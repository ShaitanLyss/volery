/* The reader for Claude Code and plugin updates — what the accounts panel draws
 * and what `Skein` asks which cards are stale against.
 *
 * Named for what it does rather than `freshen.svelte.ts`, which on a
 * case-insensitive filesystem is the same import as `Freshen.svelte` — the trap
 * `waterfall.svelte.ts` and `release.svelte.ts` are named around.
 *
 * Nothing here polls. Rust runs the steps and emits `freshen:changed` with the
 * whole snapshot after each one; this holds the latest and says, once, when a
 * run has finished so the wall can write its row. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalSnapshot, type Run, type Snapshot } from "./freshen";

class Freshening {
  snap = $state<Snapshot | null>(null);
  /** The last thing the button or a setting could not do, for the panel. */
  fault = $state<string | null>(null);
  /** Called once per run that finishes while this window is listening. */
  onSettled: ((run: Run) => void) | null = null;
  #off: UnlistenFn | null = null;
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    void listen<unknown>("freshen:changed", (e) => this.#take(normalSnapshot(e.payload))).then(
      (off) => (this.#off = off),
    );
    void invoke<unknown>("freshen_state")
      .then((s) => this.#take(normalSnapshot(s)))
      .catch((e) => (this.fault = String(e)));
  }

  stop() {
    this.#off?.();
    this.#off = null;
    this.#started = false;
  }

  #take(next: Snapshot) {
    const was = this.snap;
    this.snap = next;
    const ran = was?.running && !next.running && next.last?.finishedAt;
    if (ran && next.last) this.onSettled?.(next.last);
  }

  get running(): boolean {
    return this.snap?.running === true;
  }

  async now(): Promise<boolean> {
    this.fault = null;
    try {
      return await invoke<boolean>("freshen_now");
    } catch (e) {
      this.fault = String(e);
      return false;
    }
  }

  async set(auto: boolean, everyHours: number) {
    try {
      this.#take(normalSnapshot(await invoke("freshen_settings", { auto, everyHours })));
    } catch (e) {
      this.fault = String(e);
    }
  }
}

export const freshening = new Freshening();
