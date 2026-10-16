---
paths:
  - "src/lib/berth.ts"
  - "src/lib/berth.svelte.ts"
  - "src/lib/Dock.svelte"
  - "test/berth.test.ts"
---

# Berths

### Where the two things you work *in* are moored

The transcript panel was nailed to the right of the wall and the dock to the bottom. On one
screen that is a reasonable thing to have decided for somebody. Over three it is not: the wall
is spread across all of them and the thing you type into is pinned to the corner of one.

So both have a **berth** — a site, and a box for when the site is nowhere:

- the panel: `right` (where it has always been), `left`, or `float`
- the dock: `bottom` (where it has always been), `top`, or `float`

**There is deliberately no `top`/`bottom` for the panel or `left`/`right` for the dock.** A
transcript is a column and the dock is a line of text; a panel lying along the bottom is a
letterbox and a dock standing up the side is a column of three-character lines. Offering a site
that cannot be read is not the same as offering a choice.

### A dock along an edge takes all of it, or what the panel leaves

Lyss, 2026-10-16: *"it's literally impossible to dock chat to a side, and dock the dock to top
or bottom but more focused to a corner, so that instead of taking the full width and taking
space away from the chat, it takes the available width … if i'm aiming at the bottom center of
the screen or top center then it's full width, otherwise it's not."*

The three sites were right and the argument above still holds — but a moored dock took **the
whole edge**, under the panel as well, so a transcript moored to a side lost its foot (or its
head) to a line of text that had no reason to be over there. So a dock moored top or bottom has
one more thing to say, `extent`: `full`, the whole width (what it always did), or
`available`, the width the panel leaves — the dock stops at the panel's border and the panel
runs on from the title bar to the bottom of the window.

- **A field beside the site, not three more sites**, and this is the reasoning the "not six
  sites" paragraph above had to be re-read against. Six sites would be the *same* mistake that
  paragraph refuses, from the other side: a site is where a surface is, and an
  available-width dock at the bottom is *at the bottom*. Every reader that asks where the dock
  is — the chrome `arrange.ts` remembers per mooring, the bar's `order`, the handle — has the
  same answer either way and has no business learning a second spelling of it. The chrome in
  particular is untouched for a reason, not by luck: `main.wall` still ends where the dock
  begins (below), so the pane is the same height at either width. And a field degrades
  better than a site: an older build reading this one's berth drops a key it does not know and
  keeps the edge, where an unknown *site* would have sent the dock back to the bottom.
- **The middle is the narrow target, and the corners are everything else.** Her own words make
  the centre the special case, so `CENTRE` is a band of ±112px about the room's middle and the
  rest of the edge is a corner. Asked of the point the dock is *carried by* — the middle of its
  top edge, where the handle is — rather than its top-left, which also became the dock's
  `inside` test: carried by its top-left, a dock barely narrower than the window could not
  reach the left-hand corner without that corner leaving the room and the drop floating.
- **`CENTRE` is bounded by the narrowest panel, and that is the number that decides it.** An
  available-width dock is centred on what the panel leaves, so its handle sits half a panel off
  the room's centre — at least `PANEL_MIN / 2`, 150px. A band wider than that, less the
  handle's half-width and the drag's slop, and the first pixel of dragging that dock finds its
  own handle in the middle and throws it across the window: `EDGE`'s box-not-cursor bug, one
  axis over. `test/berth.test.ts` holds the numbers against each other.
- **The grip is kept at its share of the box, not its pixel offset.** The dock is carried as a
  box `dockAt.w` wide (its floating width) whatever it is drawn at, and a moored dock is far
  wider. Keeping the grip's pixel offset — what the drag did for the panel and still does —
  put the carried box's middle hundreds of pixels left of the hand, which made the extent
  depend on where the dock *used* to be, and dropped a floated dock with its handle nowhere
  near the cursor (that second half was a bug before any of this).
- **Which corner is not kept.** An available-width dock fills what the panel leaves, so it is
  always in the corner away from the panel, and the side you aimed at could only matter to a
  dock narrower than the room's free width — which nothing draws. Aimed at the corner *under*
  the panel it still means "not across the panel", and the panel's own side says where that is.
  So it follows the panel from one side to the other untold, which is what "keep the chat's
  column" means. Filling the free width rather than having a width of its own is the same
  decision: a corner dock you could also resize would be a second floating dock with an edge
  stuck to it, and the floating one already exists.
- **With nothing beside it, available is the whole room.** A floating panel divides nothing,
  and neither does one that is not open (no card focused), so the dock is drawn full width and
  remembered as available — moor the panel and the dock steps aside without being asked.
- **Too little left and it takes the full width instead** (`dockInsets`), rather than a field
  narrower than `MIN_W`, the floor a floating dock already has. `panelWidth` keeps `WALL_MIN` of
  wall, so this only bites in a window under about 540px.
- **Double-click puts back both**: the bottom, at the full width, which is where the dock has
  always been.

#### How the panel gets past the wall without the wall moving

The panel is a child of `main.wall`, and the wall ending exactly where the dock begins is
load-bearing for three things that should not learn about this: the glass (`a box cannot
escape its parent` is how it never covers the dock), the chrome `arrange.ts` remembers, and the
strip of kept files that sits on the dock's top edge. So the wall is left as it was and only
the panel is let out: **a negative margin on a stretched flex item grows it by that much**,
into the band beside the dock that the dock no longer covers. The dock steps aside by a margin
of the panel's width on that side. Both are numbers this file computes (`dockInsets`) and
`App.svelte` applies; neither is a second layout.

