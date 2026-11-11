/* Analytics: the query layer.
 *
 * `docs/ANALYTICS.md` section 9 is the design; this is the half a face reads.
 * Pure: no runes, no Tauri, no DOM, so every argument below is tested directly
 * in `test/analytics.test.ts`. The subjects (usage_fact, tool_fact, the hourly
 * rollups) are plain rows; this file decides what they mean, which rung of the
 * fixed bucket ladder answers a span, and when a question cannot be answered at
 * all.
 *
 * Three rules the rest of the file is built on:
 *
 *  - **A gap is not a zero.** A bucket with no row is omitted from a series, not
 *    drawn at the baseline. The same rule section 9.6 states for the machine
 *    join, where a laptop asleep must not read as a laptop that was idle.
 *  - **A bucket width is chosen from the ladder, never invented.** Two panels
 *    side by side may then disagree about the rung, but never by a few minutes,
 *    which is what makes them comparable at a glance.
 *  - **An unanswerable question is refused with the tier named.** Degrading a
 *    session split to a host split would be a different question wearing the same
 *    numerals.
 *
 * The view spec is data (`analytics_view.config_json`, a widget's config, a
 * report), so `normalizeView` is the other half of the opaque-column bargain the
 * widgets strike: an unknown key is dropped, a renamed knob degrades, and no NaN
 * reaches a frame.
 *
 * Three row families, and each has the arithmetic it actually supports:
 * usage rows fold through `fold`/`series`, tool rows through
 * `toolFold`/`toolSeries` with `latency` for a percentile, and the allowance
 * measures come from `attribute`/`residualOf` rather than from a column. A
 * measure asked of the wrong family reads as empty rather than as a wrong zero.
 */

import { HOUR, MINUTE, count, money, rateAt, type Rate } from "./usage";
import { pct } from "./limits";

export { money, pct };

/* ── the vocabulary ────────────────────────────────────────────────────────*/

/** What a dimension may be split or filtered by (section 9.1). */
export type Dimension =
  | "host"
  | "account"
  | "provider"
  | "model"
  | "cli"
  | "effort"
  | "project"
  | "source"
  | "session"
  | "card"
  | "branch"
  | "tool"
  | "server"
  | "skill"
  | "subagent";

/** How a measure is aggregated *across* the buckets of a series. */
export type Aggregate = "sum" | "mean" | "p50" | "p95" | "max" | "last" | "count";

/** How the rows *inside* one bucket fold before the bucket is one point.
 *  Absent for a percentile measure, which `latency` answers from a histogram,
 *  for a span-level derived measure (`pace`, `per_card`) that has no row fold,
 *  and for a ratio that must be recomputed from its parts (`error_rate`, which
 *  `toolFold` does as total errors over total calls). */
export type Within = "sum" | "mean" | "max" | "last";

export type Unit = "tokens" | "usd" | "points" | "count" | "percent" | "ratio" | "bytes" | "bytes/s" | "ms";

export type Provenance = "measured" | "modeled" | "attributed" | "reported";

export type MeasureKey =
  | "tokens"
  | "tokens_in"
  | "tokens_out"
  | "tokens_cache_read"
  | "tokens_cache_write"
  | "usd_modeled"
  | "usd_reported"
  | "requests"
  | "allowance_points"
  | "residual_points"
  | "cpu"
  | "gpu"
  | "mem"
  | "disk"
  | "net"
  | "cards_working"
  | "worktrees"
  | "turns"
  | "ended_ok"
  | "ended_failed"
  | "calls"
  | "errors"
  | "error_rate"
  | "ms_p50"
  | "ms_p95"
  | "out_bytes"
  | "swaps"
  | "spawns"
  | "fan_out"
  | "skill_calls"
  | "skill_cost"
  | "pace"
  | "per_card";

export type MeasureSpec = {
  key: MeasureKey;
  unit: Unit;
  provenance: Provenance;
  /** Whether values may be added across buckets. A mean, a max and a ratio may not. */
  additive: boolean;
  /** How rows inside one bucket combine. Absent for a percentile measure, which
   *  is answered by `latency` from a histogram rather than folded, and for the
   *  measures noted on `Within`. */
  within?: Within;
  /** A latency percentile: exact over fine tool rows, estimated from the hourly
   *  buckets, and subject to the three-year bucket retention. */
  percentile?: boolean;
};

/* Units and provenance are the whole point of the table: a face that prints a
 * number without them is guessing at what it is looking at. `allowance_points`
 * is *attributed* rather than measured because the account's total is exact and
 * its distribution is an estimate (section 5.2), and `usd_modeled` is *modeled*
 * because a rate table produced it from tokens. */
const MEASURE_LIST: MeasureSpec[] = [
  { key: "tokens", unit: "tokens", provenance: "measured", additive: true, within: "sum" },
  { key: "tokens_in", unit: "tokens", provenance: "measured", additive: true, within: "sum" },
  { key: "tokens_out", unit: "tokens", provenance: "measured", additive: true, within: "sum" },
  { key: "tokens_cache_read", unit: "tokens", provenance: "measured", additive: true, within: "sum" },
  { key: "tokens_cache_write", unit: "tokens", provenance: "measured", additive: true, within: "sum" },
  { key: "usd_modeled", unit: "usd", provenance: "modeled", additive: true, within: "sum" },
  { key: "usd_reported", unit: "usd", provenance: "reported", additive: true, within: "sum" },
  { key: "requests", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "allowance_points", unit: "points", provenance: "attributed", additive: true, within: "sum" },
  { key: "residual_points", unit: "points", provenance: "attributed", additive: true, within: "sum" },
  { key: "cpu", unit: "percent", provenance: "measured", additive: false, within: "mean" },
  { key: "gpu", unit: "percent", provenance: "measured", additive: false, within: "mean" },
  { key: "mem", unit: "bytes", provenance: "measured", additive: false, within: "mean" },
  { key: "disk", unit: "bytes/s", provenance: "measured", additive: false, within: "mean" },
  { key: "net", unit: "bytes/s", provenance: "measured", additive: false, within: "mean" },
  { key: "cards_working", unit: "count", provenance: "measured", additive: false, within: "max" },
  { key: "worktrees", unit: "count", provenance: "measured", additive: false, within: "max" },
  { key: "turns", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "ended_ok", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "ended_failed", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "calls", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "errors", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "error_rate", unit: "ratio", provenance: "measured", additive: false },
  { key: "ms_p50", unit: "ms", provenance: "measured", additive: false, percentile: true },
  { key: "ms_p95", unit: "ms", provenance: "measured", additive: false, percentile: true },
  { key: "out_bytes", unit: "bytes", provenance: "measured", additive: true, within: "sum" },
  { key: "swaps", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "spawns", unit: "count", provenance: "measured", additive: true, within: "sum" },
  { key: "fan_out", unit: "count", provenance: "measured", additive: false, within: "max" },
  { key: "skill_calls", unit: "count", provenance: "measured", additive: true, within: "sum" },
  /* The turn's cost apportioned across its calls (section 3.7), so a sum over
     skill rows is the share of the bill those calls carried. Attributed rather
     than modeled: it is a division of a measured number. */
  { key: "skill_cost", unit: "usd", provenance: "attributed", additive: true, within: "sum" },
  { key: "pace", unit: "ratio", provenance: "modeled", additive: false },
  { key: "per_card", unit: "usd", provenance: "modeled", additive: false },
];

