/* What a build is saying, on the wall the build is for.
 *
 * The second of the three log widgets (see `logface.ts` for why they are three
 * widgets rather than three variants of one), and the one that reads something
 * the app was already holding twice over: `actions.rs` pipes every action's
 * stdout and stderr up as `action:log`, `Run.log` in `actions.svelte.ts` keeps
 * the last five hundred lines of it, and `progressFrom` has been parsing UBT's
 * `@progress` markers and `[12/345]` counters out of them all along for the
 * chip on the territory's edge. What a widget adds is that a build you pressed
 * and walked away from is *readable* from across the room, instead of being a
 * chip that has gone rust-red with the reason a panel away.
 *
 * **It is not an Unreal widget**, and that is deliberate. The subject here is a
 * run this wall started, and UnrealBuildTool, cargo, tsc and pnpm are four
 * things that produce one. UBT gets the best of it only because `actions.ts`
 * already knew the most about UBT's output — the progress markers, the cook
 * counter, the Live Coding lines — not because anything below asks whose build
 * it is.
 *
 * Pure — no runes, no DOM. `BuildLog.svelte` draws it. */

import type { Row } from "./logface";

/** The same four `RunState` values `actions.svelte.ts` holds, plus the fifth
 *  thing a *project* can be: never having run anything at all. Mirrored
 *  structurally rather than imported for the reason `serverlog.ts`'s `Health`
 *  is — `Run` is a rune class, and this side of the purity boundary may not
 *  hold one. */
export type Verdict = "idle" | "running" | "ok" | "failed" | "cancelled";

/** A project and its most recent run, as much of both as a log needs.
 *
 * The subject is the **project**, not the run, and that is the one structural
 * decision in this file. A run's id is a UUID that exists for as long as one
 * build takes, so a widget pinned to one would be pointing at nothing by
 * tea-time and there would be no menu entry to pin it with. A project is on the
 * wall all day. So the knob names a root, and what the widget draws is whatever
 * that project most recently ran — press `test` after `build` and the log
 * follows, which is also what you wanted it to do. */
export type Build = {
  /** The project root. Both the subject knob's value and the wall's own id for
   *  a project, so pinning survives every run. */
  id: string;
  /** What to call it — the root's last segment, resolved by the caller, which
   *  is the only thing here that knows about paths. */
  project: string;
  /** Which action's log this is (`build`, `test`, `ship`, `cycle`), or null
   *  when nothing has been run in this project yet. */
  action: string | null;
  state: Verdict;
  /** 0–100, only ever from something that genuinely counts to a known total. */
  pct: number | null;
  /** The last thing worth repeating — a file being compiled, a verdict. */
  note: string | null;
  startedAt: number | null;
  endedAt: number | null;
  log: string[];
  /** What the button would press, and what to call it. Null for a project that
   *  offers nothing runnable — an Unreal project whose engine would not
   *  resolve, a bare folder with no package.json. */
  again: { id: string; label: string } | null;
};

/** Whether this is the build to follow. A run in flight, and nothing else: a
 *  wall of six projects where one is compiling has exactly one answer to
 *  "whichever is running". */
export const isLive = (b: Build) => b.state === "running";

/** When this project last had something to say, for a follower to fall back on.
 *
 * The other half of the promise above, and for a while the promise was made
 * without it: the comment on `isLive` used to go on to claim that *the moment it
 * finishes the widget stays on it rather than wandering, because the finished
 * log is the reading you wanted*, and nothing implemented that. A predicate
 * answers "is this one running" and cannot remember which one just was, so
 * `subjectOf` fell through to the first project on the wall — very often one
 * that has never built anything, whose face is the words "this project has
 * nothing to build". Which is to say the widget threw the log away at the one
 * moment it was finally complete, and the user reported exactly that
 * (sink f2cce1c8).
 *
 * `endedAt` first so a finished run outranks one that started earlier and is
 * still going — that case cannot arise through `subjectOf`, which asks `isLive`
 * before it asks this, but a fallback that would answer wrongly if asked out of
 * order is one nobody may reuse. Zero for a project that has never run
 * anything, which is what keeps it out of the running entirely. */
export const lastRun = (b: Build) => b.endedAt ?? b.startedAt ?? 0;

/** The dot. `ok` and `cancelled` are both `rest` — done, and nothing to do — and
 *  the difference between them is in the note rather than in a colour, because
 *  a cancelled build is not a failure and must not go rust. */
export function pulseOf(v: Verdict): "idle" | "live" | "rest" | "dead" {
  return v === "running"
    ? "live"
    : v === "failed"
      ? "dead"
      : v === "idle"
        ? "idle"
        : "rest";
}

/* ── what a line is complaining about ──────────────────────────────────────
 *
 * The reading that makes this widget worth hanging up: a UBT build is three
 * thousand lines and four of them matter. There is no structure to lean on —
 * `actions.rs` reads pipes, not a compiler API — so this is pattern matching,
 * and the whole risk is being too eager. A matcher that called `Compiling
 * error-handling v0.3.1` an error, or counted the `0 errors` in a summary,
 * would turn the problems reading into a second copy of the log and there
 * would be no way to tell from looking at it.
 *
 * So every pattern demands punctuation the word would not have in prose: a
 * colon after it, a bracketed code, or an MSVC-style `C2065`. `1 error
 * generated.` deliberately does not match — it is a count, not a diagnostic,
 * and the four lines above it are the ones you want. */

