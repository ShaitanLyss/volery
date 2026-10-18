import { MAX_ATTACHED, compose, dropToken, echoOf, type Block, type Carried } from "./attach";

/** What a card holds while no account will take its words, and how they go out
 *  again.
 *
 *  It was one slot. A first prompt held for an account was kept, persisted and
 *  sent when one freed up; a *second* typed into the same card was refused,
 *  marked failed and kept nowhere — gone at the next restart (sink `864ccaae`).
 *  Lyss, 2026-10-16: "something typed or done by the user should never be
 *  lost." So it is a queue, oldest first, and nothing you type into a held card
 *  is turned away: it joins the back.
 *
 *  **And it goes out as one round, not one turn a message.** Lyss's call, and
 *  the CLI agrees with it: three prompts written to `claude -p` back to back
 *  came back as *one* replay carrying three text blocks and were answered in
 *  one turn (probed 2026-10-16, Skein's argv, Haiku — the CLI merges its own
 *  queue). One turn per message would cost a full re-read of the context each,
 *  and worse, would have the agent act on the first before it had read the
 *  second — which may be the one that says "actually, don't". Volery cannot
 *  tell whether three messages are one ask or three, and does not try: they go
 *  together, each verbatim and marked as its own, and the agent decides.
 *
 *  The one cut is a slash command, which cannot ride inside other words — the
 *  CLI only treats `/model x` as a command when it is the whole prompt, and
 *  inside a combined one it would reach the model as prose. So a held queue is
 *  sent as rounds cut at commands (`nextRound`), each round after the one
 *  before has finished its turn. Usually that is exactly one round.
 *
 *  Pure, per the purity boundary: `Skein` owns the timer, the store and the
 *  send; `Conversation` owns the lines. This is the bookkeeping between. */

/** One message a card is holding. `key` names it for as long as it is held —
 *  its place in the queue moves as the ones ahead of it go — and is what its
 *  pictures are filed under, in memory and in the store. */
export type HeldItem = {
  key: string;
  /** As you typed it, picture tokens and all — what the line draws. */
  text: string;
  /** The names of the pictures it carries, in the order they were attached.
   *  The bytes are kept beside the queue rather than in it: in memory while
   *  the wall is up, and in the store so a restart does not lose them
   *  (`store::migrate_v54`). */
  pictures: string[];
  /** Composed by a heal rather than typed by you — the only kind that may
   *  lapse (`lapsesOnAnswer`), and the only kind that goes to the *front*:
   *  it re-asks the turn that broke, which came before anything queued. */
  composed?: true;
  /** Skein's own words — a resume prompt after a restart, the news of jobs
   *  that died, a brief, a follow-up — held because the card was. Never
   *  combined with yours under a header that says each was typed, never handed
   *  back to your draft, and sent alone so its own recogniser still knows it
   *  (`isResumePrompt` and the rest anchor on a prompt's first words). Found in
   *  review: the first cut queued a resume prompt as though you had typed it. */
  own?: true;
};

/** A card's hold: what it is keeping, and what it is waiting on.
 *
 *  `allowance` — no account will take work; `why` and `until` say which and
 *  for how long, and a timer and the allowance poll are the ways out.
 *  `turn` — an account is free and a round has gone out; what is left goes
 *  when that round's turn has finished, so nothing jumps it. */
export type Held = {
  queue: HeldItem[];
  why: string;
  until: number | null;
  waiting: "allowance" | "turn";
};

/** What a held line says under your words. Quiet and achromatic, unlike
 *  `· not sent`: nothing has gone wrong, and the card is keeping them. */
export const HELD_MARK = " · held — will send when allowance returns";

/** What the face says while what is left of a queue waits behind the round
 *  that went out ahead of it. */
export const QUEUED_LINE = "held — sending the rest after this turn";

/** What the face says when nothing is signed in, or every account is switched
 *  off. Held rather than failed, which it was until 2026-10-16: it does end —
 *  when you sign one in or turn one on, and the minute's sweep notices — and a
 *  failure here was a prompt that existed nowhere once the wall closed. */
export const NO_ACCOUNT_HELD = "held — no account is available; sign one in or switch one on";

/** Where a message joins the queue: yours at the back, always — there is no
 *  refusal any more — and a heal's at the front, since it stands in for the
 *  turn that broke, which was asked before anything waiting here was. */
export function admit(queue: readonly HeldItem[], item: HeldItem): HeldItem[] {
  return item.composed ? [item, ...queue] : [...queue, item];
}

