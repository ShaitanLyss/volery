import { expect, test, describe } from "bun:test";
import {
  actionsFor,
  automationStep,
  conflictBadge,
  conflictPrompt,
  liveCodingStep,
  managerFromField,
  progressFrom,
  refocusStep,
  scriptArgv,
  tagMark,
  tallyNote,
  LIVE_CODING,
  NO_FOCUS,
  NO_STATUS,
  NO_TALLY,
  type ProjectFacts,
  type ProjectStatus,
  type Step,
} from "../src/lib/actions";

const bare: ProjectFacts = {
  root: "C:\\atelier\\thing",
  manager: "pnpm",
  scripts: [],
  node: false,
  tauri: false,
  cargo: false,
  git: false,
  unreal: null,
  /* Nothing here declares a version, so no project in this file offers a bump.
     That verb has its own suite — `test/bump.test.ts`. */
  versions: [],
};

const node = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  ...bare,
  node: true,
  scripts: ["dev", "build", "test"],
  ...over,
});

const unreal = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  ...bare,
  root: "C:\\atelier\\caravan",
  unreal: {
    uproject: "C:\\atelier\\caravan\\Caravan.uproject",
    name: "Caravan",
    engine: "C:\\Program Files\\Epic Games\\UE_5.8",
    mcpPort: 7245,
    log: "C:\\atelier\\caravan\\Saved\\Logs\\Caravan.log",
  },
  ...over,
});

const open: ProjectStatus = { ...NO_STATUS, editorPid: 4242 };

const ids = (f: ProjectFacts, s: ProjectStatus = NO_STATUS) =>
  actionsFor(f, s).map((a) => a.id);

const argvOf = (f: ProjectFacts, id: string, s: ProjectStatus = NO_STATUS) => {
  const step = actionsFor(f, s).find((a) => a.id === id)?.steps[0];
  return step && step.kind === "run" ? step.argv : null;
};

const kinds = (f: ProjectFacts, id: string, s: ProjectStatus = NO_STATUS) =>
  actionsFor(f, s)
    .find((a) => a.id === id)!
    .steps.map((x: Step) => x.kind);

describe("what a project offers", () => {
  test("a folder with nothing in it offers nothing", () => {
    expect(actionsFor(bare)).toEqual([]);
  });

  test("a node project offers the scripts it actually has", () => {
    expect(ids(node({ scripts: ["dev", "build"] }))).toEqual(["build"]);
    expect(ids(node({ scripts: ["dev"] }))).toEqual([]);
  });

  /* The default the user asked for out loud: pnpm unless the repo says
     otherwise, because npm is what gets typed by habit and not by choice. */
  test("pnpm is what a script runs as", () => {
    expect(argvOf(node(), "build")).toEqual(["pnpm", "run", "build"]);
    expect(argvOf(node({ manager: "bun" }), "test")).toEqual(["bun", "run", "test"]);
  });

  test("only npm needs the -- before forwarded arguments", () => {
    expect(scriptArgv("pnpm", "tauri", ["build"])).toEqual(["pnpm", "run", "tauri", "build"]);
    expect(scriptArgv("bun", "tauri", ["build"])).toEqual(["bun", "run", "tauri", "build"]);
    expect(scriptArgv("npm", "tauri", ["build"])).toEqual([
      "npm", "run", "tauri", "--", "build",
    ]);
    /* …and not when there is nothing to forward, or npm run build becomes
       `npm run build --`. */
    expect(scriptArgv("npm", "build")).toEqual(["npm", "run", "build"]);
  });

  test("packageManager pins the dialect, and anything unrecognised does not", () => {
    expect(managerFromField("pnpm@9.1.0")).toBe("pnpm");
    expect(managerFromField("yarn@4.0.0+sha512.deadbeef")).toBe("yarn");
    expect(managerFromField("corepack@1")).toBeNull();
    expect(managerFromField(null)).toBeNull();
  });

  /* A Tauri app's build and its bundle are hours apart; giving them the same
     word would make one of them a surprise. */
  test("a tauri app ships the bundle and builds the front end", () => {
    const f = node({ tauri: true, scripts: ["dev", "build", "test", "tauri"] });
    expect(ids(f)).toEqual(["build", "test", "ship"]);
    expect(argvOf(f, "build")).toEqual(["pnpm", "run", "build"]);
    expect(argvOf(f, "ship")).toEqual(["pnpm", "run", "tauri", "build"]);
  });

  test("a bare cargo project gets the three cargo verbs", () => {
    expect(ids({ ...bare, cargo: true })).toEqual(["build", "test", "ship"]);
    expect(argvOf({ ...bare, cargo: true }, "ship")).toEqual([
      "cargo", "build", "--release",
    ]);
  });
});

