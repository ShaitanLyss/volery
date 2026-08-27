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

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use librespot_connect::{ConnectConfig, Spirc};
use librespot_core::authentication::Credentials;
use librespot_core::config::DeviceType;
use librespot_core::{Session, SessionConfig};
use librespot_metadata::audio::UniqueFields;
use librespot_playback::audio_backend;
use librespot_playback::config::{AudioFormat, PlayerConfig};
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
            Wire::Session { .. } => self.session = Some(ev.clone()),
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
/// What is kept afterwards is the **refresh** token, and only that: it is the
/// long-lived half, and the access token it buys is good for an hour and is
/// never written down.
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
    .await??;

    crate::vault::store_at(VAULT_TARGET, VAULT_WHO, &token.refresh_token)?;
    Ok(())
}

/// Forget the credential. The session, if one is up, goes with it — a signed-out
/// account that is still playing is the app disagreeing with itself.
#[tauri::command]
pub async fn spotify_forget(app: AppHandle) -> Result<(), String> {
    stop_inner(&app);
    crate::vault::clear_at(VAULT_TARGET)?;
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
    if app.state::<Spotify>().live.lock().unwrap().is_some() {
        return Ok(()); /* already up; asking twice is not an error */
    }

    let refresh = crate::vault::read_at(VAULT_TARGET)
        .ok_or_else(|| "no spotify account is linked".to_string())?;

    /* The refresh is a network round trip against accounts.spotify.com. Off the
       main thread for the reason every outbound call in this app is: blocking
       there stops the whole wall being painted, not just this command. */
    let token = crate::off_main(move || {
        librespot_oauth::OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, SCOPES.to_vec())
            .build()
            .map_err(|e| format!("could not reach spotify: {e}"))?
            .refresh_token(&refresh)
            .map_err(|e| format!("spotify would not renew the sign-in: {e}"))
    })
    .await??;

    let device = name.unwrap_or_else(|| "volery".to_string());
    let session = Session::new(SessionConfig::default(), None);
    let credentials = Credentials::with_access_token(token.access_token);

    session
        .connect(credentials.clone(), false)
        .await
        .map_err(|e| format!("spotify would not open a session: {e}"))?;

    let backend = audio_backend::find(None).ok_or("no audio backend was built in")?;
    let mixer_fn = mixer::find(None).ok_or("no mixer was built in")?;
    let mixer = mixer_fn(MixerConfig::default())
        .map_err(|e| format!("could not open the mixer: {e}"))?;

    /* position_update_interval stays None — see the note at the top of the file. */
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

    let (spirc, task) = Spirc::new(connect, session, credentials, player, mixer.clone())
        .await
        .map_err(|e| format!("spotify would not accept this device: {e}"))?;

    tauri::async_runtime::spawn(task);

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
        emit(&app, &state, Wire::Session { device });
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
