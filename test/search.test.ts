import { describe, expect, test } from "bun:test";

import { entriesOf, keysSaid, rank, type Entry } from "../src/lib/search";
import { CHORDS } from "../src/lib/leader";
import type { ChatRow } from "../src/lib/chatview";

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
    owed: false,
    endedOnQuestion: false,
    aside: false,
    lastAt: 0,
    turnAt: null,
    lastWords: "",
    parent: null,
    ...over,
  };
}

const rows = [
  row("a", { title: "fix the contact form" }),
  row("b", { title: "dark mode for the site", lastWords: "the toggle follows the system theme" }),
  row("c", { title: "flights to lisbon", project: null }),
];
const entries = entriesOf({
  rows,
  projects: ["portfolio", "paperwork"],
  chords: CHORDS,
  commands: [
    { name: "rename", summary: "give it a name" },
    { name: "clear", summary: "start fresh" },
  ],
});
const labels = (es: Entry[]) => es.map((e) => e.label);

describe("ctrl+K's list", () => {
  test("empty lists conversations first, then projects, settings, the sink, chords, commands", () => {
    const kinds = rank(entries, rows, "", 1000).map((e) => e.kind);
    expect([...new Set(kinds)]).toEqual(["conversation", "project", "setting", "sink", "chord", "command"]);
  });

  test("every chord is offered with its keys", () => {
    for (const c of CHORDS) expect(entries).toContainEqual({ kind: "chord", keys: c.keys, label: c.label, note: keysSaid(c.keys) });
    expect(keysSaid("vv")).toBe("space v v");
  });

  test("a conversation is found by a word of its title, first", () => {
    expect(rank(entries, rows, "contact")[0]).toMatchObject({ kind: "conversation", id: "a" });
  });

  test("and by its last words, as the sidebar's search finds it", () => {
    expect(labels(rank(entries, rows, "toggle"))).toContain("dark mode for the site");
  });

  test("a conversation that does not match is not offered on fuzz alone", () => {
    expect(rank(entries, rows, "fcf").some((e) => e.kind === "conversation")).toBe(false);
  });

  test("a chord typed as its keys comes first, however it is spelled", () => {
    expect(CHORDS.some((c) => c.keys === "vv")).toBe(true);
    for (const q of ["vv", "space v v", "sp vv"]) expect(rank(entries, rows, q)[0]).toMatchObject({ kind: "chord", keys: "vv" });
  });

  test("a chord is found by its label", () => {
    expect(rank(entries, rows, "find file")[0]).toMatchObject({ kind: "chord", keys: "ff" });
  });

  test("a slash asks for commands only", () => {
    const got = rank(entries, rows, "/re");
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((e) => e.kind === "command")).toBe(true);
    expect(got[0]!.label).toBe("/rename");
  });

  test("the sink and the settings are there to be found", () => {
    expect(rank(entries, rows, "sink")[0]).toMatchObject({ kind: "sink" });
    expect(rank(entries, rows, "accounts")[0]).toMatchObject({ kind: "setting", id: "accounts" });
  });

  test("a project is found by its name", () => {
    expect(rank(entries, rows, "paperw")[0]).toMatchObject({ kind: "project", name: "paperwork" });
  });
});
