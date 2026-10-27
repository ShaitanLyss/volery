//! One browser MCP server for the whole wall, instead of one per card — and
//! since 2026-10-24, one in which each card has tabs of its own.
//!
//! Every project card used to carry its own stdio `npx @playwright/mcp
//! --cdp-endpoint http://127.0.0.1:9222`: three processes and ~217 MB per card
//! (sink 482e25ee), all of them driving **the same Chrome**. Measured on
//! 2026-10-14 at ten cards: about 1.4 GB of private memory spent on identical
//! servers, on a 15.4 GB machine found at 0.4 GB free.
//!
//! `@playwright/mcp` has an HTTP transport (`--port`), where one process serves
//! many clients, and reading its source (playwright-core 1.64, bundled with
//! `@playwright/mcp` 0.0.83, `coreBundle.js` around `factory.create`) settled
//! that a session got what a stdio server got: its own `connectOverCDP`, the
//! default context — so the user's live sign-ins stay shared — and its own
//! `BrowserBackend`, which is where "the current tab" lives.
//!
//! **And that was the bug, not the reassurance it read as.** A backend's tabs
//! are every page in the default context, and its current tab is the first of
//! them. So every card saw every card's pages, a card with no tab of its own
//! took whichever page Chrome listed first, `browser_tabs select` brought a
//! page to the front of the one window they all shared and hid the rest, and a
//! card closing "a duplicate" closed another card's work. Sink 9e05a3fd is
//! Lyss's own wording of it; `.claude/rules/browser.md` has the twenty twins.
//!
//! So the server Volery runs is `browserhost.cjs` — the same server built from
//! the pieces `@playwright/mcp`'s own CLI is built from, run under the pinned
//! package by `npx -p`, with three differences: a card is named in the URL
//! (`/mcp/<card>`) and gets a browser context of its own — its own pages,
//! cookies and storage — seeded from the vault (`browser::session_path`) and
//! saved back into it when it closes; and every page a card opens is a window
//! of its own. The file says how, `browservault.cjs` is the merge rule, and
//! `tools/probe-card-tabs.ts` is the measurement.
//!
//! Two properties of the original are kept on purpose, both load-bearing:
//!
//! - **A session costs nothing until it calls a tool.** The backend (and so the
//!   CDP connection) is created on the first `tools/call`, never at `initialize`
//!   or `tools/list` — the same laziness `browser.rs`'s probe measured over stdio.
//! - **A dead client's session is closed by the server.** Once a session has a
//!   backend the server pings it every three seconds and closes it when a ping
//!   goes unanswered, which disposes the CDP connection — and, `TAB_GRACE`
//!   later, the dead card's tabs. That matters here more than anywhere: Volery
//!   ends a card with `TerminateProcess`, so no client ever says goodbye.
//!
//! **And it ends the CONNECT_TIMEOUT family**, which is the other half of why
//! sharing one server was worth doing (sinks 36919493, d5c3b54e, ab552a46,
//! 0e31145a, 6f564b5a, c14409db, cb41f229, 2f25b6b7). Each of those is a card
//! whose stdio server — `npx` resolving a package on a machine with no memory
//! to spare — did not answer `initialize` inside the CLI's thirty seconds, and
//! the CLI does not retry. Connecting to a server already up is a loopback
//! round trip.
//!
//! The port is fixed for the reason `browser::DEFAULT_PORT` is: a card's
//! `--mcp-config` is written at spawn and cannot be renegotiated, so the address
//! has to be knowable before anything is listening on it. Fixed per wall, not
//! per machine: a named lab's is its own (`browser::ports`), so it runs a host
//! of its own against a Chrome of its own rather than finding the installed
//! wall's answering here.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::servers::jobs;

use crate::browser::mcp_url as url;

/// This wall's host port: 9245 on the installed wall, a lab's own on a lab.
fn port() -> u16 {
    crate::browser::ports().mcp
}

/// Loopback only, like the CDP port it drives. See `browser::mcp_url`.
const HOST: &str = "127.0.0.1";

/// The `@playwright/mcp` this wall runs. See the note in `start` on why it is
/// pinned, and re-run `tools/probe-shared-mcp.ts` and `tools/probe-card-tabs.ts`
/// before moving it — the host reaches into the package's `tools` export, which
/// is public but young, so a move is a re-probe rather than a bump.
const PINNED: &str = "@playwright/mcp@0.0.83";

