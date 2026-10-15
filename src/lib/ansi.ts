/* Turn a dev server's terminal output into something we can render.
 *
 * Servers keep their colour through a pipe by being *asked* to rather than by
 * being a terminal — `servers::force_colour` — but it arrives the same way
 * either way, as SGR escape sequences. This is a deliberately small parser: the
 * 16 basic colours, bold and dim, and reset. That covers essentially everything
 * vite, cargo, tsc and npm emit. Anything else is dropped rather than printed
 * as noise.
 *
 * Which is why `force_colour` asks for `FORCE_COLOR=1` and not `3`: a
 * truecolour `38;2;r;g;b` is parsed correctly here and then leaves the colour
 * alone, so requesting 24-bit would render as no colour at all. The narrow ask
 * matches the narrow renderer on purpose — if this parser ever grows a palette,
 * that is the other half of the change.
 *
 * Pure, so it is tested directly. */

export type Span = {
  text: string;
  /** Index into the palette, or null for the default paper colour. */
  color: number | null;
  bold: boolean;
  dim: boolean;
};

/** The CSS a span's colour is drawn with: `var(--ansi-N)`, declared in
 *  `tokens.css`. The sixteen are custom properties rather than hex values here
 *  because the right set depends on the ground — pale celadon is 8.6:1 on the
 *  dark wall and illegible on cream — and `data-ground="light"` swaps them. A
 *  hex in this file could not follow the skin, and every consumer drew it as an
 *  inline style that nothing could override. */
export function ansiVar(index: number): string {
  return `var(--ansi-${index})`;
}

/** The dark-ground values, kept for what cannot read a stylesheet and as the
 *  statement of what `tokens.css` declares for `--ansi-0` … `--ansi-15` outside
 *  a light ground (`test/ansi.test.ts` holds the two together). Warm-neutral
 *  takes on the standard 16, so terminal output still looks like it belongs on an
 *  ink wall rather than in somebody else's console. Nothing draws with this any
 *  more — see `ansiVar`. */
export const ANSI_PALETTE = [
  "#4b4340", // black
  "#c5603f", // red     — the same rust that means "broke"
  "#7fb8a4", // green   — the same celadon that means "alive"
  "#e9a13b", // yellow  — the same amber that means "wants you"
  "#7f9dc0", // blue
  "#a98cc0", // magenta
  "#6fb5b5", // cyan
  "#b4a89c", // white
  "#6b6058", // bright black
  "#e07a55", // bright red
  "#9bd4bf", // bright green
  "#f5bc63", // bright yellow
  "#9bb8d8", // bright blue
  "#c4a8d8", // bright magenta
  "#8fd0d0", // bright cyan
  "#ede4d8", // bright white
];

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
// Everything else: cursor moves, erase-line, mode switches. Dropped.
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[(][0-9;?]*[a-zA-Z]|\x1b./g;

/** Strip every escape sequence, leaving readable text. */
export function stripAnsi(input: string): string {
  return input.replace(SGR, "").replace(OTHER_ESCAPES, "");
}

/** Split a line into styled spans. */
export function parseAnsi(input: string): Span[] {
  const spans: Span[] = [];
  let color: number | null = null;
  let bold = false;
  let dim = false;
  let at = 0;

  const push = (text: string) => {
    if (!text) return;
    const clean = text.replace(OTHER_ESCAPES, "");
    if (!clean) return;
    const last = spans[spans.length - 1];
    /* Merge runs with identical styling so the DOM stays small on chatty
       output — a progress line can otherwise become hundreds of spans. */
    if (last && last.color === color && last.bold === bold && last.dim === dim) {
      last.text += clean;
    } else {
      spans.push({ text: clean, color, bold, dim });
    }
  };

  SGR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR.exec(input)) !== null) {
    push(input.slice(at, m.index));
    at = m.index + m[0].length;

    // A bare `\x1b[m` is a reset, same as `\x1b[0m`.
    const codes = (m[1] === "" ? "0" : m[1]).split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = null;
        bold = false;
        dim = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c >= 30 && c <= 37) color = c - 30;
      else if (c >= 90 && c <= 97) color = c - 90 + 8;
      else if (c === 39) color = null;
      else if (c === 38 || c === 48) {
        /* 256-colour and truecolour: consume the arguments so their numbers
           are never mistaken for further codes, then approximate 38 (a
           foreground) by leaving the colour alone. */
        const mode = codes[i + 1];
        if (mode === 5) i += 2;
        else if (mode === 2) i += 4;
      }
      // 40-47 / 100-107 are backgrounds; a log pane has one ground, so ignored.
    }
  }
  push(input.slice(at));
  return spans;
}
