/* A screen, as the webview sees it: the bytes on the loopback socket, what a
 * tile asks the host for, and the arithmetic every face of one shares.
 *
 * Pure, and tested directly in `test/cast.test.ts`. The byte layouts are
 * `src-tauri/src/cast/wire.rs`'s and that file's test fixtures are copied into
 * the test byte for byte — which is what stops the two halves drifting, since
 * nothing else would notice: a header read one byte off decodes a frame of the
 * wrong size, the decoder rejects it, and the tile reads as a slow network.
 * `docs/SCREENS.md` is the contract both sides are written against.
 *
 * Imported by the worker (`cast.worker.ts`), the holder (`cast.svelte.ts`) and
 * the faces, so nothing in here may touch the DOM: a Worker has none.
 */

/* ── the kinds on the wire ─────────────────────────────────────────────── */

export const VIDEO = 0x01;
export const CURSOR_SHAPE = 0x02;
export const CURSOR_POS = 0x03;
export const AUDIO = 0x04;

/** The fixed part of a video message, before the Annex-B payload. */
export const VIDEO_HEADER = 26;
const KEY_FLAG = 0x01;
const SHAPE_HEADER = 14;
const POS_LEN = 10;

/** What a video message's header says. The two times are the host's wall
 *  clock in µs since the Unix epoch; ~1.8e15 today, well inside a double's 2^53,
 *  so they are numbers rather than bigints and arithmetic on them stays cheap. */
export type VideoHeader = {
  key: boolean;
  w: number;
  h: number;
  seq: number;
  captureUs: number;
  encodedUs: number;
};

export type Video = VideoHeader & { kind: "video"; data: Uint8Array };

export type CursorShape = {
  kind: "shape";
  w: number;
  h: number;
  hotX: number;
  hotY: number;
  shape: number;
  /** Straight-alpha RGBA, `w * h * 4`. A view onto the message, not a copy. */
  rgba: Uint8Array;
};

export type CursorPos = {
  kind: "pos";
  visible: boolean;
  /** Source pixels from the monitor's top-left. Signed: a cursor whose hot
   *  spot is on the screen can have its image's corner off it. */
  x: number;
  y: number;
  shape: number;
};

export type Binary = Video | CursorShape | CursorPos;

function bytesOf(b: ArrayBuffer | Uint8Array): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}

function viewOf(u: Uint8Array): DataView {
  return new DataView(u.buffer, u.byteOffset, u.byteLength);
}

/** Exactly `wire::read_video`: null for anything shorter than a header or not
 *  a video message. */
export function readVideo(b: ArrayBuffer | Uint8Array): Video | null {
  const u = bytesOf(b);
  if (u.length < VIDEO_HEADER || u[0] !== VIDEO) return null;
  const d = viewOf(u);
  return {
    kind: "video",
    key: (u[1] & KEY_FLAG) !== 0,
    w: d.getUint16(2, true),
    h: d.getUint16(4, true),
    seq: d.getUint32(6, true),
    captureUs: Number(d.getBigUint64(10, true)),
    encodedUs: Number(d.getBigUint64(18, true)),
    data: u.subarray(VIDEO_HEADER),
  };
}

/** `wire::is_keyframe`, without decoding the rest — what the worker asks of
 *  every frame while it is waiting for a place to start. */
export function isKeyframe(b: ArrayBuffer | Uint8Array): boolean {
  const u = bytesOf(b);
  return u.length >= 2 && u[0] === VIDEO && (u[1] & KEY_FLAG) !== 0;
}

export function readCursorShape(b: ArrayBuffer | Uint8Array): CursorShape | null {
  const u = bytesOf(b);
  if (u.length < SHAPE_HEADER || u[0] !== CURSOR_SHAPE) return null;
  const d = viewOf(u);
  const w = d.getUint16(2, true);
  const h = d.getUint16(4, true);
  /* A shape whose pixels do not match its own size is not a cursor, and
     drawing it would read off the end of the message. */
  if (u.length !== SHAPE_HEADER + w * h * 4) return null;
  return {
    kind: "shape",
    w,
    h,
    hotX: d.getUint16(6, true),
    hotY: d.getUint16(8, true),
    shape: d.getUint32(10, true),
    rgba: u.subarray(SHAPE_HEADER),
  };
}

