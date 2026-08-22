/* Which of the header's items still fit across the bar, and which fold away
 * into the panel behind the ⋯ button.
 *
 * Pure and tested, because the bug this exists to fix was arithmetic and the
 * arithmetic is the part that is easy to get subtly wrong. The header is a flex
 * row that had no floor: narrow the window and every item shrank to its
 * min-content and then simply spilled past the right edge, taking the window
 * controls with it. Losing `themes` off the end is a nuisance; losing the
 * maximise button is a trap, because the gesture that would give you the room
 * back is the one that went over the edge. There is now a structural guarantee
 * in the stylesheet — the foldable clusters may shrink to nothing and the
 * controls may not shrink at all — and this file is the good behaviour that
 * sits on top of it, deciding what to give up and in what order rather than
 * letting the browser clip whatever happened to be last.
 *
 * **Order is priority, most-important-first.** The caller passes the items in
 * the order it wants to keep them, and what does not fit folds from the tail.
 * That is the whole policy: there is no scoring, no per-item weight, nothing to
 * keep in sync — the array reads as the sentence "give these up last".
 *
 * Two things this deliberately does not do. It does not know about the DOM, so
 * the caller measures; and it does not hedge — an item either fits or it folds,
 * with no half-width or elided-label state, because a header of truncated words
 * is harder to read at a glance than a shorter header of whole ones. */

/** One item's measured footprint, in CSS pixels, border box included. */
export type Measured = { key: string; width: number };

export type Fold = {
  /** Keys that stay in the bar, in the order they were given. */
  shown: string[];
  /** Keys that go into the panel, in the order they were given. */
  folded: string[];
};

/** What a run of items costs laid end to end.
 *
 * Every item is charged `width + gap`, including the first — so this reserves
 * one gap more than flexbox actually spends. Deliberate: being one gap
 * pessimistic costs a fraction of a character of width, and it makes every sum
 * below a plain `Σ cost` with no off-by-one to reason about at each boundary.
 * A fold decided one gap early is invisible; a fold decided one gap late is the
 * bug this file exists to prevent. */
export function costOf(items: Measured[], gap: number): number {
  let total = 0;
  for (const it of items) total += widthOf(it) + Math.max(0, gap);
  return total;
}

/** Decide the fold.
 *
 * `avail` is the room the foldable items have between the things that never
 * fold — the wordmark, an update offer, the control-surface note, the open
 * button and the window controls. `foldWidth` is what the ⋯ button itself
 * costs, and it is only charged when something actually folds: a header with
 * room for everything should not carry a button that opens an empty panel. */
export function foldChrome(
  avail: number,
  items: Measured[],
  gap: number,
  foldWidth: number,
): Fold {
  if (items.length === 0) return { shown: [], folded: [] };

  /* The cheap answer first, and it is also the common one — most of the time
     the window is wide and nothing is given up. Asked before the ⋯ button is
     charged for, since charging for it is what would push the last item out. */
  const room = Number.isNaN(avail) ? 0 : avail;
  if (costOf(items, gap) <= room) return { shown: items.map((i) => i.key), folded: [] };

  /* Something folds, so the button is real and takes its share first. Note the
     order: reserving the button can push out an item that fit a line ago, and
     that item has to fold rather than being drawn over the button. */
  let left = room - (Math.max(0, foldWidth) + Math.max(0, gap));

  const shown: string[] = [];
  const folded: string[] = [];
  for (const it of items) {
    const cost = widthOf(it) + Math.max(0, gap);
    /* Once one item has folded every item after it folds too, whatever its
       width. A narrow item slipping into a gap left by a wide one ahead of it
       would reorder the bar as you resize — the same buttons in a different
       arrangement at every width, which reads as the header rearranging itself
       rather than as the header getting shorter. */
    if (folded.length > 0 || cost > left) {
      folded.push(it.key);
      continue;
    }
    left -= cost;
    shown.push(it.key);
  }

  return { shown, folded };
}

/** A measurement that is missing, negative or not a number costs nothing rather
 *  than poisoning every sum after it. `offsetWidth` is 0 for an element that is
 *  not laid out yet, which is a real state on first paint and not an error. */
function widthOf(it: Measured): number {
  const w = it.width;
  return Number.isFinite(w) && w > 0 ? w : 0;
}
