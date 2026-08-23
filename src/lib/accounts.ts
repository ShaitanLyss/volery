/* Which account the next turn goes to, and what to do when the answer is none.
 *
 * `limits.ts` answers "how much of this account is gone"; this answers "so
 * which one do we use". The same split, one rung up: `accounts.rs` holds the
 * registry and the credential, and every question of *policy* is here, pure and
 * tested — because the policy is the part that will be argued about, and an
 * argument is worth having against tests.
 *
 * The whole of `.claude/rules/accounts.md` is the reasoning. The three rules
 * that shape every function below:
 *
 *  - **The order is an order.** Lowest rank that is allowed to work gets the
 *    work. Never the one with the most headroom — spreading by headroom leaves
 *    three part-spent subscriptions and no clean one, and a reserve is only a
 *    reserve if something guards it.
 *  - **Two ceilings, and only one of them is yours.** A cap you set is a
 *    decision you can unmake; the server's 100% is a fact you can only wait
 *    out. They are kept apart all the way to the face because they mean
 *    opposite things to whoever reads it.
 *  - **A bypass moves your ceiling and never the server's.** Nothing here can
 *    promise work through a real refusal, so nothing here pretends to.
 */

import { binding, until, type Window } from "./limits";

/** One account as the registry holds it. No credential: an account *is* a
 *  Claude Code credential store (`~/.claude/accounts/<label>/`), the CLI owns
 *  what is in it, and nothing of it enters this process — see `accounts.rs`.
 *  `signedIn` is the registry's word on whether that store holds a credential,
 *  which is a different question from whether the credential in it is still
 *  fresh: an access token expires and the CLI refreshes it on the account's next
 *  turn. `standingOf` is where that distinction is drawn. */
export type Account = {
  label: string;
  /** Lower goes first. Dense or sparse, both fine — only the order is read. */
  rank: number;
  enabled: boolean;
  /** Window `kind` → the percentage past which this account stops taking new
   *  work. Absent means no ceiling of yours, which leaves the server's. */
  caps: Record<string, number>;
  signedIn: boolean;
};

/** The last allowance reading for one account, or why there isn't one. Mirrors
 *  what `read_allowances` hands over per account: a fault is not the same as an
 *  account being full, and the two must never collapse into each other. */
export type Allowance =
  | { ok: true; windows: Window[]; at: number }
  | { ok: false; fault: string };

/** One window standing in the way, and whose ceiling it is.
 *
 *  `by` is the whole reason this type exists rather than a bare `Window[]`.
 *  "You said 80%" and "the account is spent" want different words, different
 *  colours and different offers — one has a button that fixes it and the other
 *  has a clock. */
export type Blocker = {
  window: Window;
  by: "you" | "server";
  resetsAt: number | null;
};

export type Standing =
  /** Will take work. `unmeasured` is set when it will take work *without* its
   *  allowance having been read — the account is signed in and switched on, but
   *  nothing current is known about how full it is, so your caps cannot be
   *  applied to it this moment. It still goes: see `standingOf`. */
  | { state: "ready"; label: string; unmeasured?: string }
  /** Signed in, measured, and simply full — or full enough. */
  | { state: "blocked"; label: string; blockers: Blocker[]; availableAt: number | null }
  /** Cannot be used at all, and waiting will not change it: not signed in, or
   *  switched off. **Not** "the allowance could not be read" — that was this
   *  type's worst bug and is documented on `standingOf`. */
  | { state: "unusable"; label: string; why: string };

/** The server's own rejection words, from `limits.ts::tierOf` — kept in step
 *  with it deliberately, since a severity that means "urgent" there and
 *  "nothing special" here would draw a card calm while it was being refused. */
const REJECTED = new Set(["rejected", "exceeded"]);

/** How full this account is allowed to get on this window, 0–100.
 *
 *  A cap above 100 is not a cap and is read as none rather than honoured, so a
 *  slider dragged to the end cannot quietly come to mean "and past the real
 *  limit too". A cap of 0 is honoured, and means exactly what it says: never
 *  start work on this account. That is a legitimate way to hold one in reserve
 *  without deleting it, so it is not treated as "unset". */
export function capFor(account: Account, kind: string, bypass: boolean): number {
  if (bypass) return 100;
  const cap = account.caps[kind];
  if (cap === undefined || !Number.isFinite(cap)) return 100;
  if (cap > 100 || cap < 0) return 100;
  return cap;
}

/** Every window standing in the way of new work on this account.
 *
 *  A window counts as the server's when it is at or past 100, or when the
 *  server has already put a rejection word on it — and the server's word is
 *  taken even below 100, because it knows things this does not: an org
 *  restriction, a spend limit, a refusal already issued. That check is ahead of
 *  the cap check so a bypass can never talk a real rejection into being one of
 *  yours.
 *
 *  `>=` rather than `>` on both, and it matters at the edges. A window at
 *  exactly 100 is spent, and a cap of 80 that admitted work at 80.0 would be a
 *  ceiling you set and then stood on. */
export function blockersFor(
  account: Account,
  windows: Window[],
  bypass: boolean,
): Blocker[] {
  const out: Blocker[] = [];
  for (const w of windows) {
    if (w.used >= 100 || REJECTED.has(w.severity.toLowerCase())) {
      out.push({ window: w, by: "server", resetsAt: w.resetsAt });
      continue;
    }
    const cap = capFor(account, w.kind, bypass);
    if (cap < 100 && w.used >= cap) {
      out.push({ window: w, by: "you", resetsAt: w.resetsAt });
    }
  }
  return out;
}

/** When every one of these blockers has cleared, or null if that is unknowable.
 *
 *  The *latest* of them, because the account is not free until the last window
 *  standing in the way has rolled. A blocker naming no reset — which a scoped
 *  window nobody has touched genuinely does — makes the whole answer unknown
 *  rather than being skipped: skipping it would produce a confident time that
 *  arrives to find the account still blocked, and a countdown that lies once
 *  will not be believed again. Unknown is honest, and the caller has a second
 *  way out (the next allowance poll) that needs no time at all. */