/* A null-prototype map, so `MEASURES["toString"]` is undefined rather than
 * `Object.prototype.toString`. The table is a lookup, not an object with
 * behaviour, and `measureOf` promises `null` for a name it does not know. */
export const MEASURES: Record<MeasureKey, MeasureSpec> = (() => {
  const map = Object.create(null) as Record<MeasureKey, MeasureSpec>;
  for (const m of MEASURE_LIST) map[m.key] = m;
  return map;
})();

export const MEASURE_KEYS = MEASURE_LIST.map((m) => m.key);

export function measureOf(key: string): MeasureSpec | null {
  return Object.hasOwn(MEASURES, key) ? MEASURES[key as MeasureKey] : null;
}

/* ── the rows ──────────────────────────────────────────────────────────────*/

/** One `usage_fact` row: the five-minute grain of section 3.1, as it is built
 *  in section 17. `source` is who ran it (card, terminal, unknown) and
 *  `provenance` is where the row came from (transcript, turn). They sound alike
 *  and are in the key for different reasons. */
export type Fact = {
  at: number;
  host: string;
  session: string;
  agent: string;
  parentAgent: string;
  depth: number;
  model: string;
  effort: string;
  cli: string;
  source: string;
  account: string;
  accountIdentity: string;
  provider: string;
  project: string;
  provenance: "transcript" | "turn";
  inTok: number;
  outTok: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  requests: number;
  usdReported: number;
};

/** One `usage_hour` row. The hourly tier keeps the dimensions that survive
 *  three years and drops session, agent and card, which is why a card-level
 *  question over a year is refused rather than answered from here. */
export type HourFact = {
  hour: number;
  host: string;
  account: string;
  provider: string;
  model: string;
  effort: string;
  cli: string;
  source: string;
  project: string;
  provenance: "transcript" | "turn";
  inTok: number;
  outTok: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  requests: number;
  usdReported: number;
};

export type UsageRow = Fact | HourFact;

export function atOf(row: UsageRow): number {
  return "hour" in row ? row.hour : row.at;
}

export type ToolKind = "builtin" | "mcp" | "skill" | "agent";

/** One `tool_fact` row (section 3.7). The grain is the turn, and the payload is
 *  reduced to counts and sizes: `outBytes` is a measurement of a result, never
 *  the result. */
export type ToolFact = {
  turnId: number;
  at: number;
  host: string;
  session: string;
  agent: string;
  kind: ToolKind;
  server: string;
  tool: string;
  target: string;
  childAgent: string;
  requestedModel: string;
  calls: number;
  errors: number;
  msTotal: number;
  outBytes: number;
  turnUsd: number;
};

/** One `tool_hour` row. The latency bands are exclusive and exhaustive, the way
 *  the prompt word buckets are: under 50ms, 50-200ms, 200ms-1s, 1-5s, over 5s.
 *  A sum over calls is what lets months answer a percentile at all. */
export type ToolHour = {
  hour: number;
  host: string;
  account: string;
  provider: string;
  project: string;
  kind: ToolKind;
  server: string;
  tool: string;
  target: string;
  calls: number;
  errors: number;
  receipts: number;
  msTotal: number;
  msUnder50: number;
  msUnder200: number;
  msUnder1s: number;
  msUnder5s: number;
  msOver5s: number;
  outBytes: number;
  turnUsd: number;
};

export type ToolRow = ToolFact | ToolHour;

/* ── filtering ─────────────────────────────────────────────────────────────*/

/** A map of dimension to values. `*` means every value; an empty list means
 *  none, which is different from all and is never produced by accident in the
 *  UI (section 9.1). A dimension absent from the map is unfiltered. */
export type Filter = Partial<Record<Dimension, string[]>>;

export type DimensionMap = Partial<Record<Dimension, string>>;

/** The dimensions a usage row carries itself. `card` and `branch` are resolved
 *  through `analytics_session` at query time, so they are absent here on
 *  purpose; `subagent` reads the fact's own `agent`, which is the subagent id. */
export function dimsOf(row: UsageRow): DimensionMap {
  return {
    host: row.host,
    account: row.account,
    provider: row.provider,
    model: row.model,
    cli: row.cli,
    effort: row.effort,
    project: row.project,
    source: row.source,
    session: "session" in row ? row.session : undefined,
    subagent: "agent" in row ? row.agent : undefined,
  };
}

/** The dimensions a tool row carries. A skill is a tool whose `kind` is
 *  `skill`, and its name is the row's `target`, which is why `skill` is not a
 *  column.
 *
 *  The fine `tool_fact` carries neither account, provider nor project: they are
 *  resolved through `analytics_session`, the same join `card` and `branch` cost.
 *  `tool_hour` carries all three because they survive three years, which is
 *  why the coarse row answers a split the fine row has to join for. */
export function toolDimsOf(row: ToolRow): DimensionMap {
  return {
    host: row.host,
    account: "account" in row ? row.account : undefined,
    provider: "provider" in row ? row.provider : undefined,
    project: "project" in row ? row.project : undefined,
    tool: row.tool,
    server: row.server,
    skill: row.kind === "skill" ? row.target : undefined,
    subagent: "agent" in row ? row.agent : undefined,
    session: "session" in row ? row.session : undefined,
  };
}

/** Whether a row's dimensions satisfy a filter. An empty list matches nothing;
 *  `*` anywhere in a list matches everything; a dimension the filter does not
 *  name is unfiltered. */
export function matches(filter: Filter, dims: DimensionMap): boolean {
  for (const [dim, values] of Object.entries(filter)) {
    if (!values) continue;
    if (values.includes("*")) continue;
    if (values.length === 0) return false;
    const value = dims[dim as Dimension] ?? "";
    if (!values.includes(value)) return false;
  }
  return true;
}

export function filterRows<T>(rows: readonly T[], filter: Filter, dims: (row: T) => DimensionMap): T[] {
  if (Object.keys(filter).length === 0) return rows.slice();
  return rows.filter((row) => matches(filter, dims(row)));
}

/* ── buckets ───────────────────────────────────────────────────────────────*/

export type Bucket = "1m" | "5m" | "15m" | "1h" | "1d" | "1w";

/** The fixed ladder, finest first. The gaps are deliberate: two panels that
 *  both answer from this ladder cannot have axes that nearly agree, which is
 *  what section 9.3 asks for. */
export const BUCKETS: readonly Bucket[] = ["1m", "5m", "15m", "1h", "1d", "1w"];

const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

