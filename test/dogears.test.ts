import { describe, expect, test } from "bun:test";

import {
  FUSE_DEFAULT,
  FUSE_MAX,
  FUSE_MIN,
  KEEP_DEFAULT,
  KEEP_MAX,
  burn,
  clampFuse,
  clampKeep,
  drop,
  flatOf,
  fuses,
  keyOf,
  locate,
  mark,
  reap,
  remember,
  reread,
  sayFuse,
  tabLabel,
  touch,
  type Dogear,
} from "../src/lib/dogears";

const MIN = 60_000;
const ROOT = "C:\\atelier\\skein";

/** A tab, with only the fields a test cares about spelled out. */
function tab(path: string, touched: number, over: Partial<Dogear> = {}): Dogear {
  return { root: ROOT, path, line: null, raw: false, read: null, touched, ...over };
}

/* ── identity ─────────────────────────────────────────────────────────────── */

describe("what identifies a tab", () => {
  test("the root is part of it — the same path in two projects is two files", () => {
    const a = keyOf({ root: "C:\\a\\nova", path: "src/lib/theme.ts" });
    const b = keyOf({ root: "C:\\a\\skein", path: "src/lib/theme.ts" });
    expect(a).not.toBe(b);
  });

  test("the joiner cannot occur in a path, so two keys cannot collide", () => {
    /* The failure this guards is a joiner that is itself a path character:
       root `C:\a` + path `b\c` and root `C:\a\b` + path `c` are two files, and
       a backslash joiner makes them one key. */
    const a = keyOf({ root: "C:\\a", path: "b\\c" });
    const b = keyOf({ root: "C:\\a\\b", path: "c" });
    expect(a).not.toBe(b);
  });
});

/* ── the knobs ────────────────────────────────────────────────────────────── */

describe("the knobs", () => {
  test("zero is a real setting — it is the off switch", () => {
    expect(clampKeep(0)).toBe(0);
  });

  test("anything unreadable is the default and never zero", () => {
    /* A cleared field or a value from an older build must not silently switch
       the feature off. */
    for (const bad of ["", null, undefined, "nope", NaN, {}]) {
      expect(clampKeep(bad)).toBe(KEEP_DEFAULT);
      expect(clampFuse(bad)).toBe(FUSE_DEFAULT);
    }
  });

  test("both are clamped to their bounds", () => {
    expect(clampKeep(4000)).toBe(KEEP_MAX);
    expect(clampKeep(-3)).toBe(0);
    expect(clampFuse(0)).toBe(FUSE_MIN);
    expect(clampFuse(99999)).toBe(FUSE_MAX);
  });

  test("a fractional number is rounded rather than refused", () => {
    expect(clampKeep("5.4")).toBe(5);
    expect(clampFuse("2.6")).toBe(3);
  });
});

/* ── remembering ──────────────────────────────────────────────────────────── */

