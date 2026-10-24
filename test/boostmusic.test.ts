import { describe, expect, test } from "bun:test";
import {
  BARS,
  BUS_OF,
  Conductor,
  DOMINANT,
  DUCK_RELEASE_STEPS,
  FANFARE,
  FANFARE_HARMONY,
  inChord,
  LOOP,
  PICARDY,
  place,
  PROGRESSION,
  REST_STEPS,
  STEP_S,
  STEPS,
  THEME,
  type MomentKind,
  type Rendered,
} from "../src/lib/boostmusic";
import type { Intensity } from "../src/lib/boost";

/** Run a conductor to step `to`, queueing `kind` when it reaches `at`. */
function run(opts: { level?: Intensity; to: number; at?: number; kind?: MomentKind; ignite?: boolean }) {
  const c = new Conductor(opts.level ?? 3, { ignite: opts.ignite });
  const out: Rendered[] = [];
  let plan = null;
  while (c.step < opts.to) {
    if (opts.kind && c.step === opts.at) plan = c.queue(opts.kind);
    out.push(c.render());
  }
  return { out, plan, c };
}

const STINGERS = new Set(["brass", "boom", "fanfare", "harmony", "fill", "drone"]);

describe("the loop", () => {
  test("is the sketch's bit style, layer by layer", () => {
    const voicesAt = (L: Intensity) => new Set(run({ level: L, to: LOOP }).out.flatMap((r) => r.cues.map((c) => c.voice)));
    expect([...voicesAt(0)].sort()).toEqual(["heart", "pad"]);
    expect([...voicesAt(1)].sort()).toEqual(["bass", "heart", "pad"]);
    expect([...voicesAt(2)].sort()).toEqual(["bass", "hat", "heart", "pad", "snare", "stab", "thump"]);
    expect([...voicesAt(3)].sort()).toEqual(["bass", "hat", "heart", "lead", "pad", "snare", "stab", "thump"]);
  });

  test("plays every note of the theme, in order, over the eight bars", () => {
    const lead = run({ level: 3, to: LOOP }).out.flatMap((r) => r.cues.filter((c) => c.voice === "lead").map((c) => [c.step, c.midi]));
    expect(lead).toEqual(THEME.map(([s, m]) => [s, m]));
  });

  test("walks i VI VII V i VI iv V and comes round again", () => {
    const { out } = run({ to: 2 * LOOP });
    const bars = out.filter((r) => r.step % STEPS === 0).map((r) => r.bar.pos);
    expect(bars).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("every pitched loop note belongs to the bar's chord, except the theme's passing tones", () => {
    for (const r of run({ to: LOOP }).out)
      for (const c of r.cues)
        if (c.midi !== undefined && c.voice !== "lead") expect(inChord(c.midi, r.bar.chord)).toBe(true);
  });
});

describe("intensity", () => {
  test("a change asked for mid-bar waits for the bar line", () => {
    const c = new Conductor(0);
    const out: Rendered[] = [];
    while (c.step < 48) {
      if (c.step === 21) c.want(3);
      out.push(c.render());
    }
    const firstBass = out.find((r) => r.cues.some((q) => q.voice === "bass"))!;
    expect(firstBass.step).toBe(32);
    expect(out.slice(16, 32).every((r) => r.bar.level === 0)).toBe(true);
  });
});

describe("where a moment lands", () => {
  test("every moment, queued on any step, lands on a bar line and hands back on one", () => {
    for (const kind of ["ignite", "limit", "victory"] as const)
      for (let q = 0; q < LOOP; q++) {
        const p = place(kind, q);
        expect(p.land % STEPS).toBe(0);
        expect(p.until % STEPS).toBe(0);
        expect(p.from).toBeGreaterThanOrEqual(q);
        expect(p.land).toBeGreaterThanOrEqual(q);
      }
  });

  test("a limit break queued mid-bar lands on the next bar line, with a fill from the next beat", () => {
    expect(place("limit", 5)).toEqual({ kind: "limit", from: 8, land: 16, until: 32 });
    expect(place("limit", 8)).toEqual({ kind: "limit", from: 8, land: 16, until: 32 });
  });

  test("too late in the bar, the fill takes the whole next bar instead of being a flam", () => {
    expect(place("limit", 9)).toEqual({ kind: "limit", from: 16, land: 32, until: 48 });
    expect(place("limit", 16)).toEqual({ kind: "limit", from: 16, land: 32, until: 48 });
  });

  test("a fill is never shorter than two beats, and the wait is at most a bar and a half", () => {
    for (let q = 0; q < LOOP; q++) {
      const p = place("limit", q);
      expect(p.land - p.from).toBeGreaterThanOrEqual(8);
      expect(p.land - q).toBeLessThanOrEqual(STEPS + STEPS / 2);
    }
  });

  test("a victory takes the next bar line and two bars", () => {
    expect(place("victory", 3)).toEqual({ kind: "victory", from: 16, land: 16, until: 48 });
  });

  test("moments never overlap: the second waits for the first to hand back", () => {
    const c = new Conductor(3);
    for (let i = 0; i < 5; i++) c.render();
    const a = c.queue("limit")!;
    const b = c.queue("victory")!;
    expect(b.land).toBeGreaterThanOrEqual(a.until);
  });

  test("a limit arriving while the last one is still ringing is absorbed, and so is one in the rest after it", () => {
    const c = new Conductor(3);
    c.render();
    const first = c.queue("limit")!;
    while (c.step < first.land + 2) c.render();
    expect(c.queue("limit")).toBeNull();
    while (c.step < first.until + REST_STEPS - 1) c.render();
    expect(c.queue("limit")).toBeNull();
    c.render();
    const later = c.queue("limit")!;
    expect(later.from).toBeGreaterThanOrEqual(first.until + REST_STEPS);
  });

  test("a burst spread over ten seconds is one limit break", () => {
    const c = new Conductor(3);
    const placed = [];
    /* Four cards, 0, 2.5, 6 and 10 seconds apart. */
    const at = [0, 2.5, 6, 10].map((s) => Math.round(s / STEP_S));
    while (c.step < at[3] + 1) {
      if (at.includes(c.step)) placed.push(c.queue("limit"));
      c.render();
    }
    expect(placed.filter(Boolean).length).toBe(1);
  });

  test("a victory arriving during a limit break waits for it to hand back", () => {
    const c = new Conductor(3);
    c.render();
    const l = c.queue("limit")!;
    while (c.step < l.land + 3) c.render();
    const v = c.queue("victory")!;
    expect(v.land).toBe(l.until);
  });

  test("a burst of the same moment is one moment", () => {
    const c = new Conductor(3);
    c.render();
    expect(c.queue("limit")).not.toBeNull();
    expect(c.queue("limit")).toBeNull();
    expect(c.queue("limit")).toBeNull();
  });
});

describe("what a moment plays", () => {
  test("a limit break's fill climbs the chord under it and its hit is the chord it lands on", () => {
    for (let at = 0; at < LOOP; at += 3) {
      const { out, plan } = run({ to: at + 3 * STEPS, at, kind: "limit" });
      const fill = out.filter((r) => r.step >= plan!.from && r.step < plan!.land);
      for (const r of fill)
        for (const c of r.cues.filter((c) => c.voice === "fill")) expect(inChord(c.midi!, r.bar.chord)).toBe(true);
      const pitches = fill.flatMap((r) => r.cues.filter((c) => c.voice === "fill").map((c) => c.midi!));
      expect(pitches).toEqual([...pitches].sort((x, y) => x - y));
      const hit = out.find((r) => r.step === plan!.land)!;
      const brass = hit.cues.filter((c) => c.voice === "brass");
      expect(brass.length).toBeGreaterThan(0);
      for (const c of brass) expect(inChord(c.midi!, hit.bar.chord)).toBe(true);
      expect(hit.cues.some((c) => c.voice === "crash")).toBe(true);
    }
  });

  test("a victory is the dominant then the major tonic, and the loop picks up at its top", () => {
    const { out, plan } = run({ to: 4 * LOOP, at: 37, kind: "victory" });
    const bar1 = out.filter((r) => r.step >= plan!.land && r.step < plan!.land + STEPS);
    const bar2 = out.filter((r) => r.step >= plan!.land + STEPS && r.step < plan!.until);
    expect(bar1[0].bar.chord).toEqual(DOMINANT);
    expect(bar2[0].bar.chord).toEqual(PICARDY);
    for (const [bar, chord] of [[bar1, DOMINANT], [bar2, PICARDY]] as const)
      for (const r of bar)
        for (const c of r.cues) if (c.midi !== undefined) expect(inChord(c.midi, chord)).toBe(true);
    const fanfare = out.flatMap((r) => r.cues.filter((c) => c.voice === "fanfare").map((c) => [c.step - plan!.land, c.midi]));
    expect(fanfare).toEqual(FANFARE.map(([s, m]) => [s, m]));
    expect(out.flatMap((r) => r.cues.filter((c) => c.voice === "harmony")).length).toBe(FANFARE_HARMONY.length);
    /* No theme over the fanfare: the fanfare is the lead. */
    expect([...bar1, ...bar2].some((r) => r.cues.some((c) => c.voice === "lead"))).toBe(false);
    const after = out.find((r) => r.step === plan!.until)!;
    expect(after.bar.pos).toBe(0);
    expect(after.cues.some((c) => c.voice === "lead")).toBe(true);
  });

  test("ignite is a bar of riser on the dominant into the first downbeat of the loop", () => {
    const { out } = run({ to: 3 * STEPS, ignite: true });
    const riser = out.slice(0, STEPS);
    expect(riser.every((r) => r.bar.chord === DOMINANT && r.bar.muted)).toBe(true);
    expect(riser.some((r) => r.cues.some((c) => c.voice === "swell"))).toBe(true);
    expect(riser.some((r) => r.cues.some((c) => c.voice === "pad" || c.voice === "lead"))).toBe(false);
    for (const r of riser) for (const c of r.cues) if (c.midi !== undefined) expect(inChord(c.midi, DOMINANT)).toBe(true);
    const down = out[STEPS];
    expect(down.bar.pos).toBe(0);
    expect(down.bar.chord).toEqual(PROGRESSION[0]);
    expect(down.cues.some((c) => c.voice === "crash")).toBe(true);
  });

  test("no stinger makes a tritone with the bass on any downbeat it lands on", () => {
    for (const kind of ["limit", "victory"] as const)
      for (let at = 0; at < LOOP; at++) {
        const { out } = run({ to: at + 4 * STEPS, at, kind });
        for (const r of out.filter((r) => r.step % STEPS === 0)) {
          const bass = r.cues.filter((c) => c.voice === "bass").map((c) => c.midi!);
          const sting = r.cues.filter((c) => STINGERS.has(c.voice)).map((c) => c.midi!);
          for (const b of bass) for (const s of sting) expect(((s - b) % 12 + 12) % 12).not.toBe(6);
        }
      }
  });

  test("the drums keep time: nothing on the drum bus is ducked or silenced by a moment", () => {
    const plain = run({ level: 2, to: 4 * STEPS }).out;
    const moment = run({ level: 2, to: 4 * STEPS, at: 2, kind: "limit" }).out;
    const drums = (rs: Rendered[]) => rs.flatMap((r) => r.cues.filter((c) => BUS_OF[c.voice] === "drums").map((c) => `${c.voice}@${c.step}`));
    expect(drums(moment)).toEqual(drums(plain));
  });

  test("the duck goes down where the moment starts and is whole again on the bar line it hands back at", () => {
    for (const kind of ["limit", "victory"] as const) {
      const { out, plan } = run({ to: 5 * STEPS, at: 6, kind });
      const ducks = out.filter((r) => r.duck).map((r) => [r.step, r.duck]);
      expect(ducks).toEqual([
        [plan!.from, "down"],
        [plan!.until - DUCK_RELEASE_STEPS, "up"],
      ]);
      expect(plan!.until % STEPS).toBe(0);
    }
  });

  test("the progression has eight bars and every chord is a triad of A minor, with both sevenths", () => {
    expect(PROGRESSION.length).toBe(BARS);
    /* The natural seventh for VII (G), the raised one for V (E major's G#). */
    const key = [9, 11, 0, 2, 4, 5, 7, 8];
    for (const ch of PROGRESSION) for (const pc of [0, 1, 2]) expect(key).toContain((ch.root + [0, ch.quality === "minor" ? 3 : 4, 7][pc]) % 12);
  });
});
