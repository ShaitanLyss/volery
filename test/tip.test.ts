import { describe, expect, test } from "bun:test";

import { cutShort, placeTip, TIP_GAP } from "../src/lib/tip";

describe("the full title on settle", () => {
  test("only a title the box cut short asks for one", () => {
    expect(cutShort({ scrollWidth: 300, clientWidth: 180 })).toBe(true);
    expect(cutShort({ scrollWidth: 180, clientWidth: 180 })).toBe(false);
    /* A fractional zoom measures an exact fit a pixel over. */
    expect(cutShort({ scrollWidth: 181, clientWidth: 180 })).toBe(false);
  });

  const view = { w: 1000, h: 800 };

  test("under the title and flush with its start", () => {
    expect(placeTip({ left: 100, top: 200, bottom: 220 }, { w: 300, h: 40 }, view)).toEqual({ x: 100, y: 220 + TIP_GAP });
  });

  test("above it when there is no room below", () => {
    expect(placeTip({ left: 100, top: 760, bottom: 780 }, { w: 300, h: 40 }, view)).toEqual({ x: 100, y: 760 - TIP_GAP - 40 });
  });

  test("never past the window's edge", () => {
    expect(placeTip({ left: 900, top: 200, bottom: 220 }, { w: 300, h: 40 }, view).x).toBe(1000 - 300 - TIP_GAP);
    expect(placeTip({ left: -50, top: 200, bottom: 220 }, { w: 300, h: 40 }, view).x).toBe(TIP_GAP);
  });
});
