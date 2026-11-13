/* What a drop of files and folders becomes, answered by the card it is aimed at.
 *
 * Every input that speaks to an agent — the dock's field, chat view's message
 * box, a question's answer, a notice's reply — takes a drop, and what that drop
 * *is* depends on where the card runs, not on which box it landed in. On this
 * wall a path is enough, because the agent opens it with its own tools. On
 * another wall a path here means nothing there, so the bytes must travel and the
 * wall's honest shape for that is a parcel (`docs/PARCEL-DROP.md`).
 *
 * So this is ambient, on `useFiles`' argument (CLAUDE.md, *a capability every
 * surface should have is not a prop*): the root knows every card and its wall's
 * roster, a box knows only which card it is writing to, and threading a
 * capability through each mounter is a thing a surface can forget — silently,
 * because a box that forgot would just attach a path to a card that cannot read
 * one. A surface says the one thing the root cannot know (`to`), and this says
 * the rest.
 *
 * **Null is the ordinary attachment**, and it is the default: a card on this
 * wall, a chat card, a card whose wall did not announce parcels, and a target
 * the root has never heard of all fall back to the path. That is the direction
 * that fails safe — a path to a card here is what a drop has always been.
 *
 * Plain `.ts` would do, but it is provided at the root and read inside
 * components the same way `paths.svelte.ts` is, so it sits beside it. */

import type { Reach } from "./attach";
import type { Remote } from "./handle";

/** What a drop to one card becomes: the parcel's caps and whether that wall
 *  lands one, the ordinary carrier (null), or a refusal said beside the box.
 *
 *  Refusal is a third answer rather than a null because it is not the box
 *  forgetting something — it is the target having no shape this gesture fits.
 *  A remote chat card has no project to receive a hand-off, so a parcel to it
 *  is refused in one line exactly as an agent's parcel is, and selecting *no*
 *  carrier would attach it as a path its agent cannot open instead. */
export type Placing = { caps: "afar"; can: boolean } | { refuse: string };

/** How a drop reaches the card with this id, or null for the ordinary carrier. */
export type Carrier = (card: string) => Placing | null;

/** The same sentence a drop on a chat card's *face* gives (`App.svelte`): the
 *  two gestures are one refusal. */
export const CHAT_REFUSAL =
  "a chat card has no project to receive a hand-off — drop it on a project card";

let provided: Carrier = () => null;

/** Set once at the root, from the wall's cards and their roster rows. */
export function provideCarrier(c: Carrier): void {
  provided = c;
}

/** What a drop to `card` becomes — read by `PromptBox` on every drop. */
export function carrierTo(card: string | null | undefined): Placing | null {
  return card ? provided(card) : null;
}

/** The carrier the root would provide for a card with this `remote` and
 *  `reach` — the whole decision, pure, so `App.svelte` wires it in one line and
 *  a test can hold it.
 *
 *  Only a card on another wall is a parcel. A card here (`remote` null) is a
 *  path in the sentence, which its agent reads with its own tools — a copy into
 *  its folder would be work it did not ask for, and a local chat card keeps its
 *  own carriage (`Reach`, a PDF read in and the rest refused by the send). A
 *  wall from before parcels (`can` false) is the ordinary carrier too, and the
 *  strip falls back to it saying so.
 *
 *  **A remote chat card refuses**, and that is `reach.chat` rather than the
 *  digest's kind read here again: `CardHandle.reach` is the one place a card
 *  says what it can take, and a surface asking a second field would be a second
 *  answer that can disagree. */
export function carrierFor(remote: Remote | null, reach: Reach | null): Placing | null {
  if (!remote) return null;
  if (reach?.chat) return { refuse: CHAT_REFUSAL };
  return { caps: "afar", can: !!remote.parcel };
}
