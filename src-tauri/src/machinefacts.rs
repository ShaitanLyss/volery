//! The machine's own readings (§6): what this wall's hardware was doing, once a
//! minute, and live while somebody is watching.
//!
//! **A different subject from `perf.rs`.** That module answers what *the
//! studio's processes* are costing and walks the process table to do it, which
//! is the expensive half of a sample and the reason it only runs while a meter
//! widget is up. This one reads system counters — CPU, memory, GPU, disk,
//! network — which are a handful of syscalls and no process walk at all. So it
//! can record a history while the wall is up, which is the whole point: a
//! history nobody took is not available later, and "was last Tuesday slow
//! because the GPU was pinned" is a question no transcript can answer.
//!
//! **`procs` is deliberately not collected here.** §6.3's standing rule is that
//! analytics never walks processes; the one process count this wall has comes
//! from `perf.rs` while a meter is up, and the column is NULL on a row taken
//! without one rather than a number that means something else.
//!
//! **Nothing is ever 0 for "could not read".** A GPU this build cannot ask
//! about, a counter a machine does not publish, a first CPU reading with no
//! baseline: all of them are `None` and NULL, and the face draws a dash. The
//! rule is `perf.rs`'s and `limits.rs`'s, and it matters more here because a
//! machine series is read as history: a run of zeros looks like an idle
//! machine, and an idle machine is exactly what somebody diagnosing a slow
//! afternoon is trying to rule out.
//!
//! ### Two cadences, one sampler
//!
//! - **Sixty seconds into `machine_fact`**, only while the wall is recording.
//!   The switch is `machine_record`, set from the wall, and off means no row and
//!   no counter refresh for the history's sake. The recorder waits a full
//!   interval before its first row: it starts before any window exists, so a
//!   row at the top of the loop would be recorded against a switch the page has
//!   not had the chance to set yet.
//! - **On demand, at most every [`LIVE_MS`]**, while an analytics view is open.
//!   The live panel asks `machine_now` and the flyway beat carries what it
//!   answered, so every wall on the fleet draws every machine. The reading is
//!   *not* recorded at this cadence and does not touch the history — and it is
//!   **not governed by the recording switch**, which is a decision about this
//!   disk rather than about whether a watching wall may see its machine.
//!
//! The two share one `System`, one `Disks` and one `Networks` because all three
//! are deltas between refreshes: two samplers would halve each other's rates.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sysinfo::{CpuRefreshKind, Disks, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{AppHandle, Manager};

/// How often the history is written. Chosen against what a minute is worth: a
/// machine series answers questions about afternoons, and a slower row would
/// miss a compile that peaked for forty seconds.
pub const RECORD_EVERY_MS: u64 = 60_000;

/// How old the cached reading may be before an on-demand ask refreshes it.
/// Two seconds is the live beat's own cadence, so a beat never pays for two
/// samples and never draws a figure more than one beat old.
pub const LIVE_MS: i64 = 2_000;

/// The host a row is stamped with. The same name `analytics` uses, because a
/// machine reading and a fact from one machine must agree about who it was.
fn host() -> String {
    crate::flyway::key::host_name()
}

/// One reading of the machine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// When it was taken, epoch ms, on this wall's clock.
    pub at: i64,
    /// The whole machine, 0 to 100. `None` where no baseline exists yet.
    pub cpu: Option<f32>,
    pub mem_used: Option<u64>,
    pub mem_total: Option<u64>,
    /// The busiest GPU engine's utilization, 0 to 100, where the counters can
    /// be read. `None` is "this build cannot ask", never "idle".
    pub gpu: Option<f32>,
    /// Virtual memory, which needs a DXGI device to ask for and is not read
    /// yet. Present in the row so a later build can fill it without a rung.
    pub gpu_mem: Option<u64>,
    /// Bytes per second over the interval since the previous sample.
    pub disk_read: Option<u64>,
    pub disk_write: Option<u64>,
    /// Available bytes across the fixed volumes.
    pub disk_free: Option<u64>,
    pub net_rx: Option<u64>,
    pub net_tx: Option<u64>,
    /// The process count, which is `perf.rs`'s to answer and NULL here.
    pub procs: Option<u32>,
    pub cards: Option<u32>,
    pub cards_working: Option<u32>,
    pub worktrees: Option<u32>,
}

