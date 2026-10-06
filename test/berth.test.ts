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

describe("where a drop moors", () => {
  test("the panel takes the edge it was dropped near", () => {
    expect(dockSiteAt({ x: 800, y: 4 }, ROOM)).toBe("top");
    expect(dockSiteAt({ x: 800, y: 896 }, ROOM)).toBe("bottom");
  });

  test("a drop in the middle floats", () => {
    expect(dockSiteAt({ x: 800, y: 450 }, ROOM)).toBe("float");
  });

  test("the panel takes the edge it was dropped near", () => {
    expect(panelSiteAt({ x: 4, y: 450 }, ROOM)).toBe("left");
    expect(panelSiteAt({ x: 1596, y: 450 }, ROOM)).toBe("right");
    expect(panelSiteAt({ x: 800, y: 450 }, ROOM)).toBe("float");
  });

  test("the edges are the room's, not the window's", () => {
    /* Spread, the chrome lives on the home screen, so the left edge of the
       room is 1080 across. Without this the panel would moor left whenever it
       was dropped anywhere on the first monitor. */
    expect(panelSiteAt({ x: HOME.x + 4, y: 800 }, HOME)).toBe("left");
    expect(panelSiteAt({ x: 4, y: 800 }, HOME)).toBe("float");
  });

  test("a drop on another screen floats, however near that screen's edge", () => {
    /* The nearness tests are distances with no far side, so a drop on the
       monitor above the home screen was negative pixels from its top edge and
       moored there — the one drop that most obviously meant "over there". */
    expect(dockSiteAt({ x: 2000, y: HOME.y + 4 }, HOME)).toBe("top");
    expect(dockSiteAt({ x: 2000, y: 4 }, HOME)).toBe("float");
    expect(panelSiteAt({ x: HOME.x - 4, y: 800 }, HOME)).toBe("float");
    expect(dockSiteAt({ x: 2000, y: HOME.y + HOME.h + 40 }, HOME)).toBe("float");
  });

  test("the band is wide enough to aim at", () => {
    // "Put it over there", not "hit this line".
    expect(dockSiteAt({ x: 800, y: EDGE - 1 }, ROOM)).toBe("top");
    expect(dockSiteAt({ x: 800, y: EDGE + 1 }, ROOM)).toBe("float");
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
