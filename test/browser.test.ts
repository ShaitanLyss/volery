import { describe, expect, test } from "bun:test";
import {
  buttonOf,
  caption,
  consoleRow,
  failedRow,
  fitFrame,
  frameUrl,
  keyMessages,
  modifiersOf,
  networkRow,
  normalizeConfig,
  cookieFor,
  storageStateFrom,
  savedWhat,
  EMPTY_STATE,
  shortUrl,
  toPage,
  toneOfConsole,
  type FrameMeta,
} from "../src/lib/browser";
import { FOLLOW } from "../src/lib/logface";

const meta = (w: number, h: number): FrameMeta => ({
  deviceWidth: w,
  deviceHeight: h,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
});

describe("fitting a frame into a widget", () => {
  test("a frame narrower than the box is centred horizontally", () => {
    const fit = fitFrame({ w: 100, h: 100 }, { w: 300, h: 100 });
    expect(fit.scale).toBe(1);
    expect(fit.w).toBe(100);
    expect(fit.x).toBe(100);
    expect(fit.y).toBe(0);
  });

  test("it contains rather than covers, so nothing is cropped", () => {
    /* 1280x800 into a 640x640 box: the limiting dimension is width, and the
       height must come out under the box rather than overflowing it. */
    const fit = fitFrame({ w: 1280, h: 800 }, { w: 640, h: 640 });
    expect(fit.scale).toBeCloseTo(0.5);
    expect(fit.w).toBe(640);
    expect(fit.h).toBe(400);
    expect(fit.h).toBeLessThanOrEqual(640);
  });

  test("it never scales up, because a blown-up page reads as a broken one", () => {
    const fit = fitFrame({ w: 200, h: 100 }, { w: 2000, h: 1000 });
    expect(fit.scale).toBe(1);
    expect(fit.w).toBe(200);
  });

  test("a degenerate box does not produce NaN", () => {
    for (const box of [
      { w: 0, h: 100 },
      { w: 100, h: 0 },
    ]) {
      const fit = fitFrame({ w: 100, h: 100 }, box);
      expect(Number.isFinite(fit.x)).toBe(true);
      expect(fit.w).toBe(0);
    }
    const none = fitFrame({ w: 0, h: 0 }, { w: 100, h: 100 });
    expect(none.w).toBe(0);
  });
});

describe("turning a click into a page coordinate", () => {
  /* The bug this exists to prevent: dividing by the image's pixel size rather
     than by the rectangle it was drawn into. Here they are deliberately
     different numbers — a 1280x800 viewport screencast down to a 640x400
     picture, drawn into a 640x400 box. */
  test("the centre of the picture is the centre of the page", () => {
    const fit = fitFrame({ w: 640, h: 400 }, { w: 640, h: 400 });
    const pt = toPage({ x: 320, y: 200 }, fit, meta(1280, 800));
    expect(pt).not.toBeNull();
    expect(pt!.x).toBeCloseTo(640);
    expect(pt!.y).toBeCloseTo(400);
  });

  test("the letterbox offset is taken off before scaling", () => {
    /* A 100x100 frame in a 300x100 box sits at x=100. The picture's own
       top-left is therefore widget (100, 0), and must map to page (0, 0). */
    const fit = fitFrame({ w: 100, h: 100 }, { w: 300, h: 100 });
    const pt = toPage({ x: 100, y: 0 }, fit, meta(800, 600));
    expect(pt!.x).toBeCloseTo(0);
    expect(pt!.y).toBeCloseTo(0);
  });

  test("a click in the letterbox margin is not a click in the page", () => {
    const fit = fitFrame({ w: 100, h: 100 }, { w: 300, h: 100 });
    expect(toPage({ x: 20, y: 50 }, fit, meta(800, 600))).toBeNull();
    expect(toPage({ x: 280, y: 50 }, fit, meta(800, 600))).toBeNull();
  });

  test("the device size is what scales, not the image size", () => {
    /* Same drawn rectangle, two different viewports. If the mapping used the
       image size these would agree, and clicks would land in the wrong place on
       any page whose viewport is not its screencast size. */
    const fit = fitFrame({ w: 640, h: 400 }, { w: 640, h: 400 });
    const small = toPage({ x: 640, y: 400 }, fit, meta(640, 400));
    const large = toPage({ x: 640, y: 400 }, fit, meta(1920, 1200));
    expect(small!.x).toBeCloseTo(640);
    expect(large!.x).toBeCloseTo(1920);
  });
});

