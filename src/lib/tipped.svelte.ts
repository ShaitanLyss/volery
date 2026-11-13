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
  return tipOn(text, measure, (t) => cutShort(t));
}

/** **The wall's tip, for anything that would otherwise carry a native
 *  `title`.** Lyss, 2026-11-13: *"I want no plain html tooltips, they should
 *  all use custom volery components and styles"*. A native title is the
 *  browser's box in the system's face, after the system's delay; this is the
 *  one `Tooltip.svelte` draws, at the same settle as a cut-short title.
 *
 *  Unlike `fullTitle` it shows whether or not anything is cut, because what it
 *  carries is an explanation rather than a repeat: which command a button runs,
 *  what a numeral counts. The site keeps an `aria-label` where the title was
 *  the only accessible name, since this attachment draws nothing for a screen
 *  reader.
 *
 *  `text` is read when the tip goes up, so a title that changes does not
 *  re-run the attachment — the reason `fullTitle` takes a function too. */
export function tipOf(
  text: string | null | undefined | (() => string | null | undefined),
): Attachment<HTMLElement> {
  const read =
    typeof text === "function" ? () => text() ?? "" : () => text ?? "";
  return tipOn(read, (el) => el, () => true);
}

/** The one arm-and-show, shared by the two above so the settle, the drag guard
 *  and the teardown cannot come to differ. `want` is asked of the measured
 *  element when the pointer settles. */
function tipOn(
  text: () => string,
  measure: (el: HTMLElement) => HTMLElement | null,
  want: (t: HTMLElement) => boolean,
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
        const said = text();
        if (!el.isConnected || !t || !said || !want(t)) return;
        const r = t.getBoundingClientRect();
        tipped.show({ text: said, at: { left: r.left, top: r.top, bottom: r.bottom }, by: el });
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
