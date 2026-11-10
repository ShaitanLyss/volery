//! What this wall does when it dies rather than closes.
//!
//! On 2026-11-10 at 12:58 a wall that had been up for three hours vanished
//! while nobody was in front of it. Windows had it — `skein.exe 0.101.0`,
//! `0xc0000409` with exception data `7`, on a worker thread — and `volery.log`
//! had **not one line**, from the crash or about it. Nothing restarted it
//! either; the wall came back two minutes later because a person opened it.
//! The panic hook would have written a line and said so in the chronicle, so
//! the obvious reading was that this was not a panic — and it was not.
//!
//! The dump says what it was: a `Vec` growth asked the allocator for a new
//! block, got null back, and Rust's allocation-failure hook ran and then
//! `__fastfail(FAST_FAIL_FATAL_APP_EXIT)`ed the process. The wall had run out
//! of memory. There was no message anywhere because a `windows_subsystem =
//! "windows"` process writes its stderr into nothing.
//!
//! ### Why an observer, and not an exception filter
//!
//! The first attempt was `SetUnhandledExceptionFilter`, which is what a crash
//! handler is *for*. It is inert here, and that was measured rather than
//! assumed: a probe (`ffprobe.rs`, 2026-11-10) that installs both a vectored
//! handler and an unhandled-exception filter and then calls
//! `std::process::abort()` gets **neither** called — while the same probe with
//! a null dereference gets both. Fast-fail is `int 29h`, which the kernel
//! delivers straight to Windows Error Reporting precisely *because* the process
//! state may be corrupt; no user-mode handler is consulted, by design. So the
//! only thing that can see a crash of this kind is a process that is not the
//! one crashing.
//!
//! That is this module: `watch_for` starts a second copy of this same binary
//! (`--watch-wall <pid> <log dir>`) at launch, outside every job, which waits
//! on the wall's process handle and — when the wall exits with an exception
//! code — writes what it can see, restarts the wall, and disappears.
//!
//! The exception filter is kept anyway, because it *does* fire for the crashes
//! that are ordinary faults (an access violation, heap corruption), and it is
//! the only thing that can name the module and offset of one. It writes that
//! into the same record and restarts nothing, so there is exactly one restarter.
//!
//! ### What a dying wall owes, and where each goes
//!
//! - **A line in the log**, flushed at once. `applog` batches through a sluice,
//!   so a line merely pushed is one the process dies before writing.
//! - **Its stderr to a file.** `SetStdHandle` sends stderr to `logs/stderr.log`
//!   for the life of the launch — which is where that `memory allocation of N
//!   bytes failed` line was going to go, had anything been listening. It is
//!   truncated at launch, since this holds a process's dying words and not a
//!   history.
//! - **`died.json` beside the log**, which the **next** launch turns into a
//!   chronicle row (`landed`) — the shape `update::Underway` already had, and
//!   for its reason: the process that could have said this is the one that did
//!   not survive.
//! - **The wall back up.** Through a plain spawn from the observer, which
//!   already outlives the wall — not `update::relaunch_after_exit`'s detached
//!   PowerShell, which exists because the *dying* process cannot be the parent
//!   of its own successor. Bounded by the freeze watchdog's own rule
//!   (`watchdog::may_restart`): `SKEIN_NO_REVIVE`, and not within `REVIVE_GAP`
//!   of the last restart, so a wall that dies on launch comes back once and
//!   then stays down instead of becoming a loop.

use tauri::AppHandle;

/// The record a dying run leaves for the next launch, beside the log.
const DIED: &str = "died.json";

/// Where this launch's stderr goes. See `watch`.
const STDERR: &str = "stderr.log";

/// Where the launch before this one's did. One generation is worth keeping:
/// the wall that comes back from a crash is the one that would otherwise
/// truncate the dying words `landed` reads.
const STDERR_PREV: &str = "stderr.prev.log";

/// The switch the observer is started with.
const WATCH: &str = "--watch-wall";

