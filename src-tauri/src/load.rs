//! How hard the machine is working, and who is making it work.
//!
//! Lyss runs about ten cards at once on a 15.4 GB laptop, and on 2026-10-14 the
//! machine was found at 0.4 GB free and 100% CPU: a `next dev` at 4.4 GB, a
//! `tsc --noEmit` at 2.6 GB, two RISE MCP servers at half a gigabyte each, and a
//! Playwright MCP per card. What made it expensive was not any one of those. It
//! was that **every card read the symptom as its own failure.** A test run that
//! hangs, or prints nothing, or dies without a word under memory pressure looks
//! exactly like a broken test from inside one conversation, so each card re-ran
//! its gate, which added load, which made the next card's gate hang too.
//!
//! So this module answers one question for a card: *is the machine saturated,
//! and by whom?* Three readers share it:
//!
//! - **`mcp__skein__load`**, a tool a card can call when a gate misbehaves. It is
//!   deferred with a search hint rather than loaded, because the loaded tier is
//!   full (`ask::roster`) and because the reflex is served by the second reader.
//! - **The `PreToolUse` hook** (`hooks::load_note`), which asks the wall before a
//!   heavy command and, only while the machine is saturated, puts a note in front
//!   of the model saying who else is running what. That is the channel that
//!   reaches a reflex; a tool is only read by an agent that thought to look.
//! - **The reaper** (`perf.rs`), which uses `heavy` to recognise a gate left
//!   running after its card's turn ended.
//!
//! **Advisory, deliberately.** Lyss chose that over a wall-wide queue of heavy
//! gates (2026-10-14): nothing here ever holds a card. A queue is the next step
//! if notes prove not to be enough, and the census below is what it would read.
//!
//! **Sampled on the reaper's tick, so it is not a fourth poller.** CPU has no
//! event, and memory pressure's only event (`CreateMemoryResourceNotification`)
//! fires at Windows' own threshold, which is far below the point where test
//! runners start dying. `perf::spawn_reaper` already wakes once a minute because
//! orphaning emits nothing either; reading two system counters on the same wake
//! costs nothing new. A minute is also the right grain: "pinned" means pinned for
//! minutes, and a reading that jumped on every compile would be noise.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use serde_json::{json, Value};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};

use crate::servers::Servers;
use crate::supervisor::Supervisor;

pub const LOAD_TOOL: &str = "load";

/* ── the reading ─────────────────────────────────────────────────────────── */

/// One reading of the machine, taken on the reaper's tick.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub at: i64,
    pub used: u64,
    pub total: u64,
    /// The whole machine's CPU, 0–100, averaged over the interval since the
    /// previous sample. The first sample after launch reads 0 because there is
    /// nothing to average against, which errs towards calm.
    pub cpu: f32,
}

/// The last few readings. Ten minutes at the reaper's cadence, which is more
/// than the two the CPU rule needs and enough for the tool to show a trend.
#[derive(Default)]
pub struct Load(Mutex<VecDeque<Sample>>);

const KEEP: usize = 10;

impl Load {
    pub fn push(&self, s: Sample) {
        if let Ok(mut ring) = self.0.lock() {
            ring.push_back(s);
            while ring.len() > KEEP {
                ring.pop_front();
            }
        }
    }

    pub fn recent(&self) -> Vec<Sample> {
        self.0.lock().map(|r| r.iter().copied().collect()).unwrap_or_default()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Take a reading. Called from `perf::spawn_reaper` with the reaper's own
/// `System`, so the CPU figure is the average over the minute since the last
/// tick rather than over a few milliseconds.
pub fn tick(app: &AppHandle, sys: &mut System) {
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    app.state::<Load>().push(Sample {
        at: now_ms(),
        used: sys.used_memory(),
        total: sys.total_memory(),
        cpu: sys.global_cpu_usage(),
    });
}

/* ── what counts as saturated ────────────────────────────────────────────── */

/// Memory at or above this share of the machine is saturated. Lyss's number.
/// On 15.4 GB it is ~1.5 GB free, which is about where `tsc` on nova and a
/// vitest run with workers stop fitting beside a dev server.
pub const MEMORY_HOT: f64 = 0.90;

/// A minute's average CPU at or above this is a hot minute.
pub const CPU_HOT: f32 = 90.0;

/// How many hot minutes in a row make the CPU pinned. Two, which is Lyss's
/// "pinned for more than 2 min": one hot minute is a compile, two is a machine
/// that is not keeping up.
pub const CPU_PINNED_SAMPLES: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pressure {
    pub memory: bool,
    /// How many minutes the CPU has been hot, counting back from now, once it
    /// has been at least `CPU_PINNED_SAMPLES`. Zero means not pinned.
    pub cpu_minutes: usize,
}

impl Pressure {
    pub fn any(&self) -> bool {
        self.memory || self.cpu_minutes > 0
    }
}

/// The rule, pure. `memory` is the freshest `(used, total)` there is, which may
/// be newer than the ring: a card asking now deserves now's memory, while CPU
/// can only be read as an average over an interval and so comes from the ring.
pub fn pressure(samples: &[Sample], memory: Option<(u64, u64)>) -> Pressure {
    let memory = memory
        .or_else(|| samples.last().map(|s| (s.used, s.total)))
        .is_some_and(|(used, total)| total > 0 && used as f64 / total as f64 >= MEMORY_HOT);
    let hot = samples.iter().rev().take_while(|s| s.cpu >= CPU_HOT).count();
    Pressure {
        memory,
        cpu_minutes: if hot >= CPU_PINNED_SAMPLES { hot } else { 0 },
    }
}

/// Gigabytes, one decimal. Every figure an agent reads goes through this so
/// that two lines of one answer never disagree about rounding.
pub fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

/// Megabytes for a process, gigabytes once it is worth saying so.
pub fn size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        gb(bytes)
    } else {
        format!("{} MB", bytes / (1024 * 1024))
    }
}

