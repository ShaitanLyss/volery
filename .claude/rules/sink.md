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

### The scope the merge uses and the scope the read uses are not the same one

`sink` at `scope: project` serves "this project's items plus the wall-wide ones" — a union,
and `sink_open` is indexed on `(project_id, settled_at)` to serve exactly that.
`put_sink_item` merges within **one** `project_id` only, matching `title_taken`'s rule and its
argument: two items with one title in two different projects are two findings about two
repositories and always were.

So an agent that read a wall-wide item in project scope, agreed with it, and dropped under the
same title did not second it. It filed a project twin, and was told "dropped into the project
sink as […] — nobody is assigned to it", with exactly the confidence of a fresh finding. That
is `voices` losing the one count it exists to keep. Filed as sink `23f5f762`; measured in
`skein.db` on 2026-09-10 as **six** title pairs split across the two scopes, not the three
originally reported — one of them a *settled* wall-wide item whose project twin is still open,
which is the same hole read from the other end.

**The sixth is the cause in one line.** Card `6ff8e41c` made it that same afternoon by copying
a title byte-for-byte out of `sink`'s own listing in order to second `b6bfecba`, and got
`71a15dfd`. The listing did not say which scope a row came from, so the title copied out of it
was not the address the copier thought it was — and there is no amount of care an agent can
take that fixes that, because the information was not in front of it.

Three shapes were on the table for closing the merge rule itself, and none of them is what
was built:

1. **Merge across the union**, so the merge follows the read. Cheapest at the call site and
   the most invasive semantically: it retires `title_taken`'s argument, and it lets a
   wall-wide item swallow a project finding that only happens to share a form of words.
2. **Narrow the read**, so `sink` at project scope stops showing wall-wide items. Restores the
   invariant by making the two piles genuinely separate, at the cost of the thing the union
   was for: a card working in one project can no longer see what the studio knows.
3. **Say which scope was searched** and leave both rules alone. Built in `ee16945`; it does
   not stop the twin, it makes it visible in the receipt at the moment it is made.

What was chosen instead is cheaper than all three and addresses the cause rather than the
merge: **put the scope on every row of the listing, and have `drop` look across the one
other scope before it creates.** Neither rule moves. `title_taken` keeps its argument
verbatim, `put_sink_item` still merges within one `project_id`, and two projects may still
hold same-titled items.

**Every row of a listing says which scope it is filed under.** `scope_tag`, immediately after
the id: `WALL` for a wall-wide item, otherwise the project's name.

    - [b6bfecba] WALL · bug — Cards can't see mcp__browser__* …
    - [d02d17ca] skein · chore — conversation.svelte.ts holds two raw NUL bytes …

Three things about those eight characters, all of them arguable and all of them decided:

- **It is the same vocabulary as the receipts, one register down.** `scope_name` spells a
  territory as prose (`filed under the nova project`) and `scope_tag` as a column, and both
  come off one `Filed` match so a fourth reading cannot be added to one and forgotten in the
  other. An agent that reads a row and then reads a receipt is being told the same thing
  twice, not two things that happen to agree.
- **The wall shouts.** A project read holds exactly two kinds of row and the difference
  between them is the entire point, so it has to survive being skimmed — `WALL` against a
  lowercase project name does that where `wall` against `skein` does not. This is the one
  place in the codebase where the house's lowercase register is deliberately not applied: a
  listing is a tool result read by a model, not prose on the wall, and what it owes is
  legibility.
- **One word is the budget.** Every row of every read pays for it and a full sink already
  overflows a tool result, so the column is a word and never a sentence.

**And `drop` says what the mark means**, in its own description, because a convention an agent
has to infer off a listing is one that gets inferred wrong — which is the whole of the sixth
twin. It says that a title addresses an item only together with its scope, that seconding a
`WALL` row takes `scope: "skein"`, and that the mismatch is refused rather than done quietly.
Asserted in `drop_says_what_seconding_a_wall_wide_item_takes`, since a tool description is
prose and prose gets tidied.

### `drop` refuses a cross-scope twin rather than warning about one

