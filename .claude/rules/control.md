---
paths:
  - "src-tauri/src/control.rs"
  - "src/lib/control.svelte.ts"
  - "test/wall.test.ts"
  - "tools/ctl.ts"
---

# The control surface

### The control surface (`src-tauri/src/control.rs` + `src/lib/control.svelte.ts`)

Off unless `SKEIN_CONTROL=1` (or a pinned port number). It binds loopback, writes
`%APPDATA%/dev.skein.studio/control.json` with a fresh token, and lights a chip in the title
bar. `POST /op` with `X-Skein-Token` runs one op in the studio and returns its answer.

```powershell
$env:SKEIN_CONTROL="1"; bun run tauri dev     # terminal 1
bun tools/ctl.ts health                        # terminal 2
bun tools/ctl.ts ops                           # the full vocabulary
bun tools/ctl.ts snapshot cards
bun tools/ctl.ts send card=skein text="hello"
bun run test:wall
```

Two rules make a green run mean something, and both are easy to break:

1. **Ops drive the app's own seams.** Injecting an event goes out as a real `conv:event` and
   comes back through Rust to the same listener the supervisor talks to; a dropped file goes
   out as a real `tauri://drag-drop`. Never add an op that reaches into component internals
   or builds a parallel path.
2. **Synthetic vs real input, which is a ladder and not a pair.** `click` and `key` dispatch
   synthetic events and prove only that handlers are connected. `real.click` / `real.drag` /
   `real.wheel` / `real.key` move the actual Win32 cursor and press actual keys, and are the
   only thing that can see Chromium retargeting a real click after `setPointerCapture`, or
   scroll a scroller the app does not scroll itself. They need a **second** opt-in,
   `SKEIN_CONTROL_INPUT=1` — `SKEIN_CONTROL` alone must never arm the mouse.

   The rule is not "prefer real". It is **say which rung a claim needs, and use that one**,
   because the armed rung is skipped in most runs and a claim that only it can check is a
   claim nothing checks on an ordinary afternoon. Three rungs:

   | rung | ops | proves | costs |
   |---|---|---|---|
   | one event | `click`, `key`, `wheel` | a handler is bound to a name | nothing |
   | the whole gesture | `press`, `scroll` | the app's own sequencing and bookkeeping | nothing |
   | a real gesture | `real.*` | that Chromium delivers it to the thing you aimed at | needs the mouse lent, so skipped by default |

### The gap that made it a ladder

Rungs one and three were the whole vocabulary, and between them sat two things nothing could
reach (sink 59f00bee, hit while building the file-viewer tabs).

**`el.click()` fires one event out of five.** Every dismissible thing on this wall closes on
`pointerdown` — `ContextMenu`'s catcher, `Overflow`, the dog-ear knobs, the file viewer's
window listener — on the stated argument that the panel should be gone before whatever is
underneath decides what the press meant. So the one gesture those components exist to get
right was the one gesture the surface could not make, and the same went for the press half of
`Canvas.groundDown`, where the selection is settled and four kinds of thing are grabbed.
`press` is the full ladder — `pointerdown`, the moves, `pointerup`, then the `click` or the
`auxclick` — with a frame between each, because the handlers write `$state` and measure the
DOM again on the next move.

**A synthetic key moves no scroller, and a synthetic wheel scrolls nothing.** There is no
default action on an untrusted event to be taken, so End over the control surface did nothing
— and the viewer's own handler is *right* to ignore it ("arrows, page keys, Home and End all
mean in a file exactly what they mean in a file"). The only scroll the surface could cause was
the app's own `scrollIntoView` on the line a file was opened at. That cost a whole behaviour
its test: the dog-ears remember where you were reading and put you back
(`Spyglass.reading`/`putBack`), and since a tab's line and its remembered reading always agree
until something scrolls, "restored your reading" and "re-centred the line" were the same
observation from outside. The user confirmed it by hand.

`scroll` writes a scroller's `scrollTop`, and that is **rung two rather than a parallel path**:
a written `scrollTop` fires the same `scroll` event a wheel does, and every listener that folds
one hears it identically. What it cannot see is *which* scroller a gesture lands on — nested
scrollers, a non-passive listener that preventDefaults, `overscroll-behavior` — and that is
rung three's, which is why `real.wheel` and `real.key` exist rather than `scroll` being called
enough.

Three things about them worth knowing before reaching for one:

- **`scroll` with no `to` and no `by` only reads, and that is the common case.** The assertion
  worth making is that two readings of the same scroller agree, never that one of them is a
  particular number — a scroll offset in pixels is a fact about a font. Same reason
  `finder.tabs[].read` reports *whether* a place was kept and not what it was.
- **`scroll` refuses a box with no overflow** rather than reporting `scrollTop: 0, as
  requested`. Nearly always the wrong selector, and a plausible answer there reads as the app
  having failed to remember.
