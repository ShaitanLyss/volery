/** What boost looks like: a catalogue of looks, and a renderer for each that
 *  draws the wall's atmosphere into one canvas behind the cards.
 *
 *  Lyss, 2026-10-24: *"your mockups don't look that great, and they have no
 *  motion, put more work into it, I'd like have a few the user can choose
 *  from."* So every look here moves, the wall offers all of them, and the
 *  recordings she chose from were drawn by this file.
 *
 *  **The one place on the wall decorative hue is allowed, and it is confined
 *  the way the synth's is (`toys.md`)**: hues are named here and in the boost
 *  components, nothing touches `tokens.css`, and only while boost is on. The
 *  difference from the synth is that the wall stays visible, so a look either
 *  keeps clear of the three status hues — celadon working, amber asking, rust
 *  failed — or says it does not (`legible: false`), and the picker says so.
 *
 *  **Cost, priced against `motion.md`**: the present rate is the term that
 *  matters, so a field draws at most `FPS` frames a second, and only when the
 *  motion setting allows it at all — `still` draws one frame and stops,
 *  `spare` draws at `SPARE_FPS`. Every glow is drawn once into a sprite at
 *  resize and blitted, because `shadowBlur` and `filter` per particle per frame
 *  are the expensive things in a 2D canvas; what has to be soft *and* moving
 *  (the abyss's caustics) is drawn into a small buffer and scaled up, which
 *  blurs it for free. No `box-shadow` animates anywhere.
 *
 *  The renderer takes its canvas context and a seeded random source, so the
 *  same look draws the same field in the app and in the recordings. */

export type LookId = "crystal" | "ember" | "eclipse" | "abyss";

export type Look = {
  id: LookId;
  label: string;
  /** One line for the picker. */
  blurb: string;
  /** Whether working / asking / failed stay readable under it — no hue within
   *  reach of celadon, amber or rust. Said on the picker when false. */
  legible: boolean;
  /** The boost button's glyph while this look is on: an inline 12×12 SVG,
   *  a constant of this file and never anything a card wrote. */
  crest: string;
  /** The colours the CSS half of the look reads — the ground, a card's fill,
   *  the title bar, the boost button's crest, a card on credits, the
   *  ignition's title. Names are the `--boost-*` custom properties the studio
   *  root carries while boost is on. Every fill here is opaque: nothing
   *  standing on the wall may be transparent (CLAUDE.md). */
  vars: Record<string, string>;
};

export const LOOKS: Look[] = [
  {
    id: "crystal",
    label: "crystal",
    blurb: "a violet void with crystals turning in it",
    legible: true,
    crest: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0 L10 4 L6 12 L2 4 Z" fill="#eef1ff"/><path d="M6 0 L6 12 L10 4 Z" fill="#a99bff"/></svg>',
    vars: {
      "--boost-ground": "radial-gradient(ellipse 90% 70% at 50% 112%, #2f1c72 0%, #140e2e 42%, #07060f 82%)",
      "--boost-card": "#100d1f",
      "--boost-ink": "#eef1ff",
      "--boost-a": "#9d8cff",
      "--boost-b": "#dfe6ff",
      "--boost-c": "#5f7dff",
      "--boost-bar": "linear-gradient(90deg, #0b0919, #181238 50%, #0b0919)",
      "--boost-vignette": "rgba(96, 72, 255, 0.40)",
    },
  },
  {
    id: "ember",
    label: "ember",
    blurb: "a burning horizon and gold in the air — the most final-boss, and the hardest on amber and rust",
    legible: false,
    crest: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M0 11 L0 3 L3 6.5 L6 1 L9 6.5 L12 3 L12 11 Z" fill="#f3c766"/></svg>',
    vars: {
      "--boost-ground": "radial-gradient(ellipse 110% 55% at 50% 115%, #6e1a07 0%, #2c0905 38%, #110504 66%, #060202 92%)",
      "--boost-card": "#150b09",
      "--boost-ink": "#fff2cf",
      "--boost-a": "#f0b048",
      "--boost-b": "#fff0c0",
      "--boost-c": "#c2410c",
      "--boost-bar": "linear-gradient(180deg, #170806, #0b0403)",
      "--boost-vignette": "rgba(150, 26, 6, 0.55)",
    },
  },
  {
    id: "eclipse",
    label: "eclipse",
    blurb: "black and white-hot, feathers falling — status is the only colour left",
    legible: true,
    crest: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="#000" stroke="#fff" stroke-width="1.4"/></svg>',
    vars: {
      "--boost-ground": "radial-gradient(ellipse 80% 70% at 76% 40%, #121212 0%, #060606 55%, #020202 100%)",
      "--boost-card": "#0b0b0b",
      "--boost-ink": "#ffffff",
      "--boost-a": "#ffffff",
      "--boost-b": "#d8d8d8",
      "--boost-c": "#8a8a8a",
      "--boost-bar": "linear-gradient(180deg, #070707, #030303)",
      "--boost-vignette": "rgba(0, 0, 0, 0.85)",
    },
  },
  {
    id: "abyss",
    label: "abyss",
    blurb: "the deep — light from far above, and something vast passing below",
    legible: true,
    crest: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 C 9 5, 10 7, 6 11 C 2 7, 3 5, 6 1 Z" fill="#bfe6ff"/></svg>',
    vars: {
      "--boost-ground": "linear-gradient(180deg, #072a46 0%, #041c31 35%, #020d19 75%, #01060d 100%)",
      "--boost-card": "#06121f",
      "--boost-ink": "#e4f4ff",
      "--boost-a": "#4fa8ff",
      "--boost-b": "#bfe6ff",
      "--boost-c": "#2a6fd6",
      "--boost-bar": "linear-gradient(180deg, #05213a, #031322)",
      "--boost-vignette": "rgba(2, 16, 40, 0.75)",
    },
  },
];

export const DEFAULT_LOOK: LookId = "crystal";

export function lookOf(id: string | null | undefined): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS.find((l) => l.id === DEFAULT_LOOK)!;
}

/** Frames a second, at most. Half the display rate is what the eye reads as
 *  smooth drift, and the present rate is the cost (`motion.md`). */
export const FPS = 30;
/** And under `spare` motion — enough to be alive, little enough to be cheap. */
export const SPARE_FPS = 8;

/* ── randomness, seeded so a look draws the same field everywhere ───────── */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const TAU = Math.PI * 2;

/* ── the renderer's shape ──────────────────────────────────────────────── */

type Ctx = CanvasRenderingContext2D;
type Sprite = HTMLCanvasElement | OffscreenCanvas;

