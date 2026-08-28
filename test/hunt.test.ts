import { describe, expect, test } from "bun:test";
import {
  MIN_QUERY,
  huntBlocks,
  huntCap,
  matchAt,
  spansOf,
  stepTo,
  tally,
  textOf,
} from "../src/lib/hunt";
import type { Block } from "../src/lib/transcript";
import type { Line } from "../src/lib/conversation.svelte";

const line = (kind: Line["kind"], text: string): Line => ({ kind, text }) as Line;
const one = (key: string, text: string, kind: Line["kind"] = "text"): Block => ({
  kind: "line",
  key,
  line: line(kind, text),
});
const fold = (key: string, ...texts: string[]): Block => ({
  kind: "tools",
  key,
  lines: texts.map((t) => line("tool", t)),
});

describe("where a word occurs", () => {
  test("is found regardless of case", () => {
    expect(spansOf("Read store.rs and STORE.md", "store")).toEqual([
      { from: 5, to: 10 },
      { from: 18, to: 23 },
    ]);
  });

  /* Indices into the original, not into the lowercased copy — the caller slices
     the string it gave. */
  test("comes back as spans of the text as it was written", () => {
    const text = "The Supervisor spawns";
    const [s] = spansOf(text, "supervisor");
    expect(text.slice(s.from, s.to)).toBe("Supervisor");
  });

  /* `aa` in `aaaa` is two matches. A reader stepping through them expects to
     visit four characters twice, not to be shown three overlapping places. */
  test("does not overlap itself", () => {
    expect(spansOf("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  /* One character matches most of any transcript, which is noise rather than a
     reading — and the panel has to draw something per match. */
  test("refuses a query too short to be an answer", () => {
    expect(MIN_QUERY).toBe(2);
    expect(spansOf("everything everywhere", "e")).toEqual([]);
    expect(spansOf("everything", "")).toEqual([]);
    expect(spansOf("everything", "   ")).toEqual([]);
  });

  test("and finds nothing in nothing", () => {
    expect(spansOf("", "store")).toEqual([]);
  });

  /* Surrounding space is the user still typing, not part of the word. */
  test("ignores space around the query", () => {
    expect(spansOf("store.rs", "  store  ")).toEqual([{ from: 0, to: 5 }]);
  });
});

describe("what a block offers to a search", () => {
  test("is its line's text", () => {
    expect(textOf(one("l1", "look at store.rs"))).toBe("look at store.rs");
  });

  /* The decision worth pinning: a fold's contents are searched even though they
     are not currently on screen. The alternative is a find that reports a word
     absent from a transcript that contains it. */
  test("includes what is inside a closed fold", () => {
    const b = fold("l2", "reading store.rs", "editing supervisor.rs");
    expect(textOf(b)).toContain("store.rs");
    expect(textOf(b)).toContain("supervisor.rs");
    expect(spansOf(textOf(b), "supervisor")).toHaveLength(1);
  });
});

describe("hunting a column", () => {
  const blocks = [
    one("a", "start with store.rs"),
    one("b", "nothing here"),
    fold("c", "reading store.rs", "grep for store"),
    one("d", "and finally the store", "you"),
  ];

  test("returns the blocks that carry it, in column order", () => {
    expect(huntBlocks(blocks, "store").map((f) => f.key)).toEqual(["a", "c", "d"]);
  });

  /* The count is *matches*, not blocks — "3 of 17" has to mean seventeen
     occurrences or stepping through it skips some. */
  test("counts occurrences rather than places", () => {
    const found = huntBlocks(blocks, "store");
    expect(found.map((f) => f.spans.length)).toEqual([1, 2, 1]);
    expect(tally(found)).toBe(4);
  });

  test("finds nothing for a word that is not there", () => {
    expect(huntBlocks(blocks, "librespot")).toEqual([]);
    expect(tally([])).toBe(0);
  });

  /* The mapping the panel needs: it counts matches and scrolls to blocks. */
  test("says which block the nth match is in", () => {
    const found = huntBlocks(blocks, "store");
    expect(matchAt(found, 0)).toEqual({ key: "a", nth: 0 });
    expect(matchAt(found, 1)).toEqual({ key: "c", nth: 0 });
    expect(matchAt(found, 2)).toEqual({ key: "c", nth: 1 });
    expect(matchAt(found, 3)).toEqual({ key: "d", nth: 0 });
    expect(matchAt(found, 4)).toBeNull();
    expect(matchAt(found, -1)).toBeNull();
  });
});

describe("stepping through matches", () => {
  test("wraps at both ends, the way every find bar does", () => {
    expect(stepTo(3, 0, 1)).toBe(1);
    expect(stepTo(3, 2, 1)).toBe(0);
    expect(stepTo(3, 0, -1)).toBe(2);
  });

  /* A query that shrinks the match list under the cursor must land somewhere
     real rather than nowhere. */
  test("comes back into range from outside it", () => {
    expect(stepTo(3, 9, 1)).toBe(0);
    expect(stepTo(3, 9, -1)).toBe(2);
    expect(stepTo(3, -4, 1)).toBe(0);
  });

  test("and stays put when there is nothing to step through", () => {
    expect(stepTo(0, 0, 1)).toBe(0);
    expect(stepTo(0, 5, -1)).toBe(0);
  });
});

describe("what the bar says", () => {
  /* The two failing states are different and both are worth saying: too short to
     run is not the same as ran and found nothing. */
  test("says nothing at all while the query is too short", () => {
    expect(huntCap("s", 0, 0)).toBe("");
    expect(huntCap("", 0, 0)).toBe("");
  });

  test("says so when it ran and found nothing", () => {
    expect(huntCap("librespot", 0, 0)).toBe("not in this transcript");
  });

  test("and counts from one, the way a person does", () => {
    expect(huntCap("store", 4, 0)).toBe("1 of 4");
    expect(huntCap("store", 4, 3)).toBe("4 of 4");
  });

  /* Clamped, so a stale cursor cannot draw "5 of 4" for the frame before the
     step lands. */
  test("never claims a match past the end", () => {
    expect(huntCap("store", 4, 9)).toBe("4 of 4");
  });
});
