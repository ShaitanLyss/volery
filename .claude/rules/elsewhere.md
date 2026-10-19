---
paths:
  - "src/lib/shadow.ts"
  - "src/lib/shadows.svelte.ts"
  - "src/lib/cards.svelte.ts"
  - "test/shadow.test.ts"
  - "src-tauri/src/flyway/tail.rs"
  - "src-tauri/src/flyway/act.rs"
  - "src/lib/handle.ts"
  - "src-tauri/src/flyway/look.rs"
  - "src-tauri/src/flyway/moving.rs"
  - "src-tauri/src/flyway/link/moves.rs"
  - "src-tauri/src/flyway/opening.rs"
  - "src/lib/moveall.ts"
  - "src/lib/Exodus.svelte"
  - "src-tauri/src/flyway/link/leaving.rs"
---

# Cards on other walls

The half of distributed Volery that makes it a dashboard rather than a remote spawn button.
Lyss's words: *"I can spawn cards on both laptops and control them from my work laptop."* The
flyway (`src-tauri/src/flyway/`) carries what one wall tells another; this is what a wall
tells the others about its **cards**, how the others draw one, and how they speak to it.
`docs/FLYWAY-REMAINING.md` §3 was the brief.

### A shadow is a fifth kind, not a card wearing a mark

`layout.md` has four kinds of thing standing on the wall — cards, territories, images,
widgets. A card on another machine could have been a `Conversation` with a `host` field, and
`Card.svelte` would have drawn it with no change. It is not, and the reason is what
`Skein.convs` is wired to: rousing at launch, the reap pass, `#fillHistory`, the hold sweep,
`warmSlash`, `#persistConv`'s row writes, the quit dialog's busy count, attention, the Tab
cycle. Every one of those would have had to remember to skip a remote card, and forgetting is
silent until it is not — the rousing pass forgetting spawns `claude --resume <id>` here on a
session that only exists over there. That is CLAUDE.md's "a capability is not a prop" turned
round: **a mark is a guard every caller must remember; a type that cannot be passed where a
`Conversation` is wanted is a guard nobody can forget.**

So `Shadow` (`shadows.svelte.ts`) is its own class in its own collection (`Elsewhere.shadows`),
and it shares three things with a card, each a shape rather than the class: the **face**
(`Card.svelte` takes a structural `CardFace` both satisfy), the **readable** (`Transcript.svelte`
takes `Readable`), and the **handle** a gesture holds (`CardHandle`, `cards.svelte.ts` — see *One
card handle* at the end). Nothing that wants a `Conversation` can be handed any of the three, and
that is the guard; `Skein.convs`, rousing, the reap pass and persistence never see a handle. What
a shadow gets on the wall:

- **Drawn**, by `layout()` itself (`standElsewhere`), in the wall's **left** margin —
  territories flow rightward from the origin, so the left edge is the one that stays put — as
  **a section per project under each wall's name**. See *Sectioned by project* below. Dotted
  border where a territory's is dashed.
- **Focused**, on the same `focusedId` a card uses, so focusing one lets go of the other.
  `App.card` is the focused card's handle whichever wall it is on; `App.focused` is the same card
  when it is this wall's, for what only a card here can be — picked into a gathering, the
  directory of a `!` line.
- **Spoken to**, from the dock, through the same `send` a card here takes — pictures included
  (see *A picture crosses with its prompt* below). What cannot arrive is the handle's to say: a
  quiet wall, a picture to a wall too old to take one, or a prompt past the frame's ceiling is
  refused by `CardHandle.carries` before the draft is cleared, a `!` line has no card here to run in, and
  Volery's own commands are refused with the reason unless they are a verb (`/clear`,
  `/account`), which is asked of the far wall as the right-click would. **The palette is the
  trap here**: it still opens over a `/` offering this wall's commands, and its line sent raw put
  `/gear planning` in front of the far agent as a prompt about the word "planning" and `/btw …`
  into the conversation as a real turn (found in review). So a half-typed name completes as it
  would here, a whole one that is Volery's is run or refused, and one that is the CLI's goes —
  the far wall carries it out as if typed there.
- **Reached by keyboard**, `<space> e e`, which steps through them. Deliberately not a third
  arm of the Tab cycle: both arms walk `canvas.order()`, whose cards are handed to the
  selection and the waiting cycle.
- **Stuck to the glass**, from its right-click menu or `<space> c g` on the focused one, and
  dragged about there by its own gesture. See *On the glass* below for why its spot needed no
  row.
- **Every verb its wall announced**, from the same right-click, chords and dock a card here has
  — see *One card handle*.

The node carries `data-shadow`, never `data-conv`, so `nodeOf` reads a press on one as bare
ground — no pick, no carry on the wall, no pin (which would write a placement row keyed on an id
this store has never seen). Its right-click is the card's own menu (`menu.ts::cardRows`, built by
the handle), behind the verbs its wall announced; what is only meaningful on that machine — its
processes, pinning, a move — is not offered, and a verb it cannot be asked by key says why.
Before it had a menu, a right-click on a shadow fell through to the *ground's* menu and offered
to open a project underneath it. Its one control is a ✕ (and `<space>cc` on the focused one) that
**asks its own wall to close it** — a person's close, which that wall allows
whatever its switch says and whoever opened the card (Lyss: closing only stops work and cannot
hurt the other machine). It asks first when the digest says working or jobs (`closing.ts`, the
same plate as a local close), is refused by *this* wall for a peer without `close_by_person` in
its `can` ("X needs updating to close cards from here"), and **never removes the shadow
itself** — the wall's next snapshot drops it, and a refusal lands on `Shadow.closing`, drawn in
the panel and as a fault. The wall that closes it writes a chronicle row naming who asked. No
strand box, no Tab order, no perf meter. Each of those is a thing that would have
needed a guard; here it needed nothing, which is the point.

**A shadow is also not a dormant card.** A dormant card has a row and no process *yet*, and
wakes when you type. A shadow has no row and no process here, ever. It is drawn muted when its
wall goes quiet, borrowing the dormant fill because "the light is what's missing" is exactly
true — but the words say *not heard from*, never *dormant*.

### Sectioned by project

Lyss: *"all my shadow cards are one big grid, they should be sectioned by projects."* The first
cut made one region per **host** and laid every one of that machine's cards into it, whatever
project each was in — and a territory per project is the whole organising idea of this wall,
so a remote machine's cards were the one place the wall stopped reading the way it reads. Now
`standElsewhere` makes one region per **(host, project)**, stacked down the left margin. The
digest already carried `project`, so nothing new crosses the link.

- **The host is a heading over its sections, not a prefix on each.** `lab · skein` down the
  column eight times is the host said eight times. So `heads` puts the wall's name once, in
  `HOST_HEAD` of room above its first section, and each section's chip says only the project.
  The heading is a new thing to draw rather than a territory's chip — no row, no handle, no
  drag — and it carries *not heard from* where the old region's chip did. Two levels of
  grouping read off the spacing before the words: sections a `REGION_GAP` apart, walls two.
- **Hosts by name, sections by name within one** (`sectionOrder`, case folded). Most recently
  active is the better order for a list you read once and the worse one for a place you come
  back to: a section that jumped to the top because a card in it spoke would move every section
  under it, which is the position-is-memory rule `layout.ts` is built on.
- **A card with no project** — an older build's digest, or one that sent `""` — stands in a
  section called `no project`, last, and never in one called nothing. A chat card is not this
  case: the owner names its project `chat`, and it gets a section by that name.
- **Project, not the owner's territory.** The digest carries `territory` too, and sectioning by
  it would mirror the other wall exactly — but a grouping's name is free text a person typed,
  two of them on different projects can both be "new grouping", and the merge would put
  unrelated cards in one box. A project is stable, and is what Lyss asked for.
- **Still four columns, every section.** The comment over `ELSEWHERE_COLS` used to justify four
  by a region holding a whole machine. That reason went, and four stayed for another: the
  sections stack down one margin, so their cost is paid in *height*. A busy project — this
  repository, on the other laptop, at dozens of cards — at a territory's two columns is a strip
  taller than any screen. Width is the cheap direction there, and one width keeps the column's
  edges straight. Fixed, still, so a machine opening cards does not reshape a section.
- **The id is `sectionId`**, a JSON pair, because both halves are free text and a separator
  either could contain is not a separator.

### On the glass, persisted like a card's

Sink `dbf55968`: Lyss tried to put a shadow on the glass from her work laptop and could not. The
glass is where you put what you want to keep an eye on while working elsewhere, and a card on
another machine is *the* thing you want to keep an eye on while working elsewhere.

**It was session-only for its first two weeks, and Lyss overruled that** (sink `735f3234`: put
back on the glass after every restart, *"they should work exactly the same as normal cards"*).
The three arguments for memory were each answerable once the store's record turned out to need
no new table:

1. **A persisted spot outlives what it points at.** Answered by pruning, below.
2. **`arrange::KINDS` clears as well as sets.** It still must not list this kind, and does not.
   But `glass_spot` — the record every other kind's columns are a *cache* of — is generic
   (`arrangement, kind, ref, x, y`), and `adopt_in`'s shifted copy for a room never seen already
   selects every kind. So a shadow is a `glass_spot` row of kind `shadow` and **nothing else**:
   no table, no columns, no migration, and so safe to run on the installed wall.
3. **The panel already made this choice.** True of what was *said* to a shadow, which is still
   in memory. A spot is an arrangement, which is what the glass persists.

- **Keyed on the shadow id**, `shadowKey(host, card)`, so two walls' cards cannot share a spot.
- **Written through** by `stick_shadow` → `arrange::remember` on every stick, move and unstick,
  beside the in-memory write (`Elsewhere.stick`). A failure is swallowed: the wall is right and
  only this room's memory is behind.
- **Read back by `adopt_arrangement`**, which now answers `shadows` beside the five others;
  `Elsewhere.adoptRoom` replaces the current room's spots with it. The per-room bookkeeping that
  used to live in `shadow.ts` (`enterRoom`, `ShadowGlass`) is gone: the store does it, with the
  same shifted copy.
