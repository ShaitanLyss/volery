---
paths:
  - "src-tauri/src/worktree.rs"
  - "src-tauri/src/supervisor.rs"
---

# The tree a card works in

A worktree card is one conversation on its own branch, in its own checkout, sharing the
territory of the project it came from. `claude --worktree <name>` used to do all of it in one
flag, and Skein used the flag for exactly that reason.

**What it did with the name is why it no longer does.** Probed against claude 2.1.241:
`--worktree feat/async-auth` makes the folder `.claude/worktrees/feat+async-auth` and the
branch **`worktree-feat+async-auth`** — the slug, plus a prefix. The folder is nobody's
business; the branch is the name that goes on a pull request, which is the one place a name is
read by people. It was renamed by hand twice on this machine before anyone worked out where it
came from, and the reflog is where the evidence finally was:

```text
Branch: renamed refs/heads/worktree-feat+async-auth to refs/heads/feat/async-access-control
```

`-w, --worktree [name]` is the CLI's whole surface here — no branch option — so the only way to
get the name you typed is to stop delegating. `worktree::ensure` is three git commands, and
buys two things past the name: the base is ours, and it is idempotent.

Things that are load-bearing:

- **The folder keeps the CLI's spelling, and that is compatibility rather than taste.** Every
  worktree card made before this module has its tree at `.claude/worktrees/<slug>` with `/`
  folded to `+`. `ensure` returning an existing directory untouched is the whole of what puts
  a dormant card back into the tree it has been working in — get the slug wrong and each of
  those cards silently gains a second, empty tree beside the one holding its work.
- **`ensure` is reached on every spawn, not only the first.** Waking a card, swapping its
  account, restoring the wall — all of them land here, and all but one find the tree already
  there. That is why it is `ensure` and not `create`: a function that could only make one would
  have needed every caller to remember which case it was in, which is the shape of the bug
  before it happens (the same argument `store::kind_of` settles for chat cards, `chat.md`).
- **Which name it is asked about comes off the row, and for a day this bullet was a wish.**
  The line above was written as though every spawn reached `ensure`, and one did not: `wake`
  passed `worktree: null` and had done since the app was written. That was harmless while
  `--worktree` was a flag the CLI kept across a `--resume`, and became live the moment this
  module started making the tree — so a worktree card woken by a click, a send, a rouse or an
  account swap came back running in the **main tree**, with nothing on the wall to say so,
  because the `cwd` the card draws itself from was still right. `store::worktree_of` is the
  third thing `spawn_conversation` asks the store rather than the caller, and it is the one
  that proves the rule the other two only state: `kind` and the preset were argued into the
  store *because* a future call site would forget, and this is the parameter where the call
  site already had.
- **`worktree::run_dir` is that same answer without the making of it**, and everything that
  is not spawning asks it instead. Reading a transcript, resolving a relative path an agent
  wrote, deriving where the CLI filed a background task's output — all of them are questions
  the CLI answers *per directory*, and all of them were being asked about `cwd`. That is the
  bug's second half and the more expensive one: the CLI files a session under the directory
  it is running in, so a card sent to the wrong tree also comes back with **no transcript to
  resume**, spawns `--session-id` fresh, and starts a second history under the root's slug
  while its own sits in the tree. Measured 2026-08-25 over the four worktree cards then on
  the wall: two transcripts apiece under one session id, split at the first wake, not
  overlapping by a record. One of them was found by its own card writing "I'll find the
  component first" about a component it had spent the previous hour in.
- **So the fix had to mend what it would otherwise rewind.** With the child sent back to its
  tree, `--resume` finds the *older* half — the one from before the first wake — and the day's
  work stops being what the card comes back holding. `supervisor::reunite_split_transcript`
  moves the newer half to where the card now looks and keeps the older beside it as
  `.jsonl.bak`. It is narrow by construction rather than by a guess: a transcript under the
  project root's slug for a card that works in a tree can only have been written by a build
  with this bug in it, since that child was never once meant to run there. `.bak` and not
  `.jsonl`, because `sessions::walk` reads any `.jsonl` stem as a session id and would offer
  a half that can be adopted and never resumed. It runs at a spawn, where the card has no
  process to be holding the file, and only ever moves newer onto older, so the second call
  finds nothing to do.
- **`--no-track`, or the branch's idea of upstream is `main` itself.** Branching from a
  remote-tracking ref makes git set that ref as the upstream: probed 2026-08-25,
  `worktree add -b feat/x <dir> origin/main` leaves `branch.feat/x.merge = refs/heads/main`, so
  a `git push` from that branch targets **main**. `push.default=simple` refuses it — which is
  what this machine has, so the symptom would have been a baffling error rather than a
  disaster — but `push.default=upstream` does not. Nothing about the base you branched *from*
  should decide where you publish *to*. No upstream at all is the correct state and Skein
  already knows what to do with it: `actions.ts` offers **publish** (`git push -u origin HEAD`)
  for a branch that has none, which sets it to a remote branch of the same name — exactly the
  config the CLI-made branches ended up carrying.
