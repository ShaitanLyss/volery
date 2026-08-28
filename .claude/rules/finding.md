---
paths:
  - "src-tauri/src/find.rs"
  - "src/lib/finding.ts"
  - "src/lib/finder.svelte.ts"
  - "src/lib/Spyglass.svelte"
  - "src/lib/dogears.ts"
  - "src/lib/Dogears.svelte"
  - "tools/probe-places.ts"
  # ToolCall is panel.md's file first, but half of "a path opens the file" lives
  # in it — so this loads there too rather than trusting a pointer in prose.
  - "src/lib/ToolCall.svelte"
---

# The finder, and the file viewer

### `<space>ff` and `<space>fw`

Telescope, on the wall. Lifted from nvchad because that is the gesture these hands already
have: `<space>ff` finds a file by name, `<space>fw` finds a word in one. It is the same shape
as the floating shell — summoned from anywhere with one chord, over the wall rather than
instead of it, opaque and without a scrim — and it is built to the same three-way split, for
the same reason: `find.rs` is primitives, `finding.ts` is pure and tested, `finder.svelte.ts`
owns the session, `Spyglass.svelte` draws it.

**The component is `Spyglass` and the class is `Finder`**, which is not a whim. A
`.svelte.ts` module and a `.svelte` component of the same name are one module path to two
files, and TypeScript says so — the same split `Console`/`Shell` and `Pomodoro`/`Cycle`
already have.

### Space is the leader, and it costs nothing

This is the part that looks like it should not work. `onGlobalKey` ends with a branch that
takes any bare printable key into the focused card's draft — "the wall has no single-letter
shortcuts, so a printable key means only one thing" — and a space is a printable key.

It is free anyway, and the argument is worth keeping because it is the only thing that
licenses a leader here at all: **a prompt never begins with a space.** By the time a space is
a space, focus is in the draft field, `isTyping` is true, and this ladder does not run. The
one gesture the leader takes away is appending a leading space to an empty draft, which is
not a gesture.

Everything else about the leader is nvim's behaviour, deliberately, because that is what the
hand expects:

- **A key that completes no chord falls through.** `<space>q` leaves you with a `q` in the
  draft — the space did nothing, and the `q` is still a `q`. `chord` reports `swallow: false`
  for that case and `App.svelte` does not `preventDefault`, so the key goes on to the branch
  that would have had it. A finder that ate it instead would be a wall where a letter
  occasionally vanished into a gesture nobody made.
- **Escape is the exception** — it abandons a sequence *and* is swallowed, because a press
  meaning "I did not mean to start this" must not also deselect the card.
