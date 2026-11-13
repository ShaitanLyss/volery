import { describe, expect, test } from "bun:test";
import { instancesOf, type AllowanceSample } from "../src/lib/allowancesamples";
import {
  FASTER,
  fillSaid,
  fillSaidLine,
  fillsOf,
  fillTrend,
  fillTrends,
  fillWarning,
  MIN_FILLS,
  SESSION_MS,
  trendSaid,
  type Fill,
} from "../src/lib/fill";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESET = Date.UTC(2026, 10, 13, 8, 30);
const OPEN = RESET - SESSION_MS;

function s(over: Partial<AllowanceSample> & { at: number; used: number }): AllowanceSample {
  return {
    host: "studio",
    account: "tx-team",
    kind: "session",
    scope: "",
    resetsAt: RESET,
    severity: "normal",
    plan: null,
    source: "poll",
    ...over,
  };
}

describe("one five-hour window's fill", () => {
  test("is the time it took to reach 100", () => {
    const fills = fillsOf(
      instancesOf([
        s({ at: OPEN + 10 * MIN, used: 0 }),
        s({ at: OPEN + 40 * MIN, used: 50 }),
        s({ at: OPEN + 80 * MIN, used: 100 }),
      ]),
      RESET + HOUR,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]!.hours).toBeCloseTo(80 / 60, 4);
    expect(fills[0]!.filled).toBe(true);
    expect(fills[0]!.closed).toBe(true);
  });

  /* The user's own example: a window that does not fill inside its five hours
     is timed by the rate it did move at, so it can read past five. */
  test("goes past five hours when the window closes unfinished", () => {
    const fills = fillsOf(
      instancesOf([
        s({ at: OPEN + 30 * MIN, used: 10 }),
        s({ at: OPEN + 2 * HOUR, used: 60 }),
      ]),
      RESET + HOUR,
    );
    expect(fills[0]!.filled).toBe(false);
    expect(fills[0]!.hours).toBeCloseTo((2 * 100) / 60, 4);
  });

  /** The percentage is cumulative from the opening, so a wall that first looked
   *  at a window when it was already at 70% still knows the window's average
   *  rate. This is the whole reason the reading does not need early samples. */
  test("needs no first sample, because the level is from the opening", () => {
    const fills = fillsOf(
      instancesOf([
        s({ at: OPEN + 3.5 * HOUR, used: 70 }),
        s({ at: OPEN + 3.6 * HOUR, used: 72 }),
      ]),
      RESET + HOUR,
    );
    expect(fills[0]!.hours).toBeCloseTo((3.6 * 100) / 72, 4);
  });

  test("only the five-hour window, and only one with a reset", () => {
    const fills = fillsOf(
      instancesOf([
        s({ at: OPEN + HOUR, used: 40 }),
        s({ at: OPEN + HOUR, used: 40, kind: "weekly_all", resetsAt: RESET + 3 * DAY }),
        s({ at: OPEN + HOUR, used: 40, resetsAt: null }),
      ]),
      RESET + HOUR,
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]!.account).toBe("tx-team");
  });

  test("a window that moved nothing has no rate", () => {
    const fills = fillsOf(instancesOf([s({ at: OPEN + HOUR, used: 0 })]), RESET + HOUR);
    expect(fills[0]!.hours).toBeNull();
    expect(fillSaidLine(fills[0]!)).toBe("no movement yet");
  });

  test("an open window is a projection and says so", () => {
    const fills = fillsOf(instancesOf([s({ at: OPEN + HOUR, used: 50 })]), OPEN + HOUR);
    expect(fills[0]!.closed).toBe(false);
    expect(fillSaidLine(fills[0]!)).toBe("fills in 2h at this rate");
  });
});

describe("the trend over windows", () => {
  const now = Date.UTC(2026, 10, 13, 12, 0);
  function fill(resetsAt: number, hours: number, over: Partial<Fill> = {}): Fill {
    return {
      account: "tx-team",
      resetsAt,
      opened: resetsAt - SESSION_MS,
      used: 100,
      into: hours * HOUR,
      hours,
      filled: true,
      crossedAt: resetsAt - SESSION_MS + hours * HOUR,
      closed: true,
      ...over,
    };
  }
  const recent = (hours: number) => [1, 2, 3].map((d) => fill(now - d * HOUR, hours));
  const before = (hours: number) =>
    [24, 30, 40, 48, 60, 72].map((h) => fill(now - h * HOUR, hours));

  test("compares the median of the day with the week before it", () => {
    const got = fillTrend([...recent(1.2), ...before(2)], now);
    expect(got.recent).toBeCloseTo(1.2);
    expect(got.before).toBeCloseTo(2);
    expect(got.ratio).toBeCloseTo(0.6);
    expect(got.verdict).toBe("faster");
    expect(fillWarning("tx-team", got)).toContain("either the allowance got smaller or the work got heavier");
    expect(fillWarning("tx-team", got)).toContain("tx-team");
    expect(trendSaid(got)).toContain("40% faster");
  });

  test("says nothing off too few windows on either side", () => {
    const short = fillTrend([...recent(1).slice(0, MIN_FILLS - 1), ...before(2)], now);
    expect(short.verdict).toBe("unknown");
    expect(fillWarning("tx-team", short)).toBeNull();
    const none = fillTrend([], now);
    expect(none.verdict).toBe("unknown");
    expect(trendSaid(none)).toBeNull();
  });

  test("a mild change is steady, and a slower one is not a warning", () => {
    expect(fillTrend([...recent(1.9), ...before(2)], now).verdict).toBe("steady");
    const slower = fillTrend([...recent(3), ...before(2)], now);
    expect(slower.verdict).toBe("slower");
    expect(fillWarning("tx-team", slower)).toBeNull();
  });

  /** An open window moves every time a turn lands; a median full of them would
   *  be a reading of the last minute. */
  test("an open window is not in the comparison", () => {
    const got = fillTrend([...recent(2), fill(now - 10 * MIN, 0.05, { closed: false }), ...before(2)], now);
    expect(got.recent).toBeCloseTo(2);
    expect(got.counts.recent).toBe(3);
  });

  /** A window seen for five minutes projects from two readings, which is noise
   *  dressed as a rate; a window that actually filled needs no floor. */
  test("an unfinished window barely watched is not compared", () => {
    const barely = fill(now - HOUR, 0.05, { filled: false, crossedAt: null, into: 5 * MIN, used: 5 });
    const got = fillTrend([...recent(2).slice(0, 2), barely, ...before(2)], now);
    expect(got.counts.recent).toBe(2);
    const full = fill(now - HOUR, 0.05, { filled: true, into: 5 * MIN, used: 100 });
    expect(fillTrend([...recent(2).slice(0, 2), full, ...before(2)], now).counts.recent).toBe(3);
  });

  test("the threshold is the one the module documents", () => {
    const got = fillTrend([...recent(2 * FASTER), ...before(2)], now);
    expect(got.verdict).toBe("faster");
  });

  test("one trend per account, in the registry's order", () => {
    const mine = fillTrends([...recent(1), ...before(2)], ["tx-team", "personal"], now);
    expect([...mine.keys()]).toEqual(["tx-team", "personal"]);
    expect(mine.get("tx-team")!.verdict).toBe("faster");
    expect(mine.get("personal")!.verdict).toBe("unknown");
  });
});

describe("how a fill is said", () => {
  test("as a span under a day", () => {
    expect(fillSaid(1.333)).toBe("1h 20m");
    expect(fillSaid(2)).toBe("2h");
    expect(fillSaid(6.25)).toBe("6h 15m");
    expect(fillSaid(0.5)).toBe("30m");
  });
});
