/* The one connection to Asana behind however many board widgets are up.
 *
 * Same bargain as `devops.svelte.ts`, the process sampler and the transcript
 * reader: a widget asks by attaching and stops asking by detaching, and with
 * nobody asking nothing is requested and no credential is read. That matters
 * here for the reason it matters for the forge — this is something that leaves
 * the machine, and a wall nobody is looking at must not be talking to a
 * third-party server on a timer.
 *
 * Polling at all is the same deliberate exception. Asana has webhooks, but they
 * want a public endpoint to post to, and standing one up for a desktop wall is
 * a different application. So this is the fourth thing on the wall that goes
 * and looks, and it owes CLAUDE.md's argument: there is no event near a card
 * moving in somebody else's browser, and the leftover poll is bounded by
 * somebody watching.
 *
 * ## A reading is per project *and* per filter
 *
 * Two board widgets on one project, one showing open tasks and one showing
 * everything, are two different questions — so the key is both. Keying on the
 * project alone would have the second widget quietly redraw the first's
 * reading, which is the class of bug that looks like a filter that does not
 * work.
 *
 * ## The optimistic move, and the two races it has
 *
 * `plan` in `asana.ts` does the arithmetic and returns the new board with the
 * wire arguments; this file does the *timing*, which is where the bugs are.
 *
 * **A poll landing mid-save undraws the move.** The reading was taken before
 * Asana was told anything, so landing it would put the card back where it came
 * from — indistinguishable from a save that failed silently. So a poll that
 * lands while a save is in flight is dropped, and a reconciling poll is taken
 * once the save settles.
 *
 * **Rolling back to a snapshot is wrong when two moves overlap.** The snapshot
 * from the first move predates the second, so restoring it would undo a move
 * that had succeeded. The snapshot is therefore only restored when the failing
 * save is the *only* one in flight — the overwhelmingly common case, and the
 * one where an instant rollback is worth having — and a reconciling read
 * follows either way. Asana is the truth; the snapshot is only there so the
 * card does not sit in the wrong column for a network round trip. */

import { invoke } from "@tauri-apps/api/core";
import { plan, type Board, type Move } from "./asana";

/** How often a board is re-read while a widget is watching it.
 *
 * A kanban is somebody else's afternoon: cards move on the order of minutes and
 * nobody is waiting at the wall for one. One request per column would make this
 * expensive, which is exactly why `asana_board` reads the tasks in one query
 * with `memberships` instead — so a poll is three requests, and a minute
 * between them is roughly one request every twenty seconds to one host. */
const BOARD_EVERY = 60_000;

/** A workspace or a project: a gid, what it is called, and — for a project —
 *  whether you are a member of it.
 *
 *  That last field is what makes a picker over sixty projects usable: the
 *  handful you actually work in are the ones Asana's own sidebar shows under
 *  Work, and measured against the real workspace those are exactly the ones you
 *  are a *member* of. Starring was the other candidate and picked out only one
 *  of the three, so membership is the right notion. */
export type Named = { gid: string; name: string; mine: boolean };

/** One project's reading, at one filter. */
class Watch {
  board = $state<Board | null>(null);
  /** Whether a reading has ever landed. A project with nothing on it and a
   *  project whose first request is still in flight look identical otherwise,
   *  and the first poll is three requests plus a page of tasks. */
  ready = $state(false);
  fault = $state<string | null>(null);
  at = $state(0);
  /** Saves in flight against this board. Drawn — a card mid-save is worth
   *  marking — and load-bearing: it is what stops a poll undrawing a move, and
   *  what decides whether a snapshot rollback is safe. */
  saving = $state(0);
  /** What a refused save said. Cleared by the next attempt, and by being
   *  dismissed: a card that went back where it came from with no explanation is
   *  the wall silently disagreeing with you. */
  refused = $state<string | null>(null);
}

export class Asana {
  /** Every reading, keyed by project and filter. A record rather than a Map so
   *  it is `$state` all the way down and a component can read one without the
   *  whole thing being a dependency. */
  boards = $state<Record<string, Watch>>({});

  /** Every project the token can see, flat, across every workspace. Asked once
   *  when something wants it rather than on a clock — a project list changes
   *  when somebody makes a project, which is not an event worth a timer. */
  projects = $state<Named[]>([]);
  projectsReady = $state(false);
  projectsFault = $state<string | null>(null);

