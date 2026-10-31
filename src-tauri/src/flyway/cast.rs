//! A screen across the flyway: the vocabulary of the media connection. Pure;
//! `link/cast.rs` is the wiring and `wire.rs` the transport.
//!
//! `docs/SCREENS.md` is the contract this serves. What crosses is exactly what
//! the loopback socket carries (`cast::wire`) — the host's hub encodes once and
//! both are dumb pipes over its `Out`s — so everything here is about *carrying*:
//! which QUIC shape each message rides, how it is sealed, and what the path is
//! allowed to cost.
//!
//! ### Why a connection is held open now, when nothing else holds one
//!
//! `link.rs` argued a held connection would pay for itself "when a live
//! transcript" arrived. A screen is that and more: sixty frames a second, a
//! handshake per frame would be the whole latency budget, and the shapes that
//! matter — a stream per frame, datagrams — only exist inside one connection.
//! So there is **one per (viewer wall, host wall) pair while any screen between
//! them is open**, on its own ALPN, and every screen between the two walls is a
//! session multiplexed on it by a `sid` the viewer picks.
//!
//! ### Which shape each message rides
//!
//! - **Video: a unidirectional stream per frame.** A lost packet delays the
//!   frame it belongs to and never the ones behind it, which a single stream
//!   would. A keyframe's stream also carries the `config` text in front of it:
//!   the front must have the config before the first keyframe of a new shape,
//!   and a config on the control stream would race the frame on its own stream.
//!   Riding together they cannot be reordered, and a config the viewer has
//!   already forwarded is not forwarded twice (`Configs`).
//! - **Control** — open, want, key, close, refusals, state/stats texts, cursor
//!   shapes, and the input that must not be lost (keys, buttons, release-all):
//!   one bidirectional stream of length-prefixed sealed messages. A lost key-up
//!   is a key held down for ever.
//! - **Datagrams** — mouse moves, the wheel, the cursor's position, and the
//!   clock pings. A mouse move that arrives late is worse than one that does
//!   not arrive, and so is a cursor position.
//!
//! ### Sealing, built once per connection
//!
//! `seal.rs` builds a key and draws a random nonce per frame, which is right
//! for a JSON frame a minute and wasteful at sixty frames a second. Here each
//! direction gets a key of its own, derived once from the wall key and the
//! connection's own TLS exporter, and a nonce is a counter. **The exporter is
//! the half that makes a counter safe**: the room key is shared by every
//! connection between every pair of walls, so a counter under it would repeat
//! the first nonce on the second connection. The exporter is unique to this
//! connection's handshake and both ends compute it without a word said, so the
//! key is too — and the direction in the HKDF info and the AAD keeps the two
//! ends' counters from ever meeting under one key.
//!
//! The QUIC connection is already TLS to an identity only a wall-key holder
//! has (`wire.rs`), so this seal is the flyway's rule kept — *the payload is
//! sealed before it reaches the transport* — rather than the only lock.
//!
//! ### What the path may cost
//!
//! Through n0's relay the code assumes about a megabit (`look.rs`). A screen
//! that tried to push 1440p60 through that would stutter with nothing to say
//! why, so a relayed path is held to `RELAY_BOX` at `RELAY_FPS` and
//! `RELAY_KBPS` and **says so** in the state the tile draws (`fit`). A direct
//! path is steered by loss and queueing delay (`Steer`), which is the half a
//! congestion controller cannot do for us: it can only pace what the encoder
//! already made, and a frame made too big is latency whichever way it is paced.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};

use crate::cast::{Input, Want};

use super::seal::WallKey;

/// What the media connection is called on the wire. Its own ALPN rather than a
/// word inside `volery/flyway/2`, so `answer` can hand it a transport tuned for
/// video before the handshake finishes, and an older wall refuses it at the
/// handshake instead of reading frames it has no word for.
pub const ALPN: &[u8] = b"volery/cast/1";

/// The label the connection's TLS exporter is asked under (RFC 5705). Any
/// string both ends agree on; versioned with the ALPN.
pub const EXPORTER_LABEL: &[u8] = b"volery/cast/1 exporter";

/// The most one sealed message may be. A 4K keyframe at a generous bitrate is
/// a few megabytes; this is well past that and still a bound.
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;

/* ── sealing ─────────────────────────────────────────────────────────────── */

const TAG: usize = 16;
const COUNTER: usize = 8;
/// `kind u8, sid u32` in front of every body.
const HEAD: usize = 5;

/// Which way a message travels. In the key's derivation, the nonce and the
/// associated data, so the two directions never share a nonce under one key
/// and a message cannot be reflected back at its sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    ToHost = 1,
    ToViewer = 2,
}