export function availableAt(blockers: Blocker[]): number | null {
  if (blockers.length === 0) return null;
  let out = 0;
  for (const b of blockers) {
    if (b.resetsAt === null) return null;
    if (b.resetsAt > out) out = b.resetsAt;
  }
  return out;
}

/* ── the one window an account speaks with ────────────────────────*/

/** Which window stands for a whole account where there is one line per account,
 *  and whether that window is a ceiling rather than a reading.
 *
 *  `ceiling` is why this is a record and not a bare `Window`. A week stopped at
 *  the cap *you* set reads 60%, and wants the same rust as one the server has
 *  refused — which nothing in `limits.ts::tierOf` can work out, since it reads
 *  the server's severity and our own thresholds and neither has ever heard of
 *  your caps. And it is the blocker rather than a flag because whose ceiling it
 *  is survives all the way to the face here as it does everywhere else in this
 *  file: 60% in rust with no word about a cap is a face that looks broken. */
export type Spoken = {
  window: Window | null;
  /** The week's ceiling, where one has been reached — null while the reading is
   *  the five hours and nothing is standing in the way. */
  ceiling: Blocker | null;
};

/** The five-hour window, unless the week has run out.
 *
 *  This used to be `limits.ts::binding` — the fullest window, whatever clock it
 *  runs on — which is the right answer to "am I about to be cut off" on one
 *  account's header, the question it was written for. It is the wrong answer per
 *  account across several subscriptions, and for a reason that only appears once
 *  there are several: the week fills over days while the five hours refill four
 *  times a day, so by midweek the max is the weekly figure on every row and the
 *  column stops moving. What the wide face is asked is how much of *this
 *  session* each account has left, and the max was hiding exactly that.
 *
 *  So the five hours speak, and the week speaks only when it has something the
 *  five hours cannot say: that this account is finished for the week whatever
 *  its session window reads. That judgement is `blockersFor` rather than a
 *  second copy of it, so a face saying the week is spent and a wall holding work
 *  back cannot come to disagree — including about *your* ceiling, which is the
 *  case the server's own figures cannot show at all.
 *
 *  Bypass is deliberately not a parameter. It is a property of a *card* — one
 *  conversation told to ignore the caps you set — and this is a widget reading an
 *  account, where those caps are in force. A window past 100 or already refused
 *  is the server's and shows through either way. */
export function speaksWith(account: Account, windows: Window[]): Spoken {
  const weekly = blockersFor(account, windows, false).filter(
    (b) => b.window.group === "weekly",
  );
  if (weekly.length > 0) {
    /* The fullest of them, the tie-break `sayBlocked` already uses: with the
       whole week and a scoped week both stopped, the one further past its
       ceiling is the one still standing there when the other rolls. */
    const worst = [...weekly].sort((a, b) => b.window.used - a.window.used)[0]!;
    return { window: worst.window, ceiling: worst };
  }
  /* `binding` over the session windows rather than the first of them: the server
     has only ever sent one, and if it ever sends two the fuller is the one that
     stops you. Falling back to every window keeps an account whose server names
     no session window drawing something rather than an em dash. */
  const sessions = windows.filter((w) => w.group === "session");
  return { window: binding(sessions.length > 0 ? sessions : windows), ceiling: null };
}

/** Where one account stands right now.
 *
 *  **An account that cannot be measured is not an account that cannot be used**,
 *  and conflating the two was this module's worst bug: it took the whole
 *  accounts feature down for every account, because the credential Skein's own
 *  sign-in minted (`claude setup-token`, scoped `user:inference`) is refused by
 *  the allowance endpoint, so `allowance.ok` was false forever. Every send met
 *  "no account available" — for an account that ran turns perfectly well. The
 *  credential design changed (see `accounts.rs`) and this rule stays changed
 *  too, because the reasoning survives the fix:
 *
 *  - What makes an account usable is a credential that spawns a card. Whether
 *    its allowance can be *read* is a separate capability, over a network, that
 *    can fail for a dozen reasons that say nothing about the subscription.
 *  - An account held in reserve is the case that makes this bite. Nothing runs
 *    on it, so nothing refreshes its credential, so its reading can be stale
 *    exactly when the waterfall wants to move work there. Refusing it then would
 *    make the reserve unreachable — the one job a reserve has.
 *  - What is lost is real and small: with no reading, **your caps cannot be
 *    applied**, so the first turn on an unmeasured account may cross a ceiling
 *    you set. That turn refreshes the store, the next poll reads it, and every
 *    turn after is measured. The server's own ceiling is never crossed by this,
 *    because a refusal is what `markSpent` and the reactive swap are for.
 *
 *  So an unreadable allowance produces `ready` carrying *why* it is unmeasured,
 *  and the face says so for as long as it lasts. Only two things make an account
 *  unusable: not being signed in, and being switched off. Both are yours to fix
 *  and neither is a network away. */
export function standingOf(
  account: Account,
  allowance: Allowance | undefined,
  bypass: boolean,
): Standing {
  const label = account.label;
  if (!account.enabled) return { state: "unusable", label, why: "switched off" };
  if (!account.signedIn) {
    return { state: "unusable", label, why: "not signed in — sign in to this account" };
  }
  if (!allowance) {
    return { state: "ready", label, unmeasured: "its allowance has not been read yet" };
  }
  if (!allowance.ok) return { state: "ready", label, unmeasured: allowance.fault };

  const blockers = blockersFor(account, allowance.windows, bypass);
  if (blockers.length === 0) return { state: "ready", label };
  return { state: "blocked", label, blockers, availableAt: availableAt(blockers) };
}

/** Accounts that could actually take work: signed in, and switched on.
 *
 *  Not "registered". A row whose store holds no credential cannot spawn anything
 *  and a switched-off one will not be asked to, so neither is a subscription
 *  this wall is choosing between. */
