---
paths:
  - "src/lib/asana.ts"
  - "src/lib/asana.svelte.ts"
  - "src/lib/Kanban.svelte"
  - "src-tauri/src/asana.rs"
  - "test/asana.test.ts"
---

# The Asana board: columns are sections, and the drag is optimistic

#### The Asana board

One project's kanban on the wall, beside the cards doing the work — and **the first widget on
this wall that writes anything.** A card can be dragged between columns, the move lands in
Asana, and the wall never waits on the network to redraw it.

`asana.rs` answers in facts, `asana.ts` is pure and owns the one piece of arithmetic that
matters, `asana.svelte.ts` is the one connection behind however many widgets are up, and
`Kanban.svelte` draws it.

### Columns are sections, and that is not a detail

Asana has no separate notion of a board column. A **section** is a subdivision of a project
that draws as a header in list view and as a column in board view — one concept, two
renderings. So `GET /projects/{gid}/sections` is the column list and
`POST /sections/{gid}/addTask` is the move.

Worth stating because the phrase a person uses is *"the custom status columns"*, and
`custom_fields` is a different Asana feature entirely. If a board ever turns up whose columns
are an enum custom field rather than sections, that is a **second reading** and not a bug in
this one.

The other thing conflated by everybody the first time: **`completed` is the checkmark, not the
column.** A task can sit in a Done section for weeks unticked, and a ticked one stays in
whatever section it was in. `completed_since=now` — Asana's idiom for "incomplete only", which
reads backwards until you notice nothing has been completed since *now* — filters the
checkmark. So the `showing` knob hides finished cards and a Done column still draws either
way.

### `plan` is one function on purpose

**The optimistic update and the request are two statements of one intention, and anything that
computes them separately eventually computes them differently.** `plan` in `asana.ts` returns
the new board *and* the wire arguments from one decision, so they cannot disagree.

The trap that makes this concrete, and it was **measured against the live API on 2026-09-03**
rather than read: `addTask` with neither `insert_before` nor `insert_after` puts the task at
the **top** of the section. A card sitting at the bottom of a two-card column, re-added with
no position, came back at the top. So a widget that drew the card where you dropped it and
sent no position would show it at the bottom and have it jump to the top on the next poll —
which does not read as a disagreement about ordering, it reads as *the app having lost your
drag*.

Hence: a position is always sent when the column has anything in it. Above the first card is
`insert_before` that card; anywhere else is `insert_after` the card it now sits under — a
**neighbour rather than an index**, which is the form that survives the column having gained a
card since the reading. Only an empty column sends neither, where Asana's default is also the
only possible answer.

Two things `plan` gets right that are easy to get wrong:

- **The neighbours come from the column with the dragged card removed.** Computing them from
  the column as drawn makes `insert_after` name the very task being inserted, which Asana
  refuses — and it only happens on a *within-column* drag, so it ships.
- **Every no-op returns null**, and there are five: a drop onto the card's own position, a drop
  back exactly where it was, the unsectioned pile, a card a poll took away mid-drag, a column
  that is not there. It matters beyond tidiness — an optimistic update with no request behind
  it draws a move that never happened and is then "corrected" by the next poll, which is
  indistinguishable from a save that failed and forgot to roll back.

`plan` also never mutates the board it is given. The rollback depends on that: `asana.svelte.ts`
keeps the previous board, and a `plan` that spliced in place would have destroyed what it was
about to restore.

### The unsectioned pile

Asana lets a task be in a project without being in any section. Dropping those on the floor
would make the board quietly disagree with the count in Asana's own header, so they get a
column called `no column` with an **empty gid**.

That empty gid is what makes it not a drop target: a move needs a section to POST to and there
is none. A card can be dragged *out* of the pile — which is the useful half, and how a task
somebody filed without a column gets onto the board — and not into it. Refused in `plan` and
again in `asana_move`, so no path can produce a request with an empty gid in its URL.

### The two races, which are the actual bugs

`plan` is arithmetic; `asana.svelte.ts` owns the timing, and that is where this was going to go
wrong.

- **A poll landing mid-save undraws the move.** The reading was taken before Asana was told
  anything, so landing it puts the card back where it came from — again indistinguishable from
  a silent failure. So a poll that lands while a save is in flight is **dropped**, and the save
  takes its own reconciling read once it settles.
- **Rolling back to a snapshot is wrong when two moves overlap.** The snapshot from the first
  predates the second, so restoring it undoes a move that succeeded. The snapshot is restored
  only when the failing save is the *only* one in flight — nearly always, and the case where an
  instant rollback is worth having. A reconciling read follows either way, because **Asana is
  the truth and the snapshot is only a guess about it**, and because Asana decides the final
  ordering: a neighbour-relative insert can land somewhere the arithmetic here did not predict.

A refusal is **dismissed rather than cleared by a redraw**. The card has already gone back
where it came from, so the sentence is the only remaining evidence that anything happened.

### The drag is pointer events, not HTML5 drag-and-drop

Deliberate, and not merely conservative:

- Every gesture on this wall is pointer events — `Canvas`'s pan and marquee, a card's drag, a
  widget's resize — so it is the mechanism already proved in this webview.
- HTML5 `dragstart` fires only *after* the pointer has travelled, which is exactly the window
  in which `Canvas` claims the press and starts moving the widget instead.

