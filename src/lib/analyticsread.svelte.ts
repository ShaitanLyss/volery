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