describe("modifiers and buttons", () => {
  test("the bitmask is alt 1, ctrl 2, meta 4, shift 8", () => {
    expect(modifiersOf({})).toBe(0);
    expect(modifiersOf({ altKey: true })).toBe(1);
    expect(modifiersOf({ ctrlKey: true })).toBe(2);
    expect(modifiersOf({ metaKey: true })).toBe(4);
    expect(modifiersOf({ shiftKey: true })).toBe(8);
    expect(modifiersOf({ ctrlKey: true, shiftKey: true })).toBe(10);
  });

  test("DOM button numbers become CDP names", () => {
    expect(buttonOf(0)).toBe("left");
    expect(buttonOf(1)).toBe("middle");
    expect(buttonOf(2)).toBe("right");
    /* Anything unrecognised is a left click rather than nothing: a pointer
       device reporting button 7 still means the person pressed something. */
    expect(buttonOf(9)).toBe("left");
  });
});

describe("keys", () => {
  /* The one that matters most: keyDown alone fires listeners but inserts
     nothing, because insertion is driven by the char event. */
  test("a printable key sends keyDown AND char, or nothing is typed", () => {
    const msgs = keyMessages({ key: "a", code: "KeyA" }, "down");
    expect(msgs.map((m) => m.type)).toEqual(["keyDown", "char"]);
    expect(msgs[0].text).toBe("a");
    expect(msgs[1].text).toBe("a");
  });

  test("a non-printable key sends no char, or Backspace types as well as deletes", () => {
    const msgs = keyMessages({ key: "Backspace" }, "down");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("keyDown");
    expect(msgs[0].windowsVirtualKeyCode).toBe(8);
    expect(msgs[0].text).toBeUndefined();
  });

  test("the arrows and Enter carry their virtual key codes", () => {
    expect(keyMessages({ key: "ArrowDown" }, "down")[0].windowsVirtualKeyCode).toBe(40);
    expect(keyMessages({ key: "Enter" }, "down")[0].windowsVirtualKeyCode).toBe(13);
    expect(keyMessages({ key: "Tab" }, "down")[0].windowsVirtualKeyCode).toBe(9);
  });

  test("a modified key is a shortcut and carries no text", () => {
    const msgs = keyMessages({ key: "a", ctrlKey: true }, "down");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBeUndefined();
    expect(msgs[0].modifiers).toBe(2);
  });

  test("keyUp never sends a char", () => {
    const msgs = keyMessages({ key: "a" }, "up");
    expect(msgs.map((m) => m.type)).toEqual(["keyUp"]);
  });

  test("a key with no code and no text produces nothing to send", () => {
    expect(keyMessages({ key: "Shift" }, "down")).toEqual([]);
    expect(keyMessages({ key: "Dead" }, "down")).toEqual([]);
  });

  test("space is printable and has a code, so it both types and scrolls", () => {
    const msgs = keyMessages({ key: " " }, "down");
    expect(msgs.map((m) => m.type)).toEqual(["keyDown", "char"]);
    expect(msgs[0].windowsVirtualKeyCode).toBe(32);
  });
});

