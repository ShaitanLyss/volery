/* The running half of a project's verbs.
 *
 * `actions.ts` decides *what* a project offers and how to read its output; this
 * drives it — spawns the command, folds the lines as they arrive, waits for a
 * running editor to answer, and holds the result long enough for a chip on the
 * wall to say how it went.
 *
 * Shaped like `Skein`: a plain class with Tauri subscriptions and no lifecycle
 * of its own, so `App.svelte`'s `onDestroy` has to release it through
 * `Listeners`. Skip that and every edit in dev leaves a superseded generation
 * ingesting `action:log` for a wall nobody can see — and polling every project
 * on the machine, forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  actionsFor,
  automationStep,
  folderName,
  liveCodingStep,
  progressFrom,
  tallyNote,
  LIVE_CODING,
  NO_STATUS,
  NO_TALLY,
  REMOTE_CONTROL_PORT,
  type Action,
  type ProjectFacts,
  type ProjectStatus,
  type Step,
  type Tally,
} from "./actions";
import { stripAnsi } from "./ansi";
import type { Build } from "./buildlog";
import { Listeners } from "./listeners";
import { parseLine, type Editor } from "./unreallog";

export * from "./actions";

export type RunState = "running" | "ok" | "failed" | "cancelled";

/** `poll_projects` answers with the root it is answering about. */
type StatusRow = ProjectStatus & { root: string };

/** How long a running editor is given to answer before we stop waiting. A cook
 *  or a full rebuild genuinely can take this long. */
const EDITOR_TIMEOUT_MS = 10 * 60 * 1000;
/** If a Live Coding compile has not *started* by now, it is not going to. */
const LIVE_CODING_GRACE_MS = 20_000;
const LIVE_CODING_OFF =
  "the compile never started — is Live Coding enabled? (Editor Preferences → Live Coding)";
/** Long enough for an editor to save a big level and put its prompt away. */
const CLOSE_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_MS = 8_000;
/** How stale a repo's remote-tracking refs may get before a poll tick fetches
 *  it. Minutes rather than seconds, because unlike everything else the poll
 *  reads this one leaves the machine: somebody else's push is not news anybody
 *  needs within eight seconds, and a wall of a dozen repos hitting their
 *  remotes at that rate is rude to the remotes and worse on a tethered
 *  connection. */
const FETCH_MS = 5 * 60_000;
const MAX_LOG = 500;
/** How much of an editor's log to read back when a widget first asks for it.
 *
 *  `tail_log` starts at the *end* of the file, which is right for a Live Coding
 *  verdict — a previous compile's "succeeded" must not be read as this one's —
 *  and wrong for a widget, which would then hang on the wall showing nothing
 *  until the editor next had something to say. So the first read is a lump of
 *  the recent past, and 32k is about two hundred lines of Unreal's own
 *  formatting: comfortably more than any widget can draw and cheap to read
 *  once. */
const PRIME_BYTES = 32 * 1024;

/** One press of one chip, from the click to the verdict. */
export class Run {
  /** Also the id every Rust primitive is addressed by, for this whole run —
   *  a cycle's close, build and relaunch all share it, because only one of
   *  them is ever live at a time. */
  readonly id = crypto.randomUUID();
  readonly root: string;
  readonly action: string;
  readonly startedAt = Date.now();

  state = $state<RunState>("running");
  /** 0–100 when something in the output actually counts to a total. */
  pct = $state<number | null>(null);
  /** The last thing worth repeating — a file being compiled, a verdict. */
  note = $state<string | null>(null);
  log = $state<string[]>([]);
  endedAt = $state<number | null>(null);

  /** Set to true by `cancel`, so a step that is waiting rather than running —
   *  an editor closing, a log being tailed — can stop as well. */
  cancelling = false;
  /** The live step's own reader, if it has one. */
  watch: ((line: string) => void) | undefined;
  /** Automation output is counted wherever it appears: in a headless run's
   *  stdout, and in the log of an editor running the same tests. */
  tally: Tally = NO_TALLY;

  constructor(root: string, action: string) {
    this.root = root;
    this.action = action;
  }

