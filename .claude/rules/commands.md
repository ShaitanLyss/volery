---
paths:
  - "src/lib/commands.ts"
  - "src/lib/Dock.svelte"
  - "src/lib/field.svelte.ts"
  - "src-tauri/src/slash.rs"
  - "test/commands.test.ts"
---

# Slash commands, and clearing a card

### Slash commands, and clearing a card

The dock reads `/`-prefixed drafts as commands. `commands.ts` is pure and owns the
vocabulary and what a half-typed draft matches; `field.svelte.ts` holds the palette's state and
one arm per command — the same split as `menu.ts` and `ContextMenu.svelte`. Adding a command
is one entry in `COMMANDS` and one arm in `runCommand`.

- **Skein reads only its own names, and this is a safety property rather than a
  simplification.** `claude` has slash commands of its own — the built-ins and everything in
  `.claude/commands/` — and they work in `--print` mode, so a prompt beginning with a slash
  is ordinary traffic. `/commit` is the project's command and has to reach the agent unread.
  An unknown name therefore matches nothing, opens no palette, and is sent as the prompt it
  is; swallowing it would silently break every custom command anybody has written, and the
  failure would look like the agent ignoring them.
- **The palette is for choosing, so it closes at the first space.** Left open while
  arguments are typed it would sit there claiming a choice is still to be made. Enter runs
  the lit entry (`/cle` + Enter clears, as in the CLI), Tab completes without running, Escape
  dismisses and *keeps the text* — a draft starting with a slash is a perfectly ordinary
  thing to say to an agent, and that is the way to say it.
- **A command reaches as far as a prompt does and costs the same modifier.** Clearing five
  gathered cards at once must not be easier than talking to them.

#### Three vocabularies under one slash

`COMMANDS` is fixed because it is *this window's* vocabulary. What the agent answers to is
not, and the palette offers both:

| what | where it comes from | read by | may sit |
|---|---|---|---|
| Volery's own | `COMMANDS`, fixed | this window | head only |
| the CLI's own built-ins | `initialize`, asked | the CLI | head only |
| the project's own `.claude/commands/` | `initialize`, asked | the CLI | head only |
| every skill, plugin ones included | `initialize`, asked | **the model** | anywhere |

`slash.rs` fetches the bottom three as one list; `paletteExtras` composes it and
`matchCommands` decides which of it is reachable from where the caret is. Ordering is the
CLI's own, which puts a project's commands first and then the skills and then the built-ins —
locality, and a habit people already have from the CLI itself. Volery's own names win any
collision and the first of any duplicate wins the rest.

#### Asking the CLI what it answers to, rather than working it out

`control_request { subtype: "initialize" }` on a `claude`'s stdin comes back with
`commands: [{ name, description, argumentHint, aliases }]` — 57 of them here, 60 in a project
keeping three of its own. Probed 2026-09-07 against claude 2.1.233 with
`tools/probe-skills.ts initialize`:

```text
1.22s  57 commands   stdin left open, trusted directory
1.32s  57 commands   stdin closed straight after the write
1.24s  57 commands   a fresh directory nobody has ever trusted, no flags
```

**This replaced two designs that were here first, and both were the same mistake.** The first
walked `.claude/commands/` and parsed frontmatter — 400 lines of Rust to arrive at a worse
version of one field, when the CLI reports `deep/nested.md` as `deep:nested` with
`argumentHint: "branch"` read out of its `argument-hint:` and gives a file with no frontmatter
at all a description off its first line. The second stored what `system/init` had said in a
schema column (v31, `skills_json`), because init only arrives after a card's first message and
the palette is wanted before it — a request that answers in 1.2 seconds needs no column, and
the rung was reverted. Neither had been checked against `claude --help` or the control route's
own subtype union, both of which were already written down in this repository.

The lesson generalises past this feature and is the one `turns.md` records about the
task-notification events: **when something is already publishing the answer, the work is
finding where it says it — not reconstructing it.** Ask what the thing tells you before
deciding what to derive.

