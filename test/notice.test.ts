import { describe, expect, test } from "bun:test";
import {
  NOTICE_ACK,
  SETTLE_MS,
  YOUNG_JOB_MS,
  followUpText,
  isCloseKey,
  noticeFromRow,
  noticeLine,
  noticeQueue,
  noticeWords,
  parkedReply,
  raiseAt,
  restNotice,
  seesRest,
  allowanceReset,
  allowanceStop,
  waitsOnYou,
  type Notice,
} from "../src/lib/notice";

const n = (over: Partial<Notice>): Notice => ({
  id: "n",
  conversationId: "c",
  kind: "done",
  text: "done",
  raisedAt: 0,
  away: false,
  waited: false,
  ...over,
});

describe("restNotice", () => {
  test("a clean end is finished, a closing question is a question", () => {
    expect(restNotice("ok", "All green, committed.")).toEqual({
      kind: "done",
      text: "All green, committed.",
    });
    expect(restNotice("question", "Done.\n\nShould I push it?")?.kind).toBe("question");
  });

  test("an ask tool in the turn decides nothing — the closing words do", () => {
    expect(restNotice("asked", "Both landed. Send me the path and I'll load it.")?.kind).toBe(
      "question",
    );
    expect(restNotice("asked", "Both landed.")?.kind).toBe("done");
  });

  test("a stop is your own gesture, and a local command is not work", () => {
    expect(restNotice("stopped", "half way")).toBeNull();
    expect(restNotice("ok", "Compacted.", { local: true })).toBeNull();
    expect(restNotice(null, "x")).toBeNull();
  });

  test("an error raises only once the card has given up on it", () => {
    expect(restNotice("error", "", { lastError: "overloaded", healing: true })).toBeNull();
    const given = restNotice("error", "I was halfway through.", { lastError: "overloaded" });
    expect(given?.kind).toBe("error");
    expect(given?.text).toBe("overloaded\n\nI was halfway through.");
    expect(restNotice("error", "")?.text).toBe("the turn ended in an error");
  });

  test("a turn with nothing to say still says it finished", () => {
    expect(restNotice("ok", "  ")?.kind).toBe("done");
  });
});

describe("seesRest", () => {
  test("acknowledging a finish or a question stops the card's clock", () => {
    expect(seesRest(n({ kind: "done" }))).toBe(true);
    expect(seesRest(n({ kind: "question" }))).toBe(true);
  });

  test("but not a breakage, a card's own news, or one holding a turn open", () => {
    expect(seesRest(n({ kind: "error" }))).toBe(false);
    expect(seesRest(n({ kind: "card" }))).toBe(false);
    expect(seesRest(n({ kind: "card", askId: "a" }))).toBe(false);
    expect(seesRest(n({ kind: "question", askId: "a" }))).toBe(false);
  });
});

describe("raiseAt", () => {
  test("a rest with nothing running settles for a few seconds and no more", () => {
    expect(raiseAt(1_000, [])).toBe(1_000 + SETTLE_MS);
  });

  test("young background work holds it until the youngest job comes of age", () => {
    const rested = 100 * 60_000;
    const jobs = [{ since: rested - 60_000 }, { since: rested - 3 * 60_000 }];
    expect(raiseAt(rested, jobs)).toBe(rested - 60_000 + YOUNG_JOB_MS);
  });

  test("a dev server started an hour ago holds nothing", () => {
    const rested = 100 * 60_000;
    expect(raiseAt(rested, [{ since: rested - 60 * 60_000 }])).toBe(rested + SETTLE_MS);
  });
});

describe("the queue", () => {
  test("a notice holding a turn open comes first, the rest oldest first", () => {
    const q = noticeQueue([
      n({ id: "b", raisedAt: 2 }),
      n({ id: "a", raisedAt: 1 }),
      n({ id: "p", raisedAt: 9, askId: "ask-1", kind: "card" }),
    ]);
    expect(q.map((x) => x.id)).toEqual(["p", "a", "b"]);
  });
});

describe("words", () => {
  test("a question is answered and everything else is followed up", () => {
    expect(noticeWords(n({ kind: "question" })).send).toBe("answer");
    expect(noticeWords(n({ kind: "done" })).send).toBe("follow up");
    expect(noticeWords(n({ kind: "error" })).mark).toBe("Stopped on an error");
    expect(noticeWords(n({ kind: "card", askId: "a" })).mark).toContain("waiting");
  });

  test("a follow-up to a rest is your next message, to a card's notice it names it", () => {
    expect(followUpText(n({ kind: "done" }), "  push it ")).toBe("push it");
    const said = followUpText(n({ kind: "card", text: "Restarting the lab.\nBack in 5." }), "ok");
    expect(said).toContain("> Restarting the lab.\n> Back in 5.");
    expect(said.endsWith("ok")).toBe(true);
    /* Yours, so no relay mark — `relay.ts` reads those as "this was not you". */
    expect(said.startsWith("[skein")).toBe(false);
  });

  test("a parked notice returns the follow-up, or says it was only acknowledged", () => {
    expect(parkedReply()).toBe(NOTICE_ACK);
    expect(parkedReply("  ")).toBe(NOTICE_ACK);
    expect(parkedReply("go ahead")).toContain("go ahead");
  });

  test("one line of it, without the markdown", () => {
    expect(noticeLine("\n## **Done** in `x.rs`\nmore")).toBe("Done in x.rs");
    expect(noticeLine("")).toBe("");
  });
});

