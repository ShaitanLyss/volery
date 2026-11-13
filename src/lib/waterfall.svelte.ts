/* The one reader behind the accounts panel and, later, the waterfall itself.
 *
 * Same bargain as `ledger.svelte.ts`, and named the same way round and for a
 * sharper version of the same reason. `accounts.svelte.ts` would have been the
 * obvious name and does not survive contact with Windows: `./accounts.svelte`
 * resolves to the *component* `Accounts.svelte` on a case-insensitive
 * filesystem, and `svelte-check` fails with two files differing only in casing.
 * That is the `usage.svelte.ts` trap `ledger.svelte.ts` is named around,
 * one degree worse — not an ambiguity a compiler resolves the wrong way, but
 * one it cannot resolve at all. So the reader is named for what the subsystem
 * *does*, which leaves `accounts.ts` pure and `Accounts.svelte` the panel.
 *
 * Something asks by attaching and stops asking by detaching. With nobody
 * attached nothing is polled, which matters here more than it looks: a wall
 * with three accounts on it makes three requests per pass, against an endpoint
 * that answered `429` to a single account polled on a minute
 * (`.claude/rules/usage.md`). The floor and the backoff that actually guarantee
 * politeness are in `limits.rs`, per account; this interval is only the polite
 * cadence.
 *
 * Every *decision* is in `accounts.ts` — which account is next, whether one is
 * blocked, when the wall comes back. This file holds no policy at all; it reads
 * Rust, keeps the answers in runes, and hands them to the pure functions. See
 * `.claude/rules/accounts.md`.
 */

import { invoke } from "@tauri-apps/api/core";
import { samplesOf, type AllowanceSample } from "./allowancesamples";
import { ownShare } from "./ownshare.svelte";
import {
  paceFor,
  paceHold,
  planOf,
  rateOver,
  RATE_MS,
  WEEK_MS,
  type PaceHold,
  type Plan,
} from "./pace";
import {
  type AfarSeat,
  choose,
  observed,
  observedKinds,
  polled,
  probing,
  refuse,
  several,
  standingOf,
  usable,
  vouches,
  type Account,
  type Allowance,
  type Choice,
  type Refusal,
  type Standing,
} from "./accounts";
import type { Report, Window } from "./limits";
import { purse } from "./purse.svelte";

/** Three minutes, the same reasoning `ledger.svelte.ts` sets out at length: a
 *  five-hour window moves one percent in three of them and every face here
 *  floors to whole percents, so anything quicker spends a request to redraw the
 *  same numeral. Multiplied by the account count, which is the other half of
 *  why it is not a minute. */
const EVERY = 180_000;

/** And how long after a pass that could not reach the endpoint.
 *
 *  The cadence above is what a *reading* is worth: nothing on this face moves
 *  faster than a percent in three minutes, so asking sooner spends a request to
 *  redraw the same numeral. A failed pass has no reading to redraw, and what
 *  waits on it is not a numeral — it is whether your caps are being applied at
 *  all, and, once a held reading has thinned to nothing, which account the next
 *  turn goes to. Three minutes is a long time to be flying blind over what may
 *  have been one dropped packet.
 *
 *  Just past `limits.rs`'s `FLOOR_MS`, which is the thing that actually bounds
 *  this — a minute per account, whoever asks and however often. Sixty-five
 *  seconds rather than sixty so the pass lands *after* the floor rather than on
 *  it: inside it Rust answers locally, and with nothing held that answer is a
 *  fault it wrote itself, which would spend the retry on nothing.
 *
 *  Nothing here has to be careful about a `429`, and that is deliberate rather
 *  than lucky. The hush lives in Rust and outranks this: inside one, a pass
 *  makes no request at all and is answered out of the cache. Backing off here as
 *  well would be two clocks disagreeing about one, which is the trap
 *  `Ledger.#askAllowance` names. */
const SOON = 65_000;