describe("push and pull", () => {
  const repo = { ...bare, git: true };
  const tracking = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
    ...NO_STATUS, upstream: true, branch: "main", ...over,
  });

  /* The presence of either chip is the news — a pull chip means somebody
     pushed, read from across the wall without reading the label. */
  test("a branch level with its remote offers neither", () => {
    expect(ids(repo, tracking())).toEqual([]);
  });

  test("what is ahead is on the chip", () => {
    const [push] = actionsFor(repo, tracking({ ahead: 3 }));
    expect(push.id).toBe("push");
    expect(push.label).toBe("push ↑3");
    expect(push.title).toBe("3 commits to push on main");
  });

  test("what a fetch found is on the chip", () => {
    const [pull] = actionsFor(repo, tracking({ behind: 1 }));
    expect(pull.id).toBe("pull");
    expect(pull.label).toBe("pull ↓1");
    expect(pull.title).toBe("1 commit to pull on main");
  });

  /* Pull first, since that is the order the work has to happen in. */
  test("a diverged branch offers both, and says so on each", () => {
    const s = tracking({ ahead: 2, behind: 5 });
    expect(ids(repo, s)).toEqual(["pull", "push"]);
    expect(actionsFor(repo, s)[0].title).toContain("diverged");
    expect(actionsFor(repo, s)[1].title).toContain("pull first");
  });

  /* A merge left half-done is a conflicted tree, and the agents on this wall
     are editing these repos with permissions skipped. A refusal is a message. */
  test("pull is fast-forward only, so it can never leave a merge open", () => {
    expect(argvOf(repo, "pull", tracking({ behind: 1 }))).toEqual([
      "git", "pull", "--ff-only",
    ]);
  });

  /* Where an untracked branch goes is a decision, and git guessing it is how
     work lands on the wrong remote. */
  test("a branch with no upstream is published rather than pushed", () => {
    const s = { ...NO_STATUS, branch: "spike" };
    expect(argvOf(repo, "push", s)).toEqual(["git", "push", "-u", "origin", "HEAD"]);
    expect(actionsFor(repo, s)[0].label).toBe("publish");
  });

  /* With no upstream there is no `branch.ab` to count against, so an ahead of
     zero is the absence of an answer rather than the answer "nothing" — the one
     case where the chip shows without a count behind it. */
  test("an untracked branch still offers to publish, counting nothing", () => {
    expect(ids(repo, { ...NO_STATUS, branch: "spike" })).toEqual(["push"]);
  });

  /* `NO_STATUS` is what a territory holds between appearing and its first poll,
     and a detached HEAD reports no branch at all. Publishing either would push
     something nobody named. */
  test("nothing is offered until the poll has answered, or off a branch", () => {
    expect(ids(repo, NO_STATUS)).toEqual([]);
    expect(ids(repo, { ...NO_STATUS, branch: null, ahead: 2 })).toEqual([]);
  });

  /* ── what rides along ──────────────────────────────────────────────────
     `bump` writes a commit *and* an annotated tag, and `git push` alone leaves
     the tag behind — the release goes out with no tag on it and the chip
     disappears, which reads as done. `--follow-tags` fixes the push; naming the
     tag on the label is what makes the flag safe to pass, since this is the one
     gesture in the row that reaches another machine. */

  test("the tag a bump wrote is named on the chip and carried by the push", () => {
    const s = tracking({ ahead: 1, unpushedTags: ["v0.11.3"] });
    const [push] = actionsFor(repo, s);
    expect(push.label).toBe("push ↑1 +v0.11.3");
    expect(push.title).toBe("1 commit to push on main, carrying v0.11.3");
    expect(argvOf(repo, "push", s)).toEqual(["git", "push", "--follow-tags"]);
  });

  /* Three names do not fit on a chip, and a chip that grows to fit its contents
     is a row that reflows every time you commit. The tooltip still lists them,
     because "+3 tags" is the one label you would actually want to check. */
  test("several tags are counted, and still named in the tooltip", () => {
    const [push] = actionsFor(
      repo,
      tracking({ ahead: 2, unpushedTags: ["v0.9.0", "v0.10.0", "v0.11.0"] }),
    );
    expect(push.label).toBe("push ↑2 +3 tags");
    expect(push.title).toContain("v0.9.0, v0.10.0, v0.11.0");
  });

  /* Probed: `git push --follow-tags` sends an annotated tag even when the branch
     is up to date. So a tag on an already-pushed commit is genuinely pushable,
     and without this the chip is absent and the tag has no way off the wall. */
  test("a tag alone draws the chip, with nothing counted ahead", () => {
    const s = tracking({ ahead: 0, unpushedTags: ["v0.11.3"] });
    expect(ids(repo, s)).toEqual(["push"]);
    const [push] = actionsFor(repo, s);
    expect(push.label).toBe("push +v0.11.3");
    /* No "↑0" anywhere, and the title says what is true rather than counting to
       zero — a chip reading "push ↑0" is a chip that looks broken. */
    expect(push.label).not.toContain("↑");
    expect(push.title).toBe("nothing to push on main, carrying v0.11.3");
  });

  test("no tags leaves the label exactly as it was", () => {
    expect(actionsFor(repo, tracking({ ahead: 3 }))[0].label).toBe("push ↑3");
    expect(actionsFor(repo, tracking({ ahead: 3, unpushedTags: [] }))[0].label).toBe("push ↑3");
  });

  /* The one place the two push chips differ, and it is deliberate. With no
     upstream there is no ref to measure "not pushed yet" against, so
     `project.rs` reads no tags and this chip cannot name what it would send.
     Nothing is stranded: publishing gives the branch an upstream, and a tag left
     behind draws its own `push +v…` on the next poll. */
  test("publish carries no tags, because it cannot say which", () => {
    const s = { ...NO_STATUS, branch: "spike", unpushedTags: ["v0.11.3"] };
    expect(argvOf(repo, "push", s)).toEqual(["git", "push", "-u", "origin", "HEAD"]);
    expect(actionsFor(repo, s)[0].label).toBe("publish");
  });

  /* Off a branch there is nothing to push and nothing to tag against, and a tag
     must not be the thing that resurrects a chip a detached HEAD should not
     have. */
  test("a tag does not draw the chip off a branch, or before the first poll", () => {
    expect(ids(repo, { ...NO_STATUS, unpushedTags: ["v1.0.0"] })).toEqual([]);
    expect(
      ids(repo, { ...NO_STATUS, upstream: true, branch: null, unpushedTags: ["v1.0.0"] }),
    ).toEqual([]);
  });
});

