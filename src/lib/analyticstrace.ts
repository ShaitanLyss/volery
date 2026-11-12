/* The prompt trace and the hall (docs/ANALYTICS.md §11.11, §11.12): every
 * decision behind the two drawings, and nothing that needs a wall.
 *
 * The trace is the page the vault exists for. Its rows are prompt **facts** —
 * the form, never the words — so day grouping, the filters, the labels and the
 * strip's rates are all arithmetic over numbers. A body is a separate read, made
 * only when the vault is open, and it never passes through anything in this
 * file: the reader hands it to the component that draws it and it is dropped
 * when the detail closes.
 *
 * **A prompt kind is a label, not a palette.** The seven kinds are drawn in
 * chrome ink in the same face as everything else; the wall's rule is that colour
 * means status (working, asking, failed), and a kind is not a state. The chart
 * palette is untouched by this lane for the same reason.
 *
 * **There is no full-text search and there will not be one.** A prompt's words
 * are sealed, and an index over sealed bodies would be a second copy of exactly
 * what the vault protects. Search here is by the facts: kind, project, day,
 * card. A row from another wall is drawn from its synced counts, which is what
 * makes the trace a fleet reading rather than a local one.
 *
 * Pure: no Tauri, no runes, no `localStorage`. Tested by
 * `test/analyticstrace.test.ts`.
 */

import { dateLine } from "./clock";
import { handleOf } from "./relay";
import { count, money } from "./usage";

/* ── the vocabulary §3.8 published ──────────────────────────────────────── */

export type PromptKind =
  | "design"
  | "redirect"
  | "nudge"
  | "task"
  | "question"
  | "issue"
  | "other";

/** The seven kinds in the order `prompt.rs` declares them, held to it by
 *  `test/prompt.test.ts`. Display only. */
export const PROMPT_KINDS: readonly PromptKind[] = [
  "design",
  "redirect",
  "nudge",
  "task",
  "question",
  "issue",
  "other",
];

export function isPromptKind(raw: unknown): raw is PromptKind {
  return typeof raw === "string" && (PROMPT_KINDS as readonly string[]).includes(raw);
}

/** What the row is, after a correction. `kind_override` is local and visible,
 *  and the trace draws the corrected kind everywhere because that is the one
 *  the person meant. */
export function effectiveKind(row: { kind: string; kindOverride?: string | null }): string {
  return row.kindOverride || row.kind || "other";
}

export function isCorrected(row: { kind: string; kindOverride?: string | null }): boolean {
  return Boolean(row.kindOverride) && row.kindOverride !== row.kind;
}

/* ── one fact, as the trace reads it ────────────────────────────────────── */

/** `analytics.rs::PromptRow`, camelCased by serde. The form counts are here;
 *  the body is not, and cannot be: the command that returns a row has never
 *  opened a blob. */
export type PromptRow = {
  host: string;
  promptId: string;
  at: number;
  hour: number;
  seenCount: number;
  session: string;
  card: string;
  project: string;
  source: string;
  account: string;
  provider: string;
  vaultId: string;
  kind: string;
  kindOverride: string | null;
  chars: number;
  words: number;
  lines: number;
  fences: number;
  codeLines: number;
  images: number;
  questions: number;
  redactions: number;
  withheld: number;
  /** `sealed`, `locked`, `withheld`, `deleted` or `none`. */
  bodyState: string;
  bodyTruncated: number;
};

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** One row off the wire, made drawable.
 *
 * The same bargain every opaque answer here strikes: a field that will not
 * parse becomes the shape's zero rather than a NaN in a template, and a row
 * with no identity is dropped rather than drawn as a nameless line.
 */
export function asPromptRow(raw: unknown): PromptRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const host = str(r.host);
  const promptId = str(r.promptId);
  if (!host || !promptId) return null;
  return {
    host,
    promptId,
    at: num(r.at),
    hour: num(r.hour),
    seenCount: num(r.seenCount, 1),
    session: str(r.session),
    card: str(r.card),
    project: str(r.project, "unknown"),
    source: str(r.source),
    account: str(r.account),
    provider: str(r.provider),
    vaultId: str(r.vaultId),
    kind: str(r.kind, "other"),
    kindOverride: typeof r.kindOverride === "string" && r.kindOverride ? r.kindOverride : null,
    chars: num(r.chars),
    words: num(r.words),
    lines: num(r.lines),
    fences: num(r.fences),
    codeLines: num(r.codeLines),
    images: num(r.images),
    questions: num(r.questions),
    redactions: num(r.redactions),
    withheld: num(r.withheld),
    bodyState: str(r.bodyState, "none"),
    bodyTruncated: num(r.bodyTruncated),
  };
}

