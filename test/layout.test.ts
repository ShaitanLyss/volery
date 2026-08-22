import { expect, test, describe } from "bun:test";
import {
  CARD_BOX,
  CARD_W,
  DROP_MAX_EDGE,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_REST,
  PIN_COLS,
  PIN_GAP,
  pinSpot,
  REGION_COLS,
  REGION_GAP,
  REGION_HEAD,
  REGION_PAD,
  REGION_W,
  SLOT_H,
  SLOT_W,
  TERRITORY_COLS,
  TERRITORY_W,
  WALL_MIN,
  Z_CARD,
  Z_CHIP,
  Z_FRONT,
  fitViewport,
  layout,
  lodFor,
  nextBackZ,
  nextFrontZ,
  READ_MAX,
  READ_MIN,
  READ_REST,
  READ_STEP,
  nudgeReading,
  panelWidth,
  readingScale,
  settle,
  territoryColumn,
  wallOrder,
  touches,
  contains,
  type Lod,
  type Placeable,
  type Placement,
} from "../src/lib/layout";

const conv = (id: string, cwd: string): Placeable => ({
  id,
  cwd,
  project: cwd.split(/[\\/]/).pop()!,
});

/** A project row. `x`/`y` left off means the grid still places it. */
const proj = (
  name: string,
  root_path: string,
  x: number | null = null,
  y: number | null = null,
) => ({ name, root_path, x, y });

