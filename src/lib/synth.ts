/* The toy's reasoning, with no runes, no canvas and no AudioContext in it.
 *
 * A keyboard-driven audiovisual synth you open over the wall while an agent is
 * working. Everything here is the part with rules worth asserting; the two
 * things you can only look at or listen to — a canvas and an audio graph —
 * are `synth.worker.ts` and `synth.svelte.ts`. That is the same split
 * `ambience.ts` has and it is here for the same reason.
 *
 * Five decisions came out of looking at what makes these fun rather than out of
 * taste, and each is load-bearing enough to state:
 *
 * 1. **Pentatonic, always.** Five notes with no tritone between any pair, so no
 *    two keys pressed together are dissonant and mashing the board sounds
 *    deliberate. This is why Patatap and every Orff classroom instrument work,
 *    and for a toy opened for ninety seconds by someone who has not warmed up
 *    it is the difference between fun and noise you close. There is deliberately
 *    no chromatic option: "no wrong notes" is the feature.
 *
 * 2. **The picture is made of the sound, not triggered beside it.** The
 *    standing complaint about digital instruments is that they decouple the
 *    gesture from the output, so the connection stops being perceptible. So the
 *    scope here is a real Lissajous figure — the left channel on X and the
 *    right on Y, which is what an oscilloscope in XY mode draws — fed from two
 *    analysers on the actual bus. Voices pan by where they were played, so the
 *    figure is a picture of what your hands did.
 *
 * 3. **Tap and hold are not predicted, they are observed.** Nothing can know at
 *    keydown which one you meant. Every note therefore opens the same envelope,
 *    and the *release* is what differs: a key let go inside `HOLD_MS` is a
 *    pluck and gets a short release, one held past it has been sustaining and
 *    gets a long one. The visual follows the same envelope, so the two agree by
 *    construction rather than by two pieces of code being kept in step.
 *
 * 4. **A palette is a matched set**, changed with one key mid-play. That is
 *    Patatap's actual mechanic and it is better than a settings panel: scale,
 *    root, waveform, envelope and hue move together, so the toy has moods
 *    rather than knobs.
 *
 * 5. **Feedback is most of how it looks.** Every visual synth's signature trick
 *    is routing the rendered frame back in as a source — trails, echoes,
 *    recursive zoom. It costs three lines in the renderer and does more than
 *    anything else here.
 */

/* ── what is on the shelf ─────────────────────────────────────────────────── */

/** Everything `<space>t` opens onto. One, so far. A union rather than a string
 *  so that `leader.ts`'s verb cannot name a toy that does not exist. */
export type ToyId = "synth";

/* ── the keyboard as a grid ───────────────────────────────────────────────── */

/** The three playing rows, as they sit under the hands.
 *
 *  Physical layout, not alphabet: `q` is above `a` is above `z`, so a seat's
 *  row and column mean something spatial and every mode below can use them.
 *  Ten columns each, which is why the rows run past the letters — `;` finishes
 *  the home row and `,` `.` `/` the bottom one. A ragged grid would have made
 *  every mode below carry a special case for the short row, and the three keys
 *  it costs are ones nothing else on this wall wants. */
export const ROWS = ["qwertyuiop", "asdfghjkl;", "zxcvbnm,./"] as const;

/** Where a key sits, or null if it is not one of the thirty.
 *
 *  Row 0 is the top row. Case-folded, because Shift is a modifier somebody's
 *  hand rests on and a capital `Q` is the same seat as a `q`. */
export type Seat = { row: number; col: number };

export function seat(key: string): Seat | null {
  if (key.length !== 1) return null;
  const k = key.toLowerCase();
  for (let row = 0; row < ROWS.length; row++) {
    const col = ROWS[row]!.indexOf(k);
    if (col >= 0) return { row, col };
  }
  return null;
}

/** A seat's index in reading order, which is what the catalogue mode keys off
 *  and what makes a per-key patch derivable rather than hand-written. */
export function seatIndex(s: Seat): number {
  return s.row * 10 + s.col;
}

