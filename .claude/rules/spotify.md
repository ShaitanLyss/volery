---
paths:
  - "src/lib/spotify.ts"
  - "src/lib/spotify.svelte.ts"
  - "src/lib/Spotify.svelte"
  - "src-tauri/src/spotify.rs"
  - "src-tauri/src/selector.rs"
  - "src-tauri/src/tunnel.rs"
  - "test/spotify.test.ts"
  - "tools/lift-tunnel.ts"
  - "src-tauri/Cargo.toml"
---

# Music on the wall

The sink item was one line — *"add spotify integration to play music from skein"* — and
essentially all of the work was finding out what that sentence can mean in August 2026.
Everything below the first section is downstream of one decision, so the decision is first.

## "Play music" has two readings, and the cheap one was not chosen

- **Control a Spotify that is already running.** The Web API can transfer playback, play,
  pause, skip, seek, set volume and report what is playing, on a device already signed in.
  A normal REST integration.
- **Be the player.** Volery emits the audio itself.

The user was asked (2026-08-27) and chose **be the player, via librespot**, and chose to
**bake it into the release binary**. Both halves of that were put to them with the costs
attached and the second was argued against explicitly; see *The position on Spotify's terms*
below, which is the part that has to be re-read rather than re-litigated if anyone revisits
this.

## What the Web API actually offers now, probed rather than remembered

Spotify has restricted this surface twice in living memory and a design against remembered
endpoints would have been wrong in both directions. Checked against the developer
documentation and the February 2026 changelog on 2026-08-27:

- **The player endpoints survived.** February 2026 removed a great deal — Get New Releases,
  Get Artist's Top Tracks, Get Available Markets, the bulk multi-item fetches, Create
  Playlist, Get User's Profile, Get User's Playlists — and cut `search`'s `limit` from a
  maximum of 50 to **10** with the default from 20 to 5. Every `/me/player/*` endpoint is
  listed as still available. The save/remove endpoints were consolidated onto `PUT`/`DELETE
  /me/library` and playlist items moved to `/playlists/{id}/items`.
- **The November 2024 cull is still in force** for anything created since: Related Artists,
  Recommendations, Audio Features and Audio Analysis are closed to new apps. Nothing here
  wants them, but a future "what does this track sound like" idea should know they are gone
  rather than discover it against a 403.
- **Control needs Premium.** *"This API only works for users who have Spotify Premium"*, on
  the playback endpoints, under `user-modify-playback-state`. Reading what is playing does
  not.

### The registration cost, which is the reason the Web API is not the spine here

A Web API app is in **development mode** and that mode got materially worse in February 2026:
**5 authenticated users**, and the app owner must themselves hold Premium *for the app to
function at all*. Extended quota mode lifts the cap and is not a door open to a project like
this one — since May 2025 it requires a legally registered business, a launched service and
**250,000 monthly active users**.

So the honest shape of a Web API integration is *every user registers their own Spotify
application and pastes a client id in*. That is a fine thing to ask of one person on one wall
and an absurd thing to ship in a downloadable release, which is precisely the direction this
app was being taken.

## librespot, and why it dissolves the registration problem

librespot is not a wrapper over the Web API. It is an open-source reimplementation of
Spotify's **client protocol** in Rust (MIT), the engine under `ncspot`, `Spotifyd` and
`Snapcast`. It pulls the encrypted stream directly, decrypts it, decodes Ogg Vorbis and hands
PCM to an audio backend; it also registers as a Spotify Connect receiver, so the wall appears
in the device list on your phone like a speaker.

**It needs no app registration from anybody**, and the reason is the whole of the ethical
question. Read from `librespot-core/src/config.rs` on 2026-08-27:

```rust
pub(crate) const KEYMASTER_CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
pub(crate) const ANDROID_CLIENT_ID:   &str = "9a8d2f0ce77a4e248bb71fefcb557637";
pub(crate) const IOS_CLIENT_ID:       &str = "58bd3c95768941ea9eb4350aaa033eb3";
```

Those are Spotify's *own* first-party client ids. That is why librespot can ask for
`streaming`, `user-modify`, `user-personalized` and `user-read-birthdate` — scopes the public
Web API will not grant a custom client id, as `librespot-oauth` says in as many words: *"Some
of these scopes are unavailable for custom client IDs."* The zero setup cost and the terms
problem are **the same fact**, and anything proposing to keep the first while fixing the
second has misunderstood the mechanism.

