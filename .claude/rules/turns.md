---
paths:
  - "src/lib/classify.ts"
  - "src/lib/conversation.svelte.ts"
  - "src/lib/Seats.svelte"
  - "src/lib/crowd.ts"
  - "src/lib/crowds.svelte.ts"
  - "src-tauri/src/workflow.rs"
  - "src-tauri/src/supervisor.rs"
  - "src-tauri/src/quit.rs"
  - "src/lib/quitting.ts"
---

# How a turn starts, stops, and outlives itself

### Stopping a turn

The stdin that carries prompts carries a second kind of message: a `control_request`. The
CLI accepts a small set of subtypes on it — `interrupt`, `set_model`,
`set_permission_mode`, `set_max_thinking_tokens`, `set_color`, `mcp_toggle`,
`message_rated` — and `interrupt` is the same one the Agent SDK's `query.interrupt()`
sends. `supervisor.rs::interrupt_conversation` writes one line; that is the whole
mechanism.

Probed against claude 2.1.229 with `tools/probe-interrupt.ts`, which spawns with Skein's
exact argv. Within 20ms of the write:

```text
control_response  subtype success, {still_queued: [], cancelled: []}
assistant         the half-written answer, as far as it had got
user              "[Request interrupted by user]"
result            is_error true, subtype error_during_execution,
                  terminal_reason "aborted_streaming"
```

and the child then answered the next prompt normally. **This is not `close_conversation`
with a nicer name** — the process, the session and the context all survive, and what the
agent had already written is kept, because the CLI emits the partial message before it
emits the aborted result. Three things follow:

- **`terminal_reason` is the only honest signal.** A stopped turn arrives wearing every
  mark of a failed one, so `wasStopped` is consulted *before* the error test in
  `endingFor`; without it a card goes rust for something you did on purpose. Prefix-matched
  on `aborted` — `aborted_streaming` mid-answer, `aborted_tools` with a tool call in
  flight, and room for a third.
- **`stopped` is an `Ending`, and it warms on the clean-finish clock.** Nothing went
  wrong and nobody is waiting on an answer, so it is not `fail` and not `ask` — but a card
  you stopped is exactly as easy to walk away from as one that finished. It also clears any
  `pendingAsk`: a question cannot outlive the turn it was asked in (the parked thread in
  `ask.rs` times out on its own).
- **The `[Request interrupted by user]` note is the CLI talking, not you.** It arrives as a
  `user` message on the wire *and* as a plain `user` record in the session file with no
  `isMeta` to sort it out by, so both folds have to know it on sight (`isStopNote`) or the
  same stop is a meta line live and a sentence you appear to have typed after a restart.
  Two wordings on this machine, hence matching by shape.

`cancel_queued` is deliberately not asked for, though the CLI advertises it
(`interrupt_cancel_queued_v1`). Stopping means stopping what is *running*; a prompt already
written to stdin behind it is one you sent and are owed an answer to, and the transcript is
marking it unacknowledged until it lands.

The gesture is Escape, which is what the same hands do in Claude Code, and a `stop` button
in the dock beside the target readout. Escape reaching it first is the existing ladder
rather than an exception to it — a running turn is the innermost thing there is — and it
takes only the step it has, so with nothing working Escape lets go exactly as before and a
second press after a stop does the letting go. Both aim at the **focused card alone**,
never at the gathering: a stop is cheap and undoable, but firing one at everything a wide
marquee happened to catch is not a gesture anybody means. The button's square is drawn in
CSS, not typed — `■` falls through to Segoe UI Emoji here and comes out blue, the same trap
the ambience panel's layer-order buttons avoid.

### Work that outlives a turn

Every other state on this wall is a fold over one turn: it opens on the first event and
closes on the `result`. Background work breaks that, and it was the one thing on the wire the
fold had no concept of at all — so a card running `uv run pytest tests/ -n 6` across twelve
processes said `at rest` and started warming on the neglect clock. That reading was not a
bug in `urgencyFor`; the turn really had finished. The card simply had no way to say that its
*work* had not.

A `Bash` carrying `run_in_background`, an `Agent` (which backgrounds by default in this
build) and a `Monitor` all return **immediately**. The tool result is a receipt, not an
answer, and the three are worded differently — read out of this machine's 496 transcripts on
2026-08-14:

```text
Command running in background with ID: btuqox9zy. Output is being written to: …
Monitor started (task bc4v3btv8, timeout 1800000ms). You will be notified on each event.
Async agent launched successfully. (This tool result is internal metadata — never quote …)
```

Completion arrives much later as a `<task-notification>` block carrying `task-id`,
`tool-use-id`, `status` and a `summary`. `classify.ts` owns all of it (`backgroundKind`,
`jobLabel`, `startedJob`, `parseTaskNotification`, `taskNumberOf`); `Conversation.jobs` is
the fold.

- **`busy` is a second question, not a widening of `working`.** `working` still means exactly
  what it meant — a turn is open — and rousing, delivery and the interrupt all still want
  that. What changed is that the *colour* was reading `working` to answer a broader question:
  is this card busy. An agent that backgrounded a thirteen-minute run and said "I'll commit
  once the suite is green" has ended its turn and not its work, and it will be woken by the
  notification rather than by you.
- **A job is keyed on the tool_use id**, which is the only identity the call, the receipt and
  the notification all share — the same bargain `Seat` makes. The agent receipt's `agentId`
  is now extracted as well, having deliberately not been: it instructs in the same breath that
  it not be repeated *to the user*, which is still honoured, and it turned out to be the only
  thing that finds a subagent's transcript on disk. See "Jobs that outlive the process".
- **The call registers the job and the receipt confirms it.** `Agent` can be told to run
  inline and only its receipt says which it did, so a job starts `starting` and is either
  promoted to `running` or dropped. Registering from the call is what puts it on the card a
  round trip early rather than late.
- **A broken turn outranks a running job.** `tier` reads `working`, then `error`, then
  `busy`. Rust is the fault colour and a background job painting celadon over a turn that
  errored would be the one case where the wall says "fine" about a card that is not.
