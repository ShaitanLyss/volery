---
paths:
  - "src-tauri/src/nvim.rs"
  - "src/lib/nvim.ts"
  - "src/lib/nvim.svelte.ts"
  - "src/lib/Quill.svelte"
  - "tools/probe-nvim.ts"
---

# Editing a file, in your own nvim

### Volery does not have an editor, and is not getting one

It runs the one already on this machine and draws what that one says the screen looks like.
`nvim --embed` speaks msgpack-RPC over stdin and stdout: it sends `redraw` batches describing
a grid of cells, and it takes keys back. So everything in `init.lua` is simply *there* —
treesitter colouring, LSPs, telescope, cmp, lazy, whatever mapping you added last Tuesday —
because it is your nvim and not an imitation of one.

That is the whole design, and it is worth stating as a boundary rather than as a feature:
**nothing in this app is allowed to know what a plugin is.** No `ext_cmdline`, no
`ext_popupmenu`, no `ext_messages`, no `ext_multigrid`. With all of them off, nvim composites
its own floats, its own command line and its own popup menu into the single grid it is already
sending — which is exactly why telescope works here without a line of code naming telescope.
Turning one of those on would move a piece of nvim's UI into Volery's hands, and Volery would
then have to be right about it forever.

### It is pipes, which is the only reason this exists at all

The obvious route to nvim is a terminal emulator, and `.claude/rules/shell.md` records why
there is not one on this wall: **ConPTY does not work on this machine.** Every `openpty` child
dies at `0xC0000142` (STATUS_DLL_INIT_FAILED) before it runs a line, which took the floating
shell off a PTY and then took the dev servers off one too. An editor is the case where that
would have been fatal rather than merely limiting — `shell.md` says as much in the sentence
"anything that paints by moving a cursor — `vim`, `htop` — has nowhere to paint".

nvim's UI protocol needs no terminal. It is three pipes, the same primitive `shell.rs` and
`servers.rs` already use, and the constraint that killed the obvious approach turns out not to
touch this one at all. The general shape is worth keeping: **when the usual route is blocked,
check whether the thing you are talking to has a second interface built for programs rather
than for terminals.** Editors, debuggers, language servers and build tools very often do.

Probed 2026-08-25 with `tools/probe-nvim.ts` against nvim 0.11.6 and this machine's own
config:

| | `-u NONE` | with `init.lua` |
|---|---|---|
| attach acknowledged | 101ms | 517ms |
| settled | 830ms | ~5s |
| highlight attributes defined | 58 | 434 |
| bytes on the wire, whole session | 9.3 kB | 10.6 kB |

The wire cost is nothing — 84 `grid_line` events for a session that opened a file and jumped
to line 50. **The cost is the five seconds**, and every shape decision below is downstream of
it.

`--drive` is the probe's second half, and it exists because of the machine rather than the
design: with no MSVC toolchain here, the app itself cannot be put in front of a real nvim (see
the last section). So it makes the same six calls `nvim.rs` makes — reading `OPEN_LUA` **out of
the Rust** rather than carrying a copy, since a copy would go on passing after the real one
broke — and asserts on nvim's own answers. It cannot prove the app is wired up. It proves that
none of the RPC is misspelled, mis-arited or wrong about escaping, that the clamp clamps, that
the E37 path switches buffers, that a paste keeps its indentation and that a resize takes.

Two things it caught that reading the protocol would not have:

- **`nvim_paste`'s phase is `-1`, and a client that cannot encode a negative integer gets
  `Invalid 'phase': 4294967295`.** `rmpv` is fine; the probe's own hand-rolled encoder was not,
  twice — it also had only str8, so the ~500-byte Lua wrapped its length field, corrupted the
  frame, and desynced the stream permanently *with no error anywhere*. Worth knowing if anyone
  ever writes a second client here: the failure mode of a bad msgpack length is not an error,
  it is silence.
- **A killed nvim with a modified buffer stops the *next* one.** The swap file it leaves makes
  the next session open behind nvim's `ATTENTION / swap file found` prompt, which waits for a
  key — so every call after it simply never answers. That is nvim being correct, and it is why
  the probe runs with `--cmd "set noswapfile"` and writes to a scratch file rather than to
  anything in the repository. **The app deliberately does not set `noswapfile`**: there the
  swap file is the point, and answering the prompt is something you can do, because the grid
  takes keys like any other.

### The same panel, a third reading

