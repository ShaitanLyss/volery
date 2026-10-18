import { describe, expect, test } from "bun:test";

import { clockOf, footOf, lowOf, outOf, windowNoun } from "../src/lib/allowance";
import type { Window } from "../src/lib/limits";

/* Noon on a Wednesday, local time. */
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
const at = (h: number, m: number, day = 21) => new Date(2026, 9, day, h, m, 0).getTime();

function win(over: Partial<Window> = {}): Window {
  return {
    kind: "five_hour",
    group: "session",
    used: 47,
    severity: "normal",
    resetsAt: at(15, 40),
    scope: null,
    active: true,
    ...over,
  };
}

describe("the clock a reset is said by", () => {
  test("today is a time, another day carries its name", () => {
    expect(clockOf(at(15, 40), NOW)).toBe("15:40");
    expect(clockOf(at(9, 5, 22), NOW)).toBe("thu 09:05");
  });
  test("each window by its clock", () => {
    expect(windowNoun(win())).toBe("this session");
    expect(windowNoun(win({ group: "weekly", kind: "seven_day" }))).toBe("this week");
  });
});

describe("the sidebar's foot", () => {
  test("the account, its plan and the window that binds it", () => {
    expect(footOf("work", [win(), win({ group: "weekly", used: 20 })], "Max")).toEqual({
      name: "work",
      line: "max · 47% of this session",
    });
  });
  test("the machine's own credential, with no reading yet", () => {
    expect(footOf(null, null, null)).toEqual({ name: "claude code", line: "as this computer is signed in" });
  });
  test("signed out is said, not contradicted (the signed-out lab drew 'as this computer is signed in')", () => {
    expect(footOf(null, null, null, true)).toEqual({ name: "claude code", line: "not signed in yet" });
    expect(footOf("work", null, null, true).line).toBe("this conversation's account");
  });
  test("the fullest window binds, the week when it is fuller", () => {
    expect(footOf(null, [win({ used: 10 }), win({ group: "weekly", used: 80 })], null).line).toBe("80% of this week");
  });
});

describe("running low", () => {
  test("calm says nothing", () => {
    expect(lowOf([win({ used: 40 })], NOW)).toBeNull();
  });
  test("warm says how much and when it comes back", () => {
    expect(lowOf([win({ used: 85 })], NOW)).toBe("this session's allowance is 85% used · it comes back at 15:40");
  });
  test("spent is the banner's, not this line's", () => {
    expect(lowOf([win({ used: 100 })], NOW)).toBeNull();
  });
});

describe("run out everywhere", () => {
  test("nothing held, no banner; a queue held behind a turn is not run out", () => {
    expect(outOf(null, NOW)).toBeNull();
    expect(outOf({ waiting: "turn", until: null }, NOW)).toBeNull();
  });
  test("held for the allowance: when it comes back, and that nothing is lost", () => {
    const out = outOf({ waiting: "allowance", until: at(15, 40) }, NOW, [win({ used: 100 })])!;
    expect(out.head).toBe("this session's allowance is used up.");
    expect(out.body).toContain("It comes back at 15:40");
    expect(out.body).toContain("nothing is lost");
  });
  test("held with no clock to watch: no account can take it", () => {
    expect(outOf({ waiting: "allowance", until: null }, NOW)!.head).toBe("no account can take this right now.");
  });
});
