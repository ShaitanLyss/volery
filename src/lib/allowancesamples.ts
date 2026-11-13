/* Allowance samples (§3.3, §5, §11.1): the points an allowance window was read
 * at, the curve between them, and what the delta can be attributed to.
 *
 * **A sample is a point, not an interval.** The curve between two samples is a
 * step, not a line: `used[i]` holds from `at[i]` until `at[i+1]`, because only
 * the endpoints are known (§5.1). A straight line would invent a rate for the
 * interval.
 *
 * A window is monotonic inside its own reset, which is the whole of what makes
 * this arithmetic worth anything: the last sample minus the first of an
 * instance is what the account actually spent, whatever caused it. A drop, or a
 * `resets_at` that moved, closes the instance and opens the next; nothing is
 * carried across.
 *
 * Pure and directly tested. The attribution arithmetic itself is
 * `analytics.ts::residualOf`; this file only builds its input from samples and
 * fact buckets, so there is one definition of "what counts towards a delta".
 */

import {
  attribute,
  attributedCost,
  isSentinel,
  modeledUsd,
  residualOf,
  type CostFact,
  type DeltaSpan,
  type Fact,
  type ResidualReading,
} from "./analytics";

/** `usage_fact`'s grain (§3.1), which is also what a fact's `at` means: the
 *  beginning of the five-minute bucket a request landed in. A span that starts
 *  or ends inside a bucket splits it by the fraction of its width on each side,
 *  because a bucket has no finer resolution than that (§5.1). */
export const FINE_BUCKET_MS = 5 * 60 * 1000;

/** Two reads of one window that differ in `resets_at` only by a little are one
 *  instance: the probes show a stable stamp, so this is a guard rather than a
 *  measured wobble (§5.1). */
const RESET_TOLERANCE_MS = 1_000;

/* ── what the command answers ────────────────────────────────────────────── */

/** One `allowance_fact` row. `used` is a percentage 0 to 100 in the source's
 *  own unit; `source` is `poll`, `stream` or `peer`. */