export function readCursorPos(b: ArrayBuffer | Uint8Array): CursorPos | null {
  const u = bytesOf(b);
  if (u.length < POS_LEN || u[0] !== CURSOR_POS) return null;
  const d = viewOf(u);
  return {
    kind: "pos",
    visible: u[1] !== 0,
    x: d.getInt16(2, true),
    y: d.getInt16(4, true),
    shape: d.getUint32(6, true),
  };
}

/** Any binary message the host sends. Audio is reserved and comes back null,
 *  as does a kind this build does not know — a newer host's message is
 *  skipped rather than guessed at. */
export function readBinary(b: ArrayBuffer | Uint8Array): Binary | null {
  const u = bytesOf(b);
  switch (u[0]) {
    case VIDEO:
      return readVideo(u);
    case CURSOR_SHAPE:
      return readCursorShape(u);
    case CURSOR_POS:
      return readCursorPos(u);
    default:
      return null;
  }
}

/* ── the text messages ─────────────────────────────────────────────────── */

/** Where a session stands, as the host or this side says it. `connecting` is
 *  ours — the socket is not open yet; every other word is the host's. */
export type CastState = "connecting" | "live" | "paused" | "locked" | "refused" | "ended";

const HOST_STATES: CastState[] = ["live", "paused", "locked", "refused", "ended"];

export type Config = { codec: string; w: number; h: number; fps: number };

export type Text =
  | ({ t: "config" } & Config)
  | { t: "state"; state: CastState; why: string }
  | { t: "stats"; stats: Record<string, unknown> };

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** One JSON text message, normalised. Anything malformed or unknown is null,
 *  and the caller drops it: a config with no size cannot configure a decoder,
 *  and a state word this build does not know is not one it can draw. */
export function readText(s: string): Text | null {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case "config": {
      const w = num(o.w);
      const h = num(o.h);
      if (typeof o.codec !== "string" || !w || !h) return null;
      return { t: "config", codec: o.codec, w, h, fps: num(o.fps) ?? 0 };
    }
    case "state": {
      const state = o.state as CastState;
      if (!HOST_STATES.includes(state)) return null;
      return { t: "state", state, why: typeof o.why === "string" ? o.why : "" };
    }
    case "stats": {
      const { t: _, ...stats } = o;
      return { t: "stats", stats };
    }
    default:
      return null;
  }
}

/* ── what the viewer says back ─────────────────────────────────────────── */

/** What a viewer wants of a source: `cast::Want`, field for field. */
export type Want = { w: number; h: number; fps: number; visible: boolean; focused: boolean };

export const wantText = (w: Want): string => JSON.stringify({ t: "want", ...w });
export const KEY_TEXT = JSON.stringify({ t: "key" });
export const driveText = (on: boolean): string => JSON.stringify({ t: "drive", on });

/* ── what a tile asks for ──────────────────────────────────────────────── */

/** The focused screen's ceiling, whatever the monitor can do. */
export const FOCUS_FPS_CAP = 120;
export const VISIBLE_FPS = 30;
export const SMALL_FPS = 15;
/** Below this many device pixels across, a tile is a thumbnail. */
export const SMALL_W = 480;

/** The sizes a want snaps to, as a ratio between steps. A quarter of an
 *  octave: zooming the wall is continuous, and every distinct size reported
 *  is a rendition the host may rebuild — a keyframe, which is the most
 *  expensive frame there is. So the size steps rather than follows, and a
 *  tile zoomed by less than ~19% asks for nothing new. Always rounded *up*,
 *  so the frame is never upscaled on its way to the glass. */
const STEP = 2 ** 0.25;

export function snapUp(px: number): number {
  if (px <= 16) return 16;
  const n = Math.ceil(Math.log(px / 16) / Math.log(STEP) - 1e-9);
  /* Even, because the encoder works in 4:2:0 and an odd size is a size the
     host has to round anyway — better it rounds the same way we did. */
  return Math.ceil((16 * STEP ** n) / 2) * 2;
}

