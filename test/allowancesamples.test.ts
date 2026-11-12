import { describe, expect, test } from "bun:test";
import {
  allowanceResidual,
  asAllowanceSamples,
  attributedCostOf,
  bindingOf,
  costBucketsOf,
  daySpend,
  FINE_BUCKET_MS,
  instancesOf,
  samplesOf,
  spansOf,
  type AllowanceCost,
  type AllowanceSample,
  type CostBucket,
} from "../src/lib/allowancesamples";
import { stripModel, weekResidual } from "../src/lib/analyticstiles";

const HOUR = 3_600_000;

/** The strip's input with its two folded halves built the way the shell does:
 *  instances once, and the week's residual once. */
function stripOf(input: { samples: any; costs: any; coveredFrom: number; now: number; fleet: any }) {
  const instances = input.samples === null ? [] : instancesOf(input.samples);
  return stripModel({ ...input, instances, week: weekResidual(input.samples, instances, input.costs, input.now) });
}
const NOW = new Date(2026, 10, 12, 15, 0).getTime();

function sample(over: Partial<AllowanceSample> = {}): AllowanceSample {
  return {
    at: NOW,
    host: "studio",
    account: "lyss",
    kind: "session",
    scope: "",
    used: 10,
    resetsAt: NOW + 2 * HOUR,
    severity: "normal",
    plan: "team",
    source: "poll",
    ...over,
  };
}

describe("the curve between two samples", () => {
  test("steps are summed, and the last reading is what holds", () => {
    const got = instancesOf([
      sample({ at: NOW - 40 * 60_000, used: 10 }),
      sample({ at: NOW - 20 * 60_000, used: 14 }),
      sample({ at: NOW, used: 19 }),
    ]);
    expect(got.length).toBe(1);
    expect(got[0].delta).toBe(9);
    expect(got[0].last).toBe(19);
    expect(got[0].points.map((p) => p.used)).toEqual([10, 14, 19]);
  });

  test("a roll closes the instance and nothing is carried across it", () => {
    const got = instancesOf([
      sample({ at: NOW - 2 * HOUR, used: 88, resetsAt: NOW - HOUR }),
      sample({ at: NOW, used: 4, resetsAt: NOW + 4 * HOUR }),
    ]);
    expect(got.length).toBe(2);
    expect(got[0].delta).toBe(0);
    expect(got[1].first).toBe(4);
    expect(got[1].delta).toBe(0);
  });

  test("a moved reset is a new instance even when the reading rose", () => {
    const got = instancesOf([
      sample({ at: NOW - HOUR, used: 10, resetsAt: NOW + HOUR }),
      sample({ at: NOW, used: 12, resetsAt: NOW + 8 * HOUR }),
    ]);
    expect(got.length).toBe(2);
  });

  test("a window with no reset contributes no delta and never joins one with a reset", () => {
    const got = instancesOf([
      sample({ at: NOW - HOUR, used: 4, resetsAt: null }),
      sample({ at: NOW, used: 6, resetsAt: null }),
    ]);
    expect(got.length).toBe(1);
    expect(got[0].resetsAt).toBeNull();
    expect(got[0].delta).toBe(2, "the instance can still rise; it just names no reset");
    const split = instancesOf([
      sample({ at: NOW - HOUR, used: 4, resetsAt: null }),
      sample({ at: NOW, used: 6, resetsAt: NOW + HOUR }),
    ]);
    expect(split.length).toBe(2);
  });

  test("two accounts and two kinds are separate instances", () => {
    const got = instancesOf([
      sample({ account: "lyss", kind: "session", used: 10 }),
      sample({ account: "lyss", kind: "weekly_all", used: 40 }),
      sample({ account: "tx-team", kind: "session", used: 5 }),
    ]);
    expect(got.length).toBe(3);
  });
});

