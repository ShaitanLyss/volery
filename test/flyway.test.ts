import { describe, expect, test } from "bun:test";
import { flywayError, flywayReading, worthJoining } from "../src/lib/flyway";

describe("the flyway panel's voice", () => {
  test("a rejection is quoted as it came", () => {
    expect(flywayError("that is not a wall key")).toBe("that is not a wall key");
    expect(flywayError(new Error("boom"))).toBe("boom");
    expect(flywayError(undefined)).toBe("that did not work");
    expect(flywayError("  ")).toBe("that did not work");
  });

  test("the reading names the machine only when linked", () => {
    expect(flywayReading(null, "x")).toBe("asking…");
    expect(flywayReading(false, "x")).toBe("not in a flyway");
    expect(flywayReading(true, "office")).toBe("linked — this machine is office");
    expect(flywayReading(true, "")).toContain("unnamed");
  });

  test("only emptiness is refused before the vault sees it", () => {
    expect(worthJoining("   ")).toBe(false);
    expect(worthJoining("3h7k o0il")).toBe(true);
  });
});

import { acceptingReading, otherWalls, wallLine, type Wall } from "../src/lib/flyway";

function wall(over: Partial<Wall>): Wall {
  return {
    host: "desk",
    me: false,
    quietMs: 1_000,
    standing: "open",
    reason: null,
    cardsLive: 7,
    cardsWorking: 2,
    allowanceUsed: 40,
    territories: ["skein", "nova"],
    older: false,
    ...over,
  };
}

describe("the roster, as somebody choosing a machine reads it", () => {
  test("a wall that takes work says how busy it is and where it can stand a card", () => {
    expect(wallLine(wall({}))).toBe("takes work · 2 of 7 working · allowance 40% used · skein, nova");
  });

  test("quiet hides what the wall last said, because that is history", () => {
    const line = wallLine(wall({ standing: "quiet", quietMs: 4 * 60_000 }));
    expect(line).toBe("quiet for 4 min — asleep, or off the network");
    expect(line).not.toContain("working");
  });

  test("closed and full are told apart from quiet and from each other", () => {
    expect(wallLine(wall({ standing: "closed" }))).toContain("not taking work");
    expect(wallLine(wall({ standing: "full" }))).toContain("at its bound");
  });

  test("an older build says first that nothing but its sink reaches it", () => {
    expect(wallLine(wall({ older: true, standing: "open" }))).toContain("older volery");
  });

  test("this wall is not one of the others", () => {
    const rows = [wall({ host: "zed" }), wall({ host: "me", me: true }), wall({ host: "alpha" })];
    expect(otherWalls(rows).map((w) => w.host)).toEqual(["alpha", "zed"]);
  });

  test("the switch says what saying yes means", () => {
    expect(acceptingReading(null)).toBe("asking…");
    expect(acceptingReading(false)).toBe("other walls may not open cards here");
    expect(acceptingReading(true)).toContain("this machine's shell");
  });
});
