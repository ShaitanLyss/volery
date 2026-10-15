---
paths:
  - "src-tauri/src/timeline.rs"
  - "src/lib/timeline.ts"
  - "src/lib/timelines.svelte.ts"
  - "src/lib/Frise.svelte"
  - "src/lib/Plate.svelte"
  - "src/lib/plates.ts"
  - "src/lib/Annals.svelte"
  - "src/lib/Unfinished.svelte"
  - "test/timeline.test.ts"
  - "test/plates.test.ts"
---

# Timelines

A card's plan for a long piece of work, drawn on the glass as a frise: major steps as
milestones along one hairline, sub-steps as ticks between them, and a step whose work runs in
parallel forking into **strands** that rejoin at the next milestone. The card draws it and keeps
it current; the user reads it at a glance across ten cards. Sink `9bd1e768`, designed with the
user over mockups on 2026-10-01 (the "thread" look, strands rather than several marks on one
line, the "plates" archive).

`timeline.rs` owns the plan and every write. `timeline.ts` is the pure reading — the row's
shape, how far along it is, every mark's position (`frise`) — and `test/timeline.test.ts` holds
it. `Frise.svelte` is one plate; `plates.ts` (pure, `test/plates.test.ts`) and `Plate.svelte`
house it as a widget; `Annals.svelte` is the archive, `Unfinished.svelte` the close confirm.
Schema v37, and no rung since: the housing is a widget row.

### One live timeline per card, and parallel work is a strand

Tools take no id: a card's own live timeline is the only one it can mean. Parallel work — a
background task, a split — is a step forking into named strands, each with its own sub-steps
and its own live marker, so the parallel parts stay inside the plan they belong to. A card may
hold a *complete* one on the glass (waiting for the archive click) and start a new live one.

### Two writes, priced differently

`timeline_set` takes the whole plan; `timeline_mark` moves states by path (`3`, `3.2`,
`3.ui.2`, 1-based) and takes `done`/`active`/`todo` lists so several items move in one call.
The user asked for the hybrid explicitly to keep ticks cheap — a mark is a few dozen tokens
where re-sending the plan is a thousand or two. A `set` **carries forward** every state it can
match by title (step by title, sub-step by strand name then by title anywhere in the step), so
restructuring does not mean restating progress; a state written explicitly wins. Marks are
all-or-nothing: every path resolves before any applies.

Rewinding is allowed and is just a mark. A step marked `done`/`todo` takes its sub-steps with
it; `active` on a step that has sub-steps is refused, since it names nothing in particular.

### Owner writes; any card reads, wall-wide

Reading is not project-scoped, on the user's point that a card in one project spawns cards in
others — the orchestrator reading its children's progress without a `send` costing them a turn
is the case it is for. Writing is the owner's alone.

### Colour is the owner's status, on the live markers only

A live marker is *where work is happening now*, which is a status, so it wears the owning
card's tier — celadon working, amber asking, muted at rest. Milestones are never tinted; how far
a plan has got is not a status. An archived plate is drawn `rest` throughout, so a left one's
markers read as where it stopped.

### Clicking a step finds the write in the transcript

Every write that moves something takes the plan's next `rev` and ends its answer with
`[timeline 3fa9c1 r7]` (`receipt`) — the timeline's short id as well as the rev, because a rev
restarts at 1 for every timeline and a card can hold a complete one and a live one at once, so
`r3` alone would land a click on the wrong plan's write. A mark that changes nothing takes no
rev and writes nothing. Each step and sub-step records the rev that added it (`born`) and the one that
finished it (`done`, cleared on a rewind) — `stamp`, serialised flattened onto the item. A click
focuses the owner and walks the transcript for the timeline tool call whose *result* carries
that receipt (`Transcript.reveal`), which works for history read back off disk as well as for a
live column, because the receipt is in the session file. A rev rather than a timestamp because
the thing being found is a tool call, and a time would have to be matched against another clock.
`jumpToWrite` retries for a few seconds since a dormant card's history is still loading when it
is focused, and gives up silently — landing on the card already happened.

### Closing a card with one in flight asks, whoever closes it

Your own close puts up `Unfinished.svelte` (keep-it focused, Escape keeps). An agent's
`close` is parked on the user like any other close question — **including a parent closing its
own child**, which otherwise closes unasked; `with_timeline` rewrites the question so it does
not call the child "not a card it opened". Either way the close itself archives the timeline as
`left` (`leave_for`, from `close_conversation_record`, beside the board's and the sink's own
clearing). The control surface's `close` op — a test's hand, or a spoken sentence through the
steward — asks nobody, so it refuses a card with a live timeline unless given `force`.

