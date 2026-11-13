import { describe, expect, test } from "bun:test";

import {
  ATTRIBUTION_GAP,
  asAgents,
  asSessionFacts,
  asToolTotals,
  bytesSaid,
  cellOf,
  columnsFor,
  concurrency,
  dayBuckets,
  foldSlices,
  habitModel,
  habitSaid,
  isSwap,
  latencySaid,
  profileLines,
  rateSaid,
  serverPoints,
  shareSaid,
  slices,
  sortToolLines,
  toolKpis,
  toolLines,
  toolTitle,
  type SessionFact,
} from "../src/lib/analyticsbehaviour";
import type { InvalidateRow } from "../src/lib/analyticswork";
import type { ToolTotal } from "../src/lib/analytics";
import { dayKey } from "../src/lib/analyticstrace";

const HOUR = 3_600_000;

function hour(over: Partial<ToolTotal> = {}): ToolTotal {
  return {
    kind: "builtin",
    server: "",
    tool: "Read",
    target: "",
    calls: 1,
    errors: 0,
    receipts: 0,
    msTotal: 100,
    msUnder50: 1,
    msUnder200: 0,
    msUnder1s: 0,
    msUnder5s: 0,
    msOver5s: 0,
    outBytes: 10,
    turnUsd: 0.1,
    ...over,
  };
}

function session(over: Partial<SessionFact> = {}): SessionFact {
  return {
    session: "s1",
    host: "home",
    project: "volery",
    source: "card",
    card: "c1",
    parentCard: "",
    openedBy: "person",
    branch: "main",
    startedAt: 1_000,
    endedAt: 2_000,
    cliMin: "2.1.300",
    cliMax: "2.1.300",
    accountFirst: "lyss",
    accountLast: "lyss",
    providerFirst: "anthropic",
    providerLast: "anthropic",
    turns: 1,
    ...over,
  };
}

function change(over: Partial<InvalidateRow> = {}): InvalidateRow {
  return {
    at: 1_500,
    host: "home",
    session: "s1",
    card: "c1",
    kind: "account",
    ref: "tx-team",
    tree: "C:/x",
    affected: 1,
    tokens: 0,
    inTokens: 0,
    model: "",
    usd: 0,
    provenance: "attributed",
    ...over,
  };
}

describe("the tool rows, as the command answers them", () => {
  test("a row with no tool is dropped and a kind this build does not know is a built-in", () => {
    const rows = asToolTotals([
      { tool: "Read", kind: "builtin", calls: 2 },
      { tool: "", kind: "builtin", calls: 99 },
      { tool: "Write", kind: "quantum", calls: 1 },
      null,
      "nope",
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].calls).toBe(2);
    expect(rows[1].kind).toBe("builtin");
  });

  test("a missing number is zero, never NaN", () => {
    const [row] = asToolTotals([{ tool: "Read", calls: "many", outBytes: null }]);
    expect(row.calls).toBe(0);
    expect(row.outBytes).toBe(0);
  });
});

