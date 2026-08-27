---
paths:
  - "src/lib/widgets.ts"
  - "src/lib/widgets.svelte.ts"
  - "src/lib/WidgetNode.svelte"
  - "src/lib/Clock.svelte"
  - "src/lib/clock.ts"
  - "src/lib/Perf.svelte"
  - "src/lib/perf.ts"
  - "src/lib/meter.svelte.ts"
  - "src-tauri/src/perf.rs"
  - "src/lib/logface.ts"
  - "src/lib/LogFace.svelte"
  - "src/lib/LogTail.svelte"
  - "src/lib/serverlog.ts"
  - "src/lib/ServerLog.svelte"
  - "src/lib/buildlog.ts"
  - "src/lib/BuildLog.svelte"
  - "src/lib/unreallog.ts"
  - "src/lib/UnrealLog.svelte"
  - "src/lib/status.ts"
  - "src/lib/Status.svelte"
  - "src/lib/beacon.svelte.ts"
  - "src-tauri/src/status.rs"
---

# Widgets, the clock, and the performance meter

### Widgets

Instruments you hang on the wall: a clock, a reading of what this studio's processes are
costing, a reading of what Claude Code has spent. To the wall a widget is the same kind of thing as a reference image — hand-placed,
freely sized, belonging to no project, never in the auto-layout — so `widgets.svelte.ts` is
`images.svelte.ts` with a kind and a config where the path was, and `WidgetNode.svelte` is
`ImageNode.svelte` minus rotation (a photo pinned at an angle is a photo; a clock at an angle
is a clock you cannot read).

`widgets.ts` is pure and is the *whole* vocabulary: the catalogue, each kind's parameters,
its default size and its floor. A new knob is one line, a new variant is one entry in a
`choice`, a new kind is one spec plus one arm in `WidgetNode`'s switch — and Rust never hears
about any of it, because `widget.config_json` is one opaque column for the same reason
`ambience_profile.layers_json` is (schema v5). `normalizeWidget` is the other half of that
bargain and runs on every read: a retired variant, a renamed knob or a config that will not
parse degrades to something drawable, and a *kind* nothing can draw is left off the wall
rather than guessed at — that is a widget from a newer build, and drawing it as a clock would
be worse than an empty patch of wall.

Everything a widget can be told is on its own right-click, not in a panel: the native menu is
suppressed, so `menu.ts` is the whole answer. Two groups — the variant, which is what you are
looking at, and then everything else (`optionsOf`, built off the catalogue, so a knob added
there is reachable by hand the same day; a parameter with no way to reach it is a parameter
that does not exist). The one in force is *marked* — `on` on the `MenuItem`, a dot drawn in
CSS by `ContextMenu.svelte`, because a `✓` falls through to Segoe UI Emoji here and comes out
blue, and "analog (showing)" repeated five times is a paragraph. What can be hung up comes off
the catalogue too (`widgetOffers` in `App.svelte`), so a new kind appears on the ground and
territory menus by existing.

**No numbers among the knobs.** A menu is a poor slider, and the one number these widgets
wanted was better answered by the box you drag: how many rows a meter shows is `rowsFor(h)`.
A setting that could disagree with the height would be a widget arguing with itself.

Two things carry over from elsewhere and are load-bearing:

- **A widget is opaque unless you say otherwise.** The ambience is drawn behind everything on
  the wall, so an instrument you can see the weather through is not an instrument — the same
  constraint, and the same fix, as the dormant card a leaf drifted through. That is the
  default and the reason for it; the `frame` knob below is the way to spend it deliberately.
- **The press is a click until it has travelled.** A widget can hold buttons (a performance
  row goes to the card it names), and capturing the pointer on `pointerdown` retargets the
  eventual `click` to the wrapper and silently swallows every one of them. That rule now lives
  in `Canvas` and applies to the whole wall, along with the *move* gesture itself: a widget can
  be selected beside a card, a project and a reference image, and dragging any member of a
  selection moves all of it, so moving cannot be something each thing does only to itself. What
  `WidgetNode` still owns is the resize — the one gesture that is about this widget and cannot
  mean anything else — and its grip is marked `data-grip`, which is what tells `handleOf` to
  leave the press alone. Being a `button` is deliberately *not* enough: a card's whole body is
  one, and a rule that stepped over buttons stepped over every card on the wall. See
  `layout.md`.

##### How much of a frame it wears

Every widget wore a solid outline and a solid fill, which is right for an instrument and wrong
for furniture: a clock is a thing in the room, and a panel drawn over the wall reads as
something the app is telling you rather than something you hung up. So the frame is a knob —
`frame` in `COMMON`, three values, `framed` (the wall as it was), `plate` (a fill, no outline),
`bare` (neither).

