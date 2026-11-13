import { capFor, shareFor, type Account, type Allowance, type SelfUse } from "./accounts";
import { CREDITS, type Decision } from "./credits";
import type { PaceHold } from "./pace";

/** What the wall tells Rust about its allowance, so a spawn, a wake and a
 *  stop notice can be weighed without asking the webview (`admit.rs`).
 *
 *  **The front end says the outcome, never the policy.** Which account a new
 *  card would land on is `credits.ts::route` over `accounts.ts::choose` — the
 *  caps, the tiers, the refusals the stream has heard and boost all live there,
 *  and Rust re-deciding any of it would be the second copy that drifts. So this
 *  is a summary of a few decisions: one for a card with nothing to stick to,
 *  the same with a card's bypass of your caps (which is all a held wake or
 *  notice for a bypassed card needs), and one for a card asked onto each
 *  account — since a spawn that names an account lands there while it has room
 *  (`stickTo`), and that is the account its admission has to be weighed on.
 *  `admit.rs` holds the rule that reads it (85% of the five hours, Lyss's
 *  number), and only there.
 *
 *  Pure, per the purity boundary: `Skein.#noteAllowance` asks the waterfall and
 *  hands the answers in. */
export type AllowanceFacts = {
  /** No account, and no credits, would take a new card. */
  held: boolean;
  /** When the first door opens, where the blocker named one. */
  until: number | null;
  /** The same for a card bypassing your caps — held only by the server. */
  heldBypass: boolean;
  untilBypass: number | null;
  /** The account a new card would land on — null for credits (an account's
   *  own usage credits included, with boost on), a held wall, or a wall with
   *  nothing to place it on. */
  landing: string | null;
  /** How close `landing`'s five-hour window is to its ceiling, 0..1. */
  spent: number | null;
  /** When that window resets. */
  resetsAt: number | null;
  /** A card asked onto each account, and where it really lands. */
  asked: AskedFacet[];
  /** The accounts whose own plan is holding new work right now (`pace.ts`
   *  §14), with the sentence and the week's reset. **A pace has no account to
   *  find room on**, so it is not a fifth kind of blocker: it is a reason the
   *  admission gate holds that clears on the wall's own tick, not on a window
   *  coming back. `admit.rs` only reads this. */
  plans: PlanHold[];
};

/** One account's pace, as Rust is told it (`admit::Planned`). */
export type PlanHold = PaceHold & { account: string };

/** Where one card lands and how near that is (`admit::Facet`). */
export type Facet = { landing: string | null; spent: number | null; resetsAt: number | null };
export type AskedFacet = Facet & { account: string };

/** What Rust says about a new card that is not to start yet
 *  (`admit::Queued`): the face's line, when it starts at the latest, and —
 *  where the wait is a plan's pace — that it is one, so a release pass knows
 *  there is no account reading it would need to go and fetch. */
export type Queued = { why: string; until: number | null; reason?: "pace" };

/** How long the front end leaves between two held prompts it releases on its
 *  own, once there is more than one — `admit::RELEASE_GAP_MS`, held equal by a
 *  test. A reset frees every held card at once, and each is a cold cache. */
export const RELEASE_GAP_MS = 3_000;

const EMPTY: Facet = { landing: null, spent: null, resetsAt: null };

export const NOTHING_KNOWN: AllowanceFacts = {
  held: false,
  until: null,
  heldBypass: false,
  untilBypass: null,
  ...EMPTY,
  asked: [],
  plans: [],
};

/** How close an account's **five-hour** window is to its ceiling.
 *
 *  `accounts.ts::spentOf`'s arithmetic — the same `capFor` denominator, so
 *  "85% spent" here means what the balancer means by it — over one window
 *  rather than the fullest. Lyss's 85% was chosen against the five hours ("on a
 *  5-hour window that leaves roughly 45 minutes"), so a week at 86% must not
 *  queue a fan-out for days, and a model-scoped week (the Opus week full) must
 *  not queue a lane on another model. A week that is actually spent is not a
 *  nearness question: `blockersFor` blocks the account and the landing account
 *  is another one. An unmeasured account — or one whose reading carries no
 *  session window — is `null` rather than 0, because a queue decided on a
 *  reading nobody took would be a guess presented as a number. */
