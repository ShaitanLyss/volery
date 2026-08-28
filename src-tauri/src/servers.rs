//! Dev server groups — the part that retires the three PowerShells.
//!
//! The hard problem here is not starting things, it is stopping them. A dev
//! server is `npm run dev` spawning node spawning esbuild; killing the process
//! you spawned leaves the grandchildren alive, still holding port 5173, and the
//! next start fails for reasons that look nothing like the cause.
//!
//! So every server goes into a Windows job object with KILL_ON_JOB_CLOSE.
//! Dropping the handle takes the whole tree down, including anything it
//! spawned after we stopped looking.
//!
//! **These run through pipes, not a PTY, and that was a retreat.** A dev
//! server's output genuinely *is* a terminal — colour, carriage returns,
//! progress lines — so this was the one place in Skein where a pseudo-terminal
//! earned its weight, and it was the last holdout after `actions.rs` and
//! `shell.rs` had each given theirs up. It gave its up for the same reason:
//! every `openpty`-spawned child on this machine dies at `0xC0000142` before
//! running a line of its own code, so the PTY route started exactly nothing.
//! `.claude/rules/servers.md` has the evidence and what is still unresolved
//! about the cause.
//!
//! What the retreat costs is smaller than it looks, because two of the PTY's
//! three benefits were never wired up here:
//!
//! - **Colour is kept**, by asking for it rather than by being a terminal —
//!   `force_colour` below, and `ansi.ts` was already renderer-agnostic.
//! - **Redraws are kept**: `pump_lines` splits on `\r` whatever it is reading.
//!   What is lost is the *program's* willingness to emit them, since vite and
//!   cargo ask `isatty` before drawing a spinner. Discrete output — HMR
//!   updates, request logs, compiler errors — is unaffected.
//! - **Typing into a server** is lost on paper and not in fact: `PtyServer`
//!   kept no writer and did not even store the master, so there was no input
//!   path to lose. vite's `r`/`u`/`o` shortcuts never worked here.
//!
//! What is *gained*, beyond the feature running at all: both streams arrive
//! separately, so `ServerLog.stderr` stopped being hardcoded `false`; a server
//! that dies now says so, which the merged PTY reader could not tell us; and
//! `CREATE_NO_WINDOW` is set, which the ConPTY path never passed.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::{ServerGroup, ServerSpec};

/* ── Windows job objects ──────────────────────────────────────────────── */

#[cfg(windows)]
pub(crate) mod jobs {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, JobObjectBasicProcessIdList,
        JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_PROCESS_ID_LIST,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Dropping this kills every process assigned to it, and everything they
    /// spawned. That is the entire point.
    pub struct Job(HANDLE);

    // The handle is only ever touched through this type, and only closed once.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;
                Some(Job(h))
            }
        }

        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let Ok(p) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else {
                    return false;
                };
                let ok = AssignProcessToJobObject(self.0, p).is_ok();
                let _ = CloseHandle(p);
                ok
            }
        }

        /// Every process currently in this job.
        ///
        /// This is the definitive answer to "what does this card own", and it
        /// is worth asking the kernel rather than walking parent pointers.
        /// `perf.rs::ancestry` climbs the parent chain until it recognises
        /// somebody, which is a decent guess and exactly a guess: it goes blind
        /// the moment an *intermediate* parent exits, because the chain from
        /// the survivor upward now points at a pid that is gone. Those are
        /// precisely the processes worth finding — a leaked one is by
        /// definition one whose parent went away — so the instrument was blind
        /// in exactly the place it needed to see.
        ///
        /// A job has no such gap. Membership is set once at assignment,
        /// inherited by everything spawned afterwards, and unaffected by
        /// anything in between dying. It is also the only *proof* available:
        /// a parentless `bun.exe` on this machine is unattributable by
        /// inspection, and the rule that a `claude.exe` Skein did not spawn is
        /// somebody's terminal cuts the same way for killing as for labelling.
        /// Being in our job is how a process is known to be ours to end.
        pub fn pids(&self) -> Vec<u32> {
            unsafe {
                let mut cap = 64usize;
                for _ in 0..5 {
                    /* The struct carries the first id inline, hence `cap - 1`
                       extra slots rather than `cap`. */
                    let bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                        + cap.saturating_sub(1) * std::mem::size_of::<usize>();
                    let mut buf = vec![0u8; bytes];
                    let ok = QueryInformationJobObject(
                        Some(self.0),
                        JobObjectBasicProcessIdList,
                        buf.as_mut_ptr() as *mut core::ffi::c_void,
                        bytes as u32,
                        None,
                    )
                    .is_ok();
                    let head = &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST);
                    /* Too small a buffer fails with ERROR_MORE_DATA having
                       still written the counts, so the retry can be sized
                       rather than doubled — but it is doubled anyway when the
                       count is not to be trusted, or a job that grew between
                       the two calls would spin. */
                    if !ok {
                        let want = head.NumberOfAssignedProcesses as usize;
                        cap = if want > cap { want + 16 } else { cap * 2 };
                        continue;
                    }
                    let n = head.NumberOfProcessIdsInList as usize;
                    let list = head.ProcessIdList.as_ptr();
                    return (0..n).map(|i| *list.add(i) as u32).collect();
                }
                Vec::new()
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
pub(crate) mod jobs {
    pub struct Job;
    impl Job {
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn assign(&self, _pid: u32) -> bool {
            true
        }
        pub fn pids(&self) -> Vec<u32> {
            Vec::new()
        }
    }
}

/* ── runtime state ────────────────────────────────────────────────────── */

/// A dev server and the tree underneath it.
///
/// The job object is what actually owns that tree; `child` is kept for the kill
/// off Windows, where `Job` is a stub, and to reap the handle on the way out.
struct PipeServer {
    child: Child,
    _job: Option<jobs::Job>,
    /// Set before any deliberate kill, and read by `exit_if_last`.
    ///
    /// Without it a *restart* reports the death it caused: `start_group` kills
    /// the old tree, whose pipes then close and emit `exited` for that label —
    /// arriving after the replacement has already said `starting`, so a server
    /// that came up fine reads as one that died. A stop we asked for is not news
    /// about the server. The same flag `bang.rs` keeps, for the same reason.
    stopped: Arc<AtomicBool>,
}

struct RunningGroup {
    servers: Vec<PipeServer>,
    /// Whether the health poll started with this group still speaks for it.
    ///
    /// The poll at the end of `start` is a detached thread that lives for
    /// twenty seconds and held nothing but a clone of the spec list, so it
    /// outlived the group it was started for. Stop a group inside those twenty
    /// seconds and the loop ran on; if anything else on this machine then bound
    /// the same port — a second Volery, a `pnpm dev` in a terminal, an
    /// unrelated service — it reported `up` for a server this wall had stopped.
    /// The front end clears health on stop and would have had it set straight
    /// back, which is the file's own "a group down for a reason must not look
    /// like a group that failed" rule running in reverse: one that failed
    /// looking like one that is fine. Restart inside the window and there were
    /// two polls, the old one answering about the new one's ports.
    ///
    /// A flag rather than a generation number, and it lives *here* rather than
    /// in a map beside the group, so the poll's licence to speak is the same
    /// object as the group's existence. Both removal paths — `start`'s restart
    /// block and `stop` — already hold the old `RunningGroup` when they take it
    /// out of the map, so clearing it is one line each and cannot be reached
    /// without one of them running. There is no third place that removes.
    polling: Arc<AtomicBool>,
}

/// Private fields: the running map is only ever touched from this module, and
/// exposing it would leak the private `RunningGroup` type.
///
/// **Two locks rather than one, and they must stay two.** `running` is held
/// across a kill and a `wait`; `trace` is taken once per line of output, which
/// on a `pnpm dev` that has just recompiled is a burst of hundreds. One mutex
/// would put that burst behind whatever `start_group` is doing to a process
/// tree, on the pump threads, which is the shape that ends with a reader thread
/// parked and a card's log arriving in a lump after the fact.
#[derive(Default)]
pub struct Servers {
    running: Mutex<HashMap<String, RunningGroup>>,
    /// What each group has said and what each of its servers was last reported
    /// as. `Arc` because a pump thread outlives the call that made it and holds
    /// this directly — the alternative is `app.state::<Servers>()` per line,
    /// which is a `TypeId` lookup on the hottest path in this file.
    trace: Traces,
}

#[derive(Clone, Serialize)]
struct ServerLog {
    group_id: String,
    label: String,
    line: String,
    stderr: bool,
}

/* ── what a group has said ────────────────────────────────────────────────
 *
 * Until an agent could ask, nothing in Rust kept a line: `server:log` went out
 * as it was pumped and `GroupRuntime.log` in the front end was the only copy on
 * the machine. That was the right arrangement while the wall was the only
 * reader — a second copy of something already in a rune would have been a cache
 * to keep in step — and it stops being right the moment `mcp__skein__server_log`
 * exists, because a card asking what vite said cannot reach into the front
 * end's state and must not be answered by round-tripping through the window.
 *
 * So the pump writes twice, and the second write is bounded three ways rather
 * than one. See `.claude/rules/servers.md`.
 */

/// One line a server printed, as the ring keeps it.
#[derive(Clone)]
struct Said {
    label: String,
    line: String,
    stderr: bool,
    at: i64,
}

/// How many lines a group keeps for an agent to read back.
///
/// Deliberately more than the front end's `MAX_LOG` (400), because the two are
/// answering different questions. The widget draws what fits on the wall and a
/// tail is all it can ever use; a card asks *after* something went wrong, often
/// about a compile that scrolled past minutes ago, and the useful answer is
/// further back than the useful drawing.
const KEEP_LINES: usize = 2_000;

/// And the same bound stated in the unit that actually runs away.
///
/// `MAX_LINE` caps one line at 8 KB, so lines alone would let a group sit on
/// 16 MB — which is not a leak, it is a bound nobody would have chosen. A
/// webpack stack trace or a minified line in a source map is exactly the shape
/// that reaches the ceiling, and it reaches it having said very little. Half a
/// megabyte is a few thousand ordinary lines and a few dozen pathological ones,
/// and whichever cap bites first is the honest one.
const KEEP_BYTES: usize = 512 * 1024;

/// What one group has said, and what its servers were last reported as.
#[derive(Default)]
struct Trace {
    lines: VecDeque<Said>,
    /// Kept alongside rather than summed on eviction: `KEEP_BYTES` is checked
    /// on every line, and walking the deque to total it would make an append
    /// O(n) on the hottest path in the file.
    bytes: usize,
    /// How many have fallen off the front. The count is the point — an answer
    /// that silently began in the middle reads as the whole log, and a card
    /// would conclude a server never printed something it printed twice.
    dropped: usize,
    /// The last `server:state` word per server label, recorded where it is
    /// emitted rather than asked for again. Health has only ever existed as a
    /// fold in the front end (`GroupRuntime.health`), so without this a tool
    /// could say a group was running and not whether anything had come up.
    health: HashMap<String, String>,
}

type Traces = Arc<Mutex<HashMap<String, Trace>>>;

impl Trace {
    /// Append, then evict from the front until both bounds hold.
    fn push(&mut self, said: Said) {
        self.bytes += said.line.len();
        self.lines.push_back(said);
        while self.lines.len() > KEEP_LINES || self.bytes > KEEP_BYTES {
            /* `while` rather than `if`, and both bounds in the one condition:
               a single 8 KB line can put `bytes` over on its own, and one that
               arrives after the deque is already full needs two evictions. */
            let Some(gone) = self.lines.pop_front() else { break };
            self.bytes = self.bytes.saturating_sub(gone.line.len());
            self.dropped += 1;
        }
    }
}

#[derive(Clone, Serialize)]
struct ServerState {
    group_id: String,
    label: String,
    /// "starting" | "up" | "down" | "exited"
    state: String,
    code: Option<i32>,
}

/// Whether the wall has asked for this group at all — a different question from
/// any one server's health. See `say_running`.
#[derive(Clone, Serialize)]
struct GroupState {
    group_id: String,
    running: bool,
}

/// Blocking for up to 180ms, so **only ever from a thread that is not the main
/// one** — the health poll below spawns for this, and anything else that wants
/// it owes the same. There was a `probe_ports` command here that answered a
/// list of ports for the front end ("port 5173 is taken", surfaced before a
/// start); it was removed 2026-08-23 having never had a caller, because sync
/// and sequential it would have parked the thread that paints every card for
/// 180ms per port on whatever gesture finally wired it up. If the reading is
/// wanted, it comes back `async` over `crate::off_main` with the probes run
/// concurrently rather than one after another — a group's four ports are one
/// timeout's wait, not four.
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(180),
    )
    .is_ok()
}

