/* Can a small model turn a spoken sentence into an ordered plan of wall ops,
 * with its referents resolved against a known wall?
 *
 * This is the probe `docs/VOICE.md` names as the one that decides whether the
 * decided shape is the right one, and it is the cheap half of the feature: no
 * audio, no microphone, no app, no Rust. Thirty written utterances — the five
 * the user actually asked for, plus compound ones, ambiguous ones, and several
 * built to be misread — against a fixture wall whose contents are known, so a
 * resolved referent can be checked rather than admired.
 *
 *   bun tools/probe-steward.ts --dry            # the prompt and the table, spends nothing
 *   bun tools/probe-steward.ts                  # haiku and sonnet, all thirty
 *   bun tools/probe-steward.ts --model haiku    # one model
 *   bun tools/probe-steward.ts --only 9,13,27   # a few, by id
 *
 * ### What it isolates, and what it therefore cannot see
 *
 * It asks for **JSON in a reply** rather than giving the model real MCP tools.
 * That is deliberate and it is the one variable held apart: the question here is
 * whether the *parse* is any good — whether "select the auth work and open
 * image.png in caravan" comes back as two steps in the right order with the
 * right referents — and wiring an MCP server to find out would mix parse quality
 * with tool-schema plumbing and with the roster's own attention budget.
 *
 * So what it cannot see, stated plainly because `probe-guidance.ts` was green
 * for a fortnight while the feature it attested to was inert:
 *
 *  - **Whether the same quality holds with real tools.** A steward with thirty
 *    MCP tools in front of it is answering a different question from one filling
 *    in a JSON shape, and tool-use decoding is not the same decoder as text.
 *  - **Whether it holds on the app's own argv.** This builds its own, per
 *    `probe-context.ts`'s pattern, so it proves a mechanism and not a
 *    configuration. The lesson from `probe-guidance.ts`: where the argv is the
 *    thing in question, the argv has to come from where the app's comes from.
 *  - **Anything about speech.** Every utterance here is already text. The
 *    transcription is a separate probe with a separate failure mode, and the
 *    spoken-path cases below (`image dot png`, `source slash lib`) are written
 *    the way an engine would hand them over rather than the way a person talks.
 *
 * ### The one thing it is built to test that is a *design* claim, not a model one
 *
 * `docs/VOICE.md` decides that **a step's disposition is a table and not a
 * judgement** — the model returns steps, and whether the plan needs confirming
 * is computed here, from the op names, by the complement of the undo stack. So
 * `needs` below is never read out of the reply. `IMMEDIATE` is that table, and
 * a wrong entry in it is a worse bug than any misparse.
 *
 * **`stop` is the entry to argue about.** By the rule it confirms: it holds a
 * process, so the undo stack refuses it, so voice asks first. But Escape stops a
 * turn today with no confirmation at all, and "stop" is the one thing you want
 * to be instant when a card is going wrong. The counter-argument is that a
 * misheard "stop" is possible where a pressed Escape is not. Utterance 19 exists
 * to put a real answer under that; the table's current entry is a position, not
 * a finding.
 */

/* ── the wall these utterances are spoken at ──────────────────────────────────
 *
 * Built to be hard on purpose. The traps, so nobody removes one by tidying:
 *
 *  - `volery` is a territory whose folder is named `skein`, which is true of
 *    this repository and is the rename `CLAUDE.md` describes.
 *  - `caravan onboarding copy` is a card whose *title* contains a territory's
 *    name, so "caravan" alone is genuinely ambiguous.
 *  - `the ring` is an exact title and `fixing the ring occupancy bug` contains
 *    it, which is the exact-beats-substring case `#card()` already answers.
 *  - `halt work draft` is a card whose title is the payload from the user's own
 *    example. "send halt work draft a message" has to survive that.
 *  - `image.png` and `image@2x.png` sit in one folder.
 */

type Territory = { name: string; root: string; files: string[] };
type Card = { id: string; title: string; project: string; working: boolean };

