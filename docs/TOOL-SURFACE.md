# Three decisions about the tools the wall hands its cards

Design work for sink `d3a1921a`, `14f2543e` and `94371889`, done 2026-09-03 by card
`620ed29e`. **Nothing here is built.** Each item is a new or changed capability that every
card on the wall would get, the choice between shapes is not one this file gets to make, and
the question was put to the user twice and went unanswered — so the shapes and their costs are
written down here rather than lost with the card that worked them out.

The pattern is `.claude/rules/ask.md`'s *"Not built: `flag`, and the decision it is waiting
on"*, one level up: three decisions, one file, and a recommendation on each that is a
recommendation and not a default.

Two items in the same brief **were** built and are not here: `b6a278c1` (a tool call that
swallowed one of its own arguments) in commit `29eaf1a`, and `51863e1e` (a preview built by
its `js` renders blank) in `033a268`. Both were bugs with one right answer. These three are
not.

---

## 1. A deferred tool is invisible to an agent that already has a habit

**Sink `d3a1921a`.** An agent opening a PR on an Azure DevOps repo went straight to
`az repos pr create`, it failed with `VS800075`, and it hand-built a
`pullrequestcreate?sourceRef=…` URL for the user to click — while `mcp__skein__pull_request`
existed and its description *opens by saying to use it instead of `az repos pr create`, and
gives the reason*.

### Why it was missed, which is the part that decides the fix

It was in the deferred-tools system reminder as a bare name among ~70 others.
`formatDeferredToolLine` is `function iFa(e){ return e.name }` — no description, no
parameters, ~25 bytes. `pull_request` sitting next to `pinned`, `records`, `reviews`, `take`
and `touched` reads as part of a review/records cluster.

And `ToolSearch` was never called, because **there was no question**. There was a task the
agent already believed it knew the tool for. That is the whole shape of it:

> A deferred tool is invisible to an agent that has an existing habit for the job.

`ask.md`'s tiering section had already reached the neighbouring conclusion and it is worth
quoting, because it rules out the obvious answer: *"a description is only read by an agent
that has thought to look for a tool… Nothing in a schema reaches a reflex and nothing in
`ToolSearch` reaches one either, because the failure is not searching at all."* The three
tools loaded on that argument — `pin`, `wake_me`, `allowance` — are loaded precisely because
they replace something an agent does wrongly *by default*. `pull_request` is no less
reflex-shaped than those. It is arguably more so, since the reflex it replaces is a shell
command an agent has run a thousand times.

### What is available to build with

- **`hooks.rs` can deny with a reason, and the reason reaches the model.** Probed 2026-08-25
  against claude 2.1.241: a `permissionDecision: "deny"` from a `PreToolUse` hook stops a tool
  call *even on a card spawned with `--dangerously-skip-permissions`* — bypass mode skips the
  asking, not the hooks. `sweep` and `perilous` are already exactly this shape.
- **It cannot warn without denying.** Sink `00195b71` is open on that question: whether an
  `allow` decision's `permissionDecisionReason` reaches the model has never been probed, and
  `hooks.rs` documents `deny(reason)` as the only measured lever. So "let it through and say
  something" is not a shape that can be costed yet.
- **The loaded tier has no room.** 22 tools, 38,598 bytes on every spawn of every card, 1,402
  bytes under the ceiling `the_loaded_tier_is_what_every_turn_pays_for` asserts. Promotion
  means eviction, and the test was authored with the instruction that tripping it is a
  conversation rather than a bump.
- **`append_prompt` is short *because of* the loaded tier**, and both comments say so from
  both ends. Bytes taken off the roster may have to be paid back there, in a copy that can
  drift out of step with the schema.

### The shapes

| | shape | cost |
|---|---|---|
| **A** | **Deny the habit at `PreToolUse`.** A table: `az repos pr create` / `gh pr create` → `mcp__skein__pull_request`, `az pipelines runs list` → `mcp__skein__pipelines`. The reason names the tool and says why. | A table to keep current, and a wrong entry is obstructive rather than merely useless. Bounded by matching the specific verb form (`az repos pr create`, not `az repos`). |
| **B** | **A + one line in `append_prompt`** naming the pairs. | Most reliable. Pays for the sentence on every turn of every card, and the prose is a second copy that can drift. |
| **C** | **`append_prompt` only.** | Cheap in bytes, over-triggers nothing. But a line read at turn 1 is not a nudge at the moment of the reflex, which is the failure. |
| **D** | **Promote the forge tools into the loaded tier.** | Does not fit without an eviction, and by `ask.md`'s own conclusion does not reach a reflex. |

