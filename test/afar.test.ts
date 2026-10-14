import { describe, expect, test } from "bun:test";
import {
  DEFER_ANSWER,
  CLOSE_IT,
  LEAVE_IT,
  closingHere,
  closingsOf,
  readClosing,
  readClosings,
  DELETE_IT,
  KEEP_IT,
  humanSize,
  NOTICE_AFAR_ACK,
  NOTICE_AFAR_PREFIX,
  noticeAnswer,
  noticeHere,
  noticeOf,
  noticesOf,
  readNotices,
  readRemoval,
  readRemovals,
  remoteNotices,
  removalHere,
  removalsOf,
  confirmHere,
  confirmsOf,
  readConfirm,
  readConfirms,
  type DigestNotice,
} from "../src/lib/afar";
import corpus from "./fixtures/confirm.json";
import { composeAnswer, blankAnswers } from "../src/lib/asking";
import { digestOf, readDigest, type DigestSource } from "../src/lib/shadow";
import { NOTICE_ACK, type Notice } from "../src/lib/notice";

/* What `remove::evidence` writes, in full. */
function evidence(over: Record<string, unknown> = {}, target: Record<string, unknown> = {}) {
  return {
    machine: "home",
    reason: "a corrupt turbopack manifest",
    targets: [
      {
        path: "C:\\Users\\lyss\\workbench\\nova\\.next",
        kind: "directory",
        exists: true,
        entries: 9627,
        bytes: 5_690_000_000,
        capped: false,
        own: true,
        repo: true,
        tracked: 0,
        writers: ["auditing nova (32e394af)"],
        servers: ["nova dev (nova)"],
        ...target,
      },
    ],
    ...over,
  };
}

function source(over: Partial<DigestSource> = {}): DigestSource {
  return {
    id: "card-1",
    title: "tidy",
    project: "nova",
    territory: "nova",
    kind: "project",
    tier: "ask",
    ending: null,
    dormant: false,
    working: false,
    aside: false,
    gear: "making",
    activity: "asked you",
    held: null,
    stalled: false,
    unacknowledged: false,
    restingSince: 1_000,
    ctx: 0.2,
    lines: [],
    jobs: [],
    asks: [],
    ...over,
  };
}

describe("a removal carries what the glance would have said", () => {
  test("the whole of the evidence reads back", () => {
    const r = readRemoval(evidence())!;
    expect(r.machine).toBe("home");
    expect(r.targets[0]!.path).toBe("C:\\Users\\lyss\\workbench\\nova\\.next");
    expect(r.targets[0]!.entries).toBe(9627);
    expect(r.targets[0]!.own).toBe(true);
  });

  /* A field missing is a question this wall cannot compose, and it refuses
     rather than asks — never a bare path. Mirrors `remove::travels`. */
  test("anything missing refuses the whole removal", () => {
    for (const over of [{ machine: "" }, { reason: "  " }, { targets: [] }, { targets: "C:\\x" }]) {
      expect(readRemoval(evidence(over))).toBeNull();
    }
    for (const t of [
      { path: "" },
      { kind: "folder" },
      { exists: false },
      { entries: -1 },
      { entries: 1.5 },
      { bytes: "5 GB" },
      { capped: undefined },
      { own: undefined },
    ]) {
      expect(readRemoval(evidence({}, t))).toBeNull();
    }
    expect(readRemoval(evidence({ targets: Array(9).fill(evidence().targets[0]) }))).toBeNull();
    expect(readRemoval(null)).toBeNull();
  });

  test("only Volery's own question publishes its evidence", () => {
    const remove = readRemoval(evidence());
    const asks = [
      { askId: "a", since: 5, ours: true, remove },
      /* An agent's ask_user carrying a `remove` block is still an agent's. */
      { askId: "b", since: 6, ours: false, remove },
      /* A close: ours, and nothing to carry. */
      { askId: "c", since: 7, ours: true, remove: null },
    ];
    expect(removalsOf(asks).map((r) => r.askId)).toEqual(["a"]);
  });

  test("it travels in a field of its own, never among the questions", () => {
    const remove = readRemoval(evidence());
    const d = digestOf(
      source({ asks: [{ askId: "rm-1", since: 900, ours: true, questions: [], remove }] }),
    );
    /* A wall from before this reads `asks` alone: a removal there would reach
       it as an ordinary question with no machine on it. */
    expect(d.asks).toEqual([]);
    expect(d.removals).toHaveLength(1);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.removals[0]!.askId).toBe("rm-1");
    expect(back.removals[0]!.removal.targets[0]!.bytes).toBe(5_690_000_000);
    /* And one that does not read back is dropped, not drawn as less. */
    const broken = JSON.parse(JSON.stringify(d));
    delete broken.removals[0].removal.targets[0].own;
    expect(readRemovals(broken.removals)).toEqual([]);
  });
});

