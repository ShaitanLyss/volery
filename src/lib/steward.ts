/* The rung underneath the grammar: a small model, the wall in its prompt, and
 * every word of its reply treated as a proposal rather than as a decision.
 *
 * Pure. Nothing here spawns anything — this is the prompt that goes out, the
 * tolerant read of what comes back, and the validation that decides what a reply
 * is allowed to *become*. The spawning belongs to whatever owns a long-lived
 * `claude`, and it is the smaller half.
 *
 * ## Why the validation is the interesting part
 *
 * `tools/probe-steward.ts` measured the parse and it was good: Haiku 28/30,
 * Sonnet 27/30, and — the number that mattered — **zero acted on a remark or a
 * question across sixty utterances**, with seven written specifically to be
 * misread. That is a finding about a model on a Friday. It is not a safety
 * property, and treating it as one would be the whole mistake: a reply is
 * arriving from a process, over a pipe, and the wall it proposes to move holds
 * cards spawned with `--dangerously-skip-permissions`.
 *
 * So `understand()` re-checks everything the reply asserts that it is in a
 * position to check, against the same `Wall` the prompt was built from:
 *
 *  - **Every card is a live id.** The model is *given* the ids; anything else is
 *    an invention, not an ambiguity.
 *  - **Every path is a member of that territory's own file list**, verbatim. Not
 *    fuzzy — the list was in the prompt.
 *  - **Every payload appears in the utterance.** This is rule 3 of the prompt
 *    turned from an instruction into a check. A model asked to fill in a text
 *    field will improve prose given the slightest opening, and *"halt work"*
 *    becoming *"Please halt work when you can."* is a different message sent to
 *    a real agent under somebody else's name.
 *  - **Unknown args are dropped** rather than refused, since an arg no handler
 *    reads cannot do anything, and refusing on one would throw away a good plan.
 *  - **`needs` is never read**, because `planOf` computes it from the op names.
 *
 * ## The `said` field, which is a design rule the schema was quietly breaking
 *
 * The probe's schema asks the model for `said`, "a short phrase naming this
 * step" — and `Plan.reads` is built from the steps' `said`. So `reads` was
 * model-composed after all, which is exactly what `docs/VOICE.md` forbids and
 * for a stated reason: *a confirmation you have heard the same way fifty times
 * is one you can act on without listening hard.*
 *
 * The field is still in the schema and **its value is never read**. Kept because
 * the 28/30 was measured with it there and taking it out is an unmeasured change
 * to a prompt whose numbers are the reason for building this rung at all; a
 * short phrase naming the step is also plausibly the model doing itself some
 * good. Not read, because `phraseOf` is the one place that says how a step
 * sounds, and both rungs go through it.
 */

import {
  phraseOf,
  planOf,
  resolveCard,
  resolveTerritory,
  type Plan,
  type Step,
  type Wall,
} from "./voice";

/* ── the vocabulary the steward is given ──────────────────────────────────────
 *
 * Real ops, named as `control.svelte.ts` names them, with `find.lookAt` and
 * `sink.add` spelled as `docs/VOICE.md` proposes them (the first is
 * `find do=look-at` in the table today; the second does not exist yet and is the
 * one gap the design found).
 *
 * **Wider than what can be carried out, on purpose.** `voice.ts`'s `CARRIERS`
 * knows eight ops; this offers eighteen. A step the steward proposes and nothing
 * can run comes back from `carry` as `refused` with nothing having happened,
 * which is the honest answer — narrowing the vocabulary to what is wired would
 * instead have the model quietly re-plan a sentence into the ops it was allowed,
 * and *"close that card"* answered by selecting it is worse than *"nothing here
 * can close"*.
 */

export type Verb = {
  op: string;
  /** How its arguments are written in the prompt. */
  shape: string;
  /** One line, lowercase, in the wall's voice. */
  says: string;
  /** Arg names this op takes. Anything else the model sends is dropped. */
  args: string[];
  /** Args naming a card, which must each be an id on the wall. */
  cards?: string[];
  /** Args naming a territory, by folder name. */
  projects?: string[];
  /** Args naming a file inside the territory this step also names. */
  paths?: string[];
  /** Args that must appear in the utterance word for word — the payloads.
   *
   *  Deliberately not every text field. A `title` or a `subject` is a *summary*
   *  and composing one is the useful thing a model does here; a `body` or a
   *  `text` is somebody's words being carried somewhere, and improving those is
   *  putting words in their mouth. `rename`'s title is in this set because you
   *  said what to call it. */
  verbatim?: string[];
  /** Args that must be one of a fixed set. */
  choices?: Record<string, string[]>;
  /** Args that must be a positive number. */
  numbers?: string[];
};