describe("tagMark", () => {
  test("names one, counts many, says nothing about none", () => {
    expect(tagMark([])).toBe("");
    expect(tagMark(["v1.0.0"])).toBe(" +v1.0.0");
    expect(tagMark(["v1.0.0", "v1.1.0"])).toBe(" +2 tags");
  });
});

describe("conflicts", () => {
  const torn = (over: Partial<ProjectStatus> = {}): ProjectStatus => ({
    ...NO_STATUS,
    branch: "main",
    conflicts: 3,
    conflictPaths: ["src/a.rs", "src/b.rs", "src/c.rs"],
    operation: "merge",
    ...over,
  });

  test("a whole repo has no badge at all", () => {
    expect(conflictBadge(NO_STATUS)).toBeNull();
    expect(conflictBadge({ ...NO_STATUS, dirty: true, ahead: 4 })).toBeNull();
  });

  test("the badge counts, and names what it can", () => {
    const b = conflictBadge(torn())!;
    expect(b.label).toBe("3 conflicts");
    expect(b.title).toContain("a merge");
    expect(b.title).toContain("src/a.rs");
  });

  /* The path list is capped in project.rs, so a badge that showed three of
     forty and stopped would read as a badge that meant three. */
  test("a capped list says how much it is not showing", () => {
    const b = conflictBadge(torn({ conflicts: 40 }))!;
    expect(b.label).toBe("40 conflicts");
    expect(b.title).toContain("and 37 more");
  });

  test("one conflict is not one conflicts", () => {
    expect(conflictBadge(torn({ conflicts: 1 }))!.label).toBe("1 conflict");
  });

  /* The single most useful thing this prompt carries. In a rebase git replays
     your commits onto the other branch, so `ours` is the *other* branch — an
     agent that assumes merge semantics takes the wrong side with confidence. */
  test("a rebase is told that ours and theirs are the other way round", () => {
    const p = conflictPrompt(torn({ operation: "rebase" }));
    expect(p).toContain("the opposite of a merge");
    expect(p).toContain("git rebase --continue");
  });

  test("a merge is told which branch it is standing on", () => {
    const p = conflictPrompt(torn());
    expect(p).toContain("`main`, where you are standing");
    expect(p).not.toContain("the opposite of a merge");
    expect(p).toContain("git merge --continue");
  });

  /* Conflicts with no marker left is a real state — `git checkout --merge`, or
     a half-cleaned rebase — and the prompt has to stay a sentence through it. */
  test("an unnamed operation still reads as English and promises no --continue", () => {
    const p = conflictPrompt(torn({ operation: null }));
    expect(p).toContain("an operation that did not finish");
    expect(p).not.toContain("--continue");
    expect(p).toContain("do **not** commit");
  });

  /* The whole point: the ask is about intent, not about deleting markers. */
  test("the prompt asks for intent, refuses a coin toss, and stops before history", () => {
    const p = conflictPrompt(torn());
    expect(p).toContain("trying to do");
    expect(p).toContain("git log --merge");
    expect(p).toContain("neither side verbatim");
    expect(p).toContain("stop and ask me");
    expect(p).toContain("do **not** commit");
    /* It never lists the paths itself — the capped list would quietly lie
       about a forty-file conflict, and the agent is standing in the repo. */
    expect(p).toContain("--diff-filter=U");
    expect(p).not.toContain("src/a.rs");
  });

  /* `send` titles an untitled card from the first 42 characters, so the opening
     has to survive being cut there. */
  test("the first line reads as a card title", () => {
    expect(conflictPrompt(torn()).slice(0, 42)).toBe(
      "resolve the 3 conflicts in this repository",
    );
  });
});

