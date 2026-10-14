/**
 * A card waiting on a wake, rather than at rest.
 *
 * `at rest` covered two states that want opposite things from you: **finished,
 * nothing will happen**, and **waiting, something will happen at a known
 * time**. A card that armed a wake for thirty minutes and stopped read exactly
 * like one that was done — and then warmed to amber for the neglect it was not
 * suffering, on its status disc and its outline alike (2026-10-15, a card on
 * another wall). The wall already knew: `later.rs` keeps every armed
 * `wake_me` with its time and the note saying why. Nothing drew it.
 *
 * ### Two sources, one reading
 *
 * A card can be woken by two clocks, and which one it used is not a thing you
 * care about while looking at the wall:
 *
 * - **`wall`** — Volery's own `wake_me`, a row in SQLite that outlives the
 *   process and is served by `later.rs`'s tick.
 * - **`session`** — the CLI's `CronCreate` and `ScheduleWakeup`, which live in
 *   the card's process alone and die with it (`classify.ts::foldTimers`).
 *
 * Both become a `Wake` here and both read the same on the face. They differ in
 * one way worth saying, and the tooltip says it: a session schedule is held by
 * the process, so a card that loses its process loses the schedule — and then
 * there is nothing left to be late, which is why `markExited` writes a line
 * into the transcript about it rather than this reading going on waiting.
 * A recurring cron job is the one shape that cannot fully join in: it names no
 * single moment, so it says "on a schedule" and can never be late.
 *
 * ### Spent is "a turn has ended since", not "it is gone from the table"
 *
 * Serving a `wake_me` deletes its row — the DELETE is the claim — and the CLI
 * never echoes its own schedule firing. So neither source can say *it fired*;
 * what both can say is that the card has since done something. A wake is still
 * being waited on while no turn has ended after its time: armed in a turn, due
 * after that turn ended, and nothing since. One due *during* a turn was taken
 * into it, or is queued behind it and will open the next. That is why
 * `later.rs` sends no event on a serve: a wake that went to the inbox of a
 * dormant card woke nothing, and if the face forgot it at the serve, it would
 * go quietly back to `at rest` — the one outcome this reading exists to stop.
 *
 * ### Late, and how late is late
 *
 * The inverse of `aside`, and the half worth getting right: `aside` stops the
 * clock indefinitely because you said you are not coming back; a wake has a
 * deadline, and once it has passed with nothing happening, the silence was a
 * promise that lapsed. See `urgencyFor` for what late does to the colour.
 *
 * `LATE_AFTER_S` is a minute past the time. Nothing that is going to arrive
 * arrives later than a few seconds past it: `later.rs`'s tick is five seconds
 * and a live card echoes the note within one; the CLI fires a wakeup on time
 * and a one-shot on time or *early*. So a minute is twelve of the waker's ticks
 * of margin, and short enough that by the time anybody glances at the card it
 * has said so. Between the time and the minute the card says it is waking,
 * which is the truth for those seconds and keeps the countdown passing zero
 * visible rather than merely recorded.
 *
 * ### Across the flyway
 *
 * `elsewhere.md`'s rule: **publish the moment, never the countdown.** The
 * digest carries the soonest wake's `at` on the owning wall's clock — constant
 * for as long as it is armed — and the far side moves it onto its own clock by
 * the same arithmetic `askedAt` uses, so no term compares two machines' clocks.
 * The tier is the owner's, so the far wall never decides lateness for colour;
 * it only words it.
 *
 * Pure: no runes, no clock read here. Everything that moves is handed in.
 */

import type { SessionTimer, WakeHold } from "./classify";

/** A moment a card asked to be handed a prompt. */
export type Wake = {
  id: string;
  /** Epoch ms it is due, on this wall's clock. Null for a schedule that names
   *  no single moment — a recurring cron job. */
  at: number | null;
  /** Why, in the card's own words. Drawn in a tooltip, never sent anywhere. */
  note: string;
  from: "wall" | "session";
};

/** What the face reads: the soonest wake still being waited on. */
export type Waiting = {
  at: number | null;
  note: string;
  from: "wall" | "session";
  /** How many are being waited on in all, this one included. */
  count: number;
  /** Seconds since it became late — past its time *and* past `LATE_AFTER_S` —
   *  or null while it is not. */
  lateS: number | null;
  /** The others, soonest first, for the tooltip. */
  rest: readonly Wake[];
};