export type Fit = { x: number; y: number; w: number; h: number };

/** Letterbox `src` inside `box`: the largest rectangle of `src`'s shape that
 *  fits, centred. A source of no size fills the box, which is what a tile
 *  that has not heard a config yet should draw its waiting state over. */
export function fitIn(src: { w: number; h: number }, box: { w: number; h: number }): Fit {
  if (src.w <= 0 || src.h <= 0 || box.w <= 0 || box.h <= 0) {
    return { x: 0, y: 0, w: Math.max(0, box.w), h: Math.max(0, box.h) };
  }
  const k = Math.min(box.w / src.w, box.h / src.h);
  const w = src.w * k;
  const h = src.h * k;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
}

export type Seen = {
  /** The tile's box in CSS pixels of the wall — `widget.w` and `widget.h`, or
   *  the focused overlay's own box. */
  boxW: number;
  boxH: number;
  /** The wall's zoom: 1 for anything not drawn on the canvas. */
  scale: number;
  dpr: number;
  /** The source's shape when known (`Monitor` or the last config), so the size
   *  asked for is the picture's and not the letterbox's bars. */
  src: { w: number; h: number } | null;
  /** The monitor's refresh, for the focused screen's rate. */
  hz: number;
  visible: boolean;
  focused: boolean;
};

/** What to ask the host for: the adaptive table in `docs/SCREENS.md`, from
 *  this side. A hidden tile asks for no frames at all, and the host pauses;
 *  its size is still reported so the keyframe on return is the right shape. */
export function want(s: Seen): Want {
  const fit = s.src ? fitIn(s.src, { w: s.boxW, h: s.boxH }) : { w: s.boxW, h: s.boxH };
  const k = Math.max(0, s.scale) * Math.max(1, s.dpr || 1);
  let w = snapUp(fit.w * k);
  let h = snapUp(fit.h * k);
  /* Never more than the source has: the host clamps anyway, but a want that
     already says the truth is a want that compares equal across zooms past
     native, and so is not sent again. */
  if (s.src) {
    w = Math.min(w, evenUp(s.src.w));
    h = Math.min(h, evenUp(s.src.h));
  }
  const fps = !s.visible
    ? 0
    : s.focused
      ? Math.min(FOCUS_FPS_CAP, s.hz > 0 ? s.hz : 60)
      : w < SMALL_W
        ? SMALL_FPS
        : VISIBLE_FPS;
  return { w, h, fps, visible: s.visible, focused: s.focused };
}

const evenUp = (n: number) => Math.ceil(n / 2) * 2;

export function sameWant(a: Want | null, b: Want | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.w === b.w &&
    a.h === b.h &&
    a.fps === b.fps &&
    a.visible === b.visible &&
    a.focused === b.focused
  );
}

/* ── the codec ─────────────────────────────────────────────────────────── */

/** An RFC 6381 codec string a `VideoDecoder` can be configured with, or null.
 *  `avc1.PPCCLL` for H.264 and the HEVC family for the stage that adds it;
 *  anything else is a host speaking a codec this build cannot draw. */
export function codecOk(codec: string): boolean {
  return /^(avc1|avc3)\.[0-9a-f]{6}$/i.test(codec) || /^(hev1|hvc1)\.[0-9A-Za-z.]+$/.test(codec);
}

/** The NAL units of an Annex-B stream, start codes removed. Three- and
 *  four-byte start codes both, since encoders mix them. */
export function nalUnits(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) out.push(b.subarray(start, trimZeros(b, start, i)));
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < b.length) out.push(b.subarray(start));
  return out;
}

/* A four-byte start code is a zero then a three-byte one, so the unit before
   it carries that zero at its tail. Trailing zeros are never payload in a NAL
   unit (rbsp_trailing_bits ends in a one), so they can all go. */
function trimZeros(b: Uint8Array, from: number, to: number): number {
  while (to > from && b[to - 1] === 0) to--;
  return to;
}

