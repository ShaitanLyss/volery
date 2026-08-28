import { expect, test, describe } from "bun:test";
import { HISTORY_MAX_LINES, foldTranscript, trimOverlap } from "../src/lib/history";
import { VALUE_CAP } from "../src/lib/toolcall";

/** One NDJSON record per argument, the way a transcript is written. */
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n");

const user = (text: unknown, extra: object = {}) => ({
  type: "user",
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (content: unknown[], extra: object = {}) => ({
  type: "assistant",
  message: { role: "assistant", content },
  ...extra,
});

describe("what a transcript says", () => {
  test("both prompt shapes are the same speech", () => {
    /* The TUI writes a bare string, the SDK writes a text block. 877 and 67
       records respectively on this machine — a reader that took only one shape
       would show every Skein card's half of the conversation and no CLI card's,
       or the reverse. */
    const h = foldTranscript(
      jsonl(user("typed in the terminal"), user([{ type: "text", text: "sent by skein" }])),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "typed in the terminal" },
      { kind: "you", text: "sent by skein" },
    ]);
  });

  test("an assistant turn folds to the same lines the live stream produces", () => {
    const h = foldTranscript(
      jsonl(
        assistant([
          { type: "thinking", thinking: "at length, and mostly" },
          { type: "text", text: "here is the answer" },
          { type: "tool_use", name: "Read", input: { file_path: "C:\\atelier\\skein\\src\\lib\\layout.ts" } },
        ]),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "text", text: "here is the answer" },
      {
        kind: "tool",
        text: "reading layout.ts",
        /* The call itself, not only its prose — the panel opens one to show
           what it was called with, and history has to carry the same thing the
           live fold does or a restart changes what a card can be asked. */
        call: {
          name: "Read",
          input: { file_path: "C:\\atelier\\skein\\src\\lib\\layout.ts" },
        },
      },
    ]);
  });

  test("tool results are not speech", () => {
    // 6680 of the 7624 `user` records here are tool results, not prompts.
    const h = foldTranscript(
      jsonl(user([{ type: "tool_result", tool_use_id: "t1", content: "1400 lines of output" }])),
    );
    expect(h.lines).toEqual([]);
  });

  test("the answer to a parked question is the one tool result that is", () => {
    /* It is the only thing a *person* said that arrives on the wire as a tool
       result. Dropped with the rest, a restored card showed the agent asking
       and then acting with the decision between them nowhere on the page. */
    const h = foldTranscript(
      jsonl(
        assistant([
          {
            type: "tool_use",
            id: "t7",
            name: "mcp__skein__ask_user",
            input: { question: "one widget or two?" },
          },
        ]),
        user([{ type: "tool_result", tool_use_id: "t7", content: [{ type: "text", text: "two" }] }]),
        assistant([{ type: "text", text: "two it is" }]),
      ),
    );
    expect(h.lines).toEqual([
      {
        kind: "tool",
        text: "asked you a question",
        call: {
          id: "t7",
          name: "mcp__skein__ask_user",
          input: { question: "one widget or two?" },
          /* The reply lands on the call as well as being drawn as your answer:
             the two readings are independent, and the raw result belongs on the
             line whatever `answerNote` makes of it. */
          result: { text: "two" },
        },
      },
      { kind: "answer", text: "two" },
      { kind: "text", text: "two it is" },
    ]);
  });

  test("a reply to some other call is still machinery", () => {
    /* A tool result carries no tool name, only the id of the call it answers —
       so the ask's own ids are what is matched, and nothing else. */
    const h = foldTranscript(
      jsonl(
        assistant([{ type: "tool_use", id: "t8", name: "Read", input: {} }]),
        user([{ type: "tool_result", tool_use_id: "t8", content: "1400 lines" }]),
      ),
    );
    expect(h.lines).toEqual([
      {
        kind: "tool",
        text: "reading a file",
        /* Still one line in the column — but the result is on the call now, so
           opening it shows the 1400 lines rather than only that there were
           some. */
        call: { id: "t8", name: "Read", input: {}, result: { text: "1400 lines" } },
      },
    ]);
  });

  test("a question nobody answered is Skein talking, not you", () => {
    const h = foldTranscript(
      jsonl(
        assistant([
          { type: "tool_use", id: "t9", name: "mcp__skein__ask_user", input: {} },
        ]),
        user([
          {
            type: "tool_result",
            tool_use_id: "t9",
            content: [
              {
                type: "text",
                text: "The user did not answer within ten minutes. Proceed using your best judgement, and say which way you went and why.",
              },
            ],
          },
        ]),
      ),
    );
    expect(h.lines[1]).toEqual({
      kind: "meta",
      text: "no answer sent — the agent went on with its own judgement",
    });
  });
});

