/* The analytics room (docs/ANALYTICS.md §11): the arguments a component would
 * otherwise hold.
 *
 * `analytics.ts` is the query layer and answers what the numbers mean. This is
 * the step between that and a face: which storage tier answers a span, how a
 * window of facts becomes a handful of series with stable colours, where the
 * gaps are, what a bucket is called, and what an unanswerable reading prints.
 * Pure, so every one of those is tested directly in
 * `test/analyticsroom.test.ts` — a chart is very hard to read a bug out of.
 *
 * Four rules, and each is here rather than in the component because a rule that
 * lives in a template is one nobody can test:
 *
 *  - **A gap is not a zero.** `runsOf` breaks a series where the recorded
 *    buckets are not adjacent, and the face draws the break as nothing at all.
 *    The same rule `series` states for a row that is missing.
 *  - **The series keeps its slot by identity, not by rank in the view.** The
 *    split is ordered by size, but a colour is handed out in that fixed order
 *    and never cycled; past the ceiling the remainder folds to one series in a
 *    text token, which cannot be mistaken for a sixth identity (§10.1).
 *  - **A tier decision is made once.** `windowTier` is the only place the
 *    48-hour boundary lives on this side, and `analytics.rs` enforces the same
 *    number, so a disagreement fails loudly instead of truncating.
 *  - **Null is a reading.** A ratio with no denominator is `null` all the way to
 *    the face, which prints a dash; no NaN, no Infinity and no zero reaches a
 *    frame.
 */

import { dateLine } from "./clock";
import {
  BUCKET_MS,
  SERIES_CEILING,
  SERIES_FOLD,
  autoBucket,
  coarser,
  dimsOf,
  fold,
  money,
  pct,
  series,
  seriesColor,
  spanMsOf,
  tokens,
  type Bucket,
  type MeasureKey,
  type Point,
  type UsageRow,
} from "./analytics";
import { HOUR, count } from "./usage";

/* ── which tier answers ────────────────────────────────────────────────────*/

/** The widest span read from the five-minute facts. The matching constant is
 *  `analytics.rs::FINE_WINDOW_MS`, and the two are the same number on purpose:
 *  the command refuses a wider fine request rather than answering it slowly. */
export const FINE_WINDOW_MS = 48 * HOUR;

export type WindowTier = "fine" | "hourly";

export function windowTier(spanMs: number): WindowTier {
  return spanMs <= FINE_WINDOW_MS ? "fine" : "hourly";
}

/** What the command is asked for, and the one place a span becomes two
 *  instants. `until` is *now*, so the last bucket is the one in progress. */
export type WindowRequest = { since: number; until: number; fine: boolean };

export function windowRequest(span: string, now: number): WindowRequest {
  const spanMs = spanMsOf(span) ?? 7 * 24 * HOUR;
  return { since: now - spanMs, until: now, fine: windowTier(spanMs) === "fine" };
}

/** The rung the chart draws: `auto`, clamped to the grain the answering tier
 *  actually recorded. A five-minute answer cannot be drawn at one minute, and
 *  an hourly one cannot be drawn at five. */
export function roomBucket(spanMs: number, tier: WindowTier): Bucket {
  const grain: Bucket = tier === "fine" ? "5m" : "1h";
  return coarser(autoBucket(spanMs), grain);
}

/* ── the controls' vocabulary ──────────────────────────────────────────────*/

/** The spans the room offers, as the doc's presets trimmed to the five that
 *  answer without a calendar. `said` is the phrase under the title. */
export const SPANS: readonly { span: string; label: string; said: string }[] = [
  { span: "24h", label: "24h", said: "the last 24 hours" },
  { span: "7d", label: "7d", said: "the last 7 days" },
  { span: "30d", label: "30d", said: "the last 30 days" },
  { span: "90d", label: "90d", said: "the last 90 days" },
  { span: "1y", label: "1y", said: "the last year" },
];

export const DEFAULT_SPAN = "7d";