A **cleared** card leaves its timeline too (`clear_conversation`): the agent that drew the plan
is gone though the card stays. `leave_for` therefore never re-reads the session — after a clear
it is already the new one — and keeps the one `set` recorded, which is the conversation that
remembers the plan. One live timeline per card is held by a partial unique index as well as by
every writer taking the store lock across its check and its write.

### Picking one back up adopts the session

A left timeline's card is closed, so somebody has to own it. The user chose re-adopting the
session that drew it — `importSession`, the same path `adopt` takes for any closed card — and
handing the timeline to that card (`resume_timeline`). The owner is looked up **by session**,
not by card id: a card cleared since is on another session and has forgotten the plan, and a
session already adopted back through `adopt` is a card on the wall that remembers it. A
second click while the first is still adopting is ignored (`pickingUp`). It remembers the plan because it is the
same conversation. If the card is still on the wall (archived by hand), the timeline simply goes
back to it.

### A plate is a widget, and there is no layer any more

Until 2026-10-15 the plates were drawn on a layer of their own, `Lintel.svelte`: an `inset: 0`
sheet on the glass, inert, each plate taking events back and dragging itself. Lyss asked for them
to be widgets "like others in essence" — selected with the rest, gathered in a band, moved to the
wall or the glass, given variants (sink `b2b0546d`). A plate now **is** a widget, kind `timeline`,
on the pattern the pinned last message set one day earlier (`tether.ts`): a widget whose config
carries what it is a view of. Everything a widget has, a plate has by being one — the one
selection, the band, the carry and its one undo per press, a spot on the glass per screen
arrangement, the frame knob, and a right-click built off the catalogue.

- **The plan did not move, and must not.** The tools write it, a close archives it, a pick-up
  hands it back; Rust reads and writes it on every one of those, and `widget.config_json` is the
  column Rust never reads. So the timeline table stays exactly as it was, and the widget is the
  *housing*: its `config_json` carries the timeline's id (`plates.ts::PLAN`) and its row carries
  where the plate is. No schema rung. Folding the plan into the widget would have been the
  `said` pattern taken one step too far — a pin reads a card the front end already holds; a
  plate reads a plan the back end writes.
- **The wall puts a plate up and takes it down, unrecorded.** An agent draws a plan; nobody hangs
  one. App's housing effect asks `plates.ts::unhoused` and `evicted` of the two lists every time
  the plans change. Putting up waits only for the widgets to be read (it asks what is housed);
  taking down waits for *both* reads to have succeeded — a store that could not be read is not a
  glass with no plans on it — and drops what the undo stack knew about a plate it took down
  (`plateOfGone`), since undoing a move of one would hang a housing of nothing back up.
  `Widgets.put` refuses a plate whose plan is not shown, and a second plate of one plan, and the
  canvas does not draw a plate whose plan it cannot find (`drawn`), which would otherwise be a
  two-pixel sliver that could still be selected and taken down.
- **Taking a plate down archives its plan, and that is the only thing it does.** The grip, the
  menu (`archive it`), `<space>la`, Delete and the control surface's `widget.remove` all reach
  `Widgets.remove`, which hands a plate to `retire` — `archive_timeline` — and the plate comes down
  with the event that follows. Not on the undo stack, as it never was: the way back is the archive.
  **Delete and Backspace leave a live plan up**, and say so. They reach whatever is selected, and a
  plate clicked to be read *is* selected — so one stray Backspace would archive an agent's plan
  mid-work, its next mark would fail, it would draw a new one, and the old one could never be
  picked back up. The gestures that name the plate still archive a live one (found in review).
- **Three places to stand, not two** (`plates.ts::hangOf`). A plate nobody has moved hangs in the
  **stack** at the top of the *home* screen, as every timeline always arrived; dragged out of it, it
  is on the **glass** at a spot; put on the wall, it stands on the **wall** like any instrument. A
  spot wins; without one the `wall` state key decides between the wall and the stack. That flag is
  also what keeps screen arrangements honest: walk into a room where a plate was never stuck and it
  finds no spot, and one that came out of the stack goes back into it — what a timeline did before
  it was a widget. So the glass toggle cannot be two-sided for a plate: the menu offers the two
  places it is not (`menu.ts::hangItems`), `Canvas.hangPlate` does the moving, and the ordinary
  toggle defers to it.
