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

/** The window the wall is closest to being stopped by, right now.
 *
 *  Across every account and every window kind: the highest reading on an
 *  instance that has not reset. A tie goes to the one that resets soonest,
 *  because that is the one a person is waiting on. An instance past its reset
 *  has been given back and is not binding whatever it last read, which is the
 *  same rule `accounts.ts::keptThrough` keeps for a held reading. */
export function bindingOf(instances: readonly WindowInstance[], now: number): WindowInstance | null {
  /* **Only the newest instance of each window is a reading of it now.** An
     instance closed by a drop stays in the list — its deltas are history and
     the residual needs them — but its last value is not what the account is at
     any more. Without this, a window whose percentage halved on a plan change
     would go on binding at its old figure for the rest of the day. */
  const latest = new Map<string, WindowInstance>();
  for (const one of instances) {
    const key = keyOf(one);
    const held = latest.get(key);
    if (!held || one.from >= held.from) latest.set(key, one);
  }
  let best: WindowInstance | null = null;
  for (const one of latest.values()) {
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
export function costBucketsOf(rows: readonly AllowanceCost[]): CostBucket[] {
  const fine = new Set(
    rows
      .filter((r) => r.provenance === "transcript")
      .map((r) => `${r.session}\u0000${Math.floor(r.at / 3_600_000)}`),
  );
  const kept = rows.filter(
    (r) => r.provenance === "transcript" || !fine.has(`${r.session}\u0000${Math.floor(r.at / 3_600_000)}`),
  );
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

/** The spans of every instance of one window key, with the facts that overlap
 *  each one. A fact bucket straddling a span boundary is split by the fraction
 *  of its width on each side (§5.1) — the bucket has no finer resolution, and a
 *  wider claim would be pretending it does. */
export function spansOf(
  instances: readonly WindowInstance[],
  buckets: readonly CostBucket[],
  account: string,
): DeltaSpan[] {
  const spans: DeltaSpan[] = [];
  const mine = instances.filter((i) => i.account === account);
  for (const one of mine) {
    for (let i = 1; i < one.points.length; i++) {
      const from = one.points[i - 1].at;
      const to = one.points[i].at;
      const delta = Math.max(0, one.points[i].used - one.points[i - 1].used);
      if (to <= from) continue;
      const facts: CostFact[] = [];
      const seen = new Set<string>();
      for (const b of buckets) {
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
