/* The one reader behind however many usage widgets are on the wall.
 *
 * Named for the class rather than for the widget, the way `meter.svelte.ts` is:
 * `usage.svelte.ts` beside the pure `usage.ts` is one import specifier with two
 * answers, and which one you get depends on what the compiler saw first.
 *
 * Same bargain as the process sampler otherwise. A widget asks by attaching and
 * stops asking by detaching; with nobody asking, nothing is read and Rust's
 * index is simply never touched. That matters more here than it looks: the
 * first reading walks every transcript written in the past week, and a wall
 * with no usage widget on it should never pay for that.
 *
 * Polling is the same deliberate exception the sampler is. A turn taken in a
 * terminal emits no event this app can hear — it appends to a file — and the
 * whole point of reading the files rather than Skein's own `turn` table is to
 * count those turns too. */

import { invoke } from "@tauri-apps/api/core";
import type { Slice } from "./usage";
import { binding, pct, resetIn, said, until, type Report } from "./limits";
import { allowanceCrossing } from "./chronicle";

/** Slow, because nothing here moves fast: a five-hour window shifts by a ninth
 *  of a percent in this long, and every pass after the first reads only the
 *  bytes appended since. */
const EVERY = 20_000;

/** The allowance is asked for on its own, much slower clock, and the reason is
 *  that the two readings are not the same kind of work. The transcript pass is
 *  local file I/O against an index that already knows where it left off; this
 *  one is a request over the network to somebody else's server, and that server
 *  counts them.
 *
 *  **Three minutes because that is what one printed percent costs.** A five-hour
 *  window fills in three hundred minutes, so it moves one percent in three of
 *  them, and the face floors to whole percents — any cadence quicker than this
 *  spends a request to redraw the same numeral. It was a minute, and on
 *  2026-08-17 the endpoint answered `429` to a wall that had been polling on one
 *  all day. `limits.rs` holds a floor and a backoff of its own besides, which is
 *  where the real guarantee lives: this interval is the polite cadence, that one
 *  is the one a bug cannot get past. */
const ALLOWANCE_EVERY = 180_000;

type Scan = { slices: Slice[]; read: number; added: number; since: number };

/** Which of the two readings a widget is looking at.
 *
 * `allowance` is the account's own figures off `/api/oauth/usage`; `spend` is
 * what the transcripts say the work cost. They are separate because they are
 * separate: a different source, a different failure, a different clock, and a
 * widget draws one of them at a time. */
export type Wants = "allowance" | "spend";

export class Ledger {
  slices = $state<Slice[]>([]);
  fault = $state<string | null>(null);

  /** What is left of the account's allowance, straight from the endpoint the
   *  CLI's own `/usage` reads. Null until the first answer lands, and null for
   *  good on an account that has no OAuth sign-in to ask with — Bedrock, Vertex,
   *  a bare API key — which is why the face keeps the transcript reading as a
   *  fallback rather than treating this as the only thing it can draw. */
  limits = $state<Report | null>(null);
  /** Kept apart from `fault` because the two halves fail apart and for different
   *  reasons — the transcripts are a filesystem and the allowance is a network,
   *  and a signed-out account must not make the cost reading look broken. The
   *  same split `devops.svelte.ts` draws across its two halves. */
  limitsFault = $state<string | null>(null);
  /** Whether a reading has ever landed. A wall with nothing spent and a wall
   *  whose first pass is still walking a week of transcripts look identical
   *  otherwise, and the first one is worth saying out loud. */
  ready = $state(false);
  /** When the last pass finished, so a stalled reader is visible from outside. */
  at = $state(0);

  /** Which of the two readings each widget is actually looking at. A map rather
   *  than a set because the two are paid for separately and neither should be
   *  bought for a wall that is not reading it — see `#retime`. */
  #watchers = new Map<string, Wants>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #allowanceTimer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #askingAllowance = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  /** Whether anything on the wall is reading the transcripts. */
  get scanning(): boolean {
    return this.#timer !== null;
  }

  /** Whether anything on the wall is asking the account. Apart from `scanning`
   *  for the reason `meter.sampling` is apart from the widget count: the two
   *  halves start and stop independently now, and a face drawing a stale
   *  allowance looks identical to one drawing a live one. */
  get asking(): boolean {
    return this.#allowanceTimer !== null;
  }

