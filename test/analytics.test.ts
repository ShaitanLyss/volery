import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTO_MAX,
  AUTO_MIN,
  BUCKETS,
  BUCKET_MS,
  DIMENSION_KEYS,
  MEASURES,
  SERIES,
  SERIES_ALL_PAIRS,
  SERIES_CEILING,
  SERIES_FOLD,
  aggregate,
  aggregateNote,
  attribute,
  autoBucket,
  bucketCount,
  bucketOf,
  coarser,
  dimensionAt,
  dimsOf,
  duration,
  fold,
  latency,
  latencyBasis,
  latencyLabel,
  matches,
  measureOf,
  measureValue,
  modeledUsd,
  money,
  normalizeView,
  pace,
  pct,
  perCard,
  percentileFromBuckets,
  quantile,
  residualOf,
  resolveView,
  series,
  seriesColor,
  spanMsOf,
  tierFor,
  tokens,
  USAGE_GRAIN,
  toolDimsOf,
  toolFold,
  toolSeries,
  toolValue,
  type Fact,
  type HourFact,
  type ResidualInput,
  type ToolFact,
  type ToolHour,
} from "../src/lib/analytics";
import { priceOf } from "../src/lib/usage";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The instant every fixture is dated from unless it says otherwise. */
const T0 = Date.UTC(2026, 7, 14, 12, 0, 0);

function fact(over: Partial<Fact> = {}): Fact {
  return {
    at: T0,
    host: "a",
    session: "s1",
    agent: "",
    parentAgent: "",
    depth: 0,
    model: "claude-opus-5-5",
    effort: "",
    cli: "",
    source: "card",
    account: "lyss",
    accountIdentity: "",
    provider: "anthropic",
    project: "volery",
    provenance: "transcript",
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 0,
    usdReported: 0,
    ...over,
  };
}

function hour(over: Partial<HourFact> = {}): HourFact {
  return {
    hour: T0,
    host: "a",
    account: "lyss",
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "",
    cli: "",
    source: "card",
    project: "volery",
    provenance: "transcript",
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 0,
    usdReported: 0,
    ...over,
  };
}

function toolFact(over: Partial<ToolFact> = {}): ToolFact {
  return {
    turnId: 1,
    at: T0,
    host: "a",
    session: "s1",
    agent: "",
    kind: "builtin",
    server: "",
    tool: "Bash",
    target: "",
    childAgent: "",
    requestedModel: "",
    calls: 1,
    errors: 0,
    msTotal: 100,
    outBytes: 0,
    turnUsd: 0.01,
    ...over,
  };
}

function toolHour(over: Partial<ToolHour> = {}): ToolHour {
  return {
    hour: T0,
    host: "a",
    account: "lyss",
    provider: "anthropic",
    project: "volery",
    kind: "mcp",
    server: "skein",
    tool: "send",
    target: "",
    calls: 10,
    errors: 0,
    receipts: 0,
    msTotal: 0,
    msUnder50: 0,
    msUnder200: 0,
    msUnder1s: 0,
    msUnder5s: 0,
    msOver5s: 0,
    outBytes: 0,
    turnUsd: 0,
    ...over,
  };
}

/* ── buckets ───────────────────────────────────────────────────────────────*/

