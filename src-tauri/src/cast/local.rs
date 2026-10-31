//! The loopback socket a tile's Worker dials: `ws://127.0.0.1:<port>/<session>?t=<token>`.
//!
//! One port per run, bound on first use. `cast_open` mints a session — an id
//! and a token — and the socket refuses any request that does not name a
//! session it minted with that session's token, because any local process can
//! dial a loopback port. A session is consumed by the first socket to claim it
//! and lives exactly as long as that socket.
//!
//! Every socket gets two threads of its own, never Tauri's main thread and
//! never a tokio worker: one reads what the tile says (wants, key requests,
//! input) and one writes what the hub sends, popping an `Outbox` so a tile that
//! cannot keep up drops frames until the next keyframe rather than queueing.
//! The writer is a second `WebSocket` over a clone of the same `TcpStream`;
//! tungstenite's reader would also write if it were sent a ping, and our only
//! peer is our own Worker, which never pings (browsers cannot).
//!
//! `host: null` is this machine: the hub. Anything else is a wall on the
//! flyway, and the same `Viewer` is handed to `flyway::link::cast::subscribe`,
//! so the Worker cannot tell the two apart — which is the point.

use super::hub::{self, state_text, Outbox};
use super::{wire, Input, Out, Viewer, Want};
use std::collections::HashMap;
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

/// How long a minted session waits for its socket.
const CLAIM_WITHIN: Duration = Duration::from_secs(30);

struct Minted {
    token: String,
    host: Option<String>,
    monitor: String,
    at: Instant,
}

struct Server {
    port: u16,
    minted: Mutex<HashMap<String, Minted>>,
    /// `None` only in `examples/cast-probe.rs --serve`, which dials the real
    /// socket the way a tile does: no flyway, no window to exclude.
    app: Option<AppHandle>,
}

static SERVER: OnceLock<Result<Arc<Server>, String>> = OnceLock::new();

