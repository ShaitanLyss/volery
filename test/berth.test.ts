import { describe, expect, test } from "bun:test";
import {
  CENTRE,
  DOCK_EXTENTS,
  DOCK_SITES,
  EDGE,
  MIN_H,
  MIN_W,
  PANEL_SITES,
  besideOf,
  dockExtentAt,
  dockExtentSaid,
  dockInsets,
  dockSiteAt,
  panelSiteAt,
  floatBox,
  moorings,
  mooringsOf,
  nextSite,
  roomsOf,
} from "../src/lib/berth";
import { DRAG_SLOP, PANEL_MIN, PANEL_REST } from "../src/lib/layout";

const ROOM = { x: 0, y: 0, w: 1600, h: 900 };
/* The home screen's share of a window spread over a desk: the chrome's room
   does not start at the window's origin. */
const HOME = { x: 1080, y: 60, w: 2560, h: 1380 };

/* The two surfaces as boxes, because a site is decided by where the *thing* is
   and not by where the finger is. A dock is a line — wide and short — which is
   the whole of why that distinction mattered. */
const panelBox = (x: number, y = 0) => ({ x, y, w: 420, h: 880 });
const dockBox = (x: number, y: number) => ({ x, y, w: 1200, h: 90 });

describe("where a drop moors", () => {
  test("the dock takes the edge it was dropped near", () => {
    expect(dockSiteAt(dockBox(200, 0), ROOM)).toBe("top");
    expect(dockSiteAt(dockBox(200, ROOM.h - 90), ROOM)).toBe("bottom");
  });

  test("the panel takes the edge it was dropped near", () => {
    expect(panelSiteAt(panelBox(0), ROOM)).toBe("left");
    expect(panelSiteAt(panelBox(ROOM.w - 420), ROOM)).toBe("right");
    expect(panelSiteAt(panelBox(600), ROOM)).toBe("float");
  });

  test("a drop in the middle floats", () => {
    expect(dockSiteAt(dockBox(200, 400), ROOM)).toBe("float");
  });

  test("a surface sitting where it is moored reads as moored there", () => {
    /* The bug this signature exists for. It used to take the *cursor*, and the
       dock's handle is on its top edge — so a dock moored along the bottom had
       its cursor a whole dock-height above the window's bottom, further than
       `EDGE`, and the first pixel of a drag un-moored it and it floated. */
    expect(dockSiteAt(dockBox(0, ROOM.h - 90), ROOM)).toBe("bottom");
    expect(panelSiteAt(panelBox(ROOM.w - 420), ROOM)).toBe("right");
  });

  test("the edges are the room's, not the window's", () => {
    /* Spread, the chrome lives on the home screen, so the left edge of the
       room is 1080 across. Without this the panel would moor left whenever it
       was dropped anywhere on the first monitor. */
    expect(panelSiteAt(panelBox(HOME.x + 4, 800), HOME)).toBe("left");
    expect(panelSiteAt(panelBox(4, 800), HOME)).toBe("float");
  });

  test("a surface on another screen floats, however near that screen's edge", () => {
    /* The nearness tests are distances with no far side, so a surface dragged
       onto the monitor above the home screen was negative pixels from its top
       edge and moored there — the one drop that most obviously meant "over
       there". */
    expect(dockSiteAt(dockBox(2000, HOME.y + 4), HOME)).toBe("top");
    expect(dockSiteAt(dockBox(2000, 4), HOME)).toBe("float");
    expect(panelSiteAt(panelBox(HOME.x - 4, 800), HOME)).toBe("float");
    expect(dockSiteAt(dockBox(2000, HOME.y + HOME.h + 40), HOME)).toBe("float");
  });

  test("the band is wide enough to aim at", () => {
    // "Put it over there", not "hit this line".
    expect(dockSiteAt(dockBox(200, EDGE - 1), ROOM)).toBe("top");
    expect(dockSiteAt(dockBox(200, EDGE + 1), ROOM)).toBe("float");
  });
});