Belt and braces for the card that does not read the column. Before creating, `do_drop` asks
`store::sink_titled` whether an **open** item with this title is sitting in the *other* scope
— wall-wide when the drop is landing in a project, this project when the drop is wall-wide —
and if one is, nothing is written and `twin_refusal` names its id, says where it is filed, and
gives the one argument that seconds it.

Three bounds on that question, and each of them is what keeps `title_taken`'s argument intact:

- **Only the one pair of scopes the union puts in front of a reader.** A third project's
  identically-titled item is not consulted and never was. Two repositories, two findings.
- **Only when this scope has nothing of its own to merge with**, so a real merge still wins.
  The question being asked is what to do when there is nothing to merge with *here* and
  something one scope over.
- **Only open items.** A settled item does not hold its title against a fresh drop, here for
  the same reason it does not absorb one: it happening again is news.

**Why it refuses rather than warns**, which was the live question:

- **A warning cannot be acted on.** By the time an agent reads one, the twin exists. Undoing
  it takes a `done` on the row that was just made plus a re-drop with the right scope — three
  calls, and a `voices` count that is wrong in the meantime if the agent does not make them.
  A warning that creates anyway is the bug this closes, with better manners.
- **A refusal costs one gesture and loses nothing**, which is `title_taken`'s own sentence
  applied one door along. The refusal names the id, so seconding is one call and rewording is
  one call; nothing has to be undone first because nothing happened.
- **The false positive is cheap and rare.** It fires only on a title specific enough to be a
  sink title — `drop`'s own description asks for "specific enough to act on months later" —
  colliding across exactly the wall/project pair while being a genuinely different finding.
  When it does fire, the answer is a title that says how the two differ, which the sink wanted
  anyway: a pile where one title answers to two items is a pile nothing can be addressed in.
- **It is the third door in this subsystem to make the same choice**, after `title_taken` and
  `Pick::Several`. One subsystem answering "the address is ambiguous" three different ways
  would be worse than any one of the three answers.

What it does **not** do is offer a way through. There is no `force` argument, deliberately: a
second item under one title is the state the whole invariant exists to prevent, and an
argument that reinstates it would be reached for exactly when an agent is in a hurry.

### The six twins, and what merging them actually took

Merging them was the third part of closing `23f5f762`, and five of the six needed nothing —
worth recording, because the shape of the repair is not the shape the item was filed in.

