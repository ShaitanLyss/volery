/* Finding a word in the transcript you are reading.
 *
 * Ctrl+F used to reach the *webview's* own find bar, which is the wrong tool in
 * two ways at once. It searches the whole document — so it matches the header,
 * the card titles, every widget on the wall and the dock — and it draws
 * Chromium's chrome over an app whose whole point is that it has none. Asked for
 * by the user (sink 776a4d34): the browser one gone everywhere, and a find that
 * belongs to whatever it was opened over. The transcript is the first of those,
 * and for now the only one.
 *
 * **Plain case-insensitive substring, not the fuzzy scorer.** `finding.ts` scores
 * candidates because a file finder is answering "which of these did you mean"
 * from a few characters. Ctrl+F is answering "where does this word appear", and a
 * fuzzy match there is a find that jumps to places the word is not. Different
 * question, different matcher, and they deliberately do not share one.
 *
 * Block-level rather than character-level, which is the one real limit and worth
 * stating. A `text` line is rendered markdown — headings, code fences, links —
 * so highlighting inside it means reaching into `Markdown.svelte`'s output, and
 * a find that rewrote the renderer's DOM to paint a background would be trading
 * a much larger surface for a nicer highlight. So a match bands the block it is
 * in and the panel scrolls to it, which is what "where does this word appear"
 * actually asks for.
 *
 * Pure, tested directly (`test/hunt.test.ts`). `Block` is a type-only import and
 * erased at build.
 */

import type { Block } from "./transcript";

/** Where a match sits inside one string. Same shape as `finding.ts`'s, on
 *  purpose — a span is a span, and the two modules highlight the same way even
 *  though they match differently. */
export type Span = { from: number; to: number };

/** The shortest query worth running.
 *
 *  Two. One character matches most of any transcript and the count would be
 *  noise rather than a reading — and the panel has to draw something for every
 *  match, so a query of `e` over a long column is a bad frame as well as a bad
 *  answer. Below this the bar says nothing rather than everything. */
export const MIN_QUERY = 2;

/** Every place `query` occurs in `text`, case-insensitively.
 *
 *  Non-overlapping and left to right, which is what a reader stepping through
 *  matches expects: `aa` in `aaaa` is two matches, not three. Empty or
 *  too-short queries find nothing rather than everything.
 *
 *  Lowercased once per call rather than per character. The two strings are the
 *  same length lowercased as long as nothing in them changes width under
 *  case-folding — which is true of every case this is used on and is why the
 *  spans are indices into the *original*, so the caller can slice it. */
export function spansOf(text: string, query: string): Span[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY || !text) return [];
  const hay = text.toLowerCase();
  const out: Span[] = [];
  let at = hay.indexOf(q);
  while (at !== -1) {
    out.push({ from: at, to: at + q.length });
    at = hay.indexOf(q, at + q.length);
  }
  return out;
}

/** All the text a block puts on the page, for matching against.
 *
 *  A fold's contents count. That is the decision worth stating: a run of tool
 *  calls is one line until you open it, so a match inside it is a match in
 *  something you cannot currently see — and finding it anyway is the useful
 *  answer, because the alternative is a find that says a word is not in a
 *  transcript that contains it. The panel opens the fold when it lands there.
 *
 *  A tool call's *result* is deliberately not searched. It is held on the call
 *  (`ToolCall.result`) and can be twenty thousand characters of a file that was
 *  read, so searching it would make every Ctrl+F a scan of every file the agent
 *  has opened — and a match there is not a place in the *conversation*. What is
 *  searched is what the column says: the line, and the lines inside a fold. */
export function textOf(b: Block): string {
  if (b.kind === "tools") return b.lines.map((l) => l.text).join("\n");
  return b.line.text;
}

/** One block that matched, and where. */
export type Found = {
  /** The block's own key — what the panel hangs a `data-hunt` on. */
  key: string;
  /** Matches within `textOf(b)`, in order. */
  spans: Span[];
};

/** Which blocks carry the query, in column order.
 *
 *  Blocks rather than matches, because the panel scrolls to a *place* and a
 *  block is the smallest thing it can scroll to. `spans` is carried anyway so
 *  the count is the number of matches rather than the number of blocks — "3 of
 *  17" has to mean seventeen occurrences, or stepping through it skips some. */
export function huntBlocks(blocks: Block[], query: string): Found[] {
  const out: Found[] = [];
  for (const b of blocks) {
    const spans = spansOf(textOf(b), query);
    if (spans.length) out.push({ key: b.key, spans });
  }
  return out;
}

/** How many matches in total. */
export function tally(found: Found[]): number {
  let n = 0;
  for (const f of found) n += f.spans.length;
  return n;
}

/** Step through the matches, wrapping at both ends.
 *
 *  Wrapping rather than stopping, which is what every find bar does and what a
 *  reader expects — the last match followed by `n` is the first one, and the
 *  first followed by `N` is the last. `at` out of range comes back to 0, so a
 *  query that shrinks the match list under the cursor lands somewhere real
 *  instead of nowhere. */
export function stepTo(count: number, at: number, by: number): number {
  if (count <= 0) return 0;
  if (at < 0 || at >= count) return by < 0 ? count - 1 : 0;
  return (((at + by) % count) + count) % count;
}

/** Which block the nth match is in, and which match it is inside that block.
 *
 *  The panel counts matches and scrolls to blocks, so it needs the mapping
 *  between them in one place rather than an index walk at every call site. */
export function matchAt(found: Found[], n: number): { key: string; nth: number } | null {
  if (n < 0) return null;
  let left = n;
  for (const f of found) {
    if (left < f.spans.length) return { key: f.key, nth: left };
    left -= f.spans.length;
  }
  return null;
}

/** What the bar says about the state of the search.
 *
 *  Prose rather than a bare fraction, because the two failing states are
 *  different and both are worth saying: a query too short to run is not the
 *  same as a query that found nothing, and a bar that showed `0/0` for both
 *  would have you retyping a word that was never the problem. */
export function huntCap(query: string, count: number, at: number): string {
  if (query.trim().length < MIN_QUERY) return "";
  if (count === 0) return "not in this transcript";
  return `${Math.min(at + 1, count)} of ${count}`;
}
