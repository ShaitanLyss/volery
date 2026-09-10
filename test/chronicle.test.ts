import { describe, expect, test } from "bun:test";

import {
  ALLOWANCE_MARK,
  CARD_LEVELS,
  DETAIL_MAX,
  DIGEST_ORDER,
  LEVELS,
  MARK_MAX,
  MAX_FLYING,
  WISP_MS,
  allowanceCrossing,
  byNewest,
  clip,
  digest,
  flying,
  newest,
  normalize,
  normalizeAll,
  place,
  statusOf,
  tally,
  unseen,
  unseenCount,
  windowKey,
  type Entry,
  type Level,
} from "../src/lib/chronicle";

/** A drawable row, so a case can say only what it is about. */
function entry(over: Partial<Entry> = {}): Entry {
  return {
    id: "e1",
    from: null,
    projectId: null,
    source: "volery",
    level: "note",
    mark: "something happened",
    detail: "",
    paths: [],
    at: 1_000,
    seenAt: null,
    ...over,
  };
}

describe("the vocabulary", () => {
  /* Nothing on the wire carries the levels, so this assertion is the only thing
     holding the two halves together. If it goes red because `chronicle.rs`
     gained a level, the fix is here and in `statusOf` — not here alone. */
  test("is the four the store may hold, urgent first", () => {
    expect(LEVELS).toEqual(["ask", "bad", "good", "note"]);
  });

  test("a card may write three of the four, and never ask", () => {
    expect(CARD_LEVELS).toEqual(["bad", "good", "note"]);
    expect(CARD_LEVELS).not.toContain("ask");
    /* Every level a card may write is a level the store may hold — the subset
       relation is the whole claim, and a typo in either list breaks it. */
    for (const l of CARD_LEVELS) expect(LEVELS).toContain(l);
  });

  test("the digest reads in the order the levels are declared", () => {
    expect(DIGEST_ORDER).toEqual(LEVELS);
  });

  test("every level draws in a status colour and none invents one", () => {
    const seen = new Set(LEVELS.map((l) => statusOf(l)));
    expect(seen).toEqual(new Set(["ask", "fail", "work", "rest"]));
  });

  test("the four map the way the wall reads colour", () => {
    expect(statusOf("good")).toBe("work");
    expect(statusOf("bad")).toBe("fail");
    expect(statusOf("ask")).toBe("ask");
    expect(statusOf("note")).toBe("rest");
  });
});

describe("normalize", () => {
  test("keeps a whole row", () => {
    const e = normalize({
      id: "a",
      from: "5c42088c",
      projectId: "p1",
      source: "nova · auth",
      level: "good",
      mark: "pushed 4 commits",
      detail: "gate green",
      paths: ["src/a.ts"],
      at: 42,
      seenAt: 99,
    });
    expect(e).toEqual({
      id: "a",
      from: "5c42088c",
      projectId: "p1",
      source: "nova · auth",
      level: "good",
      mark: "pushed 4 commits",
      detail: "gate green",
      paths: ["src/a.ts"],
      at: 42,
      seenAt: 99,
    });
  });

  test("refuses only the two it cannot draw", () => {
    expect(normalize({ mark: "no id" })).toBeNull();
    expect(normalize({ id: "a" })).toBeNull();
    expect(normalize({ id: "a", mark: "   " })).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize("a row")).toBeNull();
    /* Everything else has a sensible absence. */
    expect(normalize({ id: "a", mark: "m" })).not.toBeNull();
  });

  test("an unknown level falls to note, never to ask", () => {
    /* The direction is the point: a newer build writing `warn` must not make the
       entry invisible, and must not let it invent an urgency nobody wrote. */
    expect(normalize({ id: "a", mark: "m", level: "warn" })?.level).toBe("note");
    expect(normalize({ id: "a", mark: "m", level: 7 })?.level).toBe("note");
  });

  test("degrades a hostile row rather than refusing it", () => {
    const e = normalize({
      id: "a",
      mark: "m",
      from: 5,
      projectId: [],
      source: null,
      detail: { x: 1 },
      paths: ["ok", 3, null],
      at: "soon",
      seenAt: Number.NaN,
    });
    expect(e).toEqual({
      id: "a",
      from: null,
      projectId: null,
      source: "volery",
      level: "note",
      mark: "m",
      detail: "",
      paths: ["ok"],
      at: 0,
      seenAt: null,
    });
  });

  test("trims a mark and a detail to what the wall can draw", () => {
    const e = normalize({ id: "a", mark: "x".repeat(400), detail: "y".repeat(900) });
    expect(e!.mark.length).toBe(MARK_MAX);
    expect(e!.detail.length).toBe(DETAIL_MAX);
    /* And says it had to, so "why is this cut off" has an answer. */
    expect(e!.mark.endsWith("…")).toBe(true);
    expect(e!.detail.endsWith("…")).toBe(true);
  });

  test("normalizeAll drops what cannot be drawn and keeps the rest", () => {
    expect(normalizeAll([{ id: "a", mark: "m" }, null, { id: "" }, { id: "b", mark: "n" }])).toHaveLength(2);
    expect(normalizeAll("not a list")).toEqual([]);
    expect(normalizeAll(undefined)).toEqual([]);
  });
});

