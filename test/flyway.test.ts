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
