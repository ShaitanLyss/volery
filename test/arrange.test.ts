import { describe, expect, test } from "bun:test";
import {
  NO_ARRANGEMENT,
  fingerprint,
  nearest,
  normalise,
  similarity,
  type Screen,
} from "../src/lib/arrange";

const LAPTOP: Screen[] = [{ x: 0, y: 0, w: 2560, h: 1600, scale: 2 }];

/* The desk as described: an upside-down mirrored L, the portrait screen on the
   left. The left monitor's top is above the others, so the union's origin is
   not any one screen's own. */
const DESK: Screen[] = [
  { x: -1080, y: -200, w: 1080, h: 1920, scale: 1 },
  { x: 0, y: 0, w: 2560, h: 1440, scale: 1 },
  { x: 2560, y: 0, w: 2560, h: 1440, scale: 1 },
];

describe("an arrangement is a shape, not a set of monitors", () => {
  test("the same shape somewhere else on the desktop is the same arrangement", () => {
    const moved = DESK.map((s) => ({ ...s, x: s.x + 4000, y: s.y + 777 }));
    expect(fingerprint(moved)).toBe(fingerprint(DESK));
  });

  test("the order the monitors were enumerated in does not matter", () => {
    const shuffled = [DESK[2], DESK[0], DESK[1]];
    expect(fingerprint(shuffled)).toBe(fingerprint(DESK));
  });

  test("turning one screen portrait is a different arrangement", () => {
    const flat = DESK.map((s, i) => (i === 0 ? { ...s, w: s.h, h: s.w } : s));
    expect(fingerprint(flat)).not.toBe(fingerprint(DESK));
  });

  test("putting the portrait screen on the other side is a different arrangement", () => {
    const mirrored: Screen[] = [
      { x: 0, y: 0, w: 2560, h: 1440, scale: 1 },
      { x: 2560, y: 0, w: 2560, h: 1440, scale: 1 },
      { x: 5120, y: -200, w: 1080, h: 1920, scale: 1 },
    ];
    expect(fingerprint(mirrored)).not.toBe(fingerprint(DESK));
  });

  test("one screen and the whole desk are different arrangements", () => {
    // The whole point: unspread is one room and spread is another.
    expect(fingerprint([DESK[1]])).not.toBe(fingerprint(DESK));
  });

  test("the same shape at another scale is its own arrangement", () => {
    // Every glass spot is in CSS pixels, and those two rooms are different
    // sizes — but they are the same shape, so one seeds the other below.
    const dpi = DESK.map((s) => ({ ...s, scale: 1.5 }));
    expect(fingerprint(dpi)).not.toBe(fingerprint(DESK));
  });

  test("a monitor reporting nothing yet does not get an arrangement of its own", () => {
    /* Mid-handshake a monitor can answer 0×0. Letting one in would give a
       transient state its own copy of the whole glass, left behind for ever
       once the real answer arrived. */
    expect(fingerprint([...DESK, { x: 9000, y: 0, w: 0, h: 0 }])).toBe(fingerprint(DESK));
    expect(fingerprint([])).toBe(NO_ARRANGEMENT);
    expect(fingerprint([{ x: 0, y: 0, w: 0, h: 0 }])).toBe(NO_ARRANGEMENT);
  });

  test("a real arrangement never collides with the empty one", () => {
    expect(fingerprint(LAPTOP)).not.toBe(NO_ARRANGEMENT);
    expect(fingerprint(DESK)).not.toBe(NO_ARRANGEMENT);
  });

  test("normalising puts the set at its own origin", () => {
    const ns = normalise(DESK);
    expect(Math.min(...ns.map((s) => s.x))).toBe(0);
    expect(Math.min(...ns.map((s) => s.y))).toBe(0);
    expect(ns.length).toBe(3);
  });
});

