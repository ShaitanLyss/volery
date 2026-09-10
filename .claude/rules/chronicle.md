---
paths:
  - "src/lib/chronicle.ts"
  - "src/lib/chronicle.svelte.ts"
  - "src/lib/Register.svelte"
  - "src-tauri/src/chronicle.rs"
---

# The chronicle, and the wisp that says so

What happened on this wall, kept — so that a wall of ten cards is not ten transcripts you
open one at a time to find out how the afternoon went, and so that coming back after an hour
is a thing you can *read* rather than reconstruct.

One record, read two ways, and the whole design is in that sentence.

- A **wisp** is an entry in its first few seconds. It is drawn at the edge of the card that
  wrote it, in wall space, and drifts to the register.
- A **row** in the register is the same entry afterwards, forever.

Nothing here appears and then vanishes. That is not a detail — it is the reason there is no
dismissal gesture anywhere in this subsystem, and no "did I miss one". Things scroll off; they
are not dismissed. A toast you failed to read is gone, and every toast system then grows a
history panel to apologise for it. This starts from the history and lets the newest rows
briefly stand up off the wall instead.

## Why the geometry rather than a label

Because you never read *"card X said Y"* — you watch it leave card X.

The wall is already the thing that says which conversation is which: territories, positions,
the card you dragged over there because it is the one you care about. A notification drawn in
that space inherits all of it for free, where a notification in a corner has to spend a line
of text re-establishing what the wall already showed. This is the same argument
`layout.md` makes for territories and `flow.md` makes for drawing a relay as a braided light
between two cards: **the wall's geometry is a channel, and re-encoding it as prose is paying
twice.**

The costs are real and they are the ones to watch when changing this:

- A card off the viewport cannot be flown from. `Canvas` draws an edge indicator instead,
  coloured by status and counting what is out there.
- A wall zoomed out to `far` has cards too small to be a source. The wisp is drawn at the
  card's box whatever the density, which is legible because `CARD_W` is fixed at every LOD
  (see `layout.md`) — but below a floor it is the register's own highlight that carries it.
- Volery's own wall-level entries have no source card at all — the allowance running down
  belongs to no position. Those do not fly; they land in the register with the same
  highlight a settled wisp gets. A flight from nowhere would be a lie about where it came
  from.

## Two decisions that are not mechanics

### A card may not write `ask`

`chronicle.rs::CARD_LEVELS` is three of the store's four. Amber on this wall means *a
structured ask is waiting* — `attention.svelte.ts` builds a whole ladder on it, and its head
comment argues against there ever being a second answer to "how does Volery get your
attention". So the wall may write "this card is asking you"; a card may not claim your
attention through this channel. It already has `ask_user`, which is the honest way to want
somebody and costs the card its own turn.

A card that passes `level: "ask"` is **not refused** — it is filed as `note` and told, in the
tool result, which level it got and why. Refusing loses the entry, which is the one failure
this feature cannot have. Saying nothing teaches the card that `ask` works.

The assertion `a_card_may_not_write_the_level_that_means_asking` exists because adding
`"ask"` to that array is the entire change it would take to give every card on the wall a way
to flash the taskbar, and nothing else in the tree would say so: the column takes it, the
front end draws it amber, and it looks like a feature.

### Nothing escalates

No level reaches the taskbar, the peek window or the chime. The register is a record; the
away-ladder stays Volery's own judgement about cards that are blocked, failed or overdue.

Chosen for reversibility as much as taste. Adding escalation later is one optional field on
the tool and one branch in the ladder. Removing it later means breaking a contract cards have
already been taught — and `wisp`'s description is the only copy of the instruction, so the
retraction would have to reach every dormant card's transcript to be believed.

## The trim is a correctness property, not housekeeping

`store::trim_chronicle` deletes **seen rows first**, and this is the part most likely to be
"simplified" back into a bug.

The obvious cap is *keep the newest N*. It is wrong here in a way that is invisible until it
costs something: this feature exists to answer "what happened while I was away", and a wall
left running over a weekend with a fleet of cards on it writes past any N. A newest-N sweep
then deletes the oldest **unseen** rows — exactly the ones nobody has read, and the only ones
whose loss cannot be recovered from. Silently.

So there are two statements, in this order:

1. delete rows that are **seen** and outside the newest-`CHRONICLE_KEEP` window. Seen history
   is the part you have already had the value of.
2. a backstop at twice the cap that deletes regardless — because "never delete unseen" is
   unbounded for anybody who stops looking, and an unbounded table is a different failure
   rather than none.

Both are idempotent, so this is safe on every insert, which is where it runs.

`mark_chronicle_seen` guards on `seen_at IS NULL` for the neighbouring reason: without it,
pressing *all seen* twice restamps the lot, and any reading of *when* you caught up becomes
the time you last clicked rather than the time you read it.

## `source` is stored, not joined

The card id is in `from_id` already, so the display name looks derivable. It is not: a card
gets closed and a project gets forgotten, and the row has to go on saying who spoke. A
chronicle whose oldest rows read *unknown* has lost the thing it was for. Resolved once at
write time; `from_id` is provenance only, and there is deliberately **no foreign key** on it.

`secret_grant` in the same file wants `ON DELETE CASCADE` because a grant outliving its card
is a credential leak. A chronicle row outliving its card is the entire point. Two tables, one
column shape, opposite answers — worth knowing which one you are copying from.

## The cap on the flight is a GPU budget

