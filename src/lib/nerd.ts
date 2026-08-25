/* The icons somebody else's config draws with, and the one measurement that
 * makes them fit a cell.
 *
 * A modern editor config — nvchad, lazyvim, anything with a file tree — draws
 * its tree, its git gutter, its statusline and its diagnostics out of a Nerd
 * Font: several thousand glyphs in the private use area, which no font that
 * ships with Windows has. Without one, every one of them is tofu, and the
 * editor Volery draws is a worse-looking editor than the same nvim in a
 * terminal. So this is the one face the app carries rather than finds:
 * `fonts/symbols-nerd-font-mono.woff2`, Nerd Fonts v3.4.0 symbols-only, MIT
 * (`fonts/LICENSE-nerd-fonts`).
 *
 * **It has no letters in it**, which is what makes it safe to put in a font
 * stack at all — probed with fontTools: 10,410 mapped codepoints, none in
 * U+0041–U+007A, not even a space. A face named after the ones that can set
 * text can only ever supply a glyph they do not have, so `--mono` still reads
 * in Cascadia and only the tofu changes. That is also why it is in `--mono`
 * itself rather than only in the editor: the shell and the server logs render
 * somebody else's output too, and a prompt with a git branch icon in it is the
 * same case as a statusline with one.
 *
 * ### Why this is a `FontFace` and not an `@font-face`
 *
 * The glyphs in the symbols font are **one em wide, every one of them** —
 * measured, all 10,410 at advance 2048/2048. The faces that set text are not:
 * Cascadia Mono and JetBrains Mono are 0.6 em, Consolas is 0.55. So an icon
 * dropped into a monospace line is around 1.6 cells wide, and in the editor
 * grid — where nvim has already decided that a private-use glyph occupies one
 * column — everything after it on that row slides right and the caret, which is
 * placed by arithmetic on the cell width, lands in the wrong column.
 *
 * `size-adjust` on the face is the fix, and the number has to be *measured*
 * rather than written down, for the same reason `Quill.svelte` measures a cell
 * instead of assuming one: the ratio is a property of whichever face in
 * `--mono` the machine actually has, and this app does not get to know which
 * that is. A descriptor cannot read a custom property, so the rule cannot live
 * in `tokens.css` and be measured; it is constructed here instead, once, before
 * anything is drawn. Which is also what a patched Nerd Font does — the `Mono`
 * variants scale their icons to one cell of the font they were patched into,
 * and this arrives at the same place from the other side.
 */

import symbols from "./fonts/symbols-nerd-font-mono.woff2?url";

/** What one character of `--mono` is, as a fraction of the em.
 *
 *  Fifty of them and a large size, because a single glyph's advance rounds to
 *  whatever fraction the layout engine feels like — the same reason
 *  `Quill.svelte`'s ruler is fifty characters long. */
function advanceRatio(): number {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(50);
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;white-space:pre;" +
    "font-family:var(--mono);font-size:100px;";
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();

  const ratio = width / 50 / 100;
  /* A measurement taken before the document has a body, or against a face that
     is not monospace at all, is not worth acting on. 0.6 is Cascadia's, which
     is what this machine and every Windows 11 has. */
  return ratio > 0.3 && ratio < 1.5 ? ratio : 0.6;
}

/** Declare the symbols face, sized to the cell the rest of `--mono` draws.
 *
 *  Called once from `main.ts`, before `mount`. Nothing is fetched here: a
 *  `FontFace` added to the document is loaded only when a glyph only it has is
 *  actually drawn, so a wall with no editor open never pays the 1.2 MB. */
export function fitNerdSymbols(): void {
  if (typeof FontFace !== "function" || !document.fonts) return;
  /* `local()` first: a machine whose terminal already has the symbols font
     installed uses that copy and fetches nothing. Same font either way, so the
     same adjustment holds. */
  const src =
    `local("Symbols Nerd Font Mono"), local("SymbolsNerdFontMono-Regular"), ` +
    `url(${JSON.stringify(symbols)}) format("woff2")`;
  const face = new FontFace("Nerd Symbols", src, {
    display: "swap",
    sizeAdjust: `${(advanceRatio() * 100).toFixed(2)}%`,
  } as FontFaceDescriptors);
  document.fonts.add(face);
}
