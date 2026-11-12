/* The collector: a gesture goes in here, and a batch leaves every few seconds.
 *
 * **Nothing types.** This module records that a thing happened, never what was
 * typed or opened — no keystroke content, no draft, no prompt text, no file
 * name. The kinds are a closed vocabulary (`acts.ts::ACTION_KINDS`) and none of
 * them carries a word the person wrote.
 *
 * The shape is the one thing an instrument like this gets wrong: **a call per
 * gesture**. A fast minute is a few hundred pointer events, and a wall that
 * pays an IPC round trip per click is a wall that is slower the more you use
 * it. So the collector folds into a map keyed by (bucket, kind, target,
 * detail), sends **one** command every five seconds and only when something
 * happened, and sends each bucket's **running total** rather than a delta.
 *
 * That last choice is the store's bargain as much as this one's
 * (`analytics::note_action_rows`): a flush whose answer was lost is sent again
 * on the next tick, and a running total makes the resend free instead of
 * doubling every click in it. **So a bucket is kept until it can no longer
 * grow.** Deleting a key as soon as it has been sent is the bug this sentence
 * exists to prevent: the click after the flush would start a fresh count at one,
 * and the store, holding three, would refuse it — the minute would read as the
 * largest five-second window in it rather than as the minute.
 *
 * Five kinds are also **marks** (`MARK_KINDS`): a focus, a send, an interrupt, a
 * spawn, a close. Those are sent at the instant they happened as well as
 * counted, because their *order* is what the readings fold — a minute bucket
 * absorbs the order, and a switch is exactly the thing that happens inside one.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  GESTURE_KINDS,
  MARK_KINDS,
  MINUTE_MS,
  forgetAfter,
  noteIn,
  type ActionBucket,
  type ActionKind,
} from "./acts";

const MINUTE = MINUTE_MS;
/** Five seconds: long enough that a burst is one command, short enough that a
 *  crash loses at most a handful of gestures. */
const FLUSH_EVERY_MS = 5_000;
/** The store's own ceiling on one note, minus room for the minute that rolls
 *  over while we are still sending. Past it the oldest buckets go, which are
 *  the ones already final. */
const NOTE_CAP = 300;
/** How many refused flushes in a row before this gives up on what it is
 *  holding. Twelve is a minute of five-second retries: long enough to ride out
 *  a store that is briefly busy, short enough that a permanent refusal does not
 *  become a loop for the rest of the session. */
const GIVE_UP_AFTER = 12;

/** A mark carries a sequence of its own. Clearing the sent ones by length was
 *  wrong the moment the list could drop its oldest at the cap: a `shift` while
 *  a flush was in the air moved every later index, and the mark that had just
 *  arrived was the one sliced off and lost. */
type Mark = { seq: number; at: number; kind: string; target: string; detail: string };

const MARKED = new Set<string>(MARK_KINDS);
const COUNTED = new Set<string>(GESTURE_KINDS);

class Acts {
  /** The minute buckets, by (bucket, kind, target, detail). Kept until the
   *  bucket is over, because the store takes the largest count it is shown. */
  #dirty = new Map<string, ActionBucket>();
  /** The events themselves, oldest first, sent once each. */
  #marks: Mark[] = [];
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastFocus = "";
  /** Consecutive refused flushes, reset by any that lands. */
  #refusals = 0;
  /** The live read: deliberate gestures noted inside the current minute. */
  #liveAt = 0;
  #live = 0;
  /** Svelte only invalidates a reader when a `$state` it read changes, so the
   *  fields above are plain and this is the dependency a drawing hangs off. */
  #version = $state(0);

  get version(): number {
    return this.#version;
  }

  /** Deliberate gestures so far this minute, for the live strip. **The four
   *  the doc counts** — a view change or a chord is not one of them, or the
   *  tile would rise when you tidied the wall. */
  get thisMinute(): number {
    void this.#version;
    const at = Math.floor(Date.now() / MINUTE) * MINUTE;
    return this.#liveAt === at ? this.#live : 0;
  }

