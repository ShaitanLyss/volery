/** Boost's mood as the wall holds it: whether it is on, how hard the wall is
 *  working, which look it wears, and a channel the moments go out on.
 *
 *  The switch itself is the purse's (`purse.svelte.ts`) — this mirrors it so
 *  the score and the looks have one thing to read. `Skein` is what calls
 *  `mark` (a card onto credits, a card finishing on them) and what keeps
 *  `working` and `onCredits` current; nothing here talks to Rust. */

import { purse } from "./purse.svelte";
import { intensityOf, victoryDue, type BoostMoment, type Intensity } from "./boost";
import { LOOKS, lookOf, type Look, type LookId } from "./boostfield";

const LOOK_KEY = "skein.boost.look";

function readLook(): LookId {
  try {
    return lookOf(localStorage.getItem(LOOK_KEY)).id;
  } catch {
    return lookOf(null).id;
  }
}

/** How long a limit break is remembered for a card that was not drawn yet when
 *  it happened — a new card spawned straight onto credits is marked a moment
 *  before it mounts, and should still flare when it does. */
const LIMIT_MEMORY_MS = 2_500;

export class Boost {
  /** Cards with a turn open right now, and cards spending credits. Written by
   *  `App.svelte` from the wall's own readings, so nothing here re-derives a
   *  card's state. */
  working = $state(0);
  onCredits = $state(0);

  /** Which look the wall wears while boost is on — this machine's, in
   *  `localStorage`, beside the switch it decorates (`boostfield.ts`). */
  lookId = $state<LookId>(readLook());

  get on(): boolean {
    return purse.boost;
  }

  get look(): Look {
    return lookOf(this.lookId);
  }

  get intensity(): Intensity {
    return intensityOf(this.working, this.onCredits);
  }

  setLook(id: string) {
    this.lookId = lookOf(id).id;
    try {
      localStorage.setItem(LOOK_KEY, this.lookId);
    } catch {
      /* A choice that will not persist still holds for this session. */
    }
  }

  /** The next look in the catalogue, for the chord that cycles them. */
  nextLook(dir = 1) {
    const i = LOOKS.findIndex((l) => l.id === this.lookId);
    this.setLook(LOOKS[(i + dir + LOOKS.length) % LOOKS.length]!.id);
  }

  #listeners = new Set<(m: BoostMoment) => void>();
  #lastVictory: number | null = null;
  #limits = new Map<string, number>();
  #ignitedAt: number | null = null;

  /** Hear every moment from now on. Returns the way to stop. */
  listen(fn: (m: BoostMoment) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Whether this card had a limit break so lately that a face mounting now
   *  should still play it — see `LIMIT_MEMORY_MS`. */
  limitedLately(card: string, now = Date.now()): boolean {
    const at = this.#limits.get(card);
    return at !== undefined && now - at < LIMIT_MEMORY_MS;
  }

  /** When boost was last switched on, or null. The switch marks the ignition
   *  in the same call that turns boost on, and the field is only mounted
   *  *because* boost is on — so the field always arrives a beat after the
   *  moment it exists to show, and a listener alone never once heard a real
   *  one. `boostview.svelte.ts` asks this as it mounts. */
  get ignitedAt(): number | null {
    return this.#ignitedAt;
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
    if (m.kind === "ignite") this.#ignitedAt = m.at;
    if (m.kind === "limit") {
      this.#limits.set(m.card, m.at);
      for (const [card, at] of this.#limits) if (m.at - at > LIMIT_MEMORY_MS) this.#limits.delete(card);
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