/// Minutes, for an age.
pub fn ago(secs: u64) -> String {
    if secs < 90 {
        format!("{secs}s")
    } else if secs < 90 * 60 {
        format!("{}m", secs / 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// One line saying how the machine is, which both the tool and the hook lead
/// with.
pub fn headline(p: Pressure, used: u64, total: u64, samples: &[Sample]) -> String {
    let free = total.saturating_sub(used);
    let pct = if total > 0 { (used as f64 / total as f64 * 100.0).floor() as u64 } else { 0 };
    let mut out = format!("RAM {} of {} in use ({pct}%, {} free)", gb(used), gb(total), gb(free));
    if let Some(last) = samples.last() {
        if p.cpu_minutes > 0 {
            out.push_str(&format!(", CPU pinned at {:.0}% for {} min", last.cpu, p.cpu_minutes));
        } else {
            out.push_str(&format!(", CPU {:.0}% over the last minute", last.cpu));
        }
    }
    out
}

/* ── what counts as heavy ────────────────────────────────────────────────── */

/// Is this command line a heavy, one-shot check — a type-check, a test run, a
/// build — and if so, a short name for it.
///
/// **A different question from `gates.ts`, deliberately.** That file decides
/// which commands are a project's *gates* so it can record whether the tree
/// builds; it is a front-end fold over the stream, and Rust never needs to know
/// what a gate is. This asks whether a command will take gigabytes and minutes,
/// from two places the front end cannot reach — a hook process, and the
/// reaper looking at a process table. `pnpm build` is heavy and may not be a
/// gate; `bun run check` is both. Two questions, two answers.
///
/// It reads both kinds of line: a command an agent typed (`pnpm test`,
/// `npx tsc --noEmit`) and a process's argv joined back up (`node
/// …\typescript\bin\tsc --noEmit -p .`). Watch modes are not heavy here: they
/// are long-lived on purpose, and a "leftover" watcher is usually a watcher.
///
/// Conservative in the direction that matters. A miss costs a note not shown
/// or a stray not reaped; a false hit costs a note about load in front of an
/// ordinary command, or a process ended that was wanted. So it names programs
/// rather than guessing from words in arguments.
pub fn heavy(line: &str) -> Option<String> {
    segments(line).into_iter().find_map(|seg| heavy_simple(&seg))
}

/// The same question about a running process, asked of its argv **as argv**.
///
/// Never by joining it back into a line and splitting that on the shell's
/// separators, and the reason is the one an adversarial review found before
/// this shipped: a card's own `claude.exe` carries its whole system prompt in
/// its argv (`--append-system-prompt`), standing instructions included. A
/// guidance line reading `bun run check && bun run test`, split as a shell
/// line, made the card itself read as a leftover test run — and the reaper
/// would have ended the card. A process runs one program; its argv is one
/// simple command, and `claude.exe` is not a program this names.
pub fn heavy_argv(p: &sysinfo::Process) -> Option<String> {
    let words: Vec<String> = p
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy().trim_matches('"').to_string())
        .filter(|w| !w.is_empty())
        .collect();
    heavy_simple(&words)
}

/// Split on the shell's command separators, then into words, quotes off.
fn segments(line: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for part in line.split(['\n', ';', '|', '&']) {
        let words: Vec<String> = part
            .split_whitespace()
            .map(|w| w.trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string())
            .filter(|w| !w.is_empty())
            .collect();
        if !words.is_empty() {
            out.push(words);
        }
    }
    out
}

/// The program a word names: the last path component, lowercased, with the
/// Windows and node wrappers' extensions taken off.
fn stem(word: &str) -> String {
    let last = word.rsplit(['/', '\\']).next().unwrap_or(word).to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".ps1", ".bat", ".mjs", ".cjs", ".js"] {
        if let Some(s) = last.strip_suffix(ext) {
            return s.to_string();
        }
    }
    last
}

/// A long-lived mode: a watcher, a dev server, an interactive runner. Not a
/// one-shot check, and a "leftover" one is usually wanted.
fn watching(words: &[String]) -> bool {
    words.iter().any(|w| {
        matches!(w.as_str(), "--watch" | "watch" | "--watchAll" | "--ui" | "serve" | "dev" | "start")
    })
}

/// A package script that is a check, by its name — and not one whose name also
/// says it stays up (`test:watch`, `test-server`, `dev:test`).
fn heavy_script(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if ["watch", "serve", "server", "dev", "start"].iter().any(|k| n.contains(k)) {
        return false;
    }
    ["test", "check", "build", "tsc", "typecheck", "lint", "e2e", "vitest", "jest", "gate"]
        .iter()
        .any(|k| n.contains(k))
}

/// Flags a package manager reads a value after, so `pnpm --filter web test` is
/// read as `test` rather than as a script called `web`.
const VALUE_FLAGS: [&str; 6] = ["--filter", "-F", "-C", "--dir", "--prefix", "--cwd"];

/// The first word of `rest` that is an argument rather than a flag or a flag's
/// value, with its index.
fn first_arg(rest: &[String]) -> Option<(usize, &str)> {
    let mut k = 0;
    while k < rest.len() {
        let w = rest[k].as_str();
        if w.starts_with('-') {
            k += if VALUE_FLAGS.contains(&w) { 2 } else { 1 };
            continue;
        }
        return Some((k, w));
    }
    None
}

/// A word that names a file rather than a script: `bun apps/mcp/src/index.ts`
/// runs a file, and a path that happens to contain `test` is not a test run.
fn is_path(w: &str) -> bool {
    w.contains('/') || w.contains('\\') || w.ends_with(".ts") || w.ends_with(".js")
}

fn heavy_simple(words: &[String]) -> Option<String> {
    if watching(words) {
        return None;
    }
    let mut i = 0;
    /* Leading `VAR=value` assignments, as a POSIX shell takes them. */
    while i < words.len() && words[i].contains('=') && !words[i].starts_with('-') {
        i += 1;
    }
    let mut hops = 0;
    while i < words.len() && hops < 6 {
        hops += 1;
        let prog = stem(&words[i]);
        let rest = &words[i + 1..];
        let found = first_arg(rest);
        let next = found.map(|(_, w)| w);
        match prog.as_str() {
            "npx" | "pnpx" | "bunx" => {
                i += 1;
                while i < words.len() && words[i].starts_with('-') {
                    i += 1;
                }
                /* `npx @playwright/mcp` and friends name a package, not a
                   program; the stem of a scoped name is what follows the
                   slash, which is the program for every tool that matters. */
                continue;
            }
            "node" | "nodejs" => {
                /* `node [flags] <script> …`: the script is the program. A
                   `--max-old-space-size=8192` before it is a flag. */
                i += 1;
                while i < words.len() && words[i].starts_with('-') {
                    i += 1;
                }
                if i < words.len() && stem(&words[i]) == "bin" {
                    return None;
                }
                continue;
            }
            "pnpm" | "npm" | "yarn" | "bun" => {
                let (k, sub) = found?;
                let at = i + 1 + k;
                if is_path(sub) {
                    i = at;
                    continue;
                }
                match sub {
                    "run" | "run-script" => {
                        let script = words.get(at + 1)?;
                        return heavy_script(script).then(|| format!("{prog} run {script}"));
                    }
                    "exec" | "dlx" | "x" => {
                        i = at + 1;
                        continue;
                    }
                    "test" | "t" | "tsc" | "typecheck" | "build" | "lint" | "check" => {
                        return Some(format!("{prog} {sub}"));
                    }
                    other if prog != "npm" && heavy_script(other) => {
                        return Some(format!("{prog} {other}"));
                    }
                    _ => return None,
                }
            }
            "tsc" | "vue-tsc" => {
                if words.iter().any(|w| w == "-w") {
                    return None;
                }
                return Some(prog);
            }
            "vitest" | "jest" | "mocha" | "eslint" | "pytest" | "webpack" | "rustc" => {
                return Some(prog);
            }
            "playwright" if next == Some("test") => return Some("playwright test".into()),
            "cargo" => {
                return match next {
                    Some(s @ ("check" | "build" | "test" | "clippy" | "nextest")) => {
                        Some(format!("cargo {s}"))
                    }
                    _ => None,
                };
            }
            "next" | "vite" | "astro" | "nuxt" if next == Some("build") => {
                return Some(format!("{prog} build"));
            }
            "turbo" | "nx" => {
                /* Task names only — a flag's value (`--filter=web-test`) says
                   which package, not what runs in it. */
                return rest
                    .iter()
                    .filter(|w| !w.starts_with('-'))
                    .find(|w| heavy_script(w))
                    .map(|s| format!("{prog} {s}"));
            }
            "dotnet" if matches!(next, Some("build" | "test")) => {
                return Some(format!("dotnet {}", next.unwrap_or_default()));
            }
            "python" | "python3" | "py" => {
                return rest
                    .windows(2)
                    .any(|w| w[0] == "-m" && w[1] == "pytest")
                    .then(|| "pytest".to_string());
            }
            "uv" => {
                if let Some((k, "run")) = found {
                    i += 1 + k + 1;
                    continue;
                }
                return None;
            }
            _ => return None,
        }
    }
    None
}

/* ── who is using it ─────────────────────────────────────────────────────── */

/// A heavy process one of the wall's cards is running.
#[derive(Clone, Debug)]
pub struct Run {
    pub pid: u32,
    pub card: String,
    pub what: String,
    pub age: u64,
    pub bytes: u64,
}

/// Where the memory is, attributed as far as the wall can prove.
#[derive(Default)]
pub struct Census {
    pub used: u64,
    pub total: u64,
    /// card id → private bytes of everything in its job.
    pub cards: HashMap<String, u64>,
    /// server group id → private bytes of everything in its job.
    pub groups: HashMap<String, u64>,
    /// This app and the webviews it draws with.
    pub studio: u64,
    /// The servers the wall runs once for every card: the shared browser MCP
    /// (`mcphost.rs`) and each pooled project server (`pool.rs`), by name.
    pub shared: HashMap<String, u64>,
    /// The heaviest things on the machine that are not this wall's, folded by
    /// executable: `(name, count, bytes)`, heaviest first.
    pub others: Vec<(String, usize, u64)>,
    pub runs: Vec<Run>,
}

/// Private bytes, which is what a process is actually costing — working set is
/// what happens to be resident, and on a machine this short of memory that is
/// whatever Windows has not paged out yet (`processes.md`: "measure private
/// commit, never working set"). sysinfo reports it as `virtual_memory` on
/// Windows (`PrivateUsage`, read out of sysinfo 0.38.4's `windows/process.rs`).
fn private(p: &sysinfo::Process) -> u64 {
    p.virtual_memory()
}

/// Take the census. One process enumeration with memory, then command lines
/// only for the processes the wall's cards own — reading a command line means
/// reading another process's memory, and doing that for every process on the
/// machine would be most of the cost for rows nobody needs.
///
/// Called on a request's own thread (the MCP listener and the hook route both
/// give each request one), so it parks nobody but its caller.
pub fn census(app: &AppHandle) -> Census {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );

    let card_pids = app.state::<Supervisor>().owned_pids();
    let group_pids = app.state::<Servers>().owned_pids();
    let mut shared_pids: HashMap<u32, String> = app
        .state::<crate::pool::Pool>()
        .pids()
        .into_iter()
        .map(|(pid, name)| (pid, format!("shared MCP server \"{name}\"")))
        .collect();
    for pid in crate::mcphost::pids(app) {
        shared_pids.insert(pid, "shared browser MCP server".to_string());
    }
    let ours: HashSet<u32> = card_pids
        .keys()
        .chain(group_pids.keys())
        .chain(shared_pids.keys())
        .copied()
        .collect();

    let mut c = Census { used: sys.used_memory(), total: sys.total_memory(), ..Census::default() };
    for (pid, card) in &card_pids {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            *c.cards.entry(card.clone()).or_default() += private(p);
        }
    }
    for (pid, group) in &group_pids {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            *c.groups.entry(group.clone()).or_default() += private(p);
        }
    }
    for (pid, label) in &shared_pids {
        if let Some(p) = sys.process(Pid::from_u32(*pid)) {
            *c.shared.entry(label.clone()).or_default() += private(p);
        }
    }

    /* The studio: this process and its descendants that no job claims, which is
       the WebView2 tree. A parent walk, bounded the way `perf::ancestry` is
       because pids are reused. */
    let me = Pid::from_u32(std::process::id());
    let parents: HashMap<Pid, Pid> =
        sys.processes().iter().filter_map(|(pid, p)| p.parent().map(|up| (*pid, up))).collect();
    let under_me = |pid: Pid| {
        let mut at = pid;
        for _ in 0..16 {
            if at == me {
                return true;
            }
            match parents.get(&at) {
                Some(&up) if up != at => at = up,
                _ => return false,
            }
        }
        false
    };
    let mut others: HashMap<String, (usize, u64)> = HashMap::new();
    for (pid, p) in sys.processes() {
        if ours.contains(&pid.as_u32()) {
            continue;
        }
        if under_me(*pid) {
            c.studio += private(p);
            continue;
        }
        let e = others.entry(p.name().to_string_lossy().to_string()).or_default();
        e.0 += 1;
        e.1 += private(p);
    }
    let mut others: Vec<(String, usize, u64)> =
        others.into_iter().map(|(n, (k, b))| (n, k, b)).collect();
    others.sort_by(|a, b| b.2.cmp(&a.2));
    others.truncate(6);
    c.others = others;

    /* Command lines for the cards' processes only. */
    let mine: Vec<Pid> = card_pids.keys().map(|p| Pid::from_u32(*p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&mine),
        false,
        ProcessRefreshKind::nothing().with_memory().with_cmd(UpdateKind::OnlyIfNotSet),
    );
    c.runs = runs_in(&sys, &card_pids);
    c
}

