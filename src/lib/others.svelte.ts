/* The other conversations, as a thread can reach them.
 *
 * Chat view draws a conversation's relations inside its thread — the card a
 * spawn call opened, standing where the call stands; a relay drawn as a
 * message from whoever sent it, with their name to open them by
 * (`docs/chat-mode.md` §5.5). Both need to find a card by its handle and to
 * select one, and both are the view's to answer: only it knows what selecting
 * means.
 *
 * Ambient rather than a prop on `Thread`, by CLAUDE.md's *a capability every
 * surface should have is not a prop*: set once by the view that can answer it,
 * read by whatever is drawn under it. And with **no default** — the wall's
 * panel provides nothing, so a thread drawn there finds no relations and draws
 * none, rather than reaching for some other surface's idea of "open". An
 * ambient capability with no honest default defaults to off. */

import { getContext, setContext } from "svelte";
import type { CardHandle } from "./cards.svelte";

export type Others = {
  /** The card a handle names, if it is on this wall or one it can see. */
  find(handle: string): CardHandle | null;
  /** Put it in front of you. */
  open(id: string): void;
};

const OTHERS = Symbol("volery:others");

export function provideOthers(o: Others): void {
  setContext<Others>(OTHERS, o);
}

/** What the surface above provides, or null where nothing does. */
export function others(): Others | null {
  return getContext<Others | undefined>(OTHERS) ?? null;
}
