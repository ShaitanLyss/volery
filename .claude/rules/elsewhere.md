---
paths:
  - "src/lib/shadow.ts"
  - "src/lib/shadows.svelte.ts"
  - "src/lib/Yonder.svelte"
  - "test/shadow.test.ts"
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

- **Drawn**, by `layout()` itself (`standElsewhere`), one region per other wall in the wall's
  **left** margin — territories flow rightward from the origin, so the left edge is the one
  that stays put. Four columns, fixed, so another machine opening cards does not reshape the
  region. Dotted border where a territory's is dashed.
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

And nothing else. The node carries `data-shadow`, never `data-conv`, so `nodeOf` reads a press
on one as bare ground — no pick, no drag, no pin (which would write a placement row keyed on an
id this store has never seen), no card menu. No close control: only the wall it is on can end
it. No strand box, no Tab order, no perf meter. Each of those is a thing that would have
needed a guard; here it needed nothing, which is the point.

**A shadow is also not a dormant card.** A dormant card has a row and no process *yet*, and
wakes when you type. A shadow has no row and no process here, ever. It is drawn muted when its
wall goes quiet, borrowing the dormant fill because "the light is what's missing" is exactly
true — but the words say *not heard from*, never *dormant*.

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
  the way `restingSince` is (`askedAt`). Volery's own questions (`ours`: close, unpost, remove)
  never travel; they are answered on the machine they would act on, and the link refuses an
  answer to one anyway.
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

### What is not here

- **The transcript.** A digest is the tier; streaming a conversation is a much larger tier and
  `FLYWAY-REMAINING.md` says what it costs. `Yonder.svelte` says in words that the conversation
  stays on the other machine, because a panel shaped like a transcript with most of it missing
  reads as one that failed to load.
- **Notices travelling** (sink `16864f3d` item 2). A card that finished or ended on a question
  shows its tier on the shadow, but the notice queue is this wall's.
- **The peek, the taskbar flash and the chime** for a remote question. The card goes amber on
  the wall and the question takes the dock, but `attention.svelte.ts` folds local cards only.
- **Persistence.** What was said to a shadow from here is in memory only, like a `!` line: it
  is in nobody's session file, and a prompt is only worth tracking while somebody waits on it.
