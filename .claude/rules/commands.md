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

`COMMANDS` is fixed because it is *this window's* vocabulary. Two others are not, and the
palette offers all three:

| what | where it comes from | read by | may sit |
|---|---|---|---|
| Volery's own | `COMMANDS`, fixed | this window | head only |
| the CLI's own | `COMMANDS`, `by: "cli"` | the CLI | head only |
| the project's own | `.claude/commands/**.md`, walked by `slash.rs` | the CLI | head only |
| the card's skills | `system/init`'s `skills`, folded | **the model** | anywhere |

`paletteExtras` composes the two dynamic ones and `matchCommands` decides which of them is
reachable from where the caret is. **Ordering is locality** — this window's, then the
project's, then the card's — which is also the order `system/init` lists them in, so it is a
habit people already have. Locality settles collisions too, by keeping the first of any name:
a project that writes its own `/code-review` shadows the skill of that name, and nothing
shadows `/clear`.

#### The project's own commands, walked rather than folded

`slash.rs` walks `<cwd>/.claude/commands/` and then `~/.claude/commands/`, and it is the only
one of the three vocabularies that touches a disk.

**It is walked even though the wire carries it, and the measurement is the reason.** Probed
2026-09-07 with `tools/probe-skills.ts` after seeding three files into a scratch project:
`slash_commands` came back with 60 names, ordered **project commands first, then the skills,
then the CLI's built-ins** — so the set wanted here is a *prefix* of that array. Taking it
would mean depending on the order of an undocumented list, which breaks without saying so.
Subtracting does not work either: `slash_commands − skills` still leaves ~30 built-ins, and
the only way to name those is a table of them, which goes stale the next time the CLI grows
one. A walk answers the question by construction.

- **And it brings something the wire has not got.** A command file may carry a
  `description:` in its frontmatter, so unlike a skill these rows say what they do in their
  author's own words. Where there is none the row says where it came from, which is what
  every skill's row says — the summary column is never empty.
- **Cross-checked against the CLI's own naming.** `bare.md`, `deep/nested.md` and `hello.md`
  enumerate to `bare`, `deep:nested` and `hello`, name for name what `slash_commands`
  reported. A subdirectory is a **colon**, the same spelling a plugin's skills use, which is
  why `NAME_CHAR` admits one.
- **`by: "cli"`, so nothing is intercepted.** This is the rule the file opens with, now with
  a way to *find* the commands it protects: `/commit` is the project's and reaches the agent
  unread. `resolveCommand` still answers only for Volery's own.
- **Head-only, unlike a skill**, because the CLI expands the file when a prompt *begins* with
  the name. `/commit` mid-sentence is text.
- **Not a YAML parser, deliberately.** One scalar out of a block whose shape the CLI
  documents, read out of the first 4KB. Every failure has the same harmless answer: a row
  that says where it came from instead of what it does. A `description:` past the closing
  `---` is prose about something else and is not taken.
- **Bounded on depth, count and bytes**, and the depth bound is there for the case a walk
  must never meet — a directory symlink pointing at its own parent, which is an error
  nowhere and would otherwise spin. `entry.file_type()` rather than `metadata`, so a symlink
  is seen as one.
- **Sorted, not in `read_dir` order.** A palette whose rows move when the same repo is
  opened on another machine is one nobody can build a habit on.
- **Asked once per directory, for the life of the wall** (`Skein.learnSlash` /
  `slashFor`). This is a one-shot read like the finder's file list, not a fourth poller — the
  architecture note is about things asked *repeatedly* because no event announces them. The
  trade is explicit: a command file added while the app is up is not offered until the next
  launch, and re-walking on every focus change would put a directory read behind a keystroke
  for a set that changes about once a month. `learnSlash` asks and `slashFor` only reads, so
  nothing can start a walk from inside a `$derived`.
- **A failure is recorded as "nothing".** A project with no commands and a directory that
  could not be read offer the same palette, and neither is worth a fault on the wall.

#### Skills, which are the agent's — and the slash that stopped having to lead

Which **skills** a card has depends on its directory, on which plugins are installed and
which of those are scoped to that project, and on the build of Claude Code behind it. So
nothing in `commands.ts` names one — they are folded off the wire, and `skillCommand` turns a
name into a palette row.

**The wire publishes them, which is what makes this cheap.** Probed 2026-09-06 against claude
2.1.233 with `tools/probe-skills.ts`, spawning with Skein's exact argv: three of
`system/init`'s keys are catalogues of what the agent answers to by name — `slash_commands`
(52 here, and everything in the table above bar Volery's own, in one list), `skills` (22, a
contiguous run inside it), and `agents` (8, a different vocabulary again) — beside a `plugins`
array giving each plugin's `name`, `path` and `source`. `Conversation.skills` is a fold over
that array and nothing goes and looks.

- **Names only, so a summary is derived or it is invented.** There is no description anywhere
  on any of the three arrays and no per-skill path. `skillCommand` derives what it can from
  the name — `tx-toolkit:committee` announces its plugin, a bare `dataviz` announces that it
  has none. Reading descriptions off disk was considered and dropped: a plugin's `SKILL.md`
  *is* findable from `plugins[].path` and a project's from the cwd, but the CLI's own
  built-ins were 16 of the 22 here and live inside a 320MB binary, on disk nowhere. Half a
  palette with summaries is worse than none, and a hardcoded table is one that goes stale the
  first time somebody rewords a skill.
