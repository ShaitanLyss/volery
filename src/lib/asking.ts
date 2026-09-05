/* A parked question, as a thing with parts.
 *
 * `ask_user` began as one question with a flat list of options, which is the
 * right shape for most asks and the wrong one for the ask that matters. An
 * agent about to build something rarely has one decision outstanding; it has
 * two or three, on independent axes. With one question to put them in, it
 * fuses them — and the options it writes are then a *cross-product*:
 *
 *     two widgets, and yes to attention
 *     two widgets, but keep it silent
 *     one widget with three variants (attention: yes)
 *     three widgets (attention: yes)
 *
 * Four of the eight combinations, presented as if they were the whole set, so
 * "three widgets, keep it silent" was not merely hard to pick — it was not
 * there. That is worse than a long question. It is a list that looks complete
 * and is not, and the length is a symptom of the same fusing: every option has
 * to spell out both halves, which is what turns four choices into four
 * paragraphs.
 *
 * So a call carries N questions and the panel walks you through them one at a
 * time. The parking is unchanged and cannot change — one `tools/call` is one
 * HTTP request and gets one reply — so the answers are composed into that
 * single reply when the last one is given. This module is the pure half: what a
 * call asked, where you are in answering it, and what the reply says.
 */

/** A design that can be *looked at* rather than described.
 *
 *  Claude Code in a terminal can only spell a layout out in prose, so an agent
 *  with three designs to offer writes three paragraphs and you pick one by
 *  imagining it. There is a webview here. The option carries the thing itself
 *  and Skein draws it, which is the one question this app is better placed to
 *  ask than the CLI is.
 *
 *  It is a document, not a component: the model writes plain HTML, plain CSS
 *  and — where a decision genuinely turns on interaction — plain script, and it
 *  runs in an isolated frame that can reach nothing (`previewDoc`, and the
 *  `sandbox` attribute in `Gallery.svelte`). No framework, no imports, no
 *  network. */
export type AskPreview = {
  html: string;
  css: string | null;
  js: string | null;
};

export type AskOption = {
  label: string;
  detail?: string | null;
  /** What picking this looks like. `null` for the ordinary option, which is
   *  most of them — this is for the choice between *designs*. */
  preview?: AskPreview | null;
};

export type AskQuestion = {
  /** A few words naming the decision. Shown on the panel's spine and in the
   *  peek, which is a single ellipsised line and can do nothing with a
   *  paragraph. Derived from the question when the agent gives none. */
  header: string;
  question: string;
  options: AskOption[];
  /** One thing to look at, for the question that shows a single design and
   *  asks whether it will do. That is an approval, not a comparison, so it
   *  hangs off the question rather than being duplicated onto a yes and a no. */
  preview?: AskPreview | null;
};

/** One slot per question, in step order. `null` means not answered yet. */
export type Answers = (string | null)[];

/** What a skipped question sends. The agent asked, so it is owed a reply — and
 *  "you decide" is a real answer that reads as one, where an empty string
 *  reads as a bug. */
export const NO_PREFERENCE = "no preference — your call";

/** Past this many, a call is not asking a question, it is administering a
 *  survey. The excess is dropped rather than truncated silently mid-list: see
 *  `overflowOf`, which exists so the panel can say so. */
export const MAX_QUESTIONS = 5;

/* -- how long the whole call gets -----------------------------------------
 *
 * Mirrored in `ask.rs` — `ANSWER_BASE`, `ANSWER_PER_QUESTION`,
 * `ANSWER_PER_OPTION`, `ANSWER_MAX`, `answer_window` — and the duplication is
 * deliberate. `Ask.svelte` draws a live countdown, which is real information
 * rather than decoration: it is what tells you whether to keep reading or answer
 * now. The number it counts down to must be the number the parking thread gives
 * up on, and neither side can be handed the other's answer without a field on
 * `ask:opened` and a matching read in `skein.svelte.ts` — the panel holds the
 * *normalized* questions and Rust holds the raw arguments. So what is shared is
 * the arithmetic, and `ask.rs`'s tests assert the same table of payloads these
 * do.
 *
 * It was a flat ten minutes, which meant two different things depending on what
 * was asked. A call carrying five questions with three or four options each,
 * context and pros and cons per option, expired with the user still reading it —
 * "I was almost done, the answer time should scale with number of questions" —
 * and they answered all five immediately when re-asked, which is the evidence
 * the clock was the only thing wrong (sink `d2adbf74`). */

