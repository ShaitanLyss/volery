/** Boost's score as sound: the Web Audio half of `boostmusic.ts`.
 *
 *  The conductor there decides every note; this owns the clock, the context,
 *  the three buses, the duck and the gate. It plays only while boost is on,
 *  the chime is enabled and nobody has said they are away — Lyss's "dynamic
 *  music (when chime is enabled)", and away mode's rule that being away
 *  mutes the whole notification ladder (`away.md`). The reasoning is in
 *  `.claude/rules/boost-music.md`. */

import { boost } from "./boost.svelte";
import type { Intensity } from "./boost";
import {
  BUS_OF,
  Conductor,
  DUCK_ATTACK_S,
  DUCK_DB,
  DUCK_RELEASE_STEPS,
  duckGain,
  STEP_S,
  type Bus,
  type Cue,
  type MomentKind,
} from "./boostmusic";

/** How far ahead of the context's clock steps are committed, and how often
 *  the scheduler wakes to commit them. A moment queued now lands on a bar line
 *  past the lookahead, so this is also the most a moment can be late by. */
const LOOKAHEAD_S = 0.2;
const TICK_MS = 25;
/** The gate's fade either way. */
const FADE_S = 1;
/** A context shut this long is closed, so a wall that turned boost off an hour
 *  ago is not holding an audio device open. */
const CLOSE_AFTER_MS = 30_000;
/** An ignite heard this recently when the gate opens makes the score enter on
 *  its riser instead of fading in — see `#open`. */
const IGNITE_FRESH_MS = 3_000;

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

type Nodes = {
  ctx: AudioContext;
  fade: GainNode;
  verb: ConvolverNode;
  /** Each bus is two inputs, dry and reverb send, because the duck has to take
   *  a voice's tail down with it — a reverb return the duck did not reach is a
   *  ducked loop still washing under the moment. */
  buses: Record<Bus, { dry: GainNode; send: GainNode }>;
  pulse: PeriodicWave;
  noise: AudioBuffer;
  meter: AnalyserNode;
  momentMeter: AnalyserNode;
};

/** What `reading` answers: enough for a lab run to see whether the score is
 *  sounding and when its moments land, since a sound has no DOM. */
export type ScoreReading = {
  open: boolean;
  running: boolean;
  state: AudioContextState | "none";
  now: number;
  t0: number;
  step: number;
  stepS: number;
  level: Intensity;
  placed: { kind: MomentKind; fromAt: number; landAt: number; untilAt: number }[];
  /** [context time, peak] every tick, the whole mix and the moment bus. */
  peaks: [number, number, number][];
};

export class BoostScore {
  #n: Nodes | null = null;
  #conductor: Conductor | null = null;
  #t0 = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #open = false;
  #level: Intensity = 0;
  #duckLevel = 1;
  #igniteAt = -Infinity;
  #placed: ScoreReading["placed"] = [];
  #peaks: ScoreReading["peaks"] = [];
  #buf: Float32Array | null = null;
  #release: (() => void) | null = null;

