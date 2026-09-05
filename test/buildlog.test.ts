import { describe, expect, test } from "bun:test";
import {
  absence,
  diagnosticOf,
  isLive,
  keeping,
  lastRun,
  problems,
  projectOptions,
  pulseOf,
  rowsOf,
  standing,
  type Build,
} from "../src/lib/buildlog";

function build(over: Partial<Build> = {}): Build {
  return {
    id: "C:\\atelier\\skein",
    project: "skein",
    action: "build",
    state: "ok",
    pct: null,
    note: null,
    startedAt: 1000,
    endedAt: 2000,
    log: [],
    again: { id: "build", label: "build" },
    ...over,
  };
}

/* ── what a line is complaining about ──────────────────────────────────────
 *
 * The reading the whole widget is for, and the one place being too eager would
 * ruin it: a `problems` view that matched every line with the word "error" in it
 * would be a second copy of the log, and there would be no way to tell from
 * looking at it. So the false positives get as many tests as the true ones. */

describe("a compiler complaining, in every dialect this wall sees", () => {
  test("MSVC, which is what a UBT build is made of", () => {
    expect(diagnosticOf("PlatformMovementComponent.cpp(1047): error C2065: 'bLatch'"))
      .toBe("error");
    expect(diagnosticOf("Foo.cpp(12): warning C4996: 'strcpy': deprecated")).toBe(
      "warning",
    );
    expect(diagnosticOf("LINK : fatal error LNK1120: 3 unresolved externals")).toBe(
      "error",
    );
  });

  test("clang and gcc, which is what a Linux target is made of", () => {
    expect(diagnosticOf("foo.cpp:12:3: error: use of undeclared identifier")).toBe(
      "error",
    );
    expect(diagnosticOf("foo.cpp:12:3: warning: unused variable 'x'")).toBe("warning");
  });

  test("cargo, which is what half this repo is made of", () => {
    expect(diagnosticOf("error[E0308]: mismatched types")).toBe("error");
    expect(diagnosticOf("error: could not compile `skein` (lib)")).toBe("error");
    expect(diagnosticOf("warning: unused import: `std::fmt`")).toBe("warning");
  });

  test("UnrealBuildTool's own voice, and the editor's", () => {
    expect(diagnosticOf("ERROR: Unable to find plugin 'Foo'")).toBe("error");
    expect(diagnosticOf("EXEC : error : Failed to produce item")).toBe("error");
    expect(diagnosticOf("LogAutomationTest: Error: Expected 3, got 4")).toBe("error");
    expect(diagnosticOf("LogCook: Warning: Package failed to load")).toBe("warning");
  });

  test("the JavaScript toolchain's bracketed form", () => {
    expect(diagnosticOf("\u2718 [ERROR] Could not resolve \"./missing\"")).toBe("error");
    expect(diagnosticOf("[WARNING] chunk size exceeds 500 kB")).toBe("warning");
  });

  /* Every one of these contains the word and none of them is a diagnostic. A
     matcher that took them would put the entire log in the problems view. */
  test("prose with the word in it is not a diagnostic", () => {
    expect(diagnosticOf("   Compiling error-handling v0.3.1")).toBeNull();
    expect(diagnosticOf("1 error generated.")).toBeNull();
    expect(diagnosticOf("Total build time: 41.3 seconds (0 errors, 3 warnings)"))
      .toBeNull();
    expect(diagnosticOf("[3/9] Compile ErrorReport.cpp")).toBeNull();
    expect(diagnosticOf("Determining if the include file errno.h exists")).toBeNull();
  });

  /* A line can name both, and the more serious reading is the true one — this is
     the last line of a failed cargo build and it belongs in red. */
  test("a line that names both is read as the worse of the two", () => {
    expect(
      diagnosticOf("error: aborting due to 1 previous error; 3 warnings emitted"),
    ).toBe("error");
  });

  test("an ordinary line is getting on with it", () => {
    expect(diagnosticOf("@progress 'Compiling C++ source code...' 43%")).toBeNull();
    expect(diagnosticOf("")).toBeNull();
  });
});

describe("what the problems reading keeps", () => {
  const log = [
    "[1/3] Compile A.cpp",
    "A.cpp(4): warning C4996: deprecated",
    "[2/3] Compile B.cpp",
    "B.cpp(9): error C2065: 'x'",
  ];

  test("all is not a narrowing at all", () => {
    expect(keeping("all")).toBeNull();
  });

  test("problems is the two that complained", () => {
    expect(log.filter(keeping("problems")!)).toEqual([log[1], log[3]]);
  });

  /* Counted over the whole log rather than the drawn tail, which is what makes
     it worth having: "4 errors" on a pane showing one of them is the number that
     tells you to make the widget bigger. */
  test("the counts are of everything held, not of what fits", () => {
    expect(problems(log)).toEqual({ errors: 1, warnings: 1 });
    expect(problems([])).toEqual({ errors: 0, warnings: 0 });
  });
});

