---
paths:
  - "src-tauri/src/remove.rs"
  - "src-tauri/src/hooks.rs"
  - "tools/probe-rm.ts"
  - "tools/lift-remove.ts"
---

# Deleting a path from a card, and the guard everybody believed in

Two halves that only work together: `mcp__skein__remove`, which deletes behind one click,
and two `PreToolUse` denials whose reasons name it. Built 2026-09-10 for sink `394430bf` and
`14f2543e`, both open since 2026-08-31 and both stuck on a design question that turned out to
rest on a false premise.

## The premise, and the measurement that overturned it

The user's own `~/.claude/settings.json` carries

```jsonc
"deny": ["Bash(rm -rf:*)", "Bash(git push --force:*)", "Bash(git reset --hard:*)"]
```

put there deliberately, on a stated intent: **cards must not be able to delete without my
approval.** Everything written about this before tonight reasoned from that rule firing.
Sink `14f2543e` did, `docs/TOOL-SURFACE.md` §2 did at length, and so did the brief that
commissioned this work — which went as far as instructing that `hooks.rs` must *not* guard
deleting, since that would "double up on something already handled".

It is not handled. `tools/probe-rm.ts`, one real turn against claude 2.1.241 with Skein's own
argv shape and that deny list verbatim, sentinel directories as the ground truth:

```text
shell tools the card was given: PowerShell

SURVIVED  rm -rf a-rm-rf              Remove-Item: no parameter matches 'rf'
SURVIVED  rm -fr b-rm-fr              Remove-Item: no parameter matches 'fr'
SURVIVED  rm -r -f c-rm-r-f           'f' is ambiguous: -Filter, -Force
SURVIVED  rm --recursive --force d     no positional parameter accepts '--force'
DELETED   find e-find-delete -delete
DELETED   mv f-mv-aside f-mv-aside.bak
DELETED   Remove-Item -Recurse -Force g-remove-item
```

**Not one of those calls was refused by a permission rule.** A card spawned this way has no
`Bash` tool at all — asked for one by name, it answered *"NO BASH TOOL"*, and a `ToolSearch`
over the deferred set found none — so `Bash(rm -rf:*)` names a tool the card cannot call and
matches nothing. The four spellings that survived did so because PowerShell's `rm` is an alias
for `Remove-Item`, which rejects POSIX flag bundles before any deletion is contemplated. That
is a shell incompatibility wearing a guard's clothes, and it holds for exactly as long as
nobody types the spelling that works — which the probe then did, and it worked.

**What is *not* established is why.** This card, on the same machine and the same
`settings.json`, does have a Bash tool, and its own `rm -rf` was refused by that rule mid-task.
So the rule works where a Bash tool exists; what decides whether a card gets one was not
measured and is not claimed here. Both facts are true and the honest reading is the narrow
one: *with Skein's argv shape, on 2026-09-10, the card got PowerShell and the deny governed
nothing it could do.* Filed as sink `a093c3ba`.

The general shape, and it is worth carrying past this subsystem: **a permission rule names a
tool before it names a command, so a rule is only worth what the tool list makes it worth.**
Nothing errors when it stops matching. A deny that governs a tool the card was never given is
indistinguishable, from every direction anybody looks, from a deny that is working.

## Why a tool rather than a wider permission

A permission rule can refuse and cannot ask. That is the whole of it. So a card that
legitimately needs a corrupt build cache gone is stopped with nowhere to go, and the thing it
does next is find a spelling that is not denied — sink `14f2543e` recorded the one that was
reached for, `mv .next .next-stale-audit-backup`, which had the same effect while being less
legible about intent and leaving 5.3 GB on disk that is still there.

