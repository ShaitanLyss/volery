# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Volery is a Tauri 2 desktop app (Windows-first) that puts every concurrent Claude Code
conversation on one zoomable studio wall. Each card is a long-lived
`claude --print --output-format stream-json` child process; there is no terminal emulator
anywhere on the path. The front end folds the structured event stream into its own design.

This uses plain **Svelte 5 + Vite**, not SvelteKit.

### It used to be called Skein, and half of it still is

Renamed 2026-08-21, because `Skein` is a NIST SHA-3 finalist hash function and owns the
search results outright — plus a YARN deploy tool on PyPI, Skeinforge, and a Bevy plugin. A
volery is both *a large enclosure in which birds have room to fly* and *a flock of birds in
flight*, which is the room and the flock in one word; a skein is geese in flight, so the
imagery is continued rather than replaced and nothing in the internal vocabulary (strands,
flights, the flock in the ambience) had to be rethought. `docs/NAMES.md` has the whole
search, what was rejected and why, and the families worth mining if it changes again — which
it may, since the name was chosen explicitly as *for now*.

**The rename deliberately stopped at the visible identity**, and knowing where the line is
drawn matters more than the name: `productName`, the window titles, `index.html`, the README,
the package name and the GitHub repo are Volery. Everything the wire or the disk depends on
is still `skein`, on purpose:

- **`identifier: "dev.skein.studio"`** is the `%APPDATA%` folder the database lives in, and is
  hard-coded a second time in `hooks.rs`. Changing it orphans a live wall — every card, every
  turn, every widget — unless the folder is migrated first.
- **The MCP tool names `mcp__skein__*`** (and the `scope: "skein"` value the board, sink and
  relay tools take) are quoted in every transcript already on this machine. Renaming them
  makes a dormant card's own history reference tools that no longer exist, and the rules teach
  them by name. `classify.ts`'s `SKEIN_*_TOOL` constants are that vocabulary.
- **The crate and binary** (`skein`, `skein_lib`) and the control surface's `SKEIN_CONTROL`
  variables, which are test plumbing rather than anything a person reads.

The one interface that grew a second name is `VOLERY_AZDO_PAT`, read ahead of
`SKEIN_AZDO_PAT` — a variable sitting in a shell profile is exactly what a rename must not
break, and both are kept. The Azure DevOps token entered in the app keys off the durable
identity for the same reason the `%APPDATA%` folder does: it lives in the Windows credential
vault under `dev.skein.studio/azdo-pat`, so a further rename does not read as the app having
forgotten your credential (`vault.rs`).

## Commands

```powershell
bun run tauri dev        # the app (starts vite on :1420 itself via beforeDevCommand)
bun run dev              # vite alone — the wall will fault, since every read is an invoke
bun run check            # svelte-check + tsc over src/**
bun run build            # vite build → dist/
bun run tauri build      # bundle

bun run test             # the pure suites: ansi, classify, layout, pick, glass, specs, history, menu,
                         # markdown, actions, outline, follow, ambience, transcript, compaction,
                         # presets,
                         # commands, copy, widgets, naming, drafts, rousing, quitting, timing,
                         # sink, logface, serverlog, buildlog, unreallog,
                         # nvim,
                         # guidance,
                         # undo, lineage, update,
                         # asking,
                         # toolcall,
                         # flow, relay, board, serverlog,
                         # usage,
                         # bang,
                         # repair, limits, accounts, signin, azdo,
                         # shell, finding, styles
bun test test/classify.test.ts                                        # one file
bun test test/classify.test.ts -t "urgency"                            # one describe/test
bun run test:live        # spawns the real `claude` binary, real API turns, minutes
bun run test:wall        # drives a RUNNING app over the control surface

cd src-tauri && cargo test    # unit tests in store.rs, ask.rs, relay.rs, board.rs, sink.rs,
                              # later.rs, pin.rs, spawn.rs,
                              # bang.rs, update.rs, guidance.rs,
                              # quit.rs,
                              # repair/text.rs,
                              # control.rs,
                              # supervisor.rs,
                              # servers.rs, shell.rs, nvim.rs, find.rs, sessions.rs, project.rs,
                              # usage.rs,
                              # limits.rs
cd src-tauri && cargo run --example limits-probe   # what /api/oauth/usage really answers
cd src-tauri && cargo run --example find-probe -- .. "off_main"   # what ripgrep costs on a tree
bun tools/probe-nvim.ts --config   # what `nvim --embed` answers over pipes, with your config
bun tools/probe-guidance.ts        # whether --append-system-prompt lands, and survives --resume
```

