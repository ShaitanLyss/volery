import { expect, test, describe } from "bun:test";
import {
  BRIEF_FILES,
  briefFor,
  shortPath,
  trailOf,
  type Handled,
} from "../src/lib/handoff";

const PLAN = "C:/Users/me/.claude/plans/rework-the-store-imperative-gem.md";
const CWD = "C:/Users/me/workbench/skein";
const read = (path: string, count = 1): Handled => ({ path, op: "read", count });

describe("naming a path in a brief", () => {
  test("a file under the maker's own directory is named relatively", () => {
    expect(shortPath(`${CWD}/src/lib/store.ts`, CWD)).toBe("src/lib/store.ts");
  });

  test("separators and case are folded, because this is Windows", () => {
    /* The store keeps whatever the tool call typed, and two cards in the same
       file type it two ways. Matching literally would leave half a card's own
       trail drawn as absolute paths. */
    expect(shortPath("C:\\Users\\me\\workbench\\skein\\src\\a.ts", CWD)).toBe("src/a.ts");
    expect(shortPath("c:/users/ME/workbench/SKEIN/src/a.ts", CWD)).toBe("src/a.ts");
  });

  test("a trailing separator on the root changes nothing", () => {
    expect(shortPath(`${CWD}/src/a.ts`, `${CWD}/`)).toBe("src/a.ts");
  });

  test("a file elsewhere stays absolute rather than climbing out with ..", () => {
    /* It is genuinely somewhere else, and `../../nova/src/x.ts` is a path you
       have to count on your fingers to read. */
    const other = "C:/Users/me/workbench/nova/src/x.ts";
    expect(shortPath(other, CWD)).toBe(other);
  });

  test("a near-miss prefix is not treated as a parent", () => {
    /* `…/skein-old` starts with `…/skein` and is a different repository. */
    const other = "C:/Users/me/workbench/skein-old/src/a.ts";
    expect(shortPath(other, CWD)).toBe(other);
  });
});

describe("the trail handed forward", () => {
  test("the plan document is not in its own file list", () => {
    /* It is named at the top of the brief, and a second mention buried in a
       list reads as two different documents. */
    expect(trailOf([read(PLAN), read("src/a.ts")], PLAN).map((h) => h.path)).toEqual([
      "src/a.ts",
    ]);
  });

  test("other plans are dropped too", () => {
    /* A planner looking at its own earlier work is not the codebase, and a
       maker sent to read a plan that was not the brief has been misdirected. */
    const older = "C:/Users/me/.claude/plans/something-else-quiet-moth.md";
    expect(trailOf([read(older), read("src/a.ts")], PLAN).map((h) => h.path)).toEqual([
      "src/a.ts",
    ]);
  });

  test("the store's order is kept — most-handled first, not most recent", () => {
    /* Recency is the tail of an exploration; frequency is its subject. */
    const rows = [read("src/a.ts", 9), read("src/b.ts", 2)];
    expect(trailOf(rows, PLAN)).toEqual(rows);
  });
});

describe("the brief a maker opens on", () => {
  const brief = (handled: Handled[]) =>
    briefFor({ plan: PLAN, handled, cwd: CWD, planner: "95f0e224" });

  test("the plan is named by path, never inlined", () => {
    /* Inlining would put the document in context twice — once in the brief and
       once when the maker reads it — which is the cost this exists to avoid. */
    const out = brief([]);
    expect(out).toContain(".claude/plans/rework-the-store-imperative-gem.md");
    expect(out.length).toBeLessThan(2000);
  });

  test("the trail is listed, and a written file says so", () => {
    const out = brief([read(`${CWD}/src/lib/store.ts`, 6), { path: `${CWD}/src/a.ts`, op: "write", count: 1 }]);
    expect(out).toContain("- src/lib/store.ts");
    expect(out).toContain("- src/a.ts (written)");
    /* A read is the ordinary case and carries no marker — a list where every
       row is annotated is a list where the annotation says nothing. */
    expect(out).not.toContain("src/lib/store.ts (read)");
  });

  test("a long trail is cut, and the tail says exactly how many were cut", () => {
    /* An exact number rather than "and more": the cut is made here, off the
       whole list, precisely so the count can be honest. */
    const many = Array.from({ length: BRIEF_FILES + 7 }, (_, i) => read(`${CWD}/src/f${i}.ts`));
    const out = brief(many);
    expect(out).toContain(`and 7 more`);
    expect(out).toContain("- src/f0.ts");
    expect(out).not.toContain(`- src/f${BRIEF_FILES}.ts`);
  });

  test("a trail cut to exactly the cap says nothing about a remainder", () => {
    const exact = Array.from({ length: BRIEF_FILES }, (_, i) => read(`${CWD}/src/f${i}.ts`));
    expect(brief(exact)).not.toContain("more it looked at");
  });

  test("no trail at all still produces a usable brief", () => {
    /* The read can fail, and a failed read is not a reason to refuse the
       handoff — the plan and the escalation path are still most of it. */
    const out = brief([]);
    expect(out).toContain("Read ");
    expect(out).toContain("95f0e224");
    expect(out).not.toContain("these files");
  });

  test("the planner is named, for recall rather than for credit", () => {
    /* `recall` reads another card's transcript off disk without costing that
       card a turn, which is what makes escalation affordable at all. */
    const out = brief([read(`${CWD}/src/a.ts`)]);
    expect(out).toContain("recall");
    expect(out).toContain("95f0e224");
  });

  test("it says what to do when the plan is wrong about the code", () => {
    /* The failure mode of a smaller model against a good plan is not following
       it badly, it is improvising when the code is not shaped as assumed. One
       sentence, and the highest value per token in the brief. */
    expect(brief([])).toContain("rather than working around it");
  });
});

describe("the root a trail is read against", () => {
  /* The bug this was caught for, kept as a test because the shape of it is not
     obvious from either side. A worktree does not sit *beside* the project —
     `worktree::dir_for` puts it at `cwd/.claude/worktrees/<slug>`, nested
     under it — so shortening a worktree card's paths against its `cwd` does
     not leave them absolute and readable. It produces a relative path that
     looks right and resolves, from the maker's own directory, to nowhere. */
  const ROOT = "C:/Users/me/workbench/skein";
  const RUN = `${ROOT}/.claude/worktrees/feat-x`;
  const FILE = `${RUN}/src/lib/store.ts`;

  test("against the run directory, a worktree card's file names itself", () => {
    expect(shortPath(FILE, RUN)).toBe("src/lib/store.ts");
  });

  test("against the project root it becomes a path to nowhere", () => {
    /* Not absolute — which would at least have been readable — but a relative
       path the maker would resolve against its own cwd, which *is* the run
       directory, giving `…/worktrees/feat-x/.claude/worktrees/feat-x/…`. */
    expect(shortPath(FILE, ROOT)).toBe(".claude/worktrees/feat-x/src/lib/store.ts");
  });

  test("a card with no worktree has the two roots equal, so nothing changes", () => {
    expect(shortPath(`${ROOT}/src/a.ts`, ROOT)).toBe("src/a.ts");
  });
});
