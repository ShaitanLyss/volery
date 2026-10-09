//! What this wall keeps for the fleet, and what it says it is.
//!
//! `fleet.rs` is pure: it is handed a `Facts` and the last roster version, and
//! never reads a store. This is the other side of that bargain — the rows the
//! fleet's wiring reads and writes (`flyway_setting`, `flyway_birth`, schema
//! v47; `flyway_child`, v48) and the one function that assembles a `Facts`
//! from the wall as it is now. Kept out of `store.rs` for `sinksync.rs`'s reason: it is one subsystem's
//! SQL, and the file every card edits does not need to carry it.
//!
//! ### A territory, as another machine names it
//!
//! **The project's name**, through the same seam `sinksync::scope_of` uses for
//! the sink. A path means nothing on a laptop whose checkout lives somewhere
//! else, and a name is the one thing two checkouts of a repository share with
//! no registry between them. It is a known-weak identity and it is weak in one
//! place on purpose: when a real shared identity arrives it replaces both
//! readers at once.
//!
//! Two projects on one wall can share a name. They are both advertised —
//! hiding one would make an ask for it read as "no such territory", which is a
//! different and wrong answer — and an ask that lands on the name is refused
//! *with that reason* when the card is about to be opened (`root_for`), the
//! way `spawn.rs` refuses an ambiguous name rather than picking one. A card
//! carrying `--dangerously-skip-permissions` opened in the wrong repository of
//! the right name is the failure that would look like data loss.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::fleet::{Bound, Territory};

/* ── settings ──────────────────────────────────────────────────────────────── */

pub const FLEET_VERSION: &str = "fleet_version";
pub const CARDS_VERSION: &str = "cards_version";
pub const ACCEPTING: &str = "accepting";
pub const BOUND_LIVE: &str = "bound_live";
pub const BOUND_HOUR: &str = "bound_hour";

