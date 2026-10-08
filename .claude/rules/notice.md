---
paths:
  - "src-tauri/src/notice.rs"
  - "src/lib/notice.ts"
  - "src/lib/Notice.svelte"
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
"more" steps through `Skein.waitingCards` — asks first, then each card with a notice. Asks
come first because they hold an agent mid-turn on a clock; a notice is a card that already
stopped. The same attention ladder rings for it (peek, taskbar flash, chime, all muted while
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

**No notice for the card you are watching** — selected, panel open, window focused
(`Skein.watching`, set in `App.svelte`). You saw it finish.

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
`NOTICE_ACK`; a follow-up answers the text. Away, or unanswered past its window, it is
queued instead (`notice::Queued`), under its own opening `QUEUED_OPENING`, which
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