- **A sequence lapses after `LAPSE_MS`** (nvim's `timeoutlen`, 1000ms), and the lapse is
  checked *before* the key is read, so the key is then reconsidered from scratch. That is
  what makes a second leader press after a wait open a fresh sequence rather than be read as
  `<space><space>`.
- **A modifier pressed on its own changes nothing**, in either direction. Every modifier
  fires its own keydown, so without this a hand brushing Shift between the leader and the
  letter would abandon the chord — and `<space>Shift+F`, which is how a caps-locked keyboard
  types it, would never fire. `press` also refuses to restart the stopwatch on one, since a
  held Shift repeats its keydown and would keep a forgotten sequence alive under a resting
  finger.
- **Time is passed in, not read.** `chord(open, key, sinceMs)` is pure, so the lapse is part
  of the rule the tests can see rather than a `setTimeout` somewhere nothing can reach. The
  timer in `finder.svelte.ts` is only about *the hint*, which has to go away on its own.

**The which-key hint lives in `Spyglass.svelte`**, and `App.svelte` renders the component for
a pending chord as well as for an open panel. Two reasons, and the second is the load-bearing
one: a half-typed leader is the only gesture on this wall with no affordance at all — every
other binding is on a button or in a `title` — and **a component is the only CSS scope this
codebase has**, so a `.hint` in App's 565-line stylesheet is exactly how `.ghost` came to
mean two things (see `test/styles.test.ts`).

### Two modes, one panel

`ff` and `fw` are one panel with a setting, not two panels, and ctrl+F swaps between them
**without losing the query**. That is the gesture the arrangement exists for: you type a word
looking for a file, do not find it, and want to know where the word *is* — and retyping it is
the tax that makes you not bother. Opening via a chord clears the query, because a chord is
you starting a search; `swap` keeps it, because that is the same search asked a different way.

`Row` is one type for both modes on purpose. The keyboard, the preview and the viewer must
not have to know which mode produced a row — and that is what let grep mode answer with file
*names* as well as contents without a second code path anywhere.

### The file list is fetched once and filtered here

This is the whole reason the panel feels like telescope rather than like a search box.
Paying `rg --files` per keystroke makes the panel a thing you wait for, so files mode is
**one subprocess per open** and pure scoring per keystroke — which also puts the interesting
half in `finding.ts`, where it is tested rather than reasoned about.

Measured by `cargo run --example find-probe` on 2026-08-23 against ripgrep 15.2.0: this repo
is **350 paths in 70ms**, and `C:\atelier` — 26,000 files across a dozen projects including
an Unreal tree — is **25,957 paths in 181ms**. Both are far enough inside `FILE_CAP` that the
once-per-open fetch is plainly the right trade.

Grep mode cannot work that way, since nobody has the project's contents in memory, so it does
run `rg` per query. Three things bound it:

- **Debounced** (`GREP_MS`, 120ms), so a six-letter word is one subprocess rather than six.
- **A generation guard.** Answers land out of the order they were asked in — a grep for `f`
  takes longer than one for `finding` — and without `#gen` the list flicks back to the
  broader answer a beat after the narrower one arrived.
- **The child is killed at `HIT_CAP`**, not drained. The difference between capping the
  *answer* and capping the *work* is a panel that stays responsive while you type the second
  character of a one-character query.

**And the honest limit, measured over the same 26,000-file tree: a one-character `e` comes
back in 61ms because the cap lets it stop, and a *rare* word takes 2.5s because nothing does
— every file has to be read to the end to prove the word is not in it.** So the cap bounds
the cheap case and cannot bound the expensive one. What bounds that is the debounce and the
generation guard together: one run per pause in your typing, and no stale answer ever drawn.
Worth knowing before anyone proposes removing either, and worth knowing as a *user* — on a
tree that size a precise `fw` query is a beat behind your hands, and the panel says `working`
while it is.

The list is re-fetched on **every** open, with the old one left on screen while it runs — a
file created two minutes ago has to be findable, and the alternative (a cache with an age) is
a finder that is right most of the time about the one thing it exists to know.

### What the scorer prefers, and why

Greedy left-to-right subsequence matching, which is not optimal and is the right trade: an
optimal alignment over 40,000 paths per keystroke is a dynamic program per path, and greedy
plus these bonuses picks the same winner in every case anybody types.

- **Consecutive runs**, compounding along the run, so a whole substring is worth far more
  than two halves. This does most of the work.
- **Word starts** — after `/ \ _ - .` or a space, or a camelCase step. This is what makes
  `slt` find `src/lib/theme.ts`.
- **The basename over the directory**, heavily. Without it `store` means the sixty files
  under a `storage/` folder rather than `store.rs`, which is the one query that would have
  told you the scorer was wrong.
- **Shortness**, faintly, as the tiebreak and with a floor, so a deep path is never scored
  out of the running by its depth alone.

Case is never a filter, only a bonus — nobody types the capital in `Transcript` when they are
looking for it. A space in the query is a separator rather than a character to find, which is
what makes `lib theme` behave as two terms with no splitting anywhere.

**The match spans are drawn**, and they are not decoration: without the marks you cannot tell
why the third row is above the fourth, which is the difference between a fuzzy list and a
list of guesses. `shift` re-bases them from the whole path onto the filename, and **drops**
the ones that fell in the directory rather than clamping — a clamped half-span marks the first
character of the filename, which is a character that did not match, and marking the wrong
thing is worse than marking nothing.

### The viewer is one step in, and Escape is free

Enter opens the file where it is; Escape returns to the list with the query and the selection
exactly where they were; Escape again puts it away. The step back has to be free or you stop
using Enter to look at things — which would leave the finder as a thing that finds paths
rather than a thing that shows you files.

**This used to say "there is no editor on this wall", and there is one now** — the panel has a
third reading, and `e` from here hands the file to your own nvim at the line you were looking
at (`.claude/rules/editing.md`). The viewer did not become it, deliberately: a real nvim config
takes about five seconds to start, and putting that in front of every Enter on a grep hit would
have cost the cheap reading this whole section is about. So the two are one panel and two
steps — found, read, edited — and the step between the last two is one key each way.

- **It opens at the line you were looking at**, centred — a hit on line 900 of `store.rs` is
  the whole reason you pressed Enter. The *list* uses `block: "nearest"` instead, because
  centring on every arrow press makes the whole list travel under a selection that never
  appears to move.
- **The panel holds the keyboard, not the field.** The viewer has no field, so `.pane` carries
  `tabindex="-1"` and the scroller is focused when the viewer opens — otherwise Escape and
  ctrl+R land on the window, whose handler is the one switched off while this is open.

**A markdown file opens rendered**, through the repo's own `Markdown.svelte`, so a rule reads
here exactly as an agent's answer reads in the transcript. Half the files worth finding in
this repo are `.claude/rules/*.md`, and a rule read as a wall of `##` and backticks is a rule
nobody reads. `nav={false}`, since that flag is about the transcript's rail listing a
paragraph and there is no rail here.

**The raw toggle is a preference, not a per-file switch**, and that is the one part worth
arguing. Resetting it per file would mean pressing ctrl+R again for every rule you opened once
you had decided you wanted the source — the first press is you correcting a default, and a
default you have to correct repeatedly is not a default. So: rendered until you say otherwise,
then as you said, for as long as the wall is up. Extension rather than content-sniffing,
because a heuristic that is right 95% of the time about *whether to render* is worse than a
rule you can predict.

The preview beside the list is deliberately **not** rendered, in either mode. Its job is to
show you *where* a hit is, and that is a line number and a column; a rendered document has
neither.

### A file it draws rather than reads

An image or a film opens *as one*. Before 2026-08-28 it did not: `read_text` sniffs the head
for a NUL, a PNG has one, and the viewer said **"not a text file — nothing to read here"** —
which is the right sentence for a `.exe` and the wrong one for a screenshot, since that is a
file it can show perfectly well. Sink 28409145.

- **Two lists, and they have to agree.** `finding.ts`'s `IMAGES`/`VIDEOS` answer "ask Rust for
  bytes instead of text"; `find::media_type` answers "and here is the MIME string". The seam
  has nothing to import across it, the same arrangement `relay.ts` has with `relay.rs` — so
  `agrees with the Rust half about every extension` reads the table **out of `find.rs`'s
  source** rather than transcribing it, and asserts the two sets non-empty first so it cannot
  pass by having parsed nothing.
- **By name here, by content there, and that is not inconsistent.** Sniffing bytes answers *is
  this text*, which an extension cannot be trusted about because a file with no extension is
  perfectly normal. The extension answers *which element should draw this*, which only the name
  can say — there is no byte pattern separating a file the webview renders from one it shows a
  broken-image glyph for.
- **A `data:` URL, not the asset protocol, and that is a containment decision.**
  `tauri.conf.json` enables `assetProtocol` scoped to `$APPDATA/references/**` — pinned images,
  which Volery itself put there. A project root is chosen at runtime and that scope is static
  configuration, so reaching one would mean widening it to `**` — and it would route around
  `safe_join`, which is the only thing between the viewer and every file on this machine. The
  bytes come through Rust past the same join every other read uses. `a_media_read_cannot_climb_out_of_the_project`
  is the guard.
- **`MEDIA_CAP` is 16 MB and it is *said* rather than truncated.** Half a PNG is not a smaller
  PNG, it is a broken one, and an `img` that fails to decode reads as a bug in the viewer
  rather than as a file that is too big. Over the cap the panel gives the size and offers `e`,
  which opens it outside — so the answer is never "no".
- **`svg` is in neither list**, and it is the omission worth knowing. It is text, so the viewer
  already opens it and shows what it contains, which is the more useful reading of a file you
  are looking at in a code viewer. It is also a document that can carry script in an app whose
  `csp` is `null`.
- **A video gets `controls` and nothing else** — no autoplay, no loop, no muted-autoplay trick.
  Opening a file in a viewer is a reading gesture, and a film that starts playing because you
  looked at it is the panel doing something you did not ask for.
- **`media` sits on `Sheet` beside `text`, not in a second cache.** The viewer's whole subject
  is "the file you are looking at" and there is exactly one of those; a separate cache would be
  two eviction policies and two ways to be stale. `binary` stays *false* for media, because
  that word means "cannot be shown at all" and the viewer already has a sentence for it.

### Getting there from a transcript

The finder finds files; the place you most often want to *look* at one is while reading what an
agent just did to it. So a path in a tool call is a link into the viewer — the `path`-form
arguments (`file_path`, `cwd`, `scriptPath`, and the rest of `PATHS` in `toolcall.ts`), and
every `path:line[:col]` in a tool's **result**, which is what turns a `Grep` answer from a wall
of matches into something you can walk.

**Two functions in `finding.ts` make it possible, and the asymmetry between them is the whole
lesson.**

`insideRoot(path, root)` is the front-end mirror of `safe_join` in `find.rs`: a transcript is
full of absolute paths, the viewer reads `(root, relative)`, and Rust refuses anything that
climbs out. **Null is the useful answer** — a tool call can perfectly reasonably name a file in
another repository, in `%TEMP%`, or in the engine directory, and none of those can be opened
here. Those stay inert text, because *a link that fails when pressed is the one outcome worse
than no link*.

`placesIn(text)` finds the places in a result, and its guards matter more than its pattern.
A candidate must carry a **file extension** before the colon, which is what rules out `10:30`
and `Error at 5:12`. The **matched text** is checked for `://` rather than what precedes it —
the path character class includes `/`, so `http://example.com:8080` otherwise parses as a path
of `http://example.com` and a line of 8080, and looking backwards would never have seen it.
There is **no space in the path class**, a deliberate loss: allowing one let a match run
backwards through prose (`see src/lib/a.ts:42` parsed with a path of `see src/lib/a.ts`), so
`C:\Program Files\x\a.ts:3` is missed — the right way round to fail.

**And the guard that measurement added rather than reasoning: a relative candidate must carry a
separator.** `tools/probe-places.ts` reads the real tool results out of this machine's
transcripts and reports what `placesIn` finds in them. Over 1,153 of them it turned up
`RailReplayTests.cpp:282` and dozens like it — a *filename mentioned in prose*, which
`insideRoot` then happily reduced to a root-relative path that does not exist. Exactly the dead
link the whole pattern exists to avoid, and nothing about reading the code would have shown it.
The guard took the count from 520 places to 392 and left the `Grep` results untouched.

So the two functions ask for different evidence on purpose: a bare name given as a tool's
`file_path` **is** a path, because something passed it to a tool that opened it; a bare name in
a sentence is somebody talking about a file. `package.json:3` in prose is not a link, and that
is the price.

**A line, only when the call actually said one.** `startLine` in `toolcall.ts` reads `Read`'s
`offset`. An `Edit` names the text it replaced rather than where, and finding that text in the
file would put the viewer confidently in the wrong place whenever the string occurs twice — so
the honest answer is null and the file opens at the top.

**Where "back" goes depends on where you came from**, and `alone` is the flag that knows.
Opened from a result, Escape returns to the list with the query and the selection intact.
Opened from a transcript there is no list behind it, and dropping you into an empty finder over
a project you never searched would be one gesture answered with two — so that case closes the
panel and gives you back what you were reading. The header's button says which (`results` or
`close`), because the two states draw an identical panel and differ only in this. `alone` is
cleared by `hide` and by `show`, or a later chord would inherit it.

