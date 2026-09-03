import { describe, expect, test } from "bun:test";
import {
  MAX_QUESTIONS,
  NO_ANSWER_NOTE,
  NO_PREFERENCE,
  PREVIEW_VIEWPORT,
  answerNote,
  answeredCount,
  askHeadline,
  askShown,
  blankAnswers,
  composeAnswer,
  isComplete,
  isScriptBuilt,
  normalizeAsk,
  overflowOf,
  panelsOf,
  previewAside,
  previewDoc,
  stepAt,
  type Answers,
  type AskPreview,
  type AskQuestion,
} from "../src/lib/asking";

const q = (header: string, question: string, labels: string[] = []): AskQuestion => ({
  header,
  question,
  options: labels.map((label) => ({ label, detail: null })),
});

describe("normalizeAsk", () => {
  test("the single-question sugar still makes one question", () => {
    const out = normalizeAsk({
      question: "tabs or spaces?",
      options: [{ label: "tabs" }, { label: "spaces", detail: "the right answer" }],
    });
    expect(out.length).toBe(1);
    expect(out[0].question).toBe("tabs or spaces?");
    expect(out[0].options.map((o) => o.label)).toEqual(["tabs", "spaces"]);
    expect(out[0].options[1].detail).toBe("the right answer");
  });

  test("several questions arrive in order", () => {
    const out = normalizeAsk({
      questions: [
        { header: "shape", question: "one widget or two?", options: [{ label: "two" }] },
        { header: "attention", question: "join the ladder?", options: [{ label: "yes" }] },
      ],
    });
    expect(out.map((x) => x.header)).toEqual(["shape", "attention"]);
    expect(out[1].question).toBe("join the ladder?");
  });

  test("both forms in one call keeps both questions", () => {
    /* A call sending both meant both. Dropping either loses a question the
       turn is genuinely parked on. */
    const out = normalizeAsk({
      question: "and one more thing?",
      questions: [{ question: "first?" }],
    });
    expect(out.map((x) => x.question)).toEqual(["first?", "and one more thing?"]);
  });

  test("a header is derived when none is given", () => {
    const out = normalizeAsk({ question: "Should the timer ring?" });
    expect(out[0].header).toBe("Should the timer ring?");
  });

  test("a derived header takes the first sentence when it is short", () => {
    const out = normalizeAsk({
      question: "Which shape? I can do one widget with variants, or two separate ones.",
    });
    expect(out[0].header).toBe("Which shape?");
  });

  test("a derived header from a long opener is cut on a word", () => {
    const out = normalizeAsk({
      question:
        "Two decisions before I build this and I would rather not guess at either of them.",
    });
    expect(out[0].header.length).toBeLessThanOrEqual(48);
    expect(out[0].header.endsWith("…")).toBe(true);
    expect(out[0].header).not.toContain(" …");
  });

  test("blank and malformed questions are dropped, not drawn", () => {
    const out = normalizeAsk({
      questions: [
        { question: "   " },
        { question: "real one?" },
        { question: 42 },
        "nonsense",
      ],
    });
    expect(out.map((x) => x.question)).toEqual(["real one?"]);
  });

  test("options that are not options are dropped", () => {
    const out = normalizeAsk({
      question: "pick?",
      options: [{ label: "" }, { detail: "no label" }, { label: "  keep  " }, 7],
    });
    expect(out[0].options).toEqual([{ label: "keep", detail: null, preview: null }]);
  });

  test("an empty detail becomes null rather than an empty span", () => {
    const out = normalizeAsk({ question: "pick?", options: [{ label: "a", detail: "  " }] });
    expect(out[0].options[0].detail).toBe(null);
  });

  test("options that are not an array are simply no options", () => {
    const out = normalizeAsk({ question: "pick?", options: "tabs, spaces" });
    expect(out[0].options).toEqual([]);
  });

  test("an ask with nothing in it is still answerable", () => {
    /* The turn is parked either way. A card blocked with nothing on screen
       to unblock it with is the one outcome that cannot be allowed. */
    const out = normalizeAsk({});
    expect(out.length).toBe(1);
    expect(out[0].question).toBe("(no question given)");
  });

  test("the cap holds and the overflow is countable", () => {
    const raw = {
      questions: Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
        question: `q${i}?`,
      })),
    };
    expect(normalizeAsk(raw).length).toBe(MAX_QUESTIONS);
    expect(overflowOf(raw)).toBe(3);
  });

  test("nothing over the cap means no overflow", () => {
    expect(overflowOf({ questions: [{ question: "a?" }] })).toBe(0);
    expect(overflowOf({})).toBe(0);
  });
});

