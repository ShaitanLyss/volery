import { describe, expect, test } from "bun:test";
import { instancesOf, type AllowanceSample } from "../src/lib/allowancesamples";
import {
  planWeeksOf,
  RATE_MS,
  WEEK_MS,
  type Plan,
} from "../src/lib/pace";
import {
  expectedAt,
  holdsNew,
  NO_PLAN,
  paceFor,
  paceHold,
  paceSaid,
  paceTier,
  planOf,
  projectedAt,
  rateOver,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
} from "../src/lib/pace";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESET = Date.UTC(2026, 10, 18, 0, 0, 0);
const FROM = RESET - 7 * DAY;
const at = (days: number) => FROM + days * DAY;

describe("the plan's line", () => {
  test("is nought at the reset and one at the next", () => {
    expect(expectedAt(FROM, RESET, FROM)).toBe(0);
    expect(expectedAt(FROM, RESET, RESET)).toBe(1);
  });

  test("is halfway through the week at its middle", () => {
    expect(expectedAt(FROM, RESET, at(3.5))).toBeCloseTo(0.5, 5);
  });

  /* A clock that ran past the reset, or a window with no width, must not
     divide by nothing downstream. */
  test("is clamped outside the window and safe with none", () => {
    expect(expectedAt(FROM, RESET, FROM - DAY)).toBe(0);
    expect(expectedAt(FROM, RESET, RESET + DAY)).toBe(1);
    expect(expectedAt(RESET, RESET, at(1))).toBe(0);
  });
});

describe("the plan a person chose", () => {
  test("is off unless it says on", () => {
    expect(planOf(undefined)).toEqual(NO_PLAN);
    expect(planOf({ mode: "throttle" }).on).toBe(false);
    expect(planOf({ on: true }).on).toBe(true);
  });

  /* The opaque-column bargain: a knob renamed by a newer build costs the
     setting and never the wall, and the direction that costs nothing is off. */
  test("degrades to off rather than to a hold nobody can explain", () => {
    expect(planOf("nonsense").on).toBe(false);
    expect(planOf({ on: "yes" }).on).toBe(false);
    expect(planOf({ on: true, mode: "sprint" }).mode).toBe("throttle");
  });

  test("clamps its threshold to the range a slider can reach", () => {
    expect(planOf({ on: true, threshold: 0.2 }).threshold).toBe(THRESHOLD_MIN);
    expect(planOf({ on: true, threshold: 9 }).threshold).toBe(THRESHOLD_MAX);
    expect(planOf({ on: true, threshold: 1.3 }).threshold).toBe(1.3);
    expect(planOf({ on: true, threshold: "x" }).threshold).toBe(NO_PLAN.threshold);
  });
});

describe("the rate the week is going at", () => {
  const points = [
    { at: at(2), used: 20 },
    { at: at(2) + HOUR, used: 22 },
  ];

  test("is points per millisecond, as a fraction", () => {
    expect(rateOver(points, at(2))).toBeCloseTo(2 / 100 / HOUR, 12);
  });

  test("measures only the recent span, because last week is not today's news", () => {
    const old = [{ at: at(0), used: 0 }, ...points];
    expect(rateOver(old, at(2))).toBeCloseTo(2 / 100 / HOUR, 12);
  });

  test("is null with nothing to measure", () => {
    expect(rateOver([], at(2))).toBeNull();
    expect(rateOver([points[0]!], at(2))).toBeNull();
    expect(rateOver([{ at: at(2), used: 5 }, { at: at(2), used: 9 }], at(2))).toBeNull();
  });

  /* A window that dropped has rolled. A negative rate would project a week
     that un-spends itself. */
  test("never negative", () => {
    expect(rateOver([{ at: at(2), used: 40 }, { at: at(2) + HOUR, used: 10 }], at(2))).toBe(0);
  });
});

describe("where the week lands", () => {
  test("carries today's rate to the reset", () => {
    expect(projectedAt(0.4, 0.01 / DAY, RESET, at(4))).toBeCloseTo(0.43, 5);
  });

  test("is the reading itself when nothing is moving", () => {
    expect(projectedAt(0.4, 0, RESET, at(4))).toBeCloseTo(0.4, 5);
  });
});

