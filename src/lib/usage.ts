/* What Claude Code has spent, and against which clock.
 *
 * `usage.rs` reads the transcripts and answers in facts — five-minute buckets
 * of tokens by model. Everything a person actually wants to know is here: what
 * a token costs, which of the two windows it falls in, when the near one rolls
 * over, and what to call the number. The same split `perf.rs`/`perf.ts` draws,
 * and for the same reason — a price list is knowledge about Claude, and this
 * file is where Claude-specific knowledge is allowed to live beside
 * `classify.ts`.
 *
 * Pure — no runes, no DOM, no `invoke` — so all of it has direct Bun tests.
 *
 * **The two windows are not the same kind of thing, and the difference is
 * load-bearing.** The five-hour one is a *block*: it opens with the first turn
 * after a lull and closes five hours later, whatever you do in between, which
 * is why it has a reset time worth printing. The weekly one is *rolling* —
 * seven days back from now — because the real weekly window resets on a
 * schedule tied to the account and there is nothing on this machine that knows
 * it. Inventing one would put a countdown on the wall that is wrong by up to a
 * week, and a confident wrong number is worse than an honest vaguer one. So the
 * week says "past 7 days" and offers no reset.
 *
 * Both are read off *this machine's* transcripts, which is everything Claude
 * Code has done here — Skein's cards and any terminal alike, since they write
 * to the same files. It is not everything the *account* has done: another
 * machine's turns count against the same limits and cannot be seen from here.
 * That is the one thing this widget cannot know, and the reason it reports what
 * has been spent rather than a percentage of an allowance. */

export type Slice = {
  /** The bucket's start, epoch ms. */
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
};

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const BLOCK_MS = 5 * HOUR;
export const WEEK_MS = 7 * 24 * HOUR;

/* ── what a token costs ─────────────────────────────────────────────────────
 *
 * Dollars per million tokens, at published list rates. Cache reads and the two
 * cache-write TTLs are all multiples of the input rate rather than columns of
 * their own — that relationship holds across every model and has done since
 * caching shipped, so a new model is one line here rather than five. */

export type Rate = { input: number; output: number };

const CACHE_READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2;

/** Rates as published 2026-08-14. Sonnet 5's introductory $2/$10 runs to
 *  2026-08-31 and is deliberately *not* used: a reading that quietly gets 50%
 *  more expensive one morning is a wall arguing with itself, and the standing
 *  rate is the one worth planning against. */
export const RATES: Record<string, Rate> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** What one model costs, or null when nothing here can say.
 *
 * The family fallback is the point rather than a nicety: a model released after
 * this build ships would otherwise price at nothing, and a ledger that silently
 * reads zero for the model you are actually using is the one failure this
 * widget must not have. Tiers have held their rate across every release so far,
 * so guessing by tier is a much smaller error than guessing zero — and a model
 * that matches no tier at all is counted as `unpriced` and said out loud rather
 * than folded into the total. `[1m]` and the like are stripped: `system/init`
 * gives the configured id with its window tier attached (see `classify.ts`). */
export function rateFor(model: string): Rate | null {
  const id = model.replace(/\[.*$/, "").trim();
  const exact = RATES[id];
  if (exact) return exact;
  if (id.includes("fable") || id.includes("mythos")) return RATES["claude-fable-5"];
  if (id.includes("opus")) return RATES["claude-opus-5"];
  if (id.includes("sonnet")) return RATES["claude-sonnet-5"];
  if (id.includes("haiku")) return RATES["claude-haiku-4-5"];
  return null;
}

/* ── totals ────────────────────────────────────────────────────────────────*/

export type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  /** Every token processed, of whatever kind. */
  tokens: number;
  usd: number;
  /** Tokens whose model matched no rate, so contributed nothing to `usd`. */
  unpriced: number;
};

export function empty(): Totals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    tokens: 0,
    usd: 0,
    unpriced: 0,
  };
}

function absorb(t: Totals, s: Slice) {
  t.input += s.input;
  t.output += s.output;
  t.cacheRead += s.cacheRead;
  t.write5m += s.write5m;
  t.write1h += s.write1h;
  const n = s.input + s.output + s.cacheRead + s.write5m + s.write1h;
  t.tokens += n;
  const rate = rateFor(s.model);
  if (!rate) {
    t.unpriced += n;
    return;
  }
  t.usd +=
    (s.input * rate.input +
      s.output * rate.output +
      s.cacheRead * rate.input * CACHE_READ +
      s.write5m * rate.input * WRITE_5M +
      s.write1h * rate.input * WRITE_1H) /
    1e6;
}