/// The heavy processes among `owned`, one per tree: a `pnpm test` that started
/// a vitest is one run, not two, so a process whose parent is itself a heavy run
/// of the same card is folded into it.
pub fn runs_in(sys: &System, owned: &HashMap<u32, String>) -> Vec<Run> {
    let mut heavy_pids: HashMap<u32, (String, String)> = HashMap::new();
    for (pid, card) in owned {
        let Some(p) = sys.process(Pid::from_u32(*pid)) else { continue };
        if let Some(what) = heavy_argv(p) {
            heavy_pids.insert(*pid, (card.clone(), what));
        }
    }
    let heavy_of: HashMap<u32, String> =
        heavy_pids.iter().map(|(pid, (card, _))| (*pid, card.clone())).collect();
    let mut out: Vec<Run> = heavy_pids
        .iter()
        .filter(|(pid, (card, _))| !under_heavy(sys, **pid, card, &heavy_of))
        .filter_map(|(pid, (card, what))| {
            let p = sys.process(Pid::from_u32(*pid))?;
            Some(Run {
                pid: *pid,
                card: card.clone(),
                what: what.clone(),
                age: p.run_time(),
                bytes: tree_bytes(sys, *pid, owned),
            })
        })
        .collect();
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    out
}

/// Is some ancestor of `pid` itself a heavy run of the same card? Then this one
/// is part of that run — the vitest under `pnpm test → cmd → vitest` — and is
/// counted, judged and reaped as part of it, through however many intermediate
/// shells. Bounded, since pids are reused and a stale chain can loop.
pub fn under_heavy(sys: &System, pid: u32, card: &str, heavy_of: &HashMap<u32, String>) -> bool {
    let mut at = Pid::from_u32(pid);
    for _ in 0..16 {
        let Some(up) = sys.process(at).and_then(|p| p.parent()) else { return false };
        if up == at {
            return false;
        }
        if heavy_of.get(&up.as_u32()).is_some_and(|c| c == card) {
            return true;
        }
        at = up;
    }
    false
}

