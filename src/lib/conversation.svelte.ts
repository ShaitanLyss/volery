/* The state of one conversation, folded from the claude stream-json event feed.
 *
 * Everything the wall shows is derived here. No polling, no terminal scraping —
 * every field below is a fold over events that `claude -p --output-format
 * stream-json` already emits. Classification lives in ./classify.ts so it can
 * be tested against real output without a Svelte compiler in the way. */

import {
  ASK_TOOLS,
  backgroundKind,
  basename,
  clip,
  compactNote,
  compactStat,
  contextWindowFor,
  describeTool,
  endingFor,
  healKindOf,
  healGaveUpNote,
  HEAL_BUDGET,
  type HealKind,
  isCompactSummary,
  isStopNote,
  skillBody,
  jobLabel,
  jobNote,
  localAnswer,
  systemTaskNote,
  localCommandAwaiting,
  localCommand,
  NUDGE_BUDGET,
  nudgeGaveUpNote,
  type NudgeKind,
  UNACKNOWLEDGED_LINE,
  parseTaskNotification,
  sameModel,
  unwokenNote,
  WAKE_GRACE_S,
  spanOf,
  startedJob,
  taskNumberOf,
  textOf,
  urgencyFor,
  workflowMeta,
  workflowName,
  type Ending,
  type JobKind,
  type TaskNote,
  type Tier,
} from "./classify";
import { backupSettled } from "./repair";
import {
  compactEstimate,
  compactFill,
  compactLate,
  normalizeSeen,
  recordCompaction,
  type Compaction,
} from "./compaction";
import { costStep } from "./usage";
import { until } from "./limits";
import { UNNAMED } from "./naming";
import { effortAnswer, isEffort, type Effort } from "./commands";
import { isRelayPrompt, relayCap } from "./relay";
import { answerNote } from "./asking";
import type { Answers, AskQuestion } from "./asking";
import { capInput, landed, type ToolCall } from "./toolcall";
import {
  afterAck,
  afterExit,
  afterInit,
  DEFAULT_GEAR,
  gearOfInit,
  gearOfModeAck,
  gearOfWire,
  isPlanDocument,
  type Gear,
  type GearState,
} from "./gears";

export type { Ending, Tier };
/* The panel draws a call from this and half the wall types against it. */
export type { ToolCall } from "./toolcall";

/** What a card is, as opposed to what state it is in.
 *
 * `project` is every card there has ever been: a working tree with the machine
 * at its disposal. `chat` is one opened outside any project, which can search
 * the web and reach nothing else — the capability lives in the argv
 * (`supervisor.rs::chat_argv`) and this is only what the wall calls it. */
export type ConvKind = "project" | "chat";

export type Line = {
  /** `you` is a turn *you* opened — see the `user` case in `ingest`. Rousing's
   *  resume prompt is the one exception and stays in this register anyway: it
   *  is a prompt, it is echoed and claimed like one, and both folds push it as
   *  one. What marks it as Skein's is that `blocksOf` recognises the words and
   *  folds it away behind `RESUME_CAP` — see `rousing.ts::isResumePrompt`.
   *
   *  `answer` is the other thing you say into a conversation and the only one
   *  that opens no turn: the reply to a parked `ask_user`, kept under the call
   *  that asked it. It is not `you` — that register is a prompt, and the rails
   *  list every one of them as a place in the conversation to travel back to,
   *  which an answer to a question you were asked is not. *
   *  `summary` is the block of text a compaction carried forward. It arrives as
   *  a `user` message — the CLI handing the model everything it must not forget
   *  — and it is neither yours nor the agent's, so it is neither `you` nor
   *  `text`. It is the one line kind that is folded away by default: they run
   *  16k–25k characters here, and a round you want to read is on the far side
   *  of it.
   *
   *  `skill` is the other one, and arrives the same way and for the same
   *  reason: invoking a skill puts the whole of its text into the conversation
   *  as a `user` message, so it is neither yours nor the agent's either — and
   *  it is bigger, since it is a whole file. See `skillBody`. Both are folded
   *  by `blocksOf`'s `long` block, which is the one thing they need in common.
   *
   *  `relay` is a message another card on this wall sent to this one. It
   *  arrives on the wire as a plain `user` message — the same shape as
   *  something you typed — so left alone it is drawn in your register, in your
   *  card, with nothing saying it was not you. Its own kind, recognised off the
   *  envelope's words (`relay.ts::isRelayPrompt`) for the reason rousing's
   *  prompt is: the live fold and the one that reads a session back off disk
   *  share nothing but the text. It *does* open a turn, unlike the three notes
   *  above — a message is a prompt somebody sent, and the card is about to
   *  spend a turn on it. See `.claude/rules/relay.md`.
   *
   *  `shell` is a `!` line: a command you ran in this card's directory rather
   *  than something you said to its agent. It is the one kind nothing on the
   *  wire ever produces — no event carries it and no session file records it —
   *  which is why a restored card comes back without one. Its `text` is what the
   *  command printed. See `.claude/rules/bang.md`. */
  kind:
    | "you"
    | "text"
    | "tool"
    | "error"
    | "meta"
    | "answer"
    | "summary"
    | "skill"
    | "relay"
    | "shell";
  text: string;
  /** The cap a folded line wears — set on the three kinds that fold on their
   *  own. On a `summary` it is what the compaction cost and saved: the numbers
   *  arrive one event before the words they belong to, and are absent when no
   *  boundary reported them. On a `skill` it is the skill's name, absent when
   *  the path the CLI injected was not one. On a `shell` it is the whole cap
   *  `bang.ts::runCap` wrote — the command, the line count and how it ended. */
  note?: string;
  /** On a `you` line, whether the process has it yet: `pending` is drawn but
   *  not yet acknowledged, `failed` never reached one, and absent is the normal
   *  case — the wire echoed it back.
   *
   *  On a `shell` line the same two words mean the run rather than the send:
   *  `pending` while it is going, `failed` for a non-zero exit. A run that was
   *  *stopped* is neither — killing it is something you did on purpose, and the
   *  cap says so in words rather than the line wearing a fault. Same
   *  distinction `wasStopped` draws for a turn. */
  state?: "pending" | "failed";
  /** On a `tool` line, the call itself: its name, the arguments the model
   *  wrote, and — once it lands — what came back.
   *
   *  `text` is `describeTool`'s one line of prose, which is the right answer to
   *  "what is it doing" and no answer at all to "what did it actually do". Both
   *  were on the wire and only the first was kept, so the panel could say
   *  `searching for describeTool` and not which directory, which glob, or
   *  whether it found anything. This is the rest of it; `toolcall.ts` is what
   *  sets it on the page and `ToolCall.svelte` draws it.
   *
   *  Capped where it is written (`capInput`, `landed`), not where it is drawn:
   *  a line is kept for the life of the card and there are up to three hundred
   *  of them, so a cap that only bites at render time is not a memory bound.
   *  Absent on every other kind of line. */
  call?: ToolCall;
  /** Bookkeeping rather than drawing: this line was written by `echo` and the
   *  wire has not echoed it back yet, so it is still the line a replay claims.
   *  Separate from `state` because the two stopped being the same question —
   *  see `#settleEchoes`. */
  awaited?: true;
};

/* The ask vocabulary lives in ./asking.ts, which is pure and normalizes the raw
   tool-call arguments on every read. Re-exported here because `AskOption` was
   this file's before questions became plural, and half the wall imports it. */
export type { AskOption, AskQuestion } from "./asking";

/** One subagent the card has convened.
 *
 * `--forward-subagent-text` re-emits a subagent's text and thinking as messages
 * carrying `parent_tool_use_id`, so each thought arrives already addressed to
 * the card that spawned it. There is nothing to correlate — we just route. */
export type Seat = {
  /** The parent's tool_use id — the only thing tying a thought to a seat. */
  id: string;
  persona: string;
  state: "spawning" | "thinking" | "done";
  thought: string;
  verdict: string | null;
  /** Set when this seat is a *workflow* rather than one subagent: a script that
   *  fans a crowd of agents out over phases and hands back a receipt.
   *
   *  Its presence is the marker and its `phases` are what the script declared —
   *  which may be none, since `meta.phases` is optional. Nothing else about a
   *  workflow reaches this window: its agents run on a stream Skein never sees,
   *  so the phases are drawn as a list of what it *will* do and never as
   *  progress through them. A lit phase would be a claim nothing here can
   *  make. See `workflowMeta`. */
  crew?: { phases: string[] };
};

/** One piece of work the agent started that outlives the turn that started it.
 *
 * Keyed on the tool_use id, which is the only identity the call, the receipt
 * and the completion notification all share — the same bargain `Seat` makes,
 * and for the same reason: there is nothing to correlate, only to route.
 *
 * Settled jobs are *removed* rather than kept with a state, so `busy` is a
 * question about the list's contents rather than about each entry's history.
 * What a job did is said once, in the transcript, by the CLI's own summary. */
export type Job = {
  toolId: string;
  /** The CLI's id, once a receipt names one — what `TaskOutput` and `TaskStop`
   *  take, and what the completion notification quotes back as `<task-id>`.
   *  For a subagent it is the `agentId`, which is the same value under another
   *  name and is what finds its transcript on disk. */
  taskId: string | null;
  kind: JobKind;
  label: string;
  /** Where the CLI is writing this job's output, when its receipt says.
   *
   *  Only `Bash` names one; a `Monitor` and an `Agent` carry none, and theirs
   *  is derived at the far end from the session and the task id. This is the
   *  field the whole of job persistence exists to keep: a job that reports in
   *  needs none of it, because its notification quotes its own `<output-file>`
   *  — this is for the job whose notification never comes. */
  outputPath: string | null;
  /** A workflow's own run directory, from its receipt, and null for every other
   *  kind. The journal inside it is the only account of how far a workflow has
   *  got (`workflow.rs`), and `crowds` is what reads it.
   *
   *  Deliberately **not** persisted with the row. A `job` row exists to say what
   *  was *lost* when the process went away, and progress is a reading about a
   *  run this process is watching — the day after, the journal is a finished
   *  file and the notification's own summary is the better account of it. So no
   *  schema rung, and a roused card simply does not draw a crowd for a workflow
   *  it never saw launch. */
  journalDir: string | null;
  /** `starting` is provisional — registered from the call, before the receipt
   *  has confirmed the thing actually went to the background. */
  state: "starting" | "running";
  since: number;
};

/** A job's arrival or departure, for Skein to write down.
 *
 *  A queue of these rather than a callback, for the reason `pendingHeal` is a
 *  field: `conversation.svelte.ts` never talks to Rust, and a write fired from
 *  inside `ingest` would land in the middle of the tick, the ledger and the
 *  persistence that all run off the same event. Skein drains it. */
export type JobWrite =
  | {
      op: "record";
      toolId: string;
      taskId: string | null;
      kind: JobKind;
      label: string;
      outputPath: string | null;
    }
  | { op: "settle"; toolId: string };

/** One item of the agent's own plan, folded from `TaskCreate`/`TaskUpdate`.
 *
 * The plan is the best single account of a long turn there is: it is what the
 * agent means to do, in its own words, with its own idea of how far along it
 * is — where the activity line can only ever report the last tool call. */
export type PlanTask = {
  /** The number the CLI assigned, which is what `TaskUpdate` names. */
  n: string;
  subject: string;
  /** The gerund written to be displayed while this item is the one in hand. */
  activeForm: string;
  status: string;
};

export type PendingAsk = {
  askId: string;
  /** Every decision this one call is parked on, in the order to ask them.
   *  Always at least one — `normalizeAsk` guarantees it, because a card blocked
   *  with nothing on screen could never be unblocked. */
  questions: AskQuestion[];
  /** One slot per question; `null` until answered. Held here rather than in
   *  `Ask.svelte` so that clicking away to another card and coming back does
   *  not throw away the answers already given — the panel draws whichever card
   *  is blocked, so its own state would not survive the switch. */
  answers: Answers;
  /** Questions the call carried past `MAX_QUESTIONS`. Drawn, because an agent
   *  that asked six things and got five answers will guess at the sixth. */
  dropped: number;
  since: number;
};

/** A one-second tick. Urgency decays with neglect, so the wall has to know
 *  what time it is — but only one timer does, not one per card.
 *
 * **It advances by exactly one second, and that is load-bearing.** This was a
 * plain `setInterval(…, 1000)` reading `Date.now()`, and a countdown on the wall
 * would every so often drop two seconds at once — 4:31 to 4:29 — which reads as
 * a timer that has lost count. Nothing was wrong with the arithmetic:
 * `setInterval` is a *minimum* delay and each tick lands a few milliseconds
 * late, the lateness accumulates because the next one is scheduled from when the
 * last one ran, and every reading on this wall is a `Math.floor` of something
 * linear in `t`. Once the accumulated drift carries `t` across a whole-second
 * boundary the floor skips one, and it goes on doing it about every couple of
 * hundred ticks forever. Every instrument reading this clock had the same skip;
 * a countdown is only where it is legible, because you are watching one number.
 *
 * So two changes, and each fixes half of it:
 *
 *  - **The next tick is scheduled from the wall clock, not from this one.**
 *    A self-correcting `setTimeout` aimed just past the coming second boundary,
 *    so lateness is spent rather than banked and the error cannot grow.
 *  - **`t` is snapped to the boundary it landed on.** That is what makes the
 *    step exactly 1000ms rather than merely close to it, so `floor` of anything
 *    derived from `t` moves by exactly one per tick whatever phase it is at.
 *    `Math.round` rather than `Math.floor` so a timer that fires a hair *early*
 *    names the second it was aiming at instead of the one before.
 *
 * The snap costs nothing that matters: everything reading this clock reads it to
 * a second, and the half-second it may shift a written epoch by (`start`,
 * `bank`) cannot change an elapsed — both sides of that subtraction are the same
 * `now`. A tick delayed by much more than a second — the machine slept, the
 * webview was throttled — jumps by however long that really was, which is the
 * honest answer and the one the old code gave too. */
