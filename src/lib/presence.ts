/* Being away: how long for, what the pile looks like, and what a card is
 * handed when you finally answer.
 *
 * The pure half of away mode. `presence.svelte.ts` holds the state and
 * `Vigil.svelte` draws the pile; everything here is arithmetic and prose, so it
 * has a direct Bun test and the wording that reaches an agent is asserted
 * rather than eyeballed.
 *
 * `presence.rs` owns the other side of the round trip — what the *asking* card
 * was told at the moment it asked. The two halves deliberately live apart: that
 * note is written on a server thread with no webview in sight, and this one is
 * written from a click.
 */

import type { AskQuestion, Answers } from "./asking";
import { composeAnswer } from "./asking";

/** One question that piled up, as the wall holds it. Mirrors
 *  `presence::DeferredRow`. */
export type Deferred = {
  id: string;
  conversationId: string;
  questions: AskQuestion[];
  /** Normalized once, when the row arrives — the same `blankAnswers` sheet a
   *  live ask carries, and held here so switching between cards in the pile
   *  does not throw away what has already been answered. `PendingAsk` holds its
   *  answers for the identical reason. */
  answers: Answers;
  askedAt: number;
};

/** One thing a card asked Volery to *do* while you were out.
 *
 *  Kept apart from a question because the answer means something different. An
 *  answer to a question is handed to the agent, which then decides. An answer
 *  to one of these **re-enters the decision** in Rust — `spawn::close`,
 *  `board::unpost`, `remove::remove` are asked again with the arguments the
 *  card gave, twelve hours later, and may well refuse. So the panel has to say
 *  so: approving one is not "it will happen", it is "ask again now, and do it
 *  if the answer is still yes". */
export type Act = {
  id: string;
  conversationId: string;
  /** `mcp__skein__close`, `mcp__skein__unpost`, or `remove` for a shell line
   *  the hook stopped. Drawn as a verb by `actVerb`. */
  tool: string;
  questions: AskQuestion[];
  askedAt: number;
};

/** What an act is, in a word, for the row that lists it. */
export function actVerb(tool: string): string {
  if (tool.endsWith("close")) return "close a card";
  if (tool.endsWith("unpost")) return "take a notice down";
  if (tool.endsWith("remove")) return "delete a path";
  return tool;
}

/** The pile, grouped the way it is read: one card, everything it asked, oldest
 *  first.
 *
 *  Grouped rather than listed flat because the unit of attention in the morning
 *  is a *card* — three questions from the same agent about the same piece of
 *  work are one context to load, and interleaving them with another card's is
 *  the same mistake `asking.ts` describes an agent making when it fuses two
 *  decisions into one question.
 *
 *  Cards are ordered by their oldest question, so the pile reads in the order
 *  it accumulated and a card that asked at seven does not sink below one that
 *  asked at midnight. */
export type Pile = {
  conversationId: string;
  asks: Deferred[];
  /** What this card wants *done*, drawn under its questions. One group per
   *  card whichever kind it asked, because the unit of attention is still the
   *  card: deciding whether its scratch directory may go is the same context
   *  as answering what it asked about the work. */
  acts: Act[];
  /** When this card first asked. The group's sort key, and what the heading
   *  counts from. */
  since: number;
}[];

export function pileOf(asks: Deferred[], acts: Act[] = []): Pile {
  const cards = new Set([
    ...asks.map((a) => a.conversationId),
    ...acts.map((a) => a.conversationId),
  ]);
  const out: Pile = [];
  for (const conversationId of cards) {
    const mine = asks
      .filter((a) => a.conversationId === conversationId)
      .sort((a, b) => a.askedAt - b.askedAt);
    const doing = acts
      .filter((a) => a.conversationId === conversationId)
      .sort((a, b) => a.askedAt - b.askedAt);
    out.push({
      conversationId,
      asks: mine,
      acts: doing,
      since: Math.min(
        mine[0]?.askedAt ?? Number.POSITIVE_INFINITY,
        doing[0]?.askedAt ?? Number.POSITIVE_INFINITY,
      ),
    });
  }
  return out.sort((a, b) => a.since - b.since);
}

/** How many decisions are waiting, over the whole pile.
 *
 *  Questions are counted by the decisions inside them — a call carrying three
 *  is three things to decide, and a pile counted by *rows* would say "1
 *  question" to somebody with three to make. An act is one decision whatever
 *  it drew. */
export function waitingCount(asks: Deferred[], acts: Act[] = []): number {
  return asks.reduce((n, a) => n + a.questions.length, 0) + acts.length;
}

