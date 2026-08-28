/* How the transcript column is grouped into blocks.
 *
 * A round is mostly machinery. An agent reads six files, edits four, runs the
 * suite twice — and drawn one line each, those calls *are* the column: what you
 * asked and what came of it end up a screen apart with twenty lines of
 * bookkeeping between them. So a run of consecutive tool calls folds into one
 * line you can open, and the conversation reads as a conversation again.
 *
 * Only tool lines fold. An error, a meta note and speech are all news, and news
 * is never folded away — which is also what makes the fold safe: a run is broken
 * by anything that is not a tool call, so nothing that matters can end up
 * hidden inside one.
 *
 * Pure on purpose, tested directly (test/transcript.test.ts). The `Line` import
 * is type-only and erased at build, so nothing rune-bearing is pulled in here.
 */

import { clip } from "./classify";
import type { Line } from "./conversation.svelte";
import { isWakePrompt } from "./relay";
import {
  JOBS_CAP,
  RESUME_CAP,
  RESUME_FAILED_CAP,
  isJobsPrompt,
  isResumePrompt,
} from "./rousing";

/** How many consecutive calls it takes to be worth folding.
 *
 *  Two. A lone call is already one line, so folding it would trade a line of
 *  transcript for a line of chrome and hide the more useful of the two. */
export const MIN_FOLD = 2;

export type Block =
  /** Drawn exactly as it always was. */
  | { kind: "line"; key: string; line: Line }
  /** A run of tool calls, drawn as one line until it is opened. */
  | { kind: "tools"; key: string; lines: Line[] }
  /** One line that is too long to stand in the column — a compaction's
   *  summary, the whole of a skill the agent invoked, or the prompt rousing
   *  sends a card whose turn was cut off. Folded on its own.
   *
   *  Its own block kind rather than a long `line`, for the reason `tools` is
   *  one: a fold needs a key, and only a block has one. It differs from `tools`
   *  in being a fold of exactly one thing, which is the opposite of the
   *  MIN_FOLD rule and deliberately so — that rule is about not trading a line
   *  of transcript for a line of chrome, and these trade twenty thousand
   *  characters for it, or in one case on this machine seven hundred thousand.
   *
   *  The three kinds share the block, the fold and the drawing of it because
   *  they are the same problem: text that is neither yours nor the agent's,
   *  arriving as a `user` message, at a size that buries the round you came to
   *  read. Only the cap differs, and `longFold` is where it does.
   *
   *  The resume prompt is the odd one in that it keeps line kind `you` — it is
   *  a prompt, it is echoed and claimed like one (`Conversation.echo`), and
   *  both folds push it as one — so it is recognised here by its words rather
   *  than by its kind. Changing the kind instead would have meant widening
   *  every predicate the echo bookkeeping asks and `trimOverlap`'s anchor, to
   *  change nothing but which branch of this function it takes. */
  | { kind: "long"; key: string; line: Line }
  /** A `!` run: the command, and what it printed. A fold of exactly one thing
   *  like `long`, and for the same reason — what a `cargo build` prints is not a
   *  line — but the only fold on this wall that starts *open*. Every other one
   *  hides machinery you did not ask for; a run is the thing you asked for, and
   *  a `git status` you have to click to read is one you would rather have typed
   *  somewhere else. See `.claude/rules/bang.md`. */
  | { kind: "shell"; key: string; line: Line };

/** The line kinds that fold on their own — see the `long` block above. A `you`
 *  line joins them when it is rousing's prompt, which is asked separately. */
/* Folded on their own, and a relay joins them for a third reason again. A
 * compaction and a skill fold because of their *size*; a relay is usually a
 * paragraph. It folds because of whose words they are: instructions written by
 * another agent for this one, which is exactly the register nobody reads and
 * exactly the register rousing's prompt is folded for. The cap names the
 * sender, which is the part you actually want from the column. */
const LONG: Line["kind"][] = ["summary", "skill", "relay"];

/** Fold a column of lines into the blocks that are drawn.
 *
 *  `tag` separates the two columns — history and live are folded once each and
 *  drawn either side of the seam, and their keys share one namespace.
 *
 *  A group's key is its *first* line's words rather than its position, because
 *  which group is open has to survive the live fold's cap: `lines` is sliced off
 *  the front past MAX_LINES, which shifts every index down and would silently
 *  move an opened group onto a different one. The first line of a group does not
 *  change as the group grows (a new call lands at the end), so the key is stable
 *  for exactly as long as the group is. Identical runs — the same command twice
 *  in one turn — are told apart by the count of those before them. */
