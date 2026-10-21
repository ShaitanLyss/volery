---
paths:
  - "src-tauri/src/subscribe/**"
  - "src-tauri/src/eventhub.rs"
  - "src-tauri/src/amqp/**"
  - "src/lib/sources.ts"
  - "src/lib/sources.svelte.ts"
  - "src/lib/waiting.ts"
---

# Event subscriptions: a turn only when something happened

Lyss, 2026-10-21: *"we also need to build in a way or make a change to volery that only wakes
agents only when something they care about actually happened, right now they lose a turn every
2 hours"* — and *"DO NOT poll or open SSE streams to databases. Use Change Data Capture /
Eventstreams / Event Grid / Webhooks to trigger reactive executions."*

An agent watching an external stream (Nova feedback first; CI and deploys later) had one move:
wait inside a `run_in_background` job, which the CLI caps at two hours. It woke, found nothing,
re-armed, and lost a turn each time — while its watcher queried a Fabric SQL database every
five seconds and kept it billed around the clock.

**Volery is always running, so Volery holds the connection and the card holds nothing.** A
card calls `subscribe(source, filter, note, every_minutes?)`, ends its turn, and is handed one
only when a matching event arrives. No timer, no empty wake, no cap. Designed on AU-LT-288 with
Lyss and built on the MSVC machine, because `cargo test` is the only way to run the engine's
tests.

## "Wake" means one thing: hand the card a turn

The word meant three things to the person who asked for it, so the code, the tool description
and this file say which:

- **an idle live card** is handed a new turn (`supervisor::deliver`);
- **a card mid-turn is never interrupted.** What matches while it works is held and handed over
  as **one** turn when it ends — not written into its stdin, where the CLI would queue it as one
  turn per batch. `supervisor::turn_open` is asked first; `persist_turn`'s close is the signal;
- **a dormant card is roused** — `relay.rs`'s "a message addressed to one card by name now wakes
  it": a self-row in its inbox (`record_relay(awake: false)`, the `deliver_from_afar` shape, so
  `drain_inbox` hands it over as written) and `relay:wake` for the front end to spawn it. A
  second batch while that rouse is in flight waits for the roused turn to end rather than
  becoming a second inbox row and a second turn.

## Once: not lost, not duplicated

Two transactions are the whole guarantee (`ledger.rs`):

- **`ingest` matches, writes and checkpoints in one commit.** An event is never checkpointed
  without its deliveries, nor re-delivered because the checkpoint did not land — the
  `set_mid_turn` lesson again, *bookkeeping about how far something got is written by the same
  commit as the getting there*. An event at or before the checkpoint is skipped, which is what
  makes any replay safe: a stale re-attach, a service resend, a reconnect from an older
  position.
- **`claim` DELETEs a batch before it is delivered** — `later.rs::serve_due`'s ordering, and
  its argument: interrupted between the two, a lost batch is a card waiting for an event it
  missed; a doubled one is a card handed the same events twice, the failure this exists to stop.
  A batch that cannot reach a live card goes to the inbox, so the ordinary failure loses nothing.

**A new subscription starts now.** An event is matched only against subscriptions created at or
before its enqueued time, so an old checkpoint never hands a newcomer a backlog. With a
**two-second skew** (`SKEW_MS`): the two clocks are Azure's and this laptop's, and the first use
of any subscription is *subscribe, then make an event to watch it arrive*. Strict, Azure half a
second behind drops exactly that event; two seconds costs at most an event from the two seconds
before the call. This is the one place the build is looser than the approved wording, and why.

**Where a partition starts** (`start_for`): the checkpoint, exactly — which is what makes events
that arrived while the laptop slept or Volery was down arrive on reconnect, once. But a
checkpoint older than every current subscription would only replay events none of them may
receive, so the reader starts at the oldest subscriber instead. That is also the fresh start:
never the beginning of the hub's retention. A checkpoint is per `(source, partition)`, per wall;
changing a source's connection string to a different hub clears them, since sequence numbers
belong to one hub.

## Batching and the guard, which must never throttle a real session