export type RoomMeasure = "usd_modeled" | "tokens";

export const ROOM_MEASURES: readonly { key: RoomMeasure; label: string; said: string }[] = [
  { key: "usd_modeled", label: "spend", said: "modeled spend" },
  { key: "tokens", label: "tokens", said: "every token kind" },
];

/** One dimension at a time (§11.2: split is a panel's, never two axes). */
export type RoomSplit = null | "project" | "account" | "model" | "host";

/** **`machine` is a split, not a filter.** The rail has offered `machine` since
 *  the fleet was one wall's, and a filter answers "show me the laptop" while a
 *  split answers "show me all three summed, side by side" — which is the
 *  reading §8 exists for: one person on several machines, each line its own
 *  contribution to the total. It is labelled `machine` because that is what the
 *  rail calls it, and one word for one thing. */
export const ROOM_SPLITS: readonly { key: RoomSplit; label: string }[] = [
  { key: null, label: "none" },
  { key: "project", label: "project" },
  { key: "account", label: "account" },
  { key: "model", label: "model" },
  { key: "host", label: "machine" },
];

/* ── the window, read defensively ──────────────────────────────────────────*/

export type AnalyticsWindow = {
  tier: WindowTier;
  since: number;
  until: number;
  /** Rows the query layer folds. A row that cannot be read is dropped rather
   *  than folded as a zero. */
  rows: UsageRow[];
  /** Cards whose session overlaps the window. */
  cards: number;
  /** The earliest instant the store holds, or null when nothing is recorded.
   *  Only answered for an empty window — the empty state is the one reader, and
   *  one of the queries behind it is the read's only unindexed scan. */
  first: number | null;
  /** Requests across the whole store. Zero on a window with rows, for the same
   *  reason `first` is null there. */
  recorded: number;
};

/** A reader is the command, or a fixture. */
export type WindowReader = (span: string, now: number) => Promise<AnalyticsWindow>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One row, or null when it has no clock. The numbers a missing field would
 *  otherwise contribute are zero, which is what the schema's own defaults say;
 *  a row with no time at all cannot be placed in a bucket and is dropped. */
function asRow(raw: unknown): UsageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const base = {
    host: str(r.host),
    account: str(r.account),
    provider: str(r.provider),
    model: str(r.model),
    effort: str(r.effort),
    cli: str(r.cli),
    source: str(r.source),
    project: str(r.project),
    provenance: r.provenance === "turn" ? ("turn" as const) : ("transcript" as const),
    inTok: num(r.inTok) ?? 0,
    outTok: num(r.outTok) ?? 0,
    cacheRead: num(r.cacheRead) ?? 0,
    write5m: num(r.write5m) ?? 0,
    write1h: num(r.write1h) ?? 0,
    requests: num(r.requests) ?? 0,
    usdReported: num(r.usdReported) ?? 0,
  };
  const hour = num(r.hour);
  if (hour !== null) return { hour, ...base };
  const at = num(r.at);
  if (at === null) return null;
  return {
    at,
    ...base,
    session: str(r.session),
    agent: str(r.agent),
    parentAgent: str(r.parentAgent),
    depth: num(r.depth) ?? 0,
    accountIdentity: str(r.accountIdentity),
  };
}

/** The command's answer, made safe to draw. The `widget.config_json` bargain
 *  one layer down: an unknown tier degrades to the one that cannot lie about
 *  resolution, a missing bound becomes now, and a row that will not parse is
 *  dropped rather than folded as a zero. */
export function asWindow(raw: unknown): AnalyticsWindow {
  const now = Date.now();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { tier: "hourly", since: now, until: now, rows: [], cards: 0, first: null, recorded: 0 };
  }
  const r = raw as Record<string, unknown>;
  const since = num(r.since) ?? now;
  const until = num(r.until) ?? now;
  const rows = Array.isArray(r.rows)
    ? r.rows.map(asRow).filter((x): x is UsageRow => x !== null)
    : [];
  return {
    tier: r.tier === "fine" ? "fine" : "hourly",
    since,
    until,
    rows,
    cards: Math.max(0, Math.trunc(num(r.cards) ?? 0)),
    first: num(r.first),
    recorded: Math.max(0, Math.trunc(num(r.recorded) ?? 0)),
  };
}

