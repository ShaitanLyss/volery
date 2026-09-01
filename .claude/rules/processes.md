---
paths:
  - "src-tauri/src/supervisor.rs"
  - "src-tauri/src/servers.rs"
  - "src-tauri/src/perf.rs"
  - "src/lib/Card.svelte"
---

# What a card is holding, and what dies with it

`CLAUDE.md` states the rule this file is the measurement behind: **every spawn goes in a job
object, and the one that did not was the biggest.** `servers.rs`, `bang.rs`, `shell.rs` and
`actions.rs` each learned it; `supervisor.rs` learned it last, in 0.4.0, after 80 descendants
were found under one Skein for 6 cards.

That rule is **holding**. This file says how that was established, what it does *not* cover,
and why the wall now draws a count.

### The orphan hunt, and what the orphans turned out to be

Two sink items (7f011a39, 04f83f09) described the same subsystem from opposite sides —
"things that should die survive" and "things that should survive get killed". 7f011a39
reported **24 `@playwright/mcp` processes, ~1.0 GB of private commit, for 11 Claude sessions,
several dormant 4, 5 and 14 days**, and read that as MCP servers accumulating across days
because nothing reaped them.

Measured 2026-09-01, walking `ParentProcessId` from every candidate up to its root rather
than reading any code:

```text
skein.exe/7200                      started 15:31
claude.exe                          11 of them, ALL under skein/7200
node.exe                            36 of them, ALL under skein/7200
playwright chain, every instance:
  node(mcp) <- cmd <- node(npx) <- cmd <- claude.exe <- skein.exe/7200
```

**Nothing was orphaned. Not one process on the machine was parentless.** Three things follow,
and each corrects a part of the original reading:

- **The 24 were live MCP servers of live cards.** The chain is two `node.exe` per card — an
  `npx` wrapper and the real `cli.js` — so 24 is ~12 cards' worth of correctly-parented,
  correctly-job-held servers, not a day's leak.
- **"Dormant 4, 5 and 14 days" is *card* dormancy, not process age.** No process on the box
  predated skein's launch that afternoon. A card dormant a fortnight is one nobody has
  *spoken to* in a fortnight; `restore.md`'s rousing pass gives it a process back at every
  launch regardless. The processes were spawned in one burst at 15:32 by that pass.
- **A previous Skein cannot leave orphans behind either.** `CreateJobObjectW(None, None)` takes
  default security attributes, so the handle is **not inheritable** — no child holds a copy,
  and `KILL_ON_JOB_CLOSE` therefore fires when skein's own process object goes, hard kill
  included. There is no path by which a card's tree outlives the app.

**So 7f011a39 is not a Volery bug, and the honest settlement is a correction rather than a
fix.** What it did find is real and is the next section.

### The job holds, and it was proved by construction rather than by reading

The doubt worth resolving was narrow: `claude.exe` is assigned to the job, but the MCP server
is four levels down through two `cmd.exe` hops, and job membership is inherited rather than
re-asserted. So the chain was rebuilt with the same shape and the single handle closed:

```text
BEFORE close: 3 alive -> node.exe/25764, cmd.exe/25036, node.exe/14340
AFTER  close: 0 alive
```

Descendants join their parent's job automatically and stay in it; assigning the root is
enough, and `spawn_now` assigns **before it takes stdio off the child**, which is what puts
the tree inside from its first breath. An MCP server spawned between the `CreateProcess` and
the assignment would be outside it for life — the comment there is load-bearing, not decorative.

The escape Windows does offer, `CREATE_BREAKAWAY_FROM_JOB`, requires `JOB_OBJECT_LIMIT_BREAKAWAY_OK`
on the job. `Job::new` does not set it.

### The one real hole: WMI reparents out of the job

There is an escape, it is trivial, and **agents have already found it**. `Win32_Process.Create`
is serviced by `WmiPrvSE.exe`, so the new process is that service's child and never touches
the caller's job at all:

```text
host node/10288 assigned to job
WMI-created pid 28020 -> parent = 5112 (WmiPrvSE.exe)
closing job handle ...
  in-job host node/10288 alive after close : False
  WMI child   node/28020 alive after close : True
```

Card 375a83bb reached for exactly this on 2026-09-01, deliberately, because a "detached"
background logger kept being torn down at 76 seconds. That teardown is **not** the job — the
job only fires when the card closes — it is the Bash tool ending its own children at turn end,
which is Claude Code's behaviour and not Volery's to change.

So both halves of the pair of sink items land outside this app, and the honest statement of
the promise is narrower than `CLAUDE.md`'s one-liner:

> **Children die with the app** — every process a card starts *by ordinary means*. A process
> created through WMI, a scheduled task, or a service is outside the job, and is outside
> `owned_pids` too, which means it is not merely unreaped but **unattributable**: nothing can
> prove it was ours, and `kill_process` will refuse it for exactly that reason.

That is the trade the design makes on purpose (`jobs::Job::pids` argues it at length: job
membership is the only *proof* of ownership, where a parent walk is a guess). Detecting WMI
escapees would mean reintroducing the guess — some heuristic over command lines and start
times — to chase a case an agent has to go out of its way to reach. **The fix for the escape
is not detection, it is removing the reason to reach for it**, and that reason is that a card
has no sanctioned way to start something that outlives its turn. `mcp__skein__server` is the
nearest thing and only starts groups the user has already defined. See the sink item.

### Killing an MCP server silently de-tools a live card

