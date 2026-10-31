/// <reference lib="webworker" />
/* One screen's decoder, on a thread of its own.
 *
 * `docs/SCREENS.md`'s first rule is that **neither main thread ever touches a
 * frame** — not Tauri's, and not the wall's JS thread, which also folds every
 * card's events and runs Svelte. So the loopback socket is dialled from here,
 * the H.264 is decoded here on the GPU, and the decoded `VideoFrame` goes from
 * here straight onto an `OffscreenCanvas` the tile transferred to us. What
 * crosses back to the wall is small and slow: a state word, a config, a stats
 * line twice a second, and a cursor's CSS when its shape changes.
 *
 * A remote desktop shows **the newest frame or nothing**. A queue is latency,
 * so nothing here ever waits its turn: a decoder that has fallen behind drops
 * deltas until the next keyframe and asks the host for one, and a decoder that
 * has lost its place (an error) is rebuilt and does the same.
 *
 * Every `VideoFrame` is closed the moment it is on the glass. A decoder has a
 * small pool of output surfaces, and one frame held open is one fewer for the
 * next; holding a few stalls the decoder outright, which looks exactly like a
 * frozen network.
 *
 * Pure decisions are `cast.ts`'s; this file is the plumbing between them.
 */

import {
  codecFromAnnexB,
  codecOk,
  cursorAt,
  cursorCss,
  decoderConfig,
  driveText,
  fitIn,
  KEY_TEXT,
  prune,
  readBinary,
  readText,
  summarize,
  wantText,
  type CastState,
  type Config,
  type CursorShape,
  type FromWorker,
  type Paint,
  type Surface,
  type Tick,
  type ToWorker,
  type Want,
} from "./cast";

