//! The browser the wall owns, so an agent and a person can drive one page.
//!
//! Volery does not draw a browser and does not host one in a webview. It runs a
//! real Chrome as a child, with a CDP port open on loopback, and hands the
//! endpoint to whoever wants it: `@playwright/mcp --cdp-endpoint` for the agent,
//! and the browser widget for the person. Both attach to the *same* browser at
//! the same time, which is the entire point — you click in the widget and it
//! lands in the page the agent is driving, same session, same cookies.
//!
//! ### Why not a webview, which is the obvious thing to try
//!
//! Measured 2026-09-03 on this machine, real Chrome channel against a real dev
//! bundle (`about:blank` reads ~100× cheaper and is worthless as a figure):
//!
//! ```text
//! browser + 1 page                    550.7 MB   ( 9 procs)
//! browser + 4 pages                  1190.9 MB   (12 procs)  -> 128 MB per page
//! + a whole second browser + 1 page  1802.5 MB   (21 procs)  -> 611.6 MB
//! after close()                          0.0 MB   ( 0 procs)
//! ```
//!
//! So a browser costs ~450 MB fixed and a page costs ~128 MB. A WebView2-hosted
//! page would also cost a ~128 MB renderer, so hosting the page *inside* Volery
//! saves nothing a shared browser does not already save — while giving up the
//! pinned browser build, cross-browser, real `newContext()`, and putting an
//! unauthenticated CDP port on the environment that draws the wall itself.
//! Sharing one browser saves ~484 MB per additional card; hosting it in-app
//! saves ~0. That is why this file spawns Chrome instead of opening a webview.
//!
//! The other half of the measurement is that there was never a leak to fix:
//! `close()` returned to 0 processes and 0 MB, and `.claude/rules/processes.md`
//! had already established nothing was orphaned. This file exists for the
//! *feature*, not to reclaim memory.
//!
//! ### The two flags that are load-bearing
//!
//! - **`--remote-allow-origins`.** Chrome 111 began rejecting CDP WebSocket
//!   upgrades that carry an `Origin` header, which every connection from a
//!   webview does. Without this the widget's socket is closed during the
//!   handshake and the failure names nothing about origins — it looks like the
//!   port is shut. The `/json/*` HTTP endpoints answer fine either way, so it
//!   fails *after* everything appears to be working.
//! - **`--user-data-dir`.** Two clients cannot share one Chrome profile
//!   directory. Probed 2026-09-03: a second `launchPersistentContext` on a
//!   directory another already holds fails with `Target page, context or
//!   browser has been closed`, which says nothing about profiles. The installed
//!   `@playwright/mcp` config passes no `--user-data-dir` at all, so every card
//!   resolves to one default profile and the second card to want a browser
//!   cannot have one. Volery's browser therefore keeps its own directory under
//!   the app data folder, which also means a login survives between turns.
//!
//! ### What is deliberately not here
//!
//! No folding. Rust starts the process, waits for the port to answer, and lists
//! targets; the screencast, the input and the console are the front end's, over
//! a WebSocket it opens itself. That is the division the event pipeline already
//! makes for `claude` — `CLAUDE.md`'s "Rust folds nothing" — and it is why
//! there is no frame buffer in this file. A frame that crossed the Tauri IPC
//! would be base64 in a JSON envelope on the main thread, at up to 95 kB a
//! frame, which is precisely the shape `off_main` exists to keep off it.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::servers::jobs;

/// Where the CDP port is bound. Loopback only, never `0.0.0.0` — the port is
/// unauthenticated by design (CDP has no notion of a credential) so the only
/// boundary available is which interface it answers on.
const HOST: &str = "127.0.0.1";

/// The conventional CDP port, and the number a person will type into a
/// `--cdp-endpoint` by hand without being told twice.
///
/// Fixed rather than ephemeral on purpose. An MCP server's arguments are
/// settled when the card spawns and cannot be renegotiated afterwards, so an
/// endpoint whose port moves between runs is one that cannot appear in a static
/// config — which is the only kind of config the plugin that supplies
/// `@playwright/mcp` has. A stable number is what makes the agent half of this
/// work at all.
pub const DEFAULT_PORT: u16 = 9222;

/// How long to wait for a freshly spawned Chrome to answer `/json/version`.
///
/// Cold start on this machine was comfortably under two seconds; ten is chosen
/// to survive a first run that has to create the profile directory, and an
/// on-access scanner reading the whole of Chrome off disk.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/* ── where the browser stands ──────────────────────────────────────────── */

/// Whether the shared browser is a window on your desktop, and if not, how it
/// is kept off it.
///
/// The ask was "it literally opens a Chrome window — can I see it in Volery and
/// not outside it", and there are two honest answers rather than one. All three
/// were measured against Chrome 152.0.7977.83 before any of it was built
/// (`tools/probe-browser.ts hidden`), and the measurement is worth reading
/// rather than summarising, because **it overturned the design twice**.
///
/// What decides between the two windowed answers is not frames. That was the
/// assumption — a window nobody can see being one Chrome stops painting — and
/// held over 30 seconds it is simply false: a plain hidden window paints 597
/// frames, a parked one 601, a normal one 599. What decides it is that **Chrome
/// puts a hidden window back**, on something as ordinary as opening a tab. See
/// `park_windows`, and `.claude/rules/browser.md` for the table and for the two
/// ways the first probe managed to agree with the wrong answer.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// A normal Chrome window, on the desktop and in the taskbar. What this
    /// app did for its whole life before the knob existed, and still what you
    /// want while signing into something awkward.
    Window,
    /// A real, headed Chrome parked off-screen at (-32000, -32000) with
    /// `WS_EX_TOOLWINDOW` set, so it is on no desktop and in no taskbar — but
    /// is in every other respect the browser you would have had.
    ///
    /// **Parked rather than hidden, and that distinction was measured.**
    /// `ShowWindow(SW_HIDE)` is the obvious implementation and it loses to
    /// Chrome: opening a *tab* re-shows the window (probed — the same `HWND`
    /// flips visible again), so every page the agent opened would flash onto
    /// the desktop and need chasing back down. Chrome calls `ShowWindow` and
    /// never repositions, so a parked window survives a new tab untouched. Only
    /// a genuinely new *window* — an OAuth popup — lands somewhere visible, and
    /// that is what `browser_park` is for.
    ///
    /// The default, because it is what the feature was asked for: the widget is
    /// the way you look at this browser, and it can be brought back to the
    /// desktop with one press when it needs to be.
    #[default]
    Parked,
    /// No window exists at all — `--headless=new`. Nothing can leak onto the
    /// desktop because there is nothing to leak, and there is correspondingly
    /// no way to take the real window back for a sign-in that needs it.
    Headless,
}