Password login is gone (deprecated upstream); the ways in are interactive OAuth on a loopback
port, a `streaming`-scoped access token, or zeroconf discovery.

### Audio quality is not the reason, and should not be quoted as one

| | librespot | Web Playback SDK |
|---|---|---|
| stream | 320 kbps Ogg Vorbis | 256 kbps AAC |

The gap is narrower than the numbers: AAC is the more efficient codec and both sit at or past
transparency for most listeners. librespot has the lighter runtime — native decode, no EME,
no CDM in the audio path — and a nominal bitrate edge. Neither is a performance problem for a
music player. **The decision was distributability, not fidelity**, and a future reader
weighing this up should not be told otherwise.

### What was rejected, and one piece of folklore corrected

The **Web Playback SDK** was the other "be the player" route. The received wisdom is that a
desktop webview cannot host it, and that wisdom is inherited from **Electron**, which ships no
Widevine CDM and no VMP signing. It does not transfer cleanly: **Tauri on Windows is WebView2,
which has Widevine and PlayReady natively.** Against that, Spotify's own docs name
Chrome/Firefox/Edge/IE as supported and do not name WebView2. So the honest status is
*plausible and unproven*, not *impossible* — it was offered as a bounded probe and the user
chose librespot instead. If librespot ever has to come out, this is the route to probe rather
than dismiss.

## The position on Spotify's terms, stated once and plainly

librespot's own README says it: *"Using this code to connect to Spotify's API is probably
forbidden by them. Use at your own risk."* It works by presenting Spotify's first-party client
id, which is not incidental to it — it is the mechanism, per the constants above.

That risk was put to the user in those words, together with the distinction between running it
on your own machine against your own account and **shipping a release that embeds it**, on a
public repository under a personal name. They chose to ship it. That is recorded here because
it is a decision someone made with the trade-off in front of them, not a thing that crept in —
and because the next person to open this file deserves the argument rather than a surprise.

The practical residue, for whoever maintains it: Premium is required and will remain so
upstream; a protocol reimplementation tracks a moving target, so **an outage here is more
likely to be Spotify changing something than a bug in this file**, and the failure should say
so rather than blame the network.

## It builds here, and the one pin that makes that true

Probed 2026-08-27 on this machine — **no MSVC**, `stable-x86_64-pc-windows-gnu`, per
`build.md`'s rule that a throwaway crate in `.scratch` is the only way to answer a library
question here (no exe built from the main crate runs on that target). `cargo check --lib`
against `librespot-core`, `-playback` (rodio backend), `-metadata`, `-oauth` and `-connect`:
**clean in 1m36s**, with a probe that instantiated `Player::new`, `audio_backend::find` and
`NoOpVolume` on purpose, so what passed is the API surface and not merely the resolver.

Three things that could have been traps and are not: the decoders are `symphonia`, which is
pure Rust, so **no `protoc`, no `cmake`, no C toolchain** beyond what the tree already needs;
`rodio` reaches WASAPI through the `windows` crate; and nothing in the tree spawns a child
process, so the *"every spawn goes in a job object"* rule has nothing to bite on here.

**The pin.** Out of the box it fails, and the failure names nothing that points at Spotify:

```text
error[E0277]: the trait bound `vergen::feature::build::Build: vergen_lib::entries::Add`
              is not satisfied
error: could not compile `librespot-core` (build script)
```

`librespot-core`'s build script wants `vergen ^9` and `vergen-gitcl ^1`. Those were one
family until they were not:

| | depends on |
|---|---|
| `vergen 9.0.6` (2025-04-09) | `vergen-lib ^0.1.6` |
| `vergen 9.1.0` (2026-01-16) | `vergen-lib ^9.1.0` |

A breaking change shipped inside a **minor** bump, so `^9` picks it up. `vergen-gitcl 1.0.8`
is still on `vergen-lib 0.1.6`, both get unified into one build script, and the two `Add`
traits are not the same trait. librespot 0.8.0 was published 2025-11-10 and **built fine at
the time** — it was broken retroactively, three months later, by a crate it does not name.

