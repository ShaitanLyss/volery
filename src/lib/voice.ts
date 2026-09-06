/* What was said, turned into a plan the wall can carry out.
 *
 * Pure, and deliberately the whole of the thinking. `docs/VOICE.md` decides
 * that **Rust owns audio → text and the wake gate, and everything from the text
 * onwards happens here** — not because the front end is written in TypeScript
 * but because *both ends of the parse already are*. The wall a referent
 * resolves against is front-end `$state` (card titles, `Region.project` → `cwd`,
 * and the file list `finding.md` says is "fetched once and scored here"), and
 * every step a plan produces lands on a `ControlHost` method. A parse in Rust
 * would need the wall shipped down to it and the plan shipped back up, twice
 * per utterance, to arrive at the same place.
 *
 * The one piece that genuinely belongs in Rust is Design 3's address gate —
 * matching *"caravan,"* against the closed set of handles, on every audio frame,
 * to decide whether anything goes up the pipe at all. That is a hot-path
 * closed-set match rather than a parse, and it belongs beside the recogniser.
 *
 * ## The two rungs, and the rule that decides which one answers
 *
 * `hear()` below is the **grammar**: the fast rung, for the gestures whose whole
 * value is being instant. It is small on purpose — eight verbs — because it is
 * not the product. Underneath it is the steward, a small model with the same
 * wall in its prompt, and the ladder only works because of one rule:
 *
 * > **The grammar answers only when it can account for the entire utterance.**
 *
 * That is `resolveCommand`'s *exact-and-whole* clause from `commands.md`, one
 * layer up, and it is here for the identical reason: reading `/clear` out of
 * `/clear the deck` throws away the rest of what was typed, and reading
 * `select card A` out of *"select card A and open image.png in caravan"* throws
 * away half a sentence — silently, which is the part that matters. So a partial
 * match is not a match, and everything the grammar does answer is complete.
 *
 * Most of that rule costs nothing to enforce, because the card resolver already
 * leans the safe way: its substring rung asks whether a *title contains the
 * query*, never the reverse, so a longer query never spuriously matches a
 * shorter title. "select the ring and fit the wall" finds no card, and escalates
 * by itself.
 *
 * ## What is not here, and is not an oversight
 *
 * **The grammar does not send.** No `send`, no `broadcast`, no `post`, no
 * `sink.add` — nothing that carries prose. Deciding where the referents stop and
 * the payload begins is precisely what a pattern is worst at and what a model is
 * for, and it is also the sentence where being wrong is worst: project cards
 * spawn with `--dangerously-skip-permissions`, so a misheard broadcast is the
 * most destructive thing this application can do. `payloadIn` is here to
 * *refuse* such an utterance, not to parse one.
 */

import { rank, splitPath } from "./finding";

/* ── the wall, as voice sees it ───────────────────────────────────────────────
 *
 * A read-only projection, not the real thing. `Conversation` carries dozens of
 * fields and a live event fold; a resolver needs three of them, and taking only
 * those is what keeps this module pure and its tests a fixture rather than an
 * app. The caller builds one of these per utterance.
 */

/** The least a thing must be to be findable by what somebody called it. */
export type Named = { id: string; title: string; project: string };

export type VoiceCard = Named & {
  /** Mid-turn. Only a plural needs it — *"stop everything"* means every card
   *  that is actually doing something, and a plan that stopped the idle ones
   *  too would be wrong in a way nobody would notice. */
  working: boolean;
};

export type VoiceTerritory = {
  /** The folder name, which is what a territory is called out loud. */
  project: string;
  /** Its root on disk, which is what `finder.lookAt` wants. */
  cwd: string;
  /** Every file under it, relative and forward-slashed, as `find.rs` reports
   *  them. Already in the front end — see `finding.md`. */
  files: string[];
};

export type Wall = {
  cards: VoiceCard[];
  territories: VoiceTerritory[];
  /** Which card is in front. Several sentences have no referent at all and mean
   *  "this one"; `#card()` already falls back to it and so does this. */
  focusedId: string | null;
};

