---
paths:
  - "src/lib/gates.ts"
  - "src/lib/gates.svelte.ts"
  - "src/lib/Gatehouse.svelte"
  - "tools/probe-gates.ts"
  - "tools/lift-gates.ts"
---

# Whether the tree builds, and whose fault it is if not

The wall knows a great deal about its **cards** — tier, activity, context, jobs, gears, which
files each has touched. Until this it knew nothing about the **health of the work they were
doing**, and there was no answer anywhere to three questions people asked all day: does this
tree currently build, was this red before I started, and has somebody already fixed it.

### What it cost to not know

Sink 3ebe1d59, measured across a nine-card split on 2026-08-27, and it is the largest single
waste anybody could point at from that day.

`librespot-core`'s build script pulled two `vergen-lib` versions into one graph — vergen 9.1.0
moved from `vergen-lib ^0.1.6` to `^9.1.0`, a breaking change inside a minor bump, while
`vergen-gitcl 1.0.8` stayed on 0.1.6 — so `cargo check` failed for **every card at once**,
before reaching any crate, with an error naming nobody's `src/*.rs`. Then:

- One card diagnosed it correctly and **broadcast to every card on the wall** that the Rust
  gate was down, a turn apiece, and had to **retract** the broadcast an hour later because it
  had gone stale.
- Another hit it independently, assumed its own new code was at fault, and spent a cycle
  proving otherwise.
- A third, whose dependency it was, was fixing it the whole time, invisibly.
- **The same pin was applied and lost three times.** `cargo update -p vergen --precise 9.0.6`
  writes a lock entry, and a lock entry is re-resolved by the next `cargo update` or by
  anybody adding a dependency. Each card assumed a sibling had undone its fix. Nobody had —
  all three were losing to cargo.

And separately, a card ran `git stash` in the shared tree, wiping four cards' uncommitted
work, while trying to answer *"is this `cargo check` error pre-existing or mine?"* (sink
7f6bfe2f). `.claude/rules/hooks.md` records that incident from the guard's side; the thing
worth noticing here is **what the card was trying to find out**. It reached for the most
destructive tool in the tree because that was the only way it had to answer a reasonable
question.

Every one of those is the same missing fact.

### Why this is not the fourth poller

CLAUDE.md allows exactly three places that go and look, each with its argument written down,
and says of a fourth that *"'I could not find where the event was' is not the argument."*
Running the gates on a timer would have been the obvious design and is wrong twice over: it is
expensive, and it would fight the cards for the cargo lock — `Blocking waiting for file lock
on package cache` was itself observed repeatedly that afternoon, because cards were starting
cargo runs on top of each other's.

**This does not merely satisfy that rule, it does not need the concession the rule offers.**
The fallback CLAUDE.md permits is "find an event that already exists *near* the thing you care
about and fold that instead". Here the exact event already arrives:

```
a card runs `bun run test` of its own accord
  → assistant message, tool_use block, input.command   ← the run starting
  → user message, tool_result block, is_error          ← the verdict
  → Conversation.ingest has folded both since before this existed
```

Nothing is run, nothing is asked, and no clock is involved. A wall where nobody runs a gate
records nothing, which is correct rather than a gap. The recorder is ~40 lines in two arms of
a method that was already there.

### The hook was the obvious design, and it was measured out of the way

`tools/probe-gates.ts`, and it is worth reading before proposing anything here, because the
finding is the opposite of the assumption everyone starts with.

**`PostToolUse` does not fire for a tool call that failed.** Four failing commands reached
`PreToolUse` across two runs and not one produced a `PostToolUse`. That was eliminated as a
crash in the probe's own hook by logging a receipt *before* parsing anything — 6 receipts, 6
parsed firings — so it is the CLI declining to call the hook rather than the hook dying on the
payload.

Which means a hook could never have observed the one outcome worth recording. It is not an
obstacle so much as the shape of the thing:

| event | fires | so it means |
|---|---|---|
| `PreToolUse` | always | a gate run **started** |
| `PostToolUse` | on success only | the run **passed** — its arrival *is* the verdict |

That is also why `tool_response` carries no exit status and does not need one: it only ever
describes a success. A row opened by the first and never closed by the second is a gate that
did not pass, **by construction rather than by a query** — which is the bargain the `job`
table already strikes, and `hooks.md` says so in its own words about a background call's
receipt.

