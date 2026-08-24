import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

/* The arithmetic above is only half of what makes the header work; the other
   half is bookkeeping, and it is the half that actually broke. `App.svelte`
   describes each foldable item once, in `barButtons`, and then names it twice
   more: `BAR_ORDER` is what the bar draws, `FOLD_ORDER` is what the ruler
   measures and what the ⋯ panel is filtered from. A key in neither is a button
   that exists only in the array — no error, no warning, nothing in the DOM to
   look at. `token` shipped like that: the keyring panel was written, wired and
   documented as "reachable from the header", and there was no way into it from
   the header at all. `find` had been missing from `BAR_ORDER` since the day it
   was added, present in `FOLD_ORDER` and in `barButtons` and nowhere the bar
   could draw it — so it was never one slip, it is the slip this shape invites.

   Read out of the source rather than imported, because these three lists live
   inside a component and a component cannot be loaded here. Narrow on purpose:
   it asserts the sets agree and nothing about order, which is a judgement. */
describe("the header's three lists", () => {
  const src = readFileSync("src/App.svelte", "utf8");

  /** The keys of one `const NAME = [...]` or `$derived([...])` literal. */
  function keysOf(decl: string, pattern: RegExp): string[] {
    const at = src.indexOf(decl);
    expect(at).toBeGreaterThan(-1);
    /* Whichever terminator comes first: `];` closes a plain array and `);`
       closes the `$derived(` around one, and looking for only one of them finds
       the *next* declaration's instead of this one's end. */
    const ends = ["\n  );", "\n  ];"].map((t) => src.indexOf(t, at)).filter((i) => i > -1);
    expect(ends.length).toBeGreaterThan(0);
    return [...src.slice(at, Math.min(...ends)).matchAll(pattern)].map((m) => m[1]);
  }

  const described = keysOf("const barButtons = $derived(", /\bkey: "([a-z]+)"/g);
  const bar = keysOf("const BAR_ORDER = [", /"([a-z]+)"/g);
  const fold = keysOf("const FOLD_ORDER = [", /"([a-z]+)"/g);

  /* The readings are the other half of the snippet: `tag`, `spend`, `live` and
     `zoom` are spans it writes itself rather than buttons out of `barButtons`,
     so they are named in the order lists and described nowhere. Read out of the
     snippet's own branches, so a fifth needs no edit here — only a branch to
     draw it. */
  const readings = [...src.matchAll(/key === "([a-z]+)"/g)]
    .map((m) => m[1])
    .filter((k) => bar.includes(k) || fold.includes(k));

  test("every item an order list names is one the bar knows how to draw", () => {
    expect(described.length).toBeGreaterThan(5);
    expect([...bar].sort()).toEqual([...described, ...readings.filter((k) => k !== "tag")].sort());
  });

  test("every drawn item can fold, and only drawn items can", () => {
    /* `tag` is the one exception in the other direction: it draws on the left
       of the drag region rather than in the cluster, so it folds without being
       in `BAR_ORDER` — which is exactly what `drawAt` special-cases. */
    expect([...fold].sort()).toEqual([...bar, "tag"].sort());
  });

  test("no key is named twice in a list", () => {
    for (const list of [described, bar, fold]) expect(new Set(list).size).toBe(list.length);
  });
});
