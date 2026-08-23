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

use std::collections::HashMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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
}

/// Private field: the running map is only ever touched from this module, and
/// exposing it would leak the private RunningGroup type.
#[derive(Default)]
pub struct Servers(Mutex<HashMap<String, RunningGroup>>);

#[derive(Clone, Serialize)]
struct ServerLog {
    group_id: String,
    label: String,
    line: String,
    stderr: bool,
}

#[derive(Clone, Serialize)]
struct ServerState {
    group_id: String,
    label: String,
    /// "starting" | "up" | "down" | "exited"
    state: String,
    code: Option<i32>,
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
            exit_if_last(app, group_id, &spec.label, &left, &stopped);
            continue;
        };
        let app = app.clone();
        let group_id = group_id.to_string();
        let label = spec.label.clone();
        let left = left.clone();
        let stopped = stopped.clone();
        std::thread::spawn(move || {
            pump_lines(&mut stream, |text| {
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
            exit_if_last(&app, &group_id, &label, &left, &stopped);
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
    let _ = app.emit(
        "server:state",
        ServerState {
            group_id: group_id.to_string(),
            label: label.to_string(),
            state: "exited".into(),
            code: None,
        },
    );
}

#[tauri::command]
pub fn start_group(
    app: AppHandle,
    servers: State<'_, Servers>,
    group: ServerGroup,
    cwd: String,
) -> Result<(), String> {
    /* Inline rather than calling stop_group — State isn't cloneable, and a
       restart must fully release the old tree before the new one binds ports. */
    if let Some(mut old) = servers.0.lock().unwrap().remove(&group.id) {
        for s in old.servers.iter_mut() {
            /* Before the kill, so the flag is up by the time the pipes close. */
            s.stopped.store(true, Ordering::SeqCst);
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
        old.servers.clear();
    }

    let mut running = Vec::new();
    for spec in &group.servers {
        let _ = app.emit(
            "server:state",
            ServerState {
                group_id: group.id.clone(),
                label: spec.label.clone(),
                state: "starting".into(),
                code: None,
            },
        );
        match spawn_one(&app, &group.id, spec, &cwd) {
            Ok(s) => running.push(s),
            Err(e) => {
                let _ = app.emit(
                    "server:state",
                    ServerState {
                        group_id: group.id.clone(),
                        label: spec.label.clone(),
                        state: "exited".into(),
                        code: None,
                    },
                );
                let _ = app.emit(
                    "server:log",
                    ServerLog {
                        group_id: group.id.clone(),
                        label: spec.label.clone(),
                        line: e,
                        stderr: true,
                    },
                );
            }
        }
    }

    servers
        .0
        .lock()
        .unwrap()
        .insert(group.id.clone(), RunningGroup { servers: running });

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
    std::thread::spawn(move || {
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(500));
            let mut all_known = true;
            for spec in &group2.servers {
                let Some(port) = spec.port else {
                    continue;
                };
                if !port_open(port) {
                    all_known = false;
                    continue;
                }
                let _ = app2.emit(
                    "server:state",
                    ServerState {
                        group_id: group2.id.clone(),
                        label: spec.label.clone(),
                        state: "up".into(),
                        code: None,
                    },
                );
            }
            if all_known {
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_group(servers: State<'_, Servers>, group_id: String) -> Result<(), String> {
    if let Some(mut g) = servers.0.lock().unwrap().remove(&group_id) {
        for s in g.servers.iter_mut() {
            /* A group taken down on purpose reads `idle`, not `exited`. The
               front end clears its health on stop, so a late `exited` from the
               closing pipes would put it straight back — and this rule already
               says elsewhere that groups down for a reason must not look like
               groups that failed. */
            s.stopped.store(true, Ordering::SeqCst);
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
        /* Dropping each job object takes down anything the children spawned. */
        g.servers.clear();
    }
    Ok(())
}

#[tauri::command]
pub fn group_running(servers: State<'_, Servers>, group_id: String) -> bool {
    servers.0.lock().unwrap().contains_key(&group_id)
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

#[cfg(test)]
mod tests {
    use super::*;

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
}

impl Servers {
    /// Which process each running server is, keyed to its group.
    ///
    /// Only the process we started: `pnpm dev` is node spawning node spawning
    /// esbuild, and the rest of that tree is attributed to the group through its
    /// parent (`perf.rs::ancestry`) rather than tracked here — the job object
    /// already owns the tree, and this is the same tree read the other way.
    pub fn pids(&self) -> HashMap<u32, String> {
        let map = self.0.lock().unwrap();
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
        let mut map = self.0.lock().unwrap();
        for (_, mut g) in map.drain() {
            for s in g.servers.iter_mut() {
                s.stopped.store(true, Ordering::SeqCst);
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    }
}
