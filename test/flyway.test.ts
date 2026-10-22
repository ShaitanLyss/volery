import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BUILD_ANNOUNCED_FROM,
  buildLine,
  buildStanding,
  flywayError,
  flywayReading,
  mineOf,
  nothingHeard,
  olderTag,
  ownBuildLine,
  worthJoining,
  type Wall,
} from "../src/lib/flyway";

describe("the flyway panel's voice", () => {
  test("a rejection is quoted as it came", () => {
    expect(flywayError("that is not a wall key")).toBe("that is not a wall key");
    expect(flywayError(new Error("boom"))).toBe("boom");
    expect(flywayError(undefined)).toBe("that did not work");
    expect(flywayError("  ")).toBe("that did not work");
  });

  test("the reading names the machine only when linked", () => {
    expect(flywayReading(null, "x", true)).toBe("asking…");
    expect(flywayReading(false, "x", false)).toBe("not in a flyway");
    expect(flywayReading(true, "office", true)).toBe("linked — this machine is office");
    expect(flywayReading(true, "", true)).toContain("unnamed");
  });

  /* The heading used to be computed off `held` alone, so a wall whose endpoint
     never came up read "linked" at the top and "the link is not up — nothing is
     syncing" four lines below. The heading is the line that gets read. */
  test("a key held with the link down does not read as linked", () => {
    expect(flywayReading(true, "office", false)).toBe("office — the link is not up");
    expect(flywayReading(true, "office", false)).not.toContain("linked");
    expect(flywayReading(true, "", false)).toContain("unnamed");
  });

  test("an empty roster names what to check, likeliest first", () => {
    const up = nothingHeard(true);
    expect(up.length).toBe(3);
    /* Asleep before blocked: the probe is a five-minute errand and a shut lid
       is the common case, so the order is the whole of the advice. */
    expect(up[0]).toContain("not running");
    expect(up[1]).toContain("network");
    expect(up[2]).toContain("different key");
    /* And with no place on the flyway there is only one thing it can be, so
       the three guesses would be three wrong ones. */
    const down = nothingHeard(false);
    expect(down.length).toBe(1);
    expect(down[0]).toContain("restarting volery");
  });

  test("only emptiness is refused before the vault sees it", () => {
    expect(worthJoining("   ")).toBe(false);
    expect(worthJoining("3h7k o0il")).toBe(true);
  });
});

import { acceptingReading, forgettable, otherWalls, wallLine, type Wall } from "../src/lib/flyway";

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

describe("forgetting a wall that has gone", () => {
  const wall = (over: Partial<Wall> = {}): Wall => ({
    host: "lab-a",
    me: false,
    quietMs: 5 * 60_000,
    standing: "quiet",
    reason: null,
    cardsLive: 0,
    cardsWorking: 0,
    allowanceUsed: null,
    territories: [],
    older: false,
    ...over,
  });

  test("a quiet wall may be forgotten", () => {
    expect(forgettable(wall())).toBe(true);
  });

  /* A live wall re-announces on its own tick, so `Fleet::forget` cannot hold
     against it — the control would appear to work and undo itself within
     thirty seconds. `link.rs::flyway_forget` refuses the same three in words;
     this is the half that keeps the button off them. */
  test("a wall still being heard from may not", () => {
    expect(forgettable(wall({ standing: "open" }))).toBe(false);
    expect(forgettable(wall({ standing: "full" }))).toBe(false);
    expect(forgettable(wall({ standing: "closed" }))).toBe(false);
  });

  test("this wall is never offered", () => {
    /* `otherWalls` already drops it, so this is belt and braces — and the
       belt is what a future caller that forgets to filter will meet. */
    expect(forgettable(wall({ me: true }))).toBe(false);
  });

  test("an older build is no different — quiet is quiet", () => {
    expect(forgettable(wall({ older: true }))).toBe(true);
    expect(forgettable(wall({ older: true, standing: "open" }))).toBe(false);
  });
});

/* Which Volery a wall runs. The fact is `Facts::build` on the wire — not the
   statement clock `fleet.rs` also calls `version` — and an absent one is *older
   than the first release that says*, never a blank. */
describe("the build a wall runs", () => {
  const row = (host: string, build?: string, dev = false, me = false): Wall => ({
    host,
    me,
    quietMs: 0,
    standing: "open",
    reason: null,
    cardsLive: 0,
    cardsWorking: 0,
    allowanceUsed: null,
    territories: [],
    older: false,
    build,
    dev,
  });
  const mine = "0.75.1";

  test("an older build says so with its version, a newer one and an equal one do not alarm", () => {
    expect(buildLine(row("lap", "0.73.1"), mine)).toBe("older build — 0.73.1");
    expect(buildLine(row("lap", "0.75.1"), mine)).toBe("build 0.75.1");
    expect(buildLine(row("lap", "0.76.0"), mine)).toBe("newer build — 0.76.0");
    expect(olderTag(row("lap", "0.73.1"), mine)).toBe("older build — 0.73.1");
    expect(olderTag(row("lap", "0.75.1"), mine)).toBe("");
    expect(olderTag(row("lap", "0.76.0"), mine)).toBe("");
  });

  test("a wall that says nothing is older than the first release that says, not blank", () => {
    expect(buildStanding(row("lap"), mine)).toBe("unsaid");
    expect(buildStanding(row("lap", ""), mine)).toBe("unsaid");
    expect(buildLine(row("lap", ""), mine)).toContain(`before ${BUILD_ANNOUNCED_FROM}`);
    expect(olderTag(row("lap"), mine)).toContain(BUILD_ANNOUNCED_FROM);
    expect(olderTag(undefined, mine)).toBe("");
  });

  test("a development build is marked, because a lab at a version is not the release of that name", () => {
    expect(buildLine(row("lab", "0.75.1", true), mine)).toBe("build 0.75.1 · development build");
    expect(buildLine(row("lab", "0.73.1", true), mine)).toBe("older build — 0.73.1 · development build");
  });

  test("with nothing to compare against it says the version and does not guess", () => {
    expect(buildStanding(row("lap", "0.73.1"), "")).toBe("unordered");
    expect(buildLine(row("lap", "0.73.1"), "")).toBe("build 0.73.1");
    expect(buildStanding(row("lap", "0.73.1-rc.1"), mine)).toBe("unordered");
  });

  test("this wall's own row says nothing about itself in the list, and says its version above it", () => {
    const me = row("desk", "0.75.1", false, true);
    expect(buildLine(me, mine)).toBe("");
    expect(olderTag(me, mine)).toBe("");
    expect(mineOf([row("lap", "0.73.1"), me])).toBe("0.75.1");
    expect(mineOf([row("lap", "0.73.1")])).toBe("");
    expect(ownBuildLine([me])).toBe("this machine runs volery 0.75.1");
    expect(ownBuildLine([row("desk", "0.75.1", true, true)])).toContain("development build");
    expect(ownBuildLine([row("lap", "0.73.1")])).toBe("");
  });

  /* Two homes for one number would drift; the Rust one names the first release
     that announces, and the panel quotes it. */
  test("the first release named here is the one fleet.rs names", () => {
    const rust = readFileSync("src-tauri/src/flyway/fleet.rs", "utf8");
    const m = /pub const BUILD_ANNOUNCED_FROM: &str = "([^"]+)"/.exec(rust);
    expect(m?.[1]).toBe(BUILD_ANNOUNCED_FROM);
  });
});
