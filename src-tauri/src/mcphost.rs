//! One `@playwright/mcp` for the whole wall, instead of one per card.
//!
//! Every project card used to carry its own stdio `npx @playwright/mcp
//! --cdp-endpoint http://127.0.0.1:9222`: three processes and ~217 MB per card
//! (sink 482e25ee), all of them driving **the same Chrome**. Measured on
//! 2026-10-14 at ten cards: about 1.4 GB of private memory spent on identical
//! servers, on a 15.4 GB machine found at 0.4 GB free.
//!
//! `@playwright/mcp` has an HTTP transport (`--port`), where one process serves
//! many clients, and reading its source (playwright-core 1.64, bundled with
//! `@playwright/mcp` 0.0.83, `coreBundle.js` around `factory.create`) settles the
//! one thing that had to be true before sharing it: **each HTTP session gets
//! what a stdio server got.** A session opens its own `connectOverCDP`, takes
//! `browser.contexts()[0]` — the default context, so the user's live sign-ins
//! stay shared exactly as before — and builds its own `BrowserBackend`, which is
//! where "the current tab" lives. Nothing about a card's view of the browser
//! changes; only the process count does. `--shared-browser-context` would have
//! made every card share one backend, and one current tab, which is the fight
//! sinks 7af2acb4 and 9e05a3fd already describe — it is deliberately not passed.
//!
//! Two more properties from the same reading, both load-bearing:
//!
//! - **A session costs nothing until it calls a tool.** The backend (and so the
//!   CDP connection) is created on the first `tools/call`, never at `initialize`
//!   or `tools/list` — the same laziness `browser.rs`'s probe measured over stdio.
//! - **A dead client's session is closed by the server.** Once a session has a
//!   backend the server pings it every three seconds and closes it when a ping
//!   goes unanswered (`startHeartbeat`), which disposes the CDP connection. That
//!   matters here more than anywhere: Volery ends a card with `TerminateProcess`,
//!   so no client ever says goodbye.
//!
//! **And it ends the CONNECT_TIMEOUT family**, which is the other half of why
//! this is worth doing (sinks 36919493, d5c3b54e, ab552a46, 0e31145a, 6f564b5a,
//! c14409db, cb41f229, 2f25b6b7). Each of those is a card whose stdio server —
//! `npx` resolving a package on a machine with no memory to spare — did not
//! answer `initialize` inside the CLI's thirty seconds, and the CLI does not
//! retry. Connecting to a server that is already up is a loopback round trip.
//!
//! The port is fixed for the reason `browser::DEFAULT_PORT` is: a card's
//! `--mcp-config` is written at spawn and cannot be renegotiated, so the address
//! has to be knowable before anything is listening on it.

use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::servers::jobs;

use crate::browser::{mcp_url as url, MCP_PORT as PORT};

/// Loopback only, like the CDP port it drives. See `browser::mcp_url`.
const HOST: &str = "127.0.0.1";

/// The `@playwright/mcp` this wall runs. See the note in `start` on why it is
/// pinned, and re-run `tools/probe-shared-mcp.ts` before moving it.
const PINNED: &str = "@playwright/mcp@0.0.83";

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
    let addr: SocketAddr = format!("{HOST}:{PORT}").parse().expect("a literal address");
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

/// Start the server if nothing is answering on its port, in the background, and
/// ask every card whose `browser` server failed to connect to try again once it
/// is up. Cheap and idempotent: the common case is one loopback connect.
///
/// **Another wall's server counts.** A lab wall beside the installed one, or a
/// second Volery against the same machine, finds the port taken and uses what
/// is there — it drives the same Chrome on the same fixed port, which is the
/// arrangement `browser.rs` already has for the browser itself.
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
        let result = start(&host);
        host.starting.store(false, Ordering::SeqCst);
        match result {
            Ok(Started::Fresh) => {
                log::info!(target: "volery::mcphost", "shared browser MCP up on {}", url());
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

fn start(host: &Host) -> Result<Started, String> {
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
    let mut cmd = Command::new("cmd");
    /* `npx`, once, for the wall — the wrapper sink 482e25ee measured at 111 MB
       was a per-card cost and is now a per-wall one.

       **Pinned to the version that was probed**, where the stdio entry floated
       on `@latest`. The trade changed with the transport: a stdio server that
       broke cost the cards it broke, but an HTTP server that answers a card 401
       or 403 is remembered by the *name* `browser` in the CLI's machine-wide
       `mcp-needs-auth-cache.json`, and every session on the machine then lists
       it as needing auth without sending a request (`load.md` §1). A release
       that tightened its host checks would take the browser off every card on
       the wall, silently. Moving this is one line and a re-run of
       `tools/probe-shared-mcp.ts`. */
    cmd.args([
        "/C",
        "npx",
        "--yes",
        PINNED,
        "--port",
        &PORT.to_string(),
        "--host",
        HOST,
        /* **Named, or every card is refused with a 403.** The MCP route checks
           `Host` against its own list, which defaults to `localhost:<port>` —
           port and all, after normalising the bind address — so the
           `127.0.0.1:<port>` a card sends is not on it. Measured with the probe:
           the CLI reported the server as `needs-auth` and listed no tools.
           Naming the one host the cards use keeps the guard against a page
           rebinding a name of its own to loopback, which `'*'` would drop. */
        "--allowed-hosts",
        &format!("{HOST}:{PORT}"),
        "--cdp-endpoint",
        &crate::browser::address(),
    ])
    .stdin(Stdio::null())
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
    Err(format!("nothing answered on {} within {}s", url(), READY_TIMEOUT.as_secs()))
}