describe("what a transcript carries that the wire never does", () => {
  test("a subagent's own turns stay inside their seat", () => {
    /* The live card collapses subagents into seats. Replaying their turns would
       render a card's history as mostly other agents talking. */
    const h = foldTranscript(
      jsonl(
        user("do the thing", { isSidechain: true }),
        assistant([{ type: "text", text: "subagent thinking out loud" }], { isSidechain: true }),
        assistant([{ type: "text", text: "the card's own answer" }]),
      ),
    );
    expect(h.lines).toEqual([{ kind: "text", text: "the card's own answer" }]);
  });

  test("injected context is not something anybody said", () => {
    const h = foldTranscript(
      jsonl(
        user("<local-command-caveat>Caveat: …</local-command-caveat>", { isMeta: true }),
        user("Continue from where you left off.", { isMeta: true }),
        user("what I actually asked"),
      ),
    );
    expect(h.lines).toEqual([{ kind: "you", text: "what I actually asked" }]);
  });

  test("a skill is the one injected thing worth reading", () => {
    /* On disk a skill's body carries `isMeta` like every other injection, so
       the drop above swallowed it and a restored card never showed which skills
       it had picked up. Live it fell through the other way and drew the whole
       file as a prompt you had typed. Both are the same fold now — and
       `skillBody` reads the text, since the two paths share no field to read. */
    const h = foldTranscript(
      jsonl(
        user("run the design review"),
        assistant([{ type: "tool_use", name: "Skill", input: { skill: "design-review" } }]),
        user(
          "Base directory for this skill: C:\\Users\\x\\.claude\\skills\\design-review\n\n# Collaborative Design Review",
          { isMeta: true },
        ),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "run the design review" },
      {
        kind: "tool",
        text: "running /design-review",
        call: { name: "Skill", input: { skill: "design-review" } },
      },
      {
        kind: "skill",
        text: "Base directory for this skill: C:\\Users\\x\\.claude\\skills\\design-review\n\n# Collaborative Design Review",
        note: "design-review",
      },
    ]);
  });

  test("a stop is a note, not a sentence you typed", () => {
    /* The CLI writes this as an ordinary `user` record with no `isMeta` on it,
       so nothing above sorts it out. Left alone it comes back after a restart
       as a prompt you appear to have sent — and reads differently from the same
       stop live, which draws a meta line. */
    const h = foldTranscript(
      jsonl(
        user("count to four hundred"),
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "1 — one" }] } },
        user([{ type: "text", text: "[Request interrupted by user]" }]),
        user("never mind, do this instead"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "count to four hundred" },
      { kind: "text", text: "1 — one" },
      { kind: "meta", text: "stopped" },
      { kind: "you", text: "never mind, do this instead" },
    ]);
  });

  test("an api refusal keeps its error register instead of the agent's voice", () => {
    /* The CLI wraps a refusal as an assistant message with `model:
       "<synthetic>"`, so drawn as `text` it is the agent apparently announcing
       its own rate limit. 268 of these on this machine, 170 of them 429s, which
       means every card that had ever hit a limit came back saying it.

       Live the message is dropped, because the `result` behind it carries the
       same sentence as the turn's error line. A session file has no `result`
       records at all, so dropping it here would lose the refusal entirely — the
       reading is what has to agree across a restart, not the record. Both sides
       say the CLI refused; neither says the agent spoke. */
    const refusal =
      "You've hit your session limit \u00b7 resets 2:40pm (Australia/Sydney) \u00b7 progress saved";
    const h = foldTranscript(
      jsonl(
        user("carry on with the migration"),
        {
          type: "assistant",
          isApiErrorMessage: true,
          apiErrorStatus: 429,
          message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: refusal }] },
        },
        user("swap to the other account"),
        {
          type: "assistant",
          message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "on it" }] },
        },
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "carry on with the migration" },
      { kind: "error", text: refusal },
      { kind: "you", text: "swap to the other account" },
      { kind: "text", text: "on it" },
    ]);
  });

  test("a screenshot comes back off disk as well as on the wire", () => {
    /* The seam this file exists for. A `Read` of a PNG carries the image inside
       the `tool_result` and no text beside it, so a fold that read results for
       prose alone drew the call as having answered with nothing — on both sides,
       but the fix has to land on both or the panel shows the picture only until
       you restart. `picturesOf` is shared with the live fold for the same reason
       `textOf` is. */
    const h = foldTranscript(
      jsonl(
        user("look at the capture"),
        assistant([
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "shot.png" } },
        ]),
        user([
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ]),
      ),
    );
    const call = h.lines.find((l) => l.kind === "tool")?.call;
    expect(call?.result?.pictures).toEqual([
      { url: "data:image/png;base64,aGVsbG8=", chars: 8 },
    ]);
    /* And the head stops calling it empty. */
    expect(call?.result?.text).toBe("");
  });

  test("an image-resize note is dropped, on both sides of a restart", () => {
    /* The one in this family whose bug was live-only. On disk it carries
       `isMeta`, so the block above `switch` had always dropped it; the live
       stream has no `isMeta` at all, so `conversation.svelte.ts` drew it as a
       sentence you had typed. The line was therefore in the transcript until
       the card was restored and then gone — the divergence this file exists to
       prevent, reported as "some stuff is showing in the transcript".

       Asserted twice over, with the flag and without it, because the predicate
       is what makes the two folds agree and the flag is what makes only one of
       them work. Verbatim from this machine's transcripts, 2026-08-28. */
    const note =
      "[Image: original 3200x2000, displayed at 2000x1250. Multiply coordinates by 1.60 to map to original image.]";
    const h = foldTranscript(
      jsonl(
        user("check the support captures"),
        user(note, { isMeta: true }),
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "cards view, still loading" }] } },
        /* No flag: some other client's transcript, or a build that stops
           setting it. The text alone has to be enough. */
        user(note),
        user("batch the fixes"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "check the support captures" },
      { kind: "text", text: "cards view, still loading" },
      { kind: "you", text: "batch the fixes" },
    ]);
  });

  test("a background job reporting in is the CLI talking, not you", () => {
    /* Same shape as the stop note above and the same hazard: a bare string on a
       `user` record with no `isMeta` to sort it out by. Read as speech it puts a
       block of XML into the transcript as words you appear to have typed, and
       it has to read the same here as it does live, or a restart changes what a
       card said. Verbatim from this machine's transcripts, 2026-08-14. */
    const summary =
      'Background command "Wait for LCD test results" completed (exit code 0)';
    const note = [
      "<task-notification>",
      "<task-id>b1i328ewu</task-id>",
      "<tool-use-id>toolu_01DAtQaKTV5KhC7ULgtFK68w</tool-use-id>",
      "<output-file>C:/Temp/claude/x/tasks/b1i328ewu.output</output-file>",
      "<status>completed</status>",
      `<summary>${summary}</summary>`,
      "</task-notification>",
    ].join("\n");
    const h = foldTranscript(
      jsonl(
        user("run the LCD tests in the background"),
        user(note),
        user("and now commit it"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "run the LCD tests in the background" },
      { kind: "meta", text: summary },
      { kind: "you", text: "and now commit it" },
    ]);
  });

  test("compaction is kept whole, captioned by the boundary above it", () => {
    // One line, not two: the boundary's numbers are the summary's cap, and the
    // summary is kept in full because it is what the card used to know.
    const h = foldTranscript(
      jsonl(
        {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: {
            trigger: "manual",
            preTokens: 624_414,
            postTokens: 11_500,
            durationMs: 187_669,
          },
        },
        user("This session is being continued from a previous conversation…", {
          isCompactSummary: true,
        }),
      ),
    );
    expect(h.lines).toEqual([
      {
        kind: "summary",
        text: "This session is being continued from a previous conversation…",
        note: "context compacted · 624k → 12k · 3m 8s",
      },
    ]);
  });

  test("a boundary whose summary never arrived still says so", () => {
    // The file ends on the fold. The discontinuity is real and has to be drawn
    // — this is the case the old meta line was always for.
    const h = foldTranscript(
      jsonl(
        user("carry on"),
        {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "auto", preTokens: 190_000, postTokens: 9_000 },
        },
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "carry on" },
      { kind: "meta", text: "context compacted · 190k → 9k" },
    ]);
  });

  test("a summary with no boundary is still a summary", () => {
    // A tail read that begins after the boundary record. The words are the
    // thing worth keeping; the numbers were only ever the label.
    const h = foldTranscript(
      jsonl(
        user("This session is being continued from a previous conversation…", {
          isCompactSummary: true,
        }),
      ),
    );
    expect(h.lines).toEqual([
      {
        kind: "summary",
        text: "This session is being continued from a previous conversation…",
      },
    ]);
  });

  test("bookkeeping records draw nothing", () => {
    // ai-title, last-prompt, mode, attachment and friends outnumber speech.
    const h = foldTranscript(
      jsonl(
        { type: "ai-title", aiTitle: "Fix the slug" },
        { type: "last-prompt", prompt: "…" },
        { type: "mode", mode: "default" },
        { type: "attachment", attachment: { content: "a wall of skill descriptions" } },
        { type: "file-history-snapshot", messageId: "x" },
        { type: "system", subtype: "turn_duration", durationMs: 4200 },
        { type: "queue-operation", operation: "enqueue" },
      ),
    );
    expect(h.lines).toEqual([]);
  });
});