- **`COMMON` is joined on by `paramsOf`, never written into a spec.** It is the one place the
  shared knobs meet a widget's own, and therefore the definition of a widget's vocabulary: the
  menu, `defaultConfig` and `normalizeWidget` all ask it rather than reading `spec.params`, or
  a shared knob would be offered without being persisted — or persisted without being
  reachable, which is the failure the catalogue's "a parameter with no way to reach it does not
  exist" rule already names. A new kind of instrument gets the frame by existing, the way
  `widgetOffers` already gives it a way onto the wall.
- **One choice, not two toggles**, because the fourth state a pair would allow is the only one
  nobody wants: an outline with the wall showing through it is a hole cut in the wall rather
  than an instrument. The three values are an ordered retreat and each step takes one layer
  off, so that state cannot be written.
- **`bare` is the deliberate exception to "nothing on the wall may be transparent."** That rule
  exists because a leaf drifting through a dormant card reads as broken — the card did not ask
  for it. A clock you *set* bare is the opposite: the weather behind it is the reading you
  chose, and is what makes it furniture rather than a panel. The rule stands as the default,
  which is the whole reason this is a knob and not a restyle.
- **The fill lives on the wrapper and nowhere else.** Every face used to paint its own
  `var(--ink)` — the same colour twice, harmless until it wasn't: `bare` would have shown the
  wall through the frame and then had the reading paint it straight back over. The faces now
  paint no background at all and `WidgetNode` is the only thing that fills. The buttons inside
  a timer and a pomodoro keep theirs, which is right — a control is not a reading.
- **Selection puts the edge back, and only selection.** That rule has to be read *after* the
  `data-frame` ones: at equal specificity only source order settles it. Hover used to reveal
  the edge too, on the argument that a widget you cannot find the corner of is one you cannot
  drag — but every widget is draggable anywhere, so the only thing that edge reported was where
  the pointer was, and a wall of instruments lighting up one after another as you cross it is
  the app narrating your mouse. The grips have always been selection-only, so now the edge and
  the handles agree about what picking a thing up means: the frame you chose is what the widget
  wears until it is selected.
- **It goes onto the node as `data-frame` and the styling hangs off that**, one enum in the DOM
  rather than a pair of booleans. `frameOf` is total, so the attribute always names a frame the
  CSS has a rule for. Nothing was added to `snapshot` for it: `widgets[].config` already
  carries the value, and the `dom` op returns `data` and computed styles, so the knob and the
  rule it reached are both visible from outside — which is the pairing `panel.reading` and
  `panel.linePx` exist to make.
- **A pomodoro's menu had to be told.** Its cadence items are built by hand (the cycle is one
  per studio), and that arm read every `cfg:` id as cadence-or-nothing — so the one kind whose
  menu is partly written out here was the one kind that silently dropped its frame. `optionsOf`
  is now asked for a pomodoro too, and the `cfg:` handler falls through to it.

#### The clock

`clock.ts` is pure and holds the arithmetic — hand angles, ring fractions, the digital split,
the words, the face geometry. Five variants, and they are genuinely different readings rather
than skins: `analog` is read by angle, `digital` by numeral, `words` by sentence, `artistic`
as a brush sweep round the hour, `abstract` as three rings and no numerals at all.

- **It runs on the wall's existing one-second tick** (`clock` in `conversation.svelte.ts`).
  A second timer for the most obviously timed thing in the app would be a second wake-up per
  second on a machine that is otherwise idle. Nothing sweeps, for the same reason: with a
  once-a-second reading a swept hand sits between positions for most of every second, which
  reads as broken rather than smooth. `handAngles` takes a `sweep` flag anyway, because the
  *minute* hand carrying its seconds is not optional — an hour hand at `hour * 30` is a clock
  that is wrong 59 minutes in 60.
- **The words are every minute, not the nearest five.** A clock that says "half past three"
  at 15:32 is a clock you check against another clock.
- **Type is sized off the widget's own box** (`cqw`/`cqh` against `container-type: size` on
  the node), so a clock dragged large is a large clock rather than a small one in a large
  frame.

##### A clock that is not telling the time

The mad clock: `pace`, four values, and it lies about one thing only — *which* instant the
face is reading. `madAt` maps the real epoch onto a made-up one and every face goes on drawing
`reading(now)` without knowing it has been lied to.

- **A knob, not a sixth face.** Hurtling through the afternoon is something an analog dial, a
  sentence and three rings can all do, and a variant would have made it a face you gave up
  another face to have. It is the same argument the frame makes from the other end: a knob is
  what a thing *every* variant can be told.
- **The one deliberate second wake-up per second.** A mad clock needs frames, not seconds: at
  `MAD_RATE` the minute hand comes round every five seconds, and a once-a-second reading of
  that is four positions in a turn — a stutter, which is the precise thing the shared tick's
  no-sweep rule exists to avoid drawing. So `Clock.svelte` runs its own
  `requestAnimationFrame`, bounded at both ends the way `Backdrop`'s and `Flow`'s are: it
  exists while the knob is off `real` and is torn down the instant it comes back. An honest
  clock still reads `clock.t` and costs exactly what it always did, which is what makes this
  exception payable — nobody who did not ask for it pays.
