---
paths:
  - "src-tauri/src/find.rs"
  - "src/lib/finding.ts"
  - "src/lib/finder.svelte.ts"
  - "src/lib/Spyglass.svelte"
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
rather than a thing that shows you files. There is no editor on this wall, so a file that has
been found wants somewhere to be *read*.

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
  imported from `finding.ts`.

The control surface has a `find` op (`show`, `hide`, `type`, `step`, `pick`, `look`, `back`,
`swap`, `raw`) driving the panel's own functions, and `snapshot.finder` reports the panel and
the **pending chord** apart — a half-typed leader is a state the app is in with nothing on
screen but a caption, and from outside it is otherwise invisible. There is deliberately no op
for a chord itself: that is what the `key` op is for, pressing space then f then f at the
window the way a hand does, which is the only thing that can see the leader losing a race
with the bare-printable branch below it in `onGlobalKey`.
