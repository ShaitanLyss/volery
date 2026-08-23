import { describe, expect, test } from "bun:test";
import {
  DIFF_MAX_LINES,
  RESULT_LINES,
  VALUE_CAP,
  argsOf,
  callView,
  capInput,
  capValue,
  clampLines,
  clipNote,
  diffTally,
  formOf,
  hunksOf,
  labelOf,
  landed,
  resultSize,
  splitPath,
  startLine,
  toolBadge,
} from "../src/lib/toolcall";

describe("the stamp", () => {
  test("an ordinary tool is its own name", () => {
    expect(toolBadge("Read")).toBe("Read");
    expect(toolBadge("TaskUpdate")).toBe("TaskUpdate");
  });

  test("an mcp tool is split into server and tool", () => {
    expect(toolBadge("mcp__skein__ask_user")).toBe("skein·ask_user");
    expect(toolBadge("mcp__plugin_playwright_playwright__browser_click")).toBe(
      "plugin_playwright_playwright·browser_click",
    );
  });

  test("a server name carrying the delimiter keeps its tool", () => {
    /* Non-greedy on the server half, so the *last* `__` is not the one that
       wins and the tool name survives whole. */
    expect(toolBadge("mcp__a__b__c")).toBe("a·b__c");
  });
});

describe("paths", () => {
  test("split at either separator", () => {
    expect(splitPath("C:\\atelier\\skein\\src\\lib\\toolcall.ts")).toEqual({
      dir: "C:\\atelier\\skein\\src\\lib\\",
      base: "toolcall.ts",
    });
    expect(splitPath("src/lib/toolcall.ts")).toEqual({
      dir: "src/lib/",
      base: "toolcall.ts",
    });
  });

  test("a bare name is all basename", () => {
    expect(splitPath("package.json")).toEqual({ dir: "", base: "package.json" });
  });
});

describe("labels", () => {
  test("snake and camel both become words", () => {
    expect(labelOf("file_path")).toBe("file path");
    expect(labelOf("activeForm")).toBe("active form");
    expect(labelOf("run_in_background")).toBe("run in background");
  });

  test("a flag keeps its dashes", () => {
    /* `-A` set as "a" is a different flag, and grep has both. */
    expect(labelOf("-A")).toBe("-A");
    expect(labelOf("-i")).toBe("-i");
  });
});

describe("how a value is set", () => {
  test("the key decides where it can", () => {
    expect(formOf("file_path", "src/a.ts")).toBe("path");
    expect(formOf("command", "bun run test")).toBe("shell");
    expect(formOf("content", "x")).toBe("code");
    expect(formOf("description", "read the panel")).toBe("text");
  });

  test("a pattern is a scalar, not a path", () => {
    /* Both are short strings; only one wants its last segment picked out. */
    expect(formOf("pattern", "src/**/*.ts")).toBe("scalar");
  });

  test("the shape decides for a key nobody knows", () => {
    expect(formOf("whatever", "one line")).toBe("scalar");
    expect(formOf("whatever", "two\nlines")).toBe("code");
    expect(formOf("whatever", "x".repeat(200))).toBe("text");
    expect(formOf("whatever", 12)).toBe("scalar");
    expect(formOf("whatever", true)).toBe("scalar");
  });

  test("arrays of scalars are a list, arrays of objects are json", () => {
    expect(formOf("to", ["a", "b"])).toBe("list");
    expect(formOf("edits", [{ old_string: "a" }])).toBe("json");
    expect(formOf("opts", { model: "opus" })).toBe("json");
  });
});