**An MCP tool call is not the Bash tool, so `Bash(rm -rf:*)` never matches one.** That is the
entire mechanism, and the bypass *is* the design rather than an awkwardness in it: the deny
goes on blocking the unapproved shell route, and this is the approved one. The item framed the
tool as "a deliberate bypass of a guard in the user's own config, a thing to be given
permission for" — that framing is backwards, and correcting it is half of why this file
exists. The user's intent was never *no deleting*; it was *no deleting without me*. Only a
tool can do the second half.

`.claude/rules/asana.md` reached the same conclusion one realm over and it is cited rather
than re-derived: *every write asks because the confirmation stands in for a scope an unscoped
token cannot have.* Here the scope that does not exist is **"this particular path, this
once"** — no permission vocabulary on this machine can express it, so a person expresses it
instead.

## Everything asks, and the tiering is deliberately not built

`docs/TOOL-SURFACE.md` §2 works out a four-tier classification — regenerable build output,
ignored-but-irreplaceable, tracked-and-clean, tracked-and-dirty — and recommends letting tier
1 through on the card's own word. **That is not built**, and the reason is which way the
mistake falls: *"it is only a build cache"* is exactly the judgement an agent gets wrong, and
`.env` and `.next/` are both invisible to git while one of them is irreplaceable. A `remove`
that always asks fails by wasting a click. One that sometimes does not fails by deleting
something nobody can get back.

The tiers remain the right analysis and the file remains worth reading. What is deferred is
*spending* them, and the thing that would change the calculation is evidence about how often
the click is actually a nuisance — which nobody has yet, because until tonight there was no
tool to be a nuisance.

### And then one tier was spent, and it is not "build cache"

The evidence arrived on 2026-09-30 (sink `b3d1036c`): a card cleaning up its own review
subagents' copies asked the user to click on `%TEMP%\rv1`, a directory nothing reads. So a path
**strictly inside the OS temp directory** deletes without a click — `unasked` — provided it is
also outside any repository and holding none (`nested_git`, from a walk that was not capped),
outside the parts of temp something live keeps (`reserved`: the CLI's own `claude\`, where every
card's background-task output lives, and this app's `skein-`/`volery-`), written by no other card
on this wall, and under no running dev server.

The argument is the directory's, not the agent's, which is what keeps it clear of the judgement
this section refuses to spend: temp is where the OS says scratch goes, and nobody can weigh a
click on it. The three extra conditions are there because **temp is shared by every card on the
machine**, so "in temp" alone would be the shared-`.scratch/` hazard (`CLAUDE.md`) one directory
out — a card sweeping another card's in-flight files. The temp root itself is asked about, since
it is everyone's scratch at once, and it is all-or-none per call: a question listing five paths
when three were going anyway is a question about the wrong thing.

**It is evidence of absence, and the adversarial review said so first.** A card's writes are
recorded when it uses the file tools; its *shell* writes are not, so "no other writer" means none
on record — which is why the repository and reserved-subtree conditions are hard checks rather
than trust. The same review caught a clone nested under the target counting as "untracked"
(git is asked from the target, which is not itself a repo), and `%TEMP%\claude` passing every
condition.

`TEMP` is an environment variable and could say anything, so `narrow_temp` refuses a candidate
root that is not named `Temp`/`tmp`, is a filesystem root, is the home directory or an ancestor
of it, or contains a territory. Roots are canonicalized before comparison — `temp_dir()` hands back the 8.3 short
form (`LYSS~1.DEL`) on this machine, and the targets are long-form. The refusals all still run
first; the tier only decides whether the question is worth putting.

## The delete is permanent, and the confirmation is the whole of the safety

Considered and rejected: `SHFileOperationW` with `FOF_ALLOWUNDO`, which puts the tree in the
Windows recycle bin and makes a mistake recoverable.

Three arguments, and the first decides it.

- **The recycle bin silently skips anything over its per-volume quota.** The default is a
  percentage of the volume, and a 5.3 GB `.next` is exactly the size that exceeds it — so the
  bin would hold the small mistakes and permanently delete the large ones, without saying
  which it had done. A promise of recovery that quietly does not hold for the cases worth
  asking about is *worse than no promise*: it is a check that is wrong in the reassuring
  direction, which this codebase refuses everywhere (`checkFailed`'s rule, `docket.rs`'s
  argument against masking the token).
