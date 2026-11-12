/* What a point of a window is worth, and whether that holds still.
 *
 * §22. A window is a percentage and nothing else; the two currencies Lyss asked
 * to read it in are bought by whatever the window was spent on, so the number is
 * a **price at a mix** rather than a property of the plan. Anthropic publishes
 * no token figure, so this is a derivation from this wall's own facts and says
 * what it rests on.
 *
 * ## What is identifiable, and what is not
 *
 * Attribution (`analytics.ts::attribute`) divides one interval's delta among its
 * facts by modeled cost. That is the right rule for "who paid", and it has a
 * consequence worth stating because it bounds this whole module: **a per-model
 * rate cannot be recovered from it**, because the split was made proportional to
 * dollars in the first place. Re-derive dollars-over-points for each model out
 * of an attributed interval and every model lands on the interval's own rate, by
 * construction. The data carries one number per interval (how far the window
 * moved) and one aggregate (what that cost), and those two cannot separate "the
 * window weights Opus differently from the price list" from "the window weights
 * by the price list".
 *
 * What *is* identifiable is the shape of the deviation: for every hour, what one
 * point cost, and whether the hours that cost more are the hours with a
 * different model mix, or specific hours of the day, or neither. That is a
 * comparison of groupings over the same deviations, and it is what `verdictOf`
 * does. Where the two move together (this wall does run Opus at particular
 * hours) they cannot be separated, and the verdict says so instead of awarding
 * the credit to whichever grouping happened to fit better.
 *
 * ## Bins
 *
 * One hour, both sides binned the same way. A ratio of sums within one bin is a
 * rate for that bin; five-minute dollars against a ten-minute sample would be a
 * rate for an interval neither of them covers. The hourly tier is also the only
 * one that reaches far enough back to see a week's shape (§22.5).
 */

import {
  atOf,
  isSentinel,
  modeledUsd,
  quantile,
  type HourFact,
  type UsageRow,
} from "./analytics";
import { instancesOf, type AllowanceSample } from "./allowancesamples";
import { count, money } from "./usage";

export const HOUR = 60 * 60 * 1000;

/** One hour of one window's life on one account. */
export type RateBin = {
  /** The hour's start, ms, on the hour. */
  at: number;
  account: string;
  /** The window kind: `session` is the five-hour, `weekly_all` the week. */
  kind: string;
  /** Which scoped window of that kind, `""` for the unscoped one. An account
   *  can carry two `weekly_scoped` windows at once and they are two currencies,
   *  so a bin that lost this would be the scope-summing bug §21.1 forbids. */
  scope: string;
  /** Points the window moved inside this hour. Positive steps only; a roll is a
   *  new instance and never a negative one. */
  points: number;
  /** Modeled dollars attributed to those points. */
  usd: number;
  /** Every token kind beside that money. */
  tokens: number;
  /** Model → share of this hour's dollars, summing to 1 on a priced hour. The
   *  reading's own record of what it was measured at. */
  mix: Record<string, number>;
  /** Tokens in this hour that the price table could not place. They buy the
   *  window like any other token and are kept out of *both* sides of the ratio:
   *  priced as zero they would make an unknown model look free (§9.1). */
  unpriced?: number;
};

/** A rate is only worth reading above this much movement. A bin at 0.2 points is
 *  mostly the sample's rounding, and reporting tenths of a cent per point off it
 *  would be noise dressed as a measurement. */
export const MIN_POINTS = 1;

/** The whole reading below is refused under this many trustworthy hours: one
 *  afternoon is an anecdote, and a "the rate varies" claim off four hours is the
 *  kind of invented structure this module exists to avoid. */
export const MIN_HOURS = 12;

/** How far a grouping's extremes must differ, as a fraction of the rate, before
 *  it is worth a sentence. Below it the spread is what sampling does. */
export const SPREAD_FLOOR = 0.08;

/** And how much of the deviation variance it must carry. */
export const EXPLAINED_FLOOR = 0.15;

