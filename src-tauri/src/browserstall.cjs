/* When a card's own tab has stopped answering, and what the card is told.
 *
 * Since each card is a context of its own, a frozen tab costs other cards
 * nothing — measured (`probe-card-tabs.ts stall`, part 1): card B's calls and
 * a new card's first call ran in 6-500ms beside card A's looping tab. It cost
 * card A everything. Every reply lists every tab's title, `page.title()` has
 * no deadline, so one frozen tab hung *every* call A made, on its healthy tab
 * too, until the CLI gave up on the call five minutes later.
 *
 * Lyss's decision (2026-10-25): Volery tells the card and never touches the
 * page, and never cuts off the agent's own script. So the host does two things
 * and both are said here:
 *
 * - **A tab title gets a deadline.** Past it the tab list reads the browser's
 *   own title and *not answering*, and the card's other tabs work normally.
 * - **A call that is still running gets its tab looked at**, and is ended with
 *   a sentence only when the look is evidence rather than elapsed time.
 *
 * **What a look can and cannot tell apart** is the whole of the second half,
 * and every row was measured (parts 2, 3, 6):
 *
 * - A frozen loop, an `alert()` left open, the agent's own 12s synchronous
 *   evaluate and a page mid-way through a slow navigation all read the same to
 *   a fresh socket: nothing answers, not even `Page.enable`. Chrome holds every
 *   protocol message to a page that is navigating until the navigation
 *   commits, which is why the last one is silent too.
 * - So the host asks what it knows instead: Playwright holds a dialog as a
 *   modal state (and already answers every tool with it at once — part 2); a
 *   navigation in flight is a main-frame request with no response yet; the
 *   agent's own script is the tool being `browser_evaluate` or
 *   `browser_run_code_unsafe`. None of those is ever named.
 * - A page paused in a debugger answers the protocol and runs no timer, and
 *   so does a page whose timers are faked or wrapped. A page that answers the
 *   protocol cannot hold a call past the bounded waits, so it is never named;
 *   only a page that answers nothing is.
 * - A heavy page that still yields (40ms of work a frame) answers in ~75ms,
 *   and `browser_wait_for` leaves its page answering throughout.
 *
 * And what frees a frozen tab, because the sentence says it: closing it (0.5s)
 * or navigating it to another host (50ms — a new process). Not another port
 * on the same host: Chrome's site ignores the port, so that is the same
 * frozen process. A reload, a
 * same-site navigation, `Runtime.terminateExecution` and a screenshot all
 * reach nothing, because they need the frozen process.
 *
 * Pure. `browserhost.cjs` does the asking; `test/browserstall.test.ts` runs
 * this.
 */
"use strict";

/** The tools that run the agent's own code in the page. A silent page under
 *  one of these may be exactly what the agent asked for — a 40s computation
 *  reads the same as `while(true){}` — so they are never cut off. */
const AGENT_CODE = new Set(["browser_evaluate", "browser_run_code_unsafe"]);

/** Tools that are never watched at all: the agent's own code, and the ones
 *  that are how a frozen tab is got rid of. `browser_handle_dialog` *is*
 *  watched: a page can freeze the moment its dialog is answered. */
const UNWATCHED = new Set([...AGENT_CODE, "browser_tabs", "browser_close", "browser_install"]);

/** The tools that need the current tab's page to answer before they can do
 *  anything, and so are refused up front once that tab is known not to. An
 *  explicit list, so a tool that does not need the page — the console and
 *  network readings, which are how a freeze is diagnosed, a resize, a
 *  navigation (another host is the measured way out), a timed wait — and any
 *  tool added later is let through to the watch rather than refused. */
const NEEDS_PAGE = new Set([
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_select_option",
  "browser_fill_form",
  "browser_press_key",
  "browser_take_screenshot",
  "browser_file_upload",
  "browser_find",
]);

function watched(tool) {
  return !UNWATCHED.has(tool);
}

function refusedUpFront(tool) {
  return NEEDS_PAGE.has(tool);
}

/** How much longer than usual to wait before watching a call at all. A timed
 *  `browser_wait_for` sleeps in the host for its whole length — the page may
 *  be busy on purpose all that while — so its watch starts after it. */
function waitsFirst(tool, args) {
  if (tool !== "browser_wait_for") return 0;
  const t = Number(args && args.time);
  return Number.isFinite(t) && t > 0 ? t * 1000 : 0;
}