describe("what the page says about itself", () => {
  test("console levels fold to the substrate's three tones", () => {
    expect(toneOfConsole("error")).toBe("fail");
    expect(toneOfConsole("assert")).toBe("fail");
    expect(toneOfConsole("warning")).toBe("warn");
    expect(toneOfConsole("log")).toBe("plain");
    expect(toneOfConsole("table")).toBe("plain");
  });

  test("primitive arguments are printed, objects are described", () => {
    const row = consoleRow({
      type: "log",
      args: [{ value: "count" }, { value: 3 }, { description: "Array(2)" }],
    });
    expect(row.text).toBe("count 3 Array(2)");
    expect(row.mark).toBe("console");
    expect(row.tone).toBe("plain");
  });

  test("an argument with neither value nor description is not a blank line", () => {
    /* A blank console row reads as the log being broken rather than as an
       object nobody asked to expand. */
    const row = consoleRow({ type: "log", args: [{}] });
    expect(row.text).toBe("[object]");
  });

  test("an error keeps its own level as the gutter mark", () => {
    expect(consoleRow({ type: "error", args: [{ value: "boom" }] })).toEqual({
      mark: "error",
      tone: "fail",
      text: "boom",
    });
  });

  test("a 500 fails and a 404 warns, though neither is an error event", () => {
    expect(networkRow({ response: { status: 500, url: "http://x/api/a" } }).tone).toBe("fail");
    expect(networkRow({ response: { status: 404, url: "http://x/api/a" } }).tone).toBe("warn");
    expect(networkRow({ response: { status: 200, url: "http://x/api/a" } }).tone).toBe("plain");
  });

  test("a refused connection keeps Chrome's reason, which is the whole answer", () => {
    const row = failedRow({ errorText: "net::ERR_CONNECTION_REFUSED", type: "Document" });
    expect(row.tone).toBe("fail");
    expect(row.text).toBe("net::ERR_CONNECTION_REFUSED");
    expect(row.mark).toBe("document");
  });

  test("a cancelled request is noise, not a failure", () => {
    expect(failedRow({ canceled: true }).tone).toBe("plain");
  });
});

describe("shortening a url", () => {
  test("the origin goes, since it is the same on every line", () => {
    expect(shortUrl("http://localhost:3000/api/orders")).toBe("/api/orders");
  });

  test("a bare origin keeps its host rather than becoming a slash", () => {
    expect(shortUrl("http://localhost:3000/")).toBe("localhost:3000");
  });

  test("a long path is cut from the front, keeping the identifying end", () => {
    const s = shortUrl("http://x/" + "a".repeat(200), 20);
    expect(s.length).toBe(20);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("a")).toBe(true);
  });

  test("something that is not a url survives", () => {
    expect(shortUrl("data:text/html,hello")).toContain("hello");
  });
});

describe("the frame and the caption", () => {
  test("a frame becomes a data url an img can take", () => {
    expect(frameUrl("QUJD")).toBe("data:image/jpeg;base64,QUJD");
  });

  test("a titled page is named by its title", () => {
    expect(caption({ title: "[Local] NOVA", url: "http://localhost:3000/" })).toBe("[Local] NOVA");
  });

  test("an untitled page falls back to its host, never to blank", () => {
    expect(caption({ title: "", url: "http://localhost:3000/x" })).toBe("localhost:3000");
    expect(caption({ title: "about:blank", url: "about:blank" })).toBe("blank page");
    expect(caption(null)).toBe("no page");
  });
});

describe("reading the knobs back", () => {
  test("an empty config is a drivable page", () => {
    const c = normalizeConfig({});
    expect(c.variant).toBe("page");
    expect(c.showing).toBe("all");
    expect(c.interactive).toBe(true);
    expect(c.target).toBe(FOLLOW);
  });

  /* A widget hung up before the knob existed is one somebody hung up to work
     in, so the absence of the key must not read as "read only". */
  test("a config predating the interactive knob is still interactive", () => {
    expect(normalizeConfig({ variant: "page" }).interactive).toBe(true);
    expect(normalizeConfig({ interactive: false }).interactive).toBe(false);
  });

  test("a retired variant degrades to something drawable", () => {
    expect(normalizeConfig({ variant: "filmstrip" }).variant).toBe("page");
    expect(normalizeConfig({ showing: "everything" }).showing).toBe("all");
  });

  /* The one knob deliberately NOT clamped: a page id is whatever Chrome
     minted, the pages are opened by the agent, and the valid set is not
     knowable here. Clamping it to the literal options would rewrite a widget's
     subject on every launch, which is the trap `normalizeParam` exempts every
     sourced knob from. */
  test("an unknown target is kept rather than clamped away", () => {
    expect(normalizeConfig({ target: "AB12CD34" }).target).toBe("AB12CD34");
  });

  /* Anything that is not a usable id falls back to following, never to a blank
     — a blank would match no page and the face would draw nothing, where
     following always has one honest answer. */
  test("a target that is not a string falls back to following", () => {
    expect(normalizeConfig({ target: 7 }).target).toBe(FOLLOW);
    expect(normalizeConfig({ target: "" }).target).toBe(FOLLOW);
    expect(normalizeConfig({}).target).toBe(FOLLOW);
  });
});

