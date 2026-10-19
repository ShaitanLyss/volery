import { describe, expect, test } from "bun:test";

import {
  BANG_LINES,
  type Completion,
  type Match,
  applyCompletion,
  bangOf,
  capOutput,
  commandCursor,
  handover,
  isBang,
  isContainer,
  kindLabel,
  runCap,
  tokens,
} from "../src/lib/bang";

describe("isBang", () => {
  test("a bare ! is already a shell line", () => {
    /* The field has to change on the keystroke, not once there is something
       worth running — otherwise pressing ! does nothing you can see. */
    expect(isBang("!")).toBe(true);
  });

  test("a command is one too", () => {
    expect(isBang("!git status")).toBe(true);
  });

  test("a leading space says prose", () => {
    /* Same argument resolveCommand makes about a slash: a line beginning with
       whitespace is a sentence that happens to contain the character. */
    expect(isBang(" !careful")).toBe(false);
  });

  test("a ! anywhere else is just a word", () => {
    expect(isBang("that worked!")).toBe(false);
    expect(isBang("do it!")).toBe(false);
  });

  test("nothing typed is not a shell line", () => {
    expect(isBang("")).toBe(false);
  });
});

describe("bangOf", () => {
  test("the command, without the bang", () => {
    expect(bangOf("!git status")).toBe("git status");
  });

  test("trimmed at both ends", () => {
    expect(bangOf("!  bun run check  ")).toBe("bun run check");
  });

  test("a bare bang is not a command", () => {
    /* The one distinction this function exists to make. A field turned into a
       shell line and not yet typed in has nothing to run, and Enter on it must
       not spawn a shell to run nothing. */
    expect(bangOf("!")).toBeNull();
    expect(bangOf("!   ")).toBeNull();
  });

  test("not a shell line at all", () => {
    expect(bangOf("git status")).toBeNull();
    expect(bangOf(" !ls")).toBeNull();
  });

  test("the bang survives inside the command", () => {
    /* `!!` is a command called `!` as far as this is concerned — nothing here
       reads shell history expansion, and the shell can say what it thinks. */
    expect(bangOf("!!foo")).toBe("!foo");
  });
});

describe("commandCursor", () => {
  test("one to the left of where it is in the draft", () => {
    /* `!git` with the caret at the end is offset 4 in the draft and 3 in the
        command. Getting this by one puts every completion a character out. */
    expect(commandCursor("!git", 4)).toBe(3);
  });

  test("a caret before the bang is the start of the command", () => {
    expect(commandCursor("!git", 0)).toBe(0);
  });

  test("never past the end of the command", () => {
    expect(commandCursor("!ls", 99)).toBe(2);
  });
});

