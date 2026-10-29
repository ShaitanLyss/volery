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
 *  - **The order is an order, and a tier is a declaration of equivalence.**
 *    Work falls to the lowest *priority* that is allowed to take it and only
 *    moves to the next once that whole tier is spent — because spreading by
 *    headroom across the lot leaves three part-spent subscriptions and no clean
 *    one, and a reserve is only a reserve if something guards it. *Within* one
 *    priority that guard is deliberately given up: putting two accounts on one
 *    tier is saying these are the same pocket, so the least-spent of them takes
 *    the next turn and they run down together. `rank` orders inside a tier and
 *    breaks the tie.
 *  - **Two ceilings, and only one of them is yours.** A cap you set is a
 *    decision you can unmake; the server's 100% is a fact you can only wait
 *    out. They are kept apart all the way to the face because they mean
 *    opposite things to whoever reads it.
 *  - **A bypass moves your ceiling and never the server's.** Nothing here can
 *    promise work through a real refusal, so nothing here pretends to.
 */

import { binding, until, type Overage, type Window } from "./limits";
import { MINUTE } from "./usage";

/** One account as the registry holds it. No credential: an account *is* a
 *  Claude Code credential store (`~/.claude/accounts/<label>/`), the CLI owns
 *  what is in it, and nothing of it enters this process — see `accounts.rs`.
 *  `signedIn` is the registry's word on whether that store holds a credential,
 *  which is a different question from whether the credential in it is still
 *  fresh: an access token expires and the CLI refreshes it on the account's next
 *  turn. `standingOf` is where that distinction is drawn. */
export type Account = {
  label: string;
  /** The tier this account is in, and the first thing work is sorted by. Lower
   *  runs first, and a whole tier is spent before the next one is touched.
   *
   *  **Accounts sharing a priority are declared equivalent**, which is the
   *  whole of what a tier means: the least-spent of them takes the next turn,
   *  so they run down together rather than in sequence. One account per tier is
   *  the strict waterfall this started as, and is what every wall that predates
   *  the column still has — `migrate_v30` gives each existing row a tier of its
   *  own precisely so that an upgrade changes nothing about where money goes.
   *
   *  Dense or sparse, both fine, as with `rank`. It is 1-based rather than
   *  0-based because it is the one number in this module a person names out
   *  loud ("priority 1 for the company accounts") and reads back off the panel;
   *  a tier called zero is a tier nobody asked for. */
  priority: number;
  /** Lower goes first *within a tier*, and the tie-break when two accounts in
   *  one are equally spent. Dense or sparse, both fine — only the order is
   *  read. */
  rank: number;
  enabled: boolean;
  /** Window `kind` → the percentage past which this account stops taking new
   *  work. Absent means no ceiling of yours, which leaves the server's. */
  caps: Record<string, number>;
  signedIn: boolean;
  /** The credential is there but cannot be revived: its *refresh* token's own
   *  expiry has passed and the access token has too, so the CLI has nothing to
   *  refresh with and the next turn on it fails at the door. Optional, since a
   *  build that predates the field — and every fixture — is simply not lapsed.
   *
   *  This is the idle-account failure mode. A reserve nothing runs on never
   *  refreshes, so after a couple of weeks it is `signedIn` by the file check and
   *  dead by the clock, and without this the waterfall counted it as `ready ·
   *  unmeasured` — which `spentOf` reads as *empty*, so inside its tier it was
   *  the account preferred for the next turn. See `standingOf`. */
  lapsed?: boolean;
  /** Who it signs in as: `<account uuid>:<organisation uuid>`, learned off its
   *  own credential and empty until then (`limits.rs::learn_identity`). What other
   *  walls on the flyway match it on — never the label, which is this
   *  machine's name for it. Optional, as `lapsed` is. */
  identity?: string;
  identityEmail?: string;
  identityOrg?: string;
  /** Whose word each synced setting is: one entry per field changed under the
   *  sync (`accountsync.rs`). Empty for a row nobody has touched since the
   *  upgrade, which keeps its own settings and sends none. */
  synced?: Synced[];
  /** The sign-in is a retired copy of another machine's: refused until it is
   *  signed in again here. Mirrors `accounts.rs::is_copy`. */
  copied?: boolean;
};

/** One account on another wall, as that wall said it
 *  (`link/accounting.rs::AfarSeat`): its label there, who it signs in as, and
 *  whether it can take work. */
export type AfarSeat = {
  host: string;
  label: string;
  identity: string;
  email: string;
  state: "signed in" | "not signed in" | "lapsed" | "copied" | string;
  quietMs: number;
};

/** How long a wall may go unheard and still be offered a sign-in from here —
 *  the fleet's `QUIET_AFTER_MS`, past which the flyway refuses any exchange
 *  with it anyway. */
export const SEAT_QUIET_MS = 90_000;

/** The accounts on other walls that want signing in, and that could be signed
 *  in from here right now: not signed in, lapsed, or a retired copy, on a wall
 *  heard from lately. A signed-in account is left out — signing it in again
 *  from afar is a thing nobody needs to be offered every time the panel opens.
 *  Order is Rust's, by wall and label. */
export function seatsToSign(seats: AfarSeat[]): AfarSeat[] {
  return seats.filter((s) => s.state !== "signed in" && s.quietMs <= SEAT_QUIET_MS);
}

/** What a row on another wall says about the account, in the panel's words. */
export function saySeat(s: AfarSeat): string {
  const why =
    s.state === "copied"
      ? "its sign-in is a copy of another machine's, retired so neither logs the other out"
      : s.state === "lapsed"
        ? "its sign-in has lapsed"
        : "not signed in";
  const who = s.email ? ` (${s.email})` : "";
  return `${s.label}${who} on ${s.host} — ${why}`;
}

