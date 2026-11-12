/* The action scoreboard's fold: what a switch is, what a stay is, and the
 * difference between a reading and a zero.
 *
 * The numbers here are the whole feature. A switch count that folds a Tab-and-
 * back as two switches punishes the gesture that finds things; a median stay
 * drawn from the mean of one card left open all night is a number nobody can
 * use; and a rate that quietly counts navigation says you were busier the day
 * you tidied the wall. None of those throws.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTION_KINDS,
  GESTURE_KINDS,
  MARK_KINDS,
  SWITCH_FLOOR_MS,
  asActionWindow,
  forgetAfter,
  noteIn,
  cardRows,
  duration,
  fragmentation,
  gestureRate,
  gestureSeries,
  interruptRate,
  medianDwellMs,
  perHour,
  switchesPerHour,
  visits,
  type ActionBucket,
  type ActionMark,
  type ActionWindow,
} from "../src/lib/acts";

const T0 = 1_764_000_000_000; // a minute boundary, fixed so nothing depends on today
const MIN = 60_000;
const HOUR = 60 * MIN;

const focus = (at: number, card: string): ActionMark => ({ at, host: "w", kind: "focus", target: card });
const mark = (at: number, kind: string, target = ""): ActionMark => ({ at, host: "w", kind, target });

const window_ = (over: Partial<ActionWindow> = {}): ActionWindow => ({
  from: T0,
  to: T0 + HOUR,
  bucket: MIN,
  coarse: false,
  marksCapped: false,
  series: [],
  marks: [],
  cards: [],
  hosts: [],
  ...over,
});

describe("a visit", () => {
  test("a Tab-and-back inside the floor is one visit", () => {
    /* On a, glance at b for eight seconds, back to a. Nobody changed context
       twice; the glance is the thing the floor exists for. The marks carry the
       instant rather than the minute (that is what `action_mark` is for), so
       an eight-second glance is a sequence the store can actually hold. */
    const got = visits([focus(T0, "a"), focus(T0 + MIN, "b"), focus(T0 + MIN + 8_000, "a")], T0 + HOUR);
    expect(got.map((v) => v.card)).toEqual(["a"]);
    expect(got[0]!.until).toBe(T0 + HOUR);
  });

  test("coming back after the floor is a switch, and so is the glance", () => {
    const got = visits(
      [focus(T0, "a"), focus(T0 + MIN, "b"), focus(T0 + MIN + SWITCH_FLOOR_MS, "a")],
      T0 + HOUR,
    );
    expect(got.map((v) => v.card)).toEqual(["a", "b", "a"]);
    expect(got[1]!.until - got[1]!.at).toBe(SWITCH_FLOOR_MS);
  });

  test("a repeat focus on the card in hand is not a mark", () => {
    const got = visits([focus(T0, "a"), focus(T0 + MIN, "a")], T0 + HOUR);
    expect(got).toHaveLength(1);
  });

  test("the last stay runs to the end of the window", () => {
    const got = visits([focus(T0 + 10 * MIN, "a")], T0 + HOUR);
    expect(got[0]!.until).toBe(T0 + HOUR);
  });

  test("a window ending before the last focus still has a non-negative stay", () => {
    const got = visits([focus(T0 + 2 * HOUR, "a")], T0 + HOUR);
    expect(got[0]!.until - got[0]!.at).toBe(0);
  });

  test("only focus is a visit", () => {
    const got = visits([focus(T0, "a"), mark(T0 + MIN, "click"), focus(T0 + 2 * MIN, "b")], T0 + HOUR);
    expect(got.map((v) => v.card)).toEqual(["a", "b"]);
  });
});

describe("switches an hour", () => {
  test("four stays in an hour is three switches", () => {
    const marks = [focus(T0, "a"), focus(T0 + 10 * MIN, "b"), focus(T0 + 20 * MIN, "c"), focus(T0 + 30 * MIN, "d")];
    expect(switchesPerHour(marks, T0, T0 + HOUR)).toBe(3);
  });

  test("one card all hour is no switches, not no reading", () => {
    expect(switchesPerHour([focus(T0, "a")], T0, T0 + HOUR)).toBe(0);
  });

  test("a window with no focus at all is no reading", () => {
    expect(switchesPerHour([], T0, T0 + HOUR)).toBeNull();
  });

  test("a bad span is no reading rather than a division", () => {
    expect(switchesPerHour([focus(T0, "a")], T0, T0)).toBeNull();
  });
});

