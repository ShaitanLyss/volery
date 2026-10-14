//! One copy of a project's stdio MCP server for all of that project's cards.
//!
//! A project's `.mcp.json` is read by the CLI, and each card starts its own copy
//! of every stdio server in it. For most servers that is cheap. RISE's is not:
//! `bun --env-file=apps/backend/.env.local apps/mcp/src/index.ts` was measured at
//! 450–550 MB of private memory per card on 2026-10-14, three cards at once, and
//! every one of them a stateless API client (`rise/apps/mcp/src/index.ts`: "a
//! token, a transport, and a process") that could have served all three.
//!
//! So the wall runs one, and each card is handed an HTTP entry under the same
//! name pointing here: `POST /pool/<card id>/<server name>` on the listener
//! `ask.rs` already serves every card's `mcp__skein__*` from. Its own copy is
//! switched off in the card's settings layer (`disabledMcpjsonServers`), which
//! is the half `tools/probe-mcp-override.ts` exists to prove.
//!
//! **Opt-in, per server, by the user** (Lyss, 2026-10-14). Whether a server is
//! safe to share is a fact about that server Volery cannot read off it: one that
//! keeps per-client state — a selected project, a cursor, an open file — would
//! hand one card's state to another. A territory's right-click lists its stdio
//! servers and each can be shared; nothing is shared by default.
//!
//! What the multiplexer does, which is the whole of the protocol it speaks:
//!
//! - **One upstream per (tree, server)**, spawned on first use with the
//!   `.mcp.json` entry's command, arguments and environment, in the directory the
//!   card's child runs in (`worktree::run_dir`) — which is where the CLI would
//!   have started it, so a relative `--env-file` resolves the same way. A
//!   worktree card gets its own, because a server run from another checkout is
//!   serving different code.
//! - **Initialised once.** The first card's `initialize` is answered from the
//!   upstream's own answer, and every later card's from the same cached result.
//! - **Requests are renumbered.** Each forwarded request gets an id of the
//!   pool's own and its answer is sent back under the id the card used, so two
//!   cards both asking `id: 1` cannot receive each other's answers.
//! - **Stateless on this side.** No `Mcp-Session-Id` is issued; every POST is
//!   answered as plain JSON. The spec allows a server to run without sessions,
//!   and there is no per-card state here to key one on.
//! - **What a stdio server asks the client is refused.** `roots/list`, sampling,
//!   elicitation: there is no single client to ask, so the upstream is told
//!   `method not found`, which every server has to tolerate from a client that
//!   declares no such capability — and the pool declares none.
//! - **An upstream that dies is started again** on the next request, and every
//!   call it was holding is answered with an error naming that it died.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::servers::jobs;

/// Where a card's pooled server is reached on the ask listener.
pub const POOL_PATH: &str = "/pool/";

/// How long a forwarded request may wait for the upstream. Under Bun's 300s
/// fetch clock (`ask.md`, "the third clock is not the CLI's"), so the card gets
/// this module's sentence rather than the client's own "operation timed out".
const CALL_TIMEOUT: Duration = Duration::from_secs(270);

/* ── which servers are shared ─────────────────────────────────────────────── */

/// The user's choices: project root → server names shared there.
///
/// A file beside the database rather than a table, deliberately: it is a
/// handful of names, it is read at spawn and written by one gesture, and a
/// schema rung is the one change this app has learned to be expensive about
/// (`CLAUDE.md`, the migrations a debug build may not carry forward).
fn choices_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("mcp-pool.json"))
}