/// What killed this process, as the next launch reads it.
///
/// Every field but the code is best-effort: the observer knows the code and
/// the machine, the exception filter knows the location, and a crash early in
/// a launch may leave neither.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
struct Died {
    /// Milliseconds since the epoch, for a record that has to sort.
    #[serde(default)]
    at: i64,
    /// The wall's local clock, because a row saying "12:58" is the one thing a
    /// person can line up against their own afternoon.
    #[serde(default)]
    hour: u16,
    #[serde(default)]
    minute: u16,
    /// The exception code, as Windows gave it (`0xc0000409`).
    #[serde(default)]
    code: u32,
    #[serde(default)]
    version: String,
    /// Whether this wall was started again before the observer left.
    #[serde(default)]
    relaunched: bool,
    /// The module the faulting address fell in, and the offset into it —
    /// written by the exception filter, so only for the crashes it can see.
    #[serde(default)]
    module: Option<String>,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    thread: Option<u32>,
    #[serde(default)]
    thread_name: Option<String>,
    /// What the wall was holding when it went, in MB — the reading that turns
    /// "an abort" into "an allocation it could not have".
    #[serde(default)]
    peak_mb: Option<u64>,
    /// Where Windows left the dump, when it left one.
    #[serde(default)]
    dump: Option<String>,
}

/* ── in the wall ─────────────────────────────────────────────────────────── */

/// Install the last-chance handler and send stderr somewhere readable.
/// Called once, from `run`, beside `speak_for_panics`.
pub fn watch() {
    #[cfg(debug_assertions)]
    crash_on_purpose();
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter;
        SetUnhandledExceptionFilter(Some(on_crash));
    }
    /* `redirect_stderr` is deliberately *not* here: it needs the log directory,
       which does not exist until `applog::install` has run. `open_wall` calls it
       the moment that returns. */
}

/// Start the observer. Called once, from `open_wall`, because that is where the
/// log directory is known and a wall that could not open its store never got
/// this far anyway.
pub fn watch_for() {
    let Some(dir) = crate::applog::dir() else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(WATCH).arg(std::process::id().to_string()).arg(&dir);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /* A hidden console rather than `DETACHED_PROCESS`: this is the same
           trap `update::detached_powershell` records. No job is created for it
           — nothing here is spawned into one — so it outlives the wall's own
           job objects by being outside them. */
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(c) => log::info!(target: "crash", "watching this wall from pid {}", c.id()),
        Err(e) => log::warn!(target: "crash", "no observer: this wall's death would go unrecorded ({e})"),
    }
}

/// Turn the record a dying run left into the row it owed, then delete it.
/// Called once at launch, beside `update::landed`.
pub fn landed(app: &AppHandle) {
    let Some(dir) = crate::applog::dir() else { return };
    let at = dir.join(DIED);
    let Ok(text) = std::fs::read_to_string(&at) else { return };
    let _ = std::fs::remove_file(&at);
    let Ok(died) = serde_json::from_str::<Died>(&text) else { return };
    let (level, mark, mut detail) = landing(&died);
    if let Some(words) = last_words(&dir) {
        detail.push_str(&format!(" Its own last words: {words}"));
    }
    crate::chronicle::note(app, None, "volery", level, &mark, &detail);
}

/// The last thing the dying process said on stderr, when it said something
/// worth repeating.
///
/// This is the half the 2026-11-10 dump had to be unwound to recover: Rust's
/// allocation-failure path prints `memory allocation of N bytes failed` — the
/// exact request that could not be met — before it fast-fails, and in a
/// GUI-subsystem process that line went into an invalid handle. It survives one
/// launch, in `stderr.prev.log`, because the wall that comes back rotates it.
fn last_words(dir: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(STDERR_PREV)).ok()?;
    text.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && (l.contains("memory allocation of") || l.contains("panicked at")))
        .map(|l| l.chars().take(200).collect())
}

/* ── the observer ────────────────────────────────────────────────────────── */

/// Answer the observer's command line, if this process was started as one.
/// Called from `main`, beside `hooks::intercept` and for its reason: neither may
/// open a store or a window.
pub fn intercept() -> bool {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let Some(i) = args.iter().position(|a| a == WATCH) else { return false };
    let pid = args.get(i + 1).and_then(|p| p.to_str()).and_then(|p| p.parse::<u32>().ok());
    let dir = args.get(i + 2).map(std::path::PathBuf::from);
    match (pid, dir) {
        (Some(pid), Some(dir)) => {
            observe(pid, dir);
            true
        }
        _ => true, /* malformed: there is nothing to watch and no wall to be */
    }
}

