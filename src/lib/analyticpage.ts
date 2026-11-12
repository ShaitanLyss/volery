/* The analytics page (docs/ANALYTICS.md §11.8, §11.15): the document
 * presentation's own arguments, and the seams between it and the room.
 *
 * The page is editorial, not a second implementation. Both presentations draw
 * the same `splitSeries` rows over the same surface state; what this file adds
 * is the half the room does not have, and every one of those is a decision a
 * template would otherwise make:
 *
 *  - **`storyOf` writes the hero sentence from the numbers.** A small template
 *    table keyed by what the window actually holds — nothing recorded, a quiet
 *    window, rows the price table could not answer, or a normal one — so it
 *    cannot invent a cheerful sentence over an empty week and cannot disagree
 *    with the figure it sits above. It is never a model: prose generated per
 *    view would cost a turn and could hallucinate a figure (§11.8).
 *  - **`figureOf` is the one large figure's readings** — the window's total,
 *    its heaviest bucket, and how many stretches were not recorded at all —
 *    so the drawing reads numbers rather than summing marks.
 *  - **`pageModel` builds both from the same `splitSeries` the room calls.**
 *    `test/analyticpage.test.ts` compares the two from one fixture and against
 *    `fold`, so a skin change cannot quietly become a data change (§11.15).
 *  - **The presentation is a remembered choice per host mode**, and the mode
 *    only picks the default: the wall opens the room, chat view the page. The
 *    keys are `berth.ts`'s bargain — this machine's, disposable, and never
 *    carried in the view spec (§9.2).
 *  - **A saved view is a spec and a surface is a question.** `viewOfSurface`
 *    and `surfaceOfView` are the one translation, so saving and reopening
 *    cannot drift from what the controls mean.
 *
 * Pure: no Tauri, no runes, no `localStorage`. Tested directly.
 */

import {
  atOf,
  bucketCount,
  bucketOf,
  filterRows,
  dimsOf,
  fold,
  money,
  normalizeView,
  pct,
  resolveView,
  spanMsOf,
  tokens,
  type Bucket,
  type Filter,
  type UsageRow,
  type ViewPanel,
  type ViewSpec,
} from "./analytics";
import {
  DEFAULT_SPAN,
  SPANS,
  bucketLabel,
  emptinessOf,
  kpisOf,
  readingsOf,
  runsOfTimes,
  splitSeries,
  timesOf,
  type AnalyticsWindow,
  type Emptiness,
  type Kpis,
  type RoomMeasure,
  type RoomSeries,
  type RoomSplit,
  type SlotBook,
} from "./analyticsroom";
import { dateLine } from "./clock";
import { count } from "./usage";

/* ── which presentation is in front ────────────────────────────────────────*/

/** The two drawings of one view. There is deliberately no third here: the
 *  sheet waits for the widget kind (§11.15). */
export type Presentation = "room" | "page";

/** One key per host mode, so a wall switched to the page stays there and chat
 *  view is unaffected (`berth.ts`'s bargain: `localStorage`, per machine). */
export const PRESENTATION_STORE = {
  wall: "skein.analytics.presentation.wall",
  chat: "skein.analytics.presentation.chat",
} as const;

export type HostMode = "wall" | "chat";

/** What a mode opens with when nothing was chosen: the native one. */
export function naturalFor(mode: HostMode): Presentation {
  return mode === "chat" ? "page" : "room";
}

/** Stored text, made drawable. Anything that is not a presentation — an older
 *  build's word, a hand-edited value, nothing at all — falls back to the
 *  natural one rather than throwing the choice away and reopening the
 *  question. */
export function presentationFor(mode: HostMode, raw: string | null): Presentation {
  return raw === "room" || raw === "page" ? raw : naturalFor(mode);
}

export function otherPresentation(p: Presentation): Presentation {
  return p === "room" ? "page" : "room";
}

/* ── the surface, and a spec ───────────────────────────────────────────────*/

/** The question being asked of the facts, independent of who draws it. This is
 *  `analyticsview.svelte.ts::Surface` spelled structurally, so this module stays
 *  pure and the rune holder can pass its own object without a cast. */
export type SurfaceInput = {
  span: string;
  measure: RoomMeasure;
  split: RoomSplit;
  filter: Filter;
};

/** The three splits the room draws, which is also what a saved view may ask
 *  for without the surface having a picker for the other twelve dimensions. */