fn read_choices(app: &AppHandle) -> HashMap<String, Vec<String>> {
    choices_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_choices(app: &AppHandle, choices: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let path = choices_path(app).ok_or("no app data directory")?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(choices).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The key a root is filed under: resolved the way every other root on this
/// wall is (`store::canonical_root`), so a junction cannot file one project
/// twice.
fn root_key(root: &str) -> String {
    crate::store::canonical_root(root)
}

/// A project's stdio servers, as its `.mcp.json` declares them. HTTP and SSE
/// entries are left out: the CLI starts no process for those, so there is
/// nothing to share.
pub fn stdio_servers(root: &Path) -> Map<String, Value> {
    let Some(doc) = std::fs::read_to_string(root.join(".mcp.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return Map::new();
    };
    let Some(servers) = doc.get("mcpServers").and_then(Value::as_object) else {
        return Map::new();
    };
    servers
        .iter()
        .filter(|(_, v)| is_stdio(v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// A `.mcp.json` entry the CLI would start as a process.
pub fn is_stdio(entry: &Value) -> bool {
    let kind = entry.get("type").and_then(Value::as_str).unwrap_or("stdio");
    kind == "stdio" && entry.get("command").and_then(Value::as_str).is_some()
}

/// Which of a project's stdio servers its cards share, intersected with what
/// its `.mcp.json` still declares — a choice about a server that has since been
/// removed from the file shares nothing.
pub fn shared_for(app: &AppHandle, project_root: &str) -> Vec<String> {
    let chosen = read_choices(app).remove(&root_key(project_root)).unwrap_or_default();
    let declared = stdio_servers(Path::new(project_root));
    chosen.into_iter().filter(|n| declared.contains_key(n)).collect()
}

#[derive(serde::Serialize)]
pub struct Candidate {
    name: String,
    command: String,
    shared: bool,
}

/// The territory menu's list: every stdio server in the project's `.mcp.json`
/// and whether it is shared.
#[tauri::command]
pub async fn pool_candidates(app: AppHandle, root: String) -> Result<Vec<Candidate>, String> {
    crate::off_main(move || {
        let shared = shared_for(&app, &root);
        Ok(stdio_servers(Path::new(&root))
            .into_iter()
            .map(|(name, v)| Candidate {
                shared: shared.contains(&name),
                command: std::iter::once(v.get("command").and_then(Value::as_str).unwrap_or(""))
                    .chain(
                        v.get("args")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str),
                    )
                    .collect::<Vec<_>>()
                    .join(" "),
                name,
            })
            .collect())
    })
    .await?
}

/// Share a server across a project's cards, or stop. Takes effect at each
/// card's next spawn — a live card's MCP servers were settled when it started,
/// and that is the CLI's, not this app's, to renegotiate.
#[tauri::command]
pub async fn set_pool_shared(
    app: AppHandle,
    root: String,
    name: String,
    shared: bool,
) -> Result<(), String> {
    crate::off_main(move || {
        let mut choices = read_choices(&app);
        let names = choices.entry(root_key(&root)).or_default();
        names.retain(|n| n != &name);
        if shared {
            names.push(name.clone());
        }
        choices.retain(|_, v| !v.is_empty());
        write_choices(&app, &choices)?;
        Ok(())
    })
    .await?
}

/// The `--mcp-config` entry for a pooled server on a card.
pub fn entry(ask_port: u16, card: &str, name: &str) -> Value {
    json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{ask_port}{POOL_PATH}{card}/{}", encode(name)),
    })
}

/// Server names are the user's and may hold anything; the URL carries them
/// percent-encoded so a name with a slash in it is still one path segment.
fn encode(name: &str) -> String {
    let mut out = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(seg: &str) -> String {
    let bytes = seg.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ── the upstream ─────────────────────────────────────────────────────────── */

type Waiters = Arc<Mutex<HashMap<u64, Sender<Value>>>>;

/// Lines for the upstream's stdin, written by a thread of its own.
///
/// A channel rather than a locked pipe, and an adversarial review is why: the
/// reader answers a server's own requests (`refusal`) on the same pipe the
/// callers write to, and with a lock between them a writer blocked on a full
/// pipe held the lock the reader needed, while the server — blocked writing
/// its stdout to a reader that had stopped reading — never drained its stdin.
/// Three parties each waiting on the next. With a writer thread nobody who
/// reads ever waits on a write.
type Lines = Sender<String>;

/// One running shared server.
///
/// **No lock is held across a call**, and that is the shape of the whole
/// struct. The first cut kept the upstream behind one mutex held for the
/// length of a forwarded request — up to `CALL_TIMEOUT` — and `upstream()`
/// took that mutex while holding the pool's map, so one slow call on one
/// server would have stalled every pooled request on the wall and the load
/// census behind it. Now a line goes down a channel, the child is locked for
/// one `try_wait`, and the waiters for one insert. Calls from several cards
/// interleave on the pipe and are told apart by id.
struct Upstream {
    child: Mutex<Child>,
    lines: Lines,
    waiters: Waiters,
    /// The upstream's own answer to `initialize`, made once, before this was
    /// put where anyone could reach it.
    init: Value,
    /// Behind its own lock only because a job is a raw handle, which is `Send`
    /// and not `Sync`; it is read for the census and nothing else.
    job: Mutex<Option<jobs::Job>>,
}

/// One server's place in the pool. Locked while that server is being started,
/// so a second card arriving at the same moment waits for the first's start
/// rather than making a second copy — and **only** that server's cards wait.
/// The first cut held the pool's whole map across a start, so one slow server
/// stalled every pooled request on the wall and the census beside them.
type Slot = Arc<Mutex<Option<Arc<Upstream>>>>;

/// Every pooled server running on this wall, keyed `(run dir, name)`.
#[derive(Default)]
pub struct Pool {
    up: Mutex<HashMap<(String, String), Slot>>,
    next: AtomicU64,
}

impl Pool {
    fn slot(&self, key: (String, String)) -> Result<Slot, String> {
        let mut map = self.up.lock().map_err(|_| "pool state poisoned")?;
        Ok(map.entry(key).or_default().clone())
    }

    /// Every pooled server's processes, pid → server name, for `load.rs`'s
    /// census. The job's list where there is one, so a server that spawns
    /// helpers is weighed whole. A slot being started right now is skipped
    /// (`try_lock`) rather than waited on: a census must not wait out a start.
    pub fn pids(&self) -> HashMap<u32, String> {
        let slots: Vec<(String, Slot)> = match self.up.lock() {
            Ok(map) => map.iter().map(|((_, n), s)| (n.clone(), s.clone())).collect(),
            Err(_) => return HashMap::new(),
        };
        let mut out = HashMap::new();
        for (name, slot) in slots {
            let Ok(guard) = slot.try_lock() else { continue };
            let Some(u) = guard.as_ref() else { continue };
            let mut pids = u
                .job
                .lock()
                .ok()
                .and_then(|j| j.as_ref().map(|j| j.pids()))
                .unwrap_or_default();
            if pids.is_empty() {
                if let Ok(c) = u.child.lock() {
                    pids.push(c.id());
                }
            }
            for pid in pids {
                out.insert(pid, name.clone());
            }
        }
        out
    }
}

/// The last handle to a server going away ends it. Its job would anyway at the
/// app's exit; this is the same thing done when it stops being wanted.
impl Drop for Upstream {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
        }
    }
}

/// Expand `${VAR}` and `${VAR:-default}` the way the CLI does in a `.mcp.json`
/// entry. Pure. Read from Volery's own environment, which for a card is the
/// environment it inherited plus what `spawn_now` sets — so a variable a card
/// was *lent* (`lend.rs`) is not seen here, and a server that needs one should
/// not be shared.
pub fn expand(s: &str, env: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let Some(end) = rest[at..].find('}') else {
            out.push_str(&rest[at..]);
            return out;
        };
        let inner = &rest[at + 2..at + end];
        let (name, default) = match inner.split_once(":-") {
            Some((n, d)) => (n, Some(d)),
            None => (inner, None),
        };
        out.push_str(&env(name).or(default.map(str::to_string)).unwrap_or_default());
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

/// One word for `cmd /S /C "…"`, quoted so cmd reads it as one argument and
/// leaves `&`, `|`, `<`, `>`, `^` and `(` alone — a URL with a query string in
/// an `npx` server's arguments would otherwise be split into two commands.
/// Pure. `%VAR%` is still cmd's to expand inside quotes, and there is no
/// quoting that stops it; that is said where the fallback is used.
pub fn cmd_word(w: &str) -> String {
    format!("\"{}\"", w.replace('"', "\"\""))
}

/// A started process, not yet initialised.
struct Spawned {
    child: Child,
    lines: Lines,
    waiters: Waiters,
    job: Option<jobs::Job>,
}

fn spawn_upstream(dir: &str, spec: &Value) -> Result<Spawned, String> {
    let env = |k: &str| std::env::var(k).ok();
    let command = expand(spec.get("command").and_then(Value::as_str).unwrap_or(""), env);
    let args: Vec<String> = spec
        .get("args")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|a| expand(a, env))
        .collect();
    let prepare = |mut cmd: Command| {
        cmd.current_dir(dir);
        if let Some(vars) = spec.get("env").and_then(Value::as_object) {
            for (k, v) in vars {
                if let Some(v) = v.as_str() {
                    cmd.env(k, expand(v, env));
                }
            }
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd
    };
    let direct = || {
        let mut c = Command::new(&command);
        c.args(&args);
        prepare(c).spawn()
    };
    /* `bun` is an `.exe` and `npx` is a `.cmd`, and `CreateProcess` finds only
       the first by bare name — so a name it cannot find is tried again through
       `cmd`, which resolves a shim the way the CLI's own spawn does. `/S` with
       the whole line in one pair of quotes, each word quoted inside it, so cmd
       strips exactly the outer pair and treats every word literally — bar
       `%VAR%`, which nothing can stop cmd expanding. */
    let via_cmd = || {
        let mut c = Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let line = std::iter::once(command.as_str())
                .chain(args.iter().map(String::as_str))
                .map(cmd_word)
                .collect::<Vec<_>>()
                .join(" ");
            c.raw_arg(format!("/S /C \"{line}\""));
        }
        #[cfg(not(windows))]
        c.arg("-c").arg(&command).args(&args);
        prepare(c).spawn()
    };
    let mut child = match direct() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            via_cmd().map_err(|e| format!("could not start {command}: {e}"))?
        }
        Err(e) => return Err(format!("could not start {command}: {e}")),
    };
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
    if let Some(err) = child.stderr.take() {
        let label = command.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log::info!(target: "volery::pool", "{label}: {line}");
            }
        });
    }
    let lines = writer(stdin);
    reader(stdout, waiters.clone(), lines.clone());
    Ok(Spawned { child, lines, waiters, job })
}