impl Dir {
    fn info(self) -> &'static [u8] {
        match self {
            Dir::ToHost => b"volery/cast/1 to host",
            Dir::ToViewer => b"volery/cast/1 to viewer",
        }
    }

    fn aad(self) -> [u8; 14] {
        let mut a = [0u8; 14];
        a[..13].copy_from_slice(ALPN);
        a[13] = self as u8;
        a
    }

    fn nonce(self, n: u64) -> Nonce {
        let mut b = [0u8; 12];
        b[0] = self as u8;
        b[4..].copy_from_slice(&n.to_le_bytes());
        Nonce::assume_unique_for_key(b)
    }
}

/// One direction's key, and the counter that is its nonce. Shared by every
/// task writing that direction — control, frames and datagrams draw from one
/// counter, so no two messages ever take the same nonce.
pub struct Sealer {
    key: LessSafeKey,
    dir: Dir,
    next: AtomicU64,
}

/// The other direction's key.
pub struct Opener {
    key: LessSafeKey,
    dir: Dir,
}

fn channel_key(wall: &WallKey, exporter: &[u8], dir: Dir) -> Result<LessSafeKey, String> {
    let raw = wall.derive(exporter, dir.info())?;
    let unbound = UnboundKey::new(&aead::CHACHA20_POLY1305, &raw).map_err(|_| "could not build a channel key".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// The pair one end holds: it seals what it sends and opens what it hears.
/// `exporter` is the connection's own keying material under `EXPORTER_LABEL`.
pub fn keys(wall: &WallKey, exporter: &[u8], viewer: bool) -> Result<(Sealer, Opener), String> {
    let (out, back) = if viewer { (Dir::ToHost, Dir::ToViewer) } else { (Dir::ToViewer, Dir::ToHost) };
    Ok((
        Sealer { key: channel_key(wall, exporter, out)?, dir: out, next: AtomicU64::new(0) },
        Opener { key: channel_key(wall, exporter, back)?, dir: back },
    ))
}

impl Sealer {
    /// One message, sealed: `counter u64 LE`, then `kind, sid, body` encrypted,
    /// then the tag. The body is copied once, into the buffer it is sealed in.
    pub fn seal(&self, kind: u8, sid: u32, body: &[u8]) -> Result<Vec<u8>, String> {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        /* Unreachable at any frame rate in the life of a machine, and a wrapped
           counter is a repeated nonce — so it is a refusal, not a wrap. */
        if n == u64::MAX {
            return Err("this screen has sent all it may under one key".into());
        }
        let mut out = Vec::with_capacity(COUNTER + HEAD + body.len() + TAG);
        out.extend_from_slice(&n.to_le_bytes());
        out.push(kind);
        out.extend_from_slice(&sid.to_le_bytes());
        out.extend_from_slice(body);
        let tag = self
            .key
            .seal_in_place_separate_tag(self.dir.nonce(n), Aad::from(self.dir.aad()), &mut out[COUNTER..])
            .map_err(|_| "could not seal a screen message".to_string())?;
        out.extend_from_slice(tag.as_ref());
        Ok(out)
    }
}

/// An opened message: the kind, the session, and the body in place.
#[derive(Debug)]
pub struct Opened {
    pub kind: u8,
    pub sid: u32,
    buf: Vec<u8>,
}

impl Opened {
    pub fn body(&self) -> &[u8] {
        &self.buf[COUNTER + HEAD..self.buf.len() - TAG]
    }
}

impl Opener {
    /// Open a sealed message, in place. One message for every failure, for
    /// `seal.rs`'s reason: why a forgery failed is not something to tell it.
    pub fn open(&self, mut buf: Vec<u8>) -> Result<Opened, String> {
        const REFUSED: &str = "a screen message did not open";
        if buf.len() < COUNTER + HEAD + TAG {
            return Err(REFUSED.into());
        }
        let n = u64::from_le_bytes(buf[..COUNTER].try_into().map_err(|_| REFUSED.to_string())?);
        self.key
            .open_in_place(self.dir.nonce(n), Aad::from(self.dir.aad()), &mut buf[COUNTER..])
            .map_err(|_| REFUSED.to_string())?;
        let kind = buf[COUNTER];
        let sid = u32::from_le_bytes(buf[COUNTER + 1..COUNTER + HEAD].try_into().map_err(|_| REFUSED.to_string())?);
        Ok(Opened { kind, sid, buf })
    }
}

/* ── what a message is ───────────────────────────────────────────────────── */

/// A control message, JSON (`Ctl`).
pub const K_CTL: u8 = 1;
/// One of the hub's binary messages as it made it: video, cursor shape, cursor
/// position (`cast::wire`).
pub const K_BIN: u8 = 2;
/// One of the hub's text messages as it made it: config, state, stats.
pub const K_TEXT: u8 = 3;
/// Input events, concatenated, in `cast::wire`'s layout.
pub const K_INPUT: u8 = 4;
/// A clock ping: the viewer's clock, µs since the epoch.
pub const K_PING: u8 = 5;
/// Its answer: the ping's own time, then the host's clock.
pub const K_PONG: u8 = 6;

/// What the two ends say about a session, beside the hub's own messages.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Ctl {
    /// Viewer → host: show me this monitor. The first word of a session.
    Open { monitor: String, want: Want },
    /// Viewer → host: the tile changed.
    Want { want: Want },
    /// Viewer → host: the decoder lost its place.
    Key,
    /// Either way: this session is over.
    Close,
    /// Host → viewer: the session is live.
    Opened,
    /// Host → viewer: it will not be, and why, in words for a person.
    Refused { why: String },
}

impl Ctl {
    pub fn to_body(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_body(b: &[u8]) -> Option<Ctl> {
        serde_json::from_slice(b).ok()
    }
}

/// A sealed message's length prefix on a stream. Little-endian, as everything
/// a screen is made of.
pub fn prefix(len: usize) -> Result<[u8; 4], String> {
    if len > MAX_MESSAGE {
        return Err("that screen message is too large to send".into());
    }
    Ok((len as u32).to_le_bytes())
}

/// The length a prefix announces, or a refusal for one too large to be ours.
pub fn announced(prefix: [u8; 4]) -> Result<usize, String> {
    let n = u32::from_le_bytes(prefix) as usize;
    if n > MAX_MESSAGE {
        return Err("that wall announced a screen message too large to be one of ours".into());
    }
    Ok(n)
}

/// A pong's body.
pub fn pong(viewer_us: u64, host_us: u64) -> [u8; 16] {
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&viewer_us.to_le_bytes());
    b[8..].copy_from_slice(&host_us.to_le_bytes());
    b
}

pub fn read_pong(b: &[u8]) -> Option<(u64, u64)> {
    if b.len() < 16 {
        return None;
    }
    Some((u64::from_le_bytes(b[..8].try_into().ok()?), u64::from_le_bytes(b[8..16].try_into().ok()?)))
}

pub fn read_ping(b: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(..8)?.try_into().ok()?))
}

