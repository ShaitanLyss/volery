---
paths:
  - "src/lib/portage.ts"
  - "src/lib/portage.svelte.ts"
  - "src/lib/Carry.svelte"
  - "src-tauri/src/portage.rs"
  - "test/portage.test.ts"
---

# Carrying a wall off, and setting one up again somewhere else

A **layout** is everything about how the room is arranged and nothing about what has been
said in it. That one sentence decides every judgement in this subsystem, and if you are
changing something here, check it against that line first.

| travels | stays |
|---|---|
| territories, and where they sit | cards, turns, transcripts |
| the server groups a territory runs | the sink, the billboard, relays, wakes, spawned |
| widgets, reference images (bytes included) | `window_frame` |
| ambiences, including which was showing | which *theme* is on |
| the custom themes you wrote | accounts |
| standing instructions, both scopes | |

Each of those exclusions is a rule from somewhere else, not a shortcut:

- **Cards** — a conversation is a session file in the CLI's own store, keyed to this
  machine, and the transcript slug is derived from a `cwd` on this disk. A card carrying a
  `--resume` id that resolves to nothing is worse than no card.
- **`window_frame`** — physical pixels of a monitor that is not there. See the window-chrome
  section of CLAUDE.md for why that column is in physical pixels in the first place.
- **Which theme is on** — `.claude/rules/theme.md` is explicit that this is per-machine and
  disposable, which is why it lives in localStorage. The themes themselves are not.
- **Accounts** — asked for as a separate affordance, and it is a genuinely different kind of
  document: `.claude/rules/accounts.md` is explicit that Skein holds no credential, so an
  exported account is a waterfall configuration. Mixing it into the furniture would suggest a
  subscription had been carried across. `accounts.ts` holds that half; it is the clipboard,
  because an account list is small and text.

## No id travels, so an import adds

An id is this database's handle on a row. Carrying one invites a collision whose only
resolutions are to overwrite something you have been using or to silently drop what you are
importing, and `theme.ts` already decided which of those is wrong: *the themes already here
are the ones you have been using and the paste is the guess.* So everything is made afresh
on arrival and **an import adds — it never replaces and never deletes**.

That leaves the problem which decides whether the feature is pleasant to use, because the
first thing anybody does with an export is import it again to see whether it worked, and an
import that adds would double the wall. Hence `sameSpot`: **furniture of the same kind in
the same place is the same furniture**, so a re-import is close to a no-op rather than a
mess.

It is a judgement rather than a fact, and it is the right one for objects that have no name:
a widget is identified by what it is and where it is, because that is also how you identify
it when you are looking at the wall. Deliberately **not** by its config — two clocks in one
spot set to two timezones are one clock somebody has been fiddling with, and a re-import
should leave the fiddling alone rather than adding a second clock underneath it. An image is
matched on its file's *name*, since its path is a `%APPDATA%` directory that means nothing
off this machine.

### Standing instructions are furniture, and are only ever topped up

The one carried thing that is *words* rather than a rectangle, and therefore the one where
"an import adds" had to be worked out rather than assumed. `Carried.guidance` is the
wall's, `CarriedProject.instructions` is a territory's — see `.claude/rules/guidance.md`.

There is exactly one wall guidance, so applying a carried one over a set one is
**replacing** it, which is the single thing this subsystem promises never to do. The nearest
precedent is the ambience switch, and it does not carry: that changes a setting you can
change back in one click, where this destroys prose somebody wrote. So a carried set is
applied only where this wall has none — both scopes, one rule, because "the wall's is kept
but a territory's is overwritten" is a policy nobody could predict from outside. What is
skipped is *named* in `Landed.skipped` rather than dropped quietly, and clearing yours and
importing again is the way to take theirs.

This is why `Skein.learnProject` exists. `settle` reached `ensure_project` directly and
stopped there, so a carried territory was a row on disk that the wall did not know about
until the next launch — invisible while nothing was written *to* a fresh territory in the
same breath, and not invisible at all once instructions were.

No `LAYOUT_VERSION` bump: the version marks changes of meaning and this is a change of
shape, which `readLayout` is lenient about by design. The case that needs pinning is the
document written *before* this — every layout already exported — which must read back as
`""` at both scopes rather than `undefined`, since `tally` and the import both `.trim()`
them. `test/portage.test.ts` holds it.

## The import goes through the same commands a pair of hands would use

This is `.claude/rules/control.md`'s argument borrowed one subsystem over, and it is worth
borrowing: **a second write path is the one that drifts.** Every widget arrives through
`Widgets.add`, every image through `Board.paste`, every territory through `ensure_project`.
So an imported thing is undoable, is normalized, is drawn and is saved by exactly the code
that does those things for a thing you made by hand. Nothing in `portage.svelte.ts` writes a
row, and nothing in Rust knows an import happened.