/// The server itself. Carried in the binary and written beside the database at
/// every start, so the installed app and the script it runs cannot drift apart.
const SCRIPT: &str = include_str!("browserhost.cjs");

/// The rule saved sign-ins are merged by, which the host loads from beside
/// itself. A file of its own so `test/browservault.test.ts` can run it.
const VAULT_SCRIPT: &str = include_str!("browservault.cjs");

/// What the host's one connection to Chrome may see — the cards' own
/// contexts and nothing else — and when a card's own tab counts as stopped
/// and what the card is told — and which of its repository's worktrees a card
/// may save a file in. Loaded from beside the host, files of their own for the
/// same reason: `test/browsercdp.test.ts`, `test/browserstall.test.ts` and
/// `test/browserroots.test.ts` run them.
const SIDE_SCRIPTS: [(&str, &str); 5] = [
    ("browservault.cjs", VAULT_SCRIPT),
    ("browsercdp.cjs", include_str!("browsercdp.cjs")),
    ("browserstall.cjs", include_str!("browserstall.cjs")),
    ("browserroots.cjs", include_str!("browserroots.cjs")),
    ("browserframes.cjs", include_str!("browserframes.cjs")),
];

/// How long a card's browser context outlives its last session: a card that
/// went dormant, or was killed, loses its pages this long after the server
/// notices — its sign-ins saved into the vault first. Lyss's
/// number (2026-10-24) — "the page can always be reopened cheaply" — and it is
/// the answer to sink f7553ae5, where a day of finished cards' tabs held
/// 4.2 GB of one Chrome. A card that is merely idle keeps its session, and so
/// its pages, for as long as its process lives.
const TAB_GRACE: Duration = Duration::from_secs(120);

/// How long a start may take before it is called failed. `npx` checks the
/// registry and may install the pinned version on a first run, and this machine taxes every process start
/// (`hooks.md`, the EDR), so this is generous; nothing waits on it but the
/// background thread that started it.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// The server, when this wall started it.
#[derive(Default)]
pub struct Host {
    child: Mutex<Option<Running>>,
    /// A start is in flight; a second caller does not begin another.
    starting: AtomicBool,
    /// A server has answered before. A start after that is a *restart*, and
    /// every live card's session died with the old process.
    ever: AtomicBool,
}

struct Running {
    child: Child,
    /// Holds the `cmd → node(npx) → node(server)` tree, so the whole of it goes
    /// with the app — the same promise every other spawn here makes.
    _job: Option<jobs::Job>,
}

