/* The `!` line's session: what is running, and what the shell would complete.
 *
 * `bang.ts` is the pure half and knows nothing of processes; `bang.rs` is the
 * processes and knows nothing of cards. This is the seam — it holds the Tauri
 * subscriptions, keeps the output of each run so it can be handed over when the
 * run ends, and owns the completion popup's state.
 *
 * Holds subscriptions and a batch timer and has no lifecycle of its own, so
 * `App.svelte`'s `onDestroy` releases it — see ./listeners.ts for what a leaked
 * one costs. `snapshot.listeners.bang` is 2 and must not climb across an edit.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  BANG,
  type Completion,
  type Match,
  BANG_LINES,
  capOutput,
  handover,
  runCap,
} from "./bang";
import type { Conversation } from "./conversation.svelte";
import { Listeners } from "./listeners";
/* The history ring is the console's, not a second copy of it. `remember`'s
   immediate-repeat guard and `recall`'s clamping are exactly what a `!` history
   wants, and they are already pure and already tested — the two histories differ
   in what they are keyed by, which is this file's business, and not at all in how
   walking one works. */
import { recall, remember } from "./shell";

/** Output is batched to a frame rather than drawn line by line: a `cargo build`
 *  emits thousands a second, and a `$state` write per line puts Svelte's
 *  scheduler in front of the reader thread. The same call `Shell` makes, and the
 *  same number. */
const FLUSH_MS = 50;

/** One run in flight. Everything here is bookkeeping the *transcript* does not
 *  hold: the card draws the capped text, and the handover needs the whole of
 *  what was printed and the directory it was printed in. */
type Run = {
  cwd: string;
  cmd: string;
  /** Ctrl+Enter: say it to the agent once it has finished. Decided when you
   *  pressed the key rather than asked afterwards, because by the time a build
   *  ends you are reading something else. */
  handOver: boolean;
  /** The newest `BANG_LINES`, which is all the transcript line ever shows and
   *  all the handover ever sends. Kept to that as the run goes, so a `!` that
   *  never stops printing is a bounded run rather than a growing one. */
  lines: string[];
  /** Waiting for the next flush. */
  pending: string[];
  /** Lines no longer in `lines`: trimmed as the run went, or never handed over
   *  because they came faster than the wall draws (`bang.rs`'s outlet). */
  dropped: number;
};

/** Move a run's pending lines into it, keeping the newest `BANG_LINES`. */
function gather(run: Run) {
  run.lines.push(...run.pending);
  run.pending = [];
  const over = run.lines.length - BANG_LINES;
  if (over > 0) {
    run.lines.splice(0, over);
    run.dropped += over;
  }
}

/** One card's `!` history, and where Up has walked to in it. Per card rather
 *  than one for the wall, the same call `shell.md` makes about the console's:
 *  Up in a card you have not typed in for an hour should reach that card's last
 *  command, not whatever you most recently ran somewhere else. */
type Past = { lines: string[]; at: number; stash: string };

export class Bang {
  /** The completion the shell offered, or null when nothing is being offered.
   *  Null is the popup being down — there is no second flag, because an offering
   *  with no matches in it is not an offering. */
  offer = $state<Completion | null>(null);
  /** Which row is lit. Clamped at use, like the command palette's. */
  at = $state(0);
  /** A Tab has gone out and not come back. Drawn, because the first one on a
   *  cold shell can take a couple of seconds and a Tab that appears to do
   *  nothing is a Tab you press again. */
  asking = $state(false);

  #runs = new Map<string, Run>();
  #past = new Map<string, Past>();
  #listeners = new Listeners();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #gone = false;

  /** How to find the card an event is about, and how to say something to it.
   *  Injected the way `Widgets.others` and `DevOps.roots` are, so this class
   *  needs neither `Skein` nor the wall. */
  #look: (id: string) => Conversation | null;
  #say: (conv: Conversation, text: string) => Promise<void>;

  constructor(
    look: (id: string) => Conversation | null,
    say: (conv: Conversation, text: string) => Promise<void>,
  ) {
    this.#look = look;
    this.#say = say;
    this.#wire();
  }

  detach() {
    this.#gone = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /* ── running one ──────────────────────────────────────────────────────── */

  /** Run a line in this card's directory.
   *
   *  Single-card by construction, and that is a decision rather than a
   *  limitation: a shell command runs in *a* directory, and broadcasting one
   *  across a gathering would run it once per card in what is very often the
   *  same tree — the exact hazard the broadcast warning exists for. So the
   *  gathering is not consulted here, and the dock's bar says which directory
   *  the line will run in instead of how many cards it reaches. */
  async run(conv: Conversation, cmd: string, handOver: boolean) {
    const past = this.#pastOf(conv.id);
    past.lines = remember(past.lines, cmd);
    past.at = past.lines.length;
    past.stash = "";

    this.#runs.set(conv.id, {
      cwd: conv.cwd,
      cmd,
      handOver,
      lines: [],
      pending: [],
      dropped: 0,
    });
    conv.bangOpen(cmd, runCap(cmd, null, 0, true));

