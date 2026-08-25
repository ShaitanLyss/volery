---
paths:
  - "src-tauri/src/shell.rs"
  - "src/lib/shell.ts"
  - "src/lib/shell.svelte.ts"
  - "src/lib/Console.svelte"
---

# The floating shell

### The floating shell (Alt+I)

One long-lived `pwsh` **per project**, in the middle of the window, over the wall rather than
instead of it. Lifted straight from nvim's floating terminal, and the two things that make that
gesture worth having are both about *not* being modal: the panel is summoned and dismissed with
one key from anywhere at all, and dismissing it does not end what is running inside it.

- **The panel and the session are two facts.** Alt+I toggles the panel; the process outlives
  it, keeps its directory, and keeps its scrollback. A build you started keeps building while
  you go back and read what an agent said about it. Only `close` — or the app exiting — ends
  it. `snapshot.shell` reports `open` and `live` separately for exactly this reason, since from
  outside a panel that is shut and a shell that is gone look identical.

### One per project, and the panel follows the wall

There was one shell for the whole of Skein, and it was wrong in the way a single terminal tab
is wrong on a wall holding four repositories: every `cd` was undoing someone else's, and the
history Up walks through was four projects' commands interleaved. So a session is per project
now, and the panel is one window onto whichever of them is active.

- **The key is the project root, and it is three things at once**: the id Rust files the shell
  under, the directory it is started in, and what the front end looks it up by. Derived rather
  than allocated, which is what makes the dev path work — a Vite edit rebuilds `App.svelte` and
  the object holding every session with it, and the rebuilt one has to *find* the shells rather
  than spawn a second set beside them. A generated id would have lost them all every edit.
  Worktree cards need no thought here: a card carries its project root as its `cwd` whatever
  tree its agent is actually running in, so `skein` and `skein · fix` are one territory and one
  shell. (That used to say "whatever `--worktree` did with it". The flag is gone — Skein makes
  the tree itself now, `worktree.md` — but the reason this needs no thought is unchanged, and
  it is the `cwd` in the row rather than the flag that was ever doing the work.)
- **The active one is the last project you touched a card in, and it is sticky.**
  `activeShellKey` in `shell.ts` is the whole rule and it is pure, so it is tested rather than
  reasoned about. Sticky is the half that had to be decided: Escape, the ground click and
  closing a card all clear the focus, and none of them is a statement about which shell you
  wanted — a panel that snapped back to the first project on the wall every time you deselected
  is one you cannot leave pointing anywhere. The other half is membership: a project can be
  closed while it is still the last one you touched, and the panel stops landing there. Its
  shell is *not* killed — closing a project is not a request to kill a build — it just stops
  being the one Alt+I finds, and dies with the app like every other.
- **Chat cards do not move it.** A chat card stands in a folder of Skein's own (`chat_home`)
  and has no project at all, so following one would open a `pwsh` in the directory beside the
  database — a shell whose first command would have to be `cd` somewhere else. Touching one
  leaves the panel where it was, which is the same stickiness deselecting gets and for the same
  reason.
- **Switching starts one, but only with the panel open.** The alternative — switch the view and
  wait for Enter — spares a `pwsh` per project you click past, but it means a panel you just
  switched into cannot be typed in for four seconds without your having asked for anything, and
  the point of following the wall is being ready when you look. The open-only guard is what
  keeps that honest: `Shell.select` records the project either way and starts a shell only when
  there is a panel to start it in, so clicking across five projects with Alt+I down costs
  nothing. It is in `select` rather than in `App.svelte`'s effect on purpose — the effect runs
  with the panel shut too, and it must, or nothing names the active project and `stop`, `clear`
  and `close` have nothing to act on until the panel has been opened once.
- **The header says how many others are alive.** Splitting one shell into one per project made
  "a build is still running" a fact with nowhere to appear: the panel used to *be* every shell
  there was, and now it is one of them. The count is achromatic, because how many shells exist
  is chrome; `working` stays celadon and stays about the shell you are looking at.
- **`stop`, `clear` and `close` are the shell on screen, and only it.** A button that took down
  four shells is one nobody could press knowing what it did.
- **Alt+I fires while you are typing**, which no other binding on this wall does. It can
  afford to: Alt+letter is not a text gesture Chromium binds in a field, and there is no menu
  bar to collide with (`decorations: false`). Everything else in `onGlobalKey` is skipped
  outright while the panel is up — including the two branches that deliberately reach past a
  field, ctrl+arrow's scroll and ctrl+0's reading size, which would otherwise fire from inside
  a console into a transcript nobody is looking at.

### Pipes, not a PTY

This was once the opposite call from dev servers, which ran their children under a real
pseudo-terminal. It is no longer opposite: `servers.rs` came the same way on 2026-08-19, so
pipes are now what the whole app does and this file was simply first. The reason is written
down in `servers.md`: **portable-pty's ConPTY path does not work on this machine** — every
`openpty`-spawned child dies at `0xC0000142` (STATUS_DLL_INIT_FAILED) having emitted only
ConPTY's own `ESC[6n`. (The cause is still unsettled and `servers.md` carries a revisit note;
what is certain is that it fails.) A dev server that will not start is a chip that reads
`exited`; a *terminal* that will not start is the whole feature. So this is `std::process` with
three pipes, and the panel is honest about being line-oriented rather than pretending to be a
terminal emulator.

