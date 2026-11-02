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

What it is mechanically is Volery's `/clear` (`Skein.clear`) with three differences:

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
3. **Nothing sent in between is lost.** From the tool call until the new process drains its
   inbox, `supervisor::deliver_blocks` asks `renew::holding` and writes every delivery to the
   inbox as a self-row instead — relays, wakes, a child's stop notice, a subscription batch, a
   prompt typed into the card. The note is written into the inbox *first*, at the call, so it
   is drained first. `renew::release` runs in `spawn_now` just before `drain_inbox`. Images in
   a held prompt cannot be held as text and are said to be missing rather than dropped.

**Who performs it is the front end**, exactly as for a clear (`relay.md`, "Rust asks; the
webview spawns"): `renew:asked` marks the card, and `Skein.#renew` runs once the card has been
idle `RENEW_AFTER_MS` (3s) after its turn's `result` — a prompt queued behind the turn is taken
up ~1.5s after the result (`turns.md`), and renewing inside that gap would end the process
holding a message it had just taken. A turn that does start ends with a `result`, which
re-arms the check. A card whose process died first is renewed on `conv:exit`. A window that
reloads mid-renewal re-reads `renewals_pending`.

**A renewal that was scheduled and never performed takes its note back.** If the card is woken
on its *old* session (the front end never ran the renewal), `release` deletes the undelivered
note row before the drain, so the old session is not told it was renewed when it was not; the
held messages still go out.

Guards: a note under `MIN_NOTE` (300 characters) is refused with what a good one holds — it is
the only thing the new session knows; one renewal per card per `MIN_GAP` (an hour); one at a
time.

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
