/* A strand: the light that runs between two cards while a message is on its way.
 *
 * The thing being avoided is a wire. A line drawn between two cards says they
 * are connected, which is a claim about the wall that is not true — nothing
 * connects two cards, and a message is an event rather than a relationship. So
 * a strand exists only while something is travelling on it: the route fades in
 * behind the first pulse, the pulses run, the light drains into the recipient
 * and the wall is two cards again. Nothing persists, and there is nothing to
 * clear away.
 *
 * Everything here is pure and in **screen pixels**. That is deliberate twice
 * over. Once because both endpoints have to be reachable — a card on the wall
 * and a card stuck to the glass are in different frames, and screen space is
 * the only one they share (`glass.ts` makes the same argument from the other
 * side). And once because a strand is a fact about the wall rather than about a
 * card: zooming out to see the whole studio is exactly when you most want to
 * see who is talking to whom, and a width that scaled with the zoom would turn
 * it into a hairline at the moment it became useful.
 *
 * `Flow.svelte` draws what this returns and decides nothing.
 */

import { hexRgb, mix, rgba, type Rgb } from "./ambience";

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
/** Where the wall is being looked at from — `Studio`'s viewport, structurally.
 *  The same shape `glass.ts::View` takes, and for the same reason. */
export type View = { x: number; y: number; scale: number };

/* ── the clock ────────────────────────────────────────────────────────────
 *
 * Just under two seconds, and the *shape* of it is the part that had to be got
 * right. Three things happen in sequence and each has to finish before the
 * strand is taken down: the pulses cross, the route empties behind them, and
 * the rings open where the light landed.
 *
 * ```text
 *    0    depart      the ring that leaves the sender
 *    60   wake in     the route showing behind the first pulse
 *    1100 arrive      the first pulse lands; the rings begin
 *    1556 last pulse  the third has drained into the rim
 *    1800 wake out    the route is empty
 *    1900 gone        nothing on the wall
 * ```
 *
 * `FLIGHT_MS` is therefore derived from the slowest of the three rather than
 * chosen. It was picked by eye first, at 1400, and the second arrival ring was
 * still at a third of its alpha when the strand was retired — a landing that
 * finished by being switched off, which is exactly what the wake was shaped to
 * avoid one line above. Anything added here owes the same arithmetic.
 */

/** How long one pulse takes to cross. Arrival is therefore at `TRAVEL_MS`. */
export const TRAVEL_MS = 1100;
export const PULSES = 3;
export const PULSE_STAGGER_MS = 140;
/** How much of the curve one pulse occupies, as a fraction of its length. */
export const PULSE_SPAN = 0.16;
export const DEPART_MS = 120;
/** How long the rings at the recipient take, and how far the second lags. */
export const ARRIVE_MS = 700;
const ARRIVE_LAG_MS = 90;
/** When the route has finished emptying, and over how long it does it. */
const WAKE_OUT_AT = 1500;
const WAKE_OUT_MS = 300;

/* ── the two filaments ────────────────────────────────────────────────────
 *
 * A strand is not a line. It is two, and the app is called Skein for a reason:
 * a skein is threads twisted together, and one stroke between two cards reads
 * as a cable where two reads as something alive.
 *
 * They share a curve and disagree about everything else. Each is laterally
 * displaced from the shared route by `weaveAt` — a sine along the curve, in
 * exact antiphase between the two — so they braid, cross at the nodes, and meet
 * again at both cards. And each runs on its own clock: the second is nine per
 * cent slower, sets off seventy milliseconds late, draws a longer and fainter
 * pulse, and takes the unlifted tone. So the pair never travels as a unit — one
 * leads, the other laps into it at a crossing, and which is in front changes as
 * they go.
 *
 * The amplitude tapers to nothing at both ends (`WEAVE_AMP` is a mid-curve
 * figure), which is not decoration: both filaments have to *land on the cards*.
 * A braid that kept its width to the end would arrive as two lines striking
 * either side of a card it was supposed to be reaching.
 */