describe("the reading, and what it asks the wall to do", () => {
  const midWeek = at(3.5);
  const paceOn = { ...NO_PLAN, on: true };

  test("says how far over the line the week is", () => {
    const got = paceFor({ plan: paceOn, window: { from: FROM, reset: RESET }, used: 60, rate: null, now: midWeek });
    expect(got.expected).toBeCloseTo(0.5, 5);
    expect(got.actual).toBeCloseTo(0.6, 5);
    expect(got.pace).toBeCloseTo(1.2, 5);
  });

  /* A pace measured against a line still at zero is a division by nothing, and
     it would read as an infinite overrun at the first frame of every week. */
  test("has no pace before the plan has any width", () => {
    const got = paceFor({ plan: paceOn, window: { from: FROM, reset: RESET }, used: 0, rate: null, now: FROM });
    expect(got.pace).toBeNull();
    expect(holdsNew(paceOn, got)).toBe(false);
  });

  test("throttles new work once the week is projected to run out", () => {
    const rate = 0.004 / DAY; // 0.4% a day, so 1.4% over the 3.5 days left
    const got = paceFor({ plan: paceOn, window: { from: FROM, reset: RESET }, used: 99, rate, now: midWeek });
    expect(got.over).toBe(true);
    expect(holdsNew(paceOn, got)).toBe(true);
    expect(got.why).toContain("paced:");
    expect(got.why).toContain("nothing running is stopped");
  });

  test("and does not while the week has room", () => {
    const got = paceFor({ plan: paceOn, window: { from: FROM, reset: RESET }, used: 20, rate: 0, now: midWeek });
    expect(got.over).toBe(false);
    expect(holdsNew(paceOn, got)).toBe(false);
    expect(got.why).toBeNull();
  });

  test("a brake holds on the pace itself, which is the harsher reading", () => {
    const brake = { on: true, mode: "brake" as const, threshold: 1.15 };
    const ahead = paceFor({ plan: brake, window: { from: FROM, reset: RESET }, used: 60, rate: 0, now: midWeek });
    expect(ahead.over).toBe(false);
    expect(holdsNew(brake, ahead)).toBe(true);

    const on = paceFor({ plan: brake, window: { from: FROM, reset: RESET }, used: 50, rate: 0, now: midWeek });
    expect(holdsNew(brake, on)).toBe(false);
  });

  test("a plan that is off holds nothing, however far ahead the week is", () => {
    const got = paceFor({ plan: NO_PLAN, window: { from: FROM, reset: RESET }, used: 95, rate: 1, now: midWeek });
    expect(got.over).toBe(true);
    expect(holdsNew(NO_PLAN, got)).toBe(false);
  });
});

describe("the hold a plan puts on new work", () => {
  const plan = { ...NO_PLAN, on: true };
  const midWeek = at(3.5);
  const reading = (used: number, rate: number | null = null) =>
    paceFor({ plan, window: { from: FROM, reset: RESET }, used, rate, now: midWeek });

  test("is the plan's sentence and the week's reset, when the plan is holding", () => {
    const hold = paceHold(plan, reading(99, 0.004 / DAY), RESET);
    expect(hold?.why).toContain("paced:");
    expect(hold?.until).toBe(RESET);
  });

  test("is nothing at all when the plan is off or the week has room", () => {
    expect(paceHold(NO_PLAN, reading(99, 0.004 / DAY), RESET)).toBeNull();
    expect(paceHold(plan, reading(20, 0), RESET)).toBeNull();
  });
});

