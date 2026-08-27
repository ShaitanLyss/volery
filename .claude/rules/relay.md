---
paths:
  - "src-tauri/src/relay.rs"
  - "src-tauri/src/later.rs"
  - "src/lib/relay.ts"
  - "src/lib/relay.svelte.ts"
  - "src/lib/flow.ts"
  - "src/lib/Flow.svelte"
---

# Cards that can see each other, and the light between them

Two tools on the server `ask.rs` already runs: `list` says who else is on this wall, `send`
puts a message into another card's hands. They are there because several agents working the
same feature at once is the ordinary case on this wall and they had no way to know about each
other — two cards editing `store.rs` from opposite ends, each discovering the other's work as
a merge conflict an hour later.

The URL already carries the conversation id (`/mcp/<id>`), so a call arrives pre-addressed and
there is no correlation logic anywhere. `ask.rs` stays the transport and grew exactly one
thing: `Dispatch::Call` now carries the tool *name*, which it had been dropping. That is the
whole of what made a second tool possible, and dropping it was fine right up until it wasn't —
every `tools/call` parked on a question, so a `send` would have blocked the sending agent for
ten minutes on a panel with nothing in it.

### Fire and forget, where `ask_user` parks

The parking machinery is one file over and would be the wrong shape here. A waiting on B while
B waits on A is two cards wedged with nothing that unsticks them, and the ten-minute timeout
would be the only thing that ever ended it. A reply is the recipient calling `send` back:
symmetric, no deadlock, and nothing to explain to the model.

So `send` returns a receipt in milliseconds and the sending turn carries on. The card that is
about to spend a turn is the one at the other end.

### Handles

A card's id is a uuid, and a model addressing one by 36 characters of hex is tokens spent on
nothing. The first eight are the handle. Titles work too — they are what an agent reaches for
first — but they change under it (`naming.ts` renames as the work clarifies) and two cards may
share one, so **an ambiguous title is refused by name** rather than guessed between. Guessing
would put a message in the wrong repository, silently, and generated titles collide often.

`relay::handle_of` and `relay.ts::handleOf` must agree; the second exists only so the wall can
label a strand whose endpoint has since been closed.

### The guards, which are most of the design

The failure mode this had to survive is not a lost message. It is a spiral of them, at a turn
and an API call apiece, with nothing on the wall saying where the allowance went.

- **Hops are counted and no longer capped.** Delivering to a card marks it with the chain it
  is now acting inside; anything it sends while that turn is open inherits the chain at +1.
  There was a cap of six on that, and it was **removed 2026-08-27** because it stopped
  coordination rather than a spiral. Its own comment claimed "six is a conversation and not a
  loop"; the exchange that finally hit it was two cards negotiating a hand-off of `hooks.rs`,
  six substantive messages in, mid-agreement — which is roughly what settling one shared file
  between two cards actually costs.

  **Depth was never the signal, and that is the part worth keeping.** A loop is two agents
  saying the same thing to each other; a long exchange is two agents converging. A hop count
  cannot tell those apart, so it could only ever fire on both — and the one it fired on was
  the good one, since a genuine exchange is the one that reliably gets that deep. A guard that
  cannot distinguish its target from its opposite is not a conservative guard, it is a coin
  toss with a bias toward punishing real work.

  What is left bounding the original failure: the **rate** limit below bounds a burst, and
  **broadcast-is-hop-0** bounds fan-out, which was always the N²/N³ half the cap explicitly
  did not touch. What is genuinely no longer bounded is a *slow* two-card loop, a turn apiece,
  under the rate limit. That was accepted deliberately — stopping a real conversation was the
  more expensive of the two failures and the one actually happening.

  **The half of it that outlived it** is cited by name from `later.rs` and `spawn.rs`, so it
  is restated on `MAX_SENDS` where a grep for `MAX_HOPS` still lands: a refusal must carry its
  reasoning and a way forward, because an agent told only "no" will try a different phrasing
  of the same message.
- **The mark's lifetime is the bit that is arguable.** It is cleared on a turn *close*, and a
  message written to a card that is already mid-turn is queued by the CLI *behind* that turn,
  so its close is not ours. `Inbound::pending` therefore counts two in that case. It is not
  exact — two relays inside one turn leave it off by one — and the direction of the error is
  chosen: what a lost mark costs is one card getting to broadcast once, where a mark that
  never cleared would silently forbid a card from broadcasting ever again.