/** One look's atmosphere. `t` is seconds since the field started; `dt` the
 *  seconds since the last frame, clamped by the caller. */
export interface Field {
  resize(w: number, h: number): void;
  frame(ctx: Ctx, t: number, dt: number): void;
  /** The moments — a limit break's shockwave and sparks, the ignition's flash
   *  — drawn into a second canvas *above* the cards, since a burst behind the
   *  card it is about is a burst the card hides. Cleared and redrawn each
   *  frame; empty between moments. */
  overlay(ctx: Ctx, t: number, dt: number): void;
  /** A card went onto credits at (x, y), in canvas pixels: the limit break. */
  burst(x: number, y: number, t: number): void;
  /** Boost was switched on: the ignition. */
  ignite(t: number): void;
}

/** Something that makes an offscreen canvas — the document's in the app.
 *  Sprites are drawn once and blitted every frame. */
export type MakeCanvas = (w: number, h: number) => Sprite;

export function domCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

const ctxOf = (s: Sprite) => s.getContext("2d") as Ctx;
const sizeOf = (s: Sprite) => ({ w: (s as HTMLCanvasElement).width, h: (s as HTMLCanvasElement).height });

/** A soft round glow: a white core falling off through `color` to nothing. */
function glowSprite(make: MakeCanvas, r: number, color: string, core = 0.18): Sprite {
  const c = make(r * 2, r * 2);
  const g = ctxOf(c);
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(core, color);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  return c;
}

/** A shaft of light, soft on both sides and fading along its length, pointing
 *  down. Drawn once, then stretched and turned. Two gradients cannot share one
 *  fill, so the length's fade is laid on with `destination-in`. */
function beamSprite(make: MakeCanvas, rgb: string): Sprite {
  const W = 64, H = 512;
  const c = make(W, H);
  const g = ctxOf(c);
  const across = g.createLinearGradient(0, 0, W, 0);
  across.addColorStop(0, `rgba(${rgb},0)`);
  across.addColorStop(0.5, `rgba(${rgb},1)`);
  across.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = across;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = "destination-in";
  const along = g.createLinearGradient(0, 0, 0, H);
  along.addColorStop(0, "rgba(0,0,0,1)");
  along.addColorStop(0.6, "rgba(0,0,0,0.45)");
  along.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = along;
  g.fillRect(0, 0, W, H);
  return c;
}

/** Draw a beam sprite from (x, y) down along `angle` (radians from straight
 *  down), `len` long and `width` wide at its widest. */
function drawBeam(ctx: Ctx, beam: Sprite, x: number, y: number, angle: number, len: number, width: number, alpha: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalAlpha = alpha;
  ctx.drawImage(beam as CanvasImageSource, -width / 2, 0, width, len);
  ctx.restore();
}

/** A four-pointed glint, for a crystal's tip and a spark at its brightest. */
function glintSprite(make: MakeCanvas, r: number): Sprite {
  const c = make(r * 2, r * 2);
  const g = ctxOf(c);
  g.translate(r, r);
  g.globalCompositeOperation = "lighter";
  for (const [len, wid] of [[r, r * 0.08], [r * 0.55, r * 0.06]] as const) {
    for (const rot of [0, Math.PI / 2]) {
      g.save();
      g.rotate(rot + (len < r ? Math.PI / 4 : 0));
      const grad = g.createLinearGradient(-len, 0, len, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.95)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(0, 0, len, wid, 0, 0, TAU);
      g.fill();
      g.restore();
    }
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.35);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = core;
  g.fillRect(-r, -r, r * 2, r * 2);
  return c;
}

/** Shared by every look: the shockwaves and the spray of a burst, and the
 *  ignition's flash, in one look's colours. */