#[cfg(windows)]
fn observe(pid: u32, dir: std::path::PathBuf) {
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, INFINITE,
    };

    let handle = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid)
    };
    let Ok(handle) = handle else {
        say(&dir, &format!("wall {pid}: could not be opened, so its death is unrecorded"));
        return;
    };
    unsafe {
        let waited = WaitForSingleObject(handle, INFINITE);
        let mut code = 0u32;
        let _ = GetExitCodeProcess(handle, &mut code);
        if waited != WAIT_OBJECT_0 {
            let _ = CloseHandle(handle);
            return;
        }
        /* The process object outlives the process while a handle is open, so
           the counters are still there to be read — which is what makes "it
           was holding 3.1 GB" sayable about a wall that is already gone. */
        let mut mem = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let peak = GetProcessMemoryInfo(handle, &mut mem, mem.cb)
            .ok()
            .map(|_| (mem.PeakWorkingSetSize / (1024 * 1024)) as u64);
        let _ = CloseHandle(handle);

        if !died_of(code) {
            /* A close somebody asked for, a kill, a logoff. Not ours to answer. */
            return;
        }
        /* The dump first, because waiting for it is a wait: the clock is read
           after it so the row names the minute the wall died in rather than the
           minute the observer started waiting. */
        let dump = await_dump(pid, std::time::Duration::from_secs(10));
        let (hour, minute) = clock();
        let mut died = read_record(&dir).unwrap_or_default();
        died.at = now_ms();
        died.hour = hour;
        died.minute = minute;
        died.code = code;
        died.version = env!("CARGO_PKG_VERSION").to_string();
        died.peak_mb = peak;
        died.dump = dump.clone();

        let relaunched = if may_relaunch() { match restart(&dir) { Ok(p) => {
            say(&dir, &format!("wall {pid} died of {}, so {p} was started", hex(code)));
            true
        } _ => {
            say(&dir, &format!("wall {pid} died of {} and could not be started again", hex(code)));
            false
        } } } else {
            say(&dir, &format!(
                "wall {pid} died of {}; not restarting (revival is off, or one already happened inside the half hour)",
                hex(code)
            ));
            false
        };
        died.relaunched = relaunched;
        leave(&dir, &died);
    }
}

#[cfg(not(windows))]
fn observe(_pid: u32, _dir: std::path::PathBuf) {}

/// Whether this exit code is the process dying rather than leaving.
///
/// Windows exits an unhandled exception with the exception code itself, and
/// every NTSTATUS error lives in `0xC0000000..=0xCFFFFFFF`. A clean close exits
/// 0, a `taskkill /F` exits 1, a logoff exits `0x40010004` — none of those are
/// this, which is the whole of why the test is a range rather than "not zero".
fn died_of(code: u32) -> bool {
    code & 0xC000_0000 == 0xC000_0000
}

/// Whether this wall may be started again. The freeze watchdog's own bound,
/// reused rather than restated: `SKEIN_NO_REVIVE`, and not within `REVIVE_GAP`
/// of the last restart — which for a crash is the one that started *this* wall,
/// since `VOLERY_REVIVED_AT` rides into it.
fn may_relaunch() -> bool {
    crate::watchdog::may_restart()
}

/// Start the wall again, as its own process rather than as this one's child in
/// anything but name: the observer exits the moment it has done so.
#[cfg(windows)]
fn restart(dir: &std::path::Path) -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.env("VOLERY_REVIVED_AT", now_ms().to_string());
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(c) => Ok(c.id()),
        Err(e) => {
            say(dir, &format!("could not start the wall again: {e}"));
            Err(e.to_string())
        }
    }
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows writes the dump a moment after the process goes, so the path is
/// waited for rather than sampled once.
#[cfg(windows)]
fn await_dump(pid: u32, within: std::time::Duration) -> Option<String> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let name = std::env::current_exe().ok()?.file_name()?.to_string_lossy().to_string();
    let path = std::path::PathBuf::from(local).join("CrashDumps").join(format!("{name}.{pid}.dmp"));
    let until = std::time::Instant::now() + within;
    while std::time::Instant::now() < until {
        if path.is_file() {
            return Some(path.to_string_lossy().to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    None
}

/// The observer's own account, in the file the update relauncher already writes
/// to: one place to look when a wall came back and nobody knows why.
fn say(dir: &std::path::Path, line: &str) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("relaunch.log"))
    {
        let _ = writeln!(f, "{} [watch] {line}", stamp());
    }
}