/// The only thing that writes to the upstream's stdin. Ends when the pipe
/// breaks or every sender is gone.
fn writer(mut stdin: ChildStdin) -> Lines {
    let (tx, rx) = channel::<String>();
    std::thread::spawn(move || {
        for line in rx {
            if writeln!(stdin, "{line}").and_then(|()| stdin.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

/// What the pool answers a server that asks *it* something. Every client may
/// refuse a request it has not declared the capability for, so a server has
/// to survive this — where it would not survive silence: a server waiting on
/// an answer that never comes waits for ever, holding the call that asked.
fn refusal(id: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message":
        "Volery's MCP pool serves several cards through one connection and answers no requests from the server" } })
}

/// Read the upstream's stdout: answers go to whoever is waiting on their id;
/// requests *from* the server are refused (see `refusal`); notifications are
/// dropped, since there is no one client to hand them to.
fn reader(stdout: std::process::ChildStdout, waiters: Waiters, lines: Lines) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            let is_request = msg.get("method").is_some();
            match (msg.get("id"), is_request) {
                (Some(id), true) => {
                    let _ = lines.send(refusal(id).to_string());
                }
                (Some(id), false) => {
                    let id = id.as_u64();
                    if let Some(tx) = id.and_then(|id| waiters.lock().ok().and_then(|mut w| w.remove(&id))) {
                        let _ = tx.send(msg);
                    }
                }
                _ => {}
            }
        }
        /* The upstream is gone. Everybody still waiting is told so now rather
           than left to time out. */
        if let Ok(mut w) = waiters.lock() {
            for (_, tx) in w.drain() {
                let _ = tx.send(json!({ "error": { "code": -32000, "message":
                    "the shared MCP server exited while this call was in flight; Volery will start it again on the next call" } }));
            }
        }
    });
}

