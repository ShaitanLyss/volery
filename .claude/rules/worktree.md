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
  whether the group was new, resumed an existing branch, replaced a merged one or moved a leftover
  folder aside (`worktree::Ensured`). Git runs off the store lock. A lock **per tree**
  (`tree_lock`, keyed on the folder case-folded) serialises making and taking down that tree, and
  is taken before the folder is looked at, so two cards spawned into one new group a moment apart
  cannot both run `git worktree add` on one folder, and neither can land in a tree `retire` is
  removing. Per tree because what it is held across is slow — a `git fetch` with no timeout, a
  seed, a retirement's byte compares — and one lock for the process had every worktree card on the
  wall waiting behind any of them to wake.
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
open; a dormant card is still in its group), and once per launch by `store::sweep_worktree_groups`.
Lyss: *"remove only when clean and merged"*. The first version enforced that with three checks, and
an adversarial review the same day broke all three (2026-11-02, git 2.55.0.windows.3). What it
found is now the design, so it is written down here finding by finding.

**`git worktree remove` is not atomic, and its exit code does not say whether it finished.**
Probed: a tree holding a `node_modules` junction is unregistered, emptied of tracked files and its
`.git` link deleted — and the folder stays, holding the junction, with exit **0**. A tree with an
ignored file held open does the same and exits 255. Either leftover is a folder with no `.git`, so
git inside it walks *up*: `rev-parse --show-toplevel` answers the main repository, on main. The
next spawn with that key found the folder (`ensure` checked only that it existed), said "joins
worktree group", and the card's `git commit -am` landed on main. So:

- **A folder is a tree only while `<folder>/.git` exists** (`lost_its_link`). `ensure`/`ensure_at`
  move a folder without one aside to `.leftover-<slug>-<secs>` — renamed, nothing deleted, and the
  receipt says where — and make a fresh tree; one that cannot be moved is a refusal. A folder whose
  `.git` answers to another repository is refused (`same_repository`).
- **The in-use check is a rename, because Windows makes it one.** Probed: a file held open with
  *any* share mode, or a process whose cwd is anywhere inside, makes renaming the tree's folder fail
  with nothing changed. So `retire` begins with `git worktree move` to `.retiring-<slug>-<secs>`
  and keeps the tree if that fails. That one step covers a card's leftover process, a dev server
  group run in the tree and an escaped WMI child alike, and it cannot race: a removal that has
  started is a removal of a tree nobody holds.
- **Then links are unlinked, never followed** (`unlink_links`), `git worktree remove` runs without
  `--force`, and whatever it leaves is deleted — every byte of it having passed the checks below —
  or reported as `Retired::Partial`, a `bad` chronicle row naming the folder.

**An ignored file is not a disposable one.** `worktree remove` takes ignored files with it, and
CLAUDE.md sends every card's working files to `.scratch-$SKEIN_CARD/`, which is ignored. So is an
edited `.env`, a local database, a generated key. `retire` asks `status --ignored` and lets the
tree go only when every ignored path is build output by name — an ignored *directory* git
collapsed (`build/`) whose own name is in `REGENERABLE_DIRS` (`node_modules`, `target`,
`.svelte-kit`, `dist`, `build`, …), or a file named like `*.tsbuildinfo`; never a file merely
*inside* a folder called `build`, since a tracked `build/` can hold an ignored `secret.env` — or a
byte-for-byte copy of the same path in the main tree — which is what a `.worktreeinclude` seed is
until somebody edits it. Anything else **keeps** the tree, and the chronicle names up to three of
the paths. Kept rather than moved aside: a group whose cards left notes behind is a group a person
should look at, and the spawn receipt and `group_note` both say a `.scratch-` folder keeps it.

