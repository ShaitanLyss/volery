/** The arithmetic and the vocabulary behind the browser widget.
 *
 * `browser.rs` starts a Chrome and says where its CDP port is. Everything after
 * that is here and in `pane.svelte.ts`: the frames come over a WebSocket the
 * front end opens itself, and nothing about a frame crosses the Tauri IPC. This
 * file is the pure half — the coordinate mapping, the key translation, and the
 * fold from CDP events to log rows — so it can be tested without a browser, a
 * socket, or an app.
 *
 * ### Why a screencast rather than a webview
 *
 * `Page.startScreencast` **pushes** `Page.screencastFrame` events, and pushes
 * them *on change*: probed 2026-09-03, a page sitting idle produced **0 frames
 * in 1.2s**, and the first frame after a change arrived 11ms after
 * `startScreencast` returned. So a browser widget left open on the wall costs
 * nothing while nothing is happening, which is the bar `motion.md` sets — and it
 * is a fold over an event stream rather than a poller, which is the bar
 * `CLAUDE.md` sets. Frames measured ~6 kB on a simple page and ~95 kB for a
 * full 1280×800 view of a real app at quality 80.
 *
 * ### Why the input half works at all
 *
 * `Input.dispatchMouseEvent` is synthesized inside the renderer and needs **no
 * real window focus**. That is the fact the whole feature rests on: the widget
 * can put a click into a page without the wall losing focus, without Chrome
 * coming to the front, and without competing with the canvas for the pointer.
 * Proved end to end the same day — a click dispatched from a second, independent
 * CDP client landed in a page Playwright was driving, and the page's own
 * counter went from 0 to 1.
 */

import type { Row, Tone } from "./logface";
import type { WidgetConfig } from "./widgets";
import { FOLLOW } from "./logface";

/* ── where the picture goes ────────────────────────────────────────────── */

/** A frame's placing inside the widget, in the widget's own pixels. */
export type Fit = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** What the frame was multiplied by to get here. Kept because the inverse is
   *  what turns a click back into a page coordinate, and recomputing it from
   *  `w / frame.w` at the call site is how the two drift apart. */
  scale: number;
};

/** Letterbox a frame of `frame` into a box of `box`, centred.
 *
 * Contain rather than cover, and it is not a matter of taste: the page is being
 * *read*, and cropping the right-hand edge of an app silently hides the thing
 * somebody is looking for. Letterboxing wastes some of the widget and hides
 * nothing.
 *
 * Never scales up past 1. A 400×300 screencast blown up to fill a 1200px widget
 * is a blurry lie about a page that is genuinely 400 wide, and the blur reads as
 * the app being broken rather than as the widget being generous.
 */
export function fitFrame(
  frame: { w: number; h: number },
  box: { w: number; h: number },
): Fit {
  if (frame.w <= 0 || frame.h <= 0 || box.w <= 0 || box.h <= 0) {
    return { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  }
  const scale = Math.min(box.w / frame.w, box.h / frame.h, 1);
  const w = frame.w * scale;
  const h = frame.h * scale;
  return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h, scale };
}

/** What a screencast frame says about the page it is a picture of.
 *
 * The fields Chrome sends that this file needs. `deviceWidth`/`deviceHeight` are
 * **CSS pixels of the viewport**, which is the unit `Input.dispatchMouseEvent`
 * takes — while the JPEG's own dimensions are whatever `maxWidth`/`maxHeight`
 * constrained it to. Those two are routinely different, and conflating them is
 * the bug where clicks land near the right place at one window size and nowhere
 * near it at another. */
export type FrameMeta = {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
};

/** Turn a point in the widget into a point in the page.
 *
 * Three spaces, and the middle one is the one that gets forgotten: the pointer
 * arrives in *widget* pixels, the picture occupies a letterboxed rectangle of
 * those, and the page thinks in *CSS* pixels of its own viewport. So the
 * division is by the drawn rectangle's size and the multiplication is by the
 * device size — not by the image's pixel size, which is a third number again.
 *
 * Returns null for a point outside the picture. A click in the letterbox margin
 * is not a click in the page, and clamping it to the nearest edge would put a
 * real event somewhere the person did not aim.
 */
export function toPage(
  pt: { x: number; y: number },
  fit: Fit,
  meta: FrameMeta,
): { x: number; y: number } | null {
  if (fit.w <= 0 || fit.h <= 0) return null;
  const fx = pt.x - fit.x;
  const fy = pt.y - fit.y;
  if (fx < 0 || fy < 0 || fx > fit.w || fy > fit.h) return null;
  return {
    x: (fx / fit.w) * meta.deviceWidth,
    y: (fy / fit.h) * meta.deviceHeight,
  };
}

