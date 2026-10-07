/* The space leader, and the table of what it opens onto.
 *
 * This was `finding.ts`'s, and lived there for as long as the finder was its
 * only client. The moment a second thing wanted a chord that reasoning stopped
 * holding: the leader is a gesture the *wall* answers, and a machine that
 * returns a `FindMode` is a machine that can only ever reach one panel. So it
 * is hoisted here, the table's value is a verb rather than a mode, and
 * `finding.ts` keeps the part that is genuinely about finding.
 *
 * Nothing else changed, deliberately — every rule below is nvim's, was argued
 * once already in `.claude/rules/finding.md`, and is repeated here rather than
 * pointed at because this is now the file that owns it.
 *
 * Pure, tested directly in `test/leader.test.ts`. Nothing here knows that a
 * panel exists, which is the whole point of the verb.
 */

import type { FindMode } from "./finding";
import type { ToyId } from "./synth";
import type { ToyId as PuzzleId } from "./gate";

/** The leader key, and it is the space bar because that is where these hands
 *  learned it (nvchad). It is free on this wall for one reason worth stating:
 *  the wall routes a bare printable key into the focused card's draft, and a
 *  prompt never *begins* with a space — by the time a space is a space you are
 *  already typing, focus is in the field, and that branch no longer fires. */
export const LEADER = " ";

/** How long a half-typed chord stands before it is forgotten. nvim's
 *  `timeoutlen` default, and it is a real bound rather than a nicety: a leader
 *  that never lapsed would make the *next* letter you typed on the wall an
 *  hour later part of a sequence you had forgotten opening. */
export const LAPSE_MS = 1000;

/** What a completed chord asks for.
 *
 *  A union rather than a string, because the two arms carry different things
 *  and the dispatcher should not be parsing names. Adding a third kind is a
 *  member here, a row in `CHORDS`, and an arm wherever the wall dispatches —
 *  the machine below still learns none of them. */
/** Everything on the shelf.
 *
 *  Two vocabularies, deliberately joined here rather than merged: `synth.ts`
 *  owns what an instrument is and `gate.ts` owns what a puzzle is, and neither
 *  has any business knowing the other exists. What they have in common is only
 *  that both are things to do with your hands, which is a fact about the
 *  *shelf* — so the shelf is where it is stated. */
export type ShelfId = ToyId | PuzzleId;

export type Verb =
  | { kind: "find"; mode: FindMode }
  | { kind: "toy"; toy: ShelfId }
  | { kind: "open"; what: "timelines" | "pile" | "flyway" }
  | { kind: "window"; act: "span" | "panel" | "dock" }
  | { kind: "presence"; act: "toggle" }
  | { kind: "grouping"; act: "new" | "rename" }
  | { kind: "sink"; act: "open" | "drop" };

/** One sequence the leader opens onto.
 *
 *  `label` is the hint's, and it lives beside the chord rather than in the
 *  component so that a new chord cannot ship without one — which is exactly
 *  how the finder's hint came to carry a ternary over its two modes, a shape
 *  with nowhere for a third to go. */
export type Chord = { keys: string; label: string; verb: Verb };

/** Every sequence, in one table.
 *
 *  `f` is nvchad's, and unchanged: `ff` finds a file by name, `fw` searches for
 *  a word. `t` is the toy shelf — things to do with your hands while an agent
 *  is working, which are deliberately *namespaced* rather than each taking a
 *  letter off the top: a second toy should cost a row here and nothing else,
 *  and the which-key hint after `<space>t` is then the shelf you are reading.
 *
 *  An array rather than a record because order and label are part of the
 *  contract — `offers` sorts, but the type is what stops a chord arriving
 *  without a word for what it does. */