/** The floor: what one bare question gets, and what every call used to get. */
export const ANSWER_BASE = 600;

/** What each question past the first adds. The first is what the floor pays
 *  for. */
export const ANSWER_PER_QUESTION = 180;

/** What each drawn option adds, over every question in the call.
 *
 *  The reading load is in the options rather than the question count — one
 *  decision between eight described alternatives is a longer read than four
 *  plain yes/nos, and an option carries a `detail` line precisely so it is worth
 *  reading. */
export const ANSWER_PER_OPTION = 20;

/** The ceiling, and it is not about patience. `ask.rs::client_timeout_ms` is
 *  written into the card's `--mcp-config` at spawn, so the *client's* deadline
 *  cannot scale with a call it has not received yet. It is set from this, and
 *  every call has to fit under it or the client gives up first and writes its own
 *  sentence instead of Skein's. */
export const ANSWER_MAX = 2700;

/** How long this call waits, in seconds, from what it is asking.
 *
 *  Takes the questions the panel will actually draw — so the cap, the dropped
 *  empties and the placeholder are all already applied by `normalizeAsk`, which
 *  is why this is the shorter half of the mirror. */
export function answerWindow(questions: AskQuestion[]): number {
  const n = Math.max(1, questions.length);
  const options = questions.reduce((t, q) => t + q.options.length, 0);
  return Math.min(
    ANSWER_MAX,
    ANSWER_BASE + ANSWER_PER_QUESTION * (n - 1) + ANSWER_PER_OPTION * options,
  );
}

/** Enough of a question to name it, when the agent named nothing. */
function headerFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  /* The first sentence, if there is a short one — an agent's opener is
     "Two decisions before I build." far more often than it is the decision, but
     when it *is* the decision it is the best label available. */
  const stop = flat.search(/[.?!](\s|$)/);
  const first = stop > 0 ? flat.slice(0, stop + 1) : flat;
  const pick = first.length <= 48 ? first : flat;
  if (pick.length <= 48) return pick;
  const cut = pick.slice(0, 47);
  const space = cut.lastIndexOf(" ");
  return (space > 28 ? cut.slice(0, space) : cut.trimEnd()) + "…";
}

type RawOption = { label?: unknown; detail?: unknown; preview?: unknown };
type RawQuestion = {
  header?: unknown;
  question?: unknown;
  options?: unknown;
  preview?: unknown;
};

/** A preview, or nothing — and nothing is the answer to almost everything.
 *
 *  `html` is the whole of what makes one: a preview with no markup is an empty
 *  frame, which is worse than no frame at all because it reads as a design that
 *  failed to load. `css` and `js` are each optional on their own. */
function previewFrom(raw: unknown): AskPreview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as { html?: unknown; css?: unknown; js?: unknown };
  const html = typeof p.html === "string" ? p.html.trim() : "";
  if (!html) return null;
  const css = typeof p.css === "string" ? p.css.trim() : "";
  const js = typeof p.js === "string" ? p.js.trim() : "";
  return { html, css: css || null, js: js || null };
}

function optionsFrom(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const o of raw as RawOption[]) {
    const label = typeof o?.label === "string" ? o.label.trim() : "";
    if (!label) continue;
    const detail = typeof o?.detail === "string" ? o.detail.trim() : "";
    out.push({ label, detail: detail || null, preview: previewFrom(o?.preview) });
  }
  return out;
}

/** What the wire said, as questions we can draw.
 *
 *  Tolerant on purpose, and in the same spirit as `normalizeWidget`: this runs
 *  on a payload an agent composed, so a missing field, a string where an array
 *  belongs, or a question that is nothing but whitespace has to degrade to
 *  something answerable. An ask that arrives with no question at all is still a
 *  parked turn — refusing to draw it would leave the card blocked with nothing
 *  on screen to unblock it with. */