The links are drawn as text with a dotted underline that firms up under the pointer, not as
links: this is a wall of machinery, and a coloured underline through every path in a `Grep`
result would be decoration where `tokens.css` reserves colour for status. `LINK_LINES` (300)
bounds the linkified result — the default fold is 24 lines, so it only bites once you have
asked for the whole of something long, and past it the text is drawn plain as it always was.

### `find.rs`

- **All three commands are `async` and go through `off_main`.** A `rg` over an Unreal tree is
  seconds of work, and a `#[tauri::command]` without `async` runs inline on the thread that
  drains the event loop — so a slow grep would not be a slow grep, it would be every card on
  the wall frozen for exactly that long with the whole backlog landing at once. That is the
  20s `azdo_runs` freeze in a different hat; see the note over `off_main` in `lib.rs`.
- **The spawn is the probe**, the trick `shell.rs` uses to find a PowerShell: `rg` on `PATH`,
  then VS Code's bundled copy, and the first that starts wins. Cheaper and more honest than
  walking `PATH` for a name that may be a Store alias stub. There is deliberately **no**
  fallback to a directory walk of our own — re-implementing ripgrep's gitignore handling
  badly means a finder that offers you `node_modules` and `Binaries`, which is worse than one
  that says out loud it needs ripgrep installed.