/** The nominal width of a rung. Days and weeks follow the local calendar in
 *  `bucketOf`; these are what an *estimate* of the point count uses. */
export const BUCKET_MS: Record<Bucket, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": HOUR,
  "1d": DAY,
  "1w": WEEK,
};

/** The bucket an instant falls in, as the bucket's start.
 *
 *  Sub-day rungs floor on the epoch, which is the grain the hourly tier stores
 *  (UTC hours, section 3.6) and is stable across a page reload. Days and weeks
 *  follow the *local* calendar, because a day is a timezone and section 11.13
 *  says the card's own `today` is local midnight rather than UTC. A week starts
 *  on Monday, the ISO convention, so two walls in two timezones still agree
 *  about which week an instant belongs to once their local dates agree. */
export function bucketOf(at: number, bucket: Bucket): number {
  if (bucket === "1d" || bucket === "1w") {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    if (bucket === "1w") {
      /* getDay() is 0 for Sunday. Monday is the start, so Sunday steps back
         six days and Monday steps back none. */
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    }
    return d.getTime();
  }
  const width = BUCKET_MS[bucket];
  return Math.floor(at / width) * width;
}

/** The number of points a rung draws across a span. At least one, since a span
 *  narrower than a rung still has a bucket. */
export function bucketCount(spanMs: number, bucket: Bucket): number {
  return Math.max(1, Math.ceil(Math.max(0, spanMs) / BUCKET_MS[bucket]));
}

/** `auto` targets 80 to 200 points (section 9.3).
 *
 *  The ladder cannot always land inside that band: a month is 720 hours or 30
 *  days and nothing in between, so the choice is made by distance rather than
 *  by a hard window. A count over 200 is scored as how many times over it is,
 *  an under-80 count as how many times short, and anything inside the band is
 *  one. An equal score keeps the finer rung, because the only exact tie is a
 *  span shorter than the finest rung, where every rung draws a single point and
 *  the finest is the honest axis. */
export const AUTO_MIN = 80;
export const AUTO_MAX = 200;

export function autoBucket(spanMs: number): Bucket {
  let best: Bucket = BUCKETS[0];
  let bestScore = Infinity;
  for (const bucket of BUCKETS) {
    const n = bucketCount(spanMs, bucket);
    const score = n > AUTO_MAX ? n / AUTO_MAX : n < AUTO_MIN ? AUTO_MIN / n : 1;
    /* Strictly better only, so an equal score keeps the rung already chosen.
       The ladder is ordered finest first, so the degenerate tie answers 1m. */
    if (score < bestScore - 1e-9) {
      best = bucket;
      bestScore = score;
    }
  }
  return best;
}

/* ── which tier answers ────────────────────────────────────────────────────*/

export type Tier = "fine" | "hourly" | "daily";

/** Section 9.3: a span shorter than the fine tier's ninety days uses the fine
 *  facts, longer uses the hourly rollups, and beyond a year the days are summed
 *  from hours at query time because the daily tier is derived rather than
 *  stored. */
export const FINE_KEEP_MS = 90 * DAY;
export const HOUR_KEEP_MS = YEAR;
/** `tool_hour` is kept three years, and it is the only place a percentile older
 *  than ninety days can come from. */
export const LATENCY_KEEP_MS = 3 * YEAR;

export function tierFor(spanMs: number): Tier {
  if (spanMs <= FINE_KEEP_MS) return "fine";
  if (spanMs <= HOUR_KEEP_MS) return "hourly";
  return "daily";
}

/** The finest bucket a tier can honestly answer. A 1-minute question about two
 *  years ago is not a question the hourly rollups can hear.
 *
 *  The *subject's* own grain can be coarser than this, which is why `resolveView`
 *  takes one and clamps to it: `usage_fact` is one row per five minutes
 *  (section 3.1), so a 1-minute bucket over it would draw four empty minutes
 *  between every point and claim a resolution the data does not have. */
export const TIER_FLOOR: Record<Tier, Bucket> = { fine: "1m", hourly: "1h", daily: "1d" };

/** The grain a view spec is read at unless its caller says otherwise: the
 *  five-minute bucket `usage_fact` is written at. A caller reading the live
 *  ring or per-turn tool rows passes a finer one. */
export const USAGE_GRAIN: Bucket = "5m";

export function bucketFiner(a: Bucket, b: Bucket): boolean {
  return BUCKETS.indexOf(a) < BUCKETS.indexOf(b);
}

/** The coarser of two rungs. Ties answer `a`. */
export function coarser(a: Bucket, b: Bucket): Bucket {
  return BUCKETS.indexOf(a) >= BUCKETS.indexOf(b) ? a : b;
}

/** Dimensions the hourly and daily tiers do not carry (section 9.1). A card,
 *  branch, session or subagent split over a year is a rollup of every
 *  conversation ever taken, so it is refused with the tier named. */
const FINE_ONLY: readonly Dimension[] = ["session", "card", "branch", "subagent"];

export function dimensionAt(dim: Dimension, tier: Tier): boolean {
  return tier === "fine" || !FINE_ONLY.includes(dim);
}

/* ── spans ─────────────────────────────────────────────────────────────────*/

const SPAN_UNIT: Record<string, number> = { m: MINUTE, h: HOUR, d: DAY, w: WEEK, y: YEAR };

/** A span literal as section 9.2 writes it: `7d`, `24h`, `1y`. Lowercase units;
 *  `m` is minutes, which is the only reading that keeps `1m` meaning the bucket
 *  it names. */
export function spanMsOf(span: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhdwy])\s*$/i.exec(span);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * SPAN_UNIT[m[2].toLowerCase()];
}

/** A span made canonical, or the default. A number is not a span, an unknown
 *  unit is not a span, and a zero-width view is not one either. */
export function normalizeSpan(raw: unknown, fallback = "7d"): string {
  if (typeof raw !== "string") return fallback;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mhdwy])\s*$/i.exec(raw);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return `${m[1]}${m[2].toLowerCase()}`;
}

/* ── aggregation ───────────────────────────────────────────────────────────*/

export type Point = { at: number; value: number };

/** A quantile by linear interpolation between the two nearest ranks. This is
 *  the reading the doc means by "the p95 of the finer buckets": a percentile
 *  over the bucket values, not over the requests inside them. */
export function quantile(values: readonly number[], q: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const p = Math.min(1, Math.max(0, q));
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** One aggregate over a series. `sum` of nothing is 0, because a total of no
 *  rows is zero; every other aggregate of nothing is null, because a mean or a
 *  percentile of nothing is not a number. `count` is the number of points with
 *  a value, which is the number of non-empty buckets. */
export function aggregate(points: readonly Point[], how: Aggregate): number | null {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  switch (how) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    case "max":
      return values.length ? Math.max(...values) : null;
    case "count":
      return values.length;
    case "last": {
      let latest: Point | null = null;
      for (const p of points) {
        if (!Number.isFinite(p.value)) continue;
        if (latest === null || p.at > latest.at) latest = p;
      }
      return latest ? latest.value : null;
    }
    case "p50":
      return quantile(values, 0.5);
    case "p95":
      return quantile(values, 0.95);
  }
}

