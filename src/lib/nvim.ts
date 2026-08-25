/* The editor's screen, and the keyboard that drives it — all of it pure.
 *
 * Volery attaches to a real nvim as a *UI*: nvim says what the screen looks
 * like, in a grid of cells, and takes keys back. Rust folds none of it (see
 * `nvim.rs`), which is the same division the event pipeline already makes for
 * `claude` — the structured stream arrives and the front end folds it into its
 * own design. This file is that fold, plus the two translations either side of
 * it: an nvim highlight attribute into CSS, and a browser `KeyboardEvent` into
 * the notation nvim's own `:help key-notation` uses.
 *
 * Everything here is a function of its arguments, so `test/nvim.test.ts` tests
 * it directly and `Quill.svelte` is left with nothing but drawing.
 */

/* ── what nvim says a screen is ───────────────────────────────────────────── */

/** One cell. `hl` indexes the attribute table; 0 is the default. */
export interface Cell {
  text: string;
  hl: number;
}

/** A highlight attribute, as `hl_attr_define` gives it. Colours are 24-bit
 *  integers, absent when the attribute inherits the default. */
export interface Attr {
  foreground?: number;
  background?: number;
  special?: number;
  reverse?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
  strikethrough?: boolean;
}

/** The colours everything falls back to, from `default_colors_set`. */
export interface Colors {
  fg: number;
  bg: number;
  sp: number;
}

/** How the cursor is drawn in one mode, from `mode_info_set`. */
export interface ModeInfo {
  name: string;
  shape: "block" | "horizontal" | "vertical";
  size: number;
}

export interface Screen {
  cols: number;
  rows: number;
  /** Row-major, `rows` arrays of `cols` cells. Deliberately mutable and
   *  deliberately **not** `$state`: a hundred-by-forty grid is four thousand
   *  cells rewritten on every keystroke, and a reactive proxy over that would
   *  put Svelte's scheduler in front of the reader thread — the same lesson
   *  `shell.svelte.ts` learned about batching lines. The component watches a
   *  version number instead. */
  cells: Cell[][];
  colors: Colors;
  attrs: Map<number, Attr>;
  cursor: { row: number; col: number };
  modes: ModeInfo[];
  /** Index into `modes`, from `mode_change`. */
  modeIdx: number;
  /** The name of the mode as nvim calls it — `normal`, `insert`, `visual`. */
  mode: string;
  /** nvim is busy and the cursor should not be drawn. */
  busy: boolean;
  /** Bumped on every `flush`, which is nvim saying the screen is consistent
   *  again. The one thing the component needs to be reactive. */
  seq: number;
}

const DEFAULT_COLORS: Colors = { fg: 0xd8d4cc, bg: 0x1a1c1e, sp: 0xd8d4cc };

/** A blank cell. Never shared — a row is mutated in place. */
function blank(): Cell {
  return { text: " ", hl: 0 };
}

export function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, blank);
}

export function emptyScreen(cols = 80, rows = 24): Screen {
  return {
    cols,
    rows,
    cells: Array.from({ length: rows }, () => blankRow(cols)),
    colors: { ...DEFAULT_COLORS },
    attrs: new Map(),
    cursor: { row: 0, col: 0 },
    modes: [],
    modeIdx: 0,
    mode: "normal",
    busy: false,
    seq: 0,
  };
}

/* ── folding a redraw batch ───────────────────────────────────────────────── */

/** Resize, keeping whatever still fits.
 *
 *  Keeping it matters more than it looks: nvim sends `grid_resize` before it
 *  has repainted, so a resize that blanked the screen would flash the panel
 *  empty every time it changed shape. */
function resize(s: Screen, cols: number, rows: number) {
  const next: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const old = s.cells[r];
    const row = blankRow(cols);
    if (old) for (let c = 0; c < Math.min(cols, old.length); c++) row[c] = old[c];
    next[r] = row;
  }
  s.cells = next;
  s.cols = cols;
  s.rows = rows;
  if (s.cursor.row >= rows) s.cursor.row = rows - 1;
  if (s.cursor.col >= cols) s.cursor.col = cols - 1;
}

/** Copy a region up or down, which is what nvim sends instead of repainting a
 *  screen that scrolled.
 *
 *  The direction is the trap: positive `rows` means the *content* moves up, so
 *  the copy runs top-to-bottom; negative means it moves down and the copy has
 *  to run bottom-to-top, or a region overlapping itself smears the first line
 *  it copied over everything below. Vacated lines are left alone — nvim sends
 *  `grid_line` for them immediately afterwards. */
