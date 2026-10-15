import { expect, test, describe } from "bun:test";
import {
  ARCHIVE,
  KEPT,
  PLAN,
  STACK_GAP,
  STACK_TOP,
  WALL,
  archiveAfter,
  archiveDue,
  evicted,
  planOf,
  plateOfGone,
  seedOf,
  stackAt,
  hangOf,
  keepOnSpot,
  keptOf,
  toGlass,
  toStack,
  toWall,
  unhoused,
} from "../src/lib/plates";
import {
  defaultConfig,
  isView,
  newWidget,
  normalizeWidget,
  offersOf,
  specFor,
  variantOf,
} from "../src/lib/widgets";

const plate = (id: string, plan: string | undefined, over: Record<string, unknown> = {}) => ({
  id,
  glassX: null as number | null,
  glassY: null as number | null,
  config: { ...(plan === undefined ? {} : { [PLAN]: plan }), ...over },
});

/* ── what a plate is ───────────────────────────────────────────────────── */

describe("a plate is a widget that draws one timeline", () => {
  test("the timeline rides in the config, and an empty one is none", () => {
    expect(planOf(plate("w", "t1"))).toBe("t1");
    expect(planOf(plate("w", ""))).toBeNull();
    expect(planOf(plate("w", undefined))).toBeNull();
    expect(planOf({ config: { [PLAN]: 7 } })).toBeNull();
  });

  test("a fresh plate draws its timeline, compact, in the stack", () => {
    const w = newWidget("timeline", 0, 0, 0, "t1");
    expect(planOf(w)).toBe("t1");
    expect(variantOf(w)).toBe("compact");
    expect(hangOf(w)).toBe("stack");
    expect(w.config[ARCHIVE]).toBe("10");
  });

  /* The same refusal a pin of no card gets: the next timeline along would be
     somebody else's plan under this one's frame. */
  test("a plate of no timeline is left off the wall", () => {
    const raw = { id: "w", kind: "timeline", x: 0, y: 0, w: 400, h: 120, z: 0, config: {} };
    expect(normalizeWidget(raw)).toBeNull();
    const kept = normalizeWidget({ ...raw, config: { [PLAN]: "t1", variant: "wide" } })!;
    expect(planOf(kept)).toBe("t1");
    expect(variantOf(kept)).toBe("wide");
  });

  test("where it stands survives the round trip, and junk reads as the stack", () => {
    const on = normalizeWidget({
      id: "w",
      kind: "timeline",
      x: 10,
      y: 20,
      w: 400,
      h: 120,
      z: 0,
      config: { [PLAN]: "t1", [WALL]: 1 },
    })!;
    expect(hangOf(on)).toBe("wall");
    const junk = normalizeWidget({
      id: "w",
      kind: "timeline",
      x: 0,
      y: 0,
      w: 400,
      h: 120,
      z: 0,
      config: { [PLAN]: "t1", [WALL]: "yes" },
    })!;
    expect(hangOf(junk)).toBe("stack");
  });

  /* Hung up from nothing it would be a view of nothing — the rule `said`
     already keeps, and the one a layout export and the control surface's
     `widget.add` both ask. */
  test("it is a view, so no menu offers it", () => {
    expect(isView("timeline")).toBe(true);
    expect(isView("said")).toBe(true);
    expect(isView("clock")).toBe(false);
    const offered = offersOf().flatMap((o) => ("items" in o ? o.items.map((i) => i.id) : [o.id]));
    expect(offered).not.toContain("timeline");
    expect(specFor("timeline")?.plan).toBe(true);
  });

  test("the archive knob defaults to ten minutes and offers never", () => {
    expect(defaultConfig("timeline")[ARCHIVE]).toBe("10");
    const p = specFor("timeline")!.params.find((p) => p.key === ARCHIVE)!;
    expect(p.kind === "choice" && p.options.map((o) => o.value)).toEqual(["never", "5", "10", "15"]);
  });
});

/* ── where it stands, and moving it ────────────────────────────────────── */

