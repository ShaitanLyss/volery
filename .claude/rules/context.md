---
paths:
  - "src-tauri/src/compact.rs"
  - "src-tauri/src/renew.rs"
  - "src/lib/renewing.ts"
---

# A card's context is its price, and what a card can do about it

Every request a card makes — each tool call, not only each turn — re-reads its whole
conversation, and on this wall that re-reading is most of the bill. Sink `ef384c69` measured a
day of Opus spend at 85% cache reads and writes against 15% output. The RISE coordinator
(sink `71803a3b`) was one session for 22 days: 2,886 requests at a median of 493k tokens, 64%
of its ~220M base-input units spent re-reading itself and 31% rewriting that context cold after
overnight and allowance stalls (66 cold requests, 45 after a gap over an hour). Its average
request cost ~76k units against ~33k for a child. Output was 5%.

So a card's context size **is** its per-request price, and until this file nothing said so to
the card, and only a percentage said it to Lyss. Three pieces, built 2026-11-02 under Lyss's
go-ahead (through 12fa2a91) on sinks `859c486d`, `ef384c69` and `71803a3b`.

## The reading, folded in Rust (`compact.rs`)

- **The last top-level `assistant` message's usage**, input + cache read + cache creation +
  output — the same arithmetic as `conversation.svelte.ts`'s `ctxTokens`, output included
  because the last answer is in the next request's input. **Never `result.usage`**: it sums
  every iteration of a turn (CLAUDE.md's first load-bearing mistake), and
  `a_result_is_never_the_reading` holds that.
- Skips a subagent's forwarded message (`parent_tool_use_id` — its context, not this card's)
  and the CLI's `<synthetic>` messages (all-zero usage). A `compact_boundary`'s `post_tokens`
  is the reading the moment a compaction lands, since a compaction makes no assistant message.
- One call in the supervisor's stdout reader thread (`compact::fold`), into process memory. Not
  a column: re-established by the first answer after any spawn, and only ever asked by a card
  that is mid-turn and has therefore just produced one.

## Said to the card: `allowance`'s last line

`allowance` ends with `compact::context_line` — the absolute size, said as what every request
re-reads. **A number, never a ratio.** The ratio needs the window, the window needs the
model-tier inference CLAUDE.md records being got wrong twice, and "31%" is exactly the reading
that makes an expensive card look healthy. Above `FLOOR_TOKENS` it names `compact` in full and
says when **not** to reach for it (mid-work whose detail is still in use), and for a card with
children open (`store::live_children_of`) it names `renew` as well. No byte was added to the
loaded tier: the description of `allowance` is unchanged and both tools are deferred, found by
their hints and named by this answer — `servers`' argument for `server_log` (`ask.md`).

## `compact`: Claude Code's own `/compact`, queued behind the turn

- **Exactly `/compact`** (`COMPACT_PROMPT`), through `supervisor::deliver`. Probed 2026-09-15
  against claude 2.1.266: a resumed `--print` session intercepts it as the slash command and
  writes a real `isCompactSummary`. Anything prepended turns it back into a sentence the model
  answers conversationally — and MSYS's path conversion is the trap that taught that (a Git
  Bash probe sent `C:/Program Files/Git/compact`).
- **It does not happen during the call.** The caller is mid-turn, so the CLI queues the prompt
  behind the running turn; the receipt says so and tells the agent to end the turn with what
  must survive written down, since the summary keeps the gist.
- **Refused below 60k** (`FLOOR_TOKENS`) and more than once in twenty minutes (`MIN_GAP`),
  counted on delivery — a card in a loop would otherwise queue compactions of its own summary.
  The user explicitly rejected `--autocompact`: when to compact stays a judgement, the card's
  or hers.

## `renew`: the same card on a fresh session, from a note it writes (`renew.rs`)

The first design was a *rotation*: a new card adopting the old one's children, subscriptions
and wakes. **Lyss changed it to a renewal** (2026-11-02, through 12fa2a91), and the reason is
the whole design: everything the wall keys on a coordinator is keyed on its **card id** — the
`spawned` rows and the handle its children `send` to (including from another wall, which this
wall cannot re-point), `subscription.conversation_id` and its ledger, `wake`, `notice.from_id`,
`timeline.owner_id`, its place and its name. A renewed card moves none of it because none of it
has to move. Lyss also chose (same day) that the renewed card **keeps its title**, and that the
wall shows a **quiet mark** rather than prompting the card on its own.

What it is mechanically is Volery's `/clear` (`Skein.clear`) with three differences — and, since the 0.94 review,
Rust performs it rather than the front end.

