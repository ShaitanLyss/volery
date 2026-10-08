import { describe, expect, test } from "bun:test";
import {
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
  type DigestNotice,
} from "../src/lib/afar";
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
