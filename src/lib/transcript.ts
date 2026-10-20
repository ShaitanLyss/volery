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

import {
  RESEND_CAP,
  SKEIN_SHOW_TOOL,
  clip,
  isResendMark,
  splitResendMark,
} from "./classify";
import type { Effort } from "./commands";
import type { ConvKind, Job, Line } from "./conversation.svelte";
import { isPlanDocument, type Gear } from "./gears";
import { SPAWN_TOOL, spawnedHandle } from "./chatview";
import { isWakePrompt } from "./relay";
import {
  JOBS_CAP,
  RESUME_CAP,
  RESUME_FAILED_CAP,
  isJobsPrompt,
  isResumePrompt,
} from "./rousing";

/** Everything `Transcript.svelte` reads, and nothing else.
 *
 *  The panel used to take a `Conversation` — the class, with its process, its
 *  event fold and its forty methods — and it reads **twenty-three plain fields
 *  off it and calls nothing**. That gap is the whole of why a card on another
 *  wall could not have a transcript: a shadow has no process and never will
 *  (`shadow.ts`), so it can never *be* a `Conversation`, and the panel's
 *  requirement was a class where its need was a shape.
 *
 *  So the dependency is stated as the shape. `Conversation` satisfies it
 *  structurally and no call site changed; a shadow builds one out of what the
 *  owning wall sent. The alternative was a second transcript component for
 *  remote cards, which is the thing not to do — two renderers for one column
 *  drift, and the one that drifts is the one on the machine you are not
 *  looking at. It is the same argument `history.ts` makes for folding a file
 *  into the *same* `Line`s the live stream produces: a seam in the middle of
 *  one column of speech is worse than either side of it.
 *
 *  **Add a field here and a shadow must answer it**, which is the point: the
 *  compiler asks the question rather than a remote card quietly rendering
 *  without something. Where a shadow has no honest answer it says so with the
 *  empty value — no jobs, no cost — rather than being given a plausible one.
 *  See `.claude/rules/elsewhere.md`. */
export type Readable = {
  id: string;
  cwd: string;
  kind: ConvKind;
  lines: Line[];
  history: Line[];
  historyState: "unread" | "loading" | "ready" | "none" | "error";
  historyPartial: boolean;
  streaming: string;
  working: boolean;
  dormant: boolean;
  everSpoke: boolean;
  activity: string;
  doing: string;
  dropped: number;
  ctx: number;
  compactFrac: number | null;
  model: string | undefined;
  effort: Effort | undefined;
  gear: Gear;
  jobs: Job[];
  /* Three that only a card on another wall has, and optional for that reason:
     a card here has no honest value for any of them, and a required field
     would make `Conversation` carry three constants to say so. They are read
     off the readable rather than passed beside it — `CardFace.elsewhere`'s
     bargain — so no panel can forget to say where the conversation is. */
  /** The wall it runs on, said in the footer beside its model. */
  elsewhere?: { host: string; unheard: boolean };
  /** The panel reads the history when it opens on a card, and again whenever
   *  this changes. Absent for a card whose history is read once. */
  historyMark?: string;
  /** The same, keyed narrower: what a pinned last message re-reads on
   *  (`Saying.svelte`). Only what can change the last thing said — a new line
   *  settled, a turn opening or closing, the wall heard again — and not the
   *  card's activity, which moves on every tool call. Absent for a card whose
   *  history is read once. */
  saidMark?: string;
  /** Lines the panel says above the conversation — what this wall knows that
   *  the conversation cannot say for itself (`handle.ts::panelNotes`). */
  notes?: readonly { text: string; tone?: "warn" | "ask" }[];
};

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
  | { kind: "shell"; key: string; line: Line }
  /** A picture an agent showed with the `show` tool, drawn as itself where it
   *  was shown. A tool call, and the one tool call that is never folded into a
   *  run: the rule above is that only machinery folds, and a call whose whole
   *  effect is a thing for you to look at is not machinery — it is the turn
   *  saying something. Folded, the picture an agent showed you would be behind
   *  a cap reading `3 tool calls`, which is `pin`'s old failure (the picture a
   *  screen away from the sentence about it) arriving from the other side. See
   *  `.claude/rules/showing.md`. */
  | { kind: "shown"; key: string; line: Line }
  /** A message this conversation sent another card (`mcp__skein__send`),
   *  standing where it was sent rather than inside a run of calls. Only where
   *  the caller asks (`blocksOf`'s `apart`) — chat view, which draws it as a
   *  letter (Lyss, 2026-10-20: *"messages sent or received are displayed as
   *  plain text instead of having a nice ui"*). Folded, what one card said to
   *  another was a line reading *messaged fc5cb712* and nothing of the words;
   *  a message is the turn saying something, which is `shown`'s argument. */
  | { kind: "sent"; key: string; line: Line };

