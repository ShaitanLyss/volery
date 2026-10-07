import { describe, expect, test } from "bun:test";
import { glassAt, offsetBy, spotOf, stickTo } from "../src/lib/glass";
import { CARD_BOX, layout, REGION_HEAD, REGION_PAD, SLOT_W } from "../src/lib/layout";

/* A territory keyed on its folder, so these cases go on reading as "the region
   over C:/a" — what is new in v42 is tested where it is new. */
const conv = (id: string, cwd = "C:/a") => ({
  id,
  cwd,
  project: "a",
  projectId: cwd,
  territoryId: cwd,
});
const proj = (
  root_path: string,
  extra: Record<string, number | null> = {},
) => ({
  id: root_path,
  projectId: root_path,
  name: root_path,
  project: root_path,
  cwd: root_path,
  x: 0,
  y: 0,
  ...extra,
});

describe("stickTo", () => {
  test("lands where the thing already looked to be", () => {
    /* At 100% and no pan, a box at (100, 40) of its own size does not move. */
    const at = stickTo(
      { x: 100, y: 40, w: 208, h: 78 },
      { x: 0, y: 0, scale: 1 },
      { w: 208, h: 78 },
    );
    expect(at).toEqual({ x: 100, y: 40 });
  });

  test("keeps the centre, not the corner, when the size changes", () => {
    /* Zoomed out to a half, a 208-wide card is drawn 104 wide — and lands as a
       208-wide card centred on the same point rather than growing rightwards
       off the place you were pointing at. */
    const at = stickTo(
      { x: 0, y: 0, w: 208, h: 78 },
      { x: 0, y: 0, scale: 0.5 },
      { w: 208, h: 78 },
    );
    /* screen centre = 104 * 0.5 = 52 → corner 52 - 104 = -52, i.e. it grows
       both ways rather than only to the right. `glassAt` brings it back in. */
    expect(at).toEqual({ x: -52, y: -19.5 });

    const off = stickTo(
      { x: 200, y: 100, w: 208, h: 78 },
      { x: 0, y: 0, scale: 0.5 },
      { w: 208, h: 78 },
    );
    /* x: screen centre (200 + 104) * 0.5 = 152 → corner 152 - 104 = 48
       y: screen centre (100 + 39) * 0.5 = 69.5 → corner 69.5 - 39 = 30.5 */
    expect(off).toEqual({ x: 48, y: 30.5 });
  });

  test("reads the pan", () => {
    const at = stickTo(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 300, y: 200, scale: 1 },
      { w: 100, h: 100 },
    );
    expect(at).toEqual({ x: 300, y: 200 });
  });
});

describe("glassAt", () => {
  const pane = { w: 1000, h: 600 };

  test("leaves anything already inside alone", () => {
    expect(glassAt({ x: 100, y: 100 }, { w: 200, h: 200 }, pane)).toEqual({
      x: 100,
      y: 100,
    });
  });

  test("borrows a thing back from every edge", () => {
    expect(glassAt({ x: -40, y: -10 }, { w: 200, h: 200 }, pane)).toEqual({
      x: 0,
      y: 0,
    });
    expect(glassAt({ x: 950, y: 580 }, { w: 200, h: 200 }, pane)).toEqual({
      x: 800,
      y: 400,
    });
  });

  test("top-left wins for anything bigger than the pane", () => {
    expect(glassAt({ x: 300, y: 300 }, { w: 2000, h: 2000 }, pane)).toEqual({
      x: 0,
      y: 0,
    });
  });

  test("an unmeasured pane clamps nothing", () => {
    /* The frame between mounting and the first ResizeObserver call. Clamping to
       a box of zero would stack the whole glass in the corner and then snap. */
    expect(glassAt({ x: 420, y: 90 }, { w: 200, h: 200 }, { w: 0, h: 0 })).toEqual({
      x: 420,
      y: 90,
    });
  });
});

