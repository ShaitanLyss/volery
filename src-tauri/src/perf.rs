//! What the studio's own processes are costing.
//!
//! A wall of concurrent agents is a wall of concurrent *processes*: every card
//! is a live `claude`, every dev server is a node tree, every build is a cargo
//! or a UBT. Alt-tabbing to Task Manager to find out which of them is eating
//! the machine, and then guessing which `claude.exe` is which card, is the sort
//! of question this app exists to answer on the wall instead.
//!
//! Two rules keep it honest, and they are the same two `project.rs` follows:
//!
//! - **This module answers in facts and never in verbs.** A row is a pid, a
//!   name, a cost and — where we know it — the *role* it plays here, as an
//!   opaque reference to a conversation, a server group or a run. Turning
//!   `role: "conversation", reference: "<uuid>"` into "the card that is fixing
//!   the parser" is the front end's job, because the front end is what knows
//!   the card's title.
//! - **It samples only when something is asking.** Nothing on this wall polls;
//!   a performance meter is the one honest exception, because there is no event
//!   a process emits when it starts using the CPU. So the `System` is built on
//!   the first call and the sampling stops dead when the last widget comes off
//!   the wall — the front end simply stops calling.
//!
//! CPU is measured as a delta between refreshes, so the first sample after a
//! quiet spell reads zero and the second is the real answer. That is a property
//! of every sampler of this kind, and the front end draws the second one.
//!
//! One thing to know before believing a low reading in development: WebView2
//! keeps **one browser process per user-data folder**, so a second Skein run
//! against the same `%APPDATA%` gets no webview children of its own — they are
//! all under the instance that started first, and the studio scope of the
//! second reads a few tens of megabytes while the first carries the gigabyte.
//! Probed 2026-08-13 with two instances up: `skein.exe` 52452 held
//! `msedgewebview2.exe` 9544 and its eight renderers, and 30792 held nothing.
//! Normal single-instance use attributes the lot, since the parent chain from
//! a renderer up to `skein.exe` is intact.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System, UpdateKind,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::actions::Runs;
use crate::servers::Servers;
use crate::supervisor::Supervisor;

/// The sampler, kept between calls because a CPU reading is a difference
/// between two of them. `None` until something asks: an app that never opens a
/// performance widget never enumerates a single process.
#[derive(Default)]
pub struct Meter(Mutex<Option<System>>);

