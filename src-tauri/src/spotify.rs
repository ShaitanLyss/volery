//! Being the player, rather than driving one.
//!
//! librespot is an open-source reimplementation of Spotify's *client* protocol:
//! it pulls the encrypted stream, decodes it and pushes PCM at WASAPI, and
//! registers as a Spotify Connect receiver so the wall turns up in the device
//! list on your phone. `.claude/rules/spotify.md` is the whole argument for why
//! this rather than the Web API — including the terms-of-service position,
//! which is a decision somebody made with the trade-off in front of them and is
//! not to be quietly re-decided here.
//!
//! ### Nothing in this file polls
//!
//! librespot hands out a `PlayerEvent` stream, so the wall's usual rule holds
//! without an argument: every reading the front end draws is a fold over events
//! that arrived. The one number that would tempt a clock — the playhead — is a
//! straight line between two events we are told about anyway, so
//! `PlayerConfig::position_update_interval` is deliberately left `None` and
//! `spotify.ts::positionAt` interpolates against the wall's existing tick. A
//! second clock for a number you can compute is the thing that rule exists to
//! stop.
//!
//! ### What the front end gets when it mounts late
//!
//! Events are only useful to something that was listening. A widget hung on the
//! wall halfway through a track would otherwise draw an empty box until the
//! next transition, which on a long track is minutes. So the last *sticky*
//! event of each kind is kept and handed back by `spotify_status`, and the
//! front end folds them through exactly the same `applyEvent` — same code path,
//! no second way of describing a state. `signin.rs` keeps its output buffer for
//! the same reason and says so.
//!
//! ### Threads
//!
//! The OAuth leg parks a thread on a human — it opens a browser and waits for
//! somebody to click — so it goes through `crate::off_main`, which is
//! `spawn_blocking` and is the pool built for exactly that. Everything else is
//! ordinary async I/O on the tokio workers. Nothing here spawns a child
//! process, so the job-object rule has nothing to bite on.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use librespot_connect::{ConnectConfig, LoadRequest, LoadRequestOptions, Spirc};
use librespot_core::authentication::Credentials;
use librespot_core::config::DeviceType;
use librespot_core::{Session, SessionConfig};
use librespot_metadata::audio::UniqueFields;
use librespot_playback::audio_backend;
use librespot_playback::config::{AudioFormat, PlayerConfig, VolumeCtrl};
use librespot_playback::mixer::{self, Mixer, MixerConfig};
use librespot_playback::player::{Player, PlayerEvent};

/* ── who we say we are ─────────────────────────────────────────────────────*/

/// Spotify's own client id, which is how librespot reaches scopes the public
/// Web API will not grant a registered app — and is therefore also the whole of
/// the terms-of-service question. Named here rather than buried so that anybody
/// reading this file meets it. See the rule.
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";

/// Spotify stopped accepting `localhost` in 2025 — it must be the loopback IP
/// literal. The port is librespot's own default, kept so the redirect matches
/// what the upstream project registered.
const REDIRECT_URI: &str = "http://127.0.0.1:5588/login";

/// `streaming` is the one that matters and the one a custom client id cannot
/// have. The rest are what a face needs to draw the thing it is controlling.
const SCOPES: &[&str] = &[
    "streaming",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
];

/// Beside `dev.skein.studio/azdo-pat`, and keeping the `skein` spelling for the
/// reason `vault.rs` gives at length: this is a name the *disk* depends on, and
/// a credential keyed to a product name that changes again is a token that
/// silently vanishes on upgrade.
const VAULT_TARGET: &str = "dev.skein.studio/spotify";
const VAULT_WHO: &str = "spotify (volery)";

/* ── the wire ──────────────────────────────────────────────────────────────*/

#[derive(Clone, Serialize)]
pub struct TrackOut {
    pub id: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u32,
    pub art: Option<String>,
    pub explicit: bool,
    pub kind: &'static str,
}