- **`--hidden` with `--glob !.git`** is a pair, and neither half works alone. Without
  `--hidden` this repo's whole `.claude/rules/` tree — the thing an agent looks for most — is
  invisible. With it and nothing else you get several thousand objects out of `.git`.
- **The query is a pattern that falls back to a literal.** A regex is what a developer typing
  into a search box means most of the time and what ripgrep does by default, but this box is
  typed into one character at a time and half the useful queries pass through an invalid state
  on the way — `foo(` is a parse error, and an empty result is indistinguishable from "nothing
  matches". So exit code 2 *with no hits* re-runs with `--fixed-strings`, and the panel says
  `literal` when that happened. One retry, on the error path only. Probed against ripgrep
  15.2.0: 0 is matches, 1 is none, 2 is "I could not do what you asked".
- **`--max-columns-preview`**, not just the cap. Probed against 15.2.0: the cap alone replaces
  a long line with the literal text `[Omitted long line with 1 matches]`, which parses as a
  hit and reads as one.
- **A hit line is split by position, not on `:`.** A line of source has more colons in it than
  the structure does, and `parse_hit` walks left looking for the digits-colon-digits-colon
  shape rather than assuming where the path ends.
- **`safe_join` refuses anything that leaves the project.** In normal use it can never fire —
  the finder only ever asks for paths `rg` gave it — which is exactly why it is there: a
  command is reachable from anything holding the IPC and not only from the code path that
  meant to call it, so "read me any file on this disk" is a capability worth not handing out
  by accident. The same argument `open.rs` makes about checking a url's scheme in Rust as well
  as in `markdown.ts`. `..` is refused rather than resolved, since resolving means
  `canonicalize`, which needs the file to exist and answers differently for a symlink.
