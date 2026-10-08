---
paths:
  - "src/lib/arrange.ts"
  - "src/lib/arrange.svelte.ts"
  - "src-tauri/src/arrange.rs"
  - "test/arrange.test.ts"
---

# One glass per room

### One glass per room

Where you put something on the glass is a fact about the screens in front of you, and this
window has two quite different sets of them. Unspread, the glass is one screen's worth of
window. Spread (`span.ts`), it is every monitor at once. Those are **not one room with more
furniture in it** — they are different rooms, and an arrangement made for one of them read
back in the other is a pile in the corner.

So a glass spot belongs to a *screen arrangement*, and switching into one that has never been
seen copies the most similar known one rather than handing you an empty pane.

Before this, the pane was the home screen's share of the window even while the wall was spread
over three monitors, and the comment in `glass.ts` said so out loud: *what was stuck to the
glass belongs to the home screen, and stays there*. That was the right call **given one set of
spots**, because one set cannot describe two rooms and the alternative was that spreading
scattered an arrangement you had made. Two sets is what makes widening the pane safe, and the
two halves have to land together — widening it alone is the bug the old comment was avoiding.

### What an arrangement is

`arrange.ts`, pure and tested. **The shape of the screens, not the set of monitors**: the
rects are normalised to their own top-left and sorted before anything is said about them, so
nothing here can see a monitor's name, its handle, or where the set sits in the desktop's
coordinates. Two 1920×1080 panels side by side are the same arrangement whoever made them; the
same two with the left one turned portrait are not.

- **Physical pixels**, because that is the unit a monitor is described in — the argument
  `window.rs` makes about `window_frame` — and the one thing about a screen that does not
  change when the page is zoomed.
- **The scale factor is in the fingerprint and not in the similarity.** The same desk at 100%
  and at 150% is the same *shape*, so one should be seeded from the other; and it is still its
  own arrangement, because every spot on the glass is in CSS pixels and those two rooms are
  different sizes.
- **A monitor reporting 0×0 is dropped.** Mid-handshake a monitor can answer nothing, and
  letting one into the fingerprint would give a transient state its own arrangement — with its
  own copy of the whole glass, left behind for ever once the real answer arrived.

### Similarity is an alignment search, and trusting the normalisation was the bug

Normalising both sides to their own top-left is what makes an arrangement a shape rather than a
place on the desktop, and it is **not enough to compare two shapes by**. Drop a screen from the
L-shaped desk and the remaining two slide to a new origin, so nothing lines up with where it
was: the two-screen room scored better against a single laptop panel than against the desk it
is literally part of.

So `similarity` tries every alignment that puts one screen of each side on top of the other and
keeps the best. Translation-invariant for the same reason normalising is, and additionally it
*finds* the correspondence rather than assuming the origins are it. At most six screens a side,
so being right costs nothing anybody can measure. The general shape, which is worth carrying:
**normalising to a canonical origin is a way of naming a thing, not a way of comparing two.**

A score of zero is still an answer — two rooms sharing no geometry are a better starting point
than a blank pane, and every spot is clamped onto whatever pane it lands on anyway.

### The columns are a cache of the room you are in

Every spot still lives where it always did: `placement.glass_x`, `project.glass_x`,
`reference_image.glass_x`, `widget.glass_x`, `timeline.glass_x`. `glass_spot` is the record,
those five pairs are the arrangement in front of you, and `adopt_arrangement` is the one place
they are reconciled. **Every read path in the app is therefore untouched**, which is the whole
reason the change is this small — and an older build opening the file still finds a wall it
understands.

**Written through rather than harvested on the way out.** The obvious design is to copy the
columns into the table when you *leave* an arrangement, and it is wrong for the reason
`set_mid_turn` learned: bookkeeping that records how far something got must not be deferred to
after the getting there. A crash is the exit that saves nothing. So every writer calls
`arrange::note` beside its own write and the table is never behind.

- **A failure to remember is logged, not returned.** The placement has already landed by then,
  so the cost is this room's memory of one spot — and turning that into a failed drag would be
  the wrong trade in the loudest possible way.
- **The test for "never seen" is the `arrangement` row, not whether it has any spots.** "I took
  everything off the glass in here" is a thing you did, and re-cloning over it every time you
  walked back in would make it impossible to do.
- **The reconcile clears as well as sets**, as one correlated `UPDATE` per kind rather than a
  clear-then-apply: a card stuck in one room and never stuck in the other has to be *on the
  wall* in the other, not sitting where the last room left it — and there is no instant at
  which the wall has been emptied.
- **The first arrangement ever identified inherits the glass as it stands.** Every wall made
  before this feature has its spots in the columns and nothing in the table. The alternative is
  that the first launch after the update finds the glass empty, which reads as having lost your
  arrangement rather than as having gained a feature.

### A copy arrives looking like the thing it was copied from

The pane is the whole window while spread and the home screen's share of it otherwise, so *the
same place on the home screen* is a different pair of numbers in the two rooms. A straight copy
piles the glass onto whichever monitor the union starts at — on an upside-down-L desk, the
portrait one.

So `arrangement` carries the pane's origin as it was when that room was last in front of you,
and a cloned spot is shifted by the difference. The origin is supplied by the front end and is
*derived* rather than measured — `Canvas` reads the real thing with a ResizeObserver that may
not have run when the spread lands, and a few pixels of chrome either way is absorbed by the
clamp on the very first draw.

### Where it is asked

Off `attention.focused`, which is the shape the architecture note prefers: nothing emits an
event when a monitor is plugged in or the window is dragged onto another screen, but coming
back to the window is both when the answer can have changed and when it is worth having. The
spread is the other trigger and that one genuinely *is* an event. Everything past the first
question is bounded by `settle`, which returns nothing at all unless the fingerprint moved —
so the residue of a focus is one `currentMonitor` call.

### The one kind with no columns

A card on another wall (`elsewhere.md`) can be stuck to the glass and has **no row here** to
carry a spot, so it is not in `arrange::KINDS` and must never be added to it without rows
behind it: `adopt` clears as well as sets, and a kind listed with nothing written for it
empties that table's `glass_x` on the next arrangement change. Its spots are session-only and
kept per room *in memory* by the same rules this file states — a room seen before gets its own
back, a room never seen copies the one just left shifted by the panes' origins — in
`shadow.ts::enterRoom`, called from `settleArrangement` beside `adopt` with the same key and
origin. `elsewhere.md` argues why it is not persisted.

### What the undo stack is told

A glass position is a room's coordinates, so an act holding one from the room you have just
left can never be written back honestly. Each holder's `adoptGlass` answers the ids it actually
moved and those records are dropped from the stack.

Deliberately **not** `undo.clear()`: the stack also holds renames and deletions that have
nothing to do with screens, and losing the ability to undo a closed card because you pressed
the spread button would be a worse bug than the one this avoids.