- **It does not hold off the user's own volume either** — a network path or a second drive
  without a bin deletes outright, again silently.
- **Putting 5.3 GB in the recycle bin is its own kind of wrong.** The tool's ordinary case is
  reclaiming disk space; a version of it that moves the space somewhere else and leaves the
  user to empty it by hand has not done the job.

So the delete is permanent and the confirmation says so in as many words, twice — in the
question and in the result. `.claude/rules/undo.md` is the other half of the argument and
points the same way: the stack is this session's and in memory, and it explicitly *cannot*
reach a file. Its one file-shaped decision went the other way for a reason that does not apply
here — `store::delete_image` stopped deleting the copied file **because taking an image down
is undoable**, so a step restoring the row needed the file to still exist. Nothing about
`remove` is undoable, so there is no row to restore and nothing to keep the bytes for.

## What the question carries

Sink `394430bf` named five things and every one of them is something the user cannot get from
the path in front of them. That list is the tool's whole advantage over an agent asking in
prose, and `the_question_carries_the_five_things_a_path_cannot_say` holds it:

- the absolute path, canonical — not the string the card typed
- size and file count, or *more than* both when the walk was capped
- whether git tracks it, and how much: untracked reads differently from *240 files come back
  from a commit*
- which other cards on this wall have **written** under it (`store::touches_near`, which is
  the wall's own record — git knows what changed and not who changed it)
- whether a dev server is running in that tree, which is the fact the item was filed about:
  deleting `.next` under a live server costs *every card on the wall* a cold recompile, and
  nothing in the path says so

**The survey runs before the question, not after.** `docket.rs` states the rule and it is
sharper here: a confirmation that says "delete a directory" without saying how big it is is
not a smaller version of this question, it is a different and worthless one.

### Where the walk runs, which is not where the brief expected

The brief flagged this as a `#[tauri::command]` that must go through `crate::off_main`,
because walking 9,627 files on the main thread freezes every card on the wall. That is the
right rule and it does not apply: `remove` is reached from `ask::start`, which **gives every
request its own thread**, on the same bargain `servers::handle` and `docket::handle` already
strike — *this parks nobody but its own caller*, which is a card that asked for a delete and
can wait for one. It must never become a `#[tauri::command]`, and the comment at the foot of
`ask.rs`'s roster chain says so about the arm below it for the same reason.

The walk is still bounded, two ways, because "its own thread" is not "unbounded": 200,000
entries or 15 seconds, whichever comes first, and a capped walk reads as *more than* rather
than as a count. `DirEntry::metadata` rather than `fs::metadata`, so a junction is counted as
the link it is rather than walked into — Windows build tooling makes these constantly and
following one describes a tree the delete will not touch.

## What it refuses, with a click or without

Refusing is cheap and a refusal is legible, so `refuse` errs towards it. Every arm names what
to do instead, because a refusal an agent cannot act on is one it will work around — which is
this whole subsystem's founding observation.

- **A path holding uncommitted changes to tracked files.** This is what makes the tool safe to
  offer at all. `git status --porcelain --untracked-files=no` and *not* the untracked half:
  an untracked file under a build cache is the normal state of a build cache, and refusing on
  one would refuse every case the tool was built for.

  **In this tree the dirty half is frequently somebody else's**, which is sink `8404a6ca`'s
  lesson arriving in a new realm. Several cards work in one checkout here, so uncommitted work
  under a path one card is about to remove may belong to a card that has not written it down
  yet — and a delete takes all of it at once with nothing anywhere to say whose it was. The
  refusal says so and names `mcp__skein__touched`.
- **Anything under `.git`.** Matched on the *name* rather than resolved, because `.git` is a
  file in a worktree and a directory in a checkout, and both answers are leave it alone.
- **A git work tree's root, a territory root, a filesystem root, the home directory**, and any
  directory the calling card is standing inside. A *sibling* territory is not refused — a card
  clearing another project's build cache is a real thing to want, and it is asked about like
  anything else.
- **A path that does not exist**, said plainly rather than succeeding vacuously. The refusal
  spells out why that is not the same as done: an agent told "nothing to do" acts as though
  the cleanup happened, and a path already gone and a path got wrong look identical from here.

`under` is the sharpest of these and the easiest to get wrong: it compares on **segment
boundaries**, because a plain `starts_with` makes `C:/work/skein-old` a child of
`C:/work/skein` — right for every path anybody tests by hand and wrong exactly when two
directories share a prefix.

### The refusals are re-checked on the way out, and the reading is not

`docket.rs` does not re-read on approval, on the argument that the only thing which can have
changed is on Asana's side. That argument does not survive the crossing. A question can stand
for up to forty-five minutes, and those are minutes in a working tree several cards are
editing — so a directory that was clean when the question went up can be holding somebody's
unwritten work by the time it is answered. `settle_delete` re-runs `refuse` against a fresh
light survey, which is `spawn::close`'s rule: **the settle is the last moment at which the
wall is still current.**

The *reading* is deliberately not refreshed. Size and file count informed a decision that has
now been taken, and re-walking nine thousand files to produce a number nobody will see would
only widen the window between the check and the delete.

## The two denials, and why the tool alone was not enough

`docs/TOOL-SURFACE.md` §1 is the finding both of these rest on: **a capability an agent has a
habit against is indistinguishable from one that does not exist.** A description is only read
by an agent that has thought to look for a tool, and the failure here is not searching — it is
already knowing what to type. A `PreToolUse` deny is the only channel on this machine that
speaks *at the moment the reflex fires*, and `deny(reason)` reaches the model even under
`--dangerously-skip-permissions` (probed 2026-08-25, 2.1.241; bypass skips the asking, not the
hooks).

So `hooks.rs` grew two more guards beside `perilous` and `sweep`, and neither is a wall — each
hands over a working route, which is what stops `14f2543e`'s complaint applying to them: *a
guard that is both obstructive and bypassable is the worst of the three options*.

**`displaced` — a move that is a delete with a rename on it.** `.next` →
`.next-stale-audit-backup`, `dist` → `dist.old`. Displacement is the *shape* rather than the
verb: what matches is a destination that is the source with a shelving word bolted on, in the
same directory. An ordinary `mv a b`, a move into a different folder, a rename inside a
refactor — none of them match, and that is the property that makes it affordable. A guard that
fired on ordinary renames is one every card learns to route around, and then it guards
nothing.

**`wipes` — deleting a tree from the shell.** Added with the user's explicit approval on
2026-09-10, because a new denial every card on the wall is subject to is not a thing to add
and mention afterwards. It covers the **family** rather than the two spellings the probe
watched get through: `Remove-Item`/`rm`/`del`/`rd`/`rmdir` with any recursive switch, cmd's
`/s`, and `find … -delete` / `-exec`. A guard catching two of five spellings is the precise
failure it was added to fix.

Deleting **one file, non-recursively, is not denied at all**. That line is what keeps this from
being a guard on `rm`, and `deleting_one_file_is_not_this` holds it.

**And it let the commonest spelling through for three weeks.** `wipes_in` read any word opening
with `/` as a cmd switch, so `rm -rf /tmp/rv1` — any absolute POSIX path — "named nothing" and
was not a wipe. `is_cmd_switch` now asks for cmd's actual shape, one letter after the slash, and
only for cmd's own verbs (`cmd_verb`): to `rm`, `/c` is Git Bash's whole C: drive.

### A shell delete is handed over, not refused

Refusing with the tool's name in the reason cost a turn every time and relied on the card
reading closely; the item that changed this was filed by one that did not (sink `b3d1036c`). So
where the command can be read **exactly**, the hook does the call itself: it POSTs the paths to
`ask::REMOVE_PATH`, which runs `remove`'s own decision — refusals, survey, question on the card,
temp tier. The shell call is then **denied whatever the answer**, with what happened as the
reason: a yes has already deleted and a no means no, so the command must never run itself.

**It does not hold the hook while the user decides**, and the first version did. A hook the CLI
kills prints nothing, and printing nothing *allows the call* — so a question parked past the
`PreToolUse` ceiling would have run the delete in the shell after all, and nothing had measured
whether the CLI honours a fifteen-minute ceiling. Now `hand_off` runs the whole decision on its
own thread and the request waits at most `HAND_OFF_WAIT` (25s): a refusal, a temp delete or a
quick click comes back in the reply, and anything slower returns "still asking" — the thread
that sees the question through then tells the card what happened as a `from the wall —` message
(`remove::deliver_late`, to the inbox if the card is dormant). Whoever takes the reply sender
decides which, so the outcome is neither lost nor reported twice. `hooks::ROUTE_TIMEOUT` (40s)
sits between that and the unchanged 50s `PRE_TOOL_TIMEOUT_S`, so the hook always answers first,
and a client error is a refusal naming the tool, never silence. It also means a question outlives
an Escape: the card is interrupted, the question stands, and the answer arrives as a message.

- **`routable` is written to say no.** Literal paths only: no glob, brace, comma list or
  unknown variable, no flag it has not heard of, no `-Filter`/`-Include`, no redirection, no
  backtick. `find … -delete` is never handed on — it deletes what *matches* under its operand,
  and handing the operand to `remove` would delete more than was asked. Anything unreadable falls
  back to `wipe_reason`, which is still right, one turn slower.
- **Only when the delete is the first command on the line**, because a `cd` before it moves the
  ground every relative path is measured from. What is chained after it did not run either, and
  the reason says so.
- **Operands are resolved in the hook**, which runs in the card's environment, each variable by
  its own name (`$env:TEMP` is `TEMP`, not `temp_dir()`, which reads `TMP` first): the payload's
  `cwd` (the shell's own, which after a `cd` is not the row's) and Git Bash's mounts — `/tmp` is
  `TEMP`, `/c/…` is `C:/…`. Refused rather than guessed: any other absolute POSIX path, an unset
  variable (the shell would delete `/x`), PowerShell's `~`/`$HOME` (5.1 builds them from
  `HOMEDRIVE`+`HOMEPATH`), drive-relative `C:x` and root-relative `\x`, **any relative path under
  PowerShell** (whether its `cwd` follows `Set-Location` is not measured), a variable or `~` on a
  line with any quote in it (quoting decides whether it expands, and the tokens do not keep it),
  a backslash under Bash, and `''` under PowerShell. PowerShell is tokenized with
  `commands_as(…, false)`, where a backslash is a separator and not an escape.
