/* Waking the wall back up, and what to say to a card whose turn was cut off.
 *
 * Lazy restore is about *painting*: the wall comes back from SQLite with no
 * `claude` process anywhere, which is what makes the first frame instant. It is
 * not an argument for leaving the processes down — a wall of dormant cards is a
 * wall you have to click before it can do anything, and a card that was mid-turn
 * when the app closed has work half-done in a repo and nobody carrying it.
 *
 * So rousing runs *behind* the painted wall, exactly as the transcript reads do:
 * nothing is awaited before the wall is on screen, and a card that has already
 * been spoken to by the time the queue reaches it is simply skipped. This module
 * is the pure half — the order, the pacing, and the words. */

/** How long to leave between spawns.
 *
 *  Sequential with a gap rather than all at once, for the reason `broadcast`
 *  gives: each wake is a `claude` process starting, and thirty of them in the
 *  same tick is a thundering herd on a machine that is also painting a wall and
 *  starting dev servers. The queue is background work; it is allowed to take a
 *  minute. */
export const ROUSE_GAP_MS = 400;

/** The little of a card this module needs. */
export type Rousable = { dormant: boolean; interrupted: boolean; aside?: boolean };

/** Which cards to wake, in the order to wake them.
 *
 *  Interrupted first, and that is the whole of the ordering: those are the ones
 *  that lost a turn, so they are the ones with something to get back to. The
 *  rest keep the wall's own order, which is the order they were opened in.
 *
 *  Two kinds of card are left out. One that already has a process is either one
 *  you are using or one this queue has already reached, and waking it again is a
 *  call that can only fail. And one set aside is a card you deliberately put by
 *  — see `Conversation.aside`, which says stop counting this as waiting; giving
 *  it a process back at every launch is the same instruction ignored. Note it is
 *  left out even when `interrupted`: setting a card aside mid-turn is exactly
 *  the gesture that says "not this, not now". */
export function rouseOrder<T extends Rousable>(cards: T[]): T[] {
  const dormant = cards.filter((c) => c.dormant && !c.aside);
  return [
    ...dormant.filter((c) => c.interrupted),
    ...dormant.filter((c) => !c.interrupted),
  ];
}

/** What the resumed prompt says while it is folded away.
 *
 *  A resumed card shows a `you` line you did not write, which is the one thing
 *  the panel must never do silently — the whole point of `echo`'s pending mark
 *  is that the transcript says who has what. So the prompt wears a cap saying
 *  it is Skein's, in the same register as `cleared` and `stopped`.
 *
 *  It used to be a `meta` line written *above* the prompt, with the prompt
 *  itself drawn whole below it: twenty-odd lines of instructions addressed to
 *  the agent, at the top of every card the wall roused, in the register of
 *  something you had typed. Nobody reads them — they are not written for the
 *  reader — and on a wall coming back from a crash they were the first screen
 *  of every card on it. Now the same sentence is the cap on a fold holding the
 *  prompt, so it costs one line and the words are still one click away.
 *
 *  Folding it also settles a difference between the two halves of the panel:
 *  the note was Skein's own and is in no transcript, so a card restored from
 *  disk drew the prompt with nothing at all to say where it came from. The cap
 *  comes off the words themselves (`isResumePrompt`), so both folds draw it.
 *
 *  Short, because a fold cap is `nowrap` with an ellipsis and this panel is a
 *  third of a window wide. */
export const RESUME_CAP = "resumed by skein — the turn was cut off";

/** The same, when the send never left — see `Conversation.echoFailed`. Folded,
 *  the line's own `failed` mark is not on screen to be read, so the cap is
 *  where it has to be said. */
export const RESUME_FAILED_CAP = "resumed by skein — the prompt never went";

/** A job whose ending this card never heard — one row of `store::pending_jobs`.
 *
 *  `outputPath` is null when there is nowhere to send the agent: the receipt
 *  named no file and none could be derived, or one was derived and is not on
 *  disk. Saying a job was lost is worth doing either way; sending an agent to
 *  read a file that is not there is not. */