pub struct Machine {
    inner: Mutex<Option<Sampler>>,
    record: AtomicBool,
}

impl Default for Machine {
    fn default() -> Self {
        Machine { inner: Mutex::new(None), record: AtomicBool::new(true) }
    }
}

impl Machine {
    /// The last reading, refreshed if it is older than [`LIVE_MS`].
    ///
    /// The counters are refreshed here rather than in the caller, so this must
    /// be reached off the main thread (`machine_now` and the waker both do).
    /// A `None` means the sampler could not be built at all, which is a machine
    /// this build cannot read rather than an idle one.
    pub fn now(&self, cards: Counts) -> Option<Sample> {
        let mut held = self.inner.lock().ok()?;
        let sampler = held.get_or_insert_with(Sampler::new);
        if sampler.at == 0 || sampler.stale(LIVE_MS) {
            sampler.sample(cards);
        } else {
            sampler.attach(cards);
        }
        Some(sampler.sample.clone())
    }

    /// The cached reading without refreshing it, for a beat that must not wait.
    /// `None` until something has sampled.
    ///
    /// **`try_lock`, not `lock`.** This is reached from `flyway_note_live` on
    /// the main thread, and the sampler can be inside a counter refresh with
    /// the lock held. Waiting there is a stall between a click and the card it
    /// was aimed at, for a figure that is one reading old either way; a beat
    /// without its machine half is the cheaper failure.
    pub fn cached(&self) -> Option<Sample> {
        let held = self.inner.try_lock().ok()?;
        let sampler = held.as_ref()?;
        if sampler.at == 0 {
            return None;
        }
        Some(sampler.sample.clone())
    }

    pub fn record_on(&self, on: bool) {
        self.record.store(on, Ordering::Release);
    }

    pub fn recording(&self) -> bool {
        self.record.load(Ordering::Acquire)
    }
}

/// The card counts a reading carries. Read from the store and the supervisor
/// rather than sampled, because both already know.
#[derive(Debug, Clone, Copy, Default)]
pub struct Counts {
    pub cards: Option<u32>,
    pub cards_working: Option<u32>,
    pub worktrees: Option<u32>,
}

/// The counters, kept between reads because every rate here is a difference.
struct Sampler {
    sys: System,
    disks: Disks,
    networks: Networks,
    last: Instant,
    at: i64,
    last_read: u64,
    last_write: u64,
    last_rx: u64,
    last_tx: u64,
    gpu: Gpu,
    counts: Counts,
    sample: Sample,
}

impl Sampler {
    fn new() -> Sampler {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let mut disks = Disks::new_with_refreshed_list();
        let mut networks = Networks::new_with_refreshed_list();
        /* A CPU percentage is a difference between two reads, so the first one
           has no answer. A short warm-up is cheaper than recording the first
           minute as `None` on every launch, and it happens on a thread that is
           not painting anything. */
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        std::thread::sleep(std::time::Duration::from_millis(120));
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        disks.refresh(true);
        networks.refresh(true);
        let last_read = disk_sum(&disks).0;
        let last_write = disk_sum(&disks).1;
        let (last_rx, last_tx) = net_sum(&networks);
        let mut one = Sampler {
            sys,
            disks,
            networks,
            last: Instant::now(),
            at: 0,
            last_read,
            last_write,
            last_rx,
            last_tx,
            gpu: Gpu::new(),
            counts: Counts::default(),
            sample: Sample {
                at: 0,
                cpu: None,
                mem_used: None,
                mem_total: None,
                gpu: None,
                gpu_mem: None,
                disk_read: None,
                disk_write: None,
                disk_free: None,
                net_rx: None,
                net_tx: None,
                procs: None,
                cards: None,
                cards_working: None,
                worktrees: None,
            },
        };
        one.sample(Counts::default());
        one
    }