export type Filament = {
  /** Multiplier on `TRAVEL_MS`. */
  travel: number;
  /** A head start, or in the second's case a late one, in milliseconds. */
  stagger: number;
  /** Multiplier on `PULSE_SPAN` — a slower thread draws a longer smear. */
  span: number;
  /** Multiplier on the drawn width. */
  width: number;
  /** Where this thread is in the braid. A half turn apart is what makes them
   *  cross rather than run beside each other. */
  phase: number;
  /** Multiplier on alpha, so the pair reads as one strand with a bright thread
   *  in it rather than as two strands somebody drew twice. */
  alpha: number;
};

export const FILAMENTS: Filament[] = [
  { travel: 1, stagger: 0, span: 1, width: 1, phase: 0, alpha: 1 },
  { travel: 1.09, stagger: 70, span: 1.25, width: 0.72, phase: Math.PI, alpha: 0.78 },
];

/** How many half-turns of the braid fit along one strand. Not an integer on
 *  purpose: a whole number of turns makes both ends of every strand look the
 *  same, which is a pattern rather than a thing that happened. */
export const TWISTS = 1.5;
/** How far apart the threads get at the middle of the curve, in screen pixels. */
export const WEAVE_AMP = 9;
/** How fast the braid itself turns, in radians per millisecond. Small: this is
 *  the difference between a rope and a rope being paid out. */
export const WEAVE_DRIFT = 0.0011;

export const FLIGHT_MS = Math.max(
  TRAVEL_MS + ARRIVE_LAG_MS + ARRIVE_MS,
  WAKE_OUT_AT + WAKE_OUT_MS,
  ...FILAMENTS.map(
    (f) =>
      TRAVEL_MS * f.travel +
      f.stagger +
      (PULSES - 1) * PULSE_STAGGER_MS +
      PULSE_SPAN * f.span * TRAVEL_MS * f.travel,
  ),
);

/** How many strands may be in the air at once.
 *
 *  A broadcast to a wall of twenty is twenty strands in the same tick, each
 *  sampling a curve every frame. The oldest are retired early rather than the
 *  newest refused: what you have already seen leaving matters less than what is
 *  leaving now, and a cap that dropped the new ones would make a big broadcast
 *  look like a small one. */
export const MAX_STRANDS = 12;

/* ── the curve ────────────────────────────────────────────────────────────── */

/** Where a wall box lands on screen. `glass.ts` does this arithmetic for the
 *  other direction; a card already on the glass is in these units already. */
export function screenBox(box: Box, view: View): Box {
  return {
    x: view.x + box.x * view.scale,
    y: view.y + box.y * view.scale,
    w: box.w * view.scale,
    h: box.h * view.scale,
  };
}

