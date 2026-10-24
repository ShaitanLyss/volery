/** Boost's score, as data and as decisions: the 16-bit last battle Lyss picked
 *  by ear on 2026-10-24, and where each moment lands in it.
 *
 *  Pure. Nothing here knows about Web Audio — `boostscore.svelte.ts` turns a
 *  `Cue` into oscillators and owns the clock. What this file owns is every
 *  musical claim the score makes, so each can be asserted
 *  (`test/boostmusic.test.ts`): which voice sounds on which step at which
 *  intensity, the bar a queued moment lands on, the chord a moment is built
 *  from, and the numbers the duck moves by. `.claude/rules/boost-music.md` has
 *  the reasoning. */

import type { Intensity } from "./boost";

export const BPM = 168;
/** Sixteenths to a bar, bars to the loop. */
export const STEPS = 16;
export const BARS = 8;
export const LOOP = STEPS * BARS;
export const STEP_S = 60 / BPM / 4;
export const BAR_S = STEP_S * STEPS;

export type Chord = { root: number; quality: "minor" | "major" };

/** A minor over eight bars, i VI VII V i VI iv V: the natural seventh for VII
 *  and the raised one for V, which is the harmonic-minor colour. `root` is the bass
 *  octave (A2 = 45). The sketch's harmony, unchanged. */
export const PROGRESSION: readonly Chord[] = [
  { root: 45, quality: "minor" },
  { root: 41, quality: "major" },
  { root: 43, quality: "major" },
  { root: 40, quality: "major" },
  { root: 45, quality: "minor" },
  { root: 41, quality: "major" },
  { root: 38, quality: "minor" },
  { root: 40, quality: "major" },
];

/** The two chords a victory borrows: the dominant, and the tonic turned major
 *  — a Picardy third — before the loop takes the minor back at its top. */
export const DOMINANT: Chord = { root: 40, quality: "major" };
export const PICARDY: Chord = { root: 45, quality: "major" };

export function tones(c: Chord, octave: number): number[] {
  const third = c.quality === "minor" ? 3 : 4;
  return [0, third, 7].map((i) => c.root + 12 * octave + i);
}

export function pitchClasses(c: Chord): number[] {
  return tones(c, 0).map((m) => m % 12);
}

export function inChord(midi: number, c: Chord): boolean {
  return pitchClasses(c).includes(midi % 12);
}

/** The theme: [step in the 128-step loop, midi, length in steps]. Original,
 *  and the sketch's note for note. */
export const THEME: readonly (readonly [number, number, number])[] = [
  [0, 76, 4], [4, 81, 4], [8, 83, 2], [10, 84, 2], [12, 83, 2], [14, 81, 2], [16, 84, 6], [22, 81, 2],
  [24, 77, 4], [28, 81, 4], [32, 83, 4], [36, 86, 4], [40, 79, 2], [42, 81, 2], [44, 83, 4], [48, 80, 8],
  [56, 83, 4], [60, 88, 4], [64, 81, 2], [66, 76, 2], [68, 81, 2], [70, 84, 2], [72, 88, 6], [78, 86, 2],
  [80, 84, 4], [84, 81, 4], [88, 77, 4], [92, 84, 4], [96, 86, 4], [100, 89, 4], [104, 88, 2], [106, 86, 2],
  [108, 84, 4], [112, 83, 4], [116, 80, 4], [120, 76, 4], [124, 80, 2], [126, 83, 2],
];
const THEME_AT = new Map(THEME.map((n) => [n[0], n]));

/** The bass's octave figure, one entry per eighth. */
const BASS = [0, 12, 0, 12, 0, 12, 7, 12];

/** The victory fanfare over its two bars: [step, midi, length]. An arpeggio
 *  climbing the dominant, then the major tonic held and answered. Original —
 *  it is not the Final Fantasy fanfare's repeated-note triplet figure, nor
 *  anybody else's. */
export const FANFARE: readonly (readonly [number, number, number])[] = [
  [0, 71, 2], [2, 76, 2], [4, 80, 4], [8, 83, 2], [10, 80, 2], [12, 83, 2], [14, 88, 2],
  [16, 85, 6], [22, 81, 2], [24, 85, 2], [26, 88, 6],
];
/** The line under it, a third or a sixth below, chord tones only. */
export const FANFARE_HARMONY: readonly (readonly [number, number, number])[] = [
  [0, 64, 4], [4, 68, 4], [8, 71, 4], [12, 76, 4],
  [16, 76, 8], [24, 81, 8],
];

