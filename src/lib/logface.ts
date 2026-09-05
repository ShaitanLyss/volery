/* What every log on the wall has in common, and nothing about any one of them.
 *
 * Three instruments read a stream of lines somebody else is producing — a dev
 * server group (`serverlog.ts`), a build or test run (`buildlog.ts`), and a
 * running Unreal editor (`unreallog.ts`). They are three widgets rather than
 * three variants of one, because the *subject* differs in every way that a
 * widget is made of: a group has ports and per-server health and a start
 * button, a run has a verdict and a percentage and a run-again button, an
 * editor log has categories and verbosities and an open-the-editor button. A
 * single kind with a `source` knob would be a spec whose every other knob was
 * guarded off against it — and the right-click's variant menu would hand you an
 * unrelated instrument.
 *
 * What they genuinely share is this file and the two components beside it: how
 * many lines a box of a given height has room for, which subject a widget is
 * about and how to say so when it is about none, and what a filter that emptied
 * the pane owes the person looking at it. Written once because it was got right
 * once — the arithmetic below exists for a reason about the *wall* rather than
 * about logs, and a second copy of it would be a second place to be wrong about
 * the wheel.
 *
 * Pure — no runes, no DOM. `LogFace.svelte` draws the frame and
 * `LogTail.svelte` draws the lines. */

/** The one literal every subject knob has: follow the wall rather than name a
 *  thing on it.
 *
 * The default in all three widgets, and for one reason — it is the setting that
 * stays right. Groups are added, projects come and go, runs are pressed hours
 * after a widget was hung up, and a wall where the thing you are watching is
 * simply "whatever is working" is most walls. Nothing is hidden by it either:
 * every face names its subject in its own header, so following and pinning read
 * the same and differ only in what happens when a second thing starts. */
export const FOLLOW = "running";

/** How many lines a log of this height has room for.
 *
 * The box you drag it to is the setting, which is the rule the whole widget
 * catalogue is built on — and here it is load-bearing rather than tasteful:
 * `Canvas` preventDefaults every wheel on the surface to zoom the wall, so a
 * pane on the wall cannot be scrolled with the wheel. A widget that overflowed
 * would hide its newest lines behind a scrollbar nothing could move. So it does
 * not overflow: what fits is what is drawn, anchored to the tail, and
 * scrollback lives in a panel, which is a panel and does scroll.
 *
 * Not `rowsFor`, which the meter, the pipelines and the reviews faces share:
 * those are three lists of the same one-line rows at the same size, and a log
 * is monospace and denser. Sharing it would have made this arithmetic wrong
 * about its own CSS, which is the one thing it is for. Measured against `.log`
 * in `LogTail.svelte` — change that font size and this comes with it. */
const HEAD = 22;
const LINE = 15;

export function linesFor(h: number): number {
  return Math.max(1, Math.floor((h - HEAD - 6) / LINE));
}

/** Which of the things on the wall this widget is a reading of, and why it is a
 *  reading of nothing when it is.
 *
 * Two absences, and they are different things to say. `none` is a wall with
 * nothing of this sort on it at all — the widget is fine and there is nothing
 * yet to point it at. `gone` is a widget that names something which is not here
 * any more, which is the deleted case and the one thing that must not be
 * papered over by quietly showing a different subject's output: the log would
 * be somebody else's and nothing would say so. Following is not that case — a
 * widget set to follow claims nothing in particular, and the header names
 * whatever it settled on.
 *
 * `live` is what "whichever is running" means to this subject, and each of the
 * three answers it differently — a group that is up, a run that is still going,
 * a project whose editor is open.
 *
 * ### And what a follower does when nothing is live, which was got wrong
 *
 * It used to take `all[0]`, on the argument that a wall where nothing is
 * working has one honest answer. That is true of a wall where nothing has
 * *ever* worked and false of the case it actually hit: a build log follows a
 * project through its compile and then, the instant the compile finishes, no
 * subject is live any more and the widget wanders off to whichever project sorts
 * first — which is very often one that has never run anything, so the reading
 * you were waiting three minutes for is replaced by "this project has nothing to
 * build" at the exact moment it arrives (sink f2cce1c8). `buildlog.ts` even
 * claims the opposite in prose: *the moment it finishes the widget stays on it
 * rather than wandering, because the finished log is the reading you wanted.*
 * `isLive` alone could never have kept that promise — a predicate answers "is
 * this one working", and nothing in it remembers which one just was.
 *
 * So the fallback is *the most recently live subject*, and only then the first.
 * `recency` is what each subject knows about that, bigger meaning more recent
 * and zero meaning never; a subject that has no notion of it passes none and
 * gets the old behaviour, which is right where nothing is ever put down — the
 * server log's `live` stays true for a group that crashed, so there is nothing
 * for it to wander away from. Ties keep list order, since `>` is strict. */