- **The notification is `meta`, and missing it put XML in your mouth.** It is a bare string on
  a `user` record with no `isMeta` to sort it out by — exactly `isStopNote`'s shape, and
  exactly its failure: **both** folds pushed the raw `<task-notification>` block as a `you`
  line and then opened a turn on it. `history.ts` needs the guard too, or a restart changes
  what a card said.
- **No turn is begun on a notification.** The agent usually is woken by it and the first event
  of that turn opens it through the arms that already do so; opening one here would strand the
  card `working` for good on the occasions when nothing responds.
- **The neglect clock starts when the last job lands**, not back when the turn ended —
  otherwise a card whose job ran twenty minutes blooms amber the instant it finishes, for a
  wait nobody was subject to.
- **`markExited` clears the card's jobs, and that is now the smaller half of what happens to
  them.** Skein only ever learns a job finished by being *told*, down the stream that just
  closed — so a job it did not watch start is one it could never watch end, and a count nothing
  can decrement would leave the card permanently celadon. It is still said out loud rather than
  dropped silently. What has changed is that the note is no longer the end of it: the *row*
  survives, and the next launch acts on it. See "Jobs that outlive the process".
  Note the line this bullet used to carry — "the work may well still be running: these are
  grandchildren of `claude`, not of Skein" — stopped being true in 0.4.0, when the `claude`
  children went into a job object with `KILL_ON_JOB_CLOSE`. Before it, a background job was
  orphaned and usually ran to completion; after it, the tree goes down with the card. Both
  states are still on this machine, since an installed build lags the tree, which is exactly
  why the prompt says *check* rather than assuming either.
- **A completed job with a non-zero exit code is a failed one.** The code rides in the summary
  rather than in a field of its own, and a background test run that came back red must not
  read as done.
- **A backgrounded subagent holds a seat *and* a job, and only the notification closes the
  seat.** `#closeSeat` fires on a `tool_result`, which for a background agent is the launch
  receipt rather than an answer — so closing on it would collapse the seat the instant it was
  taken and write that receipt's own "internal metadata, never quote this" text into the
  verdict the wall then draws. This only became reachable once seats started being created at
  all; see below.

### A workflow, which is a crowd

A `Workflow` is the fourth `JobKind`, and it was the one background tool nothing in here knew
about: no `describeTool` case, so the card drew the bare word `Workflow`; no `backgroundKind`,
so no job; no job, so `busy` stayed false and a card that had just fanned fifteen agents over
five phases sat reading `at rest` and started warming on the neglect clock. That is the whole
of "it looks like nothing is happening", and the fix is mostly the three lines that were
missing. What took thought is what there is to *draw*.

- **The script's `meta` block is the only account of a workflow that ever reaches this
  window.** The tool result is a receipt, and the dozen agents underneath run on a stream Skein
  never sees — no `phase()` call, no agent's start, no agent's answer arrives here. So
  `workflowMeta` reads the block the script is required to open with, and that is the material:
  a name, a sentence, and the phase titles in order.
- **Which is honest, because it is the model's own words.** The wall draws nothing the agent
  did not say; a workflow's `meta` is something it said, in a call this window watched arrive.
  The line that would *not* be honest is a lit phase — there is no signal for which phase is
  running, so the track is drawn as a flat list of what it set out to do and never as progress.
  Anything else would be Skein narrating a run it cannot see.
- **Read by regex, bounded by brace counting.** The block is specified as a pure literal, so
  the three fields wanted are within reach of a pattern, and a JavaScript parser inside
  `classify.ts` would be a large thing to carry for it. The bound is the half that matters:
  everything below `meta` is prose written for other agents to read, and one prompt saying
  `name: "..."` would otherwise rename the run. A `detail` holding a brace of its own — a
  template hole, a JSON shape quoted in prose — is why the counter is quote-aware, and both
  shapes are in the scripts measured here.
- **A workflow takes a seat, and the seat is a crowd.** It is the same gesture a subagent's
  seat is — work convened beside the card rather than done in it — so it is drawn in the same
  vocabulary rather than a new one. What differs is the count: three figures, the outer two
  smaller and fainter, because a workflow is a dozen agents and drawing it as one figure would
  say the wrong number in the one channel the wall has for saying it. `Seat.crew` is the marker
  and carries the phases; its *presence* is the question, since `meta.phases` is optional and
  an empty list is a real answer.
- **A crowd is lit by its receipt, and it is the only seat that is.** Every other seat stays dim
  until its subagent speaks, which is right — a seat that brightens on the call would be
  claiming an agent arrived. A workflow's agents will never speak *here*, so left to that rule
  the largest thing a card can convene would sit at "arriving…" for a quarter of an hour. The
  receipt is proof it started, which is exactly what `thinking` means. It still closes the way
  every other seat closes: on the notification, through `#closeSeat`, with the CLI's own
  summary as the verdict.
- **Its receipt is a fourth shape and its id is the ordinary one.** `Workflow launched in
  background. Task ID: wxx8uibpu` — nine characters, the same as a `Bash` job's, and the same
  value the notification quotes back as `<task-id>`. The `Run ID: wf_…` on the next line is a
  *different* id naming the run's directory, and taking it would key the job on something no
  notification ever mentions. No output path is named, but the notification's own
  `<output-file>` proves the CLI files one under `tasks\<id>.output` like every other kind — so
  `store::task_output_path` derives it with nothing added, and a workflow lost to a quit is
  named in the resume prompt with somewhere to read it.
- **It has no inline arm**, unlike `Agent`, so the job is not provisional in the way the
  comment on `backgroundKind` describes. The receipt still confirms it, because the confirm path
  is what promotes `starting` to `running` and lights the crowd.

#### And then how far it has got

A crowd that says only *that* it is out is still a card you have to take on faith, so the
count is read off the run's own journal — the second deliberate exception to "nothing polls",
and the same exception the performance sampler is: nothing emits an event when a workflow
agent finishes, so there is no fold to be had. `workflow.rs` reads, `crowds.svelte.ts` asks,
`crowd.ts` decides what that makes the crowd look like.

