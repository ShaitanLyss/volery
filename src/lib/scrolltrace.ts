/* TEMPORARY. Instrumentation for the panel losing the tail on a card switch.
 *
 * Delete this file, its import in `Transcript.svelte`, and every `trace.*` call
 * once the cause is settled. It is deliberately *not* in the pure-and-tested set
 * in CLAUDE.md and must not be added to the `test` script — there is nothing
 * here worth a contract, only a witness.
 *
 * ### What it is watching for
 *
 * `following` is a remembered flag. It is cleared by `onScroll` whenever the
 * view is not near the bottom and `pinned` does not vouch for the event, and it
 * is re-armed only by a gesture, a card switch or the studio regaining focus.
 * The suspicion is that a scroll event **nobody made** clears it: the browser
 * clamping `scrollTop` when the column changes height, or Chromium's scroll
 * anchoring (`overflow-anchor` is `auto` by default) adjusting `scrollTop` to
 * hold content above the fold still. Both are delivered at the next rendering
 * update — which runs the scroll steps *before* animation-frame callbacks — so
 * the already-queued `keepTail` frame then sees `following === false` and
 * declines to pin, and the view stays wherever the column left it.
 *
 * So the one number that decides it is **how long ago the last real gesture
 * was**, at the instant `following` goes true → false. If that is "never" or
 * "seconds", no hand was on the wheel and the event is the column's own; gating
 * the release on a gesture fixes the whole class. If it is a few tens of
 * milliseconds, the hypothesis is wrong and something is genuinely being
 * scrolled.
 *
 * ### Reading it
 *
 * `bun run tauri dev`, F12 for devtools (the key is not bound anywhere in
 * `App.svelte`, and WebView2's devtools are on in a debug build). Every entry is
 * a `console.debug`; the release of the tail is a `console.warn` so it can be
 * found without reading the rest. Then, in the console:
 *
 *     __tail.dump()   // the whole ring as text
 *     __tail.copy()   // …and onto the clipboard, to paste back here
 *     __tail.clear()  // reset before reproducing, so the ring is only the run
 */

/** How many entries to keep. A card switch during a live turn is a few dozen;
 *  this holds several reproductions without the ring eating the interesting one. */
const RING = 600

/** One thing that happened, in the order it happened. */
type Entry = {
  /** Milliseconds since the trace started. */
  at: number
  what: string
  /** Everything measured at that instant, printed in insertion order. */
  fields: Record<string, unknown>
}

/** The three numbers plus the two flags every decision in the panel is made
 *  from. Passed in rather than read here: this module deliberately knows nothing
 *  about the panel's state. */
export type Shot = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  pinned: number
  following: boolean
}

const dev = import.meta.env.DEV

class Trace {
  #ring: Entry[] = []
  #t0 = performance.now()
  /** When the last real hand-on-the-wheel event was seen, or -1 for none since
   *  the trace was cleared. This is the whole point of the exercise. */
  #gestured = -1
  /** What `following` was at the last entry that reported it, so a flip can be
   *  called out rather than left to be spotted in a column of numbers. */
  #was: boolean | null = null

  get sinceGesture(): number {
    if (this.#gestured < 0) return -1
    return Math.round(performance.now() - this.#gestured)
  }

  /** A gesture arrived. Recorded separately from `note` because the age of the
   *  last one is the measurement. */
  gesture(kind: string, extra: Record<string, unknown> = {}): void {
    if (!dev) return
    this.#gestured = performance.now()
    this.#push("GESTURE", { kind, ...extra })
  }

  /** Something happened that did not move the view. */
  note(what: string, fields: Record<string, unknown> = {}): void {
    if (!dev) return
    this.#push(what, fields)
  }

  /** Something happened that the follow's decision depends on. `shot` is taken
   *  by the caller so the numbers are the ones that decision actually saw. */
  saw(what: string, shot: Shot, fields: Record<string, unknown> = {}): void {
    if (!dev) return
    const slack = shot.scrollHeight - shot.scrollTop - shot.clientHeight
    const flipped = this.#was === true && shot.following === false
    this.#was = shot.following
    this.#push(what, {
      top: Math.round(shot.scrollTop),
      height: Math.round(shot.scrollHeight),
      client: Math.round(shot.clientHeight),
      slack: Math.round(slack),
      pinned: Math.round(shot.pinned),
      following: shot.following,
      sinceGesture: this.sinceGesture,
      ...fields,
    })
    /* The line the whole trace exists to produce. A release with no gesture
       behind it — `sinceGesture` of -1, or anything past a few hundred ms — is
       the column having let go of itself. */
    if (flipped) {
      const age = this.sinceGesture
      console.warn(
        `[tail] RELEASED after ${age < 0 ? "no gesture at all" : `${age}ms since last gesture`}` +
          ` — ${what}, slack ${Math.round(slack)}, pinned ${Math.round(shot.pinned)}`,
      )
    }
  }

  #push(what: string, fields: Record<string, unknown>): void {
    const at = Math.round(performance.now() - this.#t0)
    const entry: Entry = { at, what, fields }
    this.#ring.push(entry)
    if (this.#ring.length > RING) this.#ring.shift()
    console.debug(`[tail] ${String(at).padStart(6)} ${what}`, fields)
  }

  clear(): void {
    this.#ring = []
    this.#t0 = performance.now()
    this.#gestured = -1
    this.#was = null
  }

  dump(): string {
    return this.#ring
      .map(
        (e) =>
          `${String(e.at).padStart(7)}ms  ${e.what.padEnd(14)} ` +
          Object.entries(e.fields)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(" "),
      )
      .join("\n")
  }

  async copy(): Promise<string> {
    const text = this.dump()
    try {
      await navigator.clipboard.writeText(text)
      console.info(`[tail] ${this.#ring.length} entries on the clipboard`)
    } catch {
      console.info("[tail] clipboard refused; here it is instead")
      console.log(text)
    }
    return text
  }
}

export const trace = new Trace()

/* Reachable from the console without an import, which is the only way to get at
   it in a running window. */
if (dev && typeof window !== "undefined") {
  ;(window as unknown as { __tail: Trace }).__tail = trace
}
