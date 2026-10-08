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

### 4. Reaching a card once it is open (2026-10-08, card da1713c9)

The orchestrator half: a card that opened work on another machine can now
steer it, read it and tidy it away, and the card it opened can report back.
`send`, `recall` and `close` each grew one argument, `host`; without it, or
naming this wall, each does what it always did. `walls` (deferred) is how an
agent finds what to put there.

- **Wire.** Two more tags, `recall` and `close`, each a prompt's shape (an
  `Ask` with a `card`) — one path in `Fleet::reach` / `hear_ask` for all three,
  so keyed, remembered, aged and never sent to a quiet wall. A recall answers
  with a new `Outcome::Said` (the speeches, capped again on arrival), kept out
  of the gossip; a close answers `Opened` like a prompt. A wall announces the
  words it understands (`Facts::can`); an asker refuses at once to ask an older
  wall rather than wait out `GIVE_UP_MS` for a tag it would skip.
- **Who may — `fleet::may_reach`, decided on the wall the card is on.** The
  switch gates work and nothing else. A prompt is work: held to the switch,
  except an answer to a parked question and **a child's report to the card that
  opened it** (Lyss's decision, the same as an answer's). A recall is a read:
  the origin always, anyone else through the switch. A close stops work: the
  origin only, switch or not, and anyone else is refused — never asked, since
  the person who would be asked is at the other machine.
- **The origin and the child are both recorded, not believed.** The far wall
  has `flyway_birth`; the asking wall now writes `flyway_child` (**schema v48**)
  when the answer says the card opened. So a reply is let through the switch
  because the asking wall wrote the pair down, not because the far wall says
  "I am its child".
- **Addresses are resolved where the card is**, by `relay::resolve` against
  that wall's roster: handle, id or exact title, an ambiguous title refused by
  name. Nothing the asker writes is ever an id the far wall did not mint.
- **An agent's message arrives as a relay**, in `relay::afar_envelope` (the
  shape `relay.ts` already folds, with `on <host>` after the project and a
  trailer saying to reply with `host`), delivered through the relay so a
  dormant card wakes to read it — never through the front end's `Skein.send`,
  which would draw it as typed here. A person's prompt from a dock is unchanged.
- **A close** keeps the local refusals (mid-turn, set aside) and refuses a card
  whose timeline is still in flight rather than asking across a network; it
  closes with an agent's fade and a chronicle row naming the asking wall.
- The calls park for up to 30s. A late refusal of a send, and a late close
  either way, reach the card as a wall message; a late recall does not.
- `Selfhood.born_for` now tells a card opened by another wall's card the exact
  `send` that reaches its parent. The spawn receipt names all three tools.

Not proven app-to-app yet — see "What to try" below. The protocol layer is run
here by `bun tools/lift-fleet.ts` (all of `fleet.rs`'s tests, executed).

#### What to try, across AU-LT-288 and QUEERISFREEDOM

1. Both on this build. On QUEERISFREEDOM, switch **on** "take work from other
   walls" (`space k`, then `a`).
2. From a card on AU-LT-288: `spawn{host: "QUEERISFREEDOM", prompt: "…report
   back to me when done"}`. The receipt names the handle.
3. Wait for the child's report to arrive on AU-LT-288 as a relay line *from
   "…" in … on QUEERISFREEDOM*. Then switch QUEERISFREEDOM **off** and have the
   child `send` again — it should still arrive (a reply is not work).
4. With the switch still off, from the parent: `recall{card, host}` should read
   it; `send{to, host}` should be refused naming the switch; a *different* card
   on AU-LT-288 should be refused a `recall`.
5. `close{card, host}` from the parent closes it (with the fade, and a
   chronicle row on QUEERISFREEDOM); from any other card it is refused.
6. `walls` from the parent marks the child `yours`; from the child it marks the
   parent `opened_you`.

## What is left

### What parks waiting for a person (sink 16864f3d)

- **`ask_user` travels** (749d8ea). The question rides its card's digest —
  words only, never a preview or a file, never a question Volery composed — and
  the answer comes back as a prompt naming the question (`Ask::answers`,
  `flyway_prompt`'s `askId`), handed straight into the parked call by
  `ask::answer_from_afar`. Not held to the far wall's switch: an answer starts
  no work. Proved between two walls with the owning wall's switch off.
- **`notice` does not travel yet.** Same shape as `ask_user`, not built.
- **Removal confirmation does not travel yet**, and a remote answer to any
  question with an act behind it is refused on the owning machine. Lyss decided
  it should travel (sink 7207a6d9) with the machine named, the path as that
  machine resolves it and what is actually there carried with the question;
  until that is built, refusing is the honest stand-in.
- **Credentials never travel** — decided, not pending. A remote spawn needing a
  credential the far machine lacks should be refused naming which one; today
  nothing checks for that, so the card would start and fail at its first call.

### Two builds side by side

The normal case, not the edge one: the machine you sit at updates and the other
waits. A frame under a word this build does not know is skipped, and so is a
frame under a word it knows in a shape it cannot read (one more `Outcome`
variant), logged rather than failing the exchange — `frame::take` holds that
with a test. **But the fleet itself needs this release at both ends**: a 0.42
wall answers v1 only, so against one, all that crosses is the sink.

### Smaller things

- **Recall and close for a person.** The dock prompts a remote card; it cannot
  yet read one's transcript or close one. The wire is there (`Act`) — it is a
  front-end gesture away, and the gate already says who may.
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
- Schema is at **v48**. Take the next rung and say so on the board.
- The wall suite (`test/wall.test.ts`) has ~19 standing failures and some are
  flaky — sink `64e5003c`. It is not yet trustworthy as a gate.
