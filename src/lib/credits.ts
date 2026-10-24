/** Credits, and boost mode: a card that runs on the organisation's API credits
 *  when the account it was on runs out.
 *
 *  Pure, and the whole of the policy. `purse.svelte.ts` holds the state,
 *  `skein.svelte.ts` does the moving, `credits.rs` is what being on credits means
 *  for a child process. `.claude/rules/accounts.md`, *Credits and boost mode*,
 *  has the reasoning, including the one sentence in Anthropic's terms the whole
 *  feature stands on: `claude -p` run with an API key from the linked
 *  organisation is billed as Agent SDK usage, which the monthly credits cover. */

import type { Choice } from "./accounts";

/** What a card on credits carries where an account label goes. `credits.rs`
 *  holds the same string and `test/credits.test.ts` reads it there; no account
 *  can be called this, because `accounts.rs::is_label` refuses `@`. */
export const CREDITS = "@credits";

export function onCredits(label: string | null | undefined): boolean {
  return label === CREDITS;
}

/** What a face calls a card's funding: the account's own label, or `credits`. */
export function fundingName(label: string | null): string | null {
  return label === CREDITS ? "credits" : label;
}

/** The month's ceiling on credits when nobody has set one: the most a Team
 *  plan's monthly credit can be. Yours, not the Console's — the Console's spend
 *  limit on the key's workspace is the one that cannot be crossed. */
export const DEFAULT_BUDGET = 500;

/** The first instant of this month, on the local calendar. Credits refresh on
 *  the plan's billing cycle, which nothing here knows; the calendar month is
 *  what the Console's own spend caps reset on, and the closest honest window. */
