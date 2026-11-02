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

/** The three ways `renew_conversation` declines, as the prefixes `renew.rs`
 *  writes (`NOT_SCHEDULED`, `BUSY`, `DROPPED`). `test/renewing.test.ts` reads
 *  them out of the Rust so the two cannot drift. */
export const RENEW_NOT_SCHEDULED = "not-scheduled:";
export const RENEW_BUSY = "busy:";
export const RENEW_DROPPED = "dropped:";

/** What the wall does with a renewal Rust declined to perform.
 *
 *  - `gone` — nothing is scheduled any more (performed elsewhere, dropped, the
 *    wall restarted): stop waiting for it. Keeping the id is how a renewal
 *    abandoned once used to kill the card three seconds after every later turn.
 *  - `later` — mid-turn, or a spawn was starting: ask again after it.
 *  - `dropped` — Rust gave it up because something would be lost, and told the
 *    card why; stop waiting, and say so on the card.
 *  - `failed` — anything else: stop waiting and raise it, since an error this
 *    side cannot read is not one a retry is known to fix. */
export type RenewDeclined = "gone" | "later" | "dropped" | "failed";

export function renewDeclined(err: string): RenewDeclined {
  const s = err.replace(/^Error:\s*/, "");
  if (s.startsWith(RENEW_NOT_SCHEDULED)) return "gone";
  if (s.startsWith(RENEW_BUSY)) return "later";
  if (s.startsWith(RENEW_DROPPED)) return "dropped";
  return "failed";
}

/** Whether the CLI holds a schedule that has **not fired yet** — the question a
 *  renewal asks, which is not the reaper's. `timersArmed` errs late on purpose
 *  (`until` carries fifteen minutes of slack, so a stood-down card never loses a
 *  firing); asked here, that slack refused a renewal for a quarter of an hour
 *  after a `ScheduleWakeup` had already woken the card — exactly the loop a
 *  coordinator renews in. So a one-shot counts while its moment is ahead, a
 *  recurring job while it lives, and a one-shot whose moment could not be read
 *  not at all: refusing on it would refuse for the life of the process. */
export function scheduleAhead(
  timers: readonly { at: number | null; until: number | null }[],
  now: number,
): boolean {
  return timers.some((t) => (t.at !== null ? t.at > now : t.until !== null && t.until > now));
}

/** What only the front end can see that a renewal would destroy: background
 *  jobs it has folded (a row may not be written yet) and the CLI's own
 *  `CronCreate` / `ScheduleWakeup`, which live in the old process and nowhere
 *  else — `keptFrom`'s `jobs` and `scheduled` arms, for the same reason. Rust
 *  abandons the renewal with this sentence and tells the card it, rather than
 *  holding its post for as long as the work runs. `null` when nothing would be
 *  lost. Worded to finish `not performed: …`. */
export function renewBlocker(card: {
  jobs: number;
  timers: readonly { at: number | null; until: number | null }[];
  now: number;
}): string | null {
  if (card.jobs > 0) {
    return (
      `this card has ${card.jobs} background job${card.jobs === 1 ? "" : "s"} still running, ` +
      `and renewing would end ${card.jobs === 1 ? "it" : "them"} with the process. Renew once ` +
      `${card.jobs === 1 ? "it has" : "they have"} reported in.`
    );
  }
  if (scheduleAhead(card.timers, card.now)) {
    return (
      "this card has a schedule armed in its own process (CronCreate or ScheduleWakeup), and " +
      "renewing would end it with the process. Delete it or let it fire, then renew."
    );
  }
  return null;
}