describe("how much of its edge a dock takes", () => {
  /* A dock box carried by the middle of its top edge, as `App.svelte` carries
     it: the handle is centred, and the grip is kept at the share of the box it
     was taken at. `aim` is where that handle is. */
  const carriedAt = (aim: number, y: number, w = 720) => ({ x: aim - w / 2, y, w, h: 90 });
  const mid = ROOM.x + ROOM.w / 2;

  test("aimed at the middle of the bottom or the top, it takes the whole edge", () => {
    expect(dockExtentAt(carriedAt(mid, ROOM.h - 90), ROOM)).toBe("full");
    expect(dockExtentAt(carriedAt(mid, 0), ROOM)).toBe("full");
    expect(dockExtentAt(carriedAt(mid - CENTRE, 0), ROOM)).toBe("full");
    expect(dockExtentAt(carriedAt(mid + CENTRE, ROOM.h - 90), ROOM)).toBe("full");
  });

  test("aimed anywhere else along the edge, it takes what the panel leaves", () => {
    for (const aim of [0, 200, mid - CENTRE - 1, mid + CENTRE + 1, 1400, ROOM.w]) {
      expect(dockExtentAt(carriedAt(aim, ROOM.h - 90), ROOM)).toBe("available");
      expect(dockExtentAt(carriedAt(aim, 0), ROOM)).toBe("available");
    }
  });

  test("the middle is the room's, not the window's", () => {
    // Spread, the chrome's room is the home screen, 1080 across.
    const homeMid = HOME.x + HOME.w / 2;
    expect(dockExtentAt(carriedAt(homeMid, HOME.y), HOME)).toBe("full");
    expect(dockExtentAt(carriedAt(ROOM.w / 2, HOME.y), HOME)).toBe("available");
  });

  test("a dock sitting where it is moored reads as moored that wide", () => {
    /* The twitch test, one axis over from `EDGE`'s. A dock taking the
       available width is centred on what the panel leaves, so its handle is
       half a panel off the room's centre — and if that were inside the middle
       band, the first pixel of dragging it would throw it across the window. */
    for (const panel of [PANEL_MIN, PANEL_REST, 700]) {
      const leftOver = ROOM.w - panel;
      // Panel on the right: the dock runs from the left edge to the panel.
      const right = leftOver / 2;
      // Panel on the left: the dock runs from the panel to the right edge.
      const left = panel + leftOver / 2;
      for (const handle of [right, left]) {
        for (const nudge of [-DRAG_SLOP, DRAG_SLOP]) {
          expect(dockExtentAt(carriedAt(handle + nudge, ROOM.h - 90), ROOM)).toBe("available");
        }
      }
    }
    // And a full-width one, whose handle is the room's centre.
    expect(dockExtentAt(carriedAt(mid + DRAG_SLOP, ROOM.h - 90), ROOM)).toBe("full");
  });

  test("the middle band is narrower than half the narrowest panel", () => {
    /* What the test above rests on, stated as the numbers: the handle is 34px
       wide, so a grip can sit 17px off its centre, and the drag has to travel
       its slop before it is a drag at all. */
    expect(CENTRE + 17 + DRAG_SLOP).toBeLessThan(PANEL_MIN / 2);
  });

  test("the left-hand corner can be reached on a window barely wider than the dock", () => {
    /* Carried by its top-left, a 720px dock on an 800px room could not get
       its middle further left than 360 without that corner leaving the room
       and the drop floating. Carried by its handle, it can. */
    const narrow = { x: 0, y: 0, w: 800, h: 700 };
    const box = carriedAt(60, narrow.h - 90);
    expect(box.x).toBeLessThan(0);
    expect(dockSiteAt(box, narrow)).toBe("bottom");
    expect(dockExtentAt(box, narrow)).toBe("available");
  });

  test("and a handle carried off the room still floats", () => {
    expect(dockSiteAt(carriedAt(-10, ROOM.h - 90), ROOM)).toBe("float");
    expect(dockSiteAt(carriedAt(ROOM.w + 10, ROOM.h - 90), ROOM)).toBe("float");
  });
});

