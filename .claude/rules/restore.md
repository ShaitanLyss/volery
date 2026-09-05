---
paths:
  - "src/lib/rousing.ts"
  - "src/lib/skein.svelte.ts"
  - "src/lib/history.ts"
  - "src-tauri/src/sessions.rs"
  - "src-tauri/src/supervisor.rs"
  - "src/lib/Import.svelte"
---

# Lazy restore, rousing, setting aside, and adopting sessions

### Lazy restore, and rousing the wall

On launch the wall is painted entirely from SQLite — every card in its pinned position,
title, and the context fraction it reached — with **zero** `claude` processes spawned and
nothing awaited, which is what makes the first frame cost a query however many cards are on
it. A card is `dormant` until it has a process, and `Skein.wake()` spawns with `--resume`
(or `--session-id` when there is no transcript to resume). Dev server groups start eagerly —
they are the slow thing and nothing about them is speculative.

**Which of those two it is, is asked of the disk** — `spawn_conversation` looks for
`~/.claude/projects/<slug>/<session>.jsonl` and decides there. It used to be told, by
`resume: conv.everSpoke`, and `everSpoke` is `last_ending IS NOT NULL`, which answers *did a
turn ever finish*. Those are different facts and a card killed part-way through its first
turn has the second without the first: it came back wanting `--session-id` against an id the
CLI already knew, and the child died at once with `Error: Session ID <id> is already in use.`
on stderr and **nothing on stdout** — no `result`, so the card had only a stderr line and an
exit code 1 to show for it. Rousing is what turned that from a click you could avoid into
every launch, since interrupted cards are woken first and being interrupted is exactly how a
first turn ends up unfinished. Probed 2026-08-14 against claude 2.1.232 with
`tools/probe-resume.ts`: a spawn that is never spoken to writes **no file at all**, so the
file existing means something was said and can be resumed, and the check needs no second
condition. It fixes the other direction too — a row claiming an ending whose transcript has
since been deleted now starts fresh rather than dying on `No conversation found with session
ID`. The front end no longer passes the flag: one question with a file for an answer must not
have a second, staler answer travelling beside it.

**And then the file was asked about under a name the CLI does not use.** Both sides ask the
same question — the CLI refuses `--session-id` for a session it already has a transcript for,
`Own()` in the bundled JS being a `statSync` of exactly this path — so the only way to
disagree is to spell the directory differently, and a junction is how. `C:\Users\lyss` on this
machine points at `C:\Users\flori`; Windows resolves a reparse point when a process's current
directory is *opened*, so a child spawned with `current_dir("C:\Users\lyss\codes\rise")`
reports the target from `process.cwd()` and files under `C--Users-flori-codes-rise`, while
Skein looked under `C--Users-lyss-codes-rise` and found nothing there. Every card in those two
territories therefore spawned fresh, and the first wake after one had spoken died on `Error:
Session ID … is already in use.` — exit 1, nothing on stdout, the same failure the paragraph
above is about, arrived at from the opposite direction. Found 2026-08-26 from an account swap,
which is where it shows: closing and respawning seconds after a card spoke is the one path
that wakes a card that recently had a transcript. 17 cards, 9 of them live, and not one
`C--Users-lyss-…` directory under `~/.claude/projects` to show for them.

So `transcript_dir_name` canonicalizes before it folds, and the pure fold is `fold_dir_name`
underneath it — every caller reaches the resolving one, because a caller that has to remember
is the shape of the bug before it happens. The general rule it is an instance of: **a path
used to predict what another process will do must be the path that process will see, not the
one we typed.** Two spellings of one directory is not a case a string test can reach, which is
why `a_junction_folds_to_what_it_points_at` makes a real junction — every string test in that
module passed throughout.

Because of this, anything a dormant card must display has to be persisted in
`store.rs::update_conversation` as turns settle.

**Laziness is about the paint, not about the processes.** Behind the painted wall two passes
run and neither is awaited: `#fillHistory` reads the transcripts, and `#rouse`
(`rousing.ts`, pure: the order, the pacing, the words) gives every dormant card its process
back and asks any card that was mid-turn when the app closed to pick that turn up. Waiting
for a click bought nothing — a wall you have to touch card by card before it can do
anything, and a card left half-way through editing a repo sitting there saying `interrupted`
until somebody noticed.