export const CHORDS: readonly Chord[] = [
  { keys: "ff", label: "find file", verb: { kind: "find", mode: "files" } },
  { keys: "fw", label: "grep", verb: { kind: "find", mode: "grep" } },
  { keys: "ts", label: "synth", verb: { kind: "toy", toy: "synth" } },
  /* The puzzles the away gate puts in your way, available without being away.
     They were built to mark a boundary on the way back to work, and that is a
     worse reason to meet one than simply wanting to: a word you cannot get is
     a fine thing to be doing while a card thinks, and the whole argument for
     this shelf is that it is where the hands go while something else runs.
     Four rows here is what `toys.md` asks of a second toy, four times over, and
     it costs nothing else — the gate surface already draws all of them.

     `tk` for croquis is the one letter that is not a mnemonic: `tc` is the
     casse-tête and `td` the dérivée, both of which earned theirs first. The
     hint carries the label beside the chord, which is what that is for. */
  { keys: "tm", label: "motus", verb: { kind: "toy", toy: "motus" } },
  { keys: "td", label: "dérivée", verb: { kind: "toy", toy: "calculus" } },
  { keys: "tc", label: "casse-tête", verb: { kind: "toy", toy: "rotate" } },
  { keys: "tk", label: "croquis", verb: { kind: "toy", toy: "sketch" } },
  /* `a` for the archive: one letter, because it is a place you go rather than
     a family of things, and nothing else here begins with it. */
  { keys: "a", label: "archived timelines", verb: { kind: "open", what: "timelines" } },
  /* `p` for the pile of questions that built up while you were away. One
     letter, on the same argument `a` makes — a place you go rather than a
     family of things, and nothing else here begins with it. `q` was the
     obvious letter and is deliberately left free: `test/leader.test.ts` spends
     it as its example of a key that completes no chord, after nvim, where
     `<space>q` leaves you holding a `q`.

     It is not in the `i` family with `ia`, and that is not arbitrary: `i` is
     *"I'm …"*, a claim about where you are, and this is not one. It is also
     deliberately not a second spelling of `z` — coming back and reading the
     pile were one gesture for as long as the pile could only be opened by
     coming back, which is the gap this closes. */
  { keys: "p", label: "questions that piled up", verb: { kind: "open", what: "pile" } },
  /* `k` for the wall key: a place you go, on `a`'s argument, and the key is the
     whole of what a flyway is — starting, joining and leaving all happen in the
     one panel it opens. */
  { keys: "k", label: "flyway key", verb: { kind: "open", what: "flyway" } },
  /* `w` is the window, after nvim's `<C-w>` family: what the studio window
     itself does rather than anything on the wall. A family rather than a
     letter, because placing a window is several verbs (maximise, minimise,
     which screen) and they want to sit together in the hint. */
  /* `s` is the sink, and it is a family rather than a letter because there are
     two gestures and they are nothing alike: *read the pile* and *add to it*.
     `ss` is the family's main verb, after `ff` — doubling the family letter for
     the thing you mostly came for is nvchad's shape and is already the one
     taught by the finder.

     The sink has no chord before this at all: `Basin.svelte` is a *widget*, so
     the only way to read the pile was to hang one on the wall, and the only way
     to add to it by hand was to find that widget first. Both of those are the
     wrong shape for the moment they are wanted — you are in the middle of
     something else, and the whole value of writing a finding down is that it
     costs nothing to do and nothing to come back from. */
  { keys: "ss", label: "the sink", verb: { kind: "sink", act: "open" } },
  { keys: "sd", label: "drop something in the sink", verb: { kind: "sink", act: "drop" } },
  { keys: "ws", label: "every screen / one screen", verb: { kind: "window", act: "span" } },
  /* `g` is the grouping family — how this folder's work is arranged on the
     wall, which is what v42 made a thing you can have more than one of. A
     family rather than two letters off the top, per the rule above the table:
     making one and naming one are two verbs about the same noun and want to
     sit together in the hint, and a third (moving a card into one) has
     somewhere to go when it earns a chord of its own.

     Both act on the focused card's territory, since that is the one thing the
     wall always knows you mean — the same target `/rename` takes. */
  /* And where the two things you work *in* are moored. A chord cannot point at
     a place on the screen, so each cycles its three sites — starting from the
     edge that surface has always had, so going round the ring puts you back
     without having to remember which way it goes. See `berth.ts`. */
  { keys: "gn", label: "another grouping here", verb: { kind: "grouping", act: "new" } },
  { keys: "gr", label: "rename this grouping", verb: { kind: "grouping", act: "rename" } },
  { keys: "wp", label: "panel: right / left / floating", verb: { kind: "window", act: "panel" } },
  { keys: "wd", label: "dock: bottom / top / floating", verb: { kind: "window", act: "dock" } },
  /* Away mode, and it has two chords on purpose. `z` is the one you reach for
     — one key, zzz, and nothing else here begins with it. `ia` is the one you
     *think of*: "I'm away" is what the thing is called in the user's own
     words, and a chord you can derive from the name is one you do not have to
     have learned. They are the same verb, which is what makes a second spelling
     cost a row here and nothing else.

     The `i` family has no other member yet. That is fine — `t` was a family of
     one for a while too, and a letter spent on a family is spent once. */
  { keys: "z", label: "away / back", verb: { kind: "presence", act: "toggle" } },
  { keys: "ia", label: "I'm away / back", verb: { kind: "presence", act: "toggle" } },
];

