/* The keeping of replies typed into the dock's queue — the rune and the
 * storage around `replies.ts`, which has the reasoning.
 *
 * One for the window, module-level, because the thing it guards against is a
 * component going away: anything a panel owned would go with the panel. The
 * fields read their text from here and write every keystroke back,
 * synchronously, so a reload or a crash costs nothing that was typed. */
import {
  REPLIES_KEY,
  decodeReplies,
  encodeReplies,
  noted,
  orphans,
  textUnder,
  withReply,
  without,
  type About,
  type Orphan,
  type Replies,
  type Reply,
} from "./replies";

function read(): Replies {
  try {
    return decodeReplies(localStorage.getItem(REPLIES_KEY), Date.now());
  } catch {
    return {};
  }
}

class Keeping {
  #all = $state.raw<Replies>(read());

  /** Items whose reply is on its way. Taken out of the store only once the
   *  send is known to have landed, so a send that fails — the notice already
   *  came down, the card was closed, the other wall refused it — leaves the
   *  words where the dock's "not sent" line finds them. Meanwhile the item has
   *  usually left the queue already (every send here takes it down first), and
   *  this is what stops that line flashing up for a reply merely in flight. */
  #sending = $state.raw<string[]>([]);

  /** Items you closed yourself — sent, acknowledged, deferred — since the
   *  dock last asked. Plain: it is only ever asked, once per departure, by the
   *  dock's own effect (`byYou`). */
  #yours = new Set<string>();

  /** One field's text. */
  text(key: string): string {
    return this.#all[key]?.text ?? "";
  }

  /** Write one field. Every keystroke comes through here. */
  put(key: string, text: string, about: About) {
    const was = this.#all[key];
    if ((was?.text ?? "") === text && (!was || (was.about === about.about && !was.why))) return;
    this.#all = withReply(this.#all, key, text, Date.now(), about);
    this.#save();
  }

  /** Everything kept for an item, joined. */
  of(item: string): string {
    return textUnder(this.#all, item);
  }

  /** The item was answered, or you took it down: its reply is done with. */
  forget(item: string) {
    if (this.#sending.includes(item)) this.#sending = this.#sending.filter((i) => i !== item);
    const next = without(this.#all, item);
    if (Object.keys(next).length === Object.keys(this.#all).length) return;
    this.#all = next;
    this.#save();
  }

  /** Say why a reply is still here — drawn on the "not sent" line. */
  note(item: string, why: string) {
    this.#all = noted(this.#all, item, why);
    this.#save();
  }

  sending(item: string) {
    if (!this.#sending.includes(item)) this.#sending = [...this.#sending, item];
  }

  /** The send came back. Landed, and the reply goes; refused, and it stays,
   *  no longer in flight. */
  settled(item: string, landed: boolean) {
    if (landed) this.forget(item);
    else if (this.#sending.includes(item)) this.#sending = this.#sending.filter((i) => i !== item);
  }

  /** You are closing this item yourself — the panels call it on every
   *  gesture that takes an item away (`Dock.svelte` reads it as `byYou`). */
  closing(item: string) {
    this.#yours.add(item);
  }

  /** Did you close it? Asked once, when it leaves the queue. */
  byYou(item: string): boolean {
    return this.#yours.delete(item);
  }

  /** What the dock hands back — see `replies.ts::orphans`. */
  orphans(live: ReadonlySet<string>, ready: (r: Reply) => boolean): Orphan[] {
    return orphans(this.#all, live, this.#sending, ready);
  }

  #save() {
    try {
      localStorage.setItem(REPLIES_KEY, encodeReplies(this.#all));
    } catch {
      /* A full or refused store keeps the replies for this window's life,
         which is what there was before any of this — never a fault. */
    }
  }
}

export const replies = new Keeping();