`bun run test` deliberately excludes `test/live.test.ts` and `test/wall.test.ts` — one costs
money, the other needs a live app. Both are real tests, not scaffolding; run them when
touching the classifier or the wall.

**On a machine with no MSVC toolchain** neither `cargo test` nor `bun run tauri dev` runs at
all, and the failure names nothing that points at the cause. `.claude/rules/build.md` has the
whole of it — the four traps, and the `cargo check --lib` loop that *does* work there.

## Where the rest of it is

This file is what holds for every session. Everything below is one subsystem's reasoning, in
`.claude/rules/`, each scoped with `paths:` frontmatter so it loads when you open a file it
governs — and not otherwise. If you are about to work somewhere, read its rule first; the
prose there is why the code is shaped as it is, and most of it records a bug that shipped.

| rule | covers | fires on |
|---|---|---|
| `turns.md` | how a turn opens, how Escape stops one, and background work that outlives it (`busy` vs `working`, jobs, the plan) | `classify.ts`, `conversation.svelte.ts`, `supervisor.rs` |
| `repair.md` | mending a conversation a tool call made unsendable: the two causes behind one 400, taking the bad characters out, and the original kept until the card has moved on | `repair.ts`, `repair/mod.rs`, `repair/text.rs` |
| `restore.md` | painting the wall from SQLite, rousing dormant cards, setting one aside, scrollback and adopting sessions Skein did not start | `rousing.ts`, `skein.svelte.ts`, `history.ts`, `sessions.rs` |
| `theme.md` | how the reading is set: a theme as a diff against `tokens.css`, the revert guarantee, the eleven knobs and why each is arguable, deriving and carrying one off the machine | `theme.ts`, `theme.svelte.ts`, `Themes.svelte`, `tokens.css` |
| `panel.md` | the transcript: markdown parsing, folding tool calls, opening one to see its arguments and result, panel width, reading size, the two rails, keyboard scrolling, following the tail | `Transcript.svelte`, `Markdown.svelte`, `markdown.ts`, `outline.ts`, `follow.ts`, `transcript.ts`, `toolcall.ts`, `ToolCall.svelte`, `copy.ts` |
| `layout.md` | territories, the flow, pinning, the two-box viewport, `CARD_BOX`, the three pointer gestures, one selection over four kinds and the band that draws it, and an agent putting an image on the wall beside its card | `layout.ts`, `pick.ts`, `Canvas.svelte`, `studio.svelte.ts`, `images.svelte.ts`, `pin.rs` |
| `undo.md` | taking it back: one shape for four realms, the boundary that keeps prompts and the viewport off the stack, why a drag is one press, and the image file that is no longer deleted with its row | `undo.ts`, `undo.svelte.ts` |
| `widgets.md` | the widget catalogue and its knobs, the clock, the performance meter, and the three logs over one substrate | `widgets.ts`, `WidgetNode.svelte`, `Clock.svelte`, `perf.ts`, `logface.ts`, `serverlog.ts`, `buildlog.ts`, `unreallog.ts` |
| `usage.md` | what is left of the allowance and what it has cost — the account's own windows and their resets, then reading transcripts, the dedup, the five prices, and the day's figure the title bar and the horizon carry | `limits.ts`, `usage.ts`, `ledger.svelte.ts`, `limits.rs`, `usage.rs` |
| `timers.md` | timers, the pomodoro cycle, and why breaks are taken rather than offered | `timing.ts`, `cycle.svelte.ts`, `Rest.svelte` |
| `azdo.md` | pipelines and reviews, the four-rung auth ladder and the rung that could not spawn, a 400 that means "not your project", where the one stored secret lives, and the TLS interception this network does | `azdo.ts`, `devops.svelte.ts`, `azdo.rs`, `vault.rs`, `Keyring.svelte` |
| `actions.md` | the verbs a project has all day, Unreal's shape, conflicts and the fetch clock | `actions.ts`, `project.rs`, `actions.rs` |
| `ask.md` | the `ask_user` MCP server, parking a `tools/call`, and several questions in one call | `ask.rs`, `asking.ts`, `Ask.svelte` |
| `relay.md` | cards that can see each other: the roster, a message into another card's hands, reading a file's history or another card's words instead of costing it a turn, a note to yourself later, the guards that stop a spiral, and the braided light one is drawn as | `relay.rs`, `later.rs`, `relay.ts`, `relay.svelte.ts`, `flow.ts`, `Flow.svelte` |
| `board.md` | the billboard: a standing notice about work in progress, the four ways one gets cleared up, and the globs that make one come and find the agent who needed it | `board.rs`, `board.ts`, `board.svelte.ts`, `Billboard.svelte` |
| `sink.md` | the sink: somewhere a finding outlives the card that made it, why a hold expires where a notice is only marked, merging on the title without losing the count, and the face you work the pile from | `sink.rs`, `sink.ts`, `sink.svelte.ts`, `Basin.svelte` |
| `commands.md` | slash commands, why Skein reads only its own names, and clearing a card | `commands.ts`, `Dock.svelte`, `field.svelte.ts` |
| `guidance.md` | standing instructions: the wall's and a territory's, why they are a system prompt rather than a `CLAUDE.md` or a hook, what a live card does not hear, and why they are instructions rather than a lock | `guidance.rs`, `guidance.ts`, `Guidance.svelte` |
| `control.md` | the control surface and the two rules that make a green run mean something | `control.rs`, `control.svelte.ts`, `wall.test.ts` |
| `glass.md` | sticking a thing to a pane in screen space without moving where it is | `glass.ts` |
| `ambience.md` | what the ground does when nobody is asking it anything | `ambience.ts`, `Backdrop.svelte` |
| `servers.md` | dev server groups, colour without a terminal, why the PTY came off, and what an EDR made of it | `servers.rs`, `ansi.ts` |
| `shell.md` | the shell Alt+I floats over the wall, the marker that draws its prompt, and why this one is pipes | `shell.rs`, `shell.ts`, `shell.svelte.ts`, `Console.svelte` |
| `editing.md` | editing a file in your own nvim: attaching to one as a UI over pipes rather than a PTY, the panel's third reading, what the wire format gets wrong, the one key kept back, and colour against the house rule | `nvim.rs`, `nvim.ts`, `nvim.svelte.ts`, `Quill.svelte` |
| `finding.md` | the finder and the file viewer: why space is free as a leader, a file list fetched once and scored here, what the fuzzy scorer prefers, a markdown file that opens as a document, and a path in a tool call that opens it | `find.rs`, `finding.ts`, `finder.svelte.ts`, `Spyglass.svelte`, `ToolCall.svelte` |
| `bang.md` | `!` in the dock: a shell line where a prompt goes, the two things Enter and Ctrl+Enter mean, and completion out of the shell's own `TabExpansion2` | `bang.ts`, `bang.svelte.ts`, `bang.rs`, `Dock.svelte`, `field.svelte.ts` |
| `naming.md` | what a card is called, and the draft it wears before it is named | `naming.ts` |
| `menu.md` | the right-click, and why offering nothing is a real answer | `menu.ts` |
| `worktree.md` | the tree a card works in: why Skein makes it rather than `--worktree`, the folder spelling it must keep, the upstream `-b` would otherwise set, and the base ladder | `worktree.rs`, `supervisor.rs` |
| `spawn.md` | a card putting a card on the wall and taking it off again: which territories it may name and why a path is not one of them, the three bounds that are switched off and what is watching instead, the one birth path, what a card may close, and the root a spawned card is drawn on | `spawn.rs`, `lineage.ts`, `Lineage.svelte` |
| `chat.md` | the card with no project, what `--tools` really does, and where a capability is decided | `supervisor.rs`, `store.rs`, `skein.svelte.ts` |
| `hooks.md` | the hook Skein hands its cards: the Bash tool halving runs of backslashes, why a quoted heredoc was never the cause, and the one binary that undoes it | `hooks.rs`, `main.rs` |
| `accounts.md` | more than one subscription: an account as a credential store and why Skein holds none of it, signing one in without a terminal, the waterfall and its stickiness, your caps against the server's, the per-card bypass, being held, and finding Claude Code before installing it | `accounts.ts`, `accounts.rs`, `signin.ts`, `signin.rs`, `claude.rs`, `Accounts.svelte` |
| `update.md` | getting onto the newer one: why the installer does the work rather than a plugin, offering nothing when in doubt, and why the exit handler launches it | `update.rs`, `update.ts`, `release.svelte.ts`, `release.yml` |
| `portage.md` | carrying a wall off and setting one up again: what a layout is and what it deliberately leaves behind, why no id travels and an import only adds, furniture identified by what-and-where, and a territory that arrives pointing nowhere | `portage.ts`, `portage.svelte.ts`, `portage.rs`, `Carry.svelte` |
| `roster.md` | **design, unbuilt** — drawing something else's work: a wall-level MCP registry, the row contract a server publishes to appear here, and why `tier` is the only vocabulary Volery exports | `roster.ts`, `Roster.svelte`, `mcp.rs` |
| `build.md` | building without MSVC — the four traps, and what a no-MSVC machine can check | `Cargo.toml`, `tools/*.ps1` |