describe("territories", () => {
  test("each project gets its own region, laid out left to right", () => {
    const { regions } = layout(
      [conv("a", "C:/atelier"), conv("b", "C:/nova"), conv("c", "C:/atelier")],
      {},
    );
    expect(regions.map((r) => r.project)).toEqual(["atelier", "nova"]);
    expect(regions[0].x).toBe(0);
    expect(regions[1].x).toBe(REGION_W + REGION_GAP);
  });

  /* They used to run along one line forever: a wall six projects wide fitted at
     a zoom where every card was a smudge, with the whole lower half of the
     screen unused. Filling a row and wrapping had the same fault in miniature —
     three projects wide and one tall before anything grows downwards — so the
     wall grows a square: 1×1, 2×2, 3×3. */
  test("the wall fills as a growing square, not a row at a time", () => {
    const { regions } = layout(
      Array.from({ length: 9 }, (_, i) => conv(String(i), `C:/${i}`)),
      {},
    );
    /* Every project holds one card, so all nine stand the same height and the
       rows read straight off y. */
    const pitch = regions[0].h + REGION_GAP;
    /*     1 2 5
           3 4 6
           7 8 9  */
    const want: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ];
    expect(regions.map((r) => [r.x, r.y])).toEqual(
      want.map(([col, row]) => [col * TERRITORY_W, row * pitch]),
    );
  });

  test("past the last square the rows carry on left to right", () => {
    const { regions } = layout(
      Array.from({ length: TERRITORY_COLS * TERRITORY_COLS + 2 }, (_, i) =>
        conv(String(i), `C:/${i}`),
      ),
      {},
    );
    const pitch = regions[0].h + REGION_GAP;
    expect(regions.slice(-2).map((r) => [r.x, r.y])).toEqual([
      [0, TERRITORY_COLS * pitch],
      [TERRITORY_W, TERRITORY_COLS * pitch],
    ]);
  });

  /* The first cut reserved a fixed cell tall enough for eight cards, so a
     project holding one card sat in four hundred units of empty wall and the
     row below it was pushed miles down for no reason you could see. */
  test("a territory takes only the room it needs, and the next one follows it up", () => {
    const convs = [
      conv("a", "C:/a"),
      ...Array.from({ length: 5 }, (_, i) => conv(`b${i}`, "C:/b")),
      conv("c", "C:/c"),
      conv("d", "C:/d"),
    ];
    const { regions } = layout(convs, {});
    const at = (name: string) => regions.find((r) => r.cwd === `C:/${name}`)!;

    // a and b take the top row of the square; c drops under a, which holds one
    // card — so it follows a's real height up, not a cell sized for eight.
    expect(at("a").y).toBe(0);
    expect(at("c")).toMatchObject({ x: 0, y: at("a").h + REGION_GAP });
    // Nothing but the gap between them.
    expect(at("c").y - (at("a").y + at("a").h)).toBe(REGION_GAP);
    // And d follows b down its own column, cleared of b's five cards.
    expect(at("d")).toMatchObject({ x: TERRITORY_W, y: at("b").h + REGION_GAP });
  });

  test("regions never overlap, in either direction", () => {
    const { regions } = layout(
      Array.from({ length: TERRITORY_COLS * 2 + 1 }, (_, i) =>
        conv(String(i), `C:/${i}`),
      ),
      {},
    );
    for (const a of regions) {
      for (const b of regions) {
        if (a === b) continue;
        const apart =
          a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  /* Packing against real heights is only safe because the result is written
     down (`Skein.#settlePlaces`) instead of re-derived on every paint — a
     placed territory is not repacked by anything a conversation does. */
  test("a settled territory does not move when a neighbour gains cards", () => {
    const projects = [
      proj("a", "C:/a", 0, 0),
      proj("b", "C:/b", TERRITORY_W, 0),
      proj("c", "C:/c", 0, 400),
    ];
    const thin = layout([conv("x", "C:/a")], {}, projects).regions;
    const fat = layout(
      Array.from({ length: 9 }, (_, i) => conv(String(i), "C:/a")),
      {},
      projects,
    ).regions;
    expect(fat.map((r) => [r.x, r.y])).toEqual(thin.map((r) => [r.x, r.y]));
  });

  test("the fill order grows outward from the top-left corner", () => {
    const seq = (cols: number, n: number) =>
      Array.from({ length: n }, (_, i) => territoryColumn(i, cols));
    expect(seq(3, 11)).toEqual([0, 1, 0, 1, 2, 2, 0, 1, 2, 0, 1]);
    expect(seq(2, 6)).toEqual([0, 1, 0, 1, 0, 1]);
    // One column can only ever answer with itself.
    expect(seq(1, 3)).toEqual([0, 0, 0]);
  });

  test("a region grows to hold its cards", () => {
    const one = layout([conv("a", "C:/x")], {}).regions[0];
    const many = layout(
      Array.from({ length: 5 }, (_, i) => conv(String(i), "C:/x")),
      {},
    ).regions[0];
    expect(many.h).toBeGreaterThan(one.h);
  });
});

describe("auto-placement", () => {
  test("cards fill their territory in open order, without overlapping", () => {
    const convs = Array.from({ length: 4 }, (_, i) => conv(String(i), "C:/x"));
    const { laid } = layout(convs, {});
    const seen = new Set(laid.map((l) => `${l.x},${l.y}`));
    expect(seen.size).toBe(4);
    // Two columns, so the third card starts a new row.
    expect(laid[1].y).toBe(laid[0].y);
    expect(laid[2].y).toBe(laid[0].y + SLOT_H);
    expect(laid[1].x).toBe(laid[0].x + SLOT_W);
  });

  test("cards land inside their own project's region", () => {
    const { regions, laid } = layout(
      [conv("a", "C:/atelier"), conv("b", "C:/nova")], {},
    );
    for (const l of laid) {
      const r = regions.find((r) => r.cwd === l.conv.cwd)!;
      expect(l.x).toBeGreaterThanOrEqual(r.x);
      expect(l.x).toBeLessThan(r.x + r.w);
      expect(l.y).toBeGreaterThanOrEqual(r.y);
      expect(l.y).toBeLessThan(r.y + r.h);
    }
  });
});

/* What Tab and shift+Tab step through. */
describe("reading order", () => {
  const ids = (convs: Placeable[], placements: Record<string, Placement> = {}, projects?: ReturnType<typeof proj>[]) =>
    wallOrder(layout(convs, placements, projects).laid).map((c) => c.id);

  test("a territory reads left to right, then down", () => {
    /* Four cards, two columns: 0 1 / 2 3. */
    expect(ids(Array.from({ length: 4 }, (_, i) => conv(String(i), "C:/x")))).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
  });

  test("one territory at a time, in project order", () => {
    const order = ids(
      [conv("a", "C:/nova"), conv("b", "C:/atelier"), conv("c", "C:/nova")],
      {},
      [proj("atelier", "C:/atelier"), proj("nova", "C:/nova")],
    );
    /* Never interleaved: two territories can stand side by side, and Tab
       crossing back and forth between them would be unreadable. */
    expect(order).toEqual(["b", "a", "c"]);
  });

  /* Open order is not reading order once anything has been dragged: `laid`
     still lists a pinned card where it was opened. */
  test("a card dragged to the end of its territory is reached last", () => {
    const convs = [conv("a", "C:/x"), conv("b", "C:/x"), conv("c", "C:/x")];
    const { laid } = layout(convs, {});
    const last = laid[laid.length - 1];
    expect(ids(convs, { a: { x: last.x, y: last.y + SLOT_H, pinned: true } })).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  test("cards side by side order by x, however they were dropped", () => {
    const convs = [conv("a", "C:/x"), conv("b", "C:/x")];
    /* Nothing dropped by hand lands on the pitch, so a few units of wobble
       must not decide which of two neighbours comes first. */
    const order = ids(convs, {
      a: { x: 500, y: 203, pinned: true },
      b: { x: 260, y: 197, pinned: true },
    });
    expect(order).toEqual(["b", "a"]);
  });

  test("the wall's own array is left alone", () => {
    const convs = [conv("a", "C:/x"), conv("b", "C:/x"), conv("c", "C:/x")];
    const { laid } = layout(convs, { a: { x: 0, y: 9999, pinned: true } });
    const before = laid.map((l) => l.conv.id);
    wallOrder(laid);
    expect(laid.map((l) => l.conv.id)).toEqual(before);
  });
});

describe("pinning", () => {
  const pinned: Record<string, Placement> = {
    b: { x: 999, y: 777, pinned: true },
  };

  test("a pinned card keeps exactly where it was dropped", () => {
    const { laid } = layout(
      [conv("a", "C:/x"), conv("b", "C:/x"), conv("c", "C:/x")], pinned,
    );
    const b = laid.find((l) => l.conv.id === "b")!;
    expect(b).toMatchObject({ x: 999, y: 777, pinned: true });
  });

  test("unpinned cards flow around a pinned one instead of leaving a hole", () => {
    const convs = [conv("a", "C:/x"), conv("b", "C:/x"), conv("c", "C:/x")];
    const { laid } = layout(convs, pinned);
    const flowing = laid.filter((l) => !l.pinned);
    // a and c take the first two slots — c does not sit out b's old position.
    expect(flowing).toHaveLength(2);
    expect(flowing[1].x).toBe(flowing[0].x + SLOT_W);
    expect(flowing[1].y).toBe(flowing[0].y);
  });

  test("pinning does not disturb where the others already were", () => {
    const convs = [conv("a", "C:/x"), conv("b", "C:/x")];
    const before = layout(convs, {});
    const after = layout(convs, pinned);
    const aBefore = before.laid.find((l) => l.conv.id === "a")!;
    const aAfter = after.laid.find((l) => l.conv.id === "a")!;
    expect(aAfter.x).toBe(aBefore.x);
    expect(aAfter.y).toBe(aBefore.y);
  });

  /* The bug: a pinned card kept its slot in the flow as well as its own
     position, so every conversation opened afterwards landed underneath it —
     always the same corner, however much free wall there was. Dragging a card
     a short way pins it about where it already sat, so this was the common
     case, not an odd one. */
  test("a card pinned on the grid holds that slot against the flow", () => {
    const slot0 = { x: REGION_PAD, y: REGION_HEAD };
    const { laid } = layout([conv("pinned", "C:/x"), conv("new", "C:/x")], {
      pinned: { ...slot0, pinned: true },
    });

    const fresh = laid.find((l) => l.conv.id === "new")!;
    expect(fresh).not.toMatchObject(slot0);
    expect(fresh.x).toBe(slot0.x + SLOT_W);
    expect(fresh.y).toBe(slot0.y);
  });

  test("close enough to look like a slot is close enough to hold it", () => {
    // Nobody drops a card on the pitch exactly; 12 units off still reads as in.
    const { laid } = layout([conv("pinned", "C:/x"), conv("new", "C:/x")], {
      pinned: { x: REGION_PAD + 12, y: REGION_HEAD - 9, pinned: true },
    });
    expect(laid.find((l) => l.conv.id === "new")!.x).toBe(REGION_PAD + SLOT_W);
  });

  test("a card pinned off the grid reserves nothing", () => {
    /* Carried away from its territory on purpose — the slot it used to be in
       is free wall again, and the next conversation should use it. */
    const { laid } = layout([conv("away", "C:/x"), conv("new", "C:/x")], {
      away: { x: 4000, y: 2400, pinned: true },
    });
    expect(laid.find((l) => l.conv.id === "new")!).toMatchObject({
      x: REGION_PAD,
      y: REGION_HEAD,
    });
  });

  test("the flow keeps filling past a pin, without skipping the gap after it", () => {
    const { laid } = layout(
      [conv("a", "C:/x"), conv("p", "C:/x"), conv("b", "C:/x"), conv("c", "C:/x")],
      // Pinned onto slot 1, so a takes 0, then b and c take 2 and 3.
      { p: { x: REGION_PAD + SLOT_W, y: REGION_HEAD, pinned: true } },
    );
    const at = (id: string) => laid.find((l) => l.conv.id === id)!;
    expect(at("a")).toMatchObject({ x: REGION_PAD, y: REGION_HEAD });
    expect(at("b")).toMatchObject({ x: REGION_PAD, y: REGION_HEAD + SLOT_H });
    expect(at("c")).toMatchObject({ x: REGION_PAD + SLOT_W, y: REGION_HEAD + SLOT_H });
  });

  test("the territory grows to hold a card pinned below its flow", () => {
    const shallow = layout([conv("a", "C:/x")], {}).regions[0].h;
    const deep = layout([conv("a", "C:/x"), conv("p", "C:/x")], {
      p: { x: REGION_PAD, y: REGION_HEAD + SLOT_H * 3, pinned: true },
    }).regions[0].h;
    expect(deep).toBeGreaterThan(shallow);
  });

  test("a stale pin for a closed conversation is simply ignored", () => {
    const { laid } = layout([conv("a", "C:/x")], {
      ghost: { x: 5, y: 5, pinned: true },
    });
    expect(laid).toHaveLength(1);
    expect(laid[0].conv.id).toBe("a");
  });
});

describe("a territory is the project, not the cards standing in it", () => {
  /* Closing the last conversation in a project used to take the project off
     the wall — and with it the "+" that starts the next one. Finishing
     everything and then beginning again in the same place is ordinary. */
  test("a project with no cards still has its territory", () => {
    const { regions } = layout([], {}, [proj("caravan", "C:/atelier/caravan")]);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ project: "caravan", cwd: "C:/atelier/caravan" });
    expect(regions[0].h).toBeGreaterThan(0);
  });

  test("emptying a project leaves every other territory where it was", () => {
    const projects = [proj("a", "C:/a"), proj("b", "C:/b"), proj("c", "C:/c")];
    const full = layout([conv("x", "C:/b")], {}, projects);
    const empty = layout([], {}, projects);
    expect(empty.regions.map((r) => r.x)).toEqual(full.regions.map((r) => r.x));
  });

  test("order follows the project list, not what happens to be open", () => {
    const projects = [proj("first", "C:/1"), proj("second", "C:/2")];
    /* The card lives in the *second* project. Deriving order from cards would
       put it on the left and shuffle the wall as conversations come and go. */
    const { regions } = layout([conv("x", "C:/2")], {}, projects);
    expect(regions.map((r) => r.cwd)).toEqual(["C:/1", "C:/2"]);
  });

  test("a cwd with cards but no project row is kept, at the end", () => {
    const { regions, laid } = layout([conv("x", "C:/stray")], {}, [proj("a", "C:/a")]);
    expect(regions.map((r) => r.cwd)).toEqual(["C:/a", "C:/stray"]);
    expect(laid).toHaveLength(1);
  });

  test("the project's own name wins over a card's idea of it", () => {
    // A worktree card calls itself "skein · fix"; the territory is still skein.
    const branched: Placeable = { id: "w", cwd: "C:/skein", project: "skein · fix" };
    const { regions } = layout([branched], {}, [proj("skein", "C:/skein")]);
    expect(regions[0].project).toBe("skein");
  });

  test("with no projects passed, cards still make their own territories", () => {
    // The old call shape, which the wall used before projects were threaded in.
    const { regions } = layout([conv("x", "C:/x")], {});
    expect(regions.map((r) => r.cwd)).toEqual(["C:/x"]);
  });
});

describe("carrying a territory", () => {
  test("a placed territory stays exactly where it was put", () => {
    const { regions } = layout([], {}, [proj("a", "C:/a", 1234, 567)]);
    expect(regions[0]).toMatchObject({ x: 1234, y: 567 });
  });

  /* The cards go with it. Flowing ones are slots measured off the region's
     origin, so they follow by arithmetic — this is what makes the drag whole
     without touching a single placement. */
  test("the cards flowing in it come along", () => {
    const here = layout([conv("a", "C:/x")], {}, [proj("x", "C:/x", 900, 400)]);
    expect(here.laid[0]).toMatchObject({
      x: 900 + REGION_PAD,
      y: 400 + REGION_HEAD,
    });
  });

  test("a placed territory holds its ground against one being settled", () => {
    /* `first` sits in the top-left cell, which is where the order sends
       `second`; `second` clears it downwards rather than landing on it. */
    const { regions } = layout([], {}, [
      proj("first", "C:/1", 0, 0),
      proj("second", "C:/2"),
    ]);
    expect(regions[0]).toMatchObject({ x: 0, y: 0 });
    expect(regions[1].x).toBe(0);
    expect(regions[1].y).toBeGreaterThanOrEqual(regions[0].h);
  });

  test("something settling under a placed territory clears it, not overlaps it", () => {
    /* Dropped by hand a little off the pitch — the packing does not care where
       the columns are, only whether the boxes touch. */
    const { regions } = layout([], {}, [
      proj("held", "C:/1", 12, 0),
      proj("a", "C:/2"),
      proj("b", "C:/3"),
      proj("c", "C:/4"),
    ]);
    const held = regions[0];
    const under = regions.find((r) => r.x < held.x + held.w && r !== held)!;
    expect(under.y).toBeGreaterThanOrEqual(held.y + held.h);
  });

  test("a territory carried off to the far wall holds nothing back", () => {
    // Nothing is standing in the columns any more, so the next one starts fresh.
    const { regions } = layout([], {}, [
      proj("away", "C:/1", 9000, 4000),
      proj("new", "C:/2"),
    ]);
    expect(regions[1]).toMatchObject({ x: 0, y: 0 });
  });

  /* The wall it actually runs against: every territory carries a position, so
     carrying one somewhere disturbs nothing — the hole it leaves stays a hole,
     which is what makes position memory. An *unsettled* territory would fill
     that hole, exactly as an unpinned card fills a freed slot; the front end
     writes a position down the moment a project appears, so nothing stays
     unsettled long enough for that to be visible. */
  test("moving a placed territory leaves the others exactly where they were", () => {
    const before = layout([], {}, [
      proj("a", "C:/a", 0, 0),
      proj("b", "C:/b", TERRITORY_W, 0),
      proj("c", "C:/c", 0, 400),
    ]).regions;
    const after = layout([], {}, [
      proj("a", "C:/a", 2000, 1000),
      proj("b", "C:/b", TERRITORY_W, 0),
      proj("c", "C:/c", 0, 400),
    ]).regions;
    expect(after.slice(1).map((r) => [r.x, r.y])).toEqual(
      before.slice(1).map((r) => [r.x, r.y]),
    );
  });

  test("a half-written position is not a position", () => {
    // Neither column can be read on its own; both or the grid decides.
    const { regions } = layout([], {}, [proj("a", "C:/a", 500, null)]);
    expect(regions[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("one stacking order for the whole wall", () => {
  /* The bug: cards were pinned at 1000 and territory chips at 1001 in CSS,
     while an image's z-index was its own small z — so "bring to front" could
     only reorder images among themselves, and the front-most image on the wall
     still drew behind every card and every `+`. */
  test("bringing an image to the front puts it above cards and chips", () => {
    expect(nextFrontZ([1, 2, 3])).toBeGreaterThan(Z_CARD);
    expect(nextFrontZ([1, 2, 3])).toBeGreaterThan(Z_CHIP);
  });

  test("front is front, however many times it is asked for", () => {
    let zs = [1, 2];
    for (let i = 0; i < 3; i++) {
      const z = nextFrontZ(zs);
      expect(z).toBeGreaterThan(Math.max(...zs));
      zs = [...zs, z];
    }
  });

  test("a new image lands behind the work, not over it", () => {
    // A reference is something to work from; it should not cover the cards.
    expect(nextBackZ([])).toBeLessThan(Z_CARD);
    expect(nextBackZ([1, 2, 3])).toBe(4);
  });

  test("the back band never creeps up into the cards", () => {
    // Otherwise a wall of references added one at a time eventually covers them.
    expect(nextBackZ([Z_CARD - 1])).toBe(Z_CARD - 1);
    expect(nextBackZ([Z_CARD - 5, Z_CARD - 1])).toBeLessThan(Z_CARD);
  });

  test("an image already at the front does not drag the next one up with it", () => {
    // The back band is computed from the back band alone.
    expect(nextBackZ([5, Z_FRONT + 1])).toBe(6);
  });
});

describe("semantic zoom", () => {
  test("three densities, in order", () => {
    expect(lodFor(0.4)).toBe("field");
    expect(lodFor(1)).toBe("wall");
    expect(lodFor(1.8)).toBe("open");
  });

  test("the thresholds are contiguous — no scale falls through", () => {
    for (let s = 0.34; s <= 2.2; s += 0.02) {
      expect(["field", "wall", "open"]).toContain(lodFor(s));
    }
  });
});

describe("walking into an emptied slot", () => {
  /** A rect as a browser hands one to a FLIP animation: screen pixels. */
  const at = (left: number, top: number) => ({ left, top });

  test("the offset is where the card was, in canvas units", () => {
    /* One slot up, measured at 1:1. */
    const { dx, dy } = settle(at(400, 500 + SLOT_H), at(400, 500), 1);
    expect(dx).toBe(0);
    expect(dy).toBe(SLOT_H);
  });

  test("the zoom is divided out exactly once", () => {
    /* The same move seen at `field`: half the screen distance, and the same
       canvas distance, because the transform plays back inside `.layer`. This
       is the whole of what `svelte/animate`'s `flip` gets wrong here — it would
       give SLOT_H / 0.5 again. */
    const { dy } = settle(at(400, 500 + SLOT_H * 0.5), at(400, 500), 0.5);
    expect(dy).toBe(SLOT_H);

    const wide = settle(at(400, 500 + SLOT_H * 2), at(400, 500), 2);
    expect(wide.dy).toBe(SLOT_H);
  });

  test("a card that did not move is not animated", () => {
    /* Every pinned card on the wall, on every close. */
    expect(settle(at(400, 500), at(400, 500), 1).duration).toBe(0);
  });

  test("further is longer, but never long", () => {
    const near = settle(at(0, SLOT_H), at(0, 0), 1).duration;
    const far = settle(at(0, SLOT_H * 4), at(0, 0), 1).duration;
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    for (const d of [1, 10, 100, 5000]) {
      expect(settle(at(0, d), at(0, 0), 1).duration).toBeLessThanOrEqual(360);
    }
  });

  test("a scale of zero cannot make the offset infinite", () => {
    /* `zoomAt` clamps well above this, but a NaN inside a frame loop is not a
       thing to leave to a clamp somewhere else. */
    const { dx, dy, duration } = settle(at(0, 10), at(0, 0), 0);
    expect(Number.isFinite(dx)).toBe(true);
    expect(Number.isFinite(dy)).toBe(true);
    expect(Number.isFinite(duration)).toBe(true);
  });
});

describe("a card and its slot", () => {
  const DENSITIES: Lod[] = ["field", "wall", "open"];

  /** The invariant the slot sizes exist for, which used to be a claim in a
   *  comment and nothing more. `open` drew a 288×172 card on a 248×116 pitch: it
   *  covered the 40 units of its neighbour where the context ring is drawn, and
   *  the row below covered the speech it had just made room for. Zooming in to
   *  read hid what you zoomed in to read. */
  test("a card never outgrows the slot it is placed in, at any density", () => {
    for (const lod of DENSITIES) {
      expect(CARD_BOX[lod].w).toBeLessThanOrEqual(SLOT_W);
      expect(CARD_BOX[lod].h).toBeLessThanOrEqual(SLOT_H);
    }
  });

  test("every density has a box, and the wall's is the card width", () => {
    for (const lod of DENSITIES) {
      expect(CARD_BOX[lod].w).toBeGreaterThan(0);
      expect(CARD_BOX[lod].h).toBeGreaterThan(0);
    }
    // The marquee used to assume this one at every zoom level.
    expect(CARD_BOX.wall.w).toBe(CARD_W);
  });

  test("density is height only — every card is the same width at every zoom", () => {
    /* Both directions, and only one of them was ever true. `open` has always
       grown downwards because a wider card overlapped its neighbour; `field`
       shrank to 58 on the argument that a card showing only its ring should be
       the size of one, which made zooming out a rearrangement of the wall
       instead of the same wall further off. Nothing was ever placed in the width
       it gave back — the pitch is SLOT_W at every density. */
    for (const lod of DENSITIES) expect(CARD_BOX[lod].w).toBe(CARD_W);
    expect(CARD_BOX.field.h).toBeLessThan(CARD_BOX.wall.h);
    expect(CARD_BOX.open.h).toBeGreaterThan(CARD_BOX.wall.h);
  });
});

/* Both were private while the territory packing and the pin walk were the only
 * callers. The marquee is the third (`pick.ts::covered`), and it needs the
 * distinction between them: everything you can pick up is caught by being
 * touched, and a territory — which is an area rather than a thing standing on
 * the wall — only by being enclosed. */
describe("two boxes", () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

  test("touching needs area in both axes, not merely a shared edge", () => {
    const a = box(0, 0, 100, 100);
    expect(touches(a, box(99, 99, 10, 10))).toBe(true);
    /* Edge to edge. Two cards on adjacent slots share no area, and a band
       dragged to exactly a card's left edge has not reached it. */
    expect(touches(a, box(100, 0, 10, 10))).toBe(false);
    expect(touches(a, box(0, 100, 10, 10))).toBe(false);
    /* Overlapping in one axis only is not overlapping. */
    expect(touches(a, box(50, 200, 10, 10))).toBe(false);
  });

  test("touching is symmetric, and a box touches itself", () => {
    const a = box(10, 20, 30, 40);
    const b = box(30, 40, 30, 40);
    expect(touches(a, b)).toBe(touches(b, a));
    expect(touches(a, a)).toBe(true);
  });

  test("containing allows the edges to coincide, unlike touching", () => {
    const a = box(0, 0, 100, 100);
    expect(contains(a, box(0, 0, 100, 100))).toBe(true);
    expect(contains(a, box(10, 10, 80, 80))).toBe(true);
    /* One unit over any edge is not contained. */
    expect(contains(a, box(-1, 10, 80, 80))).toBe(false);
    expect(contains(a, box(10, 10, 91, 80))).toBe(false);
    expect(contains(a, box(10, 10, 80, 91))).toBe(false);
  });

  test("containing implies touching, and is not implied by it", () => {
    const a = box(0, 0, 100, 100);
    const inner = box(20, 20, 10, 10);
    expect(contains(a, inner) && touches(a, inner)).toBe(true);
    const half = box(90, 90, 40, 40);
    expect(touches(a, half)).toBe(true);
    expect(contains(a, half)).toBe(false);
  });
});

describe("fit", () => {
  test("frames the content and stays within the scale limits", () => {
    const { regions } = layout(
      [conv("a", "C:/x"), conv("b", "C:/y"), conv("c", "C:/z")], {},
    );
    const v = fitViewport(regions, 1280, 800);
    expect(v.scale).toBeGreaterThan(0.33);
    expect(v.scale).toBeLessThanOrEqual(1.15);
    // Everything lands on screen.
    const right = Math.max(...regions.map((r) => r.x + r.w));
    expect(v.x + right * v.scale).toBeLessThanOrEqual(1280);
    expect(v.x).toBeGreaterThanOrEqual(0);
  });

  test("an empty studio is a no-op rather than a division by zero", () => {
    expect(fitViewport([], 1280, 800)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("the reading panel's width", () => {
  test("undragged, it is the third of the window it always was", () => {
    expect(panelWidth(null, 1600)).toBe(PANEL_REST);
    expect(panelWidth(null, 1280)).toBe(410);
    // Its own floor, not 32% of a small window.
    expect(panelWidth(null, 800)).toBe(PANEL_MIN);
  });

  test("dragged, it is what you dragged it to", () => {
    expect(panelWidth(640, 1920)).toBe(640);
    expect(panelWidth(PANEL_MAX, 1920)).toBe(PANEL_MAX);
  });

  test("it cannot be dragged past its limits", () => {
    expect(panelWidth(40, 1920)).toBe(PANEL_MIN);
    expect(panelWidth(4000, 1920)).toBe(PANEL_MAX);
  });

  test("the wall never disappears behind it", () => {
    // 1000 asked for on a 1200 window would leave 200 of wall.
    expect(panelWidth(1000, 1200)).toBe(1200 - WALL_MIN);
  });

  test("but a narrow window still gets a panel it can read", () => {
    // Below PANEL_MIN + WALL_MIN there is no arrangement that satisfies both,
    // and a sliver you cannot widen back is the worse of the two failures.
    expect(panelWidth(500, 500)).toBe(PANEL_MIN);
    expect(panelWidth(null, 400)).toBe(PANEL_MIN);
  });

  test("a width survives being read back at the same window size", () => {
    const w = panelWidth(717, 1440);
    expect(panelWidth(w, 1440)).toBe(w);
  });
});

describe("how big the reading is", () => {
  test("untouched, it is the size the transcript always was", () => {
    expect(readingScale(null)).toBe(READ_REST);
    expect(READ_REST).toBe(1);
  });

  test("it cannot be set past what stays readable", () => {
    expect(readingScale(0.1)).toBe(READ_MIN);
    expect(readingScale(9)).toBe(READ_MAX);
  });

  test("a notch goes up away from you, the way the wall's zoom reads it", () => {
    expect(nudgeReading(1, -100)).toBe(1 + READ_STEP);
    expect(nudgeReading(1, 100)).toBe(1 - READ_STEP);
  });

  test("a notch that would leave the range stops at the end of it", () => {
    expect(nudgeReading(READ_MAX, -100)).toBe(READ_MAX);
    expect(nudgeReading(READ_MIN, 100)).toBe(READ_MIN);
  });

  test("no notch is no change — a trackpad reporting the other axis only", () => {
    expect(nudgeReading(1.15, 0)).toBe(1.15);
  });

  test("a spin never drifts off the notch", () => {
    /* The whole reason this rounds: 0.05 does not exist in binary, so twenty
       additions of it land on 1.0000000000000007 and print as 100.00000000001%
       — and a scale that never equals `READ_REST` again would leave the reset
       and the "did this notch change anything" test both quietly wrong. */
    let s: number = READ_REST;
    for (let i = 0; i < 12; i += 1) s = nudgeReading(s, -1);
    for (let i = 0; i < 12; i += 1) s = nudgeReading(s, 1);
    expect(s).toBe(READ_REST);
    expect(readingScale(s)).toBe(s);
  });

  test("a scale survives being read back", () => {
    const s = nudgeReading(nudgeReading(null, -1), -1);
    expect(readingScale(s)).toBe(s);
  });
});
describe("where a pinned image goes", () => {
  const card = { x: 1000, y: 400 };
  const wide = { w: 420, h: 236 };
  /* Genuinely clear of the card, which is what the comment over this has always
     said and what the code did not do: the old spot put the image's *centre* a
     gap past the card's right edge, so half of it sat behind the card. That was
     harmless-looking, because a reference lives in the z-band below the work,
     and it is still wrong — an image half-hidden behind a card is one you cannot
     read without moving something. */
  const first = {
    x: 1000 + CARD_W + PIN_GAP + wide.w / 2,
    y: 400 + PIN_GAP + wide.h / 2,
  };
  const box = (at: { x: number; y: number }, size = wide) => ({
    x: at.x - size.w / 2,
    y: at.y - size.h / 2,
    w: size.w,
    h: size.h,
  });

  test("the first one sits just clear of the card, to the right and down", () => {
    expect(pinSpot(card, [], wide)).toEqual(first);
    /* Which is to say its left edge, not its middle, is a gap past the card. */
    expect(first.x - wide.w / 2).toBe(1000 + CARD_W + PIN_GAP);
  });

  test("the second does not land on the first", () => {
    const next = pinSpot(card, [box(first)], wide);
    expect(next).not.toEqual(first);
    expect(next.x).toBe(first.x + wide.w + PIN_GAP);
    expect(next.y).toBe(first.y);
  });

  /* The reported bug at the size it was reported: six frames of a render, one
     visible rectangle and five underneath it. Every one has to be somewhere no
     earlier one is, and "no two overlap" is the assertion rather than "no two
     are equal" — two images a pixel apart are the same bug. */
  test("six pinned in a row are six that can all be seen", () => {
    const taken: ReturnType<typeof box>[] = [];
    for (let i = 0; i < 6; i += 1) taken.push(box(pinSpot(card, taken, wide), wide));
    for (let i = 0; i < taken.length; i += 1) {
      for (let j = i + 1; j < taken.length; j += 1) {
        const a = taken[i]!;
        const b = taken[j]!;
        const hit =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(hit).toBe(false);
      }
    }
  });

  /* Rightwards first, because below a card is the next row of cards and to the
     left is where the territory's next column opens. */
  test("the row runs rightwards and then starts another underneath", () => {
    const taken: ReturnType<typeof box>[] = [];
    const spots: { x: number; y: number }[] = [];
    for (let i = 0; i < PIN_COLS + 1; i += 1) {
      const at = pinSpot(card, taken, wide);
      spots.push(at);
      taken.push(box(at, wide));
    }
    for (const s of spots.slice(0, PIN_COLS)) expect(s.y).toBe(first.y);
    expect(spots[PIN_COLS]!.y).toBe(first.y + wide.h + PIN_GAP);
    expect(spots[PIN_COLS]!.x).toBe(first.x);
  });

  /* Three wide so the block stays roughly square as it grows, rather than a
     line that ends up a screen from the card it belongs to. */
  test("nine pins make a block rather than a line", () => {
    const taken: ReturnType<typeof box>[] = [];
    const spots: { x: number; y: number }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const at = pinSpot(card, taken, wide);
      spots.push(at);
      taken.push(box(at, wide));
    }
    expect(new Set(spots.map((s) => s.x)).size).toBe(PIN_COLS);
    expect(new Set(spots.map((s) => s.y)).size).toBe(3);
  });

  /* An image somebody dragged into the gap is as much in the way as one the wall
     put there, which is why `#boxes` hands over every image and not only the
     pinned ones. */
  test("something already sitting in the first spot is stepped around", () => {
    const next = pinSpot(card, [box(first, { w: 200, h: 200 })], wide);
    expect(next).not.toEqual(first);
  });

  test("a wall with nothing near the card puts it in the first spot", () => {
    expect(pinSpot(card, [box({ x: -4000, y: -4000 })], wide)).toEqual(first);
  });

  /* A wall so full that the whole walk is blocked still puts the image somewhere
     it can be dragged from. A refusal here would be a file in storage with
     nothing drawn — the same judgement `spotBeside` makes about a card the
     layout has never heard of. */
  test("a wall with no room left stacks rather than refusing", () => {
    const everywhere = { x: -10_000, y: -10_000, w: 40_000, h: 40_000 };
    const at = pinSpot(card, [everywhere], wide);
    expect(Number.isFinite(at.x)).toBe(true);
    expect(Number.isFinite(at.y)).toBe(true);
  });

  /* A tall image steps down by its own height rather than by a fixed pitch,
     which is the whole reason the size is measured before the spot is chosen. */
  test("the step is the image's own box, not a fixed cell", () => {
    const tall = { w: 236, h: 420 };
    const one = pinSpot(card, [], tall);
    const two = pinSpot(card, [box(one, tall)], tall);
    expect(two.x - one.x).toBe(tall.w + PIN_GAP);
  });
});