fn random_hex(bytes: usize) -> Result<String, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut b = vec![0u8; bytes];
    SystemRandom::new().fill(&mut b).map_err(|_| "no randomness for a session token".to_string())?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn server(app: Option<&AppHandle>) -> Result<Arc<Server>, String> {
    SERVER
        .get_or_init(|| {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("binding the screens socket: {e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let s = Arc::new(Server { port, minted: Mutex::default(), app: app.cloned() });
            let t = s.clone();
            std::thread::Builder::new()
                .name("cast-listen".into())
                .spawn(move || {
                    for conn in listener.incoming().flatten() {
                        let s = t.clone();
                        let _ = std::thread::Builder::new().name("cast-session".into()).spawn(move || session(s, conn));
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(s)
        })
        .clone()
}

/// Mint a session and say where to dial it.
pub fn open(app: &AppHandle, host: Option<String>, monitor: String) -> Result<String, String> {
    mint(Some(app), host, monitor)
}

/// The same, with no app behind it: the probe's end-to-end check of the
/// socket. Local monitors only.
pub fn open_bare(monitor: String) -> Result<String, String> {
    mint(None, None, monitor)
}

fn mint(app: Option<&AppHandle>, host: Option<String>, monitor: String) -> Result<String, String> {
    let s = server(app)?;
    let id = random_hex(8)?;
    let token = random_hex(16)?;
    let mut m = s.minted.lock().unwrap();
    m.retain(|_, v| v.at.elapsed() < CLAIM_WITHIN);
    m.insert(id.clone(), Minted { token: token.clone(), host, monitor, at: Instant::now() });
    Ok(format!("ws://127.0.0.1:{}/{id}?t={token}", s.port))
}

/// `/<session>?t=<token>` → the minted session, removed so it is claimed once.
fn claim(minted: &mut HashMap<String, Minted>, path: &str, query: Option<&str>) -> Option<Minted> {
    let id = path.strip_prefix('/')?;
    let token = query?.split('&').find_map(|kv| kv.strip_prefix("t="))?;
    let m = minted.get(id)?;
    if m.token != token || m.at.elapsed() >= CLAIM_WITHIN {
        return None;
    }
    minted.remove(id)
}

/// What the session is attached to.
enum Feed {
    /// This machine. Input reaches it only through the input lane's
    /// through-the-tile mode (`drive.rs`), never `inject` — injected clicks
    /// would land on Volery, which is covering the very desktop being shown.
    /// While `drive` is `None` a local tile's input is dropped here.
    Local {
        sub: hub::Subscription,
        monitor: super::Monitor,
        drive: Option<super::drive::Drive>,
        _exclude: Option<super::exclude::Hold>,
    },
    /// Another wall. Its input always goes; while the tile is focused, the
    /// keyboard is captured too, so Win, Alt+Tab and Alt+F4 reach the far
    /// machine rather than this one (`drive::Keys::Capture`).
    Remote { sub: Arc<crate::flyway::link::cast::RemoteSubscription>, keys: Option<super::drive::Hold> },
}

impl Feed {
    fn key(&self) {
        match self {
            Feed::Local { sub, .. } => sub.key(),
            Feed::Remote { sub, .. } => sub.key(),
        }
    }

    fn input(&self, events: &[Input]) {
        match self {
            Feed::Local { drive: Some(d), .. } => d.apply(events),
            Feed::Local { drive: None, .. } => {}
            Feed::Remote { sub, .. } => sub.input(events),
        }
    }

    fn want(&mut self, w: Want, app: Option<&AppHandle>, viewer: &Arc<Outbox>) {
        match self {
            Feed::Local { sub, .. } => sub.want(w),
            Feed::Remote { sub, keys } => {
                sub.want(w);
                if w.focused && keys.is_none() {
                    *keys = capture_keys(app, sub.clone(), viewer.clone());
                } else if !w.focused {
                    keys.take();
                }
            }
        }
    }

    /// `{"t":"drive","on":…}`. Answered with the same message carrying what
    /// actually happened, and a `why` when it did not.
    fn drive(&mut self, on: bool, app: Option<&AppHandle>, viewer: &Arc<Outbox>) {
        let said = match self {
            Feed::Local { monitor, drive, .. } => {
                if on && drive.is_none() {
                    match volery_hwnd(app).and_then(|h| super::drive::Drive::start(h, monitor, viewer.clone())) {
                        Ok(d) => {
                            *drive = Some(d);
                            Ok(true)
                        }
                        Err(why) => Err(why),
                    }
                } else if !on {
                    if let Some(mut d) = drive.take() {
                        // Waits for a click still in flight, then restores.
                        d.leave();
                        log_settles();
                    }
                    Ok(false)
                } else {
                    Ok(true)
                }
            }
            // A far screen is driven by its input alone; there is no mode.
            Feed::Remote { .. } => Ok(on),
        };
        let msg = match said {
            Ok(on) => serde_json::json!({ "t": "drive", "on": on }),
            Err(why) => serde_json::json!({ "t": "drive", "on": false, "why": why }),
        };
        viewer.send(Out::Text(msg.to_string().into()));
    }
}

/// Whether clicks through the tile land: the mouse hook's count of clicks it
/// saw delivered, and of those it gave up on — a climbing second number is
/// clicks landing on Volery (`drive::settles`). Logged at each drive's end,
/// as the field reading for the settle bound.
fn log_settles() {
    let (confirmed, gave_up) = super::drive::settles();
    log::info!("cast: drive settles so far: {confirmed} confirmed, {gave_up} gave up");
}

fn volery_hwnd(app: Option<&AppHandle>) -> Result<isize, String> {
    use tauri::Manager;
    let w = app.and_then(|a| a.get_webview_window("main")).ok_or("no main window to step aside")?;
    Ok(w.hwnd().map_err(|e| e.to_string())?.0 as isize)
}

fn capture_keys(
    app: Option<&AppHandle>,
    sub: Arc<crate::flyway::link::cast::RemoteSubscription>,
    viewer: Arc<Outbox>,
) -> Option<super::drive::Hold> {
    let hwnd = volery_hwnd(app).ok()?;
    let sink: Arc<dyn Fn(&[Input]) + Send + Sync> = Arc::new(move |ev| sub.input(ev));
    match super::drive::hold(super::drive::Keys::Capture(sink), hwnd, viewer, Box::new(|| {})) {
        Ok(h) => Some(h),
        Err(e) => {
            // Another screen holds the keyboard; this one still drives,
            // without the system keys.
            log::info!("cast: keyboard capture for a far screen refused: {e}");
            None
        }
    }
}

/// A viewer's want, as the tile sends it.
pub fn parse_want(v: &serde_json::Value) -> Option<Want> {
    let n = |k: &str| v.get(k).and_then(|x| x.as_f64()).map(|x| x.max(0.0).round() as u32);
    Some(Want {
        w: n("w")?,
        h: n("h")?,
        fps: n("fps").unwrap_or(0),
        visible: v.get("visible").and_then(|x| x.as_bool()).unwrap_or(true),
        focused: v.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

fn session(server: Arc<Server>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let claimed: Arc<Mutex<Option<Minted>>> = Arc::default();
    let (into, s2) = (claimed.clone(), server.clone());
    let ws = tungstenite::accept_hdr(stream, move |req: &Request, resp: Response| {
        let mut m = s2.minted.lock().unwrap();
        match claim(&mut m, req.uri().path(), req.uri().query()) {
            Some(c) => {
                *into.lock().unwrap() = Some(c);
                Ok(resp)
            }
            None => {
                let mut e = ErrorResponse::new(Some("no such screen session".into()));
                *e.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                Err(e)
            }
        }
    });
    let claimed = claimed.lock().unwrap().take();
    let (Ok(mut ws), Some(minted)) = (ws, claimed) else { return };
    let Ok(raw) = ws.get_ref().try_clone() else { return };
    let mut writer = WebSocket::from_raw_socket(raw, Role::Server, None);

    let outbox = Outbox::new();
    let feed: Arc<Mutex<Option<Feed>>> = Arc::default();

    // The writer: everything the hub (or the flyway) hands this viewer.
    let (wo, wf) = (outbox.clone(), feed.clone());
    let write = std::thread::Builder::new().name("cast-write".into()).spawn(move || {
        crate::cast::capture::urgent();
        loop {
            if wo.take_key_request() {
                if let Some(f) = wf.lock().unwrap().as_ref() {
                    f.key();
                }
            }
            match wo.pop(Duration::from_millis(250)) {
                Some(Out::Binary(b)) => {
                    if writer.send(Message::binary(b.to_vec())).is_err() {
                        break;
                    }
                }
                Some(Out::Text(t)) => {
                    if writer.send(Message::text(t.to_string())).is_err() {
                        break;
                    }
                }
                None if wo.is_closed() => break,
                None => {}
            }
        }
        wo.close();
    });

    // The reader: this thread. Nothing is subscribed until the first want,
    // which is the first thing the tile knows about itself.
    loop {
        let msg = match ws.read() {
            Ok(m) => m,
            Err(_) => break,
        };
        match msg {
            Message::Text(t) => {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(t.as_str()) else { continue };
                match v.get("t").and_then(|x| x.as_str()) {
                    Some("want") => {
                        let Some(w) = parse_want(&v) else { continue };
                        let mut f = feed.lock().unwrap();
                        match f.as_mut() {
                            Some(feed) => feed.want(w, server.app.as_ref(), &outbox),
                            None => match attach(server.app.as_ref(), &minted, w, outbox.clone()) {
                                Ok(mut made) => {
                                    // A first want may already be focused.
                                    made.want(w, server.app.as_ref(), &outbox);
                                    *f = Some(made);
                                }
                                Err(why) => {
                                    outbox.send(state_text("refused", Some(&why)));
                                    break;
                                }
                            },
                        }
                    }
                    Some("key") => {
                        if let Some(f) = feed.lock().unwrap().as_ref() {
                            f.key();
                        }
                    }
                    Some("drive") => {
                        let on = v.get("on").and_then(|x| x.as_bool()).unwrap_or(false);
                        if let Some(f) = feed.lock().unwrap().as_mut() {
                            f.drive(on, server.app.as_ref(), &outbox);
                        }
                    }
                    _ => {}
                }
            }
            Message::Binary(b) => {
                let events = wire::read_inputs(&b);
                if !events.is_empty() {
                    if let Some(f) = feed.lock().unwrap().as_ref() {
                        f.input(&events);
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    // The socket is gone: unsubscribe (and lift every held key) before the
    // writer drains, so nothing more is sent to a viewer nobody reads.
    if let Some(Feed::Local { drive: Some(_), .. }) = feed.lock().unwrap().take() {
        log_settles();
    }
    outbox.close();
    if let Ok(w) = write {
        let _ = w.join();
    }
}

fn attach(app: Option<&AppHandle>, m: &Minted, want: Want, outbox: Arc<Outbox>) -> Result<Feed, String> {
    let viewer: Arc<dyn Viewer> = outbox;
    match &m.host {
        None => {
            let monitor = super::monitors::list().into_iter().find(|x| x.id == m.monitor).ok_or("that monitor is gone")?;
            let sub = hub::subscribe(&m.monitor, want, viewer)?;
            Ok(Feed::Local { sub, monitor, drive: None, _exclude: app.map(super::exclude::hold) })
        }
        Some(host) => {
            let app = app.ok_or("no flyway without the app")?;
            let sub = tauri::async_runtime::block_on(crate::flyway::link::cast::subscribe(app, host, &m.monitor, want, viewer))?;
            Ok(Feed::Remote { sub: Arc::new(sub), keys: None })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minted(token: &str) -> HashMap<String, Minted> {
        let mut m = HashMap::new();
        m.insert("abcd".into(), Minted { token: token.into(), host: None, monitor: "m".into(), at: Instant::now() });
        m
    }

    #[test]
    fn a_session_is_claimed_once_and_only_with_its_token() {
        let mut m = minted("s3cret");
        assert!(claim(&mut m, "/abcd", Some("t=wrong")).is_none());
        assert!(claim(&mut m, "/abcd", None).is_none());
        assert!(claim(&mut m, "/other", Some("t=s3cret")).is_none());
        assert!(claim(&mut m, "/abcd", Some("x=1&t=s3cret")).is_some());
        assert!(claim(&mut m, "/abcd", Some("t=s3cret")).is_none(), "a second socket cannot claim it");
    }

    #[test]
    fn a_want_reads_the_tiles_numbers_and_defaults_the_rest() {
        let v = serde_json::json!({ "t": "want", "w": 1279.6, "h": 720, "fps": 60, "visible": false, "focused": true });
        assert_eq!(parse_want(&v), Some(Want { w: 1280, h: 720, fps: 60, visible: false, focused: true }));
        let v = serde_json::json!({ "t": "want", "w": 640, "h": 360 });
        assert_eq!(parse_want(&v), Some(Want { w: 640, h: 360, fps: 0, visible: true, focused: false }));
        assert_eq!(parse_want(&serde_json::json!({ "t": "want" })), None);
    }
}