function scroll(s: Screen, top: number, bot: number, left: number, right: number, rows: number) {
  if (!rows) return;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= s.rows || from < 0 || from >= s.rows) return;
    const src = s.cells[from];
    const dst = s.cells[to];
    for (let c = left; c < right && c < s.cols; c++) dst[c] = src[c];
  };
  if (rows > 0) for (let r = top + rows; r < bot; r++) move(r, r - rows);
  else for (let r = bot + rows - 1; r >= top; r--) move(r, r - rows);
}

/** Paint one line.
 *
 *  Two things in the wire format that are easy to get wrong, and both were
 *  confirmed against nvim 0.11.6 with `tools/probe-nvim.ts`:
 *
 *  - **A cell with no `hl` carries the one before it.** The attribute is only
 *    sent when it changes, so defaulting a missing one to 0 paints every run
 *    after the first in the default colours — which looks like a colourscheme
 *    that gave up halfway along the line.
 *  - **`repeat` is a run of identical cells**, which is how a screenful of
 *    trailing spaces costs three numbers rather than a hundred. */
function line(s: Screen, row: number, colStart: number, cells: unknown[]) {
  const target = s.cells[row];
  if (!target) return;
  let c = colStart;
  let hl = 0;
  for (const raw of cells) {
    if (!Array.isArray(raw)) continue;
    const text = typeof raw[0] === "string" ? raw[0] : " ";
    if (typeof raw[1] === "number") hl = raw[1];
    const times = typeof raw[2] === "number" ? raw[2] : 1;
    for (let n = 0; n < times && c < s.cols; n++) target[c++] = { text, hl };
  }
}

/** Fold a batch of redraw events into the screen, in place.
 *
 *  Returns the same object rather than a copy, on purpose: this runs on every
 *  keystroke over a grid of thousands of cells, and the version counter is what
 *  the component watches instead. Unknown events are ignored rather than
 *  refused — nvim adds them between versions, and a UI that threw on one it had
 *  not heard of would break on an upgrade of somebody else's editor. */
export function applyRedraw(s: Screen, events: unknown[]): Screen {
  for (const ev of events) {
    if (!Array.isArray(ev) || typeof ev[0] !== "string") continue;
    const name = ev[0];
    const args = ev.slice(1);

    switch (name) {
      case "grid_resize":
        for (const a of args) {
          if (Array.isArray(a)) resize(s, Number(a[1]) || 1, Number(a[2]) || 1);
        }
        break;

      case "grid_clear":
        s.cells = Array.from({ length: s.rows }, () => blankRow(s.cols));
        break;

      case "grid_line":
        for (const a of args) {
          if (Array.isArray(a) && Array.isArray(a[3])) {
            line(s, Number(a[1]), Number(a[2]), a[3]);
          }
        }
        break;

      case "grid_scroll":
        for (const a of args) {
          if (Array.isArray(a)) {
            scroll(s, Number(a[1]), Number(a[2]), Number(a[3]), Number(a[4]), Number(a[5]));
          }
        }
        break;

      case "grid_cursor_goto":
        for (const a of args) {
          if (Array.isArray(a)) s.cursor = { row: Number(a[1]) || 0, col: Number(a[2]) || 0 };
        }
        break;

      case "default_colors_set":
        for (const a of args) {
          if (!Array.isArray(a)) continue;
          /* -1 is nvim saying "no colour set", which must not become black. */
          const pick = (v: unknown, was: number) =>
            typeof v === "number" && v >= 0 ? v : was;
          s.colors = {
            fg: pick(a[0], s.colors.fg),
            bg: pick(a[1], s.colors.bg),
            sp: pick(a[2], s.colors.sp),
          };
        }
        break;

      case "hl_attr_define":
        for (const a of args) {
          if (Array.isArray(a) && typeof a[0] === "number" && a[1] && typeof a[1] === "object") {
            s.attrs.set(a[0], a[1] as Attr);
          }
        }
        break;

      case "mode_info_set":
        for (const a of args) {
          if (!Array.isArray(a) || !Array.isArray(a[1])) continue;
          s.modes = a[1].map((m: Record<string, unknown>) => ({
            name: typeof m?.name === "string" ? m.name : "",
            shape:
              m?.cursor_shape === "horizontal" || m?.cursor_shape === "vertical"
                ? m.cursor_shape
                : "block",
            size: typeof m?.cell_percentage === "number" ? m.cell_percentage : 100,
          }));
        }
        break;

      case "mode_change":
        for (const a of args) {
          if (!Array.isArray(a)) continue;
          s.mode = typeof a[0] === "string" ? a[0] : s.mode;
          s.modeIdx = Number(a[1]) || 0;
        }
        break;

      case "busy_start":
        s.busy = true;
        break;
      case "busy_stop":
        s.busy = false;
        break;

      case "flush":
        s.seq++;
        break;
    }
  }
  return s;
}