/// A process's argv joined back into one line — for showing to a person, never
/// for classifying (`heavy_argv` says why).
pub fn argv(p: &sysinfo::Process) -> String {
    p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" ")
}

/// A run's cost is its whole tree within the card's job: vitest's workers are
/// the run as much as vitest is.
pub fn tree_bytes(sys: &System, root: u32, owned: &HashMap<u32, String>) -> u64 {
    let mut total = 0;
    for pid in owned.keys() {
        let mut at = Pid::from_u32(*pid);
        for _ in 0..16 {
            if at.as_u32() == root {
                if let Some(p) = sys.process(Pid::from_u32(*pid)) {
                    total += private(p);
                }
                break;
            }
            match sys.process(at).and_then(|p| p.parent()) {
                Some(up) if up != at => at = up,
                _ => break,
            }
        }
    }
    total
}

/* ── names ───────────────────────────────────────────────────────────────── */

struct Names {
    cards: HashMap<String, (String, String)>,
    groups: HashMap<String, String>,
}

/// Card titles and projects, and group labels, read once per answer. A card id
/// means nothing to an agent and a title is what it would write to the user.
fn names(app: &AppHandle, cards: &HashSet<&String>, groups: &HashSet<&String>) -> Names {
    let mut n = Names { cards: HashMap::new(), groups: HashMap::new() };
    let store = app.state::<crate::store::Store>();
    let Ok(conn) = store.0.lock() else { return n };
    for id in cards {
        if let Some(r) = crate::store::roster_one(&conn, id) {
            n.cards.insert((*id).clone(), (r.title, r.project));
        }
    }
    for id in groups {
        if let Some(label) = crate::store::server_group_label(&conn, id) {
            n.groups.insert((*id).clone(), label);
        }
    }
    n
}

