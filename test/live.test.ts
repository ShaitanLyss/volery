/* The live reading's arithmetic. Small, and every part of it is a number the
 * eye will read as a fact about the last minute, so each one is checked rather
 * than trusted. */

import { describe, expect, test } from "bun:test";
import { byHost, liveSaid, perMinute, stripOf, totalsIn, type LiveSample } from "../src/lib/live";

const NOW = 1_764_000_000_000;
const MINUTE = 60_000;

const sample = (over: Partial<LiveSample> = {}): LiveSample => ({
  at: NOW,
  host: "",
  model: "claude-sonnet-5-5",
  inTok: 0,
  outTok: 0,
  cacheRead: 0,
  write: 0,
  usd: 0.01,
  ...over,
});

describe("what landed in a window", () => {
  test("sums the four classes and counts the requests", () => {
    const got = totalsIn(
      [sample({ inTok: 10, outTok: 20, cacheRead: 300, write: 40 }), sample({ inTok: 5 })],
      NOW - MINUTE,
      NOW + MINUTE,
    );
    expect(got.requests).toBe(2);
    expect(got.tokens).toBe(375);
    expect(got.usd).toBeCloseTo(0.02, 9);
  });

  test("the window is half open, so a sample on its edge is in exactly one of two adjacent windows", () => {
    const rows = [sample({ at: NOW, inTok: 100 })];
    expect(totalsIn(rows, NOW - MINUTE, NOW).tokens).toBe(0);
    expect(totalsIn(rows, NOW, NOW + MINUTE).tokens).toBe(100);
  });

  test("a model the table could not place is counted as unpriced, never as free money", () => {
    const got = totalsIn([sample({ usd: null, outTok: 500 })], NOW - 1, NOW + 1);
    expect(got.usd).toBe(0);
    expect(got.unpriced).toBe(500);
    expect(got.tokens).toBe(500);
  });
});

describe("the rate", () => {
  test("is per minute, whatever the window's width", () => {
    const totals = { requests: 2, tokens: 1_200, usd: 0.24, unpriced: 0 };
    expect(perMinute(totals, NOW, NOW + MINUTE)!.tokens).toBeCloseTo(1_200, 6);
    expect(perMinute(totals, NOW, NOW + 2 * MINUTE)!.tokens).toBeCloseTo(600, 6);
  });

  test("a window with no width is no reading rather than a slow one", () => {
    expect(perMinute({ requests: 0, tokens: 0, usd: 0, unpriced: 0 }, NOW, NOW)).toBeNull();
  });
});

describe("by machine", () => {
  test("busiest first, and a machine with nothing in the window is absent", () => {
    const rows = [
      sample({ host: "laptop", inTok: 100 }),
      sample({ host: "desk", inTok: 900 }),
      sample({ host: "gone", inTok: 5_000, at: NOW - 10 * MINUTE }),
    ];
    const got = byHost(rows, NOW - MINUTE, NOW + MINUTE);
    expect(got.map((r) => r.host)).toEqual(["desk", "laptop"]);
  });
});

describe("the strip", () => {
  test("a quiet column is a zero, so a lull draws as ground", () => {
    const rows = [sample({ at: NOW + 1_000, inTok: 50 })];
    const bars = stripOf(rows, NOW, NOW + 60_000, 6);
    expect(bars).toHaveLength(6);
    expect(bars[0]).toBe(50);
    expect(bars.slice(1)).toEqual([0, 0, 0, 0, 0]);
  });

  test("a sample at the end of the window belongs to no column of it", () => {
    const bars = stripOf([sample({ at: NOW + 60_000, inTok: 50 })], NOW, NOW + 60_000, 6);
    expect(bars.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("saying a rate", () => {
  test("says thousands and millions, and quiet for nothing", () => {
    expect(liveSaid(0)).toBe("quiet");
    expect(liveSaid(420)).toBe("420 tok/min");
    expect(liveSaid(12_500)).toBe("12.5k tok/min");
    expect(liveSaid(2_400_000)).toBe("2.40M tok/min");
  });
});
