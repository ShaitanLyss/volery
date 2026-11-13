/* One day's spend, read in every currency it has, and split by what paid for it.
 *
 * The wall records money in three units that answer different questions about
 * the same work:
 *
 * - **tokens**, which say how much was processed and nothing about how hard;
 * - **api-credit worth**, the figure the CLI reports per turn, or the rate
 *   table's price where a provider's CLI reports zero (providers.md), which is
 *   what the tokens would have cost at API prices;
 * - **percentage points of one account's allowance window**, which is the only
 *   unit that says "am I about to be stopped", and exists only for a
 *   subscription account.
 *
 * They are interchangeable only along known edges (docs/ANALYTICS.md §21).
 * Tokens become dollars through the rate table, per fact, at the fact's own
 * instant. Dollars become points through *attribution*: the modelled cost of
 * the facts inside a window, over the points the window moved, for that account
 * and that kind. Nothing sums a five-hour window and a weekly one, and nothing
 * sums two accounts' percentages, because a point on one plan is not a point on
 * another. The one figure that adds across fundings is api-credit worth.
 *
 * **A day can be more than 100% of a five-hour window**, and that is not an
 * error: five hours refill four times a day, so a day holding 1.58 windows'
 * worth of work is ordinary. The percentage is therefore summed over every
 * instance of that kind that the day overlaps, split by time at the edges. A
 * single instance still pins at 100%; it is the day that exceeds it.
 *
 * Pure. The room's strip and the title bar's figure both read it.
 */

import { isSentinel } from "./analytics";
import { CREDITS } from "./credits";
import {
  attributedCostOf,
  preferredCostRows,
  type AllowanceCost,
  type CostBucket,
  type WindowInstance,
} from "./allowancesamples";
import { CACHE_READ, WRITE_1H, WRITE_5M, rateAt } from "./usage";

/** Where a turn's money came from.
 *
 * - `plan`: a subscription, by its account label. The only kind with allowance
 *   windows, and therefore the only one that can be read as a percentage.
 * - `credits`: Anthropic API credits (`@credits`), billed per token.
 * - `provider`: another provider's balance (`@deepseek`), billed per token at
 *   that provider's rates, which `usage.ts::priceOf` wrote onto the turn. */
export type FundingKind = "plan" | "credits" | "provider";

/** A funding, as one row of the day's breakdown. */
export type FundingRow = {
  label: string;
  kind: FundingKind;
  usd: number;
  tokens: number;
  turns: number;
};

/** One grouped row, as `spend_fundings` answers it. `kind` is derived here
 *  rather than sent, so the label is the only vocabulary the wire carries and
 *  the server cannot disagree with `fundingOf` about what `@credits` is. */
export function asFundingRow(raw: unknown): FundingRow | null {
  const r = obj(raw);
  if (!r) return null;
  const label = str(r.label).trim();
  /* Absent is zero (an older server that sent fewer fields); present and
     impossible is a refusal, because a negative dollar drawn into a breakdown
     is a figure somebody would act on. */
  const usd = Number(r.usd ?? 0);
  const tokens = Number(r.tokens ?? 0);
  const turns = Number(r.turns ?? 0);
  if (!Number.isFinite(usd) || usd < 0) return null;
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  if (!Number.isFinite(turns) || turns < 0) return null;
  return { label, kind: fundingOf(label), usd, tokens, turns };
}

/** What kind of money a label names.
 *
 *  `@credits` is Anthropic's own credits; any other `@`-prefixed label is a
 *  provider sentinel (`providers.ts`). Everything else is a subscription,
 *  including `""`, which is the CLI's own sign-in and is still a plan. */
export function fundingOf(label: string): FundingKind {
  if (label === CREDITS) return "credits";
  if (isSentinel(label)) return "provider";
  return "plan";
}

/** Allowance points one window kind consumed inside `[from, to)`.
 *
 *  One entry per `(account, kind)`, and the arithmetic is `spansOf`'s: a step
 *  between two samples is a delta over an interval, and a step straddling the
 *  boundary contributes its overlap's share, because a bucket has no finer
 *  resolution and a wider claim would pretend it does (§5.1).
 *
 *  Provider sentinels are skipped: `@deepseek` has no allowance window, so a
 *  sample naming one would be about nothing this reading can add to. An account
 *  with the same name on two walls is one account by construction; samples are
 *  keyed by the account, not the host (§3.3). */
/** `scope` is part of the identity, not decoration. An account can carry two
 *  `weekly_scoped` windows at once (`seven_day_opus` and `seven_day_sonnet`
 *  arrive as one kind under different scopes), and they are two currencies:
 *  keyed on `(account, kind)` alone this would add them, which is the one thing
 *  §21.1 forbids. */
