/* castlab: a fake host and the real viewer, in one page.
 *
 *   bun tools/cast-relay.ts                       # the stand-in loopback socket
 *   bunx vite --port 1499 --strictPort            # any free port; NOT 1420
 *   open http://localhost:1499/tools/castlab.html[?paint=bitmap&w=2560&h=1440&fps=60]
 *
 * The host half draws a moving scene (a clock, sweeping bars, a grid fine
 * enough to show scaling) into a canvas, encodes it with WebCodecs'
 * `VideoEncoder` as Annex-B H.264 — the format the Media Foundation encoder
 * hands the hub — and sends exactly the messages `src-tauri/src/cast/wire.rs`
 * lays out: a `config` text before each new shape, `0x01` video with the 26-byte
 * header, a `0x02` cursor shape and `0x03` positions circling the screen. It
 * obeys the viewer's `want` (size, fps, pause) and `key`, as the hub will.
 *
 * The viewer half is `src/lib/cast.worker.ts` itself, handed two canvases the
 * way `cast.svelte.ts` does it, so what is measured here is what ships:
 * `window.castlab` exposes the stats the worker reports, for a probe to read.
 *
 * Measured with it, on this machine (see the commit that adds it): the two
 * painters' per-frame CPU cost, decode latency, and the drop-to-keyframe path.
 */

import type { FromWorker, ToWorker, Want } from "../src/lib/cast";

const q = new URLSearchParams(location.search);
const PAINT = (q.get("paint") === "bitmap" ? "bitmap" : "2d") as "2d" | "bitmap";
const SRC_W = Number(q.get("w") ?? 1920);
const SRC_H = Number(q.get("h") ?? 1080);
const SRC_FPS = Number(q.get("fps") ?? 60);
const RELAY = q.get("relay") ?? "ws://127.0.0.1:14399";

const hostOut = document.getElementById("host") as HTMLPreElement;
const viewOut = document.getElementById("view") as HTMLPreElement;

/* ── the fake host ─────────────────────────────────────────────────────── */

const source = document.getElementById("source") as HTMLCanvasElement;
source.width = SRC_W;
source.height = SRC_H;
const sctx = source.getContext("2d")!;

function scene(t: number) {
  const g = sctx;
  g.fillStyle = "#1b2a35";
  g.fillRect(0, 0, SRC_W, SRC_H);
  g.strokeStyle = "#ffffff18";
  for (let x = 0; x < SRC_W; x += 16) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, SRC_H);
    g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const x = ((t / 1000) * (120 + i * 40) + i * 300) % (SRC_W + 200) - 200;
    g.fillStyle = `hsl(${i * 55} 60% 55%)`;
    g.fillRect(x, 120 + i * 140, 200, 90);
  }
  g.fillStyle = "#f3f1ee";
  g.font = `${Math.round(SRC_H / 8)}px Consolas, monospace`;
  const d = new Date();
  g.fillText(
    `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, "0")}`,
    SRC_W * 0.08,
    SRC_H * 0.9,
  );
}

let ws: WebSocket | null = null;
let want: Want = { w: SRC_W, h: SRC_H, fps: 30, visible: true, focused: false };
let encoder: VideoEncoder | null = null;
let enc = { w: 0, h: 0 };
let seq = 0;
let hw: HardwareAcceleration = "prefer-hardware";
let encoderError = "";
let forceKey = true;
let sent = 0;
let bytes = 0;
const scaled = document.createElement("canvas");
const scaledCtx = scaled.getContext("2d")!;

const wallUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

function ensureEncoder() {
  const w = Math.min(SRC_W, want.w) & ~1;
  const h = Math.min(SRC_H, want.h) & ~1;
  if (encoder && enc.w === w && enc.h === h) return;
  if (encoder && encoder.state !== "closed") encoder.close();
  enc = { w, h };
  scaled.width = w;
  scaled.height = h;
  const codec = "avc1.64002a";
  encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const msg = new Uint8Array(26 + data.length);
      const dv = new DataView(msg.buffer);
      msg[0] = 0x01;
      msg[1] = chunk.type === "key" ? 1 : 0;
      dv.setUint16(2, w, true);
      dv.setUint16(4, h, true);
      dv.setUint32(6, seq++, true);
      dv.setBigUint64(10, BigInt(chunk.timestamp), true);
      dv.setBigUint64(18, BigInt(wallUs()), true);
      msg.set(data, 26);
      ws?.send(msg);
      sent++;
      bytes += msg.length;
    },
    error: (e) => {
      encoderError = String(e);
      /* Hardware that refuses this level is not a reason for no picture. */
      if (hw === "prefer-hardware") {
        hw = "no-preference";
        enc = { w: 0, h: 0 };
        ensureEncoder();
      }
    },
  });
  encoder.configure({
    codec,
    width: w,
    height: h,
    bitrate: Math.round(w * h * Math.max(want.fps, 1) * 0.08),
    framerate: Math.max(want.fps, 1),
    latencyMode: "realtime",
    hardwareAcceleration: hw,
    avc: { format: "annexb" },
  });
  ws?.send(JSON.stringify({ t: "config", codec, w, h, fps: want.fps }));
  forceKey = true;
}