**Recommended: A.** The nudge has to arrive when the habit fires, and `PreToolUse` is the only
channel that does. It is also the *only* one of the four that is self-correcting: `az repos pr
create` genuinely fails on this machine (the `az` login is
`ca.lyss.delprat@ltrp.onmicrosoft.com`, which cannot see the NOVA project), so the deny is
replacing a call that was going to fail anyway — the guard costs the agent nothing it was
going to get.

**The general rule worth extracting either way:** a capability an agent cannot see is
indistinguishable from one it declined to use — `ask.md` already says that — and *a capability
an agent has a habit against is indistinguishable from one that does not exist*. The second is
strictly harder, because the first is fixed by making the tool visible and the second is not.

---

## 2. A safe-delete tool, and a correction to the premise

**Sink `14f2543e`** (correction filed as `c7c9b449`). The item asks for
`mcp__skein__remove({ paths, reason })` to replace an `rm -rf` denial that "fails in both
directions at once": it blocked a safe, approved clear of a corrupt `.next/`, and it was
trivially worked around with `mv .next .next-stale-audit-backup`, which had the same effect
while being less legible and leaving junk on disk.

### The correction, and it moves the decision

**The denial is not Volery's.** There is no `rm` guard anywhere in this codebase — `hooks.rs`
denies a `git commit` that would sweep a sibling's staged work (`sweep`) and tree-wide git
(`perilous`), and nothing else. What denied it is the user's own global config:

```jsonc
// ~/.claude/settings.json:14
"deny": ["Bash(rm -rf:*)", "Bash(git push --force:*)", "Bash(git reset --hard:*)"]
```

Two consequences:

1. **Volery cannot widen or narrow it.** The `--settings` layer `supervisor` passes merges
   *over* the user's settings, but a deny wins over an allow across layers. "Replace the
   blanket permission" is not a move Volery has. Neither is closing the `mv` hole — the hole is
   in that one regex and the regex is not ours.
2. **An MCP tool is the only route Volery has, and it works for a reason worth stating:**
   `mcp__skein__remove` is not the `Bash` tool, so `Bash(rm -rf:*)` never matches it. That is
   the entire mechanism. It is worth being honest that this is a *bypass of the user's own
   guard*, offered on the argument that the guard is too blunt — which is a thing to be given
   permission for rather than to build and mention afterwards.

So the smallest fix available is the user editing one line of their own file, and that is not
an edit Volery or an agent should make unasked.

### The shapes

| | shape | cost |
|---|---|---|
| **A** | **`remove` with a self-serve tier.** Regenerable build output on the card's word; everything else parks for a click. | Most machinery, and the tier is a promise about what is genuinely regenerable. Fixes both directions of the failure. |
| **B** | **`remove` where everything parks.** No self-serve tier. | The worth is legibility, the shared-tree check, and nothing left on disk — not speed. Every `.next/` costs a click. |
| **C** | **Narrow the user's own deny rule.** | Zero code. Smallest thing that removes the friction, and it is the user's file to change. |
| **D** | **Leave it.** | The `mv` workaround works; the cost is one untidy directory and a less legible transcript. |

### The classification, which is the interesting half

Whatever is built, the tiers are the same and only the self-serve line moves:

1. **Regenerable build output** — `.next/`, `dist/`, `build/`, `target/`, `.turbo/`,
   `.svelte-kit/`, `.vite/`, `coverage/`, `__pycache__`, `.pytest_cache/`, `node_modules/`.
   Reproducible by a documented command; losing one costs time, not work.
2. **Ignored but not regenerable** — anything else `.gitignore` matches: `.env`,
   `.scratch-*/`, local databases, logs. Gitignore protects these *because* they are
   unrecoverable, which is the opposite of tier 1 despite both being invisible to git.
3. **Tracked and clean** — recoverable; the reason can name the commit it comes back from.
4. **Tracked and dirty, or untracked and unignored** — the only truly unrecoverable case, and
   in a shared working tree the dirty half may be **another card's in-flight work**, which is
   the same hazard `perilous` and `sweep` already guard from the git side. Sink `8404a6ca` is
   the live evidence that naming paths is not sufficient protection in a shared tree.

Refused outright at every setting, and this list is not a tier: a `.git/` directory, a repo
root, a drive root, a home directory, and anything above the calling card's own `cwd`.

**Recommended: A with tier 1 self-serve only**, on the argument that "regenerable" is the one
claim a machine can actually check — there is a build command, and running it restores the
state. Tier 2 is where an agent's judgement is worst, because `.env` and `.next/` are both
"invisible to git" and one of them is irreplaceable. Tier 3 would let a card quietly delete
source you would have to *notice* was gone, which is a different and worse failure than being
asked one time too many.