export function asPromptRows(raw: unknown): PromptRow[] {
  return Array.isArray(raw)
    ? raw.map(asPromptRow).filter((r): r is PromptRow => r !== null)
    : [];
}

/* ── time, in the reader's own day ──────────────────────────────────────── */

/** Local midnight of the day `at` falls in.
 *
 * `prompt_facts` takes the window from its caller because Rust does not know
 * where midnight is (`usage.md`'s argument for `spend_since`), and a local day
 * is 23 or 25 hours twice a year. This is that arithmetic, done here. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `days` calendar days from `at`, in local time.
 *
 * Not `at + days * 24h`: a local day is 23 or 25 hours twice a year, and
 * adding a fixed day across a transition lands in the wrong one. `setDate`
 * moves the calendar, which is what "yesterday" and "seven days ago" mean. */
export function addDays(at: number, days: number): number {
  const d = new Date(at);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** `2026-11-11`, in local time. The grouping key and the day filter's value. */
export function dayKey(at: number): string {
  const d = new Date(at);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** How far back the trace reads by default: the last seven local days, ending
 *  now. A week is what `prompt_hour` keeps richly and what a person can still
 *  recognise; a month of prompts is a different page (the evolution view). */
export const TRACE_DAYS = 7;

export function traceWindow(now: number, days = TRACE_DAYS): { from: number; to: number } {
  const from = startOfDay(addDays(now, -(Math.max(1, days) - 1)));
  return { from, to: now + 1 };
}

/** The day, said for a header. `today` and `yesterday` are the two a person
 *  thinks in; everything else is the date the clock widget would say. */
export function dayLabel(day: string, now: number): string {
  if (day === dayKey(now)) return "today";
  if (day === dayKey(addDays(now, -1))) return "yesterday";
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return dateLine(new Date(y, m - 1, d).getTime()).toLowerCase();
}

export type PromptDay = {
  /** `YYYY-MM-DD`. */
  day: string;
  /** Local midnight, for sorting and for the next/previous page. */
  at: number;
  label: string;
  rows: PromptRow[];
};

/** Rows grouped by local day, newest day first and newest prompt first inside
 *  one. A trace is read from the top backwards in time, which is how a
 *  transcript is read. */
export function groupByDay(rows: readonly PromptRow[], now: number): PromptDay[] {
  const days = new Map<string, PromptRow[]>();
  for (const row of rows) {
    const key = dayKey(row.at);
    const list = days.get(key);
    if (list) list.push(row);
    else days.set(key, [row]);
  }
  return [...days.entries()]
    .map(([day, list]) => {
      const ordered = [...list].sort((a, b) => b.at - a.at || a.promptId.localeCompare(b.promptId));
      const [y, m, d] = day.split("-").map(Number);
      return {
        day,
        at: new Date(y, m - 1, d).getTime(),
        label: dayLabel(day, now),
        rows: ordered,
      };
    })
    .sort((a, b) => b.at - a.at);
}

/* ── the filters, which are facts and never words ───────────────────────── */

export type PromptFilter = {
  /** A kind, or absent for every kind. Matched against the effective kind. */
  kind?: string | null;
  project?: string | null;
  /** `YYYY-MM-DD`. */
  day?: string | null;
};

export function filterPrompts(rows: readonly PromptRow[], filter: PromptFilter): PromptRow[] {
  return rows.filter((row) => {
    if (filter.kind && effectiveKind(row) !== filter.kind) return false;
    if (filter.project && row.project !== filter.project) return false;
    if (filter.day && dayKey(row.at) !== filter.day) return false;
    return true;
  });
}

export function projectsOf(rows: readonly PromptRow[]): string[] {
  return [...new Set(rows.map((r) => r.project))].filter(Boolean).sort();
}

/** The days present in `rows`, newest first, each with how many prompts it
 *  holds before any filter cuts them. */
export function daysOf(rows: readonly PromptRow[], now: number): { day: string; label: string; n: number }[] {
  const n = new Map<string, number>();
  for (const row of rows) {
    const key = dayKey(row.at);
    n.set(key, (n.get(key) ?? 0) + 1);
  }
  return [...n.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, count]) => ({ day, label: dayLabel(day, now), n: count }));
}