## Architecture

### The event pipeline

```
claude -p (child, NDJSON stdio)
  → supervisor.rs reader threads → app.emit("conv:event" | "conv:stderr" | "conv:exit")
  → skein.svelte.ts #wire() routes by conversation id
  → Conversation.ingest(ev) folds it into $state
  → $derived tier/ctx/idleSeconds paint the card
```

Nothing polls, and nothing the *agent* said is drawn before it says it — every card state
above is a fold over events that arrived.

There are exactly **three** places that go and look, and all three are the same argument:
there is no event to fold *from the thing being watched*, because it emits none. The
performance sampler, since no process announces that it has started using the CPU
(`meter.svelte.ts`); a running workflow's progress, since its agents run on a stream this app
never sees and nothing announces that one has finished (`crowds.svelte.ts`, `workflow.rs`);
and whether a newer release exists, since GitHub tells nobody a tag appeared
(`release.svelte.ts`, `update.rs`).

The first two are bounded the same way — one poller however many readers, started by the
first that asks and stopped by the last that stops.

**The third is the shape to prefer, and it is not a clock at all.** It was once asked exactly
once, at launch, on the argument that the answer only had to be right by tomorrow morning —
which was true of the answer and wrong about the wall, since this app is left up for days and
a wall opened with no network never checked again. What replaced it is not a timer: *focus* is
an event, `attention.focused` already folds it, and the question is asked when you come back
to the window — which is also the moment the answer is worth having. The residue is bounded
three ways: only while the window is in front, never twice inside a floor, and **not at all
once there is something to say**, since no further ask can change the answer.