describe("how alike two arrangements are", () => {
  test("an arrangement is identical to itself", () => {
    expect(similarity(DESK, DESK)).toBeCloseTo(1, 10);
    expect(similarity(LAPTOP, LAPTOP)).toBeCloseTo(1, 10);
  });

  test("a set that merely contains another is not the same room", () => {
    /* Otherwise one screen of the desk would score a perfect match for the
       whole desk, and spreading would silently reuse the unspread spots. */
    expect(similarity(DESK, [DESK[1]])).toBeLessThan(1);
  });

  test("losing one screen off three scores better than keeping one of three", () => {
    const two = [DESK[1], DESK[2]];
    expect(similarity(DESK, two)).toBeGreaterThan(similarity(DESK, [DESK[1]]));
  });

  test("a shape is matched by alignment, not by where normalising left it", () => {
    /* The bug: both sides are normalised to their own top-left, so dropping a
       screen from the desk slides the other two to a new origin and nothing
       lines up with where it was. Two of the desk's screens then scored better
       against a single laptop panel than against the desk they are part of. */
    const two = [DESK[1], DESK[2]];
    expect(similarity(two, DESK)).toBeGreaterThan(similarity(two, LAPTOP));
  });

  test("nothing in common scores nothing", () => {
    expect(similarity(DESK, [])).toBe(0);
    expect(similarity([], [])).toBe(0);
  });

  test("it does not matter which way round it is asked", () => {
    const two = [DESK[0], DESK[1]];
    expect(similarity(DESK, two)).toBeCloseTo(similarity(two, DESK), 10);
  });

  test("the same shape at another scale is still the same shape", () => {
    // Scale rides in the fingerprint and takes no part here, so the 150% desk
    // is seeded from the 100% one rather than from the laptop.
    const dpi = DESK.map((s) => ({ ...s, scale: 1.5 }));
    expect(similarity(DESK, dpi)).toBeCloseTo(1, 10);
  });
});

describe("which known arrangement a new one is copied from", () => {
  const known = [
    { key: fingerprint(LAPTOP), screens: LAPTOP, seenAt: 10 },
    { key: fingerprint(DESK), screens: DESK, seenAt: 20 },
  ];

  test("the first run has nothing to copy from", () => {
    expect(nearest(DESK, [])).toBeNull();
  });

  test("a new arrangement takes the one it is most like", () => {
    /* Spreading over two of the desk's three screens for the first time: the
       desk is the obvious ancestor, not the laptop. */
    const two = [DESK[1], DESK[2]];
    expect(nearest(two, known)?.key).toBe(fingerprint(DESK));
  });

  test("it never names the arrangement being asked about", () => {
    // Otherwise adopting one that already exists would copy it onto itself.
    expect(nearest(DESK, known)?.key).toBe(fingerprint(LAPTOP));
  });

  test("a shape nothing resembles still gets an ancestor", () => {
    /* A blank pane is worse than a starting point, and every spot is clamped
       onto whatever pane it lands on anyway. */
    const alien: Screen[] = [{ x: 0, y: 0, w: 640, h: 480, scale: 1 }];
    expect(nearest(alien, known)).not.toBeNull();
  });

  test("a tie goes to whichever was in front of you most recently", () => {
    const a = [{ x: 0, y: 0, w: 1000, h: 1000, scale: 1 }];
    const b = [{ x: 0, y: 0, w: 1000, h: 1000, scale: 2 }];
    const pick = nearest([{ x: 0, y: 0, w: 1000, h: 1000, scale: 3 }], [
      { key: "a", screens: a, seenAt: 1 },
      { key: "b", screens: b, seenAt: 99 },
    ]);
    expect(pick?.key).toBe("b");
  });

  test("the answer does not depend on the order the rows came back in", () => {
    const rows = [
      { key: fingerprint(LAPTOP), screens: LAPTOP, seenAt: 10 },
      { key: fingerprint(DESK), screens: DESK, seenAt: 20 },
    ];
    const two = [DESK[1], DESK[2]];
    expect(nearest(two, rows)?.key).toBe(nearest(two, [...rows].reverse())?.key);
  });
});
