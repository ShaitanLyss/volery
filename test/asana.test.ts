import { describe, expect, test } from "bun:test";
import {
  boardReading,
  cardCount,
  columnOf,
  dueReading,
  emptySaid,
  plan,
  todayIso,
  type Board,
  type Card,
} from "../src/lib/asana";

/* The board, and where a card goes when you drop it.
 *
 * Nearly all of this is about `plan`, and `plan` is one function for a reason:
 * the optimistic update and the request are two statements of one intention,
 * and computing them apart is how they come to disagree. The concrete trap is
 * that `addTask` with no position puts the task at the **top** of the section —
 * so the tests that matter most here are the ones asserting what goes on the
 * wire beside what gets drawn. */

const card = (gid: string, over: Partial<Card> = {}): Card => ({
  gid,
  name: `task ${gid}`,
  assignee: "",
  due: "",
  completed: false,
  url: `https://app.asana.com/0/1/${gid}`,
  ...over,
});

/** Three columns: backlog `a` with a1 a2 a3, doing `b` with b1, done `c` empty.
 *  Plus the unsectioned pile, which is a real place a card can be and not a
 *  place one can be put. */
function board(): Board {
  return {
    project: "999",
    name: "Nova",
    url: "https://app.asana.com/0/999",
    more: 0,
    asked: 3,
    columns: [
      { gid: "a", name: "Backlog", cards: [card("a1"), card("a2"), card("a3")] },
      { gid: "b", name: "Doing", cards: [card("b1")] },
      { gid: "c", name: "Done", cards: [] },
      { gid: "", name: "no column", cards: [card("x1")] },
    ],
  };
}

/** The gids in one column of a planned board, for reading an assertion at a
 *  glance rather than through three levels of `find`. */
function order(b: Board, gid: string): string[] {
  return b.columns.find((c) => c.gid === gid)?.cards.map((k) => k.gid) ?? [];
}

describe("moving a card to another column", () => {
  test("it lands where it was dropped and leaves the column it came from", () => {
    const got = plan(board(), "a2", "b", "b1")!;
    expect(order(got.next, "b")).toEqual(["a2", "b1"]);
    expect(order(got.next, "a")).toEqual(["a1", "a3"]);
  });

  test("dropped above the first card, the wire says insert_before", () => {
    /* And never `insert_after` of nothing, which Asana reads as "top" — right
       here by luck and wrong the moment the column has been reordered by
       somebody else between the reading and the drop. Naming a neighbour is
       what makes the position survive that. */
    const got = plan(board(), "a2", "b", "b1")!;
    expect(got.wire).toEqual({ task: "a2", section: "b", before: "b1", after: null });
  });

  test("dropped past everything, the wire says insert_after the last card", () => {
    /* **The trap this file exists for.** With neither field Asana puts the task
       at the top of the section, so a drop at the bottom would be drawn at the
       bottom and then jump to the top on the next poll — which reads as the app
       having lost the drag rather than as a disagreement about order. */
    const got = plan(board(), "a1", "a", null)!;
    expect(order(got.next, "a")).toEqual(["a2", "a3", "a1"]);
    expect(got.wire).toEqual({ task: "a1", section: "a", before: null, after: "a3" });
  });

  test("into an empty column, neither field is sent", () => {
    /* The one case where Asana's default is also the only possible answer: the
       top of an empty section is its only position. */
    const got = plan(board(), "a2", "c", null)!;
    expect(order(got.next, "c")).toEqual(["a2"]);
    expect(got.wire).toEqual({ task: "a2", section: "c", before: null, after: null });
  });

  test("the wire never names the card being moved", () => {
    /* The stripped-list bug: computing neighbours from the column *including*
       the dragged card makes `insert_after` name the very task being inserted,
       which Asana refuses — and it only happens on a within-column drag, so it
       would ship. */
    for (const before of [null, "a1", "a2", "a3"]) {
      const got = plan(board(), "a2", "a", before);
      if (!got) continue;
      expect(got.wire.before).not.toBe("a2");
      expect(got.wire.after).not.toBe("a2");
    }
  });
});