That is the lesson worth carrying, and it generalises past updates: when the thing you care
about emits nothing, **look for an event that already exists near it and fold that instead**,
then bound whatever is left over. Anything proposing to be the fourth owes one of these
shapes and the same argument. "I could not find where the event was" is not the argument.

Your own prompt is the one exception, and it is drawn the moment you send it
(`Conversation.echo`). It was once the other way round: only `--replay-user-messages`
echoing the prompt back put it in the transcript, on the argument that the UI should never
show a message the agent had not received. That argument was right about honesty and wrong
about where to spend it — waking a dormant card spawns a process and resumes a session
first, so the transcript swallowed what you had typed for a second or more with the draft
already cleared. The honesty is kept by *marking* the line instead: `state: "pending"` until
the echo claims it (`#claimEcho`, matched on trimmed text), `state: "failed"` if the send
never left (`echoFailed`), absent once the process has demonstrably got it — an `assistant`
message or a `result` settles anything still pending, since answering us is proof of receipt,
and so does the process going away, which is a prompt it took and died holding rather than
one that never went.
So the panel still distinguishes what the agent has from what is on its way; it no longer
does it by showing nothing. A `user` event with no line waiting for it is a prompt
this window did not send — a terminal appending to the same session — and is pushed as
before.

**Settling a line is not claiming it**, and conflating the two drew prompts twice. Send into a
card that is already working and the CLI *queues* the prompt behind the running turn — which
goes on speaking, and every message of it settled the line waiting below, so when the queued
prompt was finally taken up its replay found nothing pending to claim and pushed a second copy
of what you had typed. Being answered proves a prompt arrived; it does not say *which*. So the
two questions are two fields: `state` is what is drawn and `awaited` is whether the wire still
owes this line its echo. Speech clears the doubt and leaves the claim standing
(`#settleEchoes`); only the echo itself, a failed send, or the stream closing
(`#forgetEchoes`) closes the books.

`src/lib/skein.svelte.ts` is the only place that talks to Rust. `src/lib/conversation.svelte.ts`
owns per-card state and is the only place that reads the raw event shapes.

`App.svelte` is the wiring root and holds what genuinely spans the window: the header, the
wall, the panel, the two keyboard ladders (`onDraftKey` and `onGlobalKey`, which have to be
read against each other), and the verbs that reach `Skein`. Everything a single subsystem
owns lives in its own component — `Dock.svelte` is the most recent, cut out after a `.ghost`
in the header and a `.ghost` in the dock turned out to be the same selector in one 565-line
stylesheet. **A component is the only CSS scope this codebase has**, so a subsystem with its
own vocabulary of class names wants its own file rather than a prefix;
`test/styles.test.ts` catches the collision if one slips in anyway.

### Purity boundary