The finder's panel has three states now: the list of results, the file, and the file being
edited. One frame, one header, one Escape ladder. It is deliberately *not* a second floating
panel beside the shell's, which was the first design and was wrong for a reason worth keeping:
every route to a file already leads to this panel — `<space>ff`, `<space>fw`, a path in a tool
call, a dogear — and a second destination would have meant every one of those routes growing a
second answer to "and where does it open?".

- **The viewer stays, and stays instant.** The read path is the common one and it costs
  nothing: `read_file_text` and a scroller. Making the panel *always* nvim would have put five
  seconds in front of every Enter on a grep hit, and lost the rendered-markdown reading of a
  rule, which is half of what the viewer is for.
- **`e` in the viewer is the step in.** A bare letter, free for exactly the reason the space
  leader is free on the wall: the viewer has no field, so a printable key means only one thing.
- **Alt+E is the step back out**, and it has to be a chord. Escape is the most-pressed key in
  nvim and an editor you left every time you finished an insert would be unusable. Alt+E is the
  sibling of the shell's Alt+I; `<M-e>` is not bound by nvim's defaults.
- **It hands over the line you were looking at, from the middle of the viewport.** Not the top:
  nvim centres what it is sent (`zz`), so the middle is the one line that lands back where it
  already was, and switching to edit does not scroll the file half a screen under you. Found by
  `elementFromPoint` at the centre of the sheet rather than by arithmetic over `scrollTop`, so
  it is right where a long line has wrapped and the rows are not a uniform height.

### The panel and the session are two facts

The same split the shell has, and here the argument is stronger. **Leaving edit mode does not
close nvim.** Your buffers stay open, your undo history survives, your unsaved changes are
still unsaved, and your language servers stay warm. An editor that paid five seconds every time
you glanced at a search result is one nobody would open twice.

**One nvim per project, keyed on the project root** — which is at once the id Rust files it
under, the directory it is started in, and what the front end looks it up by. Derived rather
than allocated, which is what makes the dev path work: a Vite edit rebuilds `App.svelte` and
the object holding every session with it, and the rebuilt one has to *find* the sessions rather
than spawn a second set beside them. The reason for per-project is stronger than the shell's:
an editor's working directory is what its LSP roots itself on, what its pickers search, and
what its git plugin talks to. One nvim across four repositories would be wrong about all three.

The header carries the count of editors open elsewhere, achromatic, the same way the shell's
does — and here it means something sharper, because one of those may be holding unsaved
buffers.

### The prologue, and the one thing Rust remembers

**Rust folds nothing.** A redraw batch is converted to JSON and emitted as it arrived; the grid
is built in `nvim.ts`, which is pure and tested. That is the division the event pipeline
already makes for `claude` itself, and it is why there is no grid model in `nvim.rs`.

The one exception is not taste, it is a bug that would otherwise be permanent in dev: **the
attribute table is sent once.** `hl_attr_define` arrives when nvim starts and never again, so a
front end that attaches later has missed all 434 of them — and in dev that is every Vite edit.
So `nvim.rs` keeps the definitions, the default colours and the mode table, and replays them to
whoever attaches next, ahead of a `redraw!` that regenerates the cells. Without it a rebuilt
front end draws a perfectly correct grid in no colours at all.

Two details in it:

- **Attributes are a map keyed on the attribute id, not a list.** nvim redefines an id when a
  colourscheme changes; a list would grow without bound across a long session *and* replay the
  stale definition first.
- **The replay order is colours before attributes**, since an attribute that sets no foreground
  falls back to the default one.

Nothing about *cells* is kept. `redraw!` regenerates cells, so keeping them would be a second
copy of the screen for no reason.

### The screen is not `$state`, and the version number is why

A hundred-by-forty grid is four thousand cells, rewritten on every keystroke. A `$state` proxy
over that means Svelte tracking four thousand objects and diffing them at the speed you type —
the same shape of mistake `shell.svelte.ts` made once by pushing a line at a time instead of
batching to a frame, which put the scheduler in front of the reader thread.

So the screen is plain data folded by `applyRedraw`, and the only reactive thing in
`EditorSession` is a **version number**. `Quill.svelte` reads the version to know it must
redraw and then reads the screen. Two things bound it:

- **Only a `flush` bumps it.** That is nvim saying the screen is consistent; redrawing on
  anything less draws a half-painted line.
- **At most once an animation frame.** nvim flushes per keystroke, which is fine — and also per
  line of a `:%s` over a big file, and per frame of a plugin's animation, which is not. One
  frame is the right unit here for the same reason 50ms is the right unit for the shell's
  lines: it is about how often the wall may be repainted, not how often the process spoke.

