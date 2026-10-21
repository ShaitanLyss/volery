/* Where `refs.ts` looks: the store for a sink item or a notice, git for a
 * commit.
 *
 * A card is `whois`'s — on this wall, on another one, or closed and still in the
 * store — and this does not repeat it: it is asked only about an id no card
 * answered to. What is left is two kinds of answer with two different costs, and
 * both are paid once and kept.
 *
 * - **A sink item or a notice** is in the store the moment anything names it, so
 *   one local query answers it for good, and a "no" is a "no": the render's worth
 *   of unknown ids is gathered into one ask, as `whois` gathers handles.
 * - **A commit** needs a repository, and the repository is whichever the prose
 *   was written in (`FileScope`'s root), so it is keyed on both. A presence is
 *   kept for the life of the window; an absence is re-asked after
 *   `COMMIT_RECHECK_MS`, since a hash is often written the instant it is made
 *   and "no such commit" is a reading of a moment (`refs.ts`).
 *
 * A singleton rather than a context, for `whois`'s reason, and it knows nothing
 * until a surface provides `reflinks.svelte.ts` — drawing is the surface's call,
 * looking is not.
 *
 * Reactive: every answer is a `SvelteMap` entry, so a component reading `other`
 * or `commit` redraws when the answer lands, and a streaming paragraph that asks
 * the same question on every token costs a map lookup after the first. */

import { invoke } from "@tauri-apps/api/core";
import { SvelteMap } from "svelte/reactivity";
import { commitKey, refText, say, standing, type Candidate, type Ref } from "./refs";
import { cardName } from "./naming";
import { whois } from "./whois.svelte";
import { whoIs } from "./whois";

/** What `other_names` says: a sink item or a notice. */
type Other = { handle: string; kind: "sink" | "notice"; title: string; settled: boolean };
/** What `commit_names` says. */
type Commit = { handle: string; short: string; subject: string; author: string; at: number };

/** A commit in full, for the sheet. */
export type CommitDetail = { handle: string; full: string; body: string; stat: string };

/** How long a render's worth of unknown ids is gathered before one ask. */
const GATHER_MS = 40;

type Seen = { at: number; yes: boolean; ref: Ref | null };

class Refs {
  #other = new SvelteMap<string, Ref | null>();
  #commits = new SvelteMap<string, Seen>();
  #waitingOther = new Set<string>();
  #waitingCommits = new Map<string, Set<string>>();
  /** What has been asked and not yet answered — an id, or a commit's
   *  `commitKey`. Without it, every render between the ask and the answer asked
   *  again: a streaming paragraph naming a hash re-derives once a token, and
   *  each re-ask is a git spawn (~0.5s apiece on this machine). Cleared when the
   *  answer is stored or the ask fails, so a failure is still retried. */
  #asking = new Set<string>();
  /** Bumped whenever an answer lands — see `whois.answered`. */
  answered = $state(0);
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the window is still the one that should be asking. */
  #live = true;

  /** The sink item or notice an id names, asking the store the first time.
   *  Undefined until it has answered, null for "neither". */
  other(key: string): Ref | null | undefined {
    const got = this.#other.get(key);
    if (got === undefined) this.#askOther(key);
    return got;
  }

  /** The commit a hash names in `root`, asking git the first time and again
   *  once a "no" has gone stale. Undefined until it has answered. */
  commit(root: string | null | undefined, sha: string): Ref | null | undefined {
    if (!root) return null;
    const key = commitKey(root, sha);
    const got = this.#commits.get(key);
    if (got && standing(got, Date.now())) return got.ref;
    this.#askCommit(root, sha.toLowerCase());
    return got ? got.ref : undefined;
  }

  /** The whole of a commit, for the sheet — one git call, on the click. */
  async detail(root: string, sha: string): Promise<CommitDetail | null> {
    try {
      return await invoke<CommitDetail | null>("commit_detail", { root, sha });
    } catch {
      return null;
    }
  }