/** Past its time, how long before a wake that has not woken anything is late. */
export const LATE_AFTER_S = 60;

/** Within this, the face counts down; past it, it names the time. A time is
 *  what you want of a wait you will come back to; a duration is what you want
 *  of one you might sit through. */
export const COUNTDOWN_UNDER_S = 15 * 60;

/** The CLI's schedules as wakes. A one-shot whose moment could not be read is
 *  left out: it has no time to say and nothing to be late against, and it
 *  still keeps the reaper off the card, which is the arm that matters for it. */
export function sessionWakes(timers: readonly SessionTimer[]): Wake[] {
  return timers
    .filter((t) => t.at !== null || t.until !== null)
    .map((t) => ({ id: t.id, at: t.at, note: t.note, from: "session" as const }));
}

/** The wakes still being waited on, soonest first, a recurring one last.
 *
 *  @param endedAt when the card's last turn ended. Anything due at or before it
 *  was taken into a turn or opened one. */
export function pending(wakes: readonly Wake[], endedAt: number): Wake[] {
  return wakes
    .filter((w) => w.at === null || w.at > endedAt)
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

/** The reading, or null when the card is not waiting on anything.
 *
 *  The caller decides whether a reading is wanted at all — a card mid-turn or
 *  running background work is working, whatever it has armed. */
export function waitingOf(wakes: readonly Wake[], endedAt: number, now: number): Waiting | null {
  return readWaiting(pending(wakes, endedAt), now);
}

/** The same, over a list `pending` already chose — so a caller can hold that
 *  list apart from the clock. The digest does: which wakes are pending changes
 *  on an event, and how late one is changes every second. */
export function readWaiting(pend: readonly Wake[], now: number): Waiting | null {
  const [first, ...rest] = pend;
  if (!first) return null;
  return {
    at: first.at,
    note: first.note,
    from: first.from,
    count: rest.length + 1,
    lateS: lateFor(first.at, now),
    rest,
  };
}

function lateFor(at: number | null, now: number): number | null {
  if (at === null) return null;
  const past = Math.floor((now - at) / 1000) - LATE_AFTER_S;
  return past >= 0 ? past : null;
}

/** What `urgencyFor` is handed. */
export function holdOf(w: Waiting | null): WakeHold {
  return w ? { lateS: w.lateS } : null;
}

/** A moment on another wall's clock, moved onto this one's.
 *
 *  `askedAt`'s arithmetic, which works forwards as well as back: `madeAt` is
 *  this wall's estimate of when the snapshot was made, and `t − at` is how far
 *  the moment was from that, measured on the owner's clock alone. */
export function hereAt(t: number, at: number | null, madeAt: number): number {
  return at === null ? madeAt : madeAt + (t - at);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `14:32`, local, and `tomorrow 02:10` when it is not today. */
export function clockOf(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `tomorrow ${hm}`;
}

function span(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The face's line. Lowercase, sentence-shaped, the house register. */
export function waitLine(w: Waiting, now: number): string {
  if (w.at === null) return "waiting — on a schedule";
  const ahead = Math.ceil((w.at - now) / 1000);
  if (ahead > COUNTDOWN_UNDER_S) return `waiting — wakes at ${clockOf(w.at, now)}`;
  if (ahead > 0) return `waiting — wakes in ${span(ahead)}`;
  if (w.lateS === null) return "waiting — waking now";
  return `should have woken at ${clockOf(w.at, now)} · ${span(Math.floor((now - w.at) / 1000))} ago`;
}

const NOTE_CAP = 280;

function said(w: { at: number | null; note: string; from: "wall" | "session" }, now: number): string {
  const when = w.at === null ? "on a schedule" : `at ${clockOf(w.at, now)}`;
  const held = w.from === "session" ? " (held by its process, and lost with it)" : "";
  const note = w.note.length > NOTE_CAP ? `${w.note.slice(0, NOTE_CAP - 1)}…` : w.note;
  return note ? `${when}${held} — ${note}` : `${when}${held}`;
}

/** The tooltip: why, in the card's own words, for each wake it is waiting on. */
export function waitTitle(w: Waiting, now: number): string {
  const head =
    w.lateS !== null
      ? "this card armed a wake that has not woken it — nothing has happened since its time"
      : "this card armed a wake and is waiting on it, not finished";
  return [head, said(w, now), ...w.rest.map((r) => said(r, now))].join("\n");
}
