import { describe, expect, test } from "bun:test";
import {
  carry,
  certain,
  dispositionOf,
  hear,
  IMMEDIATE,
  matchCards,
  payloadIn,
  planOf,
  resolveCard,
  resolveCards,
  resolveFile,
  resolveTerritory,
  spelt,
  spoke,
  spoken,
  territoriesIn,
  uncarriable,
  type Hands,
} from "../src/lib/voice";
import { CARDS, CASES, FOCUSED, TERRITORIES, WALL } from "./fixtures/wall";

const caravan = TERRITORIES[0].files;
const volery = TERRITORIES[1].files;

describe("spoken separators", () => {
  test("a word becomes the character it names", () => {
    expect(spoken("image dot png")).toBe("image.png");
    expect(spoken("docs slash voice dot md")).toBe("docs/voice.md");
    expect(spoken("my under score file")).toBe("my_file");
    expect(spoken("tokens dash two dot css")).toBe("tokens-two.css");
  });

  test("a spelled-out extension is glued before the separators are", () => {
    /* The order matters and it is the only reason this is not two lines: glue
       the dot first and "image dot p n g" becomes "image.p n g". */
    expect(spoken("image dot p n g")).toBe("image.png");
    expect(spoken("readme dot m d")).toBe("readme.md");
  });

  test("a single letter on its own is left alone", () => {
    expect(spoken("a dot ts")).toBe("a.ts");
  });

  test("case goes, because a mouth has none", () => {
    expect(spoken("Docs Slash VOICE dot MD")).toBe("docs/voice.md");
  });

  test("source is spelled src, and only as an alternative", () => {
    expect(spelt("source/lib/limits.ts")).toBe("src/lib/limits.ts");
    expect(spelt("src/lib/limits.ts")).toBe("src/lib/limits.ts");
    /* Not a word substitution anywhere but a whole path segment. */
    expect(spelt("resource/x.ts")).toBe("resource/x.ts");
  });
});

describe("matchCards — the ladder the control surface already uses", () => {
  test("an id wins first", () => {
    expect(matchCards(CARDS, "c5", null)).toEqual({ by: "id", cards: [CARDS[4]] });
  });

  test("an exact title beats a title that merely contains it", () => {
    const m = matchCards(CARDS, "the ring", null);
    expect(m?.by).toBe("title");
    expect(m?.cards.map((c) => c.id)).toEqual(["c5"]);
  });

  test("exact but for case is its own rung, above the substring one", () => {
    const m = matchCards(CARDS, "The Ring", null);
    expect(m?.by).toBe("spoken");
    expect(m?.cards.map((c) => c.id)).toEqual(["c5"]);
  });

  test("a substring returns every card at that rung, not the first", () => {
    const m = matchCards(CARDS, "ring", null);
    expect(m?.by).toBe("partial");
    expect(m?.cards.map((c) => c.id)).toEqual(["c4", "c5"]);
  });

  test("nothing said means the focused card", () => {
    expect(matchCards(CARDS, null, FOCUSED)).toEqual({ by: "focused", cards: [CARDS[5]] });
    expect(matchCards(CARDS, undefined, null)).toBeNull();
  });

  test("a number indexes the wall from zero, as it always has", () => {
    expect(matchCards(CARDS, 0, null)?.cards[0].id).toBe("c1");
    expect(matchCards(CARDS, 99, null)).toBeNull();
  });

  test("no rung at all is null", () => {
    expect(matchCards(CARDS, "the deployment work", null)).toBeNull();
  });
});