/** Whether the pile button, or the `p` chord, opens anything.
 *
 *  A press is a toggle while the panel is up and a *refusal* while the pile is
 *  empty — `Vigil.svelte` draws the pile and nothing else, so an empty one is
 *  not a smaller version of that panel, it is a panel reporting that nothing
 *  happened in the words "0 questions from 0 cards".
 *
 *  Pure and here rather than beside the `$state` it sets, for the reason the
 *  purity boundary gives: the arithmetic of what a gesture does is testable and
 *  the rune holding the answer is not. `presence.svelte.ts::openPile` is the
 *  one caller. */
export function pileOpens(showing: boolean, asks: Deferred[], acts: Act[] = []): boolean {
  return !showing && waitingCount(asks, acts) > 0;
}

/** How long something has stood, in the shape a person reads.
 *
 *  Its own function rather than `later.rs::said`'s, which is the same idea in
 *  Rust and cannot be imported. The scales differ on purpose: a wake says
 *  "40 minutes ago" because that is the scale a wake runs at, and away mode
 *  runs overnight — so this rounds to hours early and says *last night* and
 *  *yesterday*, which is what you actually want to know when you sit down with
 *  coffee. Under a minute is "just now" rather than a count of seconds: the one
 *  case it covers is a question asked while you were walking back to the desk,
 *  and "12 seconds ago" is a number nobody needs. */
export function stood(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** The same scale, said as a duration rather than as a point — "9 hours",
 *  which is what the away screen and the heading count. */
export function lasted(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "under a minute";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest && h < 6 ? `${h}h ${rest}m` : `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** What the asking card is handed, hours later.
 *
 *  **Not a relay mark, and that is the whole decision in this function.**
 *  `relay.ts` recognises five shapes under two marks and every one of them
 *  means *this was not you* — a message from another card, a notice off the
 *  billboard, a note the wall handed back. This is the opposite: the user
 *  composed it, by reading the question and clicking, and the only thing Volery
 *  did was carry it. Drawing it under a mark that says somebody else wrote it
 *  would be the same lie `isRelayPrompt` exists to prevent, told the other way
 *  round. So it is a plain prompt, drawn in your own register, because it is
 *  yours.
 *
 *  What it has to carry instead is *which question* — the agent asked hours and
 *  possibly several turns ago, and may have asked more than once. So the
 *  question is quoted back with the answer under it, which is what
 *  `composeAnswer` already does for a live call and is why this builds on it
 *  rather than beside it. */
export function answerEnvelope(
  questions: AskQuestion[],
  answers: Answers,
  stoodMs: number,
): string {
  const body = composeAnswer(questions, answers);
  const many = questions.length > 1;
  return (
    `You asked me ${many ? "these" : "this"} ${stood(stoodMs)}, while I was away, ` +
    `and the wall queued ${many ? "them" : "it"} for me. Here ` +
    `${many ? "are my answers" : "is my answer"}:\n\n${body}\n\n` +
    `(Volery held ${many ? "these questions" : "this question"} from your \`mcp__skein__ask_user\` ` +
    `call — the call itself has long since returned, so nothing is parked and nothing is ` +
    `waiting on you except the work. Pick up from wherever you left it: say what you had ` +
    `held back on this, and carry on with it now.)`
  );
}

/** How long you must have been away before a puzzle stands in the way.
 *
 *  Away mode is not a night mode. *"I could be away for lunch, away for
 *  toilets, away for sport for 2 hours"* — so the switch has to be worth
 *  throwing for five minutes, and a brain-waking puzzle after a five-minute
 *  break is precisely the thing `gate.ts` says would end the feature: a gate
 *  you resent is a gate you turn off, and then you have neither.
 *
 *  Twenty minutes is the line because of what the gate is *for*. It exists to
 *  mark a boundary — you were doing something else and now you are back at
 *  work — and a trip to the kettle is not one. Under it, coming back is
 *  nothing at all: the screen goes and the wall is there.
 *
 *  Not a setting. The toggle you want for "never" already exists on the gate
 *  itself, and a second knob that is a *duration* is a knob nobody can answer
 *  without trying three values. */
export const GATE_AFTER_MS = 20 * 60 * 1000;

/** Whether coming back should put a puzzle up.
 *
 *  Both halves matter and they fail differently: the setting off is you having
 *  said no, and a short away is Volery not asking a question worth asking. */
export function gateOnReturn(toys: boolean, awayMs: number): boolean {
  return toys && awayMs >= GATE_AFTER_MS;
}

/** What the away screen does while nobody is watching.
 *
 *  Three readings, and the setting exists because this is genuinely a taste
 *  question nobody can answer from first principles — see `away.md`. `peek`
 *  is the middle one: a full screen you can see the wall through by holding a
 *  key, for the walk-past glance without ending away mode. */
export type AwayScreen = "takeover" | "dimmed" | "peek";

export const AWAY_SCREENS: readonly AwayScreen[] = ["takeover", "dimmed", "peek"];

export function isAwayScreen(v: unknown): v is AwayScreen {
  return typeof v === "string" && (AWAY_SCREENS as readonly string[]).includes(v);
}