What that costs, and what it does not:

- **No TUI.** Anything that paints by moving a cursor — `vim`, `htop`, a full-screen installer
  — has nowhere to paint. Line-oriented output, which is essentially everything you actually
  type at a shell, comes through exactly as it does for dev servers, `pump_lines` and all.

  **The one that mattered got in by another door.** Editing is the case where "no TUI" would
  have been fatal rather than limiting, and the way round it was not to fix the PTY: nvim has a
  UI protocol built for programs rather than for terminals (`nvim --embed`, msgpack-RPC over
  these same three pipes), so the editor never needed a terminal at all. See
  `.claude/rules/editing.md`. Worth carrying past this file: **when the terminal route is
  blocked, check whether the thing you are talking to has a second interface meant for
  programs.** Editors, debuggers, language servers and build tools very often do.
- **Colour survives.** Probed 2026-08-17 against PowerShell 7 with `-Command -` over pipes:
  output streamed line by line as it happened, and SGR sequences came through intact
  (`Get-Location` emitted `ESC[32;1m`). `ansi.ts` renders them, the same parser the servers
  panel uses. `FORCE_COLOR` and `CLICOLOR_FORCE` are set for the toolchains that check.
- **There is no ctrl+C to send.** `GenerateConsoleCtrlEvent` needs a console the child shares,
  and a GUI app's children have none. So the gesture is `stop`, and it says what it does: kill
  the tree, open a fresh shell in the same directory. Naming it "interrupt" would have been a
  button that sometimes did nothing to a process that had hung. The tree goes down through a
  Windows job object with `KILL_ON_JOB_CLOSE`, the same one `servers.rs` uses and for the same
  reason — a shell spawns builds which spawn compilers.
- **`GIT_TERMINAL_PROMPT=0`**, as everywhere else that shells out. This one is foreground only
  in the sense that you typed it: there is still no terminal for Git Credential Manager to ask
  a question in, so an expired token has to fail fast rather than hang forever behind a prompt
  nobody can see.

### The marker

`-Command -` prints **no prompt and no echo** — which is what makes it usable as a stream, and
what means Skein has to draw the prompt itself and therefore has to be *told* where the shell
is. So after every command a second line goes in, whose whole job is to be recognised on the
way back out:

```
$__skein_ok = $?; Write-Output ([char]1 + 'skein' + [char]1 + …$PWD.Path)
```

`shell.rs` recognises it, turns it into a `shell:done { ok, cwd }`, and never emits it as
output. Four things about it are load-bearing:

- **The PowerShell stays in `shell.rs`, next to the argv it belongs with.** The front end never
  learns that a marker exists — it receives an event. A protocol split across the two sides
  would be one more thing to keep in step across a shell dialect.
- **`$?` is captured into a variable before anything else is evaluated**, because building the
  string would be that next thing and would clobber it. It is `$?` rather than `$LASTEXITCODE`
  because it is the one that means "the thing I just typed worked" for a cmdlet and a native
  exe alike.
- **The marker is searched for, not matched at the start.** A command that ends without a
  newline (`Write-Host -NoNewline`) leaves its last word on the front of our line, and that
  word is output. It is emitted as output and the rest read as the marker.
- **`cd` is a thing you type**, and so is a script that changes directory forty times without
  saying so. Nothing here parses what was typed; the prompt is whatever the shell last said
  `$PWD` was.

`[char]1` rather than a `` `u{1} `` escape, because Windows PowerShell 5.1 has not got the
escape and is the fallback rung of the ladder.

### Which shell, and what it costs to be yours

`pwsh`, then `powershell`, and the panel says which it got — the two differ in enough places
(encoding, `$PSStyle`, half the cmdlets) that claiming the wrong one would be lying about what
it runs. The spawn is the probe: a failed `spawn` falls through to the next rung, which is
cheaper and more honest than walking `PATH` for a name that may be a Store alias stub.

**The profile is loaded on purpose**, and it is why the panel has a `starting` state at all.
Probed 2026-08-17: this profile takes about 4s against 0.5s for `-NoProfile`, and prints a line
of its own on the way. That is a real wait, and it buys the aliases and functions that make it
*your* shell rather than a box that happens to run commands. The first marker is what says the
wait is over, so readiness needed no second mechanism.

Two things are primed before anything you type, and neither is shown: UTF-8 output, because
5.1 otherwise hands a redirected stdout the OEM code page and every box-drawing character
arrives as mojibake; and `$ProgressPreference = 'SilentlyContinue'`, because PowerShell renders
progress by steering a cursor we have not got and over a pipe that is a screenful of escapes
per web request.

### Attaching to a shell that is already running is the normal case

Not an error, and not a reason to spawn a second one. Toggling the panel shut leaves the
session live, and in dev **every front-end edit** rebuilds `App.svelte` and with it the object
that was holding it. `open_shell` answers a live id with a fresh marker instead of a spawn, and
reports `started: false` — so the reattach path and the first-open path look identical from the
front end, and the note that says `pwsh in <directory>` is only printed when there is a
directory we actually chose. An attached shell claims no `cwd` at all until its marker lands,
because it may have been `cd`'d anywhere since.

One-per-project put a second face on the same case: after a rebuild the new `Shell` knows about
no session at all, and a build running in a project you have not switched back to yet is still
emitting lines under an id nothing is holding. `#heard` adopts them — an unknown id on
`shell:out` or `shell:done` makes the record and marks it live, because a shell that is
speaking is a shell that is running, and dropping the lines would mean switching to that
project showed an empty panel over a process plainly working. `shell:exit` is deliberately not
on that list: it is the one event that must not conjure a session, or a shell this window never
adopted would turn up as a record whose entire content is that it is gone.

