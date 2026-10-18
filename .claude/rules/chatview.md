---
paths:
  - "src/lib/Thread.svelte"
  - "src/lib/HuntBar.svelte"
  - "src/lib/follow.svelte.ts"
  - "src/lib/hunt.svelte.ts"
  - "src/lib/chatview.ts"
  - "src/lib/viewmode.ts"
  - "src/lib/Transcript.svelte"
  - "src/lib/front.svelte.ts"
  - "src/lib/composer.ts"
  - "src/lib/composer.svelte.ts"
  - "src/lib/view.svelte.ts"
  - "src/lib/field.svelte.ts"
  - "src/lib/Dock.svelte"
---

# Chat view: one conversation's column, read in two rooms

Chat view is a second presentation of the same wall — one conversation in front of you, every
other one down the side, a message box at the foot. The design is `docs/chat-mode.md`, the
build order `docs/chat-mode-plan.md`, and the approved pictures `docs/chat-mode/`. This file is
what the building of it learned, in the order it was learned.

The constraint everything below serves: **chat view forks no logic.** It reads the same
`Skein`, sends through the same handles, holds the same queue. So the first phases are
extractions with no visible change — the wall's components hold things that are not about the
wall, and those come out *before* chat view exists, so both views are built on the extraction
rather than one on the other.

### The thread came out of the transcript (phase 1)

`Thread.svelte` is the column: the `one` and `column` snippets, the streaming tail, the live
edge, the empty-sheet line, the fold state and the find. `Transcript.svelte` is what is left —
the panel: rails, reading size, notes, the jobs drawer, the footer, the way back to the end —
and it renders a `Thread` inside its scroller.

- **The thread is `display: contents`.** The scroller is a flex column whose `gap` spaces the
  lines; a wrapper with a box would have collapsed every gap into one. So the thread's root is
  invisible to layout and still something to raise an event on and to look a block up under.
- **It takes a `CardHandle`, not a `Readable` and two callbacks.** History (`card.history()`)
  and opening a file a call named (`card.look`) were props on the panel; a second mount that
  forgot either would draw a card on another wall empty, or a path that goes nowhere — both
  silently. The handle carries both, so there is nothing to forget.
- **The scopes stay the mounter's.** `scopeFiles` and `scopePictures` are ambient and the
  panel sets them (`CLAUDE.md`, *A capability every surface should have is not a prop*). Chat
  view's sheet sets its own. Forgetting fails safe: paths are plain text.
- **Letting go of the tail is an event, `RELEASE`.** A fold worked, a find landing on a match
  and a timeline step revealing its write each say "I chose where to read". The thread raises
  `thread:release` on its root; it bubbles to whatever scroller wears the follow. A callback
  prop would have been one more thing a mounter could omit, and omitting it is the bug
  `panel.md` spends a page on: a fold opened at the foot of a live turn, carried straight past.
  The panel also hears it to re-collect its rails, since the column changed height.
- **The panel's follow is `follow.svelte.ts`'s `Follow`**, worn as `{@attach follow.attach}`.
  Everything `panel.md` argues — only a gesture may let go, `pinned` compared rather than
  trusted, growth heard rather than declared, the carried scroll judged only once it settles —
  moved whole. `stickToTail` stays the answer for a plain scroller; a conversation is not one.
- **The find is `hunt.svelte.ts`'s `Hunting`**, constructed by the thread (the highlights are
  read inside the column and landing opens a fold) and drawn by `HuntBar.svelte` wherever the
  mounter floats it. `Transcript.hunt()` is `thread.finder().open()`.
- **The CSS moved with the markup**, because a component is the only CSS scope this codebase
  has. `test/styles.test.ts` asserts each class the split was about is defined in exactly one
  of the three components, and was checked to fail with a stray `.cap` left behind.

Proved in two frozen labs side by side (`bun run lab chat0` on `HEAD`, `bun run lab chat` on
the change) fed the same long fixture: captures of the panel at the tail, mid-column and with a
fold and its calls open were pixel-identical; a fold opened mid-stream let go of the tail in
both; *to the end* took it up again; a rail click carried the view and a streaming turn did
not drag it back. Not driven: typing into the find field (there is no `fill` op), and a peered
lab's history on open.

### What is in front of you came out of the dock (phase 2b)

`front.svelte.ts`'s `Front` is the queue — each card's front question and its notices, the
held item, the guard for a held item going while you type into it, "more waiting on you" —
constructed once in `App.svelte`. It cannot live in the dock: chat view unmounts the dock, and a
hold the dock owned would be dropped on every switch. `queue.ts` keeps every rule; the dock
draws the held item through local aliases so `test/queue.test.ts`'s markup assertions still hold
on `Dock.svelte`. `Front.of(card)` is for chat view's thread.

A `$derived` class field that reads a private field straight off `this` — `$derived(f(this.#x))`
— is refused by TypeScript as *used before its initialization*, because field initializers run
before the constructor assigns. `$derived.by(() => …)` defers the read and is what to write.

### The composer came out of App (phase 2a)

`onDraftKey`, `send`, `sendText`, `runCommand`, the `!` line's run and completions, and the
dock's caret and stir handlers are `composer.svelte.ts`'s `Composer` now, over `Field`. Its keys
are a table in `composer.ts`, per view, and `test/composer.test.ts` holds it. Four things it had
to take with it, because App held them in places a move would have missed:

- **The mounted field, as a registry.** `composer.input` is whichever field is on screen
  (`bind:el={composer.input}`), and focusing the draft, the caret after a completion and the
  `!` history all reach through it. App's single `prompt` ref was the dock's alone: a key typed
  on the wall under chat view would have focused a textarea that was not there.
- **The stir guard** (`edited`): a second field that stirred without `stirsCard` would bring
  back `/clear` typed into a dormant card resuming the session it was clearing.
- **The field's own rules** — a dismissal that does not outlive its draft, the lit row back to
  the top when the list changes — moved from the dock's effects into `Field`'s constructor.
- **The view.** `composer.reach` and `targets` are the selected card alone in chat view, and
  every send forces broadcast off there, whatever modifier is down.

One fix made on the way rather than frozen: the palette's Escape did not stop propagating, so
the window's handler blurred the field on the same press. `palette-off` stops it now.

Lab (frozen, synthetic keys on the dock's field, no API turn spent — `/model` is answered by the
CLI locally, `/gear` is Volery's, a `!` line is a shell), 14/14: a `!` line runs in the focused
card and lands in its transcript; `/gear planning` reaches the focused card only; Escape
dismisses the palette keeping the text; Enter on a gathering refuses and keeps the draft while
Ctrl+Enter reaches both; Tab steps to the next card; a draft is parked and handed back across a
switch; a key typed on the wall lands in the draft and focuses the field.

### A capture of a lab is DPI-aware or it is cropped

Every card that captures a lab improvises a `PrintWindow` script (sink `90058cb7` counts
eleven). The one trap they share: PowerShell is not DPI-aware, so `GetWindowRect` returns
scaled coordinates while `PrintWindow` draws physical pixels — at 150% the bitmap is two thirds
of the window and the panel is simply not in it. Call `SetProcessDPIAware()` first.