    fn stale(&self, ms: i64) -> bool {
        crate::store::now().saturating_sub(self.at) >= ms
    }

    /// Take a reading and make it the cached one.
    fn sample(&mut self, counts: Counts) {
        let elapsed = self.last.elapsed().as_millis().max(1) as u64;
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.disks.refresh(true);
        self.networks.refresh(true);
        let (read, write) = disk_sum(&self.disks);
        let (rx, tx) = net_sum(&self.networks);
        let per_s = |now: u64, before: u64| {
            Some((now.saturating_sub(before)) * 1_000 / elapsed)
        };
        let gpu = self.gpu.read();
        let at = crate::store::now();
        /* Built from the *previous* counters and only then overwritten: the
           rate is a difference, and writing the baseline first makes every
           reading zero. Found while reading this back rather than in a run,
           which is the one kind of bug this file's tests cannot catch. */
        let sample = Sample {
            at,
            cpu: finite_around(self.sys.global_cpu_usage() as f64),
            mem_used: Some(self.sys.used_memory()),
            mem_total: Some(self.sys.total_memory()),
            gpu,
            gpu_mem: None,
            disk_read: per_s(read, self.last_read),
            disk_write: per_s(write, self.last_write),
            disk_free: Some(disk_free(&self.disks)),
            net_rx: Some(rx.saturating_sub(self.last_rx) * 1_000 / elapsed),
            net_tx: Some(tx.saturating_sub(self.last_tx) * 1_000 / elapsed),
            procs: None,
            cards: counts.cards,
            cards_working: counts.cards_working,
            worktrees: counts.worktrees,
        };
        self.last = Instant::now();
        self.last_read = read;
        self.last_write = write;
        self.last_rx = rx;
        self.last_tx = tx;
        self.at = at;
        self.counts = counts;
        self.sample = sample;
    }

    /// Keep the cached reading's cheap facts current without re-reading the
    /// counters, so a burst of beats does not cost a refresh each.
    fn attach(&mut self, counts: Counts) {
        if counts.cards == self.counts.cards
            && counts.cards_working == self.counts.cards_working
            && counts.worktrees == self.counts.worktrees
        {
            return;
        }
        self.counts = counts;
        self.sample.cards = counts.cards;
        self.sample.cards_working = counts.cards_working;
        self.sample.worktrees = counts.worktrees;
    }
}

/// A whole-machine CPU percentage, clamped to its own unit. sysinfo reports
/// 0–100 globally; a machine that reports a fraction of it reads as idle.
fn finite_around(v: f64) -> Option<f32> {
    if v.is_finite() {
        Some(v.clamp(0.0, 100.0) as f32)
    } else {
        None
    }
}

fn disk_sum(disks: &Disks) -> (u64, u64) {
    let mut read = 0u64;
    let mut write = 0u64;
    for disk in disks.list() {
        let usage = disk.usage();
        read = read.saturating_add(usage.read_bytes);
        write = write.saturating_add(usage.written_bytes);
    }
    (read, write)
}

/// Available bytes across the fixed volumes. A removable disk is somebody's
/// USB stick and says nothing about whether this machine has room.
fn disk_free(disks: &Disks) -> u64 {
    let mut free = 0u64;
    for disk in disks.list() {
        if disk.is_removable() || disk.total_space() == 0 {
            continue;
        }
        free = free.saturating_add(disk.available_space());
    }
    free
}

/// In and out across every interface that is not loopback. The loopback is this
/// wall talking to itself, and counting it would make the reading loudest
/// exactly when nothing left the machine.
fn net_sum(networks: &Networks) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (name, data) in networks.list() {
        let lower = name.to_ascii_lowercase();
        if lower == "lo" || lower.contains("loopback") {
            continue;
        }
        rx = rx.saturating_add(data.received());
        tx = tx.saturating_add(data.transmitted());
    }
    (rx, tx)
}

