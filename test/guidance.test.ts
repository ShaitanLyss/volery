import { describe, expect, test } from "bun:test";
import {
  changed,
  gist,
  LIMIT,
  lockGist,
  LOCKED_TOOLS,
  room,
  set,
  tidy,
} from "../src/lib/guidance";

describe("tidy", () => {
  test("trims the ends and leaves the middle alone", () => {
    expect(tidy("  call me Lyss  ")).toBe("call me Lyss");
    /* The blank line in the middle survives. Somebody's instructions are prose
       and reformatting prose as it is typed is how an editor stops being one. */
    expect(tidy("first\n\n\n\nsecond")).toBe("first\n\n\n\nsecond");
  });

  test("bounds a long one without splitting a character", () => {
    expect(tidy("x".repeat(LIMIT + 100))).toHaveLength(LIMIT);
    /* An astral character is one code point and two UTF-16 units. Slicing by
       `.length` would cut it in half and leave a lone surrogate, which is a
       string that survives every type check and renders as a replacement box. */
    const wide = "🌒".repeat(LIMIT + 10);
    const out = tidy(wide);
    expect([...out]).toHaveLength(LIMIT);
    expect(out).not.toContain("�");
    expect([...out].every((c) => c === "🌒")).toBe(true);
  });

  test("nothing is nothing", () => {
    expect(tidy("")).toBe("");
    expect(tidy("   \n\t  ")).toBe("");
  });
});

describe("changed", () => {
  test("a draft that only differs by whitespace has not changed", () => {
    /* The whole reason this is one function and not a `!==` at each call site:
       hitting Enter before Save must not be a reason for Save to light up. */
    expect(changed("read only\n", "read only")).toBe(false);
    expect(changed("  read only  ", "read only")).toBe(false);
    expect(changed("", "   ")).toBe(false);
  });

  test("real edits are changes, in both directions", () => {
    expect(changed("read only", "read only, mostly")).toBe(true);
    expect(changed("something", "")).toBe(true);
    /* Clearing the field is a change — it is how you take an instruction back,
       and a Save that stays dark would make that impossible. */
    expect(changed("", "read only")).toBe(true);
  });

  test("a draft past the limit stops changing once it is over", () => {
    /* Both clip to the same stored text, so there is nothing to save. Without
       this the button would sit lit forever on a too-long instruction. */
    const stored = "x".repeat(LIMIT);
    expect(changed("x".repeat(LIMIT + 50), stored)).toBe(false);
  });
});

describe("room", () => {
  test("counts down from the limit, in characters", () => {
    expect(room("")).toBe(LIMIT);
    expect(room("hello")).toBe(LIMIT - 5);
    /* Two UTF-16 units, one character, one unit of the budget — the same thing
       the Rust side enforces. A counter that disagrees with its own limit reads
       as the app losing text. */
    expect(room("🌒")).toBe(LIMIT - 1);
  });

  test("never goes negative", () => {
    expect(room("x".repeat(LIMIT + 500))).toBe(0);
  });

  test("ignores the whitespace that will be trimmed off anyway", () => {
    expect(room("   hi   ")).toBe(LIMIT - 2);
  });
});

describe("set", () => {
  test("only text somebody actually wrote counts", () => {
    expect(set("read only")).toBe(true);
    expect(set("")).toBe(false);
    expect(set("  \n ")).toBe(false);
    /* A project that predates the column and one from a build that does not
       send it both arrive as nothing rather than as a crash. */
    expect(set(null)).toBe(false);
    expect(set(undefined)).toBe(false);
  });
});

describe("gist", () => {
  test("is the first line with anything on it", () => {
    expect(gist("read only\ndo not commit")).toBe("read only");
    expect(gist("\n\n  the real first line  \nmore")).toBe("the real first line");
  });

  test("cuts long lines and says it did", () => {
    const out = gist("y".repeat(200), 20);
    expect([...out]).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a line exactly at the width is not cut", () => {
    /* The boundary, because an ellipsis on a line that fits is the kind of
       wrongness you see every day and never get round to. */
    const exact = "z".repeat(20);
    expect(gist(exact, 20)).toBe(exact);
  });

  test("nothing set reads as empty, so a caller can use it as the whole test", () => {
    expect(gist("")).toBe("");
    expect(gist("   \n\n  ")).toBe("");
    expect(gist(null)).toBe("");
    expect(gist(undefined)).toBe("");
  });
});

describe("lockGist", () => {
  test("names the tools it takes away, because the system prompt does too", () => {
    const on = lockGist("skein", true);
    for (const tool of LOCKED_TOOLS) expect(on).toContain(tool);
    expect(on).toContain("skein");
  });

  test("says what is left, so the switch does not read as breaking the card", () => {
    /* The half somebody deciding whether to turn it on needs: a locked card is
       not a mute one. It reads, searches, runs commands, and hands the change
       back in words. */
    const on = lockGist("nova", true);
    expect(on).toContain("read");
    expect(on).toContain("run commands");
    expect(on).toContain("hand a change back");
  });

  test("off says which of the two things this is, against the box beside it", () => {
    /* The whole difficulty of this switch. The box asks; this refuses the
       tools. A label that leaves somebody believing prose is enforcement is the
       state the lock was built to end. */
    const off = lockGist("rise", false);
    expect(off).toContain("ask them not to");
    expect(off).toContain("takes the editing tools away");
  });

  test("neither state claims more than it does", () => {
    /* The shell is untouched and the honest strong version is a decision the
       user is holding. Until then nothing here may say "read only" flat, as if
       a card could not write at all. */
    for (const locked of [true, false]) {
      const out = lockGist("skein", locked);
      expect(out).not.toContain("cannot write");
      expect(out).not.toContain("no shell");
    }
  });
});
