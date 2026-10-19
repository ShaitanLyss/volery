/* A question filed in one wall's pile, answered at another (sinks `52c0affa`,
 * `3368f78f`).
 *
 * Two walls simulated end to end through the pure halves of the path: the
 * owning wall ("desk") publishes its pile in a card's digest, the snapshot goes
 * over the wire as JSON, the wall she is at ("lap") reads it and draws the
 * question, composes the answer its pile would send, and names the row on the
 * prompt wire; the owning wall checks the row, claims it and only then hands it
 * on. The claim is a stand-in for `store::take_deferred_ask`, whose one property
 * — a row is taken once — is the whole of "no double answers". What only the
 * running app can show (the link, the panel) is the lab run in `away.md`. */

import { describe, expect, test } from "bun:test";
import {
  digestOf,
  readSnapshot,
  askHere,
  askedAt,
  FILED_CAP,
  FILED_BUDGET,
  type DigestSource,
} from "../src/lib/shadow";
import {
  PILE_AFAR_PREFIX,
  PILE_DROP,
  HELD_CAP,
  heldDue,
  pileAnswer,
  pileRefusal,
  readHeld,
  noticeOf,
  type HeldAnswer,
} from "../src/lib/afar";
import { answerEnvelope, pileOf, waitingCount, pileOpens, type Deferred } from "../src/lib/presence";
import { blankAnswers, normalizeAsk } from "../src/lib/asking";

function source(over: Partial<DigestSource> = {}): DigestSource {
  return {
    id: "c1",
    title: "release the fix",
    project: "nova",
    territory: "nova",
    kind: "project",
    tier: "rest",
    ending: "ok",
    dormant: true,
    working: false,
    aside: false,
    gear: "making",
    activity: "at rest",
    held: null,
    stalled: false,
    unacknowledged: false,
    restingSince: 1_000,
    ctx: 0.1,
    ctxTokens: 20_000,
    turns: 3,
    costUsd: 0.5,
    compactFrac: null,
    turnSince: null,
    holding: null,
    timeline: null,
    lines: [],
    jobs: [],
    pendingWakes: [],
    asks: [],
    ...over,
  };
}

/** The owning wall's pile, as `Presence.asks` holds it. */
function deskPile(): Deferred[] {
  const questions = normalizeAsk({
    question: "Open the release-fix PR now?",
    options: [
      { label: "open it", detail: "draft PR against main" },
      { label: "wait", detail: "hold until the build is green" },
    ],
  });
  return [
    { id: "row-1", conversationId: "c1", questions, answers: blankAnswers(questions), askedAt: 2_000 },
    {
      id: "row-2",
      conversationId: "c2",
      questions: normalizeAsk({ question: "Cancel the two PR builds?" }),
      answers: [null],
      askedAt: 2_500,
    },
  ];
}

/** `store::take_deferred_ask`: the row goes once. */
function claimer(pile: Deferred[]) {
  return (id: string) => {
    const i = pile.findIndex((d) => d.id === id);
    if (i < 0) return false;
    pile.splice(i, 1);
    return true;
  };
}

/** What crosses: the owning wall's snapshot of one card, through JSON. */
function overTheWire(pile: Deferred[], card = "c1") {
  const d = digestOf(source({ id: card, filed: pile.filter((a) => a.conversationId === card) }));
  const snap = readSnapshot(JSON.parse(JSON.stringify({ v: 1, at: 10_000, cards: [d] })));
  return snap!.cards[0]!;
}

describe("a filed question crosses to the wall she is at", () => {
  test("the owning wall publishes its pile, and the far wall reads it back", () => {
    const card = overTheWire(deskPile());
    expect(card.filed).toHaveLength(1);
    expect(card.filed[0]!.askId).toBe("row-1");
    expect(card.filed[0]!.since).toBe(2_000);
    expect(card.filed[0]!.questions[0]!.question).toBe("Open the release-fix PR now?");
    expect(card.filed[0]!.questions[0]!.options.map((o) => o.label)).toEqual(["open it", "wait"]);
    /* Filed questions are not parked ones: nothing here may be answered
       into a parked call. */
    expect(card.asks).toEqual([]);
  });

  test("an older owning wall sends no pile, which reads as unknown and not as empty", () => {
    const d = digestOf(source()) as unknown as Record<string, unknown>;
    delete d.filed;
    const snap = readSnapshot(JSON.parse(JSON.stringify({ v: 1, at: 1, cards: [d] })));
    expect(snap!.cards[0]!.filed).toBeNull();
  });

  /* A wall that has just started publishes its cards before it has read its
     pile. Read as empty, that snapshot would clear every far sheet and let go
     of every answer held for the wall — so it says unknown. */
  test("a pile not read yet travels as unknown; an empty one read as empty", () => {
    expect(digestOf(source({ filed: null })).filed).toBeNull();
    expect(digestOf(source({ filed: undefined })).filed).toBeNull();
    expect(digestOf(source({ filed: [] })).filed).toEqual([]);
    expect(overTheWire([], "c9").filed).toEqual([]);
  });

  test("a big pile stays inside its budget: the rest travels lean and is pulled whole", () => {
    const long = (i: number): Deferred => {
      const questions = normalizeAsk({
        question: `${i}: ` + "a long question ".repeat(100),
        options: Array.from({ length: 6 }, (_, j) => ({ label: `option ${j}`, detail: "detail ".repeat(40) })),
      });
      return { id: `r${i}`, conversationId: "c1", questions, answers: blankAnswers(questions), askedAt: i };
    };
    const filed = overTheWire(Array.from({ length: 8 }, (_, i) => long(i))).filed!;
    expect(filed).toHaveLength(8);
    expect(JSON.stringify(filed).length).toBeLessThan(FILED_BUDGET + 8 * 1_200);
    expect(filed[0]!.questions[0]!.shows).toBe(false);
    const lean = filed[7]!.questions[0]!;
    expect(lean.shows).toBe(true);
    expect(lean.options.map((o) => o.label)).toEqual(Array.from({ length: 6 }, (_, j) => `option ${j}`));
    expect(lean.options.every((o) => o.detail === null)).toBe(true);
  });

  test("the pile is bounded as the owning wall bounds it", () => {
    const many: Deferred[] = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      conversationId: "c1",
      questions: normalizeAsk({ question: `q${i}` }),
      answers: [null],
      askedAt: i,
    }));
    expect(overTheWire(many).filed).toHaveLength(FILED_CAP);
  });

  test("the answer sent from there is the answer the pile here would send", () => {
    const pile = deskPile();
    const here = pile[0]!;
    const far = overTheWire(pile).filed[0]!;
    const drawn = askHere(far, "desk");
    const since = askedAt(far, 10_000, 50_000);
    /* Same option, same lapse of time: the far wall's text is the local text. */
    const local = answerEnvelope(here.questions, ["open it"], 60_000);
    const remote = answerEnvelope(drawn, ["open it"], 60_000);
    expect(remote).toBe(local);
    expect(since).toBe(42_000);
  });

  test("its pile counts it, groups it under the card it came from, and opens on it", () => {
    const far = overTheWire(deskPile()).filed[0]!;
    const drawn = askHere(far, "desk");
    const afar: Deferred = {
      id: far.askId,
      conversationId: "elsewhere:desk:c1",
      questions: drawn,
      answers: blankAnswers(drawn),
      askedAt: 5_000,
      host: "desk",
    };
    expect(waitingCount([afar])).toBe(1);
    expect(pileOpens(false, [afar])).toBe(true);
    expect(pileOf([afar]).map((g) => g.conversationId)).toEqual(["elsewhere:desk:c1"]);
    /* Held for a quiet wall: drawn, and not counted — nothing waits on her. */
    expect(waitingCount([{ ...afar, held: true }])).toBe(0);
    expect(pileOpens(false, [{ ...afar, held: true }])).toBe(false);
  });
});

