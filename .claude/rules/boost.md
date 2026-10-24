---
paths:
  - "src/lib/boostfield.ts"
  - "src/lib/boostview.svelte.ts"
  - "src/lib/boost.ts"
  - "src/lib/boost.svelte.ts"
  - "src/lib/BoostIgnition.svelte"
  - "test/boostfield.test.ts"
  - "src/lib/ChatView.svelte"
  - "src/lib/Sidebar.svelte"
---

# Boost's look

Boost mode (`accounts.md`, *Credits and boost mode*) is the wall spending the organisation's
API credits after a subscription has run out. Lyss asked for it to look and sound like a Final
Fantasy last battle, *"now this is the real deal, this is our last battle to save the world,
forget all the things about professionalism and keeping things with a specific direction"*.
`boost-music.md` is the sound. This is the light.

## What she chose, and what she sent back

The first round was three still mockups (crystal & void, ember & crown, eclipse), rendered
HTML screenshotted to PNG. She sent all three back: *"your mockups don't look that great, and
they have no motion, put more work into it, I'd like have a few the user can choose from."*
Every lesson below comes from taking that literally:

- **Motion is shown, not described.** Each look is a renderer (`boostfield.ts`) and was judged
  as a ten-second video recorded from that renderer: the ignition, then a limit break on a card
  at ~3s, then the look at rest. The harness lives in a card's scratch (`proto/wall.html`
  imports the bundled renderer; `record.mjs` drives Playwright's `recordVideo`). **The
  recordings are the code**, so what she approved is what ships, frame for frame.