/** `error:` / `ERROR:` / `error[E0308]:` at the head of a line. */
const LEAD_ERR = /^\s*(?:error|fatal error)\b\s*(?::|\[)/i;
/** MSVC and friends: `foo.cpp(12): error C2065:`, `fatal error LNK1120:`. */
const CODED_ERR = /\berror\s+[A-Z]+\d+\s*:/;
/** clang, gcc, UBT's `EXEC : error :`, and Unreal's `LogFoo: Error:`. */
const TAGGED_ERR = /:\s*(?:fatal\s+)?error\s*:/i;
/** esbuild and the JavaScript toolchain's bracketed form. */
const BRACKET_ERR = /\[(?:ERROR|error)\]/;

const LEAD_WARN = /^\s*warning\b\s*(?::|\[)/i;
const CODED_WARN = /\bwarning\s+[A-Z]+\d+\s*:/;
const TAGGED_WARN = /:\s*warning\s*:/i;
const BRACKET_WARN = /\[(?:WARNING|warning)\]/;

/** What this line is complaining about, or null if it is getting on with it.
 *
 * Errors are asked first, because a line can name both — `error: aborting due
 * to 1 previous error; 3 warnings emitted` — and the more serious reading is
 * the true one. */
export function diagnosticOf(line: string): "error" | "warning" | null {
  if (LEAD_ERR.test(line) || CODED_ERR.test(line) || TAGGED_ERR.test(line) || BRACKET_ERR.test(line))
    return "error";
  if (
    LEAD_WARN.test(line) ||
    CODED_WARN.test(line) ||
    TAGGED_WARN.test(line) ||
    BRACKET_WARN.test(line)
  )
    return "warning";
  return null;
}

/** What the `showing` knob narrows to. `problems` is the whole reason the knob
 *  exists here — see above. */
export function keeping(showing: string): ((l: string) => boolean) | null {
  return showing === "problems" ? (l) => diagnosticOf(l) !== null : null;
}

export const NARROWING: Record<string, string> = { problems: "to complain about" };

/** How many of each the log holds, for the header.
 *
 * Counted over the whole log rather than the drawn tail: "4 errors" when the
 * pane shows one of them is the number you want, and it is what tells you to
 * make the widget bigger. */
export function problems(log: readonly string[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const l of log) {
    const d = diagnosticOf(l);
    if (d === "error") errors++;
    else if (d === "warning") warnings++;
  }
  return { errors, warnings };
}

/** Build lines as the shared tail draws them.
 *
 * No gutter mark: every line of one build came from the same place, and an
 * action id repeated down the left edge is thirty columns of the same word on
 * a face that is short of columns. What the tone does instead is reach the
 * *text* — `LogTail`'s `tint`, which this widget turns on where the server log
 * leaves it off.
 *
 * The difference is worth stating, because the server log's comment argues the
 * other way and both are right. There, the signal is which *pipe* a line came
 * down, and half of everything logs perfectly calm prose to stderr — tinting on
 * that would be Skein overruling the program. Here the signal is the program
 * saying the word "error", with a colon after it, about itself. Reading that
 * back is not an opinion. And it is deferential in the one case it needs to be:
 * a line that arrived with its own SGR colour has that colour set inline on its
 * spans by `parseAnsi`, which wins over the tint inherited from the row — so a
 * toolchain that coloured its own error keeps its own red. */
export function rowsOf(lines: string[]): Row[] {
  return lines.map((l) => {
    const d = diagnosticOf(l);
    return {
      mark: null,
      tone: d === "error" ? ("fail" as const) : d === "warning" ? ("warn" as const) : ("plain" as const),
      text: l,
    };
  });
}

/** Whether there is a button instead of a reading, and what it says.
 *
 * **A failed build is not down**, which is the opposite of what the server log
 * decided about a crashed group and is right for the same underlying reason.
 * There, a dead server's log is stale and the useful gesture is to start it
 * again. Here the log of a failed build is the *entire point of the widget* —
 * it holds the four lines you are looking for — and replacing it with a button
 * would hide the answer behind the question. So the only down state is a
 * project that has never run anything, where there is genuinely nothing to
 * read, and re-pressing a finished action is left to the chips on the
 * territory's own edge, which are already on the wall a few inches away. */
export function standing(b: Build): { word: string; verb: string | null } | null {
  if (b.state !== "idle") return null;
  return b.again
    ? { word: "nothing built yet", verb: b.again.label }
    : /* A word and no button, which is a state `LogFace` allows for this one
         case. Drawn rather than hidden, the same way `actionsFor` draws a `no
         engine` chip: a project with no verbs is worth saying out loud, since
         the alternative is a widget that looks broken. */
      { word: "this project has nothing to build", verb: null };
}

/** The two absences, in this subject's words. */
export function absence(because: "none" | "gone"): string {
  return because === "gone"
    ? "the project this was set to is not on the wall any more — right-click to pick another"
    : "no projects on the wall yet — a build log reads whatever one of them last ran";
}

/** What the `projects` source resolves to for the right-click. */
export function projectOptions(builds: Build[]): { value: string; label: string }[] {
  return builds.map((b) => ({ value: b.id, label: b.project }));
}