/* ── a window into series ──────────────────────────────────────────────────*/

export type RoomSeries = {
  /** The split value this series is, or `other` for the fold, or `""`. */
  key: string;
  label: string;
  /** The palette slot, or null for the fold, which is a text token and not an
   *  identity. */
  slot: number | null;
  color: string;
  points: Point[];
  total: number;
  /** Rows in this group the measure could not answer. A series with no points
   *  but unpriced rows is *unknown*, not free, and the face prints a dash. */
  unpriced: number;
};

/** A value's palette slot, remembered for as long as the book lives.
 *
 * §10.1 is explicit: *"a filter that changes the series count does not repaint
 * the survivors, because the series keeps its slot by identity."* So a slot is
 * never handed out by rank — sorting by size would repaint two series the
 * moment they swapped — and it is never cycled. A value keeps the slot it was
 * given; a new value takes the lowest one still free; past five, null means the
 * fold.
 *
 * The book is per split dimension and the caller owns it (the room clears it
 * when the dimension changes): a project's slot means nothing in an account
 * chart, and one book for both would starve the second of hues. */
export type SlotBook = Map<string, number>;

export function slotFor(key: string, book: SlotBook, taken: Set<number>): number | null {
  const held = book.get(key);
  if (held !== undefined) {
    taken.add(held);
    return held;
  }
  /* A slot the book has already given away is not free, even when the value
     holding it is absent from this window. Reading only `taken` — this
     window's series — is how a value loses its colour the first time a window
     contains it and the one it displaced: the absent holder's hue looks free,
     gets handed out, and the next window containing both has to repaint one of
     them. */
  const owned = new Set(book.values());
  for (let i = 0; i < SERIES_CEILING; i += 1) {
    if (!owned.has(i) && !taken.has(i)) {
      book.set(key, i);
      taken.add(i);
      return i;
    }
  }
  return null;
}

/** The window as series, ordered by size so the legend reads biggest first, and
 *  coloured by identity so a change of window does not repaint them.
 *
 * Past the ceiling the rest is summed into one `other` series in the fold
 * colour: five identities is where the palette stops, and a sixth hue would be
 * a colour nobody can tell from the five (§10.1). `book` is what makes a
 * survivor keep its slot across a read; without one every call starts fresh. */
export function splitSeries(
  rows: readonly UsageRow[],
  measure: RoomMeasure,
  bucket: Bucket,
  split: RoomSplit,
  book: SlotBook = new Map(),
): RoomSeries[] {
  const key = measure as MeasureKey;
  if (!split) {
    const one = series(rows, key, bucket);
    return [
      {
        key: "",
        label: "",
        slot: 0,
        color: seriesColor(0),
        points: one.points,
        total: sum(one.points),
        unpriced: one.unpriced,
      },
    ];
  }

  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const value = dimsOf(row)[split] ?? "";
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }

  const sized = [...groups.entries()]
    .map(([value, group]) => {
      const one = series(group, key, bucket);
      return {
        key: value,
        label: value || "unnamed",
        points: one.points,
        total: sum(one.points),
        unpriced: one.unpriced,
      };
    })
    .sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const taken = new Set<number>();
  const kept: RoomSeries[] = [];
  const folded: typeof sized = [];
  for (const s of sized) {
    const slot = slotFor(s.key, book, taken);
    if (slot === null) folded.push(s);
    else kept.push({ ...s, slot, color: seriesColor(slot) });
  }
  if (!folded.length) return kept;

  const points = new Map<number, number>();
  for (const s of folded) for (const p of s.points) points.set(p.at, (points.get(p.at) ?? 0) + p.value);
  const other: RoomSeries = {
    key: "other",
    label: "other",
    slot: null,
    color: SERIES_FOLD,
    points: [...points.entries()].map(([at, value]) => ({ at, value })).sort((a, b) => a.at - b.at),
    total: folded.reduce((a, s) => a + s.total, 0),
    unpriced: folded.reduce((a, s) => a + s.unpriced, 0),
  };
  return [...kept, other];
}

