---
paths:
  - "src/lib/layout.ts"
  - "src/lib/pick.ts"
  - "test/pick.test.ts"
  - "src-tauri/src/pin.rs"
  - "src/lib/Canvas.svelte"
  - "src/lib/studio.svelte.ts"
  - "src/lib/images.svelte.ts"
  - "src/lib/ImageNode.svelte"
---

# Layout and the wall

### Layout and the wall

`layout.ts` is pure: cards auto-flow into their project's territory (grouped by `cwd`), and
dragging one pins it forever at canvas coordinates. Pinned cards never reflow; unpinned ones
flow around them.

**Territories flow onto a grid and can be carried.** They ran along a single line off the
origin at first — project 1 at x=0, project 2 beside it, forever rightwards — so six projects
made a wall three thousand units wide and five hundred tall, and the zoom that fitted it left
every card a smudge with the lower half of the screen unused. They now settle into
`TERRITORY_COLS` columns, `REGION_GAP` under what is above them, in the order
`territoryColumn` gives — and a territory dragged by its **name** (the handle; `.region`
itself must stay bare ground, which is what `handleOf` exists to have got right — first so a
press there still panned, and now so a band can be drawn inside a territory to gather what is
standing in it) stays where it was put: `project.x/y`, schema v3, null meaning "not settled yet".

Two things about that are load-bearing:

- **The packing is against real heights**, so there is no air on the wall that nothing is
  standing in. The first cut reserved a fixed cell tall enough for eight cards, and a project
  holding one sat in four hundred units of nothing with the row below pushed miles down.
- **The order fills a growing square, not a row at a time** (`territoryColumn`): 1×1, then
  2×2, then 3×3 — the new right-hand column top to bottom, then the new bottom row left to
  right, so nine projects read `1 2 5 / 3 4 6 / 7 8 9`. Filling a row across first meant three
  projects made a wall three wide and one tall, fitted at a zoom that already cost the full
  width with two thirds of the screen empty. Only the *column* comes from the order; where a
  territory lands in it is still `settleY` against real heights, so a "row" is something you
  read off the wall rather than a pitch anything reserves. Past the last square the rows
  continue left to right — with the column count fixed there is nowhere further out to grow.
- **A settled position is written down** (`Skein.#settlePlaces`, after the cards are loaded and
  whenever a project first appears), which is the only reason packing against heights is safe.
  Left unsettled, a territory's position would depend on the project list *and* on how many
  cards each project happens to hold, so the wall would rearrange itself every time a
  conversation opened — and the cards pinned inside a territory that moved are absolute canvas
  coordinates, so they would be left standing where the territory used to be. Settling happens
  once per project, or when asked for; never on a paint.

Dense packing plus never repacking means a project that has grown a lot since it was placed can
reach into its neighbour. That is what `tidy the territories` on the wall's menu is for
(`Skein.tidyProjects`) — the whole wall laid out again around what is standing on it now — and
`settle it back in` on one territory's menu, offered only when it has actually been moved.
Neither ever happens by itself. The column count is a constant for the same reason: deriving it
from how many projects there are would move every territory the moment a folder was opened.

Carrying a territory carries its cards. Flowing ones follow by arithmetic, since their slots
are measured off the region's origin; pinned ones are translated by the same delta by hand and
re-saved on release, or the territory would tear in two the moment it moved.

**Territories come from the projects, not from the cards standing in them.** Deriving them
from grouped `cwd`s meant closing the last conversation in a project took the project off the
wall — and with it the `+` that starts the next one, though finishing everything and starting
again in the same place is ordinary. `layout` takes the project list and orders regions by
it (`created_at`), which is stable whatever opens and closes; a `cwd` with cards but no
project row still gets a territory, at the end.

The counterpart is `forget_project`, on an empty territory's menu: without it every folder
ever opened accumulates, and a wall you cannot tidy stops being a wall you read. It refuses
while anything is open there, and takes closed conversations, placements and server groups
with it by cascade — rows, not transcripts, which stay on disk and can be adopted back.
`test/wall.test.ts` forgets its `.scratch/walltest` projects in `afterAll` for the same reason it
closes its cards: without that, every run would leave a territory on the real wall.

