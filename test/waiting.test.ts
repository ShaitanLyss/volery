import { describe, expect, test } from "bun:test";
import {
  LATE_AFTER_S,
  clockOf,
  hereAt,
  holdOf,
  pending,
  sessionWakes,
  waitLine,
  waitTitle,
  waitingOf,
  type Wake,
} from "../src/lib/waiting";
import { QUESTION_BLOOM_S, CLEAN_BLOOM_S, urgencyFor, foldTimers } from "../src/lib/classify";

const S = 1000;
const MIN = 60 * S;
/* Local time, so the clock strings are what a person here would read. */
const now = new Date(2026, 9, 15, 14, 0, 0).getTime();
const wake = (at: number | null, note = "check the deploy", from: Wake["from"] = "wall", id = "w1"): Wake => ({
  id,
  at,
  note,
  from,
});

describe("which wakes a card is still waiting on", () => {
  test("one armed in the last turn and due after it ended is waited on", () => {
    const endedAt = now - 2 * MIN;
    expect(pending([wake(now + 30 * MIN)], endedAt)).toHaveLength(1);
  });

  test("one due at or before the last turn ended was taken into a turn, and is spent", () => {
    /* It fired into a turn that was running, or opened the turn that has since
       ended. Neither source can say "it fired" — a serve deletes the row and
       the CLI echoes nothing — so the turn ending past it is the evidence. */
    expect(pending([wake(now - 5 * MIN)], now - 2 * MIN)).toEqual([]);
    expect(pending([wake(now - 2 * MIN)], now - 2 * MIN)).toEqual([]);
  });

  test("soonest first, and a schedule with no single moment last", () => {
    const ws = [wake(null, "hourly", "session", "c"), wake(now + 40 * MIN, "b", "wall", "b"), wake(now + 5 * MIN, "a", "wall", "a")];
    expect(pending(ws, 0).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  test("a card restored from disk waits on everything the table still holds", () => {
    /* `endedAt` is 0 until a turn ends on this wall; a row still in the table
       has not been served, whatever its time says. */
    expect(waitingOf([wake(now - 10 * MIN)], 0, now)?.lateS).toBe(10 * 60 - LATE_AFTER_S);
  });
});

describe("the ladder", () => {
  const endedAt = now - MIN;

  test("nothing armed is no reading at all — at rest stays at rest", () => {
    expect(waitingOf([], endedAt, now)).toBe(null);
    expect(holdOf(null)).toBe(null);
  });

  test("a long wait names the time", () => {
    const w = waitingOf([wake(now + 30 * MIN)], endedAt, now)!;
    expect(waitLine(w, now)).toBe("waiting — wakes at 14:30");
    expect(w.lateS).toBe(null);
  });

  test("a short one counts down, off the clock it is handed", () => {
    const w = waitingOf([wake(now + 4 * MIN + 10 * S)], endedAt, now)!;
    expect(waitLine(w, now)).toBe("waiting — wakes in 4m");
    expect(waitLine(w, now + 4 * MIN)).toBe("waiting — wakes in 10s");
  });

  test("passing zero is visible: waking, then late", () => {
    const at = now + 10 * MIN;
    const at0 = waitingOf([wake(at)], endedAt, at + 5 * S)!;
    expect(waitLine(at0, at + 5 * S)).toBe("waiting — waking now");
    expect(at0.lateS).toBe(null);

    const t = at + (LATE_AFTER_S + 3 * 60) * S;
    const late = waitingOf([wake(at)], endedAt, t)!;
    expect(late.lateS).toBe(3 * 60);
    expect(waitLine(late, t)).toBe("should have woken at 14:10 · 4m ago");
    expect(waitTitle(late, t)).toContain("has not woken it");
  });

  test("a wake across midnight says so", () => {
    const late = new Date(2026, 9, 15, 23, 50).getTime();
    expect(clockOf(new Date(2026, 9, 16, 2, 10).getTime(), late)).toBe("tomorrow 02:10");
  });

  test("a recurring schedule waits on no moment and is never late", () => {
    const w = waitingOf([wake(null, "every hour", "session")], endedAt, now + 9 * 3600 * S)!;
    expect(waitLine(w, now)).toBe("waiting — on a schedule");
    expect(w.lateS).toBe(null);
  });

  test("the tooltip says why, for each, and which one dies with the process", () => {
    const w = waitingOf(
      [wake(now + 30 * MIN, "look at the CI run"), wake(now + 50 * MIN, "check the release", "session", "w2")],
      endedAt,
      now,
    )!;
    expect(w.count).toBe(2);
    const t = waitTitle(w, now);
    expect(t).toContain("waiting on it, not finished");
    expect(t).toContain("at 14:30 — look at the CI run");
    expect(t).toContain("at 14:50 (held by its process, and lost with it) — check the release");
  });
});

describe("what it does to urgency", () => {
  test("a pending wake does not warm, however long the card has rested", () => {
    /* Lyss's card: grey at first (right), then amber on the neglect clock
       while it was doing exactly what it said it would (wrong). */
    const hold = holdOf(waitingOf([wake(now + 30 * MIN)], now - 20 * MIN, now));
    expect(urgencyFor("ok", CLEAN_BLOOM_S + 60, false, false, hold)).toBe("rest");
    expect(urgencyFor("question", QUESTION_BLOOM_S + 60, false, false, hold)).toBe("rest");
    /* And with nothing armed, the same card warms as it always did. */
    expect(urgencyFor("ok", CLEAN_BLOOM_S + 60)).toBe("ask");
  });

  test("a late wake warms at once and blooms on the question clock", () => {
    const at = now - 40 * MIN;
    const just = holdOf(waitingOf([wake(at)], at - MIN, at + LATE_AFTER_S * S));
    expect(just).toEqual({ lateS: 0 });
    /* Not the neglect clock: that would count from the rest forty minutes ago
       and bloom the instant the wake went late. */
    expect(urgencyFor("ok", 41 * 60, false, false, just)).toBe("soft");
    expect(urgencyFor("ok", 41 * 60, false, false, { lateS: QUESTION_BLOOM_S })).toBe("ask");
  });

  test("events still speak, and aside still has the last word", () => {
    const late = { lateS: 600 };
    expect(urgencyFor("error", 0, false, false, { lateS: null })).toBe("fail");
    expect(urgencyFor("asked", 0, false, false, { lateS: null })).toBe("ask");
    expect(urgencyFor("ok", 0, true, false, late)).toBe("rest");
    /* A late wake is news after whatever notice you acknowledged. */
    expect(urgencyFor("ok", 0, false, true, late)).toBe("ask");
    expect(urgencyFor("ok", 9_999, false, true, { lateS: null })).toBe("rest");
  });
});

describe("the CLI's schedules join the same reading", () => {
  test("a wakeup reads exactly as a wake_me does", () => {
    const t = foldTimers(
      [],
      "ScheduleWakeup",
      { delaySeconds: 1800, reason: "watching the deploy" },
      "Next wakeup scheduled for 14:30:00 (in 1800s).",
      false,
      now,
    );
    const w = waitingOf(sessionWakes(t), now - S, now)!;
    expect(waitLine(w, now)).toBe("waiting — wakes at 14:30");
    expect(w.note).toBe("watching the deploy");
  });

  test("a one-shot whose moment could not be read claims none", () => {
    expect(sessionWakes([{ id: "x", until: null, at: null, note: "" }])).toEqual([]);
  });
});

describe("across the flyway", () => {
  test("the moment moves onto this wall's clock and no clocks are compared", () => {
    /* The owner's clock runs an hour ahead of this one. Its snapshot was made
       at its 15:00, which this wall puts at its own 14:00; the wake is due
       twenty minutes after the snapshot was made, on either clock. */
    const ownerAt = now + 60 * MIN;
    const ownerWake = ownerAt + 20 * MIN;
    expect(hereAt(ownerWake, ownerAt, now)).toBe(now + 20 * MIN);
  });
});
