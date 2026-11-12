/* The analytics widget (§12): one view, drawn small on the wall.
 *
 * A widget's `config_json` holds either a **saved-view id** or an **inline
 * spec**, plus a size intent — and nothing else, because `config_json` is one
 * opaque column and Rust never hears about any of it, the same bargain
 * `widget.config_json` strikes for every kind on this wall.
 *
 * The three decisions this file exists to get right, each of which is a bug the
 * other way round:
 *
 *  - **A shared widget is a *reading*, an inline one is a *copy*.** Pointing at
 *    a saved view means editing that view in the overlay updates every widget
 *    that reads it; editing one widget makes a copy and touches nothing else.
 *    The difference is drawn (`shareSaid`) rather than left to be discovered,
 *    because it is exactly the sort of thing that is invisible until somebody
 *    edits a view and wonders why a widget on another screen moved.
 *  - **A shared widget keeps the spec it last drew.** A saved view deleted
 *    while the wall is up would otherwise be a widget that goes blank, so the
 *    resolved spec is written back beside the id on every successful draw. The
 *    widget goes on drawing it and says the view is gone; `forkedOf` is the one
 *    gesture that turns the snapshot into an ordinary inline copy.
 *  - **A widget that cannot draw is left off the wall.** A spec that will not
 *    parse is a widget from a build this one does not understand, and drawing a
 *    default view in its place would be inventing a reading. A widget with *no*
 *    spec yet — one just hung up from the catalogue — is a different thing and
 *    opens on the default view, which is the one the overlay opens with.
 *
 * Everything decided here is pure and tested in `test/analyticswidget.test.ts`.
 * The drawing is `AnalyticsFace.svelte`, and the reading is one `Analytics`
 * holder behind however many widgets are up (`analyticsholder.svelte.ts`).
 */

import {
  normalizeView,
  spanMsOf,
  type Point,
  type ViewSpec,
  type Folded,
} from "./analytics";
import { SPANS } from "./analyticsroom";
import type { SavedView } from "./analyticpage";
import type { WidgetConfig } from "./widgets";

/* ── the vocabulary ────────────────────────────────────────────────────────*/

/** The size intent, under the catalogue's own key (`widgets.ts::VARIANT`): every
 *  widget's first knob is the one that changes what you are looking at rather
 *  than how much of it, and the right-click's quick-switch reads it by that key.
 *  A literal here rather than an import, because `widgets.ts` imports this file
 *  for `SIZES` and a value back the other way is a cycle; `test/analyticswidget.test.ts`
 *  holds the two spellings together. */
export const SIZE = "variant";
/** The saved view this widget reads, or empty for an inline copy. */
export const VIEW = "view";
/** The inline spec, as JSON. Written when a view is hung up as a copy, or when
 *  a shared one is forked. */
export const SPEC = "spec";
/** The spec resolved on the last successful draw of a *shared* view, so a view
 *  deleted while the wall is up does not blank the widget. */
export const SNAPSHOT = "snapshot";

export type SizeIntent = "stat" | "chart" | "board";

/** One vocabulary for the menu, the face and the tests. `widgets.ts` builds its
 *  choice from this list, so the three cannot drift apart. */
export const SIZES: readonly { key: SizeIntent; label: string; said: string }[] = [
  { key: "stat", label: "a figure", said: "one measure, a figure, a sparkline" },
  { key: "chart", label: "a chart", said: "one panel, no rail" },
  { key: "board", label: "a board", said: "two panels stacked" },
];

/** Anything that is not one of the three is the chart, which is the one that
 *  says the most without being wrong about the box it was dragged to. */
export function sizeOf(raw: unknown): SizeIntent {
  return raw === "stat" || raw === "board" ? raw : "chart";
}

export type AnalyticsConfig = {
  size: SizeIntent;
  view: string;
  spec: string;
  snapshot: string;
};

export function configOf(config: WidgetConfig): AnalyticsConfig {
  return {
    size: sizeOf(config[SIZE]),
    view: typeof config[VIEW] === "string" ? (config[VIEW] as string) : "",
    spec: typeof config[SPEC] === "string" ? (config[SPEC] as string) : "",
    snapshot: typeof config[SNAPSHOT] === "string" ? (config[SNAPSHOT] as string) : "",
  };
}