- **The journal holds two facts and the drawing is allowed exactly two facts.** Across all six
  runs and 52 agents on this machine (2026-08-21) the file carries only `started` and `result`
  records and only the keys `type`, `key`, `agentId`, `result`. **No phase and no label
  anywhere.** So the reading is "3 of 7 back" and the phase track above it stays flat — which
  is the same line the section above draws, now with the measurement behind it rather than an
  assumption. Anything that lights a phase is inventing one.
- **The run's directory is taken from the receipt, not derived.** `Transcript dir:` names it
  absolutely; re-deriving it would mean re-performing the lossy transcript slug to arrive
  where the receipt already points. It rides on the live `Job` and is deliberately **not**
  persisted: a `job` row exists to say what was *lost* when the process went away, and
  progress is a reading about a run this process is watching. No schema rung, and a roused
  card simply draws no crowd for a workflow it never saw launch.
- **Counting is by line prefix with a real parse behind it, and that is not premature.** A
  `result` record embeds whatever the agent returned — so an agent that reviewed `workflow.rs`
  would put the literal text `"type":"started"` inside its own result, and a substring count
  would have the run go *backwards*. The prefix settles all 81 records measured without
  touching a payload; anything else falls through to `serde_json`, because the failure mode of
  the fast path alone is a silent zero, and a silent zero is a workflow that looks like it
  never started anybody.
- **No journal yet is not zero agents.** It is the ordinary first second of every run, so it
  reads as `None` and draws the three-figure stand-in for "a crowd, of unknown size" —
  `UNKNOWN_CROWD` in `crowd.ts`, and three rather than one because one would say *subagent* and
  none would say the card is idle, which is the bug the whole seam exists to fix.
- **Everybody home is a moment, not an ending.** A pipeline stage that has returned is one
  whose next stage is about to start, so a crowd can be entirely home twice in a run with ten
  minutes left. `allHome` answers only "is anything out right now"; the notification is still
  the only thing that ends a workflow, and wiring the two together would settle a card halfway
  through its own work.
- **The figure cap abbreviates the drawing and never the reading.** Past `FIGURES_MAX` the row
  stops being a proportion — 30 of 40 draws nine home out of nine — and the tally underneath
  carries the truth. That is the same bargain the transcript's result clamp strikes: what is
  cut is *said*. It is also why the tally is not optional decoration.
- **`crowds.watchers` is in the snapshot apart from the readings**, for `meter.sampling`'s
  reason twice over: a crowd drawn from a stopped poller looks identical from outside, and a
  workflow that settled while leaving its directory read every four seconds forever is the leak
  this shape exists to make visible from a test.

### Told, and not stirring

The line above says an agent "will be woken by the notification rather than by you", and it is
right. Counting *batches* over the 64 transcripts on this machine that carry a
`<task-notification>` (`tools/probe-wake.ts`, 2026-08-19):

```text
skein-spawned   53 batches   woken 48 (91%)   prompt first 2   silent 3
terminal       124 batches   woken 120 (97%)  prompt first 1   silent 3
```

Median wake delay ten seconds. **The ordinary path works and needs no help**, which is worth
stating plainly because the first attempt at this measurement said otherwise and was wrong in
two ways that any future probe over transcripts will meet:

- **Notifications arrive in batches.** Three jobs landing together write three `user` records
  in the same second, so "did an assistant record immediately follow this one" answers NO for
  every notification but the last of its batch, by construction.
- **Bookkeeping sits between everything.** `ai-title`, `mode`, `last-prompt`,
  `file-history-snapshot` and `attachment` are interleaved freely and break the same test
  again.

Together those turned a ~3% failure rate into a reported ~50%. A related dead end: the queue
records (`queue-operation`, `enqueue`/`dequeue`/`remove`) show a notification enqueued 506
times and dequeued **zero**, which looks conclusive and means nothing — the CLI evidently
delivers them by some path that writes no `dequeue`, and the only sound test is whether a turn
followed.

What is actually left is one case, and every silent notification on the Skein side is it:

```text
"3 background shell command task(s) from the previous session"
"10 background shell command task(s) from the previous session"
```

That is the CLI reconciling tasks it found orphaned at startup. A process died holding them;
`--resume` restores the conversation but not the task table, so the new process can only
report them stopped with no exit code. **That notification wakes nobody, three times out of
three** — and it is the one Skein generates constantly, because a desktop app gets closed
where a terminal session runs for days. The work behind it has usually finished and written
its output (11 of 15, in the case this was found from), so what is lost is the news rather
than the work, and the card sits reading `at rest` on top of a completed job.

#### And the job nudge has never once fired, because live it is a different event

Everything above is right about the CLI and wrong about the wire. Measured 2026-08-25 over all
222 transcripts on this machine: **zero `NUDGE_TEXT` sends, ever**, against 193
`<task-notification>` records. `tools/probe-nudge.ts` says why, and the answer is one line
long: **live, the notification is not a `user` message.**

```text
34.89s  system/task_notification  {task_id, tool_use_id, status,
                                   output_file, summary}
34.91s  system/init                       ← the woken turn, 20ms later
35.9s   assistant "The background command completed (exit code 0)."
```

`#settleJob` is reached from the `user` arm, on a message whose text contains
`<task-notification>` XML. On the wire the CLI sends a **`system` event with subtype
`task_notification`** carrying the same facts already parsed into fields. `ingest`'s `system`
arm knew exactly three subtypes — `init`, `status`, `compact_boundary` — so it fell straight
through and nothing happened at all.

**Fixed by reading it.** `systemTaskNote` in `classify.ts` takes the event and `ingest`'s
system arm hands it to the same `#settleJob` the `user` arm does — which needs no telling
which side it came from, being keyed on ids rather than on provenance. `taskNoteOf` is the
one reading of a job's fate, shared by both, so a job cannot mean one thing live and another
after a restart. The XML path stays exactly as it was: `history.ts` still folds a transcript,
and that is still the only thing that runs on a relaunch.

