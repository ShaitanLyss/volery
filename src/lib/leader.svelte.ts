/* The live half of the space leader: a half-typed sequence, and a clock.
 *
 * The rule is `leader.ts` and is pure. This is the two things it deliberately
 * does not have — the time the last key was pressed, and a timer that takes the
 * hint down on its own — plus the one field the hint is drawn from.
 *
 * It used to be three methods on `Finder`, which was right for as long as the
 * finder was the only thing a chord could open. `fire` is the whole of what
 * changed: the leader now hands out a verb and the wall decides what it means,
 * so a new chord reaches a new subsystem without this file learning its name.
 */

import { LAPSE_MS, chord, type Verb } from "./leader";

export class Leader {
  /** The letters typed since the leader, or null when no sequence is open.
   *  Drawn as a hint — a chord is the one gesture on this wall with no
   *  affordance at all, so the wall offers what it is waiting for. */
  pending = $state<string | null>(null);

  #pressedAt = 0;
  #lapse: ReturnType<typeof setTimeout> | null = null;
  #gone = false;
  #fire: (verb: Verb) => void;

  constructor(fire: (verb: Verb) => void) {
    this.#fire = fire;
  }

  /** Feed a keydown to the leader, and say whether the key was ours.
   *
   *  `false` means the key belongs to whoever would have had it — which is the
   *  case that makes this worth a return value rather than a side effect. A
   *  second key that completes no chord abandons the sequence and *falls
   *  through*, the way `<space>q` in nvim leaves you with a `q`; a wall that
   *  ate it would be one where a letter occasionally vanished.
   *
   *  Time is read here rather than in `leader.ts` so the rule itself stays pure
   *  and testable. */
  press(key: string): boolean {
    const since = this.pending === null ? 0 : Date.now() - this.#pressedAt;
    const step = chord(this.pending, key, since);
    /* A modifier on its own changed nothing, and must not be allowed to change
       anything here either — including the stopwatch. A held Shift repeats its
       keydown, so restarting the clock on it would keep a forgotten sequence
       alive for as long as a finger rested on the key. */
    if (step.kind === "held") return false;
    this.pending = step.open;
    this.#pressedAt = Date.now();

    /* The hint has to go away on its own, or a sequence you thought better of
       sits under the wall until the next thing you type. It is the same lapse
       the machine applies to the *next* key; this one is only about the
       drawing, which is why it is a timer here and not a rule there. */
    if (this.#lapse !== null) clearTimeout(this.#lapse);
    this.#lapse = null;
    if (step.open !== null && !this.#gone) {
      this.#lapse = setTimeout(() => {
        this.#lapse = null;
        this.pending = null;
      }, LAPSE_MS + 50);
    }

    if (step.kind === "fire") this.#fire(step.verb);
    return step.swallow;
  }

  /** Drop the timer. Vite rebuilds this object on every front-end edit, and a
   *  superseded generation's timeout would write `pending` on an instance
   *  nothing is drawing. */
  detach() {
    this.#gone = true;
    if (this.#lapse !== null) clearTimeout(this.#lapse);
    this.#lapse = null;
    this.pending = null;
  }
}