/** Everything from `from` (inclusive) to `to` (exclusive). */
export function sum(slices: Slice[], from: number, to: number): Totals {
  const t = empty();
  for (const s of slices) if (s.at >= from && s.at < to) absorb(t, s);
  return t;
}

export type Measure = "cost" | "tokens";

/** The one number a bar, a ring or a headline is drawn from. */
export function amount(t: Totals, measure: Measure): number {
  return measure === "cost" ? t.usd : t.tokens;
}

/** A fraction of a reference, clamped — a bar that ran past its own end would
 *  say less than one pinned at full. */
export function share(of: number, against: number): number {
  if (!(against > 0)) return 0;
  return Math.min(1, Math.max(0, of / against));
}

/* ── the local day ─────────────────────────────────────────────────────────
 *
 * A third window, and the only one anybody has by glancing at a wall clock: what
 * today has cost. It is what the title bar's figure and the warmth in the ground
 * are scoped to (`Skein.spend`), which is a different reading from the two above
 * — this studio's own turns off the `turn` table, rather than the account's off
 * the transcripts — but it is the same species of arithmetic, and this is the
 * file where "against which clock" lives. */

/** Midnight this morning, local, as epoch ms.
 *
 *  Deliberately not `now - (now % DAY)`, which is midnight *UTC* — the middle of
 *  the afternoon in half the world, and a figure that would reset itself partway
 *  through the working day here. Nor `now - offset`, which asks the offset in
 *  force *now* and applies it to a moment before a changeover may have happened:
 *  on the two days a year a timezone moves, that lands an hour either side of
 *  the midnight it was aiming at. `Date.setHours` resolves it against the
 *  calendar, which is the one thing that always knows. */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ── the five-hour block ───────────────────────────────────────────────────*/

export type Block = { from: number; to: number };

/** The five-hour blocks this activity falls into, oldest first.
 *
 * A block opens at the top of the hour the first turn after a lull landed in,
 * and runs five hours from there — which is the shape the CLI's own usage
 * readout has, resetting on the hour rather than at the minute you happened to
 * start. Anything landing inside an open block joins it; the first turn past
 * its end opens the next one. A gap needs no rule of its own: a turn five hours
 * after the last one is necessarily outside whatever block that one was in.
 *
 * It is an inference, not a fact off the wire — nothing in a transcript records
 * where the server thinks the boundary is. It is the best available reading of
 * a real mechanism, which is why the widget prints when the block rolls but
 * never prints what is left of an allowance. */
export function blocks(slices: Slice[]): Block[] {
  const out: Block[] = [];
  for (const s of [...slices].sort((a, b) => a.at - b.at)) {
    const last = out[out.length - 1];
    if (last && s.at < last.to) continue;
    const from = s.at - (s.at % HOUR);
    out.push({ from, to: from + BLOCK_MS });
  }
  return out;
}

/** The block `now` is inside, or null when nothing has been said for five
 *  hours — which is a real state and the one the wall shows as rested. */
export function blockAt(slices: Slice[], now: number): Block | null {
  const all = blocks(slices);
  const last = all[all.length - 1];
  return last && now >= last.from && now < last.to ? last : null;
}

/* ── the two readings ──────────────────────────────────────────────────────*/

export type Reading = {
  key: "block" | "week";
  /** What the window is, in words. */
  said: string;
  totals: Totals;
  /** What the fraction is drawn against, and what to call it. Null when there
   *  is nothing honest to compare against — a first day on a fresh machine has
   *  no busiest block and no week before. */
  against: { amount: number; said: string } | null;
  frac: number;
  /** Milliseconds until the block rolls. Only ever set on the block: the week
   *  has no reset this machine can know. */
  resetsIn: number | null;
};

export type Readings = { block: Reading; week: Reading };

/** Both windows, and the reference each is drawn against.
 *
 * Neither fraction is a fraction *of a limit* — no limit is knowable from here
 * (see the note at the top). They are drawn against the wall's own recent
 * history instead, which answers the question a bar can honestly answer: is
 * this heavier than usual. The block goes against the busiest other block of
 * the past week; the week goes against the week before it. */