export type WindowWorth = {
  account: string;
  kind: string;
  /** Points behind the rate. */
  points: number;
  /** Hours with a trustworthy rate inside `spanMs`. */
  hours: number;
  spanMs: number;
  /** Dollars of modeled work one point of this window bought. */
  usdPerPoint: number | null;
  /** Every token kind one point bought. */
  tokensPerPoint: number | null;
  /** The same two for a whole window, which is 100 points. */
  wholeUsd: number | null;
  wholeTokens: number | null;
  /** Where the rate sits, from resampling the bins (`bootBand`). */
  usdBand: [number, number] | null;
  /** What it was measured at, largest share first. */
  mix: readonly { model: string; share: number }[];
  /** Tokens spent inside the rated hours on models the price table could not
   *  place. Real work, deliberately outside the ratio, and said out loud. */
  unpricedTokens: number;
};

/** A bin is trustworthy when both sides are there: the window moved, and the
 *  price table placed the work. An unpriced hour has tokens and no dollars, and
 *  a dollar rate off it would be zero rather than absent. */
export function isRated(b: RateBin): boolean {
  return (
    Number.isFinite(b.points) &&
    Number.isFinite(b.usd) &&
    b.points >= MIN_POINTS &&
    b.usd > 0
  );
}

function binable(b: RateBin): boolean {
  return (
    Number.isFinite(b.at) &&
    Number.isFinite(b.points) &&
    Number.isFinite(b.usd) &&
    Number.isFinite(b.tokens) &&
    b.points >= 0 &&
    b.usd >= 0 &&
    b.tokens >= 0
  );
}

function mine(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  scope: string,
): RateBin[] {
  return bins.filter(
    (b) => b.account === account && b.kind === kind && b.scope === scope && binable(b),
  );
}

/** The bins of one account and window that fall inside the span. Every reading
 *  below starts here, so a figure and the verdict beside it are always about
 *  the same hours; there is no path that scopes one and not the other. */
function scoped(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  scope: string,
  since: number,
  until: number,
): RateBin[] {
  return mine(bins, account, kind, scope).filter((b) => b.at >= since && b.at < until);
}

function mixOf(bins: readonly RateBin[]): { model: string; share: number }[] {
  const by = new Map<string, number>();
  let total = 0;
  for (const b of bins) {
    for (const [model, share] of Object.entries(b.mix)) {
      if (!Number.isFinite(share) || share <= 0) continue;
      const dollars = share * b.usd;
      by.set(model, (by.get(model) ?? 0) + dollars);
      total += dollars;
    }
  }
  if (total <= 0) return [];
  return [...by.entries()]
    .map(([model, dollars]) => ({ model, share: dollars / total }))
    .sort((a, b) => b.share - a.share || a.model.localeCompare(b.model));
}

/** A seeded generator, because a bootstrap that reseeds per render draws a
 *  different interval every frame and reads as a number that flickers. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The rate's interval, by resampling the hours themselves. Deliberately a
 *  bootstrap over bins rather than a formula over points: points are not
 *  independent draws (one request can move a tenth of a window), so a
 *  Poisson-style standard error would be confidently wrong in the direction of
 *  an interval that is too tight. */
export function bootBand(
  used: readonly RateBin[],
  seed = 0x5eed,
  draws = 400,
): [number, number] | null {
  const rated = used.filter(isRated);
  if (rated.length < 2) return null;
  const next = seeded(seed);
  const rates: number[] = [];
  for (let d = 0; d < draws; d++) {
    let points = 0;
    let usd = 0;
    for (let i = 0; i < rated.length; i++) {
      const pick = rated[Math.floor(next() * rated.length)];
      points += pick.points;
      usd += pick.usd;
    }
    if (points > 0) rates.push(usd / points);
  }
  const lo = quantile(rates, 0.05);
  const hi = quantile(rates, 0.95);
  return lo === null || hi === null ? null : [lo, hi];
}