/** One look, in one word. `late` is a look whose connect or handshake used
 *  more than half its budget: too short a question to accuse anybody with,
 *  which is `browser::answers`' rule.
 *
 *  `answering` is a page that answers the protocol and runs no timer: paused
 *  in a debugger (measured), frozen by Chrome, or a page whose timers are
 *  faked or wrapped (zone.js, a test clock). Such a page cannot hold a call
 *  past the bounded waits Playwright and the host already put on everything,
 *  so it is never named — only `silent`, a page that answered nothing, is. */
function reading(look) {
  if (!look || !look.socket || look.late) return "unknown";
  if (look.turn) return "ok";
  if (look.enable) return "answering";
  return "silent";
}

/** Two looks some seconds apart and what the host knows now. A tab is named
 *  only when both looks found it silent and nothing by design explains it —
 *  the next thing an agent may do with the name is close it. */
function verdict(first, second, now) {
  if (!now || now.closed || now.dialog || now.navigating || now.served) return null;
  return first === "silent" && second === "silent" ? "silent" : null;
}

/** A page's own words, made safe to set inside quotes in Volery's sentence:
 *  no control characters, nothing that could close the quote, start a line,
 *  open a code span or reorder what is drawn. `hooks::stall_note`'s rule. */
function quoted(s, max) {
  let t = String(s || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/["`\n\r\u201c\u201d\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
  const chars = Array.from(t);
  if (chars.length > max) t = chars.slice(0, max).join("") + "…";
  return `"${t}"`;
}

/** A URL without its query or fragment: enough to name a tab, and none of
 *  the codes and tokens a sign-in leaves in a URL. */
function bareUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return `${u.origin === "null" ? u.protocol : u.origin}${u.pathname}`;
  } catch {
    return String(url || "").split(/[?#]/)[0];
  }
}

const WAYS_OUT = (index) =>
  `It is your tab, and no other card can see it. \`browser_tabs\` with action "close" and index ${index} frees you at once, and so does \`browser_navigate\` to a page on another host — 127.0.0.1 instead of localhost, say. Another port on the same host, a reload, or a navigation within the same site will not: Chrome keeps a site in one process, and that process is the frozen one.`;

/** What a card is told when its call is ended. `still` is a call that never
 *  started: the tab was already known not to answer, one more look agreed,
 *  and the tool was not dispatched. A call ended while it ran may yet take
 *  effect, and the sentence says so, so the agent does not repeat it blind. */
function stuckNote({ index, title, url, seconds, gap, still }) {
  const tab = `your tab at index ${index}, ${quoted(title || "untitled", 80)} (${quoted(bareUrl(url), 120)}),`;
  const ended = still
    ? `${tab} is still not answering, so this call was not made.`
    : `${tab} stopped answering, so Volery stopped waiting on this call after ${seconds}s.`;
  const why = `Its page answered nothing at all in two looks ${gap}s apart: an infinite loop, a long synchronous script, or a dialog Playwright never saw. Volery did nothing to the tab.`;
  const pending = still ? "" : " What the call was doing may still happen once the tab answers, so take a snapshot before you repeat an action.";
  return [`volery: ${ended} ${why}${pending}`, `${WAYS_OUT(index)} If it is busy on purpose, wait and call again.`].join("\n");
}

/** What a card is told when its current tab is silent and another tab of its
 *  own has a dialog open: a dialog blocks its tab's whole process, which a
 *  same-site tab shares, so the dialog is the likelier cause and answering it
 *  the remedy. */
function dialogNote({ index, title, dialogIndex, dialogTitle, seconds }) {
  return [
    `volery: your tab at index ${index}, ${quoted(title || "untitled", 80)}, is not answering, and your tab at index ${dialogIndex}, ${quoted(dialogTitle || "untitled", 80)}, has a dialog open — on the same site, that holds both. Volery stopped waiting on this call after ${seconds}s and did nothing to either tab.`,
    `Answer the dialog: \`browser_tabs\` select index ${dialogIndex}, then \`browser_handle_dialog\`. What this call was doing may still happen once the tab answers, so take a snapshot before you repeat an action.`,
  ].join("\n");
}

/** What the tab list says for a tab whose title did not come back in time. */
function titleNote(title, navigating) {
  const t = String(title || "").trim();
  const state = navigating ? "loading" : "not answering";
  return t ? `${t} (${state})` : `(${state})`;
}

/** What the wall's chronicle is handed, once per tab per time it stops:
 *  `via` says how the card heard — its call was ended, or its tab list marks
 *  the tab. */
function reportBody({ title, url, via }) {
  return { title: String(title || ""), url: bareUrl(url), via: via === "call" ? "call" : "list" };
}

module.exports = { AGENT_CODE, UNWATCHED, NEEDS_PAGE, watched, refusedUpFront, waitsFirst, reading, verdict, quoted, bareUrl, stuckNote, dialogNote, titleNote, reportBody };