describe("the question drawn on the other wall", () => {
  const r = readRemoval(evidence())!;

  test("names the machine, the resolved path and what is there", () => {
    const q = removalHere(r, "home")!;
    expect(q).toHaveLength(1);
    expect(q[0]!.header).toBe("delete on home");
    const body = q[0]!.question;
    expect(body).toContain("**home**");
    expect(body).toContain("home's disk, not this machine's");
    expect(body).toContain("C:\\Users\\lyss\\workbench\\nova\\.next");
    expect(body).toContain("a directory, 5.3 GB in 9,627 files");
    expect(body).toContain("inside the card's own working tree");
    expect(body).toContain("**untracked**");
    expect(body).toContain("auditing nova (32e394af)");
    expect(body).toContain("nova dev (nova)");
    expect(body).toContain("a corrupt turbopack manifest");
    expect(body).toContain("**This is permanent.**");
  });

  test("says when it is outside the card's tree, and when a count is a floor", () => {
    const out = readRemoval(evidence({}, { own: false, capped: true }))!;
    const body = removalHere(out, "home")![0]!.question;
    expect(body).toContain("**outside the card's own working tree**");
    expect(body).toContain("more than 5.3 GB in more than 9,627 files");
  });

  /* The whole risk is confirming against the wrong filesystem. */
  test("is not drawn at all when the evidence names another machine", () => {
    expect(removalHere(r, "office")).toBeNull();
    expect(removalHere(r, "")).toBeNull();
    expect(removalHere(r, "HOME")).not.toBeNull();
  });

  test("a click answers with exactly the label the owning wall reads as a yes", () => {
    const q = removalHere(r, "home")!;
    expect(q[0]!.options.map((o) => o.label)).toEqual([DELETE_IT, KEEP_IT]);
    const answers = blankAnswers(q);
    answers[0] = DELETE_IT;
    expect(composeAnswer(q, answers)).toBe(DELETE_IT);
  });

  /* The two labels are Rust's, and only `delete it` verbatim is a yes there.
     Read out of the source so a renamed button cannot ship as a "no". */
  test("the labels are remove.rs's own", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/remove.rs", import.meta.url)).text();
    expect(rs).toContain(`const DELETE_IT: &str = "${DELETE_IT}";`);
    expect(rs).toContain(`const KEEP_IT: &str = "${KEEP_IT}";`);
  });

  test("sizes read in remove.rs's register", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(5_690_000_000)).toBe("5.3 GB");
    expect(humanSize(150 * 1024 * 1024)).toBe("150 MB");
  });
});

/* What `spawn::close_evidence` writes, in full. */
function closing(over: Record<string, unknown> = {}) {
  return {
    machine: "home",
    card: { title: "release notes", handle: "ab12cd34" },
    by: { title: "RISE salvage", handle: "901d7bf3" },
    why: "its work is done",
    timeline: null,
    ...over,
  };
}