export function normalizeAsk(raw: {
  question?: unknown;
  options?: unknown;
  questions?: unknown;
}): AskQuestion[] {
  const list: RawQuestion[] = Array.isArray(raw?.questions)
    ? (raw.questions as RawQuestion[])
    : [];

  const out: AskQuestion[] = [];
  for (const q of list) {
    const text = typeof q?.question === "string" ? q.question.trim() : "";
    if (!text) continue;
    const header = typeof q?.header === "string" ? q.header.trim() : "";
    out.push({
      header: header || headerFrom(text),
      question: text,
      options: optionsFrom(q?.options),
      preview: previewFrom(q?.preview),
    });
  }

  /* The single-question sugar. Kept because most asks are one decision and a
     one-line call should stay a one-line call — and because it is what every
     already-running agent is holding. It is *appended* rather than preferred:
     a call sending both meant both, and dropping either would lose a question
     the turn is parked on. */
  const single = typeof raw?.question === "string" ? raw.question.trim() : "";
  if (single) {
    out.push({
      header: headerFrom(single),
      question: single,
      options: optionsFrom(raw?.options),
      preview: previewFrom((raw as { preview?: unknown })?.preview),
    });
  }

  if (!out.length) {
    out.push({
      header: "no question given",
      question: "(no question given)",
      options: [],
      preview: null,
    });
  }

  return out.slice(0, MAX_QUESTIONS);
}

/** How many questions were dropped for being past the cap. The panel says so,
 *  because an agent that asked six things and got five answers will act on the
 *  sixth regardless, and you should know which one it is guessing at. */
export function overflowOf(raw: { questions?: unknown }): number {
  const n = Array.isArray(raw?.questions) ? raw.questions.length : 0;
  return Math.max(0, n - MAX_QUESTIONS);
}

/** The size a preview is composed at.
 *
 *  A frame cannot tell you how tall it wants to be, and asking it would mean a
 *  `postMessage` channel back out of the sandbox — a hole in the one wall this
 *  feature stands on, opened for a layout convenience. So a preview is drawn
 *  into a fixed viewport and scaled down, which is what the wall already does
 *  with cards (`CARD_BOX`): every design is composed at the same size and
 *  compared at the same size, which is also the only way three of them side by
 *  side mean anything. */
export const PREVIEW_VIEWPORT = { w: 1280, h: 800 };

/** One thing the gallery draws, whatever it hung off.
 *
 *  A question's own preview and its options' previews are the same object to
 *  look at and differ only in whether picking it answers anything — the
 *  approval case has nothing to pick, the comparison case has one per panel. */
export type PreviewPanel = {
  /** The answer this panel sends, or `null` for a question's own preview,
   *  which is a thing to look at rather than a thing to choose. */
  label: string | null;
  detail: string | null;
  preview: AskPreview;
};

/** Everything worth showing for one question, in the order it was offered. */
export function panelsOf(q: AskQuestion): PreviewPanel[] {
  const out: PreviewPanel[] = [];
  if (q.preview) out.push({ label: null, detail: null, preview: q.preview });
  for (const o of q.options) {
    if (o.preview) {
      out.push({ label: o.label, detail: o.detail ?? null, preview: o.preview });
    }
  }
  return out;
}

/** Elements that draw something whatever the markup around them says.
 *
 *  Kept short and literal on purpose. This is the escape hatch for a design that
 *  is genuinely one picture or one chart, and widening it toward "anything with
 *  a class attribute" would turn the check below into one that never fires. */
const DRAWS = /<\s*(img|svg|canvas|iframe|video|picture|object|embed|hr|input)\b/i;

/** Whether markup puts anything on the page by itself.
 *
 *  Text with the tags taken out, plus the list above. `<div id="rows"></div>` is
 *  nothing; `<div id="rows">loading…</div>` is something, and so is one `<svg>`. */
function drawsSomething(html: string): boolean {
  if (DRAWS.test(html)) return true;
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " ")
    .trim();
  return text.length > 0;
}