describe("the bucket ladder", () => {
  test("every rung floors to its own start, and one millisecond before moves back a rung", () => {
    /* Sub-day rungs floor on the epoch, which is what the hourly tier stores.
       The bases here are deliberately on their own boundaries. */
    const cases: [Parameters<typeof bucketOf>[1], number][] = [
      ["1m", Date.UTC(2026, 7, 14, 12, 3, 0)],
      ["5m", Date.UTC(2026, 7, 14, 12, 10, 0)],
      ["15m", Date.UTC(2026, 7, 14, 12, 30, 0)],
      ["1h", Date.UTC(2026, 7, 14, 12, 0, 0)],
    ];
    for (const [bucket, base] of cases) {
      /* An instant inside the bucket, and the exact boundary. */
      const inside = base + Math.floor(BUCKET_MS[bucket] / 3);
      expect(bucketOf(inside, bucket)).toBe(base);
      expect(bucketOf(base, bucket)).toBe(base);
      expect(bucketOf(base - 1, bucket)).toBe(base - BUCKET_MS[bucket]);
    }
  });

  test("a day follows the local calendar, not UTC", () => {
    /* Local midnight is section 11.13's `today`, and the reason this cannot be
       `now - (now % DAY)`: that is midnight UTC. */
    const at = new Date(2026, 7, 14, 13, 27, 9, 400).getTime();
    const start = bucketOf(at, "1d");
    const d = new Date(start);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    /* The last millisecond of the previous day is the previous bucket. */
    expect(bucketOf(start - 1, "1d")).toBe(start - DAY);
  });

  test("the day boundary is local on a machine that is not UTC, in a child", () => {
    /* The in-process assertions above cannot tell local midnight from UTC
       midnight on a UTC machine, and CI runs in UTC. A child with its own TZ is
       the only pure test that makes the difference observable. */
    const module = pathToFileURL(resolve(import.meta.dir, "../src/lib/analytics.ts")).href;
    const script = [
      `import { bucketOf } from ${JSON.stringify(module)};`,
      "const at = new Date(2026, 7, 14, 13, 27).getTime();",
      'const day = new Date(bucketOf(at, "1d"));',
      "if (day.getHours() !== 0 || day.getDate() !== 14 || day.getMonth() !== 7) process.exit(1);",
      "const utcMidnight = Math.floor(at / 86400000) * 86400000;",
      'if (bucketOf(at, "1d") === utcMidnight) process.exit(2);',
      "process.exit(0);",
    ].join("\n");
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, TZ: "Australia/Sydney" },
    });
    if (run.exitCode !== 0) throw new Error(`child exited ${run.exitCode}: ${run.stderr.toString()}`);
    expect(run.exitCode).toBe(0);
  });

  test("a week starts on Monday and holds the whole local week", () => {
    /* 2026-08-14 is a Friday; its Monday is the 10th. */
    const friday = new Date(2026, 7, 14, 22, 0).getTime();
    const start = bucketOf(friday, "1w");
    const monday = new Date(start);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(10);
    expect(monday.getHours()).toBe(0);
    /* Any instant in the same week is the same bucket. */
    expect(bucketOf(new Date(2026, 7, 12, 8, 0).getTime(), "1w")).toBe(start);
    expect(bucketOf(new Date(2026, 7, 16, 23, 59).getTime(), "1w")).toBe(start);
    expect(bucketOf(new Date(2026, 7, 17, 0, 0).getTime(), "1w")).not.toBe(start);
  });

  test("auto lands inside 80-200 points whenever the ladder allows it", () => {
    const week = autoBucket(7 * DAY);
    expect(BUCKETS).toContain(week);
    expect(week).toBe("1h");
    const n = bucketCount(7 * DAY, week);
    expect(n).toBeGreaterThanOrEqual(AUTO_MIN);
    expect(n).toBeLessThanOrEqual(AUTO_MAX);
    expect(n).toBe(168);
  });

  test("auto never invents a width and never goes finer than a minute", () => {
    expect(autoBucket(2 * DAY)).toBe("15m"); // 192 points, inside the band
    expect(autoBucket(10 * DAY)).toBe("1h"); // 240, the closest rung to 200
    expect(autoBucket(365 * DAY)).toBe("1w"); // 53, the closest rung to the band
    /* A span shorter than the finest rung still gets the finest rung. */
    expect(autoBucket(10 * MINUTE)).toBe("1m");
    expect(autoBucket(0)).toBe("1m");
  });

  test("the coarser of two rungs is the one the data can answer", () => {
    expect(coarser("1m", "5m")).toBe("5m");
    expect(coarser("1h", "5m")).toBe("1h");
    expect(coarser("1w", "1w")).toBe("1w");
    /* The default subject grain is the five-minute usage_fact bucket. */
    expect(USAGE_GRAIN).toBe("5m");
  });

  test("the tier follows the ninety-day and one-year boundaries", () => {
    expect(tierFor(90 * DAY)).toBe("fine");
    expect(tierFor(90 * DAY + 1)).toBe("hourly");
    expect(tierFor(365 * DAY)).toBe("hourly");
    expect(tierFor(365 * DAY + 1)).toBe("daily");
  });

  test("a span literal parses, and a bad one does not", () => {
    expect(spanMsOf("7d")).toBe(7 * DAY);
    expect(spanMsOf("24h")).toBe(DAY);
    expect(spanMsOf("1y")).toBe(365 * DAY);
    expect(spanMsOf("2w")).toBe(14 * DAY);
    expect(spanMsOf(" 30m ")).toBe(30 * MINUTE);
    expect(spanMsOf("")).toBeNull();
    expect(spanMsOf("7")).toBeNull();
    expect(spanMsOf("7 months")).toBeNull();
    expect(spanMsOf("0d")).toBeNull();
  });

  test("a dimension exists where the tier keeps it", () => {
    expect(dimensionAt("session", "fine")).toBe(true);
    expect(dimensionAt("session", "hourly")).toBe(false);
    expect(dimensionAt("card", "daily")).toBe(false);
    expect(dimensionAt("account", "hourly")).toBe(true);
    expect(dimensionAt("model", "daily")).toBe(true);
    /* A tool split survives: tool_hour carries the tool and its server. */
    expect(dimensionAt("tool", "daily")).toBe(true);
    expect(DIMENSION_KEYS).toContain("subagent");
  });
});

/* ── filtering ─────────────────────────────────────────────────────────────*/