/** The H.264 codec string a keyframe's SPS names, for a host that sent frames
 *  before (or without) a config. Profile, constraint flags and level are the
 *  three bytes after the NAL header — the string is those bytes in hex. */
export function codecFromAnnexB(b: Uint8Array): string | null {
  for (const nal of nalUnits(b)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
  }
  return null;
}

/** What a `VideoDecoder` is configured with. No `description`: the stream is
 *  Annex-B, parameter sets in band, which is what lets a decoder that lost its
 *  place start again at the next keyframe without being told anything. */
export function decoderConfig(
  c: Config,
  hardware: "prefer-hardware" | "no-preference" = "prefer-hardware",
): VideoDecoderConfig {
  return {
    codec: c.codec,
    codedWidth: c.w,
    codedHeight: c.h,
    hardwareAcceleration: hardware,
    optimizeForLatency: true,
  };
}

/* ── the stats ─────────────────────────────────────────────────────────── */

/** One frame as the worker saw it through. Times in ms on the *host's* clock
 *  for `capture`, on this machine's wall clock for `shown`; for a local screen
 *  they are the same clock. */
export type Tick = { shown: number; capture: number; bytes: number };

export type Stats = { fps: number; latencyMs: number | null; kbps: number };

/** How far back the readings look. Long enough that fps is not a count of
 *  three, short enough that a stall reads as one within a second. */
export const STATS_WINDOW_MS = 1000;

/** fps, the median glass-to-glass-minus-glass latency, and bitrate over the
 *  last window. The median rather than the mean because one frame held up by a
 *  GC pause is not what the connection is like.
 *
 *  Latency across machines is two clocks subtracted, and only as good as their
 *  agreement — Windows keeps them within tens of ms over NTP, which is the size
 *  of the thing being measured. So a negative or absurd reading is dropped
 *  rather than drawn, and a far screen's number is a hint, not a measurement.
 *  The honest measurement is the glass-to-glass one `docs/SCREENS.md` stage 5
 *  asks for, with a camera. */
export function summarize(ticks: readonly Tick[], now: number, windowMs = STATS_WINDOW_MS): Stats {
  const recent = ticks.filter((t) => now - t.shown <= windowMs && t.shown <= now);
  const fps = (recent.length * 1000) / windowMs;
  const lats = recent
    .map((t) => t.shown - t.capture)
    .filter((l) => l >= 0 && l < 10_000)
    .sort((a, b) => a - b);
  const latencyMs = lats.length ? lats[Math.floor((lats.length - 1) / 2)] : null;
  const bytes = recent.reduce((n, t) => n + t.bytes, 0);
  return { fps: Math.round(fps), latencyMs, kbps: Math.round((bytes * 8) / windowMs) };
}

/** Keep the ring to what `summarize` can read, so a long session does not
 *  grow it. */
export function prune(ticks: Tick[], now: number, windowMs = STATS_WINDOW_MS): Tick[] {
  let i = 0;
  while (i < ticks.length && now - ticks[i].shown > windowMs) i++;
  return i ? ticks.slice(i) : ticks;
}

/* ── the remote cursor as the OS's own ─────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function adler32(b: Uint8Array): number {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; i++) {
    a = (a + b[i]) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks. A cursor is at most
 *  a few kilobytes and is converted once per shape, so a compressor would be
 *  code to keep correct for bytes nobody waits on. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * MAX, Math.min(raw.length, (i + 1) * MAX));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 0xff;
    out[o++] = part.length >>> 8;
    out[o++] = ~part.length & 0xff;
    out[o++] = (~part.length >>> 8) & 0xff;
    out.set(part, o);
    o += part.length;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const d = new DataView(out.buffer);
  d.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  d.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Straight-alpha RGBA as a PNG file — which is what CSS `cursor: url()` takes,
 *  and the whole reason for this: while you drive a screen the remote pointer
 *  is the *OS's* pointer wearing the remote shape, moved by the hardware at the
 *  display's own rate, where a pointer drawn in a canvas would be a frame
 *  behind your hand at best. PNG's alpha is straight too, so the bytes go in
 *  as they are. */