Files named `*.svelte.ts` contain runes and only run in the app. Plain `.ts` files in
`src/lib` (`classify.ts`, `layout.ts`, `pick.ts`, `ansi.ts`, `specs.ts`, `markdown.ts`, `ambience.ts`,
`transcript.ts`, `commands.ts`, `naming.ts`, `drafts.ts`, `rousing.ts`, `timing.ts`, `asking.ts`,
`usage.ts`, `azdo.ts`, `glass.ts`, `shell.ts`, `bang.ts`, `theme.ts`, `relay.ts`, `signin.ts`,
`undo.ts`, `finding.ts`,
`flow.ts`, `lineage.ts`, `board.ts`, `sink.ts`, `logface.ts`, `serverlog.ts`, `buildlog.ts`,
`nvim.ts`,
`guidance.ts`,
`update.ts`,
`unreallog.ts`,
`repair.ts`, `toolcall.ts`, `follow.ts`) are pure
and have direct Bun tests — keep them that way, and put new testable logic there rather than
inside a component.
Adding a test file means adding it to the `test` script, which names its files explicitly.

`classify.ts` holds essentially all Claude-specific knowledge: tool names, model ids, event
vocabulary, the tier/ending taxonomy. If a second agent backend ever matters, that is the
file that grows an interface. The one exception is `usage.ts`'s price table, which is beside
the arithmetic that reads it rather than in `classify.ts` — a rate is knowledge about a
*bill*, not about a stream, and nothing in the event pipeline has ever needed one.

`azdo.ts` is the same arrangement one service over: the build status and vote vocabularies,
what a merge status means, how rows are ordered and what any of it is called. That is where a
second forge — GitHub checks, GitLab pipelines — would grow its interface, and it is
deliberately not in `classify.ts`, which is about an agent rather than about a repository host.

### Things that were got wrong once and are load-bearing

- **Context occupancy comes from the last `assistant` message's `usage`**, never from
  `result.usage` — the latter sums every iteration of a turn and pegs the ring. The one place
  that sum is the right number is a `turn` row, which wants the whole turn; see `store.rs`.
- **Model ids arrive in two forms.** `system/init` gives the configured id with its window
  tier (`claude-opus-5[1m]`); every `assistant` message gives the bare API name. A
  per-message id must never be allowed to narrow the window — see `sameModel` / `#adoptModel`.
- **`thinking_delta` outnumbers `text_delta` ~8:1** on reasoning models, so a turn must be
  marked working on thinking deltas too or cards look frozen.
- **A freshly spawned conversation is not dormant** even though `system/init` has not
  arrived — claude emits init only after the first message lands.
- **Closing the studio must exit the app.** `peek` is a second window created at startup
  and only ever hidden, and the run loop exits when *all* windows close — so closing `main`
  left a live process with no window, ports still bound and `claude` children still editing
  repos, because `RunEvent::ExitRequested` never fired. `lib.rs` now exits explicitly on the
  main window's `CloseRequested`; everything in the exit handler depends on that.
- **Shutdown marks what was mid-*turn***, and that has been got wrong twice in the same
  direction — each time by widening "interrupted" to something easier to ask, and each time
  the cost was the whole wall coming back claiming its last turn was cut off. First it was
  every row with `closed_at IS NULL`, which also matches dormant cards restored from previous
  sessions. Then it was every id `Supervisor::shutdown` killed — which was fine until rousing
  gave *every* dormant card a process at launch, at which point a clean quit flagged all of
  them and the next launch sent each a `resumePrompt`: money and an agent apiece, for turns
  that finished hours ago. A process is not a turn. `Conv::turn` is a flag the reader thread
  keeps (`turn_mark`: speech opens, `result` closes), `shutdown` returns only the ids holding
  it, and `store::mark_interrupted` still guards on `closed_at`. Schema v10 clears the flags
  written under the old rule, since nothing can tell them apart from real ones.
- **And then it under-fired, because a crash is not a shutdown.** Narrowing the rule was
  right and writing it *only* at `ExitRequested` was not: the column then meant "the app was
  asked to close while this was mid-turn", and the one exit that actually loses work asks
  nothing. Skein killed, and the wall came back with every card looking as though it had
  finished cleanly. So the mark is no longer computed at the end — `store::set_mid_turn`
  writes it at both boundaries of a turn as they happen (`send_prompt` and the reader thread,
  on a *transition* only, since `stream_event` arrives thousands of times a turn), and what
  survives a crash is a row that was already true. The clean path keeps `mark_interrupted` as
  a backstop, and the front end stopped clearing the flag after a send — that write now lands
  on a turn the same call has just opened, which is the under-firing bug in one line. The
  general shape: **a flag that says "something was lost" must be written when the thing
  starts, not when it is noticed** — code that runs at exit is exactly the code a crash skips.
- **The transcript directory slug folds every non-alphanumeric character**, not only the
  separators: `C:\atelier\skein\.scratch\wall` → `C--atelier-skein--scratch-wall`, and one
  emoji becomes *two* dashes because the replacement runs per UTF-16 code unit. Getting the
  dot wrong meant `read_ai_title` looked at a path that did not exist and reported its
  normal, silent "no transcript yet", so every card under a dotted directory stayed
  untitled. Note the encoding is lossy, so nothing may decode it: anything enumerating
  sessions reads `cwd` out of the records instead, which all of them carry.