/** A design that is a skeleton its own script fills in, and therefore draws
 *  nothing at all until somebody runs the script.
 *
 *  Reported 2026-09-01 (sink `51863e1e`): a preview whose `html` was
 *  `<div id="rows">` and whose `js` populated it from a JSON block rendered as
 *  an empty frame — no rows, no error, nothing. **The renderer was right.**
 *  Every preview renders static first even on a card that is allowed scripts,
 *  because a srcdoc frame shares the renderer with its parent and there is no
 *  way to kill a `while(true){}` inside one (`Gallery.svelte`); the schema says
 *  so. What was missing is that nothing *surfaced* it. The user read a blank
 *  frame as a broken feature, and the agent got no signal at all — the call
 *  succeeded and came back with an answer.
 *
 *  So this is asked twice from two sides: `Gallery.svelte` draws a plate in the
 *  frame saying the design is waiting on its script, and `composeAnswer` tells
 *  the agent that one of its previews was never seen. Neither half needs the
 *  other, which is the argument for the predicate being here rather than in
 *  either of them.
 *
 *  Deliberately conservative. A skeleton drawn entirely by CSS — a `<div>` with
 *  a background and a size — is a false positive, which is why the plate is a
 *  centred note over the frame rather than a cover: whatever is behind it is
 *  still visible around it, and running the script takes it away. */
export function isScriptBuilt(p: AskPreview): boolean {
  return !!p.js && !drawsSomething(p.html);
}

/* A closing tag inside the text ends the element early. Neither of these is a
   security boundary — the CSP below is, and the markup is the model's anyway —
   but a design that silently loses its second half because a stylesheet
   contained the string `</style` is a bug that would read as the model's. */
function neuter(source: string): string {
  return source.replace(/<\/(script|style)/gi, "<\\/$1");
}

/** The document a preview is rendered as.
 *
 *  Two things contain it, and only one of them is guaranteed:
 *
 *  - **The `sandbox` attribute, which `Gallery.svelte` sets and this function
 *    cannot.** `allow-scripts` *without* `allow-same-origin` puts the frame on
 *    an opaque origin: no parent DOM, no reaching `window.__TAURI__` through
 *    `window.parent`, no storage, no top-level navigation, no modals. That is
 *    the wall, and it is spec-guaranteed. It matters here more than it would in
 *    a browser, because a project card's agent is spawned with
 *    `--dangerously-skip-permissions` and the invoke bridge is the app's whole
 *    surface.
 *  - **This CSP, which closes network egress and gates scripts.**
 *    `tauri.conf.json` has `"csp": null`, so nothing at the app level stops a
 *    mockup fetching from the internet, and `default-src 'none'` is the whole
 *    of what does. **Not yet probed against WebView2**: a `<meta>` CSP applies
 *    to the document it is in by spec and srcdoc inherits its parent's (here,
 *    none), but this has been reasoned about rather than tested, and it wants a
 *    `tools/probe-*.ts` before it is relied on for anything but designs.
 *
 *  `scripts` is not a knob on the preview — it is decided by what kind of card
 *  asked. See `Gallery.svelte`.
 *
 *  `tokens` is the app's own custom properties, passed in rather than imported
 *  so this module stays pure and directly testable. A design composed in
 *  Skein's palette is being judged on the decision rather than on whether the
 *  agent guessed the greys. */
export function previewDoc(
  preview: AskPreview,
  opts: { scripts: boolean; tokens?: string },
): string {
  const policy = [
    "default-src 'none'",
    "img-src data:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    /* One gate for scripts wherever they are written, so a `<script>` typed
       into `html` is refused on a chat card exactly as the `js` field is. */
    opts.scripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
  ].join("; ");

  const frame = `html,body{margin:0;padding:0;width:${PREVIEW_VIEWPORT.w}px;height:${PREVIEW_VIEWPORT.h}px;overflow:hidden;background:var(--ink,#151210);color:var(--paper,#ede4d8);font-family:var(--body,Georgia,serif)}*{box-sizing:border-box}`;

  const parts = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    opts.tokens ? `<style>${neuter(opts.tokens)}</style>` : "",
    `<style>${frame}</style>`,
    preview.css ? `<style>${neuter(preview.css)}</style>` : "",
    "</head><body>",
    preview.html,
    opts.scripts && preview.js ? `<script>${neuter(preview.js)}</script>` : "",
    "</body></html>",
  ];
  return parts.join("");
}