The XML *does* exist, in the **transcript**, as a `user` record. That is why `history.ts` folds
it correctly, why every measurement over transcripts finds it, and why the section above reads
as though the mechanism worked: **it works on restart and has never once run live.** A probe
over transcripts cannot see this difference, and two of them did not.

So the reach was much wider than the nudge, and the nudge was the least of it. Live, none of
this happened: `#dropJob` was never called, so `busy` stayed true and a card kept its
background-work ring after the work was done; `#closeSeat` never fired, so a backgrounded
subagent's seat and a workflow's crowd never closed; the `job` row was never deleted, so the
next launch reported finished work as lost; and `unwoken` was never set, which is the whole of
why no job nudge had ever been sent. All four come back with the event.

**Three sibling events arrive on the same arm and are deliberately still unread** — each
carrying, already parsed, something `classify.ts` scrapes out of receipt prose with a regex:

```text
system/background_tasks_changed  {tasks: [{task_id, task_type, description}]}
system/task_started              {task_id, tool_use_id, description,
                                  is_backgrounded, task_type}
system/task_updated              {task_id, patch: {status, end_time}}
```

`task_started` is `startedJob`'s three shapes with the guessing taken out, including the
`is_backgrounded` flag that the `Agent` inline-or-not dance exists to infer. `output_file` on
the notification is the path `store::task_output_path` derives. A fold onto these would be
strictly better than the text it replaces, and the receipt parsing should stay anyway — it is
what `history.ts` reads. They were left out of the fix on purpose and the reason is narrow:
**the start path already works live**, because a `tool_result` does arrive as a `user` event,
and `task_updated` carries `status: "completed"` in the same millisecond as the notification —
folding it beside this one settles the same job twice. Only the settle was broken, so only the
settle was changed.

One thing the same probe settles about the grace: the woken turn's `system/init` arrived **20ms**
after the notification. The transcript-measured "wake delay" of ten seconds is the gap to the
*finished* assistant record, and `#beginTurn` fires on the first `thinking` block, so it was
never the number `WAKE_GRACE_S` should have been set against. Once these events are folded the
nudge will be quiet almost always — which is correct, and is the opposite of the reason it is
quiet now.

So this is a narrow fix for a narrow case, and the wall's own reading was the wrong half of it:

- **`unwoken` is a third question, the way `busy` was a second one.** `working` means a turn is
  open and `busy` means work is running; this means *told, and not stirring*. It has to be
  separate from neglect, because `#settleJob` already restarts the neglect clock when a job
  lands — so such a card does warm to amber eventually, but on the clean-finish clock and
  indistinguishably from a card that finished a turn and went quiet. Those two want opposite
  things from you: one wants reading, the other wants a word, any word.
- **`stalled` sits below `busy` in the tier and above `urgencyFor`.** A card with other work
  still running is honestly working, not waiting. But left to `urgencyFor` this reads as
  ordinary neglect and takes five minutes to say anything, about a state known in seconds.
- **The nudge is a prompt because a prompt is what the case needs.** `NUDGE_TEXT` is nearly
  empty on purpose: the notification is already in the conversation, and what the agent wants
  is a turn in which to act on it, not Skein's paraphrase of a summary line.

### Sent, and not picked up

The same queue holds the other thing you can put in it, and for a long while the wall said
nothing at all about that one. A prompt written to a card that is already working is *queued*
behind the running turn, and until it is taken up the agent has never seen it.

`tools/probe-queue.ts` says the ordinary path is fine — spawning with Skein's exact argv, a
prompt sent mid-turn came back ~3s after the running turn's `result`, and an interrupt in
between did not lose it:

```text
 5.87s  → prompt A (long)              7.38s  → control interrupt
 5.87s  → prompt B (while A runs)      7.42s  control_response {still_queued: []}
 9.83s  result #1  B-replayed=false    7.43s  result #1  aborted_streaming
12.99s  user isReplay=true [= B]       9.47s  user isReplay=true [= B]
13.80s  assistant "bravo"             10.45s  assistant "bravo"
```

Two things there are worth keeping. The CLI reports `still_queued: []` for a prompt it
demonstrably held, so **its own account of its queue is not evidence of anything** — the
replay is. And it emits a fresh `system/init` for each dequeued prompt.

What was wrong was what the wall drew while it waited, and it was worse than saying nothing:

- **`#settleEchoes` takes the pending mark off a prompt the turn says nothing about.** It runs
  on every `assistant` message and every `result`, and its argument — being answered is proof
  of receipt — holds for the prompt that *caused* the turn. A prompt queued behind that turn
  is not the prompt that caused it. So the card came to rest with your words drawn exactly
  like words that had been delivered and answered.
- **`awaited` already knew.** It was added to stop a queued prompt being drawn twice (see
  "Settling a line is not claiming it") and then never read again — and it is the only honest
  record there is, because `--replay-user-messages` echoes a prompt back when the CLI *takes it
  up*. `Conversation.awaiting` is that flag counted, kept at the four sites that touch it
  rather than derived, and `unacknowledged` is a card at rest still owing one past
  `WAKE_GRACE_S`.
- **It is `stalled`'s twin and sits beside it in the tier**, above `urgencyFor` for the same
  reason: neglect would take five minutes to say something known in twelve seconds, about a
  card whose transcript is meanwhile claiming the prompt arrived.
- **One mechanism, two silences.** `pendingNudge` carries a `NudgeKind`, and `#nudge` re-checks
  whichever one it is before spending a turn — `awaiting === 0` for a prompt, `unwoken === null`
  for a job. On the prompt side that check is *usually* what happens: the queue drains in about
  three seconds and the grace is twelve, so the timer finds a working card and costs nothing.
- **The budgets are counted apart, and the prompt one resets only at zero.** A nudge is itself
  a prompt, so "a prompt was taken up" is a test a stuck card passes with your words still
  behind the nudge in the queue — reset there, the allowance would be restored by its own
  spending and the loop would be unbounded. `#claimEcho` clears `promptNudgeAttempts` only when
  `awaiting` reaches zero, which is the moment everything sent has been acknowledged. Neither
  budget is cleared when a turn opens, for the reason `nudgeAttempts` already gives.
