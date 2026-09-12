/// <reference lib="webworker" />
/* The toy's renderer, on a thread of its own.
 *
 * It is here rather than in the component for one reason, and it is worth being
 * precise about which: **not** that the drawing is expensive. `motion.ts` has
 * the measurement and the dominant term on this GPU is the *present rate*, not
 * the painted area — a worker does not make a continuously animating full-screen
 * canvas cheaper. What it buys is that the main thread stays free while you
 * play, so cards go on ingesting events and painting behind the toy instead of
 * competing with a 60Hz frame loop for the one thread that also drains the
 * Tauri event queue.
 *
 * So the contract is: this file never touches the DOM, never calls an invoke,
 * and receives everything it draws. It is handed an `OffscreenCanvas` once and
 * a frame's worth of state per frame, and the audio graph it is drawing stays
 * on the other side — the only thing that crosses is two arrays of samples.
 *
 * **The frame loop is not here**, and the reason is the one thing that could
 * not move: `AnalyserNode` lives on the main thread, so the samples have to be
 * read there anyway. A worker running its own `requestAnimationFrame` would
 * still need a message per frame to get them, and would then be drawing
 * whatever arrived last rather than what was read for this frame. So main reads
 * and posts, and this draws on receipt — one message per frame, in one
 * direction, and no way for the picture and the sound to be a frame apart.
 */

import { envelopeAt, rings, wrapHue, type Envelope } from "./synth";

/** One voice, as much of it as a picture needs. Built on the audio side and
 *  sent whole each frame — small enough (a dozen numbers, twelve voices) that
 *  structured-cloning it is not worth optimising away. */
export type VoiceView = {
  hue: number;
  /** 0..1 of the viewport. */
  x: number;
  y: number;
  /** Seconds since the note started, on the audio clock. */
  since: number;
  /** Seconds the key was (or has been) down. */
  held: number;
  down: boolean;
  env: Envelope;
  fig: { a: number; b: number; drift: number };
};

export type ToWorker =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "size"; w: number; h: number; dpr: number }
  | {
      type: "frame";
      voices: VoiceView[];
      /** The bus, left and right, for the XY scope. */
      xs: Float32Array;
      ys: Float32Array;
      /** 0..1, how loud the whole thing is. Drives how far the trails reach. */
      loud: number;
    }
  | { type: "stop" };

let ctx: OffscreenCanvasRenderingContext2D | null = null;
let W = 0;
let H = 0;
/** Rotates slowly so the feedback zoom does not read as a straight push-in.
 *  Advanced per frame rather than from a clock — the drift only has to be
 *  smooth, and a worker with no frames is a worker drawing nothing anyway. */
let spin = 0;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "init") {
    ctx = msg.canvas.getContext("2d", { alpha: false });
    return;
  }
  if (msg.type === "size") {
    if (!ctx) return;
    W = Math.max(1, Math.round(msg.w * msg.dpr));
    H = Math.max(1, Math.round(msg.h * msg.dpr));
    ctx.canvas.width = W;
    ctx.canvas.height = H;
    /* A resize leaves the buffer undefined, and this canvas is read back every
       frame by the feedback pass — so an unpainted one would be fed into the
       trails as whatever was in the allocation. */
    ctx.fillStyle = "#07060a";
    ctx.fillRect(0, 0, W, H);
    return;
  }
  if (msg.type === "stop") {
    ctx = null;
    return;
  }
  if (msg.type === "frame") draw(msg.voices, msg.xs, msg.ys, msg.loud);
};

