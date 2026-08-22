//! A control surface, so the thing being built can be driven without hands.
//!
//! Everything else in this app has been provable from a desk: the classifier has
//! tests, the store has migrations, the MCP endpoint was probed before it was
//! written. The wall itself never was. Three paths shipped that nobody but the
//! author had ever touched — and two real bugs (the wake deadlock, the close
//! button that swallowed its own click) were found by *them*, at the mouse,
//! because there was no way for me to reach the running app.
//!
//! This is that way. A loopback HTTP endpoint takes an op, hands it to the
//! webview, and returns whatever the webview says. The ops deliberately speak
//! the app's own vocabulary — `conv:event`, `tauri://drag-drop`, `ask:opened` —
//! rather than reaching into component internals. Driving the same seams Rust
//! drives means a green run is evidence about the app, not about the harness.
//!
//! Off unless asked for. `SKEIN_CONTROL=1` binds an ephemeral port, writes the
//! port and a fresh token to `control.json` beside the database, and lights a
//! chip in the title bar — a surface that can drive the app should never be
//! quietly on.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// Long enough for an op that spawns a `claude` process, short enough that a
/// wedged webview reports as wedged instead of hanging the caller forever.
const OP_TIMEOUT: Duration = Duration::from_secs(45);

/// The header carrying the token. Deliberately not a simple header: a browser
/// would have to preflight it, and we answer no CORS, so a random web page
/// cannot reach this even knowing the port.
const TOKEN_HEADER: &str = "X-Skein-Token";

#[derive(Default)]
pub struct Control {
    pending: Mutex<HashMap<String, Sender<Value>>>,
    endpoint: Mutex<Option<Endpoint>>,
    /// The studio has registered its listener. Until it has, an op would be
    /// emitted into an empty room and time out with nothing to say about why.
    attached: AtomicBool,
    /// How many times a studio has attached, and the newest generation number.
    ///
    /// One attachment is a healthy app. More than one means the front end has
    /// been hot-reloaded, which is worth knowing before you spend twenty
    /// minutes wondering why two ops disagree about what is on the wall — a
    /// superseded instance is supposed to stay silent, and this is how you
    /// check that it is.
    attachments: AtomicU32,
    generation: AtomicU32,
    /// Where the published token lives, so it can be taken away on exit.
    file: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

impl Control {
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.endpoint.lock().unwrap().clone()
    }
    pub fn set_endpoint(&self, ep: Endpoint) {
        *self.endpoint.lock().unwrap() = Some(ep);
    }

    /// Take the published endpoint away on the way out. A `control.json` that
    /// outlives its process is worse than none: the port reads as live, and the
    /// connection refused looks like a bug in whatever is calling.
    pub fn cleanup(&self) {
        if let Some(path) = self.file.lock().unwrap().take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// What the title bar shows, and what the peek window learns nothing from.
#[tauri::command]
pub fn control_endpoint(control: State<'_, Control>) -> Option<Endpoint> {
    control.endpoint()
}

/// The studio saying it is listening, and which generation it is.
#[tauri::command]
pub fn control_attach(control: State<'_, Control>, generation: Option<u32>) {
    control.attached.store(true, Ordering::SeqCst);
    control.attachments.fetch_add(1, Ordering::SeqCst);
    control
        .generation
        .store(generation.unwrap_or(1), Ordering::SeqCst);
}

/// The studio's answer to one op, handed back to the parked HTTP request.
#[tauri::command]
pub fn control_reply(
    control: State<'_, Control>,
    rid: String,
    value: Value,
) -> Result<(), String> {
    let tx = control
        .pending
        .lock()
        .unwrap()
        .remove(&rid)
        .ok_or("that op is no longer waiting")?;
    tx.send(value).map_err(|_| "the caller has gone".to_string())
}

/* ── real input ────────────────────────────────────────────────────────────
 *
 * A synthetic `pointerdown` proves my handlers are wired to each other. It does
 * not prove Chromium will deliver a click, and that is precisely the bug class
 * that has bitten this app twice — `setPointerCapture` retargeting a *real*
 * click is invisible to any event you dispatch yourself.
 *
 * So these move the actual cursor and press the actual button. The undecorated
 * window is what makes the arithmetic honest: with no frame, the client origin
 * is the window origin, so a CSS point converts with one multiply. */

/// Real input is a *separate* opt-in from the control surface.
///
/// `SKEIN_CONTROL=1` deliberately does not arm the mouse. Almost every op is a
/// read or a message, and those should be reachable without the ability to grab
/// the cursor mid-sentence and click wherever a card happens to be — the author
/// is usually working in another window while this runs.
pub(crate) fn input_armed(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("on") | Some("true") | Some("yes")
    )
}

const NOT_ARMED: &str = "real input needs SKEIN_CONTROL_INPUT=1 as well — \
     SKEIN_CONTROL alone does not arm the mouse, on purpose. Every other op works.";

fn check_armed() -> Result<(), String> {
    if input_armed(std::env::var("SKEIN_CONTROL_INPUT").ok().as_deref()) {
        Ok(())
    } else {
        Err(NOT_ARMED.to_string())
    }
}

/// CSS pixels in the main webview → physical screen pixels.
#[cfg(windows)]
fn to_screen(app: &AppHandle, x: f64, y: f64) -> Result<(i32, i32), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("no main window to aim at")?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    /* inner_position is the client area's origin, which is the origin CSS
       coordinates are measured from. */
    let origin = win.inner_position().map_err(|e| e.to_string())?;
    Ok((
        origin.x + (x * scale).round() as i32,
        origin.y + (y * scale).round() as i32,
    ))
}

