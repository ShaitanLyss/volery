/* Moving every card of a grouping to another machine, as words.
 *
 * The move itself is the card menu's (`Skein.moveCard`, `flyway/moving.rs`)
 * and is not touched: each card is quiesced, its conversation shipped and
 * checked there with one real turn, and only then let go here — or kept, with
 * the reason. Lyss: *"moving all the cards of a project to another machine is
 * a nice idea as well, I do want that."* What a whole grouping adds is a
 * question before it (many moves, each costing a turn) and a sentence after it
 * (which went, which stayed and why). Both are decided here so they can be
 * read without a browser; `App.svelte` only runs them, one card at a time —
 * never fanned out, since each move holds a card still and costs a turn, and
 * a refusal is the card staying exactly where it was.
 *
 * Pure, tested in `test/moveall.test.ts`. */

/** How one card's move ended. */
export type Moved = { title: string; moved: true } | { title: string; moved: false; why: string };

/** The question before a grouping's cards go, as the plate's sentences. */
export function departure(n: number, host: string): string[] {
  const lead = n === 1 ? "it is" : "one card at a time, each is";
  return [
    `${lead} stopped here, its conversation sent to ${host} and checked there with one turn of its own.`,
    "a card mid-turn, with uncommitted or unpushed work, background work or a timeline in flight stays here and is named afterwards.",
  ];
}

/** What happened, in one line the wall can show: how many went, and for each
 *  that stayed, its name and why. Kept short — the full reason for a card that
 *  stayed is also in its own transcript when it got far enough to have one. */
export function movedSummary(results: readonly Moved[], host: string): string {
  const went = results.filter((r) => r.moved).length;
  const stayed = results.filter((r): r is Extract<Moved, { moved: false }> => !r.moved);
  const head =
    went === results.length
      ? `moved ${went === 1 ? "the card" : `all ${went} cards`} to ${host}`
      : `moved ${went} of ${results.length} card${results.length === 1 ? "" : "s"} to ${host}`;
  if (!stayed.length) return head;
  return `${head} — still here: ${stayed.map((r) => `${r.title} (${firstClause(r.why)})`).join("; ")}`;
}

/** A refusal's first clause, which is the reason; the rest is remedy, and a
 *  list of several cards wants only the reasons. */
function firstClause(why: string): string {
  const s = why.trim().replace(/\s+/g, " ");
  const cut = s.search(/ — |\. |; /);
  const one = cut > 0 ? s.slice(0, cut) : s.replace(/\.$/, "");
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}