describe("a close carries what the glance would have said (sink 2770489d)", () => {
  test("the whole of the evidence reads back", () => {
    const c = readClosing(closing())!;
    expect(c.machine).toBe("home");
    expect(c.card).toEqual({ title: "release notes", handle: "ab12cd34" });
    expect(c.by.handle).toBe("901d7bf3");
    expect(c.why).toBe("its work is done");
  });

  /* Mirrors `spawn::travels`: a field missing is a question this wall cannot
     compose, and it refuses rather than asks. */
  test("anything missing refuses the whole close, but no reason is a reason", () => {
    for (const over of [
      { machine: "" },
      { card: null },
      { card: { title: "x" } },
      { card: { title: "", handle: "ab12cd34" } },
      { by: { handle: "901d7bf3" } },
      { by: undefined },
      { why: "   " },
      { why: 5 },
      { timeline: "  " },
      { timeline: 3 },
    ]) {
      expect(readClosing(closing(over))).toBeNull();
    }
    expect(readClosing(null)).toBeNull();
    expect(readClosing(closing({ why: null }))!.why).toBeNull();
  });

  test("only Volery's own question publishes its evidence", () => {
    const close = readClosing(closing());
    const asks = [
      { askId: "a", since: 5, ours: true, close },
      /* An agent's ask_user carrying a `close` block is still an agent's. */
      { askId: "b", since: 6, ours: false, close },
      { askId: "c", since: 7, ours: true, close: null },
    ];
    expect(closingsOf(asks).map((r) => r.askId)).toEqual(["a"]);
  });

  test("it travels in a field of its own, never among the questions", () => {
    const close = readClosing(closing());
    const d = digestOf(
      source({ asks: [{ askId: "cl-1", since: 900, ours: true, questions: [], close }] }),
    );
    expect(d.asks).toEqual([]);
    expect(d.removals).toEqual([]);
    expect(d.closings).toHaveLength(1);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.closings[0]!.askId).toBe("cl-1");
    expect(back.closings[0]!.closing.card.handle).toBe("ab12cd34");
    /* A wall from before this sends no `closings`: nothing to draw. */
    const old = JSON.parse(JSON.stringify(d));
    delete old.closings;
    expect(readDigest(old)!.closings).toEqual([]);
    /* And one that does not read back is dropped, not drawn as less. */
    const broken = JSON.parse(JSON.stringify(d));
    delete broken.closings[0].closing.by;
    expect(readClosings(broken.closings)).toEqual([]);
  });

  test("the question names the machine, the card, who asked and why", () => {
    const q = closingHere(readClosing(closing())!, "home")!;
    expect(q).toHaveLength(1);
    expect(q[0]!.header).toBe("close on home");
    const body = q[0]!.question;
    expect(body).toContain("**home**");
    expect(body).toContain("**RISE salvage** (901d7bf3)");
    expect(body).toContain("**release notes** (ab12cd34)");
    expect(body).toContain("not a card it opened");
    expect(body).toContain("its work is done");
    expect(body).toContain("does not delete");
    const none = closingHere(readClosing(closing({ why: null }))!, "home")![0]!.question;
    expect(none).toContain("It gave no reason.");
    expect(none).not.toContain("timeline");
    const planned = closingHere(readClosing(closing({ timeline: "rewrite — 3 of 5 done" }))!, "home")![0]!
      .question;
    expect(planned).toContain("timeline still in flight: rewrite — 3 of 5 done");
    expect(planned).toContain("left unfinished");
    const itself = closingHere(
      readClosing(closing({ by: { title: "release notes", handle: "ab12cd34" } }))!,
      "home",
    )![0]!.question;
    expect(itself).toContain("is asking to be closed");
    expect(itself).not.toContain("not a card it opened");
  });

  /* The whole risk is confirming a close on the wrong wall. */
  test("is not drawn at all when the evidence names another machine", () => {
    const c = readClosing(closing())!;
    expect(closingHere(c, "office")).toBeNull();
    expect(closingHere(c, "")).toBeNull();
    expect(closingHere(c, "HOME")).not.toBeNull();
  });

  test("a click answers with exactly the label the owning wall reads as a yes", () => {
    const q = closingHere(readClosing(closing())!, "home")!;
    expect(q[0]!.options.map((o) => o.label)).toEqual([CLOSE_IT, LEAVE_IT]);
    const answers = blankAnswers(q);
    answers[0] = CLOSE_IT;
    expect(composeAnswer(q, answers)).toBe(CLOSE_IT);
  });

  test("the labels are spawn.rs's own", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/spawn.rs", import.meta.url)).text();
    expect(rs).toContain(`const CLOSE_IT: &str = "${CLOSE_IT}";`);
    expect(rs).toContain(`const LEAVE_IT: &str = "${LEAVE_IT}";`);
  });
});

/* A defer pressed on another wall's question travels as a sentence, because the
   prompt wire has no field for it and a wall from before it would read a new
   field as an answer. The owning wall recognises this exact text. */
describe("a defer sent to another wall (sink 7805fa20)", () => {
  test("is the string ask.rs recognises", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/ask.rs", import.meta.url)).text();
    expect(rs).toContain(`pub(crate) const DEFER_ANSWER: &str = "${DEFER_ANSWER}";`);
  });

  /* What an older wall would do with it is hand it to the agent as the
     answer, so it has to be safe to read as one. */
  test("reads as a non-answer to an agent that receives it as one", () => {
    expect(DEFER_ANSWER).toContain("later");
    expect(DEFER_ANSWER).toContain("Nothing has been decided");
    expect(DEFER_ANSWER).toContain("do not decide it yourself");
  });
});