  /** Start following the wall. `chime` and `away` are injected because both
   *  live on instances `App.svelte` builds; the switch and the intensity are
   *  `boost`'s. Returns the release, which `App.svelte`'s `onDestroy` calls —
   *  a superseded generation's scheduler would otherwise go on playing. */
  attach(deps: { chime: () => boolean; away: () => boolean }): () => void {
    this.release();
    const unlisten = boost.listen((m) => this.#moment(m.kind));
    const unroot = $effect.root(() => {
      $effect(() => {
        const open = boost.on && deps.chime() && !deps.away();
        this.#set(open, boost.intensity);
      });
    });
    const wake = () => {
      if (this.#n && this.#n.ctx.state === "suspended") void this.#n.ctx.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    this.#release = () => {
      unlisten();
      unroot();
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
    };
    return () => this.release();
  }

  release() {
    this.#release?.();
    this.#release = null;
    this.#halt();
    this.#close();
  }

  get reading(): ScoreReading {
    const n = this.#n;
    return {
      open: this.#open,
      running: this.#timer !== null,
      state: n ? n.ctx.state : "none",
      now: n ? n.ctx.currentTime : 0,
      t0: this.#t0,
      step: this.#conductor?.step ?? 0,
      stepS: STEP_S,
      level: this.#level,
      placed: [...this.#placed],
      peaks: [...this.#peaks],
    };
  }

  #set(open: boolean, level: Intensity) {
    this.#level = level;
    this.#conductor?.want(level);
    if (open === this.#open) return;
    this.#open = open;
    if (open) this.#start();
    else this.#fadeOut();
  }

  #moment(kind: MomentKind) {
    if (kind === "ignite") this.#igniteAt = Date.now();
    if (!this.#open || !this.#conductor) return;
    const plan = this.#conductor.queue(kind);
    if (!plan) return;
    const at = (k: number) => this.#t0 + k * STEP_S;
    this.#placed = [...this.#placed, { kind, fromAt: at(plan.from), landAt: at(plan.land), untilAt: at(plan.until) }].slice(-8);
  }

  #start() {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    const n = this.#nodes();
    if (!n) return;
    void n.ctx.resume().catch(() => {});
    this.#ramp(n.fade.gain, 1, FADE_S);
    /* Still sounding — the gate shut and opened again inside its fade — so
       the score carries on where it was rather than starting over. */
    if (this.#timer) return;
    const ignite = Date.now() - this.#igniteAt < IGNITE_FRESH_MS;
    this.#conductor = new Conductor(this.#level, { ignite });
    this.#t0 = n.ctx.currentTime + 0.08;
    this.#duckLevel = 1;
    for (const b of Object.values(n.buses)) for (const g of [b.dry, b.send]) {
      g.gain.cancelScheduledValues(0);
      g.gain.value = 1;
    }
    this.#placed = [];
    if (ignite) {
      const p = this.#conductor.plans[0];
      const at = (k: number) => this.#t0 + k * STEP_S;
      if (p) this.#placed = [{ kind: "ignite", fromAt: at(p.from), landAt: at(p.land), untilAt: at(p.until) }];
    }
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
    this.#tick();
  }

  #fadeOut() {
    const n = this.#n;
    if (!n) return;
    this.#ramp(n.fade.gain, 0, FADE_S);
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => {
      this.#stopTimer = null;
      this.#halt();
      this.#closeTimer = setTimeout(() => this.#close(), CLOSE_AFTER_MS);
    }, FADE_S * 1000 + 150);
  }

  /** Move a gain to `to` over `s`, from wherever it is now. The pin first:
   *  a ramp scheduled without one starts from the last *scheduled* value, and
   *  a gain jumping to that is a click (`toys.md`, the two Web Audio traps). */
  #ramp(p: AudioParam, to: number, s: number) {
    const now = this.#n!.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(to, now + s);
  }

  #halt() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
    this.#conductor = null;
  }