- **A link is deleted as a link.** `canonicalize` follows a junction, so `rm -rf %TEMP%\link`
  into a repository's `node_modules` would have become a question about the real one. The parent
  is canonicalized instead and `settle_delete` takes the link off with `remove_dir`, which does
  not enter it. That was true of the tool before this and is fixed for both doors.

### What a Bash `rm -rf` still meets first

**The user's own `Bash(rm -rf:*)` answers before any of this can.** The incident's denial was
the CLI's wording, not Volery's, so on a card that has a Bash tool that rule wins — whether it
preempts the hook or overrides its reason was not measured (`tools/probe-deny-order.ts` only ever
got PowerShell under this argv, as `probe-rm.ts` did). Handing over therefore works for every
shell spelling *except* the one that rule covers, until the rule is narrowed or dropped. That is
the user's config and is not Volery's to edit — see `accounts.rs` for the house rule — and
dropping it is now safe to recommend: every recursive delete in every shell reaches her click or
the temp tier through this path.

**Which layer refused is never ambiguous**, which was the brief's stated worry about Volery
guarding anything the user's own config touches. Every reason in `hooks.rs` opens with
`volery:`; the user's deny produces the CLI's own wording and nothing of the kind. Hers is the
Bash tool's, these are every shell's, and hers still comes first where a Bash tool exists.