export const VOCABULARY: Verb[] = [
  { op: "focus", shape: "{card}", says: "bring one card to the front", args: ["card"], cards: ["card"] },
  {
    op: "select",
    shape: "{cards: [...]}",
    says: "gather cards — the dock aims a prompt at these",
    args: ["cards"],
    cards: ["cards"],
  },
  { op: "deselect", shape: "{}", says: "let go of everything", args: [] },
  {
    op: "open",
    shape: "{project}",
    says: "open a NEW card in a territory",
    args: ["project"],
    projects: ["project"],
  },
  { op: "chat", shape: "{}", says: "open a new card with no project", args: [] },
  {
    op: "send",
    shape: "{card, text}",
    says: "send a prompt to one card",
    args: ["card", "text"],
    cards: ["card"],
    verbatim: ["text"],
  },
  {
    op: "broadcast",
    shape: "{cards: [...], text}",
    says: "send the same prompt to several cards",
    args: ["cards", "text"],
    cards: ["cards"],
    verbatim: ["text"],
  },
  {
    op: "stop",
    shape: "{card}",
    says: "end the turn a card is in the middle of",
    args: ["card"],
    cards: ["card"],
  },
  {
    op: "rename",
    shape: "{card, title}",
    says: "call a card something else",
    args: ["card", "title"],
    cards: ["card"],
    verbatim: ["title"],
  },
  {
    op: "clear",
    shape: "{card}",
    says: "end a card's session and give it a fresh one",
    args: ["card"],
    cards: ["card"],
  },
  { op: "close", shape: "{card}", says: "take a card off the wall", args: ["card"], cards: ["card"] },
  {
    op: "aside",
    shape: "{card, aside: true}",
    says: "put a card by, or pick it back up",
    args: ["card", "aside"],
    cards: ["card"],
  },
  {
    op: "find.lookAt",
    shape: "{project, path}",
    says: "open a file in the reading panel",
    args: ["project", "path"],
    projects: ["project"],
    paths: ["path"],
  },
  {
    op: "sink.add",
    shape: "{project, title, body, kind}",
    says: "file a finding in the wall's sink",
    args: ["project", "title", "body", "kind"],
    projects: ["project"],
    verbatim: ["body"],
    choices: { kind: ["note", "idea", "bug", "chore"] },
  },
  {
    op: "post",
    shape: "{subject, body}",
    says: "put a standing notice on the billboard",
    args: ["subject", "body"],
    verbatim: ["body"],
  },
  { op: "viewport.fit", shape: "{}", says: "fit the whole wall in the window", args: [] },
  {
    op: "timer.set",
    shape: "{minutes, label}",
    says: "set a countdown",
    args: ["minutes", "label"],
    numbers: ["minutes"],
  },
  {
    op: "answer",
    shape: "{card, text}",
    says: "answer a question a card has parked",
    args: ["card", "text"],
    cards: ["card"],
    verbatim: ["text"],
  },
];

const VERB = new Map(VOCABULARY.map((v) => [v.op, v]));

/* ── the prompt ─────────────────────────────────────────────────────────────── */

/** How wide the two left columns are.
 *
 *  **Fixed, not derived from the longest entry, and that is the whole reason
 *  they are constants.** A derived width means adding one op reflows every line
 *  of the table — so a nineteenth verb would silently change all eighteen lines
 *  of a prompt whose 28/30 is the reason this rung exists, and the diff would
 *  look like whitespace rather than like a re-measurement. These are the widths
 *  that were measured. An op longer than `OP_W` overflows its own row and
 *  nobody else's, which `sink.add`'s shape already does. */
const OP_W = 13;
const SHAPE_W = 22;

/** The op table, as the model reads it. Padded so it scans as a table, which is
 *  cheap and is the difference between eighteen lines of prose and eighteen
 *  lines of reference. */
function opTable(): string {
  return VOCABULARY.map(
    (v) => `${v.op.padEnd(OP_W)}${v.shape.padEnd(SHAPE_W)}  ${v.says}`,
  ).join("\n");
}

/** What the steward is told, built from the wall it is being asked about.
 *
 *  **This is the prompt `tools/probe-steward.ts` measures**, imported rather
 *  than restated — which is the whole reason it moved here. A probe scoring a
 *  prompt only the probe has is a number about nothing, and that was the state
 *  of it until this file existed. The eight rules below are in the order they
 *  matter, and rules 2 and 5 were worth five whole cases between them: read the
 *  probe's header before rewording any of them. */
