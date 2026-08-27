---
paths:
  - "src-tauri/src/board.rs"
  - "src/lib/board.ts"
  - "src/lib/board.svelte.ts"
  - "src/lib/Billboard.svelte"
---

# The billboard

`send` is a message to somebody. A **notice** is a message to nobody in particular — "I am
reworking the transcript panel this afternoon, leave `markdown.ts` alone" — and the difference
that matters is what each costs. Reading the board is free and reaches the whole wall; a `send`
costs the recipient a turn and reaches one card. So an agent that wants to know who is working
nearby reads the board *first*, and sends only once it knows who to send to.

`send`'s own description says that, and so does the system prompt, because the reflex the
roster tools create is exactly the wrong one: an agent that has just been told it can message
its colleagues will message them to ask what they are doing. See `.claude/rules/relay.md` for
the other half of this.

Three tools — `board`, `post`, `unpost` — and there are three rather than two because **taking
a notice down has to be as obvious as putting one up**. A board nobody clears is a board nobody
believes, and the failure is quiet: every notice on it stays true-looking forever, so the first
thing an agent learns is that the board is out of date and can be skipped.

### Clearing, in descending order of how much it can be relied on

Only the first works without anybody remembering anything.

1. **A card that closes takes its notices with it.** `store::sweep_notices`, called when a card
   closes and again on every read as the backstop for a crash in between. The commonest stale
   notice by a long way is one from a card that finished and went away.
2. **Clearing a card clears its notices.** A reset card is not still doing what it said it was
   doing.
3. **Stale is marked, never removed.** Ninety minutes untouched and every reading says so — the
   agent's and yours, off the same number, because `board.rs` computes `stale` onto the row
   rather than letting each side recompute a threshold. A long refactor is a real thing, and
   deleting a true notice is worse than showing an old one.
4. **Your own notices come first on every read**, under a line saying they are yours to take
   down, and the receipt for posting one says the same.

**No foreign key does any of this, and reaching for one is the trap.** `ON DELETE CASCADE` on
`from_id` looks like it clears the board when a card goes and does nothing at all, because
closing a card sets `closed_at` and deletes no row. That is worse than having no constraint —
it reads as solved. See the note on `store.rs::migrate_v15`, which is the same shape
`set_mid_turn` learned one table over: bookkeeping that records how far something got must not
be left to a mechanism that never fires.

### The notice that comes to find you

A notice can carry `paths`, and then it does not wait to be read: any card that writes to a
file one of the globs covers is served it, **once**. That is the difference between a board
agents must remember to consult and one that reaches the agent who needed it.

- **It is a notice served, not a lock, and the wording is not modesty.** Skein sees the
  `tool_use` on the wire, which is the earliest it can know — but the CLI queues a prompt
  written mid-turn behind the running turn, so what the agent gets is "before you go further"
  rather than "before you touch". There is no gate to hold: a project card runs with
  `--dangerously-skip-permissions` and the edit is already happening when the event arrives.
  Reading the board first is still the cheap way to find this out; this is the backstop for
  when it did not happen.
- **Writes only.** Reading a file somebody else is rewriting is not a clash — it is how you
  find out. The call sits beside `record_file_touch` in `skein.svelte.ts`, which is the one
  place a write is folded out of the stream; the two are separate because they answer different
  questions, one a ledger of what happened and one a thing that reaches out.
- **Once per (notice, card), decided by `INSERT OR IGNORE`** rather than read-then-write. A card
  making three edits in one turn is exactly the card this fires on, and a check-then-set would
  serve it three times.
- **Editing a notice clears its served marks**, because new words are news again. Without it,
  the agent most in need of the correction is the one guaranteed not to get it.
- **Never your own**, and a failed delivery is still left marked served: a dormant card replayed
  the same notice at every wake for the rest of the day is worse than one missed, and the board
  is still there to be read.
