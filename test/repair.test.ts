import { describe, expect, test } from "bun:test";
import {
  backupSettled,
  repairWorthTrying,
  REPAIR_SETTLE_TURNS,
  sayCommand,
  sayNothingToRepair,
  sayRepair,
  poisonedPath,
  type RepairReport,
} from "../src/lib/repair";

/** The real one, from the session this was written for. */
const real: RepairReport = {
  records: 1,
  chars_removed: 4383,
  nuls: 1222,
  undecodable: 100,
  culprits: [
    {
      tool: "Bash",
      command:
        'Bash cd /c/Users/lyss.delprat/.local/bin && echo "=== oauth prompt strings ==="; ' +
        'grep -aoE "(Paste|paste)[^\\"]{0,70}" claude.exe | sort -u | head -12',
      /* `claude.exe` is a binary and not a source file, so the repair named
         none — which is the honest answer for this one. */
      path: null,
      declared: false,
    },
  ],
  backup: "C:/Users/x/.claude/projects/p/s.jsonl.skein-bak",
};

describe("when a repair is worth reaching for", () => {
  test("only the truncated body", () => {
    expect(repairWorthTrying("malformed")).toBe(true);
  });

  test("not an overload, which is somebody else's weather", () => {
    /* There is nothing in this conversation to mend; a repair here would
       rewrite a session to fix a queue somewhere else. */
    expect(repairWorthTrying("overloaded")).toBe(false);
    expect(repairWorthTrying(null)).toBe(false);
  });
});

describe("what the card says about one", () => {
  test("the counts are named, because the card rewrote somebody else's file", () => {
    const said = sayRepair(real);
    expect(said).toContain("1,222 nul characters");
    expect(said).toContain("100 undecodable");
  });

  test("and the tool call, so the reader can judge it", () => {
    expect(sayRepair(real)).toContain("grep -aoE");
  });

  test("one result reads as one, not as a figure", () => {
    expect(sayRepair(real)).toContain("one tool result");
    expect(sayRepair({ ...real, records: 3 })).toContain("3 tool results");
  });

  test("a report with no command still reads as a sentence", () => {
    const said = sayRepair({ ...real, culprits: [] });
    expect(said).toContain("repaired —");
    expect(said).not.toContain("undefined");
    expect(said).not.toContain("``");
  });

  test("only the counts that happened are mentioned", () => {
    const said = sayRepair({ ...real, undecodable: 0 });
    expect(said).toContain("nul characters");
    expect(said).not.toContain("undecodable");
  });

  test("falls back to a character count when neither kind was counted", () => {
    const said = sayRepair({ ...real, nuls: 0, undecodable: 0 });
    expect(said).toContain("4,383 characters");
  });

  test("the prose is lowercase, like the rest of the wall", () => {
    expect(sayRepair(real)[0]).toBe(sayRepair(real)[0]!.toLowerCase());
    expect(sayNothingToRepair()[0]).toBe(sayNothingToRepair()[0]!.toLowerCase());
  });

  test("a clean conversation is a finding, and says so without naming a cause it did not check", () => {
    expect(sayNothingToRepair()).toContain("nothing corrupt");
    expect(sayNothingToRepair()).not.toContain("too large");
  });
});

describe("where the characters still are", () => {
  /** The loop from sink 08de8ed3: a poisoned source file in a shared tree. */
  const poisoned: RepairReport = {
    ...real,
    nuls: 2,
    undecodable: 0,
    culprits: [
      {
        tool: "Read",
        command: "Read preview-router/lib/routing.test.ts",
        path: "preview-router/lib/routing.test.ts",
        declared: true,
      },
    ],
  };

  test("the file is named, because a 400 names only a column offset in a request body", () => {
    /* Without this the card that died cannot learn from the repair, so it
       reads the same file next turn and dies identically. Two cards burned
       five turns on that. */
    expect(sayRepair(poisoned)).toContain("preview-router/lib/routing.test.ts");
  });

  test("and the card says it did not touch it, because it did not", () => {
    /* A repair mends the conversation only. Saying so is what turns "repaired"
       from an all-clear into an instruction. */
    expect(sayRepair(poisoned)).toContain("did not touch");
    expect(sayRepair(poisoned)).toContain("still in");
  });

  test("a path read out of a shell line is offered as a guess", () => {
    const guessed: RepairReport = {
      ...poisoned,
      culprits: [
        {
          tool: "Bash",
          command: "Bash cat preview-router/lib/routing.test.ts",
          path: "preview-router/lib/routing.test.ts",
          declared: false,
        },
      ],
    };
    expect(sayRepair(guessed)).toContain("probably");
    expect(sayRepair(guessed)).toContain("check it");
  });

  test("and when no file could be named, the old sentence still stands", () => {
    /* `real` is the `grep -a claude.exe` case: a binary, deliberately read as
       text, with no source file to blame. */
    expect(sayRepair(real)).toContain("could not be sent while they were in it");
    expect(sayRepair(real)).not.toContain("null");
  });
});

describe("the file skein would put its name to", () => {
  test("a declared path, which is the one the tool was handed", () => {
    expect(
      poisonedPath({
        ...real,
        culprits: [{ tool: "Read", command: "Read a.ts", path: "a.ts", declared: true }],
      }),
    ).toBe("a.ts");
  });

  test("never a guess, because a wall-level notice is acted on without checking", () => {
    /* The certain tier and nothing else. A notice naming the wrong file sends
       the next card to clean something that was never dirty — worse than a
       notice that names none. */
    expect(
      poisonedPath({
        ...real,
        culprits: [{ tool: "Bash", command: "Bash cat a.ts", path: "a.ts", declared: false }],
      }),
    ).toBe(null);
  });

  test("and nothing at all when the repair named nothing", () => {
    expect(poisonedPath(real)).toBe(null);
    expect(poisonedPath({ ...real, culprits: [] })).toBe(null);
  });
});

describe("shortening a command", () => {
  test("the front is kept, because that is what identifies it", () => {
    expect(sayCommand("grep -aoE pattern claude.exe", 100)).toBe("grep -aoE pattern claude.exe");
    expect(sayCommand("grep -aoE pattern claude.exe", 12)).toBe("grep -aoE p…");
  });

  test("newlines and runs of space flatten, so it sits on one line", () => {
    expect(sayCommand("a\n\n  b\tc")).toBe("a b c");
  });

  test("the navigation is dropped, because it is not what identifies the call", () => {
    /* The bug this catches: sixty characters off the front of the real command
       named a directory and never reached the `grep` that broke the session. */
    expect(sayCommand("Bash cd /c/Users/lyss/.local/bin && grep -aoE x claude.exe")).toBe(
      "Bash grep -aoE x claude.exe",
    );
  });

  test("a cd that is the whole command is left alone", () => {
    /* No `&&`, so nothing was preamble to anything — dropping it would leave
       an empty line where a real tool call should be. */
    expect(sayCommand("Bash cd /some/where")).toBe("Bash cd /some/where");
  });
});

describe("keeping the original until the repair has proved itself", () => {
  test("not straight away — a bad repair shows up as the next turn failing", () => {
    expect(backupSettled(0)).toBe(false);
    expect(backupSettled(1)).toBe(false);
  });

  test("two good turns is the evidence", () => {
    expect(backupSettled(REPAIR_SETTLE_TURNS)).toBe(true);
    expect(backupSettled(9)).toBe(true);
  });
});