- **A synthetic drag cannot honestly cross the slop.** The first thing `groundMove` does past
  `DRAG_SLOP` is `setPointerCapture`, and a pointer id no real pointer owns is not something a
  page may capture. `press` takes `dx`/`dy` anyway and reports what the app threw while they
  were delivered (`errors` in the reply), so the outcome is *observed* rather than assumed —
  but **a drag you want to believe in is `real.drag`**. Its id is deliberately nowhere near 1:
  borrowing the real mouse's would put a fictional pointer in the slot Chromium tracks the
  actual cursor in, and a harness that leaves the real pointer captured has broken the app it
  was measuring.

`real.key` takes `KeyboardEvent.key`'s spelling, not Win32's, so one spelling for a keystroke
holds across both rungs — and `vk` in `control.rs` is a **closed** table that refuses what it
does not know. Deriving a virtual key from the character with a fallback for the rest gives you
a harness that presses *nearly* the right key and a test that fails nowhere near its assertion.
Positive `notches` on `real.wheel` scrolls **down**, which is `deltaY`'s sense and the
synthetic `wheel` op's; Win32 means the opposite by a positive wheel, and the flip happens in
`control_real_wheel` and nowhere else.

**What is deliberately not tested from here is the follow.** `scroll` makes it look easy —
scroll `.lines` back, feed an event, assert the panel did not jump — and the note further down
this suite explains why it would be a guard that cannot fail: this suite runs with the studio
in the background, which is exactly where `watching` re-arms `following` on every arriving
event. The judgement lives in `follow.ts` and is tested there, with no DOM to arrange.

### Voice is the second pair of hands, and it is not a client of this

`voice.hear` and `voice.say` drive the whole path from a sentence to the wall moving, with a
keyboard where the microphone will be. That is not a stand-in: `voice.ts` never sees audio in
any of the three designs in `docs/VOICE.md` — a transcript is text on the ordinary event
pipeline — so everything below the recogniser is exactly what these two ops drive. The
feature is therefore drivable, and testable, before a frame of audio has been captured.

They are here because this is the surface for driving the app from outside, and **not**
because voice goes through it. `App.svelte` builds the `ControlHost` unconditionally and hands
the same object to `new Control(...)` and to `new Voicing(...)`; only the listening socket is
gated on `SKEIN_CONTROL`. Arming a loopback port in every install so a voice layer had
somewhere to POST would be the parallel path rule one exists to forbid, wearing a disguise.

The pair is deliberate and it is the same split as `press` versus `real.press`, one subsystem
over: **`voice.hear` parses and runs nothing**, so a test can assert what was *understood*
apart from what was *done*. Those two fail differently — a misparse and a dead handle look
identical from a surface that can only see the wall afterwards — and the day the steward rung
lands, `voice.hear` is the op that can score it without spending anything on the wall.

`voice.say` will not carry out a plan whose disposition is `confirmation` unless it is passed
`confirmed: true`. That gate is in `Voicing.say` rather than in the op, so a future keystroke
cannot forget it.

There is no `eval` op, on purpose. Editing any front-end file hot-reloads `App.svelte` and
constructs a second `Control`; a generation counter on `window` (not module scope) keeps the
superseded one silent — this once caused a single `open` op to spawn two agents.

The same hazard applies to anything holding a Tauri subscription. `Skein`, `Attention` and
`Control` are plain classes with no lifecycle, so **`App.svelte`'s `onDestroy` releases them**
via `Listeners` (`src/lib/listeners.ts`). Skip that and a superseded `Skein` keeps ingesting
events *and writing rows* — one `result` became one `turn` row per generation. `snapshot`
reports `listeners.skein` / `listeners.attention` / `listeners.actions` so a leak is visible
from outside: they must not climb across an edit (7, 3 and 2 today). Module-level timers need the same care — see the
`clock` interval's `window` handle in `conversation.svelte.ts`.

`test/wall.test.ts` only ever creates conversations under `.scratch/walltest/`, closes each
test's own cards in `afterEach`, and sweeps the subtree in `afterAll`. Keep it that way, so
running it cannot disturb real work on the wall.

**The `afterEach` is about memory, not tidiness.** `open` spawns a real `claude` per card, a
dozen processes and about a gigabyte of commit with its MCP servers (`processes.md`), and the
suite opens thirty-odd. Held to `afterAll`, they took free commit on this 32 GB machine from
fifteen gigabytes to half of one (2026-10-08, sampled every 3s). The lab then died mid-run with
`memory allocation of 131072 bytes failed`, and every later test failed "Unable to connect" —
from a different test each run, depending on what else the machine was doing. That was a good
part of sink 64e5003c's "the red moves between runs". It was also a suite that could take the
user's own apps down with it. No test may reach back for a card an earlier one opened; open
your own.

