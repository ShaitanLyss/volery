/* What a message from another card looks like once it is in a transcript.
 *
 * The recipient's CLI replays a relayed prompt as a plain `user` message —
 * exactly the shape of something you typed — so the panel has one job here and
 * it is not cosmetic: say that this was not you. Left alone it would be drawn
 * in your register, in your card, with nothing on the page distinguishing an
 * instruction another agent gave from one you gave.
 *
 * Recognised off the words themselves, the way `rousing.ts::isResumePrompt`
 * recognises a resume and for the same reason: the live fold and the one that
 * reads a session back off disk share nothing but the text. Nothing on the wire
 * carries a flag, and a column would not survive `--resume` reading the
 * transcript from the CLI's own file.
 *
 * `relay.rs::envelope` writes what this reads. Pure — no runes — so both ends
 * of the round trip can be asserted directly.
 */

/** The first line of every relayed message. Must match `relay::RELAY_MARK`. */
export const RELAY_MARK = "[skein relay]";

/** The first line of a wake. Must match `later::WAKE_MARK`.
 *
 *  Its own string rather than a relay envelope, and `later.rs` is right about
 *  why: there is nobody at the other end of a wake, so a header naming a sender
 *  would be a lie. What was missing was this end. Nothing in `src/` knew the
 *  string, so a wake fell through to the plain `user` arm and was drawn in your
 *  own register, in your own card, with nothing on the page saying you had not
 *  typed it — the exact bug this file exists to prevent, wearing the one dress
 *  it did not check for.
 *
 *  It is recognised *here*, beside the relay, rather than as a sixth line kind
 *  in the panel: the panel's job is identical in every case and it is to say
 *  this was not you. Only the cap and the hint differ, and both are one
 *  function each. And the mark is not being changed to a relay one, however
 *  tidy that would be — every transcript already on this machine carries
 *  `[skein wake]`, and `history.ts` reads those back off disk. */
export const WAKE_MARK = "[skein wake]";

/** Who a message came from, as far as the envelope says. */
export type RelayFrom = {
  /** The sender's title when it was sent, which is not necessarily its title
   *  now — cards are renamed as the work clarifies, and what the transcript
   *  keeps is what was true. */
  name: string;
  handle: string;
  project: string | null;
};

/* Four shapes. A sender can be closed between writing a message and its
 * recipient waking up to read it, so the second keeps the handle — still the
 * only thing that identifies what said it. The third is not a message at
 * all: a standing notice off the billboard, which came to find this card
 * because it edited a file the notice covers (`board.rs::on_touch`). And the
 * fourth has no author anywhere — the wall telling a parent that cards it
 * opened have stopped (`spawn::envelope`), which is a fold over an event rather
 * than anything anybody wrote.
 *
 * One mark and one recogniser for all four, deliberately — the panel's job is
 * the same in every case, which is to say this was not you. The alternative for
 * the last two was a mark apiece, and `later.rs` took it: `[skein wake]` is its
 * own string, and for a fortnight the front end did not know it, so a wake was
 * drawn as something you typed. A shape under a mark that is already recognised
 * cannot go wrong that way — which is the argument, and it is an argument about
 * cost rather than about correctness. The fifth shape below is under the second
 * mark and is read correctly now (sink af952612); what it cost was a constant,
 * a regex, a predicate and a branch in `transcript.ts`, none of which the first
 * four needed. */
const HEADED =
  /^\[skein relay\] from "(.*?)" \(([0-9a-f]{4,36})\)(?: in (.+?))? —\s*$/;
const ORPHANED =
  /^\[skein relay\] from a card that has since been closed \(([0-9a-f]{4,36})\) —\s*$/;
const NOTICE = /^\[skein relay\] from the billboard —/;
const WALL = /^\[skein relay\] from the wall —/;
/* The fifth shape, and the only one under the other mark. `later::envelope`
   writes "…woken about this 5 minutes ago, and it is now:"; the elapsed phrase
   is the one thing in that header worth keeping, so it is lifted into the name
   and ends up in the fold cap rather than being stripped with the line. */
const WAKE = /^\[skein wake\] you asked to be woken about this (.+?), and it is now:\s*$/;

/** Whether this line is one somebody other than you put in your card.
 *
 *  Five shapes under two marks. The name is what it decides — the `relay` line
 *  kind — rather than what wrote it; a wake is not a relay and is still not
 *  yours, and `isWakePrompt` is what tells them apart afterwards. */