- **Binary is detected on the bytes**, not on the extension: an extensionless file is normal,
  and `from_utf8_lossy` over an `.exe` is a screenful of `�` that reads as a rendering bug
  rather than as "this is not text". Truncation cuts at the last newline inside the cap, which
  also guarantees it never cuts inside a UTF-8 sequence.

### The files kept to hand

The viewer was very good at getting you to a file and had no memory at all: read halfway down
`store.rs`, press Escape to look at the card beside it, and getting back was `<space>ff`, four
characters, Enter, and the scroll all over again. Which is enough friction that you stop
looking things up — the failure mode of a reader with no bookmarks is that it stops being used
rather than that it is annoying.

So every file the viewer opens leaves a **dog-ear**: a pill on a strip above the dock,
`Dogears.svelte`, with the arithmetic in `dogears.ts` (`test/dogears.test.ts`, 37 tests).

**A tab is a reading, not a path**, and that is the whole design. It carries where the
scroller was, what was selected, and *which of the two readings* it was in — because "the
state I was at" is all three, and a tab that only remembered the path would have saved you the
four characters and none of the scroll.

- **Character offsets, not a line and a column.** This looks like the harder answer and is the
  easier one: the source view is line-numbered `div`s and a rendered document is arbitrary
  markup, so a line/column pair works in one and means nothing in the other. A flat offset
  over the container's text nodes works in both, in twenty lines, and is exact for as long as
  the DOM is the same — which it is, since the viewer renders the whole file rather than a
  window of it. `flatOf` and `locate` are the two inverses and they are pure; the only
  untestable line in the arrangement is the `TreeWalker` in the component.
