//! Running a project's own verbs.
//!
//! `servers.rs` keeps things up; this keeps things *moving*. A build, a test
//! run, a package, a push — one-shot work with an exit code that matters and
//! output you want to watch go by.
//!
//! Everything here is a *primitive*. What a build is, when a build is a Live
//! Coding patch instead of a process, what "succeeded" reads like in an editor
//! log — none of that is decided here. That is `src/lib/actions.ts`, which is
//! pure and tested; this file spawns, tails, posts and kills, and reports what
//! happened.
//!
//! **Commands arrive as argv, never as a shell string.** Everything goes
//! through `cmd /C call ...`, and cmd does not understand the `\"` escaping that
//! a Windows command line is quoted with — so `C:\Program Files\Epic Games\...`,
//! which is where every engine on earth is installed, would arrive at UBT in
//! three pieces. The `call` matters too: cmd strips the first and last quote of
//! its own tail when that tail begins with one, so a command starting with a
//! quoted path loses it. Beginning with a bare word means there is nothing to
//! strip.
//!
//! **Pipes, not a pseudo-terminal.** This was once the one place that parted
//! company with `servers.rs`; dev servers have since come the same way, for the
//! same reason, so pipes are now what the whole app does. A PTY would be better
//! on paper — colour, and a progress line redrawn with a bare `\r` — but ConPTY
//! does not work on this
//! machine at all. Probed 2026-08-12 on Windows 11 26200 against portable-pty
//! 0.9.0 (the newest published): *every* `openpty`-spawned child died with
//! `0xC0000142` (STATUS_DLL_INIT_FAILED) having emitted only ConPTY's own
//! `ESC[6n`, while the identical command through `std::process::Command` ran
//! fine. `cmd /C ver`, `git.exe` with no shell at all, and the default program
//! all failed the same way, so it is ConPTY and not the argv. `psuedocon.rs`
//! spawns with `STARTF_USESTDHANDLES` and all three handles set to
//! `INVALID_HANDLE_VALUE`, which is the shape that build appears to reject.
//!
//! What that costs is small here, and turned out to be smaller than feared for
//! a dev server too: `pump_lines` splits on `\r` as well as `\n` whatever it is
//! reading, so a redraw still arrives as a line; UBT's `-Progress` markers and
//! the cook's counters are ordinary stdout either way; and `FORCE_COLOR` keeps
//! most of the JavaScript toolchain's colour through a pipe. Both streams are
//! pumped, because cargo and UBT do much of their talking on stderr.
//!
//! The colour ask has since been consolidated into
//! `servers::force_colour` — six variables rather than this one, since cargo,
//! `env_logger` and pytest each read a different name. This file still sets only
//! `FORCE_COLOR`, because what it runs is UBT and package managers rather than a
//! toolchain zoo, and widening it would change what a working chip prints.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::servers::{jobs, pump_lines};

#[derive(Clone, Serialize)]
struct ActionLog {
    run_id: String,
    line: String,
    /// cargo and UBT do much of their talking here.
    stderr: bool,
}

#[derive(Clone, Serialize)]
struct ActionState {
    run_id: String,
    /// "ok" | "failed" | "cancelled"
    state: String,
    code: Option<u32>,
}

/// One thing in flight, keyed by the run id the front end made.
///
/// A run is only ever doing one of these at a time — a cycle closes the editor,
/// *then* builds, *then* reopens — so a single entry per id is enough, and it
/// means `cancel` needs to know nothing about which step is live.
struct Run {
    /// Only for the fallback in `end`; the job is what normally kills.
    pid: Option<u32>,
    stop: Arc<AtomicBool>,
    /// Dropping this takes down everything the command spawned — which for a
    /// build is a great many things, since UBT fans out to cl.exe by the dozen
    /// and none of them stop when the parent does.
    _job: Option<jobs::Job>,
}

#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Run>>);

impl Runs {
    fn take(&self, run_id: &str) -> Option<Run> {
        self.0.lock().unwrap().remove(run_id)
    }

