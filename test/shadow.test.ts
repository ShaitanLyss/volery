import { describe, expect, test } from "bun:test";
import { REGION_GAP, regionWidth, SLOT_H } from "../src/lib/layout";
import {
  ACCOUNTS_CAP,
  advance,
  capText,
  digestOf,
  faceOf,
  GIVE_UP_MS,
  idleOf,
  LAND_WITHIN_MS,
  landingNow,
  openRefusal,
  promptRefusal,
  QUIET_AFTER_MS,
  readDigest,
  readSnapshot,
  SAID_CAP,
  sameCards,
  scrub,
  sentReading,
  askHere,
  carryAnswers,
  shows,
  askedAt,
  remoteQuestions,
  standElsewhere,
  placedOf,
  steadyDoing,
  ELSEWHERE_COLS,
  HOST_HEAD,
  NO_PROJECT,
  sectionId,
  sectionOrder,
  stickShadow,
  keepHost,
  withoutWall,
  spotsOf,
  NO_SPOTS,
  type CardDigest,
  type DigestSource,
  type Sent,
} from "../src/lib/shadow";

function source(over: Partial<DigestSource> = {}): DigestSource {
  return {
    id: "c1",
    title: "fix the ring",
    project: "skein",
    territory: "skein",
    kind: "project",
    tier: "rest",
    ending: "ok",
    dormant: false,
    working: false,
    aside: false,
    gear: "making",
    activity: "at rest",
    held: null,
    stalled: false,
    unacknowledged: false,
    restingSince: 1_000,
    ctx: 0.4123,
    ctxTokens: 82_460,
    turns: 7,
    costUsd: 1.234,
    compactFrac: null,
    turnSince: null,
    holding: null,
    timeline: null,
    lines: [
      { kind: "you", text: "go" },
      { kind: "text", text: "first" },
      { kind: "tool", text: "reading x" },
      { kind: "text", text: "done — the ring no longer pegs" },
    ],
    jobs: [],
    pendingWakes: [],
    asks: [],
    ...over,
  };
}

describe("making a digest", () => {
  test("carries what a card face draws", () => {
    const d = digestOf(source());
    expect(d).toEqual({
      id: "c1",
      title: "fix the ring",
      project: "skein",
      territory: "skein",
      kind: "project",
      tier: "rest",
      ending: "ok",
      dormant: false,
      working: false,
      aside: false,
      planning: false,
      model: null,
      effort: null,
      account: null,
      bypassCaps: false,
      doing: "at rest",
      restingSince: 1_000,
      ctx: 0.412,
      ctxTokens: 82_460,
      turns: 7,
      costUsd: 1.23,
      compactFrac: null,
      turnSince: null,
      held: null,
      holding: null,
      timeline: null,
      said: "done — the ring no longer pegs",
      jobs: 0,
      wakes: [],
      asks: [],
      filed: null,
      removals: [],
      closings: [],
      confirms: [],
      notices: [],
      parent: null,
    });
  });

  /* A card waiting on a wake reads as waiting on the far wall too, and what
     crosses is the moment — never a countdown, which would change the digest
     every second and have it shipped every second. */
  test("carries the moment a card is waiting for, and an older wall's carries none", () => {
    const d = digestOf(source({ pendingWakes: [{ at: 9_000, note: "x".repeat(900), from: "wall" }] }));
    expect(d.wakes).toHaveLength(1);
    expect(d.wakes[0]).toMatchObject({ at: 9_000, from: "wall" });
    expect(d.wakes[0].note.length).toBeLessThanOrEqual(300);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    expect(back.wakes[0].at).toBe(9_000);
    const old = JSON.parse(JSON.stringify(d));
    delete old.wakes;
    expect(readDigest(old)?.wakes).toEqual([]);
    expect(readDigest({ ...old, wakes: [{ at: "soon" }, { at: null, from: "elsewhere" }] })?.wakes).toEqual([
      { at: null, note: "", from: "wall" },
    ]);
  });

  /* What a shadow's panel states in its footer the way a local card's does. An
     older wall sends none of them, which reads as unknown rather than as a
     model called "". */
  test("carries which model, effort and account, and an older wall's absence reads as unknown", () => {
    const d = digestOf(source({ model: "claude-opus-5[1m]", effort: "high", accountLabel: "work", bypassCaps: true }));
    expect(d).toMatchObject({ model: "claude-opus-5[1m]", effort: "high", account: "work", bypassCaps: true });
    expect(readDigest(JSON.parse(JSON.stringify(d)))).toMatchObject({
      model: "claude-opus-5[1m]",
      effort: "high",
      account: "work",
      bypassCaps: true,
    });
    const old = JSON.parse(JSON.stringify(digestOf(source())));
    delete old.model;
    delete old.account;
    expect(readDigest(old)).toMatchObject({ model: null, account: null, bypassCaps: false });
  });

  /* What lets another wall draw the root to a card's parent (`lineage.ts`,
     "across walls"). `host: null` is the card's own wall. */
  test("carries who opened the card, and survives the wire", () => {
    const local = digestOf(source({ parent: { host: null, card: "p1" } }));
    expect(local.parent).toEqual({ host: null, card: "p1" });
    const afar = digestOf(source({ parent: { host: "desk", card: "p2" } }));
    expect(readDigest(JSON.parse(JSON.stringify(afar)))?.parent).toEqual({ host: "desk", card: "p2" });
  });

  /* Two walls are never upgraded together: an older digest has no `parent`,
     and a broken one must never become a parent called "". */
  test("an older or broken wall's parent reads as none", () => {
    const base = digestOf(source());
    const { parent: _, ...old } = base;
    expect(readDigest(old)?.parent).toBeNull();
    expect(readDigest({ ...base, parent: { host: "desk", card: "\u0000 " } })?.parent).toBeNull();
    expect(readDigest({ ...base, parent: "p1" })?.parent).toBeNull();
    expect(readDigest({ ...base, parent: { host: "", card: "p1" } })?.parent).toEqual({ host: null, card: "p1" });
  });

  /* The said line is agent output, and it crosses a machine. */
  test("takes the impossible characters out of what was said", () => {
    const d = digestOf(source({ lines: [{ kind: "text", text: "ok\u0000\u0003 then\ttab\nline" }] }));
    expect(d.said).toBe("ok then\ttab\nline");
  });

  test("caps what was said, and marks the cut", () => {
    const d = digestOf(source({ lines: [{ kind: "text", text: "x".repeat(1000) }] }));
    expect(Array.from(d.said).length).toBe(SAID_CAP);
    expect(d.said.endsWith("…")).toBe(true);
  });

  test("never cuts through a surrogate pair", () => {
    const s = "🪶".repeat(10);
    const cut = capText(s, 4);
    expect(cut).toBe("🪶🪶🪶…");
  });

  /* A digest that changes every second would be shipped every second. */
  test("a resting card's digest does not change as it rests", () => {
    const a = digestOf(source());
    const b = digestOf(source());
    expect(sameCards([a], [b])).toBe(true);
  });

  test("a working card says no resting time, whatever the field held", () => {
    expect(digestOf(source({ working: true, restingSince: 5 })).restingSince).toBeNull();
  });

  test("an occupancy that moved by a token is not a change", () => {
    const a = digestOf(source({ ctx: 0.41231 }));
    const b = digestOf(source({ ctx: 0.41234 }));
    expect(sameCards([a], [b])).toBe(true);
    expect(sameCards([a], [digestOf(source({ ctx: 0.5 }))])).toBe(false);
  });

  test("planning is the gear, said as a flag", () => {
    expect(digestOf(source({ gear: "planning" })).planning).toBe(true);
  });

  test("background jobs are counted, not described", () => {
    expect(digestOf(source({ jobs: [{}, {}] })).jobs).toBe(2);
  });
});