export function roomSplitOf(dim: unknown): RoomSplit {
  return dim === "project" || dim === "account" || dim === "model" ? dim : null;
}

export function roomMeasureOf(key: unknown): RoomMeasure {
  return key === "tokens" ? "tokens" : "usd_modeled";
}

/** The current question, as a spec §9.2 can store, carry in a widget, or embed
 *  in a report. Presentation is not in it, on purpose. */
export function viewOfSurface(surface: SurfaceInput, name: string): ViewSpec {
  const panel: ViewPanel = {
    form: "area",
    measure: surface.measure,
    split: surface.split,
    filter: {},
    stack: false,
    annotate: [],
  };
  return {
    v: 1,
    name: name.trim(),
    span: surface.span,
    bucket: "auto",
    filter: surface.filter,
    panels: [panel],
  };
}

/** Two filters that say the same thing. Order inside a list is not a claim
 *  about anything, so `["a","b"]` and `["b","a"]` are one question. A dimension
 *  missing from one and named with an empty list in the other are *not* merged:
 *  §9.1 keeps "none" and "all" apart on purpose, and a comparison that tidied
 *  that away would hang the wrong widget on the wall. */
function sameFilter(a: Filter, b: Filter): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    /* A dimension named with an empty list is *none* and one not named at all
       is *all* (`analytics.ts::matches`), so the two are not the same question
       even though both have no values. */
    if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) return false;
    const x = [...(a[key as keyof Filter] ?? [])].sort();
    const y = [...(b[key as keyof Filter] ?? [])].sort();
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return true;
}

/** Whether the surface is asking exactly this spec's question.
 *
 *  It is what decides how a pin is hung (§12): a widget pointed at a saved view
 *  is a reading that every edit to that view moves, and one carrying a copy is
 *  its own. Pinning the question the overlay is already showing should not make
 *  a second copy of a view that is in the library — so the overlay asks this,
 *  and shares when the answer is yes. */
export function viewMatches(view: ViewSpec, surface: SurfaceInput): boolean {
  const panel = view.panels[0];
  return (
    view.span === surface.span &&
    roomMeasureOf(panel?.measure) === surface.measure &&
    roomSplitOf(panel?.split) === surface.split &&
    sameFilter(view.filter ?? {}, surface.filter ?? {})
  );
}

/** A spec, back as the four controls. A measure or a split this surface cannot
 *  draw degrades to the nearest it can rather than refusing the whole view: a
 *  saved spec is data from a build that may have had more, and reopening it
 *  with the wrong measure is recoverable while a refusal is not. */
export function surfaceOfView(view: ViewSpec): SurfaceInput {
  const panel = view.panels[0];
  return {
    span: view.span || DEFAULT_SPAN,
    measure: roomMeasureOf(panel?.measure),
    split: roomSplitOf(panel?.split),
    filter: view.filter ?? {},
  };
}

/* ── what a surface cannot honour about a spec ─────────────────────────────*/

/** Why this spec cannot be answered, in the design's own words, or null.
 *
 *  §9.1's rule is that an unanswerable combination is **refused with the tier
 *  named**, never silently answered from the wrong rows. `analytics.ts`'s
 *  `resolveView` holds the three refusals and, until now, had no caller at all:
 *  a saved view asking for a session split over a year opened as a view with no
 *  split, and the surface said nothing. This is the sentence it says instead.
 *
 *  `now` is passed rather than read so a view opened a minute ago keeps saying
 *  the same thing about the window it was opened on. */
export function refusalOf(view: ViewSpec, now: number): string | null {
  const one = resolveView(view, now);
  return one.ok ? null : one.error.detail;
}

/** A view that asks for more panels than this surface draws. Not a refusal:
 *  the first panel is a real answer, and the note says which part of the spec
 *  is not being shown rather than degrading silently (§9.2, §11.2). */
export function panelNote(view: ViewSpec): string | null {
  if (view.panels.length <= 1) return null;
  return `this view asks for ${view.panels.length} panels; one is drawn here`;
}

/* ── saved views ───────────────────────────────────────────────────────────*/