  /** One gesture. `target` is a card id, a panel name or a territory; `detail`
   *  is one short word (which view, which chord). Neither is ever text the
   *  person wrote. */
  note(kind: ActionKind, target = "", detail = ""): void {
    const now = Date.now();
    const at = Math.floor(now / MINUTE) * MINUTE;
    if (!this.#dirty.has(`${at}|${kind}|${target}|${detail}`) && this.#dirty.size >= NOTE_CAP) {
      this.#dropOldest();
    }
    noteIn(this.#dirty, kind, target, detail, now);
    if (MARKED.has(kind)) {
      if (this.#marks.length >= NOTE_CAP) this.#marks.shift();
      this.#marks.push({ seq: ++this.#seq, at: now, kind, target, detail });
    }
    if (COUNTED.has(kind)) {
      if (this.#liveAt !== at) {
        this.#liveAt = at;
        this.#live = 0;
      }
      this.#live += 1;
      this.#version++;
    }
    this.#arm();
  }

  /** The ring moved onto a card. Not a gesture of its own: a repeat landing on
   *  the card already in hand is the same visit, and the fold in `acts.ts`
   *  treats a repeat as no switch either, so the row is not worth a write. */
  focus(card: string): void {
    if (!card || card === this.#lastFocus) return;
    this.#lastFocus = card;
    this.note("focus", card);
  }

  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, FLUSH_EVERY_MS);
  }

  async #flush(): Promise<void> {
    if (this.#dirty.size === 0 && this.#marks.length === 0) return;
    /* The snapshot is taken together so a mark and its count always travel in
       one batch: they are two facts about one gesture and a reader must never
       see the second without the first. */
    const sent = [...this.#dirty.values()].map((b) => ({ ...b }));
    const sentMarks = this.#marks.slice();
    try {
      await invoke("note_actions", {
        notes: sent.map(({ at, kind, target, detail, count }) => ({ at, kind, target, detail, count })),
        marks: sentMarks.map(({ at, kind, target, detail }) => ({ at, kind, target, detail })),
      });
    } catch {
      /* Kept rather than dropped: a store that is briefly busy loses nothing,
         and the running-total rule makes the retry harmless if the write did
         land. **Re-armed here**, because `#arm` is only reached through a
         gesture: without this a failed flush with nothing after it sat in the
         map until the next click, and a wall that went quiet after an error
         lost the minute it had already counted.
         And given up on after a minute of trying. A batch the store refuses
         for a reason retrying cannot fix would otherwise be sent, refused and
         re-sent for the life of the session, and one bad row would block every
         gesture behind it. Losing a minute of counts is the smaller failure,
         and a store that refuses for a minute is one whose numbers nobody is
         reading. */
      if (++this.#refusals >= GIVE_UP_AFTER) {
        this.#dirty.clear();
        this.#marks = [];
        this.#refusals = 0;
        return;
      }
      this.#arm();
      return;
    }
    this.#refusals = 0;
    /* The marks are events: one row each, and the store ignores a repeat by
       its primary key. Everything up to the last sequence sent is gone from
       our end, whatever the list has done since — a `shift` at the cap must
       not take the mark that arrived during the write with it. */
    const last = sentMarks.at(-1)?.seq ?? 0;
    if (last > 0) this.#marks = this.#marks.filter((m) => m.seq > last);
    /* **A bucket is forgotten only once it can no longer grow**: its minute is
       over and its count has not moved since the snapshot. `acts.ts` owns that
       arithmetic, and its test is the sequence that was wrong — send 3, add 2,
       send 5. */
    forgetAfter(this.#dirty, sent, Date.now());
  }

  #dropOldest(): void {
    let oldestKey = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, n] of this.#dirty) {
      if (n.at < oldestAt) {
        oldestAt = n.at;
        oldestKey = key;
      }
    }
    if (oldestKey) this.#dirty.delete(oldestKey);
  }
}

/** One collector for the window, like every other module-level store here. */
export const acts = new Acts();
