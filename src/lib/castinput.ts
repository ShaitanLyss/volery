/* The viewer's half of driving a screen: DOM events in, the input bytes
 * `src-tauri/src/cast/wire.rs` reads out. Pure, so every mapping here is a
 * test rather than a thing somebody notices on a far machine.
 *
 * The tile owns the listeners (`Screen.svelte`); this owns what an event
 * *means*. Every function returns one message's bytes — possibly several
 * events concatenated, which `wire::read_inputs` takes in order — or null
 * when the event means nothing to the far machine. Layouts are the table in
 * `docs/SCREENS.md`; little-endian throughout. */

export const MOUSE_ABS = 0x11;
export const MOUSE_REL = 0x12;
export const BUTTON = 0x13;
export const WHEEL = 0x14;
export const KEY = 0x15;
export const RELEASE_ALL = 0x16;

/** The drawn video rectangle inside the tile, in client pixels — the
 * letterboxed picture, not the tile. */
export type Fit = { x: number; y: number; w: number; h: number };

/* ── scancodes ─────────────────────────────────────────────────────────── */

/** `KeyboardEvent.code` → PS/2 set-1 make code, `0xE0xx` for the extended
 * keys. Scancodes rather than virtual keys because they name the *physical*
 * key: the host's own layout decides what it types, which is what a person at
 * that machine would get (Lyss's machines are French AZERTY, so the key where
 * a US board has Q types A on the far machine — the Parsec behaviour, and the
 * right one, since the far machine's shortcuts are laid out for its layout).
 * It is also what games read.
 *
 * Values are the UI Events code table's Windows column, except the two keys
 * where Windows' own reporting is inverted from set 1: NumLock is set-1 `0x45`
 * here (Windows reports it as `E0 45`), and Pause, whose set-1 make is the
 * three-byte `E1 1D 45` and fits no `u16`, is the sentinel `0xE11D`.
 * `cast/inject.rs` sends both, and PrintScreen, as virtual keys, because a
 * scancode-flagged `SendInput` for them is read differently across keyboard
 * drivers. */
export const PAUSE = 0xe11d;

export const SCANCODES: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEqual: 0x59,
  F13: 0x64,
  F14: 0x65,
  F15: 0x66,
  F16: 0x67,
  F17: 0x68,
  F18: 0x69,
  F19: 0x6a,
  F20: 0x6b,
  F21: 0x6c,
  F22: 0x6d,
  F23: 0x6e,
  KanaMode: 0x70,
  Lang2: 0x71,
  Lang1: 0x72,
  IntlRo: 0x73,
  F24: 0x76,
  Convert: 0x79,
  NonConvert: 0x7b,
  IntlYen: 0x7d,
  NumpadComma: 0x7e,

  MediaTrackPrevious: 0xe010,
  MediaTrackNext: 0xe019,
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  AudioVolumeMute: 0xe020,
  LaunchApp2: 0xe021,
  MediaPlayPause: 0xe022,
  MediaStop: 0xe024,
  AudioVolumeDown: 0xe02e,
  AudioVolumeUp: 0xe030,
  BrowserHome: 0xe032,
  NumpadDivide: 0xe035,
  PrintScreen: 0xe037,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
  Power: 0xe05e,
  Sleep: 0xe05f,
  WakeUp: 0xe063,
  BrowserSearch: 0xe065,
  BrowserFavorites: 0xe066,
  BrowserRefresh: 0xe067,
  BrowserStop: 0xe068,
  BrowserForward: 0xe069,
  BrowserBack: 0xe06a,
  LaunchApp1: 0xe06b,
  LaunchMail: 0xe06c,
  MediaSelect: 0xe06d,

  Pause: PAUSE,
};

export function scancodeOf(code: string): number | null {
  return Object.hasOwn(SCANCODES, code) ? SCANCODES[code] : null;
}

/* ── encoding ──────────────────────────────────────────────────────────── */

const clampU16 = (n: number) => Math.max(0, Math.min(65535, Math.round(n)));
const clampI16 = (n: number) => Math.max(-32768, Math.min(32767, Math.trunc(n)));

/** One `0x15`. Exported so the tests and a pasted-text path can share it. */
export function keyBytes(scan: number, down: boolean): Uint8Array {
  return new Uint8Array([KEY, scan & 0xff, (scan >> 8) & 0xff, down ? 1 : 0]);
}

function absBytes(x: number, y: number): number[] {
  return [MOUSE_ABS, x & 0xff, x >> 8, y & 0xff, y >> 8];
}

function i16Pair(kind: number, a: number, b: number): number[] {
  const v = new DataView(new ArrayBuffer(5));
  v.setUint8(0, kind);
  v.setInt16(1, a, true);
  v.setInt16(3, b, true);
  return [...new Uint8Array(v.buffer)];
}

/* ── keys ──────────────────────────────────────────────────────────────── */

/** A key event, or null when the key has no scancode here (the tile should
 * then let it be the wall's).
 *
 * An auto-repeat is sent as another down, which is what Windows' own
 * typematic produces on the host — so an app there sees a held key exactly as
 * it would from a local keyboard, and the far machine never needs to run a
 * repeat timer of its own that could outlive a lost key-up. */
export function keyInput(e: { code: string; type: string; repeat?: boolean }): Uint8Array | null {
  const down = e.type === "keydown" ? true : e.type === "keyup" ? false : null;
  if (down === null) return null;
  const scan = scancodeOf(e.code);
  return scan === null ? null : keyBytes(scan, down);
}

/* ── the pointer ───────────────────────────────────────────────────────── */

/** DOM `MouseEvent.button` → the wire's button code. The two orders differ in
 * the middle: the DOM says 1 is the *middle* button and 2 the right, the wire
 * (and Win32's own left/right/middle order) says the opposite. */
