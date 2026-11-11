/* The watches a card sets on its own spend, as a page draws them.
 *
 * `docs/ANALYTICS.md` §11.13 is the feature and `src-tauri/src/spend.rs` is the
 * tool that makes them; this file owns only the vocabulary and the wording, so
 * the one surface that draws a watch beside a card's spend can be tested
 * without a store. The tool is where a watch is *made*, there is deliberately
 * no editor here beyond a delete.
 *
 * Pure: no runes, no Tauri, no DOM. */

/** The three measures, in the order the tool lists them. Kept as a value this
 *  module owns so `test/spend.test.ts` can hold it to the Rust vocabulary. */
export const MEASURES = ["usd", "tokens", "allowance_points"] as const;
export type Measure = (typeof MEASURES)[number];

/** The four periods. `window` exists only with `allowance_points`, which is a
 *  rule the tool enforces; this file only has to be able to say it. */
export const PERIODS = ["session", "day", "turn", "window"] as const;
export type Period = (typeof PERIODS)[number];

export const SCOPES = ["self", "self+children"] as const;
export type WatchScope = (typeof SCOPES)[number];

/** One row of `spend_watch`, as `store::SpendWatch` serialises it. */
export type SpendWatch = {
  id: number;
  conversationId: string;
  measure: Measure;
  period: Period;
  atValue: number;
  scope: WatchScope;
  createdAt: number;
  firedFor: string | null;
  firedAt: number | null;
};

function oneOf<T extends string>(list: readonly T[], raw: unknown): T | null {
  return typeof raw === "string" && (list as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

/** A row from the store, or `null` for one this build cannot draw.
 *
 * The opaque-row bargain: a measure or period from a newer build degrades to
 * nothing rather than drawing a watch under a label we would have to invent. A
 * row that cannot be named is one the page should not offer a delete for
 * either, because the person would be deleting something they cannot read. */
export function asWatch(raw: unknown): SpendWatch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const measure = oneOf(MEASURES, r.measure);
  const period = oneOf(PERIODS, r.period);
  const scope = oneOf(SCOPES, r.scope);
  const id = typeof r.id === "number" ? r.id : Number.NaN;
  const atValue = typeof r.atValue === "number" ? r.atValue : Number.NaN;
  if (measure === null || period === null || scope === null) return null;
  if (!Number.isFinite(id) || !Number.isFinite(atValue)) return null;
  return {
    id,
    conversationId: typeof r.conversationId === "string" ? r.conversationId : "",
    measure,
    period,
    atValue,
    scope,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    firedFor: typeof r.firedFor === "string" ? r.firedFor : null,
    firedAt: typeof r.firedAt === "number" ? r.firedAt : null,
  };
}

/** `1.2M`, `84k`, `312`. The same scale the tool's answer uses. */
export function tokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1_000_000) {
    const m = (v / 1e6).toFixed(1);
    return `${m.endsWith(".0") ? m.slice(0, -2) : m}M`;
  }
  if (v >= 1_000) return `${Math.floor(v / 1_000)}k`;
  return String(v);
}

/** A threshold as the card wrote it: `$10`, `$10.50`, `1M tokens`, `5 points`. */
export function thresholdSaid(measure: Measure, at: number): string {
  switch (measure) {
    case "usd": {
      const v = Math.max(0, at);
      return Math.abs(v - Math.trunc(v)) < 1e-9
        ? `$${Math.trunc(v)}`
        : v >= 1
          ? `$${v.toFixed(2)}`
          : `$${v.toFixed(4)}`;
    }
    case "tokens":
      return `${tokens(at)} tokens`;
    case "allowance_points": {
      const s = Math.max(0, at).toFixed(1);
      return `${s.endsWith(".0") ? s.slice(0, -2) : s} points`;
    }
  }
}

/** The period as a person says it. */
export function periodSaid(period: Period): string {
  switch (period) {
    case "session":
      return "this session";
    case "day":
      return "today";
    case "turn":
      return "this turn";
    case "window":
      return "this window";
  }
}

/** One watch in a line: *warn at $10, this session*.
 *
 * `fired` is drawn apart from the threshold because it is a fact about a period
 * instance rather than about the setting: the same watch reads unfired again
 * when the day rolls, and that is the whole of the restart. */
export function watchSaid(w: SpendWatch, now: number): string {
  const scope = w.scope === "self+children" ? ", with the cards it opened" : "";
  const base = `warn at ${thresholdSaid(w.measure, w.atValue)}, ${periodSaid(w.period)}${scope}`;
  return w.firedAt === null ? base : `${base} · fired ${when(w.firedAt, now)}`;
}

/** `today 14:03`, `yesterday 09:12`, `3 nov`. A page with no clock of its own
 *  is handed one, so this stays pure. */
export function when(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const yesterday = new Date(now - 86_400_000).toDateString() === d.toDateString();
  if (sameDay) return `today ${time}`;
  if (yesterday) return `yesterday ${time}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