/* ── what a row says, in one line per cell ──────────────────────────────── */

/** The card a prompt was said in, or the session when the card had no title.
 *  A prompt typed into a terminal has no card, and saying `terminal` is more
 *  honest than an empty cell. */
export function cardLabel(row: Pick<PromptRow, "card" | "session" | "source">): string {
  if (row.card) return row.card;
  /* `handleOf` rather than a second spelling of it: cutting an id to a handle
     is defined once, and this is the same eight characters a relay, a board
     post and a card elsewhere are addressed by. */
  if (row.session) return handleOf(row.session);
  return row.source || "terminal";
}

export function lengthLabel(row: { words: number; chars?: number }): string {
  if (row.words > 0) return `${count(row.words)} ${row.words === 1 ? "word" : "words"}`;
  if (row.chars && row.chars > 0) return `${count(row.chars)} chars`;
  return "no text";
}

export function redactionLabel(row: Pick<PromptRow, "redactions" | "withheld">): string {
  if (row.withheld > 0) return "withheld";
  if (row.redactions > 0) return `${count(row.redactions)} redacted`;
  return "clean";
}

export type BodyTag = "sealed" | "locked" | "withheld" | "deleted" | "none";

/** What the body column says. `none` is a row recorded before the vault
 *  existed, which is a different thing from one whose body was deleted. */
export function bodyTag(row: Pick<PromptRow, "bodyState">): BodyTag {
  return row.bodyState === "sealed" ||
    row.bodyState === "locked" ||
    row.bodyState === "withheld" ||
    row.bodyState === "deleted"
    ? row.bodyState
    : "none";
}

export function bodyTagLabel(tag: BodyTag): string {
  switch (tag) {
    case "sealed":
      return "sealed";
    case "locked":
      return "locked";
    case "withheld":
      return "withheld";
    case "deleted":
      return "forgotten";
    default:
      return "form only";
  }
}

/** The sentence the detail pane uses when there is no body to draw. Each says
 *  what state the row is in and what, if anything, can change it. */
export function bodyNote(tag: BodyTag, vaultReady: boolean): string {
  switch (tag) {
    case "sealed":
      return vaultReady
        ? "sealed under the vault, and open: reading it here unseals it for this pane only"
        : "sealed under the vault. unlock it to read the redacted words";
    case "locked":
      return vaultReady
        ? "this body was recorded while the vault was locked. seal pending will take it from its transcript if the transcript is still there"
        : "the form was recorded while the vault was locked. the text is still in its transcript, and seal pending can keep it once the vault is open";
    case "withheld":
      return "the redactor refused this body: it held more secrets than it could safely take out, so the form was kept and the words were not";
    case "deleted":
      return "the body was forgotten. the counts and the door remain, which is what keeps the week's mix honest";
    default:
      return "this prompt was recorded before any body was kept. the form is all there is";
  }
}

/** Whether the detail pane may ask for the words. The preconditions are the
 *  component's and the command's alike: a sealed row under an open vault. */
export function bodyReadable(row: Pick<PromptRow, "bodyState">, vaultReady: boolean): boolean {
  return vaultReady && row.bodyState === "sealed";
}

/** The one body read's answer, as the pane draws it. */
export type PromptBody = { state: string; text: string | null; truncated: boolean };

export function asPromptBody(raw: unknown): PromptBody {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    state: str(r.state, "locked"),
    text: typeof r.text === "string" ? r.text : null,
    truncated: Boolean(r.truncated),
  };
}

/* ── the strip: form readings, no body required ─────────────────────────── */

