/* The floating shell — one long-lived `pwsh` per project, and everything the
 * panel draws.
 *
 * Two shapes worth knowing before reading this.
 *
 * **The panel closing does not close the shell.** Alt+I is a toggle over
 * something that is already running, the way nvim's floating terminal is, so a
 * build you started stays started while you go back to the wall and read what
 * an agent said about it. The process only ends when you ask it to, or when the
 * app does.
 *
 * **There is one shell per project, not one for Skein.** Every session is keyed
 * on a project's root — which is also the id Rust holds it under, so the key is
 * derived rather than allocated and survives the front end being rebuilt. The
 * one on screen is the last project you touched a card in (`activeShellKey`),
 * so the panel is already in the right tree by the time you have opened it; the
 * others keep running behind it, which is why the header says how many.
 *
 * Holds Tauri subscriptions and has no lifecycle of its own, so `App.svelte`'s
 * `onDestroy` releases it — see ./listeners.ts for what a leaked one costs.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Listeners } from "./listeners";
import {
  type ShellLine,
  promptPath,
  pushLines,
  recall,
  remember,
  sameDir,
} from "./shell";

/** Lines are batched to a frame rather than pushed one at a time: a build
 *  emits thousands per second, and a `$state` write per line puts Svelte's
 *  scheduler in front of the reader thread. One timer serves every session,
 *  since a batch is about how often the wall may be redrawn and not about
 *  which shell was talking. */
const FLUSH_MS = 50;

/** One project's shell: the process, where it is, and what it has said.
 *
 *  Everything the panel used to read off `Shell` lives here now, because all of
 *  it was per-shell the moment there was more than one — including the command
 *  history, which is the surprising one. It is per project on purpose: Up in a
 *  project you have not typed in for an hour should reach that project's last
 *  command, not whatever you most recently ran somewhere else. */
export class ShellSession {
  /** The project root. Also the id Rust files this shell under, and the
   *  directory it was started in — three facts that are deliberately one
   *  string, so nothing has to remember a mapping. */
  readonly key: string;
  /** What we found — `pwsh`, or `powershell` where that is all there is. Null
   *  until one has started, which is what `starting` reads off. */
  program = $state<string | null>(null);
  /** Where the shell is now, straight from its own `$PWD` rather than from
   *  wherever we last thought we sent it: `cd` is a thing you type. */
  cwd = $state("");
  lines = $state<ShellLine[]>([]);
  /** A command has gone in and its marker has not come back. Also true between
   *  the spawn and the first marker, which is the shell reading your profile —
   *  about four seconds of it here, and the reason this is drawn at all. */
  busy = $state(false);
  /** True once a shell has been asked for and has not exited. */
  live = $state(false);
  fault = $state<string | null>(null);
  /** Where Up and Down have walked to. `history.length` is the live draft. */
  at = $state(0);

  /** Everything typed into this shell, oldest first. Plain — nothing draws it. */
  history: string[] = [];
  /** What was in the field before the walk started, so Down can give it back. */
  stash = "";
  /** Lines waiting for the next flush. */
  pending: ShellLine[] = [];

  constructor(key: string) {
    this.key = key;
  }

  /** What the prompt says, in the width the panel has. */
  get where(): string {
    return this.cwd ? promptPath(this.cwd, this.#home()) : "";
  }

  /** Home, inferred from the shell's own directory rather than asked for.
   *
   *  There is no `os` plugin in this app and adding one for a tilde would be a
   *  poor trade; every path the shell reports is absolute, and the account's
   *  own folder is the first three segments of a Windows user path. Wrong
   *  guesses cost a `~` that does not appear, which is what the display looked
   *  like before there was one. */
  #home(): string {
    const m = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(this.cwd);
    if (m) return m[1];
    const p = /^(\/(?:home|Users)\/[^/]+)/.exec(this.cwd);
    return p ? p[1] : "";
  }
}

/** Nothing to draw, for the getters that answer before a project has been
 *  named. A shared frozen array rather than a fresh one, so a panel reading it
 *  every redraw is not handed a new identity each time. */
const NO_LINES: ShellLine[] = [];

export class Shell {
  /** Whether the panel is on screen. Not whether a shell is running, and not
   *  which one — the panel is one window onto whichever session is active. */
  open = $state(false);
  /** Every shell this window knows about, live or exited. An array rather than
   *  a Map because the header iterates it and `$state` tracks the assignment;
   *  there are never more than a wall's worth of projects in it. */
  sessions = $state<ShellSession[]>([]);
  /** The project whose shell the panel is showing. */
  activeKey = $state("");

  #listeners = new Listeners();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #gone = false;

  constructor() {
    this.#wire();
  }