export function usable(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.enabled && a.signedIn);
}

/** Whether there is a choice of account to be made at all.
 *
 *  Everything the accounts feature draws on the *wall* hangs off this: the
 *  account beside a card's project name, and the account knob on the usage
 *  widget. With one account there is nothing to choose and nothing to
 *  distinguish, so a label naming it appears on every card and never varies —
 *  which is a word nobody reads after the first day, taking room from the two
 *  facts on that line that do change. The same argument `menu.ts` makes about
 *  offering nothing being a real answer.
 *
 *  Counted over `usable` rather than the registry, so registering a second
 *  account you have not signed into yet does not switch the whole wall into
 *  a mode it cannot use. The accounts panel is deliberately *not* gated on
 *  this — it is where the second account gets set up, so it has to show what
 *  is there however little of it there is. */
export function several(accounts: Account[]): boolean {
  return usable(accounts).length > 1;
}

/** Rank order, and it is the only order anything here reads. Ties broken by
 *  label so the list is stable across restarts rather than however SQLite felt
 *  about it. */
export function ordered(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

export type Choice =
  /** Use this one. `swapFrom` is set when this is not the account the card is
   *  already on, which is what makes it a swap rather than a spawn. */
  | { kind: "use"; label: string; swapFrom: string | null }
  /** Nothing is available. Wait — `until` is the first door to open, or null
   *  when no blocker named a reset and only a fresh poll can say. */
  | { kind: "hold"; until: number | null; standings: Standing[] }
  /** Nothing is available and waiting will not help: no accounts, none with a
   *  token, all switched off. */
  | { kind: "none"; why: string };

/** Which account the next turn goes to.
 *
 *  Waterfall, with one refinement: **a card swaps when it must, not when it
 *  could.** `stickTo` is the account the card is already running on, and if
 *  that account is still ready it wins regardless of rank. New work — a fresh
 *  card, a dormant one waking, a held one released — passes `null` and gets the
 *  lowest-ranked ready account, so the consumption order is exactly the
 *  waterfall that was asked for.
 *
 *  The refinement is not a softening of it. Without stickiness a card that
 *  moved to account two at 4pm moves back to account one the moment its
 *  five-hour window rolls, and pays the uncached re-read of its whole context
 *  both times — twice, for a conversation that was running perfectly well. New
 *  work still always falls to the lowest available account, which is the part
 *  that keeps the reserve a reserve.
 *
 *  `hold` beats `none` whenever anything is merely blocked, because those are
 *  answered differently: one is a wait and the other is a thing to go and fix.
 */
export function choose(
  accounts: Account[],
  allowances: Record<string, Allowance>,
  opts: { bypass?: boolean; stickTo?: string | null } = {},
): Choice {
  const bypass = opts.bypass ?? false;
  const stickTo = opts.stickTo ?? null;

  const list = ordered(accounts);
  if (list.length === 0) return { kind: "none", why: "no accounts are set up" };

  const standings = list.map((a) => standingOf(a, allowances[a.label], bypass));

  /* Ahead of the waterfall, and only ever for an account that is genuinely
     ready — a card sticks to an account it is allowed to be on, not to one it
     has been cut off from. */
  if (stickTo !== null) {
    const held = standings.find((s) => s.label === stickTo);
    if (held?.state === "ready") return { kind: "use", label: stickTo, swapFrom: null };
  }

  const ready = standings.find((s) => s.state === "ready");
  if (ready) {
    return {
      kind: "use",
      label: ready.label,
      swapFrom: stickTo !== null && stickTo !== ready.label ? stickTo : null,
    };
  }

  const blocked = standings.filter(
    (s): s is Extract<Standing, { state: "blocked" }> => s.state === "blocked",
  );
  if (blocked.length === 0) {
    /* Everything is unusable, so there is no clock to watch. Say the reason
       when they all share one, since "not signed in" for a single-account
       setup is a sentence with an obvious next step and "nothing is usable" is
       not. */
    const whys = new Set(
      standings.map((s) => (s.state === "unusable" ? s.why : "")).filter(Boolean),
    );
    const why =
      whys.size === 1 ? [...whys][0]! : "no account is usable — check the accounts panel";
    return { kind: "none", why };
  }

  /* The *earliest* door to open, which is the opposite of `availableAt`'s rule
     within one account and right for the same reason: there, work needs every
     window clear; here, it needs any one account. A blocked account whose
     return time is unknown does not make the wall's return time unknown — one
     of the others may still name a time, and a hold that says "in 40m" and is
     released early by a poll has cost nobody anything. */
  let until: number | null = null;
  for (const b of blocked) {
    if (b.availableAt === null) continue;
    if (until === null || b.availableAt < until) until = b.availableAt;
  }
  return { kind: "hold", until, standings };
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** Why this account is not taking work, in one line for the face.
 *
 *  Names the window and whose ceiling it is, because "80% of the five hours,
 *  which is your cap" and "the week is spent" are the two different things a
 *  person does two different things about. The fullest blocker speaks for the
 *  set: listing three is a paragraph on a card that has room for a line. */
export function sayBlocked(blockers: Blocker[]): string {
  if (blockers.length === 0) return "";
  const worst = [...blockers].sort((a, b) => b.window.used - a.window.used)[0]!;
  const what = worst.window.kind === "session" ? "5 hours" : "7 days";
  const scope = worst.window.scope ? ` · ${worst.window.scope}` : "";
  return worst.by === "you"
    ? `at your cap on the ${what}${scope}`
    : `the ${what}${scope} is spent`;
}

/** The same thing in three words, for a face that has already named the window.
 *
 *  Not `sayBlocked` with the window taken out: that one is a whole line on a
 *  card and says "at your cap on the 7 days", which beside a tooltip that opens
 *  "7 days — 65% used" names it twice. Two wordings because there are two
 *  places, and the shared half — that a cap of yours and a spent account are
 *  never the same sentence — is the part that matters. */
export function sayCeiling(b: Blocker): string {
  return b.by === "you" ? "at your cap" : "spent";
}

/** Why an account is taking work without having been measured, in one line.
 *
 *  Said on the face for as long as it is true, by `healNote`'s rule: Skein
 *  spawns with `--dangerously-skip-permissions`, and an account being spent
 *  without the ceiling you set being checkable is exactly the kind of thing that
 *  must not be quiet. The reason itself comes from Rust and is already a
 *  sentence — this only says what it *means*, which is the part the reason does
 *  not carry. */
export function sayUnmeasured(why: string): string {
  return `your caps are not being applied — ${why}`;
}

/** What the wall says while it is holding work back. `until` is wording's
 *  problem rather than this function's — the caller has `limits.ts::until`,
 *  which already knows how to say five minutes and five days on one face. */
export function sayHold(choice: Extract<Choice, { kind: "hold" }>): string {
  const n = choice.standings.filter((s) => s.state === "blocked").length;
  const which = n === 1 ? "the account is" : "every account is";
  return choice.until === null
    ? `${which} at its limit — waiting for one to come back`
    : `${which} at its limit — holding until one frees up`;
}

/** The line the transcript keeps when a card changes account.
 *
 *  Written into the transcript rather than only shown on the face, and the
 *  reason is `healNote`'s exactly: Skein spawns with
 *  `--dangerously-skip-permissions`, and the one thing an app like that owes
 *  you is that nothing it does on its own is invisible afterwards. A card that
 *  quietly moved onto the subscription you were keeping in reserve is precisely
 *  the thing that must not be quiet. The re-read is named because it is the
 *  part with a cost. */
export function swapNote(from: string, to: string, why: string): string {
  return `moved from ${from} to ${to} — ${why}. the next turn re-reads this conversation uncached`;
}

/** And the line when a card is bypassing the caps you set, which it says for as
 *  long as it is doing it rather than once when you asked for it. */
export function bypassNote(on: boolean): string {
  return on
    ? "ignoring your account caps on this card — the accounts' own limits still apply"
    : "back to your account caps on this card";
}

/* ── carrying the waterfall between machines ───────────────────────────────
 *
 * The precedent is `theme.ts`'s `exportThemes` / `importThemes` / `mergeThemes`
 * and every decision it made is kept: the clipboard rather than a file, since
 * this is small text and the app has no filesystem plugin; a versioned wrapper
 * object; a normalizer on the way in, because this is data that outlives the
 * build that wrote it and that a person may have typed; and a rename rather
 * than an overwrite on a collision, because what is already here is what you
 * have been using and the paste is the guess.
 *
 * **What is different is the whole reason this needed writing rather than
 * copying.** A theme is the whole of itself — eleven strings, and pasting them
 * in gives you the thing. An account is not: Skein holds no credential at all,
 * an account *is* a Claude Code credential store under
 * `~/.claude/accounts/<label>/`, the CLI owns what is in it, and nothing of it
 * enters this process (`accounts.rs`, and `.claude/rules/accounts.md` at
 * length). So what leaves the machine here is the *shape of the waterfall* —
 * the order, the ceilings you set, which rows are switched on — and never a
 * subscription. Import it somewhere else and every account arrives unsigned.
 *
 * That is not a shortcoming to be worked around, it is the format's most
 * important property, and both halves of this file's contract rest on it: the
 * document carries no field that could be mistaken for a credential, and the
 * panel says out loud what has just arrived. `standingOf` already draws an
 * unsigned row `unusable` in exactly the right words, which is the durable
 * half; `sayImported` and `sayUnsigned` are the part that says it at the
 * moment the mistake is available to be made.
 */

export const EXPORT_VERSION = 1;

/** The longest a label may be, kept in step with `accounts.rs::is_label`. */
const MAX_LABEL = 64;

/** One account as a document carries it: the `account` table without
 *  `added_at`, and nothing whatever from the credential store.
 *
 *  **`signedIn` is deliberately not here**, and its absence is the design
 *  rather than an omission. It is not a stored field — `list_accounts`
 *  computes it by looking for a file on *this* machine — so writing it into a
 *  document would be a claim about a disk the document is about to leave. Every
 *  imported row is unsigned and has to be visibly unsigned rather than
 *  plausibly signed in.
 *
 *  **`caps` travels.** A cap is your decision about your own spending rather
 *  than anything about a credential; it is by far the most tedious thing in
 *  this panel to re-enter by hand; and it is inert on an account that cannot
 *  spend, so it can only ever arrive early and be right later. There is no
 *  version of "carry my waterfall" that sensibly leaves the ceilings behind.
 *
 *  **`enabled` travels too**, and that is the less obvious call. It is half of
 *  what the waterfall *is* — an account held in reserve by being switched off
 *  is a decision as real as its rank, and `capFor`'s comment makes the same
 *  argument about a cap of zero. The objection would be that a paste must not
 *  be able to switch spending on; it cannot, because an imported row has no
 *  credential behind it and `standingOf` refuses it before `enabled` is ever
 *  reached. So carrying it costs nothing and dropping it would silently
 *  flatten the arrangement being carried. */
export type AccountDoc = {
  label: string;
  rank: number;
  enabled: boolean;
  caps: Record<string, number>;
};

/** The document itself, as an object.
 *
 *  Handed to `accounts.rs::save_accounts_file` as JSON rather than text when a
 *  file is being written, so the format keeps exactly one owner — this
 *  function, in the module where it is tested — and Rust only has to reach
 *  into the rows it was told to put a credential in.
 *
 *  Ranks are re-densified to 0…n-1 in `ordered` order rather than copied,
 *  because `rank` is only ever meaningful as an ordering — `reorder_accounts`
 *  makes the same point from the other side — and this is a document a person
 *  reads, where 0,3,7 invites a guess about what went missing. */
export function accountsDoc(
  accounts: Account[],
  opts: { withSignIns?: boolean } = {},
): Record<string, unknown> {
  const list: AccountDoc[] = ordered(accounts).map((a, i) => ({
    label: a.label,
    rank: i,
    enabled: a.enabled,
    caps: cleanCaps(a.caps),
  }));
  return {
    skeinAccounts: EXPORT_VERSION,
    /* A line for whoever reads this in a paste buffer or a text editor,
       ignored on the way back in. The plainest available place to say the one
       thing about this document that is easy to get wrong, and it costs a line.

       **Which of the two it says is not cosmetic.** `accounts.rs` splices the
       credentials in *after* this and never touches the note, so a document
       carrying sign-ins under the other wording would be a file that lies
       about itself to whoever opens it — and this is the wording somebody
       reads when they are deciding whether it is safe to keep. */
    note: opts.withSignIns
      ? "the order, the ceilings AND the sign-ins — this file holds live credentials in plain text, and anyone who can read it can spend these subscriptions until you sign out"
      : "the order and the ceilings, not the accounts — no credential is in here, so every account arrives unsigned",
    accounts: list,
  };
}

/** The registry as text, for the clipboard.
 *
 *  **Never with sign-ins**, and taking no options is what says so. The clipboard
 *  is the wrong carrier for a bearer token — Windows keeps a history of it
 *  and can sync that history to another device — which is why the file
 *  exists at all, and why the two are two gestures rather than one with a
 *  modifier on it. */
export function exportAccounts(accounts: Account[]): string {
  return JSON.stringify(accountsDoc(accounts), null, 2);
}

/** A label reduced to the shape `accounts.rs::is_label` allows: ASCII letters,
 *  digits, dot, dash and underscore, at most 64 of them, and not nothing but
 *  dots.
 *
 *  Kept in step with that function deliberately rather than merely resembling
 *  it. A label names a *directory* under `~/.claude/accounts/` and `sign_out`
 *  removes that directory recursively, so `..` is the case the dots clause is
 *  there for. Rust rejects a bad label and is the actual guard; this is the
 *  same rule one layer up, so a pasted document is repaired into something
 *  addable instead of being refused a row at a time with the reason on the
 *  other side of an IPC boundary.
 *
 *  Case is kept, unlike `theme.ts::slugify` — a theme id is a key, but a label
 *  is a name somebody typed and reads back, and `Work` quietly lowercased to
 *  `work` is a rename nobody asked for. Returns "" for anything with nothing
 *  usable left. */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LABEL)
    .replace(/-+$/, "");
  return /[^.]/.test(s) ? s : "";
}

