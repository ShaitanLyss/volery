import { describe, expect, test } from "bun:test";
import { closeWarnings, mustConfirm } from "../src/lib/closing";

describe("closing", () => {
  test("an idle card with nothing in the background closes at once", () => {
    expect(mustConfirm({ working: false, jobs: 0 })).toBe(false);
    expect(closeWarnings({ working: false, jobs: 0 })).toEqual([]);
  });

  test("a card mid-turn asks, and says what it would lose", () => {
    const w = closeWarnings({ working: true, jobs: 0 });
    expect(mustConfirm({ working: true, jobs: 0 })).toBe(true);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("mid-turn");
  });

  test("background work alone asks, even with no turn open", () => {
    expect(mustConfirm({ working: false, jobs: 1 })).toBe(true);
    expect(closeWarnings({ working: false, jobs: 1 })[0]).toContain("background work");
    expect(closeWarnings({ working: false, jobs: 3 })[0]).toContain("3 pieces");
  });

  test("both say both, turn first", () => {
    const w = closeWarnings({ working: true, jobs: 2 });
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("mid-turn");
  });

  test("a figure that is not a count asks about nothing", () => {
    expect(mustConfirm({ working: false, jobs: NaN })).toBe(false);
    expect(mustConfirm({ working: false, jobs: -2 })).toBe(false);
  });
});