const TERRITORIES: Territory[] = [
  {
    name: "caravan",
    root: "C:/work/caravan",
    files: [
      "src/assets/image.png",
      "src/assets/image@2x.png",
      "src/components/Header.svelte",
      "src/main.ts",
      "docs/README.md",
      "package.json",
    ],
  },
  {
    name: "volery",
    root: "C:/atelier/skein",
    files: [
      "src/lib/limits.ts",
      "src/lib/skein.svelte.ts",
      "src/lib/tokens.css",
      "docs/VOICE.md",
    ],
  },
  {
    name: "orchard",
    root: "C:/work/orchard",
    files: ["schema/001_init.sql", "src/index.ts"],
  },
];

const CARDS: Card[] = [
  { id: "c1", title: "the auth work", project: "caravan", working: true },
  { id: "c2", title: "caravan onboarding copy", project: "caravan", working: false },
  { id: "c3", title: "halt work draft", project: "caravan", working: false },
  { id: "c4", title: "fixing the ring occupancy bug", project: "volery", working: true },
  { id: "c5", title: "the ring", project: "volery", working: false },
  { id: "c6", title: "sink triage", project: "volery", working: false },
  { id: "c7", title: "orchard schema migration", project: "orchard", working: true },
  { id: "c8", title: "untitled", project: "orchard", working: false },
];

/** Which card is in front. Several utterances have no referent at all and mean
 *  "this one" — `#card()` already falls back to the focused card, so the plan
 *  should too rather than asking. */
const FOCUSED = "c6";

/* ── the disposition table, which is the design's and not the model's ──────── */

/** Immediate, because it only changes how you look at the wall — which is
 *  `undo.md`'s own reason for keeping these off the undo stack. Anything absent
 *  from this set needs confirmation, so a new op is confirmed by default: the
 *  safe direction for a list somebody will extend without reading this file. */
const IMMEDIATE = new Set([
  "focus",
  "select",
  "deselect",
  "find.lookAt",
  "viewport.fit",
  "rename",
  "aside",
  "timer.set",
]);

function dispositionOf(ops: string[]): "nothing" | "confirmation" {
  return ops.every((o) => IMMEDIATE.has(o)) ? "nothing" : "confirmation";
}

/* ── the op vocabulary the steward is given ───────────────────────────────────
 *
 * Real ops, named as `control.svelte.ts` names them, with `find.lookAt` and
 * `sink.add` spelled as `docs/VOICE.md` proposes them (the first is
 * `find do=look-at` in the table today; the second does not exist yet and is the
 * one gap the design found).
 */
const OPS = `
focus        {card}                  bring one card to the front
select       {cards: [...]}          gather cards — the dock aims a prompt at these
deselect     {}                      let go of everything
open         {project}               open a NEW card in a territory
chat         {}                      open a new card with no project
send         {card, text}            send a prompt to one card
broadcast    {cards: [...], text}    send the same prompt to several cards
stop         {card}                  end the turn a card is in the middle of
rename       {card, title}           call a card something else
clear        {card}                  end a card's session and give it a fresh one
close        {card}                  take a card off the wall
aside        {card, aside: true}     put a card by, or pick it back up
find.lookAt  {project, path}         open a file in the reading panel
sink.add     {project, title, body, kind}  file a finding in the wall's sink
post         {subject, body}         put a standing notice on the billboard
viewport.fit {}                      fit the whole wall in the window
timer.set    {minutes, label}        set a countdown
answer       {card, text}            answer a question a card has parked
`.trim();

