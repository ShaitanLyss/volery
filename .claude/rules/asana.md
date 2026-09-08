---
paths:
  - "src/lib/asana.ts"
  - "src/lib/asana.svelte.ts"
  - "src/lib/Kanban.svelte"
  - "src/lib/Tasks.svelte"
  - "src/lib/Health.svelte"
  - "src-tauri/src/asana.rs"
  - "src-tauri/src/docket.rs"
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

### Three widgets, one connection

The board is one reading of Asana and not the only one worth a wall. Three now, and the split
follows the rule `azdo.md` states: **a variant is a different reading of the same fact, and a
different fact is a different widget.** You want a board and "what is on me" up at the same
time, which a variant makes impossible.

- **`asana` — the board.** One project, its sections as columns, a card you can move.
  Readings: the board, or how much is in each column.
- **`asanatasks` — what is on you.** `assignee=me` across the workspace, one request, and the
  cheapest useful thing here. Late first and most overdue at the top, then today, then by date,
  then everything undated — and anything ticked last however overdue it was, because a
  completed task is history rather than work. Readings: the list, or the three numbers (late,
  today, this week) that still say something at the size of a card.
  - `assignee=me` **requires** `workspace`; Asana refuses the pair otherwise. That is why the
    connection holds `spaces` at all.
  - An undated task sorts *below* a dated one, and that is a judgement rather than a
    convenience: an undated task is one nobody has committed to, and putting it above something
    due on Friday would be the list arguing with the plan.
- **`asanahealth` — how every project is going.** The reading Asana will not give you without
  a portfolio, since its status updates live one project at a time and "is anything off track
  anywhere" is a tab each. Readings: a grid of dots (the default — the question is answered
  without your reading a word), or a list worst-first with each update's own heading quoted.

All three share one `Asana`, and each is bounded by its own watchers on its own clock: a board
every minute, what-is-on-you every minute, the project list every **two** — a status update is
a thing somebody writes weekly, and that request is the most expensive one in the file.

### The health taxonomy, and the two ways to be wrong about it

Asana is mid-migration between two status fields and **both are documented**, so `asana.rs`
asks for both and carries whichever answered: `current_status_update.status_type`
(`on_track`/`at_risk`/`off_track`/`on_hold`/`complete`/`dropped`, the one new integrations are
told to prefer) and `current_status.color` (`green`/`yellow`/`red`/`blue`/`complete`, the
deprecated one). The projection into one vocabulary is in `asana.ts` and **not in Rust**, for
the reason `azdo.md` gives at length about two forges: folding a vocabulary at the wire is
where a state one side has and the other does not gets quietly turned into a lie. Note the
colour field has no word for `dropped`, which is the gap the newer field exists to fill.

Two decisions carry the widget, and both are ways it could have been quietly wrong:

- **Silence is not "on track".** Most projects have never had a status update written on them.
  `none` is its own state, muted, and it says *nothing said* — a grid that drew silence as
  green would be the most reassuring possible way to be wrong about a portfolio. It sorts after
  `on-track` and before the finished ones: not actionable, not settled either.
- **A parked project is not a project in trouble.** `on-hold` is muted rather than amber.
  Drawing a decision somebody has already taken as a warning is how a grid learns to cry wolf,
  and then nobody reads it.

And the colours are **the wall's four**, never Asana's. `healthTier` projects onto
`classify.ts`'s tiers — rust for off track, the half-amber `partiallySucceeded` uses for at
risk, celadon for on track, muted for everything settled or unknown. Colour is status here, and
these are the statuses this wall has.

### Custom fields, read the way Asana says to

A board's columns are sections; its *vocabulary* is custom fields — priority, effort, squad,
whatever that project's owner set up — and the board ignored them until now. They arrive on the
same task query as one more `opt_fields`, so they are nearly free.

**`display_value` and never the typed value.** Asana's own advice, and the reason is the one
this app cares about: "integrations that don't require the underlying type should use this
field", so an enum, a number, a date and a people field all arrive as a string somebody chose
the formatting of. A new custom field type therefore costs no code here.