- **The band is everything between the wall and that edge**, so everything in it has to step
  aside too or be ordered out of it. At the bottom that is the voice bar, which sits between
  the wall and the dock: it gets its own box (`.heard`), is narrowed with the dock and is
  measured into the reach. At the top it was the fault bar, which fell *under* a top dock:
  it is now `order: -1`, directly under the title bar wherever the dock is, so it stays the
  full width and the band is the dock alone.
- **Measured as border boxes, fractions and all** (`bind:borderBoxSize`). The dock reported
  `clientHeight`, which leaves out its border and rounds — harmless for clamping a floating
  dock, and a hairline short of the window's edge for a panel let out by exactly that much at
  150%.

### Mooring is the room's, floating is the window's

`panelSiteAt` and `dockSiteAt` take the **chrome's** room — the window, or the home screen's
share of it while spread — because that is where an *edge* is. A float is placed and clamped
against the whole window instead. That asymmetry is the feature rather than an oversight: you
moor to the screen the chrome lives on, and you float anywhere at all, including onto a monitor
the chrome has never been on.

Two things that had to be got right:

- **A drop outside the room always floats.** The nearness tests are distances with no far side,
  so a drop on the monitor *above* the home screen was negative pixels from its top edge and
  moored there — which is the one drop that most obviously meant "put it over there, on that
  screen". `inside` is asked first.
- **The band is 72px wide.** The gesture is "put it over there", not "hit this line", and the
  alternative to a wide band is a surface that floats a few pixels off the edge you meant,
  which reads as the drop having failed rather than as a position you chose.

### A floating one owes `--span-*`

The studio root has `contain: layout` while spread, which makes it the containing block for
every `position: fixed` descendant (`span.ts`, and the rule stated in CLAUDE.md). A berth is
stored in **window** coordinates, so drawing it subtracts `--span-x`/`--span-y` back off — the
same thing `ContextMenu` and `Overflow` do, and both variables are zero when nothing is spread,
so the arithmetic is harmless on one screen rather than conditional.

`z-index` is the other half. A floating panel clears the glass (4), because the rule that the
pane may cover the panel is right for a panel filling an edge — the pane is in front of the
wall and the panel is the wall's furniture — and wrong for one you have deliberately placed,
which is the same kind of thing as what is stuck to the pane. A floating dock clears everything
(6): it is the one surface in this window that must never be covered, which is also why the
geometric promise in `glass.md` still holds in spirit when the dock leaves its edge.

### `localStorage`, not SQLite

A deliberate difference from a glass spot, and the argument is already written in
`studio.svelte.ts` beside `panelW`: how this window is divided is per-machine, disposable, and
no business being in the database. **Which edge** it is divided along is the same kind of fact,
and splitting a berth's site from its width across two stores would be the worse answer by some
way.

Keyed by screen arrangement (`arrange.md`) for the reason a glass spot is — the edge you want
the transcript on is a fact about the screens in front of you — with one guard the glass does
not need. **`last`**: the real arrangement key arrives a moment after launch, once the monitors
have answered, and without somewhere to look in the meantime the studio would draw in the
default berths and then visibly jump into yours. The room you were last in is very nearly
always the room you are in.

A room nobody has moored in yet is seeded from `last` rather than from the defaults — the same
"duplicated from the most similar setup" the glass does, with a cruder notion of *similar*,
because there are two enums and a rectangle here rather than a wall's worth of arrangement.

### The gestures

- **The handle, in the padding.** The transcript's reading column starts at the panel's own
  top-left — the two rails hang *outside* it, over the wall — so a handle in that corner would
  sit on the prose and quietly eat a click near the first line. The panel's padding is on the
  side facing away from the wall, which is also the side the handle has to mirror to when the
  panel moors on the other edge, so one rule gets both. The dock's is centred on its top edge,
  which is the one part of a line of text that holds nothing. Both are drawn smaller than they
  can be hit: nobody can aim at four pixels and nobody wants to look at twelve.
- **Double-click puts it back**, which is the offer `gripReset` already makes and for the same
  reason: a surface dragged somewhere unreachable on a screen you no longer have is otherwise
  something you fix by eye.
- **One sign, not three resize handlers.** The width grip is always on the edge facing away
  from the panel's own anchor — moored right it is on the left and dragging left widens; moored
  left or floating it is on the right and dragging right does. `gripSign` is the whole of the
  difference.
- **A floating panel's width is its own.** `studio.panelW` is how the *window* is divided and
  means nothing to a panel that is not dividing it, so the grip writes to the berth while
  floating. Writing one while drawing the other is how a drag ends up fighting a stylesheet.
- **The keyboard is `<space>w p` and `<space>w d`.** A chord cannot point at a place on the
  screen, so each cycles its three sites — starting from the edge that surface has always had,
  so going round the ring puts you back without having to remember which way it goes. `w` was
  already the window family, and its own note says placing a window is several verbs that want
  to sit together in the hint; this is that being taken up.
- **And `<space>w a` is the dock's width, a ring of its own.** Not two more stops on `wd`'s:
  where the dock is and how wide it is there are two questions, and one ring of five would
  have to be counted round — getting from the bottom to the top would pass through a width you
  did not ask for. So `wd` keeps the width as it moves (a dock beside the panel at the bottom is
  beside it at the top) and `wa` flips it where it is. `a` for *available*, her word. It says
  back what is now true (`dockExtentSaid`), because with nothing moored beside it, or the dock
  floating, the flip moves nothing you can see and would otherwise read as a chord that failed.
- **The write is split from the save.** A mooring drag sets a berth on every pointer move, and
  serialising every room's moorings to `localStorage` sixty times a second to record a gesture
  that is not finished makes a drag feel heavy for no reason anybody asked for. `save()` is
  called when a gesture ends — the bargain `gripUp` already strikes with `studio.save`.
