/* The one reader behind however many billboards are on the wall.
 *
 * The same bargain `Ledger` and `Meter` strike: a widget asks by attaching and
 * stops asking by detaching, and with nobody asking nothing is read. A wall
 * with no billboard up never touches the table — which is the whole answer to
 * "I want to consult it when I desire to": you hang one up, and that gesture is
 * the asking.
 *
 * Unlike those two it does **not poll**, and that is the difference worth
 * naming. The usage reader polls because a turn taken in a terminal appends to
 * a file and emits nothing this app can hear. Every write to this table goes
 * through `board.rs`, which emits `board:changed` — so there is an event for
 * every change there is, and a timer here would be a poll for news that has
 * already arrived. Nothing on this wall polls when it has been told.
 *
 * Fed by `Skein`, for `Flights`' reason: it is the only place that talks to
 * Rust, and a second `listen()` is a second thing to release in `onDestroy`.
 */

import { invoke } from "@tauri-apps/api/core";
import { normalizeAll, type Notice } from "./board";

export class Board {
  /** Every notice on every board. The widgets filter — one read serves all of
   *  them, and a per-scope read would be several round trips for a table with
   *  a dozen rows in it. */
  notices = $state<Notice[]>([]);
  /** What went wrong reading it, drawn on the face rather than swallowed. */
  fault = $state<string | null>(null);
  /** Bumped on every settled read, so a widget can tell "nothing up" from
   *  "not looked yet" without a second flag. */
  read = $state(0);

  #watchers = new Set<string>();
  #busy = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  /** Whether anything on the wall is looking at the board. */
  get watched(): boolean {
    return this.#watchers.size > 0;
  }

  attach(id: string) {
    const fresh = !this.#watchers.has(id);
    this.#watchers.add(id);
    /* The first widget to go up pays for the first read; the second draws what
       the first already fetched. */
    if (fresh) void this.refresh();
  }

  detach(id: string) {
    this.#watchers.delete(id);
  }

  /** Re-read, if anything is looking.
   *
   *  Guarded against overlap rather than queued: two reads in flight would
   *  settle in an order nobody chose, and the loser would paint an older board
   *  over a newer one. Dropping the second is safe because every write emits,
   *  so whatever this one would have seen the next event will bring. */
  async refresh(force = false) {
    if (!force && !this.watched) return;
    if (this.#busy) return;
    this.#busy = true;
    try {
      const raw = await invoke<unknown>("read_board", { projectId: null });
      this.notices = normalizeAll(raw);
      this.fault = null;
    } catch (err) {
      this.fault = err instanceof Error ? err.message : String(err);
    } finally {
      this.#busy = false;
      this.read += 1;
    }
  }

  /** Put one up as yourself — the one instruction on this wall that reaches
   *  every agent without costing a turn.
   *
   *  Answers whether it landed, and that is not decoration: `post_notice`
   *  *refuses* a notice over the caps where a card's is clipped (see
   *  `board.rs::clip`), so there is now a real path where nothing went up. The
   *  caller has the only copy of what was typed — a face that cleared its
   *  draft anyway would lose the user's words to a length limit, which is the
   *  exact failure the refusal exists to stop, one layer up. */
  async post(
    subject: string,
    body: string,
    paths: string[] = [],
    projectId: string | null = null,
  ): Promise<boolean> {
    let ok = false;
    try {
      await invoke("post_notice", { subject, body, paths, projectId });
      this.fault = null;
      ok = true;
    } catch (err) {
      this.fault = err instanceof Error ? err.message : String(err);
    }
    /* Forced, because the event is coming and this is the one caller that
       should not wait for the round trip to come back the long way. */
    await this.refresh(true);
    return ok;
  }

  /** Take one down — anybody's. It is your wall. */
  async unpost(id: string) {
    try {
      await invoke("unpost_notice", { id });
      this.fault = null;
    } catch (err) {
      this.fault = err instanceof Error ? err.message : String(err);
    }
    await this.refresh(true);
  }
}