/// Whether a hub text is the `config` a keyframe needs in front of it — kept by
/// the host and sent on the keyframe's own stream rather than the control one.
pub fn is_config(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("t").and_then(|t| t.as_str()).map(|t| t == "config"))
        .unwrap_or(false)
}

/// The viewer's memory of the last config it forwarded, so a keyframe that
/// carries the same one again does not reconfigure the decoder for nothing.
#[derive(Default)]
pub struct Configs {
    last: Option<String>,
}

impl Configs {
    /// Whether this config is news to the front.
    pub fn fresh(&mut self, text: &str) -> bool {
        if self.last.as_deref() == Some(text) {
            return false;
        }
        self.last = Some(text.to_string());
        true
    }
}

/* ── input ───────────────────────────────────────────────────────────────── */

/// Split what a tile sent into what must arrive and what may not.
///
/// Keys, buttons and release-all go reliably; moves and the wheel go as
/// datagrams. **A button carries the move in front of it**: a click is a
/// position and a press, and if the move went as a datagram that arrived after
/// the press — or not at all — the click would land wherever the pointer last
/// was. So the latest absolute move before a button goes reliably too, ahead
/// of it. Order within each half is the order sent.
pub fn split(events: &[Input]) -> (Vec<u8>, Vec<u8>) {
    let (mut sure, mut loose) = (Vec::new(), Vec::new());
    let mut pending_move: Option<Input> = None;
    for e in events {
        match e {
            Input::MouseAbs { .. } => {
                crate::cast::wire::put_input(&mut loose, e);
                pending_move = Some(*e);
            }
            Input::MouseRel { .. } | Input::Wheel { .. } => crate::cast::wire::put_input(&mut loose, e),
            Input::Button { .. } => {
                if let Some(m) = pending_move.take() {
                    crate::cast::wire::put_input(&mut sure, &m);
                }
                crate::cast::wire::put_input(&mut sure, e);
            }
            Input::Key { .. } | Input::ReleaseAll => crate::cast::wire::put_input(&mut sure, e),
        }
    }
    (sure, loose)
}

/* ── consent ─────────────────────────────────────────────────────────────── */

/// Whether this wall shows its screens to another: exactly when it takes work
/// from other walls (Lyss, 2026-10-30) — the same switch `act.rs` reads, read
/// fresh on every session open, and no second one. Seen and driven are one
/// decision: a wall that lets another open cards on it has already let it run
/// anything, and a screen is a smaller thing than that.
pub fn may_show(takes_work: bool, me: &str) -> Result<(), String> {
    if takes_work {
        Ok(())
    } else {
        Err(format!(
            "{me} does not take work from other walls, so its screens are not shown — turn on \
             “take work from other walls” there to see it from here"
        ))
    }
}

/// What `Facts::screens` says: the monitors, only while the wall takes work. A
/// wall that would refuse a session does not advertise one.
pub fn announced_screens(takes_work: bool, monitors: Vec<crate::cast::Monitor>) -> Vec<crate::cast::Monitor> {
    if takes_work {
        monitors
    } else {
        Vec::new()
    }
}

/* ── the path ────────────────────────────────────────────────────────────── */

/// Which way the bytes are going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path {
    /// Hole-punched, or on the same network: as fast as the network is.
    Direct,
    /// Through n0's relay — the code's own assumption is about a megabit.
    Relay,
}

