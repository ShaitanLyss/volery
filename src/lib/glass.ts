/* The glass: a pane in front of the wall, in screen space.
 *
 * The wall is unbounded and zoomable, which is what makes it a wall — but some
 * things you want in front of you regardless of where you have panned to. The
 * card you are waiting on, the clock, the territory you are living in this
 * afternoon. Sticking one to the glass takes it out of the wall's frame and
 * into the window's: the pan does not carry it, the zoom does not resize it,
 * and it stays exactly where you put it while the wall moves underneath.
 *
 * Two rules do most of the work, and both are about *not* changing things:
 *
 * 1. **The glass changes where a thing is drawn, never where it is.** Everything
 *    stuck to it keeps its wall position, its slot, its territory and its place
 *    in the reading order, and `layout` runs exactly as if nothing had been
 *    stuck at all. So taking something off the glass puts it back where it was,
 *    and the wall never reshuffles because you stuck something to it — which is
 *    the position-is-memory rule the whole of `layout.ts` is built on, applied
 *    to a gesture that would otherwise break it in the most confusing way
 *    available (the thing you are looking at moves something you are not).
 *
 * 2. **The glass is 1:1.** That is what "does not zoom with the wall" means, and
 *    it is also the only self-consistent answer: a size that tracked the wall's
 *    zoom would be a thing in screen space measured in canvas units. So a card
 *    on the glass draws at `wall` density — the density 1:1 gives — and an image
 *    or a widget draws at the width and height it actually has.
 *
 * The consequence of (2) is that sticking something changes its apparent size
 * unless you happened to be at 100%. `stickTo` therefore preserves its
 * **centre** rather than its corner, for the reason a dropped image is centred
 * on the cursor: you aimed at a place, not at a top-left.
 *
 * Pure — no runes, no DOM — so all of it is tested directly. Where the pane
 * *is* (over the transcript, never over the dock or the header) is a matter of
 * which box `.glass` is a child of, and lives in Canvas.svelte.
 */

export type Spot = { x: number; y: number };
export type Size = { w: number; h: number };

/** Where the wall is being looked at from: `Studio`'s viewport, structurally. */
export type View = { x: number; y: number; scale: number };

/** The part of the glass a stored spot is measured from, in glass pixels.
 *
 *  The whole pane, at its own origin. Spots are stored relative to it, drawn at
 *  its offset and clamped inside it; `x`/`y` are absent or zero whenever the
 *  pane and the glass are the same box, which they are on one screen.
 *
 *  **The pane is every screen while the studio is spread**, which is what lets
 *  something stuck to the glass be dragged onto the second monitor and found
 *  there again. It used to be the home screen's share of the window even then,
 *  so the glass was confined to one monitor however many the wall was over —
 *  and the reason that could not simply be widened is that one set of spots
 *  cannot describe two rooms. It can now because there are two sets: a spot
 *  belongs to a *screen arrangement* (`arrange.ts`), so spread and unspread
 *  remember their own, and widening the room here cannot disturb the
 *  one-screen arrangement it used to have to share.
 *
 *  What still hangs off the home screen is anything with no position of its own
 *  — the timeline stack — because centring a default across every screen puts
 *  it on a seam between two monitors. See `Lintel.svelte`'s `home`. */
export type Pane = Size & { x?: number; y?: number };

/** Where a wall box lands on the glass, in glass pixels.
 *
 * The same place on screen it was already occupying — nothing jumps across the
 * window when you stick it — but at its 1:1 size and centred on where its
 * middle was, since at any zoom but 100% those two sizes differ. `size` is what
 * the thing draws at on the glass: `CARD_BOX.wall` for a card, its own `w`/`h`
 * for an image, a widget or a territory. */
export function stickTo(box: Spot & Size, view: View, size: Size, pane?: Pane): Spot {
  const cx = view.x + (box.x + box.w / 2) * view.scale;
  const cy = view.y + (box.y + box.h / 2) * view.scale;
  return { x: cx - size.w / 2 - (pane?.x ?? 0), y: cy - size.h / 2 - (pane?.y ?? 0) };
}