fn answering() -> bool {
    let addr: SocketAddr = format!("{HOST}:{}", port()).parse().expect("a literal address");
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Whether a card connecting now would find a server.
pub fn up() -> bool {
    answering()
}

/// Every process of the server this wall started, for `load.rs`'s census.
/// Empty when another wall's server is the one answering.
pub fn pids(app: &AppHandle) -> Vec<u32> {
    app.try_state::<Host>()
        .and_then(|h| {
            h.child
                .try_lock()
                .ok()
                .and_then(|g| g.as_ref().and_then(|r| r._job.as_ref().map(|j| j.pids())))
        })
        .unwrap_or_default()
}

/// Close the tabs a card opened, now: the card has been closed for good.
///
/// The server would close them anyway, `TAB_GRACE` after the card's session
/// stopped answering, so this is only the impatient half — a closed card's
/// pages have nobody left to look at them, and two minutes of a WebGL scene
/// rendering for nobody is the thing sink f7553ae5 was about. On a thread of
/// its own and never waited on: it is called from `close_conversation_record`
/// on the main thread, and a server that is slow, or down, or another wall's
/// older build with no such route, must cost the close nothing.
pub fn release(card: &str) {
    let url = format!("http://{HOST}:{}/volery/release/{card}", port());
    std::thread::spawn(move || {
        let _ = ureq::post(&url).timeout(Duration::from_secs(5)).call();
    });
}

/// Start the server if nothing is answering on its port, in the background, and
/// ask every card whose `browser` server failed to connect to try again once it
/// is up. Cheap and idempotent: the common case is one loopback connect.
///
/// **Another wall's server counts.** A second Volery under the same ports finds
/// the port taken and uses what is there — it drives the same Chrome on the
/// same fixed port. A lab launched by `tools/lab.ts` is not that case any more:
/// its ports are its own, so what answers on them is its own host (sink
/// aabc85dd). A lab started some other way keeps the installed wall's pair, and
/// the old arrangement with it.
///
/// **Everything happens on a thread of its own**, the probe included: this is
/// called from `open_wall` on the main thread before any window exists, and a
/// 300ms connect timeout there is 300ms of nothing on every cold launch.
pub fn ensure(app: &AppHandle) {
    let Some(host) = app.try_state::<Host>() else { return };
    if host.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let host = app.state::<Host>();
        if answering() {
            /* A server is up — this wall's, or another's. Either way a later
               start is a *restart*, and the cards connected to this one will
               need telling when it goes. */
            host.ever.store(true, Ordering::SeqCst);
            host.starting.store(false, Ordering::SeqCst);
            return;
        }
        let result = start(&app, &host);
        host.starting.store(false, Ordering::SeqCst);
        match result {
            Ok(Started::Fresh) => {
                log::info!(target: "volery::mcphost", "shared browser MCP up on {}", url("<card>"));
                /* Only a server that replaced one sends every card back to
                   reconnect — each session died with the old process. A first
                   start, or one found answering after all, owes that only to
                   the cards that failed to connect. */
                if host.ever.swap(true, Ordering::SeqCst) {
                    crate::supervisor::reconnect_every_browser(&app);
                } else {
                    crate::supervisor::reconnect_stranded(&app);
                }
            }
            Ok(Started::Already) => crate::supervisor::reconnect_stranded(&app),
            Err(e) => log::warn!(target: "volery::mcphost", "shared browser MCP did not start: {e}"),
        }
    });
}

enum Started {
    /// A new process was started and answered.
    Fresh,
    /// One was already there after all — ours, slow to answer a probe, or
    /// another wall's.
    Already,
}

/// How long a live child is given to answer before being called wedged. One
/// missed 300ms probe on the saturated machine this exists for is not a dead
/// server, and killing a healthy one costs every card its browser for the
/// length of an `npx` start.
const LIVE_GRACE: Duration = Duration::from_secs(10);

/// The address the host reports a stuck tab to, with the card appended: this
/// wall's own ask listener. None while it has no port, which is a wall whose
/// cards have no tools at all and nothing to report about.
fn report_url(ask_port: u16) -> Option<String> {
    (ask_port != 0).then(|| format!("http://{HOST}:{ask_port}{}", crate::ask::STALLED_PATH))
}

/// The address the host posts every browser call to, with the card appended:
/// it holds the screen on and hears back whether it is locked or off
/// (`ask::FRAMES_PATH`, `screen.rs`). None without a port, as `report_url`.
fn frames_url(ask_port: u16) -> Option<String> {
    (ask_port != 0).then(|| format!("http://{HOST}:{ask_port}{}", crate::ask::FRAMES_PATH))
}