- **`NUDGE_PROMPT_TEXT` hedges.** What flushes the queue is any message at all, and the thing
  behind it in that queue is your own words — so it says only where to look. And it says *if*,
  because twelve seconds is long enough for the queue to have drained since the check, and an
  agent told flatly that a message exists would go hunting for one that does not.
- **A prompt the CLI answers itself is never echoed, and that leaked until 2026-08-25.**
  `--replay-user-messages` re-emits real prompts and stays silent on locally-answered ones —
  `tools/probe-echo.ts` sent `"say only: ok"`, `/model sonnet`, `"say only: done"` and got
  replays for the first and third and *no `user` event at all* for the second. So the line kept
  `awaited` for the life of the process, and three things followed and did not stop: the card
  read `sent, not picked up` from then on, every subsequent `result` scheduled a nudge until the
  budget was gone, and — because the budget is only refunded when `awaiting` hits zero — a real
  stall later in that session got no nudge at all. Every one of the 14 nudges on this machine
  was this; three cards spent a turn to answer, verbatim, "Nothing is queued behind it".
  `/compact` is the ordinary way in, which is every long card eventually.
  `#claimLocalCommand` closes the books at the `localAnswer` branch, and the leading-slash test
  in `localCommandAwaiting` is the narrowing that keeps it safe: the `result` does not name the
  prompt it answered, and claiming a real prompt queued behind a `/compact` is the double-draw
  bug `#settleEchoes` was rewritten to avoid. Skein cannot know which commands *this* build
  answers locally — a custom `/commit` is a real prompt — and does not have to, since every
  locally-answered one is slash-shaped and no ordinary prompt is.
- **The face says *sent*, not *delivered*.** Skein knows the prompt reached the child's stdin
  and knows the wire never echoed it back. Whether the CLI is holding it or lost it is not a
  question this side can answer, and both are "you are owed a turn nobody is taking".
- **The budget is per generation of work, not per turn**, and the obvious place to clear it is
  wrong. A nudge is a prompt, a prompt opens a turn, so clearing `nudgeAttempts` in
  `#beginTurn` would have it reset by its own spending every time — an allowance of two that
  can never reach two, and no bound at all on a card that keeps stalling. `#job` clears it
  instead: a card that starts new work has demonstrably been picked up.
- **Escape cancels a pending nudge, and clears the stall with it.** The same early branch
  `#heal` needed and for the same reason — a card about to act on its own is exactly what
  Escape means "don't" at. Dropping only the timer would leave the card amber, asking for the
  thing you had just refused.
- **A dead card is not nudged.** `markExited` clears the stall along with the jobs: there is no
  process to look at anything, and the amber would be asking for a gesture that does nothing.

`WAKE_GRACE_S` is twelve seconds, which is just past the median wake delay of ten — long
enough that a card taking the ordinary path is never accused, short enough that the reading
still concerns the job you are waiting on.

### Jobs that outlive the process

The nudge above only ensures somebody reads the CLI's report. It does nothing about the loss
itself, and the loss is the part that costs a morning: a card whose process died holding a
25-minute import comes back knowing nothing about it, and the CLI's own reconciliation
notification — the one that wakes nobody — is the only thing that would have said so.

So a job is written down. Schema v17, one table, and the whole of its design is in three
decisions.

- **A row means outstanding, and settling deletes it.** There is no `settled_at` to filter on,
  which is what keeps the table from drifting away from the question anybody asks of it. A job
  that reports in needs nothing from here — its notification quotes its own `<output-file>`
  and the agent is woken to read it — so the rows left at launch *are* the jobs whose fate
  nobody knows, by construction rather than by a query.
- **Written on the receipt, never on the call.** A `starting` job is one the agent said it
  *meant* to background, and an `Agent` that ran inline after all arrives as one and is dropped
  a moment later; a row written then would be work that never existed, reported as lost at the
  next launch. The receipt is also the only place a path is ever named, so the two are the same
  moment anyway.
- **Written when the job starts, not when it is noticed.** The same rule `set_mid_turn` learned
  from the other side and the migration stamp learned from a third: bookkeeping that records
  how far something got must not wait for the getting there, because the exit that loses the
  work is exactly the one that runs no cleanup. This is why `#writeJobs` drains on every event
  rather than at the `result` like `#persistConv` does.

**`startedJob` now keeps the path, and takes the `agentId` it used to refuse.** Only the Bash
receipt names a file, and the match has to stop at `.output` rather than run to the end of the
sentence that follows it — and must not stop at whitespace either, since `AppData\Local
Settings` is a real path with a space in it. A `Monitor` and an `Agent` name nothing, and
theirs is derived at the far end from the three parts that make one
(`%TEMP%\claude\<slug>\<session>\tasks\<task-id>.output`), `transcript_dir_name` supplying the
slug exactly as it does for transcripts. **Then it is checked**: a path is only ever handed
over if a file is really at it, so a CLI that moves its task directory costs this feature its
paths rather than sending an agent to read something that is not there — which reads as the
work having vanished, not as Skein having guessed.

The agent's `agentId` was deliberately not extracted, on the grounds that its receipt says
never to repeat it. That instruction is about *user-facing replies*, and it is still honoured;
what changed is that the id turned out to be needed, because it is the same value the
notification carries as `<task-id>` and therefore the only thing that finds a subagent's
transcript. A subagent's output file is its whole conversation, so the prompt asks for a
`tail` or a `grep` rather than pretending the file is small — the agent is trusted to choose,
but the default is named.

**A roused card with outstanding rows is prompted, and that is the first thing added to
`interrupted`'s privilege since the rule was written.** It meets the same bar: a row is work
that demonstrably started and demonstrably was never reported on, and it is deleted the moment
the card is told. A card that merely finished a turn still gets nothing. Two shapes, because
the two cases are different — `resumePrompt` grows a section naming the jobs, and a card whose
turn ended *cleanly* gets `jobsPrompt` instead, which must not claim the turn was cut off or
it sends an agent looking for a half-written file it never had. They fold to different caps
for the same reason.