describe("stepping", () => {
  const qs = [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")];

  test("a fresh sheet starts on the first question", () => {
    const a = blankAnswers(qs);
    expect(a).toEqual([null, null, null]);
    expect(stepAt(a)).toBe(0);
    expect(isComplete(a)).toBe(false);
    expect(answeredCount(a)).toBe(0);
  });

  test("the step is the first unanswered question", () => {
    expect(stepAt(["two", null, null])).toBe(1);
    expect(stepAt(["two", "yes", null])).toBe(2);
  });

  test("revising an earlier answer does not strand the cursor", () => {
    /* The step is derived, so going back to change question 1 and answering
       it again lands on 2 rather than on a question already answered. */
    const answers = ["two", "yes", null];
    answers[0] = null;
    expect(stepAt(answers)).toBe(0);
    answers[0] = "three";
    expect(stepAt(answers)).toBe(2);
  });

  test("a complete sheet parks on the last question", () => {
    const a = ["two", "yes", "timer"];
    expect(stepAt(a)).toBe(2);
    expect(isComplete(a)).toBe(true);
    expect(answeredCount(a)).toBe(3);
  });

  test("an empty sheet is not complete", () => {
    expect(isComplete([])).toBe(false);
  });

  test("the sheet may be filled in any order", () => {
    /* The questions in one call are usually independent — that is the reason
       they are asked together — so there is no order to enforce, and the panel
       enforces none. What makes that safe is `composeAnswer` keying on the
       index rather than on when an answer arrived; see the test below. */
    const answers: Answers = [null, null, null];
    answers[2] = "timer";
    expect(stepAt(answers)).toBe(0);
    answers[0] = "two";
    expect(stepAt(answers)).toBe(1);
    expect(isComplete(answers)).toBe(false);
    answers[1] = "yes";
    expect(isComplete(answers)).toBe(true);
  });
});

describe("composeAnswer", () => {
  test("one question composes to the bare answer", () => {
    /* Load-bearing: this is what every ask sent before multi-question, and a
       single question suddenly arriving numbered would change the reply shape
       for every agent already written against it. */
    expect(composeAnswer([q("shape", "one or two?")], ["two widgets"])).toBe("two widgets");
  });

  test("one unanswered question still says something", () => {
    expect(composeAnswer([q("shape", "one or two?")], [null])).toBe(NO_PREFERENCE);
  });

  test("several compose to a numbered list carrying the headers", () => {
    const out = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?")],
      ["two widgets", "yes, join the ladder"],
    );
    expect(out).toBe(
      "Answering each in turn:\n1. shape: two widgets\n2. attention: yes, join the ladder",
    );
  });

  test("the reply is the same however the sheet was filled in", () => {
    /* The load-bearing half of "answer them in any order". An answer is keyed
       by its question's index, never by when it was given, so the composed
       reply is identical — which is what makes the panel free to let you
       start anywhere. */
    const qs = [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")];

    const inOrder: Answers = [null, null, null];
    inOrder[0] = "two";
    inOrder[1] = "yes";
    inOrder[2] = "timer";

    const backwards: Answers = [null, null, null];
    backwards[2] = "timer";
    backwards[1] = "yes";
    backwards[0] = "two";

    expect(composeAnswer(qs, backwards)).toBe(composeAnswer(qs, inOrder));
    expect(composeAnswer(qs, backwards)).toContain("1. shape: two");
    expect(composeAnswer(qs, backwards)).toContain("3. name: timer");
  });

  test("a skipped question is sent, not omitted", () => {
    /* A gap in a numbered list invites the model to re-align the rest onto
       the wrong questions. */
    const out = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")],
      ["two widgets", null, "timer"],
    );
    expect(out.split("\n")).toEqual([
      "Answering each in turn:",
      "1. shape: two widgets",
      `2. attention: ${NO_PREFERENCE}`,
      "3. name: timer",
    ]);
  });

  test("a whitespace answer is treated as no preference", () => {
    const out = composeAnswer([q("a", "a?"), q("b", "b?")], ["   ", "yes"]);
    expect(out).toContain(`1. a: ${NO_PREFERENCE}`);
  });
});