/* ── pacing (§14) ─────────────────────────────────────────────────────────
 *
 * The reading a plan is set against is the weekly window's own percentage, and
 * the rate behind "will the week run out" is measured over the last few hours
 * of it. `pace.ts` has the arithmetic and the two spans (`RATE_MS`, `WEEK_MS`),
 * so the room's chart measures across exactly what this gate does.
 */

/** How many readings one account's week is kept at. At the three-minute poll
 *  that is a day and a half, and the observer's stream events can be denser;
 *  `RATE_MS` is what the rate actually reads, so this is only a bound. */
const WEEK_POINTS = 512;

/** The window a plan is measured against: the account's whole week, not a
 *  model-scoped one. A plan is a decision about the subscription's allowance,
 *  and a scoped week (the Opus lane full, the Haiku lane empty) is a window
 *  inside it rather than the budget itself — so where an account has only
 *  scoped weeks there is no budget to pace, and the reading says nothing rather
 *  than pacing the whole subscription to one model's lane. */
function weekOf(allowance: Allowance | undefined): Window | null {
  if (!allowance?.ok) return null;
  return allowance.windows.find((w) => w.group === "weekly" && !w.scope) ?? null;
}

/** One reading of an account's week: when it was taken, what it read, and the
 *  reset it belongs to. The reset is what closes a series, so a roll is exact
 *  rather than inferred from a fall — the wire reports lower figures inside one
 *  window (see `allowancesamples.ts`). */
type WeekPoint = { at: number; used: number; reset: number };

/** What `find_claude` answers. Mirrors `claude.rs::Presence`. */
export type Presence =
  | { state: "ready"; path: string; version: string; onPath: boolean; foundIn: string }
  | { state: "missing"; lookedIn: string[] };

/** What `read_allowances` answers per account. Mirrors `limits.rs::Allowance` —
 *  a report or a fault and exactly one of them, kept apart all the way here
 *  because "full" and "could not be asked" are answered differently. */
type RawAllowance = { label: string; report: Report | null; fault: string | null };

export class Waterfall {
  /** The registry, in tier-then-rank order as Rust returns it — `ordered`'s
   *  rule, made by the `ORDER BY` in `list_accounts` so the panel never has to
   *  re-sort what it draws. */
  list = $state<Account[]>([]);
  /** Label → the last allowance answer for it. */
  allowances = $state<Record<string, Allowance>>({});
  /** Whether Claude Code is on this machine at all, and where. Null until the
   *  first look — which is a different thing from `missing`, and the panel says
   *  so rather than accusing a machine of having no CLI while it is checking. */
  claude = $state<Presence | null>(null);
  /** Credential stores under `~/.claude/accounts` that no registered account
   *  claims — a sign-in done from a terminal, or one left behind by a `remove`,
   *  which deliberately does not delete the store. The panel offers them rather
   *  than adopting them silently. */
  unregistered = $state<string[]>([]);
  /** Every other wall's accounts as it last said them (`afar_seats`), for the
   *  panel's rows that can sign one in from here. Empty off a flyway. */
  afar = $state<AfarSeat[]>([]);
  fault = $state<string | null>(null);
  /** Whether a first pass has landed, so "no accounts" and "still looking" are
   *  distinguishable — the same reason `Ledger.ready` exists. */
  ready = $state(false);

  #watchers = new Set<string>();
  /** A `setTimeout` rescheduled by each pass rather than a `setInterval`,
   *  because the cadence is a consequence of what the last pass found — see
   *  `SOON` and `#retime`. */
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;

  /** Label → the points the weekly window has been read at, for the
   *  projection's rate. Plain rather than `$state`: it feeds a decision asked
   *  for on demand (`holdOf`), never a face, and a ring that invalidated a
   *  whole wall every time a percentage moved would buy nothing. */
  #weeks = new Map<string, WeekPoint[]>();
  /** Accounts whose stored samples have been read back into `#weeks` once this
   *  session, so a launch keeps yesterday's rate rather than starting from
   *  nothing. */
  #seeded = new Set<string>();

