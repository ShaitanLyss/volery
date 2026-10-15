import { describe, expect, test } from "bun:test";
import {
  NO_ARRANGEMENT,
  ONE_LANDSCAPE,
  ONE_PORTRAIT,
  fingerprint,
  nearest,
  normalise,
  roomKey,
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

/* Lyss's two reports (2026-10-15), each one invariant. Both are about the key
   depending on something the rule says it may not: which monitor, how many,
   which is primary, which one is home. */

/* Her laptop panel, as this machine reports it. */
const PANEL: Screen = { x: 0, y: 0, w: 2560, h: 1440, scale: 1.5 };

/* An inverted L: two monitors along the top at 100%, the laptop under the left
   one at 150% — mixed scale, which is what made the home screen matter. Written
   with the left monitor as the Windows primary, at the desktop's origin. */
const INVERTED_L: Screen[] = [
  { x: 0, y: 0, w: 2560, h: 1440, scale: 1 },
  { x: 2560, y: 0, w: 2560, h: 1440, scale: 1 },
  { x: 0, y: 1440, w: 2560, h: 1440, scale: 1.5 },
];

/** The same physical desk with screen `i` made the Windows primary: Windows
 *  puts the primary at (0, 0) and moves every other screen with it. */
function primary(screens: Screen[], i: number): Screen[] {
  const p = screens[i];
  return screens.map((s) => ({ ...s, x: s.x - p.x, y: s.y - p.y }));
}

describe("unspread, the room is one screen's worth of window, whichever screen", () => {
  test("the laptop alone and the laptop among three are the same room", () => {
    // Unspread, `look` hands over the window's own screen and nothing else;
    // with three attached the panel just sits somewhere else on the desktop.
    const amongThree = { ...PANEL, x: 0, y: 1440 };
    expect(roomKey([amongThree], false)).toBe(roomKey([PANEL], false));
  });

  test("which landscape screen the window is on does not matter", () => {
    /* Her words: "the number of connected screens or which screen shouldn't
       matter". The monitor beside the panel is another size and another
       scale, and it is still one landscape screen's worth of window. */
    const external: Screen = { x: 2560, y: 0, w: 1920, h: 1080, scale: 1 };
    expect(roomKey([external], false)).toBe(roomKey([PANEL], false));
    expect(roomKey([PANEL], false)).toBe(ONE_LANDSCAPE);
  });

  test("a portrait screen is a different room", () => {
    const portrait: Screen = { x: -1080, y: 0, w: 1080, h: 1920, scale: 1 };
    expect(roomKey([portrait], false)).toBe(ONE_PORTRAIT);
    expect(roomKey([portrait], false)).not.toBe(roomKey([PANEL], false));
  });

  test("one screen unspread is not the desk spread", () => {
    expect(roomKey([PANEL], false)).not.toBe(roomKey(INVERTED_L, true));
  });

  test("a screen that has not answered yet is not a room", () => {
    expect(roomKey([], false)).toBe(NO_ARRANGEMENT);
    expect(roomKey([{ x: 0, y: 0, w: 0, h: 0 }], false)).toBe(NO_ARRANGEMENT);
  });

  test("the glass a wall stored under the old per-monitor key is what the new key starts from", () => {
    /* The fix changes the key every unspread room is stored under, so without
       this it would be the fix that lost her glass. A first sighting of
       ONE_LANDSCAPE is copied from the nearest known room — and the old key
       for this very panel scores 1, so it wins over the desk. */
    const known = [
      { key: fingerprint([PANEL]), screens: [PANEL], seenAt: 10 },
      { key: fingerprint(INVERTED_L), screens: INVERTED_L, seenAt: 20 },
    ];
    const key = roomKey([PANEL], false);
    expect(nearest([PANEL], known, key)?.key).toBe(fingerprint([PANEL]));
  });
});

describe("spread, which screen is primary or home changes nothing on the glass", () => {
  test("making any screen of the inverted L the primary is the same arrangement", () => {
    const keys = INVERTED_L.map((_, i) => roomKey(primary(INVERTED_L, i), true));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).not.toBe(NO_ARRANGEMENT);
  });

  test("and the same for the mirrored desk with its portrait screen", () => {
    const keys = DESK.map((_, i) => roomKey(primary(DESK, i), true));
    expect(new Set(keys).size).toBe(1);
  });

  test("whatever order the monitors come back in after the primary moved", () => {
    const moved = primary(INVERTED_L, 2);
    expect(roomKey([moved[2], moved[0], moved[1]], true)).toBe(roomKey(INVERTED_L, true));
  });

  test("two screens on one rect differing only in scale have one order", () => {
    /* A duplicated display. The sort used to stop at the rect, so the
       fingerprint followed whichever the system listed first. */
    const a: Screen = { x: 0, y: 0, w: 1920, h: 1080, scale: 1 };
    const b: Screen = { ...a, scale: 1.5 };
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
  });
});