export function isRelayPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(RELAY_MARK) || t.startsWith(WAKE_MARK);
}

/** Whether it is a wake specifically — a note you left yourself, handed back.
 *
 *  Asked by `transcript.ts` for the fold's hint, which is the one place where
 *  "another card sent this" and "you asked for this" are not interchangeable. */
export function isWakePrompt(text: string): boolean {
  return text.trimStart().startsWith(WAKE_MARK);
}

/** Who sent it, or `null` for anything that is not one of ours.
 *
 *  Degrades rather than refuses, the bargain `normalizeAsk` strikes: a message
 *  whose header this build cannot parse is still a message the agent was given
 *  and acted on, so it is drawn as a relay from nobody rather than redrawn as
 *  something you typed. Getting that wrong in the other direction is the whole
 *  bug this file exists to prevent. */
export function relayFrom(text: string): RelayFrom | null {
  if (!isRelayPrompt(text)) return null;
  const head = text.trimStart().split("\n", 1)[0] ?? "";
  /* Before the relay shapes, since it is under the other mark entirely. The
     author of a wake is this card, earlier — which is a real answer and not a
     degradation, so it is named rather than falling through to "another card".
     A header this build cannot parse still says it was a wake. */
  const w = WAKE.exec(head);
  if (w) return { name: `you, ${w[1]}`, handle: "", project: null };
  if (isWakePrompt(text)) return { name: "you, earlier", handle: "", project: null };
  const m = HEADED.exec(head);
  if (m) return { name: m[1], handle: m[2], project: m[3] ?? null };
  const o = ORPHANED.exec(head);
  if (o) return { name: "a closed card", handle: o[1], project: null };
  /* The notice names its own author inside the header rather than in a field,
     because a notice outlives the card that posted it — see `board_envelope`.
     What the cap wants to say is where it came from, and that is the board. */
  if (NOTICE.test(head)) return { name: "the billboard", handle: "", project: null };
  /* No handle and no card, and that is not a degradation — nothing sent this.
     Naming the wall is what stops it reading as "from another card", which
     would be the panel inventing an author for a line that has none. */
  if (WALL.test(head)) return { name: "the wall", handle: "", project: null };
  return { name: "another card", handle: "", project: null };
}

/** The message itself, without the header or the note under it.
 *
 *  The note is addressed to the model — it says who this is from and that
 *  silence is a legitimate reply — and reading it is not the same as reading
 *  the message. Kept out of the drawn body rather than out of the fold: opening
 *  the line shows what the agent was actually handed, which is the point of
 *  having the line at all. */
export function relayBody(text: string): string {
  const t = text.trimStart();
  if (!isRelayPrompt(t)) return text;
  const nl = t.indexOf("\n");
  let body = nl === -1 ? "" : t.slice(nl + 1);
  /* Written by `envelope` as its own trailing paragraph, so it is matched
     whole. A message that happens to end in a parenthesis is untouched. */
  const note = Math.max(
    body.lastIndexOf("\n\n(This came from another agent"),
    body.lastIndexOf("\n\n(This is a standing notice"),
    body.lastIndexOf("\n\n(This came from the wall"),
    body.lastIndexOf("\n\n(This is your own note to yourself"),
  );
  if (note !== -1) body = body.slice(0, note);
  return body.trim();
}

/** What the fold says while it is closed.
 *
 *  Short, because a fold cap is `nowrap` with an ellipsis in a panel a third of
 *  a window wide — the same constraint `RESUME_CAP` is written to. It names the
 *  sender rather than quoting the message, for the reason `askHeadline` does:
 *  a cut-off first sentence names nothing. */
export function relayCap(text: string): string {
  const from = relayFrom(text);
  return from ? `from ${from.name}` : "from another card";
}

/* One more shape under this mark and the comment above the four is still the
   whole argument: a mark apiece is what let `[skein wake]` be written by Rust
   and read by nobody for as long as it took somebody to be in `later.rs` for
   another reason. Anything new that puts words in a card that the user did not
   type belongs in `isRelayPrompt` on the day it is written, not the day it is
   noticed. */

/** What a card is called on the roster, given only its id.
 *
 *  Must agree with `relay::handle_of`. Here so the wall can label a strand
 *  whose endpoint has already been closed, which is the one case where there is
 *  no title left to use. */
export function handleOf(id: string): string {
  return id.slice(0, 8);
}