impl Mode {
    /// The wire and database spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Window => "window",
            Mode::Parked => "parked",
            Mode::Headless => "headless",
        }
    }

    /// A mode read back off disk, clamped.
    ///
    /// Anything unrecognised is the default rather than an error, which is the
    /// bargain `migrate_v33` describes: a mode written by a newer build costs
    /// no migration here and cannot reach a launch argument.
    pub fn from_stored(s: &str) -> Mode {
        match s {
            "window" => Mode::Window,
            "headless" => Mode::Headless,
            _ => Mode::Parked,
        }
    }
}

/* ── state ─────────────────────────────────────────────────────────────── */

struct Running {
    child: Child,
    /// Dropped with this struct, which kills Chrome and everything under it.
    ///
    /// `child.kill()` is `TerminateProcess` and reaches exactly one process,
    /// and Chrome is a dozen — a browser process, a GPU process, a network
    /// service and a renderer per page. Killing the one we hold leaves the rest
    /// unparented and invisible, which is the mistake `CLAUDE.md` records as
    /// "every spawn goes in a job object, and the one that did not was the
    /// biggest".
    _job: Option<jobs::Job>,
    port: u16,
    version: String,
    browser_ws: String,
    /// How this browser was *launched*, which never changes for its lifetime.
    ///
    /// It has to be immutable, because it is not a preference — it is which
    /// flags are on the command line, and `--headless` and the three occlusion
    /// flags cannot be added to a running Chrome. Where the window happens to
    /// be right now is `on_desktop`, and conflating the two left a browser you
    /// had shown with no way to park it again.
    mode: Mode,
    /// Whether the window is somewhere you can see it.
    ///
    /// Starts false for a parked browser and true for a windowed one, and is
    /// the only thing `browser_show` and `browser_park` move. Meaningless for
    /// headless, where it stays false and there is nothing to show.
    on_desktop: bool,
    /// Something that went wrong which is not worth refusing the browser over
    /// — parking failing is the case: a Chrome you can see is worse than the
    /// one you asked for and far better than none. Drawn on the widget's face
    /// rather than swallowed, because a browser silently sitting on the desktop
    /// after you asked for it not to reads as the knob doing nothing.
    warning: Option<String>,
}

#[derive(Default)]
pub struct Browser {
    inner: Mutex<Option<Running>>,
    /// The mode a start uses when none is named, and the one the widget draws
    /// while nothing is running. Loaded from the database at `setup` and
    /// written back whenever it changes, so the wall comes back as you left it.
    mode: Mutex<Mode>,
    /// Whether the launch auto-start is still in flight.
    ///
    /// The wall paints before the browser is up, and a card spawned in that gap
    /// gets no `mcp__browser__*` — an MCP server's arguments are settled at
    /// spawn and cannot be renegotiated. So the gap has to be *visible* rather
    /// than merely short: the rouse queue waits on this, and the widget can say
    /// "starting" instead of "not running" for the second or two it takes.
    starting: Mutex<bool>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub port: u16,
    /// What goes in `--cdp-endpoint`, ready to paste.
    pub endpoint: String,
    /// Chrome's own version string, so the widget can say which browser this
    /// is rather than asserting one.
    pub version: String,
    /// How many processes the job holds. The honest answer to "what is this
    /// costing me", and it is asked of the kernel rather than guessed by
    /// walking parent pointers — see `jobs::Job::pids`.
    pub procs: usize,
    /// The browser-level CDP socket, for the front end to hear
    /// `Target.targetCreated` on. Empty when nothing is running.
    pub browser_ws: String,
    /// How it stands on the desktop. Reported whether or not anything is
    /// running: with nothing up this is the mode a start *would* use, which is
    /// what the widget's knob has to draw.
    pub mode: Mode,
    /// Whether its window is somewhere you can see it right now. Distinct from
    /// `mode`, which is how it was launched and cannot change.
    pub on_desktop: bool,
    /// Whether the launch auto-start is still in flight, so the widget says
    /// "starting" rather than "not running" and nothing offers you a button
    /// that would start a second one.
    pub starting: bool,
    /// What went not-quite-right, or empty. Empty rather than `null` to match
    /// `version` and `endpoint`, which are the same kind of field.
    pub warning: String,
}

/// One page (or worker) the browser has open.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub url: String,
    /// The socket the widget attaches to. Empty when Chrome did not offer one,
    /// which happens for targets already being debugged elsewhere.
    pub ws: String,
}

/* ── finding Chrome ────────────────────────────────────────────────────── */

/// Where Chrome is, or nothing.
///
/// Deliberately not `where.exe chrome` first: on a machine with several
/// Chromium-family browsers the one on `PATH` is whichever installer wrote
/// there last, and the widget attaching to a *different* browser than the one
/// the person recognises is a confusing failure. The three real install
/// locations are checked in the order Google itself uses — per-machine, then
/// 32-bit per-machine, then per-user — and `PATH` is the last resort rather
/// than the first.
fn find_chrome() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            roots.push(PathBuf::from(base).join("Google/Chrome/Application/chrome.exe"));
        }
    }
    /* Edge is a Chromium and speaks the same CDP, so it is a real fallback
       rather than a courtesy — a Windows machine has one whether or not
       anybody installed a browser. It is last because a person who has Chrome
       means Chrome. */
    for var in ["PROGRAMFILES(X86)", "PROGRAMFILES"] {
        if let Ok(base) = std::env::var(var) {
            roots.push(PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe"));
        }
    }
    roots.into_iter().find(|p| p.is_file())
}

/// The profile directory, under the app data folder for the same reason the
/// database is: it is the durable identity, and `dev.skein.studio` is not
/// renamed when the product is (see `CLAUDE.md`).
fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("browser-profile");
    std::fs::create_dir_all(&dir).map_err(|e| format!("make {}: {e}", dir.display()))?;
    Ok(dir)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/* ── keeping it off the desktop ────────────────────────────────────────── */

/// Where a parked window goes.
///
/// The number Windows itself uses for "off-screen": a minimized window's
/// restored position is reported as (-32000, -32000), so this is not a magic
/// large negative but the one the platform already means it by. Far enough
/// left of any real monitor arrangement that nothing shows, and not so far that
/// the coordinate wraps.
#[cfg(windows)]
const PARKED_AT: (i32, i32) = (-32_000, -32_000);