`engine.rs`. Events that land together are one turn: a card's batch goes `QUIET_MS` (5s) after
the last event of a burst, or `MAX_HOLD_MS` (30s) after the first if the burst never pauses — so
a trickle is still delivered rather than waiting for a quiet that never comes. `every_minutes`
spaces one subscription further. One turn carries at most `MAX_LINES` (100) events; the rest is
the next turn's, not lost.

**Driven by a channel and `recv_timeout(next deadline)`, never a tick.** The loop wakes for an
event matched, a turn closed, a card gone — and with nothing pending it blocks on the channel
with no timeout at all. CLAUDE.md's "three places that go and look" is the rule; this is not a
fourth.

Lyss: *"it shouldn't prevent me from having intensive feedback sessions."* So:

- **no hourly cap that stops delivery, and nothing is ever dropped** — only batched;
- past `GUARD_TURNS` (30) subscription turns in an hour, a card's turns are spaced
  `GUARD_SPACING_MS` (a minute) apart, with everything that arrived riding along, and a
  chronicle line says so once;
- the loop worth naming is the **self-trigger** — a card reacting to an event by producing one
  it is subscribed to. Its signature is a matching event arriving *during the turn our delivery
  opened*, batch after batch; `ECHO_LIMIT` (5) in a row writes a chronicle line and the next
  envelope tells the card how to filter its own writes out. The tool description says it up
  front: `"channel": "ui"` leaves out the card's own `mcp` writes. A real session pays nothing
  for either.

A card held for a turn end that never comes (a rouse that never became a process) is looked at
again after `TURN_HOLD_LIMIT_MS`, so nothing wedges on a signal that will not arrive.

## What the card is handed

`subscribe::envelope`: **a shape under `RELAY_MARK`, not a mark of its own** (`relay.md`), the
settle notice's exact shape — `[skein relay] from the wall —` on a line by itself, then the
count, then per subscription its id, source, filter and note, then the events as compact JSON
lines, then `\n\n(This came from the wall…`, which says nobody is waiting on a reply.
`relay.ts` already recognised all of it; `test/relay.test.ts` pins that it still does. The
header line carries nothing else because `relayBody` drops it whole.

## Sources: named by Lyss, never seen by a card

