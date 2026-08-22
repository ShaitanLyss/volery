import { expect, test, describe } from "bun:test";
import {
  covered,
  dedupe,
  haulLabel,
  haulOf,
  haulSize,
  has,
  idsOf,
  keyOf,
  marqueed,
  NO_PICKS,
  pressed,
  tapped,
  without,
  withoutKind,
  type Pick,
  type Standing,
  type World,
} from "../src/lib/pick";
import { CARD_BOX, REGION_W } from "../src/lib/layout";

const card = (id: string): Pick => ({ kind: "card", id });
const image = (id: string): Pick => ({ kind: "image", id });
const widget = (id: string): Pick => ({ kind: "widget", id });
const region = (id: string): Pick => ({ kind: "region", id });

const keys = (sel: readonly Pick[]) => sel.map(keyOf);

describe("one selection, four kinds", () => {
  test("a kind and an id together name a thing", () => {
    expect(keyOf(card("a"))).toBe("card:a");
    expect(keyOf(image("a"))).toBe("image:a");
    /* Two kinds are allowed to mint the same id — a widget's uuid and an
       image's are drawn from the same generator — and must not collide. */
    expect(keyOf(card("a"))).not.toBe(keyOf(image("a")));
  });

  test("has asks about the pair, not the id", () => {
    const sel = [card("a"), image("b")];
    expect(has(sel, card("a"))).toBe(true);
    expect(has(sel, image("a"))).toBe(false);
    expect(has(sel, image("b"))).toBe(true);
  });

  test("idsOf reads one kind out in the order it was picked", () => {
    const sel = [card("c"), image("i"), card("a"), widget("w")];
    expect(idsOf(sel, "card")).toEqual(["c", "a"]);
    expect(idsOf(sel, "image")).toEqual(["i"]);
    expect(idsOf(sel, "region")).toEqual([]);
  });

  test("dedupe keeps the first of each, so the order survives a merge", () => {
    const sel = [card("a"), image("i"), card("a"), card("b")];
    expect(keys(dedupe(sel))).toEqual(["card:a", "image:i", "card:b"]);
  });

  test("things can be taken out one at a time or by kind", () => {
    const sel = [card("a"), image("i"), card("b"), widget("w")];
    expect(keys(without(sel, card("a")))).toEqual(["image:i", "card:b", "widget:w"]);
    expect(keys(withoutKind(sel, "card"))).toEqual(["image:i", "widget:w"]);
  });
});

describe("the two modifiers", () => {
  test("a plain press on something new picks only it", () => {
    expect(keys(pressed([card("a"), card("b")], card("c")))).toEqual(["card:c"]);
  });

  /* The subtlety the whole feature rests on: collapsing on the press makes it
     impossible to drag a group by one of its members. */
  test("a plain press on something already picked leaves the selection alone", () => {
    const sel = [card("a"), image("i"), region("p")];
    expect(keys(pressed(sel, image("i")))).toEqual(["card:a", "image:i", "region:p"]);
  });

  test("and the release collapses it, if the press never travelled", () => {
    const sel = [card("a"), image("i")];
    expect(keys(tapped(sel, image("i")))).toEqual(["image:i"]);
  });

  test("ctrl toggles one thing, in either direction", () => {
    expect(keys(pressed([card("a")], card("b"), { ctrl: true }))).toEqual([
      "card:a",
      "card:b",
    ]);
    expect(keys(pressed([card("a"), card("b")], card("a"), { ctrl: true }))).toEqual([
      "card:b",
    ]);
  });

  test("shift adds and never removes", () => {
    expect(keys(pressed([card("a")], card("b"), { shift: true }))).toEqual([
      "card:a",
      "card:b",
    ]);
    /* The whole difference from ctrl: shift-clicking something you already have
       cannot cost you it, so gathering across a dense territory is safe. */
    expect(keys(pressed([card("a"), card("b")], card("a"), { shift: true }))).toEqual([
      "card:a",
      "card:b",
    ]);
  });

  test("a modified release changes nothing further", () => {
    const after = pressed([card("a")], card("b"), { ctrl: true });
    expect(keys(tapped(after, card("b"), { ctrl: true }))).toEqual(["card:a", "card:b"]);
    expect(keys(tapped(after, card("b"), { shift: true }))).toEqual(["card:a", "card:b"]);
  });

  test("a bare marquee replaces, and either modifier adds", () => {
    const sel = [card("a"), widget("w")];
    const hit = [card("b"), image("i")];
    expect(keys(marqueed(sel, hit))).toEqual(["card:b", "image:i"]);
    expect(keys(marqueed(sel, hit, { shift: true }))).toEqual([
      "card:a",
      "widget:w",
      "card:b",
      "image:i",
    ]);
    expect(keys(marqueed(sel, hit, { ctrl: true }))).toEqual([
      "card:a",
      "widget:w",
      "card:b",
      "image:i",
    ]);
  });

  test("an additive marquee over what is already held does not double it", () => {
    expect(keys(marqueed([card("a")], [card("a"), card("b")], { ctrl: true }))).toEqual([
      "card:a",
      "card:b",
    ]);
  });

  test("a marquee that caught nothing still clears, unless it was additive", () => {
    expect(marqueed([card("a")], [])).toEqual([]);
    expect(keys(marqueed([card("a")], [], { shift: true }))).toEqual(["card:a"]);
  });
});

