import { describe, expect, test } from "bun:test";

import {
  actVerb,
  answerEnvelope,
  gateOnReturn,
  GATE_AFTER_MS,
  isAwayScreen,
  lasted,
  pileOf,
  pileOpens,
  stood,
  waitingCount,
  type Act,
  type Deferred,
} from "../src/lib/presence";
import { blankAnswers, normalizeAsk, NO_PREFERENCE } from "../src/lib/asking";
import { isRelayPrompt, isWakePrompt } from "../src/lib/relay";

function ask(id: string, card: string, at: number, text = "ship it?"): Deferred {
  const questions = normalizeAsk({ question: text, options: ["yes", "no"] });
  return {
    id,
    conversationId: card,
    questions,
    answers: blankAnswers(questions),
    askedAt: at,
  };
}

function act(id: string, card: string, at: number, tool = "mcp__skein__close"): Act {
  return {
    id,
    conversationId: card,
    tool,
    questions: normalizeAsk({ question: "close it?", options: ["yes", "no"] }),
    askedAt: at,
  };
}

describe("things to do, beside things to answer", () => {
  test("an act is named by what it does, not by its tool", () => {
    expect(actVerb("mcp__skein__close")).toBe("close a card");
    expect(actVerb("mcp__skein__unpost")).toBe("take a notice down");
    /* The shell delete arrives under a bare name, since it is not a tool call
       at all — it is a hook handing over a line somebody typed. */
    expect(actVerb("remove")).toBe("delete a path");
    expect(actVerb("something_new")).toBe("something_new");
  });

  test("they group with the same card's questions", () => {
    const pile = pileOf([ask("1", "alpha", 200)], [act("a", "alpha", 100)]);
    expect(pile.length).toBe(1);
    expect(pile[0].asks.length).toBe(1);
    expect(pile[0].acts.length).toBe(1);
    /* The group counts from whichever came first, whichever kind it was. */
    expect(pile[0].since).toBe(100);
  });

  test("a card with only acts still has a group", () => {
    const pile = pileOf([], [act("a", "beta", 50)]);
    expect(pile.map((g) => g.conversationId)).toEqual(["beta"]);
  });

  test("an act is one decision whatever it drew", () => {
    expect(waitingCount([], [act("a", "x", 1), act("b", "x", 2)])).toBe(2);
    expect(waitingCount([ask("q", "x", 1)], [act("a", "x", 2)])).toBe(2);
  });

  test("groups still read in the order they accumulated", () => {
    const pile = pileOf(
      [ask("q", "beta", 500)],
      [act("a", "alpha", 100), act("b", "gamma", 900)],
    );
    expect(pile.map((g) => g.conversationId)).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("the pile", () => {
  test("groups by card, oldest card first", () => {
    const pile = pileOf([
      ask("3", "beta", 300),
      ask("1", "alpha", 100),
      ask("2", "beta", 200),
      ask("4", "alpha", 400),
    ]);
    expect(pile.map((g) => g.conversationId)).toEqual(["alpha", "beta"]);
    /* Within a card, the order it accumulated in. */
    expect(pile[0].asks.map((a) => a.id)).toEqual(["1", "4"]);
    expect(pile[1].asks.map((a) => a.id)).toEqual(["2", "3"]);
  });

  test("a card's `since` is its own oldest question, not the pile's", () => {
    const pile = pileOf([ask("1", "alpha", 100), ask("2", "beta", 900)]);
    expect(pile[0].since).toBe(100);
    expect(pile[1].since).toBe(900);
  });

  test("an empty pile is empty rather than one group of nothing", () => {
    expect(pileOf([])).toEqual([]);
  });

  test("the count is questions, not calls", () => {
    const many = normalizeAsk({
      questions: [
        { question: "a?", options: ["1"] },
        { question: "b?", options: ["1"] },
        { question: "c?", options: ["1"] },
      ],
    });
    const d: Deferred = {
      id: "x",
      conversationId: "alpha",
      questions: many,
      answers: blankAnswers(many),
      askedAt: 0,
    };
    /* One row in the table, three decisions in front of you. A pile counted by
       rows would say "1 question" to somebody with three to make. */
    expect(waitingCount([d, ask("y", "beta", 1)])).toBe(4);
  });
});

describe("the pile's own door", () => {
  /* It had none until 2026-10-05: `showing` was written by `comeBack` and by
     the panel's close, so shutting it — or a mousedown landing on the scrim —
     put a pile that was still sitting in `deferred_ask` behind a round trip out
     of presence and back into it. Nothing was ever lost; the way back in did
     not exist. */
  test("something waiting, and a press opens it", () => {
    expect(pileOpens(false, [ask("1", "alpha", 100)])).toBe(true);
  });

  test("already up, and a press shuts it", () => {
    expect(pileOpens(true, [ask("1", "alpha", 100)])).toBe(false);
  });

  test("an empty pile does not open", () => {
    /* `Vigil.svelte` *is* the pile, so an empty one is not a smaller version of
       that panel — it is a panel saying "0 questions from 0 cards", which is a
       reading of nothing. The bar button is absent for the same reason. */
    expect(pileOpens(false, [])).toBe(false);
  });

  test("an act on its own is enough to open it", () => {
    /* The two halves of the pile are counted together everywhere else, and a
       door that only answered to questions would strand a card waiting on a
       close or an unpost. */
    expect(pileOpens(false, [], [act("1", "alpha", 100)])).toBe(true);
  });
});

describe("how long something has stood", () => {
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;

  test("the scales a person reads", () => {
    expect(stood(5 * s)).toBe("just now");
    expect(stood(1 * m)).toBe("1 minute ago");
    expect(stood(40 * m)).toBe("40 minutes ago");
    expect(stood(1 * h)).toBe("1 hour ago");
    expect(stood(9 * h)).toBe("9 hours ago");
    expect(stood(25 * h)).toBe("yesterday");
    expect(stood(72 * h)).toBe("3 days ago");
  });

  test("a duration is said as a duration", () => {
    expect(lasted(30 * s)).toBe("under a minute");
    expect(lasted(1 * m)).toBe("1 minute");
    expect(lasted(2 * h + 20 * m)).toBe("2h 20m");
    /* Past six hours the minutes stop being information — "9 hours" is what
       anybody would say about a night. */
    expect(lasted(9 * h + 14 * m)).toBe("9 hours");
    expect(lasted(26 * h)).toBe("1 day");
  });

  test("nothing counts backwards", () => {
    expect(stood(-5000)).toBe("just now");
    expect(lasted(-5000)).toBe("under a minute");
  });
});

describe("the answer handed back to the card", () => {
  const d = ask("1", "alpha", 0, "ship it?");

  test("it is not drawn as something somebody else wrote", () => {
    /* The whole decision in `answerEnvelope`. `relay.ts` recognises five shapes
       under two marks and every one of them means *this was not you* — and this
       is the opposite: the user read the question and clicked, and Volery only
       carried it. A mark here would be that lie told the other way round. */
    const text = answerEnvelope(d.questions, ["yes"], 9 * 3600 * 1000);
    expect(isRelayPrompt(text)).toBe(false);
    expect(isWakePrompt(text)).toBe(false);
  });

  test("it says which question, and when it was asked", () => {
    const text = answerEnvelope(d.questions, ["yes"], 9 * 3600 * 1000);
    expect(text).toContain("9 hours ago");
    expect(text).toContain("yes");
    /* The agent asked this possibly several turns ago, so the answer has to
       carry enough to be matched to it without the call being in scope. */
    expect(text).toContain("while I was away");
  });

  test("an unanswered slot still says something", () => {
    const many = normalizeAsk({
      questions: [
        { header: "colour", question: "a?", options: ["red"] },
        { header: "shape", question: "b?", options: ["round"] },
      ],
    });
    const text = answerEnvelope(many, ["red", null], 1000);
    /* `composeAnswer`'s rule, inherited: a blank reads as a bug where "you
       decide" reads as a decision. */
    expect(text).toContain(NO_PREFERENCE);
  });

  test("the plural follows the number of questions", () => {
    const one = answerEnvelope(d.questions, ["yes"], 1000);
    expect(one).toContain("You asked me this");
    const many = normalizeAsk({
      questions: [
        { question: "a?", options: ["1"] },
        { question: "b?", options: ["1"] },
      ],
    });
    expect(answerEnvelope(many, ["1", "1"], 1000)).toContain("You asked me these");
  });

  test("it tells the agent nothing is parked", () => {
    /* The failure without it: an agent reads an answer to an `ask_user` and
       waits for the call to return, which it did hours ago. */
    const text = answerEnvelope(d.questions, ["yes"], 1000);
    expect(text).toContain("nothing is parked");
  });
});

describe("away mode is not a night mode", () => {
  /* "I could be away for lunch, away for toilets, away for sport for 2 hours" —
     the switch has to be worth throwing for five minutes, which means coming
     back from five minutes cannot cost you a puzzle. */
  test("a short away costs nothing on the way back", () => {
    expect(gateOnReturn(true, 0)).toBe(false);
    expect(gateOnReturn(true, 2 * 60 * 1000)).toBe(false);
    expect(gateOnReturn(true, GATE_AFTER_MS - 1)).toBe(false);
  });

  test("a real absence does put a puzzle up", () => {
    expect(gateOnReturn(true, GATE_AFTER_MS)).toBe(true);
    expect(gateOnReturn(true, 9 * 3600 * 1000)).toBe(true);
  });

  test("the setting still wins over the clock", () => {
    expect(gateOnReturn(false, 9 * 3600 * 1000)).toBe(false);
  });

  test("the line is a break rather than a night", () => {
    /* If this ever grew to hours it would be a night mode again, which is the
       thing the whole file is written against. */
    expect(GATE_AFTER_MS).toBeGreaterThan(5 * 60 * 1000);
    expect(GATE_AFTER_MS).toBeLessThanOrEqual(45 * 60 * 1000);
  });
});

describe("the away screen setting", () => {
  test("only the three readings are accepted", () => {
    expect(isAwayScreen("takeover")).toBe(true);
    expect(isAwayScreen("dimmed")).toBe(true);
    expect(isAwayScreen("peek")).toBe(true);
    /* A value out of a newer build, or a hand-edited localStorage, must not
       put the wall into a state it cannot draw. */
    expect(isAwayScreen("off")).toBe(false);
    expect(isAwayScreen(null)).toBe(false);
    expect(isAwayScreen(2)).toBe(false);
  });
});