describe("notices travel", () => {
  const row = (over: Partial<Notice> = {}): Notice => ({
    id: "n1",
    conversationId: "card-1",
    kind: "done",
    text: "Finished the migration.",
    raisedAt: 2_000,
    away: false,
    waited: false,
    ...over,
  });

  test("a card's own notices ride its digest and read back", () => {
    const queue = [row(), row({ id: "n2", conversationId: "other" }), row({ id: "n3", kind: "question", askId: "ask-9" })];
    const d = digestOf(source({ notices: queue }));
    expect(d.notices.map((n) => n.id)).toEqual(["n1", "n3"]);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.notices).toEqual([
      { id: "n1", kind: "done", text: "Finished the migration.", raisedAt: 2_000, askId: null },
      { id: "n3", kind: "question", text: "Finished the migration.", raisedAt: 2_000, askId: "ask-9" },
    ]);
  });

  test("an older wall sends none, and a broken one degrades", () => {
    expect(readDigest({ id: "x" })!.notices).toEqual([]);
    expect(readNotices([{ id: "", raisedAt: 1 }, { id: "a" }, { id: "b", raisedAt: 3, kind: "weird" }])).toEqual([
      { id: "b", kind: "done", text: "", raisedAt: 3, askId: null },
    ]);
  });

  test("drawn here as a notice no local row can be mistaken for", () => {
    const d: DigestNotice = { id: "n1", kind: "card", text: "x", raisedAt: 5, askId: null };
    const n = noticeHere(d, "elsewhere:home:card-1", 1_234);
    expect(n.id).toBe("elsewhere:home:card-1:n1");
    expect(n.conversationId).toBe("elsewhere:home:card-1");
    expect(n.raisedAt).toBe(1_234);
    expect(n.askId).toBeUndefined();
  });

  test("taking one down names it; a parked one is answered into its call", () => {
    const d: DigestNotice = { id: "n1", kind: "done", text: "x", raisedAt: 5, askId: null };
    expect(noticeAnswer(d)).toEqual({ answers: `${NOTICE_AFAR_PREFIX}n1`, text: NOTICE_AFAR_ACK });
    expect(noticeAnswer(d, "  run the tests too ")).toEqual({ answers: "notice:n1", text: "run the tests too" });
    const parked = { ...d, kind: "card" as const, askId: "ask-3" };
    expect(noticeAnswer(parked)).toEqual({ answers: "ask-3", text: NOTICE_ACK });
    expect(noticeAnswer(parked, "ok").text).toContain("ok");
    expect(noticeOf("notice:n1")).toBe("n1");
    expect(noticeOf("notice:")).toBeNull();
    expect(noticeOf("ask-3")).toBeNull();
  });

  /* The wire words are notice.rs's, read out of the source. */
  test("the prefix and the acknowledgement are notice.rs's own", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/notice.rs", import.meta.url)).text();
    expect(rs).toContain(`pub const AFAR_PREFIX: &str = "${NOTICE_AFAR_PREFIX}";`);
    expect(rs).toContain(`pub const AFAR_ACK: &str = "${NOTICE_AFAR_ACK}";`);
  });

  test("the ladder hears one row per card, and not over an open question", () => {
    const n = (id: string, raisedAt: number) => noticeHere({ id, kind: "done", text: "**Done** — all green", raisedAt, askId: null }, "s1", raisedAt);
    const rows = remoteNotices(
      [
        { id: "s1", host: "home", project: "nova", title: "tidy", open: [], notices: [n("a", 1_000), n("b", 4_000)] },
        { id: "s2", host: "home", project: "nova", title: "asks", open: [{}], notices: [n("c", 1_000)] },
        { id: "s3", host: "home", project: "nova", title: "quiet", open: [], notices: [] },
      ],
      10_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      key: "s1:b",
      kind: "notice",
      project: "nova · on home",
      detail: "finished — Done — all green",
      waitedSeconds: 6,
    });
  });
});

