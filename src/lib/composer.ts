/* What a key does in the message field, per view — the composer's pure half.
 *
 * The keys in the field were `App.svelte`'s `onDraftKey`, one ladder read
 * against the window's `onGlobalKey`. They came out with the rest of the
 * composer (`composer.svelte.ts`) when chat view needed a second field over the
 * same draft (`docs/chat-mode.md` §7.3), and the ladder is a table here so the
 * two views' differences are in one place and tested:
 *
 * - **Tab** walks the cards on the wall; in chat view it is focus traversal,
 *   because a sidebar and a thread are things a keyboard moves between.
 * - **Ctrl+Enter** broadcasts to a gathering on the wall; in chat view it is
 *   Enter. Chat view has one conversation in front of you, and a broadcast is
 *   the most destructive gesture in the app (`CLAUDE.md`).
 * - **Alt+P** turns plan-first on and off in chat view, where Shift+Tab is
 *   already reverse traversal.
 * - **Escape** with nothing else to close stops a turn in chat view and does
 *   nothing else — it never deselects (which would empty the view) and never
 *   blurs toward a wall that is not there. On the wall it is the window's,
 *   which gives the wall the keyboard back.
 *
 * And one fix, made rather than frozen: the palette's Escape did not stop
 * propagating, so the same press dismissed the palette and blurred the field.
 * The `!` line's Escape already stopped it, for exactly that reason.
 *
 * Which view it is, is read by the composer rather than passed by a surface
 * (`view.svelte.ts`), for the reason the gear is read from the store: a
 * capability handed in is one a future caller forgets. */

export type KeyView = "wall" | "chat";

/** The key, as the table needs it. */
export type Pressed = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

/** What the field is in the middle of. */
export type Mode = {
  /** The draft is a `!` line. */
  banging: boolean;
  /** The shell has offered completions for it. */
  offer: boolean;
  /** There is a card for the line's history to belong to. */
  history: boolean;
  /** The slash palette is up, in either stage. */
  palette: boolean;
  /** A row is lit that Tab could complete. */
  pick: boolean;
};

/** What the key does. `prevent` and `stop` are said here when they hold
 *  whatever the composer then finds; an act whose default depends on the
 *  outcome (`history`, `take`) leaves `prevent` to it. */
export type Act =
  | { act: "offer-move"; by: 1 | -1 }
  | { act: "offer-take" }
  | { act: "offer-close" }
  /** Anything typed invalidates the span the shell answered with. */
  | { act: "offer-drop" }
  | { act: "bang-complete" }
  | { act: "bang-history"; by: 1 | -1 }
  | { act: "bang-leave" }
  | { act: "bang-run"; tell: boolean }
  | { act: "palette-move"; by: 1 | -1 }
  | { act: "palette-off" }
  | { act: "palette-complete" }
  | { act: "cycle"; by: 1 | -1; wide: boolean }
  | { act: "send"; widen: boolean }
  | { act: "plan" }
  | { act: "escape" };

export type Step = Act & { prevent: boolean; stop: boolean };

const bare = (p: Pressed) => !p.ctrl && !p.meta;
const modded = (p: Pressed) => !!(p.ctrl || p.meta);
const arrow = (p: Pressed): 1 | -1 | null =>
  p.key === "ArrowDown" ? 1 : p.key === "ArrowUp" ? -1 : null;

function step(act: Act, prevent: boolean, stop = false): Step {
  return { ...act, prevent, stop };
}

/** What `pressed` does in the field, in `view`, with the field in `mode` — or
 *  null when the key is the field's own (typing) or the window's. */
export function keyFor(view: KeyView, p: Pressed, mode: Mode): Step | null {
  /* A shell line borrows the palette's keys and is asked first; the two are
     never both up (one needs a leading slash, the other a leading bang). */
  if (mode.banging) {
    if (mode.offer) {
      const by = arrow(p);
      if (by && bare(p)) return step({ act: "offer-move", by }, true);
      /* Enter *completes* rather than running: the popup is for choosing what
         to type, and a half-written path is the one moment you certainly did
         not mean to run anything. Tab agrees. */
      if (p.key === "Enter" || p.key === "Tab") return step({ act: "offer-take" }, true);
      if (p.key === "Escape") return step({ act: "offer-close" }, true, true);
      if (p.key.length === 1 || p.key === "Backspace" || p.key === "Delete") {
        return step({ act: "offer-drop" }, false);
      }
    }
    if (p.key === "Tab") return step({ act: "bang-complete" }, true);
    const by = arrow(p);
    if (by && bare(p) && mode.history) return step({ act: "bang-history", by }, false);
    /* One step back out: leaves the shell line and keeps the text. Stopped, or
       the window would blur the field on the same press. */
    if (p.key === "Escape") return step({ act: "bang-leave" }, true, true);
    /* Ctrl widens what the key reaches, and a run's other reach is the agent. */
    if (p.key === "Enter" && !p.shift) return step({ act: "bang-run", tell: modded(p) }, true);
  }

  /* The palette borrows four keys while it is open and gives them back the
     moment it closes. Bare arrows only — ctrl+arrow scrolls the reading. */
  if (mode.palette) {
    const by = arrow(p);
    if (by && bare(p)) return step({ act: "palette-move", by }, true);
    /* The text stays — a draft beginning with a slash is an ordinary thing to
       say to an agent. And stopped here, which it was not: the window then
       blurred the field on the same press. */
    if (p.key === "Escape") return step({ act: "palette-off" }, true, true);
    if (p.key === "Tab" && mode.pick) return step({ act: "palette-complete" }, true);
  }

  if (view === "wall") {
    /* Tab reaches the wall from inside the field: write to one card, then step
       to the next without going by way of the mouse. */
    if (p.key === "Tab") return step({ act: "cycle", by: p.shift ? -1 : 1, wide: modded(p) }, true);
    if (p.key === "Enter" && !p.shift) return step({ act: "send", widen: modded(p) }, true);
    return null;
  }

  /* Chat view. Tab is the browser's: focus traversal. */
  if (p.key === "Enter" && !p.shift) return step({ act: "send", widen: false }, true);
  if (p.alt && !p.ctrl && !p.meta && (p.key === "p" || p.key === "P")) {
    return step({ act: "plan" }, true);
  }
  if (p.key === "Escape") return step({ act: "escape" }, true, true);
  return null;
}