- **`by: "skill"` is a third carrier, not a third interception.** It is sent exactly as a
  `cli` command is — `runCommand`'s branch is `by !== "skein"` — and the word exists because
  the *reader* differs. That is what licenses the whole of the next bullet. It also keeps
  skills out of `cliCommand`, which has to stay a question about the CLI: a card named after
  `/dataviz make me a chart` is named after something you said, where one named `compact`
  never would be.
- **Everything at the head, skills anywhere** — the last column of the table above, and
  `by === "skill"` is the whole test. `slashAt` finds the slash-name the *caret* is in rather
  than matching the whole draft, so `make a chart with /dat` opens the palette. The reason is
  not convenience: `/clear` is carried out here, `/compact` and `/commit` are parsed by the
  CLI, and none of those reads anything but the start of a prompt — offering one mid-sentence
  would be offering something that cannot run from there. A skill is invoked by the *model*,
  through the `Skill` tool (`tools/probe-skill.ts` has the whole shape: a `tool_result` saying
  "Launching skill: …", then the skill's own text injected as a `user` message), so its name
  is prose and its position in the sentence is prose too.
- **The slash must begin a word, and that is the whole guard.** `src/lib/clear.ts`, `and/or`,
  `12/3`, `C:/Users` and `https://example.com/dataviz` all contain one and none of them opens
  anything. A leading space still says prose for the *head* case — `resolveCommand` refuses
  ` /clear` — but it cannot say so here, since a slash inside a line is by definition preceded
  by one. What separates the two is `span.from`: zero is a command being typed, anything else
  is a word in a sentence.
- **Enter runs what is lit only when the name is the whole draft**, and completes it
  otherwise (`spansWhole`, `Field.whole`). Running the lit entry over `make a chart with /dat`
  would send `/dataviz` and throw away everything in front of it. At that row Enter and Tab
  agree, which is exactly what they already do on a command that has not been given its value.
- **The name is the whole token, wherever inside it the caret sits**, and that is what makes a
  stale caret harmless: every position inside a token gives one answer, and `Field.caret` is
  `null` for "wherever the text ends" — which is both the honest reading of a caret nothing has
  reported and precisely what this behaved as before there was one. Every write that replaces
  the whole line goes through `Field.put`, which puts it back to null; a caret measured against
  a sentence that no longer exists is how a palette ends up matching a word nobody can see.
- **A skill's completion carries a space** (`completionFor`) and it is deliberately not
  `takesText`, which would make it `stillWriting` with nothing after it and stop Enter ever
  sending `/dataviz` at all. It takes whatever you say next, and mid-sentence the space is what
  lets you keep writing.
- **A skill under one of our own names is dropped rather than drawn twice.** Two rows under one
  name is a palette whose keys collide, and "what does `/clear` do here" has one answer.
- **The palette scrolls now, and does not cap.** Nine commands plus every skill was 31 rows on
  the wall this was written for. A list that silently stops at ten says a card has no skill
  that it does have; `Dock.svelte` keeps the lit row in view and the detail line is stuck to
  the bottom, since it describes a row you are looking at.

**And the list is stored on the row, which is the half that makes the feature visible at all.**
The same probe spawned with Skein's argv and sent *nothing*: no `system/init` after fifteen
seconds. The CLI emits one only after the first message lands — which is the same thing
`CLAUDE.md` records about a freshly spawned card not being dormant — so a roused card has
nothing on the wire to fold at exactly the moment somebody opens the palette to write their
first prompt of the session. Schema v31's `skills_json` is that, and it is `permission_mode`'s
argument one column over: a dormant card emits no init, and init is the only thing that ever
names these.

- **Opaque, on the bargain `widget.config_json` names.** Nothing in Rust reads it and
  `skillsFrom` normalises every read down to something drawable, so a name shaped in a way this
  build has never seen costs a palette row rather than a migration.
- **NULL and `[]` are different facts.** NULL is "nobody has ever asked this card"; `[]` is a
  card whose agent said it has none. Both draw the same palette and only one of them is a
  fact — and the distinction is what lets `update_conversation` keep COALESCEing safely while
  still being able to *empty* the column, since an emptying arrives as the string `[]` rather
  than as an absence. A plugin uninstalled has to be able to leave the palette.
- **Written when it lands, not at the next settling turn.** `#persistConv` spends
  `skillsFresh` on the init that set it. A `result`-time write would store the list one turn
  after the turn it was wanted for, and an init arrives for every dequeued prompt, so guarding
  on the value rather than the event is what keeps this from being a JSON blob rewritten per
  turn.
- **A build that names no skills leaves the stored list alone.** `#adoptSkills` returns on a
  missing array, the same reading `gearOfInit`'s `null` takes: silence is not an empty list,
  and folding one would throw away a perfectly good stored list the first time an older CLI
  answered.

`snapshot.cards[]` carries `skills`, because that is the only way from outside to tell the two
halves apart — a card told its skills and a card restored with them look identical in the
palette, and only one of them proves the column works.

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
