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
import {
  choose,
  keptThrough,
  several,
  usable,
  type Account,
  type Allowance,
  type Choice,
} from "./accounts";
import type { Report } from "./limits";

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

/** How long a `429` outranks the last reading. See `markSpent`. */
const SPENT_FOR = 5 * 60_000;

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
    try {
      const [list, stored, claude] = await Promise.all([
        invoke<Account[]>("list_accounts"),
        invoke<string[]>("stored_accounts"),
        invoke<Presence>("find_claude"),
      ]);
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
  async poll() {
    if (this.#busy) return;
    const labels = this.list.filter((a) => a.signedIn && a.enabled).map((a) => a.label);
    if (labels.length === 0) {
      this.allowances = {};
      this.#retime(false);
      return;
    }
    this.#busy = true;
    let missed = false;
    try {
      const answers = await invoke<RawAllowance[]>("read_allowances", { labels });
      const now = Date.now();
      const next: Record<string, Allowance> = {};
      for (const a of answers) {
        next[a.label] = a.report
          ? { ok: true, windows: a.report.windows, at: a.report.at }
          : keptThrough(
              this.allowances[a.label],
              a.fault ?? "the allowance could not be read",
              now,
            );
      }
      this.allowances = next;
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

  /** Accounts the server has refused more recently than we have polled, and
   *  when to start believing the poll again.
   *
   *  A 429 outranks our last reading, because it is newer and because it is the
   *  actual refusal rather than a percentage that implies one. Without this the
   *  reactive swap does not work at all: the turn fails, `choose` is asked, and
   *  it hands back the very account that just refused — because the reading it
   *  is looking at is up to a minute old and still says 82%.
   *
   *  It expires rather than being cleared by a poll. Rust's floor means the
   *  next real reading is at most a minute out and will show the account full
   *  on its own, so this only has to bridge that gap; five minutes is slack for
   *  a hush. If the account genuinely is out for hours, the poll keeps it
   *  blocked long after this has lapsed, and if it was a fluke the account
   *  quietly comes back. */
  #spent = new Map<string, number>();

  /** Distrust one account until the reading catches up. */
  markSpent(label: string) {
    this.#spent.set(label, Date.now() + SPENT_FOR);
  }

  /** Which account the next turn would go to, right now.
   *
   *  Straight through to the pure chooser — this class decides nothing — except
   *  for overlaying the refusals above, which is a *fact* about an account
   *  rather than a policy about it. A distrusted account is presented as a
   *  window at 100% with no named reset, which is the honest shape of what a
   *  429 tells us: it is full, and it did not say for how long. `availableAt`
   *  then reports unknown and the hold waits on the poll rather than on a
   *  countdown invented here. */
  next(opts: { bypass?: boolean; stickTo?: string | null } = {}): Choice {
    const now = Date.now();
    let allowances = this.allowances;
    if (this.#spent.size > 0) {
      const overlaid: Record<string, Allowance> = { ...allowances };
      for (const [label, until] of this.#spent) {
        if (until <= now) {
          this.#spent.delete(label);
          continue;
        }
        overlaid[label] = {
          ok: true,
          at: now,
          windows: [
            {
              kind: "session",
              group: "session",
              used: 100,
              severity: "rejected",
              resetsAt: null,
              scope: null,
              active: true,
            },
          ],
        };
      }
      allowances = overlaid;
    }
    return choose(this.list, allowances, opts);
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