- **Descriptions for everything, built-ins included.** That was the sentence an earlier
  version of this rule could not write: the CLI's own skills live inside a 320MB binary and
  are on disk nowhere, so a hand-rolled palette could only ever say where a row *came from*.
  The CLI also tags provenance into the description itself — `"… (project)"`,
  `"(tx-toolkit) …"`, `"(dynamic workflow)"` — so that comes free rather than being derived
  from the shape of a name.
- **`argumentHint` is carried and drawn, and is deliberately not `takesText`.** That flag makes
  a row *incomplete*, so Enter would open a space rather than send; `/loop` takes an interval
  and is perfectly runnable without one. All the hint decides is whether a completion leaves a
  space to write in, and it is drawn beside the name in mono — it is the shape of the line you
  are about to write, not prose about what the thing does.
- **`aliases` are matched but never drawn.** `review` finds `code-review`, `committee` finds
  `tx-toolkit:committee` — which is the only part of that name anybody types, and it is
  *published* rather than something the contains-match has to fake. An alias is a way to find a
  name; listing them would put five rows in front of you for one thing, and it is the canonical
  name that gets sent, so what you pick is what the agent sees.
- **A throwaway process, not a question down a live card's stdin.** Asking the card's own child
  would be free, but only for a card that *has* one — and the whole point is the palette
  working before you have said anything to a dormant card. One mechanism that always works
  beats two that each half do, and the cost is one short-lived process per directory per
  session.
- **Minimal argv and no bypass flag.** The process never runs a tool, and the probe shows an
  untrusted directory answers without one. Stdin is closed straight after the request, so
  anything that ever did want to ask a question reads EOF and exits rather than parking on a
  prompt nobody can see — the standing rule that a background read must never ask one, made
  structural rather than argued.
- **Asked once per directory, for the life of the wall** (`Skein.learnSlash` / `slashFor`).
  A one-shot read like the finder's file list, not a fourth poller. The trade is explicit: a
  command file added while the app is up is not offered until the next launch. `learnSlash`
  asks and `slashFor` only reads, so nothing can start a spawn from inside a `$derived`.
- **A failure is recorded as "nothing".** A project the request failed for and one with nothing
  to offer draw the same palette, and neither is worth a fault on the wall.
- **A refusal is an answer.** `commands_from` returns an empty list for a `subtype: "error"`
  reply rather than `None`, or the reader would sit until the twenty-second timeout on a
  request that had already been declined.
- **Descriptions are cut to a line in Rust**, not in CSS — `tx-toolkit:design-system`'s real
  one is 300-odd characters, and a palette measuring a string it then hides is doing the work
  twice. Cut on a word where there is one.


#### And the slash stopped having to lead

