import { describe, expect, test } from "bun:test";
import {
  causeOf,
  coalesce,
  look,
  LOOKING,
  peekKey,
  toAnnounce,
  unseen,
  type PeekItem,
  type Sight,
} from "../src/lib/peeking";

const T = 1_800_000_000_000;

function item(over: Partial<PeekItem> & Pick<PeekItem, "id">): PeekItem {
  return {
    project: "skein",
    title: "",
    kind: "blocked",
    detail: "",
    waitedSeconds: 0,
    ...over,
  };
}

/** Fold a run of passes: each is [focused, now, items]. */
function passes(steps: [boolean, number, PeekItem[]][]): Sight {
  let s = LOOKING;
  for (const [focused, now, items] of steps) s = look(s, items, focused, now);
  return s;
}

describe("what you have already seen", () => {
  test("nothing is unseen while the window is in front", () => {
    const a = item({ id: "a" });
    const s = passes([[true, T, [a]]]);
    expect(s.leftAt).toBeNull();
    expect(unseen([a], s)).toEqual([]);
  });

  test("going to another window announces nothing that was already standing", () => {
    const q = item({ id: "a", kind: "blocked", since: T - 60_000 });
    const f = item({ id: "b", kind: "failed", since: T - 5_000 });
    const s = passes([
      [true, T, [q, f]],
      [false, T + 1_000, [q, f]],
      [false, T + 30_000, [q, f]],
    ]);
    expect(s.leftAt).toBe(T + 1_000);
    expect(unseen([q, f], s)).toEqual([]);
  });

  test("something that arrives after you left is news", () => {
    const old = item({ id: "a", since: T - 60_000 });
    const fresh = item({ id: "b", since: T + 20_000 });
    const s = passes([
      [true, T, [old]],
      [false, T + 1_000, [old]],
      [false, T + 21_000, [old, fresh]],
    ]);
    expect(unseen([old, fresh], s).map((i) => i.id)).toEqual(["b"]);
  });

  test("an item that only reaches the ladder later is seen if its state was on the wall", () => {
    /* A card came to rest while you were looking; its overdue row appears
       GRACE_S later, after you left. The rest was on the wall — not news. */
    const s1 = passes([
      [true, T, []],
      [false, T + 5_000, []],
    ]);
    const overdue = item({ id: "a", kind: "overdue", since: T - 2_000, waitedSeconds: 22 });
    const s2 = look(s1, [overdue], false, T + 20_000);
    expect(unseen([overdue], s2)).toEqual([]);
  });

  test("a rest that began after you left is news even though it reached the ladder late", () => {
    const s1 = passes([
      [true, T, []],
      [false, T + 1_000, []],
    ]);
    const overdue = item({ id: "a", kind: "overdue", since: T + 3_000, waitedSeconds: 20 });
    const s2 = look(s1, [overdue], false, T + 23_000);
    expect(unseen([overdue], s2).map((i) => i.id)).toEqual(["a"]);
  });

  test("a key that left and came back is news — a card asking a second question", () => {
    const first = item({ id: "a", kind: "blocked", since: T - 10_000 });
    let s = passes([
      [true, T, [first]],
      [false, T + 1_000, [first]],
    ]);
    expect(unseen([first], s)).toEqual([]);
    /* Answered from another wall while you are away. */
    s = look(s, [], false, T + 5_000);
    const second = item({ id: "a", kind: "blocked", since: T + 9_000 });
    s = look(s, [second], false, T + 9_000);
    expect(unseen([second], s).map((i) => i.id)).toEqual(["a"]);
  });

  test("with no `since`, the ladder's own hearing decides", () => {
    /* Another wall's question: only when this wall heard of it is known. */
    const remote = item({ id: "r", kind: "blocked" });
    const s = passes([
      [true, T, []],
      [false, T + 1_000, []],
      [false, T + 4_000, [remote]],
    ]);
    expect(unseen([remote], s).map((i) => i.id)).toEqual(["r"]);
    const t = passes([
      [true, T, [remote]],
      [false, T + 1_000, [remote]],
    ]);
    expect(unseen([remote], t)).toEqual([]);
  });

  test("coming back clears the absence, and leaving again starts a new one", () => {
    const a = item({ id: "a", since: T + 5_000 });
    let s = passes([
      [true, T, []],
      [false, T + 1_000, []],
      [false, T + 5_000, [a]],
    ]);
    expect(unseen([a], s)).toHaveLength(1);
    s = look(s, [a], true, T + 9_000);
    expect(s.leftAt).toBeNull();
    s = look(s, [a], false, T + 12_000);
    expect(s.leftAt).toBe(T + 12_000);
    expect(unseen([a], s)).toEqual([]);
  });

  test("the leaving is dated from the blur, not from the pass that noticed it", () => {
    /* Something lands between the blur and the next pass: it arrived after you
       left, so it is news even though the pass sees it in the same breath. */
    const s0 = look(LOOKING, [], true, T);
    const q = item({ id: "q" });
    const s1 = look(s0, [q], false, T + 800, T + 300);
    expect(s1.leftAt).toBe(T + 300);
    expect(unseen([q], s1).map((i) => i.id)).toEqual(["q"]);
    /* A blur stamp from the future is not believed. */
    expect(look(s0, [], false, T + 800, T + 5_000).leftAt).toBe(T + 800);
  });

  test("a wall opened behind another window is not news about what stood before it", () => {
    /* The first pass is already unfocused; a notice raised last night arrives
       on the ladder a second later, when the queue has been read. */
    let s = look(LOOKING, [], false, T);
    const old = item({ id: "n", kind: "notice", key: "x", since: T - 3_600_000 });
    s = look(s, [old], false, T + 1_000);
    expect(unseen([old], s)).toEqual([]);
  });
});