**The fix is `vergen = "=9.0.6"` in `[build-dependencies]`** — declared to constrain somebody
else's build script rather than because our own `build.rs` wants it.

It was a `Cargo.lock` pin first, and that is the part worth keeping, because the lock pin is
the obvious answer and it does not hold. **A lock entry is re-resolved by the next `cargo
update` *or simply by adding a dependency*.** It was applied and lost three times in one
afternoon; two other cards independently diagnosed the resulting error from scratch and one
broadcast to the whole wall that the Rust gate could not pass for anybody. With the
requirement in the manifest instead, `cargo update -p vergen` answers

```text
Downgrading vergen v9.1.0 -> v9.0.6 (available: v9.1.0)
```

— it can no longer move, and one `vergen-lib` remains in the graph.

The general shape, which is not about Spotify: **a constraint you can only express in a
lockfile is a constraint that survives exactly until somebody runs a routine command.** If a
transitive version genuinely matters, say so in the manifest, where re-resolution has to obey
it — and say *why* beside it, because an `=` requirement with no explanation is the thing a
future tidy-up deletes.

## Where the credential goes

The refresh material goes in the **Windows credential vault under
`dev.skein.studio/spotify`**, beside `dev.skein.studio/azdo-pat`, and keeps the `skein`
spelling for exactly the reason `vault.rs` gives for the other one: this is a name the *disk*
depends on, the visible rename to Volery was made explicitly provisional, and a credential
keyed to a product name that changes again is a token that silently vanishes on upgrade and
reads as the app having forgotten it.

Not the wall's own database — `store.rs` is an unencrypted SQLite file that `portage.rs`
exports layouts out of, and a token in a column there travels with them.

## Signing in, and the four minutes nobody could see

Reported 2026-08-28, in the words that matter because they are the symptom:
*"i clicked sign in, opened browser, i did sign in, now the page shows go back to your
terminal, but the widget is still stuck on waiting for the browser."*

Three separate things were wrong, and only the third is about Spotify at all. They are written
out in the order they were found, because the order is the lesson: the visible complaint was
the least important of them.

### The refresh token rotates, and dropping it poisons the vault

**Spotify's authorization-code-with-PKCE flow rotates the refresh token.** Every successful
refresh answers with a *new* one and revokes the one that bought it. `spotify_link` stored the
first correctly; `spotify_start` and `access_token` then each did their own refresh and each
**threw the new credential away**. So the first refresh after a sign-in retired the only thing
in the vault, and everything afterwards — a later `spotify_start`, a card's `records` search,
the next launch — failed against a token Spotify had already killed.

Probed by refreshing the stored credential by hand after one `spotify_start`:

```text
invalid_grant: Refresh token revoked
```

It presents as the app having forgotten your account, and the only way out was signing in
again — **once per launch, for as long as it stood**. Worth noticing how well it hid: the
failing call is the *second* one, so the sign-in always looked like it worked, and it did.

`refresh_stored` is the fix and being *one* function is most of it. Three call sites each
holding a copy of "refresh the stored credential" is three places to forget the rotation, and
two of them had. The write back to the vault is best-effort on purpose: a rotation we could
not store is a credential that will fail *next* time, and refusing to hand back a token that
works right now would make that a failure this time as well.

The general shape, which is not about Spotify: **when an exchange hands you a replacement for
the thing you spent, storing the replacement is part of spending it.** A refresh that reads the
vault and does not write it is half a transaction, and it type-checks.

### librespot's own bound is four minutes of silence

`Session::connect` and `Spirc::new` were both unbounded, and librespot's internal ceiling is
nowhere near tight enough to be a reading on a wall. Its `connection::connect` looks like it
has a timeout and does not:

```rust
tokio::time::timeout(TIMEOUT, {
    let socket = crate::socket::connect(host, port, proxy).await?;  // <-- outside it
    handshake(socket)
}).await?
```

The block is evaluated to *produce* the future `timeout` wraps, so the TCP connect is awaited
before the timeout exists. Only `handshake` is covered. Every connect attempt therefore costs
the OS its full SYN timeout — 21 seconds here — and `Session::connect` will try six access
points at two attempts each. Measured 2026-08-28: **253 seconds** to reach *"Tried too many
access points"*.