Two more measurements from the same probe, both load-bearing:

- **A backgrounded call's `PostToolUse` fires on the *receipt*,** carrying a
  `backgroundTaskId`, an empty stdout, and `is_error` false while the gate is still running.
  Reading that as a pass would put a green on the wall for a run that had not started
  producing output. `recognise` refuses `run_in_background` outright.
- **`additionalContext` reaches the model from both `PreToolUse` and `PostToolUse`** — asked
  for every token it could see, the model listed both. Not used yet, and it is the obvious
  next place to put a warning if the prompt-time one proves too late.

So why is the recorder not a hook anyway? Two reasons, and the first is the one that settles
it. A hook would have had to become a **second writer** to the database, which `hooks.rs`
deliberately is not — `store::open_readonly`, and the reasoning at length in `hooks.md`: a
short-lived process running the migration ladder is the one path `store.rs` records as having
locked the app out of its own database. And a hook is a different process, so it could not
have emitted the event the widget needs. The stream fold has neither problem and sees
strictly more: `tool_result` hands it the failure text for free.

**The hook is still the reader**, for the card-facing half. That division is the whole design:
the app is the only writer, the hook stays a reader, and the fold is over an event that was
already arriving.

### One record, two faces

The two audiences want different *mechanisms* and the same *fact*, so they share one table.

- **You pull.** A widget — `Gatehouse.svelte`, fed by `gates.svelte.ts`. You hang it up and
  that gesture is the asking.
- **A card is pushed.** `hooks::standing_gates`, injected as `additionalContext` on
  `UserPromptSubmit` and `SessionStart`. Not offered, not a tool it has to think to call.

That asymmetry is the point rather than an inconsistency. A card that has to *decide* to ask
whether a red gate is its own is a card that will not — the reflex under a failing build is to
start debugging, or to reach for `git stash`. `supervisor::append_prompt` already makes this
argument about `drop`: *"the reflex this fights is not thinking there is anything to do."*

It is deliberately **not an MCP tool**, and that is worth stating because it was the expected
shape. Three reasons: the roster was at 38.6KB of a 40KB `alwaysLoad` budget when this was
built (sink c64787c2), so a tool would have cost bytes on every spawn of every card; a tool
would have to be *called*, which is the reflex problem above; and `additionalContext` costs
nothing when there is nothing to say, which is almost always. Two callers, two questions, one
table — `store::jobs_of` serving both `rouse` and `standing` is the same arrangement.

### What it is allowed to claim, which is the correctness question

**A reading that overstates is the retracted broadcast in a different envelope.** That is the
sentence to hold on to: the failure mode of this feature is not being wrong about a gate, it
is being confidently stale about one, which is exactly what happened on the day it comes from.
So the limits are stated in the code rather than discovered later, and the tests assert the
prose.

- **Only cards on this wall.** A gate run in a terminal beside Volery is invisible, exactly as
  it is to `file_touch` and to `hooks.rs`'s index guard. So "last seen green" is never "is
  green", and the reading says so out loud.
- **Only the gate that ran.** `bash tools/check-gnu.sh` is `cargo check --lib`, which looks at
  no `#[cfg(test)]` code whatever — and it is the form everybody on this machine actually
  types, so **the commonest observation available is a partial one**. `scope` carries that, a
  partial pass never clears a whole gate's red (`reading`'s `lastWhole`), and the widget draws
  it amber rather than celadon. `.claude/rules/build.md` says the same thing twice about the
  same command; this is the third place, and the first where a machine checks it.
- **Only the exit status.** A gate whose failure is swallowed — `cargo check || true` — reports
  a pass, because that is what the tool result says. `guard` refuses the commonest spellings
  rather than pretending to catch all of them.
- **`unknown` is a third outcome, not a failure.** A run whose end this window never saw — the
  process died, the card was interrupted, Volery was closed — is not a red gate. CLAUDE.md
  records `mark_interrupted` getting exactly this wrong twice, each time by widening
  "interrupted" to something easier to ask, and each time the cost was the whole wall claiming
  its last turn had been cut off.

