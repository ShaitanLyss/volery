---
paths:
  - "src/lib/Transcript.svelte"
  - "src/lib/ToolCall.svelte"
  - "src/lib/toolcall.ts"
  - "test/toolcall.test.ts"
  - "src/lib/Markdown.svelte"
  - "src/lib/Inlines.svelte"
  - "src/lib/Rail.svelte"
  - "src/lib/markdown.ts"
  - "src/lib/transcript.ts"
  - "src/lib/outline.ts"
  - "src/lib/follow.ts"
  - "test/follow.test.ts"
  - "src/lib/copy.ts"
  - "src/lib/compaction.ts"
  - "test/compaction.test.ts"
---

# The transcript panel: markdown, folding, size, rails, keys

### Markdown in the panel

The agent speaks markdown and the panel used to print it: hashes, asterisks, pipes and
fences, in one pre-wrap block. `markdown.ts` is a pure parser (blocks and inlines, tested
directly) and `Markdown.svelte` / `Inlines.svelte` walk the tree into elements. It is a
*parser*, not a renderer — nothing produces a string of HTML, so there is no `{@html}` on
the path and no escaping to get wrong; the text is whatever an agent wrote.

Five things it is worth knowing:

- **Only `text` lines fold.** `you` is what you typed, shown character for character; a
  tool call, an error and a meta note are already terse and already monospaced.
- **Every *prefix* of an answer has to parse into something showable**, since the streaming
  line is re-parsed as it arrives — an unclosed fence is a code block that says so (a dashed
  edge) rather than a paragraph of literal backticks that becomes a code block later. The
  caret travels down the tree to the last thing written, or a half-written list blinks a
  line below itself. What is *re*-parsed is only the tail; see below.
- **Single newlines survive** (GFM's `breaks`, not CommonMark's collapse): an agent's own
  line breaks in prose carry meaning in a transcript.
- **A link is a `<button>`, never an `<a href>`.** This window is undecorated, with no
  address bar and no way back, so following a real href is a one-way trip out of the app.
  The click routes out to `Skein.openLink` → `open.rs`, which shells out through
  `rundll32 url.dll,FileProtocolHandler` — not `cmd /c start`, whose shell reads `&` and
  `^` in a url an agent wrote. The scheme is checked on both sides.
