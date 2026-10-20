/* The whole of a title the box cut short, shown when the pointer settles on it.
 *
 * Lyss, 2026-10-20: *"when hovering a card, I want the full title to show on
 * settle (custom tooltip of course, never a native web tooltip)"*. A native
 * `title` is the browser's own box, in the system's face, after the system's
 * delay, drawn over the wall in a style nothing here chose. So this is the
 * wall's own, and only where it says something: a title that already fits is
 * on screen in full, and a tooltip repeating it is noise.
 *
 * The rule and the arithmetic are here, pure and tested (`test/tip.test.ts`);
 * `tipped.svelte.ts` holds which one is up and `Tooltip.svelte` draws it. */

/** How long the pointer must rest before the title shows. Long enough that
 *  sweeping across a column of cards shows nothing; short enough to read as
 *  an answer to stopping on one. */
export const TIP_SETTLE_MS = 450;

/** Between the title and the tip, and the least the tip keeps from the
 *  window's edge. */
export const TIP_GAP = 6;

/** Did the box cut this text short? A pixel of slack, because a title that
 *  exactly fits can measure one over at a fractional zoom. */
export function cutShort(el: { scrollWidth: number; clientWidth: number }): boolean {
  return el.scrollWidth > el.clientWidth + 1;
}

type Box = { left: number; top: number; bottom: number };

/** Where the tip stands: under the title and flush with its start, so the
 *  full text reads as the line continuing; above it when there is no room
 *  below; and always inside the window. */
export function placeTip(at: Box, tip: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number } {
  const below = at.bottom + TIP_GAP;
  const y = below + tip.h + TIP_GAP <= view.h ? below : Math.max(TIP_GAP, at.top - TIP_GAP - tip.h);
  const x = Math.max(TIP_GAP, Math.min(at.left, view.w - tip.w - TIP_GAP));
  return { x, y };
}