7f011a39 notes "reclaimed by killing them; they do not come back until sessions start", which
undersells it. The six cards roused at 15:32 were measured at **2 processes each and zero
`node.exe`** after that reclaim, against 12 processes and 4 `node.exe` for cards spawned
afterwards. `claude` does not restart a dead stdio server, so those cards were running with
**none of their MCP tools** and nothing anywhere said so.

Worth knowing before reaching for the meter's kill button on anything under a card: it is safe
for a leaked Chromium and it is not safe for a `node.exe` the agent still needs.

### What a card actually costs, which is the finding worth keeping

The cost is not a leak. It is that a card is expensive at rest and the wall spawns one per
dormant card at launch:

```text
11 cards, 66 processes, 9181 MB private commit
  fully equipped card    12 processes   ~1.1 GB      (5 of them)
  card with servers killed 2 processes  ~0.7 GB      (6 of them)
machine: 15.8 GB RAM, 2.0 GB free; commit charge 33.1 of 52.7 GB
```

Rousing is deliberate and `restore.md` argues for it — a wall you must click before it can do
anything is not the trade anybody wants. But the argument was made about *processes* being
cheap, and a `claude.exe` is not one process: it is a dozen, and ~1.1 GB, per card, whether or
not you ever speak to it. On a 15.8 GB machine eleven cards is the machine.

Measure **private commit**, never working set. The single largest consumer on the wall was one
`next dev` at 6.2 GB, which is Nova's dev server and not a card at all.

### The badge, and why it is not a fourth poller

`CLAUDE.md` names exactly three places that go and look, and says anything proposing to be the
fourth owes the same argument. This is not one, and the shape is the one that file recommends:
**when the thing you care about emits nothing, fold an event that already exists near it.**

A card's tree only grows because the agent did something, and `result` is precisely the
announcement that the agent did something. So `#readHolding` is called from `#persistConv`, on
the `result`, beside the title and effort reads that already happen there. An idle wall asks
nothing, because on an idle wall nothing can have changed.

- **The reading is relative, and that is what makes it drawable.** A raw count reads ~11 on
  every card, always — uniformly loud, therefore uniformly ignored. `Conv::fleet` is the tree
  at the end of the card's *first* turn, and the badge is what has joined since. Taken at the
  first turn rather than at spawn because the MCP fleet is still booting when the child is
  inserted; a baseline taken at spawn would count every server the card starts as a leak.
- **`None` is not zero.** A card with no process, or one that has not finished a turn, has no
  baseline — so `leftovers` answers `None` and the badge draws nothing rather than claiming
  the card is holding nothing. The distinction is the same one `crowds` makes about an unread
  journal, and the same one `pending_jobs` makes about a path that is not there: an instrument
  may say "I don't know", and must not say "nothing" instead.
- **Membership comes from the job, so the count is safe to act on.** It is the same list
  `owned_pids` builds and the same list `kill_process` checks against, which means every
  process the badge counts is one the wall is entitled to end.
- **Settling is once and for all.** A second turn must not re-baseline, or the count could only
  ever be zero — which is a badge that is always right and never says anything.
- **The known imprecision is in the safe direction.** A server that boots lazily, after the
  first turn, is counted as excess for the rest of the card's life. It over-reports rather than
  hiding a leak, and one fixed baseline is worth the simplicity.
- **`markExited` clears it**, and here the count really does go with the process: the job takes
  the tree, so a card whose child is gone has no descendants left. Left standing, the badge
  would name processes that no longer exist and point at a meter that cannot find them.

It is drawn at the **foot centre** — the one place left, with `.pin` at the top left, `.post`
at the top right and `.aside` and `.jobs` at the two bottom corners — and that is also the
honest spot for it: not a corner mark about the card, but something underneath it you cannot
otherwise see. Achromatic, because a card may be working, asking or failed while holding these
and colour on this wall means those three.

**It is a different question from `.jobs`, and the pair is the reading.** A job is work the
agent *said* it started, folded off a receipt. This is what the kernel says is *running*.
The incident behind the whole seam lives in the gap: a headed Chromium rendering a WebGL scene
at 60fps after its task was torn down announced nothing, was in no receipt, and read from the
wall as ambient machine load — it was nearly written into an audit report as a finding about
the machine.

### If you are diagnosing this again

Walk the parent chain to the root; do not infer ownership from an image name. A `claude.exe`
this studio did not spawn is somebody's terminal, and `perf.rs`'s `known` map is built on
exactly that distinction.

`tools/probe-processes.ps1` is the instrument that produced every figure above:

```powershell
pwsh tools/probe-processes.ps1           # the census, per card, plus anything unattributed
pwsh tools/probe-processes.ps1 -Reap     # prove KILL_ON_JOB_CLOSE on the real chain shape
pwsh tools/probe-processes.ps1 -Wmi      # prove the WMI escape
```

The census is read-only. The two proofs spawn their own throwaway trees and clean up after
themselves; neither touches anything on the wall. **The `unattributed` section is the one to
read** — on a healthy wall it is empty, and an entry in it is what both sink items were
looking for and did not find.

Two traps met while writing them, both costing a false result rather than an error:

- **`$pid` is read-only in PowerShell.** Assigning it inside a function fails per-iteration
  with `VariableNotWritable` and the loop prints nothing useful.
- **A `.js` test fixture under this repo is an ES module** (`package.json` has
  `"type": "module"`), so a harness using `require` dies before it spawns anything and the
  measurement reads "0 alive" — which looks exactly like a successful reap. Name them `.cjs`.