export type Found<T> = { it: T } | { it: null; because: "none" | "gone" };

export function subjectOf<T extends { id: string }>(
  want: string,
  all: T[],
  live?: (t: T) => boolean,
  recency?: (t: T) => number,
): Found<T> {
  if (!all.length) return { it: null, because: "none" };
  if (want && want !== FOLLOW) {
    const named = all.find((t) => t.id === want);
    return named ? { it: named } : { it: null, because: "gone" };
  }
  /* What is working; then what worked last; then whatever is there. You hang a
     log up to watch the thing that is doing something, and a thing that has
     just stopped doing it is still that thing. A wall where nothing has ever
     worked says so with the first subject and whatever button it offers. */
  const working = live ? all.find(live) : undefined;
  return { it: working ?? (recency ? latest(all, recency) : undefined) ?? all[0] };
}

function latest<T>(all: T[], recency: (t: T) => number): T | undefined {
  let best: T | undefined;
  let when = 0;
  for (const t of all) {
    const at = recency(t);
    if (Number.isFinite(at) && at > when) {
      best = t;
      when = at;
    }
  }
  return best;
}

/** The tail this widget has room for, and how much the filter is keeping back.
 *
 * `hidden` counts what the *filter* dropped rather than what did not fit: a
 * problems-only reading of a build that printed two hundred clean lines is
 * legitimately empty, and an empty pane that cannot say why reads as a widget
 * that has broken. What scrolled off the top needs no such apology — it is
 * simply older, and a taller widget shows more of it.
 *
 * Generic over the line, because the three subjects hold three different ones:
 * a server line knows which pipe it came down, a build line is a bare string, an
 * editor line has been parsed into a category and a verbosity. The predicate is
 * the whole of what the caller has to supply, which keeps the *narrowing* — the
 * `showing` knob every one of them has — one axis with three vocabularies
 * rather than three axes. */
export function tail<T>(
  log: readonly T[],
  keep: ((l: T) => boolean) | null,
  rows: number,
): { lines: T[]; hidden: number } {
  const kept = keep ? log.filter(keep) : log;
  return {
    lines: (kept.length > rows ? kept.slice(kept.length - rows) : kept) as T[],
    hidden: log.length - kept.length,
  };
}

/** What a line looks like once a subject has decided how to draw it.
 *
 * The gutter mark is whatever names the source of the line in one short word —
 * a server's label, an action's id, an Unreal log category — and `tone` is the
 * only judgement about it this layer holds. Deliberately not a colour: the
 * palette lives in the component, so a theme change reaches these without
 * anything pure having an opinion about `--st-fail`. */
export type Tone = "plain" | "warn" | "fail";

export type Row = {
  mark: string | null;
  tone: Tone;
  /** As printed, escapes and all — `LogTail` renders whatever ANSI is in it. */
  text: string;
};

/** How a filter that emptied the pane explains itself.
 *
 * One sentence assembled in one place because all three widgets owe it and it
 * is the kind of prose that drifts: `hidden` lines dropped, and what they were
 * dropped for in the subject's own words. Null when nothing was dropped, which
 * is the genuinely-nothing-yet case and reads differently. */
export function emptyBecause(hidden: number, narrowing: string): string | null {
  if (hidden <= 0) return null;
  return `nothing ${narrowing} — ${hidden} ${hidden === 1 ? "line" : "lines"} filtered out`;
}
