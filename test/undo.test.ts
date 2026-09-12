import { describe, expect, test } from "bun:test";
import {
  DEPTH,
  FUSE_MS,
  NOTHING,
  describe as describePast,
  equal,
  forget,
  fusable,
  fuse,
  invert,
  nameEdit,
  remember,
  replay,
  rewind,
  shifted,
  standsOf,
  trivial,
  type Act,
  type Edit,
  type Past,
} from "../src/lib/undo";

const edit = (over: Partial<Edit> = {}): Edit => ({
  at: "widget",
  id: "w1",
  was: { x: 0, y: 0 },
  now: { x: 10, y: 0 },
  ...over,
});

const act = (over: Partial<Act> = {}): Act => ({
  label: "moving a widget",
  edits: [edit()],
  t: 1000,
  ...over,
});

/** Everything the app does: remember a gesture, then read the stack back. */
const wall = (...acts: Act[]): Past =>
  acts.reduce((past, a) => remember(past, a), NOTHING);

describe("equal", () => {
  test("compares nested plain data", () => {
    expect(equal({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(equal({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  test("null is not an object", () => {
    expect(equal(null, {})).toBe(false);
    expect(equal(null, null)).toBe(true);
  });

  test("an array and an object of the same keys are not the same thing", () => {
    expect(equal([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  /* The reason this function exists rather than a JSON.stringify. Half the
     writers of a Placement spell `glassX` out as null and half leave it off, so
     a gesture that changed nothing looked like a change and ate an undo press
     on a step you could not see. */
  test("a missing key and an undefined one are the same key", () => {
    expect(equal({ x: 1 }, { x: 1, glassX: undefined })).toBe(true);
    expect(equal({ x: 1, glassX: undefined }, { x: 1 })).toBe(true);
  });

  test("but null is not absence", () => {
    expect(equal({ x: 1 }, { x: 1, glassX: null })).toBe(false);
  });
});

describe("invert", () => {
  test("swaps both sides of every edit and keeps the name", () => {
    const back = invert(act());
    expect(back.label).toBe("moving a widget");
    expect(back.edits[0].was).toEqual({ x: 10, y: 0 });
    expect(back.edits[0].now).toEqual({ x: 0, y: 0 });
  });

  test("is its own inverse", () => {
    expect(invert(invert(act()))).toEqual(act());
  });

  /* Creating and removing are the same shape with a null on one side, which is
     the whole reason undo has one code path rather than three. */
  test("turns a creation into a removal", () => {
    const made = act({ edits: [edit({ was: null, now: { x: 1 } })] });
    expect(invert(made).edits[0].now).toBe(null);
  });
});

describe("trivial", () => {
  test("an act that changed nothing", () => {
    expect(trivial(act({ edits: [edit({ now: { x: 0, y: 0 } })] }))).toBe(true);
    expect(trivial(act())).toBe(false);
  });

  test("one real edit among no-ops still counts", () => {
    const a = act({
      edits: [edit({ id: "w1", now: { x: 0, y: 0 } }), edit({ id: "w2" })],
    });
    expect(trivial(a)).toBe(false);
  });
});

describe("fusable", () => {
  test("the same gesture continuing", () => {
    expect(fusable(act({ t: 1000 }), act({ t: 1016 }))).toBe(true);
  });

  test("a different name is a different gesture", () => {
    expect(fusable(act(), act({ t: 1016, label: "resizing a widget" }))).toBe(false);
  });

  test("a different record is a different gesture", () => {
    const other = act({ t: 1016, edits: [edit({ id: "w2" })] });
    expect(fusable(act(), other)).toBe(false);
  });

  test("too long ago is a different gesture", () => {
    expect(fusable(act({ t: 1000 }), act({ t: 1000 + FUSE_MS + 1 }))).toBe(false);
  });

  test("order of the records does not matter", () => {
    const a = act({ edits: [edit({ id: "w1" }), edit({ id: "w2" })] });
    const b = act({ t: 1016, edits: [edit({ id: "w2" }), edit({ id: "w1" })] });
    expect(fusable(a, b)).toBe(true);
  });

  test("time never runs backwards into a fuse", () => {
    expect(fusable(act({ t: 2000 }), act({ t: 1000 }))).toBe(false);
  });
});

describe("fuse", () => {
  test("keeps where it started and where it got to", () => {
    const a = act({ t: 1000 });
    const b = act({ t: 1016, edits: [edit({ now: { x: 40, y: 0 } })] });
    const one = fuse(a, b);
    expect(one.edits[0].was).toEqual({ x: 0, y: 0 });
    expect(one.edits[0].now).toEqual({ x: 40, y: 0 });
    expect(one.t).toBe(1016);
  });

  test("an edit the earlier act did not have is taken as it comes", () => {
    const a = act({ edits: [edit({ id: "w1" })] });
    const b = act({ t: 1016, edits: [edit({ id: "w1" }), edit({ id: "w2" })] });
    expect(fuse(a, b).edits[1].id).toBe("w2");
  });
});

describe("remember", () => {
  test("a gesture goes on the stack", () => {
    const past = wall(act());
    expect(past.done).toHaveLength(1);
    expect(past.sealed).toBe(false);
  });

  test("a gesture that changed nothing does not", () => {
    const past = remember(NOTHING, act({ edits: [edit({ now: { x: 0, y: 0 } })] }));
    expect(past.done).toHaveLength(0);
  });

  /* What makes a drag one undo step rather than two hundred. */
  test("a continuous drag is one step", () => {
    let past = NOTHING;
    for (let i = 0; i < 60; i++) {
      past = remember(past, act({ t: 1000 + i * 16, edits: [edit({ now: { x: i, y: 0 } })] }));
    }
    expect(past.done).toHaveLength(1);
    expect(past.done[0].edits[0].was).toEqual({ x: 0, y: 0 });
    expect(past.done[0].edits[0].now).toEqual({ x: 59, y: 0 });
  });

  test("two deliberate nudges stay two steps", () => {
    const past = wall(act({ t: 1000 }), act({ t: 5000 }));
    expect(past.done).toHaveLength(2);
  });

  test("a drag that ends where it began leaves nothing behind", () => {
    const out = act({ t: 1000, edits: [edit({ was: { x: 0 }, now: { x: 40 } })] });
    const home = act({ t: 1016, edits: [edit({ was: { x: 40 }, now: { x: 0 } })] });
    expect(wall(out, home).done).toHaveLength(0);
  });

  test("a new gesture clears the way forward", () => {
    const stepped = rewind(wall(act())).past;
    expect(stepped.undone).toHaveLength(1);
    expect(remember(stepped, act({ t: 9000 })).undone).toHaveLength(0);
  });

  /* Trivial acts are not gestures, so they must not throw away a redo either. */
  test("a gesture that changed nothing leaves the way forward alone", () => {
    const stepped = rewind(wall(act())).past;
    const nothing = act({ t: 9000, edits: [edit({ now: { x: 0, y: 0 } })] });
    expect(remember(stepped, nothing).undone).toHaveLength(1);
  });

  /* The whole reason `sealed` exists: press Ctrl+Z and immediately drag the same
     card, and without it the drag would fuse into the act just stepped past —
     taking a `was` from before an undo that has already been applied. */
  test("a gesture right after a step back does not fuse into the head", () => {
    const past = wall(act({ t: 1000 }), act({ t: 9000 }));
    expect(past.done).toHaveLength(2);
    const stepped = rewind(past).past;
    expect(stepped.sealed).toBe(true);
    /* Well inside the fusing window of what is now the head, and it must not be
       folded into it — that head's `was` predates an undo already applied. */
    const next = remember(stepped, act({ t: 1050 }));
    expect(next.done).toHaveLength(2);
    expect(next.sealed).toBe(false);
  });

  test("the stack is bounded, and it is the oldest that goes", () => {
    let past = NOTHING;
    for (let i = 0; i < DEPTH + 20; i++) {
      past = remember(past, act({ t: 1000 + i * 5000, label: `step ${i}` }));
    }
    expect(past.done).toHaveLength(DEPTH);
    expect(past.done[0].label).toBe("step 20");
    expect(past.done[DEPTH - 1].label).toBe(`step ${DEPTH + 19}`);
  });
});

describe("rewind and replay", () => {
  test("stepping back hands over the inverse, ready to apply", () => {
    const { past, act: back } = rewind(wall(act()));
    expect(back?.edits[0].now).toEqual({ x: 0, y: 0 });
    expect(past.done).toHaveLength(0);
    expect(past.undone).toHaveLength(1);
  });

  test("stepping forward hands over what was recorded", () => {
    const { past, act: again } = replay(rewind(wall(act())).past);
    expect(again?.edits[0].now).toEqual({ x: 10, y: 0 });
    expect(past.done).toHaveLength(1);
    expect(past.undone).toHaveLength(0);
  });

  test("nothing either way answers null and leaves the stack alone", () => {
    expect(rewind(NOTHING).act).toBe(null);
    expect(rewind(NOTHING).past).toBe(NOTHING);
    expect(replay(NOTHING).act).toBe(null);
    expect(replay(NOTHING).past).toBe(NOTHING);
  });

  test("all the way back and all the way forward is where you started", () => {
    const start = wall(act({ t: 1000 }), act({ t: 5000 }), act({ t: 9000 }));
    let past = start;
    for (let i = 0; i < 3; i++) past = rewind(past).past;
    expect(past.done).toHaveLength(0);
    for (let i = 0; i < 3; i++) past = replay(past).past;
    expect(past.done.map((a) => a.t)).toEqual([1000, 5000, 9000]);
  });

  test("both directions seal the head", () => {
    expect(rewind(wall(act())).past.sealed).toBe(true);
    expect(replay(rewind(wall(act())).past).past.sealed).toBe(true);
  });
});

describe("describe", () => {
  test("names what each direction would do", () => {
    const past = rewind(wall(act({ label: "moving a card" }), act({ t: 5000, label: "resizing a widget" }))).past;
    expect(describePast(past)).toEqual({
      back: "moving a card",
      forward: "resizing a widget",
    });
  });

  test("an empty stack names nothing in either direction", () => {
    expect(describePast(NOTHING)).toEqual({ back: null, forward: null });
  });
});

describe("forget", () => {
  test("drops the edits of a record that has gone", () => {
    const past = wall(
      act({ t: 1000, edits: [edit({ at: "placement", id: "c1" })] }),
      act({ t: 5000, edits: [edit({ at: "placement", id: "c2" })] }),
    );
    const after = forget(past, "placement", "c1");
    expect(after.done).toHaveLength(1);
    expect(after.done[0].edits[0].id).toBe("c2");
  });

  test("an act left with nothing in it goes too", () => {
    const past = wall(act({ edits: [edit({ at: "territory", id: "C:/x" })] }));
    expect(forget(past, "territory", "C:/x").done).toHaveLength(0);
  });

  test("a multi-record act survives losing one of them", () => {
    const past = wall(
      act({
        label: "moving a territory",
        edits: [
          edit({ at: "territory", id: "C:/x" }),
          edit({ at: "placement", id: "c1" }),
        ],
      }),
    );
    const after = forget(past, "placement", "c1");
    expect(after.done).toHaveLength(1);
    expect(after.done[0].edits.map((e) => e.at)).toEqual(["territory"]);
  });

  test("the way forward is pruned as well as the way back", () => {
    const past = rewind(wall(act({ edits: [edit({ at: "image", id: "i1" })] }))).past;
    expect(past.undone).toHaveLength(1);
    expect(forget(past, "image", "i1").undone).toHaveLength(0);
  });

  test("only that realm's id, not the same string elsewhere", () => {
    const past = wall(act({ edits: [edit({ at: "widget", id: "x" })] }));
    expect(forget(past, "image", "x").done).toHaveLength(1);
  });
});

describe("standsOf and shifted", () => {
  const projects = [
    { root_path: "C:/a", x: 10, y: 20 },
    { root_path: "C:/b", x: null, y: null, glassX: 5, glassY: 6 },
  ];

  test("reads where every territory stands, absences and all", () => {
    expect(standsOf(projects).get("C:/a")).toEqual({
      x: 10,
      y: 20,
      glassX: null,
      glassY: null,
      cols: null,
    });
    expect(standsOf(projects).get("C:/b")).toEqual({
      x: null,
      y: null,
      glassX: 5,
      glassY: 6,
      cols: null,
    });
  });

  /* Reflowing one territory runs the packing, which gives a position to anything
     that has none — so a gesture aimed at one can move a neighbour, and the act
     has to be the difference between two readings rather than the one name. */
  test("names every territory that moved, not only the one asked about", () => {
    const before = standsOf(projects);
    const after = standsOf([
      { root_path: "C:/a", x: 99, y: 20 },
      { root_path: "C:/b", x: 40, y: 40, glassX: 5, glassY: 6 },
    ]);
    const edits = shifted(before, after);
    expect(edits.map((e) => e.id).sort()).toEqual(["C:/a", "C:/b"]);
    expect(edits.every((e) => e.at === "territory")).toBe(true);
  });

  /* A `place_project` per territory that did not move is a row written for
     nothing on every tidy, and a stack entry claiming a move that never was. */
  test("leaves out the ones that did not move", () => {
    const before = standsOf(projects);
    const after = standsOf([
      { root_path: "C:/a", x: 10, y: 20 },
      { root_path: "C:/b", x: 40, y: 40, glassX: 5, glassY: 6 },
    ]);
    expect(shifted(before, after).map((e) => e.id)).toEqual(["C:/b"]);
  });

  test("nothing moved is no act at all", () => {
    expect(shifted(standsOf(projects), standsOf(projects))).toEqual([]);
  });

  /* A project opened between the two readings has no `was` to go back to. */
  test("a territory that appeared in between is skipped", () => {
    const after = standsOf([...projects, { root_path: "C:/c", x: 1, y: 1 }]);
    expect(shifted(standsOf(projects), after)).toEqual([]);
  });
});

describe("nameEdit", () => {
  test("names the realm and the kind of change", () => {
    expect(nameEdit("widget", ["x", "y"])).toBe("moving a widget");
    expect(nameEdit("image", ["w", "h"])).toBe("resizing an image");
    expect(nameEdit("image", ["rotation"])).toBe("turning an image");
    expect(nameEdit("widget", ["config"])).toBe("adjusting a widget");
    expect(nameEdit("widget", ["z"])).toBe("bringing a widget to the front");
    expect(nameEdit("placement", ["x", "y"])).toBe("moving a card");
    expect(nameEdit("territory", ["x", "y"])).toBe("moving a territory");
  });

  /* A corner drag writes the box and the origin together, and what you did was
     resize it. */
  test("a resize that also moves the origin is still a resize", () => {
    expect(nameEdit("image", ["x", "y", "w", "h"])).toBe("resizing an image");
  });

  test("the glass toggle gets the words the menu uses", () => {
    expect(nameEdit("widget", ["glassX", "glassY"], { was: false, now: true })).toBe(
      "sticking a widget to the glass",
    );
    expect(nameEdit("widget", ["glassX", "glassY"], { was: true, now: false })).toBe(
      "putting a widget back on the wall",
    );
  });

  test("dragging something already on the glass is a move there", () => {
    expect(nameEdit("image", ["glassX", "glassY"], { was: true, now: true })).toBe(
      "moving an image on the glass",
    );
    /* With nothing said about the glass, a move is all it can honestly be. */
    expect(nameEdit("image", ["glassX"])).toBe("moving an image on the glass");
  });

  test("a patch of nothing it knows still reads as a sentence", () => {
    expect(nameEdit("widget", ["mystery"])).toBe("changing a widget");
  });
});