describe("answerNote", () => {
  test("one question's answer is kept exactly as it was sent", () => {
    expect(answerNote("two widgets")).toEqual({ kind: "answer", text: "two widgets" });
  });

  test("the preamble is dropped and the pairs are kept", () => {
    /* It is a sentence addressed to the model. What you actually decided is the
       numbered pairs under it, and they are the whole of what the transcript
       has to show. */
    const sent = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?")],
      ["two widgets", "keep it silent"],
    );
    expect(answerNote(sent)).toEqual({
      kind: "answer",
      text: "1. shape: two widgets\n2. attention: keep it silent",
    });
  });

  test("an answer that happens to mention the preamble keeps it", () => {
    /* Only the whole opening line is the preamble — anything else is a
       sentence you typed, and the panel does not edit those. */
    expect(answerNote("Answering each in turn: sure, go ahead")).toEqual({
      kind: "answer",
      text: "Answering each in turn: sure, go ahead",
    });
  });

  test("what ask.rs says when nobody answered is not something you said", () => {
    /* The same hazard `isStopNote` exists for, one layer over: read off disk
       the timeout is a `tool_result` like any other, and drawn as an answer it
       puts Skein's sentence in your mouth. */
    for (const sent of [
      "The user did not answer within ten minutes. Proceed using your best judgement, and say which way you went and why.",
      "The user dismissed the question. Proceed using your best judgement.",
    ]) {
      expect(answerNote(sent)).toEqual({ kind: "meta", text: NO_ANSWER_NOTE });
    }
  });

  test("an empty reply draws nothing", () => {
    expect(answerNote("")).toBe(null);
    expect(answerNote("   \n  ")).toBe(null);
  });

  test("skein's note to the model is not drawn as something you said", () => {
    /* The whole reason the aside carries a marker at both ends. Without the
       strip, the transcript's record of a one-word decision is that word
       followed by a paragraph of Skein lecturing an agent about `js`, in the
       register of a thing the user typed. */
    const sent = composeAnswer(
      [
        {
          header: "shape",
          question: "which?",
          options: [{ label: "warm", detail: null, preview: skeleton() }],
        },
      ],
      ["warm"],
    );
    expect(sent).toContain("skeleton built by `js`");
    expect(answerNote(sent)).toEqual({ kind: "answer", text: "warm" });
  });
});

describe("askHeadline", () => {
  test("one question is its own headline", () => {
    expect(askHeadline([q("shape", "one widget or two?")])).toBe("one widget or two?");
  });

  test("several are named by their headers, never by a truncated body", () => {
    /* The peek's line is nowrap with an ellipsis. A question body there is a
       cut-off paragraph naming nothing. */
    expect(askHeadline([q("shape", "one or two?"), q("attention", "ring?")])).toBe(
      "2 decisions: shape · attention",
    );
  });
});

const preview = (over: Partial<AskPreview> = {}): AskPreview => ({
  html: "<main>a design</main>",
  css: null,
  js: null,
  ...over,
});

/** The design sink 51863e1e reported: markup with nothing in it, filled in by
 *  a script that does not run until somebody asks for it. */
const skeleton = (): AskPreview => ({
  html: '<div id="rows"></div>',
  css: "#rows{display:grid}",
  js: 'document.getElementById("rows").innerHTML = "<b>a row</b>";',
});

