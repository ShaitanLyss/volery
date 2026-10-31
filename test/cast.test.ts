import { describe, expect, test } from "bun:test";
import {
  base64,
  codecFromAnnexB,
  codecOk,
  crc32,
  cursorCss,
  decoderConfig,
  driveText,
  EscapeHold,
  drivableAt,
  watchingWords,
  fitIn,
  isKeyframe,
  KEY_TEXT,
  monitorLabel,
  nalUnits,
  parseScreen,
  prune,
  readBinary,
  readCursorPos,
  readCursorShape,
  readText,
  readVideo,
  resolveMonitor,
  rgbaToPng,
  sameWant,
  scaleRgba,
  screenKey,
  screenOptions,
  snapUp,
  stateWords,
  statsLine,
  summarize,
  want,
  wantText,
  PRIMARY,
  VIDEO_HEADER,
  type Monitor,
  type Seen,
} from "../src/lib/cast";

/* These byte strings are `src-tauri/src/cast/wire.rs`'s test fixtures, copied
   byte for byte. Change one there and this copy changes with it, in the same
   commit — that is the whole of what keeps the two halves of the wire from
   drifting. */

const VIDEO_FIXTURE = [
  0x01, 0x01, 0x00, 0x0a, 0xa0, 0x05, 0x07, 0x00, 0x00, 0x00, //
  0x01, 0x50, 0x2a, 0x07, 0x59, 0x42, 0x06, 0x00, //
  0xe1, 0x60, 0x2a, 0x07, 0x59, 0x42, 0x06, 0x00,
];

describe("the wire, as wire.rs writes it", () => {
  test("a video header is twenty-six bytes, little-endian", () => {
    const msg = new Uint8Array([...VIDEO_FIXTURE, 0, 0, 0, 1, 0x67]);
    const v = readVideo(msg)!;
    expect(v).not.toBeNull();
    expect(v.key).toBe(true);
    expect(v.w).toBe(2560);
    expect(v.h).toBe(1440);
    expect(v.seq).toBe(7);
    expect(v.captureUs).toBe(1_761_800_000_000_001);
    expect(v.encodedUs).toBe(1_761_800_000_004_321);
    expect([...v.data]).toEqual([0, 0, 0, 1, 0x67]);
    expect(isKeyframe(msg)).toBe(true);
    expect(isKeyframe(msg.buffer)).toBe(true);
  });

  test("it reads from an ArrayBuffer and from a view into the middle of one", () => {
    const backing = new Uint8Array(40);
    backing.set(VIDEO_FIXTURE, 7);
    const view = backing.subarray(7, 7 + VIDEO_HEADER);
    expect(readVideo(view)?.w).toBe(2560);
    expect(readVideo(new Uint8Array(VIDEO_FIXTURE).buffer)?.seq).toBe(7);
  });

  test("a delta frame is not a keyframe and a short message is not a frame", () => {
    const delta = new Uint8Array(VIDEO_HEADER);
    delta[0] = 0x01;
    delta[2] = 1;
    delta[4] = 1;
    expect(isKeyframe(delta)).toBe(false);
    expect(readVideo(delta)?.key).toBe(false);
    expect(readVideo(delta.subarray(0, VIDEO_HEADER - 1))).toBeNull();
  });

  test("cursor messages carry their shape id", () => {
    const shape = new Uint8Array([0x02, 0, 1, 0, 1, 0, 0, 0, 0, 0, 9, 0, 0, 0, 1, 2, 3, 4]);
    const s = readCursorShape(shape)!;
    expect(s).toMatchObject({ w: 1, h: 1, hotX: 0, hotY: 0, shape: 9 });
    expect([...s.rgba]).toEqual([1, 2, 3, 4]);
    const pos = readCursorPos(new Uint8Array([0x03, 1, 0xfd, 0xff, 0xa0, 0x05, 9, 0, 0, 0]));
    expect(pos).toEqual({ kind: "pos", visible: true, x: -3, y: 1440, shape: 9 });
  });

  test("a shape whose pixels do not match its size is refused", () => {
    expect(readCursorShape(new Uint8Array([0x02, 0, 2, 0, 1, 0, 0, 0, 0, 0, 9, 0, 0, 0, 1, 2, 3, 4]))).toBeNull();
  });

  test("readBinary routes by kind and skips audio and anything unknown", () => {
    expect(readBinary(new Uint8Array(VIDEO_FIXTURE))?.kind).toBe("video");
    expect(readBinary(new Uint8Array([0x03, 0, 0, 0, 0, 0, 1, 0, 0, 0]))?.kind).toBe("pos");
    expect(readBinary(new Uint8Array([0x04, 1, 2, 3]))).toBeNull();
    expect(readBinary(new Uint8Array([0x7f]))).toBeNull();
    expect(readBinary(new Uint8Array([]))).toBeNull();
  });
});