/** Whether this message has to go out by itself: anything slash-shaped, the
 *  same narrowing `localCommandAwaiting` uses. A custom `/commit` is a real
 *  prompt rather than a CLI command, and is cut anyway — a skill invoked from
 *  the middle of somebody else's words is not invoked. */
export function cutsRound(text: string): boolean {
  return text.trim().startsWith("/");
}

/** Whether this message goes out alone: a command, a heal's re-ask, or
 *  Skein's own words — anything that is not simply something you typed. */
export function alone(item: HeldItem): boolean {
  return !!item.composed || !!item.own || cutsRound(item.text);
}

/** The next round out of a queue, and what is left behind it.
 *
 *  Something that goes alone goes alone; otherwise every message of yours up
 *  to the next such one goes together — but never more pictures in one round
 *  than one prompt may carry (`MAX_ATTACHED`), since each message was checked
 *  against that on its own and a round of six could carry six times it. Order
 *  is never changed: whatever is cut waits its turn exactly where you put it. */
export function nextRound(queue: readonly HeldItem[]): { round: HeldItem[]; rest: HeldItem[] } {
  if (queue.length === 0) return { round: [], rest: [] };
  if (alone(queue[0]!)) return { round: [queue[0]!], rest: queue.slice(1) };
  let n = 0;
  let pictures = 0;
  while (n < queue.length && !alone(queue[n]!)) {
    pictures += queue[n]!.pictures.length;
    if (n > 0 && pictures > MAX_ATTACHED) break;
    n++;
  }
  return { round: queue.slice(0, n), rest: queue.slice(n) };
}

/** The line ahead of a combined round, written for the agent: what these are,
 *  why they arrive together, and the one thing about them it most needs —
 *  that a later one may take an earlier one back. Deliberately not shaped like
 *  any of the wall's own envelopes (`[skein relay]`, the wake, the pick-up),
 *  which every recogniser here anchors on by their first words. */
export function heldHeader(n: number): string {
  return `skein held these ${n} messages while this card's allowance was spent, and sends them now as one turn, in the order they were written. Each is exactly as it was typed, and a later one may change or take back an earlier one.`;
}

/** The divider before message `k` of `n` in a combined round. */
export function heldDivider(k: number, n: number): string {
  return `── message ${k} of ${n} ──`;
}

/** One round, ready for the wire: the blocks, and what the replay will echo
 *  for them — which is what the lines it settles are claimed on.
 *
 *  One message goes exactly as it would have gone had nothing held it, so the
 *  ordinary case is unchanged and its line claims itself as it always did.
 *  Several are one prompt: the header, then each message under its divider,
 *  verbatim, with its pictures where its sentence put them. Adjacent text is
 *  run together into one block so the wire carries what a person would have
 *  typed, and the echo is `echoOf` the result — the same fold every pictured
 *  prompt is matched by, so the two cannot drift. */
export function composeRound(round: readonly { text: string; pictures: readonly Carried[] }[]): {
  content: Block[];
  echo: string;
} {
  if (round.length === 1) {
    const content = compose(round[0]!.text, round[0]!.pictures);
    return { content, echo: echoOf(content) };
  }
  const out: Block[] = [];
  let words = heldHeader(round.length);
  const flush = () => {
    if (words.trim()) out.push({ type: "text", text: words });
    words = "";
  };
  round.forEach((m, i) => {
    words += `\n\n${heldDivider(i + 1, round.length)}\n`;
    for (const b of compose(m.text, m.pictures)) {
      if (b.type === "text") words += b.text;
      else {
        flush();
        out.push(b);
      }
    }
  });
  flush();
  return { content: out, echo: echoOf(out) };
}

/** A held message's words as they go back to the draft — Escape, a clear, a
 *  close, a send that failed. `missing` names pictures that could not be found
 *  again, whose tokens come out of the sentence rather than pointing at
 *  nothing (`attach.ts::dropToken`, the same edit backspacing over a chip
 *  makes). Per message, since two messages may each have their own `[shot 1]`. */
export function withoutMissing(text: string, missing: readonly string[]): string {
  return missing.reduce((t, name) => dropToken(t, name), text);
}

/** Said in the transcript when held words go back to the draft. */
export function handedBackNote(n: number, why: string, lostPictures: number): string {
  const what = n === 1 ? "the held message is" : `the ${n} held messages are`;
  const pictures =
    lostPictures === 0
      ? ""
      : lostPictures === 1
        ? " — one picture could not be found again and needs attaching afresh"
        : ` — ${lostPictures} pictures could not be found again and need attaching afresh`;
  return `${why} — ${what} back in this card's draft${pictures}`;
}
