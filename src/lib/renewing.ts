/** A card's context as its price, and a coordinator renewing itself.
 *
 *  Pure. `renew.rs` is the mechanism and the argument; this is the part the
 *  wall draws and the one prompt it composes.
 *
 *  **A card's context size is its price per request** (sink `ef384c69`): every
 *  request it makes — each tool call, not only each turn — re-reads the whole
 *  conversation, and on this wall that re-reading is most of the bill. A ring at
 *  48% says how full the memory is; "every request re-reads 480k tokens" says
 *  what that fullness costs, which is the reading that makes renewing or
 *  compacting a decision taken while it is cheap. Tokens rather than dollars:
 *  this wall mostly runs on subscriptions, where a dollar figure is a rate
 *  card's opinion and a token count is the thing the allowance is spent in. */

/** Tokens as a person reads them on a card: `480k`, `1.8k`, `640`. */
export function tokensShort(tokens: number): string {
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.max(0, Math.round(tokens))}`;
}

/** The per-request price, in the words the wall uses everywhere it is said. */
export function rereads(tokens: number): string {
  return `every request re-reads ${tokensShort(tokens)} tokens`;
}

/** Where a coordinator starts wearing the quiet mark. Lyss chose the mark
 *  (2026-11-02) over a wall that prompts the card on its own: nothing is sent,
 *  nothing is spent, and the decision stays with her or the card. 300k is where
 *  a context costs a coordinator more per request than most children cost in a
 *  whole turn (median child request ~33k units, the RISE coordinator's ~76k). */
export const RENEW_MARK_FROM = 300_000;

/** Whether a card is worth the mark: large, and coordinating — it has cards
 *  open under it, which is the role renewing keeps and the cost it saves. A big
 *  card with no children is a long piece of work, and `compact` is its remedy. */
export function renewWorth(ctxTokens: number, children: number): boolean {
  return children > 0 && ctxTokens >= RENEW_MARK_FROM;
}

export function renewMarkTitle(ctxTokens: number, children: number): string {
  return (
    `${rereads(ctxTokens)}, with ${children} card${children === 1 ? "" : "s"} open under it — ` +
    `at a round boundary it could renew: a fresh session from a note it writes, keeping its ` +
    `children, subscriptions and wakes (right-click → renew it, or space then c n)`
  );
}

/** How long a card must sit idle after its turn before the wall renews it. A
 *  prompt written into a card mid-turn is queued by the CLI and taken up about
 *  1.5s after the turn's `result` (`turns.md`, measured by `probe-queue.ts`);
 *  renewing inside that gap would end the process holding a message it had just
 *  taken. Twice that, so a queued message is answered in the old session rather
 *  than lost between the two. */
export const RENEW_AFTER_MS = 3_000;

/** What the wall sends when Lyss asks a card to renew — her gesture, so it is
 *  her prompt and drawn as hers. The card writes the note, because only the
 *  card knows what it decided; the wall appends the rest. */
export const RENEW_ASK =
  "Renew yourself now, at this boundary. Write the handoff note your next session will start " +
  "from — what was decided and why, what is in flight and what you are waiting on, what comes " +
  "next, and which files hold your durable notes — and call `mcp__skein__renew` with it, then " +
  "end your turn. Your children, subscriptions, wakes and notices stay yours; the wall lists " +
  "them under your note, so you need not.";
