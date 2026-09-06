/* One fixture wall, and the utterances spoken at it.
 *
 * Shared on purpose, by the two things that grade a parse: `test/voice.test.ts`,
 * which scores the grammar rung, and `tools/probe-steward.ts`, which spends an
 * allowance scoring the model rung. **They must be scored against the same
 * wall**, because the whole design of `docs/VOICE.md` is a ladder — the grammar
 * answers what it can account for entirely and everything else escalates — and
 * two fixtures that had drifted apart would make the two rungs' results
 * incomparable, which is the only thing either number is for.
 *
 * Not a `.test.ts` file, so `bun test` never collects it and the `test` script
 * in `package.json` does not name it.
 *
 * ## The traps, so nobody removes one by tidying
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

import type { VoiceCard, VoiceTerritory, Wall } from "../../src/lib/voice";

export const TERRITORIES: VoiceTerritory[] = [
  {
    project: "caravan",
    cwd: "C:/work/caravan",
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
    project: "volery",
    cwd: "C:/atelier/skein",
    files: ["src/lib/limits.ts", "src/lib/skein.svelte.ts", "src/lib/tokens.css", "docs/VOICE.md"],
  },
  {
    project: "orchard",
    cwd: "C:/work/orchard",
    files: ["schema/001_init.sql", "src/index.ts"],
  },
];

export const CARDS: VoiceCard[] = [
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
export const FOCUSED = "c6";

export const WALL: Wall = { cards: CARDS, territories: TERRITORIES, focusedId: FOCUSED };

/* ── the utterances, and what a right answer is ───────────────────────────────
 *
 * `ops` is the expected op sequence, in order. `refs` are the argument values
 * that must appear somewhere in the step's args (ids, project names, paths).
 * `text` are substrings a payload must carry verbatim. `want` is the shape of
 * the answer: a plan, a question, or a refusal.
 */
export type Case = {
  id: number;
  say: string;
  why: string;
  want: "plan" | "ask" | "decline" | "question";
  ops?: string[];
  refs?: string[];
  text?: string[];
  /** A second answer that is also right. Only for utterances that are genuinely
   *  ambiguous *as sentences*. */
  also?: { want: Case["want"]; ops?: string[]; refs?: string[] };
};

export const CASES: Case[] = [
  /* ── the five that were actually asked for ── */
  {
    id: 1,
    say: "open a card in project caravan",
    why: "the request, verbatim",
    want: "plan",
    ops: ["open"],
    refs: ["caravan"],
  },
  {
    id: 2,
    say: "send the following message to the auth work and sink triage: halt work",
    why: "the request's compound send — two referents, one payload",
    want: "plan",
    ops: ["broadcast"],
    refs: ["c1", "c6"],
    text: ["halt work"],
  },
  {
    id: 3,
    say: "select the auth work",
    why: "the request, verbatim",
    want: "plan",
    ops: ["select"],
    refs: ["c1"],
  },
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
    why: "the tension: the rule confirms this, Escape does not",
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
  {
    id: 28,
    say: "set a timer for twenty five minutes",
    why: "a spoken number",
    want: "plan",
    ops: ["timer.set"],
    refs: ["25"],
  },
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