export type PromptStats = {
  n: number;
  /** Median words over the rows present. `null` when there are no rows: a sum
   *  cannot produce a median, and neither can an empty list. */
  median: number | null;
  p90: number | null;
  redirectRate: number | null;
  nudgeRate: number | null;
  /** Mean redactions per prompt, which is what "how often did it need cleaning"
   *  means over a window. */
  redactionRate: number | null;
  withheld: number;
  questions: number;
};

/** The `p`-quantile by the nearest-rank rule, on a sorted copy.
 *
 * Over the fine window the percentiles are exact. Over years the hourly
 * rollup's word buckets can only estimate one, which is why §11.11 labels that
 * case as an estimate; this function is the exact half, called with rows. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[at];
}

export function statsOf(rows: readonly PromptRow[]): PromptStats {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      median: null,
      p90: null,
      redirectRate: null,
      nudgeRate: null,
      redactionRate: null,
      withheld: 0,
      questions: 0,
    };
  }
  let redirect = 0;
  let nudge = 0;
  let redactions = 0;
  let withheld = 0;
  let questions = 0;
  for (const row of rows) {
    const kind = effectiveKind(row);
    if (kind === "redirect") redirect += 1;
    if (kind === "nudge") nudge += 1;
    redactions += row.redactions;
    if (row.withheld > 0) withheld += 1;
    questions += row.questions;
  }
  const words = rows.map((r) => r.words);
  return {
    n,
    median: percentile(words, 0.5),
    p90: percentile(words, 0.9),
    redirectRate: redirect / n,
    nudgeRate: nudge / n,
    redactionRate: redactions / n,
    withheld,
    questions,
  };
}

/* ── paging ─────────────────────────────────────────────────────────────── */

export type Page = { rows: PromptRow[]; page: number; pages: number };

/** One page of a day. The read is already bounded by `prompt_facts` (ten
 *  thousand rows, refused rather than truncated); this is the drawing's bound,
 *  because a busy day is a long scroll and the page's own scroll is the thing
 *  that has to stay light. */
export function pageOf(rows: readonly PromptRow[], page: number, size = 40): Page {
  const at = Math.max(0, Math.floor(page));
  const per = Math.max(1, Math.floor(size));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const clamped = Math.min(at, pages - 1);
  return { rows: rows.slice(clamped * per, clamped * per + per), page: clamped, pages };
}

/* ── the vault, as the face reads it ────────────────────────────────────── */

export type VaultRecord = { vaultId: string; createdAt: number; unlocked: boolean };

export type BodyCounts = {
  sealed: number;
  locked: number;
  withheld: number;
  deleted: number;
  none: number;
};

/** `promptvault.rs::VaultState`. Never a passphrase and never a key. */
export type VaultState = {
  vaults: VaultRecord[];
  active: string | null;
  idleMs: number | null;
  bodies: BodyCounts;
  locators: number;
  minPassphrase: number;
};

function vaultRecord(raw: unknown): VaultRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const vaultId = str(r.vaultId);
  if (!vaultId) return null;
  return { vaultId, createdAt: num(r.createdAt), unlocked: Boolean(r.unlocked) };
}

export function asVaultState(raw: unknown): VaultState {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bodies = (r.bodies ?? {}) as Record<string, unknown>;
  return {
    vaults: Array.isArray(r.vaults)
      ? r.vaults.map(vaultRecord).filter((v): v is VaultRecord => v !== null)
      : [],
    active: typeof r.active === "string" && r.active ? r.active : null,
    idleMs: typeof r.idleMs === "number" && Number.isFinite(r.idleMs) ? r.idleMs : null,
    bodies: {
      sealed: num(bodies.sealed),
      locked: num(bodies.locked),
      withheld: num(bodies.withheld),
      deleted: num(bodies.deleted),
      none: num(bodies.none),
    },
    locators: num(r.locators),
    minPassphrase: Math.max(1, num(r.minPassphrase, 12)),
  };
}

/** Whether any vault is open. One answer for the detail pane, the hall and the
 *  seal button, so they cannot disagree about whether a body may be read. */
export function vaultReady(state: VaultState | null): boolean {
  return Boolean(state && state.vaults.some((v) => v.unlocked));
}

export type SealReport = {
  sealed: number;
  withheld: number;
  unresolved: number;
  remaining: number;
  unresolvedIds: string[];
};

