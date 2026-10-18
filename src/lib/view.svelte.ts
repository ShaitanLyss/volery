/* Which view the window is drawing: the wall, or chat.
 *
 * One holder for the whole window, read rather than passed: the composer's
 * keys, the menu's rows and `Skein.watching` each ask it, for the reason the
 * gear is asked of the store — a view handed in as a prop is one a future
 * surface forgets to hand in, and gets the wall's keys in chat view without a
 * word. `viewmode.ts` decides what it opens on; this only holds it. */

import type { View } from "./viewmode";

class ViewHolder {
  current = $state<View>("wall");
}

export const view = new ViewHolder();