/* ── drawing it ───────────────────────────────────────────────────────────── */

/** A run of cells sharing one attribute — what actually becomes a `<span>`. */
export interface Run {
  text: string;
  hl: number;
}

/** Coalesce a row into runs.
 *
 *  Without this a hundred-column row is a hundred elements, forty times over,
 *  rebuilt on every keystroke. With it a line of source is a handful — one per
 *  token colour — which is what makes the DOM a reasonable surface to draw a
 *  terminal grid on at all.
 *
 *  A cell whose text is empty is the **second half of a double-width
 *  character**, and is dropped rather than drawn: the wide glyph before it
 *  already occupies both columns. */
export function rowRuns(cells: Cell[]): Run[] {
  const out: Run[] = [];
  for (const cell of cells) {
    if (cell.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.hl === cell.hl) last.text += cell.text;
    else out.push({ text: cell.text, hl: cell.hl });
  }
  return out;
}

/** The screen as plain text, one string per row, trailing blanks trimmed.
 *
 *  Not used to draw anything — `Quill.svelte` draws runs, not strings. This is
 *  for reading a grid from *outside*: what nvim has painted is the only
 *  evidence that a file opened, that a search moved the cursor or that a plugin
 *  drew what it was supposed to, and none of it is in the DOM in any form a
 *  test could assert against. See `.claude/rules/control.md`. */
export function screenText(s: { cells: Cell[][] }): string[] {
  return s.cells.map((row) =>
    row
      .map((c) => c.text)
      .join("")
      .replace(/\s+$/, ""),
  );
}

/** `#rrggbb` from the 24-bit integer nvim sends. */
export function hex(n: number): string {
  return "#" + (n & 0xffffff).toString(16).padStart(6, "0");
}

/** One attribute as an inline style.
 *
 *  Inline rather than a class per attribute, and that is a considered trade: a
 *  colourscheme defines several hundred of them (434 on this machine, measured
 *  by `tools/probe-nvim.ts`), they are defined at runtime by somebody else's
 *  config, and a stylesheet built from them would have to be rebuilt whenever
 *  one changed. Runs are few enough per row that the string cost is not the
 *  thing that matters here.
 *
 *  **`reverse` swaps the two colours rather than setting a filter**, because it
 *  is how nvim draws the visual selection, the search match and the statusline
 *  of the inactive window — the three places a wrong reading is most obvious. */
export function attrCss(hl: number, attrs: Map<number, Attr>, colors: Colors): string {
  const a = attrs.get(hl);
  let fg = a?.foreground ?? colors.fg;
  let bg = a?.background ?? colors.bg;
  if (a?.reverse) [fg, bg] = [bg, fg];

  const out = [`color:${hex(fg)}`];
  /* The default background is the panel's own, painted once behind the whole
     grid — so a cell that does not ask for one asks for nothing, and forty
     rows of `background:#1a1c1e` never reach the DOM. */
  if (bg !== colors.bg) out.push(`background:${hex(bg)}`);
  if (a?.bold) out.push("font-weight:600");
  if (a?.italic) out.push("font-style:italic");
  if (a?.strikethrough) out.push("text-decoration:line-through");
  else if (a?.undercurl) out.push(`text-decoration:underline wavy ${hex(a.special ?? colors.sp)}`);
  else if (a?.underdouble) out.push(`text-decoration:underline double ${hex(a.special ?? colors.sp)}`);
  else if (a?.underdotted) out.push(`text-decoration:underline dotted ${hex(a.special ?? colors.sp)}`);
  else if (a?.underdashed) out.push(`text-decoration:underline dashed ${hex(a.special ?? colors.sp)}`);
  else if (a?.underline) out.push("text-decoration:underline");
  return out.join(";");
}

