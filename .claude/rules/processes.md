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

The cost is not a leak. It is that a card is expensive at rest, and the wall used to spawn one
per dormant card at launch:

```text
11 cards, 66 processes, 9181 MB private commit
  fully equipped card    12 processes   ~1.1 GB      (5 of them)
  card with servers killed 2 processes  ~0.7 GB      (6 of them)
machine: 15.8 GB RAM, 2.0 GB free; commit charge 33.1 of 52.7 GB
```

Rousing was deliberate and `restore.md` argued for it — a wall you must click before it can do
anything is not the trade anybody wants. But that argument was made about *processes* being
cheap, and a `claude.exe` is not one process: it is a dozen, and ~1.1 GB, per card, whether or
not you ever speak to it. On a 15.8 GB machine eleven cards is the machine.

**This measurement is what narrowed the pass**, and the way it was narrowed is the part worth
carrying rather than the numbers. The queue was not made lazier; it was made to wake only the
cards it was already going to *speak* to — `interrupted`, or a row in `job` — which was a gate
that already existed one step further down. Every other card is woken by the gesture that
wants it, and that gesture turned out to be a keystroke rather than a send: `Skein.stir` off
the dock's `oninput`, so the spawn happens while you finish the sentence. See `restore.md`.

The general shape, for the next thing that wants to do work on the wall's behalf: **the cost
that gets away with being unbudgeted is the one paid on behalf of a person who has not
arrived.** The fix is rarely to stop doing the thing — it is to find the event that proves
they have.

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

### What the sweep may end, and what the wall shares instead

Two things changed on 2026-10-14 and both are in `.claude/rules/load.md`. **The sweep stopped
killing Git Bash work**: "parent absent" became "parent seen alive, now gone", because an MSYS
child's Windows parent exits within a second of its birth and the old rule ended `npx vitest`
runs mid-suite. And **a card is fewer processes**: its `browser` is a session on one wall-wide
`@playwright/mcp` (`mcphost.rs`) rather than three processes of its own, and a project stdio
server the user chose to share (`pool.rs`) is one process per territory rather than one per
card. The ~1.1 GB "fully equipped card" above was measured before either.

### A card at rest, re-taken 2026-10-14 — and the reaper that already answered it

Lyss asked whether half a gigabyte per awake card was the right design, against the Agent
SDK's own model, where a subprocess is per *turn* and an idle session costs nothing. A card
was briefed to measure it and then build a sleep for idle cards. **The sleep had already
shipped a month before** (969b6d2, 2026-09-13, `reaping.ts`). Neither this file nor
`restore.md` mentioned it, and both argue at length about exactly what it answers. A
behaviour with no rule is one the next person re-derives or rebuilds, so the gap is the
finding. The section below is the measurement, and `restore.md` has the mechanism.

Installed 0.53.1, claude 2.1.288, seven live cards on a 32 GB machine with 21 GB free. Read
from the process table every 20 seconds for 30 minutes, private commit with private working
set in brackets:

```text
per card, at rest
  claude.exe                    560–718 MB avg by card (150–278)   range 479–781
  user-scope `playwright` MCP   ~152 MB  cmd 5 + node(npx) 77 + cmd 5 + node(cli.js) 65
  conhost x2                    ~3 MB
  `browser`                     0 — a session on the wall's one server (~162 MB for all of it)
  `skein`                       0 — HTTP, answered inside Volery
  ------------------------------------------------------------------------------
  a card at rest                ~710–880 MB, 7 processes; ~0.3 GB of it resident
mid-turn                        claude.exe +16–80 MB over its own rest, peak 859 MB,
                                plus whatever the turn runs (one card's tree read 3 GB under cargo)
```

- **Mid-turn barely differs from at rest.** The CLI does not give its heap back after a turn,
  so an idle card costs ~95% of a working one. The one card on the wall that took no turn in
  30 minutes held 572 MB.