/// Say what a server is doing, to the wall and to the record, in one call.
///
/// Every `server:state` goes through here, and that is the whole point of it
/// being a function: health is a fold the front end has always done for itself,
/// so a tool that wanted to read it back had the choice of asking the window
/// (which is backwards) or of recording it at each of the four emit sites
/// (which is four places to forget). Emitting and recording are one act because
/// a state the wall was told and the record was not is precisely the lie a
/// reading tool would then repeat.
fn say_state(app: &AppHandle, trace: &Traces, group_id: &str, label: &str, state: &str) {
    if let Ok(mut map) = trace.lock() {
        map.entry(group_id.to_string())
            .or_default()
            .health
            .insert(label.to_string(), state.to_string());
    }
    let _ = app.emit(
        "server:state",
        ServerState {
            group_id: group_id.to_string(),
            label: label.to_string(),
            state: state.to_string(),
            code: None,
        },
    );
}

/// Say a line, to the wall and to the record, in one call.
///
/// The pump has its own copy of this inlined — it holds the `Traces` directly
/// rather than reaching for them per line, which is the point of cloning the
/// `Arc` into the thread — so this is for the handful of lines Skein itself
/// puts on a server's log rather than the ones a server printed. There are few
/// of them and they are the ones most worth having in the record: "the system
/// cannot find the file specified" is usually the whole answer to why a group
/// will not come up.
fn say_line(app: &AppHandle, trace: &Traces, group_id: &str, label: &str, line: String, err: bool) {
    if let Ok(mut map) = trace.lock() {
        map.entry(group_id.to_string()).or_default().push(Said {
            label: label.to_string(),
            line: line.clone(),
            stderr: err,
            at: crate::store::now(),
        });
    }
    let _ = app.emit(
        "server:log",
        ServerLog {
            group_id: group_id.to_string(),
            label: label.to_string(),
            line,
            stderr: err,
        },
    );
}

/// Whether the wall has this group started, to the wall and to nobody else.
///
/// `GroupRuntime.running` is set optimistically by the front end's own
/// `startGroup`/`stopGroup`, which was complete while the wall was the only
/// thing that could start a group — and `mcp__skein__server` is the second
/// thing. Without this the flag says "not started" over a group an agent
/// brought up, and `standing()` in `serverlog.ts` draws a start button on it.
///
/// Deliberately not folded into `server:state`. That answers which *server* is
/// up; this answers whether anybody has asked for the *group* at all, and the
/// two genuinely differ — a crashed group is `running: true` with an `exited`
/// health on purpose, which is the reading the whole of `standing` is built on.
fn say_running(app: &AppHandle, group_id: &str, running: bool) {
    let _ = app.emit(
        "server:running",
        GroupState {
            group_id: group_id.to_string(),
            running,
        },
    );
}

/// A line this long is a program that has lost the plot. Flush it rather than
/// grow a buffer without bound waiting for a terminator that may never come.
const MAX_LINE: usize = 8 * 1024;

/// Feed a PTY's output to `emit`, one display line at a time.
///
/// Deliberately not `BufReader::lines()`. That waits for `\n`, and a terminal
/// program's most interesting output often hasn't got one: vite, cargo and npm
/// redraw a progress line by returning to the start of it with a bare `\r`.
/// Waiting for a newline holds the whole build back and then dumps it in one
/// go — which is exactly the flat piped output the PTY is here to avoid.
///
/// So both terminators end a line, and the two consequences of that are handled
/// rather than left to surprise us: a `\r\n` pair must not also emit an empty
/// line, and neither must a bare `\r` redraw. A blank line from a real `\n` is
/// kept, because vertical space is real information in build output — it is what
/// separates vite's banner from its warnings.
///
/// Bytes are accumulated and decoded per line, so a multi-byte character split
/// across two reads survives, and invalid UTF-8 degrades to a replacement
/// character instead of killing the pump.
///
/// Returns when the stream ends. A read error counts as ended: on Windows the
/// PTY master reports the child's exit that way rather than as a clean EOF.
pub(crate) fn pump_lines<R: Read>(reader: &mut R, mut emit: impl FnMut(String)) {
    /// Decode what has accumulated and reset the buffer for the next line.
    fn take_line(line: &mut Vec<u8>) -> String {
        let text = String::from_utf8_lossy(line).into_owned();
        line.clear();
        text
    }

    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    /* Whether the byte just seen was a `\r`, so the `\n` completing a CRLF can
       be recognised as punctuation rather than as another line. */
    let mut after_cr = false;

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            match byte {
                b'\r' => {
                    /* A redraw of an empty line is not a line. */
                    if !line.is_empty() {
                        emit(take_line(&mut line));
                    }
                    after_cr = true;
                }
                /* The `\n` of a `\r\n`: that line has already gone out. */
                b'\n' if after_cr => after_cr = false,
                b'\n' => emit(take_line(&mut line)),
                _ => {
                    after_cr = false;
                    line.push(byte);
                    if line.len() >= MAX_LINE {
                        emit(take_line(&mut line));
                    }
                }
            }
        }
    }

    /* Whatever the process left unterminated — usually its last word before it
       exited, which is the line you most want to see. */
    if !line.is_empty() {
        emit(take_line(&mut line));
    }
}

