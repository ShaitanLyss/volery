/* The wall's undo stack, and the hands that put a record back.
 *
 * All the reasoning is in `./undo.ts`, which is pure and holds the whole state
 * machine. This file adds two things: the runes, so the menu and the keyboard
 * can read what each direction would do, and a `Hand` — one function per realm
 * that writes a snapshot back where it came from.
 *
 * ── two ways an act gets recorded, and why there are two ──────────────────
 *
 * **Where a gesture already has a commit point, the act is recorded there.** A
 * card dropped, a territory let go, a menu item clicked: something in the code
 * already knows the gesture is over, because that is where the row gets written.
 * `did()` is called there, once, with every record the gesture touched — which
 * is what makes dragging a territory of five pinned cards *one* press to undo
 * rather than six.
 *
 * **Where the mutation is the gesture, the act is streamed and fused.** A widget
 * being dragged or resized writes its box every frame and nothing anywhere knows
 * when you will let go; a knob nudged in the context menu fires once per click
 * with no bracket around the series. Those places call `note()` on every change
 * and `remember`'s fusing window collapses the run into one act. It is the same
 * bargain `Widgets.#saveSoon` strikes one layer down — the database only needs
 * where a thing came to rest, and so does the stack.
 *
 * The consequence worth knowing: `Widgets` and `Board` record their own edits,
 * from inside `add`/`update`/`remove`, so every caller gets undo for free —
 * including the control surface, which is how `wall.test.ts` can drive it.
 * `Studio` deliberately does *not*: placements are recorded at the gestures'
 * own commit points, for the territory-drag reason above. */

import { spotOf } from "./glass";
import type { Placement } from "./layout";
import type { RefImage } from "./images.svelte";
import type { Widget } from "./widgets";
import {
  NOTHING,
  describe,
  forget,
  forgetWhere,
  nameEdit,
  remember,
  replay,
  rewind,
  type Act,
  type Edit,
  type Past,
  type Realm,
  type Stand,
} from "./undo";

export type { Stand };

/** Putting one record back as it was. Null means it should not exist.
 *
 *  Injected rather than imported, for the reason `Widgets.others` is: this file
 *  may not own the four things it writes to, and a stack that reached for them
 *  directly could not be tested or driven from outside. */
export type Hand = {
  placement(id: string, p: Placement | null): void;
  widget(id: string, w: Widget | null): void;
  image(id: string, i: RefImage | null): void;
  territory(cwd: string, at: Stand | null): void;
};

const IDLE: Hand = {
  placement() {},
  widget() {},
  image() {},
  territory() {},
};

/** Whether a snapshot is drawn on the glass, for naming the gesture. */
const onGlass = (v: unknown): boolean =>
  !!spotOf(v as { glassX?: number | null; glassY?: number | null } | null);

export class Undo {
  past = $state<Past>(NOTHING);

  /** Set by `App.svelte` once it has the four things a step writes to. Idle
   *  until then, which is the honest state for a wall that has not loaded. */
  hand: Hand = IDLE;

  /** Nested, not a boolean: applying an act writes several records and any one
   *  of them may go through a path that records. A flag would be cleared by the
   *  first one to finish and let the rest of the step onto the stack. */
  #quiet = 0;
  #clock: () => number;

  /** The clock is injected so a test can hold it still — the fusing window is
   *  the whole of how a drag becomes one act, and a test of that cannot be at
   *  the mercy of how fast the machine got round the loop. */
  constructor(clock: () => number = () => Date.now()) {
    this.#clock = clock;
  }

  /** What each direction would do, or null where there is nothing that way. Null
   *  is what keeps the item off the menu entirely rather than on it and inert —
   *  see the standing rule in `menu.ts`. */
  goingBack = $derived(describe(this.past).back);
  goingForward = $derived(describe(this.past).forward);

  /** One gesture, whole, from a place that knows the gesture is over. */
  did(label: string, edits: Edit[]) {
    if (this.#quiet || !edits.length) return;
    this.past = remember(this.past, { label, edits, t: this.#clock() });
  }

  /** One record changing, from a place where the change *is* the gesture. The
   *  patch is handed over only to name what happened; what goes on the stack is
   *  the whole record either side, as everywhere else. */
  note(at: Realm, id: string, was: unknown, now: unknown, patch: object) {
    if (this.#quiet) return;
    const label = nameEdit(at, Object.keys(patch), {
      was: onGlass(was),
      now: onGlass(now),
    });
    this.did(label, [{ at, id, was, now }]);
  }

  /** Do this without any of it being remembered. For the paths that write to a
   *  record without anybody having asked — restoring the wall on load, banking a
   *  running timer's seconds — and for applying a step, which is the one write
   *  that must never become a new act. */
  quiet<T>(fn: () => T): T {
    this.#quiet++;
    try {
      return fn();
    } finally {
      this.#quiet--;
    }
  }

  /** A record that has gone for good and can never be written back — see
   *  `forget` in ./undo.ts. */
  drop(at: Realm, id: string) {
    this.past = forget(this.past, at, id);
  }

  /** The same, for every record matching — see `forgetWhere` in ./undo.ts. */
  dropWhere(gone: (e: Edit) => boolean) {
    this.past = forgetWhere(this.past, gone);
  }

  /** One step back. Answers what it undid, or null if there was nothing. */
  back(): string | null {
    const step = rewind(this.past);
    if (!step.act) return null;
    this.past = step.past;
    this.#apply(step.act);
    return step.act.label;
  }

  /** One step forward again. */
  forward(): string | null {
    const step = replay(this.past);
    if (!step.act) return null;
    this.past = step.past;
    this.#apply(step.act);
    return step.act.label;
  }

  /** Throw the whole history away. Nothing in the app calls this yet; it is
   *  here for the control surface, so a test can start from a known stack. */
  clear() {
    this.past = NOTHING;
  }

  /** Write every record in an act back. Always the `now` side — `rewind` hands
   *  over an inverted act, so there is one direction of travel here and no
   *  branch on which way we are going.
   *
   *  Order within an act does not matter: one gesture never touches the same
   *  record twice, and the records an act spans are independent of each other. */
  #apply(act: Act) {
    this.quiet(() => {
      for (const e of act.edits) {
        if (e.at === "placement") {
          this.hand.placement(e.id, e.now as Placement | null);
        } else if (e.at === "widget") {
          this.hand.widget(e.id, e.now as Widget | null);
        } else if (e.at === "image") {
          this.hand.image(e.id, e.now as RefImage | null);
        } else {
          this.hand.territory(e.id, e.now as Stand | null);
        }
      }
    });
  }
}
