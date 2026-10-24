/** Boost's mood as the wall holds it: whether it is on, how hard the wall is
 *  working, and a channel the moments go out on.
 *
 *  The switch itself is the purse's (`purse.svelte.ts`) — this mirrors it so
 *  the score and the looks have one thing to read. `Skein` is what calls
 *  `mark` (a card onto credits, a card finishing on them) and what keeps
 *  `working` and `onCredits` current; nothing here talks to Rust. */

import { purse } from "./purse.svelte";
import { intensityOf, victoryDue, type BoostMoment, type Intensity } from "./boost";

export class Boost {
  /** Cards with a turn open right now, and cards spending credits. Written by
   *  `App.svelte` from the wall's own readings, so nothing here re-derives a
   *  card's state. */
  working = $state(0);
  onCredits = $state(0);

  get on(): boolean {
    return purse.boost;
  }

  get intensity(): Intensity {
    return intensityOf(this.working, this.onCredits);
  }

  #listeners = new Set<(m: BoostMoment) => void>();
  #lastVictory: number | null = null;

  /** Hear every moment from now on. Returns the way to stop. */
  listen(fn: (m: BoostMoment) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** A moment happened. `victory` is rationed wall-wide (`victoryDue`) — a
   *  fanfare on every turn would be a jingle — and the rest are said as they
   *  come. Nothing is marked while boost is off. */
  mark(m: BoostMoment) {
    if (!this.on && m.kind !== "ignite") return;
    if (m.kind === "victory") {
      if (!victoryDue(this.#lastVictory, m.at)) return;
      this.#lastVictory = m.at;
    }
    for (const fn of this.#listeners) {
      try {
        fn(m);
      } catch {
        /* One listener failing must not silence the others. */
      }
    }
  }
}

export const boost = new Boost();