fn card_name(n: &Names, id: &str, caller: &str) -> String {
    let base = match n.cards.get(id) {
        Some((title, project)) => format!("\"{title}\" ({project})"),
        None => format!("card {}", &id[..id.len().min(8)]),
    };
    if id == caller {
        format!("{base}, this card")
    } else {
        base
    }
}

/* ── the hook's note ─────────────────────────────────────────────────────── */

/// What the `PreToolUse` hook puts in front of a heavy command, or `None` when
/// the machine has room — which is nearly always, and is what keeps this from
/// being a sentence agents learn to skim.
///
/// It names what is already running, because "the machine is busy" alone tells
/// an agent nothing it can act on, while "the same tsc is already running on
/// another card" tells it to wait for that one rather than start a second.
pub fn note_for(app: &AppHandle, caller: &str, command: &str) -> Option<String> {
    let what = heavy(command)?;
    let samples = app.state::<Load>().recent();
    let mut sys = System::new();
    sys.refresh_memory();
    let (used, total) = (sys.used_memory(), sys.total_memory());
    let p = pressure(&samples, Some((used, total)));
    if !p.any() {
        return None;
    }
    let c = census(app);
    let cards: HashSet<&String> = c.runs.iter().map(|r| &r.card).collect();
    let n = names(app, &cards, &HashSet::new());
    Some(compose_note(&what, &headline(p, used, total, &samples), &c.runs, |id| {
        card_name(&n, id, caller)
    }))
}