/// Move every top-level window this browser owns off the desktop, and take it
/// out of the taskbar.
///
/// Returns how many windows it moved. Idempotent, and it has to be: it is
/// called at start and again whenever a target appears, and a re-park of a
/// window already parked must cost nothing and move nothing.
///
/// Three calls, and each one is doing a different job:
///
/// - **`WS_EX_TOOLWINDOW`** takes the window out of the taskbar and out of
///   Alt+Tab. Without it you get a browser you cannot see but can still switch
///   to, which is a worse kind of confusing than a visible window.
/// - **`SetWindowPos`** does the actual parking, with `SWP_NOACTIVATE` so
///   moving it never takes the keyboard away from the wall.
/// - **`ShowWindow(SW_SHOWNA)`** is the one that is easy to get wrong. The
///   window must end up *visible* as far as Windows is concerned — which,
///   parked at (-32000, -32000), means visible and on no monitor. `SW_SHOWNA`
///   shows without activating, so the wall keeps the keyboard.
///
/// **A park rather than a `SW_HIDE`, and the measurement is unambiguous about
/// why.** Hiding is the obvious implementation and Chrome undoes it: opening a
/// *tab* puts a hidden window back on the desktop — the same `HWND` flips
/// visible again, reproduced on every run of `probe-browser.ts hidden` — so
/// every page the agent opened would flash onto your desktop and need chasing
/// back down. A parked window survives a new tab untouched, because Chrome
/// calls `ShowWindow` and never repositions. Frames are *not* the
/// discriminator between the two, which is worth saying because it was assumed
/// to be for most of a day: a plain hidden window paints fine (597 frames in
/// 30s). Only a new *window* — an OAuth popup — lands somewhere visible, and
/// that is what `browser_park` re-parks.
///
/// The ex-style change is bracketed by a hide and a show because that is the
/// documented way to make a taskbar-affecting `WS_EX_TOOLWINDOW` change take
/// effect on a window that is already up; setting it in place is ignored.
#[cfg(windows)]
pub fn park_windows(pid: u32) -> usize {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
        SetWindowLongW, SetWindowPos, ShowWindow, GWL_EXSTYLE, SWP_NOACTIVATE, SWP_NOSIZE,
        SWP_NOZORDER, SW_HIDE, SW_SHOWNA, WS_EX_TOOLWINDOW,
    };

    struct Hunt {
        pid: u32,
        found: Vec<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let hunt = &mut *(lparam.0 as *mut Hunt);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != hunt.pid {
                return TRUE;
            }
            /* The class is the guard, the same one `unreal_windows` uses.
               Chrome owns a handful of tiny helper windows per process — drag
               images, message-only sinks — and moving those achieves nothing
               while risking something. */
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class);
            if n <= 0
                || !String::from_utf16_lossy(&class[..n as usize]).starts_with("Chrome_WidgetWin")
            {
                return TRUE;
            }
            /* And a size guard under it: the helper windows are 0×0 or a few
               pixels, and a real browser window is not. Measured on this
               machine, a running Chrome answers with two sub-100px helpers per
               real window. */
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() || rect.right - rect.left <= 100 {
                return TRUE;
            }
            hunt.found.push(hwnd);
            TRUE
        }
    }

    let mut hunt = Hunt {
        pid,
        found: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut hunt as *mut _ as isize));
    }

    let mut moved = 0usize;
    for hwnd in hunt.found {
        unsafe {
            let mut rect = RECT::default();
            let already = GetWindowRect(hwnd, &mut rect).is_ok() && rect.left <= PARKED_AT.0;
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let tooled = style & WS_EX_TOOLWINDOW.0 as i32 != 0;
            if already && tooled {
                continue;
            }
            if !tooled {
                let _ = ShowWindow(hwnd, SW_HIDE);
                SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_TOOLWINDOW.0 as i32);
            }
            let _ = SetWindowPos(
                hwnd,
                None,
                PARKED_AT.0,
                PARKED_AT.1,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            /* Back to visible-as-far-as-Windows-is-concerned, without taking
               focus. This is the line that keeps the frames coming. */
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            moved += 1;
        }
    }
    moved
}

#[cfg(not(windows))]
pub fn park_windows(_pid: u32) -> usize {
    0
}

/* ── asking the port whether it is up ──────────────────────────────────── */

