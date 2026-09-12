/* Taking it back.
 *
 * Every undoable thing on this wall is the same sentence: *this record used to
 * look like that, and now it looks like this*. A widget's config, a card's
 * placement, an image's box, where a territory stands — four realms, one shape.
 * So an `Edit` carries the whole record on both sides rather than a diff, and
 * `null` on a side means it did not exist then. Creating something is an edit
 * from nothing; removing it is an edit to nothing; and undo is the same code
 * for all three because it only ever writes one side of a pair.
 *
 * Whole records rather than diffs is a deliberate cost. A diff is smaller and
 * would be wrong: `widget.config_json` and the rest are opaque JSON read
 * through a normalizer (see CLAUDE.md), so what comes back out is not always
 * key-for-key what went in, and a field-level inverse would fight the
 * normalizer over keys it had rewritten. A snapshot cannot lose that argument.
 *
 * ── what is not here ──────────────────────────────────────────────────────
 *
 * Undo means "the wall looks as it did". It never means "that turn didn't
 * happen". Nothing that left this machine is on the stack — no prompt, no
 * broadcast, no `!` line, no `actions` run, no relay message, no board notice,
 * nothing git. Nor is anything that owns a process: closing a card takes an
 * agent down, and an undo that spawned one back would be starting work nobody
 * asked for, against a session that has already been marked closed.
 *
 * The viewport is not here either, and that is the one most likely to be
 * "fixed" later. Panning and zooming are how you *look* at this wall, not
 * changes to it — a Ctrl+Z that scrolled you somewhere would spend the gesture
 * people press when they want the last thing they did undone.
 *
 * ── and it does not survive a restart ─────────────────────────────────────
 *
 * The stack is this session's. The data it describes is all in SQLite, so
 * persisting it would *work*; it would just be a hazard. An undo you can press
 * on a wall you have not touched yet, that rewinds something you did yesterday
 * and cannot see happening, is a gesture with no context to judge it by. The
 * one consequence that had to be paid for elsewhere: an image's file is no
 * longer deleted with its row, so a removal is undoable — and the orphan that
 * leaves is swept at startup, which is exactly when the stack it was being kept
 * for is gone. See `store::sweep_references`.
 *
 * Pure, and the whole state machine is here: `Past` is a plain value, every
 * function is a pure function of one, and `undo.svelte.ts` only adds the runes
 * and the hands that write the records back. */

/** Which kind of record an edit is about. The id below is that realm's own key
 *  — a conversation id, a widget id, an image id, a project's root path. */
export type Realm = "placement" | "widget" | "image" | "territory";

export type Edit = {
  at: Realm;
  id: string;
  /** The whole record either side of the change. Null means it did not exist. */
  was: unknown;
  now: unknown;
};

/** Where a territory stands, and nothing else about it.
 *
 *  Deliberately not the project row: its name and its path are not things a
 *  gesture on the wall changes, and an undo that wrote them back would be
 *  claiming to own a record it has only ever moved. */
export type Stand = {
  x: number | null;
  y: number | null;
  glassX: number | null;
  glassY: number | null;
  /** How wide it is, in columns of cards — a resize is a gesture on the wall
   *  like the other three, and one that reflows every card standing in it, so
   *  it is exactly the kind of thing a single Ctrl+Z should take back whole. */
  cols: number | null;
};

/** One gesture. Several edits, because one gesture genuinely changes several
 *  records: dragging a territory moves the territory *and* every pinned card
 *  inside it, and tidying the wall moves all of them. Undoing that has to be
 *  one press or the wall comes back in pieces. */
export type Act = { label: string; edits: Edit[]; t: number };

export type Past = {
  done: Act[];
  undone: Act[];
  /** The last thing that happened was a step back or forward, so the head of
   *  `done` is not something a fresh gesture may be fused into.
   *
   *  Time alone nearly does this and not quite: press Ctrl+Z and start dragging
   *  the same card inside the fusing window, and the drag would be folded into
   *  the act you had just stepped past — which then holds a `was` from before
   *  an undo that has already been applied. */
  sealed: boolean;
};

export const NOTHING: Past = { done: [], undone: [], sealed: false };

/** What a record keeper looks like to the things being kept.
 *
 *  `Widgets` and `Board` record their own edits, and this is the whole of what
 *  they are allowed to know about the stack — declared here, in the pure file,
 *  so neither of them has to import a rune to be given one. `Undo` satisfies it
 *  structurally; `NO_SCRIBE` is what they hold until the app hands one over, so
 *  a test that builds a `Widgets` on its own gets a working one. */