/* ── scales ───────────────────────────────────────────────────────────────── */

/** Semitone offsets from the root. All pentatonic, on purpose — see the head of
 *  this file. `yo` is the one that does not sound like the other two and is
 *  here so the palettes have somewhere to go.
 *
 *  It was hirajoshi, which is the obvious choice for that job and is wrong for
 *  this one: hirajoshi is pentatonic but *not* tritone-free — its second and
 *  fifth degrees are six semitones apart — so two keys on the board would have
 *  sounded bad together and the no-wrong-notes promise would have been a claim
 *  rather than a property. `test/synth.test.ts` asserts the interval rather than
 *  the note count, which is what caught it. `yo` is the same tradition and has
 *  no tritone in it. */
export const SCALES = {
  minor: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 7, 9],
  yo: [0, 2, 5, 7, 9],
} as const;

export type ScaleId = keyof typeof SCALES;

/** The `n`th degree of a scale, counting past the octave.
 *
 *  Negative degrees work and go down, which is not decoration: the modes below
 *  index from the middle of the board rather than from one end, so the left
 *  hand is genuinely below the right rather than everything being above the
 *  root. */
export function degree(scale: ScaleId, n: number): number {
  const steps = SCALES[scale];
  const len = steps.length;
  /* Floor division, so -1 is the *last* degree an octave down rather than the
     first one negated — which is what `%` in JS would have given, and would
     have made the bottom-left of the board play the root again. */
  const oct = Math.floor(n / len);
  const idx = n - oct * len;
  return oct * 12 + steps[idx]!;
}

/** Equal temperament, A4 = 440Hz = MIDI 69. */
export function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* ── palettes ─────────────────────────────────────────────────────────────── */

/** One matched set of scale, timbre and colour. Cycled with one key mid-play.
 *
 *  `hue` is a degree on the colour wheel and `spread` is how far the board
 *  travels from it — this is the only place in the app that names a hue at all,
 *  and it is confined to the toy on purpose. Colour on the wall means status;
 *  colour here means you are somewhere else. */
export type Palette = {
  id: string;
  label: string;
  scale: ScaleId;
  /** MIDI note the board is centred on. */
  root: number;
  wave: OscillatorType;
  /** Degrees on the wheel: where the lowest note sits, and how far the highest
   *  gets from it. */
  hue: number;
  spread: number;
  /** Filter cutoff at the bottom of the board, in Hz, and how far it opens
   *  across it. A note high on the board being brighter as well as higher is
   *  most of what makes a cheap oscillator sound like an instrument. */
  cutoff: number;
  open: number;
  env: Envelope;
};

export const PALETTES: readonly Palette[] = [
  {
    id: "dusk",
    label: "dusk",
    scale: "minor",
    root: 57, // A3
    wave: "triangle",
    hue: 190,
    spread: 130,
    cutoff: 420,
    open: 5200,
    env: { attack: 0.012, decay: 0.35, sustain: 0.45, tap: 0.18, release: 1.4 },
  },
  {
    id: "glass",
    label: "glass",
    scale: "major",
    root: 60, // C4
    wave: "sine",
    hue: 45,
    spread: 90,
    cutoff: 900,
    open: 7000,
    env: { attack: 0.004, decay: 0.9, sustain: 0.18, tap: 0.5, release: 2.6 },
  },
  {
    id: "rust",
    label: "rust",
    scale: "minor",
    root: 45, // A2
    wave: "sawtooth",
    hue: 8,
    spread: 60,
    cutoff: 220,
    open: 3400,
    env: { attack: 0.02, decay: 0.22, sustain: 0.6, tap: 0.12, release: 0.9 },
  },
  {
    id: "koto",
    label: "koto",
    scale: "yo",
    root: 62, // D4
    wave: "triangle",
    hue: 290,
    spread: 110,
    cutoff: 700,
    open: 6000,
    env: { attack: 0.003, decay: 1.2, sustain: 0.1, tap: 0.7, release: 3.2 },
  },
];

