/* The studio spread over every screen: one window over the bounding box of all
   the monitors, the wall across the whole of it, and the chrome — header,
   panel, dock — kept on the screen the window was on when it spread.

   Rust hands back where that screen is in *physical* pixels relative to the
   window (`window.rs::SpanView`), because that is the unit monitors are
   described in. This turns it into what CSS lays out in. A spread window has
   one device pixel ratio across every screen it covers, and Rust zooms the
   page so that ratio is the *home* screen's own (`window.rs::rezoom`) — so the
   home screen looks exactly as it did before the spread, and so does any other
   screen at the same scale. A screen at another scale is the one that differs,
   which is the honest cost of one window. */

export type Rect = { x: number; y: number; w: number; h: number };

/** What `span_screens` answers while spread. Physical pixels, relative to the
 *  window's client top-left — CSS 0. `shift` is how far that origin moved to
 *  spread (old minus new), drawn at `scale`. */
export type SpanView = {
  home: Rect;
  screens: Rect[];
  client: [number, number];
  shift: [number, number];
  scale: number;
};

/** The home screen's insets from each edge of the window, in CSS pixels — what
 *  the studio root is positioned by while spread.
 *
 *  **Not rounded, and that is the fix for a visible bug.** They were, on the
 *  argument that a fractional inset is a soft edge — but the insets are a
 *  physical offset divided by the ratio, and rounding *that* moved the edge off
 *  the physical pixel it belongs on. With the window at 150%, the primary's
 *  16px offset became 10.67, rounded to 11, which is 16.5 physical pixels: a
 *  half-pixel line of wall showing above the header. An unrounded inset lands
 *  on an exact physical pixel, which is sharp. All four come from physical
 *  figures (`client` rather than `innerWidth`, which the page rounds), for the
 *  same reason. */
export function homeInsets(view: SpanView, dpr: number): { x: number; y: number; r: number; b: number } {
  const k = dpr > 0 ? dpr : 1;
  const [cw, ch] = view.client;
  const { x, y, w, h } = view.home;
  return {
    x: x / k,
    y: y / k,
    r: Math.max(0, cw - x - w) / k,
    b: Math.max(0, ch - y - h) / k,
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
