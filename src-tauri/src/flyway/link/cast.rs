//! A screen across the flyway, running: the viewer's end and the host's end of
//! the media connection. `flyway/cast.rs` is the vocabulary and has the design;
//! `wire.rs` hands this file the connection.
//!
//! ### The viewer's end
//!
//! `subscribe` is what the core lane's loopback socket calls when a tile names
//! another wall. It finds or dials the one connection to that wall (`Peer`),
//! opens a session on it, waits for the host to say yes, and hands back a
//! `RemoteSubscription` whose `want`, `key` and `input` the socket drives. What
//! arrives is handed to the socket's `Viewer` as the host's hub made it — plus
//! `stats`, which this end makes: both ends ride the same path, so the viewer
//! reads direct-or-relay and the round trip off its own side of the connection,
//! and only the clock offset needs the host (a ping, answered).
//!
//! ### The host's end
//!
//! `host` answers a connection another wall opened. Every session asks the
//! take-work switch afresh before the hub is touched (`cast::may_show`), and the
//! hub is handed a `Viewer` that never blocks: frames go into a two-deep queue
//! and a viewer that cannot keep it drops until the next keyframe and asks for
//! one (`cast::Behind`). Every half-second the path is read and the encoder
//! steered (`cast::fit`, `cast::Steer`); a relayed screen is held to what fits
//! and the tile is told so in a `state`.
//!
//! The host's front end hears `cast:watched` on every open, first input and
//! close, and draws its quiet "seen from …" mark off it.
//!
//! ### Tenure
//!
//! Nothing here outlives the link. Leaving closes the endpoint (`leaving.rs`),
//! which closes every connection on it, and every loop below ends on its
//! connection closing; `subscribe` refuses on a closed link.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iroh::endpoint::{Connection, RecvStream, ReadExactError, SendStream, VarInt};
use iroh::EndpointId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch, Notify, Semaphore};

use crate::cast::{wire as cw, Input, Monitor, Out, Viewer, Want};
use crate::store::Store;

use super::super::cast::{self as fc, Ctl, Opened, Opener, Path, Sealer};
use super::super::here;
use super::{current, Link};

/// The hub, as this lane calls it (`docs/SCREENS.md`, "The hub API"). The core
/// lane's `cast::hub` replaces these bodies one for one; until it lands every
/// session is refused with a reason the tile can draw.
mod hub {
    use super::*;

    pub struct Sub;

    impl Sub {
        pub fn want(&self, _w: Want) {}
        pub fn key(&self) {}
        pub fn cap(&self, _kbps: Option<u32>) {}
    }

    pub fn subscribe(_monitor: &str, _want: Want, _viewer: Arc<dyn Viewer>) -> Result<Sub, String> {
        Err("this build cannot show its screens yet".into())
    }

    pub fn input(_monitor: &str, _events: &[Input]) {}

    pub fn monitors() -> Vec<Monitor> {
        Vec::new()
    }
}

/// How long a viewer waits for the host to say yes to a session.
const OPEN_WITHIN: Duration = Duration::from_secs(15);
/// How long a connection with no screens left on it is kept, so a tile closed
/// and reopened — a zoom, a view switch — does not pay a handshake.
const LINGER: Duration = Duration::from_secs(10);
/// Frames queued for one viewer before it is behind. Two: one being written
/// and one waiting. Anything deeper is latency.
const QUEUED: usize = 2;
/// Frames written and not yet acknowledged, per viewer. Past this the path is
/// not keeping up and the queue above fills.
const IN_FLIGHT: usize = 6;
/// The viewer's housekeeping tick: gaps given up on, and every tenth, a ping
/// and the stats.
const VIEW_TICK: Duration = Duration::from_millis(100);
/// Control outranks every frame on the connection.
const CONTROL_PRIORITY: i32 = 10;

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

fn now_ms() -> u64 {
    now_us() / 1000
}

/// What this link holds for screens: the connections it dialled, and the
/// monitors it last read, for `Facts`.
#[derive(Default)]
pub(crate) struct Media {
    viewing: StdMutex<HashMap<String, Arc<Peer>>>,
    /// One dial at a time, so two tiles opened at once make one connection.
    dialling: tokio::sync::Mutex<()>,
    next_sid: AtomicU32,
    screens: StdMutex<Vec<Monitor>>,
}

