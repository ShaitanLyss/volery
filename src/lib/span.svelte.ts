import { invoke } from "@tauri-apps/api/core";
import { availableMonitors } from "@tauri-apps/api/window";
import type { SpanView } from "./span";

/* Whether the studio is spread over every screen. One for the window, so a
   module-level instance: the button that toggles it (`WindowControls`) and the
   root that lays itself out by it (`App`) are not parent and child. Holds no
   subscription, so it has nothing to release. */
class Span {
  view = $state<SpanView | null>(null);
  /** How many screens there are, last time anyone asked. Spreading over one is
   *  a borderless full screen, which is not what the button promises. */
  screens = $state(1);
  #busy = false;

  async count() {
    try {
      this.screens = (await availableMonitors()).length;
    } catch {
      /* Leaves the last answer. A button that stays is harmless; one that
         flickers away on a transient failure is not. */
      return;
    }
    /* A screen came or went while spread. Rust lets the spread go itself when
       the change moves the window (`window.rs::reassert`); this catches the
       change that moves nothing — a monitor unplugged from beside a window that
       still overlaps the rest — on the next return to the window, since the
       chrome may now be pinned to glass that is not there. */
    if (this.view && this.screens !== this.view.screens.length) await this.toggle();
  }

  /** Rust ended the spread on its own (`window:spread` with nothing). */
  lost() {
    this.view = null;
  }

  async toggle() {
    /* A second press while the first is still moving the window would read the
       half-moved frame as the one to go back to. */
    if (this.#busy) return;
    this.#busy = true;
    try {
      this.view = await invoke<SpanView | null>("span_screens", { on: !this.view });
    } finally {
      this.#busy = false;
    }
  }
}

export const span = new Span();