describe("how a pace is said", () => {
  const one = (over: Partial<Parameters<typeof paceFor>[0]> = {}) =>
    paceFor({ plan: { ...NO_PLAN, on: true }, window: { from: FROM, reset: RESET }, used: 60, rate: null, now: at(3.5), ...over });

  /* "Ahead" of a plan reads as good and means the opposite: the window is
     being spent faster than the line allows. */
  test("as faster or slower, never as ahead", () => {
    expect(paceSaid(one())).toBe("faster than the plan");
    expect(paceSaid(one({ used: 20 }))).toBe("well under the plan");
    expect(paceSaid(one({ used: 50 }))).toBe("on the plan");
    expect(paceSaid(one({ used: 0 }))).toBe("nothing spent yet");
  });

  test("and says plainly when the week does not reach its reset", () => {
    const said = paceSaid(one({ used: 99, rate: 0.004 / DAY }));
    expect(said).toContain("runs out");
    expect(said).toContain("before the reset");
  });

  test("tiers by what will happen, not by what has", () => {
    expect(paceTier(one({ used: 99, rate: 0.004 / DAY }))).toBe("urgent");
    expect(paceTier(one({ used: 60 }))).toBe("warm");
    expect(paceTier(one({ used: 20 }))).toBe("calm");
  });
});

describe("the week against the plan, as the room draws it", () => {
  const RESET = Date.UTC(2026, 10, 18, 0, 0, 0);
  const OPENED = RESET - WEEK_MS;
  const on: Plan = { ...NO_PLAN, on: true };
  const sample = (over: Partial<AllowanceSample> & { at: number; used: number }): AllowanceSample => ({
    host: "studio",
    account: "tx-team",
    kind: "weekly_all",
    scope: "",
    resetsAt: RESET,
    severity: "normal",
    plan: "team",
    source: "poll",
    ...over,
  });

  test("is the window's line, its readings and where the rate puts it", () => {
    const now = OPENED + 6 * DAY + 2 * HOUR;
    const samples = [
      sample({ at: OPENED + DAY, used: 10 }),
      sample({ at: OPENED + 3 * DAY, used: 30 }),
      sample({ at: OPENED + 6 * DAY, used: 50 }),
      sample({ at: OPENED + 6 * DAY + HOUR, used: 52, source: "stream" }),
    ];
    const weeks = planWeeksOf(instancesOf(samples), () => on, now);
    expect(weeks).toHaveLength(1);
    const w = weeks[0]!;
    expect(w.account).toBe("tx-team");
    expect(w.opened).toBe(OPENED);
    expect(w.reset).toBe(RESET);
    expect(w.used).toBe(52);
    expect(w.expected).toBeCloseTo((6 * DAY + 2 * HOUR) / WEEK_MS, 4);
    expect(w.pace.actual).toBeCloseTo(0.52);
    expect(w.projected).toBeGreaterThan(0.52);
    expect(w.holding).toBe(false);
  });

  test("is only a week that is still running, and only one with a plan", () => {
    const now = OPENED + 6 * DAY;
    const samples = [
      sample({ at: OPENED + 3 * DAY, used: 30 }),
      sample({ at: OPENED + 3 * DAY, used: 30, kind: "session", resetsAt: now + HOUR }),
      sample({ at: OPENED + 3 * DAY, used: 30, kind: "weekly_scoped" }),
    ];
    expect(planWeeksOf(instancesOf(samples), () => on, now)).toHaveLength(1);
    expect(planWeeksOf(instancesOf(samples), () => null, now)).toHaveLength(0);
    expect(planWeeksOf(instancesOf(samples), () => on, RESET + HOUR)).toHaveLength(0);
    expect(planWeeksOf(instancesOf(samples), () => ({ ...on, on: false }), now)).toHaveLength(0);
  });

  test("draws the hold the gate would take", () => {
    const now = OPENED + 6 * DAY + 2 * HOUR;
    const samples = [
      sample({ at: OPENED + 6 * DAY, used: 96 }),
      sample({ at: OPENED + 6 * DAY + HOUR, used: 99, source: "stream" }),
    ];
    const w = planWeeksOf(instancesOf(samples), () => on, now)[0]!;
    expect(w.projected).toBeGreaterThan(1);
    expect(w.holding).toBe(true);
  });

  test("measures the rate over the same span the gate does", () => {
    expect(RATE_MS).toBe(6 * HOUR);
  });
});