**"Merged" is a claim about the branch, and the work may not be on it.** A detached `HEAD` with
commits (a bisect, `checkout <sha>`, a rebase paused on a conflict — which the merge-back recipe
itself can cause) leaves `wt/<key>` at its base, which is merged, so the tree and its reflog went
with the only reference to that work. `retire` requires `symbolic-ref HEAD == refs/heads/wt/<key>`
and no `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or
`BISECT_LOG` in the tree's git dir. A commit made detached and then abandoned *before* returning to
the branch is not caught — the reflog check that would catch it also refuses every group merged
back by rebase, whose pre-rebase commits are in the reflog by design.

**A spawn could land in a tree being deleted.** `ensure_at`'s fast path skipped `MAKING`, and the
store's census only sees a card once the front end writes its row, after `spawn:asked`. Now
the tree's lock is taken before the folder is looked at on every path; a birth (`ensure_at`, from
`spawn` and the flyway) leaves a **claim naming the card** (its id, minted before the tree for
this), written under the lock; and `retire` hands the claims to the census (`in_use`) under the
same lock, which counts a claimed card with no row yet as in the tree. The branch
is deleted *under the lock* too, after detaching the tombstone, so a spawn the moment the lock is
let go starts a fresh group rather than finding `wt/<key>` checked out by a tombstone. The slow
delete runs after the lock is let go. A wake does not claim, or a card closed minutes after it was
woken would keep its tree.

**"Merged into the main tree" means into the branch it is *on*.** `merged_somewhere` counts the
main tree only through `symbolic-ref`, never its raw `HEAD`, and never when that branch is the
group's own; and the remote's main. Two reproductions by the review of these fixes: a main tree
detached at the group's tip (a paused `git rebase wt/x`, a bisect, `switch --detach wt/x` to look)
made the group "merged" into a commit nothing would keep once `HEAD` moved; and a main tree with
`wt/x` *checked out* made it trivially merged, so a birth with key `x` deleted the branch under the
person standing on it and orphaned their commits. A birth also refuses to replace a branch any
worktree has checked out (`checked_out`).

**A swallowed `branch -d` left a branch the next group silently resumed.** With no upstream,
`branch -d` judges against the main tree's `HEAD`, so a group merged into the remote's main while
the main tree stood on another branch kept its branch; the next spawn with that key checked the
*old* branch out, ignored its base and said "new worktree group … started from <your commit>".
Now `drop_branch` falls back to `update-ref -d <ref> <tip>` (the tip `retire` proved merged), and
`ensure_at` handles an existing branch two ways, both said back in the receipt: one this wall
marked as a group and already merged is deleted and the group starts where it was asked to
(`Ensured::replaced`); anything else is **resumed** as it is (`Ensured::resumed`), and the receipt
says it resumes that branch at that commit and that the caller's base was not used.

**`wt/` is a name; the mark is the fact.** A group the wall makes gets
`branch.wt/<key>.voleryGroup = <app identifier>` in the repository's config, and `retire` takes
down only a branch carrying *this* wall's identifier. A person's own `wt/` branch, a group from
0.94.0 (before the mark), and a lab's group in the same repository all read as "not ours" and are
kept. `git branch -d/-D` drop the section with the branch. And since the *folder* is what collides
on a case-folding disk, any name whose folder would be `wt+…` must be exactly a group branch
(`reserved`): `WT/Auth`, `wt+auth` and `Wt/auth` are refused — at a birth, and on a wake only when
it is about to make something, so a card from before groups whose row already names `wt/Spike` can
still come back to its own tree. And a group's folder found on some *other* branch (a person's
`wt+auth`, slugged to the group `auth`'s folder) is refused rather than joined (`holds_the_group`);
detached is allowed, since that is a group mid-rebase.

**A retirement only ran at a close**, so a crash in the three-second beat, a card moved to another
wall or a territory forgotten with its cards left a 12–15 GB tree forever. `sweep_worktree_groups`
runs two minutes after launch over every territory root and every `cwd` a group card ever had (a
forgotten territory is not in `project`), puts each `wt+<key>` folder through the same `retire`,
and finishes any `.retiring-*` tombstone a crash interrupted — sparing anything ten minutes young
(`SWEEP_SPARES`), which may be a tombstone a retirement is still finishing or a tree another process
(a lab on the same repository) is still birthing behind a claim this one cannot see. It says only
what it removed; a kept tree was said at its close.

**A claim names a card, not a moment.** It was a two-minute clock first, and both readings of a
clock were wrong. As a veto, a card spawned and closed inside its own two minutes — the first lab
run did exactly that — left its tree for good. As a wait (the next cut, `Retired::Claimed`), a
front end starved past two minutes (2026-10-19's freeze) had its fresh tree retired before the
row landed, and the wake rebuilt it off the ladder without the orchestrator's base. "This card has
no row yet" is true however slowly the front end draws and false the moment it has one, which is
the whole question. Claims are forgotten after an hour, which bounds memory only: a row that never
landed was a spawn that failed, and its tree is the sweep's.

**A mark must not outlive its branch.** Probed by the second review: with `config.lock` held by a
tree being made beside it, `git branch -d` deletes the ref, fails to rewrite the config and exits
0, leaving `voleryGroup` for the next `wt/<key>` to inherit. `unmark` checks the mark is gone after
every delete and retries, as `mark` does on the way in.

The census compares directories as places (case, separators, trailing
slash), because the sweep's roots come from `project`, and a census that read zero for an occupied
group is the one wrong answer that deletes something.

On a thread, three seconds after the close (the card's process is killed by a separate command,
and a process still standing in the tree makes the move fail, which keeps the tree for no reason).
The verdict goes in the chronicle either way — *kept worktree group wt/x: N commit(s) … are not on
the main tree's branch* is work the user may not know is still out there. A person's branch
(`feat/x`) is never retired.

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
never a path climbing out of the root; never into `.git` or `.claude/worktrees` (a line of `*`
once meant copying the tree into itself, under the lock); never through a symlink or junction;
and at most 2 GB in all. This repository lists `src-tauri/sherpa/`. It applies to a
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
