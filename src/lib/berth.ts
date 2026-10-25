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
 * A dock moored along an edge has one more thing to say: how much of that edge
 * it takes (`DockExtent`). The whole of it, under the panel as well — which is
 * what it always did — or only the width the panel leaves, so a transcript
 * moored to a side keeps its whole column from the title bar to the bottom of
 * the window. That is not a fourth site: it is the same edge, and everything
 * that asks *which* edge (the chrome's memory in `arrange.ts`, the stylesheet's
 * `order`) has the same answer either way.
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

/** How much of its edge a moored dock takes.
 *
 *  `full` is the whole width of the room, under the panel as well, which is
 *  what the dock always did. `available` is what the panel leaves: the dock
 *  stops at the panel's border and the panel runs on past it to the edge of
 *  the window, so the transcript keeps the column it was moored in rather than
 *  giving its foot to a line of text.
 *
 *  Kept apart from the site rather than multiplying it, because it is not a
 *  place. A dock taking the available width at the bottom is still *at the
 *  bottom*, and every reader that asks where the dock is — the chrome
 *  remembered per mooring, the bar's `order`, the handle's title — has the
 *  same answer either way and has no business learning a second spelling of
 *  it. And because an older build reading a berth written by this one drops a
 *  field it does not know and keeps the edge, where a site it did not know
 *  would have sent the dock back to the bottom. */
export type DockExtent = "full" | "available";
export const DOCK_EXTENTS: readonly DockExtent[] = ["full", "available"];

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

/** The dock's berth, which also says how much of its edge it takes. Means
 *  nothing while floating, and is kept anyway: a dock floated off a corner and
 *  put back by the keyboard comes back the width it was. */
export type DockBerth = Berth<DockSite> & { extent: DockExtent };

/** Both of them, which is what one room remembers. */
export type Moorings = { panel: Berth<PanelSite>; dock: DockBerth };

/** A floating panel is a column, so it is taller than it is wide and there is
 *  a floor under both. A floating dock is a line, so it has a width and takes
 *  whatever height the draft has grown to. */
export const MIN_W = 240;
export const MIN_H = 160;

/* `MIN_H` is the *panel's* floor and must not be applied to the dock, whose
   height the berth explicitly does not own — it is whatever the draft has
   grown to. Applied anyway, the y-clamp was computed against 160 for a surface
   ninety pixels tall, so a floating dock dropped near the bottom of the window
   jumped up and sat with a gap under it, which reads as the drop having failed.
   `floatBox` takes the floor as an argument for that one caller. */

/** How close to an edge of the room a drop has to land to moor there.
 *
 *  Generous on purpose. The gesture is "put it over there", not "hit this
 *  line", and the alternative to a wide band is a surface that floats a few
 *  pixels off the edge you meant — which looks like the drop having failed
 *  rather than like a position you chose. */
export const EDGE = 72;

/** How near the middle of its edge a dock has to be aimed to take the whole of
 *  it, either side of the room's centre.
 *
 *  The middle is the special target and everything else along the edge is a
 *  corner, which is the request in its own words: aim at the bottom centre or
 *  the top centre and it is full width, otherwise it is not. So this is the
 *  narrow band and the corners are generous.
 *
 *  **And it has to be narrower than half the narrowest panel**, which is the
 *  number that actually decides it. A dock taking the available width is
 *  centred on what the panel leaves, so its handle sits half a panel off the
 *  room's centre — `PANEL_MIN / 2`, 150px, at the least. Wider than that and
 *  the first pixel of dragging that dock would find its own handle in the
 *  middle band and throw it across the whole window, which is the bug `EDGE`'s
 *  box-not-cursor note records, one axis over. `test/berth.test.ts` holds the
 *  two numbers against each other. */
export const CENTRE = 112;

/** Where a room nobody has moored in starts, and where a double-click puts
 *  things back: the chat a whole column on the right, title bar to foot, and
 *  the dock in the bottom-left corner beside it (Lyss, 2026-10-25). The dock
 *  took the full width until then, under the panel's foot as well. */
