import { expect, test, describe } from "bun:test";
import {
  FULL,
  MOTIONS,
  motionAt,
  motionFor,
  moves,
  nextMotion,
} from "../src/lib/motion";
import { menuFor, type MenuItem } from "../src/lib/menu";

const ids = (items: MenuItem[]) =>
  items.filter((i) => i.kind === "item").map((i) => (i as { id: string }).id);
const marked = (items: MenuItem[]) =>
  items
    .filter((i): i is Extract<MenuItem, { kind: "item" }> => i.kind === "item")
    .filter((i) => i.on)
    .map((i) => i.id);

describe("the catalogue", () => {
  test("three settings, each named once", () => {
    expect(MOTIONS).toHaveLength(3);
    expect(new Set(MOTIONS.map((m) => m.id)).size).toBe(3);
    expect(new Set(MOTIONS.map((m) => m.label)).size).toBe(3);
  });

  test("they run most motion to least, so `next` always means quieter", () => {
    expect(MOTIONS.map((m) => m.id)).toEqual(["full", "spare", "still"]);
  });

  test("the prose is lowercase, like everything else on the wall", () => {
    for (const m of MOTIONS) expect(m.label).toBe(m.label.toLowerCase());
  });

  test("every setting carries what it measured, so the two cannot drift", () => {
    for (const m of MOTIONS) expect(m.cost).toMatch(/^\d+(\.\d+)?%$/);
  });
});

describe("reading a stored setting", () => {
  test("each id survives the round trip", () => {
    for (const m of MOTIONS) expect(motionFor(m.id)).toBe(m.id);
  });

  /* The bargain `themeFor` strikes: a key edited by hand, or written by a build
     that had a fourth mode, costs a session its setting and not its start-up. */
  test("anything else degrades to the wall as drawn", () => {
    for (const junk of [null, undefined, "", "FULL", "quiet", 3, {}, []]) {
      expect(motionFor(junk)).toBe(FULL);
    }
  });

  test("`motionAt` always answers with a real mode", () => {
    expect(motionAt("nonsense").id).toBe(FULL);
    expect(motionAt("spare").label).toBe("less motion");
  });
});

describe("the ring", () => {
  test("cycles forward and wraps", () => {
    expect(nextMotion("full")).toBe("spare");
    expect(nextMotion("spare")).toBe("still");
    expect(nextMotion("still")).toBe("full");
  });

  test("cycles backward and wraps", () => {
    expect(nextMotion("full", -1)).toBe("still");
    expect(nextMotion("still", -1)).toBe("spare");
  });

  test("three steps either way is where you started", () => {
    for (const m of MOTIONS) {
      expect(nextMotion(nextMotion(nextMotion(m.id)))).toBe(m.id);
      expect(nextMotion(nextMotion(nextMotion(m.id, -1), -1), -1)).toBe(m.id);
    }
  });

  test("a junk id still cycles from somewhere real", () => {
    expect(nextMotion("nonsense")).toBe("spare");
  });
});

describe("moves", () => {
  test("only `still` stops", () => {
    expect(moves("full")).toBe(true);
    expect(moves("spare")).toBe(true);
    expect(moves("still")).toBe(false);
  });
});

describe("where it is reachable", () => {
  const picks = MOTIONS.map((m) => ({
    id: `motion:${m.id}`,
    label: m.label,
    on: m.id === "spare",
  }));

  test("the ground offers all three, beside the ambience", () => {
    const got = ids(menuFor({ kind: "ground", picks }));
    for (const m of MOTIONS) expect(got).toContain(`motion:${m.id}`);
    expect(got.indexOf("motion:full")).toBeLessThan(got.indexOf("ambience"));
  });

  test("the one in force is marked rather than relabelled", () => {
    expect(marked(menuFor({ kind: "ground", picks }))).toEqual(["motion:spare"]);
  });

  /* menu.ts's standing rule: offering nothing is a real answer, and a ground
     menu built without them must not grow a stray rule where they would be. */
  test("a ground menu with none of them left is unchanged", () => {
    const without = menuFor({ kind: "ground" });
    expect(ids(without)).not.toContain("motion:full");
    expect(without[0]?.kind).not.toBe("sep");
    expect(without.at(-1)?.kind).not.toBe("sep");
  });
});
