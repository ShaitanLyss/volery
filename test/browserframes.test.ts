import { describe, expect, test } from "bun:test";
// @ts-expect-error a plain CommonJS module the browser host loads; no types
import frames from "../src-tauri/src/browserframes.cjs";

type Reading = { sharing: number; minimized: boolean } | null;
const F = frames as {
  MEASURING: Set<string>;
  reading(mine: unknown, others: unknown[]): Reading;
  key(r: Reading): string;
  due(r: Reading, said: string | undefined, tool: string): boolean;
  note(r: Reading): string;
};

const win = (windowId: number, windowState = "normal") => ({ windowId, bounds: { windowState } });

describe("reading a page's window", () => {
  test("a page alone in its window shares it with nobody", () => {
    expect(F.reading(win(1), [win(2), win(3)])).toEqual({ sharing: 0, minimized: false });
  });

  test("other pages in the same window are counted, whoever's they are", () => {
    expect(F.reading(win(7), [win(7), win(2), win(7)])).toEqual({ sharing: 2, minimized: false });
  });

  test("a minimised window is read as such", () => {
    expect(F.reading(win(4, "minimized"), [])).toEqual({ sharing: 0, minimized: true });
  });

  test("a window Chrome would not name is no reading, and a failed look at another page is skipped", () => {
    expect(F.reading(null, [])).toBeNull();
    expect(F.reading({}, [])).toBeNull();
    expect(F.reading(win(1), [null, win(1)])).toEqual({ sharing: 1, minimized: false });
  });
});

describe("when the note is said", () => {
  const alone = { sharing: 0, minimized: false };
  const behind = { sharing: 1, minimized: false };

  test("never for a page drawing real frames", () => {
    expect(F.due(alone, undefined, "browser_evaluate")).toBe(false);
    expect(F.due(null, undefined, "browser_evaluate")).toBe(false);
  });

  test("once on ordinary calls, while the reading stays the same", () => {
    expect(F.due(behind, undefined, "browser_click")).toBe(true);
    expect(F.due(behind, F.key(behind), "browser_click")).toBe(false);
    expect(F.due({ sharing: 2, minimized: false }, F.key(behind), "browser_click")).toBe(true);
  });

  test("on every call a frame rate is measured in", () => {
    for (const tool of ["browser_evaluate", "browser_run_code_unsafe"]) {
      expect(F.MEASURING.has(tool)).toBe(true);
      expect(F.due(behind, F.key(behind), tool)).toBe(true);
    }
  });

  test("again once the condition has cleared and come back", () => {
    expect(F.due(behind, F.key(alone), "browser_click")).toBe(true);
  });
});

describe("what the card is told", () => {
  test("a page behind another tab: why, the measured numbers, and how to make it real", () => {
    const n = F.note({ sharing: 1, minimized: false });
    expect(n.startsWith("### Frames\n")).toBe(true);
    expect(n).toContain("one other tab");
    expect(n).toContain("0.998 fps");
    expect(n).toContain("visible");
    expect(n).toContain("close");
    expect(n).toContain("context.newPage()");
    expect(F.note({ sharing: 3, minimized: false })).toContain("3 other tabs");
  });

  test("a minimised window says so first, since nothing at all is drawn", () => {
    const n = F.note({ sharing: 2, minimized: true });
    expect(n).toContain("minimised");
    expect(n).not.toContain("other tabs");
  });

  test("nothing to say is the empty string", () => {
    expect(F.note({ sharing: 0, minimized: false })).toBe("");
    expect(F.note(null)).toBe("");
  });
});
