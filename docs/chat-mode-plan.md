# Chat view: the build plan

The design is `docs/chat-mode.md`; this is the order to build it in. Every phase below is a unit
that stands up on its own: it passes `bun run check` and the suites it touches, it is driven in a
lab before it is committed, and it leaves the wall exactly as it was for anybody who never opens
chat view.

**The sequence is the safety.** Phases 1 and 2 are refactors with no visible change, proved by
the wall behaving identically before and after. Chat view itself lands in phase 3 behind a switch
only Lyss will press, is first *released* with phase 4 — a chat view without questions in it is not
one to live in — and reaches a new install only in phase 6. If any phase stops, what has landed is
still a better-factored wall.

The design was red-teamed on 2026-10-18 before any of this was written; its findings are folded
into the spec, and the ones that change what a phase must do are said in that phase below.

## Driving it, every phase

- **The lab, frozen.** `bun run lab chat --frozen` — its own store, port and webview profile, a
  vite build that another card's edit cannot remount mid-test (`control.md`, *Testing in-memory
  state wants a frozen front end*). Drive it with `bun tools/ctl.ts` as `wall.test.ts` does, and
  say which rung each claim needs (`control.md`: one event, the whole gesture, a real gesture).
  Where an op is missing, add one through the app's own seam, never into a component.
- **Seeded cards, without spending turns where an op exists.** Cards in each state come from the
  existing `feed` fixtures (`test/fixtures/bash-described.json` is the shape). A question with
  previews is the `ask` op, which injects a full payload; a real round trip through the parking
  machinery is a `POST tools/call` to `/mcp/<id>`, which costs nothing. Lineage is the `kin` op —
  a real spawn once woke an Opus parent for $0.52 and closed its children (sink `ced09c6f`). Real
  turns, pinned to Haiku, only where no op reaches.
- **Which rung.** Anything about what a keystroke *types* is only provable with `real.key`, which
  needs `SKEIN_CONTROL_INPUT=1` and borrows the real keyboard — run those steps when Lyss lends it,
  and say in the commit which steps ran at which rung. The `key` op aims at the first textarea in
  the document; it gains a target before phase 3 puts a second composer on screen.
- **Pictures of what it drew.** Capture the lab without raising it (`control.md`: `PrintWindow`
  with `PW_RENDERFULLCONTENT`, and the occlusion flags at launch). There is no shared op for this
  yet — sink `90058cb7`, which five cards have now improvised — so landing that op first saves
  every phase below a script.
- **The Volery browser, for parity.** Open the approved mockup (`docs/chat-mode/*.html`) beside
  the lab capture and compare. The mockups are the spec's pictures; where the build differs, either
  the build is wrong or the spec gets a line saying why.
- **The wall's own regression.** Every phase re-runs `bun run test:wall` against the lab, and
  phases 1–3 also compare captures of the wall's panel and dock before and after.

Sizes: **S** under ~300 lines changed, **M** under ~800, **L** more (moves counted).

---

## Phase 0 · the leader from an empty field — S

**Done** (`621506f`). Lab 8/8 at the synthetic-key rung; the real-key rung not run.

Lyss, 2026-10-18: *"leader chords should work even when in a text field when it's empty and I do
a space bar."* Sink `3cd4359c`. Independent of everything else here and useful on the wall today,
so it ships first.