describe("unreal", () => {
  test("with the editor closed everything is a process", () => {
    expect(ids(unreal())).toEqual(["editor", "build", "test", "ship"]);
    expect(kinds(unreal(), "editor")).toEqual(["launch-editor"]);
    expect(kinds(unreal(), "build")).toEqual(["run"]);
    expect(kinds(unreal(), "test")).toEqual(["run"]);
  });

  /* UBT refuses an external build of the editor target while the editor holds
     the Live Coding mutex, so with it open `build` has to mean something else
     entirely — and a headless test run would boot a second editor for nothing. */
  test("with the editor open, build and test go to the editor", () => {
    expect(ids(unreal(), open)).toEqual(["editor", "build", "cycle", "test", "ship"]);
    expect(kinds(unreal(), "build", open)).toEqual(["live-coding"]);
    expect(kinds(unreal(), "test", open)).toEqual(["automation"]);
    expect(kinds(unreal(), "editor", open)).toEqual(["focus-editor"]);
  });

  test("cycle exists only while there is an editor to cycle", () => {
    expect(ids(unreal())).not.toContain("cycle");
    expect(kinds(unreal(), "cycle", open)).toEqual([
      "close-editor", "run", "launch-editor",
    ]);
  });

  test("the build argv is the one UBT takes, with progress markers on", () => {
    const argv = argvOf(unreal(), "build")!;
    expect(argv[0]).toBe(
      "C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat",
    );
    expect(argv).toContain("CaravanEditor");
    expect(argv).toContain("-Project=C:\\atelier\\caravan\\Caravan.uproject");
    expect(argv).toContain("-Progress");
  });

  /* Every engine lives under `C:\Program Files\…`. An argv keeps that one
     token; a shell string would have to quote it, and cmd does not read the
     escaping a Windows argv is quoted with. */
  test("a path with a space in it stays one argument", () => {
    for (const id of ["build", "test", "ship"]) {
      const argv = argvOf(unreal(), id)!;
      expect(argv[0]).toContain("Program Files");
      expect(argv[0]).not.toContain('"');
    }
  });

  test("an engine that could not be resolved says so instead of pretending", () => {
    const f = unreal({
      unreal: { ...unreal().unreal!, engine: null },
      git: true,
    });
    expect(ids(f, { ...NO_STATUS, branch: "main" })).toEqual(["engine", "push"]);
    expect(actionsFor(f)[0].steps).toEqual([]);
  });
});