- **Migrations**: `store.rs` has a `SCHEMA_VERSION` and a `STEPS` ladder. `CREATE TABLE IF NOT
  EXISTS` is not a migration; every schema change gets a new `(N, migrate_vN)` rung doing
  `ALTER`s, via `add_column` so the rung is safe to re-run.
- **A migration's stamp is written by the same commit as the migration**, and getting that
  wrong locked the app out of its own database. `migrate` used to run every pending step and
  stamp `SCHEMA_VERSION` once at the end — one write standing for a dozen that had already
  committed, since SQLite is in autocommit there. A step that failed, or a process that died
  between two of them, left the columns applied and the version naming a schema from before
  them; the next launch re-ran what had already run, `ALTER TABLE conversation ADD COLUMN
  kind` answered *duplicate column name*, and `Store::open` failed. Every launch after that
  too, because the failure was in the recovery path: the only way out was editing the file by
  hand. Found on a wall with twenty cards and 342 turns on it, stamped v9 while carrying v11's
  column and v12's table. Now each rung and its `user_version` share one transaction, so what
  a crash leaves is a version that tells the truth — the same lesson `set_mid_turn` learned
  from the other side, and the same general shape: **bookkeeping that records how far
  something got must not be deferred to after the getting there.**
- **And a store that will not open must say so, because `main` is created hidden.** The `?` on
  `Store::open` in `setup` returns before `window::settle`, so every database failure was a
  process that started, drew nothing and exited silently — "skein doesn't start any more",
  with the whole of the cause in a string nobody could read. `complain` in `lib.rs` puts it in
  a native `MessageBoxW` and names the file first. Not `tauri_plugin_dialog`, which the rest
  of the app uses: its `blocking_show` needs an event loop to pump, and nothing in `setup` has
  one yet. Anything else added to `setup` that can fail before the window shows owes the same.
- **Tauri arg names**: `invoke` converts camelCase to the command's snake_case parameters.
  A misspelled key is silently dropped into `None` rather than erroring — this is how
  `lastTier` vs `last_ending` left the column NULL for every turn ever taken, and cost every
  restored card its `--resume`. Schema v2 backfills what was recoverable.

### Rules that reach past the file they were written for

Each of these was learned in one place and then bit somewhere else. They are stated here
rather than only in the rule that owns them, because a rule loads when you open its files and
these apply when you open almost anything.

- **A Tauri command that blocks must be `async`, and `crate::off_main` is how.** A
  `#[tauri::command]` without `async` compiles to `tauri-macros`' `body_blocking` arm, which
  runs the function *inline on the thread that dispatched the IPC* — the main thread. That is
  also the only thread that drains the event-loop queue, and `app.emit` from a reader thread
  merely queues onto it (`tauri-runtime-wry`'s `send_user_message` is `proxy.send_event` and
  nothing more). So blocking there does not make one command slow, it stops **every card on
  the wall** from being painted for exactly as long as it blocks, and then lands the whole
  backlog at once. That is how a 20s `ureq` read timeout in `azdo_runs` became a 20s freeze of
  the entire app, once per 20s poll, with every conversation resuming together afterwards —
  which is what it looks like from the outside, and it looks nothing like a network timeout.
  `#[tauri::command(async)]` alone is *not* the fix: that arm is `async_runtime::spawn`, i.e.
  `tokio::spawn` onto the runtime's **worker** pool, sized to the core count — and that is the
  same pool that delivers every command's response, so a few slow calls reproduce the freeze
  one layer down. `off_main` in `lib.rs` is `spawn_blocking`, which is the pool built for work
  that parks a thread. **And the rule reaches one step further than the blocking call itself:**
  any command sharing a mutex with a now-long-running one has to leave the main thread too, or
  it waits there for the lock and the freeze comes back through the back door. `release_azdo`
  is that case — clearing a cache is instant, but `azdo_runs` holds the cache mutex across an
  entire network pass.