describe("resolveCard — the same ladder, trusted less", () => {
  test("an exact title is certain", () => {
    expect(certain(resolveCard(WALL, "sink triage"))?.id).toBe("c6");
  });

  test("a fragment picks the best match, which is the whole point of it", () => {
    /* You should not have to recite a twenty-eight-character title without a
       slip. This is the behaviour that replaced an exact-only resolver, on the
       argument that the confirm gate — not the resolver — is what carries the
       risk: the ops a card can reach without being asked are all in
       `IMMEDIATE`, and every one of them only changes how you look at the
       wall. */
    expect(certain(resolveCard(WALL, "auth"))?.id).toBe("c1");
    expect(certain(resolveCard(WALL, "onboarding"))?.id).toBe("c2");
    expect(certain(resolveCard(WALL, "ring occupancy"))?.id).toBe("c4");
    expect(certain(resolveCard(WALL, "triage"))?.id).toBe("c6");
  });

  test("an exact title still beats a fragment of a longer one", () => {
    /* The half of the old strictness worth keeping. `the ring` is an identity
       and is settled before anything is scored, so it can never lose to
       `fixing the ring occupancy bug` on a tiebreak. */
    expect(certain(resolveCard(WALL, "the ring"))?.id).toBe("c5");
  });

  test("a territory's name resolves to the card that resembles it", () => {
    /* The trade this change accepted, stated as a test so it is a decision and
       not a surprise: `caravan` is a territory *and* a fragment of exactly one
       card's title, and best-match now takes the card. Harmless where it
       lands — `select` is immediate and visible — and the alternative was
       refusing every abbreviation on the wall. */
    expect(certain(resolveCard(WALL, "caravan"))?.id).toBe("c2");
  });

  test("a word that names nothing on the wall stays missing", () => {
    /* "Never invent a referent" survives fuzzy matching, and this is what keeps
       it: `score()` answers null unless the query is a *subsequence* of the
       title, so unrelated words resolve to nothing rather than to the least-bad
       card in the room. */
    expect(resolveCard(WALL, "the deployment work").kind).toBe("missing");
    expect(resolveCard(WALL, "everything").kind).toBe("missing");
    expect(resolveCard(WALL, "zebra").kind).toBe("missing");
  });

  test("the noun the gesture is about is not the name of anything", () => {
    /* Found by utterance 19 the moment fuzzy went in: `card` is a subsequence
       of `caravan onboarding copy` — c, a, r, then the d in "onboarding" — so
       "select card" silently gathered a card. A filler word has to be refused
       explicitly, because the scorer will otherwise find it. */
    for (const filler of ["card", "the card", "this card", "this one", "conversation"]) {
      expect([filler, resolveCard(WALL, filler).kind]).toEqual([filler, "missing"]);
    }
  });

  test("a query too short to discriminate does not get to answer", () => {
    /* A length, not a score threshold. One or two characters are a subsequence
       of very nearly every title on any wall, so the ranking would carry no
       information — that is a claim about what the input can determine, which
       is a fair thing to write a constant about. An exact title of any length
       is unaffected, being settled before anything is scored. */
    expect(certain(resolveCard(WALL, "t"))).toBeNull();
    expect(certain(resolveCard(WALL, "th"))).toBeNull();
  });

  test("a genuine tie asks rather than tossing a coin", () => {
    const twins = [
      { id: "a", title: "alpha work", project: "x", working: false },
      { id: "b", title: "alpha work", project: "y", working: false },
    ];
    const r = resolveCard({ ...WALL, cards: twins }, "alpha");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.among.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("two cards at a trusted rung are ambiguous", () => {
    const twins = [
      { id: "a", title: "the ring", project: "x", working: false },
      { id: "b", title: "the ring", project: "y", working: false },
    ];
    const r = resolveCard({ ...WALL, cards: twins }, "the ring");
    expect(r.kind).toBe("ambiguous");
  });

  test("a name nobody here has is missing, which is a different thing to say", () => {
    expect(resolveCard(WALL, "the deployment work").kind).toBe("missing");
  });

  test("a spoken list splits on commas and on and", () => {
    const r = resolveCards(WALL, "the auth work, sink triage and the ring");
    expect(r.map((x) => certain(x)?.id)).toEqual(["c1", "c6", "c5"]);
  });

  test("a list with a clause in it fails as a list, rather than dropping the clause", () => {
    const r = resolveCards(WALL, "the ring and fit the wall");
    expect(r.map(certain)).toEqual([CARDS[4], null]);
  });
});

describe("resolveTerritory", () => {
  test("by folder name, with the decoration taken off", () => {
    expect(certain(resolveTerritory(WALL, "caravan"))?.cwd).toBe("C:/work/caravan");
    expect(certain(resolveTerritory(WALL, "project caravan"))?.project).toBe("caravan");
    expect(certain(resolveTerritory(WALL, "the orchard repo"))).toBeNull();
    expect(certain(resolveTerritory(WALL, "repository orchard"))?.project).toBe("orchard");
  });

  test("volery is the folder called skein, which is the rename", () => {
    expect(certain(resolveTerritory(WALL, "volery"))?.cwd).toBe("C:/atelier/skein");
  });

  test("an unknown name is missing", () => {
    expect(resolveTerritory(WALL, "westmarch").kind).toBe("missing");
  });
});

describe("resolveFile — three rungs and no threshold", () => {
  test("a basename that is what you said, past a near-miss sibling", () => {
    expect(certain(resolveFile(caravan, "image dot png"))).toBe("src/assets/image.png");
  });

  test("a basename that only contains it is ambiguous, not a guess", () => {
    const r = resolveFile(caravan, "image");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.among).toEqual(["src/assets/image.png", "src/assets/image@2x.png"]);
    }
  });

  test("the directory narrows it, in the order it was said", () => {
    expect(certain(resolveFile(volery, "docs slash voice dot md"))).toBe("docs/VOICE.md");
    expect(certain(resolveFile(volery, "src slash lib slash limits dot ts"))).toBe(
      "src/lib/limits.ts",
    );
  });

  test("source is tried as src, and the exact rung is reached on the substitution", () => {
    expect(certain(resolveFile(volery, "source slash lib slash limits dot ts"))).toBe(
      "src/lib/limits.ts",
    );
  });

  test("a file that is not in this territory is missing, and offers nothing", () => {
    expect(resolveFile(caravan, "budget dot xlsx").kind).toBe("missing");
  });

  test("the loose rung never picks — it only furnishes the question", () => {
    /* `mn` is a subsequence of `src/main.ts` and of nothing else here, so the
       scorer has a clear winner. It still does not get to answer. */
    const r = resolveFile(caravan, "mn");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.among.length).toBeGreaterThan(0);
  });
});

