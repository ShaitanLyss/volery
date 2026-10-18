import { describe, expect, test } from "bun:test";

import {
  afterClose,
  ageOf,
  dayOf,
  groups,
  matches,
  nextNeeding,
  projectsOf,
  step,
  subtitleOf,
  walkOrder,
  type ChatRow,
} from "../src/lib/chatview";

/* Noon on a Wednesday, local time, so "today" and "yesterday" are unambiguous. */
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const H = 3_600_000;

function row(id: string, over: Partial<ChatRow> = {}): ChatRow {
  return {
    id,
    title: id,
    project: "portfolio",
    host: null,
    working: false,
    doing: "",
    asking: null,
    deferred: null,
    notice: null,
    failed: false,
    aside: false,
    lastAt: NOW - H,
    turnAt: null,
    lastWords: "",
    parent: null,
    ...over,
  };
}

const keys = (rows: ChatRow[]) => groups(rows, NOW).map((g) => g.key);
const ids = (rows: ChatRow[], key: string) =>
  groups(rows, NOW).find((g) => g.key === key)?.rows.map((p) => p.row.id) ?? [];

describe("the sidebar's groups", () => {
  test("in the spec's order, and only those with something in them", () => {
    const rows = [
      row("old", { lastAt: NOW - 30 * 24 * H }),
      row("set", { aside: true }),
      row("fin", { notice: { kind: "done", text: "done" } }),
      row("ask", { asking: { text: "which dates?", nth: 1, of: 1 } }),
      row("run", { working: true, turnAt: NOW - 60_000 }),
      row("now", { lastAt: NOW - H }),
    ];
    expect(keys(rows)).toEqual(["needs", "working", "finished", "today", "earlier", "aside"]);
  });

  test("needs you takes a parked question, one put off, a question notice, a card's own notice and a failure", () => {
    const rows = [
      row("a", { asking: { text: "q", nth: 1, of: 1 } }),
      row("b", { deferred: "later" }),
      row("c", { notice: { kind: "question", text: "shall I?" } }),
      row("d", { notice: { kind: "own", text: "look" } }),
      row("e", { failed: true }),
      row("f", { notice: { kind: "done", text: "fine" } }),
    ];
    expect(ids(rows, "needs").sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(rows, "finished")).toEqual(["f"]);
  });

  test("a question you put off stays in needs you while the agent works on", () => {
    expect(ids([row("x", { deferred: "q", working: true })], "needs")).toEqual(["x"]);
  });

  test("needs you is ordered with no ring: a question first, then the rest in the wall's order", () => {
    const rows = [
      row("n1", { notice: { kind: "question", text: "?" } }),
      row("q1", { asking: { text: "q", nth: 1, of: 1 } }),
      row("n2", { failed: true }),
      row("q2", { asking: { text: "q", nth: 1, of: 2 } }),
    ];
    expect(ids(rows, "needs")).toEqual(["q1", "q2", "n1", "n2"]);
  });

  test("…and does not reorder when nothing about the rows changed", () => {
    const rows = [row("q1", { asking: { text: "a", nth: 1, of: 1 } }), row("q2", { asking: { text: "b", nth: 1, of: 1 } })];
    expect(ids(rows, "needs")).toEqual(ids([...rows], "needs"));
  });

  test("working rows sort by when the turn began, so speaking does not reshuffle them", () => {
    const rows = [
      row("older", { working: true, turnAt: NOW - 10 * 60_000, lastAt: NOW }),
      row("newer", { working: true, turnAt: NOW - 60_000, lastAt: NOW - 30_000 }),
    ];
    expect(ids(rows, "working")).toEqual(["newer", "older"]);
  });

  test("history buckets by the calendar, newest first", () => {
    const rows = [
      row("this-morning", { lastAt: NOW - 3 * H }),
      row("last-night", { lastAt: NOW - 14 * H }),
      row("monday", { lastAt: NOW - 50 * H }),
      row("earlier", { lastAt: NOW - 20 * 24 * H }),
      row("just-now", { lastAt: NOW - 60_000 }),
    ];
    expect(ids(rows, "today")).toEqual(["just-now", "this-morning"]);
    expect(ids(rows, "yesterday")).toEqual(["last-night"]);
    expect(ids(rows, "week")).toEqual(["monday"]);
    expect(ids(rows, "earlier")).toEqual(["earlier"]);
  });

  test("a set-aside row that needs you is still in needs you", () => {
    expect(ids([row("x", { aside: true, asking: { text: "q", nth: 1, of: 1 } })], "needs")).toEqual(["x"]);
  });
});

