---
paths:
  - "src-tauri/src/load.rs"
  - "src-tauri/src/mcphost.rs"
  - "src-tauri/src/pool.rs"
  - "tools/probe-shared-mcp.ts"
  - "tools/probe-mcp-override.ts"
---

# Many cards on one machine

Lyss runs about ten cards at once on a 15.4 GB laptop. On 2026-10-14 the machine was found at
**0.4 GB free and 100% CPU**, and her words were *"we need to make sure this doesn't happen
again by making changes to volery."* This file is what changed, and the measurements each part
stands on. Five parts, in the order of what they save.

What was holding the memory, measured that afternoon (private bytes, read-only census):

```text
next dev (nova's dev server group)        4.4 GB   grows over a session
tsc --noEmit, one card                    2.6 GB   --max-old-space-size=8192
claude.exe, 5-6 live cards                ~0.5 GB each
@playwright/mcp, one per card             ~217 MB each (npx 100 + cmd 11 + node 105)
RISE MCP (bun …/apps/mcp/src/index.ts)    450-550 MB each, one per RISE card
```

The part nobody measures: **every card read the symptom as its own failure.** Under memory
pressure a test runner hangs, prints nothing, or is killed without a word, and from inside one
conversation that is indistinguishable from a broken test. So each card re-ran its gate, which
added load, which made the next card's gate hang. Half of this work is memory; the other half
is telling a card what it is looking at.

## 1. One browser MCP server for the wall (`mcphost.rs`)

Every project card carried its own stdio `npx @playwright/mcp --cdp-endpoint 9222` — all of
them driving the *same* Chrome. Now the wall runs one with `--port 9244`, and each card's
`browser` entry is `{"type":"http","url":"http://127.0.0.1:9244/mcp"}` (`browser::mcp_server`).

**Why a session is a stdio server in everything but process count** — read out of
playwright-core 1.64's `coreBundle.js` (`factory.create`) and then measured
(`tools/probe-shared-mcp.ts`): each HTTP session opens its own `connectOverCDP`, takes
`browser.contexts()[0]` (the default context, so sign-ins stay shared), and builds its own
backend. `--shared-browser-context` would have merged the backends and is deliberately not
passed. The backend — and the CDP connection — is created on a session's first `tools/call`,
never at `initialize`, so an idle card costs nothing. Measured: one server with three sessions,
**110 MB** in total.

**A dead card's session is cleaned up by the server**, which matters because Volery ends a card
with `TerminateProcess` and nobody says goodbye: once a session has a backend the server pings
it every three seconds and closes it on a miss. Measured: a hard-killed `claude` had its
session closed within 15 seconds.

**It also ends the CONNECT_TIMEOUT family** (sinks 36919493, d5c3b54e, ab552a46, 0e31145a,
6f564b5a, c14409db, cb41f229, 2f25b6b7). Each was a card whose `npx` cold start missed the
CLI's thirty-second `initialize` deadline on a loaded machine, after which the CLI never
retries. Connecting to a server that is already listening is a loopback round trip.

Three things the probe found that the source did not say:

- **The MCP route has a host check of its own** that admits only `localhost:<port>` — port
  included — unless told otherwise. A card sending `Host: 127.0.0.1:9244` got a 403. So the
  server is started with `--allowed-hosts 127.0.0.1:9244`: the one host the cards use, and not
  `'*'`, which would let any web page rebind a name to loopback and drive the browser.
