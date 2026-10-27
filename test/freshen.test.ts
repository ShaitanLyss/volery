import { describe, expect, test } from "bun:test";
import {
  currentCli,
  normalSnapshot,
  runRow,
  sayCame,
  sayRun,
  sayStale,
  sayWhat,
  samePath,
  staleCards,
  staleOf,
  type CardFacts,
  type Install,
  type Item,
  type Run,
} from "../src/lib/freshen";

const TX_NEW = "C:\\Users\\flori\\.claude\\plugins\\cache\\tx-squad\\tx-toolkit\\8d5c04d1b46a";
const TX_OLD = "C:\\Users\\flori\\.claude\\plugins\\cache\\tx-squad\\tx-toolkit\\69c07eef4031";

const installs: Install[] = [
  { key: "tx-toolkit@tx-squad", scope: "user", project: null, path: TX_NEW, version: "8d5c04d1b46a" },
  {
    key: "tx-toolkit@tx-squad",
    scope: "project",
    project: "C:\\Users\\flori\\codes\\rise",
    path: TX_NEW,
    version: "8d5c04d1b46a",
  },
];

const item = (over: Partial<Item>): Item => ({
  kind: "plugin",
  name: "tx-toolkit@tx-squad",
  scope: "user",
  project: null,
  state: "current",
  from: null,
  to: null,
  said: null,
  ...over,
});

const run = (items: Item[], over: Partial<Run> = {}): Run => ({
  trigger: "button",
  startedAt: 1_000,
  finishedAt: 61_000,
  items,
  ...over,
});

const card = (over: Partial<CardFacts>): CardFacts => ({
  id: "a",
  name: "card a",
  dormant: false,
  awakeSince: 500,
  runningPlugins: [],
  ...over,
});

describe("which CLI this machine is on", () => {
  test("the last run's CLI step says it, whichever way it went", () => {
    expect(currentCli(run([item({ kind: "cli", name: "claude", state: "updated", from: "2.1.304", to: "2.1.311" })]))).toBe("2.1.311");
    expect(currentCli(run([item({ kind: "cli", name: "claude", state: "current", from: "2.1.311", to: "2.1.311" })]))).toBe("2.1.311");
  });
  test("a failed step falls back to what the launch found, without its product name", () => {
    const failed = run([item({ kind: "cli", name: "claude", state: "failed", said: "boom" })]);
    expect(currentCli(failed, "2.1.311 (Claude Code)")).toBe("2.1.311");
    expect(currentCli(null, null)).toBe(null);
  });
});