describe("opening a file fresh", () => {
  const mk = { root: ROOT, path: "src/lib/finder.svelte.ts", line: 412, raw: false };

  test("appends a tab", () => {
    const out = remember([], mk, 1000, 5);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(mk.path);
    expect(out[0].line).toBe(412);
    expect(out[0].touched).toBe(1000);
    expect(out[0].read).toBeNull();
  });

  test("keeps its place in the strip when it is already there", () => {
    /* Order is the order they were opened in and never recency — a strip whose
       pills rearranged themselves on use is a row of buttons never twice in the
       same place. */
    let t = [tab("a.ts", 1), tab("b.ts", 2), tab("c.ts", 3)];
    t = remember(t, { root: ROOT, path: "a.ts", line: null, raw: false }, 99, 5);
    expect(t.map((x) => x.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(t[0].touched).toBe(99);
  });

  test("forgets the reading, because a fresh open is not a resume", () => {
    /* You asked for line 900, so line 900 is where it opens — not wherever a
       scroll from an hour ago happens to be. */
    const held = [tab("a.ts", 1, { read: { scroll: 4200, sel: null } })];
    const out = remember(held, { root: ROOT, path: "a.ts", line: 900, raw: false }, 2, 5);
    expect(out[0].read).toBeNull();
    expect(out[0].line).toBe(900);
  });

  test("remembers nothing at all when the count is zero", () => {
    expect(remember([], mk, 1, 0)).toEqual([]);
  });
});

describe("coming back to one", () => {
  test("touch moves the recency without moving the tab or its reading", () => {
    const held = [
      tab("a.ts", 1, { read: { scroll: 900, sel: { from: 3, to: 9 } } }),
      tab("b.ts", 2),
    ];
    const out = touch(held, keyOf({ root: ROOT, path: "a.ts" }), 50);
    expect(out.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(out[0].touched).toBe(50);
    expect(out[0].read).toEqual({ scroll: 900, sel: { from: 3, to: 9 } });
  });

  test("touching something that is not there changes nothing, by identity", () => {
    const held = [tab("a.ts", 1)];
    expect(touch(held, "nope", 50)).toBe(held);
  });
});

describe("leaving a file", () => {
  test("mark writes the reading down", () => {
    const held = [tab("a.ts", 1)];
    const out = mark(held, keyOf({ root: ROOT, path: "a.ts" }), {
      scroll: 1234,
      sel: { from: 7, to: 40 },
    });
    expect(out[0].read).toEqual({ scroll: 1234, sel: { from: 7, to: 40 } });
  });

  test("switching between source and document throws the reading away", () => {
    /* The offsets describe a DOM that is about to stop existing, and a scroll
       into the middle of a rendering with half as many lines as the source is
       worse than opening at the top. */
    const held = [tab("a.md", 1, { read: { scroll: 800, sel: { from: 1, to: 2 } } })];
    const out = reread(held, keyOf({ root: ROOT, path: "a.md" }), true);
    expect(out[0].raw).toBe(true);
    expect(out[0].read).toBeNull();
  });

  test("drop is by identity when nothing matched", () => {
    const held = [tab("a.ts", 1)];
    expect(drop(held, "nope")).toBe(held);
    expect(drop(held, keyOf({ root: ROOT, path: "a.ts" }))).toEqual([]);
  });
});

/* ── the fuse ─────────────────────────────────────────────────────────────── */

describe("the fuse", () => {
  const five = [
    tab("a.ts", 10),
    tab("b.ts", 20),
    tab("c.ts", 30),
    tab("d.ts", 40),
    tab("e.ts", 50),
  ];

  test("the safe ones have no fuse at all", () => {
    const left = fuses(five, 5, 5, 1000);
    for (const t of five) expect(left.get(keyOf(t))).toBeNull();
  });

  test("past the count, the least recently touched is the one that burns", () => {
    const six = [...five, tab("f.ts", 60)];
    const left = fuses(six, 5, 5, 60);
    /* `a.ts` is the oldest, so it is the one out of the safe five. */
    expect(left.get(keyOf(six[0]))).not.toBeNull();
    for (const t of six.slice(1)) expect(left.get(keyOf(t))).toBeNull();
  });

  test("what is left counts down from the fuse", () => {
    const two = [tab("a.ts", 0), tab("b.ts", 100)];
    /* keep: 1, so `a.ts` is on the fuse from t=0. */
    expect(fuses(two, 1, 5, 0).get(keyOf(two[0]))).toBe(5 * MIN);
    expect(fuses(two, 1, 5, 2 * MIN).get(keyOf(two[0]))).toBe(3 * MIN);
    expect(fuses(two, 1, 5, 9 * MIN).get(keyOf(two[0]))).toBe(0);
  });

  test("a tie is broken by position, so a pill cannot flicker on and off", () => {
    /* Two tabs stamped in the same millisecond must not swap ranks between one
       tick and the next. */
    const tied = [tab("a.ts", 5), tab("b.ts", 5)];
    const first = fuses(tied, 1, 5, 5);
    const again = fuses(tied, 1, 5, 6);
    expect(first.get(keyOf(tied[0]))).toBeNull();
    expect(again.get(keyOf(tied[0]))).toBeNull();
    expect(first.get(keyOf(tied[1]))).not.toBeNull();
  });

  test("keep: 0 puts every tab on a fuse", () => {
    const left = fuses(five, 0, 5, 0);
    for (const t of five) expect(left.get(keyOf(t))).not.toBeNull();
  });
});

describe("reaping", () => {
  test("closes what has burned down and nothing else", () => {
    const two = [tab("old.ts", 0), tab("new.ts", 100)];
    const out = reap(two, 1, 5, 5 * MIN + 1);
    expect(out.map((t) => t.path)).toEqual(["new.ts"]);
  });

  test("a tick that changes nothing is not a write", () => {
    /* Called every second, so a fresh array each time would invalidate every
       `$derived` reading the strip for no reason. */
    const two = [tab("a.ts", 0), tab("b.ts", 100)];
    expect(reap(two, 5, 5, 1000)).toBe(two);
  });

  test("the last second is kept, so the pill and the hairline agree", () => {
    /* `> 0` here against `<= 0` in the drawing would disagree about the final
       second and the pill would vanish a beat before the hairline emptied. */
    const one = [tab("a.ts", 0)];
    expect(reap(one, 0, 5, 5 * MIN - 1)).toHaveLength(1);
    expect(reap(one, 0, 5, 5 * MIN)).toHaveLength(0);
  });

  test("coming back to a tab takes it off the fuse", () => {
    let t = [tab("a.ts", 0), tab("b.ts", 100)];
    /* keep: 1 — `a.ts` is on the fuse and four minutes in. */
    expect(fuses(t, 1, 5, 4 * MIN).get(keyOf(t[0]))).toBe(1 * MIN);
    t = touch(t, keyOf({ root: ROOT, path: "a.ts" }), 4 * MIN);
    /* Now it is the most recent, so it is safe — and `b.ts` has a full fuse
       rather than an already-part-burned one, since its own clock never moved
       but it has only just fallen out of the safe count. */
    expect(fuses(t, 1, 5, 4 * MIN).get(keyOf(t[0]))).toBeNull();
    expect(reap(t, 1, 5, 4 * MIN + 1)).toHaveLength(2);
  });
});

describe("how a fuse is drawn and said", () => {
  test("burn is one when fresh and zero when gone", () => {
    expect(burn(5 * MIN, 5)).toBe(1);
    expect(burn(0, 5)).toBe(0);
    expect(burn(2.5 * MIN, 5)).toBeCloseTo(0.5);
  });

  test("burn is clamped, so a stale reading cannot draw past the pill", () => {
    expect(burn(90 * MIN, 5)).toBe(1);
    expect(burn(-100, 5)).toBe(0);
  });

  test("the wording is the house wording for how long something has left", () => {
    expect(sayFuse(4 * MIN)).toContain("4m");
    expect(sayFuse(20_000)).toContain("under a minute");
  });
});

/* ── the label ────────────────────────────────────────────────────────────── */

describe("what a pill says", () => {
  test("one directory segment and the filename", () => {
    expect(tabLabel("src/lib/finder.svelte.ts")).toEqual({
      dir: "lib/",
      name: "finder.svelte.ts",
    });
  });

  test("a backslash path reads the same as a forward one", () => {
    expect(tabLabel("src-tauri\\src\\find.rs")).toEqual({
      dir: "src/",
      name: "find.rs",
    });
  });

  test("a file at the root of the project has no segment to show", () => {
    expect(tabLabel("CLAUDE.md")).toEqual({ dir: "", name: "CLAUDE.md" });
  });

  test("it tells apart the two files a bare name would not", () => {
    /* The whole reason there is a segment at all: `rules/finding.md` and
       `lib/finding.ts` are both "finding" and are not the same file. */
    expect(tabLabel(".claude/rules/finding.md").dir).toBe("rules/");
    expect(tabLabel("src/lib/finding.ts").dir).toBe("lib/");
  });
});

/* ── the selection, as offsets ────────────────────────────────────────────── */

describe("a position over a run of text nodes", () => {
  const lens = [4, 0, 6, 3];

  test("flatOf sums the nodes before it", () => {
    expect(flatOf(lens, 0, 2)).toBe(2);
    expect(flatOf(lens, 2, 1)).toBe(5);
    expect(flatOf(lens, 3, 3)).toBe(13);
  });

  test("locate is its inverse", () => {
    for (let i = 0; i < lens.length; i++) {
      for (let off = 0; off <= lens[i]; off++) {
        const flat = flatOf(lens, i, off);
        const back = locate(lens, flat);
        /* Not necessarily the same node — a boundary belongs to the end of the
           earlier one — but always the same *place*, which is what a Range is
           built from. */
        expect(flatOf(lens, back.i, back.off)).toBe(flat);
      }
    }
  });

  test("a boundary lands on the end of the earlier node", () => {
    /* Either choice describes the same Range; this one is the one that cannot
       run off the end of the list. */
    expect(locate([4, 6], 4)).toEqual({ i: 0, off: 4 });
  });

  test("an offset past the end lands on the last node's end, not past it", () => {
    expect(locate([4, 6], 999)).toEqual({ i: 1, off: 6 });
  });

  test("an empty run answers with the only position there is", () => {
    expect(locate([], 12)).toEqual({ i: 0, off: 0 });
    expect(flatOf([], 3, 4)).toBe(4);
  });

  test("a negative offset is the start rather than an exception", () => {
    /* Nothing should produce one, and a `setStart` that threw would lose the
       scroll along with the selection. */
    expect(locate([4], -9)).toEqual({ i: 0, off: 0 });
  });
});
