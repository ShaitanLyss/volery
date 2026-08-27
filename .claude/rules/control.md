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

`test/wall.test.ts` only ever creates conversations under `.scratch/`, and closes them in
`afterAll`. Keep it that way, so running it cannot disturb real work on the wall.

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

**An armed wall opens at the back.** `window::settle` reads who holds the foreground *before*
it shows, and when `SKEIN_CONTROL` is set it hands the keyboard straight back and drops the
window to the bottom of the z-order (`opens_quietly`, `hand_back`). It still opens, at full
size, un-minimised, where it was placed — it just does not interrupt what you were typing
into. `tauri dev` rebuilds on every source change, including changes another card on the wall
is making, so a lab instance that grabbed focus each time would be one you stopped starting.

The show itself stays unconditional, which matters: the comment above `win.show()` is there
because a skipped show is an app with no window and no gesture that asks for one. So this is
a *return* of the foreground after taking it, not a refusal to take it — which is also the
only order Windows permits, since a process may only give the foreground away while it holds
it. Measured on the lab: z-index 42 of 43, `iconic=False`, foreground still on the real
studio. Gated on `SKEIN_CONTROL` rather than on the lab identifier, because a wall being
driven from outside is the thing that shouldn't grab focus, whichever store it opened.

`test/fixtures/bash-described.json` and `…-undescribed.json` are the shape to copy for a
`feed` fixture: the same real 97-line Bash call, differing in exactly one field, so feeding
each into a fresh card is a controlled experiment rather than two anecdotes.

