import { describe, expect, test } from "bun:test";
import {
  MAX_DETAIL,
  ago,
  detailOf,
  guard,
  reading,
  recognise,
  sameTree,
  segments,
  sentence,
  type GateRun,
} from "../src/lib/gates";

/** A settled run, so a test names only the field it is about. */
const run = (over: Partial<GateRun> = {}): GateRun => ({
  toolId: "toolu_01",
  card: "aaaaaaaa-1111-4111-8111-111111111111",
  cardName: "lucid otter",
  root: "C:/Users/lyss.delprat/workbench/skein",
  gate: "cargo-check",
  scope: "whole",
  narrowed: null,
  command: "cargo check --all-targets",
  startedAt: 1_000,
  settledAt: 2_000,
  outcome: "passed",
  detail: null,
  ...over,
});

describe("recognising a gate", () => {
  /* The commands this repository actually runs, out of its own CLAUDE.md. If
     the vocabulary ever drifts from what the project tells people to type, this
     is the test that says so. */
  test.each([
    ["bun run check", "check"],
    ["bun run test", "test"],
    ["bun run build", "build"],
    ["pnpm test", "test"],
    ["npm run check", "check"],
    ["cargo check --all-targets", "cargo-check"],
    ["cargo test", "cargo-test"],
    ["cargo clippy", "cargo-clippy"],
    ["bash tools/check-gnu.sh --profile test", "cargo-check"],
    ["uv run pytest tests/ -v", "pytest"],
    ["npx vitest run", "test"],
    ["tsc --noEmit", "check"],
  ])("%s is the %s gate", (command, gate) => {
    expect(recognise({ command })?.gate).toBe(gate);
  });

  test("a command running no gate is not one", () => {
    for (const command of [
      "git status --short",
      "ls src-tauri/src",
      "bun run tauri dev",
      "code .",
      "",
    ]) {
      expect(recognise({ command })).toBeNull();
    }
  });

  /* **The shape check, not the name.** `hooks.rs` registered a `PreToolUse`
     matcher on `"Bash"`, the Windows shell tool is called `PowerShell` on a
     fresh claude, and the mismatch made every hook in that module a silent
     no-op for an unknowable number of versions. Both names are live on this
     machine at once, so a gate is recognised off the presence of `command`. */
  test("anything carrying a command qualifies, whatever the tool is called", () => {
    expect(recognise({ command: "bun run test" })?.gate).toBe("test");
    expect(recognise({ file_path: "src/lib/gates.ts" })).toBeNull();
    expect(recognise({ command: 42 })).toBeNull();
    expect(recognise(null)).toBeNull();
    expect(recognise("bun run test")).toBeNull();
  });

  /* A `cd` is not the gate, and this is the commonest real spelling in this
     repository — CLAUDE.md's own Rust line is `cd src-tauri && cargo test`. */
  test("the gate is found in a compound command, and only the gate is recorded", () => {
    const g = recognise({ command: "cd src-tauri && cargo check --all-targets" });
    expect(g?.gate).toBe("cargo-check");
    expect(g?.command).toBe("cargo check --all-targets");
  });

  test("segments splits on the three separators and drops the empties", () => {
    expect(segments("a && b ; c")).toEqual(["a", "b", "c"]);
    expect(segments("a &&  && b")).toEqual(["a", "b"]);
    expect(segments("  ")).toEqual([]);
  });
});

describe("what a run actually covered", () => {
  /* `.claude/rules/build.md` twice over: `check-gnu.sh` is `cargo check --lib`,
     which does not look at `#[cfg(test)]` code at all, and "a green
     `check --tests` reads like a green test run and is not one". A reading that
     called the bare form whole would be manufacturing that exact lie. */
  test("a bare cargo check is partial, because it typechecks no test module", () => {
    const g = recognise({ command: "bash tools/check-gnu.sh" });
    expect(g?.scope).toBe("partial");
    expect(g?.narrowed).toBe("no test modules");
  });

  test("--profile test, --tests and --all-targets widen it to whole", () => {
    for (const command of [
      "bash tools/check-gnu.sh --profile test",
      "cargo check --tests",
      "cargo check --all-targets",
    ]) {
      const g = recognise({ command });
      expect(g?.scope).toBe("whole");
      expect(g?.narrowed).toBeNull();
    }
  });

  test("one file out of a suite that names its files explicitly is partial", () => {
    expect(recognise({ command: "bun test test/gates.test.ts" })?.scope).toBe("partial");
    expect(recognise({ command: "bun test test/gates.test.ts -t urgency" })?.scope).toBe(
      "partial",
    );
    expect(recognise({ command: "bun run test" })?.scope).toBe("whole");
  });

  test("one package out of a workspace is partial", () => {
    expect(recognise({ command: "cargo check -p skein_lib --all-targets" })?.narrowed).toBe(
      "one package",
    );
  });
});