  /** Stop listening, and drop the batch timer with it — a module-level timer
   *  outliving its generation is the same hazard a subscription is. */
  detach() {
    this.#gone = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /* ── the active session, and the panel's whole reading of it ───────────── */

  /** The session on screen, or null before a project has been named. Every
   *  getter below is the panel asking this one thing about it, kept as flat
   *  fields so `Console.svelte` and the control surface read exactly what they
   *  read when there was one shell. */
  get active(): ShellSession | null {
    return this.sessions.find((s) => s.key === this.activeKey) ?? null;
  }

  get program(): string | null {
    return this.active?.program ?? null;
  }
  get cwd(): string {
    return this.active?.cwd ?? "";
  }
  get where(): string {
    return this.active?.where ?? "";
  }
  get lines(): ShellLine[] {
    return this.active?.lines ?? NO_LINES;
  }
  get busy(): boolean {
    return this.active?.busy ?? false;
  }
  get live(): boolean {
    return this.active?.live ?? false;
  }
  get fault(): string | null {
    return this.active?.fault ?? null;
  }
  get at(): number {
    return this.active?.at ?? 0;
  }

  /** The shells that are running and are not the one you are looking at.
   *
   *  Drawn in the header as a count, because splitting one shell into one per
   *  project made "a build is still running" a fact with nowhere to appear: the
   *  panel used to *be* every shell there was, and now it is one of them. */
  get others(): ShellSession[] {
    return this.sessions.filter((s) => s.live && s.key !== this.activeKey);
  }

  /* ── choosing one ─────────────────────────────────────────────────────── */

  /** Find this project's session, making the record if this is the first time
   *  it has been named. Making a record is not starting a shell — `live` stays
   *  false until `start` says otherwise. */
  #session(key: string): ShellSession {
    const found = this.sessions.find((s) => sameDir(s.key, key));
    if (found) return found;
    const made = new ShellSession(key);
    this.sessions = [...this.sessions, made];
    return made;
  }

  /** Point the panel at a project's shell, starting one if the panel is open
   *  and this project has not got one yet.
   *
   *  Starting immediately is the deliberate half. The alternative — switch the
   *  view and wait for Enter — spares a `pwsh` per project you click past, but
   *  it means the panel you just switched into cannot be typed in for four
   *  seconds without you having asked for anything, and the whole point of the
   *  panel following the wall is that it is ready when you look at it. A shell
   *  is only started while the panel is *open*: clicking around the wall with
   *  it shut costs nothing. */
  async select(key: string) {
    if (!key) return;
    const session = this.#session(key);
    this.activeKey = session.key;
    if (this.open && !session.live) await this.start(session.key);
  }

  /** Show the panel on this project's shell, starting one if there is not one.
   *
   *  `key` is only ever a *starting* directory: a shell already running is
   *  wherever you last left it, and being moved back to a project root because
   *  you toggled the panel would be the app arguing with something you typed. */
  async show(key: string) {
    this.open = true;
    await this.select(key);
  }

  /** Hide the panel. Every shell keeps running — see the note at the top. */
  hide() {
    this.open = false;
  }

  async toggle(key: string) {
    if (this.open) this.hide();
    else await this.show(key);
  }

  /* ── the session's own verbs ──────────────────────────────────────────── */

  async start(key: string) {
    const session = this.#session(key);
    this.activeKey = session.key;
    session.busy = true;
    session.fault = null;
    /* Where this one starts: the project root the first time, and afterwards
       wherever the shell had got to — `stop` is "a new shell, same directory",
       which it would not be if starting one always went back to the root. */
    const home = session.cwd || session.key;
    try {
      const info = await invoke<{ program: string; started: boolean }>("open_shell", {
        /* The project root is the id. Derived rather than allocated, so a front
           end rebuilt by a Vite edit finds the same shell rather than spawning
           a second one beside it. */
        id: session.key,
        cwd: home,
      });
      session.program = info.program;
      session.live = true;
      if (info.started) {
        session.cwd = home;
        this.#push(session, { text: `${info.program} in ${home}`, kind: "note" });
        this.#flush();
      }
      /* Nothing is claimed about where an *attached* shell is — Rust answers a
         reattach with a fresh marker, and the marker is the only thing that
         knows. In dev this is every front-end edit: Vite rebuilds `App.svelte`,
         the object holding the sessions goes with it, and the new one has to
         find shells that may have been `cd`'d anywhere since. */
    } catch (err) {
      session.busy = false;
      session.live = false;
      session.fault = String(err);
      this.#push(session, { text: String(err), kind: "err" });
      this.#flush();
    }
  }

  /** Send what was typed, and echo it — the shell echoes nothing back. */
  async send(text: string) {
    const session = this.active;
    if (!session) return;
    const line = text.replace(/\s+$/, "");
    if (!line.trim()) return;

    if (!session.live) {
      await this.start(session.key);
      if (!session.live) return;
    }

    session.history = remember(session.history, line);
    session.at = session.history.length;
    session.stash = "";
    this.#push(session, { text: line, kind: "you" });
    this.#flush();
    session.busy = true;

    try {
      await invoke("shell_send", { id: session.key, text: line });
    } catch (err) {
      session.busy = false;
      this.#push(session, { text: String(err), kind: "err" });
      this.#flush();
    }
  }

