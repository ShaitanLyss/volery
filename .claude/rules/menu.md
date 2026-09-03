---
paths:
  - "src/lib/menu.ts"
  - "src/lib/ContextMenu.svelte"
  - "test/menu.test.ts"
  - "src/lib/presets.ts"
  - "test/presets.test.ts"
---

# The right-click

### The right-click

Chromium's own menu never appears — an undecorated window whose header *is* its title bar
has no business offering "Reload" and "Save image as…". `main.ts` suppresses it for both
roots, which also means the whole answer is Skein's to give.

`menu.ts` is pure and owns *what* a target offers; `ContextMenu.svelte` only turns ids into
calls. Offering nothing is a real answer, not a failure: right-clicking prose with no
selection opens no menu rather than an empty box, so the pure function returns `[]` and the
component is never mounted. Conditional items are swept for orphaned separators, because a
menu that opens on a horizontal rule reads as a missing item.

Two consequences elsewhere. `.region` lost its `pointer-events: none` so a territory can
answer for itself — safe only because `handleOf` decides by what a press is *not* on, so a
press there is still bare ground (once a pan, now a selection band; see `layout.md`). And the card menu is where the session id finally leaves the
UI (`copy resume command`); before it, nothing on the wall would tell you what `--resume`
takes.

### Families, and the one level there is

The widget menu was nineteen rows before a browser widget and an Asana board landed on the
same afternoon; three more Asana readings would have taken it past twenty. A `more` item —
one that opens a list beside it instead of doing something — brings the ground and territory
menus back to **eight rows for twenty-one widgets**.

**The groups were already there.** The catalogue has described itself in exactly these terms
since the note above `spotify` was written: *"the things you hang up because of how the
afternoon feels, then the meters, then the services, then the agents' own notes, then the
logs… a record player belongs with the first group and nowhere near the second."* That was an
**order**, which is a grouping you can only see by reading the whole list. `WidgetSpec.family`
makes it a field. Nothing was invented to shorten the menu — a family invented for that is a
menu you have to learn instead of read — and the two widgets left standing alone are alone on
purpose: the performance meter is the only reading of *this machine*, and the browser is the
only thing on the wall you work *in*.

Where the decisions live is the usual split, and it needed no new seam: **`widgets.ts` groups**
(which widgets belong together is knowledge about the catalogue) and **`menu.ts` renders**. The
`Offer` shape is written out in both files rather than imported across, so the two still do not
know about each other — the same arrangement that keeps a new widget kind from being a
recompile of the menu.

- **A family appears where its first member sits**, so the editorial sequence still decides the
  order and a family does not sink to the bottom for being a family.
- **A leaf id is unchanged by the grouping.** Every leaf is still `widget:<kind>`, so
  `App.svelte`'s `act` needed no edit at all and the component dispatches on the id it is
  handed without learning that some arrived one level down. A family's own row carries a
  `family:` id that nothing acts on, because it opens a list rather than doing something — a
  row that did both would be a row where the fast gesture and the careful one disagree.
- **A family of one is flattened, and an empty one is dropped.** Both are this file's standing
  rule about offering nothing, one level down: a submenu you open to find a single row costs a
  gesture and tells you nothing. Neither is reachable from today's catalogue, which is itself
  asserted — the flattening exists so that *deleting* a widget kind cannot leave a pointless
  hover behind.
- **Exactly one level, and `menu.test.ts` is what says so.** `ContextMenu.svelte` renders leaves
  in its nested `{#each}` with no recursion and no arm for a nested `more`, and that is only
  safe because the test holds it over the real catalogue and over both menus that offer
  widgets. A submenu inside a submenu is a gesture you have to hold still for twice, and
  nothing here has a hierarchy that deep.
- **The label is a whole action, and the submenu's rows are bare.** "hang up a log" stands
  among `open a folder…` and `pin up an image…`, where a bare noun would read as a thing to
  look at; inside it, "servers" is the part that distinguishes it and "hang up a server log"
  would say the verb a fifth time. `WidgetSpec.short` is that second label, and `offer`
  overrides the whole row for the handful of labels the "hang up a …" template cannot carry —
  "hang up a gates" is the kind of sentence that makes a careful app look careless, and it is
  what shipped before this.

#### Two things the component had to get right

- **It is measured before it is shown, not corrected afterwards.** The same argument
  `window::settle` makes about the main window: a list that appears off the screen edge and
  then jumps back inside is a jump you watch. So the submenu renders `visibility: hidden` for
  one frame, its size is read off the element as rendered — the labels are arbitrary and
  `min-width` is a floor rather than the width — and then it is placed: flipped to the left of
  its row where the window's right edge is nearer than the list is wide, lifted where its
  bottom would run off. The measurement is cleared when another row opens, so the next list is
  placed from its own reading rather than inheriting the last one's.