/* ── one referent, resolved or honestly not ──────────────────────────────────
 *
 * Three outcomes, and the middle one is the reason this is not just `T | null`.
 * The steward prompt's first rule is *never invent a referent*, and a resolver
 * that collapsed "several things match" into "no match" would leave the caller
 * unable to tell "I have never heard of that" from "which one?" — different
 * things to say back, and only one of them worth offering a list for.
 */
export type Resolved<T> =
  | { kind: "found"; it: T }
  | { kind: "ambiguous"; among: T[] }
  | { kind: "missing"; said: string };

const found = <T,>(it: T): Resolved<T> => ({ kind: "found", it });
const ambiguous = <T,>(among: T[]): Resolved<T> => ({ kind: "ambiguous", among });
const missing = <T,>(said: string): Resolved<T> => ({ kind: "missing", said });

/** The one thing it resolved to, or null for either kind of failure. For the
 *  grammar, where anything short of certainty escalates and the difference
 *  between the two failures is the steward's problem rather than this rung's. */
export function certain<T>(r: Resolved<T>): T | null {
  return r.kind === "found" ? r.it : null;
}

/* ── spoken text, written down ────────────────────────────────────────────────
 *
 * An engine hands over separators as words. `docs/VOICE.md` records that this
 * matters less than it looks — `finding.ts::score()` treats a space in the query
 * as a term separator rather than as something to find, which is exactly the
 * shape a spoken path has, so `"image dot png"` often matches anyway. It
 * *misranks*, though, and a wrong file opened confidently is worse than a
 * question.
 */

/** Multi-word separator names, collapsed before the word walk below. */
const PHRASES: [string, string][] = [
  ["forward slash", "slash"],
  ["back slash", "backslash"],
  ["under score", "underscore"],
  ["full stop", "dot"],
];

/** One spoken word, one character. */
const SEPARATORS: Record<string, string> = {
  dot: ".",
  point: ".",
  period: ".",
  slash: "/",
  backslash: "/",
  dash: "-",
  hyphen: "-",
  underscore: "_",
};

/** A path as it was said, written the way it is spelled on disk.
 *
 *  **Only ever applied to a path query, never to prose**, and two of the steps
 *  below are only safe under that restriction: `dot` becomes `.`
 *  unconditionally, and a run of single letters is glued into a word so a
 *  spelled-out extension (*"P N G"*) survives. Run either over a sentence
 *  somebody meant literally and it mangles it. `payloadIn` is what keeps prose
 *  from ever arriving here.
 *
 *  Lowercase throughout, since speech has no case; every comparison downstream
 *  is lowercased to match, and the path handed back is the one on disk. */
export function spoken(said: string): string {
  let s = said.trim().toLowerCase();
  for (const [phrase, one] of PHRASES) s = s.split(phrase).join(one);

  const words = s.split(/\s+/).filter(Boolean);

  /* Spelled-out extensions, first: "image dot p n g" has to become "image.png"
     and not "image.p n g", which is what gluing the separators first would
     leave. A run of two or more single letters is the whole of the signal. */
  const glued: string[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && words[j].length === 1 && /[a-z]/.test(words[j])) j++;
    if (j - i >= 2) {
      glued.push(words.slice(i, j).join(""));
      i = j;
    } else {
      glued.push(words[i]);
      i++;
    }
  }

  const written = glued.map((w) => SEPARATORS[w] ?? w).join(" ");
  /* A separator binds to whatever is either side of it: "image . png" is one
     word. The character class ends in `-` so the dash is literal. */
  return written.replace(/\s*([./_-])\s*/g, "$1").trim();
}

/** Words an engine gives you for a segment that is spelled shorter on disk.
 *
 *  Exactly one entry, and it stays that way until a probe adds another. `src`
 *  is the case the steward probe names (utterance 15, *"open source slash lib
 *  slash limits dot ts"*), and it is unfindable without this: `src/lib/limits.ts`
 *  has no `o` in it at all, so no amount of fuzzy scoring recovers "source".
 *  Guessing at `library` → `lib` and `documents` → `docs` would be the
 *  restated-registry rot in miniature — a table nobody measured, drifting away
 *  from what an engine actually produces. */
