---
paths:
  - "src/lib/shadow.ts"
  - "src/lib/shadows.svelte.ts"
  - "src/lib/Yonder.svelte"
  - "test/shadow.test.ts"
  - "src-tauri/src/flyway/tail.rs"
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
and it shares exactly one thing with a card: the **face**. `Card.svelte` takes a structural
`CardFace` both satisfy; every *gesture* still takes a `Conversation`. What a shadow gets on
the wall is precisely what was built for it:

- **Drawn**, by `layout()` itself (`standElsewhere`), in the wall's **left** margin —
  territories flow rightward from the origin, so the left edge is the one that stays put — as
  **a section per project under each wall's name**. See *Sectioned by project* below. Dotted
  border where a territory's is dashed.
- **Focused**, on the same `focusedId` a card uses, so focusing one lets go of the other.
  `focusedShadow` is a separate derived of a separate type.
- **Spoken to**, from the dock (`App.sendElsewhere`) — text only. A `!` line, pictures and
  this wall's own commands are refused with a flash, draft kept, and the dock says so up
  front. **The palette is the trap here**: it still opens over a `/` offering this wall's
  commands, and its line sent raw put `/gear planning` in front of the far agent as a prompt
  about the word "planning" and `/btw …` into the conversation as a real turn (found in
  review). So a half-typed name completes as it would here, a whole one that is Volery's is
  refused, and one that is the CLI's goes — the far wall carries it out as if typed there.
- **Reached by keyboard**, `<space> e e`, which steps through them. Deliberately not a third
  arm of the Tab cycle: both arms walk `canvas.order()`, whose cards are handed to the
  selection and the waiting cycle.
- **Stuck to the glass**, from its own right-click menu or `<space> c g` on the focused one,
  and dragged about there by its own gesture. Its spot is session-only — see *On the glass*
  below, which is the one gesture a shadow shares with a card and the argument for why it
  needed no row.