pub fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM flyway_setting WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO flyway_setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn clear_setting(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM flyway_setting WHERE key = ?1", params![key])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A version persisted for `Fleet::announce`'s reason, or zero the first time.
pub fn version(conn: &Connection, key: &str) -> u64 {
    setting(conn, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Whether this wall takes work from other walls. **No unless a person said
/// yes**, and a value that does not read as yes is no — a machine joining a
/// flyway must not thereby become somewhere anybody can open a card.
pub fn accepting(conn: &Connection) -> bool {
    setting(conn, ACCEPTING).as_deref() == Some("1")
}

/// This wall's own bounds on arriving work. Absent means none, for the reason
/// `fleet::Bound` gives — any default number would be a guess, and a guess
/// shows up as the good case refused.
pub fn bound(conn: &Connection) -> Bound {
    let n = |k: &str| setting(conn, k).and_then(|v| v.parse::<u32>().ok());
    Bound { live: n(BOUND_LIVE), per_hour: n(BOUND_HOUR) }
}

/* ── cards opened for other walls ──────────────────────────────────────────── */

/// Who asked for a card on this wall.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Birth {
    pub card: String,
    pub host: String,
    pub asker_card: Option<String>,
}

/// Written before the card is opened — see `migrate_v47`.
pub fn record_birth(
    conn: &Connection,
    card: &str,
    request: &str,
    host: &str,
    asker_card: Option<&str>,
    at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO flyway_birth (conversation_id, request, asked_by_host, asked_by_card, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![card, request, host, asker_card, at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A card that was agreed to and never opened is not a card opened for another
/// wall, and must not count against the hourly bound.
pub fn unrecord_birth(conn: &Connection, card: &str) {
    let _ = conn.execute("DELETE FROM flyway_birth WHERE conversation_id = ?1", params![card]);
}

pub fn birth_of(conn: &Connection, card: &str) -> Option<Birth> {
    conn.query_row(
        "SELECT conversation_id, asked_by_host, asked_by_card FROM flyway_birth WHERE conversation_id = ?1",
        params![card],
        |r| Ok(Birth { card: r.get(0)?, host: r.get(1)?, asker_card: r.get(2)? }),
    )
    .optional()
    .ok()
    .flatten()
}

/// Every card on the wall that another wall asked for, still open.
pub fn births(conn: &Connection) -> Vec<Birth> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT b.conversation_id, b.asked_by_host, b.asked_by_card
           FROM flyway_birth b JOIN conversation c ON c.id = b.conversation_id
          WHERE c.closed_at IS NULL
          ORDER BY b.at",
    ) else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok(Birth { card: r.get(0)?, host: r.get(1)?, asker_card: r.get(2)? }))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// How many of those are on the wall now. A card agreed to but whose row the
/// front end has not written yet is not here — `Fleet::in_flight` counts it.
pub fn births_live(conn: &Connection) -> u32 {
    conn.query_row(
        "SELECT COUNT(*) FROM flyway_birth b JOIN conversation c ON c.id = b.conversation_id
          WHERE c.closed_at IS NULL",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u32)
    .unwrap_or(0)
}

/// Opened for other walls since `since`, closed or not — the shape that sees
/// a loop, per `fleet::Bound`.
pub fn births_since(conn: &Connection, since: i64) -> u32 {
    conn.query_row("SELECT COUNT(*) FROM flyway_birth WHERE at >= ?1", params![since], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u32)
        .unwrap_or(0)
}

/* ── cards this wall asked others to open ──────────────────────────────────── */

/// A card on another wall that a card here asked for — `migrate_v48`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub host: String,
    pub card: String,
    pub parent: String,
}

/// Written when the answer says the card opened, by the wall that asked. A
/// repeat of the same answer is the same row.
pub fn record_child(conn: &Connection, host: &str, card: &str, parent: &str, request: &str, at: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO flyway_child (host, card, parent_id, request, at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![host, card, parent, request, at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Whether that card is one `parent` asked for — the whole of what makes its
/// message a reply rather than work (`fleet::may_reach`). Exact on both: an id
/// from the far wall's answer, never a prefix. **Not on the host**, which is
/// where the card was when it opened: the id is the card, and it may since
/// have moved to another machine and still be the one this card asked for.
pub fn is_child_of(conn: &Connection, card: &str, parent: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM flyway_child WHERE card = ?1 AND parent_id = ?2",
        params![card, parent],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Every card a card here asked another wall for, oldest first.
pub fn children_of(conn: &Connection, parent: &str) -> Vec<Child> {
    let Ok(mut stmt) = conn.prepare("SELECT host, card, parent_id FROM flyway_child WHERE parent_id = ?1 ORDER BY at") else {
        return Vec::new();
    };
    stmt.query_map(params![parent], |r| Ok(Child { host: r.get(0)?, card: r.get(1)?, parent: r.get(2)? }))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/* ── cards moving between walls ───────────────────────────────────────────── */

/// One move, as either wall keeps it — `migrate_v49`, and `moving.rs` for what
/// the words mean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoveRow {
    pub request: String,
    pub card: String,
    /// `out` on the wall the card left, `in` on the wall it went to.
    pub direction: String,
    /// The other wall.
    pub host: String,
    pub at: i64,
    pub outcome: Option<String>,
    pub why: Option<String>,
    pub challenge: Option<String>,
    pub token: Option<String>,
    pub told_at: Option<i64>,
}

const MOVE_COLS: &str = "request, conversation_id, direction, host, at, outcome, why, challenge, token, told_at";

fn move_row(r: &rusqlite::Row) -> rusqlite::Result<MoveRow> {
    Ok(MoveRow {
        request: r.get(0)?,
        card: r.get(1)?,
        direction: r.get(2)?,
        host: r.get(3)?,
        at: r.get(4)?,
        outcome: r.get(5)?,
        why: r.get(6)?,
        challenge: r.get(7)?,
        token: r.get(8)?,
        told_at: r.get(9)?,
    })
}

fn moves_where(conn: &Connection, clause: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<MoveRow> {
    let Ok(mut stmt) = conn.prepare(&format!("SELECT {MOVE_COLS} FROM flyway_move WHERE {clause} ORDER BY at")) else {
        return Vec::new();
    };
    stmt.query_map(p, move_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
}

/// Written before anything leaves (out) or before the card is opened (in) —
/// the one ordering that makes a crash leave a row saying what was under way.
#[allow(clippy::too_many_arguments)]
pub fn record_move(
    conn: &Connection,
    request: &str,
    card: &str,
    direction: &str,
    host: &str,
    at: i64,
    challenge: Option<&str>,
    token: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO flyway_move (request, conversation_id, direction, host, at, challenge, token)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![request, card, direction, host, at, challenge, token],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn move_of(conn: &Connection, request: &str) -> Option<MoveRow> {
    moves_where(conn, "request = ?1", &[&request]).into_iter().next()
}

/// A move of this card still under way here, if there is one — what freezes a
/// card on the wall it is leaving and holds one on the wall it is arriving at
/// until it has answered (`supervisor::spawn_now`).
pub fn moving_now(conn: &Connection, card: &str) -> Option<MoveRow> {
    moves_where(conn, "conversation_id = ?1 AND outcome IS NULL", &[&card]).into_iter().last()
}

/// Every move still under way on this wall, in either direction — for the
/// tick that gives up on them.
pub fn moves_open(conn: &Connection) -> Vec<MoveRow> {
    moves_where(conn, "outcome IS NULL", &[])
}

/// Moves into this wall that are settled and that the sending wall has not
/// yet answered — said again on every tick until it does.
pub fn moves_untold(conn: &Connection) -> Vec<MoveRow> {
    moves_where(conn, "direction = 'in' AND outcome IS NOT NULL AND told_at IS NULL", &[])
}

/// Write a move's outcome, once: a row already settled is left as it is and
/// `false` comes back, so two paths that both decide cannot both win.
pub fn settle_move(conn: &Connection, request: &str, outcome: &str, why: Option<&str>, at: i64) -> bool {
    conn.execute(
        "UPDATE flyway_move SET outcome = ?2, why = ?3, settled_at = ?4 WHERE request = ?1 AND outcome IS NULL",
        params![request, outcome, why, at],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// A settled move in is changed once more, by what the sending wall said.
pub fn withdraw_move(conn: &Connection, request: &str, why: &str) {
    let _ = conn.execute(
        "UPDATE flyway_move SET outcome = 'withdrawn', why = ?2 WHERE request = ?1",
        params![request, why],
    );
}

pub fn told_move(conn: &Connection, request: &str, at: i64) {
    let _ = conn.execute("UPDATE flyway_move SET told_at = ?2 WHERE request = ?1", params![request, at]);
}

/// Cards that moved here and are still open, with no birth row of their own —
/// arriving work this wall's bounds count beside `births_live`, without
/// counting one that carries an origin twice.
pub fn arrivals_live(conn: &Connection) -> u32 {
    conn.query_row(
        "SELECT COUNT(DISTINCT m.conversation_id) FROM flyway_move m JOIN conversation c ON c.id = m.conversation_id
          WHERE m.direction = 'in' AND (m.outcome IS NULL OR m.outcome = 'confirmed') AND c.closed_at IS NULL
            AND m.conversation_id NOT IN (SELECT conversation_id FROM flyway_birth)",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u32)
    .unwrap_or(0)
}

/// Cards that moved here since `since`, settled or not and with no birth row —
/// `births_since`'s twin, for the hourly bound.
pub fn arrivals_since(conn: &Connection, since: i64) -> u32 {
    conn.query_row(
        "SELECT COUNT(*) FROM flyway_move WHERE direction = 'in' AND at >= ?1
            AND conversation_id NOT IN (SELECT conversation_id FROM flyway_birth)",
        params![since],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u32)
    .unwrap_or(0)
}

/// The sessions of cards this wall no longer holds because of a move — moved
/// out and released, or arrived and taken away again. **Not offered for
/// adoption** (`sessions.rs`): adopting one would put a second card on a
/// conversation that is running on another machine, and the two would fork
/// the moment either was spoken to.
pub fn moved_away_sessions(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT c.agent_session_id FROM conversation c JOIN flyway_move m ON m.conversation_id = c.id
          WHERE c.closed_at IS NOT NULL AND c.agent_session_id IS NOT NULL
            AND ((m.direction = 'out' AND m.outcome = 'released')
              OR (m.direction = 'in' AND m.outcome IN ('failed', 'withdrawn')))",
    ) else {
        return Vec::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// What a card is, as a move carries it — the row's own words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardRow {
    pub id: String,
    pub session: String,
    pub cwd: String,
    pub worktree: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub named: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub gear: Option<String>,
    pub project: String,
    pub open: bool,
    pub aside: bool,
}

pub fn card_row(conn: &Connection, id: &str) -> Option<CardRow> {
    conn.query_row(
        "SELECT c.id, COALESCE(c.agent_session_id, c.id), c.cwd, c.worktree, COALESCE(c.kind, 'project'),
                c.title, COALESCE(c.named_by_hand, 0), c.model, c.effort, c.permission_mode,
                COALESCE(p.name, ''), c.closed_at IS NULL, COALESCE(c.aside, 0)
           FROM conversation c LEFT JOIN project p ON p.id = c.project_id
          WHERE c.id = ?1",
        params![id],
        |r| {
            Ok(CardRow {
                id: r.get(0)?,
                session: r.get(1)?,
                cwd: r.get(2)?,
                worktree: r.get(3)?,
                kind: r.get(4)?,
                title: r.get(5)?,
                named: r.get::<_, i64>(6)? != 0,
                model: r.get(7)?,
                effort: r.get(8)?,
                gear: r.get(9)?,
                project: r.get(10)?,
                open: r.get(11)?,
                aside: r.get::<_, i64>(12)? != 0,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

/// The cards on this wall a card opened (`spawned`), still open — which stay
/// where they are when it moves and go on being its children.
pub fn children_here(conn: &Connection, parent: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT s.child_id FROM spawned s JOIN conversation c ON c.id = s.child_id
          WHERE s.parent_id = ?1 AND c.closed_at IS NULL",
    ) else {
        return Vec::new();
    };
    stmt.query_map(params![parent], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/* ── territories ──────────────────────────────────────────────────────────── */

/// One place a card can stand, as this wall has it.
struct Ground {
    name: String,
    root: String,
}

fn grounds(conn: &Connection, skeins_own: &[&Path]) -> Vec<Ground> {
    let Ok(rows) = crate::store::projects(conn) else {
        return Vec::new();
    };
    rows.into_iter()
        /* Not the chat folder beside the database, which `#openIn` makes a
           project row of without anybody declaring it — spawn.rs's rule, for
           spawn.rs's reason. */
        .filter(|p| !skeins_own.iter().any(|d| inside(&p.root_path, d)))
        .map(|p| Ground { name: p.name, root: p.root_path })
        .collect()
}

/// What this wall can host, for its announcement. One entry per name — two
/// projects sharing a name are one territory as another wall can name it, and
/// `root_for` is where that is refused.
pub fn territories(conn: &Connection, skeins_own: &[&Path]) -> Vec<Territory> {
    let mut out: Vec<Territory> = Vec::new();
    for g in grounds(conn, skeins_own) {
        if !out.iter().any(|t| t.identity == g.name) {
            out.push(Territory { identity: g.name.clone(), name: g.name });
        }
    }
    out
}

/// Where a card asked for in this territory stands here, or why it cannot.
///
/// Answered by this wall's own table, never by anything the asker wrote: the
/// ask names a territory and this is the only place a path comes from.
pub fn root_for(conn: &Connection, identity: &str, skeins_own: &[&Path]) -> Result<String, String> {
    let hits: Vec<Ground> = grounds(conn, skeins_own).into_iter().filter(|g| g.name == identity).collect();
    match hits.as_slice() {
        [one] => Ok(one.root.clone()),
        [] => Err(format!(
            "this wall no longer has a territory called {identity:?} — it may have been forgotten \
             since it was announced"
        )),
        many => Err(format!(
            "this wall has {} territories called {identity:?} ({}), and opening a card in the wrong \
             one would hand it the wrong repository — rename one of them on this wall, or open the \
             card here by hand",
            many.len(),
            many.iter().map(|g| g.root.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Every card on the wall, open — the ids, for the wiring to ask the
/// supervisor which are mid-turn.
pub fn open_cards(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT id FROM conversation WHERE closed_at IS NULL") else {
        return Vec::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn tidy(p: &str) -> String {
    p.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn inside(root: &str, dir: &Path) -> bool {
    let base = tidy(&dir.to_string_lossy());
    let root = tidy(root);
    !base.is_empty() && (root == base || root.starts_with(&format!("{base}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::store::migrate(&conn).unwrap();
        conn
    }

    fn project(conn: &Connection, id: &str, name: &str, root: &str) {
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?2, ?3, 0)",
            params![id, name, root],
        )
        .unwrap();
    }

    fn card(conn: &Connection, id: &str, project: &str, closed: bool) {
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at) VALUES (?1, ?2, 'C:/x', 0, ?3)",
            params![id, project, if closed { Some(1) } else { None }],
        )
        .unwrap();
    }

    #[test]
    fn a_wall_takes_nothing_from_other_walls_until_somebody_says_so() {
        let conn = db();
        assert!(!accepting(&conn));
        set_setting(&conn, ACCEPTING, "yes").unwrap();
        assert!(!accepting(&conn), "only the one spelling of yes is yes");
        set_setting(&conn, ACCEPTING, "1").unwrap();
        assert!(accepting(&conn));
        assert_eq!(bound(&conn), Bound::default(), "no number until somebody chooses one");
        set_setting(&conn, BOUND_LIVE, "3").unwrap();
        assert_eq!(bound(&conn).live, Some(3));
    }

    /// The restart that `Fleet::announce` is written against: the version
    /// survives it.
    #[test]
    fn the_roster_version_outlives_the_process() {
        let conn = db();
        assert_eq!(version(&conn, FLEET_VERSION), 0);
        set_setting(&conn, FLEET_VERSION, "1700000000123").unwrap();
        assert_eq!(version(&conn, FLEET_VERSION), 1_700_000_000_123);
    }

    #[test]
    fn a_birth_counts_while_its_card_is_open_and_for_the_hour_regardless() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        record_birth(&conn, "c1", "r1", "lap", Some("k"), 1_000).unwrap();
        /* Agreed to and not yet on the wall: the fleet's in-flight count has it,
           this does not. */
        assert_eq!(births_live(&conn), 0);
        card(&conn, "c1", "p", false);
        assert_eq!(births_live(&conn), 1);
        assert_eq!(births(&conn), vec![Birth { card: "c1".into(), host: "lap".into(), asker_card: Some("k".into()) }]);
        conn.execute("UPDATE conversation SET closed_at = 5 WHERE id = 'c1'", []).unwrap();
        assert_eq!(births_live(&conn), 0);
        assert_eq!(births_since(&conn, 500), 1, "closed still counts toward the hour");
        assert_eq!(births_since(&conn, 2_000), 0);
        unrecord_birth(&conn, "c1");
        assert_eq!(births_since(&conn, 0), 0);
    }

    /// A child is known by its full id and the card here that asked for it —
    /// so a prefix of the id, or another parent here, reads as no child at all,
    /// while the same card running on another machine now is still the child.
    #[test]
    fn a_child_elsewhere_is_known_by_all_three_or_not_at_all() {
        let conn = db();
        record_child(&conn, "box", "c-full-id", "parent-1", "r1", 5).unwrap();
        record_child(&conn, "box", "c-full-id", "parent-1", "r1", 5).unwrap();
        assert!(is_child_of(&conn, "c-full-id", "parent-1"));
        assert!(!is_child_of(&conn, "c-full", "parent-1"));
        assert!(!is_child_of(&conn, "c-full-id", "parent-2"));
        assert_eq!(children_of(&conn, "parent-1").len(), 1, "a repeated answer is one row");
        assert!(children_of(&conn, "parent-2").is_empty());
    }

    /// A move is decided once: the first outcome written stands, and the card
    /// is frozen exactly while one is open.
    #[test]
    fn a_move_is_settled_once_and_freezes_its_card_until_it_is() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        card(&conn, "c1", "p", false);
        assert!(moving_now(&conn, "c1").is_none());
        record_move(&conn, "r1", "c1", "out", "desk", 10, None, None).unwrap();
        assert!(record_move(&conn, "r1", "c1", "out", "desk", 11, None, None).is_err(), "one row a request");
        assert_eq!(moving_now(&conn, "c1").unwrap().host, "desk");
        assert_eq!(moves_open(&conn).len(), 1);
        assert!(settle_move(&conn, "r1", "released", None, 20));
        assert!(!settle_move(&conn, "r1", "kept", Some("late"), 30), "the first decision stands");
        assert_eq!(move_of(&conn, "r1").unwrap().outcome.as_deref(), Some("released"));
        assert!(moving_now(&conn, "c1").is_none());
    }

    /// A move in is said to the sending wall until it answers; a session this
    /// wall gave away, or took back, is not one to adopt again.
    #[test]
    fn a_settled_arrival_is_retold_until_answered_and_a_session_given_away_is_not_adoptable() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        card(&conn, "gone", "p", true);
        card(&conn, "back", "p", true);
        card(&conn, "here", "p", false);
        conn.execute("UPDATE conversation SET agent_session_id = id", []).unwrap();
        record_move(&conn, "o", "gone", "out", "desk", 1, None, None).unwrap();
        settle_move(&conn, "o", "released", None, 2);
        record_move(&conn, "i", "back", "in", "lap", 1, Some("{}"), Some("move check i")).unwrap();
        settle_move(&conn, "i", "confirmed", None, 2);
        assert_eq!(moves_untold(&conn).len(), 1);
        told_move(&conn, "i", 3);
        assert!(moves_untold(&conn).is_empty());
        assert_eq!(moved_away_sessions(&conn), vec!["gone".to_string()], "a confirmed arrival is this wall's card");
        withdraw_move(&conn, "i", "lap kept its own");
        let mut s = moved_away_sessions(&conn);
        s.sort();
        assert_eq!(s, vec!["back".to_string(), "gone".to_string()]);
        record_move(&conn, "o2", "here", "out", "desk", 5, None, None).unwrap();
        settle_move(&conn, "o2", "released", None, 6);
        assert!(!moved_away_sessions(&conn).contains(&"here".to_string()), "an open card is not given away");
    }

    /// A card that moved here is arriving work and counts against the bounds —
    /// once, whether or not it carried an origin's birth row, and not once it
    /// has failed or gone.
    #[test]
    fn a_card_that_moved_here_counts_against_the_bounds_once() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        card(&conn, "m1", "p", false);
        card(&conn, "m2", "p", false);
        card(&conn, "m3", "p", false);
        record_move(&conn, "r1", "m1", "in", "lap", 100, None, None).unwrap();
        settle_move(&conn, "r1", "confirmed", None, 110);
        record_move(&conn, "r2", "m2", "in", "lap", 100, None, None).unwrap();
        record_birth(&conn, "m2", "r2", "box", Some("k"), 100).unwrap();
        record_move(&conn, "r3", "m3", "in", "lap", 100, None, None).unwrap();
        settle_move(&conn, "r3", "failed", Some("no"), 110);
        assert_eq!(arrivals_live(&conn) + births_live(&conn), 2, "m1 by its move, m2 by its birth, m3 not at all");
        assert_eq!(arrivals_since(&conn, 50) + births_since(&conn, 50), 3, "the hour counts the failed one too");
        assert_eq!(arrivals_since(&conn, 150), 0);
    }

    #[test]
    fn a_card_row_says_what_a_move_carries() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        card(&conn, "c1", "p", false);
        conn.execute(
            "UPDATE conversation SET title = 't', named_by_hand = 1, model = 'opus[1m]', effort = 'high',
                    permission_mode = 'plan', worktree = 'feat/x' WHERE id = 'c1'",
            [],
        )
        .unwrap();
        let r = card_row(&conn, "c1").unwrap();
        assert_eq!((r.session.as_str(), r.project.as_str(), r.named, r.open), ("c1", "skein", true, true));
        assert_eq!((r.model.as_deref(), r.gear.as_deref(), r.worktree.as_deref()), (Some("opus[1m]"), Some("plan"), Some("feat/x")));
        assert!(card_row(&conn, "nope").is_none());
    }

    #[test]
    fn a_territory_is_named_and_a_path_comes_only_from_this_wall() {
        let conn = db();
        project(&conn, "p", "skein", "C:/atelier/skein");
        let t = territories(&conn, &[]);
        assert_eq!(t, vec![Territory { identity: "skein".into(), name: "skein".into() }]);
        assert_eq!(root_for(&conn, "skein", &[]).unwrap(), "C:/atelier/skein");
        assert!(root_for(&conn, "nova", &[]).unwrap_err().contains("no longer has"));
    }

    /// Two repositories with one name: offered, so an ask is not told the
    /// territory is missing — and refused with the reason when it lands.
    #[test]
    fn one_name_over_two_repositories_is_offered_and_never_guessed() {
        let conn = db();
        project(&conn, "a", "nova", "C:/dev/nova");
        project(&conn, "b", "nova", "D:/archive/nova");
        assert_eq!(territories(&conn, &[]).len(), 1);
        let why = root_for(&conn, "nova", &[]).unwrap_err();
        assert!(why.contains("2 territories") && why.contains("D:/archive/nova"), "{why}");
    }

    #[test]
    fn the_folder_beside_the_database_is_nobodys_territory() {
        let conn = db();
        project(&conn, "c", "chat", "C:/Users/x/AppData/Roaming/dev.skein.lab/chat");
        project(&conn, "p", "skein", "C:/atelier/skein");
        let own = Path::new("C:\\Users\\x\\AppData\\Roaming\\dev.skein.lab");
        let t = territories(&conn, &[own]);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].name, "skein");
        assert!(root_for(&conn, "chat", &[own]).is_err());
    }
}
