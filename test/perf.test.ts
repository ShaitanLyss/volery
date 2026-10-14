import { describe, expect, test } from "bun:test";
import {
  fold,
  members,
  orphans,
  reapedNote,
  since,
  type Proc,
  type Reaped,
  type Sample,
} from "../src/lib/perf";

describe("reapedNote", () => {
  const r = (p: Partial<Reaped>): Reaped => ({
    pid: 4168,
    name: "node.exe",
    conversation: "card-a",
    automatic: true,
    command: "node node_modules/typescript/bin/tsc --noEmit",
    why: "leftover tsc",
    bytes: 2.5 * 1024 ** 3,
    ...p,
  });

  test("a leftover names the command, the memory and the rule", () => {
    const said = reapedNote(r({}));
    expect(said).toContain("typescript/bin/tsc --noEmit (pid 4168)");
    expect(said).toContain("freeing 2.5 GB");
    expect(said).toContain("after this card's turn ended");
  });

  test("an orphan says why nothing was waiting on it", () => {
    expect(reapedNote(r({ why: "orphan", bytes: 0 }))).toBe(
      "volery ended node node_modules/typescript/bin/tsc --noEmit (pid 4168) — the process that started it was gone, so nothing was waiting on it",
    );
  });

  test("a process with no command line falls back to its image", () => {
    expect(reapedNote(r({ command: "", why: "by hand", bytes: 0 }))).toBe("ended node.exe (pid 4168)");
  });
});

function proc(p: Partial<Proc> & { pid: number }): Proc {
  return {
    ppid: 1,
    name: "node.exe",
    cpu: 0,
    mem: 0,
    role: "conversation",
    reference: "card-a",
    own: false,
    orphan: false,
    age: 600,
    ...p,
  };
}

function sample(procs: Proc[]): Sample {
  return {
    at: 0,
    scope: "skein",
    cores: 8,
    cpu: 0,
    mem_used: 0,
    mem_total: 0,
    counted: procs.length,
    other_cpu: 0,
    other_mem: 0,
    procs,
  };
}

describe("members", () => {
  /* The count on a folded row and the list behind it are two readings of one
     set. If they can disagree, the number on the wall is not evidence. */
  test("a row's count is exactly what opening it shows", () => {
    const s = sample([
      proc({ pid: 10, own: true, name: "claude.exe" }),
      proc({ pid: 11 }),
      proc({ pid: 12 }),
      proc({ pid: 20, reference: "card-b" }),
    ]);
    const rows = fold(s, () => null, "skein");
    for (const row of rows) {
      expect(members(s, row.key)).toHaveLength(row.count);
    }
  });

  test("orphans come first, ahead of anything costlier", () => {
    const s = sample([
      proc({ pid: 10, cpu: 250, name: "busy.exe" }),
      proc({ pid: 11, cpu: 0, orphan: true, name: "leaked.exe" }),
      proc({ pid: 12, cpu: 40, name: "middling.exe" }),
    ]);
    /* The orphan is the cheapest thing here and still leads — cost decides the
       rest of the order, exactly as it does for the rows. */
    expect(members(s, "conversation:card-a").map((p) => p.name)).toEqual([
      "leaked.exe",
      "busy.exe",
      "middling.exe",
    ]);
  });

  test("strangers are keyed by executable, the way fold groups them", () => {
    const s = sample([
      proc({ pid: 30, role: "other", reference: null, name: "chrome.exe" }),
      proc({ pid: 31, role: "other", reference: null, name: "chrome.exe" }),
      proc({ pid: 32, role: "other", reference: null, name: "code.exe" }),
    ]);
    expect(members(s, "name:chrome.exe").map((p) => p.pid)).toEqual([30, 31]);
  });

  /* A card with no reference and a stranger both key on an empty tail; the
     split has to be on the kind, not on what follows the colon. */
  test("a null reference does not collide with a stranger", () => {
    const s = sample([
      proc({ pid: 40, role: "conversation", reference: null }),
      proc({ pid: 41, role: "other", reference: null, name: "" }),
    ]);
    expect(members(s, "conversation:").map((p) => p.pid)).toEqual([40]);
  });
});

describe("orphans", () => {
  test("only ours — a stranger with a dead parent is not Skein's business", () => {
    const s = sample([
      proc({ pid: 50, orphan: true }),
      proc({ pid: 51, orphan: true, role: "other", reference: null }),
      proc({ pid: 52 }),
    ]);
    expect(orphans(s).map((p) => p.pid)).toEqual([50]);
  });
});

describe("since", () => {
  test("the shortest form that is still true", () => {
    expect(since(0)).toBe("0s");
    expect(since(59)).toBe("59s");
    expect(since(60)).toBe("1m");
    expect(since(3599)).toBe("59m");
    expect(since(3600)).toBe("1h");
    expect(since(86_399)).toBe("23h");
    expect(since(86_400)).toBe("1d");
  });

  /* The reading that started this: a chain sixteen hours old under a card that
     had long since finished with it. */
  test("sixteen hours reads as hours, not as a very large number of seconds", () => {
    expect(since(16 * 3600)).toBe("16h");
  });

  test("a negative age clamps rather than printing a minus", () => {
    expect(since(-5)).toBe("0s");
  });
});