describe("history read while the card is speaking", () => {
  const h = (kind: any, text: string) => ({ kind, text });

  test("the wire wins over the file for anything both carried", () => {
    /* Since reading now starts with the wall rather than with a click, a card
       woken immediately can have its new turn reach the transcript before the
       read does. */
    const history = [h("you", "older question"), h("text", "older answer"), h("you", "the new turn")];
    const live = [h("you", "the new turn"), h("text", "answering now")];
    expect(trimOverlap(history, live)).toEqual([
      h("you", "older question"),
      h("text", "older answer"),
    ]);
  });

  test("with nothing live, history is untouched", () => {
    const history = [h("you", "a"), h("text", "b")];
    expect(trimOverlap(history, [])).toEqual(history);
  });

  test("a live line the file never had leaves history whole", () => {
    const history = [h("you", "a")];
    expect(trimOverlap(history, [h("you", "something else")])).toEqual(history);
  });

  test("skein's own note is not the anchor — the prompt under it is", () => {
    /* A roused card's live column opens with the meta note rousing writes above
       the resume prompt. It is Skein talking, so it is in no transcript: anchor
       on it and nothing matches, and the file's copy of the prompt is kept
       directly above the live one. The read and the send genuinely race — the
       transcripts are still being filled in while the rousing queue works along
       the wall. */
    const history = [h("you", "carry on"), h("text", "half an answer")];
    const live = [h("meta", "resumed by skein"), h("you", "carry on")];
    expect(trimOverlap(history, live)).toEqual([]);
  });

  test("a repeated line cuts at the last one, not the first", () => {
    // "continue" gets typed a lot; cutting at the first would eat the session.
    const history = [h("you", "continue"), h("text", "ok"), h("you", "continue")];
    expect(trimOverlap(history, [h("you", "continue")])).toEqual([
      h("you", "continue"),
      h("text", "ok"),
    ]);
  });
});