export function readings(slices: Slice[], now: number, measure: Measure): Readings {
  const here = blockAt(slices, now);
  const blockTotals = here ? sum(slices, here.from, here.to) : empty();

  /* Every other block that started inside the past week, so "busiest" means
     busiest lately rather than busiest ever. The current one is excluded or it
     would be its own reference and always read full. */
  let peak = 0;
  for (const b of blocks(slices)) {
    if (b.from < now - WEEK_MS) continue;
    if (here && b.from === here.from) continue;
    peak = Math.max(peak, amount(sum(slices, b.from, b.to), measure));
  }

  const week = sum(slices, now - WEEK_MS, now + 1);
  const before = sum(slices, now - 2 * WEEK_MS, now - WEEK_MS);
  const beforeAmount = amount(before, measure);

  return {
    block: {
      key: "block",
      said: "these five hours",
      totals: blockTotals,
      against: peak > 0 ? { amount: peak, said: "busiest five hours this week" } : null,
      frac: share(amount(blockTotals, measure), peak),
      resetsIn: here ? Math.max(0, here.to - now) : null,
    },
    week: {
      key: "week",
      said: "past 7 days",
      totals: week,
      against:
        beforeAmount > 0 ? { amount: beforeAmount, said: "the week before" } : null,
      frac: share(amount(week, measure), beforeAmount),
      resetsIn: null,
    },
  };
}

/** Which models the spending went to, heaviest first — so a reading that looks
 *  wrong can be traced to the model that made it. */