describe("the steady activity line", () => {
  /* `Conversation.doing` counts down a hold and up a compaction every second;
     the digest keeps the words and drops the counting. */
  test("a held card says why, without the countdown", () => {
    expect(steadyDoing({ activity: "x", held: { why: "no allowance" }, stalled: true, unacknowledged: false })).toBe(
      "no allowance",
    );
  });
  test("stalled and unacknowledged keep their suffix", () => {
    expect(steadyDoing({ activity: "at rest", held: null, stalled: true, unacknowledged: false })).toBe(
      "at rest · not picked up",
    );
    expect(steadyDoing({ activity: "at rest", held: null, stalled: false, unacknowledged: true })).toBe(
      "at rest · sent, not picked up",
    );
  });
});

describe("reading a snapshot", () => {
  test("round-trips what was made", () => {
    const d = digestOf(source());
    const s = readSnapshot(JSON.parse(JSON.stringify({ v: 1, at: 5_000, cards: [d] })));
    expect(s).toEqual({ v: 1, at: 5_000, cards: [d], accounts: [] });
  });


  /* What a shadow's `put it on…` offers: the owner's labels, strings only,
     scrubbed, once each and bounded. An older wall sends none. */
  test("the owner's account labels are read as words and nothing else", () => {
    const s = readSnapshot({ at: 1, cards: [], accounts: ["work", "work", "", 7, "home\u0000", { x: 1 }] });
    expect(s!.accounts).toEqual(["work", "home"]);
    expect(readSnapshot({ at: 1, cards: [] })!.accounts).toEqual([]);
    expect(readSnapshot({ at: 1, cards: [], accounts: Array.from({ length: 99 }, (_, i) => `a${i}`) })!.accounts.length).toBe(
      ACCOUNTS_CAP,
    );
  });
  test("a wall saying nothing is not a wall with no cards", () => {
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ v: 1 })).toBeNull();
    expect(readSnapshot({ cards: [] })?.cards).toEqual([]);
  });

  test("a card with no id is dropped, a repeated id drawn once", () => {
    const s = readSnapshot({ at: 1, cards: [{ title: "x" }, { id: "a", title: "one" }, { id: "a", title: "two" }] });
    expect(s!.cards.map((c) => c.title)).toEqual(["one"]);
  });

  /* A newer wall's word is a colour this build would have to guess. */
  test("an unknown tier reads as the one that claims nothing", () => {
    expect(readDigest({ id: "a", tier: "glowing" })!.tier).toBe("rest");
    expect(readDigest({ id: "a", tier: "ask" })!.tier).toBe("ask");
  });

  test("degrades every field rather than refusing the card", () => {
    const d = readDigest({ id: "a", ctx: 7, jobs: -3, working: "yes", restingSince: "soon", kind: "other" })!;
    expect(d.ctx).toBe(1);
    expect(d.jobs).toBe(0);
    expect(d.working).toBe(false);
    expect(d.restingSince).toBeNull();
    expect(d.kind).toBe("project");
    expect(d.title).toBe("");
  });

  test("scrubs what it reads, whatever the far side did", () => {
    expect(readDigest({ id: "a", title: "a\u0007b" })!.title).toBe("ab");
    expect(scrub("\u007f")).toBe("");
  });

  test("a missing clock costs the idle and nothing else", () => {
    expect(readSnapshot({ cards: [{ id: "a" }] })!.at).toBeNull();
  });
});

