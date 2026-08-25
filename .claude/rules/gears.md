---
paths:
  - "src/lib/gears.ts"
  - "src/lib/Card.svelte"
  - "src-tauri/src/supervisor.rs"
---

# The gear a card is in

Until 2026-08-25 the wall had exactly one. Every project card spawns with
`--dangerously-skip-permissions` and has the machine in its hands from its first turn — which
is why `CLAUDE.md` calls a broadcast the most destructive gesture in the app, and why the only
protection anywhere was a keyboard modifier. This is the second gear: a card that reads,
searches and thinks, and whose turn ends in a document rather than in a diff.

`gears.ts` is the vocabulary and is pure. `supervisor::set_permission_mode` is the doing.
This file is what was measured, and the three things that were not what the design assumed.

### What was probed, and what it changed

`tools/probe-plan.ts`, claude 2.1.241, spawning with Skein's exact argv:

```text
--> set_permission_mode plan          (on a card spawned with --dangerously-skip-permissions)
    control_response  success, {"mode":"plan"}
    system/init       permissionMode=plan          tools=29      <- was 59
    ...asked to create a file: wrote a PLAN instead, to ~/.claude/plans/
--> set_permission_mode acceptEdits
    system/init       permissionMode=acceptEdits   tools=59
    ...asked again: wrote the file
```

Note what this first run does *not* establish, and what a second probe was needed for: every
init here follows a prompt, so it says nothing about whether a mode change alone produces one.
It does not — see below. Isolating one variable is not the same as isolating the right one.

**1. It beats the bypass flag.** This is the finding the whole feature rests on. A card spawned
with permissions bypassed and then asked for `plan` really does lose its writing tools —
29 of them instead of 59 — and really does refuse to write the file. So this is a *gear*
rather than a kind of card: no respawn, no lost process, no second conversation, and the
context the planning was done in is the context that executes it. Had it gone the other way,
planning would have had to be a property of a card at birth, which is a much worse feature —
you would have to know before you started.

**2. Two events carry the mode, they arrive at different times, and one of them can be stale.**
This was got wrong the first time and the shape of the mistake is the useful part.

The design assumed `system/init` was re-emitted on every change. It is not. A second probe,
changing the mode on a warm, idle process and then waiting:

```text
15.07s  --> set_permission_mode plan
15.13s  control_resp    {"subtype":"success","response":{"mode":"plan"}}
17.76s  init            permissionMode=bypassPermissions      <- the OLD mode
19.95s  result
        …and nothing further for 18 seconds
```

So: the **`control_response` is the immediate, authoritative one** — the process confirming, in
~60ms. `system/init` is emitted **per turn** and reports the mode that turn is running *under*,
which for a turn already in flight is the mode it started with. The init at 17.76s belonged to
a turn asked for at 0.06s, and folding it blind flips the card straight back to making.

Both are folded, and `afterAck` / `afterInit` in `gears.ts` hold the rule: an acknowledgement
is taken immediately and remembered as outstanding; an init that disagrees with an outstanding
one is ignored as stale; the init that agrees clears it, after which inits fold normally again.
That last clause is what keeps a card put into planning by *something that is not Volery* drawn
correctly, which is the whole reason for folding inits at all. `afterExit` clears the
outstanding change when the process goes — otherwise a change that never took effect would make
that card deaf to every init for the rest of its life.

Nothing polls, either way, which is still the shape `CLAUDE.md` asks for. And `Skein.setGear`
does not set the gear optimistically, because the answer is already on its way and is faster
than the round trip the call is making.

The one exception is a **dormant** card, which has no process to answer at all. There the row is
the only truth there is, so `setGear` folds it locally and the restore reads `permissionMode`
off `StoredConversation` — without which the whole wall would come back drawn as making until
each card was individually woken.