/** A label nothing here is using yet, suffixed `-2`, `-3` … on a clash.
 *
 *  Matched case-insensitively, which is stricter than the store: `label` is a
 *  `TEXT PRIMARY KEY`, so SQLite would hold `work` and `Work` as two happy
 *  rows — but the label is also a directory name, this is a Windows-first app,
 *  and on a case-insensitive filesystem those two rows are two accounts over
 *  *one* credential store, signing each other in and out. A rename is much the
 *  smaller surprise. */
export function freeLabel(want: unknown, taken: Iterable<string>): string {
  const used = new Set([...taken].map((l) => l.toLowerCase()));
  const base = cleanLabel(want) || "account";
  if (!used.has(base.toLowerCase())) return base;
  /* Terminates: every `n` gives a different string and `used` is finite. The
     stem is trimmed so the suffix cannot push the label past what Rust will
     take — a rename that produces an unaddable name is a rename that loses the
     row. */
  for (let n = 2; ; n++) {
    const tail = `-${n}`;
    const next = `${base.slice(0, MAX_LABEL - tail.length)}${tail}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

/** A caps map with everything unusable dropped and everything else clamped,
 *  which is `cleanOverrides`'s job one subsystem over.
 *
 *  Clamped to 0–100 rather than dropped when out of range, because that is
 *  what the panel's own field does (`setCap`) and because it changes nothing:
 *  `capFor` already reads a cap above 100 as no cap at all, so 150 and 100 are
 *  the same instruction. A numeric string is accepted — a document a person has
 *  edited by hand plausibly quotes its numbers, and refusing that teaches
 *  nothing. */
export function cleanCaps(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const kind = key.trim();
    if (!kind || kind.length > 40) continue;
    if (typeof v !== "number" && typeof v !== "string") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[kind] = Math.max(0, Math.min(100, Math.round(n)));
  }
  return out;
}

/** One account out of a document, or null if there is nothing usable in it.
 *
 *  Null rather than a repaired stub, which is `cleanTheme`'s call for a sharper
 *  version of the same reason: an entry with no usable label is not an account
 *  whose name got lost, it is a fragment, and inventing a name for it puts a
 *  row in the waterfall over a credential store that does not exist and cannot
 *  be signed into.
 *
 *  Everything else degrades. A missing `rank` sorts last rather than to zero,
 *  since zero is the head of the queue and a field that was never there must
 *  not claim it. A missing `enabled` is *on*: a hand-written `{"label":"work"}`
 *  is somebody asking for an account, and one that arrives switched off for
 *  want of a field it never had is a row that does nothing and does not say
 *  why. */
export function cleanAccount(raw: unknown): AccountDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (!label) return null;
  const rank =
    typeof r.rank === "number" && Number.isFinite(r.rank) ? r.rank : Number.MAX_SAFE_INTEGER;
  return { label, rank, enabled: r.enabled !== false, caps: cleanCaps(r.caps) };
}

/** Every usable account in a list, in the order the document puts them.
 *
 *  Deduplicated case-insensitively for `freeLabel`'s reason — two rows over one
 *  credential store — with the last of a set winning, as `cleanThemes` does.
 *  Sorted here rather than by the caller because the order *is* the thing being
 *  carried, so a reader of this function should never be holding it unsorted. */
export function cleanAccounts(raw: unknown): AccountDoc[] {
  const list = Array.isArray(raw) ? raw : [];
  const byLabel = new Map<string, AccountDoc>();
  for (const entry of list) {
    const a = cleanAccount(entry);
    if (a) byLabel.set(a.label.toLowerCase(), a);
  }
  return [...byLabel.values()].sort((a, b) => a.rank - b.rank);
}

/** Accounts out of exported text, normalized like anything else read back.
 *
 *  Accepts the wrapper `exportAccounts` writes, a bare array, or a single
 *  account object, because all three are things a person plausibly pastes and
 *  refusing two of them teaches nothing. Returns an empty list rather than
 *  throwing on text that is not JSON at all — the caller says "nothing in
 *  that", which is the same message a valid document with no accounts in it
 *  deserves. */
export function importAccounts(text: string): AccountDoc[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.accounts)) return cleanAccounts(r.accounts);
    return cleanAccounts([raw]);
  }
  return cleanAccounts(raw);
}

/** What an import is going to do: the rows to create, the whole merged order,
 *  and what the rename did. */
export type Merge = {
  /** The rows to create, in the order they are appended, each with its label
   *  already resolved against what is here. */
  added: AccountDoc[];
  /** Every label in the merged waterfall order, which is exactly what
   *  `reorder_accounts` takes. */
  order: string[];
  /** The collisions, so the panel can say what became of them rather than
   *  leaving you to notice a row you did not name. */
  renamed: { from: string; to: string }[];
  /** Incoming rows matched to an account already here instead of added beside
   *  it — a collision on a row that carries a sign-in. Nothing about the row
   *  here is changed by being matched; only its credential is then offered. */
  matched: { from: string; to: string }[];
  /** Every incoming label, and the account it turned out to mean. What a
   *  carried sign-in needs in order to know where it lands, and computed here
   *  rather than re-derived by the caller, since only this function knows
   *  whether a name was renamed, matched or taken as it stood. */
  landings: Record<string, string>;
};

/** Merge imported accounts into the ones already here: renamed rather than
 *  overwritten on a collision, and appended rather than interleaved.
 *
 *  **Renamed**, for `mergeThemes`'s reason — the accounts already here are the
 *  ones you have been spending, and the paste is the guess — with one extra
 *  edge that makes it more important rather than less. Overwriting `work`'s
 *  caps with a pasted `work`'s would be a silent change to where your money
 *  stops on an account that has a live credential behind it. The rename is
 *  also what makes the collision *visible*: you get both rows, you can see the
 *  paste disagreed with what is here, and you remove whichever you did not
 *  want. Note it does not merge them — `work-2` has no credential store, so it
 *  is a configuration to look at, not an account to use.
 *
 *  **Appended, and the order is the answer to the brief's question.** What is
 *  here keeps its order exactly; the imports go after it, in their own
 *  exported order, and every rank is re-densified so the result is a dense
 *  0…n-1 with no ties. Two reasons, and either alone would settle it. The
 *  order is the waterfall, i.e. where the next turn's money goes — a paste
 *  must not be able to insert itself at the head of that queue and quietly
 *  take the next turn. And an imported row is unsigned by construction, so
 *  interleaving by rank would scatter rows `choose` skips through the middle of
 *  the one list whose entire meaning is its sequence. At the end they read as
 *  what they are: new, and not yet signed in. Moving one up is then a
 *  deliberate press of `move`, which is where a decision about spending
 *  belongs.
 *
 *  **Except for a row that carries a sign-in, which is matched rather than
 *  renamed**, and `carrying` is how it is told. The rename rule is right about
 *  a configuration and wrong about a credential, because the two collisions
 *  mean different things: two rows called `lyss` and `lyss-2` holding different
 *  caps is a disagreement worth being able to see, but two rows holding two
 *  credentials for the *same subscription* is nothing anybody wants — one of
 *  them is stale, the wall would keep spending whichever it happened to rank
 *  first, and the fix would be a removal nobody was warned about. A colliding
 *  credential-bearing row is the same account arriving again, so it lands on the
 *  row already here: no new row, nothing about that row's caps, rank or
 *  switched-off-ness touched, and only its credential put up for replacement by
 *  `planSignins`. That is the case a second export exists to serve — a refresh
 *  token rotates, the copy over here goes stale, and the fix is meant to be one
 *  file rather than a browser. */
export function mergeAccounts(
  existing: Account[],
  incoming: AccountDoc[],
  opts: { carrying?: Iterable<string> } = {},
): Merge {
  const here = ordered(existing);
  const taken = new Set(here.map((a) => a.label));
  /* Both maps are keyed lowercase, `freeLabel`'s reason exactly: on this
     filesystem a document's `Lyss` and a local `lyss` are one credential
     store, so they have to be one account here too. */
  const hereBy = new Map(here.map((a) => [a.label.toLowerCase(), a.label]));
  const carrying = new Set([...(opts.carrying ?? [])].map((l) => l.toLowerCase()));
  const added: AccountDoc[] = [];
  const renamed: { from: string; to: string }[] = [];
  const matched: { from: string; to: string }[] = [];
  const landings: Record<string, string> = {};
  for (const doc of incoming) {
    const key = doc.label.toLowerCase();
    const already = hereBy.get(key);
    if (already !== undefined && carrying.has(key)) {
      matched.push({ from: doc.label, to: already });
      landings[doc.label] = already;
      continue;
    }
    const label = freeLabel(doc.label, taken);
    taken.add(label);
    if (label !== doc.label) renamed.push({ from: doc.label, to: label });
    landings[doc.label] = label;
    added.push({ ...doc, label, rank: here.length + added.length });
  }
  return {
    added,
    order: [...here.map((a) => a.label), ...added.map((a) => a.label)],
    renamed,
    matched,
    landings,
  };
}

/** The receipt for an import, in one line for the face.
 *
 *  Names the thing an export cannot carry, because this is the moment the
 *  mistake is available to be made — a list of accounts appearing in the panel
 *  looks exactly like subscriptions arriving. Zero is a real answer and is
 *  worded as `Themes.svelte` words it: text that is not JSON, a document with
 *  no accounts in it, and one whose accounts were all fragments are the same
 *  event from here, and naming which would be guessing.
 *
 *  `signedIn` is a count rather than a flag because the interesting case is the
 *  mixed one: a label that matches a credential store already on this machine
 *  — one signed in from a terminal, or left behind by a `remove`, which
 *  deliberately does not delete the store — lands genuinely usable, and saying
 *  "sign in to each" over that would be wrong about the row that needs
 *  nothing. */
export function sayImported(added: number, signedIn: number): string {
  if (added <= 0) return "nothing in that";
  const took = `took ${added}`;
  if (signedIn <= 0) return `${took} — the order and your caps, never a credential: sign in to each`;
  if (signedIn >= added) return `${took} — already signed in on this machine`;
  return `${took} — ${signedIn} already signed in here, the rest need signing in`;
}

/** The line that stays up while imported accounts are still unsigned, or "" if
 *  none are.
 *
 *  Said for as long as it is true, which is `sayUnmeasured`'s rule and the same
 *  argument: Skein spawns with `--dangerously-skip-permissions`, so the one
 *  thing it owes you is that nothing surprising about it is quiet — and an
 *  imported account is indistinguishable from a working one until something
 *  asks it to take a turn. Three labels at most, then a count: this is a line
 *  under a list, not a second copy of the list. */
export function sayUnsigned(labels: string[]): string {
  if (labels.length === 0) return "";
  const shown = labels.slice(0, 3).join(", ");
  const rest = labels.length - 3;
  const which =
    labels.length === 1
      ? `${shown} is`
      : rest > 0
        ? `${shown} and ${rest} more are`
        : `${shown} are`;
  return `imported — ${which} not signed in on this machine, and no export carries a credential`;
}

/* ── and carrying the sign-ins with them ───────────────────────────────────
 *
 * The document above carries the *shape* of the waterfall, and everything it
 * says about not carrying a credential was true when it was written. It is not
 * true any more, and the reason is worth stating plainly rather than editing
 * the old comment into agreement: three subscriptions signed in on one machine
 * are three browser round trips to repeat on the second, and a wall that can
 * carry its layout across but not those is answering the easy half of what was
 * asked. So a document may now also carry the credential stores themselves.
 *
 * **Nothing in this file ever holds one.** `accounts.rs` splices the credentials
 * in on the way out and takes them straight back out on the way in; what reaches
 * the front end is `SignIn` — two timestamps and a plan name, per account. The
 * pure functions below are the *policy* over those summaries: where a carried
 * sign-in lands, whether installing it may happen without being asked for, and
 * what the panel says about it. That split is the same one the rest of this
 * module keeps, one degree more carefully, because the thing on the other side
 * of it is a bearer token.
 *
 * The one caveat neither this file nor Rust can remove: the file is plaintext,
 * and anyone who can read it can spend those subscriptions until you sign out.
 * `sayFileWarning` is where that gets said, and it is said before the file is
 * written rather than after.
 */

/** What the front end is told about one carried credential. Mirrors
 *  `accounts.rs::Summary` exactly, and mirrors *only* it — there is no field
 *  here that could be spent, and that is the point rather than an accident. */
export type SignIn = {
  label: string;
  /** When the access token lapses. Hours, in practice, and it moves every time
   *  the CLI refreshes. */
  expiresAt: number | null;
  /** When the *refresh* token lapses, after which the account genuinely has to
   *  be signed into again. Weeks, in practice. This is the one that says how
   *  long a carried sign-in is worth anything. */
  refreshExpiresAt: number | null;
  /** `pro`, `team`, whatever the account calls itself. Drawn because a file with
   *  three sign-ins in it wants telling apart by something other than a label
   *  somebody chose months ago. */
  plan: string | null;
};

/** One summary, normalized. Rust builds these, so the shape is known — but they
 *  also come back out of a *file*, by way of a Rust that reads whatever is in
 *  it, so a stamp of the wrong type has to degrade to "not known" rather than
 *  becoming a zero. A zero here would read as 1970 and draw "expired 56 years
 *  ago" over a credential that is perfectly good. */
export function cleanSignIn(raw: unknown): SignIn | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (!label) return null;
  const stamp = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    label,
    expiresAt: stamp(r.expiresAt),
    refreshExpiresAt: stamp(r.refreshExpiresAt),
    plan: typeof r.plan === "string" && r.plan.trim() ? r.plan.trim().slice(0, 40) : null,
  };
}

export function cleanSignIns(raw: unknown): SignIn[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SignIn[] = [];
  for (const entry of list) {
    const s = cleanSignIn(entry);
    if (s) out.push(s);
  }
  return out;
}

/** How long a carried sign-in has left, in one line.
 *
 *  The *refresh* stamp where there is one, because that is what decides whether
 *  the sign-in survives at all: the access token lapses in hours and refreshes
 *  itself, so reporting it would have every carried sign-in looking nearly dead
 *  and would be wrong about the only question being asked. Says so when it does
 *  not know, rather than picking a number — a credential with no stamp in it is
 *  still perfectly installable, and what is missing is the ability to say how
 *  long it is good for. */
export function sayLife(s: SignIn, now: number): string {
  const at = s.refreshExpiresAt ?? s.expiresAt;
  if (at === null) return "no expiry in it";
  return at > now ? `${until(at - now)} left` : `expired ${until(now - at)} ago`;
}

export type Freshness = "newer" | "older" | "same" | "unknown";

/** Whether a carried sign-in is newer than the one already on this disk.
 *
 *  This is the whole of what decides between an update and a downgrade, and so
 *  between installing and asking first. The refresh stamp is compared *before*
 *  the access stamp for `sayLife`'s reason turned round: the access stamp moves
 *  every few hours, so a file copied this morning is "older" by it within the
 *  day, on a credential that is otherwise identical — which would put a press
 *  in front of the one case this feature exists for.
 *
 *  "unknown" is a real answer and not a failure: neither side had a stamp
 *  comparable with the other's, so nothing can be said, and the caller must
 *  treat it as it treats "older" — ask. */
export function fresher(incoming: SignIn, local: SignIn | null | undefined): Freshness {
  if (!local) return "unknown";
  let compared = false;
  for (const stamp of ["refreshExpiresAt", "expiresAt"] as const) {
    const i = incoming[stamp];
    const l = local[stamp];
    if (i === null || l === null) continue;
    compared = true;
    if (i > l) return "newer";
    if (i < l) return "older";
  }
  return compared ? "same" : "unknown";
}

/** One carried sign-in and what is to be done with it. */
export type Install = {
  /** What the document called it — `install_signin`'s `from`, and the key the
   *  credential is parked under in Rust. */
  from: string;
  /** The account it lands in. Not always the same name: a document's `lyss` may
   *  land in a row this machine already calls `lyss`, or in one the merge had to
   *  rename. */
  label: string;
  /** `now` goes without being asked for; `ask` waits for a press. */
  how: "now" | "ask";
  /** Why, in one line, for the face — because "this one just happened and that
   *  one is waiting for you" is not a distinction to leave anybody to infer. */
  why: string;
};

/** Which carried sign-ins may be installed, and which have to be asked about.
 *
 *  Three cases, and the middle one is the whole reason this function exists
 *  rather than a rule in the panel:
 *
 *  - **Nothing signed in at that account yet** — install. There is nothing to
 *    overwrite and nothing to lose, and this is the fresh-machine case the
 *    feature was asked for. Making somebody press three buttons to finish a
 *    thing they have already chosen twice is not care, it is friction.
 *  - **Signed in, and the file's is newer** — install, and say so afterwards.
 *    This is the case that recurs: a refresh token rotates, the copy on the
 *    other machine goes stale, and the fix is a fresh export. A newer credential
 *    for the same account is not a decision, it is an update, and treating it as
 *    one would put a press in the way of the only maintenance this feature has.
 *  - **Signed in, and the file's is older, identical, or of unknown age** —
 *    ask. Here the paste genuinely might be a mistake: an old file, the wrong
 *    file, a document from before a sign-out. Overwriting a working credential
 *    with an older one costs a browser round trip to undo, which is exactly the
 *    cost this feature exists to avoid paying.
 *
 *  `here` is the registry **after** the rows have been created, so `signedIn` is
 *  the truth about the store rather than about the document — which matters for
 *  a label that had a credential store lying around unregistered, since that row
 *  arrives signed in and its existing credential deserves the same protection as
 *  any other. */
export function planSignins(
  incoming: SignIn[],
  landings: Record<string, string>,
  here: Account[],
  locals: SignIn[],
): Install[] {
  const signedIn = new Set(here.filter((a) => a.signedIn).map((a) => a.label));
  const known = new Set(here.map((a) => a.label));
  const localBy = new Map(locals.map((s) => [s.label, s]));
  const out: Install[] = [];
  for (const s of incoming) {
    const label = landings[s.label];
    /* No landing means the row it belonged to was a fragment `cleanAccounts`
       dropped, or a document whose accounts and sign-ins disagree. Either way
       there is no account to put it in, and inventing one would be the thing
       `cleanAccount` refuses for the same reason. */
    if (!label || !known.has(label)) continue;
    if (!signedIn.has(label)) {
      out.push({ from: s.label, label, how: "now", why: "nothing was signed in here" });
      continue;
    }
    const how = fresher(s, localBy.get(label));
    if (how === "newer") {
      out.push({ from: s.label, label, how: "now", why: "the file's sign-in is newer" });
      continue;
    }
    out.push({
      from: s.label,
      label,
      how: "ask",
      why:
        how === "older"
          ? "there is a newer sign-in here already"
          : how === "same"
            ? "the sign-in here is the same age"
            : "there is a sign-in here already, of an age nothing can compare",
    });
  }
  return out;
}

/** The sentence said *before* a file is written, and the reason it is a function
 *  rather than a string in the panel is that it is the one thing in this feature
 *  that is not recoverable.
 *
 *  Everything else here can be undone by pressing something else. A plaintext
 *  credential written to a directory that syncs, or a downloads folder, or a
 *  drive that gets lent to somebody, cannot be — the only way back is signing
 *  the account out, which is the round trip this whole feature exists to save.
 *  So it names the number, names what the file is worth, and names the thing to
 *  do about it afterwards. */
export function sayFileWarning(n: number): string {
  const what = n === 1 ? "one live sign-in" : `${n} live sign-ins`;
  return `this file will hold ${what} in plain text — anyone who can read it can spend them until you sign out. delete it once it is across.`;
}

/** What a save managed, in one line. Names what it could *not* carry, because a
 *  label whose store is empty produces a row on the other machine that looks
 *  like an account which never worked — and this is the only place that is
 *  findable. */
export function sayCarried(signins: string[], missing: string[], where: string): string {
  const n = signins.length;
  const said = n === 0 ? "carried the order alone" : `carried ${n} sign-in${n === 1 ? "" : "s"}`;
  const rest =
    missing.length > 0 ? ` — nothing signed in for ${missing.join(", ")}, so ${missing.length === 1 ? "it went" : "they went"} across unsigned` : "";
  return `${said} to ${where}${rest}`;
}

/** What an import of a file did about the sign-ins in it. Kept apart from
 *  `sayImported`, which is about the rows: an import can perfectly well take
 *  three accounts and install one credential, and one line claiming both would
 *  have to fudge whichever number was less convenient. */
export function sayInstalled(done: number, waiting: number): string {
  if (done === 0 && waiting === 0) return "no sign-ins in that file";
  const parts: string[] = [];
  if (done > 0) parts.push(`signed in ${done}`);
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  return parts.join(", ");
}
