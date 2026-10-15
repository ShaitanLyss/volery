/* Which card's last message is being glanced at, and from where — one at a
 * time, for the whole window.
 *
 * Ambient rather than a prop, on CLAUDE.md's rule for a capability every
 * surface should have: a card face and a question both reach it by importing
 * this, and the root says once how a card id becomes a card
 * (`provide`). A root that never says so — the peek window draws cards and has
 * no glance — answers `can` with false, so the button is not drawn there
 * rather than drawn dead. That is the honest default: off.
 *
 * Opening one moves nothing else. The ring, the selection and the panel stay
 * where they were, which is the whole of why a glance exists beside clicking
 * the card. */

import type { CardHandle } from "./cards.svelte";
import { hasSaid, type Box } from "./glance";

type Find = (id: string) => CardHandle | null;

class Glance {
  #find = $state.raw<Find | null>(null);
  /** The card being read, or null while nothing is open. */
  id = $state<string | null>(null);
  /** Where it was opened from, in client pixels, read once on open. */
  anchor = $state.raw<Box | null>(null);
  /** Opened from the keyboard, so the reading takes the focus and the keys
   *  that scroll it — and gives it back when it closes. A click leaves the
   *  focus where it was: you may be halfway through typing an answer. */
  keyed = $state(false);
  #before: HTMLElement | null = null;

  /** Set once by the root. */
  provide(find: Find): void {
    this.#find = find;
  }

  /** Whether anything here can open one at all. */
  get ready(): boolean {
    return this.#find !== null;
  }

  /** The card a glance is open on, resolved now — so a card that closes
   *  under an open glance takes the glance with it. */
  get card(): CardHandle | null {
    return this.id ? (this.#find?.(this.id) ?? null) : null;
  }

  /** Whether a glance at `id` would show anything. */
  can(id: string | null | undefined): boolean {
    if (!id || !this.#find) return false;
    const c = this.#find(id);
    return !!c && hasSaid(c.face);
  }

  /** Open it on `id`, beside `from`. A second open on the same card from the
   *  same gesture closes it, which is what pressing a toggle twice means. */
  open(id: string, from: Element | null, keyed = false): boolean {
    if (this.id === id && !keyed) {
      this.close();
      return true;
    }
    const c = this.#find?.(id);
    if (!c) return false;
    /* What a panel opened on it would read: the scrollback off disk for a card
       here (once, and normally already done at launch), and for a card on
       another wall its tail — it has one line of what it said until then, and
       the glance is a gesture asking for exactly the rest. */
    c.history();
    if (!hasSaid(c.face)) return false;
    const r = from?.getBoundingClientRect();
    this.anchor = r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
    this.#before = keyed ? (document.activeElement as HTMLElement | null) : null;
    this.keyed = keyed;
    this.id = id;
    return true;
  }

  close(): void {
    if (this.id === null) return;
    this.id = null;
    this.anchor = null;
    const back = this.#before;
    this.#before = null;
    if (this.keyed && back?.isConnected) back.focus();
    this.keyed = false;
  }
}

export const glance = new Glance();