fn stamp() -> String {
    let (h, m) = clock();
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() % 60)
        .unwrap_or(0);
    format!("{h:02}:{m:02}:{s:02}")
}

fn read_record(dir: &std::path::Path) -> Option<Died> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(DIED)).ok()?).ok()
}

fn leave(dir: &std::path::Path, d: &Died) {
    let _ = std::fs::create_dir_all(dir);
    if let Ok(text) = serde_json::to_string(d) {
        let _ = std::fs::write(dir.join(DIED), text);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hex(code: u32) -> String {
    format!("{code:#010x}")
}

/// The local clock, in the two fields a person reads. Windows' own, since the
/// standard library knows only UTC and this crate has no timezone dependency.
#[cfg(windows)]
fn clock() -> (u16, u16) {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    (t.wHour, t.wMinute)
}

#[cfg(not(windows))]
fn clock() -> (u16, u16) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (((secs / 3600) % 24) as u16, ((secs / 60) % 60) as u16)
}

/* ── the exception filter ────────────────────────────────────────────────── */

#[cfg(windows)]
static DYING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// For the deaths it can see: an access violation, heap corruption, a stack
/// overflow. **Not** for a fast-fail — measured, see the module note — so what
/// it writes may be the only location anybody ever gets, and what it must never
/// do is assume it will be called at all.
#[cfg(windows)]
unsafe extern "system" fn on_crash(
    info: *const windows::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
) -> i32 {
    use std::sync::atomic::Ordering::SeqCst;
    use windows::Win32::System::Diagnostics::Debug::EXCEPTION_CONTINUE_SEARCH;
    use windows::Win32::System::Threading::GetCurrentThreadId;

    /* A second exception — raised inside this one by a poisoned heap, say —
       leaves the process to Windows rather than recursing. */
    if DYING.swap(true, SeqCst) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    let mut code = 0u32;
    let mut addr = 0usize;
    if !info.is_null() {
        let rec = (*info).ExceptionRecord;
        if !rec.is_null() {
            code = (*rec).ExceptionCode.0 as u32;
            addr = (*rec).ExceptionAddress as usize;
        }
    }
    let (module, offset) = locate(addr);
    let thread = GetCurrentThreadId();
    let thread_name = std::thread::current().name().map(str::to_string);
    let (hour, minute) = clock();

    log::error!(
        target: "crash",
        "volery is dying: {} in {}, on {} ({code:#010x} at {addr:#x})",
        kind(code),
        where_was(&module, offset),
        who(thread, thread_name.as_deref()),
    );
    log::logger().flush();

    /* The observer is already waiting on this process and will write the record
       with the code and the memory reading; this half is the location, which
       only the dying thread can know. Its `code` is overwritten there. */
    let Some(dir) = crate::applog::dir() else { return EXCEPTION_CONTINUE_SEARCH };
    let mut died = read_record(&dir).unwrap_or_default();
    died.at = now_ms();
    died.hour = hour;
    died.minute = minute;
    died.code = code;
    died.version = env!("CARGO_PKG_VERSION").to_string();
    died.module = Some(module);
    died.offset = Some(offset);
    died.thread = Some(thread);
    died.thread_name = thread_name;
    leave(&dir, &died);

    /* Not swallowed: Windows Error Reporting writes the dump, which is the only
       artefact that made 2026-11-10 answerable at all. */
    EXCEPTION_CONTINUE_SEARCH
}

/// The module an address falls in, by file name, and the offset into it.
#[cfg(windows)]
unsafe fn locate(addr: usize) -> (String, u64) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };
    let mut h = HMODULE::default();
    let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    if GetModuleHandleExW(flags, PCWSTR(addr as *const u16), &mut h).is_err() {
        return (String::from("somewhere"), addr as u64);
    }
    let mut buf = [0u16; 260];
    let n = GetModuleFileNameW(Some(h), &mut buf) as usize;
    let full = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    let file = full.rsplit(['\\', '/']).next().unwrap_or(&full).to_string();
    (file, addr as u64 - h.0 as u64)
}

