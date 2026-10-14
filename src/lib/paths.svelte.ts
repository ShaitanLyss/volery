import { invoke } from "@tauri-apps/api/core";
import { definitionLine, fullPath, insideRoot, isBareName, soleMatch } from "./finding";

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

  /* ── a file named by its name alone ─────────────────────────────────────
     `App.svelte` and `queue.ts::settleHold` name no directory, so the question
     is not "is this there" but "which file is it" — one `rg --files` per batch
     rather than a `stat` apiece, and its own map because the answer is a path
     rather than a kind. Same three answers, same batching, same reason.

     **Never joined onto the root.** That is the construction `placesIn`'s
     separator rule exists to refuse — `RailReplayTests.cpp` reduced to a
     root-relative file that does not exist — and resolving the name across the
     project is what makes a bare name safe to offer at all. */

  /** What each asked-about name resolved to: the one file, or `null` for none
   *  *or several* — `soleMatch` refuses an ambiguous name rather than picking. */
  #found = $state<Record<string, string | null>>({});
  #seeking = new Map<string, Set<string>>();

  /** The file a bare name resolves to under `root`, or `undefined` while
   *  nobody has been told yet. */
  found(root: string, name: string): string | null | undefined {
    return this.#found[keyOf(root, name)];
  }

  seek(root: string, name: string) {
    if (!root || !name) return;
    if (keyOf(root, name) in this.#found) return;
    let set = this.#seeking.get(root);
    if (!set) {
      set = new Set();
      this.#seeking.set(root, set);
    }
    if (set.has(name)) return;
    set.add(name);
    if (this.#timer === null) {
      this.#timer = setTimeout(() => void this.#drain(), GATHER_MS);
    }
  }

  /** What a named place is: the path to open and whether it is a folder, or
   *  `null` while it is not (yet) a link. One question for both shapes so the
   *  renderer does not have to know there are two.
   *
   *  A reference with a symbol must land on a *file* — a symbol inside a
   *  folder is nothing to open — and a bare name always lands on one, since
   *  ripgrep lists files. */
  target(root: string, at: { path: string; symbol?: string[] }): { path: string; kind: PathKind } | null {
    if (isBareName(at.path)) {
      const file = this.found(root, at.path);
      return file ? { path: file, kind: "file" } : null;
    }
    const kind = this.kind(root, at.path);
    if (!kind || (at.symbol && kind !== "file")) return null;
    return { path: at.path, kind };
  }

  /** Queue whichever question `target` will need answered. */
  want(root: string, at: { path: string; symbol?: string[] }) {
    if (isBareName(at.path)) this.seek(root, at.path);
    else this.ask(root, at.path);
  }

  async #drain() {
    this.#timer = null;
    const named = [...this.#seeking.entries()];
    this.#seeking.clear();
    for (const [root, set] of named) {
      const names = [...set];
      let answer: Record<string, string[]> = {};
      try {
        answer = await invoke<Record<string, string[]>>("find_names", { root, names });
      } catch {
        /* No ripgrep, or the walk failed: every name stays text, recorded so
           it is not asked again on the next repaint. */
      }
      const next = { ...this.#found };
      for (const n of names) next[keyOf(root, n)] = soleMatch(n, answer[n] ?? []);
      this.#found = trim(next);
    }

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
function trim<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= KEEP) return map;
  const out: Record<string, T> = {};
  for (const k of keys.slice(keys.length - KEEP)) out[k] = map[k];
  return out;
}

export const paths = new Paths();

/** The line a symbol is defined on in a file, or null — asked when a
 *  `file::symbol` link is *clicked*, never when one is drawn.
 *
 *  That is the whole of what this costs, and it is the requirement: a
 *  transcript renders thousands of times a turn and a reference in it costs a
 *  name lookup in a map; reading the file and walking it for the definition is
 *  paid once, by the press that wants it. Nothing here reaches an agent. Null
 *  for anything that goes wrong — a file outside the root, a binary, a read
 *  that fails — because the reference was to a real file and opening it at the
 *  top is a fine degradation. */
export async function symbolLine(root: string, path: string, symbol: string[]): Promise<number | null> {
  const rel = insideRoot(fullPath(root, path), root);
  if (!rel) return null;
  try {
    const file = await invoke<{ text: string; binary: boolean }>("read_file_text", { root, path: rel });
    return file.binary ? null : definitionLine(file.text, symbol);
  } catch {
    return null;
  }
}

/* ── which directory a surface's prose counts from ─────────────────────────
 *
 * This was a prop. `FileLinks` was threaded from `Transcript` into `Markdown`
 * into `Inlines` and back into both of them recursively — thirteen `{files}`
 * inside the renderer and four at the call sites — and the comment on the type
 * said why it was one prop rather than two: "a second `{onpath}` beside
 * `{onlink}` at nine call sites is nine chances to forget one." That is the
 * right observation and halving it was the wrong fix. Three surfaces forgot
 * anyway — the ask panel, and the markdown the file viewer draws through
 * `Leaf` and `Folio` — so a path in a question an agent asked you was dead
 * text, and the only way to find out was to try clicking one.
 *
 * **A capability every surface should have is not something every surface
 * should have to ask for.** So the navigation is set once, at the root, and
 * reaches every `Markdown` in the app by being above it; what a surface may
 * still say is the one thing only it knows, which is the directory its prose
 * counts from. A new panel that renders an agent's words gets working links by
 * existing, and gets them wrong only by being wrong about *whose* words they
 * are — which is a mistake with a visible consequence, where forgetting a prop
 * had none.
 *
 * `test/finding.test.ts` holds the shape: neither `Markdown` nor `Inlines` may
 * grow a `files` prop again, because a prop that exists is a prop a surface can
 * omit.
 */

import { getContext, setContext } from "svelte";
import type { FileLinks } from "./finding";

/** Opening a path, which only `App` can do — it owns the finder and the one
 *  thing that talks to Rust. Takes the root explicitly rather than reading the
 *  focused card, because the prose being clicked is not always the focused
 *  card's: the dock draws whichever card is blocked, which may be another
 *  project entirely. */
export type GoToPath = (
  root: string,
  path: string,
  line: number | null,
  how: "open" | "reveal",
) => void;

type Scope = { go: GoToPath | null; root: () => string | null };

const FILES = Symbol("volery:files");

/** Set once, by the root. `root` is the fallback — the focused card — so a
 *  surface that says nothing still linkifies against something sensible. */
export function provideFileNavigation(go: GoToPath, root: () => string | null): void {
  setContext<Scope>(FILES, { go, root });
}

/** A surface naming the directory *its* prose counts from. One line, and the
 *  navigation comes down from above unrestated. `null` turns links off for
 *  everything inside, which is what a chat card's prose wants: a relative path
 *  there counts from nowhere. */
export function scopeFiles(root: () => string | null): void {
  const up = getContext<Scope | undefined>(FILES);
  setContext<Scope>(FILES, { go: up?.go ?? null, root });
}

/** What `Inlines` asks. `null` means draw the text and nothing more. */
export function useFiles(): () => FileLinks | null {
  const scope = getContext<Scope | undefined>(FILES);
  return () => {
    const root = scope?.root() ?? null;
    const go = scope?.go;
    if (!root || !go) return null;
    return { root, go: (path, line, how) => go(root, path, line, how) };
  };
}

/* ── and the link beside it ────────────────────────────────────────────────
 *
 * `onlink` is the same prop with the same hazard and *no* scope at all: every
 * caller in the app passed the identical function, because there is only one
 * thing a markdown link can mean here. The studio has no address bar and no
 * back button, so a link leaves for the desktop or does nothing; `App` and
 * `Spyglass` had each written that out, and the second one's comment says "the
 * same call the transcript makes" — which is a copy admitting it is a copy.
 *
 * Threaded through the same thirteen places, and forgotten in the one surface
 * that was added last: a markdown link in the gallery was dead while a path in
 * it was clickable, which is the inconsistency that makes the general rule
 * worth stating. If a capability is identical at every call site it is not a
 * prop, it is the environment.
 */

/** Where a markdown link goes. Set once; there is nothing a surface could
 *  usefully say about it, which is exactly why it was never a prop's business. */
export type OpenLink = (href: string) => void;

const LINKS = Symbol("volery:links");

export function provideLinkOpener(open: OpenLink): void {
  setContext<OpenLink>(LINKS, open);
}

/** What `Inlines` asks. A no-op where nothing provided one, so a link renders
 *  as its label and goes nowhere rather than throwing. */
export function useLinks(): OpenLink {
  return getContext<OpenLink | undefined>(LINKS) ?? (() => {});
}