- **A card is *prompted* only where something was demonstrably lost.** Waking is cheap and
  reversible: a `claude -p` with nothing on its stdin is a process and no tokens. A prompt is
  neither — it spends money and starts an agent editing a repo with
  `--dangerously-skip-permissions` — so it is reserved for the cards that can prove they need
  one. Two things now qualify, and the second was the first addition since the rule was
  written:
  - `interrupted`, a turn that was open when the app went away.
  - a row in `job`, background work that started and was never reported on. It meets the same
    bar rather than widening it: the row is written when the job starts and deleted the moment
    the job reports in, so what is left at launch is only ever work whose ending nobody heard.
    It is deleted again once the card has been told (`#toldAboutJobs`) — without that, the same
    news is delivered at every launch forever, which is the failure this flag's own history is
    the cautionary tale for. See `turns.md`, "Jobs that outlive the process".

  A card that merely finished a turn still gets nothing, and a card that is *both* gets one
  prompt rather than two — `resumePrompt` grows a section naming the jobs. The card whose turn
  ended cleanly gets `jobsPrompt` instead, which deliberately does not say the turn was cut
  off: telling an agent to go and find its half-written file when it has none sends it looking
  for damage that was never done.
- **The flag is written as the turn opens, not worked out at the end**, and getting that
  backwards cost the whole feature on the exit it exists for. It used to be filled in one
  place — `Supervisor::shutdown` → `mark_interrupted`, at `ExitRequested` — which quietly made
  the column mean *the app was asked to close while this was mid-turn*. A crash asks nothing.
  Nothing ran, nothing was written, and the wall came back from a kill with every card
  claiming its last turn finished cleanly and rousing finding nothing to resume: the exact
  inverse of the over-firing above, and the worse one, since over-firing costs money and
  under-firing costs the work. `store::set_mid_turn` now writes both boundaries where they
  happen — `send_prompt` opens (a prompt on the wire and unanswered is a lost turn), the
  reader thread closes on `result` — so what survives a crash is a row that was already true
  before it. Three things fall out of that:
  - **On a transition only.** `stream_event` says "open" thousands of times a turn and the
    row wants telling twice. `turn.swap(open) != open` is the guard.
  - **The stream ending clears it, unless the app is what ended it.** A child that died
    holding a turn is a card standing on the wall saying so, and resuming it tomorrow spends
    money on a failure you were already shown. But quitting ends every stream by killing it,
    which is precisely the case the mark is for — so `shutdown` raises `going_away` before the
    first kill and the reader threads read it on the way out. Without that the kill races the
    cards worth flagging and clears them.
  - **Nothing may clear it on send any more.** `#deliver` used to, on the reading that a lost
    turn which has been answered stops being news. Under the new rule that write lands on a
    turn `send_prompt` opened a moment earlier — the card reporting as finished the turn it
    has just begun — and a quit during it comes back with nothing to resume. The card stops
    *saying* interrupted at once; the row is left to Rust. `mark_interrupted` stays at exit as
    a backstop, where it can only ever assert what the row already says.
- **Rousing broke the definition of `interrupted` on its way in**, and the whole wall was
  resumed at every launch for it — cards at rest included, each one a resume prompt spending
  money to go and read `git status` about a turn that had ended cleanly hours before.
  `shutdown` returned every id it killed, which was a fair reading of "was running" back when
  only a card you had spoken to had a process. This pass hands one to *every* dormant card, so
  after it shipped, quitting flagged everything on the wall. The supervisor now tracks the
  actual question on the `Conv` — `turn_mark` in the reader thread, speech opens a turn and
  `result` closes it, and `send_prompt` sets it on the write so a prompt still on the wire at
  quit counts as lost. It is deliberately the *only* wire vocabulary in Rust: both places
  that read it are there — the reader thread that writes the row, and `ExitRequested`, where
  there is no round trip to the webview left to make. Schema
  v10 clears what the old rule wrote, because a stored `1` from before it cannot be told from
  a real one. The general shape is worth carrying: **anything that makes the wall do more on
  its own has to be re-checked against every flag that meant "you did this"** — `interrupted`
  and `aside` are both readings of intent, and rousing is the app acting without any.