class Bursts {
  rings: { x: number; y: number; t0: number; max: number; w: number }[] = [];
  sparks: { x: number; y: number; vx: number; vy: number; t0: number; life: number; s: number }[] = [];
  flash = { t0: -99, dur: 0.5, peak: 0, x: 0, y: 0 };
  constructor(
    private r: Rng,
    private spark: Sprite,
    private ring: string,
  ) {}
  burst(x: number, y: number, t: number, scale = 1) {
    this.rings.push({ x, y, t0: t, max: 260 * scale, w: 4 });
    this.rings.push({ x, y, t0: t + 0.1, max: 170 * scale, w: 2 });
    for (let i = 0; i < 60 * scale; i++) {
      const a = this.r() * TAU;
      const v = between(this.r, 140, 620) * scale;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: t, life: between(this.r, 0.5, 1.3), s: between(this.r, 0.4, 1.2) });
    }
    this.flash = { t0: t, dur: 0.5, peak: 0.22 * Math.min(1, scale), x, y };
  }
  ignite(x: number, y: number, t: number) {
    this.burst(x, y, t, 2.4);
    this.rings.push({ x, y, t0: t + 0.25, max: 1100, w: 3 });
    this.rings.push({ x, y, t0: t + 0.45, max: 1300, w: 1.5 });
    this.flash = { t0: t, dur: 1.0, peak: 0.6, x, y };
  }
  draw(ctx: Ctx, t: number, dt: number, w: number, h: number) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const f = this.flash;
    const fk = (t - f.t0) / f.dur;
    if (fk >= 0 && fk < 1) {
      /* The flash is a light, not a fade to white: brightest where it began. */
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.max(w, h) * (0.3 + fk));
      g.addColorStop(0, `rgba(255,255,255,${f.peak * (1 - fk) ** 2})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    this.rings = this.rings.filter((g) => t - g.t0 < 0.95);
    for (const g of this.rings) {
      const k = (t - g.t0) / 0.95;
      if (k < 0) continue;
      const ease = 1 - (1 - k) ** 3;
      ctx.strokeStyle = this.ring;
      for (const [lw, a] of [[g.w * 4, 0.12], [g.w, 0.85]] as const) {
        ctx.globalAlpha = (1 - k) * a;
        ctx.lineWidth = lw * (1 + 2 * (1 - k));
        ctx.beginPath();
        ctx.arc(g.x, g.y, ease * g.max, 0, TAU);
        ctx.stroke();
      }
    }
    this.sparks = this.sparks.filter((p) => t - p.t0 < p.life);
    const drag = Math.exp(-3.2 * dt);
    for (const p of this.sparks) {
      p.vx *= drag;
      p.vy = p.vy * drag + 40 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = (t - p.t0) / p.life;
      ctx.globalAlpha = (1 - k) ** 1.5;
      const s = 22 * p.s;
      ctx.drawImage(this.spark as CanvasImageSource, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.restore();
  }
}

/* ── crystal ───────────────────────────────────────────────────────────── */

type Shard = {
  x: number; y: number; len: number; wid: number; rot: number; sway: number; spin: number;
  bob: number; phase: number; depth: number; sprite: Sprite; glint: number;
};

class Crystal implements Field {
  w = 0; h = 0;
  /** Stars in three depths, each depth drifting at its own speed — the far
   *  ones barely, the near ones visibly — so the void reads as space you are
   *  moving through. Lyss on the first cut, whose stars only twinkled in
   *  place: "it looks like a png and a 2010 rhythm game instead of having
   *  movement". */
  stars: { x: number; y: number; s: number; tw: number; ph: number; v: number }[] = [];
  shooting: { x: number; y: number; vx: number; vy: number; t0: number; life: number } | null = null;
  nextShooting = 2.5;
  shards: Shard[] = [];
  heart: Shard | null = null;
  star: Sprite;
  glint: Sprite;
  beam: Sprite;
  bursts: Bursts;
  constructor(private r: Rng, private make: MakeCanvas) {
    this.star = glowSprite(make, 6, "rgba(190,180,255,0.9)", 0.25);
    this.glint = glintSprite(make, 28);
    this.beam = beamSprite(make, "205,195,255");
    this.bursts = new Bursts(r, glowSprite(make, 10, "rgba(170,150,255,0.95)"), "#d4ccff");
  }
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const r = mulberry32(7);
    const n = Math.round((w * h) / 6000);
    this.stars = Array.from({ length: n }, (_, i) => {
      /* Depth by thirds: far, middle, near. Speed and size go with it, so the
         near stars pass the far ones — which is what makes it depth. */
      const d = i % 3;
      return {
        x: r() * w, y: r() * h, tw: between(r, 0.4, 1.8), ph: r() * TAU,
        s: [between(r, 0.35, 0.8), between(r, 0.7, 1.25), between(r, 1.2, 2.1)][d]!,
        v: [5, 13, 30][d]! * between(r, 0.8, 1.2),
      };
    });
    const count = Math.max(7, Math.round(w / 170));
    this.shards = Array.from({ length: count }, (_, i) => {
      const depth = between(r, 0.3, 1);
      const len = between(r, 70, 200) * depth;
      const wid = len * between(r, 0.3, 0.42);
      /* Toward the edges rather than under the cards — the cards are the
         work, and a crystal behind a card is a crystal nobody sees. */
      const edge = i % 2 === 0 ? between(r, 0.02, 0.2) : between(r, 0.74, 0.98);
      return {
        x: edge * w, y: between(r, 0.06, 0.96) * h, len, wid, rot: between(r, -0.9, 0.9), sway: between(r, 0.08, 0.25),
        spin: between(r, -0.05, 0.05), bob: between(r, 6, 18), phase: r() * TAU, depth,
        sprite: this.shardSprite(len, wid, depth), glint: r() * 9,
      };
    });
    this.shards.sort((a, b) => a.depth - b.depth);
    /* The heart: one great crystal far off to the right, upright, turning a
       little and back — the thing the void is gathered round. */
    const hl = Math.min(h * 0.62, 560), hw = hl * 0.36;
    this.heart = {
      x: w * 0.84, y: h * 0.56, len: hl, wid: hw, rot: 0, sway: 0.06, spin: 0, bob: 10, phase: 0, depth: 0.7,
      sprite: this.shardSprite(hl, hw, 0.7, true), glint: 2,
    };
  }
  /** A three-faced prism lit from the upper left — a bright face, a mid face
   *  and a dark one, rims of light on the edges that catch it, and a core of
   *  light inside. Far shards are drawn soft, which is the depth. */
  shardSprite(len: number, wid: number, depth: number, heart = false): Sprite {
    const pad = heart ? 90 : 34;
    const c = this.make(wid + pad * 2, len + pad * 2);
    const g = ctxOf(c);
    if (depth < 0.55) g.filter = `blur(${((0.55 - depth) * 6).toFixed(1)}px)`;
    const cx = pad + wid / 2, top = pad, bot = pad + len;
    const sh = 0.2, sl = 0.8;
    const L = [cx - wid / 2, top + len * sh], Lb = [cx - wid / 2, top + len * sl];
    const R = [cx + wid / 2, top + len * sh], Rb = [cx + wid / 2, top + len * sl];
    const ML = [cx - wid * 0.12, top + len * (sh + 0.03)], MLb = [cx - wid * 0.12, top + len * (sl - 0.03)];
    const T = [cx, top], B = [cx, bot];
    const poly = (pts: number[][], fill: string | CanvasGradient) => {
      g.beginPath();
      g.moveTo(pts[0]![0]!, pts[0]![1]!);
      for (const p of pts.slice(1)) g.lineTo(p[0]!, p[1]!);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    };
    const a = depth;
    /* The glow behind it, once. */
    g.save();
    g.shadowColor = `rgba(150,128,255,${(heart ? 0.9 : 0.6) * a})`;
    g.shadowBlur = heart ? 70 : 26;
    poly([T, R, Rb, B, Lb, L], `rgba(120,100,240,${0.25 * a})`);
    g.restore();
    const lit = g.createLinearGradient(L[0]!, L[1]!, ML[0]!, MLb[1]!);
    lit.addColorStop(0, `rgba(250,252,255,${0.92 * a})`);
    lit.addColorStop(1, `rgba(185,175,255,${0.55 * a})`);
    poly([T, ML, MLb, B, Lb, L], lit);
    const mid = g.createLinearGradient(ML[0]!, top, R[0]!, bot);
    mid.addColorStop(0, `rgba(170,150,255,${0.62 * a})`);
    mid.addColorStop(1, `rgba(90,80,230,${0.55 * a})`);
    poly([T, R, Rb, B, MLb, ML], mid);
    const dark = g.createLinearGradient(cx + wid * 0.2, top, R[0]!, bot);
    dark.addColorStop(0, `rgba(40,30,120,${0.35 * a})`);
    dark.addColorStop(1, `rgba(20,14,70,${0.6 * a})`);
    poly([T, [cx + wid * 0.22, top + len * (sh + 0.05)], [cx + wid * 0.22, top + len * (sl - 0.05)], B, Rb, R], dark);
    /* A core of light inside. */
    g.globalCompositeOperation = "lighter";
    const core = g.createRadialGradient(cx - wid * 0.08, top + len * 0.42, 0, cx - wid * 0.08, top + len * 0.42, len * 0.45);
    core.addColorStop(0, `rgba(255,255,255,${(heart ? 0.55 : 0.35) * a})`);
    core.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = core;
    g.fillRect(0, 0, wid + pad * 2, len + pad * 2);
    /* Rims on the edges that face the light. */
    g.lineJoin = "round";
    g.strokeStyle = `rgba(255,255,255,${0.95 * a})`;
    g.lineWidth = heart ? 2 : 1.2;
    g.beginPath(); g.moveTo(Lb[0]!, Lb[1]!); g.lineTo(L[0]!, L[1]!); g.lineTo(T[0]!, T[1]!); g.lineTo(R[0]!, R[1]!); g.stroke();
    g.strokeStyle = `rgba(225,228,255,${0.55 * a})`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(T[0]!, T[1]!); g.lineTo(ML[0]!, ML[1]!); g.lineTo(MLb[0]!, MLb[1]!); g.lineTo(B[0]!, B[1]!); g.stroke();
    g.strokeStyle = `rgba(200,205,255,${0.35 * a})`;
    g.beginPath(); g.moveTo(R[0]!, R[1]!); g.lineTo(Rb[0]!, Rb[1]!); g.lineTo(B[0]!, B[1]!); g.lineTo(Lb[0]!, Lb[1]!); g.stroke();
    return c;
  }
  drawShard(ctx: Ctx, s: Shard, t: number) {
    const y = s.y + Math.sin(t * 0.5 + s.phase) * s.bob;
    const rot = s.rot + Math.sin(t * 0.13 + s.phase) * s.sway + t * s.spin;
    const { w: sw, h: sh } = sizeOf(s.sprite);
    ctx.save();
    ctx.translate(s.x, y);
    ctx.rotate(rot);
    ctx.drawImage(s.sprite as CanvasImageSource, -sw / 2, -sh / 2);
    ctx.globalCompositeOperation = "lighter";
    /* The glint: a band of light crossing the shard every few seconds. */
    const k = ((t + s.glint) % 7) / 7;
    if (k < 0.2) {
      const p = k / 0.2;
      ctx.globalAlpha = Math.sin(p * Math.PI) * 0.55 * s.depth;
      const gy = -s.len / 2 + p * s.len;
      const g = ctx.createLinearGradient(0, gy - 16, 0, gy + 16);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -s.len / 2); ctx.lineTo(s.wid / 2, -s.len * 0.3); ctx.lineTo(s.wid / 2, s.len * 0.3);
      ctx.lineTo(0, s.len / 2); ctx.lineTo(-s.wid / 2, s.len * 0.3); ctx.lineTo(-s.wid / 2, -s.len * 0.3);
      ctx.closePath();
      ctx.fill();
    }
    /* And the tip catching the light as it turns. */
    const tw = Math.max(0, Math.sin(t * 0.9 + s.phase * 3));
    ctx.globalAlpha = tw ** 4 * s.depth;
    const gs = 26 + s.len * 0.15;
    ctx.drawImage(this.glint as CanvasImageSource, -gs / 2, -s.len / 2 - gs / 2, gs, gs);
    ctx.restore();
  }
  frame(ctx: Ctx, t: number, dt: number) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    /* Nebulae drifting through the void. */
    for (const [nx, ny, nr, col, ph] of [
      [0.16, 0.24, 0.55, "rgba(124,92,255,0.20)", 0],
      [0.86, 0.16, 0.45, "rgba(70,120,255,0.17)", 2],
      [0.55, 0.92, 0.7, "rgba(160,80,255,0.14)", 4],
      [0.4, 0.45, 0.35, "rgba(255,120,220,0.05)", 5],
    ] as const) {
      const x = (nx + Math.sin(t * 0.03 + ph) * 0.05) * w;
      const y = (ny + Math.cos(t * 0.025 + ph) * 0.04) * h;
      const rr = nr * Math.max(w, h);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, col);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    /* Light falling through it from the upper left, breathing. */
    for (let i = 0; i < 4; i++) {
      const a = 0.08 + 0.06 * Math.sin(t * 0.21 + i * 1.7);
      drawBeam(ctx, this.beam, w * (0.04 + i * 0.13), -40, -0.42 + i * 0.03, h * 1.5, w * (0.08 + 0.03 * (i % 2)), a);
    }
    /* Drifting left and a little up, as if the wall were travelling towards
       the heart crystal; each wraps round when it leaves. */
    for (const s of this.stars) {
      s.x -= s.v * dt;
      s.y -= s.v * 0.18 * dt;
      if (s.x < -6) s.x += w + 12;
      if (s.y < -6) s.y += h + 12;
      ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph));
      const z = 6 * s.s;
      ctx.drawImage(this.star as CanvasImageSource, s.x - z / 2, s.y - z / 2, z, z);
    }
    /* Now and then a star falls across it. */
    if (!this.shooting && t > this.nextShooting) {
      const a = between(this.r, 0.35, 0.65);
      const v = between(this.r, 650, 1000);
      this.shooting = { x: between(this.r, 0.25, 1.05) * w, y: between(this.r, -0.05, 0.35) * h, vx: -Math.cos(a) * v, vy: Math.sin(a) * v, t0: t, life: between(this.r, 0.7, 1.1) };
      this.nextShooting = t + between(this.r, 5, 11);
    }
    if (this.shooting) {
      const s = this.shooting;
      const k = (t - s.t0) / s.life;
      if (k >= 1) this.shooting = null;
      else {
        s.x += s.vx * dt; s.y += s.vy * dt;
        const tail = 0.16;
        const tx = s.x - s.vx * tail, ty = s.y - s.vy * tail;
        const fade = Math.sin(k * Math.PI);
        const g = ctx.createLinearGradient(s.x, s.y, tx, ty);
        g.addColorStop(0, `rgba(240,240,255,${0.9 * fade})`);
        g.addColorStop(1, "rgba(160,140,255,0)");
        ctx.globalAlpha = 1;
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.8;
        ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.globalAlpha = fade;
        ctx.drawImage(this.star as CanvasImageSource, s.x - 7, s.y - 7, 14, 14);
      }
    }
    ctx.restore();
    if (this.heart) {
      /* The heart breathes light. */
      const hx = this.heart.x, hy = this.heart.y;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.6);
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, this.heart.len * 0.9);
      g.addColorStop(0, `rgba(170,150,255,${0.18 + 0.1 * pulse})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      this.drawShard(ctx, this.heart, t);
    }
    for (const s of this.shards) this.drawShard(ctx, s, t);
  }
  overlay(ctx: Ctx, t: number, dt: number) {
    ctx.clearRect(0, 0, this.w, this.h);
    this.bursts.draw(ctx, t, dt, this.w, this.h);
  }
  burst(x: number, y: number, t: number) { this.bursts.burst(x, y, t); }
  ignite(t: number) { this.bursts.ignite(this.w / 2, this.h / 2, t); }
}

