/* A timeline as a widget: where its plate stands, when the wall puts one up and
 * takes it down, and when a finished one goes to the archive by itself.
 *
 * The plan is not here and never will be. `timeline.rs` owns it — the tools
 * write it, a close archives it, a pick-up hands it back — and a plan the agent
 * keeps current cannot live in `widget.config_json`, which Rust never reads.
 * What a widget adds is the *housing*: where the plate is, on the wall or the
 * glass, which variant it wears, the frame it has, the one selection and undo
 * for the moves you make. So a timeline widget carries its timeline's id in its
 * config (`PLAN`), the way a pinned last message carries its card (`tether.ts`),
 * and everything else about it is a widget's.
 *
 * **The wall puts the housing up, and takes it down.** An agent draws a plan;
 * nobody hangs one. So a shown timeline with no housing is given one, unrecorded
 * — the undo stack is for what you did — and a housing whose timeline has left
 * the glass comes down the same way. `unhoused` and `evicted` are those two
 * questions, asked of the two lists side by side.
 *
 * **Three places to stand, and the stack is the one you did not choose.** A plan
 * nobody has moved hangs in the stack at the top of the home screen, which is
 * where every timeline has always arrived; dragged out of it, it is on the glass
 * at a spot; put on the wall, it stands in the room like any other instrument.
 * The stack is the only one of the three that is not a decision, so it is the
 * only one a finished plan leaves by itself (`archiveDue`) — the `aside` rule,
 * where a deliberate keep silences the neglect clock.
 *
 * Pure, and tested in `test/plates.test.ts`. Shaped like a widget rather than
 * importing one, so this file stays below the catalogue (`widgets.ts` imports
 * `PLAN` from here, as it imports `TETHER` from `tether.ts`). See
 * `.claude/rules/timeline.md`, "A plate is a widget". */

/** The config key a plate's timeline id rides in. In the config rather than a
 *  column for `config_json`'s reason: Rust never hears about a kind of widget,
 *  and the housing is the front end's to make and to take down. */
export const PLAN = "timeline";

/** Whether a plate stands on the wall, written by the gesture that put it
 *  there. A state key rather than a knob: it is where the plate *is*, which the
 *  menu offers as moves, not as a setting with a dot beside it.
 *
 *  It only speaks when the plate has no glass spot. A spot wins — the glass is
 *  in front of the wall — and the flag says where the plate goes when the spot
 *  is taken away: back onto the wall it came from, or back into the stack. That
 *  is also what makes a screen arrangement honest about a plate: walking into a
 *  room where it was never stuck finds no spot, and a plate that came out of
 *  the stack goes back into it there, as a timeline always has. */
export const WALL = "wall";

/** Whether somebody has ever moved this plate out of the stack by hand. A
 *  state key, written by the move, and the thing the archive asks rather than
 *  where the plate happens to stand: a plate dragged onto the glass in one
 *  screen arrangement is in the stack in a room where it was never stuck, and
 *  "a plate you moved is a plate you kept" has to hold in every room, or
 *  plugging in a monitor would archive what you kept (found in review). Only
 *  putting it back in the stack by hand — `toStack` — makes it the wall's to
 *  tidy again. */
export const KEPT = "kept";

/** When a finished plate in the stack goes to the archive by itself. */
export const ARCHIVE = "archive";

/** The archive knob's values, in minutes. `never` is the way to keep finished
 *  plans in the stack for good. */
export const ARCHIVE_AFTER = ["never", "5", "10", "15"] as const;

/** Ten minutes: long enough to have looked at what a plan came to, short enough
 *  that a wall of ten cards finishing their work is not a wall of ten finished
 *  plates. Safe at that length only because the archive is recoverable — the
 *  Annals hold every plate, and hanging one back up is one press. */
export const ARCHIVE_DEFAULT = "10";

/** Where a plate stands. */
export type Hang = "stack" | "glass" | "wall";

/** As much of a widget as any of this reads. */
type Held = {
  id: string;
  kind?: string;
  glassX: number | null;
  glassY: number | null;
  config: Record<string, unknown>;
};

