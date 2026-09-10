/**
 * The one chronicle reader behind however many faces read it.
 *
 * The same bargain `Journal`, `Board`, `Ledger` and `Beacon` strike: a face asks
 * by attaching and stops asking by detaching, and with nobody attached nothing
 * is read. Two registers on the wall are two views of one table, and two
 * subscriptions would be two copies of every row in memory and two reads per
 * write arriving.
 *
 * **Nothing here polls.** `chronicle.rs::changed` emits on every write, so this
 * is a fold over an event that already exists — the pipeline rule in CLAUDE.md,
 * and the reason this is not the fifth thing on the wall that goes and looks.
 * What arrives is a *signal* rather than the row, so the fold is a re-read: the
 * alternative is putting the whole entry on the wire and then having two
 * spellings of an entry, one of which nothing tests.
 *
 * Named for what it holds rather than after its component, per the house
 * convention and for the trap `journal.svelte.ts` records paying for three
 * times: `register.svelte.ts` beside `Register.svelte` is the *same import
 * specifier* on this filesystem, and `svelte-check` refuses it outright. Hence a
 * component called `Register` and a holder called `chronicle`, exactly as
 * `board`/`Billboard` and `sink`/`Basin` already do it.
 *
 * All the thinking is in `chronicle.ts`, which is pure and tested. What is here
 * is the subscription, the refcount, and the two writes.
 *
 * **The listener is released**, per CLAUDE.md's standing rule: an unreleased
 * `listen` re-reads a table into a holder nothing draws, once per write, on a
 * wall left open for days.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { normalizeAll, type Entry } from "./chronicle";

export class Chronicle {
  /** Newest first, as `chronicle_entries` returns them. */
  entries = $state<Entry[]>([]);

  /**
   * How many are waiting to be noticed.
   *
   * Asked of Rust rather than counted off `entries`, and the difference is not
   * pedantry: the tally is drawn by the header, which wants it on a wall with no
   * register up at all — and with nobody attached, `entries` is empty and
   * counting it would answer zero. `waiting` is therefore refreshed on the same
   * event and is meaningful on its own.
   */
  waiting = $state(0);

  #readers = new Set<string>();
  #unlisten: UnlistenFn | null = null;
  #wiring = false;

  /* ── coming and going ────────────────────────────────────────────────────*/

  attach(id: string) {
    const first = this.#readers.size === 0;
    this.#readers.add(id);
    if (first) void this.#wire();
    /* A second face attaching wants the rows now rather than at the next write.
       Cheap — one read of a bounded table — and without it a register hung on a
       quiet wall draws nothing until something happens, which reads as a broken
       widget rather than as a quiet afternoon. */
    else void this.refresh();
  }

  detach(id: string) {
    this.#readers.delete(id);
    if (this.#readers.size === 0) this.release();
  }

  release() {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  get listenerCount(): number {
    return this.#unlisten ? 1 : 0;
  }

  async #wire() {
    if (this.#wiring || this.#unlisten) return;
    this.#wiring = true;
    try {
      /* Subscribed before the first read, for `Journal`'s reason and with a
         better outcome here: a write landing between the read returning and the
         listener attaching would otherwise be a row nothing draws until the
         *next* write. Overlap costs one redundant read. */
      this.#unlisten = await listen("chronicle:changed", () => {
        void this.refresh();
      });
      await this.refresh();
    } catch {
      /* The face draws an empty register, which is what it would draw anyway.
         Nothing here is worth a fault banner: a chronicle that cannot be read is
         a missing reading, not a broken wall. */
    } finally {
      this.#wiring = false;
    }
  }

  /** Re-read the table and the count. */
  async refresh() {
    try {
      const [rows, waiting] = await Promise.all([
        invoke<unknown>("read_chronicle", {}),
        invoke<number>("chronicle_waiting", {}),
      ]);
      this.entries = normalizeAll(rows);
      this.waiting = typeof waiting === "number" && Number.isFinite(waiting) ? waiting : 0;
    } catch {
      /* Keep what is drawn. Emptying the register because one read failed would
         turn a transient store lock into apparent data loss. */
    }
  }

  /* ── the two writes ──────────────────────────────────────────────────────*/

  /**
   * Mark these seen, or every one of them when `ids` is empty.
   *
   * Optimistic, then corrected by the event the write emits — the shape
   * `asana.svelte.ts` argues for. The redraw here is worth having because
   * marking a row read is the one gesture in this subsystem you make while
   * looking straight at the thing that has to change.
   */
  async markSeen(ids: string[] = []) {
    const at = Date.now();
    const touch = new Set(ids);
    this.entries = this.entries.map((e) =>
      e.seenAt === null && (touch.size === 0 || touch.has(e.id)) ? { ...e, seenAt: at } : e,
    );
    this.waiting = this.entries.filter((e) => e.seenAt === null).length;
    try {
      await invoke("chronicle_seen", { ids });
    } catch {
      /* Put it back rather than leaving the wall claiming you have read
         something you have not — the direction matters here, since an unseen row
         drawn as seen is a thing that happened and will never be looked at. */
      await this.refresh();
    }
  }
}

/**
 * The wall has one. A module-level singleton for `journal`'s reason — a widget
 * and the header are the only things that want it, and threading it through
 * `WidgetNode` would put it in a file that is somebody else's.
 */
export const chronicle = new Chronicle();