/** The reading for one account and one window kind: what a point buys, what a
 *  whole window is worth, and the mix it was measured at. `null` for a rate
 *  means *not measured*, never free (§9.1). */
export function worthOf(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  since: number,
  until: number,
  scope = "",
): WindowWorth {
  const all = scoped(bins, account, kind, scope, since, until);
  const used = all.filter(isRated);
  let points = 0;
  let usd = 0;
  let tokens = 0;
  for (const b of used) {
    points += b.points;
    usd += b.usd;
    tokens += b.tokens;
  }
  /* Unpriced tokens are counted over every hour of the span, rated or not: an
   *  hour the window moved through entirely on a model this build cannot price
   *  is work the rate does not cover, and hiding it would make the reading look
   *  complete. */
  const unpricedTokens = all.reduce((n, b) => n + (b.unpriced ?? 0), 0);
  const usdPerPoint = points > 0 && usd > 0 ? usd / points : null;
  const tokensPerPoint = points > 0 && tokens > 0 ? tokens / points : null;
  return {
    account,
    kind,
    points,
    hours: used.length,
    spanMs: Math.max(0, until - since),
    usdPerPoint,
    tokensPerPoint,
    wholeUsd: usdPerPoint === null ? null : usdPerPoint * 100,
    wholeTokens: tokensPerPoint === null ? null : tokensPerPoint * 100,
    usdBand: bootBand(used),
    mix: mixOf(used),
    unpricedTokens,
  };
}

/* ── the spread, and what it might be ───────────────────────────────────────*/

export type Grouping = {
  /** What the grouping is called in a sentence. */
  name: "mix" | "hour" | "weekday";
  /** Share of the deviation variance it carries, degrees of freedom corrected
   *  (ω², not η²). Raw η² is ~1 on a day of 24 bins grouped by 24 hours,
   *  because every group is a singleton: it would report a clock pattern from
   *  noise, which is the exact thing this module exists to refuse. */
  explained: number;
  /** The cheapest and dearest group, as a deviation from the overall rate
   *  (a fraction of it). `null` when fewer than two groups are measurable. */
  low: number | null;
  high: number | null;
  groups: number;
};

/** Which of the two clock groupings carried it. Without this a weekend effect
 *  was reported as "some hours", because the verdict knew the grouping had won
 *  and not which one. */
export type ClockWhich = "hour" | "weekday";

export type Verdict =
  | { kind: "unmeasured"; reason: string }
  | { kind: "steady"; hours: number; points: number }
  /** A rate that exists but rests on fewer than `MIN_HOURS` hours: the figures
   *  are real, the steadiness is not sayable. Worded as that, never as "not
   *  measured", which contradicted the numbers drawn above it. */
  | { kind: "few"; hours: number; points: number }
  | {
      kind: "mix" | "clock";
      hours: number;
      points: number;
      which?: ClockWhich;
      /** Cheapest and dearest group as a fraction of the overall rate. */
      low: number;
      high: number;
    }
  | { kind: "confounded"; hours: number; points: number; which: ClockWhich; low: number; high: number }
  | { kind: "mixed"; hours: number; points: number; low: number; high: number };

/** Weekday of an instant, Monday first, **local**. Every other surface on this
 *  wall labels a local calendar (`analytics.ts::bucketOf`, the room's spans),
 *  and the heatmap is drawn as the reader's week: grouping it in UTC would put
 *  the grid eleven hours off in Sydney, which is not a shape anybody recognises
 *  as their week. */
export function weekdayOf(at: number): number {
  return (new Date(at).getDay() + 6) % 7;
}

export function hourOf(at: number): number {
  return new Date(at).getHours();
}

/** The dominant model of an hour: the one with the **largest share**, not "at
 *  least half". A three-model hour at 40/35/25 is still an hour that ran mostly
 *  one thing, and the grouping's job is to put similar hours together. */
export function mixClassOf(b: RateBin): string | null {
  let best: string | null = null;
  let top = 0;
  for (const [model, share] of Object.entries(b.mix)) {
    if (Number.isFinite(share) && share > top) {
      top = share;
      best = model;
    }
  }
  return best;
}