## What is not covered, and is somebody else's decision

**The bang shell is not hooked and deliberately so.** Alt+I's console and the `!` line in the
dock are Volery's own PowerShell process (`shell.rs`, `bang.rs`) — no CLI, no `PreToolUse`, no
permission layer of any kind. So `Remove-Item -Recurse -Force` typed there runs. That is not a
hole: **it is the user typing on their own machine**, and a guard on their own keystrokes is a
different decision from a guard on a card's. Recorded rather than fixed; sink `e5f929ce` carries the decision.

## Tiering, discovery, and where this tool sits

`remove` is in the **deferred** tier with a search hint, not the loaded one. Two reasons and
the second is the real one:

- the loaded tier had ~2,076 bytes of slack against
  `the_loaded_tier_is_what_every_turn_pays_for`, and this schema is several times that;
- more to the point, `ask.md`'s own rule says a loaded description is either the prompt's
  referent or the prompt's replacement — and this is neither, **because the channel that
  reaches the reflex is the deny, not the schema.** A card that types `rm -rf` is stopped and
  handed the tool's name in the same breath. That is strictly better than a description it
  would have had to go looking for, and it costs nothing per turn.

The hint is written as the words of the problem rather than the name of the solution, which is
`ask.md`'s rule, and it carries **the shell spellings** — `rm -rf denied`, `Remove-Item
-Recurse -Force`, `find -delete`, `mv it out of the way`. A card reaching for this has just
been stopped, so the words in its hand are the ones it typed, and a hint naming only the noun
would match none of them.

## Proving it, on a machine that cannot build the app

There is no MSVC toolchain here, so the app does not compile and the tool cannot be exercised
from a running Volery. What *is* proved:

- `tools/lift-remove.ts` runs 28 Rust assertions for real — both halves, `remove.rs`'s
  decisions and `hooks.rs`'s two detectors. `approved` and `refuse` are the whole of the
  safety and neither direction of either is visible to a typecheck: an `approved` returning
  `true` for everything compiles and deletes on a timeout, and a `refuse` returning `None`
  compiles and hands every card a repository root.
- The lift has already earned itself once. `Move-Item -Path target -Destination target-stale`
  — the form an agent writing PowerShell actually types — had **both** of its operands eaten
  by flag handling that skipped a named parameter's value as though every flag were `-Force`.
  It compiled perfectly and the guard fired on nothing.
- `bash tools/check-gnu.sh` typechecks the paths the lift cannot reach.
- `tools/probe-rm.ts` is the measurement above, and is the thing to re-run when the CLI
  updates — the failure it exists for is *silence*, so nothing else will report it.

**Not proved: the tool end to end.** No question has been drawn on a real wall, no button
pressed, nothing deleted through this path. The wiring — `ask.rs`'s dispatch arm, the park,
the settle — is typechecked and unrun.

**And the tool name was wrong first.** `REMOVE_TOOL` was written as
`"mcp__skein__remove"` where every other tool on this server declares its **bare** name and
lets the CLI prefix it. The dispatch arm would have matched nothing: the tool would list, the
schema would be right, and no call would ever reach it. Caught by
`the_vocabulary_is_the_whole_vocabulary` in `test/classify.test.ts`, which reads every
`pub const *_TOOL` out of Rust and would have produced `mcp__skein__mcp__skein__remove`. Worth
recording because the failure is silent in the direction that matters — a tool nobody can call
looks exactly like a tool nobody chose to use, which is `ask.md`'s oldest lesson in this file's
newest corner.