/** The timeline this plate draws, or null for a widget that is not a plate —
 *  or a plate of nothing, which `normalizeWidget` refuses to draw. */
export function planOf(w: Pick<Held, "config">): string | null {
  const v = w.config[PLAN];
  return typeof v === "string" && v ? v : null;
}

/** Where it stands: a spot on the glass wins, then the wall flag, and a plate
 *  with neither is in the stack. */
export function hangOf(w: Pick<Held, "glassX" | "glassY" | "config">): Hang {
  if (w.glassX !== null && w.glassY !== null) return "glass";
  return w.config[WALL] === 1 ? "wall" : "stack";
}

/* ── moving one ─────────────────────────────────────────────────────────── */

/** What a widget is patched with to move it. Shaped as a `Partial<Widget>` so
 *  the registry can write it through its ordinary update, and so a move is
 *  recorded the way every other widget move is. */
export type Move = {
  x?: number;
  y?: number;
  glassX: number | null;
  glassY: number | null;
  config: Record<string, unknown>;
};

/** Back into the stack: no spot, not on the wall, and the wall's to tidy
 *  again — putting it back there is the one gesture that gives up the keep. */
export function toStack(w: Pick<Held, "config">): Move {
  return { glassX: null, glassY: null, config: { ...w.config, [WALL]: 0, [KEPT]: 0 } };
}

/** Onto the wall, standing at `at` in canvas units. */
export function toWall(w: Pick<Held, "config">, at: { x: number; y: number }): Move {
  return {
    x: at.x,
    y: at.y,
    glassX: null,
    glassY: null,
    config: { ...w.config, [WALL]: 1, [KEPT]: 1 },
  };
}

/** Onto the glass at a spot. The wall flag is left as it is: it is where the
 *  plate goes when the spot is taken away, and a plate stuck from the wall
 *  should go back to the wall, one dragged out of the stack back to the stack. */
export function toGlass(w: Pick<Held, "config">, at: { x: number; y: number }): Move {
  return { glassX: at.x, glassY: at.y, config: { ...w.config, [KEPT]: 1 } };
}

/** Whether a plate has been kept — moved out of the stack by hand. */
export function keptOf(w: Pick<Held, "config">): boolean {
  return w.config[KEPT] === 1;
}

/** The config a write leaves a plate with: any spot written onto it — a drag
 *  out of the stack, which goes through the carry and not through `toGlass` —
 *  is a keep. Answers the config unchanged for anything else, so the registry
 *  can ask it of every write without knowing what a plate is. */
export function keepOnSpot<C extends Record<string, unknown>>(
  config: C,
  patch: { glassX?: number | null; glassY?: number | null },
): C {
  if (config[PLAN] === undefined || config[KEPT] === 1) return config;
  if (patch.glassX == null || patch.glassY == null) return config;
  return { ...config, [KEPT]: 1 };
}

/* ── putting housings up and taking them down ──────────────────────────── */

/** The timelines on the glass that no plate draws yet, in the order given —
 *  which is the order they were drawn, and so the order the stack reads in. */
export function unhoused(shown: readonly string[], ws: readonly Held[]): string[] {
  const housed = new Set(ws.map(planOf).filter((p): p is string => p !== null));
  return shown.filter((id) => !housed.has(id));
}

/** The plates whose timeline is no longer on the glass — archived, left, or
 *  gone from the store — and any second plate of one timeline, which nothing
 *  makes and a race could. The first plate of a timeline is the one kept.
 *
 *  Asked only after the timelines have been read *successfully*: a store that
 *  could not be read is not a wall where every plan has been archived. */
export function evicted<W extends Held>(ws: readonly W[], shown: ReadonlySet<string>): W[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const id = planOf(w);
    if (id === null) return false;
    if (!shown.has(id) || seen.has(id)) return true;
    seen.add(id);
    return false;
  });
}

/** Where a plate goes when it is first put up: in the stack — unless the
 *  timeline carries a spot of its own on the glass, written by the build that
 *  drew plates on a layer rather than as widgets. That is the whole of the
 *  carrying over: a plate somebody had dragged off the stack before this is
 *  still where they left it, and one nobody had moved is still in the stack. */