    /// Which process each live run is, for the performance widget. A build fans
    /// out to cl.exe by the dozen and every one of them is attributed to the run
    /// through its parent — see `perf.rs::ancestry`.
    pub fn pids(&self) -> HashMap<u32, String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, run)| run.pid.map(|pid| (pid, id.clone())))
            .collect()
    }

    /// Every run dies with the app, as every dev server does.
    pub fn shutdown(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, run) in map.drain() {
            end(run);
        }
    }
}

/// Stop whatever this run was doing. Dropping the `Run` drops its job object,
/// and that is what takes the process tree down; the `taskkill` is only for the
/// case where no job could be created at all.
fn end(run: Run) {
    run.stop.store(true, Ordering::Relaxed);
    if run._job.is_none() {
        if let Some(pid) = run.pid {
            let _ = quiet(Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]))
                .status();
        }
    }
}

/// No console window flashing up behind a GUI app.
#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

/* ── running a command ────────────────────────────────────────────────────── */

#[tauri::command]
pub fn run_action(
    app: AppHandle,
    runs: State<'_, Runs>,
    run_id: String,
    argv: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    if argv.is_empty() {
        return Err("nothing to run".into());
    }
    /* Whatever this id was doing before, it is not doing it now. */
    if let Some(old) = runs.take(&run_id) {
        end(old);
    }

    /* Through a shell, because half of these are batch files and the other half
       are `.cmd` shims — `pnpm`, `RunUAT.bat`, `Build.bat`. Each argv element is
       quoted once here, by the spawn, which is the only place that can do it
       correctly. */
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("call");
        for a in &argv {
            c.arg(a);
        }
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(&argv[0]);
        c.args(&argv[1..]);
        c
    };

    cmd.current_dir(&cwd)
        /* Nothing here is interactive. A command that stops to ask something —
           git reaching for credentials, a package manager wanting confirmation —
           has to fail rather than sit forever on a stdin no wall can type into. */
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        /* Most of the JavaScript toolchain keeps its colour through a pipe if
           asked, and `ansi.ts` is already there to render it. */
        .env("FORCE_COLOR", "1");
    quiet(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("start {}: {e}", argv[0]))?;

    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    for (stream, is_err) in [
        (child.stdout.take().map(Pipe::Out), false),
        (child.stderr.take().map(Pipe::Err), true),
    ] {
        let Some(mut stream) = stream else { continue };
        let app = app.clone();
        let run_id = run_id.clone();
        std::thread::spawn(move || {
            pump_lines(&mut stream, |line| {
                let _ = app.emit(
                    "action:log",
                    ActionLog {
                        run_id: run_id.clone(),
                        line,
                        stderr: is_err,
                    },
                );
            });
        });
    }

    let stopped = Arc::new(AtomicBool::new(false));
    runs.0.lock().unwrap().insert(
        run_id.clone(),
        Run {
            pid: Some(child.id()),
            stop: stopped.clone(),
            _job: job,
        },
    );

    /* The child waits on its own thread so that waiting never holds the map — a
       build takes minutes, and every other chip on the wall would be queued
       behind this one's lock. */
    std::thread::spawn(move || {
        let status = child.wait();
        /* Take the entry back before announcing, so an `ok` can never race a
           second click into cancelling a run that has already finished. */
        if let Some(state) = app.try_state::<Runs>() {
            let _ = state.take(&run_id);
        }
        let cancelled = stopped.load(Ordering::Relaxed);
        let code = status.as_ref().ok().and_then(|s| s.code()).map(|c| c as u32);
        let _ = app.emit(
            "action:state",
            ActionState {
                run_id,
                state: if cancelled {
                    "cancelled".into()
                } else if status.map(|s| s.success()).unwrap_or(false) {
                    "ok".into()
                } else {
                    "failed".into()
                },
                code,
            },
        );
    });

    Ok(())
}

/// stdout and stderr behind one `Read`, so both can go through `pump_lines`.
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

#[tauri::command]
pub fn cancel_action(runs: State<'_, Runs>, run_id: String) -> Result<(), String> {
    if let Some(run) = runs.take(&run_id) {
        end(run);
    }
    Ok(())
}

/* ── tailing a log ────────────────────────────────────────────────────────── */