/** A fresh sheet of answers. */
export function blankAnswers(questions: AskQuestion[]): Answers {
  return questions.map(() => null);
}

/** Which question you are on: the first one still unanswered.
 *
 *  Derived rather than held, so going back to revise an earlier answer and then
 *  moving on cannot leave a cursor pointing at a question already answered. */
export function stepAt(answers: Answers): number {
  const i = answers.findIndex((a) => a === null);
  return i === -1 ? answers.length - 1 : i;
}

export function isComplete(answers: Answers): boolean {
  return answers.length > 0 && answers.every((a) => a !== null);
}

export function answeredCount(answers: Answers): number {
  return answers.filter((a) => a !== null).length;
}

/** The line a multi-question reply opens with. Named rather than inlined
 *  because the transcript's own record of that reply has to strip exactly this
 *  and nothing else — see `answerNote`. */
const PREAMBLE = "Answering each in turn:";

/** The reply the parked request unparks with.
 *
 *  One question composes to the bare answer and nothing else. That is not
 *  tidiness — it is what every ask before this one sent, and a single question
 *  suddenly arriving numbered and headed would change the shape of a reply for
 *  every agent already written against it.
 *
 *  Several compose to a numbered list carrying each question's header, so the
 *  model cannot mis-pair an answer with the decision it belongs to. Unanswered
 *  slots are sent as `NO_PREFERENCE` rather than omitted, for the same reason:
 *  a list with a gap in it invites the model to re-align the rest. */
/** How a note *about* the call is set apart from the answer to it.
 *
 *  One marker, matched in both directions: `composeAnswer` writes it and
 *  `answerNote` takes it off again, so a sentence Skein addressed to the model
 *  is never drawn in the transcript as a sentence you said. That is the same
 *  hazard `UNANSWERED` guards, one layer over. */
const ASIDE = "\n\n— skein: ";

/** What the agent is told about a design it composed that was never seen.
 *
 *  `null` for almost every call, which is the point: this is additive and only
 *  in the failing case, so the shape every agent is written against — the bare
 *  answer, the numbered list — is unchanged for the calls that are fine.
 *
 *  See `isScriptBuilt` for why a blank preview is not a renderer bug. The
 *  agent-facing half is here because the panel's plate reaches the user and
 *  nothing reached the model at all: the call succeeded, an answer came back,
 *  and the next call composed the same skeleton. */
export function previewAside(questions: AskQuestion[]): string | null {
  const n = questions.flatMap(panelsOf).filter((p) => isScriptBuilt(p.preview)).length;
  if (!n) return null;
  const [subject, it] =
    n === 1 ? ["one design in this call was", "it"] : [`${n} designs in this call were`, "they"];
  return (
    `${subject} a skeleton built by \`js\`, so ${it} drew nothing in the frame ` +
    "until the user ran the script by hand — and would have drawn nothing at " +
    "all on a chat card, where scripts are refused. Compose the design in " +
    "`html` and `css`, and keep `js` for interaction a static rendering " +
    "genuinely cannot show."
  );
}

export function composeAnswer(questions: AskQuestion[], answers: Answers): string {
  const said =
    questions.length === 1
      ? (answers[0] ?? NO_PREFERENCE).trim()
      : `${PREAMBLE}\n${questions
          .map((q, i) => {
            const a = (answers[i] ?? NO_PREFERENCE).trim() || NO_PREFERENCE;
            return `${i + 1}. ${q.header}: ${a}`;
          })
          .join("\n")}`;
  const aside = previewAside(questions);
  return aside ? `${said}${ASIDE}${aside}` : said;
}