- It arrives in the `RELAY_MARK` envelope with a third header form, so the transcript folds it
  exactly as a message and there is one recogniser rather than two. `relayCap` says "from the
  billboard". It draws a strand from the poster's card when there still is one — it is the same
  event on the wall, something leaving one card and arriving at another.

### The globs

Small and deliberately forgiving, because the two failures are not symmetric: a glob that
matches too little is a notice that never reaches the agent it was written for and **looks
exactly like the feature working**, where one that matches too much costs somebody a paragraph
they did not need.

So a pattern with no separator matches the *basename* — `*.rs` obviously means "any Rust file"
and not "one in the drive root" — and one with a separator matches the **tail** of the path,
anchored at a separator so `re.rs` cannot match `store.rs`. `*` stays inside a segment, `**`
crosses them, and everything is folded to forward slashes and lower case because Windows spells
one path two ways inside a single turn.

`glob` is iterative with one backtrack point rather than recursive. Nothing here is adversarial
today, but the naive recursion is exponential on a pattern like `**a**a**a**` and this runs on
every write every card makes.

### Caps, and what a cap does when it is reached

Two numbers, not one: **eight notices per card, of which at most four may carry no `paths`.**
120 characters of subject, 2400 of body, 8 globs. Posting the same subject twice **replaces**
rather than adding — which is what keeps an agent that re-posts once a turn from papering the
board with one sentence, is how a notice says it is still true (`touched_at` moves, so `stale`
resets), and costs nothing against either cap.

**Why the cap had to be split.** It was one number — four — on the argument that four is more
than any honest use and few enough that the board stays a page. The second half of that was
never true: the cap is per *card*, so what bounds the board's length is how many cards are
live. What it actually buys is that one card cannot paper the board, and eight does that as
well as four.

What it could not do with one number is price two different objects. A notice with **no**
`paths` is pure broadcast: every card that reads the board reads it, and it reaches nobody who
did not think to look. That is what four was written for and four is still right for it. A
notice **carrying** `paths` is a different thing already — `on_touch` serves it to the card
writing a covered file and to nobody else, so its cost falls on the one agent it was written
for. Those are numerous, short-lived and mechanical, and a card coordinating a nine-way split
legitimately wants more than four of them. Pricing them together squeezed out the useful one.

### A refusal is the whole of the guard here

This is the part worth carrying past this file. `relay.rs` states the rule where `MAX_HOPS`
used to be: **a refusal must carry its reasoning and a way forward, because an agent told only
"no" will try a different phrasing of the same message.** A bare quota message is the
degenerate case — it does not even offer a different phrasing, so what the agent does instead
is decide the announcement was optional.

And that is worse here than almost anywhere else, because of an asymmetry that is easy to miss.
A `PreToolUse` deny stops the tool call. **`post` refusing stops an *announcement about* a call
the agent then makes anyway** — the notice and the edit are two separate acts and only one of
them was refused. There is nothing downstream to catch it.

Paid for on 2026-08-27: a card claimed `.claude/rules/hooks.md`, was refused for the
four-notice cap, judged the work small and carried on unclaimed. A sibling committed that file
minutes later — with an explicit pathspec, which does not help, since `git commit -- <path>`
commits the *working-tree* content of that path — and took a hundred lines of somebody else's
work under a message about something else. **In a shared tree the board claim is not
decoration; it is the only thing standing between two cards and a mixed commit**, and the
refusal now says exactly that, names the files left unguarded, and lists the caller's own
notices likeliest-finished-first so `unpost` can be called without a `board` read first.

The refusal for running out of *bare* slots spends its words differently: it points at `paths`,
because an agent that hits it is one paragraph from the mechanism that actually reaches, and
because that is the only form of claim this wall has. It is only reachable while the total has
room — `do_post` checks the total first — or the way out it offers would not work.

### Nothing may silently keep less than was written

