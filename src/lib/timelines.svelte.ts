/* The timelines on the glass, and the archive behind them.
 *
 * Every write goes through `timeline.rs`, which emits `timeline:changed` with
 * the row as it now stands — so this folds events rather than re-reading, and
 * nothing here polls. The one full read is at load, archive included: the
 * header offers the archive only when it holds something, so its count has to
 * be known before anybody opens it.
 *
 * Fed by `Skein`, for `Board`'s reason: it is the only place that listens to
 * Rust, and a second `listen()` is a second thing to release in `onDestroy`.
 */

import { invoke } from "@tauri-apps/api/core";
import { timelineOf, type Timeline } from "./timeline";

/** `Array.prototype.with`, which ES2022 does not have. */
function swap<T>(list: T[], at: number, value: T): T[] {
  return list.map((x, i) => (i === at ? value : x));
}

export class Timelines {
  /** Everything on the glass — live and complete, not yet archived — in the
   *  order they were drawn, which is the order the stack reads in. */
  shown = $state<Timeline[]>([]);
  /** The archive, newest first. Read once at load and then folded like the
   *  glass, so the header knows whether there is anything to offer. */
  archived = $state<Timeline[]>([]);
  /** How many are in the archive, so the header can offer it only when there
   *  is something to see — counted off the events rather than read. */
  archivedCount = $state(0);
  fault = $state<string | null>(null);

  async load() {
    try {
      const [shown, archived] = await Promise.all([
        invoke<unknown[]>("read_timelines"),
        invoke<unknown[]>("archived_timelines"),
      ]);
      this.shown = shown.map(timelineOf).filter((t): t is Timeline => !!t);
      this.archived = archived.map(timelineOf).filter((t): t is Timeline => !!t);
      this.archivedCount = this.archived.length;
      this.fault = null;
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** One row as it now stands, or its id alone when it has gone. */
  ingest(payload: { row: unknown; id: string }) {
    const t = timelineOf(payload?.row);
    const id = t?.id ?? payload?.id;
    if (!id) return;
    const onGlass = !!t && t.archivedAt === null;
    const at = this.shown.findIndex((x) => x.id === id);
    if (onGlass) {
      this.shown = at === -1 ? [...this.shown, t!] : swap(this.shown, at, t!);
    } else if (at !== -1) {
      this.shown = this.shown.filter((x) => x.id !== id);
    }
    const was = this.archived.findIndex((x) => x.id === id);
    if (t && !onGlass) {
      this.archived = was === -1 ? [t, ...this.archived] : swap(this.archived, was, t);
    } else if (was !== -1) {
      this.archived = this.archived.filter((x) => x.id !== id);
    }
    this.archivedCount = this.archived.length;
  }

  /** The card's live timeline, if it has one. */
  liveFor(convId: string): Timeline | null {
    return this.shown.find((t) => t.ownerId === convId && t.state === "live") ?? null;
  }

  async archive(id: string) {
    await this.#call("archive_timeline", { id });
  }

  /** Where the user put it, or back into the stack with nulls. Drawn at once,
   *  then written — the event that comes back carries the same numbers. */
  async place(id: string, x: number | null, y: number | null) {
    const at = this.shown.findIndex((t) => t.id === id);
    if (at !== -1) this.shown = swap(this.shown, at, { ...this.shown[at], glassX: x, glassY: y });
    await this.#call("place_timeline", { id, x, y });
  }

  /** Hand a left timeline to the card that has just adopted its session. */
  async resume(id: string, ownerId: string): Promise<string | null> {
    return this.#call("resume_timeline", { id, ownerId });
  }

  async #call(cmd: string, args: Record<string, unknown>): Promise<string | null> {
    try {
      await invoke(cmd, args);
      this.fault = null;
      return null;
    } catch (err) {
      this.fault = String(err);
      return String(err);
    }
  }
}