export function centreOf(box: Box): Pt {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Where the line from this box's centre towards `to` leaves the box.
 *
 *  Strands start and end at a card's rim rather than at its middle, so the light
 *  never crosses the card's own title — the one thing on it you might have been
 *  reading when the message arrived. `gap` holds it a little clear of the edge,
 *  which is what stops a bright pulse from looking like a border. */
export function rimPoint(box: Box, to: Pt, gap = 4): Pt {
  const c = centreOf(box);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = box.w / 2;
  const hh = box.h / 2;
  /* The smaller of the two crossings is the edge actually hit; a box with no
     extent is its own rim. */
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  const len = Math.hypot(dx, dy);
  const out = s + gap / len;
  return { x: c.x + dx * out, y: c.y + dy * out };
}

/** How far from `p` along `dir` you have to travel before a disc of radius `r`
 *  centred there lies wholly inside `box` — nought if it already does.
 *
 *  **The disc is the whole trick.** `lineage.ts` closes a limb with a flat chord
 *  and needs that chord *under* the card rather than lying on the ground beside
 *  it; a chord of half-length `r` sits inside the disc of radius `r` about its
 *  middle whatever angle it is at, so asking about the disc answers for every
 *  bearing at once and needs no trigonometry. It over-answers by at most the gap
 *  between a chord and its circle, and every pixel of the over-answer is buried,
 *  so it costs nothing to see.
 *
 *  Every answer is finite, because an infinity here would put a root's base
 *  somewhere on the far side of the wall. A `dir` that never gets there — or has
 *  no length at all, which is a degenerate curve whose direction means nothing —
 *  is nought, and the caller draws what it would have drawn anyway. A box too
 *  small to hold the disc on *both* axes seats at its own centre, which is as
 *  deep as that box goes; too small on only one, and the other axis is still
 *  worth answering exactly, since travelling further buries a stub for nothing. */
export function seatDepth(box: Box, p: Pt, dir: Pt, r: number): number {
  const dd = dir.x * dir.x + dir.y * dir.y;
  if (dd === 0) return 0;
  const c = centreOf(box);
  const qx = p.x - c.x;
  const qy = p.y - c.y;
  /* As deep as the box goes: where `dir` from `p` passes closest to the centre. */
  const centreward = Math.max(0, -(qx * dir.x + qy * dir.y) / dd);
  let lo = 0;
  let hi = Infinity;
  const axes: [number, number, number][] = [
    [qx, dir.x, Math.max(0, box.w / 2 - r)],
    [qy, dir.y, Math.max(0, box.h / 2 - r)],
  ];
  for (const [q, d, half] of axes) {
    if (d === 0) {
      if (Math.abs(q) > half) return centreward;
      continue;
    }
    const a1 = (-half - q) / d;
    const a2 = (half - q) / d;
    lo = Math.max(lo, Math.min(a1, a2));
    hi = Math.min(hi, Math.max(a1, a2));
  }
  return lo > hi ? centreward : lo;
}

/** How far the strand bows out of the straight line between two cards.
 *
 *  Proportional to the distance, so a strand across the wall arcs and one
 *  between neighbours barely does — a fixed bow makes short strands look like
 *  loops and long ones look straight.
 *
 *  The **sign is not chosen**: it falls out of the perpendicular of `a → b`, so
 *  a reply bows the other way from the message it answers. That is the whole of
 *  how direction is readable with no arrowhead anywhere on the wall, and it is
 *  why nothing here ever normalises the two endpoints into an order.
 *
 *  `fan` separates strands that would otherwise be drawn on top of each other —
 *  a second message to the same card before the first has landed. It only ever
 *  adds, never flips: an alternating sign would buy the separation by making
 *  half the strands lie about which way they were going. */
export function bowOf(a: Pt, b: Pt, fan = 0): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return clamp(len * 0.18, 24, 120) + fan * 14;
}

/** The two control points of the cubic, given how far it bows. */
export function controls(a: Pt, b: Pt, bow: number): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  /* Rotated a quarter turn from `a → b`. Which side that is depends on the
     direction of travel, which is the point — see `bowOf`. */
  const nx = -dy / len;
  const ny = dx / len;
  return [
    { x: a.x + dx / 3 + nx * bow, y: a.y + dy / 3 + ny * bow },
    { x: a.x + (dx * 2) / 3 + nx * bow, y: a.y + (dy * 2) / 3 + ny * bow },
  ];
}

export function pointOn(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: a.x * w0 + c1.x * w1 + c2.x * w2 + b.x * w3,
    y: a.y * w0 + c1.y * w1 + c2.y * w2 + b.y * w3,
  };
}

/** Which way the curve is going at `t`, normalised. Zero-length only for a
 *  degenerate curve, where the direction is meaningless anyway and the caller
 *  is displacing by zero. */
export function tangentOn(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  const x =
    3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x);
  const y =
    3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y);
  const len = Math.hypot(x, y);
  return len === 0 ? { x: 0, y: 0 } : { x: x / len, y: y / len };
}