- **Files.** `src/App.svelte` (`onGlobalKey`'s leader gate, ~3986, and `isTyping`, ~4208);
  `src/lib/leader.ts` (a pure `mayLead(target, key, composing)`); `test/leader.test.ts`.
- **What.** Space starts the leader outside a text field *or* in an empty one, never during IME
  composition; the Space is swallowed; a key completing no chord falls through into the field.
- **Lab.** With the dock's empty field focused, `space v v` opens the themes panel — the synthetic
  `key` op proves the gate; that `hello` still types, that `space` then `q` leaves `q`, and that a
  field with text in it types a space need `real.key`.
- **Risks.** `onDraftKey` runs on the textarea before the window hears the key — confirm it does
  not consume Space. The which-key hint must draw over the dock, not under it.

## Coordinate first: the drop and prompt-input work

Two pieces of work in flight touch the same files as phase 2 and are prerequisites of phase 3's
message box:

- **One drop path** (sink `3c795b1f`, held by card `6667f757`): replaces `dropTargetAt`'s
  class-name hit test (`dropTargetAt`, `App.svelte:1359`). Chat view's sheet declares itself a target through
  whatever that primitive asks for.
- **Every agent-bound input supports attachments** (sink `fd7ef025`, card `a691b302` building
  it, design approved by `34b07397`): a per-draft `Draft` in `attach.svelte.ts` and
  `PromptBox.svelte` over it, registered as a drop target through `data-attach`. The composer sits
  *above* it and uses it (spec §7.3); a question's and a notice's fields mount `PromptBox` without
  the composer. **Phase 2a starts after `a691b302`'s third commit** (`Draft` and `PromptBox`), so
  the dock's field is reshaped once, by that work, and the extraction moves keys and commands
  around a field that already has its final form.

Before phase 2 starts, plan-check with card `34b07397`, and post a billboard notice over
`src/App.svelte`, `src/lib/Dock.svelte` and `src/lib/field.svelte.ts` for the duration.

---

## Phase 1 · the thread comes out of the transcript — M

**Done** (`3213bb0`, plus `6720d5a` for a bug it uncovered: `.line.you:first-child` had matched
every prompt since the `.blk` wrapper, so `--tx-round` never drew). Deviations: `Thread` takes a
`CardHandle` rather than a `Readable` and two callbacks (history and file links ride on the
handle, so no mounter can forget them), and `Transcript` takes `card` too; the find bar is
`HuntBar.svelte` over a `Hunting` class the thread owns. Two labs side by side, panel captures
pixel-identical; typing into the find field and a peered lab's history were not driven.

No visible change.

- **Files.** New `src/lib/Thread.svelte`: the `one` and `column` snippets (`Transcript.svelte`
  1162–1368), the streaming tail, the fold state (`open`, `shut`, kept local — *a fresh view of a
  card is a fresh view*), the find state (`lit`, `here`, `sought`, `carry`, `reveal`, exposed as
  `hunt()` and `reveal()`), and the history effect (`card.history()` on `historyMark`). New: the
  panel's follow — `following`, `pinned`, `gesturedAt`, the release when a fold opens — as one
  attachment beside `follow.ts`, which `Transcript.svelte` uses and chat view will. The message CSS
  moves into `Thread.svelte`'s `<style>`; `--you-align`, `--you-fill`, `--you-radius` are declared
  with the panel's current values so nothing changes.
- **Tests.** `transcript`, `hunt`, `follow`, `outline`, `copy`, `styles` (scoping) and `finding`
  (no file-scope prop crept back) stay green. A new assertion in `test/styles.test.ts` that the
  moved selectors exist in exactly one component.
- **Lab.** A card fed a long fixture: captures of the panel before and after are identical; a fold
  opens and closes, and opening one at the foot of a streaming turn releases the tail as it does
  today; Ctrl+F finds and steps through folded matches; both rails list and jump; a picture and a
  mermaid fence draw; a streamed turn is followed to the bottom and stops being followed when
  scrolled up; a card on a peered lab's wall shows its history when the panel opens on it.
- **Risks.** The rails read `data-nav` from the DOM — still inside the same scroller, but check. The
  release-on-unfold is the follow behaviour most likely to be lost in the move (`panel.md`). CSS
  specificity can shift when rules move components; the before/after capture is what catches it.

## Phase 2a · the composer comes out of App — L

**Done** (`6cd407e`), after 2b. Lab 14/14; the `/clear`-into-a-dormant-card resume was not driven.

No visible change.

- **Depends on** `a691b302`'s `Draft` + `PromptBox` commit having landed (above).
- **Files.** New `src/lib/composer.svelte.ts` (from `App.svelte`: `onDraftKey`'s body, `send`,
  `sendText`, `runCommand`, `runBang`, `completeName`, `takeCompletion`, `typeIntoDraft`,
  `reach`) and its pure half `src/lib/composer.ts` (the key table, per view). Paste and drop are
  already `PromptBox`'s by then and stay there. `Dock.svelte` calls the controller instead of
  App's functions and keeps drawing its field with `PromptBox`. `App.svelte` constructs the
  controller beside `Field` and `Drafts`.
- **What it must take with it**, which the first draft missed (spec §7.3): a registry of the
  mounted input in place of App's single `prompt` ref (paste, `typeIntoDraft`, `takeCompletion`,
  `completeName`, `askCompletion`, the `!` history and `focusDraft` all reach for it); the caret
  mirror; the stir guard from the dock's `edited()`; and the field rules from the dock's effects
  (prune untokened pictures, clear stale dismissals, reset `field.at`), which move into `Field`.
