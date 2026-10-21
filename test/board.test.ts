import { describe, expect, test } from "bun:test";
import {
  author,
  covering,
  elsewhere,
  isEmpty,
  keyOf,
  normalize,
  normalizeAll,
  reading,
  searchNotices,
  since,
  type Notice,
} from "../src/lib/board";

const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  scope: "project",
  projectId: "skein",
  from: "aaaaaaaa-1111-4111-8111-111111111111",
  subject: "reworking the store",
  body: "leave store.rs alone until I say",
  paths: ["src-tauri/src/store.rs"],
  postedAt: 1000,
  touchedAt: 1000,
  stale: false,
  ...over,
});

const notice = (over: Record<string, unknown> = {}) => normalize(row(over)) as Notice;

describe("normalize", () => {
  test("takes a row as Rust writes it", () => {
    const n = notice();
    expect(n.subject).toBe("reworking the store");
    expect(n.paths).toEqual(["src-tauri/src/store.rs"]);
    expect(n.stale).toBe(false);
  });

  /* The bargain `normalizeAsk` strikes, one table over: what arrives is data a
     model composed and a build older than it may be reading. Refusing to draw a
     row is a board that silently shows less than is on it, which is the one
     failure this feature cannot have. */
  test("degrades a row it does not fully understand rather than dropping it", () => {
    const n = normalize({ id: "n2", subject: "hm", extra: 7 })!;
    expect(n.body).toBe("");
    expect(n.paths).toEqual([]);
    expect(n.scope).toBe("project");
    expect(n.from).toBeNull();
    expect(n.stale).toBe(false);
  });

  test("drops only what could not be drawn or taken down", () => {
    /* No id: nothing to unpost with. No subject: a blank line on the board. */
    expect(normalize(row({ id: "" }))).toBeNull();
    expect(normalize(row({ subject: "" }))).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize("a notice")).toBeNull();
  });

  test("a path list with rubbish in it keeps the strings", () => {
    expect(notice({ paths: ["a.ts", 7, null, "b.ts"] }).paths).toEqual(["a.ts", "b.ts"]);
    expect(notice({ paths: "not a list" }).paths).toEqual([]);
  });

  test("a whole board survives one bad row", () => {
    const all = normalizeAll([row(), { nonsense: true }, row({ id: "n3" })]);
    expect(all).toHaveLength(2);
    expect(normalizeAll("nope")).toEqual([]);
  });
});

describe("the reading", () => {
  /* Stale last is the only rule with an argument behind it: an old notice is
     the one least likely to still be true, so it must not lead — and it must
     not be hidden either, because a long refactor is a real thing. */
  test("puts what is current first and the old at the foot, newest first in each", () => {
    const list = [
      notice({ id: "old-stale", postedAt: 10, stale: true }),
      notice({ id: "new", postedAt: 90 }),
      notice({ id: "mid", postedAt: 50 }),
      notice({ id: "new-stale", postedAt: 80, stale: true }),
    ];
    expect(reading(list).map((n) => n.id)).toEqual([
      "new",
      "mid",
      "new-stale",
      "old-stale",
    ]);
  });

  test("keeps every notice — the order is a reading, not a filter", () => {
    const list = [notice({ id: "a", stale: true }), notice({ id: "b" })];
    expect(reading(list)).toHaveLength(2);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(list)).toBe(false);
  });
});

