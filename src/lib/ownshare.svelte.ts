/* What this wall's own work explains of each account's window — the figure a
 * cap is measured against.
 *
 * A cap is a ceiling on *your* share of a subscription, and the account's own
 * percentage is everybody's share: an account shared with a manager at 20% is
 * not one where a 50% cap means "stop at 30% of your own". So the cap is
 * measured on `allowancesamples.ts::ownPoints`, which divides each window's
 * movement among the priced facts under it.
 *
 * **This wall's figure, not the fleet's.** Samples travel the flyway; the
 * fine-grained facts do not — `allowance_costs` reads `usage_fact`, which only
 * the local ingest writes — so a card on the other laptop is in *its* tables and
 * not in these. Two walls on one subscription therefore each measure the
 * ceiling on their own work, and the pair can approach twice it. That is a
 * limitation with a shape worth knowing rather than one to discover from a bill,
 * and `allowancesamples.ts::ownPoints` states it where the figure is made.
 *
 * **The current instance only.** Four five-hour windows in a day add up the way
 * a day's percentage does, which is right for a day and four times the scale of
 * the reading a cap is compared against (`allowancesamples.ts::currentOnly`).
 *
 * A read, not a fold: it costs two table reads, so it happens where the
 * allowance is already being read — inside `Waterfall.poll`, which the wall
 * attaches at construction and so runs whether or not the accounts panel is
 * open — rather than at every send.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  ownUses,
  type AllowanceCost,
  type AllowanceSample,
  type OwnUse,
} from "./allowancesamples";
import { readAllowanceCosts, readAllowanceSamples } from "./allowanceread.svelte";

/** Eight days: a weekly window is seven, and its newest instance is the one a
 *  cap is about. Four five-hour windows fit inside it many times over. */
export const SELF_SPAN_MS = 8 * 24 * 60 * 60 * 1000;

export class OwnShare {
  /** Bumped when a read lands, so the panel redraws. `#byAccount` is a plain
   *  map on purpose — this is a decision input, not a drawing — and a derived
   *  that returned the same map every time would never invalidate, which is
   *  `editing.md`'s trap. */
  version = $state(0);

  #byAccount = new Map<string, OwnUse[]>();
  #at = 0;
  #busy: Promise<void> | null = null;
  /** What the last read could not do, in the wire's own words. Empty when it
   *  worked; the previous reading is kept through a failure for `keptThrough`'s
   *  reason — a failed ask is not evidence that anything changed. */
  fault = "";

  /** Your shares for one account, in `accounts.ts::SelfUse`'s terms. An account
   *  with no reading gives an empty list, which every caller treats as *not
   *  measured* rather than as zero. */
  list(label: string): readonly OwnUse[] {
    return this.#byAccount.get(label) ?? [];
  }

  /** When the last successful read landed. */
  at(): number {
    return this.#at;
  }

  /** Re-read. **Single-flight**, because the waterfall's pass and a send can
   *  both ask while a read is in flight, and two reads of eight days of facts
   *  is one too many. */
  refresh(now = Date.now()): Promise<void> {
    if (this.#busy) return this.#busy;
    const until = Math.floor(now / 60_000) * 60_000;
    const from = until - SELF_SPAN_MS;

    this.#busy = (async () => {
      try {
        const [samples, costs] = await Promise.all([
          readAllowanceSamples(from, until),
          readAllowanceCosts(from, until),
        ]);
        this.settle(samples, costs);
        this.fault = "";
        this.#at = Date.now();
        /* **And the door is told.** `deliver_blocks` is where a relay, a wake and
           a queue drained at spawn arrive, and none of them passes through the
           front end's settling — so the ceiling you set has to be readable on
           that side (`ownshare.rs`). The share is *sent*, never recomputed
           there: one definition of what a share is, read by two doors.
           Fire and forget, because a note that did not land costs a stale
           comparison for one cadence and the next read sends it again. */
        void invoke("note_own", { shares: this.notes() }).catch(() => {});
      } catch (err) {
        this.fault = String(err);
      } finally {
        this.#busy = null;
      }
    })();
    return this.#busy;
  }

  /** The fold, which is `ownUses` — pure, in `allowancesamples.ts`, and tested
   *  there because a `.svelte.ts` with a rune in it cannot be imported by a bun
   *  test. This keeps the rows and bumps the version; it makes no call of its
   *  own. */
  settle(samples: readonly AllowanceSample[], costs: readonly AllowanceCost[]): OwnUse[] {
    const rows = ownUses(samples, costs);
    const next = new Map<string, OwnUse[]>();
    for (const row of rows) {
      const held = next.get(row.account);
      if (held) held.push(row);
      else next.set(row.account, [row]);
    }
    this.#byAccount = next;
    this.version++;
    return rows;
  }

  /** What the door is told: one row per share, carrying the whole comparison —
   *  the share, whether it is a reading or a hole, and the reading it is a share
   *  of (`share.rs`). */
  notes(): {
    account: string;
    kind: string;
    points: number;
    priced: number;
    worked: boolean | undefined;
    used: number;
    resetsAt: number | null;
  }[] {
    return this.all().map((row) => ({
      account: row.account,
      kind: row.kind,
      points: row.points,
      priced: row.priced,
      worked: row.worked,
      used: row.used,
      resetsAt: row.resetsAt,
    }));
  }

  /** Every row, in one list. */
  all(): OwnUse[] {
    return [...this.#byAccount.values()].flat();
  }
}

export const ownShare = new OwnShare();
