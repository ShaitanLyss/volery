---
paths:
  - "src/lib/actions.ts"
  - "src/lib/actions.svelte.ts"
  - "src-tauri/src/actions.rs"
  - "src-tauri/src/project.rs"
---

# Project actions

### Project actions (`src/lib/actions.ts`, `actions.svelte.ts`, `src-tauri/src/{project,actions}.rs`)

The verbs a project has all day — build it, test it, open its editor, ship it, push it — as a
row of chips along the **bottom** edge of its territory. Deliberately not up beside the dev
servers: an Unreal project offers six of them, and that row is already the project's name, its
servers and two ways to start a conversation. Identity and address at the top, work at the
foot, each with the full width. The row lives inside the region's own `REGION_PAD`, which is
why it needs no layout constants of its own and is the same size at `wall` and at `open`.

The split is the same one `classify.ts` draws for Claude:

- **`project.rs` answers in facts and never in verbs.** What a project *is* — its scripts, its
  package manager, its `.uproject` and the engine that `EngineAssociation` resolves to — is
  probed when the territory appears, and then only at the two moments it can have changed
  (below). What it is *doing* — is its editor up, is the branch ahead — is a poll, every 8s.
- **`actions.ts` is pure** and holds all the toolchain knowledge: UBT's argv, what Live Coding
  prints when it succeeds, how to read `[3/12]` and `@progress` and the cook's counters. It is
  tested directly (`test/actions.test.ts`).
- **`actions.rs` is primitives only**: spawn argv, tail a file, PUT a console command, focus a
  window, close a window, is-this-pid-alive. It decides nothing.
- **`actions.svelte.ts` orchestrates**, because half of these are sequences — a cycle is close,
  then build, then relaunch — and a sequence with a UI attached belongs in the front end.

Things that are load-bearing:

- **Facts are re-read at the two boundaries a file can change across, and neither of them is a
  clock.** "Probed once and never again" was a claim about the *poll* not re-reading a
  package.json every eight seconds, and it got read as a claim that the facts cannot change —
  so the bump chip said the version it found when the territory appeared and went on saying it.
  Pull a release somebody else cut and the arc offered a bump that had already been made, from
  a number the file no longer held; it then refuses at the last step, or writes a version
  backwards. The two boundaries: **a run finishing**, in `run`'s `finally`, since `git pull
  --ff-only` is this app changing that file just as much as `bump_version` is — which is why
  the re-probe is every chip and not, as it first was, only the one that writes a version; and
  **the window coming back to the front**, `Actions.refocus`, for the pull done in a terminal
  and the version edited in an editor. The second is the CLAUDE.md shape — nothing emits an
  event when a file changes under us, so fold the event that already exists nearby, and focus
  is not merely the available one but the right one: coming back to the window is exactly the
  boundary of not having been looking. Bounded by `refocusStep` (pure, tested) on the
  transition into focus only and behind a floor, so a burst of alt-tabs costs one pass. No
  backstop timer, because unlike the update check this leaves nothing on the network —
  `probe_project` is local reads.
- **Steps carry argv, never a shell string.** Everything runs through `cmd /C call …`, and cmd
  does not read the `\"` escaping a Windows command line is quoted with — so
  `C:\Program Files\Epic Games\UE_5.8\…`, which is where every engine is installed, would
  arrive at UBT in pieces. The `call` earns its place too: cmd strips the first and last quote
  of its own tail when that tail *begins* with one, so a command whose first token is a quoted
  path loses it. A bare word in front means there is nothing to strip.
- **The facts are re-read at both boundaries, and the narrow one was not enough.** The bump
  chip reads a version out of `facts` and offers the next one, so a stale fact does not read as
  stale — it reads as a chip offering a bump that has already been made, refusing at the last
  step or writing a version backwards. `bump` used to `reprobe` by itself, on the argument that
  it was the one place this app edits a package.json. Which was true and too narrow twice over:
  `git pull --ff-only` is one chip along and edits that file too, and a version changed in an
  editor is not this app at all. So there are two callers of `reprobe` and they divide the
  causes. **What this app did**: `run`'s `finally`, every chip, the one project whose chip was
  pressed. **What happened while the wall was not in front**: `Actions.refocus`, every project.
  There is no watcher and no clock, because *nothing emits an event when a file changes under
  us* — so, per CLAUDE.md, fold the event that already exists nearby. Focus is it, and not
  merely because it is available: the invariant being bent says the facts change while you are
  *not looking*, and coming back to the window is exactly that boundary. Two bounds, both in
  pure `refocusStep` because both are three lines and both are easy to get subtly wrong — only
  on the transition *into* focus, and a floor measured from the last **yes** rather than the
  last reading, or a burst of alt-tabs pushes the floor out ahead of itself forever and the
  wall never re-reads at all. No third bound and no backstop timer: unlike the update check
  this leaves the machine for nothing, being a dozen `read_to_string`s per project.
