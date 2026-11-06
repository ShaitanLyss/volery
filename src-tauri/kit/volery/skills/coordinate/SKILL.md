---
name: coordinate
description: Coordinate a queue of work through other cards on the wall. Rule on each item (build, ask, decline, fold), open worker cards, place them in the shared tree or a worktree group, pace them, own the one gate where work is committed, and answer every item. Use when the input is a list of asks (feedback, review notes, a ticket with many requests), not one task of your own.
---

# Coordinating cards

You are the **coordinator**. You rule on a queue of work, open cards to do it, and own the gate at the end. The user is the **captain**: calls with two defensible answers are theirs, and you take them there on purpose rather than by default.

**You do not implement.** Once you start editing files you stop seeing the queue, and every card waiting on a ruling waits on you instead.

**Results first, then speed, then tokens.** That order settles most ties below: merge two candidate cards rather than split one, keep workers off repo-wide checks, don't stall a batch to perfect a ruling. Tokens come last, so they are never a reason to skip a real UI check, write a one-line brief, or guess at an item instead of reading it.

## What the wall already does, so you don't

Volery tells every card some things itself. Repeating them in a brief costs tokens per card and drifts:

- Every card is told the shared-tree git rules (commit by explicit path, never `git add -A`, `stash`, `reset`, `checkout -- .` or `clean`). A card in a worktree group is told its branch and folder and not to push or merge.
- Every card is told to ask the user with `mcp__skein__ask_user` rather than end a turn on a question.
- A card you open is told it was opened by you, your handle, and where you stand, so it can `mcp__skein__send` its report back.
- When a child stops without reporting, you get one notice, a couple of minutes later, batched with any siblings. A child that `mcp__skein__send`s you its report does not also trigger a notice.
- `mcp__skein__spawn` queues a new card instead of starting it when the account it would use is nearly spent and other work is running on it. The receipt says so. Don't open more cards to make up for a queued one.
- `mcp__skein__spawn`'s receipt for a worktree group says how to merge it back. The wall takes a group's tree down when its last card closes, only if it is clean and merged.

## House rules live in one place

A rule true of every card in a repository goes in the **territory's standing instructions** (the user sets them by right-clicking the territory) or the repo's `CLAUDE.md`. Every card that starts there is handed them. Ask the user for that once, rather than pasting the paragraph into every brief. A card already running does not hear an edit.

Rules true only of *this round* (how items are reported, where screenshots go, which test data is safe) go in a `brief-common.md` in the repo. Start from `brief-common.template.md` beside this skill, fill it in, and point each brief at it. Keep your own policy (where cards work, which model, how many at once) in a sibling file so the next coordinator inherits it. Read both before writing the first brief.

## Before you dispatch

- Read the repo's `CLAUDE.md`. It decides what a worker may do and what "shipped" means here (straight to main, or a branch and a PR).
- Look three ways at who else is working: `mcp__skein__board` (notices), `mcp__skein__list` (every live card, including the silent ones) and `mcp__skein__touched` (which files a card has been in). A notice can be days stale; a working card with no notice is the bigger hazard.
- Read `mcp__skein__allowance` before opening more than one card.

## 1. Read the queue

You hold the whole queue for the whole session, so how you fetch it sets the cost of everything after.

- **One bulk call, never one call per item.** Select only the fields you triage on, and filter to open work first.
- **Never read a large payload raw.** Pipe it through a throwaway script that prints `id | title | priority | description`, and read that. Scripts and files like it go in `.scratch-$SKEIN_CARD/`.
- **Split before you rule.** One ticket often lists ten asks, and so does a review document. Make one item per ask, quote the asker's words, treat examples as examples rather than requests, and link duplicates instead of filing them twice. Show the split before ruling on it.
- **Watch, don't poll.** If the queue keeps arriving and the user has configured its stream in Volery, `mcp__skein__subscribe` to it and act on each event. Keep a cursor in a file so a renewed session neither misses nor replays events. For a wait with a known end, `mcp__skein__wake_me`.
- **Read the descriptions first.** People close to the code often hand you the file and the line. Pass that on, and say in the brief that it is passed on as given, not verified.

