/** The wall's credits: whether boost is on, what credits have cost this month,
 *  and what the API has refused lately.
 *
 *  `credits.ts` decides everything; this only holds what it decides over. Named
 *  for what it holds rather than `credits.svelte.ts`, which beside the pure
 *  `credits.ts` would be one import specifier with two answers — the trap
 *  `ledger.svelte.ts` and `waterfall.svelte.ts` are named around.
 *
 *  Boost and the budget are this machine's, in `localStorage`, the chime's
 *  arrangement: they are a decision about what *this* wall may spend, and a wall
 *  on another machine of the flyway is somebody else's decision. They are noted
 *  to Rust as they change (`note_boost`) so a card's `allowance` can say them. */

import { invoke } from "@tauri-apps/api/core";
import {
  creditsStanding,
  DEFAULT_BUDGET,
  monthStart,
  refuseCredits,
  type CreditMark,
  type CreditRefusal,
  type CreditsStanding,
  type Purse as PurseState,
} from "./credits";

const BOOST_KEY = "skein.boost";
const BUDGET_KEY = "skein.credits.budget";

function readBoost(): boolean {
  try {
    return localStorage.getItem(BOOST_KEY) === "1";
  } catch {
    return false;
  }
}

/** The budget as stored: a number, `"none"` for no ceiling, or nothing yet —
 *  which is the default rather than no ceiling, because a wall that has never
 *  been told a figure should not be one that can spend without limit. */
function readBudget(): number | null {
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (raw === null) return DEFAULT_BUDGET;
    if (raw === "none") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
}

export class Purse {
  boost = $state(readBoost());
  budget = $state<number | null>(readBudget());
  /** Spent on credits by this wall's cards since `since`. */
  spent = $state(0);
  /** Whether the vault holds a key. Null until asked. */
  keyHeld = $state<boolean | null>(null);
  refused = $state<CreditMark | null>(null);
  /** The month `spent` counts from. */
  since = $state(monthStart(Date.now()));
  /** What the wall does when boost comes on — release every held card, since a
   *  hold credits can take is no longer a hold (`Skein` installs it at load).
   *  A hook here rather than a method every surface must remember to call: the
   *  header, the chord, the accounts panel and the control surface all flip
   *  boost, and one that flipped it without the release would leave cards
   *  waiting on an allowance boost was turned on to stand in for. */
  whenOn: (() => void) | null = null;

  get state(): PurseState {
    return {
      boost: this.boost,
      keyHeld: this.keyHeld,
      budget: this.budget,
      spent: this.spent,
      refused: this.refused,
    };
  }

  standing(now = Date.now()): CreditsStanding {
    return creditsStanding(this.state, now);
  }

  /** Turn boost on or off. Turning it on forgets any refusal, since flipping
   *  the switch is the gesture a person makes after topping the credits up or
   *  replacing the key — the same reason `putOnAccount` forgives. */
  setBoost(on: boolean) {
    this.boost = on;
    if (on) this.refused = null;
    try {
      localStorage.setItem(BOOST_KEY, on ? "1" : "0");
    } catch {
      /* A setting that will not persist still holds for this session. */
    }
    this.#note();
    void this.refresh();
    if (on) this.whenOn?.();
  }

  setBudget(budget: number | null) {
    this.budget = budget;
    try {
      localStorage.setItem(BUDGET_KEY, budget === null ? "none" : String(budget));
    } catch {
      /* As above. */
    }
    this.#note();
  }

  /** The API refused credits. */
  refuse(kind: CreditRefusal, now = Date.now()) {
    this.refused = refuseCredits(this.refused, kind, now);
  }

  /** A turn was answered on credits, so whatever refused them has lifted. */
  served() {
    this.refused = null;
  }

  /** What has been spent this month, and whether a key is held. Cheap and
   *  local — a sum over the `turn` table and one vault read — and asked when
   *  something changed rather than on a clock: on load, on the switch, after
   *  every turn taken on credits, and when the keyring is written. */
  async refresh(now = Date.now()) {
    const since = monthStart(now);
    if (since !== this.since) {
      /* A new month: the ledger starts again, and so does any refusal for a
         balance that was the old month's grant. */
      this.since = since;
      if (this.refused?.kind === "balance") this.refused = null;
      this.#note();
    }
    try {
      const [spent, held] = await Promise.all([
        invoke<number>("credits_spent", { since }),
        invoke<boolean>("integration_held", { service: "anthropic" }),
      ]);
      this.spent = spent;
      if (held !== this.keyHeld) {
        this.keyHeld = held;
        /* A key appearing is the other gesture that clears a refusal of the
           key: the one that was refused is not the one now stored. */
        if (held && this.refused?.kind === "key") this.refused = null;
      }
    } catch {
      /* Left as it was: a figure that could not be re-read is not a month that
         cost nothing. */
    }
  }

  /** Called once the wall is up, so Rust hears the switch before any card asks
   *  its `allowance`. */
  start() {
    this.#note();
    void this.refresh();
  }

  #note() {
    void invoke("note_boost", { on: this.boost, budget: this.budget, since: this.since }).catch(() => {});
  }
}

export const purse = new Purse();