describe("where an available-width dock stops", () => {
  const avail = { site: "bottom" as const, extent: "available" as const };

  test("beside a panel moored right, it stops at the panel", () => {
    expect(dockInsets(avail, "right", 460, 1600)).toEqual({ left: 0, right: 460 });
    expect(dockInsets({ ...avail, site: "top" }, "right", 460, 1600)).toEqual({ left: 0, right: 460 });
  });

  test("beside a panel moored left, it starts after it", () => {
    expect(dockInsets(avail, "left", 460, 1600)).toEqual({ left: 460, right: 0 });
  });

  test("a full-width dock and a floating one are never inset", () => {
    expect(dockInsets({ site: "bottom", extent: "full" }, "right", 460, 1600)).toEqual({ left: 0, right: 0 });
    expect(dockInsets({ site: "float", extent: "available" }, "right", 460, 1600)).toEqual({ left: 0, right: 0 });
  });

  test("with nothing beside it, the available width is the whole room", () => {
    // A floating panel divides nothing, and neither does one that is not open.
    expect(dockInsets(avail, "float", 460, 1600)).toEqual({ left: 0, right: 0 });
    expect(dockInsets(avail, null, 460, 1600)).toEqual({ left: 0, right: 0 });
  });

  test("too little left beside the panel and it takes the full width instead", () => {
    expect(dockInsets(avail, "right", 460, 460 + MIN_W)).toEqual({ left: 0, right: 460 });
    expect(dockInsets(avail, "right", 460, 460 + MIN_W - 1)).toEqual({ left: 0, right: 0 });
  });

  test("an unmeasured panel insets nothing", () => {
    expect(dockInsets(avail, "right", 0, 1600)).toEqual({ left: 0, right: 0 });
    expect(dockInsets(avail, "right", NaN, 1600)).toEqual({ left: 0, right: 0 });
  });

  test("whether there is a panel to stand beside is one answer for the layout and the chord", () => {
    expect(besideOf("right", 460, 1600)).toBe("beside");
    expect(besideOf("left", 460, 1600)).toBe("beside");
    expect(besideOf("float", 460, 1600)).toBe("alone");
    expect(besideOf(null, 460, 1600)).toBe("alone");
    // An unmeasured panel is not a cramped one: nothing has said it is wide.
    expect(besideOf("right", 0, 1600)).toBe("alone");
    expect(besideOf("right", NaN, 1600)).toBe("alone");
    expect(besideOf("right", 460, 460 + MIN_W - 1)).toBe("cramped");
    for (const [panel, w, room] of [
      ["right", 460, 1600],
      ["left", 300, 900],
      ["float", 460, 1600],
      [null, 460, 1600],
      ["right", 460, 600],
      ["right", 0, 1600],
    ] as const) {
      const inset = dockInsets(avail, panel, w, room);
      expect(inset.left + inset.right > 0).toBe(besideOf(panel, w, room) === "beside");
    }
  });
});

describe("what the width chord says back", () => {
  test("it says what is now true, and why nothing moved when nothing did", () => {
    expect(dockExtentSaid("full", "bottom", "beside")).toBe("dock: full width");
    expect(dockExtentSaid("full", "bottom", "alone")).toBe("dock: full width");
    expect(dockExtentSaid("available", "bottom", "beside")).toBe("dock: the width the panel leaves");
    expect(dockExtentSaid("available", "top", "alone")).toContain("while no panel is open beside it");
    expect(dockExtentSaid("available", "top", "cramped")).toContain("leaves too little room");
    expect(dockExtentSaid("available", "float", "beside")).toContain("once it is moored again");
    expect(dockExtentSaid("full", "float", "alone")).toContain("once it is moored again");
  });
});

describe("cycling round the ring", () => {
  test("every site is reachable and it comes back round", () => {
    let s = PANEL_SITES[0];
    const seen = [s];
    for (let i = 0; i < PANEL_SITES.length; i++) {
      s = nextSite(PANEL_SITES, s);
      seen.push(s);
    }
    expect(new Set(seen).size).toBe(PANEL_SITES.length);
    expect(seen[seen.length - 1]).toBe(PANEL_SITES[0]);
  });

  test("it starts where the surface has always been", () => {
    // So pressing the chord round the ring puts you back without having to
    // remember which way it goes.
    expect(PANEL_SITES[0]).toBe("right");
    expect(DOCK_SITES[0]).toBe("bottom");
    expect(moorings().panel.site).toBe("right");
    expect(moorings().dock.site).toBe("bottom");
  });

  test("a new room starts with the chat a whole column on the right and the dock in the corner beside it", () => {
    // Lyss, 2026-10-25: the dock bottom left, the chat right.
    expect(moorings().dock.extent).toBe("available");
    expect(dockInsets(moorings().dock, moorings().panel.site, 460, 1600)).toEqual({ left: 0, right: 460 });
  });

  test("the width has its own ring of two", () => {
    expect(DOCK_EXTENTS[0]).toBe("full");
    expect(nextSite(DOCK_EXTENTS, "full")).toBe("available");
    expect(nextSite(DOCK_EXTENTS, "available")).toBe("full");
  });

  test("a site nothing recognises still moves on", () => {
    expect(nextSite(PANEL_SITES, "nowhere" as never)).toBe(PANEL_SITES[0]);
  });
});