describe("drawing a shadow", () => {
  const d: CardDigest = digestOf(source({ restingSince: 10_000 }));

  /* Owner clock and this clock disagree by an hour; idle must not care. */
  test("idle survives two clocks that disagree", () => {
    const ownerAt = 70_000; // owner says: made at 70s, resting since 10s → 60s rested
    const madeAt = 3_600_000 + 5_000; // this wall's estimate of when it was made
    const now = madeAt + 15_000;
    expect(idleOf(d, ownerAt, madeAt, now)).toBe(75);
  });

  test("a working card has no idle", () => {
    expect(idleOf({ ...d, working: true }, 70_000, 0, 100_000)).toBe(0);
  });

  test("a heard wall's card wears the owner's tier", () => {
    const f = faceOf({ ...d, tier: "work", working: true, doing: "running Bash" }, "lab", 10_000, 0);
    expect(f).toEqual({ tier: "work", working: true, dormant: false, doing: "running Bash", idleSeconds: 0, unheard: false });
  });

  /* The whole honesty of a shadow: a link that is down must not look like an
     agent that is thinking. */
  test("a quiet wall's working card claims nothing and says why", () => {
    const f = faceOf({ ...d, tier: "work", working: true, doing: "running Bash" }, "lab", QUIET_AFTER_MS + 1_000, 30);
    expect(f.tier).toBe("rest");
    expect(f.working).toBe(false);
    expect(f.dormant).toBe(true);
    expect(f.unheard).toBe(true);
    expect(f.idleSeconds).toBe(0);
    expect(f.doing).toBe("lab not heard from for 1m 31s · was working");
  });

  test("an asking card on a quiet wall stops asking too", () => {
    const f = faceOf({ ...d, tier: "ask" }, "lab", QUIET_AFTER_MS + 1, 0);
    expect(f.tier).toBe("rest");
  });

  test("a wall never heard from, or heard nonsense from, is not heard", () => {
    expect(faceOf(d, "lab", Infinity, 0)).toMatchObject({ unheard: true, doing: "lab not heard from · was at rest" });
    expect(faceOf(d, "lab", NaN, 0).unheard).toBe(true);
  });

  test("right at the bound it is still heard", () => {
    expect(faceOf(d, "lab", QUIET_AFTER_MS, 0).unheard).toBe(false);
  });
});

describe("a prompt sent to another wall", () => {
  const sent: Sent = { id: "p1", text: "go on", at: 0, state: "queued" };

  test("goes queued → left → taken", () => {
    const left = advance(sent, { kind: "left" });
    expect(left.state).toBe("left");
    expect(advance(left, { kind: "answer", outcome: "taken" }).state).toBe("taken");
  });

  /* The fourth reading, and the one the whole thing exists for. */
  test("left and unanswered says so, naming the machine", () => {
    const left = advance(sent, { kind: "left" });
    expect(sentReading(left, "lab", 1_000)).toEqual({
      look: "transit",
      words: "left this wall · lab has not said it has it",
    });
    expect(sentReading(sent, "lab", 1_000)).toEqual({ look: "pending", words: "not left this wall yet" });
  });

  test("refused here, at once, keeps the reason", () => {
    const r = advance(sent, { kind: "unsent", why: "lab has not been heard from for 4m" });
    expect(sentReading(r, "lab", 0)).toEqual({
      look: "failed",
      words: "not delivered — lab has not been heard from for 4m",
    });
  });

  test("an answer is final — a late `left` cannot walk it back into doubt", () => {
    const taken = advance(sent, { kind: "answer", outcome: "taken" });
    expect(advance(taken, { kind: "left" })).toBe(taken);
    const refused = advance(sent, { kind: "answer", outcome: "refused", why: "not accepting" });
    expect(advance(refused, { kind: "answer", outcome: "taken" })).toBe(refused);
  });

  test("past the give-up, a prompt that left is unknown, one that never left is failed", () => {
    const later = GIVE_UP_MS + 1;
    expect(sentReading(advance(sent, { kind: "left" }), "lab", later)).toEqual({
      look: "transit",
      words: "lab never answered — it may or may not have arrived",
    });
    expect(sentReading(sent, "lab", later)).toEqual({ look: "failed", words: "never left this wall" });
  });

  /* A late answer is still an answer: silence past the give-up was a reading,
     never a state. */
  test("a late answer still lands", () => {
    const left = advance(sent, { kind: "left" });
    const late = advance(left, { kind: "answer", outcome: "taken" });
    expect(sentReading(late, "lab", GIVE_UP_MS * 2).look).toBe("plain");
  });
});

describe("the owning wall's side", () => {
  test("a card that is gone is refused in words that say where", () => {
    expect(promptRefusal(false, "desk")).toBe("that card is not on desk any more — it may have been closed there");
    expect(promptRefusal(true, "desk")).toBeNull();
  });
});