`slashAt` finds the slash-name the *caret* is in rather than matching the whole draft, so
`make a chart with /dat` opens the palette and completes in place. The reason is a difference
in kind rather than convenience, and it is the one thing `initialize` does not tell us:
Volery's own commands are carried out here, and the CLI's built-ins and a project's command
files are *parsed by the CLI*, so none of the three means anything except at the head of a
prompt. A skill is parsed by nothing — the model reads the prompt and invokes it through the
`Skill` tool (`tools/probe-skill.ts` caught the whole shape: a `tool_result` saying "Launching
skill: …", then the skill's own text injected as a `user` message) — so its name is prose and
may sit anywhere. `by === "skill"` is the whole test.

- **The label of which names are skills comes from `system/init`**, folded per card
  (`Conversation.skills`), because the `initialize` reply does not distinguish a skill from a
  built-in. Init arrives with a card's first turn.
- **Not knowing yet means offering *more*, not less.** A card that has taken no turn has no
  `skills` array, and `paletteExtras` then treats every row as mid-line-eligible. Picking a
  command inside a sentence only ever *inserts its text* — Enter completes rather than runs
  once there is prose around it — so the cost of being wrong that way is a row you did not
  want, where the cost the other way is the whole feature missing on a fresh card.
  `skillsKnown` is the flag rather than `skills.length`, because a card whose agent genuinely
  has no skills is a real answer and must narrow the palette exactly as a populated one does.
- **The slash must begin a word, and that is the whole guard.** `src/lib/clear.ts`, `and/or`,
  `12/3`, `C:/Users` and `https://example.com/dataviz` all contain one and none of them opens
  anything. A leading space still says prose for the *head* case — `resolveCommand` refuses
  ` /clear` — but it cannot say so here, since a slash inside a line is by definition preceded
  by one. What separates the two is `span.from`: zero is a command being typed, anything else
  is a word in a sentence.
- **Enter runs what is lit only when the name is the whole draft**, and completes it otherwise
  (`spansWhole`, `Field.whole`). Running the lit entry over `make a chart with /dat` would
  send `/dataviz` and throw away everything in front of it. At that row Enter and Tab agree,
  which is exactly what they already do on a command that has not been given its value.
- **And only when Enter may *claim* the lit row, which is a rule the big palette
  forced.** `/cle` + Enter clears — an abbreviation of one of our nine, documented and
  worth having. `/commit` + Enter must send `/commit`, because it is the project's own
  command and the rule at the top of this file says it reaches the agent unread. It very
  nearly stopped doing so: `committee` is the alias the CLI publishes for
  `tx-toolkit:committee`, `"committee".startsWith("commit")`, and Enter would have run a
  skill nobody named. Prefix-versus-containing does not separate those — both are prefix
  hits. **Whose catalogue the row is from** does: `COMMANDS` is nine closed names this
  window owns and whoever is typing knows, so a prefix there is an abbreviation, while the
  agent's vocabulary is open and different per directory, so a prefix there can silently be
  a different command from the one you typed in full. `mayRunOn` is that rule — abbreviation
  for ours, exactness for theirs, and the alias counts as the name. Nothing is narrowed and
  nothing hidden either way: the row is drawn, Tab takes it, the arrows reach it, and when
  Enter declines the draft goes to the agent as the words it is.
- **The name is the whole token, wherever inside it the caret sits**, which is what makes a
  stale caret harmless: every position inside a token gives one answer. `Field.caret` is
  `null` for "wherever the text ends" — both the honest reading of a caret nothing has
  reported and precisely what this behaved as before there was one — and every write that
  replaces the whole line goes through `Field.put`, which puts it back to null. A caret
  measured against a sentence that no longer exists is how a palette ends up matching a word
  nobody can see.
- **A skill's completion carries a space** even with no `argumentHint`: it takes whatever you
  say after it whether or not the CLI described that, and it is the one kind of row completed
  mid-sentence, where the space is the difference between carrying on and reaching for the
  spacebar first.
- **The palette scrolls and does not cap.** Volery's nine plus everything the agent answers to
  came to 66 rows on the wall this was written for. A list that silently stops at ten says a
  card has no name that it does have; `Dock.svelte` keeps the lit row in view and the detail
  line is stuck to the bottom, since it describes a row you are looking at.

`snapshot.cards[]` carries `skills` and `skillsKnown`, because from outside a card that has
been told its skills and one that has not look identical in the palette — and only the flag
says which narrowing is in force.


#### The CLI's own commands, offered but not taken

`/compact`, `/model` and `/effort` are in the palette and **Skein carries out none of them**.
`by: "cli"` marks them: the palette offers them, completes them, and then sends the text you
typed as the prompt it always was. So the vocabulary grew without this file taking custody of
a single one — the rule above is extended rather than bent, and `resolveCommand` still
answers only for `/clear`.

Probed 2026-08-14 against claude 2.1.232 with `tools/probe-commands.ts`, spawning with
Skein's exact argv and sending each as a `user` message on stdin:

```text
/compact       system/status "compacting", a status carrying compact_result,
               then a fresh system/init and a result
/model sonnet  result.result "Set model to Sonnet 5 for this session only"
/effort high   result.result "Set effort level to high (this session only): …"
/rewind        result.result "/rewind isn't available in this environment."
```

The same probe asked the *other* route and got `Unsupported control request subtype` for
`compact`, `rewind` and `set_effort`. `set_model` **is** on that route and succeeds — and is
deliberately not used: sending the text leaves a line in the transcript saying what you did,
where a control message changes the model with nothing to show for it. (The dispatcher's full
union, read out of the binary: `set_permission_mode`, `set_max_thinking_tokens`,
`mcp_oauth_callback_url`, `interrupt`, `set_color`, `mcp_status`, `mcp_reconnect`,
`file_suggestions`, `get_usage`, `initialize`, `get_context_usage`, `mcp_authenticate`,
`read_file`, `set_model`, `rename_session`.)

- **A command with a fixed set of values keeps the palette up past the space, and that is
  the closing rule holding rather than breaking.** The rule exists because the palette is for
  choosing; `/model` alone is not a thing that can be run, so the choosing is *not* over at
  the space and the values are offered (`typingChoice`, `matchChoices`). `/compact`, whose
  argument is prose, closes it exactly as everything did before. Past the second space it
  closes for the original reason.
- **Enter on such a command shows the values rather than running anything**, which is also
  what Tab does — at that row the two keys agree, because there is nothing yet to disagree
  about. `completionFor` gives it its trailing space for the same reason, or completing
  would strand you on a name that cannot be sent.
- **`cliCommand` recognises them without intercepting them.** Nothing is swallowed on the
  strength of it; it answers the two places the difference shows. A card is named after the
  first thing you *say*, and `/model sonnet` is not said to the agent — so `#deliver` does
  not name a card from one, and the card face withholds the same draft while you type it.
  Those two must agree or the face previews a name the send never gives it.
- **The values are the aliases the binary actually takes**, `opus[1m]` and `sonnet[1m]`
  included — the ones that earn their place on this wall in particular, since the context
  ring is drawn against the window tier and switching is the gesture for a card running out
  of room. `opusplan` is left off: it is plan mode's upgrade model, and every card here
  spawns with permissions bypassed.
- **A locally-answered turn has to be *drawn*, or the gesture looks like it failed.** The
  whole reply is one line in `result.result` and the only `assistant` message is a
  `<synthetic>` one with empty content, so the card showed the prompt, nothing after it, and
  settled at rest. `classify.ts::localAnswer` reads it, keyed on `num_turns === 0` — which
  counts round trips to a model, so zero means nothing was asked of one. Pushed as `meta`:
  it is the CLI talking about the conversation, the same voice as the stop note and the
  resume note. Deliberately not consulted for an errored turn, where `endingFor` already
  reads `result.result` as the detail and drawing it twice would print one sentence as both
  a note and a fault.
- **`<synthetic>` must not be read as a model or as occupancy, and it was.** That message
  carries an all-zero `usage`, and `contextWindowFor("<synthetic>")` is 200k — so a 1M card
  quietly lost two thirds of its ring, began calling its model `<synthetic>`, and then had
  the ring dropped to nothing by the zero usage. Every local command emits one, and so does
  a turn refused for rate limits, which is how it was found. Anything it actually said is
  still drawn; only the arithmetic skips it.
- **A compaction is the one local command that takes real time, and the one that says least
  about itself.** Probed end to end with `tools/probe-compact.ts` (claude 2.1.232, Skein's
  exact argv). A manual `/compact` over a four-turn context took **65 seconds** and put
  **exactly two events** on the wire:

  ```text
   44.96s  system/status  status:"compacting"
  110.08s  system/status  status:null, compact_result:"success"
  110.09s  result         num_turns:0, all-zero usage
  ```

  Nothing between them. No deltas, no `compact_boundary`, no summary — the probe also watched
  the whole *next* turn, which carried only `system/init`, `status:"requesting"`, the replayed
  prompt and an ordinary answer. **The boundary and the summary are written to the session
  file and never reach stdout on this path**, which is why `history.ts` is where both are read.

  So there is nothing to draw but the wait itself. `status:"compacting"` is folded narrowly,
  since `status` also carries `requesting` on every ordinary turn where the deltas arriving
  underneath are the better account.

- **The progress bar the TUI shows cannot be mirrored, and it is worth knowing exactly why**
  rather than concluding it twice. Two internal event types feed it — `compact_progress`,
  whose payload is phases (`hooks_start` → "Running PreCompact hooks…", `compact_start`,
  `compact_end`), and `response_length`, which drives the climbing token counter. Both are in
  `dav`/`pav`, the set the SDK path filters out of its message stream, and `compact_progress`
  is routed straight to `onCompactEvent`, which *is* the TUI status line. The animation is a
  shimmer sweep over "Compacting conversation…" plus an elapsed clock off `compactingStartTime`
  — not a determinate bar over known work. Of those, elapsed is the only part derivable here,
  and it is what the card counts.

- **A manual `/compact` writes four `user` records to the session file and marks one.** Only
  the caveat carries `isMeta`; `<command-name>`/`<command-message>`/`<command-args>` and
  `<local-command-stdout>` carry nothing at all — see `.claude/rules/panel.md`.
- **`/resume` is offered and is *Skein's*, which is the one case where the CLI refusing a
  name is an argument for keeping it rather than dropping it.** Probed 2026-08-20 with
  `tools/probe-commands.ts resume`: `result.result` is `/resume isn't available in this
  environment.`, `num_turns` 0, a `<synthetic>` message — word for word what `/rewind` gives.
  The difference is that this window can already do the thing. The CLI's `/resume` is a picker
  its TUI draws over the sessions on disk, and Skein reads those same files for the adoption
  panel, so the honest answer to typing it is to open that panel. `/rewind` had nowhere to go;
  this had somewhere to go all along and no name you could type to get there.
- **It is the first command that acts on no card, and `needsCard` stopped being the literal
  `true` for it.** Two things read the flag, and both were written for commands that reach
  cards: `runCommand` refuses an empty gathering, and the reach gate charges Ctrl+Enter past
  one target. Neither is right here. The sessions on disk are the same list whatever is
  standing in front of you, and a panel opens once however many cards you are pointed at — so
  refusing on an empty wall would be withholding a gesture that needs nothing, and charging
  the modifier would be friction scaled to a number that is always one. The dock drops the
  `5 cards` badge from the row for the same reason: it would be a claim about a gathering the
  command will not touch.
- **The field is still disabled with nothing on the wall**, which is a property of the dock
  and not of this command — the textarea has always said `Open a conversation first`. So on a
  genuinely empty wall the panel is still reached from the ground's right-click, and `/resume`
  is for the case you are already typing. Widening that is a separate argument about what the
  dock is for.
- **`opens` is a third small flag and deliberately not derived from `needsCard`.** It says the
  row puts something up to choose from, and all it does is earn the ellipsis — the menus' own
  convention for a gesture that leads somewhere further, which is why the item this shares its
  work with reads `adopt a recorded session…`. Reading it off `needsCard` would put an
  ellipsis on the next card-less command by accident, and those are two different claims.
- **Forced open rather than toggled.** `openImport` toggles, which is right for a button you
  press twice and wrong for a command: typing a name is a request for the panel and never a
  request to put it away. The gesture that would otherwise close it is the one already bound
  to Escape.

- **`/rewind` is not offered**, because the CLI refuses it in this environment — see the
  probe above. The binary does carry a hidden `--rewind-files <user-message-id>` flag
  ("Restore files to state at the specified user message and exit", requires `--resume`),
  which is a real headless route to the *file* half of it; nothing here uses it yet.

#### `/rename`, and the first command that takes prose

`/rename the auth work` calls the card that, and nothing takes the name back. It is Skein's
own in the strongest sense the palette has: a card's title is drawn here, stored here and
never travels down stdin, so unlike `/compact` there is nobody at the other end to ask.
`rename_session` **is** on the CLI's control route (it is in the dispatcher union above) and
is deliberately not used — it renames the *session*, which is a file on disk, and the thing
you are looking at when you rename a card is the card.

- **`takesText` is the other half of `choices`, and never both.** They are two answers to
  "this is not finished being chosen": one is a set to pick from, the other is something only
  you can supply. So the palette offers the values for the first and closes at the space for
  the second — `/rename` gets `/compact`'s treatment, since a palette left up while you write
  a name would be claiming a choice is still to be made.
- **It inverts exactly one clause of `resolveCommand` and no others.** The exact-and-whole
  rule is there because reading `/clear` out of `/clear the deck` would throw away the rest of
  what was typed; for a command whose argument *is* the point, everything past the name is the
  rest of what was typed, so there is nothing to throw away. Bare `/rename` resolves to
  nothing — it names nothing, and anything Skein cannot carry out falls through to the agent
  as the words it is. Enter on the lit row completes to `/rename ` rather than running, which
  is what `/model` already does and for the identical reason.
- **The argument is trimmed rather than trusted to the pattern.** The lazy group hands back a
  single space for `/rename    `, and an argument of one space is a command that resolves,
  swallows the draft and renames nothing — the one outcome the fall-through rule exists to
  prevent.
- **The card face previews the name, not the command.** Every other command is withheld from
  `previewDraft` because a command is not a name; this one *is* a name, and drawing
  `/rename the auth work` in the title line would preview something no card will ever wear.
  `titleFromPrompt` cuts the preview and `Skein.rename` cuts the commit, so the two agree —
  the same argument `#deliver` makes.
- **It needs a column, or it survives exactly one turn.** `#adoptAiTitle` runs at every
  settling `result`, reads the transcript's generated title and puts it back. Schema v13's
  `named_by_hand` is what stops it, and the failure it prevents is the nasty kind: a rename
  that comes undone a few minutes later, while you are looking somewhere else. A generated
  title beats a prompt's first line; it does not beat you.
- **`clear_row` unsets it, and is the only thing that does.** It goes back to the sentinel in
  the same statement, so a flag left standing would be a card refusing every name it could
  ever be given afterwards. That is why `update_conversation` needs nothing special for it:
  the column only ever arrives `true`, from the one gesture that sets it.
- **It reaches the gathering and costs the same modifier as a prompt**, like every command
  here. Renaming five cards to one word is a strange thing to want, but a rename that silently
  only took on the focused card would be the dock disagreeing with its own target line.

The control surface has a `rename` op, and `snapshot.cards[]` carries `namedByHand` beside
`title` — a card you named and a card the transcript happened to name the same thing are one
string from outside, and the whole of the difference is whether the next turn takes it back.

`/clear` is the first one, also on a card's right-click menu. There is no way to ask a
running `claude -p` to forget its context — the CLI's own `/clear` is a TUI gesture and never
reaches the stream — so the honest equivalent is to end the process and point the card at a
fresh session id.

- **The card and the session it holds are different things, and only now do they differ.**
  `conversation.id` is *the card* — its placement, its turns, its file touches all key on it
  and must survive — while `sessionId` is what `--session-id` / `--resume` take and what
  names the transcript on disk. They were the same value everywhere until clearing, which is
  why `Skein` used `c.id` for `read_transcript`, `read_ai_title` and `copy resume command`;
  all three are `c.sessionId` now, and getting one wrong means reading a file that is not
  this card's.
- **No migration.** `agent_session_id` has been in the schema since v1, is written by
  `record_conversation` and `import_row`, and is already returned by `load_studio` — it had
  simply never had a reason to differ from `id` and so was read by nobody.
- **`clear_conversation` is its own command rather than more parameters on
  `update_conversation`**, whose every column is COALESCEd so an absent argument leaves the
  old value alone. Clearing needs the opposite for three of them, and `last_ending` back to
  NULL is the whole point: the front end reads NULL as "never spoke", which is what makes the
  next spawn use `--session-id` rather than `--resume` against a transcript that does not
  exist yet.
- **`retiring` is set before the kill.** Killing a child on Windows gives it a non-zero exit
  code and `markExited` reads one of those as a crash, so clearing raced its own teardown and
  stamped "process exited with code 1" and a rust ending onto the fresh session that had just
  replaced it. The flag is cleared by whichever exit arrives, so the ordering does not matter;
  it is only set when there is a child to kill, or a later genuine crash would go unreported.
  `close` does not need it — that card leaves the wall.
- **Nothing is destroyed, which is why it is not a danger item.** The old transcript stays
  where Claude Code wrote it, so `adopt a recorded session…` puts it back on the wall as its
  own card. That makes `importable()` filter by `sessionId` rather than `id`: keyed on `id` a
  cleared card's own fresh session would be offered for adoption while it is standing there,
  and the session it was cleared away from would not be.
- **Offered only when there is something to clear** (`everSpoke || working`), not when there
  are lines on screen — a cleared card still carries its own "cleared" note, which would leave
  the item offered forever on a card with nothing left to clear. `working` earns its place:
  abandoning a first turn that is going wrong is exactly when this is wanted.

The control surface has a `clear` op, and `snapshot` carries each card's `sessionId` (the
only way to see from outside that a clear repointed it), the palette's current `commands`,
and its `choices` — reported apart, because the two stages are never both up and an empty
`commands` is otherwise a palette that is down and one that has moved on to the values.

