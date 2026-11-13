/* The live collector: every request the wall's cards make, kept for minutes.
 *
 * **Nothing here is written down.** A sample exists so the reading a moment ago
 * can be compared with the one now, and it is dropped on a rolling bound. The
 * store already keeps the five-minute facts; this is the ungranulated edge of
 * that, and it exists because "what is arriving right now" has no bucket small
 * enough to answer it.
 *
 * A note arrives from `Conversation.ingest`, the one place that reads an
 * assistant message's `usage`, so there is one caller and no double count. The
 * cost is priced with `usage.ts::priceOf`, the same table the rest of the wall
 * uses, so the live figure and the settled one agree.
 */

import { priceOf } from "./usage";
import { totalsIn, type LiveSample } from "./live";

/** How far back the roll is kept. Long enough for a five-minute window and a
 *  minute of slack; short enough that a busy wall's array stays small. */
const KEEP_MS = 6 * 60_000;
/** A hard cap as well as a time bound, because a flooding card can write
 *  thousands of messages inside the window and a leak is a leak. */
const CAP = 4_000;

type Usage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

class Live {
  #samples: LiveSample[] = [];
  /** Svelte only re-runs a reader when a `$state` it read changed, so the roll
   *  itself is plain and this is the dependency a drawing hangs off. */
  #version = $state(0);

  get version(): number {
    return this.#version;
  }

  /** The roll, oldest first. Read it through the getters below rather than
   *  slicing it yourself, so every face measures the same window. */
  get samples(): readonly LiveSample[] {
    void this.#version;
    return this.#samples;
  }

  /** One request, as an assistant message reported it. `host` is this wall's:
   *  the stream only ever carries this machine's cards. */
  note(host: string, model: string, usage: Usage | null | undefined, at: number): void {
    if (!usage) return;
    const inTok = num(usage.input_tokens);
    const outTok = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const write = num(usage.cache_creation_input_tokens);
    if (inTok + outTok + cacheRead + write === 0) return;
    this.#samples.push({
      at,
      host,
      model,
      inTok,
      outTok,
      cacheRead,
      write,
      usd: priceOf(model, { in: inTok, out: outTok, cacheRead, cacheWrite: write }, at),
    });
    this.#trim(at);
    this.#version += 1;
  }

  /** The reading itself: what landed in `[from, to)`. */
  totals(from: number, to: number) {
    return totalsIn(this.#samples, from, to);
  }

  /** Everything older than the keep window goes, and the cap is the second
   *  bound: a card that emits for six minutes continuously must not grow an
   *  array without end. */
  #trim(now: number): void {
    const floor = now - KEEP_MS;
    let drop = 0;
    while (drop < this.#samples.length && this.#samples[drop]!.at < floor) drop += 1;
    if (drop > 0) this.#samples.splice(0, drop);
    const over = this.#samples.length - CAP;
    if (over > 0) this.#samples.splice(0, over);
  }
}

const num = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/** One collector for the window, like every other module-level store here. */
export const live = new Live();
