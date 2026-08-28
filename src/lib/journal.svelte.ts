/**
 * The app's own log, live — one subscription behind however many faces read it.
 *
 * The same shape as `deck.svelte.ts` and `beacon.svelte.ts`, and here the reason
 * is sharper than usual: this is the *process's* log, so three widgets showing
 * it are three views of one thing. Three subscriptions would be three copies of
 * every line in memory and three folds per line arriving.
 *
 * Named for what it is rather than for the module it serves, per the house
 * convention — and, as with `deck`, forced as well as chosen. `applog.svelte.ts`
 * beside `AppLog.svelte` differs only in casing, which on this filesystem
 * TypeScript refuses outright:
 *
 *     File name '.../applog.svelte' differs from already included file name
 *     '.../AppLog.svelte' only in casing.
 *
 * That is the third time this trap has been paid for here — `deck.svelte.ts` and
 * `waterfall.svelte.ts` are both named around it — and it was walked into again
 * *while writing the paragraph warning about it*. The lesson is not the casing
 * rule, which everyone here already knows; it is that naming a `*.svelte.ts`
 * after its component is the default move and the default move is wrong. Name it
 * after what it holds. `journal` is what a record of what happened is called.
 *
 * All the thinking is in `applog.ts`, which is pure and tested. What is here is
 * the subscription, the refcount, and the cap.
 *
 * **The listener is released**, per CLAUDE.md's standing rule: an unreleased
 * `listen` folds lines into a holder nothing draws, and on a wall left open for
 * days that is a leak with a heartbeat.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { LogLine } from "./applog";

/**
 * How many lines the front end keeps.
 *
 * The same number `applog.rs`'s ring keeps, and deliberately so: the Rust side
 * is the source of truth for what exists, and a front end that kept more would
 * be claiming to remember lines a fresh `app_log()` could not produce — so a
 * reload would silently shorten the history and look like data loss.
 */
const KEEP = 2000;

export class Journal {
  /** Everything kept, oldest first. */
  lines = $state<LogLine[]>([]);

  #readers = new Set<string>();
  #unlisten: UnlistenFn | null = null;
  #wiring = false;

  /* ── coming and going ────────────────────────────────────────────────────*/

  attach(id: string) {
    const first = this.#readers.size === 0;
    this.#readers.add(id);
    if (first) void this.#wire();
  }

  detach(id: string) {
    this.#readers.delete(id);
    if (this.#readers.size === 0) this.release();
  }

  release() {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  async #wire() {
    if (this.#wiring || this.#unlisten) return;
    this.#wiring = true;
    try {
      /* Subscribed *before* the catch-up read, and the order is load-bearing:
         the other way round, a line said between the read returning and the
         listener attaching is a line nothing ever sees. Overlap is harmless
         here — the same line arriving twice is two rows, where a missing one is
         the diagnosis somebody is looking for. Deduplication would cost a key
         these lines do not have, and the window is a few milliseconds. */
      this.#unlisten = await listen<LogLine>("app:log", (e) => {
        /* A fresh array rather than `push`, because `$state` invalidates on
           value identity — the trap CLAUDE.md records against the editor grid,
           which painted once and never again. */
        const next = [...this.lines, e.payload];
        this.lines = next.length > KEEP ? next.slice(next.length - KEEP) : next;
      });
      const held = await invoke<LogLine[]>("app_log");
      /* Only if nothing has arrived yet. A live line that beat the catch-up is
         newer than everything in it, and clobbering the array would drop it. */
      if (this.lines.length === 0) this.lines = held;
    } catch {
      /* Nothing to say, and nowhere to say it: an app that could not read its
         own log has no better channel to complain through. The face draws an
         empty log, which is what it would draw anyway. */
    } finally {
      this.#wiring = false;
    }
  }
}

/**
 * The wall has one. A module-level singleton for the reason `deck` is one — a
 * widget is the only thing that wants it, and threading it through `WidgetNode`
 * would put it in a file that is somebody else's.
 */
export const journal = new Journal();