/** Keep something stuck to the glass reachable in a window this size.
 *
 * The glass has edges where the wall has none, so a position that was perfectly
 * good yesterday can be off the pane today — a narrower window, a wider
 * transcript panel, a screen swapped for a smaller one. Clamped fully inside
 * rather than merely overlapping: `.glass` clips, so half of a widget hanging
 * off the right is not a widget you can read *or* drag back.
 *
 * Applied when the thing is **drawn** and not when it is stored, which is the
 * bargain `panelWidth` already strikes: what a position is worth depends on the
 * window it is read back into, so squeezing the window and widening it again
 * has to give you back what you arranged rather than what survived the squeeze.
 *
 * Top-left wins for anything larger than the pane — the same choice `revealBox`
 * makes about a card taller than the viewport. Better its head than its foot. */
export function glassAt(at: Spot, size: Size, view: Pane, keepout: Rect[] = []): Spot {
  const ox = view.x ?? 0;
  const oy = view.y ?? 0;
  /* A pane nobody has measured yet is not a pane with no room in it. Without
     this, everything on the glass stacks in the top-left corner for the frame
     between the element mounting and the ResizeObserver's first call. */
  if (view.w <= 0 || view.h <= 0) return { x: at.x + ox, y: at.y + oy };
  const spot = {
    x: ox + Math.min(Math.max(at.x, 0), Math.max(0, view.w - size.w)),
    y: oy + Math.min(Math.max(at.y, 0), Math.max(0, view.h - size.h)),
  };
  return nudged(spot, size, view, keepout);
}

/** A rectangle in glass pixels that something opaque is drawn over. */
export type Rect = Spot & Size;

/** Out from under the chrome, if it had vanished completely underneath it.
 *
 *  The pane became the *whole window* while the studio is spread, which is what
 *  lets something stuck to the glass be dragged onto another monitor — and it
 *  gave away the one thing the old pane did for free, which was that it was the
 *  wall's box and so could not reach the header or the dock. Those are opaque
 *  and painted above the wall, so a widget dropped into the strip one of them
 *  occupies on the home screen is simply gone: no handle to drag back, no menu
 *  to right-click, and (unlike a card) nothing in the reading order to Tab to.
 *
 *  **Only what is *entirely* covered is moved**, and that bound is the whole
 *  design. Something half under the header is something you can still take hold
 *  of, and shoving it would be the wall rearranging itself under a position you
 *  chose — which is the thing `glass.md` exists to promise it will not do. So
 *  this is a rescue, not a layout rule, and it fires on the case where there is
 *  nothing left to rescue it with.
 *
 *  Downwards first because the two bands are the top and the bottom of a screen
 *  and down is where the room is under a header; up if that would not fit. */
function nudged(spot: Spot, size: Size, view: Pane, keepout: Rect[]): Spot {
  const oy = view.y ?? 0;
  for (const k of keepout) {
    const hidden =
      spot.x >= k.x &&
      spot.y >= k.y &&
      spot.x + size.w <= k.x + k.w &&
      spot.y + size.h <= k.y + k.h;
    if (!hidden) continue;
    const below = k.y + k.h;
    const above = k.y - size.h;
    const floor = oy;
    const ceil = oy + view.h - size.h;
    spot = { ...spot, y: below <= ceil ? below : Math.max(floor, above) };
  }
  return spot;
}

/** The spot a thing is stuck at, or null for one that is on the wall.
 *
 * Everything persisted carries the pair as two nullable numbers, because that
 * is what a pair of nullable columns is; everything computed carries the spot
 * or nothing, because "half stuck" is not a state. This is the one place the
 * two meet, so a row half-written by an older build reads as being on the wall
 * rather than as being at x with no y. */
export function spotOf(
  it: { glassX?: number | null; glassY?: number | null } | null | undefined,
): Spot | null {
  const x = it?.glassX;
  const y = it?.glassY;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** The same spot, moved by however far its container moved.
 *
 * What carries a territory's cards when the territory itself is stuck: on the
 * wall a card in a territory sits at an offset from the region's origin, and on
 * the glass it sits at the same offset from the region's glass origin. So a
 * glass territory needs no per-card bookkeeping at all — the offset is the
 * layout's already, and dragging the region moves everything in it for free.
 * (On the wall the same move has to translate each pinned card by hand, which
 * is the thing this avoids rather than repeats.) */
export function offsetBy(spot: Spot, from: Spot, to: Spot): Spot {
  return { x: spot.x + (to.x - from.x), y: spot.y + (to.y - from.y) };
}