/** The advice under a sign-in started for another wall. Said every time,
 *  because the browser it is finished in is this machine's: it keeps a claude.ai
 *  session (cookies, never the tokens), and on a machine that is not yours to
 *  sign in on, a private window keeps even that off it. */
export const REMOTE_SIGNIN_ADVICE =
  "open it here and sign in — in a private window if this machine is not yours to keep a claude.ai session on. the tokens are made on the other wall and stay there; then paste the code the page shows.";

/** What a copied sign-in is told — `accounts.rs::COPIED`, word for word, held
 *  equal by a test. */
export const COPIED =
  "this sign-in was copied from another machine and using it would log that machine out — sign in here instead";

/** One synced field's last write — which wall, and when. */
export type Synced = { field: string; at: number; host: string };

/** Who an account signs in as, in the panel's words, or `null` before that is
 *  known. */
export function sayIdentity(a: Account): string | null {
  if (!a.identity) return null;
  const who = [a.identityEmail, a.identityOrg].filter((s) => s && s.trim()).join(" · ");
  return who ? `signs in as ${who}` : "identified";
}

/** The last change to one account's synced settings, said as a sentence for
 *  the row: what changed, on which wall, how long ago. `null` when there is
 *  nothing worth saying — nobody has changed it under the sync, or the last
 *  change was made on this wall (`me`), which the person looking already knows.
 *
 *  An account with no identity yet says so instead, once there is a flyway to
 *  keep in step with (`flying`): its settings are changed here and nowhere
 *  else until the account is used or signed in again, and a person who has
 *  just switched it off at the other laptop needs to know this one did not
 *  hear. */
export function saySynced(a: Account, me: string | null, now: number, flying: boolean): string | null {
  if (!a.identity) {
    return flying && a.signedIn ? "not identified yet — its settings stay on this wall until it is used" : null;
  }
  const last = [...(a.synced ?? [])].sort((x, y) => y.at - x.at)[0];
  if (!last) return null;
  if (me && last.host.toLowerCase() === me.toLowerCase()) return null;
  const what =
    last.field === "enabled"
      ? a.enabled
        ? "switched on"
        : "switched off"
      : last.field === "caps"
        ? "caps changed"
        : last.field === "priority"
          ? `moved to priority ${a.priority}`
          : "reordered";
  return `${what} on ${last.host} · ${agoOf(now - last.at)}`;
}

function agoOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The last allowance reading for one account, or why there isn't one. Mirrors
 *  what `read_allowances` hands over per account: a fault is not the same as an
 *  account being full, and the two must never collapse into each other.
 *
 *  `stale` is the third case, and it is deliberately on the `ok` arm rather than
 *  beside it: the windows are real, they are the last ones that arrived, and
 *  everything downstream should go on reading them exactly as it reads a fresh
 *  reading. What it carries is why the *next* ask failed, so a face can say the
 *  figures are not current without any of them being taken away. See
 *  `keptThrough`. */
export type Allowance =
  | { ok: true; windows: Window[]; at: number; stale?: string; overage?: Overage | null }
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
   *  applied to it this moment. It still goes: see `standingOf`.
   *
   *  `onCredits` is set when the plan is spent and the work would be billed to
   *  usage credits instead — ready, but at a price. See `covers`. */
  | { state: "ready"; label: string; unmeasured?: string; onCredits?: boolean }
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
 *  ceiling you set and then stood on.
 *
 *  **Except where usage credits cover it** (`credits`, from `covers`). Then the
 *  server's ceiling is not a stop: a turn past it is served and billed. Probed
 *  2026-10-29 against claude 2.1.312 on an account whose week was spent with
 *  extra usage on — the turn was answered, and its `rate_limit_event` read
 *  `seven_day: { utilization: 1, status: "rejected" }` beside `overageStatus:
 *  "allowed", isUsingOverage: true`. So a rejected *window* is not a refused
 *  *request* while credits stand behind it, which the CLI's own schema says in
 *  as many words. Your cap still applies — it is checked below as ever — because
 *  a ceiling you set on the week is a decision about spending, and credits are
 *  more spending, not less. */