describe("the filter", () => {
  const dims = { host: "a", account: "lyss", session: "s1" };

  test("* means all, and an empty list means none", () => {
    expect(matches({ host: ["*"] }, dims)).toBe(true);
    expect(matches({ host: ["*", "b"] }, dims)).toBe(true);
    expect(matches({ host: [] }, dims)).toBe(false);
  });

  test("a named list matches membership and a missing dimension is unfiltered", () => {
    expect(matches({ host: ["a", "b"] }, dims)).toBe(true);
    expect(matches({ host: ["b"] }, dims)).toBe(false);
    expect(matches({}, dims)).toBe(true);
    expect(matches({ account: ["lyss"], host: ["a"] }, dims)).toBe(true);
    expect(matches({ account: ["other"], host: ["a"] }, dims)).toBe(false);
  });

  test("an absent value is the empty string, not a wildcard", () => {
    expect(matches({ subagent: [""] }, dims)).toBe(true);
    expect(matches({ subagent: ["*"] }, dims)).toBe(true);
    expect(matches({ subagent: ["agent-1"] }, dims)).toBe(false);
  });

  test("dimsOf reads the fact's own grain", () => {
    const d = dimsOf(fact({ agent: "agent-7" }));
    expect(d.host).toBe("a");
    expect(d.session).toBe("s1");
    expect(d.subagent).toBe("agent-7");
  });
});

/* ── aggregation ───────────────────────────────────────────────────────────*/