- **The capture is at the gesture, never in a teardown.** A Svelte `$effect`'s cleanup runs
  *after* the DOM has been updated for the change that triggered it, so by the time a
  teardown asked for `scrollTop` the scroller would already be showing the next file. So
  `Finder.#keep` runs at the top of every gesture that stops showing the current file —
  `show`, `hide`, `back`, `look`, `lookAt`, `resume` — because **the only moment a reading is
  true is before the state that draws it moves.** That generalises past this file: anything
  reading the DOM as a side effect of state changing has to read it *first*.
- **The component is told how to read itself**, `Finder.reader`, the same injection `where` is.
  A scroll offset and a `Selection` are facts only the thing that drew them can see, and the
  finder asking the DOM for them itself would be the one place in it that knew what it was
  rendered into. Cleared by `detach`, since a reader holding a superseded generation's
  `bind:this` answers about a node nothing is drawing.
- **The reading being put back is *not* `$state`.** The effect that applies it keys on `sheet`;
  a reactive field cleared on consumption re-runs that effect with nothing pending, which falls
  through to the open-at-the-line branch and scrolls away from the reading it had just
  restored. `takeResume` hands it over once.
- **Restore the selection, then the scroll.** Putting a selection back scrolls to it, and where
  the scroller actually was is the more precise of the two facts.

**A fresh open is not a resume**, and the difference is what the tab forgets. `remember` clears
the stored reading: you asked for line 900 of `store.rs`, so line 900 is where it opens, even
if a tab for that file is carrying a scroll from an hour ago. `resume` is the gesture that
means "back to where I was", and it is a second entry point rather than `lookAt` with extra
state for exactly that reason. Switching between source and document forgets it too — the
offsets describe a DOM that is about to stop existing, and landing in the middle of a rendering
with half as many lines as the source is worse than opening at the top.

**Resuming writes the `raw` preference, and that is the one thing here worth arguing.** The
toggle is a preference and not a per-file switch (see above), and this is the only place other
than the toggle that writes it. The reconciliation: what `raw` decides is what a file opened
*fresh* is drawn as, and resuming a tab is not opening a file fresh — a reading includes which
of the two it was, and restoring a scroll into a view that is not on screen restores nothing.

**A tab that fails when pressed is closed rather than left standing.** A file renamed, or a
branch switched under it, makes `read_file_text` fail; the fault goes in the panel and the pill
goes with it. Same argument `insideRoot` makes about not drawing a link it cannot open.

#### And what the tabs paid for: a press outside puts the panel away

This is the second-order effect and it is the more interesting half. Dismissing on an outside
click was never available before, because closing cost you the whole search and the whole
scroll — so the only way out had to be a deliberate Escape, and a stray click could not be
allowed to mean it. Once leaving leaves a pill, closing is cheap and the panel can behave the
way every other dismissible thing on this wall does.

- **`pointerdown`, not `click`** — `ContextMenu`'s reasoning exactly: the panel should be gone
  before the thing underneath decides what that press meant.
- **No catcher, though.** `ContextMenu` can afford an overlay and this cannot: the whole
  argument for having no scrim is that the reason you are reading a file is usually the card
  beside it. So the listener is at the window and swallows nothing — one press both closes the
  panel and reaches the card, which is what clicking a card while a file is open should do.
- **The strip is excluded**, since clicking another tab is switching files rather than
  dismissing, and it would otherwise close and immediately reopen. So is any button but the
  primary one, because a right-click is asking the wall for a menu.

The general shape worth keeping: **a gesture becomes affordable when the thing it costs stops
being expensive.** The no-scrim decision and the Escape-only decision were both correct
against a viewer with no memory, and only one of them still is.

