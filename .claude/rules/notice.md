---
paths:
  - "src-tauri/src/notice.rs"
  - "src/lib/notice.ts"
  - "src/lib/Notice.svelte"
  - "src/lib/Said.svelte"
  - "src/lib/Glance.svelte"
  - "src/lib/glance.ts"
  - "src/lib/glancing.svelte.ts"
---

# Notices: a card that stopped, in the queue that waits for you

### The failure this exists for

The only way to find out that a card had gone to rest — finished, or stopped on a question
asked in prose rather than through `ask_user` — was to pan the wall to it. The chronicle did
not solve it: a register is a history of what happened, and nothing in it waits for you to
have seen it. A notice does, and that is the whole difference. Lyss, 2026-10-07: *"I never
want to miss a card being done or waiting on me because it's off-screen."*

### It is the ask's queue, not a second one

A notice stands in the dock exactly where a parked `ask_user` and a `close` / `unpost`
confirmation stand, drawn one at a time with *"N more waiting on you"* under it, and the
"more" steps through every item in the queue, this wall's and other walls' (`queue.ts`). Asks
come first *when the dock chooses afresh*, because they hold an agent mid-turn and a
notice is a card that already stopped — but **never by displacing a notice you are already
on**: one hold covers every kind, and nothing arriving moves it (ask.md, "Nor does the
question itself change while you are answering it"). A reply typed here lives in
`replies.svelte.ts`, not in the panel. The same attention ladder rings for it (peek, taskbar flash, chime, all muted while
away), and while the wall is away it goes into the pile beside the deferred questions,
grouped by card — `presence::flip` marks the ones already up as `away`, the same edge
`defer_parked` converts parked questions on. `Notice.svelte` is drawn by both the dock and
`Vigil.svelte`, `Ask.svelte`'s arrangement for its reason.

### Four kinds, and what raises each

| kind | raised when | label | reply |
|---|---|---|---|
| `done` | a turn ended clean | finished | follow up |
| `question` | its closing paragraph asks (`endsOnQuestion`) | ended on a question | answer |
| `error` | an error the card has **given up** on — not while a heal is pending | stopped on an error | follow up |
| `card` | the card called the `notice` tool | notice | follow up |

A stop raises nothing: it was your own gesture. Neither does a turn the CLI answered locally.
A rest notice is **one per card** — a newer rest replaces the older, and any turn opening on
the card takes it down (`supervisor::persist_turn` → `notice::stirred`), because what it
described is over. A card's own notices accumulate and only an acknowledgement clears them.
A follow-up to a rest is simply your next message; to a card's notice it quotes the notice,
since that may be hours old. No relay mark on either — they are your words.

**No notice for the card you are watching** — selected, panel open, window in front *and
touched within a minute* (`Skein.watching`, set in `App.svelte`, over `Attention.looking`). You
saw it finish.

The minute is the part that was missing until 2026-10-20. Watching was *focused*, asked once
when the raise fires, and the window in front is the ordinary way to walk away from the desk
(*focus is not presence*, `attention.svelte.ts`). Lyss: a card she had sent a prompt to stayed
selected, finished while she was looking elsewhere, and raised nothing — *"when a card gets
finished or ended on a question, and I'm not looking at it at that specific moment, then I
should get a notice."* `notice.ts::looking` is the rule: in front, and a key, click, wheel or
pointer move inside `LOOK_MS`. A minute, because a streaming answer is read with the hands
still; the wrong side of it costs a chime for a card you did watch, the other side costs the
work. (Chat view's settle-by-reading asked the same reading until it was retired on
2026-10-21; nothing is settled by being on screen now.)

**And a turn she opened is hers whoever opened the card.** `notice_raise` held every rest of
a card whose parent has a process, on the argument that the parent is told instead
(`spawn::settling`). But the parent is told only about a stop it has not already heard of
(`spawn::arms_stop`): a turn Lyss prompted in a child that had already reported went to
nobody. The front end now says who opened the turn (`Conversation.openedByYou`, read when
the turn ends, sent as `byPerson`), and `held` skips the parent hold for hers.

### Acknowledging one puts its card to rest

Taking a notice down used to touch nothing on the card, so the colour and the label were
downstream of a fact nobody updated: `ending` stayed `question`, `urgencyFor` went on
answering `ask` past `QUESTION_BLOOM_S`, and the card glowed amber saying *"ended on a
question"* about a question you had just read (Lyss, 2026-10-14). The clock measures nobody
having been back, and acknowledging is having been back.

- **It goes into `urgencyFor`, as `seen`, beside `aside`** — not into the waiting cycle, the
  dock's count or `attention.items`, which are four readings of the tier. `aside`'s reasoning
  in `restore.md` is the whole argument and it is not repeated here.
- **Below `error` and `asked`, on purpose.** `asked` is a question standing now, which a notice
  about the last rest cannot answer. `error` is not a clock: rust does not warm, it says the
  card broke and is still broken, and reading that mended nothing — so an acknowledged error
  stays rust and stays in the Tab cycle until you send it something. `notice.ts::seesRest` and
  `store::SEEN_KINDS` are the same list: `done`, `question` and — since 2026-10-21 — `error`;
  not a card's own news, not a notice parked on a turn. `error` sets it now because the flag
  became chat view's acknowledgement too (below), and setting it changes nothing on the wall:
  `urgencyFor` answers `fail` above `seen`.
- **Spent by the next turn, on both sides at once.** `#beginTurn` clears `restSeen`, and
  `store::set_mid_turn` clears `rest_seen` in the same statement that marks the turn open —
  nobody has to remember to. That is the whole defence against the shape this codebase keeps
  meeting (`interrupted`, `#toldAboutJobs`): a "you have seen this" flag that outlived its rest
  would silence the next one, and a new question would arrive muted.
- **Persisted (schema v50), written by `take_notice`, not by the front end.** A question card
  restored off disk comes back half amber, so a flag held only in memory had you acknowledge
  the same rest once per launch. The write is `WHERE interrupted = 0` — `interrupted` *is* the
  mid-turn mark — so a take landing a moment after the card stirred cannot mark a rest that is
  already over. A follow-up takes too and sets it, and its send opens the turn that clears it.
- **The words stay and say why.** `ending` is what the turn was and is not rewritten, so the
  label keeps it and adds `· seen` in place of the age: `ended on a question · seen`. The age
  goes for `set aside`'s reason — it is the reading being withdrawn. A card on another wall
  carries the flag's consequence as `owed` in its digest (2026-10-21); its tier already
  arrives `rest`.

### And it is the one acknowledgement, in both views (2026-10-21)

Chat view used to place a card by what its notice was *called*: a `done` rest went to
*finished* and two seconds of reading settled it, so a follow-up question `endsOnQuestion` missed
went silent (Lyss: *"'finished' is unreliable"*). Now `rest_seen` decides it: a rest without it
waits in *needs you* whatever it was called (`notice.ts::owesYou`, `chatview.md`), and Lyss
asked that acknowledging on the wall and in chat view be one thing. So the flag gained writers,
all of them gestures or the wall's own knowledge that the move is somebody else's:

- **`rest_ack`** (`store::ack_rest`) — *done with it* in chat view, `space d a` in either view,
  and setting a card aside. It takes down the card's rest notices too, so the dock agrees, and is
  the acknowledgement for a rest that raised none (the one you watched end).
- **`notice::raise` marks a rest it holds** — an armed wake, a working child, a live parent being
  told — and answers `held` rather than `false`, so the front end marks its copy.
- **A turn the CLI answers itself puts back what it found** (`#seenAtOpen`): `/model` sent from
  chat view's menu opens a turn in Rust, and must not un-acknowledge the rest before it.
- **`migrate_v58`** counted every rest standing at the upgrade as acknowledged, except those a
  notice still stood for.

The detector was widened in the same change (`classify.ts::ASK_PHRASE`, and a question with a
short line under it), knowingly trading some precision now that a wrong label costs a dot.

### A reply can carry a picture or a file

The reply box is a `PromptBox`, as every input that speaks to an agent is (`attach.md`, *Any
file, into any input*): a picture or a file goes with the reply as it would with a prompt. A
follow-up to a notice at rest is a prompt, so it goes through `Skein.send` with its turn; one to
a parked notice is a tool result, and goes as `answer_ask`'s blocks. Either way the attachments
are made ready *before* the notice comes down, so a refusal leaves it standing with the reply
still in its box. A reply to a notice on another wall carries them
too (`elsewhere.md`).

### Detecting "ended on a question" was measured, not guessed

848 real turn endings from this machine's transcripts (2026-10-07) were labelled four ways
by Sonnet — needs you / offers more / waiting on its own work / done — and the rules were
tuned on half the sessions and scored on the other half:

| rule | precision | recall |
|---|---|---|
| last line ends in `?` (what it was) | 96% | 28% |
| last paragraph has a `?` | 97% | 34% |
| **last paragraph has a `?` or an ask phrase** (shipped) | 80% | 54% |
| last two paragraphs, `?` or ask phrase | 74% | 66% |

What `?` misses is imperative — *"send me its path"*, *"your call"*, *"say the word"*. The
card's half-amber reads the same function, so the label and the colour cannot disagree. A
Haiku call per end of turn was rejected: up to 23s through the CLI, and a notice must be
snappy. A wrong answer costs only the label, since both kinds carry the text and a reply box.

A first labelling pass with Haiku counted *"I'll look again in two minutes"* as waiting on
the user. It is the card waiting on **itself** — which is the next section's problem, and the
four-way prompt exists to tell the two apart.

### The reader is one component, and a glance is it opened on demand

What Lyss liked about a notice was the reading itself — the closing message as the transcript
renders it, in a scroller with a ceiling — and she wanted it without a notice (2026-10-15):
first beside a question, *"I want it on ask tools and any kind of prompts"*, so what prompted a
question can be read without leaving it for the transcript; then on a card, so a card can be
read *"without changing the card I've actually selected"*. So the reading is `Said.svelte`,
and every surface that shows a card's last message draws through it: the notice, the glance,
and a widget that pins one to the wall. It was the notice's inline markup, and leaving that
behind as a second path would have been two readings free to drift. Its ceiling is
`--said-ceiling`, so a surface with a box of its own can lift it.

**A glance** (`Glance.svelte`) is that reader over the wall, one at a time, opened from a
question's *what it said* (alt+R inside it, `space d r` from the wall), from a card's hover
button, or `space c r` for the focused card. It moves nothing: not the ring, not the
selection — the card's button carries `data-glance`, which `Canvas.groundDown` lets through
for the reason it lets a timeline plate through — and not the panel. Escape closes it and is
swallowed (Escape stops a turn here), and so does a press or a wheel anywhere else, since the
wall moving under it would leave it pointing at nothing. While it is up it takes ctrl+arrow
and ctrl+page from the transcript, because it is what is on top; opened from the keyboard it
takes the focus and hands it back.

**What "the last message" is** is `glance.ts::lastMessage`, one function for both kinds of
card and for the widget: at rest, `lastWords` — the notice's own text, so a glance at a card
with a notice up cannot disagree with the notice; otherwise the last run of prose in `lines`,
which is the prose just before a parked `ask_user` and the current turn's while one runs; and
for a card restored at launch, the same run out of `history`, since `--resume` replays
nothing into `lines` and no `result` this process heard ever set `lastWords`. A card on another
wall has the digest's one line until `history()` pulls its tail, which opening a glance does.

The button exists only where there is something to read and somewhere to read it — the peek
window never `provide`s, so `glance.ready` is false there and no card draws a dead button —
and nothing is parsed until a glance is open: a card face asks `hasSaid`, which stops at the
first line said from the end.

**The store is `glancing.svelte.ts`, not `glance.svelte.ts`**, because this disk folds case:
`./glance.svelte` resolved to `Glance.svelte` and svelte-check refused the pair. Name a rune
module so it differs from its component by more than a capital.

### Holds: a rest is very often not the end of anything

On the same 926 rests, a notice raised the moment a turn ended was one the card cleared
itself within ten minutes **32%** of the time. What was holding:

| rule added | notices | false |
|---|---|---|
| raise immediately | 797 | 32% |
| ignore rests under 5s — a queued message was already waiting (`SETTLE_MS`) | 732 | 30% |
| hold while a background job **under 10 minutes old** still runs (`YOUNG_JOB_MS`) | 609 | 19% |
| hold while a card it opened works, or its settle relay is on the way | 486 | **6%** |

The front end holds the first two (`notice.ts::raiseAt`); Rust holds the rest in
`notice_raise`, plus an armed `wake_me` and a **live parent** — a child's finish goes to the
card that opened it, which already gets `spawn::settling`'s relay, and a second notice for
one piece of work is a double ring. A dormant or closed parent gets no relay, so then it comes
to you. **The age, not the kind, decides a job**: a test run and a dev server are both a
`Bash` with `run_in_background`, and a server never reports, so "hold while anything runs"
would mute that card for good. Two thirds of a card's own wake-ups land inside ten minutes.
A text rule ("I'll check again…") bought one more point and cost four real questions arriving
late, and was declined.

### The `notice` tool

For news that cannot wait for a closing message: *"starting the migration, the app will
restart"*, *"found a big bug, investigating"*. Deferred tier, with one sentence in
`supervisor::append_prompt` naming the *search* — the timeline arrangement, chosen by Lyss so
agents know it exists without it costing every turn, and carrying "sparingly" itself.

`wait: false` writes a row and returns. `wait: true` parks through `ask::park_and_stream`
exactly like a question — the payload is `{ notice: { text } }`, which `skein.svelte.ts`
recognises on `ask:opened` and draws as a notice at the front of the queue, and the card
wears amber (`waitingOnNotice`) since it is genuinely stopped. Acknowledge answers
`NOTICE_ACK`; a follow-up answers the text. It has no deadline (since 2026-10-16, `ask.md`):
away, on a machine nobody is touching, or put off from the dock, it is queued instead
(`notice::Queued`), under its own opening `QUEUED_OPENING`, which
`presence::is_deferral` knows — a third opening rather than "Volery queued your question",
which would be false. A follow-up to one of those then travels as a message naming it; an
acknowledgement sends nothing, and the note it was queued with says so. `CARD_MAX` bounds
a card's own notices at five.

### The chime rings with the window in front

The ladder used to chime only when another app had focus. But the window in front is the
ordinary way to walk away from the desk, and the chime exists so the user need not sit at
it. So a **new** question or notice now rings whatever has focus (`Attention.sync`'s `#rung`
set), while the peek and the flash stay for a window you cannot see. And the chime setting is
remembered (`skein.chime` in localStorage) — it came back off on every launch.

Two exceptions, both in `away.md`. The peek shows only notices raised after you looked away:
a rest you watched happen is seen, even if its notice went up a moment after you left. And an
error notice about an allowance is folded into its account's one row, which neither shows per
card nor rings as a notice.

**What you owe is one reading, `Cards.noticing`.** It leaves an allowance stop out
(`notice.ts::waitsOnYou`) for the dock, its count, chat view's *needs you*, the toasts and the
away pile alike — the pile read the raw queue until 2026-10-19 and so still listed one as owed.
The peek's per-account row above is the one other reader, and it says something else: an account
ran out. `test/notice.test.ts` names every reader of the raw queue and fails a new one.

### The register

One row per notice except `error` (the turn already wrote one with the CLI's sentence). With
notices in place the register is the passive history and the notice is the thing that waits.

### What is not done

- ~~Notices raised by a card on another machine of a flyway~~ — they travel now: the rows ride
  the card's digest and are taken down from another wall over the prompt wire with
  `askId: "notice:<id>"` (`notice::afar`, `answer_starts_nothing`). Nothing in this file's
  detector or holds changed; `elsewhere.md`, *Notices travel too*, has the rest.
- A parked notice, like a parked ask, does not survive a restart; its card's turn dies with
  the process anyway. Rest and card notices are rows and do.

### Closing the card from its notice

A notice offers `close` beside acknowledge (ctrl+shift+W in the reply box, `isCloseKey`), for the
card you have read and are finished with: it was acknowledge, then find the card, then close.
It is the card's own close — the dock calls `do("close")` on the notice's card handle
(`cards.svelte.ts`), so a card that is working or holds a timeline asks first and the notice stays
up behind that question, and a card on another wall is asked of its wall the same way. `replies.closing` is said first so the dock does not read
the notice leaving as swapped from under you; a half-typed reply is kept as "not sent". Not
offered in the away pile (`Vigil`), which has no close wired.
