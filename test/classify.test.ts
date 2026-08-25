import { expect, test, describe } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASK_TOOLS,
  CLEAN_BLOOM_S,
  CLEAN_WARM_S,
  QUESTION_BLOOM_S,
  SKEIN_ASK_TOOL,
  backgroundKind,
  baseModel,
  compactNote,
  NUDGE_BUDGET,
  HOLD_LINE,
  NUDGE_PROMPT_TEXT,
  NUDGE_TEXT,
  nudgeGaveUpNote,
  nudgeNote,
  UNACKNOWLEDGED_LINE,
  unwokenNote,
  WAKE_GRACE_S,
  compactStat,
  contextWindowFor,
  describeTool,
  endingFor,
  endsOnQuestion,
  isCompactSummary,
  skillBody,
  isStopNote,
  isTaskNotification,
  jobLabel,
  localAnswer,
  localCommandAwaiting,
  parseTaskNotification,
  sameModel,
  spanOf,
  startedJob,
  taskNumberOf,
  textOf,
  urgencyFor,
  workflowMeta,
  workflowName,
  wasStopped,
  wasMalformedRequest,
  wasOverloaded,
  wasRateLimited,
  healKindOf,
  healDelayMs,
  healNote,
  saySoon,
  HEAL_BUDGET,
  windowForObserved,
} from "../src/lib/classify";

describe("urgency decays with neglect", () => {
  test("a break is loud immediately and stays loud", () => {
    expect(urgencyFor("error", 0)).toBe("fail");
    expect(urgencyFor("error", 99_999)).toBe("fail");
  });

  test("a clean finish starts quiet, warms, then blooms", () => {
    expect(urgencyFor("ok", 0)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S - 1)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S)).toBe("soft");
    expect(urgencyFor("ok", CLEAN_BLOOM_S - 1)).toBe("soft");
    expect(urgencyFor("ok", CLEAN_BLOOM_S)).toBe("ask");
  });

  test("an unanswered question escalates faster than a clean finish", () => {
    expect(urgencyFor("question", 0)).toBe("soft");
    expect(urgencyFor("question", QUESTION_BLOOM_S)).toBe("ask");
    // At two minutes a question is already loud; a clean finish is still quiet.
    expect(urgencyFor("question", 120)).toBe("ask");
    expect(urgencyFor("ok", 120)).toBe("rest");
  });

  test("a structured ask is loud regardless of age", () => {
    expect(urgencyFor("asked", 0)).toBe("ask");
  });
});

describe("a card set aside stops decaying", () => {
  /* The whole feature, in one place: what warms a card is nothing but how long
     you have left it, so a card you put by deliberately would go amber for
     doing exactly what you asked. Everything downstream — the waiting cycle,
     the dock's count, the peek, the card's colour — reads the tier, so
     silencing it here silences all four together. */
  test("neglect no longer warms it, however long it stands", () => {
    expect(urgencyFor("ok", 0, true)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S, true)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_BLOOM_S, true)).toBe("rest");
    expect(urgencyFor("ok", 99_999, true)).toBe("rest");
  });

  test("a question it was left on goes quiet too", () => {
    /* Prose ending in a question mark is an *inference* about a turn nobody
       came back to, which is the same reading `aside` withdraws. */
    expect(urgencyFor("question", QUESTION_BLOOM_S, true)).toBe("rest");
  });

  test("a turn you stopped yourself goes quiet too", () => {
    expect(urgencyFor("stopped", CLEAN_BLOOM_S, true)).toBe("rest");
  });

  test("but a break still says so", () => {
    /* Not neglect: something happened. In practice a card set aside has no
       process doing anything, so this is the one you set aside mid-turn — and
       it must still be able to report that it broke. */
    expect(urgencyFor("error", 0, true)).toBe("fail");
    expect(urgencyFor("asked", 0, true)).toBe("ask");
  });

  test("and left out, nothing changes", () => {
    expect(urgencyFor("ok", CLEAN_BLOOM_S, false)).toBe("ask");
    expect(urgencyFor("ok", CLEAN_BLOOM_S)).toBe("ask");
  });
});

describe("endsOnQuestion", () => {
  test("plain closing question", () => {
    expect(endsOnQuestion("I've done the thing. Want me to push it?")).toBe(true);
  });

  test("question followed by a list still counts — the last line is what matters", () => {
    expect(endsOnQuestion("Done.\n\n- a\n- b\n\nShall I continue?")).toBe(true);
  });

  test("a question in the middle does not count", () => {
    expect(endsOnQuestion("Should I? I did it anyway. All tests pass.")).toBe(false);
  });

  test("tolerates trailing markdown and quotes", () => {
    expect(endsOnQuestion("Is that right?**")).toBe(true);
    expect(endsOnQuestion('He asked "is that right?"')).toBe(true);
  });

  test("statements are not questions", () => {
    expect(endsOnQuestion("All done. 14 passing, 1 skipped.")).toBe(false);
    expect(endsOnQuestion("")).toBe(false);
  });
});

describe("describeTool degrades before arguments arrive", () => {
  test("bare verb at content_block_start, sharpened when the block lands", () => {
    expect(describeTool("Read", {})).toBe("reading a file");
    expect(describeTool("Read", { file_path: "C:\\a\\b\\package.json" })).toBe(
      "reading package.json",
    );
  });

  test("never renders a dangling preposition", () => {
    for (const t of ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Task"]) {
      expect(describeTool(t, {}).trim()).toBe(describeTool(t, {}));
      expect(describeTool(t, {})).not.toMatch(/\s$/);
    }
  });

  test("unknown tools fall through to their name, since the tool list is per-session", () => {
    expect(describeTool("DesignSync", {})).toBe("DesignSync");
    expect(describeTool("mcp__foo__bar", {})).toBe("mcp__foo__bar");
  });

  test("skein's own question is named, not spelled out", () => {
    /* It fell through the rule above and drew `mcp__skein__ask_user` on the
       card — and now directly above the answer the transcript keeps under it. */
    expect(describeTool(SKEIN_ASK_TOOL, { question: "one or two?" })).toBe(
      "asked you a question",
    );
    expect(describeTool(SKEIN_ASK_TOOL, {})).toBe("asked you a question");
    expect(
      describeTool(SKEIN_ASK_TOOL, { questions: [{ question: "a?" }, { question: "b?" }] }),
    ).toBe("asked you 2 things");
  });

  test("every other tool skein hosts is named too", () => {
    /* Six of nineteen were named and thirteen drew the raw wire name — so a
       card that had just put an image on the wall said `mcp__skein__pin` in a
       panel whose whole register is lowercase prose. */
    expect(describeTool("mcp__skein__recall", { card: "1b06f3da" })).toBe("read 1b06f3da's words");
    expect(describeTool("mcp__skein__recall", {})).toBe("read another card's words");
    expect(describeTool("mcp__skein__pin", { path: "a/b/chart.png" })).toBe("pinned chart.png");
    expect(describeTool("mcp__skein__repin", { image: "last", remove: true })).toBe(
      "took an image down",
    );
    expect(describeTool("mcp__skein__spawn", { title: "the migration" })).toBe(
      "opened a card: the migration",
    );
    expect(describeTool("mcp__skein__take", { item: "2c1b45c2", release: true })).toBe(
      "put back 2c1b45c2",
    );
    expect(describeTool("mcp__skein__sink", { settled: true })).toBe(
      "read what the sink has settled",
    );
    expect(describeTool("mcp__skein__wake_me", { seconds: 480 })).toBe("back in 8 minutes");
    expect(describeTool("mcp__skein__touched", { paths: ["src/a.ts", "src/b.ts"] })).toBe(
      "checked who else is in 2 files",
    );
  });

  test("the vocabulary is the whole vocabulary, held against the rust that serves it", () => {
    /* The thirteen were not a judgement about which calls matter — they were
       simply never added, one server at a time, and nothing said so. Each MCP
       server declares its names as `pub const *_TOOL`, so that is the list this
       file owes a case for, and a new tool fails here on the day it is added
       rather than on the day somebody notices a wire name on a card. */
    const rust = readdirSync("src-tauri/src")
      .filter((f) => f.endsWith(".rs"))
      .flatMap((f) => [
        ...readFileSync(join("src-tauri/src", f), "utf8").matchAll(
          /pub const [A-Z_]+_TOOL: &str = "([a-z_]+)"/g,
        ),
      ])
      .map((m) => `mcp__skein__${m[1]}`);

    expect(rust.length).toBeGreaterThan(15);
    for (const name of rust) expect(describeTool(name, {})).not.toBe(name);
  });

  test("it is not an ASK_TOOL, and must not become one", () => {
    /* `ASK_TOOLS` decides the `asked` ending, which is for a turn that stopped
       on a question. This one parks mid-turn and resumes in place, so a card
       whose question you answered would settle amber and stay there. */
    expect(ASK_TOOLS.has(SKEIN_ASK_TOOL)).toBe(false);
  });
});

