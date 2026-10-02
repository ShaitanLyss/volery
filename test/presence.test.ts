import { describe, expect, test } from "bun:test";

import {
  answerEnvelope,
  isAwayScreen,
  lasted,
  pileOf,
  stood,
  waitingCount,
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
