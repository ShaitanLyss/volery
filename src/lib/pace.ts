/* Pacing: how much of a weekly window may be spent by now, and whether the
 * wall should hold new work because of it (§14).
 *
 * **A cap is a wall; a pace is a gradient.** A cap answers "may I start work"
 * with a no at a percentage. A pace answers "am I going to make it to the
 * reset", which is a question about the *rate* and not about the level: a week
 * at 60% on Wednesday is comfortable and a week at 60% on Sunday is not.
 *
 * Three numbers, and the difference between them is the whole design:
 *
 * - **expected** — where a straight line from the reset to the next one puts
 *   the window now. The plan. Zero at the reset, one at the next.
 * - **actual** — the window's own reading, which is the account's and includes
 *   everybody's work.
 * - **projected** — actual plus the recent rate carried to the reset. This is
 *   the one that answers "will the week run out early", and it is deliberately
 *   a straight line too: a curve fitting the last few hours would be a
 *   forecast with a confidence nothing here has earned.
 *
 * Pure, and every reading it produces is a *fraction of the window*, so a five
 * hour and a week are never added to each other by accident.
 */

/** Which weekly window this is about. One, named, always. */
export type PlanWindow = {
  /** When the window opened. A week before it resets. */
  from: number;
  /** When it rolls. */
  reset: number;
};

/** What a person chose. Stored with the account (`conversation`'s registry),
 *  never with a view: a plan is a decision about spending, and the same person
 *  looks at it from whichever machine they are at. */
export type Plan = {
  /** Off means the pace is a reading and the wall holds nothing. */
  on: boolean;
  /** How it acts. `throttle` holds new work once the week is projected to run
   *  out; `brake` holds it once the pace passes `threshold`, which is the
   *  harsher of the two and the one to pick if the point is to make the week
   *  last rather than merely to avoid running out. */
  mode: "throttle" | "brake";
  /** A pace ratio for `brake`. 1 is exactly on the line; 1.15 is a sixth
   *  ahead of it. */
  threshold: number;
};

export const NO_PLAN: Plan = { on: false, mode: "throttle", threshold: 1.15 };
export const THRESHOLD_MIN = 1.0;
export const THRESHOLD_MAX = 2.0;

/** A stored plan, made drawable and usable. Anything unreadable is no plan —
 *  the opaque-column bargain (`widget.config_json`): a knob renamed in a later
 *  build costs the setting, and must never cost the wall a hold it cannot
 *  explain.
 *
 *  **Off when in doubt**, and that is the one direction worth arguing: a plan
 *  that came back from a newer build as `on` with a mode this one cannot name
 *  would hold work for a reason the wall could not say out loud. */
export function planOf(raw: unknown): Plan {
  if (!raw || typeof raw !== "object") return NO_PLAN;
  const o = raw as Record<string, unknown>;
  const on = o.on === true;
  const mode = o.mode === "brake" ? "brake" : "throttle";
  const t = Number(o.threshold);
  const threshold = Number.isFinite(t)
    ? Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, t))
    : NO_PLAN.threshold;
  return { on, mode, threshold };
}

/** Where the plan says this window should be, 0 to 1. */
export function expectedAt(from: number, reset: number, now: number): number {
  if (!(reset > from)) return 0;
  const span = reset - from;
  return Math.min(1, Math.max(0, (now - from) / span));
}

/** Points added per millisecond, over the part of the window that is in the
 *  past. `null` when there is nothing to measure — fewer than two samples, or
 *  two at the same instant.
 *
 *  **The last few hours, not the window.** The rate that matters for "will the
 *  week run out" is today's: a rate averaged over six days answers a question
 *  about last week. `recent` is the caller's span, because what counts as
 *  recent is a judgement about how bursty this person's work is.
 *
 *  Only the rising steps count. A window that dropped has rolled, and a
 *  negative rate would project a week that un-spends itself. */
export function rateOver(
  points: readonly { at: number; used: number }[],
  recent: number,
): number | null {
  const from = points.filter((p) => p.at >= recent && Number.isFinite(p.used));
  if (from.length < 2) return null;
  const first = from[0]!;
  const last = from[from.length - 1]!;
  const span = last.at - first.at;
  if (!(span > 0)) return null;
  const moved = last.used - first.used;
  return moved > 0 ? moved / span / 100 : 0;
}