describe("isScriptBuilt", () => {
  test("markup with nothing in it and a script to fill it is the reported bug", () => {
    expect(isScriptBuilt(skeleton())).toBe(true);
  });

  test("a design with no script of its own is never one", () => {
    expect(isScriptBuilt(preview())).toBe(false);
    expect(isScriptBuilt({ html: '<div id="rows"></div>', css: null, js: null })).toBe(false);
  });

  test("markup that draws something is not a skeleton, whatever its script does", () => {
    /* The check has to be conservative in this direction: a design that renders
       and *also* animates is the ordinary use of `js`, and telling its author
       it drew nothing would be false. */
    for (const html of [
      "<main>a design</main>",
      '<div><img src="data:image/gif;base64,R0lGOD"></div>',
      "<figure><svg viewBox='0 0 4 4'></svg></figure>",
      "<p>&nbsp;loading the rows&nbsp;</p>",
    ]) {
      expect(isScriptBuilt({ html, css: null, js: "go()" })).toBe(false);
    }
  });

  test("comments and entities are not content", () => {
    /* An entity on its own is whitespace or a bullet, and a comment is nothing
       at all — neither is a design somebody can look at and decide from. */
    expect(
      isScriptBuilt({ html: "<!-- rows go here --><ul id='rows'>&nbsp;</ul>", css: null, js: "go()" }),
    ).toBe(true);
  });
});

describe("previewAside", () => {
  test("nothing is said about a call whose designs all render", () => {
    /* Additive and only in the failing case — the reply shape every agent is
       written against must not change for the calls that were fine. */
    expect(previewAside([q("shape", "one or two?")])).toBe(null);
    expect(
      previewAside([
        {
          header: "shape",
          question: "which?",
          options: [{ label: "warm", detail: null, preview: preview({ js: "go()" }) }],
        },
      ]),
    ).toBe(null);
  });

  test("it counts them across the whole sheet, not per question", () => {
    const said = previewAside([
      {
        header: "shape",
        question: "which?",
        preview: skeleton(),
        options: [{ label: "warm", detail: null, preview: skeleton() }],
      },
      { header: "attention", question: "ring?", options: [] },
    ]);
    expect(said).toContain("2 designs in this call were");
  });

  test("it says what to do differently rather than only what went wrong", () => {
    const said = previewAside([
      {
        header: "shape",
        question: "which?",
        options: [{ label: "warm", detail: null, preview: skeleton() }],
      },
    ]);
    expect(said).toContain("one design in this call was");
    expect(said).toContain("`html` and `css`");
    expect(said).toContain("chat card");
  });
});

describe("previews", () => {
  test("an option carries one, and it survives normalizing", () => {
    const out = normalizeAsk({
      question: "which of these?",
      options: [
        { label: "warm", preview: { html: "<b>warm</b>", css: "b{color:red}" } },
        { label: "cool" },
      ],
    });
    expect(out[0].options[0].preview).toEqual({
      html: "<b>warm</b>",
      css: "b{color:red}",
      js: null,
    });
    /* The ordinary option is the overwhelming majority and must stay cheap. */
    expect(out[0].options[1].preview).toBe(null);
  });

  test("a question can carry one of its own, for an approval", () => {
    const out = normalizeAsk({
      question: "will this do?",
      preview: { html: "<main>it</main>" },
      options: [{ label: "yes" }, { label: "no" }],
    });
    expect(out[0].preview?.html).toBe("<main>it</main>");
  });

  test("a preview with no markup is no preview", () => {
    /* An empty frame is worse than no frame: it reads as a design that failed
       to load rather than as an option that never had one. */
    for (const bad of [{}, { html: "  " }, { css: "b{}" }, "nope", 7, [], null]) {
      const out = normalizeAsk({ question: "?", options: [{ label: "a", preview: bad }] });
      expect(out[0].options[0].preview).toBe(null);
    }
  });

  test("normalizing degrades rather than refusing, as everywhere else here", () => {
    const out = normalizeAsk({
      question: "?",
      options: [{ label: "a", preview: { html: "<i>x</i>", css: 5, js: {} } }],
    });
    expect(out[0].options[0].preview).toEqual({ html: "<i>x</i>", css: null, js: null });
  });
});