export function moorings(): Moorings {
  return {
    panel: { site: "right", x: 0, y: 0, w: 420, h: 520 },
    dock: { site: "bottom", extent: "available", x: 0, y: 0, w: 720, h: 0 },
  };
}

/** The width a dock stored *without* one is read as: the full width, which
 *  is what every dock was drawn at before `extent` existed. Not the default,
 *  which is a choice about rooms nobody has moored in yet — reading an old
 *  berth by it would move a dock somebody already put somewhere. */
const STORED_EXTENT: DockExtent = "full";

export type Box = { x: number; y: number; w: number; h: number };

/** Which site a dragged surface at this box means, for the panel.
 *
 *  The room is the chrome's own — the window, or the home screen's share of it
 *  while spread — because that is where an *edge* is. A float is placed against
 *  the whole window instead, and that asymmetry is the feature: you moor to the
 *  screen the chrome lives on and you float anywhere at all.
 *
 *  **The box, not the cursor**, and that was a bug rather than a refinement.
 *  Measuring from the pointer asks "is your finger near an edge", and what the
 *  gesture means is "is the *thing* near an edge" — which are different by
 *  however far the handle sits from the surface's near side. The dock's handle
 *  is on its top edge, so a docked-bottom dock sits with its cursor a whole
 *  dock-height above the bottom of the window: further than `EDGE`, so the
 *  first pixel of a drag un-moored it and it floated. */
export function panelSiteAt(box: Box, room: Box): PanelSite {
  if (!inside({ x: box.x, y: box.y }, room)) return "float";
  if (box.x - room.x < EDGE) return "left";
  if (room.x + room.w - (box.x + box.w) < EDGE) return "right";
  return "float";
}

/** The dock's, which differs from the panel's in the one point it is carried
 *  by: its handle is centred on its top edge, so that is the point asked
 *  whether it is in the room. The top-left would have answered for a corner of
 *  the dock nobody is holding — and on a window not much wider than the dock,
 *  the left-hand corner of the room could not be reached at all without that
 *  corner leaving the room first and the drop floating. */
export function dockSiteAt(box: Box, room: Box): DockSite {
  if (!inside(carried(box), room)) return "float";
  if (box.y - room.y < EDGE) return "top";
  if (room.y + room.h - (box.y + box.h) < EDGE) return "bottom";
  return "float";
}

/** How much of its edge a dock dropped here takes: the whole of it when aimed
 *  at the middle, what the panel leaves when aimed anywhere else.
 *
 *  Asked of the point the dock is carried by, which is also where the hand is
 *  — the handle is in the middle of the dock's top edge, and `App.svelte`
 *  keeps the grip at the same share of the box as it was taken at, so this is
 *  the cursor to within the handle's own width. Only meaningful for a dock that
 *  `dockSiteAt` moors; a float is a float whatever this says.
 *
 *  **Which corner is not kept**, and that is a decision rather than a gap. An
 *  available-width dock fills what the panel leaves, so it is always in the
 *  corner away from the panel and the side you aimed at could only ever matter
 *  to a dock narrower than the room's free width — which nothing draws. Aimed
 *  at the corner *under* the panel it still means "not across the panel", and
 *  the panel's own side decides where that is. So it follows the panel from
 *  one side to the other without being told, which is what "keep the chat's
 *  column" means. */
export function dockExtentAt(box: Box, room: Box): DockExtent {
  const aim = carried(box).x;
  return Math.abs(aim - (room.x + room.w / 2)) <= CENTRE ? "full" : "available";
}

/** The point a dock is carried by: the middle of its top edge. */
function carried(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y };
}

/** Whether a surface is even in the room the chrome lives in, asked of the
 *  point the drag is carrying.
 *
 *  Asked first, and it is not a tidying-up: the nearness tests are distances
 *  with no far side, so a surface dragged onto the monitor *above* the home
 *  screen is negative pixels from its top edge and would moor there — which is
 *  the one drop that most obviously meant "put it over there, on that screen".
 *  Outside the room is always a float, and the edges are only edges from
 *  within. */