export const clock = $state({ t: Date.now() });

/** How far past the boundary to aim. Enough that a timer firing a shade early
 *  still lands in the second it meant, small enough to be invisible. */
const OVERSHOOT = 4;

/* One timer, however many times HMR re-evaluates this module. The handle has to
   live on `window` for the same reason the control surface's generation counter
   does: a module-scoped variable is re-created by the very reload it is meant to
   guard against, so each generation would start its own count and leave the
   previous timer ticking a clock that nothing reads. Clearing the pending
   timeout stops the whole chain, since each link only exists once the one before
   it has run. */
const TIMER = "__skeinClockTimer";
{
  const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
  clearTimeout(w[TIMER]);
  const beat = () => {
    const now = Date.now();
    const t = Math.round(now / 1000) * 1000;
    clock.t = t;
    /* Aimed from the boundary just named rather than from `now`, so a tick that
       arrived late spends the lateness and one that arrived a hair early does
       not name the same second twice. */
    w[TIMER] = setTimeout(beat, Math.max(1, t + 1000 + OVERSHOOT - now));
  };
  const start = Date.now();
  w[TIMER] = setTimeout(beat, 1000 - (start % 1000) + OVERSHOOT);
}

/** What compactions have actually cost on this machine, newest last.
 *
 *  Wall-wide rather than per-card: a fold's cost is a property of this machine
 *  and this network, and a card that has never compacted should still get the
 *  benefit of the eleven that have. localStorage rather than SQLite for the
 *  reason the viewport is there — per-machine, disposable, and not a thing you
 *  *made*. Losing it costs one slightly-wrong bar.
 *
 *  Module-level, so the file is read once for the whole wall instead of once
 *  per card. `compaction.ts` holds all the arithmetic and is pure; this is only
 *  where it is kept. */
const SEEN_KEY = "skein.compactions";
let seenCompactions: Compaction[] = (() => {
  try {
    return normalizeSeen(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null"));
  } catch {
    return [];
  }
})();

function rememberCompaction(next: Compaction) {
  const grown = recordCompaction(seenCompactions, next);
  /* `recordCompaction` refuses a measurement it does not believe, and returns
     the list it was given. Nothing to write in that case. */
  if (grown === seenCompactions) return;
  seenCompactions = grown;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(grown));
  } catch {
    /* A full or disabled store costs the calibration and nothing else. */
  }
}

const MAX_LINES = 300;

export class Conversation {
  readonly id: string;
  /** The `claude` session this card is currently pointed at — what `--resume`
   *  and `--session-id` take, and what names the transcript on disk.
   *
   *  Equal to `id` for the whole of a card's life until it is cleared, which is
   *  why everything used to use `id` for both. They are different things
   *  though: `id` is *this card* — its placement, its turns, its file touches
   *  all key on it and must survive — while the session is the conversation the
   *  card is holding, and clearing swaps that for a fresh one without the card
   *  moving or being replaced. */
  sessionId = $state("");
  readonly cwd: string;
  readonly project: string;
  readonly projectId: string;
  /** The app quit or crashed while this was mid-turn. That turn did not
   *  survive, and the card says so rather than pretending it finished. */
  interrupted = $state(false);

  title = $state(UNNAMED);
  /** You named this one yourself, so nothing else may rename it.
   *
   *  The three stages a title arrives in (see `naming.ts`) are all things that
   *  happen *to* a card — the sentinel, the cut of your first prompt, then
   *  Claude Code's generated title, which replaces whatever was there every
   *  time a turn settles. That last one is what makes this a flag rather than
   *  just a write: `/rename` without it holds for exactly one turn and then the
   *  card quietly takes its old name back, which reads as the rename having
   *  failed some time after it visibly worked.
   *
   *  Persisted, because the thing it protects against happens on the next turn
   *  of the next launch as readily as this one. Cleared by `clear`, along with
   *  the title it was protecting. */
  namedByHand = $state(false);
  /** No process behind this card yet. Drawn hollow — an absence, not a status. */
  dormant = $state(true);
  /** The process behind this card went away on its own, in this session.
   *
   *  This is what separates a crash from a card restored off disk. Both are
   *  dormant and both can be carrying `ending: "error"`, but only one of them is
   *  news: a card that failed three days ago is history the wall already shows,
   *  and announcing it as though it just happened is a false alarm. */
  died = $state(false);
  /** We are about to kill this child on purpose, so its exit is not news.
   *
   *  Killing a process on Windows gives it a non-zero exit code, and
   *  `markExited` reads one of those as a crash — so clearing a card raced its
   *  own teardown and stamped "process exited with code 1" and a rust ending on
   *  the fresh session that had just replaced it. The flag is set before the
   *  kill and cleared by whichever exit arrives, so the ordering does not
   *  matter. Not used by `close`, where the card leaves the wall anyway. */
  retiring = $state(false);
  /** True between the first event of a turn and its `result`. */
  working = $state(false);
  /** How the last turn ended. Null until one has. */
  ending = $state<Ending | null>(null);

  /** Has this conversation ever completed a turn? (`last_ending IS NOT NULL`.)
   *
   *  Deliberately *not* what decides resume vs fresh start when waking, though
   *  it used to be: a turn finishing and a transcript existing are different
   *  facts, and a card killed part-way through its first turn has the second
   *  without the first. `spawn_conversation` asks the disk instead. What this
   *  still answers is the questions it is actually about — whether there is
   *  anything to clear, and whether a blank panel means a fresh sheet or pages
   *  that are simply not here. */
  everSpoke = $state(false);
  activity = $state("dormant");

  /** When the fold of a full context started, if one is running.
   *
   *  A compaction is the one thing on this wire with no progress on it at all —
   *  one status event at each end and minutes of silence between (a real
   *  manual one here took 3m 08s) — so the card said `compacting` and then sat
   *  perfectly still, which is what a card that has hung looks like. Held so
   *  the wait can count itself out loud; see `doing`. */
  compactingSince = $state<number | null>(null);

  /** What this fold was predicted to take, in seconds, decided once when it
   *  began.
   *
   *  Once, deliberately: the estimate is a function of the occupancy at the
   *  start, and `ctxTokens` is about to be rewritten by the fold itself — so a
   *  live `$derived` would watch its own denominator collapse and the bar would
   *  leap backwards at the moment of success. It is also what makes the bar
   *  monotonic, which is the least a bar owes you. */
  compactEstimateS = $state(0);

  /** When the current rest began — the clock urgency decays against. */
  restingSince = $state<number | null>(null);

  /** Put by on purpose: kept on the wall, kept out of what is waiting.
   *
   *  Amber on this wall means *nobody has been back to this in a while*, which
   *  is a fair thing to say about a card you forgot and a false one about a
   *  card you parked — half-finished work you mean to return to, or a session
   *  held open for the context in it. Left as they were, those cards warm on
   *  the same clock as everything else and then take their turn in the waiting
   *  cycle, so the cycle stops being a list of things that want you.
   *
   *  It suppresses the *decay*, not the card: it is still on the wall, still
   *  resumable, still holding its transcript and its place, and speaking to it
   *  picks it straight back up (`Skein.#deliver`). Persisted, because the
   *  waiting cycle is the same on the next launch and because a card set aside
   *  must not be roused (`rousing.ts`). */
  aside = $state(false);

  /** A question the agent is *blocked* on, via our own ask_user MCP tool.
   *  Unlike every other tier this is not an inference: the turn is genuinely
   *  parked and nothing will happen until it is answered. */
  pendingAsk = $state<PendingAsk | null>(null);

  /** Subagents this card has convened, in the order they were spawned. */
  seats = $state<Seat[]>([]);

  /** Background work this card started that is still running.
   *
   *  Deliberately not persisted, and a restored card therefore has none. Skein
   *  only ever learns that a job finished by being *told* — the notification
   *  comes down the same stream as everything else — so a job it did not watch
   *  start is one it could never watch end, and a count restored off disk would
   *  be a number that only ever grew. */
  jobs = $state<Job[]>([]);

  /** Job arrivals and departures Skein has not written down yet.
   *
   *  Drained in `#wire`, not awaited anywhere: a row that fails to land costs
   *  the card a line in tomorrow's resume prompt, which is not worth failing an
   *  ingest for. **Not cleared by `markExited`** — the whole point is that the
   *  rows outlive the process, and a card whose stream just closed is exactly
   *  the one whose jobs nobody will ever hear the end of. */
  jobWrites = $state<JobWrite[]>([]);

  /** The agent's own plan for the turn, in the order the items were created. */
  plan = $state<PlanTask[]>([]);

  /** Is there background work in flight?
   *
   *  This is the second half of what `working` used to answer alone. `working`
   *  still means exactly what it meant — a turn is open — and everything that
   *  reads it (rousing, delivery, the interrupt) still wants that question. But
   *  the *card's colour* is asking something broader: is this card busy. An
   *  agent that backgrounded a thirteen-minute snapshot run and said "I'll
   *  commit once the suite is green" has ended its turn and has not finished
   *  its work, and it will be woken by the notification rather than by you. */
  busy = $derived(this.jobs.length > 0);

  /** A job reported in, and no turn followed.
   *
   *  The sentence above says the agent "will be woken by the notification", and
   *  it is right about half the time — see the measurement in `classify.ts`. A
   *  notification is enqueued rather than delivered, and nothing on this side
   *  dequeues it. So the state the wall had no word for is: this card has been
   *  told its work finished, and has not stirred.
   *
   *  It matters that this is separate from neglect. `#settleJob` already
   *  restarts the neglect clock when a job lands, so such a card *does* warm to
   *  amber eventually — but it warms exactly as a card that finished a turn and
   *  went quiet does, and the two want opposite things from you. One wants
   *  reading. The other wants a word, any word, to flush the queue. */
  unwoken = $state<{ at: number; count: number } | null>(null);

  /** Seconds since the notification nobody picked up. Zero when none waits. */
  unwokenSeconds = $derived(
    this.unwoken === null
      ? 0
      : Math.floor((clock.t - this.unwoken.at) / 1000),
  );

  /** Told, and did not stir — long enough now that it is not simply latency.
   *
   *  `aside` silences it for the reason `urgencyFor` silences everything else:
   *  a card you put by deliberately must not come back asking to be dealt with,
   *  and the counting has to stop in one place so the cycle, the dock and the
   *  colour cannot disagree about whether it did. */
  stalled = $derived(
    this.unwoken !== null && !this.aside && this.unwokenSeconds >= WAKE_GRACE_S,
  );

  /** A prompt that could not be sent because no account was allowed to take it,
   *  kept until one is.
   *
   *  A field on the card rather than a queue in `Skein` for the same reason
   *  `pendingHeal` is one: the card has to be able to sit here holding it, be
   *  drawn holding it, and be restored — and a hold that lived in the sender
   *  would vanish the moment anything re-rendered. `until` is when the first
   *  account is expected back, or null when no window named a reset and only
   *  the next allowance poll can say. */
  held = $state<{ text: string; why: string; until: number | null } | null>(null);

  /* The whole of `accounts.md` is over with `bypassCaps` and `accountLabel`;
     this one lives up here because `unacknowledged` below has to read it. */

  /** Prompts written to the child's stdin that the wire has never echoed back.
   *
   *  The count of `awaited` lines, kept rather than derived — the four places
   *  that touch the flag are the four that move this, and scanning `lines` on
   *  every tick to answer a question with an O(1) answer is not worth it.
   *
   *  `awaited` was added to stop a queued prompt being drawn twice and has
   *  never been read since. It happens to be the only honest record of a fact
   *  the wall badly needs: `--replay-user-messages` echoes a prompt back when
   *  the CLI *takes it up*, so a line still awaited is one written to stdin and
   *  not acted on. See `unacknowledged`. */
  awaiting = $state(0);

  /** Seconds this card has been at rest still owing an echo. Zero when it owes
   *  none, or is working — a turn underway is not a card ignoring you, even if
   *  the prompt it is running is not the one still waiting. */
  unacknowledgedSeconds = $derived(
    this.awaiting === 0 || this.working || this.restingSince === null
      ? 0
      : Math.floor((clock.t - this.restingSince) / 1000),
  );

