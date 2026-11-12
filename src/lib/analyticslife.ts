/* A card's life (§11.10): what it cost, who paid for it, and when it changed.
 *
 * **The card is a history, not a label.** The chip at the top says what it is
 * on now; the total's caption is *paid by*, and the bar under it says in what
 * shares. Those are two different questions and the answer to the first must
 * never be the caption of the second.
 *
 * Three things this fold is careful about, all of them honesty rules the page
 * would otherwise break:
 *
 * - **Dollars are all time and tokens are not.** The reported cost comes from
 *   the `turn` table, which is never pruned. Tokens and the split come from the
 *   fine tier, which keeps ninety days. When the card is older than that, the
 *   model says so (`partial`) and the page labels the token half with the date
 *   the facts begin rather than drawing a lifetime bar over a recent window.
 * - **A change with no recorded reason is `reason unknown`**, never a guess.
 *   The move rows carry the new value and the instant and nothing else.
 * - **A transition the move rows lost is recovered from the spend.** A group of
 *   requests under a funding and model that begins with no move row beside it
 *   (a wall from before the moves were kept, or a move the ingest saw) is drawn
 *   as *first spent on* — a measured instant, not an inferred move.
 *
 * Pure and directly tested, like every other fold in the surface.
 */

import { asSessionFacts, shareSaid, type SessionFact, type Slice } from "./analyticsbehaviour";

const DAY = 86_400_000;
/** How close two instants have to be for one to explain the other. A move is
 *  written the moment it happens and the first request under it follows within
 *  the turn it was made for; a minute is comfortably wider than that and far
 *  narrower than a session. */
const NEAR = 90_000;

/** `usage_fact.at` is a **five-minute bucket floor**, not the request's instant
 *  (`analytics::BUCKET_MS`, §3.1), while a session's start and a move's `at`
 *  are exact transcript instants. Every comparison here between spend and the
 *  two of them has to allow for that, or it is comparing two clocks: a
 *  session that started at 12:03:20 has its first fact stamped 12:00:00, and a
 *  move at 12:06:23 is followed by a group stamped 12:05:00. */
export const FACT_BUCKET_MS = 5 * 60 * 1000;

/* ── what the command answers ────────────────────────────────────────────── */

/** One `(session, account, provider, model)` group of a card's spend. */
export type LifeSpend = {
  session: string;
  account: string;
  provider: string;
  model: string;
  firstAt: number;
  lastAt: number;
  inTok: number;
  outTok: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  requests: number;
  /** Modelled at each fact's own instant; null only when the price table could
   *  not be read at all. */
  usd: number | null;
  /** Tokens on a model the table does not know: counted, never priced at 0. */
  unpriced: number;
};

/** A move of account, provider or model. It carries no reason: the app records
 *  the new value and the instant, and inventing the why is the one thing a
 *  timeline may not do. */
export type LifeMove = { at: number; kind: string; reference: string };

export type CardLife = {
  card: string;
  label: string;
  nowSession: string;
  nowAccount: string;
  nowModel: string;
  sessions: SessionFact[];
  spend: LifeSpend[];
  moves: LifeMove[];
  /** The CLI's own reported cost over settled turns, all time. */
  usdReported: number;
  turns: number;
  /** The oldest `usage_fact` this wall holds, or 0 when it holds none. */
  factsFrom: number;
};

/* ── the command, made drawable ──────────────────────────────────────────── */

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asSpend(raw: unknown): LifeSpend | null {
  const r = obj(raw);
  if (!r) return null;
  const model = str(r.model);
  const firstAt = num(r.firstAt);
  if (!model || !(firstAt > 0)) return null;
  const usd = typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : null;
  return {
    session: str(r.session),
    account: str(r.account),
    provider: str(r.provider),
    model,
    firstAt,
    lastAt: Math.max(firstAt, num(r.lastAt)),
    inTok: num(r.inTok),
    outTok: num(r.outTok),
    cacheRead: num(r.cacheRead),
    write5m: num(r.write5m),
    write1h: num(r.write1h),
    requests: num(r.requests),
    usd,
    unpriced: num(r.unpriced),
  };
}

function asMove(raw: unknown): LifeMove | null {
  const r = obj(raw);
  if (!r) return null;
  const kind = str(r.kind);
  const at = num(r.at);
  if (!kind || !(at > 0)) return null;
  if (kind !== "account" && kind !== "provider" && kind !== "model") return null;
  return { at, kind, reference: str(r.reference) };
}

/** The command's answer, or null where it does not name a card.
 *
 *  The session rows are read through the behaviour fold's own normaliser so a
 *  card's page and the habits cannot disagree about what a session is. */
