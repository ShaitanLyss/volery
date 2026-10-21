/* What a person reads for a card named by its handle.
 *
 * A handle is the first eight characters of a card's id (`relay::handle_of`),
 * and it is how cards address each other: short, unique, and stable across a
 * rename. It is the right thing for an agent to type and the wrong thing for a
 * person to read, because it names nothing — to know who `6f90401a` is you go
 * and look it up. Lyss, 2026-10-21, after the relay arrows: *"also some ids are
 * still showing raw"*, with a letter headed `NOVA Coordinator · sent this
 * conversation a message · 6f90401a · 28s ago`.
 *
 * This is the one rule every surface that draws a card by handle follows, so a
 * letter, a plate, the billboard and the away pile cannot come to say the same
 * card three ways. In order:
 *
 * 1. **The card as the wall knows it now** — on this wall, on another one, or
 *    closed but still in the store. Its current title, since a card is renamed
 *    as its work clarifies and the title it had when it wrote is history.
 * 2. **The name the source carried**, when the wall knows nothing: a relay's
 *    envelope quotes the sender's title, a notice from another wall brings its
 *    own wall's name for it, a gate run stored the name with the row. True when
 *    it was written, which is the best thing left.
 * 3. **"a card no longer on the wall"**, said honestly, rather than the handle.
 *
 * The handle is never the visible text. It is the copyable detail — a tooltip,
 * `handleTip` — because that is where it is useful: to paste to an agent.
 *
 * Pure. `whois.svelte.ts` is the reactive half that knows where to look. */

import { cardName } from "./naming";

/** What is said for a card nothing on this wall can name. */
export const GONE = "a card no longer on the wall";

/** A card as far as somebody has seen it: its title, and whether it has since
 *  been closed — which changes nothing about what it is called. */
export type Sighting = { title: string; closed?: boolean } | null;

/** The words for a card: what the wall saw, else what the source said, else
 *  `GONE`. An untitled card the wall *does* know is still a known card, so it
 *  is called what every other surface calls one (`cardName`'s fallback). */
export function whoIs(seen: Sighting, said?: string | null): string {
  if (seen) return cardName(seen.title, "").text || "a new conversation";
  const s = said?.trim();
  return s ? s : GONE;
}

/** The detail a name carries for whoever wants the handle itself — to paste to
 *  an agent, which is the one reader it is for. */
export function handleTip(handle: string): string {
  return `card ${handle}`;
}

/** A card's handle from its id — this wall's uuid, or another wall's
 *  `elsewhere:<host>:<card>` key, whose handle is its own card id's. Must
 *  agree with `relay::handle_of`. */
export function shortHandle(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1).slice(0, 8);
}

/** Whether an address an agent wrote is a card's id or handle rather than a
 *  title or a broadcast word: eight to thirty-six hex characters and dashes,
 *  the shape `relay.rs`'s `resolve` reads as an id. */
export function isCardAddress(address: string): boolean {
  return /^[0-9a-f]{8}(?:[0-9a-f-]{0,28})$/.test(address.trim().toLowerCase());
}
