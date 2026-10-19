import { describe, expect, test } from "bun:test";

import { SKEIN_SPAWN_TOOL } from "../src/lib/classify";
import { shadowKey } from "../src/lib/shadow";
import {
  spawnedHandle,
  cardByHandle,
  SPAWN_TOOL,
  DWELL_MS,
  afterClose,
  ageOf,
  settles,
  settledByReading,
  allowanceLine,
  hostOfKey,
  goneGhost,
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
      row("e", { failed: true, notice: { kind: "failed", text: "API Error: 529 overloaded" } }),
      row("f", { notice: { kind: "done", text: "fine" } }),
    ];
    expect(ids(rows, "needs").sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(rows, "finished")).toEqual(["f"]);
  });

  test("a card that reads rust with no notice is not asking for anything: the tier is never the reason", () => {
    /* The wall Lyss's screenshot was of, as its own store had it on
       2026-10-19: seven cards whose last turn ended in an error, the oldest on
       14 September, and an empty notice queue. Every one of them was in
       *needs you*, as "stopped: it gave up". None is. */
    const day = 24 * H;
    const rust = [
      row("mover-harness", { failed: true, lastAt: NOW - 6 * day }),
      row("slide-anim", { failed: true, lastAt: NOW - 37 * day }),
      row("network-day", { failed: true, lastAt: NOW - 37 * day }),
      row("store-production", { failed: true, lastAt: NOW - 13 * day }),
      row("ai-testing", { failed: true, lastAt: NOW - 5 * day }),
      row("eos-dashboard", { failed: true, lastAt: NOW - 3 * H }),
      row("accounts-synced", { failed: true, lastAt: NOW - 3 * H, host: "QUEERISFREEDOM" }),
    ];
    expect(ids(rust, "needs")).toEqual([]);
    expect(keys(rust)).toEqual(["today", "week", "earlier"]);
    /* Still drawn as what they are. */
    expect(groups(rust, NOW).flatMap((g) => g.rows).every((p) => p.tone === "fail")).toBe(true);
  });

  test("a card waiting for allowance is quiet: not in needs you, not rust, and says when", () => {
    const held = row("held", { failed: true, allowance: { until: null, reset: "3:30pm" } });
    const waiting = row("waiting", { allowance: { until: NOW + 2 * H, reset: null } });
    const p = groups([held, waiting], NOW).flatMap((g) => g.rows);
    expect(ids([held, waiting], "needs")).toEqual([]);
    expect(p.map((x) => x.tone)).toEqual(["rest", "rest"]);
    expect(p.find((x) => x.row.id === "held")!.sub).toBe("waiting for allowance · resets 3:30pm");
    expect(p.find((x) => x.row.id === "waiting")!.sub).toBe("waiting for allowance · back in 2h");
    expect(allowanceLine({ until: null, reset: null }, NOW)).toBe("waiting for allowance");
  });

  test("a card on another wall is folded by the same rule", () => {
    const far = (over: Partial<ChatRow>) => row("f", { host: "QUEERISFREEDOM", ...over });
    expect(ids([far({ failed: true })], "needs")).toEqual([]);
    expect(ids([far({ failed: true, notice: { kind: "failed", text: "API Error: 529 overloaded" } })], "needs")).toEqual(["f"]);
    expect(ids([far({ notice: { kind: "question", text: "shall I?" } })], "needs")).toEqual(["f"]);
  });

  test("reading settles a finished turn and a failure, and nothing that waits on an answer", () => {
    expect(settledByReading({ kind: "done", text: "fine" })).toBe(true);
    expect(settledByReading({ kind: "error", text: "API Error: 529 overloaded" })).toBe(true);
    expect(settledByReading({ kind: "question", text: "shall I?" })).toBe(false);
    expect(settledByReading({ kind: "card", text: "found a bug" })).toBe(false);
    expect(settledByReading({ kind: "card", text: "wait for me", askId: "a1" })).toBe(false);
    expect(settledByReading({ kind: "done", text: "fine", askId: "a1" })).toBe(false);
    expect(settledByReading({ kind: "error", text: "You've hit your session limit · resets 2:30pm" })).toBe(false);
  });

  test("a question you put off stays in needs you while the agent works on", () => {
    expect(ids([row("x", { deferred: "q", working: true })], "needs")).toEqual(["x"]);
  });

  test("needs you is ordered with no ring: a question first, then the rest in the wall's order", () => {
    const rows = [
      row("n1", { notice: { kind: "question", text: "?" } }),
      row("q1", { asking: { text: "q", nth: 1, of: 1 } }),
      row("n2", { failed: true, notice: { kind: "failed", text: "API Error: 529 overloaded" } }),
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
    expect(g.rows[0]).toMatchObject({ depth: 1, ghost: { id: "p", label: "the refactor", state: "here", host: null } });
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

  test("a parent that is not on the list is named as closed, never left out", () => {
    /* Drawn at the top with nothing above it, a child reads as one a person
       started — and the parent was a gesture away that nothing offered. */
    expect(groups([row("k", { parent: "gone" })], NOW)[0].rows[0]).toMatchObject({
      depth: 1,
      ghost: { id: "gone", label: "started by a closed conversation", state: "closed", host: null },
    });
  });

  test("a parent closed on another wall says where, and one on a wall not heard from says so", () => {
    const far = shadowKey("QUEERISFREEDOM", "4f1c2b9e-0000-4000-8000-000000000000");
    const closed = groups([row("k", { parent: far })], NOW)[0].rows[0].ghost;
    expect(closed).toEqual({ id: far, label: "started by a conversation closed on QUEERISFREEDOM", state: "closed", host: "QUEERISFREEDOM" });
    const out = groups([row("k", { parent: far })], NOW, new Set([far]))[0].rows[0].ghost;
    expect(out).toMatchObject({ state: "unseen", label: "started on QUEERISFREEDOM — not heard from", host: "QUEERISFREEDOM" });
  });

  test("a parent on another wall that is listed is a real row, named and reachable like any", () => {
    const far = shadowKey("QUEERISFREEDOM", "4f1c2b9e-0000-4000-8000-000000000000");
    const rows = [row(far, { title: "RISE Coordinator", host: "QUEERISFREEDOM" }), row("k", { working: true, turnAt: NOW, parent: far })];
    const g = groups(rows, NOW).find((x) => x.key === "working")!;
    expect(g.rows[0].ghost).toEqual({ id: far, label: "RISE Coordinator", state: "here", host: "QUEERISFREEDOM" });
    expect(ids(rows, "today")).toEqual([far]);
  });

  test("a parent set aside is named above its child, and so is a live parent above a child set aside", () => {
    const a = groups([row("p", { title: "the plan", aside: true }), row("k", { parent: "p" })], NOW);
    expect(a.find((g) => g.key === "today")!.rows[0]).toMatchObject({ depth: 1, ghost: { id: "p", state: "here" } });
    const b = groups([row("p", { title: "the plan" }), row("k", { parent: "p", aside: true })], NOW);
    expect(b.find((g) => g.key === "aside")!.rows[0]).toMatchObject({ depth: 1, ghost: { id: "p", state: "here" } });
    /* Both set aside: nested, as anywhere else. */
    const c = groups([row("p", { aside: true }), row("k", { parent: "p", aside: true })], NOW);
    expect(c[0].rows.map((x) => [x.row.id, x.depth, x.ghost])).toEqual([
      ["p", 0, null],
      ["k", 1, null],
    ]);
  });

  test("the wall in a shadow's id is read as shadow.ts writes it", () => {
    expect(hostOfKey(shadowKey("lab-b.queerisfreedom", "abc"))).toBe("lab-b.queerisfreedom");
    expect(hostOfKey("4f1c2b9e-0000-4000-8000-000000000000")).toBeNull();
    expect(goneGhost("x", false).state).toBe("closed");
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
    expect(subtitleOf(row("x", { failed: true, notice: { kind: "failed", text: "API error 529\n\nhalfway" } }), "needs")).toBe(
      "stopped: API error 529",
    );
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

  test("a subtitle is words, not markdown", () => {
    expect(subtitleOf(row("x", { lastWords: "**What it does.** A drop under a `title`, _once_." }), "finished")).toBe(
      "What it does. A drop under a title, once.",
    );
    expect(subtitleOf(row("x", { lastWords: "## Round 2: what I'll check" }), "finished")).toBe("Round 2: what I'll check");
    expect(subtitleOf(row("x", { lastWords: "- first item" }), "finished")).toBe("first item");
    expect(subtitleOf(row("x", { lastWords: "2 * 3 = 6 and snake_case_name" }), "finished")).toBe("2 * 3 = 6 and snake_case_name");
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
    const two = [row("a", { asking: { text: "q", nth: 1, of: 1 } }), row("b", { failed: true, notice: { kind: "failed", text: "API Error: 529 overloaded" } }), row("c")];
    const gs = groups(two, NOW);
    expect(nextNeeding(gs, null)).toBe("a");
    expect(nextNeeding(gs, "a")).toBe("b");
    expect(nextNeeding(gs, "b")).toBe("a");
    expect(nextNeeding(gs, "c")).toBe("a");
    expect(nextNeeding(groups([row("c")], NOW), "c")).toBeNull();
  });
});

describe("projects and search", () => {
  test("each project counts its conversations, on every wall, and dots its live ones", () => {
    const rows = [
      row("a", { working: true }),
      row("b", { asking: { text: "q", nth: 1, of: 1 } }),
      row("c"),
      row("d", { project: "recipes" }),
      row("e", { project: "recipes", host: "laptop", working: true }),
    ];
    expect(projectsOf(rows, ["portfolio", "recipes", "empty"], NOW)).toEqual([
      { name: "portfolio", count: 3, live: ["work", "ask"] },
      { name: "recipes", count: 2, live: ["work"] },
      { name: "empty", count: 0, live: [] },
    ]);
  });

  test("needs you is ordered by how long each has waited, wherever it runs", () => {
    /* It was the wall's own order — this wall's cards, then every other's —
       with `far` putting another wall's behind at the same tier. */
    const rows = [
      row("here-new", { notice: { kind: "question", text: "?" }, since: NOW - 60_000 }),
      row("far-old", { host: "QUEERISFREEDOM", notice: { kind: "question", text: "?" }, since: NOW - 3_600_000 }),
      row("here-ask", { asking: { text: "q", nth: 1, of: 1 }, since: NOW - 10_000 }),
      row("far-ask", { host: "QUEERISFREEDOM", asking: { text: "q", nth: 1, of: 1 }, since: NOW - 20_000 }),
    ];
    expect(ids(rows, "needs")).toEqual(["far-ask", "here-ask", "far-old", "here-new"]);
  });

  test("a search finds every word in the title, the place or the last words", () => {
    const r = row("x", { title: "Dark mode for the site", lastWords: "the header switch" });
    expect(matches(r, "dark site")).toBe(true);
    expect(matches(r, "PORTFOLIO header")).toBe(true);
    expect(matches(r, "dark lisbon")).toBe(false);
    expect(matches(r, "  ")).toBe(true);
  });
});

describe("settling a finished conversation by reading it", () => {
  const ok = { selected: true, focused: true, away: false, seenFor: DWELL_MS };

  test("selected, in front, not away, and its last message on screen for two seconds", () => {
    expect(settles(ok)).toBe(true);
  });

  test("any one missing and it stands — skimming past, a background window, away, a glance", () => {
    expect(settles({ ...ok, selected: false })).toBe(false);
    expect(settles({ ...ok, focused: false })).toBe(false);
    expect(settles({ ...ok, away: true })).toBe(false);
    expect(settles({ ...ok, seenFor: DWELL_MS - 1 })).toBe(false);
  });
});

describe("conversations that start conversations", () => {
  const receipt = (text: string, failed?: true) => ({ name: SPAWN_TOOL, result: { text, failed } });

  test("a spawn's receipt names the card it opened", () => {
    expect(spawnedHandle(receipt("opening a card in C:\\x — its handle is ab12cd34. It has the brief"))).toBe("ab12cd34");
    expect(
      spawnedHandle(receipt("opening a card in the caravan project, at C:\\c — its handle is 0f0f0f0f. It has")),
    ).toBe("0f0f0f0f");
  });

  test("anything else opens nothing", () => {
    expect(spawnedHandle(undefined)).toBeNull();
    expect(spawnedHandle({ name: SPAWN_TOOL })).toBeNull();
    expect(spawnedHandle(receipt("its handle is ab12cd34", true))).toBeNull();
    expect(spawnedHandle({ name: "mcp__skein__send", result: { text: "its handle is ab12cd34" } })).toBeNull();
    expect(spawnedHandle(receipt("refused: three cards are already working"))).toBeNull();
  });

  test("the spawn tool's name is the classifier's", () => {
    expect(SPAWN_TOOL).toBe(SKEIN_SPAWN_TOOL);
  });

  test("a handle finds its card by prefix, and nothing else does", () => {
    const ids = ["ab12cd34-1111-2222", "ff00ff00-3333"];
    expect(cardByHandle("ab12cd34", ids)).toBe("ab12cd34-1111-2222");
    expect(cardByHandle("deadbeef", ids)).toBeNull();
    expect(cardByHandle("", ids)).toBeNull();
    expect(cardByHandle("ab12", ids)).toBeNull();
  });
});
