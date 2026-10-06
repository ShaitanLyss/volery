import { describe, expect, test } from "bun:test";
import {
  DOCK_SITES,
  EDGE,
  MIN_H,
  MIN_W,
  PANEL_SITES,
  dockSiteAt,
  panelSiteAt,
  floatBox,
  moorings,
  mooringsOf,
  nextSite,
  roomsOf,
} from "../src/lib/berth";

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

  test("every room is normalised, and a broken one does not take the others", () => {
    const rooms = roomsOf({
      laptop: { panel: { site: "left" } },
      desk: 42,
    });
    expect(rooms.laptop.panel.site).toBe("left");
    expect(rooms.desk).toEqual(moorings());
  });
});
