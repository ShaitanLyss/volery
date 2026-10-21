import { describe, expect, test } from "bun:test";
import {
  candidatesIn,
  commitKey,
  COMMIT_RECHECK_MS,
  refText,
  say,
  refTip,
  standing,
  whollyAn,
  worthAsking,
  type Ref,
} from "../src/lib/refs";

const keys = (t: string) => candidatesIn(t).map((c) => c.key);

describe("what in prose may be an id", () => {
  test("a handle, a sink id and a hash are each found where they stand", () => {
    const t = "closed 7a7c5f86 for sink 20422a14, shipped in 93961f1.";
    expect(keys(t)).toEqual(["7a7c5f86", "20422a14", "93961f1"]);
    const c = candidatesIn(t);
    expect(t.slice(c[2]!.from, c[2]!.to)).toBe("93961f1");
  });

  test("a full uuid is one candidate, keyed on its first eight characters", () => {
    const t = "card 6f90401a-1111-2222-3333-444455556666 spoke";
    const c = candidatesIn(t);
    expect(c).toHaveLength(1);
    expect(c[0]!.key).toBe("6f90401a");
    expect(c[0]!.text).toBe("6f90401a-1111-2222-3333-444455556666");
  });

  test("a hash and a handle are lower-cased for the lookup and left as written for the drawing", () => {
    const c = candidatesIn("see ABCDEF12");
    expect(c[0]!.key).toBe("abcdef12");
    expect(c[0]!.text).toBe("ABCDEF12");
  });

  test("a colour, a longer word, a path segment and a version are not ids", () => {
    for (const t of [
      "#aabbccdd",
      "color #deadbeef",
      "src/lib/20422a14x",
      "6f90401a-extra",
      "v0.73.1abcdef0",
      "feed_beef",
    ]) {
      expect(keys(t), t).toEqual([]);
    }
  });

  test("a word made only of a to f, a bare number and a date are not asked about", () => {
    for (const t of ["defaced", "acceded", "1234567", "decade"]) {
      expect(keys(t), t).toEqual([]);
    }
    expect(worthAsking("defaced")).toBe(false);
    expect(worthAsking("1234567")).toBe(false);
  });

  test("eight is always asked, because a handle can be all digits", () => {
    expect(worthAsking("20261021")).toBe(true);
    expect(worthAsking("abcdefab")).toBe(true);
  });

  test("a forty-one character run is no hash", () => {
    expect(keys("a".repeat(41))).toEqual([]);
    expect(keys("a1".repeat(20))).toEqual(["a1".repeat(20)]);
  });
});

describe("a code span that is exactly one id", () => {
  test("is recognised, and anything around it is not", () => {
    expect(whollyAn("7a7c5f86")?.key).toBe("7a7c5f86");
    expect(whollyAn("93961f1")?.key).toBe("93961f1");
    expect(whollyAn(" 7a7c5f86")).toBeNull();
    expect(whollyAn("7a7c5f86 and more")).toBeNull();
    expect(whollyAn("git show 93961f1")).toBeNull();
    expect(whollyAn("")).toBeNull();
  });
});

describe("what a chip says", () => {
  const sink: Ref = { kind: "sink", key: "20422a14", title: "A wake is drawn as you", settled: true };
  const commit: Ref = {
    kind: "commit",
    key: "93961f1",
    short: "93961f1",
    subject: "a refusal mark no longer vetoes an account",
    author: "MoonLyss",
    at: 1792557244,
    root: "C:/p",
  };

  test("the words are the title or the subject, never the id", () => {
    expect(refText(sink)).toBe("A wake is drawn as you");
    expect(refText(commit)).toBe("a refusal mark no longer vetoes an account");
    expect(refText({ kind: "notice", key: "deadbeef", title: "  " })).toBe("a notice");
    expect(refText({ ...sink, title: "" })).toBe("a sink item");
    expect(refText({ ...commit, subject: "" })).toBe("a commit");
  });

  test("the id is in the tip, for pasting to an agent", () => {
    expect(refTip(sink)).toBe("sink item 20422a14 · settled");
    expect(refTip({ ...sink, settled: false })).toBe("sink item 20422a14");
    expect(refTip({ kind: "notice", key: "deadbeef", title: "x" })).toBe("billboard notice deadbeef");
    expect(refTip(commit)).toContain("commit 93961f1 · MoonLyss · 2026-10-2");
  });
});

describe("a no about a commit is a reading of a moment", () => {
  test("a yes is kept, a recent no is kept, an old no is asked again", () => {
    const now = 1_000_000;
    expect(standing({ at: now - 10 * COMMIT_RECHECK_MS, yes: true }, now)).toBe(true);
    expect(standing({ at: now - 1000, yes: false }, now)).toBe(true);
    expect(standing({ at: now - COMMIT_RECHECK_MS - 1, yes: false }, now)).toBe(false);
  });

  test("the same seven characters in two repositories are two answers", () => {
    expect(commitKey("C:/a", "ABCDEF1")).not.toBe(commitKey("C:/b", "abcdef1"));
    expect(commitKey("C:/a", "ABCDEF1")).toBe(commitKey("C:/a", "abcdef1"));
  });
});

describe("an id said as its name where no chip can be drawn", () => {
  const known: Record<string, string> = { "7a7c5f86": "Fix sink item", "93961f1": "a refusal mark" };
  const nameOf = (c: { key: string }) => known[c.key] ?? null;

  test("a known id becomes its name and the words around it are untouched", () => {
    expect(say("closed 7a7c5f86 in 93961f1.", nameOf)).toBe("closed Fix sink item in a refusal mark.");
  });

  test("an id nothing confirmed is left exactly as written", () => {
    expect(say("see 20422a14 and 7a7c5f86", nameOf)).toBe("see 20422a14 and Fix sink item");
    expect(say("only 20422a14", nameOf)).toBe("only 20422a14");
    expect(say("", nameOf)).toBe("");
  });
});