describe("a pane offset inside the glass (spread over every screen)", () => {
  /* The glass covers every screen; the home screen's wall area starts 1200px
     in and 56px down. A spot stored before the spread must draw at the same
     place on the home screen after it. */
  const pane = { x: 1200, y: 56, w: 1920, h: 1100 };

  test("a stored spot is drawn at the pane's offset", () => {
    expect(glassAt({ x: 40, y: 30 }, { w: 100, h: 100 }, pane)).toEqual({ x: 1240, y: 86 });
  });

  test("and clamped inside the pane, not inside the whole glass", () => {
    expect(glassAt({ x: -500, y: 5000 }, { w: 100, h: 100 }, pane)).toEqual({ x: 1200, y: 56 + 1000 });
  });

  test("an unmeasured pane still offsets", () => {
    expect(glassAt({ x: 1, y: 2 }, { w: 9, h: 9 }, { x: 10, y: 20, w: 0, h: 0 })).toEqual({ x: 11, y: 22 });
  });

  test("sticking stores the spot relative to the pane, so it round-trips", () => {
    const view = { x: 0, y: 0, scale: 1 };
    const at = stickTo({ x: 1300, y: 100, w: 200, h: 100 }, view, { w: 200, h: 100 }, pane);
    expect(at).toEqual({ x: 100, y: 44 });
    expect(glassAt(at, { w: 200, h: 100 }, pane)).toEqual({ x: 1300, y: 100 });
  });
});

describe("spotOf", () => {
  test("needs both halves", () => {
    expect(spotOf({ glassX: 10, glassY: 20 })).toEqual({ x: 10, y: 20 });
    expect(spotOf({ glassX: 10, glassY: null })).toBeNull();
    expect(spotOf({ glassX: null, glassY: null })).toBeNull();
    expect(spotOf({})).toBeNull();
    expect(spotOf(null)).toBeNull();
  });

  test("refuses a number that is not one", () => {
    expect(spotOf({ glassX: NaN, glassY: 3 })).toBeNull();
    expect(spotOf({ glassX: 3, glassY: Infinity })).toBeNull();
  });

  test("zero is a place", () => {
    expect(spotOf({ glassX: 0, glassY: 0 })).toEqual({ x: 0, y: 0 });
  });
});

test("offsetBy moves by the difference and nothing else", () => {
  expect(offsetBy({ x: 10, y: 10 }, { x: 0, y: 0 }, { x: 5, y: -5 })).toEqual({
    x: 15,
    y: 5,
  });
});

/* ── what the glass must not change ───────────────────────────────────────
 *
 * The one claim the whole feature rests on: the wall is laid out as though
 * nothing were stuck to it. If any of these drift, sticking something starts
 * moving things you were not looking at. */
describe("the wall is laid out as though the glass were empty", () => {
  const three = [conv("a"), conv("b"), conv("c")];

  test("a card on the glass keeps its slot", () => {
    const plain = layout(three, {}, [proj("C:/a")]);
    const stuck = layout(
      three,
      { b: { x: 0, y: 0, pinned: false, glassX: 500, glassY: 40 } },
      [proj("C:/a")],
    );
    for (const id of ["a", "b", "c"]) {
      const p = plain.laid.find((l) => l.conv.id === id)!;
      const s = stuck.laid.find((l) => l.conv.id === id)!;
      expect([s.x, s.y]).toEqual([p.x, p.y]);
    }
    expect(stuck.laid.find((l) => l.conv.id === "b")!.glass).toEqual({
      x: 500,
      y: 40,
    });
    expect(stuck.laid.find((l) => l.conv.id === "c")!.glass).toBeNull();
  });

  test("a territory on the glass keeps its cell and its height", () => {
    const plain = layout(three, {}, [proj("C:/a"), proj("C:/b", { x: null, y: null })]);
    const stuck = layout(three, {}, [
      proj("C:/a", { glassX: 12, glassY: 12 }),
      proj("C:/b", { x: null, y: null }),
    ]);
    expect(stuck.regions.map((r) => [r.x, r.y, r.h])).toEqual(
      plain.regions.map((r) => [r.x, r.y, r.h]),
    );
    expect(stuck.regions[0].glass).toEqual({ x: 12, y: 12 });
    expect(stuck.regions[1].glass).toBeNull();
  });
});