export function monthStart(now: number): number {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** And the first instant of the next one, which is when a spent budget lifts. */
export function nextMonth(now: number): number {
  const d = new Date(monthStart(now));
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/* ── refusals ─────────────────────────────────────────────────────────────*/

/** Why credits stopped taking work, as the API said it.
 *
 *  - `balance`: the organisation's credits are gone ("credit balance is too
 *    low"). They come back with next month's grant or a purchase, so the wall
 *    stops trying for hours rather than minutes.
 *  - `key`: the key was refused (401). Nothing comes back until the key is
 *    replaced, which the keyring's write clears.
 *  - `rate`: the organisation's rate limit (429). Weather, not money: a minute,
 *    doubling. */
export type CreditRefusal = "balance" | "key" | "rate";

export type CreditMark = { kind: CreditRefusal; until: number; strikes: number; at: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The next mark, given the one standing. A refusal arriving while one stands
 *  is the same news from another card — `accounts.ts::refuse`'s rule — so it
 *  does not count as a second strike. */
export function refuseCredits(held: CreditMark | null, kind: CreditRefusal, now: number): CreditMark {
  if (held && held.until > now && held.kind === kind) return { ...held, at: now };
  const strikes = held && held.kind === kind ? held.strikes + 1 : 1;
  const wait =
    kind === "rate"
      ? Math.min(MINUTE * 2 ** Math.min(strikes - 1, 8), 10 * MINUTE)
      : Math.min(HOUR * 2 ** Math.min(strikes - 1, 8), 6 * HOUR);
  return { kind, until: now + wait, strikes, at: now };
}

export function sayCreditRefusal(kind: CreditRefusal): string {
  if (kind === "balance") return "the organisation's credit balance is too low";
  if (kind === "key") return "the api key was refused — check it in the keyring";
  return "the api is rate limiting the organisation";
}

/* ── whether credits can take work ────────────────────────────────────────*/

export type Purse = {
  boost: boolean;
  /** Whether a key is stored. Null until the vault has been asked, and read as
   *  yes: a spawn without one fails loudly, which is the honest end of a guess,
   *  where reading "not asked" as "no" would turn boost off over a race. */
  keyHeld: boolean | null;
  /** Your ceiling for the month, in dollars, or null for none. */
  budget: number | null;
  /** What this wall's cards have spent on credits this month. */
  spent: number;
  refused: CreditMark | null;
};

export type CreditsStanding = { ready: true } | { ready: false; why: string; until: number | null };

export function creditsStanding(p: Purse, now: number): CreditsStanding {
  if (!p.boost) return { ready: false, why: "boost is off", until: null };
  if (p.keyHeld === false) {
    return { ready: false, why: "no anthropic api key is stored — add one in the keyring", until: null };
  }
  if (p.budget !== null && p.spent >= p.budget) {
    return {
      ready: false,
      why: `this month's credits are spent — ${money(p.spent)} of the ${money(p.budget)} you allowed`,
      until: nextMonth(now),
    };
  }
  if (p.refused && p.refused.until > now) {
    return { ready: false, why: sayCreditRefusal(p.refused.kind), until: p.refused.until };
  }
  return { ready: true };
}

/* ── where a card goes ────────────────────────────────────────────────────*/

/** An account's state as the chooser sees it, refusals included. */
export type AccountState = "ready" | "blocked" | "unusable";

export type Decision =
  /** Run on `label`. `home` is set only with `CREDITS` — the account the card
   *  stands in for. `why` is what the move (if any) is to be called. */
  | { kind: "use"; label: string; home: string | null; why: "stay" | "credits" | "home" | "ladder" }
  | Extract<Choice, { kind: "hold" }>
  | Extract<Choice, { kind: "none" }>;

/** Where a card's next turn runs, with boost in the picture.
 *
 *  **The rule is Lyss's, 2026-10-24**, put to her against one afternoon on her
 *  own wall: *"When boost mode is on, cards first try to use normal account
 *  allowance; when it runs out on the account they were using, instead of
 *  switching to the next account in the ladder, they switch to credits."* So:
 *
 *  - A card whose own account is **blocked** goes onto credits rather than down
 *    the ladder, and remembers that account as its home.
 *  - A **new** card (nothing to stick to) takes the ladder as it always did, and
 *    goes onto credits only where the ladder would hold it.
 *  - A card on credits **goes home** at its next message once its home has room
 *    — every turn on credits is money and every turn at home is not, so the one
 *    uncached re-read the move costs is the cheaper side. A card with no home
 *    (it started on credits) goes to any account with room.
 *  - When credits cannot take work — boost off, no key, your budget spent, a
 *    refusal standing — everything is the ladder exactly as before, a card on
 *    credits starting from its home.
 *
 *  - **Anything the ladder cannot place goes onto credits at once** — every
 *    account spent, *or* switched off, *or* signed out. Lyss, the same day: *"all
 *    accounts are already used or off and I spawn a card in boost mode, it should
 *    use credits right away."* So a new card spawns on credits rather than being
 *    held, and a held card is released onto them.
 *
 *  An account that is merely **unusable** (switched off, signed out) is not one
 *  that ran out, so while another account has room its card goes down the
 *  ladder as before — a switch you flipped keeps meaning what it meant — and it
 *  is only where the ladder has nowhere to put it that credits take it. */
export function route(input: {
  current: string | null;
  home: string | null;
  credits: CreditsStanding;
  ladder: (stickTo: string | null) => Choice;
  state: (label: string) => AccountState;
}): Decision {
  const { current, credits, ladder, state } = input;

  if (onCredits(current)) {
    /* A home that has gone away — switched off, removed — is no home: the card
       is then treated as one that started here. */
    const home = input.home !== null && state(input.home) !== "unusable" ? input.home : null;
    if (credits.ready) {
      if (home !== null) {
        return state(home) === "ready"
          ? { kind: "use", label: home, home: null, why: "home" }
          : { kind: "use", label: CREDITS, home, why: "stay" };
      }
      const c = ladder(null);
      return c.kind === "use"
        ? { kind: "use", label: c.label, home: null, why: "home" }
        : { kind: "use", label: CREDITS, home: null, why: "stay" };
    }
    const c = ladder(home);
    return c.kind === "use" ? { kind: "use", label: c.label, home: null, why: "ladder" } : c;
  }

  const c = ladder(current);
  if (c.kind === "use" && c.label === current) {
    return { kind: "use", label: current, home: null, why: "stay" };
  }
  if (credits.ready) {
    if (current !== null && state(current) === "blocked") {
      return { kind: "use", label: CREDITS, home: current, why: "credits" };
    }
    if (c.kind !== "use") return { kind: "use", label: CREDITS, home: null, why: "credits" };
  }
  return c.kind === "use" ? { kind: "use", label: c.label, home: null, why: "ladder" } : c;
}

/* ── saying it ────────────────────────────────────────────────────────────*/

/** The transcript's line when a card goes onto credits. By `swapNote`'s rule:
 *  nothing Volery does on its own is quiet, and a card starting to spend money
 *  per token is the last thing that should be. */
export function ontoCreditsNote(from: string | null, why: string): string {
  const leaving = from ? `moved from ${from} onto credits — ${why}` : `put on credits — ${why}`;
  const back = from ? `; it goes back to ${from} when that has room` : "";
  return `${leaving}. boost is on, so this card now spends the organisation's api credits, billed per token${back}. the next turn re-reads this conversation uncached`;
}

/** And when it comes off them. */
export function offCreditsNote(to: string, why: "home" | "ladder", reason: string | null): string {
  const because = why === "home" ? `${to} has room again` : reason ?? "credits stopped taking work";
  return `moved from credits back to ${to} — ${because}. the next turn re-reads this conversation uncached`;
}

/** The title bar's reading while boost is on. */
export function sayPurse(p: Purse, now: number): string {
  const month = new Date(now).toLocaleString("en", { month: "long" }).toLowerCase();
  const spent = money(p.spent);
  return p.budget === null
    ? `${spent} on credits in ${month}`
    : `${spent} of ${money(p.budget)} on credits in ${month}`;
}

/** The boost button's own words: the switch, and while it is on what credits
 *  have cost this month — the one figure worth a glance while money is moving. */
export function boostLabel(p: Purse): string {
  if (!p.boost) return "boost";
  return p.budget === null ? `boost · ${money(p.spent)}` : `boost · ${money(p.spent)} of ${money(p.budget)}`;
}

/** What the boost button's tooltip says, which is also its state in words. */
export function sayBoost(p: Purse, standing: CreditsStanding): string {
  if (!p.boost) {
    return "boost is off — when an account runs out, cards move down the ladder or wait (space then m b)";
  }
  if (!standing.ready) return `boost is on, but credits are not taking work: ${standing.why} (space then m b)`;
  return "boost is on — a card whose account runs out carries on with the organisation's api credits (space then m b)";
}

/** Dollars, whole above ten, cents below: the figure moves by cents a turn and a
 *  budget is a round number, and both read cleanly in the same slot. */
export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/** A budget typed into a field, or null for "no ceiling". Anything that is not a
 *  non-negative number is no change rather than a guess. */
export function parseBudget(raw: string): { ok: true; budget: number | null } | { ok: false } {
  const t = raw.trim().replace(/^\$/, "");
  if (t === "" || t === "none") return { ok: true, budget: null };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? { ok: true, budget: n } : { ok: false };
}
