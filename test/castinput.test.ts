import { describe, expect, test } from "bun:test";
import {
  buttonCode,
  keyBytes,
  keyInput,
  normalize,
  PAUSE,
  pointerInput,
  relativeInput,
  releaseAll,
  scancodeOf,
  SCANCODES,
  wheelAccumulator,
} from "../src/lib/castinput";

const bytes = (u: Uint8Array | null) => (u ? [...u] : null);
const fit = { x: 100, y: 50, w: 800, h: 450 };

/* Copied from `src-tauri/src/cast/wire.rs`'s
   `input_events_round_trip_concatenated`. Change one there and this changes
   with it, in the same commit. */
describe("the bytes are wire.rs's", () => {
  test("each event matches its fixture", () => {
    expect(bytes(pointerInput({ clientX: 100, clientY: 500, button: 0 }, fit, "move"))).toEqual([
      0x11, 0x00, 0x00, 0xff, 0xff,
    ]);
    expect(bytes(relativeInput({ movementX: -5, movementY: 300 }))).toEqual([
      0x12, 0xfb, 0xff, 0x2c, 0x01,
    ]);
    // the DOM's right button is 2; the wire's is 1
    const down = pointerInput({ clientX: 100, clientY: 500, button: 2 }, fit, "down")!;
    expect([...down.slice(5)]).toEqual([0x13, 0x01, 0x01]);
    // a DOM notch down (deltaY +100) is Windows' -120
    expect(bytes(wheelAccumulator()({ deltaX: 0, deltaY: 100, deltaMode: 0 }))).toEqual([
      0x14, 0x00, 0x00, 0x88, 0xff,
    ]);
    expect(bytes(keyInput({ code: "ControlRight", type: "keyup" }))).toEqual([
      0x15, 0x1d, 0xe0, 0x00,
    ]);
    expect(bytes(releaseAll())).toEqual([0x16]);
  });

  test("a key down is make code, little-endian, then 1", () => {
    expect([...keyBytes(0x1e, true)]).toEqual([0x15, 0x1e, 0x00, 0x01]);
  });
});

describe("scancodes", () => {
  test("letters and digits are set 1", () => {
    expect(scancodeOf("KeyA")).toBe(0x1e);
    expect(scancodeOf("KeyQ")).toBe(0x10);
    expect(scancodeOf("KeyZ")).toBe(0x2c);
    expect(scancodeOf("KeyM")).toBe(0x32);
    expect(scancodeOf("Digit1")).toBe(0x02);
    expect(scancodeOf("Digit0")).toBe(0x0b);
  });

  test("every letter and digit, F1–F24 and the numpad are mapped", () => {
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") expect(scancodeOf(`Key${c}`)).not.toBeNull();
    for (let d = 0; d <= 9; d++) {
      expect(scancodeOf(`Digit${d}`)).not.toBeNull();
      expect(scancodeOf(`Numpad${d}`)).not.toBeNull();
    }
    for (let f = 1; f <= 24; f++) expect(scancodeOf(`F${f}`)).not.toBeNull();
    expect(scancodeOf("F11")).toBe(0x57);
    expect(scancodeOf("F13")).toBe(0x64);
    expect(scancodeOf("F24")).toBe(0x76);
  });

  test("the extended keys carry E0", () => {
    expect(scancodeOf("NumpadEnter")).toBe(0xe01c);
    expect(scancodeOf("NumpadDivide")).toBe(0xe035);
    expect(scancodeOf("ArrowUp")).toBe(0xe048);
    expect(scancodeOf("Delete")).toBe(0xe053);
    expect(scancodeOf("MetaLeft")).toBe(0xe05b);
    expect(scancodeOf("MetaRight")).toBe(0xe05c);
    expect(scancodeOf("ContextMenu")).toBe(0xe05d);
    expect(scancodeOf("PrintScreen")).toBe(0xe037);
    expect(scancodeOf("AltRight")).toBe(0xe038);
    // the same physical key off the numpad is not extended
    expect(scancodeOf("Enter")).toBe(0x1c);
    expect(scancodeOf("Numpad8")).toBe(0x48);
  });

  test("the international keys an AZERTY board has", () => {
    expect(scancodeOf("IntlBackslash")).toBe(0x56); // < > beside left shift
    expect(scancodeOf("IntlRo")).toBe(0x73);
    expect(scancodeOf("IntlYen")).toBe(0x7d);
    expect(scancodeOf("Lang1")).toBe(0x72);
    expect(scancodeOf("Lang2")).toBe(0x71);
  });

  test("Pause is its sentinel and NumLock is plain set 1", () => {
    expect(scancodeOf("Pause")).toBe(PAUSE);
    expect(PAUSE).toBe(0xe11d);
    expect(scancodeOf("NumLock")).toBe(0x45);
  });

  test("no two codes share a scancode", () => {
    const seen = new Map<number, string>();
    for (const [code, scan] of Object.entries(SCANCODES)) {
      expect(seen.get(scan)).toBeUndefined();
      seen.set(scan, code);
    }
  });

  test("an unknown code is nothing, not a guess", () => {
    expect(scancodeOf("Fn")).toBeNull();
    expect(scancodeOf("toString")).toBeNull();
    expect(keyInput({ code: "Fn", type: "keydown" })).toBeNull();
    expect(keyInput({ code: "KeyA", type: "keypress" })).toBeNull();
  });

  test("a repeat is another down", () => {
    expect(bytes(keyInput({ code: "KeyA", type: "keydown", repeat: true }))).toEqual([
      0x15, 0x1e, 0x00, 0x01,
    ]);
  });
});