#[derive(Debug, Serialize, Clone)]
pub struct Proc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    /// Percent of one core, so a busy four-thread build reads ~400 and the
    /// front end divides by `cores` when it wants a share of the machine.
    pub cpu: f32,
    /// Resident bytes.
    pub mem: u64,
    /// "studio" | "conversation" | "server" | "action" | "other"
    pub role: String,
    /// Whichever id that role is keyed by — a conversation id, a server group
    /// id, a run id. Meaningless here; the front end resolves it to a name.
    pub reference: Option<String>,
    /// Is this the process the role was recognised on, rather than something it
    /// spawned? `pnpm dev` is the server; the four node processes under it are
    /// the same server costing more than it looks.
    pub own: bool,
    /// Its parent is gone — nothing is waiting on this and nothing will reap
    /// it. See `sweep`; this is the flag it acts on and the one the
    /// process list draws a mark for.
    pub orphan: bool,
    /// Seconds since it started. Drawn in the list, and the reaper's one race
    /// guard — see `REAP_MIN_AGE`.
    pub age: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Sample {
    pub at: i64,
    /// Which scope produced this reading. One sample serves every widget on the
    /// wall, so a studio-scoped one has to be able to tell whether the totals it
    /// is holding are about the studio or about the machine.
    pub scope: String,
    pub cores: usize,
    /// The whole machine, 0–100.
    pub cpu: f32,
    /// Each logical core, 0–100, in the order the platform lists them — which
    /// is what `cores` counts and what the per-core widget draws one lane per.
    ///
    /// Sent on every sample rather than behind a flag, and it is the cheap half
    /// of this call by a distance: `refresh_cpu_usage` has already read every
    /// core to compute the global figure above, so this is a `Vec<f32>` of the
    /// numbers it used and nothing else. The expensive part of a sample is the
    /// process enumeration, which is unchanged. Sixteen floats against a few
    /// hundred process rows is not a payload anything can feel, and a flag
    /// would mean two shapes of answer for one poller to serve — which is the
    /// arrangement `scope` already avoids by sampling the superset once.
    pub per_core: Vec<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
    /// How many processes the scope actually held, before any cap.
    pub counted: usize,
    /// What the cap left out, so a capped list can still add up to the truth.
    pub other_cpu: f32,
    pub other_mem: u64,
    pub procs: Vec<Proc>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Walk up the parent chain until something is recognised.
///
/// Bounded, and not only for tidiness: a pid is reused once its process is
/// reaped, so a stale parent id can in principle close a loop, and an unbounded
/// walk here would hang the sampler rather than mislabel one row.
fn ancestry(
    pid: Pid,
    parents: &HashMap<Pid, Pid>,
    known: &HashMap<Pid, (String, Option<String>)>,
) -> Option<(String, Option<String>, bool)> {
    if let Some((role, reference)) = known.get(&pid) {
        return Some((role.clone(), reference.clone(), true));
    }
    let mut at = pid;
    for _ in 0..16 {
        let Some(&up) = parents.get(&at) else { break };
        if up == at {
            break;
        }
        if let Some((role, reference)) = known.get(&up) {
            return Some((role.clone(), reference.clone(), false));
        }
        at = up;
    }
    None
}

/// One reading. `scope` is "skein" (this studio and everything it spawned) or
/// "machine" (every process, the way a task manager shows it).
///
/// `async` and off the main thread, because a reading is a full enumeration of
/// the Windows process table and the front end asks for one every two seconds
/// for as long as a performance widget is on the wall. Run inline on the IPC
/// thread — which is what a `#[tauri::command]` without `async` does — that is
/// every card on the wall going unpainted for the length of an enumeration,
/// thirty times a minute — the widget you would open to diagnose a freeze
/// causing one. See `crate::off_main`, and the rule in CLAUDE.md.
///
/// The four `State` guards the body needs are reached from the `AppHandle`
/// *inside* the closure rather than taken as parameters, since a
/// `State<'_, T>` borrows the invocation and cannot cross into
/// `spawn_blocking`. `usage::read_usage` is the same shape.
#[tauri::command]
pub async fn sample_performance(
    app: AppHandle,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Sample, String> {
    crate::off_main(move || {
        let meter = app.state::<Meter>();
        let sup = app.state::<Supervisor>();
        let servers = app.state::<Servers>();
        let runs = app.state::<Runs>();
        let machine = scope.as_deref() == Some("machine");
        let cap = limit.unwrap_or(40).clamp(1, 400);

        let mut guard = meter.0.lock().map_err(|e| e.to_string())?;
        let sys = guard.get_or_insert_with(|| {
            System::new_with_specifics(
                RefreshKind::nothing()
                    .with_memory(MemoryRefreshKind::nothing().with_ram())
                    .with_cpu(CpuRefreshKind::nothing().with_cpu_usage()),
            )
        });

        sys.refresh_cpu_usage();
        sys.refresh_memory();
        /* Memory and CPU only. Enumerating command lines and open files on every
           tick is most of what makes a process listing expensive, and none of it is
           drawn. */
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory().with_cpu(),
        );

        /* What we know about our own children, keyed by pid. The three states are
           asked rather than guessed at: a `claude.exe` on the machine that this
           studio did not spawn is somebody else's terminal, and must not be labelled
           as one of our cards. */
        let mut known: HashMap<Pid, (String, Option<String>)> = HashMap::new();
        let me = Pid::from_u32(std::process::id());
        known.insert(me, ("studio".into(), None));
        for (pid, id) in sup.pids() {
            known.insert(Pid::from_u32(pid), ("conversation".into(), Some(id)));
        }
        for (pid, id) in servers.pids() {
            known.insert(Pid::from_u32(pid), ("server".into(), Some(id)));
        }
        for (pid, id) in runs.pids() {
            known.insert(Pid::from_u32(pid), ("action".into(), Some(id)));
        }

        let parents: HashMap<Pid, Pid> = sys
            .processes()
            .iter()
            .filter_map(|(pid, p)| p.parent().map(|up| (*pid, up)))
            .collect();

        /* What each card's job says it owns, consulted only where `ancestry` came
           back empty-handed. The order matters and is the whole point: ancestry
           still decides `own`, so a `pnpm` is still the server and its node
           children still hang off it — but a process whose intermediate parent has
           exited is invisible to a parent walk, and the job can still name it. That
           gap is not a corner case, it is precisely where the leaked processes
           live, and the meter used to drop them on the floor as strangers. */
        let owned = sup.owned_pids();

        let mut rows: Vec<Proc> = Vec::new();
        for (pid, p) in sys.processes() {
            let found = ancestry(*pid, &parents, &known).or_else(|| {
                owned
                    .get(&pid.as_u32())
                    .map(|id| ("conversation".to_string(), Some(id.clone()), false))
            });
            if found.is_none() && !machine {
                continue;
            }
            let (role, reference, own) = found.unwrap_or_else(|| ("other".into(), None, true));
            /* No parent recorded, or one the process table no longer holds. Note
               the second is the common shape and the first is not: Windows keeps
               the ppid field after the parent dies, so an orphan usually still
               names one — it just names a pid nobody is at any more. */
            let orphan = p.parent().is_none_or(|up| !sys.processes().contains_key(&up));
            rows.push(Proc {
                pid: pid.as_u32(),
                ppid: p.parent().map(|up| up.as_u32()),
                name: p.name().to_string_lossy().to_string(),
                cpu: p.cpu_usage(),
                mem: p.memory(),
                role,
                reference,
                own,
                orphan,
                age: p.run_time(),
            });
        }

        let counted = rows.len();
        /* Costliest first, and by CPU before memory: the question a wall of agents
           raises is "what is running", not "what is resident". A process that is
           recognised as one of ours outranks an anonymous one at the same cost, so
           capping the machine view never hides the studio's own work. */
        rows.sort_by(|a, b| {
            let ours = |r: &Proc| r.role != "other";
            ours(b)
                .cmp(&ours(a))
                .then(
                    b.cpu
                        .partial_cmp(&a.cpu)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
                .then(b.mem.cmp(&a.mem))
        });
        let dropped = rows.split_off(rows.len().min(cap));

        Ok(Sample {
            at: now(),
            scope: if machine { "machine".into() } else { "skein".into() },
            cores: sys.cpus().len().max(1),
            cpu: sys.global_cpu_usage(),
            per_core: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
            mem_used: sys.used_memory(),
            mem_total: sys.total_memory(),
            counted,
            other_cpu: dropped.iter().map(|r| r.cpu).sum(),
            other_mem: dropped.iter().map(|r| r.mem).sum(),
            procs: rows,
        })
    })
    .await?
}

/* ── ending one, and sweeping the ones nobody is waiting on ──────────────── */

/// How long a process must have been up before the reaper will touch it.
///
/// Not a "has it hung yet" threshold — this reaper deliberately has no such
/// idea, because it cannot be had honestly: every leaked process on this
/// machine sat at 0% CPU, and so does an idle dev server, an MCP server parked
/// on stdin, and a `Monitor` that `turns.md` says may legitimately run half an
/// hour. It is a race guard. A process is briefly parentless while a spawn is
/// still being handed over, and a sweep that fired inside that window would
/// kill the thing it was watching start.
const REAP_MIN_AGE: u64 = 60;

/// How often the sweep runs.
///
/// **This is the second deliberate exception to "nothing polls", and it wants
/// the same justification as the first.** The performance meter polls because
/// no process emits an event when it starts using the CPU; this polls because
/// none emits one when its parent dies either. Orphaning is a thing that
/// *stops* happening to a process — there is nothing to subscribe to. Slow, and
/// far slower than the meter, because the cost of noticing a minute late is a
/// minute of one idle process.
const REAP_EVERY: std::time::Duration = std::time::Duration::from_secs(60);

/// How long a heavy check must have been running, on a card whose turn is over
/// and which has no background work outstanding, before it is called a leftover.
///
/// Two minutes: a foreground check that outlives the turn that ran it is
/// already a leftover the moment the turn ends, since the turn waited for the
/// shell and the shell is gone — so this is not patience about the check, it is
/// a margin against the one race there is, a turn that ended a moment ago with
/// its last tool call's process still being torn down by the CLI.
const LEFTOVER_MIN_AGE: u64 = 120;

#[derive(Debug, Serialize, Clone)]
pub struct Reaped {
    pub pid: u32,
    pub name: String,
    /// The card whose job held it.
    pub conversation: String,
    /// Did the sweep do this, or did somebody press a button?
    pub automatic: bool,
    /// Its command line, clipped. Reaped processes used to be reported by
    /// image name alone — `node.exe` — which is the one fact that says nothing
    /// on a wall where every other process is a `node.exe` (sink 968a4c6b).
    pub command: String,
    /// `"orphan"`, `"leftover"`, or `"by hand"`, in words a card note can use.
    pub why: String,
    /// Private bytes it was holding, which is what ending it gave back.
    pub bytes: u64,
}

/// What the sweep makes of one process in a card's job. Pure, so each rule has
/// a test rather than a paragraph.
#[derive(Debug, PartialEq)]
pub(crate) enum Verdict {
    Keep,
    /// Its parent was seen alive at an earlier sweep and is gone now.
    Orphan,
    /// A heavy check still running after its card's turn ended.
    Leftover(String),
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Facts {
    pub age: u64,
    pub parent_alive: bool,
    /// An earlier sweep saw this very process (same pid, same start time) with
    /// its parent alive.
    pub seen_parented: bool,
    /// What `load::heavy` called its command line.
    pub heavy: Option<String>,
    /// Its parent is itself a heavy check of the same card — a vitest under the
    /// `pnpm test` that started it — so the parent is what gets judged, and
    /// `/T` takes this one with it.
    pub under_heavy: bool,
    pub card_mid_turn: bool,
    /// The card has a row in `job`: background work it started and nobody has
    /// heard finish. Anything in its tree may be that work.
    pub card_has_jobs: bool,
}

pub(crate) fn judge(f: &Facts) -> Verdict {
    /* Background work outranks both rules. A `run_in_background` test run, a
       Monitor, a backgrounded subagent's shell: each is meant to outlive the
       turn, and the job row is the one record that says so. This is also the
       old sweep's "honest caveat" closed — a backgrounded call whose shell
       exited while the work went on is exactly a process with a dead parent on
       a card with a job outstanding. */
    if f.card_has_jobs || f.age < REAP_MIN_AGE || f.under_heavy {
        return Verdict::Keep;
    }
    /* **Both rules are about heavy checks only.** The orphan rule used to reach
       anything, and the review that caught it named the case: a card runs
       `Start-Process pnpm dev; Start-Sleep 30; iwr localhost:3000`, a sweep lands
       while that `pwsh` is alive, the server is seen parented, the call returns
       and `pwsh` exits — and the dev server the card is still testing against
       is ended mid-turn. A process a card detached on purpose is extra and is
       not this reaper's (Lyss's line); what the card's job holds goes when the
       card does, and an idle card is stood down by `reaping.ts` anyway. */
    let Some(what) = &f.heavy else { return Verdict::Keep };
    if !f.parent_alive && f.seen_parented {
        return Verdict::Orphan;
    }
    if !f.card_mid_turn && f.age >= LEFTOVER_MIN_AGE {
        return Verdict::Leftover(what.clone());
    }
    Verdict::Keep
}

/// End a process and everything under it.
///
/// `/T` rather than a bare terminate for the reason the whole of this work
/// exists: killing one process reaches one process, and the children of the one
/// you just ended are the next thing to leak. They are all inside the card's job
/// and so would go when the card does — but "when the card does" may be
/// tomorrow, and the point of ending one by hand is not to wait.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

/// End one process from the list, by hand.
///
/// **Guarded on job membership, and that guard is the whole safety of this.**
/// `perf.rs` already refuses to *label* a `claude.exe` this studio did not
/// spawn, on the grounds that it is somebody's terminal; a command that ends a
/// process by pid owes the same rule with more force, since mislabelling is a
/// wrong word on a widget and this is somebody's afternoon. Being in one of our
/// jobs is proof of parentage that inspection cannot give — a parentless
/// `bun.exe` is unattributable by looking at it, which is exactly why the ones
/// that leak are the ones nobody could be sure of.
///
/// `async`, because `taskkill` is a process spawn and a wait: see the rule in
/// CLAUDE.md about what blocking the main thread does to every card at once.
#[tauri::command]
pub async fn kill_process(app: AppHandle, pid: u32) -> Result<(), String> {
    crate::off_main(move || {
        let owned = app.state::<Supervisor>().owned_pids();
        let Some(conversation) = owned.get(&pid).cloned() else {
            return Err(format!(
                "pid {pid} is not this studio's to end — nothing on this wall owns it"
            ));
        };
        kill_tree(pid);
        let _ = app.emit(
            "perf:reaped",
            Reaped {
                pid,
                name: String::new(),
                conversation,
                automatic: false,
                command: String::new(),
                why: "by hand".into(),
                bytes: 0,
            },
        );
        Ok(())
    })
    .await?
}

/// One pass over every process in every card's job, ending the two kinds
/// nobody is waiting on. `judge` is the decision; this gathers its facts.
///
/// **An orphan is a process whose parent was seen alive and is now gone** —
/// not, as it was until 2026-10-14, any process whose parent is absent. That
/// older rule killed real work. Git Bash (MSYS) emulates `fork`, so a process a
/// card starts from a Bash tool call has a Windows parent that exits within a
/// second of the child starting: under the old rule it was "parentless" from
/// birth and ended 60–120s later with its whole tree, whatever it was doing.
/// That is what cut cards' `npx vitest` runs off mid-suite with a vacuous exit
/// 0 (sink e9c80389), and what killed labs and `bun test` runs started with
/// `&` (sink 968a4c6b). Requiring the parent to have been *seen* is the
/// discriminator: a process that never had a live parent in our sight is not
/// one that lost it, and the job reaps it when the card goes anyway.
///
/// **A leftover is a heavy check still running after its card's turn ended**,
/// on a card with no background work outstanding. A foreground tool call
/// blocks its turn, so a `tsc` still alive once the turn is over is one whose
/// shell the CLI gave up on — the 2.6 GB orphan the brief for this work found.
/// Only heavy checks (`load::heavy`), never "anything extra": a dev server a
/// card started on purpose is extra and is not a leftover (Lyss chose this
/// line, 2026-10-14).
///
/// The `claude` process itself can never match either rule: its parent is
/// Skein, and Skein is what is running this.
///
/// `parented` is this reaper's memory between passes, keyed on pid *and* start
/// time because a pid is reused once its process is gone.
fn sweep(app: &AppHandle, sys: &mut System, parented: &mut HashSet<(u32, u64)>) -> Vec<Reaped> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let sup = app.state::<Supervisor>();
    let owned = sup.owned_pids();
    /* Command lines and memory for the cards' processes only: reading a command
       line reads another process's memory, and the rest of the machine is not
       this sweep's business. */
    let mine: Vec<Pid> = owned.keys().map(|p| Pid::from_u32(*p)).collect();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&mine),
        false,
        ProcessRefreshKind::nothing().with_memory().with_cmd(UpdateKind::OnlyIfNotSet),
    );

    /* Per card, asked once: is a turn open, and is background work outstanding.
       The two locks are taken one after the other and never together, so this
       establishes no order between the supervisor's map and the store. */
    let ids: HashSet<&String> = owned.values().collect();
    let turns: HashMap<&String, bool> = ids.iter().map(|id| (*id, sup.liveness(id).1)).collect();
    let jobs: HashMap<&String, bool> = {
        let store = app.state::<crate::store::Store>();
        let conn = store.0.lock().ok();
        ids.iter()
            .map(|id| {
                let outstanding = conn
                    .as_ref()
                    .map(|c| crate::store::has_outstanding_jobs(c, id))
                    .unwrap_or(true);
                (*id, outstanding)
            })
            .collect()
    };
    let cards: HashMap<String, (bool, bool)> = ids
        .iter()
        .map(|id| {
            let mid_turn = turns.get(id).copied().unwrap_or(true);
            let outstanding = jobs.get(id).copied().unwrap_or(true);
            ((*id).clone(), (mid_turn, outstanding))
        })
        .collect();

    /* Each card's own `claude.exe`, which is never judged at all — not by
       either rule and not by its argv. The argv rule below already cannot match
       it, and this is the second lock on the same door: the card's process is
       the one thing in its job that ending would end the card. */
    let roots: HashSet<u32> = sup.pids().into_keys().collect();
    let heavy: HashMap<u32, String> = owned
        .keys()
        .filter(|pid| !roots.contains(pid))
        .filter_map(|pid| {
            let p = sys.process(Pid::from_u32(*pid))?;
            crate::load::heavy_argv(p).map(|w| (*pid, w))
        })
        .collect();
    let heavy_of: HashMap<u32, String> = heavy
        .keys()
        .filter_map(|pid| owned.get(pid).map(|c| (*pid, c.clone())))
        .collect();

    let mut seen_now: HashSet<(u32, u64)> = HashSet::new();
    let mut done = Vec::new();
    for (pid, conversation) in &owned {
        if roots.contains(pid) {
            continue;
        }
        let Some(p) = sys.process(Pid::from_u32(*pid)) else {
            continue; // already gone
        };
        let key = (*pid, p.start_time());
        let parent_alive = p.parent().is_some_and(|up| sys.process(up).is_some());
        let (card_mid_turn, card_has_jobs) = cards.get(conversation).copied().unwrap_or((true, true));
        let facts = Facts {
            age: p.run_time(),
            parent_alive,
            seen_parented: parented.contains(&key),
            heavy: heavy.get(pid).cloned(),
            under_heavy: crate::load::under_heavy(sys, *pid, conversation, &heavy_of),
            card_mid_turn,
            card_has_jobs,
        };
        if parent_alive {
            seen_now.insert(key);
        }
        let why = match judge(&facts) {
            Verdict::Keep => continue,
            Verdict::Orphan => "orphan".to_string(),
            Verdict::Leftover(what) => format!("leftover {what}"),
        };
        let bytes = crate::load::tree_bytes(sys, *pid, &owned);
        let command = crate::clip::preview(&crate::load::argv(p), 200);
        kill_tree(*pid);
        done.push(Reaped {
            pid: *pid,
            name: p.name().to_string_lossy().to_string(),
            conversation: conversation.clone(),
            automatic: true,
            command,
            why,
            bytes,
        });
    }
    /* Forget what is gone, so the set is the processes alive now that have been
       seen parented — it never grows past the cards' own trees. */
    parented.retain(|k| sys.process(Pid::from_u32(k.0)).is_some_and(|p| p.start_time() == k.1));
    parented.extend(seen_now);
    done
}