fn start(app: &AppHandle, host: &Host) -> Result<Started, String> {
    let mut guard = host.child.lock().map_err(|_| "mcp host state poisoned")?;
    if let Some(r) = guard.as_mut() {
        if matches!(r.child.try_wait(), Ok(None)) {
            let deadline = Instant::now() + LIVE_GRACE;
            while Instant::now() < deadline {
                if answering() {
                    return Ok(Started::Already);
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        let _ = r.child.kill();
        *guard = None;
    }
    if answering() {
        return Ok(Started::Already);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    let script = dir.join("browserhost.cjs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(&script, SCRIPT).map_err(|e| format!("{}: {e}", script.display()))?;
    for (name, body) in SIDE_SCRIPTS {
        let at = dir.join(name);
        std::fs::write(&at, body).map_err(|e| format!("{}: {e}", at.display()))?;
    }
    /* Each card's context is seeded from the vault and saved back into it, so
       the host is handed the one file the widget's save and the isolated
       `playwright` server already share (`browser::session_path`). */
    crate::browser::ensure_session_file(app);
    let vault = crate::browser::session_path(app)?;
    /* `npx`, once, for the wall — the wrapper sink 482e25ee measured at 111 MB
       was a per-card cost and is now a per-wall one. `-p … node <script>`
       rather than the package's own bin: `npx -p` puts the pinned package's
       `.bin` on the script's PATH, which is how `browserhost.cjs` finds the
       playwright-core beside it without anybody reading npm's hash-named cache.

       **Pinned to the version that was probed**, where the stdio entry floated
       on `@latest`. The trade changed with the transport: a stdio server that
       broke cost the cards it broke, but an HTTP server that answers a card 401
       or 403 is remembered by the *name* `browser` in the CLI's machine-wide
       `mcp-needs-auth-cache.json`, and every session on the machine then lists
       it as needing auth without sending a request (`load.md` §1). The host
       never answers either — a wrong `Host` is a 421 — and the pin is also what
       its reach into the package's internals rests on. */
    let ask_port = app.state::<crate::ask::Asks>().port();
    let report = report_url(ask_port);
    let mut words: Vec<String> = vec![
        "npx".into(),
        "--yes".into(),
        "-p".into(),
        PINNED.into(),
        "node".into(),
        script.display().to_string(),
        "--port".into(),
        port().to_string(),
        "--host".into(),
        HOST.into(),
        "--cdp-endpoint".into(),
        crate::browser::address(),
        "--vault".into(),
        vault.display().to_string(),
        "--grace-ms".into(),
        TAB_GRACE.as_millis().to_string(),
    ];
    /* Where the host tells the wall a card's tab stopped answering, so it is a
       row in the chronicle as well as a sentence to the card. */
    if let Some(r) = report {
        words.push("--report".into());
        words.push(r);
    }
    if let Some(f) = frames_url(ask_port) {
        words.push("--frames".into());
        words.push(f);
    }
    let mut cmd = Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /* `/S` with the whole line in one pair of quotes and every word quoted
           inside it, so a profile path with a space in it stays one argument —
           `pool.rs`'s spelling, for its reason — **except the program name**.
           `npx` is a `.cmd` shim that finds npm through `%~dp0`, and invoked as
           `"npx"` that expands to the current directory instead of the shim's:
           measured, `Cannot find module '<cwd>\node_modules\npm\bin\npm-prefix.js'`
           and nothing listening. The name is a constant with no space in it. */
        let line = std::iter::once(words[0].clone())
            .chain(words[1..].iter().map(|w| crate::pool::cmd_word(w)))
            .collect::<Vec<_>>()
            .join(" ");
        cmd.raw_arg(format!("/S /C \"{line}\""));
    }
    #[cfg(not(windows))]
    cmd.arg("-c").arg(words.join(" "));
    cmd.stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn npx: {e}"))?;
    /* Assigned before anything else happens, so the tree is inside from its
       first breath — `processes.md` on why that ordering is load-bearing. */
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                log::info!(target: "volery::mcphost", "{line}");
            }
        });
    }
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if answering() {
            *guard = Some(Running { child, _job: job });
            return Ok(Started::Fresh);
        }
        if let Ok(Some(status)) = child.try_wait() {
            /* Something else may have bound the port in the meantime — a second
               wall racing this one. That is a server, and it will do. */
            if answering() {
                return Ok(Started::Already);
            }
            return Err(format!("it exited with {status} before answering"));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = child.kill();
    Err(format!("nothing answered on {} within {}s", url("<card>"), READY_TIMEOUT.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host is told where to report a stuck tab only when there is a
    /// listener to report to, and the card is appended to exactly that path.
    #[test]
    fn the_host_reports_to_this_walls_own_listener() {
        assert_eq!(report_url(0), None);
        assert_eq!(
            report_url(51234).as_deref(),
            Some("http://127.0.0.1:51234/browser/stalled/")
        );
    }

    /// Every file the host `require`s from beside itself is written there.
    #[test]
    fn every_script_the_host_loads_is_written_beside_it() {
        for needed in ["browservault.cjs", "browsercdp.cjs", "browserstall.cjs", "browserroots.cjs"] {
            assert!(SCRIPT.contains(needed), "the host no longer loads {needed}");
            assert!(SIDE_SCRIPTS.iter().any(|(n, _)| *n == needed), "{needed} is not written");
        }
    }
}
