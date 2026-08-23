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

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System,
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

#[derive(Debug, Serialize, Clone)]
pub struct Reaped {
    pub pid: u32,
    pub name: String,
    /// The card whose job held it.
    pub conversation: String,
    /// Did the sweep do this, or did somebody press a button?
    pub automatic: bool,
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
            Reaped { pid, name: String::new(), conversation, automatic: false },
        );
        Ok(())
    })
    .await?
}

/// One pass: end everything in a card's job whose parent has gone away.
///
/// Membership in the job says it is ours; a dead parent says nobody is waiting
/// on it. Both halves are needed and neither is a guess — which is the entire
/// reason this reaps *orphans* and not "idle" processes.
///
/// The `claude` process itself can never match: its parent is Skein, and Skein
/// is what is running this.
///
/// **The honest caveat**, recorded because it is the one way this can be
/// wrong: a backgrounded tool call whose shell has exited while the work goes
/// on is indistinguishable from a leak by these two tests, and killing one
/// means a `<task-notification>` that never arrives and a card left holding a
/// job it cannot decrement (`turns.md`). The window is real but narrow —
/// Claude Code keeps the shell up to collect the output — and it was accepted
/// deliberately in exchange for a wall that does not silt up.
fn sweep(app: &AppHandle, sys: &mut System) -> Vec<Reaped> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let owned = app.state::<Supervisor>().owned_pids();
    let mut done = Vec::new();
    for (pid, conversation) in owned {
        let Some(p) = sys.processes().get(&Pid::from_u32(pid)) else {
            continue; // already gone
        };
        if p.run_time() < REAP_MIN_AGE {
            continue;
        }
        if p.parent().is_some_and(|up| sys.processes().contains_key(&up)) {
            continue; // somebody is still above it
        }
        kill_tree(pid);
        done.push(Reaped {
            pid,
            name: p.name().to_string_lossy().to_string(),
            conversation,
            automatic: true,
        });
    }
    done
}

/// Start the sweep. Detached, so it goes when the process does.
///
/// It owns a `System` of its own rather than sharing the meter's: the meter is
/// created on the first widget and dropped with the last, and a reaper that
/// only ran while a performance widget happened to be on the wall would be a
/// guarantee with a decoration for a switch.
pub fn spawn_reaper(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new_with_specifics(RefreshKind::nothing());
        loop {
            std::thread::sleep(REAP_EVERY);
            for r in sweep(&app, &mut sys) {
                let _ = app.emit("perf:reaped", r);
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

    /// Pids are reused, so a stale parent map can close a loop. Mislabelling one
    /// row is a bug; hanging the sampler is a frozen wall.
    #[test]
    fn a_parent_loop_ends_rather_than_spinning() {
        let known = HashMap::from([(pid(1), ("studio".to_string(), None))]);
        let parents = HashMap::from([(pid(20), pid(21)), (pid(21), pid(20))]);
        assert!(ancestry(pid(20), &parents, &known).is_none());
    }
}