describe("what a rectangle covers", () => {
  const standing = (
    p: Pick,
    x: number,
    y: number,
    w: number,
    h: number,
    area = false,
  ): Standing => ({ ...p, box: { x, y, w, h }, area });

  test("a thing is caught by being touched, not by being contained", () => {
    const on = [standing(card("a"), 100, 100, CARD_BOX.wall.w, CARD_BOX.wall.h)];
    /* One unit of overlap in each axis. A lasso you have to draw perfectly is a
       lasso you stop using. */
    expect(keys(covered({ x: 0, y: 0, w: 101, h: 101 }, on))).toEqual(["card:a"]);
    /* Edges meeting is not overlap: the band has not reached the card yet. */
    expect(covered({ x: 0, y: 0, w: 100, h: 100 }, on)).toEqual([]);
  });

  test("every kind that stands on the wall is catchable", () => {
    const on = [
      standing(card("c"), 0, 0, CARD_BOX.wall.w, CARD_BOX.wall.h),
      standing(image("i"), 300, 0, 200, 200),
      standing(widget("w"), 0, 300, 120, 90),
    ];
    expect(keys(covered({ x: 0, y: 0, w: 600, h: 600 }, on)).sort()).toEqual([
      "card:c",
      "image:i",
      "widget:w",
    ]);
  });

  test("the card's box is the density's, not the wall's", () => {
    /* `field` is 38 units shorter than `wall`. A marquee that stopped short of
       a card's drawn bottom edge used to catch it anyway. */
    const band = { x: 0, y: 0, w: CARD_BOX.wall.w, h: 60 };
    const atField = [standing(card("a"), 0, 41, CARD_BOX.field.w, CARD_BOX.field.h)];
    const atWall = [standing(card("a"), 0, 41, CARD_BOX.wall.w, CARD_BOX.wall.h)];
    expect(keys(covered(band, atField))).toEqual(["card:a"]);
    expect(keys(covered(band, atWall))).toEqual(["card:a"]);
    /* And stopping above either of them catches neither. */
    expect(covered({ x: 0, y: 0, w: CARD_BOX.wall.w, h: 41 }, atField)).toEqual([]);
  });

  /* A territory is an area rather than an object standing on the wall, so it is
     picked up only by being enclosed. A band drawn *inside* one to gather two
     of its cards would otherwise take the project too, and the next drag would
     move the whole thing. */
  test("a territory has to be enclosed, not merely reached into", () => {
    const terr = standing(region("p"), 0, 0, REGION_W, 400, true);
    const inside = { x: 20, y: 40, w: 100, h: 100 };
    expect(covered(inside, [terr])).toEqual([]);
    expect(keys(covered({ x: -10, y: -10, w: REGION_W + 20, h: 420 }, [terr]))).toEqual([
      "region:p",
    ]);
  });

  test("a band inside a territory still gathers the cards standing in it", () => {
    const on = [
      standing(region("p"), 0, 0, REGION_W, 400, true),
      standing(card("a"), 18, 30, CARD_BOX.wall.w, CARD_BOX.wall.h),
    ];
    expect(keys(covered({ x: 10, y: 20, w: 300, h: 200 }, on))).toEqual(["card:a"]);
  });
});