/** The sentence a percentile aggregate owes its reader (section 9.1).
 *
 *  A p95 over bucket totals is a different animal from a p95 over the requests
 *  inside them, and a chart that swapped one for the other silently would be
 *  lying about its own axis. The number is still the right number for the
 *  series; this is what makes the face say which series it is. */
export function aggregateNote(how: Aggregate, bucket: Bucket): string | null {
  if (how !== "p50" && how !== "p95") return null;
  return `${how} of ${bucket} totals, not of the requests inside them`;
}

/* ── what a row is worth ───────────────────────────────────────────────────*/

/** A rate, with the two cache-write multipliers `usage.ts::Rate` does not carry.
 *
 *  The store's `rate` history has `write_5m` and `write_1h` as columns (section
 *  3.5), and a table that can differ from today's constants is the whole point
 *  of pricing at the fact's own date. Both are optional, and the constants
 *  below are the fallback, so `usage.ts`'s `Rate` still satisfies this. */
export type ModelRate = Rate & {
  write5m?: number;
  write1h?: number;
};

/** A rate lookup. The default is `usage.ts`'s constant table; the store's
 *  `rate` history is the better source once it exists (section 3.5), and a
 *  caller with it passes it in here rather than this module reading the DB. */
export type RateResolver = (model: string, at: number) => ModelRate | null;

/* The same multipliers `usage.ts::priceOf` applies. They are repeated rather
 * than imported because `priceOf` takes the two cache-write TTLs as one
 * `cacheWrite`, and a fact carries them apart. `test/analytics.test.ts` holds
 * the cache-read multiplier against `priceOf` so the two cannot quietly drift. */
const CACHE_READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2;

/** A funding sentinel is not an account: `@deepseek` and `@credits` are money
 *  from somewhere else, and they never touch the subscription's denominator
 *  (section 5.2). Every sentinel starts with `@`; `accounts.rs::is_label`
 *  refuses one as an account name for the same reason. */
export function isSentinel(account: string): boolean {
  return account.trimStart().startsWith("@");
}

/** `usd_modeled`: the tokens priced through the rate in force at the fact's own
 *  timestamp.
 *
 *  Null, not zero, in the two cases the doc names. A provider card's transcript
 *  carries a Claude alias, so this table cannot know the tokens were billed by
 *  DeepSeek at all; `usd_reported` is the figure that wins, and a modeled zero
 *  would look authoritative (section 3.5). A model the table has never heard of
 *  is the other null, and it is counted as unpriced rather than folded as free.
 */
export function modeledUsd(row: UsageRow, rates: RateResolver = rateAt): number | null {
  if (isSentinel(row.account)) return null;
  const rate = rates(row.model, atOf(row));
  if (!rate) return null;
  return (
    (row.inTok * rate.input +
      row.outTok * rate.output +
      row.cacheRead * rate.input * (rate.cacheRead ?? CACHE_READ) +
      row.write5m * rate.input * (rate.write5m ?? WRITE_5M) +
      row.write1h * rate.input * (rate.write1h ?? WRITE_1H)) /
    1e6
  );
}

/** A measure's value on one usage row, or null where the row cannot answer it.
 *  The null is the "unpriced" count a face owes the reader; it is never folded
 *  in as a zero.
 *
 *  Two measures deliberately have no row of their own: `allowance_points` and
 *  `residual_points` are the output of the allowance arithmetic in section 5,
 *  not columns on a usage fact, and their series is assembled from
 *  `attribute`/`residualOf` readings rather than folded from here. */
export function measureValue(row: UsageRow, key: MeasureKey, rates: RateResolver = rateAt): number | null {
  switch (key) {
    case "tokens":
      return row.inTok + row.outTok + row.cacheRead + row.write5m + row.write1h;
    case "tokens_in":
      return row.inTok;
    case "tokens_out":
      return row.outTok;
    case "tokens_cache_read":
      return row.cacheRead;
    case "tokens_cache_write":
      return row.write5m + row.write1h;
    case "usd_modeled":
      return modeledUsd(row, rates);
    case "usd_reported":
      /* **Null on a transcript fact, because a transcript carries no money.**
         The ingest writes zero there and is right to: pricing is a query-time
         read of the rate table, and the only rows that can carry a reported
         figure are the `turn`-provenance ones the backfill writes from the CLI's
         own `total_cost_usd`. Returning the stored zero for a transcript row
         made this measure read a flat nothing for every row that exists today,
         which looks like a price of free rather than like a measurement nobody
         took. */
      return row.provenance === "turn" ? row.usdReported : null;
    case "requests":
      return row.requests;
    default:
      return null;
  }
}

export type Folded = {
  value: number | null;
  /** Rows offered to the fold. */
  rows: number;
  /** Rows that produced a value. */
  counted: number;
  /** Rows the measure could not price. A provider fact under `usd_modeled` is
   *  the case this exists for. */
  unpriced: number;
};

/** Fold rows with the measure's own `within` rule. This is the *inside of one
 *  bucket* fold; `aggregate` is what happens across buckets. */
export function fold(rows: readonly UsageRow[], key: MeasureKey, rates: RateResolver = rateAt): Folded {
  const spec = MEASURES[key];
  if (!spec?.within) return { value: null, rows: rows.length, counted: 0, unpriced: rows.length };

  let sum = 0;
  let n = 0;
  let max = -Infinity;
  let latestAt = -Infinity;
  let latest: number | null = null;

  for (const row of rows) {
    const v = measureValue(row, key, rates);
    if (v === null || !Number.isFinite(v)) continue;
    n += 1;
    sum += v;
    if (v > max) max = v;
    const at = atOf(row);
    if (at >= latestAt) {
      latestAt = at;
      latest = v;
    }
  }

  let value: number | null;
  switch (spec.within) {
    case "sum":
      value = n ? sum : null;
      break;
    case "mean":
      value = n ? sum / n : null;
      break;
    case "max":
      value = n ? max : null;
      break;
    case "last":
      value = latest;
      break;
  }
  return { value, rows: rows.length, counted: n, unpriced: rows.length - n };
}

export type Series = {
  points: Point[];
  /** Rows the measure could not price across the whole span. */
  unpriced: number;
};

/** One pass over the rows, bucketed. O(rows), not O(rows x buckets): the bucket
 *  is a map key and the fold happens once per group.
 *
 *  A bucket with no value is **omitted**, not drawn at zero. A gap in the
 *  series is how a sleeping machine and a wall nobody was using stay
 *  distinguishable (sections 9.6 and 3.4's cadence). */
