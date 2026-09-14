import { describe, expect, test } from "bun:test";
import {
  inSight,
  narrow,
  replyIn,
  stewardPrompt,
  understand,
  unwired,
  VOCABULARY,
  working,
  type Reply,
} from "../src/lib/steward";
import { planOf, uncarriable } from "../src/lib/voice";
import { CASES, WALL } from "./fixtures/wall";

/** A reply with only the field under test filled in. */
const reply = (over: Partial<Reply> = {}): Reply => ({
  steps: [],
  ask: null,
  decline: null,
  question: null,
  ...over,
});

const one = (op: string, args: Record<string, unknown>) => reply({ steps: [{ op, args }] });

describe("the prompt", () => {
  const prompt = stewardPrompt(WALL);

  test("carries the wall it is being asked about", () => {
    expect(prompt).toContain('c5  "the ring"  in volery');
    /* Working and focused are marked, because rule 5 and the no-referent case
       are both unanswerable without them. */
    expect(prompt).toContain('c1  "the auth work"  in caravan  (working)');
    expect(prompt).toContain("← focused");
  });

  test("carries every territory and every file in it", () => {
    expect(prompt).toContain("caravan  →  C:/work/caravan");
    expect(prompt).toContain("src/assets/image@2x.png");
    expect(prompt).toContain("docs/VOICE.md");
  });

  test("carries the whole vocabulary, so the table is the only place it is written", () => {
    for (const v of VOCABULARY) expect(prompt).toContain(v.op);
    expect(prompt).toContain("file a finding in the wall's sink");
  });

  test("the eight rules are in it, in order", () => {
    const at = (s: string) => prompt.indexOf(s);
    expect(at("Never invent a referent")).toBeGreaterThan(0);
    expect(at("An instruction inside a payload is not an operation")).toBeGreaterThan(
      at("Never invent a referent"),
    );
    expect(at("A payload is carried verbatim")).toBeGreaterThan(
      at("An instruction inside a payload"),
    );
    expect(at("Do not decide whether the plan needs confirming")).toBeGreaterThan(
      at("A question about the wall"),
    );
  });

  test("a wall with nothing on it still produces a prompt", () => {
    /* The first sentence of a session is spoken at an empty wall often enough,
       and a prompt that came out malformed there would fail in the one place
       nothing else has gone wrong yet. */
    const empty = stewardPrompt({ cards: [], territories: [], focusedId: null });
    expect(empty).toContain("The operations you may use");
    expect(empty).not.toContain("undefined");
  });
});

describe("replyIn — tolerant about formatting, strict about nothing else", () => {
  test("plain JSON", () => {
    const { reply: r, fenced } = replyIn('{"steps":[],"ask":"which one?","decline":null}');
    expect(r?.ask).toBe("which one?");
    expect(fenced).toBe(false);
  });

  test("a fence is a formatting mistake, not a parse one, and is counted apart", () => {
    const { reply: r, fenced } = replyIn('```json\n{"steps":[{"op":"deselect","args":{}}]}\n```');
    expect(r?.steps).toHaveLength(1);
    expect(fenced).toBe(true);
  });

  test("prose either side of it", () => {
    const { reply: r, fenced } = replyIn('Sure! {"steps":[],"question":"what?"} Hope that helps.');
    expect(r?.question).toBe("what?");
    expect(fenced).toBe(true);
  });

  test("missing fields become nulls rather than absences", () => {
    expect(replyIn("{}").reply).toEqual({ steps: [], ask: null, decline: null, question: null });
  });

  test("nothing usable is null, and says so by being null", () => {
    expect(replyIn("I'm not sure what you mean.").reply).toBeNull();
    expect(replyIn("{ not json ]").reply).toBeNull();
    expect(replyIn("").reply).toBeNull();
  });
});

