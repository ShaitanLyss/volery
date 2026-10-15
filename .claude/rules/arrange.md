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
- **The sort is total, down to the scale**, so two monitors on one rect (a duplicated display)
  cannot leave the fingerprint following the order the system listed them in.
- **A monitor reporting 0×0 is dropped.** Mid-handshake a monitor can answer nothing, and
  letting one into the fingerprint would give a transient state its own arrangement — with its
  own copy of the whole glass, left behind for ever once the real answer arrived.

### Which monitor, how many, which is primary, which is home: none of it is the room

Lyss, 2026-10-15, twice in one day — and both were the key, or the spots under it, depending
on a thing this file already said they must not.

**Unspread, the room is one screen's worth of window, keyed on its orientation alone**
(`roomKey`: `one landscape screen`, `one portrait screen`). It was `fingerprint` of the window's
own screen — `currentMonitor()` and nothing else, so the *count* of attached monitors never
reached it — but that fingerprint is the screen's exact size and scale. So the laptop panel
and the external monitor beside it were two rooms with two glasses, each going stale while she
worked in the other, and what she saw was "my glass did not carry from the laptop to three
screens with Volery on one". Her own words are the rule: *both have Volery on one landscape
screen; the number of connected screens or which screen shouldn't matter.* Orientation is the
one fact kept, because a portrait pane is a genuinely different shape to arrange in. A
different size was at first absorbed by `glassAt` clamping a spot onto the pane it landed on;
it is now carried proportionally — see "A different size is the same glass, scaled" below.
**Scale in the fingerprint still holds for a spread desk**, which is a shape; it stopped
applying to one screen, which is not.

The key changing is itself a way to lose a glass, so the fix leans on the path that already
existed: a first sighting of `one landscape screen` is copied from `nearest`, and the room this
very screen was stored under by the old key scores 1 against it. `nearest` takes the room's
key rather than computing a `fingerprint` of its own, because unspread those two differ and
the old per-monitor key is exactly the row it must *not* skip. The old rows are left where
they are — dead weight, still candidates — rather than rewritten, since a wall cannot tell
from a stored one-screen key which screen it is now looking at.

**Spread, the key was already right and the *unit* was not.** Changing the Windows primary is
a translation of the whole desktop, which `normalise` takes out; which screen the window was
spread *from* (the home, where the chrome goes) reaches `availableMonitors()` not at all. Both
are tested, primary by primary, on the inverted L. What leaked is that a glass spot is CSS
pixels and the spread page is zoomed to the *home* screen's scale (`window.rs::rezoom`) — so on
a desk with the laptop at 150% and monitors at 100%, the same stored spot is 1.5× further
from the window's origin, physically, when spread from the laptop. Same key, same numbers,
different glass. So `arrangement.unit` (schema v52) records the CSS-per-physical ratio each
room's spots were written in, and `adopt_in` multiplies a known room's spots by `was / now`
(`arrange::rescale`) when it comes back under another — about the window's top-left, which is
the union's top-left whichever screen is home. **Which screen is home moves the chrome and
nothing on the glass.**

- **Unspread rooms carry no unit**, and are never rescaled: one screen's worth of window has no
  home to differ, and a CSS pixel there is what the glass is measured in on purpose.
- **A room with no unit recorded is read as it stands** and the unit recorded from then on —
  every room stored before v52. That is right whenever its home has not changed since, and is
  the most anything can honestly say when it has.
- **A clone is not rescaled.** Copying into a fresh room is "arrive looking like the one you
  came from" on the home screen, and the home screen is drawn at its own scale in both.
- **`settle`'s early return is on the key *and* the unit** — and, unspread, the one screen's
  size (below). A re-spread from another home that lands while a settle is in flight never
  passes through the unspread room, and the key alone would call it unchanged.
- **The timeline stack still hangs off the home screen**, by design (`glass.md`): it is the
  default for a timeline nobody has placed, and centring a default across the spread puts it on
  a seam. Anything you *put* on the glass stays put.

### A different size is the same glass, scaled

