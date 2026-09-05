import { describe, expect, test } from "bun:test";
import {
  absence,
  editorOptions,
  isLive,
  isProblem,
  keeping,
  lastProblem,
  lastSeen,
  parseLine,
  pulseOf,
  rowsOf,
  shortCategory,
  standing,
  tally,
  timeOf,
  type Editor,
  type UeLine,
} from "../src/lib/unreallog";

function editor(over: Partial<Editor> = {}): Editor {
  return {
    id: "C:\\dev\\Caravan",
    project: "Caravan",
    name: "Caravan",
    open: true,
    mcpPort: 30069,
    engine: true,
    log: [],
    ...over,
  };
}

const ue = (over: Partial<UeLine> = {}): UeLine => ({
  stamp: null,
  frame: null,
  category: "LogTemp",
  verbosity: "log",
  text: "something",
  ...over,
});

/* ── taking a line apart ───────────────────────────────────────────────────
 *
 * Forty columns of prefix on a face three hundred pixels wide, which is the
 * whole reason the parse exists. Every shape below is one `FOutputDeviceFile`
 * actually writes. */

describe("an editor log line, as the file holds it", () => {
  test("the full form: stamp, frame, category, verbosity", () => {
    expect(parseLine("[2026.08.21-14.32.10:123][456]LogTemp: Warning: it broke")).toEqual(
      {
        stamp: "2026.08.21-14.32.10:123",
        frame: 456,
        category: "LogTemp",
        verbosity: "warning",
        text: "it broke",
      },
    );
  });

  /* Unreal pads the frame counter, and pads it to nothing before the first
     tick — which is where every startup line lives. */
  test("a padded frame counter, which is where the whole startup lives", () => {
    expect(parseLine("[2026.08.21-14.32.10:123][  0]LogInit: Display: RandInit").frame)
      .toBe(0);
  });

  /* Not a fallback: Unreal writes `LogTemp: Display: x` for Display and plain
     `LogTemp: x` for Log verbosity, so an unmarked line is a Log line rather
     than an unparsed one. Most of the file is this shape. */
  test("no verbosity written means Log verbosity, which is most lines", () => {
    const l = parseLine("[2026.08.21-14.32.10:123][456]LogTemp: routine business");
    expect(l.verbosity).toBe("log");
    expect(l.category).toBe("LogTemp");
    expect(l.text).toBe("routine business");
  });

  test("under -NoLogTimes there is no stamp and the rest still parses", () => {
    expect(parseLine("LogAutomationTest: Error: Expected 3, got 4")).toEqual({
      stamp: null,
      frame: null,
      category: "LogAutomationTest",
      verbosity: "error",
      text: "Expected 3, got 4",
    });
  });

  /* A line that opens with a bare verbosity and no category parses into the
     *category* slot, because that is the slot that comes first. Moving it is
     the whole of the fix. */
  test("a bare verbosity is a verbosity, not a category called Warning", () => {
    const l = parseLine("Warning: something the engine said without a category");
    expect(l.category).toBeNull();
    expect(l.verbosity).toBe("warning");
    expect(l.text).toBe("something the engine said without a category");
  });

  /* The stamp is anchored on its four-digit year rather than being any run of
     digits and dots. Otherwise a frame with no timestamp has its frame read as
     the stamp and then reports no frame at all — one wrong field standing in for
     another, which is the worst kind of parse to debug from a screenshot. */
  test("a frame with no stamp is a frame", () => {
    const l = parseLine("[456]LogTemp: x");
    expect(l.stamp).toBeNull();
    expect(l.frame).toBe(456);
  });

  /* Ordinary prose keeps its colons. `Total` is followed by a space, and the
     category group demands the colon immediately. */
  test("a sentence with a colon in it is not a category", () => {
    const l = parseLine("Total time in Pipeline: 41.3 s");
    expect(l.category).toBeNull();
    expect(l.text).toBe("Total time in Pipeline: 41.3 s");
  });

  test("a bracketed thing that is not a stamp is left in the text", () => {
    expect(parseLine("[SM5] Shader compile complete").text).toBe(
      "[SM5] Shader compile complete",
    );
  });

  test("VeryVerbose folds into verbose, which is the only place it is drawn", () => {
    expect(parseLine("LogSlate: VeryVerbose: tick").verbosity).toBe("verbose");
    expect(parseLine("LogSlate: Verbose: tick").verbosity).toBe("verbose");
  });

  test("Fatal is its own thing and reads as an error", () => {
    expect(parseLine("LogWindows: Fatal: Assertion failed").verbosity).toBe("fatal");
    expect(isProblem(parseLine("LogWindows: Fatal: Assertion failed"))).toBe(true);
  });

  test("an empty line survives being parsed", () => {
    expect(parseLine("")).toEqual({
      stamp: null,
      frame: null,
      category: null,
      verbosity: "log",
      text: "",
    });
  });
});

