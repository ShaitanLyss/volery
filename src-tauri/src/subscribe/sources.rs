//! Event sources: what Lyss configured, and the connection each one holds
//! while anybody is subscribed to it.
//!
//! **A source is named, and the name is all a card ever sees.** Lyss enters a
//! name, a connection string and a consumer group in the integrations panel;
//! the connection string goes to the Windows vault under
//! `dev.skein.studio/source/<name>` and the rest to the `source` table. A card
//! subscribes to `nova-feedback` and never holds the key — the same line
//! `creds.rs` draws, where the front end names a service and never a vault
//! target, and the same reason: a command that took a target would be a
//! command that could reach any credential on the machine.
//!
//! **No subscribers, no connection.** A source is dialled while at least one
//! subscription uses it and hung up when the last one goes (`reconcile`). Its
//! checkpoints stay, so the next connection catches up from where this wall
//! stopped reading.
//!
//! **Several walls read one stream as non-epoch receivers on one consumer
//! group.** Every non-epoch reader gets every event (up to five per partition),
//! and each wall keeps its own checkpoints in its own SQLite, so AU-LT-288 and
//! QUEERISFREEDOM both read the Nova feedback stream with no consumer group
//! apiece. A subscription lives on the wall its card is on, and only that wall
//! connects for it.
//!
//! The runner is generic over `Source`, so the reading loop — positions from
//! checkpoints, ingest, reconnect — is tested against a fake (`pump`'s tests)
//! with no network.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::ledger::{self, Arrival, Start};
use crate::store::Store;

/* ── the generic interface ──────────────────────────────────────────────── */

/// One event as a source hands it over.
#[derive(Debug, Clone, PartialEq)]
pub struct Raw {
    pub partition: String,
    pub sequence: i64,
    /// Epoch milliseconds, on the source's clock.
    pub enqueued_at: i64,
    pub properties: Map<String, Value>,
    pub body: Vec<u8>,
}

/// Something that yields `(partition, sequence, enqueued_at, properties,
/// body)` from a position. Event Hubs is the first; a webhook receiver or a
/// Fabric Activator would be another. Checkpointing is the wall's, not the
/// source's: positions come in from `ledger::start_for`, and `ingest` writes
/// them back.
pub trait Source {
    fn partitions(&mut self) -> Result<Vec<String>, String>;
    fn open(&mut self, partition: &str, from: Start) -> Result<(), String>;
    /// The next event, or `None` at the deadline. An error is a connection
    /// lost: the runner redials and starts again from the checkpoints.
    fn next(&mut self, deadline: Instant) -> Result<Option<Raw>, String>;
    fn close(&mut self);
}

/// How long one event's line may be in the turn a card is handed. Nova's are
/// a few hundred bytes; this is for the event somebody puts a document in.
const MAX_LINE: usize = 4_000;

/// An event's two readings: the fields a filter is evaluated against —
/// application properties overlaid by the body's own fields, body winning —
/// and the one line the card is handed.
pub fn arrival(raw: &Raw) -> Arrival {
    let mut fields = raw.properties.clone();
    match serde_json::from_slice::<Value>(&raw.body) {
        Ok(Value::Object(body)) => {
            for (k, v) in body {
                fields.insert(k, v);
            }
        }
        Ok(other) => {
            fields.insert("body".into(), other);
        }
        Err(_) if raw.body.is_empty() => {}
        Err(_) => {
            fields.insert("body".into(), Value::String(String::from_utf8_lossy(&raw.body).into_owned()));
        }
    }
    let line = serde_json::to_string(&fields).unwrap_or_default();
    let line = crate::clip::keep(&line, MAX_LINE)
        .marked("This event was longer than the wall hands over in one line; ask the user if the rest matters.")
        .to_string();
    Arrival {
        partition: raw.partition.clone(),
        sequence: raw.sequence,
        enqueued_at: raw.enqueued_at,
        fields,
        line,
    }
}

