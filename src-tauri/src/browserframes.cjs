/* Whether the page a card is driving is drawing real frames, and what the card
 * is told when it is not. Pure: `browserhost.cjs` asks Chrome where the page's
 * window is and hands the answer here; `test/browserframes.test.ts` holds it.
 *
 * **Why a card has to be told at all** (2026-10-27, card 0c8147e8 measuring a
 * store hop in nova). Playwright turns on focus emulation for every page it
 * drives, and focus emulation makes Chrome treat the page as visible whatever
 * its window is doing — so `document.visibilityState` reads "visible" and
 * `document.hasFocus()` true in the two cases where Chrome is in fact not
 * drawing it, and the page has no way to tell:
 *
 *   - **a tab behind another tab in the same window.** Measured with an animated
 *     WebGL page: 0.998 fps behind a tab, 240 in front, `visible` and focused
 *     in both. The nova card's pages had become tabs of one window because its
 *     script opened pages with `page.context().newPage()`, which went round the
 *     host's one-window-per-page rule (closed in `browserhost.cjs`); a link that
 *     opens in a new tab (`target=_blank`) still makes one, and Chrome cannot
 *     move a tab into a window of its own over CDP.
 *   - **a minimised window**: no frames at all, with every Chrome flag tried —
 *     the one Volery launches with (`--disable-backgrounding-occluded-windows`)
 *     and `CalculateNativeWinOcclusion` off alike. Volery parks a minimised
 *     browser window off-screen by itself (`browser::watch_minimise`), so this
 *     reading should be brief; it is said because it is not impossible.
 *
 * A window merely *covered* by another app is not on the list: with the launch
 * flag it draws at the display's rate (240 fps under Volery's own window,
 * measured on the shared browser). The screen being locked or asleep is
 * Volery's to read, not Chrome's, and its sentence comes from Rust
 * (`browser::frames_note`).
 *
 * Plain CommonJS with no dependency, beside `browserstall.cjs`.
 */

/** The calls a frame rate is measured *in*. The note is repeated on every one
 *  of them while the condition holds, since that is the moment a number is
 *  being taken; on any other call it is said once, when the reading changes,
 *  so a card stuck behind a tab for an hour of clicking is not told forty
 *  times. */
const MEASURING = new Set(["browser_evaluate", "browser_run_code_unsafe", "browser_run_code"]);

/** What Chrome said about the page's window, reduced to the two facts that
 *  stop its frames. `mine` is `Browser.getWindowForTarget` for the page;
 *  `others` the same for every other page in the browser. */
function reading(mine, others) {
  if (!mine || mine.windowId === undefined) return null;
  const sharing = others.filter((w) => w && w.windowId === mine.windowId).length;
  const minimized = mine.bounds?.windowState === "minimized";
  return { sharing, minimized };
}

/** A key for "has this changed since we last said it". */
function key(r) {
  return r ? `${r.minimized ? "min" : ""}|${r.sharing}` : "";
}

/** Whether the note is said on this call. */
function due(r, said, tool) {
  if (!r || (!r.minimized && r.sharing === 0)) return false;
  return MEASURING.has(tool) || key(r) !== said;
}

function note(r) {
  if (!r) return "";
  if (r.minimized) {
    return (
      "### Frames\n" +
      "This page's Chrome window is minimised, and Chrome draws no frames for a minimised window " +
      "— although the page still reports `visibilityState: \"visible\"` and focus, because Playwright " +
      "emulates focus. Any frame rate, requestAnimationFrame timing, long-frame count or screencast " +
      "taken now is meaningless. Volery moves a minimised browser window off-screen by itself within a " +
      "moment, which keeps it drawing; measure again. If this note keeps coming back, tell the user " +
      "rather than recording the numbers."
    );
  }
  if (r.sharing > 0) {
    const tabs = r.sharing === 1 ? "one other tab" : `${r.sharing} other tabs`;
    return (
      "### Frames\n" +
      `This page shares its Chrome window with ${tabs}, and Chrome only draws the tab in front. A tab ` +
      "behind another gets about one frame a second (measured 0.998 fps against 240 in front) while it " +
      "still reports `visibilityState: \"visible\"` and focus, because Playwright emulates focus — so " +
      "the page cannot tell. Any frame rate, requestAnimationFrame timing, long-frame count or " +
      "screencast taken in this page is meaningless unless it is the front tab. To make it real, close " +
      "the other pages in this window (`browser_tabs` with `close`, or `page.close()` on a page your " +
      "script opened) and measure again. Pages opened with `browser_tabs` `new` or `context.newPage()` " +
      "get a window of their own and never cause this; a link that opens a new tab (`target=_blank`) " +
      "still puts it in this window."
    );
  }
  return "";
}

module.exports = { MEASURING, reading, key, due, note };
