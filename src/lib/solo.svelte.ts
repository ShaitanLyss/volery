/* Flying solo, as the window knows it.
 *
 * Rust owns the fact, because every door on the wire reads it (`here::SOLO`)
 * and a setting that lived here would have to be pushed into six places on one
 * side and trusted on the other. This owns what the wall does about it: the
 * plate's state, the chrome mark, and the one reaction the two fabrics cannot
 * do for themselves — bringing the cards, questions and screens of other
 * machines down, without touching this wall's own.
 *
 * Holds a subscription, so it owes `Listeners` and a `detach`. See the note in
 * CLAUDE.md on what a superseded instance goes on doing. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Listeners } from "./listeners";
import { soloSince } from "./solo";

type Setup = { solo?: boolean; soloSince?: number | null };

export class Solo {
  /** Flying solo now. */
  on = $state(false);
  /** When it started, in epoch ms, or `null` for not solo. */
  since = $state<number | null>(null);
  /** Whether the setting has been read at all — before it has, the plate and
   *  the mark draw nothing rather than claiming a state. */
  known = $state(false);
  /** The last refusal, in words, from either direction of the switch. */
  fault = $state<string | null>(null);

  /** What entering and leaving do to the rest of the wall. Both are the app's
   *  own classes and neither may own the other, so they are lent in (`Hands`'
   *  shape in `cards.svelte.ts`). Off until they are set, which is right: a
   *  wall that has not wired them is a window that has not finished starting. */
  entered: () => void = () => {};
  left: () => void = () => {};

  /** The plate's line: `solo since friday 18:04`, or nothing. */
  get reading(): string {
    return soloSince(this.since);
  }

  #listeners = new Listeners();

  attach() {
    const l = this.#listeners;
    l.keep(
      listen<boolean>("flyway:solo", (e) => {
        /* The command has already written the setting, so the state is read
           back rather than guessed — one source of truth for the instant. */
        void this.refresh();
      }),
    );
    /* A wall that leaves the flyway ends solo (`.claude/rules/solo.md`): there
       is nothing to be solo from, and a rejoin must not start closed. The
       setting is cleared on the Rust side; this is the reading of it. */
    l.keep(listen("flyway:left", () => void this.refresh()));
    void this.refresh();
  }

  detach() {
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async refresh() {
    try {
      const s = await invoke<Setup>("flyway_setup");
      this.#apply(!!s?.solo, s?.soloSince ?? null);
    } catch {
      /* No flyway command at all — an older build, or a wall that has never
         joined. Not a fault: the plate simply never appears. */
      this.known = true;
    }
  }

  /** The switch itself. Never optimistic: the setting is Rust's, and a fault
   *  is drawn rather than a state the wall does not have. */
  async set(on: boolean) {
    this.fault = null;
    try {
      await invoke("flyway_set_solo", { on });
      await this.refresh();
    } catch (e) {
      this.fault = typeof e === "string" ? e : e instanceof Error ? e.message : String(e ?? "");
      /* The state did not move, so the wall is right and only the switch is
         behind — refresh anyway in case it moved and the answer was lost. */
      await this.refresh();
    }
  }

  toggle() {
    void this.set(!this.on);
  }

  #apply(on: boolean, since: number | null) {
    const was = this.on;
    /* A start instant that is not there, or is not a moment, is not solo —
       the direction that loses the fact rather than inventing a state. */
    const next = on && typeof since === "number" && since > 0;
    this.known = true;
    this.since = next ? since : null;
    this.on = next;
    if (next === was) return;
    if (next) this.entered();
    else this.left();
  }
}
