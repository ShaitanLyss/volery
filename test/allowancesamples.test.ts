import { describe, expect, test } from "bun:test";
import {
  allowanceResidual,
  asAllowanceSamples,
  attributedCostOf,
  bindingOf,
  cardAllowance,
  costBucketsOf,
  currentOnly,
  daySpend,
  FINE_BUCKET_MS,
  instancesOf,
  ownPoints,
  ownTotal,
  samplesOf,
  spansOf,
  type AllowanceCost,
  type AllowanceSample,
  type CostBucket,
  type WindowInstance,
} from "../src/lib/allowancesamples";
import { stripModel, weekResidual } from "../src/lib/analyticstiles";
import { mixOf } from "../src/lib/fundings";

const HOUR = 3_600_000;

/** The strip's input with its two folded halves built the way the shell does:
 *  instances once, and the week's residual once. */
function stripOf(input: {
  samples: any;
  costs: any;
  coveredFrom: number;
  now: number;
  fleet: any;
  gestures?: number;
}) {
  const instances = input.samples === null ? [] : instancesOf(input.samples);
  return stripModel({
    gestures: 0,
    ...input,
    instances,
    week: weekResidual(input.samples, instances, input.costs, input.now),
  });
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
    /* Two fleet tiles, the two money ones, the gestures and the residual. */
    expect(tiles.map((t) => t.key)).toEqual([
      "allowance",
      "today",
      "burn",
      "cards",
      "gestures",
      "unattributed",
    ]);
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

describe("the gesture tile", () => {
  test("is on the strip, and says this minute rather than a window", () => {
    const tiles = stripOf({ samples: [sample()], costs: [], coveredFrom: NOW - 8 * 24 * HOUR, now: NOW, fleet: null, gestures: 12 });
    const tile = tiles.find((t) => t.key === "gestures");
    expect(tile).toBeDefined();
    expect(tile!.value).toBe("12");
    expect(tile!.off).toBe(false);
  });

  /* Nothing yet this minute is a reading, and the tile must not say "no
     reading": the collector is running, and a person who has not clicked is
     not a wall that could not answer. */
  test("zero gestures is a real zero", () => {
    const tiles = stripOf({ samples: [sample()], costs: [], coveredFrom: NOW - 8 * 24 * HOUR, now: NOW, fleet: null, gestures: 0 });
    const tile = tiles.find((t) => t.key === "gestures")!;
    expect(tile.value).toBe("0");
    expect(tile.off).toBe(false);
    expect(tile.note).toContain("nothing yet");
  });
});

describe("what the tokens were made of", () => {
  const cost = (over: Partial<AllowanceCost> = {}): AllowanceCost => ({
    at: NOW,
    host: "studio",
    session: "s1",
    account: "lyss",
    provider: "claude",
    model: "claude-sonnet-5-5",
    provenance: "transcript",
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 1,
    ...over,
  });

  /* Sonnet 5.5 is $2 in, $10 out, cache reads at 0.05x input, writes at 1.25x.
     One million of each is 2 + 10 + 0.10 + 2.5 = $14.60, and the four classes
     are priced apart rather than as a flat count. */
  test("the four classes are priced apart, at their own rates", () => {
    const [mix] = mixOf(
      [cost({ inTok: 1_000_000, outTok: 1_000_000, cacheRead: 1_000_000, write5m: 1_000_000 })],
      NOW - 1,
      NOW + 1,
    );
    expect(mix!.input.usd).toBeCloseTo(2, 6);
    expect(mix!.output.usd).toBeCloseTo(10, 6);
    expect(mix!.cacheRead.usd).toBeCloseTo(0.1, 6);
    expect(mix!.cacheWrite.usd).toBeCloseTo(2.5, 6);
    expect(mix!.usd).toBeCloseTo(14.6, 6);
    expect(mix!.tokens).toBe(4_000_000);
  });

  /* The whole point of the reading: a cache-heavy million and an output-heavy
     million are the same count and wildly different money. */
  test("the weight is the count in input-token equivalents", () => {
    const [cache] = mixOf([cost({ cacheRead: 14_400_000, inTok: 250_000, outTok: 115_000 })], NOW - 1, NOW + 1);
    /* 0.5 + 1.15 + 1.44 = 3.09, and at $2/M that is 1.545M input equivalents. */
    expect(cache!.weight).toBeCloseTo(1_545_000, 0);
    expect(cache!.weight).toBeLessThan(cache!.tokens);
  });

  test("a row outside the day is not counted in it", () => {
    const got = mixOf([cost({ at: NOW - 2 * HOUR })], NOW - 1, NOW + 1);
    expect(got).toEqual([]);
  });

  test("a model the table cannot place is counted as unpriced, not as free", () => {
    const [mix] = mixOf([cost({ model: "no-such-model-9" })], NOW - 1, NOW + 1);
    expect(mix!.input.usd).toBe(0);
    expect(mix!.tokens).toBe(0);
    /* Nothing was in the row, so nothing is unpriced either: the row itself is
       counted through its own tokens. */
    const [withTokens] = mixOf([cost({ model: "no-such-model-9", outTok: 5_000 })], NOW - 1, NOW + 1);
    expect(withTokens!.unpriced).toBe(5_000);
    expect(withTokens!.usd).toBe(0);
  });

  test("a transcript and a turn row for one session-hour are counted once", () => {
    const rows = [
      cost({ inTok: 1_000 }),
      cost({ inTok: 9_000, provenance: "turn" }),
    ];
    const [mix] = mixOf(rows, NOW - 1, NOW + 1);
    expect(mix!.tokens).toBe(1_000);
  });

  test("two fundings are two breakdowns", () => {
    const got = mixOf([cost(), cost({ account: "api", inTok: 1_000 })], NOW - 1, NOW + 1);
    expect(got.map((m) => m.label).sort()).toEqual(["api", "lyss"]);
  });
});

describe("what one card carried of a window", () => {
  const bucket = (account: string, card: string, inTok: number, at = NOW): AllowanceCost => ({
    at,
    host: "studio",
    session: `s-${card || "none"}`,
    account,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    provenance: "transcript",
    card,
    inTok,
    outTok: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 1,
  });

  /** An instance whose movement is `used` points over ten minutes. */
  const instance = (kind: string, used: number[]): WindowInstance => ({
    account: "lyss",
    kind,
    scope: "",
    resetsAt: NOW + 3_600_000,
    from: NOW,
    to: NOW + (used.length - 1) * 10 * 60_000,
    first: used[0]!,
    last: used[used.length - 1]!,
    delta: used[used.length - 1]! - used[0]!,
    points: used.map((u, i) => ({ at: NOW + i * 10 * 60_000, used: u })),
    hosts: ["studio"],
  });

  test("a card alone in the window carries all of it", () => {
    const got = cardAllowance("a", [instance("session", [10, 20])], [bucket("lyss", "a", 1000)], NOW, NOW + HOUR);
    expect(got).toHaveLength(1);
    expect(got[0]!.points).toBeCloseTo(10, 6);
    expect(got[0]!.share).toBeCloseTo(1, 6);
  });

  /* The whole point: the split is by modeled cost, never by time. Three parts
     of the work to one, three parts of the movement to one. */
  test("two cards split the movement by what each cost", () => {
    const got = cardAllowance(
      "a",
      [instance("session", [10, 20])],
      [bucket("lyss", "a", 3000), bucket("lyss", "b", 1000)],
      NOW,
      NOW + HOUR,
    );
    expect(got[0]!.points).toBeCloseTo(7.5, 6);
    expect(got[0]!.share).toBeCloseTo(0.75, 6);
  });

  test("a card that spent nothing in the interval gets nothing of it", () => {
    const got = cardAllowance(
      "b",
      [instance("session", [10, 20])],
      [bucket("lyss", "a", 3000)],
      NOW,
      NOW + HOUR,
    );
    /* No rows for `b` at all, so there is nothing to say rather than a zero
       drawn as one. */
    expect(got).toEqual([]);
  });

  /* A window that moved with no priced fact under it is the one honest hole:
     the movement is not the card's and it is not zero either. Two intervals,
     facts under the first only. */
  test("movement no priced fact explains is counted as blind", () => {
    const got = cardAllowance(
      "a",
      [instance("session", [10, 15, 20])],
      [bucket("lyss", "a", 1000)],
      NOW,
      NOW + HOUR,
    );
    expect(got[0]!.blind).toBeCloseTo(5, 6);
    expect(got[0]!.points).toBeCloseTo(5, 6);
    expect(got[0]!.moved).toBeCloseTo(10, 6);
  });

  test("the five-hour and the weekly window are two readings", () => {
    const got = cardAllowance(
      "a",
      [instance("session", [10, 20]), instance("weekly_all", [40, 44])],
      [bucket("lyss", "a", 1000)],
      NOW,
      NOW + HOUR,
    );
    expect(got.map((r) => r.kind).sort()).toEqual(["session", "weekly_all"]);
    expect(got.find((r) => r.kind === "weekly_all")!.points).toBeCloseTo(4, 6);
  });

  test("a window that moved nothing is no share, not zero percent", () => {
    const got = cardAllowance("a", [instance("session", [10, 10])], [bucket("lyss", "a", 1000)], NOW, NOW + HOUR);
    expect(got).toEqual([]);
  });

  test("another account's window is not this card's", () => {
    const got = cardAllowance("a", [instance("session", [10, 20])], [bucket("tx-team", "a", 1000)], NOW, NOW + HOUR);
    expect(got).toEqual([]);
  });
});

describe("this wall's own share of a window", () => {
  const bucket = (card: string, inTok: number): AllowanceCost => ({
    at: NOW,
    host: "studio",
    session: `s-${card}`,
    account: "lyss",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    provenance: "transcript",
    card,
    inTok,
    outTok: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 1,
  });
  const session = (used: number[]): WindowInstance => ({
    account: "lyss",
    kind: "session",
    scope: "",
    resetsAt: NOW + 3_600_000,
    from: NOW,
    to: NOW + (used.length - 1) * 10 * 60_000,
    first: used[0]!,
    last: used[used.length - 1]!,
    delta: used[used.length - 1]! - used[0]!,
    points: used.map((u, i) => ({ at: NOW + i * 10 * 60_000, used: u })),
    hosts: ["studio"],
  });

  test("is the movement the wall's facts explain, not the whole counter", () => {
    /* Ten points moved over one interval with facts under it. */
    const [got] = ownPoints([session([10, 20])], costBucketsOf([bucket("a", 1000)]));
    expect(got).toEqual({ account: "lyss", kind: "session", points: 10, moved: 10, priced: got!.priced });
    expect(got!.priced).toBeGreaterThan(0);
  });

  /* What makes the figure a reading rather than a hole: no priced fact means
     there was nothing to divide the movement among, and a cap reading that as
     "you have spent nothing" would never fire (`accounts.ts::SelfUse`). */
  test("says what was priced, so a zero can be told from a gap", () => {
    expect(ownPoints([session([10, 20])], [])[0]!.priced).toBe(0);
    const [priced] = ownPoints([session([10, 20])], [{ at: NOW, host: "s", account: "lyss", cost: 2 }]);
    expect(priced!.priced).toBe(2);
  });

  test("only the current instance is what a cap is measured on", () => {
    /* Four five-hour windows in a day add up the way a day's percentage does,
       which is four times the scale of the reading a cap compares against. */
    const first = session([0, 10]);
    const second: WindowInstance = {
      ...session([0, 5]),
      resetsAt: first.resetsAt + 5 * 60 * 60_000,
      from: first.to + 60_000,
      to: first.to + 11 * 60_000,
      points: [
        { at: first.to + 60_000, used: 0 },
        { at: first.to + 11 * 60_000, used: 5 },
      ],
    };
    expect(currentOnly([first, second])).toEqual([second]);
    /* And `.to` is what decides it, not the order they arrive in. */
    expect(currentOnly([second, first])).toEqual([second]);
  });

  /* The whole point of the number: somebody else's usage moves the same
     counter, and it is the intervals with no facts under them. */
  test("leaves what no fact explains out of the share", () => {
    const two = session([10, 15, 20]);
    /* Facts in the first interval only: the second's delta is somebody else's. */
    const [got] = ownPoints([two], [
      { at: NOW, host: "studio", account: "lyss", cost: 0.1 },
    ]);
    expect(got!.points).toBe(5);
    expect(got!.moved).toBe(10);
  });

  test("a subscription sentinel has no window to share", () => {
    const one = { ...session([10, 20]), account: "@credits" };
    expect(ownPoints([one], [])).toEqual([]);
  });

  test("the fleet sum says when it is partial", () => {
    const mine = [{ account: "lyss", kind: "session", points: 0, moved: 40 }];
    const got = ownTotal(mine, [{ account: "lyss", kind: "session", points: 10, moved: 10 }]);
    expect(got.points).toBe(10);
    expect(got.moved).toBe(50);
    expect(got.partial).toBe(true);
  });

  test("a whole sum is not partial", () => {
    const mine = [{ account: "lyss", kind: "session", points: 12, moved: 12 }];
    expect(ownTotal(mine, []).partial).toBe(false);
  });
});
