/* The one analytics reader behind however many analytics widgets are up.
 *
 * Named for the class rather than for its widget, and *not* `analytics.svelte.ts`
 * or `analyticswidget.svelte.ts`: on this filesystem either of those is one
 * import specifier away from a component, the trap `ledger.svelte.ts` and
 * `journal.svelte.ts` are named around.
 *
 * The bargain every holder on this wall strikes: a widget asks by attaching and
 * stops asking by detaching, and a wall with no analytics widget up reads no
 * facts at all. It matters more here than on the meter, because each read is a
 * scan of the usage table over the widget's span rather than an index lookup.
 *
 * **Two reads per span, and only for a widget that asks for the second.** A
 * chart needs the window; a figure also needs the window before it, because a
 * delta against the same rows is a different claim (`analyticswidget.ts::statOf`).
 * A wall of charts therefore costs one read a span, and a single figure costs
 * two.
 *
 * **It does poll, and that is the third deliberate exception of the meter's
 * kind.** The collector writes its rollups once a minute and emits no event for
 * them; a widget standing on a wall for a day that read once at attach would be
 * an instrument showing yesterday. So one poller serves however many widgets,
 * started by the first attach and stopped by the last detach, and it is a
 * self-scheduling timeout rather than an interval so a slow read cannot stack a
 * second pass behind the last one. Nothing here reads while nobody is looking.
 */

import { readAnalyticsBefore, readAnalyticsWindow } from "./analyticsread.svelte";
import { asWindow, type AnalyticsWindow, type WindowReader } from "./analyticsroom";

/** The collector's minute, plus the few seconds that let its write land. Slower
 *  buys nothing: there is no new fact between two collects. */
const EVERY = 65_000;

/** What one widget is asking for. The span is the widget's saved view's; the
 *  flag is whether it draws a figure, which is what the second read is for. */
type Want = { span: string; before: boolean };

export class Analytics {
  /** The window per span, as it last came back. A span nobody asked for is
   *  absent rather than an empty window, so "not read yet" and "nothing
   *  recorded" stay different readings. */
  windows = $state<Record<string, AnalyticsWindow>>({});
  /** The window before each span, for a figure's delta. Read only where a
   *  widget asks for it. */
  priors = $state<Record<string, AnalyticsWindow>>({});
  /** The last read's failure, per span. A failed read leaves the last window
   *  standing and says so beside it, the rule `ledger.svelte.ts` states for a
   *  percentage: a reading does not become wrong because a read did not land. */
  faults = $state<Record<string, string>>({});
  /** Whether a read has ever landed, so a widget can tell a stalled reader from
   *  a quiet window. */
  ready = $state(false);
  /** When the last pass finished, so a stalled reader is visible from outside. */
  at = $state(0);

  #wants = new Map<string, Want>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #busy = false;
  /* A span attached while a pass was already running, or a widget that started
     asking for the earlier window mid-pass. Without it, hanging a second widget
     with a different span waits out the whole beat — 65 seconds of "reading…"
     for a fact that was one query away. */
  #dirty = false;
  #gen = 0;
  /** Injected by the browser preview, where there is no store to ask. */
  #read: WindowReader;
  #readBefore: WindowReader;

  constructor(read?: WindowReader, readBefore?: WindowReader) {
    this.#read = read ?? readAnalyticsWindow;
    this.#readBefore = readBefore ?? readAnalyticsBefore;
  }

  get watchers(): number {
    return this.#wants.size;
  }

  /** The spans something is looking at, which is what a pass reads. */
  get spans(): string[] {
    return [...new Set([...this.#wants.values()].map((w) => w.span))];
  }

  /** Whether any widget is drawing a figure of this span, which is what decides
   *  whether the earlier window is worth the read. */
  #wantsBefore(span: string): boolean {
    for (const w of this.#wants.values()) if (w.span === span && w.before) return true;
    return false;
  }

  /** A widget says what it is looking at. Re-attaching with a different span
   *  drops the old one, which is the whole of what a re-pointed widget does. */
  attach(id: string, span: string, before = false): void {
    const had = this.#wants.get(id);
    this.#wants.set(id, { span, before });
    if (had && had.span !== span && !this.spans.includes(had.span)) {
      /* The abandoned span is dropped rather than left to go stale: a widget
         re-pointed from a week to a day must not keep costing the week's scan,
         and nothing is drawing the old window any more. */
      this.#forget(had.span);
    }
    if (!had || had.span !== span || had.before !== before) {
      this.#dirty = true;
      void this.#pass();
    }
    this.#schedule();
  }

  detach(id: string): void {
    const had = this.#wants.get(id);
    this.#wants.delete(id);
    if (had && !this.spans.includes(had.span)) this.#forget(had.span);
    if (!this.#wants.size) this.#stop();
  }

  /** Read now rather than waiting out the beat — the control surface's forced
   *  read, and what the face's own *read again* does. */
  refresh(): void {
    if (this.#wants.size) void this.#pass();
  }

  #forget(span: string): void {
    const { [span]: _w, ...windows } = this.windows;
    const { [span]: _p, ...priors } = this.priors;
    const { [span]: _f, ...faults } = this.faults;
    this.windows = windows;
    this.priors = priors;
    this.faults = faults;
  }

  #stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    /* A read still in flight is dropped by the generation counter rather than
       writing into the next attach. */
    this.#gen += 1;
    this.#busy = false;
  }

  #schedule(): void {
    if (this.#timer || !this.#wants.size) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#wants.size) return;
      void this.#pass().finally(() => this.#schedule());
    }, EVERY);
  }

  async #pass(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#dirty = false;
    const gen = ++this.#gen;
    const now = Date.now();
    const spans = this.spans;
    const faults: Record<string, string> = { ...this.faults };
    try {
      await Promise.all(
        spans.map(async (span) => {
          /* A span that stopped being wanted while this pass was in flight is
             not written at all: its window was forgotten, and a late write
             would put a reading back that nothing is looking at and nothing
             will ever forget again. */
          const wanted = () => gen === this.#gen && this.spans.includes(span);
          try {
            const one = asWindow(await this.#read(span, now));
            if (!wanted()) return;
            this.windows = { ...this.windows, [span]: one };
            delete faults[span];
            this.ready = true;
          } catch (e) {
            if (!wanted()) return;
            faults[span] = e instanceof Error ? e.message : String(e);
          }
          if (!wanted() || !this.#wantsBefore(span)) return;
          try {
            const one = asWindow(await this.#readBefore(span, now));
            if (!wanted()) return;
            this.priors = { ...this.priors, [span]: one };
          } catch {
            /* The earlier window is a comparison, not the reading, so losing it
               costs the delta and leaves the figure — which is the recoverable
               half of the two. What it must not do is leave the *previous*
               comparison standing: the window slides forward every minute, and
               an old prior drawn under a fresh figure says "against the last 7
               days before it" about seven days that have moved. Dropped, the
               face says there is no earlier window to compare with. */
            if (gen !== this.#gen) return;
            const { [span]: _gone, ...rest } = this.priors;
            this.priors = rest;
          }
        }),
      );
      if (gen === this.#gen) {
        this.faults = faults;
        this.at = Date.now();
      }
    } finally {
      if (gen === this.#gen) {
        this.#busy = false;
        /* Something asked while this pass was in flight. One more pass covers
           it; the dirty flag clears at its start, so this cannot spin. */
        if (this.#dirty && this.#wants.size) void this.#pass();
      }
    }
  }
}