describe("aggregating", () => {
  test("a quantity carries its unit, provenance and additivity", () => {
    expect(MEASURES.tokens).toMatchObject({ unit: "tokens", provenance: "measured", additive: true });
    expect(MEASURES.usd_modeled).toMatchObject({ unit: "usd", provenance: "modeled", additive: true });
    expect(MEASURES.allowance_points).toMatchObject({ provenance: "attributed", additive: true });
    expect(MEASURES.usd_reported).toMatchObject({ provenance: "reported" });
    expect(MEASURES.cpu.additive).toBe(false);
    expect(MEASURES.ms_p95).toMatchObject({ unit: "ms", additive: false, percentile: true });
    /* These three are not folded from rows: one is a ratio recomputed from its
       parts, two are span-level derived measures. A `within` would be a lie a
       generic folder would act on. */
    expect(MEASURES.error_rate.within).toBeUndefined();
    expect(MEASURES.pace.within).toBeUndefined();
    expect(MEASURES.per_card.within).toBeUndefined();
  });

  test("a sum over facts equals a sum over hours for the same window", () => {
    /* The hourly tier is a stored rollup of the fine one, so the two must agree
       about a total even though they disagree about their grain. */
    const facts = [
      fact({ at: T0, inTok: 100, outTok: 10, requests: 1, usdReported: 0.5 }),
      fact({ at: T0 + 6 * MINUTE, inTok: 250, outTok: 30, requests: 2, usdReported: 1.5 }),
    ];
    const hours = [hour({ hour: T0, inTok: 350, outTok: 40, requests: 3, usdReported: 2 })];

    expect(fold(facts, "tokens").value).toBe(390);
    expect(fold(hours, "tokens").value).toBe(390);
    expect(fold(facts, "requests").value).toBe(3);
    expect(fold(hours, "requests").value).toBe(3);
    expect(fold(facts, "usd_reported").value).toBeCloseTo(2, 10);
    expect(fold(hours, "usd_reported").value).toBeCloseTo(2, 10);

    const byFact = series(facts, "tokens", "1h");
    const byHour = series(hours, "tokens", "1h");
    expect(byFact.points).toEqual(byHour.points);
    expect(aggregate(byFact.points, "sum")).toBe(390);
  });

  test("usd_modeled prices the five token kinds through the rate in force", () => {
    const row = fact({ inTok: 1e6, outTok: 1e6, cacheRead: 1e6, write5m: 1e6, write1h: 1e6 });
    /* Opus 5.5: $4 in, $20 out, cache read at 0.05x, writes at 1.25x and 2x. */
    expect(modeledUsd(row)).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 10);
    expect(measureValue(row, "tokens_cache_write")).toBe(2e6);
  });

  test("a provider fact is unpriced, not free", () => {
    const row = fact({ account: "@deepseek", inTok: 1e6, outTok: 1e6 });
    expect(modeledUsd(row)).toBeNull();
    const folded = fold([row], "usd_modeled");
    expect(folded.value).toBeNull();
    expect(folded.unpriced).toBe(1);
    expect(folded.counted).toBe(0);
    /* The series omits the bucket rather than drawing it at zero, and says how
       many rows it could not price. */
    const s = series([row], "usd_modeled", "1h");
    expect(s.points).toEqual([]);
    expect(s.unpriced).toBe(1);
    /* usd_reported is still the figure that wins for that card. */
    expect(fold([{ ...row, usdReported: 3 }], "usd_reported").value).toBe(3);
  });

  test("the hour row carries no session or subagent, and dimsOf says so", () => {
    /* The hourly tier drops the fine dimensions; a face reading `session` off
       an hour row would otherwise filter every row out silently. */
    const d = dimsOf(hour({}));
    expect(d.session).toBeUndefined();
    expect(d.subagent).toBeUndefined();
    expect(d.account).toBe("lyss");
  });

  test("the cache and write multipliers agree with usage.ts's priceOf", () => {
    /* `priceOf` takes the two cache-write TTLs as one, so this compares a row
       with only a 5m write, where both compute the same thing. Sonnet 5 has no
       cache-read override, so the standard 0.1x is the multiplier exercised. */
    const row = fact({
      model: "claude-sonnet-5",
      inTok: 1e6,
      outTok: 1e6,
      cacheRead: 1e6,
      write5m: 1e6,
      write1h: 0,
    });
    const viaPriceOf = priceOf(
      row.model,
      { in: row.inTok, out: row.outTok, cacheRead: row.cacheRead, cacheWrite: row.write5m },
      row.at,
    );
    expect(viaPriceOf).not.toBeNull();
    expect(modeledUsd(row)).toBeCloseTo(viaPriceOf!, 10);
  });

  test("a rate history can price the write TTLs apart from today's constants", () => {
    const row = fact({ inTok: 1e6, outTok: 1e6, write5m: 1e6, write1h: 1e6 });
    /* A resolver standing in for the stored `rate` table. The writes cost
       nothing here, which the copied constants would not allow. */
    const historical = modeledUsd(row, () => ({ input: 4, output: 20, write5m: 0, write1h: 0 }));
    expect(historical).toBeCloseTo(24, 10);
  });

  test("a model the table has never seen is unpriced", () => {
    expect(modeledUsd(fact({ model: "not-a-model" }))).toBeNull();
  });

  test("a bucket with no rows is a gap, not a zero", () => {
    const rows = [fact({ at: T0 }), fact({ at: T0 + 3 * HOUR, inTok: 10 })];
    const s = series(rows, "tokens", "1h");
    expect(s.points.map((p) => p.at)).toEqual([T0, T0 + 3 * HOUR]);
    expect(s.points).toHaveLength(2);
  });

  test("the aggregates each mean what they say", () => {
    const points = [
      { at: 1, value: 2 },
      { at: 2, value: 4 },
    ];
    expect(aggregate(points, "sum")).toBe(6);
    expect(aggregate(points, "mean")).toBe(3);
    expect(aggregate(points, "max")).toBe(4);
    expect(aggregate(points, "last")).toBe(4);
    expect(aggregate(points, "count")).toBe(2);
    expect(aggregate(points, "p50")).toBe(3);
    expect(aggregate(points, "p95")).toBeCloseTo(3.9, 10);
    /* A sum of nothing is zero; every other aggregate of nothing is null. */
    expect(aggregate([], "sum")).toBe(0);
    expect(aggregate([], "mean")).toBeNull();
    expect(aggregate([], "max")).toBeNull();
    expect(aggregate([], "last")).toBeNull();
    expect(aggregate([], "count")).toBe(0);
    expect(aggregate([], "p95")).toBeNull();
  });

  test("a percentile of buckets says what it is a percentile of", () => {
    expect(aggregateNote("p95", "1h")).toBe("p95 of 1h totals, not of the requests inside them");
    expect(aggregateNote("p50", "1d")).toContain("1d totals");
    expect(aggregateNote("sum", "1h")).toBeNull();
    expect(aggregateNote("max", "1w")).toBeNull();
  });

  test("a quantile interpolates between the nearest ranks", () => {
    expect(quantile([40, 10, 30, 20], 0.5)).toBe(25);
    expect(quantile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 10);
    expect(quantile([7], 0.95)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });

  test("per_card and pace refuse a divisor of zero", () => {
    expect(perCard(10, 4)).toBe(2.5);
    expect(perCard(10, 0)).toBeNull();
    expect(pace(5, 10)).toBe(0.5);
    expect(pace(5, 0)).toBeNull();
  });
});

/* ── the tool half ─────────────────────────────────────────────────────────*/

