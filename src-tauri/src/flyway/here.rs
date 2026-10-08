//! What this wall keeps for the fleet, and what it says it is.
//!
//! `fleet.rs` is pure: it is handed a `Facts` and the last roster version, and
//! never reads a store. This is the other side of that bargain — the rows the
//! fleet's wiring reads and writes (`flyway_setting`, `flyway_birth`, schema
//! v47) and the one function that assembles a `Facts` from the wall as it is
//! now. Kept out of `store.rs` for `sinksync.rs`'s reason: it is one subsystem's
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