### Running it from a card, which is how it is run now

Three traps, each of which turned a run into noise that read as product failures. All three
were hit together on 2026-10-08, and nothing in the output points at any of them.

- **The wall's reaper kills a lab you launched in the background.** `perf.rs::sweep`, once a
  minute, `taskkill /T`s any process in a card's job whose parent has gone and that is over a
  minute old. A lab started from a card is in that card's job, and Git Bash's `&` or `exec`
  leaves a Windows process whose parent is already gone, even while your command is still
  running. So the lab, its launcher and the test runner under it vanished 60–120s in, with an
  empty log and no crash event. **Launch it natively and wait on it.** In PowerShell,
  `& skein.exe` or `Start-Process` from a script that stays up keeps every ancestor alive back
  to `claude.exe`. Run `bun test` from PowerShell too, for the same reason.
- **Another card's edit hot-reloads your lab mid-run.** Every front-end save in this shared
  tree reaches a `bun run dev:lab` vite, the studio generation moves, and `ctl()` correctly
  refuses every later answer as a ghost. Thirty failures, none of them real. **For a run you
  mean to read, serve a frozen build:** `vite build --outDir .scratch-$SKEIN_CARD/dist`, then
  `vite preview --outDir … --port 1421 --strictPort`. A debug `skein.exe` loads whatever
  answers on :1421, so it never knows the difference, and the build is the tree as it was when
  you took it. Say on the board that :1421 is yours and frozen, since other cards' labs load
  from it too.
- **A store of its own is `VOLERY_WALL_DIR`, and images do not load there.** Copy
  `target\debug\skein.exe` and its DLLs into your scratch directory (a rebuild cannot then
  replace it under you). Run it with `VOLERY_SECOND=1`, `VOLERY_WALL_DIR` pointing at a fresh
  directory per run and `SKEIN_CONTROL=1`, and set `SKEIN_ID` to the folder's name under
  `%APPDATA%` so the suite finds its `control.json`. Give it a `VOLERY_FLYWAY_HOST` of its own,
  or it joins the flyway as the installed wall. The cost: reference images are written under
  that directory, outside the asset protocol's `$APPDATA/references/**`. A pasted image then
  decodes to the fallback box, and `a pasted image lands under the cursor` fails at `img.w`
  for that reason alone.

Measured that way, three consecutive runs on fresh stores gave the same answer: 81 pass,
11 skip (the `ti` real-input tests), 1 fail, the paste test above.

**It used to say `.scratch/`, and that was not a small difference.** `.scratch/` is shared by
every card on this wall, so the afterAll sweep — deliberately wide, to collect leftovers from
a run that died before its own cleanup — closed whatever *anybody* had open under there and
forgot their territory with it. A suite that cleans up after other people is not cleaning up.
The subtree is the whole fix: every run of this suite has used the same one, so the leftover
sweep keeps working, and nothing outside it is ours to sweep. See "Scratch space" in
`CLAUDE.md` for the `.scratch-<handle>/` convention the rest of the wall works to.

The membership test is `inside(p, root)`, not `p.startsWith(root)`. A prefix match answers yes
to a *sibling* — `.scratch-f3c3f791` starts with `.scratch` — which is exactly the convention
above, so the string form would have swept precisely the directories invented to escape it.
Anything else here that decides "is this path ours" owes the same separator boundary.

`REPO` is derived from `import.meta.dir` rather than written down. It was written down, went
stale the day the checkout moved, and the suite then drove a live app against a tree that did
not exist — `mkdirSync(WALL, { recursive: true })` conjures the missing path without
complaint, so the run got as far as a file-viewer test failing to open a real file, which
reads as the app being broken.

### The lab wall (`src-tauri/tauri.lab.conf.json`)

```powershell
$env:SKEIN_CONTROL="1"; bun run lab              # terminal 1 — an empty second wall
$env:SKEIN_ID="dev.skein.lab"; bun tools/ctl.ts health   # terminal 2
bun tools/ctl.ts open project=... ; bun tools/ctl.ts feed card=1 events:@test/fixtures/bash-undescribed.json
```

Driving the *real* wall is driving real work: `feed` is cheap and harmless, but `open` and
`send` spend money and put an agent with `--dangerously-skip-permissions` in a real repo, and
a crash mid-op leaves the user's own cards behind it. So there is a second instance whose
whole purpose is to have nothing on it.

**One variable does it, because one thing decides everything else.** `identifier` is what
`app_data_dir()` resolves (`lib.rs`), which is where `skein.db` lives (`store.rs`) — *and*
where `control.json` is written. So overriding it to `dev.skein.lab` forks the store, the
control surface and the window frame in a single move; `tauri dev --config` merges rather than
replaces, so the shipped identifier is never touched. `SKEIN_ID` is how `ctl.ts` follows it,
defaulting to `dev.skein.studio` so every existing invocation is unchanged.