/** One weighted one-way decomposition: the group means, the share of variance
 *  they carry, and how much of that survives a degrees-of-freedom correction.
 *
 *  **ω², not η².** η² rises with the number of groups for free: 24 bins grouped
 *  by 24 hours has η² ≈ 1 on pure noise, so a single afternoon would have been
 *  reported as a clock pattern at full confidence. ω² asks whether the grouping
 *  explains more than the groups themselves cost, and it refuses to answer at
 *  all when there are no spare observations (`n <= k`) rather than pretending
 *  to. Simulated at no real effect, the false-clock rate is 1.00 at one day,
 *  0.35 at a week and 0.00 at four weeks; the correction is what turns the
 *  first two into `steady`. */
function decompose(
  cells: readonly { g: string; w: number; y: number }[],
): { explained: number; means: Map<string, number>; grand: number; n: number; k: number } {
  const by = new Map<string, { w: number; sum: number }>();
  const total = cells.reduce((n, c) => n + c.w, 0);
  const grand = total > 0 ? cells.reduce((n, c) => n + c.w * c.y, 0) / total : 0;
  for (const c of cells) {
    const one = by.get(c.g) ?? { w: 0, sum: 0 };
    one.w += c.w;
    one.sum += c.w * c.y;
    by.set(c.g, one);
  }
  const means = new Map([...by.entries()].map(([g, one]) => [g, one.sum / one.w]));
  const between = [...by.entries()].reduce((n, [, one]) => {
    const dev = one.sum / one.w - grand;
    return n + one.w * dev * dev;
  }, 0);
  const within = cells.reduce((n, c) => {
    const dev = c.y - (means.get(c.g) ?? grand);
    return n + c.w * dev * dev;
  }, 0);
  const raw = between + within > 0 ? between / (between + within) : 0;
  const n = cells.length;
  const k = by.size;
  const explained =
    n > k ? Math.min(1, Math.max(0, 1 - ((1 - raw) * (n - 1)) / (n - k))) : 0;
  return { explained, means, grand, n, k };
}

/** The deviation variance carried by a grouping, weighted by points so an hour
 *  that moved forty points counts for more than one that moved two. */
export function groupingOf(
  used: readonly RateBin[],
  rate: number,
  label: (b: RateBin) => string | null,
  name: Grouping["name"],
): Grouping {
  const cells = used
    .filter(isRated)
    .map((b) => ({ g: label(b), w: b.points, y: b.usd / b.points - rate }))
    .filter((c): c is { g: string; w: number; y: number } => c.g !== null);
  if (cells.length === 0) {
    return { name, explained: 0, low: null, high: null, groups: 0 };
  }
  const { explained, means } = decompose(cells);
  const groups = [...means.values()];
  const rel = groups.map((g) => (rate > 0 ? g / rate : 0));
  return {
    name,
    explained,
    low: rel.length > 0 ? Math.min(...rel) : null,
    high: rel.length > 0 ? Math.max(...rel) : null,
    groups: groups.length,
  };
}

/** How well a grouping of the clock predicts whether an hour was a given
 *  mix class, η² weighted by points. This is the test for *confounding*, and it
 *  is a different question from how much either grouping explains: two effects
 *  that both move the rate are perfectly separable when every hour of the day
 *  contains both classes, and inseparable when the clock *is* the class. */
export function confoundingOf(
  used: readonly RateBin[],
  clockLabel: (b: RateBin) => string | null,
): number {
  const rated = used.filter(isRated);
  const classes = new Map<string, number>();
  for (const b of rated) {
    const c = mixClassOf(b);
    if (c !== null) classes.set(c, (classes.get(c) ?? 0) + b.points);
  }
  let top: string | null = null;
  let most = 0;
  for (const [c, w] of classes) {
    if (w > most) {
      most = w;
      top = c;
    }
  }
  if (top === null) return 0;
  const rows = rated
    .map((b) => ({ g: clockLabel(b), w: b.points, y: mixClassOf(b) === top ? 1 : 0 }))
    .filter((r): r is { g: string; w: number; y: number } => r.g !== null);
  if (rows.length === 0) return 0;
  return decompose(rows).explained;
}