describe("tool measures", () => {
  test("counts and sizes sum, and a skill counts its own calls", () => {
    const rows = [
      toolFact({ calls: 2, errors: 0, outBytes: 100 }),
      toolFact({ calls: 3, errors: 1, outBytes: 50 }),
      toolFact({ kind: "skill", tool: "Skill", target: "coordinate", calls: 4 }),
    ];
    expect(toolFold(rows, "calls").value).toBe(9);
    expect(toolFold(rows, "errors").value).toBe(1);
    expect(toolFold(rows, "out_bytes").value).toBe(150);
    /* Two ordinary calls' worth of skill rows, plus the one that is a skill. */
    expect(toolFold(rows, "skill_calls").value).toBe(4);
    expect(toolValue(rows[1], "skill_calls")).toBe(0);
  });

  test("skill_cost is the turn's bill apportioned to the skill calls", () => {
    /* Section 3.7: each row carries its share of the turn, so a sum over skill
       rows is what those calls cost rather than a copy of every turn's bill. */
    const rows = [
      toolFact({ kind: "skill", target: "coordinate", turnUsd: 0.5 }),
      toolFact({ kind: "skill", target: "coordinate", turnUsd: 0.25 }),
      toolFact({ kind: "builtin", turnUsd: 9 }),
    ];
    expect(toolFold(rows, "skill_cost").value).toBeCloseTo(0.75, 10);
    expect(MEASURES.skill_cost).toMatchObject({ unit: "usd", provenance: "attributed", additive: true });
  });

  test("error_rate is total errors over total calls, not a sum of rates", () => {
    const rows = [toolHour({ calls: 10, errors: 3 }), toolHour({ calls: 2, errors: 0 })];
    expect(toolFold(rows, "error_rate").value).toBeCloseTo(0.25, 10);
    expect(toolSeries(rows, "calls", "1h").points).toEqual([{ at: T0, value: 12 }]);
    expect(toolFold([toolHour({ calls: 0, errors: 0 })], "error_rate").value).toBeNull();
  });

  test("the fine tool row carries no account, provider or project; the hour row does", () => {
    /* `bun run check` caught exactly this: tool_fact has no project column, so
       the fine row resolves it through analytics_session and must not claim to
       carry one. */
    const fine = toolDimsOf(toolFact({ agent: "agent-2" }));
    expect(fine.tool).toBe("Bash");
    expect(fine.account).toBeUndefined();
    expect(fine.project).toBeUndefined();
    expect(fine.subagent).toBe("agent-2");

    const coarse = toolDimsOf(toolHour({ project: "volery", account: "lyss" }));
    expect(coarse.project).toBe("volery");
    expect(coarse.account).toBe("lyss");

    /* A skill's name is the row's target, not its tool. */
    expect(toolDimsOf(toolFact({ kind: "skill", tool: "Skill", target: "coordinate" })).skill).toBe("coordinate");
    expect(toolDimsOf(toolFact({ kind: "builtin" })).skill).toBeUndefined();
  });

  test("a tool bucket with no row is a gap", () => {
    const rows = [toolFact({ at: T0 }), toolFact({ at: T0 + 2 * HOUR })];
    expect(toolSeries(rows, "calls", "1h").points.map((p) => p.at)).toEqual([T0, T0 + 2 * HOUR]);

    /* A measure from the other family has no value on a tool row, and the
       series says how many it could not read rather than drawing zeros. */
    const other = toolSeries([toolFact({}), toolFact({})], "tokens", "1h");
    expect(other.points).toEqual([]);
    expect(other.unpriced).toBe(2);
  });
});

/* ── percentiles from buckets ──────────────────────────────────────────────*/

describe("a percentile the finer tier cannot give", () => {
  test("bands give an estimate, and the open band says at least", () => {
    expect(percentileFromBuckets({ under50: 50, under200: 50, under1s: 0, under5s: 0, over5s: 0 }, 0.25)).toEqual({
      ms: 25,
      atLeast: false,
    });
    /* target 47.5 of 50 lands three quarters into the open band. */
    expect(percentileFromBuckets({ under50: 10, under200: 10, under1s: 10, under5s: 10, over5s: 10 }, 0.95)).toEqual({
      ms: 5000,
      atLeast: true,
    });
    expect(percentileFromBuckets({ under50: 0, under200: 0, under1s: 0, under5s: 0, over5s: 0 }, 0.5)).toBeNull();
  });

  test("hourly rows are labelled an estimate and fine rows are labelled rows", () => {
    const fromHours = latency([toolHour({ calls: 10, msUnder50: 5, msUnder200: 5 })], 0.95);
    expect(fromHours).not.toBeNull();
    expect(fromHours!.basis).toBe("buckets");
    expect(fromHours!.exact).toBe(false);
    expect(latencyLabel(fromHours!, 0.95)).toContain("estimated");
    expect(latencyLabel(fromHours!, 0.95)).toContain("hourly buckets");

    const fromRows = latency(
      [toolFact({ msTotal: 20 }), toolFact({ msTotal: 120 }), toolFact({ msTotal: 130 }), toolFact({ msTotal: 500 })],
      0.95,
    );
    expect(fromRows!.basis).toBe("rows");
    expect(fromRows!.exact).toBe(true);
    expect(fromRows!.ms).toBeCloseTo(444.5, 10);
    expect(latencyLabel(fromRows!, 0.95)).toContain("tool rows");
  });

  test("the tier names itself when the span is past the latency buckets", () => {
    expect(latencyBasis("fine", 30 * DAY)).toMatchObject({ ok: true, basis: "rows", exact: true });
    expect(latencyBasis("hourly", 200 * DAY)).toMatchObject({ ok: true, basis: "buckets", exact: false });
    const refused = latencyBasis("daily", 4 * 365 * DAY);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("percentile");
      expect(refused.error.tier).toBe("daily");
      expect(refused.error.detail).toContain("three-year");
    }
  });
});