describe("what a row says", () => {
  test("ages read as the rest of the wall's do", () => {
    const n = notice({ postedAt: 0 });
    expect(since(n, 0)).toBe("just now");
    expect(since(n, 5 * 60_000)).toBe("5m");
    expect(since(n, 3 * 3_600_000)).toBe("3h");
    expect(since(n, 50 * 3_600_000)).toBe("2d");
    /* A clock that has not caught up yet is not a notice from the future. */
    expect(since(notice({ postedAt: 900 }), 0)).toBe("just now");
  });

  test("the files line is clipped, because a row is one line", () => {
    expect(covering(notice({ paths: [] }))).toBe("");
    expect(covering(notice({ paths: ["a.ts", "b.ts"] }))).toBe("a.ts, b.ts");
    expect(covering(notice({ paths: ["a", "b", "c", "d", "e"] }))).toBe("a, b, c +2");
  });

  test("an author is named in the words on the card, and never by its handle", () => {
    const names = new Map([["aaaaaaaa-1111-4111-8111-111111111111", "store schema"]]);
    expect(author(notice(), names)).toBe("store schema");
    /* A card closed since — the sweep in Rust should have taken the row with
       it, and this is the moment before the next read catches up. */
    expect(author(notice(), new Map())).toBe("a card no longer on the wall");
    /* And one you posted yourself, which has no card behind it at all. */
    expect(author(notice({ from: null }), names)).toBe("you");
  });
});

/* The board crosses the flyway (`flyway/boards.rs`): a notice from another
   wall arrives in the same read, named by its machine. */
describe("a notice from another wall", () => {
  const far = (over: Record<string, unknown> = {}) =>
    notice({ host: "lab2", title: "the orchestrator", projectId: null, project: "skein", ...over });

  test("carries its machine, its author's name there and its project's name", () => {
    const n = far();
    expect(n.host).toBe("lab2");
    expect(n.title).toBe("the orchestrator");
    expect(n.project).toBe("skein");
    expect(n.unheardMs).toBeNull();
    /* One of this wall's own reads as before. */
    const here = notice();
    expect(here.host).toBeNull();
    expect(here.title).toBeNull();
    /* Rubbish degrades to "this wall", never to a blank host. */
    expect(notice({ host: "", unheardMs: "soon" }).host).toBeNull();
    expect(notice({ unheardMs: Number.NaN }).unheardMs).toBeNull();
  });

  test("is named by its own wall's name for its author, since this roster has none", () => {
    expect(author(far(), new Map())).toBe("the orchestrator");
    expect(author(far({ title: null }), new Map())).toBe("a card no longer on the wall");
    expect(author(far({ from: null }), new Map())).toBe("you");
  });

  test("is keyed under its wall, so two walls cannot collide in one list", () => {
    expect(keyOf(far())).not.toBe(keyOf(notice()));
    expect(keyOf(notice())).toBe(":n1");
  });

  test("says where it stands: that machine's checkout, and an unheard wall's doubt", () => {
    expect(elsewhere(notice())).toBe("");
    expect(elsewhere(far({ paths: [] }))).toBe("on lab2's billboard");
    expect(elsewhere(far())).toContain("the files are lab2's checkout, not this one");
    const quiet = elsewhere(far({ paths: [], unheardMs: 5 * 60_000 }));
    expect(quiet).toContain("not heard from for 5m");
    expect(quiet).toContain("may have changed there");
    expect(elsewhere(far({ paths: [], unheardMs: 3 * 3_600_000 }))).toContain("for 3h");
  });
});

describe("searchNotices", () => {
  const all = [
    notice(),
    notice({ id: "n2", subject: "don't push to this repo", body: "release in flight", paths: [] }),
  ];
  test("every word somewhere, in any field, in any case", () => {
    expect(searchNotices(all, "STORE alone").map((n) => n.id)).toEqual(["n1"]);
    expect(searchNotices(all, "push flight").map((n) => n.id)).toEqual(["n2"]);
    expect(searchNotices(all, "store.rs").map((n) => n.id)).toEqual(["n1"]);
  });
  test("a quoted phrase is kept whole, and an empty query is everything", () => {
    expect(searchNotices(all, '"leave store"').map((n) => n.id)).toEqual(["n1"]);
    expect(searchNotices(all, '"store leave"')).toEqual([]);
    expect(searchNotices(all, "  ")).toHaveLength(2);
  });
  test("a term cannot match across two fields", () => {
    /* subject ends "store", body begins "leave": joined on a newline, so
       "storeleave" is in neither. */
    expect(searchNotices(all, "storeleave")).toEqual([]);
  });
});