export type Scribe = {
  /** One gesture, whole, from a place that knows the gesture is over. */
  did(label: string, edits: Edit[]): void;
  /** One record changing, from a place where the change *is* the gesture. */
  note(at: Realm, id: string, was: unknown, now: unknown, patch: object): void;
};

export const NO_SCRIBE: Scribe = { did() {}, note() {} };

/** How many gestures back you can go. Snapshots are small plain objects, so
 *  this is bounded for the sake of being bounded rather than for memory. */
export const DEPTH = 100;

/** How long two like gestures stay one gesture.
 *
 *  This is the whole reason a continuous drag is one undo step. A widget being
 *  dragged writes its position every frame — the mutation *is* the gesture,
 *  there is no commit point to hang an act on — so the acts arrive ~16ms apart
 *  and fuse into one. Generous enough that a pause mid-drag does not split it,
 *  short enough that two deliberate nudges stay two. Where a gesture *does*
 *  have a commit point of its own (a card dropped, a territory let go, a menu
 *  item clicked) the act is recorded there instead and this never comes up. */
export const FUSE_MS = 700;

/** Deep equality over the plain JSON these snapshots are.
 *
 *  `undefined` and a missing key are the same thing here, because they are the
 *  same thing in the records: `Placement.glassX` is optional and half the
 *  writers spell it out as null while the other half leave it off. Treating
 *  those as different made a gesture that changed nothing look like a change,
 *  which spends an undo press on a step you cannot see. */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => kb.includes(k) && equal(ra[k], rb[k]));
}

/** The same act pointing the other way. Applying an act always writes `now`,
 *  so stepping back is applying the inverse rather than a second code path. */
export function invert(act: Act): Act {
  return {
    ...act,
    edits: act.edits.map((e) => ({ at: e.at, id: e.id, was: e.now, now: e.was })),
  };
}

/** Did nothing, in the end. A card dragged out and back, a knob set to what it
 *  already said. Not an undo step: pressing Ctrl+Z on one of these looks like
 *  the key not working. */
export function trivial(act: Act): boolean {
  return act.edits.every((e) => equal(e.was, e.now));
}

/** Which records an act is about, as one comparable string. */
function shape(act: Act): string {
  return act.edits
    .map((e) => `${e.at} ${e.id}`)
    .sort()
    .join(", ");
}

/** Are these two the same gesture still going on? Same name, same records, and
 *  close enough in time. All three matter: the name keeps a move and a resize
 *  of one widget apart, the records keep two widgets apart, and the clock keeps
 *  this afternoon's nudge out of this morning's. */
export function fusable(a: Act, b: Act, gap = FUSE_MS): boolean {
  if (a.label !== b.label) return false;
  if (b.t < a.t || b.t - a.t > gap) return false;
  return shape(a) === shape(b);
}

/** Two into one: where it started, where it has got to. */
export function fuse(a: Act, b: Act): Act {
  return {
    label: b.label,
    t: b.t,
    edits: b.edits.map((e) => {
      const first = a.edits.find((f) => f.at === e.at && f.id === e.id);
      return first ? { ...e, was: first.was } : e;
    }),
  };
}

/** Write a gesture down. */
export function remember(past: Past, act: Act, depth = DEPTH): Past {
  /* Nothing happened, so nothing is remembered — and the redo stack survives,
     since a gesture that changed nothing has not made a redo stale. */
  if (trivial(act)) return past;

  const head = past.done[past.done.length - 1];
  if (head && !past.sealed && fusable(head, act)) {
    const one = fuse(head, act);
    const rest = past.done.slice(0, -1);
    /* Fusing can cancel a gesture out — dragged away and back again over one
       continuous press. That is not an undo step either. */
    return {
      done: trivial(one) ? rest : [...rest, one],
      undone: [],
      sealed: false,
    };
  }

  const done = [...past.done, act];
  return {
    done: done.length > depth ? done.slice(done.length - depth) : done,
    undone: [],
    sealed: false,
  };
}

/** One step back. The act handed out is already inverted, ready to apply. */
export function rewind(past: Past): { past: Past; act: Act | null } {
  const act = past.done[past.done.length - 1];
  if (!act) return { past, act: null };
  return {
    past: {
      done: past.done.slice(0, -1),
      undone: [...past.undone, act],
      sealed: true,
    },
    act: invert(act),
  };
}

/** One step forward, applied as it was recorded. */
export function replay(past: Past): { past: Past; act: Act | null } {
  const act = past.undone[past.undone.length - 1];
  if (!act) return { past, act: null };
  return {
    past: {
      done: [...past.done, act],
      undone: past.undone.slice(0, -1),
      sealed: true,
    },
    act,
  };
}