/** The next palette round the ring. A cycle rather than a picker for the same
 *  reason the theme ring is one: the gesture happens while you are playing, and
 *  a menu over the thing you are looking at is not a gesture you make with both
 *  hands on the keyboard. */
export function nextPalette(id: string, by = 1): Palette {
  const at = PALETTES.findIndex((p) => p.id === id);
  const n = PALETTES.length;
  return PALETTES[(((at < 0 ? 0 : at) + by) % n + n) % n]!;
}

/* ── the three modes ──────────────────────────────────────────────────────── */

/** What a key means on the way in. Everything downstream of this — the voice,
 *  the envelope, the scope, the trails — is identical across the three, which
 *  is the whole reason there can be three. */
export type ModeId = "musical" | "spatial" | "catalogue";

export type Mode = {
  id: ModeId;
  label: string;
  /** One quiet line, in the UI's voice. */
  note: string;
};

export const MODES: readonly Mode[] = [
  { id: "musical", label: "musical", note: "rows are octaves, keys are a scale" },
  { id: "spatial", label: "spatial", note: "the keyboard is the screen" },
  { id: "catalogue", label: "catalogue", note: "every key a different voice" },
];

export function nextMode(id: ModeId, by = 1): ModeId {
  const at = MODES.findIndex((m) => m.id === id);
  const n = MODES.length;
  return MODES[(((at < 0 ? 0 : at) + by) % n + n) % n]!.id;
}

/** Everything a keydown decides, in one value.
 *
 *  One struct for three modes rather than three shapes, because the audio graph
 *  and the renderer should not know which mode produced a note — that is what
 *  lets a fourth mode be a branch here and nothing else. */
export type Strike = {
  midi: number;
  /** -1 hard left to +1 hard right. Feeds the Lissajous as much as the ears. */
  pan: number;
  /** 0..1 across the board, before the palette's cutoff range is applied. */
  bright: number;
  wave: OscillatorType;
  env: Envelope;
  hue: number;
  /** Where on screen this happened, 0..1 in each axis. */
  at: { x: number; y: number };
};

export function strike(mode: ModeId, s: Seat, p: Palette): Strike {
  const col = s.col / 9; // 0..1 left to right
  /* Row 0 is the top row and therefore the *high* octave — the board reads like
     a stave, which is the only arrangement a hand guesses right first time. */
  const up = ROWS.length - 1 - s.row; // 0 bottom, 2 top

  if (mode === "spatial") {
    /* Position is the point, so pitch is coarse: one note per row, and the
       column moves you across the screen and the stereo field instead. Three
       pitches an octave apart make any chord you can physically play a stack of
       octaves, which cannot be wrong — the forgiving property the musical mode
       gets from the pentatonic, arrived at a different way. */
    return {
      midi: p.root + up * 12,
      pan: col * 2 - 1,
      bright: col,
      wave: p.wave,
      env: p.env,
      hue: p.hue + col * p.spread,
      at: { x: 0.06 + col * 0.88, y: 0.14 + (s.row / 2) * 0.72 },
    };
  }

  if (mode === "catalogue") {
    /* Thirty voices nobody hand-designed. The index picks the waveform, skews
       the envelope and detunes the note, which is enough for each key to be
       recognisably its own thing — discovery is the game, and thirty patches
       written by hand is the version of this that never ships. Deterministic,
       so a key is the same toy every time you press it; a catalogue you cannot
       learn is a random number generator with a keyboard attached. */
    const i = seatIndex(s);
    const waves: OscillatorType[] = ["sine", "triangle", "square", "sawtooth"];
    const pluck = i % 3 === 0;
    return {
      midi: p.root + degree(p.scale, (i * 7) % 11 - 5),
      pan: ((i % 7) / 6) * 1.6 - 0.8,
      bright: ((i * 5) % 13) / 12,
      wave: waves[i % waves.length]!,
      env: pluck
        ? { ...p.env, decay: 0.12, sustain: 0.05, tap: 0.08, release: 0.5 }
        : { ...p.env, attack: 0.002 + (i % 5) * 0.03 },
      hue: p.hue + ((i * 37) % 360) * (p.spread / 360),
      /* Scattered rather than gridded, because a catalogue has no spatial
         claim to make and a grid would imply one. Deterministic scatter from
         the index — the golden angle, which is what stops thirty points on a
         disc from landing in rows. */
      at: {
        x: 0.5 + 0.38 * Math.cos(i * 2.39996) * Math.sqrt((i + 1) / 30),
        y: 0.5 + 0.34 * Math.sin(i * 2.39996) * Math.sqrt((i + 1) / 30),
      },
    };
  }

  /* musical: the board is a stave. Columns are scale degrees left to right,
     rows are octaves, and the middle row sits on the root so both hands start
     somewhere that sounds settled. */
  const n = s.col - 4 + (up - 1) * SCALES[p.scale].length;
  const midi = p.root + degree(p.scale, n);
  const reach = (midi - p.root + 24) / 48; // roughly 0..1 over the board
  return {
    midi,
    pan: col * 1.4 - 0.7,
    bright: Math.min(1, Math.max(0, reach)),
    wave: p.wave,
    env: p.env,
    hue: p.hue + reach * p.spread,
    /* Pitch decides height, so a rising phrase rises on screen. The one mapping
       here that is a metaphor rather than an arrangement, and the only one
       everybody already shares. */
    at: { x: 0.08 + col * 0.84, y: 0.86 - Math.min(1, Math.max(0, reach)) * 0.72 },
  };
}