describe("where other walls stand", () => {
  const s = (host: string, n: number, project = "skein") => ({
    id: `elsewhere:${host}:${project}:${n}`,
    host,
    project,
  });

  /* Lyss: shadow projects should behave as local projects by design, and a
     local project can be dragged about the wall. */
  test("a section somebody put somewhere stands there, and its slot in the column stays reserved", () => {
    const shadows = [s("lab", 1, "atelier"), s("lab", 2, "skein")];
    const beside = [{ x: 0, y: 0, w: 10, h: 10 }];
    const inLine = standElsewhere(shadows, beside);
    const id = sectionId("lab", "atelier");
    const put = standElsewhere(shadows, beside, { [id]: { x: 5000, y: -300 } });
    const was = inLine.regions.find((r) => r.name === "atelier")!;
    const now = put.regions.find((r) => r.name === "atelier")!;
    expect([now.x, now.y, now.moved]).toEqual([5000, -300, true]);
    expect(was.moved).toBe(false);
    // Its cards went with it, and the section under it did not slide up.
    const card = put.laid.find((n) => n.conv.id === "elsewhere:lab:atelier:1")!;
    expect(card.x).toBeGreaterThan(5000 - 1);
    const other = (r: typeof put) => r.regions.find((x) => x.name === "skein")!;
    expect([other(put).x, other(put).y]).toEqual([other(inLine).x, other(inLine).y]);
  });

  test("a stored blob that is not a pair of numbers puts a section back in line", () => {
    expect(placedOf({ a: { x: 1, y: 2 }, b: { x: "1", y: 2 }, c: null, d: { x: NaN, y: 0 } })).toEqual({ a: { x: 1, y: 2 } });
    expect(placedOf(null)).toEqual({});
  });

  test("nothing elsewhere stands nowhere", () => {
    expect(standElsewhere([], [{ x: 0, y: 0, w: 10, h: 10 }])).toEqual({ regions: [], heads: [], laid: [] });
  });

  /* The left edge is the one territories do not grow from. */
  test("in the left margin of everything already standing, under its wall's name", () => {
    const { regions, heads } = standElsewhere([s("lab", 1)], [
      { x: 100, y: 40, w: 300, h: 300 },
      { x: -50, y: 200, w: 100, h: 100 },
    ]);
    const x = -50 - regionWidth(ELSEWHERE_COLS) - REGION_GAP * 2;
    expect(heads).toEqual([{ host: "lab", x, y: 40, w: regionWidth(ELSEWHERE_COLS) }]);
    expect(regions[0]!.x).toBe(x);
    expect(regions[0]!.y).toBe(40 + HOST_HEAD);
    expect(regions[0]!.host).toBe("lab");
    expect(regions[0]!.name).toBe("skein");
  });

  /* Lyss: "all my shadow cards are one big grid, they should be sectioned by
     projects". A project is a territory on every wall; a machine's cards were
     the one place that reading broke down. */
  test("a section per project, each holding only its own cards", () => {
    const shadows = [
      s("lab", 1, "skein"),
      s("lab", 2, "atelier"),
      s("lab", 3, "skein"),
      s("lab", 4, "atelier"),
      s("lab", 5, "skein"),
    ];
    const { regions, laid } = standElsewhere(shadows, []);
    expect(regions.map((r) => r.name)).toEqual(["atelier", "skein"]);
    for (const n of laid) {
      const r = regions.find((r) => r.name === n.conv.project)!;
      expect(n.x).toBeGreaterThanOrEqual(r.x);
      expect(n.x).toBeLessThan(r.x + r.w);
      expect(n.y).toBeGreaterThanOrEqual(r.y);
      expect(n.y).toBeLessThan(r.y + r.h);
    }
    expect(laid.map((n) => n.conv)).toEqual(expect.arrayContaining(shadows));
    expect(laid).toHaveLength(shadows.length);
  });

  test("a wall's sections stack a project gap apart, and two walls a wider one", () => {
    const shadows = [s("zed", 1), s("lab", 1, "b"), s("lab", 2, "a"), s("lab", 3, "a"), s("lab", 4, "a"), s("lab", 5, "a"), s("lab", 6, "a")];
    const { regions, heads } = standElsewhere(shadows, []);
    expect(heads.map((h) => h.host)).toEqual(["lab", "zed"]);
    expect(regions.map((r) => [r.host, r.name])).toEqual([
      ["lab", "a"],
      ["lab", "b"],
      ["zed", "skein"],
    ]);
    const [a, b, zed] = regions;
    /* Five cards on four columns is two rows. */
    expect(a!.h).toBeGreaterThanOrEqual(2 * SLOT_H);
    expect(a!.y).toBe(heads[0]!.y + HOST_HEAD);
    expect(b!.y).toBe(a!.y + a!.h + REGION_GAP);
    expect(heads[1]!.y).toBe(b!.y + b!.h + REGION_GAP * 2);
    expect(zed!.y).toBe(heads[1]!.y + HOST_HEAD);
    /* One column down the margin, every section the same width. */
    expect(new Set(regions.map((r) => r.x)).size).toBe(1);
    expect(new Set(regions.map((r) => r.w)).size).toBe(1);
  });

  test("the same project on two walls is two sections, never one", () => {
    const { regions } = standElsewhere([s("lab", 1), s("zed", 1)], []);
    expect(regions.map((r) => r.id)).toEqual([sectionId("lab", "skein"), sectionId("zed", "skein")]);
    expect(new Set(regions.map((r) => r.id)).size).toBe(2);
  });

  /* Free text on both sides, so a separator one could contain is not one. */
  test("a section id cannot be forged by a host or project carrying the separator", () => {
    expect(sectionId("a:b", "c")).not.toBe(sectionId("a", "b:c"));
  });

  test("a card with no project stands in a section of its own, last, never called nothing", () => {
    const { regions, laid } = standElsewhere([s("lab", 1, ""), s("lab", 2, "  "), s("lab", 3, "zz")], []);
    expect(regions.map((r) => r.name)).toEqual(["zz", NO_PROJECT]);
    expect(regions.every((r) => r.name.trim() !== "")).toBe(true);
    expect(laid).toHaveLength(3);
  });

  /* By name, so a section does not move because a card in it spoke. */
  test("sections stand in name order, whatever case they are in", () => {
    expect(sectionOrder(["skein", "Atelier", "caravan", "", "atelier"])).toEqual([
      "atelier",
      "Atelier",
      "caravan",
      "skein",
      NO_PROJECT,
    ]);
  });
});