export function seedOf(t: { glassX: number | null; glassY: number | null }): {
  glassX: number | null;
  glassY: number | null;
} {
  return t.glassX !== null && t.glassY !== null
    ? { glassX: t.glassX, glassY: t.glassY }
    : { glassX: null, glassY: null };
}

/** Whether an undo record is about a plate that has been taken down. Moves of a
 *  plate are on the stack like any widget's, and undoing one after its plan
 *  was archived would hang a housing of nothing back up — which the next
 *  reconcile would take straight back down, a press spent on nothing. Shaped
 *  like an `Edit`, so this file stays below the stack. */
export function plateOfGone(e: { at: string; id: string }, gone: ReadonlySet<string>): boolean {
  return e.at === "widget" && gone.has(e.id);
}

/* ── the stack ──────────────────────────────────────────────────────────── */

/** How far below the top of the home screen the stack hangs, and the gap
 *  between two plates in it — the numbers the old layer's flex column had. */
export const STACK_TOP = 14;
export const STACK_GAP = 12;

/** Where each plate in the stack is drawn: a column centred on the home
 *  screen, top first, in the order given. Laid out by hand rather than by a
 *  flex column so a stacked plate is drawn exactly as every other thing on the
 *  glass is — a widget at a position — and a drag out of the stack starts from
 *  where it was drawn, with nothing in between to keep in step.
 *
 *  The home screen rather than the whole pane: while the studio is spread a
 *  default centred across every screen hangs on the seam between two monitors.
 *  A plate whose size has not been measured yet is laid out at the size it was
 *  given, and lands where it belongs on the next frame. */
export function stackAt(
  home: { x: number; y: number; w: number },
  plates: readonly { id: string; w: number; h: number }[],
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  let y = home.y + STACK_TOP;
  for (const p of plates) {
    out[p.id] = { x: Math.round(home.x + (home.w - p.w) / 2), y: Math.round(y) };
    y += p.h + STACK_GAP;
  }
  return out;
}

/* ── going to the archive by itself ─────────────────────────────────────── */

/** How long after it finished a plate in the stack waits, or null for never.
 *  Anything the knob cannot read is the default, not "never" — a plan that
 *  never leaves is a stack that only grows. */
export function archiveAfter(config: Record<string, unknown>): number | null {
  const v = config[ARCHIVE];
  const pick = typeof v === "string" && (ARCHIVE_AFTER as readonly string[]).includes(v) ? v : ARCHIVE_DEFAULT;
  if (pick === "never") return null;
  return Number(pick) * 60_000;
}

/** Whether a finished plate goes to the archive now.
 *
 *  **Only from the stack.** A plate you moved — onto the glass at a spot, or
 *  onto the wall — is a plate you kept, and nothing takes down what you kept.
 *
 *  **Counted from the later of finishing and the last moment it had your
 *  attention.** Attention is the plate under the pointer or the plate selected,
 *  and being away (`presence.svelte.ts`) holds the clock for as long as it
 *  lasts — so a plan that finished over lunch is still there when you are back,
 *  for ten minutes of being on the wall rather than ten minutes of an empty
 *  room. *Not* the window being out of front: a wall on a second monitor is
 *  being seen while you type into an editor, and a clock that only ran with
 *  the window focused would never run there at all. Restarting rather than
 *  pausing: every read buys the whole delay again, which is the more forgiving
 *  of the two and the one with nothing to remember. */
export function archiveDue(p: {
  state: string;
  endedAt: number | null;
  updatedAt: number;
  hang: Hang;
  /** Moved out of the stack by hand at some point — see `KEPT`. */
  kept: boolean;
  after: number | null;
  /** The last moment it had attention, or 0 for never. */
  seen: number;
  now: number;
}): boolean {
  if (p.state !== "complete" || p.hang !== "stack" || p.kept || p.after === null) return false;
  const from = Math.max(p.endedAt ?? p.updatedAt, p.seen);
  return p.now - from >= p.after;
}