#[cfg(windows)]
mod win {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    pub fn cursor() -> (i32, i32) {
        let mut p = windows::Win32::Foundation::POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }

    pub fn move_to(x: i32, y: i32) {
        unsafe {
            let _ = SetCursorPos(x, y);
        }
    }

    fn button(flags: MOUSE_EVENT_FLAGS) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    pub fn press() {
        button(MOUSEEVENTF_LEFTDOWN);
    }
    pub fn release() {
        button(MOUSEEVENTF_LEFTUP);
    }
    /// The right button pans the wall too, and a pan must not leave a menu
    /// behind — which only a real button can demonstrate, since the whole
    /// question is what Chromium does between pointerup and contextmenu.
    pub fn press_right() {
        button(MOUSEEVENTF_RIGHTDOWN);
    }
    pub fn release_right() {
        button(MOUSEEVENTF_RIGHTUP);
    }
    /// The wall's third pan gesture. Here for the reason the right button is:
    /// panning is how this wall is read, so a run that cannot make the gesture
    /// cannot claim the wall is still readable. And this one is the harder of
    /// the two to be sure of by hand, because Windows also wants the middle
    /// button for autoscroll.
    pub fn press_middle() {
        button(MOUSEEVENTF_MIDDLEDOWN);
    }
    pub fn release_middle() {
        button(MOUSEEVENTF_MIDDLEUP);
    }
}

/// Move the real cursor to a point in the webview and press the real button.
#[tauri::command]
pub fn control_real_click(app: AppHandle, x: f64, y: f64, restore: Option<bool>) -> Result<(), String> {
    check_armed()?;
    #[cfg(windows)]
    {
        let (sx, sy) = to_screen(&app, x, y)?;
        let was = win::cursor();
        /* Input goes wherever the cursor is, so the window has to be up front —
           otherwise the first click only raises it and the second one is the
           one the test thinks it made. */
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
        std::thread::sleep(Duration::from_millis(60));
        win::move_to(sx, sy);
        /* A hover before the press: some controls only exist once the card is
           hovered, and Chromium needs a frame to run that transition. */
        std::thread::sleep(Duration::from_millis(90));
        win::press();
        std::thread::sleep(Duration::from_millis(40));
        win::release();
        std::thread::sleep(Duration::from_millis(60));
        if restore.unwrap_or(false) {
            win::move_to(was.0, was.1);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y, restore);
        Err("real input is implemented for Windows only".into())
    }
}

/// Press at a point, travel, release — a real drag, with real intermediate
/// moves so slop thresholds see what a hand would give them.
#[tauri::command]
pub fn control_real_drag(
    app: AppHandle,
    x: f64,
    y: f64,
    dx: f64,
    dy: f64,
    steps: Option<u32>,
    button: Option<String>,
) -> Result<(), String> {
    check_armed()?;
    /* Three buttons, because the wall means three different things by them: the
       left draws a selection band, and the right and the middle both pan. */
    let which = button.as_deref().unwrap_or("left");
    #[cfg(windows)]
    {
        let (sx, sy) = to_screen(&app, x, y)?;
        let (ex, ey) = to_screen(&app, x + dx, y + dy)?;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
        std::thread::sleep(Duration::from_millis(60));
        win::move_to(sx, sy);
        std::thread::sleep(Duration::from_millis(80));
        match which {
            "right" => win::press_right(),
            "middle" => win::press_middle(),
            _ => win::press(),
        }
        std::thread::sleep(Duration::from_millis(40));

        let n = steps.unwrap_or(12).max(1);
        for i in 1..=n {
            let t = i as f64 / n as f64;
            win::move_to(
                sx + ((ex - sx) as f64 * t).round() as i32,
                sy + ((ey - sy) as f64 * t).round() as i32,
            );
            std::thread::sleep(Duration::from_millis(16));
        }
        std::thread::sleep(Duration::from_millis(60));
        match which {
            "right" => win::release_right(),
            "middle" => win::release_middle(),
            _ => win::release(),
        }
        std::thread::sleep(Duration::from_millis(80));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y, dx, dy, steps, which);
        Err("real input is implemented for Windows only".into())
    }
}