describe("a shadow on the glass", () => {
  const A = "elsewhere:lab:1";
  const B = "elsewhere:lab:2";
  const C = "elsewhere:lab_x:9";

  test("stuck and taken off again", () => {
    let g = stickShadow(NO_SPOTS, A, { x: 10, y: 20 });
    expect(g).toEqual({ [A]: { x: 10, y: 20 } });
    g = stickShadow(g, A, null);
    expect(g).toEqual({});
  });

  /* The store answers per room, and a newer or older build's row is not this
     build's to trust. */
  test("what the store answers is read as points, and nothing else", () => {
    expect(spotsOf({ [A]: [1, 2], [B]: "x", [C]: [1, NaN] })).toEqual({ [A]: { x: 1, y: 2 } });
    expect(spotsOf(undefined)).toEqual({});
    expect(spotsOf(null)).toEqual({});
  });

  /* A card its own wall closed will not come back, so its spot is let go —
     but only that wall's, and only because that wall was just heard. */
  test("a wall just heard lets go of its closed cards' spots and nobody else's", () => {
    let g = stickShadow(NO_SPOTS, A, { x: 1, y: 1 });
    g = stickShadow(g, B, { x: 2, y: 2 });
    g = stickShadow(g, C, { x: 3, y: 3 });
    g = keepHost(g, "lab", new Set([B]));
    expect(Object.keys(g).sort()).toEqual([B, C]);
  });

  test("nothing changed writes nothing", () => {
    const g = stickShadow(NO_SPOTS, A, { x: 1, y: 1 });
    expect(keepHost(g, "lab", new Set([A, B]))).toBe(g);
    expect(keepHost(g, "elsewhere", new Set())).toBe(g);
  });
});

describe("a question that travels", () => {
  const q = (over: object = {}) => ({
    header: "widget shape",
    question: "round or square?",
    options: [
      { label: "round", detail: "softer" },
      { label: "square", detail: null },
    ],
    ...over,
  });
  const asking = (over: object = {}) =>
    source({ asks: [{ askId: "a1", since: 5_000, ours: false, questions: [q()] }], ...over });

  test("carries the words of a parked question", () => {
    expect(digestOf(asking()).asks).toEqual([
      {
        askId: "a1",
        since: 5_000,
        questions: [
          {
            header: "widget shape",
            question: "round or square?",
            options: [
              { label: "round", detail: "softer" },
              { label: "square", detail: null },
            ],
            shows: false,
          },
        ],
      },
    ]);
  });

  /* A close, an unpost or a delete is answered where it would act. */
  test("never carries the wall's own questions", () => {
    const d = digestOf(source({ asks: [{ askId: "x", since: 1, ours: true, questions: [q()] }] }));
    expect(d.asks).toEqual([]);
  });

  /* The snapshot is re-sent on every change, so a design rides it as a flag;
     the call itself is pulled once (`flyway/look.rs`). */
  test("leaves a design out of the snapshot, and says that one is coming", () => {
    const withPreview = q({ options: [{ label: "this", detail: null, preview: { html: "<b>x</b>", css: null, js: "alert(1)" } }] });
    const d = digestOf(source({ asks: [{ askId: "a", since: 1, ours: false, questions: [withPreview] }] }));
    expect(JSON.stringify(d.asks)).not.toContain("alert");
    expect(d.asks[0]!.questions[0]!.shows).toBe(true);
    expect(shows(d.asks[0]!)).toBe(true);
    const here = askHere(d.asks[0]!, "lab");
    expect(here[0]!.question).toContain("bringing it over from lab");
    expect(here[0]!.options).toEqual([{ label: "this", detail: null }]);
  });

  /* A pull that fails says why where the words said something was coming —
     never a question that silently lost its picture. */
  test("a design that could not be brought over says why", () => {
    const withFile = q({ file: { root: "C:/out", path: "shot.png" } });
    const d = digestOf(source({ asks: [{ askId: "a", since: 1, ours: false, questions: [withFile] }] }));
    const here = askHere(d.asks[0]!, "lab", "lab runs an older Volery");
    expect(here[0]!.question).toContain("could not be brought over from lab: lab runs an older Volery");
    expect(here[0]!.question).not.toContain("bringing it over");
  });

  test("a question with nothing to show pulls nothing and says nothing", () => {
    const d = digestOf(source({ asks: [{ askId: "a", since: 1, ours: false, questions: [q()] }] }));
    expect(shows(d.asks[0]!)).toBe(false);
    expect(askHere(d.asks[0]!, "lab")[0]!.question).toBe(q().question);
  });

  /* Redrawn whole, a sheet keeps what was already answered — by position, and
     only while the questions still line up. */
  test("answers survive the question being redrawn whole", () => {
    const words = [
      { header: "a", question: "shape?", options: [{ label: "round" }, { label: "a very long lab…" }] },
      { header: "b", question: "why?", options: [] },
    ];
    const whole = [
      { header: "a", question: "shape?", options: [{ label: "round" }, { label: "a very long label indeed" }] },
      { header: "b", question: "why?", options: [] },
      { header: "c", question: "past the cap?", options: [] },
    ];
    /* An equal sheet is the same array — nothing for the panel to react to. */
    const same: (string | null)[] = ["round", "because"];
    expect(carryAnswers(words, same, whole.slice(0, 2))).toBe(same);
    /* A cut label becomes the whole one; free text stays; past the cap is open. */
    expect(carryAnswers(words, ["a very long lab…", "because"], whole)).toEqual([
      "a very long label indeed",
      "because",
      null,
    ]);
  });

  test("round-trips through the reader", () => {
    const d = digestOf(asking());
    expect(readDigest(JSON.parse(JSON.stringify(d)))!.asks).toEqual(d.asks);
  });

  test("an older wall that sends no questions is a card asking nothing", () => {
    expect(readDigest({ id: "c" })!.asks).toEqual([]);
  });

  test("drops what cannot be answered, keeps what can", () => {
    const asks = readDigest({
      id: "c",
      asks: [
        { since: 1, questions: [q()] }, // no id
        { askId: "b", questions: [q()] }, // no clock
        { askId: "c", since: 1, questions: [{ question: "   " }] }, // no words
        { askId: "d", since: 1, questions: [{ question: "go?", options: [{ label: "" }, { label: "yes" }] }] },
      ],
    })!.asks;
    expect(asks.map((a) => a.askId)).toEqual(["d"]);
    expect(asks[0]!.questions[0]!.options).toEqual([{ label: "yes", detail: null }]);
  });

  test("a question with no header is named from its words", () => {
    const here = askHere({ askId: "a", since: 0, questions: [{ header: "", question: "go?", options: [], shows: false }] }, "lab");
    expect(here[0]!.header).toBe("go?");
  });

  /* Owner clock at 70s, asked at 10s: a minute old when made. */
  test("when it was asked, without comparing two clocks", () => {
    const a = { askId: "a", since: 10_000, questions: [] };
    expect(askedAt(a, 70_000, 3_600_000)).toBe(3_600_000 - 60_000);
    expect(askedAt(a, null, 500)).toBe(500);
  });
});

