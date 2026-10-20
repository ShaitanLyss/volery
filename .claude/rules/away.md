---
paths:
  - "src-tauri/src/presence.rs"
  - "src/lib/presence.ts"
  - "src/lib/presence.svelte.ts"
  - "src/lib/Vigil.svelte"
  - "src/lib/attention.svelte.ts"
  - "src/lib/peeking.ts"
  - "src/lib/Peek.svelte"
  - "src/lib/away.ts"
  - "src/lib/pieces.ts"
  - "src/lib/Away.svelte"
  - "src/lib/gate.ts"
  - "src/lib/Gate.svelte"
  - "src/lib/sketch.ts"
  - "src/lib/sketch.svelte.ts"
  - "src-tauri/src/sketch.rs"
---

> **Away mode is not a night mode.** *"I could be away for lunch, away for toilets, away for
> sport for 2 hours."* It has to be worth throwing for five minutes, which is a constraint on
> every surface below: the tool's description names lunch before it names bed, nothing in the
> prose says *morning*, and the gate does not put a puzzle in front of a five-minute break
> (`GATE_AFTER_MS`). The pile and the silence work the same at both scales.

# Being away: questions that wait, and a wall that goes quiet

### The failure this exists for

`ask_user` parks an HTTP request until you click. `.claude/rules/ask.md` spends two thousand
words on the three watchdogs it took to make that survive ten minutes, and when this was built
the longest a call could wait was `ANSWER_MAX` — 45 minutes, and only for a call carrying a dozen
questions. (A question has no deadline at all since 2026-10-16, which makes this file the only
thing standing between a card and an empty room — see *Nobody at the keyboard* below.)

It is the wrong shape for the evening of 2026-10-01. Lyss went home having handed direction to
an orchestrator card running several workers, each told to batch its product questions as
`ask_user`. A question asked at seven was gone by a quarter to eight. What each agent was
handed was *"nobody answered, carry on"* — so it decided alone, or lost the question, and
either way the morning began with decisions already taken by something that had not wanted to
take them. Her words, filed as sink `04cff69f`: *"ask user prompts have a timeout of max 45
mins lol, they won't wait long enough"*.

**Away mode's whole move is that a deferred question does not park at all.** The `tools/call`
returns at once with a note saying it was queued, the card carries on with whatever does not
depend on the answer, and the answer arrives later as a new turn. Nothing is held open, so
none of the three clocks is in play — which is why `presence.rs` is a few hundred lines rather
than a fourth round with Bun's `fetch` timeout. The general shape is worth keeping: **when a
deadline cannot be made long enough, stop needing one.**

### Where the state lives, and why it is split

`presence` is one nullable column (`store::migrate_v38`) and `deferred_ask` is a queue beside
it. Everything *cosmetic* — whether the screen animates, which reading of it, whether a toy
guards the way back — is localStorage, with the motion setting and the theme skin, per the
house rule that per-machine and disposable lives there. That is what keeps the table from
growing a column per knob.

Three things decide that split and none of them is taste:

- **Rust has to answer it.** `presence::away` is asked on the thread answering a `tools/call`,
  with no webview in sight. A setting the front end owned would have meant an IPC round trip
  on the path of every question.
- **Away is a timestamp, not a flag.** The morning pile says how long it stood, and the away
  screen counts from it. A boolean would have cost a second column the first time anything
  wanted to say *9 hours*.
- **It survives a restart, in the one direction that matters.** A wall that goes down at two
  in the morning and comes back believing you are at it resumes parking questions against a
  deadline nobody will meet, and resumes throwing peek windows at an empty room — the two
  things away mode exists to stop, undone by a crash nobody saw. `presence::load` runs in
  `setup`, after the store and before anything can ask.

Every failure in both directions resolves to **here**. `store::read_away_since` answers `None`
on any error and `presence.svelte.ts` falls back to present: a database that cannot answer
must not be the thing that silences your notifications.

### The question that was already on the wall

You flip the switch at seven; a card asked at five to. Left alone that question is parked
against a deadline nobody is going to meet — the exact loss away mode exists to prevent, five
minutes before it was switched on. So `presence::flip` converts whatever is parked, and
`ask::take_parked_questions` is how.

That is why `Asks.pending` holds a `Parked` rather than a bare `Sender<String>`. The answer
path never needed more; the conversion does, because a channel on its own cannot say which
card asked or what it asked.

**A question Volery composed is not converted**, and the asymmetry is about what an answer
*is* rather than about effort:

- An `ask_user` answer is **information**. It goes back to the agent as a turn and the agent
  decides what to do with it, with its own context in hand.
- `close`, `unpost` and the `remove` hand-off carry a `Settle` (`ask.rs`), so the answer is a
  **decision** and the settle performs it. Approving one twelve hours later means Volery doing
  something irreversible against a wall that has moved on, with no agent left to tell and
  nothing to catch it if the premise changed.

Their unanswered behaviour is already the conservative one — the card stays, the notice stays,
the delete is refused — and *"nobody was there"* is the right input to those where it is the
wrong input to a product question. The rule is enforced twice on purpose, in
`take_parked_questions` (which does not drain them) and in `park_and_stream` (which will not
run a settle on a deferral), because the two facts live in different files and the one that
would be wrong is a card closed because the wall went quiet.

The conversion is recognised by the **opening of the string**, the idiom the park already uses
for its timeout: `presence::DEFERRED_OPENING` is both what the agent reads and what the
parking thread matches on, so there is no second vocabulary to keep in step.
`ask:closed` grew a third outcome, `deferred`, rather than a shade of `answered` — an ask that
nobody answered gets `NO_ANSWER_NOTE` written into the card, and a deferred one needs no note
because the tool result says it was queued in better words and says them in a transcript a
restart can reproduce. That is the bargain `ours` already strikes one field up.

### What the agent is told, and where that text lives