"Around them" is load-bearing and was for a long time only a claim. The flow numbered its
own slots and ignored pinned cards entirely, so a card pinned *on* the grid — which is where
most end up, since dragging one a short way pins it about where it already sat — held its
position and left its slot claimable. Every conversation opened afterwards landed in that
same corner underneath it, and pinning a card also yanked its neighbour up into the slot it
had just vacated. `slotUnder` now reserves the slot a pinned card sits on, with half a slot
of tolerance because nothing dropped by hand lands on the pitch exactly; pinned cards
further out reserve nothing, since that wall really is free. Position is meant to be *memory*, so avoid anything that reshuffles the
wall when a conversation opens or closes.

The one reshuffle there is — closing a card moves every flowing card behind it up a slot —
is therefore **walked rather than jumped**: `animate:walk` on `.node`, over `settle` in
`layout.ts`. It is the same argument as position-is-memory rather than an exception to it,
since a card that arrives somewhere without travelling has to be found again. Three things
about it:

- **It is FLIP through Svelte's `animate:` directive, but not `svelte/animate`'s `flip`.**
  That one divides by the layer's zoom twice — its factor is
  `clientWidth / rect.width / currentCSSZoom`, and Chromium's client dimensions are already
  unzoomed while rects are not, so it comes out as 1/zoom². Probed 2026-08-14 against
  Chromium 151 (`tools/probe-zoom.html`, and one card closed out of a column of four): at
  `zoom: 0.5` a neighbour that moved one slot starts 232 units away instead of 116. `settle`
  divides by `studio.scale` once, the same bargain `toCanvas`, the drag deltas and `reveal`
  make.
- **A card in hand does not walk**, and it has to be said out loud (`inHand` in
  `Canvas.svelte`). It was written here first that the directive fires only on a *reorder*, so
  a drag — which moves cards without touching the list — would stay glued of its own accord.
  Svelte does not work that way: `reconcile` measures every item and applies on the next
  microtask whenever the block's **array** changes, reordered or not. The array changes on
  every frame of a drag, since the layout is derived from the carried origin and from the
  placements the gesture writes, so each pointermove aborted the running animation and started
  a fresh one from wherever the card had got to — `from` is a `getBoundingClientRect`, which
  includes the mid-flight transform. Carrying a territory therefore dragged its cards along on
  a spring: trailing the cursor by their own duration the whole way, arriving only on release.
  The suppression is per card rather than for the whole wall, because dragging one card can
  hand its slot to a neighbour, and that is an honest reflow that should still be walked.
- **A pinned card is in the block and costs nothing.** It did not move, so `settle` gives it
  no distance and no duration; that is also why the duration is a function of distance rather
  than a constant.
- **And the card that caused the reshuffle may still be there while it happens.** A card *you*
  closed goes at once and the walk is all there is to see; a card an **agent** closed fades
  over `LEAVE_MS`, underneath the neighbours walking into its slot, so what the wall draws is
  closing over a departure rather than filling a gap that appeared from nowhere. `out:leave` in
  `Canvas.svelte` on the same `.node` the `animate:` is on, and `LEAVE_MS` is stated against
  `WALK_CAP_MS` in `layout.ts` — longer than the longest walk on purpose, or the reflow would
  outlast its own cause. The node is put below `Z_CARD` and made untouchable for the duration,
  which is how a transparent thing can stand here at all: it is the leaving that is
  transparent, everything solid is in front of it, and the bug `ambience.md`'s rule records was
  a card that stayed that way rather than one on its way out. Why it is a *transition* and not
  a card kept in `convs` for half a second — which is the shipped bug in `restore.md` wearing a
  nicer face — is argued in `restore.md`, "An agent's close fades; yours goes at once".

Cards are placed on a fixed pitch (`SLOT_W`/`SLOT_H`) that does not change with zoom, so
**every density's card must fit its slot** — `CARD_BOX` in `layout.ts` records the size each
one draws at, and `layout.test.ts` asserts the invariant. It did not always hold: `open` drew
a 288-wide card on a 248 pitch, covering exactly the strip where the neighbour's context ring
sits. `open` therefore grows downwards only. Changing a `[data-lod]` size in `Card.svelte`
means updating `CARD_BOX` to match.

**The viewport is two boxes, and the split is what keeps the text sharp.** It was one,
carrying `translate(x, y) scale(s)`, and every card on the wall was soft at most zoom levels.
A `scale()` re-lays-out nothing: the subtree is laid out once at scale 1, rasterised at
whatever raster scale the compositor picked, and that bitmap is stretched. Chromium
re-rasterises when the displayed scale drifts far enough — but `will-change: transform` is a
promise the transform will keep changing, so it deliberately *pins* the raster scale instead
of re-rastering per frame. Sharp where the two happened to agree, smeared everywhere else,
occasionally snapping into focus a moment after the wheel stopped. It reads as a
machine-specific fault and is not: at 1.5× or 2× device pixel ratio the extra samples hide it,
so the same build looks fine on one monitor and poor on another.