- **Storms.** Six `send` calls per card per minute. Counted per *call* and not per recipient,
  which is the whole reason a broadcast is one call: fanning out to twelve cards deliberately
  is something somebody asked for, and twelve separate sends in a second is a card in a loop
  that has not noticed.
- **Broadcast is hop 0 only.** `project` and `skein` reach everyone, with no cap on the
  fan-out — that was asked for. The thing that must not happen is a broadcast whose recipients
  each broadcast, which is N² turns and then N³, and the hop limit does not touch it because
  the *branching* is the problem rather than the depth. So: broadcasting is something you
  started; relaying is something you were told about. A card acting on a message replies point
  to point.
- **4k of body**, clipped rather than refused. A relay is a message, not a transfer — the
  recipient shares the machine and can read the file. Refusing would get the same message sent
  again slightly shorter, twice.
- **Never yourself.** A self-send is a send that should have been a thought, and in a
  broadcast it would be a card handing itself a turn forever.

## Seeing rather than speaking

`list` and `send` are who is here and a message into one of their hands. `touched` and
`recall` are the other half, and they belong in this file because they finish the sentence
every description on this server keeps repeating: **reading costs nobody a turn, and a `send`
costs that agent one.**

The billboard already makes that argument and only goes half the distance, because a notice is
something a card *remembered to write*. Two questions come up constantly that no notice
answers, and that a card had no way to ask except by spending somebody's turn:

- *am I about to work in a file another conversation is in?* — which the wall has recorded all
  along in `file_touch`, from the first build, read by almost nobody.
- *what did the card that did the migration actually conclude?* — which is sitting in that
  card's transcript on disk.

Both are reads, and neither can be answered by the agent alone: one is the wall's ledger, the
other is another process's memory. That is the test a tool on this server has to pass.

### `touched`

Evidence, where the board is intention. It answers for the agent that changed a file and said
nothing about it — which is the common case, because posting a notice is a thing you have to
remember and editing a file is not.

- **`store::touches_near` only narrows; `board::covers` decides.** The table holds whatever the
  tool call named, which is an absolute path nearly always, and an agent asks about what it
  would type. SQL does an `instr` on the basename and the rows come back to Rust for the same
  glob decision that is already written for notices — a second spelling of that in SQL is a
  second place for it to be wrong.
- **Three answers, and only one is worth stopping for.** A write by a card still on the wall is
  a collision; a write by a card since closed is history; a read by anybody is not a clash at
  all — it is how you find out. The tool says so in its own reply rather than leaving the agent
  to rank them, because an unranked list of facts gets reported to the user as a list of facts.
- **A week, and the cut is load-bearing.** Beyond that it is not "somebody is in this file", it
  is "somebody worked on this project", which is what `git log` is for. Without the window every
  file in a mature repository comes back with a paragraph of ancient history attached, and an
  agent that learns this tool answers noise stops reading the answer.
- **No paths given means "my own files"**, which is the shape of *is anybody in my way* — the
  caller's own recorded visits are read first and their basenames become the question.

### `recall`

What to do *instead of* messaging a card to ask what it did. A conversation that has just
finished a piece of work has said so, in its own transcript, and that costs nobody anything to
read.

- **`send` is for when you need something *from* them** — a decision, a rebase, a hand-off.
  `recall` is for when you need to know what happened. The description draws that line
  explicitly, and a test asserts it does, because an agent handed a roster and no cheap way to
  read it will use the expensive one.
- **Only `assistant` text.** Thinking is not something the card *said* and a tool call is
  machinery; what is wanted is the account it gave its user.
- **Read from the end, in a window that doubles.** The first cut streamed every line, which is
  fine for the median transcript (28 KB) and not fine for the one that matters: the card that
  has been working all day is both the one worth recalling and the one whose `.jsonl` runs to
  tens of megabytes. It starts at `sessions.rs`'s measured 256 KB tail and grows until it has
  enough speeches, reaches the start, or hits 8 MB — doubling rather than one generous window
  because the distance from EOF to the sixth-from-last speech is not measurable in advance: a
  card that read three large files between two sentences puts megabytes of tool result where
  `sessions.rs` only ever had to skip its own bookkeeping. Hitting the cap answers with what
  it found, since four speeches is useful and an error is not.