impl Path {
    pub fn word(self) -> &'static str {
        match self {
            Path::Direct => "direct",
            Path::Relay => "relay",
        }
    }
}

/// The largest a relayed screen is sent at. 720p is where desktop text is
/// still text; any larger and a megabit buys mush.
pub const RELAY_BOX: (u32, u32) = (1280, 720);
pub const RELAY_FPS: u32 = 15;
/// A little under the relay's assumed megabit, for the control stream, the
/// cursor and everybody else's flyway traffic beside it.
pub const RELAY_KBPS: u32 = 800;

/// What the host asks of the hub for one viewer, given the path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fit {
    pub want: Want,
    /// The bitrate ceiling to hand `Subscription::cap`.
    pub kbps: Option<u32>,
    /// What the tile should say about being held back, if it is.
    pub held: Option<String>,
}

/// Scale `w×h` down into `max_w×max_h`, keeping its shape and an even size
/// (H.264's 4:2:0 wants even dimensions). Never up.
pub fn into_box(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h || w == 0 || h == 0 {
        return (w, h);
    }
    let s = f64::min(max_w as f64 / w as f64, max_h as f64 / h as f64);
    let even = |v: f64| ((v.floor() as u32) & !1).max(2);
    (even(w as f64 * s), even(h as f64 * s))
}

/// Fit a viewer's want to the path it is on. `steered` is `Steer`'s ceiling.
pub fn fit(want: Want, path: Path, steered: Option<u32>) -> Fit {
    match path {
        Path::Direct => Fit { want, kbps: steered, held: None },
        Path::Relay => {
            let (w, h) = into_box(want.w, want.h, RELAY_BOX.0, RELAY_BOX.1);
            let fps = want.fps.min(RELAY_FPS);
            let shrunk = (w, h) != (want.w, want.h) || fps != want.fps;
            let kbps = Some(steered.map_or(RELAY_KBPS, |s| s.min(RELAY_KBPS)));
            let held = Some(if shrunk {
                format!("through a relay, so held to {w}×{h} at {fps} fps")
            } else {
                format!("through a relay, so held to {:.1} Mbit/s", RELAY_KBPS as f64 / 1000.0)
            });
            Fit { want: Want { w, h, fps, ..want }, kbps, held }
        }
    }
}

/// One reading of the connection, every `STEER_EVERY_MS`.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    /// Packets sent and lost on the path, cumulative.
    pub sent: u64,
    pub lost: u64,
    pub rtt_ms: f64,
    /// The congestion window, bytes.
    pub cwnd: u64,
}

pub const STEER_EVERY_MS: u64 = 500;
/// The least a steered screen is sent at — below this the picture is not
/// worth the frames.
pub const STEER_FLOOR_KBPS: u32 = 500;
/// Above this the cap is lifted rather than raised: the encoder's own choice is
/// already less than the path can carry.
pub const STEER_CEIL_KBPS: u32 = 60_000;

/// A bitrate ceiling steered by what the path does: down by 30% when it loses
/// packets or its delay climbs past its floor (a queue building, which is
/// latency before it is loss), up by 15% after two clean seconds, and lifted
/// altogether once it passes `STEER_CEIL_KBPS`.
#[derive(Default, Debug)]
pub struct Steer {
    cap: Option<u32>,
    min_rtt: Option<f64>,
    clean: u32,
    last: Option<(u64, u64)>,
}

impl Steer {
    pub fn cap(&self) -> Option<u32> {
        self.cap
    }

    pub fn step(&mut self, s: Sample) -> Option<u32> {
        let (sent, lost) = match self.last.replace((s.sent, s.lost)) {
            Some((ps, pl)) => (s.sent.saturating_sub(ps), s.lost.saturating_sub(pl)),
            None => (0, 0),
        };
        if s.rtt_ms > 0.0 {
            self.min_rtt = Some(self.min_rtt.map_or(s.rtt_ms, |m| m.min(s.rtt_ms)));
        }
        let lossy = sent >= 20 && lost as f64 / sent as f64 > 0.02;
        let queued = self.min_rtt.is_some_and(|m| s.rtt_ms > m + f64::max(30.0, m));
        if lossy || queued {
            self.clean = 0;
            /* With no cap yet, start from what the window says the path holds. */
            let base = self.cap.unwrap_or_else(|| {
                let est = if s.rtt_ms > 0.0 { s.cwnd as f64 * 8.0 / s.rtt_ms } else { STEER_CEIL_KBPS as f64 };
                est.clamp(STEER_FLOOR_KBPS as f64, STEER_CEIL_KBPS as f64) as u32
            });
            self.cap = Some(((base as f64 * 0.7) as u32).max(STEER_FLOOR_KBPS));
        } else {
            self.clean += 1;
            if let Some(c) = self.cap {
                if self.clean >= 4 {
                    self.clean = 0;
                    let up = (c as f64 * 1.15) as u32;
                    self.cap = if up > STEER_CEIL_KBPS { None } else { Some(up) };
                }
            }
        }
        self.cap
    }
}