describe("contextWindowFor", () => {
  test("recognises the 1M variant", () => {
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5")).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });
});

describe("a session read off disk has no declared tier", () => {
  /* A transcript records the bare per-message id only, so occupancy is the one
     piece of evidence about the window. The real case: a caravan session whose
     last request carried 443k tokens. */
  test("occupancy above the known window can only mean a wider one", () => {
    expect(windowForObserved("claude-opus-5", 443_000)).toBe(1_000_000);
    expect(windowForObserved(undefined, 228_416)).toBe(1_000_000);
  });

  test("occupancy that fits is not evidence of anything", () => {
    expect(windowForObserved("claude-opus-5", 78_000)).toBe(200_000);
    expect(windowForObserved("claude-opus-5", 200_000)).toBe(200_000);
    expect(windowForObserved(undefined, 0)).toBe(200_000);
  });

  test("a declared tier is not narrowed by a smaller reading", () => {
    expect(windowForObserved("claude-opus-5[1m]", 12_000)).toBe(1_000_000);
  });
});

describe("the window tier only exists on the init id", () => {
  /* Probed against claude 2.1.227: system/init says claude-opus-5[1m], every
     assistant message on the same session says claude-opus-5. Believing the
     second one shrinks a 1M ring to 200k and reports 46% for 9%. */
  test("the bare per-message id is the same model as the declared one", () => {
    expect(sameModel("claude-opus-5", "claude-opus-5[1m]")).toBe(true);
    expect(sameModel("claude-opus-5[1m]", "claude-opus-5")).toBe(true);
  });

  test("a genuinely different model is not the same model", () => {
    expect(sameModel("claude-sonnet-5", "claude-opus-5[1m]")).toBe(false);
    expect(sameModel("claude-opus-4-5", "claude-opus-5")).toBe(false);
  });

  test("nothing is the same as nothing", () => {
    expect(sameModel(undefined, undefined)).toBe(false);
    expect(sameModel("", "")).toBe(false);
    expect(sameModel("claude-opus-5", undefined)).toBe(false);
  });

  test("both spellings of the tier are stripped", () => {
    expect(baseModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(baseModel("claude-sonnet-4-5-1m")).toBe("claude-sonnet-4-5");
    expect(baseModel("claude-opus-5")).toBe("claude-opus-5");
  });

  test("and the window still follows from the declared id", () => {
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextWindowFor(baseModel("claude-opus-5[1m]"))).toBe(200_000);
  });
});

describe("textOf", () => {
  test("blocks, in order, text only", () => {
    expect(
      textOf([
        { type: "text", text: "one" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });

  test("a bare string is content too — tool results use both shapes", () => {
    expect(textOf("  done  ")).toBe("done");
  });

  test("a message with no prose is empty, not noise", () => {
    expect(textOf([{ type: "tool_use", name: "Read", input: {} }])).toBe("");
    expect(textOf(undefined)).toBe("");
    expect(textOf(null)).toBe("");
    expect(textOf(42)).toBe("");
  });
});

describe("endingFor", () => {
  test("api_error_status marks a break even when is_error is absent", () => {
    const { ending, detail } = endingFor(
      { subtype: "success", api_error_status: "rate_limit_error" },
      "whatever",
      false,
    );
    expect(ending).toBe("error");
    expect(detail).toBe("rate_limit_error");
  });

  test("the message is the detail, not the bare status", () => {
    /* This read the other way round for most of the app's life, and every API
       error on the wall was drawn as `400` — a status code where the account
       of the failure belongs, while the sentence explaining it sat one line
       above in the transcript because the CLI had printed it. */
    const { detail } = endingFor(
      {
        is_error: true,
        api_error_status: 400,
        result: "API Error: 400 The request body is not valid JSON: unexpected end of data",
      },
      "",
      false,
    );
    expect(detail).toContain("not valid JSON");
    expect(detail).not.toBe("400");
  });

  test("but the status still answers when nothing was said", () => {
    /* `rate_limit_error` with no message beats "unknown error", so the status
       stays as the fallback rather than being dropped. */
    expect(endingFor({ is_error: true, api_error_status: 429, result: "  " }, "", false).detail).toBe(
      429,
    );
  });

  test("a non-success subtype is a break", () => {
    expect(endingFor({ subtype: "error_max_turns" }, "", false).ending).toBe("error");
  });

  test("clean success on a statement is 'ok'", () => {
    expect(endingFor({ subtype: "success" }, "All done.", false).ending).toBe("ok");
  });

  test("clean success ending on a question is 'question'", () => {
    expect(endingFor({ subtype: "success" }, "Push it?", false).ending).toBe("question");
  });

  test("an ask tool outranks the text heuristic", () => {
    expect(endingFor({ subtype: "success" }, "All done.", true).ending).toBe("asked");
  });
});

describe("a turn somebody stopped", () => {
  /* Verbatim from `tools/probe-interrupt.ts` against claude 2.1.229, minus the
     fields nothing here reads. Every mark of a failure is on it — which is the
     whole reason `terminal_reason` has to be consulted first. */
  const aborted = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    terminal_reason: "aborted_streaming",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
  };

  test("is not a failure, though it arrives dressed as one", () => {
    expect(endingFor(aborted, "half an answ", false).ending).toBe("stopped");
  });

  test("outranks the question heuristic, which is reading a severed sentence", () => {
    /* The partial answer can end anywhere, including on a question mark it was
       nowhere near finished asking. */
    expect(endingFor(aborted, "Should I also", false).ending).toBe("stopped");
    expect(endingFor(aborted, "Shall I go on?", false).ending).toBe("stopped");
  });

  test("an interrupt during a tool call reads the same way", () => {
    expect(wasStopped({ ...aborted, terminal_reason: "aborted_tools" })).toBe(true);
  });

  test("a real break is still a break", () => {
    expect(wasStopped({ terminal_reason: "model_error" })).toBe(false);
    expect(wasStopped({ terminal_reason: "budget_exhausted" })).toBe(false);
    /* Older results carry no terminal_reason at all. */
    expect(wasStopped({ subtype: "error_during_execution", is_error: true })).toBe(false);
    expect(endingFor({ subtype: "error_max_turns" }, "", false).ending).toBe("error");
  });

  test("a clean turn is not stopped", () => {
    expect(wasStopped({ terminal_reason: "completed", subtype: "success" })).toBe(false);
  });

  test("the card warms on the same clock a clean finish does", () => {
    /* Nothing went wrong and nobody is waiting on an answer — but a card you
       stopped is just as easy to walk away from. */
    expect(urgencyFor("stopped", 0)).toBe("rest");
    expect(urgencyFor("stopped", CLEAN_WARM_S)).toBe("soft");
    expect(urgencyFor("stopped", CLEAN_BLOOM_S)).toBe("ask");
  });
});

describe("the CLI's own note about a stop", () => {
  /* Both wordings are real: taken from the transcripts on this machine, where
     the second appears when a tool call was in flight. */
  test("is known on sight, in either wording", () => {
    expect(isStopNote("[Request interrupted by user]")).toBe(true);
    expect(isStopNote("[Request interrupted by user for tool use]")).toBe(true);
    expect(isStopNote("  [Request interrupted by user]  ")).toBe(true);
  });

  test("does not swallow somebody quoting it", () => {
    /* It has to be the whole line. Otherwise a prompt *about* interrupting —
       which is a thing you would type at this app — would vanish from the
       transcript instead of being sent visibly. */
    expect(isStopNote("why did [Request interrupted by user] appear?")).toBe(false);
    expect(isStopNote("[Request interrupted]")).toBe(false);
    expect(isStopNote("interrupted")).toBe(false);
  });
});

describe("a turn the CLI answered by itself", () => {
  /* The three shapes below are cut from `tools/probe-commands.ts` run against
     claude 2.1.232 with Skein's exact argv. `num_turns: 0` is the whole test:
     it counts round trips to a model, so zero means nothing was asked of one
     and the sentence in `result` is the CLI's own. */
  test("a local command's answer is the only thing it said", () => {
    expect(
      localAnswer({
        type: "result",
        num_turns: 0,
        subtype: "success",
        is_error: false,
        result: "Set model to Sonnet 5 for this session only",
      }),
    ).toBe("Set model to Sonnet 5 for this session only");

    expect(
      localAnswer({ type: "result", num_turns: 0, result: "Not enough messages to compact." }),
    ).toBe("Not enough messages to compact.");

    /* A refusal is still an answer, and the card has to show it or the gesture
       looks like it did nothing. */
    expect(
      localAnswer({ type: "result", num_turns: 0, result: "/rewind isn't available in this environment." }),
    ).toBe("/rewind isn't available in this environment.");
  });

  test("an ordinary turn is not one, however short", () => {
    /* `result` on a real turn is the answer the transcript already carries, so
       reading it here would print every reply twice. */
    expect(localAnswer({ type: "result", num_turns: 1, result: "Hi" })).toBeNull();
    /* The rate-limited turn that sat beside them in the probe: refused before
       a token was generated, and still one turn. */
    expect(
      localAnswer({
        type: "result",
        num_turns: 1,
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit",
      }),
    ).toBeNull();
  });

  test("nothing said is nothing to draw", () => {
    expect(localAnswer({ type: "result", num_turns: 0, result: "" })).toBeNull();
    expect(localAnswer({ type: "result", num_turns: 0, result: "   " })).toBeNull();
    expect(localAnswer({ type: "result", num_turns: 0 })).toBeNull();
    expect(localAnswer(undefined)).toBeNull();
  });

  /* And the acknowledgement that never comes. `tools/probe-echo.ts`,
     2026-08-25: `/model sonnet` returned a result with `num_turns: 0` and no
     `user` event at all, where the two ordinary prompts either side of it were
     replayed. So the line stayed `awaited`, `awaiting` never reached zero, and
     the card read `sent, not picked up` and spent its whole nudge budget for
     the life of the process. */
  describe("closing the books on one by hand", () => {
    test("the command is claimed, the prompt queued behind it is not", () => {
      /* The whole risk of the fix: claim the wrong line and a prompt still
         sitting in the queue is marked delivered, and its own echo then finds
         nothing to claim and draws your words a second time. */
      expect(localCommandAwaiting(["/compact", "now fix the tests"])).toBe("/compact");
      expect(localCommandAwaiting(["now fix the tests", "/compact"])).toBe("/compact");
    });

    test("oldest first, with two outstanding", () => {
      /* Delivery is sequential, so the answer belongs to the earlier — the
         same rule `#echoOf` follows for an ordinary echo. */
      expect(localCommandAwaiting(["/model sonnet", "/effort high"])).toBe("/model sonnet");
    });

    test("nothing slash-shaped is nothing to claim", () => {
      /* Rather than claiming *something* because a local answer arrived. A
         locally-answered turn whose prompt this window never sent is a
         terminal typing into the same session, and eating a line here would be
         Skein closing books that are not its own. */
      expect(localCommandAwaiting(["go", "now fix the tests"])).toBeNull();
      expect(localCommandAwaiting([])).toBeNull();
    });

    test("the slash may be behind whitespace", () => {
      /* `echo` draws the line as typed; the trim is the same one `#echoOf`
         matches on, so the two agree about which line this is. */
      expect(localCommandAwaiting(["  /compact  "])).toBe("  /compact  ");
    });
  });
});

/* ── Work that outlives a turn ────────────────────────────────────────────
 *
 * Every string below is verbatim from this machine's transcripts, read
 * 2026-08-14 across all 496 files. The receipts and the notification are the
 * only account the wire gives of a job, so getting them wrong is the difference
 * between a card that says it is busy and one that says it is at rest while
 * twelve pytest workers run underneath it. */
describe("background jobs", () => {
  test("a backgrounded command is one; an ordinary command is not", () => {
    expect(
      backgroundKind("Bash", {
        command: "uv run pytest tests/ -n 6",
        run_in_background: true,
      }),
    ).toBe("command");
    expect(backgroundKind("Bash", { command: "ls nova rise" })).toBeNull();
    expect(backgroundKind("Bash", { command: "ls", run_in_background: false })).toBeNull();
  });

  test("a subagent backgrounds unless it is told not to", () => {
    /* The default in this build, which is why an `Agent` call that nobody
       configured still ends its turn with the work outstanding. */
    expect(backgroundKind("Agent", { subagent_type: "Explore" })).toBe("agent");
    expect(backgroundKind("Agent", { run_in_background: true })).toBe("agent");
    expect(backgroundKind("Agent", { run_in_background: false })).toBeNull();
    /* The old name for the same tool. */
    expect(backgroundKind("Task", { description: "x" })).toBe("agent");
  });

  test("a monitor is always one, and a read is never one", () => {
    expect(backgroundKind("Monitor", { command: "while true; do :; done" })).toBe("watch");
    expect(backgroundKind("Read", { file_path: "a.ts" })).toBeNull();
    expect(backgroundKind("TaskOutput", { task_id: "b4lq9y6zq" })).toBeNull();
  });

  test("the label prefers the words written to be read", () => {
    expect(
      jobLabel("Bash", {
        command: "uv run python scripts/batch_new_plans.py manifest.txt out",
        description: "Run pipeline over 15 new/changed plans",
        run_in_background: true,
      }),
    ).toBe("Run pipeline over 15 new/changed plans");
    /* No description: the command is what there is. */
    expect(jobLabel("Bash", { command: "uv run pytest tests/ -n 6" })).toBe(
      "uv run pytest tests/ -n 6",
    );
    expect(jobLabel("Agent", {})).toBe("a subagent");
  });

  test("the three receipts, verbatim", () => {
    expect(
      startedJob(
        "Command running in background with ID: btuqox9zy. Output is being written to: C:/Temp/claude/x/tasks/btuqox9zy.output. You will be notified when it completes.",
      ),
    ).toEqual({
      started: true,
      taskId: "btuqox9zy",
      outputPath: "C:/Temp/claude/x/tasks/btuqox9zy.output",
      journalDir: null,
    });

    expect(startedJob("Monitor started (task bc4v3btv8, timeout 1800000ms). You will be notified on each event.")).toEqual(
      { started: true, taskId: "bc4v3btv8", outputPath: null, journalDir: null },
    );

    /* The agent's receipt names no path, and its id is the `agentId` — the
       same value the completion notification quotes back as `<task-id>`, which
       is what names its transcript on disk. Kept because it is needed, and the
       instruction it carries is about user-facing replies. */
    const agent = startedJob(
      "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aabf084cb860a82c6",
    );
    expect(agent.started).toBe(true);
    expect(agent.taskId).toBe("aabf084cb860a82c6");
    expect(agent.outputPath).toBeNull();
    /* Only a workflow has a journal. A subagent's receipt names no directory,
       and inventing one for it would have the poller stat a path that is not
       there once per tick, per card. */
    expect(agent.journalDir).toBeNull();
  });

  test("a windows path with spaces, stopped at .output", () => {
    /* The receipt carries on talking after the path — a greedy match swallows
       the next two sentences, and a path that stops at whitespace loses
       everything after `Local Settings`. Both were live risks here. */
    const r = startedJob(
      "Command running in background with ID: b9cln7i6a. Output is being written to: C:\\Users\\LYSS~1.DEL\\AppData\\Local Settings\\Temp\\claude\\slug\\sess\\tasks\\b9cln7i6a.output. You will be notified when it completes. To check interim output, use Read on that file path.",
    );
    expect(r.outputPath).toBe(
      "C:\\Users\\LYSS~1.DEL\\AppData\\Local Settings\\Temp\\claude\\slug\\sess\\tasks\\b9cln7i6a.output",
    );
  });

  test("a receipt with no path still starts a job", () => {
    /* Only Bash names one. A job with no path is still a job, and still worth
       persisting — the card can say what was lost even where it cannot say
       where to read it. */
    expect(
      startedJob("Command running in background with ID: bq7zz1abc."),
    ).toEqual({ started: true, taskId: "bq7zz1abc", outputPath: null, journalDir: null });
  });

  test("an inline answer is not a receipt, which is how a job is dropped", () => {
    /* The only thing separating an `Agent` that backgrounded from one that ran
       to completion in place. */
    expect(startedJob("Here are the three files you asked for: …")).toEqual({
      started: false,
      taskId: null,
      outputPath: null,
      journalDir: null,
    });
    expect(startedJob("")).toEqual({
      started: false,
      taskId: null,
      outputPath: null,
      journalDir: null,
    });
  });
});

describe("task notifications", () => {
  const done = `<task-notification>
<task-id>b1i328ewu</task-id>
<tool-use-id>toolu_01DAtQaKTV5KhC7ULgtFK68w</tool-use-id>
<output-file>C:/Temp/claude/x/tasks/b1i328ewu.output</output-file>
<status>completed</status>
<summary>Background command "Wait for post-fix LCD test result" completed (exit code 0)</summary>
</task-notification>`;

  const killed = `<task-notification>
<task-id>b4lq9y6zq</task-id>
<tool-use-id>toolu_0187H9iorRy1KQB29RVTiqrj</tool-use-id>
<output-file>C:/Temp/claude/x/tasks/b4lq9y6zq.output</output-file>
<status>killed</status>
<summary>Background command "Re-run DB probe" was stopped</summary>
</task-notification>`;

  test("it is recognised as the CLI talking, not as anything you typed", () => {
    /* The whole reason this exists: read as speech, both folds pushed this
       block as a `you` line and opened a turn on it. */
    expect(isTaskNotification(done)).toBe(true);
    expect(isTaskNotification(killed)).toBe(true);
    expect(isTaskNotification("run the tests again please")).toBe(false);
    /* Prose that merely mentions one is still prose. */
    expect(isTaskNotification("what does <task-notification> mean?")).toBe(false);
  });

  test("a completed job carries the sentence worth drawing", () => {
    const n = parseTaskNotification(done)!;
    expect(n.toolId).toBe("toolu_01DAtQaKTV5KhC7ULgtFK68w");
    expect(n.taskId).toBe("b1i328ewu");
    expect(n.end).toBe("done");
    expect(n.summary).toBe(
      'Background command "Wait for post-fix LCD test result" completed (exit code 0)',
    );
  });

  test("a job stopped on purpose is not a job that failed", () => {
    expect(parseTaskNotification(killed)!.end).toBe("killed");
  });

  test("completed with a non-zero exit code is a failure", () => {
    /* The exit code rides in the summary rather than in a field of its own, and
       a background test run that came back red must not read as done. */
    const red = done.replace("(exit code 0)", "(exit code 1)");
    expect(parseTaskNotification(red)!.end).toBe("failed");
  });

  test("anything that is not one parses to nothing", () => {
    expect(parseTaskNotification("just a prompt")).toBeNull();
    expect(parseTaskNotification("")).toBeNull();
  });
});

describe("the plan", () => {
  test("a created item's number is what every later update names", () => {
    expect(
      taskNumberOf(
        "Task #1 created successfully: Prove the HTTP client reaches AzDO through Netskope",
      ),
    ).toBe("1");
    expect(taskNumberOf("Task #12 created successfully: x")).toBe("12");
    expect(taskNumberOf("Updated task #1 status")).toBeNull();
    expect(taskNumberOf("No tasks found")).toBeNull();
  });

  test("the live vocabulary reaches the activity line", () => {
    /* `TodoWrite` has never once been emitted here; these are what arrive, and
       they fell through to `default` and printed their own bare tool names. */
    expect(
      describeTool("TaskCreate", { activeForm: "Proving TLS and the auth ladder" }),
    ).toBe("Proving TLS and the auth ladder");
    expect(describeTool("TaskUpdate", { taskId: "1", status: "in_progress" })).toBe(
      "planning",
    );
    expect(describeTool("TaskList", {})).toBe("checking the plan");
    expect(describeTool("TaskStop", { task_id: "b6ea0g7u5" })).toBe("stopping a job");
    expect(describeTool("TaskOutput", { task_id: "b4lq9y6zq" })).toBe(
      "checking on a job",
    );
  });

  test("a subagent is delegation under either name", () => {
    expect(
      describeTool("Agent", { subagent_type: "Explore", description: "Find 3D view axis labels" }),
    ).toBe("delegating: Find 3D view axis labels");
    expect(describeTool("Task", { description: "Find 3D view axis labels" })).toBe(
      "delegating: Find 3D view axis labels",
    );
  });
});

describe("a compaction, which reports itself twice and progresses never", () => {
  /* The boundary is spelled snake_case on the wire and camelCase in the session
     file — the same split `system/init` and an `assistant` message make of a
     model id — and both folds read it through here so they cannot drift. */
  test("both spellings of the boundary read the same", () => {
    const wire = compactStat({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 339_871,
        post_tokens: 10_723,
        duration_ms: 187_669,
      },
    });
    const file = compactStat({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: {
        trigger: "manual",
        preTokens: 339_871,
        postTokens: 10_723,
        durationMs: 187_669,
      },
    });
    expect(wire).toEqual({ pre: 339_871, post: 10_723, ms: 187_669, trigger: "manual" });
    expect(file).toEqual(wire!);
  });

  test("anything that is not a boundary is not one", () => {
    expect(compactStat({ type: "system", subtype: "status", status: "compacting" })).toBe(
      null,
    );
    expect(compactStat(undefined)).toBe(null);
  });

  test("an older producer reporting no post_tokens degrades rather than NaNs", () => {
    const stat = compactStat({ compact_metadata: { trigger: "auto", pre_tokens: 190_000 } })!;
    expect(stat.post).toBe(0);
    expect(compactNote(stat)).toBe("context compacted · 190k → ?");
  });

  test("the caption is the two counts, and the wait when one was reported", () => {
    expect(
      compactNote({ pre: 339_871, post: 10_723, ms: 187_669, trigger: "manual" }),
    ).toBe("context compacted · 340k → 11k · 3m 8s");
    /* Sub-second folds do not get a duration: "· 0s" is noise about a wait
       nobody sat through. */
    expect(compactNote({ pre: 190_000, post: 9_000, ms: 40, trigger: "auto" })).toBe(
      "context compacted · 190k → 9k",
    );
  });

  test("a duration is said the way somebody would say it", () => {
    expect(spanOf(0)).toBe("0s");
    expect(spanOf(47)).toBe("47s");
    expect(spanOf(120)).toBe("2m");
    expect(spanOf(188)).toBe("3m 8s");
    expect(spanOf(3600)).toBe("1h");
    expect(spanOf(3840)).toBe("1h 4m");
    expect(spanOf(-5)).toBe("0s");
  });

  /* The wire's copy of the summary carries no `isCompactSummary` — only
     `isSynthetic`, which is equally true of every note the CLI injects — so
     live it is recognised by the one fixed sentence it opens with. Drawn as a
     prompt it is twenty thousand characters you appear to have typed. */
  test("the summary is known by its preamble, on the wire and on disk", () => {
    expect(
      isCompactSummary(
        "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request…",
      ),
    ).toBe(true);
    expect(
      isCompactSummary("  this session is being continued from a previous conversation…"),
    ).toBe(true);
  });

  test("talking about a compaction is not being one", () => {
    expect(isCompactSummary("compact this session for me")).toBe(false);
    expect(
      isCompactSummary("the summary says this session is being continued from a previous run"),
    ).toBe(false);
    expect(isCompactSummary("")).toBe(false);
  });

  /* A skill is injected rather than returned: the whole file arrives as a
     `user` message, carrying `isSynthetic` on the wire and `isMeta` on disk.
     Neither field is on both, so the text is what both paths ask. Probed
     2026-08-18 against claude 2.1.232 with `tools/probe-skill.ts`, which is
     where these strings come from. */
  test("a skill body is known by the line the CLI injects above it", () => {
    expect(
      skillBody(
        "Base directory for this skill: C:\\Users\\lyss.delprat\\.claude\\skills\\design-review\n\n# Collaborative Design Review",
      ),
    ).toEqual({ name: "design-review" });
    /* The bundled ones sit under a hashed temp directory and are named by the
       same last segment. */
    expect(
      skillBody(
        "Base directory for this skill: C:\\Users\\LYSS~1.DEL\\AppData\\Local\\Temp\\claude\\bundled-skills\\2.1.232\\e8fe\\claude-api\n\n# Building…",
      ),
    ).toEqual({ name: "claude-api" });
    /* Posix too, since nothing about the shape is Windows'. */
    expect(
      skillBody("Base directory for this skill: /home/x/.claude/skills/run\n\n# Run"),
    ).toEqual({ name: "run" });
  });

  test("a trailing separator is not the skill's name", () => {
    expect(skillBody("Base directory for this skill: /a/b/commit/\n\n# Commit")).toEqual({
      name: "commit",
    });
  });

  test("it folds even when there is no name to put on the cap", () => {
    /* The size is what makes the fold necessary; the name only captions it. */
    expect(skillBody("Base directory for this skill: \n\n# Something")).toEqual({ name: "" });
  });

  test("a skill quoted in an answer is prose", () => {
    /* Anchored to the start, like every other injected shape here — otherwise
       an agent explaining how skills work folds its own paragraph away. */
    expect(
      skillBody("It prints: Base directory for this skill: /a/b/run — and then the file."),
    ).toBeNull();
    expect(skillBody("read the design-review skill")).toBeNull();
    expect(skillBody("")).toBeNull();
  });
});

describe("wasMalformedRequest", () => {
  /* The message this was written from, verbatim. */
  const real =
    "API Error: 400 The request body is not valid JSON: unexpected end of data: line 1 column 429454 (char 429453)";
  const failed = (over: any) => ({ is_error: true, ...over });

  test("the truncated body, wherever the CLI puts it", () => {
    expect(wasMalformedRequest(failed({ result: real }))).toBe(true);
    expect(wasMalformedRequest({ api_error_status: real })).toBe(true);
    expect(wasMalformedRequest(failed({ error: real }))).toBe(true);
  });

  test("even split across two fields, since they are read together", () => {
    expect(
      wasMalformedRequest({ api_error_status: "400", result: "the request body is not valid JSON" }),
    ).toBe(true);
  });

  test("a numeric status is still a status", () => {
    expect(
      wasMalformedRequest({ api_error_status: 400, result: "unexpected end of data" }),
    ).toBe(true);
  });

  test("a 400 about the content of the request is not this", () => {
    /* Deterministic — retrying one is a loop that ends when the allowance
       does. This is the assertion that keeps the detector narrow. */
    expect(wasMalformedRequest(failed({ result: "API Error: 400 max_tokens: 200000 > 64000" }))).toBe(
      false,
    );
    expect(wasMalformedRequest(failed({ result: "API Error: 400 model not found" }))).toBe(false);
  });

  test("and neither is a truncation reported under another status", () => {
    expect(wasMalformedRequest(failed({ result: "API Error: 500 unexpected end of data" }))).toBe(
      false,
    );
  });

  test("a clean turn is not an error at all", () => {
    expect(wasMalformedRequest({ subtype: "success", is_error: false })).toBe(false);
    expect(wasMalformedRequest({})).toBe(false);
    expect(wasMalformedRequest(null)).toBe(false);
  });

  /* The gate `faultText` exists for. `result.result` on a turn that *succeeded*
     is the agent's own last message, and in this repository an agent discussing
     this very feature is an ordinary afternoon. */
  test("an answer *about* a truncation is not a truncation", () => {
    const talking = {
      subtype: "success",
      is_error: false,
      result: "the API answered 400 — the request body is not valid JSON, so skein retries it",
    };
    expect(wasMalformedRequest(talking)).toBe(false);
  });
});

describe("wasOverloaded", () => {
  const failed = (over: any) => ({ is_error: true, ...over });

  test("the status, the word, or both", () => {
    expect(wasOverloaded(failed({ result: "API Error: 529 Overloaded" }))).toBe(true);
    expect(wasOverloaded({ api_error_status: 529 })).toBe(true);
    expect(wasOverloaded(failed({ error: "overloaded_error" }))).toBe(true);
  });

  test("a rate limit is not weather and is deliberately excluded", () => {
    /* It is the account's own allowance, the horizon already reports it, and it
       clears at a time that is known rather than guessed at. */
    expect(wasOverloaded(failed({ api_error_status: 429, result: "rate_limit_error" }))).toBe(false);
  });

  test("nor is any other failure", () => {
    expect(wasOverloaded(failed({ result: "API Error: 500 internal" }))).toBe(false);
    expect(wasOverloaded({})).toBe(false);
    expect(wasOverloaded(null)).toBe(false);
  });

  test("an answer mentioning an overload is not one", () => {
    expect(
      wasOverloaded({ subtype: "success", is_error: false, result: "529 means overloaded" }),
    ).toBe(false);
  });
});

describe("wasRateLimited", () => {
  const failed = (over: any) => ({ is_error: true, ...over });

  /* Not a documented shape — the sentences that actually arrived, taken off
     this machine's own transcripts. 38 refusals across eight sessions between
     2026-08-11 and 2026-08-21, every one of them with `apiErrorStatus: 429`,
     and not one of them matched by the predicate written from the API docs. So
     the reactive half of the account waterfall had never fired: the card broke,
     said nothing about an account, and refused every prompt after it in under a
     second. These are the regression tests for that. */
  test("the CLI's own composed refusal, which is what actually arrives", () => {
    const refusal = (said: string) => failed({ api_error_status: 429, result: said });
    expect(
      wasRateLimited(refusal("You've hit your session limit · resets 9:10pm (Australia/Sydney)")),
    ).toBe(true);
    expect(
      wasRateLimited(
        refusal("You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)"),
      ),
    ).toBe(true);
  });

  /* The window name is a list that grows with every plan tier — the same bundle
     names six of them and three more sit beside the table. Matching at `hit
     your` instead is what stops this going quiet again the next time one is
     added, which is precisely how it went quiet the first time. */
  test("every window the CLI can name, and the ones it cannot name yet", () => {
    const refusal = (window: string) =>
      failed({ api_error_status: 429, result: `You've hit your ${window} · resets in 2h` });
    for (const window of [
      "session limit",
      "weekly limit",
      "Opus limit",
      "Sonnet limit",
      "Fable 5 limit",
      "usage credit limit",
      "individual usage limit",
      "individual spend limit",
      "monthly spend limit",
      "some limit tier nobody has shipped yet",
    ]) {
      expect(wasRateLimited(refusal(window))).toBe(true);
    }
  });

  test("and the suffix a refusal mid-turn carries", () => {
    expect(
      wasRateLimited(
        failed({
          api_error_status: 429,
          result: "You've hit your session limit · resets 9:10pm (Australia/Sydney) · progress saved",
        }),
      ),
    ).toBe(true);
  });

  test("the credit wordings beside them", () => {
    expect(
      wasRateLimited(failed({ api_error_status: 429, result: "You've reached your Fable 5 limit." })),
    ).toBe(true);
    expect(
      wasRateLimited(
        failed({ api_error_status: 429, result: "You're out of usage credits. /model to switch models." }),
      ),
    ).toBe(true);
  });

  /* An allowance getting low is not an allowance gone, and these two are the
     bundle's own warning strings for it. A card that changed subscription on a
     warning would leave the reserve for nothing. */
  test("a warning that the allowance is running low is not a refusal", () => {
    expect(
      wasRateLimited(failed({ api_error_status: 429, result: "You've used 90% of your weekly limit" })),
    ).toBe(false);
    expect(
      wasRateLimited(
        failed({ api_error_status: 429, result: "You're close to your session limit" }),
      ),
    ).toBe(false);
  });

  test("the status with the wording, in the shapes the API sends", () => {
    expect(wasRateLimited(failed({ api_error_status: 429, result: "rate_limit_error" }))).toBe(true);
    expect(wasRateLimited(failed({ result: "API Error: 429 usage limit reached" }))).toBe(true);
    expect(wasRateLimited(failed({ error: "rate_limit_error" }))).toBe(true);
    /* The CLI's own code for it, which is `rate_limit` and not the API's
       `rate_limit_error` — the gate used to ask for the longer of the two. */
    expect(wasRateLimited(failed({ error: "rate_limit" }))).toBe(true);
  });

  /* The load-bearing one. A bare 429 out of some tool the agent ran must not
     move the card onto the subscription being kept in reserve. */
  test("a bare 429 with no limit wording is not one", () => {
    expect(wasRateLimited(failed({ result: "the deploy endpoint answered 429" }))).toBe(false);
    expect(wasRateLimited({ api_error_status: 429 })).toBe(false);
  });

  /* And the other half of the same guard: the refusal's own sentence, quoted by
     an agent that was reading this very file, in a turn that failed some other
     way. Two signals, so it takes a 429 of its own to count. */
  test("the refusal quoted without a 429 is not one", () => {
    expect(
      wasRateLimited(failed({ result: "the docs say it prints You've hit your weekly limit" })),
    ).toBe(false);
  });

  test("an answer talking about a rate limit is not one", () => {
    expect(
      wasRateLimited({
        subtype: "success",
        is_error: false,
        result: "a 429 means you hit the usage limit",
      }),
    ).toBe(false);
  });

  /* Bedrock and Vertex say quota, have no OAuth windows, and have no second
     account to fall to — swapping there is a card thrashing between spawns. */
  test("a quota is not a rate limit", () => {
    expect(wasRateLimited(failed({ result: "429 quota exceeded for this project" }))).toBe(false);
  });

  test("nor is anything else", () => {
    expect(wasRateLimited(failed({ result: "529 overloaded" }))).toBe(false);
    expect(wasRateLimited({})).toBe(false);
    expect(wasRateLimited(null)).toBe(false);
  });
});

describe("healKindOf", () => {
  test("names which of the three, and nothing else", () => {
    expect(healKindOf({ is_error: true, result: "400 not valid json" })).toBe("malformed");
    expect(healKindOf({ is_error: true, result: "529 overloaded" })).toBe("overloaded");
    expect(healKindOf({ is_error: true, result: "429 usage limit reached" })).toBe("limited");
    /* The refusal as it really arrives, all the way through the ladder — this
       is what the account swap is waiting on. */
    expect(
      healKindOf({
        is_error: true,
        api_error_status: 429,
        result: "You've hit your weekly limit · resets Aug 23, 3pm (Australia/Sydney)",
      }),
    ).toBe("limited");
    expect(healKindOf({ is_error: true, result: "500 internal error" })).toBeNull();
    expect(healKindOf({ subtype: "success" })).toBeNull();
  });

  /* Rate limiting wins the tie. Waiting out the overload ladder — five minutes,
     four times — with an idle account sitting there is the worst of both. */
  test("a 429 that also says overloaded is read as the rate limit", () => {
    expect(
      healKindOf({ is_error: true, result: "429 rate_limit_error — overloaded" }),
    ).toBe("limited");
  });
});

describe("the heal budgets", () => {
  test("a truncation survives the failure it was written for — two, then through", () => {
    expect(HEAL_BUDGET.malformed).toBeGreaterThanOrEqual(2);
  });

  test("an overload is given longer, being a queue somewhere else draining", () => {
    expect(HEAL_BUDGET.overloaded).toBeGreaterThan(HEAL_BUDGET.malformed);
  });

  test("but both are bounded — every attempt is a whole conversation", () => {
    expect(HEAL_BUDGET.malformed).toBeLessThanOrEqual(3);
    expect(HEAL_BUDGET.overloaded).toBeLessThanOrEqual(5);
  });
});

describe("healDelayMs", () => {
  test("a truncation waits long enough to read the note, then backs off", () => {
    expect(healDelayMs("malformed", 1)).toBeGreaterThanOrEqual(1_000);
    expect(healDelayMs("malformed", 2)).toBeGreaterThan(healDelayMs("malformed", 1));
  });

  test("an overload starts well back, since the CLI has already been retrying", () => {
    /* By the time a 529 reaches a `result` the binary has spent its own
       internal backoff on it. A card asking again a second later is asking a
       question that was just asked several times. */
    expect(healDelayMs("overloaded", 1)).toBeGreaterThanOrEqual(10_000);
  });

  test("and climbs every rung", () => {
    const rungs = [1, 2, 3, 4].map((n) => healDelayMs("overloaded", n));
    for (let i = 1; i < rungs.length; i++) expect(rungs[i]).toBeGreaterThan(rungs[i - 1]!);
  });

  test("the ladder is bounded past its last rung rather than reading off the end", () => {
    expect(healDelayMs("overloaded", 99)).toBe(healDelayMs("overloaded", 4));
    expect(Number.isFinite(healDelayMs("overloaded", 99))).toBe(true);
  });

  test("jitter spreads a herd forward, never backward", () => {
    /* Twenty cards fail on the same weather at the same instant. Waiting the
       same 15s and re-sending together is a stampede at a service that has
       just said it is over capacity. */
    const flat = healDelayMs("overloaded", 1, 0);
    const most = healDelayMs("overloaded", 1, 1);
    expect(most).toBeGreaterThan(flat);
    expect(most).toBeLessThanOrEqual(flat * 1.5);
    expect(healDelayMs("overloaded", 1, 0.5)).toBeGreaterThanOrEqual(flat);
  });

  test("a jitter out of range cannot stretch or invert the wait", () => {
    expect(healDelayMs("overloaded", 1, 9)).toBe(healDelayMs("overloaded", 1, 1));
    expect(healDelayMs("overloaded", 1, -9)).toBe(healDelayMs("overloaded", 1, 0));
  });

  test("a truncation is not jittered — one card's transport, no herd", () => {
    expect(healDelayMs("malformed", 1, 1)).toBe(healDelayMs("malformed", 1, 0));
  });
});

describe("saySoon", () => {
  test("seconds under a minute, whole minutes above", () => {
    expect(saySoon(15_000)).toBe("15s");
    expect(saySoon(45_000)).toBe("45s");
    expect(saySoon(120_000)).toBe("2m");
    expect(saySoon(300_000)).toBe("5m");
  });
});

describe("healNote", () => {
  test("says which failure, which attempt, and how long it will be quiet", () => {
    const note = healNote("overloaded", 2, 45_000);
    expect(note).toContain("overloaded");
    expect(note).toContain("45s");
    expect(note).toContain(`2 of ${HEAL_BUDGET.overloaded}`);
  });

  test("and the two read as different events", () => {
    expect(healNote("malformed", 1, 1_000)).not.toBe(healNote("overloaded", 1, 1_000));
  });

  test("it is lowercase, like the rest of the wall's prose", () => {
    const note = healNote("malformed", 1, 1_000);
    expect(note).toBe(note.toLowerCase());
  });
});

describe("a job that reported in and woke nobody", () => {
  test("the grace is long enough to be latency and short enough to be news", () => {
    /* A turn that is going to open opens one model round trip behind the
       notification. Accusing a card sooner than that would mostly be accusing
       cards that were already answering. */
    expect(WAKE_GRACE_S).toBeGreaterThanOrEqual(5);
    expect(WAKE_GRACE_S).toBeLessThan(CLEAN_WARM_S);
  });

  test("the nudge budget is bounded — every nudge is a real turn", () => {
    expect(NUDGE_BUDGET).toBeGreaterThanOrEqual(1);
    expect(NUDGE_BUDGET).toBeLessThanOrEqual(3);
  });

  test("what skein sends is nearly empty, because sending anything is the point", () => {
    /* The notification is still in the CLI's queue; any prompt flushes it, and
       the agent then reads the CLI's own complete report rather than Skein's
       paraphrase of a summary line. A long prompt here would be Skein guessing
       at work it never saw. */
    expect(NUDGE_TEXT.length).toBeLessThan(80);
    expect(NUDGE_TEXT).toBe(NUDGE_TEXT.toLowerCase());
  });

  test("the card's own account counts them, and says it in words", () => {
    expect(unwokenNote(1)).toContain("a job");
    expect(unwokenNote(3)).toContain("3 jobs");
    expect(unwokenNote(1)).not.toBe(unwokenNote(2));
  });

  test("a nudge names which attempt it is, out of how many", () => {
    const note = nudgeNote(1);
    expect(note).toContain(`1 of ${NUDGE_BUDGET}`);
    expect(nudgeNote(2)).toContain(`2 of ${NUDGE_BUDGET}`);
  });

  test("giving up says what to do about it, not merely that it happened", () => {
    expect(nudgeGaveUpNote()).toContain("send it something");
  });

  test("all of it is lowercase, like the rest of the wall's prose", () => {
    for (const s of [unwokenNote(1), unwokenNote(2), nudgeNote(1), nudgeGaveUpNote()]) {
      expect(s).toBe(s.toLowerCase());
    }
  });
});

/* The other silence, reached from your end rather than the CLI's: a prompt
   written to the child's stdin that the wire never echoed back. Same queue,
   same flush, and deliberately different words — a job the agent has not acted
   on and words of yours it has never seen are not the same news. */
describe("a prompt the card never picked up", () => {
  test("what skein sends is nearly empty, for one more reason than the job case", () => {
    /* What flushes the queue is any message at all, and the thing behind it in
       that queue is your own words — so anything informative here would be
       Skein paraphrasing a prompt the agent is about to read for itself. */
    expect(NUDGE_PROMPT_TEXT.length).toBeLessThan(80);
    expect(NUDGE_PROMPT_TEXT).toBe(NUDGE_PROMPT_TEXT.toLowerCase());
  });

  test("it hedges, because the queue may have drained since the check", () => {
    /* Twelve seconds pass between the card being seen to owe an echo and the
       nudge going out, and the CLI usually drains its queue inside three. An
       agent told flatly that a message exists would go looking for one that
       does not. */
    expect(NUDGE_PROMPT_TEXT).toContain("if ");
  });

  test("the two silences are worded apart", () => {
    expect(NUDGE_PROMPT_TEXT).not.toBe(NUDGE_TEXT);
    expect(nudgeNote(1, "prompt")).not.toBe(nudgeNote(1, "job"));
    expect(nudgeGaveUpNote("prompt")).not.toBe(nudgeGaveUpNote("job"));
  });

  test("a prompt nudge still names which attempt it is, out of how many", () => {
    expect(nudgeNote(1, "prompt")).toContain(`1 of ${NUDGE_BUDGET}`);
    expect(nudgeNote(2, "prompt")).toContain(`2 of ${NUDGE_BUDGET}`);
  });

  test("giving up on a prompt says what to do about it", () => {
    /* "send it something" is the job answer and is wrong here — the card has
       been sent something, twice. */
    expect(nudgeGaveUpNote("prompt")).toContain("send it again");
  });

  test("a held prompt says why, and is not the same state as an unsent one", () => {
    /* Held is Skein keeping a prompt against an allowance reset — it will go on
       its own. Unacknowledged is a prompt that left and was never taken up.
       Nothing you do moves the first; the second is asking for a gesture. */
    expect(HOLD_LINE).toBe(HOLD_LINE.toLowerCase());
    expect(HOLD_LINE).not.toBe(UNACKNOWLEDGED_LINE);
  });

  test("the face says sent rather than delivered, which is all skein knows", () => {
    /* The prompt reached the child's stdin; whether the CLI is holding it in a
       queue or lost it is not a question this side can answer. */
    expect(UNACKNOWLEDGED_LINE).toContain("sent");
    expect(UNACKNOWLEDGED_LINE).not.toContain("deliver");
  });

  test("all of it is lowercase, like the rest of the wall's prose", () => {
    for (const s of [
      NUDGE_PROMPT_TEXT,
      UNACKNOWLEDGED_LINE,
      nudgeNote(1, "prompt"),
      nudgeGaveUpNote("prompt"),
    ]) {
      expect(s).toBe(s.toLowerCase());
    }
  });
});

/* ── a workflow ────────────────────────────────────────────────────────────
 *
 * Verbatim from the seven `Workflow` calls on this machine, read 2026-08-21.
 * A workflow is the largest thing a card can start — one script, a dozen
 * subagents, a quarter of an hour — and the whole of what the wire says about
 * it is the call and a receipt. Get either wrong and the card reads `at rest`
 * for the duration, which is the bug this was found as. */
describe("a workflow says what it is in its own script", () => {
  const SCRIPT = `export const meta = {
  name: 'caravan-test-audit',
  description: 'Audit all 97 Caravan test files for assertions that cannot fail, then adversarially verify each finding',
  phases: [
    { title: 'Audit', detail: 'one agent per subsystem cluster' },
    { title: 'Verify', detail: 'independent skeptic per cluster' },
  ],
}

const CLUSTERS = ['rail', 'slide']
const results = await pipeline(CLUSTERS, c => agent(\`audit \${c}\`))
return { results }
`;

  test("the name, the sentence and the phases in order", () => {
    expect(workflowMeta(SCRIPT)).toEqual({
      name: "caravan-test-audit",
      description:
        "Audit all 97 Caravan test files for assertions that cannot fail, then adversarially verify each finding",
      phases: ["Audit", "Verify"],
    });
  });

  /* The block is bounded by counting braces, so what follows it cannot reach
     in. The prompts below a `meta` are prose a model wrote for other agents,
     and one of them saying `name: "…"` would otherwise rename the run. */
  test("nothing below the block can rename the run", () => {
    const meta = workflowMeta(
      `export const meta = { name: 'real-name', description: 'the real one' }\n` +
        `const PROMPT = "Return JSON with { name: 'fake', description: 'also fake' }"\n` +
        `phases: [{ title: 'Phantom' }]\n`,
    );
    expect(meta?.name).toBe("real-name");
    expect(meta?.description).toBe("the real one");
    expect(meta?.phases).toEqual([]);
  });

  /* A `detail` carrying a brace of its own — a template hole, or a JSON shape
     quoted in prose — must not end the block early or run it to the end of the
     file. Both were live: the scripts measured here are full of both. */
  test("a brace inside a string is not a brace", () => {
    const meta = workflowMeta(
      "export const meta = {\n" +
        "  name: 'braces',\n" +
        '  description: "returns { ok: true } per item",\n' +
        "  phases: [{ title: 'One', detail: 'writes {\"a\":1} to disk' }],\n" +
        "}\nconst rest = 1\n",
    );
    expect(meta).toEqual({
      name: "braces",
      description: "returns { ok: true } per item",
      phases: ["One"],
    });
  });

  test("an apostrophe does not end the string it is inside", () => {
    const meta = workflowMeta(
      "export const meta = {\n" +
        "  name: 'refute',\n" +
        "  phases: [{ title: 'Refute', detail: 'each dimension\\u2019s findings attacked' }],\n" +
        "}\n",
    );
    expect(meta?.phases).toEqual(["Refute"]);
    /* An escaped quote, which is the other shape that arrives. */
    expect(
      workflowMeta("export const meta = { name: 'the wall\\'s own', phases: [] }")?.name,
    ).toBe("the wall's own");
  });

  test("phases are optional, and a script with no meta says nothing", () => {
    expect(workflowMeta("export const meta = { name: 'one-shot' }")).toEqual({
      name: "one-shot",
      description: "",
      phases: [],
    });
    expect(workflowMeta("const x = 1\nawait agent('go')")).toBeNull();
    expect(workflowMeta(undefined)).toBeNull();
    expect(workflowMeta(42)).toBeNull();
    /* Truncated mid-block — `capInput` clips a call at 20k and a script can be
       longer than that. Nothing to read is nothing said, not a crash. */
    expect(workflowMeta("export const meta = {\n  name: 'cut off")).toBeNull();
  });

  /* Two of the seven calls carried `scriptPath` and no script at all: that is
     the re-invoke-after-editing path, and the file's own name is all there is
     to go on. The runtime stamps a persisted script with the run id it was
     first launched under, which is fifteen characters of noise on a card. */
  test("a name is found for every shape of call", () => {
    expect(workflowName({ script: SCRIPT })).toBe("caravan-test-audit");
    expect(workflowName({ name: "find-flaky-tests" })).toBe("find-flaky-tests");
    expect(
      workflowName({
        scriptPath:
          "C:\\Users\\flori\\.claude\\projects\\C--atelier-skein\\sess\\workflows\\scripts\\caravan-pass3-wf_9157cd8c-f79.js",
      }),
    ).toBe("caravan-pass3");
    expect(
      workflowName({ scriptPath: "/home/x/scripts/caravan-test-audit-wave2.js" }),
    ).toBe("caravan-test-audit-wave2");
    /* The script wins over the path: it is the run that is about to happen,
       where the filename is where it was last saved. */
    expect(workflowName({ script: SCRIPT, scriptPath: "/x/stale.js" })).toBe(
      "caravan-test-audit",
    );
    expect(workflowName({})).toBeNull();
  });

  test("the card names the workflow rather than printing the tool", () => {
    expect(describeTool("Workflow", { script: SCRIPT })).toBe(
      "workflow: caravan-test-audit",
    );
    /* Arguments stream in after the block opens, so every case has to survive
       an empty input — this one drew the bare word `Workflow` before. */
    expect(describeTool("Workflow", {})).toBe("running a workflow");
    expect(describeTool("Workflow", undefined)).toBe("running a workflow");
  });

  /* It has no inline arm at all: the tool returns a task id and a promise of a
     notification, always. This is the whole of the "it looks like nothing is
     happening" bug — no kind meant no job, and no job meant a card at rest
     with fifteen agents running under it. */
  test("a workflow is always background work", () => {
    expect(backgroundKind("Workflow", { script: SCRIPT })).toBe("workflow");
    expect(backgroundKind("Workflow", {})).toBe("workflow");
    expect(backgroundKind("Workflow", { run_in_background: false })).toBe("workflow");
  });

  test("the label is the workflow's own sentence, wherever it lives", () => {
    /* `description` is documented as ignored by the runtime, and it is still
       the model's words about the call, so it leads where it exists. */
    expect(
      jobLabel("Workflow", { script: SCRIPT, description: "Wave 1: four clusters" }),
    ).toBe("Wave 1: four clusters");
    /* Two of seven carried none, and this is where "a job" came from. */
    expect(jobLabel("Workflow", { script: SCRIPT })).toBe(
      "Audit all 97 Caravan test files for ass…",
    );
    expect(jobLabel("Workflow", { name: "find-flaky-tests" })).toBe("find-flaky-tests");
    expect(jobLabel("Workflow", {})).toBe("a workflow");
  });

  test("the fourth receipt, verbatim", () => {
    const r = startedJob(
      "Workflow launched in background. Task ID: wxx8uibpu\nSummary: Audit all 97 Caravan test files for assertions that cannot fail, then adversarially verify each finding\nTranscript dir: C:\\Users\\flori\\.claude\\projects\\C--atelier-skein\\sess\\subagents\\workflows\\wf_4dfe23e8-0e6\nRun ID: wf_4dfe23e8-0e6\n\nYou will be notified when it completes. Use /workflows to watch live progress.",
    );
    /* Nine characters, the same shape a `Bash` job's id is — and the same value
       the notification quotes back as `<task-id>`, which is what settles the
       job and closes the seat. `Run ID` is a different id and must not be it:
       it names the run's directory, not the task. */
    expect(r.started).toBe(true);
    expect(r.taskId).toBe("wxx8uibpu");
    /* No output path is named. The notification's own `<output-file>` shows the
       CLI files it under `tasks\\<id>.output` like every other kind, so Rust
       derives it from the session and this id with nothing added. */
    expect(r.outputPath).toBeNull();
    /* The run's own directory, absolute and taken rather than derived — the
       journal inside it is the only thing on this machine that says how far a
       workflow has got, and re-deriving the path would mean re-performing the
       lossy directory slug to arrive where the receipt already points. Stopped
       at the end of the line: three more labelled paths follow it. */
    expect(r.journalDir).toBe(
      "C:\\Users\\flori\\.claude\\projects\\C--atelier-skein\\sess\\subagents\\workflows\\wf_4dfe23e8-0e6",
    );
  });

  test("a workflow's completion is read like any other job's", () => {
    const note = parseTaskNotification(
      '<task-notification>\n<task-id>wxx8uibpu</task-id>\n<tool-use-id>toolu_016B2Eb</tool-use-id>\n<output-file>C:\\Temp\\claude\\slug\\sess\\tasks\\wxx8uibpu.output</output-file>\n<status>completed</status>\n<summary>Dynamic workflow "Audit all 97 Caravan test files" completed</summary>\n<result>{"confirmed":[]}</result>\n</task-notification>',
    );
    expect(note?.taskId).toBe("wxx8uibpu");
    expect(note?.toolId).toBe("toolu_016B2Eb");
    expect(note?.end).toBe("done");
    expect(note?.summary).toBe(
      'Dynamic workflow "Audit all 97 Caravan test files" completed',
    );
  });
});