export function buttonCode(domButton: number): number | null {
  switch (domButton) {
    case 0:
      return 0;
    case 1:
      return 2;
    case 2:
      return 1;
    case 3:
      return 3;
    case 4:
      return 4;
    default:
      return null;
  }
}

/** A client point → 0..=65535 over the source monitor, through the letterbox.
 * `clamp` pins a point outside the picture to its edge; without it such a
 * point is null. */
export function normalize(
  pt: { clientX: number; clientY: number },
  fit: Fit,
  clamp: boolean,
): { x: number; y: number } | null {
  if (!(fit.w > 0 && fit.h > 0)) return null;
  const fx = (pt.clientX - fit.x) / fit.w;
  const fy = (pt.clientY - fit.y) / fit.h;
  if (!clamp && (fx < 0 || fy < 0 || fx > 1 || fy > 1)) return null;
  return { x: clampU16(fx * 65535), y: clampU16(fy * 65535) };
}

/** A pointer event as the far machine should see it.
 *
 * - `move` is a position only, and null outside the picture — a move into the
 *   letterbox is the person leaving the screen, not aiming at its edge.
 * - `down` and `up` carry the position first, then the button, so the press
 *   lands where it was aimed even if no move preceded it. Both clamp rather
 *   than drop: a down in the margin is rare and harmless at the edge, and **an
 *   `up` must never be lost** — a dropped up is a button held down for ever on
 *   a machine nobody may be sitting at. So an `up` is null only when the
 *   button itself is not one the wire knows.
 *
 * `button` is the DOM's numbering; the swap is done here. */
export function pointerInput(
  e: { clientX: number; clientY: number; button: number },
  fit: Fit,
  act: "move" | "down" | "up",
): Uint8Array | null {
  if (act === "move") {
    const p = normalize(e, fit, false);
    return p ? new Uint8Array(absBytes(p.x, p.y)) : null;
  }
  const code = buttonCode(e.button);
  if (code === null) return null;
  const p = normalize(e, fit, true);
  const press = [BUTTON, code, act === "down" ? 1 : 0];
  return new Uint8Array(p ? [...absBytes(p.x, p.y), ...press] : press);
}

/** Pointer-locked movement, for a far game that reads raw counts. Large jumps
 * are split rather than clamped, so a flick is not shortened. */
export function relativeInput(e: { movementX: number; movementY: number }): Uint8Array | null {
  let dx = Math.trunc(e.movementX);
  let dy = Math.trunc(e.movementY);
  if (dx === 0 && dy === 0) return null;
  const out: number[] = [];
  while (dx !== 0 || dy !== 0) {
    const sx = clampI16(dx);
    const sy = clampI16(dy);
    out.push(...i16Pair(MOUSE_REL, sx, sy));
    dx -= sx;
    dy -= sy;
  }
  return new Uint8Array(out);
}

/* ── the wheel ─────────────────────────────────────────────────────────── */

/** One wheel notch in Windows' units. */
export const NOTCH = 120;
/** Windows' default: three lines a notch, so a line is 40 units. */
const LINES_PER_NOTCH = 3;

/** A wheel that remembers what it has not sent yet.
 *
 * A precision touchpad delivers a stream of small pixel deltas, and rounding
 * each to whole units on its own would lose most of a slow scroll; so the
 * remainder is carried to the next event. Units below a notch are sent as
 * they are — Windows calls that a high-resolution wheel and every app that
 * scrolls smoothly reads it, while one that only understands notches
 * accumulates them itself, which is what Windows requires of it.
 *
 * Signs go to Windows' here: the DOM's positive `deltaY` is scrolling *down*,
 * Win32's positive wheel delta is the wheel rotated *away* from you, which
 * scrolls up. Horizontal agrees in both: positive is right.
 *
 * `pxPerNotch` is what one notch of a real wheel reads as in `deltaMode` 0.
 * Chromium on Windows reports 100 at 100% scaling; whether that grows with the
 * display scale is the one thing here worth checking on Lyss's 150% panel,
 * hence a parameter rather than a constant. One per session. */
export function wheelAccumulator(pxPerNotch = 100) {
  let restX = 0;
  let restY = 0;
  return (e: { deltaX: number; deltaY: number; deltaMode: number }): Uint8Array | null => {
    const unit =
      e.deltaMode === 1
        ? NOTCH / LINES_PER_NOTCH
        : e.deltaMode === 2
          ? NOTCH
          : NOTCH / pxPerNotch;
    restX += e.deltaX * unit;
    restY += -e.deltaY * unit;
    /* A hair of slack, so ten deltas of 0.6 make the 6 they add up to rather
       than the 5.999… binary fractions do. */
    let dx = Math.trunc(restX + Math.sign(restX) * 1e-9);
    let dy = Math.trunc(restY + Math.sign(restY) * 1e-9);
    if (dx === 0 && dy === 0) return null;
    restX -= dx;
    restY -= dy;
    const out: number[] = [];
    while (dx !== 0 || dy !== 0) {
      const sx = clampI16(dx);
      const sy = clampI16(dy);
      out.push(...i16Pair(WHEEL, sx, sy));
      dx -= sx;
      dy -= sy;
    }
    return new Uint8Array(out);
  };
}

/* ── letting go ────────────────────────────────────────────────────────── */

/** Lift every key and button this viewer holds on the far machine. Sent on
 * blur, on the page going hidden, and on leaving focused mode — any moment the
 * tile stops hearing key-ups, since the key-up it would have heard next is the
 * one that never arrives. The host tracks what each viewer holds, so this
 * lifts exactly that and nothing a person at the far machine is holding. */
export function releaseAll(): Uint8Array {
  return new Uint8Array([RELEASE_ALL]);
}
