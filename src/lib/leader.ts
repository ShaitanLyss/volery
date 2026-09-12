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
export type Verb =
  | { kind: "find"; mode: FindMode }
  | { kind: "toy"; toy: ToyId };

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
