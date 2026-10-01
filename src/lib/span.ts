/* The studio spread over every screen: one window over the bounding box of all
   the monitors, the wall across the whole of it, and the chrome — header,
   panel, dock — kept on the screen the window was on when it spread.

   Rust hands back where that screen is in *physical* pixels relative to the
   window (`window.rs::SpanView`), because that is the unit monitors are
   described in. This turns it into what CSS lays out in. A spread window has
   one device pixel ratio across every screen it covers — that is the whole of
   the size jump on a mixed-DPI desk, and it is also what makes this a plain
   division rather than a per-screen one. */

export type Rect = { x: number; y: number; w: number; h: number };

/** What `span_screens` answers while spread. Physical pixels, relative to the
 *  window's client top-left — CSS 0. `shift` is how far that origin moved to
 *  spread (old minus new), drawn at `scale`. */
export type SpanView = {
  home: Rect;
  screens: Rect[];
  shift: [number, number];
  scale: number;
};

/** The home screen's insets from each edge of the window, in CSS pixels — what
 *  the studio root is positioned by while spread.
 *
 *  Right and bottom are measured off the window's own CSS size rather than off
 *  the union Rust measured, since the CSS size is what the insets are laid out
 *  inside; the clamp only stops a rounding disagreement between the two from
 *  becoming a negative inset. Rounded, since a fractional inset is a soft edge
 *  on every border the chrome draws. */
export function homeInsets(
  view: SpanView,
  dpr: number,
  win: { w: number; h: number },
): { x: number; y: number; r: number; b: number } {
  const k = dpr > 0 ? dpr : 1;
  const x = Math.round(view.home.x / k);
  const y = Math.round(view.home.y / k);
  const w = Math.round(view.home.w / k);
  const h = Math.round(view.home.h / k);
  return {
    x,
    y,
    r: Math.max(0, win.w - x - w),
    b: Math.max(0, win.h - y - h),
  };
}

/** How far to pan the wall so that spreading does not move it on the glass.
 *
 *  The surface's origin moves twice: the window's client origin jumps to the
 *  union's top-left (`shift`, physical), and the surface stops starting below
 *  the header and starts at the top of the window instead — the header is then
 *  drawn *over* it. Panning by both keeps every card where it was. Un-spreading
 *  pans back by the same amount, which is exact when the window returns to the
 *  frame it left. */
export function spreadPan(view: SpanView, barPx: number): { x: number; y: number } {
  const k = view.scale > 0 ? view.scale : 1;
  return { x: view.shift[0] / k, y: view.shift[1] / k + barPx };
}
