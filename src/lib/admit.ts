import { capFor, type Account, type Allowance } from "./accounts";
import { CREDITS, type Decision } from "./credits";

/** What the wall tells Rust about its allowance, so a spawn, a wake and a
 *  stop notice can be weighed without asking the webview (`admit.rs`).
 *
 *  **The front end says the outcome, never the policy.** Which account a new
 *  card would land on is `credits.ts::route` over `accounts.ts::choose` — the
 *  caps, the tiers, the refusals the stream has heard and boost all live there,
 *  and Rust re-deciding any of it would be the second copy that drifts. So this
 *  is a summary of one decision for a card with nothing to stick to: held, or
 *  landing on an account this close to its ceiling. `admit.rs` holds the rule
 *  that reads it (85%, Lyss's number), and only there.
 *
 *  Pure, per the purity boundary: `Skein.#noteAllowance` asks the waterfall and
 *  hands the answers in. */
export type AllowanceFacts = {
  /** No account, and no credits, would take a new card. */
  held: boolean;
  /** When the first door opens, where the blocker named one. */
  until: number | null;
  /** The account a new card would land on — null for credits, a held wall, or
   *  a wall with nothing to place it on. */
  landing: string | null;
  /** How close `landing` is to its ceiling, 0..1 (past 1 is over a cap). */
  spent: number | null;
  /** When the window behind `spent` resets. */
  resetsAt: number | null;
};

/** What Rust says about a new card that is not to start yet
 *  (`admit::Queued`): the face's line, and when it starts at the latest. */
export type Queued = { why: string; until: number | null };

export const NOTHING_KNOWN: AllowanceFacts = {
  held: false,
  until: null,
  landing: null,
  spent: null,
  resetsAt: null,
};

/** How close an account is to its ceiling, and the window that says so.
 *
 *  `accounts.ts::spentOf`'s arithmetic — the same window set and the same
 *  `capFor` denominator, so "85% spent" here means exactly what the balancer
 *  means by it — and the one thing `spentOf` throws away: *which* window, whose
 *  reset is when a card queued against it starts. An unmeasured account is
 *  `null` rather than 0, because a queue decided on a reading nobody took would
 *  be a guess presented as a number. */
export function nearness(
  account: Account,
  allowance: Allowance | undefined,
): { spent: number; resetsAt: number | null } | null {
  if (!allowance || !allowance.ok || allowance.windows.length === 0) return null;
  let worst: { spent: number; resetsAt: number | null } | null = null;
  for (const w of allowance.windows) {
    const used = Number.isFinite(w.used) ? Math.max(0, w.used) : 0;
    const cap = capFor(account, w.kind, false);
    const spent = cap <= 0 ? 1 : used / cap;
    if (!worst || spent > worst.spent) worst = { spent, resetsAt: w.resetsAt };
  }
  return worst;
}

/** The facts one decision for a new card amounts to. */
export function allowanceFacts(
  d: Decision,
  lookup: (label: string) => { account: Account; allowance: Allowance | undefined } | null,
): AllowanceFacts {
  if (d.kind === "hold") return { ...NOTHING_KNOWN, held: true, until: d.until };
  /* Nothing signed in or switched on is a fault to go and fix, not a wait —
     it never ends by itself, so nothing may be held behind it. */
  if (d.kind === "none") return NOTHING_KNOWN;
  /* Credits are boost: a decision already made to keep work moving with money,
     and a queue would overrule it. */
  if (d.label === CREDITS) return NOTHING_KNOWN;
  const found = lookup(d.label);
  const near = found ? nearness(found.account, found.allowance) : null;
  return {
    ...NOTHING_KNOWN,
    landing: d.label,
    spent: near?.spent ?? null,
    resetsAt: near?.resetsAt ?? null,
  };
}

/** Whether two notes say the same thing — so the wall writes to Rust when the
 *  fact changes, and on the sweep's minute to keep it from going stale. */
export function sameFacts(a: AllowanceFacts | null, b: AllowanceFacts): boolean {
  return (
    a !== null &&
    a.held === b.held &&
    a.until === b.until &&
    a.landing === b.landing &&
    a.resetsAt === b.resetsAt &&
    /* A percent is the precision the rule reads at; a flicker inside one is
       not a change worth a write. */
    Math.floor((a.spent ?? -1) * 100) === Math.floor((b.spent ?? -1) * 100)
  );
}