export function nearness(
  account: Account,
  allowance: Allowance | undefined,
  /** Your own share, on `blockersFor`'s terms. A queue held behind somebody
   *  else's 85% is the same complaint the cap itself had. */
  self: readonly SelfUse[] = [],
): { spent: number; resetsAt: number | null } | null {
  if (!allowance || !allowance.ok) return null;
  let worst: { spent: number; resetsAt: number | null } | null = null;
  for (const w of allowance.windows) {
    if (w.group !== "session") continue;
    const used = shareFor(w, self).points;
    const cap = capFor(account, w.kind, false);
    const spent = cap <= 0 ? 1 : used / cap;
    if (!worst || spent > worst.spent) worst = { spent, resetsAt: w.resetsAt };
  }
  return worst;
}

/** What the lookup knows about one account. `credits` is true where boost is
 *  on and the account's own usage credits cover a send — then the window
 *  filling is a bill rather than a wall, and nothing need finish first. */
export type Looked = {
  account: Account;
  allowance: Allowance | undefined;
  self: readonly SelfUse[];
  credits: boolean;
};

/** Where one decision lands, and how near. */
export function facetOf(d: Decision, lookup: (label: string) => Looked | null): Facet {
  /* A hold is said apart (`held`); nothing signed in or switched on is a fault
     to go and fix, not a wait — it never ends by itself, so nothing may be held
     behind it. */
  if (d.kind !== "use") return EMPTY;
  /* Credits are boost: a decision already made to keep work moving with money,
     and a queue would overrule it. */
  if (d.label === CREDITS) return EMPTY;
  const found = lookup(d.label);
  /* The same decision made with the account's own usage credits. */
  if (found?.credits) return EMPTY;
  const near = found ? nearness(found.account, found.allowance, found.self) : null;
  return { landing: d.label, spent: near?.spent ?? null, resetsAt: near?.resetsAt ?? null };
}

/** The facts the decisions for a new card amount to: `plain` for a card with
 *  nothing to stick to, `bypass` for the same with the caps ignored, and one
 *  decision per account a spawn could be asked onto. */
export function allowanceFacts(
  plain: Decision,
  lookup: (label: string) => Looked | null,
  more: {
    bypass?: Decision;
    asked?: { account: string; decision: Decision }[];
    /** The accounts whose plan is holding new work (`Skein.#noteAllowance`).
     *  Read whole rather than derived from a decision: a plan belongs to the
     *  account it is stored with, whether or not the ladder would land a card
     *  there. */
    plans?: readonly PlanHold[];
  } = {},
): AllowanceFacts {
  const bypass = more.bypass ?? plain;
  return {
    held: plain.kind === "hold",
    until: plain.kind === "hold" ? plain.until : null,
    heldBypass: bypass.kind === "hold",
    untilBypass: bypass.kind === "hold" ? bypass.until : null,
    ...facetOf(plain, lookup),
    asked: (more.asked ?? []).map((a) => ({ account: a.account, ...facetOf(a.decision, lookup) })),
    plans: (more.plans ?? []).map((p) => ({ ...p })),
  };
}

/** A percent is the precision the rule reads at; a flicker inside one is not
 *  a change worth a write. */
const pct = (s: number | null) => Math.floor((s ?? -1) * 100);

function sameFacet(a: Facet, b: Facet): boolean {
  return a.landing === b.landing && a.resetsAt === b.resetsAt && pct(a.spent) === pct(b.spent);
}

/** Whether two notes say the same thing — so the wall writes to Rust when the
 *  fact changes, and on the sweep's minute to keep it from going stale.
 *
 *  **A pace is compared by which accounts and until when, not by its
 *  sentence.** The sentence carries the week's percentage, which moves a whole
 *  point every few minutes, and rewriting a note because a numeral moved is a
 *  write that changes nothing the wall will do. The sentence Rust holds is the
 *  one from when the hold began, and a reading that is minutes old is exactly
 *  what the hold was decided on. */
export function sameFacts(a: AllowanceFacts | null, b: AllowanceFacts): boolean {
  return (
    a !== null &&
    a.held === b.held &&
    a.until === b.until &&
    a.heldBypass === b.heldBypass &&
    a.untilBypass === b.untilBypass &&
    sameFacet(a, b) &&
    a.asked.length === b.asked.length &&
    a.asked.every((x, i) => x.account === b.asked[i]!.account && sameFacet(x, b.asked[i]!)) &&
    a.plans.length === b.plans.length &&
    a.plans.every((x, i) => x.account === b.plans[i]!.account && x.until === b.plans[i]!.until)
  );
}