describe("a floating berth stays reachable", () => {
  test("a window that shrank borrows it back from the edge", () => {
    const b = floatBox({ x: 1500, y: 800, w: 400, h: 300 }, { w: 800, h: 600 });
    expect(b.x).toBe(400);
    expect(b.y).toBe(300);
  });

  test("widening the window gives it straight back", () => {
    const want = { x: 1500, y: 800, w: 400, h: 300 };
    expect(floatBox(want, { w: 800, h: 600 })).not.toEqual({ ...want });
    expect(floatBox(want, { w: 2400, h: 1400 })).toEqual(want);
  });

  test("a surface larger than the room keeps its head", () => {
    const b = floatBox({ x: 50, y: 50, w: 2000, h: 2000 }, { w: 800, h: 600 });
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  test("nothing collapses below what can be read", () => {
    const b = floatBox({ x: 0, y: 0, w: 10, h: 10 }, { w: 1600, h: 900 });
    expect(b.w).toBe(MIN_W);
    expect(b.h).toBe(MIN_H);
  });

  test("a surface whose height is not the berth's can say so", () => {
    /* `MIN_H` is the panel's floor. The dock's height is the draft's — the
       berth does not own it — and clamping a 90px dock's `y` against a 160px
       floor left it unable to reach the bottom of the window: dropped there it
       jumped up and sat with a gap under it, which reads as a failed drop. */
    const tall = floatBox({ x: 0, y: 1000, w: 600, h: 90 }, { w: 1600, h: 900 });
    expect(tall.y).toBe(900 - MIN_H);
    const dock = floatBox({ x: 0, y: 1000, w: 600, h: 90 }, { w: 1600, h: 900 }, 0);
    expect(dock.y).toBe(900 - 90);
    expect(dock.h).toBe(90);
  });

  test("an unmeasured room clamps nothing", () => {
    // A box of zero is not a box with no room, and the frame between mounting
    // and the first measurement would otherwise stack everything in the corner.
    const b = floatBox({ x: 900, y: 700, w: 400, h: 300 }, { w: 0, h: 0 });
    expect(b.x).toBe(900);
    expect(b.y).toBe(700);
  });
});

describe("reading back what was stored", () => {
  test("nothing at all is the berths this app has always drawn", () => {
    expect(mooringsOf(undefined)).toEqual(moorings());
    expect(mooringsOf(null)).toEqual(moorings());
    expect(mooringsOf("not an object")).toEqual(moorings());
  });

  test("a site a newer build invented degrades to the default one", () => {
    // A panel on the wrong edge is a nuisance; a studio that will not draw is
    // not. Same bargain every opaque JSON column in this app strikes.
    expect(mooringsOf({ panel: { site: "diagonal" } }).panel.site).toBe("right");
  });

  test("a NaN never reaches a layout", () => {
    const m = mooringsOf({ dock: { site: "float", x: NaN, y: "12", w: Infinity } });
    expect(Number.isFinite(m.dock.x)).toBe(true);
    expect(Number.isFinite(m.dock.y)).toBe(true);
    expect(Number.isFinite(m.dock.w)).toBe(true);
    expect(m.dock.site).toBe("float");
  });

  test("a dock stored before it had a width is the full width it was drawn at", () => {
    const m = mooringsOf({ dock: { site: "top", x: 10, y: 20, w: 600, h: 0 } });
    expect(m.dock.site).toBe("top");
    expect(m.dock.extent).toBe("full");
    // Not the new default: that is for rooms nobody has moored in, and reading
    // an old berth by it would move a dock somebody already put somewhere.
    expect(mooringsOf({ dock: { site: "bottom" } }).dock.extent).toBe("full");
    expect(mooringsOf({ panel: { site: "left" } }).dock.extent).toBe(moorings().dock.extent);
  });

  test("a width it does not know is the full one, and the edge is kept", () => {
    const m = mooringsOf({ dock: { site: "top", extent: "diagonal" } });
    expect(m.dock.site).toBe("top");
    expect(m.dock.extent).toBe("full");
    expect(mooringsOf({ dock: 7 }).dock).toEqual(moorings().dock);
    expect(mooringsOf({ dock: "bottom" }).dock).toEqual(moorings().dock);
  });

  test("the available width survives the store", () => {
    const m = mooringsOf({ dock: { site: "bottom", extent: "available" } });
    expect(m.dock.extent).toBe("available");
    const back = roomsOf(JSON.parse(JSON.stringify({ desk: m })));
    expect(back.desk.dock.extent).toBe("available");
  });

  test("every room is normalised, and a broken one does not take the others", () => {
    const rooms = roomsOf({
      laptop: { panel: { site: "left" } },
      desk: 42,
    });
    expect(rooms.laptop.panel.site).toBe("left");
    expect(rooms.desk).toEqual(moorings());
  });
});
