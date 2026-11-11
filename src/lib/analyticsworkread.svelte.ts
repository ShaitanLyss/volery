/* The work tab's one read.
 *
 * Three commands, one window: the facts the episodes are computed from, the
 * series that carries the card totals, the hourly tokens to price and the
 * session intervals to place, and the overlap pairs the strip draws. They are
 * asked together because they answer one question, and each normalises through
 * `analyticswork.ts` so a row that will not parse is dropped rather than drawn
 * as a zero.
 *
 * Its own file for the reason every subsystem here has one: the pure module
 * stays testable because it never imports Tauri.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  asInvalidateRows,
  asOverlaps,
  asWorkRows,
  asWorkSeries,
  type InvalidateRow,
  type WorkBundle,
} from "./analyticswork";
import { asWatch, type SpendWatch } from "./spend";

export async function readWorkWindow(from: number, to: number): Promise<WorkBundle> {
  const [rows, series, invalidations] = await Promise.all([
    invoke<unknown>("work_facts", { from, to }),
    invoke<unknown>("work_series", { from, to }),
    /* Its own catch, for the reason the pair listing has one: an older build
       or a refused window must not take the cost and the artifacts with it. */
    invoke<unknown>("invalidate_facts", { from, to }).then(asInvalidateRows).catch(() => null),
  ]);
  let invalidationRows: InvalidateRow[] = [];
  let invalidationsUnread = false;
  if (invalidations === null) invalidationsUnread = true;
  else invalidationRows = invalidations;
  /* The pair listing is the one read that can be refused on a wide window
     (its cap is over a whole wall's touches, not two cards'). It is caught on
     its own: the table, the scatter and the episodes do not stop being true
     because the overlap scan was too large, and the strip says it was not
     read rather than drawing an empty one. */
  let overlaps: ReturnType<typeof asOverlaps> = [];
  let overlapsUnread = false;
  try {
    overlaps = asOverlaps(await invoke<unknown>("overlap_pairs", { from, to }));
  } catch {
    overlapsUnread = true;
  }
  return {
    rows: asWorkRows(rows),
    series: asWorkSeries(series),
    overlaps,
    invalidations: invalidationRows,
    overlapsUnread,
    invalidationsUnread,
  };
}

/** The watches one card set on itself, for the block beside its per-card spend.
 *
 * Deliberately its own command and its own call rather than part of the work
 * window: a watch is one card's row, it changes when the card or its person
 * changes it rather than when the span does, and reading it must not re-read a
 * week of facts. */
export async function readWatches(card: string): Promise<SpendWatch[]> {
  const raw = await invoke<unknown>("spend_watches", { conversationId: card });
  return Array.isArray(raw)
    ? raw.map(asWatch).filter((w): w is SpendWatch => w !== null)
    : [];
}

/** Take one down from the page. The command refuses an id that is not this
 *  card's, so the page cannot delete another card's watch. */
export async function dropWatch(card: string, id: number): Promise<boolean> {
  return invoke<boolean>("spend_unwatch", { conversationId: card, id });
}