/** How the cursor should be drawn right now, as a fraction of a cell.
 *
 *  nvim describes this per mode rather than per shape name, so insert being a
 *  bar and replace being a short underline are the *config's* decision and not
 *  this app's — which is the whole bargain of running somebody's real editor. */
export function cursorBox(s: Screen): { w: number; h: number; bottom: boolean } {
  const info = s.modes[s.modeIdx];
  const size = Math.max(1, Math.min(100, info?.size ?? 100)) / 100;
  if (info?.shape === "vertical") return { w: size, h: 1, bottom: false };
  if (info?.shape === "horizontal") return { w: 1, h: size, bottom: true };
  return { w: 1, h: 1, bottom: false };
}

/** How many cells fit. Floored, because a partial row is one nvim would paint
 *  into and the panel would clip. */
export function gridSize(
  width: number,
  height: number,
  cellW: number,
  cellH: number,
): { cols: number; rows: number } {
  if (!(cellW > 0) || !(cellH > 0)) return { cols: 80, rows: 24 };
  return {
    cols: Math.max(20, Math.floor(width / cellW)),
    rows: Math.max(5, Math.floor(height / cellH)),
  };
}

/* ── the keyboard ─────────────────────────────────────────────────────────── */

/** Keys with a name of their own in `:help key-notation`. */
const NAMED: Record<string, string> = {
  Escape: "Esc",
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Del",
  " ": "Space",
};

/** Keys that are a modifier and nothing else. */
const BARE = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

/** A browser key event in nvim's notation, or null when there is nothing to
 *  send.
 *
 *  Three things worth knowing, each of which is a bug if got wrong:
 *
 *  - **Shift is not reported for a printable key.** The browser has already
 *    applied it — `e.key` is `A`, not `a` — so adding `S-` would send `<S-A>`,
 *    which nvim reads as a *different* key from `A`.
 *  - **`<` has to be escaped**, or typing one into a file is read as the start
 *    of a key name and swallows everything up to the next `>`.
 *  - **AltGr is Ctrl+Alt on Windows**, which is how `@` and `#` are typed on
 *    half the layouts in Europe. So a printable character that arrived *with*
 *    both is sent as itself rather than as `<C-M-@>` — the modifiers made the
 *    character, they are not being pressed with it. */
export function nvimKey(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = e.key;
  if (!key || key === "Unidentified" || key === "Process" || BARE.has(key)) return null;

  const named = NAMED[key] ?? (/^F\d{1,2}$/.test(key) ? key : null);
  const printable = !named && Array.from(key).length === 1;

  let ctrl = e.ctrlKey;
  let alt = e.altKey;
  if (printable && ctrl && alt) {
    /* AltGr. The character in `e.key` is what the layout produced. */
    ctrl = false;
    alt = false;
  }

  if (!named && !printable) return null;

  let mods = "";
  if (ctrl) mods += "C-";
  /* Shift only where the browser has not already spent it. */
  if (e.shiftKey && named) mods += "S-";
  if (alt) mods += "M-";
  if (e.metaKey) mods += "D-";

  if (named) return `<${mods}${named}>`;
  if (!mods) return key === "<" ? "<lt>" : key;
  return `<${mods}${key === "<" ? "lt" : key}>`;
}

/** What a wheel gesture is called to `nvim_input_mouse`. */
export function wheelDir(dx: number, dy: number): "up" | "down" | "left" | "right" {
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "down" : "up";
  return dx > 0 ? "right" : "left";
}

/** The modifier string `nvim_input_mouse` takes, which is not the same spelling
 *  the key notation uses — no angle brackets and no trailing dash. */
export function mouseMods(e: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string {
  return (e.ctrlKey ? "C" : "") + (e.shiftKey ? "S" : "") + (e.altKey ? "A" : "");
}

/** Where in the grid a pointer is, clamped to it. */
export function cellAt(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  s: { cols: number; rows: number },
): { row: number; col: number } {
  if (!(cellW > 0) || !(cellH > 0)) return { row: 0, col: 0 };
  return {
    row: Math.max(0, Math.min(s.rows - 1, Math.floor(y / cellH))),
    col: Math.max(0, Math.min(s.cols - 1, Math.floor(x / cellW))),
  };
}
