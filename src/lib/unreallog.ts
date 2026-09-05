/* What a running Unreal editor is saying about itself.
 *
 * The third log widget (see `logface.ts` for why they are three rather than
 * three variants of one), and the only one whose lines are not already on the
 * wall for some other reason: a dev server's output arrives because the servers
 * panel wanted it, a build's because a chip wanted it, and the editor's log is
 * a file on disk that nothing was reading. So this is the one that has to ask —
 * `actions.svelte.ts` tails `Saved/Logs/<Name>.log` while a widget wants it and
 * the editor is up, through the same `tail_log` that has been reading that file
 * for Live Coding verdicts all along.
 *
 * **Gated on the editor being open**, which is the one thing about it that is a
 * decision rather than a mechanism. A tail is a thread and a 250ms wake, and an
 * editor that is not running is a file that will not change — so with the
 * editor closed the widget stops asking and offers to open one instead, the way
 * the server log offers to start a group that is down. The lines it already has
 * stay: a log you were reading does not become less true because the editor
 * finished exiting, and the last hundred lines of a session are often exactly
 * what you wanted after it went.
 *
 * Pure — no runes, no DOM. `UnrealLog.svelte` draws it. */

import type { Row } from "./logface";

/** How loud a line claimed to be.
 *
 * Unreal's own ladder, minus the distinction nothing here draws: `VeryVerbose`
 * folds into `verbose`, since a face that separated them would be separating two
 * things you have never once wanted apart on a wall.
 *
 * `log` is the default and that is a fact about the *file* rather than a
 * fallback: Unreal writes `LogTemp: Display: x` for Display and plain `LogTemp:
 * x` for Log verbosity, so an unmarked line is not an unparsed one — it is a
 * Log line, which is most of them. */
export type Verbosity = "fatal" | "error" | "warning" | "display" | "log" | "verbose";

/** One line out of the editor's log, taken apart.
 *
 * Four fields the raw line spends nearly forty columns on, which is why this
 * exists at all: a widget three hundred pixels wide that drew
 * `[2026.08.21-14.32.10:123][456]LogTemp: Warning: ` before saying anything
 * would be a widget with room for the timestamp and nothing else. */
export type UeLine = {
  /** `2026.08.21-14.32.10:123`, or null under `-NoLogTimes`. */
  stamp: string | null;
  /** The frame counter Unreal prints beside it — `[  0]` before the first tick. */
  frame: number | null;
  /** `LogTemp`. Null for a line that is not in the category form at all: raw
   *  output, a continuation, a banner. */
  category: string | null;
  verbosity: Verbosity;
  /** Everything after the last colon that belonged to the prefix. */
  text: string;
};

/** The words Unreal spells a verbosity with, in log output. */
const VERBOSITY: Record<string, Verbosity> = {
  Fatal: "fatal",
  Error: "error",
  Warning: "warning",
  Display: "display",
  Log: "log",
  Verbose: "verbose",
  VeryVerbose: "verbose",
};

/* `[stamp][frame]Category: Verbosity: text`, with every part optional except
   the text. Deliberately one regex rather than a scanner: the shape is fixed
   by `FOutputDeviceFile`, has been for a decade, and a hand-rolled parser would
   be more code to be wrong in. The category is `\w+` with no spaces, which is
   what keeps an ordinary sentence like `Total time: 5.4s` from being read as a
   category called `Total` — after `Total` comes a space, and the group demands
   the colon immediately.

   The stamp is anchored on its four-digit year rather than being any run of
   digits and dots. `[456]LogTemp: x` — a frame with no timestamp — would
   otherwise have its frame read as the stamp and then report no frame at all,
   which is one wrong field standing in for another and the worst kind of parse
   to debug from a screenshot. */
const LINE =
  /^(?:\[(\d{4}\.[\d.:-]+)\])?(?:\[\s*(\d+)\s*\])?(?:(\w+)\s*:\s*)?(?:(Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose)\s*:\s*)?([\s\S]*)$/;

