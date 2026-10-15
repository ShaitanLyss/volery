import { describe, expect, test } from "bun:test";
import { GLANCE_GAP, hasSaid, lastMessage, placeGlance } from "../src/lib/glance";

const t = (text: string) => ({ kind: "text", text });
const tool = (text = "Read foo.ts") => ({ kind: "tool", text });
const you = (text: string) => ({ kind: "you", text });

describe("what a glance reads", () => {
  test("nothing said is nothing to read, whatever the closing field holds", () => {
    expect(hasSaid({ lines: [] })).toBe(false);
    expect(hasSaid({ lines: [you("hi"), tool()] })).toBe(false);
    /* A cleared card keeps `lastWords` and has no lines: the glance must not
       show a conversation `/clear` ended. */
    expect(lastMessage({ lines: [], lastWords: "old", working: false })).toBe("");
  });

  test("at rest it is the notice's own text, exactly", () => {
    const lines = [you("go"), t("looking"), tool(), t("done — two files")];
    expect(lastMessage({ lines, lastWords: "  done — two files\n\nand a note  ", working: false })).toBe(
      "done — two files\n\nand a note",
    );
  });

  test("while working the closing field is the last turn's, so the lines win", () => {
    const lines = [t("old answer"), you("next"), t("starting on it"), tool()];
    expect(lastMessage({ lines, lastWords: "old answer", working: true })).toBe("starting on it");
  });

  test("the last run of prose, back to the tool call before it", () => {
    /* A question parked mid-turn: the prose just before the ask is the thing
       it is about, and what came before the previous tool call is not. */
    const lines = [t("first"), tool(), t("found two ways"), t("which do you want?"), tool("ask_user")];
    expect(lastMessage({ lines, working: true })).toBe("found two ways\n\nwhich do you want?");
  });

  test("a card restored off disk has lines and no closing field", () => {
    expect(lastMessage({ lines: [you("q"), t("a")], working: false })).toBe("a");
    expect(lastMessage({ lines: [you("q"), t("a")], lastWords: "", working: false })).toBe("a");
  });

  test("a card on another wall reads its one digest line", () => {
    expect(lastMessage({ lines: [t("the gist…")], working: false })).toBe("the gist…");
  });
});

describe("where a glance stands", () => {
  const view = { width: 1000, height: 800 };
  const size = { width: 400, height: 200 };

  test("below its anchor where that fits, left-aligned with it", () => {
    expect(placeGlance({ left: 100, top: 100, width: 208, height: 90 }, size, view)).toEqual({
      left: 100,
      top: 190 + GLANCE_GAP,
    });
  });

  test("above where below does not fit — the dock at the foot of the window", () => {
    const dock = { left: 300, top: 560, width: 600, height: 220 };
    expect(placeGlance(dock, size, view)).toEqual({ left: 300, top: 560 - GLANCE_GAP - 200 });
  });

  test("clamped into the window, never half off it", () => {
    const p = placeGlance({ left: 900, top: 100, width: 208, height: 90 }, size, view);
    expect(p.left).toBe(1000 - 400 - GLANCE_GAP);
  });

  test("an anchor off screen gets the middle of the window", () => {
    expect(placeGlance({ left: -900, top: 100, width: 208, height: 90 }, size, view)).toEqual({
      left: 300,
      top: 300,
    });
    expect(placeGlance(null, size, view)).toEqual({ left: 300, top: 300 });
  });

  test("neither side fits: the roomier one, clamped", () => {
    const tall = { width: 400, height: 500 };
    const p = placeGlance({ left: 0, top: 200, width: 100, height: 100 }, tall, view);
    expect(p.top).toBe(800 - 500 - GLANCE_GAP);
  });
});

describe("a card restored off disk", () => {
  test("has its scrollback in history and nothing in lines until it speaks", () => {
    const history = [you("q"), t("the answer"), tool()];
    expect(hasSaid({ lines: [], history })).toBe(true);
    expect(lastMessage({ lines: [], history, working: false })).toBe("the answer");
  });

  test("once it speaks again, the lines are the newer word", () => {
    expect(lastMessage({ lines: [t("new")], history: [t("old")], working: false })).toBe("new");
    expect(lastMessage({ lines: [you("next")], history: [t("old")], working: true })).toBe("old");
  });
});
