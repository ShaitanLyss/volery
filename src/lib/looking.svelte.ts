/* Looking at a picture full size.
 *
 * A picture in the transcript is drawn to fit the column, and the column is a
 * third of the window — so a screenshot's labels and a diagram's small print
 * are drawn smaller than anybody can read. Enter or a click on one opens it
 * here, over everything, at the size it is and with room to look closer.
 *
 * One lightbox for the window, and it mounts itself. A picture can be drawn
 * from three places that are not the root — the transcript, a question in the
 * dock, a card's last message kept on the wall — and the third is inside the
 * wall's zoomed, translated layer, where `position: fixed` would be measured
 * against the layer rather than the window. So the overlay is mounted into the
 * studio root, the one box every centred dialog in the app is placed against
 * (`contain: layout` while spread over several screens, which is what keeps it
 * on the home screen rather than straddling all of them). Mounted on first use
 * rather than from `App.svelte`, so nothing that draws pictures has to be
 * threaded a prop to reach it — "a capability every surface should have is not
 * a prop" (CLAUDE.md).
 */

import { mount, unmount } from "svelte";
import Lightbox from "./Lightbox.svelte";

export type Lit = {
  /** What the `<img>` draws — a `data:` URL, already validated. */
  url: string;
  /** The picture's own size in pixels. */
  w: number;
  h: number;
  /** A vector picture: its size is CSS pixels, and it is sharp at any zoom. */
  svg: boolean;
  /** Drawn on a white page, as in the column — see `InlinePicture`'s `paper`. */
  paper: boolean;
  /** What it is called, for the bar and for a screen reader. */
  name: string;
  alt: string;
  caption?: string;
  /** Opening the file it came from, when there is one and this surface may
   *  reach the disk: the viewer, or Explorer. */
  go?: ((how: "open" | "reveal") => void) | null;
};

class Shown {
  current = $state<Lit | null>(null);
  /** Where focus goes back to: whatever opened it. */
  #from: HTMLElement | null = null;
  #host: { el: Element; app: Record<string, unknown> } | null = null;

  open(lit: Lit, from?: HTMLElement | null) {
    this.#ensure();
    this.#from = from ?? (document.activeElement as HTMLElement | null);
    this.current = lit;
  }

  close() {
    this.current = null;
    const back = this.#from;
    this.#from = null;
    /* After the overlay has gone, or focus lands on a node being removed. */
    requestAnimationFrame(() => {
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
  }

  #ensure() {
    const root = document.querySelector(".studio") ?? document.body;
    if (this.#host?.el === root && root.isConnected) return;
    /* The studio was drawn again (a hot reload in development), so the old
       mount is in a detached tree and is let go of. */
    if (this.#host) {
      try {
        void unmount(this.#host.app);
      } catch {}
    }
    this.#host = { el: root, app: mount(Lightbox, { target: root, props: { shown: this } }) };
  }
}

export const lightbox = new Shown();
export type { Shown };
