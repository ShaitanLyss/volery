/* The saved-view library's four writes, and nothing else.
 *
 * `analytics.rs` stores the rows; `analyticpage.ts::asSavedViews` makes what
 * comes back drawable. This is the three lines between them, in the shape every
 * subsystem here uses: the pure module stays testable because it never imports
 * Tauri, and the component keeps no wire vocabulary.
 *
 * **A rename or a delete answers whether it changed anything**, because "the
 * view is gone" is a real answer and a row that quietly does nothing leaves the
 * surface showing a library that is not there.
 */

import { invoke } from "@tauri-apps/api/core";
import { asSavedViews, type SavedView } from "./analyticpage";
import type { ViewSpec } from "./analytics";

export async function readSavedViews(): Promise<SavedView[]> {
  return asSavedViews(await invoke<unknown>("analytics_views"));
}

/** Save a spec under a name and answer the stored row. */
export async function saveSavedView(name: string, view: ViewSpec): Promise<SavedView> {
  const raw = await invoke<unknown>("analytics_save_view", {
    name,
    configJson: JSON.stringify(view),
  });
  /* One row through the same normaliser the list gets, so a freshly saved view
     is drawn exactly as it will be after a restart. */
  const [one] = asSavedViews(raw ? [raw] : []);
  if (!one) throw new Error("the store did not answer with the view it saved");
  return one;
}

export async function renameSavedView(id: string, name: string): Promise<boolean> {
  return invoke<boolean>("analytics_rename_view", { id, name });
}

export async function deleteSavedView(id: string): Promise<boolean> {
  return invoke<boolean>("analytics_delete_view", { id });
}
