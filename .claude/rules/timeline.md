---
paths:
  - "src-tauri/src/timeline.rs"
  - "src/lib/timeline.ts"
  - "src/lib/timelines.svelte.ts"
  - "src/lib/Frise.svelte"
  - "src/lib/Lintel.svelte"
  - "src/lib/Annals.svelte"
  - "src/lib/Unfinished.svelte"
  - "test/timeline.test.ts"
---

# Timelines

A card's plan for a long piece of work, drawn on the glass as a frise: major steps as
milestones along one hairline, sub-steps as ticks between them, and a step whose work runs in
parallel forking into **strands** that rejoin at the next milestone. The card draws it and keeps
it current; the user reads it at a glance across ten cards. Sink `9bd1e768`, designed with the
user over mockups on 2026-10-01 (the "thread" look, strands rather than several marks on one
line, the "plates" archive).

`timeline.rs` owns the plan and every write. `timeline.ts` is the pure reading — the row's
shape, how far along it is, every mark's position (`frise`) — and `test/timeline.test.ts` holds
it. `Frise.svelte` is one plate, `Lintel.svelte` the glass layer, `Annals.svelte` the archive,
`Unfinished.svelte` the close confirm. Schema v37.

### One live timeline per card, and parallel work is a strand

Tools take no id: a card's own live timeline is the only one it can mean. Parallel work — a
background task, a split — is a step forking into named strands, each with its own sub-steps
and its own live marker, so the parallel parts stay inside the plan they belong to. A card may
hold a *complete* one on the glass (waiting for the archive click) and start a new live one.

### Two writes, priced differently

`timeline_set` takes the whole plan; `timeline_mark` moves states by path (`3`, `3.2`,
`3.ui.2`, 1-based) and takes `done`/`active`/`todo` lists so several items move in one call.
The user asked for the hybrid explicitly to keep ticks cheap — a mark is a few dozen tokens
where re-sending the plan is a thousand or two. A `set` **carries forward** every state it can
match by title (step by title, sub-step by strand name then by title anywhere in the step), so
restructuring does not mean restating progress; a state written explicitly wins. Marks are
all-or-nothing: every path resolves before any applies.

Rewinding is allowed and is just a mark. A step marked `done`/`todo` takes its sub-steps with
it; `active` on a step that has sub-steps is refused, since it names nothing in particular.

### Owner writes; any card reads, wall-wide

Reading is not project-scoped, on the user's point that a card in one project spawns cards in
others — the orchestrator reading its children's progress without a `send` costing them a turn
is the case it is for. Writing is the owner's alone.

### Colour is the owner's status, on the live markers only

A live marker is *where work is happening now*, which is a status, so it wears the owning
card's tier — celadon working, amber asking, muted at rest. Milestones are never tinted; how far
a plan has got is not a status. An archived plate is drawn `rest` throughout, so a left one's
markers read as where it stopped.

### Clicking a step finds the write in the transcript

Every write that moves something takes the plan's next `rev` and ends its answer with
`[timeline 3fa9c1 r7]` (`receipt`) — the timeline's short id as well as the rev, because a rev
restarts at 1 for every timeline and a card can hold a complete one and a live one at once, so
`r3` alone would land a click on the wrong plan's write. A mark that changes nothing takes no
rev and writes nothing. Each step and sub-step records the rev that added it (`born`) and the one that
finished it (`done`, cleared on a rewind) — `stamp`, serialised flattened onto the item. A click
focuses the owner and walks the transcript for the timeline tool call whose *result* carries
that receipt (`Transcript.reveal`), which works for history read back off disk as well as for a
live column, because the receipt is in the session file. A rev rather than a timestamp because
the thing being found is a tool call, and a time would have to be matched against another clock.
`jumpToWrite` retries for a few seconds since a dormant card's history is still loading when it
is focused, and gives up silently — landing on the card already happened.

### Closing a card with one in flight asks, whoever closes it

Your own close puts up `Unfinished.svelte` (keep-it focused, Escape keeps). An agent's
`close` is parked on the user like any other close question — **including a parent closing its
own child**, which otherwise closes unasked; `with_timeline` rewrites the question so it does
not call the child "not a card it opened". Either way the close itself archives the timeline as
`left` (`leave_for`, from `close_conversation_record`, beside the board's and the sink's own
clearing). The control surface's `close` op — a test's hand, or a spoken sentence through the
steward — asks nobody, so it refuses a card with a live timeline unless given `force`.

A **cleared** card leaves its timeline too (`clear_conversation`): the agent that drew the plan
is gone though the card stays. `leave_for` therefore never re-reads the session — after a clear
it is already the new one — and keeps the one `set` recorded, which is the conversation that
remembers the plan. One live timeline per card is held by a partial unique index as well as by
every writer taking the store lock across its check and its write.

### Picking one back up adopts the session

A left timeline's card is closed, so somebody has to own it. The user chose re-adopting the
session that drew it — `importSession`, the same path `adopt` takes for any closed card — and
handing the timeline to that card (`resume_timeline`). The owner is looked up **by session**,
not by card id: a card cleared since is on another session and has forgotten the plan, and a
session already adopted back through `adopt` is a card on the wall that remembers it. A
second click while the first is still adopting is ignored (`pickingUp`). It remembers the plan because it is the
same conversation. If the card is still on the wall (archived by hand), the timeline simply goes
back to it.

### The glass layer is inert and owes Canvas an exception

`Lintel.svelte`'s `.timelines` is `inset: 0` and `pointer-events: none`; only its plates take
events back. It is a direct child of `.glass`, whose `.glass > :global(*)` hands events back to
every child — so without `.glass > :global(.timelines)` in Canvas it is a transparent sheet over
the whole wall that eats every press, the 0.29.0 Wisps bug (`layout.md`). `styles.test.ts`
holds the pair. And `groundDown` returns early on a left press inside `[data-timeline]`, or the
release would read it as a click on bare glass and let go of everything.

Named `Lintel` and not `Timelines` because `Timelines.svelte` and `timelines.svelte.ts` are one
file to a case-insensitive filesystem — svelte-check says so, and `Carry.svelte` has the same
note about `Portage`.

### Discoverability is one prompt sentence that names a search

The four tools are deferred with search hints. `supervisor::append_prompt` carries one sentence
— chosen by the user — telling project cards to draw planned multi-stage work as a timeline and
to *search their tools for `timeline`*. It names a search rather than a tool, so it keeps
`the_prompt_names_only_tools_whose_schemas_are_loaded` honest: that rule's reason is a prompt
pointing at an identifier whose schema was withheld, and ToolSearch is loaded. The user's limit
— not for small tasks or open-ended experimenting — is in that sentence and in `timeline_set`'s
description both.