So `.pan` translates and `.layer` zooms. A translation cannot change the raster scale, and
`zoom` is not a transform — it multiplies used lengths, so the subtree genuinely re-lays-out
and every glyph is rastered at the size it is shown at. Three things follow:

- **`will-change: transform` is worn only during a gesture** (`moved()`, released 180ms after
  the last movement). Holding it permanently is what pinned the raster scale, and it also
  costs subpixel antialiasing, since a promoted layer gets greyscale AA.
- **Nothing else had to change.** Everything on the wall is positioned in canvas units with
  `left`/`top`, which `zoom` scales; and `toCanvas`, the drag deltas and `reveal` all work off
  `studio.scale` rather than reading the DOM. `getBoundingClientRect` accounts for zoom, so
  the control surface's `dom` and `real.click` are unaffected too.
- **`zoom` re-lays-out, so card boxes are no longer exactly linear in the scale** — layout
  rounding moves them a fraction of a canvas unit between densities. Harmless against
  `CARD_BOX`, which has ~11 units of slack under `SLOT_H`, but it is why cards are all
  `white-space: nowrap`: text that wrapped would wrap *differently* at different zooms.

`-webkit-font-smoothing: antialiased` in `tokens.css` stays, deliberately. Removing it brings
back Windows subpixel AA, which puts colour fringes on every glyph — on this wall colour is
status, and greyscale AA at the correct raster size is sharp without it.

`.layer` is `inset: 0`, so at rest it
covers the surface exactly. "The ground" therefore cannot mean `e.target === surface`, which
was true *nowhere*: panning worked only in the margin the layer had been translated off, so
the wall felt draggable in some places and inert wherever the projects were. `handleOf`
asks what the press is *not* on instead — it is the three-way successor to `isGround`, which
had only to tell the ground from everything else while the one thing a left press could do
there was pan. For the same reason the surface sets
`user-select: none` — a press-and-move on the wall is always a gesture, and without it
dragging a card highlighted its title instead of carrying it. The transcript panel is
outside the canvas and stays selectable, because that is where you read and copy.

**The right button pans from anywhere**, which is the one place `handleOf`'s answer is not
asked.
Panning is how this wall is read, so the gesture that does it must not be something the wall
can be too full to offer — and it was: a right-drag begun over a card, a widget, a reference
image or any button inside one of them did nothing, so the denser a territory grew the less of
it you could take hold of, and the places you most want to move away from were the places you
could not. **The middle button pans beside it**, added when the left button stopped panning
(see the selection section below): it is what every other canvas in the world pans with, and
it is the one that is still free while the right button is on its way to a menu. The left
button still asks what is under it, because there the answer is the difference between drawing
a selection band and carrying what you have got hold of; nothing standing on the wall wants a
right- or middle-drag for itself. Four things make it hold everywhere:

- **The press is read in the capture phase**, on `.surface` *and* on `.glass`. Bubble was
  enough while only bare ground counted; the things standing on the wall stop presses of their
  own — a widget's move gesture, a grip, a card's buttons — and the pan that works everywhere
  cannot be the last handler asked. The glass is the sharper half: it is a *sibling* of the
  surface, not a descendant, so a press on a card stuck to the pane never bubbles anywhere the
  wall can see.
- **The pointer is not captured until the press has travelled** — the same "a press is a click
  until it has travelled" rule every gesture on this wall follows, for a sharper reason.
  Capture retargets everything after it, and a plain right-click on a card's composer has to
  reach that composer for the menu to know it was aimed at an editable. Capture at 4px, so a
  pan that wanders off the window still stops dead nowhere. That rule is now stated **once**,
  in `groundDown`/`groundMove`, for all three gestures and all four kinds of thing — it used to
  be written out separately in `Canvas.cardDown`, `Canvas.terrDown` and `WidgetNode`, and
  `ImageNode` never had it at all.
- **The moves and the release come off the window**, added on the press and removed on the
  release. Between the press and the 4px there is no single element guaranteed to see them —
  the press may have landed on the glass, and the cursor may already have left whatever it
  landed on.