/* Sink a02ecd0e: a pull request asked on one laptop never reached the other.
   Every confirmation Volery composes now carries one generic block unless it
   names why it stays (`ask::Stay`), and nothing on this side knows a kind. The
   corpus is shared with `cargo test`, whose first entry is exactly what
   `smith.rs` stamps on a pull-request create. */
describe("every confirmation travels by one block (sink a02ecd0e)", () => {
  const pr = corpus.whole[0]!;

  test("the corpus reads the same here as in Rust", () => {
    for (const block of corpus.whole) expect(readConfirm(block)).not.toBeNull();
    for (const b of corpus.broken) expect(readConfirm(b.block), b.why).toBeNull();
    expect(readConfirm(null)).toBeNull();
  });

  test("only Volery's own publishes it, and not twice beside a removal or a close", () => {
    const confirm = readConfirm(pr);
    const close = readClosing(closing());
    const asks = [
      { askId: "a", since: 5, ours: true, confirm },
      /* An agent's ask_user dressed up with a block is still an agent's. */
      { askId: "b", since: 6, ours: false, confirm },
      /* One already travelling as a close goes in that field, which a wall of
         the build before this reads; publishing it here as well buys nothing. */
      { askId: "c", since: 7, ours: true, confirm, close },
      /* One that stays carries no block. */
      { askId: "d", since: 8, ours: true, confirm: null },
    ];
    expect(confirmsOf(asks).map((r) => r.askId)).toEqual(["a"]);
  });

  test("it travels in a field of its own, never among the questions", () => {
    const confirm = readConfirm(pr);
    const d = digestOf(source({ asks: [{ askId: "pr-1", since: 900, ours: true, questions: [], confirm }] }));
    expect(d.asks).toEqual([]);
    expect(d.confirms).toHaveLength(1);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.confirms[0]!.askId).toBe("pr-1");
    expect(back.confirms[0]!.confirm.act).toBe("open a pull request");
    /* A wall from before this sends no `confirms`: the question stays where it
       was asked, as it always did. */
    const old = JSON.parse(JSON.stringify(d));
    delete old.confirms;
    expect(readDigest(old)!.confirms).toEqual([]);
    /* And one that does not read back is dropped, not drawn as less. */
    const broken = JSON.parse(JSON.stringify(d));
    broken.confirms[0].confirm.facts = [];
    expect(readConfirms(broken.confirms)).toEqual([]);
  });

  test("the question names the machine and the card, and answers with the button's own label", () => {
    const q = confirmHere(readConfirm(pr)!, "AU-LT-288", "release the rise fix")!;
    expect(q).toHaveLength(1);
    expect(q[0]!.header).toBe("open a pull request on AU-LT-288");
    const body = q[0]!.question;
    expect(body).toContain("**release the rise fix**, a card on **AU-LT-288**");
    expect(body).toContain("**repository**: LagardereAWPL / RISE / rise-app");
    expect(body).toContain("`feature/travel` into `main`");
    expect(body).toContain("your own name");
    expect(body).toContain("Nothing happens on this machine");
    /* The click is the owning wall's exact label, which `smith::approved`
       reads verbatim — so the button here is the button there. */
    const answers = blankAnswers(q);
    answers[0] = q[0]!.options[0]!.label;
    expect(composeAnswer(q, answers)).toBe("open it");
    /* Heard from one machine, about another: not drawn at all. */
    expect(confirmHere(readConfirm(pr)!, "QUEERISFREEDOM", "x")).toBeNull();
    /* A reason is drawn when there is one. */
    const lend = confirmHere(readConfirm(corpus.whole[1])!, "home", "")![0]!.question;
    expect(lend).toContain("A card on **home**");
    expect(lend).toContain("Its reason: *to read the attachments on three tickets*");
  });

  /* The gate on the machine that acts names no tool. A list of what crosses
     is what stranded the pull request — every confirmation after the two that
     were made to cross was silently local — so the way it comes back is a tool
     name reappearing in this function. */
  test("the gate that lets an answer from afar act names no kind", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/ask.rs", import.meta.url)).text();
    const start = rs.indexOf("pub(crate) fn afar_may_answer(");
    expect(start).toBeGreaterThan(0);
    const body = rs.slice(start, start + rs.slice(start).search(/\r?\n\}\r?\n/));
    expect(body).toContain("confirm_travels");
    expect(body).not.toMatch(/_TOOL|_ACT|remove::|spawn::|board::|smith::|docket::|lend::/);
  });
});