  /** The control surface's stand-in for a registry and its readings: an
   *  allowance spent without spending one (`control.svelte.ts`, the
   *  `allowance` op). While it stands `refresh` and `poll` leave the registry
   *  alone — the next beat would otherwise put the real one back mid-test —
   *  and everything downstream (`next`, `choose`, the hold) reads it as it
   *  reads a real one, which is the point: what is under test is the hold,
   *  not the reading. `null` takes it down and reads the real registry again. */
  standIn(
    accounts: {
      label: string;
      windows: Report["windows"];
      /** The ceilings to stand in with, so a capped account can be looked at
       *  with no store behind it (`accounts-preview.ts`). */
      caps?: Record<string, number>;
      /** A pacing plan to stand in with, so the control can be looked at. */
      plan?: Record<string, unknown>;
    }[] | null,
  ) {
    if (!accounts) {
      this.#standIn = false;
      void this.refresh();
      return;
    }
    this.#standIn = true;
    this.list = accounts.map((a, i) => ({
      label: a.label,
      priority: 1,
      rank: i,
      enabled: true,
      caps: a.caps ?? {},
      plan: a.plan ?? {},
      signedIn: true,
      lapsed: false,
    }));
    const at = Date.now();
    this.allowances = Object.fromEntries(accounts.map((a) => [a.label, { ok: true as const, windows: a.windows, at }]));
  }
  #standIn = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  /** Accounts that could actually take work — signed in and switched on. */
  get usable(): Account[] {
    return usable(this.list);
  }

  /** Whether there is a choice of account to be made at all. Everything the
   *  feature draws on the wall is gated on this; see `several` in
   *  `accounts.ts` for why, and for why the accounts panel is not. */
  get several(): boolean {
    return several(this.list);
  }
  get polling(): boolean {
    return this.#timer !== null;
  }

