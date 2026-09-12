/* The toy's live half: an audio graph, a worker, and the keyboard between them.
 *
 * `synth.ts` is the rules and `synth.worker.ts` is the drawing. This is the part
 * that can only exist in a running app — nodes, a clock, a canvas handed away —
 * and it is deliberately thin on judgement: almost everything it does with a
 * keypress is decided by a pure function next door.
 *
 * ### Why there is no Web Worker doing audio
 *
 * Because there is already a thread. The Web Audio graph is rendered by the
 * browser on its own real-time audio thread; the main thread only *schedules*,
 * and `AudioParam` automation is sample-accurate and booked ahead. Moving note
 * scheduling to a worker would buy nothing and cost the gesture its latency.
 * (Custom DSP would be different, and the tool for that is an `AudioWorklet` —
 * also a real-time thread — rather than a Worker. Nothing here needs one.)
 *
 * The *drawing* is the part that was on the main thread, and that is what went
 * to a worker. See the head of `synth.worker.ts` for what that does and does
 * not buy.
 *
 * ### Spotify keeps playing, and this is not a coincidence worth relying on
 *
 * `spotify.rs` runs librespot in-process and pushes PCM at WASAPI itself; this
 * is a WebAudio graph inside the webview, which is a separate WASAPI client.
 * Windows mixes them in shared mode, so the two coexist with no ducking, no
 * pausing and no code. It is worth knowing *why* it is free rather than
 * assuming it: anything that ever moved this app's audio into the same output
 * stream as librespot would have to answer the question properly.
 */

import {
  MAX_VOICES,
  PALETTES,
  allocate,
  figure,
  hz,
  nextMode,
  nextPalette,
  seat,
  strike,
  tailOf,
  type ModeId,
  type Palette,
  type Strike,
} from "./synth";
import type { ToWorker, VoiceView } from "./synth.worker";

/** How many samples the scope traces. A power of two because the analyser
 *  wants one, and 1024 because that is about two cycles of a low note — enough
 *  for the figure to close, few enough that the frame's message is 8KB. */
const FFT = 1024;

/** Peak gain of one voice. Low, because twelve of them can sound at once and
 *  the compressor on the master is there to catch chords rather than to be the
 *  thing that makes single notes quiet. */
const VOICE_PEAK = 0.16;

type Voice = {
  key: string | null;
  /** Audio-clock time the note started. */
  since: number;
  held: boolean;
  /** Seconds the key was down. Meaningless until `held` goes false. */
  heldFor: number;
  st: Strike | null;
  osc: OscillatorNode | null;
  sub: OscillatorNode | null;
  gain: GainNode | null;
  filter: BiquadFilterNode | null;
  pan: StereoPannerNode | null;
};

function blank(): Voice {
  return {
    key: null,
    since: 0,
    held: false,
    heldFor: 0,
    st: null,
    osc: null,
    sub: null,
    gain: null,
    filter: null,
    pan: null,
  };
}

export class Synth {
  /** Whether the toy is up. The overlay is `{#if}`d on this, so closing it
   *  destroys the canvas — which is also what makes `transferControlToOffscreen`
   *  safe to call on mount, since it may only ever be called once per element. */
  on = $state(false);

  mode = $state<ModeId>("musical");
  palette = $state<Palette>(PALETTES[0]!);

  /** What the last gesture changed, shown for a moment and then gone. A toy
   *  with a permanent status bar is a tool; this says what you just did and
   *  gets out of the way. */
  said = $state<string | null>(null);
  #saidFor: ReturnType<typeof setTimeout> | null = null;

  /** Something went wrong that the toy can survive but you should be told
   *  about. Unlike `said` this does not clear itself — it is describing a state
   *  the toy is *in* rather than a gesture you just made, and a black screen
   *  that explained itself for one second and then went back to being a black
   *  screen would be worse than one that never explained itself at all. */
  fault = $state<string | null>(null);

  #ac: AudioContext | null = null;
  #bus: GainNode | null = null;
  #master: GainNode | null = null;
  #anL: AnalyserNode | null = null;
  #anR: AnalyserNode | null = null;
  #xs = new Float32Array(FFT);
  #ys = new Float32Array(FFT);

  #worker: Worker | null = null;
  #raf: number | null = null;
  #ro: ResizeObserver | null = null;

  #slots: Voice[] = Array.from({ length: MAX_VOICES }, blank);
  /** Keys currently down, so auto-repeat and a key held across a mode change
   *  cannot open a second voice for the same finger. */
  #down = new Set<string>();

  /* ── opening and closing ──────────────────────────────────────────────── */

  toggle() {
    if (this.on) this.hide();
    else this.show();
  }