/* ── what the readings count ───────────────────────────────────────────── */

describe("what is wrong, and how much of it", () => {
  const log = [
    ue({ verbosity: "log" }),
    ue({ verbosity: "warning", text: "deprecated" }),
    ue({ verbosity: "display" }),
    ue({ verbosity: "error", text: "asset failed to load" }),
    ue({ verbosity: "warning", text: "also deprecated" }),
  ];

  test("errors and warnings, and fatal counted as an error", () => {
    expect(tally(log)).toEqual({ errors: 1, warnings: 2 });
    expect(tally([ue({ verbosity: "fatal" })])).toEqual({ errors: 1, warnings: 0 });
  });

  test("a clean session counts to nothing rather than failing to count", () => {
    expect(tally([ue(), ue({ verbosity: "display" })])).toEqual({
      errors: 0,
      warnings: 0,
    });
  });

  /* The last one, not the worst one: this is the reading that answers "what has
     just gone wrong", and a screenful of warnings after an error you have
     already dealt with is not it. */
  test("the last problem is the most recent one, whatever its verbosity", () => {
    expect(lastProblem(log)?.text).toBe("also deprecated");
  });

  test("nothing wrong is null rather than a made-up line", () => {
    expect(lastProblem([ue(), ue({ verbosity: "display" })])).toBeNull();
    expect(lastProblem([])).toBeNull();
  });

  test("problems narrows to the three loud verbosities", () => {
    expect(keeping("all")).toBeNull();
    expect(log.filter(keeping("problems")!)).toHaveLength(3);
  });
});

/* ── what the gutter says ──────────────────────────────────────────────── */

describe("a category, shortened to what it is worth", () => {
  /* Three columns off every line, which on a face this narrow is three columns
     of the message. */
  test("the Log every category starts with comes off", () => {
    expect(shortCategory("LogTemp")).toBe("Temp");
    expect(shortCategory("LogAutomationTest")).toBe("AutomationTest");
  });

  /* The handful that do not follow the convention are left exactly as they are
     rather than being mangled to fit a rule they were never in. */
  test("one that does not follow the convention is left alone", () => {
    expect(shortCategory("Cmd")).toBe("Cmd");
    expect(shortCategory("Log")).toBe("Log");
    expect(shortCategory(null)).toBeNull();
  });
});

describe("the clock out of a stamp", () => {
  /* The date is today — this is a log of a process that is running — and the
     milliseconds are for diffing two logs rather than reading one. */
  test("eight characters you would actually use", () => {
    expect(timeOf("2026.08.21-14.32.10:123")).toBe("14:32:10");
  });

  test("no stamp is no time, rather than a zero", () => {
    expect(timeOf(null)).toBeNull();
    expect(timeOf("not a stamp")).toBeNull();
  });
});