describe("three places to stand", () => {
  test("a spot on the glass wins over the wall flag", () => {
    expect(hangOf({ ...plate("w", "t"), glassX: 4, glassY: 5 })).toBe("glass");
    expect(hangOf({ ...plate("w", "t", { [WALL]: 1 }), glassX: 4, glassY: 5 })).toBe("glass");
    expect(hangOf(plate("w", "t", { [WALL]: 1 }))).toBe("wall");
    expect(hangOf(plate("w", "t"))).toBe("stack");
  });

  test("half a spot is no spot", () => {
    expect(hangOf({ ...plate("w", "t"), glassX: 4 })).toBe("stack");
  });

  test("into the stack clears the spot and the wall", () => {
    const m = toStack(plate("w", "t", { [WALL]: 1, variant: "wide" }));
    expect(m.glassX).toBeNull();
    expect(hangOf({ ...m })).toBe("stack");
    expect(m.config.variant).toBe("wide");
  });

  test("onto the wall stands it where it was asked, off the glass", () => {
    const m = toWall({ config: { [PLAN]: "t" } }, { x: 120, y: -40 });
    expect(m).toMatchObject({ x: 120, y: -40, glassX: null, glassY: null });
    expect(hangOf(m)).toBe("wall");
  });

  /* The flag is where the plate goes when its spot is taken away, so sticking
     one to the glass leaves it alone: one stuck from the wall goes back to the
     wall, one dragged out of the stack goes back to the stack. That is also
     what walking into a screen arrangement where it has no spot does. */
  test("onto the glass keeps where it came from", () => {
    const fromStack = toGlass(plate("w", "t"), { x: 1, y: 2 });
    expect(hangOf(fromStack)).toBe("glass");
    expect(hangOf({ ...fromStack, glassX: null, glassY: null })).toBe("stack");
    const fromWall = toGlass(plate("w", "t", { [WALL]: 1 }), { x: 1, y: 2 });
    expect(hangOf({ ...fromWall, glassX: null, glassY: null })).toBe("wall");
  });
});

/* ── a plate you moved is a plate you kept ─────────────────────────────── */

describe("moving a plate out of the stack keeps it, in every room", () => {
  test("onto the glass or the wall is a keep; back into the stack gives it up", () => {
    expect(keptOf(plate("w", "t"))).toBe(false);
    expect(keptOf(toGlass(plate("w", "t"), { x: 1, y: 2 }))).toBe(true);
    expect(keptOf(toWall(plate("w", "t"), { x: 1, y: 2 }))).toBe(true);
    expect(keptOf(toStack(plate("w", "t", { [KEPT]: 1 })))).toBe(false);
  });

  /* A drag out of the stack is the carry writing a spot, not `toGlass`. */
  test("any spot written onto a plate is a keep, and nothing else is", () => {
    const cfg = { [PLAN]: "t" };
    expect(keepOnSpot(cfg, { glassX: 3, glassY: 4 })[KEPT]).toBe(1);
    expect(keepOnSpot(cfg, { glassX: null, glassY: null })).toBe(cfg);
    expect(keepOnSpot(cfg, {})).toBe(cfg);
    const clock = { variant: "analog" };
    expect(keepOnSpot(clock, { glassX: 3, glassY: 4 })).toBe(clock);
  });

  /* The case found in review: dragged onto the glass in one screen
     arrangement, it finds no spot in another and stands in the stack there —
     and must not then be archived as though nobody had chosen it. */
  test("a kept plate back in the stack by a change of room is never archived", () => {
    const moved = toGlass(plate("w", "t"), { x: 1, y: 2 });
    const elsewhere = { ...moved, glassX: null, glassY: null };
    expect(hangOf(elsewhere)).toBe("stack");
    expect(keptOf(elsewhere)).toBe(true);
    expect(
      archiveDue({
        state: "complete",
        endedAt: 0,
        updatedAt: 0,
        hang: "stack",
        kept: true,
        after: 60_000,
        seen: 0,
        now: 10 * 60_000,
      }),
    ).toBe(false);
  });
});

/* ── the wall putting them up and taking them down ─────────────────────── */

