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
  - "src/lib/ChatView.svelte"
  - "src/lib/Sidebar.svelte"
  - "src/lib/MessageBox.svelte"
  - "src/lib/SlashPalette.svelte"
  - "src/lib/Icon.svelte"
  - "src/lib/icons.ts"
  - "src/lib/NewChat.svelte"
  - "src/lib/PickMenu.svelte"
  - "src/lib/ModelMenu.svelte"
  - "src/lib/GettingReady.svelte"
  - "src/lib/ProjectPage.svelte"
  - "src/lib/Lookup.svelte"
  - "src/lib/Budget.svelte"
  - "src/lib/AccountPop.svelte"
  - "src/lib/starting.ts"
  - "src/lib/starting.svelte.ts"
  - "src/lib/allowance.ts"
  - "src/lib/search.ts"
  - "src/lib/projectview.ts"
  - "src/lib/Toasts.svelte"
  - "src/lib/SidePane.svelte"
  - "src/lib/PlanStrip.svelte"
  - "src/lib/PlanDoc.svelte"
  - "src/lib/others.svelte.ts"
  - "src/lib/Welcome.svelte"
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

### The switch, and the wall that stays mounted offstage (phase 3)

`view.svelte.ts` holds which view the window draws (`localStorage`, `skein.view.v1`), and
`App.svelte::switchView` is the one way to change it — the title bar's switch, Ctrl+Shift+M,
`space w v` and the control surface's `view` op all go through it. Under chat view `App`
draws `ChatView` instead of the wall's header, band, panel and dock; the wall itself stays
mounted with `class:offstage` (`display: none`) and `inert`, so going back is instant and
every card, widget and pane keeps its state. Five obligations come with that, each a bug the
design review found:

- **Nothing reveals a card on it.** Its surface measures 0 wide, so a reveal decides every card
  is off screen, pans and saves the viewport. `Canvas.reveal`, `revealWidget`, `fitAll`,
  `center` and `toCanvas` read the view and do nothing (or answer from the viewport alone).
  Every road into `focusCard` therefore lands harmlessly, and `ring` stops at the focus under
  chat view: the wall's *selection* is a gathering Lyss built and chat view never touches it.
  `openIn`/`openChat` honour the same rule. Canvas imports the holder as `viewing`, because it
  already has a `view` — the viewport.
- **Nothing behind it runs.** `display: none` stops CSS animation and no JavaScript, so the
  canvas gets `ambience={null}`, `Flow`'s and `Lineage`'s frame loops wait on the view, the
  browser widget's screencast is not `seeing`, and the panel is not mounted at all.
- **The chrome is not measured offstage.** `arrange.svelte.ts` keeps the lowest chrome height it
  ever sees per mooring; one frame without the dock would store a height with no dock in it for
  good, so `onchrome` is ignored under chat view.
- **The keys that act on the wall are guarded** — `chatKey` in App: Tab is focus traversal,
  Home is the top of the thread, the wall's undo and Delete are inert, Escape stops a turn and
  goes no further, Ctrl+Tab walks the *sidebar*, Alt+↓ is the next that needs you. Leader
  chords that arrange the wall (`leader.ts::actsOnWall`) switch to it and then run, because
  the chord says you want the wall.