/// One connected session of a source: position every partition from the
/// checkpoints, then read until stopped or the connection fails. `Ok` only on
/// a stop. `told` is called once per card that has something new waiting.
pub fn pump<S: Source + ?Sized>(
    src: &mut S,
    db: &Mutex<Connection>,
    name: &str,
    stop: &AtomicBool,
    connected: &dyn Fn(),
    told: &dyn Fn(String),
) -> Result<(), String> {
    let parts = src.partitions()?;
    let starts: Vec<(String, Start)> = {
        let conn = db.lock().map_err(|_| "the store is unavailable".to_string())?;
        let Some(oldest) = ledger::oldest_on(&conn, name) else { return Ok(()) };
        parts
            .iter()
            .map(|p| (p.clone(), ledger::start_for(ledger::checkpoint(&conn, name, p), oldest)))
            .collect()
    };
    for (p, from) in &starts {
        src.open(p, *from)?;
    }
    connected();
    loop {
        if stop.load(Ordering::Relaxed) {
            src.close();
            return Ok(());
        }
        let Some(raw) = src.next(Instant::now() + Duration::from_secs(5))? else { continue };
        let a = arrival(&raw);
        let cards = {
            let conn = db.lock().map_err(|_| "the store is unavailable".to_string())?;
            /* Checked under the lock: a source repointed at another hub clears
               its checkpoints after halting this reader, and an event of the
               old hub's written after that would sit in the new hub's
               checkpoint and skip everything below it. */
            if stop.load(Ordering::Relaxed) {
                drop(conn);
                src.close();
                return Ok(());
            }
            ledger::ingest(&conn, name, &a, crate::store::now())?
        };
        for c in cards {
            told(c);
        }
    }
}

/* ── the registry ───────────────────────────────────────────────────────── */

/// The vault entry a source's connection string lives under. The one place
/// the string is spelled, and `dev.skein.studio` for `vault.rs`'s reason: it
/// is a name the disk depends on.
pub fn target(name: &str) -> String {
    format!("dev.skein.studio/source/{name}")
}

/// `src/lib/sources.ts::validName` holds the same rule.
pub fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-'))
}

#[derive(Debug, Clone)]
pub struct Configured {
    pub name: String,
    pub kind: String,
    pub consumer_group: String,
    pub namespace: String,
    pub entity: String,
}