/* ── keys and buttons ──────────────────────────────────────────────────── */

/** CDP's modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
 *
 * Written out rather than imported from anywhere because it is four bits and a
 * dependency would be worse, but the order is genuinely arbitrary and worth
 * stating — it is not the order any DOM API uses, and guessing it produces a
 * Ctrl+click that arrives as an Alt+click. */
export function modifiersOf(e: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
  );
}

/** DOM `button` numbers to CDP's names. */
export function buttonOf(button: number): "left" | "middle" | "right" | "back" | "forward" {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "left";
  }
}

/** The keys whose CDP virtual key code cannot be derived from the DOM `key`.
 *
 * A printable character needs no entry — its code is the uppercased character
 * — and every other key needs one, because `Input.dispatchKeyEvent` without a
 * `windowsVirtualKeyCode` is a keystroke the renderer receives and does nothing
 * with. Backspace and the arrows are the ones a person notices immediately;
 * Tab and Enter are the ones that make a form usable at all. */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
};

export type KeyMsg = {
  type: "keyDown" | "keyUp" | "char";
  modifiers: number;
  key: string;
  code?: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
};

/** Translate a keyboard event into the one or two CDP messages it takes.
 *
 * Two, for a printable character, and this is the part that is easy to get
 * wrong: `keyDown` alone moves focus and fires handlers but **inserts nothing**
 * into an input, because text insertion is driven by the `char` event. So a
 * person typing into the page through the widget would watch their keystrokes
 * do nothing while `keydown` listeners fired perfectly. A non-printable key
 * gets one message and must not get a `char`, or Backspace inserts a character
 * as well as deleting one.
 *
 * Returns an empty list for a key with no text and no known code — a dead key,
 * or a modifier pressed on its own, which the renderer learns about from the
 * `modifiers` of the next real key anyway.
 */
export function keyMessages(
  e: {
    key: string;
    code?: string;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
  phase: "down" | "up",
): KeyMsg[] {
  const modifiers = modifiersOf(e);
  const printable = e.key.length === 1;
  const vk = VK[e.key] ?? (printable ? e.key.toUpperCase().charCodeAt(0) : undefined);
  if (vk === undefined) return [];

  const base: KeyMsg = {
    type: phase === "down" ? "keyDown" : "keyUp",
    modifiers,
    key: e.key,
    ...(e.code ? { code: e.code } : {}),
    windowsVirtualKeyCode: vk,
  };

  /* A modified key is a shortcut rather than typing — Ctrl+A selects, it does
     not insert "a" — so it carries no text either way. Meta is included for the
     same reason even though this is a Windows-first app: a person on a Mac
     keyboard pressing Cmd+A means the shortcut. */
  const typing = printable && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (!typing) return [base];

  if (phase === "up") return [base];
  return [
    { ...base, text: e.key, unmodifiedText: e.key },
    { type: "char", modifiers, key: e.key, text: e.key, unmodifiedText: e.key },
  ];
}

/* ── what the page says about itself ───────────────────────────────────── */

/** Chrome's console levels to the substrate's three tones.
 *
 * `logface.ts` holds three and that is deliberate — the palette is the
 * component's, so nothing pure has an opinion about `--st-fail`. Chrome offers
 * eight or so `type`s and most of them are `log`. `warning` warns, `error` and
 * `assert` fail, everything else is plain: a `table` or a `dir` is not a
 * judgement about anything. */
export function toneOfConsole(type: string): Tone {
  if (type === "error" || type === "assert") return "fail";
  if (type === "warning" || type === "warn") return "warn";
  return "plain";
}

/** Flatten one `Runtime.consoleAPICalled` into a printable line.
 *
 * CDP sends `RemoteObject`s, not strings, and the useful ones carry a `value`
 * for a primitive or a `description` for everything else. An object logged
 * without `Runtime.getProperties` being asked has neither, and `[object]` is a
 * more honest rendering than the empty string it would otherwise become — a
 * blank console line reads as the log being broken. */
export function consoleRow(ev: {
  type?: string;
  args?: { value?: unknown; description?: string; type?: string }[];
}): Row {
  const text = (ev.args ?? [])
    .map((a) => {
      if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
      if (a.description) return a.description;
      return a.type === "undefined" ? "undefined" : "[object]";
    })
    .join(" ");
  return { mark: ev.type === "log" ? "console" : (ev.type ?? "console"), tone: toneOfConsole(ev.type ?? ""), text };
}

/** One request's outcome as a line.
 *
 * Status first, because that is what is being scanned for. A failure gets the
 * `fail` tone from its status rather than from anything Chrome says about it:
 * `Network.responseReceived` is not an error event, it is where a 500 arrives
 * looking exactly like a 200. */
export function networkRow(ev: {
  response?: { status?: number; url?: string };
  type?: string;
}): Row {
  const status = ev.response?.status ?? 0;
  const url = ev.response?.url ?? "";
  const tone: Tone = status >= 500 ? "fail" : status >= 400 ? "warn" : "plain";
  return { mark: ev.type?.toLowerCase() ?? "net", tone, text: `${status || "---"} ${shortUrl(url)}` };
}

/** A request that never got a response.
 *
 * Its own fold rather than a `networkRow` with a zero status, because the
 * interesting thing is Chrome's reason — `net::ERR_CONNECTION_REFUSED` is the
 * whole answer when a dev server is not up, and it is the single most useful
 * line this log can carry. */
export function failedRow(ev: { errorText?: string; type?: string; canceled?: boolean }): Row {
  /* A cancelled request is usually the page navigating away and is noise, not a
     failure — but it is still worth a plain line, since a *pattern* of them is
     how a redirect loop looks. */
  return {
    mark: ev.type?.toLowerCase() ?? "net",
    tone: ev.canceled ? "plain" : "fail",
    text: ev.canceled ? "cancelled" : (ev.errorText ?? "failed"),
  };
}

/** Enough of a URL to recognise, from the end that identifies it.
 *
 * The origin is the same for every line in a log about one page, so keeping it
 * spends the width on the one part that does not vary. The path is what
 * distinguishes `/api/orders` from `/api/products`, and a long query string is
 * the part nobody reads in a scanning log.
 */
export function shortUrl(url: string, max = 72): string {
  let s = url;
  try {
    const u = new URL(url);
    s = u.pathname + (u.search ? "?" + u.search.slice(1, 24) : "");
    if (s === "/" || s === "") s = u.host;
  } catch {
    /* Not a URL — a data: or blob: with no host, which `new URL` accepts but
       which has no useful path either. Leave it and let the length cap do the
       work. */
  }
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max + 1);
}