- **You outrank the queue.** Each card is re-checked when its turn comes up rather than when
  the order was taken: one you have already woken is skipped, and one that is already working
  is not sent anything. So speaking to a card during the launch cannot land a resume prompt
  on top of what you just said.
- **Interrupted cards go first**, then the wall's own order, `ROUSE_GAP_MS` apart. Sequential
  with a gap for the reason `broadcast` gives — thirty spawns in one tick is a thundering
  herd on a machine that is also painting a wall and starting dev servers.
- **The flag has to clear, or the same lost turn is resumed at every launch.** Nothing used
  to unset `interrupted`; it was written at shutdown and read once. What clears it now is the
  turn itself ending — the `result` that closes the resumed turn writes the row back to 0,
  whoever's prompt opened it. `update_conversation` keeps the parameter and no longer has a
  caller: see above for why a send must not be what clears this.
- **A prompt nobody typed arrives introduced — and folded.** The panel must not quietly put
  words in your mouth; that is the same honesty `echo`'s pending mark spends its complexity
  on. But it must not shout them either, and it did: the prompt is twenty lines written *for
  the agent*, and drawn whole at the head of every roused card it was the first screen of a
  wall coming back from a crash. So `blocksOf` folds it (`isResumePrompt`) behind
  `RESUME_CAP` — "resumed by skein — the turn was cut off" — which says whose words they are
  in one line and leaves them one click away. See `panel.md` for why it is folded by its
  words rather than by a line kind of its own.
- **The cap replaced a `meta` note above the prompt, and that is a strict improvement in one
  respect.** The note was Skein's own and is in no transcript, so a card restored from disk
  drew the prompt with nothing at all to say where it came from — the two halves of the panel
  disagreed. The cap is derived from the prompt's text, which both halves have.
- **The old note broke `trimOverlap`, which is worth knowing before writing another one.** The
  overlap guard anchored on `live[0]`, and Skein's own meta lines are in no transcript, so a
  roused card matched nothing and kept the file's copy of the prompt directly above the live
  one. It anchors on the first non-`meta` line now, which is what the resume prompt still
  relies on being: it is an ordinary `you` line on both sides, so the anchor finds it and cuts
  there. The race is real rather than theoretical: the sends happen while `#fillHistory` is
  still working along the wall.
- **The prompt spends its length on looking first.** An interrupted turn died somewhere
  unknown — a file half-written, a command that may or may not have run — and the agent's own
  last message is the *least* reliable account of it, having been cut off before it could
  report. So `resumePrompt` sends it to `git status` and the tree, and says to stop and ask
  rather than guess: a guess at half-finished work is worse than a question, because it looks
  finished. Hand-wrapped, like `conflictPrompt`, since the panel renders GFM breaks.
- **The queue prompts only what *it* woke**, which is not the same as what has a process.
  `wake` answers "does this card have a child", and answers yes when Rust refuses the spawn
  because something else already made one — which is right for a click and wrong here. The
  case that separates them is the one `SKEIN_NO_WAKE` exists for: a second Skein against the
  same store has already spawned this card and already sent it whatever it needed, so a resume
  prompt from this queue is a *second* agent told to pick up the same cut-off turn, in the same
  working tree, with `--dangerously-skip-permissions`. `#spawn` says which of the two happened
  (`spawned` / `already` / `failed`) and `rouse` prompts on the first alone.
- **And it does not send what the resumed session is already holding.** A rouse prompt goes
  down the child's stdin like anything you type, so the CLI records it as an ordinary `user`
  message — and `--resume` puts the whole transcript back in front of the model. A card sent
  one that died before it could answer therefore comes back *already holding it*, and the next
  rouse composed a second, byte-identical copy and sent it beside the first. Two real sends
  against a real allowance, for an agent that then reads the same twenty lines twice with
  nothing anywhere to say why. `unansweredRousePrompt` (pure, in `rousing.ts`) is the guard,
  and **agent speech is what settles it**: a prompt the card answered is history, and a later
  crash is a new turn worth a new prompt, so the scan runs from the end and stops at the first
  `text` or `tool` line. Anything else in between — your own words, a note, a message from
  another card — is a prompt queued *behind* an unanswered one, which does not make it
  answered. Skipping is said out loud (`ALREADY_ROUSED_NOTE`, shaped like `RESUME_CAP` because
  it is the same event with the send taken out), for the reason every other thing Skein does
  on its own behalf is said: a card the queue left alone on purpose must not read as one it
  forgot. `loadHistory` shares its in-flight read so this can be asked at all — `#fillHistory`
  is running beside the queue, and what is being asked of that file is not the scrollback but
  whether to spend money.