describe("tokens", () => {
  /** The invariant the overlay depends on: what comes back concatenates to
   *  exactly what went in. The highlight is drawn behind a transparent
   *  textarea, so one dropped space puts every colour on the line over the
   *  wrong character. */
  const roundTrips = (line: string) =>
    expect(tokens(line).map((t) => t.text).join("")).toBe(line);

  test("the first word is the command", () => {
    expect(tokens("git status")[0]).toEqual({ text: "git", kind: "cmd" });
  });

  test("the word after a pipe is a command again", () => {
    const kinds = tokens("git log | Select-Object")
      .filter((t) => t.kind === "cmd")
      .map((t) => t.text);
    expect(kinds).toEqual(["git", "Select-Object"]);
  });

  test("a flag is a parameter either way it is written", () => {
    const kinds = tokens("ls -Path . --all").filter((t) => t.kind === "param");
    expect(kinds.map((t) => t.text)).toEqual(["-Path", "--all"]);
  });

  test("a bare number is not a parameter", () => {
    expect(tokens("head 20").find((t) => t.kind === "num")?.text).toBe("20");
  });

  test("a path stays one word", () => {
    /* The point of classifying whole words rather than characters: `\`, `/`,
       `.`, `:` and `-` all live inside paths, and breaking on them would
       shred every path on this machine. */
    /* Spelled out whole, because it also pins the merge: the space and the
       path are both `plain` and arrive as one token, which is what keeps the
       overlay's DOM down on a line full of paths. */
    expect(tokens("cat src-tauri/src/bang.rs")).toEqual([
      { text: "cat", kind: "cmd" },
      { text: " src-tauri/src/bang.rs", kind: "plain" },
    ]);
  });

  test("a quoted string is one token, quotes and all", () => {
    const toks = tokens(`echo "hello world"`);
    expect(toks.find((t) => t.kind === "str")?.text).toBe(`"hello world"`);
  });

  test("an unterminated string still colours as one", () => {
    /* Which is the state a string is in for the whole time you are typing it. */
    expect(tokens(`echo "half`).find((t) => t.kind === "str")?.text).toBe(`"half`);
  });

  test("a doubled quote inside is content, not the end", () => {
    expect(tokens(`echo 'it''s'`).find((t) => t.kind === "str")?.text).toBe(
      `'it''s'`,
    );
  });

  test("variables, braced or not", () => {
    expect(tokens("echo $PWD").find((t) => t.kind === "var")?.text).toBe("$PWD");
    expect(tokens("echo ${env:PATH}").find((t) => t.kind === "var")?.text).toBe(
      "${env:PATH}",
    );
  });

  test("a comment runs to the end", () => {
    expect(tokens("ls # why not").find((t) => t.kind === "comment")?.text).toBe(
      "# why not",
    );
  });

  test("a hash inside a word is part of the word", () => {
    expect(tokens("cat a#b.txt").some((t) => t.kind === "comment")).toBe(false);
  });

  test("&& is one operator, not two", () => {
    expect(tokens("a && b").find((t) => t.kind === "op")?.text).toBe("&&");
  });

  test("everything round trips", () => {
    roundTrips("git status");
    roundTrips("  ");
    roundTrips("!");
    roundTrips(`bun test test/bang.test.ts -t "tokens"`);
    roundTrips("cargo build 2>&1 | Select-String error");
    roundTrips("cd ../.. ; ls -la");
    roundTrips(`Get-ChildItem -Path 'C:\\Users\\x' -Recurse # find it`);
    roundTrips("echo ${env:PATH} $x");
    roundTrips("");
  });

  test("nothing typed is no tokens", () => {
    expect(tokens("")).toEqual([]);
  });
});

describe("kindLabel", () => {
  test("PowerShell's jargon becomes the dock's voice", () => {
    expect(kindLabel("ProviderContainer")).toBe("folder");
    expect(kindLabel("ProviderItem")).toBe("file");
    expect(kindLabel("ParameterName")).toBe("parameter");
  });

  test("an unrecognised type is shown rather than dropped", () => {
    /* A result type this build has not heard of is still information about
       what is about to be inserted. */
    expect(kindLabel("SomethingNew")).toBe("somethingnew");
  });
});

describe("applyCompletion", () => {
  const at = (index: number, length: number): Completion => ({
    index,
    length,
    matches: [],
  });
  const m = (text: string, kind = "ProviderItem"): Match => ({
    text,
    label: text,
    kind,
  });

  test("the shell's span is what gets replaced", () => {
    /* `cat src/li` — PowerShell says five characters go, starting at 4. */
    const done = applyCompletion("cat src/li", at(4, 6), m(".\\src\\lib\\bang.ts"));
    expect(done.cmd).toBe("cat .\\src\\lib\\bang.ts");
    expect(done.cursor).toBe(done.cmd.length);
  });

  test("a folder gets its separator, so Tab twice walks down", () => {
    const done = applyCompletion("cat src/l", at(4, 5), m(".\\src\\lib", "ProviderContainer"));
    expect(done.cmd).toBe("cat .\\src\\lib\\");
  });

  test("the separator matches the path it is joining", () => {
    /* A backslash pushed into a path written with slashes reads as an escape. */
    const done = applyCompletion("cat s", at(4, 1), m("./src", "ProviderContainer"));
    expect(done.cmd).toBe("cat ./src/");
  });

  test("a folder that already ends in one is left alone", () => {
    const done = applyCompletion("cat s", at(4, 1), m("./src/", "ProviderContainer"));
    expect(done.cmd).toBe("cat ./src/");
  });

  test("a file gets no separator", () => {
    const done = applyCompletion("cat s", at(4, 1), m("./src.ts"));
    expect(done.cmd).toBe("cat ./src.ts");
  });

  test("text before and after the span both survive", () => {
    const done = applyCompletion("cat li -Raw", at(4, 2), m("lib"));
    expect(done.cmd).toBe("cat lib -Raw");
    expect(done.cursor).toBe(7);
  });

  test("a stale span cannot slice off the end of the line", () => {
    /* The span describes the command as it was when the request went out, and
       a keystroke can land while it is in flight. Clamped, so the worst case is
       a completion in the wrong place rather than a crash. */
    const done = applyCompletion("ls", at(40, 10), m("x"));
    expect(done.cmd).toBe("lsx");
  });

  test("a zero-length span inserts rather than replaces", () => {
    const done = applyCompletion("git ", at(4, 0), m("status", "ParameterValue"));
    expect(done.cmd).toBe("git status");
  });
});