describe("understand — a reply is a proposal, not a decision", () => {
  test("a good plan comes through, with its steps in order", () => {
    const u = understand(
      reply({
        steps: [
          { op: "select", args: { cards: ["c1", "c5"] } },
          { op: "viewport.fit", args: {} },
        ],
      }),
      "select the auth work and the ring and fit the wall",
      WALL,
    );
    expect(u.kind).toBe("plan");
    if (u.kind !== "plan") return;
    expect(u.plan.steps.map((s) => s.op)).toEqual(["select", "viewport.fit"]);
    expect(u.plan.needs).toBe("nothing");
  });

  test("the field that does nothing wins a contradiction", () => {
    /* A model that both proposed steps and filled in `decline` has given two
       answers. Acting on a remark is the worst failure available; declining a
       real instruction costs you saying it again. */
    const u = understand(
      reply({ steps: [{ op: "open", args: { project: "orchard" } }], decline: "only a remark" }),
      "we should open a card for the orchard migration at some point",
      WALL,
    );
    expect(u).toEqual({ kind: "decline", why: "only a remark" });
  });

  test("a question outranks an ask, and both outrank steps", () => {
    expect(understand(reply({ question: "it is idle" }), "x", WALL).kind).toBe("question");
    expect(understand(reply({ ask: "which one?" }), "x", WALL).kind).toBe("ask");
  });

  test("nothing at all is unusable rather than an empty plan", () => {
    expect(understand(reply(), "x", WALL)).toEqual({
      kind: "unusable",
      why: "a reply with nothing in it",
    });
    expect(understand(null, "x", WALL).kind).toBe("unusable");
  });
});

describe("understand — every referent re-checked against the wall", () => {
  test("a card that is not on the wall is an invention, not a near miss", () => {
    const u = understand(one("focus", { card: "c99" }), "focus that one", WALL);
    expect(u).toEqual({ kind: "unusable", why: 'no card "c99" on this wall' });
  });

  test("a card named by its title is the one rule of the prompt not being followed", () => {
    /* And so it fails rather than being resolved. Resolving it would hide the
       thing worth knowing: the model was handed the ids. */
    const u = understand(one("focus", { card: "the ring" }), "focus the ring", WALL);
    expect(u.kind).toBe("unusable");
  });

  test("one bad id in a list of good ones fails the whole plan", () => {
    const u = understand(
      one("select", { cards: ["c1", "c99"] }),
      "select the auth work and that other one",
      WALL,
    );
    expect(u.kind).toBe("unusable");
  });

  test("an operation nobody has heard of", () => {
    const u = understand(one("obliterate", { card: "c1" }), "obliterate the auth work", WALL);
    expect(u).toEqual({ kind: "unusable", why: 'no such operation as "obliterate"' });
  });

  test("a territory resolves to its name and its root together", () => {
    const u = understand(one("open", { project: "caravan" }), "open a card in caravan", WALL);
    if (u.kind !== "plan") throw new Error(u.kind);
    expect(u.plan.steps[0].args).toEqual({ project: "caravan", cwd: "C:/work/caravan" });
  });

  test("a territory that is not here", () => {
    expect(understand(one("open", { project: "westmarch" }), "open one in westmarch", WALL).kind).toBe(
      "unusable",
    );
  });

  test("a path is checked for membership, never scored", () => {
    const ok = understand(
      one("find.lookAt", { project: "caravan", path: "src/assets/image.png" }),
      "open image dot png in caravan",
      WALL,
    );
    expect(ok.kind).toBe("plan");

    /* Plausible, adjacent, and not in the list that was in the prompt. */
    const no = understand(
      one("find.lookAt", { project: "caravan", path: "src/assets/image.jpg" }),
      "open image dot png in caravan",
      WALL,
    );
    expect(no).toEqual({
      kind: "unusable",
      why: 'no file "src/assets/image.jpg" in caravan',
    });
  });

  test("a path from the wrong territory does not pass by being a real file", () => {
    const u = understand(
      one("find.lookAt", { project: "caravan", path: "docs/VOICE.md" }),
      "open voice dot md in caravan",
      WALL,
    );
    expect(u.kind).toBe("unusable");
  });

  test("a path with no territory to find it in", () => {
    expect(understand(one("find.lookAt", { path: "src/main.ts" }), "open main", WALL).kind).toBe(
      "unusable",
    );
  });
});