/// Send one request and wait for its answer under the pool's own id.
fn request(
    lines: &Lines,
    waiters: &Waiters,
    pool: &Pool,
    method: &str,
    params: Value,
    within: Duration,
) -> Result<Value, String> {
    let id = pool.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = channel();
    waiters.lock().map_err(|_| "poisoned")?.insert(id, tx);
    let forget = || {
        if let Ok(mut w) = waiters.lock() {
            w.remove(&id);
        }
    };
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    if lines.send(line.to_string()).is_err() {
        forget();
        return Err("the shared server's input is closed — it has exited".into());
    }
    rx.recv_timeout(within).map_err(|_| {
        forget();
        format!("the shared server did not answer within {}s", within.as_secs())
    })
}

/// How long a server may take to answer `initialize`. Under the CLI's own
/// thirty-second MCP connect deadline, so a card is answered by this module —
/// and told why — rather than abandoning the connect and marking the server
/// failed for its whole session.
const INIT_TIMEOUT: Duration = Duration::from_secs(20);

impl Upstream {
    fn alive(&self) -> bool {
        self.child.lock().map(|mut c| matches!(c.try_wait(), Ok(None))).unwrap_or(false)
    }
}

/* ── the HTTP side ────────────────────────────────────────────────────────── */

/// Answer one POST to `/pool/<card>/<name>`. Returns the HTTP status and the
/// body (empty for a notification, which is `202 Accepted`).
///
/// **Never 401 or 403**, whatever goes wrong: the CLI remembers either by
/// server *name* in a machine-wide cache and stops asking (`load.md` §1). A
/// failure is a JSON-RPC error inside a 200, which a card reads and recovers
/// from.
pub fn handle(app: &AppHandle, url: &str, body: &str) -> (u16, String) {
    let path = url.split('?').next().unwrap_or(url);
    let rest = path.strip_prefix(POOL_PATH).unwrap_or("");
    let mut parts = rest.splitn(2, '/');
    let (Some(card), Some(name)) = (parts.next(), parts.next()) else {
        return (404, String::new());
    };
    let name = decode(name.trim_end_matches('/'));
    let Ok(rpc) = serde_json::from_str::<Value>(body) else {
        return (400, String::new());
    };
    let id = rpc.get("id").cloned();
    let method = rpc.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = rpc.get("params").cloned().unwrap_or(json!({}));

    /* A notification from the card is acknowledged and goes no further.
       `initialized` was already sent when the pool initialised the upstream,
       and a second is a protocol error. `cancelled` names the request by the
       *card's* id, which the upstream never saw — forwarded, it would cancel
       whichever request of another card's happens to hold that pool id. The
       rest (`roots/list_changed`) describe one client to a server that is
       serving several. A cancelled call simply runs to the end and its answer
       goes nowhere, which costs the server one call. */
    let Some(id) = id else {
        let _ = params;
        return (202, String::new());
    };

    let reply = |result: Result<Value, String>| -> (u16, String) {
        let msg = match result {
            Ok(answer) => {
                let mut answer = answer;
                if let Some(obj) = answer.as_object_mut() {
                    obj.insert("id".into(), id.clone());
                    obj.insert("jsonrpc".into(), json!("2.0"));
                }
                answer
            }
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": e } }),
        };
        (200, msg.to_string())
    };

    let up = match upstream(app, card, &name) {
        Ok(u) => u,
        Err(e) => return reply(Err(e)),
    };
    if method == "initialize" {
        /* Answered from the upstream's own answer to the pool, which was made
           once. Its protocol version is the one the upstream speaks, and the
           client either speaks it too or says so. */
        return reply(Ok(up.init.clone()));
    }
    if method == "ping" {
        return reply(Ok(json!({ "result": {} })));
    }
    let pool = app.state::<Pool>();
    let pool = pool.inner();
    reply(request(&up.lines, &up.waiters, pool, &method, params, CALL_TIMEOUT))
}

