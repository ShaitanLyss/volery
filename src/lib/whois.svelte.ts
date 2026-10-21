/* Where `whois.ts` looks: the cards on this wall and on every other one, and —
 * asked of the store, once per handle — the ones that have been closed.
 *
 * A singleton rather than a context, because half of what draws a card's name
 * is not a component: the billboard's `author`, a gate's `who`, the line a send
 * call folds into. It is told where the cards are (`attach`, from `App.svelte`,
 * the injection `finder.where` and `devops.roots` use) rather than reaching for
 * them, and **until it is told it knows nothing** — every card is then said by
 * what its source carried, or as `GONE`, never as a handle. An ambient
 * capability with no honest default defaults to off (CLAUDE.md).
 *
 * The closed cards are the one thing that costs a round trip, so it is paid
 * once: a handle the wall cannot see is queued, a render's worth is asked in
 * one `card_titles` call, and the answer — a name or a definite nothing — is
 * kept for the life of the window. A closed card does not get renamed, and a
 * card that is not in the store will not appear in it under an old handle. */

import { invoke } from "@tauri-apps/api/core";
import { SvelteMap } from "svelte/reactivity";
import type { CardHandle } from "./cards.svelte";
import { cardByHandle } from "./chatview";
import { describeTool, NAMES_A_CARD } from "./classify";
import type { Line } from "./conversation.svelte";
import { GONE, isCardAddress, shortHandle, whoIs, type Sighting } from "./whois";

/** What the reactive half needs of the wall: a card by id, and every id. */
export type Roll = { find(id: string): CardHandle | null; readonly all: CardHandle[] };

/** How long a render's worth of unknown handles is gathered before one ask. */
const GATHER_MS = 40;

class Whois {
  #roll: Roll | null = null;
  /** handle → what the store said: a name, or null for "not in it". */
  #stored = new SvelteMap<string, { title: string; closed: boolean } | null>();
  #waiting = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Tell it where the cards are. `App.svelte`, once. */
  attach(roll: Roll | null): void {
    this.#roll = roll;
  }

  /** Let go of a roll, if it is still the one held — a superseded App
   *  generation's teardown must not detach the generation that replaced it. */
  detach(roll: Roll): void {
    if (this.#roll === roll) this.#roll = null;
  }

  /** The card an id or a handle names on a wall this one can see, if any. */
  card(idOrHandle: string): CardHandle | null {
    const roll = this.#roll;
    if (!roll || !idOrHandle) return null;
    const exact = roll.find(idOrHandle);
    if (exact) return exact;
    const id = cardByHandle(shortHandle(idOrHandle.trim().toLowerCase()), roll.all.map((c) => c.id));
    return id ? roll.find(id) : null;
  }

  /** What the wall has seen of a card, asking the store about one it cannot
   *  see. Reactive: a component reading it redraws when the answer lands. */
  sighting(idOrHandle: string): Sighting {
    const c = this.card(idOrHandle);
    if (c) return { title: c.face.title };
    /* A far card's key that its wall has stopped carrying is not in this
       store; neither is anything that is not shaped like a card's id. */
    if (!isCardAddress(idOrHandle)) return null;
    const handle = shortHandle(idOrHandle.trim().toLowerCase());
    const stored = this.#stored.get(handle);
    if (stored === undefined) this.#ask(handle);
    return stored ?? null;
  }

  /** What the store alone says of a handle — a card this wall can no longer
   *  see but whose row is still there — asking it the first time. Undefined
   *  until it has answered, null for "no such card". For prose, where only a
   *  handle the store confirms may be drawn as a card. */
  stored(handle: string): { title: string; closed: boolean } | null | undefined {
    if (!isCardAddress(handle)) return null;
    const h = shortHandle(handle.trim().toLowerCase());
    const got = this.#stored.get(h);
    if (got === undefined) this.#ask(h);
    return got;
  }

  /** The words for a card named by id or handle — see `whois.ts` for the order.
   *  `said` is the name its source carried, if any. */
  name(idOrHandle: string, said?: string | null): string {
    return whoIs(this.sighting(idOrHandle), said);
  }

  /** An address an agent wrote, as a person reads it: a card's handle or id
   *  becomes that card's name; a title, a broadcast word or anything else is
   *  left as written, since it already says what it means. */
  address(to: string): string {
    return isCardAddress(to) ? this.name(to) : to;
  }

  #ask(handle: string): void {
    if (this.#waiting.has(handle)) return;
    this.#waiting.add(handle);
    this.#timer ??= setTimeout(() => void this.#flush(), GATHER_MS);
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    const handles = [...this.#waiting];
    this.#waiting.clear();
    if (!handles.length) return;
    try {
      const named = await invoke<{ handle: string; title: string; closed: boolean }[]>("card_titles", { handles });
      const got = new Map(named.map((n) => [n.handle, n]));
      for (const h of handles) {
        const n = got.get(h);
        this.#stored.set(h, n ? { title: n.title, closed: n.closed } : null);
      }
    } catch {
      /* A failed ask is not an answer (`known.ts`'s rule): nothing is recorded,
         so the next render asks again rather than pinning the card to GONE. */
    }
  }
}

export const whois = new Whois();

/** A tool line's words as they should read now. The text a line was folded
 *  with is frozen at the fold, and a call that named a card by handle was
 *  folded before the store could say what a closed card was called — so it
 *  read "messaged a card no longer on the wall" about a card the store knew
 *  (found in the lab, 2026-10-21). Only the tools that name a card are
 *  re-described, from the call's own arguments; reading `whois` here is what
 *  redraws the line when the store's answer lands. */
export function lineText(line: Line): string {
  const call = line.call;
  if (line.kind !== "tool" || !call || !NAMES_A_CARD.has(call.name)) return line.text;
  return describeTool(call.name, call.input, (a) => whois.address(a));
}
export { GONE };