The same defect wearing a quieter face, and it was found live in THE PROTOCOL. `clip` returned
only the string, so a notice over `MAX_BODY` went up with its tail gone and the receipt said
"posted". The notice that happened to was the standing rules for an eleven-card split — the one
thing every card was told to read first — which stood cut off mid-sentence for an afternoon
with its author believing the wall had the lot.

A cap that refuses is at least an event an agent has to answer. **A cap that truncates and says
nothing produces a result the caller cannot tell went wrong**, which is strictly worse. So
`clip` and `globs_from` both return what they took, and `lost` puts it on the receipt: how many
characters, what the body now ends with, and — for globs — that the files past the eighth are
**not** claimed and nobody will be told about them.

**A card's post is clipped and yours is refused**, and the asymmetry is deliberate. An agent's
post costs a turn, so cutting the tail and saying so is the cheaper of two bad outcomes. Yours
costs a keystroke, the text is still in the field, and `Board.fault` already draws what came
back — so nothing of yours goes up truncated. `Board.post` answers whether it landed and
`Billboard`'s draft is kept when it did not, because a face that cleared its field on the way
to a fault would lose your words to a length limit, which is this same bug one layer up.

### Running the assertions

`bun tools/lift-board.ts` — most of what is tested here is *strings*, which reads like the
least testable thing in the crate and is in fact the most load-bearing, since on this wall a
refusal is the entire guard. `cargo test` needs MSVC; the lift regenerates from `board.rs` and
`store.rs` on every run and keeps nothing, the shape `lift-servers.ts` argues for. Run
`bash tools/check-gnu.sh --tests` beside it — the lift proves the bodies and cannot prove the
module paths.

A chat card has neither tool, the same gate `relay.rs` applies and decided the same way — by
asking the store, never the caller. It has no project to be coordinated about, and the board is
a list of this machine's directories handed to the one card that can reach an arbitrary URL.

### Consulting it yourself

A `billboard` widget, which is this app's own idiom for "when I desire to": you hang one up,
and that gesture *is* the asking — `Board` reads nothing at all until a widget attaches, the
bargain `Ledger` and `Meter` strike. Unlike those two it **does not poll**. They poll because a
turn taken in a terminal appends to a file and emits nothing; every write to this table goes
through `board.rs`, which emits `board:changed`, so there is an event for every change there is
and a timer would be polling for news that has already arrived.

- **You can take any notice down and put one up**, unlike the pipelines and reviews faces which
  are read-only on purpose. Taking one down is the gesture that keeps the board worth reading
  and is the one an agent may have forgotten. Putting one up is the only instruction on this
  wall that reaches every agent without costing any of them a turn.
- **A notice you post has no author**, so nothing sweeps it away and it is yours to remove. It
  goes to the whole wall, because a notice you write by hand is not standing in any one project
  — you are.
- **No scope knob.** A widget belongs to no project, so "this project" has no referent to
  resolve against; the scope split exists for the *agents*, who must not be shown another
  project's work. You want the wall. The knobs are the reading — a list you glance at, or notes
  opened out — and whether stale notices are hidden.
- **The only colour on the face is the stale mark**, in amber. An old notice is not broken and
  is not working; it is a question, which is what amber means everywhere else here.
- `normalize` degrades rather than refuses, the bargain `normalizeAsk` strikes: what arrives is
  a row a model composed and a build older than it may be reading, and a board that silently
  shows less than is on it is the one failure this feature cannot have. Only two fields are
  load-bearing — no id means nothing to take it down with, no subject means a blank line.

`snapshot.board` carries the notices and the **watcher count**, for `listeners`' reason: the
reader is idle until a widget attaches, so an empty board on a wall with nothing hung up is the
feature working rather than an empty board. The control surface has `board` (the tool's own
words, as a model reads them), `notices` (the rows the wall draws), `post`, `unpost` and
`touch` — the last so serve-on-first-contact can be exercised without an agent taking a turn to
edit a file. Both readings are exposed and not one, because the two are what must not drift:
the tool's says `STALE` in prose and the wall's says `stale: true`, off one number.