export function asCardLife(raw: unknown): CardLife | null {
  const r = obj(raw);
  if (!r) return null;
  const card = str(r.card);
  if (!card) return null;
  return {
    card,
    label: str(r.label),
    nowSession: str(r.nowSession),
    nowAccount: str(r.nowAccount),
    nowModel: str(r.nowModel),
    sessions: asSessionFacts(r.sessions),
    spend: (Array.isArray(r.spend) ? r.spend : [])
      .map(asSpend)
      .filter((s): s is LifeSpend => s !== null)
      .sort((a, b) => a.firstAt - b.firstAt),
    moves: (Array.isArray(r.moves) ? r.moves : [])
      .map(asMove)
      .filter((m): m is LifeMove => m !== null)
      .sort((a, b) => a.at - b.at),
    usdReported: num(r.usdReported),
    turns: num(r.turns),
    factsFrom: num(r.factsFrom),
  };
}

/* ── the shares ──────────────────────────────────────────────────────────── */

export function tokensOf(g: LifeSpend): number {
  return g.inTok + g.outTok + g.cacheRead + g.write5m + g.write1h;
}

/** One slice of the bar: a funding or a model, its tokens, and whatever dollars
 *  the price table could put on them. */
export type LifeShare = Slice & { tokens: number; usd: number | null; unpriced: number };

/** Fold the spend by account or by model. The bar is drawn on **tokens**
 *  because every request has them and not every model has a price; the dollars
 *  beside each row come from the same table the rest of the surface prices
 *  with, and are absent rather than zero when it could not place a model. */