- **The stack is laid out, not placed** (`plates.ts::stackAt`), so a stacked plate is drawn exactly
  as every glass widget is — a widget at a position — and a drag out of it starts from where it was
  drawn and writes the spot that takes it out of the stack. That is the whole of what the carry
  needed; `worldNow` meets a stacked plate as an ordinary glass widget.
- **A plate sizes itself.** A frise is as tall as its widest fork, so the box you drag is only ever
  its width, and a wide plate is as long as its plan asks. `WidgetNode` measures a plate and reports
  the box up (`onmeasure`); `Canvas.drawnSize` is what the stack, the clamp, the band and `fitAll`
  reason with, so none of them meets a stored height nobody drew.
- **The carrying over is a seed, not a migration.** A plate is put up in the stack — unless its
  timeline row still carries the spot the old layer wrote (`timeline.glass_x/y`, written by nothing
  in the front end since), in which case it is put up at that spot (`seedOf`), kept.
  `unarchive_timeline` and `resume_timeline` clear the columns, or a plan the archive promises to
  hang "in the stack" would come back at a spot it was dragged to weeks ago. So a plan somebody had dragged off the
  old stack is still where they left it. Spots the old layer kept for *other* screen arrangements
  are not carried: a plate walking into such a room goes to the stack, which is where an unplaced
  plan always went. The real wall had 32 timelines on 2026-10-15 — five on the glass, three of them
  dragged to spots — and the lab proof seeded all 32.
- **Never offered, never carried** (`widgets.ts::isView`). A plate is hung by a card drawing a plan,
  so no menu offers one and `widget.add` refuses one; a layout export leaves plates behind, as it
  leaves pins, because the plan is this wall's record.
- **Over the cards on the glass, behind them on the wall.** A plate is born at `Z_PLAN` (1500),
  the number the old layer had, so the stack sits over a card stuck at the top of the glass and a
  widget brought forward still covers a plate merely standing there. Put on the wall it goes to
  the back band like every widget hung there — nothing hung on the wall covers live work — and
  back on the glass it returns to `Z_PLAN` (`Widgets.hangAt`). A plate whose hover card is open
  rides at `Z_TOP` until it closes — the lift the layer did for all plates at once, one at a time.
- **A plate in the stack is centred**, so its resize grows both edges and the grip takes twice
  the pointer's travel (`WidgetNode`'s `centred`), or the grip would crawl at half speed.
- **A press on a plate is the wall's now**, which was the half of the old arrangement most likely to
  break in the move and the one designed around first. `Canvas.groundDown` returned early on
  `[data-timeline]` because the layer dragged its own plates; left in, every press on a plate would
  have done nothing at all. It is gone, and so is `.glass > :global(.timelines)`: with no inert
  layer there is no transparent sheet over the wall to eat presses (the 0.29.0 Wisps bug,
  `layout.md`), and `styles.test.ts` goes on holding any future inert layer to the same pairing.
  What the plate keeps for itself: the hover card is `data-grip` — reading it neither starts a drag
  nor lands on the card — and a click is a selection, as on any widget. **Landing on the card** is
  the card's handle in the eyebrow (a button, `Saying.svelte`'s `.who` precedent) or a double-click
  anywhere on the plate; a step still carries you to its write.

### Two variants: a window you scroll along, or the whole line

The plate used to be one size, about half a screen. That is the `wide` variant now, opt-in, and the
default is **`compact`**: the same frise at the same pitch (`STEP_PITCH`, 128 a step), in a window as
wide as the box you drag, scrolled along (Lyss, 2026-10-15). Both draw `frise()` — a step reads the
same in either, and the archive's column is a third width of the same drawing.

- **The window follows the work, and only a hand lets go.** `timeline.ts::workAt` is where the work
  is — the first live marker, else the next milestone, else the end — and `windowAt` puts it a third
  of the way in. The judgement is not written a fourth time: `follow.ts::stickToMark` is
  `stickToTail` along the other axis, and `aimed` hands `stillFollowing` the distance from the mark
  where it would have read the distance from the bottom — absolute, because a mark can be passed on
  either side. The plate re-aims when the work moves (`reaim`), and the attachment is set up under
  `untrack`, or it would be rebuilt every time the work moved and forget you had scrolled away.