describe("the binding window", () => {
  test("the fullest window that has not reset, across every account", () => {
    const instances = instancesOf([
      sample({ account: "lyss", used: 62 }),
      sample({ account: "tx-team", kind: "weekly_all", used: 46 }),
    ]);
    expect(bindingOf(instances, NOW)!.account).toBe("lyss");
  });

  test("a window past its reset is given back and does not bind", () => {
    const instances = instancesOf([
      sample({ account: "lyss", used: 97, resetsAt: NOW - 1 }),
      sample({ account: "tx-team", kind: "weekly_all", used: 46, resetsAt: NOW + HOUR }),
    ]);
    expect(bindingOf(instances, NOW)!.account).toBe("tx-team");
  });

  test("a tie goes to the one that comes back soonest", () => {
    const instances = instancesOf([
      sample({ account: "lyss", used: 50, resetsAt: NOW + 4 * HOUR }),
      sample({ account: "tx-team", used: 50, resetsAt: NOW + HOUR }),
    ]);
    expect(bindingOf(instances, NOW)!.account).toBe("tx-team");
  });

  test("no samples is no binding window, not zero percent", () => {
    expect(bindingOf([], NOW)).toBeNull();
  });
});

describe("attributing the delta", () => {
  const bucket = (at: number, account: string, cost: number, host = "studio"): CostBucket => ({
    at,
    host,
    account,
    cost,
  });

  test("a fact bucket straddling a sample boundary is split by its width", () => {
    const at = NOW - 2 * FINE_BUCKET_MS;
    const instances = instancesOf([
      sample({ at, used: 10 }),
      sample({ at: at + FINE_BUCKET_MS / 2, used: 20 }),
    ]);
    /* Half the bucket is inside the interval: half its cost is. */
    const spans = spansOf(instances, [bucket(at, "lyss", 2)], "lyss");
    expect(spans.length).toBe(1);
    expect(spans[0].delta).toBe(10);
    expect(spans[0].facts[0].cost).toBeCloseTo(1, 10);
  });

  test("the exchange rate's dollar side is only this account's own facts", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ kind: "weekly_all", at, used: 10 }),
      sample({ kind: "weekly_all", at: at + FINE_BUCKET_MS, used: 30 }),
    ]);
    const exchange = attributedCostOf(
      instances,
      [bucket(at, "lyss", 3), bucket(at, "tx-team", 7)],
      "lyss",
      "weekly_all",
    )!;
    expect(exchange.delta).toBe(20);
    expect(exchange.cost).toBeCloseTo(3);
    /* Twenty points cost $3 of modelled work, so one point is fifteen cents. */
    expect(exchange.cost / exchange.delta).toBeCloseTo(0.15);
  });

  test("a window that did not move has no exchange rate, and so does a sentinel", () => {
    const at = NOW - HOUR;
    const still = instancesOf([
      sample({ kind: "weekly_all", at, used: 10 }),
      sample({ kind: "weekly_all", at: at + FINE_BUCKET_MS, used: 10 }),
    ]);
    expect(attributedCostOf(still, [bucket(at, "lyss", 3)], "lyss", "weekly_all")).toBeNull();
    expect(attributedCostOf(still, [bucket(at, "@deepseek", 3)], "@deepseek", "weekly_all")).toBeNull();
  });

  test("another account's facts are not in this account's denominator", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ kind: "weekly_all", at, used: 10 }),
      sample({ kind: "weekly_all", at: at + FINE_BUCKET_MS, used: 20 }),
    ]);
    const r = allowanceResidual(instances, [bucket(at, "lyss", 3), bucket(at, "tx-team", 7)]);
    expect(r.delta).toBe(10);
    expect(r.attributed).toBe(10);
    expect(r.residual).toBe(0);
    expect(r.readings.length).toBe(1, "only the account that has a sample");
  });

  test("an interval with no facts is wholly residual, and nothing is scaled up", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ kind: "weekly_all", at, used: 10 }),
      sample({ kind: "weekly_all", at: at + HOUR, used: 25 }),
    ]);
    const r = allowanceResidual(instances, []);
    expect(r.delta).toBe(15);
    expect(r.residual).toBe(15);
    expect(r.coverage).toBe("partial", "a sampled host with no facts is not a complete account");
  });

  test("a provider sentinel has no subscription residual at all", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ account: "@deepseek", kind: "weekly_all", at, used: 10 }),
      sample({ account: "@deepseek", kind: "weekly_all", at: at + HOUR, used: 20 }),
    ]);
    const r = allowanceResidual(instances, []);
    expect(r.accounts).toEqual([]);
    expect(r.delta).toBe(0);
  });

  test("the five-hour and the week are never summed: one kind, one reading", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ account: "lyss", kind: "session", at, used: 10 }),
      sample({ account: "lyss", kind: "session", at: at + HOUR, used: 30 }),
      sample({ account: "lyss", kind: "weekly_all", at, used: 40 }),
      sample({ account: "lyss", kind: "weekly_all", at: at + HOUR, used: 46 }),
    ]);
    const week = allowanceResidual(instances, [], "weekly_all");
    expect(week.kind).toBe("weekly_all");
    expect(week.delta).toBe(6, "the session window's 20 points are another currency");
    const session = allowanceResidual(instances, [], "session");
    expect(session.delta).toBe(20);
  });
});

