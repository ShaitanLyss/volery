import { describe, expect, test } from "bun:test";

import {
  type Attr,
  type Cell,
  type Screen,
  applyRedraw,
  attrCss,
  cellAt,
  cursorBox,
  emptyScreen,
  gridSize,
  hex,
  mouseMods,
  nvimKey,
  rowRuns,
  screenText,
  wheelDir,
} from "../src/lib/nvim";

/** The screen as text, one string per row, for asserting against something
 *  readable rather than against four thousand cells. The app's own — the wall
 *  test reads a grid through exactly this, so a bug in it would be a bug in
 *  both and invisible here. */
const painted = (s: Screen): string[] => screenText(s);

/** A `grid_line` event, in the shape nvim actually sends. */
const gridLine = (row: number, col: number, cells: unknown[]) => ["grid_line", [1, row, col, cells]];

/** A word as the cells nvim would really send for it — **one per cell**. A
 *  cell's text is a single grapheme (which may be several codepoints, for an
 *  emoji built out of joiners), never a run of characters; the only thing that
 *  compresses a line on the wire is the repeat count. */
const word = (text: string, hl = 0): unknown[] => Array.from(text, (ch) => [ch, hl]);

const key = (k: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey" | "shiftKey", boolean>> = {}) =>
  nvimKey({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("folding a redraw", () => {
  test("a line lands where it was addressed", () => {
    const s = emptyScreen(10, 3);
    applyRedraw(s, [gridLine(1, 2, [["h", 0], ["i", 0]])]);
    expect(painted(s)).toEqual(["", "  hi", ""]);
  });

  test("a cell with no attribute carries the one before it", () => {
    /* nvim only sends `hl` when it changes. Defaulting a missing one to 0
       paints every run after the first in the default colours, which reads as
       a colourscheme that gave up halfway along the line. */
    const s = emptyScreen(6, 1);
    applyRedraw(s, [gridLine(0, 0, [["a", 7], ["b"], ["c", 0], ["d"]])]);
    expect(s.cells[0].slice(0, 4).map((c) => c.hl)).toEqual([7, 7, 0, 0]);
  });

  test("a repeat count is a run of identical cells", () => {
    const s = emptyScreen(8, 1);
    applyRedraw(s, [gridLine(0, 0, [["-", 3, 5]])]);
    expect(painted(s)).toEqual(["-----"]);
    expect(s.cells[0][4].hl).toBe(3);
  });

  test("a run past the end of the row is clipped rather than growing it", () => {
    const s = emptyScreen(4, 1);
    applyRedraw(s, [gridLine(0, 0, [["x", 0, 99]])]);
    expect(s.cells[0]).toHaveLength(4);
  });

  test("a line addressed to a row that does not exist is ignored", () => {
    const s = emptyScreen(4, 2);
    expect(() => applyRedraw(s, [gridLine(9, 0, [["x", 0]])])).not.toThrow();
    expect(painted(s)).toEqual(["", ""]);
  });

  test("clear empties every row", () => {
    const s = emptyScreen(4, 2);
    applyRedraw(s, [gridLine(0, 0, word("ab")), ["grid_clear", [1]]]);
    expect(painted(s)).toEqual(["", ""]);
  });

  test("a resize keeps what still fits", () => {
    /* nvim sends `grid_resize` before it repaints, so blanking here flashes
       the panel empty every time it changes shape. */
    const s = emptyScreen(6, 2);
    applyRedraw(s, [gridLine(0, 0, word("hello"))]);
    applyRedraw(s, [["grid_resize", [1, 4, 3]]]);
    expect(s.cols).toBe(4);
    expect(s.rows).toBe(3);
    expect(painted(s)).toEqual(["hell", "", ""]);
  });

  test("a resize that shrinks past the cursor brings it back inside", () => {
    const s = emptyScreen(20, 20);
    applyRedraw(s, [["grid_cursor_goto", [1, 18, 18]]]);
    applyRedraw(s, [["grid_resize", [1, 5, 5]]]);
    expect(s.cursor).toEqual({ row: 4, col: 4 });
  });
});

describe("scrolling", () => {
  const lines = (texts: string[]) => {
    const s = emptyScreen(4, texts.length);
    texts.forEach((t, r) => applyRedraw(s, [gridLine(r, 0, word(t))]));
    return s;
  };

  test("content moves up", () => {
    const s = lines(["a", "b", "c", "d"]);
    applyRedraw(s, [["grid_scroll", [1, 0, 4, 0, 4, 1, 0]]]);
    /* The vacated line is left alone — nvim paints it immediately after. */
    expect(painted(s).slice(0, 3)).toEqual(["b", "c", "d"]);
  });

  test("content moves down without smearing", () => {
    /* The direction is the trap: a downward scroll copies a region over
       itself, so it has to run bottom-to-top or the first line copied is
       repeated all the way down. */
    const s = lines(["a", "b", "c", "d"]);
    applyRedraw(s, [["grid_scroll", [1, 0, 4, 0, 4, -1, 0]]]);
    expect(painted(s).slice(1)).toEqual(["a", "b", "c"]);
  });

  test("only the addressed columns move", () => {
    const s = emptyScreen(4, 2);
    applyRedraw(s, [gridLine(1, 0, word("abcd"))]);
    applyRedraw(s, [["grid_scroll", [1, 0, 2, 0, 2, 1, 0]]]);
    /* Columns 2 and 3 of row 0 were never in the region. */
    expect(s.cells[0].map((c) => c.text)).toEqual(["a", "b", " ", " "]);
  });

  test("scrolling by nothing is not a copy", () => {
    const s = lines(["a", "b"]);
    applyRedraw(s, [["grid_scroll", [1, 0, 2, 0, 4, 0, 0]]]);
    expect(painted(s)).toEqual(["a", "b"]);
  });
});

describe("the rest of the protocol", () => {
  test("flush is what says the screen is consistent again", () => {
    const s = emptyScreen();
    expect(s.seq).toBe(0);
    applyRedraw(s, [gridLine(0, 0, [["x", 0]]), ["flush", []]]);
    expect(s.seq).toBe(1);
  });

  test("an attribute definition is remembered by its id", () => {
    const s = emptyScreen();
    applyRedraw(s, [["hl_attr_define", [4, { foreground: 0x98c379, bold: true }, {}, []]]]);
    expect(s.attrs.get(4)).toEqual({ foreground: 0x98c379, bold: true });
  });

  test("minus one is nvim saying no colour, not black", () => {
    const s = emptyScreen();
    const was = s.colors.bg;
    applyRedraw(s, [["default_colors_set", [0xc9d1d9, -1, -1, 0, 0]]]);
    expect(s.colors.fg).toBe(0xc9d1d9);
    expect(s.colors.bg).toBe(was);
  });

  test("the mode is taken from the config's own table", () => {
    const s = emptyScreen();
    applyRedraw(s, [
      ["mode_info_set", [true, [{ name: "normal", cursor_shape: "block" }, { name: "insert", cursor_shape: "vertical", cell_percentage: 25 }]]],
      ["mode_change", ["insert", 1]],
    ]);
    expect(s.mode).toBe("insert");
    expect(cursorBox(s)).toEqual({ w: 0.25, h: 1, bottom: false });
  });

  test("an underline cursor sits on the bottom of the cell", () => {
    const s = emptyScreen();
    applyRedraw(s, [
      ["mode_info_set", [true, [{ name: "replace", cursor_shape: "horizontal", cell_percentage: 20 }]]],
      ["mode_change", ["replace", 0]],
    ]);
    expect(cursorBox(s)).toEqual({ w: 1, h: 0.2, bottom: true });
  });

  test("a mode nvim never described is still drawn as something", () => {
    const s = emptyScreen();
    applyRedraw(s, [["mode_change", ["cmdline_normal", 3]]]);
    expect(cursorBox(s)).toEqual({ w: 1, h: 1, bottom: false });
  });

  test("busy is what hides the cursor", () => {
    const s = emptyScreen();
    applyRedraw(s, [["busy_start", []]]);
    expect(s.busy).toBe(true);
    applyRedraw(s, [["busy_stop", []]]);
    expect(s.busy).toBe(false);
  });

  test("an event from a newer nvim is ignored rather than refused", () => {
    /* A UI that threw on an event it had not heard of would break on somebody
       else's editor being upgraded. */
    const s = emptyScreen();
    expect(() => applyRedraw(s, [["win_extmark_from_the_future", [1, 2, 3]], ["flush", []]])).not.toThrow();
    expect(s.seq).toBe(1);
  });

  test("rubbish on the wire does not take the screen down", () => {
    const s = emptyScreen();
    expect(() => applyRedraw(s, [null, 7, "flush", [], [42]])).not.toThrow();
  });
});

describe("rowRuns", () => {
  const row = (spec: Array<[string, number]>): Cell[] =>
    spec.map(([text, hl]) => ({ text, hl }));

  test("cells sharing an attribute become one span", () => {
    expect(rowRuns(row([["a", 1], ["b", 1], ["c", 2]]))).toEqual([
      { text: "ab", hl: 1 },
      { text: "c", hl: 2 },
    ]);
  });

  test("the second half of a wide character is dropped", () => {
    /* The glyph before it already occupies both columns; drawing an empty cell
       after it would push the rest of the line one to the right. */
    expect(rowRuns(row([["漢", 1], ["", 1], ["x", 1]]))).toEqual([{ text: "漢x", hl: 1 }]);
  });

  test("an empty row is no spans at all", () => {
    expect(rowRuns([])).toEqual([]);
  });
});

describe("attributes as CSS", () => {
  const colors = { fg: 0xc9d1d9, bg: 0x14171a, sp: 0xff0000 };
  const table = (a: Attr) => new Map([[1, a]]);

  test("an attribute nothing defined is the default foreground", () => {
    expect(attrCss(0, new Map(), colors)).toBe("color:#c9d1d9");
  });

  test("a background equal to the default is not written", () => {
    /* It is painted once behind the whole grid, so forty rows of it never
       need to reach the DOM. */
    expect(attrCss(1, table({ background: 0x14171a }), colors)).toBe("color:#c9d1d9");
  });

  test("reverse swaps the two colours", () => {
    /* How nvim draws the visual selection, the search match and an inactive
       statusline — the three places a wrong reading shows first. */
    const css = attrCss(1, table({ foreground: 0x000000, background: 0xffffff, reverse: true }), colors);
    expect(css).toBe("color:#ffffff;background:#000000");
  });

  test("reverse on an attribute with no colours of its own swaps the defaults", () => {
    expect(attrCss(1, table({ reverse: true }), colors)).toBe("color:#14171a;background:#c9d1d9");
  });

  test("an undercurl is drawn in the special colour", () => {
    const css = attrCss(1, table({ undercurl: true, special: 0x00ff00 }), colors);
    expect(css).toContain("text-decoration:underline wavy #00ff00");
  });

  test("an undercurl with no special colour of its own falls back", () => {
    expect(attrCss(1, table({ undercurl: true }), colors)).toContain("wavy #ff0000");
  });

  test("bold and italic come through", () => {
    const css = attrCss(1, table({ bold: true, italic: true }), colors);
    expect(css).toContain("font-weight:600");
    expect(css).toContain("font-style:italic");
  });

  test("hex pads a colour that would otherwise be short", () => {
    expect(hex(0x00ff00)).toBe("#00ff00");
    expect(hex(0)).toBe("#000000");
  });
});

describe("the keyboard", () => {
  test("a printable key is itself", () => {
    expect(key("a")).toBe("a");
    expect(key("7")).toBe("7");
  });

  test("shift is not reported for a printable key", () => {
    /* The browser has already applied it, so `<S-A>` would be a different key
       from `A` as far as nvim is concerned. */
    expect(key("A", { shiftKey: true })).toBe("A");
  });

  test("shift is reported for a key that has a name", () => {
    expect(key("Tab", { shiftKey: true })).toBe("<S-Tab>");
  });

  test("the named keys are named", () => {
    expect(key("Escape")).toBe("<Esc>");
    expect(key("Enter")).toBe("<CR>");
    expect(key("Backspace")).toBe("<BS>");
    expect(key("ArrowDown")).toBe("<Down>");
    expect(key("PageUp")).toBe("<PageUp>");
    expect(key("Delete")).toBe("<Del>");
    expect(key("F12")).toBe("<F12>");
  });

  test("a bare space is a space and a modified one is named", () => {
    expect(key(" ")).toBe("<Space>");
    expect(key(" ", { ctrlKey: true })).toBe("<C-Space>");
  });

  test("control and alt are what nvim calls them", () => {
    expect(key("w", { ctrlKey: true })).toBe("<C-w>");
    expect(key("x", { altKey: true })).toBe("<M-x>");
    expect(key("s", { metaKey: true })).toBe("<D-s>");
  });

  test("a literal less-than is escaped", () => {
    /* Otherwise typing one into a file starts a key name and swallows
       everything up to the next `>`. */
    expect(key("<")).toBe("<lt>");
    expect(key("<", { ctrlKey: true })).toBe("<C-lt>");
  });

  test("AltGr produces its character rather than a chord", () => {
    /* Ctrl+Alt is how `@` and `#` are typed on half the layouts in Europe.
       The modifiers made the character; they are not being pressed with it. */
    expect(key("@", { ctrlKey: true, altKey: true })).toBe("@");
  });

  test("AltGr on a named key is still a chord", () => {
    /* No layout produces Enter from a modifier combination. */
    expect(key("Enter", { ctrlKey: true, altKey: true })).toBe("<C-M-CR>");
  });

  test("a modifier on its own sends nothing", () => {
    expect(key("Shift")).toBeNull();
    expect(key("Control")).toBeNull();
    expect(key("AltGraph")).toBeNull();
  });

  test("a dead key or an IME composition sends nothing", () => {
    expect(key("Process")).toBeNull();
    expect(key("Unidentified")).toBeNull();
    expect(key("")).toBeNull();
  });

  test("a key with a name this file has never heard of sends nothing", () => {
    /* Rather than sending `BrowserSearch` into the buffer as text. */
    expect(key("BrowserSearch")).toBeNull();
    expect(key("MediaPlayPause")).toBeNull();
  });

  test("a character outside the basic plane is one key", () => {
    expect(key("é")).toBe("é");
    expect(key("😀")).toBe("😀");
  });
});

describe("the pointer", () => {
  test("a wheel gesture takes the larger axis", () => {
    expect(wheelDir(0, 10)).toBe("down");
    expect(wheelDir(0, -10)).toBe("up");
    expect(wheelDir(-12, 3)).toBe("left");
    expect(wheelDir(12, 3)).toBe("right");
  });

  test("mouse modifiers are spelled without the brackets", () => {
    expect(mouseMods({ ctrlKey: true, altKey: false, shiftKey: true })).toBe("CS");
    expect(mouseMods({ ctrlKey: false, altKey: false, shiftKey: false })).toBe("");
  });

  test("a press finds its cell", () => {
    expect(cellAt(25, 40, 10, 20, { cols: 80, rows: 24 })).toEqual({ row: 2, col: 2 });
  });

  test("a press outside the grid is clamped to it", () => {
    expect(cellAt(9999, 9999, 10, 20, { cols: 8, rows: 4 })).toEqual({ row: 3, col: 7 });
    expect(cellAt(-5, -5, 10, 20, { cols: 8, rows: 4 })).toEqual({ row: 0, col: 0 });
  });

  test("a cell size nothing has measured yet does not divide by zero", () => {
    expect(cellAt(10, 10, 0, 0, { cols: 8, rows: 4 })).toEqual({ row: 0, col: 0 });
  });
});

describe("gridSize", () => {
  test("a partial row is not offered to nvim", () => {
    /* nvim would paint into it and the panel would clip the result. */
    expect(gridSize(1005, 419, 10, 20)).toEqual({ cols: 100, rows: 20 });
  });

  test("a panel too small still asks for something nvim will take", () => {
    expect(gridSize(10, 10, 10, 20)).toEqual({ cols: 20, rows: 5 });
  });

  test("before the font has been measured there is a fallback", () => {
    expect(gridSize(800, 600, 0, 0)).toEqual({ cols: 80, rows: 24 });
  });
});