Both say **check** rather than **redo**, and that is not hedging. The two possible states are
far apart and only looking distinguishes them: before the job object landed (0.4.0) a
background job was orphaned and usually ran to completion — 11 of the 15 in the case this
came from had finished and written full output — and with it, the tree is killed and the work
stopped part-way. A prompt that assumed either would be wrong about half the wall, and the
expensive half re-runs a database write that already landed.

**And the news is spent once it is delivered** (`#toldAboutJobs`), or the same prompt is sent
at every launch forever. That is the failure `interrupted` carried for most of its life —
written once, read once, never unset — and it costs a turn and an agent per card per launch.
Cleared after the send and only for what was actually reported: a prompt that never left has
told the card nothing.

**Background work is still not allowed to survive a quit, and this table does not change
that.** The question was asked once the rows existed — the job object cannot tell a
sixteen-hour orphaned `bash` chain from the import you asked for, `Conversation.jobs` is
exactly that distinction, and the table is what would make it visible to Rust at
`ExitRequested`, where there is no round trip to the webview left to make. The answer is no,
for a reason worth writing down because the table makes it look otherwise:

**A row is not a handle.** Persisting a job tells Skein a job existed; it gives it nothing to
reap one with. So sparing the tree at `shutdown` would mean nothing kills it at all — the card
is gone, the window is gone, and the only reaper left is the OS when the process exits by
itself, which for a hung `bash` is never. That is precisely the measurement the job object was
added for: 80 descendants under one Skein for 6 cards, the oldest a `bash → bash → bash →
bun` chain sixteen hours old under a card long since finished with it, and a count that only
ever went up across a day. The table would make that leak *legible* rather than *bounded*,
which is the worse of the two positions, because it reads as solved.

What the distinction licenses is **warning** rather than sparing, and that is what was built:
a quit says how many cards have work running, and still kills all of it. The default stays
kill, nothing outlives the wall, and the cost is paid before the decision instead of
discovered at the next launch. (Work that genuinely must outlive Skein already has its shape
one file over — `actions::launch_detached` spawns from *Skein* rather than from a card,
deliberately, and says so where it is.)

`quit.rs` holds the latch, `quitting.ts` the wording, `Quit.svelte` draws it. Four decisions,
and each of them is the one that keeps this from becoming a worse bug than the one it fixes:

- **The count is written through as it changes, not asked for at the moment of closing.**
  `CloseRequested` is handled on the main thread inside the event loop; the only thing that
  knows which cards are busy is the webview, which cannot be asked a question synchronously
  from there and may not answer at all. So the wall reports its own count (`note_busy`) the
  same way `store::set_mid_turn` reports a turn — write the fact as it changes, so the code at
  the boundary only has to read it.
- **A second close always goes through.** `should_ask` spends the single refusal it has, so a
  wedged webview, a stale count or a dialog that never paints costs one extra press rather
  than the app. The comment in `lib.rs` about closing the studio leaving a live process whose
  only remedy was Task Manager is exactly the failure that budget keeps out, and anything
  clever enough to hold the close shut twice has reintroduced it.
- **"quit anyway" closes the window again** rather than calling some third confirm command, so
  the confirmed path and the press-close-twice escape hatch are one path. Two paths could
  disagree about what "the user said yes" means; one cannot.
- **`stay` clears the latch**, or staying would buy exactly one reprieve and the next close
  would go straight through — a dialog whose second showing is silently absent is a dialog
  that lies, since the press looks identical.

The safe answer takes the focus and Escape means it, because the destructive button on a
dialog you did not ask for should have to be aimed at. It sits above the break, which
otherwise claims to be the one thing above everything: that claim still holds for anything
that *reports*, and this is you acting — a dialog holding the close shut has to be visible, or
the window has merely stopped closing for no reason you can see.

#### The plan, and the tool names that were never arriving

`classify.ts` knew two names that this machine has **never once emitted**, and the cost was
paid twice over.

- **`Task` is not the subagent tool; `Agent` is.** 0 uses against 192, all time. Both
  `describeTool`'s case and `conversation.svelte.ts`'s seat creation keyed on `Task` alone, so
  the entire seat machinery was dead from the day it shipped — the only seats that ever
  appeared were minted by the forwarded-message fallback, which has no persona to give them
  and so called every one of them `seat`. Both names are matched now; the old one costs a line.
- **`TodoWrite` is not the plan; `TaskCreate`/`TaskUpdate` are.** 0 uses against 359. Every
  plan update fell through `default:` and printed the bare string `TaskUpdate` on the card.
- **The plan is folded, because `TaskUpdate` carries no words.** It has an id and a status,
  and the subject lives back on the `TaskCreate` whose receipt (`Task #1 created successfully:
  …`) assigned the number. `Conversation.plan` holds the pairing so the activity line can read
  `activeForm` — the gerund the model writes for exactly this purpose — instead of a verb.

The card wears a small hollow ring at its foot for background work, achromatic and drawn at
every density: at `field` the activity line is gone, and a busy card must not read as merely
quiet. It carries a count only past one. `snapshot.cards[]` reports `busy`, `jobs` and `plan`
beside `working` for the reason `aside` is reported beside `tier` — a card mid-turn and a card
holding a background job both read `work`, which is the intended effect and therefore the
thing a test cannot otherwise see.

### Turns a card may try again by itself

Four failures, and only four.

- **`malformed`** — 400, "The request body is not valid JSON: unexpected end of data: line 1
  column 429454". The conversation was serialised and the body arrived truncated. Both halves
  of the detection are load-bearing: a bare 400 is the API refusing the *content* of a request
  (a parameter out of range, a model that does not exist), which is deterministic, and
  retrying one of those is a loop that ends when the allowance does.
- **`overloaded`** — 529. One signal is enough here, because "overloaded" is not a word the API
  uses for anything else.