- **The rate is chosen for the minute and hour hands, and the second hand is lost.** There are
  3600 between a second hand and an hour hand, so no single rate makes all three lively: at 720
  the minute hand takes five seconds and the hour hand a minute, both a pleasure to watch, and
  the second hand becomes a blur that aliases. That is accepted rather than worked around,
  because the hand it spends is the one the analog face already draws as the faintest hint. Not
  a knob either — no numbers among these, and the three mad paces are three readings rather
  than three speeds.
- **`deranged` is discontinuous on purpose.** It lands somewhere arbitrary, runs from there at
  a speed and in a direction of its own for `LURCH_MS`, then snaps elsewhere. A clock off its
  hinges lurches; a smooth random walk reads as a clock that is merely *wrong*, which is the
  one thing a clock must not look like unless it means it.
- **Every bout's numbers come out of a hash of the bout index, never `Math.random`.** That is
  what keeps `madAt` a pure function of its two timestamps, so the same instant drawn twice
  draws the same — a re-render is not a reshuffle — and the whole of the madness is testable
  without a fake clock.
- **Nothing about a bout is persisted.** `since` is when *this* bout began, a local rather than
  a config key, so a launch, a reload and a second thought all start the madness from now.
  Persisting it would resume a clock nine hundred days out of true; coming back to a wall
  should look like arriving, not like resuming a paused film, which is the same call
  `Backdrop`'s `stop()` makes about the flourishes in the air.

#### The performance widget

A task manager whose rows are *things on this wall*. That is the whole argument for it living
in here: six cards are six identical `claude.exe` in anybody else's process list, and the one
eating a core is the one you want to go and look at — so clicking a row reveals the card.

The split is the one `project.rs` draws. `perf.rs` answers in facts — pid, name, cost, and the
*role* it plays here as an opaque reference — and `App.svelte`'s `nameFor` turns
`conversation: <uuid>` into a card's title, because the title is front-end knowledge.
`Supervisor`, `Servers` and `Runs` each expose `pids()`; a `claude.exe` this studio did not
spawn is somebody's terminal and must never be labelled as one of our cards.

- **Descendants inherit their ancestor's role** (`ancestry`, bounded at 16 hops because pids
  are reused and a stale parent map can close a loop). A dev server is `pnpm` spawning node
  spawning esbuild, and a build fans out to cl.exe by the dozen; only the first of each is in
  any of our maps, and a meter that showed the rest as strangers would understate the thing by
  most of its cost. `perf.ts::fold` then makes each tree one line — strangers fold by
  executable, the way a browser's dozen windows do.
- **Sampling is the one deliberate exception to "nothing polls"**, because no process emits an
  event when it starts using the CPU. It is bounded at both ends: the `Meter` (`meter.svelte.ts`
  — named for the class, since `perf.svelte.ts` beside `Perf.svelte` is the *same file* on this
  filesystem) is one sampler for however many widgets are up, and when the last detaches it
  stops and `release_performance` drops Rust's process table. One sample serves both scopes —
  the machine's is a superset — which is also why `Sample` carries the scope it was taken at:
  a studio-scoped widget must not inherit a machine-scoped sample's leftovers.
- **In development the studio's own row reads low.** WebView2 keeps one browser process per
  user-data folder, so a second Skein against the same `%APPDATA%` has no webview children of
  its own — they are all under the instance that started first. Probed 2026-08-13 with two up.
- **Every number goes through one formatter.** A row printing 0.2% under a header printing 0%
  is a meter arguing with itself.

#### Listing what a card holds, and ending one of them

