//! The studio, on disk.
//!
//! Everything the wall needs to paint itself before a single process has
//! started: which projects exist, which conversations were open, where their
//! cards sat, and which dev servers should come back up.
//!
//! Two schema decisions are deliberate and worth not undoing:
//!
//! 1. `conversation.id` is a Skein UUID and `agent_session_id` is the agent's
//!    handle. Today they hold the same value, because we mint the id and hand
//!    it to `--session-id`. Keeping them as separate columns costs nothing now
//!    and is the only thing here that would be painful to change once there is
//!    real data behind it.
//!
//! 2. `file_touch` is written from the first build, and the collision detection
//!    it was always for is finally built on it. Three readers now: the broadcast
//!    bar warns that two selected cards share a working tree, `relay::touched`
//!    answers "who else has been in this file", and `foreign_staged` stops a
//!    card committing a sibling's work out of the index they share. The last of
//!    those is the one the table was written for — see sink 8d3dab75, and
//!    `hooks.rs` for the guard that reads it.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// `.0` is the connection, `.1` the app data directory (imported reference
/// images are copied in beside the database).
pub struct Store(pub Mutex<Connection>, pub PathBuf);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// Where the territory has been dragged to, if it ever has. `None` means the
    /// wall's territory grid decides — the same contract `placement` has for a
    /// card that was never pinned.
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// Where the territory is *drawn* if it has been stuck to the glass — the
    /// pane in front of the wall — in screen pixels. Independent of `x`/`y`,
    /// which stay whatever the wall says: a stuck territory keeps its cell, so
    /// putting it back moves nothing. See `migrate_v9`.
    ///
    /// Renamed for the wire because the four things that can be stuck speak one
    /// vocabulary in the front end (`glassX`), and a feature spelled two ways
    /// depending on which table it landed in is a feature read twice.
    #[serde(rename = "glassX")]
    pub glass_x: Option<f64>,
    #[serde(rename = "glassY")]
    pub glass_y: Option<f64>,
    /// What every card standing in this territory is told, on top of what the
    /// wall tells all of them. Empty is the ordinary case and means "nothing
    /// beyond the wall's". See `crate::guidance`.
    ///
    /// Carried in the snapshot rather than behind a command of its own, because
    /// the panel lists every territory with a mark against the ones that carry
    /// something — a standing instruction whose existence is invisible is the
    /// kind that gets forgotten and then blamed on the agent — and a round trip
    /// per territory to draw that list would be a list that fills in.
    #[serde(default)]
    pub instructions: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerSpec {
    pub label: String,
    pub command: String,
    pub cwd: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerGroup {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub autostart: bool,
    pub start_order: i64,
    pub servers: Vec<ServerSpec>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredConversation {
    pub id: String,
    pub agent_session_id: Option<String>,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    /// The title was given by you rather than cut from a prompt or read out of
    /// the transcript, and so is not to be replaced — see `migrate_v13`.
    pub named_by_hand: bool,
    pub worktree: Option<String>,
    pub model: Option<String>,
    /// How hard this session has been told to think, or `None` where nothing
    /// has told us. The column has been here since v1 and was read by nobody
    /// until the transcript footer wanted to say so — the wire carries no
    /// effort at all, so this is the only place a dormant card's answer can
    /// come from. See `supervisor::read_session_effort`.
    pub effort: Option<String>,
    pub interrupted: bool,
    pub last_ctx_frac: f64,
    pub last_ending: Option<String>,
    /// Put by on purpose: on the wall, out of what is waiting, and not roused.
    pub aside: bool,
    /// `project` or `chat` — see `migrate_v11`. A string rather than a bool
    /// because this is a taxonomy with room in it, and `chat: false` would be a
    /// column that could only ever answer one more question.
    pub kind: String,
    /// Which account this card is spending, or `None` for whoever Claude Code
    /// is signed in as. Restored so `choose`'s stickiness survives a restart —
    /// without it every card comes back unattached and the first send moves the
    /// whole wall onto the first account at once, re-reading every conversation
    /// uncached. See `.claude/rules/accounts.md`.
    pub account_label: Option<String>,
    /// This card ignores the caps you set. Persisted because it is a decision
    /// about a conversation, and one that quietly reverted on restart is one you
    /// would have to remember to make again.
    pub bypass_caps: bool,
    /// Which gear the card is in, or `None` for one nobody has ever set — see
    /// `gear_of`. Carried on the restore because a **dormant** card has no
    /// process to announce itself: the gear otherwise arrives folded off a
    /// `system/init`, which a card without a child never emits, so the whole
    /// wall would come back drawn as making until each card was woken.
    #[serde(rename = "permissionMode")]
    pub permission_mode: Option<String>,
    /// Canvas position. `None` means "let the layout place it".
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub pinned: bool,
    /// Where the card is drawn if it has been stuck to the glass. Beside the
    /// canvas position rather than instead of it — see `migrate_v9`.
    #[serde(rename = "glassX")]
    pub glass_x: Option<f64>,
    #[serde(rename = "glassY")]
    pub glass_y: Option<f64>,
}

/// Everything needed to paint the wall, in one round trip.
#[derive(Debug, Serialize, Clone)]
pub struct Studio {
    pub projects: Vec<Project>,
    pub conversations: Vec<StoredConversation>,
    pub server_groups: Vec<ServerGroup>,
    /// What the wall tells every card standing on it, project and chat alike.
    /// Empty is the ordinary case. In the snapshot rather than behind a command
    /// of its own for the same reason a project's is on its row: the front end
    /// wants to draw whether there is one, and a second round trip to find out
    /// is a round trip the first paint would have to wait for.
    pub guidance: String,
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
        let conn = Connection::open(dir.join("skein.db")).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        migrate(&conn)?;
        Ok(Store(Mutex::new(conn), dir))
    }
}

/// Schema version. Bump it and add a row to `STEPS` for every change.
///
/// `CREATE TABLE IF NOT EXISTS` is not a migration: it silently does nothing
/// when the table already exists, so a renamed or added column never lands and
/// the next query fails against a schema that looks superficially fine. This
/// caught us once already. Every future change gets a numbered step.
const SCHEMA_VERSION: i64 = 25;

/// The ladder, one rung per version. Ordered, and the number is the version the
/// database is at *once that step has run* — see `migrate`, which stamps it in
/// the same transaction as the step itself.
const STEPS: &[(i64, fn(&Connection) -> Result<(), String>)] = &[
    (1, migrate_v1),
    (2, migrate_v2),
    (3, migrate_v3),
    (4, migrate_v4),
    (5, migrate_v5),
    (6, migrate_v6),
    (7, migrate_v7),
    (8, migrate_v8),
    (9, migrate_v9),
    (10, migrate_v10),
    (11, migrate_v11),
    (12, migrate_v12),
    (13, migrate_v13),
    (14, migrate_v14),
    (15, migrate_v15),
    (16, migrate_v16),
    (17, migrate_v17),
    (18, migrate_v18),
    (19, migrate_v19),
    (20, migrate_v20),
    (21, migrate_v21),
    (22, migrate_v22),
    (23, migrate_v23),
    (24, migrate_v24),
    (25, migrate_v25),
    // Future changes go here as another `(N, migrate_vN)`, each one an ALTER
    // rather than a CREATE, so existing databases actually move forward.
];

/// Walk the database up to `SCHEMA_VERSION`, one rung at a time, each rung and
/// its stamp in one transaction.
///
/// **The stamp is part of the step, and that is the whole of this function.**
/// It used to run every pending step and then stamp `SCHEMA_VERSION` once at
/// the end, which is a single write standing for a dozen that already landed:
/// SQLite is in autocommit here, so each `ALTER` committed as it ran, and a
/// step that failed — or a process that died — left the columns applied with
/// the version still naming a schema from before them. The next launch then
/// re-ran the steps it had already taken, `ALTER TABLE conversation ADD COLUMN
/// kind` answered *duplicate column name: kind*, and `Store::open` failed. Not
/// once, but on every launch from then on: the failure was in the recovery
/// path, so the app could not start again until the file was edited by hand.
/// This happened, on a real wall, with twenty cards and 342 turns in it — the
/// database was stamped 9 while carrying v11's column and v12's table.
///
/// So a rung either lands with its number or does not land at all, and what a
/// crash leaves behind is a version that tells the truth. The general shape is
/// the one `set_mid_turn` learned the other way round: **the record that says
/// how far something got must be written by the same commit as the getting
/// there** — a bookkeeping write left until the end is a write the failing case
/// skips.
///
/// The steps are idempotent as well (`add_column` checks before it alters),
/// which is belt and braces for the transaction — and not only that, since it
/// is what lets an already-wedged database walk itself out rather than needing
/// the surgery this one needed.
fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("read schema version: {e}"))?;

    /* A database from a newer build. Every step here only knows how to move
       forward, so there is nothing to run and — crucially — nothing to stamp:
       writing SCHEMA_VERSION over a higher number would claim this build's
       schema for a file carrying a later one, and the next launch of the newer
       build would then re-run migrations across data that already has them.
       Refusing says which way round the problem is, in the one place that can
       still tell. */
    if version > SCHEMA_VERSION {
        return Err(format!(
            "this database is from a newer Skein (schema v{version}, this build knows v{SCHEMA_VERSION}) — update the app rather than downgrading the file"
        ));
    }

    for (n, step) in STEPS {
        if version >= *n {
            continue;
        }
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("begin migration v{n}: {e}"))?;
        step(conn)?;
        /* Transactional, like any other write to the database header — so a
           rolled-back step takes its version with it. */
        conn.pragma_update(None, "user_version", n)
            .map_err(|e| format!("stamp schema version {n}: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit migration v{n}: {e}"))?;
    }

    Ok(())
}