describe("children sit under their parent", () => {
  test("in the parent's group, nested", () => {
    const rows = [row("p", { working: true, turnAt: NOW }), row("k", { working: true, turnAt: NOW, parent: "p" })];
    const g = groups(rows, NOW).find((x) => x.key === "working")!;
    expect(g.rows.map((p) => [p.row.id, p.depth, p.ghost])).toEqual([
      ["p", 0, null],
      ["k", 1, null],
    ]);
  });

  test("an idle child follows a parent that is working", () => {
    const rows = [row("p", { working: true, turnAt: NOW }), row("k", { parent: "p" })];
    expect(ids(rows, "working")).toEqual(["p", "k"]);
    expect(ids(rows, "today")).toEqual([]);
  });

  test("a working child of a parent in history stays in working, under its parent's greyed title", () => {
    const rows = [row("p", { title: "the refactor" }), row("k", { working: true, turnAt: NOW, parent: "p" })];
    const g = groups(rows, NOW).find((x) => x.key === "working")!;
    expect(g.rows[0]).toMatchObject({ depth: 1, ghost: "the refactor" });
    expect(ids(rows, "today")).toEqual(["p"]);
  });

  test("a grandchild follows the chain", () => {
    const rows = [
      row("p", { working: true, turnAt: NOW }),
      row("k", { parent: "p" }),
      row("g", { parent: "k" }),
    ];
    const g = groups(rows, NOW).find((x) => x.key === "working")!;
    expect(g.rows.map((p) => [p.row.id, p.depth])).toEqual([
      ["p", 0],
      ["k", 1],
      ["g", 2],
    ]);
  });

  test("a parent that is not on the list leaves its child at the top", () => {
    expect(groups([row("k", { parent: "gone" })], NOW)[0].rows[0]).toMatchObject({ depth: 0, ghost: null });
  });

  test("a cycle in the lineage cannot hang the grouping", () => {
    const rows = [row("a", { parent: "b" }), row("b", { parent: "a" })];
    expect(() => groups(rows, NOW)).not.toThrow();
  });
});

describe("what a row says", () => {
  test("a question, and which of several", () => {
    expect(subtitleOf(row("x", { asking: { text: "which dates work for you?\nmore", nth: 1, of: 2 } }), "needs")).toBe(
      "asks: which dates work for you? · 1 of 2",
    );
    expect(subtitleOf(row("x", { asking: { text: "which?", nth: 1, of: 1 } }), "needs")).toBe("asks: which?");
  });

  test("a failure says it stopped", () => {
    expect(subtitleOf(row("x", { failed: true, lastWords: "API error 529" }), "needs")).toBe("stopped: API error 529");
  });

  test("a working row says what it is doing and where", () => {
    expect(subtitleOf(row("x", { working: true, doing: "running the tests" }), "working")).toBe(
      "running the tests · portfolio",
    );
    expect(subtitleOf(row("x", { working: true, doing: "reading", project: null, host: "laptop" }), "working")).toBe(
      "reading · chat · on laptop",
    );
  });

  test("a finished row says the first line of what it said", () => {
    expect(subtitleOf(row("x", { lastWords: "\nDone — the site has a dark mode.\nMore." }), "finished")).toBe(
      "Done — the site has a dark mode.",
    );
  });

  test("a history row has its place beside the title and nothing under it", () => {
    const p = groups([row("x", { project: null })], NOW)[0].rows[0];
    expect(p.sub).toBeNull();
    expect(p.aside).toBe("chat");
  });

  test("a working row's right-hand side is the age of its turn", () => {
    const p = groups([row("x", { working: true, turnAt: NOW - 4 * 60_000 })], NOW)[0].rows[0];
    expect(p.aside).toBe("4m");
  });

  test("tones are status only", () => {
    const tone = (r: ChatRow) => groups([r], NOW)[0].rows[0].tone;
    expect(tone(row("a", { asking: { text: "q", nth: 1, of: 1 } }))).toBe("ask");
    expect(tone(row("f", { failed: true }))).toBe("fail");
    expect(tone(row("w", { working: true }))).toBe("work");
    expect(tone(row("d", { notice: { kind: "done", text: "" } }))).toBe("done");
    expect(tone(row("r"))).toBe("rest");
  });

  test("ages are coarse", () => {
    expect([ageOf(40_000), ageOf(4 * 60_000 + 59_000), ageOf(2 * H), ageOf(50 * H)]).toEqual(["40s", "4m", "2h", "2d"]);
  });

  test("days are calendar days", () => {
    const midnight = new Date(2026, 9, 21).getTime();
    expect(dayOf(midnight, NOW)).toBe("today");
    expect(dayOf(midnight - 1, NOW)).toBe("yesterday");
  });
});