export type LostJob = {
  /** The tool_use id the row was written under — what settles it once the card
   *  has been told, so the same news is not delivered again tomorrow. */
  toolId: string;
  label: string;
  kind: string;
  outputPath: string | null;
  startedAt: number;
};

/** What the background-work prompt says while it is folded away. */
export const JOBS_CAP = "resumed by skein — background work went unaccounted for";

/** How long ago, in the register the rest of the wall uses. */
function ago(startedAt: number, now: number): string {
  const mins = Math.max(0, Math.round((now - startedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return `${h}h${mins % 60 ? ` ${mins % 60}m` : ""} ago`;
}

/** The lines naming what was lost, for either prompt to carry.
 *
 *  One line per job, and the path is the payload — everything else is there so
 *  the agent can tell which of its own jobs this was without opening anything. */
export function jobsLines(jobs: LostJob[], now: number): string[] {
  return jobs.map((j) => {
    const where = j.outputPath
      ? `output at ${j.outputPath}`
      : "no output file was kept";
    return `- ${j.label} (${j.kind}, started ${ago(j.startedAt, now)}) — ${where}`;
  });
}

/** What to say to a card whose turn ended cleanly but whose work did not.
 *
 *  This is the case the whole `job` table exists for, and it is **not**
 *  `interrupted`: the turn finished, the agent said what it was going to say,
 *  and then a background job it was waiting on outlived the process that was
 *  listening for it. The CLI reports such jobs at the next launch as "stopped"
 *  with no exit code and no output — and that report, measured, wakes nobody
 *  three times out of three (`turns.md`). So the card is told directly.
 *
 *  It says *check* rather than *redo*, because the two possible states are far
 *  apart and only looking distinguishes them: on a Skein without the job object
 *  the work was orphaned and usually ran to completion, and on one with it the
 *  process was killed part-way. A prompt that assumed either would be wrong half
 *  the time, and the expensive half is re-running a database write that already
 *  landed.
 *
 *  Hand-wrapped, like `resumePrompt`, for the same GFM reason. */
export function jobsPrompt(jobs: LostJob[], now: number): string {
  return [
    "background work you started was still running when skein last closed, and",
    "its result was never reported back to you. this is the same session",
    "resumed.",
    "",
    ...jobsLines(jobs, now),
    "",
    "check what actually happened rather than assuming either way — the job may",
    "have run to completion after the process that was watching it went away, or",
    "it may have been killed part-way. read the output file where there is one;",
    "prefer `tail`, `grep` or a ranged read over pulling a large log in whole.",
    "",
    "then carry on from what you find. if it finished, use the result. if it was",
    "cut off, say so before re-running anything that writes.",
  ].join("\n");
}

/** Does this text look like the prompt above? Same bargain `isResumePrompt`
 *  strikes: the cap is derived from the words, so the live fold and the one
 *  rebuilt from a transcript agree without Skein having to record anything. */
export function isJobsPrompt(text: string): boolean {
  return text.trimStart().startsWith("background work you started was still running");
}

/** What to say to a card that was working when the app went away.
 *
 *  It is deliberately not "continue". The turn died somewhere unknown: a file
 *  may be half-written, a command may have run and its output lost, and the
 *  agent's own last message is the least reliable account of where things got
 *  to, because it was interrupted before it could say so. So the prompt spends
 *  its length on *looking first* — and on the case where looking does not
 *  settle it, where stopping and asking beats guessing at half-finished work.
 *
 *  Hand-wrapped, like `conflictPrompt`: the panel renders GFM, where a single
 *  newline is a line break, so a paragraph arriving as one long line stays one
 *  long line beside the others. */
export function resumePrompt(jobs: LostJob[] = [], now = Date.now()): string {
  return [
    "you were part-way through a turn when skein closed, so that turn was cut",
    "off mid-flight. this is the same session resumed — everything you can see",
    "above is yours.",
    "",
    "work out where it actually got to before you carry on:",
    "",
    "- your last message is the *least* reliable account of it, since you were",
    "  interrupted before you could report. read the tree instead.",
    "- `git status` and `git diff` if this is a repo; otherwise the files you",
    "  had been editing. a half-written file is the normal failure here.",
    "- a command you had started may have run to completion with its output",
    "  lost, or not at all. check the effect rather than assuming either.",
    /* Named rather than left to that last bullet, which says the right thing
       and says it about nothing in particular. A card that knows its job was
       called `import-write` and where the log is does not have to go looking
       for what it might have been running. */
    ...(jobs.length
      ? [
          "",
          "background work of yours was still running when it closed, and its",
          "result was never reported back to you:",
          "",
          ...jobsLines(jobs, now),
        ]
      : []),
    "",
    "then pick the work back up and finish it.",
    "",
    "if you cannot tell what you were in the middle of, say so and stop rather",
    "than guessing — a guess at half-finished work is worse than a question,",
    "because it looks finished.",
  ].join("\n");
}

/** Is this the prompt above, arriving back as a line to be drawn?
 *
 *  Asked of the *words*, for the reason `isCompactSummary` and `skillBody` are:
 *  the live fold and the transcript fold have no field in common to sort this
 *  out by — the wire carries nothing marking a prompt as Skein's, and the
 *  session file records it as an ordinary `user` message, because that is
 *  exactly what it is. The one thing both halves have is the text.
 *
 *  Anchored to the first line rather than compared whole. The prompt is
 *  hand-wrapped prose that will be edited again, and a card resumed under an
 *  older wording is still a card whose transcript should fold — while an
 *  equality test would quietly stop folding every transcript on disk the next
 *  time a sentence in the middle of it changed. Anchored rather than merely
 *  contained for the usual reason: an agent *quoting* the prompt back is
 *  speech, and speech does not fold. */
export function isResumePrompt(text: string): boolean {
  return /^you were part-way through a turn when skein closed/i.test(
    text.trimStart(),
  );
}

/** Which of skein's own rouse prompts this session already ends in, unanswered
 *  — and so must not be sent a second time.
 *
 *  A resume prompt is written to the child's stdin like anything else, so the
 *  CLI records it in the session file as an ordinary `user` message. `--resume`
 *  then puts it back in front of the model. So a card that was sent one and
 *  died before it could answer comes back **already holding it**, and the rouse
 *  that follows composes a second, byte-identical copy and sends it beside the
 *  first — two real sends against a real allowance, and an agent reading the
 *  same instructions twice with nothing to say why.
 *
 *  That is the shape sink `01e00f30` reported, and it is worth guarding whether
 *  or not it was the cause there: skein re-sending something the session
 *  already holds is wrong on its own terms.
 *
 *  **Agent speech is what settles it.** A resume prompt the card answered is
 *  history — the turn it opened happened, and a later crash is a new turn worth
 *  a new prompt. One with no `text` or `tool` line after it was never taken up,
 *  and the model has it either way. So the scan runs from the end and stops at
 *  the first line of the agent's; anything else in between — your own words, a
 *  note, a message from another card — is a prompt queued behind an unanswered
 *  one, which does not make it answered.
 *
 *  Structural rather than typed against `Line` so this file stays pure. */
export function unansweredRousePrompt(
  lines: readonly { kind: string; text: string }[],
): "resume" | "jobs" | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.kind === "text" || l.kind === "tool") return null;
    if (l.kind !== "you") continue;
    if (isResumePrompt(l.text)) return "resume";
    if (isJobsPrompt(l.text)) return "jobs";
  }
  return null;
}

/** Said instead of sending, so a card the rouse deliberately left alone does
 *  not read as one it forgot. `meta`, like the other things skein says about a
 *  conversation rather than in it, and shaped like `RESUME_CAP` because it is
 *  the same event with the send taken out. */
export const ALREADY_ROUSED_NOTE =
  "resumed by skein — the prompt was already in the session";
