/* Which prompts in a column are Skein's own.
 *
 * The transcript draws a prompt in *your* register — a left rule in the panel, a bubble on
 * the right in chat view — and that is right for what you typed. It was also drawing every
 * prompt the wall sent for an agent to act on there: a resumed turn, a jobs report, the job
 * nudge, a heal's pick-up. Those are not yours, and the right bubble is the one thing on the
 * wall that means "this is what I said" (reported 2026-11-11).
 *
 * **Live this is never guessed.** Every one of them is marked by the code that sends it —
 * `send(…, { own: true })`, or `drawHeld(…, true)` for a brief a queued spawn is holding — so
 * the sender already knows and the line records it. This module is for
 * the other half: a session file records them as ordinary `user` messages with nothing
 * marking them, so the shapes have to be recognised from their words — the same bargain
 * `isResumePrompt` and `isRelayPrompt` strike, and the reason `history.ts` and the live fold
 * can draw a restored card the same way.
 *
 * The three handovers — a plan handover, a spawned card's brief, and the wall's check for a
 * card that moved — are free-form prose, so nothing in their words identifies them, and a
 * transcript record does not grow a field an older file did not have. They are enveloped on
 * the way out now (`relay.ts::handOver`), under `[skein relay] handed over —`, which is
 * recognised below. A probe settled that the mark cannot travel as a field on the wire:
 * `tools/probe-mark.ts` puts one on the user envelope and the CLI drops it from both the
 * replay and the session record.
 */

import { isCarryOn, isJobNudge, isPickUp, isPromptNudge, stripResendMark } from "./classify";
import { isHandoverPrompt } from "./relay";
import { RENEW_ASK } from "./renewing";
import { isJobsPrompt, isResumePrompt } from "./rousing";

/** Whether a prompt is one Skein wrote for a card to act on, rather than something you typed.
 *
 *  The heal's resend mark is stripped first, for `isJobNudge`'s reason: a prompt sent again
 *  after a failure is the same prompt, and its copy must not read as yours.
 *
 *  A word-for-word match is a real cost here — typing one of these sentences yourself draws
 *  it as Skein's — and it is the same cost the family already pays for its long prompts. The
 *  alternative is a flag on the wire, which is a probe away rather than a decision. */
export function isOwnPrompt(text: string): boolean {
  const t = stripResendMark(text).trim();
  return (
    isResumePrompt(t) ||
    isJobsPrompt(t) ||
    isJobNudge(t) ||
    isPromptNudge(t) ||
    isPickUp(t) ||
    isCarryOn(t) ||
    isHandoverPrompt(t) ||
    t === RENEW_ASK.trim()
  );
}

/** Whether a heal is composing a sentence the session has never held: a
 *  **carry-on** after the allowance ran out (the wall asking the card to
 *  continue), or a **pick-up** of a wall-opened turn that failed before reaching
 *  a model. Those go out unmarked, because a mark explains a duplicate and there
 *  is none.
 *
 *  Everything else `#heal` sends repeats text the CLI already recorded, so it
 *  carries the attempt mark — including Skein's own shapes: a resume prompt, a
 *  handover brief and a renewal's ask. The *register* is a separate question,
 *  asked of the text that actually goes out (`#heal` computes it with
 *  `isOwnPrompt(out)`), and conflating the two shipped a defect: a re-sent
 *  handover went out unmarked, as though the brief in the session were not
 *  already there. That is the duplicate `resendMark` exists to explain, and the
 *  reason a retry of a prompt recorded on receipt says so in the copy that
 *  arrives second.
 *
 *  A predicate rather than an inline test because a test can hold it, where the
 *  call site cannot be reached without a `Skein` (found in review: live drew a
 *  carry-on and a pick-up in the person's register while the same words read
 *  off disk were drawn as Skein's). */
export function healFresh(heal: { carry?: boolean; text: string }): boolean {
  return !!heal.carry || isCarryOn(heal.text) || isPickUp(heal.text);
}