describe("the pointer", () => {
  test("the DOM's middle and right buttons swap", () => {
    expect(buttonCode(0)).toBe(0);
    expect(buttonCode(1)).toBe(2);
    expect(buttonCode(2)).toBe(1);
    expect(buttonCode(3)).toBe(3);
    expect(buttonCode(4)).toBe(4);
    expect(buttonCode(5)).toBeNull();
  });

  test("corners and centre go through the letterbox", () => {
    expect(normalize({ clientX: 100, clientY: 50 }, fit, false)).toEqual({ x: 0, y: 0 });
    expect(normalize({ clientX: 900, clientY: 500 }, fit, false)).toEqual({ x: 65535, y: 65535 });
    expect(normalize({ clientX: 500, clientY: 275 }, fit, false)).toEqual({ x: 32768, y: 32768 });
  });

  test("a move into the letterbox is nothing", () => {
    expect(pointerInput({ clientX: 99, clientY: 200, button: 0 }, fit, "move")).toBeNull();
    expect(pointerInput({ clientX: 500, clientY: 501, button: 0 }, fit, "move")).toBeNull();
  });

  test("an up outside the picture is still sent, clamped to the edge", () => {
    const up = pointerInput({ clientX: 2000, clientY: -40, button: 0 }, fit, "up")!;
    expect([...up]).toEqual([0x11, 0xff, 0xff, 0x00, 0x00, 0x13, 0x00, 0x00]);
  });

  test("an up with no picture to aim at still lifts the button", () => {
    const up = pointerInput({ clientX: 0, clientY: 0, button: 1 }, { x: 0, y: 0, w: 0, h: 0 }, "up");
    expect(bytes(up)).toEqual([0x13, 0x02, 0x00]);
  });

  test("a down is the position, then the press", () => {
    const d = pointerInput({ clientX: 500, clientY: 275, button: 0 }, fit, "down")!;
    expect([...d]).toEqual([0x11, 0x00, 0x80, 0x00, 0x80, 0x13, 0x00, 0x01]);
  });

  test("a relative jump past i16 is split, not shortened", () => {
    const r = relativeInput({ movementX: 40000, movementY: 0 })!;
    expect(r.length).toBe(10);
    const v = new DataView(r.buffer);
    expect(v.getInt16(1, true) + v.getInt16(6, true)).toBe(40000);
    expect(relativeInput({ movementX: 0, movementY: 0 })).toBeNull();
  });
});

describe("the wheel", () => {
  test("lines and pages", () => {
    const w = wheelAccumulator();
    expect(bytes(w({ deltaX: 0, deltaY: -3, deltaMode: 1 }))).toEqual([0x14, 0, 0, 120, 0]);
    expect(bytes(w({ deltaX: 1, deltaY: 0, deltaMode: 2 }))).toEqual([0x14, 120, 0, 0, 0]);
  });

  test("a touchpad's small deltas are carried, not rounded away", () => {
    const w = wheelAccumulator();
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const b = w({ deltaX: 0, deltaY: 0.5, deltaMode: 0 });
      if (b) total += new DataView(b.buffer).getInt16(3, true);
    }
    // 5 px at 100 px a notch is 6 units, scrolling down
    expect(total).toBe(-6);
  });

  test("the notch size is a parameter", () => {
    expect(bytes(wheelAccumulator(150)({ deltaX: 0, deltaY: 150, deltaMode: 0 }))).toEqual([
      0x14, 0, 0, 0x88, 0xff,
    ]);
  });

  test("a huge delta is split into several events", () => {
    const b = wheelAccumulator()({ deltaX: 0, deltaY: -40000, deltaMode: 0 })!;
    expect(b.length % 5).toBe(0);
    let sum = 0;
    for (let i = 0; i < b.length; i += 5) sum += new DataView(b.buffer).getInt16(i + 3, true);
    expect(sum).toBe(48000);
  });
});