/** Whether a line is a picture an agent showed — see the `shown` block. */
export const isShown = (line: Line): boolean =>
  line.kind === "tool" && line.call?.name === SKEIN_SHOW_TOOL;

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
 *  in one turn — are told apart by the count of those before them.
 *
 *  **`base` is that same hazard, for the lines the paragraph above stops one
 *  short of.** An ordinary line was keyed on its raw index, which was judged
 *  harmless because it has no fold state to misplace — and it has a DOM node.
 *  Past the cap every index shifts on every message, so every key changed, so
 *  Svelte's keyed `{#each}` rebuilt the entire column each time; that takes
 *  Chromium's scroll anchor with it, and with nothing to anchor, `scrollTop`
 *  keeps its number while the content above it got shorter. The reader slides
 *  toward the bottom a line at a time with nothing having decided to scroll
 *  (sink `b14e1606`, and `Conversation.dropped` has the whole of it).
 *
 *  So the caller passes how many lines have fallen off the front and the key
 *  becomes an *absolute* position — stable by construction, which is the same
 *  property the group keys buy by other means. Defaulting to zero keeps every
 *  other caller right: history is folded once and never sliced. */
export function blocksOf(lines: Line[], tag = "l", base = 0, apart?: (line: Line) => boolean): Block[] {
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
    /* A prompt Skein sent again after a turn died before reaching a model
       carries a sentence saying so, appended to your words — so the line is
       partly yours and partly Skein's, which is the one shape none of the folds
       above had. Drawn whole it is your `go` and four lines accounting for it,
       and `healNote` has already told *you* the same thing from above, before
       the wait.

       So it is drawn as its two halves: your words as the line they are, and
       the mark under them behind a cap. Folding rather than dropping, for the
       reason the resume prompt is folded rather than dropped — what the agent
       was actually handed is worth being able to read, and a panel that showed
       one thing while the wire carried another is the divergence this family of
       recognisers exists to prevent.

       Asked after `roused`, so a resume prompt that was itself resent folds
       whole and takes its mark with it rather than being split in two. */
    const resent =
      line.kind === "you" ? splitResendMark(line.text) : null;
    if (resent) {
      /* The body keeps the line's own identity — its `state`, so a send that
         never left still wears its failed mark, and its `data-nav`, since your
         prompt is a place in the conversation to travel back to. The mark gets
         neither: it is not a round, and a `failed` cap here would say the
         *mark* never went. */
      if (resent.body) {
        out.push({
          kind: "line",
          key: `${tag}${base + i}`,
          line: { ...line, text: resent.body },
        });
      }
      const nth = longs.get("h") ?? 0;
      longs.set("h", nth + 1);
      out.push({
        kind: "long",
        key: `${tag}h${nth}`,
        line: { ...line, text: resent.mark, state: undefined },
      });
      continue;
    }
    if (line.kind !== "tool") {
      out.push({ kind: "line", key: `${tag}${base + i}`, line });
      continue;
    }
    /* Keyed by position like an ordinary line, and for the ordinary line's
       reason: it has a DOM node, and the absolute `base` is what keeps that
       node — and the picture already decoded inside it — across the live
       column sliding. */
    if (isShown(line)) {
      out.push({ kind: "shown", key: `${tag}${base + i}`, line });
      continue;
    }
    if (apart?.(line)) {
      out.push({ kind: "sent", key: `${tag}${base + i}`, line });
      continue;
    }
    let end = i;
    /* A shown picture breaks a run the way speech does, so the calls either
       side of it fold on their own and the picture stands between them — and
       so does a message sent, where the caller stands those apart. */
    while (end < lines.length && lines[end].kind === "tool" && !isShown(lines[end]) && !apart?.(lines[end])) end++;
    const run = lines.slice(i, end);
    if (run.length < MIN_FOLD) {
      out.push({ kind: "line", key: `${tag}${base + i}`, line });
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
  /* Rousing's prompt, and the mark on a prompt Skein sent again — the two
     `you` lines that reach a `long` block. What it is and who sent it, since
     the words below are the one thing in the column addressed to the agent
     rather than to you. A send that never left says so here too: folded, the
     line's own `failed` mark is not on screen. */
  if (line.kind === "you") {
    /* Asked first, because it is the one `you` fold that is not a whole prompt
       but the tail of one — `blocksOf` has already drawn your words as their
       own line above it. So none of the three tests below apply to it: it is
       not rousing's, it did not fail, and the failed-send cap would be claiming
       the *mark* never went when what never went was the prompt above, which is
       wearing its own mark and is on screen to be read. */
    if (isResendMark(line.text)) {
      return { cap: RESEND_CAP, hint: "why skein sent this prompt twice" };
    }
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

/** What a run of machinery did, as chat view folds it (`docs/chat-mode.md`
 *  §4.2): *read 6 files, edited 3, ran the tests*, with a diff stat and how
 *  long it worked. The panel keeps `foldSummary` — its status-line reading of
 *  the last call — and chat view, whose reader is not watching the machinery,
 *  wants what it came to instead.
 *
 *  Counted by tool, not by line: files are counted once however often they
 *  were read; edits by the file they touched. The diff stat is lines, counted
 *  off the arguments the model wrote (an edit's old and new strings, a write's
 *  content) — the honest reading of "how much changed" that needs no git, and
 *  a rough one: an edit that rewrites a line counts it once each way, as a
 *  diff does. */
export type RunSummary = {
  /** The phrases, joined: `read 6 files, edited 3, ran the tests`. */
  words: string;
  added: number;
  removed: number;
  /** From the first call to the last thing that landed, in ms — or null when
   *  the run carries no times (a transcript read before they were kept), or
   *  took under a second, where *worked for 0s* would be a number saying
   *  nothing. */
  worked: number | null;
};

const READS = new Set(["Read", "NotebookRead"]);
const SEARCHES = new Set(["Grep", "Glob", "LS"]);
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SHELLS = new Set(["Bash", "PowerShell"]);
const WEB = new Set(["WebSearch", "WebFetch"]);
const HELPERS = new Set(["Task", "Agent"]);
const TESTS = /\b(test|tests|vitest|jest|pytest|cargo test|bun test|bun run test|gate)\b/i;

function linesIn(v: unknown): number {
  return typeof v === "string" && v.length ? v.split("\n").length : 0;
}

export function runSummary(lines: Line[]): RunSummary {
  const read = new Set<string>();
  const edited = new Set<string>();
  let searched = 0;
  let commands = 0;
  let tests = false;
  let web = 0;
  let helpers = 0;
  let started = 0;
  let planned = false;
  let other = 0;
  let added = 0;
  let removed = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const line of lines) {
    const call = line.call;
    if (line.at !== undefined) {
      first = first === null ? line.at : Math.min(first, line.at);
      last = last === null ? line.at : Math.max(last, line.at);
    }
    if (call?.result?.at !== undefined) last = last === null ? call.result.at : Math.max(last, call.result.at);
    if (!call) {
      other++;
      continue;
    }
    const input = (call.input ?? {}) as Record<string, unknown>;
    const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
    if (READS.has(call.name)) read.add(file || `#${read.size}`);
    else if (SEARCHES.has(call.name)) searched++;
    /* A plan written into `~/.claude/plans` is not an edit to the project —
       nothing there has changed yet, which is the whole point of one. */
    else if (EDITS.has(call.name) && isPlanDocument(file)) planned = true;
    else if (EDITS.has(call.name)) {
      edited.add(file || `#${edited.size}`);
      if (call.name === "Write") added += linesIn(input.content);
      else if (call.name === "MultiEdit" && Array.isArray(input.edits)) {
        for (const e of input.edits as Record<string, unknown>[]) {
          removed += linesIn(e?.old_string);
          added += linesIn(e?.new_string);
        }
      } else {
        removed += linesIn(input.old_string);
        added += linesIn(input.new_string ?? input.new_source);
      }
    } else if (SHELLS.has(call.name)) {
      commands++;
      const said = `${String(input.command ?? "")} ${String(input.description ?? "")}`;
      if (TESTS.test(said)) tests = true;
    } else if (WEB.has(call.name)) web++;
    else if (HELPERS.has(call.name)) helpers++;
    /* A conversation it opened is not a step of machinery — it has its own
       linked card under the run (§5.5) — but the run should still say so. */
    else if (call.name === SPAWN_TOOL) {
      /* Only one that opened something; a refusal is a step like any other. */
      if (spawnedHandle(call)) started++;
      else other++;
    }
    else other++;
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const words: string[] = [];
  if (read.size) words.push(`read ${n(read.size, "file", "files")}`);
  if (searched) words.push(`searched ${searched === 1 ? "once" : `${searched} times`}`);
  if (edited.size) words.push(`edited ${edited.size}`);
  if (planned) words.push("wrote the plan");
  if (tests) words.push("ran the tests");
  else if (commands) words.push(`ran ${n(commands, "command", "commands")}`);
  if (web) words.push(`looked on the web${web > 1 ? ` ${web} times` : ""}`);
  if (helpers) words.push(`started ${n(helpers, "helper", "helpers")}`);
  if (started) words.push(started === 1 ? "started a conversation" : `started ${started} conversations`);
  if (other) words.push(n(other, "other step", "other steps"));
  return {
    words: words.join(", "),
    added,
    removed,
    worked: first !== null && last !== null && last - first >= 1000 ? last - first : null,
  };
}