/** Above this, the clock groups *are* the mix classes: the wall runs its models
 *  on a schedule, and no decomposition of one afternoon can tell a price that
 *  depends on the model from one that depends on the hour. */
export const CONFOUNDED_ABOVE = 0.8;

/** Whether the rate holds still, and if it does not, which of the two things
 *  this data can see carries the movement.
 *
 *  The order of the answers is the order of what can be concluded:
 *
 *  - too few trustworthy hours is `unmeasured`, and says how many it has;
 *  - nothing past the floors is `steady`, which is a real answer and the one to
 *    expect when the window is weighted by the price list;
 *  - one grouping carrying the movement is that grouping;
 *  - both carrying a lot, with the clock predicting the class nearly perfectly,
 *    is `confounded`, and nothing here pretends to separate them;
 *  - both carrying a lot over hours that contain both classes is `mixed`: two
 *    effects, reported as two rather than folded into one.
 */
export function verdictOf(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  rate: number | null,
  since: number,
  until: number,
  scope = "",
): Verdict {
  const used = scoped(bins, account, kind, scope, since, until).filter(isRated);
  if (rate === null || rate <= 0) {
    return { kind: "unmeasured", reason: "no hour in this span could be priced" };
  }
  const points = used.reduce((n, b) => n + b.points, 0);
  if (used.length < MIN_HOURS) return { kind: "few", hours: used.length, points };
  const mix = groupingOf(used, rate, mixClassOf, "mix");
  const hour = groupingOf(used, rate, (b) => String(hourOf(b.at)), "hour");
  const weekday = groupingOf(used, rate, (b) => String(weekdayOf(b.at)), "weekday");
  const clock = hour.explained >= weekday.explained ? hour : weekday;
  const which: ClockWhich = clock.name === "weekday" ? "weekday" : "hour";
  const clockOf =
    which === "hour"
      ? (b: RateBin): string => String(hourOf(b.at))
      : (b: RateBin): string => String(weekdayOf(b.at));
  const spreadOf = (g: Grouping): number =>
    g.low === null || g.high === null ? 0 : g.high - g.low;
  const mixStrong = mix.explained >= EXPLAINED_FLOOR && spreadOf(mix) >= SPREAD_FLOOR;
  const clockStrong =
    clock.explained >= EXPLAINED_FLOOR && spreadOf(clock) >= SPREAD_FLOOR;
  /* The two ends of whichever grouping won, in the units the sentences use: a
     fraction of the overall rate, negative below it. `spread` used to be the
     width of the range, and every sentence read it as "X% more than the
     cheapest", which is a different number whenever the rate is not the cheapest
     group's. */
  const ends = (g: Grouping): { low: number; high: number } => ({
    low: g.low ?? 0,
    high: g.high ?? 0,
  });
  if (!mixStrong && !clockStrong) return { kind: "steady", hours: used.length, points };
  if (mixStrong && clockStrong) {
    const low = Math.min(ends(mix).low, ends(clock).low, 0);
    const high = Math.max(ends(mix).high, ends(clock).high, 0);
    return confoundingOf(used, clockOf) >= CONFOUNDED_ABOVE
      ? { kind: "confounded", hours: used.length, points, which, low, high }
      : { kind: "mixed", hours: used.length, points, low, high };
  }
  const winner = mixStrong ? mix : clock;
  return mixStrong
    ? { kind: "mix", hours: used.length, points, ...ends(winner) }
    : { kind: "clock", hours: used.length, points, which, ...ends(winner) };
}

/* ── the week ───────────────────────────────────────────────────────────────*/