export function rgbaToPng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const d = new DataView(ihdr.buffer);
  d.setUint32(0, w);
  d.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const parts = [
    new Uint8Array(sig),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Nearest-neighbour resample, for a cursor drawn at a tile's scale: a remote
 *  arrow the size of the remote's own on a quarter-size tile would be four
 *  times too big against what it points at. */
export function scaleRgba(
  rgba: Uint8Array,
  w: number,
  h: number,
  k: number,
): { rgba: Uint8Array; w: number; h: number } {
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  if (W === w && H === h) return { rgba, w, h };
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / W));
      out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return { rgba: out, w: W, h: H };
}

/** Chromium refuses a cursor image past 128 px either way and silently falls
 *  back, so a shape scaled past it is clamped rather than lost. */
export const CURSOR_MAX = 128;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >>> 18] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    s += B64[n >>> 18] + B64[(n >>> 12) & 63];
    s += i + 1 < b.length ? B64[(n >>> 6) & 63] : "=";
    s += "=";
  }
  return s;
}

/** The CSS `cursor` value for a remote shape at scale `k` (tile pixels per
 *  source pixel), with its hot spot carried along and a fallback, since a
 *  `url()` cursor without one is invalid CSS. */
export function cursorCss(s: Pick<CursorShape, "rgba" | "w" | "h" | "hotX" | "hotY">, k: number): string {
  const kk = Math.min(k, CURSOR_MAX / Math.max(s.w, s.h, 1));
  const sc = scaleRgba(s.rgba, s.w, s.h, kk);
  const png = rgbaToPng(sc.rgba, sc.w, sc.h);
  const hx = Math.min(sc.w - 1, Math.round(s.hotX * (sc.w / s.w)));
  const hy = Math.min(sc.h - 1, Math.round(s.hotY * (sc.h / s.h)));
  return `url(data:image/png;base64,${base64(png)}) ${hx} ${hy}, default`;
}

/* ── between the holder and its worker ─────────────────────────────────── */

/** How a decoded frame reaches the glass. `2d` draws the `VideoFrame` into a
 *  2D context, letterboxed by `drawImage`'s destination rectangle; `bitmap`
 *  hands an `ImageBitmap` to a `bitmaprenderer` context and lets CSS
 *  `object-fit` letterbox it. Both keep the frame a GPU texture; which costs
 *  less per frame is measured, not argued — see `cast.worker.ts`. */
export type Paint = "2d" | "bitmap";

/** A surface the worker paints: the picture and, over it, the remote cursor
 *  while you are only watching. Two canvases so a cursor that moves over a
 *  still screen redraws a cursor and not a frame — and so no decoded frame has
 *  to be kept open to redraw under it. */
export type Surface = { video: OffscreenCanvas; overlay: OffscreenCanvas };

export type ToWorker =
  /** The tile's own surface, handed over once for the life of the session. */
  | { t: "tile"; surface: Surface; paint: Paint }
  /** The focused overlay's surface; the worker paints there until `unfocus`. */
  | { t: "focus"; surface: Surface }
  | { t: "unfocus" }
  /** Dial (or redial) the loopback socket. */
  | { t: "open"; url: string }
  /** The current surface's size in device pixels, and the ratio to CSS ones —
   *  which the driven cursor is sized in. */
  | { t: "size"; w: number; h: number; dpr: number }
  /** The source's native size, which cursor positions are in. */
  | { t: "native"; w: number; h: number }
  | { t: "want"; want: Want }
  /** Input events as `castinput.ts` encodes them, sent as one binary message. */
  | { t: "input"; bytes: ArrayBuffer }
  /** Driving: the worker stops drawing the cursor and reports its shape as CSS
   *  instead, and the host is told (`{"t":"drive"}`). */
  | { t: "drive"; on: boolean }
  | { t: "close" };

export type FromWorker =
  | { t: "state"; state: CastState; why: string }
  | { t: "config"; config: Config; hardware: boolean }
  | {
      t: "stats";
      stats: Stats;
      /** Frames dropped waiting for a keyframe since the session opened. */
      dropped: number;
      /** Median CPU time to put a frame on the canvas, in ms. */
      paintMs: number;
      /** Anything the host's own `stats` message said. */
      host: Record<string, unknown> | null;
    }
  /** The remote cursor as a CSS `cursor` value, while driving. `none` when the
   *  far machine has hidden it. */
  | { t: "cursor"; css: string };