/** One row of `analytics_view`, as this side reads it. */
export type SavedView = {
  id: string;
  name: string;
  view: ViewSpec;
  createdAt: number;
  updatedAt: number;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** What the store answered, made drawable: a row with no id or no readable
 *  config is dropped rather than drawn as a nameless empty view, and a config
 *  that is valid JSON but the wrong shape goes through `normalizeView`, the
 *  same normaliser every other opaque config passes (`§9.2`).
 *
 *  The row's own `name` wins over the spec's, because the library is where a
 *  view is renamed and the config's copy is whatever was typed at save time. */
export function asSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(str(r.configJson) || "null");
    } catch {
      parsed = null;
    }
    const view = normalizeView(parsed);
    const name = (str(r.name).trim() || view.name || "untitled").slice(0, 120);
    const createdAt = num(r.createdAt) ?? 0;
    out.push({
      id,
      name,
      view: { ...view, name },
      createdAt,
      updatedAt: num(r.updatedAt) ?? createdAt,
    });
  }
  return orderViews(out);
}

/** The library's one order: newest change first, and a tie broken by the name.
 *  Exported because the menu keeps its rows in the same order after a rename
 *  without a second read, and two comparators would eventually disagree. */
export function orderViews(list: readonly SavedView[]): SavedView[] {
  return [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/* ── the figure ────────────────────────────────────────────────────────────*/

export type PagePeak = {
  at: number;
  label: string;
  value: number;
  /** Of the window's total, in percent; null when there is no denominator. */
  share: number | null;
};

export type PageFigure = {
  /** The measure's total over the window, or null when no row could answer. */
  total: number | null;
  /** Rows the price table could not answer. Never folded in as free. */
  unpriced: number;
  /** The heaviest *bucket*, which is what the figure annotates. */
  peak: PagePeak | null;
  /** The heaviest *day*, folded from the rows rather than from the drawn
   *  buckets: §11.8's sentence is about a day, and the rung a week is drawn at
   *  is an hour, so the two are different readings. Null on an empty window. */
  day: PagePeak | null;
  /** Buckets that have a reading at all, and how many the span should hold. */
  recorded: number;
  expected: number;
  /** Breaks *between* recorded buckets — stretches the store did not record
   *  inside the window, counted here so the prose can say it rather than
   *  leaving the reader to notice. The window's two edges are deliberately not
   *  counted: a bucket with no row is equally "no request" and "nobody was
   *  recording", so nothing here can claim either, and the prose says only
   *  what the break proves. */
  gaps: number;
  /** The window's total per recorded bucket, or null with no readings. */
  mean: number | null;
  /** The same per recorded day. */
  dayMean: number | null;
  /** Days that produced a value under this measure, which `dayMean` divides
   *  by. A day of rows the measure could not answer is not one of them. */
  days: number;
};

/** The one large figure's readings (§11.8): the same series the room draws,
 *  the query layer's own total for the hero, and the heaviest bucket annotated.
 *
 *  **The total is the fold, not the sum of the marks.** Adding the bands back up
 *  is a different arithmetic in a different order, and it disagreed with
 *  `fold` in the last bits the first time this was written — which is exactly
 *  the class of divergence §11.15's test exists to catch. The series are read
 *  for the shape and the peak; the number in the sentence is the query layer's. */
export function figureOf(
  rows: readonly UsageRow[],
  series: readonly RoomSeries[],
  folded: { value: number | null; unpriced: number },
  measure: RoomMeasure,
  bucket: Bucket,
  since: number,
  until: number,
): PageFigure {
  const times = timesOf(series);
  const readings = readingsOf(series);

  const value = folded.value;
  const unpriced = folded.unpriced;

  const shareOf = (v: number) => (value !== null && value > 0 ? (v / value) * 100 : null);

  let peak: PagePeak | null = null;
  for (const t of times) {
    const reading = readings.get(t);
    if (!reading) continue;
    if (!peak || reading.total > peak.value) {
      peak = { at: t, label: bucketLabel(t, bucket), value: reading.total, share: shareOf(reading.total) };
    }
  }

  /* The day the sentence is about, folded from the rows with the same measure
     the figure is drawn in. Grouped by the local day the row falls in, because
     "the heaviest day" is a person's day and not a UTC boundary. */
  const byDay = new Map<number, UsageRow[]>();
  for (const row of rows) {
    const at = bucketOf(atOf(row), "1d");
    const group = byDay.get(at);
    if (group) group.push(row);
    else byDay.set(at, [row]);
  }
  let day: PagePeak | null = null;
  /* A day whose rows the measure could not answer is not a quiet day: it
     contributes nothing to the total and must not be a divisor in the mean
     either, or "three times an average day" is overstated by it. */
  let pricedDays = 0;
  for (const [at, group] of byDay) {
    const one = fold(group, measure).value;
    if (one === null) continue;
    pricedDays += 1;
    if (!day || one > day.value) day = { at, label: dateLine(at), value: one, share: shareOf(one) };
  }

  const spanMs = Math.max(0, until - since) || spanMsOf("7d") || 0;
  return {
    total: value,
    unpriced,
    peak,
    day,
    recorded: times.length,
    expected: bucketCount(spanMs, bucket),
    gaps: times.length ? runsOfTimes(times, bucket).length - 1 : 0,
    mean: value !== null && times.length ? value / times.length : null,
    dayMean: value !== null && pricedDays ? value / pricedDays : null,
    days: pricedDays,
  };
}

/* ── the prose ─────────────────────────────────────────────────────────────*/

/** A fact under the lede: a value and what it is, in the house register. */
export type StoryFact = { label: string; value: string; note: string; off: boolean };

export type StorySection = { id: "changed" | "went" | "worked"; title: string; body: string };

/** A budget against a plan (§14). **Null means not recorded, never zero**, the
 *  same reading the room's allowance tile keeps: a sentence built from an
 *  unmeasured plan would be inventing the one thing the page exists not to
 *  invent, so the clause that uses this is absent rather than guessed. */
export type PlanReading = { limit: number; used: number; resetsAt: number | null };

export type StoryInput = {
  window: AnalyticsWindow;
  /** Already filtered by the surface. */
  rows: readonly UsageRow[];
  span: string;
  measure: RoomMeasure;
  split: RoomSplit;
  series: readonly RoomSeries[];
  kpis: Kpis;
  figure: PageFigure;
  /** Null means no plan is recorded, and the clause about one is left out. */
  plan?: PlanReading | null;
  /** Section 5's unaccounted share, in points; null means it was not recorded,
   *  which is not the same as nothing being unaccounted for. */
  residualPoints?: number | null;
};

export type Story = {
  /** The hero sentence. One sentence, and it never guesses. */
  lede: string;
  facts: StoryFact[];
  sections: StorySection[];
  /** True when there is nothing to read at all, which the page draws as the
   *  room's own empty state rather than as a zero. */
  empty: boolean;
};

/** Which template the hero uses. Each is a state the window really has, not a
 *  tone: the page says what it knows and names the half it does not. */
export type StoryState = "unrecorded" | "quiet" | "unpriced" | "normal";

export function storyStateOf(input: { window: AnalyticsWindow; rows: readonly UsageRow[]; figure: PageFigure }): StoryState {
  if (input.rows.length === 0) return input.window.first === null ? "unrecorded" : "quiet";
  return input.figure.total === null ? "unpriced" : "normal";
}

const capped = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function spanSaid(span: string): string {
  return SPANS.find((s) => s.span === span)?.said ?? `the last ${span}`;
}

function amount(measure: RoomMeasure, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "nothing priceable";
  return measure === "usd_modeled" ? money(value) : tokens(value);
}

/** Clauses that are only said when they are true. A phrase table rather than a
 *  sentence assembled from parts, because the parts read as generated when
 *  three of them stack — the reason `showcase.md` bans antithesis as a default
 *  shape. */
function paceClause(plan: PlanReading | null | undefined, measure: RoomMeasure): string {
  if (!plan || !(plan.limit > 0) || measure !== "usd_modeled") return "";
  const share = (plan.used / plan.limit) * 100;
  if (!Number.isFinite(share)) return "";
  if (share < 70) return ", well inside the weekly limit";
  if (share < 100) return ", a little ahead of plan";
  if (share < 115) return ", just past the weekly limit";
  return ", past the weekly limit";
}

function residualClause(points: number | null | undefined): string {
  if (points === null || points === undefined || !Number.isFinite(points)) return "";
  if (points <= 0) return ", and nothing is unaccounted for";
  return `, with ${pct(points)} of it not yet accounted for`;
}

/** The hero sentence, from the numbers.
 *
 *  §11.8: *"It says the week's percentage, the pace against the plan, the
 *  largest single day, and the residual."* The last three are only sayable
 *  when the facts behind them exist, so each is a clause that is present or
 *  absent rather than a template that fills a hole with a zero. The register
 *  is the design's: a percentage is a fact about a week, not a verdict on the
 *  person reading it. */
function ledeOf(state: StoryState, input: StoryInput): string {
  const { figure, window, measure, span, kpis } = input;
  const when = spanSaid(span);

  if (state === "unrecorded") {
    return "nothing has been recorded yet. volery starts writing facts about a minute after it opens, beginning with the transcripts already on this machine.";
  }
  if (state === "quiet") {
    const since = window.first !== null ? `, on a wall recording since ${dateLine(window.first)}` : "";
    return `nothing was recorded in ${when}${since}. ${count(window.recorded)} requests are on record outside this window.`;
  }
  if (state === "unpriced") {
    const n = input.rows.length === 1 ? "one row falls" : `${count(input.rows.length)} rows fall`;
    return `${n} in ${when}, and not one of them has a price the rate table can answer. ${count(figure.unpriced)} of them are waiting on a rate.`;
  }

  const peak = figure.day
    ? `, the heaviest day ${figure.day.label}${figure.day.share !== null ? ` at ${pct(figure.day.share)} of it` : ""}`
    : "";
  const requests = kpis.requests > 0 ? ` across ${count(kpis.requests)} requests` : "";
  const spent = measure === "usd_modeled" ? `cost ${amount(measure, figure.total)}` : `moved ${amount(measure, figure.total)}`;
  return `${capped(when)} ${spent}${requests}${peak}${paceClause(input.plan, measure)}${residualClause(input.residualPoints)}.`;
}

function changedOf(input: StoryInput): string {
  const { figure, measure } = input;
  const peak = figure.day ?? figure.peak;
  if (!peak) {
    return `no bucket in this window has a reading, so there is no shape to compare.`;
  }
  const mean = figure.day ? figure.dayMean : figure.mean;
  const ratio = mean !== null && mean > 0 ? peak.value / mean : null;
  const heaviest = `${peak.label} carried ${amount(measure, peak.value)}${ratio !== null && ratio >= 1.15 ? `, ${ratio.toFixed(1)} times an average ${figure.day ? "day" : "bucket"}` : ""}.`;
  /* What the breaks prove is only what is *between* readings: an empty bucket
     is equally "no request" and "nobody was recording", so the sentence claims
     nothing about the window's edges. */
  const gaps =
    figure.gaps > 0
      ? ` ${figure.gaps === 1 ? "one stretch between readings was" : `${figure.gaps} stretches between readings were`} not recorded at all; those are the breaks in the line, not a fall to zero.`
      : " every bucket between the first reading and the last has one.";
  const unpriced = figure.unpriced > 0 ? ` ${count(figure.unpriced)} rows could not be priced and are left out of the total.` : "";
  return `${heaviest}${gaps}${unpriced}`;
}

function wentOf(input: StoryInput): string {
  const { series, measure, split } = input;
  if (!split) {
    const one = series[0];
    if (!one || !one.points.length) return "nothing in this window could be priced, so there is no total to divide.";
    return `the window's ${amount(measure, one.total)} is not divided by anything yet. the split control above asks it by project, account or model.`;
  }
  const named = series.filter((s) => s.slot !== null && s.points.length > 0);
  const whole = named.reduce((a, s) => a + s.total, 0);
  if (!(whole > 0)) return `split by ${split}, nothing in this window could be priced, so the shares are not drawn.`;
  const top = [...named].sort((a, b) => b.total - a.total).slice(0, 3);
  const said = top.map((s) => `${s.label || "unnamed"} at ${pct((s.total / whole) * 100)}`).join(", ");
  const fold = series.find((s) => s.slot === null && s.points.length > 0);
  const rest = fold ? ` everything past the fifth folds into one band at ${pct((fold.total / whole) * 100)}.` : "";
  return `split by ${split}, the window's ${amount(measure, whole)} divides with ${said}.${rest}`;
}

function workedOf(input: StoryInput): string {
  const { kpis, rows } = input;
  const cards = kpis.cards;
  const per = kpis.tokens !== null && kpis.requests > 0 ? Math.round(kpis.tokens / kpis.requests) : null;
  const cache = kpis.cacheShare !== null ? `, ${pct(kpis.cacheShare)} of every token read from cache` : "";
  const perSaid = per !== null ? `, about ${count(per)} tokens a request` : "";
  const leading = kpis.leading ? ` ${kpis.leading.project} is the loudest project, at ${kpis.leading.share !== null ? pct(kpis.leading.share) : "an unmeasured share"} of the tokens.` : "";
  const rowsSaid = rows.length === 1 ? "one row" : `${count(rows.length)} rows`;
  return `${count(cards)} ${cards === 1 ? "card was" : "cards were"} active over ${rowsSaid}, ${count(kpis.requests)} requests${perSaid}${cache}.${leading}`;
}

/** The page's prose, generated from the values the figure is drawn from. */
export function storyOf(input: StoryInput): Story {
  const state = storyStateOf(input);
  const empty = emptinessOf(input.window) !== null;
  const facts: StoryFact[] = [
    {
      label: "spend",
      value: amount("usd_modeled", input.kpis.spend),
      note: input.kpis.unpriced > 0 ? `${count(input.kpis.unpriced)} rows unpriced` : "modeled",
      off: input.kpis.spend === null,
    },
    {
      label: "tokens",
      value: input.kpis.tokens === null ? "—" : count(input.kpis.tokens),
      note: "in, out and cache",
      off: input.kpis.tokens === null,
    },
    {
      label: "requests",
      value: count(input.kpis.requests),
      note: "in this window",
      off: false,
    },
    {
      label: "cards",
      value: count(input.kpis.cards),
      note: "active in this window",
      off: false,
    },
  ];
  return {
    lede: ledeOf(state, input),
    facts,
    sections: empty
      ? []
      : [
          { id: "changed" as const, title: "what changed", body: changedOf(input) },
          { id: "went" as const, title: "where it went", body: wentOf(input) },
          { id: "worked" as const, title: "how you worked", body: workedOf(input) },
        ],
    empty,
  };
}

/* ── the page's model ──────────────────────────────────────────────────────*/

export type PageModel = {
  /** The same `RoomSeries` the room draws, from the same call. */
  series: RoomSeries[];
  kpis: Kpis;
  figure: PageFigure;
  story: Story;
  empty: Emptiness | null;
};

export type PageInput = {
  window: AnalyticsWindow;
  /** The surface's filter, applied here so both presentations see one row set
   *  (§11.3: a filter is the view's, not a drawing's). */
  filter?: Filter;
  measure: RoomMeasure;
  split: RoomSplit;
  bucket: Bucket;
  span: string;
  /** Palette history, so a series keeps its colour across a read. Optional:
   *  the page's own read of one fixture starts fresh. */
  book?: SlotBook;
  plan?: PlanReading | null;
  residualPoints?: number | null;
};

/** The window's rows after the surface's filter, which is the one row set both
 *  presentations draw. */
export function surfaceRows(window: AnalyticsWindow, filter: Filter = {}): UsageRow[] {
  return filterRows(window.rows, filter, dimsOf);
}

/** What a report's cover may say about its contents (§13.1).
 *
 *  **The hosts, accounts and CLI version of the rows the report includes**,
 *  not of the window it was asked for. The first cut read the unfiltered window,
 *  so a report filtered to one account listed every account on its cover while
 *  the methodology named one; with anonymisation on it also minted letters for
 *  identities that never appear in the body. One row set, so the cover and the
 *  series cannot describe different data. */
export function coverOf(
  window: AnalyticsWindow,
  filter: Filter = {},
): { hosts: string[]; accounts: string[]; claude: string | null } {
  const rows = surfaceRows(window, filter);
  const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))].sort();
  /* The most common non-empty version, because a straddling window can hold
     two and a report has one line for it. */
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.cli) counts.set(row.cli, (counts.get(row.cli) ?? 0) + 1);
  }
  let claude: string | null = null;
  let most = 0;
  for (const [cli, n] of counts) {
    if (n > most) {
      claude = cli;
      most = n;
    }
  }
  return {
    hosts: unique(rows.map((r) => r.host)),
    accounts: unique(rows.map((r) => r.account)),
    claude,
  };
}

/** Everything the page draws, in one value. */
export function pageModel(input: PageInput): PageModel {
  const rows = surfaceRows(input.window, input.filter);
  const series = splitSeries(rows, input.measure, input.bucket, input.split, input.book ?? new Map());
  const kpis = kpisOf(rows, input.window.cards);
  /* One fold, and the figure reads it: the same call the room's own strip is
     built from, so the hero sentence and the KPI tiles cannot disagree. */
  const folded = fold(rows, input.measure);
  const figure = figureOf(
    rows,
    series,
    folded,
    input.measure,
    input.bucket,
    input.window.since,
    input.window.until,
  );
  const story = storyOf({
    window: input.window,
    rows,
    span: input.span,
    measure: input.measure,
    split: input.split,
    series,
    kpis,
    figure,
    plan: input.plan ?? null,
    residualPoints: input.residualPoints ?? null,
  });
  return { series, kpis, figure, story, empty: emptinessOf(input.window) };
}