describe("today against yesterday", () => {
  test("a window that does not reach yesterday's midnight says so rather than drawing part of it", () => {
    const dayStart = new Date(2026, 10, 12, 0, 0).getTime();
    const buckets = [bucketAt(dayStart + HOUR, 2), bucketAt(dayStart - 2 * HOUR, 5)];
    const yesterdayFrom = dayStart - 24 * HOUR;
    const near = daySpend(buckets, NOW, dayStart, yesterdayFrom, dayStart + HOUR);
    expect(near.today).toBe(2);
    expect(near.yesterday).toBeNull();
    const far = daySpend(buckets, NOW, dayStart, yesterdayFrom, yesterdayFrom);
    expect(far.yesterday).toBe(5);
  });

  function bucketAt(at: number, cost: number): CostBucket {
    return { at, host: "studio", account: "lyss", cost };
  }
});

describe("noting a reading", () => {
  test("a report whose source names another wall is a peer reading", () => {
    const rows = samplesOf("lyss", {
      windows: [{ kind: "session", scope: null, used: 27, resetsAt: NOW + HOUR, severity: "normal" }],
      at: NOW,
      plan: "team",
      source: "read on lab",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("peer");
    expect(rows[0].host).toBe("lab");
    expect(rows[0].used).toBe(27);
    expect(samplesOf("lyss", { windows: [], at: NOW, source: "" }).length).toBe(0);
    expect(
      samplesOf("lyss", {
        windows: [{ kind: "session", scope: null, used: 27, resetsAt: null, severity: "normal" }],
        at: NOW,
      })[0].source,
    ).toBe("poll");
  });

  test("a row that will not parse is dropped rather than read as zero percent", () => {
    const rows = asAllowanceSamples([
      { at: NOW, account: "lyss", kind: "session", used: 27, source: "poll" },
      { at: NOW, account: "", kind: "session", used: 5 },
      { at: NOW, account: "lyss", kind: "session", used: "half" },
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].resetsAt).toBeNull();
    expect(rows[0].severity).toBe("normal");
  });
});

describe("the live strip", () => {
  const none: CostBucket[] = [];

  test("a tile that cannot be measured says so, and never shows zero for unknown", () => {
    const failed = stripOf({ samples: null, costs: none, coveredFrom: NOW - 8 * 86_400_000, now: NOW, fleet: null });
    expect(failed[0].off).toBe(true);
    expect(failed[0].value).toBe("not read");
    const nothing = stripOf({ samples: [], costs: none, coveredFrom: NOW - 8 * 86_400_000, now: NOW, fleet: null });
    expect(nothing[0].off).toBe(true);
    expect(nothing[0].value).toBe("no sample yet");
    expect(nothing.find((t) => t.key === "burn")!.off).toBe(true);
    const unread = stripOf({
      samples: [sample({ used: 62 })],
      costs: null,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: null,
    });
    expect(unread.find((t) => t.key === "unattributed")!.off).toBe(true);
    expect(unread.find((t) => t.key === "today")!.off).toBe(true);
  });

  test("the binding tile draws the window, the account and the countdown", () => {
    const tiles = stripOf({
      samples: [sample({ used: 62, resetsAt: NOW + 2 * HOUR })],
      costs: none,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: { rate: 900, parts: [{ host: null, rate: 900 }], silent: [], cards: 3, local: 3, measured: true },
    });
    const allowance = tiles.find((t) => t.key === "allowance")!;
    expect(allowance.value).toBe("62%");
    expect(allowance.note).toContain("lyss");
    expect(allowance.note).toContain("resets in 2h");
    expect(tiles.find((t) => t.key === "burn")!.value).toContain("tok/min");
    expect(tiles.find((t) => t.key === "cards")!.value).toBe("3");
    expect(tiles.length).toBe(5);
  });

  test("no delta this week is a measured zero, not an unknown", () => {
    const tiles = stripOf({
      samples: [sample({ kind: "weekly_all", used: 62 })],
      costs: none,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: null,
    });
    const unattributed = tiles.find((t) => t.key === "unattributed")!;
    expect(unattributed.off).toBe(false);
    expect(unattributed.value).toBe("0 pts");
  });

  test("a week's delta with no facts is all residual, and says the reading is partial", () => {
    const at = NOW - 2 * HOUR;
    const tiles = stripOf({
      samples: [
        sample({ kind: "weekly_all", at, used: 40 }),
        sample({ kind: "weekly_all", at: at + HOUR, used: 55 }),
      ],
      costs: none,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: null,
    });
    const unattributed = tiles.find((t) => t.key === "unattributed")!;
    expect(unattributed.value).toBe("15 pts");
    expect(unattributed.note).toContain("partial");
  });

  test("a wall read only on the five-hour window says so, rather than reporting its points as a week", () => {
    const at = NOW - 2 * HOUR;
    const tiles = stripOf({
      samples: [sample({ at, used: 40 }), sample({ at: at + HOUR, used: 55 })],
      costs: none,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: null,
    });
    const unattributed = tiles.find((t) => t.key === "unattributed")!;
    expect(unattributed.off).toBe(true);
    expect(unattributed.value).toBe("no weekly sample");
  });

  test("a wall whose burn nothing is reading does not draw 0 tok/min", () => {
    const tiles = stripOf({
      samples: [],
      costs: none,
      coveredFrom: NOW - 8 * 86_400_000,
      now: NOW,
      fleet: { rate: 0, parts: [{ host: null, rate: 0 }], silent: [], cards: 2, local: 2, measured: false },
    });
    const burn = tiles.find((t) => t.key === "burn")!;
    expect(burn.off).toBe(true);
    expect(burn.value).toBe("not read");
    /* A wall heard from still makes the cards figure a fleet one. */
    expect(tiles.find((t) => t.key === "cards")!.note).toBe("on this machine");
  });
});

describe("pricing a bucket", () => {
  const cost = (over: Partial<AllowanceCost> = {}): AllowanceCost => ({
    at: NOW,
    host: "studio",
    session: "s1",
    account: "lyss",
    provider: "anthropic",
    model: "claude-opus-5-5",
    provenance: "transcript",
    inTok: 1_000,
    outTok: 100,
    cacheRead: 10_000,
    write5m: 0,
    write1h: 0,
    requests: 1,
    ...over,
  });

  test("a row no price table can place is not a zero-cost fact", () => {
    expect(costBucketsOf([cost({ model: "a-model-from-next-year" })])).toEqual([]);
    expect(costBucketsOf([cost()]).length).toBe(1);
    expect(costBucketsOf([cost()])[0].cost).toBeGreaterThan(0);
  });

  test("a turn row over an hour the transcripts cover is not counted twice", () => {
    const same = { at: NOW, session: "s1" };
    const once = costBucketsOf([cost({ ...same, provenance: "transcript" })])[0].cost;
    const got = costBucketsOf([
      cost({ ...same, provenance: "transcript" }),
      cost({ ...same, provenance: "turn" }),
    ]);
    /* The row count is one either way — they share a bucket — so the assertion
       that fails with the dedupe deleted is the money. */
    expect(got.length).toBe(1);
    expect(got[0].cost).toBeCloseTo(once, 12);
    const only = costBucketsOf([cost({ ...same, provenance: "turn" })]);
    expect(only.length).toBe(1, "a turn row with no transcript over its hour is kept");
  });

  test("one bucket's rows are folded, and two accounts are not", () => {
    const got = costBucketsOf([cost(), cost({ account: "tx-team" })]);
    expect(got.length).toBe(2);
    expect(got.map((b) => b.account).sort()).toEqual(["lyss", "tx-team"]);
  });
});

describe("a window that has rolled", () => {
  test("a superseded instance with a future reset is not what the window is at now", () => {
    const at = NOW - HOUR;
    const instances = instancesOf([
      sample({ at: at - HOUR, used: 88, resetsAt: NOW + 3 * HOUR }),
      sample({ at, used: 4, resetsAt: NOW + 3 * HOUR }),
    ]);
    expect(instances.length).toBe(2);
    expect(bindingOf(instances, NOW)!.last).toBe(4);
  });
});