- **Pruned, per wall, only when that wall was just heard** (`keep_shadow_glass`, off
  `#reconcile`'s `heard`). A card its own wall closed will not come back, so its spots go from
  every room. A silent wall says nothing about its cards — a lid shut, or launch before the link
  is up — and pruning on that would forget everything you stuck. A stored snapshot read at
  launch does not prune either, only a live one. The match is `substr`, not `LIKE`: a host name
  is free text and `_` in it is a wildcard.
- **A spot stuck before the monitors first answered** is kept in memory but not written (no
  current arrangement yet) and replaced when the first room is adopted: a few seconds at launch.

**What it gets on the pane and what it does not.** Drawn at `wall` density by the same
`glassAt` clamp a stuck card gets; its section keeps the slot, because `standElsewhere` lays
out every shadow as if nothing were stuck (the glass's first rule). **Dragged by its own
gesture** (`Canvas.shadowDown`), the way a timeline plate is — not the wall's carry, which hauls
a *selection*, and `pick.ts`'s kinds each write their move to a row. A left press that does not
travel is still the click that focuses it. **No undo record**: the stack's realms each put a row
back and a shadow has none; the same menu item takes it off again.

### What a shadow still does not get

An audit of the four kinds' gestures against shadows, done with the glass. Each is a gap, not a
design, unless it says so:

- **The marquee and the selection** (`standing()`, `pick.ts`). A band across shadows selects
  nothing, a ctrl-click adds nothing, and so a shadow is never carried with other things. A
  fifth `Kind` is the shape that would fix it, and it is a real cost: `Haul`/`World` grow an
  array, every consumer of `studio.picks` has to know a pick can be a card with no row
  (`studio.selected` is cards only, so the dock and broadcast are safe), and a carry on the
  *wall* has nowhere to write. Not done.
- **Tab.** Deliberately not — see *Reached by keyboard* above.
- **Delete**, the dock's gathering and broadcast: images and widgets only, and `selected` is
  this wall's cards. A shadow cannot be in either, which is right.
- **Moving a card on the wall.** By design: a card is laid out in its section, not arranged.
- **Moving a section** is a gesture of its own (2026-10-13, Lyss: *"shadow projects should behave as
  local projects"*): drag its name (`Canvas.sectionDown`). Its place is `Elsewhere.sections`, kept in
  `localStorage` (`skein.sections.v1`) on `berth.svelte.ts`'s argument, passed to `standElsewhere`,
  which still reserves the section's slot in the column so dragging one away does not slide the rest up.
  The name says which wall it is on (`skein · QUEERISFREEDOM`); the host heading is far above a
  tall section. The way back is the section's own right-click, `put it back in line`
  (`moveSection(id, null)`); the drag itself still has no key path.
- **Strands and roots.** `cardBoxes` has no shadows, so no strands, roots or wisps reach one —
  61057379 is drawing roots across walls as this is written.

### The digest is the owner's front end's, and Rust does not read it

The tier is `classify.ts`'s taxonomy, in TypeScript; Rust sees every raw event first and still
cannot say a card is asking. So the **owning wall's front end** makes one `CardDigest` per open
card (`digestOf`), and Rust carries the whole snapshot as **one opaque JSON value per wall** —
`widget.config_json`'s bargain across a network. `readSnapshot` runs on every read and
degrades: an unknown tier reads as `rest`, the one that claims nothing; a card with no id is
dropped; every string is capped and scrubbed. A field a newer build adds costs no Rust change
and no lockstep between two machines that are never upgraded together.

**Do not port the taxonomy to Rust to make this tidier.** Two homes for one vocabulary drift
silently, and the drift lands on the machine you are not looking at. If it ever must be, it
needs a shared fixture corpus run by both `bun test` and `cargo test`.

The tier is the **owner's**, as sent, and never re-derived on the far side. A resting card
warms with neglect; that is a change to the owner's own `tier` derived, which the owner's
publisher hears, so the next snapshot carries it. Re-warming here would be a second home for
the ladder in `Conversation.tier`, and gets the held card wrong — the owner keeps a card
holding a prompt at `rest` on purpose.

### What is drawn is one shape, and the digest is that shape spread

Lyss, 2026-10-19: *"remote cards report 0 tok and 0 turns, it shouldn't have been possible, we
need a structural fix."* The panel's footer read `turns`, `ctxTokens` and `costUsd` off
`Readable`, which a shadow answered with constants (`readonly turns = 0`); the digest had never
carried them, and nothing anywhere failed while it was so. The same audit found six more: a far
chat card drawn as a project, no *planning* chip, no model chip, no allowance band for a card
held over there, no compaction, no held processes. Each was a field one list (what a surface
draws) had and another list (what the digest carries) did not, kept in step by hand.

So the facts a surface draws are **one type, `gist.ts::Gist`**, and both kinds produce it:
`CardHandle.gist` is `gistOf(conv)` for a card here and `Shadow.gist` for one elsewhere. The
digest **spreads `wireGist(gistOf(c))`** — the very function the local face is made by — and
`shadow.ts::GIST_READ` is a mapped type over `Gist` with one reader per key, so a key added to
the shape is a compile error in `gistOf` and in the reader until both carry it. Wire names are
the gist's keys, which were already the digest's (`kind`, `planning`, `model`, `account`…), so
an older wall reads every field it ever read.

- **Unknown is `null`, drawn `—`, never zero.** A wall from before a field sends nothing and
  every reader answers that as unknown (`countSaid`). A default would be a number nobody
  measured, which is the bug.
- **What changes per token or per second is rounded before it is sent** (`wireGist`: cost to
  the cent, a compaction to a twentieth), because `sameCards` ships a snapshot whenever a
  digest would draw differently.
- **Moments are on the maker's clock** and `Shadow.gist` moves them here by the snapshot's own
  `at` (`turnSince`, a hold's `until`); while the wall is unheard it claims no turn, hold,
  compaction or held processes — `faceOf`'s honesty.
- **A path is not a fact** (`planDoc`, `cwd`): it names a file on the owning machine, so it
  stays on `Conversation`, read through `.conv` only for a gesture.
- **The guard is `test/gist.test.ts`**, in `finding.test.ts`'s shape: every component, so a new
  surface is covered without a list; it fails a drawn field read through `.conv` or through a
  name given to it (`const conv = $derived(card?.conv …)` is how `ModelMenu` hid it), a gist key
  that is a constant on `Shadow`, and a digest or reader that leaves a key out. Each was checked
  to fail with its bug put back by hand.

A card restored dormant on its own wall also published no rest (`restingSince` null, it had no
rest of this session's), so the far side could not date it at all; the source now falls back to
the store's last activity.

### Published by folding, never by a clock

CLAUDE.md names three places this app goes and looks. This is not a fourth. The snapshot is an
`$effect` over the wall's cards, and every field it reads is state or a derived over the event
fold, so it re-runs when a card changes and at no other time. Two fields would have broken
that, and both were taken out:

- **Idle** changes every second with no event behind it. The digest carries `restingSince` —
  constant for as long as the card rests — and the far side computes idle as
  `(snapshot.at − restingSince) + (now − madeAt)`, where `madeAt` is arrival less the link's
  `ageMs`. Both owner-clock values are subtracted from each other and both local values from
  each other, so **no term compares two machines' clocks** and the answer survives them
  disagreeing. `idleOf` holds it and `test/shadow.test.ts` puts an hour of skew through it.
- **`doing`** appends a live countdown to a held prompt and a running total to a compaction.
  `steadyDoing` keeps the words and drops the counting.

What is bounded is the **send**: offered to the link at most once a second, and only when it
would draw differently (`sameCards`, with `ctx` rounded so a token's growth is not a change).

**Nothing is published before `skein.loaded`.** A snapshot replaces the last wholesale and a
card missing from it reads as closed; `Skein.load` paints from SQLite before any card has a
process, so a snapshot in that window would flash every unread card as gone on every other
wall. A version stops an *older* snapshot winning, not a *premature* one. (Raised by
`34b07397` in review; the shape is worth keeping for anything else that publishes a whole set.)

### A quiet wall's cards claim nothing

The whole honesty of a shadow. A laptop that shut its lid mid-turn sent a digest saying
*working* and will never send the one that takes it back. Drawn as it was, the card glows
celadon over a machine in a bag — **a link that is down looking exactly like an agent that is
thinking.** So past `QUIET_AFTER_MS` (the fleet's, 90s — the roster refuses a prompt to a
quiet wall at the same moment, so a card drawn as working past it would be one you could see
and not reach) `faceOf` drops the tier to `rest`, takes `working` off, draws it muted and says
`lab not heard from for 1m 31s · was working`.

Liveness is the **roster's** word (`flyway:roster`'s `quietMs`) or a snapshot arriving, never
the snapshot's age. A snapshot's age runs from publish, so a wall whose cards have not changed
for an hour sends an hour-old snapshot every exchange; its age says nothing about whether the
wall is up.

### Four readings of a prompt, and the fourth is the reason

A local prompt has three: `pending` until the echo, `failed` if it never left, nothing once it
arrived. A remote one needs one more between the two that matter — **it has left this wall and
the other has not said it has it** — because folding that into `pending` would draw a link
that is down exactly like an agent that has not got round to it, and the two want opposite
things from you: patience, or the other machine woken.

| state | look | words |
|---|---|---|
| `queued` | dashed rule, like a local pending | not left this wall yet |
| `left` | **dotted** — the other wall's stitch, because that is where it is | left this wall · lab has not said it has it |
| `taken` | plain | lab has it |
| `refused` | rust, like a local failed send | not delivered — *why* |

`left` is only ever set by the link's `flyway:prompt-left`, emitted **after a real write to a
connection** — never on handing the prompt to Rust. Claiming it while the prompt still sat in
this wall's outbox would make the fourth state worthless. Past `GIVE_UP_MS` (the fleet's) with
no answer, a `queued` prompt reads as failed (*never left this wall*) and a `left` one says it
does not know — *lab never answered — it may or may not have arrived* — rather than guessing
either way. Those are *readings*, not states: a late answer still lands (`advance`), and an
answer is final, so a stale `left` cannot walk a delivered prompt back into doubt.

**Refused now, never queued for later.** A prompt into a quiet wall is refused on the spot,
with the draft left in the dock — clearing it into a line in a panel that may be shut would be
the send looking like it went. Queueing for reconnect is convenient and delivers, when a lid
lifts eight hours later, something you have since changed your mind about, onto a card running
`--dangerously-skip-permissions`. The fleet's ask was built with the same refusal and a prompt
is the same kind of act: not idempotent, and only worth doing while somebody is waiting. The
dock refuses it first, while the card is already drawn as unheard, so the wall cannot say one
thing on the card and another under the prompt; the link refuses it again for an unknown host, and the
far wall's "take work from other walls" switch gates prompts exactly as it gates spawns.

### The owning wall's half

`flyway:prompt` arrives; `Elsewhere.#take` finds the card and hands the text to **`Skein.send`**
— the same path a prompt typed here takes, so a dormant card wakes, the echo marks it, a held
account holds it. It arrives introduced (`conv.note("sent from desk")`), because a `you` line
nobody at this keyboard typed is the transcript putting words in somebody's mouth. `taken` is
answered when `Skein.send` says the wall has it — delivered, or held for an account, which
keeps it — and `refused` when the send failed there, with the card's own reason.
`Skein.send` returns that boolean for this caller alone, and **"held" means *this* text is
in the slot**: `#hold` refuses to overwrite a different prompt already waiting, so a card
holding one drops a second — and answering off `held !== null` told another wall a prompt
had arrived that nothing would ever send (found in review; the local half of that drop is
sink `f20aa3b2`).

Three more guards on this side, each a way the first cut answered wrongly. A prompt that
arrives **before `skein.loaded`** is refused as *still starting*, not *it may have been
closed* — every card looks absent until the wall has read them. A **repeat** of an id
already taken gets the first answer again and is never sent twice, keyed on the asking host
and the id (the fleet's lesson about ids alone); the link drops repeats too, and this is the
second lock on a door whose failure is a second turn on a card with the machine in its hands.
And every arrival is **answered**, success or throw — an asker that never hears back can only
say it does not know.

### A picture crosses with its prompt

Lyss attached a screenshot to a prompt for a card on the other laptop and was told *"pictures
stay on this wall — only words go to …"*. That was one line in `RemoteCard.carries`, and it was
a special case standing exactly where her principle says none should: a card elsewhere gets
what a card here gets, by construction. And there was nothing to build on either end — every
wall already knows how to attach a picture (`attach.md`); the far wall needed only the bytes.

So **the payload rides the prompt**, and both ends are the code a local paste already runs:

- **The sender** cuts the draft with `attach.ts::turnOf` — the function `Field.turn` now is —
  which carries, beside the blocks, echo and thumbnails, the pictures the sentence still names
  (`Turn.carried`). `Elsewhere.send` hands those to `flyway_prompt` with the sentence *as typed*,
  tokens and all, and keeps only the thumbnails on the `Sent`, which `asLines` draws under the
  line as a local prompt's are, while it travels and once it has landed.
- **The owning wall** (`Elsewhere.#take`) puts each picture through `Attachments.fromCarried`,
  which is the same private `#take` a paste goes through — decoded, held to `MAX_BYTES`, scaled
  if over the edge, given a thumbnail — and cuts the sentence with the same `turnOf`. The card
  then gets, through `Skein.send`, the turn a person at that keyboard would have sent: interleaved
  blocks, the echo the replay will claim, thumbnails in its own panel. All or nothing — one
  picture the webview cannot decode refuses the prompt, named, because the sentence arriving
  without one of its pictures is the one thing this must not do.

**On the wire it is its own tag, `pictured`** (`FleetMsg::Pictured`), an `Ask` with `pictures`
set. Not a field on `prompt`: a wall from before would read the field as absent and hand its
card a sentence about `[image 1]` with no image — and an older *relay* would strip it on the way
through, the same silence one hop later. Under its own tag both pass over the whole request
(`frame::take`), and the sender has already refused a wall that does not announce `pictures` in
`Facts::can` (`Unsendable::Older`, and `handle.ts::carriesTo` before that, with the draft kept).
`Remote.pictures` is the roster row's word; the dock says *words only* of exactly the walls it is
still true of.

**The one limit a remote picture has, and it is the frame's.** A prompt is one sealed frame, a
frame is at most 8 MB (`wire::MAX_FRAME`), and a wall sent a larger one fails the *whole*
exchange — sink and cards with it. So `CARRY_MOST` — 7 MB of words-as-JSON plus base64, one
number in `attach.rs` and `attach.ts` held equal by a test — is the ceiling, a megabyte under the
frame rather than to the millimetre. One picture at the API's own 5 MB fits; several full-size
screenshots together may not, and are refused before the draft is cleared, in megabytes, never
cut down to fit. The per-picture limits (`MAX_ATTACHED`, `MAX_BYTES`) are the dock's, reused on
the far side, not a second set.

- **Checked on both walls, refused rather than mended** (`attach::carried_fit`): count, a name
  that can sit in a sentence and appears there as its token, a sendable media type, base64 and
  nothing else, the size, and the first bytes agreeing with the media type — the API refuses a
  request where the two disagree, with a 400 that names nothing. On the sending wall before
  anything is queued; on the owning wall before anything reaches the front end, because those
  bytes came from another machine and end up in a `src=` and a request.
- **On an exchange of its own, never in a greeting, never relayed.** A words-only prompt rides
  every tick's greeting until answered. A greeting is one exchange bounded at twenty seconds,
  and seven megabytes on a slow uplink would time the *whole greeting* out — sink, cards and
  board with it — on every tick for the two minutes the prompt lives (found in review). So
  `gossip` never carries a pictured request; the asker alone says it, to the wall it is for, in
  `link.rs::push_pictured`: its own exchange, given `wire::carrying_within` (twenty seconds
  plus one per 128 KB, a megabit floor — 76s at the ceiling), one upload in flight per prompt,
  re-said on each tick while unanswered (`Fleet::pictured_for`), and marked *left* only when
  that exchange lands. The cost is reach: a wall this one cannot dial — reachable only through
  a third, or only dialling in — never receives one, and the prompt reads *never left this wall*
  rather than arriving as words. A relay that is handed one anyway drops it.
- **Held for an account like any other, pictures and all** (since 2026-10-16). It was *never*
  held: the hold kept text alone, a picture could neither be written there nor dropped from the
  sentence naming it, and `#deliver` failed a pictured prompt and answered the far wall refused
  (`PICTURES_NOT_HELD`). Now the owning wall holds it on *its* disk — `held_picture`, the one
  carve-out from attachments never touching one (`attach.md`) — and answers `taken`, which is
  true: the wall has it and will send it. Local and remote alike, as the refusal was.
- **Held until answered, and never written to disk in transit.** The fleet keeps an ask for ten minutes for
  the *key* that stops a redelivered frame being a second prompt; `unburden` drops the pictures
  the moment an answer is recorded or heard, and the addressee never keeps them at all. Nothing
  on either wall writes them anywhere, which is `attach.md`'s rule kept across the wire.

**What driving it found that the suites did not.** Three bugs, each invisible to a green run:

- **No prompt with a picture in it had ever been claimed, here or anywhere.** `attach.ts::echoOf`
  joined text blocks with nothing; `textOf`, which reads the replay, has always joined them with
  a newline. The far card answered correctly and then drew the prompt twice and was nudged about
  a prompt it had answered. `echoOf` is `textOf` now (`attach.md`).
- **A picture dropped on the dock for a far card was pinned to the wall.** The drop handler
  asked `targets` — this wall's cards — where the send asks `reach`. It asks `reach` now.
- **A picture whose bytes are not its type** (a JPEG named `.png`) passed the dock and was
  refused by the far wall's check after the draft had gone; `carriesTo` asks `looksLike` too.

Demonstrated 2026-10-15 between two frozen labs (`pica`, `picb --peer pica`), driven by the
control surface through the dock's own path. A card opened on picb, its wall taking work, and
its shadow on pica focused by `<space> e e`; the dock read *on lab-picb — sent there*, no
longer *words only*. A pasted picture (`KIWI 4817` beside an orange circle) sent as
*"What word and number are written in [pasted.png], and what colour is the circle?"* was
answered on picb *"It says KIWI 4817, and the circle is orange."*, claimed once with no nudge,
its thumbnail drawn under the prompt on both walls and pica's receipt reading *lab-picb has
it*. Two 3.6 MB pictures dropped on the dock attached rather than pinned, and the send was
refused with both kept: *"this prompt comes to 9.2 MB and at most 7 MB goes to
lab-picb.queerisfreedom at once — send fewer pictures, or smaller ones"*. One of them alone
(4.8 MB of base64) crossed in one frame and was described *"Grey static of random coloured
pixels."* **Not shown:** a slow link (both labs are on one machine, so `carrying_within` is
held by reasoning, not measured), a far wall from before pictures (the unit tests hold the
refusal and the skipped tag), and the hold, which needs every account at its limit.

A card **opened** here at another wall's request says so on its own face — `Conversation.bornFor`,
drawn as *from desk* in the qualifier row beside the account. A field rather than a prop for
the reason `elsewhere` is a field of the face: every surface that draws a card reads it, so
none can forget it. The link's record of births and the card can arrive in either order; an
effect stamps whichever comes second.

### And so does a file, pulled rather than carried

A file, or bytes with no path (a pasted blob, a browser drag), goes to a card on another wall
the way it goes to one here — as a path the agent reads — except the path has to be one on
*that* machine (sink `fd7ef025`). So the bytes cross and are written on the owning wall, into
the card's own folder (`attachments.rs`), and its agent is handed that path.

- **Pulled, not carried in the frame.** The prompt rides `Pictured`, 7 MB for everything, and a
  file may be 24 MB. The transfer that already moves a question's files in parts (`look.rs`)
  is reused whole: the sender holds the files under a stage id (`stage_outbound` — a path is
  served from where it is, bytes are written under `attachments/_outbound` first), and the
  owning wall asks for that id the way it asks for a question's files — `look_here` serves a
  `stage-` id from `attachments::outbound_args`, a question's own id from `ask.rs` as before.
  `flyway_fetch` gathers and writes into the card's folder. A stage is let go after an hour.
- **The prompt names the stage in its picture list**, as an entry of its own type
  (`attach.ts::MANIFEST`), with the token each file wears. Not in a new field of the frame: a
  wall from before files would drop an unknown field in silence and hand its card a sentence
  naming files it never got, where an unknown entry in the picture list is refused whole by its
  own `carried_fit`. A wall that has files announces `files` (`attachments::CAN_FILES`), and the
  dock refuses with the draft kept when the far wall has not (`handle.ts::carriesTo`).
- **The owning wall cuts the sentence itself**, with `turnFrom` and its own card's reach — so a
  far *chat* card gets a PDF inline and refuses anything else, exactly as one here would. All
  or nothing, like the pictures: a file that did not arrive refuses the prompt.
- **A folder does not travel.** It is a place on the sending machine; its files can be dropped
  instead, and the dock says so.

Driven across two peered lab walls (`bun run lab att`, `bun run lab atb --peer att`): a PDF by
path, a pasted text file as bytes and a picture, to a Haiku card on the other wall, which named
both code words and the colours. The owning wall's folder held the two files.

**An answer and a notice reply carry them too.** Sent from here they go the prompt's way —
pictures in the list, files staged and named by a manifest (`Elsewhere.#carrying`) — and
`flyway_prompt` no longer drops a picture because an `askId` is set. On the owning wall an
answer with attachments is not handed straight into the parked call as words are
(`ask::answer_from_afar`): `ask::afar_may_attach` checks the question is still parked, on this
card, and an agent's own, and the answer goes to the front end like a prompt, where
`#gather` decodes the pictures and fetches the files and `Skein.answerAskWith` gives it through
`answer_ask` — the channel a click here uses, so the tool result carries the image blocks.
A notice reply takes the same `#gather` into `followUpNotice`. Driven across the two labs: a
note and a picture in a remote `ask_user` answer (the note reached the agent as a path on its
machine, the picture's colours were named) and a picture in a remote notice reply.

### A question asked over there is answered from here

The general rule (sink `16864f3d`): **anything that parks waiting for a person must travel to
where the person is, or fail fast.** A card on the home laptop stopped on `ask_user` while Lyss
sits at the work laptop waits out the whole window and then proceeds without her — "control
them from my work laptop" is simply not true while a question can strand a card.

- **The question rides the snapshot.** `CardDigest.asks` carries each parked question's words —
  header, question, options — and `since` on the owner's clock, read against the snapshot's `at`
  the way `restingSince` is (`askedAt`). Volery's own questions (`ours`) do not ride `asks`:
  each travels in a field of its own carrying its evidence — a removal and a close in theirs,
  and **every other confirmation in `confirms`, by default** — see *Every confirmation travels
  unless it says why not* below. This sentence once said none of them ever would, then that
  only a removal or a close did, and both versions were the bug.
- **Words in the snapshot; the call itself pulled.** See *What a question shows* below — this
  bullet used to say a design or a file never crossed, and that was the bug.
- **The answer rides the prompt wire**, `flyway_prompt` with an `askId`, carrying exactly what
  this wall's dock would have sent (`composeAnswer`). The owning wall hands it straight into
  the parked call (`ask::answer_from_afar`, c86101fa's); its own panel comes down through
  `ask:closed`. It goes through the four readings a prompt does and is drawn among what was
  said to the card, marked *answer to …*.
- **The same panel draws it.** `Dock.svelte` renders `Ask.svelte` over a sheet the shadow keeps
  per ask — the same object across snapshots, so half an answered sheet survives the next one
  arriving. It stands ahead of a local question only when its card is the one in the ring
  (you went to it), and otherwise behind every local question and ahead of every notice: still
  an agent stopped on a clock, just on another machine.
- **No countdown, here or there.** It used to be held still (`stirs={false}`), counting the base
  window from when it was asked, because no touch travels to lengthen the far call. Questions
  have had no deadline since 2026-10-16 (`ask.md`), so the far panel draws when it was asked, as
  a local one does, and there is no special case left.
- **Hidden while its answer is on the way**, given back if the answer is refused (the sheet
  still filled in), and **not answerable at all once its wall is unheard** — the question may
  have been answered there or run out of time, and a question not confirmed as still waiting
  must not look like one waiting for an answer. The panel says which (`handle.ts::panelNotes`).

Demonstrated 2026-10-08 between two walls of one build: a card on lab2 parked on a real
`ask_user`, the question was on lab's dock within ~3s, "square" clicked there was `taken` in
0.6s and the card resumed and said "square" at 2.7s. Then a question left up while lab2 was
killed: past 90s it was no longer offered and the panel said why.

### What a question shows crosses too, and is drawn by the same code

For its first week a remote question was words only: a preview was left behind as code another
wall would run, a file as a path that means nothing on another machine, and `shows` put a
sentence on the question saying so. Lyss answered RISE questions over three screenshots she could
not see (sink `77c043c6`, `be3196fa`, `154a1637`) and set the design for the fix: *"the remote
specific code should be as small as possible, the shared unique components should be as much as
possible … I shouldn't discover shadow card specific bugs that don't exist on normal cards."*

So nothing crosses as a *rendering*. **The call crosses** — `ask.rs` still holds the parked
`ask_user`'s arguments, every file already resolved to the `(root, path)` pair the viewer reads —
and the far wall draws it through **the same `normalizeAsk`, `Ask.svelte`, `Gallery.svelte` and
`Leaf.svelte`** a local question goes through. What is remote-specific is the transport
(`flyway/look.rs`, two arms in `link.rs`) and twenty lines in `Elsewhere.#look`; nothing in the
drawing knows the question came from elsewhere, so there is no second path for a shadow-only bug
to live on.

- **Pulled the moment a question that `shows` arrives**, not when the dock draws it (Lyss's call,
  2026-10-12): the pictures are there before anybody looks, at the cost of a pull per question
  whether or not it is opened. Never gossiped — a snapshot is re-sent on every change, and a
  screenshot in it would be one sent dozens of times an hour. `tail.rs`'s shape: one wall asks,
  the other answers on the same stream from `Parked::args` and its own disk, nothing kept there.
- **In parts, so no limit is lower than here.** A local question's file is read up to 24 MB
  (`find::DOC_CAP`) and a frame is 8 MB, so a file crosses over as many exchanges as it takes,
  each answer spending at most `look::BUDGET` on arguments and base64 together — 2 MB, sized to
  the exchange's twenty seconds over a slow relay rather than to the frame. 24 MB a file, the same
  ceiling; 96 MB a question, which a local question has no need of because it reads lazily. The
  arguments themselves cross in one answer and stop at 2 MB (`ARGS_MOST`) — the one limit a local
  question does not have, met only by a preview with images inlined into its markup. Two pulls
  run at a time, since each gathers its files in memory before writing them.
- **Matched by position, on one walk.** Both walls number the files by `ask::each_site` — the call,
  its options, each question, each of its options — which is also the walk `attach_files`
  resolves them on. A second spelling of it would be a screenshot under the wrong option.
- **Written to a folder of this wall's own** (`<app data>/afar-asks/<host>/<ask>/<n>/<name>`) and
  pointed at there. Taken away when the question goes (`flyway_look_forget`, off `#sheets`, and
  again by a pull that lands after its question went); the whole folder is wiped when the link
  comes up, since no sheet survives a restart, and a pull sweeps anything over a day old.
- **Every file slot is overwritten on arrival.** With the pair this wall wrote, or with
  `{ path, fault }` — never left as the other machine wrote it, because a `root` from there is a
  path on *this* disk the viewer would happily read. The fault is drawn on the gallery panel the
  file would have filled (`fileFrom` keeps it; `Gallery` puts it on the plate a failed read uses):
  too large, unreadable over there, changed while crossing, stopped arriving — each names the
  file and the wall. A pull that fails outright (an older wall, a quiet one, the question gone)
  says why in the question's words, where they already said something was coming. A file that
  stopped partway is drawn as its fault and the reply says `whole: false`. Either way it is asked
  again on the next snapshot **that wall itself sends**, three times in all, never on a clock and
  never off another wall's snapshot or a quiet wall's. A question being answered from here is
  not pulled for.
- **Redrawn without disturbing the sheet.** The redraw keeps answers by position, moves an answer
  that was an option onto the full label (the digest cuts labels at 300), and writes nothing when
  nothing moved. `Ask.svelte`'s draft is keyed on the *value* answered at the step rather than
  on the arrays, because the first cut cleared a half-typed answer the moment the pictures
  landed — ask.md's "losing what I was typing", on a road only a remote question had. Both were
  found by the review before this shipped.
- **Scripts follow the card's kind**, as they do locally — `scripts={kind !== "chat"}` — where the
  remote panel used to pass `false` because nothing it drew had a script.
- **Both walls need the build.** An owning wall from before this announces no `look` in
  `Facts::can`, and the question says it runs an older Volery.

Nothing about the drawing differs any more: the held-still countdown was the last remote-only
reading, and it went with the countdown.

### And it reaches you when you are not looking

The dashboard's claim is that you can look away from it. A remote question that only took the
dock reached you only while Volery was the window in front; in any other window nothing said a
card on the other machine had stopped, which is the failure this feature exists to prevent, at
exactly the distance the flyway added.

So a remote question feeds **the existing ladder** — taskbar flash, then the peek, then the
chime (`attention.svelte.ts`) — as a `blocked` row, through one more injected list beside
`instruments` and `notices` (`shadow.ts::remoteQuestions`). Not a second ladder: the ladder
already never needed a `Conversation`, only rows, which is what let a rung countdown join it.
One row per card, its oldest open question, because a local card is one row for its
`pendingAsk` and the peek keys its rows on the id. `key` is the ask, so a card that asks again
after being answered rings again. The shadow's own `open` decides what counts, so a question
whose answer is on its way, or whose wall has gone quiet, is not news either.
`waitedSeconds` is measured from `askedAt`, which is what keeps a question that arrived with a
wall this one had just met from ringing as fresh. Clicking the row (`peek:goto`) lands on the
shadow by `focusCard`, exactly as a card here is landed on, so its question is in the dock.
(It used to open the panel as well, which a card here's row never did — one of the small
differences the handle took out; `<space> e e` still opens it, since stepping to a card over
there is asking to read it.)

Demonstrated 2026-10-08: a question parked on lab2, lab unfocused and undriven — the peek came
up reading "one thing wants you · proj-b · on lab2", and a real click on it brought lab to the
front on that card with the question in the dock. A wall with the control surface armed stays
silent on purpose (`isDriven`), so a lab run reads the rows off `snapshot.attention.items`.

### And Rust reads four fields of it, once

`walls` (`flyway/reach.rs`) is the agents' view of the other walls, and a card wants the
cards' handles in it. So `reach::cards_in` reads `id`, `title`, `project` and a state out of
the snapshot — the one place Rust looks inside. It keeps the bargain rather than breaking it:
the tier is passed on as the owner's word and never re-derived, a missing or mistyped field
is empty, a card with no id is skipped, every string is scrubbed and capped, and a quiet
wall's cards say `unknown` — the honesty `faceOf` keeps on the glass, kept in the tool too.

### The conversation itself, pulled while a panel is open on it

A digest is the tier; a conversation is the other kind of thing — hundreds of kilobytes,
wanted one card at a time, and only while somebody is reading it. So it is **never
gossiped**. Opening the panel on a shadow asks the owning wall for that card's tail
(`flyway_tail`, through `CardHandle.history`), and the panel is the same `Transcript.svelte` a
local card uses, mounted the same way: folded tool calls that open onto their arguments and
result, markdown, the rails, the find bar. There is no second panel component any more — what
only a card elsewhere says (where it runs, in the footer beside its model; the notes above the
column; when to read again) is three optional fields of `Readable` (`elsewhere`, `notes`,
`historyMark`) the shadow answers and a card here does not.

- **One exchange, answered on the same stream** (`flyway/tail.rs`). Every other request
  between walls is answered by the far wall dialling *back* with a fleet `answer`, which is
  kept and re-said every tick (`Fleet::open`) — right for an act, ruinous for a reading: a
  400k tail re-said to every peer every thirty seconds is the transcript gossiped after all.
  So the far wall holds the dialler's stream open while its front end makes the tail and
  writes it back there (`Link::answer_all`). Nothing is kept on either side, nothing retries.
- **The owning front end makes it, parked the way `ask.rs` parks a `tools/call`.** The tail
  is `tailOf` over `history` and `lines` — the taxonomy stays in TypeScript — so an arriving
  `tail` is a oneshot under a fresh id, a `flyway:tail` event, and `flyway_tail_answer`
  handing it back (`Elsewhere.#lend`). A card nobody on the owning wall has opened has its
  scrollback read off disk first, as opening it there would. Twelve seconds, well inside the
  asker's twenty-second exchange, and always answered — "still starting", "no card … is
  open", or the lines.
- **Bounded on the way out and again on the way in** (`tail::fit`): an array of at most 120
  objects of at most 16 fields, every string scrubbed (`crate::clean`) and capped, nothing
  nested past a call, the whole budget — field names included — spent from the newest line
  backwards and never exceeded, not even for the newest. Lines of which none could be read
  is a broken answer, not an empty conversation. A different build's agent output
  is going into this card's panel; `readTail` caps too, and Rust is not the hole between.
- **Refused at once, never waited on** (`Link::tail_reachable`): an unknown wall, a quiet one
  (the roster's 90s, in the fleet's own words), or one too old — a wall that can answer says
  `tail` in its `Facts::can`. Not one of `fleet::CAN`, since those are the acts an *agent*
  may ask and a wall missing one is told to agents as unsteerable; a 0.43 wall is steerable
  and merely unreadable. Even sent, an older wall passes over `tail` as a word it has no use
  for (`frame::take`) and its sink carries on.
- **Not gated by "take work from other walls".** That switch is about *starting* work; a read
  starts nothing, and gating it would be a wall whose cards you can see and not read — the
  argument that already lets an answer to a parked question through.
- **Refreshed off the snapshot, not a clock.** While the panel is open, `Transcript`'s history
  effect re-reads whenever `Shadow.historyMark` changes — when the card's settled last line, its
  activity (`doing` — the only field a run of tool calls with nothing said between them moves),
  its resting moment or `working` changes, and when its wall is heard again. A `$derived` string,
  **not a getter**: `digest` is replaced on every snapshot, and a getter would hand the effect
  that signal, so a snapshot that moved *another* card would pull this one's conversation over
  the link again. A read refused while the wall was quiet is not the last word (found in review:
  without `unheard` in the string, an idle card's panel stayed on the error for good).
  One read in flight and one queued behind it (`Shadow.readTail`). Only a first read says
  `loading`; a refresh that fails keeps what was read, since it is still what was said, and
  puts the reason in `tailWhy`.
- **A read never moves the tick's backoff.** `read_tail` leaves `failing` alone: a read that
  ran long — a relay, a far scrollback read off disk — is not a wall asleep, and marking it
  would let reading a transcript decide when two walls next sync.

Demonstrated 2026-10-08 between two walls of one build (`lab`, `lab2`): a card on lab2 read a
file and answered in markdown; opening its shadow's panel on lab drew the prompt, the folded
`Read` (opening onto the path and the file's six lines) and the heading and bold list. A
second turn on lab2 appeared in lab's open panel on its own, 3 → 6 lines.

### Notices travel too

A notice exists to tell you a card wants you — finished, ended on a question, gave up, or said
something itself (`notice.md`) — and its queue was this wall's. So a card on the home laptop
finishing while Lyss sat at the office showed its tier on the shadow and nothing else: the one
thing notices are for stopped at the machine boundary. Sink `16864f3d` item 2, built on the
question's template rather than beside it (`afar.ts`).

- **The rows ride the digest** (`CardDigest.notices`): id, kind, text capped at 6,000,
  `raisedAt` on the owner's clock, and the ask id when the notice is holding its card's turn
  open. `notice.rs` and `notice.ts` still decide *whether* a notice is raised — the detector
  and the holds were measured and are not re-derived here; what crosses is the notice.
- **Drawn by the same `Notice.svelte`**, keyed on the shadow (`noticeHere`) so it can never be
  mistaken for a row of this wall's own queue, behind every question and every local notice
  unless its card is the one in the ring — the place a remote question takes among the asks.
  Not answerable while its wall is unheard, `open`'s honesty, and hidden while the answer
  travels, given back with a fault if it is refused.
- **Taking one down is an answer that names the notice**, down the prompt wire with
  `askId: "notice:<id>"` and the text `acknowledged` or the follow-up as typed. Not a new tag:
  a wall from before this reads the prefixed id as an ask id, finds no such question and
  refuses, which is right from a wall that never published the notice. The owning wall's
  `deliver_here` hands it to the front end (`PromptHere.notice`), and `Elsewhere.#take` makes
  the same two gestures its own dock makes — `acknowledgeNotice`, `followUpNotice` — so the
  queue, the card and the register cannot tell the two apart. A notice holding a turn open is
  answered by its real ask id instead, into the call, exactly as a question is.
- **The switch.** An acknowledgement starts nothing and passes "take work from other walls"
  like a question's answer; a **follow-up** is a message that wakes the card, and is held to
  the switch like any prompt (`notice::answer_starts_nothing`). Only a person's: an agent on
  another wall has no business clearing this wall's queue, and `deliver_here` refuses one.
- **It rings.** `afar.ts::remoteNotices` joins `remoteQuestions` on the same injected list of
  the attention ladder — one row per card, its newest notice, and none for a card that has a
  question open, as a local card with a pending ask has no notice row.

Demonstrated 2026-10-09 between two walls of one frozen build (`lab`, `lab2`): a card on lab2
finished a turn, its "finished" notice was in lab2's queue and on lab's shadow, dock and
attention ladder within seconds, and pressing *acknowledge* in lab's dock emptied lab2's queue
inside a second.

### The billboard crosses too — and it is not the notice queue

Two things on this wall are called notices and only one of them is *Notices travel too* above:
that is the queue a card's finished turn or question raises for a person. The **billboard** —
`board`, `post`, `unpost`, standing coordination between cards — crosses as well since
2026-10-14, by a different shape and for a different reader: each wall says its whole board on
every exchange (`flyway/boards.rs`, a `board` frame beside the cards snapshot, in Rust because the
board is Rust's), every other wall reads it beside its own named by machine, and a notice is
taken down from another wall by asking the wall it lives on. `board.md`, *Across the flyway*, is
the design: why the home wall stays the authority, why a notice that names files is read on
another wall and never served there, what a quiet wall's notices do, and who may take one down
from where.

### A removal confirmed from another wall

The one of Volery's own three questions that crosses, and it crosses because Lyss overruled
the proposal that it should not: *"it should be my judgement whether to go through it or not,
blocked away by volery."* (sink `7207a6d9`). Close stays local — a shadow has its own close,
asked as a person from its ✕ — and unpost stayed local, on the argument that a board notice is
one wall's coordination with its own cards, until the billboard itself crossed (`board.md`,
*Across the flyway*); a close and an unpost both travel now. **The next person will read the old sentence in `ask.rs` or
here and think none of the three travel; `ask::afar_may_answer` is the rule, and holds it by
test.**

The care is all in what the confirmation carries, because what she gives up by not being at
that machine is the glance. `remove::evidence` writes it beside the prose question: the
machine (`flyway::key::host_name`), each target's path **as that machine resolved it**
(canonical, a link's parent canonicalised rather than the link followed), file, directory or
link, how many entries and how large, whether either is only a floor, whether it is inside the
card's own working tree, git's word on it, the other cards that wrote there and any dev server
running out of it, and the card's reason. Words only — no listing, no contents.

- **The far wall composes the question from those fields alone** (`afar.ts::removalHere`) and
  never draws the owner's prose. A field missing is then a question it cannot compose, and
  `readRemoval` refuses the whole removal rather than drawing less: a confirmation reduced to a
  path string is exactly the version that deserved the original worry.
- **Named for the wall it was heard from**, which the link vouches for, and not drawn at all if
  the evidence names a different machine. The header the peek prints is `delete on <host>`,
  and the body opens on *that machine's disk, not this machine's*.
- **A field of its own** (`CardDigest.removals`), never inside `asks`. An older far wall reads
  `asks` alone, so a removal there would reach it as an ordinary question with no machine on
  it; in a field of its own it reaches that wall as nothing.
- **Checked again on the machine it would act on.** `answer_from_afar` lets an answer to an
  `ours` question through only for a removal whose parked question still carries evidence that
  passes `remove::travels` — the far wall's drawing is a claim, the parked question is the
  fact. And the delete itself still re-runs every refusal at the moment of deleting
  (`settle_delete`), which is what makes a confirmation from afar about the tree as it is
  rather than as it was described.
- **Refused at once to a quiet wall, never queued.** The question is not offered once its wall
  is unheard, `Elsewhere.answer` refuses a click already on its way when the wall goes quiet,
  and the fleet refuses a prompt into a quiet wall — so a confirmation cannot land hours later
  on a card running `--dangerously-skip-permissions`. Its own window (`answer_window`) bounds
  the rest, as it does locally.
- **The answer is the label.** `composeAnswer` of one question is the option's label, so a
  click sends `delete it` and `remove::approved` reads only that, verbatim; `test/afar.test.ts`
  reads both labels out of `remove.rs` so a renamed button cannot ship as a no.

Demonstrated 2026-10-09 between the same two walls: a card on lab2 called `remove` on a
directory outside any repository and outside temp, so it asked. lab drew *delete on lab2* with
the resolved path, "a directory, 26 B in 4 files" (right to the byte), inside the card's own
tree and not in git, the reason and the permanence line, and the peek ladder carried it as
`blocked`. *delete it* pressed in lab's dock came back `taken`, the directory was gone from
disk one second later with the file beside it untouched, and the card on lab2 reported the
delete and then raised a "finished" notice of its own, which lab drew in turn. Stopping lab2
took its standing notice off lab once the wall went unheard.

### A close confirmed from another wall

A removal was the first of Volery's own questions to cross; a **close** is the second, on the
same arrangement and for a bill that was paid in minutes. On 2026-10-12 a card on QUEERISFREEDOM
(opened from AU-LT-288) made nine `close` calls on cards it had not opened. Each became a Volery
confirmation on QUEERISFREEDOM, none left that wall, Lyss was at the other laptop, and the card
stood blocked ~98 minutes — each park running ten minutes after the last (sink `2770489d`).

`spawn::close_evidence` is written beside the prose question, as `remove::evidence` is: the
machine, the card being closed by title **and** handle, the card asking by title and handle, and the
reason it gave (`null` when it gave none — drawn as *gave no reason*, never skipped). The far wall
composes its question from those fields alone (`afar.ts::closingHere`, header `close on <host>`),
refuses to draw one whose evidence names a different machine, and the digest carries it in a field of
its own (`CardDigest.closings`) for the same reason `removals` is: a wall from before this reads
`asks` alone and must not meet a bare question with no machine on it. `spawn::travels` is the second
lock, on the machine the close happens on, and `ask::afar_may_answer` accepts it under the `close` act
only. The answer is the label (`close it`, read verbatim by `spawn::approved`), and the settle still
re-reads the wall at the moment of closing — a card that has started a turn since is refused.

Not built, by decision: batching several closes into one question (sink `c79df2f8`), and a
"waiting on you" field in `walls`/`recall`. **Needs both walls on the new version to work** — an
older owning wall publishes no `closings`, so nothing is drawn and the old behaviour (the question
stands on its own wall) is unchanged.

### Every confirmation travels unless it says why not (sink `a02ecd0e`)

The two sections above are the history and this is the rule. A card on `AU-LT-288` asked Lyss to
approve opening a pull request while she sat at `QUEERISFREEDOM`, prompting that card over the
flyway and reading its answers: **the conversation reached her and the one thing she had to act
on did not.** Nothing refused it, drew it or logged it — it opened on one machine and waited.
Her words: *"almost everything should travel across the flyway, by design, we shouldn't have to
special case it."*

**The cause was a default, not a missing case.** Volery's own questions were excluded and each
that crossed had been made to — a removal, then a close, each its own piece of work with its own
argument — so every confirmation written after them (the pull request, six Asana writes, the
credential lend) was silently local. That is CLAUDE.md's *a capability every surface should have
is not a prop*, one level up: a list of what travels is a list somebody forgets to append to,
and forgetting is silent.

**So the default is in the type.** `ask::Settle` — the closure that does what an answer means —
is no longer a bare closure. It is made by `Settle::new(confirm, …)`, which takes an
`ask::Confirm`, or by `Settle::stays(stay, …)`, which takes an `ask::Stay`, and there is no third
constructor. Writing a confirmation's evidence is therefore part of writing the confirmation,
and travelling follows from having it: **a confirmation added next month crosses with nothing
added to any list**, which is the test the item set.

- **The evidence is generic, and it is the removal's pattern.** `Confirm` is a verb phrase
  (*open a pull request*), facts as label/value pairs written to mean the same on either machine
  (a repository by org and name, a branch by name, an Asana project by name — never *this
  machine's* anything), the card's reason if it gave one, and a sentence of stakes. At least one
  fact, or there is nothing to decide on. `Settle::stamp` adds the machine
  (`flyway::key::host_name`) and copies the question's own option labels at park, before the
  question is registered — so the parked copy, the `ask:opened` the digest is folded from and
  the copy the gate checks are one value, and the labels are the exact strings each module's
  `approved` reads.
- **The far wall writes the question from the fields, never from the owning wall's prose**
  (`afar.ts::confirmHere`). The prose is written from the owning machine's point of view, and
  read on another it says *here* about a place that is not here. The machine leads in the header
  (`open a pull request on AU-LT-288`) and the first line, the card is named by the shadow's own
  title, and the last line says the one thing every kind shares: nothing happens on this
  machine, and that one checks again when the answer arrives. A block whose machine is not the
  wall it was heard from is not drawn; one missing a field is not drawn (`readConfirm`, strict in
  the direction that refuses).
- **One field, `CardDigest.confirms`, for every kind.** An older far wall reads nothing there —
  the question stays where it was asked, as before — and an older owning wall sends nothing.
  A removal or a close carries the block too but is published in its own field instead
  (`confirmsOf` skips them), because a wall of the build before reads only those and the richer
  drawing wins; `#sheets` keeps one sheet per ask whichever field it came in.
- **The gate names no kind** (`ask::afar_may_answer(ours, question)` is `!ours ||
  confirm_travels(question)`), and `test/afar.test.ts` reads its body out of `ask.rs` to keep it
  that way: a tool name reappearing there is the old list coming back.
- **The answer is re-checked where it acts, and approval travelling is not the decision
  travelling.** The click crosses as the option's label down the prompt wire; `answer_from_afar`
  checks the parked question (not the far wall's drawing) and hands the label into the same
  channel a local click uses, so the settle — and every refusal inside it, `settle_delete`'s and
  `spawn::close`'s re-reads included — runs on the machine that acts, at the moment it acts. A
  pull request or an Asana write re-checks nothing locally by design (the service does —
  `azdo.md`, `asana.md`), and that is the same from afar as from the dock.
- **Credentials never cross.** Approving a credential lend from the other laptop lends it
  *there*, into that card's environment on that machine; the block carries the credential's
  name, whose account it checked as and what it reaches, and nothing else.
- **A quiet wall refuses at once**, by the machinery a parked question already has: a sheet is
  not offered once its wall is unheard, `Elsewhere.answer` refuses a click already on its way,
  and the fleet refuses a prompt into a quiet wall. A pull request approved eight hours later on
  a card running `--dangerously-skip-permissions` is the thing not built.
- **`test/fixtures/confirm.json` is read by both `cargo test` and `bun test`**, and its first
  entry is exactly what `smith.rs` stamps on a pull-request create — so the Rust that writes the
  block and the TypeScript that draws it are held to one file rather than to two descriptions of
  it (the rule *The digest is the owner's front end's* states about the taxonomy).

**The exclusions are `ask::Stay`, one variant each with its argument written beside it, and
today there are none.** The last was `Stay::BoardNotice`, which kept `unpost`'s confirmation (a
dead card's notice coming down) on its own wall *pending the billboard itself crossing walls*.
It has (`board.md`, *Across the flyway*), so the question carries `board::retire_confirm`'s
evidence — with the notice's home wall as a `whose billboard` fact when a card retires another
wall's notice, since `machine` is where the question is parked — and the variant is gone. Its old
argument — *a board notice is one wall's coordination with its own cards, so a notice answered
elsewhere means little* — did not survive scrutiny twice over: a notice need not be about a
working tree at all (*"don't push to this repo"*, *"wrapping things up before a holiday"*), and
remote spawn made an orchestrator on one wall with workers on another an ordinary topology, one
that could neither see nor clear the notices its workers raise. The enum is kept, empty, so the
next exclusion is an argument to write rather than a mechanism to rebuild.

**The general lesson, and it has now bitten twice in a day: an exclusion justified by "these two
things do not interact" expires silently the moment something makes them interact.** The flyway
made walls interact, so every rule written before it that turned on walls *not* interacting is
owed a re-reading — and the reading to give it is the orchestrator across machines, not only Lyss
at a laptop. The audit done for this item, read that way, is in `ask.md` under *What waits on a
person, and whether it reaches her*; it found the away pile quietly local (sink `4a3f859b`).

**Both walls need the build** for a pull request, an Asana write or a credential lend to cross;
removals and closes cross between this build and the one before by their old fields, as they did.

Demonstrated 2026-10-14 between two labs of one build (`cfa`, `cfb`, built from main at
`421c207`): a card on cfb, standing in the tx-toolkit checkout, called `pull_request` create
through its own MCP endpoint. The confirmation parked on cfb and cfa drew *open a draft pull
request on lab-cfb.queerisfreedom*, composed from the block — repository, the branches, title,
description, stakes — with the machine first and nothing of cfb's prose. `open it` pressed in
cfa's dock went down the prompt wire, cfb's settle ran, and draft PR !830 opened in tx-toolkit
under the credential cfb holds, 23 seconds after the call parked. It was abandoned and its branch
deleted straight after; Lyss chose the repository. **Not shown:** an Asana write or a credential
lend answered from afar (the same block and the same gate, so the shared corpus and the unit
tests are their evidence), and an older wall at either end.

### Deferring a question from the other wall

*Defer* (sink `7805fa20`) has no field on the prompt wire and a wall from before it would read a new
field as absent, which is an **answer**. So it travels as text — `afar.ts::DEFER_ANSWER`, a sentence
that is safe to hand an agent as an answer if the owning wall is too old to recognise it (*nothing has
been decided — do not decide it yourself*) — and a wall that does recognise it files the question as a
local defer does (`ask::answer_from_afar` → `presence::defer_one`), after the same gates an answer
passes. `test/afar.test.ts` reads the string out of `ask.rs` so the two cannot drift.

### Roots run between walls

Lyss: *"tentacles should draw always between parent and children, regardless of where they
live, local local, remote local, local remote, remote remote."* The roots (`lineage.ts`,
`Lineage.svelte`, and `spawn.md` for what a root is) were drawn from `Skein.kin`, which is
this wall's `spawned` table. So when the flyway put other machines' cards on the wall, three
of the four cases stopped drawing, and the missing one that matters most is an orchestrator
opening cards on the other laptop, which is what remote spawn is for.

**The drawing barely changed, because the ids were already right.** `familiesOf` keys on ids
that are unique on this wall, and a shadow's is `shadowKey(host, card)`. (That function now
lives in `shadow.ts`, so `lineage.ts` can name one without runes.) So the work was a complete
`Kin[]` (`kinAcross`, read as `Elsewhere.kin`) and one box map holding shadows as well as
cards (`Canvas.rootBoxes`). That map is kept separate from `cardBoxes` because `Flow` and
`Wisps` read `cardBoxes`, and no strand box is one of the things a shadow does not get.

- **Two sources, and neither costs a round trip.** A child *here* is in this wall's own
  `spawned` rows or its `flyway_birth` rows, and a birth already names the asking card:
  `here::Birth::asker_card` has always crossed to the front end, which only ever kept the host
  (`Elsewhere.askedBy` keeps both; `births` is left as the control surface reports it). A
  child *over there* says who its parent is in its own digest. `CardDigest.parent` is
  `{ host, card }`, where `host: null` means *the card's own wall*, so the owner needs no flyway
  name to describe a local spawn. `flyway_births` was the other candidate and is the wrong one.
  It is answered by the child's wall, so it costs a request per wall. It also only knows births
  that crossed, while remote → remote (a card on the other laptop opened by a card beside it)
  is in that wall's `spawned` table, which only its digest can say.
- **One parent per child, first source wins**: this wall's table, then its births, then
  another wall's word. A confused fleet must not draw a card with two roots coming in.
- **An older wall sends no `parent`, which reads as null.** That means no root, and never a
  parent called `""` (`readParent` drops an id that is empty after scrubbing). While this wall
  does not yet know its own flyway name, a shadow naming a *third* wall is skipped rather than
  guessed at. It might be this wall, and a stray drawn to a card standing right here would
  be wrong.

**A missing end has three causes, and each gets a different answer.** This is the
honest-reading question, and it is where the thought went:

- **The parent's wall is quiet.** Its shadows stay up, muted, and so does the root.
  Parentage is structure, not status, and it is as true of a card on a laptop in a bag as of
  one streaming now. The charge *is* status, and it follows the child's face (`Canvas.charged`
  reads `Shadow.tier`), so a quiet wall's child carries no current. A current running into a
  machine nobody can reach is the lie *A quiet wall's cards claim nothing* exists to prevent,
  drawn in the ground.
- **The parent has been closed.** This wall holds that wall's snapshot and the card is not in
  it, so the pair is dropped, exactly as a local pair with a closed parent is. A card whose
  parent has gone is a card, not half a root.
- **The parent is on a wall this one holds no word from at all.** That could be a third
  machine this one does not hear, or a wall whose first snapshot has not arrived. The family is
  real and continues somewhere this wall cannot draw, so the pair carries `unseen` and is drawn
  as a **stray**: a short root coming into the child from the west, where other walls stand,
  with its free end faded into the ground (`strayFor`, `STRAY_FADE`). It has no charge, since
  one end of the work is out of sight. A limb to a guessed position would be a claim nobody
  made about where a card is. Drawing nothing would say a person opened the card.

**A root between two machines is stitched.** Colour is status, so the difference cannot be
colour. The vocabulary already existed: a territory's border is dashed, another wall's region
is dotted, and a prompt that has left this wall is drawn in the other wall's stitch. So a root
whose two ends run on different machines is the same tapered root cut across at even
intervals. A root between two cards of the *same* other wall is solid, because on that wall
it is an ordinary root. Three details hold the stitching together:

- **Spaced along the curve's length, not its parameter** (`stitches`), or the stitches bunch
  where the cubic is slow.
- **The first stitch starts at 0 and the last ends at 1**, always, because those are the two
  stretches carried under a card (`seat`/`tuck`). A root that began or ended in a gap would
  show its cut end on the ground, which is the defect *under the card* in `lineage.ts` removes.
- **Each stitch is a subpath of the same body**, so a stitched limb sharing a trunk with a
  solid one still unions into it. There is no sheen on a stitched root, since a stroke would
  bridge the very gaps that say it crosses.

**No growth for a shadow's root.** A shadow appearing does not mean a card was just opened;
it may be a wall that has just been heard. A root that grew would claim a birth nobody saw.
The one live case that is known is a birth *here* heard on `flyway:born`, which stamps `at`,
and that root grows.

Demonstrated 2026-10-08 between two walls of one build (`lab61`, `lab62`). The spawns were
real `spawn` tools/calls made to each card's own MCP endpoint, because the lab account had
run out. A card on lab61 opened one on lab62, a card on lab62 opened one beside it, and one
opened on lab61. On lab62 that drew a solid root to its local child, a stitched root to the
shadow of its child on lab61, and a stitched root from lab61's shadow into the local "child of
lab61". On lab61 it drew the mirror, plus a solid root between two lab62 shadows. Two
stitched roots along one row of cards overlap into something like a ladder. That is the row,
not the drawing, and it is the same thing a local root does passing under a neighbour.

### A card moving to another wall

The other direction of the flyway: not opening work over there, but a card that is already
running here — with hours of conversation behind it — picking up on another machine. The card
menu's `move it to another machine ▸`, offered only for a wall heard from lately, taking work,
and holding this card's territory. `flyway/moving.rs` is the design and the pure half;
`flyway/link/moves.rs` is the wiring, a child of `link.rs` so it can use the wire and the
fleet without either growing a public face for one subsystem.

**It rests on `tools/probe-migrate.ts`**: a session transplants verbatim. The transcript put
where the other machine's CLI looks — that machine's home, the slug of the directory the child
will run in, the session id as the name — resumes with no record rewritten. Accounts do not
change where that is (`CLAUDE_SECURESTORAGE_CONFIG_DIR` picks the credential store and only
that), so the arriving wall plants once, whatever account its ladder then picks.

The shape: **quiesce on A → ship the transcript and the rows → resume on B → confirm the model
has its history → release A.** And one sentence the whole of it answers to: **a card that
exists nowhere is the one outcome that must be impossible.**

- **Confirmed means the card finished its own sentence, from memory.** Reading the planted file
  back proves the bytes arrived and nothing about the model — a CLI that resumed a session and
  answered from nothing would pass a byte check perfectly. So the card's first turn on B is a
  cloze test: `challenge_of` takes a line of the card's own prose from the end of the
  transcript as shipped (never a table, a fence or a subagent's), the prompt shows its first
  four words, and the card is asked for the rest with no tool calls. `held` wants one unbroken
  run of at least six-tenths of the hidden half, never under 28 characters, so a dropped comma
  passes and a guess on the same subject does not. The answer is read off **the transcript the
  CLI wrote on B** (`answer_after`), after the turn closes (`persist_turn`'s hook), never off
  the front end. It costs one real turn — the whole context, read once — and that read is the
  one the card's next prompt there would pay anyway, since the first turn after a transplant
  writes the prompt cache from cold. The same prompt says what moved and what did not: other
  paths, nothing it started came with it, where the code is.
- **A's copy is closed and marked, never deleted.** `flyway_move` (schema v49) holds the move
  on both walls, `direction` out and in. Released, A's row is `closed_at` with an outcome of
  `released`, its transcript stays on disk, and three things keep it from being reached: a
  closed row is not loaded; `sessions.rs` does not offer a moved-away session for adoption
  (`here::moved_away_sessions`), since a second card on it would fork the conversation the
  moment either was spoken to; and `reach::place` finds the handle in B's snapshot, so
  `send`/`recall`/`close` follow the card. It does not read as a card that finished: the
  chronicle says *moved a card to B*, and the card's shadow is drawn in B's region.
- **The id and the session are kept.** A card is matched by its id wherever a wall asks who it
  is (`may_reach`, `is_child_of`) — which was written that way for this — so an orchestrator
  goes on reaching it by the same handle. The lineage is re-pointed on both walls: a parent on
  A gets `flyway_child` for it on B, its children on A get `flyway_birth` naming it on B, and
  B writes the mirror. Every arrival writes a birth row, so it counts against B's bounds on
  arriving work (`MAX_LIVE`'s cousins, `Facts::bound`), and a card born for a third wall keeps
  that origin.
- **The territory has to exist on B**, by name, and nothing about a move widens that.
  `here::root_for` is the only place a path comes from; a wall without the repository is
  refused before anything leaves, with what it does have. The checkout is the other machine's
  own and the code moves by git: A refuses a tree with uncommitted work, untracked included,
  and a commit no remote branch contains (`tree_refusal`), and B tells the card whether its
  checkout already has that commit. A card on a branch of its own gets that branch on B —
  `origin/<name>` if pushed, else the very commit — before `worktree::ensure` runs, since
  `ensure` alone would branch afresh off the base and put the card on the wrong code.
- **Refused rather than lost.** Mid-turn, a background job, an unread relay, a pending wake or
  a timeline in flight are all things a stopped process would drop, so each is a refusal with
  its own remedy, before anything is written (`in_flight_here`). A chat card has no repository.
  A wall that is quiet, too old (`Facts::can` lacks `move`) or not taking work is refused at
  once — never queued for a lid to lift.
- **Born through the one birth path.** Rust writes the row first (`store::arrive_row` — an
  upsert, because a card coming *back* has a closed row here that `record_row`'s `OR IGNORE`
  would leave closed), plants the file, records the lineage, then emits `flyway:move-in`;
  `Skein.openMoved` opens it through `#openIn` with the session it brought (`#openIn` took a
  `session` for this, since a card cleared before it moved has one that is not its id) and
  hands it the check as its first prompt, under the wall's own envelope.

**What a crash leaves is the card on A, and that is not "it depends".** Each wall's decision is
one persisted word, written once (`here::settle_move` updates only an open row):

- A is **frozen** from the moment the row is written — `supervisor::spawn_now` asks
  `link::move_blocks` on every wake — and unfrozen by `kept` or closed by `released`. It gives
  up after twelve minutes (`SETTLE_WITHIN_MS`) and keeps its card; a crash before then comes
  back to a frozen card that the next tick past the deadline releases back to work.
- B holds an arriving card only while **this process** sent its check (an in-memory map, on
  purpose): after a restart the card is refused a spawn — no rouse prompt lands where the
  check should have been — and the sweep fails it and takes it off. B fails a check not given
  in eight minutes, which is inside A's twelve, so B normally decides first.
- B says how it ended until A answers (`told_at`), for up to a day. A answers from its own word
  (`moving::settle_out`): in flight and confirmed is `released`; anything else — failed, or a
  confirmation arriving after A gave up — is `kept`, and **`kept` is B's only licence to take
  its copy away**. So the two walls never both let the card go; the test walks every state.
- The one corner left is the safe one: B confirmed, A did not hear in time and kept its copy,
  and somebody had already spoken to the copy on B. B then keeps it too (`untouched_since`),
  and both walls put a chronicle row up saying the card is on both — two copies a person can
  tell apart, rather than one quietly discarded with somebody's words in it.

**The wire** is `tail.rs`'s shape pushed the other way: `move_offer` (the rows and the size,
so a refusal costs nothing shipped), then the transcript as `move_part`s of at most three
megabytes — inside the wire's 8 MB frame however quote-dense the JSON-in-JSON is — each its own
exchange answered on the same stream, never gossiped and never relayed. `move_settled` is
pushed by B and answered `move_released` on the same stream. Every string off the wire is
scrubbed, the session and card ids are held to letters, digits and dashes (the session becomes
a file name under the CLI's projects directory), a branch is refused if it could be read as a
git option, the commit must be hex, and the model and effort travel as the row's own words held
to a shape — the row stores what a preset resolved to (`opus[1m]`), not `spawn`'s family names.

### A card opened in a section, from here (sink `0da533f2`)

Lyss: *"if I right click a remote project I want to be able to spawn remote cards based on my
local presets and default preset"*, and *"shadow projects should behave as local projects by
design"*. So a section answers a right-click — on its name or its box, both carry
`data-section` — the way a territory's `+` does here: **this wall's** presets (`menu.ts`'s
`section` kind shares `presetRows` with the `spawn` kind, so a preset added or renamed reaches
both), this wall's default dotted, and a pick opens a card in that project on that wall.
`<space> e n` opens the same menu at the focused shadow's section. The menu's hint line says so,
and says which wall.

- **A person's ask, not an agent's, and the difference is the brief.** `spawn` with a `host`
  refuses an empty prompt — a card an *agent* opens with nothing to do is a process and a turn
  spent on nothing. A `+` opens a card that spends nothing until somebody types, so the person's
  ask carries **no brief** and the far wall opens an empty card exactly as its own `+` would; the
  first message is typed into this wall's dock once the shadow arrives. `flyway/opening.rs` is the
  whole of it: `person_request` builds the `fleet::Request` (`card: None`, empty brief, no title,
  no needs), and `brief_refusal` is the far wall's rule — empty is refused **only when a card
  asked**, so an agent's empty ask from a build that forgot the guard is still refused where the
  card would have opened. `openSpawned` sends nothing when the brief is empty.
- **The preset crosses as `spawn`'s vocabulary** (`presets.ts::spawnPairOf`): the family and a
  level, which the far wall resolves through its own `presetForSpawn`, keeping the family's window.
  Every row round-trips to its own model and effort (`test/presets.test.ts`); *as claude code is
  set up* is two nulls, the machine's own setting there. No `account` — that is the far wall's
  ladder.
- **Gated as an ask always was, and told up front.** `flyway_open` refuses at once a wall never
  heard, quiet (`Fleet::ask`), too old (`opening::WORD`, `open_empty` in `Facts::can`, read as the
  roster row's `opens`), not taking work, or without a project by that name — and the far wall
  still weighs its switch, its bounds and the territory again when it decides. Never queued. The
  menu offers the presets only where all of that holds here (`shadow.ts::openRefusal`), and
  otherwise says why in its place.
- **The answer reaches the front end, not a tool call.** A person's ask is a `Wants::Open` waiter
  in `link.rs`: `answered` emits `flyway:opened-there` (`opened` with the card's id there, or
  `refused` in a person's words), and `nobody_answered` emits a refusal once and keeps the waiter
  so a late `opened` still lands. `Elsewhere.openThere` resolves on it; a refusal is a fault.
- **The new card takes the focus when its shadow arrives** — the wall's next snapshot — so the
  dock is aimed at it. Bounded (`landingNow`): only within `LAND_WITHIN_MS` (30 s) of asking, and
  only if the focus is still where it was when you asked. A card that turns up later is drawn in
  its section and left alone; something arriving a minute on and taking the focus would be the
  wall moving under your hands.

Demonstrated 2026-10-13 between two frozen labs (`opa`, `opb --peer opa`), driven by the control
surface's `menu` and `click`: a card opened on opb in `labproj` drew a `labproj` section on opa,
whose right-click offered opa's five presets and the plain row; *a quick question* opened a second
card on opb — on haiku, `bornFor` opa, at rest with no turn spent — and opa's focus was on its
shadow by the next snapshot. With opb's switch written off by hand (sink `4b634e26`), the same
right-click offered no rows, only the reason. **Not shown:** `<space> e n` (the table is tested),
the move-all (a lab card has no pushed commit to move by, so it rests on the per-card move's own
demonstration and `moveall.test.ts`), and a far wall too old to announce `open_empty`.

### A grouping's cards moved together

The territory menu's `move its cards to another machine ▸ <host>` (Lyss: *"moving all the cards
of a project to another machine is a nice idea as well"*). Offered where the card menu's `move`
would be — heard, taking work, holding a territory of this project's name (`App.wallsHolding`, one
filter for both) — and only with cards to move. It asks first (`Exodus.svelte`, the close plate's
shape, with the count and `moveall.ts::departure`'s sentences), then runs **`Skein.moveCardThrough`
one card at a time**, each to its end — quiesced, shipped, confirmed with a turn there, released
here — before the next starts. Not fanned out: each move holds a card still and costs a turn, and
the waits are the far wall's own bounds. A card the move refuses (mid-turn, dirty tree, a job, a
pending wake…) or keeps stays exactly where it was, is not retried, and is named at the end with
the first clause of its reason (`movedSummary`). `moveCardThrough` waits on `flyway:move`'s
`moved`/`kept`, bounded past the far wall's twelve-minute deadline so one unheard ending cannot
hold the rest.

### What is not here

- **A root to a child on a wall this one cannot see.** The parent's wall records the birth
  (`flyway_child`), but nothing hands it to the front end, and a wall that asked for a card
  almost always hears the wall it asked. A stray is drawn on the child's side only.
- **The whole scrollback.** 120 lines from the end, which is the round you are in and the one
  before; older rounds stay on the owning wall, and the panel says so.
- **Persistence.** What was said to a shadow from here is in memory only, like a `!` line: it
  is in nobody's session file, and a prompt is only worth tracking while somebody waits on it.

### One card handle (sinks `865e555f`, `735f3234`)

Lyss, 2026-10-12: *"shadow vs local stop drifting and naturally offers the same features without
crazy amount of code duplication and special casing … only pieces of code that need to know that
some code is remote should deal with it."* Agreed as **option B** below, and built in four steps:
the verb table and the menu (1), the `act` frame with every verb the menu offers a shadow (2, 3),
and the dock, the keyboard and the panel onto the handle (4) — see the two *What was built*
sections at the end.

**The drift has one cause.** A shadow is its own type for the right reason (above: a `Conversation`
reaches rousing, reaping and `#persistConv`), but every *gesture* then took a `Conversation`, so
each grew a `focusedShadow` branch (18 in `App.svelte`, 11 in `Dock.svelte`) and a menu of its own
with two rows. The guard belongs on `Skein.convs`. It never needed to reach the menu.

**B: a handle above both, for gestures only.**

```ts
interface CardHandle {
  readonly id: string;
  readonly face: CardFace;           // what Card.svelte already takes
  readonly readable: Readable;       // what Transcript.svelte already takes
  can(verb: Verb): Can;              // "yes" | { no: reason } — drives menu, keys, dock
  do(verb: Verb, args?): Promise<Outcome>;   // outcome has the shadow's four readings
}
```

`LocalCard` wraps a `Conversation` and calls `Skein`; `RemoteCard` wraps a `Shadow` and sends one
`act` frame. `Skein.convs`, rousing, the reap pass and persistence never see a handle. The menu,
the dock's send, the keyboard chords and the panel are built from `handle.can`, so a verb added
once appears on both kinds, and a verb a kind cannot do says why instead of vanishing.

**What it must not do: touch the hot paths.** Rendering stays on `CardFace` and `Conversation`'s
own event fold; a handle is made once per card, `LocalCard`'s verbs are one-line delegates, and no
local path gains an `isRemote` test. Lyss's worry was *"would it make local cards slower or
worse"*; the constraint is that nothing a local card does per event or per frame goes through it.

**The verbs, by what the owner must do.** Most of today's menu is already a string id dispatched in
`App.svelte` (`wake`, `aside`, `bypass`, `account:<id>`, `clear`, `copy-resume`, `copy-cwd`,
`processes`, `regroup:`, `hand:`, `move:`, `close`). These become verbs:

| verb | remote means | cost class |
|---|---|---|
| send, answer, close | exist today (`prompt`, `close_by_person`) | starts work / person's |
| model, effort | **already work**: `/model` and `/effort` are the CLI's, and a prompt starting with one goes through the same `send` and is carried out as if typed there | starts work |
| wake | the owner's `Skein.wake`; today implicit in `send` | starts work |
| clear | owner's `Skein.clear` | starts work, destructive-ish |
| aside, bypass, account, regroup | owner's setter | cosmetic / money (account, bypass spend) |
| copy-resume, copy-cwd | the owner **answers with text** (session id, its cwd) and this wall copies it; labelled *on <host>* since the path is that machine's | read |
| processes | owner's list, drawn here later | read |
| hand, move | out of scope for now (`move` is already its own exchange) | — |
| show in explorer, open in editor | `can` says *no: that is on <host>* | local by nature |

**Transport: one generic `act`, not a frame per verb.** `act { card, verb, args }` answered on the
same stream (`tail.rs`'s shape), the owner's front end running it against its own `Skein` as
`Elsewhere.#take` already does for a prompt. A wall announces the verbs it understands in
`Facts::can` (`act:aside`, `act:account` …), so an older owner is told *needs updating*, exactly as
`close_by_person` is. Adding the next verb is one entry on each side and no new frame.

**Gating is the safety design, and it is per cost class, not per verb:**

- *starts work or spends money* (send, wake, clear, account, bypass, model): held to the "take work
  from other walls" switch like a prompt, refused to a quiet wall **at once and never queued** — a
  card runs `--dangerously-skip-permissions`, and a lid lifting hours later must not deliver
  something you have changed your mind about.
- *a person's* (close, stop): passes whatever the switch says, as today.
- *cosmetic and reads* (aside, regroup, copy-*): not gated by the switch, still refused when quiet.
- **Agents never reach `act`.** It is a person's gesture from the dock/menu, as `deliver_here`
  already refuses a notice answer from an agent. `walls`/`send` stay the agents' road.
- The owner **re-checks** at the moment of acting (as `settle_delete` does): a card that has started
  a turn since is refused for `clear`.

**Outcome states** are the four a prompt already has (`queued`, `left`, `taken`, `refused`),
generalised: `Shadow.closing` becomes one `pending` map keyed by verb.

**Build order.** (1) `CardHandle` + `LocalCard` beside the existing code, menu only, behind no
flag — the menu is read-only plumbing and the local verbs must behave identically (existing
`menu`/`actions` tests are the guard). (2) `RemoteCard` + `act` for the read and cosmetic verbs
(`copy-*`, `aside`). (3) The gated verbs. (4) Dock and keyboard onto the handle, deleting the
`focusedShadow` branches. Rust (`act` frame, `Facts::can`, owner-side dispatch) goes to a card on a
machine that can compile it; the front end can be done anywhere.

**Decided (Lyss, 2026-10-13):** `account`, `bypass` and `clear` are settable remotely — *"I am the
owner everywhere"*, and `clear` keeps the card and its session on disk to be adopted back, so it
is not the destruction an earlier draft of this note called it. They stay `work` cost: gated like a
prompt, so refused to a quiet wall (**quiet** is the fleet's word: not heard from for
`QUIET_AFTER_MS`, 90 s — a lid shut, asleep or offline; nothing to do with the card being idle).

### What was built: the menu and the `act` frame

`handle.ts` is the verb/cost table and `verbsFor`; `menu.ts`'s card rows are one function
(`cardRows`) behind `has(verb)`, and a shadow's menu is that function given the verbs its wall
can be asked, filled from its digest the way a local card's is filled from its `Conversation`.
`flyway/act.rs` carries them. A right-click on a shadow now offers wake, set aside / pick back up,
ignore / respect the caps, put it on…, clear, copy resume command **on <host>** and copy working
directory **on <host>**, wherever its wall announced the verb.

- **One frame, one exchange.** `act { id, card, verb, args }` → `acted { id, outcome, why, text }`,
  answered on the stream it came in on (`Link::answer_all` → `act_here`; the asker's `read_act`),
  nothing kept, nothing retried. `outcome` is a string, not an enum, for `Tailed`'s reason —
  anything but `taken` reads as refused. `text` is how `copy-resume` (`claude --resume
  <sessionId>`) and `copy-cwd` come back; the asker copies it.
- **Announced, so an older wall is offered nothing.** `Facts::can` carries `act:<verb>` per verb
  this build does (`act::words`); the roster row turns them into `acts` (only verbs *this* build
  also knows — `act::offered`) and `closes` (`close_by_person`); `Shadow.remote` reads both. Not
  in `fleet::CAN`, for `tail::WORD`'s reason: those are what an *agent* may ask.
- **Gated by cost, on the owner, on its switch read fresh** (`act::gate`). `work` — wake, clear,
  account, bypass — needs "take work from other walls", exactly as a prompt does; `cosmetic`
  (aside) and `read` (the copies) do not. The asker refuses at once a wall that is unknown, quiet
  (`QUIET_AFTER_MS`), too old for the verb (`act_reachable` → `reachable`), or — for a work verb —
  last announced as not taking work; nothing is queued, since a gesture is one exchange and an
  exchange that does not land is the gesture refused.
- **A person's, never an agent's.** No MCP tool sends an `act`; `flyway_act` is a Tauri command
  the menu calls. The frame carries `from_card` anyway, never set by this build, and the owner
  refuses one that names a card — `deliver_here`'s second lock on a notice answer.
- **Strict shapes.** Id and card held to a uuid's alphabet (`act::is_id`); the verb to `VERBS`;
  args read into a fresh object per verb (`read_args`) so nothing else a peer sends reaches the
  front end. **A setting crosses as the state wanted, never a toggle** (`aside {on}`,
  `bypass {on}`) — a gesture made against a face a snapshot old must not flip it the wrong way.
  Every string either way is scrubbed and capped (`fit_text`).
- **The owner's front end does it**, parked under a fresh id (`flyway:act`, answered by
  `flyway_act_answer`, twelve seconds, `ACT_WITHIN`), with the same `Skein` calls its own menu
  makes (`Elsewhere.#perform`). It **re-checks the card as it is** (`handle.ts::actRefusal`):
  `clear` carries `sawWorking` — what the asker's face said when the person chose it — and is
  refused if the card has *started* a turn since, while a turn already going wrong may still be
  abandoned, as locally; `account` must name one of this wall's usable accounts. `putOnAccount`
  and `clear` report failure as a fault rather than a throw, so whether they went is read off the
  card (its account, its session id). A work verb leaves a note in the transcript naming the wall
  that asked.
- **The owner's accounts ride the snapshot** (`Snapshot.accounts`, labels only, read by
  `readAccounts`), since `put it on…` is a choice among *that* wall's subscriptions. An older wall
  sends none, which offers no choice.
- **The asker's reading.** `Elsewhere.act` returns `taken` (with `text`) or `refused`, and keeps
  `Shadow.acting` — `asked` → `taken` | `refused` — beside `closing` rather than generalising it,
  since a close is answered on the prompt wire and an act is not. One at a time per shadow. A
  refusal is said as a fault. What a setting did is drawn by the wall's next snapshot, never here.

`test/handle.test.ts` reads `act.rs`'s `VERBS` and holds it equal to `handle.ts`'s `ACTS`, cost
and all.

Demonstrated 2026-10-13 between two labs of one frozen build (`acta`, `actb`), driven by the
control surface's `menu` and `click`: a card opened on actb drew on acta with `copy-resume`,
`copy-cwd` and `aside` on its menu; *set it aside* there set it aside on actb. After a restart
left it dormant, *wake it* with actb's switch off (its default) was refused at once and the card
stayed dormant; with the switch written on by hand (no control op — sink `4b634e26`) the next
*wake it* woke it, and *pick it back up* cleared the aside. **Not shown:** the copied text reaching
the clipboard — the write needs a focused window, and a *local* card's copy on the same unfocused
lab failed identically ("could not reach the clipboard"); `clear` and `account` (the lab card had
no turn and the lab no accounts), so those rest on the unit tests. **Both walls need the build**: an older owner announces no `act:` words, so its shadows'
menus are the glass and the close, as before.

### What was built: the dock, the keyboard and the panel (step 4)

**`cards.svelte.ts` is the handle**, and the rest of the front end holds one. `CardHandle` is the
brief's interface grown by what the surfaces turned out to ask: `can`/`do`, `face`/`readable`,
`remote`, the project line a panel heads it with (`where`), whether its questions run scripts or
take a touch (`scripts`), what the dock says beside it (`hints`), its right-click fields
(`menu()`), `carries(turn)`/`say` for a prompt, `stir`, `history`, `look`, and its questions and
notices with the gestures that answer them. `LocalCard` is one-line delegates to `Skein`;
`RemoteCard` sends one `act` (or the prompt wire, or `close_by_person`). `Cards` makes one handle
per card and keeps it (a `WeakMap` over the `Conversation`/`Shadow`), so a `$derived` holding a
handle hands back the same object and `queue.ts::steady` sees an item unchanged. The window's own
state — the close plate, the glass, the clipboard, this wall's furniture for a menu — is lent in as
`Hands`, so a handle carries nothing that is a card's beyond what it wraps.

**Measured as branches removed**, which was the brief's test: lines in `App.svelte` and
`Dock.svelte` that name the remote kind (`focusedShadow`, `remote`, `onremote*`, `far-ask`,
`far-notice`, `focusShadow`, `closeElsewhere`, `sendElsewhere`, `askShadow`, `unfinishedAway`,
the `shadow` menu kind…) went from **86 to 10**, and `focusedShadow` from 11 to none. What is left
asks *where* on purpose: the `[data-shadow]` selector a right-click reads, a section (`<space> e
n`, which is about elsewhere), the plate and the placeholder naming the wall, one command refusal
naming it, and whether a far queue has been read. `Yonder.svelte` is gone.

- **The menu is one branch.** `[data-conv]` and `[data-shadow]` both reach `cards.find`, the
  target is `handle.menu()` and every row is dispatched as `rowVerb(id)` → `handle.do`. `menu.ts`
  lost its `shadow` kind: a card elsewhere is `kind: "card"` with `host` and `verbs`.
  `test/handle.test.ts` holds that every row `cardRows` can draw is a verb the handle dispatches.
- **The dock has one card** (`card`, plus `cards` for the queue) where it had `focused`,
  `remote`, `shadows` and six `onremote*` callbacks. The queue is **two kinds, not four** — an
  `ask` and a `notice`, each carrying its card's handle (`of`), with `far` the item's flag for
  `queueOrder` — so the far snippets went and `test/queue.test.ts` holds one branch per kind and no
  `far-` kind. A far confirmation (`b717f78`) is one more sheet on the shadow and needed nothing
  here. The line above the field is `handle.hints` (`dockHints`, pure and tested), the stop button
  is `do("stop")` for either kind, and the `!` bar says *where* when the card is not here.
- **One send.** `send` → `runCommand`/`sendText`, with `reach` (the gathering, else the card in
  the ring wherever it is) in place of `targets` where a lone card elsewhere counts. A turn is
  asked `carries` *before* the draft is cleared. `/clear` and `/account` are verbs and reach a far
  card through its handle; Volery's other commands refuse one with the reason, draft kept.
- **Stopping a turn crosses** — the brief's one missing verb that the dock offers. `stop` is a
  `person` cost (it only ends work, as a close does, so it passes the far wall's switch) and the
  first person's verb to ride `act` (`act.rs`, `Cost::Person`); the owner stops it with the card's
  own `Skein.stop` and notes who asked, and a card that finished first is `taken`. Escape stops a
  far card's turn only where its wall can be asked, and otherwise falls through to letting go —
  Escape must not become a key that says no for ever; the dock's button is where the reason is
  said.
- **The keyboard reaches everything the menu does.** `<space> c` and a letter is
  `verbFocused(verb)` → `card.do`, for either kind; `c p` is processes, and `c m` opens the card's
  own right-click at the card with the first row under the keyboard — `ContextMenu` now walks
  with j/k or the arrows, → and ← into and out of a family — which is how the verbs that are a
  pick from a list (account, grouping, maker, machine) are reached without the mouse.
- **The panel is `Transcript` for both.** What only a card elsewhere had in `Yonder` is three
  optional `Readable` fields the shadow answers: `elsewhere` (drawn in the footer, *on lab*,
  beside the model the item said was missing — the model itself was put on the digest by
  `206c5a5`), `notes` (`handle.ts::panelNotes`, Yonder's conditions as a pure tested function) and
  `historyMark` (when to pull the tail again). Ctrl+F finds in a far card's conversation now,
  which it never did. The header Yonder drew — title, status — is the card face's, and a card
  here's panel never had one.
- **One close plate.** `do("close")` asks first on either kind (a timeline in flight or work in
  hand here; the digest's working or jobs there) through `Hands.confirmClose`, and the plate's yes
  is `do("close", { sure: true })`. It now holds the whole keyboard whichever kind it is about,
  where only the far plate did before.
- **Small differences that went with it**, each the local behaviour winning: the peek and "more
  waiting on you" land on a far card with `focusCard` (they used to force its panel open; `<space>
  e e` still does), and landing on a card from the peek reveals it, as every other landing does.
- **And one that came back.** The hold rule (`f96136e`) dropped the dock's `scopeFiles` call, so
  a path in a question opened against nothing; the dock scopes it to the asking card's directory
  again (none for a card elsewhere, whose pictures arrive resolved).

**Still `local`:** `processes`, `regroup`, `hand` and `pin` until a remote card has a row here,
and Volery's own `/rename`, `/btw`, `/gear`/`/plan` on a far card, which say so.

Demonstrated 2026-10-14 between two frozen labs of one build (`acta`, `actb --peer acta`, the
binary HEAD plus this `act.rs`), driven by the control surface. A card opened on actb drew on
acta, and its right-click there offered `copy-resume, copy-cwd, aside, glass, close` where the
same card's on actb offered those plus `regroup` and `processes` — one row function, two verb
sets. With the shadow focused, acta's panel was `Transcript` (the notes above the column, `on
lab-actb…` in the footer beside `opus[1m] · xhigh`), the dock read *on lab-actb — words only,
sent there*, and Ctrl+F opened the find field in the far conversation. Put on haiku, the card
on actb was given a forty-five-second `ping`; acta drew it working, and acta's dock **stop**
ended it within a second — the owner's column reads *stopped from lab-acta*, the call is cut
off, and the shadow says *stopped · 7s*. `<space> c m` opened the card's menu with
`copy-resume` under the keyboard; j, j, k, ↑, ↑ walked `copy-cwd`, `aside`, `copy-cwd`,
`copy-resume` and wrapped to `close` (read off the snapshot's `dom.focusedMenu`, since `:focus`
matches nothing in a window that is not in front); taking `aside` from it set the card aside on
actb. In the dock, `/rename alpha` was refused with the draft kept (*reaches this wall's cards —
not yet one on lab-actb*), and `/clear` went to actb as the verb and came back refused by its
switch (*not taking work from other walls*). **Not shown:** a wall too old to announce
`act:stop` (the unit tests hold the refusal), Enter on a menu row (a synthetic key does not
press a button; the click it stands for was), and a far question or notice in the dock, whose
drawing is the queue test's and was not changed beyond the handle it carries.

## Leaving the flyway

Reported 2026-10-19: *"leaving the flyway didn't actually leave until volery was closed and
reopened, and other machines just thought it went quiet instead of it being gone."* Two bugs
with one root: leaving was a **setting**, not an event.

### Why it did not leave

`key::leave` cleared the vault entry and nothing else. `link::arrive` had started three things
that each held the endpoint and the key in memory — the accept loop, the tick `loop {}` and
the pushes — and none of them was ever asked whether to go on. So the wall kept dialling,
answering, announcing and publishing its cards as a member until the process closed. The
front end made it worse: the panel's roster and `Elsewhere.walls` were only ever *added to*,
so even a wall that did stop left its rows and shadows drawn.

`link/leaving.rs` is the repair, and its centre is `Tenure` — closed once, read by every task a
link starts. **A task that lives as long as a link owes the link a way to end it.** The tick is
`tick_until_closed`, a pure-ish loop so "a left wall stops dialling" is held by a test rather
than trusted; the accept loop checks it; `push`, `dial` and `tick` refuse once it is closed;
and `Wire::close` ends the endpoint, which ends `next_dial` and every connection. The tick used
to call `pull(app)`, which looks up *whichever link is current* — so a wall that left and came
back would have had two loops ticking. It ticks its own link now.

The order in `leaving::leave`, each step is why the next is safe: read whom to tell (the
invite's seed is in the vault) → **clear the key** (the one step that can refuse — a lab on
the installed wall's key may not — so a refused leave has changed nothing) → take the link out
and close its tenure → say goodbye → close the endpoint → tell the front end. What the wall was
itself waiting on (`waiting`, `prompts_out`) is settled with `nobody_answered`, so a parked tool
call is answered rather than dropped.

### The goodbye, and why silence is still quiet

`FleetMsg::Leaving { host }`, `msg: "leaving"`, said once to every wall the leaver flies with
(`farewell_to`: the roster's walls that are not quiet, plus anyone who dialled in or seeded the
invite and is not on it; never itself, never a wall on the v1 language, never a wall already
quiet — saying it to an empty room costs a whole timeout). A wall that receives it
(`Link::departed`) takes the wall off **at once**: `Fleet::depart` (forget, held against stale
gossip), `Cards::depart`, the board's copy, `heard`/`failing`/`older`, then `flyway:left
{host}` and a roster redraw; the front end's `withoutWall` removes the row, the snapshot and
the heard-time and `#reconcile` takes the shadows down.

- **A wall that went quiet without a word still reads quiet**, with its cards, exactly as
  before: a shut lid is not a departure, and that is `Fleet`'s test
  `a_goodbye_takes_a_wall_off_where_silence_only_makes_it_quiet`.
- **Who said it is the handshake's to prove, not the frame's.** The word names a host, and
  `departed` acts only if that name derives the identity the connection proved
  (`Wire::peer`). `Fleet::on` does nothing with a `Leaving` for exactly that reason — it
  cannot check a name against a connection.
- **Not gated on a `Facts::can` word, deliberately.** A capability word lets the *sender*
  refuse something the receiver would mishandle. A goodbye has nothing to refuse: an older wall
  skips the unknown `msg` (`frame::take`) and reads the leaver as quiet, as before.
- **Said once, never queued, never relayed.** A peer that was asleep when it was said reads
  quiet (the leaver can no more tell it than the peers could have). A goodbye delivered a week
  late would take a wall that had since rejoined off the roster.
- **A straggler is not a return.** `Cards::depart` remembers the version the wall had, so a
  snapshot already on the way when the goodbye landed does not put the cards back; only
  something newer does, and a wall that rejoins publishes one. `Cards::forget` (a person
  removing a quiet wall) deliberately does *not* remember: a quiet wall that wakes up re-says
  the same snapshot, and that must be drawn.
- **Rejoining is nothing special.** The leaver's announcement version only rises, so the first
  one after it passes the version `Fleet::forget` holds. `Link.left` keeps a goodbye-sayer out
  of the *heard*/seed dialling until it is heard from again, but never out of the roster's — a
  wall that announces is back on it, and that is what makes it dialled.
- **Not closed by leaving:** cards other walls opened here. Leaving ends the link; a card is a
  conversation somebody may still want. `key.rs` has always said the caller deals with them.

`flyway_forget` shares `Link::drop_wall` now, which fixed a neighbour: forgetting a quiet wall
used to leave its cards in the link and its shadows on the wall.

Demonstrated 2026-10-19 between two frozen labs (`a`, `b --peer a`), driven through the Flyway
panel (`<space> k`, "leave the flyway") and read off the snapshot's new `elsewhere.roster`:
with a card open on `a` and drawn as a shadow on `b`, **leave on `a`** left `a` with no roster
and no heard-times, and `b` — within three seconds, no restart — with its own row only: no `a`
row, no `heardAt`, no shadow, and still none 45 seconds (a tick and a half) later. `a`'s log said
*left — said goodbye to 1 of 1 wall(s)*. **Rejoining** (`a` joins with the invite naming `b`)
had both rosters carrying both walls within one tick. **A crash** (`taskkill /F` on `a`, no
goodbye) left `a` on `b`'s roster, its quiet time climbing past the 90 s line to 170 s, and its
shadow still drawn — a shut lid is still not a departure. One trap in the harness, not the
product: `.flyway .act.go` matches *start a flyway* before *join*, so a join clicked by that
selector starts a flyway of its own and reads exactly like a rejoin that never converged.


### Accounts are one set of settings, whichever wall you are at

An account is the same subscription on every machine, so its on/off, caps, priority and rank
travel (2026-10-19) — and unlike everything above, which one wall owns and the others draw,
**every wall writes them**. So they converge rather than being pictured: a register per field,
last write wins on a hybrid logical clock, a value nobody has changed under that build never
sent, matched across walls by who the account signs in as rather than by its label. The frame
(`accounts`) rides every exchange and a push a second after a change, only to a wall announcing
`accounts` in `Facts::can`, and carries the readings each wall took itself, by age, so a wall
that has not polled an account still knows it is at 90%. `accounts.md`, *One account, every
wall*, is the design; `flyway/accounts.rs`, `accountsync.rs` and `link/accounting.rs` are the
code.

**What a token never does is cross.** The one credential-derived thing in the frame is a salted,
truncated digest of each store's refresh-token chain, which finds a sign-in copied between
machines — the same chain on two walls, where the first refresh on either signs the other out —
and retires the copy (`accounts.md`, *A sign-in never leaves its machine*). `flyway/mod.rs`'s
rule, *the wire carries work, never secrets*, is kept to the letter: a digest is not a secret,
and nothing could spend one.

**Older walls are left alone.** A wall that does not announce the word is sent nothing and read
for nothing, and keeps its own settings.