/* ── ember ─────────────────────────────────────────────────────────────── */

/** The fire is simulated, not drawn: a field of heat a quarter of the wall
 *  wide, fed along its foot each frame and carried upward cooling, a cell at a
 *  time — the old demo-scene fire, given a wind and a palette. Drawn at that
 *  size and scaled up it is soft for free; drawn a second time, a little
 *  larger and added on top, it glows. Lyss on the first cut, which stamped
 *  teardrop sprites along the bottom: "the flames at the bottom need to look
 *  much better" — a shape that only flickers in size is a drawing of fire,
 *  where heat that moves is fire. */
class Ember implements Field {
  w = 0; h = 0;
  embers: { x: number; y: number; vy: number; drift: number; ph: number; s: number; fl: number; hue: number }[] = [];
  streaks: { x: number; y: number; vx: number; vy: number; t0: number }[] = [];
  dots: Sprite[];
  beam: Sprite;
  bursts: Bursts;
  nextStreak = 0.4;
  /* The heat field, its size, the canvas it is painted into, and the palette. */
  fw = 0; fh = 0;
  heat = new Float32Array(0);
  buf: Sprite | null = null;
  img: ImageData | null = null;
  palette = new Uint8ClampedArray(256 * 4);
  feed = new Float32Array(0);
  wind = 0;
  constructor(private r: Rng, private make: MakeCanvas) {
    this.dots = [
      glowSprite(make, 8, "rgba(255,200,80,0.95)", 0.25),
      glowSprite(make, 8, "rgba(255,130,30,0.95)", 0.22),
      glowSprite(make, 8, "rgba(255,70,20,0.9)", 0.2),
    ];
    this.beam = beamSprite(make, "255,150,60");
    this.bursts = new Bursts(r, glowSprite(make, 10, "rgba(255,180,70,0.95)"), "#ffd98a");
    /* Heat to colour: nothing, smouldering red, red, orange, gold, white-hot.
       Alpha rises with heat, so the cool top of a flame dissolves into the
       wall rather than stopping at an edge. */
    const stops: [number, number, number, number, number][] = [
      [0, 0, 0, 0, 0],
      [0.12, 70, 6, 2, 0],
      [0.3, 170, 28, 6, 150],
      [0.5, 235, 80, 14, 220],
      [0.68, 255, 150, 36, 245],
      [0.85, 255, 214, 110, 255],
      [1, 255, 250, 225, 255],
    ];
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let k = 0;
      while (k < stops.length - 2 && v > stops[k + 1]![0]) k++;
      const a = stops[k]!, b = stops[k + 1]!;
      const f = (v - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 4; c++) this.palette[i * 4 + c] = a[c + 1]! + (b[c + 1]! - a[c + 1]!) * f;
    }
  }
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const r = this.r;
    const n = Math.round((w * h) / 6500);
    this.embers = Array.from({ length: n }, () => this.ember(r() * h));
    this.fw = Math.max(32, Math.ceil(w / 4));
    this.fh = Math.max(24, Math.ceil((h * 0.42) / 4));
    this.heat = new Float32Array(this.fw * this.fh);
    this.feed = new Float32Array(this.fw);
    this.buf = this.make(this.fw, this.fh);
    this.img = ctxOf(this.buf).createImageData(this.fw, this.fh);
  }
  ember(y: number) {
    const r = this.r;
    return { x: r() * this.w, y, vy: between(r, 24, 90), drift: between(r, 10, 40), ph: r() * TAU, s: between(r, 0.4, 1.6), fl: between(r, 6, 16), hue: Math.floor(r() * 3) };
  }
  /** One step of the fire. The foot is fed from a slowly wandering source so
   *  the fire has hot and cool stretches that move along it; each cell above
   *  takes the heat of the cells below it, drifted by the wind, less a little —
   *  which is the whole of how a flame rises, licks and dies. */
  burn(t: number) {
    const { fw, fh, heat, feed, r } = this;
    for (let x = 0; x < fw; x++) {
      /* Two slow waves and some noise: where the fire is fierce and where it
         is only embers, moving along the foot. */
      const wave = 0.55 + 0.25 * Math.sin(x * 0.045 + t * 0.6) + 0.2 * Math.sin(x * 0.11 - t * 1.1);
      feed[x] = feed[x]! * 0.6 + 0.4 * Math.min(1, wave * (0.75 + 0.45 * r()));
      heat[(fh - 1) * fw + x] = feed[x]!;
    }
    this.wind = 0.7 * this.wind + 0.3 * (Math.sin(t * 0.37) * 0.6 + (r() - 0.5) * 0.8);
    const lift = 1.6 / fh;
    for (let y = 0; y < fh - 1; y++) {
      const row = y * fw, below = (y + 1) * fw, below2 = Math.min(fh - 1, y + 2) * fw;
      for (let x = 0; x < fw; x++) {
        const sx = Math.min(fw - 1, Math.max(0, Math.round(x + this.wind + (r() - 0.5) * 1.6)));
        const l = Math.max(0, sx - 1), rr = Math.min(fw - 1, sx + 1);
        const v = (heat[below + sx]! * 2 + heat[below + l]! + heat[below + rr]! + heat[below2 + sx]! * 2) / 6;
        heat[row + x] = Math.max(0, v - lift * (0.4 + r() * 1.3));
      }
    }
    const img = this.img!;
    const d = img.data, pal = this.palette;
    for (let i = 0; i < fw * fh; i++) {
      const p = Math.min(255, Math.floor(heat[i]! * 255)) * 4;
      const o = i * 4;
      d[o] = pal[p]!; d[o + 1] = pal[p + 1]!; d[o + 2] = pal[p + 2]!; d[o + 3] = pal[p + 3]!;
    }
    ctxOf(this.buf!).putImageData(img, 0, 0);
  }
  frame(ctx: Ctx, t: number, dt: number) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    /* The furnace's light, flickering on incommensurate beats so it never
       visibly loops. */
    const heat = 0.6 + 0.22 * Math.sin(t * 1.3) * Math.sin(t * 0.47 + 1) + 0.08 * Math.sin(t * 7.1);
    const g = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, h);
    g.addColorStop(0, `rgba(255,110,25,${0.42 * heat})`);
    g.addColorStop(0.45, `rgba(190,40,10,${0.18 * heat})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    /* Heat rising off it, as faint shafts. */
    for (let i = 0; i < 5; i++) {
      const x = w * (0.1 + i * 0.2) + Math.sin(t * 0.3 + i) * 30;
      drawBeam(ctx, this.beam, x, h + 20, Math.PI + Math.sin(t * 0.2 + i) * 0.05, h * 0.9, w * 0.14, 0.04 + 0.03 * Math.sin(t * 0.7 + i * 2));
    }
    ctx.restore();
    /* The fire itself: once at a quarter size and scaled, and once more, a
       little larger and added on top, for its glow. */
    this.burn(t);
    if (this.buf) {
      const fy = h - h * 0.42;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.globalAlpha = 0.95;
      ctx.drawImage(this.buf as CanvasImageSource, 0, fy, w, h * 0.42);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.35;
      ctx.drawImage(this.buf as CanvasImageSource, -w * 0.02, fy - h * 0.06, w * 1.04, h * 0.48);
      ctx.restore();
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i]!;
      e.y -= e.vy * dt;
      if (e.y < -10) this.embers[i] = this.ember(h + 10);
      const x = e.x + Math.sin(t * 0.9 + e.ph) * e.drift;
      /* Brighter low down, cooling as it rises. */
      const life = Math.max(0, Math.min(1, e.y / h));
      const flick = 0.55 + 0.45 * Math.sin(t * e.fl + e.ph);
      ctx.globalAlpha = (0.2 + 0.8 * life) * flick;
      const s = 10 * e.s * (0.6 + 0.6 * life);
      ctx.drawImage(this.dots[e.hue] as CanvasImageSource, x - s / 2, e.y - s / 2, s, s);
    }
    /* Gold sparks thrown up out of it. */
    if (t > this.nextStreak) {
      this.streaks.push({ x: this.r() * w, y: h - h * 0.12, vx: between(this.r, -80, 80), vy: -between(this.r, 420, 760), t0: t });
      this.nextStreak = t + between(this.r, 0.15, 0.9);
    }
    this.streaks = this.streaks.filter((s) => t - s.t0 < 1.5);
    ctx.lineCap = "round";
    for (const s of this.streaks) {
      s.vy += 180 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      ctx.globalAlpha = 1 - (t - s.t0) / 1.5;
      const tx = s.x - s.vx * 0.05, ty = s.y - s.vy * 0.05;
      const lg = ctx.createLinearGradient(s.x, s.y, tx, ty);
      lg.addColorStop(0, "rgba(255,240,180,0.95)");
      lg.addColorStop(1, "rgba(255,120,30,0)");
      ctx.strokeStyle = lg;
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tx, ty); ctx.stroke();
    }
    ctx.restore();
  }
  overlay(ctx: Ctx, t: number, dt: number) {
    ctx.clearRect(0, 0, this.w, this.h);
    this.bursts.draw(ctx, t, dt, this.w, this.h);
  }
  burst(x: number, y: number, t: number) { this.bursts.burst(x, y, t); }
  ignite(t: number) { this.bursts.ignite(this.w / 2, this.h * 0.8, t); }
}

/* ── eclipse ───────────────────────────────────────────────────────────── */

class Eclipse implements Field {
  w = 0; h = 0;
  feathers: { x: number; y: number; vy: number; sway: number; ph: number; rot: number; spin: number; s: number }[] = [];
  stars: { x: number; y: number; a: number }[] = [];
  feather: Sprite | null = null;
  streamers: Sprite | null = null;
  bolt: { pts: [number, number][]; branches: [number, number][][]; t0: number } | null = null;
  nextBolt = 4;
  bursts: Bursts;
  constructor(private r: Rng, private make: MakeCanvas) {
    this.bursts = new Bursts(r, glowSprite(make, 10, "rgba(255,255,255,0.95)"), "#ffffff");
  }
  get ring() {
    const R = Math.min(this.w, this.h) * 0.23;
    return { x: this.w * 0.78, y: this.h * 0.42, R };
  }
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const r = this.r;
    this.feathers = Array.from({ length: 18 }, () => ({
      x: r() * w, y: r() * h, vy: between(r, 10, 26), sway: between(r, 20, 60), ph: r() * TAU,
      rot: r() * TAU, spin: between(r, -0.6, 0.6), s: between(r, 0.5, 1.15),
    }));
    this.stars = Array.from({ length: Math.round((w * h) / 9000) }, () => ({ x: r() * w, y: r() * h, a: between(r, 0.08, 0.45) }));
    this.feather = this.featherSprite();
    this.streamers = this.streamerSprite();
  }
  featherSprite(): Sprite {
    const c = this.make(44, 128);
    const g = ctxOf(c);
    g.translate(22, 8);
    g.fillStyle = "rgba(240,240,240,0.5)";
    g.beginPath();
    g.moveTo(0, 4);
    g.bezierCurveTo(17, 22, 16, 74, 1, 102);
    g.bezierCurveTo(-15, 74, -16, 24, 0, 4);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.28)";
    g.lineWidth = 1;
    for (let i = 10; i < 98; i += 5) {
      g.beginPath(); g.moveTo(0.5, i); g.quadraticCurveTo(7, i - 3, 12, i - 9); g.stroke();
      g.beginPath(); g.moveTo(-0.5, i); g.quadraticCurveTo(-7, i - 3, -12, i - 9); g.stroke();
    }
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(3, 58, 0, 114); g.stroke();
    return c;
  }
  /** The corona's streamers, drawn once and turned slowly as a whole. */
  streamerSprite(): Sprite {
    const { R } = this.ring;
    const S = Math.ceil(R * 4.4);
    const c = this.make(S, S);
    const g = ctxOf(c);
    const m = S / 2;
    g.globalCompositeOperation = "lighter";
    const r = mulberry32(31);
    for (let i = 0; i < 46; i++) {
      const a = r() * TAU;
      const len = R * between(r, 0.45, 1.1);
      const wdt = between(r, 0.012, 0.06);
      const grad = g.createRadialGradient(m, m, R * 0.95, m, m, R + len);
      grad.addColorStop(0, `rgba(255,250,240,${between(r, 0.12, 0.3)})`);
      grad.addColorStop(1, "rgba(255,250,240,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(m + Math.cos(a - wdt) * R, m + Math.sin(a - wdt) * R);
      g.lineTo(m + Math.cos(a) * (R + len), m + Math.sin(a) * (R + len));
      g.lineTo(m + Math.cos(a + wdt) * R, m + Math.sin(a + wdt) * R);
      g.closePath();
      g.fill();
    }
    return c;
  }
  makeBolt(): Eclipse["bolt"] {
    const r = this.r;
    let x = between(r, 0.08, 0.92) * this.w, y = 0;
    const pts: [number, number][] = [[x, y]];
    const end = between(r, 0.45, 0.85) * this.h;
    const branches: [number, number][][] = [];
    while (y < end) {
      x += between(r, -38, 38);
      y += between(r, 18, 46);
      pts.push([x, y]);
      if (r() < 0.18) {
        let bx = x, by = y;
        const br: [number, number][] = [[bx, by]];
        for (let i = 0; i < 4; i++) { bx += between(r, -40, 40); by += between(r, 15, 35); br.push([bx, by]); }
        branches.push(br);
      }
    }
    return { pts, branches, t0: 0 };
  }
  frame(ctx: Ctx, t: number, dt: number) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const { x, y, R } = this.ring;
    const breathe = 0.5 + 0.5 * Math.sin(t * 0.55);
    ctx.save();
    ctx.fillStyle = "#fff";
    for (const s of this.stars) {
      ctx.globalAlpha = s.a;
      ctx.fillRect(s.x, s.y, 1, 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
    const bloom = ctx.createRadialGradient(x, y, R * 0.9, x, y, R * (2.6 + 0.3 * breathe));
    bloom.addColorStop(0, `rgba(255,248,235,${0.34 + 0.1 * breathe})`);
    bloom.addColorStop(0.25, `rgba(255,240,220,${0.1 + 0.04 * breathe})`);
    bloom.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, w, h);
    if (this.streamers) {
      const S = sizeOf(this.streamers).w;
      for (const [dir, a] of [[1, 0.95], [-0.6, 0.55]] as const) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(t * 0.012 * dir);
        ctx.globalAlpha = a * (0.75 + 0.25 * breathe);
        ctx.drawImage(this.streamers as CanvasImageSource, -S / 2, -S / 2);
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    for (const [lw, a] of [[14, 0.06], [5, 0.3], [1.8, 0.95]] as const) {
      ctx.strokeStyle = `rgba(255,252,245,${a * (0.85 + 0.15 * breathe)})`;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, R + 1, 0, TAU); ctx.stroke();
    }
    /* A bead of light running round the rim — the diamond ring. */
    const bead = t * 0.25;
    const bx = x + Math.cos(bead) * (R + 1), by = y + Math.sin(bead) * (R + 1);
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, R * 0.35);
    bg.addColorStop(0, "rgba(255,255,255,0.9)");
    bg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(bx - R * 0.35, by - R * 0.35, R * 0.7, R * 0.7);
    ctx.restore();
    if (this.feather) {
      ctx.save();
      for (const f of this.feathers) {
        f.y += f.vy * dt;
        f.rot += f.spin * dt;
        if (f.y > h + 70) { f.y = -70; f.x = this.r() * w; }
        const fx = f.x + Math.sin(t * 0.6 + f.ph) * f.sway;
        ctx.save();
        ctx.translate(fx, f.y);
        ctx.rotate(f.rot + Math.sin(t * 0.8 + f.ph) * 0.4);
        ctx.scale(f.s, f.s);
        ctx.globalAlpha = 0.6;
        ctx.drawImage(this.feather as CanvasImageSource, -22, -64);
        ctx.restore();
      }
      ctx.restore();
    }
    if (t > this.nextBolt) {
      this.bolt = this.makeBolt();
      this.bolt!.t0 = t;
      this.nextBolt = t + between(this.r, 7, 13);
    }
    if (this.bolt) {
      const k = (t - this.bolt.t0) / 0.45;
      if (k >= 1) this.bolt = null;
      else {
        /* Two strokes of light, the second a beat behind — lightning flickers. */
        const on = k < 0.22 || (k > 0.38 && k < 0.6) ? 1 : 0.2;
        const a = (1 - k) * on;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255,255,255,${0.12 * a})`;
        ctx.fillRect(0, 0, w, h);
        ctx.lineJoin = "round";
        for (const [lw, al] of [[12, 0.1], [4, 0.4], [1.5, 1]] as const) {
          ctx.strokeStyle = `rgba(255,255,255,${al * a})`;
          ctx.lineWidth = lw;
          for (const path of [this.bolt.pts, ...this.bolt.branches]) {
            ctx.beginPath();
            ctx.moveTo(path[0]![0], path[0]![1]);
            for (const p of path.slice(1)) ctx.lineTo(p[0], p[1]);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  }
  overlay(ctx: Ctx, t: number, dt: number) {
    ctx.clearRect(0, 0, this.w, this.h);
    this.bursts.draw(ctx, t, dt, this.w, this.h);
  }
  burst(x: number, y: number, t: number) { this.bursts.burst(x, y, t); }
  ignite(t: number) {
    const { x, y } = this.ring;
    this.bursts.ignite(x, y, t);
    this.nextBolt = t + 0.35;
  }
}

/* ── abyss ─────────────────────────────────────────────────────────────── */

class Abyss implements Field {
  w = 0; h = 0;
  bubbles: { x: number; y: number; vy: number; r: number; ph: number }[] = [];
  motes: { x: number; y: number; vx: number; vy: number; ph: number }[] = [];
  bubble: Sprite;
  mote: Sprite;
  beam: Sprite;
  caustic: Sprite | null = null;
  bursts: Bursts;
  constructor(private r: Rng, private make: MakeCanvas) {
    this.bubble = this.bubbleSprite();
    this.mote = glowSprite(make, 5, "rgba(140,210,255,0.85)", 0.3);
    this.beam = beamSprite(make, "150,215,255");
    this.bursts = new Bursts(r, glowSprite(make, 10, "rgba(120,200,255,0.95)"), "#c8ecff");
  }
  bubbleSprite(): Sprite {
    const c = this.make(32, 32);
    const g = ctxOf(c);
    const fill = g.createRadialGradient(16, 16, 8, 16, 16, 13);
    fill.addColorStop(0, "rgba(120,200,255,0)");
    fill.addColorStop(1, "rgba(150,215,255,0.25)");
    g.fillStyle = fill;
    g.beginPath(); g.arc(16, 16, 13, 0, TAU); g.fill();
    g.strokeStyle = "rgba(200,235,255,0.7)";
    g.lineWidth = 1.1;
    g.beginPath(); g.arc(16, 16, 13, 0, TAU); g.stroke();
    const hl = g.createRadialGradient(11, 10, 0, 11, 10, 6);
    hl.addColorStop(0, "rgba(255,255,255,0.95)");
    hl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = hl;
    g.beginPath(); g.arc(11, 10, 6, 0, TAU); g.fill();
    return c;
  }
  resize(w: number, h: number) {
    this.w = w; this.h = h;
    const r = this.r;
    this.bubbles = Array.from({ length: Math.round(w / 32) }, () => ({ x: r() * w, y: r() * h, vy: between(r, 14, 50), r: between(r, 2.5, 11), ph: r() * TAU }));
    this.motes = Array.from({ length: Math.round((w * h) / 9000) }, () => ({ x: r() * w, y: r() * h, vx: between(r, -6, 6), vy: between(r, -4, 3), ph: r() * TAU }));
    /* The caustics are drawn at a sixth of the size and scaled up — which is
       what makes them glow rather than read as lines. */
    this.caustic = this.make(Math.ceil(w / 6), Math.ceil((h * 0.6) / 6));
  }
  /** The surface's light, woven into a net: two families of waves crossing,
   *  drawn small. */
  drawCaustics(t: number) {
    const c = this.caustic;
    if (!c) return;
    const g = ctxOf(c);
    const { w: cw, h: ch } = sizeOf(c);
    g.clearRect(0, 0, cw, ch);
    g.globalCompositeOperation = "lighter";
    g.lineWidth = 1;
    for (const [fam, n, k1, k2, sp] of [[0, 11, 0.08, 0.17, 0.9], [1, 9, 0.11, 0.06, -0.7]] as const) {
      for (let i = 0; i < n; i++) {
        g.strokeStyle = `rgba(170,225,255,${0.16 + 0.08 * Math.sin(t * 0.8 + i + fam)})`;
        g.beginPath();
        for (let x = -4; x <= cw + 4; x += 2) {
          const base = ((i + 0.5) / n) * ch;
          const y = base + Math.sin(x * k1 + t * sp + i * 1.9) * 4 + Math.sin(x * k2 - t * sp * 0.7 + i) * 3;
          const yy = fam ? base + (y - base) * 1.2 + (x - cw / 2) * 0.12 : y;
          if (x === -4) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.stroke();
      }
    }
    /* Fading with depth, so the net has no edge — light from the surface
       thins out, it does not stop at a line. */
    g.globalCompositeOperation = "destination-in";
    const fade = g.createLinearGradient(0, 0, 0, ch);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.55, "rgba(0,0,0,0.55)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, cw, ch);
  }
  frame(ctx: Ctx, t: number, dt: number) {
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    /* Something vast, passing in the deep — a shape a shade darker than the
       water and a rim of light, once every minute or so. */
    const pass = (t % 64) / 64;
    const lx = -w * 0.6 + pass * w * 2.2, ly = h * 0.78 + Math.sin(t * 0.1) * 20;
    ctx.translate(lx, ly);
    ctx.scale(w / 1280, w / 1280);
    ctx.fillStyle = "rgba(0,4,10,0.45)";
    ctx.beginPath();
    ctx.moveTo(-420, 0);
    ctx.bezierCurveTo(-300, -95, 120, -120, 380, -30);
    ctx.bezierCurveTo(470, 0, 470, 20, 380, 40);
    ctx.bezierCurveTo(120, 110, -300, 90, -420, 0);
    ctx.moveTo(-400, 0);
    ctx.lineTo(-560, -80); ctx.lineTo(-520, 0); ctx.lineTo(-560, 80); ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(110,190,255,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-300, -82); ctx.bezierCurveTo(-60, -125, 200, -100, 380, -30); ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    /* Light from a surface far above, swaying with it. */
    for (let i = 0; i < 7; i++) {
      const sway = Math.sin(t * 0.17 + i * 1.3) * 0.06;
      const a = 0.07 + 0.06 * (0.5 + 0.5 * Math.sin(t * 0.31 + i * 2.1));
      drawBeam(ctx, this.beam, w * (0.04 + i * 0.15), -30, -0.18 + sway + i * 0.03, h * 1.25, w * (0.06 + 0.05 * ((i * 7) % 3) / 2), a);
    }
    this.drawCaustics(t);
    if (this.caustic) {
      ctx.globalAlpha = 0.9;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.caustic as CanvasImageSource, 0, 0, w, h * 0.6);
    }
    /* A glow rising from far below, slow as breathing. */
    const deep = ctx.createRadialGradient(w * 0.5, h * 1.25, 0, w * 0.5, h * 1.25, h * 0.85);
    deep.addColorStop(0, `rgba(40,120,255,${0.16 + 0.08 * Math.sin(t * 0.4)})`);
    deep.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = deep;
    ctx.fillRect(0, 0, w, h);
    for (const m of this.motes) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.x < -5) m.x = w + 5; if (m.x > w + 5) m.x = -5;
      if (m.y < -5) m.y = h + 5; if (m.y > h + 5) m.y = -5;
      ctx.globalAlpha = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.4 + m.ph));
      ctx.drawImage(this.mote as CanvasImageSource, m.x - 3, m.y - 3, 6, 6);
    }
    ctx.restore();
    ctx.save();
    for (const b of this.bubbles) {
      b.y -= b.vy * dt;
      if (b.y < -20) { b.y = h + 20; b.x = this.r() * w; }
      const x = b.x + Math.sin(t * 2 + b.ph) * 4;
      ctx.globalAlpha = 0.7;
      ctx.drawImage(this.bubble as CanvasImageSource, x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
    ctx.restore();
  }
  overlay(ctx: Ctx, t: number, dt: number) {
    ctx.clearRect(0, 0, this.w, this.h);
    this.bursts.draw(ctx, t, dt, this.w, this.h);
  }
  burst(x: number, y: number, t: number) { this.bursts.burst(x, y, t); }
  ignite(t: number) { this.bursts.ignite(this.w / 2, this.h * 0.3, t); }
}

/** The renderer for a look. `seed` makes the field the same wherever it is
 *  drawn; `make` is how sprites get a canvas. */
export function createField(look: LookId, make: MakeCanvas = domCanvas, seed = 1): Field {
  const r = mulberry32(seed);
  if (look === "ember") return new Ember(r, make);
  if (look === "eclipse") return new Eclipse(r, make);
  if (look === "abyss") return new Abyss(r, make);
  return new Crystal(r, make);
}
