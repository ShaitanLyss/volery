/* Berths: where the two pieces of chrome you work *in* are moored.
 *
 * The transcript panel and the dock were each nailed to one edge — the panel
 * to the right of the wall, the dock along the bottom — and on one screen that
 * is a reasonable thing to have decided for somebody. Over three screens it is
 * not: the wall is spread across all of them and the thing you type into is
 * pinned to a corner of one. So both can be moored somewhere else, and both can
 * come off the edge entirely and float, which is the same gesture as sticking
 * something to the glass and means the same thing — *I put it there*.
 *
 * Three sites each, and the third is the one that matters:
 *
 * - the panel: `right` (where it has always been), `left`, or `float`
 * - the dock: `bottom` (where it has always been), `top`, or `float`
 *
 * There is deliberately no `top`/`bottom` for the panel or `left`/`right` for
 * the dock. A transcript is a column and the dock is a line of text; a panel
 * lying along the bottom is a letterbox and a dock standing up the side is a
 * column of three-character lines. Offering a site that cannot be read is not
 * the same as offering a choice.
 *
 * Pure — no runes, no DOM — so all of it is tested directly. Where a floating
 * one is *drawn* is `App.svelte`, and it owes `--span-*` like everything else
 * placed at viewport coordinates: the studio root is the containing block for
 * anything fixed inside it while spread (`span.ts`), so a berth in window
 * coordinates has to subtract the home screen's offset back off or it lands a
 * screen away from where it was dropped.
 */

import { glassAt } from "./glass";

export type PanelSite = "right" | "left" | "float";
export type DockSite = "bottom" | "top" | "float";

export const PANEL_SITES: readonly PanelSite[] = ["right", "left", "float"];
export const DOCK_SITES: readonly DockSite[] = ["bottom", "top", "float"];

/** Where one surface is moored, and how big it is when it is floating.
 *
 *  `x`/`y` are **window** coordinates — the whole window, every screen
 *  included, which is the point: a floating panel is something you can put on
 *  the middle monitor. `w`/`h` only mean anything while floating; a moored one
 *  is sized by the layout, and by `panelWidth` for the panel's own column. */
export type Berth<S extends string> = {
  site: S;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Both of them, which is what one room remembers. */
export type Moorings = { panel: Berth<PanelSite>; dock: Berth<DockSite> };

/** A floating panel is a column, so it is taller than it is wide and there is
 *  a floor under both. A floating dock is a line, so it has a width and takes
 *  whatever height the draft has grown to. */
export const MIN_W = 240;
export const MIN_H = 160;

/** How close to an edge of the room a drop has to land to moor there.
 *
 *  Generous on purpose. The gesture is "put it over there", not "hit this
 *  line", and the alternative to a wide band is a surface that floats a few
 *  pixels off the edge you meant — which looks like the drop having failed
 *  rather than like a position you chose. */
export const EDGE = 72;

export function moorings(): Moorings {
  return {
    panel: { site: "right", x: 0, y: 0, w: 420, h: 520 },
    dock: { site: "bottom", x: 0, y: 0, w: 720, h: 0 },
  };
}

/** Which site a drop at this point means, for the panel.
 *
 *  The room is the chrome's own — the window, or the home screen's share of it
 *  while spread — because that is where an *edge* is. A float is measured
 *  against the whole window instead, and that asymmetry is the feature: you
 *  moor to the screen the chrome lives on and you float anywhere at all. */
export function panelSiteAt(
  p: { x: number; y: number },
  room: { x: number; y: number; w: number; h: number },
): PanelSite {
  if (!inside(p, room)) return "float";
  if (p.x - room.x < EDGE) return "left";
  if (room.x + room.w - p.x < EDGE) return "right";
  return "float";
}

export function dockSiteAt(
  p: { x: number; y: number },
  room: { x: number; y: number; w: number; h: number },
): DockSite {
  if (!inside(p, room)) return "float";
  if (p.y - room.y < EDGE) return "top";
  if (room.y + room.h - p.y < EDGE) return "bottom";
  return "float";
}

/** Whether a drop even landed in the room the chrome lives in.
 *
 *  Asked first, and it is not a tidying-up: the nearness tests are distances
 *  with no far side, so a drop on the monitor *above* the home screen is
 *  negative pixels from its top edge and moored there — which is the one drop
 *  that most obviously meant "put it over there, on that screen". Outside the
 *  room is always a float, and the edges are only edges from within. */
function inside(
  p: { x: number; y: number },
  room: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    p.x >= room.x && p.x <= room.x + room.w && p.y >= room.y && p.y <= room.y + room.h
  );
}

/** The next site round, which is the keyboard's whole vocabulary here.
 *
 *  A chord cannot point at a place on the screen, so it cycles — and the cycle
 *  starts at the site each surface has always had, so pressing it four times
 *  on a three-site ring puts you back where you were without having to
 *  remember which way round it goes. */
export function nextSite<S extends string>(sites: readonly S[], now: S): S {
  const i = sites.indexOf(now);
  return sites[(i < 0 ? 0 : i + 1) % sites.length];
}

/** A floating berth's box, kept reachable in a window this size.
 *
 *  `glassAt`'s bargain, one surface over, and for the identical reason: what a
 *  position is worth depends on the window it is read back into, so squeezing
 *  the window and widening it again has to give back what you arranged rather
 *  than what survived the squeeze. Unplugging the monitor a floating dock was
 *  on is the case that makes this not optional — without it the thing you type
 *  into is off the screen and there is no gesture left that reaches it. */
export function floatBox(
  b: { x: number; y: number; w: number; h: number },
  room: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(MIN_W, Math.min(b.w, room.w || b.w));
  const h = Math.max(MIN_H, Math.min(b.h, room.h || b.h));
  const at = glassAt({ x: b.x, y: b.y }, { w, h }, { w: room.w, h: room.h });
  return { x: at.x, y: at.y, w, h };
}

/** One surface's berth, out of whatever was in the store.
 *
 *  Normalised on every read and degraded to something drawable, which is the
 *  bargain every opaque JSON column in this app strikes: a knob renamed or a
 *  newer build's data costs no migration and cannot put a NaN inside a layout.
 *  An unknown site is the default site rather than a throw — the failure mode
 *  of guessing wrong is a panel on the wrong edge, and the failure mode of
 *  throwing is a studio that will not draw. */
function berthOf<S extends string>(v: unknown, sites: readonly S[], fallback: Berth<S>): Berth<S> {
  const o = (v ?? {}) as Record<string, unknown>;
  const site = sites.find((s) => s === o.site) ?? fallback.site;
  return {
    site,
    x: num(o.x, fallback.x),
    y: num(o.y, fallback.y),
    w: Math.max(MIN_W, num(o.w, fallback.w)),
    h: Math.max(0, num(o.h, fallback.h)),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function mooringsOf(v: unknown): Moorings {
  const o = (v ?? {}) as Record<string, unknown>;
  const d = moorings();
  return {
    panel: berthOf(o.panel, PANEL_SITES, d.panel),
    dock: berthOf(o.dock, DOCK_SITES, d.dock),
  };
}

/** Every room's moorings, out of whatever was in `localStorage`.
 *
 *  Keyed by screen arrangement (`arrange.ts`) for the reason a glass spot is:
 *  the edge you want the transcript on is a fact about the screens in front of
 *  you, and the answer on a laptop is not the answer on a desk of three. */
export function roomsOf(v: unknown): Record<string, Moorings> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Record<string, Moorings> = {};
  for (const [key, m] of Object.entries(o)) {
    if (typeof key !== "string") continue;
    out[key] = mooringsOf(m);
  }
  return out;
}