describe("which cards are on the old copy", () => {
  const snap = { installs, changedAt: 10_000 };

  test("a card whose init names an older CLI is stale", () => {
    expect(staleOf(card({ cliVersion: "2.1.304" }), snap, "2.1.311")).toEqual(["claude code 2.1.304"]);
    expect(staleOf(card({ cliVersion: "2.1.311" }), snap, "2.1.311")).toEqual([]);
  });

  test("a card reading a plugin from an old commit directory is stale, by name", () => {
    const old = card({
      cliVersion: "2.1.311",
      runningPlugins: [{ name: "tx-toolkit", path: TX_OLD, source: "tx-toolkit@tx-squad" }],
    });
    expect(staleOf(old, snap, "2.1.311")).toEqual(["tx-toolkit"]);
  });

  test("the current directory matches whatever its case and separators", () => {
    const now = card({
      cliVersion: "2.1.311",
      runningPlugins: [{ name: "tx-toolkit", path: TX_NEW.toLowerCase().replace(/\\/g, "/") + "/", source: "tx-toolkit@tx-squad" }],
    });
    expect(staleOf(now, snap, "2.1.311")).toEqual([]);
    expect(samePath("C:\\A\\b", "c:/a/B/")).toBe(true);
  });

  test("a plugin no marketplace installed can never be behind", () => {
    const inline = card({
      cliVersion: "2.1.311",
      runningPlugins: [
        { name: "mine", path: "C:\\dev\\mine", source: "mine@inline" },
        { name: "gone", path: "C:\\x", source: "gone@nowhere" },
      ],
    });
    expect(staleOf(inline, snap, "2.1.311")).toEqual([]);
  });

  test("a plugin with no source is matched on its name", () => {
    const bare = card({ cliVersion: "2.1.311", runningPlugins: [{ name: "tx-toolkit", path: TX_OLD }] });
    expect(staleOf(bare, snap, "2.1.311")).toEqual(["tx-toolkit"]);
  });

  test("a process that has not spoken is judged by its age against the last change", () => {
    expect(staleOf(card({ awakeSince: 5_000 }), snap, "2.1.311")).toEqual(["started before the last update"]);
    expect(staleOf(card({ awakeSince: 20_000 }), snap, "2.1.311")).toEqual([]);
    expect(staleOf(card({ awakeSince: 5_000 }), { installs, changedAt: null }, "2.1.311")).toEqual([]);
  });

  test("a dormant card is never stale — its next process starts on what is there", () => {
    expect(staleOf(card({ dormant: true, awakeSince: null, cliVersion: "2.1.1" }), snap, "2.1.311")).toEqual([]);
  });

  test("the wall's list keeps only the stale ones", () => {
    const list = staleCards(
      [card({ id: "a", cliVersion: "2.1.304" }), card({ id: "b", cliVersion: "2.1.311" })],
      snap,
      "2.1.311",
    );
    expect(list.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("what a run is called", () => {
  test("each kind of row says what it is about", () => {
    expect(sayWhat(item({ kind: "cli", name: "claude" }))).toBe("claude code");
    expect(sayWhat(item({ kind: "marketplace", name: "tx-squad" }))).toBe("tx-squad marketplace");
    expect(sayWhat(item({}))).toBe("tx-toolkit (user)");
    expect(sayWhat(item({ scope: "project", project: "C:\\Users\\flori\\codes\\rise" }))).toBe("tx-toolkit (project, rise)");
  });

  test("and what came of it", () => {
    expect(sayCame(item({ state: "updated", from: "69c07eef4031", to: "8d5c04d1b46a" }))).toBe("69c07eef4031 → 8d5c04d1b46a");
    expect(sayCame(item({ kind: "marketplace", state: "updated" }))).toBe("refreshed");
    expect(sayCame(item({ state: "current", to: "8d5c04d1b46a" }))).toBe("current · 8d5c04d1b46a");
    expect(sayCame(item({ state: "current", from: "bc2b8549769b", to: "8d5c04d1b46a" }))).toBe(
      "current · 8d5c04d1b46a (record: bc2b8549769b)",
    );
    expect(sayCame(item({ state: "failed", said: "fatal: Authentication failed" }))).toBe("failed — fatal: Authentication failed");
    expect(sayCame(item({ state: "skipped", said: "its project folder is gone" }))).toBe("skipped — its project folder is gone");
  });

  test("the summary line counts what moved and what failed, and nothing else", () => {
    const r = run([
      item({ kind: "cli", name: "claude", state: "updated", from: "2.1.304", to: "2.1.311" }),
      item({ kind: "marketplace", name: "tx-squad", state: "updated" }),
      item({ state: "updated", from: "a", to: "b" }),
      item({ scope: "project", project: "C:\\x\\rise", state: "updated", from: "a", to: "b" }),
      item({ name: "lua-lsp@claude-plugins-official", state: "failed", said: "nope" }),
    ]);
    expect(sayRun(r, 61_000)).toBe(
      "checked just now (by hand) — updated claude code 2.1.304 → 2.1.311 and tx-toolkit, 1 failed",
    );
    expect(sayRun(run([item({})], { trigger: "auto" }), 61_000 + 2 * 3_600_000)).toBe(
      "checked 2h ago — everything current",
    );
    expect(sayRun(run([item({ state: "running" }), item({})], { finishedAt: null }), 0)).toBe("updating — 1 of 2");
    expect(sayRun(null, 0)).toBe("not checked yet");
  });
});

describe("the chronicle row", () => {
  test("a run that moved nothing and failed nothing writes nothing", () => {
    expect(runRow(run([item({}), item({ kind: "marketplace", name: "m", state: "updated" })]), [])).toBe(null);
  });
  test("a run that moved something names it and the cards left behind", () => {
    const row = runRow(run([item({ state: "updated", from: "a", to: "b" })]), [
      { id: "1", name: "nova", why: ["tx-toolkit"], busy: false },
    ]);
    expect(row?.level).toBe("good");
    expect(row?.mark).toBe("updated tx-toolkit");
    expect(row?.detail).toContain("1 card still on the old copy (nova)");
    expect(row?.detail).toContain("space then a");
  });
  test("a failure is bad and carries its first line", () => {
    const row = runRow(run([item({ kind: "marketplace", name: "tx-squad", state: "failed", said: "fatal: Authentication failed" })]), []);
    expect(row?.level).toBe("bad");
    expect(row?.detail).toBe("tx-squad marketplace failed: fatal: Authentication failed");
  });
  test("a run still going writes nothing yet", () => {
    expect(runRow(run([item({ state: "updated" })], { finishedAt: null }), [])).toBe(null);
  });
});

describe("the stale line and the wire", () => {
  test("it says how many are held back and why", () => {
    const s = [
      { id: "1", name: "a", why: ["x"], busy: false },
      { id: "2", name: "b", why: ["x"], busy: true },
    ];
    expect(sayStale(s, 2)).toBe("2 cards still on the old copy");
    expect(sayStale(s, 1)).toBe("2 cards still on the old copy — 1 busy, left alone until it rests");
    expect(sayStale([], 0)).toBe("");
  });
  test("a snapshot off the wire is drawable whatever arrived", () => {
    const n = normalSnapshot({ settings: { everyHours: "x" } });
    expect(n.settings).toEqual({ auto: true, everyHours: 6 });
    expect(n.last).toBe(null);
    expect(n.installs).toEqual([]);
    expect(normalSnapshot(null).running).toBe(false);
  });
});