- **The hover card is drawn beside the strip, not inside the step.** A box that scrolls sideways
  clips downwards too, so a card inside the step would be cut off at the strip's edge. It hangs from
  `.hang` instead, under its step less the window's offset, and leaving a step for its own card (or
  the card for its own step) is not leaving — `relatedTarget` says where the pointer went.
- **A bare wheel carries the strip sideways** (`wheel.ts::stride`). A mouse reports only `deltaY`,
  and shift is the wall's pan, so without this the only way along a compact plate was a trackpad.
  Over a strip with nothing beyond it the wheel is the wall's again.
- **No scrollbar; a fade says which end has more.** A bar would be a second thing a press on the
  plate could mean — a drag on it carries the plate — and a mask is achromatic.
- **Keys:** `<space>l` is the line's family — `ll` the whole line / a window, `lg` glass / wall,
  `ls` back in the stack, `la` archive — on the selected plates, or else the focused card's plan.

### Finishing: a flourish, then the archive by itself

Two moments, about ten minutes apart (sink `d7232bc8`).

- **The flourish animates the colour leaving, and adds nothing.** Colour on a plate is status, on the
  live markers only, so finishing already means the colour goes. On a plan going `live` → `complete`
  *while drawn*, a pulse in the owner's own colour travels the line a step at a time — through every
  strand of a fork together (`Frise.trackStep`) — the end of the line takes it and lets it go, and
  the last live markers drain to nothing. ~650 ms of travel, gone from the document at one second.
  No new hue (there is no success-green on this wall), no confetti, and it ends: `motion.md` priced
  the glow that never stopped. Reduced motion keeps the drain and drops the travel; `still` keeps
  neither. A plate that comes up already finished — at launch, out of the archive — is simply
  finished.
- **A finished plate in the stack goes to the archive by itself**, after `archive` minutes — a knob,
  `never` / 5 / **10** / 15. Only a plate nobody moved: a plate you moved to the glass or the wall
  is a plate you kept, `aside`'s rule — and that is a **flag** (`plates.ts::KEPT`), written by the
  move and by any spot the carry writes (`keepOnSpot`), not a reading of where it stands now. The
  first cut asked where it stood, and review found the hole: dragged onto the glass in one screen
  arrangement, a plate has no spot in another and stands in the stack there, so plugging in a
  monitor archived what you had kept — and the archive's `delete_widget` then forgot its spot in
  every room. Only `ls` / "put it back in the stack" gives the keep up, and arriving in the stack
  starts the clock afresh. Counted from the later of finishing and **the last moment it had
  attention** — under the pointer or selected — and **held while you are away** (presence's away
  mode, `away.md`), so a plan that finished over lunch is still there when you are back; the clock
  is empty at every launch for the same reason. *Not* held by the window being out of front, which
  was the first cut and the lab is what showed it wrong: a wall on a second monitor is seen all day
  from an editor, and a clock that ran only with the window focused would never run there. Restarting rather than pausing: every read buys the
  whole delay again, which is the more forgiving of the two and has nothing to remember.
  `Timelines.sweep` runs on the wall's one-second tick, so it is no second wake-up. The away
  machinery needed nothing of its own beyond being asked: `presence.away` is one boolean.
- **It fades, then goes** (`FADE_MS`, 600), and a plate reached for, moved or kept while it fades
  stays. An archive that fails gives the plate back rather than leaving it faded out and still
  pressable. **A gap between two ticks is not neglect**: a sleep or a closed lid moves every clock
  forward by the gap, or a wall woken in front of you would archive its finished plans at once.
- **Ten minutes is safe because the archive is one press back.** A finished plan in the Annals
  offers `hang it back up` (`unarchive_timeline`), which puts it back in the stack; a left one still
  offers `pick it back up`, which adopts its session.

### Discoverability is one prompt sentence that names a search

The four tools are deferred with search hints. `supervisor::append_prompt` carries one sentence
— chosen by the user — telling project cards to draw planned multi-stage work as a timeline and
to *search their tools for `timeline`*. It names a search rather than a tool, so it keeps
`the_prompt_names_only_tools_whose_schemas_are_loaded` honest: that rule's reason is a prompt
pointing at an identifier whose schema was withheld, and ToolSearch is loaded. The user's limit
— not for small tasks or open-ended experimenting — is in that sentence and in `timeline_set`'s
description both.