export type WeekCell = {
  weekday: number;
  hour: number;
  /** Dollars per point for this hour of the week, or `null` for a cell with no
   *  trustworthy hour in it. Never a filled-in average: the gap is the reading
   *  that stops a heatmap inventing the pattern it is asked about. */
  usdPerPoint: number | null;
  points: number;
  /** How many of the span's weeks contributed to it. Four, over 28 days. */
  weeks: number;
};

/** The rate by hour of the week. `weeks` is how many the span covers, which is
 *  what makes a cell's `weeks` comparable to it. */
export function weekGrid(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  since: number,
  until: number,
  weeks: number,
  scope = "",
): WeekCell[] {
  const cells = new Map<string, { points: number; usd: number; n: number }>();
  for (const b of scoped(bins, account, kind, scope, since, until).filter(isRated)) {
    const key = `${weekdayOf(b.at)}:${hourOf(b.at)}`;
    const one = cells.get(key) ?? { points: 0, usd: 0, n: 0 };
    one.points += b.points;
    one.usd += b.usd;
    one.n += 1;
    cells.set(key, one);
  }
  const out: WeekCell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const one = cells.get(`${weekday}:${hour}`);
      out.push({
        weekday,
        hour,
        usdPerPoint: one && one.points > 0 && one.usd > 0 ? one.usd / one.points : null,
        points: one?.points ?? 0,
        weeks: Math.max(0, Math.min(weeks, one?.n ?? 0)),
      });
    }
  }
  return out;
}

/** Everything a row of the panel needs, from one scoping of the hours. */
export type WindowReading = {
  worth: WindowWorth;
  verdict: Verdict;
  /** The week's shape, for a window that has one. Empty for a provider. */
  grid: WeekCell[];
};

export function readingOf(
  bins: readonly RateBin[],
  account: string,
  kind: string,
  since: number,
  until: number,
  weeks = 4,
  scope = "",
): WindowReading {
  const worth = worthOf(bins, account, kind, since, until, scope);
  return {
    worth,
    verdict: verdictOf(bins, account, kind, worth.usdPerPoint, since, until, scope),
    grid: weekGrid(bins, account, kind, since, until, weeks, scope),
  };
}

/* ── from the two reads to the hours ────────────────────────────────────────*/

type HourMoney = {
  usd: number;
  tokens: number;
  unpriced: number;
  byModel: Map<string, number>;
};

function hourFloor(at: number): number {
  return Math.floor(at / HOUR) * HOUR;
}

function rowTokens(row: UsageRow): number {
  return row.inTok + row.outTok + row.cacheRead + row.write5m + row.write1h;
}

/** Dollars, tokens and the mix, per hour, for one account.
 *
 *  **`prefer_transcript` cannot be applied exactly on this tier**: the rule keys
 *  on `(session, hour)` and `usage_hour` has no session column. The hourly
 *  analogue kept here is coarser and stated: a `turn` row is dropped when any
 *  transcript row stands for the same `(hour, host, account)`. It errs towards
 *  counting nothing twice, which is the direction §7.4 is about, and it is the
 *  rule the turn backfill will owe again if it ever lands (§7.4 is not built). */
function moneyByHour(rows: readonly UsageRow[], account: string): Map<number, HourMoney> {
  const covered = new Set<string>();
  for (const r of rows) {
    if (r.account !== account || r.provenance !== "transcript") continue;
    covered.add(`${hourFloor(atOf(r))}\u0000${r.host}\u0000${r.account}`);
  }
  const out = new Map<number, HourMoney>();
  for (const r of rows) {
    if (r.account !== account) continue;
    const hour = hourFloor(atOf(r));
    if (
      r.provenance !== "transcript" &&
      covered.has(`${hour}\u0000${r.host}\u0000${r.account}`)
    ) {
      continue;
    }
    const one = out.get(hour) ?? { usd: 0, tokens: 0, unpriced: 0, byModel: new Map() };
    const usd = modeledUsd(r);
    if (usd === null) {
      one.unpriced += rowTokens(r);
    } else if (usd > 0) {
      one.usd += usd;
      one.tokens += rowTokens(r);
      one.byModel.set(r.model, (one.byModel.get(r.model) ?? 0) + usd);
    }
    out.set(hour, one);
  }
  return out;
}

