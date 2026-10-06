import { invoke } from "@tauri-apps/api/core";

/* What the paths an agent named in prose actually are.
 *
 * The transcript offers a path written in a sentence as something you can
 * click, and the only thing the *text* can tell you is the shape of one —
 * `.tmp/report.md` and `and/or` are the same shape, and so are `src/lib` and
 * `this/that`. So the pattern in `finding.ts` is allowed to be generous and
 * this is the guard: nothing becomes a link until the disk has said it is
 * there. A path this never hears about stays plain text, which is the right way
 * round to fail — a dead link in the middle of an agent's answer is the one
 * outcome worse than not offering the link, and `placesIn`'s own note next door
 * makes the same call for the same reason.
 *
 * It also answers the question the *click* needs, which is why it is one
 * question rather than two: a file opens in the viewer and a folder opens in
 * Explorer.
 *
 * One for the window, so a module-level instance — every transcript in the app
 * is asking about the same disk, and a cache per panel would re-ask for every
 * path each time you looked at another card.
 */

export type PathKind = "file" | "dir";

/** How long to wait before asking, in ms.
 *
 *  A streaming answer renders many times a second and each render hands over
 *  the same candidates; this collects a turn's worth into one call. Short
 *  enough that a finished answer lights up as you read it rather than after
 *  you have given up on it. */
const GATHER_MS = 120;

/** How many answers to keep.
 *
 *  Bounded because the alternative is a map that grows for as long as the app
 *  is open — a wall left up for days reads a great many transcripts. The
 *  eviction is crude on purpose: the whole point of the cache is the burst of
 *  repeats while one answer streams, and anything older than the last few
 *  thousand paths is a panel nobody is looking at. */
const KEEP = 4000;

/** Key the answer by the root as well, because the same relative path means
 *  different files in two cards. */
function keyOf(root: string, path: string): string {
  return `${root}\u0000${path}`;
}

class Paths {
  /** What each asked-about path turned out to be. `null` is a real answer —
   *  "the disk does not have this" — and is what keeps a candidate from being
   *  asked about again every time the paragraph repaints. */
  #known = $state<Record<string, PathKind | null>>({});
  /** Queued, keyed by root, because the command takes one root and a list. */
  #waiting = new Map<string, Set<string>>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** What this path is, or `undefined` while nobody has been told yet.
   *
   *  Three answers, not two: `undefined` is "ask me again in a moment" and is
   *  what the caller draws as plain text without giving up on it. */
  kind(root: string, path: string): PathKind | null | undefined {
    return this.#known[keyOf(root, path)];
  }

  /** Queue a question, if it is not already answered or queued.
   *
   *  Idempotent and cheap, because it is called from a render path: a
   *  paragraph being repainted sixty times while a turn streams must cost
   *  sixty map lookups and one round trip, not sixty round trips. */
  ask(root: string, path: string) {
    if (!root || !path) return;
    if (keyOf(root, path) in this.#known) return;
    let set = this.#waiting.get(root);
    if (!set) {
      set = new Set();
      this.#waiting.set(root, set);
    }
    if (set.has(path)) return;
    set.add(path);
    if (this.#timer === null) {
      this.#timer = setTimeout(() => void this.#drain(), GATHER_MS);
    }
  }

  async #drain() {
    this.#timer = null;
    const batches = [...this.#waiting.entries()];
    this.#waiting.clear();
    for (const [root, set] of batches) {
      const paths = [...set];
      let answer: Record<string, string> = {};
      try {
        answer = await invoke<Record<string, string>>("classify_paths", { root, paths });
      } catch {
        /* The disk refused to be asked. Every candidate in this batch is
           recorded as absent rather than left unanswered, so the render does
           not queue them all again on its next pass and spin. They stay text,
           which is what they already were. */
      }
      const next = { ...this.#known };
      for (const p of paths) {
        const kind = answer[p];
        next[keyOf(root, p)] = kind === "dir" || kind === "file" ? kind : null;
      }
      this.#known = trim(next);
    }
  }
}

/** Keep the map bounded. Oldest-inserted first, which object key order gives
 *  for free on string keys and is good enough for a cache whose whole job is
 *  the burst of repeats while one answer streams. */
function trim(map: Record<string, PathKind | null>): Record<string, PathKind | null> {
  const keys = Object.keys(map);
  if (keys.length <= KEEP) return map;
  const out: Record<string, PathKind | null> = {};
  for (const k of keys.slice(keys.length - KEEP)) out[k] = map[k];
  return out;
}

export const paths = new Paths();
