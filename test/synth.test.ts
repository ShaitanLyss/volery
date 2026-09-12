import { describe, expect, test } from "bun:test";

import {
  HOLD_MS,
  MAX_VOICES,
  PALETTES,
  RING_MS,
  ROWS,
  SCALES,
  allocate,
  degree,
  envelopeAt,
  figure,
  gesture,
  hz,
  nextMode,
  nextPalette,
  rings,
  seat,
  seatIndex,
  strike,
  tailOf,
  wrapHue,
  type Envelope,
  type Slot,
} from "../src/lib/synth";

const env: Envelope = { attack: 0.1, decay: 0.2, sustain: 0.5, tap: 0.05, release: 1 };

/* ── the board ────────────────────────────────────────────────────────────── */

describe("the keyboard as a grid", () => {
  test("the three rows sit above each other", () => {
    expect(seat("q")).toEqual({ row: 0, col: 0 });
    expect(seat("a")).toEqual({ row: 1, col: 0 });
    expect(seat("z")).toEqual({ row: 2, col: 0 });
  });

  test("case is a modifier somebody's hand is resting on, not a different seat", () => {
    expect(seat("Q")).toEqual(seat("q"));
  });

  test("anything that is not one of the thirty has no seat", () => {
    for (const k of [" ", "Enter", "Tab", "1", "Escape", "ArrowUp", ""]) {
      expect(seat(k)).toBeNull();
    }
  });

  test("no key sits in two places", () => {
    const all = ROWS.join("");
    expect(new Set(all).size).toBe(all.length);
  });

  test("the index is reading order and is unique across the board", () => {
    const seen = new Set<number>();
    for (let r = 0; r < ROWS.length; r++) {
      for (let c = 0; c < ROWS[r]!.length; c++) seen.add(seatIndex({ row: r, col: c }));
    }
    expect(seen.size).toBe(ROWS.join("").length);
  });
});

/* ── notes ────────────────────────────────────────────────────────────────── */

describe("scales", () => {
  test("every scale is pentatonic, because no wrong notes is the feature", () => {
    /* Not decoration. Five notes with no tritone is why mashing the board
       sounds deliberate, and it is the single decision this toy would be worst
       without — so it is asserted rather than left to whoever edits the table
       next. */
    for (const steps of Object.values(SCALES)) expect(steps.length).toBe(5);
  });

  test("no scale contains a tritone between any two of its notes", () => {
    /* The actual property. Six semitones apart is the one interval that sounds
       wrong on its own, and a "pentatonic" scale that happened to contain one
       would pass the length check above and still sound bad. */
    for (const steps of Object.values(SCALES)) {
      for (const a of steps) {
        for (const b of steps) {
          expect(Math.abs(a - b) % 12).not.toBe(6);
        }
      }
    }
  });

  test("a degree past the end of the scale is the next octave up", () => {
    expect(degree("minor", 5)).toBe(12);
    expect(degree("minor", 6)).toBe(15);
  });

  test("a negative degree goes down rather than wrapping to the root", () => {
    /* `%` in JS would have made -1 the root negated, which would have put the
       root back under the bottom-left of the board — two keys playing the same
       note and a hole where the note below should be. */
    expect(degree("minor", -1)).toBe(-2); // the last degree, an octave down
    expect(degree("minor", -5)).toBe(-12);
  });

  test("A4 is 440", () => {
    expect(hz(69)).toBeCloseTo(440, 6);
    expect(hz(81)).toBeCloseTo(880, 6);
    expect(hz(57)).toBeCloseTo(220, 6);
  });
});

/* ── envelopes ────────────────────────────────────────────────────────────── */

