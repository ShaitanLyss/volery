---
paths:
  - "src-tauri/src/sink.rs"
  - "src/lib/sink.ts"
  - "src/lib/sink.svelte.ts"
  - "src/lib/Basin.svelte"
---

# The sink

Somewhere for a finding to go. An agent doing one thing walks past another — a bug in a file
it only opened to read, a Skein tool that misbehaved on it, a rough edge worth somebody's
afternoon — and it has exactly two honest options, both of which lose it: say it in a
transcript nobody will scroll back through, or act on it now and blow the scope of the job it
was asked to do. The commonest outcome is the third one, which is to say nothing.

Four tools: `sink` reads it, `drop` puts something in, `take` claims one so two cards do not
both do it, `done` takes it down.

### It is the billboard's opposite, and every column follows from that

They look like the same feature and they are not. A notice is about **now** — "I am reworking
the transcript panel, leave `markdown.ts` alone" — so it is worthless the moment that stops
being true, and every mechanism in `board.rs` is about taking one down. An item here is a
finding, and its whole value is that it **survives**: the turn that found it, the card that
found it, and the session both were in.

So the differences are not accidents of implementation:

| | a notice | an item |
|---|---|---|
| when its author's card closes | deleted (`sweep_notices`) | kept; only the *hold* is released |
| staleness | marked, never removed | a **hold** expires and gives way |
| reaches out on a file write | yes (`on_touch`) | never — it is read when asked for |
| who may take it down | its author, or you | anyone who dealt with it, or you |
| lives as long as | the work it describes | until somebody settles it |

**`from_id` is provenance and nothing more.** No foreign key, no cascade, no sweep. The card
that found a thing going away says nothing at all about whether the thing is still true, and
a table built to not lose findings must not lose them to a card being closed. This is the
first table on the wall that deliberately outlives its writer; `store.rs::migrate_v18` is
where that is argued in full.

### The hold, and why it expires when a notice does not

Both go stale. Only one gives way, and the asymmetry is the point.

`board::STALE_AFTER_MS` *marks* a notice at ninety minutes and never removes it, because a
long refactor is a real thing and deleting a true notice is worse than showing an old one. A
hold cannot work that way, because while it stands **the item is blocked**: the cost of
keeping a dead hold is not a stale paragraph, it is work nobody can pick up, forever, on the
word of a card that wandered off two days ago.

So `sink::HOLD_STALE_MS` is load-bearing rather than advisory — and, for exactly the same
reason, generous. Two hours against the board's ninety minutes, because expiring a hold
somebody is still honouring costs two agents doing one job and finding out in the diff. The
number is deliberately not the board's; a shared constant would be two different arguments
resolved by one accident.

Clearing, in descending order of how much it can be relied on — the same ladder the billboard
walks, one rung shorter, because nothing here needs deleting:

1. **A card that closes or is cleared lets go of what it held.** `sink::release_for`, called
   from both places in `store.rs` where `board::clear_for` is. The only one that needs nobody
   to remember anything.
2. **`sweep_sink_holds` on every read**, as the backstop for a crash between the two.
3. **The hold expires**, and a lapsed hold is drawn amber and reads as free.
4. **You can prise one off** from the widget, for when you can see sooner than the clock can.

### A hold is a claim, so it cannot be a read-then-write

`store::hold_sink_item` takes the holder the caller *read* and only lands if that is still
what the row says. Two cards reading the same free item in the same instant and both claiming
it is the one race a hold exists to prevent, and a read-then-write would hand one item to two
agents — which is worse than having no hold at all, because both of them have been told they
are safe. `one_item_cannot_be_held_by_two_cards` is the guard.

### Merging on the title, and why it must be loud

A box every card may write to freely collects the same observation once per card that meets
it. "`ask_user` timed out on me" is a true thing five agents will each independently want to
report, and fifteen near-identical rows is a sink nobody reads, which is a sink that may as
well not exist.

But deduplicating by dropping the later ones throws away the one fact those fifteen rows
carried that one row does not: **that it keeps happening, to everybody.** So a merge counts
(`voices`), keeps the new words if they are new, and says in the receipt that this is what
happened — an agent that believed it had raised a fresh thing when it had seconded an old one
would go on to describe the sink wrongly to the user.

Matched case-insensitively on the whole title within one scope, and no cleverer than that on
purpose: a fuzzy match that folded two genuinely different findings together would lose the
second one entirely, where the cost of missing a match is merely the duplicate this was
avoiding. A **settled** item does not absorb the thing happening again, because it happening
again is news.

### `done` keeps the row

Settling is `settled_at`, not a `DELETE`. An agent that decides a thing is handled and is
wrong about it has not destroyed the only record that it was ever raised, and the widget's
`put it back` is the other half of that. The user's own `throw away` is the only gesture in
this subsystem that loses a record, and it is the only one no agent can reach.

**Somebody else's live hold makes `done` a refusal rather than a warning.** `done` on an item
another card is in the middle of is either two agents on one job — in which case the news the
user needs is the collision, not the tick — or an agent settling work it did not do. Both are
worse than being told no. A hold that has gone stale is not a hold, so that case falls
through.

### The caps, and what they are each protecting

- `MAX_OPEN_PER_CARD` (12) — higher than the board's four, because findings accumulate
  honestly over a long session where notices do not. It stops a card that has started
  narrating its every thought into the sink while the box is still readable.
- `MAX_HELD` (3) — an agent doing three things at once is doing none of them, and every item
  it holds is one no other card will touch.

Both refuse rather than rotate, for `board::MAX_PER_CARD`'s reason: an agent whose oldest item
was silently dropped would go on believing it had been written down.

### Nothing here is assigned