describe("build lines as the shared tail draws them", () => {
  /* No gutter mark: every line of one build came from the same place, and an
     action id repeated down the left edge is thirty columns of the same word on
     a face short of columns. The tone reaches the text instead. */
  test("no mark, and a tone that came from the line itself", () => {
    expect(rowsOf(["[1/3] Compile A.cpp", "B.cpp(9): error C2065: 'x'"])).toEqual([
      { mark: null, tone: "plain", text: "[1/3] Compile A.cpp" },
      { mark: null, tone: "fail", text: "B.cpp(9): error C2065: 'x'" },
    ]);
  });

  test("a warning is warn rather than fail", () => {
    expect(rowsOf(["A.cpp(4): warning C4996: x"])[0].tone).toBe("warn");
  });
});

/* ── the button, and the case it must not appear in ────────────────────── */

describe("a build with nothing to show says why", () => {
  /* The only down state. A project that has never run anything has genuinely
     nothing to read, and the button is the whole of what the widget can offer. */
  test("a project that has never built offers to", () => {
    expect(standing(build({ state: "idle", action: null }))).toEqual({
      word: "nothing built yet",
      verb: "build",
    });
  });

  /* **The opposite of what the server log decided about a crashed group**, and
     right for the same underlying reason. A dead server's log is stale and the
     useful gesture is to start it again; the log of a failed build holds the
     four lines you are looking for, and replacing it with a button would hide
     the answer behind the question. */
  test("a failed build is not down — its log is the entire point", () => {
    expect(standing(build({ state: "failed" }))).toBeNull();
  });

  test("nor is a cancelled one, whose partial log is still a log", () => {
    expect(standing(build({ state: "cancelled" }))).toBeNull();
    expect(standing(build({ state: "running" }))).toBeNull();
    expect(standing(build({ state: "ok" }))).toBeNull();
  });

  /* A word and no button. Drawn rather than hidden, the same way `actionsFor`
     draws a `no engine` chip: a project with no verbs is worth saying out loud,
     since the alternative is a widget that looks broken. */
  test("a project with nothing to build says so and offers nothing", () => {
    const s = standing(build({ state: "idle", action: null, again: null }));
    expect(s?.verb).toBeNull();
    expect(s?.word).toContain("nothing to build");
  });
});

describe("a build's dot", () => {
  /* A cancelled build is not a failure and must not go rust — the difference
     between it and a clean one is in the note, not in a colour. */
  test("running is live, failed is dead, and done is at rest either way", () => {
    expect(pulseOf("running")).toBe("live");
    expect(pulseOf("failed")).toBe("dead");
    expect(pulseOf("ok")).toBe("rest");
    expect(pulseOf("cancelled")).toBe("rest");
    expect(pulseOf("idle")).toBe("idle");
  });
});

describe("which build the wall follows", () => {
  test("live is a run in flight and nothing else", () => {
    expect(isLive(build({ state: "running" }))).toBe(true);
    expect(isLive(build({ state: "failed" }))).toBe(false);
    expect(isLive(build({ state: "ok" }))).toBe(false);
  });

  /* And then the half that was missing, which is sink f2cce1c8. `isLive` cannot
     keep the widget still once the run ends — it answers "is this one going",
     and the moment the answer is no everywhere, a follower with nothing else to
     go on takes the first project on the wall. `lastRun` is what it goes on. */
  test("a finished run is ranked by when it finished", () => {
    expect(lastRun(build({ startedAt: 1_000, endedAt: 4_000 }))).toBe(4_000);
  });

  test("one still going is ranked by when it started", () => {
    expect(lastRun(build({ state: "running", startedAt: 1_000, endedAt: null }))).toBe(1_000);
  });

  test("a project that has never run anything ranks nowhere at all", () => {
    expect(lastRun(build({ state: "idle", startedAt: null, endedAt: null }))).toBe(0);
  });

  /* The three together are the whole fix: the project that just finished
     compiling outranks the one that sorts first and has never built. */
  test("the build that just ended beats a project with no runs", () => {
    const done = build({ id: "b", state: "ok", startedAt: 1_000, endedAt: 4_000 });
    const never = build({ id: "a", state: "idle", startedAt: null, endedAt: null });
    expect(lastRun(done)).toBeGreaterThan(lastRun(never));
  });
});

describe("naming one", () => {
  test("the menu offers the projects by name", () => {
    expect(
      projectOptions([build({ id: "a", project: "skein" }), build({ id: "b", project: "caravan" })]),
    ).toEqual([
      { value: "a", label: "skein" },
      { value: "b", label: "caravan" },
    ]);
  });

  test("the two absences are two different things to say", () => {
    expect(absence("gone")).toContain("not on the wall any more");
    expect(absence("none")).toContain("no projects");
  });
});