- **Nothing pastes or drops onto it.** `onPaste` returns under chat view (a paste into the
  message box is `PromptBox`'s and never reaches it), and a drop on anything but an input
  opens a folder as a conversation and says where else a file goes — never pins.

The composer's reach is the selected card alone under chat view, with broadcast forced off;
the lab proved a Ctrl+Enter there reaches the selected card and not the gathered one.

**The thread is restyled by custom properties, never by reaching in.** Your own line is a
bubble on the right through `--you-align`, `--you-fill`, `--you-radius`, `--you-rule`,
`--you-edge`, the `--you-pad-*` four, `--you-face` and `--you-size` — each defaulting to exactly
what the panel draws, so the panel did not move a pixel. The agent's prose takes the reading
colour through `--tx-prose`, as a reading theme already does.

**The palette is one component** (`SlashPalette.svelte`), lifted out of the dock so chat view's
message box draws the same rows; the composer carries out what a row does. `PromptBox` gained
`--pb-font`, because you write in the UI's face and the agent answers in the book's (§8.3).

**The tokens are declared once, consumed, and never read bare.** `--cv-*`, `--dur-*` and
`--ease-*` live in `tokens.css` (with the light-ground relationships under
`:root[data-ground="light"]`), and `test/chattokens.test.ts` asserts each is declared, drawn
with somewhere, and read with a fallback — what `theme.test.ts` asserts of the reading knobs,
which it never saw. A token a later phase draws is declared with that phase, not ahead.
`test/palette.test.ts` holds the `--ch-*` reads in `tokens.css` to the same standard.

A restored card had no clock for the sidebar's day groups — `restingSince` is this session's.
`store.rs::LAST_ACTIVE` reads its newest turn (or its birth) into `lastActive` at load: an
expression, not a column, so no rung. `Conversation.turnSince` stamps when a turn opens, for a
working row's age and so *working* does not reshuffle each time a card speaks.

### An agent's life in the thread (phase 4)

**Its question is the last thing in its thread**, `Ask.svelte` itself with `--ask-ceiling:
none`, so the column scrolls rather than the sheet capping. The keys a question answers to —
a number picks, ← → between questions, the options a single-select listbox — are in
`Ask.svelte` and `asking.ts::askKey`, not in chat view, so the dock has them too. One drawing,
two places.

**Arrivals are toasts and nothing takes the focus.** `Toasts.svelte` reads `front.svelte.ts`
— the same queue the dock draws — for what arrived while the window is in front: two at most
and *and N more*, a question's toast answers by selecting its conversation. A row rising in
the sidebar is the other half of the same news.

**Reading a finished conversation settles it, and only reading.** `chatview.ts::settles` is
four conditions: selected, window in front, not away, the last message on screen for
`DWELL_MS`. Every shortcut round one was a bug the review found — Ctrl+Tab skimming past, the
selection a view switch lands on, the card selected after a close, a launch with nobody at the
keyboard — each would have acknowledged rests nobody read and taken them out of the away pile.
A turn that ended on a question is never settled by reading: it stays in *needs you* until it
is answered or dismissed. The dwell is an `IntersectionObserver` on the last `.line`, so it
measures what is on screen and not what is selected.

**A queued message says so.** A prompt sent mid-turn is `awaited` until the CLI takes it up
(CLAUDE.md, *Settling a line is not claiming it*), so the bubble reads *queued — it goes when
this turn finishes*, with *send now* as `do("stop")` and nothing else: the CLI does not lose a
queued prompt on an interrupt, and stopping then sending would deliver it twice.

**A line keeps when it happened.** `Line.at` and `ToolResult.at` are stamped live and read off
each session record's `timestamp` in `history.ts`. `transcript.ts::runSummary` folds a run by
tool — files counted once, edits by file, *ran the tests* when a shell line names them, a diff
stat off the arguments the model wrote — and `Thread` reads `view.current` to draw it in chat
view while the panel keeps `foldSummary`. A plan written is *wrote the plan*, not an edit: nothing
in the project has changed yet. Under a second says no time at all.

**Relations reach through `others.svelte.ts`, which only chat view provides.** A spawn's
linked card stands where the call stands, its child read off the receipt's handle
(`spawnedHandle`; kin knows *that* a card has children, not which call opened each). A relay is
a message from its sender with their name openable, never your bubble. Ambient with no default,
by CLAUDE.md's *a capability every surface should have is not a prop*: the wall's panel provides
nothing and so draws neither, which is the point — on the wall a child is a limb.

**The plan strip and the pane read `timeline.ts`; nothing decides a plan here.** The strip
flourishes once on completion (≤ 650ms, opacity and transform) and leaves the document; the
pane (Ctrl+., `view.pane`, closed by default) reads the files through `Skein.trail` only while
its tab is open, once a turn — never on a delta — and says *could not be read* rather than
drawing an empty list that reads as *none*. A finished plan is `PlanDoc.svelte` at the thread's
end; *build it here* takes it down itself once the go-ahead is sent, because a plan written by
a card already out of plan first has no gear change to clear it.

**The offstage wall is measured, not argued.** `snapshot.dom.running` counts running
animations and those inside `.wall`. With the wall offstage the second is 0, and chat view at
rest is 0.00% GPU 3D where the wall at rest is 54% (its ambience). Chat view's own status
animations while cards work hold the present rate up (~20% for three working cards): any
infinite animation does, whatever it moves, which `motion.md` explains.

### Starting things (phase 5)

**The empty sheet is the new conversation.** Ctrl+Shift+O and *new conversation* clear the
selection (`App.newConversation`), and `NewChat.svelte` is what the sheet draws with nothing
selected. Nothing is spawned until the first send — a conversation nobody has written to is
not a process. The draft is the window's one `Field`, so what is typed there survives reading
another conversation and coming back.

- **The first send takes the draft out before it opens the card.** `Starter.start` opens
  through App's `openIn`/`openChat` (one `spawning` latch), then hands the draft to the
  composer — the one send path, so pictures, naming and the stir guard are what they always
  are. But opening moves the focus, and the focus moving is where `drafts.ts::switchTo` parks
  the field under the bucket it was holding (the empty sheet's) and hands the new card its own
  empty one. So the field is emptied first and the draft put back after a `tick`, and a card
  that fails to open gives the words back.
- **The place is a choice with a default, never a mode** (§2.1). `starting.ts::startingPlace`:
  the last place started from, then the most recently used project of *this* wall (a card on
  another wall belongs to that wall's folder of the same name), then *just chat* — a
  newcomer's first launch. A picked folder (*open a folder…*, Ctrl+O) is a place, not yet a
  project: nothing opens until the send, and after it the folder is remembered as the project
  `ensure_project` made it. `localStorage` (`skein.start.v1`), per machine, like the view.
- **The chat home is a territory and no project.** It is how "no project" has an address
  (`store::chat_home`); the sidebar counted it as a project called *chat* until phase 5
  filtered it out, and the place menu never offers it.

**Readiness asks the CLI, and a signed-out default is not signed out.** `claude_auth` runs
`claude auth status --json` in Volery's own environment — the one an unmanaged card inherits.
`tools/probe-auth.ts` measured it (claude 2.1.288): ~1s a spawn, so it is asked when the empty
state draws and on *look again*, never on a timer; signed out exits **1** with a good record, so
the exit code is not the answer. And on Lyss's machine the default credential *is* signed out —
every sign-in is a managed account — so `readiness` reads any usable account as ready first.
*Sign in to Claude* signs into a managed account (the first registered, or `claude`), because
`signin.rs` writes only into a store and an account is what the waterfall already spawns on.
Claude Code not found shows the PowerShell line and runs nothing.

**The model menu is the wall's five presets, one scale.** For a new conversation it is the
preset the card opens with (`Skein.openChat` now carries `open`'s three states, so a chat card
stops opening on whatever Claude Code was configured for). For an open one it sends `/model`,
and `/effort` after it only where the family's automatic level differs: `Skein.send` already
follows a `/model` with `effortForModel`'s level, and sending the same one again drew the line
and its answer twice (`starting.ts::switchLines`). *As claude code is set up* is not offered on
an open card — a conversation cannot be told to forget a model.

**A project's page, and what it does not offer.** `ProjectPage.svelte` over
`projectview.ts`, which reads `chatview.ts::groups` so the page and the sidebar cannot disagree
about *needs you*. Instructions and read only write the project row (`setProjectGuidance`,
`setProjectReadOnly`) and the page says a running card hears them at its next start. There is
no *open in your editor*: nothing on the wall opens a folder in an editor today, and a row that
does nothing is worse than no row. Dev servers are the project's groups, if it has any.

**Ctrl+K is one ranked list** (`search.ts`, drawn by `Lookup.svelte`). Conversations and
projects are offered only when `chatview.ts::matches` says so — the sidebar's own rule — and a
chord typed as its keys (`vv`, `space v v`) comes first, so the palette is where a forgotten
chord is looked up in both directions. A chord that arranges the wall switches to it first, as
the leader does. **The component is not `Palette.svelte`**: `palette.svelte.ts` (the skins) is
the same file on a case-insensitive disk, and `import "./palette.svelte"` resolved to the
component and broke every build in the tree for a few minutes. Check a new name against
`ls src/lib` case-insensitively, and an import without an extension against every extension
the resolver tries (`projectview.ts`, not `projectpage.ts`, beside `ProjectPage.svelte`).

**The allowance is read where it is spent.** The conversation's managed account (or the one the
waterfall would put it on), else this machine's own reading — the ledger's, asked only while
chat view is up and nothing is managed. `allowance.ts` words it: the foot's *max · 47% of this
session*, the running-low line at `limits.ts`'s warm, the banner while the waterfall holds. The
banner's *take it back* is `do("stop")`, which drops the whole hold back into the box (there is
no per-message take-back). An unmanaged install has no hold at all — `#managing` is false and a
spent default credential answers the send with the CLI's own error — so the banner is a managed
wall's; that is today's model, not chat view's to change.

**Testing an allowance without spending one** is the `allowance` control op:
`Waterfall.standIn` replaces the registry and readings and holds the beat off; `Ledger.standIn`
does the same for this machine's reading. The reading is rung one; the hold it causes is the
app's own path from the send onward. Keep every stood-in account spent — one the chooser would
*use* is moved onto, and a stood-in label has no credential store.

Lab (frozen, `bun run lab chat5`), 40/40 — see `dfcc9b4` for the list. One real Haiku turn,
everything else synthetic keys and the app's own ops. The signed-out arm, 5/5, ran in a second
launch with `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at an empty directory, since **a lab
inherits the launching shell's credential** — launched from a card on a managed account, every
lab card is signed in, and the signed-out state cannot be reached without that.

### The first launch and the finish (phase 6)

**The welcome is asked of `opening`, once two things have answered.** The store (`skein.loaded`)
and the control surface (`control.asked`): before the first, *never held a conversation* and
*not read yet* are one reading and an existing wall would see the question flash; before the
second, a lab is undriven for the moment its endpoint takes to arrive. Its choice is stored
whichever way it goes, and `view.stored` is reactive so storing it is what takes the screen
down. Enter is handled by the welcome itself off `document.activeElement` — a synthetic key
does not click a focused button, and with nothing chosen Enter must do nothing.

**Narrow is decided by width in the view, and by media query everywhere else.** ChatView reads
the window width for the two things that change behaviour — the sidebar becomes a drawer, the
pane a sheet — and Ctrl+Shift+S asks the view (`toggleSidebar`) rather than flipping
`view.sidebar`, which a drawer does not use. Everything that only changes how it looks (the
strip's step, the chip's family, the hint line, stacked options) is a `max-width` query in its
own file, since it has nothing to decide.

**An endless animation answers to all four motion readings, and a test says so.** `spare`
steps it, `still` and reduced motion stop it; `styles.test.ts` reads every chat-view component
and fails one that forgot an arm. **And a screen reader hears the paragraph, not the token**:
the polite region announces each answer as it settles and *finished* at the turn's end, only
for the conversation in front of you, and never on merely selecting one.

### A capture of a lab is DPI-aware or it is cropped

Every card that captures a lab improvises a `PrintWindow` script (sink `90058cb7` counts
eleven). The one trap they share: PowerShell is not DPI-aware, so `GetWindowRect` returns
scaled coordinates while `PrintWindow` draws physical pixels — at 150% the bitmap is two thirds
of the window and the panel is simply not in it. Call `SetProcessDPIAware()` first.
