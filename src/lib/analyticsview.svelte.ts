/* The analytics surface, above the presentation that draws it.
 *
 * `docs/ANALYTICS.md` §11.15: the room and the page are two presentations of
 * one view, so the choice between them is a redraw and never a second
 * implementation. What makes that true is where the state lives — the question
 * you are asking (span, measure, split) belongs to the surface, and only the
 * drawing belongs to whichever presentation is in front.
 *
 * So this module is not the room's. The page, the next cut, reads the same
 * three fields, and swapping presentations carries them across, because a
 * presentation that owned them would take them with it when it closed.
 *
 * What deliberately does *not* live here: the window that was read, the
 * selection, the table toggle. Those are about one drawing rather than about
 * the question — a selection is a bucket in an axis that a different span will
 * not have — and a page and a room showing them to each other would be two
 * drawings arguing about the same value.
 *
 * **The seam for the swap.** A later `v` (and the small control beside the
 * title) chooses a presentation; it does not live here, because a chosen
 * presentation is remembered per host mode (`localStorage`, the `berth`
 * bargain) and neither presentation exists yet to choose between. When the page
 * lands, this module gains that choice and the room reads it; nothing in the
 * room's own drawing has to move.
 *
 * The host mode only picks the *default*, which is the native one: the wall
 * opens the room and chat view opens the page. Either is reachable from either
 * mode, and the mode is never the thing that decides. Until the page exists the
 * room is the only presentation, so it is what both modes open.
 */

import { DEFAULT_SPAN, type RoomMeasure, type RoomSplit } from "./analyticsroom";

/** The question being asked of the facts, independent of who draws it. */
export type Surface = {
  span: string;
  measure: RoomMeasure;
  split: RoomSplit;
};

/** One surface, shared by every presentation and outliving each of them: close
 *  the room and open it again and you are still looking at the same week. Not
 *  `localStorage` — a launch opening on last week's span is a setting nobody
 *  chose, which is `berth.ts`'s argument the other way round. */
export const surface = $state<Surface>({
  span: DEFAULT_SPAN,
  measure: "usd_modeled",
  split: null,
});
