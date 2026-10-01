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
  /* Spread from a window maximised on the primary: its client origin was at
     (0, 0) on the desktop and is now at the union's (-1200, -16). */
  shift: [1200, 16],
  scale: 1,
};

describe("homeInsets", () => {
  test("at 100% the insets are the physical offsets", () => {
    expect(homeInsets(desk, 1, { w: 3120, h: 2416 })).toEqual({ x: 1200, y: 16, r: 0, b: 1200 });
  });

  test("at 150% everything divides, the window's CSS size included", () => {
    /* The window is drawn at the laptop's DPI: 3120×2416 physical is 2080×1611
       CSS, and the primary's 1920×1200 is 1280×800 of it. */
    expect(homeInsets(desk, 1.5, { w: 2080, h: 1611 })).toEqual({ x: 800, y: 11, r: 0, b: 800 });
  });

  test("a rounding disagreement with the window size does not go negative", () => {
    expect(homeInsets(desk, 1, { w: 3119, h: 2416 }).r).toBe(0);
  });

  test("a nonsense ratio is read as 1 rather than dividing by it", () => {
    expect(homeInsets(desk, 0, { w: 3120, h: 2416 }).x).toBe(1200);
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
