/* Whether closing a card is worth asking about.
 *
 * Closing is not undoable and takes the agent down with whatever it was in the
 * middle of, and the ✕ sits on every card, so a stray click on a card that is
 * doing something cost its work. The answer is a pure function of what the card
 * is doing, so it lives here rather than in `App.svelte`: the local ✕, the menu
 * and `<space>cc` all ask it, and so does the one on a card on another wall,
 * off its digest (`shadow.ts`), which is the same two facts arriving by a
 * different road.
 *
 * `working` and `jobs` are `turns.md`'s two questions kept apart on purpose:
 * a turn open, and work still running after the turn that started it. Either
 * is something a close would cut off. An idle card with nothing in the
 * background is not asked about, exactly as before.
 *
 * Pure, and tested directly in `test/closing.test.ts`. */

/** What a card is doing, as far as a close is concerned. A `Conversation` and a
 *  `CardDigest` both have these two fields by these names, or near enough to
 *  read straight across (`jobs` is a count on a digest and a list on a card). */
export type Doing = { working: boolean; jobs: number };

/** What a close would cut off, as sentences — empty when nothing, which is the
 *  whole of "close at once". Lowercase and quiet, the house voice. */
export function closeWarnings(d: Doing): string[] {
  const out: string[] = [];
  if (d.working) out.push("it's mid-turn — closing stops it where it is.");
  const n = Math.max(0, Math.floor(Number.isFinite(d.jobs) ? d.jobs : 0));
  if (n === 1) out.push("it has background work running — closing ends it.");
  else if (n > 1) out.push(`it has ${n} pieces of background work running — closing ends them.`);
  return out;
}

/** Whether a close has to be confirmed. */
export function mustConfirm(d: Doing): boolean {
  return closeWarnings(d).length > 0;
}