### `/btw` — a question asked beside the conversation

*"Ask a quick side question without interrupting the main conversation"*, which is the CLI's
own description of `/btw` and is exactly what this does. Asked for by the user (sink bab5415f).

**It had to be rebuilt rather than passed through, and the measurement is the reason.** Read
out of the 2.1.241 binary on this machine, 2026-08-28: the string `"/btw"` sits inside a
`_d.jsxs(...)` call — the **Ink layer** — beside `"Side questions aren't available when viewing
a session read-only"` and `"This remote connection doesn't support side questions"`. Volery
drives `claude --print`, which has no Ink, so handing the CLI `/btw` as a prompt gets it read
as text. Every part needed to assemble it is published, though:

- **It forks.** The session context spreads `btwHistory: e.kind === "fork" ? e.root.btwHistory
  : new q4s`, and the fallback-model schema glosses `scope: "local"` as *"a subagent /
  side-question (/btw) / background fork fell back"*. `--fork-session` is that flag on the
  `--print` path, and it is what keeps the card's own transcript untouched. **That is the whole
  feature**: the answer costs a request and changes nothing about the conversation it was asked
  beside — no turn opened, nothing queued behind what the card is doing.
- **The framing is quoted verbatim, and the tag is closed.** `<system-reminder>This is a side
  question from the user. You must answer this question directly in a single response.` and
  then eight more clauses, ending `…information you have.</system-reminder>`. Not reworded,
  because those sentences are what keep the fork answering instead of picking up tools and
  working — and `--tools ""` is the half that makes it structural rather than a request.
  **The CLI closes nothing for us**: it emits the whole block as one literal and writes the
  question *after* the closing tag, which is what `ask` does here. This carried the first two
  sentences and no close for its first week — a `<system-reminder>` opened over the user's
  own question, with nothing anywhere saying where the reminder stopped (sink cc3a4f27). Read
  out of the 2.1.233 bundle on 2026-09-05, at `@168367992` and `@303183256`.