/// Watch a file from its current end and emit whatever gets appended.
///
/// The only way to hear back from a *running* Unreal editor. Its Remote Control
/// call returns the moment the editor accepts the command, and the answer —
/// whether the Live Coding patch took, whether the tests passed — appears in
/// its log some seconds later. So the trigger and the result are two different
/// mechanisms, and this is the second one.
///
/// From the end, not the beginning: the log holds the whole session, and a
/// previous compile's "succeeded" would be read as this one's.
#[tauri::command]
pub fn tail_log(
    app: AppHandle,
    runs: State<'_, Runs>,
    run_id: String,
    path: String,
) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};

    if let Some(old) = runs.take(&run_id) {
        end(old);
    }

    let mut at = {
        let mut file = std::fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
        file.seek(SeekFrom::End(0))
            .map_err(|e| format!("{path}: {e}"))?
    };

    let stopped = Arc::new(AtomicBool::new(false));
    runs.0.lock().unwrap().insert(
        run_id.clone(),
        Run {
            pid: None,
            stop: stopped.clone(),
            _job: None,
        },
    );

    std::thread::spawn(move || {
        let mut pending = String::new();
        while !stopped.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(250));
            /* Reopened each pass rather than held: the editor's writer truncates
               and rotates, and a held handle would go on reading a file nothing
               writes to any more. */
            let Ok(mut f) = std::fs::File::open(&path) else {
                continue;
            };
            let len = f.seek(SeekFrom::End(0)).unwrap_or(at);
            if len < at {
                /* Rotated. Start again from the top of the new file. */
                at = 0;
            }
            if len == at || f.seek(SeekFrom::Start(at)).is_err() {
                continue;
            }
            let mut chunk = Vec::new();
            if f.read_to_end(&mut chunk).is_err() {
                continue;
            }
            at += chunk.len() as u64;
            pending.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = pending.find('\n') {
                let line = pending[..nl].trim_end_matches('\r').to_string();
                pending = pending[nl + 1..].to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "action:log",
                    ActionLog {
                        run_id: run_id.clone(),
                        line,
                        /* A log file has one stream, and the editor writes its
                           own errors into it as ordinary lines. */
                        stderr: false,
                    },
                );
            }
        }
        /* No `action:state`: a tail has no verdict of its own. Whoever started
           it is reading the lines and decides when it is over. */
    });

    Ok(())
}