export type WindowSpend = {
  account: string;
  kind: string;
  scope: string;
  points: number;
};

/** **A window the samples covered and that did not move is a row with zero
 *  points, not a missing row.** An absent kind means "no samples here", which
 *  the block words as `not read`; a measured zero is a real reading and is the
 *  one a quiet window genuinely produces. Dropping the zero made the honest
 *  answer look like a missing one. */
export function windowSpend(
  instances: readonly WindowInstance[],
  from: number,
  to: number,
): WindowSpend[] {
  if (!(to > from)) return [];
  const by = new Map<string, WindowSpend>();
  const at = (one: WindowInstance): WindowSpend => {
    const key = `${one.account}\u0000${one.kind}\u0000${one.scope}`;
    let row = by.get(key);
    if (!row) {
      row = { account: one.account, kind: one.kind, scope: one.scope, points: 0 };
      by.set(key, row);
    }
    return row;
  };
  for (const one of instances) {
    if (isSentinel(one.account)) continue;
    let touched = false;
    for (const p of one.points) {
      if (p.at >= from && p.at < to) {
        touched = true;
        break;
      }
    }
    if (touched) at(one);
    for (let i = 1; i < one.points.length; i++) {
      const a = one.points[i - 1];
      const b = one.points[i];
      const delta = Math.max(0, b.used - a.used);
      const width = b.at - a.at;
      if (!(width > 0)) continue;
      const overlap = Math.min(to, b.at) - Math.max(from, a.at);
      if (overlap <= 0) continue;
      const row = at(one);
      if (delta > 0) row.points += delta * (overlap / width);
    }
  }
  return [...by.values()].sort(
    (a, b) =>
      a.account.localeCompare(b.account) ||
      a.kind.localeCompare(b.kind) ||
      a.scope.localeCompare(b.scope),
  );
}

/** One funding's day: its money, and for a plan its allowance percentages.
 *
 *  `windows` is per window kind because the kinds are different currencies
 *  (§5.5) and never summed. A plan funding with no samples covering the day
 *  gets an empty list, which the caller must draw as "not read" rather than as
 *  zero. */
export type FundingWindow = {
  kind: string;
  scope: string;
  points: number;
};

export type FundingReading = FundingRow & {
  windows: FundingWindow[];
};

/** The day's breakdown, one row per funding, joined with the account's windows.
 *
 *  **The two halves are different scopes and the caller must say so.** The
 *  money is this studio's settled turns; the percentages are the account's own
 *  windows, which count work done in a terminal and on another wall. Joining
 *  them by account is still the useful reading, and it is not an identity:
 *  `turn.usd` for a subscription is what those tokens would have cost at API
 *  prices, while the percentage says how much of the plan's window went.
 *
 *  A funding whose label is not a plan account never gets a window, even if an
 *  account happens to share the name: `@credits` is not a subscription. */
export function fundingReadings(
  rows: readonly FundingRow[],
  instances: readonly WindowInstance[],
  from: number,
  to: number,
): FundingReading[] {
  const spend = windowSpend(instances, from, to);
  const windowsOf = new Map<string, FundingWindow[]>();
  for (const w of spend) {
    const list = windowsOf.get(w.account) ?? [];
    list.push({ kind: w.kind, scope: w.scope, points: w.points });
    windowsOf.set(w.account, list);
  }
  return rows.map((row) => ({
    ...row,
    windows: row.kind === "plan" ? (windowsOf.get(row.label) ?? []) : [],
  }));
}

/** Dollars at API rates per allowance point, for one account and window kind.
 *
 *  `attributed` is the modelled cost of the facts inside the window and `delta`
 *  the points it moved, both from the attribution (`analytics.ts::residualOf`).
 *  Null rather than zero when the window moved no points: a rate computed over
 *  an empty denominator is not a slow rate, it is no rate. */
export function usdPerPoint(attributed: number, delta: number): number | null {
  /* Zero attributed dollars with a moved window means no known fact carried the
     delta (the work was on another machine, or the model was unpriced). A rate
     of $0 there would say the window is free, so it is no rate at all. */
  if (!(delta > 0) || !(attributed > 0)) return null;
  return attributed / delta;
}

/** Dollars at api rates per point, for every window a funding row carries.
 *
 *  The two halves come from different reads (`allowance_costs` and
 *  `allowance_fact`), and a rate exists only where both did. An account whose
 *  work happened elsewhere has a percentage and no rate, which is the honest
 *  pair: the window moved, and what it cost is unknown here. */
export type Exchange = { account: string; kind: string; scope: string; usdPerPoint: number };