/// This launch's stderr, to a file.
///
/// `windows_subsystem = "windows"` means there is no console, so every
/// `eprintln!` in this crate — and Rust's own dying words, which are the ones
/// that matter — has been written into an invalid handle and dropped. The
/// allocation failure that killed this wall on 2026-11-10 said
/// `memory allocation of N bytes failed` to stderr: the exact request that
/// could not be satisfied, gone. Truncated at every launch, because this holds
/// a process's last words and not a history.
pub(crate) fn redirect_stderr() {
    use std::io::Write;
    let Some(dir) = crate::applog::dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    /* One generation back, so a crash's own words are still here when the wall
       it restarts reads them. */
    let _ = std::fs::remove_file(dir.join(STDERR_PREV));
    let _ = std::fs::rename(dir.join(STDERR), dir.join(STDERR_PREV));
    let Ok(file) = std::fs::File::create(dir.join(STDERR)) else { return };
    let handle = {
        use std::os::windows::io::AsRawHandle;
        file.as_raw_handle() as *mut core::ffi::c_void
    };
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};
        let _ = SetStdHandle(STD_ERROR_HANDLE, windows::Win32::Foundation::HANDLE(handle));
    }
    /* Kept open for the life of the process: closing it here would leave stderr
       pointing at a handle nobody owns. */
    std::mem::forget(file);
    let _ = writeln!(std::io::stderr(), "--- stderr from this launch, since {} ---", stamp());
}

/// The exception this is, in words for somebody who is not going to look up an
/// NTSTATUS. Pure, so the table is read rather than trusted.
fn kind(code: u32) -> &'static str {
    match code {
        // What the allocator's failure hook raises on x64, and therefore also
        // what a Rust `panic = "abort"` build, a double panic or an unwind
        // across an FFI boundary ends as. Measured on the 2026-11-10 dump: the
        // allocation-failure hook, a request of ~1 MiB, and a null from
        // `HeapAlloc`.
        0xc0000409 => "a fail-fast abort — an allocation that could not be met, or `abort()`",
        0xc0000005 => "an access violation",
        0xc00000fd => "a stack overflow",
        0xc0000374 => "heap corruption",
        _ => "an exception Windows does not have a short word for",
    }
}

/// `skein.exe+0x2405f81`, the form the event log and the dump both use.
fn where_was(module: &str, offset: u64) -> String {
    format!("{module}+0x{offset:x}")
}

/// Who this was, in as few words as reading a thread list needs.
fn who(thread: u32, name: Option<&str>) -> String {
    match name {
        Some(n) => format!("the {n} thread"),
        None => format!("thread {thread:#x}"),
    }
}

/// The row the next launch writes — pure, so its wording is tested rather than
/// discovered in the chronicle.
fn landing(d: &Died) -> (&'static str, String, String) {
    let at = format!("{:02}:{:02}", d.hour, d.minute);
    let mark = if d.relaunched {
        format!("volery crashed at {at} and came back by itself")
    } else {
        format!("volery crashed at {at} — nothing restarted it")
    };

    let mut detail = String::from("It died with ");
    detail.push_str(&format!("{}.", kind(d.code)));
    if let (Some(module), Some(offset)) = (d.module.as_deref(), d.offset) {
        detail.push_str(&format!(
            " The fault was in {}, on {}.",
            where_was(module, offset),
            who(d.thread.unwrap_or(0), d.thread_name.as_deref())
        ));
    }
    if let Some(mb) = d.peak_mb {
        detail.push_str(&format!(
            " It was holding {:.1} GB when it went, which is what an allocation Rust cannot get \
             and then gives up over looks like.",
            mb as f64 / 1024.0
        ));
    }
    if let Some(dump) = d.dump.as_deref() {
        detail.push_str(&format!(" Windows left a dump at {dump}."));
    }
    if d.relaunched {
        detail.push_str(
            " Cards that were mid-turn were picked up again, and cards that were awake are \
             awake. Nothing was asked for: this is Volery's own restart, not an update.",
        );
    } else {
        detail.push_str(
            " Nothing came back by itself, either because revival is switched off \
             (`SKEIN_NO_REVIVE`) or because a restart had already happened inside the half \
             hour — these are not made into a loop.",
        );
    }
    ("bad", mark, detail)
}