/* ── the residual ──────────────────────────────────────────────────────────*/

describe("the residual", () => {
  test("full: every sampled host has facts and the shares sum to the delta", () => {
    const r = residualOf({
      account: "lyss",
      sampled: ["a", "b"],
      spans: [
        {
          delta: 42,
          facts: [
            { account: "lyss", host: "a", cost: 10 },
            { account: "lyss", host: "b", cost: 30 },
          ],
        },
      ],
    });
    expect(r.attributed).toBe(42);
    expect(r.residual).toBe(0);
    expect(r.coverage).toBe("full");
    expect(r.missing).toEqual([]);
    expect(r.excluded).toBe(false);
  });

  test("partial: a fact-less interval is the missing share, and no known card is scaled up", () => {
    /* The busy interval's delta goes to the facts that overlap it, exactly. The
       quiet interval's delta stays residual rather than being divided among the
       busy interval's facts, which is section 5.2's whole point. */
    const r = residualOf({
      account: "lyss",
      sampled: ["a", "b"],
      spans: [
        { delta: 30, facts: [{ account: "lyss", host: "a", cost: 10 }] },
        { delta: 12, facts: [] },
      ],
    });
    expect(r.delta).toBe(42);
    expect(r.attributed).toBe(30);
    expect(r.residual).toBe(12);
    expect(r.coverage).toBe("partial");
    expect(r.missing).toEqual(["b"]);
  });

  test("a provider sentinel is outside the subscription denominator", () => {
    const withProvider = residualOf({
      account: "lyss",
      sampled: ["a"],
      spans: [
        {
          delta: 10,
          facts: [
            { account: "lyss", host: "a", cost: 10 },
            { account: "@deepseek", host: "a", cost: 90 },
          ],
        },
      ],
    });
    /* Were the provider's dollars in the denominator, lyss's facts would take a
       tenth of the delta. They take all of it, because the 90 never touched the
       subscription. */
    expect(withProvider.attributed).toBe(10);
    expect(withProvider.residual).toBe(0);

    /* A subscription delta with no subscription facts is wholly residual. */
    const onlyProvider = residualOf({
      account: "lyss",
      sampled: ["a"],
      spans: [{ delta: 10, facts: [{ account: "@credits", host: "a", cost: 90 }] }],
    });
    expect(onlyProvider.attributed).toBe(0);
    expect(onlyProvider.residual).toBe(10);
    expect(onlyProvider.coverage).toBe("partial");

    /* And a provider's own window has no subscription residual at all. */
    const sentinel = residualOf({ account: "@deepseek", sampled: ["a"], spans: [{ delta: 99, facts: [] }] });
    expect(sentinel.excluded).toBe(true);
    expect(sentinel.delta).toBe(0);
    expect(sentinel.residual).toBe(0);
  });

  test("nothing attributed: the whole delta is residual, never zero", () => {
    const r = residualOf({ account: "lyss", sampled: [], spans: [{ delta: 42, facts: [] }] });
    expect(r.attributed).toBe(0);
    expect(r.residual).toBe(42);
    expect(r.coverage).toBe("full");
  });

  test("another account's facts and unknown facts stay out of the denominator", () => {
    const r = residualOf({
      account: "lyss",
      sampled: ["a"],
      spans: [
        {
          delta: 20,
          facts: [
            { account: "tx-team", host: "a", cost: 900 },
            { account: "unknown", host: "a", cost: 900 },
          ],
        },
      ],
    });
    expect(r.attributed).toBe(0);
    expect(r.residual).toBe(20);
    expect(r.coverage).toBe("partial");
  });

  test("a zero-cost fact is not coverage: the host still has no share to give", () => {
    /* The denominator and the coverage label use one predicate, or a host whose
       only fact priced at nothing would be reported as accounted for while its
       delta sat in the residual. */
    const r = residualOf({
      account: "lyss",
      sampled: ["a"],
      spans: [{ delta: 5, facts: [{ account: "lyss", host: "a", cost: 0 }] }],
    });
    expect(r.attributed).toBe(0);
    expect(r.residual).toBe(5);
    expect(r.coverage).toBe("partial");
    expect(r.missing).toEqual(["a"]);
  });

  test("a caller that cannot supply the sample list is partial, not full", () => {
    /* The type requires the list, but a JavaScript caller can still omit it.
       Claiming full coverage would be the one thing section 15 forbids, and an
       absent list is the reading not knowing, not the reading being complete. */
    const r = residualOf({ account: "lyss", spans: [{ delta: 5, facts: [] }] } as unknown as ResidualInput);
    expect(r.coverage).toBe("partial");
    expect(r.missing).toEqual([]);
  });

  test("attribute divides one interval among its own account's facts", () => {
    const a = attribute(
      42,
      [
        { account: "lyss", host: "a", cost: 1 },
        { account: "lyss", host: "b", cost: 2 },
        { account: "other", host: "a", cost: 100 },
      ],
      "lyss",
    );
    expect(a.residual).toBe(0);
    expect(a.points.map((p) => p.points)).toEqual([14, 28]);
  });
});