- **A window that does not start at byte 0 drops its first line**, per `sessions::feed_range`,
  where that is argued. Half a line still carries `"type":"assistant"`, and what it costs here
  is not a wrong field but a speech quietly missing from an answer that looks complete.
- **The cheap `contains("\"assistant\"")` gate before the parse** is most of what a pass costs
  — the same trick `usage.rs` uses on the same files.
- **A missing transcript is an error, never silence.** "It has said nothing" and "Skein could
  not find its file" are acted on completely differently, and collapsing them would have an
  agent report a card as idle when the truth is that the reading failed.
- **It is that card's own account, not a check on it.** The reply says so: what a conversation
  believes it has done is not what is in the repository.

## A message to yourself, later

`wake_me` (`later.rs`). The worst thing a card can do with a turn is spend it waiting, and
today it has one move: park a `Bash` call on a `sleep` and hold the whole turn — context,
process, and the user's attention — doing nothing for ten minutes. This is the other way
round. The turn *ends*, the wall keeps the note, and when the moment comes the card is handed
a prompt as though somebody had typed it.

It lives beside the relay because it **is** the relay's delivery: `supervisor::deliver` if the
card is live, a `relay` row for the inbox `spawn_conversation` already drains if it is not.
Getting a prompt it did not type is a thing this codebase has already got right once, and a
second mechanism beside it would be a second thing for `relay.ts` to learn to draw.

- **A self-send across time is not a self-send.** `do_send` refuses one because a message to
  yourself should have been a thought; a message to yourself *later* is the only way to have
  a thought later. Different tool, different mark: `WAKE_MARK` rather than `RELAY_MARK`,
  because `relay.ts` reads a sender's name out of that envelope and there is nobody at the
  other end of this one. The envelope also says nobody is waiting on a reply, or the agent
  answers it.
- **The loop it has to survive is a card that re-arms forever**, at a turn and an API call
  apiece — the failure `relay.rs`'s guards exist for, arriving by a road they cannot see:
  every wake is hop zero, because the card is talking to itself. So the guard is a **rate**,
  twelve per card per hour, counted on *delivery* — which is why `wake_served` is a table of
  its own outliving the `wake` rows it counts. Checked on arming too, so a card in a loop is
  told while it still has a turn to do something about it.
- **Serving claims before it delivers**, and the DELETE is the claim. Interrupted between the
  two, a lost wake is a card that waits for nothing; a double-served one is a card handed the
  same prompt in a loop. `store::set_mid_turn`'s lesson again — bookkeeping about how far
  something got is written when it happens.
- **Thirty seconds to twelve hours, clamped rather than refused.** An agent whose wake was
  bounced spends a turn discovering the range. Below thirty seconds the round trip costs more
  than it saves and it wants a `sleep`; past twelve hours it is not a wait, it is a reminder,
  and the description sends that to `drop` — an item in the sink costs no turn when it comes
  due.
- **The waker is started in `setup`, beside `perf::spawn_reaper`**, for that function's exact
  reason: a wake armed for ten past has to arrive at ten past whether or not anybody is
  looking at the wall. It is the third deliberate poll in this codebase, and it earns it the
  same way the other two do — **a moment arriving is not something that happens to anything**,
  so there is no event to subscribe to.
- **A card that closes or is cleared loses its wakes.** Unlike the sink, there is nothing here
  worth keeping: a note to yourself has no value once there is no self to hand it to.

### Chat cards may do neither, and this is the one gate worth arguing for

A chat card spawns `--tools WebSearch,WebFetch` with no bypass, precisely so that what it
reads on the web cannot act on this machine (`.claude/rules/chat.md`). `--tools` filters the
built-in set only — MCP tools pass straight through — so without an explicit refusal both of
these arrive on a chat card with full reach.