export function stewardPrompt(wall: Wall): string {
  const cards = wall.cards
    .map(
      (c) =>
        `  ${c.id}  "${c.title}"  in ${c.project}${c.working ? "  (working)" : ""}${
          c.id === wall.focusedId ? "  ← focused" : ""
        }`,
    )
    .join("\n");

  const territories = wall.territories
    .map((t) => `  ${t.project}  →  ${t.cwd}\n${t.files.map((f) => `      ${f}`).join("\n")}`)
    .join("\n");

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

${opTable()}

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

/* ── reading the reply ──────────────────────────────────────────────────────── */

export type Reply = {
  steps: { op: string; args: Record<string, unknown>; said?: string }[];
  ask: string | null;
  decline: string | null;
  /** A spoken question — *"what is sink triage doing?"*
   *
   *  **This field exists because the probe found it missing.** The first run told
   *  the model to `decline` a question, and on "what is sink triage doing?" it
   *  broke format entirely and answered in prose — the only unparseable reply in
   *  thirty. That is a schema with nowhere for a legitimate input to go rather
   *  than a model failure: asking the wall something is one of the things voice
   *  is *for*, and lumping it in with "this was only a remark" denies it a slot. */
  question: string | null;
};

/** The reply, or null if nothing parseable came back.
 *
 *  Tolerant on purpose: a model that wraps its JSON in a fence or a sentence has
 *  made a formatting mistake, not a parse mistake, and scoring the two together
 *  would hide whichever is the real problem. `fenced` carries the distinction out
 *  so a caller can count them separately. */
export function replyIn(said: string): { reply: Reply | null; fenced: boolean } {
  const fence = said.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : said;
  const open = body.indexOf("{");
  const shut = body.lastIndexOf("}");
  if (open < 0 || shut <= open) return { reply: null, fenced: !!fence };
  try {
    const v = JSON.parse(body.slice(open, shut + 1)) as Record<string, unknown>;
    return {
      reply: {
        steps: Array.isArray(v.steps) ? (v.steps as Reply["steps"]) : [],
        ask: (v.ask as string) ?? null,
        decline: (v.decline as string) ?? null,
        question: (v.question as string) ?? null,
      },
      fenced: !!fence || open > 0,
    };
  } catch {
    return { reply: null, fenced: !!fence };
  }
}

/* ── deciding what it is allowed to become ──────────────────────────────────── */

export type Understood =
  | { kind: "plan"; plan: Plan }
  /** The sentence was ambiguous and the model wants to know which. */
  | { kind: "ask"; question: string }
  /** A fair question about the wall, which is simply not a plan. */
  | { kind: "question"; question: string }
  /** A remark, not an instruction. */
  | { kind: "decline"; why: string }
  /** The reply itself cannot be used, and `why` says how. Never a plan, never
   *  partly a plan. */
  | { kind: "unusable"; why: string };

/** The words the payload must be found in, loosened only in the ways speech is.
 *
 *  Case goes, because a mouth has none and a model will capitalise a sentence.
 *  Whitespace collapses, because a transcript's spacing is not a fact about what
 *  was said. Trailing punctuation goes for the same reason. Nothing else: a word
 *  added, removed or reordered is a different message. */
function loosely(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.?!,;:]+$/, "");
}

/** Turn a reply into the one thing it is allowed to be.
 *
 *  Order matters, and the first rule is the one worth stating: **when a reply
 *  contradicts itself, the field that does nothing wins.** A model that both
 *  proposed steps and filled in `decline` has given two answers, and the safe
 *  reading of "I am not sure this was an instruction" is not to act. Acting on a
 *  remark is the worst failure available here; declining a real instruction
 *  costs you saying it again. */