describe("the envelope", () => {
  test("silence before the note and at the moment it starts", () => {
    expect(envelopeAt(env, -1, null)).toBe(0);
    expect(envelopeAt(env, 0, null)).toBe(0);
  });

  test("it rises through the attack and peaks at the top of it", () => {
    expect(envelopeAt(env, 0.05, null)).toBeCloseTo(0.5, 5);
    expect(envelopeAt(env, 0.1, null)).toBeCloseTo(1, 5);
  });

  test("it decays to the sustain and then holds there", () => {
    expect(envelopeAt(env, 0.3, null)).toBeCloseTo(0.5, 5);
    expect(envelopeAt(env, 9, null)).toBeCloseTo(0.5, 5);
  });

  test("a release falls from wherever the note had actually got to", () => {
    /* The load-bearing one, and the audio bug it mirrors: released mid-attack,
       the level has to fall from half rather than jump to full and back down.
       This is the same shape as `#stop`'s `setValueAtTime(gain.value)` and the
       reason both exist. */
    const half = envelopeAt(env, 0.05, null);
    expect(half).toBeCloseTo(0.5, 5);
    expect(envelopeAt(env, 0.05, 0.05)).toBeCloseTo(0.5, 5);
    /* A tap's release is 0.05s, so a quarter of the way through it is a
       quarter of the way down from where it was. */
    expect(envelopeAt(env, 0.05 + 0.0125, 0.05)).toBeCloseTo(0.5 * 0.75, 5);
  });

  test("it reaches zero and stays there", () => {
    expect(envelopeAt(env, 10, 0.05)).toBe(0);
  });

  test("a tap and a hold released at the same level end at different times", () => {
    /* This is tap-versus-hold in one assertion. Both are released from the
       sustain; the tap is gone in 50ms and the hold is still sounding a second
       later. A toy where holding only meant "longer" would fail this by
       passing both. */
    const tapped = 0.05; // inside HOLD_MS
    const holdFor = 0.5; // past it
    expect(gesture(tapped * 1000)).toBe("tap");
    expect(gesture(holdFor * 1000)).toBe("hold");
    expect(envelopeAt(env, tapped + 0.06, tapped)).toBe(0);
    expect(envelopeAt(env, holdFor + 0.06, holdFor)).toBeGreaterThan(0);
  });

  test("the tap/hold line is where the comment says it is", () => {
    expect(gesture(HOLD_MS - 1)).toBe("tap");
    expect(gesture(HOLD_MS)).toBe("hold");
  });

  test("the tail agrees with when the envelope actually reaches zero", () => {
    /* The reap in the frame loop uses `tailOf` and the picture uses
       `envelopeAt`. If they disagreed, a voice would either be freed while it
       was still audible or held after it went silent. */
    for (const held of [0.02, 0.1, 0.5, 4]) {
      const tail = tailOf(env, held * 1000);
      expect(envelopeAt(env, held + tail, held)).toBe(0);
      expect(envelopeAt(env, held + tail * 0.5, held)).toBeGreaterThan(0);
    }
  });

  test("every palette's envelope is playable", () => {
    /* A zero attack clicks, a zero release clicks, and a sustain outside 0..1
       is a level the gain node will refuse or clip on. Cheap to assert and the
       sort of thing a hand-edited table gets wrong. */
    for (const p of PALETTES) {
      expect(p.env.attack).toBeGreaterThan(0);
      expect(p.env.tap).toBeGreaterThan(0);
      expect(p.env.release).toBeGreaterThan(p.env.tap);
      expect(p.env.sustain).toBeGreaterThanOrEqual(0);
      expect(p.env.sustain).toBeLessThanOrEqual(1);
    }
  });
});

/* ── voices ───────────────────────────────────────────────────────────────── */

