import { describe, expect, test } from "bun:test";
import { CARRY_ON_TEXT, NUDGE_PROMPT_TEXT, NUDGE_TEXT, pickUpText } from "../src/lib/classify";
import { jobsPrompt, resumePrompt } from "../src/lib/rousing";
import { RELAY_MARK, WAKE_MARK } from "../src/lib/relay";

/* The prompt vocabulary, held to the Rust that decides it.
 *
 * `docs/ANALYTICS.md` §3.8 names the seven kinds and says the TypeScript is
 * display only, held to the Rust enum by this file, the pattern
 * `test/afar.test.ts` uses for `remove.rs`'s labels. There is no TypeScript
 * vocabulary to compare against yet (the trace it draws is phase 5b), so what
 * this asserts is the half that exists: `prompt.rs` has exactly those seven
 * words, once each, in the published order, and a `store.rs` default names one
 * of them.
 *
 * A kind added to the enum without being added here fails, which is the whole
 * point: an eighth kind would reach a chart whose colours and labels were chosen
 * for seven.
 */

const rust = await Bun.file(new URL("../src-tauri/src/prompt.rs", import.meta.url)).text();
const store = await Bun.file(new URL("../src-tauri/src/store.rs", import.meta.url)).text();
/* The insert lives with the sink that writes it, not with the vocabulary. */
const ingest = await Bun.file(new URL("../src-tauri/src/analytics.rs", import.meta.url)).text();

/** §3.8's vocabulary, in its own order, as published. */
const PUBLISHED = ["design", "redirect", "nudge", "task", "question", "issue", "other"];

/** The words out of `pub const KINDS: [&str; N] = [ … ];`. */
function declaredKinds(source: string): string[] {
  const at = source.indexOf("pub const KINDS");
  if (at < 0) throw new Error("prompt.rs has no KINDS array");
  const open = source.indexOf("[", source.indexOf("=", at));
  const close = source.indexOf("];", open);
  if (open < 0 || close < 0) throw new Error("KINDS is not a closed array literal");
  return [...source.slice(open, close).matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

/** The strings `Kind::as_str` answers, in arm order. */
function spelledKinds(source: string): string[] {
  const at = source.indexOf("pub fn as_str");
  if (at < 0) throw new Error("prompt.rs has no Kind::as_str");
  const body = source.slice(at, source.indexOf("\n    }", at));
  return [...body.matchAll(/Kind::\w+\s*=>\s*"([a-z]+)"/g)].map((m) => m[1]);
}

describe("the prompt vocabulary", () => {
  test("is exactly the seven words §3.8 published, in its order", () => {
    expect(declaredKinds(rust)).toEqual(PUBLISHED);
  });

  test("and the enum spells each one the same way", () => {
    expect(spelledKinds(rust).sort()).toEqual([...PUBLISHED].sort());
  });

  /* A restated list is a second copy, so the two lists are also checked against
     each other: an arm that disagrees with the array is a row whose `kind`
     column says something the code cannot name back. */
  test("KINDS and as_str cannot drift apart", () => {
    expect(spelledKinds(rust)).toEqual(declaredKinds(rust));
  });

  /* The schema's default is a word the enum has to know, or a row written
     before the kind was decided draws as a colour nothing chose. */
  test("the schema's default kind is one of them", () => {
    const at = store.indexOf("CREATE TABLE IF NOT EXISTS prompt_fact");
    expect(at).toBeGreaterThan(-1);
    const body = store.slice(at, store.indexOf(");", at));
    const match = /kind\s+TEXT NOT NULL DEFAULT '([a-z]+)'/.exec(body);
    expect(match).not.toBeNull();
    expect(PUBLISHED).toContain(match![1]);
  });

  /* **No prompt text is stored by this lane**, and the insert is the one place
     that could break it. The statement names `body_sealed` exactly once, as the
     NULL it writes, and `body_state` as the literal `'none'`: a later change that
     carried a body through this path has to edit this line, and this test is
     what makes that edit a decision rather than an accident. */
  test("the prompt insert writes no body", () => {
    const at = ingest.indexOf("INSERT INTO prompt_fact");
    expect(at).toBeGreaterThan(-1);
    const statement = ingest.slice(at, ingest.indexOf('",', at));
    expect(statement.match(/body_sealed/g)?.length).toBe(1);
    /* The tail, literally. Asserting only that `NULL` and `'none'` appear
       somewhere would pass a change that bound a body into the last slot
       (`'none',0,?21)`), which is the exact edit this guard exists to catch, so
       the three literals are pinned in order at the end of the values. */
    expect(statement.trimEnd().endsWith("'none',0,NULL)")).toBe(true);
    /* And a body would arrive as a bound parameter. */
    expect(statement).not.toMatch(/body_sealed\s*=\s*\?/);
  });
});

/* The wall's own openings, held to the composers that write them.
 *
 * `sessions.rs` keeps a copy of each opening so the fold can reject a record the
 * wall wrote into a card's stdin. A copy that drifts is one of two failures, and
 * neither is loud: a wall prompt read as a person's pollutes the mix, and a
 * person's read as the wall's loses words nobody can recover. So every prefix in
 * Rust must be the start of exactly one composer's output, and every composer
 * here must be claimed by one.
 *
 * The resend mark is not in this list: it is *appended* rather than prefixed, so
 * `sessions.rs` finds it by its own shape and `classify.ts::RESEND_CAP` is the
 * sentence it draws. That link is checked by `classify.test.ts`, which owns the
 * mark's two halves.
 */
const sessions = await Bun.file(new URL("../src-tauri/src/sessions.rs", import.meta.url)).text();

/** The first string of every tuple in `sessions.rs`'s `WALL` array. */
function wallPrefixes(source: string): string[] {
  const at = source.indexOf("const WALL:");
  if (at < 0) throw new Error("sessions.rs has no WALL list");
  const open = source.indexOf("[", source.indexOf("=", at));
  const close = source.indexOf("];", open);
  if (open < 0 || close < 0) throw new Error("WALL is not a closed array literal");
  return [...source.slice(open, close).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\(.)/g, "$1"),
  );
}

describe("the wall's own prompts", () => {
  /* One entry per composer, named by the source it comes from so a failure
     reads as which one drifted. */
  const composers: [string, string][] = [
    ["relay.ts", RELAY_MARK],
    ["relay.ts", WAKE_MARK],
    ["rousing.ts", resumePrompt()],
    ["rousing.ts", jobsPrompt([])],
    ["classify.ts", NUDGE_TEXT],
    ["classify.ts", NUDGE_PROMPT_TEXT],
    ["classify.ts", pickUpText("overloaded")],
    ["classify.ts", CARRY_ON_TEXT],
  ];

  test("every opener Rust rejects is one a composer writes", () => {
    const prefixes = wallPrefixes(sessions);
    expect(prefixes.length).toBe(composers.length);
    for (const prefix of prefixes) {
      const claimed = composers.filter(([, text]) => text.startsWith(prefix));
      expect(claimed.length, `"${prefix}" is not the opening of exactly one composer`).toBe(1);
    }
  });

  test("and every composer's opening is rejected", () => {
    const prefixes = wallPrefixes(sessions);
    for (const [where, text] of composers) {
      expect(
        prefixes.some((prefix) => text.startsWith(prefix)),
        `${where}'s opening is not in sessions.rs's WALL list`,
      ).toBe(true);
    }
  });
});