/* ── the endpoint ─────────────────────────────────────────────────────── */

/// `SKEIN_CONTROL=1` for an ephemeral port, `SKEIN_CONTROL=8787` to pin one.
/// Anything falsey, or unset, and none of this exists.
pub(crate) fn requested_port(raw: Option<&str>) -> Option<u16> {
    let v = raw?.trim().to_ascii_lowercase();
    match v.as_str() {
        "" | "0" | "off" | "false" | "no" => None,
        "1" | "on" | "true" | "yes" => Some(0),
        other => Some(other.parse::<u16>().unwrap_or(0)),
    }
}

/// What a request means, decided without touching the network.
#[derive(Debug, PartialEq)]
pub(crate) enum Route {
    /// Liveness, and where to find everything else. No token required — it
    /// reveals nothing you don't already have by knowing the port.
    Health,
    /// Run an op in the studio.
    Op,
    /// A token was missing or wrong.
    Denied,
    NotFound,
}

pub(crate) fn route(method: &str, url: &str, token_ok: bool) -> Route {
    let path = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    match (method, path) {
        ("GET", "/health") | ("GET", "") => Route::Health,
        ("POST", "/op") => {
            if token_ok {
                Route::Op
            } else {
                Route::Denied
            }
        }
        _ => Route::NotFound,
    }
}

fn reply(req: tiny_http::Request, code: u16, body: Value) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let _ = req.respond(
        tiny_http::Response::from_string(body.to_string())
            .with_status_code(code)
            .with_header(header),
    );
}

/// Run one op: park a channel, emit it to the studio, wait for the answer.
fn run_op(app: &AppHandle, control: &Control, op: Value) -> (u16, Value) {
    if !control.attached.load(Ordering::SeqCst) {
        return (
            503,
            json!({ "ok": false, "error": "the studio has not attached to the control surface yet" }),
        );
    }

    let rid = crate::store::uuid_v4();
    let (tx, rx) = mpsc::channel::<Value>();
    control.pending.lock().unwrap().insert(rid.clone(), tx);

    let _ = app.emit("control:op", json!({ "rid": rid, "op": op }));

    match rx.recv_timeout(OP_TIMEOUT) {
        Ok(v) => (200, v),
        Err(RecvTimeoutError::Timeout) => {
            control.pending.lock().unwrap().remove(&rid);
            (
                504,
                json!({ "ok": false, "error": "the studio did not answer in 45s" }),
            )
        }
        Err(RecvTimeoutError::Disconnected) => (
            500,
            json!({ "ok": false, "error": "the studio dropped the op" }),
        ),
    }
}