So the card was not hung. It was working, silently, for four minutes, and there was no way to
tell those apart from outside. `CONNECT_BUDGET` is 30s around both calls: generous for a
reachable access point, which answers in well under a second, and short enough that the answer
arrives while somebody is still looking at the widget. The two calls are the only reason this
crate has a direct `tokio` dependency, and its `Cargo.toml` entry says so.

### A failure has to be a state, not only a reply

`spotify_start` returned its failures as `Err` strings and emitted nothing. A returned string
reaches exactly one caller — whoever pressed the button — while the *wall* has however many
faces on it and a `Linking` still sitting in the replay. So every other widget, and any face
that mounted during those four minutes, went on drawing a sign-in that had already failed.

Both commands now emit `Closed { fault }` on every failure path as well as returning it. **A
reply and a state are different obligations and this subsystem owes both**; the same split the
event pipeline makes everywhere else.

### Three legs were drawn as one, which is the complaint as written

`deck.link()` awaits three things — the browser, the session, the status read — and `busy`
covered all of them, with one label: `"waiting for the browser…"`. So the reported symptom was
literally true and completely misleading. The browser leg had finished six minutes earlier;
the refresh token was already in the vault, written at the moment the page said *go back to
your terminal*.

`Wire::Opening` is the fix, and it is a wire event rather than a field on `Deck` on purpose: a
face that never pressed the button follows along too, which is the whole argument for the
replay in the first place. `Replay::note` keeps `Linking`/`Opening`/`Session` in one slot,
because they are the mutually exclusive things a session can be doing and `Closed` resets the
struct — four states, one slot. The button's own label is now `"signing in…"`, and it is only
on screen for the blink before the first event arrives.

The rule worth carrying: **a label that guesses which leg is running is a label that is wrong
for the duration of the longest one.** If a verb has legs, the legs are states.

**The browser leg is still deliberately unbounded**, because the thing it waits on is a
person. The cost is stated where it lives, above `spotify_link`: abandon the sign-in and
`busy` stays set for the life of the process, since a blocking accept cannot be cancelled and
nothing else can take port 5588 back. Everything after that leg is bounded, which is where the
four minutes actually were.

## librespot could not reach Spotify from here, and the fix is a tunnel of our own

This is the one that took the longest and it is the one worth reading, because two
plausible diagnoses were measured and both were wrong before the third was right.

### What it looked like

```text
INFO  Connecting to AP "ap-gae2.spotify.com:4070"
DEBUG Connection to "ap-gae2.spotify.com:4070" failed: ... (os error 10060)
...six access points, two attempts each, ports 4070, 443 and 80...
ERROR Tried too many access points
--- FAILED after 253.4s
```

`10060` is `WSAETIMEDOUT`.

### The two wrong answers, kept because they are the ones anyone would reach for

**"Port 4070 is firewalled."** It is the obvious reading — 4070 is Spotify's preferred
access-point port, `SessionConfig::ap_port` exists precisely to route around a firewall that
blocks it, and librespot's own `apresolve.rs` says *"firewalls only allow certain ports (e.g.
443 and not 4070)"*. It is also wrong. `ap_port: Some(443)` was probed as a controlled variant
and failed **identically** — 211 seconds, every access point, port 443 only. Do not reach for
it again on its own.

**"This machine's IPv6 route is dead."** Also wrong, and this one was written into the rule and
the commit message before being checked, which is the mistake worth learning from rather than
the fact. This machine's IPv6 is fine:

| | |
|---|---|
| `ipv6.google.com` over IPv6 | open, 71 ms |
| `www.cloudflare.com` over IPv6 | open, 25 ms |
| `dealer.spotify.com` over IPv6 | open, 32 ms |

So there is a working default route and things on the other side of it answer. **A generalised
claim about the network was made from one host's behaviour, and it was falsifiable in about
fifteen seconds.** Two of the three wrong turns in this whole investigation were that shape.

### The right answer, which is per-host and one line of librespot

`librespot-core/src/socket.rs`:

```rust
let socket_addr = (host, port).to_socket_addrs()?.next().ok_or_else(...)?;
TcpStream::connect(&socket_addr).await?
```