- **But that guard is not why anyone went looking, and the thing that was is `#heal`.** Sink
  `01e00f30` reported `resumePrompt` arriving twice in one turn and proposed two causes: the
  rouse queue firing twice, or `--resume` restoring a pre-crash copy. Both are wrong, and the
  second is only the *shape* of the truth. `Conversation.echo` writes `#lastSent` for every
  send this window makes, **skein's own included** — so when a resume prompt's turn dies before
  reaching a model, the thing `#heal` re-sends is the resume prompt. The failed attempt is
  already in the session file, because the CLI records a prompt when it *takes* it rather than
  when it answers it, so the retry lands beside its own copy.

  Settled 2026-09-05 from this machine's transcripts rather than from the experiment the item
  asks for, which would have meant killing a running wall: every doubled app-composed prompt on
  it — six, across four cards — follows a failed turn at a delay sitting on `healDelayMs`'s
  ladder, the two in the report 15.5s and 17.4s after a `529 Overloaded` against a base of 15s
  plus up to 25% of jitter. The reporting card was auditing its own input during the 2026-09-03
  outage, where every one of its turns 529'd for twenty-two minutes; the "doubled" nudges beside
  them are `NUDGE_BUDGET`'s two attempts, twelve seconds after each of two failures.

  **The retry itself is right and did not change**: a turn that never reached a model has to be
  tried again, or an interrupted card is never picked up at all. What was missing was a
  *marker* — `healNote` tells the person and the agent was told nothing — and `withResendMark`
  is it: the re-send now carries a sentence naming skein, the attempt and the cause. It is
  **appended, never prefixed**, and that is the constraint to know before touching it. Every
  recogniser here anchors on a prompt's first words, so a prefix would stop the resume prompt
  folding behind `RESUME_CAP` on precisely the retry the mark exists to explain;
  `rousing.test.ts` asserts that the fold and `unansweredRousePrompt` both survive a marked
  prompt, because a change to the *anchors* breaks it just as surely as a change to the mark.

  Worth carrying past this file, because it is a general trap in anything that replays: **a
  retry of a prompt that was recorded on receipt is a second copy in the context, not a second
  attempt at the first** — and the thing that makes it survivable is saying so in the copy that
  arrives second. The arithmetic and the timings are on `#heal` in `skein.svelte.ts`.
- **And two callers share one spawn rather than racing over it.** `wake`'s guard was
  `conv.dormant`, read before an `await` and cleared after it, with a Rust-side spawn that
  takes seconds — long enough for the queue, a click and a send to all be inside the window.
  `#waking` is a single-flight map keyed by id: whoever arrives second awaits the promise the
  first is holding. Rust's own guard was the same shape and is atomic now
  (`Supervisor::claim`), so the second spawn is refused rather than granted — two `claude`
  children on one session, of which the map kept the second while the first ran on with no
  handle left to kill it. Both halves were needed: without the front-end one the second caller
  merely sees an error it has to interpret, and the caller that usually sees it is `rouse`.
- **A loop cannot be unsubscribed**, so `detach` sets a flag the queue checks each time
  round. This is the `Listeners` hazard in a shape `Listeners` cannot fix: editing a
  front-end file constructs a second Skein while the first one's queue is still walking the
  wall, and left running it would spawn against ids the live Skein is also spawning against
  and send a second copy of every resume prompt. **The flag lands before the replacement
  exists**, which is the half it is worth nothing without and was checked rather than assumed
  while narrowing `01e00f30`: Svelte's HMR wrapper calls `destroy_effect` on the outgoing
  branch *before* it constructs the incoming one, and `onDestroy` is a teardown that runs
  synchronously inside that — so `detach()` has set the flag before the new component's script
  body reaches `new Skein`, let alone before the effect that calls `load`.
- **A card you set aside is left where you put it**, interrupted or not — see below. That is
  the strongest of the things the flag means: rousing spawns a process per dormant card and
  prompts the ones that lost a turn, and a card put by for later is precisely one you have
  said you are not carrying on with.