export function series(
  rows: readonly UsageRow[],
  key: MeasureKey,
  bucket: Bucket,
  rates: RateResolver = rateAt,
): Series {
  const groups = new Map<number, UsageRow[]>();
  for (const row of rows) {
    const at = bucketOf(atOf(row), bucket);
    const group = groups.get(at);
    if (group) group.push(row);
    else groups.set(at, [row]);
  }
  const points: Point[] = [];
  let unpriced = 0;
  for (const [at, group] of groups) {
    const f = fold(group, key, rates);
    unpriced += f.unpriced;
    if (f.value !== null) points.push({ at, value: f.value });
  }
  points.sort((a, b) => a.at - b.at);
  return { points, unpriced };
}

/** A measure's value on one tool row. The tool half of the vocabulary is
 *  counts and sizes; a latency percentile is not a row measure, because it
 *  needs the whole distribution, and `latency` is what gives it. */
export function toolValue(row: ToolRow, key: MeasureKey): number | null {
  switch (key) {
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "out_bytes":
      return row.outBytes;
    /* A skill is a tool call whose `kind` is `skill`; the count is the row's
       own calls, so a skill invoked twice in one turn counts twice. */
    case "skill_calls":
      return row.kind === "skill" ? row.calls : 0;
    case "skill_cost":
      return row.kind === "skill" ? row.turnUsd : 0;
    case "error_rate":
      return row.calls > 0 ? row.errors / row.calls : null;
    default:
      return null;
  }
}

/** Fold tool rows inside one bucket. `error_rate` is the one that is not a sum:
 *  it is total errors over total calls, because summing two rates would be a
 *  different, wrong number. */
export function toolFold(rows: readonly ToolRow[], key: MeasureKey): Folded {
  let calls = 0;
  let errors = 0;
  let sum = 0;
  let n = 0;
  let max = -Infinity;
  let latestAt = -Infinity;
  let latest: number | null = null;

  for (const row of rows) {
    const v = toolValue(row, key);
    if (v === null || !Number.isFinite(v)) continue;
    n += 1;
    sum += v;
    if (v > max) max = v;
    calls += row.calls;
    errors += row.errors;
    const at = "hour" in row ? row.hour : row.at;
    if (at >= latestAt) {
      latestAt = at;
      latest = v;
    }
  }

  const spec = MEASURES[key];
  let value: number | null;
  if (key === "error_rate") value = calls > 0 ? errors / calls : null;
  else if (!spec?.within) value = null;
  else if (spec.within === "sum") value = n ? sum : null;
  else if (spec.within === "mean") value = n ? sum / n : null;
  else if (spec.within === "max") value = n ? max : null;
  else value = latest;

  return { value, rows: rows.length, counted: n, unpriced: rows.length - n };
}

/** A tool series, bucketed the same way a usage series is. A bucket with no
 *  tool row is a gap, exactly as it is on the usage side. */
export function toolSeries(rows: readonly ToolRow[], key: MeasureKey, bucket: Bucket): Series {
  const groups = new Map<number, ToolRow[]>();
  for (const row of rows) {
    const at = bucketOf("hour" in row ? row.hour : row.at, bucket);
    const group = groups.get(at);
    if (group) group.push(row);
    else groups.set(at, [row]);
  }
  const points: Point[] = [];
  let unpriced = 0;
  for (const [at, group] of groups) {
    const f = toolFold(group, key);
    unpriced += f.unpriced;
    if (f.value !== null) points.push({ at, value: f.value });
  }
  points.sort((a, b) => a.at - b.at);
  return { points, unpriced };
}

/* ── latency, and what a percentile can honestly say ───────────────────────*/

/** The five exclusive latency bands of a `tool_hour` row. */
export type LatencyBands = {
  under50: number;
  under200: number;
  under1s: number;
  under5s: number;
  over5s: number;
};

export function bandsOf(row: ToolHour): LatencyBands {
  return {
    under50: row.msUnder50,
    under200: row.msUnder200,
    under1s: row.msUnder1s,
    under5s: row.msUnder5s,
    over5s: row.msOver5s,
  };
}

/* The bands' edges. The last one is open, which is why a quantile landing there
 * is reported as `atLeast` rather than given an invented upper bound. */
const BAND_EDGES: readonly [number, number | null][] = [
  [0, 50],
  [50, 200],
  [200, 1000],
  [1000, 5000],
  [5000, null],
];

/** A percentile estimated from the hourly bands.
 *
 *  Linear inside a closed band and the band's lower edge inside the open one,
 *  with `atLeast` set so the face can say "over 5s" rather than "exactly 5s".
 *  An estimate is the whole of what months of tool calls can honestly give
 *  (sections 3.6 and 19). */
export function percentileFromBuckets(
  bands: LatencyBands,
  q: number,
): { ms: number; atLeast: boolean } | null {
  const counts = [bands.under50, bands.under200, bands.under1s, bands.under5s, bands.over5s].map((n) =>
    Number.isFinite(n) && n > 0 ? n : 0,
  );
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const p = Math.min(1, Math.max(0, q));
  if (p <= 0) return { ms: 0, atLeast: false };

  const target = p * total;
  let before = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const n = counts[i];
    if (n <= 0) continue;
    const after = before + n;
    if (target <= after) {
      const fraction = (target - before) / n;
      const [lo, hi] = BAND_EDGES[i];
      if (hi === null) return { ms: lo, atLeast: true };
      return { ms: lo + (hi - lo) * fraction, atLeast: false };
    }
    before = after;
  }
  /* Unreachable while the counts sum to their own total, but a float and an
     empty set can still part company here, and the open band's floor is the
     honest answer either way. */
  return { ms: BAND_EDGES[BAND_EDGES.length - 1][0], atLeast: true };
}

export type LatencyReading = {
  ms: number;
  /** `rows`: the fine tool facts, one row per turn and tool, exact over those
   *  rows. `buckets`: summed `tool_hour` bands, an estimate over calls. */
  basis: "rows" | "buckets";
  exact: boolean;
  atLeast: boolean;
  /** What the value was computed over. Rows for the fine tier, calls for the
   *  hourly one, because a band counts calls. */
  n: number;
};

/** A percentile over tool rows, chosen by the rows' own grain.
 *
 *  The fine tier stores one row per turn and tool, so a percentile there is
 *  exact over *rows*: a row that carried several identical calls was already
 *  summed by the fold, and this cannot take it apart again. The hourly tier
 *  stores bands, so its percentile is estimated over calls and labelled as an
 *  estimate. The doc's rule is that a chart may swap one for the other only if
 *  it says so. */
export function latency(rows: readonly ToolRow[], q: number): LatencyReading | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  if ("msUnder50" in first) {
    const total: LatencyBands = { under50: 0, under200: 0, under1s: 0, under5s: 0, over5s: 0 };
    let calls = 0;
    for (const row of rows) {
      const b = bandsOf(row as ToolHour);
      total.under50 += b.under50;
      total.under200 += b.under200;
      total.under1s += b.under1s;
      total.under5s += b.under5s;
      total.over5s += b.over5s;
      calls += b.under50 + b.under200 + b.under1s + b.under5s + b.over5s;
    }
    const p = percentileFromBuckets(total, q);
    if (!p) return null;
    return { ms: p.ms, basis: "buckets", exact: false, atLeast: p.atLeast, n: calls };
  }
  const values = rows.map((row) => (row as ToolFact).msTotal).filter((v) => Number.isFinite(v));
  const ms = quantile(values, q);
  if (ms === null) return null;
  return { ms, basis: "rows", exact: true, atLeast: false, n: values.length };
}