/** Points the window moved, per hour, splitting an interval that straddles an
 *  hour boundary by time exactly as `spansOf` splits one at a sample boundary.
 *  The interval's ends are poll instants, so a split is accurate to the poll's
 *  cadence and no better; the bin is an hour, which is coarser than that. */
function pointsByHour(
  samples: readonly AllowanceSample[],
  account: string,
  kind: string,
  scope: string,
): Map<number, number> {
  const mineSamples = samples.filter(
    (s) =>
      s.account === account &&
      s.kind === kind &&
      s.scope === scope &&
      !isSentinel(s.account),
  );
  const out = new Map<number, number>();
  const add = (hour: number, points: number): void => {
    out.set(hour, (out.get(hour) ?? 0) + points);
  };
  for (const one of instancesOf(mineSamples)) {
    for (let i = 1; i < one.points.length; i++) {
      const from = one.points[i - 1].at;
      const to = one.points[i].at;
      const delta = Math.max(0, one.points[i].used - one.points[i - 1].used);
      if (delta <= 0 || to <= from) continue;
      let cursor = from;
      while (cursor < to) {
        const hour = hourFloor(cursor);
        const end = Math.min(to, hour + HOUR);
        add(hour, (delta * (end - cursor)) / (to - from));
        cursor = end;
      }
    }
  }
  return out;
}

/** The hours of one account, joined across the two reads. One bin per hour per
 *  window kind, because a dollar of work advances every window the account has
 *  and the rate is *that window's* points, not a sum of them. */