- **Copying gives back the markdown, not the drawing of it** (`copy.ts`, the panel's
  `oncopy`, and the context menu's `copy` — both routes, or there would be two clipboards).
  Rendering marks as elements means the browser's own copy strips every one of them: a
  numbered list arrives unnumbered, a bold label unbolded, a fence as loose lines. But an
  answer copied out of here is nearly always on its way somewhere that reads markdown, so
  the selection's cloned fragment is walked back into source. It is put back together from
  what is *drawn* rather than sliced out of the line's text because a selection is a DOM
  range and only the DOM knows where one starts — so a partial selection gives a partial
  document, and a clone that has lost its list has no marker to write. `toMarkdown` is pure
  and takes `Bit`s (the little of a node it needs), which is what lets it be tested with no
  browser; `bitsOf` is the ten lines that turn a real fragment into them. The panel's own
  furniture — the fence's copy button and language tag, the caret, the seam over restored
  scrollback — is drawn but never copied.

No syntax highlighting, deliberately: colour on this wall is status, and a keyword is not a
status.

### An answer is parsed once, not once per token

`lines` only ever grows, so a settled line is folded the once — that argument is at the top
of `Transcript.svelte` and has been since markdown arrived here. **The turn still being
written is the same argument one level down, and it was the exception for as long as it
existed.** `parseMarkdown(conv.streaming)` re-read the whole accumulated answer on every
`text_delta`, and cards spawn with `--include-partial-messages`, so that is thousands of
times a turn: quadratic in the length of the answer, on the thread that also runs one script
eval per event on the wall, with Svelte's diff of the block array on top. Measured here on a
hundred-thousand-character report — an ordinary plan on this wall — **36.6 s of parsing
across the turn, against 169 ms now**. The symptom is exactly what it sounds like: the panel
gets less responsive the longer an answer runs, and comes right the moment it finishes.

`StreamedMarkdown` in `markdown.ts` is the fold. Everything above the last **block boundary**
is settled in the same sense a line is — it has been written, and nothing arriving later can
reach back past that point — so it is parsed once and handed back by identity.

- **What counts as a boundary is the whole of the subtlety.** A blank line settles what is
  above it: a paragraph stops at one, a quote's lazy continuation stops at one, a table's
  rows stop at one, and `readTable`'s single line of lookahead cannot see past one. **Unless**
  it is inside a fence, where a blank line is code, or inside a list, where `readList` counts
  blanks and carries on. Those are the only two things the scanner tracks, and its list
  branch mirrors `readList`'s break condition branch for branch — `tableAt` exists so the two
  ask the table question with one piece of code rather than two that have to agree.
- **Where it cannot tell, it stays inside.** A boundary that was not one is a code block
  flickering into prose mid-stream; a boundary missed is only a slower parse. So every
  uncertainty resolves towards *not settling* — a numbered list interrupting a bulleted one
  settles nothing, though it safely could.
- **The honest limit is an answer with no boundary in it at all.** One enormous fence, or one
  loose list running its whole length, is no faster than it was. A fence at least degrades
  well, since nothing inside one is parsed for inlines.
- **The source must only ever grow, and `key` is what says it is still the same source.** A
  length comparison catches a restart; it cannot catch moving to another card mid-turn, which
  is why `read` takes `conv.id`.
- **Parsing once is only half of it.** The panel draws two `<Markdown>` components into one
  `.md` column — the settled blocks and the tail — because a single array would have Svelte's
  `{#each}` walk every block on every token however cheap the parse got. Neither adds an
  element, so `.md > :first-child` and `:last-child` still find the ends of the answer, and
  the settled array's identity moves only when one more block joins it. The caret rides the
  tail, except on the deltas where the tail is nothing but blank lines — then it goes on the
  last settled block, or it would blink out between one paragraph and the next.
- **The contract is tested as a contract**: every prefix of a document holding one of
  everything, fed a character at a time, must read exactly as a fresh `parseMarkdown` of that
  prefix. That is the only assertion worth making here, and it is what caught the
  fence-straddling case. `test/markdown.test.ts`.

### Folding the machinery away

A round is mostly machinery: an agent reads six files, edits four and runs the suite twice, and
drawn one line each those calls *are* the column — what you asked and what came of it end up a
screen apart with twenty lines of bookkeeping between them. So a run of consecutive tool calls
folds into one cap you can open, each independently. `transcript.ts` is pure (`blocksOf`,
`foldCount`, `foldSummary`, tested in `test/transcript.test.ts`) and `Transcript.svelte` draws
what it returns; the two columns — history and live — are folded once each and share one key
namespace, hence the `tag`.

- **Only tool calls fold, and two is the minimum.** A run is broken by anything that is not a
  tool line, so an error, a meta note and speech cannot end up inside a fold — which is what
  makes folding safe rather than merely tidy. A lone call folded would trade a line of
  transcript for a line of chrome and hide the more useful of the two.
- **Nothing navigable is ever inside a fold** — a tool line carries no `data-nav` — so the rails
  list the same places whatever is open. Opening one does change every offset they measured,
  which is why `toggle` calls `refresh(0)`.
- **A group is keyed by its first line's words, not its position.** The live fold is capped at
  `MAX_LINES` and sliced off the *front*, which shifts every index down and would silently move
  an opened group onto a different run. A group's first line does not change as the group grows,
  so the key lasts exactly as long as the group; identical runs are told apart by a count of
  those before them.
- **Folded, the cap carries the run's *last* call**, so a group at the foot of a live turn reads
  as a status line and the panel stays current without being opened; once the turn settles the
  same words say where the work got to.
- **The live edge is its own line at the foot of the column** (`.line.doing`, `conv.doing`).
  A tool call reaches `lines` only when its block closes, so between your prompt landing and the
  first thing written there was nothing on the page at all — and with the calls folded the page
  can sit still for a minute at a time. It is suppressed while text streams: `activity` is
  "responding" then, and the words arriving above it are the better account.

### Opening a call

A folded run hides the machinery; opening one used to show you the machinery *as prose* and
nothing else. `describeTool` writes `searching for describeTool` — a good answer to "what is it
doing", which is the question the **card** asks, and no answer at all to "what did it actually
do", which is the question you opened the panel for. Which directory. Which glob. Whether it
found anything. All of it was on the wire and all of it was thrown away, so the one place in
Skein that could have told you was the one place that had decided not to keep it.

So a `tool` line carries `Line.call` — the tool's own name, the arguments the model wrote, and
the result once it lands — and each call is a fold in its own right, nested inside the run fold
it may be part of. `toolcall.ts` is pure and decides *what* is shown and in what order
(`test/toolcall.test.ts`); `ToolCall.svelte` is the typography.

- **Closed, it weighs exactly what it weighed before.** Same monospace, same size, same paper as
  `.line.tool`. A round is mostly machinery and the machinery is meant to recede — so everything
  the fold adds sits at the two ends: the tool's raw name as a hairline chip at the left, and at
  the right a ledger saying how much came back. Becoming clickable must not make a line heavier.
- **Every argument is shown, including the ones nothing here has an opinion about.** The reason
  to open a call is that something in it is not what you assumed; a fold that decides which
  arguments you meant to check is a fold to be distrusted for the ones it did show. Unknown keys
  are drawn as JSON rather than dropped, and unknown *tools* keep the order the model wrote them
  in. `LEAD` only promotes the subject of the call — which file, which command, which pattern —
  because object key order is the model's and changes between two calls to the same tool.
- **How a value is set is asked of the key first and the shape second.** The key is the only
  thing that knows meaning: a path and a search pattern are both short strings and only one of
  them wants its last segment picked out. The shape is the fallback, so a tool nobody has heard
  of still gets a multi-line value set as lines rather than run together as a sentence.
  Which is also how a key gets it wrong: `script` sat in `SHELLS` on the reasonable-sounding
  assumption that a thing called a script is a thing you type at a prompt, and the only tool on
  this machine that has ever carried one is `Workflow` — whose script is four hundred lines of
  JavaScript, drawn with a `›` in front of the first of them as though somebody had typed the
  whole thing at a shell. It is source, and `CODES` is where it belongs. A `Workflow` also
  wanted a `LEAD` of its own more than most: everything that says *which run this was* is a
  short string beside a value that is the rest of the fold.
- **An edit is a diff.** Comparing two adjacent walls of near-identical code by eye is precisely
  what a diff was invented to stop anybody having to do. Line-level LCS, written out in
  `toolcall.ts` rather than pulled in, with `DIFF_MAX_LINES` guarding the O(n·m) table — past it
  there is no diff and `callView` therefore leaves `old_string` and `new_string` in the argument
  list. That last clause is the whole reason `callView` exists as one function: the two strings
  are dropped **only when a diff was actually produced**, and asked separately that is two calls
  that have to agree about a guard.
- **The diff is achromatic.** Red and green is what every other tool does and colour on this wall
  is status — a diff's two sides are not one. Ink, weight, a wash and the gutter mark do it
  instead, which is how a printed diff has always done it. The two colours in the component are
  the celadon pip on a call that has not landed and the rust on one that failed, and both of
  those *are* statuses.
- **A call still in flight says so** rather than looking like one that answered with nothing.
  The pip, and the body's rule goes dashed — the panel's existing spelling of "not settled yet",
  the same one a pending prompt wears.
- **What is kept is capped where the line is written, not where it is drawn.** `VALUE_CAP`
  through `capInput` and `landed`. Up to 300 live lines and 400 of history, each now able to
  hold an argument and a result, is a memory budget rather than a rounding error — and a cap
  applied at render time is not a bound at all. What was cut is *said*, and the note names the
  session file, because a fold that truncates quietly has to be distrusted for everything else.
  `RESULT_LINES` is the separate, softer clamp on what stands in the fold before you ask for the
  rest; nothing is lost to it.
- **A call's fold key is its `tool_use` id**, not its position. Unique across the card, stable
  for as long as the line is, and — because history reads it out of the session file — the same
  string after a restart, so a call you had open stays open across a rouse. The block key is the
  fallback and is positional in exactly the way `blocksOf` warns about.
- **The result is routed by id, both live and off disk.** `Conversation.#land` walks `lines`
  backwards, because a result arrives within a message or two of its call and a `Map` keyed on
  the id would go on holding lines `MAX_LINES` had already sliced away. `history.ts` does keep a
  map, because it folds a whole file in one pass with no slicing until the end and a backward
  walk per result there is quadratic. Both go through `landed`, so the cap and the failure flag
  cannot be applied one way live and another way after a restart.
- **A result can be a picture, and until 2026-08-28 that was the one answer the panel could not
  show.** A `Read` of a PNG, a screenshot harness, an image in a prompt: each arrives as an
  `image` block inside the `tool_result` with **no text beside it at all**, so a fold that read
  results for prose drew the call as having answered with nothing, and `resultSize` said
  "empty" about a round whose whole content was the picture the agent was looking at. Asked for
  by the user (sink 28cb1c5d), who had watched it happen while checking deck captures.

  `classify.ts::picturesOf` is the reader and is shared by both folds, for the reason `textOf`
  is: the block shape is identical on the wire and on disk, and a panel that showed the image
  only until you restarted is the divergence `history.ts` exists to prevent.

  **Both fields it produces are untrusted input that ends up inside `src=`**, which is the
  whole care in that function. The media type is matched against a short `image/<subtype>` and
  the payload against the base64 alphabet, and anything else is *refused rather than
  sanitised* — there is no legitimate value that rejects. A `{type:"url"}` source, the other
  variant in the API, is dropped too: drawing it would have the panel fetch from the network on
  behalf of a transcript, which this app does nowhere else and certainly not inside a fold
  nobody clicked.

  Two bounds, and they are the memory argument. `MAX_IMAGE_CHARS` (4 MB of base64, about a 4K
  screenshot) refuses one too large to carry, because these are held in `$state` for the life
  of the line and a card that screenshots in a loop on a wall left open for days is the failure
  mode. `RESULT_PICTURES` draws four and **counts the rest out loud** — silently keeping the
  first four is the quiet truncation this codebase keeps having to learn not to do. The `img`
  itself is only in the DOM while the fold is open, so decoding is paid for by a click.

  The `[Image: original 3200x2000, displayed at 2000x1250. …]` note is a *different* record and
  stays dropped (`isImageNote`): it is coordinate arithmetic addressed to the model, it carries
  `isMeta` on disk, and it was being drawn as something the user had typed.
### Finding a word in what you are reading

Ctrl+F used to reach the *webview's* own find bar, which is the wrong tool twice over: it
searches the whole document — the header, every card title, every widget on the wall, the dock
— and it draws Chromium's chrome over an app whose whole premise is having none. The user
asked for it gone everywhere and for a find that belongs to whatever it was opened over (sink
776a4d34). The transcript is the first of those and for now the only one.

- **The key is swallowed unconditionally, above the shell and finder guards.** `App.svelte`'s
  ladder takes Ctrl+F even where there is nothing to hand it to, because a find that works in
  some places and summons the browser's in others is worse than either. Then it is *routed*:
  the shell has no search of its own yet and gets silence; the finder's Ctrl+F is a different
  question — it swaps that panel's two modes — and `Spyglass.svelte` has already answered it by
  the time the window handler runs, so this only has to stop the default.
- **`hunt.ts` is plain case-insensitive substring, deliberately not `finding.ts`'s scorer.** A
  file finder scores candidates because it is answering "which of these did you mean" from a
  few characters. Ctrl+F answers "where does this word appear", and a fuzzy match there is a
  find that jumps to places the word is not. Different question, different matcher, and they
  share no code on purpose.
- **Matches are counted, blocks are scrolled to.** "3 of 17" has to mean seventeen occurrences
  or stepping through it skips some — so `huntBlocks` carries spans per block and `matchAt` is
  the mapping between the two. `MIN_QUERY` is 2: one character matches most of any transcript,
  which is noise rather than a reading, and the panel draws something per match.
- **A closed fold is searched, and landing there opens it.** `hunt.ts::textOf` looks inside a
  run of tool calls, because the alternative is a find that reports a word absent from a
  transcript containing it — and `carry` un-shuts and opens the fold before scrolling, or the
  panel would say "here" and show a collapsed line. A call's *result* is deliberately not
  searched: it can be twenty thousand characters of a file that was read, and a match in it is
  not a place in the conversation.
- **Block-level, not character-level, and that is the one real limit.** A `text` line is
  rendered markdown, so highlighting inside it means reaching into `Markdown.svelte`'s output —
  a much larger surface traded for a nicer highlight. A match bands its block; the current one
  bands brighter and takes an outline. Achromatic, because colour on this wall is status and a
  search is not one; the single exception is the tally going rust when the word is not there,
  which *is* a result.
- **`.blk` is `display: contents`**, so an anchor per block costs no layout — the column's flex
  still sees the block itself. Which means the wrapper has no box: the band is drawn on the
  child (`> :global(*)`), and `carry` scrolls `firstElementChild` rather than the wrapper,
  because `scrollIntoView` on a boxless element silently does nothing.
- **The bar floats over the column rather than sitting above it.** Opening a find must not
  reflow the thing you are searching. It is at the top because a match is scrolled to the
  *centre*, so a bar at the foot would be the one place a match can never be.
- **Escape and Enter are stopped from propagating.** Escape on this wall interrupts a card's
  turn, and closing a find bar must not also stop an agent — the same care `Bump.svelte` takes.
  Every other key is stopped too, or a printable one would reach the wall's ladder and land in
  the focused card's draft.

- **A copied diff is a `diff` fence.** Each row is its own element so it can carry a background,
  which makes every row a block, and blocks are joined with a blank line — so an eight-line edit
  came out of the clipboard sixteen lines tall with the shape of the change gone. `copy.ts` has a
  branch for it. The gutter marks go too: `-` and `+` are what make the paste a diff rather than
  two versions of a file interleaved.

### The two folds of exactly one thing

The `MIN_FOLD` rule above says two calls or nothing, and both of these break it on
purpose: that rule is about not trading a line of transcript for a line of chrome, and
these trade twenty thousand characters for it — or, in the largest on this machine, six
hundred and ninety-eight thousand. `blocksOf` gives them one block kind (`long`) and
`Transcript.svelte` one branch, because the drawing is the same problem three times; only
the cap differs, and `longFold` is the whole of the difference.

- **A compaction summary**, which is what the card kept. See below.
- **A skill's body**, which is what the card was told to do. Invoking a skill returns no
  result — the CLI *injects the whole file* as a `user` message — so with nothing reading
  it, the live panel drew a skill as a prompt you appeared to have typed, and the session
  file drew it not at all: on disk it carries `isMeta`, which `history.ts` drops with the
  rest of the injected context. Two opposite bugs out of one shape.
- **Rousing's resume prompt**, which is what Skein said to a card whose turn was cut off.
  Twenty lines of instructions addressed to the agent, drawn at the top of every card the
  wall roused — so on a wall coming back from a crash they were the first screen of every
  card on it, in the register of something you had typed. Nobody reads them; they are not
  written for the reader. See `restore.md`.

The resume prompt is the odd one of the three in keeping line kind `you`. It *is* a
prompt: it is echoed and claimed like one (`Conversation.echo`), `history.ts` pushes it
like one, and `trimOverlap` cuts the file's copy against the live one by matching kind and
text. So it is recognised here by its words (`isResumePrompt`) rather than by its kind —
giving it a kind of its own would have meant widening every predicate the echo bookkeeping
asks and the overlap anchor besides, to change nothing but which branch of `longFold` it
takes. Being a `long` block is also what takes it out of the rails: `data-nav` is written
by the line snippet, which a folded block never reaches, so it stops being listed as a
round to travel back to — which it never was.

A cap can carry a fault. `RESUME_FAILED_CAP` is the one that does: folded, a line's own
`failed` mark is not on screen to be read, so a send that never left says so on the cap
instead (`.cap.failed`, the same rule a `!` run's cap keeps and for the same reason).

Neither field is on both sides — `isSynthetic` is the wire's and `isMeta` is the file's —
so `skillBody` asks the *text*, matching the `Base directory for this skill:` line the CLI
writes above the body, anchored to the start so a skill quoted in an answer stays prose.
The path's last segment is the skill's name and becomes the cap. Probed 2026-08-18 against
claude 2.1.232 with `tools/probe-skill.ts`.

Folded rather than dropped, which is the one place this differs from `isStopNote` and
`parseTaskNotification`: a skill is the instructions the rest of the card is following, so
*which* one was picked up belongs in the column, and the text of it belongs one click
away. The two kinds count their fold keys apart, so a skill arriving between two
compactions renumbers neither and cannot move an opened fold onto a different one.

### The compaction, which is a wait and then a wall of text

Both halves of it were drawn wrong, and in opposite directions: the wait showed nothing and
the result showed everything. See `.claude/rules/commands.md` for what the wire actually
carries — probed, and less than it looks: on a manual `/compact`, two status events and
nothing else. **The boundary and the summary reach `history.ts`, not `ingest`.**

- **The bar is a prediction, and the whole design is how to draw a guess without
  it reading as a measurement.** `compaction.ts` is pure and holds all of it. Three rules:
  the prediction comes from what folds have *actually* cost, starting with the eight this
  machine had recorded and recalibrating against every one the wall watches; the bar reaches
  `NEARLY` (0.9) at the predicted moment and creeps asymptotically after, so arriving at the
  prediction never looks like arriving at the end and only the closing status completes it;
  and past the prediction the *line* says `longer than usual`, because a bar sitting at 97%
  for ninety seconds has stopped saying anything and started saying the wrong thing.
- **The eight measurements are the reason the model is nearly a constant.** Read out of
  `compactMetadata` across this machine's transcripts on 2026-08-17: 47k→70s, 47k→65s,
  340k→188s, 432k→157s, 453k→117s, 470k→103s, 624k→125s, 981k→117s. A twentyfold range in
  tokens gives a 2.9× range in seconds, and above ~340k the times fall as often as they rise —
  a fold is dominated by writing a summary of roughly fixed length, not by reading the
  context. Least squares over the lot is `96s + 0.051s per 1k tokens`. So `priorFor` is a
  floor plus a tilt that saturates at `TILT_AT`, and fitting anything more elaborate to eight
  points with ±40s of scatter would be false precision dressed as a model.
- **Calibration is on the median *ratio*, not on a mean of durations.** A mean would flatten
  the size tilt away the moment the observations happened to be all large or all small; a
  ratio scales the prior and leaves its shape alone. The median rather than the mean because
  one fold that stalled on a slow network must not move the next twelve, and it is pulled
  toward 1 by `n/(n+2)` so the first observation moves the estimate a third of the way rather
  than replacing it.
- **The estimate is taken once, when the fold starts, and never re-derived.** It is a function
  of occupancy, and `ctxTokens` is about to be rewritten by the fold itself — a live `$derived`
  would watch its own denominator collapse and the bar would leap *backwards* at the moment of
  success. `#compactTokens` is kept apart from `ctxTokens` for the same reason on the way out:
  reading occupancy afterwards would file every measurement under ten thousand tokens and teach
  the estimate that compactions are free.
- **A hard `CEILING` as well as the asymptote, and that is arithmetic rather than taste.**
  `1 - exp(-x)` is exactly 1 in a double once x passes ~37, which a fold ten times its
  prediction reaches — so a bar that could never fill filled anyway, at the worst possible
  moment, on the one fold that had gone badly wrong.
- **`#endCompaction` is the only way a fold ends**, so there is one place that can forget to
  clear the count or teach the estimate a lie. It records on the closing status, on the
  boundary and on `result`; it does *not* record on `markExited`, because a summarisation that
  died part-way took as long as it took and that measures the crash rather than the work.
  `recordCompaction` refuses anything under five seconds outright rather than clamping it: a
  two-second compaction is a fold whose start was missed, and averaged in it poisons the
  estimate for the session. It returns the same list it was given so the caller knows nothing
  was written.
- **What has been seen lives in localStorage, wall-wide.** Same side of the line as the
  viewport and the panel width — per-machine, disposable, not a thing you *made* — and losing
  it costs one slightly-wrong bar. Wall-wide rather than per-card because a fold's cost is a
  property of this machine, so a card that has never compacted gets the benefit of the eleven
  that have. Read once at module level, not once per card.
- **On the card it takes no layout height at all.** A sibling of `.card`, absolutely
  positioned along the bottom inside edge, like `.pin` and `.aside`: cards sit on a fixed
  pitch and `CARD_BOX` records what each density draws at, so anything in the flow here pushes
  every row into the one below it. Skipped at `field`, the density that keeps the ring and
  drops everything else. Celadon at half opacity in both places — it is the working
  status, but it is a guess, and a guess must not be as loud as the ring beside it that is
  measured. `transition: width 1s linear` is what makes a once-a-second clock read as movement
  rather than as a stall; eased would accelerate and decelerate twice a second, which is worse
  than the step it hides.
- **`doing` is `activity` plus the one wait that has to count itself.** Everywhere else the
  word is enough because something under it is moving — deltas arrive, calls land, the plan
  advances. A compaction has none of that: the wire says `compacting` and then says nothing
  for up to three minutes, which is indistinguishable from a card that has hung. So
  `compactingSince` is held and `doing` appends `spanOf` it, off the same one-second `clock`
  every card already reads for neglect — no second timer. Both readers go through `doing`
  (the card's label and the panel's live edge) rather than one of them appending the count,
  or the wall and the panel would disagree about how long you had been waiting. It is cleared
  by the closing status, by `result` and by `markExited`, because a count nothing can stop
  ticks on a dead card for the rest of the session.
- **The ring is the last thing to hear about a compaction and the first thing you look at.**
  Occupancy is the last `assistant` message's usage and a compaction produces no assistant
  message, so a card that went into `/compact` at 98% is still drawn at 98% — rust and
  apparently no better off — until the next turn answers. `compact_boundary` carries
  `post_tokens` and `ingest` reads it, but **the probe never saw one on a manual `/compact`**:
  that path writes the boundary to the session file only. The arm is kept because a *reactive*
  compaction is a different shape — it happens mid-turn, the CLI has to tell the consumer the
  conversation was rebuilt underneath it, and `qEf` has a `compact_boundary` case producing
  exactly the wire form `compactStat` reads. That is inference from the binary and not probed;
  filling a real context to the auto threshold costs hundreds of thousands of tokens. Until
  somebody does, **a manual compaction's ring corrects on the next turn and not before** — say
  so rather than assuming the arm fires.
- **The summary is its own line kind, folded, and kept whole.** It arrives as a `user`
  message — the CLI handing the model everything it must not forget — and pushed as a `you`
  line it was 16k–25k characters you appear to have typed, with the round you were reading
  shoved off the top of the panel. It is not the agent's either. `summary` is neither, drawn
  as a fold of exactly *one* thing: the deliberate opposite of `MIN_FOLD`, whose reasoning is
  about not trading a line of transcript for a line of chrome, where this trades twenty
  thousand characters for it. History used to clip it to 240 characters, which lost the
  discontinuity more politely rather than not at all; what a card used to know is worth being
  able to read, and a clip is not readable.
- **The cap is the boundary's two token counts**, which arrive one event *before* the words
  they label — so both folds hold a note and hang it on the summary that follows
  (`#compacted`, `compacted`). `history.ts` pushes it as a bare `meta` line if no summary ever
  comes, which is exactly the old behaviour for the one case that still needs it.
- **Live it is matched on the preamble, not on a flag** — and, like the boundary, this is the
  reactive path's arm rather than the manual one's. `isCompactSummary` is written to the
  session file and dropped on the way to stdout (`qEf`'s `user` case names `isSynthetic` and
  nothing else), and `isSynthetic` is equally true of every note Claude Code injects. The
  preamble is one fixed string in the binary, the same manual or automatic, identical on the
  wire and on disk, so `classify.ts::isCompactSummary` is one question both folds can ask of
  the same words. Same bargain as `isStopNote` and `parseTaskNotification`, at a hundred times
  the size. No turn is opened on it: the compaction's own turn is already open.

- **A local command writes four `user` records and marks one of them, and that cost the
  transcript more than the summary did.** From the probe's own session file:

  ```text
  isMeta:true   <local-command-caveat>Caveat: The messages below were…
  (unmarked)    <command-name>/compact</command-name>
                <command-message>compact</command-message>
                <command-args></command-args>
  (unmarked)    <local-command-stdout>Compacted </local-command-stdout>
  ```

  Only the caveat is sorted out by `isMeta`. The other two were pushed as `you` lines — a
  block of XML you appear to have typed — and because `<command-message>` holds the bare name,
  **a compacted card read as though somebody had said the word "compact" into it**. 61
  `<command-name>` blocks and 21 `<local-command-stdout>` blocks across this machine's
  transcripts, every one drawn that way. `localCommand` folds them to `meta`: the name with
  its arguments (`/model sonnet`), and whatever the command printed back. Not dropped —
  running a command is a real thing that happened and the transcript is the record of it.
  It returns `null` for "not a local command" and an empty `text` for "one with nothing to
  draw", and conflating those two puts the quietest commands straight back into your mouth.
- **Markdown is parsed only when the fold is open.** A summary is written as headed sections
  and numbered lists, and parsing twenty thousand characters of it on every delta of a live
  turn — folded away where nobody can see it — would be the panel's most expensive line by
  some distance.
- **Nothing inside it is navigable**, the same rule the tool folds keep. A summary's own two
  dozen headings would bury every real place in the conversation the `contents` rail lists.
- **A failed compaction says so.** `status:null` carries `compact_result` and, when it went
  wrong, `compact_error`; success needs nothing said, because the ring falling and the cap
  have already said it. Silence on a failure is a card that spent three minutes and a fold
  that did not happen, looking exactly like one that succeeded.

### The footer, and the one fact the wire will not tell you

`.meta-bar` states what the card *is*: occupancy, tokens, turns, what it has cost, and — off
to the right — which model it is talking to and how hard it has been told to think.

The model id rides the stream. **The effort does not, and nothing on the wire does.** Probed
2026-08-20 against claude 2.1.233, spawning with Skein's exact argv: `system/init` carries the
model, the tools, the slash commands, the agents, the skills, the output style and the version,
and no effort; an `assistant` event carries `message`, `parent_tool_use_id`, `session_id`,
`uuid`, `timestamp` and `request_id`, and no effort either — with `--effort xhigh` passed
explicitly, so this is not a default being elided. The *session file* records it, as a
top-level `effort` on every assistant record (`"xhigh"` in that probe, `"high"` in the same
probe run without the flag).

So it is read off disk, which puts it in exactly the arrangement `read_ai_title` is already in:
a fact about the session that exists only in the transcript, fetched at the settling turn by
`Skein.#adoptEffort`. Two differences, both deliberate.

- **It reads the tail, not the whole file.** `supervisor::read_session_effort` works back from
  EOF in a doubling window (256 KB → 8 MB), because every assistant record states the field and
  the newest one is near the end. `ai_title_of` reads the whole file and can afford to; this
  runs on the same per-turn path and would be the more expensive of the two if written the same
  way.
- **The CLI's own answer wins for one turn.** `/effort max` is answered by the binary itself —
  `result` with `num_turns: 0` and no cost — and writes *no assistant record*, so the file still
  holds the level being replaced. `effortAnswer` in `commands.ts` reads the level out of that
  sentence, and `Conversation.effortStated` spends one skipped read on it. Without that, typing
  `/effort max` showed `high` in the footer until the next turn had run.

The level is written back to `conversation.effort` — a column that had been in the schema since
v1 and read by nobody — so a dormant card can say what it thinks at without spawning anything.
It survives `clear_conversation` for the same reason the model does: a fresh session in the same
card is still that card.

### How wide the panel is

**A column you set, never one that sizes itself.** `panelWidth` in `layout.ts` decides it —
undragged, the third of the window it always was (300–460); dragged, what you dragged it to,
and the only thing that overrules you is `WALL_MIN`, so there is always a wall left to have
the conversation on. The width lives on `Studio` beside the viewport and goes to
localStorage for the same reason: it is how this window is divided, per-machine and
disposable, not something you made. The handle is `.side`'s own left border widened to seven
pixels (`.grip` in `App.svelte`), hanging three pixels out over the wall — clear of the
rails, and the wall under it still pans everywhere the cursor is not on it.

It sized itself once, by accident, and that is the thing not to reintroduce. `.detail` was a
flex item with no `min-width: 0`, and a flex item will not shrink below its *min-content*
width: prose has none to speak of (`overflow-wrap: anywhere` on `.line` gives a paragraph a
min-content of one character), but a code fence is `white-space: pre` and a table's headers
are `nowrap`, so their min-content became a floor — clamped by `.line`'s `max-width: 78ch`,
which at 0.86rem is around 537px against a column that never exceeds ~420. So any answer
containing a fence widened the whole panel past `.side` and off the right edge of the
window, and the `overflow-x: auto` that is on `.code` and `.table-scroll` never got its
chance, because the box around them grew instead of the box scrolling. Wide content scrolls
inside itself. Nothing in the panel may decide the panel's width — re-measuring the
paragraph somebody is halfway through reading is the same kind of wrong as reshuffling the
wall when a card opens.

**The grip does not `preventDefault` on pointerdown**, which suppresses the compatibility
mouse events and with them `dblclick` — so the double-click reset could not fire at all.
`user-select: none` on the grip refuses the selection that the default would otherwise have
started, at the source. Probed 2026-08-13 through the control surface.

### How big the reading is

The panel's other dimension, set with **ctrl+wheel over the panel**, and ctrl+0 puts it back
to 100%. Independent of the width on purpose: a narrow column of large type is an ordinary
way to read, and so is a wide one of small, so neither is derived from the other. Same shape
as the width otherwise — `readingScale` / `nudgeReading` in `layout.ts` are pure and tested,
`Studio.readScale` holds it beside the viewport in localStorage (per-machine, disposable, not
a thing you made), and the gesture in `Transcript.svelte` is routed back out to `App.svelte`,
because how this window is set up to be read from is not the panel's to keep.

- **It is one multiplier, `--read`, and everything else is already relative to it.** The
  transcript is proportional to itself — a heading, a fence, a table and the caret are all
  `em` off `.line`, and `78ch` means seventy-eight characters at whatever size those
  characters are — so scaling `.line` scales the column and nothing inside it changes shape.
  What `--read` is written into by hand is the handful of sizes and spacings that are *not*
  `em`: the other `.line` kinds, the seam, the line gap, and the list indents and cell
  padding in `Markdown.svelte`. `calc(Xrem * var(--read, 1))` rather than an inherited `em`
  chain, so each rule keeps the number it always had and a new rule cannot opt out by being
  nested one level deeper than expected. The default of 1 is what keeps `Markdown.svelte`
  renderable outside the panel.
- **The instrument is not the reading.** The readout chip (`text 115%`) is deliberately not
  scaled by `--read`, and it goes after 900ms — a size left on the panel would be furniture.
- **The wheel is the other way round from the wall's.** On the wall a bare wheel zooms,
  because the densities *are* the navigation there; in the panel a bare wheel can only mean
  scrolling, so the size costs a modifier. They never overlap — the panel is outside
  `.surface`, and neither listener sees the other's events. Both are registered by hand for
  the same reason: non-passive, or `preventDefault` is not available.
- **Resizing moves the reader.** Every mark's offset changes, so the panel recollects a frame
  later (mid-effect it is still drawn at the old size), and the scroll position is restored as
  a *fraction* of the column taken before the change — at double the size, the same pixel
  offset means something entirely different. A panel that was following the tail outranks
  that anchor.
- The effect that does this depends on `read` alone. `scroller` and `following` are read
  untracked: either would re-run it on every scroll, and re-running it means recollecting the
  whole panel and flashing a readout for a size that did not change. It also skips its first
  run, or focusing a card would announce the panel's own size on every click.

Chromium's ctrl+wheel and ctrl+0 are free to be taken because Tauri 2 leaves
`zoomHotkeysEnabled` false and `tauri.conf.json` does not set it. `snapshot.panel` reports
both halves — `reading`, the multiplier the studio holds, and `linePx`, what a line is
actually drawn at — because a `--read` that reached no rule would leave the first moving and
the second still. The `wheel` op takes `target=panel` to drive the real listener.

### The rails beside the transcript

Two floating lists hang off the panel's left edge, over the wall, and they list different
things. `you said` is the whole conversation — every prompt you have sent, from the top.
`contents` is **one** answer — how the round being read came out: its opening words, its
headings, the start of each of its list items. A table of contents for a dozen answers at
once is not a table of contents; it is the transcript again in a narrower column.

**"Its headings" mostly means its bold paragraph openings.** An agent writes `##` far less
often than it writes `**1. The impact pipeline.** The largest unbuilt system left…` — six
sections and not one heading or list marker in the message. A rail that listed only `#` and
`-` had nothing to say about answers written that way, which is most of them: it showed the
opening line and stopped. So a paragraph that *opens* in bold is a heading with its label run
in, marked `data-nav="lead"` and named by the bold alone (`runIn` in `markdown.ts`, the label
carried on the element as `data-lead`, the whole paragraph kept for the tooltip). Two rules
keep it from listing prose: the bold has to open the paragraph — bold mid-sentence is
emphasis and no section begins there — and it has to be short, or a first sentence written in
bold for weight becomes a rail entry that is the paragraph again. Run-in labels are collected
for top-level paragraphs only (`nav={false}` down every recursion in `Markdown.svelte`):
inside a list item the line is already a mark and would be listed twice, one line apart.

Same three needs either way — a list of places, one lit, and a click that goes there — so
they are one component (`Rail.svelte`) over one pure module (`outline.ts`: `stub`, `nest`,
`readingAt`), and only what is collected differs.

The marks are read off the panel's **own DOM** rather than parsed out of the markdown a
second time. Everything navigable carries `data-nav` — `"you"` on the line, `"msg"` on an
agent message, `"h"` on a heading, `"li"` on a list item and `"lead"` on a paragraph that
opens with a bold label, all in `Markdown.svelte` — so one
`querySelectorAll` finds the lot in document order, the labels cannot drift from what is
drawn, and the element's `offsetTop` — which is what a click needs anyway — comes free. That
offset is measured against `.lines`, which is `position: relative` for exactly this reason.

- **A container is labelled by what it carries before its first nested mark** (`startText`).
  Everything past that belongs to the mark below, and taking it twice prints the same words
  one line apart. So a message opening with a heading has no entry of its own, and a list
  item holding a nested list is labelled by its own line.
- **`rank` is not an indent.** A heading's 1–6 and a list item's nesting are what the tag
  knows alone; the indent is carried along the run by `nest`, each heading setting the floor
  for the list items after it — the same `rank`-1 list sits deeper under an `h3` than under
  an `h1`. A run-in label sits *on* the floor and a list written under it hangs off it, but
  it never moves the floor: `nest` keeps `floor` and `base` apart for exactly this, or a run
  of bold paragraphs would step one indent further right with each one until the answer ran
  off the edge of the column. `nest` also returns `null` for the marks to drop, *after* using them: an empty
  `msg` shows nothing but is still the boundary that stops the next answer's list from
  inheriting the last one's indent.
- **`contents` is scoped to the round, and lists that round's last message** (`conclusionAt`).
  A round is not a message: an agent says a line, calls four tools, says another line, calls
  three more, and *then* explains what it did — so one thing you asked for is a dozen `msg`
  marks, eleven of which are "right, now the store". Scoping to the message being read meant
  scrolling back through a round you had just watched replaced its contents with those eleven
  in turn. Mid-round the last message is as far as the agent has got, which is the best
  available answer to "what did this come to"; once it settles it is the summing-up. Marks are
  still collected for every message — which round you are in, and what it came to, both fall
  out of the same `headAt` that lights an entry, so neither is a thing to track. The
  consequence is that `contentsAt` is legitimately `-1` inside a round's working part: the
  rail lists where the round is going while you read how it got there. The cap counts *rounds*
  (`contents · 2/5`) when there is more than one, or a scoped rail reads as a rail that lost
  half its headings; rounds that answered nothing yet are not counted, since the rail cannot
  show them.
- **A collect walks every mark in the panel**, so a live turn's deltas are throttled
  (`refresh`, 160ms) while structure changes are immediate. Only ever shortening the wait is
  what keeps that from starving.

- **Offsets are measured, never cached.** The column above a mark grows all through a turn,
  so a top recorded when the mark was collected is wrong a second later. `measure()` runs on
  scroll and on the frame after any content change.
- **`readingAt` returns `-1` above the first mark**, and the *last* mark whenever the view is
  parked at the bottom — a final section shorter than the viewport never reaches the top edge,
  so without that rule scrolling all the way down leaves the rail pointing well above what
  fills the screen.
- **A carried view is not a scrolled view**, and conflating the two made clicking a rail
  entry do nothing at all. `following` is a dependency of the follow-the-tail effect, and a
  smooth scroll emits its first event with the panel barely moved — so a panel parked at the
  tail (where every panel starts) read as still following, the effect re-ran, and the view
  was dragged straight back down before it had gone anywhere. `jump` now holds `carrying`
  until `SETTLE_MS` after the last scroll event and `settle` takes the reading then. For the
  same reason the follow's `requestAnimationFrame` asks whether it is still following when it
  fires, not only when it was scheduled: a click during a live turn lands between the two.
- **A view held is a view being read, and nobody reads an unfocused window.** Letting go of
  the tail is how you read what has just gone past, so it must survive a live turn — but it
  must not survive being away. Turn to an editor while the agent works and it writes another
  round underneath the place you were holding, so coming back lands you mid-round on stale
  news with the newest thing said off the bottom of the panel. `watching` (the studio's own
  focus, passed down from `attention.focused` rather than subscribed to twice) re-arms
  `following` whenever anything arrives while the window is blurred, and the existing follow
  does the scrolling — a second path to the bottom would be a second thing to keep in step
  with the frame it waits. It is gated on something *arriving*, not on the blur: away for two
  seconds with nothing said, the place you were holding is still yours. The other two ways to
  stop watching need nothing — focusing another card already re-arms on `conv.id`, and `read`
  unmounts the panel outright.

  **This shipped not wired up, and did nothing for two months.** `watching` has a default of
  `true` — so that `Markdown.svelte`'s panel is renderable with no studio around it — and
  `App.svelte` mounted `<Transcript>` without the prop, so `if (!watching)` was unreachable
  and the whole re-arm was dead. The symptom is not "the view stayed where I left it", which
  is what a dead re-arm sounds like; it is **"the scroll is near the start of the
  conversation"**, because a held pixel offset that was three quarters of the way down a
  short column is a tenth of the way down the long one an agent spent ten minutes writing.
  Two things follow for any prop like this: a default that makes a component work standalone
  also makes a missing prop silent, and a behaviour whose whole point is that it fires while
  nobody is looking is a behaviour nobody will notice the absence of.

  **And once wired up it fired on the blur after all, because asking a question inside an
  effect is subscribing to it.** `if (!watching)` *reads* `watching`, so `watching` joined
  `streaming`, `lines.length`, `history.length` and `activity` as a dependency of the very
  effect whose comment promised it was not one — losing focus re-ran the effect, re-armed
  `following` on the spot, and the follow effect (which reads `watching` for its own reason,
  below) carried the view to the bottom. So the gate that was supposed to mean "away *and*
  something arrived" meant "away", and the four arrival reads above it were decoration.
  Scroll into the middle of a conversation that finished an hour ago, click an editor, and
  the place you were holding was gone with nothing having arrived to take it. `watching` is
  now read through `untrack`, which is the whole of the gate: the four reads are what wakes
  the effect, and `watching` is only what it asks once awake.

  The general shape, and it is not confined to this file: **in a reactive effect, a condition
  and a trigger are the same act unless you separate them.** Any effect whose comment says
  "gated on X, not on Y" while reading `Y` in an `if` has no gate. The two prior bugs in this
  same effect were about the prop not being passed and about the frame never arriving; this
  one is about a dependency nobody wrote down, and it is the only one of the three that reads
  as the panel actively throwing away what you were reading.

  The follow effect reads `watching` too, and that is the other half of it: Chromium suspends
  `requestAnimationFrame` for a minimised or occluded window, so the re-arm can set
  `following` all it likes and the frame it waits for arrives only on the restore. Re-running
  the follow when focus comes back re-pins the tail; if the tail was genuinely let go of, the
  `following` guard returns and nothing moves.

- **The follow's own scroll event is not you scrolling, and reading it as such is how the
  panel lost the tail while you were sitting there watching it.** `stillFollowing` in
  `outline.ts` is the judgement, pure and tested. A write to `scrollTop` does not dispatch its
  scroll event synchronously — the event lands a beat later, and `onScroll` then asks `atTail`
  whether the view is still at the bottom. A turn writing in bursts moves the bottom *inside
  that beat*, so the answer was about a column that had grown rather than about anything you
  did: the panel concluded you had scrolled away and stopped following, permanently, since
  nothing re-arms `following` while the window keeps focus. `pinned` is where the follow last
  put the view, and every programmatic trip to the bottom goes through `pin` so the next one
  added cannot forget. It is *compared* rather than trusted as a flag, because content landing
  below the view does not move `scrollTop` — so the event reporting our own write reports
  exactly the number we wrote, and anything else is a hand on the wheel. Every deliberate
  gesture (`step`, `jump`, a card change) clears it, so a step landing precisely on the tail is
  still read as yours.

  This is the same distinction `carrying` draws for the rail's smooth scroll, and the follow
  went without it for as long as it has existed. Measured against a card roused at launch with
  a 2 MB transcript: `scrollTop` froze at 212987 while the column grew to 283877 and stayed
  there — three quarters of the way down, which is why the report was "somewhere in the
  middle" rather than "at the top". The two bugs are opposite in signature and worth telling
  apart: **a dead re-arm strands you at 0, a mis-read scroll event strands you mid-column.**

  **It cannot be guarded from `wall.test.ts`**, and that is a property of the suite rather than
  an omission. The suite runs with the studio in the background, which is precisely where the
  `watching` re-arm sets `following` true on every arriving event — so it rescues the panel
  from this and a burst test from out there passes either way. Measured: unfixed and unfocused,
  six rounds of eight concurrent events came back gap 0 every round; the same rounds with the
  re-arm held inert stranded the panel 70890px above the tail. Hence the pure test. Anything
  else about the panel that only misbehaves while the window has focus is in the same position,
  and a green wall test is not evidence about it.
- **The click scrolls by rect, not by `offsetTop`** (`measure` still uses `offsetTop`, since
  it reads every mark on every scroll and the panel is positioned for it). One click can
  afford `getBoundingClientRect` and gets the right answer whatever the panel grows in the
  way.
- **`.rails` is `pointer-events: none`; each rail takes it back.** The gaps around them are
  wall, and the wall pans.
- **The marks go the moment the card does**, before the next collect lands — they point at
  elements no longer in the document, so left up they would list the previous answer and
  measure it at an offset of zero.

### Following the tail, which is not only this panel's

**Near the bottom means stuck to it** — and every scroller in the app that grows at the
bottom wants exactly that: the transcript, the shell's scrollback, a dev server's log in the
servers panel. `follow.ts` is that decision, once, and it was extracted after being made
three times to three different standards. `stillFollowing` and `STICK_PX` used to live in
`outline.ts`; they are in `follow.ts` now, which this panel imports.

- **The hard part is what "near" means while the bottom is moving**, and the answer is
  `pinned`: the position the follow last wrote. The long version is in `stillFollowing`'s
  own comment, because it is three lines that were wrong for as long as the follow existed.
  `Console.svelte` had the naive version of it — `slack < 24`, no correction for its own
  writes — so a burst of build output landing in the beat before the scroll event arrived
  read as a hand on the wheel and the console silently stopped following. `Servers.svelte`
  had none of it: a `pre.log` with `overflow: auto`, which opened at the *oldest* of its last
  hundred lines and stayed there while the group talked.
- **`stickToTail` is an attachment and is the whole of what a plain scroller needs** —
  `<pre class="log" {@attach stickToTail}>`, no state, no effect, no handler. It hears growth
  through `hearGrowth` rather than being told about it, which is what lets it be
  complete on its own: appended lines are `childList`, and a `{#each}` over a sliding window
  of the last N lines rewrites the text of nodes it already has once it is full
  (`characterData`), so past that point nothing is appended ever again. A component that had
  to declare its own growth is a component that forgets to.
- **This panel keeps its own effect, and only borrows the judgement.** It is not a plain
  scroller: a rail carries the view, the keyboard steps it, `watching` re-arms it, and
  `following` is `$state` that its effect graph depends on. `Tail` is deliberately *not*
  reactive — it is a plain class over three numbers, which is what keeps the judgement
  testable with no DOM (`test/follow.test.ts`) — so wiring it in here would cost the panel
  its reactivity and buy nothing. The rule is the shared one; the wiring is per panel.

  **And "the wiring is per panel" is what it took a long time to stop meaning "the growth is
  declared per panel".** The bullet above was written about the plain scrollers and it applied
  to this one all along: the follow effect woke on `conv.streaming`, `conv.lines.length`,
  `conv.history.length` and `conv.activity` — which is every way the *agent* can make the
  column taller and not one of the others. Everything else changed the height with no signal
  behind it and so with nothing to re-pin:

  - the **panel dragged narrower** by its grip, or the window resized. Every line of every
    answer rewraps into a taller column, and there is nothing in the app's own state that
    even *could* have said so; `panelWidth` is arithmetic on a drag.
  - a **fold opened**, since `open` and `shut` are the panel's own `$state`.
  - a **`!` run's output**, which is written into a line that already exists (`#push` returns
    the proxy for exactly this) and so moves no length anywhere.

  Every one of them left the view above the tail with `following` still **true**, which is
  the signature worth knowing: by the panel's own account nothing was wrong, so nothing
  re-armed and only the wheel or the button got you back. Reported as "it keeps ending up
  back up the page, I don't know when, I keep clicking to the end" — and the "I don't know
  when" is the tell. **A follow that enumerates its causes is a follow with a list of
  conditions nobody can finish.** `hearGrowth` is now shared with `stickToTail`: a
  `MutationObserver` for the column and a `ResizeObserver` for the viewport, and the panel
  keeps only what is genuinely its own — `keepTail()`, which coalesces however many reasons
  arrive in one frame into one write and asks `following` again when the frame fires.
- **A fold you have just worked lets go of the tail** (`unfolded`), which is the same argument
  `jump` makes and one the follow had never needed made out loud before: unfolding a call at
  the bottom of a live turn is asking to read *that*, and a follow that hears the column would
  otherwise carry the view straight past the header to the end of whatever was uncovered. Said
  for closing as well as opening, which is safe rather than sloppy — a shorter column clamps
  the view back down onto the tail, and that clamp is a real scroll event, so `onScroll`
  measures it and takes the tail up again.
- **The resize re-measures; a mutation only re-pins.** A rewrap moves every mark in the panel,
  so `far` taken at the old width is a way back that never appears — but a collect walks every
  mark, which is the cost `refresh` exists to throttle, and the content effects already ask
  for it at a rate a stream can afford.
- **`snapToTail(el)` is the imperative nudge**, for a scroller that has to go back to the
  bottom because something was *asked for* rather than printed — sending a command in the
  shell, where you want to watch what it does even if you had scrolled back to read what the
  last one did. Named `snap` because it is instant: `Transcript.toTail` is the other kind, a
  glide you watch, and the two are not interchangeable.

### Reading it from the keyboard

Until now the only ways down the panel were the wheel and the rails, both of which want a
hand on the mouse — at exactly the moment the other hand has finished typing the prompt.
**Ctrl+↑/↓ moves the reading three lines, Ctrl+PageUp/PageDown a screen less two lines of
overlap.** `stepBy` and `landing` in `outline.ts` are the arithmetic, pure and tested;
`Transcript.step` does it; the keys are `App.svelte`'s, in `onGlobalKey`.

- **It does not check `isTyping`, and that is the whole point.** Everything else on the wall
  that reaches past a field checks it first. Here the moment you most want to scroll an
  answer is the moment you have just pressed Enter, with the caret still in the draft, so a
  binding that worked everywhere except in the field would fail exactly where it is for.
  Ctrl is what buys the right to fire inside a field: bare arrows stay the caret's, bare page
  keys stay the field's, and ctrl+arrow is not a text gesture Chromium binds in a textarea,
  so nothing is taken away. The palette's own arrows are narrowed to bare ones for the same
  reason — a palette open over the draft is no reason to stop answering a question asked of
  the other half of the window.

  The rule it is an exception to: **a bare key that means something to a field belongs to the
  field.** Tab, Delete and a bare printable character were all guarded with `isTyping`;
  `Home` was not, so fitting the wall fired with the caret in the draft — and since the
  branch calls `preventDefault`, the key was swallowed rather than merely doubled up and the
  caret did not move at all.
- **Measured in lines, never in pixels.** The transcript is scaled by `--read`, so a step of
  sixty pixels is three lines at 100% and one at 300% — the same key moving a different
  amount of reading depending on how large you had set the reading. `lineHeight` measures a
  real `.line` rather than recomputing the `calc`, or a step would disagree with the text it
  moves and leave a sliver of the previous line at the top of every page.
- **Instant, unlike `jump` and `toTail`.** Those are one deliberate leap to a place you
  named, where seeing yourself travel is what tells you where you went. A step is the reading
  advancing, and a held key would spend the press fighting the animation it started a frame
  earlier. It calls `stopGlide` for the reason the wheel does.
- **`following` is not touched.** An instant write to `scrollTop` fires a real scroll event,
  so `onScroll` takes the reading exactly as it does for the wheel — stepping up off the tail
  lets go of a live turn, stepping back down onto it takes it up again, and there is no
  second path to the bottom to keep in step with the frame the follow waits for. This is why
  `landing` clamps rather than letting the browser do it: the last press of a run down has to
  land *on* the tail.
- **Aimed at the focused card alone**, like Escape's stop — the panel only ever shows one
  conversation, and a gathering has no reading to move. With no panel open the binding is
  undefined and the keys are somebody else's.

`snapshot.panel` reports `scrollTop` and `scrollMax`. Both, because either alone is
unreadable from outside: a `scrollTop` of 0 is the top of a long transcript and also every
position of one that does not fill its panel, where the keys are correctly a no-op.

### A path in a tool call opens the file

`ToolCall.svelte` turns a `path`-form argument, and every `path:line` in a result, into a link
into the finder's file viewer. The reasoning — why `insideRoot` returns null rather than
clamping, why a bare filename in prose is deliberately *not* a link, and why backing out of a
viewer opened this way closes the panel instead of stepping back to a list nobody opened — is
in `.claude/rules/finding.md`, which owns the viewer. What belongs here is only the house rule
it obeys: the links are text with a dotted underline, not coloured, because **colour on this
wall is status** and a path is not one. Same argument the diff two screens up makes about not
being red and green.

### Reading what a background job is printing

The panel grows a drawer between the column and the footer, listing what the card has running
in the background and tailing the output of whichever one you expand. Sink 80e0a4ad: "I can't
find a way to check the logs of subprocesses of a card — for example a dev server, a
long-running task. I would like to be able to display the log directly in the transcript."

`jobs.ts` is the arithmetic, `Jobs.svelte` the drawing and the effect, `joblog.rs` the read.
The record it draws from is `Conversation.jobs`, which `.claude/rules/turns.md` owns; nothing
new is folded here.

**`Processes.svelte` is not this**, and it was checked before anything was built. It lists a
card's job object by pid, cpu, memory and age, and can end one — it answers *what is in
there*, and never *what is it printing*.

#### Why a drawer and not a line in the column

The obvious home is the `Bash` tool call that started it: already in the transcript, already
openable, already knows its own arguments. It is wrong for two reasons that only appear once
the thing is actually running.

- **A dev server is started once, hours ago.** Its call is a long way up a scrollback you
  would have to go and find, which is the opposite of what you want from a running process —
  the same thing you want from a card, *where is it now*, reachable without hunting.
- **This panel follows its own tail.** A pane growing in the middle of the column either
  fights the follow or scrolls out from under you as the turn above it writes.

So it sits in the one strip of the panel that does not move, and is **absent entirely** when
the card holds no background work, which is most cards most of the time. Nothing is added to a
panel that has nothing to say. Open, it takes a bounded share (`max-height: 40%`) — the
transcript is what the panel is for.

One job expanded at a time. Two logs in a strip this size would give each three lines.

#### The poll, which is the fourth in this app and owes an argument

`CLAUDE.md` names exactly three places that go and look rather than fold an event, all three
because the thing being watched emits nothing, and says anything proposing to be the fourth
owes one of those shapes and the same argument. A file being appended to by another process is
squarely that case. The argument:

- **It is not a fourth clock.** The prescription in that section is to find an event that
  already exists near the thing and fold *that*. The wall's one-second tick is one, is already
  the only wake-up on an idle machine, and is exactly the cadence a person reading a log
  wants. So this adds no timer, no lifecycle, and nothing for `Listeners` to release.
- **What is left over is bounded three ways, any of which switches it off entirely.** Only
  while a job is *expanded*, so it takes a deliberate act to begin at all; only while
  `watching`, which is window focus, so a wall left up overnight reads nothing; and never past
  the job settling, since `conv.jobs` drops it and the drawer goes with it. That makes it the
  most tightly bounded of the four — the only one that needs an eye on it to exist.

`watching` is passed down rather than subscribed to here, for the reason the panel takes it
rather than asking: `attention.svelte.ts` already owns the window's focus and a second
subscription is a second thing to release.

#### Incremental, and the three things that were got wrong first

Each read starts where the last one stopped, so a 40 MB dev-server log costs one read on
opening and a few hundred bytes a second afterwards. **The seek is Rust's and the fold is
TypeScript's**, which is a real division rather than an accident: choosing an offset needs the
file's length, and asking for that from here would be a second round trip per tick for a
number the read is about to have anyway. The contract between the halves is the offset
actually read from — the fold compares it against the one it expected — so neither side has to
trust the other's arithmetic, and both are tested where they live.

- **A log is opened at its end.** `UNREAD` is `-1`, not `0`, because `0` is a real offset and
  the one a truncated file legitimately takes. Conflating them reads a 40 MB log from the
  beginning and shows the morning's startup banner as though it were now. Opening at the end
  means the first chunk begins mid-line, so its leading fragment is dropped — kept, it opens
  the pane on something that reads as corruption.
- **Continuity breaks are not spliced.** A file that shrank, and a burst too large for one
  read, are the same case: what is held is no longer contiguous with what arrived. Both drop
  what is held rather than gluing on. Splicing shows two halves of different minutes joined at
  a line boundary, with nothing saying so.
- **Bytes are trimmed to character boundaries at both ends.** A seek lands mid-sequence about
  one time in a hundred on non-ASCII output, and a process *still writing* can leave a
  character half-written on a pipe. `from_utf8_lossy` on an untrimmed window puts a
  replacement glyph in the middle of a word once every few reads.

A line with no newline yet is held apart from the drawn lines and redrawn rather than appended
to, or a progress line arriving in three writes becomes three rows.

#### What it says about what it cannot show

Two bounds, and both are stated rather than left to be inferred, on the rule that **a silent
cap reads as having shown everything**: `missing()` says how much of the file was stepped over
("4.9 KB earlier isn't shown — opened at the end"), and the foot says how many lines are on
screen. The in-memory tail is capped at 400 lines — a bound on the *process*, not the pane,
since unlike a widget on the wall a scrolling panel has no height deciding what fits, and a
dev server prints all day.

An empty pane has four different things it might mean and they are four different sentences
(`absence`). The one worth care is `nofile`: a `Monitor` and an `Agent` name no output file in
their receipt and theirs is derived from the session and the task id, so a CLI that moved its
task directory lands there — and the honest answer is that the file is not where it should be,
never an empty pane that reads as a silent process. Same bargain `store::pending_jobs` strikes
when it existence-checks a derived path.

Tone comes from `buildlog::diagnosticOf`, deliberately and not a fourth copy of the same
judgement: what a backgrounded command is, nearly always, is a build, a test run or a server —
which is the subject that function was measured against. The gutter mark is null throughout,
since every line came down one pipe from one command.

The tail follows itself with `{@attach stickToTail}` and nothing else, which is the rule this
file already states for every scroller that gains content at the end.

#### One Svelte trap, since it cost ten minutes and names nothing

**A local called `derived` shadows the rune.** Every `$derived` in the component is then parsed
as `$` applied to that variable, and what `svelte-check` reports is a page of errors about
`SvelteStore` and `subscribe` — with no mention of runes anywhere in them.