pub fn configured(conn: &Connection) -> Vec<Configured> {
    let Ok(mut stmt) = conn.prepare("SELECT name, kind, consumer_group, namespace, entity FROM source ORDER BY name")
    else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok(Configured {
            name: r.get(0)?,
            kind: r.get(1)?,
            consumer_group: r.get(2)?,
            namespace: r.get(3)?,
            entity: r.get(4)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

pub fn one(conn: &Connection, name: &str) -> Option<Configured> {
    configured(conn).into_iter().find(|c| c.name == name)
}

/* ── runners ────────────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Default)]
struct Reading {
    state: &'static str,
    fault: String,
}

struct Runner {
    stop: Arc<AtomicBool>,
    nudge: Sender<()>,
    cutter: Arc<Mutex<Option<Arc<crate::amqp::ws::Cutter>>>>,
}

impl Runner {
    fn halt(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.nudge.send(());
        if let Ok(c) = self.cutter.lock() {
            if let Some(c) = c.as_ref() {
                c.cut();
            }
        }
    }
}

/// Managed state: one runner per source being read, and what each is doing.
#[derive(Default)]
pub struct Runners {
    running: Mutex<HashMap<String, Runner>>,
    readings: Mutex<HashMap<String, Reading>>,
}

fn changed(app: &AppHandle) {
    let _ = app.emit("sources:changed", ());
}

fn set_reading(app: &AppHandle, name: &str, state: &'static str, fault: &str) {
    if let Some(r) = app.try_state::<Runners>() {
        if let Ok(mut m) = r.readings.lock() {
            m.insert(name.to_string(), Reading { state, fault: fault.to_string() });
        }
    }
    changed(app);
}

/// Bring the running set into line with the subscriptions: dial every source
/// somebody is subscribed to, hang up every one nobody is.
pub fn reconcile(app: &AppHandle) {
    let Some(runners) = app.try_state::<Runners>() else { return };
    /* The running set is held across the read of what is wanted, so two
       reconciles cannot interleave — one reading "nothing wanted" and halting a
       runner the other had just found already up for its new subscriber. The
       order is running → store, and nothing takes them the other way round. */
    let Ok(mut running) = runners.running.lock() else { return };
    let (wanted, known) = {
        let Some(store) = app.try_state::<Store>() else { return };
        let Ok(conn) = store.0.lock() else { return };
        (ledger::sources_in_use(&conn), configured(&conn).into_iter().map(|c| c.name).collect::<Vec<_>>())
    };
    let gone: Vec<String> = running.keys().filter(|n| !wanted.contains(n)).cloned().collect();
    for n in gone {
        if let Some(r) = running.remove(&n) {
            r.halt();
        }
    }
    for n in wanted {
        if running.contains_key(&n) || !known.contains(&n) {
            continue;
        }
        running.insert(n.clone(), spawn_runner(app.clone(), n));
    }
}

/// Hang one up. Its stop flag is set before this returns, and `pump` checks
/// it under the store's lock before every ingest — so once this has run, the
/// old connection writes no further checkpoint.
fn halt(app: &AppHandle, name: &str) {
    if let Some(runners) = app.try_state::<Runners>() {
        if let Ok(mut running) = runners.running.lock() {
            if let Some(r) = running.remove(name) {
                r.halt();
            }
        }
    }
}

/// Hang one up and dial it again — its connection string or group changed.
fn restart(app: &AppHandle, name: &str) {
    halt(app, name);
    reconcile(app);
}

/// The backoff between failed connections: doubling from a second to five
/// minutes, so a source down for an afternoon costs a dozen attempts an hour.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);

fn spawn_runner(app: AppHandle, name: String) -> Runner {
    let stop = Arc::new(AtomicBool::new(false));
    let (nudge, woken) = mpsc::channel::<()>();
    let cutter: Arc<Mutex<Option<Arc<crate::amqp::ws::Cutter>>>> = Arc::new(Mutex::new(None));
    let r = Runner { stop: stop.clone(), nudge, cutter: cutter.clone() };
    std::thread::Builder::new()
        .name(format!("source {name}"))
        .spawn(move || run(app, name, stop, woken, cutter))
        .ok();
    r
}

fn run(
    app: AppHandle,
    name: String,
    stop: Arc<AtomicBool>,
    woken: Receiver<()>,
    cutter: Arc<Mutex<Option<Arc<crate::amqp::ws::Cutter>>>>,
) {
    let mut backoff = BACKOFF_MIN;
    while !stop.load(Ordering::Relaxed) {
        set_reading(&app, &name, "connecting", "");
        let began = Instant::now();
        let outcome = session(&app, &name, &stop, &cutter);
        if let Ok(mut c) = cutter.lock() {
            *c = None;
        }
        match outcome {
            Ok(()) => break,
            Err(e) if stop.load(Ordering::Relaxed) => {
                let _ = e;
                break;
            }
            Err(e) => {
                eprintln!("[source {name}] {e}");
                set_reading(&app, &name, "failing", &e);
                /* A connection that held for a while and then dropped is the
                   ordinary case — a laptop waking — and starts the ladder
                   again rather than inheriting the last climb. */
                if began.elapsed() > Duration::from_secs(120) {
                    backoff = BACKOFF_MIN;
                }
                if let Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) = woken.recv_timeout(backoff) {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
    set_reading(&app, &name, "idle", "");
}

fn session(
    app: &AppHandle,
    name: &str,
    stop: &AtomicBool,
    cutter: &Mutex<Option<Arc<crate::amqp::ws::Cutter>>>,
) -> Result<(), String> {
    let Some(store) = app.try_state::<Store>() else { return Ok(()) };
    let cfg = {
        let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
        one(&conn, name).ok_or_else(|| format!("{name} is no longer configured"))?
    };
    let secret = crate::vault::read_at(&target(name))
        .ok_or("no connection string is stored for it — add one in the integrations panel")?;
    let cs = crate::eventhub::ConnString::parse(&secret)?;
    let mut hub = crate::eventhub::EventHub::connect(&cs, &cfg.consumer_group)?;
    if let Ok(mut c) = cutter.lock() {
        *c = hub.cutter();
    }
    if stop.load(Ordering::Relaxed) {
        crate::eventhub::EventHub::close(&mut hub);
        return Ok(());
    }
    let app2 = app.clone();
    let connected = move || set_reading(&app2, name, "connected", "");
    let app3 = app.clone();
    let told = move |card: String| super::arrived(&app3, card);
    pump(&mut hub, &store.0, name, stop, &connected, &told)
}

/// Record a source, clearing its checkpoints if it now points at another hub.
/// The whole of `set_source`'s write, under the one lock its caller holds.
fn save(conn: &Connection, name: &str, group: &str, namespace: &str, entity: &str, moved: bool) -> Result<(), String> {
    if moved {
        ledger::clear_checkpoints(conn, name);
    }
    conn.execute(
        "INSERT INTO source (name, kind, consumer_group, namespace, entity, created_at)
         VALUES (?1, 'eventhub', ?2, ?3, ?4, ?5)
         ON CONFLICT(name) DO UPDATE SET
           consumer_group = excluded.consumer_group,
           namespace = excluded.namespace, entity = excluded.entity",
        params![name, group, namespace, entity, crate::store::now()],
    )
    .map_err(|e| format!("record source: {e}"))?;
    Ok(())
}

/* ── what the panel reads and does ──────────────────────────────────────── */

/// One source as the integrations panel draws it. Never the secret — `held`
/// says whether one is stored, which is the most the front end is told.
#[derive(Serialize, Clone)]
pub struct SourceRow {
    pub name: String,
    pub kind: String,
    pub consumer_group: String,
    pub namespace: String,
    pub entity: String,
    pub held: bool,
    pub subscribers: i64,
    pub state: String,
    pub fault: String,
}

fn row_of(app: &AppHandle, conn: &Connection, c: Configured) -> SourceRow {
    let reading = app
        .try_state::<Runners>()
        .and_then(|r| r.readings.lock().ok().and_then(|m| m.get(&c.name).cloned()))
        .unwrap_or_default();
    let subscribers = ledger::count_on_source(conn, &c.name);
    SourceRow {
        held: crate::vault::held_at(&target(&c.name)),
        subscribers,
        state: if subscribers == 0 || reading.state.is_empty() { "idle".into() } else { reading.state.into() },
        fault: reading.fault,
        name: c.name,
        kind: c.kind,
        consumer_group: c.consumer_group,
        namespace: c.namespace,
        entity: c.entity,
    }
}

#[tauri::command]
pub async fn sources_list(app: AppHandle) -> Result<Vec<SourceRow>, String> {
    crate::off_main(move || {
        let store = app.try_state::<Store>().ok_or("the store is unavailable")?;
        let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
        Ok(configured(&conn).into_iter().map(|c| row_of(&app, &conn, c)).collect())
    })
    .await?
}

/// Add a source or change one. `connection` `None` keeps the stored secret —
/// a consumer-group change — and a new source must bring one.
#[tauri::command]
pub async fn set_source(
    app: AppHandle,
    name: String,
    connection: Option<String>,
    consumer_group: Option<String>,
) -> Result<SourceRow, String> {
    crate::off_main(move || {
        let name = name.trim().to_string();
        if !valid_name(&name) {
            return Err(format!(
                "{name:?} cannot be a source name — lowercase letters, digits, `.`, `_` and `-`, \
                 starting with a letter or digit, up to 64"
            ));
        }
        let store = app.try_state::<Store>().ok_or("the store is unavailable")?;
        let existing = {
            let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
            one(&conn, &name)
        };
        let group = consumer_group
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .or_else(|| existing.as_ref().map(|e| e.consumer_group.clone()))
            .unwrap_or_else(|| "$Default".into());
        let connection = connection.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        let (namespace, entity) = match (&connection, &existing) {
            (Some(c), _) => {
                let cs = crate::eventhub::ConnString::parse(c)?;
                (cs.host, cs.entity)
            }
            (None, Some(e)) => (e.namespace.clone(), e.entity.clone()),
            (None, None) => return Err("a new source needs its connection string".into()),
        };
        if let Some(c) = &connection {
            crate::vault::store_at(&target(&name), &format!("event source {name} (volery)"), c)?;
        }
        /* Sequence numbers belong to one hub. Pointing the name at another
           leaves checkpoints that would skip — or replay — everything, so they
           go; the subscriptions' own start times bound the rest. The old hub's
           reader is halted *before* the clear, and `pump` checks its flag
           under the store's lock, so it writes nothing after it. */
        let moved = existing.as_ref().is_some_and(|e| e.namespace != namespace || e.entity != entity);
        if moved {
            halt(&app, &name);
        }
        {
            /* One lock, taken once. The first cut of the clear above re-took
               this mutex while still holding it whenever the source was *not*
               moved — every new source — and a std mutex is not re-entrant:
               the store deadlocked, and with it every command on the wall.
               Volery froze on "adding…" on AU-LT-288, twice (sink 798e9b1c).
               `save` is the whole write, under the one guard, and is tested. */
            let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
            save(&conn, &name, &group, &namespace, &entity, moved)?;
        }
        restart(&app, &name);
        changed(&app);
        let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
        let row = one(&conn, &name).ok_or("the source did not stick")?;
        Ok(row_of(&app, &conn, row))
    })
    .await?
}

/// Take a source away — refused while anything is subscribed to it, since a
/// subscription on a source that is gone is a card waiting for ever.
#[tauri::command]
pub async fn forget_source(app: AppHandle, name: String) -> Result<(), String> {
    crate::off_main(move || {
        let store = app.try_state::<Store>().ok_or("the store is unavailable")?;
        {
            let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
            let n = ledger::count_on_source(&conn, &name);
            if n > 0 {
                return Err(format!(
                    "{n} subscription{} still use{} {name} — the cards holding them would wait for \
                     ever. They go when those cards unsubscribe, close or are cleared.",
                    if n == 1 { "" } else { "s" },
                    if n == 1 { "s" } else { "" }
                ));
            }
            conn.execute("DELETE FROM source WHERE name = ?1", [&name]).map_err(|e| e.to_string())?;
            ledger::clear_checkpoints(&conn, &name);
        }
        crate::vault::clear_at(&target(&name))?;
        restart(&app, &name);
        changed(&app);
        Ok(())
    })
    .await?
}

/// Dial it, authenticate, and ask how many partitions it has — the source's
/// `check it`. Answered in the `Verdict` shape every other check uses.
#[tauri::command]
pub async fn check_source(app: AppHandle, name: String) -> Result<crate::creds::Verdict, String> {
    crate::off_main(move || {
        let Some(secret) = crate::vault::read_at(&target(&name)) else {
            return crate::creds::Verdict { ok: false, who: String::new(), said: "nothing stored".into() };
        };
        let group = app
            .try_state::<Store>()
            .and_then(|s| s.0.lock().ok().and_then(|c| one(&c, &name)))
            .map(|c| c.consumer_group)
            .unwrap_or_else(|| "$Default".into());
        let probe = || -> Result<String, String> {
            let cs = crate::eventhub::ConnString::parse(&secret)?;
            let mut hub = crate::eventhub::EventHub::connect(&cs, &group)?;
            let parts = Source::partitions(&mut hub)?;
            /* Attaching one partition is what proves the consumer group: the
               read above would answer for any group, existing or not. */
            if let Some(p) = parts.first() {
                Source::open(&mut hub, p, Start::Since(crate::store::now()))?;
            }
            Source::close(&mut hub);
            Ok(format!("{} partition{} on {}, group {group}", parts.len(), if parts.len() == 1 { "" } else { "s" }, cs.entity))
        };
        match probe() {
            Ok(who) => crate::creds::Verdict { ok: true, who, said: String::new() },
            Err(said) => crate::creds::Verdict { ok: false, who: String::new(), said },
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscribe::ledger::tests::{db, sub};
    use serde_json::json;
    use std::collections::VecDeque;

    /// A hub with a log per partition, read from a position, that can be made
    /// to drop the connection after a number of reads.
    struct Fake {
        log: HashMap<String, Vec<(i64, i64, Value)>>,
        open: HashMap<String, VecDeque<(i64, i64, Value)>>,
        drop_after: Option<usize>,
        read: usize,
        opened_at: Vec<(String, Start)>,
    }

    impl Fake {
        fn new(log: HashMap<String, Vec<(i64, i64, Value)>>, drop_after: Option<usize>) -> Self {
            Fake { log, open: HashMap::new(), drop_after, read: 0, opened_at: Vec::new() }
        }
    }

    impl Source for Fake {
        fn partitions(&mut self) -> Result<Vec<String>, String> {
            let mut p: Vec<String> = self.log.keys().cloned().collect();
            p.sort();
            Ok(p)
        }
        fn open(&mut self, partition: &str, from: Start) -> Result<(), String> {
            self.opened_at.push((partition.to_string(), from));
            let q = self.log[partition]
                .iter()
                .filter(|(seq, at, _)| match from {
                    Start::After(s) => *seq > s,
                    Start::Since(t) => *at > t,
                })
                .cloned()
                .collect();
            self.open.insert(partition.to_string(), q);
            Ok(())
        }
        fn next(&mut self, _deadline: Instant) -> Result<Option<Raw>, String> {
            if self.drop_after == Some(self.read) {
                return Err("connection reset".into());
            }
            let mut keys: Vec<String> = self.open.keys().cloned().collect();
            keys.sort();
            for p in keys {
                if let Some((seq, at, body)) = self.open.get_mut(&p).unwrap().pop_front() {
                    self.read += 1;
                    return Ok(Some(Raw {
                        partition: p,
                        sequence: seq,
                        enqueued_at: at,
                        properties: Map::from_iter([("channel".to_string(), json!("ui"))]),
                        body: body.to_string().into_bytes(),
                    }));
                }
            }
            Err("drained".into())
        }
        fn close(&mut self) {}
    }

    fn log() -> HashMap<String, Vec<(i64, i64, Value)>> {
        let mut m = HashMap::new();
        m.insert("0".into(), (1..=4).map(|s| (s, 10_000 + s, json!({"p": 0, "s": s}))).collect());
        m.insert("1".into(), (1..=3).map(|s| (s, 10_000 + s, json!({"p": 1, "s": s}))).collect());
        m
    }

    /// The whole loop the runner drives: a session that drops part-way, a
    /// second that starts from the checkpoints, and every event delivered
    /// exactly once between them.
    #[test]
    fn a_dropped_session_resumes_from_the_checkpoint_and_loses_nothing() {
        let db = Mutex::new(db());
        ledger::add(&db.lock().unwrap(), &sub("s", "card", json!({"channel": "ui"}), 9_000, 0)).unwrap();
        let stop = AtomicBool::new(false);
        let told = Mutex::new(Vec::new());
        let tell = |c: String| told.lock().unwrap().push(c);

        let mut first = Fake::new(log(), Some(3));
        let err = pump(&mut first, &db, "nova-feedback", &stop, &|| {}, &tell).unwrap_err();
        assert_eq!(err, "connection reset");
        assert!(first.opened_at.iter().all(|(_, s)| *s == Start::Since(9_000 - ledger::SKEW_MS)), "fresh start at the subscriber");

        let mut second = Fake::new(log(), None);
        let err = pump(&mut second, &db, "nova-feedback", &stop, &|| {}, &tell).unwrap_err();
        assert_eq!(err, "drained");
        assert!(second.opened_at.iter().any(|(_, s)| matches!(s, Start::After(_))), "{:?}", second.opened_at);

        let claim = ledger::claim(&db.lock().unwrap(), "card", 50_000, 100).unwrap();
        let mut lines: Vec<String> = claim.sections.iter().flat_map(|s| s.lines.clone()).collect();
        lines.sort();
        lines.dedup();
        assert_eq!(claim.sections[0].lines.len(), 7, "every event once: {lines:?}");
        assert_eq!(lines.len(), 7);
    }

    #[test]
    fn a_source_with_no_subscribers_is_not_read() {
        let db = Mutex::new(db());
        let mut f = Fake::new(log(), None);
        assert!(pump(&mut f, &db, "nova-feedback", &AtomicBool::new(false), &|| {}, &|_| {}).is_ok());
        assert!(f.opened_at.is_empty());
    }

    #[test]
    fn an_event_reads_as_properties_overlaid_by_its_body() {
        let raw = Raw {
            partition: "0".into(),
            sequence: 1,
            enqueued_at: 1,
            properties: Map::from_iter([
                ("channel".to_string(), json!("mcp")),
                ("source".to_string(), json!("nova-feedback")),
            ]),
            body: br#"{"channel":"ui","eventId":7}"#.to_vec(),
        };
        let a = arrival(&raw);
        assert_eq!(a.fields["channel"], json!("ui"), "the body wins");
        assert_eq!(a.fields["source"], json!("nova-feedback"));
        assert_eq!(a.line, r#"{"channel":"ui","eventId":7,"source":"nova-feedback"}"#);
        let text = arrival(&Raw { body: b"not json".to_vec(), ..raw.clone() });
        assert_eq!(text.fields["body"], json!("not json"));
    }

    /// The write `set_source` makes, under one guard: a new source lands, a
    /// group change keeps the checkpoints, and a move to another hub clears
    /// them. `set_source` takes the lock once around this and nothing else.
    #[test]
    fn a_source_is_saved_under_one_lock() {
        let c = db();
        save(&c, "nova-feedback", "$Default", "ns", "hub", false).unwrap();
        c.execute(
            "INSERT INTO source_checkpoint (source, partition, sequence, enqueued_at, at) VALUES ('nova-feedback', '0', 9, 1, 1)",
            [],
        )
        .unwrap();
        save(&c, "nova-feedback", "cg_x", "ns", "hub", false).unwrap();
        assert_eq!(one(&c, "nova-feedback").unwrap().consumer_group, "cg_x");
        assert_eq!(ledger::checkpoint(&c, "nova-feedback", "0"), Some((9, 1)), "same hub keeps its place");
        save(&c, "nova-feedback", "cg_x", "ns2", "hub2", true).unwrap();
        assert_eq!(one(&c, "nova-feedback").unwrap().entity, "hub2");
        assert_eq!(ledger::checkpoint(&c, "nova-feedback", "0"), None, "another hub starts over");

    }

    #[test]
    fn a_source_name_is_a_word_not_a_path() {
        for ok in ["nova-feedback", "ci.builds", "a", "eos_2"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "Nova", "-x", "a/b", "../x", "a b", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert_eq!(target("nova-feedback"), "dev.skein.studio/source/nova-feedback");
    }
}
