---
paths:
  - "src/lib/undo.ts"
  - "src/lib/undo.svelte.ts"
  - "test/undo.test.ts"
---

# Taking it back

Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, and two items at the top of the ground's own menu.
`undo.ts` is pure and holds the whole state machine; `undo.svelte.ts` adds the runes and the
`Hand` that writes a record back. The file heads carry the argument — this is what does not
fit in either of them.

### One shape, four realms

Every undoable thing on this wall is the same sentence: *this record used to look like that,
and now it looks like this*. An `Edit` is `{ at, id, was, now }` with the **whole record** on
both sides and `null` meaning "did not exist" — so creating is an edit from nothing, removing
is an edit to nothing, and applying a step is one loop with no branch on which of the three it
is. An `Act` is a list of edits, because one gesture genuinely changes several records.

The four realms are `placement`, `widget`, `image`, `territory`. Whole records rather than
diffs is deliberate and costs memory: `widget.config_json` and its neighbours are opaque JSON
read through a normalizer, so what comes back out is not always key-for-key what went in, and
a field-level inverse would fight the normalizer over keys it had rewritten. A snapshot cannot
lose that argument.

### The boundary, which is the part worth defending

**Undo means "the wall looks as it did". It never means "that turn didn't happen".** Nothing
that left this machine is on the stack — no prompt, no broadcast, no `!` line, no `actions`
run, no relay message, no board notice, nothing git. Nor is anything holding a process:
closing a card takes an agent down, and a step that spawned one back would be starting work
nobody asked for against a session already marked closed.

**The viewport is not on it either**, and that is the one most likely to be "fixed" later.
Panning and zooming are how you *look* at this wall, not changes to it; a Ctrl+Z that scrolled
you somewhere would spend the gesture people press when they want the last thing they did
undone. Selection is out for the same reason — gathering cards for a broadcast changes
nothing.

The two things that leave for good — a card closed, a project forgotten — call `undo.drop`,
which takes their edits off both stacks. Left there they would be presses that appear to do
nothing, which is worse than a shorter history.

### Two ways an act is recorded, and why there are two

- **Where a gesture already has a commit point, the act is recorded there**, once, with every
  record it touched. `Canvas.haulUp`, `Canvas.toggleGlass`, the menu's `unpin` / `reflow` /
  `tidy`. This is what makes dragging a territory of five pinned cards *one* press to undo
  rather than six — recorded from inside `Studio` it would be six, because a territory drag
  writes a placement per member every frame.
- **Where the mutation *is* the gesture, the act is streamed and fused.** A widget dragged or
  resized writes its box every frame and nothing knows when you will let go; a knob nudged in
  the context menu fires once per click with no bracket around the series. `Widgets` and
  `Board` call `note()` from inside `add`/`update`/`remove` and `FUSE_MS` collapses the run.

So `Widgets` and `Board` hold a `Scribe` and record themselves — every route to one is
undoable by existing, including the control surface, which is how `wall.test.ts` can drive it.
`Studio` deliberately holds none.

**A drag across the wall is the one gesture that reaches into both halves of that split**, and
it is why `quiet` is public rather than an internal of `Undo`. A selection now spans all four
kinds, so one press can move a card, a territory, a widget and a reference image together
(`layout.md`). `Canvas.haulMove` wraps its writes in `undo.quiet` — which is what stops
`Widgets` and `Board` recording their own halves of it — and `haulUp` records once, with every
record the press touched, in all four realms. Streamed and fused would have made a group drag
two or three presses to put back, and the wall would come apart in whatever order the fuse
windows happened to fall: the same argument that made a territory and its cards one act,
one kind wider. That is not an exception to the rule above, it is the rule choosing the first
branch: a haul has a commit point, so it is recorded at it.

Three consequences of that split:

- `Widgets.beat` goes through `#patch` rather than `update`, so a running timer's banked
  seconds are not remembered. Nobody asked for them; on the stack they would push every real
  gesture off it while the wall sat idle, and undoing one would rewind a clock.
- `Widgets.put` / `Board.put` are the whole-record writers a step applies through, and they
  never record — that write *is* the recording being played. `Undo.quiet` wraps a step anyway,
  because `remove` is on the same path and does record.
- `Studio.place` and `Studio.forget` exist for the same reason. `pin`, `unpin` and `stick`
  each set one side of the row and leave the other standing, which is right for a person —
  sticking a card to the glass is not a statement about where it belongs on the wall — and
  wrong for putting a record back, where both sides are known. `forget` in particular: drag a
  card out of a glass territory and its `was` is *null*, and `unpin` would have left it
  flowing on the wall and still stuck to the pane.

### Things that were got right on purpose and will look removable

- **`sealed`.** Press Ctrl+Z and immediately drag the same card, and without it the drag fuses
  into the act just stepped past — taking a `was` from before an undo that has already been
  applied. Time alone nearly covers this and not quite; the two presses can be 50ms apart.
- **`trivial`.** A drag that ends where it began, a knob set to what it already said. Not an
  undo step: pressing Ctrl+Z on one of these looks like the key not working. Checked again
  *after* a fuse, since a press that went out and came back cancels itself.
- **A trivial act does not clear the redo stack.** Nothing happened, so nothing has made a
  redo stale.
- **`equal` treats a missing key and an `undefined` one as the same key.** `Placement.glassX`
  is optional and half its writers spell it out as null while the other half leave it off; a
  stricter compare made gestures that changed nothing look like changes.
- **Territories are observed, not predicted.** Reflowing one and tidying the wall both end in
  `Skein.#settlePlaces`, which gives a position to anything that has none — so a gesture aimed
  at one territory can move a neighbour. `standsOf` / `shifted` read the wall, act, and read it
  again; both `App.svelte` and the control surface go through them, and a second copy would be
  a second answer.

### It does not survive a restart, and an image's file is the price

The stack is this session's, in memory. The data it describes is all in SQLite, so persisting
it would *work* — it would just be a hazard: an undo you can press on a wall you have not
touched yet, that rewinds something you did yesterday and cannot see happening, is a gesture
with no context to judge it by.

That decision is paid for once, in Rust. `store::delete_image` no longer removes the copied
file with the row, because taking an image down is now undoable and a step that put the row
back pointing at a deleted file would restore a broken rectangle — the exact failure the note
in `Board.remove` is about, arriving by a new route. The orphan is collected by
`store::sweep_references`, called from `Board.load` **and only from there**: an image is
copied to disk before its row is written, so a sweep running between those two steps would
delete the file out from under an image being pinned up. Launch is also, conveniently, the
moment the stack that wanted it is gone. It picks up the orphan this pair has always been able
to leak — a crash between the copy and the row.

### What is not undoable yet, and would fit

Themes have their own revert guarantee (`theme.md`) and would need to compose with it rather
than duplicate it. Ambience profiles, a card's aside/bypass flags and the pomodoro's knobs are
all wall state and all absent — each is a `Realm` and a `Hand` method away. Card titles are
not: they come from the transcript rather than from a gesture.

There is no persistence and no "undo history" panel. `snapshot.undo` carries the labels and
both depths, which is what a test reads and what the menu says out loud.