export function leaders(
  slices: Slice[],
  from: number,
  to: number,
  measure: Measure,
): { model: string; amount: number }[] {
  const by = new Map<string, Totals>();
  for (const s of slices) {
    if (s.at < from || s.at >= to) continue;
    let t = by.get(s.model);
    if (!t) by.set(s.model, (t = empty()));
    absorb(t, s);
  }
  return [...by.entries()]
    .map(([model, t]) => ({ model, amount: amount(t, measure) }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/** A model id as it is worth reading on a widget two inches wide. */
export function shortModel(model: string): string {
  return model
    .replace(/\[.*$/, "")
    .replace(/^claude-/, "")
    .replace(/-(\d)-(\d)$/, " $1.$2")
    .replace(/-(\d)$/, " $1");
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** Money, at the precision the size of it deserves.
 *
 * Never more than five characters up to $999M, because these sit in a row of
 * tabular numerals that must not reflow as it grows. The thresholds are just
 * under each round number rather than on it (`9950`, not `10_000`) — rounding
 * *then* comparing is what turns $999,999 into `$1000k`, which is six
 * characters and the bug this shape exists to avoid. */
export function money(usd: number): string {
  if (!(usd > 0)) return "$0";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 999.5) return `$${Math.round(usd)}`;
  if (usd < 9950) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd < 999_500) return `$${Math.round(usd / 1000)}k`;
  if (usd < 9.95e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${Math.round(usd / 1e6)}M`;
}

export function count(n: number): string {
  if (!(n > 0)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function say(n: number, measure: Measure): string {
  return measure === "cost" ? money(n) : count(n);
}

/** How long is left, in words that change about once a minute. Deliberately not
 *  ticking to the second: a countdown you can watch is a countdown you do
 *  watch, which is the argument `Rest.svelte`'s `said` already makes. */
export function left(ms: number): string {
  if (!(ms > 0)) return "any moment";
  const mins = Math.round(ms / MINUTE);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** What this turn cost, given the CLI's running total and the last one seen.
 *
 *  `result.total_cost_usd` is a running total **of the process**, not of the
 *  session — probed 2026-08-25 with `tools/probe-cost.ts`, spawning with
 *  Skein's exact argv: a small turn on a fresh session reported `0.2542635`,
 *  and the same session `--resume`d in a second process reported `0.225298`
 *  for its next small turn. Lower, so the counter had started again rather
 *  than carrying what the session had already spent.
 *
 *  A card outlives its process — an account move ends the child and wakes it,
 *  a card that crashed is woken again — so the baseline is routinely above the
 *  number the new process counts from. This used to be `Math.max(0, total -
 *  baseline)`, which booked the first turn of every new process at nothing:
 *  nine such turns on 2026-08-24, one of them 4.7M cache reads wide, and each
 *  of them missing from the day's figure and the ledger both.
 *
 *  **A total below the baseline is a counter that restarted**, and its own
 *  value is then the whole of what this process has spent — which is this
 *  turn, since a new process has taken no other. Here rather than in
 *  `conversation.svelte.ts` for the reason the price table is here: it is
 *  arithmetic about a bill, and arithmetic wants a test. */
export function costStep(total: number, baseline: number): number {
  if (!Number.isFinite(total) || total < 0) return 0;
  if (!Number.isFinite(baseline) || baseline < 0) return total;
  return total < baseline ? total : total - baseline;
}

/* ── what kind of row a settled turn is owed ────────────────────────────────
 *
 * `costStep` above answers *how much*, and for a while that was taken to be
 * the whole question. It is not: a `result` can carry a cost step and no turn
 * to put it on, and the row written for it said a turn had cost $13.52 and
 * processed nothing. */

/** The four counts a turn row carries, as `Conversation.lastTurn` holds them. */
export type TurnTokens = {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
};

/** What a `turn` row *is* — a turn, or money with no turn to attribute it to. */
export type TurnRow = "turn" | "spend";

/** Which of the two a settled `result` is owed.
 *
 *  **`num_turns` is the discriminator, and it is exact rather than a
 *  heuristic.** It counts round trips to a model, so zero means no model was
 *  reached — which means no tokens were spent *in this turn*, and any cost
 *  step on it is therefore money that accumulated earlier in the process and
 *  had nothing to be booked against until now. Same field `classify.ts`'s
 *  `localAnswer` and `localCommandAwaiting` already trust for the same reason,
 *  and probed there: 2026-08-14 against claude 2.1.232
 *  (`tools/probe-commands.ts`), every locally-answered command reported
 *  `num_turns: 0`, `duration_api_ms: 0` and an all-zero `usage`, where the
 *  rate-limited turn beside them still reported 1.
 *
 *  Measured on this wall's own `turn` table, over the 696 rows written since
 *  `migrate_v7` began recording tokens at all: **101 carry no tokens, and 14
 *  of those carry real money — $148.08.** The distribution is what settles the
 *  design one level down. On 2026-08-22 the table holds exactly two such rows,
 *  $71.31 and $38.64, and *they are the whole of that day's figure*: `all_usd`
 *  and `notok_usd` are both $109.95. So the money cannot be dropped and cannot
 *  be moved off the day it landed on — a `spend` row is a relabelling, never a
 *  deletion, and `store::spend_row` goes on summing both kinds. See
 *  `.claude/rules/usage.md`.
 *
 *  **The tokens are consulted as well, and only ever to say `turn`.** A
 *  `num_turns: 0` result that somehow reported tokens is a turn whatever it
 *  says about round trips, because the tokens are the evidence something was
 *  processed. That arm has never been seen; it is here because the failure it
 *  prevents — a row with real tokens filed as "no turn happened" — destroys
 *  information, where the arm it guards merely mislabels.
 *
 *  **Anything other than a literal zero is a turn**, `undefined` included. A
 *  CLI that stops sending the field, or an error path that omits it, falls
 *  back to exactly the behaviour this replaces: the money is attributed and
 *  the row is as readable as it is today. That is the safe direction — the
 *  other one files real turns as spend on the strength of a missing field.
 *
 *  Note what is deliberately *not* narrowed here: a turn that reached a model
 *  and then failed reports `num_turns >= 1` and its own tokens, so it stays a
 *  turn row. `.claude/rules/turns.md` requires that — "the failed attempt is
 *  still a turn", and a retry that swallowed it would make the day's figure
 *  understate what the wall spent.
 *
 *  Here rather than in `conversation.svelte.ts` or `classify.ts` for the
 *  reason the price table and `costStep` are here: what a ledger row *is* is
 *  knowledge about a bill rather than about a stream, and it wants a test. */
export function turnRowKind(numTurns: unknown, tokens: TurnTokens): TurnRow {
  if (numTurns !== 0) return "turn";
  const counted =
    finite(tokens?.in) +
    finite(tokens?.out) +
    finite(tokens?.cacheRead) +
    finite(tokens?.cacheWrite);
  return counted > 0 ? "turn" : "spend";
}

/** A count that can be added up: anything unusable reads as none of them. */
function finite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}