**`.next()` — the first address `getaddrinfo` returns, and never any of the others.** No Happy
Eyeballs, no iteration, no fallback. And what `getaddrinfo` returns first for a Spotify access
point, here, is an address that does not answer:

| host | over IPv6 | over IPv4 |
|---|---|---|
| `ap-gae2.spotify.com` | timeout, 21086 ms | **open, 30 ms** |
| `ap-gew1.spotify.com` | timeout | **open, 46 ms** |
| `apresolve.spotify.com` | timeout | **open, 81 ms** |
| `api.spotify.com` | timeout | **open, 20 ms** |
| `dealer.spotify.com` | **open, 32 ms** | open, 29 ms |

Note the last row and the fact that `2600:1901:1:292::` answers where `2600:1901:1:7c5::` does
not: this is **per address, not per prefix and not per network**. Nothing here should be
described as "IPv6 is broken", including by whoever revisits it.

There is a working address sitting second in every one of those lists, and librespot never
reaches it. That is the whole bug, and it is what makes preferring IPv4 a fix rather than a
superstition.

### `tunnel.rs`, and why a proxy rather than a fork

`SessionConfig` has six fields and not one of them is about addresses, so librespot cannot be
told which family to prefer. But `proxy` changes **which host librespot resolves**: it dials
the proxy — `127.0.0.1`, one address, no ambiguity — and asks it over HTTP `CONNECT` to reach
the access point. The address decision moves into code this app owns, which is `tunnel.rs`: a
loopback `CONNECT` listener that sorts every resolved address IPv4-first and tries them in
turn.

Measured on the same network, in one session, minutes apart:

| | |
|---|---|
| librespot, direct | 253 s, then *"Tried too many access points"* |
| through the tunnel, `ap_port` 4070 | **connected in 1.94 s**, `Authenticated as 'chronoflo'` |
| through the tunnel, `ap_port` 443 | **connected in 1.27 s** |

The alternative was vendoring `librespot-core` and fixing `socket.rs` to iterate — the smaller
diff by far, four lines against a hundred. It was not chosen because this file already argues
that a protocol reimplementation tracks a moving target: a fork of one has to be re-merged
forever, and a supported config field costs nothing at upgrade time. That is a trade someone
made deliberately and it is the thing to re-read rather than re-decide.

Two things the measurement settled beyond the headline:

- **One tunnel covers the resolver too.** `apresolve.spotify.com:443` came through it, so
  librespot's `HttpClient` honours `config.proxy` as well as the raw AP socket. Nothing else
  needed pointing at it.
- **Port 443 is not being interfered with here**, both rungs authenticate, so the single
  `early eof` an earlier run got from `ap-gue1.spotify.com:443` was not TLS interception. It
  remains unexplained and it no longer matters, because a rung that fails is now one of two.

### The trap that comes with the proxy, and it is silent

Setting `proxy` **also decides which access-point ports librespot will consider**, and nothing
at the call site says so. `ApResolver::port_config`:

```rust
if self.session().config().proxy.is_some() || self.session().config().ap_port.is_some() {
    Some(self.session().config().ap_port.unwrap_or(443))
} else { None }
```

A proxy with no `ap_port` therefore filters the whole list down to port 443 and throws away
Spotify's preference order (4070, then 443, then 80). So `spotify.rs` sets `ap_port` explicitly
and walks the ladder itself — `AP_PORTS`, one fresh `Session` per rung, each bounded by
`CONNECT_BUDGET`. Both rungs were probed and both work, so the ladder is not for this network;
it is for the one where 4070 really is firewalled, which is the case `ap_port` exists for.

80 is deliberately left off: a network that passes a binary protocol on 80 where it refused it
on 443 is one nobody has met, and an extra rung is 30 seconds of somebody's evening.

### What is still unproven

`Spirc::new` and actual audio. The session opens and authenticates; the Connect device
registration and the rodio output path have never run against Spotify. Sink `4951f398` carries
that, and it is now the whole of what is left in it.

### The probe, and why it is a scratch crate

`.scratch/spotprobe` — uncommitted, per `build.md`: `cargo test` does not run on this machine
and **no exe built from the main crate runs on the gnu target at all** (`0xC0000139` before
`main`), so a throwaway crate is the only runnable Rust probe here. It grew a `main` from the
compile-only check that was already there, and then an IPv4-first tunnel of its own, which is
where `tunnel.rs` was written and proved before being brought into the app.

