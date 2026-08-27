/* The one reader behind however many gate readings are on the wall.
 *
 * Sink 3ebe1d59. `Board`'s bargain, copied deliberately rather than adapted: a
 * widget asks by attaching and stops asking by detaching, and with nobody asking
 * nothing is read. A wall with no gate widget up never touches the table.
 *
 * **And it does not poll.** Every write to `gate_run` goes through
 * `store::open_gate_run` or `store::settle_gate_run`, both of which emit
 * `gates:changed` — so there is an event for every change there is, and a timer
 * here would be a poll for news that has already arrived. That is the rule
 * `board.svelte.ts` states for the billboard, and here it is load-bearing twice
 * over: CLAUDE.md allows exactly three places that go and look and demands an
 * argument from a fourth, and this whole feature's justification is that it
 * *folds what already happens*. A poller in the reading would undo the argument
 * behind the recorder.
 *
 * Keyed by tree rather than by project, for `migrate_v26`'s reason: two cards on
 * different worktrees of one project share a project and share no files, so a
 * project-scoped reading would report one card's red gate to another that cannot
 * reach the code causing it.
 *
 * Fed by `Skein`, for `Board`'s reason: it is the only place that talks to Rust,
 * and a second `listen()` is a second thing to release in `onDestroy`.
 */

import { invoke } from "@tauri-apps/api/core";
import { reading, type GateRun, type GateState } from "./gates";

/** What one row looks like coming off the wire, before it is trusted. */
type Raw = Record<string, unknown>;

/** Normalise one row, degrading rather than throwing.
 *
 *  `widget.config_json` and friends strike the same bargain, and CLAUDE.md names
 *  it: a normaliser runs on every read and degrades to something drawable, so a
 *  renamed column or a newer build's data costs no migration and cannot put a
 *  NaN inside a frame loop. Here the specific hazard is `settledAt`, which is
 *  genuinely nullable and must stay null rather than becoming 0 — a run whose
 *  end nobody saw would otherwise sort as though it happened in 1970 and would
 *  read as the oldest observation on the wall. */
function normalize(raw: Raw): GateRun | null {
  const str = (k: string): string | null =>
    typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : null;
  const toolId = str("toolId");
  const gate = str("gate");
  const root = str("root");
  const card = str("card");
  if (!toolId || !gate || !root || !card) return null;
  const num = (k: string): number | null =>
    typeof raw[k] === "number" && Number.isFinite(raw[k] as number) ? (raw[k] as number) : null;
  const outcome = str("outcome");
  return {
    toolId,
    card,
    cardName: str("cardName"),
    root,
    gate,
    scope: raw.scope === "partial" ? "partial" : "whole",
    narrowed: str("narrowed"),
    command: str("command") ?? "",
    startedAt: num("startedAt") ?? 0,
    settledAt: num("settledAt"),
    outcome:
      outcome === "passed" || outcome === "failed" || outcome === "unknown" ? outcome : "unknown",
    detail: str("detail"),
  };
}

export function normalizeAll(raw: unknown): GateRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => normalize(r as Raw)).filter((r): r is GateRun => r !== null);
}

export class Gates {
  /** Every run observed in every tree a widget has asked about, keyed by tree.
   *
   *  Per tree rather than one flat list, unlike `Board`'s single array: a card
   *  runs gates constantly, so this table is the busiest thing any widget reads,
   *  and one read per tree keeps a wall with four territories from re-fetching
   *  three of them every time the fourth moves. */
  runs = $state<Record<string, GateRun[]>>({});
  /** What went wrong reading it, drawn on the face rather than swallowed. */
  fault = $state<string | null>(null);
  /** Bumped on every settled read, so a widget can tell "nothing observed" from
   *  "not looked yet" without a second flag. */
  read = $state(0);

  /** Which trees anything has ever been observed in, busiest-recent first.
   *
   *  **Asked of Rust rather than derived from the wall.** A widget belongs to no
   *  project, and even a widget that wanted to could not work this out: the
   *  front end knows a card's `cwd` and its worktree *name*, where the record is
   *  keyed on the directory the child actually ran in (`worktree::run_dir`).
   *  Computing it here would be a second copy of `dir_for`'s spelling — the
   *  fact-written-twice failure `hooks.rs`'s matcher already paid for. It is
   *  also the more honest list: not "trees the wall has cards in" but "trees
   *  anybody has been seen running a gate in", which is what a reading can
   *  speak about at all. */
  trees = $state<string[]>([]);

  #watchers = new Set<string>();
  #busy = new Set<string>();

  get watchers(): number {
    return this.#watchers.size;
  }

  /** Whether anything on the wall is looking at the gates. */
  get watched(): boolean {
    return this.#watchers.size > 0;
  }

  attach(id: string) {
    const fresh = !this.#watchers.has(id);
    this.#watchers.add(id);
    /* The first widget up pays for the first read; the second draws what the
       first already fetched. */
    if (fresh) void this.refreshAll();
  }

  detach(id: string) {
    this.#watchers.delete(id);
    if (!this.#watchers.size) {
      /* Dropped rather than kept, so a widget taken off the wall does not leave
         the busiest table in the app pinned in memory for the session. */
      this.runs = {};
      this.trees = [];
    }
  }

  /** The tree list, then one read per tree. Nothing is read with nobody
   *  looking. */
  async refreshAll() {
    if (!this.watched) return;
    try {
      this.trees = (await invoke<unknown>("gate_trees")) as string[];
      this.fault = null;
    } catch (e) {
      this.fault = String(e);
      return;
    }
    await Promise.all(this.trees.map((r) => this.refresh(r, true)));
  }

  /** Re-read one tree, if anything is looking at it.
   *
   *  Guarded against overlap per tree rather than globally: two reads of the
   *  same tree in flight would settle in an order nobody chose and the loser
   *  would paint an older reading over a newer one, where two reads of
   *  *different* trees are simply two reads. Dropping the second is safe because
   *  every write emits, so whatever this one would have seen the next event
   *  brings. */
  async refresh(root: string, force = false) {
    if (!root) return;
    if (!force && !this.watched) return;
    if (this.#busy.has(root)) return;
    this.#busy.add(root);
    try {
      const raw = await invoke<unknown>("gate_runs", { root });
      this.runs = { ...this.runs, [root]: normalizeAll(raw) };
      this.fault = null;
    } catch (e) {
      this.fault = String(e);
    } finally {
      this.#busy.delete(root);
      this.read += 1;
    }
  }

  /** What `gates:changed` means: re-read that tree, and only that tree.
   *
   *  A root nobody has seen before also moves the tree *list*, which is the one
   *  case that needs the fuller read — the first gate ever run in a newly opened
   *  territory would otherwise not appear until something else provoked a
   *  refresh. */
  changed(root: string) {
    if (!this.watched) return;
    if (root && !this.trees.includes(root)) {
      void this.refreshAll();
      return;
    }
    void this.refresh(root);
  }

  /** The folded reading for one tree — one state per gate, red first. */
  stateOf(root: string): GateState[] {
    return reading(this.runs[root] ?? []);
  }

  /** Everything drops when the wall is torn down. */
  release() {
    this.#watchers.clear();
    this.#busy.clear();
    this.runs = {};
    this.trees = [];
  }
}
