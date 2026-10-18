/* Which view the window is drawing: the wall, or chat.
 *
 * One holder for the whole window, read rather than passed: the composer's
 * keys, the menu's rows, `Skein.watching` and the wall's own loops each ask it,
 * for the reason the gear is asked of the store — a view handed in as a prop is
 * one a future surface forgets to hand in, and gets the wall's keys in chat
 * view without a word. `viewmode.ts` decides what the window opens on; this
 * holds it and remembers it.
 *
 * `localStorage`, beside the berth and the motion setting, because a view is
 * per machine and disposable (`docs/chat-mode.md` §7.7): the wall on a desktop
 * and chat on a laptop is a perfectly good arrangement, and the database would
 * carry the choice to the wrong one. */

import { DEFAULT_STATE, readState, VIEW_KEY, type View, type ViewState } from "./viewmode";

class ViewHolder {
  current = $state<View>("wall");
  /** Whether chat view's sidebar is shown. */
  sidebar = $state(true);
  /** Chat view's side pane — plan, files, linked, jobs, side question — is
   *  open. Closed by default: the live parts density (§6.4). */
  pane = $state(false);
  /** What was stored, if anything — `opening` asks whether a choice exists. */
  /** What was chosen and kept — read by the first-launch decision, so a
   *  reactive value: choosing on the welcome screen must take it down. */
  stored = $state.raw<ViewState | null>(null);

  constructor() {
    try {
      this.stored = readState(localStorage.getItem(VIEW_KEY));
    } catch {
      this.stored = null;
    }
    if (this.stored) {
      this.current = this.stored.view;
      this.sidebar = this.stored.sidebar;
      this.pane = this.stored.pane;
    }
  }

  /** Switch, and remember. */
  set(to: View) {
    this.current = to;
    this.save();
  }

  toggle() {
    this.set(this.current === "chat" ? "wall" : "chat");
  }

  save() {
    const next: ViewState = {
      ...(this.stored ?? DEFAULT_STATE),
      view: this.current,
      sidebar: this.sidebar,
      pane: this.pane,
    };
    this.stored = next;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      /* a browser refusing storage costs the choice next launch, nothing more */
    }
  }
}

export const view = new ViewHolder();
