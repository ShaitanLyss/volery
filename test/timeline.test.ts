import { describe, expect, test } from "bun:test";
import {
  STRAND_GAP,
  current,
  effective,
  fraction,
  frise,
  planOf,
  railWidth,
  reach,
  isReceipt,
  receiptOf,
  shortId,
  roman,
  stepRev,
  subRev,
  timelineOf,
  took,
  whereabouts,
  type Plan,
  type Timeline,
} from "../src/lib/timeline";

/* The plan the mockups were drawn from: five steps, the third forking into a
   ui strand and a background api strand, both live. Written as Rust serialises
   it — `Marks` flattened onto each item. */
const RAW = {
  rev: 6,
  steps: [
    { title: "survey", state: "todo", born: 1, done: 2, strands: [{ subs: [
      { title: "a", state: "done", born: 1, done: 2 },
      { title: "b", state: "done", born: 1, done: 2 },
    ] }] },
    { title: "schema", state: "todo", born: 1, done: 4, strands: [{ subs: [
      { title: "c", state: "done", born: 1, done: 3 },
      { title: "d", state: "done", born: 1, done: 4 },
    ] }] },
    { title: "viewer", about: "layers and toggles", state: "todo", born: 1, strands: [
      { name: "ui", subs: [
        { title: "counts", state: "done", born: 1, done: 5 },
        { title: "toggles", state: "active", born: 1 },
        { title: "polish", state: "todo", born: 1 },
      ] },
      { name: "api", background: true, subs: [
        { title: "endpoint", state: "active", born: 5 },
      ] },
    ] },
    { title: "rollout", state: "todo", born: 1, strands: [] },
    { title: "handover", state: "todo", born: 6, strands: [] },
  ],
};

const plan = (): Plan => planOf(structuredClone(RAW));

function row(over: Partial<Timeline> = {}): Timeline {
  return {
    ...timelineOf({
      id: "t1",
      owner_id: "c1",
      session_id: "s1",
      cwd: "C:\\work\\nova",
      project: "",
      source: "the card",
      title: "rollout",
      plan: structuredClone(RAW),
      state: "live",
      archived_at: null,
      glass_x: null,
      glass_y: null,
      born_at: 0,
      updated_at: 60_000,
      ended_at: null,
    })!,
    ...over,
  };
}

describe("reading a row", () => {
  test("a row off the wire becomes a timeline, marks and all", () => {
    const t = row();
    expect(t.id).toBe("t1");
    expect(t.ownerId).toBe("c1");
    expect(t.plan.rev).toBe(6);
    expect(t.plan.steps[2].strands[1]).toEqual({
      name: "api",
      background: true,
      subs: [{ title: "endpoint", state: "active", born: 5, done: undefined }],
    });
    expect(t.plan.steps[0].done).toBe(2);
  });

  test("what a newer build might send degrades to something drawable", () => {
    const p = planOf({ steps: [{ title: 3, state: "exploded", strands: "no" }, null] });
    expect(p.rev).toBe(0);
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]).toMatchObject({ title: "", state: "todo", strands: [] });
    expect(planOf(null)).toEqual({ rev: 0, steps: [] });
    expect(timelineOf({})).toBeNull();
    expect(timelineOf({ id: "x", state: "weird" })?.state).toBe("live");
  });
});

describe("how far along", () => {
  test("a step is as far along as its sub-steps, or its own state with none", () => {
    const p = plan();
    expect(p.steps.map(effective)).toEqual(["done", "done", "active", "todo", "todo"]);
    p.steps[3].state = "active";
    expect(effective(p.steps[3])).toBe("active");
  });

  test("progress counts an active item as half, as Rust does", () => {
    // 2 + 2 + (1 + .5 + 0) + .5 + 0 + 0 over 2 + 2 + 4 + 1 + 1.
    expect(fraction(plan())).toBeCloseTo(6 / 10, 9);
    expect(fraction({ rev: 0, steps: [] })).toBe(0);
  });

  test("the current step is the first not done", () => {
    expect(current(plan())).toBe(2);
    const p = plan();
    for (const s of p.steps) {
      s.state = "done";
      for (const k of s.strands) for (const x of k.subs) x.state = "done";
    }
    expect(current(p)).toBe(-1);
  });

  test("reach is the done prefix plus half an active item, not a count", () => {
    const sub = (state: "todo" | "active" | "done") => ({ title: "", state });
    expect(reach([])).toBe(0);
    expect(reach([sub("done"), sub("active"), sub("todo"), sub("todo")])).toBe(1.5 / 4);
    expect(reach([sub("done"), sub("todo"), sub("done")])).toBe(1 / 3);
    expect(reach([sub("done"), sub("done")])).toBe(1);
  });
});