- **`limited`** — 429, the account's own allowance. The odd one out, and `accounts.md` owns the
  whole argument: it is a heal because the *fix* is not waiting but moving to another
  subscription, so each attempt goes to a different account and the ladder ends in a hold
  rather than a failure.
- **`dropped`** — the stream died under the turn. No status at all; see below, because it is the
  only one of the four that does not clear the usual bar the usual way.

This paragraph used to say **429 is deliberately not on this list**, on the argument that a rate
limit is not weather — it is the account's own allowance, the horizon already reports it
(`usage.md`), and it clears at a time that is *known* rather than guessed at. That argument is
still exactly right and it is still the reason a card does not *wait* on a 429; what changed
on 2026-08-21 is that Skein grew somewhere else to send it. Keep the reasoning, note what it
licenses: a 429 is retryable because there is another account, not because the door will open.

The first three share the property that licenses a retry outright: the request did not get a
turn out of a model, so re-sending repeats nothing. Every other failure has to be assumed to
have done something. A project card spawns with `--dangerously-skip-permissions`, so "send the
last thing again" is the most dangerous reflex this app could be given; it is affordable only
where the thing being repeated demonstrably had no effect. Note what that argument does *not*
claim: a turn is many requests, and the ones before the failing one may well have written
files. Re-sending is still right, because the retry resumes the same session and the agent
reads back what it already did rather than starting over blind. What must not happen is a
repeat of a request that *itself* had an effect.

#### `dropped` does not clear that bar the same way, and saying so is the point

The other three are cases where **nothing happened**. A connection lost mid-response is not:
the model produced a turn, part of it arrived, and there is a window in which a completed
`tool_use` was among the blocks that landed and was run. Waving that through as "same as a
529" is how this list would acquire a fifth member it should not have, so the argument is
made explicitly and it rests on a property of the CLI rather than of the network.

**The CLI commits the partial before it reports the failure.** When a response stream dies
part-way it does not fail the request and does not retry it — it *finalizes what it has*,
forcing a `stop_reason` onto the blocks already yielded and writing them to the session, then
appends a synthesized assistant message (`model: "<synthetic>"`, `isApiErrorMessage: true`,
`error: "server_error"`) whose whole content is the API Error sentence. A tool that ran has its
`tool_result` in the session too. So the re-send does not repeat the request: it resumes a
session that already holds whatever that request achieved, and the agent reads it back. The
failure this list must keep out is the one whose effect landed *outside* the session and was
never recorded — an MCP call that charged something, a deploy that fired. A dropped stream is
not that one, and being able to say which of the two a new kind is, is the test any fifth
member has to pass.

**How it arrives, and why nothing saw it for months.** The synthesized message is the last of
the turn, so the `result` reads `subtype: "success"`, `api_error_status: null`,
**`is_error: true`**, and `result` is the sentence. `endingFor` therefore already said `error`
and the card already went rust — what was missing was any predicate that matched, because every
existing one asks for a number and this failure carries none. Read out of claude 2.1.241's
bundle and confirmed against all 292 session transcripts on this machine: six occurrences in
three weeks, plus two of `Unable to connect to API (ENOTFOUND)`, which is the same failure one
layer earlier and is included.

**Deliberately not `Server error mid-response`**, the seventh sentence off the same ternary in
the same function. That one is the service answering badly rather than the link going, and its
ladder is the overloaded one. Nothing on this machine has ever produced it, and a predicate
written for a shape nobody has met is the mistake `wasRateLimited` spent four months making —
route it to `overloaded` when somebody actually meets one.

**What it cost while nothing retried it.** 2026-08-27T03:21:47 — three cards, 48ms apart, all
`fail`, $11.14 of turn between them. Each then sat rust until a human or a stray relay message
poked it two to four minutes later, and one card on 25 Aug was never poked and simply ends
there. That is the case for the feature and it is worth keeping in figures, because the failure
is invisible from the wall: a card that has stopped is indistinguishable from a card that
finished.

**The honest residue.** The text re-sent is `#lastSent` — your prompt again — so a card that had
already written half an answer is being asked for the whole of it a second time. That is waste
rather than danger, and the alternative is worse in kind: Volery composing a "carry on" of its
own puts words in your mouth to save tokens. Measured, it is close to free anyway — four of the
six had produced nothing but an empty thinking block when the wire went, because the
"mid-response" wording fires on *any* block having been yielded, an empty one included. If it
ever does prove wasteful, the refinement available is not a cleverer sentence: Volery folds the
stream and already knows what the turn produced, so the decision could be made on the turn's
own shape rather than on the CLI's wording.

**`faultText` is the gate, and it is the one piece here that is easy to leave out.**
`result.result` on a turn that *succeeded* is the agent's own final message — so without it, a
card that answered a question about a 529 by quoting one reads as having hit one, and Skein
re-sends your prompt on the strength of the agent talking about the weather. In this repository
that is not hypothetical. Both callers happen to sit behind `ending === "error"` already, so it
is belt to that braces; it exists because the next caller will not know to stand there.

The ladders differ because the failures do, and **the variable that sets each one is how much
waiting has already been done by somebody else.**

A truncation waits 1s then 4s, and that wait is for **you** — a card that fails and re-sends
inside the same tick reads as a card that did nothing, and the note would be gone before it
could be read. An overload starts at **15s** and runs 15s → 45s → 2m → 5m, because by the time
a 529 reaches a `result` the CLI has already spent its own internal backoff on it; a card
asking again a second later is asking a question that was just asked several times and answered
the same way. A rate limit does not wait at all, because the next attempt is a different
account (`accounts.md`).

A dropped wire runs **5s → 20s → 60s**, three rungs, and both ends of that are measured. The
CLI spends **no** backoff of its own here — it finalizes the partial and gives up on the first
drop, which is exactly how three cards produced the error 48ms apart — so nothing is owed to a
queue and the 15s opening would be Volery inventing a wait nobody asked for. What *is* owed is
a moment for the link to come back, and one second is not it. Five is: on this machine another
card was answering normally 3.9s, 5.1s and 14.2s after the three drops that could be timed. The
whole ladder is under ninety seconds because a link still down after that is not having a blip,
and every attempt is a whole conversation back up the connection that just failed.