/// `ALTER TABLE ... ADD COLUMN`, unless it is already there.
///
/// SQLite has no `ADD COLUMN IF NOT EXISTS`, and a duplicate is a hard error
/// rather than a no-op — so this asks `table_info` first. Every added column in
/// the ladder goes through here, which makes a step safe to re-run: that is
/// what lets a database whose version fell behind its schema — the wedge
/// `migrate` describes — come back on its own instead of failing at the same
/// rung on every launch forever.
///
/// It checks rather than swallowing the error, because "duplicate column name"
/// is the only failure that means *already done* and matching on the text of a
/// message is how the next thing SQLite words differently gets treated as
/// success.
fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), String> {
    if has_column(conn, table, column)? {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))
        .map_err(|e| format!("add {table}.{column}: {e}"))
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| format!("read {table} columns: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("read {table} columns: {e}"))?;
    while let Some(row) = rows.next().map_err(|e| format!("read {table} columns: {e}"))? {
        let name: String = row.get(1).map_err(|e| format!("read {table} columns: {e}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS project (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            root_path   TEXT NOT NULL UNIQUE,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_group (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            label        TEXT NOT NULL,
            autostart    INTEGER NOT NULL DEFAULT 1,
            start_order  INTEGER NOT NULL DEFAULT 0,
            spec_json    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation (
            id                TEXT PRIMARY KEY,
            agent_session_id  TEXT,
            project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            cwd               TEXT NOT NULL,
            title             TEXT NOT NULL DEFAULT 'untitled',
            worktree          TEXT,
            branch            TEXT,
            model             TEXT,
            effort            TEXT,
            born_at           INTEGER NOT NULL,
            closed_at         INTEGER,
            interrupted       INTEGER NOT NULL DEFAULT 0,
            last_ctx_frac     REAL NOT NULL DEFAULT 0,
            last_ending         TEXT
        );

        CREATE TABLE IF NOT EXISTS placement (
            conversation_id  TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
            x                REAL NOT NULL,
            y                REAL NOT NULL,
            pinned           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS turn (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            ended_at         INTEGER NOT NULL,
            status_tier      TEXT NOT NULL,
            in_tokens        INTEGER NOT NULL DEFAULT 0,
            out_tokens       INTEGER NOT NULL DEFAULT 0,
            cache_tokens     INTEGER NOT NULL DEFAULT 0,
            usd              REAL NOT NULL DEFAULT 0,
            broadcast_id     TEXT
        );

        CREATE TABLE IF NOT EXISTS file_touch (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            path             TEXT NOT NULL,
            op               TEXT NOT NULL,
            at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS file_touch_path ON file_touch(path);
        CREATE INDEX IF NOT EXISTS conversation_open ON conversation(closed_at);

        -- Reference images pinned to the wall. Deliberately NOT tied to a
        -- project: a reference board is personal and spans everything you are
        -- working on. Always placed by hand, so unlike a card it carries its own
        -- size and rotation and never enters the auto-layout.
        CREATE TABLE IF NOT EXISTS reference_image (
            id          TEXT PRIMARY KEY,
            path        TEXT NOT NULL,
            x           REAL NOT NULL,
            y           REAL NOT NULL,
            w           REAL NOT NULL,
            h           REAL NOT NULL,
            rotation    REAL NOT NULL DEFAULT 0,
            z           INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v1: {e}"))
}

/// Repair `last_ending` for conversations that spoke before it was ever written.
///
/// The front end sent `lastTier` where the command takes `last_ending`. Tauri
/// drops an unknown key, so the parameter arrived as `None`, the COALESCE kept
/// the old value, and the column stayed NULL for every turn ever taken. The
/// front end derives `everSpoke` from it, so those cards woke with
/// `--session-id` instead of `--resume` — a card with real history restarting
/// from nothing.
///
/// No schema change: the column always existed, it was just never filled. What
/// we can recover is *whether* a turn happened, from the `turn` rows that were
/// written correctly all along. How it ended is genuinely lost, so it gets
/// `'ok'` — which is exactly what `Conversation.restore` already substitutes for
/// a NULL, so this changes no card's appearance, only whether it resumes.
fn migrate_v2(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE conversation SET last_ending = 'ok'
          WHERE last_ending IS NULL
            AND EXISTS (SELECT 1 FROM turn WHERE turn.conversation_id = conversation.id)",
        [],
    )
    .map(|_| ())
    .map_err(|e| format!("migrate v2: {e}"))
}

/// Where a territory has been put. Territories used to run along a single line
/// off the origin, so there was nothing to remember; now that one can be dragged
/// — carrying its cards with it — the wall has to come back the way it was left.
///
/// Nullable, and null is meaningful: it means the grid still places this project,
/// which is what every existing row starts as and what "tidy it back" returns it
/// to. An ALTER rather than a CREATE, per the note on `SCHEMA_VERSION`.
fn migrate_v3(conn: &Connection) -> Result<(), String> {
    add_column(conn, "project", "x", "REAL")?;
    add_column(conn, "project", "y", "REAL")
}

/// What the wall does when nobody is asking it anything: stacks of background
/// effects, saved as profiles you can switch between.
///
/// The layers are one JSON column rather than a table of layers and a table of
/// parameters. Every effect has its own knobs, and they change as the effects do
/// — a normalised schema here would mean a migration every time a slider is
/// added, to describe data that is only ever read and written whole. The front
/// end normalises whatever comes back (`ambience.ts::normalizeProfile`), which
/// is the same contract `server_group.spec_json` has.
///
/// `active` is at most one row. Which profile is showing is studio state and
/// belongs next to the profiles rather than in localStorage — unlike the
/// viewport, it is a thing you *made*, not where you happen to be looking.
fn migrate_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ambience_profile (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            layers_json TEXT NOT NULL,
            active      INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v4: {e}"))
}

/// Instruments hung on the wall: a clock, a reading of what the studio's own
/// processes are costing. Like a reference image and unlike a card, a widget is
/// always placed by hand and belongs to no project — it is furniture in the
/// room rather than part of the work.
///
/// `config_json` is one opaque column for the same reason `ambience_profile`'s
/// layer stack is: every kind of widget has its own knobs, a clock's variant
/// means nothing to a performance meter, and they change as the widgets do. A
/// normalised schema would be a migration per parameter, to describe data that
/// is only ever read and written whole. Rust never parses it; the front end's
/// `normalizeWidget` does, on every read.
fn migrate_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS widget (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            x           REAL NOT NULL,
            y           REAL NOT NULL,
            w           REAL NOT NULL,
            h           REAL NOT NULL,
            z           INTEGER NOT NULL DEFAULT 0,
            config_json TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v5: {e}"))
}

/// A card put by on purpose — kept on the wall, kept out of what is waiting.
///
/// It has to be a column rather than front-end state for two reasons that both
/// happen at launch: the waiting cycle is the same cycle on the next run, and
/// rousing spawns a process for every dormant card it finds, so a flag that did
/// not survive a restart would give back exactly the sessions you had put down.
///
/// An ALTER with a default, per the note on `SCHEMA_VERSION` — every existing
/// row is a card nobody has set aside, which is what 0 means.
fn migrate_v6(conn: &Connection) -> Result<(), String> {
    add_column(conn, "conversation", "aside", "INTEGER NOT NULL DEFAULT 0")
}

/// Cache reads and cache writes are one column in v1 and must not be, because
/// they are not one price. A cache read is 0.1x input and a cache write is
/// 1.25x — a factor of 12.5 between two numbers that were being added
/// together, so the summed column cannot answer the only question a ledger is
/// for. Measured over the 15 sessions this wall had taken by 2026-08-14:
/// 231.4M cache-read tokens against 6.23M written, which is $115.69 against
/// $38.91 at Opus 5 rates. Summed, that is one meaningless number.
///
/// `cache_tokens` stays and keeps its name, but its *meaning* is repaired:
/// `record_turn` was passing `ctxTokens` — the context ring's occupancy, which
/// is a reading of the last request, not a count of anything this turn spent.
/// Occupancy already has a home in `conversation.last_ctx_frac`.
///
/// Nothing backfills, because there is nothing recoverable to backfill from:
/// every existing row carries zeros for in/out and an occupancy figure under
/// `cache_tokens`. The rows are left as they are rather than deleted — they
/// still date a turn and record how it ended, which is what the EXISTS check
/// in v2 reads them for.
fn migrate_v7(conn: &Connection) -> Result<(), String> {
    let count = "INTEGER NOT NULL DEFAULT 0";
    add_column(conn, "turn", "cache_read_tokens", count)?;
    add_column(conn, "turn", "cache_write_tokens", count)
}

/// The pomodoro cycle — one per studio, so at most one row.
///
/// It is not a widget's config, and that is the whole point of the table. A
/// pomodoro widget is a *view*: two of them on the wall are two readings of one
/// afternoon, and if each held its own phase they would be two clocks telling
/// different times. The cycle outlives any one of them too, so swapping which
/// view is up carries on rather than starting again — which a per-widget config
/// could not do, since the state would leave with the widget.
///
/// It does not run without any view at all: a cycle with no pomodoro widget on
/// the wall pauses (`Cycle.watched`), the way the process sampler stops when the
/// last meter comes down. The row is what makes that a *pause* rather than a
/// loss — the phase is still here when a widget goes back up.
///
/// `state_json` is opaque here for the same reason `widget.config_json` and
/// `ambience_profile.layers_json` are: the phase machine, the cadences and what
/// a snooze means all live in `src/lib/timing.ts`, which is pure and tested, and
/// none of it is worth a migration per field. Rust never parses it; the front
/// end's `normalizeCycle` does, on every read.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION` — this is a
/// new table, so there is nothing to backfill and no existing row to give a
/// default to. A studio that has never run a pomodoro simply has no row, which
/// `read_pomodoro` reports as `None`.
fn migrate_v8(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS pomodoro (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            state_json  TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v8: {e}"))
}

/// The glass: where a thing is drawn when it has been stuck to the window
/// rather than left on the wall.
///
/// Four tables get the same pair because four kinds of thing can be stuck —
/// a card, a territory, a reference image and a widget — and the glass means
/// exactly the same thing to each. Columns on the thing's own row rather than
/// one `glass(kind, id, x, y)` table, for two reasons: the position travels
/// with what it is a position *of*, so it is written by the same upsert and
/// read by the same query as everything else about it; and closing a card or
/// forgetting a project takes it with them by the cascade that is already
/// there, where a side table keyed on a mixed id would quietly accumulate rows
/// pointing at things nobody can see any more.
///
/// Nullable, and null is meaningful — "on the wall", which is what every
/// existing row starts as and what putting one back returns it to. That is the
/// same shape `project.x`/`y` took in v3.
///
/// Emphatically **not** a replacement for the wall positions beside them. A
/// card stuck to the glass keeps its placement, a territory keeps its cell, and
/// the wall is laid out as though nothing were stuck at all — so taking a thing
/// off the pane puts it back where it was and nothing else moves. Storing one
/// pair of coordinates whose meaning depended on a flag would have made that
/// round trip lossy, which on a wall whose whole argument is that position is
/// memory is the one thing it must not be. See `src/lib/glass.ts`.
///
/// These are screen pixels, which is unlike everything else in this file, and
/// they are still studio data rather than viewport state: where you put a thing
/// is something you *made*, unlike where you happen to be looking. What depends
/// on the window is handled where it is drawn (`glassAt`), so a narrow window
/// borrows a widget back from the edge and a wide one gives it straight back.
fn migrate_v9(conn: &Connection) -> Result<(), String> {
    for table in ["placement", "project", "reference_image", "widget"] {
        add_column(conn, table, "glass_x", "REAL")?;
        add_column(conn, table, "glass_y", "REAL")?;
    }
    Ok(())
}

/// Throw away every stored `interrupted`, because none of them means what the
/// column says.
///
/// `Supervisor::shutdown` returned every id it killed, and rousing gives every
/// dormant card a process at launch — so from the day rousing shipped, a clean
/// quit flagged the entire wall, cards that had been resting for days included.
/// The next launch then sent each of them a `resumePrompt`.
///
/// No schema change: the column is right, the values in it are not, and unlike
/// v2 there is nothing to recover them from — a `turn` row says a turn ended,
/// never that one was cut off. So it clears rather than repairs, and the cost is
/// bounded and one-way: at worst a card that genuinely was mid-turn at the last
/// quit is not offered its resume, which is a prompt you can send yourself. The
/// alternative is running the bug once more over every card on the wall.
fn migrate_v10(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE conversation SET interrupted = 0", [])
        .map(|_| ())
        .map_err(|e| format!("migrate v10: {e}"))
}

/// What a card *is*, which until now every card was the same answer to.
///
/// `project` is a card standing in a working tree with the machine at its
/// disposal; `chat` is a card with no project and no tools but the two web
/// ones. It is a column rather than something inferred from `cwd`, even though
/// every chat card shares one directory: the cwd is where a chat card was put
/// so that it would have somewhere harmless to be, and reading a *capability*
/// off a path means the day that path changes, every card built on it silently
/// gets the machine back. The column says what was meant.
///
/// Defaulted rather than backfilled, because the default is the truth: every
/// row written before this one was a project card and still is.
fn migrate_v11(conn: &Connection) -> Result<(), String> {
    add_column(
        conn,
        "conversation",
        "kind",
        "TEXT NOT NULL DEFAULT 'project'",
    )
}

/// Where the studio window was when it was last closed.
///
/// A singleton row, the shape `pomodoro` uses, and for the same reason: there
/// is one studio window and a row per launch would be a log nobody reads.
///
/// Typed columns rather than the opaque JSON that table holds, which is the
/// exception to the bargain the other opaque columns strike. That bargain works
/// because a normalizer runs in the front end on every read; this one is read by
/// Rust in `setup`, *before* there is a front end to normalize anything, so the
/// degradation has to be the reader's own — see `read_window_frame`, which
/// answers `None` to anything it does not like and lets `window::settle` centre
/// on the monitor instead.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: a new table
/// with nothing to backfill. A studio that has never been closed has no row,
/// which is the first-launch case and is already handled.
fn migrate_v12(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS window_frame (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            x           INTEGER NOT NULL,
            y           INTEGER NOT NULL,
            w           INTEGER NOT NULL,
            h           INTEGER NOT NULL,
            maximized   INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v12: {e}"))
}

/// You said what this card is called, so nothing else gets to say otherwise.
///
/// A title has always been something that happened *to* a card — the sentinel,
/// then the cut of the first prompt, then Claude Code's generated title, which
/// the front end adopts at every settling turn. `/rename` is the first name that
/// comes from you, and without a column saying so it would survive exactly one
/// turn: the next `result` reads the transcript's title, finds it different, and
/// puts it back. A rename that comes undone a few minutes later, while you are
/// looking somewhere else, is worse than no rename at all.
///
/// Defaulted rather than backfilled, because the default is the truth: nothing
/// written before this could have been named by hand, there being no way to do
/// it. Cleared by `clear_row` along with the title it protects.
fn migrate_v13(conn: &Connection) -> Result<(), String> {
    add_column(
        conn,
        "conversation",
        "named_by_hand",
        "INTEGER NOT NULL DEFAULT 0",
    )
}

/// What one card said to another.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: a new table
/// with nothing to backfill, since until now no card could address another one.
///
/// The row is written for every relay and not only for the queued ones, which
/// is worth being deliberate about — a delivered message has already gone into
/// the recipient's stdin and is in its transcript, so the row is not *needed*
/// to deliver it. What the row buys is the two things a transcript cannot
/// answer: which card sent it (the recipient's transcript has the envelope, but
/// the sender's has only a tool call it may have made three of), and whether it
/// has landed yet. `delivered_at IS NULL` is the whole of an inbox: a card that
/// was dormant when it was written to, holding what it has not been told.
///
/// `chain` and `hops` are the loop guard's memory. They are stored rather than
/// held only in `Relays` because a chain that survives a quit should survive it
/// *counted* — a queued message delivered at tomorrow's launch is the sixth hop
/// of something, and a restart that reset it to zero would be a way to buy six
/// more hops by crashing.
fn migrate_v14(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS relay (
            id            TEXT PRIMARY KEY,
            from_id       TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            to_id         TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            body          TEXT NOT NULL,
            chain         TEXT NOT NULL,
            hops          INTEGER NOT NULL DEFAULT 0,
            sent_at       INTEGER NOT NULL,
            delivered_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS relay_inbox ON relay(to_id, delivered_at);
        "#,
    )
    .map_err(|e| format!("migrate v14: {e}"))
}

/// The billboard, and who has already been shown what is on it.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: two new
/// tables with nothing to backfill.
///
/// **No foreign key on `from_id`, deliberately, and it is the one place in this
/// schema that goes without one.** Two reasons and the second is the load-bearing
/// one. A notice may be posted by *you* rather than by a card, and that is a null
/// author rather than a missing row. And a `REFERENCES … ON DELETE CASCADE` would
/// never fire anyway: closing a card sets `closed_at` and deletes nothing, so the
/// cascade that looks like it is clearing the board is doing nothing at all —
/// which is a worse position than having no constraint, because it reads as
/// solved. `board::sweep` is the real answer and is called at both ends: when a
/// card closes, and again on every read as the backstop for a crash in between.
/// Same shape as `set_mid_turn`'s lesson, one table over.
///
/// `paths` is the globs this notice applies to, newline-separated, empty meaning
/// the whole board. Stored as text rather than a table for the reason
/// `widget.config_json` is: it is a short list read whole, by one module, and a
/// join would buy nothing. Unlike those, it is *not* opaque — `board.rs` parses
/// it, because deciding whether a path matches is exactly the decision that has
/// to be made where the write to stdin is.
///
/// `notice_served` is what makes "the first time" mean something. A composite
/// primary key rather than a unique index, so `INSERT OR IGNORE` is the whole of
/// the serving decision and there is no read-then-write to race.
fn migrate_v15(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notice (
            id          TEXT PRIMARY KEY,
            scope       TEXT NOT NULL,
            project_id  TEXT,
            from_id     TEXT,
            subject     TEXT NOT NULL,
            body        TEXT NOT NULL,
            paths       TEXT NOT NULL DEFAULT '',
            posted_at   INTEGER NOT NULL,
            touched_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notice_board ON notice(scope, project_id);

        CREATE TABLE IF NOT EXISTS notice_served (
            notice_id        TEXT NOT NULL,
            conversation_id  TEXT NOT NULL,
            at               INTEGER NOT NULL,
            PRIMARY KEY (notice_id, conversation_id)
        );
        "#,
    )
    .map_err(|e| format!("migrate v15: {e}"))
}

/// Accounts: the registry, the order, and the two per-card flags the waterfall
/// needs. `.claude/rules/accounts.md` is the reasoning.
///
/// **No credential is stored here and none ever will be.** An account *is* a
/// Claude Code credential store — `~/.claude/accounts/<label>/`, written and
/// kept current by the CLI itself — and `accounts.rs` does no more than name
/// that directory to a child process. What this table holds is the label, where
/// the account sits in the order, and the ceilings you set: all of which are
/// yours rather than Anthropic's, and none of which is a secret. The property
/// that buys: deleting this database costs you no credentials.
///
/// `caps` is JSON — a window `kind` to a percentage — rather than a table of
/// its own. The rate limiter's window vocabulary moves (`limits.rs` documents
/// seven codenamed windows that appeared and were null), so a schema that
/// pinned one column per window would need a migration every time Anthropic
/// named a new one. A JSON object absorbs that without a schema change, and
/// `accounts.ts` already treats an unknown kind as ordinary.
fn migrate_v16(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS account (
            label      TEXT PRIMARY KEY,
            rank       INTEGER NOT NULL DEFAULT 0,
            enabled    INTEGER NOT NULL DEFAULT 1,
            caps       TEXT NOT NULL DEFAULT '{}',
            added_at   INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS account_order ON account(rank);
        "#,
    )
    .map_err(|e| format!("migrate v16: {e}"))?;

    /* Which account a card is running on, so a restored wall knows what its
       cards were spending before it was closed — and so `choose`'s stickiness
       has something to stick to across a restart. Null means "whatever the CLI
       is signed in as", which is every card that existed before this rung and
       is also the honest answer for a wall with no accounts registered. */
    add_column(conn, "conversation", "account_label", "TEXT")?;
    /* The per-card bypass. Persisted rather than kept in memory because it is a
       decision about a conversation, and a decision that quietly reverted when
       the app restarted would be one you had to remember to make again. */
    add_column(conn, "conversation", "bypass_caps", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

/// Background work a card had in flight, so a restart can say what was lost.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: a new table
/// with nothing to backfill, since until now a job existed only in the front
/// end's `$state` and died with the window.
///
/// **A row here means "outstanding", and settling deletes it.** That follows the
/// grain `Conversation.jobs` already set — settled jobs are removed rather than
/// kept with a state — and it is also what makes the table answer the only
/// question anybody asks of it. A job that reports in needs nothing from this
/// table: its `<task-notification>` quotes its own `<output-file>` and the agent
/// is woken to read it, 48 times out of 53. This exists for the other case, and
/// the other case is defined by the absence of that notification. So the set of
/// rows at launch *is* the set of jobs whose fate nobody knows, with no
/// `settled_at` to filter on and no way for the two to drift apart.
///
/// `output_path` is null for a `Monitor` and an `Agent`, whose receipts name no
/// file — only Bash's does. Theirs is derived when it is read, from the three
/// parts that make one: `%TEMP%\claude\<slug>\<session_id>\tasks\<task_id>.output`.
/// Which is why `session_id` is stored beside the conversation id rather than
/// looked up from it: a cleared card keeps its `id` and takes a *new* session,
/// so the id on the row would resolve to the wrong directory for every job the
/// card ran before the clear.
///
/// **The foreign key will not clean up after a closed card, and that is not an
/// oversight.** Closing a card sets `closed_at` and deletes no row, so an
/// `ON DELETE CASCADE` here would never fire — the same trap `migrate_v15`
/// documents for the billboard. `forget_jobs` is the real answer, called where
/// the card is closed and where it is cleared. The constraint is kept for the
/// case that does delete.
fn migrate_v17(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS job (
            tool_id          TEXT PRIMARY KEY,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            session_id       TEXT NOT NULL,
            task_id          TEXT,
            kind             TEXT NOT NULL,
            label            TEXT NOT NULL,
            output_path      TEXT,
            started_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_card ON job(conversation_id);
        "#,
    )
    .map_err(|e| format!("migrate v17: {e}"))
}

/// The sink: what an agent noticed and could not act on there and then.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: a new table
/// with nothing to backfill.
///
/// **This is the first table on the wall that deliberately outlives the card
/// that wrote to it, and every column below turns on that.** A notice is a
/// standing claim about work in progress, so it dies with its author and
/// `sweep_notices` is right to delete it. An item in the sink is a *finding* —
/// a bug seen in passing, a tool that should exist, a thing to take care of
/// later — and the card that found it going away says nothing at all about
/// whether it is still true. So `from_id` is provenance and nothing more: no
/// foreign key, no cascade, and no sweep. What a sweep releases here is the
/// **hold**, which is the only part of an item that is about a live card.
///
/// `held_by` / `held_at` are that hold, and they are two columns rather than a
/// join table because an item may be held by at most one card — that is the
/// whole point of it. `held_at` is not decoration: a hold no card is honouring
/// has to expire, or the first agent to claim an item and then wander off owns
/// it until the database is deleted. `sink::HOLD_STALE_MS` is where that number
/// lives, and unlike the billboard's staleness it is *load-bearing* rather than
/// advisory — a stale hold may be taken. The billboard only marks, because
/// deleting a true notice is worse than showing an old one; here the item is
/// blocked while the hold stands, so the cost of not expiring one is work
/// nobody can pick up.
///
/// `settled_at` rather than a DELETE, so `done` is reversible from the widget —
/// an agent that decides a thing is handled and is wrong about it has not
/// destroyed the only record that it was ever raised. Open is
/// `settled_at IS NULL`, which is what the index is for.
///
/// `voices` is how many separate cards have dropped this same thing. It exists
/// because the failure mode of a box agents may write to freely is fifteen
/// copies of one observation, and the obvious fix — merging on the title —
/// throws away exactly the signal worth keeping, which is that fifteen of them
/// hit it. See `put_sink_item`.
fn migrate_v18(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sink_item (
            id            TEXT PRIMARY KEY,
            project_id    TEXT,
            kind          TEXT NOT NULL,
            title         TEXT NOT NULL,
            body          TEXT NOT NULL,
            paths         TEXT NOT NULL DEFAULT '',
            from_id       TEXT,
            dropped_at    INTEGER NOT NULL,
            touched_at    INTEGER NOT NULL,
            voices        INTEGER NOT NULL DEFAULT 1,
            held_by       TEXT,
            held_at       INTEGER,
            settled_at    INTEGER,
            settled_note  TEXT
        );
        CREATE INDEX IF NOT EXISTS sink_open ON sink_item(project_id, settled_at);
        "#,
    )
    .map_err(|e| format!("migrate v18: {e}"))
}

/// Wakes: a card's note to itself, and the receipts that catch a loop.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`: two new
/// tables with nothing to backfill.
///
/// **A row in `wake` means "outstanding", and serving it deletes it** — the same
/// grain `job` takes one table up, and for the same reason: it makes the table
/// answer the only question anybody asks of it, with no `served_at` to filter on
/// and no way for the set of rows and the set of pending wakes to drift apart.
///
/// **`wake_served` is a separate table because it is a different fact.** A wake
/// that has been handed over is gone; what has to survive it is the *count*, per
/// card, per hour — which is the only guard that can see the failure this feature
/// invites (see `later.rs`: a card that re-arms on every wake is a loop the hop
/// counter cannot detect, because every wake is hop zero). Keeping the served
/// rows in `wake` with a flag would mean the rate limit and the due-list were the
/// same query with opposite filters, and the day somebody adds a third state one
/// of them is wrong.
///
/// The foreign key will not clean up after a closed card — `closed_at` deletes no
/// row, the trap `migrate_v15` documents — so `later::clear_for` is the real
/// answer, called where the card is closed and where it is cleared. Unlike the
/// sink, there is nothing here worth keeping: a note to yourself has no value
/// once there is no self to hand it to.
fn migrate_v19(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS wake (
            id               TEXT PRIMARY KEY,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            due_at           INTEGER NOT NULL,
            armed_at         INTEGER NOT NULL,
            note             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS wake_due ON wake(due_at);

        CREATE TABLE IF NOT EXISTS wake_served (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  TEXT NOT NULL,
            at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS wake_served_card ON wake_served(conversation_id, at);
        "#,
    )
    .map_err(|e| format!("migrate v19: {e}"))
}

/// Parentage, for the cards an agent opened rather than you.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION`.
///
/// **A table rather than a `spawned_by` column on `conversation`, and the reason
/// is an ordering problem rather than taste.** The row for a card is written by
/// the *front end* (`Skein.#openIn` records before it spawns, because
/// `spawn_conversation` asks the store what kind of card it is), so Rust cannot
/// stamp a column on a row that does not exist yet — and `spawn.rs` has to know
/// the answer *before* the card is opened, since that is when the guards are
/// checked. Recording the intent instead makes the question answerable at the
/// only moment it is asked, and leaves nothing to race.
///
/// It also means an intent can exist with no card behind it — a spawn asked for
/// and never drawn, because nothing was listening. That is deliberately counted
/// against the rate: an agent whose spawn silently failed and which is therefore
/// asking again is exactly the loop the rate is for.
///
/// No foreign key in either direction. `child_id` names a row that does not exist
/// yet, and `parent_id` names one that `closed_at` will not delete — the trap
/// `migrate_v15` documents. Nothing sweeps this: the whole value of it is
/// answering "was this card opened by an agent" months later, and a lineage that
/// evaporated when the parent closed would answer that wrongly and confidently.
fn migrate_v20(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS spawned (
            child_id   TEXT PRIMARY KEY,
            parent_id  TEXT NOT NULL,
            at         INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS spawned_parent ON spawned(parent_id, at);
        "#,
    )
    .map_err(|e| format!("migrate v20: {e}"))
}

/// Which card put an image on the wall, for the images an agent pinned.
///
/// `NULL` for everything already there and for everything you drop yourself,
/// which is the honest reading rather than a default: nobody pinned those, and
/// a column claiming a card did would make `repin` offer an agent an image it
/// has never seen.
///
/// It exists to answer one question, and the question is a permission: **may
/// this card change this image?** The wall is the user's, and an agent that
/// could overwrite the source of any rectangle on it — including a photo you
/// dropped this morning — is a much larger capability than the one being
/// asked for. Same argument `spawn.rs` makes about which cards a card may
/// close, and the same shape: the intent is recorded when the thing is made, so
/// the question is answerable at the moment it is asked.
///
/// Written by the *front end*, with the rest of the row — `pin.rs` mints the
/// id and names the card, `Board.pinned` carries both into the record it saves.
/// So this is one more field on an existing write rather than a second one, and
/// there is no window in which an image exists with nobody's name on it.
fn migrate_v21(conn: &Connection) -> Result<(), String> {
    add_column(conn, "reference_image", "pinned_by", "TEXT")
}

/// When you last reworded a sink item, or NULL for one still in the words it was
/// dropped in.
///
/// An ALTER, per the note on `SCHEMA_VERSION`, and nullable rather than
/// defaulted to `dropped_at`: "never edited" and "edited the moment it arrived"
/// are different facts and a default would make every item already in the sink
/// claim the second one.
///
/// It exists because the words in an item stop being the finder's the moment you
/// rewrite them, and `render` tells an agent who dropped a thing. An item that
/// says "dropped by lucid otter" while carrying a body you rewrote yesterday is
/// attributing your reasoning to a card that never said it — which matters here
/// more than it would anywhere else, since half of what a long-lived sink holds
/// was dropped by conversations that are no longer on the wall to be asked.
///
/// Deliberately *not* `dropped_at`, which an edit leaves alone. `dropped_at` is
/// when the finding was made and the whole ordering of the pile turns on it
/// (`sink.ts::reading`); moving it would let a typo fix send an item that has
/// been ignored for three weeks to the back of the queue, which is exactly the
/// item the pile exists to keep in front of you. `voices` is left alone for the
/// same reason from the other end: how many cards have met a thing is not
/// changed by somebody rewording it.
fn migrate_v22(conn: &Connection) -> Result<(), String> {
    add_column(conn, "sink_item", "edited_at", "INTEGER")
}

/// Standing instructions: one text for the whole wall, one per territory.
///
/// Two homes for one idea, and that is the point rather than an accident. A
/// project's instructions are a *property of that project* — they belong on its
/// row, where `forget_project`'s existing cascade takes them with it and no
/// second delete has to remember. The wall's are a property of nothing else, so
/// they get the singleton `window_frame` already established here: a table with
/// one row, `CHECK (id = 1)` making a second one impossible at the schema
/// rather than by convention.
///
/// The alternative — one `guidance(scope, project_id)` table shaped like
/// `notice` — was rejected because the wall's row would key on a NULL
/// `project_id`, and SQLite counts NULLs as distinct inside a PRIMARY KEY. That
/// is a uniqueness constraint that does not constrain, which is the worst of
/// the three options: it looks like it holds.
///
/// An ALTER with a default, per the note on `SCHEMA_VERSION` — every project
/// that already exists carries no instructions, which is the right answer for
/// all of them.
fn migrate_v23(conn: &Connection) -> Result<(), String> {
    add_column(conn, "project", "instructions", "TEXT NOT NULL DEFAULT ''")?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS wall_guidance (
            id           INTEGER PRIMARY KEY CHECK (id = 1),
            instructions TEXT NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v23: {e}"))
}

/// Which gear a card is in, so one put down survives a rouse.
///
/// NULL rather than a default of `bypassPermissions`, and the two are not the
/// same thing: NULL is "nobody has ever set this card's gear", which is every
/// card that existed before this column, and it spawns exactly as it always did
/// — with `--dangerously-skip-permissions` and nothing else said. A card that
/// has been *put* in bypass deliberately stores the string. Nothing reads the
/// difference today; the migration is written this way so that if anything ever
/// needs to, the answer is in the data rather than lost to a backfill.
fn migrate_v24(conn: &Connection) -> Result<(), String> {
    add_column(conn, "conversation", "permission_mode", "TEXT")
}

/// What a `turn` row *is* — a turn, or money with no turn to attribute it to.
///
/// A `result` can carry a cost step and no turn behind it: the CLI answers
/// `/compact`, `/model` and `/effort` itself, reporting `num_turns: 0` and an
/// all-zero `usage`. The cost it carries is real — `total_cost_usd` is a
/// running total of the *process*, so the step is whatever accumulated since
/// the last turn that had a `result` of its own — but the row written for it
/// said a turn had cost $13.52 and processed nothing. See `usage.ts::
/// turnRowKind`, which is where the deciding happens, and `.claude/rules/
/// usage.md`.
///
/// An ALTER with a default, per the note on `SCHEMA_VERSION`.
///
/// **The default is `'unknown'`, and that is the whole of the thinking here.**
/// The obvious choice is `'turn'` — it is what the overwhelming majority of
/// existing rows are — and it is wrong, because a default is applied to every
/// row already in the table and would therefore *assert* that each of them was
/// a turn. On this machine 101 of the 696 rows written since `migrate_v7` began
/// recording tokens carry no tokens at all, and some of them are precisely the
/// rows this column exists to distinguish. `'unknown'` asserts nothing.
///
/// **And there is deliberately no backfill**, which is the other half of the
/// same argument and the place it would have been easy to do damage.
/// `in_tokens = 0 AND out_tokens = 0 AND …` looks like it identifies these
/// rows and does not: it is the *symptom*, and rows written before
/// `migrate_v7` show the two apart — those carry zeros because nothing wrote
/// the columns yet, and they were ordinary turns. `num_turns` is not recorded
/// anywhere, so for a row already on disk the cause is genuinely unknowable,
/// and inferring it from the symptom would replace a readable lie with an
/// unreadable one. `migrate_v2` could backfill because it had the `turn` table
/// to recover *from*; this has nothing. Historical rows therefore stay exactly
/// as readable as they are today, which is the honest outcome and costs
/// nothing.
///
/// The default also lands on any future INSERT that forgets the column, and
/// that is the right direction for the same reason: a row nobody classified
/// reads as unclassified rather than as a turn.
fn migrate_v25(conn: &Connection) -> Result<(), String> {
    add_column(conn, "turn", "kind", "TEXT NOT NULL DEFAULT 'unknown'")
}

/// The last window frame, in physical pixels, or `None` if there isn't a usable
/// one. Every failure here is `None` on purpose — a missing row, a locked
/// database, a width some future build wrote as a negative — because the
/// fallback is "open centred on this monitor", which is a perfectly good window,
/// and nothing about where a window sat last time is worth failing a launch for.
pub(crate) fn read_window_frame(conn: &Connection) -> Option<crate::window::Frame> {
    let row: Option<(i64, i64, i64, i64, i64)> = conn
        .query_row(
            "SELECT x, y, w, h, maximized FROM window_frame WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (x, y, w, h, maximized) = row?;
    if w <= 0 || h <= 0 {
        return None;
    }
    Some(crate::window::Frame {
        x: x as i32,
        y: y as i32,
        w: w as u32,
        h: h as u32,
        maximized: maximized != 0,
    })
}

pub(crate) fn save_window_frame(
    conn: &Connection,
    f: &crate::window::Frame,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO window_frame (id, x, y, w, h, maximized, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
             x = ?1, y = ?2, w = ?3, h = ?4, maximized = ?5, updated_at = ?6",
        params![f.x, f.y, f.w as i64, f.h as i64, f.maximized as i64, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remember which account a card is on.
///
/// Written the moment a card is spawned or swapped rather than at the next
/// settling turn, for the reason `set_aside` gives: a card that swaps and is
/// never spoken to again would otherwise come back attached to the account it
/// left, and the first thing it did would be to move itself back.
#[tauri::command]
pub fn set_conversation_account(
    store: tauri::State<'_, Store>,
    id: String,
    account_label: Option<String>,
) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE conversation SET account_label = ?1 WHERE id = ?2",
            params![account_label, id],
        )
        .map_err(|e| format!("set account: {e}"))?;
    Ok(())
}

/// Which account a card is spending, for a caller that has only its id.
///
/// `None` covers both "no row" and a row whose label is null or empty, because
/// all three mean the same thing to everything downstream: the account Claude
/// Code is itself signed in as. `limits::token` already reads an empty label
/// that way, so flattening here keeps the two files agreeing rather than making
/// the caller remember which of three absences it is holding.
///
/// Not a `#[tauri::command]`. The front end has this on the conversation row it
/// already holds; the reader that needed a lookup is the `allowance` MCP tool,
/// which is handed a conversation id and nothing else.
pub fn account_of(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT account_label FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|l| !l.trim().is_empty())
}

/// Remember that a card is ignoring your caps.
#[tauri::command]
pub fn set_conversation_bypass(
    store: tauri::State<'_, Store>,
    id: String,
    bypass: bool,
) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE conversation SET bypass_caps = ?1 WHERE id = ?2",
            params![bypass as i64, id],
        )
        .map_err(|e| format!("set bypass: {e}"))?;
    Ok(())
}

pub fn now() -> i64 {

    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn dir_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/* ── commands ─────────────────────────────────────────────────────────── */

/// Find or create the project that owns a directory. Projects are implicit:
/// pointing at a new path is all it takes to make one.
#[tauri::command]
pub fn ensure_project(store: tauri::State<'_, Store>, root_path: String) -> Result<Project, String> {
    let conn = store.0.lock().unwrap();
    type Row =
        (String, String, Option<f64>, Option<f64>, Option<f64>, Option<f64>, String);
    let existing: Option<Row> = conn
        .query_row(
            "SELECT id, name, x, y, glass_x, glass_y, instructions
               FROM project WHERE root_path = ?1",
            params![root_path],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((id, name, x, y, glass_x, glass_y, instructions)) = existing {
        return Ok(Project { id, name, root_path, x, y, glass_x, glass_y, instructions });
    }

    let id = uuid_v4();
    let name = dir_name(&root_path);
    conn.execute(
        "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, root_path, now()],
    )
    .map_err(|e| e.to_string())?;
    /* No position: a project arrives in the grid's hands, and the wall writes
       one back as soon as it has flowed it somewhere. */
    /* And not on the glass: the pane is somewhere you put a thing on purpose,
       never somewhere a thing arrives. */
    Ok(Project {
        id,
        name,
        root_path,
        x: None,
        y: None,
        glass_x: None,
        glass_y: None,
        /* A new territory says nothing of its own. The wall's instructions still
           reach every card in it — see `crate::guidance::compose`. */
        instructions: String::new(),
    })
}

/// Where a territory sits on the wall.
///
/// `None`/`None` hands it back to the grid, which is what the territory menu's
/// "tidy it back onto the grid" does — so this is one command rather than a
/// place and a separate clear.
///
/// Only the territory is recorded here. The cards it carried are pinned by
/// `save_placement`, one call each, because that is already what a card's
/// position means and a territory drag is a drag of each of them too.
#[tauri::command]
pub fn place_project(
    store: tauri::State<'_, Store>,
    root_path: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    place_row(&conn, &root_path, x, y)
}

/// The write itself, so it can be tested without an app around it.
fn place_row(
    conn: &Connection,
    root_path: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE project SET x = ?2, y = ?3 WHERE root_path = ?1",
        params![root_path, x, y],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Point a territory at a different folder.
///
/// The other half of "a project arrives unrooted" — see `portage.ts`. An
/// imported layout carries the root its territory had on the machine that wrote
/// it, which will not exist here, and this is how it is given a real one.
///
/// `root_path` is UNIQUE and is the identity the whole app matches on, so the
/// conflict is the interesting case and it is left to SQLite rather than checked
/// first: a `SELECT` and then an `UPDATE` is two statements a second writer can
/// get between, and the constraint is the only thing that cannot be raced. What
/// comes back is the constraint's own message, which the panel shows.
///
/// The name is deliberately not touched, though `ensure_project` derives one
/// from the path at creation. A territory that arrived in a document is named
/// for the folder it had where it was written, which is nearly always what you
/// go on calling it — and a rename as a side effect of pointing at a folder is
/// one you would have to notice before you could undo it.
///
/// Nor are the cards. A card's `cwd` is where its process was actually spawned
/// and its transcript slug is derived from that path; rewriting it would claim a
/// conversation happened somewhere it did not. An imported territory has no
/// cards, and a rerooted one keeps whatever history it has, in the place that
/// history happened.
#[tauri::command]
pub fn reroot_project(
    store: tauri::State<'_, Store>,
    id: String,
    root_path: String,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    let hit = conn
        .execute(
            "UPDATE project SET root_path = ?2 WHERE id = ?1",
            params![id, root_path],
        )
        .map_err(|e| e.to_string())?;
    if hit == 0 {
        return Err(format!("no territory with id {id}"));
    }
    Ok(())
}

/// Where a territory is drawn when it has been stuck to the glass, or `None`
/// for one put back on the wall.
///
/// Its own command rather than two more arguments on `place_project`, whose own
/// pair of nulls already means something else entirely -- "hand it back to the
/// grid". Conflating them would make one call able to say two unrelated things
/// and neither of them clearly.
///
/// It deliberately does not touch `x`/`y`. A territory on the pane still holds
/// its cell on the wall, so putting it back drops it among its neighbours
/// exactly where it was and nothing else moves.
#[tauri::command]
pub fn stick_project(
    store: tauri::State<'_, Store>,
    root_path: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    stick_row(&conn, &root_path, x, y)
}

/// The write itself, so the round trip can be tested without an app around it.
fn stick_row(
    conn: &Connection,
    root_path: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE project SET glass_x = ?2, glass_y = ?3 WHERE root_path = ?1",
        params![root_path, x, y],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn record_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    project_id: String,
    cwd: String,
    worktree: Option<String>,
    /* `chat` for a card with no project; absent means `project`. One word, so
       there is no camelCase for `invoke` to convert and get wrong — the trap
       that left `last_ending` NULL for every turn ever taken. */
    kind: Option<String>,
    /* What the card was set up as, where a preset opened it. One word each, for
       the same reason `kind` is one word. Absent means "whatever Claude Code is
       configured for", which is every card opened by a plain click on the `+`
       and every card that existed before presets did. */
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    record_row(
        &conn,
        &id,
        &project_id,
        &cwd,
        worktree.as_deref(),
        kind.as_deref(),
        model.as_deref(),
        effort.as_deref(),
    )
}

/// The statement itself, so the insert can be tested without a Tauri app —
/// the bargain `import_row` and `forget_row` already strike.
#[allow(clippy::too_many_arguments)]
fn record_row(
    conn: &Connection,
    id: &str,
    project_id: &str,
    cwd: &str,
    worktree: Option<&str>,
    kind: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO conversation
           (id, agent_session_id, project_id, cwd, worktree, born_at, kind, model, effort)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'project'), ?7, ?8)",
        params![id, project_id, cwd, worktree, now(), kind, model, effort],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// What kind of card this id is, asked of the store.
///
/// The supervisor asks this rather than being told, for the reason it asks the
/// disk whether to resume: a capability that travels as an argument is one
/// every future call site has to remember to pass, and the failure mode here is
/// not a card that starts wrong but a chat card that comes back from a rouse
/// with the machine in its hands. `wake` never has to know.
///
/// Unknown ids answer `project`, which is what every id was before v11 — and
/// the conservative direction is the *card* being ordinary, never the sandbox
/// being lifted: a chat card is only ever chat because a row says so.
pub fn kind_of(store: &Store, id: &str) -> String {
    kind_row(&store.0.lock().unwrap(), id)
}

/// The query itself, so the fallback can be tested without a Tauri app.
fn kind_row(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT kind FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_else(|| "project".into())
}

/// What a card was set up as: the model and the effort to spawn it with.
///
/// Asked of the store for the same reason `kind_of` is, and it is the same
/// failure if it is not: `open` passes what a preset chose, `wake` has nothing
/// to pass, and a card that comes back from a rouse on the default model is a
/// preset that quietly stopped holding. The rouse is the case that matters,
/// because it is every dormant card at once with nobody watching — a wall of
/// cards opened as "a quick question" waking up on Opus.
///
/// Both are free text and neither is validated here. What `--model` accepts is
/// the CLI's business — aliases and full ids both work, probed 2026-08-20
/// against 2.1.233 — and a level from a newer build of Skein is one this one
/// should pass through rather than drop.
///
/// Unknown ids answer `(None, None)`, which is "whatever Claude Code is
/// configured for" — what every card was before presets existed.
pub fn setup_of(store: &Store, id: &str) -> (Option<String>, Option<String>) {
    setup_row(&store.0.lock().unwrap(), id)
}

/// The query itself, so the fallback can be tested without a Tauri app.
fn setup_row(conn: &Connection, id: &str) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT model, effort FROM conversation WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or((None, None))
}

/// Which gear a card is in, or `None` for one nobody has ever set.
///
/// The fourth of these, and it is asked of the store for exactly the reason the
/// other three are — see `worktree_of`, which records what happened to the one
/// that was passed as an argument instead. `open` could pass a gear; `wake`
/// could not, and the card it would forget is the one that matters: a card put
/// into planning, left dormant overnight, and roused at launch with the machine
/// back in its hands because nobody remembered it had been put down.
///
/// `None` means "spawn as this card has always spawned", which is bypass via
/// the flag rather than an explicit `--permission-mode`. Free text and not
/// validated here: what the flag accepts is the CLI's business, and
/// `supervisor::set_permission_mode` is the one door in, which does check.
pub fn gear_of(store: &Store, id: &str) -> Option<String> {
    gear_row(&store.0.lock().unwrap(), id)
}

/// The query itself, so the fallback can be tested without a Tauri app.
fn gear_row(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT permission_mode FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|m| !m.trim().is_empty())
}

/// Remember the gear, so it survives the card going dormant.
///
/// Written before the control request reaches the wire, not after — the order
/// `supervisor::set_permission_mode` keeps, and the same shape as
/// `set_mid_turn`: **bookkeeping that records a decision must not wait for the
/// thing it decides to succeed.** A card whose process died between the write
/// and the flush comes back in the gear you asked for; one where the order was
/// reversed comes back in the gear you left.
pub fn set_permission_mode(store: &Store, id: &str, mode: &str) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "UPDATE conversation SET permission_mode = ?2 WHERE id = ?1",
        params![id, mode],
    )
    .map_err(|e| format!("set permission mode: {e}"))?;
    Ok(())
}

/// Which branch's tree a card works in, or `None` for one that works in its
/// project.
///
/// The third of these, and it is the one that proves the rule the other two
/// state. `kind_of` and `setup_of` are both asked of the store because "`open`
/// and `wake` both reach this line and only one of them would have remembered
/// to pass it" — and `worktree` was the parameter that *was* passed, by `open`,
/// which remembered. `wake` did not. It sent `worktree: null` from the day the
/// app was written, which was harmless for as long as `--worktree` was a flag
/// the CLI kept across a `--resume`, and became a live bug the moment Skein
/// started making the tree itself (`worktree.rs`): every card woken by a click,
/// a send, a rouse or an account transition came back in the main tree — with
/// nothing to say so, since the row it reads its `cwd` from was still right.
///
/// Unknown ids answer `None`, which is the same thing every card without a
/// worktree answers and is therefore safe to fall back to.
pub fn worktree_of(store: &Store, id: &str) -> Option<String> {
    worktree_row(&store.0.lock().unwrap(), id)
}

/// The query itself, so the fallback can be tested without a Tauri app.
fn worktree_row(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT worktree FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
    .filter(|n: &String| !n.trim().is_empty())
}

/// The two standing instructions a card is to be told: the wall's, and its own
/// territory's. `crate::guidance` composes them; this is only the reading.
///
/// The fourth thing `spawn_now` asks the store rather than its caller, for the
/// reason `worktree_of` spells out at length — `open` and `wake` both reach that
/// line, and the one that forgets is the one that wakes every dormant card on
/// the wall at launch.
///
/// A lock it cannot take, a card with no row, a territory that has been
/// forgotten: all of them answer "nothing", which is what a wall with no
/// instructions set answers too and is therefore already a case every reader
/// handles.
pub fn guidance_of(store: &Store, id: &str) -> (String, String) {
    match store.0.lock() {
        Ok(conn) => guidance_rows(&conn, id),
        Err(_) => (String::new(), String::new()),
    }
}

/// The queries themselves, so the fallbacks can be tested without a Tauri app.
fn guidance_rows(conn: &Connection, id: &str) -> (String, String) {
    let wall = wall_guidance(conn);
    let project = conn
        .query_row(
            "SELECT p.instructions
               FROM conversation c JOIN project p ON p.id = c.project_id
              WHERE c.id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or_default();
    (wall, project)
}

/// Where chat cards stand.
///
/// They need *a* directory — the CLI is spawned in one, and the transcript
/// path is derived from it — but nothing about a chat card wants a project, so
/// this is a folder of Skein's own beside the database, created on demand. It
/// holds nothing and is never written to; it exists so that "no project" has an
/// address.
///
/// One directory for every chat card rather than one apiece: they share no
/// state because none of them can read or write a file, so a directory each
/// would be a hundred empty folders and a hundred transcript slugs.
#[tauri::command]
pub fn chat_home(store: tauri::State<'_, Store>) -> Result<String, String> {
    let dir = store.1.join("chat");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create chat dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Take a project off the wall for good.
///
/// The counterpart to a territory outliving its last card: an empty territory
/// stays because you are likely to use it again, so there has to be a way to
/// say you are not — otherwise every folder ever opened accumulates, and a
/// wall you cannot tidy stops being a wall you read.
///
/// Refused while anything is open in it, which is the case where the territory
/// is plainly still in use. Closed conversations go with it, and so do its
/// server groups and placements, by cascade — rows, not transcripts. Those stay
/// where Claude Code wrote them and can be adopted back at any time.
#[tauri::command]
pub fn forget_project(
    store: tauri::State<'_, Store>,
    root_path: String,
) -> Result<bool, String> {
    let conn = store.0.lock().unwrap();
    forget_row(&conn, &root_path)
}

/// The refusal and the delete, so both branches can be tested without an app.
fn forget_row(conn: &Connection, root_path: &str) -> Result<bool, String> {
    let open: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM conversation c
               JOIN project p ON p.id = c.project_id
              WHERE p.root_path = ?1 AND c.closed_at IS NULL",
            params![root_path],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if open > 0 {
        return Err(format!(
            "{open} conversation{} still open there",
            if open == 1 { " is" } else { "s are" }
        ));
    }
    let gone = conn
        .execute("DELETE FROM project WHERE root_path = ?1", params![root_path])
        .map_err(|e| e.to_string())?;
    Ok(gone > 0)
}

/// Adopt a conversation Claude Code recorded, as a card on the wall.
///
/// The row is a *pointer*: the transcript stays where the CLI wrote it and
/// stays canonical, because waking this card runs `--resume` against that same
/// file — which appends to it rather than forking (probed against 2.1.228). So
/// the same session remains resumable from a terminal afterwards, with whatever
/// Skein added to it.
///
/// `last_ending` is set to `ok` rather than left NULL, and that is load-bearing
/// rather than cosmetic: `Conversation.restore` reads NULL as "never spoke",
/// and a card that never spoke wakes with `--session-id` instead of `--resume`
/// — which for an id that already has a transcript is a collision, not a fresh
/// start. We cannot know how the last turn actually ended (that lives in
/// `result` events, which are not written to the transcript), so `ok` here
/// means no more than "there is something to resume".
///
/// Re-importing an id already on the wall is an update, and one that clears
/// `closed_at`: closing a card removes it from the wall without deleting it, so
/// adoption has to be able to bring it back.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn import_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    project_id: String,
    cwd: String,
    title: Option<String>,
    model: Option<String>,
    last_ctx_frac: Option<f64>,
    born_at: Option<i64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    import_row(
        &conn,
        &id,
        &project_id,
        &cwd,
        title.as_deref(),
        model.as_deref(),
        last_ctx_frac,
        born_at,
    )
}

/// The statement itself, so the upsert can be tested without a Tauri app.
#[allow(clippy::too_many_arguments)]
fn import_row(
    conn: &Connection,
    id: &str,
    project_id: &str,
    cwd: &str,
    title: Option<&str>,
    model: Option<&str>,
    last_ctx_frac: Option<f64>,
    born_at: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO conversation
           (id, agent_session_id, project_id, cwd, title, model, born_at,
            last_ctx_frac, last_ending)
         VALUES (?1, ?1, ?2, ?3, COALESCE(?4, 'untitled'), ?5, ?6,
                 COALESCE(?7, 0), 'ok')
         ON CONFLICT(id) DO UPDATE SET
           closed_at     = NULL,
           title         = COALESCE(?4, title),
           model         = COALESCE(?5, model),
           last_ctx_frac = COALESCE(?7, last_ctx_frac),
           last_ending   = COALESCE(last_ending, 'ok')",
        params![
            id,
            project_id,
            cwd,
            title,
            model,
            born_at.unwrap_or_else(now),
            last_ctx_frac
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called as a turn settles, so a dormant card can show what it reached without
/// ever spawning the session it belonged to.
///
/// `interrupted` is here and nothing calls it any more, which is worth a line
/// rather than a deletion. It used to be the one column the front end ever
/// *un*set: the flag meant "the app went away while this was mid-turn", and
/// `#deliver` cleared it on any successful send, since a lost turn that has been
/// answered stops being news. That reading is gone. The column now says "a turn
/// is open on this card", and it is written by the two ends of a turn in Rust
/// (`set_mid_turn`) — so a front end clearing it after a send would be wiping a
/// mark the send itself had just made, which is precisely how a crash mid-turn
/// came back with nothing to resume. The parameter stays because COALESCE means
/// an absent one costs nothing, and because a caller that wants to say this
/// should be made to read the paragraph above first.
///
/// `aside` is the other one that goes both ways, and needs nothing special for
/// it: it is only ever written by the gesture that sets or unsets it, so it
/// always arrives with the value it is meant to take. That is what a COALESCE
/// cannot express and why `clear_conversation` is its own command — the
/// difference is whether a caller ever means "put this back to the default",
/// which nothing here does.
///
/// `named_by_hand` needs nothing special for the opposite reason: it only ever
/// arrives `true`, from the one gesture that sets it, and the only thing that
/// unsets it is `clear_row` — which is already the command for "put this card
/// back to its defaults" and clears the title in the same statement.
#[tauri::command]
pub fn update_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    title: Option<String>,
    model: Option<String>,
    last_ctx_frac: Option<f64>,
    last_ending: Option<String>,
    interrupted: Option<bool>,
    aside: Option<bool>,
    named_by_hand: Option<bool>,
    effort: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "UPDATE conversation SET
           title         = COALESCE(?2, title),
           model         = COALESCE(?3, model),
           last_ctx_frac = COALESCE(?4, last_ctx_frac),
           last_ending     = COALESCE(?5, last_ending),
           interrupted   = COALESCE(?6, interrupted),
           aside         = COALESCE(?7, aside),
           named_by_hand = COALESCE(?8, named_by_hand),
           effort        = COALESCE(?9, effort)
         WHERE id = ?1",
        params![
            id,
            title,
            model,
            last_ctx_frac,
            last_ending,
            interrupted,
            aside,
            named_by_hand,
            effort
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Point a card at a fresh session, keeping the card.
///
/// Deliberately not an `update_conversation` with more parameters: that command
/// means "fill in what a settling turn learned", and every column it touches is
/// COALESCEd so an absent argument leaves the old value alone. Clearing needs
/// the opposite of that for three of these — `last_ending` back to NULL is the
/// whole point (the front end reads NULL as "never spoke", which is what makes
/// the next spawn use `--session-id` rather than `--resume` against a
/// transcript that does not exist yet), and a COALESCE cannot express it.
///
/// `agent_session_id` has been written since v1 and read by nobody until now,
/// so there is no migration here: the column was always the right shape, it
/// simply never had a reason to differ from `id`.
///
/// Nothing is deleted. The previous session's transcript stays where Claude
/// Code wrote it and can be adopted back onto the wall as its own card — the
/// same property that makes `forget_project` safe.
#[tauri::command]
pub fn clear_conversation(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    {
        let conn = store.0.lock().unwrap();
        clear_row(&conn, &id, &session_id)?;
    }
    /* Clearing mechanism (2) — see `board.rs`. A card that has been reset is not
       still doing what its notice says it is doing, and the notice would outlive
       every other trace of the work it described. */
    crate::board::clear_for(&app, &id);
    /* And it lets go of whatever it was holding in the sink — but the items
       themselves stay, which is the whole difference between the two. See
       `migrate_v18`. */
    crate::sink::release_for(&app, &id);
    crate::later::clear_for(&app, &id);
    Ok(())
}

/// The statement itself, so it can be tested without a Tauri app. It does not
/// touch the billboard — `clear_conversation` does that, where there is an
/// `AppHandle` to tell the wall with.
fn clear_row(conn: &Connection, id: &str, session_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE conversation SET
               agent_session_id = ?2,
               title            = 'untitled',
               named_by_hand    = 0,
               last_ctx_frac    = 0,
               last_ending      = NULL,
               interrupted      = 0
             WHERE id = ?1",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no conversation {id}"));
    }
    Ok(())
}

/// One row per settled turn, and the only place the wall records what a turn
/// *cost* — so every argument here has to be a fact about this turn alone.
/// Two of them were not, and the ledger was unreadable for it: `in_tokens` and
/// `out_tokens` were hardcoded to 0 at the call site, and `usd` was handed
/// `result.total_cost_usd`, which is the session's running total rather than
/// the turn's, so a card's rows climbed monotonically and no row said what its
/// own turn had spent. Both are read off `result.usage` now, whose sum-over-
/// the-turn shape — the very thing that disqualifies it from feeding the
/// context ring — is exactly what a turn row wants. See `Conversation.ingest`.
///
/// `cache_read_tokens` and `cache_write_tokens` are apart because their prices
/// are (0.1x against 1.25x input); see `migrate_v7`. `cache_tokens` is their
/// sum, kept so the column keeps meaning something rather than being left to
/// rot at whatever it last held.
///
/// **And a third argument was not a fact about the turn either, because there
/// was no turn.** `kind` says whether the row is one — see `migrate_v25` and
/// `usage.ts::turnRowKind`, which is where the deciding happens, since what a
/// ledger row *is* is knowledge about a bill rather than about the schema.
///
/// It is `Option<String>` and falls to `'unknown'`, which is a deliberate
/// choice about *which* failure a misspelling causes. Tauri converts camelCase
/// to snake_case and silently drops a key it does not recognise — the
/// `lastTier` bug — and a required `String` would then fail to deserialise, the
/// whole command would error, the front end's `.catch(() => {})` would swallow
/// it and **no row would be written at all**. That loses the money, which is
/// the one thing this table exists to keep; the day's figure and the burn
/// horizon are a SUM over it. So a label that does not arrive costs a label and
/// never a row. Same shape as `chat.md`'s "unknown falls to `project`": both
/// directions are wrong, and this is the one whose symptom is visible in the
/// data rather than absent from it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn record_turn(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    status_tier: String,
    kind: Option<String>,
    in_tokens: i64,
    out_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    usd: f64,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO turn
           (conversation_id, ended_at, status_tier, kind, in_tokens, out_tokens,
            cache_read_tokens, cache_write_tokens, cache_tokens, usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            conversation_id,
            now(),
            status_tier,
            row_kind(kind.as_deref()),
            in_tokens,
            out_tokens,
            cache_read_tokens,
            cache_write_tokens,
            cache_read_tokens + cache_write_tokens,
            usd
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The two labels a `turn` row may carry, and what anything else becomes.
///
/// Folded rather than stored verbatim, and this is the one place the two
/// arguments genuinely conflict. Storing what the caller said would be kinder
/// to a future build that invents a third kind; folding is kinder to *this*
/// one, because the column's whole purpose is that a row should not claim to be
/// something it is not, and `"trun"` sitting in the data is a value that looks
/// meaningful and is not. There is exactly one writer, so nothing is being
/// guarded against but a typo — and a typo reads as `unknown`, which is true.
fn row_kind(said: Option<&str>) -> &'static str {
    match said {
        Some("turn") => "turn",
        Some("spend") => "spend",
        _ => "unknown",
    }
}

/// What this studio has spent since a moment, in dollars — the figure in the
/// title bar and the warmth in the ground.
///
/// The cutoff is an argument rather than something worked out here, and both
/// halves of that are deliberate. "Today" is a *local* day, and the timezone —
/// with the two days a year its offset moves — is knowledge the front end has
/// and this file would have to grow a calendar to acquire. And a wall left open
/// overnight has to roll over, so the boundary is a moving argument rather than
/// a constant either way; `Skein.dayTick` is what notices.
///
/// Read off `turn`, which is the only place the wall records what a turn cost,
/// so this covers cards closed earlier today and turns taken in a previous run
/// of the app — everything the day's figure used to lose. It is *this* studio's
/// spend and not the account's: turns taken in a terminal are in no `turn` row,
/// which is what the usage widget reads transcripts for.
///
/// No index on `ended_at`. The table is one row per settled turn and the query
/// is a SUM of a few tens of thousands of tiny rows, run as a turn settles and
/// once when the day rolls; an index would cost a migration to save a fraction
/// of a millisecond.
#[tauri::command]
pub fn spend_since(store: tauri::State<'_, Store>, since: i64) -> Result<f64, String> {
    let conn = store.0.lock().unwrap();
    spend_row(&conn, since)
}

/// The statement itself, so it can be tested without a Tauri app.
///
/// **Every `kind` of row, and that is not an omission.** `migrate_v25` split
/// turns from money-with-no-turn-behind-it, and it is tempting to read this
/// figure as being about turns and filter. It is not: it is about *money*, and
/// a `spend` row's dollars were spent on the day they were recorded. The
/// measurement that settles it is on this wall's own table — on 2026-08-22 two
/// no-token rows carry $71.31 and $38.64 and are the **whole** of that day's
/// figure, $109.95 out of $109.95. A `WHERE kind = 'turn'` here would have
/// reported that day as costing nothing.
///
/// Which is also why `kind` was made a column on this table rather than a table
/// of its own. A separate table is the tidier shape and puts the hazard the
/// wrong way round: forgetting to filter costs a slightly noisy reading,
/// forgetting to UNION loses a day's money silently. The default direction of
/// the mistake matters more here than the tidiness does.
fn spend_row(conn: &Connection, since: i64) -> Result<f64, String> {
    /* COALESCE because SUM over no rows is NULL, and a day with nothing spent
       in it yet is the normal state at nine in the morning. */
    conn.query_row(
        "SELECT COALESCE(SUM(usd), 0) FROM turn WHERE ended_at >= ?1",
        params![since],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// One card's visit to one file.
pub struct Touch {
    pub conversation_id: String,
    pub path: String,
    /// `read` or `write`.
    pub op: String,
    pub at: i64,
}

/// Every recorded visit to a file whose path contains `needle`.
///
/// **A substring rather than a glob, and the narrowing is all this does.** What
/// is stored is whatever the tool call named — an absolute path, nearly always —
/// and what an agent asks about is what it would type: `src/lib/sink.ts`, or
/// just `sink.ts`. Deciding whether one covers the other is `board::covers`'
/// job and it is done in Rust on the rows this hands back, because the same
/// decision is already written there and a second spelling of it in SQL is a
/// second thing to be wrong. `instr` rather than `LIKE`, so a path with a `%` in
/// it needs no escaping.
///
/// Newest first and capped, because this is read to answer "who else has been
/// here lately" and the tail of a year's edits answers nothing.
pub fn touches_near(conn: &Connection, needle: &str, limit: i64) -> Vec<Touch> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, path, op, at FROM file_touch
          WHERE instr(lower(path), lower(?1)) > 0
          ORDER BY at DESC LIMIT ?2",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![needle, limit], |r| {
        Ok(Touch {
            conversation_id: r.get(0)?,
            path: r.get(1)?,
            op: r.get(2)?,
            at: r.get(3)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// Where a card is standing and which session it is on, which is the pair
/// `supervisor::transcript_path` needs. `None` for the session on a card that
/// has never taken a turn.
///
/// **The directory is where the card's child runs, not the row's `cwd`.** For
/// every card without a worktree those are the same string, and for one with a
/// worktree they are not: the row keeps the project root — its territory, its
/// servers, its shell — while the agent stands in the tree for its branch, and
/// the CLI files the transcript under whichever directory it is *running* in.
/// Every caller here is asking a question the CLI answers per-directory, so
/// every one of them wants the second. See `worktree::run_dir`.
pub fn session_of(conn: &Connection, id: &str) -> Option<(String, Option<String>)> {
    conn.query_row(
        "SELECT cwd, worktree, agent_session_id FROM conversation WHERE id = ?1",
        params![id],
        |r| {
            let cwd: String = r.get(0)?;
            let worktree: Option<String> = r.get(1)?;
            Ok((crate::worktree::run_dir(&cwd, worktree.as_deref()), r.get(2)?))
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// The same sum, for a caller that already holds the lock.
///
/// `spend_since` is the command and takes its cutoff from the front end, which
/// is where the timezone lives (see the note there). `limits::do_allowance` is
/// not the front end and has no timezone, so it asks for a rolling window
/// instead — which is why this is exposed rather than the command being called
/// from Rust with a guessed midnight.
pub fn spend_over(conn: &Connection, since: i64) -> f64 {
    spend_row(conn, since).unwrap_or(0.0)
}

/// Written from day one and read by almost nobody — see the module note.
#[tauri::command]
pub fn record_file_touch(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    path: String,
    op: String,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO file_touch (conversation_id, path, op, at) VALUES (?1, ?2, ?3, ?4)",
        params![conversation_id, path, op, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* ── the shared index ─────────────────────────────────────────────────────── */

/// A staged file that another card wrote and this one did not.
///
/// `title` is that card's, so the message a hook builds can name a card the
/// agent has actually seen on the wall rather than eight hex digits.
#[derive(Debug, Clone, PartialEq)]
pub struct Foreign {
    /// As git named it: relative to the repository root, forward slashes.
    pub path: String,
    pub conversation_id: String,
    pub title: String,
    /// Still on the wall. A closed card's uncommitted work is no more yours to
    /// commit, so this does not gate anything — it only changes the wording.
    pub open: bool,
}

/// Open the studio database read-only, for a process that is not the app.
///
/// **`Store::open` is not the way in from outside**, and the difference is the
/// whole point: it creates the directory, sets `journal_mode`, and runs
/// `migrate`. A short-lived process that did any of that would be a second
/// writer racing the wall through the recovery path — and `migrate`'s own note
/// records what a half-applied ladder costs. This opens the file that is there
/// and reads it.
///
/// `None` for anything at all: no file, a lock, a schema from the future. Every
/// caller here is advisory, so not knowing is the same as having nothing to say.
///
/// The database is in WAL, which a read-only connection reaches through the
/// `-shm` file rather than by reading the journal itself — so this works
/// *because the app is running*, which is exactly when the only caller exists.
pub fn open_readonly(db: &std::path::Path) -> Option<Connection> {
    use rusqlite::OpenFlags;
    Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// How far back a write counts as still being somebody's work in progress.
///
/// Milliseconds, because `now` is — getting that wrong would make the window
/// twenty-four *seconds* and the guard would see nothing on a wall that had
/// been quiet for a minute.
///
/// The staged-ness is the real evidence and this only bounds the scan, but it
/// is not *only* an optimisation: a card that wrote a file last week and
/// committed it, in a tree where somebody has since re-staged that same file,
/// would otherwise be named as the owner of work that is not its. A day is long
/// enough to cover a card left dormant overnight and short enough that last
/// week's history says nothing.
const STILL_WARM_MS: i64 = 24 * 60 * 60 * 1000;

/// Is this stored touch the same file git just named?
///
/// **Anchored at a separator, or `re.rs` matches `store.rs`** — the same trap
/// `board::covers` records, and the reason this is a suffix test rather than a
/// `contains`. Both sides arrive through `board::normalize`, so the comparison
/// is over forward slashes in one case.
///
/// The stored side is the longer one: an absolute path out of a tool call
/// against a path relative to the repository root. Equality is kept as a case
/// because a tool call may name a relative path too, which is what an agent
/// typing `src/lib/a.ts` into `Edit` produces.
fn same_file(stored: &str, staged_normalized: &str) -> bool {
    stored == staged_normalized
        || (stored.len() > staged_normalized.len()
            && stored.ends_with(staged_normalized)
            && stored.as_bytes()[stored.len() - staged_normalized.len() - 1] == b'/')
}

/// Of these staged paths, which were written by some *other* card lately.
///
/// This is the reader `file_touch` was waiting for. The table has been written
/// since the first build — every `Edit`, `Write` and `NotebookEdit` any card
/// makes — and until now the only thing that read it was the broadcast bar's
/// overlap warning. What it answers here is the question behind
/// sink 8d3dab75: **cards sharing a working tree share one git index**, so
/// `git add <my paths>` stages into an index a sibling has already staged into
/// and a pathspec-less `git commit` takes all of it.
///
/// **Paths are matched by normalised suffix, not by equality.** What
/// `file_touch` holds is whatever the tool call named — an absolute Windows path
/// with backslashes, nearly always — and what git names is relative to the
/// repository root with forward slashes. `board::normalize` already folds those
/// two into one spelling and is reused rather than respelled.
///
/// **A path this card has also written is not foreign.** Two cards editing one
/// file is a different problem and one the agent can see; being handed somebody
/// else's file it has never opened is the one it cannot.
///
/// Empty for every ordinary case — one card in a tree, a clean index, a machine
/// with no wall — and that is what makes a guard built on it silent rather than
/// a thing to work around.
pub fn foreign_staged(db: &std::path::Path, card: &str, root: &str, staged: &[String], now: i64) -> Vec<Foreign> {
    if staged.is_empty() {
        return Vec::new();
    }
    let Some(conn) = open_readonly(db) else {
        return Vec::new();
    };

    /* Every write under this tree, lately, by anybody. Narrowed in SQL by the
       root so a wall with a year of touches across six projects does not come
       back whole, and the deciding is done in Rust because `board::covers` and
       `normalize` are already the place that knows what "the same file" means.
       The cap is a backstop against a pathological tree, not a real bound. */
    let since = now - STILL_WARM_MS;
    let Ok(mut stmt) = conn.prepare(
        "SELECT f.path, f.conversation_id, COALESCE(c.title, ''), c.closed_at IS NULL
           FROM file_touch f
           LEFT JOIN conversation c ON c.id = f.conversation_id
          WHERE f.op = 'write'
            AND f.at > ?1
            AND instr(lower(f.path), lower(?2)) > 0
          ORDER BY f.at DESC
          LIMIT 8000",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![since, root], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)? != 0,
        ))
    }) else {
        return Vec::new();
    };

    /* Ours and theirs in one pass, because "this card also wrote it" is only
       answerable once every row has been seen. */
    let mut mine: Vec<String> = Vec::new();
    let mut theirs: Vec<(String, String, String, bool)> = Vec::new();
    for (path, conv, title, open) in rows.filter_map(Result::ok) {
        let norm = crate::board::normalize(&path);
        if conv == card {
            mine.push(norm);
        } else {
            theirs.push((norm, conv, title, open));
        }
    }

    let mut out: Vec<Foreign> = Vec::new();
    for rel in staged {
        let want = crate::board::normalize(rel);
        let is = |p: &String| same_file(p, &want);
        if mine.iter().any(is) {
            continue;
        }
        /* Newest first out of SQL, so the first match is the card that touched
           it last — which is the one whose work is sitting in the index. */
        if let Some((_, conv, title, open)) = theirs.iter().find(|(p, ..)| is(p)) {
            out.push(Foreign {
                path: rel.clone(),
                conversation_id: conv.clone(),
                title: title.clone(),
                open: *open,
            });
        }
    }
    out
}

/// Which other open conversations have edited the same files as this one.
/// The broadcast bar reads this to warn before a prompt fans out across a
/// shared working tree.
#[tauri::command]
pub fn overlapping_conversations(
    store: tauri::State<'_, Store>,
    conversation_id: String,
) -> Result<Vec<String>, String> {
    let conn = store.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT b.conversation_id
               FROM file_touch a
               JOIN file_touch b ON a.path = b.path
              WHERE a.conversation_id = ?1
                AND b.conversation_id <> ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// A card's whole placement: where it belongs on the wall, and where it is
/// drawn if it has been stuck to the glass.
///
/// Every column is written every time, with no COALESCE anywhere -- unlike
/// `update_conversation`, which leaves an absent argument alone. That is
/// deliberate, and the front end holds up the other end of it (`savePlacement`
/// takes the whole placement, never a piece of one): the two positions are set
/// by different gestures, so a partial write would mean dragging a territory
/// silently un-sticking every card in it, with no error anywhere to see it by.
/// `glass_x`/`glass_y` have to be able to say "on the wall", which is exactly
/// what a COALESCE cannot express -- the same reason `clear_conversation` is a
/// command of its own rather than more arguments on `update_conversation`.
#[tauri::command]
pub fn save_placement(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    x: f64,
    y: f64,
    pinned: bool,
    glass_x: Option<f64>,
    glass_y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO placement (conversation_id, x, y, pinned, glass_x, glass_y)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(conversation_id) DO UPDATE SET
           x = ?2, y = ?3, pinned = ?4, glass_x = ?5, glass_y = ?6",
        params![conversation_id, x, y, pinned as i64, glass_x, glass_y],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_conversation_record(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    id: String,
) -> Result<(), String> {
    {
        let conn = store.0.lock().unwrap();
        conn.execute(
            "UPDATE conversation SET closed_at = ?2 WHERE id = ?1",
            params![id, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    /* Its notices go with it. A command rather than a query, which is why this
       reaches into `board` where nothing else in this file does: the billboard's
       one reliable clearing is a card leaving the wall, and putting it anywhere
       else would make it a thing somebody has to remember. `board::clear_for`
       owns both the delete and telling the wall — see the note on
       `migrate_v15` for why a foreign key could not have done this. */
    crate::board::clear_for(&app, &id);
    crate::sink::release_for(&app, &id);
    crate::later::clear_for(&app, &id);
    Ok(())
}

/// Whether a turn is open on this card, written **as it happens** rather than
/// worked out later.
///
/// This column used to be filled in one place only — `Supervisor::shutdown` →
/// `mark_interrupted`, at `ExitRequested` — which quietly made it mean "the app
/// was *asked* to close while this was mid-turn". A crash is not asked, so
/// nothing ran, nothing was written, and the wall came back from the one kind of
/// exit that actually loses work with every card claiming it had finished
/// cleanly. That is the whole failure this fixes: the flag now goes down at the
/// moment a turn opens and comes up when it settles, so what survives a crash is
/// a row that was already true when the power went out. Nothing has to run at
/// exit for it to be right.
///
/// The cost is two UPDATEs per turn — one at each boundary, not one per event;
/// `stream_event` outnumbers everything else about 8:1 on a reasoning model, so
/// the caller writes only on a transition.
///
/// `closed_at IS NULL` for the reason `mark_interrupted` has always had it: a
/// card on its way off the wall is not a card with work standing still.
pub fn set_mid_turn(conn: &Connection, id: &str, open: bool) {
    let _ = conn.execute(
        "UPDATE conversation SET interrupted = ?2 WHERE id = ?1 AND closed_at IS NULL",
        params![id, open],
    );
}

/// Marks the conversations that lost a turn when the app went down. An in-flight
/// turn does not survive, and the card should say so rather than pretend it
/// finished cleanly.
///
/// Only the ones that were actually running, which is why `Supervisor::shutdown`
/// hands back its ids. `closed_at IS NULL` on its own also matches every dormant
/// card restored from a previous session and never woken — nothing was in flight
/// there, and flagging them meant a wall you had merely looked at came back with
/// every card claiming its last turn was interrupted.
///
/// Since `set_mid_turn` the row already says this before we get here, and that
/// is deliberately not an argument for deleting this: the in-memory `Conv::turn`
/// is the authority at quit, the row is a best-effort write from a reader
/// thread, and re-asserting the two agree costs one statement per mid-turn card
/// on a path that runs once. It can only ever set what the flag already meant.
pub fn mark_interrupted(conn: &Connection, ids: &[String]) {
    for id in ids {
        set_mid_turn(conn, id, true);
    }
}

#[tauri::command]
pub fn save_server_group(
    store: tauri::State<'_, Store>,
    group: ServerGroup,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    let spec = serde_json::to_string(&group.servers).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO server_group (id, project_id, label, autostart, start_order, spec_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           label = ?3, autostart = ?4, start_order = ?5, spec_json = ?6",
        params![
            group.id,
            group.project_id,
            group.label,
            group.autostart as i64,
            group.start_order,
            spec
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_server_group(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM server_group WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The whole studio, in one round trip. This is what lets the wall paint
/// itself before anything has been spawned.
#[tauri::command]
pub fn load_studio(store: tauri::State<'_, Store>) -> Result<Studio, String> {
    let conn = store.0.lock().unwrap();

    let mut ps = conn
        .prepare(
            "SELECT id, name, root_path, x, y, glass_x, glass_y, instructions
               FROM project ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let projects = ps
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
                glass_x: r.get(5)?,
                glass_y: r.get(6)?,
                instructions: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut cs = conn
        .prepare(
            "SELECT c.id, c.agent_session_id, c.project_id, c.cwd, c.title, c.worktree,
                    c.model, c.interrupted, c.last_ctx_frac, c.last_ending, c.aside,
                    c.kind, c.named_by_hand, c.account_label, c.bypass_caps,
                    p.x, p.y, p.pinned, p.glass_x, p.glass_y, c.effort,
                    c.permission_mode
               FROM conversation c
               LEFT JOIN placement p ON p.conversation_id = c.id
              WHERE c.closed_at IS NULL
              ORDER BY c.born_at",
        )
        .map_err(|e| e.to_string())?;
    let conversations = cs
        .query_map([], |r| {
            Ok(StoredConversation {
                id: r.get(0)?,
                agent_session_id: r.get(1)?,
                project_id: r.get(2)?,
                cwd: r.get(3)?,
                title: r.get(4)?,
                worktree: r.get(5)?,
                model: r.get(6)?,
                interrupted: r.get::<_, i64>(7)? != 0,
                last_ctx_frac: r.get(8)?,
                last_ending: r.get(9)?,
                aside: r.get::<_, i64>(10)? != 0,
                kind: r.get(11)?,
                named_by_hand: r.get::<_, i64>(12)? != 0,
                account_label: r.get(13)?,
                bypass_caps: r.get::<_, i64>(14)? != 0,
                x: r.get(15)?,
                y: r.get(16)?,
                pinned: r.get::<_, Option<i64>>(17)?.unwrap_or(0) != 0,
                glass_x: r.get(18)?,
                glass_y: r.get(19)?,
                effort: r.get(20)?,
                permission_mode: r.get(21)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut gs = conn
        .prepare(
            "SELECT id, project_id, label, autostart, start_order, spec_json
               FROM server_group ORDER BY start_order",
        )
        .map_err(|e| e.to_string())?;
    let server_groups = gs
        .query_map([], |r| {
            let spec: String = r.get(5)?;
            Ok(ServerGroup {
                id: r.get(0)?,
                project_id: r.get(1)?,
                label: r.get(2)?,
                autostart: r.get::<_, i64>(3)? != 0,
                start_order: r.get(4)?,
                servers: serde_json::from_str(&spec).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(Studio {
        projects,
        conversations,
        server_groups,
        guidance: wall_guidance(&conn),
    })
}

/* ── standing instructions ────────────────────────────────────────────────
   The store's half of `crate::guidance`; the composing and the argv are
   there. Kept here because this is the file that owns the two tables, and a
   subsystem reaching into another's SQL is how a schema stops being one
   file's business. */

/// What the wall tells every card. Never fails: a missing row is the ordinary
/// first-launch case and a locked database is not worth failing a paint over,
/// and both mean the same thing to every reader — nothing to say.
pub fn wall_guidance(conn: &Connection) -> String {
    conn.query_row("SELECT instructions FROM wall_guidance WHERE id = 1", [], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// Set the wall's. An upsert on the one permitted id, the same shape
/// `save_window_frame` uses over the same kind of single-row table.
///
/// Answers what was stored rather than nothing, because `clip` may have
/// shortened it and a panel that goes on showing its own draft would then be
/// showing text no card will ever be handed.
#[tauri::command]
pub fn set_wall_guidance(store: tauri::State<'_, Store>, text: String) -> Result<String, String> {
    let text = crate::guidance::clip(&text);
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    conn.execute(
        "INSERT INTO wall_guidance (id, instructions, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET instructions = ?1, updated_at = ?2",
        params![text, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(text)
}

/// Set one territory's. Same contract as the wall's, one row over.
#[tauri::command]
pub fn set_project_guidance(
    store: tauri::State<'_, Store>,
    project_id: String,
    text: String,
) -> Result<String, String> {
    let text = crate::guidance::clip(&text);
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    let n = conn
        .execute(
            "UPDATE project SET instructions = ?2 WHERE id = ?1",
            params![project_id, text],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no project {project_id} on this wall"));
    }
    Ok(text)
}

/* ── reference images ─────────────────────────────────────────────────── */

/// `rename_all` is a no-op for every field that was already here — they are all
/// one word — and gives the glass pair the `glassX`/`glassY` the front end
/// speaks everywhere else. See `migrate_v9`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefImage {
    pub id: String,
    pub path: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub z: i64,
    /// Where it is drawn if it has been stuck to the glass, or `None` for one
    /// on the wall. Never a substitute for `x`/`y`.
    ///
    /// `default` because these arrive from the front end as well as leaving for
    /// it, and a payload written by a build that predates the glass has to be
    /// readable as "on the wall" rather than refused.
    #[serde(default)]
    pub glass_x: Option<f64>,
    #[serde(default)]
    pub glass_y: Option<f64>,
    /// The card that pinned it, or `None` for one you put up yourself. See
    /// `migrate_v21` — it is a permission rather than a provenance note.
    #[serde(default)]
    pub pinned_by: Option<String>,
}

const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"];

/// Copy an image into the studio's own storage and return its new home.
///
/// Deliberately a copy, not a link. A reference board is a thing you build up
/// over months; it should not quietly fill with broken rectangles because you
/// tidied your downloads folder. It also means the asset protocol can be scoped
/// to one directory instead of the whole disk.
///
/// Split from the command below so `pin.rs` can reach it. It could not: the
/// command takes a `State`, which an MCP handler has as an `AppHandle` and not
/// as an extractor, and copying a file is not knowledge worth writing twice.
pub fn copy_into_references(
    data_dir: &std::path::Path,
    src: &std::path::Path,
) -> Result<String, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "not an image: .{ext} — the wall draws {}",
            IMAGE_EXTS.join(", ")
        ));
    }
    let dir = data_dir.join("references");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create references dir: {e}"))?;
    let dest = dir.join(format!("{}.{ext}", uuid_v4()));
    std::fs::copy(src, &dest).map_err(|e| format!("copy {}: {e}", src.display()))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_image(store: tauri::State<'_, Store>, src: String) -> Result<String, String> {
    copy_into_references(&store.1, std::path::Path::new(&src))
}

/// What kind of image these bytes are, read off the bytes themselves.
///
/// The clipboard route has no filename to take an extension from, and the front
/// end's `type` string is not a fact about the bytes — so this asks the bytes.
/// The extension it returns is what names the file, and the asset protocol
/// serves a content type off that name, so a guess here would be served as a
/// lie later. `None` means "nothing we can draw", which is the honest answer for
/// the audio, the html and the shortcut that also live on a clipboard.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    let head = |sig: &[u8]| bytes.starts_with(sig);
    if head(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head(b"\xff\xd8\xff") {
        Some("jpg")
    } else if head(b"GIF87a") || head(b"GIF89a") {
        Some("gif")
    } else if head(b"BM") {
        Some("bmp")
    /* RIFF is a container — the four bytes after the length say which one, and
       only WEBP is an image. */
    } else if head(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        Some("webp")
    /* AVIF is ISO-BMFF: a length, then `ftyp`, then the brand. */
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        Some("avif")
    } else {
        None
    }
}

/// Give bytes off the clipboard the same home an imported file gets.
///
/// A screenshot has no path: Windows' capture tools put a bitmap on the
/// clipboard and write nothing to disk, so `import_image`'s copy-from-a-path has
/// nothing to copy from. Everything downstream is unchanged — the file lands in
/// the same `references` directory, which is the only place the asset protocol
/// will serve from.
///
/// The bytes ride as a raw IPC body (`InvokeBody::Raw`) rather than as command
/// arguments, because a `Vec<u8>` argument is serialised as a JSON array of
/// numbers: a two-megabyte screenshot would cross as roughly eight million
/// characters of text.
#[tauri::command]
pub fn paste_image(
    store: tauri::State<'_, Store>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("clipboard image arrived as json, not bytes".into());
    };
    let Some(ext) = sniff_image(bytes) else {
        return Err("clipboard holds no image we can draw".into());
    };

    let dir = store.1.join("references");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create references dir: {e}"))?;
    let dest = dir.join(format!("{}.{ext}", uuid_v4()));
    std::fs::write(&dest, bytes).map_err(|e| format!("write pasted image: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Sort dropped paths into the two things the wall accepts: directories become
/// conversations, images get pinned up. Anything else is ignored rather than
/// guessed at.
#[derive(Debug, Serialize, Default)]
pub struct Dropped {
    pub dirs: Vec<String>,
    pub images: Vec<String>,
}

#[tauri::command]
pub fn classify_drop(paths: Vec<String>) -> Dropped {
    let mut out = Dropped::default();
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            out.dirs.push(p);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if IMAGE_EXTS.contains(&ext.as_str()) {
            out.images.push(p);
        }
    }
    out
}

#[tauri::command]
pub fn list_images(store: tauri::State<'_, Store>) -> Result<Vec<RefImage>, String> {
    let conn = store.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, path, x, y, w, h, rotation, z, glass_x, glass_y, pinned_by
               FROM reference_image ORDER BY z, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RefImage {
                id: r.get(0)?,
                path: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                rotation: r.get(6)?,
                z: r.get(7)?,
                glass_x: r.get(8)?,
                glass_y: r.get(9)?,
                pinned_by: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_image(store: tauri::State<'_, Store>, image: RefImage) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO reference_image
           (id, path, x, y, w, h, rotation, z, glass_x, glass_y, pinned_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           path = ?2,
           x = ?3, y = ?4, w = ?5, h = ?6, rotation = ?7, z = ?8,
           glass_x = ?9, glass_y = ?10",
        params![
            image.id, image.path, image.x, image.y, image.w, image.h,
            image.rotation, image.z, image.glass_x, image.glass_y,
            image.pinned_by, now()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The images one card put on the wall, oldest first, each with when it went up.
///
/// Not a command: `pin.rs` asks it, on the MCP server's own thread, to answer an
/// agent about its own pins. The front end has the whole list in `$state`
/// already and has no use for a second route to it.
///
/// Oldest first, because "the one I put up before this" is the only ordering an
/// agent can name — it cannot see the wall, so a list sorted by where things
/// are would be sorted by something it has no way to check.
pub fn images_pinned_by(
    conn: &Connection,
    caller: &str,
) -> Result<Vec<(RefImage, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, x, y, w, h, rotation, z, glass_x, glass_y, pinned_by, created_at
               FROM reference_image WHERE pinned_by = ?1 ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![caller], |r| {
            Ok((
                RefImage {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    x: r.get(2)?,
                    y: r.get(3)?,
                    w: r.get(4)?,
                    h: r.get(5)?,
                    rotation: r.get(6)?,
                    z: r.get(7)?,
                    glass_x: r.get(8)?,
                    glass_y: r.get(9)?,
                    pinned_by: r.get(10)?,
                },
                r.get::<_, i64>(11)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// How many images are on the wall in all, an agent's own included.
///
/// Said alongside the list above so a card knows how much of the wall is not
/// its business, which is the whole reason `repin` will not touch a row it did
/// not write.
pub fn image_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM reference_image", [], |r| r.get(0))
        .unwrap_or(0)
}

/// One image, whoever put it there, or `None` if no such row.
pub fn image_row(conn: &Connection, id: &str) -> Option<RefImage> {
    conn.query_row(
        "SELECT id, path, x, y, w, h, rotation, z, glass_x, glass_y, pinned_by
           FROM reference_image WHERE id = ?1",
        params![id],
        |r| {
            Ok(RefImage {
                id: r.get(0)?,
                path: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                rotation: r.get(6)?,
                z: r.get(7)?,
                glass_x: r.get(8)?,
                glass_y: r.get(9)?,
                pinned_by: r.get(10)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// Removes the row and leaves the copied file where it is.
///
/// It used to take the file too, on the reasonable argument that we own the copy
/// and an orphan is invisible. Undo is what changed the arithmetic: taking an
/// image down is now a step you can take back (see `src/lib/undo.ts`), and a
/// step that put the row back pointing at a file we had just deleted would
/// restore a broken rectangle — the exact failure the note in `Board.remove` is
/// about, arriving by a new route.
///
/// So the copy outlives the row, and `sweep_references` collects it at the next
/// launch, which is when the stack that wanted it is gone. That also picks up
/// the orphan this pair has always been able to leak: `import_image` copies the
/// file and the front end writes the row afterwards, so a crash between the two
/// left a file no row has ever claimed.
#[tauri::command]
pub fn delete_image(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM reference_image WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete every file in our references directory that no row points at, and
/// answer how many went.
///
/// Called once, from `Board.load` — the moment the rows have just been read and
/// therefore the moment "no row points at it" is a fact rather than a race. It
/// must not be called at any other time: an image is copied to disk before its
/// row is written, so a sweep running between those two steps would delete the
/// file out from under an image being pinned up.
///
/// Only ever inside our own directory, and only files — the same guard
/// `delete_image` carried, since the path column holds whatever was imported and
/// nothing here may follow it out of the folder we own.
#[tauri::command]
pub fn sweep_references(store: tauri::State<'_, Store>) -> Result<usize, String> {
    let conn = store.0.lock().unwrap();
    sweep_orphans(&conn, &store.1.join("references"))
}

fn sweep_orphans(conn: &Connection, owned: &std::path::Path) -> Result<usize, String> {
    let dir = match std::fs::read_dir(owned) {
        Ok(d) => d,
        /* Nothing pinned up yet, so nothing to sweep. */
        Err(_) => return Ok(0),
    };

    let mut claimed = std::collections::HashSet::new();
    {
        let mut stmt = conn
            .prepare("SELECT path FROM reference_image")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            claimed.insert(row.map_err(|e| e.to_string())?);
        }
    }

    let mut swept = 0;
    for entry in dir.flatten() {
        let path = entry.path();
        /* Directories are left alone rather than walked: nothing puts one here,
           so one that exists is somebody else's and not ours to collect. */
        if !path.is_file() {
            continue;
        }
        /* Compared as the string a row would hold, which is what `import_image`
           and `paste_image` hand the front end and therefore what got written. */
        if claimed.contains(&path.to_string_lossy().to_string()) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            swept += 1;
        }
    }
    Ok(swept)
}

/* ── ambience ─────────────────────────────────────────────────────────────
 *
 * See the note on `migrate_v4` for why the layers are one JSON column. Nothing
 * here understands what an effect is: the vocabulary lives in
 * `src/lib/ambience.ts`, which is also the only thing that validates it, so
 * adding a parameter never touches Rust. */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AmbienceProfile {
    pub id: String,
    pub name: String,
    /// The layer stack, verbatim. Opaque here on purpose.
    pub layers: serde_json::Value,
    pub active: bool,
}

#[tauri::command]
pub fn list_ambience(store: tauri::State<'_, Store>) -> Result<Vec<AmbienceProfile>, String> {
    let conn = store.0.lock().unwrap();
    list_ambience_rows(&conn)
}

/// The read itself, so the round trip can be tested without an app around it.
fn list_ambience_rows(conn: &Connection) -> Result<Vec<AmbienceProfile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, layers_json, active FROM ambience_profile ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let raw: String = r.get(2)?;
            Ok(AmbienceProfile {
                id: r.get(0)?,
                name: r.get(1)?,
                /* A column that will not parse is an empty stack, not a failure
                   to paint the wall — the profile is still there to be edited. */
                layers: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([])),
                active: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Upsert one profile. Called on every adjustment (debounced in the front end),
/// so it must be cheap and must not disturb which profile is showing.
#[tauri::command]
pub fn save_ambience(
    store: tauri::State<'_, Store>,
    profile: AmbienceProfile,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_ambience_row(&conn, &profile)
}

fn save_ambience_row(conn: &Connection, profile: &AmbienceProfile) -> Result<(), String> {
    let layers = serde_json::to_string(&profile.layers).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO ambience_profile (id, name, layers_json, active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?2, layers_json = ?3",
        params![profile.id, profile.name, layers, profile.active as i64, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Show a profile, or `None` for a bare wall.
///
/// One statement clears whatever was showing and one lights this, in a
/// transaction: two profiles both marked active would leave the front end
/// picking one by row order, which is a wall that changes when nothing did.
#[tauri::command]
pub fn activate_ambience(
    store: tauri::State<'_, Store>,
    id: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    activate_ambience_row(&conn, id.as_deref())
}

fn activate_ambience_row(conn: &Connection, id: Option<&str>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE ambience_profile SET active = 0 WHERE active <> 0", [])
        .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        let hit = tx
            .execute(
                "UPDATE ambience_profile SET active = 1 WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        if hit == 0 {
            /* Dropping the transaction rolls it back, so a bad id leaves what
               was showing showing rather than blanking the wall. */
            return Err(format!("no ambience profile {id}"));
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_ambience(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM ambience_profile WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ── widgets ──────────────────────────────────────────────────────────────
 *
 * See the note on `migrate_v5`. Nothing here knows what a clock is: the
 * catalogue, the variants and the defaults live in `src/lib/widgets.ts`, which
 * is also the only thing that validates a config — so a new variant, a new knob
 * or a whole new kind of widget never touches Rust. */

/// `rename_all` as on `RefImage`, and for the same reason.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z: i64,
    /// Where it is drawn if it has been stuck to the glass, or `None` for one
    /// on the wall. Never a substitute for `x`/`y`.
    ///
    /// `default` because these arrive from the front end as well as leaving for
    /// it, and a payload written by a build that predates the glass has to be
    /// readable as "on the wall" rather than refused.
    #[serde(default)]
    pub glass_x: Option<f64>,
    #[serde(default)]
    pub glass_y: Option<f64>,
    /// Whatever this kind of widget was set to. Opaque here on purpose.
    pub config: serde_json::Value,
}

#[tauri::command]
pub fn list_widgets(store: tauri::State<'_, Store>) -> Result<Vec<Widget>, String> {
    let conn = store.0.lock().unwrap();
    list_widget_rows(&conn)
}

/// The read itself, so the round trip can be tested without an app around it.
fn list_widget_rows(conn: &Connection) -> Result<Vec<Widget>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, x, y, w, h, z, config_json, glass_x, glass_y
               FROM widget ORDER BY z, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let raw: String = r.get(7)?;
            Ok(Widget {
                id: r.get(0)?,
                kind: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                z: r.get(6)?,
                glass_x: r.get(8)?,
                glass_y: r.get(9)?,
                /* A config that will not parse is a widget at its defaults, not
                   a hole in the wall — `normalizeWidget` fills in every knob it
                   does not find, so an empty object is the honest fallback. */
                config: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Upsert one widget. Called on every drag frame (debounced in the front end),
/// so it must be cheap.
#[tauri::command]
pub fn save_widget(store: tauri::State<'_, Store>, widget: Widget) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_widget_row(&conn, &widget)
}

fn save_widget_row(conn: &Connection, w: &Widget) -> Result<(), String> {
    let config = serde_json::to_string(&w.config).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO widget
           (id, kind, x, y, w, h, z, config_json, glass_x, glass_y, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           x = ?3, y = ?4, w = ?5, h = ?6, z = ?7, config_json = ?8,
           glass_x = ?9, glass_y = ?10",
        params![
            w.id, w.kind, w.x, w.y, w.w, w.h, w.z, config, w.glass_x, w.glass_y, now()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_widget(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM widget WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ── the pomodoro cycle ────────────────────────────────────────────────────
 *
 * One row or none. See `migrate_v8` for why it is not a widget's config. */

/// The cycle as last written, or `None` when no pomodoro has ever been started
/// here. `None` is a real answer rather than a failure — the front end reads it
/// as the default cycle, switched off, which is what an untouched studio is.
#[tauri::command]
pub fn read_pomodoro(store: tauri::State<'_, Store>) -> Result<Option<serde_json::Value>, String> {
    let conn = store.0.lock().unwrap();
    read_pomodoro_row(&conn)
}

fn read_pomodoro_row(conn: &Connection) -> Result<Option<serde_json::Value>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT state_json FROM pomodoro WHERE id = 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    /* A state that will not parse is a studio with no cycle running, not an
       error to put on the fault bar: `normalizeCycle` fills in every field it
       does not find, so `null` is the honest fallback and the next write
       repairs the row. */
    Ok(raw.map(|s| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)))
}

/// Upsert the cycle. Written on every transition and on a slow beat while one
/// is running, so like `save_widget` it has to be cheap.
#[tauri::command]
pub fn save_pomodoro(
    store: tauri::State<'_, Store>,
    state: serde_json::Value,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_pomodoro_row(&conn, &state)
}

fn save_pomodoro_row(conn: &Connection, state: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO pomodoro (id, state_json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET state_json = ?1, updated_at = ?2",
        params![json, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* ── background jobs ──────────────────────────────────────────────────────
 *
 * Written when a job is confirmed running and deleted when it reports in, so
 * what is in this table at launch is exactly the work whose ending nobody was
 * there to hear. See `migrate_v17` for why that is the whole schema, and
 * `turns.md` for the measurement that says this case is the only one worth
 * paying for. */

/// Remember a job that has just been confirmed running.
///
/// Called on the *receipt*, not on the call: a job starts provisional and only
/// its receipt says whether it really went to the background — and the receipt
/// is also the only place the output path is ever named, so those are the same
/// moment. An upsert rather than an insert because a tool_use id is unique but a
/// card may be told about one twice on a restart that replays.
#[tauri::command]
pub fn record_job(
    store: tauri::State<'_, Store>,
    tool_id: String,
    conversation_id: String,
    session_id: String,
    task_id: Option<String>,
    kind: String,
    label: String,
    output_path: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO job (tool_id, conversation_id, session_id, task_id, kind, label, output_path, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(tool_id) DO UPDATE SET
             task_id = COALESCE(?4, task_id),
             output_path = COALESCE(?7, output_path)",
        params![tool_id, conversation_id, session_id, task_id, kind, label, output_path, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A job reported in, so nobody needs to be told about it again.
///
/// Matched on the tool_use id alone. The notification also carries a `task-id`
/// and `#settleJob` will fall back to it, but a row is only ever written under a
/// tool_use id, so that is the one that can miss nothing.
#[tauri::command]
pub fn settle_job(store: tauri::State<'_, Store>, tool_id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM job WHERE tool_id = ?1", params![tool_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drop everything remembered for a card.
///
/// Called where a card is closed and where it is cleared, because neither of
/// those deletes the `conversation` row and so neither fires the foreign key —
/// see `migrate_v17`. A cleared card is the sharper of the two: it keeps its id
/// and takes a new session, so rows left behind would be reported against a
/// session that never ran them.
#[tauri::command]
pub fn forget_jobs(store: tauri::State<'_, Store>, conversation_id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM job WHERE conversation_id = ?1", params![conversation_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// What a card had in flight, with somewhere to read each one if there is one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJob {
    pub tool_id: String,
    pub task_id: Option<String>,
    pub kind: String,
    pub label: String,
    /// Where the output is, but **only if it is actually there**. See below.
    pub output_path: Option<String>,
    pub started_at: i64,
}

/// The jobs a card never heard the end of, for the prompt that tells it so.
///
/// Two things happen here that cannot happen in the front end, which is why this
/// is a command rather than a query the caller shapes.
///
/// **The path is derived for the kinds whose receipt never named one.** Only
/// Bash's does; a `Monitor`, an `Agent` and a `Workflow` carry none, and the
/// CLI's layout is the same for all four —
/// `%TEMP%\claude\<slug>\<session>\tasks\<task-id>.output` — with `slug` the
/// same fold `transcript_dir_name` already performs for transcripts. An agent's
/// task id is the `agentId` off its receipt, which is why that is extracted now
/// having deliberately not been.
///
/// **And then it is checked, which is the half that makes deriving safe.** A
/// path is only returned if a file is really at it, so a CLI that moves its task
/// directory costs this feature its paths rather than handing an agent a
/// filename that does not exist — the failure mode being avoided is a card told
/// to go and read something, going, and finding nothing, which reads as the work
/// having vanished rather than as Skein guessing. Everything else on the row is
/// reported either way: knowing a job was lost is worth saying even when there
/// is nowhere to look.
#[tauri::command]
pub fn pending_jobs(
    store: tauri::State<'_, Store>,
    conversation_id: String,
) -> Result<Vec<PendingJob>, String> {
    let conn = store.0.lock().unwrap();
    jobs_of(&conn, &conversation_id, None)
}

/// The same rows, for a process that is not the app.
///
/// The hook this serves is `hooks::reply`'s `UserPromptSubmit` and
/// `SessionStart` arms — a short-lived `skein.exe --bash-hook` handing a card
/// back the background work it has forgotten it started. `open_readonly` for the
/// reason `foreign_staged` uses it: a reader is a reader, and a second process
/// running the migration ladder is the one path `store.rs` records as having
/// locked the app out of its own database.
///
/// **Scoped to one session, which `pending_jobs` deliberately is not.** The
/// command's caller is `rouse`, whose whole question is what the *previous*
/// process left behind; the hook's is what *this* process is holding, and the
/// difference matters in both directions. A row from a dead session is work the
/// resume prompt already tells the card about and then deletes — repeating it
/// here would say it twice — and if that prompt never went, the row would
/// otherwise be re-announced on every prompt forever, which is a false claim
/// with no way of ever becoming true. A session id bounds it to something
/// provable: the process that started this job is the process asking.
///
/// Silent on every failure, like `foreign_staged` and for the same reason — the
/// caller is advisory, so not knowing is the same as having nothing to say.
pub fn outstanding_jobs(db: &std::path::Path, card: &str, session: &str) -> Vec<PendingJob> {
    let Some(conn) = open_readonly(db) else {
        return Vec::new();
    };
    jobs_of(&conn, card, Some(session)).unwrap_or_default()
}

/// The body both of the above share: rows out, paths derived and checked.
fn jobs_of(
    conn: &Connection,
    conversation_id: &str,
    session: Option<&str>,
) -> Result<Vec<PendingJob>, String> {
    /* The directory the card's child *ran* in, which for a worktree card is not
       the `cwd` on its row — the temp task tree is slugged from the same string
       transcripts are, so asking the wrong one hands back a path that is not
       there and the check below then drops it. Silent, and it looked exactly
       like "the CLI moved its task directory". Taken from the row rather than
       from the caller for the reason `spawn_conversation` takes everything from
       the row: `rouse` is the only caller and it had `cwd` to hand. */
    let run_dir = session_of(conn, conversation_id)
        .map(|(dir, _)| dir)
        .unwrap_or_default();
    /* `?2 IS NULL OR session_id = ?2` rather than two prepared statements: the
       two callers differ in one predicate and nothing else, and a second copy of
       the column list is a second place for it to drift from the tuple below. */
    let mut stmt = conn
        .prepare(
            "SELECT tool_id, task_id, kind, label, output_path, started_at, session_id
             FROM job WHERE conversation_id = ?1
               AND (?2 IS NULL OR session_id = ?2)
             ORDER BY started_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id, session], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let (tool_id, task_id, kind, label, stored, started_at, session_id) =
            row.map_err(|e| e.to_string())?;
        let path = stored.or_else(|| task_output_path(&run_dir, &session_id, task_id.as_deref()));
        let path = path.filter(|p| std::path::Path::new(p).exists());
        out.push(PendingJob { tool_id, task_id, kind, label, output_path: path, started_at });
    }
    Ok(out)
}

/// Where the CLI writes a task's output, for the three kinds that never say.
///
/// Not `home_dir` like `transcript_path` — the tasks live under the *temp*
/// directory, which is a different root that happens to carry the same slug.
fn task_output_path(cwd: &str, session_id: &str, task_id: Option<&str>) -> Option<String> {
    let task_id = task_id?;
    let p = std::env::temp_dir()
        .join("claude")
        .join(crate::supervisor::transcript_dir_name(cwd))
        .join(session_id)
        .join("tasks")
        .join(format!("{task_id}.output"));
    Some(p.to_string_lossy().into_owned())
}

/* ── the roster ───────────────────────────────────────────────────────────
 *
 * What one card is allowed to know about the others. See `relay.rs`, which is
 * the only caller and owns every decision about what it *means*; these are
 * queries and nothing else.
 *
 * Note what is deliberately not here. A card's live reading — working, asking,
 * what it is doing this second — is a fold over events and lives in
 * `conversation.svelte.ts`, which is in the webview. Rust knows the row and the
 * process, and that is what the roster reports: enough to pick who to talk to,
 * and nothing that would need the front end to be running for an agent to ask.
 */

/// One card as the roster sees it. `state` is filled in by `relay.rs` from the
/// supervisor, since having a process is not something the database knows.
#[derive(Debug, Clone)]
pub struct RosterRow {
    pub id: String,
    pub title: String,
    pub project: String,
    pub project_id: String,
    pub cwd: String,
    pub worktree: Option<String>,
    pub kind: String,
    /// When the last turn on this card ended, or `None` if it has never taken
    /// one. Milliseconds, the unit everything else in this file uses.
    pub last_turn_at: Option<i64>,
    /// Messages written to it that it has not been given yet.
    pub inbox: i64,
}

/// One territory on the wall, for an agent that may name it.
#[derive(Debug, Clone)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub root_path: String,
}

/// Every territory the wall has, in the order the eye reads them.
///
/// This is the set a `spawn` may name, and it is deliberately the *table*
/// rather than "projects with a card open in them": a territory is the user's
/// own standing declaration that this is somewhere they work here, it outlives
/// its last card on purpose (see `forget_row`), and `forget project` is how it
/// is retracted. So what an agent may point a card at is exactly what the user
/// has put on the wall and not taken off again — never a path a model wrote.
pub fn projects(conn: &Connection) -> Result<Vec<ProjectRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, root_path FROM project ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectRow { id: r.get(0)?, name: r.get(1)?, root_path: r.get(2)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Every card still on the wall, optionally narrowed to one project.
///
/// Closed cards are left out and that is the whole of the filter: a card you
/// closed is not somebody to talk to, and an agent offered one would address it
/// and be told it is not there — a refusal it could have been spared by not
/// being shown the row.
///
/// **`MAX(t.ended_at)` counts every `kind` of turn row, deliberately.** This is
/// the one query that reads a row *as a turn*, so `migrate_v25` looks like it
/// owes a `WHERE kind = 'turn'` here, and it does not. What `last_turn_at`
/// feeds is `relay.rs`'s `idle_seconds` — how long since this card did
/// anything, read by an agent deciding whether there is somebody there to talk
/// to. A card that answered `/compact` a minute ago is demonstrably alive, and
/// filtering would report it as idle for however long the compaction ran. The
/// `kind` column says what a row *cost*; it does not say whether the card was
/// awake, and these are two questions.
///
/// That is also why `record_turn` is still called for a locally-answered
/// result rather than the row being skipped. Skipping it would change
/// `idle_seconds` by the back door — the same behaviour change, arrived at
/// without deciding to make it.
///
/// Ordered by `born_at` so the list reads in the order the wall was built,
/// which is the order the cards are in on it.
pub fn roster(conn: &Connection, project_id: Option<&str>) -> Result<Vec<RosterRow>, String> {
    let sql = "
        SELECT c.id, c.title, p.name, c.project_id, c.cwd, c.worktree, c.kind,
               (SELECT MAX(t.ended_at) FROM turn t WHERE t.conversation_id = c.id),
               (SELECT COUNT(*) FROM relay r
                 WHERE r.to_id = c.id AND r.delivered_at IS NULL)
          FROM conversation c
          JOIN project p ON p.id = c.project_id
         WHERE c.closed_at IS NULL
           AND (?1 IS NULL OR c.project_id = ?1)
         ORDER BY c.born_at";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| {
            Ok(RosterRow {
                id: r.get(0)?,
                title: r.get(1)?,
                project: r.get(2)?,
                project_id: r.get(3)?,
                cwd: r.get(4)?,
                worktree: r.get(5)?,
                kind: r.get(6)?,
                last_turn_at: r.get(7)?,
                inbox: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// The one row an addressed card is, or `None` — used to answer "who am I" and
/// to check a target before writing to it.
pub fn roster_one(conn: &Connection, id: &str) -> Option<RosterRow> {
    roster(conn, None).ok()?.into_iter().find(|r| r.id == id)
}

/// Write a message down. `delivered_at` is null until it has actually gone into
/// the recipient's stdin, which is what makes the same row serve as the inbox.
#[allow(clippy::too_many_arguments)]
pub fn record_relay(
    conn: &Connection,
    id: &str,
    from_id: &str,
    to_id: &str,
    body: &str,
    chain: &str,
    hops: i64,
    delivered: bool,
) -> Result<(), String> {
    let at = now();
    conn.execute(
        "INSERT INTO relay (id, from_id, to_id, body, chain, hops, sent_at, delivered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            from_id,
            to_id,
            body,
            chain,
            hops,
            at,
            if delivered { Some(at) } else { None }
        ],
    )
    .map_err(|e| format!("record relay: {e}"))?;
    Ok(())
}

/// One queued message, in the order it was written.
#[derive(Debug, Clone)]
pub struct QueuedRelay {
    pub id: String,
    pub from_id: String,
    pub body: String,
    pub chain: String,
    pub hops: i64,
}

/// What a card has been told while it was asleep, oldest first.
///
/// Read rather than taken: `mark_delivered` is a separate call, made once the
/// write to stdin has succeeded. A card whose pipe was closed between these two
/// still has its message.
pub fn inbox(conn: &Connection, to_id: &str) -> Result<Vec<QueuedRelay>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, from_id, body, chain, hops FROM relay
              WHERE to_id = ?1 AND delivered_at IS NULL
              ORDER BY sent_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![to_id], |r| {
            Ok(QueuedRelay {
                id: r.get(0)?,
                from_id: r.get(1)?,
                body: r.get(2)?,
                chain: r.get(3)?,
                hops: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Best-effort, per the note on `persist_turn`: a mark that did not land is a
/// message delivered twice at the next wake, which is a duplicate line in a
/// transcript — where failing the delivery would be a message lost.
pub fn mark_delivered(conn: &Connection, id: &str) {
    let _ = conn.execute(
        "UPDATE relay SET delivered_at = ?2 WHERE id = ?1 AND delivered_at IS NULL",
        params![id, now()],
    );
}

/// How many messages every card is holding undelivered, for the wall's inbox
/// marks. One query rather than one per card, since this is read on every
/// restore.
/* ── the billboard ────────────────────────────────────────────────────────
 *
 * Queries only. `board.rs` owns every decision about what a notice *means* —
 * what may post one, when it is stale, whether a path is covered by it.
 */

#[derive(Debug, Clone)]
pub struct Notice {
    pub id: String,
    /// `project` or `skein`.
    pub scope: String,
    /// Null for a wall-wide notice.
    pub project_id: Option<String>,
    /// Null when you posted it rather than a card.
    pub from_id: Option<String>,
    pub subject: String,
    pub body: String,
    /// Newline-separated globs; empty means it is about the work, not a file.
    pub paths: String,
    pub posted_at: i64,
    pub touched_at: i64,
}

fn notice_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Notice> {
    Ok(Notice {
        id: r.get(0)?,
        scope: r.get(1)?,
        project_id: r.get(2)?,
        from_id: r.get(3)?,
        subject: r.get(4)?,
        body: r.get(5)?,
        paths: r.get(6)?,
        posted_at: r.get(7)?,
        touched_at: r.get(8)?,
    })
}

const NOTICE_COLS: &str =
    "id, scope, project_id, from_id, subject, body, paths, posted_at, touched_at";

/// What is on the board for a card standing in `project_id`.
///
/// A project read returns that project's notices **and** the wall-wide ones,
/// because a notice posted to the whole wall is by definition relevant to
/// everyone — a scope that hid them would make `skein` the only useful reading
/// and the default the wrong one. `None` for the project means every board.
///
/// Newest last, which is the order a board is read in.
pub fn notices(conn: &Connection, project_id: Option<&str>) -> Result<Vec<Notice>, String> {
    let sql = format!(
        "SELECT {NOTICE_COLS} FROM notice
          WHERE ?1 IS NULL OR scope = 'skein' OR project_id = ?1
          ORDER BY posted_at"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| notice_of(r))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Put one up, or bring your own up to date.
///
/// Keyed on `(from_id, subject)` rather than minted fresh every time, and that
/// is what keeps the board readable: an agent that re-posts "reworking the
/// transcript" once a turn would otherwise paper the whole board with the same
/// sentence. Re-posting refreshes `touched_at`, which is also how a notice says
/// it is still true — see `board::stale`.
#[allow(clippy::too_many_arguments)]
pub fn put_notice(
    conn: &Connection,
    id: &str,
    scope: &str,
    project_id: Option<&str>,
    from_id: Option<&str>,
    subject: &str,
    body: &str,
    paths: &str,
) -> Result<String, String> {
    let at = now();
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM notice
              WHERE subject = ?1
                AND ((from_id IS NULL AND ?2 IS NULL) OR from_id = ?2)",
            params![subject, from_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();

    if let Some(old) = existing {
        conn.execute(
            "UPDATE notice SET scope = ?2, project_id = ?3, body = ?4, paths = ?5,
                               touched_at = ?6
              WHERE id = ?1",
            params![old, scope, project_id, body, paths, at],
        )
        .map_err(|e| format!("update notice: {e}"))?;
        /* The words changed, so everybody who was shown the old ones is owed the
           new ones. Without this, editing a notice would quietly reach nobody
           who had already met it — which is precisely the agent it most needs
           to reach. */
        let _ = conn.execute("DELETE FROM notice_served WHERE notice_id = ?1", params![old]);
        return Ok(old);
    }

    conn.execute(
        "INSERT INTO notice (id, scope, project_id, from_id, subject, body, paths,
                             posted_at, touched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![id, scope, project_id, from_id, subject, body, paths, at],
    )
    .map_err(|e| format!("post notice: {e}"))?;
    Ok(id.to_string())
}

/// Take one down. `owner` limits it to that card's own notices; `None` is you,
/// who may take down anything — it is your wall.
pub fn drop_notice(conn: &Connection, id: &str, owner: Option<&str>) -> bool {
    let n = match owner {
        Some(o) => conn.execute(
            "DELETE FROM notice WHERE id = ?1 AND from_id = ?2",
            params![id, o],
        ),
        None => conn.execute("DELETE FROM notice WHERE id = ?1", params![id]),
    };
    let gone = n.unwrap_or(0) > 0;
    if gone {
        let _ = conn.execute("DELETE FROM notice_served WHERE notice_id = ?1", params![id]);
    }
    gone
}

/// Everything one card has up. What an agent that has finished a piece of work
/// wants, and what closing a card does for it.
pub fn drop_notices_of(conn: &Connection, from_id: &str) -> usize {
    let _ = conn.execute(
        "DELETE FROM notice_served WHERE notice_id IN
           (SELECT id FROM notice WHERE from_id = ?1)",
        params![from_id],
    );
    conn.execute("DELETE FROM notice WHERE from_id = ?1", params![from_id])
        .unwrap_or(0)
}

/// Drop every notice whose author is no longer on the wall.
///
/// The commonest stale notice by far is one from a card that finished and went
/// away, so this is the clearing that actually works — the other three are
/// nudges. See the note on `migrate_v15` for why it is not a foreign key.
pub fn sweep_notices(conn: &Connection) -> usize {
    let _ = conn.execute(
        "DELETE FROM notice_served WHERE notice_id IN
           (SELECT n.id FROM notice n JOIN conversation c ON c.id = n.from_id
             WHERE c.closed_at IS NOT NULL)",
        [],
    );
    conn.execute(
        "DELETE FROM notice WHERE from_id IN
           (SELECT id FROM conversation WHERE closed_at IS NOT NULL)",
        [],
    )
    .unwrap_or(0)
}

/// How many notices this card has up, for the cap.
pub fn notice_count_of(conn: &Connection, from_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM notice WHERE from_id = ?1",
        params![from_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Mark this notice as shown to this card, and say whether that was news.
///
/// `INSERT OR IGNORE` is the whole decision, so two tool calls landing at once
/// cannot both be told they are the first — a read-then-write here would serve
/// the same notice twice on a card making parallel edits, which is exactly the
/// card this fires on.
pub fn serve_notice(conn: &Connection, notice_id: &str, conversation_id: &str) -> bool {
    conn.execute(
        "INSERT OR IGNORE INTO notice_served (notice_id, conversation_id, at)
         VALUES (?1, ?2, ?3)",
        params![notice_id, conversation_id, now()],
    )
    .unwrap_or(0)
        > 0
}

/* ── the sink ────────────────────────────────────────────────────────────────
 *
 * `.claude/rules/sink.md` is the reasoning; `migrate_v18` is why the columns are
 * these. Everything here is deliberately dull — the interesting decisions (which
 * hold has expired, whether two titles are the same thing) live in `sink.rs`,
 * beside the words an agent reads about them.
 */

#[derive(Debug, Clone)]
pub struct SinkItem {
    pub id: String,
    /// Null for an item about the wall rather than about one project.
    pub project_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: String,
    /// Newline-separated globs; empty means it is about no file in particular.
    pub paths: String,
    /// The card that dropped it, or null when you did. Provenance only — see
    /// `migrate_v18` on why nothing cleans up after it.
    pub from_id: Option<String>,
    pub dropped_at: i64,
    pub touched_at: i64,
    pub voices: i64,
    pub held_by: Option<String>,
    pub held_at: Option<i64>,
    pub settled_at: Option<i64>,
    pub settled_note: Option<String>,
    /// When you last reworded it, or `None` for an item still in the words it
    /// was dropped in. See `migrate_v22`.
    pub edited_at: Option<i64>,
}

const SINK_COLS: &str = "id, project_id, kind, title, body, paths, from_id, dropped_at, \
                         touched_at, voices, held_by, held_at, settled_at, settled_note, \
                         edited_at";

fn sink_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<SinkItem> {
    Ok(SinkItem {
        id: r.get(0)?,
        project_id: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        body: r.get(4)?,
        paths: r.get(5)?,
        from_id: r.get(6)?,
        dropped_at: r.get(7)?,
        touched_at: r.get(8)?,
        voices: r.get(9)?,
        held_by: r.get(10)?,
        held_at: r.get(11)?,
        settled_at: r.get(12)?,
        settled_note: r.get(13)?,
        edited_at: r.get(14)?,
    })
}

/// What is in the sink for a card standing in `project_id`.
///
/// Same scope rule as the billboard: a project read returns that project's items
/// **and** the wall-wide ones, because an item with no project is by definition
/// everybody's. `None` for the project means every item in the database, which
/// is what the widget asks for when it is showing the whole wall.
///
/// Oldest first — a sink is read to find the thing that has been waiting
/// longest, which is the opposite of the order a transcript wants.
pub fn sink_items(
    conn: &Connection,
    project_id: Option<&str>,
    settled: bool,
) -> Result<Vec<SinkItem>, String> {
    let sql = format!(
        "SELECT {SINK_COLS} FROM sink_item
          WHERE (?1 IS NULL OR project_id IS NULL OR project_id = ?1)
            AND settled_at IS {}
          ORDER BY dropped_at",
        if settled { "NOT NULL" } else { "NULL" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |r| sink_of(r))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn sink_one(conn: &Connection, id: &str) -> Option<SinkItem> {
    let sql = format!("SELECT {SINK_COLS} FROM sink_item WHERE id = ?1");
    conn.query_row(&sql, params![id], |r| sink_of(r))
        .optional()
        .ok()
        .flatten()
}

/// The result of a `drop`, which is one of two quite different things.
pub struct SinkPut {
    pub id: String,
    /// True when this went onto an item that was already there.
    pub merged: bool,
    pub voices: i64,
}

/// How long a body may grow by merging. Nothing here is a document; an item that
/// has grown past this has become a conversation and wants to be several items.
const MAX_SINK_BODY: usize = 4_000;

/// Put something in the sink, or add a voice to what is already there.
///
/// **Merging on the title is what keeps this readable, and it must not be
/// silent.** A box every card may write to freely collects the same observation
/// once per card that meets it — "ask_user timed out on me" is a true thing five
/// agents will each independently want to report — and fifteen near-identical
/// rows is a sink nobody reads, which is a sink that may as well not exist. But
/// deduplicating by dropping the later ones throws away the one fact those
/// fifteen rows carried that one row does not: that it keeps happening, to
/// everybody. So a merge *counts* (`voices`), keeps the new words if they are
/// new, and `sink.rs` says in the receipt that this is what happened — an agent
/// that believed it had raised a fresh thing when it had seconded an old one
/// would go on to describe the sink wrongly to the user.
///
/// Matched case-insensitively on the whole title within the same scope, and no
/// cleverer than that on purpose: a fuzzy match that folded two genuinely
/// different findings together would lose the second one entirely, where the
/// cost of missing a match is merely the duplicate this was avoiding.
#[allow(clippy::too_many_arguments)]
pub fn put_sink_item(
    conn: &Connection,
    id: &str,
    project_id: Option<&str>,
    kind: &str,
    title: &str,
    body: &str,
    paths: &str,
    from_id: Option<&str>,
) -> Result<SinkPut, String> {
    let at = now();
    let existing: Option<(String, String, i64, Option<String>)> = conn
        .query_row(
            "SELECT id, body, voices, from_id FROM sink_item
              WHERE settled_at IS NULL
                AND lower(title) = lower(?1)
                AND ((project_id IS NULL AND ?2 IS NULL) OR project_id = ?2)",
            params![title, project_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((old, old_body, voices, old_from)) = existing {
        /* A second card meeting the same thing is a second voice. The same card
           saying it twice is not — that is one agent repeating itself, and
           counting it would make `voices` a measure of how talkative a card is
           rather than of how widely the thing is felt. */
        let another = from_id.is_some() && from_id != old_from.as_deref();
        let mut body_now = old_body.clone();
        if !body.is_empty() && !old_body.contains(body) {
            body_now.push_str("\n\n");
            body_now.push_str(body);
            if body_now.chars().count() > MAX_SINK_BODY {
                body_now = body_now.chars().take(MAX_SINK_BODY).collect();
            }
        }
        let voices_now = voices + i64::from(another);
        conn.execute(
            "UPDATE sink_item SET body = ?2, voices = ?3, touched_at = ?4,
                                  paths = CASE WHEN ?5 = '' THEN paths ELSE ?5 END
              WHERE id = ?1",
            params![old, body_now, voices_now, at, paths],
        )
        .map_err(|e| format!("update sink item: {e}"))?;
        return Ok(SinkPut { id: old, merged: true, voices: voices_now });
    }

    conn.execute(
        "INSERT INTO sink_item (id, project_id, kind, title, body, paths, from_id,
                                dropped_at, touched_at, voices)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 1)",
        params![id, project_id, kind, title, body, paths, from_id, at],
    )
    .map_err(|e| format!("drop into sink: {e}"))?;
    Ok(SinkPut { id: id.to_string(), merged: false, voices: 1 })
}

/// Reword one, which is yours alone — no agent reaches this.
///
/// The other write to an item's words, and the shorter half of `put_sink_item`
/// in every respect: no merge, no voice, and `dropped_at` and `from_id` left
/// exactly as they were. What moves is `kind`, `title`, `body`, `paths` and the
/// `edited_at` stamp that says so.
///
/// **Conditional on the row still being editable, for `hold_sink_item`'s
/// reason.** A guard that is not in the UPDATE is not a guard: you open an item
/// to fix its title, a card `take`s it while you are typing, and a read-then-
/// write would then rewrite the brief out from under an agent already working
/// from it — which is the hazard the billboard exists to prevent, arriving
/// through the one door the billboard does not watch. `sink.rs` checks first so
/// it can say *why* in words; this is what makes the answer true. `cutoff` is
/// the instant a hold stops being believed, and the arithmetic matches
/// `sink::free` exactly — a `held_at` of NULL fails `held_at < ?` and so counts
/// as held, which is what `free` says too.
pub fn edit_sink_item(
    conn: &Connection,
    id: &str,
    kind: &str,
    title: &str,
    body: &str,
    paths: &str,
    cutoff: i64,
) -> bool {
    let at = now();
    conn.execute(
        "UPDATE sink_item SET kind = ?2, title = ?3, body = ?4, paths = ?5,
                              edited_at = ?6, touched_at = ?6
          WHERE id = ?1
            AND settled_at IS NULL
            AND (held_by IS NULL OR held_at < ?7)",
        params![id, kind, title, body, paths, at, cutoff],
    )
    .unwrap_or(0)
        > 0
}

/// Take an item, or put it back — `by` of `None` releases it.
///
/// Conditional on the hold the caller believes it is replacing, so two cards
/// claiming the same item in the same instant cannot both be told they have it:
/// `expect` is the holder the caller read, and the UPDATE lands only if that is
/// still what the row says. A read-then-write here would hand one item to two
/// agents, which is the one thing a hold exists to prevent.
pub fn hold_sink_item(
    conn: &Connection,
    id: &str,
    by: Option<&str>,
    expect: Option<&str>,
) -> bool {
    let at = now();
    conn.execute(
        "UPDATE sink_item SET held_by = ?2, held_at = ?3, touched_at = ?4
          WHERE id = ?1
            AND settled_at IS NULL
            AND ((held_by IS NULL AND ?5 IS NULL) OR held_by = ?5)",
        params![id, by, by.map(|_| at), at, expect],
    )
    .unwrap_or(0)
        > 0
}

/// Refresh a hold this card already has, so a long piece of work does not go
/// stale underneath it.
pub fn touch_sink_hold(conn: &Connection, id: &str, by: &str) -> bool {
    let at = now();
    conn.execute(
        "UPDATE sink_item SET held_at = ?3, touched_at = ?3 WHERE id = ?1 AND held_by = ?2",
        params![id, by, at],
    )
    .unwrap_or(0)
        > 0
}

/// Mark it addressed. Not a DELETE — see `migrate_v18`.
pub fn settle_sink_item(conn: &Connection, id: &str, note: Option<&str>) -> bool {
    conn.execute(
        "UPDATE sink_item SET settled_at = ?2, settled_note = ?3, held_by = NULL,
                              held_at = NULL, touched_at = ?2
          WHERE id = ?1 AND settled_at IS NULL",
        params![id, now(), note],
    )
    .unwrap_or(0)
        > 0
}

/// Put a settled item back, because it turned out not to be addressed.
pub fn unsettle_sink_item(conn: &Connection, id: &str) -> bool {
    conn.execute(
        "UPDATE sink_item SET settled_at = NULL, settled_note = NULL, touched_at = ?2
          WHERE id = ?1 AND settled_at IS NOT NULL",
        params![id, now()],
    )
    .unwrap_or(0)
        > 0
}

/// Yours to throw away. No agent reaches this — an item an agent believes is
/// finished with is `settle_sink_item`, which keeps the record.
pub fn drop_sink_item(conn: &Connection, id: &str) -> bool {
    conn.execute("DELETE FROM sink_item WHERE id = ?1", params![id])
        .unwrap_or(0)
        > 0
}

/// Let go of everything one card is holding. Called where a card closes and
/// where it is cleared: the item stays, the claim on it does not.
pub fn release_sink_holds_of(conn: &Connection, held_by: &str) -> usize {
    conn.execute(
        "UPDATE sink_item SET held_by = NULL, held_at = NULL WHERE held_by = ?1",
        params![held_by],
    )
    .unwrap_or(0)
}

/// Release every hold belonging to a card no longer on the wall.
///
/// The backstop for a crash between the two calls above, run on every read —
/// the same shape as `sweep_notices`, with the difference that matters: this
/// clears the *hold* and leaves the item. An item is not somebody's to take away
/// by closing their card. See `migrate_v18`.
pub fn sweep_sink_holds(conn: &Connection) -> usize {
    conn.execute(
        "UPDATE sink_item SET held_by = NULL, held_at = NULL
          WHERE held_by IN (SELECT id FROM conversation WHERE closed_at IS NOT NULL)",
        [],
    )
    .unwrap_or(0)
}

/// How many items this card is holding, for the cap.
pub fn sink_held_count(conn: &Connection, held_by: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sink_item WHERE held_by = ?1 AND settled_at IS NULL",
        params![held_by],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// How many still-open items this card has dropped, for the cap.
pub fn sink_dropped_count(conn: &Connection, from_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM sink_item WHERE from_id = ?1 AND settled_at IS NULL",
        params![from_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}


/* -- wakes ------------------------------------------------------------------ */

pub struct Wake {
    pub id: String,
    pub conversation_id: String,
    pub armed_at: i64,
    pub note: String,
}

pub fn arm_wake(
    conn: &Connection,
    id: &str,
    conversation_id: &str,
    due_at: i64,
    note: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO wake (id, conversation_id, due_at, armed_at, note)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, conversation_id, due_at, now(), note],
    )
    .map(|_| ())
    .map_err(|e| format!("arm wake: {e}"))
}

/// Everything that has come due, oldest first.
pub fn wakes_due(conn: &Connection, now_ms: i64) -> Vec<Wake> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, conversation_id, armed_at, note FROM wake
          WHERE due_at <= ?1 ORDER BY due_at",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![now_ms], |r| {
        Ok(Wake {
            id: r.get(0)?,
            conversation_id: r.get(1)?,
            armed_at: r.get(2)?,
            note: r.get(3)?,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

/// Claim one, so it cannot be served twice. The DELETE *is* the claim -- see the
/// note in `later::serve_due` on why this happens before the delivery rather
/// than after it.
pub fn take_wake(conn: &Connection, id: &str) -> bool {
    conn.execute("DELETE FROM wake WHERE id = ?1", params![id])
        .unwrap_or(0)
        > 0
}

pub fn wakes_armed_by(conn: &Connection, conversation_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM wake WHERE conversation_id = ?1",
        params![conversation_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn record_wake_served(conn: &Connection, conversation_id: &str, at: i64) {
    let _ = conn.execute(
        "INSERT INTO wake_served (conversation_id, at) VALUES (?1, ?2)",
        params![conversation_id, at],
    );
    /* Kept only as long as the window that reads it. Pruned here rather than on
       a timer, because this is the one moment the table is known to have grown
       and a sweep nobody triggers is a table that only grows. */
    let _ = conn.execute(
        "DELETE FROM wake_served WHERE at < ?1",
        params![at - 2 * 60 * 60 * 1_000],
    );
}

pub fn wakes_served_to(conn: &Connection, conversation_id: &str, since: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM wake_served WHERE conversation_id = ?1 AND at >= ?2",
        params![conversation_id, since],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// A card is going, or has been cleared. Nothing here is worth keeping.
pub fn drop_wakes_of(conn: &Connection, conversation_id: &str) {
    let _ = conn.execute("DELETE FROM wake WHERE conversation_id = ?1", params![conversation_id]);
    let _ = conn.execute(
        "DELETE FROM wake_served WHERE conversation_id = ?1",
        params![conversation_id],
    );
}


/* -- parentage -------------------------------------------------------------- */

/// Record that a card is about to be opened by another card. See `migrate_v20`
/// on why this is an intent rather than a column.
pub fn record_spawn(conn: &Connection, child_id: &str, parent_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO spawned (child_id, parent_id, at) VALUES (?1, ?2, ?3)",
        params![child_id, parent_id, now()],
    )
    .map(|_| ())
    .map_err(|e| format!("record spawn: {e}"))
}

/// Was this card opened by another card?
///
/// **No caller at the moment** — `spawn::ONE_GENERATION` is off, so a card an
/// agent opened may open cards of its own. Kept for the same reason
/// `spawns_since` is: the guard is parked rather than abandoned, and the rows it
/// reads are still written by every spawn. It is also the plainest way to ask
/// "was this card opened by an agent", which is the question the `spawned` table
/// exists to be able to answer months later.
pub fn was_spawned(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM spawned WHERE child_id = ?1",
        params![id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Who opened this card, if anybody did.
pub fn spawner_of(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT parent_id FROM spawned WHERE child_id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Has the user set this card aside?
///
/// Read by `spawn::close`, which refuses to tidy one away: setting a card aside
/// is the user saying "I am coming back to this", and it is the one thing on a
/// card that is an explicit human intention rather than a fact about the work.
/// An agent closing it would be the app overruling the person quietly. Missing
/// rows answer `false` — a card that is not there is not one anybody parked.
pub fn is_aside(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT aside FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(0)
        != 0
}

/// Every parentage with both ends still on the wall, as `(child, parent)`.
///
/// Two joins rather than one, because a root has two ends and a row survives
/// both of them: the table is deliberately never swept, so it holds pairs whose
/// parent was closed months ago. The front end drops what it cannot draw as
/// well (`lineage.ts::familiesOf` needs a box for each end), and this is the
/// same filter one layer earlier — the wall should not be handed rows it will
/// only throw away, once per launch, for every card that ever existed.
pub fn lineage(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.child_id, s.parent_id
               FROM spawned s
               JOIN conversation c ON c.id = s.child_id
               JOIN conversation p ON p.id = s.parent_id
              WHERE c.closed_at IS NULL AND p.closed_at IS NULL
              ORDER BY s.at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// How many of this card's children are still on the wall.
///
/// A join to `conversation`, so a child that has been closed stops counting and
/// one whose spawn never drew was never counted: this answers *what is standing*
/// rather than what has ever been started, and `spawns_since` below is what
/// notices the ones that never arrived.
///
/// It was the live cap's question first (`spawn::MAX_LIVE`, now off) and is kept
/// for the receipt `close` hands back — a card that has just tidied one away is
/// told how many of its own are left, which is the number it would otherwise
/// call `list` to count.
pub fn live_children_of(conn: &Connection, parent_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM spawned s
           JOIN conversation c ON c.id = s.child_id
          WHERE s.parent_id = ?1 AND c.closed_at IS NULL",
        params![parent_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// How many spawns this card has asked for since a moment, drawn or not.
///
/// **No caller at the moment** — `spawn::MAX_PER_HOUR` is off — and kept rather
/// than deleted, because the rate is parked rather than abandoned and the rows it
/// counts are still written. Asks rather than cards is the whole point of it: a
/// spawn that silently never drew is exactly the loop a rate limit is for, and it
/// leaves a row here and no card anywhere.
pub fn spawns_since(conn: &Connection, parent_id: &str, since: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM spawned WHERE parent_id = ?1 AND at >= ?2",
        params![parent_id, since],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

pub fn inbox_counts(conn: &Connection) -> Vec<(String, i64)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT to_id, COUNT(*) FROM relay WHERE delivered_at IS NULL GROUP BY to_id",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

#[cfg(test)]
mod tests {
    /// The staged path is repository-relative with forward slashes; the stored
    /// one is whatever a tool call named, which on this machine is an absolute
    /// Windows path. Both come through `board::normalize` first.
    #[test]
    fn a_stored_touch_is_matched_to_the_file_git_named() {
        let stored = crate::board::normalize("C:\\Users\\x\\workbench\\skein\\src\\lib\\store.rs");
        assert!(same_file(&stored, &crate::board::normalize("src/lib/store.rs")));
        assert!(same_file(&stored, &crate::board::normalize("lib/store.rs")));
        assert!(same_file(&stored, &crate::board::normalize("store.rs")));

        /* Anchored at a separator: the trap `board::covers` already records. */
        assert!(!same_file(&stored, &crate::board::normalize("re.rs")));
        assert!(!same_file(&stored, &crate::board::normalize("ore.rs")));

        /* A different file whose name merely ends the same way. */
        assert!(!same_file(&stored, &crate::board::normalize("src/lib/other.rs")));

        /* A relative tool call, which is what `Edit` on a typed path produces. */
        assert!(same_file(
            &crate::board::normalize("src/lib/store.rs"),
            &crate::board::normalize("src/lib/store.rs")
        ));
    }

    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn seed_project(conn: &Connection, id: &str, path: &str) {
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?1, ?2, 0)",
            params![id, path],
        )
        .unwrap();
    }

    #[test]
    fn sniff_image_names_the_format_from_the_bytes() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("png"));
        assert_eq!(sniff_image(b"\xff\xd8\xff\xe0JFIF"), Some("jpg"));
        assert_eq!(sniff_image(b"GIF89a\x01\x00"), Some("gif"));
        assert_eq!(sniff_image(b"BM\x36\x00\x00\x00"), Some("bmp"));
        assert_eq!(sniff_image(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image(b"\x00\x00\x00\x20ftypavif\x00\x00"), Some("avif"));

        /* A RIFF that is not an image, and a clipboard holding text: both are
           "nothing to draw" rather than a file to write with a wrong name. */
        assert_eq!(sniff_image(b"RIFF\x24\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_image(b"hello from the clipboard"), None);
        assert_eq!(sniff_image(b""), None);

        /* Short enough that the container checks would index out of bounds if
           they read the brand before checking the length. */
        assert_eq!(sniff_image(b"RIFF"), None);
        assert_eq!(sniff_image(b"\x00\x00\x00\x20ftyp"), None);
    }

    /* ── standing instructions (v23) ──────────────────────────────────── */

    /// The wall's, and the shape every reader depends on: a studio nobody has
    /// set instructions on answers the empty string rather than failing, since
    /// that is what "nothing to say" is everywhere else in this subsystem.
    #[test]
    fn a_wall_with_no_instructions_says_nothing() {
        let conn = db();
        assert_eq!(wall_guidance(&conn), "");
    }

    /// One wall, so writing twice leaves one row — the `CHECK (id = 1)` is the
    /// schema saying so and the upsert is honouring it. The same invariant
    /// `saving_the_cycle_twice_leaves_one_row` pins one table over.
    #[test]
    fn the_wall_keeps_one_set_of_instructions() {
        let conn = db();
        let put = |t: &str| {
            conn.execute(
                "INSERT INTO wall_guidance (id, instructions, updated_at) VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET instructions = ?1, updated_at = ?2",
                params![t, 0],
            )
            .unwrap();
        };
        put("call me Lyss");
        put("call me Lyss, and keep it short");

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM wall_guidance", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the wall grew a second set of instructions");
        assert_eq!(wall_guidance(&conn), "call me Lyss, and keep it short");
    }

    /// What `spawn_now` actually asks for, both halves at once.
    #[test]
    fn a_card_is_told_the_walls_and_its_own_territorys() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, agent_session_id, project_id, cwd, born_at)
             VALUES ('c1', 'c1', 'p1', 'C:/x', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wall_guidance (id, instructions, updated_at) VALUES (1, 'wall says', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE project SET instructions = 'project says' WHERE id = 'p1'",
            [],
        )
        .unwrap();

        assert_eq!(
            guidance_rows(&conn, "c1"),
            ("wall says".to_string(), "project says".to_string())
        );

        /* A card this wall has never heard of still gets the wall's. The
           alternative — refusing both — would make one unknown id cost a spawn
           the instructions every other card on the wall gets. */
        assert_eq!(
            guidance_rows(&conn, "nobody"),
            ("wall says".to_string(), String::new())
        );
    }

    /// Forgetting a territory takes its instructions with it, by the cascade
    /// that is already there — which is the whole reason they live on the
    /// project row rather than in a table of their own.
    #[test]
    fn forgetting_a_project_forgets_what_it_told_its_cards() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute("UPDATE project SET instructions = 'read only' WHERE id = 'p1'", [])
            .unwrap();
        conn.execute("DELETE FROM project WHERE id = 'p1'", []).unwrap();

        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project WHERE instructions = 'read only'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    /// v23 has to land on a database that already exists, and the column has to
    /// arrive filled rather than NULL — every project that predates this said
    /// nothing, which is the right answer for all of them and is also the only
    /// one `guidance_rows`' `String` column can read.
    #[test]
    fn an_existing_database_gains_instructions_that_are_not_null() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES ('old','old','C:/old',0)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let text: String = conn
            .query_row("SELECT instructions FROM project WHERE id = 'old'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(text, "");
        assert_eq!(wall_guidance(&conn), "");
    }

    #[test]
    fn migrate_stamps_a_version_and_is_idempotent() {
        let conn = db();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // Running it again must not throw or reset anything.
        migrate(&conn).unwrap();
        let v2: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, SCHEMA_VERSION);
    }

    /// The ladder is walked one rung at a time and the stamp rides with the
    /// rung, so at no point does the version name a schema the file does not
    /// have. Checked by walking a fresh database up from zero and asserting the
    /// stamp after each step, which is the invariant a crash between two rungs
    /// depends on.
    #[test]
    fn every_rung_lands_with_its_own_number() {
        for stop in 0..=SCHEMA_VERSION {
            let conn = Connection::open_in_memory().unwrap();
            /* Walk to `stop` by hand, the way `migrate` would have if this
               build's SCHEMA_VERSION were `stop`. */
            for (n, step) in STEPS.iter().take(stop as usize) {
                step(&conn).unwrap();
                conn.pragma_update(None, "user_version", n).unwrap();
            }
            let v: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, stop, "stopping after {stop} rungs must read as v{stop}");

            // And from there the rest of the ladder runs, exactly once each.
            migrate(&conn).unwrap();
            let v: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, SCHEMA_VERSION);
        }
    }

    /// The bug this whole arrangement exists for, in the state it was actually
    /// found in: `user_version` at 9 on a database already carrying v11's
    /// column and v12's table, because the old `migrate` stamped once at the end
    /// and the steps before it had already committed.
    ///
    /// The old code failed here with `duplicate column name: kind` — and failed
    /// again on every launch after, since the failure was in the recovery path.
    /// The wall it happened on had twenty cards and 342 turns on it.
    #[test]
    fn a_database_whose_stamp_fell_behind_its_schema_walks_itself_out() {
        let conn = Connection::open_in_memory().unwrap();
        for (_, step) in STEPS.iter().take(12) {
            step(&conn).unwrap();
        }
        // Every rung to v12 applied, and the stamp left where the crash left it.
        conn.pragma_update(None, "user_version", 9).unwrap();

        migrate(&conn).expect("a stamp behind its schema must be recoverable");

        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // Including the rung that never got to run.
        assert!(has_column(&conn, "conversation", "named_by_hand").unwrap());
        // And the re-run columns are single, not doubled or dropped.
        assert!(has_column(&conn, "conversation", "kind").unwrap());
    }

    /// A file from a newer build is refused rather than stamped down to this
    /// one's number, which would hand the newer build a database claiming a
    /// schema older than its contents — the same wedge one direction over.
    #[test]
    fn a_database_from_a_newer_build_is_refused_not_downgraded() {
        let conn = db();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 4)
            .unwrap();

        let err = migrate(&conn).expect_err("a newer schema must not be walked backwards");
        assert!(err.contains("newer Skein"), "{err}");

        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION + 4, "the stamp must be left alone");
    }

    /// Adding a column that is already there is the step already having run, not
    /// an error — which is what makes a rung safe to re-run.
    #[test]
    fn add_column_is_a_no_op_when_the_column_is_there() {
        let conn = db();
        assert!(has_column(&conn, "conversation", "aside").unwrap());
        add_column(&conn, "conversation", "aside", "INTEGER NOT NULL DEFAULT 0").unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('conversation') WHERE name = 'aside'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        assert!(!has_column(&conn, "conversation", "no_such_column").unwrap());
    }

    #[test]
    fn the_schema_carries_the_columns_lazy_restore_depends_on() {
        let conn = db();
        let mut stmt = conn.prepare("PRAGMA table_info(conversation)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        // A dormant card shows what it reached without spawning anything.
        assert!(cols.contains(&"last_ctx_frac".to_string()));
        assert!(cols.contains(&"last_ending".to_string()));
        assert!(cols.contains(&"interrupted".to_string()));
        // Identity stays separate from the agent's own session handle.
        assert!(cols.contains(&"agent_session_id".to_string()));
        // A card put by stays put by across a launch — the rousing queue reads
        // this before it spawns anything.
        assert!(cols.contains(&"aside".to_string()));
    }

    /// The whole risk in migration v6 is the default: every row that existed
    /// before the column did is a card nobody has set aside, and a NULL there
    /// would come back through `load_studio` as neither true nor false.
    #[test]
    fn a_card_nobody_has_put_by_reads_as_such() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let aside: i64 = conn
            .query_row("SELECT aside FROM conversation WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(aside, 0);
    }

    /// The four absences `account_of` flattens, and the one presence it does
    /// not. Each row here reddens a different edit: dropping the `.flatten()`
    /// breaks the NULL case, dropping the `.filter` breaks the two empty ones,
    /// dropping the `.ok()` breaks the unknown id, and returning `None`
    /// unconditionally breaks the label case.
    ///
    /// Why it matters that all four collapse to `None`: the caller hands the
    /// result straight to `limits::token`, which reads an empty label as the
    /// CLI's own sign-in. A NULL that arrived as `Some("")` would ask about the
    /// global account and *say* it was asking about a named one.
    #[test]
    fn a_cards_account_is_its_own_or_nothing() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["null", "empty", "blank", "named"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        let set = |id: &str, v: Option<&str>| {
            conn.execute(
                "UPDATE conversation SET account_label = ?2 WHERE id = ?1",
                params![id, v],
            )
            .unwrap();
        };
        set("empty", Some(""));
        set("blank", Some("   "));
        set("named", Some("work"));

        /* The column defaults to NULL, which is every card that existed before
           accounts did — the case the bug shipped on. */
        assert_eq!(account_of(&conn, "null"), None);
        assert_eq!(account_of(&conn, "empty"), None);
        assert_eq!(account_of(&conn, "blank"), None);

        /* A card that really is on an account gets its name back, untrimmed
           only because nothing writes a padded one — the filter judges on the
           trim and returns the stored string. */
        assert_eq!(account_of(&conn, "named").as_deref(), Some("work"));

        /* An id no row answers to. The MCP tool is handed a conversation id off
           a URL, so this is reachable: a card closed between spawning its
           request and the request arriving. */
        assert_eq!(account_of(&conn, "no-such-card"), None);
    }

    /// It goes both ways, which is the thing a COALESCEd column can normally
    /// only half-do — see the note on `update_conversation`. Nothing here ever
    /// means "put it back to the default", so an explicit false is enough.
    #[test]
    fn setting_a_card_aside_and_picking_it_back_up_both_land() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let set = |v: bool| {
            conn.execute(
                "UPDATE conversation SET aside = COALESCE(?2, aside) WHERE id = ?1",
                params!["c1", Some(v)],
            )
            .unwrap();
            conn.query_row::<i64, _, _>(
                "SELECT aside FROM conversation WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        assert_eq!(set(true), 1);
        assert_eq!(set(false), 0);

        // And an absent argument leaves whatever is there alone, so a settling
        // turn writing its context fraction cannot quietly pick a card back up.
        conn.execute(
            "UPDATE conversation SET aside = COALESCE(?2, aside) WHERE id = ?1",
            params!["c1", None::<bool>],
        )
        .unwrap();
        let after: i64 = conn
            .query_row("SELECT aside FROM conversation WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(after, 0);
    }

    /// Clearing swaps the session and keeps the card. The distinction is the
    /// whole feature: placements, turns and file touches all key on `id`, so an
    /// id that changed would leave the card standing somewhere else with none
    /// of its history attached.
    #[test]
    fn clearing_repoints_the_row_without_moving_the_card() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "s1", "p1", "C:/x", Some("some work"), None, Some(0.8), None).unwrap();
        conn.execute(
            "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('s1', 40, 90, 1)",
            [],
        )
        .unwrap();

        clear_row(&conn, "s1", "s2").unwrap();

        let (session, title, frac, ending, interrupted): (
            String,
            String,
            f64,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT agent_session_id, title, last_ctx_frac, last_ending, interrupted
                   FROM conversation WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(session, "s2", "the card is still pointed at the old session");
        assert_eq!(title, "untitled", "the next prompt has to be able to name it");
        assert_eq!(frac, 0.0, "a fresh session holds no context");
        /* NULL, not 'ok': the front end reads NULL as "never spoke" and only
           then spawns with --session-id. Left as 'ok' the card would wake with
           --resume against a transcript that does not exist. */
        assert_eq!(ending, None);
        assert_eq!(interrupted, 0);

        let pinned: (f64, f64, i64) = conn
            .query_row(
                "SELECT x, y, pinned FROM placement WHERE conversation_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(pinned, (40.0, 90.0, 1), "clearing moved the card off its pin");
    }

    #[test]
    fn clearing_a_card_that_is_not_there_says_so() {
        let conn = db();
        assert!(clear_row(&conn, "ghost", "s2").is_err());
    }

    /// The column `/rename` exists for. Without it the rename survives exactly
    /// one turn: `#adoptAiTitle` runs at every settling `result`, reads the
    /// transcript's generated title, finds it different and puts it back.
    #[test]
    fn a_name_given_by_hand_is_marked_and_a_settling_turn_leaves_it_alone() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "c1", "p1", "C:/x", Some("read the auth code"), None, None, None)
            .unwrap();

        // Nothing was named by hand before there was a way to do it.
        let flagged: i64 = conn
            .query_row(
                "SELECT named_by_hand FROM conversation WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flagged, 0);

        // The rename, as `Skein.rename` sends it.
        conn.execute(
            "UPDATE conversation SET
               title         = COALESCE(?2, title),
               named_by_hand = COALESCE(?3, named_by_hand)
             WHERE id = ?1",
            params!["c1", Some("the auth work"), Some(true)],
        )
        .unwrap();

        // And a settling turn afterwards, which names every column but these.
        conn.execute(
            "UPDATE conversation SET
               title         = COALESCE(?2, title),
               last_ctx_frac = COALESCE(?3, last_ctx_frac),
               named_by_hand = COALESCE(?4, named_by_hand)
             WHERE id = ?1",
            params!["c1", None::<String>, Some(0.4), None::<bool>],
        )
        .unwrap();

        let (title, flagged, frac): (String, i64, f64) = conn
            .query_row(
                "SELECT title, named_by_hand, last_ctx_frac FROM conversation WHERE id = 'c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "the auth work");
        assert_eq!(flagged, 1, "the mark that stops the title being replaced");
        assert_eq!(frac, 0.4, "the rest of the turn still settled");
    }

    /// Clearing is the one thing that unsets it, and it has to: the title it
    /// protects goes back to the sentinel in the same statement, so a flag left
    /// standing would be a card refusing every name it could ever be given.
    #[test]
    fn clearing_forgets_that_the_card_was_named_by_hand() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "s1", "p1", "C:/x", Some("the auth work"), None, None, None).unwrap();
        conn.execute(
            "UPDATE conversation SET named_by_hand = 1 WHERE id = 's1'",
            [],
        )
        .unwrap();

        clear_row(&conn, "s1", "s2").unwrap();

        let (title, flagged): (String, i64) = conn
            .query_row(
                "SELECT title, named_by_hand FROM conversation WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "untitled");
        assert_eq!(flagged, 0, "a cleared card would refuse to be named again");
    }

    /// The v2 repair: a card that has turns behind it must come back resumable.
    #[test]
    fn the_backfill_marks_conversations_that_spoke_and_leaves_the_silent_ones_alone() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Start from a v1 database, as an existing install would.
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        for id in ["spoke", "silent"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO turn (conversation_id, ended_at, status_tier) VALUES ('spoke', 0, 'rest')",
            [],
        )
        .unwrap();

        migrate_v2(&conn).unwrap();

        let ending = |id: &str| -> Option<String> {
            conn.query_row(
                "SELECT last_ending FROM conversation WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        // everSpoke is read off this column, and decides --resume vs --session-id.
        assert_eq!(ending("spoke").as_deref(), Some("ok"));
        assert_eq!(ending("silent"), None, "a card that never spoke has nothing to resume");
    }

    /// The day's figure: everything the wall spent since the cutoff, whoever
    /// spent it and whether or not that card is still open.
    #[test]
    fn the_days_spend_sums_every_turn_past_the_cutoff() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["open", "closed"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        // A card closed this afternoon still spent what it spent this morning.
        conn.execute(
            "UPDATE conversation SET closed_at = 500 WHERE id = 'closed'",
            [],
        )
        .unwrap();
        let turn = |id: &str, at: i64, usd: f64| {
            conn.execute(
                "INSERT INTO turn (conversation_id, ended_at, status_tier, usd)
                 VALUES (?1, ?2, 'rest', ?3)",
                params![id, at, usd],
            )
            .unwrap();
        };
        turn("open", 50, 1.0); // yesterday
        turn("open", 100, 2.0); // exactly on the boundary — the day owns its own midnight
        turn("open", 150, 0.5);
        turn("closed", 200, 0.25);

        assert_eq!(spend_row(&conn, 100).unwrap(), 2.75);
        assert_eq!(spend_row(&conn, 0).unwrap(), 3.75, "the whole table");
        assert_eq!(
            spend_row(&conn, 900).unwrap(),
            0.0,
            "a day with nothing in it yet is zero, not an error"
        );
    }

    /// The v25 split must not touch the figure it is drawn from. On this wall's
    /// own table, 2026-08-22 holds exactly two no-token rows — $71.31 and
    /// $38.64 — and they are the whole of that day: $109.95 out of $109.95. A
    /// `WHERE kind = 'turn'` in `spend_row` would report that day as free.
    #[test]
    fn the_days_spend_counts_a_spend_row_exactly_like_a_turn() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();
        let row = |at: i64, kind: &str, usd: f64| {
            conn.execute(
                "INSERT INTO turn (conversation_id, ended_at, status_tier, kind, usd)
                 VALUES ('c1', ?1, 'rest', ?2, ?3)",
                params![at, kind, usd],
            )
            .unwrap();
        };
        row(100, "spend", 71.31);
        row(200, "spend", 38.64);

        assert_eq!(
            (spend_row(&conn, 0).unwrap() * 100.0).round(),
            10995.0,
            "the day was entirely spend rows, and it still cost what it cost"
        );

        row(300, "turn", 10.0);
        row(400, "unknown", 5.0);
        assert_eq!(
            (spend_row(&conn, 0).unwrap() * 100.0).round(),
            12495.0,
            "every kind of row, including the label this build did not write"
        );
    }

    /// A rung either lands with its number or does not land at all, and
    /// `add_column` is what lets a database whose version fell behind its
    /// schema walk itself out. So the rung must survive being run twice — the
    /// wedge `migrate` describes is exactly a step being re-run.
    #[test]
    fn the_kind_rung_is_safe_to_run_again() {
        let conn = db();
        // `db()` has already walked the whole ladder, so this is the re-run.
        migrate_v25(&conn).unwrap();
        migrate_v25(&conn).unwrap();
        assert!(has_column(&conn, "turn", "kind").unwrap());
    }

    /// Every row already on disk predates the column, and the default must not
    /// assert what those rows were. 101 of the 696 rows written on this machine
    /// since `migrate_v7` carry no tokens, and some of them are precisely the
    /// rows the column exists to distinguish — so `'turn'` would have been a
    /// new lie in place of the old one, and there is nothing to backfill from.
    #[test]
    fn rows_that_predate_the_column_say_unknown_rather_than_claiming_to_be_turns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();
        // A row from before the column existed: a real turn, and one of the
        // zero-token ones. Nothing on disk can tell them apart.
        conn.execute(
            "INSERT INTO turn (conversation_id, ended_at, status_tier, usd)
             VALUES ('c1', 0, 'rest', 13.52)",
            [],
        )
        .unwrap();

        migrate_v25(&conn).unwrap();

        let kind: String = conn
            .query_row("SELECT kind FROM turn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kind, "unknown");
        let usd: f64 = conn
            .query_row("SELECT usd FROM turn", [], |r| r.get(0))
            .unwrap();
        assert_eq!(usd, 13.52, "a relabelling is never a deletion");
    }

    /// Tauri drops a key it does not recognise — the `lastTier` bug — and a
    /// required `String` would then fail the whole command, whose caller
    /// swallows errors: no row, and the money gone from the day's figure. A
    /// label that does not arrive must cost a label and never a row.
    #[test]
    fn a_label_that_did_not_arrive_costs_a_label_and_not_a_row() {
        assert_eq!(row_kind(Some("turn")), "turn");
        assert_eq!(row_kind(Some("spend")), "spend");
        assert_eq!(row_kind(None), "unknown");
        assert_eq!(row_kind(Some("")), "unknown");
        assert_eq!(row_kind(Some("trun")), "unknown", "a typo reads as untrue, not as a turn");
        assert_eq!(row_kind(Some("Turn")), "unknown");
    }

    #[test]
    fn the_backfill_never_overwrites_an_ending_we_actually_know() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, last_ending)
             VALUES ('c1','p1','C:/x',0,'error')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO turn (conversation_id, ended_at, status_tier) VALUES ('c1', 0, 'fail')",
            [],
        )
        .unwrap();

        migrate_v2(&conn).unwrap();

        let ending: String = conn
            .query_row("SELECT last_ending FROM conversation WHERE id='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ending, "error", "a real ending was flattened to ok");
    }

    /// An adopted CLI session must wake with `--resume`, and the only thing
    /// that decides that is a non-NULL `last_ending` — `restore` reads NULL as
    /// "never spoke", and a fresh `--session-id` on an id that already has a
    /// transcript collides instead of resuming.
    #[test]
    fn an_imported_session_is_restorable_and_resumable() {
        let conn = db();
        seed_project(&conn, "p1", "C:/atelier/caravan");
        import_row(
            &conn,
            "0f3bbb4e",
            "p1",
            "C:/atelier/caravan",
            Some("Set default sweep behavior"),
            Some("claude-opus-5"),
            Some(0.23),
            Some(1_700_000_000_000),
        )
        .unwrap();

        let (title, ending, born, frac): (String, Option<String>, i64, f64) = conn
            .query_row(
                "SELECT title, last_ending, born_at, last_ctx_frac FROM conversation WHERE id='0f3bbb4e'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Set default sweep behavior");
        assert_eq!(ending.as_deref(), Some("ok"), "would wake as a fresh session");
        // Age comes off the transcript, not off the moment it was adopted.
        assert_eq!(born, 1_700_000_000_000);
        assert_eq!(frac, 0.23);
    }

    /// Forgetting is the deliberate counterpart to a territory surviving its
    /// last card, so it must not be possible to do it to a project that is
    /// plainly still in use.
    #[test]
    fn a_project_with_something_open_cannot_be_forgotten() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let refused = forget_row(&conn, "C:/x").unwrap_err();
        assert!(refused.contains("still open"), "unhelpful refusal: {refused}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the project was forgotten anyway");
    }

    /// Closed conversations go with it — the rows, not the transcripts, which
    /// stay on disk and can be adopted back.
    #[test]
    fn forgetting_an_empty_project_takes_its_history_with_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('c1','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        assert_eq!(forget_row(&conn, "C:/x"), Ok(true));
        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))
            .unwrap();
        let convs: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!((projects, convs), (0, 0));
    }

    #[test]
    fn forgetting_something_that_was_never_there_is_not_an_error() {
        let conn = db();
        assert_eq!(forget_row(&conn, "C:/never"), Ok(false));
    }

    /// Closing a card leaves the row behind, so adopting the same session again
    /// has to put it back on the wall rather than quietly do nothing.
    #[test]
    fn importing_something_closed_brings_it_back() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "c1", "p1", "C:/x", Some("first"), None, None, None).unwrap();
        conn.execute("UPDATE conversation SET closed_at = 1 WHERE id = 'c1'", [])
            .unwrap();

        import_row(&conn, "c1", "p1", "C:/x", Some("later"), None, None, None).unwrap();

        let (closed, title): (Option<i64>, String) = conn
            .query_row(
                "SELECT closed_at, title FROM conversation WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(closed, None, "re-adopting left the card off the wall");
        assert_eq!(title, "later");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "adoption duplicated the conversation");
    }

    /// A card that has been worked in since it was adopted knows more about
    /// itself than the transcript scan does, so re-adopting must not blank it.
    #[test]
    fn re_importing_does_not_overwrite_what_the_card_already_knows() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(
            &conn,
            "c1",
            "p1",
            "C:/x",
            Some("titled"),
            Some("claude-opus-5"),
            Some(0.5),
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE conversation SET last_ending = 'question' WHERE id = 'c1'",
            [],
        )
        .unwrap();

        import_row(&conn, "c1", "p1", "C:/x", None, None, None, None).unwrap();

        let (title, model, frac, ending): (String, String, f64, String) = conn
            .query_row(
                "SELECT title, model, last_ctx_frac, last_ending FROM conversation WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "titled");
        assert_eq!(model, "claude-opus-5");
        assert_eq!(frac, 0.5);
        assert_eq!(ending, "question", "a known ending was reset to a guess");
    }

    #[test]
    fn closing_a_conversation_removes_it_from_the_wall_without_deleting_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 1);

        conn.execute("UPDATE conversation SET closed_at = 1 WHERE id = 'c1'", [])
            .unwrap();

        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 0);
        // The history is still there — closing a card is not forgetting it.
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
    }

    /// Shutdown marks what was *running*, not everything still on the wall.
    ///
    /// The bug: `WHERE closed_at IS NULL` also matches every dormant card
    /// restored from a previous session and never woken. Quitting cleanly flagged
    /// the whole wall, so the next launch had every card claiming its last turn
    /// was interrupted — including ones nobody had spoken to in days.
    #[test]
    fn shutdown_marks_only_the_conversations_that_were_actually_running() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["live", "dormant"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('done','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        /* Only `live` had a child in the supervisor. `done` is passed too, to
           show the closed_at guard holds even if a stale id turns up. */
        mark_interrupted(&conn, &["live".to_string(), "done".to_string()]);

        let flag = |id: &str| -> i64 {
            conn.query_row(
                "SELECT interrupted FROM conversation WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(flag("live"), 1, "a card mid-turn at shutdown lost that turn");
        assert_eq!(flag("dormant"), 0, "a card that was never woken lost nothing");
        assert_eq!(flag("done"), 0, "a card already closed was not mid-turn");
    }

    /// A root has two ends and the table has neither of them: rows outlive both
    /// cards on purpose, since the value of a lineage is answering "was this
    /// opened by an agent" months later. So what the wall can *draw* is the
    /// narrower question, and it is asked here rather than by handing the front
    /// end every pair that ever existed and letting it throw most of them away.
    #[test]
    fn the_lineage_drawn_is_the_pairs_with_both_ends_still_open() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["parent", "kid", "orphan", "bereaved"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('shut','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        /* And what `close` reads of a card before tidying it away. Default 0,
           so a card nobody parked is closeable and a missing row is not
           somebody's parked card. */
        assert!(!is_aside(&conn, "kid"));
        assert!(!is_aside(&conn, "nobody-at-all"));
        let park = |v: i64| {
            conn.execute("UPDATE conversation SET aside = ?1 WHERE id = 'kid'", params![v])
                .unwrap();
        };
        park(1);
        assert!(is_aside(&conn, "kid"));
        park(0);
        assert!(!is_aside(&conn, "kid"));

        record_spawn(&conn, "kid", "parent").unwrap();
        /* A child whose parent has been closed, and a parent whose child has —
           the two halves of the same filter, and both are ordinary. */
        record_spawn(&conn, "orphan", "shut").unwrap();
        record_spawn(&conn, "shut", "bereaved").unwrap();

        assert_eq!(
            lineage(&conn).unwrap(),
            vec![("kid".to_string(), "parent".to_string())]
        );
        /* And the rows are all still there, which is the point of the filter
           being in the query rather than in a sweep. */
        assert_eq!(spawner_of(&conn, "orphan").as_deref(), Some("shut"));
        assert!(was_spawned(&conn, "shut"));
    }

    /// The bug this covers: the flag was only ever written at `ExitRequested`,
    /// so it recorded "the app was *asked* to close mid-turn". A crash asks
    /// nothing — nothing ran, nothing was written, and the wall came back from
    /// the one exit that really does lose work with every card looking clean and
    /// nothing for rousing to resume. Written at the boundaries instead, the row
    /// is already true before the crash, so surviving it takes no code at all.
    #[test]
    fn a_turn_marks_its_row_as_it_opens_and_clears_it_as_it_settles() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c','p1','C:/x',0)",
            [],
        )
        .unwrap();
        let flag = || -> i64 {
            conn.query_row("SELECT interrupted FROM conversation WHERE id='c'", [], |r| {
                r.get(0)
            })
            .unwrap()
        };

        set_mid_turn(&conn, "c", true);
        assert_eq!(flag(), 1, "kill the app here and the turn is lost");
        set_mid_turn(&conn, "c", false);
        assert_eq!(flag(), 0, "a turn that reached its result lost nothing");
    }

    /// A card on its way off the wall is not a card with work standing still —
    /// the same guard `mark_interrupted` has always had, and it has to hold on
    /// the hot path too, since `close_conversation` and the reader thread that
    /// notices the child go both run at once.
    #[test]
    fn a_closed_card_is_not_marked_mid_turn() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('gone','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        set_mid_turn(&conn, "gone", true);

        let flag: i64 = conn
            .query_row("SELECT interrupted FROM conversation WHERE id='gone'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(flag, 0);
    }

    /// Every flag stored before v10 was written by a shutdown that counted
    /// processes rather than turns, and rousing gives every card a process — so
    /// they are cleared wholesale rather than trusted.
    #[test]
    fn v10_clears_the_flags_the_old_shutdown_wrote() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, interrupted)
             VALUES ('resting','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        migrate_v10(&conn).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE interrupted = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "a resting card would be sent a resume prompt at launch");
    }

    /// Every row that existed before the column did is a project card, and the
    /// default has to say so — a v11 that left `kind` NULL would leave
    /// `kind_of` reading NULL for the whole wall.
    #[test]
    fn v11_gives_every_existing_card_the_kind_it_already_had() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        /* Start from a database that predates the column, as an install would. */
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('old','p1','C:/x',0)",
            [],
        )
        .unwrap();

        migrate_v11(&conn).unwrap();

        assert_eq!(kind_row(&conn, "old"), "project");
    }

    /// The same shape v11 has, and the default is the truth for the same
    /// reason: a card written before `/rename` existed cannot have been named
    /// by hand, so every existing row arrives at the one value that lets Claude
    /// Code's generated title go on replacing it exactly as it always did.
    #[test]
    fn v13_leaves_every_existing_card_open_to_being_titled() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('old','p1','C:/x',0)",
            [],
        )
        .unwrap();

        migrate_v13(&conn).unwrap();

        let flagged: i64 = conn
            .query_row(
                "SELECT named_by_hand FROM conversation WHERE id = 'old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flagged, 0);
    }

    /// The store is what the argv is built from, so this is the whole of what
    /// makes a chat card one.
    #[test]
    fn a_recorded_kind_is_what_comes_back_out() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "talk", "p1", "C:/x", None, Some("chat"), None, None).unwrap();
        record_row(&conn, "work", "p1", "C:/x", None, None, None, None).unwrap();

        assert_eq!(kind_row(&conn, "talk"), "chat");
        assert_eq!(
            kind_row(&conn, "work"),
            "project",
            "a caller that says nothing means the card it has always meant"
        );
    }

    /// A preset is a row, and the row is what the next spawn reads. The wake
    /// tomorrow morning is the case this exists for: nothing passes a model in
    /// there, so a preset that lived in the open call alone would hold for
    /// exactly one process.
    #[test]
    fn a_card_opened_from_a_preset_is_set_up_the_same_way_at_every_spawn() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "deep", "p1", "C:/x", None, None, Some("opus[1m]"), Some("max"))
            .unwrap();
        record_row(&conn, "plain", "p1", "C:/x", None, None, None, None).unwrap();

        assert_eq!(
            setup_row(&conn, "deep"),
            (Some("opus[1m]".into()), Some("max".into()))
        );
        assert_eq!(
            setup_row(&conn, "plain"),
            (None, None),
            "a plain click means whatever Claude Code is configured for"
        );
        assert_eq!(
            setup_row(&conn, "no-such-card"),
            (None, None),
            "and so does an id with no row at all"
        );
    }

    /// The third thing the argv is built from, and the one that used to travel
    /// as an argument — `open` passed it, `wake` passed null, and a card on a
    /// branch came back in the main tree for it.
    #[test]
    fn the_tree_a_card_works_in_comes_off_its_row() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "branched", "p1", "C:/x", Some("feat/async-auth"), None, None, None)
            .unwrap();
        record_row(&conn, "plain", "p1", "C:/x", None, None, None, None).unwrap();
        record_row(&conn, "blank", "p1", "C:/x", Some("   "), None, None, None).unwrap();

        assert_eq!(worktree_row(&conn, "branched"), Some("feat/async-auth".into()));
        assert_eq!(worktree_row(&conn, "plain"), None);
        assert_eq!(
            worktree_row(&conn, "blank"),
            None,
            "whitespace is not a branch, and `ensure` would refuse it anyway"
        );
        assert_eq!(
            worktree_row(&conn, "no-such-card"),
            None,
            "an unknown id means the card every card without a worktree is"
        );
    }

    /// The pair every per-directory question about a card is asked with. The
    /// directory is where the child *runs*, which is the whole of the fix: the
    /// row's `cwd` is the territory, and the CLI files a session under the tree.
    #[test]
    fn a_card_is_looked_up_where_its_child_actually_stands() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "plain", "p1", "C:/x", None, None, None, None).unwrap();
        record_row(&conn, "branched", "p1", "C:/x", Some("feat/async-auth"), None, None, None)
            .unwrap();

        let (dir, session) = session_of(&conn, "plain").unwrap();
        assert_eq!(dir, "C:/x", "no branch, so the territory is where it stands");
        assert_eq!(
            session.as_deref(),
            Some("plain"),
            "the insert seeds the session with the card id"
        );

        let (dir, _) = session_of(&conn, "branched").unwrap();
        assert_eq!(
            dir,
            crate::worktree::dir_for("C:/x", "feat/async-auth").to_string_lossy(),
            "and this is the directory `ensure` puts the child in"
        );
        assert!(dir.contains("feat+async-auth"), "the CLI's folder spelling, kept");
    }

    /// The other half: what a settling turn learns replaces what the preset
    /// asked for, so the alias becomes the resolved id and a `/effort` mid
    /// session is what the next wake spawns with.
    #[test]
    fn what_the_card_is_seen_to_be_overwrites_what_it_was_opened_as() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "c1", "p1", "C:/x", None, None, Some("opus[1m]"), Some("max"))
            .unwrap();
        conn.execute(
            "UPDATE conversation SET
               model  = COALESCE(?2, model),
               effort = COALESCE(?3, effort)
             WHERE id = ?1",
            params!["c1", Some("claude-opus-5[1m]"), None::<String>],
        )
        .unwrap();

        assert_eq!(
            setup_row(&conn, "c1"),
            (Some("claude-opus-5[1m]".into()), Some("max".into())),
            "the resolved id round-trips through --model, and the untouched              column keeps the level the card was opened at"
        );
    }

    /// An id with no row answers `project`, and the direction matters: the
    /// unknown case must fall to the card the wall has always had, never to the
    /// one whose tools are gone. A chat card is only ever chat because a row
    /// says so — so a lost row costs a card its sandbox, loudly, rather than
    /// costing a working card its tools, silently.
    #[test]
    fn an_id_with_no_row_is_a_project_card() {
        let conn = db();
        assert_eq!(kind_row(&conn, "never-recorded"), "project");
    }

    #[test]
    fn marking_nothing_is_a_no_op_rather_than_a_wall_wide_update() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        // Quitting with nothing awake must not touch a single row.
        mark_interrupted(&conn, &[]);

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE interrupted = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn placements_survive_and_upsert_rather_than_duplicating() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        for (x, y) in [(10.0, 20.0), (99.0, 88.0)] {
            conn.execute(
                "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('c1', ?1, ?2, 1)
                 ON CONFLICT(conversation_id) DO UPDATE SET x = ?1, y = ?2, pinned = 1",
                params![x, y],
            )
            .unwrap();
        }

        let (n, x, y): (i64, f64, f64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(x), MAX(y) FROM placement WHERE conversation_id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(n, 1, "dragging a card twice must not make two placements");
        assert_eq!((x, y), (99.0, 88.0));
    }

    /// A territory is dragged, not flowed, once it has been moved once — so the
    /// position has to come back, and NULL has to keep meaning "the grid decides".
    #[test]
    fn a_territory_remembers_where_it_was_put_and_can_be_given_back_to_the_grid() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");

        let at = || -> (Option<f64>, Option<f64>) {
            conn.query_row("SELECT x, y FROM project WHERE root_path='C:/x'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(at(), (None, None), "a new project starts in the grid's hands");

        place_row(&conn, "C:/x", Some(1100.0), Some(560.0)).unwrap();
        assert_eq!(at(), (Some(1100.0), Some(560.0)));

        // Moved again — one row, not two positions.
        place_row(&conn, "C:/x", Some(20.0), Some(30.0)).unwrap();
        assert_eq!(at(), (Some(20.0), Some(30.0)));

        // "tidy it back onto the grid" is the same command with nothing in it.
        place_row(&conn, "C:/x", None, None).unwrap();
        assert_eq!(at(), (None, None));
    }

    /// The v3 columns have to land on databases that already exist, which is the
    /// whole reason a schema change is an ALTER and not a CREATE.
    #[test]
    fn an_existing_database_gains_the_territory_position_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");

        migrate(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(project)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(cols.contains(&"x".to_string()));
        assert!(cols.contains(&"y".to_string()));
        // An existing territory keeps flowing until somebody moves it.
        place_row(&conn, "C:/x", Some(7.0), Some(8.0)).unwrap();
    }

    /// The glass is beside the wall, never instead of it. This is the whole
    /// round trip the feature rests on: a territory stuck to the pane must come
    /// back off it standing exactly where it was packed, so the two positions
    /// have to be written and read independently.
    #[test]
    fn sticking_a_territory_leaves_its_place_on_the_wall_alone() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        place_row(&conn, "C:/x", Some(1100.0), Some(560.0)).unwrap();

        let at = || -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
            conn.query_row(
                "SELECT x, y, glass_x, glass_y FROM project WHERE root_path='C:/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
        };
        assert_eq!(at(), (Some(1100.0), Some(560.0), None, None));

        stick_row(&conn, "C:/x", Some(40.0), Some(90.0)).unwrap();
        assert_eq!(
            at(),
            (Some(1100.0), Some(560.0), Some(40.0), Some(90.0)),
            "sticking says nothing about where the territory belongs"
        );

        stick_row(&conn, "C:/x", None, None).unwrap();
        assert_eq!(
            at(),
            (Some(1100.0), Some(560.0), None, None),
            "and putting it back gives it its own cell, not a fresh one"
        );
    }

    /// v9 adds the same pair to four tables, and the one that would go unnoticed
    /// is `placement` — a card's glass spot is the only one whose absence looks
    /// exactly like a card nobody ever stuck.
    #[test]
    fn an_existing_database_gains_the_glass_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        for table in ["placement", "project", "reference_image", "widget"] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert!(cols.contains(&"glass_x".to_string()), "{table} has no glass_x");
            assert!(cols.contains(&"glass_y".to_string()), "{table} has no glass_y");
        }
    }

    /// A widget's glass spot rides on the same upsert as everything else about
    /// it, so taking one off the pane has to actually clear the columns rather
    /// than leave the old spot behind for the next launch to read back.
    #[test]
    fn a_widget_remembers_the_pane_and_forgets_it_again() {
        let conn = db();
        let mut w = widget("w1", "clock", serde_json::json!({}));
        w.glass_x = Some(120.0);
        w.glass_y = Some(64.0);
        save_widget_row(&conn, &w).unwrap();
        let got = &list_widget_rows(&conn).unwrap()[0];
        assert_eq!((got.glass_x, got.glass_y), (Some(120.0), Some(64.0)));
        assert_eq!((got.x, got.y), (10.0, 20.0), "the wall position is untouched");

        w.glass_x = None;
        w.glass_y = None;
        save_widget_row(&conn, &w).unwrap();
        let back = &list_widget_rows(&conn).unwrap()[0];
        assert_eq!((back.glass_x, back.glass_y), (None, None));
    }

    /* ── ambience ─────────────────────────────────────────────────────── */

    fn ambience(id: &str, name: &str, layers: serde_json::Value) -> AmbienceProfile {
        AmbienceProfile {
            id: id.to_string(),
            name: name.to_string(),
            layers,
            active: false,
        }
    }

    /// Rust holds the layer stack without understanding it, which is the whole
    /// bargain of the JSON column: a knob added in `ambience.ts` must survive a
    /// round trip through a build of Rust that has never heard of it.
    #[test]
    fn a_layer_stack_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let layers = serde_json::json!([
            { "id": "l1", "kind": "leaves", "on": true, "opacity": 0.8,
              "params": { "count": 12, "wind": -40.5, "somethingNewer": 3 } },
            { "id": "l2", "kind": "ripples", "on": false, "opacity": 1,
              "params": { "rate": 9 } }
        ]);
        save_ambience_row(&conn, &ambience("p1", "late october", layers.clone())).unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "late october");
        assert_eq!(got[0].layers, layers);
    }

    /// Every drag of a slider writes, so this is the hot path — and it must not
    /// disturb which profile is showing.
    #[test]
    fn adjusting_a_profile_updates_it_rather_than_making_another() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        activate_ambience_row(&conn, Some("p1")).unwrap();

        let mut edited = ambience("p1", "atelier", serde_json::json!([{ "kind": "swirls" }]));
        /* The front end sends the profile as it holds it; `active` is not its
           business, and a save must never be able to switch the wall. */
        edited.active = false;
        save_ambience_row(&conn, &edited).unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1, "editing a profile made a second one");
        assert_eq!(got[0].layers, serde_json::json!([{ "kind": "swirls" }]));
        assert!(got[0].active, "editing the showing profile stopped it showing");
    }

    #[test]
    fn exactly_one_profile_is_ever_showing() {
        let conn = db();
        for id in ["p1", "p2", "p3"] {
            save_ambience_row(&conn, &ambience(id, id, serde_json::json!([]))).unwrap();
        }
        let showing = |conn: &Connection| -> Vec<String> {
            list_ambience_rows(conn)
                .unwrap()
                .into_iter()
                .filter(|p| p.active)
                .map(|p| p.id)
                .collect()
        };

        activate_ambience_row(&conn, Some("p2")).unwrap();
        assert_eq!(showing(&conn), vec!["p2".to_string()]);

        activate_ambience_row(&conn, Some("p3")).unwrap();
        assert_eq!(showing(&conn), vec!["p3".to_string()]);

        // A bare wall is a real choice, not the absence of one.
        activate_ambience_row(&conn, None).unwrap();
        assert!(showing(&conn).is_empty());
    }

    /// The rollback matters: a stale id from a profile deleted in another window
    /// must leave the wall as it was rather than clearing it.
    #[test]
    fn activating_something_that_is_not_there_leaves_the_wall_alone() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        activate_ambience_row(&conn, Some("p1")).unwrap();

        assert!(activate_ambience_row(&conn, Some("gone")).is_err());

        let got = list_ambience_rows(&conn).unwrap();
        assert!(got[0].active, "a bad id blanked the wall on its way out");
    }

    /// The column is written by the front end and read by it too, so the shapes
    /// can only ever drift in one direction — but a row that will not parse must
    /// still list, or a profile becomes impossible to fix or delete.
    #[test]
    fn a_layer_column_that_will_not_parse_reads_as_an_empty_stack() {
        let conn = db();
        conn.execute(
            "INSERT INTO ambience_profile (id, name, layers_json, active, created_at)
             VALUES ('p1', 'broken', 'not json at all', 1, 0)",
            [],
        )
        .unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].layers, serde_json::json!([]));
        assert_eq!(got[0].name, "broken");
    }

    #[test]
    fn a_profile_can_be_thrown_away() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        conn.execute("DELETE FROM ambience_profile WHERE id = 'p1'", []).unwrap();
        assert!(list_ambience_rows(&conn).unwrap().is_empty());
    }

    /// v4 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step and not a `CREATE TABLE IF NOT EXISTS`
    /// somewhere on the read path.
    #[test]
    fn an_existing_database_gains_the_ambience_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        assert_eq!(list_ambience_rows(&conn).unwrap().len(), 1);
    }

    fn widget(id: &str, kind: &str, config: serde_json::Value) -> Widget {
        Widget {
            id: id.to_string(),
            kind: kind.to_string(),
            x: 10.0,
            y: 20.0,
            w: 200.0,
            h: 200.0,
            z: 3,
            glass_x: None,
            glass_y: None,
            config,
        }
    }

    /// The same bargain the layer stack has: Rust holds a widget's settings
    /// without understanding them, so a variant invented in `widgets.ts` must
    /// survive a round trip through a build that has never heard of it.
    #[test]
    fn a_widget_config_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let config = serde_json::json!({
            "variant": "something-newer", "seconds": false, "rows": 7
        });
        save_widget_row(&conn, &widget("w1", "clock", config.clone())).unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "clock");
        assert_eq!(got[0].config, config);
        assert_eq!(got[0].z, 3);
    }

    /// Moving one fires continuously, so the hot path must update rather than
    /// accumulate — the bug reference images had before their save was debounced.
    #[test]
    fn moving_a_widget_updates_it_rather_than_making_another() {
        let conn = db();
        save_widget_row(&conn, &widget("w1", "clock", serde_json::json!({}))).unwrap();
        let mut moved = widget("w1", "clock", serde_json::json!({ "variant": "abstract" }));
        moved.x = 400.0;
        save_widget_row(&conn, &moved).unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1, "dragging a widget left a second one behind");
        assert_eq!(got[0].x, 400.0);
        assert_eq!(got[0].config, serde_json::json!({ "variant": "abstract" }));
    }

    /// A config that will not parse must still list, or a widget becomes
    /// impossible to fix or take down.
    #[test]
    fn a_config_column_that_will_not_parse_reads_as_defaults() {
        let conn = db();
        conn.execute(
            "INSERT INTO widget (id, kind, x, y, w, h, z, config_json, created_at)
             VALUES ('w1', 'clock', 0, 0, 10, 10, 0, 'not json at all', 0)",
            [],
        )
        .unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].config, serde_json::json!({}));
    }

    /// v5 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step.
    #[test]
    fn an_existing_database_gains_the_widget_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_widget_row(&conn, &widget("w1", "clock", serde_json::json!({}))).unwrap();
        assert_eq!(list_widget_rows(&conn).unwrap().len(), 1);
    }

    /// A studio that has never run a pomodoro has no row, and that is an answer
    /// rather than a failure — the front end reads `None` as the default cycle,
    /// switched off.
    #[test]
    fn a_studio_with_no_cycle_reports_none() {
        let conn = db();
        assert!(read_pomodoro_row(&conn).unwrap().is_none());
    }

    /// The same bargain the widget config and the layer stack have: the phase
    /// machine lives in `timing.ts` and Rust holds its state without
    /// understanding a field of it, so anything invented there must survive the
    /// round trip untouched.
    #[test]
    fn a_cycle_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let state = serde_json::json!({
            "cadence": "50/10",
            "per": 4,
            "done": 3,
            "since": 1_760_000_000_000i64,
            "banked": 42.5,
            "snoozedUntil": 0,
            "pushed": 2,
            "on": true,
            "paused": false,
            "invented_tomorrow": ["anything"],
        });
        save_pomodoro_row(&conn, &state).unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap(), state);
    }

    /// One cycle per studio, so writing it twice must leave one row — the
    /// `CHECK (id = 1)` is the schema saying so, and this is the upsert
    /// honouring it. Two rows would leave the front end picking by row order,
    /// which is an afternoon that changes when nothing did.
    #[test]
    fn saving_the_cycle_twice_leaves_one_row() {
        let conn = db();
        save_pomodoro_row(&conn, &serde_json::json!({ "done": 1 })).unwrap();
        save_pomodoro_row(&conn, &serde_json::json!({ "done": 2 })).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the studio grew a second pomodoro cycle");
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap()["done"], 2);
    }

    /// A state that will not parse is a studio with no cycle running, not a
    /// fault to put on the red bar: the next write repairs the row.
    #[test]
    fn an_unparseable_cycle_still_reads() {
        let conn = db();
        conn.execute(
            "INSERT INTO pomodoro (id, state_json, updated_at) VALUES (1, 'not json at all', 0)",
            [],
        )
        .unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap(), serde_json::Value::Null);
    }

    /// v8 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step.
    #[test]
    fn an_existing_database_gains_the_pomodoro_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_pomodoro_row(&conn, &serde_json::json!({ "on": true })).unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap()["on"], true);
    }

    #[test]
    fn an_existing_database_gains_the_window_frame_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        /* A studio that has never been closed has no row, which is the
           first-launch case `window::settle` centres for. */
        assert!(read_window_frame(&conn).is_none());

        let f = crate::window::Frame { x: -1920, y: 40, w: 1280, h: 688, maximized: true };
        save_window_frame(&conn, &f).unwrap();
        assert_eq!(read_window_frame(&conn).unwrap(), f);

        /* Closing twice leaves one row, the way saving the cycle twice does —
           this table is a place, not a log. */
        save_window_frame(&conn, &crate::window::Frame { maximized: false, ..f }).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM window_frame", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        assert!(!read_window_frame(&conn).unwrap().maximized);
    }

    /// Nothing about where a window sat is worth failing a launch for, so the
    /// reader degrades to `None` and the next launch is centred — the same
    /// bargain the opaque JSON columns strike, made on this side of the wire
    /// because `setup` reads this before there is a front end to normalize it.
    #[test]
    fn a_frame_with_no_size_in_it_is_not_a_frame() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO window_frame (id, x, y, w, h, maximized, updated_at)
             VALUES (1, 0, 0, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        assert!(read_window_frame(&conn).is_none());
    }

    #[test]
    fn closing_a_conversation_cascades_to_its_rows() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('c1',1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO file_touch (conversation_id, path, op, at) VALUES ('c1','a.ts','write',0)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM conversation WHERE id='c1'", []).unwrap();

        let p: i64 = conn
            .query_row("SELECT COUNT(*) FROM placement", [], |r| r.get(0))
            .unwrap();
        let f: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_touch", [], |r| r.get(0))
            .unwrap();
        assert_eq!((p, f), (0, 0), "orphan rows were left behind");
    }

    /// This is the query the broadcast bar reads to warn that the cards you
    /// have gathered are about to rebase the same files.
    #[test]
    fn overlap_finds_conversations_sharing_a_file_and_ignores_the_rest() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["a", "b", "c"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        let touch = |c: &str, p: &str| {
            conn.execute(
                "INSERT INTO file_touch (conversation_id, path, op, at) VALUES (?1, ?2, 'write', 0)",
                params![c, p],
            )
            .unwrap();
        };
        touch("a", "src/db.ts");
        touch("b", "src/db.ts");
        touch("b", "src/ui.ts");
        touch("c", "docs/readme.md");

        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT b.conversation_id FROM file_touch a
                   JOIN file_touch b ON a.path = b.path
                  WHERE a.conversation_id = ?1 AND b.conversation_id <> ?1",
            )
            .unwrap();
        let hits: Vec<String> = stmt
            .query_map(params!["a"], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert_eq!(hits, vec!["b".to_string()], "c shares no files with a");
    }

    #[test]
    fn a_project_is_found_by_path_rather_than_created_twice() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        // root_path is UNIQUE — the same directory is always the same project.
        let again = conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES ('p2','x','C:/x',0)",
            [],
        );
        assert!(again.is_err(), "the same directory made two projects");
    }

    #[test]
    fn dir_name_handles_both_separators_and_trailing_slashes() {
        assert_eq!(dir_name("C:\\atelier\\skein"), "skein");
        assert_eq!(dir_name("C:/atelier/skein/"), "skein");
        assert_eq!(dir_name("/home/x/nova"), "nova");
        assert_eq!(dir_name("skein"), "skein");
    }

    /* ── the references sweep ────────────────────────────────────────────
     *
     * `delete_image` stopped taking the file with the row so that taking an
     * image down is undoable, which makes this the only thing that ever collects
     * one. It runs at launch, once, off the rows — so the two properties that
     * matter are that it never touches a file a row claims, and that it does
     * collect one no row does. */

    fn seed_image(conn: &Connection, id: &str, path: &std::path::Path) {
        conn.execute(
            "INSERT INTO reference_image
               (id, path, x, y, w, h, rotation, z, created_at)
             VALUES (?1, ?2, 0, 0, 10, 10, 0, 0, 0)",
            params![id, path.to_string_lossy().to_string()],
        )
        .unwrap();
    }

    /* ── the sink ─────────────────────────────────────────────────────────── */

    fn seed_card(conn: &Connection, id: &str, closed: bool) {
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES (?1, 'p1', 'C:/x', 0, ?2)",
            params![id, if closed { Some(1) } else { None }],
        )
        .unwrap();
    }

    fn put(conn: &Connection, title: &str, body: &str, from: Option<&str>) -> SinkPut {
        put_sink_item(conn, &uuid_v4(), Some("p1"), "bug", title, body, "", from).unwrap()
    }

    #[test]
    fn two_cards_meeting_the_same_thing_make_one_item_with_two_voices() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        seed_card(&conn, "c2", false);

        let first = put(&conn, "ask_user times out", "parks for ten minutes", Some("c1"));
        assert!(!first.merged);
        let second = put(&conn, "ASK_USER TIMES OUT", "and then answers TIMED_OUT", Some("c2"));
        assert!(second.merged, "the same title is the same finding");
        assert_eq!(second.id, first.id);
        assert_eq!(second.voices, 2);

        let items = sink_items(&conn, Some("p1"), false).unwrap();
        assert_eq!(items.len(), 1);
        /* The second card's words are kept — merging must not silently discard
           the half of the report the first one did not have. */
        assert!(items[0].body.contains("parks for ten minutes"));
        assert!(items[0].body.contains("TIMED_OUT"));
    }

    /// One agent repeating itself is not two conversations meeting a thing, and
    /// counting it would make `voices` a measure of how talkative a card is.
    #[test]
    fn one_card_saying_it_twice_is_still_one_voice() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        put(&conn, "the same finding", "first telling", Some("c1"));
        let again = put(&conn, "the same finding", "second telling", Some("c1"));
        assert!(again.merged);
        assert_eq!(again.voices, 1);
    }

    /// A settled item does not swallow a fresh report of the same thing coming
    /// back — it is back, and that is news.
    #[test]
    fn a_settled_item_does_not_absorb_the_thing_happening_again() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        let first = put(&conn, "it is broken", "once", Some("c1"));
        assert!(settle_sink_item(&conn, &first.id, Some("fixed in f7b30e8")));
        let again = put(&conn, "it is broken", "and again", Some("c1"));
        assert!(!again.merged);
        assert_ne!(again.id, first.id);
        assert_eq!(sink_items(&conn, Some("p1"), false).unwrap().len(), 1);
        assert_eq!(sink_items(&conn, Some("p1"), true).unwrap().len(), 1);
    }

    /// The whole point of a hold. Two cards reading the same free item and both
    /// claiming it: the second write is conditional on the hold the caller read,
    /// so exactly one of them is told it has it.
    #[test]
    fn one_item_cannot_be_held_by_two_cards() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        seed_card(&conn, "c2", false);
        let it = put(&conn, "a job", "for one of them", Some("c1"));

        assert!(hold_sink_item(&conn, &it.id, Some("c1"), None));
        assert!(!hold_sink_item(&conn, &it.id, Some("c2"), None));
        assert_eq!(sink_one(&conn, &it.id).unwrap().held_by.as_deref(), Some("c1"));
        assert_eq!(sink_held_count(&conn, "c1"), 1);
        assert_eq!(sink_held_count(&conn, "c2"), 0);

        /* Taking one that has gone stale is the same write with the holder the
           caller actually read, so it lands. */
        assert!(hold_sink_item(&conn, &it.id, Some("c2"), Some("c1")));
        assert_eq!(sink_one(&conn, &it.id).unwrap().held_by.as_deref(), Some("c2"));
    }

    /// Rewording one is yours, and the guard is in the UPDATE rather than in the
    /// check above it: a card that takes the item while you are typing must not
    /// have the brief rewritten out from under it. `sink.rs` says why in words;
    /// this is what makes the answer true.
    #[test]
    fn a_held_item_cannot_be_reworded_under_the_card_holding_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        let it = put(&conn, "a typo'd finding", "half a thought", None);
        let cutoff = now() - 120 * 60 * 1_000;

        assert!(edit_sink_item(&conn, &it.id, "chore", "the same finding, said properly",
                               "the whole of it", "src/lib/sink.ts", cutoff));
        let after = sink_one(&conn, &it.id).unwrap();
        assert_eq!(after.title, "the same finding, said properly");
        assert_eq!(after.kind, "chore");
        assert_eq!(after.paths, "src/lib/sink.ts");
        assert!(after.edited_at.is_some(), "the stamp says the words moved");
        /* An edit is not a new finding, so it does not go to the back of the
           queue — and it is not a new voice either. */
        assert_eq!(after.dropped_at, sink_one(&conn, &it.id).unwrap().dropped_at);
        assert_eq!(after.voices, 1);

        assert!(hold_sink_item(&conn, &it.id, Some("c1"), None));
        assert!(!edit_sink_item(&conn, &it.id, "bug", "rewritten under c1", "no", "", cutoff));
        assert_eq!(sink_one(&conn, &it.id).unwrap().title, "the same finding, said properly");

        /* A settled item is history, and history is not edited. */
        assert!(hold_sink_item(&conn, &it.id, None, Some("c1")));
        assert!(settle_sink_item(&conn, &it.id, None));
        assert!(!edit_sink_item(&conn, &it.id, "bug", "rewriting the past", "no", "", cutoff));
    }

    /// A hold nobody has honoured is not a hold, here as everywhere else — the
    /// same cutoff `sink::free` applies, so what the widget offers and what the
    /// write allows cannot disagree.
    #[test]
    fn a_lapsed_hold_does_not_block_a_rewording() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        let it = put(&conn, "left to go stale", "somebody took this and wandered off", None);
        assert!(hold_sink_item(&conn, &it.id, Some("c1"), None));

        /* A cutoff in the future is a hold that has already lapsed by it. */
        let cutoff = now() + 1;
        assert!(edit_sink_item(&conn, &it.id, "note", "said better", "and better", "", cutoff));
        assert_eq!(sink_one(&conn, &it.id).unwrap().title, "said better");
    }

    /// The difference between this table and the billboard, in one assertion. A
    /// card closing takes its notices with it and leaves its findings behind —
    /// see `migrate_v18`.
    #[test]
    fn a_closed_card_loses_its_hold_and_keeps_its_item() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", true);
        let it = put(&conn, "found on the way past", "worth someone's afternoon", Some("c1"));
        assert!(hold_sink_item(&conn, &it.id, Some("c1"), None));

        assert_eq!(sweep_sink_holds(&conn), 1);
        let after = sink_one(&conn, &it.id).unwrap();
        assert!(after.held_by.is_none(), "the hold goes");
        assert_eq!(after.from_id.as_deref(), Some("c1"), "the provenance stays");
        assert_eq!(sink_items(&conn, Some("p1"), false).unwrap().len(), 1, "the item stays");
    }

    /* ── wakes ────────────────────────────────────────────────────────────── */

    /// The DELETE *is* the claim, and claiming before delivering is what keeps a
    /// wake from being handed over twice — see `later::serve_due`.
    #[test]
    fn a_wake_can_only_be_taken_once() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        arm_wake(&conn, "w1", "c1", 500, "look at the pipeline").unwrap();

        assert!(wakes_due(&conn, 400).is_empty(), "not yet");
        let due = wakes_due(&conn, 500);
        assert_eq!(due.len(), 1, "inclusive at the moment it falls due");
        assert_eq!(due[0].note, "look at the pipeline");

        assert!(take_wake(&conn, "w1"));
        assert!(!take_wake(&conn, "w1"), "a second pass gets nothing");
        assert!(wakes_due(&conn, 9999).is_empty());
    }

    /// The rate is the only guard that can see a card re-arming forever, because
    /// every wake is hop zero — see the note at the top of `later.rs`. So the
    /// count has to outlive the rows it counts.
    #[test]
    fn the_served_count_outlives_the_wakes_themselves() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        let hour = 60 * 60 * 1_000;
        let t = 10 * hour;
        for _ in 0..3 {
            record_wake_served(&conn, "c1", t);
        }
        assert_eq!(wakes_served_to(&conn, "c1", t - hour), 3);
        assert_eq!(wakes_served_to(&conn, "c2", t - hour), 0, "counted per card");

        /* And pruned on the write that grew it, so the table cannot only grow. */
        record_wake_served(&conn, "c1", t + 3 * hour);
        assert_eq!(
            wakes_served_to(&conn, "c1", 0),
            1,
            "the old receipts are gone once the window has passed them"
        );
    }

    #[test]
    fn a_closed_card_takes_its_notes_to_itself_with_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        arm_wake(&conn, "w1", "c1", 1, "n").unwrap();
        record_wake_served(&conn, "c1", 1);
        drop_wakes_of(&conn, "c1");
        assert!(wakes_due(&conn, 9999).is_empty());
        assert_eq!(wakes_served_to(&conn, "c1", 0), 0);
    }

    /* ── what the ledger of touches answers ───────────────────────────────── */

    /// `touches_near` only narrows; `board::covers` decides. So the needle is
    /// deliberately loose — an agent asks about `sink.ts` and the table holds an
    /// absolute path — and the rows it hands back are expected to include things
    /// the caller will then reject.
    #[test]
    fn touches_are_narrowed_by_substring_and_newest_first() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_card(&conn, "c1", false);
        seed_card(&conn, "c2", false);
        for (card, path, op, at) in [
            ("c1", "C:/atelier/skein/src/lib/sink.ts", "read", 100),
            ("c2", "C:/atelier/skein/src/lib/sink.ts", "write", 200),
            ("c1", "C:/atelier/skein/src/lib/board.ts", "write", 300),
        ] {
            conn.execute(
                "INSERT INTO file_touch (conversation_id, path, op, at) VALUES (?1,?2,?3,?4)",
                params![card, path, op, at],
            )
            .unwrap();
        }

        let hits = touches_near(&conn, "sink.ts", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].at, 200, "newest first");
        assert_eq!(hits[0].op, "write");

        /* Case-folded, because a path arrives in whatever spelling the tool call
           used and Windows does not care. */
        assert_eq!(touches_near(&conn, "SINK.TS", 10).len(), 2);
        /* And the limit is honoured, since this is read to answer "lately". */
        assert_eq!(touches_near(&conn, "/lib/", 1).len(), 1);
        assert!(touches_near(&conn, "nothing-like-it", 10).is_empty());
    }

    /// A wall-wide item is everybody's, the same way a wall-wide notice is.
    #[test]
    fn a_project_read_includes_the_wall_wide_items() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        seed_project(&conn, "p2", "C:/y");
        put_sink_item(&conn, &uuid_v4(), Some("p1"), "note", "p1's", "b", "", None).unwrap();
        put_sink_item(&conn, &uuid_v4(), Some("p2"), "note", "p2's", "b", "", None).unwrap();
        put_sink_item(&conn, &uuid_v4(), None, "idea", "the studio's", "b", "", None).unwrap();

        let mine: Vec<String> = sink_items(&conn, Some("p1"), false)
            .unwrap()
            .into_iter()
            .map(|i| i.title)
            .collect();
        assert_eq!(mine, vec!["p1's", "the studio's"]);
        assert_eq!(sink_items(&conn, None, false).unwrap().len(), 3);
    }

    /// `done` keeps the row, so the user can put it back.
    #[test]
    fn settling_is_reversible() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        let it = put(&conn, "maybe done", "or maybe not", None);
        assert!(settle_sink_item(&conn, &it.id, Some("dealt with")));
        assert!(!settle_sink_item(&conn, &it.id, None), "twice is not a second settling");
        assert!(unsettle_sink_item(&conn, &it.id));
        let back = sink_one(&conn, &it.id).unwrap();
        assert!(back.settled_at.is_none());
        assert!(back.settled_note.is_none(), "the old verdict does not survive being wrong");
    }

    #[test]
    fn the_sweep_collects_what_no_row_claims_and_nothing_else() {
        let conn = db();
        let dir = std::env::temp_dir().join(format!("skein-sweep-{}", uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let kept = dir.join("kept.png");
        let orphan = dir.join("orphan.png");
        std::fs::write(&kept, b"k").unwrap();
        std::fs::write(&orphan, b"o").unwrap();
        seed_image(&conn, "i1", &kept);

        assert_eq!(sweep_orphans(&conn, &dir).unwrap(), 1);
        assert!(kept.exists());
        assert!(!orphan.exists());

        /* Idempotent: a second launch finds nothing left to do. */
        assert_eq!(sweep_orphans(&conn, &dir).unwrap(), 0);

        /* And it *does* reach an image whose row has gone — the case undo left
           behind on purpose. */
        conn.execute("DELETE FROM reference_image WHERE id = 'i1'", [])
            .unwrap();
        assert_eq!(sweep_orphans(&conn, &dir).unwrap(), 1);
        assert!(!kept.exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_references_directory_that_was_never_made_is_not_a_failure() {
        let conn = db();
        let missing = std::env::temp_dir().join(format!("skein-none-{}", uuid_v4()));
        assert_eq!(sweep_orphans(&conn, &missing).unwrap(), 0);
    }

    #[test]
    fn generated_ids_are_well_formed_and_distinct() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        // Version 4, RFC 4122 variant — claude validates --session-id.
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
    }
}

/// A v4 UUID without pulling in a crate for it.
pub fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut b = [0u8; 16];
    for chunk in b.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(now() as u64);
        h.write_usize(chunk.as_ptr() as usize);
        chunk.copy_from_slice(&h.finish().to_ne_bytes()[..chunk.len()]);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}