Lyss, 2026-10-15, the same afternoon: *"it should be identical but scaled to match."* Sharing
one room between the laptop and the monitor beside it was half of that; the clamp that absorbed
the size difference was the other half going wrong. A widget in the laptop's top-right corner
landed two-thirds of the way across the monitor, and one at the laptop's bottom edge floated in
the monitor's middle — the same pixels, read on a pane half again as big.

**A one-screen room's spots are a share of a frame**, and the frame is recorded against the
room (`arrangement.frame_w`/`frame_h`, schema v53). When the room comes back on a screen of
another size, `adopt_in` carries every spot from the frame it was laid out in to the one it is
about to be drawn in (`arrange::reframe`), and records the new one. The decided fork holds:
**position scales, size does not, and the clamp is what is left for what cannot fit at all.**

- **Proportional over the travel, not over the pane** (`arrange::travel`). What is kept is
  `x / (frame - size)` — how far along the room it has to move in a thing is — so flush right
  stays flush right, the middle stays the middle, and anything that fitted the laptop fits the
  monitor without the clamp touching it. A share of the pane keeps the *top-left corner's*
  share instead, and everything near the far edges drifts inwards by its own size times the
  growth. That needs each thing's size, which only the canvas knows (a card is `CARD_BOX.wall`,
  a territory is however its cards laid it out), so `settle` hands a size book in with the
  adopt (`Canvas.measureGlass`); anything missing from it travels as a point.
- **It stays invertible, and that is what every other choice serves.** Nothing is clamped in
  storage and a thing too big for either frame is left where it is both ways, so laptop →
  monitor → laptop gives back the pixels you left (measured on a copy of her wall: 50 spots, the
  worst off by 1e-13 px). Successive carries telescope — `(F₂−w)/(F₁−w) · (F₃−w)/(F₂−w)` is
  `(F₃−w)/(F₁−w)` — so nothing creeps across many moves either. **Both hold for a thing whose
  size did not change in between.** A territory grows as its cards open, a plate as its plan
  does, and each carry keeps the share the thing had *at that moment* — which is the right
  answer and not a round trip.
- **Pixels and a frame rather than fractions in the table**, deliberately. Fractions in the
  columns would change what `glass_x` means to every read path in the app (`layout`'s carried
  territory cards add offsets to it), and fractions in `glass_spot` alone would need `remember`
  to divide by a size Rust does not have. Pixels with the frame they are in say exactly what
  fractions say, the columns stay a cache of the room you are in, and the conversion happens
  once per change of screen in the one place that has the sizes.
- **The frame is the screen's, not the window's** (`arrange.ts::frameOf`): the monitor's work
  area less the window's own chrome *at rest*. So un-maximising the window changes nothing and
  a narrower window is still absorbed by the clamp, as it always was. Only a change of *screen*
  re-expresses anything.