describe("the median stay", () => {
  test("is the middle stay, not the mean", () => {
    /* 1m, 1m, and eight hours. A mean would read 2.7h; nothing that happened
       looked like that. */
    const marks = [focus(T0, "a"), focus(T0 + MIN, "b"), focus(T0 + 2 * MIN, "c")];
    expect(medianDwellMs(marks, T0 + 2 * MIN + 8 * HOUR)).toBe(MIN);
  });

  test("an even count is the midpoint of the two middle ones", () => {
    const marks = [focus(T0, "a"), focus(T0 + MIN, "b"), focus(T0 + 3 * MIN, "c")];
    /* Stays: 1m, 2m, and nothing after c — so the window ends there. */
    expect(medianDwellMs(marks, T0 + 3 * MIN)).toBe(2 * MIN);
  });

  test("no visits is no reading", () => {
    expect(medianDwellMs([], T0, T0 + HOUR)).toBeNull();
  });
});

describe("gestures a minute", () => {
  const series = [
    { at: T0, kind: "click", count: 6 },
    { at: T0, kind: "send", count: 1 },
    { at: T0, kind: "view", count: 40 },
  ];

  test("counts the deliberate kinds and no navigation", () => {
    expect(gestureRate(series, T0, T0 + MIN)).toBe(7);
  });

  test("the vocabulary of what counts is the one the doc names", () => {
    expect([...GESTURE_KINDS]).toEqual(["click", "send", "interrupt", "command"]);
    for (const kind of GESTURE_KINDS) expect([...ACTION_KINDS]).toContain(kind);
  });

  test("a window with only navigation is no reading, not zero", () => {
    expect(gestureRate([{ at: T0, kind: "view", count: 9 }], T0, T0 + MIN)).toBeNull();
  });
});

describe("the interrupt rate", () => {
  test("is interrupts over sends, summed from the counts", () => {
    /* The counts, not the marks: a row's `count` is how many happened in the
       bucket, and three sends in one minute are three sends. */
    const got = interruptRate([
      { at: T0, kind: "send", count: 2 },
      { at: T0, kind: "interrupt", count: 1 },
    ]);
    expect(got).toEqual({ sends: 2, interrupts: 1, share: 0.5 });
  });

  test("no sends is no reading, however many interrupts there are", () => {
    expect(interruptRate([{ at: T0, kind: "interrupt", count: 4 }])).toBeNull();
  });
});

describe("a card's own row", () => {
  test("folds the slice and the visits, busiest first", () => {
    const w = window_({
      marks: [focus(T0, "a"), focus(T0 + 10 * MIN, "b"), mark(T0 + 11 * MIN, "send", "b")],
      cards: [
        { key: "a", kind: "focus", count: 1, first: T0, last: T0 },
        { key: "b", kind: "focus", count: 1, first: T0 + 10 * MIN, last: T0 + 10 * MIN },
        { key: "b", kind: "send", count: 1, first: T0 + 11 * MIN, last: T0 + 11 * MIN },
      ],
    });
    const rows = cardRows(w);
    expect(rows[0]!.card).toBe("b");
    expect(rows[0]!.sends).toBe(1);
    expect(rows.find((r) => r.card === "a")!.dwellMs).toBe(10 * MIN);
    /* b's stay runs to the window's end: 50 minutes. */
    expect(rows[0]!.dwellMs).toBe(50 * MIN);
  });

  test("an empty target is the wall, not a card", () => {
    const rows = cardRows(window_({ cards: [{ key: "", kind: "click", count: 4, first: T0, last: T0 }] }));
    expect(rows).toEqual([]);
  });
});

describe("the sparkline", () => {
  test("fills a quiet bucket with a zero rather than skipping it", () => {
    const w = window_({
      bucket: MIN,
      from: T0,
      to: T0 + 3 * MIN,
      series: [
        { at: T0, kind: "click", count: 2 },
        { at: T0 + 2 * MIN, kind: "send", count: 1 },
      ],
    });
    expect(gestureSeries(w)).toEqual([2, 0, 1]);
  });
});

describe("fragmentation", () => {
  test("two cards an hour in a half-busy window", () => {
    const w = window_({
      bucket: MIN,
      from: T0,
      to: T0 + 2 * MIN,
      marks: [focus(T0, "a"), focus(T0 + MIN, "b")],
      series: [{ at: T0, kind: "click", count: 1 }],
    });
    const got = fragmentation(w)!;
    /* Two cards inside two minutes is sixty an hour, which is the arithmetic
       the reading is asking for and not a number anybody should see. */
    expect(got.cardsPerHour).toBe(60);
    expect(got.busyShare).toBe(0.5);
  });

  test("a coarse window has no order to fold, so it says so", () => {
    expect(fragmentation(window_({ coarse: true }))).toBeNull();
  });
});