- **It is ephemeral, and that is a match rather than a shortcut.** `class q4s { exchanges = []
  … .slice(-20) }` is hung on the CLI's in-memory session context and written nowhere. So an
  aside here is in-memory too — which settles what would otherwise be a real question, since
  the card's own session file will never contain it and persisting it would mean a table of
  our own. `/btw`'s `detail` line says so, because "the answer is gone when the wall closes" is
  something to know before pressing it.

**Two line kinds of their own, `asked` and `aside`**, rather than `you` and `text`. Neither is
part of the conversation, so drawing them as a prompt and an answer would say it went somewhere
it did not. `answer` was already taken by the reply to a parked `ask_user`, which is a third
act again — that one is something you said *into* this conversation. Drawn set in from the
margin behind a rule, which is what "beside" looks like in a column where every other voice
starts at the edge.

**One at a time per card**, the way a second `!` replaces the first in `bang.rs`. `Asides`
hands out a generation per question and a superseded answer is *dropped* rather than delivered
late under a question it does not answer — and the card says it was replaced, because a
question that silently vanished is a card that appears to have forgotten it.

`aside.rs` has the rest: the job object (a `claude` child carries a `conhost` and `kill()`
reaches one process), the finite wait, the hard failure when the card's account is not signed
in rather than a quiet fall-through to whichever one is, and the refusal when a card has never
taken a turn — there is nothing to fork. `bun tools/lift-aside.ts` runs its five assertions.