function sum(points: readonly Point[]): number {
  let total = 0;
  for (const p of points) total += p.value;
  return total;
}

/** Where a stretch of instants breaks. Two recorded buckets further apart than
 *  one and a half bucket-widths are not neighbours: something was not recorded
 *  in between, and a line drawn across it would claim a value for a time the
 *  store knows nothing about. The half is slack for a local day that is an hour
 *  longer across a DST change.
 *
 *  This is the single statement of that rule. `runsOf` is the same thing over
 *  points, and the chart — which works on the union of every series' instants —
 *  calls this one: a rule written twice is a rule that gets fixed once. */
function runsByAt<T extends { at: number }>(items: readonly T[], bucket: Bucket): T[][] {
  const gap = BUCKET_MS[bucket] * 1.5;
  const runs: T[][] = [];
  let run: T[] = [];
  for (const item of items) {
    if (run.length && item.at - run[run.length - 1].at > gap) {
      runs.push(run);
      run = [];
    }
    run.push(item);
  }
  if (run.length) runs.push(run);
  return runs;
}

/** The rule over a set of instants, which is what the chart holds: the union of
 *  every series' buckets rather than one series' points. */
export function runsOfTimes(times: readonly number[], bucket: Bucket): number[][] {
  return runsByAt(
    times.map((at) => ({ at })),
    bucket,
  ).map((run) => run.map((x) => x.at));
}

/** The same rule over points, for a caller holding one series rather than the
 *  union. Linear, like the rule it wraps: a `find` per point would be the wrong
 *  shape for the one place this runs on every redraw. */
export function runsOf(points: readonly Point[], bucket: Bucket): Point[][] {
  return runsByAt(points, bucket);
}

/** Every instant any series has a reading at, sorted. A bucket no series saw
 *  is simply absent, which is what makes it a gap rather than a zero. */
export function timesOf(list: readonly RoomSeries[]): number[] {
  const seen = new Set<number>();
  for (const s of list) for (const p of s.points) seen.add(p.at);
  return [...seen].sort((a, b) => a - b);
}

/** The value each series carries at each instant of the axis, so a stacked band
 *  and the tooltip read from one table rather than two loops that can disagree. */
export type BucketReading = {
  at: number;
  total: number;
  parts: { key: string; label: string; color: string; value: number }[];
};

export function readingsOf(list: readonly RoomSeries[]): Map<number, BucketReading> {
  const out = new Map<number, BucketReading>();
  for (const s of list) {
    for (const p of s.points) {
      const reading = out.get(p.at) ?? { at: p.at, total: 0, parts: [] };
      reading.parts.push({ key: s.key, label: s.label, color: s.color, value: p.value });
      reading.total += p.value;
      out.set(p.at, reading);
    }
  }
  /* Not re-sorted by this bucket's value. The band order is the series order,
     which is settled once for the whole window: a stack whose bands swap places
     bucket to bucket is a chart with crossed bands and nothing to read. */
  return out;
}

/** The bucket nearest an instant a pointer is over. Null when the axis is
 *  empty, which is a window with no rows rather than a window of zeros. */
export function nearestAt(times: readonly number[], at: number): number | null {
  if (!times.length) return null;
  let best = times[0];
  let bestGap = Math.abs(times[0] - at);
  for (const t of times) {
    const gap = Math.abs(t - at);
    if (gap < bestGap) {
      best = t;
      bestGap = gap;
    }
  }
  return best;
}

