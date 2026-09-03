/* Looking closer at a design, and moving it under the glass.
 *
 * A preview is composed at a fixed viewport (`PREVIEW_VIEWPORT`, 1280×800) and
 * drawn scaled into whatever box it is given — that is `Gallery.svelte`'s whole
 * bargain, and it is what makes three designs comparable: same size composed,
 * same size judged. Fit is therefore the *right* reading for the gallery and
 * the wrong one for a detail: at three panels across a laptop a 12px caption is
 * composed at 12px and drawn at four, which is a design being judged on
 * whether you could read it.
 *
 * So the arithmetic of looking closer lives here, pure and tested, and the
 * component owns only the pointer. Everything below is in **box pixels**: `x`
 * and `y` are the top-left corner of the scaled content within the box it is
 * drawn in, which is the same origin `transform-origin: 0 0` gives the frame,
 * so a view maps to one `translate(x, y) scale(s)` and nothing has to agree
 * about where the middle is.
 *
 * The one rule that is not arithmetic: **fit is the floor.** There is no
 * reading below it — the design is already entirely visible and shrinking it
 * further only makes the box emptier — and having a floor is what lets `0`
 * always mean "back to the picture you started from".
 */

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

/** Where the composed viewport sits inside the box it is drawn in. */
export type View = { scale: number; x: number; y: number };

/** Four times the composed size. Past this a 1280-wide design is being read a
 *  glyph at a time, and the frame is a bitmap by then anyway — the document is
 *  re-rastered by the compositor at whatever scale we set, but the layout was
 *  settled at 1280 and no further detail exists to be uncovered. */
export const MAX_SCALE = 4;

/** How much of the box a fit view is allowed to leave empty before it is worth
 *  calling something else. Two readings within this of each other are the same
 *  reading, and `0` is drawn as pressed rather than offered. */
const EPSILON = 0.001;

/** The scale at which the whole composed viewport is visible — `contain`,
 *  never `cover`, because a design cropped to fill the box is a design you are
 *  deciding about without having seen. */
export function fitScale(box: Size, vp: Size): number {
  if (box.w <= 0 || box.h <= 0 || vp.w <= 0 || vp.h <= 0) return 1;
  return Math.min(box.w / vp.w, box.h / vp.h);
}

/** Fit is the floor and `MAX_SCALE` the ceiling — but the floor wins if the box
 *  is bigger than the composed viewport, since a fit that is already 5× must
 *  not be clamped back down to 4 and leave the design unable to fit its own
 *  stage. */
export function scaleBounds(box: Size, vp: Size): { min: number; max: number } {
  const fit = fitScale(box, vp);
  return { min: fit, max: Math.max(fit, MAX_SCALE) };
}

/** The invariant every other function in this file ends with.
 *
 * Content larger than the box is held so its edges never come inside one —
 * dragging cannot strand the design half off the stage with nothing to grab.
 * Content smaller than the box is *centred* rather than clamped, which is the
 * half that was easy to miss: it is what makes fit look composed rather than
 * pinned to the top-left corner, and it means the same rule serves both the
 * zoomed-in and zoomed-out cases with no branch anywhere else. */
export function clampView(view: View, box: Size, vp: Size): View {
  const { min, max } = scaleBounds(box, vp);
  const scale = Math.min(max, Math.max(min, view.scale || min));
  const axis = (boxLen: number, contentLen: number, v: number) =>
    contentLen <= boxLen
      ? (boxLen - contentLen) / 2
      : Math.min(0, Math.max(boxLen - contentLen, v));
  return {
    scale,
    x: axis(box.w, vp.w * scale, view.x),
    y: axis(box.h, vp.h * scale, view.y),
  };
}

/** The whole design, centred. What the stage opens at and what `0` returns to. */
export function fitView(box: Size, vp: Size): View {
  return clampView({ scale: fitScale(box, vp), x: 0, y: 0 }, box, vp);
}

/** Zoom so that whatever is under `anchor` is still under it afterwards.
 *
 * This is the entire difference between a zoom that feels like a magnifier and
 * one that feels like a slider with a picture attached. The content point under
 * the cursor is computed in composed coordinates *before* the scale changes and
 * pinned back to the same box pixel after — so pointing at a caption and
 * scrolling brings that caption closer, rather than the middle of the design.
 *
 * The clamp afterwards can still move it, and that is correct: an anchor near
 * an edge would otherwise pull the design off its own stage, and honouring the
 * anchor there would mean honouring it into a view that shows the backdrop. */
export function zoomTo(
  view: View,
  scale: number,
  anchor: Point,
  box: Size,
  vp: Size,
): View {
  const { min, max } = scaleBounds(box, vp);
  const next = Math.min(max, Math.max(min, scale));
  /* A view with no scale cannot be anchored against — there is no content
     coordinate to preserve — so fall back to the middle rather than dividing by
     zero and translating the design to NaN, which is a frame that vanishes. */
  if (!view.scale) return clampView({ scale: next, x: 0, y: 0 }, box, vp);
  const cx = (anchor.x - view.x) / view.scale;
  const cy = (anchor.y - view.y) / view.scale;
  return clampView(
    { scale: next, x: anchor.x - cx * next, y: anchor.y - cy * next },
    box,
    vp,
  );
}

export function zoomBy(
  view: View,
  factor: number,
  anchor: Point,
  box: Size,
  vp: Size,
): View {
  return zoomTo(view, view.scale * factor, anchor, box, vp);
}

/** The middle of the box — the anchor for a zoom that came from a button or a
 *  key rather than from a pointer that was somewhere in particular. */
export function centreOf(box: Size): Point {
  return { x: box.w / 2, y: box.h / 2 };
}

/** Drag, in box pixels. */
export function panBy(
  view: View,
  dx: number,
  dy: number,
  box: Size,
  vp: Size,
): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, box, vp);
}

/** One wheel event → a zoom factor.
 *
 * `deltaMode` is read because a mouse reports lines and a trackpad reports
 * pixels, and treating 3 lines as 3 pixels makes a real mouse wheel do nothing
 * at all. The per-event clamp is the other half: a trackpad flick arrives as
 * one delta in the hundreds, and `1.0015^-400` is a 45% jump in a single frame
 * — which reads as the design flinching rather than as zooming. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = Math.max(-120, Math.min(120, px));
  return Math.pow(1.0022, -capped);
}

/** What a button or a key step is worth. */
export const STEP = 1.25;

/** Whether this view is the one `0` would return to, within a hair. Drawn as
 *  pressed rather than offered — an affordance that does nothing when you use
 *  it teaches you to stop trusting the row it is in. */
export function isFit(view: View, box: Size, vp: Size): boolean {
  return Math.abs(view.scale - fitScale(box, vp)) < EPSILON;
}

/** Whether the design is drawn at the size it was composed at. */
export function isActual(view: View): boolean {
  return Math.abs(view.scale - 1) < EPSILON;
}

/** The reading, against the composed viewport rather than against fit.
 *
 * 100% means one composed pixel to one screen pixel, which is the only number
 * here that means anything outside this file: it is the size the agent was told
 * to compose at, so it is the size the design was actually designed for. A
 * percentage of *fit* would change meaning with the window. */
export function readout(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** Whether there is anywhere to pan — the cursor and the hint both turn on it. */
export function canPan(view: View, box: Size, vp: Size): boolean {
  return vp.w * view.scale > box.w + EPSILON || vp.h * view.scale > box.h + EPSILON;
}