```bash
cd .scratch/spotprobe
export PATH="/c/cygwin/bin:$PATH" RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu \
  CC_x86_64_pc_windows_gnu=/c/cygwin/bin/x86_64-w64-mingw32-gcc.exe \
  CXX_x86_64_pc_windows_gnu=/c/cygwin/bin/x86_64-w64-mingw32-g++.exe \
  AR_x86_64_pc_windows_gnu=/c/cygwin/bin/x86_64-w64-mingw32-ar.exe
cargo build --bin spotprobe
RUST_LOG=librespot=debug ./target/debug/spotprobe.exe           # reads the vault
RUST_LOG=librespot=debug ./target/debug/spotprobe.exe --link    # its own browser leg
```

`--link` exists because of the rotation bug above: reading the vault after one `spotify_start`
gets a revoked token and answers a question about the wrong credential. **It costs a browser
sign-in every run**, which over one afternoon came to four of them from the user — if this file
is opened again for a network question, teaching the probe to cache its refresh token is the
first ten minutes to spend.

The pure half of `tunnel.rs` does not need any of that. `bun tools/lift-tunnel.ts` executes its
four assertions in under a second with no cargo and no dependencies, which also means it works
when the dependency graph does not — and for a Spotify file that is not hypothetical, since
`librespot-core`'s `vergen` conflict had the cargo gate red for every card on this wall for a
stretch on 2026-08-27.

**The reason a probe was needed at all is that the app installs no `log` sink.** librespot said
*"Connecting to AP …"* and *"Tried too many access points"* on every one of those four minutes,
with `log` macros, into nothing — so the whole diagnosis existed at runtime and was discarded.
`tunnel.rs::log_line` is the one place holding that shape until a sink exists. See sink
`7786cf73`.

## A card may choose what plays, and deliberately cannot drive it

The user asked for this in one line — *"add mcp tools for agents to control the volery
spotify, ability to select music. not volume, not play/pause"* — and **the exclusions are the
design.** Read them as: the user keeps control of their own listening. An agent can put
something on; it cannot silence them, cannot interrupt them mid-track, and cannot change how
loud their room is.

`src-tauri/src/selector.rs` is that, and it is named for the role rather than the mechanism:
in a sound system the *selector* is the person who picks the records. Two tools.

    records     search the catalogue. reading, changes nothing anybody hears.
    put_on      load a selection. the only act, and it refuses while music is on.

**The irony worth knowing before you edit here: the transport is the part that already
works.** `spotify_command(verb, value)` has driven play, pause, volume, repeat and seek since
the integration landed. What did not exist was the half the user actually wanted — nothing
searched Spotify's catalogue and nothing could load a chosen record. So this was new work in
the opposite direction from where the code already was, and the temptation while writing it is
to expose the nine verbs sitting right there. Do not. If a future tool in this file wants one
"for completeness", that is the instinct the scoping exists to refuse.

### The load leg needs no Web API, which is not the obvious answer

Volery is a librespot Spirc connect device, so the natural reading is that selecting music
means the Web API's own remote control — `PUT /v1/me/player/play` with a `device_id` and
`uris`/`context_uri`. It does not. **`Spirc::load` is exposed by `librespot-connect` 0.8** and
takes the same two shapes that endpoint does; the crate's own doc comments say so outright:
`LoadRequest::from_context_uri` is the endpoint's `context_uri`, `from_tracks` is its `uris`.
So a load is a local call on a handle this app is already holding — no second network round
trip, no device-id juggling, and no Premium requirement *for the load itself*.

**Search is the other way round, and there is no local option at all.** `SpClient` has
`get_metadata`, `get_context`, `get_playlist`, `get_radio_for_track` and `get_rootlist` — and
no catalogue search of any kind. So `records` is a real `GET /v1/search`, and that is the only
reason this subsystem has an HTTP path. It reuses `forge::agent` rather than building a
client, because that agent exists for a reason about *the network* rather than about Azure
DevOps: this network intercepts TLS, so it is built with `native-certs`, and its own comment
argues that duplicating it per provider means two places to be wrong about a corporate proxy.
Spotify is the third caller and inherits the requirement rather than escaping it.