describe("what disqualifies a command from being read as a gate", () => {
  /* Each of these was a live failure mode rather than a hypothesis, and every
     one of them fails in the same direction: a green on the wall for a gate
     that did not pass. That is the worst thing this feature can do, because it
     is what a broadcast needing retraction already was. */
  test("a watcher never settles, so its result is about the kill", () => {
    expect(recognise({ command: "vitest --watch" })).toBeNull();
    expect(recognise({ command: "cargo watch -x check" })).toBeNull();
  });

  test("a swallowed failure exits zero and would report a pass", () => {
    expect(recognise({ command: "cargo check || true" })).toBeNull();
    expect(recognise({ command: "bun run test ; true" })).toBeNull();
    expect(recognise({ command: "bun run test ; :" })).toBeNull();
  });

  /* This one would have made the feature read its own documentation. The sink
     is full of cards writing rules that quote gate commands verbatim. */
  test("a gate being talked about is not a gate being run", () => {
    expect(recognise({ command: 'grep -n "cargo check" .claude/rules/build.md' })).toBeNull();
    expect(recognise({ command: "echo bun run test" })).toBeNull();
  });

  test("a gate whose output is thrown away was not run to learn anything", () => {
    expect(recognise({ command: "cargo check > /dev/null" })).toBeNull();
  });

  /* Probed: a backgrounded call's `tool_result` is a launch receipt that
     arrives at once, carrying `backgroundTaskId`, an empty stdout and
     `is_error` false while the gate is still going. Reading that as a pass
     would put a green up for a run that had not started producing output. */
  test("a backgrounded gate is not observable here and is not recorded", () => {
    expect(recognise({ command: "bun run test", run_in_background: true })).toBeNull();
    expect(recognise({ command: "bun run test", run_in_background: false })?.gate).toBe("test");
  });

  test("guard is asked of the whole line, since || is only a lie read together", () => {
    expect(guard("cargo check || true")).toBe(true);
    expect(guard("cargo check")).toBe(false);
  });
});

