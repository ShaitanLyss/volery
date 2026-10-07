import { describe, expect, test } from "bun:test";
import {
  NOTICE_ACK,
  SETTLE_MS,
  YOUNG_JOB_MS,
  followUpText,
  noticeFromRow,
  noticeLine,
  noticeQueue,
  noticeShown,
  noticeWords,
  parkedReply,
  raiseAt,
  restNotice,
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

  test("the focused card's notice is drawn first, else the front of the queue", () => {
    const q = [n({ id: "a", conversationId: "x" }), n({ id: "b", conversationId: "y" })];
    expect(noticeShown("y", q)?.id).toBe("b");
    expect(noticeShown("z", q)?.id).toBe("a");
    expect(noticeShown(null, [])).toBeNull();
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
