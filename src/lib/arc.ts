/* Where the choices on a chip's arc land.
 *
 * Pure and out here for the reason `layout.ts` is: these are a handful of
 * numbers that have to hold or the thing collides with itself, and "it looked
 * right when I tuned it" is not a thing anybody can check a year later. The
 * component that draws them is `Bump.svelte`; the invariants they satisfy are
 * asserted in `test/bump.test.ts`, the way `CARD_BOX`'s are in
 * `test/layout.test.ts`.
 *
 * A **top** arc, not a circle: the choices spread over `ARC_SPREAD` degrees
 * centred on straight up, so the outer ones come out up-and-sideways and the
 * middle one directly above. Three constraints decided the numbers, and two of
 * them are hard:
 *
 * 1. **Each item clears the button it came out of.** The button is a chip, and
 *    the outer items are nearly beside it rather than above it, so this is the
 *    binding constraint on how wide the fan can open. At 120° the outer two rise
 *    22 units, which is exactly a chip's half-height plus an item's plus a
 *    hair — open it wider and they sit on the chip.
 * 2. **Each item clears its neighbours.** The middle one is 22 above the outer
 *    two at this radius, which is the same clearance from the other side.
 * 3. **The peak stays as close to the acts row as legibility allows**, because
 *    the row sits in the region's bottom padding and anything above it is over a
 *    card. `ARC_R` plus half an item is 53 units. At `wall` density a card fills
 *    78 of its 116-unit slot, so there are ~44 units of empty slot and 18 of
 *    padding beneath the last card and the arc very nearly fits inside them; at
 *    `open` a card is 105 tall and the peak overlaps its bottom ~25 units.
 *
 * That last overlap is accepted rather than designed away. There is no
 * three-item arc legible at this type size that fits in 20 units, so "fits at
 * every density" would mean "no arc at all" — and a verb that works at one zoom
 * and not another is worse than a transient overlap. It is bounded three ways:
 * it is only there while you are choosing, it draws at `Z_CHIP` where every
 * other chip in this row already is, and sideways it reaches ~61 units either
 * side of the button, which lands inside the 52-unit gutter between territories
 * even when the arc's chip is the first one in the row. */

/** How far out each choice travels, in canvas units. */
export const ARC_R = 44;

/** The angle the fan opens through, centred on straight up. */
export const ARC_SPREAD = 120;

/** Between one item leaving the button and the next, in ms. Small on purpose:
 *  the point is that they arrive in an order you can see, not that you wait. */
export const ARC_STAGGER = 45;

/** What a chip and an arc item measure, in canvas units.
 *
 *  Nominal, the way `CARD_BOX` is — the real thing is `min-width` plus padding
 *  around a 0.62rem mono glyph, and the wall is zoomed rather than scaled so it
 *  drifts a fraction between densities. They are here so the clearances above
 *  are arithmetic rather than a claim, and they are what the test measures
 *  against. A wider label than `major` means re-checking them. */
export const ARC_ITEM = { w: 46, h: 18 };

/** An offset from the button's centre, in canvas units. Up is negative, as on
 *  the wall. */
export type ArcSpot = { dx: number; dy: number };

/** Where each of `n` choices ends up, in reading order left to right. */
export function arcSpots(n: number, r = ARC_R, spread = ARC_SPREAD): ArcSpot[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    /* One choice goes straight up; there is no fan to open. */
    const deg = n < 2 ? -90 : -90 - spread / 2 + (spread * i) / (n - 1);
    const rad = (deg * Math.PI) / 180;
    return { dx: Math.cos(rad) * r, dy: Math.sin(rad) * r };
  });
}

/** Do two boxes of these sizes, centred at these two points, keep apart?
 *
 *  What "clears" means for everything above: overlapping on *one* axis is fine
 *  — the outer items overlap the button horizontally and are held apart
 *  vertically — so this asks whether they are separated on either. */
export function apart(
  a: ArcSpot,
  b: ArcSpot,
  box: { w: number; h: number } = ARC_ITEM,
): boolean {
  return Math.abs(a.dx - b.dx) >= box.w || Math.abs(a.dy - b.dy) >= box.h;
}