export function parseLine(raw: string): UeLine {
  const m = LINE.exec(raw);
  if (!m) return { stamp: null, frame: null, category: null, verbosity: "log", text: raw };
  const [, stamp, frame, first, second, rest] = m;

  /* A line that opens with a bare `Warning:` and no category — which the engine
     does emit — parses into the *category* slot, because that is the slot that
     comes first. Moving it is the whole of the fix: what was matched is a
     verbosity if it reads as one, and then there is simply no category. */
  const asVerbosity = first ? VERBOSITY[first] : undefined;
  const category = second ? (first ?? null) : asVerbosity ? null : (first ?? null);
  const verbosity = second
    ? VERBOSITY[second]
    : (asVerbosity ?? "log");

  return {
    stamp: stamp ?? null,
    frame: frame === undefined ? null : Number(frame),
    category,
    verbosity,
    /* When the category slot turned out to hold a verbosity there is nothing to
       put back — the regex already consumed only the word and its colon. */
    text: rest ?? "",
  };
}

/** Whether this line is one of the ones you hung the widget up for. */
export const isProblem = (l: UeLine) =>
  l.verbosity === "fatal" || l.verbosity === "error" || l.verbosity === "warning";

/** What the `showing` knob narrows to. */
export function keeping(showing: string): ((l: UeLine) => boolean) | null {
  return showing === "problems" ? isProblem : null;
}

export const NARROWING: Record<string, string> = { problems: "wrong" };

/** How many of each the log holds. Over everything the wall has tailed, not
 *  over the drawn tail — see the same note in `buildlog.ts`. */
export function tally(log: readonly UeLine[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const l of log) {
    if (l.verbosity === "error" || l.verbosity === "fatal") errors++;
    else if (l.verbosity === "warning") warnings++;
  }
  return { errors, warnings };
}

/** The last thing that went wrong, for the reading that is a count and one
 *  line. Null on a session with nothing wrong in it, which is the answer you
 *  wanted and reads better as a word than as an empty pane. */
export function lastProblem(log: readonly UeLine[]): UeLine | null {
  for (let i = log.length - 1; i >= 0; i--) if (isProblem(log[i])) return log[i];
  return null;
}

/** The category, minus the `Log` every one of them starts with.
 *
 * Three columns off every line of the gutter, which on a face this narrow is
 * three columns of the message. `LogAutomationTest` → `AutomationTest`,
 * `LogTemp` → `Temp`, and the handful that do not follow the convention —
 * `Cmd`, a plugin's own — are left exactly as they are rather than being
 * mangled to fit a rule they were never in. */
export function shortCategory(category: string | null): string | null {
  if (!category) return null;
  if (category.length > 4 && category.startsWith("Log")) return category.slice(3);
  return category;
}

/** Just the clock out of a stamp: `2026.08.21-14.32.10:123` → `14:32:10`.
 *
 * The date is today — this is a log of a process that is running — and the
 * milliseconds are for diffing two logs rather than for reading one. What is
 * left is the eight characters you would actually use, to line something up
 * against a build that failed at about the same time. */
