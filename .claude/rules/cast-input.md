---
paths:
  - "src-tauri/src/cast/drive.rs"
  - "src-tauri/src/cast/inject.rs"
  - "src/lib/castinput.ts"
  - "src-tauri/examples/drive-probe.rs"
---

# Screens on the wall: the input half

`docs/SCREENS.md` is the contract and `cast.md` the rest of the subsystem; this is why the
input is shaped as it is. Three pieces: `castinput.ts` (a DOM event → the wire's bytes, pure),
`inject.rs` (a far viewer's events → `SendInput` on the host), `drive.rs` (this laptop driven
through its *own* tile, with Volery staying in front). `examples/drive-probe.rs` is the
measurement every number below comes from, and its header keeps them.

## A far machine: inject.rs

- **A stuck key is the worst failure.** Nobody may be at the far machine, and a held Ctrl turns
  every later click into something else. Each `Driver` (one per viewer session) remembers what
  it pressed; `ReleaseAll` and dropping the `Driver` lift exactly that, and an up for something
  this viewer does not hold is dropped rather than lifting a key somebody else is holding.
- **Scancodes**, so the *host's* layout decides what a key types. Lyss's machines are AZERTY: the
  key a US board calls Q types A there. That is Parsec's behaviour and right, since the host's
  shortcuts are laid out for its layout. Pause, NumLock and PrintScreen go as virtual keys,
  because their set-1 codes do not survive a scancode `SendInput` the same way everywhere.
- **What cannot be reached is said.** UIPI drops input into an elevated window without a word,
  and the secure desktop takes none; `Driver::reach()` names both for the tile. The SYSTEM
  helper Lyss agreed to as a later stage would host injection behind the same `Driver`, and
  these are the two states it lifts.
- **Every `SendInput` here carries a mark** in `dwExtraInfo` (`MARK`, and `MARK_LAST` for the
  final move of a drive click), so the keyboard hook can tell Volery's own input from a
  person's. **Only the low 32 bits survive**: a sequence number packed above the mark never
  reached the hook (below).

## This laptop: drive.rs

Windows has one cursor and one foreground window, and Volery covers the app a local tile shows.
What works, measured on a lab wall against Edge (WebView2 156, 240 Hz panel at 150%):

- **Volery topmost, wearing `WS_EX_TRANSPARENT` and `WS_EX_NOACTIVATE` while driving.**
  - Topmost keeps it drawn over the app that has the foreground.
  - **Transparent alone is the occlusion fix, not click-through.** A Chromium window — Edge,
    Chrome, every Electron app — under a plain topmost Volery is marked hidden and paints
    nothing (0 rAF/s), so the tile freezes while you type into it. With the style: 240. Volery
    still takes its own clicks. Reading this took four runs, because Chromium only recomputes
    occlusion on its own window moving or a foreground change, never on another process's
    style: nudge the *Chromium* window to make it look again.
  - **No-activate is the tile click not stealing the foreground back.** Without it every click on
    the tile blurred the app (7 in 8). The style can be set from any thread, where answering
    `WM_MOUSEACTIVATE` would need a subclass installed on the main one.
- **A click is one instant of click-through.** `WS_EX_LAYERED` joins `WS_EX_TRANSPARENT` (the
  pair is what passes a click), then one `SendInput` batch of [move to P, down, up, move back],
  then a wait until the click has been delivered, then layered comes off. No composed frame
  changed while doing it.
- **That wait is the dangerous part, and it was got wrong twice.** While Volery is
  click-through, a *real* click on the tile falls through it onto whatever is underneath.
  - Waiting for the cursor to come back confused "back" with "not moved yet" and closed up early:
    the injected click then landed on Volery, 7 of 10.
  - Its replacement put a sequence number in `dwExtraInfo`'s high half for a low-level mouse hook
    to watch for. The hook never saw it, so every click held Volery open for the full timeout —
    and the test's next tile click went through onto Lyss's installed wall, or the game she had
    open. A guard in the probe caught it; the unguarded runs before it had not.
  - Now the final move carries `MARK_LAST`, the hook counts it, and the bound is 60 ms
    (`os::SETTLE`): closing too early costs one missed click, holding too long sends a real one
    somewhere nobody aimed. `drive::settles()` counts confirmed against given-up; on the last
    run 30 confirmed, 0 given up, 27 landed. The 3 misses all followed a test click on the tile,
    most likely the lab's webview still holding capture from it — which cannot race in the app,
    where the drive click is sent after the tile's own pointer-up. Unverified.
- **A drive that ends mid-click restores twice.** The click's closing-up can run after the
  restore and put the drive's styles back on; `Drive::finish` joins the worker and restores
  again. A run that skipped this left a lab wearing `TRANSPARENT|NOACTIVATE` for good.
- **A press is replayed when it ends**, as a click or as a drag along its path (thinned to 24
  points), because the physical button is on Volery's window. Double clicks work; hover and
  press-and-hold do not.
- **The wheel moves no cursor**: a `WM_MOUSEWHEEL` sent to the window under P with Volery let
  through for the millisecond it takes. To the deepest window, as Windows' own "scroll inactive
  windows" does — except Chromium's inner `Chrome_RenderWidgetHostHWND`, which hands it to its
  frame *and* lets it travel on, so one notch scrolled twice (200 px against 100); there it goes
  to the frame.
- **Keys are not sent at all.** The app has the foreground, so the physical keyboard reaches it
  natively, IME and dead keys included.

### Escape, held

Lyss's way out of every screen is Escape held 500 ms (`cast.md`, Driving). In local drive
Volery never sees the key — the app has the keyboard — so a `WH_KEYBOARD_LL` hook (`Hold`) is in
for exactly as long as the drive: a hold lets go and puts Volery back in front, a tap is
replayed (marked, so the hook lets it pass), and the tile is told `{"t":"hold","phase":…}` to
draw the ring it cannot hear. The callback only decides and queues: Windows removes a slow
low-level hook without saying so. The same hook in `Keys::Capture` is a focused remote screen
taking Win, Alt+Tab, Alt+F4 and Ctrl+Esc off this machine, and only while Volery is in front.

### Known, accepted

- **The driven app's popups open over Volery on the real desktop.** Context menus and dropdowns
  are topmost windows of their own and land above a topmost Volery at the app's real position,
  not inside the tile. Accepted 2026-10-31 for ordinary apps.
- **The cursor blinks at the target for each click** — away from the tile ~24 ms median
  (16–46), a few frames at 240 Hz. Cosmetic, accepted the same day.
- **Drag-select is unreliable**: it selected in two runs and not in the last.

## Testing with real input on Lyss's machine

**A real-input test can land on her live wall, and once did.** A run had the test Edge open
behind the installed wall instead of in front of it; every "click through the lab" landed on
her wall, `hello` and Enter were typed into her composer (which sent it to the card running
the test), and an Escape stopped that card. So `drive-probe` now:

- refuses any click unless the window it lands on is one of the test's own (`aim_direct`,
  `aim_through`), and any keystroke unless the foreground is (`aim_keys`); a refusal ends the
  run and puts everything back, and says which windows held the point;
- **never sends Escape** — on her wall it stops whichever card is selected;
- raises the test window to the top of the ordinary windows and *not* topmost: left topmost, the
  first click that activated it rose above the lab, which no real app can do;
- scrubs a lab of leftover drive styles on the way in, and is run against a lab that has had
  time to settle — a lab sends itself to the bottom once its page is ready (`window.rs`,
  `hand_back`), which can be after the launcher says it is up.

Ask before every run that injects, say how long, and never overlap with another card's
real-input test — they share one cursor.