Only fields *with* a value are carried — an empty chip reads as a value that failed to load,
which is worse than no chip — and `chipsOf` caps what a card draws and **reports the
remainder**, for the reason `Board.more` does.

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
- Custom fields: `display_value` is documented as the universal readable value and is what the
  chips read. The **project status field is the one shape here that was not probed** — the PAT
  was revoked before the health grid was written — so `asana.rs` asks for both the preferred
  and the deprecated field and reads whichever answers. Both are documented fields of Project,
  so the request is valid either way; what is unverified is only *which* one this workspace
  fills in. A project with neither draws as `nothing said`, which is also the honest reading if
  the field name is wrong.

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

## Asana a card can reach — `docket.rs`

Three MCP tools on the skein server: `tasks`, which reads; `task`, which is the one verb and
has six actions; and `asana_token`, which is the escape hatch and hands over the credential
itself. The arrangement is `smith.rs`'s one service over, and the file is a door onto
`asana.rs` rather than a second client — `get`, `post`, `put` and `delete` became `pub(crate)`
and the token and base url did not, so what crosses the seam is a request and never the secret.
`asana_token` is the deliberate exception to that last clause, and the section on it below is
the whole of why.

### Why it exists: a credential the app was holding and not lending

Volery takes an Asana PAT, keeps it in the Windows credential vault, verifies it, and draws
three widgets off it. An agent on the same wall had no route to any of that — it could see a
kanban board eight feet away and could not read the task it had been asked to work on. There
is no CLI to fall back to either: `integrations.ts` marks Asana `sole: true` precisely because
**nothing else on this machine holds an Asana credential**, so a card asking "what does the
ticket say" had no answer at all.

**The certificate is why a card could not route around us, and it is deliberately not the
argument for the file.** `app.asana.com` is intercepted here exactly as `dev.azure.com` is —
probed 2026-09-04, a leaf issued by `ca.macquarietelecom-103950.au.goskope.com`, the same
Netskope CA — so a card that shells out to `curl` reads a certificate error where Volery's
`ureq` succeeds against the same host. But `smith.rs` exists because `az` is *broken* on this
network and `gh` is not; here there is no tool to compare against, and the capability is
**absent** rather than broken. Keeping those two arguments apart is what stops the next
integration being justified by a certificate that has nothing to do with it.

### Every write asks, and it is one rule rather than a table

`smith.rs` gates its one verb and states the floor as *a card may write only what a person
would type into a text field*. Both are inherited and the gate is drawn wider: **there is no
unattended write in this file.** Not create, not a comment, not a checkbox, and **not a move**
— even though a move is the one write the widget itself makes on a drag.

That asymmetry with the widget is the point rather than an inconsistency. A drag is a gesture a
person made, on a board they were looking at, that they undo by dragging it back. A card's
`move` is none of those, and the person whose board it is may not be at the wall at all.

**The confirmation is standing in for a scope that does not exist**, which is why it is
unconditional rather than reserved for the destructive verbs. Two facts pull against each
other:

- **An Asana PAT is unscoped.** `integrations.ts` records this in a field that exists to stop
  the panel implying otherwise: a token is the whole of what the account can do, across every
  workspace it can see. There is no narrower credential to hand a card.
- **A card cannot be scoped to a territory the way `smith.rs` scopes one.** There, the
  org/project/repo triple comes off the card's own git remote, so a card *physically cannot*
  name somebody else's repository. Asana has no such anchor — a project is not derivable from a
  working directory — so a card **must** be able to name one, and the blast radius the forge
  closed by construction is open here by necessity.

So every question names the project and the task in the user's own words, and the thing being
approved is *where* as much as *what*. A card reaching into a workspace nobody expected it to
touch is visible in the one place it has to pass through.

**`delete` is offered, and it needed checking rather than arguing.** The floor turns on whether
an act is reversible by the person whose name is on it, and `DELETE /tasks/{gid}` is not a hard
delete — Asana moves the task to that person's own trash, restorable for 30 days. So it clears
the same bar `pull_request`'s create does, and it is refused the way `merge` is refused there:
by not being reachable without a person, rather than by not existing. The question says where
it goes and for how long, because that is the fact that makes the decision.

A **chat card is refused outright**, the same rule `smith.rs` states: a credential-carrying
tool is exactly the reach that card kind exists to deny.

### Three things the reading had to get right

