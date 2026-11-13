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
import { BUCKET_MS, bucketOf } from "./analytics";
import { asWindow, roomBucket, windowRequest, type AnalyticsWindow } from "./analyticsroom";

/** **The grain is asked for, and folded in SQL.**
 *
 *  A span decides how many points the chart draws and never which facts exist,
 *  so the server is told the width to fold to rather than being left to ship
 *  every five-minute row for a ninety-day window. The anchor travels with it
 *  because a day here is a *local* day: a bucket starting at the local midnight
 *  containing the window is the one the chart will draw, and folding to UTC
 *  days first would split one local day across two rows.
 *
 *  `roomBucket` is the same function the chart draws with, so the fold and the
 *  drawing cannot disagree about the grain. */
function grain(since: number, until: number, fine: boolean): { bucket: number; anchor: number } {
  const at = roomBucket(Math.max(0, until - since), fine ? "fine" : "hourly");
  return { bucket: BUCKET_MS[at], anchor: bucketOf(since, at) };
}

export async function readAnalyticsWindow(span: string, now: number): Promise<AnalyticsWindow> {
  const here = windowRequest(span, now);
  const { bucket, anchor } = grain(here.since, here.until, here.fine);
  const raw = await invoke<unknown>("analytics_window", { ...here, bucket, anchor });
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
  const since = here.since - width;
  const { bucket, anchor } = grain(since, here.since, here.fine);
  const raw = await invoke<unknown>("analytics_window", {
    since,
    until: here.since,
    fine: here.fine,
    bucket,
    anchor,
  });
  return asWindow(raw);
}