/** Every voice the score has. The first eight are the loop; the rest belong
 *  to the moments. */
export type Voice =
  | "pad" | "heart" | "bass" | "thump" | "snare" | "hat" | "stab" | "lead"
  | "fill" | "roll" | "crash" | "brass" | "boom" | "fanfare" | "harmony" | "swell" | "drone";

/** Which bus a voice plays into. `music` is what a moment ducks; `drums` is
 *  never ducked, because the beat is what tells you the moment is part of the
 *  score rather than on top of it; `moment` is the moment itself. */
export type Bus = "music" | "drums" | "moment";

export const BUS_OF: Record<Voice, Bus> = {
  pad: "music", bass: "music", stab: "music", lead: "music",
  heart: "drums", thump: "drums", snare: "drums", hat: "drums",
  fill: "moment", roll: "moment", crash: "moment", brass: "moment", boom: "moment",
  fanfare: "moment", harmony: "moment", swell: "moment", drone: "moment",
};

/** One thing to play. `step` is absolute — steps since the score started —
 *  `at` a fraction of a step past it (a roll's thirty-seconds), `len` in steps,
 *  `vel` 0–1 scaling the patch's own level. */
export type Cue = { voice: Voice; step: number; at: number; midi?: number; len: number; vel: number };

/** How far the music bus goes down under a moment, how fast, and how it comes
 *  back: over the last beat of the moment, so it is whole again exactly on the
 *  bar line the loop takes over at. */
export const DUCK_DB = -8;
export const DUCK_ATTACK_S = 0.04;
export const DUCK_RELEASE_STEPS = 4;
export const duckGain = (db: number) => Math.pow(10, db / 20);

/** The loop's own time after a limit break, during which another is absorbed:
 *  one whole turn of the eight bars, about eleven seconds — the theme gets a
 *  phrase between two breaks, so they read as two events rather than a stutter. */
export const REST_STEPS = LOOP;

export type MomentKind = "ignite" | "limit" | "victory";

/** A moment placed on the score. `from` is its first step (a fill, a riser),
 *  `land` the bar line it lands on, `until` the bar line it hands back at. */
export type Plan = { kind: MomentKind; from: number; land: number; until: number };

const ceilTo = (k: number, n: number) => Math.ceil(k / n) * n;

/** Where a moment queued at step `q` — the first step not yet scheduled —
 *  goes.
 *
 *  - **limit** is a fill into a downbeat. If at least half a bar is left, the
 *    fill starts on the next beat and the hit lands on the coming bar line;
 *    otherwise the fill takes the whole next bar. A fill shorter than two
 *    beats is a flam, not a fill, and waiting a whole extra bar every time
 *    would put up to three seconds between a card going onto credits and the
 *    sound of it. So the wait is 0.7–2.1 s, never less than two beats of fill.
 *    The hit's bar is the moment's too, so it hands back a bar after landing.
 *  - **victory** lands on the next bar line and owns two bars.
 *  - **ignite** is a riser over a whole bar, landing on the bar line after it;
 *    it is the entrance, so it owns nothing past the landing. */
export function place(kind: MomentKind, q: number): Plan {
  const bar = ceilTo(q, STEPS);
  if (kind === "limit") {
    const room = bar - q;
    const land = room >= STEPS / 2 ? bar : bar + STEPS;
    const from = room >= STEPS / 2 ? ceilTo(q, 4) : bar;
    return { kind, from, land, until: land + STEPS };
  }
  if (kind === "victory") return { kind, from: bar, land: bar, until: bar + 2 * STEPS };
  return { kind, from: bar, land: bar + STEPS, until: bar + STEPS };
}

/** What a bar plays: its chord, and where in the progression it is — `null`
 *  for a bar a moment has borrowed, which plays no theme and no turnaround. */
export type BarState = { chord: Chord; pos: number | null; level: Intensity; muted: boolean };

/** What one step produced. `duck` is a direction for the music bus, when this
 *  step is where it starts to move. */
export type Rendered = { step: number; bar: BarState; cues: Cue[]; duck: "down" | "up" | null };

/** The conductor: walks the score a step at a time, holding the progression,
 *  the intensity and the moments queued on it. The runtime asks for one step
 *  at a time as its lookahead reaches it, and never for one twice. */