#### The fuse, and why it is not a cap

There is **no limit** on the tabs. There is a number that are *safe* — the five most recently
touched — and a fuse under everything below that line: fall out of the top five and you have
five minutes. Coming back to a tab makes it the most recent again, which both takes it off the
fuse and resets it.

That beats a hard cap for the reason a hard cap always fails: the sixth file you open is not
the least interesting one, it is the newest, and a cap would either refuse it or silently throw
away the tab you were about to go back to. **Time is the only thing that distinguishes a file
you are done with from one you are between.**

- **Nothing here schedules anything.** Expiry is time passing, and the wall already has a
  one-second tick every card folds (`clock`). `reap` is a fold over it, and it answers with the
  *same array* when nothing has gone — a second in which nothing expires must not be a write,
  or every `$derived` reading the strip is invalidated once a second forever. This is the shape
  CLAUDE.md asks for: when the thing you care about emits nothing, find an event that already
  exists near it rather than starting a fourth poller.
- **Order in the strip is the order they were opened, never recency.** A strip whose pills
  rearranged themselves every time you used one is a row of buttons that are never twice in the
  same place. Recency is `touched`, and the only thing it decides is the fuse. Ties in `touched`
  are broken by position, or two tabs stamped in the same millisecond would swap ranks between
  ticks and a pill would flicker on and off its fuse.
- **The last second is kept.** `reap` drops at `<= 0` and the hairline draws `> 0`, so the pill
  and the fuse agree about the final second instead of the pill vanishing a beat early.
- **Only a tab that has one gets a hairline.** A line under every pill reads as chrome; this
  has to read as a thing running out.

#### Where the two knobs live

`tabs kept` and `close after` are on the strip itself, behind the `⋯`, and not in a settings
panel. There is no general settings panel in this app — the chime is a bar toggle, the reading
is the themes panel, the ambience is its own — and inventing one for two numbers puts them a
panel away from the only thing they are about.

- **`keep: 0` is the off switch**, and it clears the strip rather than leaving the pills to
  expire. Which creates the trap the strip is shaped around: knobs reachable only from a strip
  the knobs can empty would be a setting you can enter and not leave. So the strip also stands
  whenever the finder is open — if you are using the viewer at all, what it remembers is
  adjustable.
- **`Number("")` is 0, and 0 means "keep none".** So clearing the field would arrive as an
  explicit off switch nobody asked for; `readNum` checks for emptiness *before* coercing, and
  anything unreadable is the default rather than zero. Found by the test, not by reading the
  code.
- **localStorage, behind `readKnobs`/`writeKnobs`** — the same seam `theme.svelte.ts` draws.
  Right here rather than merely available: a tab is per-machine and disposable by construction,
  and two numbers about how long a pill stays on the bottom of *this* window are not authored
  work. The tabs themselves do not persist at all, which the fuse already implies — a strip
  restored at launch is a set of readings from before the wall came down.

#### Where the strip sits

Absolutely placed inside `main.wall`, anchored by `bottom` — and that is the whole of its
placement, with no arithmetic. The wall ends exactly where the dock begins, so the strip sits
on the dock's top edge however tall the draft has grown. (The which-key hint one file over
hard-codes `bottom: 5.2rem` because it is `position: fixed`; this is what that would have
wanted.) `z-index: 5` clears `Canvas`'s `.glass`, said out loud because this is later in the
document than the canvas and earlier than `.side`, so source order alone would put it behind
the transcript. It may cover the transcript's bottom edge when the tabs wrap, which is the same
bargain the glass strikes: over the panel, never over the dock or the header — and that last
part is a fact about the DOM rather than a number.

`pointer-events` are off on the strip and on again per pill, so the gaps between them are still
wall. A rectangle across the bottom of the window that swallowed a click on a card would be a
strip that cost you a gesture — the same bargain `.glass` and the which-key hint strike.

A pill says **one directory segment and the filename** (`rules/finding.md`), with the whole
path in the tooltip. Not the full path, which does not fit and whose truncation eats the
filename you are reading; not the bare name, which loses the difference between three
`mod.rs`.