- **A 401 or 403 is remembered by server *name*, machine-wide.** The CLI read that 403 as
  "needs auth" and wrote `"browser"` into `~/.claude/mcp-needs-auth-cache.json`; every later
  session on the machine reported `needs-auth` for `browser` **without sending a request**. Had
  it gone unnoticed, every card on the wall would have lost its browser the moment this
  shipped, with nothing pointing at the cause. Two rules follow: **the shared server must
  never answer a card 401 or 403**, and **a probe must never name its server `browser`** (the
  probe's is `probebrowser`). If cards ever report `needs-auth` for `browser`, that file is the
  first place to look.
- **Tab isolation is unchanged, not broken.** Two sessions both drive the browser's first page,
  exactly as N stdio servers did — that is sinks 7af2acb4 and 9e05a3fd, which this neither
  causes nor fixes.

**Lifecycle.** Started at launch in the background (`open_wall`), and `ensure`d — one loopback
connect when it is up, never waited on — at every spawn, on the browser wake route, and when a
card's `system/init` reports `browser` failed. A card that beats a cold start fails to connect
and is sent `mcp_reconnect` when the server lands (`reconnect_stranded`). A server that dies
and is started again sends `mcp_reconnect` to **every** live card, because every session died
with it and nothing guarantees the CLI opens a new one on a 404. Another wall's server on the
port (a lab beside the installed wall) counts as up: it drives the same Chrome on the same
fixed port. A live server that misses one 300 ms probe is given ten seconds before it is called
wedged — killing a healthy one on a saturated machine costs every card its browser for the
length of an `npx` start — and only a server that *replaced* one sends every card back to
reconnect. **The version is pinned** (`@playwright/mcp@0.0.83`, the one probed), where the stdio
entry floated on `@latest`: a stdio server that broke cost the cards it broke, but an HTTP
server that answers a card 401 or 403 is remembered by name machine-wide, so a release that
tightened its host checks would take the browser off every card at once. Moving it is one line
and a re-run of the probe.

## 2. Project stdio servers, shared (`pool.rs`)

A territory's right-click lists the stdio servers in its `.mcp.json`; **share** one and every
card in that territory gets `{"type":"http","url":"http://127.0.0.1:<ask port>/pool/<card>/<name>"}`
under the same name, served by **one** upstream process per (tree, server). Opt-in per server,
by the user (Lyss, 2026-10-14), because whether a server is safe to share — whether it keeps
per-client state — is a fact Volery cannot read off it. RISE's is a stateless API client and
the reason this exists.

**The override is the whole mechanism, and it was probed** (`tools/probe-mcp-override.ts`,
claude 2.1.285): with the same name in `--mcp-config` and `.mcp.json`, init reports
`source: "dynamic"`, the flag's copy starts and **the project's copy never does**.
`disabledMcpjsonServers` in the settings layer changed nothing measurable and is kept as a
backstop, since the failure it guards — a CLI that one day starts both — would put the 500 MB
back on every card with every tool still working.

The multiplexer, which is the whole protocol it speaks:

- **One upstream per (run dir, name)**, started on first request with the entry's command,
  args and env (`${VAR}` and `${VAR:-default}` expanded as the CLI does), in the card's run
  directory, inside a job. A worktree card gets its own: a server run from another checkout
  serves other code. `bun` is an `.exe` and `npx` a `.cmd`; a name `CreateProcess` cannot find
  is retried through `cmd /C`.
- **Initialised once.** Every card's `initialize` is answered from the upstream's cached answer.
- **Ids are renumbered**, so two cards both asking `id: 1` cannot get each other's answers.
- **No lock is held across a call.** Lines go to the server through a writer thread's channel,
  the child is locked for one `try_wait`; calls from several cards interleave on the pipe and
  are told apart by id. Each server has its own slot, locked only while *that* server starts —
  the first cut held one mutex across a whole call and the pool's whole map across a start, so
  one slow server would have stalled every pooled request on the wall and the load census.
- **`initialize` must answer within 20 s**, under the CLI's own 30 s connect deadline, so a
  card is told why rather than abandoning the connect. A card that reports a pooled server
  `failed` anyway is sent `mcp_reconnect` once, 25 s later, when the pool's start has finished
  (`supervisor::note_pooled`).
- **The writer is a thread, not a lock**, and a review found why: the reader answers a
  server's own requests on the same pipe, and with a lock between them a write blocked on a
  full pipe held the lock the reader needed while the server, blocked on its stdout, never
  drained its stdin.
- **A server's own requests are refused, not ignored.** `roots/list`, sampling: there is no one
  client to ask. Silence would hang the server's call for ever; `-32601` is something every
  server must tolerate from a client that declared no such capability.
- **A card's notifications go no further.** `cancelled` names the request by the *card's* id,
  which the upstream never saw — forwarded, it would cancel another card's request that holds
  that number. A cancelled call runs to the end and its answer goes nowhere.
- **Stateless on this side**: no `Mcp-Session-Id`, plain JSON answers, `405` to a `GET`.

**Where the choice lives** is `<app data>/mcp-pool.json`, root → names, not a table: it is a
handful of names, read at spawn and written by one gesture, and a schema rung is the one change
this app has learned to be expensive about. A choice takes effect at each card's next spawn —
a live card's MCP servers were settled when it started. **And the pool does not ask again
on each request**: the card has the URL because it was shared at spawn, and re-checking turned
an unshare into a card whose own copy is switched off and whose pooled one refuses it. An
unshared upstream is left running for the cards still using it, until the app exits.

`npx`-style servers are started through `cmd /S /C "…"` with every word quoted, so a URL with
a query string stays one argument; `%VAR%` is the one thing cmd still expands inside quotes.
`${VAR}` is expanded from Volery's own environment, so a server that needs a credential a card
was *lent* (`lend.rs`) should not be shared.

**Not measured live**: no RISE card has been driven through the pool on a real wall yet,
because this machine cannot build the app (no MSVC). The override, the protocol and the probe's
real-`claude` connection are measured; the end-to-end path through `ask.rs` is typechecked.

## 3. The reaper ends what nobody is waiting on, and only that (`perf.rs`)

The sweep used to end anything in a card's job whose parent was absent. Under **Git Bash**
(MSYS emulates `fork`) a process's Windows parent exits within a second of the child starting,
so a card's `npx vitest run` or `sh run.sh &` was "parentless" from birth and was killed 60–120 s
later with its whole tree — the log stopped mid-line and the shell reported exit 0 (sinks
e9c80389, 968a4c6b). `judge` is now two rules, pure and tested:

- **Both rules apply to heavy checks only** (`load::heavy_argv`), and each card's own
  `claude.exe` is never judged at all. A review caught two ways the first cut could end wanted
  work: the orphan rule reached a dev server a card started with `Start-Process` from a `pwsh`
  that then exited, mid-turn; and argv was classified by joining it into a line and splitting
  on `&&` — so a card whose standing instructions said `bun run check && bun run test` would
  have read as a leftover test run, and the reaper would have ended the card. A process runs
  one program, so its argv is read as one command.
- **Orphan** — the parent was *seen* alive at an earlier sweep (keyed pid + start time, since
  pids are reused) and is gone now. A process that never had a live parent in sight did not
  lose one; its card's job still takes it when the card goes.
- **Leftover** — a heavy check (`load::heavy`) at least two minutes old, on a card with **no
  turn open and no outstanding `job` row**, not itself under a heavy parent of the same card.
  A foreground call blocks its turn, so a `tsc` still running once the turn is over is one whose
  shell the CLI gave up on. A child under a heavy run of the same card, through any number of
  shells, is part of that run and is not judged separately. Watch modes, dev servers and
  scripts named `*:watch`, `*-server`, `dev`, `serve` are not heavy.
- **A card's outstanding `job` rows are read for its current session only**, the scope
  `outstanding_jobs` uses — a row from a session it has left is news for `rouse`, not work.
- **A card with background work outstanding spares everything in it**, which also closes the old
  sweep's "honest caveat" — a backgrounded call whose shell exited while the work went on.

**Every reap is said.** `perf:reaped` had been emitted since the sweep existed and **nothing ever
listened**: every automatic reap was silent. The card now gets a line naming the command, the
memory and the rule (`perf.ts::reapedNote`), and a leftover — or anything over 200 MB — gets a
chronicle row.

## 4. Telling a card the machine is saturated (`load.rs`, `hooks.rs`)

**Sampled on the reaper's tick**, so it is not a fourth poller: CPU has no event, memory's only
event fires at Windows' own threshold far below where test runners start dying, and the reaper
already wakes once a minute. Saturated is **RAM ≥ 90%**, or **CPU ≥ 90% for two consecutive
minutes** (Lyss's numbers).

- **The hook**, before a heavy command and only while saturated, asks the wall
  (`POST /load/note/<card>`) and adds `additionalContext` naming what is already running on
  which card and how long, and saying a hang is load, not code. Composed beside the Bash
  backslash `updatedInput` in one `hookSpecificOutput`. Fails open and silent, with a 5 s budget.
  Saying nothing while the machine has room is what keeps it from becoming a line agents skim.
- **`mcp__skein__load`**, deferred (the loaded tier is full) with a hint written as symptoms —
  "tests hang", "tsc killed". Heavy checks running now, memory by card / dev server group /
  shared server / Volery itself, and the heaviest things that are *not* this wall's (a Claude
  desktop app's own servers, a terminal), shown so a card can say what is using the machine —
  not so it can end them.
- **Advisory only**, chosen over a wall-wide queue of heavy gates. The census is what a queue
  would read if notes prove not enough.

`heavy` is a different question from `gates.ts`'s and deliberately a second recogniser: that one
decides what a gate *is* for the front end's fold; this decides whether a command will take
gigabytes, from a hook process and from the process table, where the front end cannot reach.
It names programs rather than guessing from words, and watch modes are not heavy.

## 5. Dev servers say when they have grown (`servers.rs`)

`servers` reports each running group's private memory, and past 3 GB a sentence: a restart
gives most of it back, other cards may be checking against it, so tell the user and let them
choose the moment. It never restarts anything itself.

## Measured, and how to measure again

```powershell
bun tools/probe-shared-mcp.ts      # one HTTP @playwright/mcp, two sessions, one real claude
bun tools/probe-mcp-override.ts    # .mcp.json vs --mcp-config vs disabledMcpjsonServers
bun tools/lift-load.ts             # the pure halves of load.rs, perf::judge and pool.rs,
                                   # run for real on a machine with no MSVC (18 assertions)
```

Not covered by anything here: the Claude **desktop** app's own RISE backends (~1 GB, two of
them, seen in the census) are not this app's to start or stop, and the census names them so a
card can say so.