export function blockersFor(
  account: Account,
  windows: Window[],
  bypass: boolean,
  credits = false,
): Blocker[] {
  const out: Blocker[] = [];
  for (const w of windows) {
    if (w.used >= 100 || REJECTED.has(w.severity.toLowerCase())) {
      if (!credits) {
        out.push({ window: w, by: "server", resetsAt: w.resetsAt });
        continue;
      }
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

/** How spent this account is, as a fraction of what it is *allowed* to spend:
 *  the tightest window, `used / capFor(...)`, taken as the max across every
 *  window `blockersFor` walks. 0 is untouched, 1 is at its ceiling.
 *
 *  This is the balancer inside a tier, and it is deliberately not the raw
 *  percentage. What has to be equalised, if two accounts on one priority are to
 *  run out together, is **how close each is to being refused** — and a cap is
 *  part of that distance. An account capped at 50% sitting at 40% has spent 0.8
 *  of its allowance; an uncapped one at 60% has spent 0.6. The capped one is
 *  nearer the door, so it should take less work, which the raw percentages get
 *  exactly backwards.
 *
 *  It reads `capFor` and the same window set as `blockersFor` rather than a
 *  second copy of either, for the reason `speaksWith` gives at length: two
 *  definitions of "full" in one module drift, and what that looks like from
 *  outside is a face reading calm about an account the wall will not send work
 *  to. Here the drift would be quieter and worse — a tier that keeps choosing
 *  the account nearest its ceiling and blocks it, over and over.
 *
 *  **An unmeasured account counts as empty**, and is therefore preferred inside
 *  its tier. That is the same bargain `standingOf` strikes and states in full:
 *  there is no evidence it is spent, refusing it would make a reserve
 *  unreachable, and what is lost is one turn that may cross a ceiling of yours
 *  before the store refreshes. It is also the honest degradation on a fresh
 *  wall — with no readings at all every account ties at 0 and `rank` decides,
 *  which is exactly the strict waterfall this had before tiers existed.
 *
 *  The divide is guarded on both ends. `capFor` legitimately returns 0 for a
 *  cap of zero, which means "never start work here"; such an account is already
 *  `blocked` so the balancer never sees it, but 0/0 is `NaN` and `40/0` is
 *  `Infinity`, and a comparison against either silently picks the wrong
 *  account rather than failing. A zero ceiling has no headroom by definition,
 *  so it reports 1. A `used` that is not a finite number is read as 0 for the
 *  same reason `cleanCaps` clamps: this figure comes off a wire. */
export function spentOf(
  account: Account,
  allowance: Allowance | undefined,
  bypass: boolean,
): number {
  if (!allowance || !allowance.ok) return 0;
  let worst = 0;
  for (const w of allowance.windows) {
    const used = Number.isFinite(w.used) ? Math.max(0, w.used) : 0;
    const cap = capFor(account, w.kind, bypass);
    const spent = cap <= 0 ? 1 : used / cap;
    if (spent > worst) worst = spent;
  }
  return worst;
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
export function speaksWith(account: Account, windows: Window[], credits = false): Spoken {
  /* `credits` for the same reason `blockersFor` takes it: a week spent with
     usage credits behind it is not finished, the wall is still sending work
     there, and a face reading it as spent would disagree with the chooser. */
  const weekly = blockersFor(account, windows, false, credits).filter(
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

/* ── a reading the network went away in the middle of ────────────────*/

/** What survives of a reading when the next ask fails.
 *
 *  **A failed ask is not evidence about an account**, and one was allowed to act
 *  like evidence: `Waterfall.poll` built a fresh map of readings every pass, so a single connect timeout on flaky wifi replaced a perfectly good
 *  reading with a fault. Every account went `ready · unmeasured` at once — your
 *  caps off, `spentOf` reading every account as untouched, and the waterfall
 *  degraded to rank order until the network came back, for a wall whose
 *  percentages were minutes old and still true. That is the same conflation
 *  `standingOf` documents, one layer along: there a fault must not make an
 *  account *unusable*, here it must not make one *unmeasured* while something
 *  true is still in hand.
 *
 *  What makes keeping it honest is that **a window is monotonic inside its own
 *  reset**. Usage only accumulates until the window rolls, so a percentage taken
 *  ten minutes ago is a *floor* on what the percentage is now rather than a
 *  guess at it: an account the reading puts past your cap is certainly still
 *  past it, and one it puts at 40% is at *at least* 40%. The error can only be
 *  under-blocking, which is the direction this module already accepts and states
 *  on `spentOf` — an unmeasured account counts as empty. So the held figure can
 *  only move the answer towards the truth, never away from it.
 *
 *  That argument runs out exactly at the reset, which is why a rolled window is
 *  **dropped** rather than kept: past it the figure is a floor on nothing, and a
 *  wall left offline for an afternoon would go on holding work back against an
 *  allowance the account has long since been given back. So a held reading thins
 *  as its windows roll and becomes a fault again once the last one has — which
 *  is the honest end of it, since by then nothing is known and `ready ·
 *  unmeasured` is the truth rather than a degradation.
 *
 *  A window naming no reset — which a scoped week nobody has touched genuinely
 *  does — cannot be given that argument at all, so it goes with the rolled ones.
 *  It is also the harmless case: those are the windows sitting at zero. */
export function keptThrough(
  held: Allowance | undefined,
  fault: string,
  now: number,
): Allowance {
  if (!held?.ok) return { ok: false, fault };
  const windows = held.windows.filter((w) => w.resetsAt !== null && w.resetsAt > now);
  if (windows.length === 0) return { ok: false, fault };
  /* `at` is the *reading's* age and not this pass's, so a poll that keeps
     failing goes on saying how old the figures really are rather than resetting
     the clock on them every three minutes. The overage goes with them: a
     credit balance is not unknown because one ask failed, and dropping it would
     block an account on a spent window the credits were covering. */
  return { ok: true, windows, at: held.at, stale: fault, ...(held.overage ? { overage: held.overage } : {}) };
}

/** What one account's reading becomes after a poll: the answer, or what the
 *  held reading keeps through a failed ask (`keptThrough`) — or the held one,
 *  where it is newer than the answer.
 *
 *  That third arm is `observed`'s doing. A card's own stream may have spoken
 *  more recently than the poll's answer was taken: Rust answers inside its floor
 *  out of a cache, and a reading another wall took arrives already aged. Taking
 *  the older over the newer would put a window the stream had just seen at 100%
 *  back to 97% and send the next turn there — the very refusal the stream was
 *  read to get ahead of. A stale held reading is not newer than anything, so it
 *  always gives way.
 *
 *  The credit amounts are the poll's alone (the stream carries none), so they
 *  are taken from the answer whatever its age; whether credits can cover a send
 *  stays the stream's newer word. */
export function polled(
  held: Allowance | undefined,
  report: { windows: Window[]; at: number; overage: Overage | null } | null,
  fault: string,
  now: number,
): Allowance {
  if (!report) return keptThrough(held, fault, now);
  if (held?.ok && !held.stale && held.at > report.at) {
    const o = report.overage;
    return o ? { ...held, overage: { ...o, enabled: held.overage?.enabled ?? o.enabled } } : held;
  }
  return { ok: true, windows: report.windows, at: report.at, overage: report.overage };
}

/* ── what a card's own stream says about its account ─────────────────────────*/

/** The windows a `rate_limit_event` names, as the endpoint's `limits[]` calls
 *  them. Only the two every account has; the third the CLI tracks
 *  (`seven_day_overage_included`) is a per-model week whose display name only
 *  the endpoint carries, and the poll still reads it. */
const UNIFIED = [
  ["five_hour", "session", "session"],
  ["seven_day", "weekly_all", "weekly"],
] as const;

/** A held reading with what a card's own stream just said laid over it, or
 *  `null` when the event says nothing usable.
 *
 *  **The wall used to learn an account was full by being refused**, and that is
 *  the whole of what this replaces. The allowance poll is three minutes apart
 *  (`waterfall.svelte.ts::EVERY`), a busy card crosses several percent in that
 *  time, and so the next send went out on a reading that still said 97% — and
 *  the swap, the carry-on and the note all came after a 429 rather than
 *  before it. Meanwhile every turn of every card was carrying the answer: the
 *  CLI emits `rate_limit_event` whenever any window's rounded percentage, reset
 *  or status moves, read off the response headers of the request it just made.
 *  That is the event the CLAUDE.md asks for when something seems to need a
 *  poll — it was arriving all along and nothing folded it. (Skein's own case
 *  for it read a key, `rate_limit`, that the CLI has never sent.)
 *
 *  Shape observed 2026-10-29 off claude 2.1.312, one real turn:
 *
 *  ```text
 *  rate_limit_info: { status: "rejected", resetsAt: 1793509200,
 *    rateLimitType: "seven_day", overageStatus: "allowed", isUsingOverage: true,
 *    unifiedWindows: { five_hour: { utilization: 0, resetsAt: …, status: "allowed" },
 *                      seven_day: { utilization: 1, resetsAt: …, status: "rejected" } } }
 *  ```
 *
 *  `utilization` is a **fraction** where the endpoint speaks percent, and
 *  `resetsAt` is epoch **seconds**; both are converted here so nothing
 *  downstream learns a second scale. Windows the event names replace the held
 *  ones of the same kind; the rest of the held reading stays, less any window
 *  that has rolled — `keptThrough`'s argument, that inside its reset a figure is
 *  a floor and past it is nothing. The top-level `status` is deliberately not
 *  read as a refusal: with credits behind it, it read `rejected` on a turn that
 *  was answered.
 *
 *  The overage is only ever *moved*, never invented: switched off by a refusal
 *  or a reason it cannot cover sends, switched on by the CLI saying it is
 *  allowed or in use, and otherwise whatever the poll last said — which is also
 *  where the amounts come from, since the event carries none. */
export function observed(
  held: Allowance | undefined,
  info: unknown,
  now: number,
): Allowance | null {
  if (!info || typeof info !== "object") return null;
  const i = info as Record<string, unknown>;
  const unified =
    i.unifiedWindows && typeof i.unifiedWindows === "object"
      ? (i.unifiedWindows as Record<string, unknown>)
      : null;

  const seen: Window[] = [];
  for (const [key, kind, group] of UNIFIED) {
    const w = unified?.[key];
    if (!w || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    const used = finiteOrNull(r.utilization);
    const reset = finiteOrNull(r.resetsAt);
    if (used === null || reset === null || reset <= 0) continue;
    const status = typeof r.status === "string" ? r.status : "";
    seen.push({
      kind,
      group,
      /* Rust clamps the endpoint's percent to 0–1000; the same bounds here, so
         a past-the-cap figure ("values above 1 occur", says the schema) reads
         as past it rather than wrapping or vanishing. */
      used: Math.min(1000, Math.max(0, used * 100)),
      severity: status === "rejected" || status === "allowed_warning" ? status : "normal",
      resetsAt: reset < 1e12 ? reset * 1000 : reset,
      scope: null,
      active: i.rateLimitType === key,
    });
  }

  const before = held?.ok ? (held.overage ?? null) : null;
  let overage = before;
  const reason = typeof i.overageDisabledReason === "string" && i.overageDisabledReason !== "";
  if (reason || i.overageStatus === "rejected") {
    if (before?.enabled !== false) overage = { ...(before ?? { used: null }), enabled: false };
  } else if (
    i.overageStatus === "allowed" ||
    i.overageStatus === "allowed_warning" ||
    i.isUsingOverage === true
  ) {
    if (before?.enabled !== true) overage = { ...(before ?? { used: null }), enabled: true };
  }

  if (seen.length === 0 && overage === before) return null;

  const kept = (held?.ok ? held.windows : []).filter(
    (w) =>
      !seen.some((s) => s.kind === w.kind) && !(w.resetsAt !== null && w.resetsAt <= now),
  );
  const active = seen.some((s) => s.active);
  const windows = [...kept.map((w) => (active && w.active ? { ...w, active: false } : w)), ...seen];
  return { ok: true, windows, at: now, ...(overage ? { overage } : {}) };
}

/** What is left of the usage credits, for the account's row — or `null`, which
 *  the panel draws as nothing at all.
 *
 *  Lyss asked for exactly that: *"reports how many credits are available if
 *  any, or say nothing if none."* So off, spent through, or unreadable is
 *  silence, and the only sentence is one with something in it. A ceiling the
 *  account does not name is said as such rather than as a number, because
 *  credits with no limit are credits available.
 *
 *  Minor units of the currency, divided by the currency's own digits — which
 *  `Intl` knows, and which matters: a hundredth of a yen is not a thing. An
 *  unknown code falls back to two digits and the code itself. */
export function sayCredits(overage: Overage | null | undefined): string | null {
  if (!covers(overage)) return null;
  const limit = finiteOrNull(overage!.limit);
  if (limit === null) return "usage credits on — no limit set";
  const spent = finiteOrNull(overage!.spent) ?? 0;
  const left = limit - spent;
  if (left <= 0) return null;
  return `${money(left, overage!.currency)} of usage credits left`;
}

/** The line a card's transcript keeps when its turns start being billed to
 *  usage credits — once, when it starts. `swapNote`'s rule: nothing that spends
 *  your money on the wall's initiative may be invisible afterwards. */
export const BILLED_NOTE =
  "this card is now running on usage credits — the plan's allowance is spent, so its turns are billed";

function money(minor: number, currency: string | null | undefined): string {
  const code = (currency || "USD").toUpperCase();
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency: code });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
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
  /* Unlike "could not be measured", this one is a fact about the credential and
     not about a network: there is nothing left to refresh with. Counting it
     ready would hand the next turn to the account guaranteed to refuse it. */
  if (account.lapsed) {
    return { state: "unusable", label, why: "sign-in has lapsed — sign in to this account again" };
  }
  /* A copy of another machine's sign-in: the same refresh-token chain on two
     machines, where using it here would log that one out (`accounts.rs`, *a
     sign-in never leaves its machine*). Rust refuses to spawn on it whatever this
     says; this is what keeps the waterfall from choosing it and the panel saying
     why. */
  if (account.copied) return { state: "unusable", label, why: COPIED };
  if (!allowance) {
    return { state: "ready", label, unmeasured: "its allowance has not been read yet" };
  }
  if (!allowance.ok) return { state: "ready", label, unmeasured: allowance.fault };

  const credits = covers(allowance.overage);
  const blockers = blockersFor(account, allowance.windows, bypass, credits);
  if (blockers.length === 0) {
    /* Ready, and whether the plan is what pays. Asked of the same rule with the
       credits taken away, so "on credits" means exactly "would be blocked by
       the server without them" and cannot drift from it. */
    const billed = credits && blockersFor(account, allowance.windows, bypass, false).length > 0;
    return billed ? { state: "ready", label, onCredits: true } : { state: "ready", label };
  }
  return { state: "blocked", label, blockers, availableAt: availableAt(blockers) };
}

/** Whether usage credits stand behind this account's spent plan right now.
 *
 *  Lyss, 2026-10-29: *"try whenever overage is enabled"* — her manager gave her
 *  credits, and the wall would not try them, because every window at 100% read
 *  as the server's refusal (`blockersFor`). The CLI spends them by itself the
 *  moment the plan runs out; the wall was the only thing in the way.
 *
 *  `enabled` is the endpoint's `is_enabled`, which the CLI's schema defines as
 *  false *while extra usage cannot cover sends* — so a spent balance turns it
 *  off at the source. The amounts are checked as well, because the endpoint is
 *  polled and a figure saying the ceiling is reached is newer evidence than a
 *  flag that has not caught up. Being wrong in the generous direction costs one
 *  refused turn, which `markSpent` remembers: the refusal overlay carries no
 *  overage, so a refused account is blocked whatever this says. */
export function covers(overage: Overage | null | undefined): boolean {
  if (!overage?.enabled) return false;
  const limit = finiteOrNull(overage.limit);
  const spent = finiteOrNull(overage.spent);
  return !(limit !== null && spent !== null && spent >= limit);
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Accounts that could actually take work: signed in, and switched on.
 *
 *  Not "registered". A row whose store holds no credential cannot spawn anything
 *  and a switched-off one will not be asked to, so neither is a subscription
 *  this wall is choosing between. */
export function usable(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.enabled && a.signedIn && !a.lapsed && !a.copied);
}

/* ── remembering a refusal ───────────────────────────────────────────────*/

/** First distrust, and the ceiling it doubles towards. Five minutes is what a
 *  hush-sized blip is worth; six hours is a window's order of magnitude without
 *  being so long that a mis-read refusal strands an account for a day. */
export const REFUSAL_BASE = 5 * MINUTE;
export const REFUSAL_MAX = 6 * 60 * MINUTE;

/** How long after the last refusal an account may be tried once more while the
 *  reading says it has room — see `probing`. Two minutes is just past
 *  `limits.rs`'s one-minute floor, so the reading that vouches for the account
 *  is never older than the refusal it is being weighed against. */
export const REFUSAL_PROBE = 2 * MINUTE;

/** An account the server has refused, until when, how many times running, and
 *  when it last said so (`at` is what `probing` measures from). */
export type Refusal = { until: number; strikes: number; at: number; stated?: boolean };

/** Whether a standing refusal should be tried again now, on the reading's word.
 *
 *  **A mark that nothing may test can never be proven wrong.** `markServed` is
 *  the only thing that clears one early, and it needs a turn to be answered on
 *  the account — which the mark itself forbids. So a refusal that was true when
 *  it was made (a window that has since rolled, a reset hint a clock read
 *  wrongly) stood for up to six hours over an account with room: on
 *  2026-10-21 QUEERISFREEDOM held every send "until 15:37" with `tx-team` at 2%
 *  of its session, and `/account tx-team` moved a card there only for the next
 *  send to be held again. This is the half-open step of a circuit breaker: once
 *  `REFUSAL_PROBE` has gone by since the last refusal, the mark stops *vetoing*
 *  and the reading decides — so an account the reading calls full is still
 *  full, and one it calls free gets a turn.
 *
 *  What it costs when the mark was right (a spend cap the reading cannot see):
 *  one refused turn per `REFUSAL_PROBE`, which `refuse` closes again by stamping
 *  `at`. That is the price of ever finding out, and a refused turn spends
 *  nothing. */
export function probing(mark: Refusal, now: number): boolean {
  /* A reset the server *named* is evidence, not memory: nothing is gained by
     asking before it, and each ask is a real turn. Only a guessed back-off is
     probed. */
  if (mark.stated) return false;
  return now - mark.at >= REFUSAL_PROBE;
}

/** What a refusal does to what is already known about an account.
 *
 *  **A refusal used to be believed for a flat five minutes, and then the poll
 *  contradicted it.** The poll reads `/api/oauth/usage`, whose windows are
 *  percentages of a *plan* — and a spend cap (the org's, or an individual's:
 *  "You've hit your individual spend limit", `overageDisabledReason:
 *  org_spend_cap_reached`) is not a window at all. Observed: 429 on every turn
 *  while the account's weekly figure read 35%. So five minutes later the reading
 *  said ready, the sticky card went back to the refusing account, so did every
 *  new card, and each of them spent a turn being told no. A fixed memory cannot
 *  be right about a refusal the reading cannot see, so the memory backs off
 *  instead: each refusal *after the last one lapsed* doubles the distrust, up to
 *  `REFUSAL_MAX`, and a turn that is actually served on the account clears it
 *  (`Waterfall.markServed`).
 *
 *  `hint` is a reset the server named, in epoch ms — used when it is longer than
 *  the back-off and capped by the same ceiling, because a stated reset is better
 *  evidence than a guess but a wrong one (a weekly reset quoted for a monthly
 *  cap) must still be rechecked within hours.
 *
 *  A refusal arriving *while one stands* is the same news from another card on
 *  the account, not a second strike: twenty cards hitting one wall inside a
 *  minute must not read as twenty failures and take the back-off to its ceiling. */
export function refuse(
  held: Refusal | undefined,
  now: number,
  hint: number | null = null,
): Refusal {
  const hinted =
    hint !== null && Number.isFinite(hint) && hint > now
      ? Math.min(hint, now + REFUSAL_MAX)
      : 0;
  if (held && held.until > now) {
    return {
      until: Math.max(held.until, hinted),
      strikes: held.strikes,
      at: now,
      ...(held.stated || hinted > 0 ? { stated: true } : {}),
    };
  }
  const strikes = (held?.strikes ?? 0) + 1;
  const backoff = Math.min(REFUSAL_BASE * 2 ** Math.min(strikes - 1, 16), REFUSAL_MAX);
  return { until: Math.max(now + backoff, hinted), strikes, at: now, ...(hinted > 0 ? { stated: true } : {}) };
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

/** Tier first, then rank, and it is the only order anything here reads. Ties
 *  broken by label so the list is stable across restarts rather than however
 *  SQLite felt about it.
 *
 *  Priority ahead of rank because the tier is now the coarse order and rank is
 *  the fine one inside it, and because this is also the *panel's* order: a list
 *  that drew a priority-2 account above a priority-1 one would be showing the
 *  bands out of the sequence work actually falls through them, which is the one
 *  thing this panel is arranged to make legible. `choose` does its own
 *  partition rather than leaning on this, but it walks the list in this order,
 *  so the tie between two equally-spent accounts in a tier falls to rank. */
export function ordered(accounts: Account[]): Account[] {
  return [...accounts].sort(
    (a, b) => a.priority - b.priority || a.rank - b.rank || a.label.localeCompare(b.label),
  );
}

/** One priority band and everyone in it, in `ordered` order.
 *
 *  The panel's shape, and pure so the grouping is tested rather than written
 *  inline in a `{#each}`. Bands come out in the order work falls through them
 *  and carry their own number, which is the user's rather than an index —
 *  priorities may be sparse (nothing re-densifies what somebody typed), and a
 *  header saying "priority 2" over accounts stored at 5 would be a panel
 *  quietly disagreeing with the field you set it in. */
export type Tier = { priority: number; accounts: Account[] };

export function tiers(accounts: Account[]): Tier[] {
  const out: Tier[] = [];
  for (const a of ordered(accounts)) {
    const last = out[out.length - 1];
    if (last && last.priority === a.priority) last.accounts.push(a);
    else out.push({ priority: a.priority, accounts: [a] });
  }
  return out;
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
 *  **A waterfall of tiers, load-balanced inside each tier.** The lowest
 *  *priority* that has anything ready takes the work, and only when every
 *  account in it is blocked does the next priority get looked at — so a tier is
 *  a reserve exactly as a single account used to be. Inside the chosen tier the
 *  account that has spent least of its own allowance goes, `spentOf` being what
 *  "least" means, so accounts on one priority run down together instead of in
 *  sequence. Ties fall to `ordered`, which is rank then label.
 *
 *  A one-account-per-tier registry is therefore the strict waterfall unchanged,
 *  which is what every wall that predates the `priority` column has and what
 *  `migrate_v30` is careful to keep.
 *
 *  Then one refinement, which is older than tiers and untouched by them: **a
 *  card swaps when it must, not when it could.** `stickTo` is the account the
 *  card is already running on, and if that account is still ready it wins ahead
 *  of all of the above. New work — a fresh card, a dormant one waking, a held
 *  one released — passes `null` and goes through the tiers.
 *
 *  The refinement is not a softening of it. Without stickiness a card that
 *  moved to account two at 4pm moves back to account one the moment its
 *  five-hour window rolls, and pays the uncached re-read of its whole context
 *  both times — twice, for a conversation that was running perfectly well. New
 *  work still always falls to the lowest available tier, which is the part that
 *  keeps the reserve a reserve.
 *
 *  It does mean a card sitting on a priority-2 account stays there while
 *  priority 1 has room, and that is deliberate rather than an edge nobody
 *  noticed: it is the same trade the rule has always made, and it is bounded —
 *  the card came to be there because priority 1 was spent, and every *new* card
 *  meanwhile is going to priority 1. The alternative is paying the full uncached
 *  re-read of a fifty-turn conversation to move it somewhere it is not needed.
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
     has been cut off from. One that is ready *on credits* sticks only where
     the waterfall has no plan room to offer instead (below): stickiness saves
     an uncached re-read, which is worth having until it is being paid for in
     money the next account would not charge. */
  const held = stickTo === null ? undefined : standings.find((s) => s.label === stickTo);
  if (held?.state === "ready" && !held.onCredits) {
    return { kind: "use", label: stickTo!, swapFrom: null };
  }

  /* The lowest tier with anything ready in it. Read off the ready accounts
     rather than off the registry, so a whole priority that is blocked or
     switched off is stepped over exactly as a single account always was — a
     tier nobody can use is not a tier the work waits behind. */
  let tier: number | null = null;
  for (let i = 0; i < list.length; i++) {
    if (standings[i]!.state !== "ready") continue;
    const p = list[i]!.priority;
    if (tier === null || p < tier) tier = p;
  }

  if (tier !== null) {
    /* And the least-spent inside it. Strictly `<`, so a tie is won by whoever
       came first in `ordered` — rank, then label — which is both the promised
       tie-break and what makes a wall with no readings at all behave exactly as
       the strict waterfall did.

       Credits need nothing of their own here: an account billing them has a
       window at or past its ceiling, so `spentOf` reads it at 1 or more and any
       account in the tier with plan left goes first. The tier order is not
       bent for them — credits on a priority-1 account are spent before a
       priority-2 plan is touched, which is what putting it first said. */
    let pick = list[0]!;
    let pickAt = 0;
    let least = Infinity;
    for (let i = 0; i < list.length; i++) {
      const account = list[i]!;
      if (standings[i]!.state !== "ready" || account.priority !== tier) continue;
      const spent = spentOf(account, allowances[account.label], bypass);
      if (spent < least) {
        least = spent;
        pick = account;
        pickAt = i;
      }
    }
    /* A card already on credits stays on them rather than moving to another
       account's credits: the move would cost the uncached re-read and save
       nothing. It moves only to plan room. */
    const picked = standings[pickAt]!;
    if (held?.state === "ready" && picked.state === "ready" && picked.onCredits) {
      return { kind: "use", label: stickTo!, swapFrom: null };
    }
    return {
      kind: "use",
      label: pick.label,
      swapFrom: stickTo !== null && stickTo !== pick.label ? stickTo : null,
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

/** What one priority band is for, in one line under its number.
 *
 *  Two facts and no more: whether this tier shares its work, and what has to
 *  happen before it is touched at all. Those are the two things the tiers
 *  feature added and the two a person cannot read off the list on its own — a
 *  band of two looks exactly like a band of one with a row above it unless
 *  something says which.
 *
 *  `above` is the priority of the band immediately before this one, or null for
 *  the first. Naming the one immediately above rather than "the tiers above" is
 *  concrete and stays true: the waterfall means being held for the previous
 *  band implies being held for every band before that. */
export function sayTier(count: number, above: number | null): string {
  const shared = count > 1 ? "shared — whichever is least spent takes the next turn" : "";
  if (above === null) return shared || "takes the work first";
  const after = `held back until priority ${above} is spent`;
  return shared ? `${shared}, and ${after}` : after;
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

/** That a row's figures are the last ones that arrived, and how old they are.
 *
 *  The counterpart to `sayUnmeasured` and deliberately the opposite claim. There
 *  the consequence is the part worth saying out loud, because your caps are not
 *  being applied at all; here they are, against a reading that has stopped being
 *  refreshed. So this leads with the age — the one thing that decides what the
 *  figure is still worth — and gives the reason after it.
 *
 *  Said for as long as it is true, by `healNote`'s rule and for `sayUnmeasured`'s
 *  reason: a percentage that looks live and is an hour old is the one way this
 *  face can mislead about an account the wall is spending. */
export function sayStale(at: number, why: string, now: number): string {
  const age = Math.max(0, now - at);
  const when = age < MINUTE ? "just now" : `${until(age)} ago`;
  return `measured ${when} — ${why}`;
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

/** The same move, when you asked for it rather than the waterfall.
 *
 *  Said in its own words rather than `swapNote`'s, because the reason half of
 *  that sentence is `#whyLeft` — a reading of what the account it is leaving
 *  could no longer do — and here the account it is leaving could do fine. "You
 *  said so" is the whole of the why.
 *
 *  It keeps the second clause verbatim, and that is the part worth keeping: the
 *  process ends and comes back against the same session, so the next turn pays
 *  for the whole conversation uncached. That is the price of the gesture and
 *  the one thing somebody pressing a menu item has no way to know. */
export function putOnNote(to: string, from: string | null): string {
  const leaving = from ? `moved from ${from} to ${to}` : `put on ${to}`;
  return `${leaving} — you asked for it. the next turn re-reads this conversation uncached`;
}

/** And when the account you asked for cannot take work.
 *
 *  The card is moved anyway and this says what will happen next, rather than
 *  the gesture being refused. Refusing would be the honest-looking answer and
 *  the wrong one: an allowance reading is up to a minute old and does not see a
 *  spend cap at all, so "that account has no room" is a thing this window
 *  believes rather than knows — and the one gesture a person has for overriding
 *  the waterfall should not be vetoed by the waterfall's own guess. What is
 *  owed instead is the warning, before the send rather than after it. */
export function putOnBlockedNote(to: string, why: string): string {
  return `${to} is not taking work — ${why}. this card is on it, and the wall will move it on the next send unless that clears`;
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
  /** Travels for the same reason `enabled` does, and more plainly: the tiers
   *  *are* the waterfall being carried. A document that dropped them would
   *  arrive as a flat list of singletons, which is a different spending policy
   *  wearing the same labels — and silently, since nothing on the far side
   *  could tell it had been flattened. */
  priority: number;
  rank: number;
  enabled: boolean;
  caps: Record<string, number>;
};

/** The lowest priority a document may name. 1-based, as the column is. */
const FIRST_TIER = 1;

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
 *  reads, where 0,3,7 invites a guess about what went missing.
 *
 *  **Priorities are copied rather than densified**, which is the opposite call
 *  and the same reasoning read the other way round. A rank is a position and
 *  nothing else, so renumbering it loses nothing; a priority is a number
 *  somebody chose and typed, and rewriting their 1 and 5 as 1 and 2 would be
 *  this document quietly disagreeing with the panel it was exported from. What
 *  has to survive the trip is which accounts share a tier, and copying keeps
 *  that exactly. */
export function accountsDoc(accounts: Account[]): Record<string, unknown> {
  const list: AccountDoc[] = ordered(accounts).map((a, i) => ({
    label: a.label,
    priority: a.priority,
    rank: i,
    enabled: a.enabled,
    caps: cleanCaps(a.caps),
  }));

  return {
    skeinAccounts: EXPORT_VERSION,
    /* A line for whoever reads this in a paste buffer or a text editor,
       ignored on the way back in — the plainest place to say the one thing
       about this document that is easy to get wrong. It is the only wording
       there is: a sign-in never leaves its machine (accounts.md), so no
       document this app writes ever holds one. */
    note: "the order and the ceilings, not the accounts — no credential is in here, so every account arrives unsigned",
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
 *  why.
 *
 *  **A missing `priority` becomes `rank + 1`**, which is `migrate_v30`'s rule
 *  and is here for exactly its reason: every document written before tiers
 *  existed describes a strict waterfall, and the reading of it that preserves
 *  that is one tier per account in the order it already gives. Defaulting to a
 *  single shared tier would take a carried reserve and turn it into a pool —
 *  the one mistake in this feature that spends money without anything on screen
 *  changing. Where the rank is missing too there is nothing to derive from and
 *  the account sorts last, as it does by rank.
 *
 *  A priority below 1 is not honoured, since the column is 1-based, and falls
 *  back the same way rather than being clamped up into tier 1 — clamping would
 *  silently merge a hand-written 0 with whatever else is there, which is the
 *  same flattening one paragraph up. */
export function cleanAccount(raw: unknown): AccountDoc | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = cleanLabel(r.label);
  if (!label) return null;
  const ranked = typeof r.rank === "number" && Number.isFinite(r.rank);
  const rank = ranked ? (r.rank as number) : Number.MAX_SAFE_INTEGER;
  const named =
    typeof r.priority === "number" && Number.isFinite(r.priority) && r.priority >= FIRST_TIER;
  const priority = named
    ? Math.round(r.priority as number)
    : ranked
      ? Math.round(rank) + 1
      : Number.MAX_SAFE_INTEGER;
  return { label, priority, rank, enabled: r.enabled !== false, caps: cleanCaps(r.caps) };
}

/** Every usable account in a list, in the order the document puts them.
 *
 *  Deduplicated case-insensitively for `freeLabel`'s reason — two rows over one
 *  credential store — with the last of a set winning, as `cleanThemes` does.
 *  Sorted here rather than by the caller because the order *is* the thing being
 *  carried, so a reader of this function should never be holding it unsorted —
 *  and sorted by `ordered`'s rule, tier then rank, since a hand-edited document
 *  may perfectly well list its accounts in neither. */
export function cleanAccounts(raw: unknown): AccountDoc[] {
  const list = Array.isArray(raw) ? raw : [];
  const byLabel = new Map<string, AccountDoc>();
  for (const entry of list) {
    const a = cleanAccount(entry);
    if (a) byLabel.set(a.label.toLowerCase(), a);
  }
  return [...byLabel.values()].sort((a, b) => a.priority - b.priority || a.rank - b.rank);
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
 *  **Incoming tiers keep their shape and are pushed past every tier that is
 *  here**, which is that rule read one column over, and it matters more than
 *  the rank version does. The shape has to survive — two imported accounts that
 *  shared a priority still share one, or the document did not carry the thing
 *  it exists to carry — but a pasted tier 1 landing *on* the local tier 1 would
 *  put an unsigned row into the pocket the next turn comes out of, and worse,
 *  would declare it equivalent to the account you have been spending. So
 *  incoming priorities are renumbered to consecutive tiers starting just past
 *  the highest one here: same grouping, same order, and no paste can reach the
 *  head of the queue. It is the one place a priority is densified rather than
 *  copied, and that is the difference between a number somebody typed and one
 *  this function had to invent.
 */
export function mergeAccounts(
  existing: Account[],
  incoming: AccountDoc[],
): Merge {
  const here = ordered(existing);
  const taken = new Set(here.map((a) => a.label));
  /* The first tier an import may occupy, and the map from the document's own
     priorities onto the tiers below it. */
  const below = here.reduce((n, a) => Math.max(n, a.priority), FIRST_TIER - 1) + 1;
  const tiersBelow = new Map<number, number>();
  for (const p of [...new Set(incoming.map((d) => d.priority))].sort((a, b) => a - b)) {
    tiersBelow.set(p, below + tiersBelow.size);
  }
  const added: AccountDoc[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (const doc of incoming) {
    const label = freeLabel(doc.label, taken);
    taken.add(label);
    if (label !== doc.label) renamed.push({ from: doc.label, to: label });
    added.push({
      ...doc,
      label,
      priority: tiersBelow.get(doc.priority) ?? below,
      rank: here.length + added.length,
    });
  }
  return {
    added,
    order: [...here.map((a) => a.label), ...added.map((a) => a.label)],
    renamed,
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