function draw(voices: VoiceView[], xs: Float32Array, ys: Float32Array, loud: number) {
  const c = ctx;
  if (!c || W === 0) return;
  const unit = Math.min(W, H);

  /* ── 1. feedback ────────────────────────────────────────────────────────
     The frame just drawn, redrawn slightly larger and slightly turned, at just
     under full opacity. That is the whole of the trails, the echoes and the
     recursive zoom every visual synth is built out of — three lines, and more
     of how this looks than anything below it.

     The zoom scales with how loud it is, so a held chord pulls the picture
     outward and silence lets it settle. The floor matters: at exactly 1.0 the
     feedback is a straight fade and the image goes muddy rather than moving. */
  const zoom = 1.004 + loud * 0.01;
  spin += 0.0006 + loud * 0.002;
  c.save();
  c.globalAlpha = 0.93;
  c.translate(W / 2, H / 2);
  c.rotate(Math.sin(spin) * 0.0016);
  c.scale(zoom, zoom);
  c.drawImage(c.canvas, -W / 2, -H / 2, W, H);
  c.restore();

  /* And a breath of the ground colour over it, or the feedback loop saturates:
     every pass multiplies what is already bright, and without a sink the whole
     frame is white inside a few seconds of playing. */
  c.globalCompositeOperation = "source-over";
  c.globalAlpha = 0.055;
  c.fillStyle = "#07060a";
  c.fillRect(0, 0, W, H);
  c.globalAlpha = 1;

  /* ── 2. what each note is doing ─────────────────────────────────────── */
  c.globalCompositeOperation = "lighter";
  for (const v of voices) {
    const level = envelopeAt(v.env, v.since, v.down ? null : v.held);
    if (level <= 0.001) continue;
    const hue = wrapHue(v.hue);
    const x = v.x * W;
    const y = v.y * H;

    /* The bloom, following the envelope exactly — this is the one place the
       picture and the sound are the same number rather than two that agree. */
    const r = unit * (0.03 + level * 0.1);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${hue}, 85%, 68%, ${0.5 * level})`);
    g.addColorStop(0.45, `hsla(${hue}, 90%, 52%, ${0.18 * level})`);
    g.addColorStop(1, `hsla(${hue}, 90%, 45%, 0)`);
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);

    /* The rings, which are the visible half of holding a key: one is emitted
       every `RING_MS` for as long as it is down, so a tap leaves a single ring
       and a held note keeps ringing. Ages come from a pure function of the two
       times rather than an accumulator here, so the cadence does not drift with
       the frame rate. */
    for (const age of rings(v.since * 1000, v.held * 1000)) {
      const k = age / 1400;
      const rr = unit * (0.02 + k * 0.42);
      c.strokeStyle = `hsla(${hue}, 88%, 64%, ${(1 - k) * (1 - k) * 0.5})`;
      c.lineWidth = Math.max(1, unit * 0.0022 * (1 - k) * 3);
      c.beginPath();
      c.arc(x, y, rr, 0, Math.PI * 2);
      c.stroke();
    }

    /* This note's own figure, drawn where it was played.
     *
     * The scope below is the *sum* of everything sounding, which is the honest
     * picture and also the one that says nothing about any single note. This is
     * the other half: the same Lissajous idea per voice, at its own ratio, so a
     * held note has a shape of its own rather than only a glow. Octaves draw the
     * same figure at different sizes, and the ratio is a fraction off closing,
     * so it precesses instead of standing still — which is the difference
     * between a diagram and something worth watching.
     *
     * Only while the note is still doing something: at low levels it is a
     * scribble under the bloom, and thirty of those is mud. */
    if (level > 0.12) {
      const { a, b, drift } = v.fig;
      const rr = unit * 0.05 * (0.6 + level);
      const phase = v.since * drift * 60;
      c.strokeStyle = `hsla(${hue}, 95%, 80%, ${level * 0.4})`;
      c.lineWidth = Math.max(0.75, unit * 0.0012);
      c.beginPath();
      for (let i = 0; i <= 96; i++) {
        const u = (i / 96) * Math.PI * 2;
        const px = x + Math.sin(a * u + phase) * rr;
        const py = y + Math.sin(b * u) * rr;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
    }
  }

  /* ── 3. the scope ───────────────────────────────────────────────────────
     Left channel on X, right on Y — an oscilloscope in XY mode, which is what a
     Lissajous figure is. Not an illustration of the sound: this *is* the signal,
     so the figure closes when the notes are in a simple ratio and precesses when
     they are not, and voices panned by where you played them push it sideways.
     That is the coupling the whole toy is built on. */
  const n = Math.min(xs.length, ys.length);
  if (n > 1 && loud > 0.0015) {
    const hues = voices.filter((v) => v.down || v.since - v.held < 0.9);
    const hue = wrapHue(
      hues.length ? hues.reduce((a, v) => a + wrapHue(v.hue), 0) / hues.length : 200,
    );
    const gain = unit * 0.36;
    c.strokeStyle = `hsla(${hue}, 95%, 74%, 0.5)`;
    c.lineWidth = Math.max(1, unit * 0.0016);
    c.lineJoin = "round";
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const px = W / 2 + xs[i]! * gain;
      const py = H / 2 - ys[i]! * gain;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();

    /* A second, brighter, thinner pass over the same path. A scope's glow is
       its trace overdriving the phosphor where it moves slowly, and two
       strokes at different widths is the cheapest honest imitation of it. */
    c.strokeStyle = `hsla(${hue}, 100%, 92%, 0.35)`;
    c.lineWidth = Math.max(0.5, unit * 0.0006);
    c.stroke();
  }

  c.globalCompositeOperation = "source-over";
}