describe("the text messages", () => {
  test("config, state and stats are read; malformed and unknown are not", () => {
    expect(readText('{"t":"config","codec":"avc1.64002a","w":2560,"h":1440,"fps":60}')).toEqual({
      t: "config",
      codec: "avc1.64002a",
      w: 2560,
      h: 1440,
      fps: 60,
    });
    expect(readText('{"t":"config","codec":"avc1.64002a","w":0,"h":1440}')).toBeNull();
    expect(readText('{"t":"state","state":"locked"}')).toEqual({ t: "state", state: "locked", why: "" });
    expect(readText('{"t":"state","state":"connecting"}')).toBeNull();
    expect(readText('{"t":"state","state":"melted"}')).toBeNull();
    expect(readText('{"t":"stats","rtt":12}')).toEqual({ t: "stats", stats: { rtt: 12 } });
    expect(readText('{"t":"later"}')).toBeNull();
    expect(readText('{"t":"drive","on":false,"why":"a screen already holds the keyboard"}')).toEqual({
      t: "drive",
      on: false,
      why: "a screen already holds the keyboard",
    });
    expect(readText('{"t":"drive","on":true}')).toEqual({ t: "drive", on: true, why: "" });
    expect(readText('{"t":"drive"}')).toBeNull();
    expect(readText('{"t":"hold","phase":"done"}')).toEqual({ t: "hold", phase: "done" });
    expect(readText('{"t":"hold","phase":"sideways"}')).toBeNull();
    expect(readText("not json")).toBeNull();
    expect(readText("7")).toBeNull();
  });

  test("what the viewer says back is the contract's JSON", () => {
    expect(JSON.parse(wantText({ w: 640, h: 360, fps: 30, visible: true, focused: false }))).toEqual({
      t: "want",
      w: 640,
      h: 360,
      fps: 30,
      visible: true,
      focused: false,
    });
    expect(JSON.parse(KEY_TEXT)).toEqual({ t: "key" });
    expect(JSON.parse(driveText(true))).toEqual({ t: "drive", on: true });
  });
});