### Where the bounds are, and that they are said out loud

`FILE_CAP` (40,000 paths), `HIT_CAP` (2,000 lines), `LINE_CAP` (400 chars), `VIEW_CAP` (2MB),
`SHOWN` (200 rows), `VIEW_LINES` (6,000 rows). Every one of them is a cap on what is *read* or
*sent*, never on what is drawn — the rule `conversation.svelte.ts` states about `Line.cap`: a
cap that only bites at render time is not a memory bound.

And the two that can hide an answer say so in the header — `capped` when the project has more
files than the finder holds, `+` on the count when the hits were cut short. A finder that
quietly cannot see a file is worse than one that admits its bound.

### Where things live

- `finding.ts` — pure and tested (`test/finding.test.ts`, 62 tests): the leader machine, the
  scorer and its spans, `rank`, `fileRows`/`grepRows`, `moveIn`, `viewLines`,
  `windowAround`, `isMarkdown`, `splitPath`, `shift`, `pieces`.
- `finder.svelte.ts` — `Finder`: the session, the debounces, the generation guard, the small
  sheet cache, and the Tauri calls. Told **where to look** rather than reaching for it
  (`finder.where`, the injection `devops.roots` and `pomodoro.watched` use), so it cannot see
  the wall. Holds timers and no subscriptions, and `App.svelte`'s `onDestroy` releases it — a
  superseded generation's debounce firing a grep into a panel nobody can see is the same
  hazard a leaked listener is, one layer down.
- `Spyglass.svelte` — elements, and nothing else. Every piece of arithmetic it needs is
  imported from `finding.ts`. Plus the two functions that read and write a `Reading`, which are
  here because a scroller and a `Selection` are the only facts in the whole arrangement that
  nothing else can see.
- `dogears.ts` — pure and tested (`test/dogears.test.ts`, 37 tests): the tab list and its
  identity, the knobs and their clamps, `remember`/`touch`/`mark`/`reread`/`drop`, the fuse
  (`fuses`, `reap`, `burn`, `sayFuse`), `tabLabel`, and the two selection inverses `flatOf`
  and `locate`.
- `Dogears.svelte` — the strip: the pills, the fuse hairlines, the `⋯` and its two knobs. Reads
  `clock` for the tick and holds no timer of its own.
- `ToolCall.svelte` — the transcript's end of it, importing `insideRoot` and `placesIn`. It
  routes the gesture out as `onfile` rather than reaching for the panel, the same way it
  routes `onlink`: what this component knows about is typography, and which panel is on
  screen is not its business. `Transcript.svelte` passes the card's `cwd` as `root` — absent
  for a chat card, which has no project, and every path there stays text.
- `tools/probe-places.ts` — what real tool results look like and what `placesIn` finds in
  them. Run it before changing that pattern; it is what caught the bare-filename case.

The control surface has a `find` op (`show`, `hide`, `type`, `step`, `pick`, `look`, `back`,
`swap`, `raw`) driving the panel's own functions, and `snapshot.finder` reports the panel and
the **pending chord** apart — a half-typed leader is a state the app is in with nothing on
screen but a caption, and from outside it is otherwise invisible. `look-at` is the transcript's door in — a
separate gesture rather than a shortcut for `look`, since it names its own root and leaves
nothing behind for Escape to step back to, which is what makes `alone` in the answer worth
reading. There is deliberately no op for a chord itself: that is what the `key` op is for,
pressing space then f then f at the window the way a hand does, which is the only thing that
can see the leader losing a race with the bare-printable branch below it in `onGlobalKey`.

The tabs are the same op — `resume`, `shut`, `reap`, `keep`, `fuse` — and `snapshot.finder.tabs`
reports each with the milliseconds it has `left`, null for a safe one. That number is the only
way from outside to tell a tab that is about to go from one that is staying, since the pills
differ by an opacity and a hairline. **`reap` takes the time**, because the alternative is a
test sleeping five real minutes to watch a fuse burn down. And a tab reports *whether* it is
carrying a reading rather than what the reading is: a scroll offset in pixels is a fact about a
font, and a test asserting one would be a test about the theme.