describe("the answer goes back and is taken once", () => {
  test("names the row with the prefix presence.rs reads, and is not a notice", async () => {
    const rs = await Bun.file(new URL("../src-tauri/src/presence.rs", import.meta.url)).text();
    expect(rs).toContain(`pub const AFAR_PREFIX: &str = "${PILE_AFAR_PREFIX}";`);
    expect(pileAnswer("row-1")).toBe("deferred:row-1");
    expect(noticeOf(pileAnswer("row-1"))).toBeNull();
  });

  test("the owning wall takes it, and a second wall's answer is refused", () => {
    const pile = deskPile();
    const claim = claimer(pile);
    /* From lap. */
    expect(pileRefusal(pile, "c1", "row-1", "desk")).toBeNull();
    expect(claim("row-1")).toBe(true);
    /* From a third wall, which drew the same question off the same snapshot. */
    const late = pileRefusal(pile, "c1", "row-1", "desk");
    expect(late).toContain("no longer waiting on desk");
    expect(claim("row-1")).toBe(false);
    /* And answered at the owning wall itself first: the same refusal. */
    const again = deskPile();
    claimer(again)("row-1");
    expect(pileRefusal(again, "c1", "row-1", "desk")).toContain("no longer waiting");
  });

  test("an answer addressed to the wrong card is refused, whatever the row", () => {
    expect(pileRefusal(deskPile(), "c1", "row-2", "desk")).toBe("that question belongs to another card on that wall");
  });

  test("once taken it leaves every wall's pile with the next snapshot", () => {
    const pile = deskPile();
    claimer(pile)("row-1");
    expect(overTheWire(pile).filed).toEqual([]);
  });

  test("not worth answering is a drop the owning wall recognises, not words for the card", () => {
    expect(PILE_DROP).toBe("not worth answering");
  });
});

describe("into a wall that is not heard from, the answer waits", () => {
  const held = (over: Partial<HeldAnswer> = {}): HeldAnswer => ({
    id: "p1",
    host: "desk",
    card: "c1",
    row: "row-1",
    text: "my answer",
    about: "release",
    at: 1,
    ...over,
  });

  test("and goes when that wall is heard again and still files the row", () => {
    const filed = new Set(["c1\nrow-1"]);
    const due = heldDue([held(), held({ id: "p2", host: "other" })], "desk", filed);
    expect(due.send.map((h) => h.id)).toEqual(["p1"]);
    expect(due.gone).toEqual([]);
  });

  test("and is let go, said, when the row was answered elsewhere meanwhile", () => {
    const pile = deskPile();
    claimer(pile)("row-1");
    const card = overTheWire(pile);
    const filed = new Set(card.filed.map((a) => `c1\n${a.askId}`));
    const due = heldDue([held()], "desk", filed);
    expect(due.send).toEqual([]);
    expect(due.gone.map((h) => h.id)).toEqual(["p1"]);
  });

  test("survives a restart of this wall: storage is read back, and a malformed row is not guessed at", () => {
    const kept = JSON.parse(JSON.stringify([held(), { ...held({ id: "x" }), text: "" }, { id: "y" }, held({ id: "dup" })]));
    const back = readHeld(kept);
    /* The empty answer and the half row are dropped; a second answer to the
       same row is one answer. */
    expect(back.map((h) => h.id)).toEqual(["p1"]);
    expect(readHeld("nonsense")).toEqual([]);
    expect(readHeld(Array.from({ length: 200 }, (_, i) => held({ id: `p${i}`, row: `r${i}` })))).toHaveLength(HELD_CAP);
  });
});