/// Say what the sweep ended: on the card, through `perf:reaped`, and — for a
/// leftover check, or anything that was holding real memory — in the
/// chronicle, where Lyss reads what happened while she was not looking.
///
/// Until now nothing listened to `perf:reaped` at all, so every automatic reap
/// this wall ever made was silent: a card's test run vanished, and the only
/// trace was a log that stopped mid-line (sinks e9c80389, 968a4c6b).
fn report(app: &AppHandle, r: &Reaped) {
    log::info!(
        target: "volery::reaper",
        "ended pid {} ({}) on card {}: {} — {}",
        r.pid, r.why, r.conversation, r.name, r.command
    );
    let _ = app.emit("perf:reaped", r.clone());
    const WORTH_A_ROW: u64 = 200 * 1024 * 1024;
    if !r.why.starts_with("leftover") && r.bytes < WORTH_A_ROW {
        return;
    }
    let row = {
        let store = app.state::<crate::store::Store>();
        let conn = store.0.lock().ok();
        conn.and_then(|c| crate::store::roster_one(&c, &r.conversation))
    };
    /* `note` takes the store lock itself, so the read above is dropped first
       (the trap `chronicle.md` records). */
    let (title, project) = row
        .map(|w| (w.title, Some(w.project_id)))
        .unwrap_or_else(|| (r.conversation.chars().take(8).collect(), None));
    let what = r.why.strip_prefix("leftover ").unwrap_or(&r.why);
    crate::chronicle::note(
        app,
        project.as_deref(),
        &title,
        "note",
        &format!("volery ended a {what} still running on \"{title}\""),
        &format!("{} freed — {}", crate::load::size(r.bytes), r.command),
    );
}