const SPELT: Record<string, string> = { source: "src" };

/** The query with those substitutions applied. Tried *as well as* the literal
 *  transcription rather than instead of it, because a repository is entitled to
 *  a folder genuinely called `source` and the substitution must not be what
 *  makes it unfindable. */
export function spelt(query: string): string {
  return query
    .split("/")
    .map((seg) => SPELT[seg] ?? seg)
    .join("/");
}

/* ── a card ───────────────────────────────────────────────────────────────────
 *
 * Lifted out of `control.svelte.ts`'s `#card()`, which the control surface has
 * used since it was written and whose own comment says why it exists: *"Tests
 * read better as `{"card": "caravan"}` than as a pasted uuid."* That is the
 * sentence a voice layer would have written, so this is the same resolver rather
 * than a lookalike — `control.md`'s rule against a parallel path applies to a
 * lookup ladder as much as to a socket, and two five-rung ladders that must
 * agree are one ladder and one bug.
 *
 * Two things change in the lift, and both are what a channel with no case and no
 * screen needs: the rungs return **every** card at the winning tier rather than
 * the first, and an exact-but-for-case title is its own rung above the substring
 * one. `#card()` still takes `[0]` and behaves as it did; voice can tell "which
 * one?" from "never heard of it", which is the whole difference between asking
 * and guessing.
 */

export type CardMatch<T> = {
  /** Which rung answered. Earlier beats later and a rung is never mixed with
   *  the next — an exact title wins outright over the cards that merely contain
   *  the words, which is the `the ring` vs `fixing the ring occupancy bug`
   *  case. */
  by: "id" | "title" | "spoken" | "partial" | "project" | "index" | "focused";
  cards: T[];
};

/** Every card at the best rung that matched, or null.
 *
 *  `want` absent means the focused card, which is how *"call this one the voice
 *  work"* works without asking. A number indexes the wall as drawn — note it is
 *  **0-based**, which is what the code has always done and not what `#card()`'s
 *  comment claimed; the comment was wrong, the behaviour is what `wall.test.ts`
 *  drives, so the behaviour is what was kept. */
export function matchCards<T extends Named>(
  cards: T[],
  want: string | number | null | undefined,
  focusedId: string | null,
): CardMatch<T> | null {
  if (want === undefined || want === null || want === "") {
    const f = cards.find((c) => c.id === focusedId);
    return f ? { by: "focused", cards: [f] } : null;
  }
  if (typeof want === "number") {
    const c = cards[want];
    return c ? { by: "index", cards: [c] } : null;
  }

  const s = String(want).trim();
  const low = s.toLowerCase();
  const rungs: CardMatch<T>[] = [
    { by: "id", cards: cards.filter((c) => c.id === s) },
    { by: "title", cards: cards.filter((c) => c.title === s) },
    /* Exact but for case, above the substring rung rather than folded into it.
       A mouth produces no capitals, so without this every spoken title falls to
       a substring match and a card whose title is a prefix of another's could
       never be named out loud. Strictly better than what it sits above: an
       exact title is a better answer than a containment, whatever the case. */
    { by: "spoken", cards: cards.filter((c) => c.title.toLowerCase() === low) },
    { by: "partial", cards: cards.filter((c) => c.title.toLowerCase().includes(low)) },
    { by: "project", cards: cards.filter((c) => c.project.toLowerCase().includes(low)) },
  ];
  for (const rung of rungs) if (rung.cards.length) return rung;
  return null;
}

/** The rungs a *spoken* referent may be certain on.
 *
 *  The substring rungs are missing from this on purpose, and the case that
 *  settled it is in the fixture: `caravan` is a territory, and it is also a
 *  substring of the card titled `caravan onboarding copy`. `matchCards` answers
 *  that with exactly one card at the `partial` rung — perfectly reasonable for
 *  the control surface, where somebody *typed* an abbreviation on purpose and
 *  can see what came back — and catastrophic for voice, where "select caravan"
 *  would silently gather one card out of a territory of them.
 *
 *  So the ladder is one resolver and the trust in it is two. A partial match is
 *  still worth having: it becomes `ambiguous` rather than `missing`, which is
 *  what lets the caller offer a list instead of claiming never to have heard of
 *  the thing. It simply is not an answer. */