/// No console window flashing up behind a GUI app — the same shape `shell.rs`,
/// `actions.rs` and `project.rs` use. Worth noting the ConPTY path this
/// replaced never passed it: the pseudo-terminal was what hid the window, so a
/// spawn that failed to attach to one had nothing suppressing it.
#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Ask a child for colour it would otherwise withhold for want of a terminal.
///
/// **`isatty` cannot be faked and this is not an attempt to.** On Windows it is
/// `GetFileType` on the handle: a pipe answers `FILE_TYPE_PIPE`, a console
/// answers `FILE_TYPE_CHAR`, and node's `process.stdout.isTTY` is libuv's
/// `uv_guess_handle` asking the same question. It is a property of the kernel
/// object the child is holding, not a claim the parent gets to make — the only
/// way to make it answer "character device" is to hand over a real one, which
/// is a console, which is the ConPTY that does not work here.
///
/// So this uses the convention that exists *because* `isatty` is unfakeable:
/// every one of these variables is a toolchain's documented way of being told
/// "something is capturing your output and it can render colour". What no
/// variable covers is a tool gating *behaviour* rather than colour on `isatty`
/// — spinners, screen clears, vite's keypress shortcuts. Those are gone and no
/// amount of environment brings them back.
///
/// `FORCE_COLOR` is deliberately `1` — the 16 basic colours — and not `3`.
/// `ansi.ts` renders exactly bold, dim, reset and those 16; it consumes a
/// truecolour `38;2;r;g;b` correctly and then *leaves the colour alone*, so
/// asking for 24-bit would render as no colour at all. The narrow ask is the
/// right ask, not a compromise.
fn force_colour(cmd: &mut Command) -> &mut Command {
    cmd
        /* The JavaScript toolchain, via `supports-color`: vite, esbuild, tsc,
           vitest, chalk, picocolors. */
        .env("FORCE_COLOR", "1")
        /* The BSD convention, which is what Rust's `anstyle`/`termcolor` and
           the ripgrep/bat/fd family read. Same pair `shell.rs` sets. */
        .env("CLICOLOR_FORCE", "1")
        /* cargo reads neither of the above. */
        .env("CARGO_TERM_COLOR", "always")
        /* `env_logger`, for a Rust server's own log lines rather than its
           compiler's. */
        .env("RUST_LOG_STYLE", "always")
        /* pytest and pip; `asset_extraction` is the reason. */
        .env("PY_COLORS", "1")
        /* Some tools check `TERM` before anything else and an unset or `dumb`
           one is a hard no. Carried over from the PTY path, which set it for
           this reason and not because a terminal existed. */
        .env("TERM", "xterm-256color")
        /* And the one that undoes all of the above if the wall inherited it:
           `NO_COLOR` wins over `FORCE_COLOR` in every implementation that
           honours both, so a child must not be handed one. */
        .env_remove("NO_COLOR")
}

fn spawn_one(
    app: &AppHandle,
    trace: &Traces,
    group_id: &str,
    spec: &ServerSpec,
    cwd: &str,
) -> Result<PipeServer, String> {
    /* Shell out, because a dev server command is written for a shell:
       `npm run dev`, `cargo watch -x run`, chained &&. `cmd` rather than the
       `pwsh` the floating shell and `!` use, because these commands are
       authored against it — `&&`, `%VAR%` — and because `actions.rs` has been
       running `cmd /C` through pipes here all along. */
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", &spec.command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", &spec.command]);
        c
    };

    cmd.current_dir(spec.cwd.as_deref().unwrap_or(cwd))
        /* There is no terminal here to answer a question. A server that stops
           to ask one — a package manager wanting confirmation, git reaching for
           credentials — has to fail rather than sit forever on a stdin no wall
           can type into. The same reason `actions.rs` nulls it, and it costs
           nothing that was working: the PTY kept no writer either. */
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        /* Autostart means this runs with nobody watching, so a credential
           prompt would block a server nobody asked to start. */
        .env("GIT_TERMINAL_PROMPT", "0");
    force_colour(&mut cmd);
    no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("start {}: {e}", spec.label))?;

    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    /* Both streams, separately — which is the point. vite says most of what
       matters on stdout and cargo does much of its talking on stderr, and the
       merged PTY reader could only ever call all of it stdout. */
    let left = Arc::new(AtomicUsize::new(2));
    let stopped = Arc::new(AtomicBool::new(false));
    for (stream, is_err) in [
        (child.stdout.take().map(Pipe::Out), false),
        (child.stderr.take().map(Pipe::Err), true),
    ] {
        let Some(mut stream) = stream else {
            exit_if_last(app, trace, group_id, &spec.label, &left, &stopped);
            continue;
        };
        let app = app.clone();
        let group_id = group_id.to_string();
        let label = spec.label.clone();
        let left = left.clone();
        let stopped = stopped.clone();
        let trace = trace.clone();
        std::thread::spawn(move || {
            pump_lines(&mut stream, |text| {
                /* Recorded before it is emitted, and the order is not
                   arbitrary: the emit crosses a thread boundary into the event
                   loop and lands whenever the main thread next drains, so a
                   card that asked immediately after a line was drawn on the
                   wall could otherwise be answered without it. Writing first
                   makes the record the earlier of the two readings, which is
                   the direction that cannot surprise anybody. */
                if let Ok(mut map) = trace.lock() {
                    map.entry(group_id.clone()).or_default().push(Said {
                        label: label.clone(),
                        line: text.clone(),
                        stderr: is_err,
                        at: crate::store::now(),
                    });
                }
                let _ = app.emit(
                    "server:log",
                    ServerLog {
                        group_id: group_id.clone(),
                        label: label.clone(),
                        line: text,
                        stderr: is_err,
                    },
                );
            });
            exit_if_last(&app, &trace, &group_id, &label, &left, &stopped);
        });
    }

    Ok(PipeServer {
        child,
        _job: job,
        stopped,
    })
}

/// One of the two pipes, so both can go through the same generic pump without
/// a `&mut dyn Read` — which is unsized and will not fit `pump_lines`. The same
/// shape `actions.rs` uses, and for the same reason.
enum Pipe {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Pipe::Out(r) => r.read(buf),
            Pipe::Err(r) => r.read(buf),
        }
    }
}

/// Both pipes closing is a server that is gone, and whichever closes last says
/// so.
///
/// This is what the PTY could not do. One merged reader ending meant either the
/// process had exited or the master had been released, and nothing downstream
/// could tell which — so a server that died kept reading `starting` until the
/// port poll gave up, and then read `starting` for the rest of the session.
///
/// The exit *code* is deliberately not fetched. `Child::wait` needs the child,
/// the child lives behind the `Servers` mutex, and `stop_group` is a plain
/// `#[tauri::command]` on the main thread that takes the same lock — so a wait
/// under it would park the thread that paints every card on the wall. That is
/// the freeze `azdo_runs` shipped once, one lock further along, and `code` has
/// never crossed the wire anyway: the front end's `server:state` listener does
/// not declare the field.
fn exit_if_last(
    app: &AppHandle,
    trace: &Traces,
    group_id: &str,
    label: &str,
    left: &Arc<AtomicUsize>,
    stopped: &Arc<AtomicBool>,
) {
    if left.fetch_sub(1, Ordering::SeqCst) != 1 {
        return;
    }
    /* A stop we asked for is not news about the server, and saying it anyway
       makes a restart look like a crash. */
    if stopped.load(Ordering::SeqCst) {
        return;
    }
    say_state(app, trace, group_id, label, "exited");
}

#[tauri::command]
pub fn start_group(
    app: AppHandle,
    servers: State<'_, Servers>,
    group: ServerGroup,
    cwd: String,
) -> Result<(), String> {
    start(&app, &servers, &group, &cwd);
    Ok(())
}