describe("announcing", () => {
  test("each piece of news is announced once", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const one = toAnnounce([a], new Set());
    expect(one.news.map((i) => i.id)).toEqual(["a"]);
    const two = toAnnounce([a], one.announced);
    expect(two.news).toEqual([]);
    const three = toAnnounce([a, b], two.announced);
    expect(three.news.map((i) => i.id)).toEqual(["b"]);
  });

  test("something that left and came back is announced again", () => {
    const a = item({ id: "a" });
    const once = toAnnounce([a], new Set());
    const gone = toAnnounce([], once.announced);
    expect(gone.announced.size).toBe(0);
    expect(toAnnounce([a], gone.announced).news).toHaveLength(1);
  });

  test("a row leaving does not re-announce what is left", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const both = toAnnounce([a, b], new Set());
    expect(toAnnounce([a], both.announced).news).toEqual([]);
  });
});

describe("an account running out is one piece of news", () => {
  const limited = (account: string | null) => causeOf("limited", account);

  test("six cards caught by one account are one row", () => {
    const cards = ["a", "b", "c", "d", "e", "f"].map((id, n) =>
      item({
        id,
        kind: "failed",
        waitedSeconds: 10 + n,
        since: T - (10 + n) * 1000,
        detail: "You've hit your session limit · resets 3:30pm",
        cause: limited("work"),
      }),
    );
    const out = coalesce(cards);
    expect(out).toHaveLength(1);
    const [row] = out;
    expect(row.kind).toBe("failed");
    expect(row.title).toBe("work");
    expect(row.detail).toBe("ran out of allowance — 6 cards stopped on it");
    /* Lands you on the card it caught first. */
    expect(row.id).toBe("f");
    expect(row.waitedSeconds).toBe(15);
    expect(row.since).toBe(T - 15_000);
  });

  test("the row's key is the account's, so a card joining it is not news", () => {
    const a = item({ id: "a", kind: "failed", cause: limited("work") });
    const b = item({ id: "b", kind: "failed", cause: limited("work") });
    const once = coalesce([a]);
    const twice = coalesce([a, b]);
    expect(once[0].detail).toBe("ran out of allowance — one card stopped on it");
    expect(peekKey(once[0])).toBe(peekKey(twice[0]));
    const told = toAnnounce(once, new Set());
    expect(toAnnounce(twice, told.announced).news).toEqual([]);
  });

  test("a card's error notice about the allowance folds with the failures", () => {
    const failed = item({ id: "a", kind: "failed", cause: limited("work") });
    const notice = item({ id: "b", kind: "notice", key: "n1", cause: limited("work") });
    expect(coalesce([failed, notice])).toHaveLength(1);
  });

  test("a folded row rings as a notice when it swallowed one, and only then", () => {
    const failed = item({ id: "a", kind: "failed", cause: limited("work") });
    const notice = item({ id: "b", kind: "notice", key: "n1", cause: limited("work") });
    expect(coalesce([failed])[0].rings).toBeUndefined();
    expect(coalesce([failed, notice])[0].rings).toBe(true);
  });

  test("two accounts are two pieces of news", () => {
    const out = coalesce([
      item({ id: "a", kind: "failed", cause: limited("work") }),
      item({ id: "b", kind: "failed", cause: limited("home") }),
    ]);
    expect(out.map((i) => i.title).sort()).toEqual(["home", "work"]);
  });

  test("with no account managed, the one account is still one row", () => {
    const out = coalesce([
      item({ id: "a", kind: "failed", cause: limited(null) }),
      item({ id: "b", kind: "failed", cause: limited(null) }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("");
    expect(out[0].cause).toEqual({ kind: "limited", account: null });
  });

  test("other failures, and everything else, are left alone", () => {
    const overloaded = item({ id: "a", kind: "failed", cause: causeOf("overloaded", "work") });
    const plain = item({ id: "b", kind: "failed" });
    const question = item({ id: "c", kind: "blocked" });
    const out = coalesce([
      overloaded,
      plain,
      question,
      item({ id: "d", kind: "failed", cause: limited("work") }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(out[3].project).toBe("account");
    expect(causeOf("overloaded", "work")).toBeUndefined();
  });

  test("a question from a card on that account is not swallowed", () => {
    /* A card can be out of allowance and also have a question parked from
       before; the ladder lists it as blocked, and `coalesce` reads the kind. */
    const q = item({ id: "a", kind: "blocked", cause: limited("work") });
    expect(coalesce([q])).toEqual([q]);
  });
});
