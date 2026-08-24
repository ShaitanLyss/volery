/* The one connection to Azure DevOps behind however many widgets are up.
 *
 * Named for the class rather than for either widget, the way `meter.svelte.ts`
 * and `ledger.svelte.ts` are — and here there is a second reason on top of the
 * filesystem one: two widgets read this, so naming it after one of them would
 * make the other look like a guest.
 *
 * Same bargain as the process sampler and the transcript reader. A widget asks
 * by attaching and stops asking by detaching; with nobody asking, nothing is
 * requested, no credential is resolved and Rust's cache is dropped. That matters
 * more here than for either of the others, because this is the only thing in the
 * app besides `git fetch` that leaves the machine — a wall nobody is looking at
 * must not be talking to a corporate server on a timer.
 *
 * **The two readings are kept apart all the way down**, which is the shape the
 * API forced and turned out to be the right one anyway. Pull requests are one
 * org-wide request; runs are one request per project, so on this workspace they
 * are six. Sharing a cadence would mean either polling PRs six times more often
 * than they change or polling runs six times less often than they do. So there
 * are two watcher sets, two intervals and two `$state` fields, and a wall with
 * only a reviews widget on it never asks about a build.
 *
 * Polling at all is the same deliberate exception the sampler is. Azure DevOps
 * has no event this app can hear — there are service hooks, but they want a
 * public endpoint to post to, and standing one up for a desktop wall is a
 * different application. */

import { invoke } from "@tauri-apps/api/core";
import type { Review, Run } from "./azdo";

/** How often the runs list is refreshed while something is watching it.
 *
 * A build's state changes on the order of a minute and the row people care
 * about is the one that just went red, so this is the fast one — but it costs a
 * request per project, so it is nowhere near as fast as it could be. Twenty
 * seconds against six projects is roughly one request every three seconds to
 * one host, which is polite. */
const RUNS_EVERY = 20_000;

/** And how often pull requests are. Slower on purpose: it is one request, but a
 *  PR that appeared thirty seconds ago is not news, and a vote landing is not
 *  something anybody is waiting at the wall to see. */
const REVIEWS_EVERY = 60_000;

type RunsScan = {
  runs: Run[];
  orgs: string[];
  asked: number;
  unseen: number;
  fault: string | null;
};
type ReviewsScan = { reviews: Review[]; orgs: string[]; asked: number; fault: string | null };

/** One half of the connection: a list, when it last landed, and what went wrong.
 *
 * Held as an object per reading rather than as six fields on the class, so the
 * two halves cannot end up sharing a `fault` — a build endpoint refusing a
 * code-scoped token is exactly the case where one half is broken and the other
 * is fine, and a single fault field would have the reviews widget reporting the
 * pipelines widget's problem. */
class Half<T> {
  rows = $state<T[]>([]);
  orgs = $state<string[]>([]);
  /** Whether a reading has ever landed. A wall with nothing running and a wall
   *  whose first request is still in flight look identical otherwise, and the
   *  first poll here is several seconds — a credential to resolve, a project
   *  list to fetch — so it is worth saying out loud. */
  ready = $state(false);
  fault = $state<string | null>(null);
  /** When the last pass finished, so a stalled poller is visible from outside. */
  at = $state(0);
  /** How many requests the last pass cost. Reported rather than merely counted:
   *  this is the only widget on the wall whose cost is somebody else's server. */
  asked = $state(0);
  /** Projects no rung of the ladder can see. Only the runs half can have any —
   *  pull requests come back org-wide in one call, so there is no per-project
   *  request there to be refused. See `emptySaid`. */
  unseen = $state(0);
}

export class DevOps {
  runs = new Half<Run>();
  reviews = new Half<Review>();

  /** Where to look for organisations — the wall's project roots, injected the
   *  way `Cycle.watched` and `Widgets.others` are.
   *
   *  It is a function rather than a value because the wall changes: open a
   *  folder and its org joins the reading on the next tick, with nothing to
   *  re-wire. And it is injected rather than imported because the projects
   *  belong to `Skein` and an instrument may not reach into it. */
  roots: () => string[] = () => [];

  #runWatchers = new Set<string>();
  #reviewWatchers = new Set<string>();
  #runTimer: ReturnType<typeof setInterval> | null = null;
  #reviewTimer: ReturnType<typeof setInterval> | null = null;
  #runBusy = false;
  #reviewBusy = false;