`send` from a chat card would be a line from the open web into a card running
`--dangerously-skip-permissions`: the exact route the kind exists to close, reopened one layer
up. And `list` is a list of this machine's directories handed to the one card that can reach
an arbitrary URL. Both are refused, decided by asking the store what kind of card this is —
never by trusting the caller, the rule `spawn_conversation` follows.

A chat card still **receives** when addressed by name: it has no tools, so a prompt is only a
prompt, and "ask the researcher" is a legitimate thing to want. It is passed over by a
broadcast, though — it has no repository to be coordinated about, so an announcement is a turn
spent on nothing.

### What the transcript keeps

The recipient's CLI replays a relayed prompt as a plain `user` message — the same shape as
something you typed. Left alone it is drawn in your register, in your card, with nothing
saying it was not you. That is the bug this whole half exists to prevent, and it is the same
hazard `isStopNote`, `isCompactSummary` and `skillBody` each answer one arm over.

So it is its own `Line` kind, recognised **off the words themselves** (`relay.ts`), the way
`rousing.ts::isResumePrompt` recognises a resume and for the same reason: the live fold and
the one that reads a session back off disk share nothing but the text, and no column would
survive `--resume` reading the CLI's own file.

- **It opens a turn**, unlike the three notes above it in that arm. A message is a prompt
  somebody sent and the card is about to spend a turn on it.
- **Asked before `#claimEcho`.** The texts could not match, but a relay arriving while a send
  of yours is still unacknowledged must not be able to settle it either way.
- **Folded, with the sender as the cap.** Not for size — a relay is usually a paragraph — but
  for whose words they are: instructions written by another agent for this one, which is
  exactly the register nobody reads. Opened, the *whole* envelope shows, including the note
  addressed to the model, because what is worth reading is what the agent was actually handed.
- **`relayFrom` degrades rather than refuses.** A header this build cannot parse is still a
  message the agent was given and acted on, so it is drawn as a relay from nobody. Getting it
  wrong in the other direction is the thing that must not happen.
- The title is quoted in the envelope, so a quote inside a title would end the field the front
  end reads the name out of. Folded to an apostrophe rather than escaped — one less thing for
  two parsers in two languages to agree about.

### Queued, not woken

A dormant target gets a row with `delivered_at` null, and the card wears a mark saying it is
holding post. `spawn_conversation` drains the inbox — the one line both `wake` and `open`
reach, the same argument the `kind` lookup there makes — *before* anything else can be
written, so a card woken by a prompt you typed reads what it was told while it slept first.
That is the order the two actually happened in.

Waking instead was the alternative and is the more consistent rule; it was not taken because
an agent that can spend a process and an API turn on six sleeping cards without anybody asking
is the wrong default. `wake: true` is available and says what it costs.

**`chain` and `hops` are stored, not only held in `Relays`.** This used to be a guard in its
own right — a queued message delivered at tomorrow's launch is the sixth hop of something, and
a restart that reset it to zero was a way to buy six more hops by crashing. With the cap gone
that argument goes with it, and they are still stored for two reasons that do not depend on
it: `broadcast && hops > 0` is a live guard that has to survive a restart the same way, and
`relay.ts` draws a chain. Cheap either way, and a counter nobody enforces is the right thing
to keep — it is what any future guard that can actually tell a loop from a conversation would
be built on.

## The strand

A message in flight is drawn as light between the two cards. The thing being avoided is a
**wire**: a line between two cards says they are connected, which is a claim about the wall
that is not true — nothing connects two cards, and a message is an event rather than a
relationship. So a strand exists only while something is travelling on it, and when the light
has passed the wall is two cards again. Nothing persists and there is nothing to clear away.

### It is two threads, because a skein is

One stroke reads as a cable. Two read as something alive — and the app is called Skein because
a skein is threads twisted together, so the shape was there before the feature was.

The two share a curve and disagree about everything else. `weaveAt` displaces each laterally
by a sine along the route, in exact **antiphase**, so they braid, cross at every node, and
meet again at both cards; every zero between them is a crossing rather than a place they
touch, which is why nothing in that function ever takes an absolute value. And each runs its
own clock — the second is nine per cent slower, sets off seventy milliseconds late, draws a
longer and fainter smear, and takes the unlifted tone. The pair never travels as a unit: one
leads, the other laps into it at a crossing, and which is in front changes as they go.