export function asSealReport(raw: unknown): SealReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    sealed: num(r.sealed),
    withheld: num(r.withheld),
    unresolved: num(r.unresolved),
    remaining: num(r.remaining),
    unresolvedIds: Array.isArray(r.unresolvedIds)
      ? r.unresolvedIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** What a seal pass did, in one sentence a person can act on. */
export function sealSaid(r: SealReport): string {
  if (r.sealed === 0 && r.withheld === 0 && r.remaining === 0) {
    return "nothing was waiting: every body is already sealed";
  }
  const parts: string[] = [];
  if (r.sealed > 0) parts.push(`${count(r.sealed)} sealed`);
  if (r.withheld > 0) parts.push(`${count(r.withheld)} withheld`);
  if (r.unresolved > 0) parts.push(`${count(r.unresolved)} transcripts gone`);
  if (r.remaining > 0) parts.push(`${count(r.remaining)} still waiting`);
  return parts.join(" · ");
}

export type ForgetReport = { bodies: number; marked: number; tombstones: number; favourites: number };
export type ResetReport = { vaults: number; bodies: number; tombstones: number; notes: number };

export function asForgetReport(raw: unknown): ForgetReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    bodies: num(r.bodies),
    marked: num(r.marked),
    tombstones: num(r.tombstones),
    favourites: num(r.favourites),
  };
}

export function asResetReport(raw: unknown): ResetReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    vaults: num(r.vaults),
    bodies: num(r.bodies),
    tombstones: num(r.tombstones),
    notes: num(r.notes),
  };
}

export function forgetSaid(r: ForgetReport): string {
  const bodies = r.bodies === 1 ? "one body" : `${count(r.bodies)} bodies`;
  const hall = r.favourites > 0 ? `, and ${count(r.favourites)} hall ${r.favourites === 1 ? "entry" : "entries"}` : "";
  return `forgot ${bodies}${hall}; every count is still there`;
}

export function resetSaid(r: ResetReport): string {
  const vaults = r.vaults === 1 ? "one vault" : `${count(r.vaults)} vaults`;
  return `reset ${vaults} and forgot ${count(r.bodies)} bodies. there is no key left, and nothing here can be opened again`;
}

/* ── the hall (§11.12) ──────────────────────────────────────────────────── */

/** One favourite: a marker over a prompt, with the form joined back so the hall
 *  needs no second copy of the body. */
export type FavouriteRow = {
  host: string;
  promptId: string;
  title: string;
  tags: string[];
  createdAt: number;
  at: number;
  project: string;
  kind: string;
  kindOverride: string | null;
  bodyState: string;
  words: number;
  /** The card's own cost and turn count, from its `turn` rows. */
  cost: number;
  turns: number;
  /** The note, unsealed, only when the vault that holds it is open. */
  note: string | null;
  noteLocked: boolean;
};

export function asFavouriteRow(raw: unknown): FavouriteRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const host = str(r.host);
  const promptId = str(r.promptId);
  if (!host || !promptId) return null;
  return {
    host,
    promptId,
    title: str(r.title, "untitled"),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    createdAt: num(r.createdAt),
    at: num(r.at),
    project: str(r.project, "unknown"),
    kind: str(r.kind, "other"),
    kindOverride: typeof r.kindOverride === "string" && r.kindOverride ? r.kindOverride : null,
    bodyState: str(r.bodyState, "none"),
    words: num(r.words),
    cost: num(r.cost),
    turns: num(r.turns),
    note: typeof r.note === "string" ? r.note : null,
    noteLocked: Boolean(r.noteLocked),
  };
}

export function asFavouriteRows(raw: unknown): FavouriteRow[] {
  return Array.isArray(raw)
    ? raw.map(asFavouriteRow).filter((f): f is FavouriteRow => f !== null)
    : [];
}

export type HallFilter = {
  tag?: string | null;
  project?: string | null;
  kind?: string | null;
  year?: number | null;
};

export type HallSort = "date" | "cost";