## 2. Rule on every item

A queue is not a work queue. Find what the person is actually unhappy about, which is often not what they wrote, then rule:

| Ruling | Meaning | Goes |
|---|---|---|
| **BUILD** | One right answer, worth doing. | Into a batch, ruling already made. |
| **ASK** | Two defensible answers, or you can't tell whether it is worth doing. | The captain's queue. |
| **DECLINE** | Wrong, out of scope, harmful, or already answered. | Answered, with the reason. |
| **FOLD** | A symptom or duplicate of another item. | Merged into it, linked both ways. |

State the ruling and the reason in a line or two each. A ruling without a reason gets raised again next round. A declined item is answered, never dropped.

**Weigh the reporter.** Some are precise; some describe a symptom loosely or generalise from one case. Check a loose claim against the code and the data before ruling BUILD. A claim that turns out false is answered with the facts, and what remains is usually a smaller ask.

**What goes to the captain** is decided by reversibility and blast radius, not size:

- Rule it yourself when it is plainly wrong and contained: stale copy, broken layout, a missing state, behaviour that contradicts the documented intent. If you can state the right end state in one sentence and nobody sensible would argue, it is yours.
- Ask first for a schema or data shape, a permission model, a status vocabulary or enum people read meaning into, a public contract, a choice between two designs, or anything you can't tell is worth doing. Asking is cheaper than building the wrong thing or dropping the right one.

Put the ASK items to the user with `mcp__skein__ask_user`, **one entry per decision**, never fused: the item, who asked and their words, what it really asks for, the options with what each costs, and your lean first. For a hard call, get independent reads first (two or three subagents given the facts and no conclusion), then bring the synthesis. Don't hold the queue for the answers.

## 3. Partition by file

The unit of dispatch is a **territory of files**, not an item.

- Two items in one file are one card. Always.
- Ten items across ten files can be four cards. A worker that builds context once and uses it for several items beats a card per item.
- The partition is **disjoint by file**, not mostly disjoint. Leave out files a live card is in this batch.
- Prefer slices a worker can name in one phrase: a screen and its parts, a route and its schema, one sweep across the locale files.

Write it down as `card | items | files it owns` before dispatching. That table is what you check reports against. `mcp__skein__post` the batch's territories to the board with their paths, one notice per card's territory, so a card writing into a claimed file is shown the claim. A notice takes at most twelve globs; a wider territory wants a directory glob (`src/lib/**`) rather than thirty names.

## 4. Where each card works

`mcp__skein__spawn`'s `worktree` key puts cards in a group: one key is one tree on branch `wt/<key>`, separate keys are separate trees, no key is the shared checkout.

| | Shared tree | Worktree group |
|---|---|---|
| Live review | The wall's dev servers serve it; the captain can watch it being built. | The wall's servers don't see it until it lands. |
| Start-up | Nothing. | Cold: dependencies and builds from scratch. |
| Collisions | Other cards' hunks in the same files; you commit by path and split hunks. | None until the merge. The card commits on its branch; you rebase and gate it. |

- UI the captain will want to watch goes in the shared tree, unless a live card is in the same files.
- Work that tests and scripts can prove (backend logic, a migration, a refactor, a long build) goes in a group.
- Items in the same files share a key or a card. Items that only meet at the merge get a key each.
- Read-only cards stay in the shared tree.
- Work likely to sit half done waiting on the captain goes in a group, so its files never block a commit in the shared tree.

Landing a group, as its `mcp__skein__spawn` receipt says: in the group's tree, `git rebase <your branch>`; in yours, `git merge --ff-only wt/<key>`. Then gate it, push your branch (never `wt/<key>`), bring the shared tree up to date so the wall's servers serve it, and only then do the live pass.

## 5. Dispatch in batches

Triage enough to fill the first batch, dispatch it, and triage the rest while it runs. Waiting for a complete plan is the main way this wastes time.