- **A few to choose from.** All four approved looks ship, and she picks one in the app (the
  accounts panel's credits band, or `space m l`).
- **Second round notes, both taken.** Crystal: *"the dot in the background don't move, it looks
  like a png and a 2010 rythm game"*, so its stars now drift in three depths at three speeds,
  and a shooting star crosses every few seconds. Ember: *"the flames at the bottom need to look
  much better"*, so the teardrop sprites went and a real fire simulation replaced them (below).
  Both approved on the third look.

## The four looks

| look | what moves | status readable? |
|---|---|---|
| crystal | stars in three parallax depths, a great heart crystal and faceted shards turning and glinting, soft beams, nebulae, a shooting star | yes — violet and ice |
| ember | a simulated fire along the foot of the wall, embers cooling as they rise, gold sparks, heat shafts | **no** — gold beside amber, red beside rust |
| eclipse | a breathing corona with turning streamers, a bead of light round the rim, feathers falling, lightning every ~10s | yes — monochrome |
| abyss | swaying light shafts, a caustic net glowing across the top, bubbles and motes rising, a vast silhouette passing about once a minute | yes — azure |

## The one place on the wall decorative hue is allowed, and how it is confined

The wall's rule is that colour is status. Boost breaks it on purpose, at her word, and the
break is fenced in the way the synth's is (`toys.md`):

- **Hues are named only in `boostfield.ts` and the boost components.** Nothing touches
  `tokens.css`. The look reaches the CSS as `--boost-*` custom properties set on the studio
  root, only while boost is on (`App.svelte`, `data-boost`).
- **The wall stays visible, unlike the synth's overlay**, so a look either keeps clear of the
  three status hues or says it does not. `Look.legible` is that claim, and `test/boostfield.
  test.ts` holds it: every saturated accent of a legible look sits at least 35° of hue from
  celadon, amber and rust, and ember is asserted to be within reach of amber. The picker's
  tooltip for ember says asking and failed read less clearly under it.
- **Every fill is opaque.** `--boost-card` is a six-digit hex and the test says so. The first
  harness mixed colours with `color-mix` percentages that did not sum to 100%, which yields
  alpha, and every card came out see-through. That breaks the rule CLAUDE.md states, that
  nothing standing on the wall may be transparent.

## What it costs, priced against `motion.md`

The term that matters is the **present rate**: any frame that changes makes the whole window
present. So:

- **A field draws at most 30 frames a second (`FPS`)**, `spare` motion 8 (`SPARE_FPS`), and
  **`still` draws one frame and stops**, as does the system's reduced-motion. The setting is
  read off `document.documentElement.dataset.motion`, where every stylesheet reads it, rather
  than threaded in. A moment (an ignition, a limit break) is a one-shot and still plays under
  `still`. One-shots answer to reduced-motion, not to the wall's setting.
- **A hidden window draws nothing** (`document.hidden`).
- **Every glow is a sprite drawn once at resize and blitted**: soft dots, beams, a shard with
  its glow, a feather, the corona's streamers. `shadowBlur` and `filter` per particle per frame
  are what is expensive in a 2D canvas, and none is used in a frame. What must be soft *and*
  move is drawn small and scaled up: the abyss's caustics at a sixth, the ember's fire at a
  quarter. That blurs it for free and costs a sixteenth to a thirty-sixth of the pixels.
- **The air canvas draws only while a moment is in flight** and is cleared once after, so an
  idle wall in boost pays for one canvas, not two.
- **No `box-shadow` animates.** A card on credits wears a turning edge: a conic gradient
  rotated by `transform` on a pseudo-element, which the compositor does for free. Its glow is
  static. The title bar's sweep is a `background-position` on a 1px line. Every endless
  animation has its `[data-motion="still"]` and reduced-motion arms beside it, which
  `test/styles.test.ts` enforces.

## Two canvases, because a burst behind a card is a burst the card hides

The field is drawn **in the ground**: a canvas in `Canvas.svelte`'s `.surface`, after the
ambience backdrop and before the roots, so it sits under everything standing on the wall.
While boost is on, App hands the backdrop no profile, for the synth's reason: two full-screen
fields on one frame loop, one of them covered.

The moments are drawn **in the air**: a second canvas after `.pan`, over the cards and inert.
The first harness drew a limit break's shockwave in the ground. The card it was about covered
most of it, which is the opposite of the point.

`Field.frame` is the atmosphere, `Field.overlay` the moments. `boostview.svelte.ts` runs both
from one `requestAnimationFrame`, as Svelte attachments (`{@attach boostView.ground}`), so the
wall's markup gained two canvases and nothing else.

## Chat view wears it too, in its own way

Lyss, while this was being finished: *"don't forget to also support the chatview natively."*
Chat view is a second room over the same wall (`chatview.md`), and the wall is offstage under
it at `display: none`, so the wall's canvases would draw nothing there at full cost. So:

- **One field at a time, mounted by whichever room is in front.** `Canvas.svelte` mounts its
  two canvases only while the view is not chat; `ChatView.svelte` mounts its own in the sheet.
  `BoostView` is a singleton, and a switch can attach the new canvas before the old one's
  teardown runs, so a teardown lets go only of the canvas it was handed.
- **The sheet is the battlefield, and the reading is never set over it bare.** A veil of the
  look's dark stands behind the column (`.veil`), four fifths opaque and feathered at the sides.
  The first cut was fully opaque and pushed the whole field to two narrow margins. At 80% a
  crystal or a flame behind a line of prose is a dim glow, not a shape, and the field still
  reads across the sheet.
- **The room's surfaces take the look's dark.** `--cv-lift`, `--cv-hair`, `--surface` and
  `--raised` are re-set on `.chat` while boost is on, so the message box, a selected row and the
  buttons are lit in the look's colour instead of the studio's brown. They are set where the
  look is worn rather than in each component.
- **The sidebar is the wall's cards, as rows.** A conversation on credits carries the look's
  crest before its title and a static line of its light down the row's edge. A list of turning
  edges would be a list nobody could read. A row going onto credits flares once: a band of light
  crosses it and the element leaves the document.
- **A limit break has nowhere obvious to burst from**, since there is no card. The selected
  conversation's message box is `data-boost-anchor`, so its burst comes from where you type. A
  row in the sidebar bursts from the sheet's edge at the row's height, so the shockwave comes in
  from the side it is on. `#cardCentre` passes over anything measuring nothing, because the
  offstage wall's cards are still in the document at zero size.
- **The ignition plays over the sheet** (`BoostIgnition.svelte`, a second instance).
- **The title bar takes the same light and sweep**, and its sweep answers to all four motion
  readings (`spare` steps it), which `styles.test.ts` requires of every chat-view component.

## Boost wears the studio's ground, whatever skin is on

Every look is a dark scene drawn against the studio's ground. On a light skin, boost's cards
and veil were dark slabs under the skin's dark ink, and the wall was unreadable. So while boost
is on, `skin.wear("studio")` paints the studio in place of the chosen skin. Painting is exact
both ways (`theme.md`), so the chosen skin comes back byte for byte when boost goes off. Nothing
is stored: the ring, the panel and `skin.theme` go on naming the skin you chose. Checked in the
lab with `sugar`: `ground` reads dark with boost on, light with it off, and the skin stays sugar.

## The ignition a listener alone never heard

The first in-app run (as opposed to the recordings) showed no ignition at all. The switch marks
`ignite` in the same call that turns boost on. The field is mounted *because* boost is on, so its
canvas, and the listener in `#start`, arrive a beat after the moment they exist to show. The
recordings never saw this, because the harness marked the ignition itself after mounting.

`boost.ignitedAt` is the fix, and it is `limitedLately`'s shape: a field that mounts asks after
the moment that mounted it, and plays it if it is under 2.5s old and not the one it last played.
That last clause stops a switch between the wall and chat view a second later from replaying it.
The general shape: **a listener installed by the thing an event causes will never hear that
event.** Ask after it instead.

## The moments, as light

`skein.svelte.ts` marks them (`boost.mark`), the score hears them, and so does the look:

- **ignite** (boost switched on): the field's flash and shockwaves in the air canvas, and the
  title card (`BoostIgnition.svelte`). A dark band opens, a line of light runs through it, and
  "boost — the last battle" stands in it for two seconds. Keyed on `boostView.ignitions` so it
  plays once per switch, and gone from the document when it ends, which is `motion.md`'s rule
  for anything that celebrates.
- **limit** (a card went onto credits): a shockwave and a spray of sparks from the card's
  centre in the air canvas, and the card itself flares "limit break" (`Card.svelte`). The card
  listens to `boost` rather than being handed anything. A new card spawned straight onto
  credits is marked a moment before it is drawn, so `boost.limitedLately` lets it flare when
  it arrives (2.5s of memory).
- **victory** is the score's alone. A turn finishing is not a thing the wall should flash at,
  and the fanfare is rationed to one per 90 seconds besides.

## The fire, since it is the one that took three goes

The ember look's flames are **simulated, not drawn**: a heat field a quarter of the wall wide.
Each frame the foot is fed from two slow waves and some noise, so hot and cool stretches move
along it. Every cell above takes the heat of the cells below it, drifted by a wandering wind,
less a little. That is the whole of how a flame rises, licks and dies: the old demo-scene fire.
A 256-entry palette maps heat to colour, with alpha rising with heat so the cool top dissolves
rather than stopping at an edge. It is drawn once scaled up, then once more slightly larger and
added on top for the glow. The first cut stamped teardrop sprites that only flickered in size.
That is a drawing of fire, where heat that moves is fire.

## Where it is chosen

- **`space m b`** switches boost; **`space m l`** cycles the look and says which.
- **The accounts panel's credits band** (`space a`) names all four looks, marks the one in
  force, and carries each look's blurb as its tooltip.
- The look is this machine's, in `localStorage` (`skein.boost.look`), beside the switch it
  decorates.
- The control surface's `boost` op takes `look` and, with `mark=limit`, a `card`, so a lab can
  play a limit break on a real card's face. The snapshot reports `look` and `worn` (the studio
  root's `data-boost`).