### What the wire format gets you wrong on

Every one of these is tested in `test/nvim.test.ts`, and every one of them was found by reading
the protocol against what the probe actually returned.

- **A `grid_line` cell with no `hl` carries the one before it.** The attribute is only sent when
  it changes. Defaulting a missing one to 0 paints every run after the first in the default
  colours, which reads as a colourscheme that gave up halfway along the line.
- **A cell's text is one grapheme, never a run.** The only thing that compresses a line is the
  repeat count — which *is* a run of identical cells, and is how a screenful of trailing spaces
  costs three numbers.
- **`grid_scroll` copies a region over itself.** Positive rows means the content moves up and
  the copy runs top-to-bottom; negative means down and it has to run bottom-to-top, or the
  first line copied smears over everything below it. Vacated lines are left alone — nvim paints
  them immediately after, and blanking them here is a flicker.
- **`grid_resize` arrives before the repaint**, so a resize that blanked the screen flashes the
  panel empty every time it changes shape. Keep whatever still fits.
- **`-1` in `default_colors_set` means "no colour set", not black.**
- **An empty cell text is the second half of a double-width character** and is dropped rather
  than drawn; the wide glyph before it already occupies both columns.
- **An event this file has never heard of is ignored, not refused.** nvim adds them between
  versions, and a UI that threw on one would break on an upgrade of somebody else's editor.

### The keyboard, and the one key kept back

Everything goes to nvim. There is no allow-list, and there must not be one — half of what makes
an editor yours is a mapping this app has never heard of. `Quill.svelte` keeps back exactly one
chord (Alt+E) and forwards the rest, and it `stopPropagation`s as well as `preventDefault`s,
because `Spyglass.svelte` underneath reads Escape as "back to the results" and ctrl+R as the
markdown toggle — both of which would fire from a keystroke meant for the buffer.

`nvimKey` is the translation and three things in it are load-bearing:

- **Shift is not reported for a printable key.** The browser has already applied it — `e.key` is
  `A`, not `a` — so adding `S-` would send `<S-A>`, which nvim reads as a *different key* from
  `A`. It is added for named keys, where the browser has not spent it: `<S-Tab>` is real.
- **`<` is escaped to `<lt>`**, or typing one into a file starts a key name and swallows
  everything up to the next `>`.
- **AltGr is Ctrl+Alt on Windows**, which is how `@` and `#` are typed on half the layouts in
  Europe. A *printable* character that arrived with both is sent as itself: the modifiers made
  the character, they are not being pressed with it. A *named* key with both is still a chord,
  since no layout produces Enter from a modifier combination.

**Paste is `nvim_paste`, not `nvim_input`.** Input runs every character through mappings and
autopairs, so a function pasted into insert mode arrives re-indented into a staircase with half
its brackets doubled. This is what `:help paste` exists for.

**The mouse is wired**, and it is not a luxury: you arrived at this panel with the pointer, and
a window you cannot click into reads as a picture of an editor rather than an editor. The wheel
sends the *gesture* rather than a line count, so nvim scrolls by its own `mousescroll` and
`scrolloff`.

### Opening a file is Lua, and the path is an argument

`:edit <path>` would be wrong here in four separate ways, so `nvim.rs` sends `nvim_exec_lua`
with the path as a *value*. A Windows path is full of backslashes and may hold spaces, `%`,
`#` and `[`, every one of which means something on Vim's command line — passing it as an
argument means nothing has to be escaped correctly.

Three things the Lua does beyond opening, each of which would otherwise read as a bug:

- **An already-open buffer is switched to, not re-edited.** `:edit` on a modified buffer fails
  with E37, so the file you were halfway through changing would refuse to open from the panel
  that was already showing it.
- **The line is clamped.** The finder's line comes from a grep hit against what was on disk,
  and an agent may have shortened the file since.
- **`checktime`**, because on *this* wall the other thing editing these files is an agent.
  Without it nvim sits on a buffer it read ten minutes ago and quietly writes it back over the
  agent's work.

### Colour, against the house rule

`tokens.css` reserves colour for status and keeps chrome achromatic, and this component draws a
file in somebody else's colourscheme. That is not a violation, it is the same line `ansi.ts`
has drawn since the first day there was a shell: **the rule is about chrome, and a document is
not chrome.** The shell renders SGR colour faithfully, the server logs do, and reading a file in
Volery's ink while editing the same file in the editor's would be two readings of one file that
disagree.