/** The sentence a percentile owes its reader (section 9.1). */
export function latencyLabel(reading: LatencyReading, q: number): string {
  const p = `p${Math.round(Math.min(1, Math.max(0, q)) * 100)}`;
  if (reading.basis === "rows") return `${p} over ${count(reading.n)} tool rows`;
  const at = reading.atLeast ? "at least " : "";
  return `${p} estimated from ${count(reading.n)} calls in hourly buckets (${at}${Math.round(reading.ms)}ms)`;
}

/** Whether a span's tier can answer a percentile at all.
 *
 *  Fine answers exactly, hourly and daily answer as estimates from the bands.
 *  Past the three-year retention of `tool_hour` there is nothing to estimate
 *  from, and that is the one arm that refuses: the daily tier is derived from
 *  hourly rows, so when the hours are gone the percentile is gone with them. */
export function latencyBasis(
  tier: Tier,
  spanMs: number,
): { ok: true; basis: "rows" | "buckets"; exact: boolean } | { ok: false; error: ViewRefusal } {
  if (spanMs > LATENCY_KEEP_MS) {
    return {
      ok: false,
      error: {
        code: "percentile",
        tier,
        detail: `a percentile over ${duration(spanMs)} is beyond the three-year latency buckets`,
      },
    };
  }
  return tier === "fine"
    ? { ok: true, basis: "rows", exact: true }
    : { ok: true, basis: "buckets", exact: false };
}

/* ── the allowance residual (section 5) ────────────────────────────────────*/

export type CostFact = {
  account: string;
  host: string;
  /** Modeled cost in dollars, the weight the interval's delta is divided by. */
  cost: number;
};

export type AttributedPoint = { fact: CostFact; points: number };

/* One predicate, so the denominator and the coverage label cannot disagree
 * about which facts count. A zero-cost or unpriced fact is a known request that
 * cannot carry a share, and it is not evidence that its host's spend is
 * accounted for. */
function attributable(f: CostFact, account: string): boolean {
  return f.account === account && !isSentinel(f.account) && Number.isFinite(f.cost) && f.cost > 0;
}

/** Split one sample interval's delta among the facts that overlap it.
 *
 *  The denominator is the account's own work: another account's card on the
 *  same machine never takes points from this account's delta, and a provider
 *  sentinel never touches the subscription at all. A fact whose account is
 *  `unknown` stays out and its share remains residual.
 *
 *  An interval with no known request is wholly unattributed. An interval with
 *  some divides its delta among them and **nothing is scaled up to fill a gap
 *  elsewhere**: a fact-less interval stays residual, so a missing machine
 *  cannot make every known card look more expensive (section 5.2). */
export function attribute(
  delta: number,
  facts: readonly CostFact[],
  account: string,
): { points: AttributedPoint[]; attributed: number; residual: number } {
  const d = Number.isFinite(delta) && delta > 0 ? delta : 0;
  const eligible = facts.filter((f) => attributable(f, account));
  const total = eligible.reduce((a, f) => a + f.cost, 0);
  if (d === 0 || eligible.length === 0 || total <= 0) {
    return { points: [], attributed: 0, residual: d };
  }
  const points = eligible.map((fact) => ({ fact, points: (d * fact.cost) / total }));
  /* The shares sum to the delta by construction, so the attributed figure is
     the delta itself rather than a float that is a hair under it. */
  return { points, attributed: d, residual: 0 };
}

export type DeltaSpan = {
  /** Points the window moved across this sample interval. `max(0, …)` is the
   *  caller's, per section 5.1: a roll starts a new instance and never produces
   *  a negative delta. */
  delta: number;
  /** Every fact overlapping the interval, from any account. Account scoping
   *  happens here, not at the caller. */
  facts: readonly CostFact[];
};

export type ResidualInput = {
  /** The account the allowance window belongs to. */
  account: string;
  spans: readonly DeltaSpan[];
  /** Every host that sent a sample for this window. Required rather than
   *  optional: a host here with no fact is the only thing that can make the
   *  reading *partial*, and a caller that omitted the list would be handed
   *  `full` by default, which is a claim the input did not support. */
  sampled: readonly string[];
};

export type ResidualReading = {
  account: string;
  /** The account's delta, after the provider exclusion. */
  delta: number;
  attributed: number;
  /** The unaccounted share. Never invented, never negative. */
  residual: number;
  /** `partial` when a host sent a sample but no fact, or, for a subscription
   *  window (`excluded` false), when no sample list was given at all; the
   *  residual is then a floor, not a complete account. An excluded provider
   *  reading has no subscription residual to be partial about. */
  coverage: "full" | "partial";
  /** The hosts that sent samples and no facts. */
  missing: string[];
  /** True when the whole reading is a provider sentinel's, which has no
   *  subscription residual at all (section 5.2). */
  excluded: boolean;
};

/** The residual over a window: the account's delta minus what its own facts
 *  can account for (section 5.3).
 *
 *  Two windows are deliberately not one input: the five-hour and the weekly
 *  delta are not additive, and a caller that summed them would be summing two
 *  different currencies (section 5.5). Call this once per window kind. */
export function residualOf(input: ResidualInput): ResidualReading {
  const account = input.account;
  if (isSentinel(account)) {
    return { account, delta: 0, attributed: 0, residual: 0, coverage: "full", missing: [], excluded: true };
  }

  let delta = 0;
  let attributed = 0;
  const withFacts = new Set<string>();
  for (const span of input.spans) {
    delta += Number.isFinite(span.delta) && span.delta > 0 ? span.delta : 0;
    const a = attribute(span.delta, span.facts, account);
    attributed += a.attributed;
    for (const f of span.facts) {
      if (attributable(f, account)) withFacts.add(f.host);
    }
  }

  /* The type requires the list, but a JavaScript caller can still omit it.
     Treating that as "no host is missing" would be the completeness claim
     section 15 forbids, so an absent list reads as partial: the reading cannot
     know what it was not told. */
  const sampled = Array.isArray(input.sampled) ? input.sampled : null;
  const missing = sampled === null ? [] : [...new Set(sampled)].filter((host) => !withFacts.has(host));
  return {
    account,
    delta,
    attributed,
    residual: Math.max(0, delta - attributed),
    coverage: sampled === null || missing.length ? "partial" : "full",
    missing,
    excluded: false,
  };
}

/* ── derived measures (section 9.4) ────────────────────────────────────────*/

/** `per_card`: cost divided by completed turns. Null when there is no divisor,
 *  because a ratio of unlike things is a number the face would have to
 *  apologise for. */