/** How far one thread is off the shared route at `t`, in screen pixels.
 *
 *  A sine along the curve, tapered by another one so it is exactly zero at both
 *  cards — the two threads leave together, braid, and arrive together. The
 *  `age` term turns the braid slowly as the message travels, which is what
 *  stops the pattern reading as a texture painted on the wall.
 *
 *  Signed: the two filaments are a half turn apart, so wherever this is
 *  positive for one it is negative for the other, and every zero is a crossing.
 *  That is the whole mechanism, and it is why nothing here ever takes an
 *  absolute value. */
export function weaveAt(t: number, filament: number, age: number, amp = WEAVE_AMP): number {
  /* Pinned rather than left to the taper, which is `sin(pi)` at the far end and
     therefore 1.2e-16 rather than 0 — a third of a femtometre off the card, and
     an endpoint that is *nearly* the rim is an endpoint the next person has to
     write a tolerance around. The guarantee is worth stating in the code. */
  if (t <= 0 || t >= 1) return 0;
  const f = FILAMENTS[filament] ?? FILAMENTS[0];
  const taper = Math.sin(Math.PI * t);
  return (
    amp * taper * Math.sin(Math.PI * TWISTS * 2 * t + f.phase + age * WEAVE_DRIFT)
  );
}

/** Where one thread actually is: the shared curve, pushed sideways. */
export function filamentPoint(
  a: Pt,
  c1: Pt,
  c2: Pt,
  b: Pt,
  t: number,
  filament: number,
  age: number,
  amp = WEAVE_AMP,
): Pt {
  const p = pointOn(a, c1, c2, b, t);
  const off = weaveAt(t, filament, age, amp);
  if (off === 0) return p;
  const tan = tangentOn(a, c1, c2, b, t);
  return { x: p.x - tan.y * off, y: p.y + tan.x * off };
}

/** A stretch of one thread, for stroking as a tapered polyline. */
export function filamentSamples(
  a: Pt,
  c1: Pt,
  c2: Pt,
  b: Pt,
  from: number,
  to: number,
  filament: number,
  age: number,
  steps = 14,
  amp = WEAVE_AMP,
): Pt[] {
  const n = Math.max(1, Math.round(steps));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(
      filamentPoint(a, c1, c2, b, from + ((to - from) * i) / n, filament, age, amp),
    );
  }
  return out;
}

/** A run of points along part of the shared route, ignoring the braid. */
export function samples(
  a: Pt,
  c1: Pt,
  c2: Pt,
  b: Pt,
  from: number,
  to: number,
  steps = 12,
): Pt[] {
  const n = Math.max(1, Math.round(steps));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    out.push(pointOn(a, c1, c2, b, from + ((to - from) * i) / n));
  }
  return out;
}

/** Out fast, in gently.
 *
 *  Cubic ease-*out*, and the family is the decision rather than the exponent. A
 *  pulse that moved linearly read as a marker being dragged along a line. An
 *  ease-in-out — the reflex choice, and what this was first — is slowest at both
 *  ends, so the light crept away from the sender: the moment that has to read as
 *  *sent* was the moment nothing was happening. Leaving at full speed and
 *  settling into the recipient is the shape of a thing thrown. */
export function ease(t: number): number {
  const u = clamp(t, 0, 1);
  return 1 - Math.pow(1 - u, 3);
}

/* ── the envelopes ────────────────────────────────────────────────────────── */

/** Where one pulse's head and tail are along the curve, or `null` once it has
 *  drained into the recipient.
 *
 *  The tail is the head's position a fraction of a span earlier, both clamped —
 *  so a pulse arriving does not stop dead at the rim, it shortens into it, which
 *  is what makes the landing look like light being absorbed rather than a dot
 *  being deleted. */