function systemPrompt(): string {
  const cards = CARDS.map(
    (c) =>
      `  ${c.id}  "${c.title}"  in ${c.project}${c.working ? "  (working)" : ""}${
        c.id === FOCUSED ? "  ← focused" : ""
      }`,
  ).join("\n");

  const territories = TERRITORIES.map(
    (t) => `  ${t.name}  →  ${t.root}\n${t.files.map((f) => `      ${f}`).join("\n")}`,
  ).join("\n");

  return `You turn one spoken sentence into an ordered plan of operations on a studio wall of
Claude Code conversations. Each conversation is a "card". Each repository the wall
knows is a "territory" or "project".

The sentence has been transcribed from speech, so separators may arrive as words:
"dot" for ".", "slash" for "/", "dash" for "-", "underscore" for "_". Spelled-out
extensions ("P N G") mean the extension. Resolve them.

# The wall right now

Cards:
${cards}

Territories, and every file in each:
${territories}

# The operations you may use

${OPS}

# Answer with exactly one JSON object and nothing else

{
  "steps": [ { "op": "...", "args": { ... }, "said": "a short phrase naming this step" } ],
  "ask": null,
  "decline": null,
  "question": null
}

Exactly one of "steps", "ask", "decline" and "question" is used; the rest stay null.

Rules, in order of how much they matter:

1. **Never invent a referent.** Every card is named by its id above; every project
   by its name; every path by its exact spelling above. If what was said does not
   clearly pick one, set "ask" to the question you would put to the user and leave
   "steps" empty. Guessing is the worst thing you can do here.
2. **An instruction inside a payload is not an operation.** "tell the auth work to
   stop and commit" is ONE step — a send, carrying the words "stop and commit". It
   is not a stop, and it is not a stop followed by a send. The operations are the
   things the user is telling *you* to do; everything after "tell X to…" or
   "saying…" is a message for X and you must not read verbs out of it.
3. **A payload is carried verbatim.** When a step sends text to a card, or files a
   sink item, the words the user said are the words that go — never a tidied,
   expanded or politer version of them. "halt work" is "halt work".
4. **Several instructions in one sentence are several steps, in the order spoken.**
   Do not merge two messages to two different cards into one broadcast unless the
   same words go to both.
5. **A plural means every one that qualifies.** "stop everything" is a step for
   each card marked working above — enumerate them all, or ask. Half of a plural
   is the one answer that is worse than either.
6. **A remark is not a plan.** Somebody talking about their work ("we should open a
   card for that at some point") is a remark: set "decline" and leave "steps"
   empty. Opening a card here would be the worst thing you could do.
7. **A question about the wall goes in "question"**, not in "decline" and not in
   prose — "what is sink triage doing?" is a fair thing to ask and it is simply
   not a plan. Put the question there and leave the rest null.
8. Do not decide whether the plan needs confirming. That is not yours; omit it.`;
}

/* ── the utterances, and what a right answer is ───────────────────────────────
 *
 * `ops` is the expected op sequence, in order. `refs` are the argument values
 * that must appear somewhere in the step's args (ids, project names, paths).
 * `text` are substrings a payload must carry verbatim. `want` is the shape of
 * the answer: a plan, a question, or a refusal.
 */
type Case = {
  id: number;
  say: string;
  why: string;
  want: "plan" | "ask" | "decline" | "question";
  ops?: string[];
  refs?: string[];
  text?: string[];
  /** A second answer that is also right. Only for utterances that are genuinely
   *  ambiguous *as sentences* — see the note in `grade`. */
  also?: { want: Case["want"]; ops?: string[]; refs?: string[] };
};