describe("a remote question reaching you when you are not looking", () => {
  const q = (question: string, header = "h") => ({ header, question, options: [] });
  const shadow = (over: object = {}) => ({
    id: "elsewhere:lab:c1",
    host: "lab",
    project: "skein",
    title: "fix the ring",
    open: [
      { askId: "a1", questions: [q("round or square?")], since: 10_000 },
      { askId: "a2", questions: [q("later?")], since: 20_000 },
    ],
    ...over,
  });

  /* One row per card, as a local card is — and the peek keys its rows on id. */
  test("is one blocked row per card, its oldest question, keyed on the ask", () => {
    expect(remoteQuestions([shadow()], 70_000)).toEqual([
      {
        id: "elsewhere:lab:c1",
        key: "a1",
        project: "skein · on lab",
        title: "fix the ring",
        kind: "blocked",
        detail: "round or square?",
        waitedSeconds: 60,
      },
    ]);
  });

  test("a card with nothing open — answered, on its way, or its wall quiet — is no row", () => {
    expect(remoteQuestions([shadow({ open: [] })], 0)).toEqual([]);
  });

  test("several decisions name their headers, as a local one does", () => {
    const rows = remoteQuestions(
      [shadow({ open: [{ askId: "a", questions: [q("x", "shape"), q("y", "colour")], since: 0 }] })],
      0,
    );
    expect(rows[0]!.detail).toBe("2 decisions: shape · colour");
  });

  test("never a negative wait, whatever the estimate", () => {
    expect(remoteQuestions([shadow()], 0)[0]!.waitedSeconds).toBe(0);
  });
});

import {
  TAIL_BUDGET,
  TAIL_LINES,
  TAIL_RESULT_CAP,
  TAIL_TEXT_CAP,
  asLines,
  readTail,
  tailOf,
  weave,
  type Sent,
  type TailSource,
  type WireLine,
} from "../src/lib/shadow";

const said = (kind: string, text: string, extra: Partial<TailSource> = {}): TailSource => ({
  kind,
  text,
  ...extra,
});

const sent = (text: string, at: number, state: Sent["state"] = "taken"): Sent => ({
  id: `s${at}`,
  text,
  at,
  state,
});