1. **It keeps what a clear lets go of.** `store::clear_conversation` drops the card's notices,
   wakes, subscriptions, queued questions and live timeline, on the argument that a reset card
   is no longer doing that work. A renewed card is, so `renew_conversation` repoints the
   session and keeps all five, and the title (`renew_row`). It still drops lent credentials
   (the person agreed for what *that* conversation said it needed) and parked delete hand-offs.
2. **The new session opens on the card's own note**, with the wall's facts appended by
   `say_facts`: live children by handle with state and the first line of their last report to
   it, far children (`flyway_child`), subscriptions, wakes, its notices, queued questions, its
   live timeline, and the path of the transcript it is leaving (grep it, do not read it whole).
   Under `RELAY_MARK` as `[skein relay] renewed —`, because `relay.md` asks any new unbidden
   prompt to be *a shape under the mark*; `relay.ts::isRenewPrompt` reads it and
   `Thread.svelte` draws a divider over it in both rooms — a session boundary, never a letter.
3. **What is sent in between is kept behind the note.** The note is written into the inbox
   at the call, first, with `chain = renew:<the session it leaves>` (`NOTE_CHAIN`); the
   inbox orders by time *then rowid*, so a row written in the same millisecond still follows
   it. While the renewal is **scheduled and the old process is alive** (`renew::holds`), the
   old process is kept from everything: the wall's own post — wakes, stop notices, board
   notes, subscription batches, a typed prompt — is held as a self-row by
   `supervisor::deliver_blocks`, and a relay (`do_send`, `deliver_from_afar`) is queued with
   its own sender, chain and hops and receipted *kept for … after its own note*, arming
   nothing. Images in a held prompt cannot be held as text and are said to be missing.
   **Only then.** Once performed, or once the old process has died, the card is an ordinary
   dormant card and its post takes the ordinary path — queued, and a `relay:wake` for a
   directed message, whose spawn performs or finishes the renewal. Holding past that point
   (the first build) answered every sender "delivered" for a card nothing was going to wake.

**Rust performs it; the front end spawns** (`relay.md`, "Rust asks; the webview spawns"). The
first build had the front end decide everything, `clear`'s way, and the 0.94 review found the
gap between its awaits was the whole bug surface. Now:

- `renew:asked` puts the card in `Skein.#renewals`; `#renew` runs once it has been idle
  `RENEW_AFTER_MS` (3s) after its turn's `result` — a prompt queued behind the turn is taken
  up ~1.5s after it (`turns.md`), and renewing inside that gap would end the process holding
  a message it had just taken. A card whose process died first is renewed on `conv:exit`.
- **`renew_conversation` decides whether there is a process** — never the front end's
  `dormant`, which after a reload reads true for every restored card, live or not (the
  review's blocker: the old process left running on a repointed row, deaf). It stops the
  process under the supervisor's lock *unless a turn is open* (`busy:`, asked again after the
  turn), then holds the card's **spawn claim** across the repoint
  (`supervisor::claimed_for`), so nothing can be spawned on the old session in between; it
  answers the new session and whether it stopped anything. The front end takes the session
  **at once**, before any further await — a throw after the repoint used to leave it spawning
  the session Rust had just refused, until a reload. It then waits for the stopped process's
  exit **by count** (`Conversation.exitCount`), not by `dormant`, which a reloaded wall reads
  true already; an exit still unheard after four seconds is swallowed when it comes
  (`swallowExit`), or the old process's late exit would put the new one to sleep.