/* ── the view spec ─────────────────────────────────────────────────────────*/

describe("the view spec", () => {
  test("unknown keys are dropped and renamed knobs degrade to what they became", () => {
    const spec = normalizeView({
      v: 1,
      name: "  weekly allowance  ",
      span: "7d",
      bucket: "1h",
      filter: { host: ["*"], nonsense: ["x"] },
      panels: [
        {
          form: "stacked",
          measure: "cost",
          split: "agent",
          filter: { account: ["lyss"], wat: ["nope"] },
          stack: false,
          annotate: ["residual", "wat"],
        },
      ],
      extra: 1,
    });

    expect(spec.name).toBe("weekly allowance");
    expect(spec.span).toBe("7d");
    expect(spec.bucket).toBe("1h");
    expect(spec.filter).toEqual({ host: ["*"] });
    expect("nonsense" in spec.filter).toBe(false);
    expect("extra" in spec).toBe(false);
    expect(spec.panels).toHaveLength(1);
    expect(spec.panels[0]).toMatchObject({
      form: "area",
      measure: "usd_modeled",
      split: "subagent",
      stack: true,
      annotate: ["residual"],
    });
    expect(spec.panels[0].filter).toEqual({ account: ["lyss"] });
  });

  test("a config that would not parse becomes the default, not a throw", () => {
    for (const raw of [null, undefined, 7, "weekly", [], { panels: "nope" }]) {
      const spec = normalizeView(raw);
      expect(spec.v).toBe(1);
      expect(spec.span).toBe("7d");
      expect(spec.bucket).toBe("auto");
      expect(spec.panels).toHaveLength(1);
      expect(spec.panels[0].measure).toBe("usd_modeled");
    }
  });

  test("a retired form, an unknown bucket and a bad span each degrade", () => {
    const spec = normalizeView({
      span: "soon",
      bucket: "7m",
      panels: [{ form: "lava-lamp", measure: "not-a-measure", split: "nonsense" }],
    });
    expect(spec.span).toBe("7d");
    expect(spec.bucket).toBe("auto");
    expect(spec.panels[0].form).toBe("area");
    expect(spec.panels[0].measure).toBe("usd_modeled");
    expect(spec.panels[0].split).toBeNull();
  });

  test("an empty filter list survives, because none is a real answer", () => {
    const spec = normalizeView({ filter: { host: [], account: "lyss", model: [1, "opus"] } });
    expect(spec.filter.host).toEqual([]);
    expect("account" in spec.filter).toBe(false);
    expect(spec.filter.model).toEqual(["opus"]);
  });

  test("a non-empty list of non-strings is malformed, not a filter of none", () => {
    /* None is a real answer and is kept when the source list really was empty.
       A list of numbers narrowing the view to nothing would draw an empty
       chart that looks deliberate. */
    const spec = normalizeView({ filter: { host: [1, 2], account: [], model: ["opus", 3] } });
    expect("host" in spec.filter).toBe(false);
    expect(spec.filter.account).toEqual([]);
    expect(spec.filter.model).toEqual(["opus"]);
  });

  test("a prototype name is not a measure", () => {
    expect(measureOf("toString")).toBeNull();
    expect(measureOf("constructor")).toBeNull();
    expect(normalizeView({ panels: [{ measure: "toString" }] }).panels[0].measure).toBe("usd_modeled");
  });

  test("a name is capped, and no NaN reaches a panel", () => {
    const spec = normalizeView({ name: "x".repeat(500), panels: [{}] });
    expect(spec.name).toHaveLength(120);
    for (const panel of spec.panels) {
      expect(panel.stack).toBe(false);
      expect(panel.annotate).toEqual([]);
    }
  });

  test("resolve chooses the tier and the rung, and refuses what the tier cannot answer", () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0);

    const week = resolveView(normalizeView({ span: "7d", panels: [{ split: "account" }] }), now);
    expect(week.ok).toBe(true);
    if (week.ok) {
      expect(week.view.tier).toBe("fine");
      expect(week.view.bucket).toBe("1h");
      expect(week.view.grain).toBe("5m");
      expect(week.view.points).toBe(168);
      expect(week.view.to).toBe(now);
      expect(week.view.from).toBe(now - 7 * DAY);
    }

    /* A session split over 200 days is an hourly-tier question. */
    const tooFine = resolveView(normalizeView({ span: "200d", panels: [{ split: "session" }] }), now);
    expect(tooFine.ok).toBe(false);
    if (!tooFine.ok) {
      expect(tooFine.error.code).toBe("dimension");
      expect(tooFine.error.tier).toBe("hourly");
      expect(tooFine.error.dimension).toBe("session");
    }

    /* A minute bucket over the same span asks the hourly rollup for a
       resolution it does not keep. */
    const tooNarrow = resolveView(normalizeView({ span: "200d", bucket: "1m" }), now);
    expect(tooNarrow.ok).toBe(false);
    if (!tooNarrow.ok) {
      expect(tooNarrow.error.code).toBe("bucket");
      expect(tooNarrow.error.tier).toBe("hourly");
    }

    /* A percentile past the three-year buckets is refused, naming the tier. */
    const tooOld = resolveView(normalizeView({ span: "5y", panels: [{ measure: "ms_p95" }] }), now);
    expect(tooOld.ok).toBe(false);
    if (!tooOld.ok) {
      expect(tooOld.error.code).toBe("percentile");
      expect(tooOld.error.tier).toBe("daily");
    }
  });

  test("a one-minute bucket over five-minute facts is refused, and auto clamps", () => {
    const now = Date.UTC(2026, 7, 14, 12, 0, 0);

    /* usage_fact is written once per five minutes (section 3.1). A 1m axis
       would put four empty minutes between every point and claim a resolution
       the data does not have, which section 5.1 forbids inventing. */
    const short = resolveView(normalizeView({ span: "1h" }), now);
    expect(short.ok).toBe(true);
    if (short.ok) {
      expect(short.view.bucket).toBe("5m");
      expect(short.view.grain).toBe("5m");
      expect(short.view.points).toBe(12);
    }

    const explicit = resolveView(normalizeView({ span: "1h", bucket: "1m" }), now);
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) {
      expect(explicit.error.code).toBe("bucket");
      expect(explicit.error.tier).toBe("fine");
      expect(explicit.error.detail).toContain("5m");
    }

    /* A caller reading per-turn tool rows or the live ring has 1m data and
       says so. */
    const finer = resolveView(normalizeView({ span: "1h", bucket: "1m" }), now, "1m");
    expect(finer.ok).toBe(true);
    if (finer.ok) expect(finer.view.bucket).toBe("1m");
  });
});