The integrations panel (`Keyring.svelte`, `<space> o`) takes a name, a connection string and a
consumer group (`$Default` unless the stream says otherwise — a Fabric Eventstream's custom
endpoint names its own). The connection string goes to Credential Manager under
`dev.skein.studio/source/<name>`; the rest to the `source` table. **The wire names a source,
never a target** (`integrations.md`'s rule): `sources::target` is the only place the vault
string is built, so no command can reach another credential.

- **A stream may have no connection string at all.** The first one to go live (2026-10-21, Nova
  feedback on a Fabric Eventstream) is on a tenant that disables SAS keys on custom endpoints,
  so Entra ID is the only way in. A source can therefore be written in the connection string's
  own shape with a service principal instead of a key — `Endpoint=sb://…/;EntityPath=…;
  TenantId=…;ClientId=…;ClientSecret=…` — still one secret in one vault entry through one field.
  Volery asks `login.microsoftonline.com` for a client-credentials token for
  `https://eventhubs.azure.net/.default` and hands it to CBS as type `jwt` (the publisher card
  verified that the SP reads the destination that way with `@azure/event-hubs`). The token is
  renewed at three quarters of its life, and Entra's own `AADSTS…` line is what a refusal says.
  Lyss's own user via `az` was the alternative and was not taken: it needs a workspace role
  nobody has tested, and `az` cannot get through Netskope on AU-LT-288 at all (`azdo.md`).
- **No subscribers, no connection.** `sources::reconcile` dials what is subscribed to and hangs
  up the rest; checkpoints stay.
- **Several walls, one stream.** A subscription lives on its card's wall and only that wall
  connects. Every wall reads as a **non-epoch** receiver on the **same** consumer group — each
  non-epoch reader gets every event, up to five per partition — and keeps its own checkpoints.
  A card moved to another wall does not carry its subscriptions in v1.
- `forget it` is refused while anything subscribes, since that card would wait for ever.
- `check it` dials, authenticates, reads the partitions and attaches one — the attach is what
  proves the consumer group, which the read alone does not.
- A source that fails reconnects with backoff, one second doubling to five minutes, and starts
  the ladder over after a connection that held two minutes (a laptop waking is ordinary).
- **A source says what it is doing in two places a card can read without the panel.** Every
  connect (with its partition count), failure (with its fault and the backoff) and stop goes to
  `volery.log` under target `source` — it was `eprintln!`, and the app has no console, so a
  source failing on AU-LT-288 left nothing behind once the panel closed. And the
  `subscriptions` tool lists each source with its reading (`sources::reading`, the same one the
  panel draws), so a card waiting on a quiet stream can tell *nothing has happened* from
  *nothing can arrive*.

## The transport: a hand-rolled AMQP 1.0 receiver

Approved by Lyss over the Azure SDK, which is async and brings its own TLS — and every outbound
client on this network must trust `forge::tls_config()`'s merged roots to get through Netskope.

- `amqp/codec.rs` — types, frames, message sections; every length bounds-checked, nesting capped.
- `amqp/conn.rs` — one connection, one session, generic over `Read + Write`, tested against a
  scripted fake broker on an in-memory pipe. Heartbeats at half the peer's idle timeout; a peer
  silent for twice ours (60s) is presumed dead, which is what a laptop's sleep does to TCP.
  Requests on `$cbs`/`$management` keep any event that lands meanwhile.
- `amqp/ws.rs` — `wss://<ns>/$servicebus/websocket`, subprotocol `AMQPWSB10`, port 443.
- `eventhub.rs` — every wire detail checked against the official SDKs' source and Microsoft's
  protocol guide (2026-10-21): the SAS key is the base64 *text's* bytes, not decoded; the string
  signed is the URL-encoded `sb://<ns>/<hub>`, `\n`, expiry seconds; SASL ANONYMOUS then
  `put-token` within twenty seconds; one token covers every partition and `$management`;
  partition ids from a `READ` (`type` `com.microsoft:eventhub`, token again as `security_token`);
  receivers on `<hub>/ConsumerGroups/<cg>/Partitions/<id>` with the
  `apache.org:selector-filter:string` filter, descriptor `0x0000468C00000004`, positioned by
  `x-opt-sequence-number > 'N'` or `x-opt-enqueued-time > '<ms>'`; `snd-settle-mode` settled;
  token renewed on the same `$cbs` link at 45 of its 60 minutes. A link the service detaches
  (thirty idle minutes, a token expiry) is re-attached from its last sequence; more than three
  in a minute and the connection is redialled.

Unverified when written, and worth knowing before blaming the code: the idle timeout the
service states, the exact condition a sixth reader on a partition gets, and whether a Fabric
Eventstream endpoint accepts AMQP over WebSockets (it is a `servicebus.windows.net` namespace,
so it should).

## The card's face

A card with a live subscription reads `waiting — on <source>` instead of `at rest` and does not
warm on the neglect clock — `waiting.ts`'s `from: "event"` wake, never late since it names no
time, patched by `subscription:armed` / `subscription:disarmed` (`later.rs`'s arrangement; read
once by `subscriptions_armed`). A timed wake reads before it; a recurring cron after.

## Filters

`filter.rs`, pure: a JSON object of field → condition, evaluated against the application
properties overlaid by the body's own fields (body wins). A literal means equals — against a
list field, *is an element*; `in`, `contains` (list element or substring), `exists`, `not`;
top-level `all`/`any`/`not`; dotted names reach into objects; `{}` is everything. A missing
field fails every positive test and passes its negation, so `{"modules": {"not": {"contains":
"EOS"}}}` matches an event with no `modules`. Compiled at `subscribe`, so a bad filter is
refused to the agent that wrote it rather than matching nothing for a week.

## The tools, and their tier

`subscribe` is **loaded**, on `wake_me`'s argument: it replaces something agents do wrongly by
default (a background watcher), and nothing in `ToolSearch` reaches a reflex. 2,469 bytes —
the loaded tier went from 28,390 to 30,859 against the 32,000 ceiling, so the next addition
there will trip it and owes the conversation that ceiling asks for. `subscriptions` (read-only)
and `unsubscribe` are deferred, named in full by `subscribe`'s receipt — `cancel_wake`'s
arrangement. A card closed or cleared loses its subscriptions (`subscribe::clear_for`, beside
`later::clear_for`).