/// Bring a group up, replacing whatever of it was already running.
///
/// Cut out of the command rather than left in it because there is now a second
/// caller — `mcp__skein__server`, on the MCP server's own thread — and the two
/// must not be two starts. A restart in particular is *one* act here and cannot
/// be composed out of a stop and a start by anybody: the release below sets
/// `stopped` before the kill so the dying tree's pipes do not report a death
/// the replacement then has to argue with, and it finishes before a single new
/// process is spawned so the ports are genuinely free. A caller that did it in
/// two calls would race its own ports and emit an `exited` for a server that
/// came up fine. See `.claude/rules/servers.md`.
///
/// Not a `Result`: nothing here fails as a whole. A server that will not spawn
/// says so on its own log and reads `exited`, which is the same account the wall
/// gives of one that spawned and then died, and is more use than an error that
/// abandons the group's other four.
pub(crate) fn start(app: &AppHandle, servers: &Servers, group: &ServerGroup, cwd: &str) {
    /* Inline rather than calling `stop` — a restart must fully release the old
       tree before the new one binds ports, and doing it here keeps that inside
       the one function that promises it. */
    if let Some(mut old) = servers.running.lock().unwrap().remove(&group.id) {
        /* And the old group's health poll stops speaking for it here, before
           the new tree binds anything. Otherwise a restart inside the poll's
           twenty-second life leaves two of them running, and the older one is
           reporting `up` about ports that now belong to processes it has never
           heard of. */
        old.polling.store(false, Ordering::SeqCst);
        for s in old.servers.iter_mut() {
            /* Before the kill, so the flag is up by the time the pipes close. */
            s.stopped.store(true, Ordering::SeqCst);
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
        old.servers.clear();
    }

    /* The record starts again with the tree. A restart's whole purpose is to
       ask what it says *this* time, and a log that ran on from the last one
       would answer with the failure you just tried to fix — while `dropped`,
       which exists to say an answer began in the middle, would be counting
       lines from a process that no longer exists. The wall does the same thing
       one layer up: `stopGroup` clears health, and `standing` reads a group
       nobody has started as having nothing to show. */
    if let Ok(mut map) = servers.trace.lock() {
        map.insert(group.id.clone(), Trace::default());
    }

    let mut running = Vec::new();
    for spec in &group.servers {
        say_state(app, &servers.trace, &group.id, &spec.label, "starting");
        match spawn_one(app, &servers.trace, &group.id, spec, cwd) {
            Ok(s) => running.push(s),
            Err(e) => {
                say_state(app, &servers.trace, &group.id, &spec.label, "exited");
                /* Through the same door every other line goes through, so the
                   reason a server would not start is in the log a card reads
                   back rather than only on the wall — it is usually the whole
                   answer ("The system cannot find the file specified"). */
                say_line(app, &servers.trace, &group.id, &spec.label, e, true);
            }
        }
    }

    let polling = Arc::new(AtomicBool::new(true));
    servers.running.lock().unwrap().insert(
        group.id.clone(),
        RunningGroup {
            servers: running,
            polling: polling.clone(),
        },
    );
    say_running(app, &group.id, true);

    /* Ports come up asynchronously, so report health shortly after rather than
       claiming "up" the instant a process exists.

       Only `up` is emitted, never `starting`, and that is not a tidy-up — it is
       what keeps this poll from clobbering an `exited` that `exit_if_last` has
       already sent. The two race by construction: a server that dies at two
       seconds reports it immediately, and a loop still re-asserting `starting`
       every 500ms for the next eighteen would bury it, leaving a dead server
       reading `starting` for the rest of the session. `starting` is already the
       state from the emit before the spawn, so saying it again says nothing;
       this loop exists to deliver the one transition it can see. */
    let app2 = app.clone();
    let group2 = group.clone();
    let trace2 = servers.trace.clone();
    std::thread::spawn(move || {
        for _ in 0..HEALTH_PASSES {
            std::thread::sleep(Duration::from_millis(500));
            if !health_pass(&group2.servers, &polling, port_open, |label| {
                say_state(&app2, &trace2, &group2.id, label, "up")
            }) {
                break;
            }
        }
    });
}

/// How many times the health poll looks before giving up. Twenty seconds at
/// 500ms apart, which is what a cold `next dev` costs on this machine.
const HEALTH_PASSES: usize = 40;

/// One look at a group's ports. `true` to keep looking.
///
/// Cut out of the thread above so the two things that stop it can actually be
/// asserted — the thread itself is twenty seconds of `sleep` around this, and a
/// bug in *when it stops* is exactly the kind nothing here could reach. Takes
/// its port probe and its emit as arguments for the same reason: a test wants
/// to answer for a port without binding one, and to count what was said without
/// an `AppHandle`.
///
/// Two ways to stop, and they are different questions. `alive` false means this
/// poll no longer speaks for a live group and **must say nothing at all** —
/// checked before any port is read, since the bug was reporting `up` for a
/// stopped group whose port something else had taken. Every port answering
/// means the poll is simply finished, which is the ordinary exit.
fn health_pass(
    specs: &[ServerSpec],
    alive: &AtomicBool,
    /* `FnMut` rather than `Fn` because a test wants to count the probes, and
       counting is a mutation. Costs the real caller nothing — it passes a plain
       `fn` — and the looser bound is the one that lets the assertion prove the
       port was never read at all. */
    mut open: impl FnMut(u16) -> bool,
    mut up: impl FnMut(&str),
) -> bool {
    if !alive.load(Ordering::SeqCst) {
        return false;
    }
    let mut all_known = true;
    for spec in specs {
        let Some(port) = spec.port else {
            continue;
        };
        if !open(port) {
            all_known = false;
            continue;
        }
        up(&spec.label);
    }
    !all_known
}

/// `app` is new and is injected by Tauri rather than passed from the front end,
/// so nothing in `skein.svelte.ts` changes: the stop now says so on the wire
/// (`say_running`), which it never had to while the front end was the only
/// thing that could ask for one and set its own flag optimistically.
#[tauri::command]
pub fn stop_group(
    app: AppHandle,
    servers: State<'_, Servers>,
    group_id: String,
) -> Result<(), String> {
    stop(&app, &servers, &group_id);
    Ok(())
}

/// Take a group down, and say so.
///
/// Cut out for the same reason `start` was, and it returns whether anything was
/// actually running — which the command has never needed and the tool does. A
/// card told "stopped" about a group that was already down has been told
/// something false about the machine, and it is exactly the sort of false thing
/// an agent then reasons from.
pub(crate) fn stop(app: &AppHandle, servers: &Servers, group_id: &str) -> bool {
    let Some(mut g) = servers.running.lock().unwrap().remove(group_id) else {
        return false;
    };
    /* First, and before anything is killed: a poll that reads a port between
       the kill and the flag would report `up` for a group being taken down. */
    g.polling.store(false, Ordering::SeqCst);
    for s in g.servers.iter_mut() {
        /* A group taken down on purpose reads `idle`, not `exited`. The front
           end clears its health on stop, so a late `exited` from the closing
           pipes would put it straight back — and this rule already says
           elsewhere that groups down for a reason must not look like groups
           that failed. */
        s.stopped.store(true, Ordering::SeqCst);
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    /* Dropping each job object takes down anything the children spawned. */
    g.servers.clear();

    /* And the record agrees with the wall about it. The lines are *kept* —
       what a server said before you stopped it is often exactly why you
       stopped it, and this is the only scrollback there is. Only the health is
       cleared, which is the same thing `stopGroup` does one layer up and for
       the same reason: idle, not exited. */
    if let Ok(mut map) = servers.trace.lock() {
        if let Some(t) = map.get_mut(group_id) {
            t.health.clear();
        }
    }
    say_running(app, group_id, false);
    true
}

#[tauri::command]
pub fn group_running(servers: State<'_, Servers>, group_id: String) -> bool {
    servers.running.lock().unwrap().contains_key(&group_id)
}

/// Should the wall skip starting its `autostart` groups on load?
///
/// Set `SKEIN_NO_SERVERS=1` and the groups still appear as chips, still say what
/// they are, and still start when clicked — only the eager start on load is off.
/// That is the difference that matters: dev servers bind ports, so a second Skein
/// against the same store (a build under test beside the installed one, say)
/// otherwise races the first for every port in the workspace and both ends up
/// with groups reading `exited`.
///
/// Deliberately advisory rather than enforced in `start_group`: the flag means
/// "don't start these for me", not "these may not run", and a chip that refused
/// to answer a click would be a worse thing than a port conflict.
#[tauri::command]
pub fn servers_quiet() -> bool {
    quiet(std::env::var("SKEIN_NO_SERVERS").ok().as_deref())
}

/// Absent or empty is off, `0`/`false`/`no` are off, anything else is on — the
/// same shape `SKEIN_CONTROL_INPUT` reads, so the vocabulary is one vocabulary.
///
/// Shared with `supervisor::wake_quiet`, which reads `SKEIN_NO_WAKE` the same
/// way. Two flags that mean "don't start things for me" must agree on what a
/// person is likely to type, or one of them is a trap.
pub(crate) fn quiet(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        None | Some("") => false,
        Some(v) => !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"),
    }
}

/* ── what a card may ask of the dev servers ───────────────────────────────
 *
 * Three tools on the `skein` MCP server, and their whole shape is the line the
 * board and the sink already draw: **reading is free, acting is not.**
 * `servers` and `server_log` cost nobody anything and are the two an agent
 * should reach for by reflex — a card that read the log before deciding whether
 * to restart is a card that did not restart. `server` starts processes on this
 * machine, and its description says so in those words rather than leaving the
 * model to infer it from a verb.
 *
 * They live in this file rather than a module of their own on purpose.
 * `relay.rs`, `board.rs` and `sink.rs` each hold their subsystem's state *and*
 * its tools, which is the pattern; and a `devservers.rs` would have needed a
 * `mod` line in `lib.rs` — a seam whose other half is an untracked file, which
 * is the exact pair that stopped `main` compiling once already. There is no new
 * `#[tauri::command]` here and no new module, so `lib.rs` is untouched.
 *
 * Nothing here needs `crate::off_main`. That rule is about a `#[tauri::command]`
 * without `async`, which runs inline on the thread that dispatches the IPC — the
 * one that paints every card. These are not commands: `ask::start` gives every
 * MCP request a thread of its own, so `start`'s kills and waits park a thread
 * nobody is drawing from. What *is* still owed is the lock discipline, and it is
 * why `Servers` has two mutexes rather than one — the pump threads take `trace`
 * for every line of output, and putting that behind whatever `start` is doing to
 * a process tree would stall a card's log behind a restart.
 */

/// The roster of groups. Reading, and free.
pub const SERVERS_TOOL: &str = "servers";
/// What a group has said. Reading, and free.
pub const SERVER_LOG_TOOL: &str = "server_log";
/// Start, stop or restart one. Not free — this one runs things.
///
/// One tool with an `action` rather than three, and the reason is a fact about
/// this file rather than a preference about names: **a restart is one act and
/// cannot be composed.** `start` releases the old tree with `stopped` already
/// set, so the dying pipes do not report a death the replacement then has to
/// argue with, and it finishes before a single new process is spawned so the
/// ports are genuinely free. A `server_stop` followed by a `server_start` would
/// race its own ports and report a server that came up fine as having died — so
/// the correct thing is the named thing and the wrong composition is not
/// offered at all.
///
/// The one-letter distance from `servers` is deliberate rather than overlooked,
/// and it is safe in the direction that matters: this tool *requires* `group`
/// and `action`, so a model that meant the list and typed this gets a schema
/// error rather than a restarted server. The confusion cannot run the other way
/// into anything that touches the machine.
pub const SERVER_TOOL: &str = "server";

/// How many lines a log read answers with when nobody said.
///
/// Sized for the question actually being asked, which is "what did it just
/// say" — a vite failure, a compiler's last four lines, the reason a port would
/// not bind. Enough to carry the tail of a stack trace, and not so much that a
/// card reaching for this on spec pays a screenful of HMR notices for it.
const LOG_DEFAULT: usize = 60;

/// And the ceiling, whatever was asked for.
///
/// `KEEP_LINES` is 2000 and this is deliberately far below it: the ring is sized
/// so the *answer* can be anywhere in recent history, not so that the whole of
/// it can be poured into one tool result. A dev server log runs to megabytes and
/// an agent that asked for all of it would spend its context on webpack's
/// opinion of itself. `match` is the cheaper question and the one worth
/// encouraging.
const LOG_MAX: usize = 400;

/// Take the escapes out of a line before an agent reads it.
///
/// The wall asks dev servers for colour they would otherwise withhold for want
/// of a terminal — that is `force_colour`, and it is the whole reason `ansi.ts`
/// exists. So every line in the ring may carry SGR sequences, and the one reader
/// that cannot use them is the one added here: a model handed
/// `ESC[32m ready in 342ms ESC[39m` is reading noise around the four words that
/// mattered, and paying tokens for the noise.
///
/// The wall keeps the colour and the tool takes it off — one line, two readers,
/// two right answers. Not by dropping the escape byte alone, which would leave
/// the `[32m` behind and read as though the server had printed it.
///
/// Narrow on purpose and narrow in the safe direction: CSI and OSC are what a
/// terminal program actually emits, anything else beginning with an escape drops
/// the escape and its one following byte, and text that is not an escape at all
/// passes through untouched. A sequence this does not recognise costs at most
/// two characters of a line rather than swallowing the rest of it, which is the
/// failure worth choosing — a log with a stray `[?25l` in it is legible, and a
/// log truncated at the first unrecognised byte is not.
fn strip_ansi(s: &str) -> String {
    const ESC: char = '\u{1b}';
    let mut out = String::with_capacity(s.len());
    let mut cs = s.chars();
    while let Some(c) = cs.next() {
        if c != ESC {
            out.push(c);
            continue;
        }
        match cs.next() {
            /* CSI: parameters and intermediates, then one final byte in
               0x40..=0x7E. Unterminated at end of line simply ends. */
            Some('[') => {
                for f in cs.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&f) {
                        break;
                    }
                }
            }
            /* OSC: a string ended by BEL, or by ST which is an escape and a
               backslash. Window titles and hyperlinks — rare out of a dev
               server and cheap enough to handle rather than mangle. */
            Some(']') => {
                while let Some(f) = cs.next() {
                    if f == '\u{7}' {
                        break;
                    }
                    if f == ESC {
                        /* Consume the backslash of an ST. Anything else was a
                           fresh escape, and leaving it to the outer loop costs
                           one character rather than the rest of the line. */
                        if cs.clone().next() == Some('\\') {
                            cs.next();
                        }
                        break;
                    }
                }
            }
            /* `ESC c`, `ESC 7`, and the rest of the two-character family. */
            Some(_) | None => {}
        }
    }
    out
}