describe("panelsOf", () => {
  test("nothing to look at is the normal ask", () => {
    expect(panelsOf(q("shape", "one or two?", ["one", "two"]))).toEqual([]);
  });

  test("the question's own preview comes first and chooses nothing", () => {
    const out = panelsOf({
      header: "approve",
      question: "will this do?",
      preview: preview(),
      options: [
        { label: "yes", detail: null },
        { label: "tweak it", detail: null, preview: preview({ html: "<i>b</i>" }) },
      ],
    });
    expect(out.length).toBe(2);
    expect(out[0].label).toBe(null);
    expect(out[1].label).toBe("tweak it");
  });
});

describe("previewDoc", () => {
  /* The sandbox attribute is the guaranteed boundary and it lives on the
     element (`Gallery.svelte`); what this function is responsible for is the
     document's own policy, and the two things that policy decides. */

  test("the frame can reach nothing by default", () => {
    /* `tauri.conf.json` has `"csp": null`, so nothing above this stops a
       mockup fetching from the internet. This line is the whole of what does. */
    const doc = previewDoc(preview(), { scripts: false });
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
  });

  test("scripts are gated by the card, not by the payload", () => {
    const p = preview({ js: "document.title='x'" });
    const off = previewDoc(p, { scripts: false });
    expect(off).toContain("script-src 'none'");
    expect(off).not.toContain("document.title");

    const on = previewDoc(p, { scripts: true });
    expect(on).toContain("script-src 'unsafe-inline'");
    expect(on).toContain("document.title");
  });

  test("the gate covers a script written into the markup too", () => {
    /* Otherwise the `js` field is a front door with the window left open: a
       chat card's agent would simply put the script in `html` instead. */
    const doc = previewDoc(preview({ html: "<script>fetch('/x')</script>" }), {
      scripts: false,
    });
    expect(doc).toContain("script-src 'none'");
  });

  test("no script element when there is no script", () => {
    expect(previewDoc(preview(), { scripts: true })).not.toContain("<script>");
  });

  test("a closing tag in the text cannot end the element early", () => {
    /* Not a boundary — the CSP is — but a design that silently loses its second
       half because a stylesheet contained `</style` is a bug that reads as the
       model's rather than as ours. */
    const doc = previewDoc(preview({ css: "a{}</style><b>", js: "//</script><b>" }), {
      scripts: true,
    });
    expect(doc).not.toContain("</style><b>");
    expect(doc).not.toContain("</script><b>");
  });

  test("the app's own tokens are defined when they are passed", () => {
    const doc = previewDoc(preview(), { scripts: false, tokens: ":root{--paper:#fff}" });
    expect(doc).toContain("--paper:#fff");
  });

  test("it composes at the one size everything is compared at", () => {
    const doc = previewDoc(preview(), { scripts: false });
    expect(doc).toContain(`width:${PREVIEW_VIEWPORT.w}px`);
    expect(doc).toContain(`height:${PREVIEW_VIEWPORT.h}px`);
  });
});

describe("askShown", () => {
  const a = { id: "a" };
  const b = { id: "b" };

  test("the card in the ring answers its own question", () => {
    expect(askShown(b, [a, b])).toBe(b);
  });

  test("otherwise it is the first card that asked", () => {
    expect(askShown(null, [a, b])).toBe(a);
    expect(askShown({ id: "c" }, [a, b])).toBe(a);
  });

  test("selecting the card it drew is what takes the offer down", () => {
    /* The button appears exactly while the drawn card is not the focused one,
       so landing on it has to make the two agree — nothing else clears it. */
    const shown = askShown(null, [a, b]);
    expect(shown).not.toBe(null);
    expect(askShown(shown, [a, b])).toBe(shown);
  });

  test("nothing blocked draws nothing", () => {
    expect(askShown(a, [])).toBe(null);
  });
});