**Reading `is_error` rather than grepping output is what makes this immune to a trap the
protocol records from the other end**: a `check-gnu.sh` that dies on `cargo: not found` emits
no error lines at all, so a grep counts zero and calls it green — "a green that never ran". A
tool result knows better.

### The tree, not the project, and it was nearly a silent bug

`gate_run.root` is the directory the child **actually ran in**. Two cards on different
worktrees of one project share a `project_id` and share no files, so a project-scoped reading
would report one card's red gate to another that cannot reach the code causing it —
`hooks::perilous` had to learn the same distinction from the other side.

The trap: **`Conversation.worktree` is a branch *name*, not a path.** The obvious
`this.worktree || this.cwd` would have written a branch name into a column of directories, and
since the reader is a hook whose payload gives it the real run directory, the two sides would
never have matched — the reading would have been permanently, silently empty for exactly the
cards most likely to be sharing a repository.

So **the root is derived in Rust and never passed in**: `store::open_gate_run` asks
`session_of`, which goes through `worktree::run_dir` — the one pure function
`supervisor::spawn` and `worktree::ensure` also agree on. Computing it in the front end would
have been a second copy of `dir_for`'s spelling, which is the fact-written-twice failure
`hooks.rs`'s matcher already paid for. `gate_trees` exists for the same reason: a widget
cannot enumerate the trees it should watch, so it asks.

### Two writes, and why the second one is not symmetry

A single write on the result would be simpler and would lose the state that matters most in a
shared tree: **somebody is running this gate right now.** That is what `Blocking waiting for
file lock on package cache` was, repeatedly, and one extra statement makes it visible. It is
also the only thing that lets a run whose end nobody saw read as `unknown` rather than
silently not existing.

`GATE_KEEP` (50) bounds the table by construction rather than by a sweep somebody has to
remember to call, and counts **per gate** rather than over the table, so forty `cargo-check`
runs in an afternoon cannot evict the only observation anybody has of `pytest`. A time bound
was the alternative and is worse here: it cannot promise a bound at all, since growth is set
by how many cards are working rather than by the clock.

### Flapping, which is the reading nobody had

`reading`'s `flapping` is true when a gate has gone green-to-red-and-back more than once in
the window. That is the third waste of that afternoon addressed directly: the pin applied and
lost three times, with each card concluding a sibling had undone its fix. Nobody could see the
gate going green and red again, so the available explanation was the wrong one.

One change is *news* rather than flapping — a gate that broke, or one somebody fixed — and
calling that flapping would cry wolf on the single commonest thing that happens to a gate.
Hence `> 1`, and a test for each side.

The card-facing reading goes one step further and names the usual cause, because the
diagnosis is the expensive part: a `cargo update --precise` pin does not survive the next
resolve.

### Saying nothing, which is most of the time

`standing_gates` returns `None` for every ordinary case, and the quiet path is the feature.

**Only ever about somebody else's observation.** Telling a card about a gate it watched go red
itself is noise — it was there. Every branch is conditioned on another card having been the
observer, which is also what makes it worth a context slot at all: it is the thing this card
provably cannot know.

**The repetition problem has a read-only bound.** `UserPromptSubmit` fires on every prompt, so
an unconditional reading would repeat for as long as the gate stayed red. The billboard solves
this with `notice_served` — and that is a **write**, which a hook must not be. So the bound is
computed from the rows themselves: *nothing is said about a gate this card has since observed
for itself.* It falls silent the moment the card learns first-hand, needs no state, and costs
a repeat over the handful of prompts in between. **If that proves noisy the fix is
`notice_served`'s shape plus a writer, not a wider silence here** — a reading that goes quiet
while the tree is broken is worse than one that repeats.

Two clocks bound the rest, and both are about not lying:

- `GATE_STALE_MS` (6h) — **a stale red is a stale green with the sign flipped.** A card sent
  hunting a bug somebody fixed overnight loses exactly the turn this exists to save. Six hours
  is about a working session: long enough to cover a card arriving in the afternoon to a tree
  broken before lunch, short enough that nothing here ever speaks about yesterday.
- `GATE_RUNNING_MS` (10m) — an unsettled row is either a live run or an orphan, and only time
  tells them apart from here. Generous against a warm `cargo check --lib` at ~19s and a full
  `bun run test` at ~6s, so anything older is treated as nothing rather than announced as work
  in flight. `Gatehouse.svelte` has the same number and the two should move together.