export class Conductor {
  /** The next step to render. */
  step = 0;
  #want: Intensity;
  #level: Intensity;
  #next = 0;
  #bar: BarState;
  #plans: Plan[] = [];
  #restUntil = 0;

  constructor(level: Intensity = 0, opts: { ignite?: boolean } = {}) {
    this.#want = level;
    this.#level = level;
    this.#bar = { chord: PROGRESSION[0], pos: 0, level, muted: false };
    if (opts.ignite) this.#plans.push(place("ignite", 0));
  }

  /** Ask for an intensity. It is taken on the next bar line, never mid-bar. */
  want(level: Intensity) {
    this.#want = level;
  }

  get plans(): readonly Plan[] {
    return this.#plans;
  }

  /** Queue a moment. Answers where it went, or `null` for a moment the score
   *  is already saying.
   *
   *  Cards arrive in bursts — a whole wall's subscription runs out together,
   *  or four cards are spawned onto credits within ten seconds — and each one
   *  marks a limit. So:
   *
   *  - moments never overlap: one waits for the last to hand back;
   *  - one of a kind that has not handed back yet — waiting, filling or still
   *    ringing — absorbs another of its kind, because it is already saying it;
   *  - after a limit break the loop gets `REST_STEPS` to itself, and a limit
   *    inside that is absorbed too. Deferring it instead would land it seconds
   *    after the card it was about, which is the "no regard for the music"
   *    the sketch was faulted for, the other way round;
   *  - and at most two are ever waiting.
   *
   *  So a burst is one limit break, and a slow trickle is at most one every
   *  ten bars or so. Victory needs none of this — `boost.ts` rations it to one
   *  in ninety seconds before it reaches here. */
  queue(kind: MomentKind): Plan | null {
    if (this.#plans.some((p) => p.kind === kind && p.until > this.step)) return null;
    if (kind === "limit" && this.step < this.#restUntil) return null;
    if (this.#plans.filter((p) => p.from >= this.step).length >= 2) return null;
    const after = this.#plans.reduce((m, p) => Math.max(m, p.until), this.step);
    const plan = place(kind, after);
    this.#plans.push(plan);
    if (kind === "limit") this.#restUntil = plan.until + REST_STEPS;
    return plan;
  }

  /** Decide the bar starting at `k`. */
  #enterBar(k: number) {
    this.#level = this.#want;
    const victory = this.#plans.find((p) => p.kind === "victory" && k >= p.land && k < p.until);
    const ignite = this.#plans.find((p) => p.kind === "ignite" && k >= p.from && k < p.land);
    if (victory) {
      const first = k === victory.land;
      this.#bar = { chord: first ? DOMINANT : PICARDY, pos: null, level: this.#level, muted: false };
      if (!first) this.#next = 0;
    } else if (ignite) {
      this.#bar = { chord: DOMINANT, pos: null, level: this.#level, muted: true };
      this.#next = 0;
    } else {
      const pos = this.#next;
      this.#bar = { chord: PROGRESSION[pos], pos, level: this.#level, muted: false };
      this.#next = (pos + 1) % BARS;
    }
  }

  render(): Rendered {
    const k = this.step++;
    if (k % STEPS === 0) this.#enterBar(k);
    const bar = this.#bar;
    const cues = loopCues(k, bar);
    let duck: "down" | "up" | null = null;
    for (const p of this.#plans) {
      cues.push(...momentCues(p, k, bar));
      if (p.kind !== "ignite") {
        if (k === p.from) duck = "down";
        if (k === p.until - DUCK_RELEASE_STEPS) duck = "up";
      }
    }
    /* Forget what is over. */
    this.#plans = this.#plans.filter((p) => k < p.until);
    return { step: k, bar, cues, duck };
  }
}

/** The loop at one step: the sketch's `bit` style, layer for layer.
 *  0 — pad and the kick heartbeat; 1 — the pulse bass; 2 — drums and stabs;
 *  3 — the theme. */
export function loopCues(k: number, bar: BarState): Cue[] {
  const s = k % STEPS;
  const { chord, pos, level: L, muted } = bar;
  const out: Cue[] = [];
  const cue = (voice: Voice, len: number, midi?: number, vel = 1) => out.push({ voice, step: k, at: 0, midi, len, vel });

  if (!muted && s === 0) for (const m of tones(chord, 2)) cue("pad", 15, m);
  if (s === 0 || s === 8) cue("heart", 3);
  if (!muted && L >= 1 && s % 2 === 0) cue("bass", 1.6, chord.root + BASS[s / 2]);
  if (L >= 2) {
    if (s === 0 || s === 6 || s === 8) cue("thump", 2);
    if (s === 4 || s === 12 || ((pos === 3 || pos === 7) && s >= 13)) cue("snare", 1.4);
    if (s % 2 === 1) cue("hat", 0.4);
    if (!muted && (s === 0 || s === 10)) for (const m of tones(chord, 2)) cue("stab", 1.5, m);
  }
  if (!muted && L >= 3 && pos !== null) {
    const n = THEME_AT.get(pos * STEPS + s);
    if (n) cue("lead", n[2] * 0.92, n[1]);
  }
  return out;
}

/** The chord tones a limit-break fill climbs: nine of them, from the chord's
 *  root in the third octave to its fifth in the sixth. */
export function fillLadder(c: Chord): number[] {
  return [1, 2, 3].flatMap((o) => tones(c, o));
}

/** A moment's own notes at step `k`, built on the bar's chord. */
export function momentCues(p: Plan, k: number, bar: BarState): Cue[] {
  const out: Cue[] = [];
  const cue = (voice: Voice, len: number, midi?: number, vel = 1, at = 0) => out.push({ voice, step: k, at, midi, len, vel });
  const c = bar.chord;

  if (p.kind === "limit") {
    if (k >= p.from && k < p.land) {
      /* The fill: a sixteenth tremolo climbing the chord that sounds under it,
         and a snare roll that doubles to thirty-seconds for the last beat. The
         climb is on *this* bar's chord rather than the one it lands on: the
         bass is still playing this one, and the coming chord over it is a
         clash at three of the eight bar lines (G over F is a B against F, E
         over G is a G# against G). */
      const i = k - p.from;
      const n = p.land - p.from;
      const ladder = fillLadder(c);
      const rise = i / Math.max(1, n - 1);
      cue("fill", 0.9, ladder[Math.min(ladder.length - 1, Math.floor((i * ladder.length) / n))], 0.55 + 0.45 * rise);
      const vel = 0.3 + 0.7 * rise;
      cue("roll", 0.5, undefined, vel);
      if (p.land - k <= 4) cue("roll", 0.5, undefined, vel, 0.5);
    }
    if (k === p.land) {
      cue("crash", 20);
      cue("boom", 8, c.root);
      for (const m of [c.root + 12, ...tones(c, 2), c.root + 36]) cue("brass", 14, m);
    }
  }

  if (p.kind === "victory" && k >= p.land && k < p.until) {
    const i = k - p.land;
    if (i === 0 || i === STEPS) {
      cue("crash", i === 0 ? 16 : 24, undefined, i === 0 ? 0.7 : 1);
      cue("boom", 8, c.root);
      for (const m of [c.root + 12, ...tones(c, 2)]) cue("brass", i === 0 ? 6 : 14, m, 0.8);
    }
    for (const line of [FANFARE, FANFARE_HARMONY]) {
      const n = line.find((x) => x[0] === i);
      if (n) cue(line === FANFARE ? "fanfare" : "harmony", n[2] * 0.92, n[1]);
    }
  }

  if (p.kind === "ignite") {
    if (k >= p.from && k < p.land) {
      /* The riser: the dominant held under a filtered-noise swell, the
         pulse bass's octaves building on E, and a roll into the downbeat — so
         the score's first bar line is V resolving to i rather than the loop
         starting cold. */
      const i = k - p.from;
      if (i === 0) cue("swell", STEPS);
      if (i === 0) for (const m of tones(c, 2)) cue("drone", STEPS, m, 0.8);
      if (i % 2 === 0) cue("bass", 1.6, c.root + BASS[(i / 2) % BASS.length], 0.4 + (0.6 * i) / STEPS);
      if (i >= 8) {
        const vel = 0.3 + (0.7 * (i - 8)) / 7;
        cue("roll", 0.5, undefined, vel);
        if (i >= 12) cue("roll", 0.5, undefined, vel, 0.5);
      }
    }
    if (k === p.land) {
      cue("crash", 20);
      cue("boom", 8, c.root);
    }
  }
  return out;
}