/// Narrower than `PlayerEvent` on purpose. `Preloading`,
/// `TimeToPreloadNextTrack` and `EndOfTrack` are notes the player passes to
/// itself, and drawing them would be reporting our own plumbing back at
/// somebody. Internally tagged, matching `SpotifyEvent` in `spotify.ts`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum Wire {
    #[serde(rename = "session")]
    Session { device: String },
    #[serde(rename = "closed")]
    Closed { fault: Option<String> },
    #[serde(rename = "linking")]
    Linking,
    /// Signing in is *done* and the receiver is coming up. A separate state
    /// from `Linking` because the two were drawn as one, and the one that
    /// reported this bug was reading "waiting for the browser…" off a widget
    /// whose browser leg had finished six minutes earlier. Three legs under one
    /// word is a face that says something false for as long as the longest of
    /// them takes.
    #[serde(rename = "opening")]
    Opening,
    #[serde(rename = "track")]
    Track { track: TrackOut },
    #[serde(rename = "loading")]
    Loading {
        #[serde(rename = "positionMs")]
        position_ms: u32,
    },
    #[serde(rename = "playing")]
    Playing {
        #[serde(rename = "positionMs")]
        position_ms: u32,
    },
    #[serde(rename = "paused")]
    Paused {
        #[serde(rename = "positionMs")]
        position_ms: u32,
    },
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "seeked")]
    Seeked {
        #[serde(rename = "positionMs")]
        position_ms: u32,
    },
    #[serde(rename = "volume")]
    Volume { volume: u16 },
    #[serde(rename = "shuffle")]
    Shuffle { shuffle: bool },
    #[serde(rename = "repeat")]
    Repeat { repeat: &'static str },
    #[serde(rename = "unavailable")]
    Unavailable,
}

/* ── what is running ───────────────────────────────────────────────────────*/

/// The sticky events, kept so a face that mounts mid-track has something to
/// draw. Only the ones that describe a *standing* condition — a `seeked` is a
/// correction to a state, not a state, so it is not kept.
#[derive(Default)]
struct Replay {
    session: Option<Wire>,
    track: Option<Wire>,
    transition: Option<Wire>,
    volume: Option<Wire>,
    shuffle: Option<Wire>,
    repeat: Option<Wire>,
}