**The whole contract is in the reply, not in the tool's schema.** `ask_user` is an
`alwaysLoad` tool, so every byte of its description is paid on every spawn of every card for
ever (`ask.md`'s two tiers), while the deferral note costs nothing until the one turn it is
true of — and lands in front of the model at exactly the moment it needs it. The sink item
asked for it in the docs; this is the same instruction, in the cheaper place. Four things it
has to say, each a way the feature fails without it:

| it says | or else |
|---|---|
| the question was **queued**, nothing was lost | the agent re-asks, or treats it as a timeout |
| **nothing has been decided** | a non-answer is read as consent |
| the answer comes as a **new message** | the agent waits for a return value that already came |
| **do not ask it again** | the morning pile is one question eleven times |
| the row's **id**, and that `withdraw` takes it back | a question answered some other way still asks her, and her answer lands as a stale turn |

`MAX_PER_CARD` bounds the pile at eight per card, and past it the tool says so and tells the
card to decide for itself. That is a bound rather than a courtesy: an agent that asks, is told
it was queued, and asks again is a loop with nobody awake to notice, and what it produces is a
pile nobody can read — the one way this fails *worse* than the timeout it replaces, since a
timeout at least forgets.

### Taking a filed question back (2026-10-20)

Lyss: *"agents need to have a way to cancel deferred questions when no longer relevant … useful
for example when the question got answered some other way like plain text or through another
card sending messages."* A filed question goes stale in a way only its card can see: she types
the answer into the conversation, or another card `send`s it. Left standing, the row goes on
asking her in the pile, in chat view's *needs you* and on every wall the digest carries it to,
and answering it hands the card a turn about something already settled.

- **The reply names the row, in the sentence that says it was kept** (`deferred_note`,
  `rest_note`, and `notice::queued_note` for a waiting notice), and ends on `withdraw_line` —
  one function, so every road says it in the same words. Every road into the pile goes through
  `presence::file`, which now hands back the id it minted, so the direct filing, the conversion
  of a parked question, the unattended one and *defer* are covered by construction. A waiting
  notice queued while nobody was there is the same situation one table over (its reply may
  reach the card some other way), so it gets the id too; a plain `wait: false` notice is news,
  not a wait, and does not. A full pile filed nothing and names nothing.
- **`mcp__skein__withdraw` is deferred**, found by the words of the problem (*"the question I
  put off was answered"*, *"the user answered in chat"*), for `cancel_wake`'s argument: the
  reflex is reached by the reply that queued the question, which names the tool in full beside
  the id — a tool result, free per turn. Nothing was added to the loaded tier. The name is
  spelled out in `withdraw_line` rather than interpolated, because `supervisor`'s guard that
  every `mcp__skein__…` in a result is advertised reads literals and caught the first cut.
- **Own rows only** (`pick_withdrawal`, pure): another card's id is refused naming that card,
  so the stale question can be raised with it instead. An id is matched whole or by a prefix of
  at least eight characters (the handle length every id here is quoted at), and a prefix naming
  two of the caller's rows is refused rather than guessed. Mine first: an id that is the
  caller's is not refused because a prefix of it resembles somebody else's.
- **The claim is the answer's claim.** `store::take_deferred_ask` — the same DELETE under the
  store lock that a person's answer takes, read and deleted under one hold — so whichever lands
  first wins. The loser is told plainly: a card withdrawing a question she already answered is
  told the answer is on its way as a message. To tell *already answered* from *no such
  question*, the `take_deferred_ask` command remembers what it took (`Presence::taken`, memory
  only, 256 rows); after a restart the two read alike and the reply says both. Every refusal
  ends with the caller's own queued rows and their ids, since the agent may simply have the
  wrong one.
- **The pile hears it as a notice change** (`notice::changed`), the event `clear_for` already
  sends when a card's rows go and `presence.svelte.ts` already refreshes on — no new listener.
  The digest other walls draw the pile from is folded from that read, so a far wall stops
  drawing it on its next snapshot, and an answer it was holding for the row is let go by
  `#sendHeld`'s existing *no longer files it* arm, whose sentence now names a withdrawal among
  the reasons. Nothing new crosses the flyway.
- **A chronicle row**, under the card's name, *withdrew a queued question: …* with the
  agent's optional `reason` as its detail — so a question leaving the pile is never a mystery.
  It is the one thing here that is the card's own gesture told to her rather than hers told to
  her, and the register's rule (*what happened to you*) admits it: the pile changed under her.
- **Acts are not withdrawable**, deliberately: `act_note` already tells the card there is
  nothing to cancel, because answering one re-enters the decision against the wall as it is.

Demonstrated 2026-10-20 on a frozen lab (`wd`) with a real Haiku card: it put the wall away with
its own `away` tool and called `ask_user`, which filed row `82b72f47…`; its reply quoted *filed
under id `82b72f47-…`*. A `withdraw` of that id posted to the MCP endpoint as a second card on
the same wall was refused (*queued by another card (`9ac99e7f`), not by you*) and the row stood.
The card was then told the answer had come in chat and to take the queued copy back *"the way
the queueing reply told you to"*. It was not told the tool's name. It found `withdraw` from the
reply alone, the row went, the chrome's pile count dropped from 2 to 1 (the one left was its own
*finished* notice), and the chronicle read *withdrew a queued question: Which colour should the
lab banner be?* with the reason *answered in chat*. A second withdrawal of the same id said
nothing was queued under it. **Not shown:** the *already answered* reading (it needs a person's
claim racing the card, so `a_question_already_answered_reads_as_answered_not_as_unknown` holds
it), a far wall letting go of a held answer (that path is `#sendHeld`'s existing arm, which
this change only rewords), and a queued waiting notice withdrawn (same gate, unit-tested).

### The tool can say you are gone and cannot say you are back

`mcp__skein__away` exists because you say *"I'm off"* to a card rather than reaching for the
header. It is deferred-tier with a hint written in the words of the problem — *the user said
they are leaving, off to bed, going out* — since nobody thinks "set presence".

It cannot end away mode, and the asymmetry is about which direction the mistake runs in.
Saying *away* wrongly costs a question being queued instead of asked, and the queue is read
the moment you touch the wall. Saying *back* wrongly re-arms every peek, every chime and every
parking deadline, in a room with nobody in it, and nothing finds out until the morning shows a
pile of expired questions. **Where a person is, is a claim only that person can make.** The
refusal names the way out in the same paragraph, because a card told "no" with nothing to
offer is a card that argues.

### The silence

`Attention.sync` returns early while away, and it takes the whole ladder — peek, taskbar
flash, chime, *and the rung countdown*. `enabled` is a preference about whether Skein may
interrupt you; this is a statement that there is nobody to interrupt. The countdown's
exemption is argued from *"an alarm you only hear if you had wandered off is not an alarm"*,
and that argument runs out here: away is not having wandered off.

**The alarm pass is muted rather than skipped**, which is the half that is not obvious.
`ring` answers *what is newly overrun* by comparing against what has already sounded, so a
pass that does not run leaves every alarm that went off overnight looking fresh — and the
first tick after you come back would play all of them at once, hours late, which is worse than
ringing in an empty room. Muting keeps the bookkeeping and drops only the sound.

The peek is **hidden**, not merely not shown: going away with one on screen must take it down,
or away mode begins with the exact thing it exists to prevent still sitting in the corner.

### The peek says only what you have not seen

Lyss, 2026-10-16: *"they show up when I go to another window, which is nonsensical because I
was already on the wall so I know what was going on"*. She was right about the mechanism, not
just the feel. `Attention.sync` showed the peek whenever the window was not in front and the
ladder held anything. So alt-tab threw up the wall's whole standing state at once: questions she
had been reading, a failure she had just seen go rust, a card that finished in front of her.
The signature check underneath only governed the chime. The window, and the taskbar flash with
it, came up for everything.

**Seen means it was there while the window was in front, and it has stood without a break
since.** "It" is the item itself, *or the state it reports*. `peeking.ts` is the whole rule,
pure and asserted:

- `look` folds every pass into a `Sight`: `leftAt`, when the window stopped being in front, and
  `heard`, when each key now on the ladder was first on it. A key that leaves is **forgotten**.
  So a card whose question was answered elsewhere and that then asks a second one is heard
  afresh. Without the forgetting, `blocked:<card>` would read as the question you left behind.
  `look` runs ahead of `enabled` and of away mode for the same reason: a pass that does not run
  misses the leaving.
- `since` is the state's own start, where that is earlier than its row. An `overdue` row reaches
  the ladder `GRACE_S` after the rest it reports, and a rest notice `SETTLE_MS` or more after
  its rest. Both rests were on the wall from their first moment. So a card that finished while
  you were looking is seen even when its row arrives after you left. Another wall's question has
  no `since`. Only this wall's hearing of it is known, and a question that reaches this wall
  while you are away is news even if it was asked earlier.
- `unseen` is what the peek shows: `min(heard, since) > leftAt`. The peek lists **only** those
  rows, not the ladder. What you left behind is still on the wall, where you will see it.
- `toAnnounce` spends the window, the flash and the chime once per key, pruned to what is still
  showing. So a dismissal holds until something new arrives, and a row that resolves does not
  bring the peek back for whatever is left. A dismissal used to be undone by any row leaving,
  because it was recorded as the whole list's signature.

Two consequences, both deliberate:

- **Focus stands in for looking, in the quiet direction.** If the window is in front and you have
  walked away, whatever happens is "seen" as far as the peek is concerned. Coming back, you are
  looking at the wall first, and the chime covers the walk (*the chime is not a peek, and focus
  is not presence*). The peek is for a window you cannot see, and this does not change that.
- **A wall opened behind another window** counts its own launch as the leaving. A notice or a
  rung timer from before then is not news. That is the rule the bell already kept (`#watching`).

Three places the inputs had to be right, each found by the red-team pass:

- **A blocked row is keyed and dated by the card's newest ask**, not by the one drawn. A card
  can hold several (a subagent asking behind its parent's question). A second question arriving
  while you were away would otherwise ride the first one's key, already seen, for as long as
  you were gone.
- **A crash is dated by itself** (`Conversation.diedAt`). A card that dies at rest is still
  counting `idleSeconds` from its last turn. So a death after you left read as one you saw, and
  the one failure this ladder calls "the one case worth a window" was silenced.
- **The leaving is dated from the blur** (`onFocusChanged`), not from the pass that noticed it.
  The race, where something lands between the two, comes out as news.

Left on purpose. Another wall's rows carry no `since`, so a question you saw that drops off
while its wall is quiet and then comes back is announced again. Giving it the remote ask's own
time would fix that and would also silence a question asked while its wall was unreachable,
which you never saw: a repeat is cheaper than a miss. And a failure that turns into a notice
`SETTLE_MS` later is announced twice, because the two rows have different keys. That was true
before this change, and an allowance is exempt because both fold to the account's key.

### An account running out is one piece of news

Same day: *"when my account runs out of allowance, I'm swarmed with one notification per card
… at most I should get one notification saying an account ran out of allowance"*. An allowance
running out stops every card on that account within seconds, and each card stood on the ladder
as its own `failed` row, or as its own error notice once a heal had given up. The result was a
peek reading *"6 things want you"*, all six carrying the same CLI sentence.

`Conversation.lastFault` is `healKindOf` of the turn that last broke. It has to be separate from
`lastError` because the sentence alone cannot say it was a 429: the status rides in
`api_error_status`. `coalesce` folds every `failed` or `notice` row whose cause is `limited`
into **one row per account** (`accountLabel`; one row with no name when no account is managed).
The row is keyed `limited:<account>`, reads `ran out of allowance — N cards stopped on it`, and
lands you on the first card it caught.

- **Folded from the first card, not the second.** The key is the account's, so the second card
  joins a row already announced. Folding only from two would change the key and announce the
  same account twice.
- **Only `limited`.** An overload is weather, and two cards that broke for different reasons
  are two pieces of news. A blocked card on that account stays blocked: a parked question is
  not an allowance.
- **The folded row rings once, as a notice, if it swallowed one** (`rings`). The first cut drew
  it as `failed` and nothing more, so with the window in front an allowance running out rang
  nothing at all, where it used to ring once per card. The red-team pass caught that: *"they
  asked for one, and get zero"*. Its key is the account's, so the bell's own books give one
  ring per account. A row made only of `failed` cards (held on a reset, no notice yet) rings
  only as a failure would, which is not at all while you are at the wall.
- **The dock is not folded.** Each card's error notice is still its own item there, with its
  own reply box and its own close. That queue is per card on purpose (`notice.md`). The folding
  is about being interrupted, and the dock does not interrupt.

Demonstrated 2026-10-16 in a lab: four fresh cards. Three were fed a 429 `result`
(`api_error_status: 429`, *You've hit your session limit*) and one a 529. The ladder read two
rows: one `ran out of allowance — 3 cards stopped on it`, with the three error notices folded
into it, and the 529 card's own notice. **The peek window itself cannot be shown in a lab**:
`isDriven` mutes the ladder whenever the control surface is armed (2026-10-08's reason), and
focus is not something a control op can move. So *what is seen* is asserted in
`test/peeking.test.ts` and reasoned in `sync`, not demonstrated. A card on another wall carries
no cause in its digest, so another wall's allowance failures are not folded. Nor is a notice
that stood across a restart: `lastFault` lives in memory, and such a notice is seen at
launch anyway, so only its row in the peek's list is affected.

### The morning pile

`Vigil.svelte`, opened by `Presence.comeBack` when there is anything in it.

- **Grouped by card, not listed by time.** The unit of attention is a card: three questions
  from one agent about one piece of work are one context to load, and interleaving them with
  another card's is the mistake `asking.ts` describes an agent making when it fuses two
  decisions into one question. `pileOf` sorts cards by their own oldest question, so the pile
  reads in the order it accumulated.
- **It reuses the ask panel rather than drawing its own.** A deferred question is the same
  payload a live one is, and a second implementation of the stepper, the previews, the gallery
  and the free-text field would be a second place for a design to arrive unrenderable. That is
  what `Ask.svelte` taking `ask`/`project`/`title` props instead of a `Conversation` bought:
  the pile has no card blocked behind it and could not have invented one.
- **How long it has stood, not a countdown.** It was `parked={false}` that swapped one for the
  other, back when a live ask had a countdown; since 2026-10-16 neither has one, and both draw
  when the question was asked — which is what makes a pile readable in any order.

### The pile had no door of its own, and that is a class of bug

`presence.showing` was written in exactly two places for the whole of away mode's first life:
`comeBack`, which opened it, and the panel's own close. The panel also shuts on a `mousedown`
anywhere on its scrim — which is right, and is how `Ask.svelte`'s sheet behaves — so the pile
could be dismissed with one stray click and then had **no way back in**. The only route was
going away again and coming back, which is `z` twice and is a gesture nobody would guess from
looking at the wall. Lyss hit it on 2026-10-05 with two cards' questions in the queue and
reasonably asked whether they were gone.

They were not, and the distinction is the useful part: **nothing about this was a data bug.**
A `deferred_ask` row is deleted by `store::take_deferred_ask` when the question is answered
and by `drop_deferred_asks_of` when the asking card is closed, and by nothing else — not by
the panel, not by a restart, not by presence changing. `showing` is a reading of the queue and
never the queue. So the whole of the loss was in the gesture, and the whole of the fix is a
way to make it again.

The general shape is worth stating, because away mode is the subsystem most prone to it:
**a surface whose only door is the event that created it is a surface you get one look at.**
Anything else that opens itself in response to something happening — and this file is full of
them — owes a second way in that does not require the event to happen twice.

What it got is the two the house style asks for, both going through one verb
(`Presence.openPile`, so the button and the chord cannot disagree):

- **A chrome button, absent until something is in it.** It is `register`'s argument verbatim —
  a thing that happened while you were away leaves no mark on the wall, so the count has
  nowhere else to be — and the stronger case of the two, since the chronicle is a thing to
  read and this is a card waiting on you. Achromatic anyway, for `register`'s reason. It folds
  later than `away` and before the readings: when something is waiting it is the most
  important item in the bar, and giving it up for the zoom would be the fold inverted.
- **`<space>p`**, for the pile. Deliberately not in the `i` family — `i` is *"I'm …"*, a claim
  about where you are, and this is not one — and deliberately not a second spelling of `z`,
  since coming back and reading the pile being one gesture is the bug. `q` was the obvious
  letter and is left free: `test/leader.test.ts` spends it as its example of a key that
  completes no chord, after nvim's `<space>q`.

**An empty pile does not open**, from either door, and that is not tidiness: `Vigil.svelte`
*is* the pile, so an empty one is not a smaller version of that panel — it is a panel
reporting "0 questions from 0 cards", which is an instrument reading nothing. `pileOpens` in
`presence.ts` is the whole rule, pure and asserted, for the purity boundary's reason: what a
gesture does is testable and the rune holding the answer is not.

### The answer is yours, so it is drawn as yours

`answerEnvelope` deliberately carries **no relay mark**. `relay.ts` recognises five shapes
under two marks and every one of them means *this was not you* — a message from another card,
a notice off the billboard, a note the wall handed back. This is the opposite: you read the
question and clicked, and Volery only carried it. A mark here would be the same lie
`isRelayPrompt` exists to prevent, told the other way round. `test/presence.test.ts` asserts
it against both predicates, because the honest-looking mistake is to add one for tidiness.

What it must carry instead is *which question*, since the agent asked hours and possibly
several turns ago — so the question is quoted back with the answer under it, which is what
`composeAnswer` already does for a live call. And it says **nothing is parked**: an agent that
read an answer and then waited for its `ask_user` call to return would wait for ever.

Answering sends a turn, and `Skein.send` rouses a dormant card to take it. That is the one
expensive gesture in the panel — a process and an API turn per card — so the pile says how
many cards it is about to wake before you start. It is the opposite of `later::serve_due`'s
rule, which drops a wake into the inbox rather than rousing, and the difference is who asked:
a wake is a card's note to itself, where this is a person at the wall deliberately answering.

The claim comes **before** the send, `later::serve_due`'s ordering and its reasoning: an
interruption between the two loses an answer, where the other way round hands a card the same
decision twice, and that is the worse failure.

### Away is the person's, across every wall (sink `f931e6ca`)

Lyss had switched `AU-LT-288` to away and was working at `QUEERISFREEDOM`. A card on `AU-LT-288`
asked her something, it went into that laptop's pile, and she never saw a question she could have
answered at once. The per-wall switch was exactly right while a wall was the only place she
could be; the flyway made that false. It is the same shape as the `ours` list and `unpost`'s old
argument on the same day (`ask.md`): **a rule justified by two things not interacting expires the
moment something makes them interact.**

**The fix is small because a parked question already travels** (`CardDigest.asks`, `confirms`,
`elsewhere.md`). If the asking wall knows she is elsewhere it parks the question instead of
filing it, and the existing path carries it to her. So there are now two readings, kept apart:

- **`presence::away_here`** is this wall's switch. It draws the away screen, mutes this wall's
  ladder, and is what this wall *announces* (`Facts.present`, on the flyway's existing tick, and
  at once when the switch flips — `link::announce_soon`).
- **`presence::away`** is whether there is nobody to ask: switched away here **and** no other
  wall present. Present means heard within the roster's `QUIET_AFTER_MS` and announcing
  `present`. **A quiet wall counts as away and a never-heard one does not exist** (her ruling: *"a
  quiet wall should count the same as i'm away"*), so there is no third state for a call site to
  weigh. `present` is a positive word so an older wall, which sends nothing, also reads as away.
  On one machine, or with no peers, this is exactly the old switch: the change only ever *adds* a
  reason to park.

Every place that chooses between parking and filing asks `away` — `ask_user`, a waiting notice,
and the settle-carrying arms, which ask `nobody_to_ask(app, settle.travels())` so that a question
made under an `ask::Stay` (one that cannot reach her elsewhere) is still filed by this wall's
switch alone, rather than parked for an empty room. **Going away while she is present elsewhere
files only those**: what travels stays parked where it reaches her, and the notices stay up,
since they travel too (`take_parked_questions(…, staying_only)`).

The remaining case was the pile itself: she is away everywhere, the question is filed, and she comes
back on the *other* machine. That is the next section.

### The pile is hers, not a machine's (sinks `52c0affa`, `3368f78f`)

2026-10-20: three nova cards on `AU-LT-288` filed four questions while she was away; she came back at
`QUEERISFREEDOM` and saw none of them. The coordinator restated them in its own transcript and relayed
her answers by `send`, which lost the options and the previews. Her words: *"deferred questions should
be sent and synced across the flyway"*. The fix is the parked question's shape (`elsewhere.md`, *a
question asked over there is answered from here*) applied to the pile, and every half of it reuses
something that already existed:

- **The rows ride the digest** as `CardDigest.filed`, through the same mapping and reader a parked
  question takes (`shadow.ts::travelling`, `readAsks`), sourced from `Presence.asks` through an
  injected `Elsewhere.pile`. A design or a file is pulled by the same look: `ask::args_for_afar` falls
  back to the row (`presence::filed_args`) when nothing is parked, and the files were resolved before
  the question was filed, so the stored arguments are what the look reads.
- **The far wall draws them in its own pile**, not its dock — `Presence.afar` is
  `Elsewhere.filedHere()`, merged into `pile` and `waiting`, so `Vigil.svelte` groups them under the
  card (*project · on host*) and answers them through the same `Ask` panel. The local pile does not go
  in the dock either; a far one does not get a door a local one lacks.
- **The answer is the local answer.** The far wall composes `answerEnvelope` exactly as `deliver` does,
  and sends it down the prompt wire naming the row (`deferred:<row>`, `presence::AFAR_PREFIX`). The
  owning wall's link hands it to its front end (`flyway:prompt` with `deferred`), and
  `Elsewhere.#takeFiled` does what `deliver` does: check the row is this card's, **claim it, then send
  it as a turn**, waking the card. *Not worth answering* is `PILE_DROP`, a claim with nothing sent.
- **The claim is the only dedup, and it is enough.** `take_deferred_ask` is a `DELETE` under the store
  lock, so whichever answer reaches it first wins — the owning wall's own pile, this wall, a third — and
  every other is refused as no longer waiting. Which is also why every try goes under a fresh request
  id: the fleet refuses a reused one once its time to live is past (`fleet::reach`), and nothing else
  needs the id to repeat.
- **`filed: null` is unknown, never empty.** A wall that has just started publishes its cards before
  its pile is read (`Presence.loaded`); read as "nothing filed", that snapshot cleared every far sheet
  and let go of every answer held for the wall. The red-team review caught it before it shipped. An
  older wall sends no field, which reads as null too.
- **A pile grows all night**, so it travels inside `FILED_BUDGET` per card; past it a question goes
  lean with `shows` set and is pulled whole. A snapshot over `cards.rs::MAX_SNAPSHOT` is refused
  whole, which would freeze every card on that wall at exactly the moment she comes back to look.

**Into a wall not heard from, the answer waits** — the one thing on the prompt wire that does, against
*refused now, never queued for later*, and the asymmetry is the argument. A prompt, a parked answer and
a confirmation are only worth delivering while somebody is waiting on them. A filed question is the
opposite by construction: the card was told the answer comes later, as a message, whenever she gets to
it. So `Elsewhere.held` keeps every answer's words until the owning wall says (`localStorage`, so a
restart of this wall loses nothing; pictures cannot be kept and are refused into a quiet wall), and
`#sendHeld` sends them when that wall is talking — on its snapshot *and* on the roster saying it is
heard, since a wall coming back with nothing changed sends no new snapshot, and nothing changing is the
normal case with the asking card asleep on this very answer. A row the wall no longer files is let go
and said, never sent.

Demonstrated 2026-10-20 on two labs of one build (`qa`, `qb`, on one private key), with a real card on
qb switching qb away and asking through `ask_user`, and qa switched away so nobody was present:

1. The question was filed on qb and drawn in qa's pile with its options, *on lab-qb*. `teal` pressed in
   qa's pile reached the card as the local envelope (`answered from lab-qa`), and it replied `TEAL`;
   both piles emptied.
2. A second question, then qb closed. Past the quiet bound qa still drew it, saying *has not been heard
   from — an answer waits here until it is*; `square` was held, qb relaunched, and the card replied
   `SQUARE` with qa's line *taken*.
3. A third, answered `large` on qa while qb was down and held; qa closed; qb relaunched alone and
   `small` answered in its own pile (`SMALL`); qa relaunched, read its held answer back out of storage,
   found the row gone, and said so — nothing reached the card twice.

**Not done:** deferred *acts* (close, unpost, remove) still stay in their wall's pile. Their question is
the owning wall's prose and carries no evidence, since the away path files it before `Settle::stamp`
runs, and `elsewhere.md`'s rule is that the far wall composes a decision from fields, never from that
prose. Sink `91c5a729` has the shape.

### Nobody at the keyboard (2026-10-16)

A wall nobody has touched for as long as it takes to lock (`machine::idle_away`, `machine.md`)
counts as switched away **for filing**: `nobody_to_ask` is `(away_here || idle) && !(travels &&
present_elsewhere)`, and `watch_idle` — called on the 25s tick every parked call already has —
files what is parked through the same `defer_parked` the switch runs, with a chronicle row since
nothing opens the pile on the way back. It was announcement-only until questions lost their
deadline; with a deadline a forgotten laptop's question was filed within forty-five minutes
anyway, and without one it would have waited for days. That is why it changed, and why the
`AwayWhenIdle` knob is on by default with a chord (`space m i`).

What it deliberately does **not** do: draw the away screen, mute the ladder, or mark a rest notice
`away` — those follow the switch alone (`switched_away`), because they are about a person having
said where she is, and an inference from an untouched mouse should not silence anything. The
filing reason is `Queued::Unattended`, whose opening (`UNATTENDED_OPENING`) does not claim the wall
is in away mode, since nobody switched it. And it is idempotent rather than edge-triggered: an
edge needs the start of a stretch of idleness, and a stretch that began with nothing parked
would leave a stale one behind.

Demonstrated 2026-10-14 on two labs of one build (`cfa`, `cfb` on one private flyway key): with
cfb switched away by its card's own `away` tool and cfa present, a card on cfb called `ask_user`.
It **parked** rather than being filed, cfa drew it within seconds, and `teal` pressed in cfa's dock
reached the card 15s after it asked. With cfa switched away as well, the same call was filed at
once (*Volery is in away mode … queued*) — the union, not merely "always park". The run also
caught the `away` tool still telling the card that `ask_user` queues, which became untrue the
moment it was written; its reply now says whichever is true (`cb701b5`). **Not shown:** idle,
which needs twenty untouched minutes on the one machine running both labs. Its threshold and
verdict are unit-tested, and `idle_away` ran in both labs' announcements and answered *not idle*
while the machine was in use, which is all a lab can show.

## The away screen

`Away.svelte`, and it stands whenever the wall is away — **including with the
animation switched off**, because a dark window is indistinguishable from a crashed one and
saying *the wall is away* is the screen's first job. The setting decides only whether anything
moves.

### Touching it does not bring you back

The pieces answer the pointer, and that is most of why they are worth having. Lyss asked for
it in as many words: *"imagine we're showing a ball bouncing from one edge to another,
clicking could bounce it back or send it in another random direction, grabbing and holding
would allow to seize it and move it, and then release it with a flick to give it momentum"*.
A screen that fled on the first click could not be played with at all.

So the three gestures are the same in all four pieces — **tap** does something to the thing
under the pointer, **hold** seizes it, **release** throws it at the speed your hand had — and
the way back is the button or Escape, which is a thing you mean rather than a thing you brush.

`flick` is where a drag becomes a throw, and it has two rules that are each a bug that would
otherwise only show up overnight. It measures the **last 90ms** rather than the whole gesture,
because carrying something slowly and then snapping your wrist averages to the wall ignoring
you. And it refuses to divide by zero, clamps, and `pieces.ts::sane` catches whatever gets
past: **one `Infinity` in a velocity is a thing that leaves the universe on a screen nobody is
watching, so it is still gone in the morning.**

### Colour, and the clause that became a condition

`toys.md` records the one standing exception to *colour means status*: the synth is full of
hue, confined by two things — nothing touches `tokens.css`, and the toy occludes the wall
outright, so at no moment is a status colour and a decorative one on screen together.

The away screen inherits that bargain and inherits the second clause **as a condition rather
than as a fact**, because one of its three readings deliberately does not occlude the wall.
`hueAllowed` is the whole rule: `takeover` and `peek` may use hue, `dimmed` may not, and
`pieces.ts::tone` is the one place either branch is written, so a piece is authored once and
reads correctly in both. Even the hue arc is short on purpose — amber through rose to violet,
skipping the greens and reds that mean *working* and *failed* on the wall.

### The three readings are a setting because the answer is genuinely taste

Asked, and the answer was *"not sure so i'd make it a setting too"*. `takeover` is a
screensaver; `dimmed` leaves the cards legible behind, for walking past and seeing that work
is happening; `peek` covers and fades out while you hold any key, for the glance that does not
end away mode. The knobs live in the screen's own corner rather than in a panel, which is
`Effects.svelte`'s argument about the ambience: the whole point of editing a backdrop live is
that you are looking at the thing you are adjusting.

### What it costs, and the three things that bound it

An away screen runs for hours unattended, which is the worst case `motion.md` describes.

- **It does not honour the wall's motion setting, and the first version did.** That was wrong,
  and the correction is Lyss's: *"that enum is for the always on pulsing animation on active
  cards"*. It was measured against the status glow — which runs on every working card, for
  ever, while you are trying to read the wall — so everything about it answers *how much should
  the wall move while I work*. An away screen is opt-in, runs only when nobody is there, and in
  two of its three readings covers the wall outright, so there is no glow on screen to compete
  with and no work being read over it.

  What the gate actually did, which is the part worth keeping written down: at `spare` the
  screensaver ran at 20fps, and at `still` **the loop drew one frame and stopped**. So a wall
  set to no motion got a frozen picture, and a wall set to less motion got something visibly
  stepping — with nothing on screen to say a setting had done either. Together with the
  restart bug above it produced the exact 1fps that was reported, and fixing the restart alone
  would have left a `still` wall staring at a single frame.

  The away screen's own switch is `presence.animate`, in its own corner, and that is the right
  one: a knob about the away screen belongs to the away screen.
- **Rotation is folded onto `clock.t`**, the wall's existing one-second tick, so an away
  screen adds exactly one rAF to an idle machine and no timer at all. `HOLD_MS` is nine
  minutes: long enough that walking past twice in an evening shows the same thing, short
  enough that a night is not one piece. `nextPiece` never repeats the current one and prefers
  a mood it does not have, so an evening moves between fun and cute and artistic instead of
  taking three artistic ones in a row by chance.
- **The frame loop's dependencies are stated, and everything else is untracked.** This is the
  bug the away screen shipped with, and it is worth reading before touching any effect here.
  `start()` ended by noting when the piece went up — `since = clock.t`, a read of the wall's
  one-second `$state` tick, **inside a tracked `$effect` body**. So every second the effect
  tore the loop down and built a new piece, and a piece's `resize` is how it is *built*: the
  flock scattered to new positions, the orbs were re-placed, the lanterns re-hung. With the
  motion setting at `still` — where the loop deliberately draws one frame and stops — those
  were the only frames left, and the screen ran at **exactly one frame per second with nothing
  in the same place twice**. Reported as *"the animation runs at 1FPS … no smooth animation,
  no smooth interactions"*, and the first guess from across the room was that the machine
  could not keep up. It was a dependency.

  `untrack(start)` is the fix rather than mending that one line, because the line was not
  wrong in itself: anything `start` reaches may read a rune — `readTones`, `size`, `env`, a
  piece's own `resize` — and a fix that mended only the read that happened to bite would leave
  the next one to be found the same way. **An effect whose body calls into the rest of the
  file should state its dependencies and untrack the call.** The two other effects here are on
  the same tick and got the same treatment, one of which was a near miss.
- **`size()` resizes the piece only when the box moved.** Same hazard from the other side: the
  `ResizeObserver` fires once on observe and again on every layout settle, and each call was
  throwing the scene away and starting a new one.
- **One canvas per piece, not one canvas.** A canvas cannot change its context kind once it
  has one and `tide` is WebGL2 where the others are 2D, so the `{#key}` is the whole of that:
  a new piece gets a new element and the old context goes with the old one. A machine with no
  WebGL2 falls back to `flock` rather than showing a black rectangle for nine minutes.

## The gate on the way back

`Gate.svelte`, and away mode is **still on while you stand in front of it** — `comeBack` is
called from the gate's way through rather than from the toggle. That ordering is what stops a
half-woken wall firing every notification that accumulated overnight at the moment you reach
for a key.

Lyss's reasoning, in her words: *"unlock toys are fun actions to do when i'm back to actually
unlock volery and get back to work … the idea is to get fun and stimulate the brain, it
shouldn't take too long, 5 mins max"*.

### It does not meet a short absence at all

`gateOnReturn` is two conditions and the second is the one that was missed first time. The
setting being on is you having said yes; **having been away twenty minutes** is Volery
deciding the question is worth asking at all. Under that, coming back is nothing: the screen
goes and the wall is there.

The gate exists to mark a boundary — you were doing something else and now you are back at
work — and a trip to the kettle is not one. A puzzle after a five-minute break is exactly the
thing the next paragraph says would end the feature, and it would end it *faster*, because it
happens several times a day.

It is deliberately **not a setting**. The knob for "never" is already on the gate, and a
second knob that is a *duration* is one nobody can answer without trying three values.

### It is not a lock, and that is a design decision rather than a weakness

The bypass is on screen from the first frame, small and quiet — asked for in those words when
the alternative was offered. It is right for a reason beyond preference: **a gate that
actually held the door would be a gate you resent on the morning you are late**, and one
morning of that is the end of the feature. It works because you want it to, and the only thing
the design owes you is that wanting it is easy.

Everything follows from that. No score, no streak, no timer counting you down. Getting it
right says so and lets you through; getting it wrong costs nothing and offers another. The
switch that turns it off for good is *on the gate itself*, because a thing you cannot refuse
is a thing you stop enjoying — and the away screen's own knobs turn it back on.

### They are on the toy shelf as well, and croquis was nearly never on either

`<space>t` carries all four, through the same component at `mode="play"` — see `toys.md` for
what differs. They were built to mark a boundary on the way back to work, and that turns out
to be a *worse* reason to meet one than simply wanting to: a word you cannot get is a fine
thing to be doing while a card thinks.

The shelf also surfaced a real defect. `sketch` was in `TOYS` and could not be the puzzle you
were given: the initial pick named the other three explicitly, so croquis was reachable only
by pressing *another*. The reason was real — reading `sketchbook.ready` reactively there would
swap the puzzle under your hands the moment a fetch landed — and the fix was wrong, because
what it needed was to be read **once** (`untrack`), not to be left out. The general shape, and
it is one this codebase keeps meeting: **a value that must not change under you wants to be
read once, not avoided.**

### Four puzzles, and the two bugs the tests caught

| | what it is | why this one |
|---|---|---|
| `motus` | six letters, the first one given | the French game rather than Wordle, and the free letter is what makes six letters reasonable before coffee |
| `calculus` | differentiate or integrate | the one that is actually *work*, in the way a warm-up is |
| `rotate` | Shepard–Metzler: same shape, or its mirror? | needs no vocabulary and no maths, and the time it takes rises linearly with the angle, which is as close as a puzzle gets to being measurably a rotation in your head |
| `sketch` | a reference, and a button saying you drew it | the only one with no right answer, and the only one that can be unavailable — see below |

**A generated puzzle that cannot be solved looks exactly like you being bad at it**, which is
why every generator here is a function of a seed and is asserted rather than eyeballed. Both
of the guards found a real bug on the first run:

- **The answer is checked numerically, not symbolically.** String comparison would reject `2x`
  for `2*x` and `x^2/2` for `0.5x²` — a gate that fails you for being right. So `parseExpr` is
  sixty lines of recursive descent and `sameFunction` compares at five sample points. An
  integral accepts **any** antiderivative, by comparing the difference against a constant:
  demanding the particular spelling in the table would be marking a convention rather than the
  calculus.
- **Letters are matched as a prefix, longest token first.** With whitespace stripped, `2x
  sin(x)` is `2xsin(x)`, and the greedy word match this started with read `xsin` — not x, not
  a function, not anything. Two correct answers in the bank were unparseable and therefore
  unpassable. Functions are tried before `pi` and `x` so that `exp` beats `e`.
- **A figure whose mirror is also a rotation of it is chiral in name only**, and asking *same
  or mirror?* about one has two right answers — so the gate marks you wrong for the true one.
  `makePuzzle` grows until the figure is genuinely handed, and if it gives up it offers a
  rotation pair, since *mirror* is the only answer that can be wrong about a shape we are not
  sure of.

Motus's marking is the other classic: a letter appearing twice in the guess and once in the
answer earns one mark, not two, so it is two passes — exact positions first, then the leftovers
against what is left. A single pass teaches the player something false.

### The fourth toy has an outside

`croquis` is a reference on the screen, a pencil and paper in front of you, and a button that
says you are done. Nothing marks it — it is the only toy here with no right answer, and that
is the point. Lyss's reasoning: *"i want real photographs to sketch, and I also want sometimes
pieces from artists I like … to copy style in order to build on my drawing knowledge …
basically I want to get better at drawing and find my own style"*.

**The gate never fetches.** That is the rule the whole toy rests on. A morning with no network
is still a morning you wanted to draw, and a gate that went to the internet for its picture
would hang for twenty seconds on a train and then show an error — so the fetching happens
while you are *going away*, when the machine is idle and nobody is waiting, and the gate only
ever opens a file. `topUp` is called from `togglePresence`, never from `Gate.svelte`.

The timer counts **up**. A timer running out is a thing you watch, and five minutes spent
watching a clock is not a drawing — `Rest.svelte`'s argument about the break screen, one
surface over. The number exists so you know afterwards how long it took.

A reference is **dropped from the cache when you say you are done**, which is what makes
twelve of them two weeks of mornings rather than the same twelve pictures for ever.

### Four sources, and why the fourth had to exist

Two are open-access collections — the Art Institute of Chicago and the Met both publish
public-domain works with an API and no key, so Hokusai, Mucha, Klimt and Sargent are one
search term away. One is Picsum, for photographs, which is a different exercise: value and
foreshortening rather than somebody else's line.

The fourth is **an image search**, and the first version of this file refused to build one on
copyright grounds. That was wrong, and the correction is worth keeping because the reasoning
error is a common one. Lyss: *"about Amano, I understand there's copyright, but I'm not asking
to steal his work, just show it like a normal Google search would so that I can look at it and
sketch it, that's no copyright infringement"*. Fetching an image to **look at** is what every
browser does on every page; drawing from a reference is what every art student has always
done. What copyright bears on is publishing or selling the result, and nothing here does
either — the picture is cached locally, shown to one person, and deleted when they say they
have drawn it. Refusing was mistaking *where the work came from* for *what is being done with
it*.

So `search` is two requests to DuckDuckGo — a page, for the token its results endpoint
demands, and then the results — probed 2026-10-02 at 58 results for *yoshitaka amano*, each
with a full-size URL, its dimensions, a title and the page it was found on. **It is the most
fragile thing in this subsystem and says so**: neither request is a published interface, so it
returns `null` rather than throwing, `topUp` moves on, and the other three go on working. If
it ever stops, that is what has happened — not the cache and not the network.

`folder` stays, for the one thing a search is bad at: references you chose deliberately and
want to come back to.

### Two checks, not one, because they are different questions

`sketch_json` keeps the exact host allowlist: a *question* goes to one of a handful of
services whose shapes `sketch.ts` knows, and widening that is a commit.

`sketch_cache` cannot have a list — an image search names a different CDN every time — so it
checks the **shape** of the host instead. `public_only` refuses anything but https, and
refuses loopback, private and link-local addresses, which is what stops a command reachable
from the webview being used to read `http://192.168.1.1/` or a service bound to localhost. It
is not airtight: a name that resolves to a private address at connect time is not caught,
since this reads the URL and not the socket. That is written down rather than implied, and for
a personal desktop app fetching pictures the user asked for it is the proportionate check.

What actually protects the disk is the three things that apply to every byte either way — the
magic-number sniff, the size cap, and a file name that cannot climb out of the cache. A host
list was never what made those true.

### Two things `sketch.rs` is careful about

- **It is not a general-purpose fetcher.** A Tauri command that fetched any URL and wrote the
  answer to disk is a hole whatever it is called, so every request is checked against
  `ALLOWED` by exact host or registrable suffix. The cost of that list being short is the
  right cost: a new source is a commit here rather than a URL typed into a settings box. The
  tests cover the three shapes the check is usually broken in — a lookalike suffix, a URL with
  the allowed host in its *query*, and `https://api.artic.edu@evil.example/`.
- **The bytes decide what an image is**, not the `Content-Type`. The name `sniff` returns is
  what the asset protocol serves a content type from, and the bytes come off somebody else's
  CDN — so a header is a claim and the magic number is the fact. It also catches the captive
  portal answering an HTML login page with a 200, which would otherwise be cached as a picture
  and drawn as a broken image at seven in the morning. `sketch.ts::safeParse` is the same
  guard one layer up, for the JSON.

The cache lives under `references/sketch/`, inside the one directory the asset protocol will
serve from. `store::sweep_orphans` walks that directory and deliberately leaves subdirectories
alone — *"nothing puts one here, so one that exists is somebody else's and not ours to
collect"* — so this is the case that comment was written for.

## The keyboard, while either screen is up

`onGlobalKey` returns early on `presence.away || gating`, and both surfaces blur whatever had
focus when they arrive. Two bugs, and neither is visible from reading either file alone:

- **Escape would have done two things.** Further down the wall's ladder it stops a turn, and
  it is also the way back from both of these — so the one keypress that ends away mode would
  have interrupted whatever the focused card was in the middle of. It is swallowed as a whole
  rather than Escape alone, because the gate *is* a keyboard surface: `motus` reads every
  letter, and a ladder underneath that still answered `f` or `/` would be the wall acting on a
  word you were spelling.
- **A full-window layer covers the draft field; it does not blur it.** So every letter of a
  motus guess would also have been typed into a prompt nobody can see, and `onDraftKey` would
  have acted on it. The blur belongs in the arriving layer, since it is the layer arriving
  that makes it true.

## Acts, and what "if it is still relevant" means

Three tools compose their own question — `close`, `unpost`, and the delete `remove` handles,
including the shell line a hook stops. For away mode's first day these went on timing out, on
the argument that their unanswered behaviour is already the conservative one.

**That argument was wrong about what gets lost.** Lyss: *"close unpost remove should be queued
somehow instead, if still relevant, otherwise we're going to miss a lot of cleanup — often
cards want to remove scratch temp folders they built for their experiments"*. A refusal is
safe in the sense that nothing wrong happens, and unsafe in the sense that matters: a night of
refusals is a tree full of other cards' `.scratch-<handle>/` directories and a board full of
notices nobody can take down, and nobody goes back for them.

### The request is stored, never the decision

`deferred_act` holds `tool` and the **arguments the card gave**. Answering calls
`presence::reenter`, which asks `spawn::close` / `board::unpost` / `remove::remove` *again*,
now, and gets a fresh `Settle` — or `Stale`, meaning the tool no longer wants to ask, which is
reported as *"it did not happen — the wall has moved on"*.

That is the whole of the qualifier. A card that has since started a turn is refused; a notice
whose author came back is refused; a directory now holding somebody's unwritten work is
refused, because `remove`'s own settle re-checks that too. **Storing the outcome instead was
the obvious shape and is the trap** — a closure cannot be serialised, and a serialised
*verdict* would mean performing an act against a wall nobody has re-read.

Three consequences worth knowing before touching it:

- **`Parked` carries the request beside the question**, so flipping the switch with one
  already on the wall files it as an act rather than leaving it to expire.
- **The row is taken and the act attempted in one call**, which is the opposite ordering from
  a deferred question. An answer lost is a card that waits; an act performed twice is a card
  closed that somebody reopened. `store::take_deferred_act` returns what it took, so the
  attempt has something to work from.
- **The card is told and not roused.** It asked for something to be done, not for an answer it
  stopped on, so `later.rs`'s rule holds — `tell_late` is `remove::deliver_late`'s shape
  generalised, under `RELAY_MARK`'s *from the wall —*, which is honest here in a way it is not
  for an answer you composed yourself.

`smith` and `docket` (and `update_volery`) cannot be filed, and that is the line: they write to
somebody else's service, where re-entry can check nothing about what changed while you were out.
Since 2026-10-16 they no longer time out either — they **wait**, parked, travel to any wall she is
at, and her yes still lands on an open turn when she is back.

The panel says so rather than implying a decision is simply carried out — *"checked again
before anything happens — if the reason has gone, it won't"* — and it keeps the sentence that
came back, because quite often it is *nothing happened*, and a row that vanished silently
would leave you believing a card was closed that is still open.

### What was deliberately left out

- **Away mode is still a thing you say.** The screen, the silence and the morning pile come
  only from the switch. What changed on 2026-10-16 is narrower: an untouched machine *files*
  questions as the switch would (*Nobody at the keyboard*, above), because once a question has
  no deadline the alternative is a card parked on an empty room. It files and decides nothing —
  a question in the pile is still answered by her — which is why it does not run into the old
  objection that guessing nobody is there answers for somebody gone to make coffee.