### Where things live

The usual three-way split. `shell.rs` is primitives and the one piece of shell dialect;
`shell.ts` is pure and tested (`test/shell.test.ts`) — the scrollback cap, the history ring,
`promptPath`, and `activeShellKey`/`sameDir`, which are the whole of which shell is showing;
`shell.svelte.ts` owns the sessions and their subscriptions; `Console.svelte` draws whichever
is active.

**`shell.rs` needed nothing for any of this**, which is the sign the split was in the right
place: `Shells` was already a `HashMap` keyed by an id it never interpreted, `shutdown` already
drained all of it, and every command already took the id from the caller. One-per-project was a
front end that started passing a different key.

- **The component is `Console` and the class is `Shell`** because `shell.svelte.ts` and
  `Shell.svelte` are one file to a case-insensitive filesystem and TypeScript says so. The same
  split `cycle.svelte.ts` and `Pomodoro.svelte` already have.
- **`Shell` holds subscriptions and a batch timer**, so `App.svelte`'s `onDestroy` releases it
  with the rest — `snapshot.listeners.shell` is 3 and must not climb across an edit. Lines are
  batched to a frame rather than pushed one at a time: a build emits thousands per second, and
  a `$state` write per line puts Svelte's scheduler in front of the reader thread. **One timer
  serves every session**, draining all of their batches in one pass: a batch is about how often
  the wall may be redrawn, not about which shell was talking, and a timer per project would be
  one more thing for `detach` to get wrong. A hidden session's lines are still flushed, so
  switching to it shows what it printed while you were elsewhere.
- **The command history is per project too**, which is the one that reads as a surprise until
  you want it. Up in a project you have not typed in for an hour should reach that project's
  last command — the thing a shared history cannot do, and the reason `history`, `at` and the
  draft stash all live on `ShellSession` rather than on `Shell`.
- **`Shell`'s flat fields are getters onto the active session.** `program`, `cwd`, `where`,
  `lines`, `busy`, `live`, `fault` and `at` all read through `active`, so `Console.svelte` and
  the control surface read exactly what they read when there was one shell, and a test written
  then still means what it meant. `sessions` and `others` are the new surface, and
  `snapshot.shell` carries `sessions` for the same reason the header carries a count.
- **`promptPath` cuts from the front**, which is why it exists rather than a
  `text-overflow: ellipsis` — that cuts the other end, and every prompt in this repo would read
  `C:\Users\flori\Documents\…`. It keeps four segments rather than three because the drive
  spends one of them.
- **The failure mark goes on the command, not in its output.** Which line failed is a question
  you ask having scrolled past a screenful of what it printed, so the answer wants to be at the
  top of that screen. Rust for the caret, and nothing else — colour is status here as
  everywhere.
- **Following the tail is `stickToTail` and nothing local.** The console had its own naive
  version — `slack < 24` measured in an `onscroll`, no correction for its own writes — so a
  burst of build output landing in the beat before the scroll event arrived read as a hand on
  the wheel and the panel silently stopped following what it was printing. It is the shared
  attachment now (`follow.ts`; the reasoning is in `panel.md`), plus one call to `snapToTail`
  after Enter: a command you *asked for* takes you back to the bottom even if you had scrolled
  up to read what the last one said, which is the one thing about this panel's follow that is
  its own.
- **The panel is opaque and has no scrim.** Opaque because the backdrop draws behind everything
  and a leaf drifting through a console is the same bug a dormant card once had; no scrim
  because the reason to open a shell beside a card is usually the card, and the wall behind
  stays readable *and* clickable.

The control surface has a `shell` op (`show`, `select`, `hide`, `send`, `stop`, `close`,
`clear`) driving the panel's own functions, and `key` grew an `alt` flag so `wall.test.ts` can
press the real binding rather than call `show` and prove nothing about the key. `cwd` on `show`
and `select` names *which project's* shell — the one thing a test cannot get by touching a
card, since it wants to name the project rather than go and find a card standing in it.