impl Replay {
    /// In the order a fold wants them: the session exists before a track is in
    /// it, and a track exists before it is playing.
    fn events(&self) -> Vec<Wire> {
        [
            &self.session,
            &self.volume,
            &self.shuffle,
            &self.repeat,
            &self.track,
            &self.transition,
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect()
    }

    fn note(&mut self, ev: &Wire) {
        match ev {
            /* One slot for the four things the session can be doing, because
               they are mutually exclusive and a face that mounts halfway
               through a sign-in should draw the sign-in rather than "not signed
               in" — the same argument the replay exists for at all. `Closed`
               resets the whole struct below, which is the fourth. */
            Wire::Session { .. } | Wire::Linking | Wire::Opening => {
                self.session = Some(ev.clone())
            }
            Wire::Track { .. } => self.track = Some(ev.clone()),
            Wire::Playing { .. } | Wire::Paused { .. } | Wire::Loading { .. } => {
                self.transition = Some(ev.clone())
            }
            Wire::Stopped => {
                self.track = None;
                self.transition = None;
            }
            Wire::Volume { .. } => self.volume = Some(ev.clone()),
            Wire::Shuffle { .. } => self.shuffle = Some(ev.clone()),
            Wire::Repeat { .. } => self.repeat = Some(ev.clone()),
            Wire::Closed { .. } => *self = Replay::default(),
            _ => {}
        }
    }
}

struct Live {
    spirc: Spirc,
    mixer: Arc<dyn Mixer>,
    device: String,
}

#[derive(Default)]
pub struct Spotify {
    live: Mutex<Option<Live>>,
    replay: Mutex<Replay>,
}

#[derive(Serialize)]
pub struct Status {
    /// Whether there is a credential in the vault — *not* whether it still works.
    /// The two are different questions and only one can be answered for free.
    linked: bool,
    running: bool,
    device: String,
    /// For a face that mounted late; fold these through `applyEvent`.
    replay: Vec<Wire>,
}

/* ── emitting ──────────────────────────────────────────────────────────────*/

fn emit(app: &AppHandle, state: &Spotify, ev: Wire) {
    if let Ok(mut replay) = state.replay.lock() {
        replay.note(&ev);
    }
    let _ = app.emit("spotify:event", ev);
}

/* ── turning librespot's events into ours ──────────────────────────────────*/

/// Spotify's cover art comes in several sizes; a widget is small and the wall
/// is zoomable, so the *largest* is the wrong default and the smallest goes
/// soft the moment somebody zooms in. Middle if there is one, else the biggest
/// thing offered.
fn pick_art(item: &librespot_metadata::audio::AudioItem) -> Option<String> {
    if item.covers.is_empty() {
        return None;
    }
    let mut sorted: Vec<_> = item.covers.iter().collect();
    sorted.sort_by_key(|c| c.width);
    let pick = sorted.get(sorted.len() / 2).or_else(|| sorted.last())?;
    Some(pick.url.clone())
}

fn describe_track(item: &librespot_metadata::audio::AudioItem) -> TrackOut {
    let (artists, album, kind) = match &item.unique_fields {
        UniqueFields::Track {
            artists, album, ..
        } => (
            artists.iter().map(|a| a.name.clone()).collect(),
            album.clone(),
            "track",
        ),
        UniqueFields::Episode { show_name, .. } => {
            (vec![show_name.clone()], show_name.clone(), "episode")
        }
        UniqueFields::Local {
            artists, album, ..
        } => (
            artists.clone().map(|a| vec![a]).unwrap_or_default(),
            album.clone().unwrap_or_default(),
            "local",
        ),
    };

    TrackOut {
        id: item.uri.clone(),
        name: item.name.clone(),
        artists,
        album,
        duration_ms: item.duration_ms,
        art: pick_art(item),
        explicit: item.is_explicit,
        kind,
    }
}

/// `None` for the events that are the player talking to itself.
fn narrow(ev: PlayerEvent) -> Option<Wire> {
    Some(match ev {
        PlayerEvent::TrackChanged { audio_item } => Wire::Track {
            track: describe_track(&audio_item),
        },
        PlayerEvent::Loading { position_ms, .. } => Wire::Loading { position_ms },
        PlayerEvent::Playing { position_ms, .. } => Wire::Playing { position_ms },
        PlayerEvent::Paused { position_ms, .. } => Wire::Paused { position_ms },
        PlayerEvent::Seeked { position_ms, .. } => Wire::Seeked { position_ms },
        PlayerEvent::PositionCorrection { position_ms, .. } => Wire::Seeked { position_ms },
        PlayerEvent::PositionChanged { position_ms, .. } => Wire::Seeked { position_ms },
        PlayerEvent::Stopped { .. } => Wire::Stopped,
        PlayerEvent::Unavailable { .. } => Wire::Unavailable,
        PlayerEvent::VolumeChanged { volume } => Wire::Volume { volume },
        PlayerEvent::ShuffleChanged { shuffle } => Wire::Shuffle { shuffle },
        PlayerEvent::RepeatChanged { context, track } => Wire::Repeat {
            /* Track beats context: repeating one track inside a repeating
               context is still, to anybody looking at it, one track on loop. */
            repeat: if track {
                "track"
            } else if context {
                "context"
            } else {
                "off"
            },
        },
        _ => return None,
    })
}

/* ── signing in ────────────────────────────────────────────────────────────*/

/// The browser leg. Opens Spotify's own authorize page and runs a one-shot
/// loopback server for the redirect, which is the same shape `signin.rs` uses
/// for Claude — and the reason neither of them needs a terminal.
///
/// What is stored is the **refresh** token: the long-lived half, and the only
/// one worth keeping across a launch. The access token it buys is good for an
/// hour and is held in `TOKEN` for as long as it lasts, because `records` needs
/// one at search time — see that static, whose comment corrects the "never
/// written down" this one used to claim.
///
/// **This leg is deliberately unbounded**, because the thing it waits on is a
/// person: librespot parks a thread on the loopback listener until the redirect
/// arrives, and a browser tab somebody has not got to yet is not a failure.
/// The cost is that abandoning the sign-in leaves the deck's `busy` set for the
/// life of the process, since there is nothing to cancel a blocking accept with
/// and nothing that could take port 5588 back. Everything *after* this leg is
/// bounded — see `CONNECT_BUDGET` — which is where the four unexplained
/// minutes actually were.
#[tauri::command]
pub async fn spotify_link(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<Spotify>();
        emit(&app, &state, Wire::Linking);
    }

    let token = crate::off_main(move || {
        librespot_oauth::OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, SCOPES.to_vec())
            .open_in_browser()
            .build()
            .map_err(|e| format!("could not start the sign-in: {e}"))?
            .get_access_token()
            .map_err(|e| format!("spotify would not sign you in: {e}"))
    })
    .await?;

    /* Emitted as well as returned, for the reason `spotify_start` gives at
       length: a `Linking` left standing in the replay is every *other* face on
       the wall drawing a sign-in that has already failed. */
    let token = match token {
        Err(fault) => {
            let state = app.state::<Spotify>();
            emit(
                &app,
                &state,
                Wire::Closed {
                    fault: Some(fault.clone()),
                },
            );
            return Err(fault);
        }
        Ok(t) => t,
    };

    crate::vault::store_at(VAULT_TARGET, VAULT_WHO, &token.refresh_token)?;
    /* The browser leg has just paid for a token exchange; `records` wants
       exactly this string. Same bargain `refresh_stored` strikes one leg on. */
    remember(&token.access_token, token.expires_at);
    Ok(())
}