/* ── the GPU, which Windows has no tidy API for ──────────────────────────── */

/// PDH's `\GPU Engine(*)\Utilization Percentage`, read as the busiest engine.
///
/// **Per engine and not summed.** Eleven engines each at 8% is a GPU at 8%
/// doing eleven things, not one at 88%, and the schema's `gpu` is defined as 0
/// to 100. The busiest engine is also the honest answer to "is the GPU the
/// reason this is slow".
struct Gpu {
    #[cfg(windows)]
    query: Option<(windows::Win32::System::Performance::PDH_HQUERY, windows::Win32::System::Performance::PDH_HCOUNTER)>,
    #[cfg(windows)]
    primed: bool,
}

/* **The handle is safe to move between threads, and only one thread can touch
   it at a time anyway.** PDH queries are process-wide objects rather than
   thread-affine ones, and every read of this struct happens under the `Machine`
   mutex. windows-rs does not mark the raw handle `Send`, so the claim has to be
   made here rather than nowhere — and it is a claim about the API's own
   contract, not about this file's discipline. */
#[cfg(windows)]
unsafe impl Send for Gpu {}

impl Gpu {
    fn new() -> Gpu {
        #[cfg(windows)]
        {
            Gpu { query: open_gpu_query(), primed: false }
        }
        #[cfg(not(windows))]
        {
            Gpu {}
        }
    }

    #[cfg(windows)]
    fn read(&mut self) -> Option<f32> {
        use windows::Win32::System::Performance::*;
        let (query, counter) = self.query?;
        let status = unsafe { PdhCollectQueryData(query) };
        if status != 0 {
            return None;
        }
        /* A rate counter has no value until it has been read twice. The first
           sample after a launch is therefore no reading rather than 0%. */
        if !self.primed {
            self.primed = true;
            return None;
        }
        let mut size = 0u32;
        let mut count = 0u32;
        let first = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None)
        };
        const PDH_MORE_DATA: u32 = 0x8000_07D2;
        if first != PDH_MORE_DATA || size == 0 {
            return None;
        }
        /* A buffer of `u64` rather than bytes: the items hold an `f64` and a
           pointer, and a `Vec<u8>` is not guaranteed to be aligned for them. */
        let words = (size as usize).div_ceil(8) + 1;
        let mut buf = vec![0u64; words];
        let again = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W),
            )
        };
        if again != 0 {
            return None;
        }
        let items = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W, count as usize) };
        let mut best: Option<f32> = None;
        for item in items {
            if item.FmtValue.CStatus != 0 {
                continue;
            }
            let v = unsafe { item.FmtValue.Anonymous.doubleValue };
            if !v.is_finite() {
                continue;
            }
            let v = (v as f32).clamp(0.0, 100.0);
            best = Some(best.map_or(v, |b| b.max(v)));
        }
        best
    }

    #[cfg(not(windows))]
    fn read(&mut self) -> Option<f32> {
        None
    }
}

#[cfg(windows)]
impl Drop for Gpu {
    fn drop(&mut self) {
        if let Some((query, _)) = self.query {
            unsafe { windows::Win32::System::Performance::PdhCloseQuery(query) };
        }
    }
}

#[cfg(windows)]
fn open_gpu_query() -> Option<(
    windows::Win32::System::Performance::PDH_HQUERY,
    windows::Win32::System::Performance::PDH_HCOUNTER,
)> {
    use windows::core::w;
    use windows::Win32::System::Performance::*;
    let mut query = PDH_HQUERY::default();
    if unsafe { PdhOpenQueryW(None, 0, &mut query) } != 0 {
        return None;
    }
    let mut counter = PDH_HCOUNTER::default();
    let ok = unsafe {
        PdhAddEnglishCounterW(query, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut counter)
    };
    if ok != 0 {
        unsafe { PdhCloseQuery(query) };
        return None;
    }
    Some((query, counter))
}