/** Where the window lands at its reset if the recent rate holds, as a fraction.
 *  Clamped at zero; not clamped at one, because 1.4 is the interesting case. */
export function projectedAt(actual: number, ratePerMs: number, reset: number, now: number): number {
  const ahead = Math.max(0, reset - now);
  const extra = Number.isFinite(ratePerMs) ? Math.max(0, ratePerMs) * ahead : 0;
  return Math.max(0, actual + extra);
}

/** One window's pace, at one instant. */
export type Pace = {
  /** The plan's line, 0 to 1. */
  expected: number;
  /** The window's own reading, as a fraction. */
  actual: number;
  /** `actual / expected`, or `null` before the plan has any width to divide
   *  by: a pace measured against a line still at zero is a division by
   *  nothing, and it would read as an infinite overrun at the first frame. */
  pace: number | null;
  /** Where the week lands if today's rate holds. */
  projected: number;
  /** Whether the week is projected to run out before its reset. */
  over: boolean;
  /** The reason the wall gives when it holds work, or null where there is
   *  nothing to say. */
  why: string | null;
};

export function paceFor(input: {
  plan: Plan;
  window: PlanWindow;
  /** The window's reading, 0 to 100. */
  used: number;
  /** Points per millisecond, from `rateOver`. */
  rate: number | null;
  now: number;
}): Pace {
  const { plan, window, now } = input;
  const actual = Math.max(0, Math.min(1, (Number.isFinite(input.used) ? input.used : 0) / 100));
  const expected = expectedAt(window.from, window.reset, now);
  const rate = input.rate ?? 0;
  const projected = projectedAt(actual, rate, window.reset, now);
  const pace = expected > 0 ? actual / expected : null;
  const over = projected > 1;
  const at: Pace = { expected, actual, pace, projected, over, why: null };
  at.why = holdsNew(plan, at) ? paceNote(at) : null;
  return at;
}

/** Whether the plan wants new work held right now. Extracted from `paceFor` so
 *  a caller can ask the question of a pace it built itself.
 *
 *  **This never stops a turn in flight.** A paused turn has already paid for
 *  the context it built; pacing exists to spend less, and losing a turn to it
 *  is spending badly. The caller holds the *next* send — the held queue's
 *  existing shape, with a reason of its own. */
export function holdsNew(plan: Plan, pace: Pace): boolean {
  if (!plan.on) return false;
  if (plan.mode === "throttle") return pace.over;
  return pace.pace !== null && pace.pace > plan.threshold;
}

/** The sentence a held card carries. Says which plan, how far ahead, and when
 *  it lets go — the three things an account hold's sentence says, because a
 *  person should not have to tell the two reasons apart by their wording. */
export function paceNote(pace: Pace): string {
  const now = Math.round(pace.actual * 100);
  const plan = Math.round(pace.expected * 100);
  const land = Math.round(pace.projected * 100);
  return (
    `paced: the week is at ${now}% against a plan of ${plan}% by now, and at this rate it ` +
    `lands at ${land}% by the reset. new work waits; nothing running is stopped.`
  );
}

/** How a pace reads on a face: quiet under the line, warm on it, rust past it. */
export function paceTier(pace: Pace): "calm" | "warm" | "urgent" {
  if (pace.projected > 1) return "urgent";
  if (pace.pace !== null && pace.pace > 1) return "warm";
  return "calm";
}

/** What the face says under the line. **Faster or slower, never "ahead"**:
 *  ahead of a plan reads as a good thing and means the opposite here — the
 *  window is being spent faster than the line allows. */
export function paceSaid(pace: Pace): string {
  if (pace.projected > 1) {
    const over = Math.round((pace.projected - 1) * 100);
    return `runs out ${over}% before the reset`;
  }
  /* Nothing spent is not "well under the plan": a pace of nought against a
     line is a window nobody has touched, and the two read very differently on
     a Monday morning. */
  if (pace.actual === 0 || pace.pace === null) return "nothing spent yet";
  if (pace.pace > 1) return "faster than the plan";
  if (pace.pace < 0.85) return "well under the plan";
  return "on the plan";
}
