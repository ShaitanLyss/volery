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
  stateOf,
  waiting,
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

  /* The two refusals the face can make instantly. The other three — held,
     settled, and a title another item already holds — need the table and come
     back from Rust as a sentence. These two are the bar `do_drop` sets, and an
     edit must not take an item below the bar it cleared to get in. */
  test("a title and a body, which is the bar an agent's drop clears", () => {
    expect(refusal(proposed({ title: " ", body: "b", kind: "note", paths: "" }))).toBe(
      "an item needs a title",
    );
    expect(refusal(proposed({ title: "t", body: " ", kind: "note", paths: "" }))).toContain(
      "act on in a month",
    );
    expect(refusal(proposed({ title: "t", body: "b", kind: "note", paths: "" }))).toBeNull();
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