describe("walking the sidebar", () => {
  const rows = [
    row("ask", { asking: { text: "q", nth: 1, of: 1 } }),
    row("run", { working: true, turnAt: NOW }),
    row("old", { lastAt: NOW - 2 * H }),
    row("set", { aside: true }),
  ];
  const order = walkOrder(groups(rows, NOW));

  test("the walk is the sidebar's order, with set aside folded away", () => {
    expect(order).toEqual(["ask", "run", "old"]);
    expect(walkOrder(groups(rows, NOW), true)).toEqual(["ask", "run", "old", "set"]);
  });

  test("ctrl+tab steps and wraps", () => {
    expect(step(order, "run", 1)).toBe("old");
    expect(step(order, "old", 1)).toBe("ask");
    expect(step(order, "ask", -1)).toBe("old");
    expect(step(order, null, 1)).toBe("ask");
    expect(step([], null, 1)).toBeNull();
  });

  test("closing selects the next in the sidebar's order, or the one before at the end", () => {
    expect(afterClose(order, "run")).toBe("old");
    expect(afterClose(order, "old")).toBe("run");
    expect(afterClose(["only"], "only")).toBeNull();
  });

  test("alt+down goes to the next that needs you, wrapping", () => {
    const two = [row("a", { asking: { text: "q", nth: 1, of: 1 } }), row("b", { failed: true }), row("c")];
    const gs = groups(two, NOW);
    expect(nextNeeding(gs, null)).toBe("a");
    expect(nextNeeding(gs, "a")).toBe("b");
    expect(nextNeeding(gs, "b")).toBe("a");
    expect(nextNeeding(gs, "c")).toBe("a");
    expect(nextNeeding(groups([row("c")], NOW), "c")).toBeNull();
  });
});

describe("projects and search", () => {
  test("each project counts its conversations and dots its live ones", () => {
    const rows = [
      row("a", { working: true }),
      row("b", { asking: { text: "q", nth: 1, of: 1 } }),
      row("c"),
      row("d", { project: "recipes" }),
      row("e", { project: "recipes", host: "laptop" }),
    ];
    expect(projectsOf(rows, ["portfolio", "recipes", "empty"], NOW)).toEqual([
      { name: "portfolio", count: 3, live: ["work", "ask"] },
      { name: "recipes", count: 1, live: [] },
      { name: "empty", count: 0, live: [] },
    ]);
  });

  test("a search finds every word in the title, the place or the last words", () => {
    const r = row("x", { title: "Dark mode for the site", lastWords: "the header switch" });
    expect(matches(r, "dark site")).toBe(true);
    expect(matches(r, "PORTFOLIO header")).toBe(true);
    expect(matches(r, "dark lisbon")).toBe(false);
    expect(matches(r, "  ")).toBe(true);
  });
});