describe("editor lines as the shared tail draws them", () => {
  const lines = [
    parseLine("[2026.08.21-14.32.10:123][456]LogTemp: Warning: deprecated"),
    parseLine("[2026.08.21-14.32.11:001][457]LogCore: Error: nope"),
  ];

  test("the short category in the gutter, and the tone the writer claimed", () => {
    expect(rowsOf(lines, false)).toEqual([
      { mark: "Temp", tone: "warn", text: "deprecated" },
      { mark: "Core", tone: "fail", text: "nope" },
    ]);
  });

  /* Off by default: eight characters is still an eighth of the face, and it is
     only worth it when you are lining this up against a build that failed at
     about the same moment. */
  test("the time joins the gutter only when it was asked for", () => {
    expect(rowsOf(lines, true)[0].mark).toBe("14:32:10 Temp");
  });

  test("a line with no category still gets whichever mark there is", () => {
    expect(rowsOf([parseLine("[SM5] compiling")], false)[0].mark).toBeNull();
  });
});

/* ── the button, and what it opens ─────────────────────────────────────── */

describe("an editor that is not open says so and offers to be", () => {
  /* Unlike the build log, this *does* replace the reading: the lines are a
     previous session's and the useful gesture is a new one. Which is the server
     log's answer to a group that has exited, one subject over. */
  test("a closed editor is a down state with a button", () => {
    expect(standing(editor({ open: false }))?.verb).toBe("open the editor");
  });

  /* The whole reason to open it from here rather than from the taskbar: this app
     only ever opens one with `-ModelContextProtocolStartServer` and the port
     from the committed `.mcp.json`, so the editor this starts is one the cards
     on the wall can talk to. Worth saying rather than leaving as a surprise. */
  test("the word says the mcp server is part of the offer", () => {
    expect(standing(editor({ open: false }))?.word).toContain("mcp server on :30069");
  });

  test("a project with no committed port just says the editor is not open", () => {
    const s = standing(editor({ open: false, mcpPort: null }));
    expect(s?.word).toBe("editor not open");
    expect(s?.verb).toBe("open the editor");
  });

  /* Every Unreal command is `<engine>\\Engine\\...`, so without the engine root
     there is nothing to launch and a button would be a lie. */
  test("a project whose engine would not resolve offers nothing to press", () => {
    const s = standing(editor({ open: false, engine: false }));
    expect(s?.verb).toBeNull();
    expect(s?.word).toContain("EngineAssociation");
  });

  /* Open, and the reading is the lines. A widget narrating "it is running" over
     the top of its own output is a label on a window. */
  test("an open editor is left to speak for itself", () => {
    expect(standing(editor())).toBeNull();
  });
});

describe("which editor the wall follows, and how it reads", () => {
  test("the one that is up", () => {
    expect(isLive(editor({ open: true }))).toBe(true);
    expect(isLive(editor({ open: false }))).toBe(false);
  });

  /* And when none is, the one whose lines are still worth reading. Without this
     a follower took the first project on the wall the moment the editor closed
     — throwing away the session this file deliberately keeps. Coarse on
     purpose: an `Editor` carries no clock, so all it can say is that this one
     spoke. */
  test("a closed editor that has spoken outranks one that never has", () => {
    expect(lastSeen(editor({ open: false, log: [ue()] }))).toBe(1);
    expect(lastSeen(editor({ open: false, log: [] }))).toBe(0);
  });

  test("open is live and closed is idle rather than dead", () => {
    expect(pulseOf(editor({ open: true }))).toBe("live");
    expect(pulseOf(editor({ open: false }))).toBe("idle");
  });

  test("the menu offers the unreal projects by name", () => {
    expect(editorOptions([editor({ id: "a", project: "Caravan" })])).toEqual([
      { value: "a", label: "Caravan" },
    ]);
  });

  test("the two absences are two different things to say", () => {
    expect(absence("gone")).toContain("not on the wall any more");
    expect(absence("none")).toContain("no unreal projects");
  });
});