/// The last `max_bytes` of a file, or nothing if there is no such file.
///
/// One caller, and a specific one: a failed Live Coding compile leaves its
/// compiler diagnostics nowhere the editor's own log can see them — they are in
/// UnrealBuildTool's log under `%LOCALAPPDATA%`, and without this a failed
/// build on the wall says "live coding failed" and not one word about why.
///
/// `%VAR%` is expanded here rather than by the caller, because the front end has
/// no business knowing where this machine keeps its app data.
#[tauri::command]
pub fn read_tail(path: String, max_bytes: u64) -> Option<String> {
    use std::io::{Seek, SeekFrom};

    let mut expanded = String::new();
    let mut rest = path.as_str();
    while let Some(open) = rest.find('%') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else { break };
        expanded.push_str(&rest[..open]);
        expanded.push_str(&std::env::var(&after[..close]).unwrap_or_default());
        rest = &after[close + 1..];
    }
    expanded.push_str(rest);

    let mut file = std::fs::File::open(&expanded).ok()?;
    let len = file.seek(SeekFrom::End(0)).ok()?;
    file.seek(SeekFrom::Start(len.saturating_sub(max_bytes))).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/* ── setting a version, and recording that you did ────────────────────────
 *
 * One primitive, told exactly what to write. Which level to bump, what the new
 * number is, which files carry it, what the commit says and what the tag is
 * called are all decided in `actions.ts`, which is pure and tested; where a
 * version lives inside a file of a given shape is `project.rs`, which already
 * had to know in order to read it. What is left here is the part only this side
 * can do: look at the repository as it is *now*, refuse if it is not in a state
 * a release can be cut from, and then write, commit and tag.
 *
 * **It never pushes, and must not grow the ability to.** A push is outward-facing
 * and is asked for every time in this house. It does not need to be added
 * either: a bump leaves the branch one commit ahead of its upstream, so the push
 * chip appears in the same row a tick later, drawn by a mechanism that already
 * exists. The gesture is one deliberate click away and stays deliberate.
 *
 * Two orderings are load-bearing.
 *
 * **Every refusal is asked before anything is written**, and asked *here* rather
 * than taken off the 8-second poll — the whole point of the check is that it is
 * true at the instant of the write, and "the tree was clean eight seconds ago"
 * is exactly the sentence that stops being true on a wall full of agents editing
 * the same repositories.
 *
 * **Every file's new text is computed before any file is written.** A shape
 * `project.rs` cannot edit refuses the whole bump with nothing half-done, rather
 * than leaving two of four files on the new number and a tree nobody asked for.
 *
 * The commit is `git commit -- <paths>`, which commits those paths' working-tree
 * state and nothing else, whatever the index holds. Not `git add` then `commit`,
 * and emphatically not `commit -a`: this wall runs agents in these repositories
 * with `--dangerously-skip-permissions`, and the window between the cleanliness
 * check and the commit is a window one of them can write in. The pathspec form
 * makes "only our files" structural instead of a promise.
 *
 * Hooks are not skipped. A repository with a pre-commit hook has one for a
 * reason, and a bump commit is not the place to start making exceptions — if it
 * fails, the files are left modified, which is visible and recoverable, and the
 * error says so. */

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEdit {
    /// Relative to the root, forward-slashed — a path `git commit --` accepts.
    pub path: String,
    /// "json" | "toml" | "ini" | "lock" — see `project::set_version`.
    pub kind: String,
    /// What the file is expected to say now, and a refusal if it does not.
    ///
    /// A project's facts are probed *once*, when its territory appears on the
    /// wall, so the number a chip's arc did its arithmetic on can be hours old —
    /// and this wall has other cards editing the same repositories. Without this
    /// check a file bumped to 0.9.0 by hand would be written back down to the
    /// 0.8.0 a stale plan computed, over a tag that already exists.
    pub from: String,
    /// What it should say, rendered at this file's own arity — an Unreal
    /// `ProjectVersion` keeps its fourth number where a package.json has three.
    pub to: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BumpPlan {
    pub from: String,
    pub to: String,
    /// `v0.8.0`. Checked for existence before anything is written, because a tag
    /// that is already taken is the one failure with no way forward.
    pub tag: String,
    pub message: String,
    pub files: Vec<VersionEdit>,
}

/// git, with every way it could stop and ask something shut off.
///
/// None of these calls touch the network, but the rule is about the shape rather
/// than the call: a command that can put up Git Credential Manager's window is a
/// command that eventually does, and there is no terminal here to answer it.
fn git(root: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(["--no-optional-locks", "-c", "credential.interactive=false"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    quiet(&mut cmd);
    cmd
}

/// `(ok, stdout, stderr)`.
fn git_out(root: &str, args: &[&str]) -> (bool, String, String) {
    match git(root).args(args).output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

#[tauri::command]
pub async fn bump_version(root: String, plan: BumpPlan) -> Result<String, String> {
    /* `off_main`, because this is three git spawns and a pre-commit hook can
       take seconds. Blocking on the main thread would stop every card on the
       wall from being painted for exactly that long — see the note in lib.rs. */
    crate::off_main(move || bump(&root, &plan)).await?
}

fn bump(root: &str, plan: &BumpPlan) -> Result<String, String> {
    let dir = Path::new(root);

    if plan.files.is_empty() {
        return Err("nothing declares a version here".into());
    }

    /* ── is this a repository a release can be cut from? ── */

    /* Half-done *before* the branch, because during a rebase HEAD is detached
       by design — git checks the commit it is replaying onto out. Asking the
       branch question first told a stopped rebase it was "not on a branch",
       which is true and is not the thing that needs saying. */
    if let Some(op) = crate::project::git_operation(root) {
        return Err(format!("there is a {op} half-done here — finish it first"));
    }

    let (ok, branch, _) = git_out(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if !ok || branch.is_empty() {
        return Err(
            "HEAD is not on a branch — a tag needs a commit and a commit needs somewhere to go"
                .into(),
        );
    }

    let (ok, dirty, err) = git_out(root, &["status", "--porcelain", "-uno"]);
    if !ok {
        return Err(format!("could not read the status: {}", first_line(&err)));
    }
    if !dirty.is_empty() {
        /* Named, not counted: "the tree is dirty" sends you to a terminal to
           find out what, and the answer is usually one file you had forgotten.
           Untracked files are deliberately not in this — `-uno` — since the
           commit stages named paths and cannot pick one up.
           `XY PATH`, split on the *first* space rather than sliced at a fixed
           offset: `git_out` trims the whole of stdout, so an unstaged-only
           change (`" M path"`, X being a space) arrives one character short and
           a `[3..]` took a letter off the front of every filename. */
        let mut names: Vec<&str> = dirty
            .lines()
            .filter_map(|l| l.trim_start().splitn(2, ' ').nth(1))
            .map(str::trim)
            .take(3)
            .collect();
        if dirty.lines().count() > names.len() {
            names.push("…");
        }
        return Err(format!(
            "the tree has uncommitted changes ({}) — a version bump has to be a commit of its own",
            names.join(", ")
        ));
    }

    let (exists, _, _) = git_out(
        root,
        &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{}", plan.tag)],
    );
    if exists {
        return Err(format!(
            "{} already exists — {} has been released from here before",
            plan.tag, plan.to
        ));
    }

    /* ── every new text first, then every write ── */

    let mut pending: Vec<(PathBuf, String)> = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    for f in &plan.files {
        let path = dir.join(&f.path);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("{}: {e}", f.path))?;
        let (was, next) = if f.kind == "lock" {
            let name = crate::project::lock_crate(dir, &f.path)
                .ok_or_else(|| format!("{}: no Cargo.toml beside it to name the crate", f.path))?;
            crate::project::set_lock_version(&text, &name, &f.to)
        } else {
            crate::project::set_version(&f.kind, &text, &f.to)
        }
        .ok_or_else(|| {
            format!(
                "{} no longer has a version to set — it may have been edited since the wall read it",
                f.path
            )
        })?;
        if was != f.from {
            return Err(format!(
                "{} says {was}, not {} — the wall's reading is stale, so nothing was written",
                f.path, f.from
            ));
        }
        if next != text {
            changed.push(f.path.clone());
            pending.push((path, next));
        }
    }

    if changed.is_empty() {
        return Err(format!("every file already says {}", plan.to));
    }

    for (path, text) in &pending {
        std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    }

    /* ── record it ── */

    let mut args = vec!["commit", "-m", &plan.message, "--"];
    for p in &changed {
        args.push(p);
    }
    let (ok, out, err) = git_out(root, &args);
    if !ok {
        return Err(format!(
            "the files are on {} but the commit did not go through: {}",
            plan.to,
            first_line(if err.is_empty() { &out } else { &err })
        ));
    }

    /* Annotated, like every tag this repository already carries, and with the
       commit's own message on it — an annotated tag is a real object with an
       author and a date, which is what a release wants; `-m` is what keeps it
       from opening an editor there is no terminal to type in. */
    let (ok, out, err) = git_out(root, &["tag", "-a", &plan.tag, "-m", &plan.message]);
    if !ok {
        return Err(format!(
            "committed {} but could not tag it: {}",
            plan.to,
            first_line(if err.is_empty() { &out } else { &err })
        ));
    }

    Ok(format!(
        "{} → {} · {} file{} · tagged {} on {branch}",
        plan.from,
        plan.to,
        changed.len(),
        if changed.len() == 1 { "" } else { "s" },
        plan.tag,
    ))
}

/// The first line with anything on it. git says a great deal on a failure and a
/// chip's note has room for one line of it.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("no output")
        .to_string()
}

#[cfg(test)]
mod bump_tests {
    use super::*;

    /* Against a real repository, because every one of these is a fact about
       what git does rather than about our arithmetic — and because the whole
       point of the refusals is that they are true of the working tree at the
       instant of the write. A pure test could not tell a refusal that works from
       one that is spelled correctly. */

    struct Repo(PathBuf);

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("skein-bump-{name}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Repo(dir);
            repo.run(&["init", "-b", "main"]);
            /* A test must not depend on this machine's identity, or on whether
               its owner signs commits — a global `commit.gpgsign` would fail
               every commit here with no key and no prompt to answer. */
            for (k, v) in [
                ("user.name", "skein tests"),
                ("user.email", "tests@localhost"),
                ("commit.gpgsign", "false"),
                ("tag.gpgsign", "false"),
            ] {
                repo.run(&["config", k, v]);
            }
            repo
        }

        fn at(&self) -> &str {
            self.0.to_str().unwrap()
        }

        /// Through `git_out` rather than `status`, so git's own chatter is
        /// captured instead of printed over the test run's output.
        fn run(&self, args: &[&str]) -> bool {
            git_out(self.at(), args).0
        }

        fn write(&self, rel: &str, text: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }

        fn read(&self, rel: &str) -> String {
            std::fs::read_to_string(self.0.join(rel)).unwrap()
        }

        fn commit_all(&self, message: &str) {
            self.run(&["add", "-A"]);
            self.run(&["commit", "-m", message]);
        }

        /// Subjects only. `--oneline` prefixes an abbreviated sha, which is
        /// not what any of these assertions are about.
        fn log(&self) -> String {
            git_out(self.at(), &["log", "--format=%s"]).1
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const PKG_AT: &str = "{\n  \"name\": \"thing\",\n  \"version\": \"0.7.0\"\n}\n";

    fn plan(from: &str, to: &str) -> BumpPlan {
        BumpPlan {
            from: from.into(),
            to: to.into(),
            tag: format!("v{to}"),
            message: format!("thing: {to}"),
            files: vec![VersionEdit {
                path: "package.json".into(),
                kind: "json".into(),
                from: from.into(),
                to: to.into(),
            }],
        }
    }

    #[test]
    fn a_clean_repo_is_written_committed_and_tagged() {
        let repo = Repo::new("clean");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");

        let said = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap();
        assert!(said.contains("0.7.0 → 0.8.0"), "{said}");
        assert!(said.contains("v0.8.0"), "{said}");
        assert!(said.contains("main"), "{said}");

        assert!(repo.read("package.json").contains("\"version\": \"0.8.0\""));
        /* One commit, with the message the plan asked for. */
        assert!(repo.log().starts_with("thing: 0.8.0"));
        assert_eq!(repo.log().lines().count(), 2);
        /* Annotated, like every tag this project's own repository carries — a
           real object with an author and a date, not a pointer. */
        assert_eq!(
            git_out(repo.at(), &["cat-file", "-t", "v0.8.0"]).1,
            "tag"
        );
        /* And nothing left over: the tree is clean again. */
        assert_eq!(git_out(repo.at(), &["status", "--porcelain"]).1, "");
    }

    /// The one thing this must never do. A bump leaves the branch one commit
    /// ahead of nothing at all — there is no remote here and it did not want one.
    #[test]
    fn nothing_reaches_a_remote() {
        let repo = Repo::new("no-remote");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");
        /* A remote that does not resolve: a push would fail loudly, so if one
           were attempted this would not come back Ok. */
        repo.run(&["remote", "add", "origin", "https://127.0.0.1:1/nope.git"]);
        assert!(bump(repo.at(), &plan("0.7.0", "0.8.0")).is_ok());
        /* Nothing was fetched or pushed, so there is no remote-tracking ref. */
        assert_eq!(
            git_out(repo.at(), &["rev-parse", "--verify", "--quiet", "origin/main"]).1,
            ""
        );
    }

    /// A version bump has to be a commit of its own, and on this wall the tree
    /// is very often somebody else's half-finished work.
    #[test]
    fn a_dirty_tree_refuses_and_writes_nothing() {
        let repo = Repo::new("dirty");
        repo.write("package.json", PKG_AT);
        repo.write("other.txt", "before\n");
        repo.commit_all("first");
        repo.write("other.txt", "mid-edit\n");

        let err = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        /* Named, so it does not send you to a terminal to find out what. */
        assert!(err.contains("other.txt"), "{err}");
        assert!(repo.read("package.json").contains("0.7.0"));
        assert!(repo.log().starts_with("first"));
    }

    /// Untracked files are deliberately *not* dirtiness here: the commit names
    /// its paths, so it cannot pick one up, and on an Unreal project `Saved/`
    /// alone would refuse every bump forever.
    #[test]
    fn an_untracked_file_is_not_in_the_way() {
        let repo = Repo::new("untracked");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");
        repo.write("scratch.log", "noise\n");

        assert!(bump(repo.at(), &plan("0.7.0", "0.8.0")).is_ok());
        /* And it is still untracked afterwards — the commit took our file only. */
        assert_eq!(
            git_out(repo.at(), &["status", "--porcelain"]).1,
            "?? scratch.log"
        );
    }

    #[test]
    fn a_tag_that_already_exists_refuses() {
        let repo = Repo::new("tagged");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");
        repo.run(&["tag", "-a", "v0.8.0", "-m", "released before"]);

        let err = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap_err();
        assert!(err.contains("v0.8.0 already exists"), "{err}");
        assert!(repo.read("package.json").contains("0.7.0"));
    }

    #[test]
    fn a_detached_head_refuses() {
        let repo = Repo::new("detached");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");
        repo.run(&["checkout", "--detach", "HEAD"]);

        let err = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap_err();
        assert!(err.contains("not on a branch"), "{err}");
    }

    /// A project's facts are probed once, when its territory appears. So the
    /// number a chip did its arithmetic on can be hours old, and this wall has
    /// other cards editing the same repositories.
    #[test]
    fn a_stale_reading_refuses_rather_than_going_backwards() {
        let repo = Repo::new("stale");
        /* Somebody bumped it by hand since the wall last looked. */
        repo.write("package.json", "{\n  \"version\": \"0.9.0\"\n}\n");
        repo.commit_all("first");

        let err = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap_err();
        assert!(err.contains("says 0.9.0"), "{err}");
        assert!(err.contains("stale"), "{err}");
        assert!(repo.read("package.json").contains("0.9.0"));
        assert!(repo.log().starts_with("first"));
    }

    /// Nothing is written until every file's new text has been computed, so one
    /// shape that cannot be edited leaves the other files alone rather than
    /// half-done.
    #[test]
    fn one_unwritable_file_refuses_the_whole_bump() {
        let repo = Repo::new("partial");
        repo.write("package.json", PKG_AT);
        repo.write("Cargo.toml", "[package]\nname = \"thing\"\nversion.workspace = true\n");
        repo.commit_all("first");

        let mut p = plan("0.7.0", "0.8.0");
        p.files.push(VersionEdit {
            path: "Cargo.toml".into(),
            kind: "toml".into(),
            from: "0.7.0".into(),
            to: "0.8.0".into(),
        });

        let err = bump(repo.at(), &p).unwrap_err();
        assert!(err.contains("Cargo.toml"), "{err}");
        /* The package.json it *could* have written is untouched. */
        assert!(repo.read("package.json").contains("0.7.0"));
        assert!(repo.log().starts_with("first"));
    }

    /// A rebase stopped part-way can have a perfectly clean tree, so
    /// cleanliness is not the whole of the check.
    #[test]
    fn a_half_done_operation_refuses() {
        let repo = Repo::new("mid-rebase");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");
        repo.write("a.txt", "ours\n");
        repo.commit_all("second");
        repo.run(&["checkout", "-b", "side", "HEAD~1"]);
        repo.write("a.txt", "theirs\n");
        repo.commit_all("third");
        /* Conflicts on `a.txt`, leaving `rebase-merge` behind. */
        repo.run(&["rebase", "main"]);
        /* Reset the conflict so the tree is clean but the rebase is not over —
           which is exactly the state cleanliness alone would miss. */
        repo.run(&["checkout", "--ours", "--", "a.txt"]);
        repo.run(&["add", "a.txt"]);

        let err = bump(repo.at(), &plan("0.7.0", "0.8.0")).unwrap_err();
        assert!(err.contains("a rebase half-done"), "{err}");
    }

    /// A plan with no files is not a bump, and must not become an empty commit.
    #[test]
    fn nothing_to_write_is_not_a_commit() {
        let repo = Repo::new("nothing");
        repo.write("package.json", PKG_AT);
        repo.commit_all("first");

        let mut p = plan("0.7.0", "0.8.0");
        p.files.clear();
        assert!(bump(repo.at(), &p).is_err());
        assert_eq!(repo.log().lines().count(), 1);
    }
}

/* ── talking to a running editor ──────────────────────────────────────────── */

/// Send one console command to the editor over its Remote Control HTTP API.
///
/// Loopback only, and `ExecuteConsoleCommand` has to be allowlisted in the
/// project's `Config/DefaultRemoteControl.ini` or the editor answers 4xx — which
/// is worth repeating back rather than swallowing, since "nothing happened" and
/// "the plugin was not loaded" look identical from the wall.
///
/// Written against a raw socket rather than an HTTP client crate for the same
/// reason `ask.rs` is: the request is four lines and the server is on this
/// machine.
#[tauri::command]
pub async fn unreal_exec(port: u16, command: String) -> Result<String, String> {
    let body = serde_json::json!({
        "objectPath": "/Script/Engine.Default__KismetSystemLibrary",
        "functionName": "ExecuteConsoleCommand",
        "parameters": { "Command": command },
    })
    .to_string();

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut sock = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| {
        format!("no editor listening on {port} ({e}) — is the RemoteControl plugin loaded?")
    })?;
    sock.set_read_timeout(Some(Duration::from_secs(10))).ok();

    let req = format!(
        "PUT /remote/object/call HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(req.as_bytes())
        .map_err(|e| format!("could not reach the editor: {e}"))?;

    let mut answer = String::new();
    sock.read_to_string(&mut answer)
        .map_err(|e| format!("no answer from the editor: {e}"))?;

    let status = answer
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    if status.starts_with('2') {
        Ok(answer)
    } else {
        Err(format!(
            "the editor refused it ({}) — is ExecuteConsoleCommand allowlisted in Config/DefaultRemoteControl.ini?",
            if status.is_empty() { "no status" } else { status }
        ))
    }
}

/* ── processes and their windows ──────────────────────────────────────────── */

/// Start something and let go of it.
///
/// The editor outlives Skein on purpose — closing the wall must not take a
/// day's unsaved level work with it — so this is the one spawn in the app that
/// is deliberately *not* in a job object.
#[tauri::command]
pub fn launch_detached(program: String, args: Vec<String>, cwd: String) -> Result<u32, String> {
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .map(|c| c.id())
        .map_err(|e| format!("could not start {program}: {e}"))
}

#[cfg(windows)]
fn windows_of(pid: u32) -> Vec<isize> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct Hunt {
        pid: u32,
        found: Vec<isize>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let hunt = &mut *(lparam.0 as *mut Hunt);
            if IsWindowVisible(hwnd).as_bool() {
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == hunt.pid {
                    hunt.found.push(hwnd.0 as isize);
                }
            }
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
    hunt.found
}

/// Bring a process's window to the front — the whole of what "the editor is
/// already open" should cost.
#[tauri::command]
pub fn focus_process(pid: u32) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, ShowWindow, SW_RESTORE,
        };
        for h in windows_of(pid) {
            let hwnd = HWND(h as *mut core::ffi::c_void);
            unsafe {
                /* Restore first: a minimised window can be brought forward and
                   still be a taskbar button. */
                let _ = ShowWindow(hwnd, SW_RESTORE);
                if SetForegroundWindow(hwnd).as_bool() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("focusing a window is implemented for windows only".into())
    }
}

/// Ask a process to close, the way clicking its × does.
///
/// WM_CLOSE rather than a kill, and the difference is the whole point: the
/// editor gets to put up its "save your changes?" prompt. A cycle that threw
/// away an afternoon of level edits would be used exactly once.
#[tauri::command]
pub fn close_process(pid: u32) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
        let mut asked = false;
        for h in windows_of(pid) {
            let hwnd = HWND(h as *mut core::ffi::c_void);
            unsafe {
                if PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() {
                    asked = true;
                }
            }
        }
        Ok(asked)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err("closing a window is implemented for windows only".into())
    }
}

/// Is this process still there? What a cycle waits on between closing the
/// editor and building — and cheap enough to ask once a second, which the
/// command-line sweep in `project.rs` very much is not.
#[tauri::command]
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let alive = GetExitCodeProcess(h, &mut code).is_ok() && code == STILL_ACTIVE;
            let _ = CloseHandle(h);
            alive
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