export type AllowanceSample = {
  at: number;
  host: string;
  account: string;
  kind: string;
  scope: string;
  used: number;
  resetsAt: number | null;
  severity: string;
  plan: string | null;
  source: "poll" | "stream" | "peer";
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function asAllowanceSamples(raw: unknown): AllowanceSample[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowanceSample[] = [];
  for (const one of raw) {
    const r = obj(one);
    if (!r) continue;
    const at = num(r.at);
    const used = num(r.used);
    const account = str(r.account);
    const kind = str(r.kind);
    if (!(at > 0) || !account || !kind || !Number.isFinite(used)) continue;
    const source = r.source === "stream" || r.source === "peer" ? r.source : "poll";
    const resets = r.resetsAt;
    out.push({
      at,
      host: str(r.host),
      account,
      kind,
      scope: str(r.scope),
      used: Math.min(100, Math.max(0, used)),
      resetsAt: typeof resets === "number" && Number.isFinite(resets) && resets > 0 ? resets : null,
      severity: str(r.severity) || "normal",
      plan: typeof r.plan === "string" && r.plan ? r.plan : null,
      source,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ── the writer's half ───────────────────────────────────────────────────── */

/** The rows one reading of one account is noted as — one per window.
 *
 *  `source` is which door the reading came through: a `rate_limit_event` off a
 *  card's own stream, the poll the waterfall already makes, or a reading
 *  another wall took and this one reused. A report whose `source` says *read on
 *  <host>* came from a peer (§5.4). */
export function samplesOf(
  label: string,
  report: { windows: readonly { kind: string; scope: string | null; used: number; resetsAt: number | null; severity: string }[]; at: number; plan?: string | null; source?: string },
  source?: AllowanceSample["source"],
): AllowanceSample[] {
  const readOn = report.source && report.source.startsWith("read on ");
  const from: AllowanceSample["source"] = source ?? (readOn ? "peer" : "poll");
  /* **A peer's reading keeps the name of the wall that took it.** The row's
     `host` is what makes a residual *partial* when that wall sent no facts; a
     row stamped with this wall's name would claim a completeness the reading
     does not have. */
  const peerHost = readOn ? report.source!.slice("read on ".length).trim() : "";
  return report.windows.map((w) => ({
    at: report.at,
    host: from === "peer" ? peerHost : "",
    account: label,
    kind: w.kind,
    scope: w.scope ?? "",
    used: Math.min(100, Math.max(0, w.used)),
    resetsAt: w.resetsAt && w.resetsAt > 0 ? w.resetsAt : null,
    severity: w.severity || "normal",
    plan: report.plan ?? null,
    source: from,
  }));
}

/* ── the curve ───────────────────────────────────────────────────────────── */

/** One instance of one window: the samples between a reset and the next. */
export type WindowInstance = {
  account: string;
  kind: string;
  scope: string;
  resetsAt: number | null;
  from: number;
  to: number;
  /** `used` at the first and last sample. */
  first: number;
  last: number;
  /** The sum of the positive steps. A roll never contributes one. */
  delta: number;
  /** The step curve itself, for a sparkline: each sample's instant and value. */
  points: { at: number; used: number }[];
  /** Every host that sampled this instance, not only the ones with facts: a
   *  host that sampled and sent none is the only thing that can make the
   *  residual read *partial* (§5.3). */
  hosts: string[];
};

function keyOf(s: { account: string; kind: string; scope: string }): string {
  return `${s.account}\u0000${s.kind}\u0000${s.scope}`;
}

function sameReset(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= RESET_TOLERANCE_MS;
}

/** Every window instance the samples describe, oldest first.
 *
 *  **A negative step or a moved reset closes the instance.** The next sample
 *  opens a new one, and the delta starts again from its own first reading:
 *  nothing is carried across a roll. A sample naming no reset is one instance
 *  for its window: it contributes no delta and is never carried across a sample
 *  with a real reset. */
export function instancesOf(samples: readonly AllowanceSample[]): WindowInstance[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const out: WindowInstance[] = [];
  let open = new Map<string, WindowInstance>();
  for (const s of sorted) {
    const key = keyOf(s);
    const current = open.get(key);
    const rolled =
      current !== undefined &&
      (s.used < current.last || !sameReset(s.resetsAt, current.resetsAt));
    if (rolled) open.delete(key);
    let one = open.get(key);
    if (!one) {
      one = {
        account: s.account,
        kind: s.kind,
        scope: s.scope,
        resetsAt: s.resetsAt,
        from: s.at,
        to: s.at,
        first: s.used,
        last: s.used,
        delta: 0,
        points: [{ at: s.at, used: s.used }],
        hosts: s.host ? [s.host] : [],
      };
      open.set(key, one);
      out.push(one);
      continue;
    }
    one.delta += Math.max(0, s.used - one.last);
    one.last = s.used;
    one.to = s.at;
    one.points.push({ at: s.at, used: s.used });
    if (s.host && !one.hosts.includes(s.host)) one.hosts.push(s.host);
  }
  return out.sort((a, b) => a.from - b.from || a.account.localeCompare(b.account) || a.kind.localeCompare(b.kind));
}

/** The newest instance of every window: what each one is at *now*.
 *
 *  `instancesOf` keeps every instance ever sampled, because a closed one's
 *  deltas are history the residual needs. That is the wrong list for any
 *  question about the present, and the two that ask differ in scope:
 *  `bindingOf` wants the one window closest to a stop, and `ownPoints` wants a
 *  figure per window kind. Both need the same filter, so it is one function.
 *
 *  **Summing across instances is right for a day and wrong for a cap.** Four
 *  five-hour windows in a day add up the way a day's percentage does (§21.2),
 *  but a cap on a five-hour window is a ceiling on *that window*, and a share
 *  summed over four of them is four times the scale of the reading it is
 *  compared against. This is the list that keeps the two apart. */
export function currentOnly(instances: readonly WindowInstance[]): WindowInstance[] {
  const latest = new Map<string, WindowInstance>();
  for (const one of instances) {
    const key = keyOf(one);
    const held = latest.get(key);
    if (held === undefined || one.to > held.to) latest.set(key, one);
  }
  return [...latest.values()].sort(
    (a, b) => a.account.localeCompare(b.account) || a.kind.localeCompare(b.kind),
  );
}

/** The window the wall is closest to being stopped by, right now.
 *
 *  Across every account and every window kind: the highest reading on an
 *  instance that has not reset. A tie goes to the one that resets soonest,
 *  because that is the one a person is waiting on. An instance past its reset
 *  has been given back and is not binding whatever it last read, which is the
 *  same rule `accounts.ts::keptThrough` keeps for a held reading. */
export function bindingOf(instances: readonly WindowInstance[], now: number): WindowInstance | null {
  let best: WindowInstance | null = null;
  for (const one of currentOnly(instances)) {
    if (one.resetsAt !== null && one.resetsAt <= now) continue;
    if (!best) {
      best = one;
      continue;
    }
    if (one.last > best.last) best = one;
    else if (one.last === best.last) {
      const their = best.resetsAt ?? Number.POSITIVE_INFINITY;
      const ours = one.resetsAt ?? Number.POSITIVE_INFINITY;
      if (ours < their) best = one;
    }
  }
  return best;
}

/* ── the delta, and what explains it ─────────────────────────────────────── */

/** One fact bucket's cost, as the attribution needs it. `at` is the bucket's
 *  start; its width is `FINE_BUCKET_MS`. */
export type CostBucket = { at: number; host: string; account: string; cost: number };

/** One five-minute bucket's tokens, as `allowance_costs` answers them. */
export type AllowanceCost = {
  at: number;
  host: string;
  session: string;
  account: string;
  provider: string;
  model: string;
  provenance: string;
  /** The card that spent it, or empty for a session this wall did not open. */
  card: string;
  inTok: number;
  outTok: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  requests: number;
};

export function asAllowanceCosts(raw: unknown): AllowanceCost[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowanceCost[] = [];
  for (const one of raw) {
    const r = obj(one);
    if (!r) continue;
    const at = num(r.at);
    const account = str(r.account);
    const model = str(r.model);
    if (!(at > 0) || !account || !model) continue;
    out.push({
      at,
      host: str(r.host),
      session: str(r.session),
      account,
      provider: str(r.provider),
      model,
      provenance: str(r.provenance) === "turn" ? "turn" : "transcript",
      card: str(r.card),
      inTok: num(r.inTok) || 0,
      outTok: num(r.outTok) || 0,
      cacheRead: num(r.cacheRead) || 0,
      write5m: num(r.write5m) || 0,
      write1h: num(r.write1h) || 0,
      requests: num(r.requests) || 0,
    });
  }
  return out;
}

/** The rows priced and folded to `(bucket, host, account)`.
 *
 *  **`prefer_transcript`, applied here because the read carries what it needs to
 *  apply it**: a backfilled turn day and the transcript facts over the same
 *  hour must not be added twice (§7.4), and the finer source wins. The rule is
 *  `spend.rs::prefer_transcript`'s, per `(session, hour)`.
 *
 *  A row the price table cannot place contributes no cost. Its tokens are real
 *  and unknown in dollars, so they stay out of the denominator rather than
 *  being counted at zero, which would make an unknown model look free and the
 *  residual smaller than it is. */
/** **The rows a money reading may count.** A transcript and a backfilled `turn`
 *  row can describe the same session-hour, and the finer source wins: counting
 *  both is the double-count §7.4 exists to prevent. Exported because the
 *  per-class mix needs the same decision, and two copies of it would disagree
 *  about a day's total by the overlap. */
export function preferredCostRows(rows: readonly AllowanceCost[]): AllowanceCost[] {
  const fine = new Set(
    rows
      .filter((r) => r.provenance === "transcript")
      .map((r) => `${r.session}\u0000${Math.floor(r.at / 3_600_000)}`),
  );
  return rows.filter(
    (r) => r.provenance === "transcript" || !fine.has(`${r.session}\u0000${Math.floor(r.at / 3_600_000)}`),
  );
}

export function costBucketsOf(rows: readonly AllowanceCost[]): CostBucket[] {
  const kept = preferredCostRows(rows);
  const merged = new Map<string, CostBucket>();
  for (const r of kept) {
    const fact: Fact = {
      at: r.at,
      host: r.host,
      session: r.session,
      agent: "",
      parentAgent: "",
      depth: 0,
      model: r.model,
      effort: "",
      cli: "",
      source: "",
      account: r.account,
      accountIdentity: "",
      provider: r.provider,
      project: "",
      provenance: r.provenance === "turn" ? "turn" : "transcript",
      inTok: r.inTok,
      outTok: r.outTok,
      cacheRead: r.cacheRead,
      write5m: r.write5m,
      write1h: r.write1h,
      requests: r.requests,
      usdReported: 0,
    };
    const cost = modeledUsd(fact);
    if (cost === null || !(cost > 0)) continue;
    const key = `${r.at}\u0000${r.host}\u0000${r.account}`;
    const one = merged.get(key) ?? { at: r.at, host: r.host, account: r.account, cost: 0 };
    one.cost += cost;
    merged.set(key, one);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at);
}

/** The first index whose bucket ends after `at`, on a list sorted by `at`. */
function firstEndingAfter(buckets: readonly CostBucket[], at: number): number {
  let lo = 0;
  let hi = buckets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid].at + FINE_BUCKET_MS <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The spans of every instance of one window key, with the facts that overlap
 *  each one. A fact bucket straddling a span boundary is split by the fraction
 *  of its width on each side (§5.1) — the bucket has no finer resolution, and a
 *  wider claim would be pretending it does.
 *
 *  **The buckets are sorted and walked from where each span begins.** A week of
 *  five-minute buckets is a few thousand rows and a window's samples are a few
 *  hundred intervals, so scanning the whole list per interval was a product
 *  nobody chose: measured at 20ms to 60ms per call on eight days of a real
 *  wall, and this is called once per window kind per account on a fold that is
 *  redrawn while the room is open (§22.5). */
export function spansOf(
  instances: readonly WindowInstance[],
  buckets: readonly CostBucket[],
  account: string,
  /** The caller has already sorted them. `ownPoints` walks one account's kinds
   *  in a loop and sorts once for all of them, where this is called per kind —
   *  and the list can be the full `ALLOWANCE_COST_CAP` of fifty thousand rows,
   *  copied and sorted for each. */
  ordered = false,
): DeltaSpan[] {
  const spans: DeltaSpan[] = [];
  const mine = instances.filter((i) => i.account === account);
  const sorted = ordered ? buckets : [...buckets].sort((a, b) => a.at - b.at);
  for (const one of mine) {
    for (let i = 1; i < one.points.length; i++) {
      const from = one.points[i - 1].at;
      const to = one.points[i].at;
      const delta = Math.max(0, one.points[i].used - one.points[i - 1].used);
      if (to <= from) continue;
      const facts: CostFact[] = [];
      const seen = new Set<string>();
      for (let j = firstEndingAfter(sorted, from); j < sorted.length; j++) {
        const b = sorted[j];
        if (b.at >= to) break;
        const end = b.at + FINE_BUCKET_MS;
        const overlap = Math.min(to, end) - Math.max(from, b.at);
        if (overlap <= 0) continue;
        const share = overlap / FINE_BUCKET_MS;
        const id = `${b.at}\u0000${b.host}\u0000${b.account}`;
        if (seen.has(id)) continue;
        seen.add(id);
        facts.push({ account: b.account, host: b.host, cost: b.cost * share });
      }
      spans.push({ delta, facts });
    }
  }
  return spans;
}

export type AllowanceResidual = {
  /** The window kind this reading is over. **One at a time**: the five-hour
   *  and the week are not additive (§5.5), so summing them would give a figure
   *  in no unit at all. */
  kind: string;
  /** Every account's delta, summed. Subscription accounts only: a provider
   *  sentinel has no subscription residual to be partial about. */
  delta: number;
  attributed: number;
  residual: number;
  /** `partial` when any account's reading could not be completed: a host that
   *  sampled the account and sent no facts. */
  coverage: "full" | "partial";
  /** The accounts this reading is over, in the order the samples named them. */
  accounts: string[];
  readings: ResidualReading[];
};

/** One window kind's residual over every subscription account that has a
 *  sample of it (§5.3). The week is the default because that is the reading
 *  the strip draws ("unattributed points this week"); a caller that wanted the
 *  five-hour window calls it again with `"session"`, never adds the two.
 *
 *  The per-account reading is `analytics.ts::residualOf`'s; this only gathers
 *  the accounts of one kind and states the coverage that the smallest one had. */
/** The dollars behind one account's window movement, for the exchange rate.
 *
 *  `delta` is the points the window moved and `cost` the modelled cost of the
 *  facts that carried them, through the same predicate `attribute` uses. Null
 *  when the window did not move: an exchange rate over an empty denominator is
 *  not a cheap rate, it is no rate, and a caller must draw a dash rather than a
 *  number it invented.
 *
 *  Call it once per window kind, like `allowanceResidual`: the five-hour and the
 *  weekly are different currencies and are never summed. */
export function attributedCostOf(
  instances: readonly WindowInstance[],
  buckets: readonly CostBucket[],
  account: string,
  kind: string,
  /** Two `weekly_scoped` windows can share a kind and differ only here, so a
   *  caller that names one must name its scope too or it will sum two windows'
   *  spans and count the overlapping buckets twice. */
  scope = "",
): { delta: number; cost: number } | null {
  if (isSentinel(account)) return null;
  const mine = instances.filter(
    (i) => i.account === account && i.kind === kind && i.scope === scope,
  );
  if (mine.length === 0) return null;
  let delta = 0;
  let cost = 0;
  for (const span of spansOf(mine, buckets, account)) {
    const d = Number.isFinite(span.delta) && span.delta > 0 ? span.delta : 0;
    delta += d;
    cost += attributedCost(d, span.facts, account);
  }
  return delta > 0 ? { delta, cost } : null;
}

export function allowanceResidual(
  instances: readonly WindowInstance[],
  buckets: readonly CostBucket[],
  kind = "weekly_all",
): AllowanceResidual {
  const ofKind = instances.filter((i) => i.kind === kind);
  const accounts: string[] = [];
  for (const one of ofKind) {
    if (isSentinel(one.account)) continue;
    if (!accounts.includes(one.account)) accounts.push(one.account);
  }
  const readings: ResidualReading[] = [];
  for (const account of accounts) {
    const mine = ofKind.filter((i) => i.account === account);
    const sampled = [...new Set(mine.flatMap((i) => i.hosts))].filter((h) => h !== "");
    readings.push(residualOf({ account, spans: spansOf(mine, buckets, account), sampled }));
  }
  let delta = 0;
  let attributed = 0;
  let residual = 0;
  let partial = false;
  for (const r of readings) {
    delta += r.delta;
    attributed += r.attributed;
    residual += r.residual;
    if (r.coverage === "partial") partial = true;
  }
  return {
    kind,
    delta,
    attributed,
    residual,
    coverage: partial ? "partial" : "full",
    accounts,
    readings,
  };
}

/* ── today against yesterday ─────────────────────────────────────────────── */

/** Modeled cost per local day, from fact buckets.
 *
 *  `today` is always *so far* — the day is not over — and the face says so.
 *  `yesterday` is `null` when the reader's window does not reach back to its
 *  midnight, because a partial yesterday drawn as a whole day would make today
 *  look calm against a figure that is missing most of a day.
 *
 *  **Both midnights are arguments, and yesterday's is not `today - 24h`.** The
 *  local calendar gives a DST day 23 or 25 hours, so subtracting a fixed day
 *  from today's midnight puts an hour of the wrong day in the figure twice a
 *  year. The caller has the timezone (`usage.ts::dayStart`); this function
 *  does not. */
export function daySpend(
  buckets: readonly CostBucket[],
  now: number,
  todayFrom: number,
  yesterdayFrom: number,
  coveredFrom: number,
): { today: number; yesterday: number | null } {
  let today = 0;
  let yesterday = 0;
  for (const b of buckets) {
    if (!(b.cost > 0)) continue;
    if (b.at >= todayFrom && b.at < now) today += b.cost;
    else if (b.at >= yesterdayFrom && b.at < todayFrom) yesterday += b.cost;
  }
  return { today, yesterday: coveredFrom <= yesterdayFrom ? yesterday : null };
}

/* ── one card's share of a window (§11.10, §21.1) ──────────────────────────*/

/** A card's share of an account's window, as a fraction of how far that window
 *  moved.
 *
 *  **This is a share of the movement, not a percentage of the plan.** A window
 *  that moved 68% and a card that carried half its cost gives 34 points, and
 *  34% of the plan. It is derived by the same rule the accounts' split uses
 *  (`analytics.ts::attribute`), applied one level finer: each sample interval's
 *  delta divided among the cards whose facts overlap it, by modeled cost. */
export type CardAllowance = {
  account: string;
  /** `session` or `weekly_all`: §5.5 keeps them apart and so does this. */
  kind: string;
  /** Points of movement this card's facts carried, over the windows it worked
   *  in. Summed across instances of the same kind, so four five-hour windows in
   *  a day add up the way a day's percentage does (§21.2). */
  points: number;
  /** How far those same windows moved while the card existed. */
  moved: number;
  /** `points / moved`, or null when they moved nothing: a share of no movement
   *  is not 0%. */
  share: number | null;
  /** Points that moved in intervals where this account had **no priced fact at
   *  all**, from any card. They are not the card's and not zero either: the
   *  window moved and nothing here can say what carried it. */
  blind: number;
};

/** What one card carried, per account and window kind.
 *
 *  `from`/`to` bound the reading, usually the card's own life. A card whose
 *  session row is missing from the cost read (a terminal, an adopted session)
 *  simply has no rows and returns nothing, rather than being counted as zero
 *  against a window it did work in. */
export function cardAllowance(
  card: string,
  instances: readonly WindowInstance[],
  costs: readonly AllowanceCost[],
  from: number,
  to: number,
): CardAllowance[] {
  if (!card || !(to > from)) return [];
  /* One bucket per (at, host, account, card), priced exactly as the residual
     prices its own. */
  const buckets: { at: number; host: string; account: string; card: string; cost: number }[] = [];
  const merged = new Map<string, { at: number; host: string; account: string; card: string; cost: number }>();
  for (const r of preferredCostRows(costs)) {
    const at = r.at;
    if (at >= to || at + FINE_BUCKET_MS <= from) continue;
    const cost = modeledUsd({
      at,
      host: r.host,
      session: r.session,
      agent: "",
      parentAgent: "",
      depth: 0,
      model: r.model,
      effort: "",
      cli: "",
      source: "",
      account: r.account,
      accountIdentity: "",
      provider: r.provider,
      project: "",
      provenance: r.provenance === "turn" ? "turn" : "transcript",
      inTok: r.inTok,
      outTok: r.outTok,
      cacheRead: r.cacheRead,
      write5m: r.write5m,
      write1h: r.write1h,
      requests: r.requests,
      usdReported: 0,
    });
    if (cost === null || !(cost > 0)) continue;
    const key = `${at}\u0000${r.host}\u0000${r.account}\u0000${r.card}`;
    const one = merged.get(key) ?? { at, host: r.host, account: r.account, card: r.card, cost: 0 };
    one.cost += cost;
    merged.set(key, one);
  }
  buckets.push(...[...merged.values()].sort((a, b) => a.at - b.at));
  if (buckets.length === 0) return [];
  const accounts = [...new Set(buckets.filter((b) => b.card === card).map((b) => b.account))];
  const out = new Map<string, CardAllowance>();
  for (const account of accounts) {
    const mine = buckets.filter((b) => b.account === account);
    for (const one of instances) {
      if (one.account !== account || isSentinel(one.account)) continue;
      for (let i = 1; i < one.points.length; i++) {
        const a = one.points[i - 1];
        const b = one.points[i];
        const span = a.at < from ? from : a.at;
        const end = b.at > to ? to : b.at;
        if (end <= span) continue;
        const delta = Math.max(0, b.used - a.used) * ((end - span) / (b.at - a.at));
        if (!(delta > 0)) continue;
        const key = `${account}\u0000${one.kind}`;
        const row =
          out.get(key) ??
          { account, kind: one.kind, points: 0, moved: 0, share: null, blind: 0 };
        let total = 0;
        let ours = 0;
        for (const bucket of mine) {
          if (bucket.at >= end) break;
          const overlap = Math.min(end, bucket.at + FINE_BUCKET_MS) - Math.max(span, bucket.at);
          if (overlap <= 0) continue;
          const priced = bucket.cost * (overlap / FINE_BUCKET_MS);
          total += priced;
          if (bucket.card === card) ours += priced;
        }
        row.moved += delta;
        if (total <= 0) row.blind += delta;
        else row.points += delta * (ours / total);
        out.set(key, row);
      }
    }
  }
  return [...out.values()]
    .map((r) => ({ ...r, share: r.moved > 0 ? r.points / r.moved : null }))
    .sort((a, b) => b.points - a.points);
}

/* ── what this wall's own work explains (§5.3, §21.1) ──────────────────────*/

/** The points of an account's window movement that **this wall's own facts
 *  explain**, per account and window kind.
 *
 *  It is `residualOf`'s `attributed` half, read per window kind, and it is the
 *  number a cap is measured against when the account is shared with somebody
 *  who is not on the flyway: their usage moves the same counter, and a ceiling
 *  meant for *your* share must not count it.
 *
 *  **It is an upper bound, and saying so is the honest reading of it.** The
 *  attribution divides an interval's movement among the facts under it, and the
 *  denominator is only ever facts this wall can see — a co-worker's requests
 *  leave no row here. So an interval where this wall worked is credited to it
 *  whole, and an interval where it did nothing is credited to it not at all.
 *  Two people working in the same five minutes therefore both count that five
 *  minutes, and the figure over-counts by however much they overlapped. The
 *  alternative — the account's own percentage — is a strictly larger bound that
 *  is wrong on every interval, and this is wrong only on the shared ones.
 *  `residualOf`'s unused movement is the measure of how much of the account
 *  this wall cannot explain at all.
 *
 *  **A per-wall figure, not a fleet one.** `allowance_costs` reads
 *  `usage_fact`, which only the local ingest writes — the samples sync, the
 *  facts do not — so two walls on one subscription each enforce the ceiling on
 *  their own work and the pair can approach twice it. Said in
 *  `.claude/rules/accounts.md` rather than left for somebody to discover from a
 *  bill.
 *
 *  `moved` is the movement the same intervals carried, so a reading can say
 *  "34 of 50" against the cap and "of 62 moved" against the account. */
export type OwnPoints = {
  account: string;
  kind: string;
  /** Points the wall's own facts explain. */
  points: number;
  /** Points the account moved while it was watching, across those intervals. */
  moved: number;
  /** Modeled dollars under those intervals. **This is what makes `points` a
   *  reading rather than a hole**: with nothing priced there is nothing to
   *  divide the movement among, so `points` is zero for a reason that says
   *  nothing about how much of the window was yours. `accounts.ts::SelfUse`
   *  is the same fact one layer out, where the cap reads it. */
  priced: number;
  /** **Did this wall make a request in this window at all**, priced or not.
   *
   *  Filled by the reader (`ownshare.svelte.ts`), which still holds the raw
   *  rows, because this fold is handed only the ones the price table could
   *  place. It is the difference between *nothing to report* and *cannot
   *  report*, and without it a wall that slept through the opening of a window
   *  would be held on somebody else's usage for the first prompt of it: no
   *  facts means `priced` is zero, and zero priced reads as unknown.
   *
   *  Absent is read as unknown, which is the older behaviour, so a caller
   *  assembling these by hand gets what it got before. */
  worked?: boolean;
};

/** **This wall's own share**, per account and kind, over the samples it holds.
 *
 *  Only an account with a subscription has a window, so a provider sentinel
 *  contributes nothing here. A window that moved with no priced fact under it
 *  contributes to `moved` and not to `points`, which is exactly the asymmetry
 *  the residual names.
 *
 *  **A scoped window is left out**, and that is a refusal rather than an
 *  omission. `caps` keys on a window *kind*, so one ceiling is compared against
 *  every scoped window of that kind at once; two of them (a model-scoped week
 *  and another) would each credit the same cost buckets and the sum would be
 *  counted once per scope over the same intervals. `attributedCostOf` already
 *  warns about exactly this. With no share for a scoped kind the cap falls back
 *  to the account's own percentage, which is the behaviour it had before any of
 *  this, and which is honest about what it can see. */
export function ownPoints(
  instances: readonly WindowInstance[],
  costs: readonly CostBucket[],
): OwnPoints[] {
  const kinds = new Map<string, { account: string; kind: string }>();
  for (const one of instances) {
    if (isSentinel(one.account) || one.scope !== "") continue;
    kinds.set(`${one.account}\u0000${one.kind}`, { account: one.account, kind: one.kind });
  }
  /* Sorted once for every account and kind rather than once per pair: this is
     the expensive half of the fold, and it runs on the main thread each pass. */
  const ordered = [...costs].sort((a, b) => a.at - b.at);
  const out: OwnPoints[] = [];
  for (const { account, kind } of kinds.values()) {
    const mine = instances.filter(
      (i) => i.account === account && i.kind === kind && i.scope === "",
    );
    const spans = spansOf(mine, ordered, account, true);
    let points = 0;
    let moved = 0;
    let priced = 0;
    for (const span of spans) {
      moved += span.delta;
      points += attribute(span.delta, span.facts, account).attributed;
      priced += attributedCost(span.delta, span.facts, account);
    }
    out.push({ account, kind, points, moved, priced });
  }
  return out.sort((a, b) => b.moved - a.moved || a.account.localeCompare(b.account) || a.kind.localeCompare(b.kind));
}

/** One share, with the reading it is a share of. What the reader keeps and what
 *  the door is told. */
export type OwnUse = OwnPoints & {
  /** The account's own percentage at the sample this was measured over. */
  used: number;
  /** When that window rolls, so a note about one that has already rolled can be
   *  recognised rather than enforced. */
  resetsAt: number | null;
};

/** **The fold the cap reads, whole.** `ownPoints` over the *current* instance of
 *  each window, with the two facts that need the rows `ownPoints` is never
 *  handed: whether this wall worked in the window at all (priced or not), and
 *  the reading the share is a share of.
 *
 *  Pure, and here rather than beside the reader for the reason every fold in
 *  this codebase is: a `.svelte.ts` cannot be imported by a bun test, and the
 *  difference between "spent nothing" and "could not price what it spent" is
 *  exactly the kind of thing that has to be asserted. */
export function ownUses(
  samples: readonly AllowanceSample[],
  costs: readonly AllowanceCost[],
): OwnUse[] {
  const current = currentOnly(instancesOf(samples));
  const rows = ownPoints(current, costBucketsOf(costs));
  const out: OwnUse[] = [];
  for (const row of rows) {
    const one = current.find(
      (i) => i.account === row.account && i.kind === row.kind && i.scope === "",
    );
    if (!one) continue;
    out.push({
      ...row,
      /* **Buckets that overlap the window, not only ones that start inside
         it.** `spansOf` credits any bucket whose five-minute width overlaps
         the first interval, so one beginning a minute before the window is
         part of the share — and a flag taken only over buckets that start
         inside would then say this wall did nothing about a window it
         demonstrably moved. */
      worked: costs.some(
        (c) =>
          c.account === row.account &&
          c.at < one.to &&
          c.at + FINE_BUCKET_MS > one.from &&
          (c.requests > 0 || c.inTok + c.outTok + c.cacheRead + c.write5m + c.write1h > 0),
      ),
      used: one.last,
      resetsAt: one.resetsAt,
    });
  }
  return out;
}

/** The same figure summed over every wall that has said one, this wall's
 *  included. A wall not heard from contributes nothing, so the sum says
 *  whether it is complete rather than pretending it is (§15). */
export function ownTotal(
  mine: readonly Pick<OwnPoints, "points" | "moved">[],
  theirs: readonly Pick<OwnPoints, "points" | "moved">[],
): { points: number; moved: number; partial: boolean } {
  let points = 0;
  let moved = 0;
  for (const one of mine) {
    points += one.points;
    moved += one.moved;
  }
  for (const one of theirs) {
    points += one.points;
    moved += one.moved;
  }
  /* Partial when this wall's own reading is missing for anything it holds a
     window for: a sample with no facts under it is the residual's hole and the
     cap's blind spot alike. */
  const partial = mine.some((one) => one.moved > 0 && one.points === 0);
  return { points, moved, partial };
}