**The `.scratch-<handle>/` variant is worth considering** as a fifth answer: tier 1 plus a
card's own scratch directory, which is the one ignored thing it demonstrably owns. It is also
the one place the sweeping hazard has already cost a rebuilt measurement harness (sink
`f1e1a8a2`), so a card being able to clean up after *itself* there and nowhere else has a
shape the rest of this table does not.

---

## 3. No sanctioned way to start a process that outlives a turn

**Sink `94371889`.** The measurement is done and is in `.claude/rules/processes.md`:

```text
host node/10288 assigned to job
WMI-created pid 28020 -> parent = 5112 (WmiPrvSE.exe)
closing job handle ...
  in-job host node/10288 alive after close : False
  WMI child   node/28020 alive after close : True
```

`Win32_Process.Create` is serviced by `WmiPrvSE.exe`, so the new process is that service's
child and never touches the caller's job at all. It is therefore outside the job **and**
outside `Supervisor::owned_pids` — **unattributable, not merely unreaped.** `perf.rs`'s
`kill_process` refuses any pid the wall cannot prove it owns, and `jobs::Job::pids` argues at
length that job membership is the only proof available, where a parent walk is a guess. So a
WMI-escaped process cannot be listed as a card's, cannot be killed from the meter, and cannot
be counted by the holding badge.

Card `375a83bb` reached for it deliberately on 2026-09-01, because a "detached" background
logger kept dying after 76 seconds. **That teardown is not the job** — the job only fires when
the card closes. It is the Bash tool ending its own children at turn end, which is Claude
Code's behaviour and not Volery's to change.

`processes.md` already states the conclusion and it is the reason this item exists:

> The fix for the escape is not detection, it is removing the reason to reach for it — and
> that reason is that a card has no sanctioned way to start something that outlives its turn.

`mcp__skein__server` is the nearest thing and only starts groups the **user** has already
defined (`servers.rs`'s `do_server`, keyed on a `group` label or id).

### What already exists, which is nearly all of it

`servers.rs` has the job object with `KILL_ON_JOB_CLOSE`, a 2000-line log ring per group, ANSI
stripped for a model and kept for the wall, the Servers widget, a kill path, and attribution
to a card. What is missing is a way to start something the user did not define.

### The shapes

| | shape | cost |
|---|---|---|
| **A** | **An ad-hoc command on `server`, plus a deny on the WMI escape whose reason names it.** | Reuses everything. Shows in the Servers widget under the card's name, dies with the app, killable from the meter. Grants every card the ability to start a process that outlives its turn — which is the thing the current design withholds on purpose. |
| **B** | **A separate, bounded `background` tool.** Dies at a deadline the caller sets, or at card close. No permanent services on a card's own authority. | Closer to what agents actually want — a logger for the length of a measurement, not a service. A second subsystem beside `servers.rs`, and a deadline is a thing to get wrong. |
| **C** | **Deny the escape only.** `Win32_Process.Create`, `schtasks`, `New-Service`, with a reason that says the Bash tool tears down at turn end and names what to use instead. | Cheapest, adds no capability. Leaves the card stuck — which is precisely the complaint item 2 above is about, one subsystem over. A guard that is obstructive *and* bypassable is the worst of the three, and denying WMI does not close the other escapes. |
| **D** | **Leave it.** | The rule already records the hole honestly, and it is an escape an agent has to go out of its way to reach. |

**Recommended: A, with C's deny riding along.** The two halves answer different failures and
neither is sufficient: the deny alone leaves the need unmet, and the capability alone leaves
the escape silent for an agent that never learns the capability exists — which is item 1 of
this file, arriving for the third time. The deny's reason is what makes the capability
discoverable at the moment of the reflex, and that is the only place discoverability has ever
worked here.

**The one thing to decide before building A** is whether an ad-hoc start needs the user's
click. `pull_request` parks because it reaches outside this machine and cannot be taken back.
A long-lived process is inside the machine, is attributable, dies with the app, and is
killable from the meter — so on the existing arguments it does not need to park. Worth saying
out loud rather than inferring, because "the user's machine" is the phrase `server_schema`'s
own description leads with.

---

## Why this file exists rather than the code

The question was put to the user as one `ask_user` sheet of four decisions, twice — once
answered *"ask again in 5mins, i'm busy"*, once timed out at ten minutes. Building any of
these on the unanswered default would be:

- **item 1**: a new denial every card on the wall is subject to,
- **item 2**: a deliberate bypass of a guard in the user's own config file,
- **item 3**: a capability the current design withholds on purpose,

and none of the three is the kind of thing to do and mention afterwards. The design was in
scope and is done; the gate is the user's.

**Sink bodies are clipped at 1,200 characters** (`sink.rs:87`, filed as `7b26058e`), which is
why the three items above all end mid-sentence in the pile and why this is a file rather than
three more voices on them.
