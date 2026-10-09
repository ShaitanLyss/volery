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
**`bun run lab <name> --frozen` now does everything below in one command** — see "Several labs
at once" further down. What follows is why each step is there.

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


### Several labs at once: `bun run lab <name>` (`tools/lab.ts`, `src-tauri/src/lab.rs`)

```powershell
bun run lab a                      # a wall called a: dev.skein.lab.a, its own port, store,
                                   # webview profile and flyway host, control surface on
bun run lab b --frozen --peer a    # a second, serving a vite build, on a's private flyway
bun run lab c --join-installed-wall-flyway   # onto LYSS'S REAL flyway — read trap 3 first
$env:SKEIN_ID="dev.skein.lab.a"; bun tools/ctl.ts health
bun run lab list                   # what is up, on which port, under which host
bun run lab down a                 # stop it and delete both of its folders
bun run lab down --all             # every named lab of yours, and leftovers of dead ones
```

Bare `bun run lab` is the lab exactly as above — `tauri dev`, `dev.skein.lab`, :1421, hot
reload on both sides — with one change: it flies on a key of its own rather than the installed wall's (trap 3 below).

**The name decides everything, and in Rust it is one variable.** `identifier` is compiled into
the binary by `generate_context!`, which is why `tauri dev --config` costs a rebuild per lab
and why two `tauri dev`s on one target directory cannot both run (the second link overwrites an
`.exe` the first is executing). So a named lab is a *frozen copy* of the debug binary, and
`VOLERY_LAB=<name>` makes that copy `dev.skein.lab.<name>` at startup
(`lab.rs::assume`, through `Context::config_mut`, debug builds only). The `%APPDATA%` store,
`control.json`, the browser profile, the webview folder and `claim_wall`'s mutex all follow, so
two processes under one name are refused by the guard that already existed — the launcher never
sets `VOLERY_SECOND`, and a name that does not parse exits rather than falling back to the
compiled-in identifier, which for a copy built by `bun run tauri dev` is the real wall.

The five traps four cards met on 2026-10-08, and what the launcher does about each:

1. **Ports.** Vite is `--strictPort`, and cards negotiated :1421/:1425/:1429 over relay. A name
   hashes into 1430–1499, probes onward past anything answering on either loopback, and the
   chosen port goes in the lab's record.
2. **`WEBVIEW2_USER_DATA_FOLDER`.** Two processes on one webview profile never attach, and say
   nothing. Each identifier has its own `%LOCALAPPDATA%` folder, and the variable names it too.
3. **The flyway.** Every wall on this machine reads one vault, so a lab used to join the
   *installed wall's* flyway on its key — as `COMPUTERNAME` when nobody set
   `VOLERY_FLYWAY_HOST`, a duplicate of the installed wall, and otherwise under whatever lab
   name a card chose. Each became a row on every roster in the flyway for good and its cards
   shadows on Lyss's wall: by 2026-10-09 she had `lab`, `lab2`, `lab-a`, `lab-b`, `mva` and
   `mvb` beside her two real machines. **A lab now flies on a key under its own identifier**,
   `dev.skein.lab.<name>/flyway-key` (the bare lab `dev.skein.lab/flyway-key`), the way its
   store, browser profile and mutex already are — decided in `lab.rs::flyway_for` before the
   builder, held in `flyway::key::OWN_TARGET`. The key *is* the membership boundary
   (`seal.rs`), so that is the whole fix: nothing filters what is drawn, which would leave a lab
   really on her flyway while merely hidden. It also means a lab cannot clear her key, since
   `leave` wipes the lab's own entry. A named lab comes up holding a key: `--peer a` copies
   lab `a`'s (only ever another lab's — `settle_lab` refuses anything not `dev.skein.lab.*`)
   and dials it, otherwise it mints its own. So `bun run lab a; bun run lab b --peer a` is two
   walls on one private flyway with nobody pasting an invite, and `down` deletes the key with
   the folders. It is called `lab-<name>.<machine>` there, the bare lab `lab.<machine>`.
   **`--join-installed-wall-flyway`** (`VOLERY_LAB_ON_INSTALLED_FLYWAY=1`) is the one way onto
   Lyss's real flyway — her roster, her shadows, her sink — for the one test that needs it,
   proving a lab against the installed wall. It is spelled so nobody types it by accident, the
   launcher says so in capitals, and a lab on it may use that key but never start, join or
   leave on it (`key::may_write`). Reuse a name when you do, because the row stays.