describe("allocating a voice", () => {
  const slots = (spec: Partial<Slot>[]): Slot[] =>
    spec.map((s) => ({ key: null, since: 0, held: false, ...s }));

  test("a free slot first", () => {
    expect(allocate(slots([{ key: "a", since: 1, held: true }, {}]), "b")).toBe(1);
  });

  test("the same key again takes its own voice back", () => {
    /* Otherwise a key's auto-repeat stacks a second voice under the first,
       thirty times a second, until the board is twelve copies of one letter. */
    expect(allocate(slots([{ key: "a", since: 1, held: true }, {}]), "a")).toBe(0);
  });

  test("with none free, the oldest released one goes", () => {
    const s = slots([
      { key: "a", since: 5, held: true },
      { key: "b", since: 1, held: false },
      { key: "c", since: 3, held: false },
    ]);
    expect(allocate(s, "d")).toBe(1);
  });

  test("a held note is never stolen while a released one is available", () => {
    const s = slots([
      { key: "a", since: 1, held: true },
      { key: "b", since: 9, held: false },
    ]);
    expect(allocate(s, "c")).toBe(1);
  });

  test("with everything held it still answers, and takes the oldest", () => {
    /* Stealing a note somebody is holding is audible and wrong, and a keypress
       that does nothing is worse — a toy that silently ignores you is not a
       toy. So this returns an index, always. */
    const s = slots([
      { key: "a", since: 7, held: true },
      { key: "b", since: 2, held: true },
    ]);
    expect(allocate(s, "c")).toBe(1);
  });

  test("the cap is above what ten fingers can hold", () => {
    expect(MAX_VOICES).toBeGreaterThan(10);
  });
});

/* ── the three modes ──────────────────────────────────────────────────────── */

describe("what a key means", () => {
  const p = PALETTES[0]!;
  const every = (): { row: number; col: number }[] => {
    const out = [];
    for (let r = 0; r < ROWS.length; r++) {
      for (let c = 0; c < ROWS[r]!.length; c++) out.push({ row: r, col: c });
    }
    return out;
  };

  test("every key on the board plays, in every mode", () => {
    /* A seat that produced a NaN frequency or a pan outside -1..1 is a key that
       either makes no sound or throws inside the audio graph — and the audio
       graph is the one place in this app where a bad number is silent rather
       than loud. */
    for (const mode of ["musical", "spatial", "catalogue"] as const) {
      for (const s of every()) {
        const st = strike(mode, s, p);
        expect(Number.isFinite(st.midi)).toBe(true);
        expect(hz(st.midi)).toBeGreaterThan(15);
        expect(hz(st.midi)).toBeLessThan(20000);
        expect(st.pan).toBeGreaterThanOrEqual(-1);
        expect(st.pan).toBeLessThanOrEqual(1);
        expect(st.bright).toBeGreaterThanOrEqual(0);
        expect(st.bright).toBeLessThanOrEqual(1);
        expect(st.at.x).toBeGreaterThanOrEqual(0);
        expect(st.at.x).toBeLessThanOrEqual(1);
        expect(st.at.y).toBeGreaterThanOrEqual(0);
        expect(st.at.y).toBeLessThanOrEqual(1);
      }
    }
  });

  test("musical mode is in the scale, whatever you press", () => {
    /* The no-wrong-notes promise, asserted over the whole board rather than
       trusted to the arithmetic that spreads it. */
    const allowed = new Set(SCALES[p.scale].map((n) => n % 12));
    for (const s of every()) {
      const st = strike("musical", s, p);
      expect(allowed.has((((st.midi - p.root) % 12) + 12) % 12)).toBe(true);
    }
  });

  test("musical mode rises left to right and bottom to top", () => {
    /* The board reads like a stave, which is the only arrangement a hand
       guesses right first time. */
    const low = strike("musical", { row: 2, col: 0 }, p).midi;
    const mid = strike("musical", { row: 1, col: 0 }, p).midi;
    const high = strike("musical", { row: 0, col: 0 }, p).midi;
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(strike("musical", { row: 1, col: 0 }, p).midi).toBeLessThan(
      strike("musical", { row: 1, col: 9 }, p).midi,
    );
  });

  test("musical mode puts a rising phrase higher on the screen", () => {
    const low = strike("musical", { row: 2, col: 0 }, p);
    const high = strike("musical", { row: 0, col: 9 }, p);
    expect(high.at.y).toBeLessThan(low.at.y);
  });

  test("spatial mode puts the key where the key is", () => {
    const left = strike("spatial", { row: 1, col: 0 }, p);
    const right = strike("spatial", { row: 1, col: 9 }, p);
    const top = strike("spatial", { row: 0, col: 4 }, p);
    const bottom = strike("spatial", { row: 2, col: 4 }, p);
    expect(left.at.x).toBeLessThan(right.at.x);
    expect(top.at.y).toBeLessThan(bottom.at.y);
    expect(left.pan).toBeLessThan(right.pan);
  });

  test("spatial mode's three pitches are octaves, so any chord is consonant", () => {
    const rows = [0, 1, 2].map((row) => strike("spatial", { row, col: 3 }, p).midi);
    for (const a of rows) for (const b of rows) expect(Math.abs(a - b) % 12).toBe(0);
  });

  test("catalogue mode gives every key its own voice, and the same one each time", () => {
    /* Deterministic is the half that matters: a catalogue you cannot learn is a
       random number generator with a keyboard attached. */
    const once = every().map((s) => JSON.stringify(strike("catalogue", s, p)));
    const twice = every().map((s) => JSON.stringify(strike("catalogue", s, p)));
    expect(once).toEqual(twice);
    /* And varied enough to be worth exploring — a catalogue where half the keys
       are the same patch is a catalogue with no discovery in it. */
    expect(new Set(once).size).toBeGreaterThan(20);
  });
});

