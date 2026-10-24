/** Boost's mood: what the wall is doing, in the few numbers the score and the
 *  looks are driven by, and the moments they answer.
 *
 *  Pure. `boost.svelte.ts` holds the state and the moments; the score
 *  (`boostmusic.*`) and the looks (`Boost*.svelte`) read it. Credits and the
 *  routing are `credits.ts` — this file is only what boost *feels* like. */

/** A moment the wall marks, in sound and in light.
 *
 *  - `ignite`: boost was switched on.
 *  - `limit`: a card went onto credits — its account ran out under it, or it
 *    started there because the ladder had nowhere to put it.
 *  - `victory`: a card on credits finished a turn cleanly. */
export type BoostMoment =
  | { kind: "ignite"; at: number }
  | { kind: "limit"; card: string; at: number }
  | { kind: "victory"; card: string; at: number };

/** How hard the score plays, 0–3, which is the four rows of the sketch Lyss
 *  approved on 2026-10-24 ("the intensity variations are good"):
 *
 *  0 — boost on, nothing working
 *  1 — a card working
 *  2 — several working (three or more)
 *  3 — a card on credits, which is the theme coming in
 *
 *  Credits outrank the count because they are the state boost exists for: the
 *  last battle is the moment the reserve is being spent, not merely a busy
 *  wall. */
export type Intensity = 0 | 1 | 2 | 3;

export function intensityOf(working: number, onCredits: number): Intensity {
  if (onCredits > 0) return 3;
  if (working >= 3) return 2;
  if (working >= 1) return 1;
  return 0;
}

/** A victory is a fanfare, and a fanfare every turn is a jingle. At most one
 *  in this long, wall-wide; the rest pass silently (their light still plays). */
export const VICTORY_GAP_MS = 90_000;

export function victoryDue(last: number | null, now: number): boolean {
  return last === null || now - last >= VICTORY_GAP_MS;
}