  #close() {
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    const n = this.#n;
    this.#n = null;
    if (n) void n.ctx.close().catch(() => {});
  }

  #tick() {
    const n = this.#n;
    const c = this.#conductor;
    if (!n || !c) return;
    const now = n.ctx.currentTime;
    while (this.#t0 + c.step * STEP_S < now + LOOKAHEAD_S) {
      const r = c.render();
      const t = this.#t0 + r.step * STEP_S;
      /* A step the scheduler reached too late — the window was throttled, or
         the context resumed after a while suspended — is skipped rather than
         played in a heap at once. */
      if (t < now - 0.02) continue;
      if (r.duck) this.#duck(r.duck, t);
      for (const cue of r.cues) this.#play(cue, t + cue.at * STEP_S);
    }
    this.#meter(n, now);
  }

  #meter(n: Nodes, now: number) {
    const peak = (a: AnalyserNode) => {
      if (!this.#buf || this.#buf.length !== a.fftSize) this.#buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(this.#buf);
      let p = 0;
      for (const v of this.#buf) p = Math.max(p, Math.abs(v));
      return p;
    };
    this.#peaks.push([now, peak(n.meter), peak(n.momentMeter)]);
    if (this.#peaks.length > 400) this.#peaks.splice(0, this.#peaks.length - 400);
  }

  #duck(dir: "down" | "up", t: number) {
    const n = this.#n!;
    const to = dir === "down" ? duckGain(DUCK_DB) : 1;
    const over = dir === "down" ? DUCK_ATTACK_S : DUCK_RELEASE_STEPS * STEP_S;
    for (const g of [n.buses.music.dry, n.buses.music.send]) {
      /* Pinned at what the curve will be at `t`, which is the last level a
         duck aimed at — the duck holds still between its own ramps. */
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(this.#duckLevel, t);
      g.gain.linearRampToValueAtTime(to, t + over);
    }
    this.#duckLevel = to;
  }

  #nodes(): Nodes | null {
    if (this.#n) return this.#n;
    try {
      const Ctx =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      const master = ctx.createGain();
      master.gain.value = 0.5;
      const fade = ctx.createGain();
      fade.gain.value = 0;
      master.connect(comp);
      comp.connect(fade);
      fade.connect(ctx.destination);
      const meter = ctx.createAnalyser();
      meter.fftSize = 1024;
      fade.connect(meter);

      const verb = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 2.8);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      }
      verb.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.32;
      verb.connect(wet);
      wet.connect(master);

      const bus = () => {
        const dry = ctx.createGain();
        const send = ctx.createGain();
        dry.connect(master);
        send.connect(verb);
        return { dry, send };
      };
      const buses = { music: bus(), drums: bus(), moment: bus() };
      const momentMeter = ctx.createAnalyser();
      momentMeter.fftSize = 1024;
      buses.moment.dry.connect(momentMeter);

      /* A quarter-duty pulse, the NES/SNES bass colour, as a Fourier series. */
      const N = 32;
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      for (let k = 1; k < N; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25);
      const pulse = ctx.createPeriodicWave(re, im);
      const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

      this.#n = { ctx, fade, verb, buses, pulse, noise, meter, momentMeter };
      return this.#n;
    } catch {
      /* No audio device is not an error worth surfacing. */
      return null;
    }
  }

  #play(cue: Cue, t: number) {
    const sp = STEP_S;
    const dur = cue.len * sp;
    const bus = BUS_OF[cue.voice];
    const v = cue.vel;
    const m = cue.midi ?? 0;
    switch (cue.voice) {
      case "pad":
        /* The sketch's pad, opened up: a third oscillator at the centre and a
           filter that blooms over the attack, so the bar line breathes rather
           than retriggers. Same notes, same level. */
        return this.#tone({ t, m, dur, bus, wave: "sawtooth", det: [-8, 0, 8], gain: 0.05 * v, cut: 900, bloom: 1800, a: 0.12, rel: 0.35, send: 0.4, pan: -0.2 });
      case "drone":
        return this.#tone({ t, m, dur, bus, wave: "sawtooth", det: [-8, 0, 8], gain: 0.06 * v, cut: 500, bloom: 2600, a: dur * 0.85, rel: 0.1, send: 0.45, pan: -0.15 });
      case "heart":
        return this.#drum({ t, bus, f0: 110, f1: 55, dur: 0.25, gain: 0.32 * v, send: 0.15 });
      case "thump":
        return this.#drum({ t, bus, f0: 150, f1: 48, dur: 0.18, gain: 0.55 * v });
      case "bass":
        return this.#tone({ t, m, dur, bus, wave: "pulse", gain: 0.13 * v, cut: 2400, rel: 0.03, pan: 0.1 });
      case "snare":
        return this.#noise({ t, bus, f: 1400, dur: 0.12, gain: 0.24 * v, send: 0.2, ft: "bandpass", q: 0.6 });
      case "hat":
        return this.#noise({ t, bus, f: 7000, dur: 0.03, gain: 0.05 * v, pan: 0.3 });
      case "stab":
        return this.#tone({ t, m, dur, bus, wave: "sawtooth", det: [-6, 6], gain: 0.07 * v, cut: 3000, rel: 0.12, send: 0.3, pan: 0.25 });
      case "lead":
        return this.#tone({ t, m, dur, bus, wave: "square", gain: 0.085 * v, cut: 5200, vib: 14, rel: 0.06, send: 0.25, pan: -0.1 });
      case "fill":
        return this.#tone({ t, m, dur, bus, wave: "sawtooth", det: [-6, 6], gain: 0.085 * v, cut: 5500, rel: 0.04, send: 0.3, pan: 0.15 });
      case "roll":
        return this.#noise({ t, bus, f: 1500, dur: 0.07, gain: 0.22 * v, send: 0.2, ft: "bandpass", q: 0.7 });
      case "crash":
        return this.#noise({ t, bus, f: 5200, dur, gain: 0.15 * v, send: 0.6 });
      case "boom":
        return this.#drum({ t, bus, f0: hz(m) * 2.4, f1: hz(m - 12), drop: 0.08, dur: 1.1, gain: 0.65 * v, send: 0.35 });
      case "brass":
        /* Brass, as far as three saws go: the filter snaps open and settles,
           which is the "blat" a horn section's attack has. */
        return this.#tone({ t, m, dur, bus, wave: "sawtooth", det: [-10, 0, 10], gain: 0.075 * v, cut: 700, blat: 3800, settle: 1300, a: 0.012, rel: 0.6, send: 0.5 });
      case "fanfare":
        return this.#tone({ t, m, dur, bus, wave: "square", gain: 0.1 * v, cut: 5200, vib: cue.len >= 5 ? 16 : 0, rel: 0.1, send: 0.35 });
      case "harmony":
        return this.#tone({ t, m, dur, bus, wave: "pulse", gain: 0.07 * v, cut: 3200, rel: 0.1, send: 0.3, pan: 0.2 });
      case "swell":
        return this.#swell(t, dur, bus);
    }
  }

  #route(node: AudioNode, bus: Bus, pan = 0, send = 0) {
    const n = this.#n!;
    const p = n.ctx.createStereoPanner();
    p.pan.value = pan;
    node.connect(p);
    p.connect(n.buses[bus].dry);
    if (send) {
      const s = n.ctx.createGain();
      s.gain.value = send;
      p.connect(s);
      s.connect(n.buses[bus].send);
    }
  }

  #env(g: GainNode, t: number, a: number, peak: number, hold: number, rel: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }

  #tone(o: {
    t: number; m: number; dur: number; bus: Bus; wave: "sawtooth" | "square" | "pulse";
    det?: number[]; gain: number; cut: number; bloom?: number; blat?: number; settle?: number;
    a?: number; rel?: number; vib?: number; send?: number; pan?: number;
  }) {
    const ctx = this.#n!.ctx;
    const a = o.a ?? 0.005;
    const rel = o.rel ?? 0.08;
    const end = o.t + o.dur + rel + 0.05;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 0.7;
    f.frequency.setValueAtTime(o.cut, o.t);
    if (o.bloom) f.frequency.exponentialRampToValueAtTime(o.bloom, o.t + a + 0.3);
    if (o.blat) {
      f.frequency.exponentialRampToValueAtTime(o.blat, o.t + 0.06);
      f.frequency.exponentialRampToValueAtTime(o.settle ?? o.cut, o.t + o.dur + rel);
    }
    const g = ctx.createGain();
    f.connect(g);
    this.#route(g, o.bus, o.pan, o.send);
    const dets = o.det ?? [0];
    for (const dt of dets) {
      const os = ctx.createOscillator();
      if (o.wave === "pulse") os.setPeriodicWave(this.#n!.pulse);
      else os.type = o.wave;
      os.frequency.setValueAtTime(hz(o.m), o.t);
      os.detune.value = dt;
      if (o.vib) {
        const l = ctx.createOscillator();
        const lg = ctx.createGain();
        l.frequency.value = 5.6;
        lg.gain.value = o.vib;
        l.connect(lg);
        lg.connect(os.detune);
        l.start(o.t + 0.15);
        l.stop(end);
      }
      os.connect(f);
      os.start(o.t);
      os.stop(end);
    }
    this.#env(g, o.t, a, o.gain / Math.sqrt(dets.length), Math.max(0, o.dur - a), rel);
  }

  #noise(o: { t: number; bus: Bus; f: number; dur: number; gain: number; send?: number; pan?: number; ft?: BiquadFilterType; q?: number }) {
    const n = this.#n!;
    const s = n.ctx.createBufferSource();
    s.buffer = n.noise;
    const f = n.ctx.createBiquadFilter();
    f.type = o.ft ?? "highpass";
    f.frequency.value = o.f;
    f.Q.value = o.q ?? 0.7;
    const g = n.ctx.createGain();
    s.connect(f);
    f.connect(g);
    this.#route(g, o.bus, o.pan, o.send);
    this.#env(g, o.t, 0.001, o.gain, 0, o.dur);
    s.start(o.t, Math.random() * 0.4);
    s.stop(o.t + o.dur + 0.1);
  }

  #drum(o: { t: number; bus: Bus; f0: number; f1: number; drop?: number; dur: number; gain: number; send?: number }) {
    const ctx = this.#n!.ctx;
    const os = ctx.createOscillator();
    os.type = "sine";
    os.frequency.setValueAtTime(o.f0, o.t);
    os.frequency.exponentialRampToValueAtTime(o.f1, o.t + (o.drop ?? 0.09));
    const g = ctx.createGain();
    os.connect(g);
    this.#route(g, o.bus, 0, o.send);
    this.#env(g, o.t, 0.002, o.gain, 0, o.dur);
    os.start(o.t);
    os.stop(o.t + o.dur + 0.05);
  }

  /** The riser: noise through a band that climbs four octaves while it grows,
   *  cut off on the downbeat it was rising to. */
  #swell(t: number, dur: number, bus: Bus) {
    const n = this.#n!;
    const s = n.ctx.createBufferSource();
    s.buffer = n.noise;
    s.loop = true;
    const f = n.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = n.ctx.createGain();
    s.connect(f);
    f.connect(g);
    this.#route(g, bus, 0, 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.03);
    s.start(t);
    s.stop(t + dur + 0.1);
  }
}

export const boostScore = new BoostScore();