const TRUSTED = new Set<CardMatch<unknown>["by"]>(["id", "title", "spoken", "index", "focused"]);

/** One card, by what it was called out loud. */
export function resolveCard(wall: Wall, said: string | null): Resolved<VoiceCard> {
  const m = matchCards(wall.cards, said, wall.focusedId);
  if (!m) return missing(said ?? "");
  if (!TRUSTED.has(m.by)) return ambiguous(m.cards);
  return m.cards.length === 1 ? found(m.cards[0]) : ambiguous(m.cards);
}

/** Several cards, from one spoken list.
 *
 *  Splitting on "and" is safe here only because of the exact-and-whole rule:
 *  *"select the ring and fit the wall"* splits into a card and a piece that
 *  resolves to nothing, so the whole utterance fails to be accounted for and
 *  goes to the steward. A resolver that quietly dropped the unresolvable half
 *  would carry out one of two instructions, which `docs/VOICE.md` calls the one
 *  answer worse than either. */
export function resolveCards(wall: Wall, said: string): Resolved<VoiceCard>[] {
  return said
    .split(/\s*,\s*|\s+and\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolveCard(wall, p));
}

/* ── a territory ─────────────────────────────────────────────────────────────── */

/** Words that decorate a territory's name without being part of it. */
const TERRITORY_NOISE = /^(?:the\s+|project\s+|territory\s+|repo(?:sitory)?\s+)+/;

/** One territory, by its folder name. Cheap by design — `Region` in `layout.ts`
 *  already names a territory by folder and carries its root, so *"project
 *  caravan"* → `cwd` needs nothing that is not on the wall already. */
export function resolveTerritory(wall: Wall, said: string): Resolved<VoiceTerritory> {
  const low = said.trim().toLowerCase().replace(TERRITORY_NOISE, "").trim();
  if (!low) return missing(said);
  const exact = wall.territories.filter((t) => t.project.toLowerCase() === low);
  if (exact.length === 1) return found(exact[0]);
  if (exact.length > 1) return ambiguous(exact);
  const near = wall.territories.filter((t) => t.project.toLowerCase().includes(low));
  if (near.length === 1) return found(near[0]);
  if (near.length > 1) return ambiguous(near);
  return missing(said);
}

/* ── a file inside a territory ────────────────────────────────────────────────
 *
 * Three rungs, and **not one of them has a threshold in it**. That is the
 * decision worth defending. The obvious design is to score every path and take
 * the winner if it is far enough ahead of the runner-up, which needs a constant
 * nobody can justify and which turns "never invent a referent" into a number.
 * These rungs are structural instead: a basename that *is* what you said, a
 * basename that *contains* what you said, and — for everything else — no answer
 * at all, only a ranked list to ask with.
 *
 * The cost is real and it is the right way round: *"open the theme file"* asks
 * rather than guessing. There is already a fuzzy finder on this wall for when
 * fuzzy is what you want, and it is driven by a keyboard that can see the list.
 */

/** The pieces of a spoken path. Split on whitespace and both separators, but
 *  never on `.` — `image.png` is one term, and an extension is part of a name
 *  rather than a step along a path. */
