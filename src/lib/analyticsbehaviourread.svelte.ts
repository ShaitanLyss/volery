/* The behaviour tab's one read (§11.9).
 *
 * Three commands, one window: the hourly tool rollup the tables and the scatter
 * are folded from, the session records the habits are counted off, and the
 * moves already recorded for the work page's invalidations. They are asked
 * together because they answer one question about one span, and each
 * normalises through `analyticsbehaviour.ts` so a row that will not parse is
 * dropped rather than drawn as a zero.
 *
 * **It reads `tool_totals`, not `tool_facts`.** The fine tier is pruned at
 * ninety days and this tab offers the spend tab's year; the rollup is kept and
 * carries the five latency bands, which is the only way a percentile over
 * months can be computed at all. `analytics.ts::latency` labels that reading an
 * estimate, which is the honest half of the bargain.
 *
 * Its own file for the reason every subsystem here has one: the pure module
 * stays testable because it never imports Tauri.
 */

import { invoke } from "@tauri-apps/api/core";
import { asSessionFacts, asToolTotals, type SessionFact } from "./analyticsbehaviour";
import { asInvalidateRows, type InvalidateRow } from "./analyticswork";
import { asActionWindow, type ActionWindow } from "./acts";
import type { ToolTotal } from "./analytics";

/** The grain the gesture series is asked for: minutes where the span is short
 *  enough to read them, hours for a month or two, days beyond. The store
 *  refuses a window whose groups overflow, so this is a ladder rather than a
 *  guess — a year of minutes is half a million groups, and even a year of hours
 *  is sixty thousand for a busy wall, which is over the cap. */
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TWO_DAYS = 2 * DAY;
const TWO_MONTHS = 60 * DAY;

export type BehaviourBundle = {
  tools: ToolTotal[];
  sessions: SessionFact[];
  changes: InvalidateRow[];
  /** What the person did in the same window (§3.10): gestures a minute,
   *  switches, stays. Empty when the read failed, which `actionsUnread` says. */
  actions: ActionWindow;
  /** The moves could not be read, for an older build or a refused window. The
   *  tables and the habits still draw; the face says the move count is missing
   *  rather than drawing it as none. */
  changesUnread: boolean;
  /** The same for the gestures. */
  actionsUnread: boolean;
};

/** Everything the behaviour tab asks of the wall, in one value. The component
 *  takes this rather than importing `invoke`, which is what lets
 *  `/analytics.html` drive the same drawing with made-up facts. */
export type BehaviourReader = (from: number, to: number) => Promise<BehaviourBundle>;

export async function readBehaviourWindow(from: number, to: number): Promise<BehaviourBundle> {
  const [tools, sessions] = await Promise.all([
    invoke<unknown>("tool_totals", { from, to }),
    invoke<unknown>("session_facts", { from, to }),
  ]);
  /* Its own catch, for the reason the work window's invalidations have one: a
     read that fails must not take the tables and the habits with it. */
  let changes: InvalidateRow[] = [];
  let changesUnread = false;
  try {
    changes = asInvalidateRows(await invoke<unknown>("invalidate_facts", { from, to }));
  } catch {
    changesUnread = true;
  }
  /* Its own catch for the reason the moves have one: a window the store refuses
     must cost the gesture band and nothing else. */
  const span = to - from;
  const bucket = span <= TWO_DAYS ? MINUTE : span <= TWO_MONTHS ? HOUR : DAY;
  let actions = asActionWindow(null, { from, to, bucket });
  let actionsUnread = false;
  try {
    actions = asActionWindow(await invoke<unknown>("action_facts", { from, to, bucket }), {
      from,
      to,
      bucket,
    });
  } catch {
    actionsUnread = true;
  }
  return {
    tools: asToolTotals(tools),
    sessions: asSessionFacts(sessions),
    changes,
    actions,
    changesUnread,
    actionsUnread,
  };
}