  attach(id: string) {
    if (this.#watchers.has(id)) return;
    this.#watchers.add(id);
    /* Immediately, not on the first beat: a panel that opened to three minutes
       of blank rows would look broken. The beat after it is set by the pass
       this starts, which is what `#retime` is for. */
    void this.refresh();
  }

  detach(id: string) {
    if (!this.#watchers.delete(id)) return;
    if (this.#watchers.size > 0) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    /* Deliberately *not* clearing `allowances`. Rust drops its own cached
       readings on `release_limits` and keeps its hushes; what is kept here is
       the last thing seen, so reopening the panel draws the previous answer
       marked stale rather than three empty rows while the first pass runs. The
       same call `Ledger` makes for the same reason. */
  }

  /** The registry and the machine — cheap, local, and the things that change
   *  when you press something rather than when time passes. */
  async refresh() {
    if (this.#standIn) return;
    try {
      const [list, stored, claude, afar] = await Promise.all([
        invoke<Account[]>("list_accounts"),
        invoke<string[]>("stored_accounts"),
        invoke<Presence>("find_claude"),
        invoke<AfarSeat[]>("afar_seats").catch(() => [] as AfarSeat[]),
      ]);
      this.afar = afar;
      this.list = list;
      this.claude = claude;
      const known = new Set(list.map((a) => a.label));
      this.unregistered = stored.filter((l) => !known.has(l));
      this.fault = null;
      this.ready = true;
    } catch (err) {
      this.fault = String(err);
      this.ready = true;
      /* The beat is armed by whichever pass ran last, so an early return here
         has to arm it itself or the reader stops for good — which is the one
         thing the `setInterval` this replaced could not do wrong. Soon, because
         a registry that cannot be listed is a worse silence than a reading that
         cannot be taken. */
      this.#retime(true);
      return;
    }
    await this.poll();
  }

  /** When the next pass is, decided by what this one found.
   *
   *  Two cadences and one timer. Anything that could not be reached puts the
   *  next pass a minute out instead of three, because what is waiting on it is
   *  not a percentage — see `SOON`. Kept in one place so the two can never both
   *  be running, which is what a `setInterval` plus a retry timer would be.
   *
   *  Nothing is scheduled with nobody watching: `detach` is the other half of
   *  the promise this class makes, and a pass that re-armed itself would keep a
   *  closed panel asking the endpoint forever. */
  #retime(soon: boolean) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#watchers.size === 0) return;
    this.#timer = setTimeout(() => void this.poll(), soon ? SOON : EVERY);
  }

  /** Ask every account that could actually answer.
   *
   *  Accounts with no token are skipped rather than asked and failed: there is
   *  nothing to ask *with*, the answer is already known, and asking would spend
   *  a request to be told so. `standingOf` reports them `unusable` from the
   *  registry alone.
   *
   *  **An account that could not be asked keeps the reading it had**, thinned of
   *  any window that has since rolled — `keptThrough` holds the whole of that
   *  argument, and the bug it is written against was this method building a
   *  fresh map every pass. One connect timeout on flaky wifi took every account
   *  to `ready · unmeasured`, which is your caps switched off and the balancer
   *  reading three part-spent subscriptions as untouched, over a network blip
   *  that changed nothing about any of them. */
  /** A pass already under way, so a caller that has to decide on a fresh
   *  reading waits for it rather than deciding on the old one. `#busy` used to
   *  return at once, which made `releaseHeld`'s "a fresh reading before
   *  deciding" true only when no beat happened to be running. */
  #inflight: Promise<void> | null = null;

  poll(): Promise<void> {
    if (this.#standIn) return Promise.resolve();
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#pass().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #pass() {
    if (this.#busy || this.#standIn) return;
    const labels = this.list
      .filter((a) => a.signedIn && a.enabled && !a.lapsed)
      .map((a) => a.label);
    if (labels.length === 0) {
      this.allowances = {};
      this.#retime(false);
      return;
    }
    this.#busy = true;
    let missed = false;
    try {
      /* **Your own share of each window, first.** Two reads of this wall's own
         tables, with no network in them, so it can be handed to the door before
         the endpoint is asked — and it must be, because the door is what a
         roused card's resume prompt and a drained inbox meet, and those arrive
         at launch, inside the seconds `read_allowances` spends on the wire. A
         pass that fails at the endpoint still leaves the note standing. */
      await ownShare.refresh();
      const answers = await invoke<RawAllowance[]>("read_allowances", { labels });
      const now = Date.now();
      const next: Record<string, Allowance> = {};
      for (const a of answers) {
        next[a.label] = polled(
          this.allowances[a.label],
          a.report,
          a.fault ?? "the allowance could not be read",
          now,
        );
      }
      this.allowances = next;
      /* Kept for the plan's rate (§14), and seeded from the wall's own record
         the first time so a launch does not start with no rate at all. */
      this.#bookWeeks(next);
      void this.#seed(Object.keys(next));
      /* Noted for the analytics room (§3.3): the poll already exists, so this
         is the sample it becomes rather than a second reader. Fire and forget:
         a sample that could not be written is replaced by the next pass, and a
         poll must never fail over its own bookkeeping. */
      for (const a of answers) {
        if (a.report) this.#note(samplesOf(a.label, a.report));
      }
      missed = answers.some((a) => !a.report);
    } catch (err) {
      /* The call itself failed, so there is nothing per account to keep or drop
         — every reading already held stays exactly as it was, which is the same
         bargain `keptThrough` strikes without being able to say so on the rows.
         `detach` makes the same call for the same reason. */
      this.fault = String(err);
      missed = true;
    } finally {
      this.#busy = false;
      this.#retime(missed);
    }
  }

  /** What a card's own stream just said about the account it is on — a
   *  `rate_limit_event`'s `rate_limit_info` — laid over the held reading.
   *
   *  This is what makes the waterfall proactive rather than three minutes
   *  behind: the poll stays, as the reading for accounts nothing is running on,
   *  but an account in use is now read off every request made against it, free.
   *  `accounts.ts::observed` has the shape and the argument. An account not in
   *  the registry is not read — a card on credits or on no managed account says
   *  nothing about any row here. */
  observe(label: string, info: unknown) {
    if (this.#standIn) return;
    if (!this.list.some((a) => a.label === label)) return;
    const next = observed(this.allowances[label], info, Date.now());
    if (!next || !next.ok) return;
    this.allowances = { ...this.allowances, [label]: next };
    /* A request's own headers are a reading like any other, and a rate wants
       them: the poll is three minutes apart, a busy card's stream is not. */
    this.#bookWeeks({ [label]: next });
    /* **Only the windows the event itself named.** `observed` merges the event's
       windows with the ones held from the last poll, and the held ones were
       read up to three minutes ago — noting them at this instant would claim a
       read that did not happen. A kind filter cannot tell the two apart when
       the held window is of the same kind, so the event's own kinds are asked
       for directly. */
    const seen = observedKinds(info);
    if (seen.size > 0) this.#note(samplesOf(label, next, "stream").filter((s) => seen.has(s.kind)));
  }

  /** Note a reading as an allowance sample (§3.3). The events that matter
   *  already exist; this only books them. */
  #note(samples: AllowanceSample[]) {
    if (samples.length === 0) return;
    void invoke("note_allowance_samples", { samples }).catch(() => {});
  }

  /* ── the plan, and the hold it puts on new work ─────────────────────────── */

  /** What this account's plan says about new work right now, or null where it
   *  says nothing (`pace.ts::paceHold`).
   *
   *  Read on demand rather than kept as a rune, and that is the whole reason it
   *  can be consulted from a send: `Skein.#settleAccount` asks it before every
   *  prompt, `#noteAllowance` asks it for Rust once a minute, and both get the
   *  same answer from the same arithmetic. **Never asked of a provider card**:
   *  a balance is not a week.
   *
   *  No reading, no reset, or a reset already past is no hold. The first is the
   *  measured rule `nearness` already states — a hold decided on a reading
   *  nobody took would be a guess wearing a number — and the last is a stale
   *  reading of a week that has since rolled, which the next pass replaces. */
  holdOf(label: string, now = Date.now()): PaceHold | null {
    const account = this.list.find((a) => a.label === label);
    if (!account) return null;
    const plan = planOf(account.plan);
    if (!plan.on) return null;
    const week = weekOf(this.allowances[label]);
    const reset = week?.resetsAt ?? null;
    if (!week || reset === null || reset <= now) return null;
    const rate = rateOver(this.#weeks.get(label) ?? [], now - RATE_MS);
    const pace = paceFor({
      plan,
      window: { from: reset - WEEK_MS, reset },
      used: week.used,
      rate,
      now,
    });
    return paceHold(plan, pace, reset);
  }

  /** Every account whose plan is holding new work, as Rust is told it. */
  paced(now = Date.now()): (PaceHold & { account: string })[] {
    const out: (PaceHold & { account: string })[] = [];
    for (const a of this.list) {
      const hold = this.holdOf(a.label, now);
      if (hold) out.push({ account: a.label, ...hold });
    }
    return out;
  }

  /** Keep one reading of an account's week, for the rate.
   *
   *  Four things are deliberate. **A reading already held is not added
   *  again** — a failed poll hands back the same reading with the same `at`,
   *  and a ring full of copies would flatten the rate towards nothing. **The
   *  ring is kept in time order**, because the backfill below arrives *after*
   *  the live reading and appending it would put the launch's history behind
   *  today's point, where the last-point rate would never see it. **A changed
   *  reset closes the series**, so the points before it describe a week that is
   *  over and go; a fall inside one week is a reading taken low, not a roll
   *  (`allowancesamples.ts` has the measurement). And the ring is bounded by
   *  the span the rate reads, because nothing older can be evidence about
   *  today. */
  #put(label: string, at: number, used: number, reset: number) {
    if (!Number.isFinite(at) || !Number.isFinite(used) || !(reset > 0)) return;
    const ring = (this.#weeks.get(label) ?? []).slice();
    if (ring.some((p) => p.at === at)) return;
    ring.push({ at, used, reset });
    ring.sort((a, b) => a.at - b.at);
    const fresh: WeekPoint[] = [];
    for (const p of ring) {
      const prev = fresh[fresh.length - 1];
      /* One second, the tolerance `allowancesamples.ts::sameReset` keeps: the
         server restamps a reset by a few hundred milliseconds between reads. */
      if (prev && Math.abs(prev.reset - p.reset) > 1_000) fresh.length = 0;
      fresh.push(p);
    }
    const newest = fresh[fresh.length - 1]!.at;
    this.#weeks.set(
      label,
      fresh.filter((p) => p.at >= newest - 2 * RATE_MS).slice(-WEEK_POINTS),
    );
  }

  #bookWeeks(readings: Record<string, Allowance>) {
    for (const [label, allowance] of Object.entries(readings)) {
      const week = weekOf(allowance);
      if (!allowance.ok || !week || week.resetsAt === null) continue;
      this.#put(label, allowance.at, week.used, week.resetsAt);
    }
  }

  /** Read the stored samples back once per account, so a rate is available at
   *  launch instead of three minutes after the second poll.
   *
   *  **The samples already exist** — every pass notes them (`#note`) — so this
   *  is reading the wall's own record rather than keeping a second one in
   *  memory across restarts. One query for the wall, filtered here to the
   *  accounts and the window the current reading names.
   *
   *  **Marked seeded only once the query has answered**, and only for accounts
   *  that had a week to seed against: a reading that is a fault at launch is
   *  the reserve account `accounts.md` describes, and marking it would cost it
   *  a rate for the rest of the session. A query that fails marks nothing and
   *  is asked again on the next pass; until then `holdOf` reads the ring as it
   *  is, which is the reading without a rate rather than a hold decided on
   *  nothing. */
  async #seed(labels: readonly string[]) {
    /* A label whose reading is a fault retries on a later pass; one whose
       reading is fine but has no unscoped week (a scoped-only account) is
       marked anyway, or it would re-ask this query every three minutes for a
       rate there is nothing to compute from. */
    const missing = labels.filter((l) => !this.#seeded.has(l) && this.allowances[l]?.ok === true);
    if (missing.length === 0) return;
    const now = Date.now();
    let rows: { at: number; account: string; kind: string; scope: string | null; used: number; resetsAt: number | null }[];
    try {
      rows = await invoke("allowance_samples", { from: now - RATE_MS, to: now });
    } catch {
      return;
    }
    for (const r of rows) {
      if (!missing.includes(r.account)) continue;
      const week = weekOf(this.allowances[r.account]);
      if (!week || r.resetsAt === null) continue;
      /* `""` and `null` are one window: the sample writer stores an absent
         scope as an empty string (`samplesOf`), and comparing the two
         spellings would seed nothing at all. */
      if (r.kind !== week.kind || (r.scope ?? "") !== (week.scope ?? "")) continue;
      this.#put(r.account, r.at, r.used, r.resetsAt);
    }
    for (const l of missing) this.#seeded.add(l);
  }

  /** Accounts the server has refused, until when, and how many times running.
   *
   *  A 429 outranks our last reading, because it is newer and because it is the
   *  actual refusal rather than a percentage that implies one. Without this the
   *  reactive swap does not work at all: the turn fails, `choose` is asked, and
   *  it hands back the very account that just refused — because the reading it
   *  is looking at is up to a minute old and still says 82%.
   *
   *  **It cannot be a flat five minutes, which is what it was.** A spend cap is
   *  not a window, so the poll goes on reading a calm percentage on an account
   *  the server is refusing, and the mark lapsing was the poll's contradiction
   *  winning by default: the sticky card and every new card went back and spent a
   *  turn each being refused again. `refuse` backs the memory off instead (5m,
   *  10m, 20m … to six hours) and `markServed` clears it, so the account comes
   *  back the moment a turn is actually answered there. Expired entries are
   *  *kept* — the strike count is the memory — and merely ignored by `next`. */
  #refused = new Map<string, Refusal>();

  /** Distrust one account until a reading — or a served turn — says otherwise.
   *  `hint` is a reset the server named, in epoch ms, when one was heard. */
  markSpent(label: string, hint: number | null = null) {
    this.#refused.set(label, refuse(this.#refused.get(label), Date.now(), hint));
  }

  /** A turn was answered on this account, so whatever refused it has lifted. */
  markServed(label: string) {
    this.#refused.delete(label);
  }

  /** A person put a card on this account: their word outranks our distrust,
   *  for the reason `putOnAccount` gives. Keeps nothing — not even the strike
   *  count — because if the server refuses again that is a fresh refusal. */
  forgive(label: string) {
    this.#refused.delete(label);
  }

  /** Which account the next turn would go to, right now.
   *
   *  Straight through to the pure chooser — this class decides nothing — except
   *  for overlaying the refusals above, which is a *fact* about an account
   *  rather than a policy about it. A distrusted account is presented as a
   *  window at 100% that resets when our distrust lapses (`refuse`) — not a
   *  claim about when the server's own window rolls, but it is what a hold
   *  should aim its retry at, since a poll cannot see a spend cap and so cannot
   *  be what releases one. */
  next(opts: { bypass?: boolean; stickTo?: string | null } = {}): Choice {
    return choose(this.list, this.#overlaid(Date.now()), {
      ...opts,
      overage: this.overage,
      /* Your own share, so a cap on a shared account is a cap on *your* work —
         `accounts.ts::SelfUse`. Read from the one place that computes it rather
         than threaded through every caller, so a surface cannot be handed the
         reading without it. */
      self: (label: string) => ownShare.list(label),
    });
  }

  /** Whether an account's usage credits may be spent: boost mode, and nothing
   *  else (Lyss, 2026-10-29). Read here and only here, so every surface that
   *  draws a standing agrees with the chooser — a surface handed the flag as an
   *  argument is one that can forget it, and forgetting would draw "ready" over
   *  an account the wall will not send to. */
  get overage(): boolean {
    return purse.boost;
  }

  /** One account's standing as the panel and the palette draw it: the reading,
   *  without the refusal overlay (`next` and `stateOf` carry that), with boost
   *  deciding the credits. */
  standing(account: Account, bypass = false): Standing {
    return standingOf(
      account,
      this.allowances[account.label],
      bypass,
      this.overage,
      ownShare.list(account.label),
    );
  }

  /** Whether the reading in hand is good enough to move a card onto `label`
   *  without asking first (`accounts.ts::vouches`). */
  vouches(label: string): boolean {
    return vouches(this.allowances[label], Date.now());
  }

  /** One account's state as `next` sees it — refusals included — for the
   *  boost routing, which has to tell an account that *ran out* (credits stand
   *  in for it) from one that was switched off (it does not). An account not in
   *  the registry is `unusable`. */
  stateOf(label: string, bypass = false): "ready" | "blocked" | "unusable" {
    const acct = this.list.find((a) => a.label === label);
    if (!acct) return "unusable";
    return standingOf(
      acct,
      this.#overlaid(Date.now())[label],
      bypass,
      this.overage,
      ownShare.list(label),
    ).state;
  }

  /** The readings with every standing refusal laid over them; see `next`. */
  #overlaid(now: number): Record<string, Allowance> {
    let allowances = this.allowances;
    if (this.#refused.size > 0) {
      const overlaid: Record<string, Allowance> = { ...allowances };
      for (const [label, mark] of this.#refused) {
        /* `probing`: past the gap since the last refusal the mark no longer
           vetoes, and the reading alone says whether the account has room. */
        if (mark.until <= now || probing(mark, now)) continue;
        overlaid[label] = {
          ok: true,
          at: now,
          windows: [
            {
              kind: "session",
              group: "session",
              used: 100,
              severity: "rejected",
              resetsAt: mark.until,
              scope: null,
              active: true,
            },
          ],
        };
      }
      allowances = overlaid;
    }
    return allowances;
  }

  /* ── the gestures ────────────────────────────────────────────────────────*/

  async add(label: string) {
    await invoke("add_account", { label });
    await this.refresh();
  }

  async remove(label: string) {
    await invoke("remove_account", { label });
    await this.refresh();
  }

  /** Delete the account's credential store, which is the gesture that actually
   *  signs it out. Kept apart from `remove` because removing a row from a list
   *  is not a thing anybody expects to sign them out of a subscription. */
  async signOut(label: string) {
    await invoke("sign_out", { label });
    await this.refresh();
  }

  async setEnabled(label: string, enabled: boolean) {
    await invoke("set_account_enabled", { label, enabled });
    await this.refresh();
  }

  async setCaps(label: string, caps: Record<string, number>) {
    await invoke("set_account_caps", { label, caps });
    await this.refresh();
  }

  /** Set one account's pacing plan (§14). Written through `set_field` in Rust,
   *  so it is stamped and every wall on the flyway hears it — a plan is a
   *  decision about spending, and it is the same decision at every machine the
   *  account is on. */
  async setPlan(label: string, plan: Plan) {
    await invoke("set_account_plan", { label, plan });
    await this.refresh();
  }

  /** Move one account up or down the order *within its tier*.
   *
   *  The whole list is written rather than the one row, because `rank` is only
   *  meaningful as an ordering: a half-applied reorder leaves two accounts
   *  claiming the same rank, the tie broken by label, and a wall quietly
   *  spending the wrong subscription. `reorder_accounts` takes the list and
   *  writes it in one transaction.
   *
   *  Refused at a tier boundary rather than allowed to fall through it, and
   *  this is the half a reader has to be told about. `list` arrives sorted by
   *  priority first, so swapping the last row of one tier with the first of the
   *  next writes two ranks and changes *nothing anybody can see* — the
   *  priorities still decide, and the list redraws exactly as it was. A button
   *  that visibly does nothing is worse than one that is not offered, so the
   *  panel disables it at the edges and this refuses it besides. Which tier an
   *  account is in is `setPriority`, a different decision with its own
   *  control. */
  async move(label: string, by: -1 | 1) {
    const at = this.list.findIndex((a) => a.label === label);
    const to = at + by;
    if (at < 0 || to < 0 || to >= this.list.length) return;
    if (this.list[at]!.priority !== this.list[to]!.priority) return;
    const labels = this.list.map((a) => a.label);
    [labels[at], labels[to]] = [labels[to]!, labels[at]!];
    await invoke("reorder_accounts", { labels });
    await this.refresh();
  }

  /** Put one account in a tier.
   *
   *  One row, where `move` writes the whole list, and `accounts.rs` has the
   *  argument: a rank is only meaningful against the other ranks, while a
   *  priority is meaningful on its own and two accounts sharing one is the
   *  point of the feature rather than a collision. Nothing another row holds
   *  can make this row's number wrong, so there is nothing for a transaction to
   *  protect. */
  async setPriority(label: string, priority: number) {
    await invoke("set_account_priority", {
      label,
      priority: Math.max(1, Math.round(priority)),
    });
    await this.refresh();
  }

  /** Start a sign-in. Returns as soon as the child is up: what is being waited
   *  on is somebody in a browser, and `signin.rs` reports the rest through
   *  `signin:out` and `signin:done`, which the panel listens for.
   *
   *  There used to be a `watchFor` beside this, polling `stored_accounts` every
   *  two seconds until a credential appeared, because the sign-in ran in a
   *  terminal Skein could not see into and a file landing was the only signal
   *  there was. The process is Skein's own now, so its exit is the signal and
   *  the poll is gone. */
  async signIn(label: string) {
    await invoke("begin_signin", { label });
  }

  /** Download and run the official installer. Only ever from an explicit
   *  gesture — `claude.rs` refuses to do it from a lookup, and the panel puts
   *  the question before this is called. */
  async install(): Promise<string> {
    const said = await invoke<string>("install_claude");
    await this.refresh();
    return said;
  }
}

export const waterfall = new Waterfall();