- **`notes` only where it was asked for.** The description is far and away the largest field on
  a task, so a board carrying sixty of them would spend a context window saying what one call
  says better. `tasks` with a `task` gid is the reading that carries it, and the schema says to
  use it before an `update` — because `notes` is replaced wholesale, which is
  `smith::amend_pull`'s trap one service over.
- **The section is matched on *this* project's gid.** A task can be in several, and taking the
  first membership files it under whichever column it occupies on somebody else's board. That
  is the one bug in this grouping that produces a *plausible* answer rather than an error, so
  it is the assertion the lift exists for.
- **A project is resolved by gid or by name**, exact before substring, and **ambiguity is
  answered with the candidates rather than resolved by picking**. An agent acting on a sentence
  somebody typed holds `"RISE"`, not a gid; refusing that would make the tool usable only after
  it had already been used once. Guessing between two matches would put a write on the wrong
  board behind a confirmation that named the wrong board, which is the failure the whole file is
  arranged to make impossible.

### `move` sends no position, and unlike the widget that is right

The section above records that `addTask` with no position puts the task at the **top** of the
column, and that the widget therefore always sends one. A card has expressed no opinion about
where in the column, so Asana's default is also the only honest answer and inventing a
neighbour would be the tool deciding something nobody asked it to. The tool's reply says where
it landed, so the card is not left guessing either.

### `asana_token` — the credential itself, and the line it crosses

The six actions are a fraction of Asana's API. A card that needs an attachment, a subtask, a
portfolio, a goal, a webhook or a bulk read has no route through them at all — so `asana_token`
parks a question and, if the user agrees, **hands the card the PAT**.

**This crosses a line `creds.rs` draws on purpose**, and it is written down rather than quietly
taken. That file states it plainly — *"the one read path out of this file, and it hands back
the secret — which everything else here is arranged not to do"* — and `integration_held`
answers a boolean precisely so that no command can return a token to the front end. An agent is
further out than the front end.

What licenses the exception is that the alternative is worse in a specific and checkable way:
an Asana PAT is unscoped and cannot be narrowed, so a card facing a gap has no sanctioned move
— and the thing an agent actually does next is go and read the vault itself, which on this
machine it can, since Credential Manager is readable by any process running as the user.
`processes.md` reaches the same conclusion about the WMI escape and states the rule: **the fix
for an escape is not detection, it is removing the reason to reach for it.** A sanctioned door
with a person standing in it beats an unsanctioned one with nobody.

#### What it hands over is a grant, not the secret

**The first cut returned the token as the tool result, and that was the wrong shape.** A tool
result is written to the session transcript on disk, in plain text, permanently — so approving
once put a copy of an unscoped credential in a file nothing can edit afterwards, and Volery's
own *forget it* stopped being enough, because clearing the vault removes Volery's copy and not
that one. Masking it in `toolcall.ts` was considered and refused for the right reason (the bytes
would still be on disk, so the reading would only *look* safer — `checkFailed`'s argument about
being wrong in the reassuring direction), but refusing the theatre is not the same as fixing the
leak.

**The fix is that the token never enters the conversation at all.** What the settle records is a
row in `secret_grant`; what a granted card gets is `ASANA_ACCESS_TOKEN` **in its process
environment**, set by `spawn_now`. Every Bash, PowerShell and script call a card makes is a
child of that process and inherits it, so a script reaches for `os.environ` and finds it without
being told — which is most of the value over a tool result the agent has to remember to thread
through by hand.

Three things were probed on 2026-09-04 against claude 2.1.241 before any of this was built, and
each one decided a line of it:

- **`env` in a `--settings` file does reach the shell tool.** It is nevertheless *not* the route
  used, and this is the load-bearing negative result: `supervisor` passes `--settings` as an
  inline JSON **argument**, so a token in it would sit in `claude.exe`'s command line, which any
  process on this machine can read. An environment block needs debug rights. Same secret, two
  hiding places, and only one of them is one.
- **A variable set on the `claude` process reaches the shell tool** (`GOT=inherited-…` came back
  through it). That is the mechanism.