- **A closed card is never renewed.** `here()` is asked before every spawn in
  `#performRenewal`, and `renew_row` repoints only a row with no `closed_at`: a parent
  closing a child that had just renewed would otherwise have spawned an agent for a card on
  no wall, with nothing left that could stop it (the review round's blocker).
- **A clear ends a renewal.** `Skein.clear` waits out one being performed and unschedules
  it; `store::clear_conversation` calls `renew::cleared`, which forgets it and deletes every
  undelivered note, whichever session it names — after a clear the card is on neither, so
  `release` could not tell, and the cleared session would have opened as though renewed.
- **The whole renewal runs inside the card's spawn single-flight** (`#waking`). A stir, a
  relay wake, a send or a click meanwhile waits for it and gets its answer, and `#spawn` on a
  dormant card with a renewal scheduled performs the renewal instead of waking it. The second
  blocker the review found was exactly that spawn, landing with the old `sessionId` still on
  the card: the old conversation resumed whole and was told it was fresh, and the note was
  spent — the 2026-10-01 `/clear` bug (`restore.md`) back. `renew::spawn_blocks` is the Rust
  backstop: a spawn during the repoint, or on the old session after it, is refused.
- **Something that would be lost gives the renewal up**, rather than holding the card's post
  while it runs. A background job (a `job` row for the current session, while the process
  lives — refused at the call too, while there is still a turn to act on it) or anything the
  front end alone sees: jobs it has folded, the CLI's own `CronCreate` / `ScheduleWakeup`
  **not yet fired** (`renewing.ts::renewBlocker`, `scheduleAhead`). Not `scheduled`, the
  reaper's reading, which carries fifteen minutes of slack on purpose and so refused a renewal
  for a quarter of an hour after a `ScheduleWakeup` had already woken the card — exactly the
  loop a coordinator renews in. Rust then turns the note into
  `not_performed`, drains what was held into the live process behind it, and emits
  `renew:dropped`.
- **Every way a renewal ends takes the id out of `#renewals`** (`#unschedule`), and Rust's
  `not-scheduled:` is one of them. An id left behind was a card killed three seconds after
  every later turn.
- A reload re-reads `renewals_pending`, which now also lists a renewal *performed* and not yet
  spawned; `renew_conversation` answers that one with the session it already gave.

**A renewal that was never performed is said, not left to be inferred.** `renew::release`
runs in `spawn_now` before the drain and rewrites every undelivered note whose chain names
the card's *current* session into `not_performed` — "the renewal was not performed …, this is
still the same session, call `renew` again if you still want it". One `UPDATE`, read off the
row alone, so it holds after a crash or a quit, when the in-memory `PENDING` is gone (finding
3: the note row is durable and the schedule was not). A spawn on the old session while
`PENDING` still had it emits `renew:dropped` too.

Guards: a note under `MIN_NOTE` (300 characters) is refused with what a good one holds — it is
the only thing the new session knows; one renewal per card per `MIN_GAP` (an hour), **charged
when performed** (`release`), not when asked; one at a time; `compact` is refused while one is
scheduled (it would compact the fresh session's note); a flyway move is refused while one is in
flight; a card closed forgets its renewal. The note's turn is **not armed** in the relay at
all: armed from itself, `spawn::is_reply` read the renewed child's first turn as a reply and
withheld its stop from its parent; armed at all, its chain (a marker, not a conversation) made
the renewed coordinator's first broadcast read as one made while acting on another card's
message, and was refused.

**Driven in a lab on 2026-11-02** (`bun run lab renew --frozen`, `renew` called through the
card's own `/mcp/<id>` route, the webview reloaded over CDP): reloaded mid-renewal, the card
came back with one process, on the new session, whose transcript opens on the note, and a
relay sent after it landed there and not in the old one; a relay to a card dormant with a
renewal scheduled performed the renewal, and the new session read the note and then the relay,
the old session neither; a background job started after the call gave the renewal up, the card
kept its session and process and read why, and a second call was refused while the job row
stood; a card closed at any moment across the renewal timer left no process behind.

## Said to Lyss: the price on the card, and the mark

- **The ring's hover is the price** in both rooms: `chatview.ts::ctxSaid` reads
  *memory 48% full · every request re-reads 480k tokens* (`renewing.ts::rereads`) on the
  card, the chat header and the sidebar. Tokens, not dollars: the wall mostly runs on
  subscriptions, where the allowance is spent in tokens.
- **The mark** (`↻` beside the ring, achromatic): a card with children open under it
  (`Canvas.childCount`, the same `lineage` pairs the roots are drawn from, so a far card's
  children count too) past `RENEW_MARK_FROM` (300k). Its hover says the price and how to renew.
  A big card with no children is a long piece of work, not a coordinator; `compact` is its remedy.
- **The gesture is a verb, `renew`** (`handle.ts`, cost `work`), so it is on the card's menu
  (*renew it — fresh session, carries on*), on `space c n`, and crosses to a card on another
  wall as an `act` (`flyway/act.rs`) that wall performs with its own `Skein.askRenew`. What it
  does is send the card `RENEW_ASK` as Lyss's prompt: only the card knows what it decided, so
  only the card can write the note.

## Not built

- A card renewed on another wall shows its divider there; the shadow here reads it through the
  tail like any line, but the far wall's `Facts::can` must announce `act:renew` before the menu
  offers it — an older far wall is told *needs updating*, as for every act.
- The image blocks of a prompt typed into a renewing card are not held (text only).