### The one judgement call, and what it costs

`start_playing` is a **field** on `LoadRequestOptions`, defaulting to false — so loading does
not inherently start playback, and the user's exclusion is honourable exactly as written. That
is the good news and it is not the whole story: **a load replaces the current context and
track**, so it is not transport-neutral either. Dropping a record onto a spinning deck takes
off whatever was playing, `start_playing: false` or not.

librespot 0.8 offers no way out. `AddToQueue` appears in `spirc.rs` but only as an *inbound*
dealer command — something a Spotify client tells *us* — and there is no `pub fn add_to_queue`
on `Spirc`. So "queue it after this track", which would have satisfied both halves, is simply
not available to build on. Do not go looking again.

So the rule is: **refuse while something is actually playing, and otherwise load and start.**
Both halves are one argument.

- If the room is silent, putting something on interrupts nothing, and *"put something on"*
  ought to mean music starts — otherwise the tool is a no-op an agent cannot distinguish from
  success, which is the worst of both.
- If the room is not silent, the user is listening to something and an agent does not get to
  take it off. The refusal **names the track it is protecting** and points at `ask_user`,
  which keeps the person in the loop by design rather than by hoping.

`refuse_while_playing` is pure and asserted, because on this wall **a refusal is the entire
guard** — there is nothing downstream to catch an agent that talks its way past one. Same
argument the billboard's refusals get, and `no_schema_offers_a_transport_verb` additionally
refuses to let either tool description grow a transport argument.

**The cost, written down rather than left to be discovered:** a *paused* track counts as
silent, so a load loses the position the user had paused at. That is deliberate — treating
paused as busy would make the tool refuse almost always, since a device that has ever played
sits paused for the rest of the day. If it turns out to be the wrong trade, it is the
`start_playing` value and the `audible` predicate, and nothing else.

### Whether audio is coming out is folded, not asked

`audible` reads `Replay::transition`, which the wall is already keeping, and `Wire::Playing` is
the only one of the three states that makes a noise. That is `CLAUDE.md`'s standing rule
applied rather than restated — when the thing you care about emits nothing, fold an event that
already exists near it — and it is why this whole boundary costs no new state, no poller and
no round trip. Anything here proposing to *ask* librespot what it is doing owes that argument.

### The access token is now kept, and the comment above `spotify_link` predates it

That comment still says the access token "is never written down". It was true while the only
thing needing one was a session. A catalogue search needs one *at search time*, so `TOKEN` in
`spotify.rs` holds it with its `expires_at`, and both `spotify_link` and `spotify_start`
populate it where the round trip has already been paid for rather than buying a second one a
moment later.

It is a `static` rather than a field on `Spotify` **because it outlives any session** — a card
may search with the player stopped, which is a question about the catalogue and not about the
device. Hanging it off the session would have made `records` answer *"not running"*, which is
not the truth about a search. A minute of skew, so a token cannot expire between the check
that accepted it and the request that used it. `spotify_forget` clears it, on the same
argument the file already makes for the session: a forgotten account whose token still answers
a search is the app disagreeing with itself.

### A fourth unproven leg, which `4951f398` does not list

Sink `4951f398` records that the integration has never played audio and names three unproven
legs: the OAuth flow, the token refresh, and playback. **There is a fourth, and it is specific
to `records`.**

Volery signs in with **librespot's borrowed client id** — Spotify's own desktop one, which is
how it reaches the `streaming` scope no registered app is granted. Whether tokens minted from
that client id are accepted by `api.spotify.com/v1/search` is **untested**. It is the one leg
that would sink the search half alone while leaving `put_on` working, so `fetch_search`
answers a 403 by saying exactly that rather than reporting an HTTP code — a card that hits it
should learn what it means rather than go looking in its own arguments.

### Running these tests

`cargo test` cannot run on this machine, and `check-gnu.sh --profile test` only *typechecks*
the assertions, which reads exactly like a green test run without being one. `bun
tools/lift-selector.ts` lifts the pure half into a throwaway and actually executes it — 26
assertions. It regenerates from `selector.rs` every run and keeps nothing, because a copy that
can go stale will, and it goes on passing while it does. Run it *and* `--profile test`: the
lift proves the bodies, and only the in-place check proves the paths.