- **Tests.** New `test/composer.test.ts` (the key table: Enter, Ctrl+Enter, Tab, Shift+Tab,
  Escape, the palette keys, `!` lines — for the wall view, matching today except for one fix: the
  palette's Escape stops propagating, so it no longer also blurs the field). Add it to the `test`
  script. `commands`, `bang`, `attach`, `drafts`, `holding` stay green.
- **Lab.** Send to one card; Ctrl+Enter to a gathering of two; Enter on a gathering refuses and
  flashes Ctrl ↵; `/gear planning` runs (`gears.md`'s three bugs stay fixed); `/model` and the
  automatic `/effort`; a `!` line runs and Ctrl+Enter tells the agent; a pasted picture becomes a
  chip at the caret; a draft survives switching cards and a restart; Tab walks the cards; `/clear`
  typed into a dormant card does not resume the session it is clearing.
- **Risks.** `onDraftKey` and `onGlobalKey` share every key and are read against each other
  (`CLAUDE.md`); moving one means re-reading both. The hand-back path (`onHandBack`) must keep
  restoring pictures as chips. Another card editing `App.svelte` at the same time — hence the
  billboard notice.

## Phase 2b · what is in front of you comes out of the dock — M

**Done** (`22c2d6e`), before 2a — it did not need the composer, and the attachments work was
still holding App. `Front` is constructed in App, since chat view unmounts the dock. Lab 9/9.

No visible change.

- **Files.** New `src/lib/front.svelte.ts` (`Dock.svelte` 155–289: items from `cards.asking` and
  `cards.noticing`, the hold, `guardSwap`, `guardEnter`, `more`). `settleHold`, `queueOrder` and
  `nextItem` stay in `queue.ts`, which `test/finding.test.ts` reads. `Ask.svelte` and
  `Notice.svelte` read `--ask-ceiling` (default `min(52cqh, 30rem)`, today's value).
- **Tests.** `test/queue.test.ts`'s markup assertions stay on `Dock.svelte` (markup cannot move into
  a `.svelte.ts` module); the `$derived(ask.askId)` assertion is about `Ask.svelte` and is
  untouched. The module gets ordinary tests. Check every moved guard *fails* by putting the old
  shape back by hand (`CLAUDE.md`).
- **Lab.** A question in the dock; a notice arriving while you type a reply to another does not
  displace it; *N more waiting* steps through both walls' items; Alt+D defers; the away pile still
  draws `Ask` through `Vigil`.
- **Risks.** The hold is the dock's most-defended behaviour (`ask.md`). Nothing about its rules
  changes; only where they live.

## Phase 3 · the switch, and chat view's skeleton — L

**Done.** Lab 20/20: the view op switches; the sidebar's groups in §5.1's order; Ctrl+Tab,
Alt+↓ and a row click leave the viewport and the wall's gathering exactly as they were; a
Ctrl+Enter from chat view reaches the selected card and not the gathered one; a picture pasted
into the message box is a chip and nothing is pinned; back on the wall the viewport, the
gathering and the focus are as left. Additions the plan did not name: `SlashPalette.svelte`
(the palette lifted out of the dock so both fields draw it), `Icon.svelte`/`icons.ts` (the
mockups' sprite as data, no `{@html}`), `Cards.all`, `store.rs::LAST_ACTIVE` and
`Conversation.turnSince` (the sidebar's clocks), `--pb-font` on `PromptBox`, the `--you-*`
knobs on the thread, `leader.ts::actsOnWall` and `space w v`, the menu's `view` field. The GPU
measurement was made in phase 4 (`41b6f03`): with nothing working, chat view in front is 0
animations and 0.00% GPU 3D while the wall in front is 54% (its ambience); with three cards
mid-turn nothing animates inside the offstage wall. So offstage is measured equal to unmounted,
and no unmounted build was needed to show it. The `key` op's target was never wanted: the op
already takes a selector, which the labs use.

The first visible phase. Reachable only by the switch, Ctrl+Shift+M or `space w v`; an install with
no stored choice still opens on the wall, and no first-launch screen exists yet. It lands on `main`
and is **not released on its own**: without questions, toasts and notices (phase 4) it is not a view
anyone should live in.

- **Prerequisites.** `a691b302`'s `PromptBox`, and the routing (spec §6.5): `dropTargetAt` and
  `onPaste` recognise inputs by `data-attach` and chat view's thread and ground by `data-drop`, and
  nothing pastes or drops onto the wall's pins while chat view is up. Without this, a picture pasted
  into chat view's message box is pinned to the hidden wall and the prompt goes without it.
- **Files.**
  - Pure: `src/lib/viewmode.ts` (spec §7.7's rule, minus the first-launch arm until phase 6),
    `src/lib/chatview.ts` (sidebar groups, `queueOrder(items, null)` kept stable, subtitles, day
    buckets, the title/project/last-words match, the next selection after a close).
  - Runes: `src/lib/view.svelte.ts` (the holder, `localStorage` `skein.view.v1`).
  - Components: `ChatView.svelte`, `Sidebar.svelte`, `MessageBox.svelte` (a view over the
    composer, its field a `PromptBox`), using `Thread.svelte` and `Cards`/`CardHandle` throughout,
    with `can()` before every verb only this wall's cards have.
  - `App.svelte`: the branch (spec §7.5) — the wall offstage by a class, not `hidden`; the dock
    unmounted; the five obligations: nothing reveals a card (`Canvas.reveal`, `revealWidget`,
    `fitAll`, `center`, `toCanvas` inert, and every road into `focusCard` routed to chat view's
    select), nothing behind it runs (`ambience={null}`, the panel gated on the wall view, the
    browser widget's screencast paused, `Flow`'s and `Lineage`'s loops held), the chrome is not
    measured offstage, the key table, the routing above. The composer's reach in chat view is the
    selected card with broadcast forced off. `skein.watching` view-aware. Un-spreading on entry,
    the window settling before the transition, re-spreading on return.
  - `src/lib/control.svelte.ts`: a `view` op and `snapshot.view` (no Rust: `control.rs` routes
    generically); the `key` op gains a target.
  - `tokens.css`: the `--cv-*`, `--dur-*` and `--ease-*` tokens (spec §8.1, §9.1).
- **Tests.** `test/chatview.test.ts`, `test/viewmode.test.ts`, and a token test that scans for the
  three prefixes and asserts each is declared, consumed and read with a fallback (`theme.test.ts`
  covers only the registered reading knobs). All added to the `test` script.
- **Lab.** Six cards in four states, and a gathering of two on the wall. Switch: the sidebar groups
  them in spec §5.1's order; the selected conversation and the draft carry across both ways; a
  half-answered dock question for another card opens chat view on that card. **The viewport,
  snapshotted before switching, is identical after** Ctrl+Tab, Alt+↓, a click on the peek and a
  timeline step in chat view. A message sent from chat view reaches only the selected card, and the
  gathering is still gathered on return. A picture pasted into the message box becomes a chip and
  the widget count does not change. Typing into a dormant card wakes it; a flyway shadow (a second
  lab with `--peer`) appears with *on lab* and can be read and sent to.
- **Measure.** Chat view over the offstage wall against chat view with the wall unmounted — the
  honest baseline; a still wall with ambience on already pays for the backdrop's loop. GPU and
  present rate per `motion.md`, with its four traps (occlusion flags; never measure from inside a
  working card; agent CPU is not the proxy; `prefers-reduced-motion` cannot be pulled from outside).
  Then `full` against `still` with one card working. If offstage costs more than unmounted with the
  obligations met, unmount (spec §11.3) and write down the measurement either way.
- **Risks.**
  - A road into `focusCard` or `Canvas.reveal` that the routing missed: the viewport check above is
    the test for it, not a reading of the code.
  - A frame of the wall laid out without its dock, storing a chrome height without it for good
    (`arrange.svelte.ts`).
  - The peek and the attention ladder must behave identically (`Attention.isDriven` silences them
    in the lab; `wall.test.ts` asserts the reading).

## Phase 4 · an agent's life in the thread — L

**Done** — `daa89e2` (the question at the thread's end with its keys, toasts, settling by the
dwell, queued bubbles), `f3cf780` (`files_handled_by` off the main thread), `a0a704f`
(timestamps and the run summary), `9502be3` (the side pane, the plan strip, the linked card, the
relay drawn from its sender), `da352d6` (the plan document card), `41b6f03` (the animation
count, and the measurement phase 3 owed). Lab `chat`, frozen, fed wire and the real MCP route:
4a 19/19 (questions in the thread and the dock, a toast, Alt+↓, settling), 4b 19/19, 4c 5/5,
the dock's keys 2/2, phase 3 re-run 20/20. Deviations:

- **The linked card is read off the spawn's receipt** (`chatview.ts::spawnedHandle`, *its handle
  is …*), not off `kin`, because kin says *that* a card has children and not which call opened
  each. The pane's *linked* tab is kin's, and was not lab-driven: only a real `spawn` writes the
  table, and that is a real turn. Its drawing is the sidebar's nesting, which phase 3 verified.
- **Reaching other cards from the thread is `others.svelte.ts`**, ambient and provided only by
  chat view, so the wall's panel draws neither the linked card nor a relay as a message.
- **The run summary** says *wrote the plan* for a write into `~/.claude/plans` rather than an
  edit with a diff stat, *started a conversation* only for a spawn that opened one, and nothing
  about time under a second.
- **The *send now* path** is lab-checked as far as the queued note; the stop it sends needs a
  real turn, which no lab here has taken.
- Chat view's four status animations while cards work (the sidebar's breathing dots, the
  thread's pip and shimmer) hold the present rate up, ~20% GPU 3D for three working cards
  against the wall's 59%: the motion pass in phase 6 is where that is looked at.

The first release of chat view, as a minor version, once this phase stands up.

- **Files.**
  - The inline question: `Ask.svelte` at the thread's tail for the selected conversation,
    `--ask-ceiling: none`; and **in `Ask.svelte` itself**, number keys and ← → between questions,
    with the options a single-select listbox (spec §10.2). The dock gets them too.
  - `Toasts.svelte` over `front.svelte.ts`; *needs you* reading deferred questions from the away
    system (`deferred_ask`).
  - Settling (spec §5.4): `done` notices by the dwell rule — selected, window in front, not away,
    the last message on screen for two seconds — through `CardHandle.acknowledge`; `question`
    notices left in *needs you* until answered or dismissed.
  - Queued bubbles from `Line.awaited`, *send now* as `do("stop")` (spec §5.6).
  - Timestamps: `Line.at` and a tool call's start and end, stamped live and read from the session
    records' `timestamp` in `history.ts`; the run summary and diff stat as a pure function beside
    `foldSummary` (spec §7.6).
  - `PlanStrip.svelte` (`timeline.ts::current`, `fraction`, `effective`; the ≤ 650 ms flourish).
  - `SidePane.svelte`: the plan stood on its end; files touched through `files_handled_by`, made
    `async` and `off_main` and cached per turn first; linked conversations from `Elsewhere.kin`;
    jobs; the `/btw` tab.
  - In `Thread`: the linked-conversation card where a spawn call stands, relay lines drawn as
    messages from their sender, the plan document card with *build it here* and *build it in a
    fresh conversation*.
- **Tests.** Pure helpers in `chatview.ts` for where a spawn's card goes, who sent a relay, the
  dwell, and the run summary; `notice.ts::seesRest` reused, not restated; `Ask.svelte`'s new keys.
- **Lab.** The `ask` op with two questions and previews: answered with 1, Enter, a typed answer,
  Enter — then the same through the dock. A second conversation asking while the first is open:
  toast, row rises, no focus taken, Alt+↓ opens it. A `done` notice: Ctrl+Tab past it leaves it
  standing; dwelling on it settles it. A `question` notice: reading it leaves it in *needs you*. A
  message sent mid-turn reads *queued* until it is taken up; *send now* stops the turn and it goes
  once. The `kin` op for a child: nested row, linked card, a relay drawn from the child.
  `timeline_set` and `timeline_mark` from a real card: the strip and the pane follow; completing it
  flourishes once and leaves the DOM.
- **Risks.** The hold rule in a second drawing (spec §5.3); `Gallery`'s fixed positioning from inside
  a scrolling thread; scripts in previews stay gated on the card's kind.

## Phase 5 · starting things — L

**Done** (`fb0d2a0` the auth probe and `claude_auth`, `fad47c3` the allowance stand-ins,
`dfcc9b4` the rest, `c41e00a` the foot's signed-out wording). Lab `chat5`, frozen: 40/40 for the
main run and 5/5 for the signed-out arm, at the synthetic-key rung; one real Haiku turn (the
just-chat conversation), everything else the app's own ops. Deviations:

- **The probe's answer** (spec §11.4): `claude auth status --json`, run in Volery's own
  environment, ~1s, signed out exits 1 with a good record. On Lyss's machine the default
  credential *is* signed out (every sign-in is managed), so readiness reads a usable account as
  ready first. *Sign in to Claude* signs into a managed account — `signin.rs` writes only into
  a store — rather than the machine's own credential.
- **The simulated allowance** is a new `allowance` op over `Waterfall.standIn` and
  `Ledger.standIn`. The reading is rung one; the hold it causes is the real `#settleAccount`
  path from the send onward. An unmanaged install has no hold at all today (`#managing` is
  false), so the banner is a managed wall's.
- **No *open in your editor*** on the project page: nothing on the wall opens a folder in an
  editor, and a row that does nothing was left out rather than drawn. *Last changed* is
  *worked in*, from the conversations, since no command reads a folder's mtime.
- **The palette is `Lookup.svelte`, its ranking `search.ts`** — `Palette.svelte` is the same
  file as `palette.svelte.ts` on a case-insensitive disk and broke every build for minutes.
  `menu.ts` dropping wall-only rows was already done in phase 3.
- **Not built**: held bubbles' *edit* (the mockup's narrow.html) — the hold's take-back is the
  banner's *take it back*, which returns the whole hold as the spec says. The place chip's
  *on a new branch…* (§4.5) — the wall's worktree prompt is a Canvas gesture with no chat-view
  surface yet.
- **Unverified**: anything at the real-key rung (what a keystroke types), the signed-in browser
  round trip itself (clicking *sign in to Claude* would open a real browser), a `warm` reading
  on a managed account rather than the machine's own, and the narrow and light-skin drawings
  (phase 6).

- **Files.** The empty state with the place picker and suggestions; the *getting ready* card
  (Claude Code not found — `claude.rs`; not signed in — `signin.rs`, after a probe of how to tell
  the machine's default credential is signed out without spending a turn, spec §11.4);
  `Skein.openChat(preset)` (`skein.svelte.ts:1646`, passing the chosen preset or the wall's
  default); the model and effort menu (`presets.ts`); `ProjectPage.svelte` (`setProjectGuidance`,
  `setProjectReadOnly`, the folder's actions); `Palette.svelte` for Ctrl+K (conversations and
  projects through `chatview.ts`'s match, every `leader.ts::CHORDS` entry with its keys, Volery's
  slash commands, settings, the sink through `Sieve`); `menu.ts` dropping wall-only rows in chat
  view; the allowance foot, the running-low line and the held banner (`waterfall`, `limits.ts`,
  `conv.held`).
- **Tests.** The palette's ranking in a pure module with a test; `presets` and `accounts` stay
  green.
- **Lab.** A new *just chat* conversation opened on a chosen model (snapshot shows the model); a
  folder dropped on the sheet's ground opens a project conversation there, and dropped into the
  message box attaches as a path; the project page's instructions and read-only flag are written
  (the snapshot shows the project row — the argv is not in any snapshot, and the spawn reading them
  is `guidance.rs`'s and `supervisor.rs`'s own tested path); Ctrl+K finds a conversation by a word
  of its title and runs `space v v`'s entry; a lab with no account signed in shows *sign in to
  Claude*.
- **Risks.** Simulating an exhausted allowance in the lab without spending one — find or add the op
  before writing the test, and say which rung it reaches.

## Phase 6 · first launch, and the finish — M

**Done** (`c5b92e6`). Lab `chat`, frozen: the first launch 5/5 on a fresh lab, the rest 15/15,
4b and 4c re-run green. Deviations:

- **The decision waits on the control surface as well as the store** (`control.asked`): the
  endpoint arrives by an invoke after the page loads, and without the wait a driven lab would
  meet the welcome for that moment. A lab asks with `view` `to: "welcome"`; a lab left up with a
  choice already stored never sees it again, which is correct and cost one confusing re-run.
- **The screens were compared with the mockups by eye** from the lab's own captures (studio,
  vellum, sugar, meadow; 860 and 560 wide), not in the Volery browser.
- **The motion pass found one gap** — the thread's pip had no `spare` arm — and left a guard
  rather than a list: `styles.test.ts` fails any chat-view component whose endless animation is
  missing an arm. Chat view's working dots still hold the present rate up while cards work
  (phase 4's measurement); that is the wall's own rule applied the same way, not a regression.
- **Narrow** keeps the switch as icons and hides the place chip and the context ring below
  600px, which the spec did not say; the update offer is held to one line.
- **Accessibility** added only the paragraph announcer; landmarks, row names and the question's
  group were already in place from earlier phases.

- **Files.** `Welcome.svelte` as approved (spec §6.9) and `viewmode.ts`'s first-launch arm; the motion
  pass (spec §9: every `[data-motion]` arm beside its block, reduced motion); the light skins (vellum,
  sugar, meadow — the pool and washes under `--ch-bloom`); the narrow layout (spec §6.8); the
  accessibility pass (spec §10.2: landmarks, names, live regions, focus never taken).
- **What it must not do.** Flash: the view is decided only after `skein.loaded`. Or break every
  lab: a lab starts with an empty store and a fresh profile, so the welcome screen is never shown
  while the control surface drives the window unless a test asks for it, and labs may seed
  `skein.view.v1` — otherwise `bun run test:wall` opens on the welcome screen in every phase.
- **Lab.** A lab asked for the welcome screen shows it; each choice is stored and the next launch
  skips it; an existing store never sees it; a driven lab never sees it uninvited. Every screen
  captured on studio and vellum and compared with the mockups in the Volery browser. Narrow at 860
  and 560 px wide.
- **Release.** A minor version: chat view reaches new installs.

## Later, each its own piece of work

- **Full-text search** (spec §11.2): ripgrep over the session files under `~/.claude/projects`, in Rust,
  `async` and `off_main`, scoped to the sessions this wall holds. M.
- **Branch into a new conversation** (spec §11.1): probe whether a resume can stop at a chosen message
  first. M after the probe.
- **Dictation into the message box**: one `voice.rs` utterance written into the draft. Nothing does
  this today (spec §4.3). S–M.
- **A sheet that hosts a widget face**, which brings the billboard and the register to Ctrl+K. S.
- **Code highlighting** (spec §11.5): only if Lyss reopens the house rule for chat view.

## The order, at a glance

| phase | visible | size | depends on |
|---|---|---|---|
| 0 · leader from an empty field | yes, on the wall | S | — |
| 1 · thread extraction | no | M | — |
| 2a · composer extraction | no | L | `a691b302`'s `Draft` + `PromptBox` commit |
| 2b · front-of-queue extraction | no | M | 2a |
| 3 · switch and skeleton | behind the switch, unreleased | L | 1, 2a, 2b, the paste and drop routing |
| 4 · agent life in the thread | first release | L | 3 |
| 5 · starting things | released | L | 3 |
| 6 · first launch and finish | for everyone | M | 4, 5 |

Phases 4 and 5 are independent of each other and can run in parallel worktrees once 3 has landed.
