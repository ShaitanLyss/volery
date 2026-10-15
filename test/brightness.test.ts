import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRIGHT_KEYS,
  GROUND,
  RAMP,
  brighten,
  cleanLevel,
  cleanLevels,
  levelSaid,
  lightGround,
  nudged,
} from "../src/lib/brightness";
import { FAMILIES, FLOORS, SKINS, contrast, hueSat, inFamily, oklab, resolveSkin } from "../src/lib/palette";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TOKENS = readFileSync(join(SRC, "lib/tokens.css"), "utf8");

/** What each skin draws: tokens.css's defaults, the skin over them, and every
 *  `var()` followed, which is what `getComputedStyle` hands the app. Only the
 *  `:root` block, so the light ground's ANSI set does not leak in. */
function drawn(id: string): Record<string, string> {
  const root = TOKENS.slice(TOKENS.indexOf(":root {"), TOKENS.indexOf("\n}", TOKENS.indexOf(":root {")));
  const base: Record<string, string> = {};
  for (const m of root.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) base[m[1]] = m[2].trim();
  const merged: Record<string, string> = { ...base, ...resolveSkin(id) };
  const deref = (v: string, depth = 0): string => {
    const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v.trim());
    return m && depth < 8 && merged[m[1]] ? deref(merged[m[1]], depth + 1) : v;
  };
  const out: Record<string, string> = {};
  for (const k of BRIGHT_KEYS) if (merged[k]) out[k] = deref(merged[k]);
  return out;
}

const L = (hex: string) => oklab(hex)![0];
const LEVELS = [-1, -0.5, 0.5, 1];

describe("zero is the skin, untouched", () => {
  /* The revert guarantee, the same promise `studio` makes on the skin ring:
     at zero nothing is written, so every property comes from the skin and
     tokens.css and from nothing else. */
  test.each(SKINS.map((s) => s.id))("%s at zero writes nothing", (id) => {
    expect(brighten(drawn(id), 0)).toEqual({});
  });
});

describe.each(SKINS.map((s) => [s.label, s.id] as const))("%s, brightened", (_l, id) => {
  const before = drawn(id);

  test.each(LEVELS)("at %p the ground moves together, so its spacing is kept", (lvl) => {
    const after = { ...before, ...brighten(before, lvl) };
    const keys = GROUND.filter((k) => /^#[0-9a-f]{6}$/i.test(before[k] ?? ""));
    const shifts = keys.map((k) => L(after[k]) - L(before[k]));
    for (const s of shifts) {
      expect(Math.sign(s)).toBe(Math.sign(lvl));
      /* The same shift for every surface, give or take the 8-bit rounding of
         a hex, unless a token hit the clamp at the top of the range. */
      expect(Math.abs(s - shifts[0])).toBeLessThan(0.006);
    }
  });

  /* Mid-grey is the dead zone. Brightness must never carry a skin across it:
     becoming light is what a skin is for. */
  test.each(LEVELS)("at %p it stays on its own side of grey", (lvl) => {
    const after = { ...before, ...brighten(before, lvl) };
    expect(lightGround(after)).toBe(lightGround(before));
  });

  test.each(LEVELS)("at %p the ink is still a ladder, and muted text keeps AA", (lvl) => {
    const after = { ...before, ...brighten(before, lvl) };
    const ratios = RAMP.map((k) => contrast(after[k], after["--well"])!);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThan(ratios[i - 1]);
    expect(ratios[2], `--paper-mute at ${lvl}`).toBeGreaterThanOrEqual(4.5);
  });

  /* Solving the top rung for its old contrast on a lifted ground ran it
     straight to #ffffff on studio, which is a different ink ("warm bone,
     never pure white" in tokens.css) rather than the same one in a brighter
     room. */
  test.each(LEVELS)("at %p the brightest ink is still its own colour", (lvl) => {
    const after = { ...before, ...brighten(before, lvl) };
    expect(["#ffffff", "#000000"]).not.toContain(after["--paper"].toLowerCase());
    expect(Math.abs(L(after["--paper"]) - L(before["--paper"]))).toBeLessThanOrEqual(0.051);
  });

  test.each(LEVELS)("at %p status keeps its family and stays a mark", (lvl) => {
    const after = { ...before, ...brighten(before, lvl) };
    for (const [k, fam] of Object.entries(FAMILIES)) {
      const hs = hueSat(after[k]);
      if (!hs || hs.sat < 0.15) continue;
      expect(inFamily(hs.hue, fam.from, fam.to), `${k} ${after[k]} at hue ${hs.hue.toFixed(0)}`).toBe(true);
    }
    for (const k of ["--st-work", "--st-ask", "--st-fail"]) {
      expect(contrast(after[k], after["--well"])!, `${k} at ${lvl}`).toBeGreaterThanOrEqual(FLOORS.contrast);
    }
  });
});

describe("what it reaches and what it leaves", () => {
  test("studio's brightest still reads as a dim room, not a light one", () => {
    const after = { ...drawn("studio"), ...brighten(drawn("studio"), 1) };
    expect(L(after["--well"])).toBeGreaterThan(0.25);
    expect(L(after["--well"])).toBeLessThan(0.33);
  });

  test("a value it cannot read is left exactly as it is", () => {
    const d = { ...drawn("studio"), "--surface": "color-mix(in srgb, red 10%, black)" };
    const out = brighten(d, 0.5);
    expect(out["--surface" as keyof typeof out]).toBeUndefined();
    expect(out["--ink" as keyof typeof out]).toBeDefined();
  });

  test("it writes nothing it does not own", () => {
    const out = brighten(drawn("vellum"), -0.7);
    for (const k of Object.keys(out)) expect(BRIGHT_KEYS as readonly string[]).toContain(k);
  });
});

describe("the level", () => {
  test("is clamped, rounded, and anything unreadable is zero", () => {
    expect(cleanLevel(2)).toBe(1);
    expect(cleanLevel(-3)).toBe(-1);
    expect(cleanLevel("0.333")).toBe(0.33);
    expect(cleanLevel("loud")).toBe(0);
    expect(cleanLevel(NaN)).toBe(0);
  });

  test("a store keeps only real levels, by skin", () => {
    expect(cleanLevels({ studio: 0.3, sugar: "x", meadow: 0, vellum: -0.4 })).toEqual({ studio: 0.3, vellum: -0.4 });
    expect(cleanLevels([1, 2])).toEqual({});
    expect(cleanLevels(null)).toEqual({});
  });

  test("a press is one step on the tenth, and stops at the ends", () => {
    expect(nudged(0, 1)).toBe(0.1);
    expect(nudged(0.25, 1)).toBe(0.4);
    expect(nudged(1, 1)).toBe(1);
    expect(nudged(-0.9, -1)).toBe(-1);
  });

  test("says itself back", () => {
    expect(levelSaid(0)).toBe("as it is");
    expect(levelSaid(0.3)).toBe("+30%");
    expect(levelSaid(-0.2)).toBe("−20%");
  });
});