And nothing else. The node carries `data-shadow`, never `data-conv`, so `nodeOf` reads a press
on one as bare ground — no pick, no carry on the wall, no pin (which would write a placement
row keyed on an id this store has never seen), no card menu: its right-click is a menu of its
own (`menu.ts`'s `shadow` kind), the glass and the close and nothing else, since everything a
card's menu offers besides reaches for a process or a session on the other machine. Before it
had one, a right-click on a shadow fell through to the *ground's* menu and offered to open a
project underneath it. Its one control is a ✕ (and `<space>cc` on the focused one) that
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

### On the glass, for this session

Sink `dbf55968`: Lyss tried to put a shadow on the glass from her work laptop and could not. The
glass is where you put what you want to keep an eye on while working elsewhere, and a card on
another machine is *the* thing you want to keep an eye on while working elsewhere — so of all
the gestures a shadow lacked, this was the one it was made for.

**The decision was where its spot lives, and it lives in memory.** Everything else on the glass
is a pair of columns on a row, reconciled per screen arrangement by `arrange::adopt` — and a
shadow has no row on this wall and never will. Two ways to give it one were open: persist it
(a table keyed on host and remote id), or keep the spot only for as long as this window is up.
It is the second, for three reasons:

1. **A persisted spot outlives what it points at.** A card closed over there while this wall
   was shut, a laptop rebuilt, a wall renamed: each leaves a spot for a card that will never
   arrive again, with nothing on screen to say so and nothing that would ever clean it up.
2. **`arrange::KINDS` clears as well as sets.** Listing a kind there with no rows behind it
   empties that table's `glass_x` on the next arrangement change, and the obvious careless rung
   could reach the real glass's tables. The safe version is a migration, a table and a new
   reconcile arm for a spot that is only worth anything while its wall is talking.
3. **The panel already made this choice.** What was said to a shadow from here is in memory
   only, on the argument that it is only worth tracking while somebody is here. A spot on the
   glass is the same kind of thing: a person's arrangement for the session they are in.

The memory is `ShadowGlass` (`shadow.ts`, pure and tested) held by `Elsewhere.glass`:

- **Keyed on the shadow id**, which is `shadowKey(host, card)` — two walls' cards cannot share
  a spot.
- **Per room**, because `arrange.md`'s one-glass-per-room is about screens, not about rows:
  a spot made unspread read back spread is a pile in the corner. `enterRoom` keeps a room's
  spots apart from the others, gives a room seen before its own back, and copies the room just
  left into one never seen, **shifted by the panes' origins** — `arrange::adopt`'s copy by the
  same rule. App calls `adoptRoom` beside `arrange::adopt`'s answer with the same key and
  origin. A spot stuck before the monitors first answered belongs to the first room named.
- **A quiet wall keeps its spots.** `Elsewhere.walls` is never pruned, so a wall that goes
  quiet still carries its cards (drawn as not heard from), and a lid that opens again finds its
  cards where you stuck them.
- **A card its wall closed lets go of its spot**, in every room (`keepOnly`, run by
  `#reconcile` with the ids the snapshots still carry) — its id will not come back, so the spot
  would otherwise point at nothing for the rest of the session. A wall that is gone for good
  stays drawn muted for the session, spots included, which is the truth: it is the last thing
  that wall said. A restart clears it, which is the session-only half.

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
- **Moving one on the wall.** By design: a section is laid out, not arranged.
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

A card **opened** here at another wall's request says so on its own face — `Conversation.bornFor`,
drawn as *from desk* in the qualifier row beside the account. A field rather than a prop for
the reason `elsewhere` is a field of the face: every surface that draws a card reads it, so
none can forget it. The link's record of births and the card can arrive in either order; an
effect stamps whichever comes second.

### A question asked over there is answered from here

The general rule (sink `16864f3d`): **anything that parks waiting for a person must travel to
where the person is, or fail fast.** A card on the home laptop stopped on `ask_user` while Lyss
sits at the work laptop waits out the whole window and then proceeds without her — "control
them from my work laptop" is simply not true while a question can strand a card.

- **The question rides the snapshot.** `CardDigest.asks` carries each parked question's words —
  header, question, options — and `since` on the owner's clock, read against the snapshot's `at`
  the way `restingSince` is (`askedAt`). Volery's own questions (`ours`) do not ride `asks`:
  close and unpost never travel, and a removal travels in a field of its own, with evidence —
  see *A removal confirmed from another wall* below, because this sentence used to say none of
  the three ever would.
- **Words only.** A preview's markup is code another wall would run and can be large; a file's
  path means nothing on another machine. Both are left behind, and `shows` puts a sentence on
  the question saying a design went with it that only the other wall can show — an approval
  answered without the thing being approved is an answer to something else, and a sentence in
  the question is the one form no panel can forget to draw.
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
- **Held still** (`stirs={false}`). Locally a touch extends the countdown at once and tells
  Rust within a minute, always erring towards *less* time shown. No touch travels, so here the
  same gesture would show *more* time than the far call has — the unsafe direction. Held
  still, it counts the question's base window from when it was asked, which a touch on its
  own wall can only lengthen.
- **Hidden while its answer is on the way**, given back if the answer is refused (the sheet
  still filled in), and **not answerable at all once its wall is unheard** — the question may
  have been answered there or run out of time, and a question not confirmed as still waiting
  must not look like one waiting for an answer. `Yonder.svelte` says which.

Demonstrated 2026-10-08 between two walls of one build: a card on lab2 parked on a real
`ask_user`, the question was on lab's dock within ~3s, "square" clicked there was `taken` in
0.6s and the card resumed and said "square" at 2.7s. Then a question left up while lab2 was
killed: past 90s it was no longer offered and the panel said why.

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
shadow by `focusShadow`, so its question is in the dock and its panel is open.

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
gossiped**. Opening the panel on a shadow (`Yonder.svelte`) asks the owning wall for that
card's tail (`flyway_tail`), and the panel draws it through the same `Transcript.svelte` a
local card uses: folded tool calls that open onto their arguments and result, markdown, the
rails.

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
- **Refreshed off the snapshot, not a clock.** While the panel is open, `Yonder` re-reads
  when the card's settled last line, its activity (`doing` — the only field a run of tool
  calls with nothing said between them moves), its resting moment or `working` changes, and
  when its wall is heard again — a `$derived` string, so a snapshot that moved *another* card
  reads nothing, and a read refused while the wall was quiet is not the last word (found in
  review: without `unheard` in the string, an idle card's panel stayed on the error for good).
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

### A removal confirmed from another wall

The one of Volery's own three questions that crosses, and it crosses because Lyss overruled
the proposal that it should not: *"it should be my judgement whether to go through it or not,
blocked away by volery."* (sink `7207a6d9`). Close stays local — a shadow has its own close,
asked as a person from its ✕ — and unpost stays local, since a board notice is one wall's
coordination with its own cards. **The next person will read the old sentence in `ask.rs` or
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

### What is not here

- **A root to a child on a wall this one cannot see.** The parent's wall records the birth
  (`flyway_child`), but nothing hands it to the front end, and a wall that asked for a card
  almost always hears the wall it asked. A stray is drawn on the child's side only.
- **The whole scrollback.** 120 lines from the end, which is the round you are in and the one
  before; older rounds stay on the owning wall, and the panel says so.
- **A close or an unpost confirmed from afar**, deliberately — see above.
- **Persistence.** What was said to a shadow from here is in memory only, like a `!` line: it
  is in nobody's session file, and a prompt is only worth tracking while somebody waits on it.
