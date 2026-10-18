/* Which view the window opens on — the wall or chat — decided purely.
 *
 * `docs/chat-mode.md` §7.7. The choice is per install and lives in
 * `localStorage` (`skein.view.v1`), beside the berth and the motion setting:
 * a view is a fact about this machine and this person's habits, and carrying
 * it in the database to another machine would carry the wrong answer — the
 * wall on a desktop and chat on a laptop is a perfectly good arrangement.
 *
 * Three rules, in order:
 *
 * 1. **A stored choice wins.**
 * 2. **An install that has never held a conversation and has no projects**
 *    asks, on the first-launch screen (§6.9) — but only once the store has
 *    loaded, since before that "never held a conversation" and "not read yet"
 *    are the same reading and the question would flash at an existing wall on
 *    every launch; and never while the control surface drives the window
 *    unless a test asked, or every lab (a fresh store, a fresh profile) would
 *    open on it.
 * 3. **Otherwise the wall**, which is every existing install.
 *
 * Tested in `test/viewmode.test.ts`. */

export type View = "wall" | "chat";

/** How much of an agent's work the thread shows (§6.4): the live parts, which
 *  Lyss chose, or all of it. */
export type Density = "live" | "open";

/** What is stored. */
export type ViewState = {
  view: View;
  density: Density;
  /** The sidebar is shown. */
  sidebar: boolean;
  /** The side pane is open. */
  pane: boolean;
};

export const VIEW_KEY = "skein.view.v1";

export const DEFAULT_STATE: ViewState = { view: "wall", density: "live", sidebar: true, pane: false };

/** What was stored, made drawable — or null when nothing was, or what was is
 *  not a choice anybody made. A field that does not parse falls back to its
 *  default rather than throwing the whole choice away: a newer build's extra
 *  knob, or one renamed, must not reopen the first-launch question. */
export function readState(raw: string | null): ViewState | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.view !== "wall" && o.view !== "chat") return null;
  return {
    view: o.view,
    density: o.density === "open" ? "open" : "live",
    sidebar: typeof o.sidebar === "boolean" ? o.sidebar : DEFAULT_STATE.sidebar,
    pane: typeof o.pane === "boolean" ? o.pane : DEFAULT_STATE.pane,
  };
}

/** What the window opens on: a view, the first-launch question, or — while the
 *  store is still loading — nothing yet. */
export type Opening = View | "welcome" | null;

export function opening(input: {
  stored: ViewState | null;
  /** Whether the store has been read (`skein.loaded`). */
  loaded: boolean;
  /** Conversations this install holds, open or closed, and projects. */
  conversations: number;
  projects: number;
  /** The control surface is driving the window. */
  driven: boolean;
  /** A test asked for the first-launch screen regardless. */
  askWelcome?: boolean;
}): Opening {
  if (input.stored) return input.stored.view;
  if (!input.loaded) return null;
  const fresh = input.conversations === 0 && input.projects === 0;
  if (fresh && (!input.driven || input.askWelcome)) return "welcome";
  return "wall";
}