- **The chrome is a memory, not a reading** (`arrange.ts::Chromes`, `restChrome`). It was read
  live, as the window less the pane, and the pane is `main.wall`, which shrinks under the dock
  whenever the dock grows — so a question open in the dock at the moment the screen changed
  was baked into the frame the whole glass was carried onto, three hundred pixels short for
  good, and a draft restored at launch skewed the migration's first record (red-team,
  2026-10-15). The chrome at rest is the *least* it ever is, so the least seen is the honest
  estimate: every pane the canvas measures is a reading (`Canvas`'s `onchrome`), not only the
  ones a settle happens to take, and the memory is kept across launches because the first
  settle of a launch is the one likeliest to find something open in the dock. **Per dock
  mooring**, since a floating dock is no chrome at all and a minimum carried from it to a
  moored one would be a lie about the other. A reading below one pixel is not a reading — a
  pane caught mid-way out of being spread covers the whole window, which a window with a
  title bar never does — and `measureGlass` reads the pane off the element rather than out of
  the ResizeObserver's last answer, which is the spread pane for a beat after unspreading.
  **The settle's own reading is taken before `arrangements.wanted` moves**, because the
  moorings follow `wanted`: the moment it names the new room, the dock's mooring is the new
  room's while the pane on screen is still the old one's, and a reading filed then went under
  the wrong mooring — a floating dock's header-only height kept as a moored one's rest, for
  good, since the memory only goes down (red-team's second pass). The frame is then built from
  the memory for the mooring the *new* room will be drawn with, and a mooring never seen at
  rest is no frame at all: the dock re-moors, the canvas reports what that measures, and the
  next focus, move or resize adopts with it. What the memory cannot follow is the title bar
  growing (a larger reading size): the least seen then stays a little under the truth until
  that mooring is next seen smaller. Nor does a frame already recorded improve when the memory
  later finds a lower minimum; it is what the next carry starts from.
- **Only a change of screen moves anything** (`framePlan`). A room whose last screen
  (`screenOf`: size and scale, never position) is the one in front of you is already in this
  screen's frame, whatever the pane measures today, and keeps the frame it recorded on arrival.
  Re-expressing off a fresh measurement every focus would creep every spot by the height of
  whatever draft was open. A scale change on the same panel *is* a change of screen — the CSS
  pane differs — and is carried.
- **A room is never adopted blind.** One screen's room waits for the pane to be measured
  (`settle` returns before adopting, and the effect in `App.svelte` asks again on the canvas's
  `glassReady` transition), because adopting writes this screen into the room's
  `screens_json`, and beside a frame from another screen that is a room whose every later
  settle believes its spots were laid out here — nothing is ever carried again. The same for a
  `known_arrangements` that failed, and for a pane that cannot be made into a frame. The next
  focus, move or measurement asks again.
- **And the moorings do not wait for it.** `arrangements.wanted` is the room the screens call
  for whether or not it has been adopted, and `berth.svelte.ts` keys on that first: a mooring
  needs nothing of the pane, and an empty wall — which draws no canvas, so never adopts a
  one-screen room — was otherwise left using the moorings of the spread desk it had just left.
- **A copy arrives scaled.** A fresh room cloned from an ancestor laid out on another screen
  size is that glass carried onto this one; an ancestor on *this* screen arrives as it was, with
  its frame — which is what makes the first flip between the two modes below move nothing.
- **Spread rooms have no frame** and are never reframed: their spots are about the desk, and
  `unit` is what carries them between homes. One adopt moves a room by at most one of the two.
- **Portrait screens get it too.** `one portrait screen` is one room for every portrait screen
  for the reason landscape is, and the carry is the same arithmetic; special-casing it out would
  have been code to keep a clamp nobody wanted.

**The migration is the frame, and it is estimated at first sight rather than in the rung.**
v53 adds the two columns and every room starts with none, because what a pane is short of its
screen — the taskbar, the title bar, the dock — is a fact about the live window that no stored
row carries. `estimateFrame` takes it to be what it is *now*: the live frame moved by the
difference between the screen the room was last seen on (`screens_json`) and this one. Exact
when they are the same screen (the first launch on the laptop the glass was laid out on moves
nothing and records the laptop's frame), and exact again when the taskbar is the same size on
both — proved on a copy of her v52 wall seeded with the room recorded as laid out on the
external and launched on the laptop: carried down by the estimate, and back on the external
every spot was exactly what had been saved there. **The one thing it cannot know** is a
room moved between two landscape screens after `de1a479` and before this, without anything
asking — its `screens_json` names the screen of its last adopt, which a move within one room
never triggered. Nothing records which screen those drags were made on.

### Scaled, or one glass per screen size

Both are wanted, and she said why: one glass that follows you is the point, and on a bigger
screen you may want more on it or the same things elsewhere. So a choice, **one for the whole
wall, default scaled** (`arrange.ts::GlassScale`, kept in `localStorage` beside the other
ground-menu settings, since it is about the screens on this desk).

- **Per size puts the size back in the key, and only the size** — `one screen 1920x1200@1.50`.
  Which screen, how many and which is primary still reach nothing. Spelt apart from the
  pre-orientation per-monitor keys (`1920x1200+0+0@1.50`): those rows are the glass from before
  `de1a479`, and the first flip should find the glass you have rather than revive that one.
- **Two rooms, never two readings of one**, which is what makes the flip lossless: it selects
  whose spots are drawn and converts nothing. The scaled room is not touched while you are in
  per-size, so flipping back finds it exactly as it was left — asserted in Rust and on a lab.
- **A first per-size sighting is copied from the scaled room of its orientation**, carried onto
  this screen (`ancestorFor`) — not from `nearest`. On the screen you were just on the two are
  the same room and nothing moves. On a screen size never seen per size, `nearest` would pick
  the pre-orientation per-monitor row for that very screen, a perfect 1, and hand back the
  glass as it stood before `de1a479`: things taken off since reappearing, things put up since
  missing (red-team, 2026-10-15). Per size means "this screen keeps its own from here on", and
  from here on starts from what is in front of you. The scaled room's *own* first sighting
  still goes through `nearest`, where that old row is exactly right.
- **The moorings fork with it.** The panel and the dock are kept per room (`berth.md`), so per
  size each screen size keeps its own moorings too — and flipping back finds the scaled room's
  as they were, for the same reason the glass does.
- **Spread is untouched by it** — a desk is a shape either way.
- `<space>w g` flips it and says what is now true (`glassScaleSaid`), since the flip itself
  often moves nothing; the ground menu carries both rows with the chord as their note.

### Testing it from one desk

Nobody can plug a monitor in over the control surface, so the `screens` op answers `look` with
the monitors it is given (`arrangements.pretend`) and lets the glass follow — everything after
`look` is the app's own path, and `snapshot.arrangement` says `pretend: true` until `screens`
is called with nothing. A pretend screen's frame comes off its own work area, so it can be
bigger than the lab window: the store carries the spots to the pretend frame and the pane
clamps what it draws, which is the clamp doing its job rather than a failure.

**A widget saves on a 250ms debounce, and a room change supersedes a save still queued**
(`Widgets.adoptGlass`) — so a harness that moves a widget and changes screens in the same
breath loses the move, correctly. Let it land first, as any hand would.

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
spread is the other trigger and that one genuinely *is* an event, and so are two more: the
window **moving** — dragged by its title bar onto the monitor beside it, which at one scale fires
no resize and keeps the focus, and which was the gap a widget placed straight afterwards fell
through to be carried twice (`onMoved`, `onScaleChanged`); the window **resizing**, which is what
maximising on the monitor you just dragged it to is, or Windows
moving it when a screen goes away (`resize`); all three coming to rest at 400ms rather than
every frame of a drag; and the canvas's pane being **measured** for the first time, since a
one-screen room is never adopted before it is. Everything past the first question is bounded by
`settle`, which returns nothing at all unless the room's key, its unit or its one screen moved —
so the residue of each is one `currentMonitor` call. What is left is a widget placed inside the
400ms after a window lands on another screen, which no hand does.

### The one kind with no columns

A card on another wall (`elsewhere.md`) can be stuck to the glass and has **no row here** to
carry a spot, so it is not in `arrange::KINDS` and must never be added to it without rows
behind it: `adopt` clears as well as sets, and a kind listed with nothing written for it
empties that table's `glass_x` on the next arrangement change. Its spot is a `glass_spot` row
of kind `shadow` and nothing else — `remember` writes it (`stick_shadow`), `adopt_in`'s shifted
copy carries it with every other kind, `spots_in` answers it as `GlassSpots.shadows`, and
`keep_shadows` lets go of a closed card's. `GlassSpots::slot`'s fallback is the timelines, so a
new kind needs its own arm there or its rows land among them.

### What the undo stack is told

A glass position is a room's coordinates, so an act holding one from the room you have just
left can never be written back honestly. Each holder's `adoptGlass` answers the ids it actually
moved and those records are dropped from the stack.

Deliberately **not** `undo.clear()`: the stack also holds renames and deletions that have
nothing to do with screens, and losing the ability to undo a closed card because you pressed
the spread button would be a worse bug than the one this avoids.