/// Which group an agent meant.
///
/// Pure, and the whole of the naming policy, so what a card may write in `group`
/// is settled in one place with tests rather than at three call sites.
///
/// A group is named by its **label**, because that is what it is called on the
/// wall and in the panel, and an id here is a uuid nobody typed. The id is
/// accepted too — `servers` reports both, and it is the answer to the one case a
/// label cannot settle.
///
/// Three refusals, each saying what to do instead. Ambiguity is refused rather
/// than resolved: two groups called `dev` in one territory is an ordinary thing
/// to have, and picking the first would be a tool restarting something the agent
/// did not name. Omission is refused the same way as soon as there is more than
/// one group — but *not* when there is exactly one, since then naming it and not
/// naming it are the same answer, which is the argument `logface.ts`'s `FOLLOW`
/// makes about a wall with one subject on it.
fn pick_group(groups: &[ServerGroup], want: &str) -> Result<ServerGroup, String> {
    let want = want.trim();
    if groups.is_empty() {
        return Err("this territory has no dev server groups — the servers panel is where a \
                    project gets one, which is the user's gesture rather than yours."
            .into());
    }
    if want.is_empty() {
        return match groups {
            [only] => Ok(only.clone()),
            _ => Err(format!(
                "name the group — this territory has {}: {}.",
                groups.len(),
                names_of(groups)
            )),
        };
    }
    /* The id first and exactly, since it is a uuid and cannot collide. */
    if let Some(g) = groups.iter().find(|g| g.id == want) {
        return Ok(g.clone());
    }
    let hit: Vec<&ServerGroup> = groups
        .iter()
        .filter(|g| g.label.eq_ignore_ascii_case(want))
        .collect();
    match hit.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!(
            "no dev server group called {want:?} in this territory. There {}: {}.",
            if groups.len() == 1 { "is one" } else { "are" },
            names_of(groups)
        )),
        several => Err(format!(
            "{} groups here are called {want:?} — name the one you mean by its id: {}.",
            several.len(),
            several.iter().map(|g| g.id.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// The groups a territory has, in the words a refusal uses.
fn names_of(groups: &[ServerGroup]) -> String {
    groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>().join(", ")
}

/// Where the caller stands, and what dev servers it may see.
struct Standing {
    project: String,
    root: String,
    groups: Vec<ServerGroup>,
}

/// Answer that, or say why not — and the refusal is the load-bearing half.
///
/// **A chat card is refused all three tools, and the kind is asked of the store
/// rather than taken from the caller.** A chat card spawns with
/// `--tools WebSearch,WebFetch` and no bypass at all: it reaches the open web and
/// nothing on this machine, which is the entire content of the kind
/// (`.claude/rules/chat.md`). A dev server group is a command line and a working
/// directory on this disk, so `server` would hand a chat card the one reach it is
/// defined by not having — and `servers` and `server_log` would hand it a list of
/// this machine's directories and the output of processes running on them, which
/// is the same refusal `relay::do_list` already makes one step earlier and for
/// the same reason. All three, not only the one that spawns.
///
/// The narrowing to the caller's own territory is the second rule and is not a
/// convenience. A card may see and drive the dev servers of the project it stands
/// in and no others: there is deliberately no `scope` knob here the way `list`
/// has one, because "every group on the wall" is not a reading anybody needs and
/// is a reach worth not offering.
fn standing(app: &AppHandle, caller: &str, acting: bool) -> Result<Standing, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is unavailable".to_string())?;

    let me = crate::store::roster_one(&conn, caller)
        .ok_or_else(|| "this conversation is not on the wall.".to_string())?;
    if me.kind == "chat" {
        return Err(if acting {
            "this is a chat card: it stands outside the wall's projects and reaches nothing \
             on this machine, so it cannot start or stop anything here."
                .into()
        } else {
            "this is a chat card: it stands outside the wall's projects and reaches nothing \
             on this machine, so it has no dev servers to look at."
                .into()
        });
    }

    let project = crate::store::project_row(&conn, &me.project_id)
        .ok_or_else(|| "this card's territory is not on the wall any more.".to_string())?;
    let groups = crate::store::server_groups_for(&conn, &project.id)?;
    Ok(Standing {
        project: project.name,
        root: project.root_path,
        groups,
    })
}

/* ── the schemas ──────────────────────────────────────────────────────────
 *
 * Longer than the code they describe, and that is the arrangement rather than
 * an accident: `ask::mcp_config` sets `alwaysLoad`, so every one of these
 * reaches every card at session start with its description attached. That is
 * where the reasoning lives — `supervisor::append_prompt` is short *because* of
 * it — so a description that only names its arguments is a tool the model will
 * reach for at the wrong moment, and this server's whole cost is paid in the
 * hope that it will not.
 */

pub fn servers_schema() -> Value {
    json!({
        "name": SERVERS_TOOL,
        "description":
            "List the dev server groups defined for this card's project — what each one \
             runs, which ports it claims, whether it is up, and what each server last \
             said. Costs nobody anything: the wall is already holding all of it.\n\n\
             Read it before assuming a server is or is not running. A card that guessed \
             wrong here starts a second vite on a bound port, or spends a turn debugging a \
             404 from a server that was never up.\n\n\
             `running` and `health` are two questions and the pair is the reading: \
             `running` is whether the wall has asked for this group, `health` is what each \
             of its servers did about it. A group that crashed is `running: true` with an \
             `exited` server, and that is the case you are most likely asking about.\n\n\
             Only this project's groups — a card sees the dev servers of the territory it \
             stands in and no others.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

pub fn server_log_schema() -> Value {
    json!({
        "name": SERVER_LOG_TOOL,
        "description":
            "Read what a dev server group has printed — the compile error, the request \
             log, the reason a port would not bind. Free, and it is what to do *instead* \
             of restarting something to find out what it says.\n\n\
             Answers the tail by default, newest last, with the colour escapes taken out. \
             The wall keeps a bounded history per group and tells you how much of it has \
             fallen off the end, so an answer that begins in the middle says that it does.\n\n\
             `match` is the cheap way to reach further back than `lines` would: it filters \
             the whole kept history rather than the tail, so it finds the failure that \
             scrolled past minutes ago without pouring the log into your context. Prefer \
             narrowing to asking for more lines.\n\n\
             The history starts again each time the group is started, because a restart's \
             whole purpose is to ask what it says this time.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "group": {
                    "type": "string",
                    "description":
                        "Which group, by the label `servers` reports, or by its id. May be \
                         left out only when the project has exactly one."
                },
                "lines": {
                    "type": "integer",
                    "description":
                        "How many lines to answer with, newest last. Default 60, capped at \
                         400 — if that is not enough, narrow with `match` rather than \
                         asking for more."
                },
                "match": {
                    "type": "string",
                    "description":
                        "Keep only lines containing this, case-insensitively, searched \
                         across the whole kept history rather than across the tail."
                },
                "stderr": {
                    "type": "boolean",
                    "description":
                        "Keep only what came down stderr. Worth knowing before you use it: \
                         half of everything logs perfectly calm prose to stderr, so this \
                         narrows by which *pipe* a line came down and not by whether it is \
                         bad news. `match` is usually what you actually wanted."
                }
            }
        }
    })
}

pub fn server_schema() -> Value {
    json!({
        "name": SERVER_TOOL,
        "description":
            "Start, stop or restart a dev server group. **This one runs processes on the \
             user's machine** — it binds ports, spawns a tree under a job object, and \
             takes down whatever was there before. Listing the groups and reading their \
             logs cost nothing; this does not, so read those first and act on what they \
             said.\n\n\
             `restart` is one action and not a stop followed by a start. Do not compose \
             it: the wall releases the old process tree and waits for it before binding a \
             single port, and two calls would race their own ports and then report a \
             server that came up fine as having died.\n\n\
             Restart after changing something a running server does not pick up by itself \
             — a vite config, a `.env`, a dependency. Do **not** restart in order to see \
             the log: that is `server_log`, it is free, and the restart would throw away \
             the output you were about to read. Do not stop a group you did not start on \
             your own account — it is the user's wall, and something else on it may be \
             watching that port.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "group": {
                    "type": "string",
                    "description":
                        "Which group, by the label `servers` reports, or by its id. May be \
                         left out only when the project has exactly one."
                },
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "restart"],
                    "description":
                        "`start` brings it up; aimed at a group that is already running it \
                         is a restart, since the ports have to be released either way, and \
                         the answer says so. `stop` takes the whole tree down. `restart` \
                         is the ordinary one."
                }
            },
            "required": ["group", "action"]
        }
    })
}