/** Move the selection one bucket along the axis, clamped at the ends. */
export function stepAt(times: readonly number[], current: number | null, delta: number): number | null {
  if (!times.length) return null;
  if (current === null) return delta > 0 ? times[0] : times[times.length - 1];
  const i = times.indexOf(current);
  if (i === -1) return nearestAt(times, current);
  return times[Math.min(times.length - 1, Math.max(0, i + delta))];
}

/* ── the axis ──────────────────────────────────────────────────────────────*/

export type Axis = { top: number; ticks: number[] };

/** A top and four divisions, rounded up to 1, 2, 2.5 or 5 times a power of ten.
 *  Rounded rather than fitted so the gridlines are numbers a person reads
 *  without dividing. */
export function niceAxis(max: number, divisions = 4): Axis {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 0, ticks: [] };
  const raw = max / divisions;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const top = step * divisions;
  const ticks: number[] = [];
  for (let i = 0; i <= divisions; i += 1) ticks.push(Number((step * i).toPrecision(12)));
  return { top, ticks };
}

const HHMM = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A bucket's name where there is room for it: the tooltip, the inspector and
 *  the table. */
export function bucketLabel(at: number, bucket: Bucket): string {
  if (bucket === "1w") return `week of ${dateLine(at)}`;
  if (bucket === "1d") return dateLine(at);
  return `${dateLine(at)} ${HHMM(new Date(at))}`;
}

/** A bucket's name where there is not: the axis. The day is dropped for a
 *  weekly rung, whose day is always monday, and kept for a day rung, whose
 *  month is what changes. */
export function tickLabel(at: number, bucket: Bucket): string {
  if (bucket === "1w") return dateLine(at).split(" ").slice(1).join(" ");
  if (bucket === "1d") return dateLine(at).split(" ").slice(1).join(" ");
  return `${dateLine(at).split(" ")[0]} ${HHMM(new Date(at))}`;
}

/** Direct labels for a chart with four series or more (§10.3), pushed apart so
 *  no two overlap and none leaves the plot.
 *
 *  Sorted by wanted position, then each is pushed to at least `gap` below the
 *  one before; if that runs off the bottom the whole set is lifted by the
 *  overflow, and finally the top is clamped. Two labels wanting the same line
 *  is the case this exists for: the thinnest band in a stack is often the
 *  biggest spender, and its label would otherwise sit on its neighbour's. */
export function spreadLabels<T extends { y: number }>(entries: readonly T[], gap: number, lo: number, hi: number): T[] {
  if (!entries.length) return [];
  const out = entries.map((e) => ({ ...e })) as T[];
  out.sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i += 1) out[i].y = Math.max(out[i].y, out[i - 1].y + gap);
  const over = out[out.length - 1].y - hi;
  if (over > 0) for (const e of out) e.y -= over;
  for (const e of out) e.y = Math.max(lo, e.y);
  return out;
}

/* ── saying numbers ────────────────────────────────────────────────────────*/

/** A measure on a face: money or tokens, with the unit. Null and a non-number
 *  both print a dash, because a ratio whose divisor is zero has no value and
 *  printing one would invent it (§9.1). */
export function measureText(measure: RoomMeasure, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return measure === "usd_modeled" ? money(value) : tokens(value);
}

/** A measure on an axis, where the unit is the axis's own title and repeating
 *  it on every tick would leave room for four labels instead of six. */
export function tickText(measure: RoomMeasure, value: number): string {
  if (!Number.isFinite(value)) return "";
  return measure === "usd_modeled" ? money(value) : count(value);
}

/** A share already in percent, or a dash when there is no denominator. */
export function shareText(share: number | null): string {
  return share === null || !Number.isFinite(share) ? "" : pct(share);
}

/* ── the strip ─────────────────────────────────────────────────────────────*/

