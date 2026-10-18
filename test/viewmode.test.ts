import { describe, expect, test } from "bun:test";

import { DEFAULT_STATE, opening, readState } from "../src/lib/viewmode";

const base = { stored: null, loaded: true, conversations: 0, projects: 0, driven: false };

describe("which view the window opens on", () => {
  test("a stored choice wins, even before the store has loaded", () => {
    expect(opening({ ...base, loaded: false, stored: { ...DEFAULT_STATE, view: "chat" } })).toBe("chat");
    expect(opening({ ...base, conversations: 9, stored: { ...DEFAULT_STATE, view: "wall" } })).toBe("wall");
  });

  test("nothing is decided until the store has loaded — never-held and not-read-yet look the same", () => {
    expect(opening({ ...base, loaded: false })).toBeNull();
  });

  test("a fresh install asks", () => {
    expect(opening(base)).toBe("welcome");
  });

  test("an install that has held a conversation, or has a project, opens on the wall", () => {
    expect(opening({ ...base, conversations: 1 })).toBe("wall");
    expect(opening({ ...base, projects: 1 })).toBe("wall");
  });

  test("a driven window never asks unless a test asked it to", () => {
    expect(opening({ ...base, driven: true })).toBe("wall");
    expect(opening({ ...base, driven: true, askWelcome: true })).toBe("welcome");
  });
});

describe("what was stored", () => {
  test("round-trips", () => {
    const s = { view: "chat", density: "open", sidebar: false, pane: true } as const;
    expect(readState(JSON.stringify(s))).toEqual(s);
  });

  test("nothing, garbage, or no view is no choice", () => {
    expect(readState(null)).toBeNull();
    expect(readState("{")).toBeNull();
    expect(readState("[]")).toBeNull();
    expect(readState(JSON.stringify({ view: "both" }))).toBeNull();
  });

  test("a field that does not parse falls back without throwing the choice away", () => {
    expect(readState(JSON.stringify({ view: "chat", density: 3, sidebar: "yes", extra: 1 }))).toEqual({
      ...DEFAULT_STATE,
      view: "chat",
    });
  });
});