describe("what a tile asks for", () => {
  const base: Seen = {
    boxW: 640,
    boxH: 360,
    scale: 1,
    dpr: 1,
    src: { w: 2560, h: 1440 },
    hz: 144,
    visible: true,
    focused: false,
  };

  test("the adaptive table: focused, visible, small, hidden", () => {
    expect(want({ ...base, focused: true }).fps).toBe(120);
    expect(want({ ...base, focused: true, hz: 60 }).fps).toBe(60);
    expect(want(base).fps).toBe(30);
    expect(want({ ...base, scale: 0.4 }).fps).toBe(15);
    const hidden = want({ ...base, visible: false });
    expect(hidden.fps).toBe(0);
    expect(hidden.visible).toBe(false);
    /* Its size is still said, so the keyframe on return is the right shape. */
    expect(hidden.w).toBeGreaterThan(0);
  });

  test("a calm tile asks for a frame a second until it is driven or focused", () => {
    expect(want({ ...base, calm: true }).fps).toBe(1);
    expect(want({ ...base, calm: true, driving: true }).fps).toBe(30);
    expect(want({ ...base, calm: true, focused: true }).fps).toBe(120);
    expect(want({ ...base, calm: true, visible: false }).fps).toBe(0);
  });

  test("the size is device pixels of the picture, not of the letterbox", () => {
    const w = want({ ...base, boxH: 1000, dpr: 1.5 });
    expect(w.w).toBeGreaterThanOrEqual(960);
    expect(w.h).toBeGreaterThanOrEqual(540);
    expect(w.h).toBeLessThan(1000 * 1.5);
  });

  test("it never asks past the source", () => {
    const w = want({ ...base, boxW: 4000, boxH: 2250, dpr: 2 });
    expect(w).toMatchObject({ w: 2560, h: 1440 });
  });

  test("a small zoom asks for nothing new; a large one does", () => {
    const a = want(base);
    expect(sameWant(a, want({ ...base, scale: 0.99 }))).toBe(true);
    expect(sameWant(a, want({ ...base, scale: 0.6 }))).toBe(false);
    expect(sameWant(null, null)).toBe(true);
    expect(sameWant(a, null)).toBe(false);
  });

  test("snapping rounds up, to even sizes, on a quarter-octave ladder", () => {
    for (const px of [17, 100, 333, 640, 1001, 2559]) {
      const s = snapUp(px);
      expect(s).toBeGreaterThanOrEqual(px);
      expect(s % 2).toBe(0);
      expect(s / px).toBeLessThan(1.2);
    }
    expect(snapUp(0)).toBe(16);
  });

  test("letterboxing centres the source's shape in the box", () => {
    expect(fitIn({ w: 16, h: 9 }, { w: 160, h: 190 })).toEqual({ x: 0, y: 50, w: 160, h: 90 });
    expect(fitIn({ w: 0, h: 0 }, { w: 10, h: 20 })).toEqual({ x: 0, y: 0, w: 10, h: 20 });
  });
});

describe("the codec", () => {
  test("which strings a decoder may be configured with", () => {
    expect(codecOk("avc1.64002a")).toBe(true);
    expect(codecOk("avc1.64002")).toBe(false);
    expect(codecOk("hev1.1.6.L120.B0")).toBe(true);
    expect(codecOk("vp09.00.10.08")).toBe(false);
  });

  test("an SPS names its own codec string", () => {
    const annexb = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x64, 0x00, 0x2a, 0xac, 0, // SPS, then a four-byte start code
      0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, // PPS
      0, 0, 1, 0x65, 0x88, 0x84, // IDR, three-byte start code
    ]);
    expect(codecFromAnnexB(annexb)).toBe("avc1.64002a");
    const units = nalUnits(annexb);
    expect(units.map((u) => u[0] & 0x1f)).toEqual([7, 8, 5]);
    /* The trailing zero before a four-byte start code is not the SPS's. */
    expect([...units[0]]).toEqual([0x67, 0x64, 0x00, 0x2a, 0xac]);
    expect(codecFromAnnexB(new Uint8Array([0, 0, 1, 0x41, 1]))).toBeNull();
  });

  test("the decoder is configured for latency, on the GPU, with no description", () => {
    const c = decoderConfig({ codec: "avc1.64002a", w: 2560, h: 1440, fps: 60 });
    expect(c).toEqual({
      codec: "avc1.64002a",
      codedWidth: 2560,
      codedHeight: 1440,
      hardwareAcceleration: "prefer-hardware",
      optimizeForLatency: true,
    });
    expect("description" in c).toBe(false);
  });
});

describe("the stats", () => {
  test("fps, the median latency and the bitrate over the last second", () => {
    const now = 10_000;
    const ticks = Array.from({ length: 30 }, (_, i) => ({
      shown: now - 990 + i * 33,
      capture: now - 990 + i * 33 - (i === 5 ? 400 : 12),
      bytes: 5000,
    }));
    const s = summarize(ticks, now);
    expect(s.fps).toBe(30);
    expect(s.latencyMs).toBe(12);
    expect(s.kbps).toBe(1200);
  });

  test("an absurd reading across two clocks is dropped rather than drawn", () => {
    const s = summarize([{ shown: 100, capture: 200, bytes: 0 }], 100);
    expect(s.latencyMs).toBeNull();
    expect(statsLine(s, "relay")).toBe("1 fps · relay");
  });

  test("the ring keeps only what the window can read", () => {
    const t = [
      { shown: 0, capture: 0, bytes: 1 },
      { shown: 1500, capture: 1500, bytes: 1 },
    ];
    expect(prune(t, 2000)).toHaveLength(1);
  });

  test("the stats line says only what is known", () => {
    expect(statsLine(null, null)).toBe("");
    expect(statsLine({ fps: 60, latencyMs: 14.4, kbps: 0 }, "direct")).toBe("60 fps · 14 ms · direct");
  });
});