- **A right-press that *moved* swallows the `contextmenu`** Windows fires on release: the
  gesture was "move the wall", not "ask the wall something". Also at the window and in the
  capture phase, since that event is aimed at whatever the cursor was over rather than at the
  surface, and the studio's own menu handler sits above both. The flag is cleared on every
  press as well as on use — a right-drag released off the window fires no `contextmenu`, and
  the flag left standing ate the next honest right-click.

Typing on the wall with a card in hand goes to the dock's field, carrying the
keystroke that started it across by hand: focus moves during that same keydown, and what
happens to that character is not something to leave to the browser. It is suppressed while a
menu is open, which is also why a `menu` op left open by a failing test makes the next
typing test look broken.

**Tab steps the focus along the wall**, shift+Tab back, from anywhere that is not a field —
in the wall's own reading order (`wallOrder` in `layout.ts`: territory by territory, top row
first), not open order, since a pinned card keeps its place in open order while sitting
anywhere. It lands on a card exactly as clicking it does — focus *and* the gathering, or the
dock would still aim a broadcast at whatever was picked before — and `Canvas.reveal` pans the
least that brings it into view, never zooming, because a selection you cannot see is worse
than none. Tab therefore no longer walks the browser's focus ring here.

**But not while anything is asking.** With cards in `waiting`, plain Tab walks *those*, in
urgency order — the dock's `N waiting` chip is the same cycle, and the chip's shortcut hint
says so. Only when nothing wants you does the key fall through to the whole wall
(`cycleTab` in `App.svelte`). So the unmodified key means "the next card I care about", which
is one gesture whose *answer* changes rather than two gestures to choose between: with four
cards amber, stepping through eleven to reach them is work nobody asked for, and with none
amber a waiting-only key would be dead. It was the other way round once, Ctrl for the waiting
list, and the modifier was on the wrong one — the thing you reach for most got the harder
chord.

**Ctrl+Tab is always the whole wall**, waiting or not. That is what pays for the plain key
shifting under you: there is one binding whose meaning does not move, so a card that is not
asking is still two keys away rather than unreachable until the wall goes quiet.

**Letting go is a click on bare ground, or Escape** — and it drops all three things that
being held consists of: the focus ring, the gathering, and the panel that the focus opens
(`ondeselect` in `App.svelte`, which the canvas can only *report* since the focus lives up
beside the panel). It used to drop one of them. `groundDown` cleared `studio.selected` and
nothing cleared `focusedId`, so clicking the wall left the card lit with its transcript open,
Escape did nothing anywhere, and there was no way back to a bare wall short of closing a
conversation. Two things about it:

- **On the release, and only if the press never moved.** Clearing on `pointerdown` meant
  dragging the wall to look at something dropped the gathering you had assembled on the way
  there — a pan is how this wall is read, not how you change your mind about it. Left button
  only (a right- or middle-press is on its way to a menu or a pan), and never when a band was
  drawn, since a marquee's own answer is what is selected afterwards.
- **Escape backs out of one thing, innermost first**, and anything that closes on Escape owns
  the key while it is open — the context menu and the adopt panel both listen on the window
  themselves, so `onGlobalKey` only has to stay out of their way (it runs first, App having
  mounted before either). A field is a step of its own: Escape with the caret in the draft
  blurs it and keeps the card, or a prompt already written would be left aiming at nothing.

The control surface's `deselect` op calls the same function rather than clearing the two
halves itself, and `snapshot.dom.transcriptOpen` is how a test sees the third.

## One selection, and the band that draws it

`pick.ts` is pure and holds all of it: what a modifier means, what a marquee covers, what a
drag carries. `Studio.picks` is where the answer is kept. Read that file's own head notes
first — this is what does not fit in them.

**There is one selection and it spans all four kinds of thing that stand on the wall.** There
used to be three, and none of them could hold two things of different sorts: `studio.selected`
was a list of card ids (the gathering a broadcast is aimed at), `Board.selected` was a single
image, `Widgets.selected` a single widget, and the two singletons deliberately cleared each
other so that Delete had one unambiguous target. A project's territory could not be selected
at all. So "these two cards and that reference, moved together" was not a sentence the wall
could say, and the only multi-select there was — a shift-drag that gathered cards — could not
reach three quarters of what was standing on it.