What *is* held to the rule is everything around the grid: the mode indicator is a `.note` and
not a status colour, because which mode an editor is in is not one of the five states this wall
has a colour for. It is drawn at all only because with no chrome of Volery's own inside the
grid it is the one thing you cannot infer by looking.

The **cursor** is Volery's one addition to what nvim said, and it is not an invention: the
shape and the size come from the config's own `mode_info_set`, so an insert-mode bar being thin
is that config's decision. It is drawn with `mix-blend-mode: difference` rather than a colour,
because it has to be visible over whatever the colourscheme put underneath it and this app does
not get to know what that was — which also inverts the glyph it covers, which is what a block
cursor is supposed to do. It is hidden while `busy`, that being nvim saying the screen it has
drawn is not one it has finished with.

### Quitting, and what is deliberately not saved

`Nvims::shutdown` kills every session, and **nothing is written on the way out.** Saving a
buffer nobody asked to have saved is the one failure here that cannot be undone. What a killed
nvim leaves is a swap file — which is precisely the mechanism nvim has for this, and which the
next session offers to recover from in its own words, better than anything this app could say.

Every nvim goes in a `jobs::Job` with `KILL_ON_JOB_CLOSE`, because an editor spawns language
servers and a language server spawns compilers. That is the rule CLAUDE.md states for every
spawn in this app, learned the expensive way by `supervisor.rs`.

### Where things live

The usual three-way split, plus the probe.

- `nvim.rs` — the process, the msgpack, the prologue, and the one piece of Lua. `rmpv` rather
  than a hand-rolled reader for one reason that matters: msgpack is self-delimiting, so
  `read_value` consumes exactly one message from the stream and there is no framing to get
  wrong. It also knows about *ext* types, which nvim uses for every buffer and window handle
  and which a naive decoder chokes on the moment one appears — the probe hit that in its first
  minute.
- `nvim.ts` — pure and tested (`test/nvim.test.ts`, 53 tests): the fold, the runs, the
  attribute translation, the key notation, the cell a pointer is over, `screenText`.
- `nvim.svelte.ts` — the sessions and their subscriptions. Holds two listeners and an animation
  frame, so `App.svelte`'s `onDestroy` releases it with the rest; `snapshot.listeners.editor`
  is 2 and must not climb across an edit.
- `Quill.svelte` — elements, one measurement, and the handlers that reach the process.
- `tools/probe-nvim.ts` — what the CLI actually does, in the pattern `tools/probe-context.ts`
  set. It carries its own minimal msgpack because it has to be independent of the code it is
  checking.

**The component is `Quill` and the class is `Editor`**, which is the same split
`Console`/`Shell`, `Spyglass`/`Finder` and `Pomodoro`/`Cycle` already have: a `.svelte.ts`
module and a `.svelte` component of one name are one module path to two files, and TypeScript
says so.

### From outside

`snapshot.editor` reports `on` and `live` separately, for the same reason the shell's does:
from outside, a panel showing a file and an nvim holding one look identical, and this is the
more expensive of the two to be wrong about — an editor left running may be holding unsaved
buffers.

The `editor` control op takes `edit`, `rest`, `close`, `keys` and `screen`. **`screen` is why
the op exists.** Everything else on this wall can be asserted through the DOM, because Volery
drew it; this is drawn by somebody else's editor from a stream this app only forwards, so
whether the file opened, whether the cursor landed on the line it was sent, whether a plugin
painted what it should have, is knowable *only* from the grid. It comes back as text, one row
per string, colour dropped the way every reading in this app drops it.

`keys` takes nvim's own notation (`<Esc>`, `ihello<Esc>`, `:wq<CR>`) rather than a browser key
name, and that is the honest boundary: the control surface cannot make a real key reach a
focused element (`.claude/rules/control.md`, and sink 59f00bee), so this addresses the process
one layer below the thing a person presses. `nvimKey` is tested directly instead of through two
layers.

**There is no wall test for any of this yet, and the reason is the machine rather than the
design.** This one has no MSVC toolchain, so `bun run tauri dev` cannot run and neither can
`cargo test` — see `.claude/rules/build.md`. `cargo check --lib` under the gnu toolchain does,
and the Rust unit tests in `nvim.rs` are written and unrun here. Anyone on a machine with MSVC
should run both and write the wall test; the ops and the snapshot are already there for it.