describe("the remote cursor as the OS's own", () => {
  test("crc32 is the PNG one", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("base64 matches the platform's", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "hello world!"]) {
      expect(base64(new TextEncoder().encode(s))).toBe(btoa(s));
    }
  });

  test("a PNG of the shape is well formed", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 255]);
    const png = rgbaToPng(rgba, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const d = new DataView(png.buffer);
    expect(d.getUint32(8)).toBe(13);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
    expect(d.getUint32(16)).toBe(2);
    expect(d.getUint32(20)).toBe(2);
    /* Every chunk's CRC checks out. */
    let o = 8;
    const seen: string[] = [];
    while (o < png.length) {
      const len = d.getUint32(o);
      const type = new TextDecoder().decode(png.subarray(o + 4, o + 8));
      seen.push(type);
      expect(d.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
      o += 12 + len;
    }
    expect(seen).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(o).toBe(png.length);
  });

  test("the PNG decodes back to the same pixels", async () => {
    /* Bun has no image decoder, so inflate the IDAT with zlib and compare the
       scanlines — which is what any decoder does first. */
    const { inflateSync } = await import("node:zlib");
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
    const png = rgbaToPng(rgba, 3, 2);
    const d = new DataView(png.buffer);
    let o = 8 + 25;
    const len = d.getUint32(o);
    const raw = inflateSync(png.subarray(o + 8, o + 8 + len));
    expect(raw.length).toBe(2 * (3 * 4 + 1));
    expect([...raw.subarray(1, 13)]).toEqual([...rgba.subarray(0, 12)]);
    expect([...raw.subarray(14, 26)]).toEqual([...rgba.subarray(12, 24)]);
  });

  test("a scaled cursor keeps its hot spot where the arrow points", () => {
    const rgba = new Uint8Array(32 * 32 * 4);
    const css = cursorCss({ rgba, w: 32, h: 32, hotX: 10, hotY: 20 }, 0.5);
    expect(css).toMatch(/^url\(data:image\/png;base64,[A-Za-z0-9+/=]+\) 5 10, default$/);
    expect(scaleRgba(rgba, 32, 32, 0.5)).toMatchObject({ w: 16, h: 16 });
    /* Past Chromium's 128px ceiling it is clamped rather than refused. */
    const big = cursorCss({ rgba, w: 32, h: 32, hotX: 31, hotY: 31 }, 8);
    expect(big).toMatch(/\) 124 124, default$/);
  });
});