  /** Start watching, saying which reading is wanted.
   *
   *  The measure is part of the ask because the two readings cost very different
   *  things and a widget only ever draws one of them. A wall showing the
   *  allowance would otherwise walk a week of transcripts — 208 MB on the first
   *  pass — to produce a number nothing on screen is looking at, which is the
   *  same waste `attach` already exists to prevent one level up. Switching the
   *  knob re-attaches, and `#retime` starts or stops only the half that changed. */
  attach(id: string, wants: Wants) {
    if (this.#watchers.get(id) === wants) return;
    this.#watchers.set(id, wants);
    this.#retime();
  }

  detach(id: string) {
    if (!this.#watchers.delete(id)) return;
    this.#retime();
  }

  /** Run exactly the readers something is looking at, and no others. */
  #retime() {
    const wanted = (w: Wants) => this.#wants(w);

    if (wanted("spend") && !this.#timer) {
      this.#timer = setInterval(() => void this.#tick(), EVERY);
      void this.#tick();
    } else if (!wanted("spend") && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    if (wanted("allowance") && !this.#allowanceTimer) {
      this.#allowanceTimer = setInterval(() => void this.#askAllowance(), ALLOWANCE_EVERY);
      void this.#askAllowance();
    } else if (!wanted("allowance") && this.#allowanceTimer) {
      clearInterval(this.#allowanceTimer);
      this.#allowanceTimer = null;
      /* Rust drops its cached reading and forgets where the credential was, the
         way `release_azdo` does: a wall with nothing asking should hold no
         token. What is kept *here* is deliberately not cleared, for the reason
         the slices are not — a widget switched back draws what it had rather
         than blanking for a minute. */
      void invoke("release_limits").catch(() => {});
    }
  }

  #wants(w: Wants): boolean {
    for (const v of this.#watchers.values()) if (v === w) return true;
    return false;
  }

  /** Also called from App's `onDestroy` — a superseded generation left ticking
   *  by a hot reload would go on reading transcripts for a wall nobody can see,
   *  which is the `Listeners` hazard in the shape a listener cannot fix. The
   *  slices are kept rather than cleared: a widget hung straight back up should
   *  draw the reading it already had instead of blanking for twenty seconds. */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#allowanceTimer) clearInterval(this.#allowanceTimer);
    this.#allowanceTimer = null;
    /* Rust drops its cached reading and forgets where the credential was, the
       way `release_azdo` does: a wall with nothing watching should hold no
       token. The reading kept *here* is deliberately not cleared, for the same
       reason the slices are not — a widget hung straight back up draws what it
       had rather than blanking. */
    void invoke("release_limits").catch(() => {});
  }

  /** Take a reading now rather than at the next beat.
   *
   *  The seam the timer sits on, not a path beside it — the control surface's
   *  `usage` op calls this so a wall test does not have to wait out twenty
   *  seconds to see a turn land. It obeys the same rule the timer does and
   *  reads nothing while nobody is watching, or an op could quietly undo the
   *  one property this class exists to have. */
  async refresh(): Promise<void> {
    await Promise.all([this.#tick(), this.#askAllowance()]);
  }

  /** What was last written to the chronicle about the allowance, as a window
   *  key — see `chronicle.ts::windowKey`. Held here rather than in the table
   *  because the question is "have I already said this", and asking the store
   *  would be a read per poll to answer something this object already knows. */
  #toldAllowance: string | null = null;

  /**
   * One row in the chronicle when the binding window crosses the mark.
   *
   * A fold over a reading that has already happened, never a reason for one to
   * happen — which is the whole of why it is called from inside `#askAllowance`
   * rather than from a clock of its own. CLAUDE.md's three-pollers passage is
   * explicit, and this must not become the fourth.
   *
   * **The honest limitation: this only fires while a usage widget is up.**
   * `#askAllowance` returns early unless something `#wants("allowance")`,
   * because a request that leaves the machine may not be made by a wall nobody
   * asked. So a wall with no usage widget records no allowance row — the
   * chronicle is quiet about it rather than wrong about it. Fixing that
   * properly means a reading somebody asked for, not a poll added here; the
   * shape to copy is `release.svelte.ts`, which asks on *focus* because focus
   * is an event that already exists.
   */
  #noteAllowance() {
    const key = allowanceCrossing(binding(this.limits?.windows ?? []), this.#toldAllowance);
    if (!key) return;
    /* Remembered before the write, not after. The write is fire-and-forget and
       the poll comes round again in minutes; remembering afterwards would let a
       slow invoke put two identical rows in. */
    this.#toldAllowance = key;
    const w = binding(this.limits?.windows ?? []);
    if (!w) return;
    const rolls = resetIn(w, Date.now());
    void invoke("chronicle_note", {
      projectId: null,
      source: "volery",
      /* `note`, not `bad`. The allowance running down is the day going normally,
         and colouring it rust would sit it beside a card that actually broke —
         which is the one thing the level vocabulary is for. */
      level: "note",
      /* `pct` and `said` rather than arithmetic and a string: the usage widget
         draws this window with exactly those two functions, and a row that
         phrased the same fact differently would read as a second, disagreeing
         instrument. `pct` floors rather than rounds, so nothing ever says 100%
         while there is allowance left. */
      mark: `${pct(w.used)} of the ${said(w)} allowance used`,
      detail: rolls === null ? "" : `rolls in ${until(rolls)}`,
    }).catch(() => {});
  }

  /** Ask the account what is left. Obeys the watcher rule the transcript pass
   *  obeys, and for a stronger reason: this one leaves the machine, so a wall
   *  with no usage widget on it must make no request at all. */
  async #askAllowance() {
    if (this.#askingAllowance || !this.#wants("allowance")) return;
    this.#askingAllowance = true;
    try {
      this.limits = await invoke<Report>("read_limits");
      this.limitsFault = null;
      this.#noteAllowance();
    } catch (err) {
      /* The last good reading is left standing. A window's percentage does not
         become wrong because the network went away for a minute, and blanking
         the one number this widget exists to show — over a blip, or over a
         sign-in the CLI is about to refresh by itself — would be the worse
         answer. The fault is drawn beside it so the figure is never passed off
         as current when it is not.
         Rate limiting arrives here as an ordinary fault and wants no handling
         of its own: `limits.rs` is serving the wait and says how much of it is
         left in the words it fails with, so the beat below can go on beating
         into a hush without a single request leaving the machine. Backing off
         *here* as well would only mean two clocks disagreeing about one. */
      this.limitsFault = String(err);
    } finally {
      this.#askingAllowance = false;
    }
  }

  async #tick() {
    if (this.#busy || !this.#wants("spend")) return;
    this.#busy = true;
    try {
      const scan = await invoke<Scan>("read_usage");
      this.slices = scan.slices;
      this.at = Date.now();
      this.ready = true;
      this.fault = null;
    } catch (err) {
      /* On the widget's own face, not the studio's fault bar — a ledger that
         cannot read the transcripts is a broken instrument, not a broken
         conversation. Same call `Meter` makes. */
      this.fault = String(err);
    } finally {
      this.#busy = false;
    }
  }
}