`studio.selected` survives as a `$derived` reading of the picked *cards*, in the order they
were picked. That is not a compatibility shim, it is the honest definition: the gathering has
always meant the cards that are selected, and everything that read it — the dock's targets, the
cards that wear the draft as their name-to-be, `snapshot.selected` — reads it unchanged.
`Board` and `Widgets` are each handed a `Picker` (`board.picks = studio`, beside
`board.scribe = undo`) so they can say "what I have just put up is what you are holding"
without owning a selection or importing `Studio` — the same injection `others` and `scribe`
already use, and the same no-op default.

**Left-drag on bare wall draws the band; left-drag on a thing carries it.** That is the
standard direct-manipulation arrangement, and the reason for it is that a wall you arrange
things on is a canvas, so the canvas conventions are the ones your hands already know. It cost
the left button its pan, which is why the middle button gained one (above).

Four decisions in here are the ones worth defending:

- **Ctrl toggles one thing; shift adds one and never removes; either one makes a band add
  rather than replace.** In a *list* — Explorer, a mail client — shift extends a **range**, and
  the range is the whole reason shift is there. This wall has a reading order (`wallOrder`) and
  it covers cards only, so a shift that meant "range" would mean it for one of the four kinds
  and quietly mean something else for the other three. On a *canvas* — Figma, Illustrator,
  Blender — shift is an add, and that is what this is. It is still worth having beside ctrl,
  because the two are different gestures rather than two spellings of one: shift can never cost
  you something you already had, and ctrl is how you take back the one you picked by mistake. A
  band does not *toggle* under either modifier, which is what symmetry would ask for — you
  cannot see what is already selected underneath a rectangle you are drawing, so it would be a
  gesture whose result you could not predict while making it. Explorer and Figma both add here
  too.
- **A plain press on something already selected leaves the selection alone; the *release*
  collapses it.** This is the subtlety the whole feature rests on, and getting it wrong makes
  multi-select useless rather than merely odd: collapse on the press and dragging a group by one
  of its members is impossible, because the group is gone before the drag starts. Hence
  `pressed` and `tapped` being two functions. It is the same shape as "the press is a click
  until it has travelled" one level up, arriving at the same conclusion from the other side.
- **A territory is caught by being *enclosed*; everything else by being touched.** Touched is
  right for anything you can pick up — a lasso you have to draw perfectly is a lasso you stop
  using — and wrong for a territory, which is `REGION_W` wide and as tall as its cards reach. A
  band drawn *inside* one to gather two of its cards touches it too, and a selection that
  quietly included the project would move the whole thing on the next drag. An area you have
  merely reached into is one you were reaching into to get at what is standing in it; an area
  you have drawn a box right around is one you meant. Same call Figma makes about a frame, and
  it leaves the territory's own name — already the handle you drag it by — as the precise way to
  pick exactly one.
- **A carry is one frame.** A selection may span the wall and the glass; a drag may not. The
  two measure a delta in different units — canvas units divided by the zoom against screen
  pixels taken as they come — so one gesture cannot honestly serve both, and a thing on the pane
  does not move when you drag something on the wall.

**One drag, four kinds.** There used to be two near-identical ones (`cardDown`, `terrDown`) and
two more inside `ImageNode` and `WidgetNode` that each moved only themselves — which is exactly
what a selection spanning the wall cannot be built on. Now the press is read by one
capture-phase handler on `.surface` and on `.glass`, `haulOf` says what is coming along, and
every frame writes `origin + delta` for all of it. Three consequences:

- **The move gesture came *out* of `ImageNode` and `WidgetNode`.** Each keeps only what is
  genuinely about itself: an image's scale and rotate, a widget's resize. Their grips carry
  `data-grip`, which is what `handleOf` steps over on its way to deciding what a press is aimed
  at — so the two live side by side with no ordering for anybody to get right, and
  `e.stopPropagation()` inside a grip is no help at all, since the wall's handler is on an
  ancestor in the *capture* phase.
- **A node beats an ordinary control inside it**, and the first cut had that backwards. It
  stepped over `button` — which stepped over every card on the wall, because `Card.svelte`'s
  whole body *is* a `<button>`. It does not need to step over them: the pointer is not captured
  until the press has travelled, so a press on a card's close button that goes nowhere is still
  a click on it, exactly as it was when `.node` ran its own `onpointerdown`. What genuinely is
  not the wall's is a grip and an editable — a drag across `.surface input`, which keeps
  `user-select: text` for the territory's worktree field, means selecting text.