A count was never enough on its own. A row said `4` and there was no way to ask which four,
and no way to end any of them — the one number on the wall with nothing behind it. Now the row
unfolds (`perf.ts::members`, keyed on the row's own key so the two cannot drift) and a card's
right-click carries `processes…` for the same list with room to read it (`Processes.svelte`).

- **The list comes from the card's job, not from walking parents.** `ancestry` climbs until it
  recognises somebody, which goes blind the moment an *intermediate* process exits — and that
  is exactly the shape of a leak, so the instrument was blind precisely where it needed to
  see. `jobs::Job::pids` asks the kernel instead: membership is set at assignment, inherited
  by everything spawned after, and survives anything in between dying. `Supervisor::owned_pids`
  is that per card, consulted only where ancestry came back empty-handed so `own` still means
  what it meant.
- **Job membership is also the only proof of ownership there is**, which is why `kill_process`
  refuses any pid outside one. A parentless `bun.exe` is unattributable by inspection; the rule
  that a `claude.exe` Skein did not spawn is somebody's terminal cuts harder for killing than
  for labelling, because mislabelling costs a wrong word on a widget.
- **Ending one is `taskkill /T`.** Ending a process and orphaning its children is the bug the
  whole of this came out of.
- **Orphans sort above cost**, which is the one place the list disagrees with the rows and does
  so deliberately. Rows rank by what is eating the machine, because that is what a meter is
  for. A list you opened, you opened to find the thing that should not be there — and that
  thing is reliably *cheap*: every leaked process measured on this machine sat at 0%. Ranking
  by cost files them last.
- **A mute and a mark, never a colour.** An orphan is not a failure; rust would say the card
  had broken when what happened is a process lost the thing above it. Same reading `set aside`
  already settles.

#### Whether Claude itself is up

`status.claude.com`, on the wall it is a fact about. The two widgets above it read what the
allowance has left and how fast it is going; this one answers what neither can — the wall has
gone quiet and the turns are failing, so **is it me or is it them?** That question currently
costs a browser tab, an ambiguous search and a minute, which is a question people answer by
guessing.

`status.rs` asks and answers in facts; `status.ts` is pure and holds every judgement — the two
ladders, the ordering, the colour, the wording, the cadence. Same split as `limits.rs` against
`limits.ts`: the part that will be argued about is the policy, and an argument is worth having
against tests. The holder is `beacon.svelte.ts` and **not** `status.svelte.ts`, which on this
filesystem is the same import specifier as `Status.svelte` — the trap `release.svelte.ts` is
named around, and `svelte-check` refuses it outright.

##### The polling argument, which is the whole of this widget

It is the **fourth** thing on this wall that goes and looks, so it owes CLAUDE.md's shape.
Statuspage emits nothing a desktop process can hear, and the page's own "subscribe to updates"
offers four things, none of which is a way for *this process* to be told:

- **Webhook** needs an inbound URL. A desktop app behind NAT has none, and giving it one means
  a public listener plus a hosted relay to forward through — a service to stand up and keep
  alive, so that a 2 KB GET can be avoided.
- **Email and Slack** arrive in a person's inbox, not in a process.
- **Atom/RSS** is still a poll, with a *worse* answer: a feed of incident **history**, bigger
  on the wire, resolved entries mixed in, and silent about the current indicator when nothing
  has happened lately — which is the state this widget is in almost all the time. Polling a
  feed to learn that nothing is wrong is polling for less.

So it goes and looks, and the rule is *fold an event that already exists near the fact, then
bound the residue*. **Two** are folded here, which is one more than the update check has:

- **You coming back to the window** (`attention.focused`), exactly as `release.svelte.ts` does
  it, and for its reason: a wall left on a second monitor for a week asks nothing, and the
  moment you look is the moment the answer is worth having.
- **A card's turn ending in an error**, and this is the better of the two. Volery *is* a Claude
  Code client, so an outage arrives on this wall as turns failing — a `result` already folded
  into `Conversation.ending`. "Is it me or is it them?" is the entire widget, and a card going
  rust is when somebody wants it answered. `App.svelte` watches the *count* of errored cards so
  the effect fires on one more going rust rather than on every unrelated fold, and `rouse` goes
  through the same floor a focus does — a territory of six cards failing in the same second is
  one ask, not six.

The residue is bounded three ways, and **the third is where this parts company with the update
check.** There the rule is *stop for good once there is something to say*, on the observation
that no further ask can change the answer. That does not transfer, because **an outage
resolves**: the moment there is something to say is the moment the answer starts changing, and
a widget latched on amber would be worse than no widget. So the third bound is not a stop but a
cadence that **tightens with the news** (`PACE` in `status.ts`):

- only while the window is in front;
- never twice inside `FLOOR`, one minute, whatever provoked it;
- and the backstop is **fifteen minutes while green, two while not**. Fifteen is
  `release.svelte.ts`'s number on purpose — two instruments asking the internet on two rhythms
  is two numbers to reason about instead of one.

`unknown` — we could not reach the page — takes the **two-minute** pace, and that is the rung
the classification exists to get right. Not knowing is not a quiet state: either the network is
back and the answer is a second away, or it is not and the widget is telling you something
true. Backing off there would make the one case where the instrument is useful the one case
where it is slowest.

Worst case is therefore a window you never leave during an outage: thirty asks an hour, of a
static CDN-fronted document, only while somebody is looking at it. A wall with no status widget
up asks **nothing** — `attach`/`detach`, the same bargain `Meter`, `Ledger`, `DevOps` and
`Board` strike.

It deliberately does **not** reach `attention`. A degraded status is not a card asking you a
question, and spending the taskbar flash and the peek window on the weather would train you to
ignore both.

##### A failure is a reading, not silence

The deliberate opposite of the update check, where every failure leaves the header as it was.
An update nobody could check for is a fact about plumbing, and an app that reported its own
inability to check would be an app talking about itself. A status page nobody could reach is
**evidence about the thing you are asking after** — so it is kept and drawn, and the last good
reading is *replaced* rather than left standing. A green dot over a failed ask is the one
dishonest thing this widget could do.

The same argument sets the age in the header. `page.updated_at` and *when this wall asked* are
different facts, and conflating them is what `Reading.at` exists to prevent: a status page
untouched for a week is normal, a reading taken a week ago is not. Past `STALE` — thirty
minutes, deliberately twice the calm backstop, so a watched wall never sees it — the age is
marked, because the only way to get there is to have been away.

##### Colour, for once, is the design rather than the constraint

Chrome is achromatic and colour is reserved for status; this face *is* status, so Statuspage's
ladder maps onto the five existing `--st-*` tokens and nothing is invented. Two ladders come
off the wire — one for the site, one per component — and `status.ts` folds both onto one
six-rung `Grade`, because a face that had to know both would draw the same news two ways.

| grade | token | why |
|---|---|---|
| `well` | `--st-work` | celadon, the wall's "alive and fine" |
| `watch` | `--st-soft` | the page's `minor` is a half-signal, and this is amber at half bloom |
| `wrong` | `--st-ask` | full amber — something wants attention |
| `broken` | `--st-fail` | rust |
| `planned` | `--st-rest` | maintenance is not a fault; the reading `set aside` already settles |
| `unknown` | `--paper-faint` | **not a status colour, and must not become one** |

That last row is the one that would be a bug rather than a preference. Not having reached the
page is the *absence* of a reading; drawing it in any of the five would be the widget inventing
news. For the same reason every unrecognised word from either ladder grades as `unknown` rather
than as `well` — a rung Statuspage adds tomorrow, read as "all fine", would have this saying the
opposite of the truth in the one case it exists for.

Four smaller calls, each of which would be a bug the other way round:

- **The page's own sentence, verbatim.** "All Systems Operational", Title Case and all. This app
  does not paraphrase somebody else's status page. The per-component word *is* ours
  (`sayGrade`), because that is our summary of an enum rather than a restatement of a claim.
- **The indicator leads, but a component can drag it down.** The page is entitled to call one
  degraded component a `minor`, and it knows things this does not. But it has been observed to
  say `none` while a component says it is down — the gap between a component being flipped and
  an incident being opened — and "All Systems Operational" printed over a rust row is a widget
  arguing with itself.
- **Worst first, then the page's own order.** The box you drag it to is the setting (`rowsFor`),
  so a widget cut to three rows must show the three that matter — `perf.ts` putting orphans
  above cost, one file over. On a green day every grade is equal and `position` alone decides,
  so nothing shuffles while all is well. Group rows are dropped (a heading is not a service) and
  so is a component the page marks `only_show_if_degraded` while it is well, which is the page
  saying "do not put this in front of people unless it matters".
- **No `incidents` variant**, and it is the `reviews` `scope` argument: a face empty on every
  ordinary day is a face nobody looks at, and by the time it had something to say the habit of
  glancing at it would be gone. The incident is drawn *inside* both readings when there is one.
  The `only what is not operational` narrowing is the same shape done safely — the face says how
  many it is keeping back, so a blank pane is never a widget that looks broken.

#### Three logs, one substrate

Three widgets read a stream of lines somebody else is producing: a dev server group, a build or
test run, and a running Unreal editor. They are **three kinds rather than three variants of
one**, and that was the decision worth getting right — a `source` knob would have been a spec
whose every other knob was `Guard`ed off against it, and `variantsOf` feeds the right-click's
quick-switch, so flipping "source" from that menu would have handed you an unrelated instrument.
The subjects differ in every way a widget is made of: a group has ports and per-server health
and a start button, a run has a verdict and a percentage, an editor log has categories and
verbosities and an open-the-editor button.

What they genuinely share is `logface.ts` (pure), `LogFace.svelte` (the frame) and
`LogTail.svelte` (the lines). The split is along CSS-scope lines, which is the `Dock.svelte`
lesson: **a component is the only CSS scope this codebase has**, so `.dot`, `.who`, `.quiet` and
`.go` live in one file rather than three, or a border colour drifts in one of them and still
looks right in isolation. `test/styles.test.ts` is the backstop.

The shared decisions, each learned on one subject and then true of the others:

- **None of them scrolls, and the wheel is why.** `Canvas` preventDefaults every wheel on the
  surface to zoom the wall, so *nothing* standing on the wall can be scrolled with one — a pane
  that overflowed would hide its newest lines behind a scrollbar nothing could move. So
  `linesFor` draws what the height fits, anchored to the tail, which is the same "the box you
  drag it to is the setting" rule `rowsFor` follows and here it is load-bearing rather than
  tasteful. Reaching further back is a panel's job, and panels scroll. It is *not* `rowsFor`:
  that is shared by three faces which are lists of the same one-line rows at the same size, and a
  log is monospace and denser, so sharing it would have made the arithmetic wrong about its own
  CSS — which is the one thing it is for. `LogTail`'s `justify-content: flex-end` is what makes
  being wrong about it survivable: overflow spills off the *top*, where it is merely old.
- **A drag on the lines selects them; a drag anywhere else on the widget still carries it.**
  The one place on this wall where a press-and-move is not a gesture. Every other reading here
  is a number or a word you look at and are done with — a log is a stack trace, a failing
  assertion, a port already in use, and its whole value is that it can be carried somewhere
  else. A log you cannot copy out of is a log you read once and then retype.

  The mechanism is one entry rather than a new rule, and that is the part worth keeping.
  `Canvas.handleOf` already had a list of things a press is *not* the wall's — a `data-grip`,
  and an editable, "where a drag means selecting text". A log's lines are the same sentence
  with the word "editable" removed, so they are marked `data-text` and join that list;
  `groundDown` does `if (aim === null && !panning) return` and the browser does what it would
  have done anyway. No pointer is captured, no gesture starts, nothing about "the press is a
  click until it has travelled" is touched. Adding a fourth pointer path here would have been
  a fourth chance to get that rule wrong, and it has already been got wrong three times in
  three faces (`layout.md`).

  Three consequences, all deliberate:

  - **The pan buttons still reach past it** — `handleOf`'s answer is only consulted for the
    left button, so the right and middle drag the wall out from under a full-width log exactly
    as they do everywhere else. A log widget that could not be panned off would be a hole in
    the wall.
  - **`user-select` is the other half and is easy to leave off.** `.surface`, `.glass` and
    `WidgetNode`'s own `.face` each say `user-select: none`, so the marker alone buys a widget
    that can no longer be moved *or* selected — strictly worse than before. `LogTail`'s `.log`
    says `user-select: text` (and `cursor: text`, so it reads as text before you try it), which
    is the same move `.surface input` already makes for a territory's worktree field. Neither
    half is a type error and neither shows up in `bun run check`, so
    `test/styles.test.ts` asserts the pairing: every component carrying the marker has the rule,
    and `Canvas.svelte` names the marker.
  - **A press on the lines no longer picks the widget up.** That is the trade the ask asked for
    and it is real: a log widget is selected and moved by its header, its chips or its frame.
    The header is always there and is never narrow, which is what makes the trade payable.

  It reaches all three logs, not just the server's, and the boundary is drawn at *log text*
  rather than at *server log text* on purpose — they share `LogTail`, and a build log you could
  not copy a compiler error out of would be the same bug wearing a second face. `ServerLog`'s
  `latest` variant carries the marker too, since it is the same lines in the other shape.
- **Two absences, said differently.** A wall with nothing of this sort on it is a widget with
  nothing to point at yet. A widget naming a subject that has been *deleted* is the one thing that
  must not be papered over by quietly showing the next one's output — the lines would be somebody
  else's and nothing on the face would say so. `subjectOf` returns which, each subject writes its
  own two sentences, and the face says which.
- **`FOLLOW` leads in all three**, because it is the setting that stays right: groups are added,
  projects come and go, runs are pressed hours after the widget was hung up. Nothing is hidden by
  it — the face names its subject in the header either way. Each subject supplies its own `live`
  predicate for what "whichever is running" means, and following falls back to the first when
  nothing is, because a wall where nothing is working still has one honest answer and a button
  under it. A wall with one subject is not offered the knob at all: following it and naming it are
  the same answer.
- **A start button and nothing else, in all three.** Stop and remove belong in a panel, spelled
  out. This is furniture on a wall you drag things around on, and a stop under the pointer where a
  reading used to be is a server killed by a mis-drag. `down.verb` may be null for the one case
  where there is something to say and nothing to press.
- **An empty pane always says why.** `emptyBecause` assembles the one sentence all three owe —
  the count dropped, and what for, in the subject's own words. What did not *fit* needs no
  apology; it is simply older, and a taller widget shows more of it. Only the filter's omissions
  are a thing the face has to say out loud, or a stderr-only reading of a perfectly healthy server
  reads as a widget that has broken.
- **`showing` is one axis with three vocabularies**, deliberately, rather than three axes: each
  subject hands `tail` a predicate and nothing above it knows what narrowing means there.
- **Whether a tone reaches the text is per-subject**, and the two answers are both right.
  `LogTail`'s `tint` is off for the server log, where the signal is which *pipe* a line came down
  and half of everything logs perfectly calm prose to stderr — colouring on that would be Skein
  overruling the program. It is on for the build and editor logs, where the signal is the writer
  saying the word "error" *with a colon after it* about its own line. And the tint is
  automatically deferential: a line that arrived with its own SGR colour has that colour set
  inline on its spans by `parseAnsi`, which wins over the row's inherited tint.

#### The server log

A dev server group's own output, on the wall it is being written for. The panel already has
every group's log behind a `log` button; what the widget adds is that you did not have to ask —
the recompile, the port binding, the stack trace, on the wall beside the card whose agent caused
it. `serverlog.ts` is pure and holds all of it: which group a widget is about, what a filter
hides, and what to say about a server that is saying nothing.

- **No holder, and that is the point of it.** `Meter`, `Ledger`, `DevOps` and `Board` each exist
  because their widget has to go and *ask* somebody — a process table, a transcript, an API, the
  billboard — and one asker must serve however many faces are up. This one asks nothing:
  `servers.rs` already pipes every group's stdout and stderr up as `server:log` for the panel's
  sake, and `GroupRuntime` already keeps them. A log widget is a second reading of live state, so
  inventing a `Servers` holder for it would have been a sampler with nothing to sample.
- **It reads a crash as down, because `running` does not.** That flag is what the *wall* asked
  for — set on start, cleared on stop — so a server that exited on its own (a port already bound,
  a config that will not parse) comes back `running: true` with an `exited` health. A start button
  that appeared only for a group nobody had started would have been missing from exactly the case
  you are looking at the log to understand. `standing` is where that is decided, and it is the one
  thing in here with a test per branch.
- **The button is `onserverstart`, not the chip's `onserver`.** That one *toggles*, and a crashed
  group is `running: true` — so the toggle would have stopped a server the face had just said had
  stopped. `start_group` releases any old tree of its own before it binds a port, so the one verb
  is the restart too. (Stop and remove stay in the panel, for the reason all three logs keep them
  out.)
- **Which group is a knob, because a widget belongs to no project.** Unlike a territory chip this
  cannot be answered by where it is standing — which is why all three logs have a subject knob at
  all. `isLive` here is asked of `running` rather than of `overall`, so a group whose server
  crashed a second ago is still the one being followed: the log of the thing that just died is the
  log you want.
- **The colour is the server's own.** The one place on this wall where colour is not ours to
  reserve for status: `ansi.ts` renders what the program printed, which the pipes keep by
  *asking* (`force_colour`) rather than by being a terminal. This is the face that leaves
  `LogTail`'s `tint` off — see the shared note above for why the other two turn it on.
- **And it is the first reader `ServerLog.stderr` has ever had.** The field only became true when
  the pseudo-terminal came off and each pipe got its own reader; under the merged one it was
  hardcoded `false` for every line ever emitted. The panel still ignores it. See
  `.claude/rules/servers.md`.

#### The build log

A run this wall started, while it runs and after it has finished. The chip on a territory's edge
already says how a build *went*, in one word and one colour; what it cannot say is why, and the
log that would has been a panel and two clicks away — which is two clicks you do not spend while
a compile is running, so the wall's answer to "is it stuck?" has been a percentage with no words
behind it.

- **Not an Unreal widget**, deliberately. UBT, cargo, tsc and pnpm are four things that produce a
  run, and nothing in `buildlog.ts` asks whose it is. UBT gets the best of it only because
  `actions.ts` already knew the most about UBT's output — `@progress`, the `[12/345]` counters,
  the cook's own tally, all of it parsed by `progressFrom` for the chip's sake long before this
  existed.
- **The subject is the project, not the run**, and that is the one structural decision in the
  file. A run's id is a UUID that lives as long as one compile, so a widget pinned to one would be
  pointing at nothing by tea-time and there would be no menu entry to pin it with. So the knob
  names a root and the face draws whatever that project most recently ran — press `test` after
  `build` and the log follows, which is what you wanted anyway.
- **A failed build is *not* a down state**, which is the opposite of what the server log decided
  about a crashed group and right for the same underlying reason. A dead server's log is stale and
  the useful gesture is to start it again; the log of a failed build *is the entire point of the
  widget* — it holds the four lines you are looking for — and replacing it with a button would
  hide the answer behind the question. The only down state is a project that has never run
  anything; re-pressing a finished action is left to the chips on the territory's own edge, which
  are already on the wall a few inches away.
- **`diagnosticOf` is fussy about punctuation on purpose.** A UBT build is three thousand lines
  and four of them matter, there is no structure to lean on (`actions.rs` reads pipes, not a
  compiler API), and the whole risk is being too eager: a matcher that called `Compiling
  error-handling v0.3.1` an error, or counted the `0 errors` in a summary line, would turn the
  problems reading into a second copy of the log with no way to tell from looking at it. So every
  pattern demands a colon, a bracketed code, or an MSVC-style `C2065`, and `1 error generated.`
  deliberately does not match — it is a count, and the four lines above it are the ones you want.
  The false positives get as many tests as the true ones.
- **The progress reading is the small one**, the way the server log's `latest` is: a bar, the last
  note and the elapsed. Four monospace lines of `cl.exe` invocations say nothing at a card's size;
  "compiling serde" says all of it. The bar appears *only* where something genuinely counted to a
  known total — for cargo and vite there is none, and a bar that guessed one would be a widget
  inventing a number. The pct is kept after the run ends, unlike the chip's, which drops it: a bar
  frozen at 47% under a rust dot says the build got half way and stopped, which is a different
  thing from one that failed on the first file.

#### The editor log

`Saved/Logs/<Name>.log`, beside the card whose agent is changing the code in it. The only one of
the three whose lines were not already on the wall for some other reason — a dev server's arrive
because the panel wanted them and a build's because a chip did — so this is the one that has to
go and ask.

- **Two gate conditions, and both are load-bearing.** A widget has to be asking
  (`Actions.wantsEditorLog`, set from `App.svelte` off the widgets that are up — the same
  arrangement `pomodoro.watched` has, because the holder may not reach into the widget registry).
  *And* the editor has to be up: a closed editor is a file that will not change, so tailing it is
  a thread and a 250ms wake spent watching nothing, and the widget has something better to draw in
  the meantime. Between them the common case — no editor log on the wall — costs one
  set-difference per poll and nothing else. `#reconcileTails` runs off `poll`, which is the only
  thing that learns an editor has appeared or gone; that is also why the button works without a
  second mechanism, since `launch-editor` already schedules a poll six seconds out.
- **No new Rust.** `tail_log` has been reading this exact file for Live Coding verdicts all along,
  reopens per pass and resets to zero when the file shrinks — so Unreal rotating `Caravan.log` to
  a `-backup-` on editor start was already handled. A widget's tail is one more id in `Runs`, and
  `action:log` routes by it: `#byRunId` first, then `#tailRoots`.
- **It has to be primed, because `tail_log` starts at the end.** Right for the thing it was
  written for (a previous compile's "succeeded" must not be read as this one's) and wrong for a
  widget, which would hang on the wall showing nothing until the editor next spoke. So
  `read_tail` — which already exists for splicing UBT's log into a failed build — reads the last
  32k once per editor *session*, tracked in `#primed` so a widget taken down and put back up does
  not re-read what it already holds. The millisecond between that read and the tail's seek to the
  end loses lines rather than duplicating them, which is the right way round: a line missing from
  the middle of a log looks like a log, where the same line twice looks like a bug in the thing
  printing it and would be chased as one. A second session under a widget that watched the first
  gets a `── editor restarted ──` marker, because the last lines before a restart are usually why
  it was restarted.
- **The lines are kept when the editor goes.** A log you were reading does not become less true
  because the process finished exiting, and the last hundred lines of a session are often exactly
  what you wanted once it had gone.
- **The parse is what makes it drawable at all.**
  `[2026.08.21-14.32.10:123][456]LogTemp: Warning: ` is nearly forty columns of prefix on a face
  three hundred pixels wide. `parseLine` takes it apart, `shortCategory` drops the `Log` every
  category starts with (`LogAutomationTest` → `AutomationTest`, and one that does not follow the
  convention is left alone rather than mangled), and `timeOf` cuts the stamp to the eight
  characters you would use — off by default, since even eight is an eighth of the face and only
  worth it when lining this up against a build that failed at the same moment. Two traps in there:
  a bare `Warning:` with no category parses into the category slot and has to be moved, and the
  stamp is anchored on its four-digit year or `[456]LogTemp: x` reads its frame as a timestamp and
  then reports no frame at all.
- **The button opens it with MCP on, and says so.** `launch-editor` passes
  `-ModelContextProtocolStartServer` and pins the port from the committed `.mcp.json`, so an
  editor Skein started is one the cards on this wall can talk to and a shortcut on the taskbar is
  not. That is the whole reason to open it from here, so it is in the word rather than left as a
  surprise. Routed to `actions.run(root, "editor")` rather than invoked in the face, which buys
  the fault bar and the poll kick for free.

#### The sweep

`perf.rs::sweep`, started by `spawn_reaper`, ends anything in a card's job whose parent has gone away, once a
minute. Two tests, neither a guess: the job says it is ours, a dead parent says nobody is
waiting on it.

- **It has no idea of "hung", deliberately, because one cannot be had honestly.** Every leaked
  process on this machine sat at 0% CPU — and so does an idle dev server, an MCP server parked
  on stdin, and a `Monitor` that `turns.md` says may legitimately run half an hour. `REAP_MIN_AGE`
  is not a hang threshold; it is a race guard, because a process is briefly parentless while a
  spawn is still being handed over.
- **This is the second deliberate exception to "nothing polls", and wants the same
  justification as the first.** The meter polls because no process emits an event when it
  starts using the CPU; this polls because none emits one when its parent dies. Orphaning is a
  thing that *stops* happening to a process — there is nothing to subscribe to.
- **Started in `setup`, not with the meter.** The meter exists only while a widget is on the
  wall, and a guarantee that holds while you are looking at it is not one.
- **The honest caveat**: a backgrounded tool call whose shell has exited while the work goes on
  is indistinguishable from a leak by these two tests, and killing one means a
  `<task-notification>` that never arrives and a card left holding a job it cannot decrement.
  The window is narrow — Claude Code keeps the shell up to collect output — and was accepted
  deliberately in exchange for a wall that does not silt up.

The control surface has `widget.add`, `widget.set`, `widget.update`, `widget.remove` and
`widget.select`, and `snapshot` reports `widgets` and `meter`. `meter.sampling` is reported
apart from the widget count for the reason ambience reports `drawing` apart from `canvas`: a
meter on the wall with a dead sampler and one with a live sampler look identical from outside.