Every twin had already been reconciled *by hand* by the card that made it: each one's
`settled_note` names its original and says where the content went (`57af2599` → "Its content
is now on d3a1921a"; `c7c9b449` → "now on 14f2543e"; `71a15dfd` → "settled with b6bfecba").
So the words were never lost. What was lost was `voices`, and by the time this was picked up
that count could no longer be repaired through the tools:

- **Four pairs are settled on both sides** (`28cb1c5d`/`1c92deeb`, `d0aae1a0`/`988af305`,
  `b6bfecba`/`71a15dfd`, and `14f2543e`/`c7c9b449` where the original is open but already
  carries the twin's correction). A settled item does not absorb a merge, so a drop under
  either title would have created a **third** row rather than joining two — strictly worse
  than the twin. And two of them are already at `voices: 2` from the hand reconciliation.
- **`d3a1921a`/`57af2599`** is the same: the original is open and its body already carries the
  twin's two findings, reworded. `put_sink_item` matches on `!old_body.contains(body)`, which
  is true of a rewording — so a merge would have appended a near-duplicate of text already
  there and, in the sibling pair, overflowed `MAX_SINK_BODY` by 806 characters to do it.
- **`7b661546`/`d0b14c6b`** was the one real repair, and it is the one the item names as the
  worst case: a *settled* wall-wide original with an *open* project twin. The twin held the
  whole write-up of work that landed on 2026-09-03 and was never taken down, because `done`
  was called on the wall row instead. Settled, naming `7b661546`.

Two rules fall out of that, and they are why this is here rather than in a commit message:

- **A merge cannot repair a twin once either side is settled.** The window for fixing one by
  merging is while both are open, which is a window measured in the hours before somebody
  tidies up. That is the argument for refusing at `drop` rather than reconciling afterwards:
  afterwards does not stay available.
- **`voices` cannot be repaired at all.** It is a count of conversations that met a thing, and
  a card merging on their behalf a week later cannot honestly increment it — `put_sink_item`
  would attribute the voice to the card doing the tidying, since that is whose `from_id` it
  has. So the count the item exists to protect is the one thing a twin destroys permanently,
  which is the whole of why the refusal is worth a round trip.

### A receipt names the row, not the title

The half of `23f5f762` that had to be fixed whatever happens to the merge rule, and the more
dangerous half.

`take` and `done` resolve across the whole wall and accept a **title** as well as an id — and
a title is unique only within a scope, so once a twin exists two open items answer to one
string. Settling the two twins from the session that found this, `done` was passed the eight
character ids, did the right thing, and its receipt named only the title. From the tool result
alone there was no way to tell which of two identically-titled items had been taken out of the
pile; it had to be checked against `skein.db` afterwards. **Had it resolved the other way it
would have settled the originals — both wall-wide, both carrying the whole design write-up —
and reported success in words indistinguishable from the correct outcome.**

That is the shape worth carrying past this subsystem: **an operation addressed by an
ambiguous key, whose receipt echoes the key rather than the row, is unverifiable from its own
output.** Not merely untidy — unverifiable, and in the direction that reads as success.

Two changes, and they are the two halves of one answer:

- **Every receipt echoes the id and the scope of the row it actually touched.** `[57af2599]
  … filed wall-wide` rather than the title alone, on the successes and on the refusals both,
  since a refusal that does not say *which* row it refused has the same hole. `scope_name` is
  the pure half — wall-wide, under this project, under the *named* project — and it names a
  third territory rather than saying "this project", because `take` and `done` read the whole
  wall and the row they touched may well be filed somewhere this card is not standing.
- **`resolve` refuses an ambiguous address rather than guessing.** `Pick::Several` names both
  ids with their scopes and touches nothing. This is `relay::resolve`'s shape, which has
  refused two cards under one title since it was written, and it is `title_taken`'s argument
  applied one door along: being told which item holds the title costs you one gesture and
  loses nothing. Note the same exposure on the id rung — four characters of a uuid is a
  prefix, not a name — so that rung collects too.

The refusal is what made the cause fixable calmly rather than urgently: a twin became a thing
an agent is *told about*, at the moment it tries to act on one, instead of a coin flip it
cannot see. The two sections above are the cause itself, closed a week's worth of cards later.

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

### `tools/lift-sink.ts`, and the assertion the typecheck could not check

There is no MSVC toolchain here, so `sink.rs`'s `mod tests` typechecks and cannot run — and a
green `check-gnu.sh --tests` reads exactly like a green test run. `tools/lift-sink.ts` lifts
the pure half into a single-file `rustc --test` crate and executes it: 31 assertions, and the
whole point is that nearly all of them are *strings*, which is the least testable-looking and
most load-bearing thing in the file. The row an agent copies a title out of, and the sentences
it is refused with, are the entire guard.

Judged not worth writing on 2026-09-10 and then written the same day, which is worth recording
because the reasoning changed rather than the conclusion being wrong. The objection was that
the assertions carry `crate::` references the lift pattern could not resolve; what they
actually carry is `crate::store::SinkItem` (derive-only, sixteen plain fields),
`crate::relay::handle_of` (one line), and `crate::store::projects` inside `Scopes::read` — the
impure half, whose two pure readings lift on their own and re-wrap in an `impl` without it.
The shared string-aware brace counter in `tools/lift-scan.ts` (4dfc013) is what made the
extraction cheap enough to bother.

It earned itself on the first run. `drop_says_what_seconding_a_wall_wide_item_takes` was
written `assert!(d.contains(r#"`scope: \"skein\"`"#))` — backslashes are literal inside a raw
string, so it could never match, and its sibling was a *negative* assertion of the same
malformed needle and therefore passed. A typecheck cannot see either. **An assertion nobody
runs is not weaker than a test, it is a claim in the codebase that nothing is checking**, and
the negative one was a false green.

### What is not built yet

- The control surface has no `sink` op. `sink_tool` is the seam for one — deliberately a
  single command taking the tool's own name and arguments, rather than the four typed wrappers
  `board` grew, because what a test wants is to make the call an agent would make.