describe("reordering inside one column", () => {
  test("a card moved up lands above the card it was dropped on", () => {
    const got = plan(board(), "a3", "a", "a1")!;
    expect(order(got.next, "a")).toEqual(["a3", "a1", "a2"]);
    expect(got.wire).toEqual({ task: "a3", section: "a", before: "a1", after: null });
  });

  test("a card moved down is positioned by the neighbour it ends up under", () => {
    /* `a1` above `a3` means, once `a1` is out of the list, index 1 — so it
       lands under `a2`. The wire has to say that and not "before a3", because
       both are true of the drawn result and only one of them stays true if the
       column gains a card in between. */
    const got = plan(board(), "a1", "a", "a3")!;
    expect(order(got.next, "a")).toEqual(["a2", "a1", "a3"]);
    expect(got.wire).toEqual({ task: "a1", section: "a", before: null, after: "a2" });
  });
});

describe("what is not a move", () => {
  test("dropping a card on itself does nothing", () => {
    /* Reads as "above me", which is where it already is — and would otherwise
       compute a wire position naming the dragged task. */
    expect(plan(board(), "a2", "a", "a2")).toBeNull();
  });

  test("dropping a card back exactly where it was does nothing", () => {
    /* The subtle one: `a1` dropped above `a2` is a real gesture that changes
       nothing, and an optimistic update with no request behind it would draw a
       move that never happened — then be "corrected" by the next poll, which
       looks exactly like a failed save that forgot to roll back. */
    expect(plan(board(), "a1", "a", "a2")).toBeNull();
    expect(plan(board(), "b1", "b", null)).toBeNull();
  });

  test("the unsectioned pile is not a drop target", () => {
    /* A real place a card can be and not a place one can be put: there is no
       section gid to POST to. Refused here so no path can produce a request
       with an empty gid in its URL. */
    expect(plan(board(), "a1", "", null)).toBeNull();
  });

  test("a card can be dragged out of the unsectioned pile", () => {
    /* The other direction is fine and is the useful half — this is how a task
       somebody added to the project without a column gets onto the board. */
    const got = plan(board(), "x1", "b", null)!;
    expect(order(got.next, "b")).toEqual(["b1", "x1"]);
    expect(order(got.next, "")).toEqual([]);
  });

  test("a card or column that is not on this board does nothing", () => {
    /* Reachable for real: a poll can land between the drag starting and the
       drop, and the card you were holding may have been completed away. */
    expect(plan(board(), "nope", "a", null)).toBeNull();
    expect(plan(board(), "a1", "nope", null)).toBeNull();
  });

  test("dropping above a card that is no longer there falls to the end", () => {
    /* Same race, one step later: the target card went away while you dragged.
       The end of the column is the answer that is certainly a position, and the
       alternative — refusing — would lose a gesture the person did make. */
    const got = plan(board(), "a1", "b", "gone")!;
    expect(order(got.next, "b")).toEqual(["b1", "a1"]);
    expect(got.wire.after).toBe("b1");
  });
});