describe("reading a file that is being written", () => {
  test("a half-written last line is skipped, not fatal", () => {
    const h = foldTranscript(jsonl(user("landed")) + '\n{"type":"assist');
    expect(h.lines).toEqual([{ kind: "you", text: "landed" }]);
  });

  test("only the tail is kept, and says so", () => {
    const many = Array.from({ length: HISTORY_MAX_LINES + 20 }, (_, i) => user(`p${i}`));
    const h = foldTranscript(jsonl(...many), { partial: true });
    expect(h.lines.length).toBe(HISTORY_MAX_LINES);
    expect(h.dropped).toBe(20);
    expect(h.lines[0].text).toBe("p20");
    expect(h.partial).toBe(true);
  });

  test("an absent or empty transcript folds to nothing", () => {
    expect(foldTranscript("").lines).toEqual([]);
    expect(foldTranscript("\n\n").lines).toEqual([]);
  });
});

describe("a local command writes four records and marks one of them", () => {
  /* Taken from a real manual `/compact` (tools/probe-compact.ts, claude
     2.1.232). The caveat carries `isMeta` and is dropped with the rest of the
     injected context; the other two carry nothing, and were pushed as `you`
     lines — which is why a compacted card read as though somebody had typed
     the word "compact" into it. */
  test("the command is what you did, not something you said", () => {
    const h = foldTranscript(
      jsonl(
        user("<local-command-caveat>Caveat: the messages below…</local-command-caveat>", {
          isMeta: true,
        }),
        user(
          [
            "<command-name>/compact</command-name>",
            "            <command-message>compact</command-message>",
            "            <command-args></command-args>",
          ].join("\n"),
        ),
        user("<local-command-stdout>Compacted </local-command-stdout>"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "meta", text: "/compact" },
      { kind: "meta", text: "Compacted" },
    ]);
  });

  test("arguments are kept, since they are half of what you ran", () => {
    const h = foldTranscript(
      jsonl(
        user(
          [
            "<command-name>/model</command-name>",
            "<command-message>model</command-message>",
            "<command-args>sonnet</command-args>",
          ].join("\n"),
        ),
      ),
    );
    expect(h.lines).toEqual([{ kind: "meta", text: "/model sonnet" }]);
  });

  test("a command that printed nothing adds no line", () => {
    // Its name, pushed just above, has already said everything there is.
    const h = foldTranscript(jsonl(user("<local-command-stdout></local-command-stdout>")));
    expect(h.lines).toEqual([]);
  });

  test("a prompt that merely mentions one is still a prompt", () => {
    const h = foldTranscript(
      jsonl(user("use <command-name> tags in the docs page you are writing")),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "use <command-name> tags in the docs page you are writing" },
    ]);
  });
});

