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

## What is left, in dependency order

### 1. Wire `fleet.rs` into the envelope — **the gate on everything else**

`fleet.rs` is written, reviewed and tested, and **nothing calls it**. Its
messages (`FleetMsg`: `Roster`, `Ask`, `Answer`) need to ride the same sealed
frames `session::Msg` does, and `link.rs` needs to drive it.

What the Fleet owes its caller, from the card that wrote it:

- Every message: `fleet.on(msg, now, &facts)` → `Reply { say, open, answered }`.
  Everything in `say` is gossip, safe to send to every peer, and must reach at
  least the sender.
- Every `open: Spawn`: exactly one `opened(asked_by_host, request, card, now)`
  or `failed(asked_by_host, request, reason, now)`.
- Timers: `announce(facts, now)` every 30s, `prune(now)` on a tick.
- **Persistence:** `Fleet::new(me, last_version)`. Persist `fleet.version()`
  after each `announce` and hand it back on start, or a restart after a clock
  correction freezes this wall on every peer's roster.
- `fleet.namesake()` is true when another machine announces under this wall's
  name — worth drawing, because both would open a card for one ask.

`link.rs`'s `answer_with` and `pull` are where this goes. Note the current
protocol is **pull-only and symmetric** — every wall dials every peer and asks
for what it is missing; nobody pushes. That is argued at the top of `link.rs`
and is right for a sink. A roster and a spawn request are *not* a sink: an ask
that waits up to 45s for the other wall's next pull is an ask nobody will use.
**This is the design decision the next card has to make**, and the two honest
options are: shorten the interval for fleet traffic only, or hold a connection
open. Do not simply reuse the sink's cadence without arguing it.

### 2. Remote spawn, reaching the real spawn path

`mcp__skein__spawn` grows a `host`. An arriving `Ask` becomes a card through
**the existing birth path** — `Skein.#openIn`, which `spawn.rs` is emphatic is
the one correct way a card comes into being. Read `.claude/rules/spawn.md`
first; its bounds (a territory named rather than a path, never a chat card)
hold unchanged for a remote asker, and `spawn.rs`'s `MAX_LIVE` / `MAX_PER_HOUR`
become per-roost bounds on arriving work.

**A card born over the flyway must say so on its face.** The user's protection
here is not that a fan-out was prevented but that it is *visible* — a remotely
born card running `--dangerously-skip-permissions` is the whole risk, and
`seal.rs`'s module comment argues why holding the key is already full trust.
A chronicle row naming the asking wall is the minimum.

### 3. Seeing and prompting a remote card

The part that makes it a *dashboard* rather than a remote spawn button. Needs:

- A **digest** per remote card — id, title, territory, host, status tier, ctx,
  idle, last line — enough to draw a card at any density.
  **The taxonomy lives in `classify.ts`, in TypeScript**, so Rust cannot produce
  a digest. The honest shape is: the owning wall's front end produces it and the
  link ships it. Do not port the taxonomy to Rust without a shared fixture
  corpus run by both suites — that drift is silent and lands on the machine you
  cannot see.
- Drawing a shadow card. `Conversation` assumes a process; a shadow has none.
- Sending a prompt to one. The echo machinery (`Conversation.echo`, `pending` /
  `awaited`) is already subtle — read the architecture note in CLAUDE.md. A
  remote prompt needs a **fourth** mark: queued-but-not-yet-left-this-machine.
  A link that is down must not look like an agent that is thinking.

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