describe("understand — a payload is the words that were said", () => {
  const say = "tell the auth work to halt work";

  test("carried verbatim, and case and spacing are the only slack", () => {
    expect(understand(one("send", { card: "c1", text: "halt work" }), say, WALL).kind).toBe("plan");
    expect(understand(one("send", { card: "c1", text: "Halt   work" }), say, WALL).kind).toBe(
      "plan",
    );
    expect(understand(one("send", { card: "c1", text: "halt work." }), say, WALL).kind).toBe(
      "plan",
    );
  });

  test("a tidied message is a different message", () => {
    /* The failure this check exists for. A model asked to fill in a text field
       will improve prose given the slightest opening, and this one goes to a
       real agent under somebody else's name. */
    const u = understand(
      one("send", { card: "c1", text: "Please halt work when you can." }),
      say,
      WALL,
    );
    expect(u.kind).toBe("unusable");
    if (u.kind === "unusable") expect(u.why).toContain("words that were not said");
  });

  test("a word added or reordered fails", () => {
    for (const text of ["halt all work", "work halt", "halt the work"]) {
      expect([text, understand(one("send", { card: "c1", text }), say, WALL).kind]).toEqual([
        text,
        "unusable",
      ]);
    }
  });

  test("a word LEFT OUT does not, and that is the limit of a substring check", () => {
    /* "halt" is a substring of "…to halt work", so a truncated payload passes.
       Stated rather than fixed, because the fix is worse: catching it needs
       knowing where the payload ends, and a sentence can hold two payloads
       neither of which is at the end ("tell A to X and tell B to Y"), so there
       is no boundary to anchor on. `payloadIn` is the thing that would have to
       find it, and the whole design says that boundary is what a pattern is
       worst at.
       The asymmetry is the reason to accept it: truncation sends *fewer* of your
       words, never other people's. */
    expect(understand(one("send", { card: "c1", text: "halt" }), say, WALL).kind).toBe("plan");
  });

  test("a title is a summary, so composing one is allowed", () => {
    /* The distinction the table draws: a `body` is somebody's words being
       carried somewhere; a `title` is the model doing the useful thing. */
    const u = understand(
      one("sink.add", {
        project: "volery",
        title: "the context ring pegs at 100%",
        body: "I noticed an issue where the context ring pegs",
        kind: "bug",
      }),
      "record a sink item for volery: I noticed an issue where the context ring pegs",
      WALL,
    );
    expect(u.kind).toBe("plan");
  });

  test("but the body of the same step is not", () => {
    const u = understand(
      one("sink.add", {
        project: "volery",
        title: "a bug",
        body: "The context ring appears to peg at one hundred percent.",
        kind: "bug",
      }),
      "record a sink item for volery: the ring pegs",
      WALL,
    );
    expect(u.kind).toBe("unusable");
  });

  test("a rename carries what you said to call it", () => {
    expect(
      understand(
        one("rename", { card: "c6", title: "the voice work" }),
        "call this one the voice work",
        WALL,
      ).kind,
    ).toBe("plan");
    expect(
      understand(one("rename", { card: "c6", title: "Voice Work v2" }), "call this one the voice work", WALL)
        .kind,
    ).toBe("unusable");
  });
});

describe("understand — the fields it refuses to read", () => {
  test("said is discarded, and phraseOf decides how a step sounds", () => {
    const u = understand(
      reply({
        steps: [
          { op: "stop", args: { card: "c1" }, said: "terminating conversation c1 immediately" },
        ],
      }),
      "stop the auth work",
      WALL,
    );
    if (u.kind !== "plan") throw new Error(u.kind);
    expect(u.plan.steps[0].said).toBe("stop the auth work");
    expect(u.plan.reads).toBe("stop the auth work");
  });

  test("a volunteered needs is ignored, and the table decides", () => {
    const u = understand(
      /* A model that helpfully answered rule 8 anyway. */
      { ...one("stop", { card: "c1" }), needs: "nothing" } as unknown as Reply,
      "stop the auth work",
      WALL,
    );
    if (u.kind !== "plan") throw new Error(u.kind);
    expect(u.plan.needs).toBe("confirmation");
  });

  test("an arg the verb does not declare is dropped, not refused", () => {
    const u = understand(
      one("focus", { card: "c1", force: true, priority: 9 }),
      "focus the auth work",
      WALL,
    );
    if (u.kind !== "plan") throw new Error(u.kind);
    expect(u.plan.steps[0].args).toEqual({ card: "c1" });
  });
});