describe("the frise", () => {
  test("every step gets the same span, whatever its sub-steps", () => {
    const fr = frise(plan(), 640);
    expect(fr.spans.map((s) => [s.x0, s.x1])).toEqual([
      [0, 128],
      [128, 256],
      [256, 384],
      [384, 512],
      [512, 640],
    ]);
    expect(fr.nodes.map((n) => n.state)).toEqual(["done", "done", "active", "todo", "todo"]);
  });

  test("a fork draws one track per strand and is as tall as its strands need", () => {
    const fr = frise(plan(), 640);
    // four straight segments and two strands
    expect(fr.track).toHaveLength(6);
    expect(fr.height).toBe(2 * (9 + STRAND_GAP / 2));
    const single = frise({ rev: 0, steps: [{ title: "x", about: "", state: "todo", strands: [] }] }, 448);
    expect(single.height).toBe(18);
  });

  test("a live marker sits on its own strand, at the middle of its sub-step", () => {
    const fr = frise(plan(), 640);
    const base = fr.base;
    // the viewer step runs 256..384 and forks with a 28-unit curve each end
    const a = 256 + 28;
    const b = 384 - 28;
    const third = (b - a) / 3;
    expect(fr.lives).toEqual([
      { x: Math.round((a + 1.5 * third) * 100) / 100, y: base - STRAND_GAP / 2 },
      { x: Math.round(((a + b) / 2) * 100) / 100, y: base + STRAND_GAP / 2 },
    ]);
  });

  test("the walked line stops where the work has reached", () => {
    const fr = frise(plan(), 640);
    // the two finished steps fill end to end, each strand into its curve,
    // and nothing past the fork
    expect(fr.fill[0]).toBe("M0,9 H128".replace("9", String(fr.base)));
    expect(fr.fill).toHaveLength(4);
    expect(fr.fill.every((d) => !d.includes("384"))).toBe(true);
  });

  test("a step with no sub-steps fills by its own state", () => {
    const p = plan();
    p.steps[3].state = "active";
    const fr = frise(p, 640);
    expect(fr.lives).toContainEqual({ x: 448, y: fr.base });
    expect(fr.fill).toContain(`M384,${fr.base} H448`);
  });

  test("ticks are the boundaries between sub-steps, lit once the one before is done", () => {
    const fr = frise(plan(), 640);
    const inner = fr.ticks.filter((k) => k.x !== 640);
    // survey 1, schema 1, ui 2, api 0
    expect(inner).toHaveLength(4);
    expect(inner.map((k) => k.done)).toEqual([true, true, true, false]);
    const end = fr.ticks.find((k) => k.x === 640)!;
    expect(end.done).toBe(false);
  });

  test("an empty plan draws nothing and does not divide by zero", () => {
    const fr = frise({ rev: 0, steps: [] }, 448);
    expect(fr.track).toEqual([]);
    expect(fr.spans).toEqual([]);
  });

  test("the line is sized off the plan, within bounds", () => {
    expect(railWidth(1)).toBe(448);
    expect(railWidth(5)).toBe(640);
    expect(railWidth(12)).toBe(768);
  });
});

describe("finding where a step was written", () => {
  test("a receipt is read off the end of a write's answer", () => {
    expect(receiptOf("marked 2; now at step 3 of 5 (52%). [timeline 3fa9c1 r7]")).toEqual({
      id: "3fa9c1",
      rev: 7,
    });
    expect(receiptOf("it is on the wall.\n\n...\n[timeline 0b12aa r12]")?.rev).toBe(12);
    expect(receiptOf("nothing to see")).toBeNull();
    // the last one wins, so a quoted earlier answer cannot
    expect(receiptOf("was [timeline aaaaaa r3], now [timeline aaaaaa r4]")?.rev).toBe(4);
  });

  test("a receipt is matched on its timeline as well as its revision", () => {
    /* Two timelines of one card both have an r3; a click on the first must not
       land on the second's. */
    const one = "3fa9c1d2-0000-4000-8000-000000000000";
    const two = "77e0aa01-0000-4000-8000-000000000000";
    expect(shortId(one)).toBe("3fa9c1");
    expect(isReceipt("done. [timeline 3fa9c1 r3]", one, 3)).toBe(true);
    expect(isReceipt("done. [timeline 3fa9c1 r3]", two, 3)).toBe(false);
    expect(isReceipt("done. [timeline 3fa9c1 r4]", one, 3)).toBe(false);
  });

  test("a finished step leads to the write that finished it, otherwise to its birth", () => {
    const p = plan();
    expect(stepRev(p.steps[1])).toBe(4);
    expect(stepRev(p.steps[2])).toBe(1);
    expect(stepRev(p.steps[4])).toBe(6);
    // done with no step mark of its own falls back to its last sub-step
    p.steps[1].done = undefined;
    expect(stepRev(p.steps[1])).toBe(4);
  });

  test("a sub-step the same way", () => {
    const ui = plan().steps[2].strands[0].subs;
    expect(subRev(ui[0])).toBe(5);
    expect(subRev(ui[1])).toBe(1);
  });
});

describe("the words", () => {
  test("roman numerals, lowercase", () => {
    expect([1, 2, 3, 4, 5, 9, 12].map(roman)).toEqual(["i", "ii", "iii", "iv", "v", "ix", "xii"]);
  });

  test("a length of time the way the plate says it", () => {
    expect(took(14 * 60_000)).toBe("14m");
    expect(took((6 * 60 + 12) * 60_000)).toBe("6h 12m");
    expect(took((52 * 60 + 5) * 60_000)).toBe("2d 4h");
  });

  test("a live plate names its step, its strands and how far", () => {
    expect(whereabouts(row())).toEqual(["viewer", "2 strands", "step iii of v", "60%"]);
  });

  test("a finished one says how long it took, a left one where it stopped", () => {
    expect(whereabouts(row({ state: "complete", endedAt: 3_600_000 }))).toEqual([
      "complete",
      "took 1h 0m",
    ]);
    const left = whereabouts(row({ state: "left", endedAt: Date.UTC(2026, 8, 28, 12) }));
    expect(left[0]).toMatch(/^left at step iii, \d+ sep$/);
  });
});
