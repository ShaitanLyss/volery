import { describe, expect, test } from "bun:test";
import { departure, movedSummary } from "../src/lib/moveall";

describe("a grouping's cards moving to another machine", () => {
  test("the question says what each card goes through, and what stays", () => {
    const one = departure(1, "lab");
    expect(one[0]).toStartWith("it is stopped here");
    const many = departure(4, "lab");
    expect(many[0]).toContain("one card at a time");
    expect(many[0]).toContain("lab");
    expect(many[1]).toContain("stays here");
  });

  test("all moved is one short line", () => {
    expect(movedSummary([{ title: "a", moved: true }], "lab")).toBe("moved the card to lab");
    expect(movedSummary([{ title: "a", moved: true }, { title: "b", moved: true }], "lab")).toBe(
      "moved all 2 cards to lab",
    );
  });

  test("each card that stayed is named with the reason, not the remedy", () => {
    const s = movedSummary(
      [
        { title: "a", moved: true },
        { title: "fix the build", moved: false, why: "it is mid-turn — wait for it to finish, then move it." },
        { title: "docs", moved: false, why: "the tree has uncommitted work. Commit it first." },
      ],
      "lab",
    );
    expect(s).toBe("moved 1 of 3 cards to lab — still here: fix the build (it is mid-turn); docs (the tree has uncommitted work)");
  });

  test("a long reason is cut, so one card cannot fill the line", () => {
    const s = movedSummary([{ title: "x", moved: false, why: "w".repeat(400) }], "lab");
    expect(s.length).toBeLessThan(200);
    expect(s).toStartWith("moved 0 of 1 card to lab");
  });
});
