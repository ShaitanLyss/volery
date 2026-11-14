---
paths:
  - "src-tauri/src/kit.rs"
  - "src-tauri/kit/**"
  - "tools/probe-kit.ts"
  - "tools/lift-kit.ts"
---

# The card kit

Every project card is spawned with `--plugin-dir <app data>/kit/volery`: a plugin Volery
ships, holding one skill and two agents.

| | what it is | what every request pays |
|---|---|---|
| `volery:coordinate` | the method for one card working a queue through other cards: rulings, placement in the shared tree or a worktree group, model and effort, pacing, the one gate, an answer for every item. A brief template and three Node scripts sit beside it | its description, in the skill listing |
| `volery:red-team` | adversarial review of a diff, read-only by its tool list and its prompt | its description, in `Agent`'s schema |
| `volery:verifier` | drives the running app in the wall's browser and reports per behaviour | the same |

356 input tokens a request for all three, measured (`bun tools/probe-kit.ts cost`). The
skill's body is paid only by a card that invokes it.

### Why a plugin and not the system prompt

Lyss asked for coordination to be something Volery ships, not something one repository
carries (2026-11-06). Most cards never coordinate, and `--append-system-prompt` is paid in full
by every card on every request, which is the budget `guidance.rs` and `supervisor::append_prompt`
already cut paragraphs to protect. A skill is the CLI's own form of "loaded only when
relevant": the description is always there, the body only on invocation.

`--plugin-dir` loads a plugin for one session and writes nothing to `~/.claude`, which is the
bargain `supervisor::agents` and `hooks.rs` already strike: **this app does not write to the
user's config**, so what every card should have arrives at spawn. Probed on claude 2.1.318: the
skill and both agents appear in `initialize` and `system/init`, `--agents`' `scout` and the
user's own plugins are still there beside them (it merges), and `installed_plugins.json` and
`settings.json` kept their mtimes.

The files live in `src-tauri/kit/volery/` and are compiled in with `include_str!`. `kit::dir`
writes them under the app data folder the first time a card spawns, only where a byte differs,
and removes anything there this build does not ship, so a skill dropped from a later build is
not still offered by a file left behind. A lab wall has its own app data folder, so a kit being
edited in a lab never reaches the installed wall's cards. A kit that cannot be written is a card
spawned without it, logged, never a card that fails to start.

### What the skill leaves out, and why that is the systemic half

The tx-toolkit skill it was adapted from (`triage-and-delegate`) has to tell a coordinator to
put in every brief things Volery already tells every card itself: the shared-tree git rules,
`ask_user`, who opened the card and how to report, stop notices, the admission queue, how a
worktree group merges back. `coordinate` lists those under *what the wall already does, so you
don't*, so a brief carries only the items. Each one is a fact in code (`append_prompt`,
`Selfhood`, `spawn::settling`, `admit.rs`, `group_receipt`), so it cannot drift the way a
paragraph in eleven briefs does.

House rules have two homes and the skill names both: rules true of every card in a repository
go in the territory's standing instructions (`guidance.md`), rules true of one round go in a
`brief-common.md` the coordinator copies from the template.

**The one pointer is in a receipt.** A card opening its first child is the one card on the wall
for which the method has just become relevant, so `spawn::coordinate_pointer` adds a sentence to
that receipt naming the skill. Only the first: `store::spawns_since(caller, 0) == 0`, asked
before the new row is written.

**And the second pointer is the palette, which needed the same flag.** A skill is only as
findable as the list of names in front of the person typing, and that list is learned from a
throwaway `claude` by `slash.rs` — which was not given `--plugin-dir`, so `volery:coordinate`
was missing from the palette on every card that had the skill. Fixed 2026-11-14 (Lyss typed
`/coordinate` and nothing appeared): `slash_commands` passes the kit for a project directory
and refuses it for the chat home, where a card is spawned without the kit. Measured with
`cargo run --example slash-probe` on this repository — 53 commands without the flag, 54 with,
the extra row carrying the CLI's own `coordinate` alias. **A plugin loaded at spawn and not in
the palette is the "capability an agent cannot see" failure one surface over, and it is
invisible from the card's side:** the skill works when invoked and simply cannot be found.

### The scripts are Node, and two of them were wrong where they came from

The tx-toolkit originals were `commit-split.sh`, `hunks.mjs` and `gate.sh`. Review of this
change (2026-11-06) broke three of them, each reproduced in a throwaway repository:

- **`hunks.mjs` dropped the patch's last newline** whenever the file's final hunk was left
  out, so `git apply` said `corrupt patch`. Keeping hunk 1 of 2, the ordinary case, never
  worked. `commit-split.mjs` now cuts hunks itself, splitting with each line's ending kept.
- **`commit-split.sh` could revert a sibling's commit.** It read HEAD, built a tree, then ran
  `git commit`, which parents the commit on whatever HEAD is *by then*. A card committing in
  between had its work silently undone at the new HEAD. The port builds with `commit-tree -p
  <the HEAD it read>` and moves HEAD with `update-ref HEAD <new> <old>`, which refuses if HEAD
  moved (checked: `cannot lock ref 'HEAD': is at … but expected …`).
- **`gate.sh` made and pushed merge commits** whenever local and remote had diverged, and kept
  accumulating them in the gate tree across runs. The port starts each run detached at the
  remote branch, fast-forwards only, and refuses a divergence with what to do. It refuses the
  tree you are standing in and a dirty gate tree rather than forcing a checkout.

And all of it is Node because a card may have PowerShell and no Bash: `sh` is not on PATH from
PowerShell on this machine, a CRLF list file breaks `read -r`, and Windows PowerShell 5.1
writes `>` as UTF-16, which `git apply` cannot read. Each script writes its own files.
`.gitattributes` pins `src-tauri/kit/**` to LF and `the_kit_ships_with_lf_endings` holds it, so
every build ships the same bytes; `every_file_in_the_kit_folder_ships` holds the folder and
`FILES` to the same list.

### The agents, and what was not shipped

- **No `model` on either.** `supervisor::agents` explains why review inherits the parent's
  model: a correctness-review miss is invisible, where a reconnaissance miss costs a retry. The
  tx-toolkit reviewer pins `opus`; this one does not.
- **`red-team` has `Bash, PowerShell, Glob, Grep, Read`**, both shells because which one a
  card has depends on the CLI build (`hooks.md`), and a prompt that forbids writing. As with
  `scout`, the shell is what makes the read-only promise the prompt's rather than the
  allowlist's.
- **`verifier` declares no tools**, so it inherits the card's, which is how it reaches
  `mcp__browser__*`. That includes the editing tools, so its prompt says in as many words that
  it never edits, creates or deletes a file: it is what a coordinator runs at the gate, in a
  tree other cards share. It is told to use a tab of its own and never to clear the browser's
  state.
- **No UI/UX reviewer.** tx-toolkit's reviews against a company design system Lyss rejected
  for EOS; a generic one would be "read the repo's own design rules", which `red-team` and the
  repo's `CLAUDE.md` already cover without a fourth description on every request.

On a machine with tx-toolkit installed both sets are listed (`tx-toolkit:red-team-reviewer`
beside `volery:red-team`). They are namespaced, so nothing collides; the cost is the 356 tokens.

### Verifying it

`bun tools/lift-kit.ts` runs `kit.rs`'s tests and the receipt pointer's under `rustc --test`
with the real kit beside it, on a machine where `cargo test` cannot run. What it cannot reach
is the two call sites (`supervisor::spawn_now`, `spawn::do_spawn`), which need the crate.