- **`SKEIN_NO_WAKE=1` turns the whole pass off** (`supervisor::wake_quiet`, sharing
  `servers::quiet`'s vocabulary), leaving the wall exactly as lazy as it was before. Two
  reasons it must exist: a second Skein against the same store would otherwise resume every
  session in the workspace a second time, appending to transcripts the first instance is
  holding — the same pairing `SKEIN_NO_SERVERS` exists for — and there has to be a way to
  open the wall and look at it without spending money. Advisory in the same way: every card
  still wakes the moment it is spoken to.

The control surface has a `rouse` op driving that same pass, and `snapshot` reports
`wakeQuiet` and `rousing` — a wall left dormant on purpose and one whose every wake failed
look identical from outside, and a card that is dormant *yet* is not one that is staying
that way.

### Closing a card changes the wall first, and does the bookkeeping after

`Skein.close` removes the card from `convs` **before** it awaits anything, and that ordering
is the whole of a bug that shipped. It used to read the other way round: three `invoke`s —
`close_conversation`, `close_conversation_record`, `forget_jobs` — and the removal
underneath them. So the gesture was hostage to all three. One that never answered left the
card standing on the wall with its process already killed: dormant, hollow, dashed, and
refusing to go, while the row behind it had already been marked closed. The wall and its own
database disagreed, and the only way out was restarting Skein — at which point
`load_studio`'s `closed_at IS NULL` swept up in one frame the card the wall had been
insisting on for an hour.

That is worth stating as a rule, because the shape recurs: **the part of a gesture the eye is
owed must not be downstream of an `await`.** `Conversation.echo` won this same argument for
prompts and paid for it with `state: "pending"` (see CLAUDE.md); closing needs no marking at
all, because a card taken off the wall has nothing left to be honest *about* — what a failed
command owes is a line in `fault`, not a card that will not leave. `closeConv` in
`App.svelte` holds up the same end: releasing the draft and moving the focus are both ahead
of the await, and the next card to focus is found by *excluding* the closed one rather than
by reading `convs[0]` afterwards, which is what makes it independent of when the removal
lands rather than merely usually right.

Two things fall out of the ordering and are not free:

- **`retiring` is deliberately not set**, where `clear` sets it. It is what stops our own
  kill being read as a crash and it is `markExited` that reads it — which the card can no
  longer reach, having left `#byId` on the line above. Nothing is left to mislead.
- **`Studio.forget`, not `unpin`.** `unpin` means "let it flow again" and therefore keeps a
  card's glass spot on purpose; a card that has gone for good would have left one behind for
  the rest of the session.

And it widens a window that was already open, which is why `rouse` grew a second guard. The
queue walks a **snapshot** (`rouseOrder` is a priority, not a membership list), and it
re-asks `dormant` at each card precisely because a second or more passes between one and the
next — long enough for you to have woken it, and equally long enough for you to have *closed*
it. Without `#byId.has`, a card shut during the launch pass is still walked up to and woken,
spawning an agent against a row that has just been marked closed, for a card nothing on the
wall can see.

#### An agent's close fades; yours goes at once

`close` takes a second argument saying who asked, and it reaches exactly one thing: whether
the wall *draws* the card leaving. Your own close is instant, and an agent's — `close:asked`,
from `mcp__skein__close` — fades over `LEAVE_MS`.

The asymmetry is the point rather than a nicety. You closed it, so you already know it went;
a card lingering half-gone is the wall taking a moment to agree with your hand. An agent
closed it while you were reading something else, and a card that vanishes between two glances
is indistinguishable from one you had misremembered being there — which on a wall whose whole
claim is that you can look away from it is the difference between tidying and losing things.

**And a fade is exactly the shape that would reintroduce the bug above, if it were built out
of waiting.** It is not. Everything in the section above still happens on the same three lines
in the same order with no `await` in front of any of it: the card leaves `#byId`, leaves
`convs`, and its glass spot is forgotten. What fades is the DOM node Svelte keeps alive to run
an outro on *after* the item behind it has left the keyed block — `out:leave` in
`Canvas.svelte`, on both the wall's card block and the glass's. So the bookkeeping is not
delayed by a millisecond and only the pixels linger.

That is the load-bearing distinction and it is worth stating in the general: **a delay you can
see must be made of pixels with no state behind them.** The tempting shapes all fail on it — a
card kept in `convs` for half a second is a card `rouse` can still walk up to and wake, that
an event can still be routed to, that Tab can reach, that the marquee can gather, and that a
strand can land on; a removal awaited behind a timer is the shipped bug with a nicer face on
it. `Skein.leaving` is deliberately none of those. It is a list of ids the canvas alone reads,
asked exactly once per card at outro time, and every question about what is *on* the wall is
still asked of `convs` or `#byId` — both of which lost the id before `leaving` gained it.

Three things fall out and none of them is free:

- **The mark goes on before the removal**, not after. The canvas reconciles its keyed block a
  microtask after `convs` changes and asks `leaving` then; an id written afterwards would
  arrive to find the outro already begun without it. Still nothing awaited — two synchronous
  statements in the order that makes them true.
- **The mark has to come off again**, or `leaving` is a list that only grows, one entry per
  card closed all day. `#leaves` is a timer per card, held and cleared in `detach` for the
  reason `#heals` is: in dev, a superseded Skein is constructed on every file save. The timer
  is bookkeeping about a list and not about the drawing — the fade is a CSS animation Svelte
  owns, which neither waits on it nor is timed by it — so it may be late and nothing is wrong.
  What it may not be is early, hence `LEAVE_MS` plus a frame's grace.
- **The fading node is made untouchable and put below the live cards**, both set on the
  element by the transition function itself, because the block that owned its inline styles has
  been destroyed and there is nobody left to write them reactively. Untouchable because every
  gesture on the wall finds its target by `closest("[data-conv]")` from an event, so without it
  there is half a second after each agent close in which you can focus, drag and right-click a
  card that exists nowhere but on the screen. Below, because removing a card reflows the ones
  after it and they walk into its slot: a transparent card drawn *over* the one arriving is
  `ambience.md`'s one hard rule broken the wrong way round. Underneath, the wall closes over
  what left and everything solid is in front of the transparent thing rather than seen through
  it — which is also the honest reading of the rule, whose bug was a card that stayed
  transparent rather than one that was on its way out.

`LEAVE_MS` is 520 and lives in `layout.ts` beside `settle`, stated against `WALK_CAP_MS`
rather than as a number: longer than the longest walk, so the thing that left is still there —
dimmer each frame — for the whole of the closing-over, and shorter than two, because the card
is not the subject and neither is its exit. `layout.test.ts` holds both ends of that, and
holds `WALK_CAP_MS` to being the cap `settle` actually applies.

**Opacity and nothing else** — no travel, no scale, no easing. That is what makes
`prefers-reduced-motion` need no branch here: the house position, settled by the strand in
`relay.md`, is that reduced motion gets the same mark *held and faded* rather than nothing,
because what the effect says still needs saying. The way to honour that is to build the effect
out of the part that survives it, instead of writing a second code path that has to be kept in
step with the first. A card going quietly is the whole message; there was never any motion in
it to take away.

### Setting a card aside

Amber on this wall means *nobody has been back to this in a while* — urgency here is
neglect, and neglect is measured by a clock (`urgencyFor`). That is fair about a card you
forgot and false about one you parked: half-finished work you mean to return to, a session
held open for the context in it, a thread waiting on somebody else. Left alone those cards
warm on the same clock as everything else, join `waiting`, and take their turn in the Tab
cycle — at which point the cycle has stopped being a list of things that want you, which is
the only thing it was for. Rousing made it acute: with every card given its process back at
launch, everything on the wall is eventually overdue.

So a card can be **set aside** — right-click, `set it aside` / `pick it back up`. Nothing
stops, nothing closes, nothing on disk moves; it keeps its process if it has one, its
transcript, its place and its context. What it stops doing is counting.

- **It goes into `urgencyFor`, not into the places that read a tier.** `waiting` in
  `App.svelte`, the dock's count, `attention.items` and the card's own colour are four
  readings of one question, and the comment above `URGENCY` claims that question is answered
  in exactly one place. Filtering the cycle instead would leave a card out of the Tab cycle while
  still blooming amber on the wall — the wall arguing with itself.
- **It silences decay, not events.** The check sits *after* the `error` and `asked` arms:
  those are things that happened rather than time passing, and a card that broke in the middle
  of the turn you walked away from still has to be able to say so. In practice a card set
  aside has nothing running, so those arms only ever concern the one you set aside mid-turn.
- **Speaking to it picks it back up** (`Skein.#deliver`, on a *delivered* prompt — a send that
  never left has changed nothing). There is no second gesture to remember, and the alternative
  is an agent working away on a card that has opted out of saying it has finished. The dock
  says so on the target line while it is still true.
- **Persisted, because both of the things it protects against happen at launch** — the waiting
  cycle is the same cycle tomorrow, and the rousing queue would otherwise hand back exactly
  the sessions you had put down. Schema v6, one column, and it rides on `update_conversation`
  rather than getting a command of its own: it is only ever written by the gesture that sets
  or unsets it, so it always arrives carrying the value it means and the COALESCE never has to
  express "back to the default" (which is the whole reason `clear_conversation` is separate).
  Written through immediately rather than at the next settling turn — a card set aside is very
  often one that will never take another turn, and `update_conversation` otherwise only runs
  off a `result`.
- **Drawn as a mute and a mark, never a colour.** The label reads `set aside` with no age
  beside it — the age is the reading being withdrawn, and a card put by for a fortnight is not
  four hundred hours overdue. The mark is a small bar at the opposite corner from the pin,
  achromatic, and it is the only thing that says so at `field` density, where there is no room
  for a label and a card set aside and a card genuinely resting are both muted. Opaque like
  `.pin`, or the ambience comes through it.
- **One menu item with two labels**, the shape `unpin` already has: it is one state with two
  sides and only one of them is ever available. Not marked danger — a prompt undoes it.

The control surface has an `aside` op (defaulting to true, returning the tier, since a card
that went aside without going `rest` has not actually been set aside), and `snapshot.cards[]`
carries `aside` beside `tier` — the two cards it distinguishes both read `rest`, which is the
intended effect and therefore the thing a test cannot otherwise see.

### Scrollback, and adopting sessions Skein did not start

`--resume` hands the model its history but replays **nothing** onto the stream. Probed
against 2.1.228: resuming a two-turn session with `--output-format stream-json` emitted
`system/init`, the new prompt and the new answer, and no historical messages — the model
answered from context it had, and stdout never carried it. The TUI's scrollback is not a
stream feature either; it reads `~/.claude/projects/<slug>/<session>.jsonl` and renders it
locally. So Skein reads the same file: `supervisor.rs::read_transcript` (tail-capped, 8 MB)
hands it to `history.ts`, which folds it into the same `Line`s the live stream produces. That
is what stops a restored card from being blank.

Reading happens as the wall loads, four files at a time, and is not awaited — the wall is
painted and correct without it. This does **not** compromise lazy restore, which is about
*processes*: a transcript read spawns nothing, so there is no reason to make a click pay for
it. Every path that puts a card on the wall starts one (`load`, `open`, `importSession`), and
`loadHistory` is idempotent, so opening the panel is then a no-op. One consequence: waking a
card while its file is still being read can leave the new turn in both places, so
`trimOverlap` cuts history at the first line the wire also carried.

The transcript's vocabulary is *not* the wire's, which is the whole difficulty —
`attachment`, `last-prompt`, `ai-title`, `mode`, `file-history-snapshot` and friends
outnumber speech, `isMeta` records are context Claude Code injected rather than anything
anybody said, and a prompt is a bare string from the TUI but a text block from the SDK.
`history.ts` records the counts it was written against.

Adoption (`sessions.rs`, the `adopt` chip) is the same file read the other way round: a
session recorded by the CLI becomes a card by writing a row that **points** at it. Nothing
is copied and nothing moves — waking that card runs `--resume` against the same file and
appends to it, so the session stays resumable from a terminal afterwards, Skein's turns
included. Two things hold it together:

- `import_conversation` sets `last_ending = 'ok'`, because `restore` reads NULL as "never
  spoke" and would wake the card with `--session-id` — a collision on an id that already
  has a transcript. It means no more than "there is something to resume".
- A transcript never carries the window tier (`[1m]` reaches the wire only on
  `system/init`), so an imported ring is inferred by `windowForObserved`: occupancy above
  200k can only mean the wider window, and inference only ever widens. `#adoptModel`
  replaces the guess with the fact the moment the card wakes.
- A session is reported **in the wall's own spelling of where it was**, and without that it
  was adopted into a territory of its own. The catalogue takes each session's `cwd` from
  inside the transcript records rather than decoding the directory slug, which is right and
  is not negotiable — the slug folds every non-alphanumeric character and nothing may decode
  it. But a record's `cwd` is the path *as the child resolved it*, and under a junction that
  is not the path the wall typed: every record from a card in `nova` or `rise` says
  `C:\Users\flori\codes\rise` while the `project` row says `C:\Users\lyss\codes\rise`.
  Adopting one therefore missed twice over — `ensure_project` matches on `root_path` and
  found nothing at the resolved path, and `layout` groups cards by `cwd` against each
  territory's root — so the wall drew the same checkout twice, with the same dev servers
  under it. `sessions::settle_roots` canonicalises both sides of that comparison and reports
  the wall's spelling where the two are one directory. It is the same gap the paragraph above
  records `transcript_dir_name` closing for the resume, met from the other end, and the same
  general rule with the arrow reversed: **a path read out of another process's records is the
  path it resolved, not the one we typed**, so anything matching it against our own has to
  canonicalise. Only whole-directory identity counts — a subdirectory, a worktree or a
  territory that is not on this machine at all matches nothing and is left exactly as
  recorded.

#### The catalogue reads the head and the tail, and for a year it read everything

`sessions_of` walks every directory under `~/.claude/projects` and it is unbounded in the one
way that matters — it grows with how long the CLI has been used on this machine. The module
claimed all along that it read only the head and tail of each file; the loop went through
every line of all 167 MB, with `field` scanning a multi-megabyte tool result seven times over
to learn a timestamp that was never on it. What that looked like from the wall is the panel
sitting empty long enough that you would start typing in the filter, and conclude the list
only appears when you query it.

Measured 2026-08-20 over the 278 transcripts here (167 MB, largest 11 MB), which is what
`HEAD` and `TAIL` are sized from:

```text
first "cwd"            p50   796 B   p99  2.1 KB   max  4.5 KB   (never on line 1)
first "timestamp"      p50    48 B   p99  441 B    max  622 B
last "ai-title"        p50  8.7 KB            from EOF   max 64.8 KB
last answered assistant p50 2.4 KB            from EOF   max 82.3 KB
bytes read: 167 MB → 39 MB with a 64 KB head and a 256 KB tail
```

- **The fold is what makes skipping the middle sound.** `Scan` holds three first-wins fields
  read from the top and three last-wins fields read from the bottom, so feeding it the head
  and then the tail answers exactly what feeding it every line would. It also makes the
  overlap on a small file free: feeding the same line twice, in order, changes nothing — which
  is why anything under `HEAD + TAIL` is simply read whole, and the median transcript is 28 KB.
- **Partial lines are discarded at both edges, and that is not tidiness.** A line cut mid-`cwd`
  hands `field` an unterminated value and gets `None`, which is safe. A line cut inside a tool
  result can still carry `"type":"assistant"` and `"usage"`, fail to parse as JSON, and put the
  session in the list with no model and an occupancy of zero.
- **`whole` is the fallback, and it is there against the measurement rather than because of
  it.** A tail that found no answered message is either a session that never got one — nothing
  to resume, correctly dropped — or a tail cut above the last one, and those are
  indistinguishable from where the reader stands. So the file is read the rest of the way. The
  cost of being wrong with the fallback is one slow file; without it, a row reading
  `untitled · 0%` for a conversation that has a name.
- **Newest first is asserted in both halves on purpose.** `walk` sorts and `Import.svelte`
  sorts again. That is not a duplicated rule but a panel refusing to hold its own default state
  somewhere else: the list opens showing everything, so the top of it *is* the answer to "what
  was I just doing", and the filter narrows a list you can already read rather than being a
  query you have to write first.
- **Recency stops being a count once it stops helping you find things.** `ago` counts up to a
  fortnight and gives a date after it: `9w ago` is arithmetic you have to do backwards, where
  `3 jun` is a day you either recall or do not. The year appears only when it is not this one.
- **`walk` takes a root** so it can be pointed at a fixture directory — what is worth testing
  is the reading, and the reading has nothing to do with where the CLI keeps its files.

