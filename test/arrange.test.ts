import { describe, expect, test } from "bun:test";
import {
  GLASS_SCALES,
  NO_ARRANGEMENT,
  ancestorFor,
  chromesFor,
  restChrome,
  ONE_LANDSCAPE,
  ONE_PORTRAIT,
  estimateFrame,
  fingerprint,
  frameOf,
  framePlan,
  glassScaleFor,
  glassScaleSaid,
  nearest,
  normalise,
  roomKey,
  screenOf,
  similarity,
  type Known,
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

/* Sink 398d2509, Lyss 2026-10-15: "it should be identical but scaled to match".
   A landscape screen of another size is the same room — and now the same glass,
   carried onto the new pane rather than clamped onto it. What is decided here
   is *whether* and *from what*; the arithmetic is `arrange.rs::travel`. */

/* The laptop at 150% — 1280×800 CSS — with a 48px taskbar, and the monitor
   beside it at 100%. */
const LAPTOP_150: Screen = { x: 0, y: 0, w: 1920, h: 1200, scale: 1.5, work: { w: 1920, h: 1128 } };
const MONITOR_100: Screen = { x: 1920, y: 0, w: 2560, h: 1440, scale: 1, work: { w: 2560, h: 1392 } };
/* What the window draws that the pane is not: the title bar and the dock. */
const CHROME = { w: 0, h: 106 };

describe("the pane a one-screen glass is a share of", () => {
  test("is the screen's work area less the window's own chrome, in CSS pixels", () => {
    expect(frameOf(LAPTOP_150, CHROME)).toEqual({ w: 1280, h: 646 });
    expect(frameOf(MONITOR_100, CHROME)).toEqual({ w: 2560, h: 1286 });
  });

  test("an older Tauri with no work area reads as the whole screen", () => {
    const bare: Screen = { x: 1920, y: 0, w: 2560, h: 1440, scale: 1 };
    expect(frameOf(bare, CHROME)).toEqual({ w: 2560, h: 1334 });
  });

  test("nothing sensible is no frame, never a reason to move anything", () => {
    expect(frameOf(undefined, CHROME)).toBeNull();
    expect(frameOf({ x: 0, y: 0, w: 100, h: 100, scale: 1 }, { w: 0, h: 500 })).toBeNull();
  });

  test("a room stored before frames is estimated off the screen it was last on", () => {
    const live = frameOf(MONITOR_100, CHROME)!;
    // On that very screen, exactly the live frame.
    expect(estimateFrame([MONITOR_100], MONITOR_100, live)).toEqual(live);
    // On the laptop, exactly the laptop's — the taskbar and the chrome are
    // taken to be what they are now, and here they are.
    expect(estimateFrame([LAPTOP_150], MONITOR_100, live)).toEqual({ w: 1280, h: 646 });
    // A spread room is not a share of one pane.
    expect(estimateFrame([LAPTOP_150, MONITOR_100], MONITOR_100, live)).toBeNull();
    expect(estimateFrame([], MONITOR_100, live)).toBeNull();
  });

  test("the same screen is its size and scale, not where it is or its taskbar", () => {
    const elsewhere = { ...LAPTOP_150, x: 4000, work: { w: 1920, h: 1200 } };
    expect(screenOf([elsewhere])).toBe(screenOf([LAPTOP_150]));
    expect(screenOf([MONITOR_100])).not.toBe(screenOf([LAPTOP_150]));
    expect(screenOf([{ ...LAPTOP_150, scale: 1.25 }])).not.toBe(screenOf([LAPTOP_150]));
    expect(screenOf([LAPTOP_150, MONITOR_100])).toBe(NO_ARRANGEMENT);
  });
});

describe("whether a room's glass is carried, and from what", () => {
  const LIVE_LAPTOP = frameOf(LAPTOP_150, CHROME)!;
  const LIVE_MONITOR = frameOf(MONITOR_100, CHROME)!;
  const NONE = { frame: null, fromFrame: null, cloneFrame: null };
  const room = (screens: Screen[], frame: { w: number; h: number } | null, key = ONE_LANDSCAPE): Known => ({
    key,
    screens,
    seenAt: 1,
    frame,
  });
  const plan = (key: string, screens: Screen[], live: { w: number; h: number } | null, known: Known[], ancestor: Known | null = null) =>
    framePlan({ key, spread: false, screens, live, known, ancestor });

  test("the laptop's room arriving on the monitor is carried from the laptop's pane", () => {
    const known = [room([LAPTOP_150], LIVE_LAPTOP)];
    expect(plan(ONE_LANDSCAPE, [MONITOR_100], LIVE_MONITOR, known)).toEqual({
      frame: LIVE_MONITOR,
      fromFrame: LIVE_LAPTOP,
      cloneFrame: null,
    });
  });

  test("back on the screen it was laid out on, nothing moves and the frame is kept", () => {
    /* Measured a little short today — a draft open in the dock — and that must
       not creep every spot each time the window comes back into focus. */
    const known = [room([LAPTOP_150], LIVE_LAPTOP)];
    const short = { ...LIVE_LAPTOP, h: LIVE_LAPTOP.h - 140 };
    expect(plan(ONE_LANDSCAPE, [LAPTOP_150], short, known)).toEqual(NONE);
  });

  test("her glass from before this change is carried from the screen it was saved on", () => {
    /* The migration: v53 adds the column and every room starts with no frame.
       Laid out on the laptop and first seen again on the monitor, it is
       estimated off the laptop and carried; first seen on the laptop, it is
       recorded as it stands and nothing moves. */
    const known = [room([LAPTOP_150], null)];
    expect(plan(ONE_LANDSCAPE, [MONITOR_100], LIVE_MONITOR, known)).toEqual({
      frame: LIVE_MONITOR,
      fromFrame: LIVE_LAPTOP,
      cloneFrame: null,
    });
    expect(plan(ONE_LANDSCAPE, [LAPTOP_150], LIVE_LAPTOP, known)).toEqual({
      frame: LIVE_LAPTOP,
      fromFrame: null,
      cloneFrame: null,
    });
  });

  test("the first flip to per-size copies the room you are in, and moves nothing", () => {
    const scaled = room([LAPTOP_150], LIVE_LAPTOP);
    const perSize = roomKey([LAPTOP_150], false, "per-size");
    // Measured short, and still: the copy is in the ancestor's frame already.
    expect(plan(perSize, [LAPTOP_150], { ...LIVE_LAPTOP, h: 600 }, [scaled], scaled)).toEqual({
      frame: LIVE_LAPTOP,
      fromFrame: null,
      cloneFrame: null,
    });
  });

  test("a per-size room first seen on the monitor is the nearest glass scaled to it", () => {
    const laptop = room([LAPTOP_150], LIVE_LAPTOP, roomKey([LAPTOP_150], false, "per-size"));
    const key = roomKey([MONITOR_100], false, "per-size");
    expect(plan(key, [MONITOR_100], LIVE_MONITOR, [laptop], laptop)).toEqual({
      frame: LIVE_MONITOR,
      fromFrame: null,
      cloneFrame: LIVE_LAPTOP,
    });
  });

  test("spread, or before the pane is measured, there is nothing to say", () => {
    const known = [room([LAPTOP_150], LIVE_LAPTOP)];
    const key = roomKey(INVERTED_L, true);
    expect(
      framePlan({ key, spread: true, screens: INVERTED_L, live: LIVE_MONITOR, known, ancestor: null }),
    ).toEqual(NONE);
    expect(plan(ONE_LANDSCAPE, [MONITOR_100], null, known)).toEqual(NONE);
  });

  test("a copy of a spread room is not reframed — it has no one pane", () => {
    const desk: Known = { key: fingerprint(INVERTED_L), screens: INVERTED_L, seenAt: 1, frame: null };
    expect(plan(ONE_LANDSCAPE, [MONITOR_100], LIVE_MONITOR, [desk], desk)).toEqual({
      frame: LIVE_MONITOR,
      fromFrame: null,
      cloneFrame: null,
    });
  });
});

describe("scaled or per size", () => {
  test("scaled is one room for every landscape screen; per size puts the size back", () => {
    expect(roomKey([LAPTOP_150], false, "scaled")).toBe(ONE_LANDSCAPE);
    expect(roomKey([MONITOR_100], false, "scaled")).toBe(ONE_LANDSCAPE);
    const a = roomKey([LAPTOP_150], false, "per-size");
    expect(a).toBe("one screen 1920x1200@1.50");
    expect(roomKey([MONITOR_100], false, "per-size")).not.toBe(a);
    // Same size at another scale is another room — the pane differs.
    expect(roomKey([{ ...LAPTOP_150, scale: 1.25 }], false, "per-size")).not.toBe(a);
    // Which screen, where, and how many still reach nothing.
    expect(roomKey([{ ...LAPTOP_150, x: 5000, y: 300 }], false, "per-size")).toBe(a);
  });

  test("per size never collides with a pre-orientation per-monitor key", () => {
    /* Those rows are this morning's glass; the first flip should copy the
       glass you have, not revive one from then under the same name. */
    expect(roomKey([LAPTOP_150], false, "per-size")).not.toBe(fingerprint([LAPTOP_150]));
  });

  test("the choice does not reach a spread desk, which is a shape either way", () => {
    expect(roomKey(INVERTED_L, true, "per-size")).toBe(roomKey(INVERTED_L, true, "scaled"));
  });

  test("anything but per-size is scaled, so a machine never asked gets the default", () => {
    expect(glassScaleFor("per-size")).toBe("per-size");
    expect(glassScaleFor("scaled")).toBe("scaled");
    expect(glassScaleFor(null)).toBe("scaled");
    expect(glassScaleFor("PER-SIZE")).toBe("scaled");
    expect(glassScaleFor(undefined)).toBe("scaled");
  });

  test("the rows and the chord say what each does, in the house's lowercase", () => {
    expect(GLASS_SCALES.map((g) => g.id)).toEqual(["scaled", "per-size"]);
    for (const g of GLASS_SCALES) expect(g.label).toBe(g.label.toLowerCase());
    expect(glassScaleSaid("scaled")).not.toBe(glassScaleSaid("per-size"));
  });
});

describe("the chrome at rest", () => {
  /* Red-team, 2026-10-15: the chrome was read live, so a question open in the
     dock at the moment the screen changed was baked into the frame the whole
     glass was carried onto — 300px short, for good. */
  test("is the least seen at a mooring, and never more than now", () => {
    let seen = {};
    let r = restChrome(seen, "bottom", 133);
    expect(r.chrome).toBe(133);
    seen = r.seen;
    // A question opens in the dock: the reading grows, the rest does not.
    r = restChrome(seen, "bottom", 433);
    expect(r.chrome).toBe(133);
    expect(r.seen).toBe(seen);
    // A smaller reading is a truer one.
    r = restChrome(seen, "bottom", 120);
    expect(r.chrome).toBe(120);
    expect(r.seen).toEqual({ bottom: 120 });
  });

  test("a floating dock is its own mooring, so it cannot drag a moored one down", () => {
    const { seen } = restChrome({ bottom: 133 }, "float", 47);
    expect(restChrome(seen, "bottom", 400).chrome).toBe(133);
    expect(restChrome(seen, "float", 400).chrome).toBe(47);
  });

  test("a reading that is not one leaves the memory alone", () => {
    /* A pane caught mid-way out of being spread covers the whole window: no
       chrome at all, which a window with a title bar never has. */
    const seen = { bottom: 133 };
    expect(restChrome(seen, "bottom", 0)).toEqual({ chrome: 133, seen });
    expect(restChrome(seen, "bottom", Number.NaN)).toEqual({ chrome: 133, seen });
    expect(restChrome({}, "top", -5)).toEqual({ chrome: null, seen: {} });
  });

  test("what is kept is read back safely", () => {
    expect(chromesFor(JSON.stringify({ bottom: 133, float: 47 }))).toEqual({ bottom: 133, float: 47 });
    expect(chromesFor("{not json")).toEqual({});
    expect(chromesFor(null)).toEqual({});
    expect(chromesFor(JSON.stringify([1, 2]))).toEqual({});
    expect(chromesFor(JSON.stringify({ bottom: "133", top: -1, float: null }))).toEqual({});
  });
});

describe("what a room seen for the first time is copied from", () => {
  const SCALED: Known = { key: ONE_LANDSCAPE, screens: [LAPTOP_150], seenAt: 5, frame: { w: 1280, h: 646 } };
  /* The pre-orientation per-monitor row for the external: this morning's glass. */
  const LEGACY: Known = { key: fingerprint([MONITOR_100]), screens: [MONITOR_100], seenAt: 1, frame: null };
  const PER_SIZE_LAPTOP: Known = {
    key: roomKey([LAPTOP_150], false, "per-size"),
    screens: [LAPTOP_150],
    seenAt: 6,
    frame: { w: 1280, h: 646 },
  };
  const known = [SCALED, LEGACY, PER_SIZE_LAPTOP];

  test("per size on a screen never seen per size starts from the glass you have", () => {
    /* Red-team: `nearest` picks the legacy row (it is this very screen), and
       things taken off the glass since this morning come back. */
    const key = roomKey([MONITOR_100], false, "per-size");
    expect(nearest([MONITOR_100], known, key)?.key).toBe(LEGACY.key);
    expect(ancestorFor({ key, screens: [MONITOR_100], spread: false, scale: "per-size", known })?.key).toBe(
      ONE_LANDSCAPE,
    );
    // And it is carried, since the scaled room was last on the laptop.
    const live = frameOf(MONITOR_100, CHROME);
    const ancestor = ancestorFor({ key, screens: [MONITOR_100], spread: false, scale: "per-size", known });
    expect(framePlan({ key, spread: false, screens: [MONITOR_100], live, known, ancestor }).cloneFrame).toEqual({
      w: 1280,
      h: 646,
    });
  });

  test("a portrait screen per size starts from the portrait room, not the landscape one", () => {
    const portrait: Screen = { x: 0, y: 0, w: 1080, h: 1920, scale: 1 };
    const tall: Known = { key: ONE_PORTRAIT, screens: [portrait], seenAt: 2, frame: null };
    const key = roomKey([portrait], false, "per-size");
    expect(ancestorFor({ key, screens: [portrait], spread: false, scale: "per-size", known: [...known, tall] })?.key).toBe(
      ONE_PORTRAIT,
    );
  });

  test("the scaled room's own first sighting still finds this panel's old row", () => {
    /* de1a479's path, unchanged: on a wall updating straight past
       orientation-only rooms, that row *is* its glass. */
    const fresh = [LEGACY, { key: fingerprint([LAPTOP_150]), screens: [LAPTOP_150], seenAt: 1 }];
    expect(
      ancestorFor({ key: ONE_LANDSCAPE, screens: [LAPTOP_150], spread: false, scale: "scaled", known: fresh })?.key,
    ).toBe(fingerprint([LAPTOP_150]));
  });

  test("with no scaled room yet, per size falls back to the nearest", () => {
    const key = roomKey([MONITOR_100], false, "per-size");
    expect(ancestorFor({ key, screens: [MONITOR_100], spread: false, scale: "per-size", known: [LEGACY] })?.key).toBe(
      LEGACY.key,
    );
  });

  test("spread, the choice changes nothing about the ancestor", () => {
    const key = roomKey(INVERTED_L, true);
    expect(ancestorFor({ key, screens: INVERTED_L, spread: true, scale: "per-size", known })?.key).toBe(
      nearest(INVERTED_L, known, key)?.key,
    );
  });
});