describe("reading progress out of the output", () => {
  test("a counted step is a fraction", () => {
    expect(progressFrom("[3/12] Compile [x64] CaravanCharacter.cpp")).toEqual({
      pct: 25,
      note: "Compile [x64] CaravanCharacter.cpp",
    });
  });

  test("UBT's own markers carry the message and the position", () => {
    expect(progressFrom("@progress 'Compiling C++ source code...' 40%")).toEqual({
      pct: 40,
      note: "Compiling C++ source code...",
    });
  });

  /* push/increment scope a sub-range: the number is a share of the whole, not a
     position in it. Read as absolute, the bar jumped to 5% and stopped. */
  test("a scoped marker never sets the position", () => {
    expect(progressFrom("@progress push 5%")?.pct ?? null).toBeNull();
    expect(progressFrom("@progress increment 1%")?.pct ?? null).toBeNull();
    expect(progressFrom("@progress pop")).toBeNull();
  });

  test("the cook counts itself", () => {
    expect(
      progressFrom(
        "LogCook: Display: Cooked packages 350 Packages Remain 350 Total 700",
      ),
    ).toEqual({ pct: 50, note: "cooked 350/700" });
  });

  test("no total is still a sign of life", () => {
    expect(progressFrom("   Compiling serde v1.0.203")).toEqual({
      pct: null,
      note: "Compiling serde v1.0.203",
    });
    expect(progressFrom("✓ 412 modules transformed.")).toEqual({
      pct: null,
      note: "412 modules transformed.",
    });
  });

  test("ordinary chatter says nothing", () => {
    expect(progressFrom("")).toBeNull();
    expect(progressFrom("  ➜  Local:   http://localhost:5173/")).toBeNull();
    expect(progressFrom("warning: unused variable `x`")).toBeNull();
  });

  test("a fraction never leaves 0..100", () => {
    const p = progressFrom("[14/12] Link Caravan.exe");
    expect(p?.pct).toBe(100);
  });
});

describe("what a running editor answers with", () => {
  const fold = (lines: string[]) => lines.reduce(liveCodingStep, LIVE_CODING);

  test("a patch that landed", () => {
    const v = fold([
      "LogLiveCoding: Display: Starting Live Coding compile",
      "LogLiveCoding: Display: Live coding succeeded",
    ]);
    expect(v).toMatchObject({ started: true, done: true, ok: true, stale: false });
  });

  /* A data-type change patches but does not take effect properly — saying
     "success" and nothing else is how you debug a stale editor for an hour. */
  test("a patch that changed data types is success with a warning", () => {
    const v = fold([
      "LogLiveCoding: Display: Starting Live Coding compile",
      "LogLiveCoding: Display: Live coding succeeded (data type changes detected)",
    ]);
    expect(v.ok).toBe(true);
    expect(v.stale).toBe(true);
    expect(v.note).toContain("cycle");
  });

  test("a failure is a failure whichever way it is worded", () => {
    for (const say of [
      "Live coding failed",
      "Live coding canceled",
      "Unable to start live coding",
    ]) {
      const v = fold([`LogLiveCoding: Error: ${say}`]);
      expect(v).toMatchObject({ done: true, ok: false });
    }
  });

  test("unrelated log chatter is not a verdict", () => {
    const v = fold(["LogTemp: Warning: Live coding succeeded"]);
    expect(v.done).toBe(false);
  });
});