describe("payloadIn — the boundary the grammar refuses to cross", () => {
  test("a colon, and the head kept apart from the words", () => {
    expect(payloadIn("send the auth work: halt work")).toEqual({
      head: "send the auth work",
      payload: "halt work",
    });
  });

  test("the spoken markers", () => {
    expect(payloadIn("send halt work draft a message saying we are done here")?.payload).toBe(
      "we are done here",
    );
    expect(payloadIn("post a notice that says leave markdown alone")?.payload).toBe(
      "leave markdown alone",
    );
  });

  test("the earliest marker wins, so the payload keeps everything after it", () => {
    expect(payloadIn("tell it saying a: b")?.payload).toBe("a: b");
  });

  test("no marker is null, and that is the only answer the grammar reads", () => {
    expect(payloadIn("select the auth work")).toBeNull();
  });
});

describe("disposition — the complement of the undo stack", () => {
  test("looking at the wall is free", () => {
    expect(dispositionOf(["select"])).toBe("nothing");
    expect(dispositionOf(["select", "find.lookAt", "viewport.fit"])).toBe("nothing");
  });

  test("the strictest step decides the whole plan", () => {
    expect(dispositionOf(["select", "send"])).toBe("confirmation");
    expect(dispositionOf(["send", "select"])).toBe("confirmation");
  });

  test("an op nobody has classified confirms", () => {
    /* The property that matters more than any entry in the set: somebody will
       add an op and not read this file. */
    expect(dispositionOf(["obliterate"])).toBe("confirmation");
  });

  test("nothing at all changes nothing", () => {
    expect(dispositionOf([])).toBe("nothing");
  });

  test("stop is deliberately outside the set", () => {
    expect(IMMEDIATE.has("stop")).toBe(false);
    expect(dispositionOf(["stop"])).toBe("confirmation");
  });
});

describe("planOf — the one way a plan is made", () => {
  test("reads is templated from the steps in the order they were said", () => {
    const p = planOf([
      { op: "select", args: {}, said: "select the ring" },
      { op: "viewport.fit", args: {}, said: "fit the wall" },
    ]);
    expect(p.reads).toBe("select the ring, then fit the wall");
    expect(p.needs).toBe("nothing");
  });

  test("an empty plan reads as nothing rather than as an empty string", () => {
    expect(planOf([]).reads).toBe("nothing");
  });
});