- **`origin/main` is a default, with a ladder under it.** `origin/master`, then `origin/HEAD`
  resolved to a branch, then `HEAD`. `origin/HEAD` sits *below* the named guesses on purpose:
  it is a local guess written at clone time and never updated, so a repo whose default branch
  has moved still points at the old one. `HEAD` last, because a tree made off the wrong base is
  recoverable and a card that refuses to open is not.
- **A best-effort fetch first.** "Based off origin/main" is a claim about the *remote's* main,
  and a remote-tracking ref is only as fresh as the last fetch — Skein's fetch clock runs in
  minutes (`actions.md`), so without this a tree made just after somebody else's push starts a
  commit behind. Its failure is ignored: being offline is not a reason to refuse to open a
  card. It is `spawn_now`, which is already on the blocking pool, so the cost is the card being
  opened and never the wall being painted — see the `off_main` rule in CLAUDE.md.
- **An existing branch is checked out rather than re-created.** Typing a name that already
  exists reads as "put a card on that branch", which is a thing people do, and `-b` on an
  existing branch is a hard error — so the alternative is refusing something reasonable. A
  branch already checked out in another tree fails with git's own words, which name the other
  worktree; that is exactly what the person needs and better than anything invented here.
- **`resume` is asked of the directory the child runs in.** The CLI files a transcript under
  its *running* directory, so a worktree card's transcripts are under the tree's slug and not
  the project root's. `spawn_now` therefore asks `transcript_path` about `run_dir`. Ask the
  wrong one and a card that has been talking for days is told it has no transcript — and a card
  that starts fresh every time it wakes has quietly lost its memory. **And so is every other
  per-directory question**: `store::session_of` returns the run directory rather than the
  row's `cwd`, which is what the three transcript reads, `relay`'s recall, `pin`'s relative
  paths and `pending_jobs`' output paths all stand on. Those three reads take a card id now
  and nothing else — two arguments that can disagree with the row is what put them a
  directory out in the first place.

**The row's `cwd` stays the project root, and that is the trap as well as the design.** Only
the child process moves. That is what keeps a
worktree card in its parent's territory, sharing its dev servers and its shell (`shell.md`),
and it is the reason this change touched no schema. The card's own name carries the branch
(`skein · fix`), which is where a person reads it — and since 2026-11-02 the card's qualifier
row does too (`Card.svelte`, beside `on <host>`), as chat view's place line does, off the
card's `Gist` so a card on another wall shows it as well.

## Worktree groups: a tree an orchestrator hands out (2026-11-02, sink 93ecd434)

Lyss decided it on 2026-10-16 and it was built on 2026-11-02: `spawn` takes a `worktree`
**key**, cards given the same key share one tree, different keys get separate trees, and leaving
it out is the shared checkout exactly as before. The orchestrator decides grouping at spawn; a
card cannot change trees after birth, because its process is bound to a directory. Every
shared-tree trap in sinks `5aca5e82` and `53bfad8a` — one index, one HEAD, one `tsbuildinfo`,
somebody else's `git stash` — is a trap a group card is not standing in.

**A group is a branch name and nothing else, which is why nearly nothing had to change.** The
key `auth` is the branch `wt/auth`, the folder `.claude/worktrees/wt+auth` (the CLI's slug, so
every rule above holds), and the row's existing `worktree` column holds the branch. So
`run_dir`, `store::session_of`, the transcript reads, a wake, `worktree_of` and the front end's
`#openIn` resolve a group card with no change, and two cards with one key land in one folder
because `ensure` finds the second one already made. **No schema change.** The `wt/` namespace is
what lets the wall treat a group differently from a branch a person typed: only a `wt/` tree is
ever taken down by the wall.

- **The key is folded and refused, not mangled** (`group_key`): lowercase, `[a-z0-9._-]`, at most
  40, no leading `.`/`-`, no `..`, no `.lock`. Lowercase because `Auth` and `auth` would be two
  branches in what Windows treats as one folder, which git refuses half-way through.
- **Made at the call, not at the child's first spawn** (`spawn::make_group`). A key that cannot
  become a tree — no repository, a base that is not a commit — is a refusal the orchestrator reads
  in the same call, rather than a card that opens and fails to start; and the receipt can say
  whether the group was new. Git runs off the store lock. `MAKING` serialises every tree this
  process makes, so two cards spawned into one new group a moment apart cannot both run
  `git worktree add` on one folder.