describe("carrying a selection", () => {
  const world: World = {
    cards: [
      { id: "c1", cwd: "/p", x: 18, y: 30, pinned: false },
      { id: "c2", cwd: "/p", x: 400, y: 500, pinned: true },
      { id: "c3", cwd: "/q", x: 900, y: 30, pinned: false },
    ],
    images: [{ id: "i1", x: 10, y: 10 }],
    widgets: [{ id: "w1", x: 20, y: 20 }],
    regions: [
      { id: "/p", x: 0, y: 0 },
      { id: "/q", x: 800, y: 0 },
    ],
  };

  test("nothing selected hauls nothing", () => {
    expect(haulSize(haulOf([], world))).toBe(0);
  });

  test("one thing of every kind, each with where it stood", () => {
    const h = haulOf([card("c1"), image("i1"), widget("w1")], world);
    expect(h.cards).toEqual([{ id: "c1", x: 18, y: 30 }]);
    expect(h.images).toEqual([{ id: "i1", x: 10, y: 10 }]);
    expect(h.widgets).toEqual([{ id: "w1", x: 20, y: 20 }]);
    expect(h.regions).toEqual([]);
    expect(haulSize(h)).toBe(3);
  });

  test("a hauled territory carries its pinned cards and not its flowing ones", () => {
    const h = haulOf([region("/p")], world);
    expect(h.regions).toEqual([
      { id: "/p", x: 0, y: 0, pins: [{ id: "c2", x: 400, y: 500 }] },
    ]);
    /* Flowing cards follow by arithmetic, since their slots are measured off
       the region's origin. */
    expect(h.cards).toEqual([]);
  });

  /* The one rule worth stating. A pinned card counted twice lands in the same
     place, since every frame is computed from the origin — but a flowing one
     would be pinned where it stands and then have its territory's flow move out
     from under it, which tears the territory in two. */
  test("a card in a hauled territory is not also moved in its own right", () => {
    const h = haulOf([region("/p"), card("c1"), card("c2")], world);
    expect(h.cards).toEqual([]);
    expect(h.regions[0].pins).toEqual([{ id: "c2", x: 400, y: 500 }]);
  });

  test("a card in some *other* territory still comes along", () => {
    const h = haulOf([region("/p"), card("c3")], world);
    expect(h.cards).toEqual([{ id: "c3", x: 900, y: 30 }]);
  });

  test("a pick naming something that has gone is simply not hauled", () => {
    const h = haulOf([card("gone"), image("gone"), region("/nowhere")], world);
    expect(haulSize(h)).toBe(0);
  });

  test("a territory counts as one thing however many cards it carries", () => {
    expect(haulSize(haulOf([region("/p")], world))).toBe(1);
  });
});

describe("what the undo menu says about a drag", () => {
  const world: World = {
    cards: [{ id: "c1", cwd: "/p", x: 0, y: 0, pinned: true }],
    images: [{ id: "i1", x: 0, y: 0 }],
    widgets: [],
    regions: [{ id: "/p", x: 0, y: 0 }],
  };

  test("one thing keeps the sentence it always had", () => {
    expect(haulLabel(haulOf([card("c1")], world), card("c1"))).toBe("moving a card");
    expect(haulLabel(haulOf([card("c1")], world), card("c1"), true)).toBe(
      "moving a card on the glass",
    );
    expect(haulLabel(haulOf([region("/p")], world), region("/p"))).toBe(
      "moving a territory",
    );
    expect(haulLabel(haulOf([region("/p")], world), region("/p"), true)).toBe(
      "moving a territory on the glass",
    );
    expect(haulLabel(haulOf([image("i1")], world), image("i1"))).toBe("moving an image");
  });

  test("more than one is counted rather than listed", () => {
    const h = haulOf([card("c1"), image("i1")], world);
    expect(haulLabel(h, card("c1"))).toBe("moving 2 things");
    expect(haulLabel(h, image("i1"), true)).toBe("moving 2 things on the glass");
  });
});

describe("the injected picker", () => {
  /* `Board` and `Widgets` hold one so they can say "what I just put up is
     selected" without owning the wall's selection or importing `Studio` — the
     same arrangement `scribe` has, and the same no-op default. */
  test("the default does nothing and throws nothing", () => {
    expect(() => {
      NO_PICKS.only("image", "a");
      NO_PICKS.drop("image", "a");
    }).not.toThrow();
  });
});