export type Kpis = {
  /** Modeled spend, or null when no row in the window could be priced. */
  spend: number | null;
  /** Rows the price table could not answer. Never folded in as free. */
  unpriced: number;
  tokens: number | null;
  requests: number;
  /** Cache reads as a share of every token, in percent; null with no tokens. */
  cacheShare: number | null;
  cards: number;
  /** The project that saw the most tokens, and what share of the window's
   *  tokens that is. Null share when the window has no tokens at all, because a
   *  ratio with no denominator is null and never zero (§9.1), and every tile
   *  that cannot be measured says so rather than drawing a zero. */
  leading: { project: string; tokens: number; share: number | null } | null;
};

export function kpisOf(rows: readonly UsageRow[], cards: number): Kpis {
  const spend = fold(rows, "usd_modeled");
  const tok = fold(rows, "tokens");

  let requests = 0;
  let cacheRead = 0;
  let allTokens = 0;
  const byProject = new Map<string, number>();
  for (const row of rows) {
    requests += row.requests;
    const t = row.inTok + row.outTok + row.cacheRead + row.write5m + row.write1h;
    cacheRead += row.cacheRead;
    allTokens += t;
    const project = row.project || "unnamed";
    byProject.set(project, (byProject.get(project) ?? 0) + t);
  }

  let leading: Kpis["leading"] = null;
  for (const [project, t] of byProject) {
    if (!leading || t > leading.tokens || (t === leading.tokens && project < leading.project)) {
      leading = { project, tokens: t, share: allTokens > 0 ? (t / allTokens) * 100 : null };
    }
  }

  return {
    spend: spend.value,
    unpriced: spend.unpriced,
    tokens: tok.value,
    requests,
    cacheShare: allTokens > 0 ? (cacheRead / allTokens) * 100 : null,
    cards,
    leading,
  };
}

/* ── the empty state ───────────────────────────────────────────────────────*/

export type Emptiness = { title: string; note: string };

/** What a room with no rows says.
 *
 *  Two different nothings, and the distinction is the whole point: a store that
 *  has never recorded anything is waiting on the collector, and a window with
 *  nothing in it is a quiet week on a wall that works. Neither is a zero, and
 *  neither is drawn as a chart at the baseline. */
export function emptinessOf(window: AnalyticsWindow): Emptiness | null {
  if (window.rows.length > 0) return null;
  if (window.first === null) {
    return {
      title: "recording starts within a minute",
      note: "volery writes what it finds once a minute, starting with the transcripts already on disk.",
    };
  }
  return {
    title: "nothing recorded in this window",
    note: `recording since ${dateLine(window.first)} · ${count(window.recorded)} requests so far`,
  };
}

/** How much the answer cost, said under the title, so a room with a 12 MB
 *  window in it says why it took a moment. */
export function tierSaid(tier: WindowTier): string {
  return tier === "fine" ? "five-minute facts" : "hourly rollups";
}

/** A sparkline's polyline, in a 100×22 box.
 *
 * A tile's history is drawn as a shape, not a chart: no axis, no ticks, and
 * `vector-effect: non-scaling-stroke` in the markup so the line stays 1px
 * whatever the tile's width. **A flat series draws a line across the middle**
 * rather than at the floor, because "nothing changed" and "nothing happened"
 * are different readings and the second one has no points at all.
 *
 * The top of the box is the series' own maximum, so a tile whose value is also
 * the maximum draws its last point on the top edge — which is the shape of the
 * reading, not a claim about headroom. */
export function sparkPoints(values: readonly number[], width = 100, height = 22, pad = 1.5): string {
  /* A value that is not a number cannot be given a point: it is dropped before
     the shape is computed, so it neither sets the scale nor emits `NaN` as a
     coordinate. What is left is the series that can be drawn. */
  const drawn = values.filter((v) => Number.isFinite(v));
  const n = drawn.length;
  if (n === 0) return "";
  if (n === 1) return `${pad},${height / 2} ${width - pad},${height / 2}`;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of drawn) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const inner = height - pad * 2;
  return drawn
    .map((v, i) => {
      const x = pad + (i / (n - 1)) * (width - pad * 2);
      const y = span <= 0 ? height / 2 : pad + (1 - (v - min) / span) * inner;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(" ");
}
