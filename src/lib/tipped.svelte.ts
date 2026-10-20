/* Which full title is showing, and the attachment that asks for one.
 *
 * One tip for the window, because the pointer is in one place: a store rather
 * than a tip per surface, so `Tooltip.svelte` is mounted once at the root and
 * any surface that cuts a title short gets the whole of it by attaching
 * `fullTitle` — nothing to thread, nothing to forget but the attachment itself.
 * The rule (`cutShort`) and the placement are `tip.ts`'s. Named apart from the
 * component by more than a capital, since this disk folds case
 * (`notice.md`, the glance store). */

import type { Attachment } from "svelte/attachments";
import { cutShort, TIP_SETTLE_MS } from "./tip";

type Showing = {
  text: string;
  at: { left: number; top: number; bottom: number };
  /** The element that asked, so only it can take its own tip down. */
  by: HTMLElement;
};

class Tipped {
  now = $state<Showing | null>(null);

  show(s: Showing) {
    this.now = s;
  }

  /** Take it down — only the tip `by` put up, when named. */
  hide(by?: HTMLElement) {
    if (!this.now || (by && this.now.by !== by)) return;
    this.now = null;
  }
}

export const tipped = new Tipped();

/** Show the whole of a title when the pointer settles on `el` and the title
 *  was cut short. `text` is read when the tip goes up, never while attaching,
 *  so a title changing does not re-run this. `measure` picks the truncating
 *  element inside `el` — a card is hovered as a whole and cut at its title —
 *  and defaults to `el` itself. */
export function fullTitle(
  text: () => string,
  measure: (el: HTMLElement) => HTMLElement | null = (el) => el,
): Attachment<HTMLElement> {
  return (el) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = (e: PointerEvent) => {
      /* A press in progress is a drag, not a rest; and once the tip is up a
         pointer moving over the same card is still on it. */
      if (e.buttons !== 0 || tipped.now?.by === el) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        const t = measure(el);
        if (!el.isConnected || !t || !cutShort(t)) return;
        const r = t.getBoundingClientRect();
        tipped.show({ text: text(), at: { left: r.left, top: r.top, bottom: r.bottom }, by: el });
      }, TIP_SETTLE_MS);
    };
    const leave = () => {
      clear();
      tipped.hide(el);
    };
    el.addEventListener("pointerenter", arm);
    el.addEventListener("pointermove", arm);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", leave);
    return () => {
      leave();
      el.removeEventListener("pointerenter", arm);
      el.removeEventListener("pointermove", arm);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", leave);
    };
  };
}
