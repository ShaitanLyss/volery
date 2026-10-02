import { describe, expect, test } from "bun:test";

import {
  awayLine,
  flick,
  FLICK_MAX,
  hueAllowed,
  isPieceId,
  nextPiece,
  pieceSpec,
  PIECES,
  type Sample,
} from "../src/lib/away";

describe("the catalogue", () => {
  test("every piece says what your hands can do to it", () => {
    /* A piece nobody knows is interactive is a piece nobody touches, and the
       `about` line is the only place that is said. */
    for (const p of PIECES) {
      expect(p.about.length).toBeGreaterThan(10);
      expect(p.moods.length).toBeGreaterThan(0);
      expect(p.label).toBe(p.label.toLowerCase());
    }
  });

  test("every mood is covered", () => {
    const moods = new Set(PIECES.flatMap((p) => p.moods));
    /* Lyss asked for fun, cute, artistic and all of it. A catalogue missing one
       is a rotation that can never reach it. */
    expect(moods).toEqual(new Set(["fun", "cute", "artistic"]));
  });

  test("an unknown id degrades to a piece rather than to nothing", () => {
    expect(isPieceId("flock")).toBe(true);
    expect(isPieceId("sparkles")).toBe(false);
    expect(pieceSpec("sparkles" as never).id).toBe(PIECES[0].id);
  });
});

describe("rotation", () => {
  test("never lands on the piece already up", () => {
    for (const p of PIECES) {
      for (const roll of [0, 0.3, 0.5, 0.99]) {
        expect(nextPiece(p.id, roll)).not.toBe(p.id);
      }
    }
  });

  test("prefers a piece that is not more of the same", () => {
    /* `flock` is artistic+cute. `orbs` is the only purely fun one, so a roll at
       the bottom of the fresh set must not come back with another artistic
       piece when a different mood is available. */
    const after = new Set([0, 0.25, 0.5, 0.75, 0.99].map((r) => nextPiece("flock", r)));
    const flockMoods = pieceSpec("flock").moods;
    for (const id of after) {
      const m = pieceSpec(id).moods;
      expect(m.every((x) => flockMoods.includes(x))).toBe(false);
    }
  });

  test("a roll at either end stays in range", () => {
    expect(PIECES.some((p) => p.id === nextPiece("flock", 0))).toBe(true);
    expect(PIECES.some((p) => p.id === nextPiece("flock", 1))).toBe(true);
    expect(PIECES.some((p) => p.id === nextPiece(null, 1))).toBe(true);
  });
});

describe("colour", () => {
  test("hue only where the wall is covered", () => {
    /* The house rule is that colour means status. `toys.md` records the one
       standing exception and the two things that confine it, and the second is
       that the toy occludes the wall outright — so the reading that
       deliberately does not occlude it may not use hue. */
    expect(hueAllowed("takeover")).toBe(true);
    expect(hueAllowed("peek")).toBe(true);
    expect(hueAllowed("dimmed")).toBe(false);
  });
});

describe("a drag turned into a throw", () => {
  const line = (n: number, dx: number, dt: number): Sample[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * dx, y: 0, t: i * dt }));

  test("an empty or single-sample trail throws nothing", () => {
    expect(flick([])).toEqual({ vx: 0, vy: 0 });
    expect(flick([{ x: 5, y: 5, t: 10 }])).toEqual({ vx: 0, vy: 0 });
  });

  test("samples at one instant throw nothing rather than infinity", () => {
    /* The actual bug: one `Infinity` in a velocity is a thing that leaves the
       universe on a screen nobody is watching, so it is still gone in the
       morning. */
    const f = flick([
      { x: 0, y: 0, t: 7 },
      { x: 90, y: 40, t: 7 },
    ]);
    expect(f).toEqual({ vx: 0, vy: 0 });
  });

  test("speed is pixels per second", () => {
    /* 10px every 10ms is 1000px/s. */
    const f = flick(line(20, 10, 10));
    expect(f.vx).toBeCloseTo(1000, 0);
    expect(f.vy).toBe(0);
  });

  test("it measures the end of the gesture, not the whole of it", () => {
    /* Carrying something slowly and then snapping: the average of the two is
       the wall ignoring your wrist. */
    const slow: Sample[] = Array.from({ length: 30 }, (_, i) => ({
      x: i * 1,
      y: 0,
      t: i * 30,
    }));
    const snap: Sample[] = [
      { x: 30, y: 0, t: 900 },
      { x: 120, y: 0, t: 945 },
      { x: 220, y: 0, t: 990 },
    ];
    const f = flick([...slow, ...snap]);
    expect(f.vx).toBeGreaterThan(1500);
  });

  test("nothing leaves faster than the cap", () => {
    const f = flick([
      { x: 0, y: 0, t: 0 },
      { x: 4000, y: -4000, t: 90 },
    ]);
    expect(f.vx).toBe(FLICK_MAX);
    expect(f.vy).toBe(-FLICK_MAX);
  });
});

describe("what the corner says", () => {
  test("it leads with how long, always", () => {
    expect(awayLine("9 hours", 0, null).head).toBe("away · 9 hours");
  });

  test("a pile is the thing that would bring you back sooner", () => {
    expect(awayLine("9 hours", 1, null).under).toBe("1 question waiting");
    expect(awayLine("9 hours", 4, null).under).toBe("4 questions waiting");
  });

  test("what you said on the way out is kept beside it", () => {
    expect(awayLine("2 hours", 0, "back around nine").under).toBe("back around nine");
    expect(awayLine("2 hours", 3, "back around nine").under).toBe(
      "3 questions waiting · back around nine",
    );
  });

  test("with neither, it says nothing under — which reads as calm", () => {
    expect(awayLine("20 minutes", 0, null).under).toBe(null);
  });
});