/// Forget the credential. The session, if one is up, goes with it — a signed-out
/// account that is still playing is the app disagreeing with itself.
#[tauri::command]
pub async fn spotify_forget(app: AppHandle) -> Result<(), String> {
    stop_inner(&app);
    crate::vault::clear_at(VAULT_TARGET)?;
    /* The same argument the session makes one line up: an account that has been
       forgotten but whose token still answers a `records` search is the app
       disagreeing with itself. */
    forget_token();
    let state = app.state::<Spotify>();
    emit(&app, &state, Wire::Closed { fault: None });
    Ok(())
}

/* ── running ───────────────────────────────────────────────────────────────*/

/// Bring the receiver up: refresh the stored credential into an access token,
/// connect a session, start a player and a Connect device, and pump librespot's
/// events at the front end.
#[tauri::command]
pub async fn spotify_start(app: AppHandle, name: Option<String>) -> Result<(), String> {
    /* Every failure below is emitted as well as returned, and the wrapper is
       the whole of why: a `?` here reaches only whoever pressed the button,
       while the *wall* has however many faces on it and a `Linking` sitting in
       the replay. So a card that never asked, and a widget hung up after the
       press, both went on drawing "waiting for the browser…" for a sign-in that
       had already failed. `Closed { fault }` is a state; a returned string is a
       reply. This subsystem owes both. */
    let outcome = start_inner(&app, name).await;
    if let Err(fault) = &outcome {
        let state = app.state::<Spotify>();
        emit(
            &app,
            &state,
            Wire::Closed {
                fault: Some(fault.clone()),
            },
        );
    }
    outcome
}

/// How long one attempt at bringing the receiver up gets before it is called a
/// failure. One attempt is one `Spirc::new`, which opens the session, takes a
/// client token, registers the dealer listeners and asks for a device.
///
/// librespot bounds none of it, and its *internal* bound on the access-point
/// leg alone is nowhere near tight enough to be a reading on a wall: six access
/// points, two attempts each, and only the handshake sits inside its own 5s
/// timeout — the TCP connect is built outside it, so every attempt costs the OS
/// its full SYN timeout. Measured 2026-08-28 with a black-holed address:
/// **253 seconds** to reach "Tried too many access points". Four minutes of a
/// card looking frozen is not a diagnosis, and the honest answer arrives long
/// before the exhaustive one — through the tunnel a reachable access point
/// authenticates in about two.
///
/// Two rungs, so the worst case a person waits is twice this.
const CONNECT_BUDGET: Duration = Duration::from_secs(30);

/// The one port everything can be on, and **443 is not a preference here — it is
/// the only value that works.**
///
/// Setting `proxy` (which `tunnel.rs` requires) makes `ApResolver::port_config`
/// return `ap_port.unwrap_or(443)`, and `process_ap_strings` then filters *every*
/// endpoint list by it. Not just the access points — the **dealer** and
/// **spclient** lists go through the same filter, and apresolve offers those on
/// one port only. Measured 2026-08-28:
///
/// | endpoint | ports offered |
/// |---|---|
/// | `accesspoint` | 4070, 443, 80 |
/// | `dealer` | **443 only** |
/// | `spclient` | **443 only** |
///
/// So `ap_port: Some(4070)` empties the dealer list, and empties it again when
/// `apresolve` adds its fallbacks, because those are filtered by the same rule.
/// `Spirc::new` then dies on `No access point available for endpoint dealer`,
/// its task exits immediately, and every later `put_on` answers *"channel
/// closed"* against a handle whose task is gone. That is what shipped in 0.14.4
/// and it looked nothing like a port problem: the session authenticated, the
/// widget said "ready, nothing playing", and there was no session at all.
///
/// This was a ladder, `[4070, 443]`, on the reasoning that 4070 is Spotify's own
/// first preference and a firewall might block it. Both rungs had been probed
/// and both "worked" — because the probe called `session.connect` and stopped,
/// and the access point is the one endpoint 4070 is valid for. **The same
/// mistake as the `Spirc::new` bug one section down, made again while fixing
/// it**: a probe that runs a different sequence from the app has not tested the
/// app. Two failures from one habit in one afternoon is the argument for
/// exercising the whole call, not the leg you are thinking about.
///
/// There is nothing to ladder. A network that blocks 443 blocks the dealer too,
/// and no choice here recovers from that.
const AP_PORT: u16 = 443;