/// The upstream a card's request goes to, started and initialised if it is not
/// running.
///
/// **Whether the server is shared is not asked here.** It was decided when the
/// card spawned — that is the only reason the card has this URL at all — and
/// asking again turned an unshare into a card whose own `.mcp.json` copy is
/// switched off and whose pooled one now refuses it, with no working copy until
/// it respawns. An unshare takes effect at each card's next spawn, which is what
/// the menu says.
fn upstream(app: &AppHandle, card: &str, name: &str) -> Result<Arc<Upstream>, String> {
    let (root, dir) = {
        let store = app.state::<crate::store::Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged")?;
        let root = crate::store::cwd_of(&conn, card).ok_or("no such card on this wall")?;
        let (dir, _) = crate::store::session_of(&conn, card).ok_or("no such card on this wall")?;
        (root, dir)
    };

    let pool = app.state::<Pool>();
    let pool = pool.inner();
    let slot = pool.slot((crate::store::canonical_root(&dir), name.to_string()))?;
    let mut guard = slot.lock().map_err(|_| "pool state poisoned")?;
    if let Some(existing) = guard.as_ref() {
        if existing.alive() {
            return Ok(existing.clone());
        }
        *guard = None;
    }
    /* The project's `.mcp.json` is read only when a server has to be started,
       never on an ordinary request — an agent caught mid-save would otherwise
       hand every card an empty file and an error. */
    let spec = stdio_servers(Path::new(&root))
        .remove(name)
        .ok_or_else(|| format!("{name} is not in this project's .mcp.json any more"))?;
    let fresh = spawn_upstream(&dir, &spec)?;
    let init = request(
        &fresh.lines,
        &fresh.waiters,
        pool,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "volery-pool", "version": env!("CARGO_PKG_VERSION") },
        }),
        INIT_TIMEOUT,
    );
    /* A server that will not initialise is ended here rather than left to the
       app's exit: nothing else holds it, and the next request starts afresh. */
    let init = match init {
        Ok(v) if v.get("error").is_none() => v,
        Ok(v) => {
            let mut c = fresh.child;
            let _ = c.kill();
            return Err(format!("{name} refused to initialise: {}", v["error"]));
        }
        Err(e) => {
            let mut c = fresh.child;
            let _ = c.kill();
            return Err(e);
        }
    };
    let _ = fresh.lines.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string());
    log::info!(target: "volery::pool", "started shared {name} in {dir}");
    let up = Arc::new(Upstream {
        child: Mutex::new(fresh.child),
        lines: fresh.lines,
        waiters: fresh.waiters,
        init: json!({ "result": init.get("result").cloned().unwrap_or(json!({})) }),
        job: Mutex::new(fresh.job),
    });
    *guard = Some(up.clone());
    Ok(up)
}