/// The note's wording, pure so it can be asserted.
pub fn compose_note(
    what: &str,
    headline: &str,
    runs: &[Run],
    name: impl Fn(&str) -> String,
) -> String {
    let mut out = format!(
        "volery: the machine is saturated — {headline}. Under this, `{what}` may hang, print \
         nothing, or die without a word; if it does, that is load, not your code, so do not \
         re-run it blind."
    );
    if runs.is_empty() {
        out.push_str(" No other heavy check is running on this wall's cards right now.");
    } else {
        out.push_str(" Running right now on this wall:");
        for r in runs.iter().take(5) {
            out.push_str(&format!(
                "\n- {} on {}, {} so far, {}",
                r.what,
                name(&r.card),
                ago(r.age),
                size(r.bytes)
            ));
        }
        out.push_str(
            "\nIf one of those is the same check on the same tree, wait for it rather than \
             starting a second.",
        );
    }
    out.push_str(
        " Prefer the narrowest run that answers your question (one test file, one package). \
         `mcp__skein__load` has the full reading.",
    );
    out
}

/* ── the tool ────────────────────────────────────────────────────────────── */

pub fn load_schema() -> Value {
    json!({
        "name": LOAD_TOOL,
        "description":
            "How hard this machine is working right now, and who is making it work: RAM and \
             CPU, the heaviest things on it attributed to cards and dev servers by name, and \
             every heavy check (tsc, test runs, builds) the wall's cards are running at this \
             moment. Free — it reads counters and the process table, and costs no other card \
             a turn.\n\n\
             **Call it when a check misbehaves before you conclude your code is broken.** \
             Under memory pressure a test runner or a type-check hangs, prints nothing, or \
             is killed without a word, and from inside one conversation that looks exactly \
             like a broken test. This wall routinely runs ten cards on one laptop; if the \
             answer says the machine is saturated, the failure is load, and re-running the \
             same suite adds to it. Wait for the run another card already has going, or \
             narrow yours to one file.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

pub fn handle(app: &AppHandle, caller: &str, tool: &str, _args: &Value) -> Option<String> {
    (tool == LOAD_TOOL).then(|| do_load(app, caller))
}

fn do_load(app: &AppHandle, caller: &str) -> String {
    let samples = app.state::<Load>().recent();
    let c = census(app);
    let p = pressure(&samples, Some((c.used, c.total)));

    let card_ids: HashSet<&String> = c.cards.keys().chain(c.runs.iter().map(|r| &r.card)).collect();
    let group_ids: HashSet<&String> = c.groups.keys().collect();
    let n = names(app, &card_ids, &group_ids);

    let verdict = if p.memory {
        "Saturated: memory is nearly gone. Test runners and type-checks hang, print nothing or \
         are killed silently under this, so a misbehaving check is very likely the machine, not \
         your code. Do not re-run a suite blind: wait for a run already going (below), or narrow \
         yours to the smallest thing that answers the question, and tell the user the machine \
         is the bottleneck."
    } else if p.cpu_minutes > 0 {
        "Saturated: the CPU has been pinned for minutes. Checks will be slow rather than wrong; \
         give them longer before deciding they hang, and do not start a second copy of a check \
         that is already running."
    } else {
        "The machine has room. A check that misbehaves now is more likely to be the check."
    };

    let mut top: Vec<(String, u64)> = Vec::new();
    for (id, b) in &c.cards {
        top.push((format!("card {}", card_name(&n, id, caller)), *b));
    }
    for (id, b) in &c.groups {
        let label = n.groups.get(id).cloned().unwrap_or_else(|| id.clone());
        top.push((format!("dev server group \"{label}\""), *b));
    }
    for (label, b) in &c.shared {
        top.push((label.clone(), *b));
    }
    top.push(("Volery itself and its webviews".to_string(), c.studio));
    top.sort_by(|a, b| b.1.cmp(&a.1));

    let trend: Vec<Value> = samples
        .iter()
        .rev()
        .take(5)
        .map(|s| json!({ "cpu": s.cpu.round(), "ram_used": gb(s.used), "minutes_ago": (now_ms() - s.at).max(0) / 60_000 }))
        .collect();

    json!({
        "machine": headline(p, c.used, c.total, &samples),
        "saturated": p.any(),
        "verdict": verdict,
        "heavy_checks_running": c.runs.iter().map(|r| json!({
            "what": r.what,
            "card": card_name(&n, &r.card, caller),
            "running_for": ago(r.age),
            "memory": size(r.bytes),
            "pid": r.pid,
        })).collect::<Vec<_>>(),
        "this_wall": top.iter().take(12).map(|(who, b)| json!({ "who": who, "memory": size(*b) })).collect::<Vec<_>>(),
        "not_this_wall": c.others.iter().map(|(name, k, b)| json!({
            "process": name, "count": k, "memory": size(*b),
        })).collect::<Vec<_>>(),
        "recent_minutes": trend,
        "note": "Memory is private bytes, what each process is actually costing. `not_this_wall` \
                 is everything Volery did not start (other apps, terminals, the Claude desktop \
                 app's own servers) and is shown so you can say what is using the machine, not \
                 so you can end it: only the user may close those. A dev server group that has \
                 grown large is reported by `mcp__skein__servers`; restarting one is the user's \
                 call, since other cards may be checking against it.",
    })
    .to_string()
}

/* ── a dev server group's weight ─────────────────────────────────────────── */

/// Past this, `servers` suggests a restart. `next dev` was measured at 4.4 GB
/// after a long session on 2026-10-14 and at 6.2 GB on 2026-09-01; a fresh one
/// is under a gigabyte. Three is well past fresh and well short of the machine.
pub const GROUP_HEAVY: u64 = 3 * 1024 * 1024 * 1024;

/// Private bytes per running group, for `servers`. One enumeration of just the
/// groups' own processes.
pub fn group_bytes(app: &AppHandle) -> HashMap<String, u64> {
    let owned = app.state::<Servers>().owned_pids();
    let pids: Vec<Pid> = owned.keys().map(|p| Pid::from_u32(*p)).collect();
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    let mut out: HashMap<String, u64> = HashMap::new();
    for (pid, group) in owned {
        if let Some(p) = sys.process(Pid::from_u32(pid)) {
            *out.entry(group).or_default() += private(p);
        }
    }
    out
}

/// What `servers` says about a group's weight: the figure always, and a
/// sentence only past `GROUP_HEAVY`. Pure.
pub fn group_weight_note(bytes: u64) -> Option<String> {
    (bytes >= GROUP_HEAVY).then(|| {
        format!(
            "this group holds {} — dev servers grow over a long session, and a restart \
             usually gives most of it back. Do not restart it on your own account: other \
             cards may be checking against it right now. Tell the user it is this large and \
             let them choose the moment.",
            size(bytes)
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(at: i64, used: u64, total: u64, cpu: f32) -> Sample {
        Sample { at, used, total, cpu }
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn memory_is_saturated_at_ninety_percent_and_not_below() {
        let ring = [s(0, 0, 0, 10.0)];
        assert!(pressure(&ring, Some((9 * GIB, 10 * GIB))).memory);
        assert!(!pressure(&ring, Some((8 * GIB, 10 * GIB))).memory);
        // An unknown total is not a saturated machine.
        assert!(!pressure(&ring, Some((5, 0))).memory);
    }

    /// The freshest memory reading wins over the ring's, because a card asking
    /// now deserves now's answer.
    #[test]
    fn fresh_memory_overrides_the_ring() {
        let ring = [s(0, 95, 100, 10.0)];
        assert!(!pressure(&ring, Some((10, 100))).memory);
        assert!(pressure(&ring, None).memory);
    }

    /// One hot minute is a compile. Two in a row is a machine not keeping up.
    #[test]
    fn the_cpu_is_pinned_only_after_two_hot_minutes_in_a_row() {
        let one = [s(0, 1, 10, 20.0), s(60, 1, 10, 99.0)];
        assert_eq!(pressure(&one, None).cpu_minutes, 0);
        let two = [s(0, 1, 10, 20.0), s(60, 1, 10, 95.0), s(120, 1, 10, 99.0)];
        assert_eq!(pressure(&two, None).cpu_minutes, 2);
        // A cool minute at the end ends it, however hot it was before.
        let cooled = [s(0, 1, 10, 99.0), s(60, 1, 10, 99.0), s(120, 1, 10, 30.0)];
        assert_eq!(pressure(&cooled, None).cpu_minutes, 0);
        assert!(!pressure(&[], None).any());
    }

    #[test]
    fn typed_checks_are_heavy() {
        for (line, want) in [
            ("pnpm test", "pnpm test"),
            ("bun run check", "bun run check"),
            ("pnpm run typecheck", "pnpm run typecheck"),
            ("npx tsc --noEmit -p .", "tsc"),
            ("npx vitest run src/a.test.ts", "vitest"),
            ("cargo check --lib", "cargo check"),
            ("cd src-tauri && cargo test", "cargo test"),
            ("pnpm exec playwright test", "playwright test"),
            ("uv run pytest tests/ -v", "pytest"),
            ("python -m pytest", "pytest"),
            ("bun test test/load.test.ts", "bun test"),
            ("pnpm build", "pnpm build"),
            ("npm test", "npm test"),
            ("CI=1 pnpm vitest run", "pnpm vitest"),
            ("turbo run build", "turbo build"),
            ("pnpm --filter web test", "pnpm test"),
            ("next build", "next build"),
        ] {
            assert_eq!(heavy(line).as_deref(), Some(want), "{line}");
        }
    }

    /// Process argv, as the reaper and the census see it.
    #[test]
    fn process_command_lines_are_heavy_by_their_script() {
        for (line, want) in [
            (
                r"C:\Users\x\AppData\Local\pnpm\node.exe --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p .tmp/tsconfig.json",
                "tsc",
            ),
            (r#""node" C:\repo\node_modules\vitest\vitest.mjs run"#, "vitest"),
            (r"C:\Users\x\.cargo\bin\cargo.exe check --lib", "cargo check"),
            (r"C:\Users\x\.rustup\toolchains\stable\bin\rustc.exe --crate-name skein", "rustc"),
        ] {
            assert_eq!(heavy(line).as_deref(), Some(want), "{line}");
        }
    }

    #[test]
    fn ordinary_and_long_lived_commands_are_not_heavy() {
        for line in [
            "git status",
            "pnpm dev",
            "pnpm install",
            "next dev --turbopack",
            r"C:\x\node.exe C:\repo\node_modules\next\dist\server\lib\start-server.js",
            "npx tsc --watch",
            "tsc -w -p .",
            "vitest --watch",
            "cargo watch -x check",
            "npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222",
            "bun --env-file=apps/backend/.env.local apps/mcp/src/index.ts",
            "pnpm --filter web dev",
            "bun apps/tests/fixture-server.ts",
            "echo test",
            "ls tests",
            "npm view vitest version",
            "pnpm test:watch",
            "bun run test-server",
            "webpack serve",
            "turbo run dev --filter=web-test",
            "npx playwright test --ui",
        ] {
            assert_eq!(heavy(line), None, "{line}");
        }
    }

    /// The blocker the review found: a card's own `claude.exe` carries its
    /// system prompt in argv, and a standing instruction naming a test command
    /// must not make the card read as a test run. Asked of the argv as argv,
    /// the program is `claude` and nothing in its arguments is a program.
    #[test]
    fn a_card_s_own_process_is_not_heavy_whatever_its_prompt_says() {
        let argv: Vec<String> = [
            r"C:\Users\x\.local\bin\claude.exe",
            "--print",
            "--append-system-prompt",
            "Before committing run:\nbun run check && bun run test\n; pnpm test | tee x",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(heavy_simple(&argv), None);
        // The same text read as a shell line *would* be heavy — which is
        // exactly why a process is never read that way.
        assert!(heavy(&argv.join(" ")).is_some());
    }

    #[test]
    fn the_note_names_what_is_running_and_where_to_read_more() {
        let runs = vec![Run {
            pid: 1,
            card: "abc".into(),
            what: "tsc".into(),
            age: 300,
            bytes: 2 * GIB + GIB / 2,
        }];
        let note = compose_note("pnpm test", "RAM 14.0 GB of 15.4 GB", &runs, |id| {
            format!("\"Fix it\" ({id})")
        });
        assert!(note.starts_with("volery: the machine is saturated"), "{note}");
        assert!(note.contains("tsc on \"Fix it\" (abc), 5m so far, 2.5 GB"), "{note}");
        assert!(note.contains("not your code"), "{note}");
        assert!(note.contains("mcp__skein__load"), "{note}");
        let quiet = compose_note("pnpm test", "RAM", &[], |id| id.to_string());
        assert!(quiet.contains("No other heavy check"), "{quiet}");
    }

    #[test]
    fn a_group_is_only_called_heavy_past_the_threshold() {
        assert!(group_weight_note(GROUP_HEAVY - 1).is_none());
        let said = group_weight_note(4 * GIB + GIB / 2).unwrap();
        assert!(said.contains("4.5 GB"), "{said}");
        assert!(said.contains("Do not restart it on your own account"), "{said}");
    }

    #[test]
    fn sizes_and_ages_read_the_way_a_person_says_them() {
        assert_eq!(size(512 * 1024 * 1024), "512 MB");
        assert_eq!(size(3 * GIB), "3.0 GB");
        assert_eq!(ago(45), "45s");
        assert_eq!(ago(600), "10m");
        assert_eq!(ago(2 * 3600 + 5 * 60), "2h05m");
    }
}