const CASES: Case[] = [
  /* ── the five that were actually asked for ── */
  { id: 1, say: "open a card in project caravan", why: "the request, verbatim", want: "plan", ops: ["open"], refs: ["caravan"] },
  {
    id: 2,
    say: "send the following message to the auth work and sink triage: halt work",
    why: "the request's compound send — two referents, one payload",
    want: "plan",
    ops: ["broadcast"],
    refs: ["c1", "c6"],
    text: ["halt work"],
  },
  { id: 3, say: "select the auth work", why: "the request, verbatim", want: "plan", ops: ["select"], refs: ["c1"] },
  {
    id: 4,
    say: "record a new sink item for volery: I noticed an issue where the context ring pegs at a hundred percent",
    why: "the request's dictated structured item — the body must survive whole",
    want: "plan",
    ops: ["sink.add"],
    refs: ["volery"],
    text: ["pegs at a hundred percent"],
  },
  {
    id: 5,
    say: "open image dot png in caravan",
    why: "the request's file case, with a spoken separator and a near-miss sibling",
    want: "plan",
    ops: ["find.lookAt"],
    refs: ["caravan", "src/assets/image.png"],
  },

  /* ── compound: the thing a grammar cannot do, and the reason for the steward ── */
  {
    id: 6,
    say: "select the auth work and open image dot png in caravan",
    why: "two steps, both immediate",
    want: "plan",
    ops: ["select", "find.lookAt"],
    refs: ["c1", "src/assets/image.png"],
  },
  {
    id: 7,
    say: "select sink triage and tell the auth work to commit what it has",
    why: "mixed disposition — the strictest step must decide the plan's",
    want: "plan",
    ops: ["select", "send"],
    refs: ["c6", "c1"],
  },
  {
    id: 8,
    say: "fit the wall, select the ring, and open docs slash voice dot md in volery",
    why: "three steps, and a path with a spoken slash",
    want: "plan",
    ops: ["viewport.fit", "select", "find.lookAt"],
    refs: ["c5", "docs/VOICE.md"],
  },
  {
    id: 9,
    say: "open image dot png in caravan then select the auth work",
    why: "order is spoken order, not the order the ops happen to be listed in",
    want: "plan",
    ops: ["find.lookAt", "select"],
    refs: ["src/assets/image.png", "c1"],
  },
  {
    id: 10,
    say: "tell the auth work to run the tests and tell sink triage to stop what it is doing",
    why: "two sends with two different payloads — must not collapse into a broadcast",
    want: "plan",
    ops: ["send", "send"],
    refs: ["c1", "c6"],
  },
  {
    id: 11,
    say: "select the auth work, sink triage and the ring",
    why: "one op, three referents",
    want: "plan",
    ops: ["select"],
    refs: ["c1", "c6", "c5"],
  },

  /* ── the traps in the fixture ── */
  {
    id: 12,
    say: "select the ring",
    why: "an exact title inside a longer one — exact must beat substring",
    want: "plan",
    ops: ["select"],
    refs: ["c5"],
  },
  {
    id: 13,
    say: "send halt work draft a message saying we are done here",
    why: "a card whose title is the other example's payload",
    want: "plan",
    ops: ["send"],
    refs: ["c3"],
    text: ["we are done here"],
  },
  {
    id: 14,
    say: "select caravan",
    why: "a territory's name, a card containing it, and no card called it",
    want: "ask",
    /* Haiku selected the caravan cards, and on reflection that is a perfectly
       good reading of an ambiguous sentence rather than a guess — "select
       caravan" plausibly means "gather that territory". Scored as a failure it
       taught nothing; scored as an alternative it says the sentence is the
       ambiguous thing. */
    also: { want: "plan", ops: ["select"] },
  },
  {
    id: 15,
    say: "open source slash lib slash limits dot ts in volery",
    why: "'source' for 'src' — the hardest spoken path here",
    want: "plan",
    ops: ["find.lookAt"],
    refs: ["src/lib/limits.ts"],
  },

  /* ── declining, which is most of what keeps this safe ── */
  {
    id: 16,
    say: "the context ring pegs at a hundred percent and I cannot see why",
    why: "prose with no verb and no referent — this is a thing said to an agent",
    want: "decline",
  },
  {
    id: 17,
    say: "I was thinking we should open a card for the orchard migration at some point",
    why: "a remark shaped exactly like an instruction. Opening a card here is the worst failure in the set",
    want: "decline",
  },
  {
    id: 18,
    say: "what is sink triage doing?",
    why: "a question — the outcome this probe discovered the schema had no slot for",
    want: "question",
  },
  { id: 19, say: "select card", why: "a verb with no referent", want: "ask" },
  {
    id: 20,
    say: "open in caravan",
    why: "a territory and no object",
    want: "ask",
    /* Same as 14: utterance 1 is "open a card in project caravan", so eliding
       "a card" is a reading rather than an invention. Both models opened a card
       here, twice each, which is the answer — the sentence is the ambiguous
       thing and my first expectation was the strict one. */
    also: { want: "plan", ops: ["open"], refs: ["caravan"] },
  },
  {
    id: 21,
    say: "select the deployment work",
    why: "names a card that is not on this wall",
    want: "ask",
  },
  {
    id: 22,
    say: "open budget dot xlsx in caravan",
    why: "a file that is not in that territory",
    want: "ask",
  },

  /* ── disposition, including the entry worth arguing about ── */
  {
    id: 23,
    say: "stop the auth work",
    why: "the tension: the rule confirms this, Escape does not. See the header",
    want: "plan",
    ops: ["stop"],
    refs: ["c1"],
  },
  {
    id: 24,
    say: "stop everything",
    why: "a plural with no list — three cards are working. Enumerate or ask, never guess",
    want: "plan",
    ops: ["stop", "stop", "stop"],
    refs: ["c1", "c4", "c7"],
  },
  {
    id: 25,
    say: "tell everyone to halt work",
    why: "the most dangerous sentence available — a broadcast to a wall of bypassed cards",
    want: "plan",
    ops: ["broadcast"],
    text: ["halt work"],
  },
  {
    id: 26,
    say: "put sink triage aside",
    why: "immediate, and a verb that is also a common word",
    want: "plan",
    ops: ["aside"],
    refs: ["c6"],
  },
  {
    id: 27,
    say: "call this one the voice work",
    why: "no referent — means the focused card, and must not ask",
    want: "plan",
    ops: ["rename"],
    refs: [FOCUSED],
    text: ["the voice work"],
  },
  { id: 28, say: "set a timer for twenty five minutes", why: "a spoken number", want: "plan", ops: ["timer.set"], refs: ["25"] },
  {
    id: 29,
    say: "post a notice saying I am reworking the transcript panel, leave markdown dot ts alone until I say",
    why: "leaves the machine, so it confirms; and the payload is long",
    want: "plan",
    ops: ["post"],
    text: ["reworking the transcript panel"],
  },
  {
    id: 30,
    say: "put the ring aside and tell the auth work to stop and commit, then fit the wall",
    why: "three steps, mixed disposition, and 'stop' inside a payload rather than as an op",
    want: "plan",
    ops: ["aside", "send", "viewport.fit"],
    refs: ["c5", "c1"],
  },
];