describe("a conversation crossing to another wall", () => {
  test("the tail is the end of it, in order", () => {
    const lines = Array.from({ length: 200 }, (_, i) => said("text", `line ${i}`));
    const out = tailOf(lines);
    expect(out.length).toBe(TAIL_LINES);
    /* The END, not the beginning — a conversation is about where it got to. */
    expect(out[out.length - 1].text).toBe("line 199");
    expect(out[0].text).toBe(`line ${200 - TAIL_LINES}`);
  });

  test("a short conversation crosses whole", () => {
    const out = tailOf([said("you", "hello"), said("text", "hi")]);
    expect(out.map((l) => l.text)).toEqual(["hello", "hi"]);
  });

  test("what is cut says so", () => {
    const out = tailOf([said("text", "x".repeat(TAIL_TEXT_CAP + 500))]);
    expect(out[0].text.length).toBe(TAIL_TEXT_CAP);
    expect(out[0].text.endsWith("…")).toBe(true);
  });

  test("a tool result crosses, capped, rather than being dropped", () => {
    const out = tailOf([
      said("tool", "reading a file", {
        call: { name: "Read", input: { path: "a.ts" }, result: { text: "y".repeat(9_999) } },
      }),
    ]);
    /* Opening a call is the one gesture whose whole purpose is seeing what came
       back, so a fold that opens onto nothing is worse than no fold. */
    expect(out[0].call?.result?.length).toBe(TAIL_RESULT_CAP);
    expect(out[0].call?.name).toBe("Read");
    expect(out[0].call?.input).toBe(JSON.stringify({ path: "a.ts" }));
  });

  test("the budget stops the walk rather than leaving a hole", () => {
    const big = "z".repeat(TAIL_TEXT_CAP);
    const lines = Array.from({ length: 100 }, () => said("text", big));
    const out = tailOf(lines);
    /* Contiguous: everything dropped is older than everything kept. A hole
       would read as a conversation that skipped a round. */
    expect(out.length).toBeLessThan(100);
    expect(out.length).toBeGreaterThan(0);
    const spent = out.reduce((n, l) => n + l.text.length, 0);
    expect(spent).toBeLessThanOrEqual(TAIL_BUDGET + TAIL_TEXT_CAP);
  });

  test("one line past the budget still crosses, or a panel opens empty", () => {
    const out = tailOf([said("text", "q".repeat(TAIL_TEXT_CAP))]);
    expect(out.length).toBe(1);
  });

  test("a circular input costs the line its arguments, not its place", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const out = tailOf([said("tool", "doing a thing", { call: { name: "X", input: loop } })]);
    expect(out[0].call?.name).toBe("X");
    expect(out[0].call?.input).toBeUndefined();
  });
});