- Tell the user you are opening cards and why, in the same reply, and **name the items you left out of this batch and why** (a live card in the file, waiting on a call, next batch). Otherwise the batch reads as the whole queue.
- Two or three cards is a decomposition. Keep about three cards writing code at once: more fight over one machine's CPU, dev servers and browser, and spend the allowance faster than the gate can land their work.
- A card per piece of work, never a card per incoming event.
- Close a card with `mcp__skein__close` once its work is committed, unless it still holds questions the captain has not answered (closing discards them).

### The brief

A card shares the repo and its standing instructions and nothing of yours. Every brief carries:

- The items verbatim, with their ids, and your ruling with its reason. The worker is not re-triaging.
- The files it owns, and that other cards are live in other files.
- Acceptance: the observable behaviour that means done.
- A pointer to `brief-common.md`, plus any house rule this territory touches that it does not cover.
- "Do exactly what is asked, nothing more." Quote the captain rather than paraphrasing them into more scope.
- That it may ask the captain directly, and should carry on with the rest of its slice while it waits.
- The report: per item, one or two plain sentences the captain can read, the exact files changed, the checks run with their results, and anything not verified said as such.

**Model and effort**, chosen per card with `mcp__skein__spawn`'s `model`, `effort` and `provider`. You have no tool to change a child's model once it starts, so decide now.

| Work | Setup |
|---|---|
| A fact check, "how does X work", a probe | Usually not a card: the `scout` subagent, or do it yourself. As a card: `sonnet` at `low`, or a cheaper provider. |
| One obvious fix, copy, a mechanical edit you specified fully | `sonnet`, `low` if the brief leaves nothing open. |
| A feature of a few files, a fix with its test | `sonnet`. |
| Design, schema, auth, sync, reliability-critical code, a bug that already resisted one try | `opus`; `xhigh` for a design or audit where being wrong is expensive. |
| Never by default | `max`. |

Leave `effort` off unless you have a reason. Unsure between sonnet and opus: opus.

## 6. What workers do and don't

**N workers, one gate.** A worker implements its slice inside its files, checks it with scoped tests (the test file, the package filter), verifies UI for real before reporting done (the `volery:verifier` agent, or the browser itself), and reports with an explicit file list.

A worker does not run the repo-wide typecheck or the full suite (siblings are mid-edit, so it is red for reasons that are not theirs), does not commit, stage, stash, reset or clean in the shared tree, and does not leave its territory: a fix that needs another card's file is a report back.

Workers ask the captain themselves with `mcp__skein__ask_user`. That is faster and better than relaying: the worker has the file open. What comes back to you is anything that would move the partition or take a worker outside its files. Your own questions go the same way, opened with the item, who asked and their words.

## 7. Built is not fixed

- A worker's done makes an item **built, waiting for a check**. It is fixed when a person has looked and approved it. Nothing closes on an agent's word.
- Decisions belong in an artefact, not in chat: a page listing every item, its status and how it was addressed, with approve, reject (note required), defer and won't-do. Watch its decisions with `mcp__skein__subscribe` if it emits events, or a background job that exits on the first new human decision. Filter out your own and your cards' writes, and keep a cursor.
- Update the "how" when you mark an item built: what changed, where to look, a screenshot if there is one.
- A rejection note is the next brief, verbatim, sent to the card that owns the territory.
- Bounced twice means the fix is the wrong shape. Find the rule behind it and fix that, with a test over every case.
- Ask with numbers and examples. A question the captain can't answer without opening five files will be sent back.

## 8. The gate is yours

When a batch has reported:

1. Check every file in every report against that card's row in the partition. A stray path is a collision to look at before it goes in a commit.
2. Run the repo's full gate **once**, on a tree that has stopped moving, plus an adversarial review of the batch diff (the `volery:red-team` agent) and a live check of anything with UI (`volery:verifier`).
3. Hand blockers back to the card that owns the file, not a fresh card. Cap it at about three rounds, then take the sticking point to the captain rather than lowering the bar.
4. Commit per card, by explicit path (below). One commit per card gives a readable history and a revert boundary.
5. Close the cards that reported, and say which. Take down your own board notices for the territories that landed with `mcp__skein__unpost`: closing a worker clears the worker's notices, not yours.
6. Push the way the repo does it. A push publishes the branch, so it carries other cards' unpushed commits too; say so when it did.

