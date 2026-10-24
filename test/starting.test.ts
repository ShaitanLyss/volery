import { describe, expect, test } from "bun:test";

import {
  baseName,
  chipSaid,
  ideasFor,
  modelSaid,
  placesOf,
  presetOf,
  presetRows,
  readiness,
  samePlace,
  startingPlace,
  storedOf,
  switchLines,
  type Place,
} from "../src/lib/starting";
import { PRESETS, presetById } from "../src/lib/presets";

const projects = [
  { name: "portfolio", dir: "C:/sites/portfolio" },
  { name: "paperwork", dir: "C:/docs/paperwork" },
  { name: "recipes", dir: "C:/docs/recipes" },
];
const seen = [
  { project: "paperwork", lastAt: 300 },
  { project: "portfolio", lastAt: 100 },
  { project: "portfolio", lastAt: 200 },
  { project: null, lastAt: 900 },
  /* A card on another wall: its project of the same name is not this folder. */
  { project: "recipes", lastAt: 10_000, host: "laptop" },
];

describe("where a new conversation starts", () => {
  test("the last place started from wins, if it still exists", () => {
    expect(startingPlace({ project: "recipes" }, projects, seen)).toEqual({ kind: "project", name: "recipes", dir: "C:/docs/recipes" });
    expect(startingPlace("chat", projects, seen)).toEqual({ kind: "chat" });
  });

  test("a remembered project that is gone falls back to the most recently used", () => {
    expect(startingPlace({ project: "deleted" }, projects, seen)).toMatchObject({ kind: "project", name: "paperwork" });
  });

  test("nothing remembered: the project used most recently here, never another wall's", () => {
    expect(startingPlace(null, projects, seen)).toMatchObject({ name: "paperwork" });
  });

  test("no projects at all is just chat — a newcomer's first launch (§5.9)", () => {
    expect(startingPlace(null, [], [])).toEqual({ kind: "chat" });
  });

  test("a picked folder is not remembered until it is a project", () => {
    expect(storedOf({ kind: "folder", dir: "C:/x" })).toBeNull();
    expect(storedOf({ kind: "chat" })).toBe("chat");
    expect(storedOf({ kind: "project", name: "a", dir: "C:/a" })).toEqual({ project: "a" });
  });
});

describe("the place menu", () => {
  const current: Place = { kind: "project", name: "portfolio", dir: "C:/sites/portfolio" };

  test("projects most recently used first, then just chat last", () => {
    const rows = placesOf(projects, seen, current);
    expect(rows.map((r) => r.label)).toEqual(["paperwork", "portfolio", "recipes", "just chat"]);
  });

  test("counts are this wall's conversations, and the place in use shows its path", () => {
    const rows = placesOf(projects, seen, current);
    expect(rows.find((r) => r.label === "portfolio")).toMatchObject({ count: 2, note: "C:/sites/portfolio" });
    expect(rows.find((r) => r.label === "recipes")).toMatchObject({ count: 0, note: "" });
    expect(rows.at(-1)?.count).toBe(1);
    expect(rows.at(-1)?.note).toContain("search the web");
  });

  test("a picked folder heads the list with its path", () => {
    const rows = placesOf(projects, seen, { kind: "folder", dir: "C:/new/site/" });
    expect(rows[0]).toMatchObject({ label: "site", note: "C:/new/site/" });
  });

  test("places compare by what they are", () => {
    expect(samePlace({ kind: "chat" }, { kind: "chat" })).toBe(true);
    expect(samePlace(current, { ...current, dir: "elsewhere" })).toBe(true);
    expect(samePlace(current, { kind: "chat" })).toBe(false);
    expect(baseName("C:/a/b/")).toBe("b");
  });

  test("three suggestions per kind of place, different for chat", () => {
    expect(ideasFor({ kind: "chat" })).toHaveLength(3);
    expect(ideasFor(current)).toHaveLength(3);
    expect(ideasFor({ kind: "chat" })).not.toEqual(ideasFor(current));
  });
});

