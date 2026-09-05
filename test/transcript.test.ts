import { expect, test, describe } from "bun:test";
import {
  blocksOf,
  foldCount,
  foldSummary,
  longFold,
  MIN_FOLD,
  runFoldCap,
} from "../src/lib/transcript";
import type { Line } from "../src/lib/conversation.svelte";
import { RESUME_CAP, RESUME_FAILED_CAP, resumePrompt } from "../src/lib/rousing";
import {
  RESEND_CAP,
  isResendMark,
  resendMark,
  withResendMark,
} from "../src/lib/classify";

const you = (text: string): Line => ({ kind: "you", text });
const said = (text: string): Line => ({ kind: "text", text });
const tool = (text: string): Line => ({ kind: "tool", text });
const bad = (text: string): Line => ({ kind: "error", text });
const carried = (text: string, note?: string): Line =>
  note ? { kind: "summary", text, note } : { kind: "summary", text };
const skill = (text: string, note?: string): Line =>
  note ? { kind: "skill", text, note } : { kind: "skill", text };
const ran = (text: string, note?: string): Line =>
  note ? { kind: "shell", text, note } : { kind: "shell", text };
const roused = (state?: Line["state"]): Line =>
  state ? { kind: "you", text: resumePrompt(), state } : { kind: "you", text: resumePrompt() };

/** What a column came out as, in one readable string: `t` for a line, and a
 *  folded group as its size. */
const shape = (lines: Line[]) =>
  blocksOf(lines)
    .map((b) =>
      b.kind === "line"
        ? b.line.kind
        : b.kind === "long"
          ? `[${
              b.line.kind === "skill"
                ? "skill"
                : b.line.kind === "you"
                  ? isResendMark(b.line.text)
                    ? "mark"
                    : "resume"
                  : "sum"
            }]`
          : b.kind === "shell"
            ? "[run]"
            : `[${b.lines.length}]`,
    )
    .join(" ");

describe("a run of tool calls folds into one block", () => {
  test("an ordinary round: what you asked, the machinery, the answer", () => {
    expect(
      shape([
        you("fold the tool calls"),
        said("right — first, what is there"),
        tool("reading Transcript.svelte"),
        tool("reading outline.ts"),
        tool("editing Transcript.svelte"),
        said("done, and here is why"),
      ]),
    ).toBe("you text [3] text");
  });

  test("a lone call stays a line — folding it would cost more than it saves", () => {
    expect(shape([said("checking"), tool("reading foo.ts"), said("it's fine")])).toBe(
      "text tool text",
    );
    expect(MIN_FOLD).toBe(2);
  });

  test("speech between two runs keeps them apart", () => {
    expect(
      shape([
        tool("reading a"),
        tool("reading b"),
        said("now the store"),
        tool("editing c"),
        tool("editing d"),
      ]),
    ).toBe("[2] text [2]");
  });

  /* The whole reason the fold is safe: it cannot swallow anything that is not a
     tool call, so an error stays exactly where it happened. */
  test("an error breaks the run and is never folded away", () => {
    expect(
      shape([tool("reading a"), tool("reading b"), bad("exited 1"), tool("reading c")]),
    ).toBe("[2] error tool");
  });

  test("nothing folds nothing", () => {
    expect(blocksOf([])).toEqual([]);
  });

  test("a whole column of calls is one group", () => {
    expect(shape([tool("a"), tool("b"), tool("c"), tool("d")])).toBe("[4]");
  });

  test("the lines inside a group are the run, in order", () => {
    const blocks = blocksOf([you("go"), tool("reading a"), tool("reading b")]);
    const group = blocks[1];
    expect(group.kind).toBe("tools");
    if (group.kind !== "tools") return;
    expect(group.lines.map((l) => l.text)).toEqual(["reading a", "reading b"]);
  });
});