describe("hear — the grammar rung", () => {
  const plan = (say: string) => hear(say, WALL);

  test("the gestures that must be instant", () => {
    expect(plan("deselect")?.steps).toEqual([{ op: "deselect", args: {}, said: "deselect" }]);
    expect(plan("fit the wall")?.steps[0].op).toBe("viewport.fit");
    expect(plan("select the auth work")?.steps[0].args).toEqual({ cards: ["c1"] });
    expect(plan("show me the ring")?.steps[0]).toEqual({
      op: "focus",
      args: { card: "c5" },
      said: "focus the ring",
    });
  });

  test("one verb, several referents, one step", () => {
    const p = plan("select the auth work, sink triage and the ring");
    expect(p?.steps).toHaveLength(1);
    expect(p?.steps[0].args).toEqual({ cards: ["c1", "c6", "c5"] });
    expect(p?.reads).toBe("select the auth work and sink triage and the ring");
  });

  test("aside is a circumfix, and its two directions are one entry apiece", () => {
    expect(plan("put sink triage aside")?.steps[0]).toEqual({
      op: "aside",
      args: { card: "c6", aside: true },
      said: "put aside sink triage",
    });
    expect(plan("pick up sink triage")?.steps[0].args).toEqual({ card: "c6", aside: false });
    /* Without the trailing word it is not an instruction at all. */
    expect(plan("put sink triage")).toBeNull();
  });

  test("the longer verb phrase wins, so a territory is not read as a filename", () => {
    expect(plan("open a card in project caravan")?.steps[0]).toEqual({
      op: "open",
      args: { project: "caravan", cwd: "C:/work/caravan" },
      said: "open a card in caravan",
    });
  });

  test("a file in a territory, said out loud", () => {
    expect(plan("open image dot png in caravan")?.steps[0].args).toEqual({
      project: "caravan",
      cwd: "C:/work/caravan",
      path: "src/assets/image.png",
    });
    expect(plan("open source slash lib slash limits dot ts in volery")?.steps[0].args).toEqual({
      project: "volery",
      cwd: "C:/atelier/skein",
      path: "src/lib/limits.ts",
    });
  });

  test("stop is understood instantly and still confirms", () => {
    const p = plan("stop the auth work");
    expect(p?.steps[0]).toEqual({ op: "stop", args: { card: "c1" }, said: "stop the auth work" });
    expect(p?.needs).toBe("confirmation");
  });

  test("a bare stop means the card in front", () => {
    expect(plan("stop")?.steps[0].args).toEqual({ card: FOCUSED });
  });
});

describe("hear — every way it refuses, which is the safety property", () => {
  const refuses = (say: string) => expect(hear(say, WALL)).toBeNull();

  test("leftover words are not a match, however good the head looks", () => {
    /* `resolveCommand`'s exact-and-whole rule, one layer up: reading `select the
       auth work` out of this would throw away half a sentence, silently. */
    refuses("select the auth work and open image dot png in caravan");
    refuses("fit the wall then select the ring");
    refuses("open image dot png in caravan then select the auth work");
  });

  test("anything carrying prose is the steward's", () => {
    refuses("select the auth work: halt work");
    refuses("send halt work draft a message saying we are done here");
    refuses("tell everyone to halt work");
  });

  test("a referent it is not certain of", () => {
    /* `select caravan` is deliberately absent — it resolves now, by best match.
       See the resolver's own tests above. */
    refuses("select the deployment work");
    refuses("select card");
    refuses("open in caravan");
    refuses("open budget dot xlsx in caravan");
    refuses("stop everything");
  });

  test("a remark, a question, and prose that opens with no verb at all", () => {
    refuses("the context ring pegs at a hundred percent and I cannot see why");
    refuses("I was thinking we should open a card for the orchard migration at some point");
    refuses("what is sink triage doing?");
  });

  test("a verb that is also a common word does not fire on it", () => {
    /* `set` opens the aside entry; a timer is not a card being put by. */
    refuses("set a timer for twenty five minutes");
  });

  test("nothing said is nothing meant", () => {
    refuses("");
    refuses("   ");
  });
});

