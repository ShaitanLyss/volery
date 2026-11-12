/* The room's one read.
 *
 * `analytics.rs::analytics_window` answers a window of facts; `analyticsroom.ts`
 * decides which tier and what the rows mean. This is the three lines between
 * them, and it exists as its own file for the reason every other subsystem has
 * one: the pure module stays testable because it never imports Tauri.
 *
 * The answer is normalized before it is returned, as every opaque thing off the
 * wire here is (`widget.config_json`'s bargain): a row that will not parse is
 * dropped, a missing bound becomes now, and no NaN reaches a frame.
 */

import { invoke } from "@tauri-apps/api/core";
import { asWindow, windowRequest, type AnalyticsWindow } from "./analyticsroom";

export async function readAnalyticsWindow(span: string, now: number): Promise<AnalyticsWindow> {
  const raw = await invoke<unknown>("analytics_window", windowRequest(span, now));
  return asWindow(raw);
}

/** The window of the same length immediately before this one, which is what a
 *  figure is compared with (`analyticswidget.ts::statOf`).
 *
 *  A second read rather than a figure derived from the first, because "this
 *  week against its own average" is a different claim from "this week against
 *  last week" and only the second is what a delta on a tile means. The tier is
 *  asked of the same span, so the two windows are always answered by the same
 *  ladder — a fine window and an hourly one a week apart would be two numbers
 *  that are not comparable. */
export async function readAnalyticsBefore(span: string, now: number): Promise<AnalyticsWindow> {
  const here = windowRequest(span, now);
  const width = Math.max(0, here.until - here.since);
  const raw = await invoke<unknown>("analytics_window", {
    since: here.since - width,
    until: here.since,
    fine: here.fine,
  });
  return asWindow(raw);
}