describe("a key that survives what happens to the column", () => {
  /* The live fold is capped and sliced off the front, so every index shifts. A
     group keyed by position would hand its open state to whatever landed on that
     index; keyed by its opening words it keeps it. */
  test("dropping lines off the front leaves a group's key alone", () => {
    const lines = [you("go"), said("ok"), tool("reading a"), tool("reading b")];
    const before = blocksOf(lines).find((b) => b.kind === "tools")!.key;
    const after = blocksOf(lines.slice(2)).find((b) => b.kind === "tools")!.key;
    expect(after).toBe(before);
  });

  test("a growing group keeps its key — a new call lands at the end", () => {
    const key = (ls: Line[]) => blocksOf(ls).find((b) => b.kind === "tools")!.key;
    expect(key([tool("reading a"), tool("reading b"), tool("editing c")])).toBe(
      key([tool("reading a"), tool("reading b")]),
    );
  });

  test("two runs opening with the same words are still two groups", () => {
    const keys = blocksOf([
      tool("running the suite"),
      tool("reading a"),
      said("again, then"),
      tool("running the suite"),
      tool("reading a"),
    ])
      .filter((b) => b.kind === "tools")
      .map((b) => b.key);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("the two columns share one namespace and must not collide", () => {
    const live = blocksOf([tool("a"), tool("b")], "l");
    const past = blocksOf([tool("a"), tool("b")], "h");
    expect(live[0].key).not.toBe(past[0].key);
  });

  test("a folded group cannot take a plain line's key", () => {
    const keys = blocksOf([said("x"), tool("a"), tool("b")]).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("a compaction summary folds on its own", () => {
  test("it is a fold of one, which is the opposite of MIN_FOLD and meant to be", () => {
    // A lone tool call is not worth a cap. Twenty thousand characters is.
    expect(shape([you("/compact"), carried("This session is being continued…")])).toBe(
      "you [sum]",
    );
  });

  test("it breaks a run of calls, like everything that is not a call", () => {
    expect(
      shape([tool("a"), tool("b"), carried("…"), tool("c"), tool("d")]),
    ).toBe("[2] [sum] [2]");
  });

  test("two compactions in one column get their own folds", () => {
    // Keyed by count rather than by words: every summary opens with the same
    // fixed preamble, so the text that tells tool runs apart is no help here.
    const keys = blocksOf([carried("This session…"), carried("This session…")]).map(
      (b) => b.key,
    );
    expect(new Set(keys).size).toBe(2);
  });

  test("a tool run reading 'summary' cannot open the summary's fold", () => {
    const keys = blocksOf([
      tool("summary"),
      tool("summary"),
      carried("This session…"),
    ]).map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("the two columns keep their folds apart", () => {
    const [live] = blocksOf([carried("x")], "l");
    const [past] = blocksOf([carried("x")], "h");
    expect(live.key).not.toBe(past.key);
  });

  test("the cap is the numbers, and says what it is without them", () => {
    expect(longFold(carried("…", "context compacted · 624k → 12k")).cap).toBe(
      "context compacted · 624k → 12k",
    );
    expect(longFold(carried("…")).cap).toBe("context compacted");
  });
});

describe("a skill's body folds the same way", () => {
  // Invoking a skill injects the whole file as a `user` message. Drawn as one
  // it is a prompt you appear to have typed, and the biggest on this machine
  // runs to 698k characters — so it is the same fold at a larger size.
  test("it is a fold of one, and breaks a run of calls", () => {
    expect(
      shape([tool("a"), tool("b"), skill("# Collab…", "design-review"), tool("c")]),
    ).toBe("[2] [skill] tool");
  });

  test("the cap names the skill, and says what it is when it cannot", () => {
    expect(longFold(skill("…", "design-review")).cap).toBe(
      "read the design-review skill",
    );
    expect(longFold(skill("…")).cap).toBe("read a skill");
  });

  test("a skill between two compactions renumbers neither", () => {
    // Each kind counts on its own, so which fold you have open survives one of
    // the other kind arriving above it.
    const keys = blocksOf([carried("a"), skill("b"), carried("c")]).map((b) => b.key);
    expect(keys).toEqual(["ls0", "lk0", "ls1"]);
  });

  test("a skill and a compaction cannot open each other", () => {
    const keys = blocksOf([carried("a"), skill("b")]).map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
  });

  test("two skills in one column get their own folds", () => {
    // Keyed by count rather than by words, like the summary: every skill body
    // opens with the same injected line.
    const keys = blocksOf([skill("Base directory…"), skill("Base directory…")]).map(
      (b) => b.key,
    );
    expect(new Set(keys).size).toBe(2);
  });
});

describe("what the cap says", () => {
  test("open, it says how much is in there", () => {
    expect(foldCount([tool("a"), tool("b"), tool("c")])).toBe("3 tool calls");
    expect(foldCount([tool("a")])).toBe("1 tool call");
  });

  /* The last call, not the first: at the foot of a live turn that is the one
     happening now, so a folded group is still a status. */
  test("folded, it says how much and what is happening", () => {
    expect(foldSummary([tool("reading a"), tool("editing Transcript.svelte")])).toBe(
      "2 tool calls · editing Transcript.svelte",
    );
  });

  test("a long command is cut rather than pushed off the edge", () => {
    const long = "bun test test/transcript.test.ts -t 'a run of tool calls folds'";
    const out = foldSummary([tool("a"), tool(long)]);
    expect(out.startsWith("2 tool calls · ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("a `!` run", () => {
  test("folds on its own, however little it printed", () => {
    /* Unlike a run of tool calls, which needs MIN_FOLD of them to be worth a
       cap: this fold is not trading a line of transcript for a line of chrome,
       it is trading however many hundred a build printed. */
    expect(shape([you("go"), ran("nothing to commit"), said("right")])).toBe(
      "you [run] text",
    );
  });

  test("it breaks a run of calls, like every other piece of news", () => {
    expect(shape([tool("a"), tool("b"), ran("out"), tool("c"), tool("d")])).toBe(
      "[2] [run] [2]",
    );
  });

  test("two identical commands get their own folds", () => {
    /* Keyed by count rather than by the cap, which begins with the command: two
       `!ls` in one turn would otherwise share a key — and since these start
       open, shutting one would read as the other having shut itself. */
    const keys = blocksOf([ran("x", "!ls · 1 line"), ran("y", "!ls · 1 line")]).map(
      (b) => b.key,
    );
    expect(new Set(keys).size).toBe(2);
  });

  test("the two columns do not share keys", () => {
    /* Same rule the rest of `blocksOf` keeps: history and live are folded once
       each and drawn either side of the seam. */
    const past = blocksOf([ran("x")], "h")[0].key;
    const live = blocksOf([ran("x")], "l")[0].key;
    expect(past).not.toBe(live);
  });

  test("its cap is whatever was written on it", () => {
    expect(runFoldCap(ran("out", "!bun run check · 9 lines · exit 1"))).toBe(
      "!bun run check · 9 lines · exit 1",
    );
  });

  test("a run with no cap still names itself", () => {
    /* Or the fold is a triangle beside blank space. */
    expect(runFoldCap(ran("out"))).toBe("a command that was run here");
  });
});

describe("the prompt rousing sends folds too", () => {
  // Twenty lines of instructions addressed to the agent, at the top of every
  // card a crashed wall came back with. Drawn whole they were the first screen
  // of each one, in the register of something you had typed.

  test("it folds, and the round under it still reads as a round", () => {
    expect(shape([roused(), said("looked, carried on"), you("thanks")])).toBe(
      "[resume] text you",
    );
  });

  test("an ordinary prompt is not folded, however long", () => {
    expect(shape([you("a".repeat(4000))])).toBe("you");
  });

  test("the cap says whose words they are", () => {
    expect(longFold(roused()).cap).toBe(RESUME_CAP);
    expect(RESUME_CAP).toContain("skein");
  });

  test("a send that never left says so on the cap", () => {
    // Folded, the line's own `failed` mark is not on screen to be read.
    expect(longFold(roused("failed")).cap).toBe(RESUME_FAILED_CAP);
  });

  test("an agent quoting the prompt back is speech, and speech does not fold", () => {
    expect(shape([said(`it said "${resumePrompt()}" and I looked`)])).toBe("text");
  });

  test("two roused prompts in one column cannot open each other", () => {
    // Keyed by count, like the summary and the skill: every resume prompt is
    // the same words, so the words tell them apart not at all.
    const keys = blocksOf([roused(), you("ok"), roused()]).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a roused prompt cannot open a compaction's fold", () => {
    const keys = blocksOf([carried("a"), roused()]).map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("a prompt skein sent again", () => {
  // `withResendMark` appends skein's account of the retry to your words, so the
  // line is partly yours and partly skein's — the one shape none of the folds
  // above has. Drawn whole, a healed `go` is your one word and four lines
  // explaining it, and `healNote` has already told you the same thing from
  // above, before the wait.

  const resent = (text: string, state?: Line["state"]): Line => {
    const marked = withResendMark(text, "overloaded", 2);
    return state ? { kind: "you", text: marked, state } : { kind: "you", text: marked };
  };

  /** Every block's line, in order — `tools` is the one kind that has none. */
  const linesOf = (ls: Line[]) =>
    blocksOf(ls).map((b) => (b.kind === "tools" ? null : b.line));

  test("your words stay a line, and skein's account folds under them", () => {
    expect(shape([resent("go")])).toBe("you [mark]");
  });

  test("the line drawn is your prompt, with the mark off it", () => {
    expect(linesOf([resent("go")])[0]?.text).toBe("go");
  });

  test("what went is one string — only the drawing is in two halves", () => {
    // The wire is unaffected by any of this. A mark present on the wire and
    // missing from the fold is the two folds disagreeing, which is the shape of
    // bug `01e00f30` took a machine-wide transcript sweep to run down.
    const sent = withResendMark("go", "overloaded", 2);
    expect(
      linesOf([{ kind: "you", text: sent }])
        .map((l) => l?.text)
        .join("\n\n"),
    ).toBe(sent);
  });

  test("the cap says why the prompt is here twice", () => {
    expect(longFold(linesOf([resent("go")])[1]!).cap).toBe(RESEND_CAP);
    expect(RESEND_CAP).toContain("skein");
  });

  test("a send that never left wears its mark on your words, not on the fold", () => {
    // A `failed` cap here would be claiming the *mark* never went. What never
    // went is the prompt above it, which is on screen wearing its own mark —
    // which is the whole reason the resume prompt needs its cap to say so and
    // this does not.
    const [body, fold] = linesOf([resent("go", "failed")]);
    expect(body?.state).toBe("failed");
    expect(fold?.state).toBeUndefined();
    expect(longFold(fold!).cap).toBe(RESEND_CAP);
  });

  test("an ordinary prompt is untouched", () => {
    expect(shape([you("go")])).toBe("you");
  });

  test("a resume prompt that was itself resent folds whole", () => {
    // Asked after `roused`, so it takes its mark down into the fold with it
    // rather than being split in two — the whole line is skein's either way.
    expect(shape([{ kind: "you", text: withResendMark(resumePrompt(), "dropped", 2) }])).toBe(
      "[resume]",
    );
  });

  test("two resent prompts in one column cannot open each other", () => {
    const keys = blocksOf([resent("go"), resent("again")]).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a resent prompt cannot open a roused one's fold", () => {
    const keys = blocksOf([roused(), resent("go")]).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("an agent quoting a mark back is speech, and speech does not fold", () => {
    expect(shape([said(`it said "${resendMark("overloaded", 2)}" and went again`)])).toBe(
      "text",
    );
  });
});