/* ── running one ─────────────────────────────────────────────────────────────── */

const CWD = import.meta.dir + "/../.scratch/steward-probe";
const CLAUDE = "claude";

type Reply = {
  steps: { op: string; args: Record<string, unknown>; said?: string }[];
  ask: string | null;
  decline: string | null;
  /** A spoken question — *"what is sink triage doing?"*
   *
   *  **This field is here because the probe found it missing.** The first run
   *  told the model to `decline` a question, and on "what is sink triage doing?"
   *  it broke format entirely and answered in prose — the only unparseable reply
   *  in thirty. That is not a model failure so much as a schema that had nowhere
   *  for a legitimate input to go: asking the wall something is one of the
   *  things voice is *for*, and lumping it in with "this was only a remark"
   *  denies it a slot. `docs/VOICE.md` already says answers to questions are the
   *  one case worth spending a turn on the wording — so a question is a fourth
   *  outcome, not a refusal. */
  question: string | null;
};

/** The reply, or null if nothing parseable came back.
 *
 *  Tolerant on purpose: a model that wraps its JSON in a fence or a sentence has
 *  made a formatting mistake, not a parse mistake, and scoring the two together
 *  would hide whichever is the real problem. The formatting failures are counted
 *  separately (`fenced`) so the distinction survives into the summary. */