/* What `ask.rs` sends the agent when the question is never answered: the
   deadline running out, and the card being closed while it was still asking.
   Duplicated across the language boundary on purpose — the same bargain
   `isStopNote` strikes with the CLI's own wording, and for the same reason.
   The transcript fold reads a reply back off disk with nothing but its text to
   go on, so without this Skein's own sentence about an unanswered question is
   drawn as a sentence you said. Matched on the opening, since both go on to
   tell the agent what to do instead.

   Which is also what let the timeout sentence start naming its own duration:
   `ask.rs::TIMED_OUT_OPENING` is fixed and everything after it is free. The
   wording it had while the deadline was a flat ten minutes stays here beside the
   new one — a transcript on disk carries it and will go on being folded, and
   dropping it would draw Skein's line as a sentence the user typed. */
const UNANSWERED = [
  "The user did not answer in time.",
  "The user did not answer within ten minutes.",
  "The user dismissed the question.",
];

/** What the panel says when the reply was Skein's rather than yours.
 *
 *  One wording for both cases, because the live path only ever learns *that*
 *  the ask closed unanswered (`ask:closed` carries a boolean) and never which
 *  of the two it was — and a line that reads one way live and another way after
 *  a restart is the seam `history.ts` exists to avoid. */
export const NO_ANSWER_NOTE =
  "no answer sent — the agent went on with its own judgement";

export type AnswerNote = {
  /** `answer` is yours and is drawn as such. `meta` is Skein talking *about*
   *  the conversation, the register `cleared` and `stopped` are written in. */
  kind: "answer" | "meta";
  text: string;
};

/** What the transcript keeps of a parked question's reply.
 *
 *  Both folds go through here — live, from the text `answerAsk` sent, and off
 *  disk, from the `tool_result` the CLI recorded against the call — so what the
 *  panel shows after a restart is what it showed when you clicked. History that
 *  renders differently from live is a visible seam in the middle of one column
 *  of speech, which is the thing `foldTranscript` is written to avoid.
 *
 *  The preamble is dropped: it is addressed to the model, and the numbered
 *  pairs under it are the whole of what you actually said. */
export function answerNote(sent: string): AnswerNote | null {
  const text = sent.trim();
  if (!text) return null;
  if (UNANSWERED.some((u) => text.startsWith(u))) {
    return { kind: "meta", text: NO_ANSWER_NOTE };
  }
  /* From the last one: `composeAnswer` appends, so anything earlier is the
     answer quoting the marker rather than the marker doing its job. */
  const cut = text.lastIndexOf(ASIDE);
  const kept = cut > 0 ? text.slice(0, cut).trim() : text;
  const head = `${PREAMBLE}\n`;
  const body = kept.startsWith(head) ? kept.slice(head.length).trim() : kept;
  return body ? { kind: "answer", text: body } : null;
}

/** What the peek and the dock say a card is waiting on.
 *
 *  The peek's line is `white-space: nowrap` with an ellipsis, so a question
 *  body put there is a truncated paragraph that names nothing. The headers are
 *  short by construction, which is most of why they exist. */
export function askHeadline(questions: AskQuestion[]): string {
  if (questions.length === 1) return questions[0].question;
  return `${questions.length} decisions: ${questions.map((q) => q.header).join(" · ")}`;
}

/** Which blocked card's question the dock draws, out of all of them.
 *
 *  The card in the ring wins whenever it is one of the ones asking, so
 *  answering follows the selection rather than fighting it; otherwise it is the
 *  first that asked, which is the queue `blocked` already is.
 *
 *  It is also what decides whether the panel is about somewhere *else*: the
 *  drawn card is then not the focused one, the transcript beside the question
 *  belongs to a different conversation, and the dock offers to go there. That
 *  offer takes itself down without being told to — selecting the card makes
 *  this return the focused one, and the two stop differing.
 *
 *  Generic over the card because nothing in this file knows what a conversation
 *  is, and `Dock.svelte` is the only caller that does. */
export function askShown<T>(focused: T | null | undefined, blocked: T[]): T | null {
  if (focused && blocked.includes(focused)) return focused;
  return blocked[0] ?? null;
}