function cursorShape() {
  const c = new OffscreenCanvas(24, 32);
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.strokeStyle = "#000";
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(1, 1);
  g.lineTo(1, 26);
  g.lineTo(7, 20);
  g.lineTo(12, 30);
  g.lineTo(16, 28);
  g.lineTo(11, 18);
  g.lineTo(19, 18);
  g.closePath();
  g.fill();
  g.stroke();
  const px = g.getImageData(0, 0, 24, 32).data;
  const msg = new Uint8Array(14 + px.length);
  const dv = new DataView(msg.buffer);
  msg[0] = 0x02;
  dv.setUint16(2, 24, true);
  dv.setUint16(4, 32, true);
  dv.setUint16(6, 1, true);
  dv.setUint16(8, 1, true);
  dv.setUint32(10, 7, true);
  msg.set(px, 14);
  return msg;
}

function cursorPos(t: number) {
  const msg = new Uint8Array(10);
  const dv = new DataView(msg.buffer);
  msg[0] = 0x03;
  msg[1] = 1;
  dv.setInt16(2, Math.round(SRC_W / 2 + Math.cos(t / 900) * SRC_W * 0.3), true);
  dv.setInt16(4, Math.round(SRC_H / 2 + Math.sin(t / 900) * SRC_H * 0.3), true);
  dv.setUint32(6, 7, true);
  return msg;
}

function dialHost() {
  ws = new WebSocket(`${RELAY}/host`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    ws!.send(JSON.stringify({ t: "state", state: "live" }));
    ensureEncoder();
    ws!.send(cursorShape());
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return; // input bytes: counted, not acted on
    const m = JSON.parse(e.data);
    if (m.t === "want") {
      want = m;
      if (want.visible && want.fps > 0) ensureEncoder();
      forceKey = true;
    } else if (m.t === "key" || m.t === "viewer") {
      forceKey = true;
      if (m.t === "viewer") {
        ensureEncoder();
        ws!.send(cursorShape());
      }
    }
  };
  ws.onclose = () => setTimeout(dialHost, 1000);
}

let lastFrame = 0;
function hostLoop(t: number) {
  requestAnimationFrame(hostLoop);
  scene(t);
  if (ws?.readyState === WebSocket.OPEN) ws.send(cursorPos(t));
  const fps = want.visible ? Math.min(want.fps || 0, SRC_FPS) : 0;
  if (!fps || !encoder || encoder.state !== "configured") return;
  if (t - lastFrame < 1000 / fps - 2) return;
  lastFrame = t;
  /* A real hub drops rather than queues behind a slow encoder; so does this. */
  if (encoder.encodeQueueSize > 2) return;
  scaledCtx.drawImage(source, 0, 0, enc.w, enc.h);
  const frame = new VideoFrame(scaled, { timestamp: wallUs() });
  encoder.encode(frame, { keyFrame: forceKey });
  forceKey = false;
  frame.close();
}
requestAnimationFrame(hostLoop);
dialHost();
setInterval(() => {
  hostOut.textContent = `host: ${enc.w}×${enc.h} ${hw} ${encoderError} · want ${JSON.stringify(want)}\n${sent} frames, ${Math.round((bytes * 8) / 1000)} kbit in the last second`;
  sent = 0;
  bytes = 0;
}, 1000);

/* ── the viewer: the real worker, handed canvases as the holder does ──── */

const tile = document.getElementById("tile") as HTMLDivElement;
const video = document.createElement("canvas");
const overlay = document.createElement("canvas");
video.className = "video";
tile.append(video, overlay);
const worker = new Worker(new URL("../src/lib/cast.worker.ts", import.meta.url), { type: "module" });
const surface = { video: video.transferControlToOffscreen(), overlay: overlay.transferControlToOffscreen() };
const post = (m: ToWorker, t: Transferable[] = []) => worker.postMessage(m, t);

const seen: { last: FromWorker[]; stats: unknown } = { last: [], stats: null };
(window as unknown as { castlab: unknown }).castlab = {
  seen,
  post: (m: ToWorker) => post(m),
  want: (w: Partial<Want>) => post({ t: "want", want: { ...currentWant(), ...w } }),
};
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.t === "stats") seen.stats = m;
  else seen.last = [...seen.last.slice(-9), m];
  viewOut.textContent = `viewer (${PAINT}):\n${JSON.stringify(seen.stats, null, 1)}\n${seen.last.map((x) => JSON.stringify(x).slice(0, 160)).join("\n")}`;
};

function currentWant(): Want {
  const r = tile.getBoundingClientRect();
  return {
    w: Math.round(r.width * devicePixelRatio),
    h: Math.round(r.height * devicePixelRatio),
    fps: Number(q.get("vfps") ?? 60),
    visible: true,
    focused: q.get("focused") === "1",
  };
}

post({ t: "tile", surface, paint: PAINT }, [surface.video, surface.overlay]);
const resize = () => {
  const r = tile.getBoundingClientRect();
  post({ t: "size", w: r.width * devicePixelRatio, h: r.height * devicePixelRatio, dpr: devicePixelRatio });
};
resize();
new ResizeObserver(resize).observe(tile);
post({ t: "native", w: SRC_W, h: SRC_H });
post({ t: "want", want: currentWant() });
post({ t: "open", url: `${RELAY}/view` });