- **`origin + delta` rather than an accumulation** is the bargain the two old drags already
  struck, and it earns its keep twice here: a pinned card that is both selected *and* inside a
  selected territory is written by two paths in the same frame, and computing from the origin
  makes those two writes agree instead of doubling. A *flowing* card in that position cannot be
  made to agree — it would be pinned where it stands and then have its territory's flow move out
  from under it — so `haulOf` excludes any card standing in a territory that is coming along.
  That is the one rule in the pure file worth reading twice.
- **`inHand` asks the haul**, so a card coming along because something else was grabbed is as
  glued as the thing under the pointer. It has to be: the FLIP animation on `.node` fires on
  every frame of a drag (see above), and one drag now moves several cards.

**One undo act for the whole press, across all four realms.** `undo.md` says a widget and an
image record themselves from inside their own classes, and they still do — every other route to
one is undoable by existing. A haul is the exception it already allows for: `haulMove` wraps its
writes in `undo.quiet` and `haulUp` records once, with every record it touched. Without that,
carrying a card, a widget and a reference together would be three presses to put back and the
wall would come apart in the order you happened to release it — the same argument that made a
territory of five pinned cards one press rather than six, one kind wider.

Selection itself is still not on the undo stack, for the reason `undo.md` gives, and gaining
three more kinds does not change it: gathering things up is how you are looking at the wall,
not something you made.

The wheel zooms at the cursor and shift+wheel pans — deliberately not Figma's convention
(which this was first), because the densities are the navigation here and panning has the
whole ground to drag. ctrl+wheel still zooms.

Placements live in SQLite next to the conversations they key on; only the *viewport* (pan,
zoom) goes to localStorage — see the note in `studio.svelte.ts` about not having two sources
of truth. Semantic zoom has three densities via `lodFor`: `field`, `wall`, `open`.

Reference images (`images.svelte.ts`, `reference_image` table) are deliberately not tied to a
project, are always hand-placed with their own size and rotation, and are *copied* into
`$APPDATA/references/` — which is also the only path the asset protocol scope allows. They
arrive either by being dropped in from another window, from `pin up an image…` on the
wall's own menu, or by being pasted — all three place them under the cursor.

**Paste is the only one of the three that does not start with a file**, which is the whole
reason it exists: a Windows screen capture leaves a bitmap on the clipboard and writes
nothing to disk, so there is no path for `import_image` to copy from and the wall could not
take the most common image anybody has to hand. `store.rs::paste_image` writes the bytes
into the same `references` directory and hands back a path, so everything downstream —
sizing, placement, the back band, the row — is `#place`, shared with a drop.

- **The bytes come off the `paste` event, not `navigator.clipboard.read()`.** The async
  clipboard API wants a permission the webview may prompt for or refuse; a paste is a
  gesture you already made and carries its own data. Chromium hands a clipboard bitmap over
  as a `File` in `clipboardData.files`, so a screenshot and a copied `.png` arrive by the
  same route. `clipboardData` is only valid during the event, so the files are read out
  synchronously before the first `await`.
- **They ride the IPC as a raw body** (`invoke("paste_image", arrayBuffer)` →
  `tauri::ipc::Request` → `InvokeBody::Raw`). A `Vec<u8>` command *argument* is serialised as
  a JSON array of numbers, which for a two-megabyte screenshot is around eight million
  characters of text.
- **The format is sniffed from the bytes** (`sniff_image`), never taken from the front end's
  `type` string. The extension it returns names the file, and the asset protocol serves a
  content type off that name, so a guess here would be served as a lie later. Anything
  unrecognised is refused rather than written — a clipboard also holds audio, html and
  shortcuts.
- **Position comes from the cursor, because ctrl+V has none of its own.** App tracks the last
  pointer position in a plain `let` rather than `$state` — a pointermove fires dozens of times
  a second and nothing is drawn from it. Off the wall (over the transcript, or never moved
  since launch) it falls back to `Canvas.center`, the middle of the *view*: the canvas is
  unbounded and its origin can be miles from anything you are looking at.
- **Text beside the image wins inside a field.** Copying from a web page puts both on the
  clipboard, and a paste into the draft you are writing means the words. Image-only in a field
  still pins, since there is nothing else it could mean — Skein's prompts are text on a child's
  stdin and there is nowhere for a picture to go.

The control surface has an `image.paste` op, which moves the cursor with a real pointermove
and then dispatches a real `paste` carrying the bytes in a `DataTransfer` — every seam except
the one thing nothing in a webview can reach, which is the OS clipboard itself. **So whether
WebView2 hands a screenshot over as a file at all is the one claim here no test makes**; it
takes a hand on ctrl+V, and it is the first thing to check if this ever appears to do nothing.

