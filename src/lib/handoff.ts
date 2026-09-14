/**
 * Handing a plan to the card that will build it.
 *
 * A planning card ends its turn in a document rather than a diff (`gears.ts`),
 * and until now the only thing to do with one was read it and put the same card
 * back into making. That keeps the conversation — and the conversation is the
 * expensive part. Measured on this wall over the 24 hours to 2026-09-14: **85%
 * of an Opus card's cost is re-reading context it already had**, cache reads
 * and writes against 15% output, at a mean occupancy of 221k. A turn on a card
 * that size costs about $0.11 before the model has said a word, and every token
 * put into context at turn 10 of 60 is paid for fifty more times.
 *
 * So the saving is not the cheaper model, whatever the usual telling of
 * "plan on the big one, build on the small one" says. Sonnet against Opus is a
 * flat 60% on the tokens it moves, which is worth having and is the small half.
 * **The saving is that a handoff is a context reset that keeps the
 * conclusions.** The planner spent 200k discovering which three files matter;
 * without a handoff every implementation turn re-reads all 200k of that
 * discovery for ever. With one, the maker starts at ten thousand tokens holding
 * only the answer — and that is true even when the maker is another Opus.
 *
 * Which decides everything in this file. The brief has to carry what the
 * planner *concluded* and nothing of how it got there, and it has to be small,
 * because the whole point is what it does not contain.
 *
 * # What goes in one, and why each part earns its tokens
 *
 * - **The plan, by path.** Not inlined: the maker reads it itself, so the
 *   document lands in context exactly once instead of twice.
 * - **The files the planner was in.** The second-biggest lever after the reset
 *   itself. A maker handed a plan and no trail does its own exploration pass —
 *   which is the same 200k the planner already spent, bought twice — and a
 *   dozen paths turn that into a handful of targeted reads. The wall has
 *   recorded this since its first build (`store::files_handled_by`) and had no
 *   reader for it.
 * - **The planner's handle.** The escalation path, and it is nearly free:
 *   `recall` reads another card's transcript off disk without costing that card
 *   a turn, so a maker that hits something the plan did not anticipate can go
 *   and look at the reasoning rather than re-deriving it or guessing.
 * - **One instruction about what to do when the plan is wrong.** The failure
 *   mode of a smaller model against a good plan is not that it follows it
 *   badly; it is that it improvises when the code turns out not to be shaped
 *   the way the plan assumed. Saying so costs a sentence and is the highest
 *   value per token in the whole brief.
 *
 * Pure, and tested. Nothing here knows what a card is.
 */

import { isPlanDocument } from "./gears";

/** One file a card has been in, as `store::files_handled_by` reports it. */
export type Handled = {
  path: string;
  op: "read" | "write";
  count: number;
};

/** A card's trail and the directory to read it against.
 *
 *  `root` is where the card's child actually ran, which for a card on a branch
 *  is **not** its `cwd`: a worktree lives at `cwd/.claude/worktrees/<slug>`,
 *  nested under the territory rather than beside it. Shortening these paths
 *  against `cwd` therefore does not leave them absolute — it produces
 *  `.claude/worktrees/feat-x/src/lib/store.ts`, which from the maker's own
 *  directory names a place that does not exist. Rust derives it off the
 *  conversation row so the slug algorithm has one spelling (`store::Trail`). */
export type Trail = {
  root: string;
  files: Handled[];
};

/**
 * How many paths a brief will name before it stops and says how many more
 * there were.
 *
 * Sixteen. A piece of work is in fewer files than this and an exploration is in
 * many more, so the cut falls between the trail and the subject — and a brief
 * that lists eighty paths has stopped being a shortlist and become the very
 * context dump the handoff exists to avoid.
 */
export const BRIEF_FILES = 16;

/**
 * How many rows to ask the store for.
 *
 * Generously more than `BRIEF_FILES`, so the cut and the count of what was cut
 * are both made here where they can be tested, and the tail says an exact
 * number rather than "and more". A card's trail is tens of rows; this is not a
 * page size worth economising.
 */
export const BRIEF_FETCH = 200;

/** A path as the brief names it: relative to where the maker will stand.
 *
 *  Separators folded to forward slashes and the comparison case-insensitive,
 *  because this is Windows and the store keeps whatever the tool call typed —
 *  which for the same file is `C:\Users\…\src\lib\foo.ts` from one card and
 *  `c:/users/…/src/lib/foo.ts` from another. A path outside the maker's
 *  directory is left absolute rather than climbed out of with `..`: it is
 *  genuinely elsewhere, and saying so plainly is more use than a relative path
 *  that has to be counted on the fingers. */
export function shortPath(path: string, cwd: string): string {
  const p = path.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return p;
  const under = p.toLowerCase().startsWith(`${root.toLowerCase()}/`);
  return under ? p.slice(root.length + 1) : p;
}

/**
 * The trail worth handing on, cut to length.
 *
 * The plan document itself comes out — it is named at the top of the brief and
 * a second mention buried in a file list reads as two different documents — and
 * with it anything else under `.claude/plans/`, which is the planner having
 * looked at its own earlier work rather than at the codebase.
 *
 * Order is whatever the store gave, which is most-handled first: recency is the
 * tail of an exploration and frequency is its subject.
 */
export function trailOf(handled: Handled[], plan: string): Handled[] {
  return handled.filter((h) => !isPlanDocument(h.path) && h.path !== plan);
}

/** What the maker is told, as its very first prompt.
 *
 *  `planner` is the handle the wall knows the planning card by — eight
 *  characters, `relay::handle_of` — and it is in here for `recall` rather than
 *  for attribution. */
export function briefFor(opts: {
  plan: string;
  handled: Handled[];
  cwd: string;
  planner: string;
}): string {
  const { plan, handled, cwd, planner } = opts;
  const trail = trailOf(handled, plan);
  const shown = trail.slice(0, BRIEF_FILES);
  const rest = trail.length - shown.length;

  const out = [
    `Read ${shortPath(plan, cwd)} first — it is the brief for this card, and it was ` +
      `written with more of the problem in view than this prompt carries.`,
  ];

  if (shown.length) {
    const lines = shown.map(
      (h) => `- ${shortPath(h.path, cwd)}${h.op === "write" ? " (written)" : ""}`,
    );
    /* Said as what it is — where another card's context went — rather than as
       "the relevant files", which would be a claim about the code this has no
       standing to make. The planner read these; whether all of them matter is
       the plan's business. */
    out.push(
      `The card that planned this was in these files, most-handled first:\n\n${lines.join("\n")}` +
        (rest > 0 ? `\n\n…and ${rest} more it looked at once or twice.` : ""),
    );
  }

  out.push(
    `Work from the plan. If the code turns out not to be shaped the way the plan ` +
      `assumes, say so rather than working around it — \`recall\` card ${planner}, which ` +
      `wrote it, to read its reasoning without costing it a turn.`,
  );

  return out.join("\n\n");
}