describe("the model chip", () => {
  test("a model is said as a person says it", () => {
    expect(modelSaid("claude-opus-5[1m]")).toBe("opus 5");
    expect(modelSaid("opus[1m]")).toBe("opus");
    expect(modelSaid("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
    expect(modelSaid("claude-sonnet-5-5")).toBe("sonnet 5.5");
    expect(modelSaid(undefined)).toBe("");
  });

  test("the chip is the model and its effort, and haiku claims none", () => {
    expect(chipSaid("sonnet[1m]", "medium")).toBe("sonnet · medium");
    expect(chipSaid("haiku", undefined)).toBe("haiku");
    expect(chipSaid(null, null)).toBe("claude code's own");
  });

  test("the menu is the wall's five presets cheapest first, then claude code's own", () => {
    expect(presetRows().map((r) => r.id)).toEqual([...PRESETS.map((p) => p.id), ""]);
  });

  test("a choice resolves in Skein.open's three states", () => {
    const wall = presetById("deep");
    expect(presetOf(null, wall)).toBe(wall);
    expect(presetOf("", wall)).toBeUndefined();
    expect(presetOf("ask", wall)).toBe(presetById("ask"));
    expect(presetOf("retired", wall)).toBe(wall);
  });

  test("switching an open conversation sends /model, and /effort after it only where the family's own differs", () => {
    expect(switchLines(presetById("deep")!)).toEqual(["/model opus[1m]", "/effort xhigh"]);
    /* sonnet's automatic level is medium already: a second /effort medium drew
       the line and its answer twice (lab, 2026-10-18). */
    expect(switchLines(presetById("work")!)).toEqual(["/model sonnet[1m]"]);
    expect(switchLines(presetById("read")!)).toEqual(["/model sonnet[1m]", "/effort low"]);
    expect(switchLines(presetById("ask")!)).toEqual(["/model haiku"]);
  });
});

describe("whether a conversation can start", () => {
  const ready = { state: "ready" as const };
  test("looking until the CLI has been looked for", () => {
    expect(readiness(null, null, 0)).toBe("looking");
  });
  test("missing is missing whatever else is true", () => {
    expect(readiness({ state: "missing" }, { loggedIn: true }, 3)).toBe("missing");
  });
  test("a usable account is ready with the default credential signed out (probe-auth found exactly this)", () => {
    expect(readiness(ready, { loggedIn: false }, 1)).toBe("ready");
  });
  test("no account and a signed-out default is signed out", () => {
    expect(readiness(ready, { loggedIn: false }, 0)).toBe("signed-out");
    expect(readiness(ready, { loggedIn: true }, 0)).toBe("ready");
  });
  test("a CLI that could not say reads as ready, not as signed out", () => {
    expect(readiness(ready, "unknown", 0)).toBe("ready");
    expect(readiness(ready, null, 0)).toBe("looking");
  });
});

/* ── which machine it works on ── */

import { ableWalls, choosesMachine, holds, machineNow, machineOptions, placeAtHome, placeOnWall, placesOn } from "../src/lib/starting";

const me = { host: "desk", me: true };
const wall = (host: string, over: Record<string, unknown> = {}) => ({
  host,
  standing: "open",
  opens: true,
  territories: ["portfolio", "ledger"],
  ...over,
});

describe("choosing the machine", () => {
  test("one machine, or others that cannot take work, offers nothing to choose", () => {
    expect(choosesMachine([me])).toBe(false);
    expect(choosesMachine([me, wall("lab", { standing: "quiet" })])).toBe(false);
    expect(choosesMachine([me, wall("lab", { standing: "closed" })])).toBe(false);
    expect(choosesMachine([me, wall("lab", { older: true })])).toBe(false);
    expect(choosesMachine([me, wall("lab", { opens: false })])).toBe(false);
    expect(choosesMachine([me, wall("lab", { territories: [] })])).toBe(false);
  });
  test("a wall heard from, new enough and taking work is offered", () => {
    expect(choosesMachine([me, wall("lab")])).toBe(true);
    expect(ableWalls([me, wall("lab"), wall("away", { standing: "quiet" })]).map((r) => r.host)).toEqual(["lab"]);
  });
  test("a chosen machine that stops taking work is this machine again", () => {
    expect(machineNow("lab", [me, wall("lab")])).toBe("lab");
    expect(machineNow("lab", [me, wall("lab", { standing: "quiet" })])).toBeNull();
    expect(machineNow("lab", [me])).toBeNull();
    expect(machineNow(null, [me, wall("lab")])).toBeNull();
  });
  test("projects match case folded", () => {
    expect(holds({ territories: ["RISE"] }, "rise")).toBe(true);
    expect(holds({ territories: ["RISE"] }, "")).toBe(false);
  });
  test("the menu draws this machine, then walls that can, then those that cannot with why", () => {
    const rows = machineOptions(
      [me, wall("zed"), wall("asleep", { standing: "quiet" }), wall("lab", { territories: ["ledger"] })],
      { kind: "project", name: "portfolio", dir: "C:/p" },
    );
    expect(rows.map((r) => r.host)).toEqual([null, "lab", "zed", "asleep"]);
    expect(rows[1]!.note).toBe("opens in ledger");
    expect(rows[2]!.note).toBe("holds portfolio");
    expect(rows[3]!.ok).toBe(false);
    expect(rows[3]!.note).toContain("not been heard from lately");
  });
  test("another machine's places are its projects, never chat or a folder", () => {
    const rows = placesOn({ territories: ["ledger", "portfolio"] }, [{ project: "portfolio", lastAt: 5 }], { kind: "chat" });
    expect(rows.map((r) => r.label)).toEqual(["portfolio", "ledger"]);
    expect(rows.every((r) => r.place.kind === "project")).toBe(true);
  });
  test("the place goes with the machine: kept where held, else the first held", () => {
    const here: Place = { kind: "project", name: "paperwork", dir: "C:/docs/paperwork" };
    expect(placeOnWall({ territories: ["paperwork", "x"] }, here, projects, seen)).toEqual({ kind: "project", name: "paperwork", dir: "" });
    expect(placeOnWall({ territories: ["recipes", "portfolio"] }, here, projects, seen)).toEqual({ kind: "project", name: "portfolio", dir: "" });
    expect(placeOnWall({ territories: ["only-there"] }, { kind: "chat" }, projects, seen)).toEqual({ kind: "project", name: "only-there", dir: "" });
  });
  test("coming home restores the folder here, or what the place would have been", () => {
    expect(placeAtHome({ kind: "project", name: "recipes", dir: "" }, null, projects, seen)).toEqual({ kind: "project", name: "recipes", dir: "C:/docs/recipes" });
    expect(placeAtHome({ kind: "project", name: "only-there", dir: "" }, "chat", projects, seen)).toEqual({ kind: "chat" });
  });
});
