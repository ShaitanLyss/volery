/* What the wall is spending right now, off the stream rather than off the store.
 *
 * **This is a different reading from the analytics, not a finer one.** §3.1
 * buckets a fact at five minutes because every question the surfaces ask is a
 * rate over months; a per-request table over a year is hundreds of millions of
 * rows. The live reading answers one question that has no bucket at all: *what
 * is arriving now*. So it is ephemeral on purpose. Nothing here is written
 * down, nothing survives a reload, and when the stream is quiet the reading
 * falls to zero rather than to the last number it saw.
 *
 * The samples are the assistant messages the wall already folds: each one
 * carries its own `usage`, which is one request. `note` is called from the one
 * place that reads them, so a second caller cannot double-count.
 *
 * Pure, so the arithmetic can be tested: a window, a rate over it, and the same
 * thing split by machine once the flyway's live lines arrive.
 */

/** One request, as the stream reported it. `usd` is null when the price table
 *  could not place the model, which is counted rather than priced at zero. */
export type LiveSample = {
  at: number;
  host: string;
  model: string;
  inTok: number;
  outTok: number;
  cacheRead: number;
  write: number;
  usd: number | null;
};

export type LiveTotals = {
  requests: number;
  tokens: number;
  usd: number;
  /** Tokens from a model the table could not price. Counted, never priced. */
  unpriced: number;
};

export const NO_TOTALS: LiveTotals = { requests: 0, tokens: 0, usd: 0, unpriced: 0 };

export const tokensOfSample = (s: LiveSample): number =>
  s.inTok + s.outTok + s.cacheRead + s.write;

/** Everything that landed inside `[from, to)`. */
export function totalsIn(
  samples: readonly LiveSample[],
  from: number,
  to: number,
): LiveTotals {
  const out: LiveTotals = { ...NO_TOTALS };
  for (const s of samples) {
    if (s.at < from || s.at >= to) continue;
    const tokens = tokensOfSample(s);
    out.requests += 1;
    out.tokens += tokens;
    if (s.usd === null) out.unpriced += tokens;
    else out.usd += s.usd;
  }
  return out;
}

/** The same thing as a rate, so a sixty-second window and a five-minute one
 *  read in one unit. Null rather than zero when the window has no width: a
 *  rate over no time is not a slow rate. */
export function perMinute(
  totals: LiveTotals,
  from: number,
  to: number,
): { tokens: number; usd: number; requests: number } | null {
  const minutes = (to - from) / 60_000;
  if (!(minutes > 0)) return null;
  return {
    tokens: totals.tokens / minutes,
    usd: totals.usd / minutes,
    requests: totals.requests / minutes,
  };
}

/** One line per machine, busiest first. A wall with nothing in the window is
 *  absent rather than drawn at zero: a machine that is off is not a machine
 *  that spent nothing. */
export function byHost(
  samples: readonly LiveSample[],
  from: number,
  to: number,
): { host: string; totals: LiveTotals }[] {
  const by = new Map<string, LiveTotals>();
  for (const s of samples) {
    if (s.at < from || s.at >= to) continue;
    const tokens = tokensOfSample(s);
    const one = by.get(s.host) ?? { ...NO_TOTALS };
    one.requests += 1;
    one.tokens += tokens;
    if (s.usd === null) one.unpriced += tokens;
    else one.usd += s.usd;
    by.set(s.host, one);
  }
  return [...by.entries()]
    .map(([host, totals]) => ({ host, totals }))
    .sort((a, b) => b.totals.tokens - a.totals.tokens || a.host.localeCompare(b.host));
}

/** The strip: `columns` buckets of tokens over `[from, to)`, oldest first. A
 *  quiet bucket is a zero, so a lull draws as ground rather than as a gap. */
export function stripOf(
  samples: readonly LiveSample[],
  from: number,
  to: number,
  columns = 60,
): number[] {
  const width = (to - from) / columns;
  const out = new Array<number>(Math.max(1, columns)).fill(0);
  if (!(width > 0)) return out;
  for (const s of samples) {
    if (s.at < from || s.at >= to) continue;
    const i = Math.min(out.length - 1, Math.max(0, Math.floor((s.at - from) / width)));
    out[i]! += tokensOfSample(s);
  }
  return out;
}

/** A rate said the way a person says it: a thousand tokens is not a number
 *  anybody can size, and a million is. */
export function liveSaid(tokensPerMinute: number): string {
  if (!Number.isFinite(tokensPerMinute) || tokensPerMinute <= 0) return "quiet";
  if (tokensPerMinute < 1_000) return `${Math.round(tokensPerMinute)} tok/min`;
  if (tokensPerMinute < 1_000_000) return `${(tokensPerMinute / 1_000).toFixed(1)}k tok/min`;
  return `${(tokensPerMinute / 1_000_000).toFixed(2)}M tok/min`;
}