describe("counting an automation run", () => {
  const fold = (lines: string[]) => lines.reduce(automationStep, NO_TALLY);

  test("a clean run", () => {
    const t = fold([
      "LogAutomationController: Found 3 automation tests based on 'Caravan'",
      "LogAutomationController: Test Completed. Result={Success} Name={A} Path={Caravan.A}",
      "LogAutomationController: Test Completed. Result={Success} Name={B} Path={Caravan.B}",
      "LogAutomationController: Test Completed. Result={Success} Name={C} Path={Caravan.C}",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
    ]);
    expect(t).toMatchObject({ total: 3, passed: 3, done: true });
    expect(tallyNote(t)).toBe("3/3 passed");
  });

  test("a failure keeps its path and its file and line", () => {
    const t = fold([
      "LogAutomationController: Found 2 automation tests based on 'Caravan'",
      "LogAutomationController: Test Completed. Result={Success} Name={A} Path={Caravan.A}",
      "LogAutomationController: Error: Expected 3 but got 4 [D:\\c\\Tests\\Cart.cpp(88)]",
      "LogAutomationController: Test Completed. Result={Fail} Name={B} Path={Caravan.Cart}",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
    ]);
    expect(t.failed).toEqual(["Caravan.Cart"]);
    expect(t.errors).toEqual(["D:\\c\\Tests\\Cart.cpp(88): Expected 3 but got 4"]);
    expect(tallyNote(t)).toBe("1/2 failed");
  });

  test("a filter that matched nothing is not a pass", () => {
    const t = fold(["LogAutomationController: Display: ...Automation Test Queue Empty"]);
    expect(t.done).toBe(true);
    expect(tallyNote(t)).toBe("no tests matched");
  });

  test("nothing accumulates after the queue empties", () => {
    const t = fold([
      "LogAutomationController: Found 1 automation tests based on 'Caravan'",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
      "LogAutomationController: Test Completed. Result={Success} Name={Z} Path={Other.Z}",
    ]);
    expect(t.passed).toBe(0);
  });
});

describe("coming back to the window", () => {
  /* The bump chip read a version once, when the project came onto the wall, and
     then said it forever — so a pull that brought in somebody else's release
     left the arc offering a bump that had already been made. Nothing emits an
     event when a file changes underneath us; focus is the event that already
     exists nearby. Two rules, both easy to get subtly wrong. */

  test("asks on the way in, never on the way out", () => {
    const a = refocusStep(NO_FOCUS, true, 1_000, 10_000);
    expect(a.ask).toBe(true);
    const b = refocusStep(a.next, false, 2_000, 10_000);
    expect(b.ask).toBe(false);
  });

  test("staying focused is not a transition", () => {
    const a = refocusStep(NO_FOCUS, true, 1_000, 10_000);
    /* The effect re-runs for reasons of its own; a reading that has not changed
       must not be a second ask. */
    expect(refocusStep(a.next, true, 500_000, 10_000).ask).toBe(false);
  });

  test("forty alt-tabs cost one pass", () => {
    let gate = NO_FOCUS;
    let asks = 0;
    for (let i = 0; i < 40; i++) {
      for (const focused of [true, false]) {
        const step = refocusStep(gate, focused, 1_000 + i * 100, 10_000);
        gate = step.next;
        if (step.ask) asks++;
      }
    }
    expect(asks).toBe(1);
  });

  test("the floor measures from the last yes, not the last reading", () => {
    /* Measuring from when it last *heard* would let a burst push the floor out
       ahead of itself forever, and the wall would never re-read at all. */
    let gate = refocusStep(NO_FOCUS, true, 500, 10_000).next;
    for (let t = 1_000; t < 10_000; t += 1_000) {
      gate = refocusStep(gate, false, t, 10_000).next;
      gate = refocusStep(gate, true, t, 10_000).next;
    }
    gate = refocusStep(gate, false, 10_501, 10_000).next;
    expect(refocusStep(gate, true, 10_501, 10_000).ask).toBe(true);
  });

  test("the first ask is not held behind a floor it has never met", () => {
    expect(refocusStep(NO_FOCUS, true, 0, 10_000).ask).toBe(true);
  });
});