  /** You sent something and the process never took it up.
   *
   *  The other half of `stalled`, arrived at from your end rather than the
   *  CLI's, and the more dangerous of the two because of what the transcript
   *  does in the meantime: `#settleEchoes` takes the `pending` mark off every
   *  waiting line as soon as the process speaks — which is right for the prompt
   *  that *caused* the turn and says nothing about one queued behind it. So the
   *  card comes to rest with your words drawn exactly like words that were
   *  delivered and answered, and until this nothing anywhere said otherwise.
   *
   *  Same grace as `stalled` and the same `aside` silence, for the same
   *  reasons. */
  unacknowledged = $derived(
    this.awaiting > 0 &&
      !this.aside &&
      /* A held prompt is awaited too — it keeps its `awaited` flag so the replay
         has a line to claim when the hold releases — but it is not lost in
         anybody's queue. Skein has it, deliberately, and the card is already
         saying so with a countdown. */
      this.held === null &&
      this.unacknowledgedSeconds >= WAKE_GRACE_S,
  );

  /** Skein should supply the nudge this card did not get.
   *
   *  A field rather than a callback, for the reason `pendingHeal` is one: the
   *  card must be able to come to rest holding it, and `conversation.svelte.ts`
   *  never talks to Rust.
   *
   *  `kind` is which silence this is — see `NudgeKind`. It decides the wording
   *  and, more importantly, what `#nudge` re-checks before it spends a turn. */
  pendingNudge = $state<{ attempt: number; kind: NudgeKind } | null>(null);

  /** Nudges spent since this card last started background work.
   *
   *  Deliberately *not* cleared when a turn opens, which is the obvious place
   *  and is wrong: a nudge is a prompt, a prompt opens a turn, and a budget
   *  reset there would be reset by its own spending every time — an allowance
   *  of two that can never reach two, and no bound at all on a card that keeps
   *  stalling. Cleared in `#job` instead, when the card starts something new,
   *  so the allowance is per generation of work rather than per turn. */
  nudgeAttempts = $state(0);

  /** The same allowance for the prompt case, counted apart.
   *
   *  Not cleared when a turn opens, for exactly the reason `nudgeAttempts` is
   *  not — a nudge *is* a prompt and would reset its own budget every time.
   *  Cleared in `#claimEcho` instead, and only when the last outstanding echo
   *  comes in — a nudge is a prompt of its own, so "one prompt was taken up" is
   *  a test a stuck card passes with your words still sitting behind the nudge
   *  in the queue. `awaiting` reaching zero is the honest moment. Same shape as
   *  `#job` clearing the other one. */
  promptNudgeAttempts = $state(0);

  /* context — the ring */
  ctxTokens = $state(0);
  contextWindow = $state(200_000);
  ctx = $derived(Math.min(1, this.ctxTokens / this.contextWindow));

  /** The window `system/init` declared, which is the only place the tier is
   *  visible. Null until init has arrived (or a row was restored). */
  #declaredWindow: number | null = null;

  /* transcript */
  lines = $state<Line[]>([]);
  /** Text arriving token-by-token, before the block closes. */
  streaming = $state("");

  /** Everything said before this card had a process to listen to, folded from
   *  the transcript on disk (see ./history.ts).
   *
   *  Kept apart from `lines` rather than prepended to it, for two reasons: the
   *  live fold stays exactly what the stream said, and the two can be read from
   *  once each. Loading happens once per Conversation *instance* — a card that
   *  is woken keeps appending to the same file it was read from, so re-reading
   *  after a turn would show every live line twice. A restart makes a fresh
   *  instance, which reads the file whole again, live lines and all. */
  history = $state<Line[]>([]);
  historyState = $state<"unread" | "loading" | "ready" | "none" | "error">(
    "unread",
  );
  /** The transcript was longer than what is shown — by bytes or by lines. */
  historyPartial = $state(false);

  /* bookkeeping */
  model = $state<string | undefined>(undefined);
  /** How hard this card has been told to think, where anything has said so.
   *
   *  Not from the wire — nothing on it carries an effort, which is the whole
   *  reason this is a field rather than a read of the last event. It arrives
   *  from the row at restore, from the CLI's own answer to `/effort`, and from
   *  the transcript on disk at a settling turn (`Skein.#adoptEffort`). */
  effort = $state<Effort | undefined>(undefined);
  /** The CLI has just said what the effort is, so the next read off disk is
   *  skipped: `/effort` writes no assistant record, and the file therefore
   *  still holds the level this one replaces. Spent on the next settling
   *  turn — one read, not the rest of the session. */
  effortStated = $state(false);
  /** The session's running total, as `result.total_cost_usd` reports it — not
   *  the last turn's. See `lastTurn` for that. */
  costUsd = $state(0);
  turns = $state(0);
  lastError = $state<string | null>(null);

  /* ── healing a turn that broke on the way out ───────────────────────────
   *
   * `wasMalformedRequest` in classify.ts is the whole of when, and why it is
   * safe; these three are the bookkeeping. The card decides that a turn is
   * worth trying again, and Skein does the trying — `conversation.svelte.ts`
   * folds events and never talks to Rust, so a class that re-sent its own
   * prompts would be reaching straight through that boundary. */

  /** The last prompt *this window* sent, and so the only text a heal may
   *  repeat. Null on a card being driven from a terminal. */
  #lastSent: string | null = null;

  /** Attempts spent healing the turn in hand. Reset by any turn that ends some
   *  other way, so the budget is per-turn and not per-card — a card that healed
   *  once this morning starts the afternoon with its full two. */
  healAttempts = $state(0);

  /** Set when the turn that just ended is worth another go, read and cleared by
   *  Skein. A field rather than a callback because the card must be able to
   *  come to rest holding one: the wall's tick, the ledger and the persistence
   *  all run off this same `result`, and a re-send fired from inside `ingest`
   *  would land in the middle of them. */
  pendingHeal = $state<{ text: string; attempt: number; kind: HealKind } | null>(null);

  /* ── which subscription this card spends ────────────────────────────────
   *
   * `.claude/rules/accounts.md`. All three are read by `skein.svelte.ts`, which
   * is the only place that talks to Rust; a `Conversation` never spawns
   * anything and so never sets these itself. */

  /** The account this card's process was spawned with, or null for whoever
   *  Claude Code is signed in as. This is what `choose`'s stickiness sticks
   *  to — a card mid-conversation stays on its account while that account is
   *  still allowed, rather than moving back the moment a better-ranked one
   *  frees up and paying the uncached re-read twice. */
  accountLabel = $state<string | null>(null);

  /** This card ignores the caps you set. It still cannot cross the accounts'
   *  own limits, because nothing can — a bypassed card with every subscription
   *  genuinely spent is held exactly like any other. */
  bypassCaps = $state(false);


  /* ── the gear ──────────────────────────────────────────────────────────────
   *
   * Whether this card has the machine or is only reading. `gears.ts` has the
   * vocabulary and what was probed to establish it. */

  /** Making, or planning. Folded off `system/init`'s `permissionMode`, which the
   *  CLI re-emits on every change — so this is right for a card Volery put into
   *  planning, for a card that came back from a rouse in the gear it was left
   *  in, and for one something else changed under us. */
  gear = $state<Gear>(DEFAULT_GEAR);

  /** A gear the wire has acknowledged but no `system/init` has yet agreed with.
   *
   *  The two events disagree for a while and this is what resolves them. A
   *  `control_response` confirms a change in about 60ms; a `system/init` is
   *  emitted per *turn* and reports the mode that turn is running under — so an
   *  init belonging to a turn that was already in flight names the old mode, and
   *  folding it would flip the card back. Measured; see `gears.ts`.
   *
   *  While this is set, inits that disagree are ignored as stale and the one
   *  that agrees clears it, after which inits fold normally again — which is
   *  what keeps a card put into planning by something that is not Volery drawn
   *  correctly. Cleared when the process goes, so a change that never took
   *  effect cannot deafen this card to inits for the rest of its life. */
  #pendingGear: Gear | null = null;