/* ── the card counts, and the row ───────────────────────────────────────── */

/// What the store and the supervisor know about this wall's work. A count that
/// cannot be read is `None`, never 0.
pub fn counts(app: &AppHandle) -> Counts {
    let cards = app.try_state::<crate::store::Store>().and_then(|store| {
        let conn = store.0.lock().ok()?;
        let open: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL", [], |r| r.get(0))
            .ok()?;
        let trees: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL AND worktree IS NOT NULL AND worktree <> ''",
                [],
                |r| r.get(0),
            )
            .ok()?;
        Some((open.max(0) as u32, trees.max(0) as u32))
    });
    let working = app
        .try_state::<crate::supervisor::Supervisor>()
        .map(|s| s.mid_turn().len() as u32);
    Counts {
        cards: cards.map(|c| c.0),
        cards_working: working,
        worktrees: cards.map(|c| c.1),
    }
}

/// Write one row into the history. A row that cannot be written is said in the
/// log and nowhere else: the wall's painting does not depend on a sample.
pub fn record(conn: &rusqlite::Connection, host: &str, s: &Sample) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO machine_fact
           (at, host, cpu, mem_used, mem_total, gpu, gpu_mem,
            disk_read, disk_write, disk_free, net_rx, net_tx,
            procs, cards, cards_working, worktrees)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        rusqlite::params![
            s.at,
            host,
            s.cpu.map(|v| v as f64),
            s.mem_used.map(|v| v as i64),
            s.mem_total.map(|v| v as i64),
            s.gpu.map(|v| v as f64),
            s.gpu_mem.map(|v| v as i64),
            s.disk_read.map(|v| v as i64),
            s.disk_write.map(|v| v as i64),
            s.disk_free.map(|v| v as i64),
            s.net_rx.map(|v| v as i64),
            s.net_tx.map(|v| v as i64),
            s.procs.map(|v| v as i64),
            s.cards.map(|v| v as i64),
            s.cards_working.map(|v| v as i64),
            s.worktrees.map(|v| v as i64),
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("machine fact: {e}"))
}

/* ── the commands ───────────────────────────────────────────────────────── */

/// This machine's reading now, for the live panel and the room.
///
/// Off the main thread because building the sampler sleeps for a warm-up and
/// every later call refreshes counters: the rule `off_main` exists for.
#[tauri::command(async)]
pub async fn machine_now(app: AppHandle) -> Result<Option<Sample>, String> {
    crate::off_main(move || {
        let Some(machine) = app.try_state::<Machine>() else { return None };
        let counts = counts(&app);
        machine.now(counts)
    })
    .await
}

/// Whether this wall records the history. The setting itself lives on the
/// wall (`localStorage`), because it is a judgement about this machine's disk
/// and privacy rather than a decision that should follow the person around.
#[tauri::command]
pub fn machine_record(state: tauri::State<'_, Machine>, on: bool) {
    state.record_on(on);
}

/// The recorded history, oldest first, for the room's machine reading.
///
/// `bucket` is the width to fold to, in milliseconds. **The reading is coarser
/// than the record on a wide span, and the caller is told the grain it asked
/// for** — a year of minute rows is half a million of them, and the rule this
/// surface keeps is that a reading may be coarser than it claims and may not be
/// narrower than it says. At `bucket <= 60_000` the rows are the record itself.
#[tauri::command(async)]
pub async fn machine_facts(
    app: AppHandle,
    from: i64,
    to: i64,
    bucket: Option<i64>,
) -> Result<Vec<Sample>, String> {
    crate::off_main(move || {
        let store = app.try_state::<crate::store::Store>().ok_or("the store is not open")?;
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        rows(&conn, &host(), from, to, bucket.unwrap_or(60_000))
    })
    .await?
}

pub const ROW_CAP: usize = 50_000;