/* ── the frame itself ──────────────────────────────────────────────────── */

/** A screencast frame as something an `<img>` can take.
 *
 * A data URL rather than a blob: the frames are small (6–95 kB), they arrive
 * already base64 because that is what CDP sends, and a blob would mean a
 * `URL.createObjectURL` per frame with a `revokeObjectURL` to match — which is
 * a leak with a frame counter on it the first time an early return skips the
 * revoke. Decoding to a data URL costs a string concatenation and cannot leak.
 */
export function frameUrl(data: string): string {
  return `data:image/jpeg;base64,${data}`;
}

/** How the widget describes what it is showing, in one line.
 *
 * The page's own title when it has one, its host when it does not, and the
 * honest thing when there is no page at all — a widget whose header is blank
 * reads as broken rather than as empty. */
export function caption(t: { title?: string; url?: string } | null): string {
  if (!t) return "no page";
  const title = (t.title ?? "").trim();
  if (title && title !== "about:blank") return title;
  const url = (t.url ?? "").trim();
  if (!url || url === "about:blank") return "blank page";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/* ── the knobs, read back safely ───────────────────────────────────────── */

export type Reading = "page" | "log";
export type Showing = "all" | "console" | "problems";

export type Config = {
  variant: Reading;
  /** The target id the knob names, or `FOLLOW` for whichever page there is. */
  target: string;
  showing: Showing;
  interactive: boolean;
};

/** Read a widget's config into something drawable, whatever is in it.
 *
 * The other half of the bargain `config_json` strikes — a normalizer runs on
 * every read so a renamed knob or a newer build's data costs no migration and
 * cannot put a nonsense value into a frame loop. `CLAUDE.md` states it for the
 * four opaque JSON columns; a widget's config is one of them.
 *
 * `target` is deliberately **not** clamped to a known list. A page id is
 * whatever Chrome minted and the pages are opened by the agent, so the valid
 * set is not knowable here — the same reason `normalizeParam` leaves a knob
 * with a `Source` alone, and the reason a widget pointed at a page that has
 * since closed falls back rather than being rewritten.
 */
export function normalizeConfig(c: WidgetConfig): Config {
  const variant = c["variant"];
  const showing = c["showing"];
  const target = c["target"];
  return {
    variant: variant === "log" ? "log" : "page",
    target: typeof target === "string" && target ? target : FOLLOW,
    showing: showing === "console" || showing === "problems" ? showing : "all",
    /* Defaults to on, matching the catalogue. A widget whose config predates
       the knob is one somebody hung up to work in, not to watch. */
    interactive: c["interactive"] !== false,
  };
}
