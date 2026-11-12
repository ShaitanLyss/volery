/* A card's life's one read (§11.10).
 *
 * One command, asked of a card rather than of a window: a card is a history,
 * and a page fed by the surface's span would redraw whenever somebody widened a
 * chart. The normaliser is `analyticslife.ts`'s, so a row that will not parse is
 * dropped rather than drawn as a zero.
 *
 * Its own file for the reason every subsystem here has one: the pure module
 * stays testable because it never imports Tauri.
 */

import { invoke } from "@tauri-apps/api/core";
import { asCardLife, type CardLife } from "./analyticslife";

/** The card's life, or null where the answer does not name one. */
export type LifeReader = (card: string) => Promise<CardLife | null>;

export async function readCardLife(card: string): Promise<CardLife | null> {
  return asCardLife(await invoke<unknown>("card_life", { card }));
}
