/* What the wall does with nobody watching.
 *
 * Away mode's other half. `presence.ts` is the bookkeeping — who is away, what
 * piled up; this is the screen that stands in front of it, and the rules that
 * decide what it is allowed to look like.
 *
 * The pure half: the catalogue, the rotation, the pointer arithmetic that turns
 * a drag into a throw, and the one rule about colour. `pieces.ts` draws, and
 * `Away.svelte` holds the frame loop.
 *
 * ## Why there is a screen at all
 *
 * A dark window is indistinguishable from a crashed one, and a wall left up
 * overnight is a thing somebody walks past. The screen is the wall saying it is
 * still here and still yours — which is also why none of this is a screensaver
 * in the power-saving sense: it draws *more* than the wall does, not less, and
 * stops dead the moment you come back.
 *
 * ## Colour, and the one place the rule bends
 *
 * The wall reserves colour for status — celadon working, amber asking, rust
 * failed. `toys.md` records the one standing exception, the synth, and the two
 * things that confine it: nothing touches `tokens.css`, and the toy occludes
 * the wall outright, so at no moment is a status colour and a decorative one on
 * screen together.
 *
 * The away screen inherits that bargain and **inherits its second clause as a
 * condition rather than a fact**. Two of the three readings occlude the wall
 * and may use hue; `dimmed` deliberately does not, since it exists so you can
 * see the cards working behind it — so in that reading the pieces draw in the
 * theme's own greys, the way `ambience.ts` does. `hueAllowed` is that rule, it
 * is one line, and it is tested, because the tempting thing to do is to let the
 * pretty version win everywhere.
 */

import type { AwayScreen } from "./presence";

/* ── the catalogue ────────────────────────────────────────────────────────── */

export type PieceId = "flock" | "orbs" | "lanterns" | "tide";

/** What a piece is *for*, which is the thing being rotated between.
 *
 *  Lyss's own words: "sometimes fun, sometimes cute, sometimes artistic,
 *  sometimes all of it". A mood is not a category of implementation — `tide`
 *  and `flock` are both canvases full of moving dots — it is a claim about what
 *  it is like to walk past it, and the rotation uses it so that a night does
 *  not turn out to be four shades of the same thing. */
export type Mood = "fun" | "cute" | "artistic";

export type PieceSpec = {
  id: PieceId;
  /** What it is called where it is named — the corner of the away screen, and
   *  the settings row. Lowercase, like the rest of the app's prose. */
  label: string;
  moods: Mood[];
  /** Which drawing context it wants. A canvas cannot change its context kind
   *  once it has one, so the component swaps the canvas when this differs — see
   *  `Away.svelte`. */
  ctx: "2d" | "webgl2";
  /** One line, said under the label. What it is, and what your hands can do to
   *  it — the second half matters more than it looks: a piece nobody knows is
   *  interactive is a piece nobody touches. */
  about: string;
};

export const PIECES: readonly PieceSpec[] = [
  {
    id: "flock",
    label: "volery",
    moods: ["artistic", "cute"],
    ctx: "2d",
    about: "birds, flocking. click to scatter them, hold one and throw it",
  },
  {
    id: "orbs",
    label: "orbs",
    moods: ["fun"],
    ctx: "2d",
    about: "they bounce. click to send one off, grab one and flick it",
  },
  {
    id: "lanterns",
    label: "lanterns",
    moods: ["cute", "artistic"],
    ctx: "2d",
    about: "they drift up and go out. click to relight one, carry one with you",
  },
  {
    id: "tide",
    label: "tide",
    moods: ["artistic", "fun"],
    ctx: "webgl2",
    about: "a field, flowing. your hand bends it",
  },
];

export function pieceSpec(id: PieceId): PieceSpec {
  return PIECES.find((p) => p.id === id) ?? PIECES[0];
}

export function isPieceId(v: unknown): v is PieceId {
  return typeof v === "string" && PIECES.some((p) => p.id === v);
}

/* ── rotation ─────────────────────────────────────────────────────────────── */

/** How long one piece holds the screen. Long enough that walking past twice in
 *  an evening shows you the same thing — a wall that reshuffled every thirty
 *  seconds would read as restless rather than as calm — and short enough that a
 *  night is not one piece. */
export const HOLD_MS = 9 * 60 * 1000;

/** Pick what comes next.
 *
 *  Two rules, and the second is the one that makes a night worth walking past.
 *  Never the piece that is already up, because a rotation that can land on
 *  itself is one that visibly does nothing. And **prefer a mood the current
 *  piece does not have**, so the sequence moves between fun and cute and
 *  artistic rather than taking three artistic ones in a row by chance.
 *
 *  `roll` is passed in rather than read from `Math.random`, which is what makes
 *  the rule testable at all — the same seam `ambience.ts` draws. */