/// Bind, publish the token, and serve until the process exits. Returns the
/// endpoint so the caller can put it in state, or `None` if control is off.
pub fn start(app: AppHandle, dir: &Path) -> Result<Option<Endpoint>, String> {
    let Some(want) = requested_port(std::env::var("SKEIN_CONTROL").ok().as_deref()) else {
        return Ok(None);
    };

    let server = tiny_http::Server::http(("127.0.0.1", want))
        .map_err(|e| format!("bind control surface: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("control surface has no ip address")?
        .port();
    let token = crate::store::uuid_v4();

    /* Published rather than printed: a harness should be able to find the
       endpoint from a cold start without anyone copying a number across. */
    let _ = std::fs::create_dir_all(dir);
    let file = dir.join("control.json");
    std::fs::write(
        &file,
        serde_json::to_string_pretty(&json!({
            "port": port,
            "token": token,
            "pid": std::process::id(),
        }))
        .unwrap_or_default(),
    )
    .map_err(|e| format!("publish control token: {e}"))?;
    *app.state::<Control>().file.lock().unwrap() = Some(file);

    let endpoint = Endpoint {
        port,
        token: token.clone(),
    };
    let serving = endpoint.clone();

    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let app = app.clone();
            let token = serving.token.clone();
            /* One thread per request: an op that waits on a spawn must not stall
               a snapshot taken to find out why it is waiting. */
            std::thread::spawn(move || {
                let token_ok = req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv(TOKEN_HEADER) && h.value.as_str() == token);
                let method = req.method().as_str().to_string();
                let url = req.url().to_string();

                match route(&method, &url, token_ok) {
                    Route::Health => {
                        let control = app.state::<Control>();
                        reply(
                            req,
                            200,
                            json!({
                                "ok": true,
                                "name": "skein",
                                "version": env!("CARGO_PKG_VERSION"),
                                "attached": control.attached.load(Ordering::SeqCst),
                                /* More than one attachment means the front end
                                   has been hot-reloaded and a superseded studio
                                   may still be in memory. Compare `generation`
                                   against the `gen` on any op reply. */
                                "attachments": control.attachments.load(Ordering::SeqCst),
                                "generation": control.generation.load(Ordering::SeqCst),
                                "inputArmed": input_armed(
                                    std::env::var("SKEIN_CONTROL_INPUT").ok().as_deref()
                                ),
                                /* The ask endpoint, so the real MCP path can be
                                   exercised end to end from outside. */
                                "mcpPort": app.state::<crate::ask::Asks>().port(),
                                "pid": std::process::id(),
                            }),
                        );
                    }
                    Route::Denied => reply(
                        req,
                        401,
                        json!({ "ok": false, "error": format!("missing or wrong {TOKEN_HEADER}") }),
                    ),
                    Route::NotFound => reply(
                        req,
                        404,
                        json!({ "ok": false, "error": "try GET /health or POST /op" }),
                    ),
                    Route::Op => {
                        let mut body = String::new();
                        if std::io::Read::read_to_string(req.as_reader(), &mut body).is_err() {
                            reply(req, 400, json!({ "ok": false, "error": "unreadable body" }));
                            return;
                        }
                        let Ok(op) = serde_json::from_str::<Value>(&body) else {
                            reply(req, 400, json!({ "ok": false, "error": "body is not json" }));
                            return;
                        };
                        let control = app.state::<Control>();
                        let (code, value) = run_op(&app, &control, op);
                        reply(req, code, value);
                    }
                }
            });
        }
    });

    Ok(Some(endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_is_off_unless_asked_for() {
        assert_eq!(requested_port(None), None);
        assert_eq!(requested_port(Some("")), None);
        assert_eq!(requested_port(Some("0")), None);
        assert_eq!(requested_port(Some("off")), None);
        assert_eq!(requested_port(Some("FALSE")), None);
    }

    #[test]
    fn truthy_means_pick_a_port_for_me() {
        // 1 must not be read as "bind port 1" — it is the obvious way to say on.
        assert_eq!(requested_port(Some("1")), Some(0));
        assert_eq!(requested_port(Some("on")), Some(0));
        assert_eq!(requested_port(Some("yes")), Some(0));
    }

    #[test]
    fn a_number_pins_that_port() {
        assert_eq!(requested_port(Some("8787")), Some(8787));
        assert_eq!(requested_port(Some(" 45871 ")), Some(45871));
    }

    #[test]
    fn nonsense_falls_back_to_an_ephemeral_port_rather_than_failing_to_start() {
        assert_eq!(requested_port(Some("banana")), Some(0));
        // Out of range for a port, so not a number we can honour.
        assert_eq!(requested_port(Some("99999")), Some(0));
    }

    #[test]
    fn the_control_surface_does_not_arm_the_mouse_by_itself() {
        // The whole point of the second variable: SKEIN_CONTROL=1 is not enough.
        assert!(!input_armed(None));
        assert!(!input_armed(Some("")));
        assert!(!input_armed(Some("0")));
        assert!(!input_armed(Some("off")));
        // Nor is a port number, which is a truthy-looking value that is not consent.
        assert!(!input_armed(Some("8787")));
    }

    #[test]
    fn input_arms_only_on_an_explicit_yes() {
        assert!(input_armed(Some("1")));
        assert!(input_armed(Some("on")));
        assert!(input_armed(Some("TRUE")));
        assert!(input_armed(Some(" yes ")));
    }

    #[test]
    fn health_needs_no_token() {
        assert_eq!(route("GET", "/health", false), Route::Health);
        assert_eq!(route("GET", "/", false), Route::Health);
    }

    #[test]
    fn an_op_without_the_token_is_denied_not_run() {
        assert_eq!(route("POST", "/op", false), Route::Denied);
        assert_eq!(route("POST", "/op", true), Route::Op);
    }

    #[test]
    fn ops_are_post_only_so_a_bare_link_cannot_drive_the_app() {
        assert_eq!(route("GET", "/op", true), Route::NotFound);
    }

    #[test]
    fn a_query_string_does_not_hide_the_route() {
        assert_eq!(route("POST", "/op?trace=1", true), Route::Op);
    }

    #[test]
    fn anything_else_is_a_404_with_a_hint() {
        assert_eq!(route("POST", "/eval", true), Route::NotFound);
        assert_eq!(route("DELETE", "/op", true), Route::NotFound);
    }
}
