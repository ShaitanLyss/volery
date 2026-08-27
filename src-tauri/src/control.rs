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
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
        MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
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

    /// One detent of a real wheel is 120, and the sign is Win32's rather than the
    /// DOM's: **positive `data` here means the wheel rotated away from you**,
    /// which scrolls *up*. `control_real_wheel` does the flip, once, so the op's
    /// vocabulary can keep `WheelEvent.deltaY`'s sense and only this line has to
    /// know that the two disagree.
    pub fn wheel(data: i32, horizontal: bool) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    /* A signed delta in an unsigned field: `mouseData` is a
                       DWORD that Win32 reads back as a short, so a downward
                       wheel travels as two's complement rather than as a
                       negative number. windows-rs types it `u32` and does no
                       conversion for you. */
                    mouseData: data as u32,
                    dwFlags: if horizontal {
                        MOUSEEVENTF_HWHEEL
                    } else {
                        MOUSEEVENTF_WHEEL
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    fn key(vk: u16, flags: KEYBD_EVENT_FLAGS) {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    /* Left at zero deliberately. Chromium reads the scan code for
                       `KeyboardEvent.code` but takes `key` off the virtual key, and
                       every binding on this wall is on `key`. A scan code invented
                       here would be one more thing that could be subtly wrong
                       without any test noticing. */
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    pub fn key_down(vk: u16) {
        key(vk, KEYBD_EVENT_FLAGS(0));
    }
    pub fn key_up(vk: u16) {
        key(vk, KEYEVENTF_KEYUP);
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

/// A key name in `KeyboardEvent.key`'s spelling → the virtual key that produces
/// it.
///
/// A **closed** vocabulary, and that is the whole design of this function. The
/// obvious alternative — derive a virtual key from the character and fall back to
/// something for the rest — produces a harness that presses *nearly* the right
/// key and a test that fails for a reason nowhere near the assertion. Refusing
/// what it does not know costs one error message and buys the guarantee that a
/// green run pressed what it said it pressed.
///
/// The names are the DOM's rather than Win32's, because `KeyboardEvent.key` is
/// the vocabulary every binding in this app is written in (`onGlobalKey`,
/// `onDraftKey`, the viewer's `onKey`) and the one the synthetic `key` op already
/// speaks. One spelling for a keystroke, whichever rung presses it.
pub(crate) fn vk(name: &str) -> Option<u16> {
    /* The scrollers' keys first — they are why this exists. A synthetic keydown
       does not make Chromium scroll the focused element, so "End goes to the
       bottom of the file" was a claim in a comment with nothing able to check
       it. See the note on `.sheet`'s tabindex in `Spyglass.svelte`. */
    let named = match name {
        "End" => 0x23,
        "Home" => 0x24,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "Escape" => 0x1B,
        "Enter" => 0x0D,
        "Tab" => 0x09,
        "Backspace" => 0x08,
        "Delete" => 0x2E,
        "Insert" => 0x2D,
        " " | "Space" => 0x20,
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    /* A single printable character, which is how a letter binding is spelled on
       this wall — "e to edit", Ctrl+F, the leader. Upper-cased because the
       virtual key for a letter *is* its ASCII capital, and the caller may have
       written either; which case actually arrives at the page is then Shift's
       business rather than this table's. */
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        let up = c.to_ascii_uppercase();
        if up.is_ascii_uppercase() || up.is_ascii_digit() {
            return Some(up as u16);
        }
    }
    /* F1–F12 are contiguous from 0x70. */
    if let Some(n) = name.strip_prefix('F').and_then(|d| d.parse::<u16>().ok()) {
        if (1..=12).contains(&n) {
            return Some(0x6F + n);
        }
    }
    None
}

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_ALT: u16 = 0x12;

/// A real wheel at a point in the webview.
///
/// The rung above `scroll`. `scroll` writes a scroller's `scrollTop` and proves
/// what the app *remembers* about a position; this proves that a wheel over a
/// point lands on the scroller you think it does and that the browser then
/// scrolls it — which is the half a written `scrollTop` assumes and cannot see.
/// Nested scrollers, a non-passive listener that preventDefaults, and
/// `overscroll-behavior` are all invisible to the other rung.
///
/// `notches` is in detents and carries **`deltaY`'s sign — positive scrolls
/// down** — so one sense holds across the synthetic `wheel` op and this one. The
/// flip to Win32's opposite convention happens here and nowhere else.
#[tauri::command]
pub fn control_real_wheel(
    app: AppHandle,
    x: f64,
    y: f64,
    notches: f64,
    horizontal: Option<bool>,
) -> Result<(), String> {
    check_armed()?;
    #[cfg(windows)]
    {
        let sideways = horizontal.unwrap_or(false);
        let (sx, sy) = to_screen(&app, x, y)?;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
        std::thread::sleep(Duration::from_millis(60));
        win::move_to(sx, sy);
        /* The cursor has to have arrived before the wheel is sent: a wheel goes
           to whatever is under the pointer at the moment it is delivered, not to
           whatever the last SetCursorPos asked for. */
        std::thread::sleep(Duration::from_millis(90));
        let steps = (notches.abs().ceil() as i32).max(1);
        let per = (notches * 120.0 / steps as f64).round() as i32;
        for _ in 0..steps {
            /* Horizontal is the one axis where Win32 and the DOM agree: positive
               is rightward in both. Vertical is inverted. */
            win::wheel(if sideways { per } else { -per }, sideways);
            /* One detent per frame, so a smooth-scroll animation and a
               deltaY-accumulating pan see a gesture rather than a jump. */
            std::thread::sleep(Duration::from_millis(24));
        }
        std::thread::sleep(Duration::from_millis(120));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y, notches, horizontal);
        Err("real input is implemented for Windows only".into())
    }
}

/// A real key, with real modifiers.
///
/// The rung above the synthetic `key` op, and it exists for the same reason
/// `real.click` does: a dispatched `KeyboardEvent` proves a handler is connected
/// and nothing else. It cannot make the browser *act* — the focused scroller does
/// not move for End, a field does not receive a character, and `preventDefault`
/// on it prevents nothing, because there was no default there to prevent. So the
/// app's own claim that a key does something outside its own handlers had no way
/// to be checked from here.
///
/// Modifiers are pressed around the key and released in reverse, which is the
/// order a hand makes and the order Windows' own modifier state expects.
#[tauri::command]
pub fn control_real_key(
    app: AppHandle,
    key: String,
    ctrl: Option<bool>,
    shift: Option<bool>,
    alt: Option<bool>,
    times: Option<u32>,
) -> Result<(), String> {
    check_armed()?;
    let code = vk(&key).ok_or_else(|| {
        format!(
            "{key:?} is not a key this surface knows how to press. Names are \
             KeyboardEvent.key's: End, Home, PageUp, PageDown, the four Arrows, \
             Escape, Enter, Tab, Backspace, Delete, Insert, Space, a single \
             character, or F1-F12."
        )
    })?;
    #[cfg(windows)]
    {
        let mods: Vec<u16> = [
            (ctrl.unwrap_or(false), VK_CONTROL),
            (shift.unwrap_or(false), VK_SHIFT),
            (alt.unwrap_or(false), VK_ALT),
        ]
        .into_iter()
        .filter_map(|(on, code)| on.then_some(code))
        .collect();

        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
        /* Longer than the mouse's 60ms, because a keystroke sent before the
           foreground has actually changed is typed into whatever window was
           there — and unlike a stray click, that lands in somebody's editor. */
        std::thread::sleep(Duration::from_millis(120));

        for m in &mods {
            win::key_down(*m);
            std::thread::sleep(Duration::from_millis(16));
        }
        for _ in 0..times.unwrap_or(1).clamp(1, 64) {
            win::key_down(code);
            std::thread::sleep(Duration::from_millis(24));
            win::key_up(code);
            std::thread::sleep(Duration::from_millis(24));
        }
        for m in mods.iter().rev() {
            win::key_up(*m);
            std::thread::sleep(Duration::from_millis(16));
        }
        std::thread::sleep(Duration::from_millis(90));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, code, ctrl, shift, alt, times);
        Err("real input is implemented for Windows only".into())
    }
}

/* ── the endpoint ─────────────────────────────────────────────────────── */

/// Is the control surface asked for at all?
///
/// Read straight off the environment rather than out of `Control`, because
/// `window::settle` runs *before* `start` binds anything — see the order in
/// `lib.rs`'s setup. Shares `requested_port`'s vocabulary so one variable goes
/// on meaning one thing, including the pinned-port spelling.
pub fn asked_for() -> bool {
    requested_port(std::env::var("SKEIN_CONTROL").ok().as_deref()).is_some()
}

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

    /* `vk` is the one part of real keyboard input that is a decision rather than
       a call into Win32, and a wrong entry here is the worst kind of harness
       bug: the run is green, the key that was pressed is not the key the test
       names, and the failure lands nowhere near either. */

    #[test]
    fn the_scrollers_keys_are_the_ones_this_exists_for() {
        // Why real keyboard input was added at all — a synthetic keydown cannot
        // move the focused scroller, so these four had no way to be checked.
        assert_eq!(vk("End"), Some(0x23));
        assert_eq!(vk("Home"), Some(0x24));
        assert_eq!(vk("PageDown"), Some(0x22));
        assert_eq!(vk("PageUp"), Some(0x21));
    }

    #[test]
    fn the_arrows_are_in_win32s_order_not_the_dom_reading_order() {
        // Left, Up, Right, Down — contiguous, and famously not the order anyone
        // guesses. Transcribing these by eye is exactly how a harness ends up
        // pressing Up for Down.
        assert_eq!(vk("ArrowLeft"), Some(0x25));
        assert_eq!(vk("ArrowUp"), Some(0x26));
        assert_eq!(vk("ArrowRight"), Some(0x27));
        assert_eq!(vk("ArrowDown"), Some(0x28));
    }

    #[test]
    fn names_are_keyboardevent_keys_spelling() {
        // One spelling for a keystroke across both rungs: whatever the synthetic
        // `key` op takes, `real.key` takes. Win32's own names ("VK_NEXT",
        // "Prior") are deliberately not accepted, so there is no second
        // vocabulary to keep in step.
        assert_eq!(vk("Escape"), Some(0x1B));
        assert_eq!(vk("Enter"), Some(0x0D));
        assert_eq!(vk("Tab"), Some(0x09));
        assert_eq!(vk("VK_NEXT"), None);
        assert_eq!(vk("Prior"), None);
        assert_eq!(vk("Down"), None);
    }

    #[test]
    fn a_letter_is_its_own_capital_in_either_case() {
        // The bare-letter bindings — "e to edit" in the viewer, Ctrl+F to swap
        // modes — are written lowercase in the app, and the virtual key is the
        // capital. Both spellings have to reach the same key.
        assert_eq!(vk("e"), Some('E' as u16));
        assert_eq!(vk("E"), Some('E' as u16));
        assert_eq!(vk("f"), vk("F"));
        assert_eq!(vk("7"), Some('7' as u16));
    }

    #[test]
    fn space_answers_to_both_of_its_names() {
        // The finder's leader is a space, and `KeyboardEvent.key` spells it as
        // the character while every human writes "Space".
        assert_eq!(vk(" "), Some(0x20));
        assert_eq!(vk("Space"), Some(0x20));
    }

    #[test]
    fn function_keys_are_bounded_at_both_ends() {
        assert_eq!(vk("F1"), Some(0x70));
        assert_eq!(vk("F12"), Some(0x7B));
        // Off the end rather than 0x7C, which is a real key (F13) and would be a
        // silently plausible answer.
        assert_eq!(vk("F13"), None);
        assert_eq!(vk("F0"), None);
    }

    #[test]
    fn an_unknown_key_is_refused_rather_than_guessed_at() {
        // The whole argument for a closed table. None of these may resolve to
        // "nearly right".
        assert_eq!(vk(""), None);
        assert_eq!(vk("Meta"), None);
        assert_eq!(vk("Control"), None);
        assert_eq!(vk("ArrowSideways"), None);
        assert_eq!(vk("PageDwn"), None);
        // Multi-character, so not a single printable either.
        assert_eq!(vk("ee"), None);
        // Non-ASCII: a real key on somebody's layout, but not one a virtual-key
        // code can be derived from without knowing the layout.
        assert_eq!(vk("é"), None);
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