`MAX_FLYING` and `flying`'s `life` parameter come out of the measurement in `motion.md`: on
this GPU the dominant term is the **present rate**, not the painted area, so *any*
continuously animating element makes the whole window present at display rate and an 8px dot
costs what a card-sized glow costs.

So three wisps cost what one costs, and thirty cost the same again. The cap is therefore for
the **eye** and the `life` is for the **GPU**, and they are two parameters because they are
two arguments. A wall set to `still` passes `life: 0` and gets no flight at all — which is
what "no motion" has to mean — and the entry still lands as a row, so turning motion off
costs an animation and never a record.

Anything added here animates `transform` and `opacity` only. `box-shadow` is what cost ~8% of
the GPU per working card, and it is the first thing to reach for when a wisp needs a glow.

## `wisp` is loaded, and it cost a byte of somebody else's budget

`chronicle.rs`'s doc comment on `wisp_schema` carries the full measurement. The short version:
the loaded MCP tier's budget was 24,000 bytes with 2,076 free, the smallest honest `wisp`
schema is 2,077, and it missed **by one byte**.

The budget went to 25,000 rather than the tool going down a tier, and both halves of that are
deliberate:

- **Not shaved.** A tier tuned to 23,999 is a build one word from red forever. The words left
  are the ones that make loading it worth anything — in particular the sentence saying when
  *not* to write a wisp, which is what stops this becoming thirty rows of narration.
- **Not deferred.** The feature is *cards writing to the wall's record*. Deferring the write
  tool ships the feature with its point removed: a deferred tool is only found by an agent
  that thought to search, and "should I announce this?" is not a question agents ask
  spontaneously.

The price was quoted before it was agreed — ~520 tokens on every spawn and every wake,
permanently — and the user said yes. **That the raise happened at all is the budget working.**
What it must not become is a number that moves whenever it is inconvenient, so the bar for the
next raise is the bar this one met: somebody names the tokens per spawn, and somebody who pays
them agrees.

One residue worth knowing: `paths` came off the schema while the tier was the constraint and
went back once it stopped being. If `wisp` ever moves down a tier, that is the field to drop
again, and it should go in the same commit.

## What Volery records itself, and the rule that decides it

**What happened *to* you, never what you did.** A worktree you merged and a card you set aside
are your own gestures, and a register that tells you what you just did is noise you read past
to find what you did not know. That rule is the whole reason this list is five rows long
rather than ten, and it is the test to apply to a sixth.

| row | written where | why it qualifies |
|---|---|---|
| a turn ended in an error | `skein.svelte.ts::#persistConv` | `ending` is already folded there, once per `result` |
| a card is asking you | same | same fold; no detail, since the question lives in `Ask.svelte` |
| a gate went red | `store.rs::settle_gate_run` | the only place that learns it; `failed` only |
| a dev server fell over | `servers.rs::exit_if_last` | that function *already* distinguishes a crash from a stop you asked for |
| the allowance crossed 80% | `ledger.svelte.ts::#noteAllowance` | folded off a reading that already happened |

Four things about that table are load-bearing:

- **Not every turn ending.** A card takes many turns and most of them ending well is the
  normal state of a working wall. One row per turn would bury the rest under exactly the noise
  this exists to cut through. Cards announce their own wins with `wisp`, which is the half that
  knows a unit of work has landed.
- **`ending` is classified in the front end and stays there.** `classify.ts::endingFor` is the
  only thing that knows an error from a question; the column `record_turn` writes is a value
  the webview computed. A second classifier in Rust would disagree with it the day either was
  edited — so `chronicle_note` is a command, and Rust does not decide which transitions matter.
- **`exit_if_last` needed no guard of its own**, because the one it already had is this
  section's rule in code: *a stop we asked for is not news about the server, and saying it
  anyway makes a restart look like a crash*. Anything added there must not grow a second guard
  that disagrees.
- **The allowance row only fires while a usage widget is up.** `#askAllowance` returns early
  unless something `#wants("allowance")`, because a request that leaves the machine may not be
  made by a wall nobody asked. So a wall with no usage widget is *quiet* about the allowance
  rather than wrong about it. Fixing that means a reading somebody asked for, not a poll added
  here — the shape to copy is `release.svelte.ts`, which asks on **focus**, because focus is an
  event that already exists.

And one placement trap, since it will be walked into again: `note` takes the store mutex, so a
call site holding it deadlocks. `settle_gate_run` calls after its `drop(conn)`, beside the
comment that moved the emit out for the same reason.

## Where the pieces are

| file | holds |
|---|---|
| `chronicle.ts` | pure: normalizing a row, the flight, the digest, the tally. Tested directly. |
| `chronicle.svelte.ts` | one subscription behind however many faces read it — `journal.svelte.ts`'s shape and refcount. |
| `Register.svelte` | the widget: the rows, the away-stack on its top edge, the two readings. |
| `Canvas.svelte` | where a wisp is drawn, and the edge indicator for a card off the viewport. |
| `chronicle.rs` | the two MCP tools, `note()` for Volery's own entries, the three commands. |
| `store.rs` | the table (`migrate_v32`), the trim, the read, marking seen. |

### Naming

`ledger` was taken — `ledger.svelte.ts` is the usage ledger — and `chronicle.svelte.ts`
beside a `Chronicle.svelte` would be the casing collision this codebase has now paid for
four times (`journal.svelte.ts`'s head comment is the record of the third). So the component
is `Register.svelte`: the house pattern is a lowercase noun shared by the pure and runes
files and a *different*, evocative noun for the component, exactly as `board`/`Billboard`,
`sink`/`Basin` and `gates`/`Gatehouse` already do.
