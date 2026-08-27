---
paths:
  - "src/lib/spotify.ts"
  - "src/lib/spotify.svelte.ts"
  - "src/lib/Spotify.svelte"
  - "src-tauri/src/spotify.rs"
  - "src-tauri/src/selector.rs"
  - "test/spotify.test.ts"
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