`sink` says so, twice. An agent reads the pile because you asked it to, or because it is
about to work somewhere the pile has an opinion about — and then it may `take` something. A
box that handed out work would be a scheduler, and this wall already has one of those.

That is also why there is no `on_touch`. A notice is about work in flight and arriving late
makes it useless, which earns the interruption. An item has no deadline and no claim on
anybody's attention, and interrupting a card mid-task with "by the way, somebody once thought
this file was untidy" would teach the wall's agents that Skein's own messages can be skimmed —
which would cost the billboard the one thing that makes it work.

### Chat cards are allowed in, unlike everywhere else

`relay` and `board` both refuse a chat card: it stands outside the wall's projects and cannot
reach this machine, so it has nothing to say about either. The sink takes one anyway, and its
items go **wall-wide** rather than to the `chat` territory — filing a finding under Skein's own
data folder would put it somewhere nobody will ever look. The reason to make the exception at
all: a chat card's one capability is `ask_user`, which makes it the card most likely to meet an
`ask_user` fault worth reporting, and refusing it would lose exactly the reports this exists to
collect.

### The face

`Basin.svelte` — named for the basin because this filesystem is case-insensitive and
`Sink.svelte` beside `sink.svelte.ts` is the *same file*. `Billboard.svelte` beside
`board.svelte.ts` is the same dodge; `meter.svelte.ts` beside `Perf.svelte` is the same lesson
learned from the other end.

- **Oldest first**, against the grain of every other face on the wall. A transcript, a board
  and an inbox are all newest-first because you are catching up; a pile of things nobody has
  done is read to find what has been ignored longest, and newest-first buries precisely the
  item the pile exists to keep in front of you. `reading` in `sink.ts` owns it and is tested.
- **Waiting, then lapsed, then held.** Held last because it is the group with nothing for you
  to decide. Lapsed above it because a hold nobody honoured is a thing that *looks* handled and
  is not.
- **Two colours, both the wall's own.** Celadon for an item a conversation is alive on; amber
  for a lapsed hold, which is exactly the wall's "nothing is broken but somebody should look".
  Waiting is achromatic, because waiting is not a status. A `kind` is a filing decision rather
  than a state and gets a monochrome glyph.
- **Every verb is here**, unlike the read-only pipelines and reviews faces and unlike the
  billboard's two. What this widget lists is a set of decisions only you can make: settle a
  thing an agent fixed and forgot to close, put back one it closed too eagerly, prise a hold
  off a card that has plainly moved on, throw away the note that was never worth keeping.
- **The `next` reading is one item, opened out** — not a skin on the pile. A list answers
  "what does this wall owe"; one thing in front of you answers "what should I do about it
  now". It draws the head of the same ordering, so the two variants cannot disagree about
  which item is next, and it says how many are behind it.
- **The settled list is a toggle, not a second widget**, and not a config knob either: "has
  anybody already dealt with this" is a glance you take and put back, where a persisted knob
  would have you launch into a wall showing history.

### `drop` is the one tool with a sentence in the system prompt

Every other tool on this server is left to its own description, which is the argument
`ask::mcp_config` makes for `alwaysLoad` and the reason `append_prompt` is short. `drop` gets a
sentence anyway, and the asymmetry is the point: **a description is only read by an agent that
has thought to look for a tool**, and the reflex this fights is not thinking there is anything
to do. An observation made in passing has a default, and the default is silence — no schema
reaches that, however well it is written.

### A body is capped once, in the store, and the cap says so

`.claude/rules/clipping.md` has the whole of this and it governs seven files; what matters
here is the number and where it is enforced.

**`store::MAX_SINK_BODY` (4,000) is the only cap on a body.** `sink.rs` used to clip to 1,200
before the text ever reached the store, which had its own 4,000 for the same field — two
numbers on one field, 3.3x apart, and the tighter one silently won. Sixteen open items were
measured sitting exactly on it, every one ending mid-sentence, one cut mid-word inside the
sentence explaining its own cause (sink `7b26058e`). It went on costing tails while it stood:
a card filing the office-documents item lost two follow-ups to it and had to re-drop them as
`43da0038` and `be344594`.

The argument that retired it is `spawn::MAX_PROMPT`'s, and it is worth restating because it
applies to anything an agent hands this server: **the body arrives as MCP `tools/call`
arguments, so it was written inside the calling agent's own output budget and is already paid
for by the time `do_drop` sees it.** Clipping saved nothing at write time and discarded only
the half the author believed they had filed. An item is the *archive* — the thing that
outlives the card that wrote it — which makes it the worst place on the wall to lose a tail.

Three things follow, and each was wrong before:

- **The store enforces it on both write paths.** `put_sink_item` capped merges only, so a
  fresh drop of fifty thousand characters was stored whole while a *second voice* on a short
  item was guillotined — cutting the newest words, the only part nobody had read yet.
- **A title is capped (120) and announced.** A title is the item's name: `resolve` matches it
  and `put_sink_item` merges on it, so shortening one silently alters an identity key behind
  the caller's back. `clipped_note` puts the overflow in the receipt and asks them to check it
  still reads as they meant. Note this was **not** the cause of the twin items seen on
  2026-09-03 — that is `23f5f762`, a scope mismatch between what `drop` merges on and what
  `sink` reads, and it is still open.
- **`sink.ts` mirrors the store's number** so the field in the Basin stops where the write
  does. A mirror of a cap that no longer exists stopped you a third of the way into what the
  write would have accepted.

### What is not built yet

- The control surface has no `sink` op. `sink_tool` is the seam for one — deliberately a
  single command taking the tool's own name and arguments, rather than the four typed wrappers
  `board` grew, because what a test wants is to make the call an agent would make.