async fn start_inner(app: &AppHandle, name: Option<String>) -> Result<(), String> {
    {
        let state = app.state::<Spotify>();
        if state.live.lock().unwrap().is_some() {
            return Ok(()); /* already up; asking twice is not an error */
        }
        emit(app, &state, Wire::Opening);
    }

    /* The refresh is a network round trip against accounts.spotify.com. Off the
       main thread for the reason every outbound call in this app is: blocking
       there stops the whole wall being painted, not just this command.
       `refresh_stored` is also what keeps the rotated credential — see its own
       comment, and the bug it records. */
    let token = crate::off_main(refresh_stored).await??;

    let device = name.unwrap_or_else(|| "volery".to_string());
    let credentials = Credentials::with_access_token(token.access_token);

    /* Everything goes through our own loopback tunnel, which prefers IPv4 —
       without it librespot dials the first address `getaddrinfo` hands it and
       never another, and on the network this was found on that address is a
       black hole for every access point. `tunnel.rs` has the measurement. */
    let proxy = crate::tunnel::endpoint()?;

    let backend = audio_backend::find(None).ok_or("no audio backend was built in")?;
    let mixer_fn = mixer::find(None).ok_or("no mixer was built in")?;

    /* **`Spirc::new` opens the session itself** — `spirc.rs`, right after it has
       registered its dealer listeners:

           // Connect *after* all message listeners are registered
           session.connect(credentials, true).await?;

       and the ordering in that comment is the reason it is done there rather
       than by the caller. So this must NOT connect first. It used to, and the
       second connect then failed on a `OnceCell` that was already set —
       `tx_connection.set(..).map_err(|_| SessionError::NotConnected)` — which
       surfaced as the splendidly misleading *"spotify would not accept this
       device: service unavailable (session is not connected)"* about a session
       that was connected perfectly well.

       That bug shipped with the integration and was unreachable until 0.14.3,
       because until the tunnel existed the *first* connect never succeeded on
       the network it was written on. Worth remembering the shape: **fixing an
       outer failure is how you find out what the inner one was**, and a leg
       that has never run is not a leg that works.

       So the whole attempt is one call. There is no port ladder around it — see
       `AP_PORT` for why there is exactly one value that can work. */
    let session = Session::new(
        SessionConfig {
            proxy: Some(proxy.clone()),
            ap_port: Some(AP_PORT),
            ..Default::default()
        },
        None,
    );

    /* **Linear, not librespot's default.** `VolumeCtrl::default()` is
       `Log(60 dB)`, which maps a half-volume slider to *3.16%* amplitude —
       measured 2026-08-28 from librespot's own log line, `Input volume 32767
       mapped to: 3.16%`, and reported as "i hear music / low tho" the first time
       audio ever came out of this app.
       |  slider | Log(60) | Cubic(60) | Linear |
       |---|---|---|---|
       |  50% | 3.16% (-30dB) | 12.5% (-18dB) | 50% (-6dB) |
       The curve is wrong here rather than merely aggressive, and the reason is
       that **Spotify has already applied one**. Connect volume is a plain
       0..65535 device level; the perceptual shaping happens in the slider you
       actually drag, in Spotify's own client, before the number is sent. Putting
       a second curve under it is double-mapping, which is the whole of the 3%.
       It also makes the wall honest: `spotify.ts`'s `volumeFromWire` is
       `v / 65535`, so any curve here is a reading that disagrees with the
       number beside it. */
    let mixer = mixer_fn(MixerConfig {
        volume_ctrl: VolumeCtrl::Linear,
        ..Default::default()
    })
    .map_err(|e| format!("could not open the mixer: {e}"))?;

    /* position_update_interval stays None — see the note at the top of the file.
       `backend` is a plain `fn` pointer (`SinkBuilder`), so it is Copy. */
    let player = Player::new(
        PlayerConfig::default(),
        session.clone(),
        mixer.get_soft_volume(),
        move || backend(None, AudioFormat::default()),
    );
    let mut events = player.get_player_event_channel();

    let connect = ConnectConfig {
        name: device.clone(),
        device_type: DeviceType::Computer,
        ..Default::default()
    };

    /* Bounded, because librespot bounds none of this and its own worst case is
       four minutes of silence. */
    let (spirc, task) = match tokio::time::timeout(
        CONNECT_BUDGET,
        Spirc::new(connect, session, credentials, player, mixer.clone()),
    )
    .await
    {
        Err(_) => {
            return Err(format!(
                "spotify did not answer within {}s",
                CONNECT_BUDGET.as_secs()
            ))
        }
        Ok(Err(e)) => return Err(format!("spotify would not open a session: {e}")),
        Ok(Ok(v)) => v,
    };

    /* **Awaited rather than abandoned**, and that is the whole of the second bug
       0.14.4 shipped. The handle used to be dropped on the floor, so when the
       Spirc task ended the wall was told nothing: the widget went on saying
       "ready, nothing playing" over a device that no longer existed, and the
       only way to find out was to try to use it and get "channel closed" back
       from a handle whose task was gone.
       A task ending is the session ending — `SpircTask::run` loops until the
       session goes invalid or it is told to shut down — so it is exactly the
       event `Closed` exists for. Folding it is CLAUDE.md's standing rule applied
       where it had been skipped: the event already existed and nobody listened.
       `stop_inner` has taken `live` already on a deliberate stop, so this leaves
       the state alone in that case rather than reporting a shutdown as a fault. */
    let ended = app.clone();
    tauri::async_runtime::spawn(async move {
        task.await;
        let state = ended.state::<Spotify>();
        let was_live = state.live.lock().map(|l| l.is_some()).unwrap_or(false);
        if !was_live {
            return; /* someone asked for this; `spotify_stop` has said so. */
        }
        let _ = state.live.lock().map(|mut l| l.take());
        emit(
            &ended,
            &state,
            Wire::Closed {
                fault: Some(
                    "the spotify session ended — the wall is no longer a device".to_string(),
                ),
            },
        );
    });

    /* One pump, ending when librespot closes the channel — which it does when
       the player is dropped, so there is nothing here to leak or to release. */
    let pump = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = events.recv().await {
            if let Some(wire) = narrow(ev) {
                let state = pump.state::<Spotify>();
                emit(&pump, &state, wire);
            }
        }
    });

    {
        let state = app.state::<Spotify>();
        *state.live.lock().unwrap() = Some(Live {
            spirc,
            mixer,
            device: device.clone(),
        });
        emit(app, &state, Wire::Session { device });
    }
    Ok(())
}

