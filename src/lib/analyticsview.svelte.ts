/* The analytics surface, above the presentation that draws it.
 *
 * `docs/ANALYTICS.md` §11.15: the room and the page are two presentations of
 * one view, so the choice between them is a redraw and never a second
 * implementation. What makes that true is where the state lives — the question
 * you are asking (span, measure, split, filter) belongs to the surface, and only
 * the drawing belongs to whichever presentation is in front.
 *
 * So this module is not the room's. Both presentations read the same four
 * fields, and swapping carries them across, because a presentation that owned
 * them would take them with it when it closed. Span and filter also survive a
 * swap for the same reason: they are the question, not the answer's shape.
 *
 * What deliberately does *not* live here: the window that was read, the
 * selection, the table toggle. Those are about one drawing rather than about
 * the question — a selection is a bucket in an axis that a different span will
 * not have — and a page and a room showing them to each other would be two
 * drawings arguing about the same value.
 *
 * **The presentation is remembered per host mode** (`analyticpage.ts` has the
 * keys and the normaliser; `berth.ts` is the bargain this copies). It is read
 * from `localStorage` when the surface opens and written when `v` or the
 * control beside the title changes it, so a wall switched to the page stays
 * there and chat view is unaffected. The host mode only picks the *default*,
 * which is the native one: the wall opens the room and chat view the page.
 *
 * Not `localStorage` for the span, measure, split or filter: a launch opening
 * on last week's span is a setting nobody chose, which is `berth.ts`'s argument
 * the other way round.
 */

import {
  naturalFor,
  presentationFor,
  otherPresentation,
  PRESENTATION_STORE,
  type HostMode,
  type Presentation,
  type SurfaceInput,
} from "./analyticpage";
import { DEFAULT_SPAN, type RoomMeasure, type RoomSplit } from "./analyticsroom";

/** The question being asked of the facts, independent of who draws it. */
export type Surface = SurfaceInput;

/** One surface, shared by every presentation and outliving each of them: close
 *  the room and open it again and you are still looking at the same week. */
export const surface = $state<Surface>({
  span: DEFAULT_SPAN,
  measure: "usd_modeled",
  split: null,
  filter: {},
});

function stored(mode: HostMode): Presentation {
  try {
    return presentationFor(mode, localStorage.getItem(PRESENTATION_STORE[mode]));
  } catch {
    /* a browser refusing storage costs the choice next launch, nothing more */
    return naturalFor(mode);
  }
}

function remember(mode: HostMode, p: Presentation) {
  try {
    localStorage.setItem(PRESENTATION_STORE[mode], p);
  } catch {
    /* see above */
  }
}

/** Which drawing the surface is showing.
 *
 *  Held here rather than in either component because the swap is not the room's
 *  or the page's: both are mounted under the same shell, and the shell reads
 *  this. `open` is the one place a stored choice is read, so a surface opened
 *  and closed all afternoon does not re-read `localStorage` on every swap. */
export const presentation = $state<{ current: Presentation; mode: HostMode }>({
  current: "room",
  mode: "wall",
});

export function openPresentation(mode: HostMode): Presentation {
  presentation.mode = mode;
  presentation.current = stored(mode);
  return presentation.current;
}

/** `v`, and the control beside the title: one redraw, and the choice is kept
 *  for this host mode. It never changes the mode (§11.15). */
export function swapPresentation(): Presentation {
  const next = otherPresentation(presentation.current);
  setPresentation(next);
  return next;
}

/** An explicit presentation — `space b d` asking for the room, `space n n` for
 *  the page. It is a choice, so it is remembered like one. */
export function setPresentation(p: Presentation): void {
  presentation.current = p;
  remember(presentation.mode, p);
}

/** A saved view, opened: the four controls become its question. A field it does
 *  not name keeps what it had rather than resetting, which is the difference
 *  between opening a view and starting over. */
export function adoptSurface(next: Partial<Surface>): void {
  if (next.span) surface.span = next.span;
  if (next.measure) surface.measure = next.measure;
  if (next.split !== undefined) surface.split = next.split;
  if (next.filter) surface.filter = next.filter;
}