const post = (m: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

/* ── the surface ───────────────────────────────────────────────────────── */

type Drawn = {
  surface: Surface;
  /** Exactly one of the two, by `paint`. */
  ctx2d: OffscreenCanvasRenderingContext2D | null;
  bitmap: ImageBitmapRenderingContext | null;
  cursor: OffscreenCanvasRenderingContext2D | null;
};

let paint: Paint = "2d";
let tile: Drawn | null = null;
let focus: Drawn | null = null;
const here = () => focus ?? tile;

let size = { w: 0, h: 0, dpr: 1 };
let native = { w: 0, h: 0 };

function drawn(surface: Surface): Drawn {
  const two = paint === "2d";
  return {
    surface,
    ctx2d: two ? (surface.video.getContext("2d", { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D | null) : null,
    bitmap: two ? null : (surface.video.getContext("bitmaprenderer") as ImageBitmapRenderingContext | null),
    cursor: surface.overlay.getContext("2d") as OffscreenCanvasRenderingContext2D | null,
  };
}

function resize(d: Drawn) {
  const w = Math.max(1, Math.round(size.w));
  const h = Math.max(1, Math.round(size.h));
  /* The bitmap path's video canvas takes the bitmap's own size each frame and
     CSS letterboxes it; only the 2D path draws at the surface's size. */
  if (d.ctx2d && (d.surface.video.width !== w || d.surface.video.height !== h)) {
    d.surface.video.width = w;
    d.surface.video.height = h;
  }
  if (d.surface.overlay.width !== w || d.surface.overlay.height !== h) {
    d.surface.overlay.width = w;
    d.surface.overlay.height = h;
  }
  drawCursor();
}

/* ── the socket ────────────────────────────────────────────────────────── */

let ws: WebSocket | null = null;
let closing = false;
let state: CastState = "connecting";
let lastWant: Want | null = null;
let driving = false;

function say(s: CastState, why = "") {
  state = s;
  post({ t: "state", state: s, why });
}

function send(m: string | ArrayBuffer) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(m);
}

function open(url: string) {
  if (ws) {
    closing = true;
    ws.close();
  }
  closing = false;
  say("connecting");
  const sock = new WebSocket(url);
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    /* The host knows nothing about this tile until told, and the contract has
       it pause until a want says otherwise. */
    if (lastWant) send(wantText(lastWant));
    if (driving) send(driveText(true));
    say("live");
    waitingKey = true;
    askKey();
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    if (typeof e.data === "string") onText(e.data);
    else onBinary(e.data as ArrayBuffer);
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    if (closing) return;
    /* The host's own `ended`/`refused` came before the close and says more;
       keep it rather than overwrite it with a generic word. */
    if (state !== "ended" && state !== "refused") {
      say("ended", e.reason || (e.code === 1000 ? "" : "the connection dropped"));
    }
  };
}

function onText(s: string) {
  const m = readText(s);
  if (!m) return;
  if (m.t === "config") configure(m);
  else if (m.t === "state") {
    say(m.state, m.why);
    if (m.state !== "live") clearCursor();
  } else {
    hostStats = m.stats;
    /* A far host says how far its clock is from ours (host − viewer, µs), so
       a capture time can be put on this machine's clock before it is
       subtracted from when the frame was painted. A local one says nothing
       and the offset stays zero — one clock. */
    if (typeof m.stats.offset_us === "number" && Number.isFinite(m.stats.offset_us)) {
      offsetUs = m.stats.offset_us;
    }
  }
}

/* ── the decoder ───────────────────────────────────────────────────────── */

let decoder: VideoDecoder | null = null;
let config: Config | null = null;
let hardware = true;
let waitingKey = true;
let lastAsk = 0;
let dropped = 0;

/** The capture time of each chunk in flight, by the timestamp the chunk was
 *  given — so a frame coming out of the decoder can be matched to when it was
 *  captured and how big it was. */
const inflight = new Map<number, { capture: number; bytes: number }>();

/** Ask the host for a keyframe, at most twice a second: a decoder that has lost
 *  its place drops every delta until one arrives, and asking per dropped frame
 *  would be sixty asks for one answer. */
function askKey() {
  const now = performance.now();
  if (now - lastAsk < 500) return;
  lastAsk = now;
  send(KEY_TEXT);
}

function configure(c: Config) {
  if (!codecOk(c.codec)) {
    say("ended", `this wall cannot draw ${c.codec}`);
    return;
  }
  const same = config && config.codec === c.codec && config.w === c.w && config.h === c.h;
  config = c;
  post({ t: "config", config: c, hardware });
  if (same && decoder && decoder.state === "configured") return;
  build();
}

function build() {
  if (!config) return;
  if (decoder && decoder.state !== "closed") decoder.close();
  inflight.clear();
  waitingKey = true;
  const d = new VideoDecoder({
    output: onFrame,
    error: (err) => {
      if (decoder !== d) return;
      /* Hardware that will not take this stream (a level past the GPU's, a
         second session refused) is not a reason to show nothing: the software
         decoder is slower and still a picture. Said once, in the config line. */
      if (hardware && /NotSupported/i.test(String(err?.name ?? err))) {
        hardware = false;
        if (config) post({ t: "config", config, hardware });
      }
      decoder = null;
      build();
      askKey();
    },
  });
  decoder = d;
  try {
    d.configure(decoderConfig(config, hardware ? "prefer-hardware" : "no-preference"));
  } catch (err) {
    say("ended", `the decoder refused ${config.codec}: ${String(err)}`);
    decoder = null;
  }
}

function onBinary(buf: ArrayBuffer) {
  const m = readBinary(buf);
  if (!m) return;
  if (m.kind === "shape") return onShape(m);
  if (m.kind === "pos") return onPos(m.visible, m.x, m.y, m.shape);

  /* A video frame. Before any config, a keyframe's own SPS says what it is —
     which is also what a fake host in a test can lean on. */
  if (!config && m.key) {
    const codec = codecFromAnnexB(m.data);
    if (codec) configure({ codec, w: m.w, h: m.h, fps: 0 });
  }
  if (!decoder || decoder.state !== "configured") {
    dropped++;
    return;
  }
  if (waitingKey && !m.key) {
    dropped++;
    askKey();
    return;
  }
  /* Behind: a decoder with frames still queued will show this one late, and
     the one after later still. Drop to the next keyframe instead; one that is
     itself a keyframe resets the queue and goes straight in. */
  if (decoder.decodeQueueSize > 1) {
    if (!m.key) {
      dropped++;
      waitingKey = true;
      askKey();
      return;
    }
    decoder.reset();
    inflight.clear();
    if (config) decoder.configure(decoderConfig(config, hardware ? "prefer-hardware" : "no-preference"));
  }
  if (m.key) waitingKey = false;
  /* Timestamps are µs; the seq keeps two frames captured in the same µs apart. */
  const ts = m.seq;
  inflight.set(ts, { capture: (m.captureUs - offsetUs) / 1000, bytes: buf.byteLength });
  if (inflight.size > 64) inflight.delete(inflight.keys().next().value as number);
  try {
    decoder.decode(
      new EncodedVideoChunk({ type: m.key ? "key" : "delta", timestamp: ts, data: m.data }),
    );
  } catch {
    waitingKey = true;
    askKey();
  }
}

/* ── painting ──────────────────────────────────────────────────────────── */

let ticks: Tick[] = [];
const paintMs: number[] = [];

function onFrame(frame: VideoFrame) {
  const d = here();
  const seen = inflight.get(frame.timestamp);
  inflight.delete(frame.timestamp);
  if (!d) {
    frame.close();
    return;
  }
  const t0 = performance.now();
  if (d.ctx2d) {
    const c = d.surface.video;
    const fit = fitIn({ w: frame.displayWidth, h: frame.displayHeight }, { w: c.width, h: c.height });
    /* Bars only where the picture is not, and only when its shape changed:
       a full clear per frame is a second fill of the whole surface. */
    if (fit.x > 0 || fit.y > 0) {
      d.ctx2d.fillStyle = "#000";
      if (fit.x > 0) {
        d.ctx2d.fillRect(0, 0, Math.ceil(fit.x), c.height);
        d.ctx2d.fillRect(Math.floor(fit.x + fit.w), 0, c.width, c.height);
      } else {
        d.ctx2d.fillRect(0, 0, c.width, Math.ceil(fit.y));
        d.ctx2d.fillRect(0, Math.floor(fit.y + fit.h), c.width, c.height);
      }
    }
    d.ctx2d.drawImage(frame, fit.x, fit.y, fit.w, fit.h);
    frame.close();
    done(t0, seen);
  } else if (d.bitmap) {
    const bm = d.bitmap;
    createImageBitmap(frame).then(
      (bmp) => {
        frame.close();
        bm.transferFromImageBitmap(bmp);
        done(t0, seen);
      },
      () => frame.close(),
    );
  } else {
    frame.close();
  }
}

function done(t0: number, seen: { capture: number; bytes: number } | undefined) {
  const now = performance.now();
  paintMs.push(now - t0);
  if (paintMs.length > 120) paintMs.shift();
  const wall = performance.timeOrigin + now;
  ticks.push({ shown: wall, capture: seen?.capture ?? wall, bytes: seen?.bytes ?? 0 });
  ticks = prune(ticks, wall);
}

/* ── the cursor ────────────────────────────────────────────────────────── */

type Shape = { m: CursorShape; image: ImageBitmap | null; css: Map<number, string> };
const shapes = new Map<number, Shape>();
let cursor = { visible: false, x: 0, y: 0, shape: -1 };
let lastCss = "";
/** What the overlay last drew, so the next draw clears only that. */
let painted: { x: number; y: number; w: number; h: number } | null = null;

function onShape(m: CursorShape) {
  /* The message is a view onto a buffer the socket owns; copy the pixels so
     the shape outlives it. */
  const keep: CursorShape = { ...m, rgba: m.rgba.slice() };
  const s: Shape = { m: keep, image: null, css: new Map() };
  shapes.set(m.shape, s);
  /* A remote desktop goes through a few dozen shapes at most; a host that
     keeps inventing ids should not grow this for ever. */
  if (shapes.size > 64) shapes.delete(shapes.keys().next().value as number);
  const img = new ImageData(new Uint8ClampedArray(keep.rgba), keep.w, keep.h);
  createImageBitmap(img).then((bmp) => {
    s.image = bmp;
    if (cursor.shape === m.shape) drawCursor();
  });
  if (cursor.shape === m.shape) drawCursor();
}

function onPos(visible: boolean, x: number, y: number, shape: number) {
  cursor = { visible, x, y, shape };
  drawCursor();
}

function clearCursor() {
  const d = here();
  if (d?.cursor && painted) d.cursor.clearRect(painted.x - 1, painted.y - 1, painted.w + 2, painted.h + 2);
  painted = null;
}

function frameFit() {
  const d = here();
  if (!d) return null;
  const src = native.w > 0 ? native : config ? { w: config.w, h: config.h } : null;
  if (!src) return null;
  return { src, fit: fitIn(src, { w: d.surface.overlay.width, h: d.surface.overlay.height }) };
}

function drawCursor() {
  clearCursor();
  const s = shapes.get(cursor.shape);
  if (driving) {
    /* The OS draws it now, at the hardware's rate; we only say what it looks
       like, in CSS pixels of the tile. */
    const at = frameFit();
    const k = at ? at.fit.w / at.src.w / (size.dpr || 1) : 1;
    const css = !cursor.visible ? "none" : s ? cssFor(s, k) : "default";
    if (css !== lastCss) {
      lastCss = css;
      post({ t: "cursor", css });
    }
    return;
  }
  const d = here();
  const at = frameFit();
  if (!d?.cursor || !s?.image || !cursor.visible || !at || state !== "live") return;
  const p = cursorAt(cursor, { x: s.m.hotX, y: s.m.hotY }, at.src, at.fit);
  const w = s.m.w * p.k;
  const h = s.m.h * p.k;
  d.cursor.drawImage(s.image, p.x, p.y, w, h);
  painted = { x: Math.floor(p.x), y: Math.floor(p.y), w: Math.ceil(w) + 1, h: Math.ceil(h) + 1 };
}

/* A PNG per shape per scale, kept: the scale moves with the wall's zoom in
   steps, and encoding the same arrow again on every zoom notch is waste. */
function cssFor(s: Shape, k: number): string {
  const key = Math.round(k * 100);
  let css = s.css.get(key);
  if (!css) {
    css = cursorCss(s.m, key / 100);
    s.css.set(key, css);
  }
  return css;
}

/* ── stats, twice a second ─────────────────────────────────────────────── */

let hostStats: Record<string, unknown> | null = null;
let offsetUs = 0;

const timer = setInterval(() => {
  if (state !== "live" && ticks.length === 0) return;
  const wall = performance.timeOrigin + performance.now();
  ticks = prune(ticks, wall);
  const sorted = [...paintMs].sort((a, b) => a - b);
  post({
    t: "stats",
    stats: summarize(ticks, wall),
    dropped,
    paintMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    host: hostStats,
  });
}, 500);

/* ── the holder's messages ─────────────────────────────────────────────── */

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case "tile":
      paint = m.paint;
      tile = drawn(m.surface);
      resize(tile);
      break;
    case "focus":
      clearCursor();
      focus = drawn(m.surface);
      resize(focus);
      waitingKey = true;
      askKey();
      break;
    case "unfocus":
      clearCursor();
      focus = null;
      waitingKey = true;
      askKey();
      break;
    case "open":
      open(m.url);
      break;
    case "size": {
      size = { w: m.w, h: m.h, dpr: m.dpr };
      const d = here();
      if (d) resize(d);
      break;
    }
    case "native":
      native = { w: m.w, h: m.h };
      drawCursor();
      break;
    case "want":
      lastWant = m.want;
      send(wantText(m.want));
      break;
    case "input":
      send(m.bytes);
      break;
    case "drive":
      if (driving === m.on) break;
      driving = m.on;
      lastCss = "";
      send(driveText(m.on));
      drawCursor();
      break;
    case "close":
      closing = true;
      clearInterval(timer);
      ws?.close(1000);
      ws = null;
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      for (const s of shapes.values()) s.image?.close();
      shapes.clear();
      self.close();
      break;
  }
};