**One stacking order for the whole wall**, in `layout.ts`: `Z_CARD` / `Z_CHIP` are set inline
from there rather than in CSS, and images stack in two bands around them — `nextBackZ` for a
reference that should sit behind the work, `nextFrontZ` for one brought to the front. It was
not one order before: cards were pinned at 1000 and chips at 1001 in CSS while an image's
z-index was its own small `z`, so the front-most image on the wall still drew behind every
card and every `+`, and `bringToFront` could only reorder images among themselves. Widgets
(below) share those bands, which is why `Board` and `Widgets` are each handed the other's
`z`s (`others`) — computed apart, "bring to front" would only mean "in front of the other
clocks".

## An agent putting something on the wall

`pin` (`pin.rs`). An agent that has *made* something to look at — a diagram, a chart it
rendered, a screenshot of the thing it just changed, a frame out of a render — had one way to
hand it over: write the path in the transcript. Which costs you four gestures (read the line,
copy it, find something to open it with, come back) and at no point puts the thing on the wall.
There is a wall, and it already draws images.

- **Rust copies; the wall places.** `store::copy_into_references` is the filesystem's half and
  has to be Rust's — a copy rather than a link, for `import_image`'s reason. Sizing cannot be:
  the only thing on this machine that knows how big a PNG is without decoding one is the
  webview (`#measure` reads `naturalWidth`), and an image placed at a guessed box arrives at
  the wrong aspect ratio, which for a diagram somebody made on purpose is the failure worth
  avoiding. So `pin.rs` validates and copies, then emits `pin:asked`.
- **It goes through the same `#place`** a dropped file and a pasted screenshot go through —
  `Board.pinned` is a door onto it rather than a second path — so a pinned image arrives at the
  same size, in the same z-band, and on the same undo stack. The note already on
  `images.svelte.ts` about pasted and dropped images arriving alike is the same argument with a
  third caller.
- **`Skein.onPin` is a hook, not a `listen()` in `App.svelte`.** `skein.svelte.ts` is the only
  thing that talks to Rust, and a second subscription is a second thing to release in
  `onDestroy` — the rule `listeners.ts` states and `board.others` already follows. The images
  live in `App.svelte`'s `Board`, so the point is computed here and handed out.
- **`Skein.spotBeside` comes off the same `layout` the canvas draws from**, so an image lands
  beside the card you are looking at rather than beside where that card would be under a
  different arrangement. It hands back the *card*, and `pinSpot` turns that into a point once
  the box is known — see the section below for why it cannot be the other way round. Right and
  slightly down, because left is where the territory's next card goes and directly below is the
  row beneath it. A card the layout does not know falls to the origin — a visibly wrong answer
  rather than a silent one, since the image is at least on the wall and can be dragged.
- **Four a minute per card.** The wall is the user's, and nothing on it may fill faster than a
  person can clear it — every pin is also a file copied into storage that somebody takes down
  by hand. The refusal tells the agent to pin the one that matters and describe the rest.
- **Images only, and that is a boundary rather than a stage.** A pinned text note would want a
  widget kind, a config, a face and a rule of its own, and what an agent has to *say* it can
  already say in the transcript, where the panel renders it properly. What the transcript
  cannot do is show you a picture beside the card that made it.

### And then the second one landed on the first

Every pin went to the card's corner plus a gap, so the second one landed on top of the first
and the sixth on top of five: one visible rectangle standing for six pictures, which from the
wall reads as the app having thrown five of them away. Reported as images spawning on top of
each other at a random location, and the "random" half is the same fact seen from further off
— a picture arriving somewhere nobody chose, indistinguishable from the last one.

Fixed at both ends, because it is two problems wearing one symptom: the wall was putting them
in the same place, *and* the agent had no way to say "this replaces that".

- **The size has to be known before the spot is chosen**, and that is the structural half.
  `pinSpot` takes the real box, so `Skein.spotBeside` no longer returns the spot — it returns
  the **card**, and `Board.pinned` picks the point after `#measure` has answered. Tried the
  other way first: a walk in `spotBeside` has to reserve a nominal square of `DROP_MAX_EDGE`,
  which is wider than the step between two landscape images and therefore rejects every
  candidate next to a taken one. It walked in a way nobody could predict. `#place` now takes
  either a point (a drop aimed at one) or a function of the box (a pin, which did not).