describe("arguments", () => {
  test("the subject of the call leads, whatever order it arrived in", () => {
    const args = argsOf("Read", { limit: 40, file_path: "src/a.ts", offset: 10 });
    expect(args.map((a) => a.key)).toEqual(["file_path", "offset", "limit"]);
  });

  test("a key the table does not name still shows, after the ones it does", () => {
    const args = argsOf("Read", { mystery: 1, file_path: "src/a.ts" });
    expect(args.map((a) => a.key)).toEqual(["file_path", "mystery"]);
  });

  test("unknown tools keep the order the model wrote", () => {
    const args = argsOf("SomeNewTool", { b: 1, a: 2, c: 3 });
    expect(args.map((a) => a.key)).toEqual(["b", "a", "c"]);
  });

  test("everything is shown — nothing is quietly dropped", () => {
    const args = argsOf("Grep", {
      pattern: "describeTool",
      path: "src",
      "-n": true,
      head_limit: 20,
      output_mode: "content",
    });
    expect(args.map((a) => a.key).sort()).toEqual(
      ["-n", "head_limit", "output_mode", "path", "pattern"].sort(),
    );
  });

  test("a list keeps its items rather than being stringified", () => {
    const [arg] = argsOf("SendMessage", { to: ["a", "b"] });
    expect(arg.form).toBe("list");
    expect(arg.items).toEqual(["a", "b"]);
  });

  test("structure is pretty-printed", () => {
    const [arg] = argsOf("X", { opts: { model: "opus" } });
    expect(arg.form).toBe("json");
    expect(arg.value).toBe('{\n  "model": "opus"\n}');
  });

  test("an undefined value is not an argument", () => {
    expect(argsOf("Read", { file_path: "a", limit: undefined })).toHaveLength(1);
  });

  test("no input is no arguments", () => {
    expect(argsOf("WebSearch", undefined)).toEqual([]);
    expect(argsOf("WebSearch", null)).toEqual([]);
    expect(argsOf("WebSearch", {})).toEqual([]);
  });

  test("a bare value still draws rather than going blank", () => {
    const args = argsOf("Odd", "just a string");
    expect(args).toHaveLength(1);
    expect(args[0].value).toBe("just a string");
  });

  test("a long value is capped and says how much went", () => {
    const [arg] = argsOf("Write", { content: "x".repeat(VALUE_CAP + 500) });
    expect(arg.value).toHaveLength(VALUE_CAP);
    expect(arg.clipped).toBe(500);
  });
});

describe("capping", () => {
  test("under the cap is untouched", () => {
    expect(capValue("short")).toEqual({ text: "short", clipped: 0 });
  });

  test("over the cap keeps the front", () => {
    const { text, clipped } = capValue("abcdef", 3);
    expect(text).toBe("abc");
    expect(clipped).toBe(3);
  });

  test("an input is capped all the way down", () => {
    const out = capInput({ a: "abcdef", b: { c: ["abcdef"] }, n: 4 }, 3) as any;
    expect(out.a).toBe("abc");
    expect(out.b.c[0]).toBe("abc");
    expect(out.n).toBe(4);
  });

  test("the capped input shares nothing with what it was read out of", () => {
    /* An event is transient and a line is kept for the life of the card, so a
       reference into one would pin the whole message. */
    const src = { a: { b: "x" } };
    const out = capInput(src) as any;
    expect(out).toEqual(src);
    expect(out.a).not.toBe(src.a);
  });
});

describe("the edit diff", () => {
  test("a one-line change is one out and one in", () => {
    const hunks = hunksOf("Edit", { old_string: "const a = 1;", new_string: "const a = 2;" });
    expect(hunks).toEqual([
      { rows: [{ sign: "-", text: "const a = 1;" }, { sign: "+", text: "const a = 2;" }] },
    ]);
  });

  test("context is kept around the change", () => {
    const hunks = hunksOf("Edit", {
      old_string: "a\nb\nc",
      new_string: "a\nB\nc",
    })!;
    expect(hunks[0].rows).toEqual([
      { sign: " ", text: "a" },
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
      { sign: " ", text: "c" },
    ]);
  });

  test("a pure insertion is only additions", () => {
    const hunks = hunksOf("Edit", { old_string: "a\nc", new_string: "a\nb\nc" })!;
    expect(hunks[0].rows.filter((r) => r.sign === "-")).toEqual([]);
    expect(hunks[0].rows.filter((r) => r.sign === "+")).toEqual([{ sign: "+", text: "b" }]);
  });

  test("the rows replay both sides exactly", () => {
    const from = "one\ntwo\nthree\nfour";
    const to = "one\ntwo and a half\nthree\nfive";
    const rows = hunksOf("Edit", { old_string: from, new_string: to })![0].rows;
    const back = (want: string) =>
      rows.filter((r) => r.sign === " " || r.sign === want).map((r) => r.text).join("\n");
    expect(back("-")).toBe(from);
    expect(back("+")).toBe(to);
  });

  test("several edits in one call are several hunks, each labelled", () => {
    const hunks = hunksOf("Edit", {
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    })!;
    expect(hunks).toHaveLength(2);
    expect(hunks[0].label).toBe("edit 1 of 2");
    expect(hunks[1].label).toBe("edit 2 of 2");
  });

  test("a single edit is not labelled", () => {
    expect(hunksOf("Edit", { old_string: "a", new_string: "b" })![0].label).toBeUndefined();
  });

  test("nothing to diff is null, not an empty list", () => {
    expect(hunksOf("Read", { file_path: "a" })).toBeNull();
    expect(hunksOf("Edit", { file_path: "a" })).toBeNull();
  });

  test("past the guard there is no diff", () => {
    const huge = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => String(i)).join("\n");
    expect(hunksOf("Edit", { old_string: huge, new_string: "x" })).toBeNull();
  });

  test("the tally counts both sides", () => {
    const hunks = hunksOf("Edit", { old_string: "a\nb", new_string: "a\nB\nC" });
    expect(diffTally(hunks)).toBe("+2 −1");
  });

  test("nothing to tally is nothing said", () => {
    expect(diffTally(null)).toBeNull();
    expect(diffTally(hunksOf("Edit", { old_string: "a", new_string: "a" }))).toBeNull();
  });
});

