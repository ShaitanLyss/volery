/* A reading held in a sheet rather than hung on the wall.
 *
 * The action palette's `space b …` rows open one of these over whichever view
 * is in front (`ReadingSheet.svelte`): pipelines, reviews, what is on you in
 * asana. The face is the widget's own (`WidgetFace.svelte`), so the sheet is a
 * second *holder* of a widget rather than a second drawing of it — and a
 * holder owes a face exactly what the wall gives it: a `Widget`, with a size
 * and a config every knob of which normalizes.
 *
 * Pure. The component measures the box and keeps the knobs; this decides
 * what a widget in a sheet is.
 */

import { FRAME, normalizeWidget, paramsOf, specFor, type Widget, type WidgetConfig, type WidgetKind, type WidgetParam } from "./widgets";
import { READINGS } from "./leader";

/** Where each reading's knobs are kept between openings — the scope you
 *  chose for the pipelines stays chosen. Per machine, beside the view
 *  (`localStorage`, as `view.svelte.ts` keeps `skein.view.v1`): a sheet is
 *  not furniture, so it has no row. */
export const SHEET_STORE = "skein.sheets.v1";

/** A widget a sheet can hold: the kind, at the size of the box it is drawn
 *  in, with its kept config normalized as one off disk is — a retired variant
 *  degrades to the default rather than to nothing. Null for a kind with no
 *  sheet, which is a palette row from a newer build or a hand-written call. */
export function sheetWidget(kind: string, kept: unknown, box: { w: number; h: number }): Widget | null {
  if (!(READINGS as readonly string[]).includes(kind)) return null;
  const w = normalizeWidget({
    id: `sheet:${kind}`,
    kind,
    x: 0,
    y: 0,
    w: Math.max(1, Math.round(box.w)),
    h: Math.max(1, Math.round(box.h)),
    z: 0,
    glassX: null,
    glassY: null,
    config: kept && typeof kept === "object" ? kept : {},
  });
  return w;
}

/** The knobs a sheet offers: the widget's own choices and toggles, read off
 *  the catalogue so a knob added there is in the sheet the same day — less
 *  the frame, which is about standing on the wall, and less a knob whose
 *  options come from elsewhere (an account, a project's board), which the
 *  face asks for itself where it needs one. A knob guarded off by another
 *  (`only`) is left out while it means nothing, as the menu leaves it. */
export function sheetKnobs(kind: string, config: WidgetConfig): WidgetParam[] {
  const spec = specFor(kind);
  if (!spec) return [];
  return paramsOf(spec).filter((p) => {
    if (p.key === FRAME) return false;
    if (p.kind === "number") return false;
    if (p.kind === "choice" && p.from) return false;
    if (p.only && !p.only.is.includes(String(config[p.only.key]))) return false;
    return true;
  });
}

/** What `SHEET_STORE` holds, read defensively: an object of kind → config,
 *  anything else ignored. A config is kept as written and normalized when it
 *  is drawn, so a knob renamed tomorrow costs nothing here. */
export function readSheets(raw: string | null): Partial<Record<WidgetKind, WidgetConfig>> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Partial<Record<WidgetKind, WidgetConfig>> = {};
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (!(READINGS as readonly string[]).includes(k)) continue;
      if (c && typeof c === "object" && !Array.isArray(c)) out[k as WidgetKind] = c as WidgetConfig;
    }
    return out;
  } catch {
    return {};
  }
}
