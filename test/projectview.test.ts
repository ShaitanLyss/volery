import { describe, expect, test } from "bun:test";

import { countsOf, filterOf, filtered, lineOf, rowsOf } from "../src/lib/projectview";
import { groups, type ChatRow } from "../src/lib/chatview";

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
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
    lastAt: NOW - 3_600_000,
    turnAt: null,
    lastWords: "",
    parent: null,
    ...over,
  };
}

const rows = [
  row("ask", { asking: { text: "which layout?", nth: 1, of: 1 } }),
  row("work", { working: true, doing: "running the tests" }),
  row("done", { notice: { kind: "done", text: "Done." }, lastWords: "\nDone — dark mode works.\nMore." }),
  row("old", { lastAt: NOW - 9 * 86_400_000, lastWords: "Fixed." }),
  row("other", { project: "paperwork" }),
  row("far", { host: "laptop" }),
];
const gs = groups(rows, NOW);

describe("a project's conversations", () => {
  test("every wall's conversations of this project, live first — a card elsewhere is one of them", () => {
    expect(rowsOf(gs, "portfolio").map((p) => p.row.id)).toEqual(["ask", "work", "done", "far", "old"]);
    expect(rowsOf(gs, "portfolio").find((p) => p.row.id === "far")!.aside).toBe("portfolio · on laptop");
  });

  test("filters by state, everything not live counting as finished", () => {
    const mine = rowsOf(gs, "portfolio");
    expect(countsOf(mine)).toEqual({ all: 5, needs: 1, working: 1, finished: 3 });
    expect(filtered(mine, "finished").map((p) => p.row.id)).toEqual(["done", "far", "old"]);
    expect(filtered(mine, "all")).toHaveLength(5);
    expect(filterOf(mine[0]!)).toBe("needs");
  });

  test("the line is what it asks, else the first line of what it last said", () => {
    const [ask, , done] = rowsOf(gs, "portfolio");
    expect(lineOf(ask!)).toContain("which layout?");
    expect(lineOf(done!)).toBe("Done — dark mode works.");
  });
});