  /** Kill what is running in the shell on screen, and open a fresh one where
   *  it was. Only this project's — the other shells are not what you were
   *  looking at, and a button that took them down too would be one nobody
   *  could press knowing what it did.
   *
   *  Deliberately not called an interrupt. These children have no console
   *  attached — a GUI app's do not — so there is no Ctrl+C to deliver to them,
   *  and pretending otherwise would be a button that sometimes did nothing to a
   *  process that had hung. Taking the tree down and starting again in the same
   *  directory is what the gesture can actually do, and the panel says so. */
  async stop() {
    const session = this.active;
    if (!session) return;
    const here = session.cwd;
    await this.close();
    this.#push(session, { text: "stopped — a new shell, same directory", kind: "note" });
    session.cwd = here;
    await this.start(session.key);
  }

  /** End the session on screen. The panel can stay open over nothing; enter
   *  starts one. */
  async close() {
    const session = this.active;
    if (!session) return;
    try {
      await invoke("close_shell", { id: session.key });
    } catch {
      /* Nothing to close is the state we were asking for. */
    }
    session.live = false;
    session.busy = false;
  }

  /** Clear the scrollback of the shell on screen, not its session. */
  clear() {
    const session = this.active;
    if (!session) return;
    session.pending = [];
    session.lines = [];
  }

  /** Walk this shell's history. Returns what the field should now say, or
   *  `null` when there was nowhere to go and the field should be left exactly
   *  alone. */
  step(dir: -1 | 1, draft: string): string | null {
    const session = this.active;
    if (!session) return null;
    const count = session.history.length;
    if (!count) return null;
    /* Stepping off the draft for the first time stashes it, so Down all the
       way back returns what you had half-typed rather than emptying the line. */
    if (session.at === count) session.stash = draft;
    const next = recall(count, session.at, dir);
    if (next === session.at) return null;
    session.at = next;
    return next === count ? session.stash : session.history[next];
  }

  /* ── the wire ─────────────────────────────────────────────────────────── */

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      /* A batch, never a line — `shell.rs`'s outlet, at most ten a second. */
      listen<{ id: string; lines: { line: string; stderr: boolean }[]; skipped: number }>(
        "shell:out",
        (e) => {
          const session = this.#heard(e.payload.id);
          if (e.payload.skipped) {
            this.#push(session, {
              text: `… ${e.payload.skipped.toLocaleString("en")} lines went by too fast to draw`,
              kind: "note",
            });
          }
          for (const l of e.payload.lines) {
            this.#push(session, { text: l.line, kind: l.stderr ? "err" : "out" });
          }
        },
      ),
    );

    keep(
      listen<{ id: string; ok: boolean; cwd: string }>("shell:done", (e) => {
        const session = this.#heard(e.payload.id);
        /* Flush first, or the failure mark lands on a command whose output is
           still sitting in the batch and has not been drawn yet. */
        this.#flush();
        session.cwd = e.payload.cwd;
        session.busy = false;
        if (!e.payload.ok) {
          /* Mark the command rather than the output. Which line failed is a
             question you ask while scrolling past a screen of it, and the
             answer wants to be at the top of that screen. */
          for (let i = session.lines.length - 1; i >= 0; i--) {
            if (session.lines[i].kind === "you") {
              session.lines[i] = { ...session.lines[i], failed: true };
              session.lines = [...session.lines];
              break;
            }
          }
        }
      }),
    );

    keep(
      listen<{ id: string }>("shell:exit", (e) => {
        /* Not `#heard`: an exit is the one event that must not conjure a
           session, or a shell this window never adopted would appear on the
           wall as a record whose whole content is that it is gone. */
        const session = this.sessions.find((s) => sameDir(s.key, e.payload.id));
        if (!session) return;
        this.#flush();
        session.live = false;
        session.busy = false;
        this.#push(session, { text: "the shell exited — enter starts another", kind: "note" });
        this.#flush();
      }),
    );
  }

  /** The session a line arrived for, adopting one that is talking to us
   *  without our having asked.
   *
   *  That is the dev case and it is worth handling rather than dropping: a
   *  Vite edit rebuilds this object while a build is still running in some
   *  other project's shell, and the output has to land somewhere or switching
   *  to that project shows an empty panel over a process that is plainly
   *  working. A shell that is speaking is a shell that is live, so the record
   *  says so. */
  #heard(id: string): ShellSession {
    const session = this.#session(id);
    session.live = true;
    return session;
  }

  #push(session: ShellSession, line: ShellLine) {
    session.pending.push(line);
    if (this.#timer !== null || this.#gone) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, FLUSH_MS);
  }

  /** Drain every session's batch. One pass over all of them rather than one
   *  timer each: a batch is about how often the wall may be redrawn, not about
   *  which shell was talking, and a hidden session's lines still have to be
   *  there when you switch to it. */
  #flush() {
    for (const session of this.sessions) {
      if (!session.pending.length) continue;
      const batch = session.pending;
      session.pending = [];
      session.lines = pushLines(session.lines, batch);
    }
  }
}
