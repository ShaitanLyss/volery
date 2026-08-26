---
paths:
  - "src-tauri/src/guidance.rs"
  - "src/lib/guidance.ts"
  - "src/lib/Guidance.svelte"
  - "test/guidance.test.ts"
  - "tools/probe-guidance.ts"
---

# Standing instructions

What you would otherwise say at the top of every conversation, said once. Two reaches:
the **wall's** go to every card standing on it, the **territory's** go to the cards
standing in it. "My name is Lyss, I have ADHD, lead with the answer" is the first kind —
a fact about the person at the keyboard, which does not stop being true when a card is
dragged from one territory to another. "This repository is read-only to you", "run
`bun run check` before you claim it builds" is the second — a fact about a body of work.

**There is deliberately no per-card scope.** A thing you want to tell one card is a thing
you can already tell it, by telling it, and it remembers. The whole value of these two is
that they outlive the card: a wall's instruction is still there after you have closed
every card on it, and a territory's is waiting for the card you open in it next week.

### It is a system prompt, and the three alternatives are all worse

`--append-system-prompt`, one flag, composed in `guidance::compose` and passed in
`supervisor::spawn_now` beside the `--settings` layer. What was considered instead:

- **Writing a `CLAUDE.md`.** This app does not write to the user's repository. A
  project-level instruction arriving as a tracked file ends up in a commit and then in a
  colleague's checkout, and "read-only to you" is not a thing to put in somebody else's
  working tree. It is the same argument `hooks.rs` makes about never editing
  `~/.claude/settings.json`, one directory over.
- **A `SessionStart` hook emitting `additionalContext`.** Works, and puts the text in the
  **transcript**, where it accumulates: Skein spawns a process per wake, so a card woken
  fifty times over a week carries fifty copies of your instructions in its own history
  and pays for all of them on every turn.
- **A `UserPromptSubmit` hook.** The same accumulation, once per turn instead of once per
  wake.

The system prompt is the one place a standing instruction can sit without being said
twice. It costs no transcript, no tokens per turn, and nothing has to be rewritten when
you edit it.

### What was probed, and what it returned

`tools/probe-guidance.ts`, 2026-08-26, against claude 2.1.233 on Windows, on Skein's exact
argv. Two claims, because the whole feature rests on them and neither is in the help text:

```
pass 1  fresh session, both scopes composed into one flag
        → "WALLOK  Your git user is MoonLyss…  PROJOK"     both reached the model
pass 2  same session --resume, a different --append-system-prompt
        → "SECONDRUN  Goodbye, take care."                 the new text replaced the old
```

The second is the one the panel makes a promise about. Skein passes `--resume` on every
wake, so "your edit takes effect the next time this card starts a process" is only true
because a resumed session is handed the flag afresh rather than reusing what the session
was started with. If that ever changes, the panel is telling somebody something untrue
about their own instructions — and it is the one lie this feature can tell that nobody
would catch, because you cannot see a system prompt from outside. Hence a probe rather
than a comment.

### A card already running does not hear an edit

Its text was fixed when its process started. The edit lands on the next start: a wake from
dormant, a clear, an account transition, a restart. The panel says so — in the note, and
again in the foot against the count of cards it is currently true of — because otherwise
this is discovered as a bug, in the worst possible shape: you write "keep answers short",
the card in front of you goes on writing long ones, and there is nothing on screen to
explain it.

**Nothing here restarts a live card to apply an edit**, and that is a decision rather than
an omission. It would throw away a turn in flight for a change to a preference, and the
standing rule on this wall is that a card's process is yours to end.

### Read from the store, never passed in

`guidance::for_conversation` asks the database, inside `spawn_now`, exactly like
`kind_of`, `setup_of` and `worktree_of` on the lines above it. `.claude/rules/chat.md` has
the argument in full and this is the fourth iteration of it: `open` and `wake` both reach
that line, and a thing travelling as an argument is a thing every future call site has to
remember. The failure it avoids is not a card that starts wrong — it is every dormant card
on the wall coming back from a launch rouse with its project's instructions quietly
missing, at once, with nobody watching.

Every read fails soft to "nothing". A missing row, an unreadable column, a lock that could
not be taken: all of them mean an instruction is absent, and a card that starts without one
is recoverable in a way a card that will not start is not.

### Where the two live, and why not in one table

Schema v23. A project's are a column on its own row, `project.instructions`, because they
are a property of that project — `forget_project`'s existing cascade takes them with it and
no second delete has to remember. The wall's are `wall_guidance`, a singleton with
`CHECK (id = 1)`, the shape `window_frame` and `pomodoro` already use here.

One `guidance(scope, project_id)` table shaped like `notice` was rejected: the wall's row
would key on a NULL `project_id`, and **SQLite counts NULLs as distinct inside a PRIMARY
KEY**. That is a uniqueness constraint that does not constrain, which is worse than either
of the other two options because it looks like it holds.

