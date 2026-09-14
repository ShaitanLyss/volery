import { describe, expect, test } from "bun:test";
import { haystack, narrow, newestFirst, type Listed } from "../src/lib/adopt";

/* The adoption panel's ordering and searching. Both were inside the component
   and one of them was wrong in a way you could only see on a wall with real
   history on it: the filter matched the title, the folder and the branch, which
   on this machine is one field. 316 of 503 transcripts carry no title, and 216
   of those sessions are on `feat/store-productivity-improvements` — so the
   folder and the branch narrow nothing, and no word anybody remembered saying
   matched at all. */

const at = (p: Partial<Listed> & { id: string }): Listed => ({
  cwd: "C:\\atelier\\skein",
  branch: "main",
  title: null,
  prompt: null,
  last_at: null,
  ...p,
});

describe("what the panel shows before you have typed anything", () => {
  test("newest activity first", () => {
    const out = newestFirst([
      at({ id: "middle", last_at: "2026-08-01T10:00:00.000Z" }),
      at({ id: "newest", last_at: "2026-08-19T10:00:00.000Z" }),
      at({ id: "older", last_at: "2026-07-01T10:00:00.000Z" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["newest", "middle", "older"]);
  });

  /* Where a transcript that never said when it was belongs. It is not evidence
     of recency and putting it at the top would displace the thing you actually
     just closed, which is what this panel is opened to get back. */
  test("a session with no last activity sorts last", () => {
    const out = newestFirst([
      at({ id: "silent" }),
      at({ id: "dated", last_at: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["dated", "silent"]);
  });

  test("the list handed in is not reordered under the caller", () => {
    const given = [
      at({ id: "a", last_at: "2026-01-01T00:00:00.000Z" }),
      at({ id: "b", last_at: "2026-09-01T00:00:00.000Z" }),
    ];
    newestFirst(given);
    expect(given.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("finding one", () => {
  const wall = [
    at({
      id: "11111111-2222-3333-4444-555555555555",
      title: "the shader representing flow on the 2d pl…",
      prompt: "the shader representing flow on the 2d plane is drawing backwards",
      last_at: "2026-09-13T22:00:00.000Z",
    }),
    at({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      title: null,
      prompt: "add a gondola preview to the store planogram",
      cwd: "C:\\Users\\lyss.delprat\\workbench\\nova",
      branch: "feat/store-productivity-improvements",
      last_at: "2026-09-13T18:00:00.000Z",
    }),
    at({
      id: "cccccccc-dddd-eeee-ffff-000000000000",
      title: "the adoption panel",
      cwd: "C:\\Users\\lyss.delprat\\workbench\\skein",
      last_at: "2026-09-12T09:00:00.000Z",
    }),
  ];

  test("an empty query is every row, untouched", () => {
    expect(narrow(wall, "").map((s) => s.id)).toEqual(wall.map((s) => s.id));
    expect(narrow(wall, "   ").length).toBe(3);
  });

  /* The case the panel existed for and could not do: a word out of the
     conversation rather than out of its metadata. */
  test("a word somebody remembers saying finds the conversation", () => {
    expect(narrow(wall, "gondola").map((s) => s.id)).toEqual([wall[1].id]);
    expect(narrow(wall, "planogram").length).toBe(1);
  });

  /* The row is *reading* its first prompt when nothing better exists, so a
     query matching what is on screen must match. That was true of the title
     before and is now true of both. */
  test("the text the row is showing is searchable whichever source it came from", () => {
    expect(narrow(wall, "adoption").map((s) => s.id)).toEqual([wall[2].id]);
    expect(narrow(wall, "shader").map((s) => s.id)).toEqual([wall[0].id]);
  });

  /* A title that has been clipped keeps only its opening words, so a phrase
     from the middle of the conversation is in the prompt or nowhere. Searching
     both is what makes a clipped title survivable. */
  test("a phrase past the end of a clipped title is still found", () => {
    expect(narrow(wall, "backwards").map((s) => s.id)).toEqual([wall[0].id]);
  });

  test("case does not matter, in the query or in the row", () => {
    expect(narrow(wall, "GONDOLA").length).toBe(1);
    expect(narrow(wall, "Nova").length).toBe(1);
  });

  /* Every term has to land, in any field and in any order — which is what makes
     a branch 216 sessions share usable at all: it narrows in combination with
     something else even though it narrows nothing alone. */
  test("several terms all have to match, across fields and in any order", () => {
    expect(narrow(wall, "nova gondola").map((s) => s.id)).toEqual([wall[1].id]);
    expect(narrow(wall, "gondola nova").map((s) => s.id)).toEqual([wall[1].id]);
    expect(narrow(wall, "skein gondola").length).toBe(0);
    expect(narrow(wall, "store-productivity gondola").length).toBe(1);
  });

  test("a session id is a handle too, for somebody arriving from a log", () => {
    expect(narrow(wall, "aaaaaaaa-bbbb").map((s) => s.id)).toEqual([wall[1].id]);
  });

  /* Fields are joined on a separator no query can contain — a term is
     whitespace-free by construction — so a term cannot match across the seam
     between two of them and report a row that does not hold it anywhere. */
  test("a term cannot match across the join between two fields", () => {
    const row = at({ id: "x", title: "alpha", prompt: "beta" });
    expect(haystack(row)).toContain("\n");
    /* And specifically not a NUL, which is what stood here first. One in a text
       an agent may read is a 400 on that card's next request (`crate::clean`,
       `repair.rs`); one in a source file makes git call the file binary, and
       this one did. */
    expect(haystack(row)).not.toContain(String.fromCharCode(0));
    expect(narrow([row], "alpha").length).toBe(1);
    expect(narrow([row], "beta").length).toBe(1);
    expect(narrow([row], "alpha beta").length).toBe(1);
    expect(narrow([row], "alphabeta").length).toBe(0);
  });

  /* A row with nothing but a path still searches by its path, and a null field
     contributes nothing rather than the word "null" — which a `join` over the
     raw array would have put in every haystack on the wall. */
  test("a row with no title and no prompt is still findable by where it was", () => {
    const bare = at({ id: "bare", title: null, prompt: null, branch: null });
    expect(haystack(bare)).not.toContain("null");
    expect(narrow([bare], "atelier").length).toBe(1);
    expect(narrow([bare], "null").length).toBe(0);
  });
});