  /** How many widgets are asking for each, for the control surface's snapshot. */
  get watchers(): { runs: number; reviews: number } {
    return { runs: this.#runWatchers.size, reviews: this.#reviewWatchers.size };
  }

  get polling(): boolean {
    return !!this.#runTimer || !!this.#reviewTimer;
  }

  attachRuns(id: string) {
    if (this.#runWatchers.has(id)) return;
    this.#runWatchers.add(id);
    if (this.#runTimer) return;
    this.#runTimer = setInterval(() => void this.#pollRuns(), RUNS_EVERY);
    void this.#pollRuns();
    /* Asked once when the poller starts rather than on a clock of its own. It is
       what tells a fault apart from a fault with nothing to fall back on, and it
       is the runs half that needs a token — a code-scoped credential reads pull
       requests perfectly well. The panel asks again when it opens, since the
       vault is reachable without us. */
    void this.askHeld();
  }

  attachReviews(id: string) {
    if (this.#reviewWatchers.has(id)) return;
    this.#reviewWatchers.add(id);
    if (this.#reviewTimer) return;
    this.#reviewTimer = setInterval(() => void this.#pollReviews(), REVIEWS_EVERY);
    void this.#pollReviews();
  }

  detach(id: string) {
    this.#runWatchers.delete(id);
    this.#reviewWatchers.delete(id);
    if (!this.#runWatchers.size && this.#runTimer) {
      clearInterval(this.#runTimer);
      this.#runTimer = null;
    }
    if (!this.#reviewWatchers.size && this.#reviewTimer) {
      clearInterval(this.#reviewTimer);
      this.#reviewTimer = null;
    }
    /* Only when *both* have gone: the Rust cache holds the credential ladder and
       the project list, which the remaining half is still using. */
    if (!this.polling) void this.#release();
  }

  /** Also called from App's `onDestroy` — a superseded generation left ticking
   *  by a hot reload would go on polling a corporate server for a wall nobody
   *  can see, which is the `Listeners` hazard in the shape a listener cannot
   *  fix. The rows are kept rather than cleared, so a widget hung straight back
   *  up draws the reading it already had instead of blanking for a minute. */
  stop() {
    if (this.#runTimer) clearInterval(this.#runTimer);
    if (this.#reviewTimer) clearInterval(this.#reviewTimer);
    this.#runTimer = null;
    this.#reviewTimer = null;
    this.#runWatchers.clear();
    this.#reviewWatchers.clear();
    void this.#release();
  }

  /** Take both readings now rather than at the next beat.
   *
   *  The seam the timers sit on rather than a path beside it — the control
   *  surface's `azdo` op calls this so a wall test does not have to wait out a
   *  minute. It obeys the same rule the timers do and asks nothing while nobody
   *  is watching, or an op could quietly undo the one property this class exists
   *  to have. */
  async refresh(): Promise<void> {
    await Promise.all([this.#pollRuns(), this.#pollReviews()]);
  }

  /** Forget the credential too, which is what makes an `az login` or a newly
   *  stored token take effect without restarting the app. */
  async #release() {
    try {
      await invoke("release_azdo");
    } catch {
      /* Nothing to report and nothing to do: this is a cache being dropped, and
         a wall that is no longer watching has no face to say it on. */
    }
  }

  async #pollRuns() {
    if (this.#runBusy || !this.#runWatchers.size) return;
    this.#runBusy = true;
    try {
      const scan = await invoke<RunsScan>("azdo_runs", { roots: this.roots() });
      this.#land(this.runs, scan.runs, scan);
    } catch (err) {
      /* The command itself failing — the IPC, not the network. Rust reports a
         refused organisation in `fault` beside whatever rows it did get, so this
         arm is the unexpected one. */
      this.runs.fault = String(err);
      this.runs.ready = true;
    } finally {
      this.#runBusy = false;
    }
  }

  async #pollReviews() {
    if (this.#reviewBusy || !this.#reviewWatchers.size) return;
    this.#reviewBusy = true;
    try {
      const scan = await invoke<ReviewsScan>("azdo_reviews", { roots: this.roots() });
      this.#land(this.reviews, scan.reviews, scan);
    } catch (err) {
      this.reviews.fault = String(err);
      this.reviews.ready = true;
    } finally {
      this.#reviewBusy = false;
    }
  }

  /** One reading landing.
   *
   *  The rows are replaced even when a fault came with them, and that is the
   *  point of carrying both: with two organisations on the wall, one refusing
   *  must not blank the other. The exception is a pass that got *nothing* and
   *  faulted — that is a reading which failed rather than a wall that went
   *  quiet, so the last good rows are kept and the face shows the fault over
   *  them. Otherwise a network blip would empty a list somebody is reading. */
  #land<T>(
    half: Half<T>,
    rows: T[],
    scan: { orgs: string[]; asked: number; unseen?: number; fault: string | null },
  ) {
    if (rows.length || !scan.fault) half.rows = rows;
    half.orgs = scan.orgs;
    half.asked = scan.asked;
    /* Optional because only the runs half has any — and defaulted rather than
       left alone, or a pass that stopped being refused would keep reporting the
       count from the one before it. */
    half.unseen = scan.unseen ?? 0;
    half.fault = scan.fault;
    half.at = Date.now();
    half.ready = true;
  }

  /* ── the token you entered ───────────────────────────────────────────────
   *
   * The fourth rung of the ladder, and the only one this app can do anything
   * about. `held` is a reading of the vault rather than something remembered
   * here, because the vault is reachable from outside — Control Panel →
   * Credential Manager will delete it behind our back, which is a property
   * `vault.rs` chose on purpose and therefore one this class must not cache
   * away. */

  /** Whether a token is stored. Never the token — no command hands one back. */
  held = $state(false);

  async askHeld(): Promise<void> {
    try {
      this.held = await invoke<boolean>("azdo_token");
    } catch {
      /* A vault that will not answer is a vault with nothing usable in it, and
         the ladder will reach the same conclusion on the next pass. */
      this.held = false;
    }
  }

  /** Store one and read again immediately.
   *
   *  Rust drops the credential cache as part of the same command, so the next
   *  poll resolves a fresh ladder — and `refresh` is called rather than waited
   *  for, since somebody who has just pasted a token is looking at the widget
   *  they pasted it for. */
  async store(token: string): Promise<void> {
    await invoke("set_azdo_token", { token });
    await this.askHeld();
    await this.refresh();
  }

  async forget(): Promise<void> {
    await invoke("clear_azdo_token");
    await this.askHeld();
    await this.refresh();
  }
}
