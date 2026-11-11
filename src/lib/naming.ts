/** What a card is called — and what it is called before it is called anything.
 *
 *  A title arrives in three stages: a card is opened and has none, the first
 *  prompt cuts one out of what you said, and once a turn lands Claude Code's own
 *  generated title replaces it (`Skein.#adoptAiTitle`). The first stage used to
 *  be drawn as the literal word "untitled", which is the sentinel's spelling and
 *  not a thing to show anybody — it is the one moment a card is asking to be
 *  given something to do, and it said the least of any state on the wall.
 *
 *  So the sentinel stays exactly where it was (it is read by the store's default,
 *  by `#deliver`, by the wall's footprints and by the process meter) and only
 *  what is *drawn* changes: an unnamed card wears the draft you are typing at it,
 *  cut the same way sending it would cut it, and before you have typed anything
 *  it wears the plainest true statement about itself.
 *
 *  Pure, per the purity boundary — the naming rules are testable and nothing
 *  here touches a rune or an invoke. */

import { handoverBody, isHandoverPrompt } from "./relay";

/** The stored spelling of "this card has never been named".
 *
 *  Not a label. It is `title`'s DEFAULT in the schema (`store.rs`), the test in
 *  `#deliver` that decides whether the first prompt gets to name the card, and
 *  the test everything that *draws* a name asks before drawing it. */
export const UNNAMED = "untitled";

/** What an unnamed card with nothing typed at it says.
 *
 *  Deliberately not "nothing said yet" — the open density already says that, in
 *  the card's own body, about the transcript. Two lines of a card telling you
 *  the same absence twice is a card with one thing to say. This one is about
 *  identity rather than contents: it is a thread, and it is new. */
export const NEW_THREAD = "a new thread";

/** How many characters of a prompt become a title. Cutting at all is the point:
 *  a card is a place on a wall read at a glance, and a paragraph is not a name. */
export const TITLE_MAX = 42;

/** Has this card been named — by you, by your first prompt, or by Claude Code?
 *
 *  Empty counts as unnamed alongside the sentinel: `store.rs` defaults the column
 *  rather than constraining it, and a row that arrived with `''` should not draw
 *  a blank space where every other card has a name. */
export function isNamed(title: string | null | undefined): boolean {
  return !!title && title.trim() !== "" && title.trim() !== UNNAMED;
}

/** The title a prompt gives the card it is sent to.
 *
 *  Shared by `Skein.#deliver`, which does the naming, and by the card face, which
 *  shows what that naming is going to produce while you are still typing it. One
 *  function for both or the preview quietly lies — a draft drawn in full and then
 *  committed as forty-one characters and an ellipsis is a card that renamed
 *  itself the instant you pressed Enter.
 *
 *  Whitespace is collapsed because a prompt is not a line: paste four paragraphs
 *  at a card and the newlines land in a `nowrap` span, which draws them as
 *  nothing and leaves the words jammed together.
 *
 *  A handover is named after its brief rather than after its envelope — the
 *  header is four words of plumbing, and a card called `[skein relay] handed
 *  over` is a card called nothing (`relay.ts::handOver`). */
export function titleFromPrompt(text: string): string {
  const said = isHandoverPrompt(text) ? handoverBody(text) : text;
  const t = said.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + "…" : t;
}

export type CardName = {
  text: string;
  /** This is not the card's name yet — it is the name it is about to have, or
   *  the absence of one. Drawn quieter, so a wall of cards you have actually
   *  named is legible at a glance from a wall of cards you have not. */
  provisional: boolean;
};

/** What to draw in a card's title line.
 *
 *  `draft` is what is typed in the dock *if this card is one the dock is aimed
 *  at* — the caller decides that, since reach is App's knowledge. An unnamed card
 *  outside the gathering shows the new-thread line, which is correct: it is not
 *  the one about to be named.
 *
 *  It is the caller's business too that a draft with the palette lit is not a
 *  name: `/clear` is about to be run rather than sent, and a card that briefly
 *  called itself "/clear" would be describing a prompt it will never receive.
 *  App withholds the draft in that case, which keeps the command vocabulary in
 *  `commands.ts` where it belongs rather than duplicating it here. */
export function cardName(
  title: string | null | undefined,
  draft = "",
): CardName {
  if (isNamed(title)) return { text: title!.trim(), provisional: false };
  const typed = titleFromPrompt(draft);
  if (typed) return { text: typed, provisional: true };
  return { text: NEW_THREAD, provisional: true };
}

/** A card's name where there is no room to explain an absence: the footprints
 *  crossing the wall, a row in the process meter.
 *
 *  The project's name stands in, because both of those are read at a distance or
 *  out of context and "a new thread" floating over a pair of footprints says as
 *  little as "untitled" did. Here the card's whereabouts is the more useful of
 *  the two facts. */
export function displayName(
  title: string | null | undefined,
  project: string,
): string {
  return isNamed(title) ? title!.trim() : project;
}

/** A card's name for the readouts that already print its project beside it: the
 *  dock's target line, the peek window, the ask panel.
 *
 *  Empty when there is none, and deliberately not `displayName`'s answer — the
 *  project is standing right there, so falling back to it would print the same
 *  word twice ("skein skein"). Nor the card face's answer: those readouts are
 *  about reach and attention rather than identity, and the draft they would
 *  echo is in the field directly below them. */
export function nameBesideProject(title: string | null | undefined): string {
  return isNamed(title) ? title!.trim() : "";
}