export function pulseAt(
  age: number,
  i: number,
  filament = 0,
): { head: number; tail: number } | null {
  const f = FILAMENTS[filament] ?? FILAMENTS[0];
  const u = (age - i * PULSE_STAGGER_MS - f.stagger) / (TRAVEL_MS * f.travel);
  if (u <= 0) return null;
  const head = ease(clamp(u, 0, 1));
  const tail = ease(clamp(u - PULSE_SPAN * f.span, 0, 1));
  if (head - tail <= 0.0005) return null;
  return { head, tail };
}

/** How strongly the route itself is showing. Peaks at 1; the caller decides
 *  what 1 is worth (it is faint — this is a wake, not a wire). */
export function wakeAlpha(age: number): number {
  if (age <= 60) return 0;
  const inn = clamp((age - 60) / 200, 0, 1);
  const out = clamp((WAKE_OUT_AT + WAKE_OUT_MS - age) / WAKE_OUT_MS, 0, 1);
  return Math.min(inn, out);
}

/** The ring that leaves the sender as the first pulse does. */
export function departure(age: number): { radius: number; alpha: number } | null {
  if (age < 0 || age > DEPART_MS) return null;
  const p = age / DEPART_MS;
  return { radius: 6 + 16 * p, alpha: 0.5 * (1 - p) };
}

/** The rings that open at the recipient when the first pulse lands.
 *
 *  Absent entirely for a message that was queued: nothing arrived, and drawing
 *  an arrival there would be the wall claiming a delivery that has not happened.
 *  Two rings rather than one, staggered, so it reads as an impact rather than as
 *  a circle appearing. */
export function arrival(age: number, delivered: boolean): { radius: number; alpha: number }[] {
  if (!delivered) return [];
  const out: { radius: number; alpha: number }[] = [];
  for (let i = 0; i < 2; i += 1) {
    const t = age - TRAVEL_MS - i * ARRIVE_LAG_MS;
    /* Both bounds exclusive: a ring at exactly its last millisecond is alpha
       zero, and a frame spent stroking nothing is still a frame. */
    if (t <= 0 || t >= ARRIVE_MS) continue;
    const p = t / ARRIVE_MS;
    out.push({ radius: 8 + 34 * p, alpha: 0.45 * (1 - p) * (i === 0 ? 1 : 0.6) });
  }
  return out;
}

export function done(age: number): boolean {
  return age >= FLIGHT_MS;
}

/* ── reduced motion ───────────────────────────────────────────────────────
 *
 * The information a strand carries is *who told whom*, and none of it is in the
 * movement. So the honest reduction is the same curve, drawn whole, held, and
 * faded — you still see the pair and the direction of the bow, and nothing
 * travels. Deliberately not "draw nothing": a message would then arrive with no
 * sign anywhere on the wall that it had, which is a worse accessibility answer
 * than a moving line.
 */

export function stillAlpha(age: number): number {
  const inn = clamp(age / 150, 0, 1);
  const out = clamp((FLIGHT_MS - age) / 400, 0, 1);
  return Math.min(inn, out);
}

/* ── the edges of the window ──────────────────────────────────────────────── */

/** Keep an endpoint reachable on a pane this size.
 *
 *  A strand whose recipient is two territories away and off-screen still has
 *  something worth saying — that a message went that way — so the endpoint is
 *  pulled to the edge and marked, rather than the strand being dropped. The
 *  caller fades a `beyond` end out instead of landing it, since a pulse
 *  stopping dead at the window edge reads as a bug rather than as distance. */
export function clampInto(
  p: Pt,
  view: { w: number; h: number },
  inset = 12,
): { pt: Pt; beyond: boolean } {
  if (view.w <= 0 || view.h <= 0) return { pt: p, beyond: false };
  const x = clamp(p.x, inset, Math.max(inset, view.w - inset));
  const y = clamp(p.y, inset, Math.max(inset, view.h - inset));
  return { pt: { x, y }, beyond: x !== p.x || y !== p.y };
}