  show() {
    if (this.on) return;
    this.on = true;
    this.#say(`${this.palette.label} · ${this.mode}`);
  }

  hide() {
    if (!this.on) return;
    this.on = false;
    this.#teardown();
  }

  /** Everything this holds, released. Called on close and from `App`'s
   *  `onDestroy`, because a class with no lifecycle that owns a worker, an
   *  `AudioContext` and a `requestAnimationFrame` is three leaks wearing one
   *  name. */
  release() {
    this.hide();
  }

  #teardown() {
    for (const k of [...this.#down]) this.#lift(k);
    this.#down.clear();
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#ro?.disconnect();
    this.#ro = null;
    if (this.#worker) {
      this.#worker.postMessage({ type: "stop" } satisfies ToWorker);
      this.#worker.terminate();
      this.#worker = null;
    }
    /* Close rather than suspend. A suspended context still holds an audio
       device open, and this is a toy you shut — leaving the wall holding a
       render thread for something nobody can see is exactly the class of thing
       `processes.md` is about, one layer up. */
    void this.#ac?.close().catch(() => {});
    this.#ac = null;
    this.#bus = this.#master = null;
    this.#anL = this.#anR = null;
    this.#slots = Array.from({ length: MAX_VOICES }, blank);
    if (this.#saidFor !== null) clearTimeout(this.#saidFor);
    this.#saidFor = null;
    this.said = null;
    this.fault = null;
  }

  /* ── the canvas ───────────────────────────────────────────────────────── */

  /** Hand the canvas to the renderer. Called from the component's `{@attach}`,
   *  and the returned function is the detach.
   *
   *  **Guarded against running twice over one element**, which is the one thing
   *  here that would throw rather than degrade: `transferControlToOffscreen`
   *  may be called once per canvas and raises on the second, and a second
   *  `#loop` would leave a `requestAnimationFrame` nothing holds the handle to.
   *  Svelte runs an attachment's cleanup before re-running it, so this should
   *  not happen — but "should not" is doing the work in that sentence, and the
   *  cost of being wrong is an exception inside an effect, which takes the wall
   *  down with the toy. */
  attach(el: HTMLCanvasElement): () => void {
    if (this.#worker) return () => this.#teardown();

    let off: OffscreenCanvas;
    try {
      off = el.transferControlToOffscreen();
    } catch {
      /* Already handed away — this canvas has a renderer and it is not this
         call's. Nothing to clean up, because nothing was started. */
      return () => {};
    }

    const w = new Worker(new URL("./synth.worker.ts", import.meta.url), { type: "module" });
    /* The one failure that would otherwise be a black rectangle and no
       explanation. A module worker that cannot be fetched fires `error` on the
       Worker rather than throwing here, so without this the picture simply
       never arrives and the toy looks broken rather than degraded. The audio is
       on this thread and goes on working, which is why this reports rather than
       closing: half a toy you understand beats a whole one you do not. */
    w.onerror = () => {
      this.fault = "the renderer did not start — sound only";
    };
    w.postMessage({ type: "init", canvas: off } satisfies ToWorker, [off]);
    this.#worker = w;

    const size = () => {
      const r = el.getBoundingClientRect();
      w.postMessage({
        type: "size",
        w: r.width,
        h: r.height,
        /* Capped, because this is a full-screen canvas presenting every frame
           and the pixel count is the one term here that is quadratic in it. At
           150% scaling on a 4K panel an uncapped dpr is 2.25× the pixels of a
           1.5× one for a picture made of glows, which is the one kind that
           cannot show the difference. */
        dpr: Math.min(window.devicePixelRatio || 1, 1.5),
      } satisfies ToWorker);
    };
    size();
    this.#ro = new ResizeObserver(size);
    this.#ro.observe(el);

    this.#audio();
    this.#loop();

    return () => this.#teardown();
  }

  /* ── the graph ────────────────────────────────────────────────────────── */

  #audio() {
    if (this.#ac) return;
    /* `interactive` is the whole latency argument in one option: it asks the
       platform for the smallest buffer it will give, which is what keeps the
       gap between a key going down and a sound starting under the threshold
       where this stops feeling like an instrument. */
    const ac = new AudioContext({ latencyHint: "interactive" });
    void ac.resume().catch(() => {});

    const bus = ac.createGain();
    bus.gain.value = 1;

    /* A delay fed back on itself, at a level that decays rather than rings. It
       is the audio counterpart of the renderer's feedback pass and it is here
       for the same reason: it turns a handful of notes into something that
       sounds like a place. */
    const delay = ac.createDelay(1.5);
    delay.delayTime.value = 0.28;
    const fb = ac.createGain();
    fb.gain.value = 0.34;
    const wet = ac.createGain();
    wet.gain.value = 0.38;
    /* Rolled off, or the repeats get brighter than the note that made them and
       the tail turns into hiss. */
    const damp = ac.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2600;

    bus.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);

    const master = ac.createGain();
    master.gain.value = 0.9;
    bus.connect(master);
    wet.connect(master);

    /* Catches chords rather than single notes — twelve voices at once is the
       case that would clip, and a limiter is a better answer than making every
       note quiet enough that twelve of them fit. */
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ac.destination);

    /* Two analysers off the *post*-everything signal, one per channel, because
       the scope is meant to draw what you are hearing — delay tail included —
       rather than what was played. X and Y of a Lissajous figure. */
    const split = ac.createChannelSplitter(2);
    comp.connect(split);
    const anL = ac.createAnalyser();
    const anR = ac.createAnalyser();
    anL.fftSize = FFT;
    anR.fftSize = FFT;
    split.connect(anL, 0);
    split.connect(anR, 1);

    this.#ac = ac;
    this.#bus = bus;
    this.#master = master;
    this.#anL = anL;
    this.#anR = anR;
  }

  /* ── the frame ────────────────────────────────────────────────────────── */

  /** Driven from here rather than from the worker's own `requestAnimationFrame`,
   *  and the reason is the one thing that cannot move: `AnalyserNode` lives on
   *  this side of the wire. So each frame reads two buffers and posts them, and
   *  the worker draws on receipt. The cost on this thread is two array reads and
   *  a structured clone of 8KB — microseconds — and everything expensive is on
   *  the other side of the message. */
  #loop() {
    const step = () => {
      this.#raf = requestAnimationFrame(step);
      const ac = this.#ac;
      const w = this.#worker;
      if (!ac || !w || !this.#anL || !this.#anR) return;

      this.#anL.getFloatTimeDomainData(this.#xs);
      this.#anR.getFloatTimeDomainData(this.#ys);

      let sum = 0;
      for (let i = 0; i < FFT; i++) sum += this.#xs[i]! * this.#xs[i]!;
      const loud = Math.min(1, Math.sqrt(sum / FFT) * 6);

      const now = ac.currentTime;
      const voices: VoiceView[] = [];
      for (const v of this.#slots) {
        if (!v.st) continue;
        const since = now - v.since;
        const held = v.held ? since : v.heldFor;
        /* Reaped here rather than on a timer: the frame loop is already the
           thing that knows how long ago every note was, and a `setTimeout` per
           note is a second clock saying the same thing worse. */
        if (!v.held && since > held + tailOf(v.st.env, held * 1000) + 0.1) {
          this.#free(v);
          continue;
        }
        voices.push({
          hue: v.st.hue,
          x: v.st.at.x,
          y: v.st.at.y,
          since,
          held,
          down: v.held,
          env: v.st.env,
          fig: figure(v.st.midi, this.palette.root),
        });
      }

      w.postMessage({ type: "frame", voices, xs: this.#xs, ys: this.#ys, loud } satisfies ToWorker);
    };
    this.#raf = requestAnimationFrame(step);
  }

  /* ── the keyboard ─────────────────────────────────────────────────────── */

  /** Every keydown while the toy is up. Returns nothing — the component has
   *  already decided this key is ours, because the overlay swallows the whole
   *  keyboard while it is open. */
  press(e: KeyboardEvent) {
    /* Auto-repeat is a key that is still down, not a new note. Without this a
       held letter opens thirty voices a second and the allocator spends the
       whole board on one finger. */
    if (e.repeat) return;

    if (e.key === "Escape") {
      this.hide();
      return;
    }
    if (e.key === " ") {
      this.palette = nextPalette(this.palette.id, e.shiftKey ? -1 : 1);
      this.#say(this.palette.label);
      return;
    }
    if (e.key === "Tab") {
      this.mode = nextMode(this.mode, e.shiftKey ? -1 : 1);
      this.#say(this.mode);
      return;
    }

    const s = seat(e.key);
    if (!s) return;
    const k = e.key.toLowerCase();
    if (this.#down.has(k)) return;
    this.#down.add(k);
    this.#strike(k, strike(this.mode, s, this.palette));
  }

  lift(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (!this.#down.delete(k)) return;
    this.#lift(k);
  }

  /** A key that never got its keyup because the window lost focus. Alt+Tab away
   *  mid-chord and the note would otherwise sustain forever with nothing on the
   *  keyboard able to stop it. */
  allOff() {
    for (const k of [...this.#down]) this.#lift(k);
    this.#down.clear();
  }

  #say(what: string) {
    this.said = what;
    if (this.#saidFor !== null) clearTimeout(this.#saidFor);
    this.#saidFor = setTimeout(() => {
      this.#saidFor = null;
      this.said = null;
    }, 1100);
  }

  /* ── notes ────────────────────────────────────────────────────────────── */

  #strike(key: string, st: Strike) {
    const ac = this.#ac;
    const bus = this.#bus;
    if (!ac || !bus) return;
    const t = ac.currentTime;

    const at = allocate(
      this.#slots.map((v) => ({ key: v.key, since: v.since, held: v.held })),
      key,
    );
    const v = this.#slots[at]!;
    /* Taking a slot that is still sounding, without the click. Ramping the old
       gain to zero over a few milliseconds rather than stopping the oscillator
       outright is the whole of it: a level cut to zero from anywhere above it is
       a step discontinuity, which is exactly what a click is. */
    if (v.gain) this.#stop(v, t, 0.008);

    const osc = ac.createOscillator();
    osc.type = st.wave;
    osc.frequency.setValueAtTime(hz(st.midi), t);

    /* A second oscillator an octave down and slightly out of tune. The detune
       is what makes one oscillator sound like an instrument rather than a test
       tone — two copies beating against each other is most of what "warm"
       means — and the octave gives the low end something to stand on. */
    const sub = ac.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(hz(st.midi - 12), t);
    sub.detune.setValueAtTime(6, t);

    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    const cut = this.palette.cutoff + st.bright * this.palette.open;
    /* The filter opens with the attack and closes again with the decay, which
       is the single most recognisable thing a subtractive synth does: a note
       that is brighter at its start than in its middle reads as struck rather
       than as faded up. */
    filter.frequency.setValueAtTime(cut * 0.45, t);
    filter.frequency.linearRampToValueAtTime(cut * 1.6, t + st.env.attack + 0.005);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(90, cut * 0.5),
      t + st.env.attack + st.env.decay,
    );

    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(VOICE_PEAK, t + st.env.attack);
    gain.gain.linearRampToValueAtTime(
      VOICE_PEAK * st.env.sustain,
      t + st.env.attack + st.env.decay,
    );

    const pan = ac.createStereoPanner();
    pan.pan.setValueAtTime(Math.max(-1, Math.min(1, st.pan)), t);

    const subGain = ac.createGain();
    subGain.gain.value = 0.35;

    osc.connect(filter);
    sub.connect(subGain);
    subGain.connect(filter);
    filter.connect(gain);
    gain.connect(pan);
    pan.connect(bus);
    osc.start(t);
    sub.start(t);

    v.key = key;
    v.since = t;
    v.held = true;
    v.heldFor = 0;
    v.st = st;
    v.osc = osc;
    v.sub = sub;
    v.gain = gain;
    v.filter = filter;
    v.pan = pan;
  }

  #lift(key: string) {
    const ac = this.#ac;
    if (!ac) return;
    const v = this.#slots.find((s) => s.key === key && s.held);
    if (!v || !v.st) return;
    const t = ac.currentTime;
    v.held = false;
    v.heldFor = Math.max(0, t - v.since);
    /* Which release it gets is decided by how long the key was down — see
       `gesture` and the head of `synth.ts`. A tap is a pluck; a hold rings out.
       `tailOf` is the same function the renderer's reap and the envelope both
       use, so the sound, the picture and the slot all end together. */
    this.#stop(v, t, tailOf(v.st.env, v.heldFor * 1000));
  }

  /** Ramp a voice down over `span` and schedule its oscillators to stop.
   *
   *  `setValueAtTime(gain.value, t)` before the ramp is the load-bearing line:
   *  it pins the curve to wherever the attack or decay had actually got to, so
   *  a note released mid-attack falls from there rather than jumping to full
   *  and back down. Cancelling without pinning is the classic Web Audio click. */
  #stop(v: Voice, t: number, span: number) {
    const g = v.gain;
    if (!g) return;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + Math.max(0.006, span));
    const end = t + Math.max(0.006, span) + 0.02;
    try {
      v.osc?.stop(end);
      v.sub?.stop(end);
    } catch {
      /* Already stopped. An oscillator is one-shot and stopping one twice
         throws; there is nothing to do about it and nothing to report. */
    }
  }

  /** Let go of a finished voice's nodes. `OscillatorNode` is one-shot, so a
   *  slot is never reused — it is emptied and filled with new nodes. */
  #free(v: Voice) {
    try {
      v.pan?.disconnect();
      v.gain?.disconnect();
      v.filter?.disconnect();
      v.osc?.disconnect();
      v.sub?.disconnect();
    } catch {
      /* Disconnecting something already gone is not a failure. */
    }
    v.key = null;
    v.st = null;
    v.osc = v.sub = null;
    v.gain = null;
    v.filter = null;
    v.pan = null;
    v.held = false;
  }
}
