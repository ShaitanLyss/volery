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

import type { Remote } from "./handle";

/** How a drop reaches the card with this id, or null for the ordinary carrier. */
export type Carrier = (card: string) => { caps: "afar"; can: boolean } | null;

let provided: Carrier = () => null;

/** Set once at the root, from the wall's cards and their roster rows. */
export function provideCarrier(c: Carrier): void {
  provided = c;
}

/** What a drop to `card` becomes — the parcel's caps and whether that wall
 *  lands one, or null for a path. Read by `PromptBox` on every drop. */
export function carrierTo(card: string | null | undefined): { caps: "afar"; can: boolean } | null {
  return card ? provided(card) : null;
}

/** The carrier the root would provide for a card with this `remote` — the whole
 *  decision, pure, so `App.svelte` wires it in one line and a test can hold it.
 *
 *  Only a card on another wall is a parcel. A card here (`remote` null) is a
 *  path in the sentence, which its agent reads with its own tools — a copy into
 *  its folder would be work it did not ask for. A wall from before parcels
 *  (`can` false) is the ordinary carrier too, and the strip says so. */
export function carrierFor(remote: Remote | null): { caps: "afar"; can: boolean } | null {
  return remote ? { caps: "afar", can: !!remote.parcel } : null;
}