/* ── resolving a widget against the library ────────────────────────────────*/

/** What a widget draws, and where it came from. */
export type Reading = {
  spec: ViewSpec;
  /** The saved view it reads, or null for a copy of its own. */
  shared: string | null;
  /** What to call it: the library's name for a saved view, the spec's own for a
   *  copy. */
  name: string;
  /** A shared id the library no longer holds. The snapshot is what is drawn. */
  gone: boolean;
};

/** A spec off a config, made drawable. Empty means *nothing written yet*, which
 *  is a new widget rather than a broken one, and answers null so the caller can
 *  tell the two apart. Unparseable text answers null too, and that one is
 *  broken. */
export function specOf(text: string): ViewSpec | null {
  if (!text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return normalizeView(raw);
}

/** The default a widget with no spec yet opens on: the view the overlay opens
 *  with, so a widget hung up from the menu and the overlay behind it agree. */
export function defaultSpec(): ViewSpec {
  return normalizeView({});
}

/** What this widget draws, or null when it cannot draw at all.
 *
 *  `library` is the saved views as `analyticpage.ts::asSavedViews` makes them,
 *  and `known` says whether that list has been read at all. The distinction is
 *  load-bearing: an id missing from a list nobody has read yet is **not** a
 *  deleted view, and saying it is would put "that view is gone" on the wall for
 *  the second between a launch and the library's answer.
 *
 *  A widget that reads a saved view and has never drawn — a launch on which the
 *  view really is gone — is the one case with nothing to draw, and it is left
 *  off the wall rather than guessed at (§12). */
export function resolveOf(
  config: AnalyticsConfig,
  library: readonly SavedView[],
  known = true,
): Reading | null {
  if (config.view) {
    const one = library.find((v) => v.id === config.view);
    if (one) return { spec: one.view, shared: one.id, name: one.name, gone: false };
    const kept = specOf(config.snapshot);
    if (!kept) return null;
    return {
      spec: kept,
      shared: config.view,
      name: kept.name || "a view that is gone",
      gone: known,
    };
  }
  const own = specOf(config.spec);
  if (own) return { spec: own, shared: null, name: own.name || "this widget only", gone: false };
  /* Nothing written yet: a widget hung up from the menu. A spec that was
   * written and did not parse is the arm above, and is refused. */
  if (config.spec.trim()) return null;
  const fresh = defaultSpec();
  return { spec: fresh, shared: null, name: "this widget only", gone: false };
}

/** How this widget is related to the library, in the words the face and the
 *  menu both use. The difference is the whole reason a snapshot exists. */
export function shareSaid(reading: Reading): string {
  if (!reading.shared) return "this widget only";
  return reading.gone ? `shared: ${reading.name} · that view is gone` : `shared: ${reading.name}`;
}

/** Turn a shared widget into an inline copy of what it is drawing: the one
 *  gesture that resolves a view which has been deleted, and the one that makes
 *  an edit local rather than to every widget pointing at the view. */
export function forkedOf(config: WidgetConfig, reading: Reading): WidgetConfig {
  return {
    ...config,
    [VIEW]: "",
    [SPEC]: JSON.stringify(reading.spec),
    [SNAPSHOT]: "",
  };
}

/** What a shared widget writes back after drawing: the spec it resolved, so the
 *  next launch has something to draw if the view is gone by then. Null when
 *  there is nothing new to write, so the caller writes only on a change —
 *  an unconditional write would be a widget updating itself on every frame. */
export function snapshotOf(config: AnalyticsConfig, reading: Reading): string | null {
  if (!reading.shared || reading.gone) return null;
  const next = JSON.stringify(reading.spec);
  return next === config.snapshot ? null : next;
}

/* ── the three readings ────────────────────────────────────────────────────*/

/** One big figure and how it compares with the window before it.
 *
 *  The previous window is a second read rather than a figure derived from this
 *  one: a delta computed from the same rows is a different claim ("this week
 *  against its own average" is not "this week against last week"), and a widget
 *  that said the second while meaning the first would be wrong in the one place
 *  the number is read. `before` is null where nothing was recorded, which is a
 *  missing reading and never a zero. */
export type Stat = {
  value: number | null;
  before: number | null;
  /** Percent change against the window before, or null without a divisor. */
  change: number | null;
};

export function statOf(now: Folded, before: Folded | null): Stat {
  const value = now.value;
  const prior = before?.value ?? null;
  const change =
    value !== null && prior !== null && prior > 0 ? ((value - prior) / prior) * 100 : null;
  return { value, before: prior, change };
}

/** The change, in the house's words: a direction, a whole percent, and nothing
 *  at all when there is no honest comparison. A movement under half a percent
 *  says it is level rather than printing `+0%`, which reads as a measurement
 *  that cannot add up. */
export function changeSaid(stat: Stat): string {
  if (stat.change === null) return "";
  const whole = Math.round(stat.change);
  if (whole === 0) return "about level";
  return `${whole > 0 ? "up" : "down"} ${Math.abs(whole)}%`;
}

/** What the change is against, for the line beside it. The span in the room's
 *  own words rather than its literal, because `7d` is a control's label and a
 *  sentence wants a duration. */
export function changeAgainst(span: string): string {
  const said = SPANS.find((s) => s.span === span)?.said ?? `the last ${span}`;
  return `against ${said} before it`;
}

/* ── geometry ──────────────────────────────────────────────────────────────*/

/** A line through points, against an axis the caller fixed.
 *
 *  **The axis is the caller's** — the window's bounds and the tallest reading
 *  across *every* series — because a widget draws several series at once, and a
 *  line scaled to its own points would put a series worth a tenth of another at
 *  the same height. `pathOf` below is the one-series case that computes both.
 *
 *  `inset` is in the same units as `w`/`h`, and it exists because a stroke is
 *  centred on its path: a line drawn to the edge loses half its width to the
 *  clip. The x axis is the *time* each reading was taken, so a gap in the
 *  record draws as a gap rather than being closed up. */
export function seriesPath(
  points: readonly Point[],
  since: number,
  until: number,
  top: number,
  w: number,
  h: number,
  inset = 2,
): string {
  const live = points.filter((p) => Number.isFinite(p.at) && Number.isFinite(p.value));
  const spanX = until - since;
  if (live.length < 2 || !(w > 0) || !(h > 0) || !(top > 0) || !(spanX > 0)) return "";
  const left = inset;
  const right = Math.max(inset, w - inset);
  const floor = Math.max(inset, h - inset);
  let d = "";
  for (const p of live) {
    const px = left + ((p.at - since) / spanX) * (right - left);
    const py = floor - (Math.max(0, p.value) / top) * (floor - inset);
    d += `${d ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return d;
}

/** One series' path, with the axis taken from the series itself: a sparkline's
 *  case, where there is nothing to compare it with. */
export function pathOf(
  points: readonly Point[],
  w: number,
  h: number,
  inset = 2,
): string {
  const live = points.filter((p) => Number.isFinite(p.at) && Number.isFinite(p.value));
  if (live.length < 2) return "";
  const since = live[0].at;
  const until = live[live.length - 1].at;
  let top = 0;
  for (const p of live) if (p.value > top) top = p.value;
  return seriesPath(live, since, until, top, w, h, inset);
}

/** The window a widget's span covers, in milliseconds, with the same fallback
 *  the overlay uses — so a widget and the surface it opens into never disagree
 *  about what `7d` means. */
export function spanMsFor(span: string): number {
  return spanMsOf(span) ?? 7 * 24 * 3_600_000;
}

/* ── the board's three panels ──────────────────────────────────────────────*/

export type BoardPanel = { id: "trend" | "split" | "numbers"; title: string };

/** What the large intent stacks. The split panel is only there when the spec
 *  asks for a split: a panel saying "nothing is divided" in a widget with room
 *  for three is a panel spent on silence. */
export function boardPanels(split: string | null): readonly BoardPanel[] {
  const panels: BoardPanel[] = [{ id: "trend", title: "over the window" }];
  if (split) panels.push({ id: "split", title: `by ${split}` });
  else panels.push({ id: "numbers", title: "in this window" });
  return panels;
}
