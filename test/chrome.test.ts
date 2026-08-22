import { describe, expect, test } from "bun:test";
import { costOf, foldChrome, type Measured } from "../src/lib/chrome";

/* Widths that make the arithmetic readable rather than realistic: a gap of 10
   and items of 100 means a run of three costs 330. */
const GAP = 10;
const FOLD = 30;

const items = (...ws: number[]): Measured[] => ws.map((w, i) => ({ key: `k${i}`, width: w }));

describe("costOf", () => {
  test("charges every item a gap, the first one included", () => {
    /* One gap more than flexbox spends. Documented, deliberate, and the reason
       every sum below is a plain comparison. */
    expect(costOf(items(100), GAP)).toBe(110);
    expect(costOf(items(100, 100, 100), GAP)).toBe(330);
  });

  test("nothing costs nothing", () => {
    expect(costOf([], GAP)).toBe(0);
  });

  test("a width that is not a width is free rather than infectious", () => {
    /* `offsetWidth` is 0 before first layout, and a NaN arriving from a
       half-built measurement must not make the whole sum NaN — that would fold
       the entire header on the frame a theme changes. */
    expect(costOf([{ key: "a", width: Number.NaN }, { key: "b", width: 100 }], GAP)).toBe(120);
    expect(costOf([{ key: "a", width: -50 }, { key: "b", width: 100 }], GAP)).toBe(120);
  });
});

describe("foldChrome", () => {
  test("everything fits, and no button is drawn to open an empty panel", () => {
    const fold = foldChrome(400, items(100, 100, 100), GAP, FOLD);
    expect(fold.shown).toEqual(["k0", "k1", "k2"]);
    expect(fold.folded).toEqual([]);
  });

  test("fits exactly, to the pixel, without folding", () => {
    /* 330 of items in 330 of room. The boundary is worth pinning: one pixel of
       pessimism here is a ⋯ button that appears at full screen. */
    const fold = foldChrome(330, items(100, 100, 100), GAP, FOLD);
    expect(fold.folded).toEqual([]);
  });

  test("one pixel short, and the tail folds", () => {
    const fold = foldChrome(329, items(100, 100, 100), GAP, FOLD);
    expect(fold.shown).toEqual(["k0", "k1"]);
    expect(fold.folded).toEqual(["k2"]);
  });

  test("the fold button takes its share before anything is measured against the room", () => {
    /* 350 of room would hold all 330 of items — but it does not, and once it
       does not the button is real: 350 - 40 = 310, which holds two. The item
       that would have fitted had we not needed the button folds rather than
       being drawn over it. This is the case that was worth writing the file
       for. */
    const fold = foldChrome(340, items(100, 100, 100, 100), GAP, FOLD);
    expect(fold.shown).toEqual(["k0", "k1"]);
    expect(fold.folded).toEqual(["k2", "k3"]);
  });

  test("once one item has folded, everything after it folds too", () => {
    /* The third item is wide and does not fit; the fourth is narrow and would.
       It folds anyway, because a bar whose buttons reorder themselves as you
       drag the window edge reads as the header rearranging rather than as the
       header getting shorter. */
    const fold = foldChrome(300, items(100, 100, 400, 20), GAP, FOLD);
    expect(fold.shown).toEqual(["k0", "k1"]);
    expect(fold.folded).toEqual(["k2", "k3"]);
  });

  test("no room at all folds everything, and says so rather than throwing", () => {
    for (const avail of [0, -200, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      const fold = foldChrome(avail, items(100, 100), GAP, FOLD);
      expect(fold.shown).toEqual([]);
      expect(fold.folded).toEqual(["k0", "k1"]);
    }
  });

  test("room for the button and nothing else still leaves the panel reachable", () => {
    /* The state the stylesheet's floor exists to make survivable: the cluster
       has shrunk to nothing, and the one thing left is the way back to
       everything else. */
    const fold = foldChrome(45, items(100, 100), GAP, FOLD);
    expect(fold.shown).toEqual([]);
    expect(fold.folded).toHaveLength(2);
  });

  test("an infinite bar is not a special case", () => {
    const fold = foldChrome(Number.POSITIVE_INFINITY, items(100, 100), GAP, FOLD);
    expect(fold.folded).toEqual([]);
  });

  test("nothing to fold is not a fold", () => {
    expect(foldChrome(0, [], GAP, FOLD)).toEqual({ shown: [], folded: [] });
  });

  test("keys come back in the order they were given", () => {
    /* The caller's order is the priority, and it is the caller's to reorder for
       drawing afterwards — so this must impose no order of its own on either
       half of the answer. */
    const fold = foldChrome(240, items(100, 100, 100, 100, 100), GAP, FOLD);
    expect([...fold.shown, ...fold.folded]).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });
});