- **Pipes, not a PTY** — see the note under dev servers. `pump_lines` is shared, and it splits
  on `\r` as well as `\n` whatever it is reading, so a redraw still arrives as a line. Both
  streams are pumped: cargo and UBT do much of their talking on stderr.
- **The log keeps its colour; everything that *reads* a line gets it stripped.** A `[1/4]`
  behind an SGR sequence matches nothing, and a note carrying raw escapes puts literal
  `ESC[43m` in a tooltip and on the fault bar.
- **pnpm is the default** when a repo says nothing — `packageManager` first, then the lockfile,
  then pnpm. npm is what gets typed by habit rather than chosen. Only npm needs `--` to forward
  arguments through a script, which is the whole of the dialect difference that matters.
- **Is the editor open** is asked the cheap way first: a top-level window of class
  `UnrealWindow` whose title carries the project name, one `EnumWindows`. Only when that finds
  nothing does it fall back to the authoritative answer — the process command line, which on
  Windows means a PowerShell/WMI spawn — cached 15s. It has to be *this* project's editor:
  another project's `UnrealEditor.exe` must never receive our compile and test triggers, and
  the Remote Control port (30010) is shared by all of them.
- **`git status` is asked with `-uno --no-optional-locks`.** The untracked scan is essentially
  the whole cost of status on an Unreal project — `Saved/`, `Intermediate/`, `DerivedDataCache/`
  — and answers a question the push chip never asks; the lock flag stops a poll colliding with
  a commit being made in a terminal.
- **`pull` and `push` are drawn only when there is something to do**, which makes their
  *presence* the news: a pull chip on a territory means somebody pushed to that remote, legible
  from across the wall without reading a label. They are last in the row because they come and
  go, so what moves under the cursor is only ever each other.
- **The fetch is a second, much slower clock, and the only thing here that leaves the
  machine.** `behind` comes off the same `--porcelain=v2 --branch` header `ahead` does
  (`# branch.ab +2 -5`, parsed and thrown away for as long as only push existed), so it is
  local and free — but it measures against the remote-tracking ref, which is only as current as
  the last fetch. So `project.rs::fetch_projects` runs `git fetch` per repo, at `FETCH_MS`
  (5 min) rather than `POLL_MS` (8s), and is **fire-and-forget**: it has no verdict worth
  drawing, and what it changes is read by the status poll already running, so a colleague's push
  becomes a pull chip within one tick of the fetch landing and nothing ever waits on the
  network. Deliberately not a `Run` — a fetch in the runs list every five minutes buries the
  builds you pressed.
- **A background fetch must never ask a question.** `GIT_TERMINAL_PROMPT=0` and
  `-c credential.interactive=false`, or a repo whose credentials have expired pops Git
  Credential Manager's window over the wall from a poll nobody asked for — or blocks forever on
  a prompt there is no terminal to answer. Both turn it into a fast failure, which is right:
  being unable to fetch is not worth interrupting anybody about. `FETCHING` holds a root for the
  life of its fetch so a dead remote cannot stack a thread per tick, and `#fetched` is stamped
  *before* the call for the same reason on the other side — a hang must not put its repo back at
  the front of the queue forever.
- **A conflicted repo tears its own territory.** Conflicts are not a verb the project offers,
  so they are not an `Action`: they are something that happened to it and has not finished, and
  the wall draws that as a state. The region's boundary is already a dashed line — a stitch —
  so `.region.torn` draws a second dashed rectangle 4px outside the first. The two are 8px
  different in each dimension, so their dashes fall out of step along every edge and the pair
  reads as one seam that has split. No SVG and no animation. It is the one project-level state
  drawn at **every** density, `field` included: colour is status here and rust is the fault
  colour, so a wall zoomed right out still shows which project is torn without showing a word.
  Deliberately not a fill — cards stand inside a territory and the backdrop draws behind
  everything, so a wash would sit between the two and tint work that is perfectly fine.
- **The badge is at the foot, opposite the verbs**, right-aligned off the region's own edge so
  a long acts row cannot shove it and so it needs nothing from that row's existence — a bare
  git repo with no build and nothing to push still tears. Clicking it opens a *new card* rather
  than broadcasting: the cards already in that territory are mid-thought on something else, and
  a conflict is its own piece of work with its own transcript worth keeping.
- **`ours` and `theirs` are backwards in a rebase**, and that single fact is most of why
  `conflictPrompt` is worth having. Git replays your commits onto the other branch, so the
  *other* branch is what is being built on and gets called "ours" while your own work arrives
  as "theirs". An agent not told which operation it is standing in takes the wrong side with
  complete confidence. `git_operation` answers it by checking `rebase-merge`/`rebase-apply`
  **before** `MERGE_HEAD` — git's own order in `wt-status.c`, because a rebase that stops on a
  conflict can have `MERGE_HEAD` too — and asks only while `conflicts > 0`, since it costs a
  second spawn. It goes through `git rev-parse --git-dir` rather than joining `.git` by hand,
  because in a worktree that is a *file* pointing elsewhere and worktrees are how half the
  cards on this wall are opened.