export function understand(
  reply: Reply | null,
  utterance: string,
  wall: Wall,
): Understood {
  if (!reply) return { kind: "unusable", why: "nothing parseable came back" };

  if (reply.decline) return { kind: "decline", why: reply.decline };
  if (reply.question) return { kind: "question", question: reply.question };
  if (reply.ask) return { kind: "ask", question: reply.ask };
  if (!reply.steps.length) return { kind: "unusable", why: "a reply with nothing in it" };

  const heard = loosely(utterance);
  const steps: Step[] = [];

  for (const raw of reply.steps) {
    const verb = VERB.get(String(raw.op));
    if (!verb) return { kind: "unusable", why: `no such operation as "${raw.op}"` };

    const given = (raw.args ?? {}) as Record<string, unknown>;
    /* Only the names the verb declares. An arg nothing reads cannot do
       anything, so this is a filter and not a complaint. */
    const args: Record<string, unknown> = {};
    for (const name of verb.args) if (given[name] !== undefined) args[name] = given[name];

    for (const name of verb.cards ?? []) {
      const want = args[name];
      if (want === undefined) continue;
      const ids = Array.isArray(want) ? want : [want];
      if (!ids.length) return { kind: "unusable", why: `${verb.op} with no card` };
      for (const id of ids) {
        /* By id and by id alone. The model is handed the ids, so a title here is
           not a near miss to be resolved — it is the one rule of the prompt not
           being followed, and resolving it would hide that. */
        if (!wall.cards.some((c) => c.id === id)) {
          return { kind: "unusable", why: `no card ${JSON.stringify(id)} on this wall` };
        }
      }
      args[name] = Array.isArray(want) ? ids : ids[0];
    }

    for (const name of verb.projects ?? []) {
      const want = args[name];
      if (want === undefined) continue;
      const where = resolveTerritory(wall, String(want));
      if (where.kind !== "found") {
        return { kind: "unusable", why: `no territory called ${JSON.stringify(want)}` };
      }
      args[name] = where.it.project;
      /* The hands take a root, so carry both — the name is what gets spoken and
         the root is what gets used, and deriving one from the other at the point
         of use would put a second lookup somewhere it can fail silently. */
      args.cwd = where.it.cwd;
    }

    for (const name of verb.paths ?? []) {
      const want = args[name];
      if (want === undefined) continue;
      const cwd = args.cwd;
      const where = wall.territories.find((t) => t.cwd === cwd);
      if (!where) return { kind: "unusable", why: `a path with no territory to find it in` };
      /* Membership, not scoring. The whole list was in the prompt. */
      if (!where.files.includes(String(want))) {
        return {
          kind: "unusable",
          why: `no file ${JSON.stringify(want)} in ${where.project}`,
        };
      }
    }

    for (const name of verb.verbatim ?? []) {
      const want = args[name];
      if (want === undefined) continue;
      if (!heard.includes(loosely(String(want)))) {
        /* Rule 3 as a check rather than as an instruction. A model asked to fill
           in a text field will improve prose given the slightest opening, and a
           tidied message is a different message sent to a real agent under
           somebody else's name. */
        return {
          kind: "unusable",
          why: `${verb.op} would send words that were not said: ${JSON.stringify(want)}`,
        };
      }
    }

    for (const [name, allowed] of Object.entries(verb.choices ?? {})) {
      const want = args[name];
      if (want === undefined) continue;
      if (!allowed.includes(String(want))) {
        return { kind: "unusable", why: `${verb.op} ${name} cannot be ${JSON.stringify(want)}` };
      }
    }

    for (const name of verb.numbers ?? []) {
      const want = Number(args[name]);
      if (args[name] === undefined) continue;
      if (!Number.isFinite(want) || want <= 0) {
        return { kind: "unusable", why: `${verb.op} ${name} cannot be ${JSON.stringify(args[name])}` };
      }
      args[name] = want;
    }

    /* `raw.said` is not read. See the header. */
    steps.push({ op: verb.op, args, said: phraseOf(verb.op, args, wall) });
  }

  /* And `needs` is not read either: `planOf` is the only thing that decides it,
     from the op names, by the complement of the undo stack. */
  return { kind: "plan", plan: planOf(steps) };
}

/** Ops the steward may propose that nothing on the wall can carry out yet.
 *
 *  Here rather than in a test so it can be *reported* — the gap is a real state
 *  of the app, not a defect, and the honest thing is to be able to say which
 *  sentence fell into it. See `resolveCard`, which the plural rules lean on. */
export function unwired(carriable: (op: string) => boolean): string[] {
  return VOCABULARY.map((v) => v.op).filter((op) => !carriable(op));
}

/** The cards a plural applies to, for the one rule the prompt cannot enforce.
 *
 *  Rule 5 — *a plural means every one that qualifies* — is the rule most likely
 *  to be half-obeyed, and "stop everything" answered with two of the three
 *  working cards is the one answer `docs/VOICE.md` calls worse than either. This
 *  is what a caller checks it against. Deliberately not applied inside
 *  `understand`: a sentence may legitimately name a subset, and only the caller
 *  knows whether "everything" was said. */
export function working(wall: Wall): string[] {
  return wall.cards.filter((c) => c.working).map((c) => c.id);
}

/** A referent's resolution, exposed so a caller can build the question the
 *  model's `ask` was too vague to be. Re-exported rather than reimplemented. */
export { resolveCard };
