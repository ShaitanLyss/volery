import { describe, expect, test } from "bun:test";

import {
  cardVerbOf,
  entriesOf,
  entryKey,
  familyOf,
  glyphOf,
  keysSaid,
  rank,
  remember,
  RECENT_KEEP,
  standingOf,
  type Entry,
} from "../src/lib/search";
import { ICONS } from "../src/lib/icons";
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
    for (const c of CHORDS) expect(entries).toContainEqual({ kind: "chord", keys: c.keys, label: c.label, note: keysSaid(c.keys), verb: c.verb });
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

describe("the action palette: the same list, opened by space", () => {
  /* A conversation that mentions the word, so the reading has to win on the
     lead rather than on being the only thing that answers. */
  const busy = [...rows, row("d", { title: "fix the pipeline build" }), row("e", { title: "status of the release" })];
  const all = entriesOf({ rows: busy, projects: ["portfolio"], chords: CHORDS, commands: [] });
  const act = (q: string, recent: string[] = []) => rank(all, busy, q, 60, { lead: "actions", recent });

  test("'pipe' then enter is the pipelines — Lyss's own example", () => {
    for (const q of ["pipe", "pip", "pipelines"]) expect(act(q)[0]).toMatchObject({ kind: "chord", keys: "bp", label: "pipelines" });
  });

  test("the conversation is still offered under the reading", () => {
    expect(act("pipe").some((e) => e.kind === "conversation" && e.id === "d")).toBe(true);
  });

  test("with nothing typed, what was taken lately leads, then the readings and panels", () => {
    const resting = act("", ["chord:cc", "sink"]);
    expect(resting.slice(0, 2).map(entryKey)).toEqual(["chord:cc", "sink"]);
    const next = resting.slice(2, 8).map(familyOf);
    expect(next.every((f) => f === "reading")).toBe(true);
  });

  test("recency breaks a tie and never invents an answer", () => {
    const a = act("asana");
    const top = a[0]!;
    const second = a[1]!;
    expect(act("asana", [entryKey(second)])[0]).toEqual(second);
    expect(top).not.toEqual(second);
    expect(act("zzqx", ["chord:bp"])).toEqual([]);
  });

  test("remember keeps the newest first, once each, bounded", () => {
    let r: string[] = [];
    for (let i = 0; i < 20; i++) r = remember(r, `k${i % 10}`);
    expect(r.length).toBe(RECENT_KEEP);
    expect(r[0]).toBe("k9");
    expect(new Set(r).size).toBe(r.length);
  });

  test("a label is scored as words, not as a path — a slash is not where a file name starts", () => {
    expect(act("pip")[0]).toMatchObject({ keys: "bp" });
  });

  test("a chord's keys still come first, in either lead", () => {
    expect(act("bp")[0]).toMatchObject({ keys: "bp" });
    expect(act("vv")[0]).toMatchObject({ keys: "vv" });
  });

  test("every row has a glyph the icon set can draw", () => {
    for (const e of all) expect(Object.keys(ICONS)).toContain(glyphOf(e));
  });

  test("every reading is a reading, every card verb a card row", () => {
    for (const e of all) {
      if (e.kind !== "chord") continue;
      if (e.verb?.kind === "reading") expect(familyOf(e)).toBe("reading");
      if (e.verb?.kind === "card") expect(familyOf(e)).toBe("card");
    }
  });

  test("a command a chord stands for is the chord's row — and still its own under a slash", () => {
    const got = entriesOf({ rows: [], projects: [], chords: CHORDS, commands: [{ name: "close", summary: "close it", chord: "cc" }, { name: "btw", summary: "aside" }] });
    const name = (es: Entry[]) => es.map((e) => (e.kind === "command" ? e.name : null)).filter(Boolean);
    for (const lead of ["search", "actions"] as const) {
      expect(name(rank(got, [], "", 1000, { lead }))).toEqual(["btw"]);
      expect(name(rank(got, [], "close", 1000, { lead }))).toEqual([]);
      expect(rank(got, [], "close", 1000, { lead })[0]).toMatchObject({ kind: "chord", keys: "cc" });
      /* Found in review: dropping it from the list dropped `/close` too. */
      expect(name(rank(got, [], "/close", 1000, { lead }))).toEqual(["close"]);
      expect(name(rank(got, [], "/btw", 1000, { lead }))).toEqual(["btw"]);
    }
  });
});

describe("a row that reaches the focused conversation", () => {
  const all = entriesOf({ rows: [], projects: [], chords: CHORDS, commands: [] });
  const chordRow = (keys: string) => all.find((e) => e.kind === "chord" && e.keys === keys)!;

  test("says which conversation, and refuses in the handle's own words", () => {
    const dormant = { title: "fix the contact form", can: (v: string) => (v === "processes" ? { no: "it is dormant, so it holds no processes" } : "yes" as const) };
    expect(standingOf(chordRow("cc"), dormant)).toEqual({ on: "fix the contact form", refused: null });
    expect(standingOf(chordRow("cp"), dormant)).toEqual({ on: "fix the contact form", refused: "it is dormant, so it holds no processes" });
  });

  test("with nothing in front of you, it is refused rather than guessed at", () => {
    expect(standingOf(chordRow("cc"), null)).toEqual({ on: null, refused: "no conversation is in front of you" });
  });

  test("a row about no conversation says nothing", () => {
    expect(standingOf(chordRow("bp"), null)).toBeNull();
    expect(standingOf(chordRow("vv"), null)).toBeNull();
  });

  test("the verbs are the handle's — keep for both keeps, nothing for the menu and the glance", () => {
    expect(cardVerbOf(chordRow("ck"))).toBe("keep");
    expect(cardVerbOf(chordRow("cl"))).toBe("keep");
    expect(cardVerbOf(chordRow("cm"))).toBeNull();
    expect(cardVerbOf(chordRow("cr"))).toBeNull();
    expect(cardVerbOf(chordRow("cx"))).toBe("clear");
  });
});