- **The prompt spends its length on method, not mechanics.** Anything can delete a marker; the
  ask is what each side was *for*, which a person does by remembering and an agent has to do by
  reading. So it says where to find each side's intent, that the answer is usually neither side
  verbatim, and — the important one — to **stop and ask** where the two genuinely cannot both
  be true, rather than pick. A conflict resolved by coin toss is worse than one left standing,
  because it looks finished. It never lists the conflicted paths itself (the list from
  `project.rs` is capped at 8 and would quietly lie about a forty-file conflict — the agent is
  standing in the repo and can run `--diff-filter=U`), and it stops before `git commit` and
  before any `--continue`: every card here spawns with `--dangerously-skip-permissions`, and a
  merge is exactly the thing to read before it becomes history.
- **`pull` is `--ff-only`.** This wall is full of agents editing these repos with
  `--dangerously-skip-permissions`, and a chip that can stop halfway through a merge is a chip
  that eventually does, leaving a conflicted tree for whatever is mid-turn in it. A refusal is a
  message; a conflict is an afternoon. Reconciling a divergence is a decision, and decisions
  belong in a terminal — the chip says "diverged" and stops.
- **Closing the editor is WM_CLOSE, never a kill.** The editor has to get to put up its "save
  your changes?" prompt. A cycle that threw away an afternoon of level edits gets used once.
- **The editor is launched detached and outside any job object** — the one spawn in the app
  that deliberately outlives Skein. Closing the wall must not take unsaved level work with it.

Unreal's shape here is lifted from a working nvim setup (`~/AppData/Local/nvim/lua/unreal.lua`),
which had already paid for the two facts that make it non-obvious: UBT *refuses* an external
build of the editor target while the editor holds the Live Coding mutex, so `build` means a
console command sent to the editor when one is open and a `Build.bat` when one is not; and a
headless test run spends ~30s booting a second editor, so with one already open the tests run
inside it. Neither of those has an exit code to read — the Remote Control call returns the
moment the editor accepts it, and the answer turns up in `Saved/Logs/<Name>.log` seconds later
— which is why `tail_log` exists and why the marker vocabulary is pure and tested.

The control surface has `action`, `action.cancel`, `action.poll`, `action.fetch` and
`action.resolve` (which spawns a real agent and sends it a real prompt), and `snapshot` reports
each project's facts, status, chips and runs. `snapshot.listeners.actions` is 2, and must not
climb across an edit.

### The editor log, tailed for a widget rather than for a run (`#reconcileTails`)

`tail_log` was written for one job: a Live Coding compile's verdict, which arrives in the
editor's log some seconds after the Remote Control call has already returned. `#tail` wraps it
in a `try/finally` because a tail has no verdict of its own, so whoever started it has to end
it — left running, the next build's lines would arrive at a run that finished ten minutes ago.

The editor log widget wants the same primitive with none of that shape: no run, no verdict, and
a lifetime measured in afternoons. So it is a second kind of caller rather than a second
mechanism.

- **It is not a `Run`, and that is the point.** Nothing waits on it and it has no exit code, and
  putting one in `runs` would bury the builds you actually pressed under a row per open editor.
  `#tails` (root → id) and `#tailRoots` (id → root) are plain maps, not `$state`, for the reason
  `#fetched` is: nothing draws them.
- **`action:log` now has two destinations**, and the order matters only in that a real run must
  win: `#byRunId` first, then `#tailRoots`. Same event because it is the same Rust primitive —
  `tail_log` emits under whatever id it was given, and a widget's tail is one more id.
- **Two conditions to be running**, checked on every `poll`: a widget is asking
  (`wantsEditorLog`, injected from `App.svelte` because this file may not reach into the widget
  registry) *and* the editor is up. A closed editor is a file that will not change, so a tail on
  one is a thread and a 250ms wake spent watching nothing. On a wall with no editor log widget the
  whole thing costs one set-difference per tick.
- **`poll` no longer returns early with no projects**, because that path still has to *stop* a
  tail — a project that has left the wall must not keep one running. And `detach` clears
  `wantsEditorLog` and reconciles, because `Listeners` covers the subscription and nothing but
  that covers the threads on the other side of it. A superseded generation in dev would otherwise
  leave one per open editor reading a file for a wall nobody can see.
- **Priming is per editor session**, tracked in `#primed` and cleared when the editor goes.
  `read_tail` — already here for splicing UBT's log into a failed Live Coding build — supplies the
  recent past that `tail_log`'s seek-to-the-end deliberately skips. The millisecond between the
  two loses lines rather than duplicating them, which is the right way round for that trade: a
  gap in a log looks like a log, where a line printed twice looks like a bug in the thing printing
  it. The first line read is dropped, because a byte offset is not a line boundary.

See `.claude/rules/widgets.md` for the face, and `unreallog.ts` for the parse.