describe("the view the fold draws", () => {
  test("an edit's two strings are the diff, and are not repeated below it", () => {
    const v = callView("Edit", {
      file_path: "src/a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(v.hunks).not.toBeNull();
    expect(v.args.map((a) => a.key)).toEqual(["file_path"]);
  });

  test("a multi-edit drops the array it diffed", () => {
    const v = callView("Edit", {
      file_path: "src/a.ts",
      edits: [{ old_string: "a", new_string: "b" }],
    });
    expect(v.args.map((a) => a.key)).toEqual(["file_path"]);
  });

  test("an edit too large to diff still shows both strings whole", () => {
    /* The failure this guards: dropping the two keys because the call *is* an
       edit, when no diff was produced — a fold with a file path in it and
       nothing about the edit. */
    const huge = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => String(i)).join("\n");
    const v = callView("Edit", { file_path: "a", old_string: huge, new_string: "x" });
    expect(v.hunks).toBeNull();
    expect(v.args.map((a) => a.key)).toEqual(["file_path", "old_string", "new_string"]);
  });

  test("a plain call is all arguments and no diff", () => {
    const v = callView("Read", { file_path: "src/a.ts" });
    expect(v.hunks).toBeNull();
    expect(v.badge).toBe("Read");
    expect(v.args).toHaveLength(1);
  });
});

describe("the result", () => {
  test("landing caps and flags", () => {
    expect(landed("ok")).toEqual({ text: "ok" });
    expect(landed("no", true)).toEqual({ text: "no", failed: true });
    const big = landed("x".repeat(VALUE_CAP + 7));
    expect(big.clipped).toBe(7);
    expect(big.text).toHaveLength(VALUE_CAP);
  });

  test("size is lines, except when there is only one", () => {
    expect(resultSize(landed("a\nb\nc"))).toBe("3 lines");
    expect(resultSize(landed("abcd"))).toBe("4 chars");
    expect(resultSize(landed("a"))).toBe("1 char");
    expect(resultSize(landed(""))).toBe("empty");
  });

  test("a short result is shown whole", () => {
    expect(clampLines("a\nb")).toEqual({ head: "a\nb", hidden: 0 });
  });

  test("a long one is cut on a line boundary and says how many are behind it", () => {
    const text = Array.from({ length: RESULT_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const { head, hidden } = clampLines(text);
    expect(hidden).toBe(5);
    expect(head.split("\n")).toHaveLength(RESULT_LINES);
    /* Never mid-token: a character cut reads as corruption rather than a clip. */
    expect(head.endsWith(`line ${RESULT_LINES - 1}`)).toBe(true);
  });

  test("the clip note names where the whole of it is", () => {
    expect(clipNote(1234)).toContain("1,234");
    expect(clipNote(1234)).toContain("session file");
  });
});

describe("which line a call was pointed at", () => {
  /* For the one gesture that wants it: a path in a tool call is clickable into
     the file viewer, and the viewer opens where the call was looking. */
  test("a Read with an offset says where it started", () => {
    const args = argsOf("Read", { file_path: "src/lib/finding.ts", offset: 240, limit: 60 });
    expect(startLine(args)).toBe(240);
  });

  test("a Read of a whole file names no line", () => {
    expect(startLine(argsOf("Read", { file_path: "src/lib/finding.ts" }))).toBeNull();
  });

  test("an Edit names no line, and does not guess one", () => {
    /* It says what text it replaced rather than where, and finding that text in
       the file would put the viewer confidently in the wrong place whenever the
       string occurs twice. The honest answer is the top of the file. */
    const args = argsOf("Edit", {
      file_path: "src/lib/finding.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(startLine(args)).toBeNull();
  });

  test("a zero or a negative offset is not a line", () => {
    /* Lines are 1-based everywhere that counts them, so a 0 is a tool saying
       "from the beginning" rather than naming a place. */
    expect(startLine(argsOf("Read", { file_path: "a.ts", offset: 0 }))).toBeNull();
    expect(startLine(argsOf("Read", { file_path: "a.ts", offset: -5 }))).toBeNull();
  });

  test("a call with no arguments at all names no line", () => {
    expect(startLine([])).toBeNull();
  });
});