describe("normalising a read", () => {
  test("drops a row that will not parse rather than drawing it as zero", () => {
    const got = asActionWindow(
      {
        from: T0,
        to: T0 + HOUR,
        bucket: MIN,
        coarse: false,
        series: [
          { at: T0, kind: "click", count: 3 },
          { at: null, kind: "click", count: 1 },
          { at: T0, kind: "click", count: "many" },
        ],
        marks: [{ at: T0, host: "w", kind: "focus", target: "a" }, { host: "w" }],
        cards: [{ key: "a", kind: "focus", count: 1, first: T0, last: T0 }, { key: "b" }],
        hosts: [],
      },
      { from: 0, to: 0, bucket: MIN },
    );
    expect(got.series).toHaveLength(1);
    expect(got.marks).toHaveLength(1);
    expect(got.cards).toHaveLength(1);
  });

  test("an unreadable answer falls back to the window that was asked for", () => {
    const got = asActionWindow(null, { from: 1, to: 2, bucket: MIN });
    expect([got.from, got.to]).toEqual([1, 2]);
    expect(got.series).toEqual([]);
  });
});

describe("saying a number", () => {
  test("a rate keeps a decimal only where it is small enough to want one", () => {
    expect(perHour(null)).toBe("no reading");
    expect(perHour(3.456)).toBe("3.5/h");
    expect(perHour(31.2)).toBe("31/h");
  });

  test("a stay says seconds, minutes, then hours", () => {
    expect(duration(null)).toBe("no reading");
    expect(duration(8_000)).toBe("8s");
    expect(duration(90 * MIN)).toBe("1.5h");
    expect(duration(3 * HOUR)).toBe("3.0h");
    expect(duration(13 * HOUR)).toBe("13h");
  });
});

describe("the collector's protocol", () => {
  /* The bug this test exists for shipped in the first cut: a bucket was
     forgotten as soon as it had been sent, so the click after the flush began
     a fresh count at one and the store, holding three, refused it. A minute of
     steady work then read as the largest five-second window in it. Nothing
     errored; the number was simply too low, for ever, and no test could see it
     because the fold was right and the store was right. */
  test("a bucket that grew after a flush is sent again as its total", () => {
    const buckets = new Map<string, ActionBucket>();
    noteIn(buckets, "click", "", "", T0 + 1_000);
    noteIn(buckets, "click", "", "", T0 + 2_000);
    noteIn(buckets, "click", "", "", T0 + 3_000);
    const first = [...buckets.values()].map((b) => ({ ...b }));
    expect(first).toHaveLength(1);
    expect(first[0]!.count).toBe(3);
    /* Nothing may be forgotten: the minute is still open. */
    forgetAfter(buckets, first, T0 + 5_000);
    expect(buckets.size).toBe(1);
    noteIn(buckets, "click", "", "", T0 + 6_000);
    noteIn(buckets, "click", "", "", T0 + 7_000);
    const second = [...buckets.values()].map((b) => ({ ...b }));
    expect(second[0]!.count).toBe(5);
    expect(second[0]!.key).toBe(first[0]!.key);
  });

  test("the minute after is a bucket of its own, and the last one is forgotten", () => {
    const buckets = new Map<string, ActionBucket>();
    noteIn(buckets, "click", "", "", T0 + 59_000);
    const first = [...buckets.values()].map((b) => ({ ...b }));
    forgetAfter(buckets, first, T0 + MIN); // the minute has turned over
    expect(buckets.size).toBe(0);
    noteIn(buckets, "click", "", "", T0 + MIN + 1_000);
    expect([...buckets.values()][0]!.at).toBe(T0 + MIN);
  });

  test("a bucket that grew during the write is not forgotten", () => {
    const buckets = new Map<string, ActionBucket>();
    noteIn(buckets, "click", "", "", T0 + 59_000);
    const sent = [...buckets.values()].map((b) => ({ ...b }));
    /* The last click of the minute lands while the write is in the air. */
    noteIn(buckets, "click", "", "", T0 + 59_900);
    forgetAfter(buckets, sent, T0 + MIN + 500);
    expect(buckets.size).toBe(1);
    expect([...buckets.values()][0]!.count).toBe(2);
  });

  test("a burst is one bucket, and a different target is another", () => {
    const buckets = new Map<string, ActionBucket>();
    noteIn(buckets, "send", "a", "", T0);
    noteIn(buckets, "send", "a", "", T0);
    noteIn(buckets, "send", "b", "", T0);
    expect(buckets.size).toBe(2);
    expect([...buckets.values()].map((b) => b.count).sort()).toEqual([1, 2]);
  });
});

describe("the vocabulary", () => {
  test("has no key, on purpose", () => {
    expect([...ACTION_KINDS]).not.toContain("key");
    expect(ACTION_KINDS).toHaveLength(15);
  });

  test("the marks are a subset of the kinds", () => {
    for (const kind of MARK_KINDS) expect([...ACTION_KINDS]).toContain(kind);
  });
});
