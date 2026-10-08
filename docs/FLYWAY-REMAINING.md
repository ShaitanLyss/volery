# The flyway: what is built, and what is left

Written 2026-10-08 by card `34b07397`, which built the layers below and is about
to be compacted. This is the handover: what exists, what it cost to learn, and
the four pieces still owed against the design we set out with.

**The goal, in Lyss's words:** *"I can spawn cards on both laptops and control
them from my work laptop."* One dashboard, several machines, one computer per
card.

---

## What is built and proven

Everything under `src-tauri/src/flyway/`, bottom to top:

| file | what it is |
|---|---|
| `seal.rs` | the key, the rooms it names, sealed frames. 13 tests. |
| `key.rs` | the key's home in the credential vault; the invite; `host_name`. |
| `sync.rs` | how two piles converge. Events not rows. 15 tests. |
| `session.rs` | what two walls say, as a state machine with **no IO**. 8 tests. |
| `fleet.rs` | the roster, and asking a wall to open a card. 22 tests. |
| `wire.rs` | iroh. QUIC, dial by public key, relay fallback. |
| `link.rs` | the thing that runs: answers dials, makes them, on a timer. |
| `sinksync.rs` (in `src-tauri/src/`) | the sink's events over real rows. Schema v45. |

**Proven end to end, app to app, on 2026-10-08.** Two separate Volery processes
with separate databases, found each other by key alone, and **257 events / 173
sink items crossed**. Then a finding dropped on one arrived on the other **0s
after the second wall came up**. That is not a unit test — it is two running
apps. `cargo run --example flyway-link` is the library-level proof; the app-level
one was done by hand with `VOLERY_FLYWAY_HOST=lab bun run lab` against the real
installed wall.

### Three things it cost to learn, which are easy to undo by accident

1. **`CaTlsConfig::system()` in `wire.rs` is what makes this work from an
   office.** The default verifies against bundled Mozilla roots — the client
   that passes on every network it is tested on and fails on the one with a
   TLS-intercepting gateway. Do not "simplify" it.
2. **`sinksync::emit` stamps events with `host_name()`, which is a fact about
   the process.** Two walls in one process collide on sequence numbers and the
   connection carries nothing while looking perfectly healthy. `VOLERY_FLYWAY_HOST`
   exists for exactly this and is the only way to test two walls on one machine.
3. **A statement that arrives before the drop it is about must be held, not
   dropped.** Hosts have no ordering between them. `sync.rs`'s `pending` is that,
   and `events_in_any_order_agree` is the test that caught it.

---

## What was left, and is now done (2026-10-08, cards c86101fa and a2a4468e)

### 1. `fleet.rs` is in the envelope, and the sink travels both ways

`frame.rs` is the envelope: an untagged union of the sink's, the fleet's and
the cards' vocabularies, so a bare v1 sink frame is still a frame. The ALPN is
`volery/flyway/2`; a wall still answers v1 and dials it when a peer refuses 2
(`error 120: peer doesn't support any known protocol`, read by
`wire::refused_protocol`), which is what keeps an installed 0.42 wall syncing.
A frame naming a `msg` this build has no word for is skipped, not fatal, so the
next vocabulary needs no ALPN bump.

