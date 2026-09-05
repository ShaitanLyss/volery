/* Standing instructions, in the front end.
 *
 * The subsystem's reasoning is in `src-tauri/src/guidance.rs` — why the text
 * goes into the system prompt rather than a `CLAUDE.md` or a hook, why a card
 * already running does not hear an edit, and why "this project is read-only" is
 * an instruction rather than a lock. What is here is only the panel's arithmetic
 * and the wall's reading of it, kept pure so it has a test.
 *
 * The one thing this file decides on its own is what "changed" means, and it is
 * decided in exactly one place on purpose. A draft in a textarea and a string in
 * SQLite differ constantly in ways nobody typed — a trailing newline from
 * hitting Enter before Save, leading space from a paste — and a Save button that
 * lights up for those is a button that always looks like there is work to do.
 * `tidy` is what is sent and `changed` compares what would be sent, so the two
 * cannot drift apart. */

/** The most one scope may carry. Mirrors `guidance::LIMIT` in Rust, which is
 *  where the argument for the number is, and which enforces it — this is the
 *  half that counts down so nobody meets it by being truncated. */
export const LIMIT = 4000;

/** What actually gets stored: trimmed and bounded, the same two operations
 *  `guidance::clip` performs, in the same order.
 *
 *  Deliberately does not touch the middle. It was tempting to collapse runs of
 *  blank lines, and it is wrong: this is prose somebody wrote, and an editor
 *  that reformats what you typed while you are typing it is one you stop
 *  trusting with anything long. */
export function tidy(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= LIMIT ? trimmed : [...trimmed].slice(0, LIMIT).join("").trimEnd();
}

/** Whether a draft differs from what is stored, once both are what would be
 *  sent. This is what a Save button turns on. */
export function changed(draft: string, stored: string): boolean {
  return tidy(draft) !== tidy(stored);
}

/** How many characters are left of `LIMIT`, never negative.
 *
 *  Counted in code points rather than UTF-16 units — `.length` would say an
 *  emoji costs two and the Rust side, which does the enforcing, counts `char`s.
 *  A counter that disagrees with the limit it is counting against is worse than
 *  none: it reads as the app losing your text. */
export function room(draft: string): number {
  return Math.max(0, LIMIT - [...draft.trim()].length);
}

/** Has this scope anything to say at all? The wall draws a mark on a territory
 *  that carries instructions, so this is asked of every project every paint. */
export function set(text: string | null | undefined): boolean {
  return !!text && text.trim().length > 0;
}

/** The three tools a locked territory refuses, named rather than summarised.
 *
 *  Named because the card is told them by name too (`guidance::compose`), and a
 *  switch whose label says "no editing" against a system prompt that says
 *  "`Edit`, `Write` and `NotebookEdit`" is two descriptions of one thing that
 *  can drift. Mirrors the array in `hooks::settings`, which is what actually
 *  denies them. */
export const LOCKED_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/** What the read-only switch says about itself, at a given state.
 *
 *  Here rather than in the component for one reason: **the whole difficulty of
 *  this switch is saying what it is without a tooltip.** The box beside it
 *  *asks* a card not to edit; this *refuses it the tools*, and a label that does
 *  not carry that distinction leaves somebody believing prose is enforcement —
 *  which is the state sink `8dde1cc1` was filed about. Prose that load-bearing
 *  wants a test.
 *
 *  It deliberately does not claim more than it does. The shell is untouched, so
 *  this says "the editing tools" and never "read only" on its own; the honest
 *  version of the strong claim is a decision the user has held (sink
 *  `b3230b03`). */
export function lockGist(name: string, locked: boolean): string {
  return locked
    ? `${LOCKED_TOOLS.join(", ")} are taken away from cards in ${name}. they can still read, ` +
        `search and run commands, and are told to hand a change back in words rather than stop.`
    : `cards in ${name} can edit it. the box below can ask them not to — this takes the ` +
        `editing tools away, so there is nothing to refuse.`;
}

/** A one-line reading of a scope, for a tooltip or a menu — the first line that
 *  has anything on it, cut to `width` with an ellipsis.
 *
 *  The *first* line rather than a summary of the whole, because the first line
 *  is the one the author wrote to be read first, and because any cleverer answer
 *  would be this file guessing at prose. Empty when there is nothing set, so a
 *  caller can use it as the whole test. */
export function gist(text: string | null | undefined, width = 60): string {
  const line = (text ?? "").split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!line) return "";
  return [...line].length <= width ? line : `${[...line].slice(0, width - 1).join("")}…`;
}
