/* The four things the wall does while you are out.
 *
 * `away.ts` is the catalogue and the rules; this is the drawing. Plain `.ts`
 * with no runes and no DOM beyond the context it is handed, so a piece is a
 * function of (size, time, hand) and nothing else — which is what lets the
 * physics be read, and in places tested, without a canvas.
 *
 * ## Every piece answers the hand
 *
 * This is the thing that makes an away screen worth having rather than a
 * screensaver, and it came from Lyss directly: *"imagine we're showing a ball
 * bouncing from one edge to another, clicking could bounce it back or send it
 * in another random direction, grabbing and holding would allow to seize it and
 * move it, and then release it with a flick to give it momentum"*. So the three
 * gestures are the same in all four pieces, and a piece that cannot answer one
 * of them answers it with something:
 *
 *   tap     — do something to the thing under the pointer
 *   hold    — seize it; it follows your hand exactly
 *   release — it keeps the speed your hand had (`away.ts::flick`)
 *
 * **Interacting does not end away mode.** The way back is the button or the
 * chord, and that is deliberate: a screen that fled the moment you touched it
 * could not be played with at all.
 *
 * ## Colour
 *
 * `env.hue` is `away.ts::hueAllowed` — true only where the wall is covered. A
 * piece must read it rather than assuming, and `tone` is the one place either
 * branch is written: given a position in the palette it answers a hue where one
 * is allowed and a mix of the theme's own two greys where it is not. Nothing
 * here imports `tokens.css` or names a status colour.
 */

import { flick, type PieceId, type Sample } from "./away";

export type RGB = [number, number, number];

export type Env = {
  /** CSS pixels. The context is already scaled by the device ratio. */
  w: number;
  h: number;
  /** Milliseconds since the piece started. */
  t: number;
  /** Milliseconds since the last frame, clamped by the caller — a tab that was
   *  backgrounded for an hour must not integrate an hour of physics in one
   *  step, which is a bird at the far end of the number line. */
  dt: number;
  hue: boolean;
  /** The ground this is drawn on — the wall's own `--well`, which is dark.
   *
   *  Named for what it *is* rather than for the token it comes from, and that
   *  is not fussiness: `--ink` is the darkest colour in the theme and `--paper`
   *  is the lightest, so a piece written against those names washes its frame
   *  with the foreground and draws its marks in the background. Both were
   *  wrong here once, and neither is visible in a type. */
  ground: RGB;
  /** What is drawn on it — `--paper`, the light one. */
  mark: RGB;
  faint: RGB;
};

export type Hand = {
  x: number;
  y: number;
  inside: boolean;
  down: boolean;
  /** True for the one frame after the pointer went down. */
  pressed: boolean;
  /** True for the one frame after it came up. */
  released: boolean;
  /** Where the pointer has just been, for `flick`. */
  trail: Sample[];
  /** Taps since the last frame. Consumed by the caller after `frame`. */
  taps: { x: number; y: number }[];
};

export type Piece2D = {
  kind: "2d";
  resize(env: Env): void;
  frame(g: CanvasRenderingContext2D, env: Env, hand: Hand): void;
};

export type PieceGL = {
  kind: "webgl2";
  resize(env: Env): void;
  frame(gl: WebGL2RenderingContext, env: Env, hand: Hand): void;
  dispose(gl: WebGL2RenderingContext): void;
};

export type Piece = Piece2D | PieceGL;

/* ── colour ───────────────────────────────────────────────────────────────── */