describe("naming a screen", () => {
  const ms: Monitor[] = [
    { id: "a:0", name: "Generic PnP Monitor", w: 2560, h: 1440, x: 0, y: 0, hz: 144, primary: true },
    { id: "a:1", name: "Generic PnP Monitor", w: 1920, h: 1080, x: -1920, y: 0, hz: 60, primary: false },
    { id: "b:0", name: "Built-in display", w: 2880, h: 1800, x: 2560, y: 0, hz: 120, primary: false },
  ];

  test("a key is a host and a monitor, and this machine is the default host", () => {
    expect(screenKey(null, "a:0")).toBe("here/a:0");
    expect(parseScreen("here/a:0")).toEqual({ host: null, monitor: "a:0" });
    expect(parseScreen("wall7/x/y")).toEqual({ host: "wall7", monitor: "x/y" });
    expect(parseScreen("here/")).toEqual({ host: null, monitor: PRIMARY });
    expect(parseScreen("")).toEqual({ host: null, monitor: PRIMARY });
  });

  test("the primary role resolves to whichever is primary today", () => {
    expect(resolveMonitor(ms, PRIMARY)?.id).toBe("a:0");
    expect(resolveMonitor(ms, "b:0")?.name).toBe("Built-in display");
    expect(resolveMonitor(ms, "gone")).toBeNull();
    expect(resolveMonitor([], PRIMARY)).toBeNull();
  });

  test("two monitors of one name are told apart by where they stand", () => {
    expect(monitorLabel(ms[0], ms)).toBe("Generic PnP Monitor · main · 2560×1440");
    expect(monitorLabel(ms[1], ms)).toBe("Generic PnP Monitor · left · 1920×1080");
    expect(monitorLabel(ms[2], ms)).toBe("Built-in display · 2880×1800");
  });

  test("every state has its words, and live says nothing", () => {
    expect(stateWords("live")).toBeNull();
    expect(stateWords("refused")).toBe("that machine doesn't take work from other walls");
    expect(stateWords("ended", "the socket closed")).toBe("ended — the socket closed");
    for (const s of ["connecting", "paused", "locked"] as const) expect(stateWords(s)).toBeTruthy();
  });
});

describe("the screen knob's options", () => {
  const one: Monitor = { id: "a:0", name: "Panel", w: 2880, h: 1800, x: 0, y: 0, hz: 120, primary: true };
  const two: Monitor = { ...one, id: "a:1", x: 2880, primary: false };

  test("one screen and nowhere else is not a choice", () => {
    expect(screenOptions([one], [])).toEqual([]);
  });

  test("this machine's, then each other wall's, by host", () => {
    const o = screenOptions([one, two], [{ host: "w2", name: "desk", monitors: [one] }]);
    expect(o.map((x) => x.value)).toEqual(["here/a:0", "here/a:1", "w2/a:0"]);
    expect(o[2].label).toBe("desk · Panel · 2880×1800");
    expect(o[0].label).toBe("here · Panel · main · 2880×1800");
  });
});

describe("whether a tile drives", () => {
  test("this machine's screen only watches until local driving is switched on", () => {
    expect(drivableAt(null, true)).toBe(false);
    expect(drivableAt(null, true, true)).toBe(true);
    expect(watchingWords(null, true)).toBe("watching — driving this machine comes next");
    expect(watchingWords(null, true, true)).toBeNull();
  });

  test("a far screen drives only when its knob says so", () => {
    expect(drivableAt("desk", false)).toBe(false);
    expect(drivableAt("desk", true)).toBe(true);
    expect(watchingWords("desk", false)).toMatch(/^watching — turn on/);
    expect(watchingWords("desk", true)).toBeNull();
  });
});

describe("escape, tapped or held", () => {
  const fake = () => {
    let f: (() => void) | null = null;
    return {
      timers: { set: (fn: () => void) => ((f = fn), 1), clear: () => (f = null) },
      fire: () => f?.(),
    };
  };

  test("a tap is sent whole when the key comes up, and leaves nothing behind", () => {
    const t = fake();
    const said: string[] = [];
    const h = new EscapeHold({ tap: () => said.push("tap"), hold: () => said.push("hold") }, 500, t.timers);
    h.down();
    h.down(); // auto-repeat
    expect(h.holding).toBe(true);
    h.up();
    expect(said).toEqual(["tap"]);
    t.fire();
    expect(said).toEqual(["tap"]);
  });

  test("a hold leaves, and its key-up sends no tap", () => {
    const t = fake();
    const said: string[] = [];
    const h = new EscapeHold({ tap: () => said.push("tap"), hold: () => said.push("hold") }, 500, t.timers);
    h.down();
    t.fire();
    h.down(); // still held, repeating
    h.up();
    expect(said).toEqual(["hold"]);
  });

  test("a press interrupted by losing focus is neither", () => {
    const t = fake();
    const said: string[] = [];
    const h = new EscapeHold({ tap: () => said.push("tap"), hold: () => said.push("hold") }, 500, t.timers);
    h.down();
    h.cancel();
    h.up();
    t.fire();
    expect(said).toEqual([]);
  });
});
