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
- **The write is split from the save.** A mooring drag sets a berth on every pointer move, and
  serialising every room's moorings to `localStorage` sixty times a second to record a gesture
  that is not finished makes a drag feel heavy for no reason anybody asked for. `save()` is
  called when a gesture ends — the bargain `gripUp` already strikes with `studio.save`.