  /** The ones you are a member of — your own sidebar, in Asana's terms.
   *
   *  Kept as a derivation rather than a second fetch because it *is* the same
   *  fetch: `members` rides along on the project list. This is what the
   *  right-click knob offers, since a menu with sixty-four entries is a menu
   *  nobody can use; browsing the rest is the widget's own picker. */
  get mine(): Named[] {
    return this.projects.filter((p) => p.mine);
  }

  /** Whether a token is stored, and a way to go and look again. The same seam
   *  `DevOps.token` is, injected from `App` and owned by the panel — the vault
   *  is read in one place, and an empty row there is the whole reason a board
   *  is blank (Asana has no ladder behind it). */
  token: { held: () => boolean; ask: () => void } = { held: () => false, ask: () => {} };

  #watchers = new Map<string, Set<string>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = new Set<string>();
  #askingProjects = false;

  /** For the control surface's snapshot: how many widgets are asking, and
   *  whether anything is on a clock. */
  get watchers(): number {
    let n = 0;
    for (const set of this.#watchers.values()) n += set.size;
    return n;
  }

  get polling(): boolean {
    return !!this.#timer;
  }

  static key(project: string, open: boolean): string {
    return `${project}:${open ? "open" : "all"}`;
  }

  watch(project: string, open: boolean): Watch | null {
    return this.boards[Asana.key(project, open)] ?? null;
  }

  /* ── attaching ───────────────────────────────────────────────────────────*/

  attach(id: string, project: string, open: boolean) {
    /* A widget with no project chosen asks nothing. It draws a picker instead,
       which is why `askProjects` is called and the poller is not. */
    if (!project) {
      void this.askProjects();
      return;
    }
    const key = Asana.key(project, open);
    const set = this.#watchers.get(key) ?? new Set<string>();
    /* Detach from every other key first, because this is also how a widget
       *changes* project or filter — the config changed under it and the effect
       re-ran. Without this, switching project twice would leave two readings
       polling for one widget. */
    this.#drop(id, key);
    if (!set.has(id)) {
      set.add(id);
      this.#watchers.set(key, set);
      if (!this.boards[key]) this.boards[key] = new Watch();
      void this.#poll(key);
      /* Asked once when a widget arrives rather than on a clock of its own. It
         is what tells "this board is empty" apart from "there is nothing to ask
         with", and the panel asks again when it opens since the vault is
         reachable without us. */
      this.token.ask();
      void this.askProjects();
    }
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.#pollAll(), BOARD_EVERY);
    }
  }

