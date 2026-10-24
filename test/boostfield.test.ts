import { describe, expect, test } from "bun:test";
import { LOOKS, lookOf, mulberry32, DEFAULT_LOOK, FPS, SPARE_FPS } from "../src/lib/boostfield";
import { intensityOf, victoryDue, VICTORY_GAP_MS } from "../src/lib/boost";

/** Hue in degrees and saturation 0–1 of a `#rrggbb`. */
function hsl(hex: string): { h: number; s: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h: (h + 360) % 360, s };
}
const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/* The three status hues, off tokens.css: celadon working, amber asking, rust
   failed. A look that says it keeps them readable keeps its accents away from
   all three. */
const STATUS = ["#7fb8a4", "#e9a13b", "#c5603f"].map((c) => hsl(c).h);

describe("the looks", () => {
  test("four of them, each named once, crystal first by default", () => {
    expect(LOOKS.map((l) => l.id)).toEqual(["crystal", "ember", "eclipse", "abyss"]);
    expect(DEFAULT_LOOK).toBe("crystal");
    expect(lookOf("nonsense").id).toBe("crystal");
    expect(lookOf(null).id).toBe("crystal");
    expect(lookOf("abyss").label).toBe("abyss");
  });

  test("every look carries every colour the CSS half reads", () => {
    const keys = ["--boost-ground", "--boost-card", "--boost-ink", "--boost-a", "--boost-b", "--boost-c", "--boost-bar", "--boost-vignette"];
    for (const l of LOOKS) expect(Object.keys(l.vars).sort()).toEqual([...keys].sort());
  });

  test("a card's fill is opaque — nothing standing on the wall may be transparent", () => {
    for (const l of LOOKS) expect(l.vars["--boost-card"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("a look that says status stays readable keeps its accents clear of all three hues", () => {
    for (const l of LOOKS.filter((x) => x.legible)) {
      for (const k of ["--boost-a", "--boost-b", "--boost-c"]) {
        const { h, s } = hsl(l.vars[k]!);
        if (s < 0.15) continue; /* a grey has no hue to collide with */
        for (const st of STATUS) expect(gap(h, st)).toBeGreaterThanOrEqual(35);
      }
    }
  });

  test("and the one that says it does not, does not — ember sits on amber", () => {
    const ember = lookOf("ember");
    expect(ember.legible).toBe(false);
    const { h } = hsl(ember.vars["--boost-a"]!);
    expect(Math.min(...STATUS.map((st) => gap(h, st)))).toBeLessThan(35);
  });

  test("a crest is an inert drawing: an svg, no script, no handler, nothing fetched", () => {
    for (const l of LOOKS) {
      expect(l.crest.startsWith("<svg")).toBe(true);
      expect(l.crest).not.toMatch(/<script|\son[a-z]+=|href|url\(/i);
    }
  });
});

describe("the renderer's clock and dice", () => {
  test("a seed draws the same field everywhere", () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  test("full motion draws at half a display's rate, spare at a few frames", () => {
    expect(FPS).toBe(30);
    expect(SPARE_FPS).toBeLessThan(FPS);
  });
});

describe("boost's mood", () => {
  test("credits outrank the count; three working is several", () => {
    expect(intensityOf(0, 0)).toBe(0);
    expect(intensityOf(1, 0)).toBe(1);
    expect(intensityOf(2, 0)).toBe(1);
    expect(intensityOf(3, 0)).toBe(2);
    expect(intensityOf(0, 1)).toBe(3);
    expect(intensityOf(9, 1)).toBe(3);
  });

  test("a victory is rationed", () => {
    expect(victoryDue(null, 1000)).toBe(true);
    expect(victoryDue(1000, 1000 + VICTORY_GAP_MS - 1)).toBe(false);
    expect(victoryDue(1000, 1000 + VICTORY_GAP_MS)).toBe(true);
  });
});
