import { describe, expect, test } from "bun:test";
import {
  KINDS,
  MAX_BODY,
  MAX_PATHS,
  MAX_TITLE,
  about,
  editable,
  finder,
  held,
  holder,
  moved,
  normalize,
  normalizeAll,
  nothing,
  opening,
  pending,
  pile,
  proposed,
  reading,
  refusal,
  search,
  stateOf,
  waiting,
  whence,
  type Item,
} from "../src/lib/sink";

const row = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  projectId: "skein",
  kind: "bug",
  title: "ask_user times out in a non-interactive session",
  body: "the call parks for ten minutes and then answers TIMED_OUT",
  paths: ["src-tauri/src/ask.rs"],
  from: "aaaaaaaa-1111-4111-8111-111111111111",
  droppedAt: 1000,
  touchedAt: 1000,
  voices: 1,
  heldBy: null,
  heldAt: null,
  holdStale: false,
  settledAt: null,
  settledNote: null,
  editedAt: null,
  ...over,
});

const item = (over: Record<string, unknown> = {}) => normalize(row(over)) as Item;

describe("normalize", () => {
  test("takes a row as Rust writes it", () => {
    const i = item();
    expect(i.kind).toBe("bug");
    expect(i.title).toBe("ask_user times out in a non-interactive session");
    expect(i.paths).toEqual(["src-tauri/src/ask.rs"]);
    expect(i.voices).toBe(1);
  });

  /* The bargain every normalizer on this wall strikes. Refusing to draw a row
     here loses a finding, which is the one failure a table built to not lose
     findings cannot have. */
  test("degrades a row from a newer build rather than refusing it", () => {
    const i = item({ kind: "question", voices: null, paths: [1, "a.ts"], heldAt: "soon" });
    expect(i.kind).toBe("note");
    expect(i.voices).toBe(1);
    expect(i.paths).toEqual(["a.ts"]);
    expect(i.heldAt).toBeNull();
  });

  test("refuses only what cannot be drawn or acted on", () => {
    expect(normalize(row({ id: "" }))).toBeNull();
    expect(normalize(row({ title: "" }))).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalizeAll([row(), null, row({ id: "" }), "nonsense"])).toHaveLength(1);
  });

  test("the kinds are the four Rust writes", () => {
    expect([...KINDS].sort()).toEqual(["bug", "chore", "idea", "note"]);
  });

  test("an item nobody has reworded says so with a null, not a zero", () => {
    expect(item().editedAt).toBeNull();
    expect(item({ editedAt: 5000 }).editedAt).toBe(5000);
    expect(item({ editedAt: "yesterday" }).editedAt).toBeNull();
  });
});

describe("state", () => {
  test("nobody on it is waiting", () => {
    expect(stateOf(item())).toBe("waiting");
    expect(held(item())).toBe(false);
  });

  test("a live hold is held", () => {
    const i = item({ heldBy: "c2", heldAt: 2000 });
    expect(stateOf(i)).toBe("held");
    expect(held(i)).toBe(true);
  });

  /* The half that parts company with the billboard: a stale notice is only
     marked, where a hold nobody has honoured actually gives way. The flag comes
     from Rust so this reading and the agent's cannot disagree. */
  test("a hold nobody has honoured reads as lapsed, not held", () => {
    const i = item({ heldBy: "c2", heldAt: 2000, holdStale: true });
    expect(stateOf(i)).toBe("lapsed");
    expect(held(i)).toBe(false);
  });

  test("a settled item is settled whatever else is on it", () => {
    expect(stateOf(item({ settledAt: 9000, heldBy: "c2", heldAt: 2000 }))).toBe("settled");
  });
});