describe("the four views", () => {
  test("tools merges the hours of one tool and keeps a built-in's server empty", () => {
    const lines = toolLines(
      [hour({ calls: 2, errors: 1, outBytes: 100, turnUsd: 0.2 }), hour({ calls: 3, outBytes: 50, turnUsd: 0.3 })],
      "tools",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe("Read");
    expect(lines[0].server).toBe("");
    expect(lines[0].calls).toBe(5);
    expect(lines[0].errors).toBe(1);
    expect(lines[0].bytes).toBe(150);
    expect(lines[0].cost).toBeCloseTo(0.5);
    expect(lines[0].errorRate).toBeCloseTo(0.2);
  });

  test("tools keeps an mcp tool's server apart from a built-in of the same name", () => {
    const lines = toolLines(
      [
        hour({ tool: "Read", kind: "builtin" }),
        hour({ tool: "Read", kind: "mcp", server: "fs" }),
      ],
      "tools",
    );
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.server).sort()).toEqual(["", "fs"]);
  });

  test("servers is mcp only, and a built-in never appears in it", () => {
    const lines = toolLines(
      [
        hour({ tool: "browser_click", kind: "mcp", server: "browser", calls: 4 }),
        hour({ tool: "ask_user", kind: "mcp", server: "skein", calls: 1 }),
        hour({ tool: "Read", kind: "builtin", calls: 9 }),
      ],
      "servers",
    );
    expect(lines.map((l) => l.name)).toEqual(["browser", "skein"]);
    expect(lines[0].calls).toBe(4);

    /* An mcp call whose name carried no server is a row, not a blank one. */
    const unnamed = toolLines([hour({ kind: "mcp", server: "", tool: "orphan" })], "servers");
    expect(unnamed.map((l) => l.name)).toEqual(["unnamed server"]);
  });

  test("a skill is grouped by the name the input carried, and falls back to the tool", () => {
    const lines = toolLines(
      [
        hour({ tool: "Skill", kind: "skill", target: "tx-toolkit:committee" }),
        hour({ tool: "Skill", kind: "skill", target: "" }),
      ],
      "skills",
    );
    expect(lines.map((l) => l.name).sort()).toEqual(["Skill", "tx-toolkit:committee"]);
  });

  test("an agent is grouped by its subagent type", () => {
    const lines = toolLines(
      [
        hour({ tool: "Agent", kind: "agent", target: "scout", calls: 2 }),
        hour({ tool: "Agent", kind: "agent", target: "scout", calls: 1 }),
        hour({ tool: "Task", kind: "agent", target: "red-team", calls: 1 }),
      ],
      "agents",
    );
    expect(lines.map((l) => [l.name, l.calls])).toEqual([
      ["scout", 3],
      ["red-team", 1],
    ]);
  });

  test("a rate with no calls is null rather than zero", () => {
    const [line] = toolLines([hour({ calls: 0, errors: 0 })], "tools");
    expect(line.errorRate).toBeNull();
  });

  test("the views and columns line up", () => {
    for (const view of ["tools", "servers", "skills", "agents"] as const) {
      const columns = columnsFor(view);
      expect(columns[0].key).toBe("name");
      expect(columns.some((c) => c.key === "cost")).toBe(true);
    }
  });
});

describe("the strip's figures", () => {
  test("a rate is total errors over total calls, never a mean of lines", () => {
    const kpis = toolKpis([
      hour({ tool: "A", calls: 1, errors: 1 }),
      hour({ tool: "B", calls: 99, errors: 0 }),
    ]);
    expect(kpis.calls).toBe(100);
    expect(kpis.errors).toBe(1);
    expect(kpis.errorRate).toBeCloseTo(0.01);
    expect(kpis.tools).toBe(2);
  });

  test("servers are mcp only, and a nameless one is not a server", () => {
    const kpis = toolKpis([
      hour({ kind: "mcp", server: "browser", tool: "click" }),
      hour({ kind: "mcp", server: "", tool: "orphan" }),
      hour({ kind: "builtin", tool: "Read" }),
    ]);
    expect(kpis.servers).toBe(1);
    expect(kpis.tools).toBe(3);
  });

  test("an empty window has no rate and no percentile at all", () => {
    const kpis = toolKpis([]);
    expect(kpis.errorRate).toBeNull();
    expect(kpis.p50).toBeNull();
    expect(kpis.p95).toBeNull();
  });
});

describe("the percentile, over the grain the row carries", () => {
  test("a band percentile is an estimate, and says so", () => {
    const [line] = toolLines([hour({ calls: 10, msUnder50: 9, msUnder5s: 1, msTotal: 5000 })], "tools");
    expect(line.p50?.basis).toBe("buckets");
    expect(line.p50?.exact).toBe(false);
    expect(line.p95?.atLeast).toBe(false);
    /* The fifth of ten calls sits five ninths into the 0-50ms band, which is
       what makes a band percentile an estimate rather than a sample. */
    expect(latencySaid(line.p50)).toBe("28ms");
  });

  test("a line with no completed call has no percentile at all", () => {
    const [line] = toolLines([hour({ calls: 3, msUnder50: 0, msUnder200: 0, msUnder1s: 0, msUnder5s: 0, msOver5s: 0 })], "tools");
    expect(line.p50).toBeNull();
    expect(latencySaid(line.p50)).toBe("—");
  });
});