- **Every spawn goes in a job object, and the one that did not was the biggest.** `child.kill()`
  is `TerminateProcess` and it reaches exactly one process, so anything the child started
  outlives it — orphaned, unparented, and invisible from a wall that has no handle on it any
  more. `servers.rs`, `bang.rs`, `shell.rs` and `actions.rs` each learned this and put their
  tree in a `jobs::Job` with `KILL_ON_JOB_CLOSE`; `supervisor.rs` — the `claude` children,
  which carry a `cmd → node` per stdio MCP server, a `conhost`, and a `bash.exe` per Bash tool
  call — did not. So `close_conversation` reclaimed the agent and nothing under it, and quitting
  left the day's accumulation running with no window left to see it from. Measured 2026-08-19:
  80 descendants under one Skein for 6 cards, the oldest a `bash → bash → bash → bun` chain
  sixteen hours old under a card long since finished with it. The one deliberate exception is
  `actions::launch_detached`, which spawns from *Skein* rather than from a card, so an editor
  still outlives the wall — and it says so where it is. **Anything new that spawns owes a job
  object, and the promise "children die with the app" is only worth what the job holds.**
- **Anything that grows at the bottom follows its own tail, and `follow.ts` is how.** Near the
  bottom means stuck to it; scrolled back means nothing moves. Every scroller that gains
  content at the end wants that, and it had been written three times to three standards — at
  length in `Transcript.svelte`, naively in `Console.svelte` (which therefore stopped following
  mid-build), and not at all in `Servers.svelte`, whose logs opened at the oldest of their last
  hundred lines and stayed there. `{@attach stickToTail}` is the whole of what a plain scroller
  needs, and it hears growth through a `MutationObserver` rather than being told about it, so
  there is nothing for a component to forget. The judgement — `stillFollowing`, which turns on
  the position the follow last wrote, because a write's scroll event arrives a beat *after* the
  bottom has moved — is pure and tested. See `panel.md`.
- **Nothing standing on the wall may be transparent.** The backdrop draws behind everything,
  so whatever stands on the wall is the only thing occluding it — a dormant card was
  `background: transparent` and a leaf drifted through the middle of one. The deliberate
  exception is a widget's `bare` frame, which is a reading you chose. See `ambience.md`.
- **Every density's card must fit its slot.** Cards sit on a fixed pitch that does not change
  with zoom; `CARD_BOX` in `layout.ts` records what each density draws at and
  `layout.test.ts` asserts it. Changing a `[data-lod]` size means updating `CARD_BOX`. **And
  density is height only** — every density is `CARD_W` wide, because a card that changes shape
  as you zoom reads as the wall rearranging itself rather than as the same wall further off,
  and the pitch is fixed so a narrower card gives its width back to nothing. See `layout.md`.
- **The press is a click until it has travelled.** Capturing the pointer on `pointerdown`
  retargets the eventual `click` and silently swallows every button inside the thing you
  captured on. Same 4px slop everywhere. Bit `Canvas.cardDown` and then `WidgetNode`, and is
  now stated **once** — in `Canvas.groundDown`/`groundMove`, for every gesture the wall
  answers and all four kinds of thing standing on it. A marquee that appeared on the first
  pixel of movement was the same bug wearing a third face. See `layout.md`.
- **The wall's one-second tick advances by exactly one second.** `clock` in
  `conversation.svelte.ts` is the only wake-up on an idle machine and nearly every reading on
  the wall is a `Math.floor` of something linear in it — so a tick that drifts does not read
  as a late clock, it reads as an instrument that skipped a number. It was
  `setInterval(…, 1000)`, whose lateness banks rather than being spent, and a countdown would
  drop 4:31 straight to 4:29 every few hundred ticks. Now a self-correcting `setTimeout` aims
  past the coming boundary and `t` is *snapped* to it, which is the half that makes the step
  exactly 1000 rather than merely close. Anything else that ever schedules from "when the last
  one ran" owes the same correction.
- **Data folded in place needs a version number *and* a fresh value.** Where a structure is too
  big to be `$state` — the editor's four-thousand-cell grid is the one case so far — the
  sanctioned shape is a plain object mutated by the fold and a `$state` counter bumped when it
  settles. The trap is the second half: a `$derived` that returns the mutated object returns the
  *same object* every time, and Svelte only invalidates readers when a derived's new value
  differs from its old one (`deriveds.js`'s `update_derived`, `runtime.js`'s `is_dirty`). So
  the version bumped, the derived re-ran, and nothing redrew — the editor painted once at mount
  and then never again while you typed into it. The version is the dependency; something like
  `nvim.ts`'s `screenView`, which builds a new value each call, is the identity. See
  `.claude/rules/editing.md`.
- **Anything holding a Tauri subscription needs releasing.** `Skein`, `Attention` and
  `Control` are plain classes with no lifecycle, so `App.svelte`'s `onDestroy` releases them
  via `Listeners`. Skip it and a superseded instance keeps ingesting events *and writing
  rows* — one `result` became one `turn` row per generation. `snapshot.listeners.*` is how a
  leak is seen from outside; the counts must not climb across an edit. Module-level timers
  need the same care.
