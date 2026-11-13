/* What this wall's own work explains of each account's window — the figure a
 * cap is measured against.
 *
 * A cap is a ceiling on *your* share of a subscription, and the account's own
 * percentage is everybody's share: an account shared with a manager at 20% is
 * not one where a 50% cap means "stop at 30% of your own". So the cap is
 * measured on `allowancesamples.ts::ownPoints`, which divides each window's
 * movement among the priced facts under it.
 *
 * **The figure is already the fleet's, and that is why this is a read rather
 * than a protocol.** Samples travel (the poll, a card's `rate_limit_event`, a
 * peer's reading) and so do the facts, so the facts of a card on the other
 * laptop are in this wall's own tables and `attribute` counts them. Nothing
 * needs publishing, and a wall that has been offline understates its own share
 * rather than pretending to a second one.
 *
 * **The current instance only.** Four five-hour windows in a day add up the way
 * a day's percentage does, which is right for a day and four times the scale of
 * the reading a cap is compared against (`allowancesamples.ts::currentOnly`).
 *
 * A read, not a fold: it costs two table reads, so it happens where the
 * allowance is already being read — once a pass, in `Waterfall.poll` — rather
 * than at every send.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  costBucketsOf,
  currentOnly,
  instancesOf,
  ownPoints,
  type AllowanceCost,
  type AllowanceSample,
  type OwnPoints,
} from "./allowancesamples";
import { readAllowanceCosts, readAllowanceSamples } from "./allowanceread.svelte";

/** Eight days: a weekly window is seven, and its newest instance is the one a
 *  cap is about. Four five-hour windows fit inside it many times over. */
export const SELF_SPAN_MS = 8 * 24 * 60 * 60 * 1000;

/** How often the wall re-reads its own share.
 *
 *  **Two minutes, because this is not the allowance poll and has none of its
 *  politeness.** That one spends somebody else's request on an endpoint that
 *  answers 429 to a minute, so it asks only while a panel is open. This is two
 *  reads of the wall's own tables, so it may run with nothing open — and it has
 *  to, because a cap is a cap whether or not anybody is looking at the accounts
 *  panel. Two minutes is well inside the resolution anything reads it at: the
 *  share moves by a point or two a turn, against caps measured in tens. */
export const SELF_EVERY_MS = 2 * 60_000;

export class OwnShare {
  #byAccount = new Map<string, OwnPoints[]>();
  #at = 0;
  /** When a read was last *attempted*, which is what the cadence below turns
   *  on. `#at` is when one last succeeded, so throttling on it would retry
   *  every tick against a store that is refusing — a read a second, forever. */
  #tried = 0;
  #busy: Promise<void> | null = null;
  /** What the last read could not do, in the wire's own words. Empty when it
   *  worked; the previous reading is kept through a failure for `keptThrough`'s
   *  reason — a failed ask is not evidence that anything changed. */
  fault = "";

  /** Your shares for one account, in `accounts.ts::SelfUse`'s terms. An account
   *  with no reading gives an empty list, which every caller treats as *not
   *  measured* rather than as zero. */
  list(label: string): readonly OwnPoints[] {
    return this.#byAccount.get(label) ?? [];
  }

  /** When the last successful read landed. */
  at(): number {
    return this.#at;
  }

  /** Re-read, unless one landed recently. What the wall's tick calls. */
  maybeRefresh(now = Date.now()): Promise<void> {
    if (this.#busy) return this.#busy;
    if (this.#tried > 0 && now - this.#tried < SELF_EVERY_MS) return Promise.resolve();
    return this.refresh(now);
  }

  /** Re-read. **Single-flight**, because the poll can be asked twice while a
   *  read is in flight and two reads of eight days of facts is one too many. */
  refresh(now = Date.now()): Promise<void> {
    if (this.#busy) return this.#busy;
    const until = Math.floor(now / 60_000) * 60_000;
    const from = until - SELF_SPAN_MS;
    this.#tried = now;
    this.#busy = (async () => {
      try {
        const [samples, costs] = await Promise.all([
          readAllowanceSamples(from, until),
          readAllowanceCosts(from, until),
        ]);
        const rows = this.settle(samples, costs);
        this.fault = "";
        this.#at = Date.now();
        /* **And the door is told.** `deliver_blocks` is where a relay, a wake and
           a queue drained at spawn arrive, and none of them passes through the
           front end's settling — so the ceiling you set has to be readable on
           that side (`ownshare.rs`). The share is *sent*, never recomputed
           there: one definition of what a share is, read by two doors.
           Fire and forget, because a note that did not land costs a stale
           comparison for one cadence and the next read sends it again. */
        void invoke("note_own", { shares: rows }).catch(() => {});
      } catch (err) {
        this.fault = String(err);
      } finally {
        this.#busy = null;
      }
    })();
    return this.#busy;
  }

  /** The fold, kept apart from the read so a test can hand it fixtures and so
   *  the arithmetic has one home (`ownPoints`, which is pure and tested). It
   *  keeps the rows and hands them back, and makes no call of its own. */
  settle(samples: readonly AllowanceSample[], costs: readonly AllowanceCost[]): OwnPoints[] {
    const rows = ownPoints(currentOnly(instancesOf(samples)), costBucketsOf(costs));
    const next = new Map<string, OwnPoints[]>();
    for (const row of rows) {
      const held = next.get(row.account);
      if (held) held.push(row);
      else next.set(row.account, [row]);
    }
    this.#byAccount = next;
    return rows;
  }
}

export const ownShare = new OwnShare();