export function perCard(cost: number, turns: number): number | null {
  if (!Number.isFinite(cost) || !Number.isFinite(turns) || turns <= 0) return null;
  return cost / turns;
}

/** `pace` for a window instance: used divided by what the chosen curve expected
 *  by now. Null when there is no honest expectation to divide by. */
export function pace(used: number, expected: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(expected) || expected <= 0) return null;
  return used / expected;
}

/* ── the palette (section 10.1) ────────────────────────────────────────────*/

/* The categorical palette lives in the cool half because the warm half is
 * already status: celadon working, amber asking, rust failed. A series in amber
 * is a chart that lies about what a colour means on this wall.
 *
 * **There are five slots, not six, and the doc measured it that way**: the
 * validator's own output says "categorical: 5 slots", and violet is recorded as
 * "the fifth, and the ceiling". The fold colour past the ceiling is a text
 * token rather than a sixth hue, so it cannot be mistaken for an identity.
 * Hues are assigned in this fixed order and never cycled: a filter that changes
 * the series count does not repaint the survivors. */
export type SeriesSlot = { hue: string; hex: string; first: string };

export const SERIES: readonly SeriesSlot[] = [
  { hue: "blue", hex: "#3987e5", first: "the account or series you are asking about" },
  { hue: "magenta", hex: "#d55181", first: "the second" },
  { hue: "yellow", hex: "#c98500", first: "the third; direct labels become mandatory here" },
  { hue: "aqua", hex: "#199e70", first: "the fourth" },
  { hue: "violet", hex: "#9085e9", first: "the fifth, and the ceiling" },
];

/** Beyond this, fold to *other* or facet. */
export const SERIES_CEILING = SERIES.length;
/** The only three a scatter or a small multiple may use: the first three pass
 *  the stricter all-pairs CVD test. */
export const SERIES_ALL_PAIRS = 3;
/** The fold, for anything past the ceiling. Not a sixth slot. */
export const SERIES_FOLD = "var(--paper-faint)";
/** One hue, dark near the surface to bright at the top, for a dark ground. */
export const SEQUENTIAL: readonly string[] = ["#1b3a5c", "#3987e5", "#9ec5f4"];
/** Blue against rust with the neutral midpoint at rest: a polarity encoding
 *  used only for ahead/behind pacing, never beside a categorical series. */
export const DIVERGING = { low: "#3987e5", mid: "var(--st-rest)", high: "#c5603f" } as const;