/* ── the grammar, scored against the wall the steward was scored against ──────
 *
 * `tools/probe-steward.ts` runs these same thirty utterances past a model and
 * grades the reply. This grades the rung below it against the same fixture, and
 * the two claims it makes are the ones the ladder rests on:
 *
 *   1. **Whatever the grammar answers is right.** Not "mostly right" — the whole
 *      argument for stacking a rigid rung on top of a model is that the rigid one
 *      cannot half-understand, so anything it does answer needs no checking.
 *   2. **It never answers a remark or a question.** The same headline the probe
 *      prints, and the one that would matter most if it stopped being true.
 */
describe("the thirty utterances", () => {
  const answered = CASES.filter((c) => hear(c.say, WALL) !== null);

  test("nothing it answers is wrong", () => {
    for (const c of CASES) {
      const p = hear(c.say, WALL);
      if (!p) continue;
      /* Compared as a pair with the utterance in it, so a failure names the
         sentence rather than making somebody count down a list of thirty. */
      const line = `${c.id}: ${c.say}`;
      const ops = p.steps.map((s) => s.op);
      const want = [c.ops, c.also?.ops].filter(Boolean) as string[][];
      expect([line, ops]).toEqual([line, want.find((w) => w.join() === ops.join()) ?? want[0] ?? []]);

      const args = JSON.stringify(p.steps.map((s) => s.args));
      for (const ref of c.refs ?? []) expect([line, ref, args.includes(ref)]).toEqual([line, ref, true]);

      expect([line, p.needs]).toEqual([line, dispositionOf(ops)]);
    }
  });

  test("it answers none of the remarks and none of the questions", () => {
    const acted = CASES.filter(
      (c) => (c.want === "decline" || c.want === "question") && hear(c.say, WALL) !== null,
    );
    expect(acted.map((c) => c.id)).toEqual([]);
  });

  test("it answers none of the utterances that should ask", () => {
    /* An `ask` case is one where the right answer is a question. The grammar has
       no way to ask, so its only correct move is to escalate — a plan here would
       be a guess dressed as certainty. */
    const guessed = CASES.filter(
      /* `also` is what makes this honest. Two of the fixture's `ask` cases have
         a second defensible reading written down beside them — "select caravan"
         and "open in caravan" — and answering one of *those* is not a guess, it
         is the alternative the fixture already sanctions. Scoring it as a
         failure would make the grammar look reckless for doing the thing the
         case says is acceptable. */
      (c) => c.want === "ask" && !c.also && hear(c.say, WALL) !== null,
    );
    expect(guessed.map((c) => c.id)).toEqual([]);
  });

  test("and it covers the eight it is meant to", () => {
    /* Pinned so a change in coverage is a thing somebody decided rather than a
       thing that happened. Every one of these is a gesture whose whole value is
       being instant; everything else on the list costs a round trip on purpose. */
    expect(answered.map((c) => c.id)).toEqual([1, 3, 5, 11, 12, 14, 15, 23, 26]);
  });
});

describe("territoriesIn — what to have a file list for before parsing", () => {
  test("names the territories an utterance mentions", () => {
    expect(territoriesIn("open image dot png in caravan", WALL).map((t) => t.project)).toEqual([
      "caravan",
    ]);
    expect(
      territoriesIn("open a card in volery and one in orchard", WALL).map((t) => t.project),
    ).toEqual(["volery", "orchard"]);
  });

  test("whole words, so a territory is not found inside another word", () => {
    expect(territoriesIn("select the caravanserai work", WALL)).toEqual([]);
  });

  test("trailing punctuation does not hide the last word", () => {
    expect(territoriesIn("open a card in caravan.", WALL).map((t) => t.project)).toEqual([
      "caravan",
    ]);
  });

  test("nothing named is nothing to fetch", () => {
    expect(territoriesIn("select the auth work", WALL)).toEqual([]);
  });
});

/** A pair of hands that only writes down what it was asked to do. */
function stub(fails?: { op: string; why: string }) {
  const log: string[] = [];
  const note = (line: string) => {
    if (fails && line.startsWith(fails.op)) throw new Error(fails.why);
    log.push(line);
  };
  const hands: Hands = {
    focus: (c) => note(`focus ${c}`),
    select: (cs) => note(`select ${cs.join("+")}`),
    deselect: () => note("deselect"),
    fit: () => note("fit"),
    stop: (c) => note(`stop ${c}`),
    aside: (c, a) => note(`aside ${c} ${a}`),
    open: (cwd) => note(`open ${cwd}`),
    lookAt: (cwd, p) => note(`lookAt ${cwd} ${p}`),
  };
  return { hands, log };
}