describe("reading", () => {
  /* The one ordering decision on this wall that runs against the grain of every
     other face, so it is asserted rather than left to the widget. A pile is read
     to find what has been ignored longest. */
  test("oldest first, which is the opposite of a transcript", () => {
    const order = reading([
      item({ id: "new", droppedAt: 9000 }),
      item({ id: "old", droppedAt: 1000 }),
      item({ id: "mid", droppedAt: 5000 }),
    ]).map((i) => i.id);
    expect(order).toEqual(["old", "mid", "new"]);
  });

  test("waiting before lapsed before held", () => {
    const order = reading([
      item({ id: "held", droppedAt: 1, heldBy: "c2", heldAt: 2000 }),
      item({ id: "lapsed", droppedAt: 2, heldBy: "c3", heldAt: 10, holdStale: true }),
      item({ id: "waiting", droppedAt: 3 }),
    ]).map((i) => i.id);
    expect(order).toEqual(["waiting", "lapsed", "held"]);
  });

  test("the incoming array is left alone", () => {
    const items = [item({ id: "b", droppedAt: 9000 }), item({ id: "a", droppedAt: 1000 })];
    reading(items);
    expect(items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  test("a kind narrows the pile and keeps the order", () => {
    const items = [
      item({ id: "n", kind: "note", droppedAt: 3000 }),
      item({ id: "b2", kind: "bug", droppedAt: 2000 }),
      item({ id: "b1", kind: "bug", droppedAt: 1000 }),
    ];
    expect(pile(items, "bug").map((i) => i.id)).toEqual(["b1", "b2"]);
    expect(pile(items).map((i) => i.id)).toEqual(["b1", "b2", "n"]);
  });
});

describe("the badge", () => {
  /* What is asking for your attention, not what is in the table — an item
     somebody is already dealing with is not a thing you have to do anything
     about, and counting it would make the number stop meaning anything. */
  test("counts what is waiting, not what is held or settled", () => {
    expect(
      pending([
        item({ id: "a" }),
        item({ id: "b", heldBy: "c2", heldAt: 2000 }),
        item({ id: "c", heldBy: "c3", heldAt: 10, holdStale: true }),
        item({ id: "d", settledAt: 5000 }),
      ]),
    ).toBe(2);
  });
});

describe("rewording one", () => {
  /* The affordance, and the whole of its policy. Drawn on a pending, unheld item
     and *not drawn at all* otherwise — the same two bounds `sink.rs::may_edit`
     enforces, off the same two fields, so the face cannot offer a verb the write
     would refuse. */
  test("pending and nobody on it", () => {
    expect(editable(item())).toBe(true);
    expect(editable(item({ heldBy: "c2", heldAt: 2000 }))).toBe(false);
    expect(editable(item({ settledAt: 9000 }))).toBe(false);
  });

  /* A lapsed hold is not a hold, here as everywhere else in this file — an item
     somebody took and let go stale is free to take and therefore free to fix. */
  test("a lapsed hold does not lock the words", () => {
    expect(editable(item({ heldBy: "c2", heldAt: 10, holdStale: true }))).toBe(true);
  });

  test("the fields open on what is already there", () => {
    const d = opening(item({ paths: ["a.ts", "b.ts"] }));
    expect(d.title).toBe("ask_user times out in a non-interactive session");
    expect(d.kind).toBe("bug");
    /* One line, because that is what you type into. */
    expect(d.paths).toBe("a.ts, b.ts");
  });

  /* The paths field has one grammar and it is `sink.rs::globs_from`'s — an
     agent's `drop` splits on newlines and commas, so this must too, or the same
     text would mean two things depending on who typed it. */
  test("the paths line is split the way an agent's drop is", () => {
    expect(proposed({ title: "t", body: "b", kind: "note", paths: "a.ts, b.ts" }).paths).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(proposed({ title: "t", body: "b", kind: "note", paths: "a.ts\n b.ts ," }).paths).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(proposed({ title: "t", body: "b", kind: "note", paths: "  " }).paths).toEqual([]);
  });

  test("what you typed is trimmed and clipped where the write clips", () => {
    const e = proposed({
      title: `  ${"t".repeat(MAX_TITLE + 40)}  `,
      body: `  ${"b".repeat(MAX_BODY + 40)}  `,
      kind: "chore",
      paths: Array.from({ length: MAX_PATHS + 4 }, (_, n) => `f${n}.ts`).join(","),
    });
    expect(e.title).toHaveLength(MAX_TITLE);
    expect(e.body).toHaveLength(MAX_BODY);
    expect(e.paths).toHaveLength(MAX_PATHS);
    expect(e.kind).toBe("chore");
  });

  /* The stamp on an item is what tells an agent the words it is reading are no
     longer the finder's. A stamp that also fired on "you opened it and closed it
     again" would mean nothing, so a save that moved nothing is not a write. */
  test("opening an item and closing it again is not an edit", () => {
    const i = item({ paths: ["a.ts"] });
    expect(moved(i, proposed(opening(i)))).toBe(false);
  });

  test("each of the four fields counts as a change on its own", () => {
    const i = item({ paths: ["a.ts"] });
    const at = opening(i);
    expect(moved(i, proposed({ ...at, title: "said properly" }))).toBe(true);
    expect(moved(i, proposed({ ...at, body: "the whole of it" }))).toBe(true);
    expect(moved(i, proposed({ ...at, kind: "chore" }))).toBe(true);
    expect(moved(i, proposed({ ...at, paths: "a.ts, b.ts" }))).toBe(true);
    /* And re-spelling the same paths is not a change to them. */
    expect(moved(i, proposed({ ...at, paths: " a.ts " }))).toBe(false);
  });

  /* The one refusal the face can make instantly. The others — held, settled,
     and a title another item already holds — need the table and come back from
     Rust as a sentence. */
  test("a title is the whole of what an item cannot be without", () => {
    expect(refusal(proposed({ title: " ", body: "b", kind: "note", paths: "" }))).toBe(
      "an item needs a title",
    );
    expect(refusal(proposed({ title: "t", body: "b", kind: "note", paths: "" }))).toBeNull();
  });

  /* **A body is not required**, and this is the assertion that keeps it that
     way. `Drop.svelte` lets you leave a title-only item by hand, so a surface
     that refused to let you reword one would be refusing to save a thing it had
     let you make. `sink_edit` agrees — a front end that offered a save Rust then
     refused would be worse than the asymmetry it replaced.

     The agent-facing `do_drop` still asks for one, and that asymmetry is the
     point rather than a leftover: an agent has the context at the moment it
     drops and will not be there in November. */
  test("an edit may leave the body empty, as a hand-dropped item does", () => {
    expect(refusal(proposed({ title: "t", body: " ", kind: "note", paths: "" }))).toBeNull();
    expect(refusal(proposed({ title: "t", body: "", kind: "note", paths: "" }))).toBeNull();
  });
});

describe("the words on a row", () => {
  test("how long it has been sitting there", () => {
    expect(waiting(item({ droppedAt: 0 }), 30_000)).toBe("just now");
    expect(waiting(item({ droppedAt: 0 }), 5 * 60_000)).toBe("5m");
    expect(waiting(item({ droppedAt: 0 }), 3 * 3_600_000)).toBe("3h");
    expect(waiting(item({ droppedAt: 0 }), 4 * 86_400_000)).toBe("4d");
    /* A clock that has gone backwards is a reading, not a crash. */
    expect(waiting(item({ droppedAt: 9000 }), 0)).toBe("just now");
  });

  test("the files are clipped rather than wrapped", () => {
    expect(about(item({ paths: [] }))).toBe("");
    expect(about(item({ paths: ["a.ts", "b.ts"] }))).toBe("a.ts, b.ts");
    expect(about(item({ paths: ["a", "b", "c", "d", "e"] }))).toBe("a, b, c +2");
  });

  /* Unlike the billboard's author, a miss here is ordinary rather than a race:
     an item outlives the card that found it on purpose, so most of a long-lived
     sink was dropped by conversations that have since closed. Eight characters
     of a dead uuid would read as something you could go and look up. */
  test("a finder nobody can name is an agent, not a fragment of a uuid", () => {
    const names = new Map([["aaaaaaaa-1111-4111-8111-111111111111", "lucid otter"]]);
    expect(finder(item(), names)).toBe("lucid otter");
    expect(finder(item(), new Map())).toBe("an agent");
    expect(finder(item({ from: null }), new Map())).toBe("you");
  });

  test("a holder nobody can name is a closed card", () => {
    const names = new Map([["c2", "quiet heron"]]);
    expect(holder(item({ heldBy: "c2", heldAt: 1 }), names)).toBe("quiet heron");
    expect(holder(item({ heldBy: "c9", heldAt: 1 }), names)).toBe("a closed card");
    expect(holder(item(), names)).toBe("");
  });

  /* Three different absences. A face that said "empty" when you had filtered to
     bugs would be reporting the filter as news about the table. */
  test("an empty face says which emptiness it is", () => {
    expect(nothing("all", false)).toBe("the sink is empty");
    expect(nothing("bug", false)).toBe("no bugs waiting");
    expect(nothing("all", true)).toBe("nothing settled yet");
    expect(nothing("bug", true)).toBe("nothing settled yet");
  });
});

describe("finding one in the pile", () => {
  const it_ = (over: Partial<Item>): Item => ({
    id: "abcd1234-0000",
    projectId: null,
    kind: "bug",
    title: "ask_user times out",
    body: "the call parks for ten minutes",
    paths: [],
    from: null,
    droppedAt: 0,
    touchedAt: 0,
    voices: 1,
    heldBy: null,
    heldAt: null,
    holdStale: false,
    settledAt: null,
    settledNote: null,
    editedAt: null,
    ...over,
  });

  test("an empty query is everything, so the box opens onto the pile", () => {
    const all = [it_({}), it_({ id: "b", title: "something else" })];
    expect(search(all, "").length).toBe(2);
    expect(search(all, "   ").length).toBe(2);
  });

  test("every term must appear, in any field and any order", () => {
    const all = [
      it_({ id: "a", title: "ask_user times out", body: "parks for ten minutes" }),
      it_({ id: "b", title: "the dock eats a key", body: "nothing to do with questions" }),
    ];
    /* One word from the title and one from the body — which is the whole point:
       you do not have to know which field you remember it from. */
    expect(search(all, "ask parks").map((i) => i.id)).toEqual(["a"]);
    expect(search(all, "parks ask").map((i) => i.id)).toEqual(["a"]);
    /* Substring, not word — `adopt.ts::narrow` is the same, and "ask" finding
       "asking" is the behaviour anybody typing half a word expects. So the
       negative case has to be a term genuinely absent from the other row. */
    expect(search(all, "ask dock").length).toBe(0);
  });

  test("it is found by kind, by path and by id as well", () => {
    const all = [it_({ id: "abcd1234-0000", kind: "chore", paths: ["src/lib/sink.ts"] })];
    expect(search(all, "chore").length).toBe(1);
    expect(search(all, "sink.ts").length).toBe(1);
    expect(search(all, "abcd1234").length).toBe(1);
  });

  test("case never matters", () => {
    const all = [it_({ title: "Ask_User Times Out" })];
    expect(search(all, "ASK_USER").length).toBe(1);
  });

  /* The spelling `mcp__skein__sink` documents to every agent on the wall. The
     surface a person searches from has to mean the same thing by it. */
  test("a quoted phrase is kept together", () => {
    const all = [
      it_({ id: "a", title: "ask_user times out in a non-interactive session" }),
      it_({ id: "b", title: "out of times, ask_user" }),
    ];
    expect(search(all, '"times out"').map((i) => i.id)).toEqual(["a"]);
    /* Unquoted, both words appear in both. */
    expect(search(all, "times out").length).toBe(2);
  });

  /* A term matching across the join of two fields would find rows nobody meant
     — `adopt.ts::haystack` learned this and the rule is the same here. */
  test("a term cannot match across two fields", () => {
    const all = [it_({ title: "the dock", body: "eats a key" })];
    expect(search(all, "dockeats").length).toBe(0);
    expect(search(all, "dock eats").length).toBe(1);
  });
});

describe("which machine a finding came from", () => {
  const from = (originHost: string | null): Item => ({
    id: "a",
    projectId: null,
    kind: "bug",
    title: "t",
    body: "b",
    paths: [],
    from: null,
    droppedAt: 0,
    touchedAt: 0,
    voices: 1,
    heldBy: null,
    heldAt: null,
    holdStale: false,
    settledAt: null,
    settledNote: null,
    editedAt: null,
    originHost,
  });

  /* On a wall in no flyway every row would otherwise carry the same word — a
     word per row for a fact nobody is asking about. The agent-facing listing
     has taken exactly this line since v44. */
  test("says nothing when the finding was seen here", () => {
    expect(whence(from("desk"), "desk")).toBe("");
    expect(whence(from("DESK"), "desk")).toBe("");
    expect(whence(from("desk"), " DESK ")).toBe("");
  });

  test("names the machine when it was somewhere else", () => {
    expect(whence(from("laptop"), "desk")).toBe("laptop");
  });

  /* A row written before the flyway existed, and one from a build that does not
     send the field. Neither is "from somewhere else" — it is not known. */
  test("says nothing when there is nothing to say", () => {
    expect(whence(from(null), "desk")).toBe("");
    expect(whence(from(""), "desk")).toBe("");
    expect(whence(from("   "), "desk")).toBe("");
  });

  /* The field survives the wire, which is the half that was missing: Rust has
     stored it since v44 and `as_json` never sent it, so the wall could not say
     what the tool already could. */
  test("it comes off the wire", () => {
    expect(normalize({ id: "a", title: "t", originHost: "laptop" })?.originHost).toBe("laptop");
    expect(normalize({ id: "a", title: "t" })?.originHost).toBeNull();
  });
});