function termsOf(query: string): string[] {
  return query
    .split(/[\s/\\]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Do these appear in this, in this order? */
function inOrder(hay: string, terms: string[]): boolean {
  let at = 0;
  for (const t of terms) {
    const i = hay.indexOf(t, at);
    if (i < 0) return false;
    at = i + t.length;
  }
  return true;
}

/** How many candidates an ambiguous answer offers to choose between. Small,
 *  because it is going to be *spoken*, and twenty read aloud is not a question
 *  anybody can answer. */
export const OFFERED = 5;

/** One file in a territory, by what it was called out loud. */
export function resolveFile(files: string[], said: string): Resolved<string> {
  const query = spoken(said);
  if (!query) return missing(said);

  /* The literal transcription and the substituted one, both, and the literal
     one first so a real `source/` folder still wins on a wall that has one. */
  const variants = [query, spelt(query)].filter((q, i, a) => a.indexOf(q) === i);
  const tries = variants.map(termsOf).filter((t) => t.length > 0);

  const base = (f: string) => splitPath(f).name.toLowerCase();

  /* Rung one and rung two differ in a single operator, and that is the whole of
     the idea: the basename either *is* the last thing you said or *contains*
     it, and everything before it has to turn up along the path in the order you
     said it. Both variants are tried at rung one before either reaches rung
     two, so a substitution that lands exactly beats a literal that only
     half-lands. */
  for (const terms of tries) {
    const last = terms[terms.length - 1];
    const hit = files.filter((f) => base(f) === last && inOrder(f.toLowerCase(), terms));
    if (hit.length === 1) return found(hit[0]);
    if (hit.length > 1) return ambiguous(hit);
  }
  for (const terms of tries) {
    const last = terms[terms.length - 1];
    const hit = files.filter((f) => base(f).includes(last) && inOrder(f.toLowerCase(), terms));
    if (hit.length === 1) return found(hit[0]);
    if (hit.length > 1) return ambiguous(hit);
  }

  /* Rung three never picks. `rank()` is here to furnish the question with
     candidates, not to answer it — and the spaces it is handed are the term
     separators its own scorer already expects, which is the coincidence
     `docs/VOICE.md` records. */
  const ranked = rank(files, termsOf(query).join(" "), OFFERED);
  return ranked.length ? ambiguous(ranked.map((r) => r.item)) : missing(said);
}

/* ── where the referents stop and the prose begins ───────────────────────────── */

/** What a person says just before they start dictating. */
const MARKS = [" with the words ", " that says ", " which says ", " saying ", " to say ", ":"];

/** The utterance split at its payload marker, or null if it carries no payload.
 *
 *  The grammar uses only the null answer — see the header. What is here for the
 *  steward's benefit is the *other* half of the contract, and it is a rule
 *  rather than a function: **a payload is carried verbatim**. The words that go
 *  to a card are the words that were said, never a tidied, expanded or politer
 *  version, and "halt work" is "halt work". A model asked to fill in a JSON
 *  field will improve prose given the slightest opening, so a payload is checked
 *  against the transcript rather than trusted. */
export function payloadIn(said: string): { head: string; payload: string } | null {
  const low = said.toLowerCase();
  let best: { at: number; len: number } | null = null;
  for (const m of MARKS) {
    const at = low.indexOf(m);
    if (at < 0) continue;
    /* Earliest wins, and the longest at that position — so "to say" is not read
       out of " that says " by accident. */
    if (!best || at < best.at || (at === best.at && m.length > best.len)) {
      best = { at, len: m.length };
    }
  }
  if (!best) return null;
  return {
    head: said.slice(0, best.at).trim(),
    payload: said.slice(best.at + best.len).trim(),
  };
}

/* ── a plan, and whether it may simply happen ─────────────────────────────────
 *
 * The unit is a plan and not an op, because "several commands in one" is the
 * thing being asked for. Everything about confirming is therefore about the
 * whole list: one confirm, decided by its strictest step. Confirming twice for
 * one sentence is how a person learns to stop using a feature.
 */

export type Step = {
  op: string;
  args: Record<string, unknown>;
  /** This step in a short phrase, for speaking back. */
  said: string;
};

export type Plan = {
  /** In order. A plan is ordered even when the ops commute — you said them in
   *  an order, and reading them back in another one is a plan you did not
   *  make. */
  steps: Step[];
  /** The whole plan in one sentence. Templated from the steps' own `said`,
   *  never composed by a model: a confirmation you have heard the same way
   *  fifty times is one you can act on without listening hard. */
  reads: string;
  /** The strictest disposition among the steps. */
  needs: "nothing" | "confirmation";
};

/** Ops that may simply happen, because all they change is how you are looking
 *  at the wall.
 *
 *  **This set is the complement of the undo stack, and that is the argument for
 *  it.** `undo.md` keeps the viewport and the selection off the stack on the
 *  grounds that they are *how you look* at the wall rather than changes to it —
 *  so the things voice may do without asking are exactly the things there would
 *  be nothing to take back from. Nothing is classified twice, and the two lists
 *  cannot drift into disagreeing about the same op.
 *
 *  Anything absent needs confirmation, so **a new op is confirmed by default** —
 *  the safe direction for a list somebody will extend without reading this.
 *
 *  `stop` is the entry worth arguing about, and it is deliberately not here. By
 *  the rule it confirms: it ends a turn, the undo stack refuses it, so voice
 *  asks. Against that, Escape stops a turn today with no confirmation at all,
 *  and "stop" is the one word you want to be instant when a card is going wrong.
 *  The counter is that a misheard "stop" is possible where a pressed Escape is
 *  not. This entry is a position, not a finding. */
export const IMMEDIATE = new Set([
  "focus",
  "select",
  "deselect",
  "find.lookAt",
  "viewport.fit",
  "rename",
  "aside",
  "timer.set",
]);

export function dispositionOf(ops: string[]): "nothing" | "confirmation" {
  return ops.every((o) => IMMEDIATE.has(o)) ? "nothing" : "confirmation";
}

/** The one way a plan is made.
 *
 *  Both derived fields are computed here rather than accepted from a caller,
 *  which is what stops a model from ever setting either. The steward is asked
 *  for steps and nothing else; `needs` is a table and `reads` is a template, and
 *  a reply that volunteered them would be ignored. */
export function planOf(steps: Step[]): Plan {
  return {
    steps,
    reads: steps.map((s) => s.said).join(", then ") || "nothing",
    needs: dispositionOf(steps.map((s) => s.op)),
  };
}

/* ── the grammar ──────────────────────────────────────────────────────────────
 *
 * Eight verbs, and it should stay about this size. What it is for is the
 * utterances that must not cost a round trip — the ones whose whole value is
 * being instant, where a two-second parse would make voice worse than the mouse
 * it replaces. Everything else has a steward underneath it, which is why
 * rigidity here stops being a cost.
 *
 * Note `stop` is in the grammar and *not* in `IMMEDIATE`. That is not an
 * inconsistency: how fast a plan is built and whether it may run unasked are
 * different questions. Saying "stop the auth work" should cost no round trip to
 * understand, and should still be confirmed before it happens.
 */

type Shape = "nothing" | "card" | "cards" | "territory" | "file-in-territory";

type Entry = {
  /** Spoken forms. Matched on whole words at the start of the utterance; the
   *  longest form matching anywhere in the table wins, so "open a card in
   *  caravan" is an `open` and not a `find.lookAt` of a file called "a card". */
  says: string[];
  op: string;
  takes: Shape;
  /** A word that must close the phrase and is not part of the referent — "put
   *  the ring **aside**". Required when present: without it there is no match at
   *  all, since "put the ring" on its own is not an instruction. */
  trail?: string[];
  /** May the referent be left out, and mean the focused card? */
  orFocused?: boolean;
  /** For the one op whose two directions share a verb shape. */
  args?: Record<string, unknown>;
};

const GRAMMAR: Entry[] = [
  {
    says: ["deselect", "let go", "let go of everything", "clear the selection"],
    op: "deselect",
    takes: "nothing",
  },
  {
    says: ["fit the wall", "fit everything", "show the whole wall", "fit"],
    op: "viewport.fit",
    takes: "nothing",
  },
  { says: ["select", "gather"], op: "select", takes: "cards" },
  { says: ["focus", "bring up", "show me"], op: "focus", takes: "card" },
  /* `stop` and not `halt`, though both are things people say. "halt work" is
     the payload in the user's own example — a message *sent* to a card — and a
     verb that is also somebody's most likely dictation is a verb worth not
     having. `stop` costs nothing to say instead. */
  { says: ["stop"], op: "stop", takes: "card", orFocused: true },
  { says: ["put", "set"], op: "aside", takes: "card", trail: ["aside", "by"], args: { aside: true } },
  { says: ["pick up", "bring back"], op: "aside", takes: "card", args: { aside: false } },
  {
    says: ["open a card in", "open a new card in", "open a card in project", "new card in"],
    op: "open",
    takes: "territory",
  },
  { says: ["open", "show", "look at"], op: "find.lookAt", takes: "file-in-territory" },
];

/** Trailing punctuation an engine sprinkles in is not part of what was said. */
function tidy(said: string): string {
  return said.trim().replace(/\s+/g, " ").replace(/[.?!,]+$/, "");
}

/** Does the utterance begin with this phrase, on a word boundary? */
function opens(low: string, phrase: string): boolean {
  if (!low.startsWith(phrase)) return false;
  const next = low[phrase.length];
  return next === undefined || next === " ";
}

/** The plan this utterance certainly means, or null — meaning *escalate*, never
 *  meaning *nothing*.
 *
 *  Every route out of here is either a complete plan or a null, and there is no
 *  third. A grammar that could half-understand would need somewhere to put the
 *  half, and where the half would go is what the exact-and-whole rule exists to
 *  prevent. */
export function hear(utterance: string, wall: Wall): Plan | null {
  const said = tidy(utterance);
  if (!said) return null;

  /* Anything carrying prose is the steward's, whatever verb it opens with. The
     grammar is not entitled to decide where a payload begins, and "select the
     auth work: halt work" is a sentence it must not half-read. */
  if (payloadIn(said)) return null;

  const low = said.toLowerCase();

  /* Longest verb phrase wins, across the whole table rather than within one
     entry — that is what puts "open a card in" above "open". */
  let best: { entry: Entry; phrase: string } | null = null;
  for (const entry of GRAMMAR) {
    for (const phrase of entry.says) {
      if (!opens(low, phrase)) continue;
      if (!best || phrase.length > best.phrase.length) best = { entry, phrase };
    }
  }
  if (!best) return null;

  const { entry } = best;
  let rest = said.slice(best.phrase.length).trim();

  if (entry.trail) {
    const hit = entry.trail.find((t) => rest.toLowerCase().endsWith(` ${t}`));
    if (!hit) return null;
    rest = rest.slice(0, rest.length - hit.length - 1).trim();
  }

  const extra = entry.args ?? {};

  switch (entry.takes) {
    case "nothing": {
      /* Leftover words are the whole point of the rule: "fit the wall then
         select the ring" is not a `viewport.fit`. */
      if (rest) return null;
      return planOf([{ op: entry.op, args: { ...extra }, said: best.phrase }]);
    }

    case "card": {
      if (!rest && !entry.orFocused) return null;
      const card = certain(resolveCard(wall, rest || null));
      if (!card) return null;
      const verb = entry.op === "aside" ? (extra.aside ? "put aside" : "pick up") : entry.op;
      return planOf([
        { op: entry.op, args: { card: card.id, ...extra }, said: `${verb} ${card.title}` },
      ]);
    }

    case "cards": {
      if (!rest) return null;
      const hit = resolveCards(wall, rest).map(certain);
      if (!hit.length || hit.some((c) => !c)) return null;
      const cards = hit as VoiceCard[];
      return planOf([
        {
          op: entry.op,
          args: { cards: cards.map((c) => c.id), ...extra },
          said: `${entry.op} ${cards.map((c) => c.title).join(" and ")}`,
        },
      ]);
    }

    case "territory": {
      const where = certain(resolveTerritory(wall, rest));
      if (!where) return null;
      return planOf([
        {
          op: entry.op,
          args: { project: where.project, cwd: where.cwd, ...extra },
          said: `open a card in ${where.project}`,
        },
      ]);
    }

    case "file-in-territory": {
      /* Split on the *last* " in ", so a file with "in" in its name survives.
         The territory has to resolve before the file can be looked for at all,
         since the candidate list belongs to the territory. */
      const at = rest.toLowerCase().lastIndexOf(" in ");
      if (at < 0) return null;
      const where = certain(resolveTerritory(wall, rest.slice(at + 4)));
      if (!where) return null;
      const path = certain(resolveFile(where.files, rest.slice(0, at)));
      if (!path) return null;
      return planOf([
        {
          op: entry.op,
          args: { project: where.project, cwd: where.cwd, path, ...extra },
          said: `open ${path} in ${where.project}`,
        },
      ]);
    }
  }
}