export function exchangesOf(
  instances: readonly WindowInstance[],
  buckets: readonly CostBucket[],
  rows: readonly FundingReading[],
): Exchange[] {
  const out: Exchange[] = [];
  for (const row of rows) {
    if (row.kind !== "plan") continue;
    for (const w of row.windows) {
      const got = attributedCostOf(instances, buckets, row.label, w.kind, w.scope);
      if (!got) continue;
      const rate = usdPerPoint(got.cost, got.delta);
      if (rate !== null) {
        out.push({ account: row.label, kind: w.kind, scope: w.scope, usdPerPoint: rate });
      }
    }
  }
  return out;
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** What a funding is called in a sentence. The house voice is lowercase and
 *  quiet, and a label the user chose is quoted as they wrote it. */
export function fundingSaid(label: string, kind: FundingKind): string {
  if (kind === "credits") return "anthropic api credits";
  if (kind === "provider") return `${label.replace(/^@/, "")} credits`;
  if (label === "") return "the signed-in account";
  return label;
}

/** The money half alone, for a tooltip with no room for windows: the day's
 *  figure and who paid it, in the order the rows came in (largest first). */
export function fundingLine(rows: readonly FundingRow[]): string {
  return rows.map((r) => `${fundingSaid(r.label, r.kind)} $${r.usd.toFixed(2)}`).join(" · ");
}

/* ── small helpers, the file's own ─────────────────────────────────────────*/

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/* ── what the tokens were made of (§21.1) ───────────────────────────────────*/

/** One class of token, and what it cost at API rates. */
export type MixClass = { tokens: number; usd: number };

/** A funding's day, broken into the four kinds of token and their prices.
 *
 *  **This is the answer to "15M of what".** A raw total is 90% cache reads on a
 *  working day, so the same 15M can be about a dollar or a few hundred. The
 *  row's dollars stay the CLI's own figure; this is the model's reading of the
 *  same work, priced per class at each fact's own instant. */
export type FundingMix = {
  label: string;
  input: MixClass;
  output: MixClass;
  cacheRead: MixClass;
  cacheWrite: MixClass;
  tokens: number;
  usd: number;
  /** The same day in **input-token equivalents**: each class's dollars divided
   *  by the input rate it was charged, so one number can be compared with
   *  another day's. Cache reads are a hundredth of the count here. */
  weight: number;
  /** Tokens whose model the table could not place. They are counted and say so
   *  rather than being priced at zero, the same bargain `unpriced` strikes. */
  unpriced: number;
};

const zeroClass = (): MixClass => ({ tokens: 0, usd: 0 });

/** The day's tokens, by class, per funding label.
 *
 *  `from`/`to` are the day's edges: the shell reads the fine tier for the day
 *  and this keeps the rows inside it, because the read's own window is wider
 *  (it is the residual's). */
export function mixOf(
  rows: readonly AllowanceCost[],
  from: number,
  to: number,
): FundingMix[] {
  const by = new Map<string, FundingMix>();
  for (const r of preferredCostRows(rows)) {
    if (r.at < from || r.at >= to) continue;
    const rate = rateAt(r.model, r.at);
    let mix = by.get(r.account);
    if (!mix) {
      mix = {
        label: r.account,
        input: zeroClass(),
        output: zeroClass(),
        cacheRead: zeroClass(),
        cacheWrite: zeroClass(),
        tokens: 0,
        usd: 0,
        weight: 0,
        unpriced: 0,
      };
      by.set(r.account, mix);
    }
    const tokens = r.inTok + r.outTok + r.cacheRead + r.write5m + r.write1h;
    mix.tokens += tokens;
    if (!rate) {
      mix.unpriced += tokens;
      continue;
    }
    const perM = 1e6;
    const inUsd = (r.inTok * rate.input) / perM;
    const outUsd = (r.outTok * rate.output) / perM;
    const readUsd = (r.cacheRead * rate.input * (rate.cacheRead ?? CACHE_READ)) / perM;
    const writeUsd = ((r.write5m * WRITE_5M + r.write1h * WRITE_1H) * rate.input) / perM;
    mix.input.tokens += r.inTok;
    mix.input.usd += inUsd;
    mix.output.tokens += r.outTok;
    mix.output.usd += outUsd;
    mix.cacheRead.tokens += r.cacheRead;
    mix.cacheRead.usd += readUsd;
    mix.cacheWrite.tokens += r.write5m + r.write1h;
    mix.cacheWrite.usd += writeUsd;
    const usd = inUsd + outUsd + readUsd + writeUsd;
    mix.usd += usd;
    /* Weight is per row, because each row carries its own input rate. */
    mix.weight += rate.input > 0 ? usd / (rate.input / perM) : 0;
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label));
}
