/* How bright the room is, on top of whichever skin is on.
 *
 * The person this exists for liked the default skin and wanted to make it
 * *brighter* with a slider, without it becoming a different skin. Separately,
 * they found the first light skins burning their eyes, which a slider can
 * answer in the other direction. So this is a third control on the wall ring
 * and deliberately not a skin: a transform applied to the resolved skin, at a
 * level remembered per skin, and a no-op at zero. At zero it writes nothing at
 * all, so `studio` stays the untouched app exactly as `palette.ts` promises.
 *
 * ## What it moves, and why not `filter: brightness()`
 *
 * The obvious one-liner is a CSS filter on the root, and it is wrong twice.
 * It brightens the text and the status colours along with the ground, and
 * lifts blacks to grey, which looks washed out rather than like a brighter
 * room. And a filter on the whole window re-rasters everything under it on
 * every frame anything animates, which is the cost class `motion.ts` exists to
 * keep out.
 *
 * So the ground is shifted instead, in Oklab lightness, and the same amount for
 * every surface and line. That keeps the *spacing* between wall, panel, card,
 * chip and hairline, and the spacing is what makes the default work. The ink
 * ramp and the status colours are then re-solved along their own hue, each to
 * keep the contrast it had against the panel. Where the new ground leaves no
 * room for that, the brightest ink stays close to its own colour rather than
 * turning white, and only the rungs that would collide under it give way. See
 * `brighten`.
 *
 * ## Why it cannot cross from dark to light
 *
 * Mid-grey is a dead zone: neither light nor dark text reads well against it.
 * A slider that carried studio's ground up through the middle would pass
 * through a range where nothing is legible, then flip the text. So the travel
 * stays on the skin's own side. A dark skin goes from a little darker up to a
 * dim charcoal room (studio's panel from Oklab L 0.16 to about 0.29); past
 * about 0.33 the muted rung could no longer keep AA. A light skin goes from
 * a dimmer paper up to a little brighter, since the light skins already sit
 * deliberately off white. Becoming light is a skin's job.
 *
 * Pure, and tested in `test/brightness.test.ts`. The applying half, reading
 * the drawn tokens and writing the result, is `palette.svelte.ts`. */

import { contrast, luminance, oklab, type SkinOverrides } from "./palette";

/** The surfaces and lines, moved by the same Oklab L. */
export const GROUND = ["--ink", "--well", "--surface", "--hollow", "--raised", "--edge", "--rule"] as const;
/** The ink ramp, re-solved for contrast against the moved panel. */
export const RAMP = ["--paper", "--paper-dim", "--paper-mute", "--paper-faint"] as const;
/** Status colours, re-solved the same way. Their hue is kept, so the families
 *  `test/palette.test.ts` holds them to cannot move. */
export const MARKS = ["--st-work", "--st-ask", "--st-soft", "--st-rest", "--st-fail"] as const;
/** Everything this reads and may write. */
export const BRIGHT_KEYS = [...GROUND, ...RAMP, ...MARKS] as const;

/** The level runs from -1 to 1. One chord press is a tenth of that. */
export const STEP = 0.1;

/** How much each rung of the ink ramp must sit under the one above, as a
 *  contrast ratio, when the room at the top has run out. Studio's own steps
 *  are 1.85, 1.69 and 1.75, so this only ever bites at the top. */
const LADDER_STEP = 1.25;

/** How far a full turn moves the ground, in Oklab L, by polarity. See the
 *  head of this file for why each side is the length it is. */
export const TRAVEL = {
  dark: { up: 0.13, down: 0.06 },
  light: { up: 0.035, down: 0.12 },
} as const;

/** A level as stored: a number in range, on the step, or 0 for anything else. */
export function cleanLevel(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(-1, Math.min(1, n)) * 100) / 100;
}

/** Levels by skin id, as read back from storage: anything unreadable dropped. */
export function cleanLevels(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length > 80) continue;
    const n = cleanLevel(v);
    if (n !== 0) out[k] = n;
  }
  return out;
}

/** The next level one press away, on the step. */
export function nudged(level: number, dir: number): number {
  return cleanLevel(Math.round((level + Math.sign(dir) * STEP) * 10) / 10);
}

/** How a level reads back: "as it is", or a signed percentage. */
export function levelSaid(level: number): string {
  const n = Math.round(cleanLevel(level) * 100);
  return n === 0 ? "as it is" : `${n > 0 ? "+" : "−"}${Math.abs(n)}%`;
}

/** Whether a drawn ground is light, by the panel. Same threshold as
 *  `palette.svelte.ts`'s ground flag. */
export function lightGround(drawn: Record<string, string>): boolean {
  return (luminance(drawn["--well"] ?? "") ?? 0) > 0.3;
}