/// Start the sweep. Detached, so it goes when the process does.
///
/// It owns a `System` of its own rather than sharing the meter's: the meter is
/// created on the first widget and dropped with the last, and a reaper that
/// only ran while a performance widget happened to be on the wall would be a
/// guarantee with a decoration for a switch.
///
/// The same wake takes the machine's reading for `load.rs` — memory and the
/// minute's CPU — which is why that module is not a poller of its own.
pub fn spawn_reaper(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new_with_specifics(RefreshKind::nothing());
        let mut parented: HashSet<(u32, u64)> = HashSet::new();
        loop {
            std::thread::sleep(REAP_EVERY);
            crate::load::tick(&app, &mut sys);
            for r in sweep(&app, &mut sys, &mut parented) {
                report(&app, &r);
            }
        }
    });
}

/// Let the sampler go when the last widget comes off the wall. A `System` holds
/// a row per process on the machine, and there is no reason to keep several
/// thousand of them warm for a wall that has stopped asking.
///
/// Dropping a `System` is instant and this would still be wrong on the main
/// thread, which is the half of the rule that is easy to miss: it takes the
/// same mutex `sample_performance` now holds across an entire enumeration, so
/// left sync it would park the thread that paints every card *waiting for the
/// lock* — the freeze back through the door the other fix just closed.
/// `release_azdo` is the same case one subsystem over.
#[tauri::command]
pub async fn release_performance(app: AppHandle) {
    let _ = crate::off_main(move || {
        if let Ok(mut guard) = app.state::<Meter>().0.lock() {
            *guard = None;
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid(n: u32) -> Pid {
        Pid::from_u32(n)
    }

    /// A dev server is `pnpm dev` spawning node spawning esbuild. Only the first
    /// of those is in any of our maps, and a meter that showed the other two as
    /// anonymous strangers would understate the server by most of its cost.
    #[test]
    fn a_grandchild_inherits_the_role_of_whatever_spawned_it() {
        let mut known = HashMap::new();
        known.insert(pid(10), ("server".to_string(), Some("g1".to_string())));
        let parents = HashMap::from([(pid(11), pid(10)), (pid(12), pid(11))]);

        let (role, reference, own) = ancestry(pid(12), &parents, &known).unwrap();
        assert_eq!(role, "server");
        assert_eq!(reference.as_deref(), Some("g1"));
        assert!(!own, "a grandchild is not the process the role was found on");

        let (_, _, own) = ancestry(pid(10), &parents, &known).unwrap();
        assert!(own);
    }

    /// A `claude.exe` this studio did not spawn is somebody's terminal.
    #[test]
    fn an_unrelated_process_is_recognised_as_nothing() {
        let known = HashMap::from([(pid(10), ("studio".to_string(), None))]);
        let parents = HashMap::from([(pid(99), pid(98))]);
        assert!(ancestry(pid(99), &parents, &known).is_none());
    }

    fn idle(age: u64) -> Facts {
        Facts { age, parent_alive: true, ..Facts::default() }
    }

    /// Sinks e9c80389 and 968a4c6b: under Git Bash a child's Windows parent is
    /// gone within a second of its birth. A process that never had a live
    /// parent in the sweep's sight did not *lose* one, and is not an orphan.
    #[test]
    fn a_process_born_without_a_parent_is_not_an_orphan() {
        let f = Facts {
            age: 3600,
            parent_alive: false,
            seen_parented: false,
            heavy: Some("vitest".into()),
            card_mid_turn: true,
            ..Facts::default()
        };
        assert_eq!(judge(&f), Verdict::Keep);
        let lost = Facts { seen_parented: true, ..f };
        assert_eq!(judge(&lost), Verdict::Orphan);
    }

    /// The review's case: `Start-Process pnpm dev` from a `pwsh` that then
    /// exits. Seen parented, parent gone, card still testing against it — and
    /// not a heavy check, so not this reaper's to end.
    #[test]
    fn a_server_a_card_detached_on_purpose_is_never_an_orphan() {
        let f = Facts {
            age: 3600,
            parent_alive: false,
            seen_parented: true,
            card_mid_turn: true,
            ..Facts::default()
        };
        assert_eq!(judge(&f), Verdict::Keep);
        assert_eq!(judge(&Facts { card_mid_turn: false, ..f }), Verdict::Keep);
    }

    /// The old sweep's "honest caveat": a backgrounded call whose shell exited
    /// while the work goes on. Its job row is what says it is wanted.
    #[test]
    fn background_work_on_the_card_spares_everything_in_it() {
        let f = Facts {
            age: 3600,
            parent_alive: false,
            seen_parented: true,
            heavy: Some("vitest".into()),
            card_has_jobs: true,
            ..Facts::default()
        };
        assert_eq!(judge(&f), Verdict::Keep);
    }

    #[test]
    fn a_heavy_check_is_a_leftover_only_once_the_turn_is_over() {
        let running = Facts { heavy: Some("tsc".into()), card_mid_turn: true, ..idle(600) };
        assert_eq!(judge(&running), Verdict::Keep, "the turn may still be waiting on it");
        let left = Facts { card_mid_turn: false, ..running.clone() };
        assert_eq!(judge(&left), Verdict::Leftover("tsc".into()));
        let young = Facts { age: LEFTOVER_MIN_AGE - 1, ..left.clone() };
        assert_eq!(judge(&young), Verdict::Keep);
        // A vitest under the `pnpm test` that started it: the parent is judged,
        // and `/T` takes this one with it.
        let child = Facts { under_heavy: true, ..left };
        assert_eq!(judge(&child), Verdict::Keep);
    }

    /// Lyss's line: a dev server a card started on purpose is extra, and is not
    /// a leftover. Only what `load::heavy` names is.
    #[test]
    fn an_ordinary_process_is_never_a_leftover() {
        assert_eq!(judge(&idle(24 * 3600)), Verdict::Keep);
    }

    /// Pids are reused, so a stale parent map can close a loop. Mislabelling one
    /// row is a bug; hanging the sampler is a frozen wall.
    #[test]
    fn a_parent_loop_ends_rather_than_spinning() {
        let known = HashMap::from([(pid(1), ("studio".to_string(), None))]);
        let parents = HashMap::from([(pid(20), pid(21)), (pid(21), pid(20))]);
        assert!(ancestry(pid(20), &parents, &known).is_none());
    }
}