/// `VOLERY_CRASH_SELF=<ms>` aborts this process on purpose, so a lab can prove
/// the whole of the path — the observer, the record, the restart, and the row
/// the wall that comes back writes. Debug builds only: an environment variable
/// that kills a wall is not something a release should answer to.
#[cfg(debug_assertions)]
fn crash_on_purpose() {
    let Ok(ms) = std::env::var("VOLERY_CRASH_SELF") else { return };
    let ms: u64 = ms.trim().parse().unwrap_or(5_000);
    let _ = std::thread::Builder::new().name("crash-self".into()).spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        /* Removed before the abort, because the observer — and the wall it
           starts — inherit our environment block: left set, the wall that came
           back would die again five seconds later and this would not be a test
           of one crash. */
        std::env::remove_var("VOLERY_CRASH_SELF");
        eprintln!("VOLERY_CRASH_SELF: aborting this wall on purpose");
        std::process::abort();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_death(relaunched: bool) -> Died {
        Died {
            at: 1_762_800_000_000,
            hour: 12,
            minute: 58,
            code: 0xc0000409,
            version: "0.101.0".into(),
            relaunched,
            module: Some("skein.exe".into()),
            offset: Some(0x2405f81),
            thread: Some(0x4398),
            thread_name: None,
            peak_mb: Some(3_182),
            dump: Some(r"C:\Users\flori\AppData\Local\CrashDumps\skein.exe.33508.dmp".into()),
        }
    }

    /// The record crosses to a process that never saw this one, so it is JSON
    /// on disk rather than a struct in memory — and an older build's record,
    /// missing a field this one added, still reads.
    #[test]
    fn the_record_round_trips_and_survives_a_field_being_absent() {
        let d = a_death(true);
        let text = serde_json::to_string(&d).unwrap();
        assert_eq!(serde_json::from_str::<Died>(&text).unwrap(), d);
        assert_eq!(serde_json::from_str::<Died>(r#"{"code":3221226505}"#).unwrap().peak_mb, None);
    }

    /// Only a death counts. A close, a kill and a logoff are three different
    /// codes and none of them is an exception.
    #[test]
    fn leaving_is_not_dying() {
        assert!(died_of(0xc0000409), "a fast-fail abort");
        assert!(died_of(0xc0000005), "an access violation");
        assert!(died_of(0xc00000fd), "a stack overflow");
        assert!(!died_of(0), "a clean close");
        assert!(!died_of(1), "taskkill /F");
        assert!(!died_of(0x40010004), "a logoff terminating the process");
    }

    /// The row has to say the one thing nobody could tell on 2026-11-10: this
    /// was not an update, and it was not you closing it.
    #[test]
    fn the_row_names_the_cause_and_says_it_was_not_an_update() {
        let (level, mark, detail) = landing(&a_death(true));
        assert_eq!(level, "bad");
        assert!(mark.contains("12:58"), "{mark}");
        assert!(mark.contains("came back by itself"), "{mark}");
        assert!(detail.contains("fail-fast abort"), "{detail}");
        assert!(detail.contains("skein.exe+0x2405f81"), "{detail}");
        assert!(detail.contains("3.1 GB"), "{detail}");
        assert!(detail.contains("not an update"), "{detail}");
    }

    /// And when nothing brought it back, the row has to say that instead —
    /// the difference being the whole of what a person wants to know.
    #[test]
    fn a_wall_that_stayed_down_says_so() {
        let (level, mark, detail) = landing(&a_death(false));
        assert_eq!(level, "bad");
        assert!(mark.contains("nothing restarted it"), "{mark}");
        assert!(detail.contains("SKEIN_NO_REVIVE"), "{detail}");
    }

    /// A record from before the filter knew where the fault was still reads as
    /// a sentence rather than as a gap.
    #[test]
    fn a_row_without_a_location_is_still_a_sentence() {
        let d = Died { code: 0xc0000005, hour: 9, minute: 3, ..Default::default() };
        let (_, mark, detail) = landing(&d);
        assert!(mark.contains("09:03"), "{mark}");
        assert!(detail.contains("access violation"), "{detail}");
        assert!(!detail.contains("fault was in"), "{detail}");
    }

    /// A thread with a name is recognised by it; one without is not invented.
    #[test]
    fn a_thread_is_named_when_it_has_a_name() {
        assert_eq!(who(0x4398, None), "thread 0x4398");
        assert_eq!(who(0x4398, Some("watchdog")), "the watchdog thread");
    }
}
