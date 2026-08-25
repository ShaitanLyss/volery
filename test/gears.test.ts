import { describe, expect, test } from "bun:test";
import {
  afterAck,
  afterExit,
  afterInit,
  DEFAULT_GEAR,
  freshGear,
  gearOfModeAck,
  GEARS,
  gearOfInit,
  gearOfWire,
  isPlanDocument,
  planTitle,
  isGear,
  planFile,
  planRoot,
  readingOf,
  wireOf,
} from "../src/lib/gears";

describe("the two gears", () => {
  test("the wall's default is what every card was before this existed", () => {
    expect(DEFAULT_GEAR).toBe("making");
    expect(wireOf("making")).toBe("bypassPermissions");
    expect(wireOf("planning")).toBe("plan");
  });

  test("every gear has a reading, and they differ", () => {
    const names = GEARS.map((g) => readingOf(g).name);
    expect(new Set(names).size).toBe(GEARS.length);
    for (const g of GEARS) {
      expect(readingOf(g).note.length).toBeGreaterThan(0);
      /* Lowercase, quiet, sentence-shaped — the house voice. */
      expect(readingOf(g).note[0]).toBe(readingOf(g).note[0].toLowerCase());
    }
  });
});

describe("reading a mode off the wire", () => {
  test("only plan is planning", () => {
    expect(gearOfWire("plan")).toBe("planning");
  });

  test("the CLI's wider vocabulary all reads as making", () => {
    /* 2.1.241 offers these besides `plan`. The wall asks one question — can this
       card change the repository — and every one of them answers yes. */
    for (const mode of ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk"]) {
      expect(gearOfWire(mode)).toBe("making");
    }
  });

  test("and so does anything unrecognisable, rather than throwing", () => {
    for (const junk of ["", "PLAN", "planning", null, undefined, 42, {}]) {
      expect(gearOfWire(junk)).toBe("making");
    }
  });
});

describe("folding a system/init", () => {
  test("an init that names the mode gives the gear", () => {
    expect(gearOfInit({ subtype: "init", permissionMode: "plan" })).toBe("planning");
    expect(gearOfInit({ subtype: "init", permissionMode: "bypassPermissions" })).toBe("making");
  });

  /* The whole reason this returns null rather than defaulting: an init that
     says nothing must not flip a planning card back to making. */
  test("an init that says nothing about the mode changes nothing", () => {
    expect(gearOfInit({ subtype: "init", model: "claude-opus-5" })).toBeNull();
    expect(gearOfInit({})).toBeNull();
    expect(gearOfInit(null)).toBeNull();
    expect(gearOfInit(undefined)).toBeNull();
    expect(gearOfInit({ permissionMode: 7 })).toBeNull();
  });
});

describe("the document a planning turn leaves behind", () => {
  test("a plan write is recognised, on either separator", () => {
    expect(
      isPlanDocument("C:\\Users\\x\\.claude\\plans\\create-a-file-imperative-gem.md"),
    ).toBe(true);
    expect(isPlanDocument("/home/x/.claude/plans/some-plan.md")).toBe(true);
  });

  test("and nothing else is", () => {
    for (const path of [
      "C:\\Users\\x\\workbench\\skein\\src\\lib\\gears.ts",
      "/home/x/.claude/plans/notes.txt",
      "/home/x/.claude/settings.json",
      "/home/x/plans/thing.md",
      "/home/x/.claude/plansible/thing.md",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isPlanDocument(path)).toBe(false);
    }
  });

  test("the slug reads as a title", () => {
    expect(planTitle("C:\\Users\\x\\.claude\\plans\\guard-the-shared-index.md")).toBe(
      "guard the shared index",
    );
    expect(planTitle("/home/x/.claude/plans/a.md")).toBe("a");
  });

  test("a long slug trails off rather than being cut mid-word-count", () => {
    const long = planTitle(
      "/p/.claude/plans/" + "extremely-long-summary-of-what-was-asked-for-here-imperative-gem.md",
    );
    expect(long.length).toBeLessThanOrEqual(52);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a path with no name at all still says something", () => {
    expect(planTitle("/p/.claude/plans/.md")).toBe("a plan");
  });
});

describe("guarding a typed value", () => {
  test("the wall's own gears pass", () => {
    for (const g of GEARS) expect(isGear(g)).toBe(true);
  });

  test("and a typo does not, so `/gear planing` changes nothing", () => {
    for (const junk of ["planing", "plan", "Making", "", null, undefined, 3, {}]) {
      expect(isGear(junk)).toBe(false);
    }
  });
});