    try {
      await invoke("bang_run", { id: conv.id, cwd: conv.cwd, text: cmd });
    } catch (err) {
      /* Nothing was spawned, so no `bang:done` is coming and the line has to be
         closed from here or it says "running" for the rest of the afternoon.
         Its own cap rather than `runCap`'s, which has no word for this: a run
         that never started is neither a failure of the command nor a stop. */
      this.#runs.delete(conv.id);
      conv.bangClose(String(err), `${BANG}${cmd} · could not start`, true);
    }
  }

  /** Kill what this card is running, and everything it started. */
  async stop(conv: Conversation) {
    if (!conv.bangCmd) return;
    try {
      await invoke("bang_stop", { id: conv.id });
    } catch {
      /* Nothing to stop is the state the gesture was asking for. */
    }
  }

  /* ── the history Up walks ─────────────────────────────────────────────── */

  #pastOf(id: string): Past {
    const found = this.#past.get(id);
    if (found) return found;
    const made: Past = { lines: [], at: 0, stash: "" };
    this.#past.set(id, made);
    return made;
  }

  /** Walk this card's `!` history. Returns the command the field should now
   *  show, or null when there was nowhere to go and it should be left alone. */
  step(conv: Conversation, dir: -1 | 1, cmd: string): string | null {
    const past = this.#pastOf(conv.id);
    const count = past.lines.length;
    if (!count) return null;
    /* Stepping off the draft for the first time stashes it, so Down all the way
       back returns what you had half-typed rather than emptying the line. */
    if (past.at === count) past.stash = cmd;
    const next = recall(count, past.at, dir);
    if (next === past.at) return null;
    past.at = next;
    return next === count ? past.stash : past.lines[next];
  }

  /* ── completion ───────────────────────────────────────────────────────── */

  /** Ask the shell what it would complete here.
   *
   *  On Tab only, never as you type, and that is what makes this whole path
   *  simple: there is no debounce, no racing requests and no popup appearing
   *  under a caret that has moved on. It is also what the CLI does, so the hands
   *  arriving here already know it.
   *
   *  Returns the single match when there is exactly one, for the caller to apply
   *  straight away — one match is not a choice, and showing a popup with one row
   *  in it to be chosen from is a keystroke asked for nothing. */
  async complete(
    conv: Conversation,
    cmd: string,
    cursor: number,
  ): Promise<{ offer: Completion; only: Match } | null> {
    this.asking = true;
    try {
      const got = await invoke<Completion>("bang_complete", {
        cwd: conv.cwd,
        line: cmd,
        cursor,
      });
      if (got.matches.length === 0) {
        this.close();
        return null;
      }
      if (got.matches.length === 1) {
        this.close();
        return { offer: got, only: got.matches[0] };
      }
      this.offer = got;
      this.at = 0;
      return null;
    } catch {
      /* A completer that would not start, or a shell that did not answer in
         time. Nothing is drawn about it: what you asked for was a completion,
         and the honest answer is that there is not one. */
      this.close();
      return null;
    } finally {
      this.asking = false;
    }
  }

  /** Put the popup away. The text in the field is untouched. */
  close() {
    this.offer = null;
    this.at = 0;
  }

  /** Move the lit row, cyclically. */
  move(step: 1 | -1) {
    const rows = this.offer?.matches.length ?? 0;
    if (!rows) return;
    this.at = (Math.min(this.at, rows - 1) + step + rows) % rows;
  }

  /** The lit match, or null when the popup is down. */
  get lit(): Match | null {
    const rows = this.offer?.matches ?? [];
    return rows.length ? rows[Math.min(this.at, rows.length - 1)] : null;
  }

  /* ── the wire ─────────────────────────────────────────────────────────── */

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      /* A batch, never a line (`bang.rs`'s outlet). */
      listen<{ id: string; lines: string[]; skipped: number }>("bang:out", (e) => {
        const run = this.#runs.get(e.payload.id);
        if (!run) return;
        run.dropped += e.payload.skipped;
        /* stderr and stdout into one column, in the order they arrived. A
           command's complaint belongs where it happened — the console panel
           colours the two apart, and here the whole run is one transcript line,
           so there is nothing to colour. What the shell wrote, in order, is what
           you would have seen in a terminal. */
        run.pending.push(...e.payload.lines);
        this.#schedule();
      }),
    );

    keep(
      listen<{ id: string; code: number | null }>("bang:done", (e) => {
        const run = this.#runs.get(e.payload.id);
        if (!run) return;
        this.#runs.delete(e.payload.id);
        gather(run);

        const conv = this.#look(e.payload.id);
        if (!conv) return;
        const code = e.payload.code;
        const out = capOutput(run.lines, BANG_LINES, run.dropped);
        conv.bangClose(
          out.text,
          runCap(run.cmd, code, run.dropped + run.lines.length, false),
          /* A non-zero exit is a failure and is marked. `null` is a run that was
             stopped, which is something you did on purpose — the cap says so in
             words, and the line wears no fault. */
          code !== null && code !== 0,
        );
        if (run.handOver) {
          void this.#say(conv, handover(run.cmd, run.cwd, code, out));
        }
      }),
    );
  }

  #schedule() {
    if (this.#timer !== null || this.#gone) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, FLUSH_MS);
  }

  /** Draw every run's batch. One pass over all of them rather than a timer
   *  each, the same call `Shell` makes: a batch is about how often the wall may
   *  be redrawn, not about which card was talking. */
  #flush() {
    for (const [id, run] of this.#runs) {
      if (!run.pending.length) continue;
      gather(run);
      const conv = this.#look(id);
      if (!conv) continue;
      const out = capOutput(run.lines, BANG_LINES, run.dropped);
      conv.bangDraw(out.text, runCap(run.cmd, null, run.dropped + run.lines.length, true));
    }
  }
}