Vite gets its own port too (1421, `dev:lab`), since `strictPort` is on and two dev builds
would otherwise race :1420.

**And since 2026-09-07 the lab is not only the polite choice — for one kind of work it is the
only one.** `store::may_migrate` refuses a debug build the studio's own database whenever the
tree carries a schema rung the installed app has not seen, because running it there is what
locked Volery out of its own wall: a card on schema v31 ran `bun run tauri dev`, the rung
landed on 86 real cards, and the installed v30 build then correctly refused a file from the
future on every launch. Recovering meant editing `user_version` by hand.

So the lab is where a migration gets developed, and the recipe when it needs real data is a
file copy rather than a flag:

```powershell
Copy-Item "$env:APPDATA\dev.skein.studio\skein.db" "$env:APPDATA\dev.skein.lab\skein.db"
bun run lab      # migrates the copy, and nothing the installed app will ever open
```

There is no override, which is a decision rather than an omission — an escape hatch gets
reached for under exactly the load that produced the incident, and the whole reason the
refusal can be this blunt is that the lab already exists one command away. What the guard
deliberately still allows is a debug build *opening* the studio when the tree is level with
the installed build, since reading the real wall is most of what a dev build is for; that is
the same judgement `SKEIN_NO_WAKE` makes, one door down.

`test/wall.test.ts` follows the identifier for this reason too — it reads `SKEIN_ID` the way
`ctl.ts` does, because a suite pointed at the studio while driving the lab asserts against a
database no op it sent had touched.

This is stronger isolation than the two quiet flags, and they solve a different problem.
`SKEIN_NO_WAKE` and `SKEIN_NO_SERVERS` make a second instance safe *against the same store* —
read their docstrings, which name this exact pairing. The lab needs neither, because an empty
wall has nothing to rouse and no groups to autostart. Reach for the flags when you need to
look at the **real** wall without it acting; reach for the lab when you need to *drive* one.

What still crosses over, deliberately: the Azure PAT, since `vault.rs` hard-codes
`dev.skein.studio/azdo-pat`, and the signed-in accounts, since Volery holds no credentials of
its own (`accounts.md`). Both are read-only from the lab's point of view, and needing to sign
in again to test a wall would be worse.

The window is not visually branded, because `decorations: false` means the title bar is
`App.svelte` and the header draws its own name. An empty wall plus the control chip is what
tells the two apart.

**An armed wall opens at the back.** `main` is created
`"focus": false`, which is tao's `MARKER_DONT_FOCUS`: its first show is `SW_SHOWNOACTIVATE`.
`window::settle` then asks for the foreground only for the real studio (`set_focus`); a wall
with `SKEIN_CONTROL` set is tucked to the bottom of the z-order *while still hidden*
(`opens_quietly`, `tuck`) so the show finds it there, keyboard untouched. `tauri dev` rebuilds
on every source change, including changes another card on the wall is making, so a lab that
surfaced on each relaunch would be one you stopped starting.

The first cut showed the window, which took the foreground, and then handed it back
(`hand_back`, still there as a backstop). That is the only order Windows permits for *giving*
the foreground away, and it was measured as "z-index 42 of 43" afterwards — but the moment in
between was the bug: a 5ms sampler of the foreground and the z-order (2026-10-08) caught the lab
holding the keyboard for ~2s per launch, over the studio Lyss was working in. **Measure the
transition, not the resting state** — a check taken after the fact cannot see a window that was
in front for two seconds and then went back.

The peek, which is the lab's as much as the studio's, was the other half: an always-on-top
window raised whenever the wall is not focused and something waits, which on a driven wall is
always. `Attention.isDriven` silences the whole ladder while the control surface is armed, as
away mode does; `wall.test.ts` asserts the reading instead and that no peek went up. And the
peek is `"focusable": false` everywhere, since tao honours `"focus": false` for a window's
*first* show only — every later show was `SW_SHOW`, and took the keyboard for a beat.

The show itself stays unconditional, which matters: the comment above `win.show()` is there
because a skipped show is an app with no window and no gesture that asks for one. Gated on
`SKEIN_CONTROL` rather than on the lab identifier, because a wall being driven from outside is
the thing that shouldn't grab focus, whichever store it opened.

**Capturing a driven wall without raising it** is `PrintWindow` with
`PW_RENDERFULLCONTENT`, which reads a window wherever it is in the z-order — *if* it has
painted. Chromium stops painting a fully covered window, so a lab at the bottom gives stale
frames unless it was launched with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows"`.
Never raise it to capture — that is the interruption this section exists to prevent.

`test/fixtures/bash-described.json` and `…-undescribed.json` are the shape to copy for a
`feed` fixture: the same real 97-line Bash call, differing in exactly one field, so feeding
each into a fresh card is a controlled experiment rather than two anecdotes.