A card carries **`data-grip`**, which is what tells `Canvas.handleOf` to leave the press alone
entirely — the wall's handler is on an ancestor in the capture phase, so a `stopPropagation`
in the widget could not help. That hands the widget the whole gesture *including the part the
wall normally owns*: **the press is a click until it has travelled 4px.** Same rule, same slop,
obeyed here because a grip has nothing to inherit it from. Under 4px a card opens in Asana;
past it, it moves. Escape abandons a drag in flight, the same contract every panel on this
wall has for the key.

Hit-testing is `document.elementFromPoint` against `[data-col]` and `[data-card]` rather than
arithmetic over stored rects — the board sits inside a canvas that is scaled and panned, client
coordinates are the one space the pointer and the DOM agree on, the browser has already done
the transform, and a column that has been scrolled needs no bookkeeping. `data-next` on each
card is what lets "the bottom half of this card" mean "above whichever comes next" without the
hit test knowing an index.

### What it costs, and what it refuses to do

- **Three requests per poll, not one per column.** The tasks come in one query with
  `memberships` rather than a query per section; a nine-column board would otherwise be eleven
  round trips per poll, on a timer, against somebody else's server. `Board::asked` reports the
  count, the same as the pipelines widget — this is the only class of widget on this wall whose
  cost is somebody else's machine.
- **A minute between polls.** A kanban is somebody else's afternoon; cards move on the order of
  minutes and nobody is waiting at the wall for one.
- **Bounded by somebody watching**, like every poller here: with no board widget up, nothing
  asks Asana anything and no token is read. A reading is keyed by project **and** filter,
  because two widgets on one project showing different things are two questions — keying on the
  project alone would have the second quietly redraw the first, which looks like a filter that
  does not work.
- **400 tasks across at most four pages**, and what is dropped is **reported** (`Board::more`,
  drawn as "at least N"). A truncated reading that looks complete is an instrument claiming to
  know something it does not. The count is a floor because Asana does not say how many are
  left.
- **One write, and no others.** No create, complete, rename, comment or delete. The argument
  `Pipelines` makes about not offering "re-run failed jobs" beside a job list is stronger here:
  a wall you glance at is not a place for a destructive verb, and a drag is a gesture you can
  make by accident. A move is reversible by dragging it back, which is what makes it the one
  write worth having.

### The picker is the widget until a project is chosen

A board with no project is not a board, so the choice is drawn *in* the widget rather than only
in the right-click menu — a first-run state whose only affordance is a menu you have to know
about reads as broken. The knob exists too (`project`, sourced from `boards`), and it carries a
literal `none — show the picker` option, which is both what the catalogue's own invariant needs
(a default has to be a value the knob accepts) and a way to get the picker back without taking
the widget down.

**Yours first, and by default only yours.** Measured on the real workspace, this account's
token can see **64 projects** and is a *member* of three — and those three are exactly the ones
Asana's own sidebar shows under Work (`T&D Team`, `RISE`, `Asana Onboarding – …`). A picker
that opened on all 64 would bury the answer nine times in ten, so the default is the short list
and `browse the other 61…` is a press away.

The membership flag costs nothing: `members` is an `opt_field` on the same project-list request,
so the distinction arrives with the names. `favorites` was the other candidate for "your
sidebar" and returned only *one* of the three, so **membership is the right notion and starring
is not** — worth recording, because favorites is the endpoint whose name suggests otherwise.

The right-click knob offers **only** the ones you are a member of, and that asymmetry is
deliberate: a menu with 64 entries is not a menu, the handful you work in are what you switch
between, and browsing everything is what the widget's own picker is for.

The picker also has a filter, and **typing counts as browsing** — it searches all 64 rather
than only what is shown, because somebody typing a name has already said they are looking past
the default. Substring and case-insensitive: a project name is a phrase somebody typed rather
than a path, so there is nothing here for a fuzzy score to prefer.

### What was probed, 2026-09-03

Read off `app.asana.com` with a real token on the `lagardere-tr.com` workspace. The full list is
in `asana.rs`'s header; the load-bearing results:

- `GET /users/me` → `data.name` and `data.email`, which is exactly what the tokens panel's
  check reads and why it can name the account.
- `GET /projects?workspace=…&archived=false&limit=100` → 64 rows, `next_page: null`. One page
  covers a real tenant. With `opt_fields=name,members`, matching against `/users/me` picks out
  exactly the **three** in the sidebar; `GET /users/me/favorites?resource_type=project` returned
  only one of them.
- `GET /tasks?project=…&completed_since=now` → 10 rows where the sections between them hold 19,
  which is the checkmark-not-the-column distinction demonstrated. `assignee` frequently arrives
  as `null` outright rather than absent.
- `addTask` with `insert_before` → 200, above the named task. With `insert_after` → 200, below
  it. **With neither → 200, and the card jumped to the top of the column.**

The board it was measured on was restored byte-for-byte afterwards.

### Still unproven

**The drag has not been driven in the real webview.** This machine has no MSVC toolchain, so
`bun run tauri dev` does not run here (`.claude/rules/build.md`) — the arithmetic, the wire
forms and every shape are tested or measured, and the gesture itself is not. What to check
first when it can be: that a press on a card does not carry the widget away (the `data-grip`
claim), and that `elementFromPoint` answers through the canvas transform at a zoom other than
1.

**And a column cannot be scrolled with the wheel**, because `Canvas` preventDefaults every
wheel event on the surface to zoom the wall. Columns are `overflow-y: auto`, so the scrollbar
works and nothing is unreachable, but the obvious gesture does nothing. That is the wall's
existing rule rather than this widget's bug — the log widgets have it too — and changing it
means deciding that some widgets eat the wheel, which is a decision about the wall and not
about Asana.