**3. `ExitPlanMode` no longer exists.** The older model — a tool call that parks waiting for
approval, which is exactly `ask.rs`'s shape and was the design this started from — is gone.
2.1.241's plan mode *writes a document* to `~/.claude/plans/` and names it in the result. So
approval is not a parked call to resume; it is a file to read and then a gear change, and
nothing in this feature touches the asking machinery. Worth knowing before reaching for it.

### The plan is found structurally, never by reading the prose

The result text names the plan file in a sentence. `isPlanDocument` ignores that and matches
the `Write` **tool call** in the event stream instead — a path containing `/.claude/plans/`
and ending `.md`. The prose is a sentence a model composed and could be phrased any number of
ways; the tool call is the CLI writing a file into a directory of its own, and it is already
in the pipeline. Same argument as everywhere else in this app: fold the event that exists.

It is deliberately **not gated on the card's gear**. The write and the init that announced the
gear are two events, and a card whose plan was dropped because the fold order surprised us is a
card that did the work and has nothing to show for it. Anything writing into `~/.claude/plans/`
is planning, whatever we think it is doing.

The plan is cleared when the card comes back into **making**, and only on a *change* into it.
A card wearing "a plan is waiting" after the plan has been acted on is a badge that stops
meaning anything; guarding on the transition stops an ordinary init mid-making from clearing a
plan that a making card has yet to be pointed at.

### Opening one: the viewer is re-rooted, the guard is not widened

A plan lives under the user's home, outside every project. `find.rs::safe_join` refuses an
absolute path and anything climbing out of the root it was given, and that guard is worth
keeping exactly as it is — so the way in is to point the viewer *at the plans directory* and
name the file within it (`planRoot`, `planFile`). Nothing about the sandbox changes; the viewer
is simply pointed somewhere else, the same way it is pointed at each project. The directory is
derived from the plan's own path rather than from a home directory `gears.ts` has no business
knowing.

### Why the wall draws two gears when the CLI has six

2.1.241 offers `acceptEdits`, `auto`, `manual`, `dontAsk`, `bypassPermissions` and `plan`.
`gearOfWire` folds every one of them that is not `plan` into **making**.

The wall asks exactly one question — *can this card change the repository* — and every mode but
`plan` answers yes. Inventing a reading for each would put five gears in a UI with two
gestures, and four of them would differ in ways this wall cannot show. The cost is honest and
small: a card in `acceptEdits` is drawn as though it were in bypass, which is correct about the
only question being asked of it.

The store column is the **CLI's** vocabulary rather than the wall's, so a mode this build has
no reading for is still a mode a card can be put into and can come back in.
`supervisor::set_permission_mode` validates against the CLI's list rather than the wall's, and
rejects anything else — an unknown value reaching `--permission-mode` is a card that fails to
spawn at all, for ever, with the reason in a stderr line nobody reads.

### Persistence, and the fourth time this lesson was learned

`store::gear_of` is asked of the store rather than passed as an argument, and it is the fourth
of these — after `kind_of`, `setup_of` and `worktree_of`. The note on `worktree_of` records
what happened to the one that *was* passed: `open` remembered and `wake` did not, for the
lifetime of the app. The card `wake` would forget here is one put into planning, left dormant
overnight, and roused at launch with the machine back in its hands because nobody remembered it
had been put down.

The row is written **before** the control request reaches the wire, which is `set_mid_turn`'s
lesson from the other side: bookkeeping that records a decision must not wait for the thing it
decides to succeed. A card whose process dies between the write and the flush comes back in the
gear you asked for.

Spawning a card whose stored gear is NULL or `bypassPermissions` still uses
`--dangerously-skip-permissions` rather than `--permission-mode bypassPermissions`. The two ask
for the same state, and the flag is what every rule in this repository names — two spellings of
one state is how a mode ends up set in one place and read in another.

### How it is drawn

- **The card's border goes dashed.** A reading of the whole card rather than a fifth corner
  mark, because the four corners are spoken for and, more to the point, the gear is not
  something that has *happened* to the card — it is what the card currently is.