impl Media {
    pub(super) fn screens(&self) -> Vec<Monitor> {
        self.screens.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

impl Link {
    /// Read this machine's monitors for the next announcement. A few
    /// milliseconds of DXGI, so off the runtime's workers.
    pub(super) async fn refresh_screens(&self) {
        if let Ok(m) = crate::off_main(hub::monitors).await {
            if let Ok(mut s) = self.media.screens.lock() {
                *s = m;
            }
        }
    }

    /// The take-work switch, read now (`act.rs` reads it the same way).
    fn takes_work(&self) -> bool {
        self.app
            .try_state::<Store>()
            .and_then(|s| s.0.lock().ok().map(|c| here::accepting(&c)))
            .unwrap_or(false)
    }

    /// Which wall an identity is, from the walls this one knows of.
    fn wall_of(&self, id: EndpointId) -> Option<String> {
        let mut hosts: Vec<String> = self.fleet.lock().map(|f| f.roster().map(|e| e.host.clone()).collect()).unwrap_or_default();
        hosts.extend(self.heard.lock().map(|h| h.iter().cloned().collect::<Vec<_>>()).unwrap_or_default());
        hosts.into_iter().find(|h| self.wire.peer(h).ok() == Some(id))
    }

    /// The connection to `host`, dialled if there is none.
    async fn peer_for(self: &Arc<Self>, host: &str) -> Result<Arc<Peer>, String> {
        let _one = self.media.dialling.lock().await;
        if let Some(p) = self.media.viewing.lock().ok().and_then(|v| v.get(host).cloned()) {
            if p.conn.close_reason().is_none() {
                return Ok(p);
            }
        }
        let id = self.wire.peer(host)?;
        let conn = self.wire.dial_cast(id).await?;
        let mut ex = [0u8; 32];
        conn.export_keying_material(&mut ex, fc::EXPORTER_LABEL, b"")
            .map_err(|e| format!("could not key the screen's connection: {e:?}"))?;
        let (seal, open) = fc::keys(self.wire.key(), &ex, true)?;
        let (send, recv) = conn.open_bi().await.map_err(|e| format!("could not open the screen's control: {e}"))?;
        let _ = send.set_priority(CONTROL_PRIORITY);
        let (tx, rx) = mpsc::unbounded_channel();
        let peer = Arc::new(Peer {
            host: host.to_string(),
            conn: conn.clone(),
            seal,
            open: Arc::new(open),
            ctl: tx,
            sessions: StdMutex::new(HashMap::new()),
            clock: StdMutex::new(fc::Clock::default()),
        });
        tauri::async_runtime::spawn(write_control(send, rx));
        tauri::async_runtime::spawn(peer.clone().read_control(recv));
        tauri::async_runtime::spawn(peer.clone().read_frames());
        tauri::async_runtime::spawn(peer.clone().read_datagrams());
        tauri::async_runtime::spawn(peer.clone().tick());
        let l = self.clone();
        let p = peer.clone();
        tauri::async_runtime::spawn(async move {
            let why = p.conn.closed().await;
            p.end_all(&format!("the connection to {} closed ({why})", p.host));
            if let Ok(mut v) = l.media.viewing.lock() {
                if v.get(&p.host).is_some_and(|q| Arc::ptr_eq(q, &p)) {
                    v.remove(&p.host);
                }
            }
        });
        if let Ok(mut v) = self.media.viewing.lock() {
            v.insert(host.to_string(), peer.clone());
        }
        Ok(peer)
    }
}

/* ── shared by both ends ─────────────────────────────────────────────────── */

/// Drain a channel of sealed messages onto a stream, length-prefixed.
async fn write_control(mut send: SendStream, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(m) = rx.recv().await {
        let Ok(p) = fc::prefix(m.len()) else { continue };
        if send.write_all(&p).await.is_err() || send.write_all(&m).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
}

/// One sealed message off a stream: `None` at a clean end, an error for a
/// stream cut off mid-message (reset, or the connection gone).
async fn read_message(recv: &mut RecvStream) -> Result<Option<Vec<u8>>, String> {
    let mut len = [0u8; 4];
    match recv.read_exact(&mut len).await {
        Ok(()) => {}
        Err(ReadExactError::FinishedEarly(0)) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let n = fc::announced(len)?;
    let mut buf = vec![0u8; n];
    recv.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

/// The path the connection is on now, and a reading of it for `Steer`.
fn read_path(conn: &Connection) -> Option<(Path, fc::Sample)> {
    let paths = conn.paths();
    let p = paths.iter().find(|p| p.is_selected())?;
    let st = p.stats();
    let rtt = p.rtt();
    Some((
        if p.is_relay() { Path::Relay } else { Path::Direct },
        fc::Sample { sent: st.udp_tx.datagrams, lost: st.lost_packets, rtt_ms: rtt.as_secs_f64() * 1000.0, cwnd: st.cwnd },
    ))
}

fn seal_send(seal: &Sealer, ctl: &mpsc::UnboundedSender<Vec<u8>>, kind: u8, sid: u32, body: &[u8]) {
    if let Ok(m) = seal.seal(kind, sid, body) {
        let _ = ctl.send(m);
    }
}

fn seal_datagram(seal: &Sealer, conn: &Connection, kind: u8, sid: u32, body: &[u8]) {
    if let Ok(m) = seal.seal(kind, sid, body) {
        /* Never waits: a full buffer drops the oldest, which for a pointer is
           exactly right. Too large for the path's datagram size goes nowhere,
           and nothing sent this way is ever that large. */
        let _ = conn.send_datagram(bytes::Bytes::from(m));
    }
}

/* ── the viewer's end ────────────────────────────────────────────────────── */

/// This wall's connection to one host wall, shared by every screen of it.
struct Peer {
    host: String,
    conn: Connection,
    seal: Sealer,
    open: Arc<Opener>,
    ctl: mpsc::UnboundedSender<Vec<u8>>,
    sessions: StdMutex<HashMap<u32, Watching>>,
    clock: StdMutex<fc::Clock>,
}

/// One screen being watched from here.
struct Watching {
    viewer: Arc<dyn Viewer>,
    configs: fc::Configs,
    /// Frames, with the config that rode in front of a keyframe.
    order: fc::Order<(Option<String>, Out)>,
    /// The `subscribe` call still waiting for the host's yes.
    opening: Option<oneshot::Sender<Result<(), String>>>,
}

/// A screen on another wall, as the loopback socket holds it. Dropping it
/// ends the session; the connection lingers a moment in case another follows.
pub struct RemoteSubscription {
    peer: Arc<Peer>,
    sid: u32,
}

/// Open a screen on another wall. Answers once the host has said yes, or with
/// the host's reason — which the socket draws as `refused`.
pub async fn subscribe(
    app: &AppHandle,
    host: &str,
    monitor: &str,
    want: Want,
    viewer: Arc<dyn Viewer>,
) -> Result<RemoteSubscription, String> {
    let link = current(app).ok_or("this wall is not on a flyway")?;
    if link.tenure.is_closed() {
        return Err("this wall has left the flyway".into());
    }
    let peer = link.peer_for(host).await?;
    let sid = link.media.next_sid.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    if let Ok(mut s) = peer.sessions.lock() {
        s.insert(sid, Watching { viewer, configs: fc::Configs::default(), order: fc::Order::default(), opening: Some(tx) });
    }
    peer.say(fc::K_CTL, sid, &Ctl::Open { monitor: monitor.to_string(), want }.to_body());
    let sub = RemoteSubscription { peer, sid };
    match tokio::time::timeout(OPEN_WITHIN, rx).await {
        Ok(Ok(Ok(()))) => Ok(sub),
        Ok(Ok(Err(why))) => Err(why),
        Ok(Err(_)) => Err(format!("the connection to {host} closed before it answered")),
        Err(_) => Err(format!("{host} did not answer within {}s", OPEN_WITHIN.as_secs())),
    }
    /* `sub` dropping on every error arm is what tells the host to forget it. */
}

impl RemoteSubscription {
    pub fn want(&self, want: Want) {
        self.peer.say(fc::K_CTL, self.sid, &Ctl::Want { want }.to_body());
    }

    pub fn key(&self) {
        self.peer.say(fc::K_CTL, self.sid, &Ctl::Key.to_body());
    }

    /// Input from the tile: what must arrive on the control stream, the rest
    /// as datagrams (`cast::split`).
    pub fn input(&self, events: &[Input]) {
        let (sure, loose) = fc::split(events);
        if !sure.is_empty() {
            self.peer.say(fc::K_INPUT, self.sid, &sure);
        }
        if !loose.is_empty() {
            seal_datagram(&self.peer.seal, &self.peer.conn, fc::K_INPUT, self.sid, &loose);
        }
    }
}

impl Drop for RemoteSubscription {
    fn drop(&mut self) {
        self.peer.say(fc::K_CTL, self.sid, &Ctl::Close.to_body());
        let empty = self
            .peer
            .sessions
            .lock()
            .map(|mut s| {
                s.remove(&self.sid);
                s.is_empty()
            })
            .unwrap_or(false);
        if empty {
            let p = self.peer.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(LINGER).await;
                if p.sessions.lock().map(|s| s.is_empty()).unwrap_or(false) {
                    p.conn.close(0u32.into(), b"no screens");
                }
            });
        }
    }
}

impl Peer {
    fn say(&self, kind: u8, sid: u32, body: &[u8]) {
        seal_send(&self.seal, &self.ctl, kind, sid, body);
    }

    /// Every session over, with the reason — a `subscribe` still waiting is
    /// answered with it, a live tile is told its screen ended.
    fn end_all(&self, why: &str) {
        let gone: Vec<Watching> = self.sessions.lock().map(|mut s| s.drain().map(|(_, w)| w).collect()).unwrap_or_default();
        for mut w in gone {
            match w.opening.take() {
                Some(tx) => {
                    let _ = tx.send(Err(why.to_string()));
                }
                None => {
                    w.viewer.send(Out::Text(fc::state("ended", Some(why)).into()));
                }
            }
        }
    }

    /// One message from the host, from whichever shape it rode.
    fn heard(&self, o: Opened) {
        let Ok(mut sessions) = self.sessions.lock() else { return };
        let Some(w) = sessions.get_mut(&o.sid) else { return };
        match o.kind {
            fc::K_CTL => match Ctl::from_body(o.body()) {
                Some(Ctl::Opened) => {
                    if let Some(tx) = w.opening.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                Some(Ctl::Refused { why }) => {
                    if let Some(tx) = w.opening.take() {
                        let _ = tx.send(Err(why));
                    } else {
                        w.viewer.send(Out::Text(fc::state("refused", Some(&why)).into()));
                    }
                    sessions.remove(&o.sid);
                }
                Some(Ctl::Close) => {
                    let why = format!("{} closed this screen", self.host);
                    w.viewer.send(Out::Text(fc::state("ended", Some(&why)).into()));
                    sessions.remove(&o.sid);
                }
                _ => {}
            },
            fc::K_TEXT => {
                if let Ok(t) = std::str::from_utf8(o.body()) {
                    w.viewer.send(Out::Text(t.into()));
                }
            }
            fc::K_BIN => {
                w.viewer.send(Out::Binary(o.body().into()));
            }
            _ => {}
        }
    }

    /// A frame's stream, read whole: the config in front of a keyframe and the
    /// frame. Handed on in order (`cast::Order`).
    fn frame(&self, sid: u32, config: Option<String>, frame: Arc<[u8]>) {
        let Some((h, _)) = cw::read_video(&frame) else { return };
        let Ok(mut sessions) = self.sessions.lock() else { return };
        let Some(w) = sessions.get_mut(&sid) else { return };
        for (cfg, out) in w.order.arrive(h.seq, h.key, now_ms(), (config, Out::Binary(frame))) {
            if let Some(c) = cfg {
                if w.configs.fresh(&c) {
                    w.viewer.send(Out::Text(c.into()));
                }
            }
            w.viewer.send(out);
        }
    }

    async fn read_control(self: Arc<Self>, mut recv: RecvStream) {
        while let Ok(Some(m)) = read_message(&mut recv).await {
            match self.open.open(m) {
                Ok(o) => self.heard(o),
                Err(e) => log::debug!("flyway: {e} from {}", self.host),
            }
        }
    }

    async fn read_frames(self: Arc<Self>) {
        while let Ok(mut recv) = self.conn.accept_uni().await {
            let p = self.clone();
            tauri::async_runtime::spawn(async move {
                let (mut sid, mut config, mut frame) = (None, None, None);
                loop {
                    match read_message(&mut recv).await {
                        Ok(Some(m)) => {
                            let Ok(o) = p.open.open(m) else { return };
                            sid = Some(o.sid);
                            match o.kind {
                                fc::K_TEXT => config = std::str::from_utf8(o.body()).ok().map(str::to_string),
                                fc::K_BIN => frame = Some(Arc::<[u8]>::from(o.body())),
                                _ => {}
                            }
                        }
                        Ok(None) => break,
                        /* Reset because a newer keyframe passed it, or cut off:
                           nothing on this stream is shown. */
                        Err(_) => return,
                    }
                }
                if let (Some(sid), Some(frame)) = (sid, frame) {
                    p.frame(sid, config, frame);
                }
            });
        }
    }

    async fn read_datagrams(self: Arc<Self>) {
        while let Ok(d) = self.conn.read_datagram().await {
            let Ok(o) = self.open.open(d.to_vec()) else { continue };
            match o.kind {
                fc::K_PONG => {
                    if let (Some((sent, host)), Ok(mut c)) = (fc::read_pong(o.body()), self.clock.lock()) {
                        c.sample(sent, host, now_us());
                    }
                }
                _ => self.heard(o),
            }
        }
    }

    /// Gaps given up on every tick; a ping and the stats every second.
    async fn tick(self: Arc<Self>) {
        let mut n = 0u32;
        while self.conn.close_reason().is_none() {
            tokio::time::sleep(VIEW_TICK).await;
            n = n.wrapping_add(1);
            let now = now_ms();
            let gave_up: Vec<u32> = self
                .sessions
                .lock()
                .map(|mut s| s.iter_mut().filter_map(|(sid, w)| w.order.expire(now).then_some(*sid)).collect())
                .unwrap_or_default();
            for sid in gave_up {
                self.say(fc::K_CTL, sid, &Ctl::Key.to_body());
            }
            if n % 10 != 0 {
                continue;
            }
            seal_datagram(&self.seal, &self.conn, fc::K_PING, 0, &now_us().to_le_bytes());
            let path = read_path(&self.conn);
            let offset = self.clock.lock().ok().and_then(|c| c.offset_us());
            let stats = fc::stats(path.map(|p| p.0), path.map(|p| p.1.rtt_ms), None, offset, None);
            if let Ok(s) = self.sessions.lock() {
                for w in s.values().filter(|w| w.opening.is_none()) {
                    w.viewer.send(Out::Text(stats.as_str().into()));
                }
            }
        }
    }
}

/* ── the host's end ──────────────────────────────────────────────────────── */

/// What the host's front end hears, to draw "seen / driven from <wall>".
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Watched {
    /// The wall watching, or `None` if it has not announced itself.
    viewer: Option<String>,
    monitor: String,
    sid: u32,
    /// Open now; false is the session's end.
    on: bool,
    /// Input has arrived on it.
    driven: bool,
}

/// One connection another wall opened to this one.
struct Hosting {
    app: AppHandle,
    me: String,
    viewer_wall: Option<String>,
    conn: Connection,
    seal: Arc<Sealer>,
    ctl: mpsc::UnboundedSender<Vec<u8>>,
    sessions: StdMutex<HashMap<u32, Shown>>,
    steer: StdMutex<fc::Steer>,
    path: StdMutex<Option<Path>>,
}

/// One of this wall's monitors, shown to that wall.
struct Shown {
    monitor: String,
    sub: Arc<hub::Sub>,
    viewer: Arc<Outgoing>,
    want: Want,
    fit: fc::Fit,
    driven: bool,
}

/// Answer a screen's connection from another wall, for as long as it stays.
pub(super) async fn host(link: Arc<Link>, conn: Connection) {
    let mut ex = [0u8; 32];
    if conn.export_keying_material(&mut ex, fc::EXPORTER_LABEL, b"").is_err() {
        return;
    }
    let Ok((seal, open)) = fc::keys(link.wire.key(), &ex, false) else { return };
    let Ok((send, mut recv)) = conn.accept_bi().await else { return };
    let _ = send.set_priority(CONTROL_PRIORITY);
    let (tx, rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(write_control(send, rx));
    let h = Arc::new(Hosting {
        app: link.app.clone(),
        me: link.me.clone(),
        viewer_wall: link.wall_of(conn.remote_id()),
        conn: conn.clone(),
        seal: Arc::new(seal),
        ctl: tx,
        sessions: StdMutex::new(HashMap::new()),
        steer: StdMutex::new(fc::Steer::default()),
        path: StdMutex::new(read_path(&conn).map(|p| p.0)),
    });
    let open = Arc::new(open);
    {
        let (h, open) = (h.clone(), open.clone());
        tauri::async_runtime::spawn(async move {
            while let Ok(d) = h.conn.read_datagram().await {
                let Ok(o) = open.open(d.to_vec()) else { continue };
                match o.kind {
                    fc::K_PING => {
                        if let Some(t) = fc::read_ping(o.body()) {
                            seal_datagram(&h.seal, &h.conn, fc::K_PONG, 0, &fc::pong(t, now_us()));
                        }
                    }
                    fc::K_INPUT => h.input(o.sid, o.body()),
                    _ => {}
                }
            }
        });
    }
    tauri::async_runtime::spawn(h.clone().steer(link.clone()));
    while let Ok(Some(m)) = read_message(&mut recv).await {
        let Ok(o) = open.open(m) else { continue };
        match o.kind {
            fc::K_CTL => match Ctl::from_body(o.body()) {
                Some(c) => h.clone().control(&link, o.sid, c).await,
                None => {}
            },
            fc::K_INPUT => h.input(o.sid, o.body()),
            _ => {}
        }
    }
    let sids: Vec<u32> = h.sessions.lock().map(|s| s.keys().copied().collect()).unwrap_or_default();
    for sid in sids {
        h.end(sid);
    }
    conn.close(0u32.into(), b"done");
}

impl Hosting {
    fn say(&self, kind: u8, sid: u32, body: &[u8]) {
        seal_send(&self.seal, &self.ctl, kind, sid, body);
    }

    fn mark(&self, sid: u32, monitor: &str, on: bool, driven: bool) {
        let _ = self.app.emit(
            "cast:watched",
            Watched { viewer: self.viewer_wall.clone(), monitor: monitor.to_string(), sid, on, driven },
        );
    }

    async fn control(self: Arc<Self>, link: &Arc<Link>, sid: u32, c: Ctl) {
        match c {
            Ctl::Open { monitor, want } => self.open(link, sid, monitor, want).await,
            Ctl::Want { want } => {
                let path = self.path.lock().ok().and_then(|p| *p).unwrap_or(Path::Relay);
                let cap = self.steer.lock().ok().and_then(|s| s.cap());
                if let Ok(mut s) = self.sessions.lock() {
                    if let Some(sh) = s.get_mut(&sid) {
                        sh.want = want;
                        self.refit(sid, sh, path, cap);
                    }
                }
            }
            Ctl::Key => {
                if let Some(sub) = self.sessions.lock().ok().and_then(|s| s.get(&sid).map(|sh| sh.sub.clone())) {
                    sub.key();
                }
            }
            Ctl::Close => self.end(sid),
            _ => {}
        }
    }

    async fn open(self: Arc<Self>, link: &Arc<Link>, sid: u32, monitor: String, want: Want) {
        if self.sessions.lock().map(|s| s.contains_key(&sid)).unwrap_or(true) {
            return;
        }
        /* Fresh, every time: the switch may have been turned off a second ago. */
        if let Err(why) = fc::may_show(link.takes_work(), &self.me) {
            self.say(fc::K_CTL, sid, &Ctl::Refused { why }.to_body());
            return;
        }
        let path = self.path.lock().ok().and_then(|p| *p).unwrap_or(Path::Relay);
        let fit = fc::fit(want, path, self.steer.lock().ok().and_then(|s| s.cap()));
        let (frames, rx) = mpsc::channel(QUEUED);
        let viewer = Arc::new(Outgoing {
            sid,
            conn: self.conn.clone(),
            seal: self.seal.clone(),
            ctl: self.ctl.clone(),
            frames,
            behind: StdMutex::new(fc::Behind::default()),
            config: StdMutex::new(None),
            want_key: Arc::new(Notify::new()),
            alive: AtomicBool::new(true),
        });
        let (m, w, v) = (monitor.clone(), fit.want, viewer.clone() as Arc<dyn Viewer>);
        /* Starting a capture is driver work, and may take a moment. */
        let sub = match crate::off_main(move || hub::subscribe(&m, w, v)).await {
            Ok(Ok(sub)) => Arc::new(sub),
            Ok(Err(why)) | Err(why) => {
                viewer.alive.store(false, Ordering::Release);
                self.say(fc::K_CTL, sid, &Ctl::Refused { why }.to_body());
                return;
            }
        };
        sub.cap(fit.kbps);
        /* Weak: the hub holds this session's viewer, which holds the frame
           queue, so a task holding the subscription strongly is a cycle — the
           capture would outlive the session for as long as the hub sent
           nothing (a paused tile sends nothing). Dropping `Shown` is what
           ends it. */
        tauri::async_runtime::spawn(send_frames(self.conn.clone(), self.seal.clone(), sid, rx, Arc::downgrade(&sub), viewer.want_key.clone()));
        let held = fit.held.clone();
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(sid, Shown { monitor: monitor.clone(), sub, viewer, want, fit, driven: false });
        }
        self.say(fc::K_CTL, sid, &Ctl::Opened.to_body());
        if let Some(h) = held {
            self.say(fc::K_TEXT, sid, fc::state("live", Some(&h)).as_bytes());
        }
        self.mark(sid, &monitor, true, false);
    }

    /// Hand the hub what the path allows, and tell the tile if that changed
    /// what it is held to.
    fn refit(&self, sid: u32, sh: &mut Shown, path: Path, cap: Option<u32>) {
        let fit = fc::fit(sh.want, path, cap);
        if fit == sh.fit {
            return;
        }
        if fit.want != sh.fit.want {
            sh.sub.want(fit.want);
        }
        if fit.kbps != sh.fit.kbps {
            sh.sub.cap(fit.kbps);
        }
        if fit.held != sh.fit.held {
            self.say(fc::K_TEXT, sid, fc::state("live", fit.held.as_deref()).as_bytes());
        }
        sh.fit = fit;
    }

    fn input(&self, sid: u32, body: &[u8]) {
        let events = cw::read_inputs(body);
        if events.is_empty() {
            return;
        }
        let (monitor, first) = {
            let Ok(mut s) = self.sessions.lock() else { return };
            let Some(sh) = s.get_mut(&sid) else { return };
            let first = !sh.driven;
            sh.driven = true;
            (sh.monitor.clone(), first)
        };
        if first {
            self.mark(sid, &monitor, true, true);
        }
        hub::input(&monitor, &events);
    }

    /// A session over: the hub let go of, anything held down lifted, the mark
    /// taken down.
    fn end(&self, sid: u32) {
        let Some(sh) = self.sessions.lock().ok().and_then(|mut s| s.remove(&sid)) else { return };
        sh.viewer.alive.store(false, Ordering::Release);
        if sh.driven {
            hub::input(&sh.monitor, &[Input::ReleaseAll]);
        }
        self.mark(sid, &sh.monitor, false, sh.driven);
    }

    /// Every half-second: read the path, steer the encoder, and every two
    /// seconds ask the switch again — turned off mid-screen ends the screen.
    async fn steer(self: Arc<Self>, link: Arc<Link>) {
        let mut n = 0u32;
        while self.conn.close_reason().is_none() {
            tokio::time::sleep(Duration::from_millis(fc::STEER_EVERY_MS)).await;
            n = n.wrapping_add(1);
            if n % 4 == 0 && !link.takes_work() {
                let sids: Vec<u32> = self.sessions.lock().map(|s| s.keys().copied().collect()).unwrap_or_default();
                let why = fc::may_show(false, &self.me).err().unwrap_or_default();
                for sid in sids {
                    self.say(fc::K_CTL, sid, &Ctl::Refused { why: why.clone() }.to_body());
                    self.end(sid);
                }
                continue;
            }
            let Some((path, sample)) = read_path(&self.conn) else { continue };
            if let Ok(mut p) = self.path.lock() {
                *p = Some(path);
            }
            let cap = self.steer.lock().ok().map(|mut s| s.step(sample)).flatten();
            if let Ok(mut s) = self.sessions.lock() {
                for (sid, sh) in s.iter_mut() {
                    self.refit(*sid, sh, path, cap);
                }
            }
        }
    }
}

/// The hub's viewer for one session on this connection. Never blocks: the
/// encoder's thread calls it.
struct Outgoing {
    sid: u32,
    conn: Connection,
    seal: Arc<Sealer>,
    ctl: mpsc::UnboundedSender<Vec<u8>>,
    frames: mpsc::Sender<(Option<Arc<str>>, Arc<[u8]>)>,
    behind: StdMutex<fc::Behind>,
    /// The last config, sent in front of every keyframe.
    config: StdMutex<Option<Arc<str>>>,
    want_key: Arc<Notify>,
    alive: AtomicBool,
}

impl Viewer for Outgoing {
    fn send(&self, out: Out) -> bool {
        if !self.alive.load(Ordering::Acquire) {
            return false;
        }
        match out {
            Out::Text(t) if fc::is_config(&t) => {
                if let Ok(mut c) = self.config.lock() {
                    *c = Some(t);
                }
            }
            Out::Text(t) => seal_send(&self.seal, &self.ctl, fc::K_TEXT, self.sid, t.as_bytes()),
            Out::Binary(b) if b.first() == Some(&cw::VIDEO) => {
                let key = cw::is_keyframe(&b);
                let room = self.frames.capacity() > 0;
                let admit = self.behind.lock().map(|mut g| g.admit(key, room)).unwrap_or(fc::Admit::Drop);
                match admit {
                    fc::Admit::Send => {
                        let cfg = if key { self.config.lock().ok().and_then(|c| c.clone()) } else { None };
                        let _ = self.frames.try_send((cfg, b));
                    }
                    fc::Admit::Drop => {}
                    fc::Admit::DropAndAskKey => self.want_key.notify_one(),
                }
            }
            Out::Binary(b) if b.first() == Some(&cw::CURSOR_POS) => {
                seal_datagram(&self.seal, &self.conn, fc::K_BIN, self.sid, &b)
            }
            Out::Binary(b) => seal_send(&self.seal, &self.ctl, fc::K_BIN, self.sid, &b),
        }
        true
    }
}

/// One session's frames onto the connection, a stream each, at most
/// `IN_FLIGHT` unacknowledged. A keyframe resets every older frame still in
/// flight: nothing behind a keyframe is worth the bytes.
async fn send_frames(
    conn: Connection,
    seal: Arc<Sealer>,
    sid: u32,
    mut rx: mpsc::Receiver<(Option<Arc<str>>, Arc<[u8]>)>,
    sub: Weak<hub::Sub>,
    want_key: Arc<Notify>,
) {
    let in_flight = Arc::new(Semaphore::new(IN_FLIGHT));
    let (epoch, _) = watch::channel(0u64);
    loop {
        let (cfg, frame) = tokio::select! {
            got = rx.recv() => match got {
                Some(f) => f,
                None => break,
            },
            _ = want_key.notified() => {
                match sub.upgrade() {
                    Some(s) => s.key(),
                    None => break,
                }
                continue;
            }
        };
        if cw::is_keyframe(&frame) {
            epoch.send_modify(|e| *e += 1);
        }
        let mine = *epoch.borrow();
        let Ok(permit) = in_flight.clone().acquire_owned().await else { break };
        let mut msgs = Vec::with_capacity(2);
        if let Some(c) = cfg {
            msgs.extend(seal.seal(fc::K_TEXT, sid, c.as_bytes()).ok());
        }
        let Ok(m) = seal.seal(fc::K_BIN, sid, &frame) else { continue };
        msgs.push(m);
        let (conn, mut passed) = (conn.clone(), epoch.subscribe());
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let Ok(mut s) = conn.open_uni().await else { return };
            for m in &msgs {
                let Ok(p) = fc::prefix(m.len()) else { return };
                if s.write_all(&p).await.is_err() || s.write_all(m).await.is_err() {
                    return;
                }
            }
            let _ = s.finish();
            tokio::select! {
                _ = s.stopped() => {}
                _ = passed.wait_for(|e| *e > mine) => {
                    let _ = s.reset(VarInt::from_u32(0));
                }
            }
        });
    }
}