describe("a plate for every timeline on the glass, and no other", () => {
  test("a timeline nothing draws yet is unhoused, in the order given", () => {
    const ws = [plate("a", "t2"), plate("b", undefined)];
    expect(unhoused(["t1", "t2", "t3"], ws)).toEqual(["t1", "t3"]);
    expect(unhoused([], ws)).toEqual([]);
  });

  test("a plate whose timeline left the glass is taken down", () => {
    const ws = [plate("a", "t1"), plate("b", "t2"), plate("c", undefined)];
    expect(evicted(ws, new Set(["t1"])).map((w) => w.id)).toEqual(["b"]);
  });

  test("a second plate of one timeline is taken down and the first kept", () => {
    const ws = [plate("a", "t1"), plate("b", "t1")];
    expect(evicted(ws, new Set(["t1"])).map((w) => w.id)).toEqual(["b"]);
  });

  test("an empty glass takes every plate down — and only plates", () => {
    expect(evicted([plate("a", "t1"), plate("z", undefined)], new Set()).map((w) => w.id)).toEqual(["a"]);
  });

  /* The carrying over: a plate somebody dragged off the old stack is still
     where they left it, and one nobody moved is still in the stack. */
  test("a timeline's own old spot seeds its plate", () => {
    expect(seedOf({ glassX: 30, glassY: 40 })).toEqual({ glassX: 30, glassY: 40 });
    expect(seedOf({ glassX: null, glassY: null })).toEqual({ glassX: null, glassY: null });
    expect(seedOf({ glassX: 30, glassY: null })).toEqual({ glassX: null, glassY: null });
  });

  test("the stack lets go of a taken-down plate's moves", () => {
    const gone = new Set(["a"]);
    expect(plateOfGone({ at: "widget", id: "a" }, gone)).toBe(true);
    expect(plateOfGone({ at: "widget", id: "b" }, gone)).toBe(false);
    expect(plateOfGone({ at: "image", id: "a" }, gone)).toBe(false);
  });
});

/* ── the stack ─────────────────────────────────────────────────────────── */

describe("the stack hangs at the top of the home screen", () => {
  test("a column, centred, top first, the old layer's numbers", () => {
    const at = stackAt({ x: 100, y: 50, w: 1000 }, [
      { id: "a", w: 400, h: 120 },
      { id: "b", w: 600, h: 90 },
    ]);
    expect(at.a).toEqual({ x: 400, y: 50 + STACK_TOP });
    expect(at.b).toEqual({ x: 300, y: 50 + STACK_TOP + 120 + STACK_GAP });
  });

  test("an empty stack places nothing", () => {
    expect(stackAt({ x: 0, y: 0, w: 800 }, [])).toEqual({});
  });
});

/* ── going to the archive by itself ────────────────────────────────────── */

describe("a finished plate in the stack goes to the archive by itself", () => {
  const MIN = 60_000;
  const base = {
    state: "complete",
    endedAt: 1_000_000,
    updatedAt: 1_000_000,
    hang: "stack" as const,
    kept: false,
    after: 10 * MIN,
    seen: 0,
    now: 1_000_000 + 10 * MIN,
  };

  test("ten minutes after it finished", () => {
    expect(archiveDue(base)).toBe(true);
    expect(archiveDue({ ...base, now: base.now - 1 })).toBe(false);
  });

  test("never while it is live, or left", () => {
    expect(archiveDue({ ...base, state: "live" })).toBe(false);
    expect(archiveDue({ ...base, state: "left" })).toBe(false);
  });

  /* A plate you moved is a plate you kept. */
  test("never once it has been moved out of the stack", () => {
    expect(archiveDue({ ...base, hang: "glass" })).toBe(false);
    expect(archiveDue({ ...base, hang: "wall" })).toBe(false);
  });

  test("never when the knob says never", () => {
    expect(archiveDue({ ...base, after: null })).toBe(false);
  });

  /* Being looked at buys the whole delay again — and being away holds the
     clock (the caller marks every plate attended while it lasts), so nothing
     goes while nobody is there to see it. */
  test("the clock starts again from the last time it had your attention", () => {
    expect(archiveDue({ ...base, seen: base.now - 1 })).toBe(false);
    expect(archiveDue({ ...base, seen: base.now - 10 * MIN })).toBe(true);
  });

  test("a row with no end time counts from its last write", () => {
    expect(archiveDue({ ...base, endedAt: null })).toBe(true);
  });

  test("the knob reads as minutes, and anything unreadable is the default", () => {
    expect(archiveAfter({ [ARCHIVE]: "never" })).toBeNull();
    expect(archiveAfter({ [ARCHIVE]: "5" })).toBe(5 * MIN);
    expect(archiveAfter({ [ARCHIVE]: "15" })).toBe(15 * MIN);
    expect(archiveAfter({ [ARCHIVE]: "eventually" })).toBe(10 * MIN);
    expect(archiveAfter({})).toBe(10 * MIN);
  });
});
