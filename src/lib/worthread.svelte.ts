/* The accounts panel's one derivation read (§22).
 *
 * Two commands, both already there for the room: `allowance_samples` for the
 * window's movement, `analytics_window` for the hours of work. `equivalence.ts`
 * folds them; this is the four lines in between, and it exists as its own file
 * so that fold stays testable without Tauri.
 *
 * **Twenty-eight days, hourly.** Four whole weeks, so every weekday appears
 * exactly four times and a day-of-week comparison is not silently weighting
 * Tuesday four times against Wednesday three. Hourly because the fine tier
 * refuses a span past forty-eight hours (`analytics.rs`), and because a week's
 * shape is an hour-of-day question rather than a five-minute one.
 */

import { invoke } from "@tauri-apps/api/core";
import { asAllowanceSamples, type AllowanceSample } from "./allowancesamples";
import { asWindow, type AnalyticsWindow } from "./analyticsroom";

export const WORTH_DAYS = 28;
export const WORTH_SPAN_MS = WORTH_DAYS * 24 * 60 * 60 * 1000;

export type WorthRead = {
  since: number;
  until: number;
  /** `null` is a read that failed, which is a different state from a span that
   *  holds no samples: one says "not measured", the other "could not ask". */
  samples: AllowanceSample[] | null;
  /** The hourly tier's rows, with the same distinction. */
  window: AnalyticsWindow | null;
  /** Which half failed and in the wire's own words; empty when neither did. */
  fault: string;
};

/** A reading to answer with instead of the wall, for the browser preview
 *  (`accounts.html`): the same seam `waterfall.standIn` is, and for the same
 *  reason — the panel's readings have to be lookable with no store behind
 *  them. */
let standing: WorthRead | null = null;

export function standWorth(read: WorthRead | null) {
  standing = read;
}

export async function readWorth(now: number): Promise<WorthRead> {
  if (standing) return standing;
  const until = Math.floor(now / 60_000) * 60_000;
  const since = until - WORTH_SPAN_MS;
  const [samples, window] = await Promise.allSettled([
    invoke<unknown>("allowance_samples", { from: since, to: until }),
    invoke<unknown>("analytics_window", { since, until, fine: false }),
  ]);
  return {
    since,
    until,
    samples: samples.status === "fulfilled" ? asAllowanceSamples(samples.value) : null,
    window: window.status === "fulfilled" ? asWindow(window.value) : null,
    fault:
      window.status === "rejected"
        ? String(window.reason)
        : samples.status === "rejected"
          ? String(samples.reason)
          : "",
  };
}