export function blocksOf(lines: Line[], tag = "l"): Block[] {
  const out: Block[] = [];
  const seen = new Map<string, number>();
  /* Counted apart from `seen`, which is keyed on a tool line's own words: a run
     whose first call happened to read `summary` would otherwise share a
     namespace with these and the two folds would open each other. Per kind, so
     a skill arriving between two compactions cannot renumber either. */
  const longs = new Map<string, number>();
  /* Counted the same way and for the same reason: every `!` run's cap begins
     with the command it ran, so two `!ls` in one turn would key each other's
     fold — and since these start open, that would read as one of them having
     been shut by itself. */
  let runs = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "shell") {
      out.push({ kind: "shell", key: `${tag}r${runs++}`, line });
      continue;
    }
    /* Rousing's prompt: Skein's words, drawn in your register because that is
       where a prompt goes, and folded because nobody reads instructions
       addressed to an agent. Asked before `LONG` so the two counters stay
       apart. */
    const roused =
      line.kind === "you" && (isResumePrompt(line.text) || isJobsPrompt(line.text));
    if (roused || LONG.includes(line.kind)) {
      /* Counted rather than keyed on its text, which is no help here — every
         compaction summary opens with the same fixed preamble, every skill
         body with the same fixed line, and every resume prompt is the same
         prompt, so the words that tell tool runs apart tell these apart not at
         all. */
      const mark = roused
        ? "u"
        : line.kind === "summary"
          ? "s"
          : line.kind === "relay"
            ? "m"
            : "k";
      const nth = longs.get(mark) ?? 0;
      longs.set(mark, nth + 1);
      out.push({ kind: "long", key: `${tag}${mark}${nth}`, line });
      continue;
    }
    if (line.kind !== "tool") {
      out.push({ kind: "line", key: `${tag}${i}`, line });
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].kind === "tool") end++;
    const run = lines.slice(i, end);
    if (run.length < MIN_FOLD) {
      out.push({ kind: "line", key: `${tag}${i}`, line });
    } else {
      const head = run[0].text;
      const nth = seen.get(head) ?? 0;
      seen.set(head, nth + 1);
      out.push({ kind: "tools", key: `${tag}g${nth} ${head}`, lines: run });
    }
    i = end - 1;
  }
  return out;
}

/** How much is folded away. What the cap says once the group is open, where the
 *  calls themselves are the detail. */
export function foldCount(lines: Line[]): string {
  return `${lines.length} tool ${lines.length === 1 ? "call" : "calls"}`;
}

/** What a folded group says while it is folded: how much, and then the *last*
 *  call in it.
 *
 *  The last rather than the first, because a group at the foot of a live turn is
 *  still growing and its last call is the one happening now — so a folded group
 *  reads as a status line and the panel stays current without being opened.
 *  Once the turn settles the same words say where the work got to, which is the
 *  more useful end of a run to be told about anyway. */
export function foldSummary(lines: Line[]): string {
  const last = lines[lines.length - 1]?.text ?? "";
  return last ? `${foldCount(lines)} · ${clip(last, 46)}` : foldCount(lines);
}

/** What a `!` run's fold says.
 *
 *  Written whole by `bang.ts::runCap` when the run is drawn, so this is only the
 *  fallback for a line that somehow arrived without a cap — the same shape
 *  `longFold` is, and for the same reason: a fold with nothing on it is a
 *  triangle beside blank space. */
export function runFoldCap(line: Line): string {
  return line.note ?? "a command that was run here";
}

/** What a fold of one long line says, closed: the cap you read and the hint
 *  the pointer gets.
 *
 *  For a compaction, the numbers when the boundary reported them — they are the
 *  reason you ran the thing, and they say plainly that it worked. When it did
 *  not, something still has to name what the fold is, or the cap is a triangle
 *  beside nothing: a summary with no boundary is a compaction Skein watched only
 *  half of, not an absence of one.
 *
 *  For a skill, its name, which is the only part of it worth a line — the body
 *  is instructions addressed to the agent, and what you want from the column is
 *  to know which ones it picked up and to be able to go and read them. Unnamed
 *  when the injected path was not one; the fold is still worth having, since
 *  what makes it necessary is the size.
 *
 *  Both strings come from here rather than one from the component, so a kind
 *  added to `LONG` cannot be drawn with a cap that says nothing. */
export function longFold(line: Line): { cap: string; hint: string } {
  /* Rousing's prompt — the only `you` line that reaches a `long` block. What
     it is and who sent it, since the words below are the one thing in the
     column addressed to the agent rather than to you. A send that never left
     says so here too: folded, the line's own `failed` mark is not on screen. */
  if (line.kind === "you") {
    /* Two prompts reach this fold and they are about different things — one
       says the *turn* was cut off, the other that a background job outlived the
       process listening for it and the turn was fine. A card roused for the
       second reason reading "the turn was cut off" would send its agent looking
       for a half-written file that does not exist. The failed-send cap wins over
       both: a prompt that never left is the more urgent fact about the line, and
       folded, the line's own mark is not on screen to say so. */
    if (line.state === "failed") return { cap: RESUME_FAILED_CAP, hint: "what skein tried to say" };
    if (isJobsPrompt(line.text)) {
      return { cap: JOBS_CAP, hint: "what skein said was left running" };
    }
    return {
      cap: RESUME_CAP,
      hint: "what skein said to pick the turn back up",
    };
  }
  if (line.kind === "skill") {
    return {
      cap: line.note ? `read the ${line.note} skill` : "read a skill",
      hint: "what the skill told it to do",
    };
  }
  /* Written when the line was pushed rather than derived here, so the live fold
     and the one that reads it off disk cannot name the sender differently —
     `relayCap` is the one place that decides. Opened, the whole envelope shows,
     including the note addressed to the model: what is worth reading is what
     the agent was actually handed. */
  if (line.kind === "relay") {
    return {
      cap: line.note ?? "from another card",
      /* The one place the family's four-shapes-one-recogniser bargain does not
         hold: "another card sent this" is false of a wake, which nobody sent
         and which this card asked for itself. The cap already says so; the hint
         would have contradicted it. */
      hint: isWakePrompt(line.text)
        ? "the note you left yourself, handed back"
        : "what another card on this wall sent here",
    };
  }
  return {
    cap: line.note ?? "context compacted",
    hint: "what the compaction carried forward",
  };
}