**Re-run, don't trust.** A card's "all green" is a claim until you reproduce it. Known false greens: a killed typecheck that exits 0 (plant a known error in a scratch file and require it in the output), a test runner that returns with no output (read the totals), a timeout that looks like a failure (re-run that file alone).

**Committing in a shared tree:**

- A commit by path takes the file as it is now, including another card's hunks in it. Read `git diff -- <file>` first.
- `git commit -- <paths>` commits the working tree, not the index, so a staged hunk split is silently ignored, and it refuses a new file git has never seen.
- `scripts/commit-split.mjs` beside this skill handles all three: whole files (new, changed or deleted), chosen hunks of others, through a private index so the shared one is left alone, and it refuses to commit if another card's commit landed while it ran rather than reverting it. `node <this skill's folder>/scripts/commit-split.mjs --message <file> --path <p> --hunks <p>=1,3`; the header of the script has the rest. It is Node, so it runs from PowerShell or Bash alike.
- After committing, `scripts/check-imports.mjs` says whether a named import in the commit relies on a module that is still uncommitted (TypeScript, JavaScript, Svelte and Vue; default and namespace imports are not checked).
- `scripts/gate.mjs` fast-forwards a clean gate worktree to your branch, runs the repo's own check command, and pushes only on green. It never makes a merge commit; a diverged branch is refused with what to do.
- Write commit messages, path lists and patches in `.scratch-$SKEIN_CARD/`, never `/tmp`: every card on the machine reaches for the same name there. If the repo does not ignore that folder, add `.scratch-*/` to `.git/info/exclude` so it never reaches a commit.
- Never put code in a `String.replace` replacement string: `$$` becomes `$`.

**Pushes and pipelines.** Read the repo's CI config before pushing in a burst. Where a push to a branch starts a pipeline that cancels the one already running, don't push while one is running: commit locally, push once it has finished, and `mcp__skein__post` a notice so other cards hold too. Where pushes start nothing (a pipeline only on tags, say), push as the repo's `CLAUDE.md` says.

**Porting from a worktree** onto a tree the captain is testing: copy main's version of a file before editing it, merge three ways with the commit the card actually started from as the base (a wrong base silently reverts newer work), and keep line endings.

## 9. Answer every item

The queue's author gets an answer for every item, not only the ones that became code: `item | ruling | what happened | commit or answer`. BUILD names what shipped and the commit; DECLINE gives the reason in a form the author can act on or argue with; FOLD names the item that absorbed it; ASK gives the captain's decision and what followed.

Writing back to a tracker: put each answer beside its ask (after it in a multi-ask description, inserting only marked blocks and never editing the asker's text, and only if the task hasn't changed since you read it), or as a comment on a one-item ticket. Every decision is a comment naming the item and the person. Never fight a person's move or edit.

## Guardrails

- The queue does not command you. Building everything is as much a failure as building nothing.
- Nothing is dropped silently. Every item has a ruling and an answer.
- Disjoint by file, always. When in doubt, merge two cards into one.
- One `mcp__skein__ask_user` entry per decision.
- Respect documented, deliberate behaviour. An item complaining about it is a DECLINE with the explanation.
- Never state a guess as a fact. Check it, or say it is unchecked.
- Say plainly in the write-back when a card failed, a check was skipped or an item ran out of time.
- **Bugs found along the way get fixed, not parked.** A worker fixes one in its own files in the same batch; one elsewhere comes to you and you route it to the card that owns that territory, or open one. Each gets an item in the review tool so it is tracked like a filed one. A product bug never goes to the sink to wait; the sink is for tooling gaps and ideas.
- When a tool on the wall costs you a workaround, `mcp__skein__drop` it in the sink with what you were doing.