describe("sorting the table", () => {
  test("a null sorts last whichever way the column is asked for", () => {
    const lines = toolLines([hour({ tool: "A", calls: 5 }), hour({ tool: "B", calls: 0, msUnder50: 0 })], "tools");
    const desc = sortToolLines(lines, "p50", "desc");
    expect(desc[desc.length - 1].name).toBe("B");
    const asc = sortToolLines(lines, "p50", "asc");
    expect(asc[asc.length - 1].name).toBe("B");
  });

  test("the sort is a copy, so the caller's order survives", () => {
    const lines = toolLines([hour({ tool: "A", calls: 1 }), hour({ tool: "B", calls: 5 })], "tools");
    const before = lines.map((l) => l.name);
    sortToolLines(lines, "name", "asc");
    expect(lines.map((l) => l.name)).toEqual(before);
  });
});

describe("the scatter", () => {
  test("the three loudest servers take the palette and the rest fold", () => {
    const rows = [
      hour({ tool: "a", kind: "mcp", server: "alpha", calls: 40 }),
      hour({ tool: "b", kind: "mcp", server: "beta", calls: 30 }),
      hour({ tool: "c", kind: "mcp", server: "gamma", calls: 20 }),
      hour({ tool: "d", kind: "mcp", server: "delta", calls: 10 }),
    ];
    const { points } = serverPoints(rows);
    const slot = Object.fromEntries(points.map((p) => [p.server, p.slot]));
    expect(slot).toEqual({ alpha: 0, beta: 1, gamma: 2, delta: -1 });
    /* Sorted by name, so the palette does not move when the table is sorted. */
    expect(points.map((p) => p.server)).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  test("a server whose calls never completed is counted and not placed", () => {
    const { points, unplaced } = serverPoints([
      hour({ tool: "a", kind: "mcp", server: "alpha", calls: 1 }),
      hour({ tool: "b", kind: "mcp", server: "beta", calls: 2, msUnder50: 0 }),
    ]);
    expect(points).toHaveLength(1);
    expect(unplaced).toBe(1);
  });

  test("a slot is spent only on a server that is drawn", () => {
    /* The loudest server failed every call, so it is in the table and not on
       the chart; the third hue belongs to the third server actually plotted. */
    const { points } = serverPoints([
      hour({ tool: "big", kind: "mcp", server: "big", calls: 100, msUnder50: 0 }),
      hour({ tool: "a", kind: "mcp", server: "alpha", calls: 40 }),
      hour({ tool: "b", kind: "mcp", server: "beta", calls: 30 }),
      hour({ tool: "c", kind: "mcp", server: "gamma", calls: 20 }),
    ]);
    const slot = Object.fromEntries(points.map((p) => [p.server, p.slot]));
    expect(slot).toEqual({ alpha: 0, beta: 1, gamma: 2 });
  });
});

describe("habits", () => {
  test("only a card session is a spawn, and an unknown opener is its own slice", () => {
    const sessions = [
      session({ session: "a", openedBy: "person" }),
      session({ session: "b", openedBy: "agent", parentCard: "c1" }),
      session({ session: "c", openedBy: "unknown" }),
      session({ session: "d", source: "terminal", card: "" }),
    ];
    const model = habitModel(sessions, [], [], 0, 10_000);
    expect(model.sessions).toBe(4);
    expect(model.spawns).toBe(3);
    const byOpener = Object.fromEntries(model.byOpener.map((s) => [s.label, s.value]));
    expect(byOpener).toEqual({ person: 1, agent: 1, unknown: 1 });
    expect(model.byOpener[0].share).toBeCloseTo(1 / 3);
  });

  test("a card opened before the window is in the window's sessions and not its spawns", () => {
    /* The command returns a session that began last week and is still running,
       because its spend and its bar belong to this window. It was not opened
       in it, so it must not put a spawn on a day whose bar holds none. */
    const model = habitModel(
      [session({ session: "old", startedAt: 1_000, endedAt: null })],
      [],
      [],
      5_000,
      10_000,
    );
    expect(model.sessions).toBe(1);
    expect(model.spawns).toBe(0);
    expect(model.days.reduce((n, d) => n + d.total, 0)).toBe(0);
  });

  test("a window that does not run forwards is answered, not walked", () => {
    const model = habitModel([session({ startedAt: 6, endedAt: 7 })], [], [], 10, 5);
    expect(model.days).toEqual([]);
    expect(model.spawns).toBe(0);
    expect(model.peakConcurrent).toBe(0);
  });

  test("a label that is empty is named rather than dropped", () => {
    const sliced = slices([
      ["volery", 2],
      ["", 2],
    ]);
    expect(sliced.map((s) => s.label).sort()).toEqual(["unknown", "volery"]);
    expect(sliced.reduce((n, s) => n + (s.share ?? 0), 0)).toBeCloseTo(1);
  });

  test("cards working at once: a sweep, clipped to the window, ends before starts", () => {
    const sessions = [
      session({ session: "a", startedAt: 1000, endedAt: 3000 }),
      session({ session: "b", startedAt: 2000, endedAt: 3000 }),
      session({ session: "c", startedAt: 3000, endedAt: 4000 }),
    ];
    const { peak, mean } = concurrency(sessions, 0, 4000);
    expect(peak).toBe(2, "a and b together, never b and c at the seam");
    expect(mean).toBeCloseTo((1000 * 1 + 1000 * 2 + 1000 * 1) / 4000);
  });

  test("an open session runs to the window's edge and is not invented an end", () => {
    const { peak } = concurrency([session({ startedAt: 1000, endedAt: null })], 0, 5000);
    expect(peak).toBe(1);
  });

  test("fan-out is agent calls per card session working in the window", () => {
    const model = habitModel(
      [session({ session: "a" }), session({ session: "b" })],
      [hour({ kind: "agent", tool: "Agent", target: "scout", calls: 6 })],
      [],
      0,
      10_000,
    );
    expect(model.agentCalls).toBe(6);
    expect(model.fanOut).toBe(3);
  });

  test("a card opened before the window is in the fan-out denominator, not the spawns", () => {
    /* It made the agent calls this morning, so it belongs to both halves of
       the ratio; it was not opened in the window, so it is not a spawn. */
    const model = habitModel(
      [session({ session: "old", startedAt: 1_000, endedAt: null })],
      [hour({ kind: "agent", tool: "Agent", target: "scout", calls: 4 })],
      [],
      5_000,
      10_000,
    );
    expect(model.spawns).toBe(0);
    expect(model.fanOut).toBe(4);
  });

  test("working at once means cards, not adopted terminal sessions", () => {
    const model = habitModel(
      [
        session({ session: "a", startedAt: 1_000, endedAt: 9_000 }),
        session({ session: "t", source: "terminal", card: "", startedAt: 1_000, endedAt: 9_000 }),
      ],
      [],
      [],
      0,
      10_000,
    );
    expect(model.peakConcurrent).toBe(1, "the terminal session is not a card");
    expect(model.sessions).toBe(2);
  });

  test("a move is counted once, and a file invalidation is not a move", () => {
    const changes = [
      change({ kind: "provider", card: "c1" }),
      change({ kind: "model", card: "c1" }),
      change({ kind: "edit", card: "c2" }),
      change({ kind: "write", card: "c2" }),
    ];
    const model = habitModel([session()], [], changes, 0, 10_000);
    expect(model.swaps).toBe(2);
    expect(model.swapCards).toBe(1);
    expect(changes.filter(isSwap)).toHaveLength(2);
  });

  test("the days are zero-filled, so a quiet day is a bar of nothing rather than a gap", () => {
    const from = new Date(2026, 10, 1).getTime();
    const to = new Date(2026, 10, 5).getTime();
    const model = habitModel([session({ startedAt: from + HOUR })], [], [], from, to);
    expect(model.days.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(model.days[0].person).toBe(1);
    expect(model.days[1].total).toBe(0);
    expect(model.perDay).toBeCloseTo(0.25);
  });

  test("a day that starts at the window's end is not a day the window has", () => {
    const from = new Date(2026, 10, 1).getTime();
    const to = new Date(2026, 10, 2).getTime();
    const sessions = [1, 2, 3, 4].map((n) => session({ session: `s${n}`, startedAt: from + n * 1000 }));
    const model = habitModel(sessions, [], [], from, to);
    expect(model.days.map((d) => d.day)).toEqual(["2026-11-01"], "one bar, not a phantom one at midnight");
    expect(model.perDay).toBe(4, "four cards in one day is four a day");
  });

  test("the provider is the last one the session spent on", () => {
    const model = habitModel(
      [session({ providerFirst: "anthropic", providerLast: "deepseek" })],
      [],
      [],
      0,
      10_000,
    );
    expect(model.byProvider[0].label).toBe("deepseek");
  });
});

describe("the session rows, as the command answers them", () => {
  test("an opener this build does not know is unknown, and a row with no session is dropped", () => {
    const rows = asSessionFacts([
      { session: "a", startedAt: 100, openedBy: "robot" },
      { session: "", startedAt: 100 },
      { session: "b" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].openedBy).toBe("unknown");
  });

  test("rows come back oldest first and a null end stays null", () => {
    const rows = asSessionFacts([
      { session: "b", startedAt: 300, endedAt: 400 },
      { session: "a", startedAt: 100, endedAt: null },
    ]);
    expect(rows.map((r) => r.session)).toEqual(["a", "b"]);
    expect(rows[0].endedAt).toBeNull();
  });
});

describe("saying it", () => {
  test("a percentile in the open band carries a plus and never a decimal millisecond", () => {
    expect(latencySaid({ ms: 5000, basis: "buckets", exact: false, atLeast: true, n: 10 })).toBe("5s+");
    expect(latencySaid({ ms: 812.4, basis: "buckets", exact: false, atLeast: false, n: 10 })).toBe("812ms");
    expect(latencySaid({ ms: 41, basis: "rows", exact: true, atLeast: false, n: 3 })).toBe("41ms");
  });

  test("bytes are in a unit a person thinks in, and a measured zero is 0 B", () => {
    expect(bytesSaid(0)).toBe("0 B");
    expect(bytesSaid(999)).toBe("999 B");
    expect(bytesSaid(2048)).toBe("2.0 KB");
    expect(bytesSaid(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("a small nonzero rate is never floored to nothing", () => {
    expect(rateSaid(0.004)).toBe("<1%");
    expect(rateSaid(0)).toBe("0%");
    expect(rateSaid(0.123)).toBe("12%");
    expect(rateSaid(null)).toBe("—");
  });

  test("a share is floored, so nothing reads 100% while something is left", () => {
    expect(shareSaid(0.999)).toBe("99%");
    expect(shareSaid(null)).toBe("—");
  });

  test("a dash means the measure does not exist; a measured zero is a zero", () => {
    const [healthy] = toolLines([hour({ errors: 0, calls: 1 })], "tools");
    expect(cellOf(healthy, "errors")).toBe("0", "no failure is a reading, not an absence");
    expect(cellOf(healthy, "bytes")).toBe("10 B");
    expect(cellOf(healthy, "cost")).toBe("$0.10");

    /* No completed call has no percentile, and a cost no turn claimed is a
       dash rather than a zero that would read as free. */
    const [unpriced] = toolLines(
      [hour({ calls: 0, turnUsd: 0, msUnder50: 0, msUnder200: 0, msUnder1s: 0, msUnder5s: 0, msOver5s: 0 })],
      "tools",
    );
    expect(cellOf(unpriced, "p95")).toBe("—");
    expect(cellOf(unpriced, "cost")).toBe("—");
  });

  test("a line's title carries its provenance", () => {
    const [line] = toolLines([hour({ kind: "mcp", server: "browser", tool: "click", calls: 2 })], "tools");
    const title = toolTitle(line);
    expect(title).toContain("2 calls");
    expect(title).toContain("mcp server browser");
    expect(title).toContain("cost apportioned from the turn");
  });

  test("the attribution gap is said, not drawn as a zero", () => {
    expect(ATTRIBUTION_GAP).toContain("not recorded");
  });

  test("the habits' sentence is a template over the numbers", () => {
    const from = new Date(2026, 10, 1).getTime();
    const to = new Date(2026, 10, 2).getTime();
    const model = habitModel(
      [
        session({ session: "a", openedBy: "person", startedAt: from + HOUR }),
        session({ session: "b", openedBy: "agent", startedAt: from + 2 * HOUR }),
      ],
      [],
      [],
      from,
      to,
    );
    const said = habitSaid(model);
    expect(said).toContain("2 cards were opened");
    expect(said).toContain("50% of them by an agent");
    expect(habitSaid(habitModel([], [], [], 0, 1))).toBe("no sessions in this window");

    /* Nothing opened is said before any rate is, or the sentence argues with
       the empty strip drawn below it. */
    const none = habitModel(
      [session({ startedAt: 1_000, endedAt: null })],
      [hour({ kind: "agent", tool: "Agent", target: "scout", calls: 2 })],
      [],
      5_000,
      10_000,
    );
    expect(habitSaid(none)).toBe("no card was opened in this window");
  });

  test("slices fold into an others row so the bars still add up", () => {
    const folded = foldSlices(
      [
        { label: "a", value: 4, share: 0.4 },
        { label: "b", value: 3, share: 0.3 },
        { label: "c", value: 2, share: 0.2 },
        { label: "d", value: 1, share: 0.1 },
      ],
      2,
    );
    expect(folded.map((s) => s.label)).toEqual(["a", "b", "others"]);
    expect(folded[2].value).toBe(3);
    expect(folded[2].share).toBeCloseTo(0.3);
    expect(foldSlices([{ label: "a", value: 1, share: 1 }], 2)).toHaveLength(1);
  });

  test("a year of days folds into buckets a card can draw", () => {
    const days = Array.from({ length: 366 }, (_, i) => {
      const at = new Date(2026, 0, 1 + i).getTime();
      return { day: dayKey(at), at, person: 1, agent: 0, unknown: 0, total: 1 };
    });
    const buckets = dayBuckets(days, 52);
    expect(buckets.length).toBeLessThanOrEqual(52);
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(366, "nothing is lost in the folding");
    expect(buckets.reduce((n, b) => n + b.days, 0)).toBe(366);
    expect(buckets.every((b) => b.days >= 1 && b.days <= Math.ceil(366 / 52))).toBe(true);
    /* Few days are themselves: a week draws seven bars, labelled by day. */
    expect(dayBuckets(days.slice(0, 7), 52).map((b) => b.days)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("the recorded agents", () => {
  const raw = [
    {
      agent: "a1",
      session: "s1",
      parentAgent: "",
      depth: 1,
      kind: "subagent",
      profile: "scout",
      requestedModel: "",
      startedAt: 1000,
      endedAt: 2000,
      turns: 4,
      costUsd: 0.5,
      account: "lyss",
      provider: "claude",
    },
    {
      agent: "a2",
      session: "s1",
      parentAgent: "",
      depth: 1,
      kind: "subagent",
      profile: "scout",
      requestedModel: "claude-sonnet-5-5",
      startedAt: 3000,
      endedAt: null,
      turns: 2,
      costUsd: 0.25,
      account: "lyss",
      provider: "claude",
    },
    {
      agent: "a3",
      session: "s2",
      parentAgent: "a1",
      depth: 2,
      kind: "task",
      profile: "",
      requestedModel: "",
      startedAt: 4000,
      endedAt: 5000,
      turns: 1,
      costUsd: 0,
      account: "unknown",
      provider: "unknown",
    },
  ];

  test("a row that will not parse is dropped rather than drawn", () => {
    const got = asAgents([...raw, { agent: "", startedAt: 1 }, { agent: "x", startedAt: null }]);
    expect(got).toHaveLength(3);
    /* An open agent keeps a null end rather than reading as finished at zero. */
    expect(got[1]!.endedAt).toBeNull();
  });

  test("profiles are summed, and an unfound spawn is `unknown` rather than guessed", () => {
    const lines = profileLines(asAgents(raw));
    expect(lines.map((l) => l.profile)).toEqual(["scout", "unknown"]);
    expect(lines[0]!.agents).toBe(2);
    expect(lines[0]!.turns).toBe(6);
    expect(lines[0]!.cost).toBeCloseTo(0.75, 10);
    /* The kinds travel with the line, so `task` and `subagent` do not blend
       into one word with no way to tell which it was. */
    expect(lines[1]!.kinds).toEqual(["task"]);
  });

  test("the cost is what was written down, never recomputed", () => {
    /* The row's number is summed; nothing here has a rate table to multiply a
       token by, which is the point of storing it at fold time. */
    expect(profileLines(asAgents(raw)).reduce((sum, l) => sum + l.cost, 0)).toBeCloseTo(0.75, 10);
  });
});
