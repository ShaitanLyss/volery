---
paths:
  - "src/lib/spotify.ts"
  - "src/lib/spotify.svelte.ts"
  - "src/lib/Spotify.svelte"
  - "src-tauri/src/spotify.rs"
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

`Cargo.lock` holds it at `vergen 9.0.6` and that is the whole fix. Worth knowing precisely
because of how it will come back: **a `cargo update` unpins it**, and the error will arrive
with no Spotify in it at all. If this reappears, it is this, and the pin is
`cargo update -p vergen --precise 9.0.6`.

## Where the credential goes

The refresh material goes in the **Windows credential vault under
`dev.skein.studio/spotify`**, beside `dev.skein.studio/azdo-pat`, and keeps the `skein`
spelling for exactly the reason `vault.rs` gives for the other one: this is a name the *disk*
depends on, the visible rename to Volery was made explicitly provisional, and a credential
keyed to a product name that changes again is a token that silently vanishes on upgrade and
reads as the app having forgotten it.

Not the wall's own database — `store.rs` is an unencrypted SQLite file that `portage.rs`
exports layouts out of, and a token in a column there travels with them.