4. **The DLLs.** `skein.exe` copied without `onnxruntime`, `sherpa-onnx-*` and `skein_lib.dll`
   exits **53**, which is `0xC0000135 STATUS_DLL_NOT_FOUND` cut to a byte. The copy takes every
   DLL in `target\debug`, and an exit of 53 is translated rather than reported as a number.
5. **The orphan sweep.** `perf.rs::sweep` reaps a process in a card's job whose parent has
   gone. The launcher stays up as the parent of the wall and its vite for the wall's whole
   life, so run it as a *foreground* command — from a card, a background shell call — and never
   behind `&`, `exec` or `Start-Process` from a shell that then exits.

**Where a lab lives, and why not in scratch.** Everything is in the identifier's two folders,
`%APPDATA%\dev.skein.lab.<name>` and `%LOCALAPPDATA%\dev.skein.lab.<name>` (the launcher's own
`lab\` — the binary copy, a frozen `dist`, `vite.log`, `lab.json` — sits inside the second).
Scratch would have put it under `mcp__skein__remove`'s no-click rule, but the identifier's
folder is the one `ctl.ts` and `wall.test.ts` already find through `SKEIN_ID`, and the one the
asset scope `$APPDATA/references/**` covers, so a pasted image loads — under
`VOLERY_WALL_DIR` it did not. `down` is the teardown instead: it deletes those two folders and
refuses any path that is not one of them.

**A live lab is its launcher's.** The record carries the launching card's `SKEIN_CARD` (or
nothing, for a person at a terminal), and `down` refuses a live lab that is somebody else's —
`--all` passes over it, a name asked for refuses, `--force` overrides. Written after the first
cut's `down --all`, run as a harmless check, took another card's lab down mid-demo: every lab
on the machine is in one folder family, so "all" meant everybody's. The record is written
before `cargo build`, not after, so a lab mid-build already counts against the cap and is not a
record-less folder for `--all` to clear. And `down` can take up to half a minute: a dead
wall's `skein.db` stays locked for several seconds after its process is gone.

**The general rule, for any destructive verb on this wall: its default scope is *yours*.**
Several cards share every tree and every per-machine folder, and `--all` reads as "all of
mine" to whoever types it — nobody running it means everybody's. So a verb that can reach
another card's work defaults to the caller's own, passes over the rest with a line saying so,
and makes reaching further an explicit flag. `down` is that shape; anything new that stops,
deletes or resets across a shared resource owes the same.

**The delete itself is `deletable`**, an exact match against the two paths the lab would
have made — never a prefix, because `dev.skein.lab.a` is a prefix of `dev.skein.lab.ab` and
`dev.skein.lab` and `dev.skein.studio` live beside them. `test/lab.test.ts` holds it, and was
checked to fail with a prefix match put in its place.

**At most three at once, the bare lab included** (`MAX_LABS`), and the refusal names the ones
up. Each is a webview and a process tree on a machine that also hosts the cards doing the work.
`cargo build` runs first unless `--no-build`, and refuses while another cargo is running or
with less than 8 GB free; both happened on 2026-10-08.

**What a named lab gives up** is Rust hot reload: the binary is a copy, so a Rust change needs
the lab restarting. That is the point of the copy, not a cost of it.

### Testing in-memory state wants a frozen front end, because other cards keep remounting yours

Found 2026-10-08 by `f8fb825e`, testing a shadow's glass spot — which is session-only and
therefore lives in memory and nowhere else. The test kept coming back with an empty glass and
four shadows correctly in place, which reads exactly like a bug in the feature.

It was not. **Another card edited `App.svelte`**, vite's HMR remounted the app in the lab wall
being driven, and in-memory state went with it. Several cards work in this tree at once, so
any of them touching any file the dev server watches wipes the thing under test at a moment
nothing records.

Two things make it worth a section rather than a footnote:

- **It fails as a wrong answer, not as an error.** Nothing in the lab says "the app you are
  driving was just remounted"; the state is simply gone, so the reading is plausible and
  wrong. The card nearly filed a real bug against its own correct code, and only went looking
  because it checked whether the page had reloaded before believing the result.
- **It cannot happen to an installed build**, which is what makes it a *harness* fault rather
  than a finding. A real wall has no HMR. So a test that only fails under `vite dev` is
  telling you about the harness; prove that before chasing the feature.

**The fix is to freeze the front end**: `vite build` into your own scratch directory and serve
it with `vite preview` on a port of your own, then point the lab at that. The bytes then stop
moving for the length of the test, whoever else is editing. It costs one build and removes a
whole class of false reading. `bun run lab <name> --frozen` is all of that in one step.

This belongs here rather than in the subsystem's own rule because it is about how anything
holding state in memory is tested on a wall several agents share — the glass is simply the
first thing that had any.