/** What a keypress did to the leader sequence.
 *
 *  `swallow` is the field the caller actually acts on, and it is separate from
 *  the kind because the two questions are separate: *what happened* and *whose
 *  key was that*. A `lapse` is the case that makes it worth having — the key
 *  that ends a sequence without completing one is **not** ours, and has to go
 *  on to whatever would have had it. That is what nvim does with `<space>q`:
 *  the space did nothing and the `q` is still a `q`. A wall that ate it
 *  instead would be one where a letter occasionally vanished. */
export type Step =
  /** No sequence was open and this was not the leader. Nothing to do. */
  | { kind: "idle"; open: null; swallow: false }
  /** A modifier pressed on its own. Nothing changed, in either direction. */
  | { kind: "held"; open: string | null; swallow: false }
  /** The leader itself. A sequence is now open. */
  | { kind: "leader"; open: string; swallow: true }
  /** A prefix of something. Keep waiting. */
  | { kind: "pending"; open: string; swallow: true }
  /** A sequence completed. */
  | { kind: "fire"; open: null; swallow: true; verb: Verb }
  /** A sequence was open and this key is not in any of them. The sequence is
   *  abandoned and the key belongs to somebody else — except for Escape, which
   *  is the one key that means "forget it" and is therefore swallowed. */
  | { kind: "lapse"; open: null; swallow: boolean };

/** Keys that are somebody pressing a modifier and nothing else.
 *
 *  They have to leave a sequence exactly as it was, which is not obvious until
 *  it bites: every one of them fires its own keydown, so without this a hand
 *  brushing Shift between the leader and the letter would abandon the chord —
 *  and, worse, `<space>` then `Shift+F` (which is how a Caps-Locked keyboard
 *  types it) would never fire at all. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

/** Step the leader machine.
 *
 *  `open` is the letters typed since the leader, or null when no sequence is
 *  open. `sinceMs` is how long ago the last of them was pressed — passed in
 *  rather than read from a clock, so the lapse is part of the rule tested here
 *  rather than a `setTimeout` somewhere that nothing can see.
 *
 *  Note the lapse is checked *before* the key is read, and then the key is
 *  reconsidered from scratch. That matters for one case: pressing the leader,
 *  waiting, and pressing the leader again has to open a fresh sequence rather
 *  than be read as `<space><space>`. */
export function chord(open: string | null, key: string, sinceMs = 0): Step {
  if (MODIFIERS.has(key)) return { kind: "held", open, swallow: false };
  if (open !== null && sinceMs > LAPSE_MS) open = null;

  if (open === null) {
    if (key === LEADER) return { kind: "leader", open: "", swallow: true };
    return { kind: "idle", open: null, swallow: false };
  }

  /* The one key that closes a sequence and is still ours. Everything else that
     fails to match falls through to the wall, but Escape means "I did not mean
     to start this" and letting it also deselect a card would be one press
     doing two things. */
  if (key === "Escape") return { kind: "lapse", open: null, swallow: true };

  /* Modifiers and named keys are not letters in a chord. They abandon the
     sequence rather than extending it with the word "Shift". */
  if (key.length !== 1) return { kind: "lapse", open: null, swallow: false };

  /* Pressing the leader again inside a sequence restarts it, which is what the
     hand means: you have lost your place and are starting over. */
  if (key === LEADER) return { kind: "leader", open: "", swallow: true };

  const next = open + key.toLowerCase();
  const hit = CHORDS.find((c) => c.keys === next);
  if (hit) return { kind: "fire", open: null, swallow: true, verb: hit.verb };
  if (CHORDS.some((c) => c.keys.startsWith(next))) {
    return { kind: "pending", open: next, swallow: true };
  }
  return { kind: "lapse", open: null, swallow: false };
}

/** What the hint under a half-typed chord offers.
 *
 *  Which-key, in one line and without a plugin. It exists because a leader
 *  sequence is the one gesture on this wall with *no* affordance at all —
 *  every other binding is either on a button or in a tooltip, and a chord you
 *  have half-forgotten is otherwise something you have to read the source for.
 *
 *  Returns the completions of `open`, as the remaining letters and what they
 *  do, in a stable order so the hint does not reshuffle under your hand.
 *
 *  The remainder is given whole rather than collapsed to its next letter. That
 *  is the right call at this size and would stop being one: a flat list reads
 *  perfectly at half a dozen chords and becomes a wall of them at thirty, at
 *  which point the shelf wants folding by its head letter. The table is the
 *  thing to watch — when `t` carries five toys, this is the function that
 *  changes, and nothing else has to. */
export function offers(open: string): { keys: string; label: string }[] {
  return CHORDS.filter((c) => c.keys.startsWith(open) && c.keys.length > open.length)
    .map((c) => ({ keys: c.keys.slice(open.length), label: c.label }))
    .sort((a, b) => (a.keys < b.keys ? -1 : a.keys > b.keys ? 1 : 0));
}