fn stop_inner(app: &AppHandle) {
    let state = app.state::<Spotify>();
    let taken = state.live.lock().unwrap().take();
    if let Some(live) = taken {
        /* Best effort: if spirc has already gone there is nothing to shut down
           and saying so would be noise. */
        let _ = live.spirc.shutdown();
    }
}

#[tauri::command]
pub async fn spotify_stop(app: AppHandle) -> Result<(), String> {
    stop_inner(&app);
    let state = app.state::<Spotify>();
    emit(&app, &state, Wire::Closed { fault: None });
    Ok(())
}

/// Put something on, because **you** asked — which is a different question from
/// a card asking, and deliberately a different door.
///
/// `put_on` consults `selector::refuse_while_playing` and stops if the room is
/// not silent. That guard is the user's own scoping, in their words: an agent
/// may choose music but may not take off what somebody is listening to. It
/// would be nonsense applied here. **You are the person it protects**, and a
/// search result you clicked that refused to play because something was already
/// playing would be the app telling you not to change your mind.
///
/// So this shares the load and shares nothing of the refusal, and the asymmetry
/// is the design rather than an oversight. Anything tempted to collapse the two
/// into one command with a `force` flag should read `selector.rs`'s header
/// first: a flag is a thing an agent can set.
#[tauri::command]
pub async fn spotify_play(app: AppHandle, uri: String) -> Result<(), String> {
    let (uri, kind) = crate::selector::normalize_uri(&uri)?;
    let as_context = crate::selector::is_context(&kind);

    let state = app.state::<Spotify>();
    let live = state.live.lock().unwrap();
    let live = live
        .as_ref()
        .ok_or_else(|| "spotify is not running — sign in from the widget first".to_string())?;

    let options = LoadRequestOptions {
        start_playing: true,
        ..Default::default()
    };
    let request = if as_context {
        LoadRequest::from_context_uri(uri, options)
    } else {
        LoadRequest::from_tracks(vec![uri], options)
    };

    /* Activate first, for the reason `put_on` gives at length: a registered
       device is not an active one, and a load handed to an inactive Spirc is
       discarded with a warning while `load` still answers `Ok`. */
    live.spirc
        .activate()
        .map_err(|e| format!("spotify would not make the wall the active device: {e}"))?;
    live.spirc
        .load(request)
        .map_err(|e| format!("spotify would not put that on: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn spotify_status(state: State<'_, Spotify>) -> Status {
    let live = state.live.lock().unwrap();
    Status {
        linked: crate::vault::held_at(VAULT_TARGET),
        running: live.is_some(),
        device: live
            .as_ref()
            .map(|l| l.device.clone())
            .unwrap_or_else(|| "volery".to_string()),
        replay: state
            .replay
            .lock()
            .map(|r| r.events())
            .unwrap_or_default(),
    }
}

/* ── choosing what plays ───────────────────────────────────────────────────
 *
 * The half of this file that `selector.rs` stands on. Everything
 * credential-shaped stays here on purpose — `CLIENT_ID`, `SCOPES` and
 * `VAULT_TARGET` are private to this file, so no second module can grow its own
 * opinion about how this app signs in to Spotify. */

/// The access token, and the moment it stops working.
///
/// `spotify_link` and `spotify_start` both mint one of these and both used to
/// drop it, on the argument that the access token "is never written down" —
/// which was true while the only thing needing one was a session. A catalogue
/// search needs one *at search time*, so it is kept, and `spotify_link`'s own
/// comment no longer claims otherwise.
///
/// A `static` rather than a field on `Spotify` because it outlives any session:
/// a card may search with the player stopped, which is a question about Spotify
/// rather than about the device. Hanging it off the session would have coupled
/// the two for no reason and made `records` fail with "not running", which is
/// not the truth about a search.
static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Treat a token as dead this long before it actually is, so one cannot expire
/// between the check that accepted it and the request that used it. A minute is
/// far longer than a search takes, and costs at most one extra refresh an hour.
const SKEW: Duration = Duration::from_secs(60);

fn remember(token: &str, expires_at: Instant) {
    if let Ok(mut held) = TOKEN.lock() {
        *held = Some((token.to_string(), expires_at));
    }
}

/// Spend the stored credential for a working access token — and **put the
/// credential Spotify hands back in its place**, which is the whole reason this
/// is one function rather than the three copies it replaces.
///
/// Spotify's authorization-code-with-PKCE flow **rotates the refresh token**:
/// every successful refresh answers with a *new* one and revokes the one that
/// bought it. Three call sites here each did the refresh and each dropped the
/// new token — so the first refresh of a session poisoned the vault, and
/// everything afterwards failed on a credential Spotify had already retired.
/// Probed 2026-08-28 by refreshing the stored token by hand after one
/// `spotify_start`: `invalid_grant: Refresh token revoked`. It reads as the app
/// having forgotten the account, and the only way out was signing in again —
/// once per launch, for as long as it stood.
///
/// The write is best-effort on purpose. A rotation we could not store is a
/// credential that will fail *next* time, and refusing to hand back a token
/// that works right now would turn that into a failure *this* time as well.
///
/// Blocking — a round trip against accounts.spotify.com. Callers on the main
/// thread or a tokio worker owe it an `off_main`; see `lib.rs`.
fn refresh_stored() -> Result<librespot_oauth::OAuthToken, String> {
    let refresh = crate::vault::read_at(VAULT_TARGET).ok_or_else(|| {
        "no spotify account is linked — sign in from the widget on the wall".to_string()
    })?;

    let token = librespot_oauth::OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, SCOPES.to_vec())
        .build()
        .map_err(|e| format!("could not reach spotify: {e}"))?
        .refresh_token(&refresh)
        .map_err(|e| format!("spotify would not renew the sign-in: {e}"))?;

    /* `build_token` fills this with "" when the response carried none, and its
       own comment says Spotify always sends one — so an empty string is a
       Spotify that changed rather than a rotation to store. */
    if !token.refresh_token.is_empty() && token.refresh_token != refresh {
        let _ = crate::vault::store_at(VAULT_TARGET, VAULT_WHO, &token.refresh_token);
    }

    remember(&token.access_token, token.expires_at);
    Ok(token)
}

fn forget_token() {
    if let Ok(mut held) = TOKEN.lock() {
        *held = None;
    }
}

/// A token that works right now, refreshing the stored credential if the cached
/// one has run out.
///
/// Blocking when the cache misses — a round trip against accounts.spotify.com.
/// Called from the MCP request thread, which `ask::start` gives its own thread
/// per request, so it parks the card that asked and nothing else on the wall.
/// **Not to be called from a `#[tauri::command]` that is not `async`**; see
/// `off_main` in `lib.rs` for what blocking the main thread costs.
pub(crate) fn access_token() -> Result<String, String> {
    if let Ok(held) = TOKEN.lock() {
        if let Some((tok, dies)) = held.as_ref() {
            if *dies > Instant::now() + SKEW {
                return Ok(tok.clone());
            }
        }
    }

    /* Asked before refreshing, only so the wording is right: `refresh_stored`
       is shared with the wall's own face, whose reader can act on "sign in from
       the widget", and a card's cannot. Linking is not something a card can do,
       and a refusal that does not say so sends it looking for a tool. */
    if !crate::vault::held_at(VAULT_TARGET) {
        return Err("no spotify account is linked — the user links one from the wall, and \
                    linking is not something a card can do"
            .to_string());
    }

    /* `refresh_stored` writes the rotated credential back and remembers the
       access token, so there is nothing left here but handing it over. */
    Ok(refresh_stored()?.access_token)
}

/// Whether audio is actually coming out of the wall.
///
/// Read off the replay fold rather than asked of librespot, because the wall is
/// already keeping it: `Replay::transition` holds the last standing state event
/// and `Wire::Playing` is the only one of the three that makes a sound. That is
/// `CLAUDE.md`'s rule about folding an event that already exists instead of
/// adding a fourth thing that goes and looks — and it is why this whole
/// boundary costs no new state, no poller and no round trip.
fn audible(state: &Spotify) -> bool {
    state
        .replay
        .lock()
        .map(|r| matches!(r.transition, Some(Wire::Playing { .. })))
        .unwrap_or(false)
}

/// What is on, so a refusal can name it. Empty when nothing is loaded.
fn now_playing(state: &Spotify) -> String {
    state
        .replay
        .lock()
        .ok()
        .and_then(|r| match r.track.as_ref() {
            Some(Wire::Track { track }) => Some(match track.artists.first() {
                Some(who) => format!("{} — {}", track.name, who),
                None => track.name.clone(),
            }),
            _ => None,
        })
        .unwrap_or_default()
}

/// Put a selection on, or refuse because the user is listening to something.
///
/// The refusal itself is `selector::refuse_while_playing`, which lives over
/// there so the boundary is one pure testable function; this is the half that
/// needs the handle. Nothing here emits an event — librespot's own pump will
/// announce the new track, which is the honest order: the wall draws what
/// happened rather than what was asked for.
pub(crate) fn put_on(app: &AppHandle, uri: &str, as_context: bool) -> Result<String, String> {
    let state = app.state::<Spotify>();

    if let Some(refusal) = crate::selector::refuse_while_playing(
        audible(state.inner()),
        Some(&now_playing(state.inner())),
    ) {
        return Ok(refusal);
    }

    let live = state.live.lock().unwrap();
    let live = live.as_ref().ok_or_else(|| {
        "the wall's spotify player is not running — the user starts it from the \
         widget on the wall, and starting it is not something a card can do"
            .to_string()
    })?;

    /* `start_playing` is the whole judgement call, and by the time control is
       here the room is demonstrably silent — so putting something on means it
       starts, or the tool is a no-op a card cannot tell from success. The
       reasoning, and what it costs a paused listener, is at the top of
       `selector.rs`. */
    let options = LoadRequestOptions {
        start_playing: true,
        ..Default::default()
    };
    let request = if as_context {
        LoadRequest::from_context_uri(uri.to_string(), options)
    } else {
        LoadRequest::from_tracks(vec![uri.to_string()], options)
    };

    /* **Activate first, or the load is dropped on the floor.** A registered
       Connect device is not an *active* one, and `SpircTask` answers a load it
       is given while inactive with
           WARN  SpircCommand::Load(..) will be ignored while Not Active
       — a warning, into a log this app does not install a sink for, and `load`
       itself still returns `Ok`. So without this the tool reported success, the
       card believed it, and nothing played. Measured 2026-08-28; it is the last
       of the four legs sink `4951f398` listed and the only one that failed
       *silently*.
       Unconditional because it is idempotent: already-active answers with its
       own warning and changes nothing. */
    live
        .spirc
        .activate()
        .map_err(|e| format!("spotify would not make the wall the active device: {e}"))?;

    live.spirc
        .load(request)
        .map_err(|e| format!("spotify would not put that on: {e}"))?;

    Ok(format!(
        "put {uri} on — the wall was quiet, so it is playing now. the user can \
         pause or change it from the widget; you cannot, by design."
    ))
}

/* ── the transport ─────────────────────────────────────────────────────────*/

/// One command rather than nine, because every one of them is the same shape —
/// take the lock, ask spirc, report what it said — and nine copies of that is
/// nine places for the lock handling to drift.
#[tauri::command]
pub fn spotify_command(
    state: State<'_, Spotify>,
    verb: String,
    value: Option<f64>,
) -> Result<(), String> {
    let live = state.live.lock().unwrap();
    let live = live.as_ref().ok_or("spotify is not running")?;

    let n = value.unwrap_or(0.0);
    let done = match verb.as_str() {
        "play" => live.spirc.play(),
        "pause" => live.spirc.pause(),
        "playpause" => live.spirc.play_pause(),
        "next" => live.spirc.next(),
        "prev" => live.spirc.prev(),
        "shuffle" => live.spirc.shuffle(n != 0.0),
        "repeat" => live.spirc.repeat(n != 0.0),
        "repeatTrack" => live.spirc.repeat_track(n != 0.0),
        "seek" => live.spirc.set_position_ms(n.max(0.0) as u32),
        "volume" => {
            /* The clamp is here as well as in `spotify.ts` because this is a
               command and anything can call it — a wall being driven over the
               control surface, most obviously. */
            let v = n.clamp(0.0, 65535.0) as u16;
            live.mixer.set_volume(v);
            live.spirc.set_volume(v)
        }
        other => return Err(format!("no such spotify command: {other}")),
    };

    done.map_err(|e| format!("spotify would not do that: {e}"))
}
