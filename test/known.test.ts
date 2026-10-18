import { describe, expect, test } from "bun:test";
import {
  chunks,
  diskMayHaveChanged,
  keyOf,
  mayWriteDisk,
  negatives,
  onDiskMayHaveChanged,
  related,
  rootsToReask,
  settle,
} from "../src/lib/known";

const ROOT = "C:\\Users\\flori\\codes\\rise";

describe("an absence is a reading of a moment", () => {
  const known: Record<string, "file" | "dir" | null> = {
    [keyOf(ROOT, "docs/ui-direction.md")]: null, // named before it was written
    [keyOf(ROOT, "src/main.ts")]: "file",
    [keyOf(ROOT, "docs")]: "dir",
    [keyOf("C:\\other", "x.md")]: null,
  };

  test("only the negatives under a root are re-asked; positives are kept", () => {
    expect(negatives(known, ROOT)).toEqual(["docs/ui-direction.md"]);
  });

  test("a change at a card's cwd concerns its root, not an unrelated one", () => {
    const roots = rootsToReask([known], ROOT + "\\");
    expect(roots).toEqual([ROOT]);
  });

  test("a focus (no place) concerns every root holding an absence", () => {
    expect(rootsToReask([known], null).sort()).toEqual([ROOT, "C:\\other"].sort());
  });

  test("a root with only positives is never re-asked", () => {
    expect(rootsToReask([{ [keyOf(ROOT, "a")]: "file" }], null)).toEqual([]);
  });

  test("unknown keys are not negatives", () => {
    expect(negatives({}, ROOT)).toEqual([]);
  });

  test("a tool result in a card fires the evidence for its cwd", () => {
    const heard: string[] = [];
    const off = onDiskMayHaveChanged((c) => heard.push(c));
    diskMayHaveChanged(ROOT);
    off();
    diskMayHaveChanged("ignored");
    expect(heard).toEqual([ROOT]);
  });
});

describe("what counts as evidence", () => {
  test("writers and shells do; readers do not", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell"]) {
      expect(mayWriteDisk(t)).toBe(true);
    }
    for (const t of ["Read", "Grep", "Glob", undefined, "mcp__skein__sink"]) {
      expect(mayWriteDisk(t)).toBe(false);
    }
  });

  test("related is containment either way, and not a prefix of a name", () => {
    expect(related("C:\\a\\b", "C:\\a\\b\\")).toBe(true);
    expect(related("C:\\a\\b", "C:\\a")).toBe(true);
    expect(related("C:\\a", "C:\\a\\b")).toBe(true);
    expect(related("C:\\a\\bc", "C:\\a\\b")).toBe(false);
  });
});

describe("what an answer may record", () => {
  test("a failed ask records nothing — it is never an absence", () => {
    expect(settle(null, "docs/x.md")).toBeUndefined();
  });
  test("an answered batch: kinds are kept and a missing key is absent", () => {
    expect(settle({ "a.md": "file", d: "dir" }, "a.md")).toBe("file");
    expect(settle({ "a.md": "file", d: "dir" }, "d")).toBe("dir");
    expect(settle({ "a.md": "file" }, "b.md")).toBeNull();
  });
  test("a batch never exceeds the Rust cap, so nothing is cut and read as absent", () => {
    const all = Array.from({ length: 1000 }, (_, i) => `p${i}`);
    const parts = chunks(all, 400);
    expect(parts.map((p) => p.length)).toEqual([400, 400, 200]);
    expect(parts.flat()).toEqual(all);
  });
});