function inside(at: { x: number; y: number }, room: Box): boolean {
  return (
    at.x >= room.x &&
    at.x <= room.x + room.w &&
    at.y >= room.y &&
    at.y <= room.y + room.h
  );
}

/** Whether there is a panel for an available-width dock to stand beside:
 *  `beside` there is, `alone` no panel is both open and moored to a side, and
 *  `cramped` there is one but it leaves too little room. */
export type Beside = "beside" | "alone" | "cramped";

/** The one place that decides it, so the layout (`dockInsets`), the drag (which
 *  leaves the width alone when there is nothing to be beside) and the chord's
 *  say-back cannot disagree about a panel nobody has measured yet.
 *
 *  `panel` is the panel's site *if it is drawn*, null if it is not: a floating
 *  panel divides nothing, and neither does one that is not open.
 *
 *  **Too little left is `cramped`, and a cramped dock takes the full width**,
 *  rather than being drawn narrower than `MIN_W`, the floor a floating dock
 *  already has. A dock squeezed to a sliver beside a wide panel is a field you
 *  cannot write in; the full width under the panel is what it always was, and
 *  is readable. The panel's own clamp (`layout.ts::panelWidth`, which keeps
 *  `WALL_MIN` of wall) means this only bites in a window under about 540px. */
export function besideOf(panel: PanelSite | null, panelW: number, roomW: number): Beside {
  if (panel !== "left" && panel !== "right") return "alone";
  if (!(panelW > 0)) return "alone";
  return roomW - panelW < MIN_W ? "cramped" : "beside";
}

/** How far in from each side of the room a moored dock stops: the panel's
 *  column, on the panel's side, when the dock takes the available width and
 *  there is a panel to stand beside — and zero both sides otherwise, which is
 *  the full width. */
export function dockInsets(
  dock: { site: DockSite; extent: DockExtent },
  panel: PanelSite | null,
  panelW: number,
  roomW: number,
): { left: number; right: number } {
  const none = { left: 0, right: 0 };
  if (dock.site === "float" || dock.extent !== "available") return none;
  if (besideOf(panel, panelW, roomW) !== "beside") return none;
  return panel === "left" ? { left: panelW, right: 0 } : { left: 0, right: panelW };
}

/** What `<space>w a` says back, since the flip often moves nothing you can see
 *  — a dock with nothing beside it is the full width either way, and a
 *  floating one is neither until it is moored. Said so the chord is not taken
 *  for having failed. */
export function dockExtentSaid(extent: DockExtent, site: DockSite, beside: Beside): string {
  const what = extent === "full" ? "dock: full width" : "dock: the width the panel leaves";
  if (site === "float") return `${what} — once it is moored again`;
  if (extent === "available" && beside === "alone") {
    return `${what} — all of it, while no panel is open beside it`;
  }
  if (extent === "available" && beside === "cramped") {
    return `${what} — all of it, while the panel leaves too little room`;
  }
  return what;
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
  minH = MIN_H,
): { x: number; y: number; w: number; h: number } {
  const w = Math.max(MIN_W, Math.min(b.w, room.w || b.w));
  const h = Math.max(minH, Math.min(b.h, room.h || b.h));
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
  const dock = (o.dock ?? {}) as Record<string, unknown>;
  return {
    panel: berthOf(o.panel, PANEL_SITES, d.panel),
    /* `extent` is read on its own: every berth stored before it existed has
       none, and those are full-width docks — which is what they were drawn as.
       Nothing stored at all is a room nobody moored in, and gets the default. */
    dock: {
      ...berthOf(o.dock, DOCK_SITES, d.dock),
      extent:
        DOCK_EXTENTS.find((e) => e === dock.extent) ??
        (o.dock && typeof o.dock === "object" ? STORED_EXTENT : d.dock.extent),
    },
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
