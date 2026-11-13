import { describe, expect, test } from "bun:test";

import { layout, REGION_GAP, regionWidth } from "../src/lib/layout";
import { tooOldForSolo, tooOldForSoloLine, wallLine, type Wall } from "../src/lib/flyway";
import { CHORDS } from "../src/lib/leader";
import {
  ACCEPTING_IS_CLOSED,
  PANEL_SAYS,
  PLATE_SAYS,
  SOLO_CHORD,
  SOLO_ROSTER_LINE,
  chromeTitle,
  openedElsewhere,
  openedHere,
  plateSpot,
  soloButton,
  soloSince,
} from "../src/lib/solo";

/* Monday 2026-11-09 18:04, local time — the moment the design's own plate
 * reads out. Built from the local calendar rather than a fixed epoch so the
 * test is about the sentence and not about which timezone this machine is in. */
const FRIDAY = new Date(2026, 10, 6, 18, 4).getTime();
const MONDAY = new Date(2026, 10, 9, 9, 0).getTime();

describe("the plate's words", () => {
  test("a start within the week is said as a weekday and a time", () => {
    expect(soloSince(FRIDAY, MONDAY)).toBe("solo since friday 18:04");
  });

  test("an older start is said as a date, because 'solo since friday' has stopped meaning anything", () => {
    const old = new Date(2026, 8, 14, 8, 30).getTime();
    expect(soloSince(old, MONDAY)).toBe("solo since 14 september 08:30");
  });

  test("not solo is nothing at all, never a line saying so", () => {
    expect(soloSince(null, MONDAY)).toBe("");
    expect(soloSince(0, MONDAY)).toBe("");
    expect(soloSince(-5, MONDAY)).toBe("");
  });

  test("a start in the future is a clock that moved, read as now", () => {
    const later = MONDAY + 60_000;
    expect(soloSince(later, MONDAY)).toBe(soloSince(MONDAY, MONDAY));
  });

  test("the button says the verb of the state it would put you in", () => {
    expect(soloButton(true)).toBe("fly with the others");
    expect(soloButton(false)).toBe("fly solo");
  });

  test("the two sentences say what stays and what stops, in a person's terms", () => {
    /* The plate leads with what the person keeps; the panel has room for both
       halves. `the books` is how the rule reasons and never how a person is
       told, so neither word appears. */
    expect(PLATE_SAYS).toContain("accounts, allowance and usage still sync");
    expect(PLATE_SAYS).toContain("No cards, questions, notices or screens cross.");
    expect(PANEL_SAYS).toContain("accounts, allowance, usage and analytics stay");
    expect(PLATE_SAYS.toLowerCase()).not.toContain("books");
    expect(PANEL_SAYS.toLowerCase()).not.toContain("books");
  });

  test("how many cards here came from another wall, singular and plural", () => {
    expect(openedElsewhere(0)).toBe("");
    expect(openedElsewhere(-1)).toBe("");
    expect(openedElsewhere(1)).toBe("1 card here was opened from another wall and keeps running.");
    expect(openedElsewhere(2)).toBe("2 cards here were opened from another wall and keep running.");
    expect(openedHere([null, undefined, ""])).toBe(0);
    expect(openedHere(["desk", null, "office"])).toBe(2);
  });

  test("the chrome mark says the state it wears", () => {
    expect(chromeTitle(true)).toContain("flying solo");
    expect(chromeTitle(true)).toContain("space then i s");
    expect(chromeTitle(false)).not.toContain("flying solo");
  });

  test("the accepting switch says it is closed anyway while solo", () => {
    expect(ACCEPTING_IS_CLOSED).toContain("closed anyway");
  });
});

describe("the chord", () => {
  test("space then i s toggles solo, and no chord is a prefix of it", () => {
    const chord = CHORDS.find((c) => c.keys === "is");
    expect(chord).toBeDefined();
    expect(chord!.verb).toEqual({ kind: "solo", act: "toggle" });
    expect(chord!.label.length).toBeGreaterThan(0);
    expect(SOLO_CHORD).toBe("space then i s");
  });
});

describe("a peer's roster line", () => {
  const wall = (solo: boolean): Wall => ({
    host: "weekend",
    me: false,
    quietMs: 1000,
    standing: "closed",
    reason: null,
    cardsLive: 0,
    cardsWorking: 0,
    allowanceUsed: 12,
    territories: [],
    older: false,
    solo,
  });

  test("solo replaces the load line rather than prefixing it", () => {
    expect(wallLine(wall(true))).toBe(SOLO_ROSTER_LINE);
    expect(SOLO_ROSTER_LINE).toContain("flying alone");
    expect(wallLine(wall(true))).not.toContain("no territories");
  });

  test("quiet still comes first: a solo wall that stopped talking is quiet", () => {
    expect(wallLine({ ...wall(true), standing: "quiet" })).toContain("quiet for");
  });

  test("an ordinary wall is unchanged", () => {
    expect(wallLine(wall(false))).toContain("not taking work from other walls");
  });
});

describe("which walls cannot show this one as solo", () => {
  const at = (host: string, build: string, me = false): Wall => ({
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
  });

  test("every wall on this build means nothing to say", () => {
    const rows = [at("me", "0.133.0", true), at("desk", "0.133.0")];
    expect(tooOldForSolo(rows, "0.133.0")).toEqual([]);
    expect(tooOldForSoloLine([])).toBe("");
  });

  test("an older or unspeaking wall is named, and the sentence says what it will draw", () => {
    const rows = [at("me", "0.133.0", true), at("desk", "0.120.0"), at("old", "")];
    const hosts = tooOldForSolo(rows, "0.133.0");
    expect(hosts.sort()).toEqual(["desk", "old"]);
    const line = tooOldForSoloLine(hosts);
    expect(line).toContain("older volery");
    expect(line).toContain("not taking work rather than as flying solo");
  });

  test("one wall is said in the singular", () => {
    expect(tooOldForSoloLine(["desk"])).toContain("desk runs an older volery");
    expect(tooOldForSoloLine(["desk"])).not.toContain("walls here");
  });
});

describe("where the plate stands", () => {
  test("with nothing on the wall it stands at the origin, not a strip-width off it", () => {
    expect(plateSpot([], 4)).toEqual({ x: 0, y: 0, w: regionWidth(1) });
  });

  test("with things standing it takes the head of the left strip", () => {
    const beside = [
      { x: 400, y: 90 },
      { x: 100, y: 300 },
    ];
    const at = plateSpot(beside, 4);
    expect(at.x).toBe(100 - regionWidth(4) - REGION_GAP * 2);
    expect(at.y).toBe(90);
    expect(at.w).toBe(regionWidth(1));
  });

  test("it is left of every region `layout` would draw, so the strip is the strip", () => {
    const stood = layout(
      [{ id: "a", cwd: "/x", project: "x", projectId: "x", territoryId: "x", s: 1 }],
      {},
      [{ id: "x", projectId: "x", name: "x", project: "x", cwd: "/x", x: 200, y: 40, cols: 2 }],
    );
    const at = plateSpot(stood.regions, 4);
    expect(at.x).toBeLessThan(stood.regions[0]!.x);
  });
});