describe("understand — the small closed sets", () => {
  test("a sink kind is one of four", () => {
    const body = "the ring pegs";
    const say = "record a sink item for volery: the ring pegs";
    expect(
      understand(one("sink.add", { project: "volery", title: "t", body, kind: "bug" }), say, WALL)
        .kind,
    ).toBe("plan");
    expect(
      understand(
        one("sink.add", { project: "volery", title: "t", body, kind: "urgent" }),
        say,
        WALL,
      ).kind,
    ).toBe("unusable");
  });

  test("minutes is a positive number, however it arrived", () => {
    const say = "set a timer for twenty five minutes";
    const u = understand(one("timer.set", { minutes: "25" }), say, WALL);
    if (u.kind !== "plan") throw new Error(u.kind);
    expect(u.plan.steps[0].args.minutes).toBe(25);
    expect(understand(one("timer.set", { minutes: 0 }), say, WALL).kind).toBe("unusable");
    expect(understand(one("timer.set", { minutes: "soon" }), say, WALL).kind).toBe("unusable");
  });
});

describe("the vocabulary against what the wall can do", () => {
  test("it is wider than what can be run, and the gap is pinned", () => {
    /* Not a defect: narrowing the vocabulary to what is wired would have the
       model quietly re-plan a sentence into the ops it was allowed, and "close
       that card" answered by selecting it is worse than "nothing here can
       close". Pinned so wiring one is a decision somebody made.

       Two of them — `rename` and `timer.set` — are in `IMMEDIATE`, so a plan
       containing one is a plan that needs no confirmation and then cannot run.
       That reads as a contradiction and is not one: `carry` refuses before
       disposition is consulted at all, so the answer is "nothing here can
       rename" rather than a silent no-op.

       `send` and `broadcast` came off this list when the wall started
       listening, and not because they were cheap — they are the two most
       consequential ops here, and they were wired because *"caravan, halt
       work"* is the sentence the always-on channel exists for. Both are outside
       `IMMEDIATE`, so both are spoken back and confirmed before anything
       reaches an agent. */
    const carriable = (op: string) =>
      uncarriable(planOf([{ op, args: {}, said: "" }])).length === 0;
    expect(unwired(carriable)).toEqual([
      "chat",
      "rename",
      "clear",
      "close",
      "sink.add",
      "post",
      "timer.set",
      "answer",
    ]);
  });

  test("nothing that can be run is missing from the vocabulary", () => {
    /* The invariant that has to hold in this direction: a wired op the steward
       is never told about is a gesture only the grammar can reach, which is a
       silent hole rather than a refusal. */
    const named = new Set(VOCABULARY.map((v) => v.op));
    for (const op of ["focus", "select", "deselect", "viewport.fit", "stop", "aside", "open", "find.lookAt"]) {
      expect([op, named.has(op)]).toEqual([op, true]);
    }
  });
});

describe("working — the plural rule's own answer", () => {
  test("every card mid-turn, so a half-obeyed plural can be seen", () => {
    expect(working(WALL)).toEqual(["c1", "c4", "c7"]);
  });

  test("the fixture's own case says three, which is what makes 24 gradeable", () => {
    const stopEverything = CASES.find((c) => c.say === "stop everything");
    expect(stopEverything?.ops).toEqual(["stop", "stop", "stop"]);
    expect(stopEverything?.refs).toEqual(working(WALL));
  });
});