/* ── the rings, the ring of palettes, and the figure ──────────────────────── */

describe("rings", () => {
  test("a tap leaves exactly one", () => {
    expect(rings(50, 50)).toEqual([50]);
  });

  test("a hold keeps emitting for as long as the key is down", () => {
    /* The visible half of tap-versus-hold. One ring that merely lasted longer
       would read as a slow animation rather than as something you are doing. */
    expect(rings(RING_MS * 3.5, RING_MS * 3.5).length).toBe(4);
  });

  test("nothing new is emitted after the key comes up", () => {
    const held = RING_MS * 2;
    const after = rings(held + RING_MS * 4, held);
    expect(after.length).toBeLessThanOrEqual(3);
  });

  test("a ring older than its life is gone", () => {
    expect(rings(9000, 50)).toEqual([]);
  });

  test("ages are oldest first, which is the order they are drawn in", () => {
    const ages = rings(RING_MS * 3, RING_MS * 3);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
  });
});

describe("palettes and modes", () => {
  test("the palette ring comes back round", () => {
    let at = PALETTES[0]!.id;
    for (let i = 0; i < PALETTES.length; i++) at = nextPalette(at).id;
    expect(at).toBe(PALETTES[0]!.id);
  });

  test("shift goes the other way", () => {
    expect(nextPalette(nextPalette(PALETTES[0]!.id, 1).id, -1).id).toBe(PALETTES[0]!.id);
  });

  test("an id nothing knows still answers with a palette", () => {
    /* Persisted state from an older build naming a palette since renamed. The
       frame loop must not be handed undefined. */
    expect(nextPalette("nothing-like-this", 1)).toBeDefined();
  });

  test("the mode ring comes back round too", () => {
    expect(nextMode(nextMode(nextMode("musical"))))!.toBe("musical");
  });

  test("every palette is distinct and labelled", () => {
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
    for (const p of PALETTES) expect(p.label.trim().length).toBeGreaterThan(0);
  });
});

describe("the figure", () => {
  test("octaves draw the same shape", () => {
    /* Which is the sort of thing you notice without being told, and the reason
       the ratio comes off the scale degree rather than off the frequency. */
    expect(figure(60, 48)).toEqual(figure(72, 48));
  });

  test("the ratio is always a small whole number, so the figure closes", () => {
    for (let m = 40; m < 90; m++) {
      const f = figure(m, 57);
      expect(Number.isInteger(f.a)).toBe(true);
      expect(Number.isInteger(f.b)).toBe(true);
      expect(f.a).toBeGreaterThan(0);
      expect(f.b).toBeGreaterThan(0);
      /* And never exactly closed: a rational ratio with no drift is a frozen
         picture, and the slow precession is most of why a scope is nice to look
         at. */
      expect(f.drift).toBeGreaterThan(0);
    }
  });
});

describe("hue", () => {
  test("it stays on the wheel however far a palette's spread walks it", () => {
    for (const h of [-720, -1, 0, 359, 360, 361, 1000]) {
      expect(wrapHue(h)).toBeGreaterThanOrEqual(0);
      expect(wrapHue(h)).toBeLessThan(360);
    }
  });
});