/* ── saying it ─────────────────────────────────────────────────────────────*/

describe("saying it", () => {
  test("money compares before it rounds, so 999,999 is not $1000k", () => {
    expect(money(999_999)).toBe("$1.0M");
    expect(money(999_999)).not.toBe("$1000k");
    expect(money(1000.5)).toBe("$1.0k");
    expect(money(0.5)).toBe("$0.50");
    expect(money(0)).toBe("$0");
  });

  test("a percentage is floored and never reads 100 with room left", () => {
    expect(pct(99.6)).toBe("99%");
    expect(pct(99.999)).toBe("99%");
    expect(pct(100)).toBe("100%");
    expect(pct(0.4)).toBe("0%");
    expect(pct(-1)).toBe("0%");
  });

  test("a token count carries its unit", () => {
    expect(tokens(1_234_567)).toBe("1.2M tokens");
    expect(tokens(3400)).toBe("3.4k tokens");
    expect(tokens(1)).toBe("1 token");
    expect(tokens(0)).toBe("0 tokens");
  });

  test("a duration uses the unit that keeps it short", () => {
    expect(duration(0)).toBe("under a minute");
    expect(duration(20_000)).toBe("under a minute");
    expect(duration(30_000)).toBe("1m");
    expect(duration(2 * HOUR + 30 * MINUTE)).toBe("2h 30m");
    expect(duration(3 * HOUR)).toBe("3h");
    expect(duration(10 * DAY)).toBe("1w 3d");
    expect(duration(400 * DAY)).toBe("1y 35d");
  });
});

/* ── the palette ───────────────────────────────────────────────────────────*/

describe("the palette", () => {
  test("the categorical order is the five measured slots, and the sixth folds", () => {
    /* Section 10.1, in order: blue, magenta, yellow, aqua, violet. The comment
       there says the validator's own output is five slots and violet is the
       ceiling; anything past it is the fold, not a sixth measured hue. */
    expect(SERIES.map((s) => s.hex)).toEqual(["#3987e5", "#d55181", "#c98500", "#199e70", "#9085e9"]);
    expect(SERIES.map((s) => s.hue)).toEqual(["blue", "magenta", "yellow", "aqua", "violet"]);
    expect(SERIES_CEILING).toBe(5);
    expect(SERIES_ALL_PAIRS).toBe(3);
    expect(seriesColor(0)).toBe("#3987e5");
    expect(seriesColor(4)).toBe("#9085e9");
    /* Never cycled: a filter that changes the series count does not repaint the
       survivors. */
    expect(seriesColor(5)).toBe(SERIES_FOLD);
    expect(seriesColor(50)).toBe(SERIES_FOLD);
  });
});
