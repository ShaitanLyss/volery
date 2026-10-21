/* What a press on a sink item, a notice or a commit named in prose does.
 *
 * `cardlinks.svelte.ts`'s sibling, and for the same reason: ambient, so the
 * transcript, a question, a notice, the pile and a letter all draw an id as the
 * thing it names by existing, and what opening one *means* is said once per
 * window — a sheet over the wall, a sheet over the conversation in chat view.
 * Absent, those ids are text. Never a chip that goes nowhere, and never a
 * helpful default: a surface that forgot to provide this would otherwise open
 * its sheet somewhere nobody asked for. (CLAUDE.md, *a capability every surface
 * should have is not a prop*.) */

import { getContext, setContext } from "svelte";
import type { Ref } from "./refs";

export type RefLinks = {
  /** Open what an id names, the way this surface opens such things. */
  open(ref: Ref): void;
  /** The pointer has come to rest on a chip, or left it: a peek at what it
   *  names, drawn beside it (`RefPeek.svelte`). Optional, so a surface with no
   *  room for one simply draws the chip. */
  hover?(ref: Ref, el: HTMLElement): void;
  unhover?(): void;
};

const KEY = Symbol("volery:reflinks");

export function provideRefLinks(links: RefLinks): void {
  setContext<RefLinks>(KEY, links);
}

/** What `Inlines` asks; null where nothing provided it. */
export function useRefLinks(): RefLinks | null {
  return getContext<RefLinks | undefined>(KEY) ?? null;
}