/* ── the answers ─────────────────────────────────────────────────────────── */

/// Route a `tools/call` to whichever of the three it names, or `None` so
/// `ask.rs` can try the next module — the same contract `relay::handle` has.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        SERVERS_TOOL => Some(do_servers(app, conversation_id)),
        SERVER_LOG_TOOL => Some(do_server_log(app, conversation_id, args)),
        SERVER_TOOL => Some(do_server(app, conversation_id, args)),
        _ => None,
    }
}

fn do_servers(app: &AppHandle, caller: &str) -> String {
    let stand = match standing(app, caller, false) {
        Ok(s) => s,
        Err(why) => return why,
    };
    if stand.groups.is_empty() {
        return format!(
            "{} has no dev server groups defined. The servers panel on the wall is where a \
             project gets one, which is the user's gesture rather than yours.",
            stand.project
        );
    }

    let servers = app.state::<Servers>();
    /* Which groups are up is taken as a snapshot and the lock released, rather
       than held alongside `trace` for the length of the map below. Nothing here
       would deadlock today — nothing anywhere holds `running` and then reaches
       for `trace` — but this would be the one place that established an order,
       and `start` and `stop` both take them one after the other in the opposite
       one. An invariant that holds only because of the order two `let`s happen
       to be written in is not an invariant. */
    let up: std::collections::HashSet<String> = servers
        .running
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    let trace = servers.trace.lock().ok();
    let rows: Vec<Value> = stand
        .groups
        .iter()
        .map(|g| {
            let up = up.contains(&g.id);
            let t = trace.as_ref().and_then(|m| m.get(&g.id));
            json!({
                "group": g.label,
                "id": g.id,
                "running": up,
                "autostart": g.autostart,
                "servers": g.servers.iter().map(|s| json!({
                    "label": s.label,
                    "command": s.command,
                    "port": s.port,
                    "health": t
                        .and_then(|t| t.health.get(&s.label))
                        .map(String::as_str)
                        .unwrap_or("idle"),
                    /* The last thing each of them said, which is the reading a
                       group of two can give in two lines — "ready in 342ms",
                       "compiled with 1 error" — and is the same one the widget
                       draws at a card's size (`serverlog::latest`). It is very
                       often the whole answer, which is what keeps a card from
                       following this up with a log read it did not need. */
                    "last": t.and_then(|t| t.lines.iter().rev()
                        .find(|l| l.label == s.label)
                        .map(|l| clip_line(&strip_ansi(&l.line)))),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    json!({
        "project": stand.project,
        "root": stand.root,
        "groups": rows,
        "note": "`server_log` reads any of these and costs nothing. `server` starts and \
                 stops them, and that runs processes on this machine.",
    })
    .to_string()
}

/// The last thing a server said, at a length that belongs in a list.
///
/// `servers` is a roster and not a log: a group of four whose vite has just
/// printed a 300-character warning would otherwise answer with more prose than
/// the whole rest of the reading, for a line the caller can have in full from
/// `server_log` one call later.
fn clip_line(s: &str) -> String {
    const MAX: usize = 160;
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX - 1).collect();
    format!("{cut}…")
}

fn do_server_log(app: &AppHandle, caller: &str, args: &Value) -> String {
    let stand = match standing(app, caller, false) {
        Ok(s) => s,
        Err(why) => return why,
    };
    let want_group = args.get("group").and_then(Value::as_str).unwrap_or("");
    let group = match pick_group(&stand.groups, want_group) {
        Ok(g) => g,
        Err(why) => return why,
    };

    /* Clamped rather than refused. A model writing 5000 here has said "as much
       as I can get", which is a reasonable thing to mean and an unreasonable
       thing to be given; what it was cut to is in the answer. */
    let want = args
        .get("lines")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, LOG_MAX))
        .unwrap_or(LOG_DEFAULT);
    let needle = args
        .get("match")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    let errs_only = args.get("stderr").and_then(Value::as_bool).unwrap_or(false);

    let servers = app.state::<Servers>();
    let up = servers.running.lock().is_ok_and(|m| m.contains_key(&group.id));
    let Ok(map) = servers.trace.lock() else {
        return "the dev server log is unavailable".into();
    };
    let Some(trace) = map.get(&group.id) else {
        return format!(
            "`{}` has not been started this session, so there is nothing it has said. \
             `server` with `action: \"start\"` brings it up — and that runs processes on \
             this machine.",
            group.label
        );
    };

    /* Filtered over the whole ring and *then* tailed, which is the order that
       makes `match` worth having: narrowing the tail would only ever search the
       sixty lines already being answered with, and the line worth finding is by
       definition one that scrolled past. */
    let kept: Vec<&Said> = trace
        .lines
        .iter()
        .filter(|l| !errs_only || l.stderr)
        .filter(|l| {
            needle
                .as_ref()
                .is_none_or(|n| l.line.to_lowercase().contains(n))
        })
        .collect();
    let from = kept.len().saturating_sub(want);
    let shown = &kept[from..];

    let mut head = format!(
        "`{}` in {} — {}",
        group.label,
        stand.project,
        if up { "running" } else { "not started" }
    );
    /* When it last said *anything*, which is a different fact from the last
       line shown and is the one that answers "is it stuck?". A group that is
       running and has printed nothing for forty minutes is either idle and fine
       or wedged, and the number is what lets the agent tell — where a tail
       alone reads identically in both cases. Taken from the whole ring rather
       than from the filtered view, or a `match` that happened to hit an old
       line would report the server as having gone quiet since. */
    if let Some(last) = trace.lines.back() {
        head.push_str(&format!(
            ", last spoke {}",
            crate::relay::ago((crate::store::now() - last.at).max(0))
        ));
    }
    if let Some(n) = &needle {
        head.push_str(&format!(", lines matching {n:?}"));
    }
    if errs_only {
        head.push_str(", stderr only");
    }

    if shown.is_empty() {
        /* Which absence it is, in the subject's own words — the same
           distinction `logface::emptyBecause` draws for the widget. A filter
           that emptied the pane and a server that has genuinely said nothing
           are different facts, and an agent told the wrong one draws the wrong
           conclusion about the machine. */
        return if needle.is_some() || errs_only {
            format!(
                "{head}\n\nNothing matched, out of {} line{} kept.",
                trace.lines.len(),
                if trace.lines.len() == 1 { "" } else { "s" }
            )
        } else {
            format!("{head}\n\nIt has not printed anything yet.")
        };
    }

    let body: Vec<String> = shown
        .iter()
        /* The label in the gutter and nothing else — which pipe a line came
           down is deliberately *not* marked, for the reason `LogTail` leaves
           its tint off for this subject: half of everything logs calm prose to
           stderr, and a tool that annotated those lines as errors would have
           the model reporting a healthy server as broken. `stderr: true` is
           there for when the pipe genuinely is the question. */
        .map(|l| format!("[{}] {}", l.label, strip_ansi(&l.line)))
        .collect();

    let mut out = format!("{head}\n\n{}", body.join("\n"));

    /* Two different kinds of "there is more", and both are worth saying. What
       the *window* left behind is recoverable — ask again, or narrow. What fell
       out of the ring is gone, and a card that assumed otherwise would conclude
       a server never printed something it printed an hour ago. */
    let held_back = kept.len() - shown.len();
    if held_back > 0 {
        out.push_str(&format!(
            "\n\n({held_back} earlier matching line{} not shown — narrow with `match`, or \
             ask for more `lines`.)",
            if held_back == 1 { "" } else { "s" }
        ));
    }
    if trace.dropped > 0 {
        out.push_str(&format!(
            "\n\n({} line{} fallen off the start of what is kept for this group — anything \
             older than that is gone.)",
            trace.dropped,
            if trace.dropped == 1 { " has" } else { "s have" }
        ));
    }
    out
}

fn do_server(app: &AppHandle, caller: &str, args: &Value) -> String {
    let stand = match standing(app, caller, true) {
        Ok(s) => s,
        Err(why) => return why,
    };
    let Some(raw) = args.get("action").and_then(Value::as_str) else {
        return "say which: `action` is \"start\", \"stop\" or \"restart\".".into();
    };
    let action = raw.trim().to_ascii_lowercase();
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        /* Named rather than defaulted. Every other tool on this server that
           does not recognise a word falls back to its default — `list`'s scope
           does, and says why: the worst reading of a wrong one is a shorter
           list. Nothing here has that property. The cheapest wrong guess this
           could make is restarting a server the user was watching, so an action
           this does not understand is an action nobody takes. */
        return format!("no such action {action:?} — it is \"start\", \"stop\" or \"restart\".");
    }
    let want_group = args.get("group").and_then(Value::as_str).unwrap_or("");
    let group = match pick_group(&stand.groups, want_group) {
        Ok(g) => g,
        Err(why) => return why,
    };

    let servers = app.state::<Servers>();
    if action == "stop" {
        return if stop(app, &servers, &group.id) {
            format!(
                "stopped `{}` — the whole tree, job object and all. `server` with \
                 `action: \"start\"` brings it back.",
                group.label
            )
        } else {
            /* Not smoothed into "stopped". A card told it stopped something
               that was already down has been told something false about the
               machine, and it is exactly the sort of false thing an agent then
               reasons from — "I stopped it, so the port is free". */
            format!("`{}` was not running, so nothing was stopped.", group.label)
        };
    }

    /* `start` and `restart` are the same call, and that is not a shortcut: this
       is the one place the release-then-bind order is guaranteed, so a `start`
       aimed at a group that is already up does the right thing rather than
       racing it. The two words are still kept apart in the schema, because what
       the agent *meant* is worth having in the transcript — and because a tool
       that quietly restarted something in answer to "start" without saying so
       would be lying about what it did. Hence the clause on the end. */
    let was = servers.running.lock().is_ok_and(|m| m.contains_key(&group.id));
    start(app, &servers, &group, &stand.root);

    let ports: Vec<String> = group
        .servers
        .iter()
        .filter_map(|s| s.port.map(|p| format!("{}:{p}", s.label)))
        .collect();
    format!(
        "{} `{}` — {} server{}{}{}. They are starting: a port takes a moment to bind, so \
         `servers` will read `starting` for a few seconds either way. Read `server_log` for \
         what it says rather than starting it again.",
        if was { "restarted" } else { "started" },
        group.label,
        group.servers.len(),
        if group.servers.len() == 1 { "" } else { "s" },
        if ports.is_empty() {
            String::new()
        } else {
            format!(", {}", ports.join(" "))
        },
        if was && action == "start" {
            ", and it was already running, so the old tree was released first"
        } else {
            ""
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A spec with just enough on it to be looked at.
    fn spec(label: &str, port: Option<u16>) -> ServerSpec {
        ServerSpec {
            label: label.into(),
            command: "pnpm dev".into(),
            cwd: None,
            port,
        }
    }

    /// The bug, and the reason `health_pass` is a function at all: a poll whose
    /// group has been stopped must not read a port, because the port may since
    /// have been taken by something else on this machine — a second Volery, a
    /// `pnpm dev` in a terminal — and saying `up` about it puts a stopped group
    /// back on the wall looking healthy.
    #[test]
    fn a_poll_whose_group_is_gone_says_nothing_and_stops() {
        let specs = [spec("web", Some(3000))];
        let alive = AtomicBool::new(false);
        let mut said = Vec::new();
        let mut probed = 0;

        let again = health_pass(
            &specs,
            &alive,
            |_| {
                probed += 1;
                true
            },
            |l| said.push(l.to_string()),
        );

        assert!(!again, "a poll that no longer speaks for a group must stop");
        assert!(said.is_empty(), "it must not report health: {said:?}");
        assert_eq!(probed, 0, "and must not even look at the port");
    }

    /// The ordinary life of the poll: report what is up, keep going while
    /// anything is still coming, and stop when there is nothing left to learn.
    #[test]
    fn a_live_poll_reports_what_is_up_and_stops_when_all_of_it_is() {
        let specs = [spec("web", Some(3000)), spec("api", Some(4000))];
        let alive = AtomicBool::new(true);

        let mut said = Vec::new();
        let again = health_pass(&specs, &alive, |p| p == 3000, |l| said.push(l.to_string()));
        assert_eq!(said, ["web"], "only the port that answers");
        assert!(again, "the other one may still be coming");

        let mut said = Vec::new();
        let again = health_pass(&specs, &alive, |_| true, |l| said.push(l.to_string()));
        assert_eq!(said, ["web", "api"]);
        assert!(!again, "nothing left to learn, so the poll is finished");
    }

    /// A server with no port declared is not a server this poll can answer for,
    /// and — the half worth pinning — it must not keep the poll alive either.
    /// Read it as "still coming" and a group of unported servers polls for the
    /// full twenty seconds every time it starts.
    #[test]
    fn a_spec_with_no_port_is_skipped_without_holding_the_poll_open() {
        let specs = [spec("worker", None)];
        let alive = AtomicBool::new(true);
        let mut said = Vec::new();
        let again = health_pass(&specs, &alive, |_| true, |l| said.push(l.to_string()));
        assert!(said.is_empty());
        assert!(!again);
    }

    /// The flag is cleared by the two paths that take a group out of the map,
    /// and the poll reads the *same* `AtomicBool` those paths hold rather than
    /// a copy of a number — so this is the whole of the contract between them.
    #[test]
    fn clearing_the_flag_is_what_the_poll_is_reading() {
        let flag = Arc::new(AtomicBool::new(true));
        let specs = [spec("web", Some(3000))];
        let seen = |f: &Arc<AtomicBool>| {
            let mut said = Vec::new();
            let again = health_pass(&specs, f, |_| true, |l| said.push(l.to_string()));
            (said, again)
        };

        assert_eq!(seen(&flag), (vec!["web".to_string()], false));
        /* What `stop` and `start`'s restart block each do to the group they
           have just removed from the map. */
        flag.store(false, Ordering::SeqCst);
        assert_eq!(seen(&flag), (Vec::<String>::new(), false));
    }

    #[test]
    fn quiet_reads_the_usual_words() {
        assert!(!quiet(None));
        assert!(!quiet(Some("")));
        assert!(!quiet(Some("  ")));
        assert!(!quiet(Some("0")));
        assert!(!quiet(Some("false")));
        assert!(!quiet(Some("No")));
        assert!(!quiet(Some("OFF")));
        assert!(quiet(Some("1")));
        assert!(quiet(Some("true")));
        assert!(quiet(Some(" yes ")));
    }

    /// Hands out its bytes in fixed-size pieces, so a `\r\n` pair or a
    /// multi-byte character can land across two reads the way a real PTY splits
    /// them. A chunk of 1 is the meanest schedule there is.
    struct Chunked<'a> {
        data: &'a [u8],
        chunk: usize,
    }

    impl Read for Chunked<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.data.len().min(self.chunk).min(buf.len());
            buf[..n].copy_from_slice(&self.data[..n]);
            self.data = &self.data[n..];
            Ok(n)
        }
    }

    fn pump(data: &[u8], chunk: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut reader = Chunked { data, chunk };
        pump_lines(&mut reader, |line| out.push(line));
        out
    }

    #[test]
    fn crlf_does_not_leave_a_phantom_blank_line_between_every_line() {
        // cmd.exe /C, which is how every server on Windows is started.
        assert_eq!(pump(b"first\r\nsecond\r\n", 4096), ["first", "second"]);
        // And the same when the pair is split across two reads.
        assert_eq!(pump(b"first\r\nsecond\r\n", 6), ["first", "second"]);
        assert_eq!(pump(b"first\r\nsecond\r\n", 1), ["first", "second"]);
    }

    #[test]
    fn a_progress_redraw_arrives_as_it_happens_rather_than_after_the_build() {
        /* The whole reason this is not BufReader::lines(): none of these have a
           newline, and a build that only prints progress would show nothing. */
        assert_eq!(
            pump(b"10%\r50%\r100%\r\ndone\n", 4096),
            ["10%", "50%", "100%", "done"]
        );
    }

    #[test]
    fn a_blank_line_from_a_real_newline_is_kept() {
        // Vertical space separates vite's banner from what follows it.
        assert_eq!(pump(b"\nVITE ready\n\nwarn\n", 4096), ["", "VITE ready", "", "warn"]);
    }

    #[test]
    fn the_last_line_survives_a_process_that_exits_without_a_newline() {
        assert_eq!(pump(b"listening on 5173", 4096), ["listening on 5173"]);
        assert_eq!(pump(b"a\nb", 4096), ["a", "b"]);
    }

    #[test]
    fn nothing_is_emitted_for_an_empty_stream() {
        assert!(pump(b"", 4096).is_empty());
        // A bare redraw of nothing is punctuation, not a line.
        assert!(pump(b"\r", 4096).is_empty());
        assert!(pump(b"\r\r\r", 4096).is_empty());
    }

    #[test]
    fn a_character_split_across_two_reads_is_not_mangled() {
        // vite's arrow is three bytes; a chunk of 1 splits every one of them.
        let out = pump("  ➜  Local: http://localhost:5173/\n".as_bytes(), 1);
        assert_eq!(out, ["  ➜  Local: http://localhost:5173/"]);
    }

    #[test]
    fn invalid_utf8_degrades_instead_of_killing_the_pump() {
        let out = pump(b"ok\xffthen\nnext\n", 4096);
        assert_eq!(out.len(), 2, "the pump stopped at the bad byte");
        assert!(out[0].starts_with("ok") && out[0].ends_with("then"));
        assert_eq!(out[1], "next", "output after the bad byte was lost");
    }

    #[test]
    fn a_runaway_line_is_flushed_rather_than_buffered_without_bound() {
        let flood = vec![b'x'; MAX_LINE * 2 + 10];
        let out = pump(&flood, 4096);
        assert!(out.len() >= 2, "a line with no terminator grew unbounded");
        assert!(out.iter().all(|l| l.len() <= MAX_LINE));
        // Nothing is dropped on the way — it is split, not truncated.
        assert_eq!(out.concat().len(), flood.len());
    }

    /* ── what a card may ask ─────────────────────────────────────────────
     *
     * The three tools' pure halves. What is deliberately *not* here is any of
     * `do_servers` / `do_server_log` / `do_server`: each takes an `AppHandle`
     * and reaches the store and the running map through it, so testing them
     * would mean standing up a Tauri app and a database — and the judgements
     * worth testing have all been cut out into functions that need neither.
     * That is the same split `limits.rs` draws against `limits.ts` and
     * `sink.rs` draws against `sink.ts`: the part that will be argued about is
     * the policy, and an argument is worth having against tests.
     */

    fn group(id: &str, label: &str) -> ServerGroup {
        ServerGroup {
            id: id.into(),
            project_id: "p".into(),
            label: label.into(),
            autostart: true,
            start_order: 0,
            servers: Vec::new(),
        }
    }

    #[test]
    fn a_line_reaches_an_agent_with_the_colour_taken_off() {
        /* What `force_colour` asks vite for, and what the wall renders happily
           and a model cannot use at all. */
        assert_eq!(
            strip_ansi("\u{1b}[32m\u{1b}[1mready\u{1b}[22m\u{1b}[39m in 342ms"),
            "ready in 342ms"
        );
        // Truecolour parses the same way, which is what `ansi.ts` found too.
        assert_eq!(strip_ansi("\u{1b}[38;2;255;0;0merr\u{1b}[0m"), "err");
        // A line with nothing in it is returned whole rather than walked over.
        assert_eq!(strip_ansi("plain text"), "plain text");
        // An OSC — a window title, ended by BEL — takes its payload with it.
        assert_eq!(strip_ansi("\u{1b}]0;vite\u{7}up"), "up");
        // And ended by ST, which is two characters rather than one.
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{1b}\\link"), "link");
        // The two-character family.
        assert_eq!(strip_ansi("a\u{1b}7b"), "ab");
    }

    /// The failure mode worth choosing, stated as a test so it stays chosen: a
    /// sequence this does not understand costs the two characters it read and
    /// not the rest of the line. A stripper that gave up at the first
    /// unrecognised byte would answer a card with a truncated compiler error
    /// and nothing to say it had been truncated.
    #[test]
    fn an_escape_it_does_not_know_costs_two_characters_not_the_line() {
        assert_eq!(strip_ansi("before\u{1b}Zafter"), "beforeafter");
        // An escape at the very end has nothing after it and must not panic.
        assert_eq!(strip_ansi("trailing\u{1b}"), "trailing");
        // Nor an unterminated CSI, which is what a line cut at MAX_LINE gives.
        assert_eq!(strip_ansi("cut\u{1b}[3"), "cut");
    }

    /// Not a nicety: `\r` redraws are kept by `pump_lines` on purpose, so a
    /// progress line arrives with its carriage return intact, and a stripper
    /// that ate control characters wholesale would flatten a build's output
    /// into one unreadable line.
    #[test]
    fn stripping_leaves_everything_that_is_not_an_escape(){
        assert_eq!(strip_ansi("a\tb\r"), "a\tb\r");
    }

    #[test]
    fn one_group_needs_no_naming_and_several_do() {
        let one = [group("a", "dev")];
        assert_eq!(pick_group(&one, "").unwrap().id, "a");

        let two = [group("a", "dev"), group("b", "docs")];
        let why = pick_group(&two, "").unwrap_err();
        // And the refusal says what the choices are, or it is a dead end.
        assert!(why.contains("dev"), "got: {why}");
        assert!(why.contains("docs"), "got: {why}");
    }

    #[test]
    fn a_group_is_named_by_its_label_or_its_id() {
        let gs = [group("a", "dev"), group("b", "docs")];
        assert_eq!(pick_group(&gs, "docs").unwrap().id, "b");
        // Case is not something anybody should have to get right by hand.
        assert_eq!(pick_group(&gs, "DEV").unwrap().id, "a");
        assert_eq!(pick_group(&gs, " dev ").unwrap().id, "a");
        // The id is the escape hatch for everything a label cannot settle.
        assert_eq!(pick_group(&gs, "b").unwrap().id, "b");
    }

    /// Two groups called `dev` in one territory is an ordinary thing to have,
    /// and this is the one place where guessing would start a process nobody
    /// named. The refusal has to carry the ids, since by construction the
    /// labels cannot tell them apart.
    #[test]
    fn an_ambiguous_name_is_refused_rather_than_guessed() {
        let gs = [group("a", "dev"), group("b", "DEV")];
        let why = pick_group(&gs, "dev").unwrap_err();
        assert!(why.contains('a') && why.contains('b'), "got: {why}");
    }

    #[test]
    fn a_name_that_matches_nothing_says_what_there_is() {
        let gs = [group("a", "dev")];
        let why = pick_group(&gs, "web").unwrap_err();
        assert!(why.contains("web"), "names what was asked for: {why}");
        assert!(why.contains("dev"), "and what there is: {why}");

        // A territory with no groups is a different sentence, not a shorter one.
        let why = pick_group(&[], "dev").unwrap_err();
        assert!(why.contains("servers panel"), "got: {why}");
    }

    /* ── the ring ───────────────────────────────────────────────────────── */

    fn said(line: &str) -> Said {
        Said { label: "web".into(), line: line.into(), stderr: false, at: 0 }
    }

    #[test]
    fn the_ring_keeps_its_last_lines_and_counts_what_it_dropped() {
        let mut t = Trace::default();
        for i in 0..(KEEP_LINES + 50) {
            t.push(said(&format!("line {i}")));
        }
        assert_eq!(t.lines.len(), KEEP_LINES);
        assert_eq!(t.dropped, 50);
        // The newest is kept and the oldest is what went.
        assert_eq!(t.lines.back().unwrap().line, format!("line {}", KEEP_LINES + 49));
        assert_eq!(t.lines.front().unwrap().line, "line 50");
    }

    /// The bound that actually runs away. A minified source-map line or a
    /// webpack stack trace reaches `MAX_LINE` having said very little, and
    /// `KEEP_LINES` alone would let one group sit on sixteen megabytes — not a
    /// leak, but a ceiling nobody would have chosen.
    #[test]
    fn a_few_enormous_lines_bite_before_the_line_count_does() {
        let mut t = Trace::default();
        let fat = "x".repeat(MAX_LINE);
        for _ in 0..200 {
            t.push(said(&fat));
        }
        assert!(t.lines.len() < KEEP_LINES, "the byte cap is what bit");
        assert!(t.bytes <= KEEP_BYTES, "and it holds: {} bytes", t.bytes);
        assert!(t.dropped > 0);
    }

    /// `bytes` is carried alongside rather than recomputed, so the one thing
    /// that could silently rot is whether it still describes the deque. A drift
    /// here would not fail anything — it would quietly evict too much or too
    /// little for the rest of the session.
    #[test]
    fn the_byte_count_still_describes_what_is_in_the_ring() {
        let mut t = Trace::default();
        for i in 0..500 {
            t.push(said(&"y".repeat(i % 400)));
        }
        let real: usize = t.lines.iter().map(|l| l.line.len()).sum();
        assert_eq!(t.bytes, real);
    }

    /// One line longer than the whole budget must still leave the ring usable
    /// rather than emptying it every time — `push` evicts until the bound
    /// holds, and with nothing left to evict it has to stop rather than spin.
    #[test]
    fn a_line_bigger_than_the_whole_budget_does_not_wedge_the_ring() {
        let mut t = Trace::default();
        t.push(said(&"z".repeat(KEEP_BYTES * 2)));
        // It is kept — a log with nothing in it would be worse than an oversized
        // one — and the next ordinary line does not push it into a loop.
        t.push(said("after"));
        assert_eq!(t.lines.back().unwrap().line, "after");
    }
}

impl Servers {
    /// Which process each running server is, keyed to its group.
    ///
    /// Only the process we started: `pnpm dev` is node spawning node spawning
    /// esbuild, and the rest of that tree is attributed to the group through its
    /// parent (`perf.rs::ancestry`) rather than tracked here — the job object
    /// already owns the tree, and this is the same tree read the other way.
    pub fn pids(&self) -> HashMap<u32, String> {
        let map = self.running.lock().unwrap();
        let mut out = HashMap::new();
        for (id, group) in map.iter() {
            for s in &group.servers {
                out.insert(s.child.id(), id.clone());
            }
        }
        out
    }

    /// Every server dies with the app — no orphan holding 5173 after a crash.
    pub fn shutdown(&self) {
        let mut map = self.running.lock().unwrap();
        for (_, mut g) in map.drain() {
            for s in g.servers.iter_mut() {
                s.stopped.store(true, Ordering::SeqCst);
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    }
}