**The amplitude tapers to zero at both ends, and that is not decoration.** Both threads have
to *land on the cards*. A braid that kept its width to the end would arrive as two lines
striking either side of the card it was meant to be reaching. The taper is `sin(pi t)`, which
is `1.2e-16` rather than `0` at the far end, so `weaveAt` pins both ends by hand — an endpoint
that is *nearly* the rim is an endpoint the next person has to write a tolerance around.

### Two tones, one colour

Celadon, `--st-work`: the tone this wall already uses for *working*, because a message in
flight is work moving between two cards. That satisfies the rule in `tokens.css` rather than
arguing with it — colour here means status, as everywhere else.

`paletteFor` returns **two** shades of it and both are drawn. The braid crosses constantly,
and a braid in one tone reads as a flat ribbon: you cannot tell which thread is in front, so
the crossings stop being crossings. The lead thread takes the lifted tone, so the faster and
brighter half is also the one that reads as nearer.

**The compositing is read off the ground rather than fixed.** Skein's own wall is dark
(`--ink`), where light is light and adding it is right. `theme.ts` puts the ground within
reach of the eleven knobs, and additive white on pale paper is a strand that gets *lighter
than the wall* and vanishes at the moment it is brightest. So the ground is read off the
document at mount, the way `Backdrop.svelte` reads its own two tones.

### The clock is derived, not chosen

Three things happen in sequence and each must finish before the strand is taken down: the
pulses cross, the route empties behind them, the rings open where the light landed. `FLIGHT_MS`
is `Math.max` of all three. It was picked by eye first, at 1400, and the second arrival ring
was still at a third of its alpha when the strand was retired — a landing that finished by
being switched off, which is exactly what the wake was shaped to avoid. **Anything added to
that timeline owes the same arithmetic.**

### The rest of it

- **The bow's sign is not chosen**; it falls out of the perpendicular of `a → b`. So a reply
  bows the other way from the message it answers, and direction is readable with no arrowhead
  anywhere on the wall. Nothing in `flow.ts` ever normalises the two endpoints into an order,
  and it must not start.
- **`fan` only ever adds, never flips.** Two messages the same way before the first has landed
  are drawn beside each other; an alternating sign would buy that separation by making half
  the strands lie about where they were going.
- **Screen pixels, at every zoom.** A strand has to reach a card on the wall *and* a card stuck
  to the glass, and screen space is the only frame those two share (`glass.ts` makes the same
  argument from the other side). It also means a strand keeps its width when you zoom out —
  which is the point, since seeing the whole studio is exactly when you want to see who is
  talking to whom.
- **Endpoints are read fresh every frame.** A card dragged while a message is crossing to it
  takes the light with it, and so does a pan: the strand is between two *cards*, not between
  two points that were true 900ms ago.
- **Pulses are stroked segment by segment, not as one path with a gradient.** A canvas gradient
  is defined between two points and this curve doubles back on itself — the braid guarantees it
  — so a two-point gradient would run its ramp along the chord and put the bright end in the
  middle of a bend.
- **A queued message never arrives.** The strand flies and dissipates; no rings. Drawing an
  arrival there would be the wall claiming a delivery that has not happened, which is the
  honesty `Conversation.echo`'s pending mark keeps one surface over.
- **The loop stops when nothing is flying**, per `Backdrop.svelte`. The effect tracks a
  *boolean*, not the list, or every strand swept would tear the loop down and rebuild it.
- **`prefers-reduced-motion` gets the same curve and the same braid, held and faded** — not
  nothing. What a strand says is who told whom, and none of that is in the movement; a message
  arriving with no mark anywhere on the wall is a worse answer than a line that does not move.
- **`MAX_STRANDS` cuts the oldest, never the newest.** A cap that dropped the new ones would
  make a big broadcast look like a small one. `snapshot.flights.cut` reports it, because a
  bound silently dropping work reads from outside as a wall that missed one.

`snapshot.flights` carries what is in the air, what has been cut, and what each card is
holding undelivered; `snapshot.cards[].inbox` carries the last of those per card, reported
beside `dormant` for the reason `aside` is reported beside `tier` — a sleeping card with post
and one without are the same card from out here, and the difference is what happens the moment
it wakes.