export function binsOf(
  samples: readonly AllowanceSample[],
  rows: readonly UsageRow[],
  account: string,
): RateBin[] {
  if (isSentinel(account)) return [];
  const money = moneyByHour(rows, account);
  /* Keyed by `(kind, scope)`, not kind: two `weekly_scoped` windows share a
     kind and are two currencies, and keying on the kind alone summed them. */
  const keys = new Set(
    samples
      .filter((s) => s.account === account)
      .map((s) => `${s.kind}\u0000${s.scope ?? ""}`),
  );
  const out: RateBin[] = [];
  for (const key of keys) {
    const [kind, scope] = key.split("\u0000");
    const points = pointsByHour(samples, account, kind, scope);
    for (const [at, moved] of points) {
      const one = money.get(at);
      if (!one || moved <= 0) continue;
      const total = [...one.byModel.values()].reduce((n, v) => n + v, 0);
      const mix: Record<string, number> = {};
      if (total > 0) {
        for (const [model, usd] of one.byModel) mix[model] = usd / total;
      }
      out.push({
        at,
        account,
        kind,
        scope,
        points: moved,
        usd: one.usd,
        tokens: one.tokens,
        mix,
        unpriced: one.unpriced,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
}

/* ── saying it ──────────────────────────────────────────────────────────────*/

/** Things a person says out loud about money, kept short enough for a row. A
 *  figure under a dollar keeps a digit that `money` would round away: one
 *  percent of a five-hour window is often one and a bit cents, and `$0.01` for
 *  0.013 is a 30% error on the number this block exists to give. */
export function smallMoney(usd: number): string {
  if (!(usd > 0)) return "$0";
  if (usd >= 1) return money(usd);
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/** What one percent and a whole window are worth, in the two currencies. A
 *  side that was not measured is absent rather than zero, and the caller draws
 *  the absent case in words (§9.1). */
export function worthSaid(w: WindowWorth): string {
  const parts: string[] = [];
  if (w.tokensPerPoint !== null) parts.push(`${count(w.tokensPerPoint)} tok`);
  if (w.usdPerPoint !== null) parts.push(smallMoney(w.usdPerPoint));
  if (parts.length === 0) return "not measured";
  return `1% ≈ ${parts.join(" ≈ ")}`;
}

/** The whole window, which is the figure Lyss actually asked for: "how many
 *  tokens a claude allowance is equivalent to". Said as `100%` rather than "a
 *  window" because it sits on a line that has already named the window, and
 *  "5-hour · 1% ≈ … · a window ≈ …" says the word twice. */
export function windowSaid(w: WindowWorth): string {
  const parts: string[] = [];
  if (w.wholeTokens !== null) parts.push(`${count(w.wholeTokens)} tok`);
  if (w.wholeUsd !== null) parts.push(money(w.wholeUsd));
  if (parts.length === 0) return "not measured";
  return `100% ≈ ${parts.join(" ≈ ")}`;
}

/** What the rate was measured at, and therefore what it is a rate *of*. A price
 *  without its mix is a constant the reader will carry to a different mix. */
export function mixSaid(w: WindowWorth): string {
  const named = w.mix
    .filter((m) => m.share >= 0.05)
    .map((m) => `${m.model} ${Math.round(m.share * 100)}%`);
  if (named.length === 0) return "";
  const cut = w.mix.filter((m) => m.share < 0.05).length;
  return `measured at ${named.join(", ")}${cut > 0 ? ` and ${cut} more` : ""}`;
}

/** The interval, said as a range rather than as a confidence level nobody asked
 *  about. Empty when there were not two hours to resample, **and empty when the
 *  two ends print the same number**: `$0.016 to $0.016 per point` is an interval
 *  narrower than the text can show, and printing it reads as a bug rather than
 *  as a tight estimate. */
export function bandSaid(w: WindowWorth): string {
  if (w.usdBand === null || w.usdPerPoint === null) return "";
  const [lo, hi] = w.usdBand;
  if (!(hi > lo)) return "";
  const said = `${smallMoney(lo)} to ${smallMoney(hi)} per point`;
  return smallMoney(lo) === smallMoney(hi) ? "" : said;
}

/** The dearest group against the cheapest, as a fraction of the *cheapest*.
 *  `low` and `high` are deviations from the overall rate, so their difference
 *  over the overall rate is the width of the range and not the increase: a
 *  cheapest hour at $0.01 and a dearest at $0.03 have a dearest that is 200%
 *  dearer, while the width over the average reads 100%. */
function overCheapest(low: number, high: number): string {
  const base = 1 + low;
  if (!(base > 0)) return "";
  return `${Math.round(((high - low) / base) * 100)}%`;
}

/** A symmetric reading of the same two ends, for an arm that carries two
 *  effects at once and cannot put one above the other. */
function aroundAverage(low: number, high: number): string {
  return `from ${Math.round(low * 100)}% to +${Math.round(high * 100)}% of the average`;
}

function where(which: ClockWhich | undefined): string {
  return which === "weekday" ? "some days of the week" : "some hours of the day";
}

/** The verdict, in the house voice. Every arm is a claim the data supports, and
 *  the `unmeasured` arm names what would make it measurable rather than
 *  apologising. */
export function verdictSaid(v: Verdict): string {
  switch (v.kind) {
    case "unmeasured":
      return `the rate is not measured yet: ${v.reason}`;
    case "few":
      return `measured from only ${v.hours} hours, which is too few to say whether it holds still`;
    case "steady":
      return `steady over ${v.hours} hours: the spread is what this many points and this mix explain`;
    case "mix":
      return `it moves with what you run: the dearest hours cost about ${overCheapest(v.low, v.high)} more per point than the cheapest`;
    case "clock":
      return `it moves with the clock: ${where(v.which)} cost about ${overCheapest(v.low, v.high)} more per point than others`;
    case "confounded":
      return `it moves, and what you run lines up with the clock here, so nothing in this data separates the two: ${aroundAverage(v.low, v.high)}`;
    case "mixed":
      return `two effects: what you run and the clock each move the rate, ${aroundAverage(v.low, v.high)}`;
  }
}
