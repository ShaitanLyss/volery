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
import { asOverlaps, asWorkRows, asWorkSeries, type WorkBundle } from "./analyticswork";

export async function readWorkWindow(from: number, to: number): Promise<WorkBundle> {
  const [rows, series] = await Promise.all([
    invoke<unknown>("work_facts", { from, to }),
    invoke<unknown>("work_series", { from, to }),
  ]);
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
    overlapsUnread,
  };
}