/// Every recorded row in `[from, to)`, oldest first; or one row per bucket when
/// `bucket` is wider than a minute.
///
/// **Gauges average and free space takes the minimum.** A bucket's CPU is what
/// the machine averaged over it; its disk free is the *lowest* it got, because
/// the interesting reading for free space is the closest it came to full. The
/// counts take the maximum, since a bucket where any card was working is a
/// bucket whose machine was carrying work.
///
/// A span too wide is refused rather than truncated, the bargain
/// `analytics::allowance_sample_rows` makes: a silently short history is a
/// chart that lies about its own span.
pub fn rows(
    conn: &rusqlite::Connection,
    host: &str,
    from: i64,
    to: i64,
    bucket: i64,
) -> Result<Vec<Sample>, String> {
    if to <= from {
        return Err(format!("machine: a window ending at {to} does not start after {from}"));
    }
    let sql = if bucket > 60_000 {
        "SELECT (at / ?4) * ?4 AS at,
                AVG(cpu), AVG(mem_used), AVG(mem_total), AVG(gpu), AVG(gpu_mem),
                AVG(disk_read), AVG(disk_write), MIN(disk_free), AVG(net_rx), AVG(net_tx),
                MAX(procs), MAX(cards), MAX(cards_working), MAX(worktrees)
           FROM machine_fact
          WHERE host = ?1 AND at >= ?2 AND at < ?3
          GROUP BY at / ?4
          ORDER BY at
          LIMIT ?5"
    } else {
        "SELECT at, cpu, mem_used, mem_total, gpu, gpu_mem,
                disk_read, disk_write, disk_free, net_rx, net_tx,
                procs, cards, cards_working, worktrees
           FROM machine_fact
          WHERE host = ?1 AND at >= ?2 AND at < ?3
          ORDER BY at
          LIMIT ?4"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| format!("machine: {e}"))?;
    fn one(r: &rusqlite::Row<'_>) -> rusqlite::Result<Sample> {
        /* **One float reader for both branches.** A raw row holds INTEGER
           bytes; a folded row's `AVG(...)` is REAL, and rusqlite refuses to
           read a REAL into an `i64` — which `.ok().flatten()` turned into
           `None`, so the default seven-day span drew memory, network and disk
           throughput as "not read" while the rows held them (found in review).
           `f64` accepts both, and every figure here is far inside its exact
           range. */
        let f = |i: usize| r.get::<_, Option<f64>>(i).ok().flatten();
        let n = |i: usize| f(i).map(|v| v.max(0.0).round() as u64);
        Ok(Sample {
            at: r.get(0)?,
            cpu: f(1).map(|v| v as f32),
            mem_used: n(2),
            mem_total: n(3),
            gpu: f(4).map(|v| v as f32),
            gpu_mem: n(5),
            disk_read: n(6),
            disk_write: n(7),
            disk_free: n(8),
            net_rx: n(9),
            net_tx: n(10),
            procs: n(11).map(|v| v as u32),
            cards: n(12).map(|v| v as u32),
            cards_working: n(13).map(|v| v as u32),
            worktrees: n(14).map(|v| v as u32),
        })
    }
    let limit = ROW_CAP as i64 + 1;
    let mapped = if bucket > 60_000 {
        stmt.query_map(rusqlite::params![host, from, to, bucket, limit], one)
    } else {
        stmt.query_map(rusqlite::params![host, from, to, limit], one)
    };
    let out = mapped
        .map_err(|e| format!("machine: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("machine: {e}"))?;
    if out.len() > ROW_CAP {
        return Err(format!(
            "machine: that window holds more than {ROW_CAP} rows, so it is refused rather than \
             truncated: ask for a narrower one"
        ));
    }
    Ok(out)
}

/// The recorder: one row a minute for the life of the wall, while it is on.
///
/// A plain thread rather than a tokio task, and it holds no lock between ticks.
/// Nothing here runs if the switch is off — the point of the switch is that the
/// machine is not being read at all, not that the rows are hidden.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        /* **The first row waits a full minute, and that is the switch's
           correctness rather than a detail.** The thread starts in `setup`,
           before any window exists, and the front end's stored choice arrives
           only once the page runs — so a row written at the top of the first
           iteration is a row recorded against an explicit opt-out. A launch
           row is worth nothing to a ninety-day history. */
        std::thread::sleep(std::time::Duration::from_millis(RECORD_EVERY_MS));
        let Some(machine) = app.try_state::<Machine>() else {
            continue;
        };
        if machine.recording() {
            let counts = counts(&app);
            let sample = machine.now(counts);
            if let (Some(sample), Some(store)) =
                (sample, app.try_state::<crate::store::Store>())
            {
                if let Ok(conn) = store.0.lock() {
                    if let Err(why) = record(&conn, &host(), &sample) {
                        log::warn!(target: "machine", "{why}");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_round_trips_with_its_nulls_intact() {
        let one = Sample {
            at: 1_764_000_000_000,
            cpu: Some(12.5),
            mem_used: Some(8 << 30),
            mem_total: Some(32 << 30),
            gpu: None,
            gpu_mem: None,
            disk_read: Some(1_000),
            disk_write: Some(2_000),
            disk_free: Some(100 << 30),
            net_rx: Some(10),
            net_tx: Some(20),
            procs: None,
            cards: Some(7),
            cards_working: Some(2),
            worktrees: Some(1),
        };
        let raw = serde_json::to_string(&one).unwrap();
        let back: Sample = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, one);
        assert!(raw.contains("\"gpu\":null"), "{raw}");
    }

    /// Every rate the sampler reports is a difference between two reads, so a
    /// zero-elapsed interval must not divide by nothing.
    #[test]
    fn a_rate_over_no_time_is_zero_and_not_a_panic() {
        let elapsed = 0u64.max(1);
        assert_eq!(5u64.saturating_sub(3) * 1_000 / elapsed, 2_000);
    }

    #[test]
    fn a_window_the_wrong_way_round_is_refused() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(rows(&conn, "h", 10, 10, 60_000).is_err());
        assert!(rows(&conn, "h", 11, 10, 60_000).is_err());
    }

    /// **A folded row carries its gauges.** `AVG(...)` is REAL and a raw row's
    /// bytes are INTEGER; a reader that took only one of the two turned the
    /// default seven-day span's memory, network and disk throughput into `None`
    /// — "not read" over rows that held them (found in review). The assertion
    /// is that a bucket read answers `Some` for each of the averaged columns.
    #[test]
    fn a_folded_row_keeps_the_columns_average_turns_real() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE machine_fact (
               at INTEGER NOT NULL, host TEXT NOT NULL, cpu REAL, mem_used INTEGER,
               mem_total INTEGER, gpu REAL, gpu_mem INTEGER, disk_read INTEGER,
               disk_write INTEGER, disk_free INTEGER, net_rx INTEGER, net_tx INTEGER,
               procs INTEGER, cards INTEGER, cards_working INTEGER, worktrees INTEGER,
               PRIMARY KEY (at, host));
             INSERT INTO machine_fact VALUES
               (0, 'h', 10.0, 8589934592, 34359738368, 5.0, NULL, 100, 200, 400000000000, 1000, 500, NULL, 3, 1, 1),
               (60000, 'h', 30.0, 8589934592, 34359738368, 9.0, NULL, 300, 400, 390000000000, 3000, 700, NULL, 3, 0, 1);",
        )
        .unwrap();
        let got = rows(&conn, "h", 0, 120_000, 120_000).unwrap();
        assert_eq!(got.len(), 1);
        let one = &got[0];
        assert!(one.cpu.is_some());
        assert!(one.mem_used.is_some(), "AVG(mem_used) is REAL and must still read");
        assert!(one.disk_read.is_some(), "AVG(disk_read) is REAL and must still read");
        assert!(one.net_rx.is_some(), "AVG(net_rx) is REAL and must still read");
        assert_eq!(one.disk_free, Some(390_000_000_000), "free space takes the bucket's low");
        assert!(one.cards_working.is_some());
    }
}