describe("the failure text kept beside a red gate", () => {
  test("nothing is nothing, not an empty string", () => {
    expect(detailOf("")).toBeNull();
    expect(detailOf("   \n\n  ")).toBeNull();
  });

  /* The **tail**, because a compiler puts its summary last: `error: could not
     compile skein (lib) due to 10 previous errors` is the line a reader wants
     and it is the final one. Taking the head would keep the first of ten
     errors and drop the count. */
  test("the tail is kept, and the cut is marked", () => {
    const long = "first line\n" + "x".repeat(MAX_DETAIL * 2) + "\nlast line";
    const out = detailOf(long)!;
    expect(out.length).toBe(MAX_DETAIL);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("last line")).toBe(true);
    expect(out).not.toContain("first line");
  });

  test("something short is kept whole and unmarked", () => {
    expect(detailOf("error: could not compile `skein`")).toBe("error: could not compile `skein`");
  });

  test("carriage returns and blank runs are spent on words instead", () => {
    expect(detailOf("a\r\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("the reading", () => {
  test("a tree with nothing observed reads as nothing, not as green", () => {
    expect(reading([])).toEqual([]);
    expect(reading([run()], "C:/somewhere/else")).toEqual([]);
  });

  test("one state per gate, and the newest settled run is the one that speaks", () => {
    const rows = [
      run({ toolId: "a", gate: "test", settledAt: 1_000, outcome: "passed" }),
      run({ toolId: "b", gate: "test", settledAt: 5_000, outcome: "failed" }),
      run({ toolId: "c", gate: "check", settledAt: 3_000, outcome: "passed" }),
    ];
    const out = reading(rows);
    expect(out.map((s) => s.gate).sort()).toEqual(["check", "test"]);
    expect(out.find((s) => s.gate === "test")!.last!.toolId).toBe("b");
  });

  test("rows are sorted here rather than trusted to arrive in order", () => {
    const rows = [
      run({ toolId: "old", settledAt: 1_000, outcome: "passed" }),
      run({ toolId: "new", settledAt: 9_000, outcome: "failed" }),
    ];
    expect(reading(rows)[0]!.last!.toolId).toBe("new");
    expect(reading(rows.slice().reverse())[0]!.last!.toolId).toBe("new");
  });

  /* The load-bearing one. A partial pass must never be able to present itself
     as the whole gate being green, because on this machine the partial form —
     `bash tools/check-gnu.sh` — is the one everybody actually types. */
  test("a partial pass does not become the gate's last whole pass", () => {
    const out = reading([
      run({ toolId: "part", scope: "partial", narrowed: "no test modules", outcome: "passed" }),
    ]);
    expect(out[0]!.last!.toolId).toBe("part");
    expect(out[0]!.lastWhole).toBeNull();
  });

  test("a whole pass behind a later partial one is still findable", () => {
    const out = reading([
      run({ toolId: "whole", settledAt: 1_000, scope: "whole", outcome: "passed" }),
      run({ toolId: "part", settledAt: 2_000, scope: "partial", outcome: "passed" }),
    ]);
    expect(out[0]!.last!.toolId).toBe("part");
    expect(out[0]!.lastWhole!.toolId).toBe("whole");
  });

  /* A run whose end this window never saw is not a red gate — the same
     distinction `mark_interrupted` got wrong twice, each time by widening
     "interrupted" to something easier to ask, and each time the cost was the
     whole wall claiming its last turn was cut off. */
  test("an unsettled run does not speak for the gate", () => {
    const out = reading([
      run({ toolId: "seen", settledAt: 1_000, outcome: "passed" }),
      run({ toolId: "lost", settledAt: null, outcome: "unknown" }),
    ]);
    expect(out[0]!.last!.toolId).toBe("seen");
    expect(out[0]!.runs).toHaveLength(2);
  });

  test("red sorts above green, however fresh the green is", () => {
    const out = reading([
      run({ gate: "check", settledAt: 9_000, outcome: "passed" }),
      run({ gate: "test", settledAt: 1_000, outcome: "failed" }),
    ]);
    expect(out.map((s) => s.gate)).toEqual(["test", "check"]);
  });

  test("the order is stable rather than incidental, so a widget does not reshuffle", () => {
    const rows = [
      run({ gate: "b", settledAt: 5_000, outcome: "passed" }),
      run({ gate: "a", settledAt: 5_000, outcome: "passed" }),
    ];
    expect(reading(rows).map((s) => s.gate)).toEqual(["a", "b"]);
  });

  /* This is the reading that answers the third waste of 2026-08-27: the same
     `cargo update --precise` pin applied and lost three times, with each card
     assuming a sibling had undone its fix when all three were losing to cargo.
     Nobody could see the gate going green and red again. */
  test("flapping is visible where it was visible to nobody", () => {
    const flap = [
      run({ toolId: "1", settledAt: 1_000, outcome: "passed" }),
      run({ toolId: "2", settledAt: 2_000, outcome: "failed" }),
      run({ toolId: "3", settledAt: 3_000, outcome: "passed" }),
      run({ toolId: "4", settledAt: 4_000, outcome: "failed" }),
    ];
    expect(reading(flap)[0]!.flapping).toBe(true);

    /* One change is a gate that broke, or one somebody fixed. That is news
       rather than flapping, and calling it flapping would cry wolf on the
       single commonest thing that happens to a gate. */
    const broke = [
      run({ toolId: "1", settledAt: 1_000, outcome: "passed" }),
      run({ toolId: "2", settledAt: 2_000, outcome: "failed" }),
    ];
    expect(reading(broke)[0]!.flapping).toBe(false);
  });

  test("only this tree's runs, since two worktrees of one project share nothing", () => {
    const here = "C:/Users/lyss.delprat/workbench/skein";
    const out = reading(
      [run({ toolId: "here", root: here }), run({ toolId: "there", root: `${here}-wt/feature` })],
      here,
    );
    expect(out[0]!.runs.map((r) => r.toolId)).toEqual(["here"]);
  });
});

describe("sameTree", () => {
  test("one directory spelled two ways is one tree", () => {
    expect(sameTree("C:\\a\\b", "C:/a/b")).toBe(true);
    expect(sameTree("C:/A/B", "c:/a/b")).toBe(true);
    expect(sameTree("C:/a/b/", "C:/a/b")).toBe(true);
  });

  test("a worktree beside a project is not the project", () => {
    expect(sameTree("C:/a/skein", "C:/a/skein-wt/feature")).toBe(false);
  });
});

describe("the one-line reading", () => {
  const now = 10 * 60_000;

  test("a gate never seen run says so, rather than reading as green", () => {
    expect(sentence({ gate: "test", last: null, lastWhole: null, runs: [], flapping: false }, now))
      .toBe("test — not seen run");
  });

  /* A green with no time on it is the stale green that made a broadcast need
     retracting an hour after it was sent. Every reading carries when. */
  test("green and red both say when", () => {
    const green = reading([run({ gate: "test", settledAt: now - 60_000, outcome: "passed" })])[0]!;
    expect(sentence(green, now)).toBe("test green 1m ago");

    const red = reading([run({ gate: "test", settledAt: now - 3_600_000, outcome: "failed" })])[0]!;
    expect(sentence(red, now)).toBe("test red 1h ago");
  });

  test("a red partial run names which part", () => {
    const s = reading([
      run({ gate: "cargo-check", scope: "partial", narrowed: "no test modules", outcome: "failed", settledAt: now }),
    ])[0]!;
    expect(sentence(s, now)).toBe("cargo-check red just now (no test modules)");
  });

  /* The most misleading state this feature can be in, so it is the one spelled
     out longest: something passed, and it was not the gate you think. */
  test("a partial pass with no whole pass behind it says both halves", () => {
    const s = reading([
      run({ gate: "cargo-check", scope: "partial", narrowed: "no test modules", outcome: "passed", settledAt: now }),
    ])[0]!;
    expect(sentence(s, now)).toBe(
      "cargo-check — only part of it passed just now — the whole gate has not passed here",
    );
  });
});

describe("ago", () => {
  test("the wall's own vocabulary, so a card and a widget agree", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44_000)).toBe("just now");
    expect(ago(60_000)).toBe("1m ago");
    expect(ago(59 * 60_000)).toBe("59m ago");
    expect(ago(2 * 3_600_000)).toBe("2h ago");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });

  test("a negative age is not a negative reading", () => {
    expect(ago(-5_000)).toBe("just now");
  });
});