- **There is no gap between a row and its list, which is why there are no timers.** The classic
  submenu bug is a dead zone you cross diagonally before the thing closes; with the list flush
  against the row (`left: 100%`, inside a `position: relative` wrapper on the row itself),
  moving into it never leaves the pair, and moving onto any *other* row closes it because that
  row says so. Escape closes the submenu first and the menu second — the wall's standing
  contract that whatever is on top owns the key — since without the first half, backing out of
  a family would take the whole menu with it.
- The mark is a triangle built from borders, for the reason the check mark is drawn in CSS:
  `▸` falls through to Segoe UI Emoji on this machine and comes out blue.

### The `+`, right-clicked

A conversation costs whatever the model and the effort behind it cost, and both are settled
before the first word — after that, changing them is a `/model` and an `/effort` into a card
that has already spent a full context on its opening prompt. The wall's `+` opened every card
on whatever Claude Code is configured for, so one setting did duty for a one-line question and
a day-long refactor alike: one of those overpays and the other is answered too cheaply, and
nothing on the card says which.

So the `+` has a second gesture. Left-click is what it always was; right-click offers five
pairings of a model with an effort — `presets.ts`, cheapest first, each with the pair shown
beside the label rather than described in it, because the point is seeing what a card costs
before opening it. `MenuItem.note` is that second column and this is the only menu that uses
one: everywhere else the label is the whole answer, and two columns for "close" is a menu you
read slower.

Three things this arrangement is careful about.

- **The button is found by `data-add`, ahead of the territory it stands on.** The `+` is drawn
  inside the region, so without its own branch in `onContextMenu` a right-click on it opens the
  territory's menu — which is what it did. `Canvas.svelte` marks the button and knows nothing
  about what the menu says; `App.svelte` decides, as it does for `data-conv` and `data-cwd`.
- **Not on a chat territory.** A chat card has two web tools and no project, `onadd` already
  routes that `+` somewhere else entirely (see `chat.md`), and the branch falls through to the
  region so the answer there stays "new chat conversation".
- **The plain opening is the last item, not the first.** It is the one that needs no reading
  and the one you get by not right-clicking at all; at the top it would put the five things
  worth looking at underneath it.

**Where a preset actually lives is the store, and that is the load-bearing half.** `open`
writes the model and the effort onto the row at `record_conversation`, and
`spawn_conversation` reads them back out through `store::setup_of` — the same bargain
`kind_of` strikes, for the same reason. `wake` passes nothing and cannot: a preset carried in
the open call alone would hold for exactly one process, and the failure would land at the
rouse, where every dormant card on the wall is respawned at once with nobody watching. A wall
of cards opened as "a quick question" would come back on Opus. `spawn_now`'s `model` parameter
— passed by no caller since it was added — is gone for the same reason.

**The levels are Anthropic's own guidance, and two of them were got wrong first time.**
Read 2026-08-20 against the effort docs' per-model sections: `high` is the API default and
the documented starting point for Opus 5, `xhigh` is the step up "for demanding coding and
agentic work", and `low`/`medium` are named as "your primary control for token cost and
response time wherever your evals show quality holds" — which is exactly what the cheap end
of this menu is for.

- **No `max`.** The top preset is `xhigh`. The docs say of `max`: "Reserve for genuinely
  frontier problems. On most workloads `max` adds significant cost for relatively small
  quality gains, and on some structured-output or less intelligence-sensitive tasks it can
  lead to overthinking." A level that is right only once you have measured it is the one
  level that does not belong on a menu whose purpose is being picked from without measuring.
  `/effort max` is still one line away on a card that turns out to want it.
- **No effort on the haiku preset.** Effort is not universal — Haiku 4.5 is absent from the
  docs' supported-models list — and the CLI does not complain: probed 2026-08-20, `--model
  haiku --effort low` ran a normal turn, reported no error, and the level did nothing. A
  silent drop is worse than a failure here, because the note beside the label is the whole
  point of the menu: `haiku · low` next to a spawn that sends no `--effort` is the row lying
  about what it buys. `Preset.effort` is therefore optional, and `presets.test.ts` asserts
  that the only preset without one is the only model without the parameter.

The model stored is an alias (`opus[1m]`, `sonnet`), not a full id, so a preset does not go
stale the week a new model ships. Probed 2026-08-20 against claude 2.1.233: `opus[1m]` →
`claude-opus-5[1m]`, `haiku` → `claude-haiku-4-5-20251001`, `fable` → `claude-fable-5`, each
read back off `system/init` — and the resolved id round-trips through `--model` too, which is
what lets the settling turn write the real id over the alias and the next wake pass it
straight back.
