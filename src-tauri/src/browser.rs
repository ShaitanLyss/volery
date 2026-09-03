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

use serde::Serialize;
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
}

#[derive(Default)]
pub struct Browser {
    inner: Mutex<Option<Running>>,
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
fn await_ready(port: u16) -> Result<String, String> {
    let url = format!("http://{HOST}:{port}/json/version");
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    let mut last = String::from("no answer");
    while std::time::Instant::now() < deadline {
        match get(&url, std::time::Duration::from_millis(500)) {
            Ok(body) => {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                return Ok(v["Browser"].as_str().unwrap_or("chrome").to_string());
            }
            Err(e) => last = e,
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    Err(format!("the browser did not open its port in time ({last})"))
}

/* ── commands ──────────────────────────────────────────────────────────── */

fn status_of(guard: &Option<Running>) -> Status {
    match guard {
        None => Status {
            port: DEFAULT_PORT,
            ..Default::default()
        },
        Some(r) => Status {
            running: true,
            port: r.port,
            endpoint: format!("http://{HOST}:{}", r.port),
            version: r.version.clone(),
            procs: r._job.as_ref().map(|j| j.pids().len()).unwrap_or(0),
        },
    }
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
    Ok(status_of(&guard))
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
            return Ok(status_of(&guard));
        }
    }

    let port = port.unwrap_or(DEFAULT_PORT);
    let profile = profile_dir(&app)?;
    let exe = find_chrome().ok_or_else(|| {
        "no Chrome or Edge found — looked in Program Files, Program Files (x86) and \
         Local AppData"
            .to_string()
    })?;

    let started = crate::off_main(move || {
        let mut cmd = Command::new(&exe);
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
            .arg("--hide-crash-restore-bubble")
            .stdin(Stdio::null())
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

        let version = match await_ready(port) {
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

        Ok(Running {
            child,
            _job: job,
            port,
            version,
        })
    })
    .await??;

    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    *guard = Some(started);
    Ok(status_of(&guard))
}

#[tauri::command]
pub async fn browser_stop(state: State<'_, Browser>) -> Result<Status, String> {
    let mut guard = state.inner.lock().map_err(|_| "browser state poisoned")?;
    /* Taking it out of the Option drops the job, which kills the tree. The
       explicit `kill` is for the one process we hold a handle to, so its exit
       status is reaped rather than left for the OS. */
    if let Some(mut r) = guard.take() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    Ok(status_of(&guard))
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
        let s = status_of(&None);
        assert!(!s.running);
        assert_eq!(s.port, DEFAULT_PORT);
        assert!(s.endpoint.is_empty(), "there is no endpoint until there is a browser");
    }
}