/* ── the clock ───────────────────────────────────────────────────────────── */

/// How far the host's clock is from the viewer's, NTP's way: of the recent
/// pings, the one with the shortest round trip, whose midpoint is the least
/// uncertain. What lets the front show capture → paint across two machines:
/// `paint_viewer - (capture_host - offset)`.
#[derive(Default, Debug)]
pub struct Clock {
    samples: VecDeque<(u64, i64)>,
}

const CLOCK_KEEP: usize = 16;

impl Clock {
    /// A pong: when the ping left, the host's clock in the answer, when it came
    /// back — all µs.
    pub fn sample(&mut self, sent_us: u64, host_us: u64, back_us: u64) {
        if back_us < sent_us {
            return;
        }
        let rtt = back_us - sent_us;
        let mid = sent_us as i128 + rtt as i128 / 2;
        let offset = (host_us as i128 - mid) as i64;
        if self.samples.len() == CLOCK_KEEP {
            self.samples.pop_front();
        }
        self.samples.push_back((rtt, offset));
    }

    /// Host clock minus viewer clock, µs.
    pub fn offset_us(&self) -> Option<i64> {
        self.samples.iter().min_by_key(|(rtt, _)| *rtt).map(|(_, o)| *o)
    }

    pub fn rtt_us(&self) -> Option<u64> {
        self.samples.back().map(|(rtt, _)| *rtt)
    }
}

/// The `stats` text the tile's overlay reads.
pub fn stats(path: Option<Path>, rtt_ms: Option<f64>, loss: Option<f64>, offset_us: Option<i64>, held: Option<&str>) -> String {
    serde_json::json!({
        "t": "stats",
        "path": path.map(Path::word),
        "rtt_ms": rtt_ms.map(|r| (r * 10.0).round() / 10.0),
        "loss": loss.map(|l| (l * 1000.0).round() / 1000.0),
        "offset_us": offset_us,
        "held": held,
    })
    .to_string()
}

/// A `state` text in the contract's vocabulary.
pub fn state(state: &str, why: Option<&str>) -> String {
    serde_json::json!({ "t": "state", "state": state, "why": why }).to_string()
}

/* ── falling behind ──────────────────────────────────────────────────────── */

/// What to do with a video frame on its way out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    Send,
    Drop,
    /// Drop it, and ask the hub for a keyframe: this viewer just fell behind.
    DropAndAskKey,
}

/// The host's rule for one viewer's frames: a frame that cannot be queued puts
/// the viewer *behind*, and everything after it is dropped until a keyframe —
/// a delta on top of a missing frame decodes to garbage, and a queue is
/// latency. Asks for the keyframe once per fall, not once per dropped frame.
#[derive(Default, Debug)]
pub struct Behind {
    behind: bool,
}

impl Behind {
    pub fn admit(&mut self, key: bool, room: bool) -> Admit {
        if self.behind && !key {
            return Admit::Drop;
        }
        if !room {
            let first = !self.behind;
            self.behind = true;
            return if first { Admit::DropAndAskKey } else { Admit::Drop };
        }
        self.behind = false;
        Admit::Send
    }
}

/* ── frames that finish out of order ─────────────────────────────────────── */

/// How long a frame past a gap waits for the one missing in front of it before
/// the viewer gives up on the gap and asks for a keyframe. A few frames at
/// sixty; past this, waiting is worse than a fresh start.
pub const HOLD_MS: u64 = 80;

/// The viewer's rule for frames, which ride a stream each and so may finish in
/// any order — the price of a lost packet delaying only its own frame. A
/// decoder must be fed in order, from a keyframe: so a frame is handed on when
/// it is the next one, held when one in front of it is still on its way, and
/// dropped when it is older than what was already shown. A keyframe needs
/// nothing in front of it, and passes everything held behind it.
pub struct Order<T> {
    last: Option<u32>,
    held: std::collections::BTreeMap<u32, (T, u64)>,
}

impl<T> Default for Order<T> {
    fn default() -> Self {
        Self { last: None, held: Default::default() }
    }
}

impl<T> Order<T> {
    /// A frame finished arriving. Returns what may go to the decoder now, in
    /// order.
    pub fn arrive(&mut self, seq: u32, key: bool, now_ms: u64, item: T) -> Vec<T> {
        let mut out = Vec::new();
        if key {
            /* An older keyframe than what is on screen would rewind it. */
            if self.last.is_some_and(|l| seq <= l) {
                return out;
            }
            self.held.retain(|s, _| *s > seq);
            self.last = Some(seq);
            out.push(item);
        } else {
            match self.last {
                None => return out,
                Some(l) if seq <= l => return out,
                Some(l) if seq == l + 1 => {
                    self.last = Some(seq);
                    out.push(item);
                }
                Some(_) => {
                    self.held.insert(seq, (item, now_ms));
                    return out;
                }
            }
        }
        while let Some(l) = self.last {
            match self.held.remove(&(l + 1)) {
                Some((it, _)) => {
                    self.last = Some(l + 1);
                    out.push(it);
                }
                None => break,
            }
        }
        out
    }

