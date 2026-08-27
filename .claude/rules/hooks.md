---
paths:
  - "src-tauri/src/hooks.rs"
  - "src-tauri/src/main.rs"
---

# The hooks Skein hands its cards

One `PreToolUse` filter doing two jobs. The first undoes a bug in the tool it is handed to;
the second stops a card committing a sibling's work out of the git index they share. This
file is the measurements behind both, and the conditions under which the first should be
deleted — the *how* is in `hooks.rs`, which is short.

**Read the last three sections before changing anything here.** The first two-thirds of this
file describes a compensator that had silently stopped running, and the correction is at the
bottom rather than woven through, because what it was measured to do is still exactly right —
it was simply never being asked.

### The failure this exists for

The Bash tool halves runs of backslashes in `command` before the shell ever sees them.
Measured 2026-08-21 against claude 2.1.233 on Windows, by comparing three points for one tool
call — what the API emitted (the transcript record), what a `PreToolUse` hook was handed, and
what arrived on disk:

```text
emitted  1  2  3  4  5  6
arrived  1  1  2  2  3  3        ceil(n/2)
```

**It is not the shell**, and that is the whole reason this went four months unfixed. Every
session that hit it wrote a correctly *quoted* heredoc — `<<'EOF'`, which does no backslash
processing whatsoever — and concluded the heredoc had eaten its escapes. The collapse also
hits single-quoted arguments and one-line commands, so bash never had the chance. Nor is it a
JSON or C unescape: `\n`, `\"`, `\$`, `` \` `` and a lone backslash all arrive intact, and a
JSON unescape would have turned the first into a newline.

There is one exception, and it is the whole reason `compensate` scans runs instead of calling
`.replace("\\\\", "\\")`: **a run immediately followed by `"` passes through whole.** That is
what made

```
awk '{ n=gsub(/\\/,"\\"); print n }' f
```

arrive as `gsub(/\/,"\\")` — the first pair halved, the second, sitting against a quote, not.
Runs of 1, 2, 3 and 4 before a `"` were each measured surviving intact; before `'`, before a
letter, and at end of line they halve. A single quote does not protect. So `"` is the whole of
the rule, and the transform is per-run rather than global.

### Why it was worth code rather than a habit

Because it is silent. The command succeeds, the file is written, and the damage surfaces
somewhere else entirely as a path with one backslash where two were meant.

