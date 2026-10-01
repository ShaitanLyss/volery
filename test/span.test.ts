import { describe, expect, test } from "bun:test";
import { homeInsets, spreadPan, type SpanView } from "../src/lib/span";

/* Lyss's desk as `span_screens` would describe it: a portrait screen left of
   the primary, a laptop under the primary, union 3120×2416. */
const desk: SpanView = {
  home: { x: 1200, y: 16, w: 1920, h: 1200 },
  screens: [
    { x: 0, y: 0, w: 1200, h: 1920 },
    { x: 1200, y: 16, w: 1920, h: 1200 },
    { x: 1200, y: 1216, w: 1920, h: 1200 },
  ],
  client: [3120, 2416],
  /* Spread from a window maximised on the primary: its client origin was at
     (0, 0) on the desktop and is now at the union's (-1200, -16). */
  shift: [1200, 16],
  scale: 1,
};

describe("homeInsets", () => {
  test("at 100% the insets are the physical offsets", () => {
    expect(homeInsets(desk, 1)).toEqual({ x: 1200, y: 16, r: 0, b: 1200 });
  });

  test("at 150% they divide and are NOT rounded — the hairline above the header", () => {
    /* 16 physical / 1.5 = 10.67 CSS; rounding it to 11 put the header's top
       at 16.5 physical pixels and showed half a pixel of wall above it. */
    const at = homeInsets(desk, 1.5);
    expect(at.y * 1.5).toBeCloseTo(16, 10);
    expect(at.x * 1.5).toBeCloseTo(1200, 10);
    expect(at.b * 1.5).toBeCloseTo(1200, 10);
  });

  test("a client a pixel short of the box does not go negative", () => {
    expect(homeInsets({ ...desk, client: [3119, 2416] }, 1).r).toBe(0);
  });

  test("a nonsense ratio is read as 1 rather than dividing by it", () => {
    expect(homeInsets(desk, 0).x).toBe(1200);
  });
});

describe("spreadPan", () => {
  test("the wall moves by the window's jump and the header it now runs under", () => {
    expect(spreadPan(desk, 40)).toEqual({ x: 1200, y: 56 });
  });

  test("the jump is physical and divides by the scale the window is drawn at", () => {
    expect(spreadPan({ ...desk, scale: 1.5 }, 40)).toEqual({ x: 800, y: 16 / 1.5 + 40 });
  });
});