**Two of the four arms are jittered — `overloaded` and `dropped` — and the truncated one is
not.** The asymmetry is the point, and the two jittered arms are jittered for the same reason
applied to two different shared things. An overload arrives at *every card at once*, and twenty
cards re-sending a whole conversation in the same tick is a thundering herd aimed at a service
that has just said it is over capacity. A dropped wire also arrives at every card at once —
that is the 03:21:47 triple — but what a herd would saturate there is **the machine's own
uplink**, which is the thing that just gave out. Same instinct as `ROUSE_GAP_MS` either way. A
truncation needs none of it: it is one card's transport, and two cards hitting it together is a
coincidence, not a cause. The roll happens once, in `#heal`, so the note names the wait the
timer actually holds — a card that says "in 15s" and goes at 19 is an instrument lying about
itself.

Nothing outside `classify.ts` had to change for the fourth kind, and that is worth noticing
about the shape rather than about this feature. `conversation.svelte.ts` drives the whole
decision off `healKindOf`; `#heal`'s `activity` ternary falls through to "trying again…", which
is already the honest string; `repairWorthTrying` is an allow-list of `malformed` rather than a
deny-list, so a new kind is excluded from the session repair by default rather than by
remembering to exclude it. A fifth kind costs the same. **An allow-list is the reason** — the
deny-list spelling of that function would have quietly run a repair against a conversation that
had nothing wrong with it.

**A `malformed` failure has two causes and the heal can only fix one of them**, which is what
`repair.md` is about. A body cut short in transit clears on a retry; characters the
*conversation* cannot express never do, and every attempt is an identical failure costing a
whole upload. `wasMalformedRequest` cannot tell them apart — the API says the same thing
either way — so the first heal attempt looks at the session file before re-sending, and what
it finds is the answer. Found 2026-08-19: a `grep -a` over `claude.exe` had put 1,222 NUL
characters in one tool result, the budget went on retries that could not have worked, and the
card then blamed a size that was never the problem.

`HEAL_BUDGET` is per kind and **per turn, not per card**: any turn ending some other way resets
it, so a card that healed this morning starts the afternoon with its full allowance.

Three separations make it safe, and each was a way of getting it wrong:

- **Only what this window sent.** `#lastSent` is set in `echo` and nowhere else. A `user` event
  with no line waiting for it is a terminal appending to the same session, and re-sending
  *that* would be Skein putting words into a conversation it is not holding.
- **The card decides, Skein does.** `Conversation.pendingHeal` is a field and not a callback,
  because the card must be able to come to rest holding one: the wall's tick, the ledger and
  the persistence all run off the same `result`, and a re-send fired from inside `ingest` would
  land in the middle of them. `conversation.svelte.ts` also never talks to Rust.
- **The failed attempt is still a turn.** `#heal` runs *after* `#persistConv`, so the broken
  turn lands in the ledger like any other. A retry that swallowed it would make the day's
  figure understate what the wall spent.

It is never silent. The error line is pushed before a heal is considered, `healNote` says which
failure, which attempt out of how many, and how long the card will be quiet — a card that has
gone still for five minutes should not need the reader to guess whether it is thinking or
waiting — and `healGaveUpNote` accounts for the rust when the budget is spent. That last line
is written only where the *budget* is what stopped it: a card with nothing to re-send has not
given up on anything, and saying it had would describe a decision nobody made.

**Escape cancels a heal, and that check sits ahead of `stop`'s `working` guard.** A card waiting
to try again is not working — that is the whole state — so without the early branch the one
card on the wall visibly about to act on its own was the one card Escape could not stop. The
scheduled timer is dropped on `detach`, `clear` and `close` for the same reason `Listeners`
exists: in dev, `detach` runs on every file save, and a surviving timer is a prompt re-sent by
an instance whose wall is already gone.

### The job table gets its second and third readers

`pending_jobs` was written for one caller — `rouse`, asking what the previous process left
behind. Two more now read the same table for the opposite question: **what is this process
holding right now.** The table did not change; only the number of things that had ever thought
to look at it.

That is the observation worth carrying out of both sink items (80e0a4ad and fb3e537d), because
neither needed anything new recorded. **A record written for "what was lost" is also the
answer to "what is running", and the only difference is the scope you read it at.**

- `store::outstanding_jobs(db, card, session)` — session-scoped, read by `hooks.rs` from a
  short-lived process, so a card can be handed back the background work its own context has
  been summarised past. `.claude/rules/hooks.md` owns the argument.
- The panel's drawer — reads `Conversation.jobs` live for the list and asks `pending_jobs` for
  the paths of the kinds whose receipt named none. `.claude/rules/panel.md` owns that one.

Both lean on the property this file already states and neither of them could have been built
without it: **a row means outstanding, and settling deletes it.** No `settled_at`, nothing to
filter on, no way for the set of rows and the set of unknown-fate jobs to drift apart. A table
with a status column would have made both of these a query somebody had to get right, and
therefore a query somebody could get wrong in a way nothing would report.

The one thing that had to be added is `session_id` as a *predicate* rather than only a stored
value. It was already on the row, for the reason `migrate_v17` gives — a cleared card keeps its
id and takes a new session, so the output path must be built from the session. Reading it back
turns out to be what separates the two questions: a row from a dead session is what `rouse`
wants and is exactly what a live card must not be told about, since `rouse` has already said it
and deleted the row.

**And `outputPath` finally has a reader.** It has been carried since job persistence landed —
scraped out of the Bash receipt by `startedJob`, derived and existence-checked by
`pending_jobs` for the other three kinds, quoted into a resume prompt — and nothing had ever
opened the file. The drawer does. Note what that does *not* change: the path is still only ever
handed over if a file is really at it, because sending an agent, or a person, to read something
that is not there reads as the work having vanished rather than as Volery having guessed.
