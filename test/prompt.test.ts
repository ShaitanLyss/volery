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
     that could break it.
     *
     * Phase 5a pinned the statement's tail to `'none',0,NULL`. Phase 5b keeps a
     * body, so that literal is gone for a reason and this is the edit it was
     * written to force. The guard is the same one in its new shape: the three
     * body columns are **bound**, in order, as the last three parameters, so
     * what reaches the column is whatever `promptvault::decide` produced and
     * never a string this write path is holding. `Body` is asserted to carry no
     * text of its own, below. */
  test("the prompt insert binds a sealed body and not a prompt", () => {
    const at = ingest.indexOf("INSERT INTO prompt_fact");
    expect(at).toBeGreaterThan(-1);
    const statement = ingest.slice(at, ingest.indexOf('",', at));
    expect(statement.match(/body_sealed/g)?.length).toBe(1);
    expect(statement.match(/body_state/g)?.length).toBe(1);
    expect(statement.trimEnd().endsWith("?22,?23,?24)")).toBe(true);
    /* No literal state: the ingest decides, the writer does not. */
    expect(statement).not.toContain("'none'");
    expect(statement).not.toContain("'sealed'");
  });

  /* And the decision's own type may not grow somewhere for the words to sit.
     `Body` is what crosses from `Reading::prompt` to the write, so a `text` or
     `said` field here would be the prompt held past the statement that read it
     — the rule the whole lane is built on. */
  test("what crosses to the write carries no text", async () => {
    const vault = await Bun.file(
      new URL("../src-tauri/src/promptvault.rs", import.meta.url),
    ).text();
    const at = vault.indexOf("pub(crate) struct Body {");
    expect(at).toBeGreaterThan(-1);
    /* `\n}` rather than `\n}\n`: the runner checks out with CRLF, where the
       closing line is `\r\n}`, and a search for the LF-only form misses and
       slices to the end of the file. That is how this guard passed here and
       failed in CI on a file it was right about. */
    const body = vault.slice(at, vault.indexOf("\n}", at));
    expect(body).not.toMatch(/^\s*(pub\(crate\) )?(text|said|prompt|plain)\s*:/m);
    /* The only fields it may have. `vault_id` is an identifier and the locator
       is a path and an offset; neither is words. */
    for (const field of body.matchAll(/^\s*(?:pub\(crate\) )?(\w+)\s*:/gm)) {
      expect(["state", "vault_id", "sealed", "truncated", "locator", "captured_at"]).toContain(
        field[1],
      );
    }

    /* And the one type that *does* hold unsealed text may not derive `Debug`:
       it is a command's answer, which is the obvious thing to put in a log line
       while looking at something else. Its shape is printed by hand instead,
       and the impl is read too, because a hand-written one that prints `text`
       is the same leak wearing a different derive. */
    const bodyAt = vault.indexOf("pub struct PromptBody {");
    expect(bodyAt).toBeGreaterThan(-1);
    const above = vault.slice(Math.max(0, bodyAt - 400), bodyAt);
    expect(above).not.toMatch(/#\[derive\([^)]*Debug/);
    const implAt = vault.indexOf("impl std::fmt::Debug for PromptBody");
    expect(implAt).toBeGreaterThan(-1);
    const impl = vault.slice(implAt, vault.indexOf("\n}", implAt));
    /* A length may be printed; the string may not. `&self.text.as_ref().map(…)`
       is the count and is fine; `&self.text` handed to a field, or a clone, is
       the leak. */
    expect(impl).not.toMatch(/&self\.text\s*[,)]/);
    expect(impl).not.toMatch(/self\.text\.clone\(\)/);
    expect(impl).toContain('"chars"');
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