  detach(id: string) {
    this.#drop(id, null);
    if (!this.#watchers.size) this.#stopTimer();
  }

  /** Take this widget off every key but one. `keep` is null to take it off all
   *  of them. */
  #drop(id: string, keep: string | null) {
    for (const [key, set] of [...this.#watchers]) {
      if (key === keep) continue;
      if (!set.delete(id)) continue;
      if (!set.size) this.#watchers.delete(key);
    }
  }

  #stopTimer() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Also called from App's `onDestroy` — a superseded generation left ticking
   *  by a hot reload would go on polling a third-party server for a wall nobody
   *  can see, which is the `Listeners` hazard in the shape a listener cannot
   *  fix. The readings are kept rather than cleared, so a widget hung straight
   *  back up draws what it had instead of blanking for a minute. */
  stop() {
    this.#stopTimer();
    this.#watchers.clear();
  }

  /** Read every watched board now rather than at the next beat. The seam the
   *  timer sits on rather than a path beside it, so the control surface can
   *  drive it without waiting out a minute — and it obeys the same rule the
   *  timer does and asks nothing while nobody is watching. */
  async refresh(): Promise<void> {
    await this.#pollAll();
  }

  /* ── reading ─────────────────────────────────────────────────────────────*/

  async #pollAll(): Promise<void> {
    await Promise.all([...this.#watchers.keys()].map((k) => this.#poll(k)));
  }

  async #poll(key: string, force = false): Promise<void> {
    const w = this.boards[key];
    if (!w) return;
    if (!force && !this.#watchers.has(key)) return;
    if (this.#busy.has(key)) return;
    this.#busy.add(key);
    const [project, filter] = splitKey(key);
    try {
      const got = await invoke<Board>("asana_board", { project, open: filter === "open" });
      /* **The first race.** This reading was taken before any in-flight save
         was sent, so landing it would put a card back where it came from — and
         that is indistinguishable from a save which failed and said nothing.
         The save takes its own reconciling read when it settles, so nothing is
         lost by dropping this one. */
      if (w.saving > 0) return;
      w.board = got;
      w.fault = null;
      w.at = Date.now();
    } catch (err) {
      w.fault = String(err);
      /* The rows already drawn stay — same rule `DevOps.#land` follows. A
         network blip must not empty a board somebody is reading, and the fault
         is shown over it. */
      w.at = Date.now();
    } finally {
      w.ready = true;
      this.#busy.delete(key);
    }
  }

  /** Every project the token can see. One request for the workspaces and one
   *  per workspace, so two or three in practice.
   *
   *  Once, unless asked again. Guarded against overlapping callers because a
   *  wall with four board widgets on it mounts four of them at the same
   *  instant, and four identical project lists is three requests nobody
   *  wanted. */
  async askProjects(again = false): Promise<void> {
    if (this.#askingProjects) return;
    if (this.projectsReady && !again) return;
    if (!this.token.held()) {
      /* Nothing to ask with. Not a fault — the panel says why, and it is the
         reason rather than a failure — but it must not be recorded as "asked
         and found nothing", or storing a token would not bring the list in. */
      this.projects = [];
      return;
    }
    this.#askingProjects = true;
    try {
      const spaces = await invoke<Named[]>("asana_workspaces");
      const lists = await Promise.all(
        spaces.map((s) => invoke<Named[]>("asana_projects", { workspace: s.gid })),
      );
      /* Prefixed with the workspace only when there is more than one, which is
         the same rule the widget-knob sources follow: on one workspace the
         prefix is the same word on every row and is therefore noise. */
      this.projects = lists.flatMap((rows, i) =>
        rows.map((p) => ({
          ...p,
          name: spaces.length > 1 ? `${spaces[i].name} · ${p.name}` : p.name,
        })),
      );
      this.projectsFault = null;
    } catch (err) {
      this.projectsFault = String(err);
    } finally {
      this.projectsReady = true;
      this.#askingProjects = false;
    }
  }

  /* ── the one write ───────────────────────────────────────────────────────*/

  /** Move a card, instantly, and then tell Asana.
   *
   *  `before` is the card the dragged one should land above, or null for the
   *  end of the column. `plan` decides both what is drawn and what is sent, so
   *  the two cannot disagree — see `asana.ts` for why that matters more than it
   *  sounds. */
  async move(
    project: string,
    open: boolean,
    task: string,
    section: string,
    before: string | null,
  ): Promise<void> {
    const key = Asana.key(project, open);
    const w = this.boards[key];
    if (!w?.board) return;
    const p = plan(w.board, task, section, before);
    /* Nothing to do — a drop back where it was, a column that cannot be moved
       into, a card a poll took away mid-drag. Deliberately silent: refusing out
       loud would put an error on the wall for a gesture that asked for nothing.
       And it must not draw an optimistic move with no request behind it, which
       the next poll would "correct" in a way that looks exactly like a save
       that failed without saying so. */
    if (!p) return;

    const undo = w.board;
    w.board = p.next;
    w.refused = null;
    w.saving += 1;
    let failed: string | null = null;
    try {
      await invoke("asana_move", { mv: p.wire satisfies Move });
    } catch (err) {
      failed = String(err);
    }
    w.saving -= 1;

    if (failed) {
      /* **The second race.** The snapshot predates any save that started after
         this one, so restoring it would undo a move that succeeded. Only safe
         when this was the only save in flight — which is nearly always, and is
         the case where an instant rollback is worth having. Otherwise the
         reconciling read below is the rollback, one round trip later. */
      if (w.saving === 0) w.board = undo;
      w.refused = failed;
    }
    /* Either way, go and see. On success because Asana decides the final
       ordering and a neighbour-relative insert can land a place the arithmetic
       here did not predict; on failure because the truth is over there and a
       snapshot is only a guess about it. `force`, since the poll guard would
       otherwise drop it when a sibling save is still going. */
    await this.#poll(key, true);
  }

  /** Dismiss a refusal. Its own verb because the message must not be cleared by
   *  a redraw: the card has moved back, so the sentence is the only remaining
   *  evidence that anything happened. */
  dismiss(project: string, open: boolean) {
    const w = this.boards[Asana.key(project, open)];
    if (w) w.refused = null;
  }
}

/** `"999:open"` → `["999", "open"]`. Split from the right, because a gid cannot
 *  contain a colon but this refuses to depend on that. */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(":");
  return at === -1 ? [key, "all"] : [key.slice(0, at), key.slice(at + 1)];
}