describe("isContainer", () => {
  test("folders and namespaces are things you keep going into", () => {
    expect(isContainer("ProviderContainer")).toBe(true);
    expect(isContainer("Namespace")).toBe(true);
    expect(isContainer("ProviderItem")).toBe(false);
  });
});

describe("capOutput", () => {
  test("short output is kept whole", () => {
    expect(capOutput(["a", "b"])).toEqual({ text: "a\nb", dropped: 0 });
  });

  test("nothing printed is nothing kept", () => {
    expect(capOutput([])).toEqual({ text: "", dropped: 0 });
  });

  test("the tail survives, and says how much did not", () => {
    /* The tail rather than the head, the same call the console's scrollback
       makes: the thing that went wrong is at the end. */
    const flood = Array.from({ length: 10 }, (_, i) => String(i));
    expect(capOutput(flood, 3)).toEqual({ text: "7\n8\n9", dropped: 7 });
  });

  test("exactly the cap drops nothing", () => {
    const some = Array.from({ length: 5 }, (_, i) => String(i));
    expect(capOutput(some, 5).dropped).toBe(0);
  });

  test("the default is a screenful of scrolling, not a build's worth", () => {
    expect(BANG_LINES).toBe(400);
  });
});

describe("runCap", () => {
  test("a run still going says so", () => {
    expect(runCap("bun run test", null, 12, true)).toBe("!bun run test · running");
  });

  test("a clean run needs nothing said about its code", () => {
    expect(runCap("ls", 0, 4, false)).toBe("!ls · 4 lines");
  });

  test("a failure carries its code", () => {
    expect(runCap("bun run check", 1, 9, false)).toBe("!bun run check · 9 lines · exit 1");
  });

  test("one line is one line", () => {
    expect(runCap("pwd", 0, 1, false)).toBe("!pwd · 1 line");
  });

  test("a run that was stopped says that instead of a code", () => {
    /* Escape kills the tree, and there is no exit code that means "you did
       this on purpose" — the same distinction wasStopped draws for a turn. */
    expect(runCap("sleep 60", null, 0, false)).toBe("!sleep 60 · 0 lines · stopped");
  });
});

describe("handover", () => {
  const out = { text: "nothing to commit", dropped: 0 };

  test("the command, where it ran, and what it said", () => {
    const text = handover("git status", "C:\\x\\skein", 0, out);
    expect(text).toContain("C:\\x\\skein");
    expect(text).toContain("$ git status");
    expect(text).toContain("nothing to commit");
    expect(text).toContain("```console");
  });

  test("a clean exit is still stated", () => {
    /* A command that printed nothing at all is exactly the case where the code
       is all there is to go on. */
    expect(handover("true", "/x", 0, { text: "", dropped: 0 })).toContain(
      "exit code 0",
    );
  });

  test("a failure carries its code", () => {
    expect(handover("false", "/x", 1, out)).toContain("exit code 1");
  });

  test("truncation is said in words", () => {
    /* Or the agent reasons confidently about output it was never shown. */
    const text = handover("build", "/x", 0, { text: "tail", dropped: 3400 });
    expect(text).toContain("3400 earlier lines dropped");
  });

  test("a stopped run says so instead of claiming a code", () => {
    expect(handover("sleep 60", "/x", null, out)).toContain("stopped before it finished");
  });

  test("the CLI's own wrapper is not borrowed", () => {
    /* `<local-command-stdout>` is the binary's marker for output it injected
       itself; putting it in a prompt would be this window claiming to be the
       thing that wrote it. */
    expect(handover("ls", "/x", 0, out)).not.toContain("local-command-stdout");
  });
});

describe("capOutput counts what was trimmed before it", () => {
  test("lines already gone are added to what the cap drops", () => {
    expect(capOutput(["a", "b"], 400, 7)).toEqual({ text: "a\nb", dropped: 7 });
    expect(capOutput(["a", "b", "c"], 2, 7)).toEqual({ text: "b\nc", dropped: 8 });
  });
});