export function nextPiece(current: PieceId | null, roll: number): PieceId {
  const now = current ? pieceSpec(current) : null;
  const others = PIECES.filter((p) => p.id !== current);
  if (!others.length) return PIECES[0].id;
  const fresh = now
    ? others.filter((p) => !p.moods.every((m) => now.moods.includes(m)))
    : others;
  const from = fresh.length ? fresh : others;
  const i = Math.min(from.length - 1, Math.max(0, Math.floor(roll * from.length)));
  return from[i].id;
}

/* ── the one rule about colour ────────────────────────────────────────────── */

/** Whether a piece may use hue, which is only true where the wall is covered.
 *
 *  See the note at the top: the synth's exception is confined by occluding the
 *  wall outright, and `dimmed` is the reading that deliberately does not. A
 *  decorative hue beside a status colour is the house rule broken rather than
 *  bent. */
export function hueAllowed(screen: AwayScreen): boolean {
  return screen !== "dimmed";
}

/* ── a drag turned into a throw ───────────────────────────────────────────── */

export type Sample = { x: number; y: number; t: number };

/** The longest window of pointer history a flick is measured over.
 *
 *  A throw is the *last* part of a drag: measure the whole gesture and carrying
 *  something slowly across the screen and then snapping your wrist gives you
 *  the average of the two, which feels like the wall ignoring you. 90ms is
 *  about the length of the snap itself. */
export const FLICK_MS = 90;

/** Pixels per second, past which a flick stops getting faster. Without it a
 *  5ms sample pair divides by almost nothing and a gentle release launches
 *  something off the screen for ever. */
export const FLICK_MAX = 2600;

/** What a release should throw, given where the pointer has just been.
 *
 *  Samples are oldest-first and may be empty, one long, or all at the same
 *  instant — all three happen, and all three must answer *no throw* rather than
 *  a NaN that then poisons a position for the rest of the night. That is the
 *  actual bug being prevented here: one `Infinity` in a velocity is a bird that
 *  leaves the universe and never comes back, on a screen nobody is watching, so
 *  it is still gone in the morning. */
export function flick(samples: readonly Sample[]): { vx: number; vy: number } {
  const last = samples[samples.length - 1];
  if (!last) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    first = samples[i];
    if (last.t - first.t >= FLICK_MS) break;
  }
  const dt = (last.t - first.t) / 1000;
  if (!(dt > 0)) return { vx: 0, vy: 0 };
  return {
    vx: clampSpeed((last.x - first.x) / dt),
    vy: clampSpeed((last.y - first.y) / dt),
  };
}

function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-FLICK_MAX, Math.min(FLICK_MAX, v));
}

/* ── how fast it is allowed to draw ───────────────────────────────────────── */

/** The shortest gap between frames, in ms, for a motion setting. `Infinity`
 *  means draw one frame and stop.
 *
 *  Pure, and here rather than inline in the component, because it is the number
 *  that decides whether the screen looks alive — and a wrong one is
 *  indistinguishable from the whole thing being broken. Which is what happened:
 *  at `still` the loop drew one frame and stopped, and a *second* fault
 *  restarted the loop once a second with the piece rebuilt from scratch, so the
 *  pair produced a slideshow at exactly 1fps with every object in a new random
 *  place. Either alone is survivable. Together they are unusable, and nothing
 *  in a type or a typecheck says so.
 *
 *  `spare` is 24 rather than the 20 it shipped as. This is one full-screen
 *  canvas with nothing else on the wall drawing, and 20 is inside the range
 *  where a person sees steps rather than movement — the point of `spare` is to
 *  cost less than `full`, not to look broken. */
export function frameFloor(motion: string | undefined): number {
  if (motion === "still") return Infinity;
  if (motion === "spare") return 1000 / 24;
  return 0;
}

/** Whether a motion setting is holding the screen back, said in the corner.
 *
 *  Null at full motion. It exists because *no motion* and *the animation is
 *  broken* look identical from across the room, and the first is a setting
 *  somebody chose months ago for a different reason. */
export function heldBack(motion: string | undefined): string | null {
  if (motion === "still") return "held still by the motion setting";
  if (motion === "spare") return "drawn sparely by the motion setting";
  return null;
}

/* ── what the corner says ─────────────────────────────────────────────────── */

export type AwayLine = {
  /** The big one: that you are away, and for how long. */
  head: string;
  /** Under it: what has piled up, or what you said on the way out. Null when
   *  there is neither, which is the ordinary case and reads as calm. */
  under: string | null;
};

/** The screen's own words.
 *
 *  Deliberately short, and deliberately *not* a dashboard. The wall is already
 *  behind it and the pile is already waiting; a screen that listed what every
 *  card was doing would be a wall you look at instead of going to bed, which is
 *  the opposite of what this is for. One fact, and the one thing that would
 *  make you come back sooner. */
export function awayLine(
  lastedText: string,
  waiting: number,
  note: string | null,
): AwayLine {
  const head = `away · ${lastedText}`;
  if (waiting > 0) {
    const q = `${waiting} question${waiting === 1 ? "" : "s"} waiting`;
    return { head, under: note ? `${q} · ${note}` : q };
  }
  return { head, under: note };
}