/* ── colour ───────────────────────────────────────────────────────────────
 *
 * Celadon: the tone this wall already uses for *working*. A message in flight is
 * work moving between two cards, so it is status rather than decoration, and the
 * rule in `tokens.css` — colour is reserved for status — is satisfied rather
 * than argued with.
 *
 * The compositing is chosen from the ground rather than fixed. Skein's own
 * theme is a dark studio wall (`--ink`), where light is light and adding it is
 * exactly right. A theme derived off it can invert that — `theme.ts` puts the
 * ground within reach of the eleven knobs — and additive white on pale paper is
 * a strand that gets *lighter than the wall* and vanishes at the moment it is
 * brightest. So the ground is read off the document at mount, the way
 * `Backdrop.svelte` reads its own two tones, and neither branch is anybody's
 * job to remember.
 */

/** The two tones a strand is drawn in — one per filament, plus the glow.
 *
 *  Both are celadon and neither is a second colour: `core` is the tone lifted
 *  towards the light, `halo` is `--st-work` as the theme actually has it. The
 *  pair is what gives the braid its depth, since the two threads cross
 *  constantly and a braid drawn in one tone reads as a flat ribbon — you cannot
 *  tell which thread is in front, so the crossings stop being crossings. */
export type Palette = { core: Rgb; halo: Rgb; additive: boolean };

/** Relative luminance, 0..1. Rec. 709, which is close enough to decide one
 *  boolean and does not need a colour space. */
export function luminance(c: Rgb): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/** How a strand is drawn against this theme's ground.
 *
 *  On a dark wall — which Skein's own is — the light is the celadon itself,
 *  lifted towards white and added. On a pale one it is the celadon pushed
 *  *towards* the ink and drawn normally, because what reads as a glowing line
 *  on paper is a saturated line with a soft halo rather than a brighter white.
 *  Same hue either way, so the wall's vocabulary does not change with the
 *  theme: celadon still means working.
 *
 *  `working` is `--st-work` and `ground` is `--ink`, both as the document has
 *  them — a theme that has moved either is read, not guessed at. */
export function paletteFor(working: string, ink: string): Palette {
  const core = hexRgb(working, [127, 184, 164]);
  const ground = hexRgb(ink, [21, 18, 16]);
  const additive = luminance(ground) < 0.5;
  return additive
    ? { core: mix(core, [255, 255, 255], 0.25), halo: core, additive: true }
    : { core: mix(core, [0, 0, 0], 0.28), halo: core, additive: false };
}

/** Which tone one filament takes. The lead thread is the lifted one, so the
 *  faster and brighter half of the pair is also the one that reads as nearer. */
export function filamentTone(p: Palette, filament: number): Rgb {
  return filament === 0 ? p.core : p.halo;
}

export function tone(c: Rgb, alpha: number): string {
  return rgba(c, alpha);
}

/* ── what is in the air ───────────────────────────────────────────────────── */

/** One message being drawn. `at` is when it was sent, in `Date.now()` terms. */
export type Strand = {
  id: string;
  from: string;
  to: string;
  at: number;
  delivered: boolean;
  broadcast: boolean;
};

/** Keep the newest `max`, and say so by returning a shorter list.
 *
 *  Separate from expiry on purpose: a strand that has run its 1.4 seconds is
 *  gone because it finished, and one dropped here was cut short. Both leave the
 *  list, and only the second is a cap doing something you might want to know
 *  about — see `snapshot.flights`. */
export function retire<T extends Strand>(
  strands: T[],
  now: number,
  max = MAX_STRANDS,
): T[] {
  const live = strands.filter((s) => !done(now - s.at));
  return live.length <= max ? live : live.slice(live.length - max);
}

/** How many live strands already run between the same pair, which is what a
 *  new one's `fan` is. Order matters: a reply is not a second copy of the
 *  message it answers, and already bows the other way. */
export function fanFor(strands: readonly Strand[], from: string, to: string): number {
  return strands.filter((s) => s.from === from && s.to === to).length;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
