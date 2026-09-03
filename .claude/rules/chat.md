---
paths:
  - "src-tauri/src/supervisor.rs"
  - "src-tauri/src/store.rs"
  - "src/lib/skein.svelte.ts"
---

# A card with no project, and what a card is allowed to reach

### The chat card

Every card on this wall was the same kind of thing until now: a working tree with an agent
in it and the whole machine at its disposal. A **chat card** is the other kind — opened from
the ground menu rather than in a territory, spawned with no tools but `WebSearch` and
`WebFetch`, so it can look something up and can read no file, run no command and reach
nothing on this machine. It is for the conversation that is not about a repository.

It is `conversation.kind` (schema v11, `project` | `chat`), and three things follow from
where that column is read.

- **The argv is built from the store, never from the caller.** `spawn_conversation` asks
  `store::kind_of` what kind of card this id is; nothing passes it in. That is the same
  bargain `--resume` strikes with the disk one function down, and for a sharper reason:
  `open` and `wake` both reach that line, and a capability travelling as an argument is one
  every future call site has to remember. The failure mode is not a card that starts wrong,
  it is a chat card that comes back from a **rouse** holding the machine — at launch, for
  every chat card on the wall at once, with nobody watching.
- **So the row lands before the spawn.** `Skein.#openIn` records first and spawns second,
  which is the other way round from how it read for most of the app's life. A chat card whose
  row arrives late is a chat card spawned as a project card. The insert is local and the
  spawn is a process, so the ordering costs nothing.
- **Unknown falls to `project`, deliberately.** A missing row, a `kind` from a newer build, a
  NULL from some future migration: all of them mean "an ordinary card". The unknown case must
  cost a chat card its sandbox — visibly, since the card then has tools it should not and you
  can see them — rather than cost a working card its tools, which reads as the agent being
  broken. Both directions are wrong; only one of them is loud.

### And a fourth thing the kind decides: what a card is told about itself

`append_prompt` takes a `Selfhood` — the card's own handle, and who opened it if anybody did —
and everything it adds is inside the `if !chat` block with the board, the roster and the
shared-index paragraph. The same argument covers it twice over: a chat card cannot write a
file, so there is no `.scratch-<handle>/` for a handle to name, and `relay::do_list` refuses it
the roster outright, so telling it which row is its own would name a thing it will be told it
may not look at. `SKEIN_CARD` is set in its environment anyway, unconditionally, where it is
inert — it has no Bash tool to expand it with, and one line without a condition is better than
one line plus a case to be wrong about.

Nothing here changes what a chat card *is*. `spawn.rs` already refuses one the ability to open
a card, so a chat card can never be a parent, and `spawn` only ever mints project cards, so it
can never be a child either. `.claude/rules/spawn.md` owns the whole of why a card is told its
provenance and why the system prompt is the channel; this is only where the boundary is drawn.

### What `--tools` actually does

Probed against claude 2.1.233 on 2026-08-16, spawning with Skein's exact argv. Three of these
cost an afternoon each and none of them is guessable from the help text.

- **`--tools ""` does not disable tools.** The CLI's own help says it does. The flag is
  variadic, an empty argument is swallowed, and what comes back is the full default set —
  `Read Edit Write Glob Grep PowerShell Bash`. The tools are always named explicitly.
- **The tool list is not a permission.** With `--tools WebSearch,WebFetch` and no permission
  argument at all, "search the web for X" came back **refused** — which looks exactly like the
  model deciding not to search. The allow rule that makes it answer is the `chat`
  half of `hooks::settings`, where it moved when the `--settings` layer stopped being
  chat-only and started carrying the Bash backslash hook for every card as well.
- **`--tools` filters the built-in set only; MCP tools pass straight through.** That is what
  keeps `ask_user` alive on a chat card, which is the one capability it genuinely wants. It
  also means any *other* MCP server the user has configured would arrive with whatever reach
  it has, so `--strict-mcp-config` pins the card to the one server Skein passes.
- There is no `Agent` in the filtered set, so no subagent can come back holding a fuller
  toolset than its parent. `WebFetch` refused `file:///…` and refused a **live local server**
  on `http://127.0.0.1:8899/`.

An allow rule rather than `--dangerously-skip-permissions`, which would also have worked —
with no file or shell tool in the process there is nothing for a bypass to unlock. It is
spelled out so the one card on the wall that is *provably* harmless is not also the one
carrying the most dangerous flag Skein knows.

**What this is not is a sandbox.** The process still runs as you, with your rights. What is
true is that the model has no route to them — not that the route has been closed. A hook, a
plugin, or a later CLI flag that reintroduces a tool moves this boundary without touching
`chat_argv`, so the probes above are the claim and they have a date on them.

### Where a chat card stands

It needs a directory — the CLI is spawned in one and the transcript path is derived from it —
so `store::chat_home` makes one beside the database and every chat card shares it. They share
no state, because none of them can read or write a file; a directory apiece would be a hundred
empty folders and a hundred transcript slugs.

That directory goes through `ensure_project` like any other, so chat cards gather in a
territory called `chat`. This is the wall staying coherent rather than a claim that they are a
project: one place they are drawn, one thing to drag, and `forget this project` reaches them
by the rule it reaches everything else. The card's own label is set to `chat` explicitly in
the constructor rather than taken from the directory's basename — reading it off the path
would mean renaming the folder relabels every chat card on the wall.

**But a territory offers to start things, and both of the things it offers are impossible
here** — there is no project to open a conversation in and no git tree to branch. Left alone,
the `+` on that territory and its right-click `new conversation here` would put an agent with
the whole machine in Skein's own data folder. So `menuFor` takes `chat` on a region target and
swaps those two items for another chat card, and `onadd` routes the `+` the same way — in
`App.svelte`, not in `Canvas`, which knows where a territory is drawn and has no business
knowing what belongs in one. Everything else a territory is still holds: it can be carried,
tidied, and forgotten.

`Skein.chatHome` is what recognises it, and it is learned off the wall where it can be: a chat
card's cwd *is* the chat home, so a wall holding one knows where it is on the first frame with
no round trip to wait for.

**It is asked for as well, on every launch, and that backstop is load-bearing rather than
tidiness.** A territory outlives its last card here by design, so closing every chat card
leaves the `chat` territory standing on the wall with nothing in it to learn from. An
unrecognised chat territory offers `new conversation here` and a `+` that mean `openIn` — a
*project* card, with `--dangerously-skip-permissions` and the whole machine, whose label is
its directory's basename and therefore reads `chat`, in the territory called `chat`. A card
that has lost its sandbox has to be the one thing you can see; that one is indistinguishable
from the sandbox working, which is the exact inversion the `kind` column exists to prevent.
The cost of closing it is an empty folder beside the database on installs that never open a
chat card, which is the smaller thing to carry.

Nothing else needed a special case, which is worth knowing before adding one. The
shared-working-tree warning is computed from recorded *file touches*, and a chat card cannot
touch a file, so it can never be part of a clash. Dev servers, actions and pipelines are all
keyed on a project that has no repository in it, and find nothing.

`snapshot.cards[]` carries `kind`, for the reason it carries `aside` and `busy`: from outside,
a chat card and a project card differ in nothing else a snapshot reports — same tier, same
activity, same everything — while the argv behind them is the entire point. The control
surface's `chat` op takes no arguments, since having no directory to be given is what makes a
chat card one.