- **What the pooling won**: from the 2026-08-19 figure of 12 processes and ~1.1 GB per card to
  7 processes and ~0.8 GB. The per-card `npx` stdio `browser` (~217 MB, three processes) is
  gone. What is left of "18 node for 6 cards" is two per card, and both are the **user's**
  `playwright` entry in `~/.claude.json`, which is `--isolated --storage-state …wall.json` on
  purpose (`browser.md`'s two-browser table). `pool.rs` shares a *project's* `.mcp.json`
  server, and this one is neither the project's nor stateless, so it stays per card. It
  costs ~150 MB idle, and the ~580 MB in `browser.md` applies only once it has launched a
  Chrome. The other two node on the wall were the shared browser server and the dev server
  groups.
- **Idle cost does not grow with the session.** Across the live cards, 224k to 787k tokens of
  context and 1.5 to 14.8 MB of transcript, there is no trend. The card at 787k after a
  compaction was second-lowest. What does grow is a few dozen MB of heap over a long
  session's turns. `tools/probe-sleep.ts` resumed copies of real transcripts and read the
  process after the session had loaded:

```text
                                spawn → init     claude.exe at rest
fresh, no MCP                   3.6 / 4.3 s      541 / 548 MB
fresh, a card's MCP             6.0 / 4.9 s      557 / 557 MB    (tree 754)
resume  1.0 MB /  151k tokens   6.6 / 6.0 s      586 / 581 MB
resume  3.0 MB /  226k          6.0 / 7.0 s      578 / 588 MB
resume  7.2 MB /  871k          6.1 / 6.2 s      541 / 571 MB
resume 14.2 MB /  626k          5.0 / 5.1 s      607 / 587 MB
real turn, Haiku                first token 5.6 s from a cold spawn, 0.64 s from a warm process
```

  So a card at 80% does not cost twice one at 10%, and the brief's worst case does not hold:
  the cards most worth sleeping are not the most expensive to wake.
- **A wake costs five to seven seconds, flat in session length.** It is process start plus
  the stdio MCP servers' `initialize`, which `init` waits for, and the transcript read is lost
  in the noise. The known ~12 s per-turn-spawn overhead reported against the SDK measures
  4–7 s here. One cold run on a loaded machine took 10.4 s. `Skein.stir` starts the spawn on
  the first keystroke, so a sentence that takes longer than that to type never shows it.
- **And a wake costs no tokens at any wait.** This was the question that could have inverted
  the policy. If a resumed process sent a different prefix, every wake inside the cache's
  life would rewrite the whole context at cache-write prices. The CLI writes **one-hour**
  cache only: 32.1M `ephemeral_1h` tokens and no 5-minute ones on the orchestrator's
  transcript. Two real Haiku turns per arm, each session's first message unique so only its
  own cache entry could serve it:

```text
warm, one process       turn 2: read 64,611   wrote 161
turn, kill, --resume    turn 2: read 64,613   wrote 495
same, git status changed in between: read 64,613, wrote 208
```

  So a resumed process reads the whole conversation back out of the cache exactly as the live
  one would have. A card idle past the hour is cold whether its process lived or not, and
  inside the hour it is warm either way. Sleeping is free in tokens, and the only things it
  spends are the seconds above.

**What that makes the policy.** The reaper's shape was right and these numbers do not ask it
to move. An idle card holds ~0.75 GB to save ~6 s. On a machine with room, the three-hour
default (chosen with Lyss, "well clear of a lunch") is a comfort setting rather than an
economic one. Under pressure, the ramp already brings it down to the 15-minute floor, and the
cache result means that floor costs nothing beyond the spawn. That last point was never shown
before. The one gap the measurement turned up was in what `keptFrom` protects, not in the
wait. `CronCreate` and `ScheduleWakeup` keep their prompt only in the process, so a card
holding one was reapable and its schedule would silently cease to exist. The `scheduled` arm
closes that. The other change was Lyss's own decision on the same numbers: a card **set
aside** now sleeps at once rather than never, since what it was protected against turned out
to cost nothing. `restore.md` has the rest of the mechanism.

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
themselves; neither touches anything on the wall.

What a card costs to keep and to wake is `tools/probe-sleep.ts`:

```powershell
bun tools/probe-sleep.ts          # spawn → init and memory at rest: fresh, and --resume of
                                  # four real transcripts COPIED under new ids. No API turn —
                                  # it sends `/cost`, which the CLI answers locally
bun tools/probe-sleep.ts real     # + a cold and a warm Haiku turn, for first-token latency
bun tools/probe-sleep.ts cache    # whether a resumed process still hits the prompt cache.
                                  # Six Haiku turns, in a throwaway git repo of its own
bun tools/probe-sleep.ts timers   # what CronCreate / ScheduleWakeup look like on the wire
                                  # and that they fire in a --print card. Two minutes
```

It copies rather than resumes a real session in place, because the CLI finds a session by id
beyond its cwd's directory (`probe-migrate.ts`). A probe that reused the id could append to a
live card's transcript. **The `unattributed` section is the one to
read** — on a healthy wall it is empty, and an entry in it is what both sink items were
looking for and did not find.

Two traps met while writing them, both costing a false result rather than an error:

- **`$pid` is read-only in PowerShell.** Assigning it inside a function fails per-iteration
  with `VariableNotWritable` and the loop prints nothing useful.
- **A `.js` test fixture under this repo is an ES module** (`package.json` has
  `"type": "module"`), so a harness using `require` dies before it spawns anything and the
  measurement reads "0 alive" — which looks exactly like a successful reap. Name them `.cjs`.