export function rgba(c: RGB, a: number): string {
  return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** One entry in a piece's palette, as a colour string.
 *
 *  `at` is a position in the palette, 0..1, and what it means depends on
 *  whether hue is allowed: a hue around a warm arc where the wall is covered,
 *  and a lightness between the theme's ink and paper where it is not. Both are
 *  the same call, so a piece is written once and reads correctly in either
 *  reading. The arc is deliberately short — amber through rose to violet,
 *  skipping the greens and reds that mean *working* and *failed* on the wall,
 *  so even the hue version never quotes a status colour at you. */
export function tone(env: Env, at: number, alpha = 1): string {
  const k = ((at % 1) + 1) % 1;
  if (!env.hue) {
    return rgba(mix(env.ground, env.mark, 0.3 + k * 0.65), alpha);
  }
  const h = 28 + k * 272;
  return `hsla(${h}, 62%, 62%, ${alpha})`;
}

/* ── shared helpers ───────────────────────────────────────────────────────── */

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** Wash the frame towards the ground colour.
 *
 *  Every 2D piece here leaves trails, and this is how: a translucent fill
 *  rather than a clear. `toys.md` learned the same thing one overlay over —
 *  feedback is most of how it looks, and without a sink the loop saturates. */
function wash(g: CanvasRenderingContext2D, env: Env, amount: number) {
  g.fillStyle = rgba(env.ground, amount);
  g.fillRect(0, 0, env.w, env.h);
}

/** Nothing in a piece may leave the universe.
 *
 *  Every piece integrates a velocity that a throw can set, and a throw is a
 *  division by a time difference. `flick` clamps and refuses to divide by zero,
 *  but this is the backstop that makes the claim true of the *state* rather
 *  than of one function: a NaN that reaches a position is a thing that is gone
 *  for the rest of the night, on a screen nobody is watching, so it is still
 *  gone in the morning. */
function sane(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

/* ── flock ────────────────────────────────────────────────────────────────── */

type Bird = { x: number; y: number; vx: number; vy: number };

/** Birds, flocking. The house piece, and the one the app is named after — a
 *  volery is a flock of birds in flight.
 *
 *  Boids, with the three classic rules and two additions that are about the
 *  hand rather than about birds: the pointer is a soft repulsor while it hovers
 *  (so the flock parts around you), and a seized bird is a *leader* — cohesion
 *  still pulls the others towards it, so carrying one drags the flock across
 *  the screen behind your hand. That second one is the whole reason this piece
 *  is worth touching, and it is four lines. */
function flockPiece(): Piece2D {
  let birds: Bird[] = [];
  let held: number | null = null;

  const SEE = 58;
  const NEAR = 18;
  const SPEED = 92;

  return {
    kind: "2d",
    resize(env) {
      const want = Math.max(40, Math.min(150, Math.round((env.w * env.h) / 14000)));
      birds = Array.from({ length: want }, () => ({
        x: rand(0, env.w),
        y: rand(0, env.h),
        vx: rand(-SPEED, SPEED),
        vy: rand(-SPEED, SPEED),
      }));
      held = null;
    },
    frame(g, env, hand) {
      const dt = Math.min(env.dt, 50) / 1000;

      if (hand.pressed && hand.inside) {
        /* Seize the nearest, but only if it is close enough to have been aimed
           at — a grab that snaps something in from across the screen reads as
           the piece deciding for you. */
        let best = -1;
        let bestD = 46 * 46;
        birds.forEach((b, i) => {
          const d = (b.x - hand.x) ** 2 + (b.y - hand.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        held = best >= 0 ? best : null;
      }
      if (hand.released && held !== null) {
        const f = flick(hand.trail);
        const b = birds[held];
        if (b) {
          b.vx = sane(f.vx);
          b.vy = sane(f.vy);
        }
        held = null;
      }
      for (const tap of hand.taps) {
        /* Scatter. Not a uniform shove: nearer birds get more of it, so a click
           reads as something happening *there* rather than everywhere. */
        for (const b of birds) {
          const dx = b.x - tap.x;
          const dy = b.y - tap.y;
          const d = Math.hypot(dx, dy) || 1;
          const push = Math.max(0, 1 - d / 260) * 420;
          b.vx += (dx / d) * push;
          b.vy += (dy / d) * push;
        }
      }

      for (let i = 0; i < birds.length; i++) {
        const b = birds[i];
        if (i === held) {
          b.x = hand.x;
          b.y = hand.y;
          continue;
        }
        let ax = 0;
        let ay = 0;
        let cx = 0;
        let cy = 0;
        let mx = 0;
        let my = 0;
        let n = 0;
        for (let j = 0; j < birds.length; j++) {
          if (j === i) continue;
          const o = birds[j];
          const dx = o.x - b.x;
          const dy = o.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > SEE * SEE) continue;
          n++;
          cx += o.x;
          cy += o.y;
          mx += o.vx;
          my += o.vy;
          if (d2 < NEAR * NEAR) {
            const d = Math.sqrt(d2) || 1;
            ax -= (dx / d) * (1 - d / NEAR) * 240;
            ay -= (dy / d) * (1 - d / NEAR) * 240;
          }
        }
        if (n) {
          /* Cohesion pulls hardest towards a bird in your hand, which is what
             makes carrying one drag the flock. */
          const lead = held !== null ? birds[held] : null;
          const tx = lead ? (cx / n) * 0.45 + lead.x * 0.55 : cx / n;
          const ty = lead ? (cy / n) * 0.45 + lead.y * 0.55 : cy / n;
          ax += (tx - b.x) * 0.55;
          ay += (ty - b.y) * 0.55;
          ax += (mx / n - b.vx) * 0.9;
          ay += (my / n - b.vy) * 0.9;
        }
        if (hand.inside && !hand.down) {
          const dx = b.x - hand.x;
          const dy = b.y - hand.y;
          const d = Math.hypot(dx, dy) || 1;
          if (d < 120) {
            const push = (1 - d / 120) * 260;
            ax += (dx / d) * push;
            ay += (dy / d) * push;
          }
        }
        b.vx = sane(b.vx + ax * dt);
        b.vy = sane(b.vy + ay * dt);

        const sp = Math.hypot(b.vx, b.vy) || 1;
        const want = Math.min(Math.max(sp, SPEED * 0.6), SPEED * 3.4);
        b.vx = (b.vx / sp) * want;
        b.vy = (b.vy / sp) * want;

        b.x += b.vx * dt;
        b.y += b.vy * dt;
        /* Wrapped rather than bounced: a flock that hits a wall reads as being
           in a box, and the one thing this piece is about is open air. */
        if (b.x < -20) b.x = env.w + 20;
        if (b.x > env.w + 20) b.x = -20;
        if (b.y < -20) b.y = env.h + 20;
        if (b.y > env.h + 20) b.y = -20;
      }

      wash(g, env, 0.1);
      birds.forEach((b, i) => {
        const a = Math.atan2(b.vy, b.vx);
        const held_ = i === held;
        g.save();
        g.translate(b.x, b.y);
        g.rotate(a);
        g.fillStyle = held_
          ? tone(env, 0.08, 0.95)
          : tone(env, 0.52 + (i % 7) * 0.03, 0.72);
        g.beginPath();
        g.moveTo(7, 0);
        g.lineTo(-4, 3.2);
        g.lineTo(-2, 0);
        g.lineTo(-4, -3.2);
        g.closePath();
        g.fill();
        g.restore();
      });
    },
  };
}

/* ── orbs ─────────────────────────────────────────────────────────────────── */

type Orb = { x: number; y: number; vx: number; vy: number; r: number; k: number };

/** The bouncing one, which is the piece Lyss described in as many words.
 *
 *  Elastic against the walls and against each other, no gravity, a breath of
 *  drag so a night of flicks does not end with everything at terminal velocity.
 *  Shaded as spheres rather than drawn as discs — the light is fixed up and to
 *  the left, so they read as objects in a room rather than as circles, which is
 *  most of the difference between this and a screensaver from 1998. */
function orbsPiece(): Piece2D {
  let orbs: Orb[] = [];
  let held: number | null = null;

  return {
    kind: "2d",
    resize(env) {
      const want = Math.max(4, Math.min(11, Math.round(Math.min(env.w, env.h) / 160)));
      const base = Math.min(env.w, env.h);
      orbs = Array.from({ length: want }, (_, i) => ({
        x: rand(base * 0.12, env.w - base * 0.12),
        y: rand(base * 0.12, env.h - base * 0.12),
        vx: rand(-170, 170),
        vy: rand(-170, 170),
        r: rand(base * 0.028, base * 0.062),
        k: i / want,
      }));
      held = null;
    },
    frame(g, env, hand) {
      const dt = Math.min(env.dt, 50) / 1000;

      if (hand.pressed && hand.inside) {
        held = null;
        for (let i = 0; i < orbs.length; i++) {
          const o = orbs[i];
          if ((o.x - hand.x) ** 2 + (o.y - hand.y) ** 2 <= o.r * o.r) {
            held = i;
            break;
          }
        }
      }
      if (hand.released && held !== null) {
        const f = flick(hand.trail);
        const o = orbs[held];
        if (o) {
          o.vx = sane(f.vx);
          o.vy = sane(f.vy);
        }
        held = null;
      }
      for (const tap of hand.taps) {
        /* A tap that lands on an orb sends it somewhere new; a tap on empty
           space nudges whatever is nearest towards you, so clicking is never
           nothing. */
        let hit = -1;
        for (let i = 0; i < orbs.length; i++) {
          const o = orbs[i];
          if ((o.x - tap.x) ** 2 + (o.y - tap.y) ** 2 <= o.r * o.r) {
            hit = i;
            break;
          }
        }
        if (hit >= 0) {
          const a = rand(0, Math.PI * 2);
          const sp = rand(260, 560);
          orbs[hit].vx = Math.cos(a) * sp;
          orbs[hit].vy = Math.sin(a) * sp;
        } else {
          let best = -1;
          let bd = Infinity;
          orbs.forEach((o, i) => {
            const d = (o.x - tap.x) ** 2 + (o.y - tap.y) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          const o = orbs[best];
          if (o) {
            const dx = tap.x - o.x;
            const dy = tap.y - o.y;
            const d = Math.hypot(dx, dy) || 1;
            o.vx += (dx / d) * 300;
            o.vy += (dy / d) * 300;
          }
        }
      }

      for (let i = 0; i < orbs.length; i++) {
        const o = orbs[i];
        if (i === held) {
          o.x = hand.x;
          o.y = hand.y;
          o.vx = 0;
          o.vy = 0;
          continue;
        }
        o.vx = sane(o.vx) * (1 - 0.06 * dt);
        o.vy = sane(o.vy) * (1 - 0.06 * dt);
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        if (o.x - o.r < 0) {
          o.x = o.r;
          o.vx = Math.abs(o.vx);
        }
        if (o.x + o.r > env.w) {
          o.x = env.w - o.r;
          o.vx = -Math.abs(o.vx);
        }
        if (o.y - o.r < 0) {
          o.y = o.r;
          o.vy = Math.abs(o.vy);
        }
        if (o.y + o.r > env.h) {
          o.y = env.h - o.r;
          o.vy = -Math.abs(o.vy);
        }
      }

      /* Equal-mass elastic collision along the normal, which is the whole of
         what makes a handful of these satisfying rather than busy. */
      for (let i = 0; i < orbs.length; i++) {
        for (let j = i + 1; j < orbs.length; j++) {
          const a = orbs[i];
          const b = orbs[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          const min = a.r + b.r;
          if (d === 0 || d >= min) continue;
          const nx = dx / d;
          const ny = dy / d;
          const overlap = (min - d) / 2;
          if (i !== held) {
            a.x -= nx * overlap;
            a.y -= ny * overlap;
          }
          if (j !== held) {
            b.x += nx * overlap;
            b.y += ny * overlap;
          }
          const p = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (p <= 0) continue;
          if (i !== held) {
            a.vx -= p * nx;
            a.vy -= p * ny;
          }
          if (j !== held) {
            b.vx += p * nx;
            b.vy += p * ny;
          }
        }
      }

      wash(g, env, 0.16);
      orbs.forEach((o, i) => {
        const lit = o.r * 0.38;
        const grad = g.createRadialGradient(
          o.x - lit,
          o.y - lit,
          o.r * 0.08,
          o.x,
          o.y,
          o.r,
        );
        grad.addColorStop(0, tone(env, o.k + 0.04, 0.98));
        grad.addColorStop(0.55, tone(env, o.k, 0.9));
        grad.addColorStop(1, rgba(env.ground, env.hue ? 0.55 : 0.4));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        g.fill();
        if (i === held) {
          g.strokeStyle = rgba(env.mark, 0.75);
          g.lineWidth = 1.5;
          g.stroke();
        }
      });
    },
  };
}

/* ── lanterns ─────────────────────────────────────────────────────────────── */

type Lantern = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  lit: boolean;
  sway: number;
  k: number;
};

/** The cute one. Paper lanterns going up, swaying, guttering out.
 *
 *  The sway is a sine on the lantern's own phase rather than noise, because
 *  what it has to read as is *light things in still air* — a lantern that
 *  wandered would read as being blown about, which is a different and much
 *  busier picture. Tapping a lit one puts it out and it sinks; tapping a dark
 *  one relights it and it climbs. That is the whole interaction and it is
 *  enough: the pleasure is in a screen that answers. */
function lanternsPiece(): Piece2D {
  let lanterns: Lantern[] = [];
  let held: number | null = null;

  function born(env: Env, k: number, below = true): Lantern {
    const r = rand(9, 20);
    return {
      x: rand(r, env.w - r),
      y: below ? env.h + rand(10, env.h * 0.8) : rand(0, env.h),
      vx: 0,
      vy: rand(-26, -13),
      r,
      lit: Math.random() > 0.18,
      sway: rand(0, Math.PI * 2),
      k,
    };
  }

  return {
    kind: "2d",
    resize(env) {
      const want = Math.max(8, Math.min(34, Math.round((env.w * env.h) / 52000)));
      lanterns = Array.from({ length: want }, (_, i) => born(env, i / want, false));
      held = null;
    },
    frame(g, env, hand) {
      const dt = Math.min(env.dt, 50) / 1000;

      if (hand.pressed && hand.inside) {
        held = null;
        for (let i = 0; i < lanterns.length; i++) {
          const l = lanterns[i];
          const rr = (l.r + 10) ** 2;
          if ((l.x - hand.x) ** 2 + (l.y - hand.y) ** 2 <= rr) {
            held = i;
            break;
          }
        }
      }
      if (hand.released && held !== null) {
        const f = flick(hand.trail);
        const l = lanterns[held];
        if (l) {
          /* A lantern is paper. It takes a fraction of the throw and loses it
             fast, which is the difference between carrying one and bowling it. */
          l.vx = sane(f.vx) * 0.35;
          l.vy = sane(f.vy) * 0.35;
        }
        held = null;
      }
      for (const tap of hand.taps) {
        for (const l of lanterns) {
          if ((l.x - tap.x) ** 2 + (l.y - tap.y) ** 2 <= (l.r + 12) ** 2) {
            l.lit = !l.lit;
            l.vy = l.lit ? -rand(16, 34) : rand(10, 26);
            break;
          }
        }
      }

      for (let i = 0; i < lanterns.length; i++) {
        const l = lanterns[i];
        if (i === held) {
          l.x = hand.x;
          l.y = hand.y;
          continue;
        }
        l.sway += dt * 0.7;
        const want = l.lit ? -rand(17, 19) : 22;
        l.vy = sane(l.vy) + (want - l.vy) * Math.min(1, dt * 0.55);
        l.vx = sane(l.vx) * (1 - Math.min(1, dt * 1.4));
        l.x += (l.vx + Math.sin(l.sway) * 7) * dt;
        l.y += l.vy * dt;
        if (l.y < -l.r * 4 || l.y > env.h + l.r * 6) lanterns[i] = born(env, l.k);
      }

      wash(g, env, 0.13);
      lanterns.forEach((l, i) => {
        if (l.lit) {
          const glow = g.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r * 4.2);
          glow.addColorStop(0, tone(env, 0.06 + l.k * 0.06, 0.3));
          glow.addColorStop(1, tone(env, 0.06, 0));
          g.fillStyle = glow;
          g.beginPath();
          g.arc(l.x, l.y, l.r * 4.2, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = l.lit
          ? tone(env, 0.04 + l.k * 0.05, 0.92)
          : rgba(mix(env.ground, env.mark, 0.45), 0.5);
        g.beginPath();
        g.ellipse(l.x, l.y, l.r * 0.8, l.r, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = rgba(env.mark, 0.22);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(l.x, l.y - l.r);
        g.lineTo(l.x, l.y + l.r);
        g.stroke();
        if (i === held) {
          g.strokeStyle = rgba(env.mark, 0.8);
          g.beginPath();
          g.ellipse(l.x, l.y, l.r * 0.8 + 3, l.r + 3, 0, 0, Math.PI * 2);
          g.stroke();
        }
      });
    },
  };
}

/* ── tide ─────────────────────────────────────────────────────────────────── */

const TIDE_VERT = `#version 300 es
/* A single triangle larger than the screen, built from gl_VertexID — no buffer,
   no attribute, nothing to bind. Two triangles would seam along the diagonal
   under a derivative-based effect; this one has no interior edge at all. */
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const TIDE_FRAG = `#version 300 es
precision highp float;
out vec4 frag;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uHand;   // x, y in pixels; z is 1 while held down
uniform float uHue;
uniform vec3 uGround;
uniform vec3 uMark;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}

vec3 hue(float h) {
  /* The same short arc tone() uses — amber through rose to violet, no green
     and no red, so the decorative palette never quotes a status colour. */
  float a = radians(28.0 + h * 272.0);
  vec3 k = vec3(cos(a), cos(a - 2.094), cos(a + 2.094));
  return clamp(0.62 + 0.3 * k, 0.0, 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * 0.045;

  /* The hand bends the field: a smooth well around the pointer that deepens
     while it is held. Warping the *domain* rather than tinting the result is
     what makes it read as the surface being pulled rather than lit. */
  vec2 h = (uHand.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  vec2 d = p - h;
  float pull = exp(-dot(d, d) * (uHand.z > 0.5 ? 5.0 : 11.0)) * (uHand.z > 0.5 ? 0.42 : 0.2);
  vec2 q = p - normalize(d + 1e-6) * pull;

  float a = fbm(q * 2.4 + vec2(t, -t * 0.7));
  float b = fbm(q * 2.4 + vec2(a * 1.9 + t * 0.5, a * 1.4 - t * 0.3));
  float c = fbm(q * 3.1 + vec2(b * 2.2, b * 1.7 - t));

  float band = smoothstep(0.32, 0.78, b * 0.7 + c * 0.45);
  vec3 grey = mix(uGround, uMark, 0.16 + band * 0.6);
  vec3 col = mix(grey, hue(fract(b * 0.8 + c * 0.35 + 0.1)), uHue * 0.72);

  /* A vignette towards the ground colour, so the piece sits in the window
     rather than being cut off by it. */
  float vig = smoothstep(1.25, 0.25, length(uv - 0.5) * 1.6);
  frag = vec4(mix(uGround, col, vig), 1.0);
}`;

/** The artistic one, and the only piece here that is a shader.
 *
 *  A domain-warped fbm: three octave stacks, each fed the one before it, which
 *  is the cheapest way to get something that looks like it has weather in it.
 *  The hand warps the domain rather than tinting the result — the difference
 *  between the surface being *pulled* and the surface being lit, and it is the
 *  reason this is worth touching.
 *
 *  Everything a shader needs is rebuilt on `resize` rather than held across
 *  one, because the context goes with the canvas when the piece changes. */
function tidePiece(): PieceGL {
  let prog: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let u: Record<string, WebGLUniformLocation | null> = {};
  let built: WebGL2RenderingContext | null = null;

  function build(gl: WebGL2RenderingContext) {
    const compile = (kind: number, src: string) => {
      const sh = gl.createShader(kind)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, TIDE_VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, TIDE_FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      /* A shader that will not link is a black screen with nothing to say, and
         this one runs where nobody is watching — so it fails loudly into the
         console and the component draws its own fallback. */
      console.error("away: tide did not link —", gl.getProgramInfoLog(p));
      return;
    }
    prog = p;
    vao = gl.createVertexArray();
    u = {
      res: gl.getUniformLocation(p, "uRes"),
      time: gl.getUniformLocation(p, "uTime"),
      hand: gl.getUniformLocation(p, "uHand"),
      hue: gl.getUniformLocation(p, "uHue"),
      ground: gl.getUniformLocation(p, "uGround"),
      mark: gl.getUniformLocation(p, "uMark"),
    };
    built = gl;
  }

  return {
    kind: "webgl2",
    resize() {
      /* Nothing: the only size the shader knows is a uniform, set every frame.
         A piece whose resize is empty is still required to have one — the
         contract is what lets the component treat all four the same. */
    },
    frame(gl, env, hand) {
      if (built !== gl) build(gl);
      if (!prog) return;
      const dpr = gl.drawingBufferWidth / Math.max(1, env.w);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform2f(u.res!, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(u.time!, env.t / 1000);
      /* Y is flipped: the page counts down from the top and `gl_FragCoord` up
         from the bottom, so a hand not flipped here pulls the field at the
         mirror of where the pointer is — which looks like a bug in the physics
         rather than in a coordinate system. */
      gl.uniform3f(
        u.hand!,
        hand.x * dpr,
        gl.drawingBufferHeight - hand.y * dpr,
        hand.down ? 1 : 0,
      );
      gl.uniform1f(u.hue!, env.hue ? 1 : 0);
      gl.uniform3f(
        u.ground!,
        env.ground[0] / 255,
        env.ground[1] / 255,
        env.ground[2] / 255,
      );
      gl.uniform3f(u.mark!, env.mark[0] / 255, env.mark[1] / 255, env.mark[2] / 255);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose(gl) {
      if (prog) gl.deleteProgram(prog);
      if (vao) gl.deleteVertexArray(vao);
      prog = null;
      vao = null;
      built = null;
    },
  };
}

/* ── the catalogue's other half ───────────────────────────────────────────── */

export function makePiece(id: PieceId): Piece {
  switch (id) {
    case "orbs":
      return orbsPiece();
    case "lanterns":
      return lanternsPiece();
    case "tide":
      return tidePiece();
    case "flock":
    default:
      return flockPiece();
  }
}