export function sharesOf(
  spend: readonly LifeSpend[],
  by: "account" | "model",
  cap = 4,
): { rows: LifeShare[]; tokens: number; usd: number; usdPartial: boolean; unpriced: number } {
  const merged = new Map<string, { tokens: number; usd: number; usdMissing: boolean; unpriced: number }>();
  for (const g of spend) {
    const label = by === "account" ? g.account || "unknown" : g.model;
    const one = merged.get(label) ?? { tokens: 0, usd: 0, usdMissing: false, unpriced: 0 };
    one.tokens += tokensOf(g);
    if (g.usd === null) one.usdMissing = true;
    else one.usd += g.usd;
    one.unpriced += g.unpriced;
    merged.set(label, one);
  }
  let tokens = 0;
  let usd = 0;
  let usdPartial = false;
  let unpriced = 0;
  for (const one of merged.values()) {
    tokens += one.tokens;
    usd += one.usd;
    unpriced += one.unpriced;
    /* One group the table could not price makes the folded dollars a floor,
       and the page says "part unpriced" rather than presenting it as exact. */
    if (one.usdMissing || one.unpriced > 0) usdPartial = true;
  }
  const all: LifeShare[] = [...merged.entries()]
    .map(([label, one]) => ({
      label,
      value: one.tokens,
      tokens: one.tokens,
      share: tokens > 0 ? one.tokens / tokens : null,
      /* **A model the table cannot price has no dollar figure, not `$0`.** A
         group the book could not place carries `usd: 0` from Rust with every
         one of its tokens counted in `unpriced`; printing that zero would be
         the one lie this block exists to avoid. A label with *some* priced
         tokens keeps its floor and is marked "part unpriced" beside it. */
      usd: one.usdMissing || (one.tokens > 0 && one.unpriced >= one.tokens) ? null : one.usd,
      unpriced: one.unpriced,
    }))
    .sort((a, b) => b.tokens - a.tokens || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (all.length <= cap) return { rows: all, tokens, usd, usdPartial, unpriced };
  const head = all.slice(0, cap);
  const rest = all.slice(cap);
  let value = 0;
  let restUsd = 0;
  let restUnpriced = 0;
  let restMissing = false;
  for (const one of rest) {
    value += one.tokens;
    if (one.usd === null) restMissing = true;
    else restUsd += one.usd;
    restUnpriced += one.unpriced;
  }
  head.push({
    label: "others",
    value,
    tokens: value,
    share: tokens > 0 ? value / tokens : null,
    usd: restMissing && restUsd === 0 ? null : restUsd,
    unpriced: restUnpriced,
  });
  return { rows: head, tokens, usd, usdPartial, unpriced };
}

/* ── the change timeline ─────────────────────────────────────────────────── */

/** What a row of the timeline says happened. `opened` and `session` are the
 *  card's own sessions; `account`, `provider` and `model` are the moves the
 *  wall recorded; `spend` is a funding and model that begins with no move row
 *  to explain it, drawn as the measured instant it is. */
export type LifeVerb = "opened" | "session" | "account" | "provider" | "model" | "spend";

export type LifeRow = {
  at: number;
  verb: LifeVerb;
  /** What the change moved it to, as the wall recorded it. Empty for a row
   *  that only says a session began. */
  target: string;
  /** The why, where the wall knows one. It never does today, and a row that
   *  guessed would be worse than one that says so. */
  reason: string | null;
};

/** `account · model`, skipping the two absences: an unrecorded account is not
 *  the word "unknown", and an empty model is no model. */
export function fundingSaid(account: string, model: string): string {
  return [account === "unknown" ? "" : account, model].filter(Boolean).join(" · ");
}

/** The model a session opened on, read off the earliest spend group in it.
 *
 *  **Scoped by the session alone, never by comparing the group's stamp with
 *  `startedAt`.** The group is stamped with the bucket floor of the session's
 *  first request, which is at or before the exact start (`FACT_BUCKET_MS`), so
 *  a `>=` test would reject the very group it is looking for on almost every
 *  real session. The session id already says which groups are this session's.
 *  Null where the card had not sent a request under that session yet. */
function openedModel(life: CardLife, session: SessionFact): string {
  const inside = life.spend
    .filter((g) => g.session === session.session)
    .sort((a, b) => a.firstAt - b.firstAt);
  return inside[0]?.model ?? "";
}

/** The timeline, oldest first.
 *
 *  **A move row is never dropped and never guessed at.** The derived `spend`
 *  rows exist for the transitions the move record does not have — a wall from
 *  before moves were kept, or a change the ingest saw and the gesture did not —
 *  and each is suppressed when a session or a move already explains that
 *  instant, so the same transition is not drawn twice in two vocabularies. */
export function timeline(life: CardLife): LifeRow[] {
  const rows: LifeRow[] = [];
  const sessions = [...life.sessions].sort((a, b) => a.startedAt - b.startedAt);
  const born = sessions[0]?.startedAt ?? 0;
  for (const [i, s] of sessions.entries()) {
    rows.push({
      at: s.startedAt,
      verb: i === 0 ? "opened" : "session",
      target: fundingSaid(s.accountFirst, openedModel(life, s)),
      reason: null,
    });
  }
  for (const m of life.moves) {
    rows.push({ at: m.at, verb: m.kind as LifeVerb, target: m.reference, reason: "reason unknown" });
  }
  /* The spend groups, in the order their funding began. A group that is the
     first in its session is already named by that session's row (which carries
     the funding and model it opened on), so it never draws a second row. What
     is left is a mid-session change, and it is drawn only when no move row
     between the previous group and it accounts for the change — `since` is what
     has already been explained. */
  const groups = [...life.spend].sort((a, b) => a.firstAt - b.firstAt);
  let since = born;
  for (const g of groups) {
    /* Only a session the card's own rows know is named by a session row; spend
       under a session no row records is a transition nothing else explains. */
    const known = sessions.some((s) => s.session === g.session);
    const firstOfSession =
      known && !groups.some((o) => o !== g && o.session === g.session && o.firstAt < g.firstAt);
    /* **A move at 12:06:23 is followed by a group stamped 12:05:00**, so the
       comparison has to reach the end of the group's own bucket. Within it,
       the move's value need not be matched: the instant is what proves the
       transition, and a `/model` alias never string-matches the bare id the
       request carried anyway. */
    const explained =
      firstOfSession ||
      life.moves.some((m) => m.at > since && m.at <= g.firstAt + FACT_BUCKET_MS);
    /* No session rows at all is a card in the minute before the collector has
       written one: its spend is still a fact, and the first group is the only
       evidence of when and on what it began. */
    if (!explained && g.firstAt > 0) {
      rows.push({ at: g.firstAt, verb: "spend", target: fundingSaid(g.account, g.model), reason: null });
    }
    since = Math.max(since, g.firstAt);
  }
  const rank = (v: LifeVerb) => (v === "opened" ? 0 : v === "session" ? 1 : 2);
  const seen = new Set<string>();
  return rows
    .sort((a, b) => a.at - b.at || rank(a.verb) - rank(b.verb) || (a.target < b.target ? -1 : 1))
    .filter((r) => {
      const key = `${r.at}\u0000${r.verb}\u0000${r.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* ── the whole reading ───────────────────────────────────────────────────── */

export type LifeModel = {
  card: string;
  label: string;
  /** The chip: what it is on now. Never the caption of the total. */
  now: { account: string; model: string; session: string };
  born: number;
  /** The last instant the card was known to be alive: its last session's end,
   *  or now when a session is still open. */
  lived: number;
  open: boolean;
  sessions: number;
  turns: number;
  /** All-time reported dollars. */
  usd: number;
  perTurn: number | null;
  /** Tokens and requests over the facts the wall still holds. */
  tokens: number;
  requests: number;
  unpriced: number;
  payer: ReturnType<typeof sharesOf>;
  model: ReturnType<typeof sharesOf>;
  timeline: LifeRow[];
  /** The token half covers less than the card's life. */
  partial: boolean;
  factsFrom: number;
};

export function lifeModel(life: CardLife, now: number): LifeModel {
  const sessions = [...life.sessions].sort((a, b) => a.startedAt - b.startedAt);
  const born = sessions[0]?.startedAt ?? 0;
  const open = sessions.some((s) => s.endedAt === null);
  const last = sessions.reduce<number>((most, s) => Math.max(most, s.endedAt ?? 0), 0);
  const lived = born > 0 ? Math.max(0, (open ? now : last || born) - born) : 0;
  const payer = sharesOf(life.spend, "account");
  const model = sharesOf(life.spend, "model");
  return {
    card: life.card,
    label: life.label,
    now: { account: life.nowAccount, model: life.nowModel, session: life.nowSession },
    born,
    lived,
    open,
    sessions: sessions.length,
    turns: life.turns,
    usd: life.usdReported,
    perTurn: life.turns > 0 && Number.isFinite(life.usdReported) ? life.usdReported / life.turns : null,
    tokens: payer.tokens,
    requests: life.spend.reduce((sum, g) => sum + g.requests, 0),
    unpriced: payer.unpriced,
    payer,
    model,
    timeline: timeline(life),
    partial: born > 0 && life.factsFrom > 0 && life.factsFrom > born + NEAR,
    factsFrom: life.factsFrom,
  };
}

/* ── saying it ───────────────────────────────────────────────────────────── */

/** How long a card lived, in two parts at most. */
export function livedSaid(ms: number): string {
  if (!(ms > 0)) return "less than a minute";
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < DAY) {
    let h = Math.floor(ms / 3_600_000);
    let m = Math.round((ms - h * 3_600_000) / 60_000);
    /* Forty seconds short of four hours rounds to `3h 60m`, which is a string
       nobody should ever read. */
    if (m === 60) {
      h += 1;
      m = 0;
    }
    return m > 0 && h < 6 ? `${h}h ${m}m` : `${h} hours`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.round((ms - d * DAY) / 3_600_000);
  const days = `${d} ${d === 1 ? "day" : "days"}`;
  if (h === 0) return days;
  if (h === 24) return `${d + 1} days`;
  return `${days} ${h}h`;
}

/** The line under the total: what the bar is a share of, in the words the
 *  honesty rules ask for. `now` is what decides whether the date carries its
 *  year, and a caller that leaves it out gets the date's own year, which is
 *  never the interesting case. */
export function splitSaid(model: LifeModel, now = Date.now()): string {
  if (model.tokens === 0) {
    return model.partial
      ? "no requests in the facts this wall still holds"
      : "no requests recorded for this card";
  }
  if (model.partial) {
    return `the fine tier keeps ninety days; the token half begins ${daySaid(model.factsFrom, now)}`;
  }
  return "";
}

/** A short local date, `9 Nov`, and its year when it is not this one.
 *
 *  Pure arithmetic on the local clock rather than `toLocaleDateString`, so the
 *  tests read the same in every timezone — the same reason `prompt.ts`'s day
 *  keys are built by hand. */
export function daySaid(at: number, now = at): string {
  if (!(at > 0)) return "—";
  const d = new Date(at);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return `${d.getDate()} ${months[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}`;
}

/** A row of the timeline as one sentence, without the time (the row draws it in
 *  its own column). */
export function rowSaid(row: LifeRow): string {
  switch (row.verb) {
    case "opened":
      return row.target ? `opened on ${row.target}` : "opened";
    case "session":
      return row.target ? `new session on ${row.target}` : "new session";
    case "account":
      return `moved to ${row.target || "an unrecorded account"}`;
    case "provider":
      return `swapped to ${row.target || "an unrecorded provider"}`;
    case "model":
      return `model changed to ${row.target || "an unrecorded model"}`;
    case "spend":
      return `first spent on ${row.target}`;
  }
}

/** The chip and the lede, said once so the room and the page cannot word the
 *  same card differently. */
export function nowSaid(model: LifeModel): string {
  const funding = fundingSaid(model.now.account, model.now.model);
  return funding ? `now on ${funding}` : "nothing recorded";
}