`Board.paste` is worth noticing as the reuse that made this cheap: it exists because
Windows' capture tools leave a bitmap on the clipboard and nothing on disk, and an imported
image is exactly that situation — bytes in hand, no file to copy.

Two costs, both the right price:

- Placing a widget is two round trips (`add`, then `update` with the size and the knobs the
  catalogue's default cannot know).
- An import lands as **one undo act per thing**, not one act. `fusable` in `undo.ts` requires
  the same records and these are all different records. The panel says so rather than
  promising a press that takes it all back — do not "fix" this by inventing a batch realm
  without reading `undo.md` first.

## A project arrives unrooted, and that is the interesting half

`project.root_path` is UNIQUE and is the identity the whole app matches on — cards find
their territory by `cwd`, `ensure_project` finds one by its root. A path from the machine
that wrote the document will not exist here, and inventing a placeholder would throw away
the only useful thing the document knows: **which folder this territory wants.**

So the old root travels verbatim, a territory whose root is not a directory here reads as
pointing nowhere, and rooting it is pointing it at a folder. `missing_roots` is the whole of
how "unrooted" is known, and it takes the paths rather than reading them out of SQLite —
which keeps the SQL in `store.rs` and makes the command what it actually is, a question
about a disk.

**Rooting is not a label change.** A server group's `cwd` is a path under the old root, and a
territory rooted at a new folder whose dev servers still start in the old one is a territory
that looks right and does nothing. `rebase` is that rewrite and it is tested against the
trap that makes the naive version wrong: `C:\work\skein-old` is not under `C:\work\skein`,
and a prefix check says it is. A `cwd` of `null` stays null — that means "the project's
root", which is the thing that just changed, so it is already correct and making it absolute
would freeze it.

`reroot_project` leaves the *name* alone even though `ensure_project` derives one from the
path at creation, and leaves the cards alone entirely — a card's `cwd` is where its process
was actually spawned, and rewriting it would claim a conversation happened somewhere it did
not.

## Two things about `autostart` and the file

- **`addGroup` takes a `was`, and it is a safety argument.** `autostart` was hard-coded true,
  which is right for a group you create by hand and wrong for one arriving in a document,
  because the load path starts every autostart group at launch. An import that quietly armed
  somebody else's dev servers would be a file that runs commands.
- **`portage.rs` is two narrow commands, not a general `write_text_file`.** A command is
  reachable from anything holding the IPC — including a card's own agent, which this app
  spawns with `--dangerously-skip-permissions` — so both insist on the extension, refuse a
  relative path, and refuse a document larger than any wall could produce. Both are `async`
  through `off_main`, because a document carrying a wall of screenshots is tens of megabytes
  and CLAUDE.md's paragraph on that is not optional reading.

## There are two carried documents, and they must not become one

`.volery.json` is this one. `.volery-accounts.json` is `accounts.rs`, and since `941dbca` it
carries **live plaintext credentials**. Each module's path check refuses the other's suffix,
on purpose, and both directions have a test.

If anyone proposes folding them into one "carry my Volery off" document, this is the reason
not to: **a wall layout is something you can put in a chat message and an accounts file is
not**, and merging them makes the safe artefact unsafe. The last section of
`.claude/rules/accounts.md` has the full argument.

The direction that costs something is the one tested *here*, and it is worth knowing why:
`read_layout_file` hands the file's text straight back to the front end, so a layout reader
that accepted an accounts document would put bearer tokens inside the webview — the one place
in this app that renders untrusted content. Widening `SUFFIX` to `.json` is all it would take,
and it is exactly the kind of change that looks like a convenience.

Image bytes ride inside the document, read back out through the asset protocol the wall
already draws them with (`assetProtocol.scope` is `$APPDATA/references/**`), so nothing
newly reachable was not already on screen. An image whose bytes could not be read is carried
anyway, with its place and size and no file: a hole you can see and replace beats a row
silently dropped, which is the general rule this whole subsystem is written to — **a layout
that comes back incomplete and says so is fine; one that comes back subtly wrong is not.**

That is also why `readLayout` does not enforce the version. A newer document is very likely
still mostly readable by the cleaners, and refusing it outright would turn a partial import
into no import.

## The panel

`Carry.svelte` draws `Portage` — the same component/class name split `Console`/`Shell` and
`Pomodoro`/`Cycle` have, and for the same case-insensitive-filesystem reason.

Going out is one press; coming in is two, the tally first and the commit second, because an
import adds to the wall and cannot be taken back in one gesture. Same shape a broadcast has,
for the same reason.

The list of territories pointing nowhere is **in the panel rather than on the territory**,
which is a deliberate narrowing of what was asked for. It is where the need arises — you
have just imported a layout and none of its projects are rooted — and from here it is a list
you can work down, where on the wall it would be one at a time. An affordance on the
territory's own row is the natural follow-up.
