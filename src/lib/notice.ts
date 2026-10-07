/* Notices: what a turn ending raises, when, in what order they are read, and
 * what a reply to one says. Pure — the rune-holding half is in
 * `skein.svelte.ts`, and Rust (`notice.rs`) holds the queue and the three
 * holds only the wall can answer. See `.claude/rules/notice.md`. */
import { endsOnQuestion, type Ending } from "./classify";

export type NoticeKind = "done" | "question" | "error" | "card";

export type Notice = {
  id: string;
  conversationId: string;
  kind: NoticeKind;
  /** Markdown — the card's closing message, or what it sent. */
  text: string;
  raisedAt: number;
  /** In the away pile as well as the dock's queue. */
  away: boolean;
  /** A card's notice that asked to be waited on and could not be. */
  waited: boolean;
  /** Set while a card's notice is parked on its tool call: the reply is the
   *  call's result rather than a message. `ask.rs` owns the id. */
  askId?: string;
};

/** How long a rest must last before it raises anything.
 *
 *  Measured on 926 real rests (2026-10-07): a card rests between a turn and a
 *  message that was already queued behind it, and the next turn opens inside a
 *  couple of seconds. Raising on those is a notice and a chime cleared before
 *  anybody could read them. */
export const SETTLE_MS = 5_000;

/** Background work younger than this holds a rest notice; older does not.
 *
 *  The age, not the kind, because the kind cannot tell a test run from a dev
 *  server — both are a `Bash` with `run_in_background`, and a server never
 *  reports, so "hold while anything runs" mutes that card for good. Two thirds
 *  of the card's own wake-ups landed inside this, and the hold is capped at it. */
export const YOUNG_JOB_MS = 10 * 60_000;

/** What a turn ending raises, or `null` for nothing.
 *
 *  `healing` is a retry the card is about to make by itself: the user chose to
 *  hear about an error only once the card has given up on it. A stop was your
 *  own gesture and a turn the CLI answered locally (`/compact`) is not work. */
export function restNotice(
  ending: Ending | null,
  lastWords: string,
  opts: { lastError?: string | null; healing?: boolean; local?: boolean } = {},
): { kind: NoticeKind; text: string } | null {
  if (!ending || ending === "stopped" || opts.local) return null;
  const said = lastWords.trim();
  if (ending === "error") {
    if (opts.healing) return null;
    const why = (opts.lastError ?? "").trim() || "the turn ended in an error";
    return { kind: "error", text: said ? `${why}\n\n${said}` : why };
  }
  if (!said) return { kind: "done", text: "*It ended its turn without a closing message.*" };
  return { kind: endsOnQuestion(said) ? "question" : "done", text: said };
}

/** When a rest notice may go up, given the card's background work.
 *
 *  `SETTLE_MS` after the rest at the soonest, and while a job younger than
 *  `YOUNG_JOB_MS` is running, not before the youngest of them comes of age. */
export function raiseAt(restedAt: number, jobs: { since: number }[]): number {
  let at = restedAt + SETTLE_MS;
  for (const j of jobs) {
    if (restedAt - j.since < YOUNG_JOB_MS) at = Math.max(at, j.since + YOUNG_JOB_MS);
  }
  return at;
}

/** The order the queue is read in: a card's notice that is holding its turn
 *  open first — an agent is stopped on it — then the rest, oldest first. */
export function noticeQueue(notices: Notice[]): Notice[] {
  return [...notices].sort(
    (a, b) => Number(!!b.askId) - Number(!!a.askId) || a.raisedAt - b.raisedAt,
  );
}

/** Which notice the dock draws: the focused card's if it has one — the card in
 *  the ring and the notice beside it should be about the same conversation —
 *  else the front of the queue. `askShown`'s rule. */
export function noticeShown(focusedId: string | null | undefined, queue: Notice[]): Notice | null {
  return queue.find((n) => n.conversationId === focusedId) ?? queue[0] ?? null;
}

/** What the panel calls it, and what its reply box says. */
export function noticeWords(n: Pick<Notice, "kind" | "askId" | "waited">): {
  mark: string;
  placeholder: string;
  send: string;
} {
  switch (n.kind) {
    case "question":
      return {
        mark: "Ended on a question",
        placeholder: "answer — goes to the card as your reply, and wakes it",
        send: "answer",
      };
    case "error":
      return {
        mark: "Stopped on an error",
        placeholder: "follow up — goes to the card as your next message, and wakes it",
        send: "follow up",
      };
    case "card":
      return {
        mark: n.askId ? "Notice — waiting on you" : "Notice",
        placeholder: n.askId
          ? "follow up — the card is waiting and reads it at once"
          : "follow up — goes to the card as a message naming this notice",
        send: "follow up",
      };
    default:
      return {
        mark: "Finished",
        placeholder: "follow up — goes to the card as your next message, and wakes it",
        send: "follow up",
      };
  }
}

/** What a follow-up sends to the card.
 *
 *  A rest notice is about the card's last turn, so your words are simply your
 *  next message — the card has the context and nothing needs quoting. A card's
 *  own notice may be hours and several turns old, so the follow-up names it,
 *  `answerEnvelope`'s reasoning for a deferred question. No relay mark either
 *  way: these are your words, and Volery only carried them. */
export function followUpText(n: Pick<Notice, "kind" | "text">, reply: string): string {
  const said = reply.trim();
  if (n.kind !== "card") return said;
  const quoted = n.text
    .trim()
    .split("\n")
    .slice(0, 6)
    .map((l) => `> ${l}`)
    .join("\n");
  return `About the notice you sent me:\n\n${quoted}\n\n${said}`;
}

/** What a parked notice's call returns to the agent. */
export const NOTICE_ACK =
  "The user acknowledged your notice and added nothing. Carry on.";

export function parkedReply(reply?: string): string {
  const said = (reply ?? "").trim();
  return said ? `The user read your notice and replied:\n\n${said}` : NOTICE_ACK;
}

/** One line of it, for the peek and the register: markdown off the front. */
export function noticeLine(text: string): string {
  for (const raw of text.split("\n")) {
    const l = raw.trim().replace(/^[#>*\-\s]+/, "").replace(/\*\*|`/g, "").trim();
    if (l && !l.startsWith("```")) return l;
  }
  return "";
}

/** A notice row as Rust serialises it, made into the front end's shape. */
export function noticeFromRow(r: any): Notice | null {
  if (!r || typeof r.id !== "string" || typeof r.conversation_id !== "string") return null;
  const kind: NoticeKind = (["done", "question", "error", "card"] as const).includes(r.kind)
    ? r.kind
    : "done";
  return {
    id: r.id,
    conversationId: r.conversation_id,
    kind,
    text: typeof r.text === "string" ? r.text : "",
    raisedAt: typeof r.raised_at === "number" ? r.raised_at : 0,
    away: r.away === true,
    waited: r.waited === true,
  };
}
