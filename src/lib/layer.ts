/* Lifting an overlay out of the stacking context it was written inside.
 *
 * `position: fixed` escapes an ancestor's `overflow`, but not its stacking
 * context. The title bar, the band, the voice box and the wall are each
 * `position: relative; z-index: 1` siblings in the studio column, so anything
 * drawn inside the bar — whatever its own `z-index` — is painted at the bar's
 * level, and the band and the wall, coming later in the document at the same
 * level, are painted *over* it wherever it hangs below the bar. The wall's
 * ground is see-through to the backdrop, so the overflow panel stayed perfectly
 * visible there and simply never received a press: its first row half-worked
 * (the strip still inside the bar's box) and its second row not at all
 * (2026-11-03, "they don't react to the mouse at all").
 *
 * The overlays at the studio root (`ContextMenu`, `Glance`, `Tooltip` …) are
 * not caught by this because they are mounted there. A component that has to
 * live inside the bar for its *button* but draws a fixed panel for its
 * *contents* gets the same footing with `{@attach toStudio}`: the node is moved
 * to the studio root on mount, which is also the containing block every
 * `--span-*` calculation assumes (`span.ts`), so the arithmetic is unchanged.
 *
 * **Put it on an element that is not a top-level node of its block.** Svelte
 * removes a block's DOM by walking siblings from its first node to its last;
 * a top-level node moved elsewhere would send that walk through the studio's
 * own children. Wrap the moved element in one that stays put, and the
 * attachment's cleanup removes the moved one itself. */

/** Where a lifted overlay goes: the studio root if it is an ancestor, else
 *  `document.body` — which only a component mounted outside the studio (a test
 *  harness, the peek window) would ever reach. */
export function studioRoot(from: Element): Element {
  const doc = from.ownerDocument;
  /* An attachment runs once the element is mounted, so `closest` is the
     answer; the query is for a node handed over before it was connected. */
  return from.closest(".studio") ?? doc.querySelector(".studio") ?? doc.body;
}

export function toStudio(node: HTMLElement): () => void {
  studioRoot(node).appendChild(node);
  return () => node.remove();
}