  push(line: string) {
    /* The log keeps its colour — `FORCE_COLOR` is set precisely so it has some,
       and the panel renders it. Everything that *reads* the line works on the
       stripped text: a `[1/4]` behind an SGR sequence does not match anything,
       and a note carrying raw escapes would put them in a tooltip and on the
       fault bar as literal `ESC[43m`. */
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG);

    const plain = stripAnsi(line);
    const p = progressFrom(plain);
    if (p) {
      if (p.pct !== null) this.pct = p.pct;
      if (p.note) this.note = p.note;
    }
    this.tally = automationStep(this.tally, plain);
    this.watch?.(plain);
  }

  /** The tail of the output, for a failure that had nothing else to say. */
  tail(n = 12): string[] {
    return this.log.map(stripAnsi).filter((l) => l.trim()).slice(-n);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise something else resolves — the shape of every "and now wait for
 *  the world to answer" in this file. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class Actions {
  facts = $state<Record<string, ProjectFacts>>({});
  status = $state<Record<string, ProjectStatus>>({});
  /** The most recent run of each `${id}@${root}`. Kept after it
   *  finishes: "the last build failed" is the thing you most want a chip to
   *  still be saying ten minutes later. */
  runs = $state<Record<string, Run>>({});
  /** What has been tailed out of each Unreal project's editor log, keyed by
   *  project root, oldest line first.
   *
   *  Kept after the editor closes rather than cleared with it. A log you were
   *  reading does not become less true because the process finished exiting,
   *  and the last hundred lines of a session are often exactly what you wanted
   *  once it had gone — an assertion, a crash, the reason it will not reopen. */
  editorLogs = $state<Record<string, string[]>>({});
  /** Which projects' editor logs anything on the wall is asking for. Set by
   *  `App.svelte` off the widgets that are up, the way `Cycle.watched` is: this
   *  file may not reach into the widget registry, and a tail nobody is looking
   *  at is a thread and a 250ms wake for nothing. */
  wantsEditorLog: () => string[] = () => [];

  #listeners = new Listeners();
  #byRunId = new Map<string, Run>();
  /** Standing editor-log tails: project root to the run id `tail_log` knows it
   *  by. Not a `Run` — a tail has no verdict, nothing waits on it, and putting
   *  one in `runs` would bury the builds you actually pressed under a row per
   *  open editor. Plain rather than `$state` for the same reason `#fetched` is:
   *  nothing draws it. */
  #tails = new Map<string, string>();
  /** And the way back, for the `action:log` listener. */
  #tailRoots = new Map<string, string>();
  /** Roots whose current editor session has already had its recent past read
   *  in. Cleared when the editor goes, so the next one primes again — and not
   *  before, or a widget taken down and put back up would re-read lines it
   *  already holds and show every one of them twice. */
  #primed = new Set<string>();
  #settle = new Map<string, (v: { state: RunState; code: number | null }) => void>();
  #timer: number | undefined;
  #fault: (message: string) => void;
  /** When each git project was last fetched. Plain, not `$state`: nothing draws
   *  it, and a clock that repainted the wall every five minutes would be a poll
   *  with extra steps. */
  #fetched: Record<string, number> = {};

  constructor(fault: (message: string) => void) {
    this.#fault = fault;
    this.#wire();
    /* `window.setInterval` rather than the bare one, for its number handle —
       see the note on the shared clock in conversation.svelte.ts. */
    this.#timer = window.setInterval(() => void this.tick(), POLL_MS);
  }

  detach() {
    this.#listeners.detach();
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    this.#timer = undefined;
    /* Every tail, or a superseded generation in dev leaves a thread per open
       editor reading a file for a wall nobody can see. `Listeners` covers the
       subscription; nothing but this covers the threads on the other side of
       it. */
    this.wantsEditorLog = () => [];
    void this.#reconcileTails();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);
    keep(
      listen<{ run_id: string; line: string }>("action:log", (e) => {
        const run = this.#byRunId.get(e.payload.run_id);
        if (run) {
          run.push(e.payload.line);
          return;
        }
        /* Or it is a standing editor tail, which is the same event because it is
           the same Rust primitive: `tail_log` emits `action:log` under whatever
           id it was given, and a widget's tail is one more id. */
        const root = this.#tailRoots.get(e.payload.run_id);
        if (root) this.#pushEditor(root, e.payload.line);
      }),
    );
    keep(
      listen<{ run_id: string; state: RunState; code: number | null }>(
        "action:state",
        (e) => {
          const settle = this.#settle.get(e.payload.run_id);
          if (!settle) return;
          this.#settle.delete(e.payload.run_id);
          settle({ state: e.payload.state, code: e.payload.code });
        },
      ),
    );
  }

  /* ── what the wall is looking at ──────────────────────────────────────── */

  /** Learn the projects on the wall, and forget the ones that left.
   *
   *  Probing is once per project and never repeated: what a project *is* — its
   *  scripts, its engine — changes when you edit package.json, not while you
   *  are looking at it. What it is *doing* is the poll's business. */
  async sync(roots: string[]) {
    const wanted = new Set(roots);
    for (const root of roots) {
      if (this.facts[root]) continue;
      try {
        const f = await invoke<ProjectFacts>("probe_project", { root });
        this.facts = { ...this.facts, [root]: f };
      } catch {
        /* A folder that has gone away is not a fault worth a red bar. */
      }
    }
    for (const known of Object.keys(this.facts)) {
      if (wanted.has(known)) continue;
      const { [known]: _gone, ...rest } = this.facts;
      this.facts = rest;
    }
    await this.poll();
  }

  /** Read one project's facts again, overwriting what is held.
   *
   *  The deliberate exception to "probing is once per project and never
   *  repeated". That rule is about the *poll* not having to re-read a
   *  package.json every eight seconds; it is not a claim that the facts can
   *  never change. A bump writes a version, so the fact it wrote has to be
   *  read back — and only for the one project it wrote in. */
  async reprobe(root: string) {
    try {
      const f = await invoke<ProjectFacts>("probe_project", { root });
      this.facts = { ...this.facts, [root]: f };
    } catch {
      /* A folder that has gone away is not a fault worth a red bar, here for
         the same reason it is not in `sync`. */
    }
  }

  /** Re-read what every project is doing. Cheap unless an Unreal project has no
   *  editor window to find, which is the one case that reaches for WMI. */
  async poll() {
    const requests = Object.values(this.facts).map((f) => ({
      root: f.root,
      unrealName: f.unreal?.name ?? null,
      git: f.git,
    }));
    if (requests.length) {
      try {
        const rows = await invoke<StatusRow[]>("poll_projects", { requests });
        const next = { ...this.status };
        for (const r of rows) {
          const { root, ...rest } = r;
          next[root] = rest;
        }
        this.status = next;
      } catch {
        /* Never a fault: a poll that fails is a poll, and the wall still works. */
      }
    }
    /* After the status, and on the no-projects path too: this is the only thing
       that stops a tail, and a project that has left the wall must not keep one
       running. The poll is also what *starts* one, which is why opening an
       editor from a widget's own button works without a second mechanism —
       `launch-editor` already schedules a poll six seconds out for the window it
       takes to appear. */
    await this.#reconcileTails();
  }

  /** One turn of the slow loop: what everything is doing, and — every so often
   *  — what the remotes have that this machine does not. */
  async tick() {
    await this.poll();
    /* A superseded generation must not go on to the network. `detach` clears
       the timer, and the poll above may well have been in flight when it did. */
    if (this.#timer === undefined) return;
    await this.#fetch(
      Object.values(this.facts)
        .filter((f) => f.git && Date.now() - (this.#fetched[f.root] ?? 0) > FETCH_MS)
        .map((f) => f.root),
    );
  }

  /** Fetch now, whatever the clock says. */
  async fetchNow() {
    this.#fetched = {};
    await this.#fetch(Object.values(this.facts).filter((f) => f.git).map((f) => f.root));
  }

  /** Bring these repos' remote-tracking refs up to date.
   *
   *  Fire-and-forget, and deliberately not a `Run`: a fetch has no verdict
   *  worth drawing, and putting one in the runs list every five minutes would
   *  bury the builds you actually pressed. What it changes — `behind` — is read
   *  by the poll that is already running, so a colleague's push becomes a pull
   *  chip within one tick of the fetch landing and nothing ever waits on the
   *  network. */
  async #fetch(roots: string[]) {
    if (!roots.length) return;
    /* Stamped before the call rather than after. A fetch that hangs — a remote
       that is down, a VPN that is not up — must not put its repo back at the
       front of the queue on every tick from now on. Rust refuses a second fetch
       of a repo already in flight regardless; this is so the *rest* of the wall
       does not queue up behind the one that is stuck. */
    const now = Date.now();
    for (const root of roots) this.#fetched[root] = now;
    try {
      await invoke("fetch_projects", { roots });
    } catch {
      /* Offline is the ordinary state of a laptop, and not a fault. */
    }
  }

  list(root: string): Action[] {
    const f = this.facts[root];
    return f ? actionsFor(f, this.status[root] ?? NO_STATUS) : [];
  }

  runOf(root: string, action: string): Run | undefined {
    return this.runs[`${action}@${root}`];
  }

  /** This project's runs, most recent first — what the servers panel reads.
   *  A chip carries a state and one line of note; the reason a build failed is
   *  a hundred lines, and those have to be somewhere you can read them. */
  recent(root: string): Run[] {
    return Object.values(this.runs)
      .filter((r) => r.root === root)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Everything a territory draws along its bottom edge.
   *
   *  Actions that hang off another chip's arc (`Action.arc`) are not chips: they
   *  are gathered onto their opener, which is what the arc fans out when it is
   *  pressed. So the row is what it always was, and the arc is a property of one
   *  chip on it rather than a second kind of thing in the loop that draws it. */
  chipsFor(root: string): {
    id: string;
    label: string;
    title: string;
    state: RunState | "idle";
    pct: number | null;
    note: string | null;
    quiet: boolean;
    idle: boolean;
    arc: { id: string; label: string; title: string }[];
  }[] {
    const all = this.list(root);
    return all
      .filter((a) => !a.arc)
      .map((a) => {
        const arc = all.filter((k) => k.arc === a.id);
        /* Its own run if it has one, else the most recent of its arc's — a chip
           whose press is a gesture still has to be able to say how the thing
           that gesture chose went. */
        const run = this.runOf(root, a.id) ?? this.#latest(root, arc);
        const state = run?.state ?? "idle";
        return {
          id: a.id,
          label: a.label,
          /* The tooltip is where the last line of output goes: the chip itself
             must not resize while a build runs, or the row shuffles under the
             cursor every few seconds. */
          title: run?.note ? `${a.title} — ${run.note}` : a.title,
          state,
          pct: run?.state === "running" ? run.pct : null,
          note: run?.note ?? null,
          quiet: !!a.quiet,
          /* An opener has no steps of its own and is still pressable: what it
             has to do is offer the arc. */
          idle: !a.steps.length && !arc.length,
          arc: arc.map((k) => ({ id: k.id, label: k.label, title: k.title })),
        };
      });
  }

  /** The most recently started run among these actions. */
  #latest(root: string, actions: Action[]): Run | undefined {
    return actions
      .map((a) => this.runOf(root, a.id))
      .filter((r): r is Run => !!r)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  /* ── what the log widgets read ────────────────────── */

  /** Every project and whatever it last ran, flat enough for a build log to
   *  draw.
   *
   *  The same arrangement `chipsFor` has one method up, and for the same
   *  reason: `Run` is a rune class, and nothing between here and the face has
   *  any business holding one. The log array is handed over by reference rather
   *  than copied — it is the five hundred lines `MAX_LOG` caps it at, and a
   *  chatty UBT would otherwise cost a copy of all of them per line.
   *
   *  Sorted by name rather than by probe order, because this list is also the
   *  right-click menu (`projectOptions`) and a menu that reordered itself when a
   *  card opened would be a menu you cannot learn. */
  builds(): Build[] {
    return Object.values(this.facts)
      .map((f) => {
        const last = this.recent(f.root)[0];
        /* `!a.arc` as well as having steps, and that half matters: an arc choice
           is a real action with real steps, so without it a project whose only
           verb is `bump` would offer `bump:major` as its again button — a
           one-click major version bump in a widget, chosen by nothing. */
        const runnable = this.list(f.root).filter((a) => a.steps.length && !a.arc);
        /* `build` if there is one, else whatever this project leads with. Not
           the *last* thing run, which is the one thing it must not be: the
           button only appears when nothing has run at all, so there is no last
           thing, and offering `ship` to a project whose first chip is `build`
           would be a widget with opinions. */
        const again = runnable.find((a) => a.id === "build") ?? runnable[0] ?? null;
        return {
          id: f.root,
          project: folderName(f.root),
          action: last?.action ?? null,
          state: last?.state ?? ("idle" as const),
          /* Kept after the run ends, unlike the chip's, which drops it. A bar
             frozen at 47% under a rust dot is the reading: it says the build got
             half way and stopped, which is a different thing from a build that
             failed on the first file. */
          pct: last?.pct ?? null,
          note: last?.note ?? null,
          startedAt: last?.startedAt ?? null,
          endedAt: last?.endedAt ?? null,
          log: last?.log ?? [],
          again: again ? { id: again.id, label: again.label } : null,
        };
      })
      .sort((a, b) => a.project.localeCompare(b.project));
  }

  /** Every Unreal project, its editor, and what has been tailed of its log.
   *
   *  Parsed here rather than on arrival, which is the cheaper of the two on the
   *  path that matters: a line arrives and is pushed as a string, and the parse
   *  happens once per render of a widget that is actually up. Nothing parses at
   *  all on a wall with no editor log on it — which is most walls, and the same
   *  bargain every other reading in this app strikes. */
  editors(): Editor[] {
    return Object.values(this.facts)
      .filter((f) => f.unreal)
      .map((f) => {
        const u = f.unreal!;
        return {
          id: f.root,
          project: folderName(f.root),
          name: u.name,
          /* Its own editor, never any `UnrealEditor.exe` — `project.rs` matches
             on the command line for exactly this reason, and a log widget
             reading somebody else's editor would be the same mistake one layer
             up. */
          open: (this.status[f.root]?.editorPid ?? null) !== null,
          mcpPort: u.mcpPort,
          engine: !!u.engine,
          log: (this.editorLogs[f.root] ?? []).map(parseLine),
        };
      })
      .sort((a, b) => a.project.localeCompare(b.project));
  }

  /** One tailed line, kept and capped.
   *
   *  Pushed into the held array rather than replacing the record, which matters
   *  at this volume: an editor loading a level says a thousand things in a few
   *  seconds, and a `{ ...this.editorLogs }` per line would be a thousand copies
   *  of a map of five-hundred-line arrays. Deep `$state` makes the push itself
   *  reactive. */
  #pushEditor(root: string, line: string) {
    const held = this.editorLogs[root];
    if (!held) {
      this.editorLogs[root] = [line];
      return;
    }
    held.push(line);
    if (held.length > MAX_LOG) held.splice(0, held.length - MAX_LOG);
  }

  /** Start the editor-log tails that are wanted and stop the ones that are not.
   *
   *  Two conditions, and both are load-bearing. A widget has to be asking — a
   *  tail is a thread and a wake every 250ms, and the wall must not pay for one
   *  nobody is reading. And the editor has to be *up*: a closed editor is a file
   *  that will not change, so tailing it is a thread spent watching nothing, and
   *  the widget has something better to draw in the meantime (a button that
   *  opens one). Between them they mean the common case — no editor log widget
   *  on the wall — costs one set-difference per poll and nothing else.
   *
   *  Called from `poll`, which is the only thing that learns an editor has
   *  appeared or gone. Idempotent: the interesting work is guarded on `#tails`,
   *  so calling it on every tick costs a walk of a map with at most one entry
   *  per open editor in it. */
  async #reconcileTails() {
    const want = new Set(
      this.wantsEditorLog().filter((root) => {
        const u = this.facts[root]?.unreal;
        return !!u?.log && (this.status[root]?.editorPid ?? null) !== null;
      }),
    );

    for (const [root, id] of [...this.#tails]) {
      if (want.has(root)) continue;
      this.#tails.delete(root);
      this.#tailRoots.delete(id);
      /* The same `cancel_action` a build is stopped with: `tail_log` registers
         under `Runs` like everything else, and its `stop` flag is what the
         reader thread checks. */
      await invoke("cancel_action", { runId: id }).catch(() => {});
      /* And the session is over, so the next start primes again. */
      this.#primed.delete(root);
    }

    for (const root of want) {
      if (this.#tails.has(root)) continue;
      const path = this.facts[root]?.unreal?.log;
      if (!path) continue;
      const id = crypto.randomUUID();
      /* Claimed before either await, so a second reconcile arriving in between
         does not start a second thread on the same file. */
      this.#tails.set(root, id);
      this.#tailRoots.set(id, root);
      try {
        if (!this.#primed.has(root)) {
          this.#primed.add(root);
          await this.#primeEditor(root, path);
        }
        await invoke("tail_log", { runId: id, path });
      } catch {
        /* An editor that has put its window up but not opened its log yet is the
           ordinary case here, and the next poll will find it. Forgetting the
           claim is the whole of the retry. */
        this.#tails.delete(root);
        this.#tailRoots.delete(id);
        this.#primed.delete(root);
      }
    }
  }

  /** The recent past of a log we are about to start tailing.
   *
   *  `tail_log` starts at the end of the file, which is right for the thing it
   *  was written for — a previous compile's "succeeded" must not be read as this
   *  one's — and leaves a widget showing nothing until the editor next speaks.
   *  So the last `PRIME_BYTES` are read once, through the `read_tail` that
   *  already exists for splicing UBT's log into a failed build.
   *
   *  There is a gap of a millisecond or two between this read and the tail's
   *  seek to the end, and anything written inside it is **lost rather than
   *  duplicated** — which is the right way round for that trade. A line missing
   *  from the middle of a log looks like a log; the same line printed twice looks
   *  like a bug in the thing printing it, and would be chased as one. */
  async #primeEditor(root: string, path: string) {
    const text = await invoke<string | null>("read_tail", {
      path,
      maxBytes: PRIME_BYTES,
    }).catch(() => null);
    if (!text) return;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    /* The first line is very likely half a line — the read started at a byte
       offset, not a boundary. Dropping it costs nothing, and a truncated first
       line in a log is the sort of thing that gets reported as a parse bug. */
    if (lines.length > 1) lines.shift();
    if (this.editorLogs[root]?.length) {
      /* A second session under a widget that watched the first. Marked, because
         the alternative is two editors' output run together with nothing saying
         where one stopped - and the last lines before a restart are usually why
         it was restarted. */
      this.#pushEditor(root, "── editor restarted ──");
    }
    for (const l of lines.slice(-MAX_LOG)) this.#pushEditor(root, l);
  }

  /* ── running one ──────────────────────────────────────────────────────── */

  /** Press a chip. A second press while it is running cancels it. */
  async run(root: string, id: string) {
    const facts = this.facts[root];
    if (!facts) return;
    const action = this.list(root).find((a) => a.id === id);
    if (!action || !action.steps.length) return;

    const key = `${id}@${root}`;
    if (this.runs[key]?.state === "running") {
      await this.cancel(root, id);
      return;
    }

    const run = new Run(root, id);
    this.runs = { ...this.runs, [key]: run };
    this.#byRunId.set(run.id, run);

    try {
      for (const step of action.steps) {
        if (run.cancelling) break;
        await this.#step(facts, run, step);
        if (run.state !== "running") break;
      }
      if (run.state === "running") {
        run.state = run.cancelling ? "cancelled" : "ok";
        /* A test run's verdict outlives its exit code: a headless run exits 255
           on any failure, and an in-editor one has no exit code at all. */
        if (run.tally.total > 0 || run.tally.done) run.note = tallyNote(run.tally);
      }
    } catch (err) {
      run.state = "failed";
      run.note = String(err).replace(/^Error:\s*/, "");
    } finally {
      run.endedAt = Date.now();
      run.watch = undefined;
      this.#byRunId.delete(run.id);
      this.#settle.delete(run.id);
      /* Whatever it was, the world has probably moved: an editor opened, a
         branch went out. */
      void this.poll();
      if (run.state === "failed") this.#report(facts, run, id);
    }
  }

  async cancel(root: string, id: string) {
    const run = this.runs[`${id}@${root}`];
    if (!run || run.state !== "running") return;
    run.cancelling = true;
    run.note = "stopping…";
    try {
      await invoke("cancel_action", { runId: run.id });
    } catch {
      /* Already gone is the outcome we wanted. */
    }
  }

  /** Say a failure out loud once, with the most useful line it produced.
   *
   *  A chip going rust-red is enough to notice and not enough to act on, and
   *  the whole log lives one click away in the servers panel — so what goes on
   *  the fault bar is the last thing the run actually said. */
  #report(facts: ProjectFacts, run: Run, id: string) {
    const name = folderName(facts.root);
    const why = run.note ?? run.tail(1)[0] ?? "no output";
    this.#fault(`${name} · ${id} failed — ${why}`);
  }

  async #step(f: ProjectFacts, run: Run, step: Step) {
    switch (step.kind) {
      case "run": {
        const res = await this.#spawn(run, step.argv, f.root);
        if (res.state !== "ok") {
          run.state = res.state;
          if (res.state === "failed" && !run.tally.done) {
            run.note = run.tail(1)[0] ?? `exit ${res.code ?? "?"}`;
          }
        }
        return;
      }

      case "bump": {
        const plan = step.plan;
        run.note = `${plan.from} → ${plan.to}`;
        /* No streaming and no exit code to read: `bump_version` either did the
           whole thing or refused before writing anything, and says which in one
           sentence. A throw lands in `run`'s catch, which puts it on the chip
           and on the fault bar. */
        run.note = await invoke<string>("bump_version", { root: f.root, plan });
        /* A project's facts are probed once and never again, because what a
           project *is* changes when you edit package.json rather than while you
           are looking at it — and this is the one place the app edits it itself.
           Without the re-probe the whole row goes on offering the bump that has
           just been made, from the number it has just left. */
        await this.reprobe(f.root);
        return;
      }

      case "launch-editor": {
        const u = f.unreal;
        if (!u?.engine) throw new Error("no engine to launch");
        /* Both flags earn their place. `-ModelContextProtocolStartServer`
           short-circuits the ini read, so it works with the shipped
           `bAutoStartServer=False` — which has to stay false, or a cook would
           fight the interactive editor for the port. The port is pinned because
           the editor's own `ServerPortNumber` lives in `Saved/Config`, which is
           not committed, so a fresh clone would come up somewhere else while
           `.mcp.json` still pointed here. */
        const args = [u.uproject, "-ModelContextProtocolStartServer"];
        if (u.mcpPort) args.push(`-ModelContextProtocolPort=${u.mcpPort}`);
        await invoke("launch_detached", {
          program: `${u.engine}\\Engine\\Binaries\\Win64\\UnrealEditor.exe`,
          args,
          cwd: f.root,
        });
        run.note = "editor starting…";
        /* It takes a while to put up a window; ask again once it has. */
        setTimeout(() => void this.poll(), 6000);
        return;
      }

      case "focus-editor": {
        const pid = this.status[f.root]?.editorPid;
        if (!pid) throw new Error("its editor is not open any more");
        const shown = await invoke<boolean>("focus_process", { pid });
        if (!shown) throw new Error("the editor would not come forward");
        run.note = "brought forward";
        return;
      }

      case "close-editor": {
        const pid = this.status[f.root]?.editorPid;
        if (!pid) return; // already closed — nothing to wait for
        await invoke("close_process", { pid });
        run.note = "waiting for the editor to close — answer any save prompt";
        const deadline = Date.now() + CLOSE_TIMEOUT_MS;
        for (;;) {
          if (run.cancelling) {
            run.state = "cancelled";
            return;
          }
          if (!(await invoke<boolean>("process_alive", { pid }))) {
            await this.poll();
            return;
          }
          if (Date.now() > deadline) {
            throw new Error("the editor was still open after three minutes");
          }
          await sleep(800);
        }
      }

      case "live-coding": {
        const u = f.unreal;
        if (!u) throw new Error("not an unreal project");
        let v = LIVE_CODING;
        const done = deferred<void>();
        run.watch = (line) => {
          const next = liveCodingStep(v, line);
          if (next === v) return;
          v = next;
          if (v.note) run.note = v.note;
          if (v.done) done.resolve();
        };
        await this.#tail(run, u.log, async () => {
          await invoke("unreal_exec", {
            port: REMOTE_CONTROL_PORT,
            command: "LiveCoding.Compile",
          });
          /* Nothing at all after twenty seconds means Live Coding is off for
             this editor session — better said now than at the ten-minute mark. */
          await this.#waitFor(run, done.promise, () => (v.started || v.done ? null : LIVE_CODING_OFF));
        });
        if (!v.ok) {
          run.state = "failed";
          /* The compiler's own diagnostics never reach the editor log — they
             live in the Live Coding console and in UBT's log, so that is where
             a failure's reason is fetched from. */
          await this.#appendUbtLog(run);
          run.note = v.note ?? "live coding failed";
        }
        return;
      }

      case "automation": {
        const u = f.unreal;
        if (!u) throw new Error("not an unreal project");
        const done = deferred<void>();
        run.watch = () => {
          if (run.tally.total > 0) {
            const seen = run.tally.passed + run.tally.failed.length;
            run.pct = Math.min(100, Math.round((seen / run.tally.total) * 100));
          }
          if (run.tally.done) done.resolve();
        };
        run.note = "running in the open editor…";
        await this.#tail(run, u.log, async () => {
          await invoke("unreal_exec", {
            port: REMOTE_CONTROL_PORT,
            command: `Automation RunTests ${step.filter}`,
          });
          await this.#waitFor(run, done.promise);
        });
        run.note = tallyNote(run.tally);
        if (run.tally.failed.length || run.tally.total === 0) run.state = "failed";
        return;
      }
    }
  }

  /** Spawn argv and wait for its exit code. */
  async #spawn(
    run: Run,
    argv: string[],
    cwd: string,
  ): Promise<{ state: RunState; code: number | null }> {
    const settled = deferred<{ state: RunState; code: number | null }>();
    this.#settle.set(run.id, settled.resolve);
    try {
      await invoke("run_action", { runId: run.id, argv, cwd });
    } catch (err) {
      this.#settle.delete(run.id);
      throw err;
    }
    return settled.promise;
  }

  /** Tail a log for the duration of `body`, and stop tailing whatever happens.
   *
   *  A tail has no verdict of its own — it is a file being read — so the thing
   *  that started it is the thing that has to end it. Left running, the next
   *  build's lines would arrive at a run that finished ten minutes ago. */
  async #tail(run: Run, path: string, body: () => Promise<void>) {
    await invoke("tail_log", { runId: run.id, path });
    try {
      await body();
    } finally {
      run.watch = undefined;
      await invoke("cancel_action", { runId: run.id }).catch(() => {});
    }
  }

  /** Wait for a running editor to answer, or stop waiting for a good reason.
   *
   *  Three of them: the answer arrived, the run was cancelled, or it has been
   *  long enough that no answer is coming. `grace` is the fourth, for the one
   *  case where waiting the full ten minutes tells you nothing you could not
   *  have been told in twenty seconds.
   *
   *  The single timer matters: a version of this that raced a fresh `setTimeout`
   *  against the answer left the loser pending, and a rejection nobody is
   *  listening for any more is an unhandled rejection in the console every time
   *  a build succeeds. */
  async #waitFor(run: Run, done: Promise<void>, grace?: () => string | null) {
    const started = Date.now();
    let tick: number | undefined;
    const guard = new Promise<never>((_, reject) => {
      tick = window.setInterval(() => {
        const waited = Date.now() - started;
        if (run.cancelling) {
          run.state = "cancelled";
          reject(new Error("stopped"));
        } else if (grace && waited > LIVE_CODING_GRACE_MS) {
          const why = grace();
          if (why) reject(new Error(why));
        } else if (waited > EDITOR_TIMEOUT_MS) {
          reject(new Error("the editor never answered"));
        }
      }, 500);
    });
    try {
      await Promise.race([done, guard]);
    } finally {
      if (tick !== undefined) window.clearInterval(tick);
    }
  }

  /** UnrealBuildTool writes its own log, and after a failed Live Coding compile
   *  it is the only place the compiler errors exist. */
  async #appendUbtLog(run: Run) {
    try {
      const text = await invoke<string | null>("read_tail", {
        path: "%LOCALAPPDATA%\\UnrealBuildTool\\Log.txt",
        maxBytes: 64 * 1024,
      });
      if (!text) return;
      run.log.push("── UnrealBuildTool log ──");
      for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
        run.log.push(line);
      }
      if (run.log.length > MAX_LOG) run.log = run.log.slice(-MAX_LOG);
    } catch {
      /* No log is not worse than the failure we already have. */
    }
  }
}