describe("the session vault", () => {
  const NOW = 1_800_000_000;

  test("a cookie CDP never gave a sameSite is Lax, not dropped", () => {
    /* Playwright REQUIRES sameSite and rejects the whole file without it, so a
       missing value must not become undefined — it would cost every other
       cookie in the vault, not just this one. Lax is what Chrome itself treats
       absence as. */
    const c = cookieFor({ name: "s", value: "v", domain: "x.com" });
    expect(c).not.toBeNull();
    expect(c!.sameSite).toBe("Lax");
    expect(c!.path).toBe("/");
  });

  test("Strict and None survive; anything unrecognised becomes Lax", () => {
    expect(cookieFor({ name: "a", domain: "x", sameSite: "Strict" })!.sameSite).toBe("Strict");
    expect(cookieFor({ name: "a", domain: "x", sameSite: "None" })!.sameSite).toBe("None");
    expect(cookieFor({ name: "a", domain: "x", sameSite: "Unspecified" })!.sameSite).toBe("Lax");
  });

  test("a session cookie stays -1, both ways CDP spells it", () => {
    expect(cookieFor({ name: "a", domain: "x", expires: -1 })!.expires).toBe(-1);
    expect(cookieFor({ name: "a", domain: "x", session: true, expires: 999 })!.expires).toBe(-1);
  });

  test("a fractional expiry is floored rather than carried into every browser", () => {
    expect(cookieFor({ name: "a", domain: "x", expires: 1800000000.7331 })!.expires).toBe(
      1_800_000_000,
    );
  });

  /* Seeding a dead cookie is worse than seeding nothing: the browser takes it,
     the app reads it, and the failure looks like the app. */
  test("an expired cookie is dropped", () => {
    expect(cookieFor({ name: "a", domain: "x", expires: NOW - 10 }, NOW)).toBeNull();
    expect(cookieFor({ name: "a", domain: "x", expires: NOW + 10 }, NOW)).not.toBeNull();
    /* And a session cookie is never "expired", whatever the clock says. */
    expect(cookieFor({ name: "a", domain: "x", expires: -1 }, NOW)).not.toBeNull();
  });

  test("a cookie with no name or no domain cannot be restored, so it is dropped", () => {
    expect(cookieFor({ value: "v", domain: "x" })).toBeNull();
    expect(cookieFor({ name: "a", value: "v" })).toBeNull();
  });

  test("two tabs on one origin merge, and the later entry wins", () => {
    /* The direction matters: a stale tab's older token must not overwrite the
       fresh one from the tab you just signed in on. */
    const s = storageStateFrom(
      [],
      [
        { origin: "https://nova", entries: [["tok", "old"], ["keep", "1"]] },
        { origin: "https://nova", entries: [["tok", "new"]] },
      ],
    );
    expect(s.origins).toHaveLength(1);
    const items = Object.fromEntries(s.origins[0].localStorage.map((i) => [i.name, i.value]));
    expect(items).toEqual({ tok: "new", keep: "1" });
  });

  test("an origin with nothing in it is left out", () => {
    const s = storageStateFrom([], [{ origin: "https://a", entries: [] }]);
    expect(s.origins).toEqual([]);
  });

  test("a page with no real origin is left out", () => {
    const s = storageStateFrom([], [
      { origin: "null", entries: [["a", "1"]] },
      { origin: "", entries: [["a", "1"]] },
    ]);
    expect(s.origins).toEqual([]);
  });

  test("the empty vault is valid, because a missing file will not start a browser", () => {
    expect(EMPTY_STATE).toEqual({ cookies: [], origins: [] });
  });

  test("what was saved is said with numbers, or the empty case is named", () => {
    expect(savedWhat(EMPTY_STATE)).toContain("nothing to save");
    expect(savedWhat({ cookies: [cookieFor({ name: "a", domain: "x" })!], origins: [] })).toBe(
      "saved 1 cookie",
    );
    const two = storageStateFrom(
      [
        { name: "a", domain: "x" },
        { name: "b", domain: "y" },
      ],
      [{ origin: "https://a", entries: [["k", "v"]] }],
    );
    expect(savedWhat(two)).toBe("saved 2 cookies and 1 origin's stored items");
  });
});