The case that found it, from `C--atelier/15a03ed2` on 2026-08-11: an agent wrote
`new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db")` into a `<<'EOF'` heredoc,
which reached disk as `"\dev…"` and announced itself as `SQLITE_CANTOPEN`. It concluded
*"Heredoc ate the backslash escapes"* and used the Write tool instead. Three more did the same
between then and 2026-08-21 — `C--Users-flori-codes-nova/b9aeac10` ("avoiding the heredoc that
broke earlier"), `C--atelier-caravan/ba9d465d` twice, `C--atelier-caravan/0aa4f322` — and none
of them left a note, because from inside one session it reads as one flaky tool call rather
than as a rule.

Telling agents to avoid it was considered and rejected. The habit would have to be held by
every card, in every repository, forever, against a model's natural tendency to under-escape;
and it would cost context on every spawn to say so. A compensator is checkable and costs
nothing anybody has to remember.

### Where the compensator lives, and why there

**In this binary**, served by `skein.exe --bash-hook` as a stdin→stdout filter, and reached
through the `--settings` layer `supervisor` already passes each card.

- **In the binary rather than a script**, because a `PreToolUse` hook fires on *every* Bash
  call of every card, so its startup cost is a tax on the whole wall — this is ~5ms against
  ~50ms for a Python script and upwards of 200ms for PowerShell 5.1. And because a machine
  that has just downloaded Skein need not also have an interpreter, which is the entire point
  of the fix travelling with the app rather than living in one `~/.claude`.
- **Exec form** (`command` plus `args`), which spawns the executable with no shell in between.
  Not tidiness: the shell form would put an installation path through a shell parser, and a
  path holding a space, a `$` or a quote is precisely the class of bug this module exists to
  compensate for. `args` was verified present in 2.1.233 before being relied on — a build that
  ignored it would run this binary with no arguments, which is to say it would open a second
  Skein for every shell command a card ran.
- **Intercepted at the top of `main`**, before Tauri starts, so a hook invocation never opens
  the store, never creates a window and never joins the wall. Anything added to `main` above
  that check inherits it, once per Bash call, on a hot path.
- **`windows_subsystem = "windows"` does not get in the way.** With no console attached the
  standard handles are whatever the parent redirected, and for a hook that is always a pipe.
  Verified against a release build, not assumed — a GUI-subsystem binary whose `print!` went
  nowhere would fail open and leave the bug in place in exactly the configuration that ships,
  while every debug test passed.

### Cards only, and what that costs

The hook goes in Skein's own settings layer, so **nothing outside Skein is written**. The cost,
accepted deliberately: a `claude` run from a terminal on the same machine still eats
backslashes. Fixing that would mean Skein editing `~/.claude/settings.json`, and this is not an
app that writes to the user's global config — `accounts.rs` goes out of its way to hold none of
it, and a desktop app that quietly edits the config of the CLI it wraps is a worse precedent
than the bug.

If a global hook *is* installed by hand as well, the two do not compound. Measured: with a
compensating hook in both the user's settings and the flag layer, the result was one doubling,
not two — hooks from different sources are each handed the original input, so the last
`updatedInput` wins rather than chaining. Worth knowing because if they *had* chained, every
backslash on such a machine would have quadrupled.

### When to delete this

The day the Bash tool stops halving backslashes, this module starts *adding* them.

`cargo test` exercises `compensate` by round-tripping it through a model of the collapse, so it
proves the inverse is exact — and it cannot see an upstream fix, because the model is a copy of
the bug. Only a live probe can. It is one throwaway session:

```powershell
claude -p "Run this exact Bash command, verbatim: cat > /tmp/bs.txt <<'EOF'
x = `"\\a\\b`"
EOF" --model claude-haiku-4-5-20251001 --dangerously-skip-permissions
```

Two backslashes on each side in `/tmp/bs.txt` is correct with or without the bug, because that
run is against a `"` and protected either way — use a run that is *not* against a quote to tell
them apart. The reproduction harness, including the negative control, is `.scratch/bsprobe`:
with no hook the file came back holding one backslash where two were written, with the layer it
came back holding two.

If the probe shows the collapse is gone, delete `hooks.rs`, the `--settings` call in
`supervisor::spawn`, and the check in `main` — and put `chat`'s allow list back wherever it
then belongs, since `settings()` is now the only thing carrying it.

### The day the deletion condition arrived, sideways

The section above says this module should be deleted the day the Bash tool stops halving
backslashes. What actually happened on 2026-08-25, probed against **claude 2.1.241** with
`tools/probe-deny.ts` and the matrix beside it, is neither deletion nor business as usual, and
both halves are worth carrying:

**1. The hook had already stopped firing, and nothing said so.** It was registered with
`matcher: "Bash"`. On this machine a fresh `claude` calls its Windows shell tool
**`PowerShell`** — the hook payload's `tool_name` is literally that — so the matcher matched
nothing and every hook in this module was a silent no-op. For how long is unknowable: a
matcher that stops matching produces no error, no warning and no missing output. The
compensator did not regress, it simply stopped being consulted.

Measured, one variable at a time:

```text
matcher "Bash"          fired = no
matcher ".*"            fired = yes    tool_name = PowerShell
matcher "" (empty)      fired = yes    tool_name = PowerShell
no matcher at all       fired = yes    tool_name = PowerShell
```

**2. The PowerShell tool has no collapse to compensate.** Emitted and arrived were
byte-identical for runs of 2, 4, 6 and 8 — every backslash survived, which is unsurprising once
said out loud, since PowerShell's escape character is the backtick and a backslash is an
ordinary character to it.

So widening the matcher to `"Bash|PowerShell"` would have been the obvious fix and the wrong
one: it would have doubled every backslash in every PowerShell command, which is exactly the
"starts *adding* them" failure this file's last section warns about, arriving from a direction
nobody was watching. Not the bug being fixed — a *second shell tool that never had it*.

**Both names are live on this one machine at the same moment**, which is what settles the
design. A card Skein spawned is holding a `Bash` tool while a fresh `claude` gets `PowerShell`.
There is no version to branch on and no setting to read.

Hence the shape the module now has:

- **No matcher at all.** The hook is registered against every tool, so it cannot be switched
  off again by a rename. A matcher is a tool name written down a second time, in a place no
  test can reach, and the copy is what rotted.
- **Both questions are answered in `reply`**, where `cargo test` can see them. *Is this a shell
  call?* — does the input carry a `command`, which is how a `Read` or an `Edit` leaves without
  naming any tool. *Does this tool eat backslashes?* — is `tool_name` exactly `Bash`, which is
  a name, but a name in code with an assertion against it.
- The cost is a ~5ms process per tool call rather than per shell call. Paid deliberately: the
  alternative is a guard that is correct and not running.

The general shape, and it reaches past this module: **a filter configured by matching on a
name that something else owns has no way to report that it stopped matching.** Anywhere a
matcher, a glob or a tool name is written into configuration, the failure is silence — so
either put the decision somewhere a test can reach it, or arrange for the broad case to be the
default and narrow inside your own code.

### The second hook: the one git index behind a shared working tree

`hooks.rs` is no longer one hook. The same `PreToolUse` filter now also refuses a `git commit`
that would take another card's staged work with it. See sink 8d3dab75 for the incident, and
`store::foreign_staged` for the evidence it reads.

**The mechanism is the index, not the checkout,** and that distinction is the whole item.
Everything in this repository already says to stage by explicit path — CLAUDE.md's "`git add
-A` is wrong when the tree holds something you did not write". It is not enough. `git add
<paths>` writes into the **repository's one index**, which a sibling card has already staged
its own files into, and `git commit` with no pathspec commits the whole index. The window is
the seconds between a sibling's `add` and its `commit`, and every card in a shared tree is
doing exactly that all day. On 2026-08-24 it produced five commits in 2m14s across three
cards, one carrying another card's `classify.ts`, `conversation.svelte.ts`, `test/classify.test.ts`
and `turns.md` under a message about spawn parentage.

The form that holds is a pathspec on the **commit**:

```bash
git commit -- src/lib/a.ts test/a.test.ts
```

which commits the working-tree content of exactly those paths and leaves the rest of the index
alone.

**What the guard does.** When a card runs a `git commit` naming no pathspec, `sweep` asks git
what is staged and `store::foreign_staged` asks the wall who wrote it. If some staged file was
written in the last day by a *different* card and not by this one, the call is denied with a
message naming the files, naming the card, and giving the command above.

**Why denying is safe.** Because the escape from a wrong answer is the same command as the fix.
If the guard has misjudged and the files really are this card's, naming them on the commit is
still the right way to commit them — so there is nothing to work around, and no reason for the
next agent to reach for `git add -A` to get past it. That property is what made a refusal
acceptable where a warning would not have been: a warning arrives after the damage, since the
whole failure is silent.

**Probed before it was built**, because the design rests on it: a `permissionDecision: "deny"`
from a `PreToolUse` hook **does** stop a tool call on a card spawned with
`--dangerously-skip-permissions`, and the reason string reaches the model. Bypass mode skips
the asking, not the hooks. Had that gone the other way the guard would have had to be a
warning injected as context — a different design, not a different line.

**Where it can be wrong, and which way.** Every one of these ends in a call let *through*,
never in a card that cannot commit:

- `file_touch` records `Edit`, `Write` and `NotebookEdit` only. A sibling that edited a file
  through `sed` in a shell call leaves no touch, so its work is invisible here. This is the
  big one, and it is why the guard is a floor rather than a proof.
- No database, no repository, a git that would not answer, a card with no id in its settings
  layer: all silent.
- A day-old bound on how recent the sibling's write must be, so a file staged from last week's
  work is not attributed to whoever last edited it.

And two ways it can deny when it need not, both of which resolve into the correct command:
a bare trailing pathspec with no `--` is read as no pathspec at all (telling
`git commit -m fix README.md` from `git commit -m fix` needs the full table of which options
take a value, and one wrong row is a guard that lets damage through); and a file two cards have
both edited is credited to neither, so the deny fires only when *this* card never touched it.

**It does not take `index.lock`.** `GIT_OPTIONAL_LOCKS=0` on everything `sweep` runs, because
`diff --cached` will opportunistically refresh and rewrite the index — in a tree whose whole
problem is that several cards are running git in it at once. A guard against a shared index
must not become another writer to it.

### The argv a card's hook is given

`--bash-hook` alone is the compensator and nothing else. `--card <id> --db <path>`, added by
`hooks::settings` from `supervisor::spawn`, is what arms the index guard.

Both are baked into the card's own settings layer rather than worked out per call. The id
could have come from the payload's `session_id`, but that is a database lookup to find out who
is asking before any question has been asked, and `agent_session_id` moves under a card every
time it is resumed — so the lookup has a window in which it answers nothing. The database path
could have been `%APPDATA%\dev.skein.studio\skein.db`, but that string is `tauri.conf.json`'s
to own and CLAUDE.md is explicit about what a second hard-coding of it costs.

The hook opens that database **read-only**, through `store::open_readonly`, which is not
`Store::open`: no `create_dir_all`, no `journal_mode`, and above all no `migrate`. A
short-lived process that ran the ladder would be a second writer racing the wall through the
one path `store.rs` records as having locked the app out of its own database. A reader is a
reader.

### The third hook: what a card has forgotten it started

`hooks.rs` is no longer two hooks on one event. `SessionStart` and `UserPromptSubmit` are
registered as well, and both do one thing: hand a card back the background work Volery
recorded it starting and never saw finish. See sink fb3e537d for the incident and
`.claude/rules/turns.md` for the table it reads.

**The failure, in the words of the agent it happened to.** "I was asked whether I had started
the dev server on localhost:3000. I said no — every command in my visible context was
read-only. It was mine: my own transcript has `pnpm dev` with `run_in_background: true`, three
seconds before the process's start time. The launch happened in an earlier stretch of the
session that had been summarized out of my context." It then spent three other cards' turns
asking who owned the process, and two of them replied with a confidently wrong directory, so
the wrong answer propagated.

The shape it named is general and worth carrying: **a long-lived side effect outlives the
context that records it.** Dev servers, watchers, tunnels, `--watch` runners, tailed logs.

**Volery already held the answer and had never handed it back**, which is the whole of why
this is nine lines of routing rather than a new subsystem. The `job` table is written on the
*receipt* of a background call and the row is deleted when the job reports in, so the rows
outstanding at any moment are — by construction rather than by a query — exactly the
background work whose fate nobody knows. Until now the only reader was `rouse`, telling a card
what its *previous* process had lost.

#### The two occasions, and why not one

Both were measured under Skein's argv before anything was built on them —
`tools/probe-jobs.ts`, 2026-08-27 against claude 2.1.241, and every claim below has its date
there.

- **`SessionStart` with `source: "compact"`** is the precise moment: the context has just been
  rebuilt and the summary did not carry the launch. It does fire in `--print --input-format
  stream-json`, which was not obvious — this is not the TUI and `SessionStart` is documented
  around sessions rather than around folds.
- **`UserPromptSubmit`** is the backstop, and it is the one that would have caught the actual
  incident, because that miss was an *answer to a question*. It fires next to the words being
  answered, which is the highest-salience place anything can be put. It also covers what the
  compaction hook cannot: a context that was never folded but is simply long, and a card
  resumed by a route `rouse` did not take.

`additionalContext` reaches the model from both. Asked for a planted token, the model answered
with one and volunteered that it could see the other, which settles it twice over.

**And the measurement that could have made this worse than the bug.** Skein draws your prompt
the moment you send it and marks the line `pending` until `--replay-user-messages` echoes it
back, matched on the *trimmed text* (`Conversation.#claimEcho`). Had `additionalContext` been
spliced into that echo, no prompt would ever have matched its line again and **every prompt on
the wall would have sat pending forever** — a regression far larger than the miss being fixed,
arriving from a direction nobody would look in. Measured: the echo comes back verbatim. The
general shape, which reaches past this module: **before injecting anything into a stream
something else is already folding, go and look at what the fold sees.**

One thing the same probe settles in passing: `UserPromptSubmit` does **not** fire for a slash
command, so `/compact` itself goes through neither hook.

#### What it is not allowed to claim

A row says a job *started* and was never reported finished. It does not say the job is
running, and the difference is not pedantry: Skein only ever learns a job ended by being told
down the stream, so a completion notification that never arrived leaves a row standing over
work that finished an hour ago. So the wording says **check** and names the stale case out
loud — the same bargain `resumePrompt` strikes, for the same reason. The two states are far
apart and only looking distinguishes them.

The **session scope** is the other half of not over-claiming, and it lives in
`store::outstanding_jobs` rather than here. Only rows this very process wrote, so the thing
making the claim is the thing that made the job. It also keeps this from saying, in a second
voice, what `rouse` already tells a card about a dead session's jobs and then deletes — and it
bounds the one way a false claim could otherwise become permanent, since a resume prompt that
never went would leave rows to be re-announced on every prompt forever, with no way of ever
becoming true.

`pending_jobs` deliberately keeps the wider scope: its caller is `rouse`, whose whole question
is what the *previous* process left behind. Two callers, two questions, one body — `jobs_of`.

#### What it costs, which is nearly nothing

A `~5ms` process per prompt, against the per-tool-call one the compensator already pays, and
prompts are rare against tool calls. Roughly ninety tokens of context, and **only when there
is outstanding work at all** — a card with none is handed nothing, so the model sees nothing.
`SessionStart` on `startup`, `resume` and `clear` says nothing either.

#### And no matcher on either, for the third time in this file

Registered against everything; the routing is a `match` on `hook_event_name` at the top of
`reply`, where `cargo test` can reach it. A payload carrying no event name at all still falls
through to the compensator, which is what a build that does not send the field should get —
the shape check below it (does the input carry a `command`) was the whole discriminator before
this arm existed and still works alone.

`settings` builds the hook entry **once** into a local and names it under three events. Not a
shortcut: it is what makes a fourth event cost one line, and what stops the three drifting
apart in the way the copy of a tool name did.

#### Testing Rust on this machine

`cargo test` does not run here at all — `.claude/rules/build.md` has it: the gnu harness exe
exits `0xC0000139` before a single test runs. What is available is `cargo check`, and the trap
is that **`bash tools/check-gnu.sh` is `cargo check --lib`, which does not look at
`#[cfg(test)]` code.** A clean run there says nothing whatever about a test you have just
written. `bash tools/check-gnu.sh --profile test` does, and costs the same. Everything in this
module's test block has been through that and nothing has been through an actual run.