/** Where a remote cursor's image goes in a surface, in that surface's pixels. */
export function cursorAt(
  pos: { x: number; y: number },
  hot: { x: number; y: number },
  native: { w: number; h: number },
  fit: Fit,
): { x: number; y: number; k: number } {
  const k = native.w > 0 ? fit.w / native.w : 1;
  return { x: fit.x + (pos.x - hot.x) * k, y: fit.y + (pos.y - hot.y) * k, k };
}

/* ── naming a screen ───────────────────────────────────────────────────── */

/** A monitor as `cast_monitors` and the flyway roster announce it:
 *  `cast::Monitor`, field for field. */
export type Monitor = {
  id: string;
  name: string;
  w: number;
  h: number;
  x: number;
  y: number;
  hz: number;
  primary: boolean;
};

/** The literal a widget's `monitor` knob defaults to: this machine's primary
 *  monitor, whichever that is today. A monitor id is the adapter and output,
 *  and both move when a dock is plugged in — so the default names the role,
 *  the way the logs' `FOLLOW` names a role rather than a group. */
export const PRIMARY = "primary";
/** The host half of a screen key that means this machine. */
export const HERE = "here";

/** A screen is a host and a monitor, kept in the widget's one `monitor` knob as
 *  `host/id` so a sourced choice can offer this machine's monitors and every
 *  other wall's in one list. The id is everything after the first slash, so an
 *  id that itself carries one survives. */
export function screenKey(host: string | null, monitor: string): string {
  return `${host ?? HERE}/${monitor}`;
}

export function parseScreen(key: string): { host: string | null; monitor: string } {
  const at = key.indexOf("/");
  if (at < 0) return { host: null, monitor: key || PRIMARY };
  const host = key.slice(0, at);
  return { host: host === HERE || host === "" ? null : host, monitor: key.slice(at + 1) || PRIMARY };
}

/** Which of `monitors` a key's monitor names, the role resolved. */
export function resolveMonitor(monitors: readonly Monitor[], id: string): Monitor | null {
  if (id === PRIMARY) return monitors.find((m) => m.primary) ?? monitors[0] ?? null;
  return monitors.find((m) => m.id === id) ?? null;
}

/** "Dell U2723QE · 2560×1440", or the position when two are called the same
 *  thing — two "Generic PnP Monitor"s are told apart by where they stand. */
export function monitorLabel(m: Monitor, all: readonly Monitor[] = [m]): string {
  const twin = all.some((o) => o !== m && o.name === m.name);
  const where = twin ? (m.primary ? " · main" : m.x < 0 ? " · left" : m.x > 0 ? " · right" : m.y < 0 ? " · above" : " · below") : "";
  return `${m.name}${where} · ${m.w}×${m.h}`;
}

/** What the tile's label says for each state, in the house's lowercase. Only
 *  `live` says nothing — the picture is the reading. */
export function stateWords(state: CastState, why = ""): string | null {
  switch (state) {
    case "connecting":
      return "connecting…";
    case "live":
      return null;
    case "paused":
      return "paused — out of sight";
    case "locked":
      return "locked — the machine is on its sign-in screen";
    case "refused":
      return why || "that machine doesn't take work from other walls";
    case "ended":
      return why ? `ended — ${why}` : "ended";
  }
}

/** The stats line under the name: "60 fps · 14 ms · direct". Each part only
 *  when it is known, so a far screen with no latency reading says less rather
 *  than a guess. */
export function statsLine(s: Stats | null, path: "direct" | "relay" | null): string {
  const parts: string[] = [];
  if (s && s.fps > 0) parts.push(`${s.fps} fps`);
  if (s && s.latencyMs !== null) parts.push(`${Math.round(s.latencyMs)} ms`);
  if (path) parts.push(path);
  return parts.join(" · ");
}