    /// Give up on a gap that has waited too long: drop what it held and start
    /// again from the next keyframe. True when it did, so the caller asks for
    /// one.
    pub fn expire(&mut self, now_ms: u64) -> bool {
        if self.held.values().any(|(_, at)| now_ms.saturating_sub(*at) > HOLD_MS) {
            self.held.clear();
            self.last = None;
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cast::Button;

    #[test]
    fn frames_reach_the_decoder_in_order_from_a_keyframe() {
        let mut o = Order::default();
        assert!(o.arrive(1, false, 0, 1).is_empty(), "nothing before a keyframe");
        assert_eq!(o.arrive(2, true, 0, 2), vec![2]);
        /* 4 finishes before 3: held, then both go when 3 lands. */
        assert!(o.arrive(4, false, 1, 4).is_empty());
        assert_eq!(o.arrive(3, false, 2, 3), vec![3, 4]);
        /* Late and already passed. */
        assert!(o.arrive(3, false, 3, 3).is_empty());
        /* A keyframe skips the gap and passes what was held behind it. */
        assert!(o.arrive(7, false, 4, 7).is_empty());
        assert!(o.arrive(9, false, 4, 9).is_empty());
        assert_eq!(o.arrive(8, true, 5, 8), vec![8, 9]);
        /* An older keyframe arriving late would rewind the screen. */
        assert!(o.arrive(6, true, 6, 6).is_empty());
    }

    #[test]
    fn a_gap_that_never_fills_is_given_up_and_a_keyframe_asked_for() {
        let mut o = Order::default();
        o.arrive(1, true, 0, 1);
        assert!(o.arrive(3, false, 100, 3).is_empty());
        assert!(!o.expire(100 + HOLD_MS));
        assert!(o.expire(101 + HOLD_MS));
        /* And then only a keyframe restarts it. */
        assert!(o.arrive(4, false, 200, 4).is_empty());
        assert_eq!(o.arrive(5, true, 200, 5), vec![5]);
    }

    fn wall() -> WallKey {
        WallKey::from_bytes([7u8; 32])
    }

    fn want(w: u32, h: u32, fps: u32) -> Want {
        Want { w, h, fps, visible: true, focused: true }
    }

    #[test]
    fn a_message_crosses_one_way_and_not_back() {
        let ex = [3u8; 32];
        let (v_seal, v_open) = keys(&wall(), &ex, true).unwrap();
        let (h_seal, h_open) = keys(&wall(), &ex, false).unwrap();
        let m = v_seal.seal(K_CTL, 9, b"hello").unwrap();
        let o = h_open.open(m.clone()).unwrap();
        assert_eq!((o.kind, o.sid, o.body()), (K_CTL, 9, &b"hello"[..]));
        /* Reflected back at its sender, it does not open: the direction is in
           the key and in the associated data. */
        assert!(v_open.open(m).is_err());
        let back = h_seal.seal(K_TEXT, 9, b"{}").unwrap();
        assert_eq!(v_open.open(back).unwrap().body(), b"{}");
    }

    #[test]
    fn two_connections_never_share_a_key() {
        let (a, _) = keys(&wall(), &[1u8; 32], true).unwrap();
        let (_, b_open) = keys(&wall(), &[2u8; 32], false).unwrap();
        /* Same wall key, same counter (0), different exporter: the first
           message of one connection does not open on the other. */
        assert!(b_open.open(a.seal(K_CTL, 0, b"x").unwrap()).is_err());
        let (_, other_wall) = keys(&WallKey::from_bytes([8u8; 32]), &[1u8; 32], false).unwrap();
        assert!(other_wall.open(a.seal(K_CTL, 0, b"x").unwrap()).is_err());
    }

    #[test]
    fn the_counter_is_the_nonce_and_it_never_repeats() {
        let (s, _) = keys(&wall(), &[1u8; 32], true).unwrap();
        let a = s.seal(K_BIN, 1, b"same").unwrap();
        let b = s.seal(K_BIN, 1, b"same").unwrap();
        assert_eq!(&a[..8], &0u64.to_le_bytes());
        assert_eq!(&b[..8], &1u64.to_le_bytes());
        assert_ne!(a[8..], b[8..]);
        assert_eq!(a.len(), 8 + 5 + 4 + 16);
    }

    #[test]
    fn a_bent_or_short_message_is_refused() {
        let (s, _) = keys(&wall(), &[1u8; 32], true).unwrap();
        let (_, o) = keys(&wall(), &[1u8; 32], false).unwrap();
        let m = s.seal(K_INPUT, 2, b"\x16").unwrap();
        for i in 0..m.len() {
            let mut bent = m.clone();
            bent[i] ^= 1;
            assert!(o.open(bent).is_err(), "byte {i} was not protected");
        }
        assert!(o.open(m[..20].to_vec()).is_err());
        assert!(o.open(Vec::new()).is_err());
    }

    #[test]
    fn a_length_prefix_is_bounded_both_ways() {
        assert_eq!(prefix(300).unwrap(), [0x2c, 0x01, 0, 0]);
        assert_eq!(announced([0x2c, 0x01, 0, 0]).unwrap(), 300);
        assert!(prefix(MAX_MESSAGE + 1).is_err());
        assert!(announced(((MAX_MESSAGE + 1) as u32).to_le_bytes()).is_err());
    }

    #[test]
    fn control_words_are_tagged_json() {
        let open = Ctl::Open { monitor: "m0".into(), want: want(1920, 1080, 60) };
        let body = open.to_body();
        assert!(String::from_utf8_lossy(&body).starts_with(r#"{"t":"open""#));
        assert_eq!(Ctl::from_body(&body), Some(open));
        assert_eq!(Ctl::from_body(br#"{"t":"key"}"#), Some(Ctl::Key));
        assert_eq!(Ctl::from_body(br#"{"t":"later_word"}"#), None);
    }

    #[test]
    fn a_ping_and_its_pong_round_trip() {
        assert_eq!(read_pong(&pong(5, 9)), Some((5, 9)));
        assert_eq!(read_ping(&7u64.to_le_bytes()), Some(7));
        assert_eq!(read_ping(&[1, 2]), None);
    }

    #[test]
    fn a_config_rides_once() {
        assert!(is_config(r#"{"t":"config","codec":"avc1.64002a","w":1,"h":1,"fps":60}"#));
        assert!(!is_config(r#"{"t":"state","state":"live"}"#));
        assert!(!is_config("not json"));
        let mut c = Configs::default();
        assert!(c.fresh("a"));
        assert!(!c.fresh("a"));
        assert!(c.fresh("b"));
        assert!(c.fresh("a"));
    }

    #[test]
    fn keys_and_buttons_go_reliably_and_moves_do_not() {
        let events = [
            Input::MouseAbs { x: 1, y: 1 },
            Input::MouseAbs { x: 2, y: 2 },
            Input::Wheel { dx: 0, dy: 120 },
            Input::Button { button: Button::Left, down: true },
            Input::MouseAbs { x: 3, y: 3 },
            Input::Button { button: Button::Left, down: false },
            Input::Key { scan: 0x1e, down: true },
            Input::Key { scan: 0x1e, down: false },
            Input::MouseRel { dx: 4, dy: 4 },
            Input::ReleaseAll,
        ];
        let (sure, loose) = split(&events);
        assert_eq!(
            crate::cast::wire::read_inputs(&sure),
            vec![
                /* The move a press happens at travels with it. */
                Input::MouseAbs { x: 2, y: 2 },
                Input::Button { button: Button::Left, down: true },
                Input::MouseAbs { x: 3, y: 3 },
                Input::Button { button: Button::Left, down: false },
                Input::Key { scan: 0x1e, down: true },
                Input::Key { scan: 0x1e, down: false },
                Input::ReleaseAll,
            ]
        );
        assert_eq!(
            crate::cast::wire::read_inputs(&loose),
            vec![
                Input::MouseAbs { x: 1, y: 1 },
                Input::MouseAbs { x: 2, y: 2 },
                Input::Wheel { dx: 0, dy: 120 },
                Input::MouseAbs { x: 3, y: 3 },
                Input::MouseRel { dx: 4, dy: 4 },
            ]
        );
        /* A press with no move before it in the batch carries none. */
        let (sure, _) = split(&[Input::Button { button: Button::Right, down: true }]);
        assert_eq!(sure, vec![0x13, 1, 1]);
    }

    #[test]
    fn a_wall_shows_its_screens_exactly_when_it_takes_work() {
        assert!(may_show(true, "AU-LT-285").is_ok());
        let why = may_show(false, "AU-LT-285").unwrap_err();
        assert!(why.contains("AU-LT-285") && why.contains("take work from other walls"));
        let m = crate::cast::Monitor {
            id: "0:0".into(),
            name: "panel".into(),
            w: 2560,
            h: 1600,
            x: 0,
            y: 0,
            hz: 165,
            primary: true,
        };
        assert_eq!(announced_screens(true, vec![m.clone()]), vec![m.clone()]);
        assert!(announced_screens(false, vec![m]).is_empty());
    }

    #[test]
    fn a_relayed_screen_is_held_to_what_fits_and_says_so() {
        let f = fit(want(2560, 1600, 120), Path::Relay, None);
        assert_eq!((f.want.w, f.want.h, f.want.fps), (1152, 720, 15));
        assert_eq!(f.kbps, Some(RELAY_KBPS));
        assert_eq!(f.held.as_deref(), Some("through a relay, so held to 1152×720 at 15 fps"));
        /* Already small: nothing shrinks, and it still says what it is held to. */
        let small = fit(want(640, 360, 15), Path::Relay, Some(400));
        assert_eq!((small.want.w, small.want.h, small.want.fps), (640, 360, 15));
        assert_eq!(small.kbps, Some(400));
        assert!(small.held.unwrap().contains("Mbit/s"));
        /* Direct: untouched, and the steered cap passes through. */
        let d = fit(want(2560, 1600, 120), Path::Direct, Some(9000));
        assert_eq!((d.want, d.kbps, d.held), (want(2560, 1600, 120), Some(9000), None));
    }

    #[test]
    fn a_box_keeps_the_shape_and_an_even_size() {
        assert_eq!(into_box(1920, 1080, 1280, 720), (1280, 720));
        assert_eq!(into_box(1000, 3000, 1280, 720), (240, 720));
        assert_eq!(into_box(1281, 721, 1280, 720), (1278, 720));
        assert_eq!(into_box(800, 600, 1280, 720), (800, 600));
    }

    #[test]
    fn the_bitrate_backs_off_on_loss_and_queueing_and_climbs_back() {
        let mut s = Steer::default();
        let at = |sent, lost, rtt| Sample { sent, lost, rtt_ms: rtt, cwnd: 1_000_000 };
        assert_eq!(s.step(at(0, 0, 10.0)), None);
        assert_eq!(s.step(at(1000, 0, 10.0)), None, "clean and uncapped stays uncapped");
        /* 5% loss: down from what the window says (800 Mbit/s, clamped to the
           ceiling) by 30%. */
        assert_eq!(s.step(at(2000, 50, 10.0)), Some(42_000));
        let after_loss = s.cap().unwrap();
        /* A queue building — rtt from 10 to 45 — is congestion before it is loss. */
        assert_eq!(s.step(at(3000, 50, 45.0)), Some((after_loss as f64 * 0.7) as u32));
        let low = s.cap().unwrap();
        for i in 0..3 {
            assert_eq!(s.step(at(4000 + i * 1000, 50, 10.0)), Some(low), "not before two clean seconds");
        }
        assert_eq!(s.step(at(8000, 50, 10.0)), Some((low as f64 * 1.15) as u32));
        /* Enough clean time lifts the cap altogether. */
        let mut lifted = false;
        for i in 0..200 {
            if s.step(at(9000 + i * 1000, 50, 10.0)).is_none() {
                lifted = true;
                break;
            }
        }
        assert!(lifted);
        /* Never below the floor. */
        let mut f = Steer { cap: Some(STEER_FLOOR_KBPS), ..Steer::default() };
        f.step(at(0, 0, 10.0));
        assert_eq!(f.step(at(100, 50, 10.0)), Some(STEER_FLOOR_KBPS));
    }

    #[test]
    fn the_clock_offset_trusts_the_shortest_round_trip() {
        let mut c = Clock::default();
        assert_eq!(c.offset_us(), None);
        /* Host 5 ms ahead. A slow ping with its delay all on the way out reads
           wrong; the quick one reads true, and wins. */
        c.sample(1_000_000, 1_000_000 + 5_000 + 40_000, 1_000_000 + 41_000);
        c.sample(2_000_000, 2_000_000 + 5_000 + 1_000, 2_000_000 + 2_000);
        assert_eq!(c.offset_us(), Some(5_000));
        assert_eq!(c.rtt_us(), Some(2_000));
        /* A pong from before its ping is a clock gone backwards, not a sample. */
        c.sample(10, 0, 5);
        assert_eq!(c.rtt_us(), Some(2_000));
    }

    #[test]
    fn stats_and_state_are_the_contracts_texts() {
        let s: serde_json::Value = serde_json::from_str(&stats(Some(Path::Relay), Some(41.26), Some(0.0123), Some(-5), Some("held"))).unwrap();
        assert_eq!(s["t"], "stats");
        assert_eq!(s["path"], "relay");
        assert_eq!(s["rtt_ms"], 41.3);
        assert_eq!(s["loss"], 0.012);
        assert_eq!(s["offset_us"], -5);
        let st: serde_json::Value = serde_json::from_str(&state("refused", Some("no"))).unwrap();
        assert_eq!((st["t"].as_str(), st["state"].as_str(), st["why"].as_str()), (Some("state"), Some("refused"), Some("no")));
    }

    #[test]
    fn a_viewer_that_falls_behind_waits_for_a_keyframe_and_asks_once() {
        let mut b = Behind::default();
        assert_eq!(b.admit(true, true), Admit::Send);
        assert_eq!(b.admit(false, true), Admit::Send);
        assert_eq!(b.admit(false, false), Admit::DropAndAskKey);
        assert_eq!(b.admit(false, false), Admit::Drop);
        /* Room again, but a delta on a missing frame is garbage. */
        assert_eq!(b.admit(false, true), Admit::Drop);
        /* A keyframe with no room is still behind, and does not ask again. */
        assert_eq!(b.admit(true, false), Admit::Drop);
        assert_eq!(b.admit(true, true), Admit::Send);
        assert_eq!(b.admit(false, true), Admit::Send);
    }
}