  /** What an id is called, for a surface that cannot draw a chip: the card's
   *  name, the sink item's title, the commit's subject — or null when nothing
   *  has confirmed it names anything (yet). The order is `Inlines`' and for the
   *  same reason; this is that rule without the drawing. */
  nameOf(c: Candidate, root?: string | null): string | null {
    if (c.key.length === 8) {
      const card = whois.card(c.key);
      if (card) return cardName(card.face.title, "").text || "a conversation";
      const gone = whois.stored(c.key);
      if (gone) return whoIs(gone);
      if (gone === undefined) return null;
      const other = this.other(c.key);
      if (other) return refText(other);
      if (other === undefined) return null;
    }
    const commit = root ? this.commit(root, c.key) : null;
    return commit ? refText(commit) : null;
  }

  /** `text` with the ids it names replaced by their names (`refs.ts::say`). */
  say(text: string, root?: string | null): string {
    return say(text, (c) => this.nameOf(c, root));
  }

  /** A superseded generation must not go on asking (`Listeners`' hazard, one
   *  layer down): this holds a timer and no subscription. */
  release(): void {
    this.#live = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#waitingOther.clear();
    this.#waitingCommits.clear();
    this.#asking.clear();
  }

  #askOther(key: string): void {
    if (this.#waitingOther.has(key) || this.#asking.has(key)) return;
    this.#waitingOther.add(key);
    this.#arm();
  }

  #askCommit(root: string, sha: string): void {
    if (this.#asking.has(commitKey(root, sha))) return;
    const set = this.#waitingCommits.get(root) ?? new Set<string>();
    if (set.has(sha)) return;
    set.add(sha);
    this.#waitingCommits.set(root, set);
    this.#arm();
  }

  #arm(): void {
    this.#timer ??= setTimeout(() => void this.#flush(), GATHER_MS);
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    if (!this.#live) return;
    const others = [...this.#waitingOther];
    const commits = [...this.#waitingCommits];
    this.#waitingOther.clear();
    this.#waitingCommits.clear();
    await Promise.all([this.#flushOthers(others), ...commits.map(([root, shas]) => this.#flushCommits(root, [...shas]))]);
  }

  async #flushOthers(keys: string[]): Promise<void> {
    if (!keys.length) return;
    for (const k of keys) this.#asking.add(k);
    try {
      const named = await invoke<Other[]>("other_names", { handles: keys });
      const by = new Map(named.map((n) => [n.handle, n]));
      for (const k of keys) {
        const n = by.get(k);
        this.#other.set(
          k,
          n
            ? n.kind === "sink"
              ? { kind: "sink", key: k, title: n.title, settled: n.settled }
              : { kind: "notice", key: k, title: n.title }
            : null,
        );
      }
      this.answered += 1;
    } catch {
      /* A failed ask is not an answer (`known.ts`'s rule): nothing is recorded,
         so the next render asks again rather than pinning an id to "neither". */
    } finally {
      for (const k of keys) this.#asking.delete(k);
    }
  }

  async #flushCommits(root: string, shas: string[]): Promise<void> {
    const keys = shas.map((sha) => commitKey(root, sha));
    for (const k of keys) this.#asking.add(k);
    try {
      const named = await invoke<Commit[]>("commit_names", { root, shas });
      const by = new Map(named.map((n) => [n.handle, n]));
      const at = Date.now();
      for (const sha of shas) {
        const n = by.get(sha);
        const ref: Ref | null = n
          ? { kind: "commit", key: sha, short: n.short, subject: n.subject, author: n.author, at: n.at, root }
          : null;
        this.#commits.set(commitKey(root, sha), { at, yes: ref !== null, ref });
      }
      this.answered += 1;
    } catch {
      /* Not recorded, as above. */
    } finally {
      for (const k of keys) this.#asking.delete(k);
    }
  }
}

export const refs = new Refs();