- **The first spot moved, and it moved because it never did what its own comment said.** That
  comment promised an image "just clear of a card"; the code put the image's *centre* a gap
  past the card's right edge, so half of it sat behind the card. Harmless-looking, because a
  reference lives in the z-band below the work, and still wrong: an image half-hidden behind a
  card is one you cannot read without moving something. It is the left edge that is a gap clear
  now, and `test/layout.test.ts` asserts which.
- **Three to a row, then another row underneath.** So a card that keeps pinning builds a block
  that stays roughly square rather than a line that ends up a screen from the card it belongs
  to. It does **not** keep the pins clear of other territories and no number would: a territory
  is `REGION_W` wide and one image is nearly that on its own, so even the first pin reaches past
  the edge of the one it stands in. Accepted rather than solved — a pin over somebody else's
  cards is *behind* them, and the wall is yours to drag.
- **Every image counts as occupied, not only the pinned ones.** Something you dragged into the
  gap beside a card is exactly as much in the way as something the wall put there. Glass-stuck
  images included: one is drawn in screen space but still holds the ground it came from, which
  is the rule `glass.ts` states for everything else.
- **The walk gives up rather than refusing.** Past `PIN_COLS * 6` candidates it returns the last
  one and stacks after all. Same judgement `spotBeside` already makes about a card the layout
  has never heard of: a visible wrong answer beats a file in storage with nothing drawn, because
  a wrong answer can be dragged.

### An image has a name, and only the card that made it may change it

`repin` and `pinned` are the other end of the same bug. However well the wall places them, an
agent iterating on a render will put up a seventh copy unless it has a way to say the seventh
*is* the first — and it had none, because a pinned image had no name it could refer to.

- **Rust mints the id now**, rather than `#place` doing it, purely so that `pin` can *say* it in
  its answer. That one change is what the rest rests on. `crypto.randomUUID` still names
  anything you drop or paste, since nothing needs to refer to those.
- **`reference_image.pinned_by`** (schema v21) is a **permission, not a provenance note**, and
  the distinction is the whole of why the column exists. `repin` refuses a row this card did not
  write. The wall is the user's; an agent able to overwrite the source of any rectangle on it —
  a photo you dropped this morning included — is a far larger capability than the one being
  asked for. Same argument `spawn.rs` makes about which cards a card may close, and the same
  shape: the intent is recorded when the thing is made, so the question is answerable at the one
  moment it is asked. Written by the front end with the rest of the row, so there is no window
  in which an image exists with nobody's name on it.
- **"Not yours" and "no such image" are different answers.** A card naming an id it read out of
  a transcript is told the image is not its to change, which is actionable; told the image did
  not exist, it would go looking for a bug.
- **A new file is re-measured and kept centred.** A newer render is very often a different
  shape, and reusing the old box would stretch it — which is the same reason the sizing cannot
  be Rust's, arriving by a second route. Centred rather than corner-anchored so an image that
  changes aspect ratio grows about its middle instead of walking across the wall a version at a
  time. The old copy is left on disk for `sweep_references`, the bargain `delete_image` already
  strikes: undo has to have something to put back.
- **A move is named, never measured.** `place` takes `beside the card`, `to the front` or
  `to the back` and there is no `x` or `y` — deliberately, and `pin.rs` has a test that says so.
  An agent cannot see the wall, so a coordinate it supplied would be a guess nothing could
  check, and the wall's own walk already knows the sizes, the gaps and what is in the way, which
  is everything the number would have to encode. What is left is the three things a card
  genuinely means.
- **`pinned` reads and promises nothing more.** It answers what this card has up — id, file
  name, how long ago — and says out loud that it cannot tell you what the wall *looks* like.
  Where things are is the user's arrangement, made with a mouse; a list of coordinates is not
  something an agent can act on. Oldest first, because "the one before this" is the only
  ordering an agent can name.
- **A repin that only moves something is free of the rate.** Nothing is copied and nothing new
  appears. One carrying a new file spends one of the four, because a card looping render →
  repin is writing a file into storage every time round, which is the cost the rate bounds.
- **Every arm goes through `update` or `remove`**, so an agent changing the wall is exactly as
  takeable-back as you changing it. And an image that has gone between the ask and the answer —
  the user took it down mid-turn — is a silent no-op: the tool has already answered the card,
  and the wall is theirs.
