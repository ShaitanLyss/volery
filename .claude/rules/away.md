---
paths:
  - "src-tauri/src/presence.rs"
  - "src/lib/presence.ts"
  - "src/lib/presence.svelte.ts"
  - "src/lib/Vigil.svelte"
  - "src/lib/attention.svelte.ts"
  - "src/lib/away.ts"
  - "src/lib/pieces.ts"
  - "src/lib/Away.svelte"
  - "src/lib/gate.ts"
  - "src/lib/Gate.svelte"
  - "src/lib/sketch.ts"
  - "src/lib/sketch.svelte.ts"
  - "src-tauri/src/sketch.rs"
---

# Being away: questions that wait, and a wall that goes quiet

### The failure this exists for

`ask_user` parks an HTTP request until you click. `.claude/rules/ask.md` spends two thousand
words on the three watchdogs it took to make that survive ten minutes, and the longest a call
can possibly wait is `ANSWER_MAX` — 45 minutes, and only for a call carrying a dozen
questions. That is the right shape for a question asked while you are at the wall.

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

`MAX_PER_CARD` bounds the pile at eight per card, and past it the tool says so and tells the
card to decide for itself. That is a bound rather than a courtesy: an agent that asks, is told
it was queued, and asks again is a loop with nobody awake to notice, and what it produces is a
pile nobody can read — the one way this fails *worse* than the timeout it replaces, since a
timeout at least forgets.

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
- **`parked={false}` replaces the countdown with how long it waited.** The countdown is real
  information for a live ask — it is what tells you whether to keep reading or answer now —
  and for a question out of the pile it would be an instrument reporting a pressure that does
  not exist. What is worth knowing instead is how long it has stood, which is what makes a
  pile readable in any order.

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

- **It honours the motion setting**, read off `document.documentElement.dataset.motion` — the
  same channel every stylesheet reads, rather than a second one to keep in step. `still` draws
  one frame and stops the loop outright; `spare` runs at 20fps.
- **Rotation is folded onto `clock.t`**, the wall's existing one-second tick, so an away
  screen adds exactly one rAF to an idle machine and no timer at all. `HOLD_MS` is nine
  minutes: long enough that walking past twice in an evening shows the same thing, short
  enough that a night is not one piece. `nextPiece` never repeats the current one and prefers
  a mood it does not have, so an evening moves between fun and cute and artistic instead of
  taking three artistic ones in a row by chance.
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

### Three puzzles, and the two bugs the tests caught

| | what it is | why this one |
|---|---|---|
| `motus` | six letters, the first one given | the French game rather than Wordle, and the free letter is what makes six letters reasonable before coffee |
| `calculus` | differentiate or integrate | the one that is actually *work*, in the way a warm-up is |
| `rotate` | Shepard–Metzler: same shape, or its mirror? | needs no vocabulary and no maths, and the time it takes rises linearly with the angle, which is as close as a puzzle gets to being measurably a rotation in your head |

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

### What it can and cannot get you, which is a real limit and not a gap

The two museum sources are open-access collections — the Art Institute of Chicago and the Met
both publish public-domain works with an API and no key, so Hokusai, Mucha, Klimt, Sargent and
several thousand others are one search term away. The third is Picsum, for photographs, which
is a different exercise: value and foreshortening rather than somebody else's line.

**A living artist's work is in none of them.** Yoshitaka Amano — the Final Fantasy covers, and
the case this was asked about — is in copyright, and a built-in fetcher that went and got his
paintings would be Volery redistributing somebody's work rather than finding you a reference.
So the honest route is `sketch_folder` / `sketch_adopt`: point the setting at a directory of
images you already have and they are drawn alongside the rest. It costs one path and it is the
only answer that is both useful and defensible. Say so rather than quietly returning a
different painter.

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

### What was deliberately left out

- **Partial answers are still lost on a live timeout.** That is `ask.md`'s own open item and a
  different piece of work.
- **Volery's own parked questions keep timing out** — see the asymmetry above.
- **Nothing goes away by itself.** No idle timer, no "you have not touched the wall in two
  hours". `ask.md` already settled the general case: guessing that nobody is there would
  answer for somebody who had merely gone to make coffee, and that is the one wrong answer.
  Away mode is a thing you say.