**The cadence decision**, argued at the top of `link.rs`: one tick at 30s
(`ANNOUNCE_EVERY_MS` — the roster's period, which the sink now shares), and
everything somebody is waiting for **pushed** at once as a one-shot exchange —
an ask to its addressee, an answer to its asker, a prompt, a changed cards
snapshot (≤1/s). No held connection. The old "nobody pushes" paragraph was true
of sink events and was generalised to the whole protocol; it is corrected in
place.

**The sink was one-directional, and nobody had noticed.** The wall that starts
a flyway has its own name in its invite and dialled nobody; the joiner's
`Hello` carried a watermark and no events. So nothing a joiner said ever
reached the wall that invited it — the "257 events crossed" proof covered one
direction. Fixed twice over: the dial set is now the invite's host (a *seed*)
∪ every host on the roster ∪ every host that has dialled in, and every pull is
followed by a push of whatever the answer's watermark shows the other wall
lacks. **Proved app-to-app against the installed 0.42 wall**, read straight out
of both SQLite files: a finding dropped on the lab reached the installed wall
(`events by host: …, lab=1`), one dropped on the installed wall before the lab
started arrived on it cold, and one dropped after the walls met arrived live.

`Fleet::version()` and the cards version are persisted (`flyway_setting`,
schema **v47**, with `flyway_birth`). `#![allow(dead_code)]` is off `flyway/`
and `sinksync.rs`.

### 2. Remote spawn is real

`mcp__skein__spawn` takes `host`. `spawn::elsewhere` refuses on this side
everything about a card that can be refused here — empty brief, bad model or
effort, a chat card, `account` with `host` (accounts are per machine; the wire
carries work, never secrets) — and resolves `project` against the territories
*that* wall announced. The call parks (`ask::park_for_answer`, keep-alives over
SSE) until the answer comes, or tells the card it will be told later by a wall
message and **not to ask again**.

The far wall decides against its live facts (`Fleet::decide`: the switch, the
territory, its own bounds), resolves the root from **its own** table
(`here::root_for` — never a path the asker wrote; a name two of its projects
share is refused with the reason), writes `flyway_birth` *before* the emit,
puts a chronicle row up naming the asking wall, and opens the card through
`Skein.openSpawned` → `#openIn`. The card's system prompt says who asked, from
which machine, and that nothing on this wall reaches back (`Selfhood.born_for`).
The card's face says so (`bornFor`, a2a4468e).

**Demonstrated** between two walls of this build on one machine (two processes,
`VOLERY_SECOND` + `VOLERY_WALL_DIR` + `VOLERY_FLYWAY_HOST`/`_PEER`): a card on
`lab2` called `spawn{host:"lab"}`, a card opened on `lab` in ~10s, answered its
brief, and the asker's call returned the handle. With the switch off, the same
ask came back at once: *"lab is not taking work from other walls — switch that
on in the flyway panel on lab"*.

The person's switch and the roster are in the flyway panel (`space k`, then `a`).
The switch defaults to off and gates prompts as well as spawns.

### 3. Seeing and prompting a remote card

The digest is a2a4468e's — produced by the owning wall's front end, one opaque
snapshot per wall, carried by `cards.rs`, never read in Rust, aged from
publish, not relayed, and never sent before the front end has published.
Prompts ride `FleetMsg::Prompt` — an `Ask` with a `card`, under a tag of its own
so no fleet build can misread one as a spawn — with every rule the ask was
red-teamed for. **Demonstrated** across the same two walls: a card on one wall
drawn on the other, prompted from the other's dock, `taken`, and its answer
read back in the next snapshot.

## What is left

### Smaller things

- **A read of the roster for agents.** An agent learns host names only from a
  refusal (`UnknownHost` lists them). A deferred `walls` tool would be the
  honest answer; `accounts`' "a field only a mistake can teach" is the argument.
- **`Fleet::namesake()` is not drawn.** Another machine under this wall's name
  is two cards for one ask. Note that any copy of the app run on this machine
  without `VOLERY_FLYWAY_HOST` joins the flyway as `COMPUTERNAME` — the
  installed wall's own identity — because the vault key is shared.
- **`Fleet::forget`** has no gesture: a retired machine stays on the roster,
  drawn quiet, for ever.
- **One startup panic, seen once and not reproduced**: a second wall restarted
  seconds after killing the first died with *"state() called before manage()
  for Store"* on a runtime thread and then on the main thread. `arrive` now
  uses `try_state`; if it recurs, the backtrace (copy `skein.pdb` beside the
  exe) will name the caller.
- **Testing two walls on one machine** wants a binary copied out of
  `target\debug` (with its DLLs) so another card's edit does not rebuild it
  out from under you, its own `WEBVIEW2_USER_DATA_FOLDER` (two processes on one
  identifier's webview folder never attach), and launching from PowerShell —
  a parentless process is reaped by the installed wall's orphan sweep.

### 4. Moving a card between hosts

`tools/probe-migrate.ts` already answered the hard question: **a session
transplants verbatim.** Put the transcript in the other machine's
`~/.claude/projects/` tree and `--resume` works; no record rewriting needed.
Tested at 33 records on one OS against one CLI version.

So `move` is: quiesce on A → ship the transcript and the rows → resume on B →
**confirm the model still has its history** → release A. Never delete before
confirming; a card that exists nowhere is the one outcome that must be
impossible. The *code* moves by git, not over the flyway — refuse to move a card
whose worktree is dirty rather than inventing a patch transport.

---

## The one thing nobody has answered

**Whether an office network lets iroh through.** `docs/FLYWAY-PROBE.md` is the
errand — five minutes at that desk. Everything above works between two machines
on one network; nothing here establishes NAT traversal between two *different*
networks, or that a TLS-intercepting gateway passes the relay. If the answer is
no, the transport is replaceable: `wire.rs` is the only file that knows about
iroh, and the frames are sealed before they reach it.

## Standing hazards for anyone working here

- **Do not run `cargo` by hand while a dev build is live.** They contend for the
  target lock and each stalls the other; this looked like "the build is
  mysteriously slow" for an hour.
- Schema is at **v46**. Take the next rung and say so on the board.
- The wall suite (`test/wall.test.ts`) has ~19 standing failures and some are
  flaky — sink `64e5003c`. It is not yet trustworthy as a gate.