- **`curl`, Python and Node all reach `app.asana.com`** and get a 401 rather than a TLS failure,
  because `CURL_CA_BUNDLE`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` are set in this
  environment. Unlike `az` against `dev.azure.com` there is no certificate wall, so a card can
  genuinely use the thing it was given.

#### An environment can only be set at spawn, and that is the whole of the awkwardness

There is no supported way to change a running process's environment on Windows. Two consequences
follow and both are stated in the code rather than left to be discovered:

- **The turn that asks cannot see it.** Its process started before the user agreed. Telling the
  card *"granted, now end your turn and come back"* would be a feature nobody uses at the moment
  they need it — so `hooks::serve_secret` exists: `volery --secret asana --card <id> --db <path>`
  prints the token to stdout, and prints **nothing at all** unless the wall's own database says
  that card was granted it. The answer to the asking turn is a one-line `export …=$(…)` built
  with the real paths, so the card has something to run rather than a shape to assemble. It is
  the same "this binary is also a subprocess its cards invoke" pattern `--bash-hook` already
  establishes, and it opens the database **read-only** for `sweep`'s reason.
- **A grant taken back does not reach a live process either.** That is why there is no revoke
  command aimed at a running card — it would be a button that did nothing visible for the rest
  of the session. `--secret` re-reads the grant on every call, so *that* half is immediate.

#### The grant dies with the card, and both endings delete it

`secret_grant` is keyed on `(conversation_id, service)`. **A row is a grant and its absence is
the whole of the refusal**, which is what keeps three readers — the settle that writes it,
`spawn_now`, and `--secret` — agreeing about one fact with no state machine between them.

- **Closing deletes it explicitly, because the cascade does not fire.** A close here is *soft* —
  `closed_at` is set and the row stays — so `ON DELETE CASCADE` never runs, and a grant left
  behind would sit in the table for the life of the database and be handed straight back if that
  session were ever adopted onto the wall again. The cascade is still worth having for the one
  path that really removes a conversation row (forgetting a project), where nothing else would.
- **Clearing deletes it too**, in the same lock as `clear_row`. A cleared card keeps its id and
  takes a new session, which is a different conversation in every sense this matters for: the
  agent that was granted the token has no memory of asking, and the person who agreed was
  agreeing to what *that* conversation said it needed it for.
- **There is deliberately no expiry and no revoke button.** Asked and answered: once granted,
  taking it back is closing or clearing the card. The distinction between "until revoked" and
  "until the card ends" turned out to be almost nothing anyway — a closed card never spawns
  again, so a grant that outlived it would be inert — and the only real difference was the
  ability to un-grant a card you wanted to keep working with, which is not a motion worth a
  panel.
- **`secret_granted` answers `false` on every failure.** A missing table, a locked database, a
  row from a future build: none of them is evidence that the user said yes, and this is the one
  read in the file where being wrong in the permissive direction hands out a credential on the
  strength of an error.
- **`reason` is stored and nothing reads it to decide anything.** It is there so that *"why does
  this card have my Asana token"* has an answer that is not "somebody clicked yes once", which
  is the question a grant with no expiry eventually gets asked.

What is **not** a leak, stated so nobody widens the warning past what is true: another card
cannot read it. `relay::recall` folds only `assistant` speech out of a transcript and never tool
results (`speeches_from` rejects any line without `"assistant"` in it) — and now there is
nothing in the transcript to read either way.

Four more things decided rather than fallen into:

- **`reason` is required, and a call without one is refused before anybody is asked.** It is
  shown verbatim and is the whole of what the user decides on; *"to work with Asana"* is not a
  decision anybody can take. Refused ahead of the network too, so a malformed call costs no
  request.
- **The identity is resolved before the question.** `GET /users/me`, the same probe
  `creds::probe_asana` makes, so the question can name **whose** account is being handed over —
  a token minted on the wrong account is accepted and then sees nothing, which is the failure
  that reads as an empty result rather than an error. It also catches a stored token that is
  already dead, which is a refusal rather than a question.
- **The buttons are `hand it over` / `keep it`, not the writes' `do it`.** Two questions that
  are not the same act must not share a word, or a habit built on six confirmations carries
  somebody through the seventh. `approved` takes the label it is matching, and
  `the_token_takes_its_own_word_and_not_the_writes_one` asserts both directions — passing the
  wrong constant is a call that compiles perfectly.
- **A chat card is refused in two places.** `docket::permitted` denies it the tools, and
  `spawn_now` will not put the variable in its environment either. A capability that depends on
  one check is a capability one edit away from being ungated, and this is the card kind whose
  whole claim is that it can reach nothing on this machine.

**The schema tells the card to look before it asks**, because the grant now outlives the turn:
`ASANA_ACCESS_TOKEN` is already set on every turn after the first, so an agent that re-asked
each time would be putting a credential question in front of somebody repeatedly — which is how
an approval stops meaning anything. That sentence is one of the four the schema test guards.

### Where it sits, and what is proven

All three are on the **discoverable** tier with search hints in `ask::roster`, on the argument
that tier is for: a card knows from its prompt whether it is working on a ticket, and the
overwhelming majority of turns on this wall touch none of them. Two collisions were fixed at
the hint rather than discovered later — **`take` and `done` are the sink's** and own the plain
words `claim` and `tick it off`, so every hint here is qualified `asana`, `board`, `ticket` or
`column`; and `tasks` has to out-rank Claude Code's own `Task`/`TaskOutput`, which are
subagents, so the hint names Asana and an assignee in the first breath.

**`asana_token`'s hint deliberately claims none of the ordinary verbs.** It carries
`attachment`, `subtask`, `portfolio`, `webhook` and *"the task tool cannot do this"* — the
words in the hand of a card that has already hit the wall — because a card searching *"create
an asana task"* must land on `task`, which asks for one thing, and not on the tool that hands
over the whole account.

`classify.ts` says **wants to** for every action of `task`, not just the destructive ones,
because every one of them parks — a past tense would be the transcript claiming an outcome
while the question is still up.

`bun tools/lift-docket.ts` runs 16 assertions for real on a machine with no MSVC, which is the
rule `build.md` states: **`approved` is the whole of the gate**, and neither direction of it is
visible to a typecheck. A version returning `true` for every answer compiles, passes
`check-gnu`, and hands every agent on the wall the user's whole Asana account.

Two of those assertions guard things a typecheck cannot see at all. `approved` takes the label
it matches, so a write's yes and the token's yes are different strings *by convention* — passing
the wrong constant compiles perfectly, and only the test says the token still refuses a write's
`do it`. And `TOKEN_ENV` is asserted to be the literal `ASANA_ACCESS_TOKEN`, because a
house-style rename there would be silent: everything still compiles, the variable is still
exported, and every Asana client on the machine stops finding it.

**No request has ever been made through these tools.** The readings reuse the wire the widgets
exercise daily, so those are as proven as the widgets are; the six writes — `put`, `delete`,
`/tasks`, `/sections/{gid}/addTask` from a card, `/tasks/{gid}/stories` — have never touched
Asana, and neither has `asana_token`'s `/users/me` probe, and at the time of writing **there is
no Asana PAT in this machine's vault** (checked 2026-09-04: `dev.skein.studio/asana-pat` is
absent). Recorded here rather than discovered later for the reason `4951f398` exists: a feature
green on every gate and never once run is a known unknown, and saying so is the only thing that
keeps it one. The first real call is the test.

**And the grant path has its own unrun half, which is the one to check first.** The three probes
above establish that a variable set on the `claude` process reaches the shell tool — they were
run against a bare `claude`, not against a card Volery spawned, and not once through
`spawn_now`'s own arm. So what is proven is the *mechanism* and not this wiring of it. Nor has
`--secret` ever been invoked: the arm is in `intercept`, it typechecks, and no shell has run it.
When there is a PAT to try, the order is (1) grant on a card, (2) `echo $ASANA_ACCESS_TOKEN` in
a **new** turn, (3) the `--secret` line from the approval answer in the *same* turn, (4) close
the card and confirm the row is gone.

**One thing no gate here can check at all**: whether an agent honours *never print it*. Nothing
in Volery enforces that — the schema says it three times and the answer says it again. The
transcript is where it would show, and it is worth a glance at the card's own reply after a
first approval. That risk is much smaller than it was, though, and worth stating as the reason
the redesign was worth doing: **the token is no longer in the transcript by default, only by an
agent's mistake.** Before, it was there by design.

**And a migration, which means the usual hazard applies.** Schema v31 adds `secret_grant`. Per
CLAUDE.md, `bun run tauri dev` opens the *real* wall and `store::may_migrate` refuses to carry
a debug build's schema forward — so this rung is the installed build's to run, and `bun run lab`
is where one gets developed against a copy.
