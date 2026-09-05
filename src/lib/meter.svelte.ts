/* The one sampler behind however many performance widgets are on the wall.
 *
 * Named for the class rather than for the widget — `perf.svelte.ts` beside a
 * `Perf.svelte` is the same file on this filesystem, and the two imports
 * resolve to whichever the compiler saw first.
 *
 * A widget asks by attaching and stops asking by detaching; when the last one
 * detaches the timer stops and Rust drops its process table. This is the same
 * argument the ambience's `living()` makes and the same one the shared `clock`
 * rune makes: the wall never runs a loop nobody is reading, and it never runs
 * two of them because two widgets happen to be up.
 *
 * Sampling at all is the one deliberate exception to "nothing polls". There is
 * no event a process emits when it starts using the CPU, and a reading is a
 * difference between two samples rather than a state anybody can push. */

import { invoke } from "@tauri-apps/api/core";
import { add, type Reading } from "./cores";
import type { Sample } from "./perf";

/** Slow enough to be free, fast enough that a build's progress is visible.
 *  Well above sysinfo's 200ms floor for a meaningful CPU delta. */
const EVERY = 2000;

type Ask = { scope: string; limit: number };

export class Meter {
  latest = $state<Sample | null>(null);
  fault = $state<string | null>(null);
  /** Every core's load, one entry per sample that landed, oldest first.
   *
   *  The per-core widget needs a history where the performance meter needs only
   *  the latest reading, and this is where the difference is paid — inside the
   *  poller that already exists rather than beside a second one. It is folded
   *  from the samples this class was taking anyway: no extra call, no extra
   *  tick, and a wall with neither widget on it still asks nothing at all.
   *
   *  `$state.raw`, and `cores.add` returns a new array for it. A deep `$state`
   *  proxy would be a proxy per reading per tick over data nothing ever writes
   *  into, and the array is replaced wholesale on every sample anyway, which is
   *  the dependency. Bounded at `KEEP` there rather than here, since how much
   *  history is worth holding is a judgement about the reading. */
  cores = $state.raw<Reading[]>([]);

  #asks = new Map<string, Ask>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  /** How many widgets are asking, for the control surface's snapshot. */
  get watchers(): number {
    return this.#asks.size;
  }

  attach(id: string, ask: Ask) {
    const before = this.#asks.get(id);
    this.#asks.set(id, ask);
    if (this.#timer) {
      /* A widget switching scope should not wait out the interval to see the
         wider list — but one merely being redrawn must not restart the clock. */
      if (before?.scope !== ask.scope) void this.#tick();
      return;
    }
    this.#timer = setInterval(() => void this.#tick(), EVERY);
    void this.#tick();
  }

  detach(id: string) {
    this.#asks.delete(id);
    if (this.#asks.size === 0) this.stop();
  }

  /** Also called from App's `onDestroy`: a superseded generation left ticking
   *  by an edit would sample forever for a wall nobody can see. */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.latest = null;
    /* And the history with it, which is the honest half. Keeping it would have
       a graph resume an hour later with the last reading before the widget came
       down joined to the first one after — one continuous line across a gap
       nothing sampled. The span filter in `cores.ts` would drop those readings
       for being too old anyway; clearing here says so at the boundary rather
       than relying on it. */
    this.cores = [];
    /* Let go of the process table too. Several thousand rows kept warm for a
       wall that has stopped asking is exactly the cost this widget exists to
       make visible. */
    void invoke("release_performance").catch(() => {});
  }

  /** End one process, and everything under it.
   *
   *  Rust refuses any pid that is not inside one of this studio's jobs, so the
   *  guard is not here — but the *reason* it is not here is worth knowing:
   *  membership in a job is proof of parentage, and the front end has none. It
   *  holds a sample, and a sample is a photograph of a moment already past.
   *
   *  The list is re-read straight afterwards rather than waiting out the tick,
   *  because a row that stays on screen after you have ended it reads as a
   *  button that did nothing — and the second press would land on a pid that
   *  by then means somebody else. */
  async end(pid: number) {
    try {
      await invoke("kill_process", { pid });
      this.fault = null;
    } catch (err) {
      this.fault = String(err);
    }
    await this.#tick();
  }

  async #tick() {
    if (this.#busy || this.#asks.size === 0) return;
    const asks = [...this.#asks.values()];
    /* One sample serves both scopes: the wider one is a superset, and a widget
       scoped to the studio simply ignores the rows it did not ask about. Two
       calls a tick to enumerate the same process table would be the meter
       becoming the thing it measures. */
    const scope = asks.some((a) => a.scope === "machine") ? "machine" : "skein";
    /* Room to fold: rows are grouped by what they belong to, so a widget with
       seven lines may be reading forty processes. */
    const limit = Math.min(400, Math.max(40, ...asks.map((a) => a.limit * 6)));

    this.#busy = true;
    try {
      const sample = await invoke<Sample>("sample_performance", { scope, limit });
      this.latest = sample;
      /* Folded whichever widget asked for the sample, because the two scopes
         are one call and the cores are the machine's either way — a per-core
         history that only advanced while a *machine*-scoped meter happened to
         be up would have gaps nobody could account for. `add` refuses a reading
         with no cores in it, which is what an older Rust answers. */
      this.cores = add(this.cores, sample.at, sample.per_core ?? []);
      this.fault = null;
    } catch (err) {
      /* Reported on the widget's own face rather than the studio's fault bar:
         a meter that cannot read the machine is a broken instrument, not a
         broken conversation. */
      this.fault = String(err);
    } finally {
      this.#busy = false;
    }
  }
}