/// The pooled servers this card was spawned with, for the supervisor's
/// reconnect when one reports `failed` at init.
pub fn pooled_for_card(app: &AppHandle, card: &str) -> Vec<String> {
    let root = {
        let store = app.state::<crate::store::Store>();
        let Ok(conn) = store.0.lock() else { return Vec::new() };
        crate::store::cwd_of(&conn, card)
    };
    root.map(|r| shared_for(app, &r)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variables_expand_the_way_the_cli_expands_them() {
        let env = |k: &str| (k == "HOME").then(|| "C:/u".to_string());
        assert_eq!(expand("${HOME}/x", env), "C:/u/x");
        assert_eq!(expand("${NOPE:-fallback}", env), "fallback");
        assert_eq!(expand("${NOPE}", env), "");
        assert_eq!(expand("plain --flag", env), "plain --flag");
        assert_eq!(expand("unclosed ${HOME", env), "unclosed ${HOME");
    }

    #[test]
    fn only_entries_the_cli_would_start_a_process_for_are_poolable() {
        assert!(is_stdio(&json!({ "command": "bun", "args": ["x.ts"] })));
        assert!(is_stdio(&json!({ "type": "stdio", "command": "npx" })));
        assert!(!is_stdio(&json!({ "type": "http", "url": "https://docs.uniwind.dev/mcp" })));
        assert!(!is_stdio(&json!({ "type": "sse", "url": "x" })));
        assert!(!is_stdio(&json!({ "args": ["no command"] })));
    }

    /// A shared server's own `.mcp.json` copy is switched off in the card's
    /// settings layer, and nothing is switched off for a card that shares
    /// nothing — an empty `disabledMcpjsonServers` would still be a key the
    /// CLI reads, and the settings every card already had must not change.
    #[test]
    fn a_shared_server_is_switched_off_in_the_card_s_settings() {
        let on: Value =
            serde_json::from_str(&crate::hooks::settings(false, None, false, 0, &["RISE".into()]))
                .unwrap();
        assert_eq!(on["disabledMcpjsonServers"], json!(["RISE"]));
        let off: Value =
            serde_json::from_str(&crate::hooks::settings(false, None, false, 0, &[])).unwrap();
        assert!(off.get("disabledMcpjsonServers").is_none(), "{off}");
    }

    #[test]
    fn a_card_reaches_its_pooled_server_on_the_ask_listener() {
        let e = entry(51234, "card-1", "RISE");
        assert_eq!(e["type"], "http");
        assert_eq!(e["url"], "http://127.0.0.1:51234/pool/card-1/RISE");
    }

    /// Every word reaches cmd quoted, so a URL with a query string stays one
    /// argument instead of becoming `…?a=1` and a second command `b=2`.
    #[test]
    fn a_word_with_shell_characters_stays_one_word_under_cmd() {
        assert_eq!(cmd_word("npx"), "\"npx\"");
        assert_eq!(cmd_word("https://x/?a=1&b=2"), "\"https://x/?a=1&b=2\"");
        assert_eq!(cmd_word("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    /// A server name rides in one path segment, whatever it holds.
    #[test]
    fn a_name_survives_the_url() {
        for name in ["RISE", "my server", "a/b", "ünï"] {
            assert_eq!(decode(&encode(name)), name);
            assert!(!encode(name).contains('/'));
        }
    }
}