export function filterFavourites(list: readonly FavouriteRow[], filter: HallFilter): FavouriteRow[] {
  return list.filter((f) => {
    if (filter.tag && !f.tags.includes(filter.tag)) return false;
    if (filter.project && f.project !== filter.project) return false;
    if (filter.kind && effectiveKind(f) !== filter.kind) return false;
    if (filter.year && new Date(f.at).getFullYear() !== filter.year) return false;
    return true;
  });
}

/** Date is the default and means "when you marked it"; cost is the other
 *  question, "which of these started the expensive work". Both tie-break on the
 *  other, so the order is total and a redraw cannot shuffle equal rows. */
export function orderFavourites(list: readonly FavouriteRow[], sort: HallSort): FavouriteRow[] {
  const key = (f: FavouriteRow) => `${f.host}/${f.promptId}`;
  return [...list].sort((a, b) => {
    if (sort === "cost") {
      return b.cost - a.cost || b.createdAt - a.createdAt || key(a).localeCompare(key(b));
    }
    return b.createdAt - a.createdAt || b.cost - a.cost || key(a).localeCompare(key(b));
  });
}

export function hallTags(list: readonly FavouriteRow[]): string[] {
  return [...new Set(list.flatMap((f) => f.tags))].sort();
}

export function hallProjects(list: readonly FavouriteRow[]): string[] {
  return [...new Set(list.map((f) => f.project))].filter(Boolean).sort();
}

export function hallYears(list: readonly FavouriteRow[]): number[] {
  return [...new Set(list.map((f) => new Date(f.at).getFullYear()))].sort((a, b) => b - a);
}

/** What a hall entry says where its note goes. A sealed note is `locked` rather
 *  than absent: an entry that had one is a different reading from one that
 *  never did. */
export function noteLabel(f: Pick<FavouriteRow, "note" | "noteLocked">): string | null {
  if (f.note) return f.note;
  if (f.noteLocked) return "note sealed";
  return null;
}

/** The card's cost, said the way the rest of the surface says money. */
export function costLabel(f: Pick<FavouriteRow, "cost" | "turns">): string {
  if (f.turns === 0) return "no turns recorded";
  return `${f.turns === 1 ? "1 turn" : `${count(f.turns)} turns`} · ${money(f.cost)}`;
}

/* ── the tab, remembered ────────────────────────────────────────────────── */

/** The tabs of one surface (§11.11, §11.14, §11.9): the money, the words, what
 *  the money bought, and how the wall is worked. */
export type SurfaceTab = "spend" | "prompts" | "work" | "behaviour";

/** One key, not one per host mode. The presentation is per mode because the
 *  wall and chat view are different rooms (§11.15); the tab is one surface's own
 *  memory, and a person who was reading prompts in chat view means it when they
 *  open the room too. */
export const TAB_STORE = "skein.analytics.tab";

export function tabFor(raw: string | null): SurfaceTab {
  return raw === "prompts" || raw === "work" || raw === "behaviour" ? raw : "spend";
}

/* ── the reader, as a fixture or as the commands ────────────────────────── */

/** Everything the prompts tab asks of the wall, in one value.
 *
 * The component takes this rather than importing `invoke`, which is what lets
 * `/analytics.html` drive the same drawing with made-up facts and a fake vault.
 * The real one is `promptsread.svelte.ts`; the fixture's is in the preview
 * module beside the window fixture, guarded by the same test that keeps both
 * out of an installer.
 */
export type PromptReader = {
  facts(from: number, to: number): Promise<PromptRow[]>;
  body(host: string, promptId: string): Promise<PromptBody>;
  vault(): Promise<VaultState>;
  createVault(passphrase: string): Promise<VaultState>;
  unlockVault(passphrase: string): Promise<VaultState>;
  lockVault(): Promise<VaultState>;
  sealPending(): Promise<SealReport>;
  forget(): Promise<ForgetReport>;
  resetVault(confirm: boolean): Promise<ResetReport>;
  overrideKind(host: string, promptId: string, kind: string): Promise<void>;
  favourites(): Promise<FavouriteRow[]>;
  keepFavourite(input: {
    host: string;
    promptId: string;
    title: string;
    tags: string[];
    note: string | null;
  }): Promise<FavouriteRow>;
  removeFavourite(host: string, promptId: string): Promise<boolean>;
};