/** A series' colour by its slot. Never cycles: the sixth series folds. */
export function seriesColor(slot: number): string {
  return SERIES[slot]?.hex ?? SERIES_FOLD;
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** A token count with its unit. Compact enough for a stat tile, and never a
 *  bare numeral on a face where cost also appears: "1.2M" of what is a question
 *  the reader should not have to ask. */
export function tokens(n: number): string {
  if (!(n > 0)) return "0 tokens";
  if (n === 1) return "1 token";
  return `${count(n)} tokens`;
}

/** A duration at the resolution its size deserves. Days above an hour, weeks
 *  above a day, years above a week, and nothing below a minute: this is for
 *  spans and buckets, not for a ticking countdown. */
export function duration(ms: number): string {
  if (!(ms > 0)) return "under a minute";
  const mins = Math.round(ms / MINUTE);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const hm = mins % 60;
  if (h < 24) return hm ? `${h}h ${hm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const dh = h % 24;
  if (d < 7) return dh ? `${d}d ${dh}h` : `${d}d`;
  const w = Math.floor(d / 7);
  const wd = d % 7;
  if (d < 365) return wd ? `${w}w ${wd}d` : `${w}w`;
  const y = Math.floor(d / 365);
  const yd = d % 365;
  return yd ? `${y}y ${yd}d` : `${y}y`;
}

/* ── the view spec (section 9.2) ───────────────────────────────────────────*/

export type ViewForm = "area" | "line" | "bar" | "scatter" | "heatmap" | "table" | "stat";

export const FORMS: readonly ViewForm[] = ["area", "line", "bar", "scatter", "heatmap", "table", "stat"];

export type Annotation = "reset" | "residual" | "plan" | "window";

export const ANNOTATIONS: readonly Annotation[] = ["reset", "residual", "plan", "window"];

export type ViewPanel = {
  form: ViewForm;
  measure: MeasureKey;
  /** The dimension the series are split by, or null for one series. */
  split: Dimension | null;
  filter: Filter;
  stack: boolean;
  annotate: Annotation[];
};

export type ViewSpec = {
  v: 1;
  name: string;
  /** A canonical span literal, e.g. `7d`. Never a number, never unknown. */
  span: string;
  bucket: Bucket | "auto";
  filter: Filter;
  panels: ViewPanel[];
};

export const MAX_NAME = 120;

const DIMENSIONS: readonly Dimension[] = [
  "host",
  "account",
  "provider",
  "model",
  "cli",
  "effort",
  "project",
  "source",
  "session",
  "card",
  "branch",
  "tool",
  "server",
  "skill",
  "subagent",
];

export const DIMENSION_KEYS = DIMENSIONS;

/* A renamed knob degrades to the thing it was renamed *to* when the mapping is
 * unambiguous, and to the default otherwise. The two here are the renames the
 * design itself performed: "cost" was the first draft's word for modeled
 * dollars, and an "agent" split is a split by the fact's own agent id, which
 * section 9.1 calls a subagent. */
const MEASURE_ALIASES: Record<string, MeasureKey> = {
  cost: "usd_modeled",
  usd: "usd_modeled",
  dollars: "usd_reported",
  token: "tokens",
  tokens_processed: "tokens",
  points: "allowance_points",
  latency: "ms_p95",
};

const DIMENSION_ALIASES: Record<string, Dimension> = {
  agent: "subagent",
  account_label: "account",
  hostname: "host",
  folder: "project",
};

/** One filter value list, with unknown dimensions dropped and non-strings
 *  dropped. An empty list survives: it means *none*, and it is a real answer
 *  (section 9.1). */
function normalizeFilter(raw: unknown): Filter {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Filter = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const dim = (DIMENSION_ALIASES[key] ?? key) as Dimension;
    if (!DIMENSIONS.includes(dim)) continue;
    if (!Array.isArray(value)) continue;
    const kept = value.filter((v): v is string => typeof v === "string");
    /* An empty list is a real answer ("none"), and it is kept. A *non-empty*
       list that yielded no strings is a malformed config, and narrowing it to
       "none" would draw an empty chart that looks deliberate; dropping the
       dimension reads as unfiltered, which is the recoverable failure. */
    if (value.length > 0 && kept.length === 0) continue;
    out[dim] = kept;
  }
  return out;
}

function normalizeMeasure(raw: unknown): MeasureKey {
  if (typeof raw !== "string") return "usd_modeled";
  /* `hasOwn` rather than a bare index: a key like `toString` would otherwise
     come back as a prototype function and be cast to a measure name. */
  const key = (Object.hasOwn(MEASURE_ALIASES, raw) ? MEASURE_ALIASES[raw] : raw) as MeasureKey;
  return measureOf(key) ? key : "usd_modeled";
}

function normalizeForm(raw: unknown): { form: ViewForm; stack: boolean } {
  if (typeof raw !== "string") return { form: "area", stack: false };
  if (raw === "stacked" || raw === "stacked-area") return { form: "area", stack: true };
  return FORMS.includes(raw as ViewForm) ? { form: raw as ViewForm, stack: false } : { form: "area", stack: false };
}

function normalizeSplit(raw: unknown): Dimension | null {
  if (typeof raw !== "string" || raw === "" || raw === "*") return null;
  const dim = (DIMENSION_ALIASES[raw] ?? raw) as Dimension;
  return DIMENSIONS.includes(dim) ? dim : null;
}

function normalizePanel(raw: unknown): ViewPanel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const { form, stack: stacked } = normalizeForm(r.form);
  const annotate = Array.isArray(r.annotate)
    ? r.annotate.filter((a): a is Annotation => typeof a === "string" && ANNOTATIONS.includes(a as Annotation))
    : [];
  return {
    form,
    measure: normalizeMeasure(r.measure),
    split: normalizeSplit(r.split),
    filter: normalizeFilter(r.filter),
    /* `stack` is kept even where the form cannot stack, because a form changed
       back by hand should not silently lose the intent. */
    stack: stacked || r.stack === true,
    annotate: [...new Set(annotate)],
  };
}

function defaultPanel(): ViewPanel {
  return { form: "area", measure: "usd_modeled", split: null, filter: {}, stack: false, annotate: [] };
}

/** A readable default. A span of a week is the one the sample spec uses and the
 *  question the overlay opens with. */
export function defaultView(): ViewSpec {
  return { v: 1, name: "", span: "7d", bucket: "auto", filter: {}, panels: [defaultPanel()] };
}

/** A spec as it came off disk, made drawable.
 *
 *  The `widget.config_json` bargain: unknown keys are dropped, a renamed knob
 *  degrades, a panel from a newer build becomes a drawable one, and a config
 *  that would not parse becomes the default rather than a throw. Nothing here
 *  can put a NaN inside a frame loop.
 *
 *  This does not refuse an unanswerable *combination* (a session split over a
 *  year). That is `resolveView`'s job, because the span is data and a
 *  normaliser that quietly rewrote it would be hiding the question rather than
 *  answering it. */
export function normalizeView(raw: unknown): ViewSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultView();
  const r = raw as Record<string, unknown>;

  const panels = Array.isArray(r.panels)
    ? r.panels.map(normalizePanel).filter((p): p is ViewPanel => p !== null)
    : [];

  const bucket = typeof r.bucket === "string" && (r.bucket === "auto" || BUCKETS.includes(r.bucket as Bucket))
    ? (r.bucket as Bucket | "auto")
    : "auto";

  const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_NAME) : "";

  return {
    v: 1,
    name,
    span: normalizeSpan(r.span),
    bucket,
    filter: normalizeFilter(r.filter),
    panels: panels.length ? panels : [defaultPanel()],
  };
}

/* ── resolving a spec against a tier ───────────────────────────────────────*/

export type ViewRefusal = {
  code: "dimension" | "bucket" | "percentile";
  /** The tier that answered, and could not. Always named: a refusal without it
   *  is the silent degradation the doc forbids. */
  tier: Tier;
  dimension?: Dimension;
  detail: string;
};

export type ResolvedView = {
  spec: ViewSpec;
  tier: Tier;
  /** The rung actually drawn: `auto` clamped to the coarser of the tier's floor
   *  and the subject's grain. */
  bucket: Bucket;
  /** The finest grain the rows behind this view have. */
  grain: Bucket;
  /** Epoch ms, half-open `[from, to)`. */
  from: number;
  to: number;
  /** How many buckets the chosen rung draws across the span at its nominal
   *  width. A local day or week can be an hour longer across a DST change, so
   *  a face drawing an axis uses the series it actually got; this is the
   *  estimate `auto` chose the rung on. */
  points: number;
};

export type Resolution = { ok: true; view: ResolvedView } | { ok: false; error: ViewRefusal };

/** Choose the tier and bucket for a spec, and refuse what the tier cannot
 *  answer.
 *
 *  Three refusals, each one a question that would otherwise be answered with
 *  the wrong rows:
 *
 *  - a fine-only dimension (session, card, branch, subagent) over a span the
 *    hourly or daily tier answers;
 *  - a bucket finer than the coarser of the tier's floor and the subject's own
 *    grain, which would ask 1-minute questions of a five-minute fact or an
 *    hourly rollup;
 *  - a percentile past the three-year latency retention.
 *
 *  `grain` is the finest the caller's rows are recorded at. It defaults to the
 *  five-minute `usage_fact` grain; a live ring or per-turn tool rows pass
 *  something finer. `auto` is clamped to it, so a one-hour view draws twelve
 *  five-minute points rather than sixty one-minute points, forty-eight of them
 *  empty.
 *
 *  The caller never has to know which tier answered on the happy path: it is
 *  returned so the face can say it, not so the caller can choose it. */
export function resolveView(
  spec: ViewSpec,
  now: number = Date.now(),
  grain: Bucket = USAGE_GRAIN,
): Resolution {
  const spanMs = spanMsOf(spec.span) ?? 7 * DAY;
  const tier = tierFor(spanMs);
  const recorded = BUCKETS.includes(grain) ? grain : USAGE_GRAIN;
  const floor = coarser(TIER_FLOOR[tier], recorded);
  const bucket = spec.bucket === "auto" ? coarser(autoBucket(spanMs), floor) : spec.bucket;

  if (bucketFiner(bucket, floor)) {
    return {
      ok: false,
      error: {
        code: "bucket",
        tier,
        detail: `${bucket} buckets are finer than the ${floor} grain this ${tier} view is read at`,
      },
    };
  }

  const used = new Set<Dimension>();
  for (const key of Object.keys(spec.filter)) used.add(key as Dimension);
  for (const panel of spec.panels) {
    if (panel.split) used.add(panel.split);
    for (const key of Object.keys(panel.filter)) used.add(key as Dimension);
    if (MEASURES[panel.measure]?.percentile) {
      const basis = latencyBasis(tier, spanMs);
      if (!basis.ok) return { ok: false, error: basis.error };
    }
  }

  for (const dim of used) {
    if (!dimensionAt(dim, tier)) {
      return {
        ok: false,
        error: {
          code: "dimension",
          tier,
          dimension: dim,
          detail: `${dim} is a fine-tier dimension; a ${spec.span} view is answered by the ${tier} tier`,
        },
      };
    }
  }

  return {
    ok: true,
    view: {
      spec,
      tier,
      bucket,
      grain: recorded,
      from: now - spanMs,
      to: now,
      points: bucketCount(spanMs, bucket),
    },
  };
}
