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

/** The library, held once, because two surfaces read it now: the overlay's list
 *  and every analytics widget on the wall. A rename that reached one and not
 *  the other would be a widget drawing a view under a name the library no
 *  longer has, so there is one copy and every write refreshes it.
 *
 *  `ready` is apart from an empty list for the reason every other holder keeps
 *  them apart: a library nobody has read yet and one with nothing saved in it
 *  are different readings, and a widget that treated the first as the second
 *  would say its view is gone during the moment before the read lands. */
export const savedViews = $state<{ list: SavedView[]; ready: boolean }>({
  list: [],
  ready: false,
});

export async function readSavedViews(): Promise<SavedView[]> {
  return asSavedViews(await invoke<unknown>("analytics_views"));
}

/** Read the library into the shared copy. Answers what it read, so a caller
 *  that wants the list can use the answer and one that only wants the cache
 *  warm can ignore it. */
export async function loadSavedViews(): Promise<SavedView[]> {
  const list = await readSavedViews();
  savedViews.list = list;
  savedViews.ready = true;
  return list;
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
  await freshen();
  return one;
}

export async function renameSavedView(id: string, name: string): Promise<boolean> {
  const changed = await invoke<boolean>("analytics_rename_view", { id, name });
  if (changed) await freshen();
  return changed;
}

export async function deleteSavedView(id: string): Promise<boolean> {
  const gone = await invoke<boolean>("analytics_delete_view", { id });
  if (gone) await freshen();
  return gone;
}

/** Re-read after a write, so a widget on the wall sees the rename or the delete
 *  the moment it lands rather than at the next launch. The read is one small
 *  query and a write is rare, which is why this is a re-read and not a bookkeep
 *  of the four mutations in place. A failure leaves the last list standing: the
 *  write itself succeeded, and a stale name is a smaller problem than a library
 *  that empties because a read did not land. */
async function freshen(): Promise<void> {
  try {
    await loadSavedViews();
  } catch {
    /* left as it was */
  }
}