describe("noticeFromRow", () => {
  test("reads Rust's row and refuses what is not one", () => {
    expect(
      noticeFromRow({
        id: "1",
        conversation_id: "c",
        kind: "question",
        text: "t",
        raised_at: 5,
        away: true,
        waited: false,
      }),
    ).toEqual(n({ id: "1", kind: "question", text: "t", raisedAt: 5, away: true }));
    expect(noticeFromRow({ id: 1 })).toBeNull();
    expect(noticeFromRow({ id: "1", conversation_id: "c", kind: "mystery" })?.kind).toBe("done");
  });
});

describe("isCloseKey", () => {
  const k = (over: object) => ({
    key: "w",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    ...over,
  });
  test("ctrl+shift+w closes, in either case", () => {
    expect(isCloseKey(k({}))).toBe(true);
    expect(isCloseKey(k({ key: "W" }))).toBe(true);
  });
  test("anything short of the full chord does not", () => {
    expect(isCloseKey(k({ shiftKey: false }))).toBe(false);
    expect(isCloseKey(k({ ctrlKey: false }))).toBe(false);
    expect(isCloseKey(k({ altKey: true }))).toBe(false);
    expect(isCloseKey(k({ key: "q" }))).toBe(false);
  });
});

describe("an allowance stop waits on no one", () => {
  /* The CLI's own refusals, verbatim from this machine's transcripts
     (2026-10-19: b22ee072 and e6bbb8b7 on QUEERISFREEDOM), as `restNotice`
     makes them into an error notice: the refusal first, what it said after. */
  const limited = (said = "") =>
    restNotice("error", said, { lastError: "You've hit your session limit · resets 2:30pm (Australia/Sydney)" })!;

  test("an error notice opening on the CLI's refusal is an allowance stop, and does not wait on you", () => {
    const r = limited("I was halfway through the migration.");
    expect(r.kind).toBe("error");
    expect(allowanceStop(r)).toBe(true);
    expect(waitsOnYou(r)).toBe(false);
  });

  test("every window the CLI names, a curly apostrophe, and the credits wording", () => {
    for (const line of [
      "You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)",
      "You’ve hit your Opus limit · resets 9pm",
      "You've hit your monthly spend limit",
      "You're out of usage credits",
      "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    ]) {
      expect(allowanceStop({ kind: "error", text: line })).toBe(true);
    }
  });

  test("a card that broke for another reason still waits on you", () => {
    for (const line of [
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "API Error: 529 overloaded",
      "the turn ended in an error",
    ]) {
      const r = { kind: "error" as const, text: line };
      expect(allowanceStop(r)).toBe(false);
      expect(waitsOnYou(r)).toBe(true);
    }
  });

  test("a refusal the agent quoted in its closing words is not one: only the first line is the CLI's", () => {
    const r = restNotice("error", "The other service said: You've hit your session limit.", {
      lastError: "API Error: 529 overloaded",
    })!;
    expect(allowanceStop(r)).toBe(false);
  });

  test("only an error notice can be one", () => {
    expect(allowanceStop({ kind: "done", text: "You've hit your session limit" })).toBe(false);
    expect(allowanceStop({ kind: "question", text: "You've hit your session limit — shall I wait?" })).toBe(false);
    expect(waitsOnYou({ kind: "done", text: "fine" })).toBe(true);
  });

  test("the reset is read out of the refusal, and is null when it names none", () => {
    expect(allowanceReset(limited())).toBe("2:30pm");
    expect(allowanceReset({ text: "You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)" })).toBe("Aug 23, 3pm");
    expect(allowanceReset({ text: "You've hit your session limit · resets 9:10pm · progress saved" })).toBe("9:10pm");
    expect(allowanceReset({ text: "You've hit your monthly spend limit" })).toBeNull();
  });
});

describe("what you owe is read through one rule", () => {
  /* The dock and chat view read `Cards.noticing`, which leaves an allowance
     stop out (`waitsOnYou`); the away pile read `skein.noticeQueue` raw and so
     still listed one as owed — the same disagreement, one surface over. So the
     raw queue has exactly these readers, each named for its reason, and
     anything new that asks "what is waiting on you" goes through
     `Cards.noticing` or fails here. */
  const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const lib = join(import.meta.dir, "../src/lib");
  const files: [string, string][] = [
    ...readdirSync(lib)
      .filter((f) => /\.(ts|svelte)$/.test(f))
      .map((f): [string, string] => [f, readFileSync(join(lib, f), "utf8")]),
    ["App.svelte", readFileSync(join(import.meta.dir, "../src/App.svelte"), "utf8")],
  ];
  const ALLOWED: Record<string, number> = {
    /* Where it is made, and where a card's own notices are read whole. */
    "skein.svelte.ts": Infinity,
    "cards.svelte.ts": Infinity,
    /* A diagnostic snapshot, which reports the queue as it is. */
    "control.svelte.ts": Infinity,
    /* The peek's rows, which fold an allowance stop into one row per account
       — "an account ran out", a different statement from owing. */
    "App.svelte": 1,
    /* The peek's own account of what it is handed — a comment. */
    "attention.svelte.ts": 1,
  };

  test("only the named places read the raw queue", () => {
    const over = files.flatMap(([f, src]) => {
      const n = (src.match(/\bnoticeQueue\b(?!\()/g) ?? []).length;
      return n > (ALLOWED[f] ?? 0) ? [`${f}: ${n}`] : [];
    });
    expect(over).toEqual([]);
  });

  test("the away pile is fed by Cards.noticing", () => {
    const app = files.find(([f]) => f === "App.svelte")![1];
    expect(app).toMatch(/presence\.notices = \(\) => cards\.noticing/);
  });
});