And it names the escape it must not leave open: **do not reach for `git stash` or tree-wide
git to find out whether a failure is yours.** That sentence goes where the question is being
asked rather than on a board the card may never read — the card that did it already knew the
tree was shared. `hooks.rs`'s fourth guard is the lock; this is the sentence beside it, and
`hooks.md` argues at length why both are needed.

### Where each piece lives, and why there

| file | holds |
|---|---|
| `gates.ts` | pure. **The only place that knows what a gate command looks like.** |
| `store.rs` (v26) | the table, two writes, two reads, the prune. Knows nothing about commands. |
| `conversation.svelte.ts` | the two fold arms — the whole recorder. |
| `hooks.rs` | `standing_gates`, read-only. The card's face. |
| `gates.svelte.ts` | the one reader behind however many widgets. Event-driven, no timer. |
| `Gatehouse.svelte` | the user's face. |

**The recogniser lives in exactly one place**, and that is deliberate: Rust only stores and
reads rows and never needs to know what a gate is. Not in `classify.ts` either, which holds
knowledge about an *agent* — its tool names, model ids, event vocabulary. A gate is knowledge
about a *repository*, which is the division `azdo.ts` already draws for a forge and `usage.ts`
for a price.

`hooks::standing_gates` is a different question (*what should this card be told*) rather than a
second copy of the same one, which is why it is Rust rather than a duplicated fold.

**A shape check, never a tool name.** `recognise` takes the tool *input* and leaves if there is
no `command`. `hooks.md` records why: that module's `PreToolUse` matcher was `"Bash"`, a fresh
`claude` on this machine calls its shell tool `PowerShell`, and the mismatch made every hook in
it a silent no-op for an unknowable number of versions. Both names are live on this machine at
once.

**`Gatehouse.svelte`, not `Gates.svelte`.** This filesystem is case-insensitive, so
`Gates.svelte` and `gates.svelte.ts` are the *same file* and `./gates.svelte` resolves to
whichever TypeScript reached first. `Basin.svelte` beside `sink.svelte.ts` is the same dodge and
`beacon.svelte.ts` beside `Status.svelte` is the same lesson from the other end. Caught here by
`svelte-check`, which refuses it outright — the data keeps the plain name and the face takes the
evocative one.

### Testing it, and what has genuinely been run

```bash
bun test test/gates.test.ts     # 48, the pure fold
bun tools/lift-gates.ts         # 15, the card-facing prose, actually executed
bash tools/check-gnu.sh --profile test
```

The lift needs **no dependency at all** — `standing_gates`, `who` and `ago` build a `String`
and touch no `serde_json` — so it is the cheapest of sink 276f26ca's three tiers and is immune
to whatever state the crate's dependency graph is in. Which is the condition this whole
feature comes from, and is not a coincidence worth passing over: the afternoon `cargo check`
was red for everyone, a lift was the only way to run any Rust in this repository at all.

**Run it *and* `--profile test`, always.** A lift is a copy, so a green run is evidence about
the text you lifted and not about the file on disk (sink 276f26ca). The pairing earned itself
inside a minute here: `--profile test` was green while one assertion was wrong — `takes a
lock` against prose reading `take a lock` — and only executing it found that.

### Not verified in the app

Nothing has ever written a row and no widget has ever been drawn. Every part is typechecked
and the pure folds are tested, and that is a different claim.

The reason is worth knowing rather than apologising for: a dev build against
`%APPDATA%\dev.skein.studio` stamps the real database forward to v26, after which the
*installed* Volery refuses to open it — so exercising this needs the user's say-so, not just a
spare minute. Sink 4951f398 exists because a card was honest about exactly this distinction
for the Spotify player, which is green on every gate and has never played a note.

What to check first, when it is run:

1. A row appears at all — `select * from gate_run` after one `bun run test` on a card.
2. `root` matches what the hook's payload `cwd` says, **for a worktree card**. That is the
   near-miss above, and a string mismatch there is silent: the reading is simply always empty.
3. `standing_gates` actually reaching a card — run a gate red on one card, then prompt
   another, and look for `<volery-gate-health>` in its context.
4. The widget's amber for a bare `check-gnu.sh`, which is the claim most likely to be read as
   a bug by somebody who has not read this file.