describe("the call, and what came back", () => {
  /* A `tool` line used to be only `describeTool`'s prose, which says what the
     agent is doing and nothing about what it did. The panel now opens one, so
     both halves have to survive being read back off disk — or a card that has
     been roused shows less about its own history than it did before the
     restart, which is the seam this whole file exists to avoid. */

  test("a result finds the call that asked for it", () => {
    const h = foldTranscript(
      jsonl(
        assistant([
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun run test" } },
        ]),
        user([{ type: "tool_result", tool_use_id: "t1", content: "44 pass\n0 fail" }]),
      ),
    );
    expect(h.lines[0].call?.result).toEqual({ text: "44 pass\n0 fail" });
  });

  test("results are routed by id, not by order", () => {
    /* Two calls in one message and the replies coming back the other way round
       is ordinary — a tool result carries the id of the call it answers and
       nothing else, which is the only thing tying the two together. */
    const h = foldTranscript(
      jsonl(
        assistant([
          { type: "tool_use", id: "a", name: "Read", input: { file_path: "one.ts" } },
          { type: "tool_use", id: "b", name: "Read", input: { file_path: "two.ts" } },
        ]),
        user([
          { type: "tool_result", tool_use_id: "b", content: "two" },
          { type: "tool_result", tool_use_id: "a", content: "one" },
        ]),
      ),
    );
    expect(h.lines.map((l) => l.call?.result?.text)).toEqual(["one", "two"]);
  });

  test("an error is marked as one", () => {
    const h = foldTranscript(
      jsonl(
        assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "gone.ts" } }]),
        user([
          { type: "tool_result", tool_use_id: "t2", content: "no such file", is_error: true },
        ]),
      ),
    );
    expect(h.lines[0].call?.result).toEqual({ text: "no such file", failed: true });
  });

  test("a call whose result never came has none", () => {
    /* The file ends mid-turn, which is what every transcript of a card still
       working looks like. Drawn as a call in flight rather than as one that
       answered with nothing. */
    const h = foldTranscript(
      jsonl(assistant([{ type: "tool_use", id: "t3", name: "Read", input: {} }])),
    );
    expect(h.lines[0].call?.result).toBeUndefined();
  });

  test("what is kept is bounded", () => {
    /* Four hundred lines of history, each able to hold an argument and a result
       — so the cap is applied here, where the line is written, and not at the
       far end where it would not be a memory bound at all. */
    const huge = "x".repeat(VALUE_CAP + 100);
    const h = foldTranscript(
      jsonl(
        assistant([{ type: "tool_use", id: "t4", name: "Write", input: { content: huge } }]),
        user([{ type: "tool_result", tool_use_id: "t4", content: huge }]),
      ),
    );
    expect((h.lines[0].call?.input as any).content).toHaveLength(VALUE_CAP);
    expect(h.lines[0].call?.result?.text).toHaveLength(VALUE_CAP);
    expect(h.lines[0].call?.result?.clipped).toBe(100);
  });

  test("a subagent's own calls stay out, as its speech does", () => {
    const h = foldTranscript(
      jsonl(
        assistant([{ type: "tool_use", id: "s1", name: "Read", input: {} }], {
          isSidechain: true,
        }),
        assistant([{ type: "tool_use", id: "m1", name: "Glob", input: { pattern: "*.ts" } }]),
      ),
    );
    expect(h.lines.map((l) => l.call?.name)).toEqual(["Glob"]);
  });
});
