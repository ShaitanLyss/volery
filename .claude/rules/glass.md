---
paths:
  - "src/lib/glass.ts"
  - "test/glass.test.ts"
---

# The glass

### The glass

The wall is unbounded and zoomable, which is what makes it a wall — and some things you
want in front of you wherever you have panned to. So anything on it can be **stuck to the
glass**: a pane in screen space in front of the wall. Right-click, `stick it to the glass` /
`put it back on the wall`, on all four things that can stand on a wall — a card, a
territory, a reference image, a widget. Panning does not carry them, zooming does not
resize them, and they go over the transcript panel but never over the dock or the title bar.

`glass.ts` is pure and small (`stickTo`, `glassAt`, `spotOf`, `offsetBy`); the two frames are
`Canvas.svelte`'s; the columns are schema v9.

- **The glass changes where a thing is *drawn*, never where it is.** `layout` runs as though
  nothing were stuck to it at all — a glass card keeps its slot, a glass territory keeps its
  cell and holds its ground against its neighbours — so taking something off puts it back
  exactly where it was and **the wall never reshuffles because you stuck something to it**.
  That is position-is-memory applied to the one gesture that would otherwise break it in the
  worst available way: the thing you are looking at moving something you are not. It is why
  the glass position is a *second* pair of columns beside `x`/`y` rather than a reinterpretation
  of them under a flag — one pair whose meaning depended on a flag would make the round trip
  lossy, and the round trip is the whole feature.
- **The glass is 1:1**, which is what "does not zoom with the wall" means and also the only
  self-consistent answer — a size that tracked the wall's zoom would be a thing in screen
  space measured in canvas units. So a card on the pane draws at `wall` density, because
  that is the density 1:1 gives (`lodFor(1)`), and an image or a widget draws at the width
  and height it actually has.
- **Sticking preserves the centre, not the corner** (`stickTo`). It lands where it already
  looked to be — nothing jumps across the window — but at any zoom but 100% its 1:1 size
  differs from its drawn size, and growing rightwards off the place you were pointing at is
  the wrong half of that. Same argument as a dropped image being centred on the cursor.
- **"Over the transcript, never over the dock" is a fact about the DOM.** `.glass` is a child
  of `main.wall`, so it covers the wall *and* the panel beside it and cannot reach the header
  or the dock — a box cannot escape its parent. No z-index to keep winning, and no rule to
  remember when the next thing joins the dock. It is emphatically not inside `.surface`,
  which clips and stops at the panel's left edge. `overflow: hidden` is the other half:
  without it something dragged to the bottom edge would spill over the dock. `z-index: 4` is
  said out loud only because `.glass` comes *before* `.side` in the document, so source order
  would otherwise put the pane behind the panel it exists to be able to cover.
- **The pane is inert and each thing on it takes that back** — the `.rails` bargain. Without
  it an empty pane would swallow every pan on the wall and every scroll in the transcript.
  The one exception is a glass territory's own boundary, which is mostly empty space: on the
  wall that area pans (`isGround` decides by what a press is *not* on), and on the pane there
  is nothing to pan, so it would just be a large rectangle blocking the transcript. Its menu
  is still reachable through its name, which carries `data-cwd` and is the handle anyway.
- **A stuck territory carries its cards, and costs nothing to do so.** On the wall carrying a
  territory has to translate each pinned card by hand or the territory tears in two; on the
  pane a card is laid at the same offset from the glass origin that it has from the wall
  origin (`drawnAt` in `layout`), so moving the origin moves every card in it, pinned or
  flowing, and there is nothing to keep in step.
- **A card held on the glass by its territory is offered no menu item.** There are two ways
  to be drawn on the pane and only one of them is something you did to the card; "put it back
  on the wall" is a promise it cannot keep while its territory is still carrying it. Offering
  nothing is a real answer here, as it is for prose with no selection.
- **The pane is every screen while the studio is spread**, and a spot belongs to a *screen
  arrangement* rather than to the wall. Those two are one change: the pane used to be the home
  screen's share of the window even over three monitors, on the argument that what was stuck to
  the glass belongs to the home screen and stays there — which was right **given one set of
  spots**, since one set cannot describe two rooms and the alternative was that spreading
  scattered an arrangement you had made. `.claude/rules/arrange.md` is the other half, and
  widening the pane without it is the bug that argument was avoiding. What still hangs off the
  home screen is anything with no position of its own: the timeline stack, since centring a
  default across every screen puts it on a seam between two monitors.
- **Clamped where it is drawn, not where it is stored** (`glassAt`). The pane has edges where
  the wall has none, so a spot that was fine yesterday can be off it today — a narrower
  window, a wider panel, a smaller screen. Squeezing the window borrows a thing back from the
  edge and widening it gives it straight back, which is the bargain `panelWidth` already
  strikes. Fully inside rather than merely overlapping, since the pane clips; top-left wins
  for anything larger than it, as in `revealBox`. And an *unmeasured* pane clamps nothing —
  a box of zero is not a box with no room, and without that guard the whole glass stacks in
  the corner for the frame between mounting and the ResizeObserver's first call.
- **One layout pass, two frames, one set of snippets.** The markup is shared, so a card on
  the pane is the same card with a different origin rather than a second code path to keep in
  step. `glass` reaches exactly three things: which units a drag is measured in (divided by
  the scale on the wall, taken as it comes on the pane), where the result is written, and a
  card's density. The one thing that could not be shared is the `.node` wrapper, because
  `animate:` has to sit on the immediate child of a keyed each block and a `{@render}` is
  not one.
- **`save_placement` writes every column every time, and the front end hands it whole
  placements.** The two positions are set by different gestures, so a caller that spelled out
  only the one it had changed would silently clear the other — dragging a territory would
  un-stick every card in it, with no error anywhere to see it by. That is the same
  silent-drop shape as the `lastTier` bug below, and the reason there is no COALESCE here:
  `glass_x` has to be able to say "on the wall", which is exactly what a COALESCE cannot
  express (the reason `clear_conversation` is its own command).
- **`stick_project` is its own command** rather than two more arguments on `place_project`,
  whose own pair of nulls already means something else entirely — "hand it back to the grid".
- **The wall's own readings skip it.** A glass card is not caught by a marquee (it is not
  standing anywhere the rectangle passed over), `reveal` no-ops on one (it is already in
  front of you, and panning to the slot it still owns would move the view for no visible
  reason), and `fitAll` frames only what is on the wall, or Home would zoom out to frame an
  empty patch of it. Tab still reaches it: it is still in the reading order, because it is
  still in the territory.

Screen pixels in SQLite is unlike everything else in `store.rs`, and they are still studio
data rather than viewport state: where you put a thing is something you *made*, unlike where
you happen to be looking. What depends on the window is handled where it is drawn — and what
depends on the *screens* is handled by storing a set of spots per arrangement, which is the
same argument one step out.

The control surface has a `glass` op (`kind` + an id; with `x`/`y` it moves something already
on the pane, without them it is the menu item), and `snapshot` carries `glass` on each card's
placement, each project, each image and each widget — a card stuck to the pane and one that
was merely never pinned both read `pinned: false`, so the pair is the only thing telling them
apart. `snapshot.glass` reports the pane's own rect and size: the size is what `glassAt`
clamps against, and the rect is the whole of "never over the dock", which a test checks by
comparing it with the header's and the dock's.