/* ── envelopes ────────────────────────────────────────────────────────────── */

/** ADSR, plus the one extra number this toy needs.
 *
 *  `tap` is the release used by a key let go before `HOLD_MS` — a pluck, and
 *  short. `release` is for one that was genuinely held. Two numbers rather than
 *  one because that difference *is* the tap-versus-hold feature: a held note
 *  that ends the same way a tapped one does makes holding mean only "longer".
 *  Seconds throughout, which is what the Web Audio clock counts in. */
export type Envelope = {
  attack: number;
  decay: number;
  /** 0..1, the level a held note settles at. */
  sustain: number;
  tap: number;
  release: number;
};

/** Past this, a press was a hold. 180ms is a deliberate number: comfortably
 *  above a fast keystroke (a typist's key is down 60–100ms) and comfortably
 *  below anything anybody would call holding. */
export const HOLD_MS = 180;

export function gesture(heldMs: number): "tap" | "hold" {
  return heldMs < HOLD_MS ? "tap" : "hold";
}

/** The envelope's value, as a number between 0 and 1.
 *
 *  This is the renderer's copy of what the audio graph is doing. Both are
 *  driven from the same `Envelope`, so a bloom fades exactly as its note does
 *  without anything having to send the picture a level sixty times a second —
 *  the agreement is by construction, which is the only kind that survives
 *  somebody editing one of them.
 *
 *  All times in seconds and relative to the note starting. `releasedAt` is null
 *  while the key is still down. */
export function envelopeAt(env: Envelope, t: number, releasedAt: number | null): number {
  if (t < 0) return 0;

  /* The level the note had reached when the key came up, which is where the
     release has to start from. Computing it rather than storing it is what
     keeps this a pure function of the two times. */
  const held = (u: number): number => {
    if (u < env.attack) return env.attack <= 0 ? 1 : u / env.attack;
    const d = u - env.attack;
    if (d < env.decay) {
      return env.decay <= 0 ? env.sustain : 1 - (1 - env.sustain) * (d / env.decay);
    }
    return env.sustain;
  };

  if (releasedAt === null || t < releasedAt) return held(t);

  const from = held(releasedAt);
  const span = gesture(releasedAt * 1000) === "tap" ? env.tap : env.release;
  if (span <= 0) return 0;
  const gone = (t - releasedAt) / span;
  return gone >= 1 ? 0 : from * (1 - gone);
}

/** How long after release a note is still worth drawing or holding a slot for.
 *  Used to reap voices, so it has to agree with `envelopeAt` reaching zero. */