- **A fresh group starts from the orchestrator's own `HEAD`** (Lyss: *"the orchestrator's current
  commit by default + the option to choose which commit or branch"*), resolved in the caller's run
  directory — its tree, if it is in one. That is what the group merges back into, and an
  orchestrator that committed a scaffold and has not pushed it would otherwise hand its workers a
  tree without the scaffold. No fetch: the base is local. `worktree_base` overrides it with any
  commit-ish, resolved where the caller stands and refused if it is not one. `ensure_at` is
  `ensure` with that base passed; `ensure` itself is unchanged (the ladder, with its fetch).
- **In another territory, or on another wall, the ladder decides** unless `worktree_base` names
  something that repository has — the caller's `HEAD` means nothing there.
- **Merge-back is the orchestrator's, linear, and the receipt says how**: in the group's tree
  `git rebase <its branch>`, then in its own `git merge --ff-only wt/<key>`. Never a merge commit,
  because this repository keeps a linear main. Nothing merges automatically: deciding when a
  group's work is done is the orchestrator's judgement, and an automatic merge is a commit nobody
  reviewed landing on main.
- **The group card is told where it works** (`supervisor::group_note`, in the system prompt and
  derived at every spawn like `Selfhood`): its branch and folder, that nothing reaches the main
  checkout until merged, to commit on the branch, not to switch, push or merge it, and that the
  tree starts cold.

### Taking a group down, only when nothing would be lost

`worktree::retire`, called from `store::close_conversation_record` through `retire_group_if_last`
when the closed card was the last open one on that tree (`store::open_in_tree` — dormant counts as
open; a dormant card is still in its group). Lyss: *"remove only when clean and merged"*. Enforced
three times, because a wrong answer here deletes the thing the group was opened to make:

1. **Clean** — `git status --porcelain` empty. Ignored files are not work: `node_modules`, a
   `target`, a seeded `.env` do not keep a tree.
2. **Merged** — the branch tip is an ancestor of the main tree's `HEAD` or of the remote's main. A
   rebase-and-fast-forward passes; cherry-picks do not, and the tree is kept — the safe way to be
   wrong.
3. **Git agrees** — `git worktree remove` without `--force` (refuses a dirty tree itself) and
   `git branch -d` (refuses an unmerged branch itself). Tested: `worktree remove` takes ignored
   build output with it, so a merged group leaves nothing behind.

On a thread, three seconds after the close (the card's process is killed by a separate command and
a process still standing in the tree makes `remove` refuse), with the census asked again after the
wait so a card spawned into the group inside it keeps the tree. The verdict goes in the chronicle
either way — *kept worktree group wt/x: N commit(s) … are not on the main tree's branch* is work
the user may not know is still out there. A person's branch (`feat/x`) is never retired.

### What a group costs, measured 2026-11-02 on this repository

A fresh worktree of skein is **22 MB** of tracked source. `bun install` there: **15 s, 264 MB**.
A cold `cargo build` (debug) in it: **~4 min 10 s → 12 GB**; adding `cargo test --lib --no-run`:
**~2 min 50 s more → 15 GB** — on a 24-core machine with other cards working. That is the cost
*per group*, not per card: cards in one group share the tree's `target`. The main tree's own
`target` (62 GB) is neither touched nor shared. The spawn description and the receipt both say a
group starts cold, so an orchestrator weighs a group against that.

**And it did not build at all until `.worktreeinclude`.** The first measured tree failed after two
minutes of compiling: `src-tauri/sherpa/` (the voice runtime, fetched and gitignored) is not in a
checkout, and tauri's resource check refuses. So `worktree::seed` copies into every *new* tree the
ignored paths the repository lists in `.worktreeinclude` (Claude Code's own name for the same
file) — a path, a directory, or `*` in the last component; never over a file git checked out;
never a path climbing out of the root. This repository lists `src-tauri/sherpa/`. It applies to a
person's worktree as well as a group's, since both were missing it.

**A build-output root was designed and deliberately not built.** The brief proposed
`CARGO_TARGET_DIR=<root>\<territory>\<key>` on an external drive, refusing a spawn when the drive
is unplugged. Lyss: the drive is a spinning disk — *"I think we can forego it for now"*. So a
group's builds land in its own tree on C:. If it comes back: the variable goes where `SKEIN_CARD`
is set in `spawn_now`, the drive check is "does the root's drive exist" (an external USB SSD
reports `DRIVE_FIXED`, so `GetDriveTypeW` cannot be the test), and the folder wants retiring with
the group. Worktrees themselves never leave the repository's disk, so the `git worktree lock` a
removable drive would need has nothing to lock.

### Across walls

`spawn` with `host` carries the key (and `worktree_base`) in the flyway `Ask`; the far wall's
`open_for` validates it, makes the tree on a thread (its own repository, the ladder unless the
base names something it has), and only then emits `flyway:spawn` with the branch, which
`#openIn` writes on the row. A tree that cannot be made answers the asker as a failed open. A wall
from before groups would read the key as absent and open the card in the shared checkout, so this
build announces `worktree` in `Facts::can` and `Fleet::ask` refuses a wall that does not
(`Unsendable::Older`).