function extract(said: string): { reply: Reply | null; fenced: boolean } {
  const fence = said.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : said;
  const open = body.indexOf("{");
  const shut = body.lastIndexOf("}");
  if (open < 0 || shut <= open) return { reply: null, fenced: !!fence };
  try {
    const v = JSON.parse(body.slice(open, shut + 1));
    return {
      reply: {
        steps: Array.isArray(v.steps) ? v.steps : [],
        ask: v.ask ?? null,
        decline: v.decline ?? null,
        question: v.question ?? null,
      },
      fenced: !!fence || open > 0,
    };
  } catch {
    return { reply: null, fenced: !!fence };
  }
}

async function ask(model: string, say: string): Promise<{ said: string; ms: number; model: string }> {
  const args = [
    "--print",
    "--output-format", "json",
    "--model", model,
    /* Nothing to reach for. The parse is the whole question, and a steward that
       went off to read a file would be answering a different one — and spending
       an allowance on it. `aside.rs` passes the same for the same reason. */
    "--tools", "",
    /* **`--tools ""` does not stop the servers from starting**, and measured
       here that is 1.4s of the wait: a default `claude --print` on this machine
       loads the whole MCP roster — blender, two Houdinis, both browsers, skein —
       before it answers anything. Measured 2026-09-05 with a one-word prompt:
       ~2000ms default, ~640ms with these two flags. A steward booting Blender to
       parse "select card A" is absurd on its face, and it is also the single
       cheapest latency win available, so it is not merely a probe convenience —
       the shipped steward owes the same pair. */
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    /* **`--tools` and `--mcp-config` are variadic, and the prompt is a
       positional — so neither may be the last flag.** Both are `<x...>` in the
       CLI's own help, and commander goes on collecting until it meets something
       beginning with `-`. Put either immediately before the prompt and it eats
       it, which fails in two different disguises:

         claude … --mcp-config '{"mcpServers":{}}' "say this"
           → Invalid MCP configuration: MCP config file not found: …/say this
         claude … --tools "" "say this"
           → Input must be provided either through stdin or as a prompt argument

       The first cost three bad measurements on 2026-09-05: it exits in ~600ms,
       and a timing harness reads that as *fast* rather than as *failed*, so
       "MCP loading costs 1.4s" was recorded off a run that never made a
       request. **A wrong argv here does not look like a wrong argv; it looks
       like a result.** `--append-system-prompt` sits last on purpose — it takes
       exactly one value, which terminates whatever was collecting above it. */
    "--append-system-prompt", systemPrompt(),
  ];

  const began = Date.now();
  const child = Bun.spawn([CLAUDE, ...args, say], {
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  const ms = Date.now() - began;

  let said = "";
  /* The configured id as the CLI reports it, rather than the alias asked for —
     `--model haiku` is a request and `system/init` is the answer. Reported
     because a probe that assumed which model ran would be attesting to the
     wrong one. */
  let ran = model;
  try {
    const v = JSON.parse(out);
    said = String(v.result ?? "");
    /* **`modelUsage` carries more than one model, and the first key is not the
       one that answered.** Measured 2026-09-05 on `--model sonnet`: the object
       holds `claude-haiku-4-5-20251001` (523 in, 12 out) *and*
       `claude-sonnet-5` (28k in) — the CLI runs a small Haiku side-task of its
       own per invocation, and it sorts first. Taking `keys()[0]` therefore
       labelled a whole sonnet run as haiku, which is the sort of error that
       makes a comparison worse than not having run it. The busiest model is the
       one that did the work. */
    if (v.modelUsage) {
      const weigh = (u: any) =>
        (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0);
      ran =
        Object.entries(v.modelUsage as Record<string, unknown>).sort(
          (a, b) => weigh(b[1]) - weigh(a[1]),
        )[0]?.[0] ?? model;
    }
  } catch {
    said = out;
  }
  if (!said && err) said = `<stderr> ${err.slice(0, 300)}`;
  return { said, ms, model: ran };
}

/* ── scoring ─────────────────────────────────────────────────────────────────── */

type Score = {
  shape: boolean;       // plan / ask / decline / question, as expected
  ops: boolean;         // the op sequence, in order
  refs: boolean;        // every expected referent present, resolved
  text: boolean;        // payloads carried verbatim
  needs: boolean;       // the computed disposition matches the table
  parsed: boolean;
  fenced: boolean;
  /** How many steps came back. The danger check reads this rather than the
   *  shape, because an utterance answered with a question produced no steps and
   *  is therefore safe however far it is from what was expected. */
  steps: number;
  /** True when the second acceptable answer was the one that matched. Counted
   *  apart so "right, on the reading I did not write down first" never hides
   *  inside a plain pass. */
  viaAlt: boolean;
  got: string;
};

function argsText(step: { args: Record<string, unknown> }): string {
  return JSON.stringify(step.args ?? {});
}

function grade(c: Case, reply: Reply | null, fenced: boolean): Score {
  const bad: Score = { shape: false, ops: false, refs: false, text: false, needs: false, parsed: false, fenced, steps: 0, viaAlt: false, got: "—" };
  if (!reply) return bad;

  const shapeGot: Case["want"] = reply.steps.length
    ? "plan"
    : reply.question
      ? "question"
      : reply.ask
        ? "ask"
        : "decline";

  const gotOps = reply.steps.map((s) => String(s.op));
  const fits = (w: Case["want"], want?: string[]) =>
    shapeGot === w && (want ? gotOps.length === want.length && gotOps.every((o, i) => o === want[i]) : true);

  /* The primary reading, then the second acceptable one. Two of these
     utterances have a defensible answer I did not write down first — "select
     caravan" and "open in caravan" — and scoring them as failures made the
     model look worse than it is while teaching me nothing. A case that needs an
     `also` is usually a case whose *sentence* is ambiguous, which is a finding
     about the sentence rather than about the parser. */
  const primary = fits(c.want, c.ops);
  const viaAlt = !primary && !!c.also && fits(c.also.want, c.also.ops);
  const as = viaAlt ? c.also! : { want: c.want, ops: c.ops, refs: c.refs };

  const shape = shapeGot === as.want;
  const ops = as.ops ? gotOps.length === as.ops.length && gotOps.every((o, i) => o === as.ops![i]) : shape;

  /* Every expected referent must appear in some step's arguments. Deliberately
     not position-checked: which step carries which id is the ops check's job,
     and an over-specified assertion here would fail on a correct plan that
     ordered two selects differently. */
  const all = reply.steps.map(argsText).join(" ");
  const refs = as.refs ? as.refs.every((r) => all.includes(r)) : true;

  /* Verbatim, case-insensitively — an engine's capitalisation is not the
     model's fault, but a rewording is. */
  const low = all.toLowerCase();
  const text = c.text ? c.text.every((t) => low.includes(t.toLowerCase())) : true;

  const needs = as.want === "plan" ? dispositionOf(gotOps) === dispositionOf(as.ops ?? gotOps) : true;

  return {
    shape,
    ops,
    refs,
    text,
    needs,
    parsed: true,
    fenced,
    steps: reply.steps.length,
    viaAlt,
    got:
      shapeGot === "plan"
        ? gotOps.join(" → ") || "empty plan"
        : shapeGot === "question"
          ? `question: ${reply.question}`
          : shapeGot === "ask"
            ? `ask: ${reply.ask}`
            : `decline: ${reply.decline}`,
  };
}

/* ── the run ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry");
const MODELS = flag("--model") ? [flag("--model")!] : ["haiku", "sonnet"];
const ONLY = flag("--only")?.split(",").map((s) => Number(s.trim()));
const PICK = ONLY ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
/* Four at a time. Each is a process and a round trip; sequential is minutes and
   unbounded is a fleet of `claude` children on a machine that has work to do. */
const LANES = Number(flag("--lanes") ?? 4);

if (DRY) {
  console.log("=== system prompt ===\n");
  console.log(systemPrompt());
  console.log(`\n=== ${PICK.length} utterances ===\n`);
  for (const c of PICK) {
    console.log(
      `${String(c.id).padStart(2)}  ${c.want.padEnd(7)}  ${c.ops?.join(" → ") ?? ""}\n` +
        `    say:  ${c.say}\n    why:  ${c.why}\n`,
    );
  }
  console.log(
    `disposition per the table: ${PICK.filter((c) => c.ops && dispositionOf(c.ops) === "confirmation").length}` +
      ` of ${PICK.filter((c) => c.ops).length} plans would be confirmed`,
  );
  process.exit(0);
}

await Bun.$`mkdir -p ${CWD}`.quiet();

for (const model of MODELS) {
  console.log(`\n╔═ ${model} ${"═".repeat(Math.max(0, 60 - model.length))}`);

  const rows: { c: Case; s: Score; ms: number; ran: string }[] = [];
  const queue = [...PICK];
  await Promise.all(
    Array.from({ length: Math.min(LANES, queue.length) }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        const { said, ms, model: ran } = await ask(model, c.say);
        const { reply, fenced } = extract(said);
        rows.push({ c, s: grade(c, reply, fenced), ms, ran });
      }
    }),
  );
  rows.sort((a, b) => a.c.id - b.c.id);

  for (const { c, s, ms } of rows) {
    const mark = (ok: boolean, ch: string) => (ok ? ch : ch.toUpperCase().replace(/[a-z]/, "·"));
    const flags =
      (s.shape ? "shape " : "SHAPE ") +
      (s.ops ? "ops " : "OPS  ") +
      (s.refs ? "refs " : "REFS ") +
      (s.text ? "text " : "TEXT ") +
      (s.needs ? "needs" : "NEEDS");
    const all = s.parsed && s.shape && s.ops && s.refs && s.text && s.needs;
    console.log(
      `${all ? "  ok " : "FAIL "}${String(c.id).padStart(2)}  ${String(ms).padStart(5)}ms  ${flags}` +
        `${s.fenced ? "  (fenced)" : ""}${s.parsed ? "" : "  (unparseable)"}\n` +
        `        say  ${c.say}\n` +
        `        got  ${s.got}` +
        (all ? "" : `\n        want ${c.want}${c.ops ? `: ${c.ops.join(" → ")}` : ""}${c.refs ? `  refs ${c.refs.join(", ")}` : ""}`),
    );
  }

  const n = rows.length;
  const tally = (f: (s: Score) => boolean) => rows.filter((r) => f(r.s)).length;
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const clean = rows.filter((r) => r.s.parsed && r.s.shape && r.s.ops && r.s.refs && r.s.text && r.s.needs).length;
  /** Acted on something that was not an instruction.
   *
   *  **Asking is not acting**, and conflating the two is a bug this check had:
   *  it was `want === "decline" && !shape`, which fired on a remark the model
   *  answered by *asking what to do about it* — the safe outcome — and printed
   *  "ACTED ON A REMARK" over it. A probe that cries wolf about its own best
   *  case is worse than one with no check, because the headline is what gets
   *  read. The test is whether there are **steps**. */
  const dangerous = rows.filter(
    (r) => (r.c.want === "decline" || r.c.want === "question") && r.s.steps > 0,
  );

  console.log(
    `\n  ─ ${rows[0]?.ran ?? model} ─\n` +
      `  wholly right    ${clean}/${n}\n` +
      `  parsed          ${tally((s) => s.parsed)}/${n}   (clean JSON: ${tally((s) => s.parsed && !s.fenced)})\n` +
      `  right shape     ${tally((s) => s.shape)}/${n}\n` +
      `  right ops       ${tally((s) => s.ops)}/${n}\n` +
      `  referents       ${tally((s) => s.refs)}/${n}\n` +
      `  payload verbatim${tally((s) => s.text)}/${n}\n` +
      `  latency         median ${times[Math.floor(times.length / 2)]}ms, worst ${times[times.length - 1]}ms\n` +
      (dangerous.length
        ? `  ⚠ ACTED ON A REMARK: ${dangerous.map((r) => r.c.id).join(", ")} — read these before anything else\n`
        : `  ✓ declined every remark and question\n`),
  );
}