export function timeOf(stamp: string | null): string | null {
  const m = stamp?.match(/-(\d{2})\.(\d{2})\.(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

function toneOf(v: Verbosity): "plain" | "warn" | "fail" {
  return v === "error" || v === "fatal" ? "fail" : v === "warning" ? "warn" : "plain";
}

/** Editor lines as the shared tail draws them.
 *
 * The gutter is the category, which is genuinely worth its columns here in a
 * way an action id would not be: one editor log interleaves forty of them, and
 * `Slate` beside a line tells you it is chrome noise before you have read a
 * word of it.
 *
 * Tinted — `LogTail`'s `tint` — for the reason the build log is and the server
 * log is not. `LogTemp: Error:` is the *writer* stating a verbosity about its
 * own line, not an inference from which pipe it came down, and the file carries
 * no colour of its own for the tint to overrule: `FOutputDeviceFile` writes
 * plain text, so every escape-free line here is one where our colour is the only
 * colour there could be. */
export function rowsOf(lines: UeLine[], stamps: boolean): Row[] {
  return lines.map((l) => {
    const cat = shortCategory(l.category);
    const at = stamps ? timeOf(l.stamp) : null;
    return {
      mark: at && cat ? `${at} ${cat}` : (at ?? cat),
      tone: toneOf(l.verbosity),
      text: l.text,
    };
  });
}

/** A project's editor and its log, as much of both as this widget needs. */
export type Editor = {
  /** The project root — the subject knob's value, stable across editor
   *  sessions the way a run id would not be. */
  id: string;
  project: string;
  /** The `.uproject`'s name, which is also what the log file is called. */
  name: string;
  /** Whether *this project's* editor is up. Its own, never any
   *  `UnrealEditor.exe` — `project.rs` matches on the command line for exactly
   *  this reason, and a log widget reading somebody else's editor would be the
   *  same mistake one layer up. */
  open: boolean;
  /** The port this repo's committed `.mcp.json` declares, if any. */
  mcpPort: number | null;
  /** Whether the engine resolved at all. Without it there is nothing to open
   *  and the button would be a lie. */
  engine: boolean;
  /** What the wall has tailed so far, oldest first. */
  log: UeLine[];
};

/** Whether this is the editor to follow: one that is up. */
export const isLive = (e: Editor) => e.open;

/** Which closed editor a follower falls back to, when none is open.
 *
 * The same fallback the build log needed (`buildlog.ts::lastRun`, sink
 * f2cce1c8) and the same reasoning: this file keeps a session's lines after the
 * editor exits — *a log you were reading does not become less true because the
 * process finished exiting* — and then `subjectOf` used to hand the widget the
 * first project on the wall the moment the editor closed, which threw those
 * lines away for a project that may never have opened one at all.
 *
 * Coarser than the build log's, because an `Editor` carries no clock: what it
 * can honestly say is *this one has spoken during this wall's life* and nothing
 * finer, so two projects whose editors have both been and gone tie and list
 * order settles them. Better than alphabetical against nothing, which is what it
 * replaces; a timestamp would want `actions.svelte.ts` to keep one per root and
 * is worth doing the day two closed editors on one wall is a real case. */
export const lastSeen = (e: Editor) => (e.log.length ? 1 : 0);

export function pulseOf(e: Editor): "idle" | "live" | "dead" {
  return e.open ? "live" : "idle";
}

/** Whether there is a button instead of a reading, and what it says.
 *
 * The editor being closed is this subject's whole down state, and unlike the
 * build log it *does* replace the reading — the lines are a previous session's
 * and the useful gesture is a new one. Which is also the server log's answer to
 * a group that has exited, one subject over.
 *
 * The button opens the editor **with its MCP server on**, because that is the
 * only way this app ever opens one: `launch-editor` passes
 * `-ModelContextProtocolStartServer` and pins the port from the committed
 * `.mcp.json`, so an editor Skein started is one the cards on this wall can
 * talk to. Worth saying in the word rather than leaving as a surprise — the
 * whole reason to open it from here rather than from the taskbar. */
export function standing(e: Editor): { word: string; verb: string | null } | null {
  if (e.open) return null;
  if (!e.engine)
    return {
      word: "no engine resolved for this project — check the .uproject's EngineAssociation",
      verb: null,
    };
  return {
    word: e.mcpPort
      ? `editor not open — opening it starts its mcp server on :${e.mcpPort}`
      : "editor not open",
    verb: "open the editor",
  };
}

/** The two absences, in this subject's words. */
export function absence(because: "none" | "gone"): string {
  return because === "gone"
    ? "the project this was set to is not on the wall any more — right-click to pick another"
    : "no unreal projects on the wall — this reads the editor log of one that has a .uproject";
}

/** What the `editors` source resolves to for the right-click. */
export function editorOptions(editors: Editor[]): { value: string; label: string }[] {
  return editors.map((e) => ({ value: e.id, label: e.project }));
}