describe("pointing the viewer at a plan", () => {
  /* `find.rs::safe_join` refuses an absolute path and anything climbing out of
     its root. A plan lives outside every project, so the viewer is re-rooted
     rather than the guard widened. */
  test("a windows path splits into a root the viewer accepts and a name", () => {
    const p = "C:\\Users\\x\\.claude\\plans\\guard-the-index.md";
    expect(planRoot(p)).toBe("C:/Users/x/.claude/plans");
    expect(planFile(p)).toBe("guard-the-index.md");
  });

  test("and a posix one", () => {
    const p = "/home/x/.claude/plans/guard-the-index.md";
    expect(planRoot(p)).toBe("/home/x/.claude/plans");
    expect(planFile(p)).toBe("guard-the-index.md");
  });

  test("the name never contains a separator, which is what the guard checks", () => {
    for (const p of [
      "C:\\Users\\x\\.claude\\plans\\a.md",
      "/home/x/.claude/plans/a.md",
      "a.md",
    ]) {
      expect(planFile(p)).not.toInclude("/");
      expect(planFile(p)).not.toInclude("\\");
    }
  });

  test("a bare name has no root, and asking for one gives nothing to open", () => {
    expect(planRoot("a.md")).toBe("");
    expect(planFile("a.md")).toBe("a.md");
  });
});

describe("reading an acknowledgement off a control_response", () => {
  const ack = (mode: string) => ({
    type: "control_response",
    response: { subtype: "success", request_id: "skein-mode-1", response: { mode } },
  });

  test("a success carrying a mode is the gear", () => {
    expect(gearOfModeAck(ack("plan"))).toBe("planning");
    expect(gearOfModeAck(ack("bypassPermissions"))).toBe("making");
  });

  test("a failure has changed nothing, so it says nothing", () => {
    expect(
      gearOfModeAck({
        type: "control_response",
        response: { subtype: "error", error: "nope", response: { mode: "plan" } },
      }),
    ).toBeNull();
  });

  test("an interrupt's receipt is not about the gear", () => {
    expect(
      gearOfModeAck({
        type: "control_response",
        response: { subtype: "success", response: { still_queued: [], cancelled: [] } },
      }),
    ).toBeNull();
  });

  test("and neither is anything else on the stream", () => {
    for (const ev of [
      { type: "system", subtype: "init", permissionMode: "plan" },
      { type: "result" },
      { type: "control_response" },
      {},
      null,
      undefined,
    ]) {
      expect(gearOfModeAck(ev)).toBeNull();
    }
  });
});

describe("the two events disagree, and the acknowledgement wins", () => {
  /* The measured sequence this exists for: mode set to plan at 15.13s and
     acknowledged; an init at 17.76s saying bypassPermissions, because it
     belonged to a turn asked for at 0.06s. Folding that init flips the card. */
  test("a stale init does not undo an acknowledged change", () => {
    let s = freshGear("making");
    s = afterAck(s, "planning");
    expect(s.gear).toBe("planning");

    s = afterInit(s, "making"); // the in-flight turn's init
    expect(s.gear).toBe("planning");
    expect(s.pending).toBe("planning");
  });

  test("the init that agrees clears the doubt", () => {
    let s = afterAck(freshGear("making"), "planning");
    s = afterInit(s, "planning");
    expect(s).toEqual({ gear: "planning", pending: null });
  });

  test("after which an init folds normally again", () => {
    /* Which is what keeps a card put into planning by something that is not
       Volery drawn correctly. */
    let s = afterInit(afterAck(freshGear("making"), "planning"), "planning");
    s = afterInit(s, "making");
    expect(s).toEqual({ gear: "making", pending: null });
  });

  test("with nothing outstanding, an init is simply believed", () => {
    expect(afterInit(freshGear("making"), "planning")).toEqual({
      gear: "planning",
      pending: null,
    });
  });

  test("a second acknowledgement supersedes the first", () => {
    let s = afterAck(freshGear("making"), "planning");
    s = afterAck(s, "making");
    expect(s).toEqual({ gear: "making", pending: "making" });
  });

  /* Or a change that never took effect would deafen the card to every init for
     the rest of its life. */
  test("the process going clears the doubt but not the reading", () => {
    const s = afterExit(afterAck(freshGear("making"), "planning"));
    expect(s).toEqual({ gear: "planning", pending: null });
  });
});