describe("carry — the plan, in order, or not at all", () => {
  test("every step, in the order it was said", async () => {
    const { hands, log } = stub();
    const plan = planOf([
      { op: "select", args: { cards: ["c1", "c5"] }, said: "select two" },
      { op: "find.lookAt", args: { cwd: "C:/work/caravan", path: "a.png" }, said: "open a.png" },
      { op: "viewport.fit", args: {}, said: "fit the wall" },
    ]);
    expect(await carry(plan, hands)).toEqual({ kind: "done", ran: 3 });
    expect(log).toEqual(["select c1+c5", "lookAt C:/work/caravan a.png", "fit"]);
  });

  test("an op nothing can carry refuses the whole plan before anything runs", async () => {
    /* Knowable in advance, so it is knowable *instead of* leaving the wall half
       moved. This is the half of no-half-execution that costs nothing. */
    const { hands, log } = stub();
    const plan = planOf([
      { op: "select", args: { cards: ["c1"] }, said: "select the auth work" },
      { op: "sink.add", args: {}, said: "file a finding" },
    ]);
    expect(await carry(plan, hands)).toEqual({
      kind: "refused",
      why: "nothing here can sink.add",
    });
    expect(log).toEqual([]);
  });

  test("a step that fails stops the walk and says which one", async () => {
    const { hands, log } = stub({ op: "stop", why: "that card has gone" });
    const step = { op: "stop", args: { card: "c1" }, said: "stop the auth work" };
    const plan = planOf([
      { op: "select", args: { cards: ["c5"] }, said: "select the ring" },
      step,
      { op: "viewport.fit", args: {}, said: "fit the wall" },
    ]);
    expect(await carry(plan, hands)).toEqual({
      kind: "stopped",
      at: 1,
      step,
      why: "that card has gone",
    });
    /* And in particular it did not go on to fit the wall. */
    expect(log).toEqual(["select c5"]);
  });

  test("aside defaults to putting by, and only an explicit false picks up", async () => {
    const { hands, log } = stub();
    await carry(planOf([{ op: "aside", args: { card: "c6" }, said: "put aside" }]), hands);
    await carry(
      planOf([{ op: "aside", args: { card: "c6", aside: false }, said: "pick up" }]),
      hands,
    );
    expect(log).toEqual(["aside c6 true", "aside c6 false"]);
  });

  test("every op the grammar can produce has a pair of hands for it", () => {
    /* The claim that makes `refused` a real answer rather than a dead branch:
       nothing the fast rung emits may ever be un-carriable, because the fast
       rung is the one that runs without asking. */
    for (const c of CASES) {
      const p = hear(c.say, WALL);
      if (p) expect([c.id, uncarriable(p)]).toEqual([c.id, []]);
    }
  });

  test("an empty plan is done, having done nothing", async () => {
    const { hands, log } = stub();
    expect(await carry(planOf([]), hands)).toEqual({ kind: "done", ran: 0 });
    expect(log).toEqual([]);
  });
});

describe("spoke — what the wall says afterwards", () => {
  test("success says nothing, because you are looking at the wall", () => {
    expect(spoke({ kind: "done", ran: 3 })).toBe("");
  });

  test("a refusal always speaks, since nothing visibly happened", () => {
    expect(spoke({ kind: "refused", why: "nothing here can post" })).toBe(
      "nothing happened — nothing here can post",
    );
  });

  test("a plan stopped partway says how far it got and where it stuck", () => {
    const step = { op: "stop", args: {}, said: "stop the auth work" };
    expect(spoke({ kind: "stopped", at: 2, step, why: "that card has gone" })).toBe(
      '2 done, then stopped at "stop the auth work" — that card has gone',
    );
  });

  test("stopping on the first step is the same as nothing happening", () => {
    const step = { op: "stop", args: {}, said: "stop the auth work" };
    expect(spoke({ kind: "stopped", at: 0, step, why: "that card has gone" })).toBe(
      "nothing happened — that card has gone",
    );
  });
});