describe("reading a tail back from a wall you did not write", () => {
  test("a newer wall's extra fields cost nothing", () => {
    const out = readTail([{ kind: "text", text: "hi", futureThing: 9 }]);
    expect(out).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("rubbish is dropped, never guessed at", () => {
    expect(readTail("nope")).toBeNull();
    expect(readTail([null, 7, { kind: "text" }, { text: "no kind" }])).toEqual([]);
  });

  test("a line survives the round trip", () => {
    const there = tailOf([
      said("you", "do the thing"),
      said("tool", "running", {
        call: { name: "Bash", input: { cmd: "ls" }, result: { text: "a\nb", failed: true } },
      }),
      said("text", "done", { narration: true }),
    ]);
    expect(readTail(JSON.parse(JSON.stringify(there)))).toEqual(there);
  });

  test("a state nobody recognises is not kept", () => {
    const out = readTail([{ kind: "you", text: "x", state: "exploded" }]);
    expect(out?.[0].state).toBeUndefined();
  });
});

/* What you sent to a card elsewhere draws its pictures under the line, as a
   prompt to a card here does — the thumbnails, kept on the send. */
describe("a sent prompt's pictures", () => {
  const shots = [{ name: "image 1", thumb: "data:image/png;base64,AA==" }];

  test("under the line while it travels", () => {
    const line = asLines(weave([], [{ ...sent("look at [image 1]", 10, "left"), shots }]), "lab", 20)[0]!;
    expect(line).toMatchObject({ kind: "you", text: "look at [image 1]", shots });
  });

  test("and under their copy once it has arrived", () => {
    const tail: WireLine[] = [{ kind: "you", text: "look at [image 1]" }];
    const line = asLines(weave(tail, [{ ...sent("look at [image 1]", 10), shots }]), "lab", 20)[0]!;
    expect(line.shots).toEqual(shots);
  });

  test("a send with none draws none", () => {
    expect(asLines(weave([], [sent("words", 10, "left")]), "lab", 20)[0]!.shots).toBeUndefined();
  });
});

describe("weaving your own sends into their conversation", () => {
  const tail: WireLine[] = [
    { kind: "you", text: "first thing" },
    { kind: "text", text: "answered" },
  ];

  test("a send that arrived keeps its receipt under their copy", () => {
    const w = weave(tail, [sent("first thing", 10)]);
    /* Not trimmed away: `<host> has it` is the only thing that distinguishes
       delivered from still-in-hand, and Lyss asked for it by name. */
    expect(w.length).toBe(2);
    expect(w[0]).toMatchObject({ at: "there", sent: { id: "s10" } });
    expect(w.filter((x) => x.at === "here").length).toBe(0);
  });

  test("a send still in flight goes below, once", () => {
    const w = weave(tail, [sent("first thing", 10), sent("not there yet", 20, "left")]);
    const here = w.filter((x) => x.at === "here");
    expect(here.length).toBe(1);
    expect(here[0]).toMatchObject({ sent: { text: "not there yet" } });
  });

  test("two identical sends are two lines, not one claimed twice", () => {
    /* `#claimEcho`'s lesson, one wall over: a match must be consumed, or a
       prompt sent twice is drawn once and the other is swallowed. */
    const both: WireLine[] = [
      { kind: "you", text: "again" },
      { kind: "you", text: "again" },
    ];
    const w = weave(both, [sent("again", 1), sent("again", 2)]);
    expect(w.filter((x) => x.at === "here").length).toBe(0);
    const claimed = w.filter((x) => x.at === "there" && x.sent);
    expect(claimed.length).toBe(2);
    expect(new Set(claimed.map((x) => (x as { sent: Sent }).sent.id)).size).toBe(2);
  });

  test("one send cannot claim a line a different send already has", () => {
    const one: WireLine[] = [{ kind: "you", text: "again" }];
    const w = weave(one, [sent("again", 1), sent("again", 2)]);
    expect(w.filter((x) => x.at === "here").length).toBe(1);
  });

  test("only your own registers are matched", () => {
    /* The agent saying your words back is not your prompt arriving. */
    const echoed: WireLine[] = [{ kind: "text", text: "do the thing" }];
    const w = weave(echoed, [sent("do the thing", 1)]);
    expect(w.filter((x) => x.at === "here").length).toBe(1);
  });

  test("whitespace does not stop a send being recognised", () => {
    const w = weave([{ kind: "you", text: "  padded " }], [sent("padded", 1)]);
    expect(w.filter((x) => x.at === "here").length).toBe(0);
  });

  test("a taken send the tail no longer holds is not drawn below everything", () => {
    /* It scrolled out of the window, or is worded differently over there. Left
       in, it sat under the newest thing the card said for the rest of the
       session. A fresh one stays: the tail may just not have been re-read. */
    const w = weave(tail, [sent("long gone", 10), sent("just now", 1_000_000 - 1_000)], 1_000_000);
    const here = w.filter((x) => x.at === "here");
    expect(here.map((x) => (x as { sent: Sent }).sent.text)).toEqual(["just now"]);
    /* A send still in doubt is never dropped, however old. */
    const w2 = weave(tail, [sent("stuck", 10, "left")], 1_000_000);
    expect(w2.filter((x) => x.at === "here").length).toBe(1);
  });

  test("an empty tail is every send, in the order they were made", () => {
    const w = weave([], [sent("b", 20, "left"), sent("a", 10, "queued")]);
    expect(w.map((x) => (x.at === "here" ? x.sent.text : "?"))).toEqual(["a", "b"]);
  });
});

describe("opening a card in a section of another wall", () => {
  const open = { host: "lab", standing: "open", territories: ["skein", "RISE"], opens: true };

  test("a wall heard, new enough, taking work and holding the project is offered", () => {
    expect(openRefusal(open, "lab", "skein")).toBeNull();
    expect(openRefusal(open, "lab", "rise")).toBeNull();
  });

  test("everything else says why, in the order it would have to change", () => {
    expect(openRefusal(undefined, "lab", "skein")).toContain("not been heard from");
    expect(openRefusal({ ...open, me: true }, "lab", "skein")).toContain("not been heard from");
    expect(openRefusal({ ...open, standing: "quiet" }, "lab", "skein")).toContain("never queued");
    expect(openRefusal({ ...open, opens: undefined }, "lab", "skein")).toContain("needs updating");
    expect(openRefusal({ ...open, older: true }, "lab", "skein")).toContain("needs updating");
    expect(openRefusal({ ...open, standing: "closed", reason: "lab is not taking work" }, "lab", "skein")).toBe(
      "lab is not taking work",
    );
    expect(openRefusal({ ...open, standing: "full" }, "lab", "skein")).toContain("not taking work");
    expect(openRefusal(open, "lab", "nova")).toBe("lab has no project called nova");
    expect(openRefusal({ ...open, territories: [...open.territories, NO_PROJECT] }, "lab", NO_PROJECT)).toContain(
      "no project called",
    );
  });

  test("a card that arrives in time takes the focus, and only if nothing else has", () => {
    const l = { key: "elsewhere:lab:c1", until: 1000 + LAND_WITHIN_MS, focusWas: "here-1" };
    expect(landingNow(l, false, "here-1", 2000)).toBe("wait");
    expect(landingNow(l, true, "here-1", 2000)).toBe("focus");
    expect(landingNow(l, true, "here-2", 2000)).toBe("drop");
    expect(landingNow(l, true, null, 2000)).toBe("drop");
    expect(landingNow(l, true, "here-1", 1001 + LAND_WITHIN_MS)).toBe("drop");
    expect(landingNow({ ...l, focusWas: null }, true, null, 2000)).toBe("focus");
  });
});

describe("a wall that leaves", () => {
  const row = (host: string) => ({ host, quietMs: 0 });
  const held = () => ({
    walls: { lap: { n: 1 }, desk: { n: 2 } } as Record<string, { n: number }>,
    heardAt: { lap: 10, desk: 20 } as Record<string, number>,
    roster: [row("me"), row("lap"), row("desk")],
  });

  test("is taken off the roster, the snapshots and the heard times — and only it", () => {
    const next = withoutWall(held(), "lap");
    expect(Object.keys(next.walls)).toEqual(["desk"]);
    expect(Object.keys(next.heardAt)).toEqual(["desk"]);
    expect(next.roster.map((r) => r.host)).toEqual(["me", "desk"]);
  });

  test("leaves the input alone, so a reader is told by an assignment", () => {
    const before = held();
    withoutWall(before, "lap");
    expect(Object.keys(before.walls)).toEqual(["lap", "desk"]);
  });

  test("answers the same objects for a wall that was never drawn", () => {
    const before = held();
    const next = withoutWall(before, "stranger");
    expect(next.walls).toBe(before.walls);
    expect(next.heardAt).toBe(before.heardAt);
    expect(next.roster).toBe(before.roster);
  });

  test("this wall leaving takes every other wall with it", () => {
    const next = withoutWall(held(), null);
    expect(next.walls).toEqual({});
    expect(next.heardAt).toEqual({});
    expect(next.roster).toEqual([]);
    /* And leaving with nothing drawn costs no redraw. */
    const empty = { walls: {}, heardAt: {}, roster: [] as { host: string }[] };
    expect(withoutWall(empty, null).walls).toBe(empty.walls);
  });
});