Both travel in `load_studio`'s snapshot rather than behind a command of their own — the
panel lists every territory with a mark against the ones that are saying something, and a
round trip per territory to draw that list is a list that fills in.

### These are instructions, not a lock

Worth stating because "this project is read-only" is the first thing anybody writes here,
and it was the first thing asked for. A project card spawns with
`--dangerously-skip-permissions`, so what is written here is read and followed, not
enforced: nothing in this subsystem refuses a tool call. Enforcement would be
`permissions.deny` rules in the `--settings` layer `hooks::settings` already builds, which
is a different feature with a vocabulary of its own to settle — does `git commit` count as
an edit, does `bun run test`. It has not been built, and the sink has the design.

### The limit, and why there is one

`guidance::LIMIT`, 4000 characters per scope, mirrored in `guidance.ts` where the panel
counts down against it. The text goes on the child's command line and Windows'
`CreateProcess` takes 32767 UTF-16 units for the *whole* of an argv that also holds a
settings JSON, a resume id and an absolute path to the CLI. Two scopes at the limit plus
the composed frame is under 9k — a factor of three, and the failure it prevents is the bad
one: a spawn that fails with an OS error naming nothing.

Rust enforces it and the panel counts, so nobody meets it by being truncated. Both count
**characters**, not UTF-16 units: a counter that disagrees with the limit it counts against
reads as the app losing your text, and somebody's instructions are exactly where an em dash
or an accented name turns up.

### The frame around the text is doing work

`compose` does not just concatenate. It says the instructions came **from the person**, so
they are not read as something the harness wants; it names **which scope** each came from,
so an instruction that surprises you can be traced back to where you wrote it without
opening two panels; and it settles **precedence** — the narrower scope wins — because the
alternative is the model guessing, and the case is not hypothetical. A wall that says "keep
going, don't check in" against a project that says "ask before you touch anything" is a
pair most people would write within a week of having this.

Neither scope set means **no argument at all**, not an empty one.

### The panel's own judgements

- **One panel, every scope.** The rail on the left is the list of reaches, the column on
  the right is whichever you are writing. Two panels would be two places to look when an
  instruction surprises you.
- **Drafts survive switching rails.** A textarea whose contents vanish because you clicked
  another row to check what it said is a textarea you stop typing long things into. The
  rail marks the scopes with unsaved work, and Escape with any of them outstanding arms
  once rather than discarding.
- **`changed` is one function, in `guidance.ts`.** A draft in a textarea and a string in
  SQLite differ constantly in ways nobody typed — a trailing newline from hitting Enter
  before Save, a leading space from a paste — and a Save button that lights up for those is
  a button that always looks like there is work to do. What is compared is what would be
  sent, so the two cannot drift.
- **What is written back into hand is what Rust *stored***, not the draft. `clip` may have
  shortened it, and a panel that goes on showing its own draft would be showing text no
  card will ever be handed.
- **The menu entry has one label at each scope**, set or unset. The obvious alternative —
  two labels, the shape `glassItem` and `aside` use — is wrong here: those are one state
  with two sides where only one gesture is available at a time. This is one gesture opening
  one panel, and a menu entry that renames itself according to its own contents is one you
  cannot learn the position of.

### They travel, and they are only ever topped up

`portage.ts`'s line is that furniture travels and work does not, and standing instructions
are furniture by that test — they are how the room is arranged, not what has been said in
it. They are also the only piece of furniture that is *words* rather than a rectangle, and
that is what made the wall's scope a real question rather than one more field.

Both travel: `Carried.guidance` for the wall's, `CarriedProject.instructions` for a
territory's. A carried set is applied **only where this wall has none**, both scopes, one
rule. The argument is that there is exactly one wall guidance, so applying a carried one
over a set one is *replacing* it — the single thing `portage.ts`'s header promises an
import never does. The ambience switch is the nearest precedent for changing something
already on screen and it does not carry: switching ambience changes a setting you can
change back, where this would destroy prose somebody wrote.

So a wall with nothing set gains them, which is the case that matters — a new machine, and
"my name is Lyss, I have ADHD" is exactly the thing you should not have to type twice. A
wall already saying something keeps saying it, and the document's version is named in the
import's `skipped` list rather than dropped quietly. Clearing yours and importing again is
the way to take theirs.

The same rule at both scopes on purpose. One policy is explicable; "the wall's is kept but
a territory's is overwritten" is a thing nobody could predict from outside.

`LAYOUT_VERSION` is **not** bumped for this. The header is explicit that the version marks
changes of *meaning*, not of shape, and `readLayout` is lenient by design: a document
written before this reads back with `""` at both scopes, and an older build reading a newer
document ignores two keys it does not know. `test/portage.test.ts` pins the
document-from-before-this case, because it is every layout anybody has already exported and
`tally` calls `.trim()` on both.

One thing fell out of doing this that was a bug on its own: `settle` reached
`ensure_project` directly and stopped there, so a carried territory was a row on disk the
wall did not know about until the next launch. `Skein.learnProject` is the three lines
`#openIn` has always had inline, now shared, and the import calls it.