/** The overrides that brighten the drawn skin by `level`, or nothing.
 *
 *  `drawn` is what the browser resolves each token to under the current skin.
 *  A token that is not a six-digit hex (an authored skin may write a
 *  `color-mix`) is left exactly as it is: a transform cannot honestly be
 *  applied to a value it cannot read. */
export function brighten(drawn: Record<string, string>, level: number): SkinOverrides {
  const lvl = cleanLevel(level);
  if (lvl === 0) return {};
  const light = lightGround(drawn);
  const travel = light ? TRAVEL.light : TRAVEL.dark;
  const dL = lvl > 0 ? lvl * travel.up : lvl * travel.down;

  const out: Record<string, string> = {};
  for (const k of GROUND) {
    const v = drawn[k];
    const o = v ? oklab(v) : null;
    if (!o) continue;
    out[k] = toHex([clamp(o[0] + dL, 0.02, 0.995), o[1], o[2]]);
  }

  const oldWell = drawn["--well"];
  const newWell = out["--well"];
  if (!oldWell || !newWell) return out;

  /* The ramp: each rung's contrast against the old panel is its target
     against the new one. Two things bound that.

     The brightest rung may not leave its own colour behind. Studio's ink is
     "warm bone, never pure white", and solving the top rung for its old 15:1
     on a lifted ground would push it to #ffffff, which is a different ink
     rather than the same one in a brighter room. So it travels at most 0.05
     in Oklab L past where the skin put it, toward white on dark and toward
     black on light, and keeps its hue and chroma.

     Then each lower rung keeps its own contrast unless that would crowd the
     rung above, in which case it sits a step under it. Only the top of the
     ladder compresses, which is where the room ran out, and the rungs that
     carry body text keep what they had: muted text keeps AA. Squeezing the
     whole ladder by one power would have dragged muted text under 4.5. */
  const paper = drawn["--paper"] ? oklab(drawn["--paper"]) : null;
  const limit = paper ? clamp(light ? paper[0] - 0.05 : paper[0] + 0.05, 0.02, 0.985) : light ? 0 : 1;
  let above = Infinity;
  for (const k of RAMP) {
    const v = drawn[k];
    const t = v ? contrast(v, oldWell) : null;
    if (t === null || !v) continue;
    const target = Math.min(t, above / LADDER_STEP);
    const solved = solve(v, newWell, target, light, limit);
    if (!solved) continue;
    out[k] = solved;
    above = contrast(solved, newWell) ?? target;
  }
  const reach = maxContrast(newWell, light);

  for (const k of MARKS) {
    const v = drawn[k];
    if (!v) continue;
    const t = contrast(v, oldWell);
    if (t === null) continue;
    const solved = solve(v, newWell, Math.min(t, reach), light);
    if (solved) out[k] = solved;
  }
  return out as SkinOverrides;
}

/* ── the arithmetic ─────────────────────────────────────────────────────── */

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The best contrast anything can have against `ground` on the text's side:
 *  white on a dark ground, black on a light one. */
function maxContrast(ground: string, light: boolean): number {
  return contrast(ground, light ? "#000000" : "#ffffff") ?? 1;
}

/** The colour along `like`'s hue whose contrast against `ground` is `target`,
 *  on the side text sits on (lighter on dark, darker on light). Bisection on
 *  Oklab L with the hue's a and b kept, so a status colour stays in its
 *  family. Returns the nearest reachable colour when the target is not.
 *  `limit` bounds how far from the ground it may go, for the brightest ink,
 *  which may not become white. */
function solve(like: string, ground: string, target: number, light: boolean, limit?: number): string | null {
  const o = oklab(like);
  const g = oklab(ground);
  if (!o || !g) return null;
  let lo = light ? (limit ?? 0.0) : g[0];
  let hi = light ? g[0] : (limit ?? 1.0);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const c = contrast(toHex([mid, o[1], o[2]]), ground) ?? 1;
    /* On dark, contrast grows with L; on light it shrinks. */
    const tooMuch = c > target;
    if (light ? tooMuch : !tooMuch) lo = mid;
    else hi = mid;
  }
  return toHex([(lo + hi) / 2, o[1], o[2]]);
}

/** Oklab to a six-digit hex, pulling chroma in until the colour is in sRGB.
 *  Chroma, not lightness, is what gives way, because lightness is the thing
 *  being solved for. */
export function toHex([L, a, b]: [number, number, number]): string {
  let k = 1;
  for (let i = 0; i < 60; i++) {
    const rgb = linearToSrgb(oklabToLinear(L, a * k, b * k));
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return hex(rgb);
    k *= 0.95;
  }
  return hex(linearToSrgb(oklabToLinear(L, 0, 0)));
}

function oklabToLinear(L: number, a: number, b: number): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearToSrgb(lin: number[]): number[] {
  return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.sign(x) * Math.abs(x) ** (1 / 2.4) - 0.055));
}

function hex(rgb: number[]): string {
  return (
    "#" +
    rgb
      .map((v) =>
        Math.round(clamp(v, 0, 1) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