describe("the wall the steward is shown, cut to one sentence", () => {
  /** A tree big enough that sending it whole is the thing being avoided. */
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `src/lib/gen${String(i).padStart(4, "0")}.ts`);

  test("a territory small enough to send whole is not touched at all", () => {
    /* The property the narrowing rests on: everything the probe measured, and
       every real territory under the cap, reaches the model byte-identically.
       Same list, same order, same object's worth of truth. */
    const files = ["src/lib/markdown.ts", "docs/VOICE.md", "README.md"];
    expect(inSight(files, "open readme dot md", 60)).toEqual(files);
  });

  test("over the cap, the file that was named is in what is shown", () => {
    const files = [...many(500), "src/lib/markdown.ts"];
    const shown = inSight(files, "open markdown dot ts in volery", 10);
    /* Bounded, and it is the *candidates* that are bounded rather than a page of
       them: five hundred generated paths score nothing against this sentence, so
       one file comes back and it is the one that was said. */
    expect(shown.length).toBeLessThanOrEqual(10);
    expect(shown).toContain("src/lib/markdown.ts");
  });

  test("a spoken separator is resolved before anything is scored", () => {
    /* Precision is what it buys. Said as three words, "markdown" alone matches
       both of these; glued into `markdown.ts` it matches one, and the one it
       matches is the one that was said. */
    expect(inSight(["docs/markdown.md", "src/lib/markdown.ts"], "markdown dot ts", 1)).toEqual([
      "src/lib/markdown.ts",
    ]);
    /* And the substitution `spelt` exists for: a said "source" is `src/`, which
       no amount of scoring recovers — `src/lib/markdown.ts` has no `o` in it. */
    expect(
      inSight([...many(500), "src/lib/markdown.ts"], "source slash lib slash markdown", 3),
    ).toEqual(["src/lib/markdown.ts"]);
  });

  test("a sentence that could not be naming a file is shown none", () => {
    /* "stop the ring" is about a card, and no word of it is a subsequence of any
       path — so the honest shortlist is empty. Sixty arbitrary files here would
       be the same refusal with a decoy in front of it. */
    expect(inSight(many(5_000), "stop the ring", 20)).toEqual([]);
  });

  test("narrow cuts every territory and leaves the cards alone", () => {
    const wall = {
      ...WALL,
      territories: WALL.territories.map((t) => ({ ...t, files: [...many(200), ...t.files] })),
    };
    const seen = narrow(wall, "open voice dot md in volery", 5);
    expect(seen.cards).toEqual(wall.cards);
    for (const t of seen.territories) expect(t.files.length).toBeLessThanOrEqual(5);
  });

  test("and what it shows is what a reply is checked against", () => {
    /* The one thing that must not drift: `stewardPrompt` and `understand` read
       the same value, so a path the model was shown is a path it may name — and
       one it was not shown is refused rather than resolved. */
    const wall = {
      ...WALL,
      territories: WALL.territories.map((t) => ({
        ...t,
        files: [...many(300), ...t.files],
      })),
    };
    const seen = narrow(wall, "look at voice dot md in volery", 12);
    const shown = seen.territories.find((t) => t.project === "volery")!.files;
    expect(shown).toContain("docs/VOICE.md");
    expect(stewardPrompt(seen)).toContain("docs/VOICE.md");

    const got = understand(
      one("find.lookAt", { project: "volery", path: "docs/VOICE.md" }),
      "look at voice dot md in volery",
      seen,
    );
    expect(got.kind).toBe("plan");

    /* And a path that exists in the tree but was cut from the list is refused,
       because the model was never shown it — which is the direction this errs
       in everywhere else. */
    const cut = understand(
      one("find.lookAt", { project: "volery", path: "src/lib/gen0000.ts" }),
      "look at gen zero in volery",
      seen,
    );
    expect(cut.kind).toBe("unusable");
  });
});

describe("the shortlist against what a recogniser actually hands over", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => `src/lib/gen${String(i).padStart(4, "0")}.ts`);

  test("punctuation on a word does not cost the territory its whole list", () => {
    /* moonshine punctuates. `score` is a subsequence match, so a full stop the
       path does not have makes the word score nothing — and when *every* word
       scores nothing the territory is shown no files at all, which is not a
       shortlist missing one file, it is `understand` refusing a path that was
       right there after a request has been paid for. */
    const files = [...many(500), "src/lib/markdown.ts"];
    expect(inSight(files, "Volery, open markdown.ts.", 5)).toContain("src/lib/markdown.ts");
    expect(inSight(files, "volery, open markdown dot ts", 5)).toContain("src/lib/markdown.ts");
  });
});
