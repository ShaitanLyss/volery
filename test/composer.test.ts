import { describe, expect, test } from "bun:test";

import { keyFor, type Mode } from "../src/lib/composer";

const prose: Mode = { banging: false, offer: false, history: true, palette: false, pick: false };
const palette: Mode = { ...prose, palette: true, pick: true };
const bang: Mode = { ...prose, banging: true };
const offered: Mode = { ...bang, offer: true };

const act = (s: ReturnType<typeof keyFor>) => (s ? { ...s } : null);

describe("the wall's field — today's keys", () => {
  test("enter sends to one; ctrl+enter widens to the gathering; shift+enter is a new line", () => {
    expect(act(keyFor("wall", { key: "Enter" }, prose))).toMatchObject({ act: "send", widen: false, prevent: true });
    expect(act(keyFor("wall", { key: "Enter", ctrl: true }, prose))).toMatchObject({ act: "send", widen: true });
    expect(keyFor("wall", { key: "Enter", shift: true }, prose)).toBeNull();
  });

  test("tab walks the cards, shift+tab back, ctrl widens to the whole wall", () => {
    expect(keyFor("wall", { key: "Tab" }, prose)).toMatchObject({ act: "cycle", by: 1, wide: false, prevent: true });
    expect(keyFor("wall", { key: "Tab", shift: true }, prose)).toMatchObject({ act: "cycle", by: -1 });
    expect(keyFor("wall", { key: "Tab", ctrl: true }, prose)).toMatchObject({ act: "cycle", wide: true });
  });

  test("escape is the window's on the wall — it gives the wall the keyboard back", () => {
    expect(keyFor("wall", { key: "Escape" }, prose)).toBeNull();
  });

  test("typing is the field's", () => {
    for (const key of ["a", " ", "Backspace", "ArrowLeft", "Home"]) expect(keyFor("wall", { key }, prose)).toBeNull();
  });
});

describe("the palette", () => {
  test("bare arrows step it; ctrl+arrow is the reading's", () => {
    expect(keyFor("wall", { key: "ArrowDown" }, palette)).toMatchObject({ act: "palette-move", by: 1 });
    expect(keyFor("wall", { key: "ArrowUp" }, palette)).toMatchObject({ act: "palette-move", by: -1 });
    expect(keyFor("wall", { key: "ArrowDown", ctrl: true }, palette)).toBeNull();
  });

  test("escape dismisses and stops there — it no longer also blurs the field (the fix)", () => {
    expect(keyFor("wall", { key: "Escape" }, palette)).toMatchObject({ act: "palette-off", prevent: true, stop: true });
  });

  test("tab completes a lit row; with nothing lit it is the view's", () => {
    expect(keyFor("wall", { key: "Tab" }, palette)).toMatchObject({ act: "palette-complete" });
    expect(keyFor("wall", { key: "Tab" }, { ...palette, pick: false })).toMatchObject({ act: "cycle" });
  });

  test("enter is the send, which runs what is lit", () => {
    expect(keyFor("wall", { key: "Enter" }, palette)).toMatchObject({ act: "send" });
  });
});

describe("a ! line", () => {
  test("enter runs it; ctrl+enter runs it and tells the agent", () => {
    expect(keyFor("wall", { key: "Enter" }, bang)).toMatchObject({ act: "bang-run", tell: false });
    expect(keyFor("wall", { key: "Enter", ctrl: true }, bang)).toMatchObject({ act: "bang-run", tell: true });
  });

  test("tab asks the shell; up and down walk the card's history when there is a card", () => {
    expect(keyFor("wall", { key: "Tab" }, bang)).toMatchObject({ act: "bang-complete", prevent: true });
    expect(keyFor("wall", { key: "ArrowUp" }, bang)).toMatchObject({ act: "bang-history", by: -1, prevent: false });
    expect(keyFor("wall", { key: "ArrowUp" }, { ...bang, history: false })).toBeNull();
  });

  test("escape leaves the line, keeping the text, and stops there", () => {
    expect(keyFor("wall", { key: "Escape" }, bang)).toMatchObject({ act: "bang-leave", stop: true });
  });

  test("with an offering up, its keys come first: enter and tab complete rather than run", () => {
    expect(keyFor("wall", { key: "Enter" }, offered)).toMatchObject({ act: "offer-take" });
    expect(keyFor("wall", { key: "Tab" }, offered)).toMatchObject({ act: "offer-take" });
    expect(keyFor("wall", { key: "ArrowDown" }, offered)).toMatchObject({ act: "offer-move", by: 1 });
    expect(keyFor("wall", { key: "Escape" }, offered)).toMatchObject({ act: "offer-close", stop: true });
  });

  test("typing over an offering drops it and goes on into the field", () => {
    expect(keyFor("wall", { key: "x" }, offered)).toMatchObject({ act: "offer-drop", prevent: false });
    expect(keyFor("wall", { key: "Backspace" }, offered)).toMatchObject({ act: "offer-drop", prevent: false });
  });
});

describe("chat view's field", () => {
  test("tab and shift+tab are focus traversal, not the wall's walk", () => {
    expect(keyFor("chat", { key: "Tab" }, prose)).toBeNull();
    expect(keyFor("chat", { key: "Tab", shift: true }, prose)).toBeNull();
  });

  test("ctrl+enter is enter — one conversation, and a broadcast is never a key away", () => {
    expect(keyFor("chat", { key: "Enter", ctrl: true }, prose)).toMatchObject({ act: "send", widen: false });
    expect(keyFor("chat", { key: "Enter" }, prose)).toMatchObject({ act: "send", widen: false });
  });

  test("alt+p is plan first", () => {
    expect(keyFor("chat", { key: "p", alt: true }, prose)).toMatchObject({ act: "plan", prevent: true });
    expect(keyFor("wall", { key: "p", alt: true }, prose)).toBeNull();
  });

  test("escape stops a turn and goes no further: it never deselects or blurs", () => {
    expect(keyFor("chat", { key: "Escape" }, prose)).toMatchObject({ act: "escape", prevent: true, stop: true });
  });

  test("the palette and the ! line keep their keys", () => {
    expect(keyFor("chat", { key: "Escape" }, palette)).toMatchObject({ act: "palette-off" });
    expect(keyFor("chat", { key: "Tab" }, palette)).toMatchObject({ act: "palette-complete" });
    expect(keyFor("chat", { key: "Enter", ctrl: true }, bang)).toMatchObject({ act: "bang-run", tell: true });
  });
});
