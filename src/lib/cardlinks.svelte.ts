/* A card named in prose, drawn as the card.
 *
 * Agents name cards by handle — `fc5cb712: taking the build`, *recommended by
 * 15555efd* — and every surface drew the eight hex characters as written, so
 * to know who was meant you went and looked the handle up (Lyss, 2026-10-20:
 * *"cards are shown as plain id, instead they should be shown as the card name
 * and clickable … one fix for both"* — the wall and chat view).
 *
 * Ambient, for CLAUDE.md's *a capability every surface should have is not a
 * prop*: `App.svelte` provides it once at the root, so the transcript, a
 * question, a notice, the pile and a letter all have it by existing, and
 * `Inlines.svelte` is the one reader. Chat view provides it again to say what
 * opening a card means there. Absent, a handle is text — never a link that goes
 * nowhere. Only a handle the wall resolves is drawn as a card
 * (`chatview.ts::handlesIn` is shape alone), so a commit hash stays a hash. */

import { getContext, setContext } from "svelte";
import type { CardHandle } from "./cards.svelte";

export type CardLinks = {
  /** The card a handle names, on this wall or another, or null. */
  find(handle: string): CardHandle | null;
  /** Go to it, the way this surface goes to a card. */
  open(card: CardHandle): void;
  /** Bring back a card that has left the wall, from the session it last held
   *  (`Skein.revive`), and go to it. Absent, a closed card's name is text. */
  revive?(session: string): void;
};

const KEY = Symbol("volery:cardlinks");

export function provideCardLinks(links: CardLinks): void {
  setContext<CardLinks>(KEY, links);
}

/** What `Inlines` asks; null where nothing provided it. */
export function useCardLinks(): CardLinks | null {
  return getContext<CardLinks | undefined>(KEY) ?? null;
}