export function tailOf(env: Envelope, heldMs: number): number {
  return gesture(heldMs) === "tap" ? env.tap : env.release;
}

/* ── voices ───────────────────────────────────────────────────────────────── */

/** How many notes may sound at once.
 *
 *  Twelve is above what ten fingers can hold, so the cap is only ever reached
 *  by long release tails overlapping — which is the case it exists for. A
 *  browser will happily run a hundred oscillators and then the frame drops
 *  somewhere you cannot see the cause of. */
export const MAX_VOICES = 12;

/** Just enough of a voice for the allocator to choose between them. */
export type Slot = {
  /** The key holding this voice, or null if it is free. */
  key: string | null;
  /** When the note started, on whatever clock the caller is using. */
  since: number;
  /** Whether the key is still down. */
  held: boolean;
};

/** Which slot a new note should take.
 *
 *  In order of preference: a free one, then the oldest *released* one, then the
 *  oldest held one. That last case is the one worth stating — stealing a note
 *  somebody is still holding is audible and wrong, but the alternative is a
 *  keypress that does nothing, and a toy that silently ignores you is worse
 *  than one that cuts a drone short. Returns an index, always. */
export function allocate(slots: readonly Slot[], key: string): number {
  /* Same key again first of all, so a repeat retriggers its own voice rather
     than stacking a second one under it — which is what a held key's auto-repeat
     would otherwise do, thirty times a second, until the cap was full of one
     letter. */
  const mine = slots.findIndex((s) => s.key === key);
  if (mine >= 0) return mine;

  const free = slots.findIndex((s) => s.key === null);
  if (free >= 0) return free;

  let best = -1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i]!.held) continue;
    if (best < 0 || slots[i]!.since < slots[best]!.since) best = i;
  }
  if (best >= 0) return best;

  best = 0;
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]!.since < slots[best]!.since) best = i;
  }
  return best;
}

/* ── the picture ──────────────────────────────────────────────────────────── */

/** A ring of the ripple a held note leaves behind.
 *
 *  Rings are emitted on a cadence for as long as the key is down, which is the
 *  visual half of tap-versus-hold: a tap leaves one, a hold keeps ringing for
 *  as long as you keep holding. The alternative — one ring that simply lasts
 *  longer — reads as a slow animation rather than as something you are doing. */
export const RING_MS = 260;

/** How old each live ring of a note is, oldest first.
 *
 *  `heldMs` is how long the key was (or has been) down; `sinceMs` how long
 *  since the note started. A ring lives `life` ms. Pure, so the cadence is a
 *  rule rather than an accumulator in a frame loop that drifts with the frame
 *  rate — which is the same argument the wall's own tick makes. */
export function rings(sinceMs: number, heldMs: number, life = 1400): number[] {
  const out: number[] = [];
  const last = Math.min(sinceMs, heldMs);
  for (let t = 0; t <= last; t += RING_MS) {
    const age = sinceMs - t;
    if (age < life) out.push(age);
  }
  return out;
}

/** The Lissajous ratio a note draws.
 *
 *  A figure is what you get plotting one oscillator against another, and its
 *  shape is decided by the ratio between them — 1:2 is a parabola, 2:3 the
 *  classic pretzel, and anything irrational never closes. Derived from the
 *  scale degree so that notes an octave apart draw the same figure at different
 *  sizes, which is the sort of thing you notice without being told.
 *
 *  The detune is what stops it standing still: a figure whose ratio is exactly
 *  rational is frozen, and one a fraction off precesses slowly. That drift is
 *  most of why an oscilloscope is nice to look at. */
export function figure(midi: number, root: number): { a: number; b: number; drift: number } {
  const n = ((midi - root) % 12 + 12) % 12;
  const a = 1 + (n % 3);
  const b = 1 + ((n + 1) % 4);
  return { a, b, drift: 0.002 + (n % 5) * 0.0007 };
}

/** Hue wrapped onto the wheel, since a palette's spread can walk it past 360. */
export function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}