fn get(url: &str, timeout: std::time::Duration) -> Result<String, String> {
    ureq::AgentBuilder::new()
        .timeout(timeout)
        .build()
        .get(url)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Poll `/json/version` until Chrome answers, and return its version string.
///
/// A spawned Chrome is not a Chrome that can be talked to; the port is bound
/// some way into startup. Nothing announces it, so this is one of the few
/// places in the app that legitimately looks rather than folds — there is no
/// event to fold *from the thing being watched*, which is the test `CLAUDE.md`
/// sets for a poller. It is bounded by construction: it runs once per start and
/// stops at the first answer.
fn await_ready(port: u16) -> Result<Ready, String> {
    let url = format!("http://{HOST}:{port}/json/version");
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    let mut last = String::from("no answer");
    while std::time::Instant::now() < deadline {
        match get(&url, std::time::Duration::from_millis(500)) {
            Ok(body) => {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                return Ok(Ready {
                    version: v["Browser"].as_str().unwrap_or("chrome").to_string(),
                    user_agent: v["User-Agent"].as_str().unwrap_or_default().to_string(),
                    ws: v["webSocketDebuggerUrl"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                });
            }
            Err(e) => last = e,
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    Err(format!("the browser did not open its port in time ({last})"))
}

/// What `/json/version` said once the port answered.
struct Ready {
    version: String,
    user_agent: String,
    /// The **browser-level** CDP socket, which is not any page's.
    ///
    /// The front end needs it for exactly one thing and it is worth naming:
    /// `Target.targetCreated`, which is how a new window announces itself. A
    /// popup is the only case parking has to chase, and folding the event
    /// Chrome already emits is what keeps this off a poller — the bar
    /// `CLAUDE.md` sets for anything that wants to go and look.
    ws: String,
}

/// The user agent a *headed* Chrome of this exact build would have sent, given
/// what a headless one just sent — or nothing, if this one is not headless.
///
/// **Headless is visible on the wire and only there.** Measured against Chrome
/// 152: `--headless=new` sends `HeadlessChrome/152.0.0.0` in the `User-Agent`
/// header, while the `Sec-CH-UA` client-hint brands are byte-identical to a
/// headed browser's. That second half is what makes an override worth doing at
/// all — an override that fixed the string while leaving the hints saying
/// something else would be a *more* distinctive fingerprint than the honest
/// one, and there is nothing to contradict here.
///
/// Derived from what the browser reported rather than composed from a template,
/// and that is deliberate: the alternative is this file holding an opinion
/// about Chrome's user-agent format, which Google has changed twice in living
/// memory (UA reduction froze the minor version at `0.0.0`), and about Edge's,
/// which differs. Taking the string Chrome just gave us and deleting one word
/// is correct for every Chromium, now and later, and needs no probe to keep
/// true.
///
/// The cost is one extra launch, paid only in headless mode: the browser has to
/// be up to be asked. `browser_start` throws the first one away and relaunches
/// with the answer.
fn headed_user_agent(ua: &str) -> Option<String> {
    if !ua.contains("HeadlessChrome") {
        return None;
    }
    Some(ua.replace("HeadlessChrome", "Chrome"))
}

/* ── commands ──────────────────────────────────────────────────────────── */

fn status_of(guard: &Option<Running>, mode: Mode, starting: bool) -> Status {
    match guard {
        None => Status {
            port: DEFAULT_PORT,
            /* The mode a start *would* use, not a placeholder. The widget's
               knob has to draw something before there is a browser, and the
               honest something is the setting it will act on. */
            mode,
            starting,
            ..Default::default()
        },
        Some(r) => Status {
            running: true,
            port: r.port,
            endpoint: format!("http://{HOST}:{}", r.port),
            version: r.version.clone(),
            procs: r._job.as_ref().map(|j| j.pids().len()).unwrap_or(0),
            browser_ws: r.browser_ws.clone(),
            mode: r.mode,
            on_desktop: r.on_desktop,
            starting,
            warning: r.warning.clone().unwrap_or_default(),
        },
    }
}

/// Read the two mutexes the status needs beside the browser itself.
fn mode_and_starting(state: &Browser) -> (Mode, bool) {
    let mode = state.mode.lock().map(|m| *m).unwrap_or_default();
    let starting = state.starting.lock().map(|s| *s).unwrap_or(false);
    (mode, starting)
}

/// The endpoint, for code that cannot await a command.
///
/// Deliberately synchronous and deliberately not a `#[tauri::command]`: it
/// takes the mutex, reads two fields and returns. There is no I/O behind it, so
/// the rule that a blocking command must leave the main thread does not apply —
/// and `spawn_now` is not async, so a command is not reachable from there
/// anyway. Returns nothing when no browser is running, which is the honest
/// answer and is why the caller sets no variable rather than an empty one.
pub fn endpoint(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<Browser>()?;
    let guard = state.inner.lock().ok()?;
    let r = guard.as_ref()?;
    Some(format!("http://{HOST}:{}", r.port))
}

/// The MCP server that turns this browser into `mcp__browser__*` on a card.
///
/// **This is the half of the feature that was missing for a fortnight**, and the
/// shape of the gap is worth keeping. Everything else was built — the Chrome,
/// the port, the widget, the vault, the `VOLERY_CDP_ENDPOINT` beside it — and
/// `append_prompt` told every card on every turn that `mcp__browser__*` was
/// there, while the server those tools come from was expected to arrive from the
/// *user's own* MCP configuration, which this app does not write. On this
/// machine it never did: `claude mcp list` answered with eight claude.ai
/// connectors and one plugin, and nothing under that prefix has ever resolved on
/// this wall. Reported from a nova card as sink `b6bfecba`, whose real cost was
/// not the missing capability but the confident sentence about it — a card told
/// it has a tool it does not have cannot say what is wrong, so a wheel-scroll
/// bug got diagnosed by reasoning about the DOM instead of by looking, and the
/// first fix was wrong.
///
/// So the server is Volery's own now, and the prompt's claim is true by
/// construction rather than by a coincidence of global configuration. This is
/// the fix `.claude/rules/browser.md` named and did not build.
///
/// Probed 2026-09-10, claude 2.1.235 against the running wall browser: spawned
/// with exactly this entry in `--mcp-config`, `system/init` reports
/// `{"name":"browser","status":"connected"}` and 24 tools under
/// `mcp__browser__`. `npx` as the bare command is what connects — the CLI
/// resolves the `.cmd` shim itself, and it is what the official plugin uses.
///
/// **`@latest` rather than a pin**, matching the plugin, because the thing on
/// the other end is a Chrome this machine updates on its own schedule and a
/// pinned client that stops speaking to it fails in the CDP handshake naming
/// nothing. The cost is an npx registry check at spawn, which is already paid
/// once per card by the plugin's own server.
pub fn mcp_server(endpoint: &str) -> serde_json::Value {
    serde_json::json!({
        "command": "npx",
        "args": ["@playwright/mcp@latest", "--cdp-endpoint", endpoint],
    })
}

#[tauri::command]
pub async fn browser_status(state: State<'_, Browser>) -> Result<Status, String> {
    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    /* A browser that died on its own — crashed, or closed by the person via its
       own window — must not still be reported as running, or the widget waits
       forever on a socket nothing is listening to. */
    if let Some(r) = guard.as_mut() {
        if matches!(r.child.try_wait(), Ok(Some(_))) {
            *guard = None;
        }
    }
    let (mode, starting) = mode_and_starting(&state);
    Ok(status_of(&guard, mode, starting))
}

/// Start the shared browser, or return the one already running.
///
/// `async`, and that is not decoration: this spawns a process and then blocks
/// on a loopback poll for up to ten seconds. A non-`async`
/// `#[tauri::command]` compiles to the `body_blocking` arm and runs *inline on
/// the thread that dispatched the IPC* — the main thread, which is also the only
/// thread that drains the event-loop queue. Ten seconds there is not one slow
/// command, it is every card on the wall going unpainted for ten seconds and
/// then landing at once. See `CLAUDE.md`.
#[tauri::command]
pub async fn browser_start(
    app: AppHandle,
    state: State<'_, Browser>,
    port: Option<u16>,
) -> Result<Status, String> {
    {
        let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
        if guard.is_some() {
            let (m, starting) = mode_and_starting(&state);
            return Ok(status_of(&guard, m, starting));
        }
    }

    /* Always the mode that is *set*, never one passed in beside the press.
       Choosing and starting are two gestures and therefore two commands
       (`browser_set_mode` is the other): a start that could also change the
       setting gives the wall two ways to answer "how does this browser
       stand", and the one that loses is whichever was not the last call. */
    let mode = state.mode.lock().map(|m| *m).unwrap_or_default();

    let port = port.unwrap_or(DEFAULT_PORT);
    let profile = profile_dir(&app)?;
    let exe = find_chrome().ok_or_else(|| {
        "no Chrome or Edge found — looked in Program Files, Program Files (x86) and \
         Local AppData"
            .to_string()
    })?;

    let started = crate::off_main(move || spawn_browser(&exe, &profile, port, mode)).await??;

    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    *guard = Some(started);
    /* And *now* it is running, so say so where a crash cannot unsay it. */
    remember(&app, mode, true);
    let (_, starting) = mode_and_starting(&state);
    Ok(status_of(&guard, mode, starting))
}

/// Put one browser up, in the mode asked for, and wait until it answers.
///
/// Split out of `browser_start` because it is what the launch auto-start needs
/// too, and because the headless arm makes this a two-launch function rather
/// than the one-liner it used to be.
fn spawn_browser(
    exe: &std::path::Path,
    profile: &std::path::Path,
    port: u16,
    mode: Mode,
) -> Result<Running, String> {
    let (mut child, mut job) = raw_spawn(exe, profile, port, mode, None)?;

    let mut ready = match await_ready(port) {
        Ok(v) => v,
        Err(e) => {
            /* Dropping the job kills the tree. Leaving a Chrome running on
               a port we have decided is not answering is how a second
               attempt fails with "port in use" and the first orphan is
               never found. */
            drop(job);
            return Err(e);
        }
    };

    /* The headless relaunch. A `--user-agent` is a launch argument and the
       string it needs can only be got from a browser that is already up, so
       the first one is asked and thrown away. Paid only in headless mode, and
       in practice paid by the launch auto-start rather than by a person, since
       that runs behind the painted wall. */
    if mode == Mode::Headless {
        if let Some(ua) = headed_user_agent(&ready.user_agent) {
            let _ = child.kill();
            let _ = child.wait();
            drop(job);
            let (c, j) = raw_spawn(exe, profile, port, mode, Some(&ua))?;
            child = c;
            job = j;
            ready = match await_ready(port) {
                Ok(v) => v,
                Err(e) => {
                    drop(job);
                    return Err(e);
                }
            };
        }
    }

    /* Parking is deliberately not fatal. A Chrome you can see is not the
       browser you asked for; it is still a working browser, and refusing to
       give you one because it could not be moved would be the wrong trade. It
       goes on the face instead. */
    let warning = if mode == Mode::Parked {
        match park_windows(child.id()) {
            0 => Some(
                "the browser started but its window could not be parked off-screen — \
                 it is on your desktop"
                    .to_string(),
            ),
            _ => None,
        }
    } else {
        None
    };

    Ok(Running {
        child,
        _job: job,
        port,
        version: ready.version,
        browser_ws: ready.ws,
        mode,
        on_desktop: mode == Mode::Window || warning.is_some(),
        warning,
    })
}

/// The `CreateProcess` half, with the arguments each mode adds.
fn raw_spawn(
    exe: &std::path::Path,
    profile: &std::path::Path,
    port: u16,
    mode: Mode,
    user_agent: Option<&str>,
) -> Result<(Child, Option<jobs::Job>), String> {
    let mut cmd = Command::new(exe);
    cmd.arg(format!("--remote-debugging-port={port}"))
        /* Loopback is the only boundary CDP has; say so rather than
           relying on the default. */
        .arg(format!("--remote-debugging-address={HOST}"))
        /* Chrome 111+ closes a CDP WebSocket whose handshake carries an
           Origin header unless the origin is allowed, and every connection
           from the webview carries one. `*` is not a widening of what is
           reachable — any process on this machine can already open this
           port, with or without an Origin — it is what stops the widget's
           socket being refused for a reason nothing reports. */
        .arg("--remote-allow-origins=*")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        /* Nothing here wants Chrome's own restore prompt, session restore
           bubble, or default-browser nagging in a window somebody is
           driving through a screencast. */
        .arg("--disable-session-crashed-bubble")
        .arg("--hide-crash-restore-bubble");

    match mode {
        /* Identical, and that is a *finding* rather than an oversight. Parked
           and windowed differ only in where `park_windows` puts the window
           after it exists; there is nothing on the command line to tell them
           apart, which is why `browser_park` and `browser_show` work on either.

           This arm carried `--disable-features=CalculateNativeWinOcclusion`,
           `--disable-backgrounding-occluded-windows` and
           `--disable-renderer-backgrounding` for most of a day, on the
           reasoning that a window nobody can see is one Chrome stops painting.
           The control run says otherwise: parked **with** the three flags is
           602 frames in 30s and **without** them 601 (`probe-browser.ts
           hidden`, Chrome 152, two runs plus a long hold). They buy nothing
           here, because a parked window is not occluded in Windows' sense —
           `IsWindowVisible` is true and nothing overlaps it; it is simply
           outside every monitor.

           They came out rather than being left in as insurance, and the reason
           is in the same table: the one configuration where those flags change
           anything, they make it *worse*. `SW_HIDE` **with** them delivers 1
           frame in 30s, reproducibly, against 597 without. Flags with an
           interaction that surprising do not belong on a path measured fine
           without them. If the picture ever does go stale after minutes rather
           than seconds, `HOLD=300000` on that probe is the run that would show
           it and these three are the first thing to try — see
           `.claude/rules/browser.md`. */
        Mode::Window | Mode::Parked => {}
        Mode::Headless => {
            /* `=new` rather than bare `--headless`: the bare spelling is the
               new one from Chrome 132 and the old one before it, and this app
               does not get to assume which Chrome the machine has. */
            cmd.arg("--headless=new")
                /* Headless has no window to take a size from, and a viewport
                   nobody chose is one the widget letterboxes oddly. This is
                   the same figure `browser.md` quotes its frame costs at. */
                .arg("--window-size=1280,800");
            if let Some(ua) = user_agent {
                cmd.arg(format!("--user-agent={ua}"));
            }
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);

    let child = cmd.spawn().map_err(|e| format!("start the browser: {e}"))?;

    /* Assigned before anything else happens to the child, which is what
       puts its whole tree inside the job from its first breath — a renderer
       spawned between `CreateProcess` and the assignment would be outside
       it for life. `servers.rs` and `supervisor.rs` both say this where
       they do it; it is not decorative. */
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    Ok((child, job))
}

/// Write down how the browser stands, so the next launch can put it back.
///
/// Swallows its failure on purpose and in one place: none of this is worth
/// failing a start or a stop over, and the cost of a lost write is one launch
/// that does not restore a browser.
fn remember(app: &AppHandle, mode: Mode, running: bool) {
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return;
    };
    let Ok(conn) = store.0.lock() else { return };
    if let Err(e) = crate::store::save_browser_state(&conn, mode.as_str(), running) {
        log::warn!("browser: could not remember how the browser stands: {e}");
    }
}

#[tauri::command]
pub async fn browser_stop(app: AppHandle, state: State<'_, Browser>) -> Result<Status, String> {
    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    /* Taking it out of the Option drops the job, which kills the tree. The
       explicit `kill` is for the one process we hold a handle to, so its exit
       status is reaped rather than left for the OS. */
    if let Some(mut r) = guard.take() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    let (mode, starting) = mode_and_starting(&state);
    /* Stopped on purpose, so the next launch must not bring it back. This is
       the whole of what distinguishes a browser you closed from one the wall
       was killed holding. */
    remember(&app, mode, false);
    Ok(status_of(&guard, mode, starting))
}

/// Wait until the launch auto-start has settled, and say whether there is a
/// browser.
///
/// One call, for one caller: the rouse queue, which spawns cards at launch and
/// must not spawn them into the gap where the browser is coming up but not yet
/// answering. A card spawned in that gap has no `mcp__browser__*` and cannot be
/// given any — an MCP server's arguments are settled at spawn — so the cost of
/// getting this wrong is a card that is silently less capable than the one
/// beside it, for the rest of its life.
///
/// Returns immediately when nothing is starting, which is every launch that
/// had no browser to restore. Bounded well past what a start can take, so a
/// wedged Chrome delays the queue rather than stopping it: the queue is
/// background work and a card roused late is a card roused.
///
/// This is a wait rather than a poll, and the distinction is the one
/// `await_ready` already makes one screen up — it runs once, it stops at the
/// first answer, and there is nothing here that goes on asking after that.
#[tauri::command]
pub async fn browser_await_start(app: AppHandle) -> Result<bool, String> {
    /* Generous: a headless start is two launches, each bounded by
       READY_TIMEOUT, so the honest ceiling is a little over twice that. */
    let deadline =
        std::time::Instant::now() + READY_TIMEOUT * 2 + std::time::Duration::from_secs(2);
    loop {
        let Some(state) = app.try_state::<Browser>() else {
            return Ok(false);
        };
        let starting = state.starting.lock().map(|s| *s).unwrap_or(false);
        if !starting {
            let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
            return Ok(guard.is_some());
        }
        if std::time::Instant::now() >= deadline {
            log::warn!("browser: the restored browser is taking too long; rousing anyway");
            return Ok(false);
        }
        drop(state);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Choose how the browser stands, without starting or stopping anything.
///
/// Takes effect at the next start rather than now, and that is the honest
/// behaviour rather than a shortcut: `--headless` is a *launch argument*, so a
/// running Chrome cannot be made headless whatever this is set to. Between the
/// two windowed modes there is nothing on the command line to change at all —
/// what moves a running browser is `browser_show` / `browser_park`, which ask
/// a different question anyway: where this window is right now, rather than
/// how the next one should come up.
///
/// Written to the database immediately, keeping `was_running` as it stands: a
/// preference is chosen the moment you press it, and a wall closed before the
/// next start should still come back with the mode you picked.
#[tauri::command]
pub async fn browser_set_mode(
    app: AppHandle,
    state: State<'_, Browser>,
    mode: Mode,
) -> Result<Status, String> {
    {
        let mut held = state.mode.lock().map_err(|_| "browser state poisoned")?;
        *held = mode;
    }
    let running = {
        let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
        guard.is_some()
    };
    remember(&app, mode, running);

    let (m, starting) = mode_and_starting(&state);
    let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    Ok(status_of(&guard, m, starting))
}

/// Put every window this browser owns back off the desktop.
///
/// Idempotent and cheap — an `EnumWindows` pass and, for anything already
/// parked, nothing at all. It exists because parking is not a thing you do
/// once: Chrome opens a *window* for an OAuth popup or a `newWindow` target,
/// and Windows places that one wherever it likes. A new *tab* was measured not
/// to need this, which is what makes parking viable at all — the common case
/// costs nothing and only the rare one is chased.
///
/// The caller is `pane.svelte.ts`, on `Target.targetCreated` over the CDP
/// socket it already holds. That is a fold over an event stream that already
/// exists rather than a poller, which is the bar `CLAUDE.md` sets — Chrome
/// announces a new target, and a new window can only arrive with one.
#[tauri::command]
pub async fn browser_park(state: State<'_, Browser>) -> Result<usize, String> {
    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    let pid = match guard.as_ref() {
        None => return Ok(0),
        /* Headless is the only mode this cannot serve, and it is because there
           is no window rather than because of anything it was launched with.
           A browser started *in a window* parks perfectly well: the two modes
           put identical arguments on the command line, and the only thing that
           made them different was three occlusion flags the control run showed
           buy nothing (`raw_spawn`). So this refuses one case instead of two,
           and the widget offers the button accordingly. */
        Some(r) if r.mode == Mode::Headless => return Ok(0),
        Some(r) => r.child.id(),
    };
    let moved = park_windows(pid);
    if let Some(r) = guard.as_mut() {
        r.on_desktop = false;
    }
    Ok(moved)
}

/// Bring the browser back onto the desktop, whatever mode it is in.
///
/// The escape hatch, and the reason parking beats headless as a default: a
/// sign-in that wants a real window — a native SSO prompt, a password manager,
/// a captcha you would rather just click — is one press away, and one press
/// back. Headless has no window to give, so this refuses rather than pretending.
#[tauri::command]
pub async fn browser_show(state: State<'_, Browser>) -> Result<Status, String> {
    let (mode, starting) = mode_and_starting(&state);
    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    match guard.as_mut() {
        None => return Err("the browser is not running".into()),
        Some(r) if r.mode == Mode::Headless => {
            return Err(
                "this browser is headless, so it has no window to show — stop it and start \
                 it parked or in a window"
                    .into(),
            )
        }
        Some(r) => {
            show_windows(r.child.id());
            /* Where the window *is* changes. How it was launched does not, and
               neither does the remembered preference: you are borrowing the
               window for a sign-in, not choosing to work that way, so the next
               start is still what you set. */
            r.on_desktop = true;
        }
    }
    Ok(status_of(&guard, mode, starting))
}

/// Undo a park: back onto the desktop, back into the taskbar, and in front.
#[cfg(windows)]
fn show_windows(pid: u32) {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
        SetForegroundWindow, SetWindowLongW, SetWindowPos, ShowWindow, GWL_EXSTYLE, SWP_NOSIZE,
        SWP_NOZORDER, SW_HIDE, SW_SHOW, WS_EX_TOOLWINDOW,
    };

    struct Hunt {
        pid: u32,
        found: Vec<HWND>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let hunt = &mut *(lparam.0 as *mut Hunt);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != hunt.pid {
                return TRUE;
            }
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class);
            if n <= 0
                || !String::from_utf16_lossy(&class[..n as usize]).starts_with("Chrome_WidgetWin")
            {
                return TRUE;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() || rect.right - rect.left <= 100 {
                return TRUE;
            }
            hunt.found.push(hwnd);
            TRUE
        }
    }

    let mut hunt = Hunt {
        pid,
        found: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut hunt as *mut _ as isize));
    }

    for hwnd in hunt.found {
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            if style & WS_EX_TOOLWINDOW.0 as i32 != 0 {
                /* Same bracket as the park: a taskbar-affecting ex-style
                   change is only honoured on a window that is hidden while it
                   is made. */
                let _ = ShowWindow(hwnd, SW_HIDE);
                SetWindowLongW(hwnd, GWL_EXSTYLE, style & !(WS_EX_TOOLWINDOW.0 as i32));
            }
            /* Somewhere a person can actually reach. Not where it was before
               parking — that is not remembered, and a window arriving at the
               top-left of the work area is a window you can see and move. */
            let _ = SetWindowPos(hwnd, None, 80, 80, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(windows))]
fn show_windows(_pid: u32) {}

/* ── coming back up ────────────────────────────────────────────────────── */

/// Restore how the browser stood when the wall last closed.
///
/// Called from `setup`. Two things happen and only the first is synchronous:
/// the remembered *mode* is loaded into the state immediately, so the widget
/// draws the right knob from the first frame; and if the browser was running,
/// a start is kicked off in the background.
///
/// **The auto-start is conditional on the remembered flag, and that is what
/// makes it affordable.** `browser.md` refused an unconditional auto-start on
/// the arithmetic — ~450 MB for a wall that may never open a browser widget —
/// and that argument still holds. It says nothing about a browser that was
/// demonstrably in use when the wall closed, which is not a guess about what
/// you might want but a record of what you had.
///
/// It also closes the rough edge that file names as the one left: a card
/// spawned at launch could not have `mcp__browser__*`, because the browser was
/// not up yet and an MCP server's arguments are settled at spawn. With the
/// browser coming up at launch, cards roused after it do have the tools — which
/// is why `starting` is a published field and the rouse queue waits on it.
/// Nothing here blocks the window: `setup` returns immediately and the wall
/// paints while Chrome is still starting.
pub fn resume_at_launch(app: &AppHandle) {
    let (mode, was_running) = {
        let Some(store) = app.try_state::<crate::store::Store>() else {
            return;
        };
        let Ok(conn) = store.0.lock() else { return };
        match crate::store::read_browser_state(&conn) {
            Some((m, r)) => (Mode::from_stored(&m), r),
            None => return,
        }
    };

    let Some(state) = app.try_state::<Browser>() else {
        return;
    };
    if let Ok(mut held) = state.mode.lock() {
        *held = mode;
    }
    if !was_running {
        return;
    }

    /* Marked before the thread starts rather than inside it. The rouse queue
       reads this to decide whether to wait, and a flag set a few milliseconds
       into the background work is a flag it can miss entirely. */
    if let Ok(mut s) = state.starting.lock() {
        *s = true;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let done = |handle: &AppHandle| {
            if let Some(state) = handle.try_state::<Browser>() {
                if let Ok(mut s) = state.starting.lock() {
                    *s = false;
                }
            }
        };

        let (Ok(profile), Some(exe)) = (profile_dir(&handle), find_chrome()) else {
            log::warn!("browser: was running last time, but there is no Chrome to start");
            done(&handle);
            return;
        };

        match crate::off_main(move || spawn_browser(&exe, &profile, DEFAULT_PORT, mode)).await {
            Ok(Ok(running)) => {
                if let Some(state) = handle.try_state::<Browser>() {
                    if let Ok(mut guard) = state.inner.lock() {
                        *guard = Some(running);
                    }
                }
                log::info!("browser: restored, {}", mode.as_str());
            }
            Ok(Err(e)) | Err(e) => {
                /* Not fatal and not silent. The commonest cause is a Chrome
                   already holding 9222 — a stale one from a wall that was
                   killed, or the person's own with a debugging port. The widget
                   will offer a start button, which is the right next move. */
                log::warn!("browser: could not restore the browser that was running: {e}");
                /* And it is no longer running, so stop claiming it was — else
                   every launch from here tries and fails again. */
                remember(&handle, mode, false);
            }
        }
        done(&handle);
    });
}

/// Every page the browser has open, so the widget can pick one to attach to.
///
/// `async` for the same reason `browser_start` is — this is a loopback HTTP
/// round trip, and a hung one on the main thread stops the wall.
#[tauri::command]
pub async fn browser_targets(state: State<'_, Browser>) -> Result<Vec<Target>, String> {
    let port = {
        let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
        match guard.as_ref() {
            None => return Err("the browser is not running".into()),
            Some(r) => r.port,
        }
    };

    let body = crate::off_main(move || {
        get(
            &format!("http://{HOST}:{port}/json/list"),
            std::time::Duration::from_secs(3),
        )
    })
    .await??;

    let list: Vec<serde_json::Value> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .map(|t| Target {
            id: t["id"].as_str().unwrap_or_default().to_string(),
            kind: t["type"].as_str().unwrap_or_default().to_string(),
            title: t["title"].as_str().unwrap_or_default().to_string(),
            url: t["url"].as_str().unwrap_or_default().to_string(),
            ws: t["webSocketDebuggerUrl"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        })
        .collect())
}

/// Open a page, and return the target to attach to.
///
/// `PUT /json/new?<url>` rather than driving an existing tab: the widget wants
/// a page it owns, and a person's own tab is not that. Chrome requires the verb
/// be PUT since 111 — a GET answers 405 with a body that says so, which is at
/// least a failure that explains itself.
#[tauri::command]
pub async fn browser_open(state: State<'_, Browser>, url: String) -> Result<Target, String> {
    let port = {
        let guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
        match guard.as_ref() {
            None => return Err("the browser is not running".into()),
            Some(r) => r.port,
        }
    };

    let target = crate::off_main(move || {
        let encoded = urlencoding_minimal(&url);
        ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .put(&format!("http://{HOST}:{port}/json/new?{encoded}"))
            .call()
            .map_err(|e| format!("open a page: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())
    })
    .await??;

    let t: serde_json::Value = serde_json::from_str(&target).map_err(|e| e.to_string())?;
    Ok(Target {
        id: t["id"].as_str().unwrap_or_default().to_string(),
        kind: t["type"].as_str().unwrap_or_default().to_string(),
        title: t["title"].as_str().unwrap_or_default().to_string(),
        url: t["url"].as_str().unwrap_or_default().to_string(),
        ws: t["webSocketDebuggerUrl"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

/// Percent-encode the few characters that would end the query early.
///
/// A whole dependency is not worth it for this: the string is a URL going in a
/// query position, so what matters is `#` (which would make the rest a
/// fragment), `&`, and whitespace. Everything else Chrome accepts verbatim, and
/// over-encoding `:` and `/` would break the URL it is meant to open.
fn urlencoding_minimal(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for c in url.chars() {
        match c {
            '#' => out.push_str("%23"),
            '&' => out.push_str("%26"),
            ' ' => out.push_str("%20"),
            '\n' | '\r' | '\t' => {}
            _ => out.push(c),
        }
    }
    out
}

/* ── the session vault ─────────────────────────────────────────────────── */

/// Where the shared sign-ins live.
///
/// One file for the whole wall, not one per app: Playwright's `storageState`
/// carries cookies for every domain and local storage for every origin in a
/// single document, so splitting it would be this app inventing a structure the
/// format does not have — and a card would then need to know which file its app
/// was in, which is knowledge it has no way to get.
///
/// Under the app data folder for the reason the database and the browser
/// profile are: `dev.skein.studio` is the durable identity and is deliberately
/// not renamed when the product is.
pub fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("sessions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("make {}: {e}", dir.display()))?;
    Ok(dir.join("wall.json"))
}

/// Make sure the vault exists, and is a vault, before anything reads it.
///
/// Called from `setup`, and the reason is a failure mode with no good symptom:
/// `@playwright/mcp --storage-state <path>` with a path that does not exist is
/// a browser that will not start, and the card that finds out is one whose turn
/// is already spent. An empty state seeds nothing and breaks nothing, so the
/// honest default is a valid empty file rather than an absent one.
///
/// Deliberately returns nothing and cannot fail the launch. A wall that will
/// not open because it could not pre-create a convenience file would be worse
/// than the convenience is worth — and unlike `Store::open`, nothing here is
/// load-bearing for drawing the wall. It logs and carries on, which is the one
/// case where that is the right answer.
pub fn ensure_session_file(app: &AppHandle) {
    let Ok(path) = session_path(app) else {
        log::warn!("browser: no app data directory, so no session vault");
        return;
    };
    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::write(&path, r#"{"cookies":[],"origins":[]}"#) {
        log::warn!("browser: could not create {}: {e}", path.display());
    }
}

/// Where the vault is, for the widget to say and for a person to paste.
#[tauri::command]
pub async fn browser_session_file(app: AppHandle) -> Result<String, String> {
    Ok(session_path(&app)?.display().to_string())
}

/// Write the vault.
///
/// Takes the assembled JSON rather than going and getting it, because getting
/// it means CDP commands on a live socket and that socket is the front end's —
/// the same division every other part of this file makes. Rust's half is that
/// the write is atomic: a card reading a half-written vault gets a parse error
/// and no session, and it would get it exactly when several agents were
/// starting at once. Write to a sibling and rename, which on Windows is
/// `MoveFileEx` with replace semantics and is what `std::fs::rename` does.
#[tauri::command]
pub async fn browser_save_session(app: AppHandle, state: String) -> Result<String, String> {
    /* Parsed here rather than trusted: this file is handed to every seeded
       browser on the wall, and one that will not parse costs every card its
       sign-in at once. Cheaper to refuse it than to write it. */
    serde_json::from_str::<serde_json::Value>(&state)
        .map_err(|e| format!("that is not a session document: {e}"))?;
    let path = session_path(&app)?;
    let tmp = path.with_extension("json.writing");
    crate::off_main(move || {
        std::fs::write(&tmp, state).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("replace {}: {e}", path.display()))?;
        Ok::<String, String>(path.display().to_string())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_survives_being_put_in_a_query() {
        assert_eq!(
            urlencoding_minimal("http://localhost:3000/a/b?x=1"),
            "http://localhost:3000/a/b?x=1",
            "the scheme, path and existing query must not be mangled"
        );
    }

    /// The `#` is the one that matters: unencoded, Chrome opens the page
    /// *before* the fragment and the app's router never sees the route.
    #[test]
    fn a_fragment_does_not_end_the_query() {
        assert_eq!(
            urlencoding_minimal("http://x/#/route&then"),
            "http://x/%23/route%26then"
        );
    }

    #[test]
    fn newlines_cannot_smuggle_a_second_request_line() {
        assert_eq!(urlencoding_minimal("http://x/\r\nHost: y"), "http://x/Host:%20y");
    }

    /// Nothing running is not an error state, and the port it *would* use is
    /// still worth reporting — the widget shows it before you start anything,
    /// and it is what a person pastes into `--cdp-endpoint`.
    #[test]
    fn a_stopped_browser_still_names_its_port() {
        let s = status_of(&None, Mode::default(), false);
        assert!(!s.running);
        assert_eq!(s.port, DEFAULT_PORT);
        assert!(s.endpoint.is_empty(), "there is no endpoint until there is a browser");
    }

    /// The widget's knob is drawn from the status, and there is no browser to
    /// read a mode off before you press start — so a stopped browser has to
    /// report the mode a start *would* use, or the knob resets itself to the
    /// default every time the browser is not running.
    #[test]
    fn a_stopped_browser_still_says_which_mode_it_would_use() {
        let s = status_of(&None, Mode::Headless, false);
        assert_eq!(s.mode, Mode::Headless);
        assert!(!s.running);
    }

    /// A start in flight is neither running nor stopped, and conflating it
    /// with stopped is how a wall offers a start button for a browser that is
    /// already coming up — and gets two Chromes fighting over one port.
    #[test]
    fn a_browser_still_coming_up_says_so() {
        let s = status_of(&None, Mode::Parked, true);
        assert!(!s.running);
        assert!(s.starting);
    }

    /// The database holds a free string, so every value that is not one of
    /// this build's own has to land somewhere sensible rather than erroring —
    /// the bargain `migrate_v33` describes.
    #[test]
    fn a_mode_read_back_is_clamped_to_one_this_build_knows() {
        assert_eq!(Mode::from_stored("window"), Mode::Window);
        assert_eq!(Mode::from_stored("parked"), Mode::Parked);
        assert_eq!(Mode::from_stored("headless"), Mode::Headless);
        assert_eq!(
            Mode::from_stored("holographic"),
            Mode::default(),
            "a mode from a newer build must not stop this one opening a browser"
        );
        assert_eq!(Mode::from_stored(""), Mode::default());
    }

    /// Round-trips, because the string is what goes in the database and the
    /// enum is what reaches a launch argument. A spelling that survives one
    /// way and not the other is a mode that silently resets on every launch.
    #[test]
    fn every_mode_survives_the_database() {
        for m in [Mode::Window, Mode::Parked, Mode::Headless] {
            assert_eq!(Mode::from_stored(m.as_str()), m);
        }
    }

    /// The wire spelling is the front end's vocabulary too, and the knob's
    /// option values are these literals.
    #[test]
    fn the_wire_spelling_is_lowercase() {
        assert_eq!(
            serde_json::to_string(&Mode::Headless).unwrap(),
            "\"headless\""
        );
        assert_eq!(
            serde_json::from_str::<Mode>("\"parked\"").unwrap(),
            Mode::Parked
        );
    }

    /// Only the one word comes out, and only when it is there.
    ///
    /// Derived from what the browser reported rather than composed here, so
    /// the test that matters is that a headed agent is left completely alone —
    /// overriding a user agent that was already right would be this file
    /// asserting an opinion about Chrome's format, which is the thing it is
    /// written to avoid.
    #[test]
    fn only_a_headless_user_agent_is_rewritten() {
        let headed = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                      (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
        assert_eq!(headed_user_agent(headed), None);
        assert_eq!(headed_user_agent(""), None);

        let headless = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                        (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36";
        assert_eq!(
            headed_user_agent(headless).as_deref(),
            Some(headed),
            "the rewritten agent must be exactly what a headed Chrome of this build sends"
        );
    }

    /// Edge is a Chromium and `find_chrome` falls back to it, so the rewrite
    /// has to survive a user agent with a trailing brand on it. Nothing about
    /// this function knows what a brand is, which is the point.
    #[test]
    fn an_edge_user_agent_survives_the_rewrite() {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0";
        assert_eq!(
            headed_user_agent(ua).as_deref(),
            Some(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
            )
        );
    }
}