- **A background poll must never ask a question.** `GIT_TERMINAL_PROMPT=0` and
  `credential.interactive=false` on anything that shells out to git, or a repo whose
  credentials expired pops a credential window over the wall from a poll nobody asked for —
  or blocks forever on a prompt there is no terminal to answer. See `actions.md`, `azdo.md`.
- **Opaque JSON columns are read by the front end, never by Rust.** `widget.config_json`,
  `ambience_profile.layers_json`, `cycle.state_json` and the ask's arguments all strike the
  same bargain: a normalizer runs on every read and degrades to something drawable, so a
  renamed knob or a newer build's data costs no migration and cannot put a NaN inside a
  frame loop.

### Windows and window chrome

`decorations: false`, so `App.svelte`'s header **is** the title bar (`data-tauri-drag-region`,
plus `WindowControls.svelte`). A second Tauri window (`peek`, `index.html?peek=1`) is the
notification surface — `main.ts` picks the root component off the query string —
deliberately a Skein-designed window rather than an OS toast. `attention.svelte.ts` escalates
taskbar flash → peek → optional chime.

**`main` is created hidden** (`"visible": false`) and `window::settle` is the only thing that
shows it, which anything added to `setup` has to keep true — an early return that skips the
show is an app with no window and no gesture that asks for one. It is hidden because the size
in `tauri.conf.json` is *logical* pixels and therefore a wish: at 150% scaling a 1920×1080
panel is a 1280×720 desktop, the configured 820 is taller than it, and `center` split the
overflow so the title bar — which with `decorations: false` is the only way to move the
window — went off the top of the screen. `settle` clamps to the monitor's work area before
the window has been drawn once, because correcting a window already on screen is a jump you
watch. Where it was last is remembered in `window_frame`, in physical pixels, since that is
the unit monitors are described in and the one that survives a scale factor changing.

Real-input, job objects, and the `to_screen` arithmetic are `#[cfg(windows)]`; non-Windows
arms return errors rather than silently no-oping.

## Conventions

- Comments here explain *why*, often citing a probe against a specific `claude` version or a
  bug that shipped. When you change behaviour that a comment justifies, update the
  justification — and if you probed something, say what you probed and what it returned.
- `tools/probe-context.ts` is the pattern for answering "what does the CLI actually do":
  spawn with Skein's exact argv, isolate one variable per variant.
- Design tokens in `src/lib/tokens.css`, single warm-ink theme on purpose. Chrome is
  achromatic and **colour is reserved for status** — celadon working, amber asking, rust
  failed. Don't introduce decorative colour.
- Prose in the UI is lowercase, quiet, and sentence-shaped ("dormant — will wake on send").
- **Project conversations** spawn with `--dangerously-skip-permissions`, so a broadcast is the
  most destructive gesture in the app; that is why it costs a modifier (Ctrl+Enter) and warns
  when targets share a working tree. **Chat conversations** (`conversation.kind`) spawn with
  `--tools WebSearch,WebFetch` and no bypass at all, so they can reach nothing on this
  machine. Which one a card is, is asked of the store inside `spawn_conversation` rather than
  passed in — `wake` would have had to remember, and the card it forgets is one that comes
  back from a rouse with the machine in its hands. See `.claude/rules/chat.md`.
- When a subsystem's reasoning grows past a paragraph or two, it belongs in its
  `.claude/rules/` file rather than here — this file is what every session pays for, and
  `/context` is where to check what that costs.

## Committing

**Finish a piece of work, commit it. Don't ask first.** A completed unit — a feature, a fix, a
refactor, a rule written down — is committed as soon as it stands up, without waiting to be
told. Work left sitting uncommitted in the tree is the failure mode this replaces: it is
invisible, it collects unrelated edits, and it puts the decision to keep it on someone who has
already said to keep it.

- **On the current branch, `main` included.** Branching first is not the default here; this is
  a solo repo with a linear history and the branch you are on is the branch you commit to. Say
  which branch it went to if it wasn't obvious.
- **Only when it stands up.** `bun run check` and `bun run test` before the commit, and they
  pass — a commit is a claim the tree builds. If something is genuinely half-done, that is not
  a completed unit; keep working or say plainly what is unfinished. Never commit around a
  known-red test to satisfy this rule.
- **One piece of work per commit**, in the house style: `skein: ` and then lowercase prose
  saying what changed and why, the body carrying the reasoning the way the log already does.
  `git add -A` is wrong when the tree holds something you did not write — stage what the work
  actually touched.
- **Pushing is still asked for.** A commit is local and cheap to amend or drop; a push is
  outward-facing and is not covered by this. Same for anything else that leaves the machine.