describe("the board as a whole is not disturbed", () => {
  test("a plan does not mutate the board it was given", () => {
    /* The rollback depends on this. `asana.svelte.ts` keeps the previous board
       and puts it back when the save fails, so a `plan` that spliced in place
       would have already destroyed what it was going to restore. */
    const before = board();
    const snapshot = JSON.stringify(before);
    plan(before, "a2", "b", "b1");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("columns nobody touched come back as the same objects", () => {
    /* Not merely equal — identical. A board is redrawn on every optimistic
       move and a column that was not involved should not invalidate whatever is
       keyed on it. */
    const before = board();
    const got = plan(before, "a2", "b", "b1")!;
    expect(got.next.columns[2]).toBe(before.columns[2]);
  });

  test("nothing is lost or duplicated by a move", () => {
    const before = board();
    const got = plan(before, "a2", "b", "b1")!;
    expect(cardCount(got.next)).toBe(cardCount(before));
    const all = got.next.columns.flatMap((c) => c.cards.map((k) => k.gid));
    expect(new Set(all).size).toBe(all.length);
  });

  test("which column a card is in is answerable before and after", () => {
    const before = board();
    expect(columnOf(before, "a2")).toBe("a");
    expect(columnOf(plan(before, "a2", "b", "b1")!.next, "a2")).toBe("b");
    expect(columnOf(before, "nope")).toBeNull();
  });
});

describe("what the board says about itself", () => {
  test("it says what it holds and what it cost", () => {
    expect(boardReading(board())).toBe("4 columns · 5 cards");
  });

  test("a reading that was cut short says so rather than looking complete", () => {
    /* No silent caps. A truncated board that reads as a total is an instrument
       claiming to know something it does not, and the count is a floor because
       Asana does not say how many are left. */
    const b = { ...board(), more: 1 };
    expect(boardReading(b)).toBe("4 columns · at least 5 cards · more than one reading holds");
  });

  test("one of a thing is not pluralised", () => {
    const b: Board = { ...board(), columns: [{ gid: "a", name: "A", cards: [card("k")] }] };
    expect(boardReading(b)).toBe("1 column · 1 card");
  });
});

describe("what a due date says", () => {
  const today = "2026-09-03";

  test("no date says nothing at all", () => {
    expect(dueReading("", today)).toBeNull();
    /* And no today, which is the shape of a caller that has not ticked yet. */
    expect(dueReading("2026-09-03", "")).toBeNull();
  });

  test("today is today, and is not late", () => {
    /* Colour is status and overdue is the only status a date carries on its
       own. Treating today as late would make every board red by lunchtime. */
    expect(dueReading(today, today)).toEqual({ text: "today", late: false });
  });

  test("tomorrow and the near future are counted in days", () => {
    expect(dueReading("2026-09-04", today)).toEqual({ text: "tomorrow", late: false });
    expect(dueReading("2026-09-09", today)).toEqual({ text: "in 6 days", late: false });
  });

  test("further out is a date, without the year", () => {
    expect(dueReading("2026-09-30", today)).toEqual({ text: "30 sep", late: false });
    expect(dueReading("2027-01-08", today)).toEqual({ text: "8 jan", late: false });
  });

  test("overdue counts up and is the one late reading", () => {
    expect(dueReading("2026-09-02", today)).toEqual({ text: "1 day late", late: true });
    expect(dueReading("2026-08-27", today)).toEqual({ text: "7 days late", late: true });
  });

  test("the arithmetic is calendar days across a month and a year boundary", () => {
    /* Where a `new Date(iso)` comparison comes out a day wrong: the string form
       is UTC midnight by the spec and local midnight in enough engines that a
       date-only comparison drifts either side of a timezone. Both sides are
       built from parts, so this is about the calendar. */
    expect(dueReading("2026-09-01", "2026-08-31")).toEqual({ text: "tomorrow", late: false });
    expect(dueReading("2027-01-01", "2026-12-31")).toEqual({ text: "tomorrow", late: false });
  });

  test("a date that cannot exist is not silently turned into one that can", () => {
    /* `Date.UTC` rolls over: 2026 has no 29th of February, and that argument
       comes back as the 1st of March — so the gap is zero and the card would
       have read "today". Found by this test rather than by reasoning, and the
       round-trip in `utcOf` is what stops it. */
    expect(dueReading("2026-02-29", "2026-03-01")).toEqual({
      text: "2026-02-29",
      late: false,
    });
    /* And a leap year where the day does exist still counts properly. */
    expect(dueReading("2028-02-29", "2028-02-28")).toEqual({ text: "tomorrow", late: false });
  });

  test("a date that will not parse is shown rather than swallowed", () => {
    /* Asana answers `due_on` as a plain date and has done for years, so this is
       the arm for a field that changed shape — and showing it is how anybody
       would find out, where returning null would hide it forever. */
    expect(dueReading("someday", today)).toEqual({ text: "someday", late: false });
  });

  test("today is read in local time, not UTC", () => {
    /* A card due today must not read as "tomorrow" between midnight and 01:00
       in Paris, which is what a `toISOString().slice(0, 10)` would do. */
    const d = new Date(2026, 8, 3, 0, 30);
    expect(todayIso(d)).toBe("2026-09-03");
  });
});

describe("the five silences", () => {
  test("no token is named as the cause, not as an empty board", () => {
    /* The reading that saves the support conversation: nothing on this machine
       holds an Asana credential, so an empty widget is not merely empty. */
    expect(emptySaid(false, "999", board(), true)).toContain("no asana token");
  });

  test("a widget with no project chosen asks for one", () => {
    expect(emptySaid(true, "", null, true)).toBe("no project chosen — pick one");
  });

  test("a first reading in flight is not an empty board", () => {
    /* The first poll is three requests plus a page of tasks, so a wall with
       nothing on it and a wall whose first request is still going look
       identical otherwise. */
    expect(emptySaid(true, "999", null, false)).toBe("asking…");
  });

  test("a project with no columns and a project with no cards are different", () => {
    expect(emptySaid(true, "999", { ...board(), columns: [] }, true)).toBe(
      "this project has no columns",
    );
    const bare: Board = {
      ...board(),
      columns: [{ gid: "a", name: "Backlog", cards: [] }],
    };
    expect(emptySaid(true, "999", bare, true)).toBe("no cards on this board");
  });

  test("a board with something on it says nothing", () => {
    expect(emptySaid(true, "999", board(), true)).toBeNull();
  });
});