describe("clip", () => {
  test("leaves what fits alone", () => {
    expect(clip("short", 20)).toBe("short");
    expect(clip("exactly-ten", 11)).toBe("exactly-ten");
  });

  test("never returns more than it was allowed", () => {
    for (const n of [1, 2, 5, 40]) expect(clip("z".repeat(200), n).length).toBeLessThanOrEqual(n);
  });

  test("does not leave a space in front of the ellipsis", () => {
    expect(clip("one two three", 9)).toBe("one two…");
  });
});

describe("order and seen", () => {
  test("byNewest is newest first and does not mutate", () => {
    const rows = [entry({ id: "a", at: 1 }), entry({ id: "b", at: 3 }), entry({ id: "c", at: 2 })];
    expect(byNewest(rows).map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  test("a tie is broken stably rather than left to the sort", () => {
    const rows = [entry({ id: "b", at: 5 }), entry({ id: "a", at: 5 })];
    expect(byNewest(rows).map((e) => e.id)).toEqual(["a", "b"]);
    expect(byNewest([...rows].reverse()).map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("unseen is the ones with no seenAt", () => {
    const rows = [entry({ id: "a" }), entry({ id: "b", seenAt: 10 }), entry({ id: "c" })];
    expect(unseen(rows).map((e) => e.id)).toEqual(["a", "c"]);
    expect(unseenCount(rows)).toBe(2);
    /* Zero is a real answer and not an empty state to paper over. */
    expect(unseenCount([entry({ seenAt: 1 })])).toBe(0);
    expect(unseenCount([])).toBe(0);
  });

  test("newest is the newest, or nothing", () => {
    expect(newest([entry({ id: "a", at: 1 }), entry({ id: "b", at: 9 })])?.id).toBe("b");
    expect(newest([])).toBeNull();
  });
});

describe("the flight", () => {
  test("an entry is a wisp for WISP_MS and then only a row", () => {
    const rows = [entry({ id: "a", at: 10_000 })];
    expect(flying(rows, 10_000).wisps).toHaveLength(1);
    expect(flying(rows, 10_000 + WISP_MS - 1).wisps).toHaveLength(1);
    expect(flying(rows, 10_000 + WISP_MS).wisps).toHaveLength(0);
  });

  test("the newest fly and the rest are counted", () => {
    const rows = Array.from({ length: MAX_FLYING + 4 }, (_, i) =>
      entry({ id: `e${i}`, at: 1_000 + i }),
    );
    const f = flying(rows, 1_100);
    expect(f.wisps).toHaveLength(MAX_FLYING);
    expect(f.overflow).toBe(4);
    /* Newest first, so what is drawn is what just happened. */
    expect(f.wisps[0]!.id).toBe(`e${MAX_FLYING + 3}`);
  });

  test("overflow counts only what was in the air", () => {
    const rows = [
      entry({ id: "fresh", at: 1_000 }),
      entry({ id: "stale", at: 1_000 - WISP_MS - 1 }),
    ];
    const f = flying(rows, 1_000, 1);
    expect(f.wisps.map((e) => e.id)).toEqual(["fresh"]);
    expect(f.overflow).toBe(0);
  });

  test("no motion means no flight, and still leaves the row", () => {
    /* This is the `still` setting, and the half that matters is the second: the
       entry is not drawn as a wisp and is not lost — turning motion off costs an
       animation, never a record. */
    const rows = [entry({ at: 1_000 })];
    expect(flying(rows, 1_000, MAX_FLYING, 0)).toEqual({ wisps: [], overflow: 0 });
    expect(flying(rows, 1_000, 0)).toEqual({ wisps: [], overflow: 0 });
    expect(rows).toHaveLength(1);
  });

  test("a row from a clock that is ahead is in flight, not expired", () => {
    /* portage.ts means rows really do arrive from another machine. The
       alternative is an entry that is never a wisp and never says why. */
    expect(flying([entry({ at: 5_000 })], 1_000).wisps).toHaveLength(1);
  });

  test("nothing in the air is not an error", () => {
    expect(flying([], 1_000)).toEqual({ wisps: [], overflow: 0 });
  });
});

describe("coming back", () => {
  test("groups the unseen, most urgent first, and drops the empty", () => {
    const rows = [
      entry({ id: "n", level: "note" }),
      entry({ id: "b", level: "bad" }),
      entry({ id: "a", level: "ask" }),
      entry({ id: "seen", level: "good", seenAt: 5 }),
    ];
    const groups = digest(rows);
    expect(groups.map((g) => g.level)).toEqual(["ask", "bad", "note"]);
    /* `good` had only a row you have already seen, so there is no line saying
       "finished: 0" to make you check something that did not happen. */
    expect(groups.map((g) => g.label)).toEqual(["wants you", "went wrong", "notes from cards"]);
  });

  test("a group is newest first", () => {
    const rows = [
      entry({ id: "old", level: "bad", at: 1 }),
      entry({ id: "new", level: "bad", at: 9 }),
    ];
    expect(digest(rows)[0]!.entries.map((e) => e.id)).toEqual(["new", "old"]);
  });

  test("nothing waiting is no groups at all", () => {
    expect(digest([])).toEqual([]);
    expect(digest([entry({ seenAt: 1 })])).toEqual([]);
  });

  test("every level can carry a group, and each has a label", () => {
    for (const level of LEVELS as readonly Level[]) {
      const g = digest([entry({ level })]);
      expect(g).toHaveLength(1);
      expect(g[0]!.label.length).toBeGreaterThan(0);
    }
  });
});

describe("tally", () => {
  test("says nothing when there is nothing", () => {
    expect(tally([])).toBe("");
    expect(tally([entry({ seenAt: 1 })])).toBe("");
  });

  test("counts the unseen, and does not say 1 things", () => {
    expect(tally([entry()])).toBe("1 while you were away");
    expect(tally([entry({ id: "a" }), entry({ id: "b" })])).toBe("2 while you were away");
    expect(tally([entry({ id: "a" }), entry({ id: "b", seenAt: 3 })])).toBe("1 while you were away");
  });
});

describe("the allowance crossing", () => {
  const win = (used: number, resetsAt: number | null = 5_000, kind = "five_hour") => ({
    kind,
    resetsAt,
    used,
  });

  test("says nothing below the mark", () => {
    expect(allowanceCrossing(win(ALLOWANCE_MARK - 1), null)).toBeNull();
    expect(allowanceCrossing(win(0), null)).toBeNull();
  });

  test("crosses at the mark, not past it", () => {
    expect(allowanceCrossing(win(ALLOWANCE_MARK), null)).toBe(`five_hour@5000`);
  });

  test("says it once for one window, however often it is asked", () => {
    /* The poll runs every few minutes. Without this the register would fill
       with the same row all afternoon. */
    const first = allowanceCrossing(win(82), null);
    expect(first).not.toBeNull();
    expect(allowanceCrossing(win(84), first)).toBeNull();
    expect(allowanceCrossing(win(99), first)).toBeNull();
  });

  test("says it again after the window resets and fills again", () => {
    /* The case nobody would catch by hand, and the reason the key carries the
       reset: a guard keyed on the kind alone works once and then stops. */
    const first = allowanceCrossing(win(82, 5_000), null);
    expect(allowanceCrossing(win(82, 23_000), first)).toBe("five_hour@23000");
  });

  test("two different windows are two rows", () => {
    const first = allowanceCrossing(win(82, 5_000, "five_hour"), null);
    expect(allowanceCrossing(win(90, 9_000, "weekly"), first)).toBe("weekly@9000");
  });

  test("nothing to read is nothing to say", () => {
    expect(allowanceCrossing(null, null)).toBeNull();
    expect(allowanceCrossing(null, "five_hour@5000")).toBeNull();
    expect(allowanceCrossing(win(Number.NaN), null)).toBeNull();
  });

  test("a window naming no reset still has a key", () => {
    expect(windowKey({ kind: "k", resetsAt: null })).toBe("k@0");
    expect(allowanceCrossing(win(85, null), null)).toBe("five_hour@0");
  });
});

describe("placing a wisp", () => {
  const view = { w: 1000, h: 800 };
  const card = (x: number, y: number) => ({ x, y, w: 200, h: 100 });

  test("a wall-level entry gets no flight at all", () => {
    /* Volery's own rows belong to no position, and a flight from nowhere would
       be a lie about where it came from. */
    expect(place(null, card(500, 400), view)).toBeNull();
  });

  test("rises off its own card and drifts to the register", () => {
    const p = place(card(100, 200), card(800, 100), view);
    expect(p).toEqual({ at: "card", x: 200, y: 200, dx: 700, dy: -50 });
  });

  test("with no register on the wall it rises and fades", () => {
    const p = place(card(100, 200), null, view);
    expect(p?.at).toBe("card");
    expect(p).toMatchObject({ dx: 0 });
    /* Upward: a thing rising and fading reads as noted and filed, where a thing
       sliding sideways to nothing reads as lost. */
    expect((p as { dy: number }).dy).toBeLessThan(0);
  });

  test("a card fully off an edge becomes an edge marker", () => {
    expect(place(card(-400, 300), null, view)).toEqual({
      at: "edge",
      side: "left",
      along: 350,
    });
    expect(place(card(1400, 300), null, view)).toMatchObject({ side: "right" });
    expect(place(card(300, -400), null, view)).toMatchObject({ side: "top" });
    expect(place(card(300, 1400), null, view)).toMatchObject({ side: "bottom" });
  });

  test("a card merely clipped by an edge still flies from its card", () => {
    /* Half off is still somewhere honest to draw. Only a card with no pixel on
       screen has no position. */
    expect(place(card(-100, 300), null, view)?.at).toBe("card");
    expect(place(card(950, 300), null, view)?.at).toBe("card");
  });

  test("the corner case goes to the edge it is further past", () => {
    /* Off the top-left, but much further past the left. Picking arbitrarily
       would put the marker on an edge you are not about to scroll toward. */
    expect(place(card(-900, -250), null, view)).toMatchObject({ side: "left" });
    expect(place(card(-250, -900), null, view)).toMatchObject({ side: "top" });
  });

  test("an edge marker stays inside the viewport", () => {
    const far = place(card(-900, -880), null, view);
    expect((far as { along: number }).along).toBeGreaterThanOrEqual(0);
    const low = place(card(-900, 2000), null, view);
    expect((low as { along: number }).along).toBeLessThanOrEqual(view.h);
  });
});
