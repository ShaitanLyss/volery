/* What one turn of the wheel means on the wall.
 *
 * `Canvas` registers its wheel listener on `.surface`, non-passive so it can
 * `preventDefault`, and it opened with that call unconditionally — before
 * anything had been asked about where the wheel actually happened. `.surface`
 * is an ancestor of everything standing on the wall, and the listener is on the
 * *bubble* phase, so it saw every wheel event inside every widget and consumed
 * it. The consequence was that **nothing on this wall could be scrolled**: an
 * Asana column with twenty cards, the sink's rows, a pipeline list — the content
 * overflowed, `overflow-y: auto` was set, the scrollbar worked, and the reflex
 * gesture did nothing at all. `LogTail` gave up scrollback over it and said so
 * in a comment; the sink item is `813c8196`.
 *
 * The gesture itself is not the bug and is deliberately kept: on a wall whose
 * densities *are* the navigation, zoom is what you do constantly and panning is
 * what you do by dragging the ground. So this is a test on where the wheel
 * landed rather than a change to what the wheel means, and the whole of the
 * judgement is three rules.
 *
 * **The modifiers are the wall's, unconditionally.** ctrl+wheel zooms and
 * shift+wheel pans wherever the cursor is, including over a list that is
 * scrolling. That is what keeps a widget from becoming a dead zone for any wall
 * gesture — the trap that would make this fix worse than the bug it fixes — and
 * it is why only the *bare* wheel has to ask anything. A big Kanban covering
 * half the wall still zooms and still pans, with a modifier that was already
 * documented.
 *
 * **A bare wheel goes to the nearest thing under it that can actually move on
 * the axis of the delta, and to the wall otherwise.** Two halves, both of which
 * have to be true: the box has to be a scroll container on that axis (computed
 * overflow `auto`/`scroll`/`overlay` — `hidden` overflows plenty and does not
 * scroll, which is exactly what `LogTail` is), *and* it has to have content
 * beyond itself there. The second half is what keeps zoom-over-a-widget: a list
 * with three rows in a box that fits six is not a scroller, and a wheel over it
 * zooms the wall like the frame around it does.
 *
 * **The axis is asked per gesture, not per element.** `deltaX` and `deltaY` are
 * already treated asymmetrically by the wall — Windows reports shift+wheel on
 * `deltaX`, a trackpad on `deltaY` — so "can this scroll" is meaningless
 * without a direction. The dominant delta decides, which is the only reading
 * that survives a trackpad's diagonal.
 *
 * **A scroller keeps the wheel at its ends.** Wheeled past the bottom of a log,
 * nothing happens; the wall does not take over. Chosen rather than fallen into,
 * and the argument is the tail of a flick: chaining out to the zoom means the
 * wall lurches under your hand at the end of a gesture you aimed at a list, and
 * it makes the same wheel in the same place mean two different things depending
 * on where that list happens to be parked. A native scroller does not do that.
 * The cost is that zooming with the cursor over an overflowing list wants either
 * a few pixels of cursor movement onto the frame or the ctrl that already works.
 * Note this cannot be bought with `overscroll-behavior: contain`, which was the
 * cheap-looking half: that governs the *browser's* chaining and does nothing at
 * all about an ancestor's JS listener, which is the whole mechanism here.
 *
 * Pure, so the rules above are tested rather than described. The DOM half —
 * which boxes are on the way up, and what their overflow computes to — is
 * `Canvas`'s, and it is gated on a `data-scroll` marker for the reason
 * `data-grip` and `data-text` are markers: a wheel fires at trackpad rate, and
 * reading `scrollHeight` forces a layout of a subtree the zoom has just
 * re-laid-out. One `closest()` on the ground costs nothing; measuring ten
 * ancestors per event on a wall being zoomed is the class of thing that has made
 * this wall slow twice. The marker is paired with the CSS by
 * `test/styles.test.ts`, the same way `data-text` is, because a scroller that
 * forgets it is silently back to this bug.
 */

/** Which way a turn of the wheel is pointing. */
export type Axis = "x" | "y";

/** As much of a `WheelEvent` as any of this reads. */
export type Turn = {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  /** ORed with `ctrlKey` rather than asked separately, the way `pick.ts` takes
   *  the toggle modifier: this file never has to know which platform it is on. */
  metaKey: boolean;
};

/** What one box can do about a wheel on one axis.
 *
 *  Two fields because there are two ways not to be a scroller and they fail in
 *  opposite directions. Missing `container` and swallowing the wheel is a widget
 *  where nothing happens; missing `beyond` and letting it through is a widget
 *  that is a hole in the wall's zoom. */
export type Reach = {
  /** Computed overflow on this axis is one the browser scrolls — `auto`,
   *  `scroll` or `overlay`. */
  container: boolean;
  /** Content beyond the box on this axis, in px: `scrollWidth - clientWidth`,
   *  or `scrollHeight - clientHeight`. */
  beyond: number;
};

/** One box on the way from what the wheel was over up to the wall. */
export type Box = { x: Reach; y: Reach };

/** What the wall should do with a turn of the wheel. */
export type Meaning = "zoom" | "pan" | "scroll";

/** Slack this small is not something to scroll. Sub-pixel layout rounding
 *  leaves `scrollHeight - clientHeight` at a fraction on boxes that visibly do
 *  not scroll, and a scroller with half a pixel in hand would eat the wheel and
 *  then not move — the worst of both answers. `STICK_PX` in `follow.ts` is the
 *  same kind of slack for the same kind of reason, an order of magnitude up,
 *  because it is about a *reading* rather than about whether a box scrolls. */
export const BEYOND_PX = 1;

/** Whether a box genuinely scrolls on the axis this reach describes. */
export function scrolls(reach: Reach): boolean {
  return reach.container && reach.beyond > BEYOND_PX;
}

/** The axis a turn of the wheel is on, or `null` for a turn with no delta —
 *  which Chromium does send, on a modifier press mid-gesture.
 *
 *  The dominant delta wins, and ties go to `y`: a trackpad reports both axes on
 *  a diagonal swipe, and the wall's own reading of the wheel has always been the
 *  vertical one. */
export function axisOf(turn: Turn): Axis | null {
  const x = Math.abs(turn.deltaX);
  const y = Math.abs(turn.deltaY);
  if (x === 0 && y === 0) return null;
  return x > y ? "x" : "y";
}

/** What this turn of the wheel means, given the boxes between what it landed on
 *  and the wall — nearest first, which is the order the browser would chain in.
 *
 *  The caller preventDefaults on `zoom` and `pan` and leaves `scroll` alone;
 *  `{ passive: false }` stays either way, since the two wall answers still need
 *  the call. */
export function wheelMeaning(turn: Turn, chain: readonly Box[]): Meaning {
  if (turn.ctrlKey || turn.metaKey) return "zoom";
  if (turn.shiftKey) return "pan";
  const axis = axisOf(turn);
  if (axis && chain.some((box) => scrolls(box[axis]))) return "scroll";
  return "zoom";
}

/** Which computed `overflow-x`/`overflow-y` values the browser scrolls.
 *
 *  Here rather than in the component because it is knowledge about CSS rather
 *  than about this wall, and because the list is the half of `container` that
 *  can be got wrong quietly: `hidden` is programmatically scrollable and the
 *  wheel does not touch it, and `overlay` is deprecated but still what some
 *  builds compute for `auto`. */
export function overflowScrolls(computed: string): boolean {
  return computed === "auto" || computed === "scroll" || computed === "overlay";
}