  /** Take a gear the wire has confirmed, or one an init reported.
   *
   *  The deciding is `gears.ts`'s — pure, and tested there, because which of
   *  two disagreeing events to believe is exactly the kind of rule that is
   *  wrong in a way nothing notices. This holds the two fields and the one
   *  consequence that is not about gears at all. */
  #foldGear(next: GearState) {
    /* Coming back into making retires the plan. A card wearing "a plan is
       waiting" after the plan has been acted on is a badge that stops meaning
       anything, and this is the moment it was acted on. Guarded on a *change*
       so an event arriving mid-making does not clear a plan a making card has
       yet to be pointed at. */
    if (next.gear !== this.gear && next.gear === "making") this.planDoc = null;
    this.gear = next.gear;
    this.#pendingGear = next.pending;
  }

  /** Take a gear the wire has acknowledged. */
  ackGear(gear: Gear) {
    this.#foldGear(afterAck({ gear: this.gear, pending: this.#pendingGear }, gear));
  }

  /** The newest plan document this card has written, or `null`.
   *
   *  Kept as a path rather than as content: the panel already knows how to open
   *  a markdown file as a document (`finding.ts`, `Spyglass.svelte`), so what a
   *  card owes is the name of the thing to open. Cleared when the card is put
   *  back into making, because a plan that has been acted on is history and a
   *  card wearing "a plan is waiting" for the rest of the day is a badge that
   *  stops meaning anything. */
  planDoc = $state<string | null>(null);


  /* ── the original a repair is keeping ──────────────────────────────────────
   *
   * A repair rewrites the session file, so Skein keeps the untouched original
   * beside it. These two decide when to stop: `repair.ts` for why it is not
   * straight away, and `Skein.#settleRepair` for the doing of it. Fields rather
   * than a callback for the same reason `pendingHeal` is one. */

  /** An untouched original is being kept for this card. */
  repairKept = $state(false);

  /** Turns that have gone well since the repair. A repair that broke the
   *  session shows up as the *next* turn failing, so this is the evidence. */
  goodTurnsSinceRepair = $state(0);

  /** Set when those turns have added up, read and cleared by Skein. */
  pendingBackupDiscard = $state(false);

  /** What the turn that just settled actually spent, read off `result.usage`.
   *
   *  This is the one place `result.usage` is the right number and the ring is
   *  not: it sums every iteration of the turn, which is why `ctxTokens` must
   *  never come from it (see the `assistant` arm) and exactly why a *turn* row
   *  must. The four counts are kept apart because their prices differ by more
   *  than an order of magnitude — a cache read is 0.1x input, a cache write
   *  1.25x — so any total that adds them is a number nobody can act on.
   *
   *  `usd` is a delta, not a reading. `total_cost_usd` is a running total and
   *  the turn's own cost is the step it took; `#costAtLastTurn` holds the
   *  previous value to subtract.
   *
   *  **What it is a running total *of* is the process, not the session**, and
   *  the difference is a turn's cost. Probed 2026-08-25 with
   *  `tools/probe-cost.ts`, spawning with Skein's exact argv: one small turn on
   *  a fresh session reported `0.2542635`, and the same session `--resume`d in a
   *  second process reported `0.225298` for its next small turn — *lower*, so
   *  the counter had started again rather than carrying the session's history.
   *
   *  A `Conversation` outlives its process — an account move ends the child and
   *  wakes it (`#moveTo`), a crashed card is woken again — so the baseline is
   *  routinely above the number the new process is counting from. That was
   *  clamped to zero, which quietly booked the first turn of every new process
   *  at nothing: nine such turns on 2026-08-24, one of them 4.7M cache reads
   *  wide. A counter that went *down* has restarted, and its current value is
   *  the whole of what this process has spent — which is this turn, since a new
   *  process has taken no other. So that is the step, and the clamp is gone
   *  along with the case it was standing in for.
   *
   *  Note what this does not fix: a `result` carrying a cost and no `usage` at
   *  all (a prompt the CLI answered itself — see `#claimLocalCommand`) still
   *  books the accumulated step onto a turn with no tokens to explain it. Four
   *  of those on 2026-08-24. They are honest about the money and misleading
   *  about the turn. */
  lastTurn = $state({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });
  #costAtLastTurn = 0;

  /** Text blocks seen in the current turn, used to classify how it ended. */
  #turnText: string[] = [];
  #sawAskTool = false;

  /** `TaskCreate` calls whose receipt has not yet named their number. */
  #creating = new Map<string, { subject: string; activeForm: string }>();

  /** Set when this conversation lives in its own git worktree. The card shows
   *  it, because "which tree am I editing" is the thing you most need to know
   *  when several agents share one repo. */
  readonly worktree: string | null;

  /** What this card *is*. A `chat` card was opened outside any project and is
   *  spawned with no tools but the two web ones (`supervisor.rs::chat_argv`),
   *  so it can look things up and can reach nothing on this machine.
   *
   *  Read-only, like `worktree`: it is decided when the card is made, the store
   *  is what remembers it, and the argv is built from the store rather than
   *  from this — so a card cannot talk its way into a fuller toolset by having
   *  this field changed. */
  readonly kind: ConvKind;

  constructor(
    id: string,
    cwd: string,
    projectId = "",
    worktree: string | null = null,
    kind: ConvKind = "project",
  ) {
    this.id = id;
    this.sessionId = id;
    this.cwd = cwd;
    this.projectId = projectId;
    this.worktree = worktree;
    this.kind = kind;
    const base = basename(cwd) || cwd;
    /* Not the basename for a chat card. Its cwd is a folder of Skein's own that
       happens to be called `chat`, and drawing that would be the card claiming
       a project it does not have — the day the folder is renamed, every chat
       card on the wall would relabel itself. */
    this.project =
      kind === "chat" ? "chat" : worktree ? `${base} · ${worktree}` : base;
  }

  /** Rebuild a card from its database row, with no process behind it.
   *
   *  This is what makes lazy restore feel instant: the wall is fully painted —
   *  title, project, position, and the context it reached — before a single
   *  `claude` has been spawned. A card at 88% can warn you before you ever wake
   *  the session it belongs to. */
  static restore(row: {
    id: string;
    agent_session_id?: string | null;
    cwd: string;
    project_id: string;
    title: string;
    model: string | null;
    interrupted: boolean;
    last_ctx_frac: number;
    last_ending: string | null;
    worktree?: string | null;
    aside?: boolean;
    kind?: string | null;
    named_by_hand?: boolean;
    /** Optional because a row written before schema v16 has neither. */
    account_label?: string | null;
    bypass_caps?: boolean;
    effort?: string | null;
    /** Optional because a row written before schema v23 has no gear. */
    permissionMode?: string | null;
  }): Conversation {
    const c = new Conversation(
      row.id,
      row.cwd,
      row.project_id,
      row.worktree ?? null,
      /* Anything but `chat` is a project card, including a row from before the
         column existed and a value from a build newer than this one. The
         unknown case has to fall to the *narrower* reading of the card and the
         *fuller* toolset it already had, never the other way round: a chat card
         drawn as a project card is a mislabel, a project card silently spawned
         as chat is a card that has quietly lost its tools. */
      row.kind === "chat" ? "chat" : "project",
    );
    /* The column has been written since v1 and read by nobody until clearing
       gave the two ids a reason to differ. A row from before then holds its own
       id, so the fallback is belt and braces rather than a migration. */
    c.sessionId = row.agent_session_id || row.id;
    c.title = row.title || UNNAMED;
    /* A row from before the column existed defaults to false, which is the
       truth about it: no card was ever named by hand before there was a way
       to do it. */
    c.namedByHand = row.named_by_hand ?? false;
    c.model = row.model ?? undefined;
    /* Guarded rather than cast: the column is free text, and a level from a
       newer build is one this one cannot describe. Nothing beats showing a
       word the footer has no place for. */
    c.effort = isEffort(row.effort) ? row.effort : undefined;
    c.contextWindow = contextWindowFor(c.model);
    /* A row written before we knew about the tier suffix says 200k when the
       session was really 1M. `system/init` corrects it the moment it wakes. */
    if (c.model) c.#declaredWindow = c.contextWindow;
    c.ctxTokens = Math.round(row.last_ctx_frac * c.contextWindow);
    c.interrupted = row.interrupted;
    c.dormant = true;
    c.everSpoke = row.last_ending !== null;
    c.ending = (row.last_ending as Ending | null) ?? "ok";
    c.aside = row.aside ?? false;
    /* Restored so `choose`'s stickiness survives a restart. Without it every
       card comes back unattached, and the first send moves the whole wall onto
       the first account at once — every conversation re-read uncached, for
       nothing. A row from before the column existed is null, which is the truth
       about it: that card was spawned as whoever was signed in. */
    c.accountLabel = row.account_label ?? null;
    c.bypassCaps = row.bypass_caps ?? false;
    /* A dormant card emits no `system/init`, so the gear cannot be folded — the
       whole wall would come back drawn as making until each card was woken.
       A row from before the column existed is null, which is the truth about
       it: no card had a gear to be in. */
    c.gear = gearOfWire(row.permissionMode ?? "bypassPermissions");
    c.activity = row.interrupted ? "interrupted" : "dormant";
    return c;
  }

  idleSeconds = $derived(
    this.restingSince === null
      ? 0
      : Math.floor((clock.t - this.restingSince) / 1000),
  );

  /** The activity line, which is `activity` plus the one wait that has to count
   *  itself.
   *
   *  Everywhere else the word is enough, because something under it is moving:
   *  deltas arrive, tool calls land, the plan advances. A compaction has none of
   *  that — the wire says `compacting` and then says nothing for minutes — so
   *  the word alone is indistinguishable from a card that has stopped. The
   *  clock is the existing one-second tick every card already reads for
   *  neglect, so this costs no timer.
   *
   *  Both readers of the activity line go through here (the card's label and the
   *  panel's live edge) rather than one of them appending the count, or the wall
   *  and the panel would disagree about how long you had been waiting. */
  /** How long this fold has been going, in seconds. Zero when none is. */
  compactingFor = $derived(
    this.compactingSince === null
      ? 0
      : Math.max(0, (clock.t - this.compactingSince) / 1000),
  );

  doing = $derived.by(() => {
    /* Ahead of the fold, because a card cannot be both and the amber is about
       to say something needs doing — leaving the line as the job's own summary
       would have the colour claiming one thing and the words another. The
       summary is kept and appended to rather than replaced: the CLI's sentence
       names what finished, which is most of what you want to know, and only
       the fact that nothing acted on it is missing. */
    /* Ahead of everything, because a card holding a prompt is not doing any of
       the other things below and the countdown is the only reading that says
       when it will stop. `until` null is a blocker that named no reset, which
       the allowance poll is the only way out of — so the line says the state
       and stops rather than inventing a time. */
    if (this.held) {
      const when = this.held.until === null ? null : until(this.held.until - clock.t);
      return when ? `${this.held.why} · ${when}` : this.held.why;
    }
    if (this.stalled) return `${this.activity} · not picked up`;
    /* Below `stalled`, which is the one that has a job's own summary to append
       to and so has more to say. Both are the same amber and the same request:
       give this card a word. */
    if (this.unacknowledged) return `${this.activity} · ${UNACKNOWLEDGED_LINE}`;
    if (this.compactingSince === null) return this.activity;
    const line = `${this.activity} · ${spanOf(this.compactingFor)}`;
    /* Said in words, because a bar that has been nearly full for a minute and a
       half has stopped telling you anything — worse, it is telling you the
       wrong thing, since what is actually true at that point is that the
       prediction was wrong rather than that the fold is nearly done. */
    return compactLate(this.compactingFor, this.compactEstimateS)
      ? `${line} · longer than usual`
      : line;
  });

  /** How full to draw the bar, 0–1, or null when there is no bar to draw.
   *
   *  It never reaches 1 on its own — see `compactFill`. The only thing that
   *  fills it is the fold actually ending, which is drawn by the bar going
   *  away rather than by it completing. */
  compactFrac = $derived(
    this.compactingSince === null
      ? null
      : compactFill(this.compactingFor, this.compactEstimateS),
  );

  /** The card's colour. Derived, never assigned — so a card that nobody
   *  touches warms on its own as it is neglected.
   *
   *  A parked question outranks everything, including `working`: the turn is
   *  technically still open, but nothing is happening and won't until you
   *  answer. That is the loudest thing a card can be.
   *
   *  `aside` goes in here rather than being filtered out at each of the places
   *  that read a tier, so that the cycle, the dock's count, the peek and the
   *  card's own colour cannot disagree about it — a card left out of the
   *  waiting list while still blooming amber would be the wall arguing with
   *  itself. `urgencyFor` decides what it does and does not silence. */
  /*  `busy` sits *below* a broken turn and above everything else. A turn that
   *  errored is news and rust is the colour that says so, and letting a
   *  background job paint over it would be the one case where celadon means
   *  "fine" on a card that is not. `working` stays on top of both, unchanged: a
   *  turn underway is the current state of the card whatever the last one did. */
  tier = $derived<Tier>(
    this.pendingAsk
      ? "ask"
      : this.working
        ? "work"
        : this.ending === "error"
          ? "fail"
          : this.busy
            ? "work"
            : /* Told, and did not stir. Amber because this is a card genuinely
                 waiting on you — the same thing a parked question is, arrived
                 at from the other end — and it sits *below* `busy` because a
                 card with other work still running is honestly working, not
                 waiting. Above `urgencyFor`, because that would draw it as
                 ordinary neglect on the clean-finish clock and take five
                 minutes to say anything at all. */
              /* And the same state reached from your end: a prompt written to
                 stdin that the process never echoed back. It sits here rather
                 than below `ending` because that would draw it as ordinary
                 neglect — five minutes to say something known in twelve
                 seconds, about a card whose transcript is meanwhile claiming
                 the prompt arrived. */
              this.stalled || this.unacknowledged
              ? "ask"
              : /* A card holding a prompt against an allowance reset. Quiet on
                   purpose, and here rather than left to `urgencyFor` so that it
                   cannot warm: this is not neglect, it is a card nothing you do
                   will move — and amber that persists for the four hours until a
                   five-hour window turns over is amber you learn to ignore. What
                   it *is* doing, and until when, is on its face. */
                this.held
                ? "rest"
                : this.ending
                ? urgencyFor(this.ending, this.idleSeconds, this.aside)
                : "rest",
  );

  /** How far the plan has got. Both counted here so the card cannot draw a
   *  denominator from one reading and a numerator from another. */
  planDone = $derived(this.plan.filter((t) => t.status === "completed").length);

  /** What to say on a card whose turn has ended but whose work has not. */
  #jobsLine(): string {
    const [first] = this.jobs;
    if (!first) return "at rest";
    return this.jobs.length === 1
      ? `running · ${first.label}`
      : `${this.jobs.length} jobs running`;
  }

  /** The plan item in hand, if the agent has said which. */
  #planLine(): string | null {
    const active = this.plan.find((t) => t.status === "in_progress");
    return active?.activeForm || active?.subject || null;
  }

  #job(toolId: string, patch: Omit<Job, "toolId">) {
    const i = this.jobs.findIndex((j) => j.toolId === toolId);
    if (i < 0) {
      this.jobs = [...this.jobs, { toolId, ...patch }];
      /* New work, new allowance — see `nudgeAttempts` for why this is here and
         not in `#beginTurn`. A card that starts a job has demonstrably been
         picked up, whatever happened to the last one. */
      this.nudgeAttempts = 0;
    } else this.jobs[i] = { ...this.jobs[i], ...patch };
    /* Persisted on the receipt and never on the call. A `starting` job is one
       the agent said it *meant* to background, and an `Agent` that ran inline
       after all arrives here first and is dropped a moment later — a row
       written then would be a job that never existed, reported as lost at the
       next launch. The receipt is also the only place a path is ever named. */
    if (patch.state === "running") {
      this.jobWrites = [
        ...this.jobWrites,
        {
          op: "record",
          toolId,
          taskId: patch.taskId,
          kind: patch.kind,
          label: patch.label,
          outputPath: patch.outputPath,
        },
      ];
    }
  }

  #dropJob(toolId: string) {
    this.jobs = this.jobs.filter((j) => j.toolId !== toolId);
  }

  /** A job reported in. The CLI's summary is already the sentence worth
   *  drawing, and it is `meta` because it is the CLI talking about the
   *  conversation — the register the stop note and the resume note are in.
   *
   *  Matched on the tool_use id, then on the CLI's own job id. A notification
   *  naming neither is still drawn: it is a job started before this window was
   *  watching, or one whose receipt was missed, and the news is worth more than
   *  the bookkeeping. What it must not do is guess which job it was and drop
   *  one at random — a card would then report the wrong thing as finished and
   *  go on holding a count for something that had. */
  #settleJob(note: TaskNote, summary: string) {
    const hit = this.jobs.find(
      (j) =>
        (note.toolId && j.toolId === note.toolId) ||
        (note.taskId && j.taskId === note.taskId),
    );
    if (hit) {
      this.#dropJob(hit.toolId);
      /* Heard the end of it, so nothing needs telling about it tomorrow. Keyed
         on the tool_use id because that is what the row was written under —
         a notification matched by its `taskId` still settles the right row,
         since `hit` is the job and not the note. */
      this.jobWrites = [...this.jobWrites, { op: "settle", toolId: hit.toolId }];
      /* A backgrounded subagent holds a seat as well as a job, and this is the
         only thing that ever closes it — its tool_result was a launch receipt,
         not an answer. A workflow's crowd closes here too, and here only: it is
         the one seat that is never heard from at all, so the CLI's own
         `Dynamic workflow "…" completed` is the whole of its verdict. */
      if (this.seats.some((s) => s.id === hit.toolId)) {
        this.#closeSeat(hit.toolId, summary);
      }
    }
    this.#push("meta", jobNote(summary));
    /* Nothing is warming while a job runs, so the neglect clock has to start
       when the last one lands rather than back when the turn ended — otherwise
       a card whose job ran twenty minutes blooms amber the instant it finishes,
       for a wait nobody was subject to. A turn opening in response resets this
       again through `#beginTurn`, which is the ordinary case. */
    if (!this.working && !this.busy) {
      this.restingSince = Date.now();
      this.activity = clip(summary, 44);
      /* The notification is in the CLI's input queue, not in the model's
         hands, and nothing on this side takes it out again — so from here the
         card is *told and not stirring* until a turn opens. `#beginTurn` is
         what clears this, whoever caused it: the agent waking on its own is the
         ordinary case and wants no special path.
         The moment is re-stamped on every notification, because a second job
         landing is a second chance for the queue to be flushed and the grace
         should be measured from the newest one. */
      const fresh = this.unwoken === null;
      this.unwoken = {
        at: Date.now(),
        count: fresh ? 1 : this.unwoken!.count + 1,
      };
      if (this.nudgeAttempts < NUDGE_BUDGET) {
        this.pendingNudge = { attempt: this.nudgeAttempts + 1, kind: "job" };
      } else if (fresh) {
        /* Only on a new stall, or a card whose budget is spent would repeat
           the line for every further job that reported into the silence. */
        this.#push("meta", nudgeGaveUpNote());
      }
    } else if (!this.working) {
      this.activity = this.#jobsLine();
    }
  }

  /** Create or update a seat. Seats are keyed by the parent's tool_use id,
   *  which is the only identity a forwarded subagent message carries. */
  #seat(id: string, patch: Partial<Omit<Seat, "id">>) {
    const i = this.seats.findIndex((s) => s.id === id);
    if (i < 0) {
      this.seats = [
        ...this.seats,
        {
          id,
          persona: patch.persona ?? "seat",
          state: patch.state ?? "spawning",
          thought: patch.thought ?? "",
          verdict: patch.verdict ?? null,
          ...(patch.crew ? { crew: patch.crew } : {}),
        },
      ];
      return;
    }
    this.seats[i] = { ...this.seats[i], ...patch };
  }

  /** The subagent finished — its bubble collapses to one line of verdict. */
  #closeSeat(id: string, result: string) {
    this.#seat(id, { state: "done", verdict: clip(result, 90) });
  }

  /** Adopt a model id, and with it the size of the ring.
   *
   *  `declared` marks the id from `system/init` — the only one that carries the
   *  window tier. A per-message id naming the same model tells us nothing new
   *  and must not narrow the window: taking it at face value is what made a 1M
   *  session read 46% when it was really at 9%. A per-message id naming a
   *  *different* model is a real change (a fallback model took the request) and
   *  is adopted whole. */
  #adoptModel(model: string, declared: boolean) {
    if (!declared && this.#declaredWindow !== null && sameModel(model, this.model)) {
      return;
    }
    this.model = model;
    this.contextWindow = contextWindowFor(model);
    if (declared) this.#declaredWindow = this.contextWindow;
  }

  /** Returns the line *as the array holds it*, which is the proxy rather than
   *  the object passed in — a `!` run keeps writing into its line as output
   *  arrives, and mutating the raw object would change nothing anybody is
   *  watching. Every other caller ignores the return. */
  #push(
    kind: Line["kind"],
    text: string,
    state?: Line["state"],
    note?: string,
    call?: ToolCall,
  ): Line {
    const line: Line = { kind, text };
    if (state) line.state = state;
    if (note) line.note = note;
    if (call) line.call = call;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
    return this.lines[this.lines.length - 1]!;
  }

  /** Hand a result to the call that asked for it.
   *
   *  Searched backwards, and that is the whole of the design: a result arrives
   *  within a message or two of its call, so the line is nearly always the last
   *  one or close to it, and the walk stops at the first match. Keeping a
   *  `Map<toolId, Line>` instead would be O(1) and wrong — `#push` slices the
   *  array at `MAX_LINES` and the map would go on holding lines that have
   *  fallen off the front, which is the leak that shape always is.
   *
   *  A call whose line has already been sliced away simply never lands, and
   *  nothing says so: the line it would have said it on is not on the page. */
  #land(toolId: string, text: string, failed: boolean) {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const call = this.lines[i].call;
      if (call?.id === toolId) {
        call.result = landed(text, failed);
        return;
      }
    }
  }

  /** What the last `compact_boundary` said it cost, waiting for the summary it
   *  labels. The numbers and the words are two events apart and the cap wants
   *  both, so the first is held until the second arrives. */
  #compacted: string | null = null;

  /* ── your half of the conversation ─────────────────────────────────────
   *
   * A prompt is on the wall the instant you send it, and the wire's echo
   * (`--replay-user-messages`) then *claims* that line rather than adding a
   * second copy of it.
   *
   * It used to be the echo alone that put your words in the transcript, on the
   * argument that nothing should be drawn the agent had not received. The
   * argument was right about honesty and wrong about where to spend it: waking
   * a dormant card spawns a process and resumes a session before the prompt can
   * even be written, so what you got for it was a transcript that swallowed
   * what you typed for a second or more, with the draft already cleared. The
   * honesty is kept instead by saying which it is — a pending line is marked as
   * pending and a send that fails says so, rather than being distinguished by
   * not existing. */

  /** Draw a prompt as sent, before anything has carried it. */
  echo(text: string) {
    /* Kept for the heal, and only ever set here — which is the whole of what
       makes a heal safe to offer. A prompt this window sent is one it can send
       again; a `user` event with no line waiting for it came from a terminal
       appending to the same session (see the `user` arm below), and re-sending
       *that* would be Skein putting words into a conversation it is not
       holding. So a card driven from somewhere else fails rust, as it always
       did, and only what you typed here is ever repeated. */
    this.#lastSent = text;
    this.#push("you", text, "pending");
    this.lines[this.lines.length - 1]!.awaited = true;
    this.awaiting += 1;
    /* The turn starts when you send, which is the same rule the echo used to
       apply — only now it applies from the gesture rather than from the
       acknowledgement. `echoFailed` takes it back if nothing ever left. */
    if (!this.working) this.#beginTurn();
    this.activity = this.dormant ? "waking…" : "sending…";
  }

  /** The oldest copy of a prompt still answering to `held`.
   *
   *  Oldest first, because delivery is sequential: with the same words sent
   *  twice, the echo and any failure both belong to the earlier of them. The
   *  predicate is passed in because a claim and a failure no longer ask the
   *  same question of a line — see `#settleEchoes`. */
  #echoOf(text: string, held: (l: Line) => boolean): Line | undefined {
    const want = text.trim();
    return this.lines.find(
      (l) => l.kind === "you" && held(l) && l.text.trim() === want,
    );
  }

  /** The process has our words — the line stands as an ordinary one, and the
   *  books are closed on it. */
  #claimEcho(text: string): boolean {
    const line = this.#echoOf(text, (l) => l.awaited === true);
    if (!line) return false;
    line.state = undefined;
    line.awaited = undefined;
    this.awaiting = Math.max(0, this.awaiting - 1);
    /* Only once *everything* sent has been acknowledged, which is not the same
       as one prompt being taken up — and the difference is the whole budget. A
       nudge is itself a prompt, so a card that took the nudge and left your
       words behind it in the queue would have claimed an echo, reset the
       allowance to nothing spent, and been nudged again for as long as it went
       on doing that. An unbounded loop of real turns, on a card that is failing
       in precisely the way the loop was built for. */
    if (this.awaiting === 0) this.promptNudgeAttempts = 0;
    return true;
  }

  /** Close the books on a prompt the CLI answered itself.
   *
   *  The one acknowledgement that never comes — `localCommandAwaiting` has the
   *  probe. Routed through `#claimEcho` rather than clearing the line here, so
   *  the awaiting count and the budget refund stay in one place: the difference
   *  between this and an ordinary echo is only *which* line, never what closing
   *  it means. */
  #claimLocalCommand(): boolean {
    const awaited = this.lines
      .filter((l) => l.kind === "you" && l.awaited === true)
      .map((l) => l.text);
    const hit = localCommandAwaiting(awaited);
    return hit === null ? false : this.#claimEcho(hit);
  }

  /** Anything still pending when the process speaks has plainly arrived, even
   *  if its echo did not match character for character. Proof of receipt is
   *  proof of receipt, and a mark left up after the answer has come back would
   *  be reporting a doubt nothing holds.
   *
   *  But being answered does not say *which* prompt was answered, and that is
   *  where this drew your words twice. Send into a card that is already working
   *  and the CLI queues the prompt behind the running turn; that turn goes on
   *  speaking, every message of it settled the line waiting below — and when the
   *  queued prompt was finally taken up minutes later, its replay found nothing
   *  pending to claim and pushed a second copy of what you had typed, right
   *  under the tool call it had been waiting on. So settling takes the *doubt*
   *  off the line and nothing more: `awaited` stays, and the echo still has its
   *  line to claim whenever it comes. */
  #settleEchoes() {
    for (const l of this.lines) {
      if (l.kind === "you" && l.state === "pending") l.state = undefined;
    }
  }

  /** Nothing more will come down this stream, so nothing still awaited ever
   *  will be. Left claimable, those lines would be claimed by the next send of
   *  the same words — which would then draw nothing at all.
   *
   *  Two exceptions, and they are the same exception said twice: **a prompt
   *  that was never written to this stream in the first place.** The stream
   *  closing says nothing about one of those, and forgetting it here has Skein's
   *  own re-send draw your words a second time — on the paths where Skein,
   *  rather than you, decides to send them.
   *
   *  - The prompt being **held**. `echoHeld` keeps its line awaited precisely so
   *    `releaseHeld` can send it later and have the replay claim it.
   *  - Anything still **pending** when the process is being *retired*, which is
   *    `keepUnsent`. A retirement is Skein ending the child on purpose — moving
   *    the card to another account, or restarting it to pick up a repair — and
   *    in both cases the send that caused it has not happened yet:
   *    `#settleAccount` runs *ahead* of `send_prompt`, so the line was echoed
   *    and then the process closed underneath it. Observed 2026-08-21: a card
   *    moved from `lyss` to `tx-team` drew `go`, the swap note, and then `go`
   *    again, because the replay from the resumed process found nothing left
   *    awaited to claim.
   *
   *  `pending` is the right test for the second and `awaited` is not, because
   *  they answer different questions here. A line that is awaited but no longer
   *  pending is one an earlier message already settled — it went down this wire
   *  and is owed only its echo, which will never come now. A line still pending
   *  when *we* pulled the process is one nothing carried. */
  #forgetEchoes(keepUnsent = false) {
    const holding = this.held?.text.trim();
    let kept = 0;
    for (const l of this.lines) {
      if (!l.awaited) continue;
      if (holding !== undefined && l.text.trim() === holding) {
        kept += 1;
        continue;
      }
      if (keepUnsent && l.state === "pending") {
        kept += 1;
        continue;
      }
      l.awaited = undefined;
    }
    this.awaiting = kept;
    /* Nulled whatever survives above: a card with no process cannot be nudged,
       and a held prompt is waiting on an allowance rather than on a flush. */
    this.pendingNudge = null;
  }


  /** Nothing carried it *yet* — Skein is holding it deliberately, and will send
   *  it when an account frees up.
   *
   *  The line stays exactly as `echo` drew it: still `pending`, because it is,
   *  and still `awaited`, because when the hold releases `#deliver` writes this
   *  very text to stdin and the replay has to have a line to claim. Clearing
   *  `awaited` here would make that echo find nothing and push a second copy of
   *  your prompt — the same double-draw `#settleEchoes` was rewritten to avoid.
   *
   *  What it *does* take back is the turn. `echo` opens one from the gesture, on
   *  the reasoning that a prompt you sent is a turn beginning; a prompt that
   *  never left is not. Left open, the card read celadon and `working` for as
   *  long as the hold lasted — up to a five-hour window — which is the wall
   *  claiming a card is burning tokens while it sits doing nothing. Worse, both
   *  `#heal` and `#nudge` refuse a working card, so the two mechanisms that
   *  could have got it moving again were the two the stuck state locked out.
   *
   *  Same guard as `echoFailed`: if something in this turn has already spoken,
   *  the turn is real and belongs to an earlier prompt. */
  echoHeld(why: string) {
    if (!this.streaming && this.#turnText.length === 0) {
      this.working = false;
      this.restingSince ??= Date.now();
    }
    this.activity = why;
  }

  /** The hold released — the line drawn a while ago is going down the wire now.
   *
   *  `echoHeld` gave the turn back when the prompt was held; this takes it again
   *  at the moment it is actually sent, which is the same rule `echo` follows
   *  from the gesture. Without it the card sat at rest with a prompt on the wire
   *  until the first event answered, and `unacknowledged` would have started
   *  counting against it. */
  echoResumed() {
    if (!this.working) this.#beginTurn();
    this.activity = "sending…";
  }

  /** Nothing carried it: the line says so and stays where it was written, so
   *  what you typed is still there to copy out of. Matched on what is *drawn* —
   *  a send that failed is one still marked pending, never an older copy of the
   *  same words that has been answered and is merely waiting on its echo. */
  echoFailed(text: string, why: string) {
    const line = this.#echoOf(text, (l) => l.state === "pending");
    if (line) {
      line.state = "failed";
      if (line.awaited) this.awaiting = Math.max(0, this.awaiting - 1);
      line.awaited = undefined;
    }
    /* The turn `echo` opened never began — unless something else in it has
       already spoken, in which case a failed send is a second prompt into a
       card that is genuinely busy and `working` is still the truth. */
    if (!this.streaming && this.#turnText.length === 0) {
      this.working = false;
      this.restingSince ??= Date.now();
    }
    this.activity = why;
  }

  /* ── `!` runs ──────────────────────────────────────────────────────────
   *
   * A command you ran in this card's directory rather than said to its agent.
   * Only the *drawing* is here: what a shell is, how one is spawned and what it
   * printed are `bang.svelte.ts`'s and `bang.rs`'s, and this end knows none of
   * it. One line per run, written into as the output arrives — see
   * `.claude/rules/bang.md`.
   *
   * Deliberately not persisted, and it is a real limit rather than an oversight:
   * `history` is read back out of the session file `claude` itself writes, and a
   * command Skein ran is in nobody's session file. So a run is on the wall for
   * as long as the card is, and a restored card comes back without it. */

  /** The command a `!` run is executing here, or null. Read by the dock, which
   *  has to say that Escape will stop it. */
  bangCmd = $state<string | null>(null);
  /** The line being written into. Held rather than looked up by index, because
   *  `lines` is sliced from the front past MAX_LINES and an index would quietly
   *  start naming a different line. */
  #bangLine: Line | null = null;

  /** Draw a run as started, before it has said anything.
   *
   *  Drawn at once, the same call `echo` makes and for the same reason: a shell
   *  takes half a second to exist and a card that showed nothing until the first
   *  byte of output would look as though the key had not registered. */
  bangOpen(cmd: string, cap: string) {
    this.bangCmd = cmd;
    this.#bangLine = this.#push("shell", "", "pending", cap);
  }

  /** More of what it has printed, and what the cap should now say.
   *
   *  Both at once because they change together — the cap carries the line count
   *  — and because the caller has already capped the text, which is the only
   *  thing that knows how much was dropped. */
  bangDraw(text: string, cap: string) {
    const line = this.#bangLine;
    if (!line) return;
    line.text = text;
    line.note = cap;
  }

  /** The run ended.
   *
   *  `failed` marks the *command*, which is the whole of `shell.md`'s argument
   *  about where a failure belongs: which line failed is a question you ask
   *  having scrolled past a screenful of what it printed, so the answer wants to
   *  be at the top of that screen rather than somewhere in the middle of it. */
  bangClose(text: string, cap: string, failed: boolean) {
    const line = this.#bangLine;
    this.bangCmd = null;
    this.#bangLine = null;
    if (!line) return;
    line.text = text;
    line.note = cap;
    line.state = failed ? "failed" : undefined;
  }

  #beginTurn() {
    this.#turnText = [];
    this.#sawAskTool = false;
    this.streaming = "";
    this.restingSince = null;
    this.working = true;
    /* A turn opening *is* the job being picked up, and it does not matter
       whether the agent woke on its own, Skein nudged it, or you typed
       something — all three are the queue being flushed, which is the whole of
       what was missing. A nudge already in flight is dropped by Skein's own
       `working` check when its timer fires; clearing the field here is what
       stops one being scheduled against a card that has already moved. */
    this.unwoken = null;
    this.pendingNudge = null;
  }

  /** What the running fold was holding when it began.
   *
   *  Kept apart from `ctxTokens`, which the fold is about to rewrite: the
   *  measurement being recorded is "a fold of *this much* took this long", and
   *  reading the occupancy afterwards would file every one of them under ten
   *  thousand tokens and teach the estimate that compactions are free. */
  #compactTokens = 0;

  /** The fold is over. Learn from it if it actually finished.
   *
   *  Every path that ends one comes through here, so there is a single place
   *  that can forget to clear the count or teach the estimate a lie. `record`
   *  is false where the fold did not finish so much as stop — a process that
   *  died mid-summarisation took as long as it took, and that is not a
   *  measurement of anything. */
  #endCompaction(record: boolean) {
    if (this.compactingSince === null) return;
    const seconds = (Date.now() - this.compactingSince) / 1000;
    this.compactingSince = null;
    this.compactEstimateS = 0;
    if (record) rememberCompaction({ tokens: this.#compactTokens, seconds });
  }

  /** Fold one raw event off the wire into card state. */
  ingest(ev: any) {
    switch (ev?.type) {
      case "system":
        if (ev.subtype === "init") {
          this.dormant = false;
          /* A process has announced itself, so whatever happened to the last
             one is no longer the current state of this card. */
          this.died = false;
          if (ev.model) this.#adoptModel(ev.model, true);
          /* The gear this turn is running under — which is not always what the
             card is set to, since an init for a turn already in flight when the
             mode changed reports the old one. `#initGear` holds the rule; see
             `gears.ts` for the measurement.

             `null` is "this init said nothing about the mode", which is not the
             same as "bypass": folding a default here would flip a planning card
             back to making on the next init an older build sent. */
          const gear = gearOfInit(ev);
          if (gear !== null) {
            this.#foldGear(
              afterInit({ gear: this.gear, pending: this.#pendingGear }, gear),
            );
          }
          this.activity = "ready";
          if (!this.working) this.restingSince ??= Date.now();
        } else if (ev.subtype === "status") {
          if (ev.status === "compacting") {
            /* Folding a full context is the one local command that takes real
               time — it is a summarisation of everything said so far — and it
               is the only account of itself on the wire until the boundary
               lands. Narrow on purpose: `status` also carries `requesting` on
               every ordinary turn, where the deltas arriving underneath are the
               better account and this would only overwrite them. */
            if (!this.working) this.#beginTurn();
            /* `??=` rather than `=`: a second `compacting` status must not
               restart the count on a wait you have already been sitting
               through — nor re-predict it, which would move a bar that has
               already been drawn. */
            if (this.compactingSince === null) {
              this.compactingSince = Date.now();
              /* Predicted from what this fold is holding, against what folds
                 have actually cost here. Both taken now because `ctxTokens` is
                 about to be rewritten by the fold itself. */
              this.#compactTokens = this.ctxTokens;
              this.compactEstimateS = compactEstimate(seenCompactions, this.ctxTokens);
            }
            this.activity = "compacting";
          } else if (typeof ev.compact_result === "string") {
            /* The other end of it. `status` is null here — the CLI saying it is
               no longer doing anything in particular — and the result rides
               along beside it. Success needs nothing said: the boundary has
               already dropped the ring and captioned the summary. A failure
               needs everything said, or a card sits there having spent three
               minutes and a fold that did not happen, looking exactly like one
               that succeeded. */
            /* A fold that failed is still a fold that took that long, and the
               next bar is better for knowing — the wait is the same work
               either way, and it is the wait being predicted. */
            this.#endCompaction(true);
            if (ev.compact_result !== "success") {
              const why =
                typeof ev.compact_error === "string" && ev.compact_error.trim()
                  ? ev.compact_error.trim()
                  : "the compaction failed";
              this.activity = clip(why, 44);
              this.#push("error", why);
            }
          }
        } else if (ev.subtype === "compact_boundary") {
          /* It is done, and this is the only event that carries numbers.
             `compact_metadata` on the wire, `compactMetadata` in the session
             file — `compactStat` reads both, so this and `history.ts` caption
             the same compaction identically. */
          this.#endCompaction(true);
          const stat = compactStat(ev);
          if (stat) {
            /* The ring is where a compaction is visible at a glance, and it was
               the last thing to hear about one. Occupancy is the last
               `assistant` message's usage and a compaction produces no
               assistant message at all — so a card that went into `/compact` at
               98% came out of it still drawn at 98%, rust and apparently no
               better off, until the *next* turn happened to answer. This is
               that answer, arriving at the moment it is true. */
            if (stat.post > 0) this.ctxTokens = stat.post;
            this.#compacted = compactNote(stat);
          }
        } else if (ev.subtype === "task_notification") {
          /* A background job reporting in — the *live* shape of it, which
             nothing here read until now. The `<task-notification>` block the
             `user` arm below parses is a transcript record; on the wire the CLI
             sends this instead, with the same facts already in fields. So the
             whole job fold ran only from `history.ts` after a restart, and a
             card whose work finished in front of you kept its ring, its seat and
             its `job` row until it was relaunched. `systemTaskNote` has the
             probe and the three sibling events it deliberately leaves alone.

             `#settleJob` is reached from both arms and needs no telling which:
             it is keyed on ids, not on where the news came from. No turn is
             begun here, for the reason the `user` arm gives — the agent is woken
             by this and its own first event opens the turn, 20ms later in the
             probe, and opening one here would strand a card `working` on exactly
             the occasions when nothing responds. */
          const note = systemTaskNote(ev);
          if (note) this.#settleJob(note, note.summary);
        }
        break;

      /* token-by-token, the thing that makes a card feel alive */
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_start") {
          const b = e.content_block;
          if (b?.type === "tool_use") {
            if (!this.working) this.#beginTurn();
            this.activity = describeTool(b.name, b.input);
          } else if (b?.type === "thinking") {
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
          }
        } else if (e?.type === "content_block_delta") {
          const d = e.delta;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            if (!this.working) this.#beginTurn();
            if (!this.streaming) this.activity = "responding";
            this.streaming += d.text;
          } else if (d?.type === "thinking_delta") {
            /* Thinking dominates the deltas on a reasoning model — a probe run
               showed 8 thinking_delta to 1 text_delta. Without this a card sits
               visibly frozen for the first seconds of every turn. */
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
          }
        }
        break;
      }

      case "assistant": {
        /* A forwarded subagent message is tagged with the parent tool call that
           spawned it. It belongs to a seat, not to the card's own transcript. */
        if (ev.parent_tool_use_id) {
          const said = textOf(ev.message?.content);
          if (said) {
            this.#seat(ev.parent_tool_use_id, {
              state: "thinking",
              thought: clip(said, 220),
            });
          }
          break;
        }

        if (!this.working) this.#beginTurn();
        this.streaming = "";
        /* It is answering us, so it has us — though not necessarily the prompt
           still waiting below, which may be queued behind this very turn. The
           mark comes off; the claim does not. */
        this.#settleEchoes();

        /* An API refusal, which the CLI wraps as an assistant message and is
           not the agent speaking. Drawn as `text` it was the agent apparently
           announcing "You've hit your weekly limit · resets Aug 23, 3pm" in its
           own voice — and then the `result` behind it, whose `result` field is
           that same sentence copied out of this very message, pushed it a
           second time as the turn's error line. Two identical lines, one
           refusal: the hazard `localAnswer` names from the other side, and half
           of what the sink item about account swaps was reporting.

           So the error line owns it and this draws nothing. Nothing is lost by
           that, and it is a guarantee rather than a hope: claude 2.1.235 builds
           the result's `is_error` straight from this flag
           (`Jr = Boolean(Mt.isApiErrorMessage)`), so a message arriving here is
           a turn that is certain to end in `error` with this text as its
           detail. `is_api_error_message` is a wrapper-level sibling of
           `message` — verified in the bundle's own stream schema, where it is
           spread onto the event beside `error` and `request_id` — and never
           inside `message.content`, which is why it is read off `ev`.

           The turn and the echoes above are settled first and deliberately: a
           refusal is proof the process had our prompt, which is exactly what
           `#settleEchoes` is asserting. What it is not is proof anybody
           answered it. */
        if (ev.is_api_error_message === true) break;

        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            this.#turnText.push(block.text);
            this.#push("text", block.text);
          } else if (block.type === "tool_use") {
            if (ASK_TOOLS.has(block.name)) this.#sawAskTool = true;
            const desc = describeTool(block.name, block.input);
            this.activity = desc;
            /* The call is kept, not just its prose — see `Line.call`. `capInput`
               both bounds it and copies it out of the event, which is transient
               where the line is not. */
            this.#push("tool", desc, undefined, undefined, {
              ...(block.id ? { id: block.id } : {}),
              name: block.name,
              input: capInput(block.input),
            });
            /* A subagent call is a seat being taken. It appears dim the moment
               the call lands and brightens when the subagent starts speaking.
               `Agent` is the live name — see `describeTool`; keying on `Task`
               alone meant no seat was ever taken here and the only ones that
               appeared were minted by the forwarded-message fallback below,
               which has no persona to give them. */
            /* A planning turn ends in a document rather than in a diff, and
               this is where the wall learns its name. Structural: the CLI
               writing a file into a directory of its own, which is already in
               the pipeline — rather than reading the result prose that also
               names it, since that is a sentence a model composed. `ExitPlanMode`
               used to be this event and no longer exists; see `gears.ts`.

               Not gated on `this.gear`, deliberately. The write and the init
               that announced the gear are two events, and a card whose plan was
               dropped because the fold order surprised us is a card that did
               the work and has nothing to show. Anything writing into
               `~/.claude/plans/` is planning, whatever we think it is doing. */
            if (block.name === "Write" && isPlanDocument(block.input?.file_path)) {
              this.planDoc = block.input.file_path;
            }
            if ((block.name === "Agent" || block.name === "Task") && block.id) {
              this.#seat(block.id, {
                persona:
                  block.input?.subagent_type ??
                  clip(block.input?.description ?? "seat", 16),
                state: "spawning",
              });
            }
            /* A workflow takes a seat too, and it is the same gesture: work
               convened beside the card rather than done in it. What is different
               is that it is a *crowd* — one script, a dozen agents, phases — and
               that nothing underneath it is ever heard from here, so this call
               is the only chance to say what it is. Everything drawn comes out
               of the script's own `meta` block, which is the model's own words:
               the wall draws nothing the agent did not say, and it said this.

               It stays dim until the receipt confirms it launched, unlike a
               subagent's seat which brightens when the subagent speaks. A
               workflow will never speak, so the receipt is the only evidence
               there is ever going to be — see the `tool_result` arm. */
            if (block.name === "Workflow" && block.id) {
              const meta = workflowMeta(block.input?.script);
              this.#seat(block.id, {
                persona: clip(workflowName(block.input) ?? "workflow", 22),
                state: "spawning",
                thought: clip(meta?.description ?? "", 160),
                crew: { phases: (meta?.phases ?? []).map((p) => clip(p, 18)) },
              });
            }
            /* Provisional: the call says it *means* to background something,
               and the receipt a moment later says whether it did. */
            const kind = backgroundKind(block.name, block.input);
            if (kind && block.id) {
              this.#job(block.id, {
                taskId: null,
                kind,
                label: jobLabel(block.name, block.input),
                outputPath: null,
                /* Named by the receipt, a round trip after this. */
                journalDir: null,
                state: "starting",
                since: Date.now(),
              });
            }
            if (block.name === "TaskCreate" && block.id) {
              /* Held until the receipt names its number — an item with no
                 number could never be matched to the update that completes it. */
              this.#creating.set(block.id, {
                subject: clip(block.input?.subject ?? "", 80),
                activeForm: clip(block.input?.activeForm ?? "", 60),
              });
            }
            if (block.name === "TaskUpdate") {
              const n = String(block.input?.taskId ?? "");
              const status = String(block.input?.status ?? "");
              const i = this.plan.findIndex((t) => t.n === n);
              if (i >= 0) {
                this.plan[i] = { ...this.plan[i], status };
                /* The plan's own words beat the bare verb: `TaskUpdate` carries
                   an id and a status and nothing anybody would want to read. */
                const line = this.#planLine();
                if (line) this.activity = clip(line, 44);
              }
            }
          }
        }

        /* A message the CLI wrote itself rather than one a model produced. It
           is stamped `<synthetic>` and carries an all-zero `usage`, and both of
           the readings below have to skip it — neither used to.
           `contextWindowFor("<synthetic>")` is 200k, so a 1M card quietly lost
           two thirds of its ring and began calling its model `<synthetic>`; the
           zero usage then read as an empty context and dropped the ring to
           nothing. Probed 2026-08-14 against claude 2.1.232 with
           `tools/probe-commands.ts`: every locally-answered slash command emits
           one of these, and so does a turn refused for rate limits — which is
           how it was found. Anything it actually *said* is drawn above; it is
           only the arithmetic that must not take it for the model's own. */
        if (ev.message?.model === "<synthetic>") break;

        /* Context occupancy is the LAST assistant message's usage. Do NOT
           substitute `result.usage` — it sums every iteration of the turn (a
           probe showed cache_read 51,140 across the turn versus 29,128 for the
           final request), so it climbs past the window and pegs the ring. */
        const u = ev.message?.usage;
        if (u) {
          this.ctxTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0);
        }
        if (ev.message?.model) this.#adoptModel(ev.message.model, false);
        break;
      }

      /* the turn closed — this is where the ending is decided */
      case "result": {
        this.streaming = "";
        this.working = false;
        this.turns += 1;
        this.everSpoke = true;
        /* Belt and braces: the turn is over, so whatever the status events did
           or did not say, nothing is compacting any more. A producer that never
           sent the closing status would otherwise leave a card at rest counting
           a fold that finished — and its duration is a real measurement, since
           the turn ending is the fold ending on that path. */
        this.#endCompaction(true);
        /* A turn that completed is a turn whose prompt arrived, whatever the
           echo looked like — an errored turn reaches here without an
           `assistant` message to have settled it. */
        this.#settleEchoes();
        /* The arc dissolves back into the card, leaving one line behind. */
        if (this.seats.length) {
          this.#push("meta", `${this.seats.length} seats · synthesised`);
          this.seats = [];
        }
        this.restingSince = Date.now();
        /* A turn has ended and a prompt of yours is still unechoed — which,
           after `#settleEchoes` just ran, is the *only* record that anything is
           outstanding. Scheduled here rather than at the grace boundary because
           `pendingNudge` is a field Skein polls, exactly as the job case is: the
           twelve seconds are `#nudge`'s timer, and the usual outcome is that the
           CLI drains its queue inside them and the timer finds a working card.
           Never past the budget — `#nudge` would take the field and spend a turn
           it is not allowed. */
        if (
          this.awaiting > 0 &&
          this.held === null &&
          this.promptNudgeAttempts < NUDGE_BUDGET
        ) {
          this.pendingNudge = { attempt: this.promptNudgeAttempts + 1, kind: "prompt" };
        }

        /* The ledger. `result.usage` is the turn summed — see `lastTurn`. It
           is read before `costUsd` is advanced, since the turn's cost is the
           step the session total just took. */
        const tu = ev.usage;
        this.lastTurn = {
          in: tu?.input_tokens ?? 0,
          out: tu?.output_tokens ?? 0,
          cacheRead: tu?.cache_read_input_tokens ?? 0,
          cacheWrite: tu?.cache_creation_input_tokens ?? 0,
          usd:
            typeof ev.total_cost_usd === "number"
              ? costStep(ev.total_cost_usd, this.#costAtLastTurn)
              : 0,
        };
        if (typeof ev.total_cost_usd === "number") {
          this.costUsd = ev.total_cost_usd;
          this.#costAtLastTurn = ev.total_cost_usd;
        }

        const { ending, detail } = endingFor(
          ev,
          this.#turnText.join("\n"),
          this.#sawAskTool,
        );
        this.ending = ending;
        /* A turn that reached a model at all clears the budget, whatever it
           then did with it — a stop, a question, an error of some other kind.
           The two attempts are for one broken send and not for a card's whole
           life, and a counter that only ever went up would leave a long-lived
           card unable to heal because of something that happened to it hours
           ago. */
        if (ending !== "error") this.healAttempts = 0;

        /* A turn that went well is the evidence a repair was right, and it is
           counted here rather than anywhere the *repair* can see, because what
           is being waited on is the conversation carrying on normally — not
           anything the repair itself did. An error does not reset the count to
           zero: a card can break for its own reasons a week later, and a
           backup kept forever because of one unrelated failure is the thing
           `sweep_repair_backups` then has to clean up. It simply does not
           count towards settling. */
        if (this.repairKept && ending !== "error") {
          this.goodTurnsSinceRepair += 1;
          if (backupSettled(this.goodTurnsSinceRepair)) {
            this.repairKept = false;
            this.pendingBackupDiscard = true;
          }
        }

        if (ending === "error") {
          this.lastError = String(detail);
          this.activity = clip(String(detail), 44);
          this.#push("error", String(detail));
          /* The error line is pushed either way. A heal is not a reason to hide
             what happened — the transcript should read as the account of a card
             that broke and picked itself up, not as one that never broke, or
             the next person wondering where the allowance went has nothing to
             find. Skein adds the note saying it is trying again, when it
             actually does. */
          const kind = healKindOf(ev);
          if (kind && this.#lastSent !== null && this.healAttempts < HEAL_BUDGET[kind]) {
            this.healAttempts += 1;
            this.pendingHeal = { text: this.#lastSent, attempt: this.healAttempts, kind };
          } else if (kind && this.healAttempts >= HEAL_BUDGET[kind]) {
            /* Only where the budget is what stopped it. A card with nothing to
               re-send — one a terminal is driving — has not given up on
               anything, and a line saying it had would be describing a decision
               nobody made. */
            this.#push("meta", healGaveUpNote(kind));
          }
        } else if (ending === "stopped") {
          /* The line saying so is already in the transcript — the CLI's own
             note arrived just above this event — so there is nothing to push. */
          this.activity = "stopped";
          /* A parked question cannot outlive the turn it was asked in. The
             thread holding the MCP call in ask.rs times out on its own; what
             matters on the wall is that the card stops claiming to be waiting
             on an answer that would now have nothing to resume. */
          this.pendingAsk = null;
        } else if (ending === "asked") {
          this.activity = "asked you";
        } else if (ending === "question") {
          this.activity = "ended on a question";
        } else {
          /* A turn the CLI answered by itself — `/compact`, `/model`,
             `/effort`. Its whole reply is this one line, and no `assistant`
             message carried it, so without this the card shows the prompt and
             then nothing and the gesture looks like it failed. `meta`, because
             it is the CLI talking about the conversation rather than the agent
             speaking in it — the same voice the stop note and the resume note
             are written in. */
          const said = localAnswer(ev);
          if (said) {
            /* And the books have to be closed by hand, because nothing else
               ever will: this turn's prompt is not replayed, so its line would
               stay `awaited` for the life of the process. See
               `localCommandAwaiting`, which is where the probe and the reason
               for the leading slash are. Left undone the card read `sent, not
               picked up` from here on and spent its whole nudge budget saying
               so to an agent that answered, every time, that nothing was
               queued. */
            this.#claimLocalCommand();
            this.#push("meta", said);
            this.activity = clip(said, 44);
            /* `/effort` is one of the turns that lands here, and its answer is
               the only account of the new level until a turn has actually run
               at it. See `effortAnswer`. */
            const level = effortAnswer(said);
            if (level) {
              this.effort = level;
              this.effortStated = true;
            }
          } else {
            /* "at rest" is a claim about the card, not about the turn, and a
               card with a `pytest -n 6` still fanning out underneath it is not
               resting. The turn did finish — that part was always true. */
            this.activity = this.busy ? this.#jobsLine() : "at rest";
          }
        }
        break;
      }

      /* Two very different things arrive as `user` messages.

         Your own words come back first: `--replay-user-messages` re-emits what
         we wrote to stdin, flagged `isReplay`. That echo is the acknowledgement
         that a prompt landed — it claims the line `echo` already drew rather
         than appending a second one. A prompt with no line waiting for it is
         one this window did not send (a terminal appending to the same
         session), and is pushed as it always was.

         Tool results arrive the same way. One whose tool_use_id matches a seat
         is that subagent reporting in. */
      case "user": {
        if (!ev.parent_tool_use_id) {
          const said = textOf(ev.message?.content);
          if (said) {
            /* A stop lands here too, as a `user` message the CLI wrote itself.
               It is a note about the conversation rather than anything you
               typed, and pushing it as `you` would put words in your mouth —
               and, worse, open a turn (below) a moment before the aborted
               `result` closes it. */
            if (isStopNote(said)) {
              this.#push("meta", "stopped");
              break;
            }
            /* A background job reporting in, which is the CLI talking about the
               conversation rather than words anybody typed — the same shape and
               the same hazard as the stop note above. Without this the raw
               `<task-notification>` XML was pushed as a `you` line and then
               opened a turn on itself.

               No turn is begun here on purpose. The agent usually is woken by
               this and the first event of that turn opens it through the arms
               that already do so; opening one here would strand the card
               `working` forever on the occasions when nothing responds. */
            const note = parseTaskNotification(said);
            if (note) {
              this.#settleJob(note, note.summary);
              break;
            }
            /* And a local command of the CLI's own, which reaches the wire
               for one reason: a prompt queued behind a `/compact`. Running one
               writes four `user` records — an `isMeta` caveat, `<command-name>`
               and `<local-command-stdout>` — and the fold flushes them across
               the boundary into the new context, where `--replay-user-messages`
               re-emits them. Nothing marks the stdout record at all, so without
               this it was pushed as a `you` line and the wall drew
               `<local-command-stdout>Compacted </local-command-stdout>` as
               something you had typed.

               `classify.ts` claimed this never arrives live, and the trace that
               falsified it is recorded there rather than copied here — one queued
               prompt is the whole of the difference, and `tools/probe-compact.ts`
               never typed during the fold.

               The seam that matters is `history.ts`, which has folded this since
               it was written: a card reading correctly only *after* a restart was
               the live path disagreeing with the restored one, which is the
               divergence that file exists to prevent. Empty text draws nothing,
               as it does there — a command that printed nothing has its own name
               pushed just above. No turn is opened: the turn the compaction runs
               in is already open and the `result` behind this closes it, the same
               argument as the summary below. */
            const ran = localCommand(said);
            if (ran) {
              if (ran.text) this.#push(ran.kind, ran.text);
              break;
            }
            /* And the summary a compaction carried forward, which is the same
               shape and the same hazard at a hundred times the size: the CLI
               addressing the model with everything it must not forget, arriving
               as a `user` message, and drawn as one it is twenty thousand
               characters you appear to have typed with the round you were
               reading pushed off the top of the panel.

               It is worth keeping — it is the whole account of what this card
               used to know — so it is a fold rather than a clip: captioned with
               what the compaction cost, closed by default, and yours to open.
               Its own kind, so nothing can mistake it for either voice.

               No turn is opened on it, unlike an ordinary prompt. The turn the
               compaction runs in is already open (`status: "compacting"` began
               it) and the `result` behind this closes it. */
            if (isCompactSummary(said)) {
              this.#push("summary", said, undefined, this.#compacted ?? undefined);
              this.#compacted = null;
              break;
            }
            /* And a skill, which is the same shape a third time: the CLI
               handing the model a body of text as a `user` message. Invoking a
               skill returns no result — it injects the file — so without this
               the whole of a skill was drawn as a prompt you had typed, and the
               largest on this machine's transcripts is 698k characters.

               Folded rather than dropped, unlike the two notes above: a skill
               is the instructions the rest of the card is following, so which
               one was picked up belongs in the transcript and the text of it
               belongs one click away.

               No turn is opened, and none needs to be: this arrives inside the
               turn whose `Skill` call asked for it. */
            const skill = skillBody(said);
            if (skill) {
              this.#push("skill", said, undefined, skill.name || undefined);
              break;
            }
            /* A message from another card. Before `#claimEcho`, which would
               otherwise hand it to whatever prompt of yours happened to be
               waiting — the texts could not match, but a relay arriving while a
               send of yours is unacknowledged must not be able to settle it
               either way. */
            if (isRelayPrompt(said)) {
              this.#push("relay", said, undefined, relayCap(said));
              if (!this.working) this.#beginTurn();
              this.activity = "reading a message";
              break;
            }
            if (!this.#claimEcho(said)) this.#push("you", said);
            /* The turn starts the moment your words land, not seconds later
               when the first token comes back. */
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
            break;
          }
        }

        for (const b of ev.message?.content ?? []) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          const said = textOf(b.content);

          /* The call that asked gets what came back, so opening it shows both
             halves. Before anything else in this loop, because everything else
             here is a *reading* of the result — a job's receipt, a plan item's
             number, a seat's verdict — and the raw text belongs on the line
             whatever any of those make of it. */
          this.#land(b.tool_use_id, said, b.is_error === true);

          /* The receipt for a job we registered provisionally. Either it names
             what was started, or the call ran inline after all and the job goes
             — which is the only way to tell an `Agent` that backgrounded from
             one that did not. */
          const pending = this.jobs.find((j) => j.toolId === b.tool_use_id);
          let launched = false;
          if (pending && pending.state === "starting") {
            const { started, taskId, outputPath, journalDir } = startedJob(said);
            launched = started;
            if (started) {
              this.#job(b.tool_use_id, {
                taskId,
                kind: pending.kind,
                label: pending.label,
                outputPath,
                journalDir,
                state: "running",
                since: pending.since,
              });
              if (!this.working) this.activity = this.#jobsLine();
              /* A crowd is lit by its receipt and by nothing else. Every other
                 seat brightens when its subagent starts speaking, and a
                 workflow's agents speak on a stream this window never sees — so
                 left to that rule the biggest thing a card can convene would
                 sit at "arriving…" for a quarter of an hour. The receipt is
                 proof it started, which is exactly what the state means. */
              const seat = this.seats.find((s) => s.id === b.tool_use_id);
              if (seat?.crew && seat.state === "spawning") {
                this.#seat(b.tool_use_id, { state: "thinking" });
              }
            } else {
              this.#dropJob(b.tool_use_id);
            }
          }

          /* A plan item's number, which is what every later update names. */
          const creating = this.#creating.get(b.tool_use_id);
          if (creating) {
            this.#creating.delete(b.tool_use_id);
            const n = taskNumberOf(said);
            if (n && !this.plan.some((t) => t.n === n)) {
              this.plan = [...this.plan, { n, ...creating, status: "pending" }];
            }
          }

          /* A subagent's seat closes on the subagent's *answer*. A background
             one answers here with a launch receipt instead — so closing on any
             tool_result would collapse the seat the instant it was taken, and
             write the receipt's own "internal metadata, never quote this"
             text into the verdict the wall then draws. It stays open until the
             notification settles the job. */
          if (!launched && this.seats.some((s) => s.id === b.tool_use_id)) {
            this.#closeSeat(b.tool_use_id, said || "returned");
          }
        }
        break;
      }

      /* The CLI's receipt for a `control_request`. For an interrupt it says only
         that the message was *taken* — what the turn did about it arrives a
         moment later as an aborted `result`, and that is the event the card
         folds. For a mode change it says more than that: the acknowledgement
         carries the new mode, and it is the *only* immediate account of it,
         since `system/init` is per-turn and can name the mode of a turn already
         in flight. So this is where the gear is really learned. See `gears.ts`. */
      case "control_response": {
        const acked = gearOfModeAck(ev);
        if (acked !== null) this.ackGear(acked);
        break;
      }

      /* Shape isn't documented and it fired once in an otherwise nominal run,
         so this stays quiet unless it clearly isn't business as usual. */
      case "rate_limit_event": {
        const status = ev.rate_limit?.status ?? ev.status;
        if (typeof status === "string" && !/^(ok|allowed|nominal)$/i.test(status)) {
          this.#push("meta", `rate limit: ${status}`);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Point this card at a fresh session, in place.
   *
   *  Everything the old session was is dropped — its words, its context, its
   *  cost, its name — because the model can no longer see any of it, and a
   *  transcript showing what the agent has forgotten is the one lie this wall
   *  must not tell. What is deliberately *not* dropped is the card: its id, its
   *  position, its project and its worktree are all untouched, so clearing
   *  costs you nothing you arranged.
   *
   *  Nothing is destroyed. The old session's transcript stays exactly where
   *  Claude Code wrote it, so it can be put back on the wall from `adopt a
   *  recorded session…` — which is why this is not a danger item.
   *
   *  `everSpoke` going false is what makes the next send spawn with
   *  `--session-id <new>` rather than `--resume`: there is no transcript to
   *  resume yet, and resuming an id that has never been written is an error. */
  clear(sessionId: string) {
    this.sessionId = sessionId;
    this.lines = [];
    this.history = [];
    this.streaming = "";
    /* Not "unread": we know this session has no transcript, having just minted
       its id, so there is nothing for the loader to go and find. */
    this.historyState = "none";
    this.historyPartial = false;
    this.seats = [];
    this.jobs = [];
    this.plan = [];
    this.#creating.clear();
    this.pendingAsk = null;
    /* A cleared card is a new session with nothing owed to it, so a prompt held
       against an account coming back is a prompt for a conversation that no
       longer exists. The account itself is *kept*: it is a property of the card
       rather than of the session, and clearing would silently drop the card
       back onto the first account. */
    this.held = null;
    this.ctxTokens = 0;
    this.costUsd = 0;
    /* The fresh session's `total_cost_usd` starts from zero again, so a
       baseline left at the old session's total would make the first turn after
       a clear read as free (the clamp in the `result` arm) and every turn after
       it read low. */
    this.#costAtLastTurn = 0;
    this.lastTurn = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    this.turns = 0;
    this.ending = null;
    this.everSpoke = false;
    this.interrupted = false;
    this.died = false;
    this.working = false;
    this.lastError = null;
    /* A cleared card is a new session with no turn behind it, so a heal queued
       against the old one would re-send your last prompt into a conversation
       that has never heard it — the one case where repeating a prompt is not
       repeating anything. */
    this.pendingHeal = null;
    this.healAttempts = 0;
    /* Same argument one job over: the notification that stalled this card
       belonged to a session it no longer has, so nudging would be Skein asking
       a fresh conversation to pick up work it has never heard of. */
    this.unwoken = null;
    this.pendingNudge = null;
    this.nudgeAttempts = 0;
    /* And the same again from your end. `lines` has just gone, so the awaited
       lines went with it — the count has to follow or the card would come back
       amber over prompts that are no longer on it. */
    this.awaiting = 0;
    this.promptNudgeAttempts = 0;
    /* The backup belongs to a session this card no longer has, so nothing here
       can ever settle it. Left set, the card would sit waiting on two good
       turns to release a file whose session is gone — and the discard would
       then be aimed at the *new* session id, which has no backup and never
       will. `sweep_repair_backups` is what collects the orphan. */
    this.repairKept = false;
    this.goodTurnsSinceRepair = 0;
    this.pendingBackupDiscard = false;
    this.restingSince = null;
    /* So the first prompt names the card again, as it does for a new one. The
       model and its window are kept: which model this card talks to is a fact
       about the card, and the ring should read 0% of the same size rather than
       fall back to 200k until `system/init` arrives. */
    this.title = UNNAMED;
    /* And the name you gave goes with the name — a flag that outlived the title
       it was protecting would leave the card refusing every generated title for
       a session it has nothing to do with. */
    this.namedByHand = false;
    this.dormant = true;
    this.activity = "cleared — will wake on send";
    /* One line, so an empty panel is an answer rather than a question. */
    this.#push("meta", "cleared · a fresh session, in the same place");
  }

  /** stdout closed — the process is gone. */
  markExited(code: number | null) {
    /* A kill we asked for. Say nothing: the card has already been given its new
       state and an exit code from `close_conversation` describes the process we
       deliberately ended, not anything that went wrong. */
    /* Whatever was in flight, this card can no longer be told how it ended: the
       notification would have come down the stream that just closed. Holding a
       count nothing can ever decrement would leave the card permanently busy —
       and permanently celadon — so the jobs go with the process. Said out loud
       below rather than silently, since the work itself may well still be
       running: these are grandchildren of `claude`, not of Skein. */
    const orphaned = this.jobs.length;
    this.jobs = [];
    /* A card with no process cannot be nudged into looking at anything, and the
       amber would be asking for a gesture that does nothing. The note below is
       what a dead card has to say about its work instead. */
    this.unwoken = null;
    this.pendingNudge = null;
    this.nudgeAttempts = 0;
    this.#creating.clear();
    /* A fold whose process is gone is not a fold still running, and a count
       nothing can stop would tick on a dead card for the rest of the session —
       the same reason the jobs go. Not recorded: a summarisation that died
       part-way took as long as it took, and that is a measurement of the crash
       rather than of the work. */
    this.#endCompaction(false);
    if (this.retiring) {
      this.retiring = false;
      this.dormant = true;
      this.working = false;
      this.streaming = "";
      /* `keepUnsent`, because a retirement is a process *we* ended and the send
         that asked for it has not happened yet — an account swap kills the child
         between `echo` and `send_prompt`. See `#forgetEchoes`. */
      this.#forgetEchoes(true);
      return;
    }
    this.dormant = true;
    this.working = false;
    this.streaming = "";
    if (orphaned) {
      this.#push(
        "meta",
        orphaned === 1
          ? "a background job was left running — its outcome is no longer being reported here"
          : `${orphaned} background jobs were left running — their outcomes are no longer being reported here`,
      );
    }
    /* A prompt still marked pending here did leave — `echoFailed` is what marks
       one that did not, and a send that failed is never followed by an exit. So
       the mark comes off rather than turning into "not sent", which would be a
       lie about a prompt this process took and then died holding. What happened
       is the line below. */
    this.#settleEchoes();
    this.#forgetEchoes();
    /* A gear change the process never got round to reflecting in an init is not
       owed one now — and left set, it would make this card deaf to every init
       for the rest of its life. The next process announces its own mode, off
       the flag `spawn` reads from the row. */
    this.#foldGear(afterExit({ gear: this.gear, pending: this.#pendingGear }));
    if (code !== 0 && code !== null) {
      this.died = true;
      this.ending = "error";
      this.lastError = `process exited ${code}`;
      this.activity = `exited ${code}`;
      this.#push("error", `process exited with code ${code}`);
    } else {
      this.activity = "dormant";
    }
  }

  /** Say something about the conversation, in the conversation.
   *
   *  A meta line is the register the panel already has for things that happened
   *  *to* a card rather than in it — `cleared`, `stopped`, a run of seats
   *  dissolving. The one use so far is the note above a resumed card's prompt:
   *  a `you` line nobody typed has to arrive introduced, or the transcript is
   *  quietly putting words in your mouth. */
  note(text: string) {
    this.#push("meta", text);
  }

  /** Skein has rewritten this card's session file. Say so, and start counting.
   *
   *  The note is pushed here rather than left to the caller because the card's
   *  transcript and the card's bookkeeping have to agree: a repair that started
   *  the countdown without saying so would be Skein editing another program's
   *  file with nothing on the wall to show for it, and that is the one thing
   *  this feature must never be. The agent is told separately and in a better
   *  place — the note the repair leaves *in the session*, where the removed
   *  output used to be. */
  markRepaired(said: string) {
    this.note(said);
    this.repairKept = true;
    this.goodTurnsSinceRepair = 0;
    this.pendingBackupDiscard = false;
  }

  /** What you answered a parked question with, kept under the call that asked.
   *
   *  The panel used to say only that the agent had asked: the question lived in
   *  the dock, was answered there, and went — so the transcript carried a tool
   *  call and then, some seconds later, an agent acting on a decision recorded
   *  nowhere. Reading a card back, yours was the one half of that exchange
   *  missing.
   *
   *  It goes through `answerNote` rather than being pushed raw, so this line and
   *  the one `foldTranscript` writes off the same reply are the same line. */
  answered(sent: string) {
    const note = answerNote(sent);
    if (note) this.#push(note.kind, note.text);
  }

  noteStderr(line: string) {
    this.#push("error", line);
  }
}
