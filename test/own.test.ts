import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CARRY_ON_TEXT, NUDGE_PROMPT_TEXT, NUDGE_TEXT, pickUpText, withResendMark } from "../src/lib/classify";
import { healFresh, isOwnPrompt } from "../src/lib/own";
import { RENEW_ASK } from "../src/lib/renewing";
import { handOver } from "../src/lib/relay";
import { jobsPrompt, resumePrompt } from "../src/lib/rousing";

/* Which prompts are Skein's own, rather than something you typed.
 *
 * Live the sender says so (`own: true`), apart from the heal, which asks this
 * of the text it actually sends. This is the other half: a session file records
 * them with nothing marking them, so the shapes are recognised from their
 * words, and a shape missing here is a card that comes back from a restart with
 * the wall's words in your bubble (reported 2026-11-11). */

const jobs = jobsPrompt([{ toolId: "t1", taskId: "a1", path: "/x", kind: "bash" }] as never, Date.now());

describe("skein's own prompts, by their words", () => {
  test("every fixed shape is recognised", () => {
    for (const s of [
      resumePrompt(),
      jobs,
      NUDGE_TEXT,
      NUDGE_PROMPT_TEXT,
      pickUpText(),
      CARRY_ON_TEXT,
      RENEW_ASK,
    ]) {
      expect(isOwnPrompt(s)).toBe(true);
    }
  });

  test("and a copy sent again after a failure is the same prompt", () => {
    /* The heal appends its mark; matched exactly, the healed copy read as
       yours, which is the one thing this must not do. */
    expect(isOwnPrompt(withResendMark(NUDGE_TEXT, "overloaded", 2))).toBe(true);
    expect(isOwnPrompt(withResendMark(resumePrompt(), "dropped", 1))).toBe(true);
  });

  test("your own prompts are yours", () => {
    for (const s of [
      "hello",
      "skein here — a background job you started has reported in. And one more thing.",
      "you were part-way through a turn when the wall closed, sort of",
      "/model sonnet",
      "[skein relay] from the billboard —\n\nsomething",
    ]) {
      expect(isOwnPrompt(s)).toBe(false);
    }
  });

  /* The briefs are markdown an agent wrote, so nothing in the words identifies
     them — the wall envelops them on the way out instead (`relay.ts::handOver`),
     which is what off disk recognition has to go on. The raw prose alone is
     still not recognisable, and saying so keeps the test honest about what the
     envelope is for rather than pretending the words carry it. */
  test("a brief is recognised by the wall's envelope, not by its words", () => {
    const brief = "## The plan\n\n1. read `server.rs`, then rename the field.";
    expect(isOwnPrompt(brief)).toBe(false);
    expect(isOwnPrompt(handOver(brief))).toBe(true);
    expect(isOwnPrompt(withResendMark(handOver(brief), "overloaded", 1))).toBe(true);
  });

  /* Two questions, and the heal asks them of two different things. `healFresh`
     is whether the sentence is new — a carry-on (the wall continuing a turn the
     allowance cut off) or a pick-up — and only those go out unmarked. The
     register is asked of the outgoing text, so a re-sent *copy* of any of
     Skein's shapes is still Skein's while a marked prompt of yours is still
     yours. Coupling them is what sent a re-sent brief out unmarked, as though
     the copy the CLI recorded were not in the session. */
  test("a heal knows which prompts are new and which are copies", () => {
    expect(healFresh({ carry: true, text: "anything" })).toBe(true);
    expect(healFresh({ text: CARRY_ON_TEXT })).toBe(true);
    expect(healFresh({ text: pickUpText() })).toBe(true);
    expect(healFresh({ text: "my prompt, sent again" })).toBe(false);
    expect(healFresh({ text: handOver("a brief") })).toBe(false);
    expect(healFresh({ text: RENEW_ASK })).toBe(false);
  });

  test("a marked copy of skein's words is still skein's", () => {
    for (const s of [
      withResendMark(handOver("a brief"), "overloaded", 2),
      withResendMark(RENEW_ASK, "limited", 1),
      withResendMark(pickUpText(), "dropped", 1),
    ]) {
      expect(isOwnPrompt(s)).toBe(true);
    }
    expect(isOwnPrompt(withResendMark("my own words", "overloaded", 2))).toBe(false);
  });

  /* And the live half reaches the line, which no test can otherwise see: the
     `Skein` class is not reachable from the pure suites. These two call sites
     drew the wall's words in the person's register — a queued spawn's brief
     live while the store marked it correctly for the restore, and the heal's
     two prompts live while `own.ts` recognised them off disk (found in
     review). */
  test("both live call sites mark what they send as skein's", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/skein.svelte.ts"), "utf8");
    expect(src).toContain("conv.drawHeld(item.key, item.text, true)");
    expect(src).toContain("this.send(conv, out, undefined, { own })");
  });

  /* And that the heal asks its two questions of the two different things. The
     predicates above are pinned; the call that combines them is not reachable
     from here, and getting it wrong is the exact defect this round fixed — a
     re-sent brief unmarked, or a re-sent renew ask losing Skein's register —
     with every other test still green. */
  test("the heal computes the register from the text it sends", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/skein.svelte.ts"), "utf8");
    expect(src).toContain("const fresh = healFresh(heal)");
    expect(src).toContain("const own = isOwnPrompt(out)");
  });
});