/** What each direction would do, for the menu to say out loud. Null where
 *  there is nothing that way — which is what stops the item being offered at
 *  all, rather than offered and inert. */
export function describe(past: Past): { back: string | null; forward: string | null } {
  return {
    back: past.done[past.done.length - 1]?.label ?? null,
    forward: past.undone[past.undone.length - 1]?.label ?? null,
  };
}

/** Drop every mention of a record that has gone for good.
 *
 *  A card closed, a project forgotten. Their edits can never be applied again —
 *  there is nothing left for them to be applied *to* — and left on the stack
 *  they are presses that appear to do nothing, which is worse than a shorter
 *  history. An act emptied this way goes with them. */
export function forget(past: Past, at: Realm, id: string): Past {
  const prune = (acts: Act[]) =>
    acts
      .map((a) => ({
        ...a,
        edits: a.edits.filter((e) => !(e.at === at && e.id === id)),
      }))
      .filter((a) => a.edits.length > 0);
  return { ...past, done: prune(past.done), undone: prune(past.undone) };
}

/* ── territories, which are the one realm you cannot predict ────────────────
 *
 * Reflowing one territory and tidying the whole wall both end in
 * `Skein.#settlePlaces`, which gives a position to anything that has none — so a
 * gesture aimed at one territory can move a neighbour, and what moved is
 * something to *observe* rather than compute. Both callers therefore read the
 * wall, act, and read it again; these two are that pattern, here rather than in
 * either of them because `App.svelte` and the control surface both do it and a
 * second copy would be a second answer. */

/** Where every territory stands. Structurally typed so this file stays free of
 *  `layout.ts` — `Territory` satisfies it, as does a project row. */
export function standsOf(
  projects: {
    root_path: string;
    x?: number | null;
    y?: number | null;
    glassX?: number | null;
    glassY?: number | null;
    cols?: number | null;
  }[],
): Map<string, Stand> {
  return new Map(
    projects.map((p) => [
      p.root_path,
      {
        x: p.x ?? null,
        y: p.y ?? null,
        glassX: p.glassX ?? null,
        glassY: p.glassY ?? null,
        cols: p.cols ?? null,
      },
    ]),
  );
}

/** The territories that actually moved between two readings, as one act's
 *  edits.
 *
 *  Filtered rather than handed over whole: an unchanged edit is a `place_project`
 *  written for nothing every time the wall is tidied, and a stack entry that
 *  claims to have moved something it did not. A territory that appeared between
 *  the two readings is skipped — there is no `was` to go back to. */
export function shifted(
  before: Map<string, Stand>,
  after: Map<string, Stand>,
): Edit[] {
  const edits: Edit[] = [];
  for (const [cwd, now] of after) {
    const was = before.get(cwd);
    if (was && !equal(was, now)) edits.push({ at: "territory", id: cwd, was, now });
  }
  return edits;
}

/* ── what a gesture is called ───────────────────────────────────────────────
 *
 * Named from the keys that changed, because the places that record a streamed
 * edit have a patch and no idea what the person thought they were doing. Phrased
 * as gerunds so the one string reads correctly after both words the UI puts in
 * front of it: "undo moving a widget", "redo moving a widget". */

const THING: Record<Realm, string> = {
  placement: "a card",
  widget: "a widget",
  image: "an image",
  territory: "a territory",
};

export function nameEdit(
  at: Realm,
  keys: string[],
  /** Whether the record was, and now is, drawn on the glass. Without it a glass
   *  patch can only be called a move; with it the two toggles get their own
   *  names, which are the words the menu uses for the same gesture. */
  glass?: { was: boolean; now: boolean },
): string {
  const has = (...k: string[]) => k.some((n) => keys.includes(n));
  const thing = THING[at];

  if (has("glassX", "glassY")) {
    if (glass && !glass.was && glass.now) return `sticking ${thing} to the glass`;
    if (glass && glass.was && !glass.now) return `putting ${thing} back on the wall`;
    return `moving ${thing} on the glass`;
  }
  if (has("config")) return `adjusting ${thing}`;
  if (has("rotation")) return `turning ${thing}`;
  /* Before position: a corner drag writes the box and the origin together, and
     what you did was resize it. A territory's left edge is the same shape one
     level up — the width and the origin move in one gesture — which is why
     `cols` is in this test and not beside `x`/`y`. */
  if (has("w", "h", "cols")) return `resizing ${thing}`;
  if (has("x", "y")) return `moving ${thing}`;
  if (has("z")) return `bringing ${thing} to the front`;
  return `changing ${thing}`;
}