describe("a stuck territory carries its cards", () => {
  test("at the same offsets it has on the wall", () => {
    const at = { x: 400, y: 250 };
    const { regions, laid } = layout([conv("a"), conv("b")], {}, [
      proj("C:/a", { x: 0, y: 0, glassX: at.x, glassY: at.y }),
    ]);
    const r = regions[0];
    for (const n of laid) {
      expect(n.glass).toEqual({
        x: at.x + (n.x - r.x),
        y: at.y + (n.y - r.y),
      });
    }
    /* And that offset is the slot pitch, so the pane shows the same shape. */
    expect(laid[0].glass).toEqual({
      x: at.x + REGION_PAD,
      y: at.y + REGION_HEAD,
    });
    expect(laid[1].glass!.x - laid[0].glass!.x).toBe(SLOT_W);
  });

  test("pinned ones too — the pane would tear otherwise", () => {
    const { regions, laid } = layout(
      [conv("a")],
      { a: { x: 900, y: 700, pinned: true } },
      [proj("C:/a", { x: 0, y: 0, glassX: 100, glassY: 100 })],
    );
    const r = regions[0];
    expect(laid[0].glass).toEqual({ x: 100 + (900 - r.x), y: 100 + (700 - r.y) });
  });

  test("a card stuck itself is not moved by its territory", () => {
    const { laid } = layout(
      [conv("a")],
      { a: { x: 0, y: 0, pinned: false, glassX: 30, glassY: 30 } },
      [proj("C:/a", { x: 0, y: 0, glassX: 600, glassY: 600 })],
    );
    expect(laid[0].glass).toEqual({ x: 30, y: 30 });
  });
});

test("a card on the pane is drawn at wall density", () => {
  /* Not a behaviour so much as the constant the pane is sized against — the
     glass is 1:1, and `wall` is the density 1:1 gives (`lodFor(1)`). */
  expect(CARD_BOX.wall).toEqual({ w: 208, h: 78 });
});

describe("out from under the chrome", () => {
  /* Spread, the pane is the whole window — which is what lets something be
     dragged onto another monitor — so it can reach the two strips of the home
     screen the header and the dock occupy. Those are opaque and painted over
     the glass, so a widget entirely inside one is gone: no handle, no menu,
     and nothing in the reading order to Tab to. */
  const PANE = { w: 4000, h: 1600 };
  /* The home screen sits 1080 across; its header is 60 tall and its dock 90. */
  const HEADER = { x: 1080, y: 0, w: 2560, h: 60 };
  const DOCK = { x: 1080, y: 1510, w: 2560, h: 90 };

  test("something entirely under the header comes out below it", () => {
    const at = glassAt({ x: 1200, y: 10 }, { w: 180, h: 40 }, PANE, [HEADER, DOCK]);
    expect(at.y).toBe(60);
    expect(at.x).toBe(1200);
  });

  test("something entirely under the dock comes out above it", () => {
    // Below the dock is off the pane, so the other way is the only way.
    const at = glassAt({ x: 1200, y: 1520 }, { w: 180, h: 40 }, PANE, [HEADER, DOCK]);
    expect(at.y).toBe(1510 - 40);
  });

  test("something only half covered is left exactly where it was put", () => {
    /* The bound is the whole design: half under the header is something you
       can still take hold of, and shoving it would be the wall rearranging
       itself under a position you chose. */
    const at = glassAt({ x: 1200, y: 40 }, { w: 180, h: 120 }, PANE, [HEADER, DOCK]);
    expect(at.y).toBe(40);
  });

  test("something on another monitor is not touched", () => {
    // The chrome is the home screen's; the rest of the glass has none.
    const at = glassAt({ x: 100, y: 10 }, { w: 180, h: 40 }, PANE, [HEADER, DOCK]);
    expect(at).toEqual({ x: 100, y: 10 });
  });

  test("no chrome, no rescue — which is every unspread window", () => {
    expect(glassAt({ x: 1200, y: 10 }, { w: 180, h: 40 }, PANE)).toEqual({ x: 1200, y: 10 });
  });

  test("the rescue stays on the pane", () => {
    const tall = { w: 2000, h: 1500 };
    const at = glassAt({ x: 0, y: 0 }, tall, PANE, [{ x: 0, y: 0, w: 4000, h: 1600 }]);
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y).toBeLessThanOrEqual(PANE.h - tall.h);
  });
});