- **The transcript footer says the word**, beside the model and the effort, and only when it is
  planning. "Making" is what every card on this wall has always been, and a word that never
  varies is one nobody reads after the first day — the same argument `Card.acct` makes about
  which account a card is on.
- **A plan waiting is a button in the bottom-right of the card**, drawn always rather than on
  hover: it is something the card is holding for you, and a thing you must hover to discover is
  a thing you never discover.

All three are **achromatic**, and that is not a style preference. A planning card can be
working, asking or failed exactly like any other, so the tier colour has to stay readable
through it; tinting the gear would put a fifth thing in a channel that means three.

### `opusplan` came back

`commands.ts` used to leave `opusplan` off the model list with the note "it is plan mode's
upgrade model, and every card here spawns with permissions bypassed". That was true of every
card and is now true of none. It is the pairing plan mode is for — plan on Opus, execute on
Sonnet — and `/gear planning` is exactly the state it names.

### What driving the real wall found, that nothing else could

The pure suites were green and the crate typechecked before any of this was run against a
live app. Three things were still wrong, and the shape they have in common is worth more than
any of them: **each was invisible because the code path had never been reachable before.**

**1. A command with choices was read as unfinished even with its value typed.** The dock's
Enter asked `cmd.choices || (cmd.takesText && !arg)` — so `/gear planning` re-opened the
palette and returned, silently, having done nothing. It had been that way for as long as
choices existed and had never mattered: every command with choices was the CLI's, and those
are carried out by *sending the text*, which never comes through that branch. `/gear` is the
first of Volery's own with choices, and it walked straight into it. The rule now lives in
`commands.ts::stillWriting`, where a test can reach it.

**2. `resolveCommand` returned `null` for a choices command with an argument** — the arm that
handles a command typed or pasted in full with the palette dismissed. Same reason it had never
been reachable: a line above filters out everything that is not `by: "skein"`, and until `/gear`
nothing with choices was. So `/gear planning` pasted whole went to the agent as a prompt about
the word "planning". It now resolves with one of its own values, and with its bare name — that
second clause matters, because the bare name is what Enter turns into an open palette.

**3. The palette's own Enter *sent* the completed line instead of running it.** Correct for a
CLI command, where carrying it out is sending it, and wrong for one of ours.

None of these is a bug in plan mode. All three are the dock discovering, for the first time,
that a command could have choices *and* be Volery's to run — and every one of them failed by
doing nothing at all, which is the failure mode a green test suite is least able to see. The
general shape: **when a feature is the first to use some combination of existing flags, the
code that branches on those flags has never been executed in that combination, and its untaken
branches are where the bugs are.**

A fourth thing, and it was the test harness rather than the app: driving the dock from Git
Bash, `/gear planning` arrived as `C:/Users/…/Git/gear planning`. MSYS2 rewrites a leading
slash into a Windows path before the argument is ever sent. Anything driving the control
surface with a slash-command must not go through a POSIX shell — `tools/` scripts and the
Python driver are both fine, and the transcript is where it was finally visible, because the
card had faithfully recorded being handed a path.

### What was confirmed against the running app

For the record, since the feature is mostly invisible until it is used:

- Setting the gear flips the card's reading within a couple of seconds **with no turn taken**,
  which is the acknowledgement fold doing its job — there is no init until a turn.
- A planning card asked to create a file **did not create it**, and wrote
  `~/.claude/plans/create-a-file-called-recursive-willow.md` instead, which `planDoc` picked up.
- `/gear making` cleared the plan.
- The gear survived a full restart of the app: the card came back in **planning**, off the row.
- A card *spawned* with `--permission-mode plan` and no bypass flag — the roused-card path,
  which is a different one from the control request — ran its tools without hanging on a
  permission prompt there is nobody to answer, refused the write, and produced a plan.
