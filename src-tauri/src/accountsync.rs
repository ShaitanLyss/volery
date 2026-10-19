//! The store's half of one account, every wall: who each account signs in as,
//! and the stamped registers its settings travel as.
//!
//! `flyway/accounts.rs` is the vocabulary and the merge, and holds the whole
//! argument for it — a register per field, last write wins on a hybrid clock, a
//! value nobody has changed under this build never sent. This file is that merge
//! against SQLite, and the one way a setting is written: every write to
//! `enabled`, `caps`, `priority` or `rank` comes through [`stamp`], whether a
//! person pressed something in the panel, a card's `set_account` was agreed to,
//! or a peer said something newer ([`receive`]). A setter that wrote the column
//! directly would be a change no other wall ever heard of, with nothing anywhere
//! to say so — so the commands in `accounts.rs` have no SQL of their own for
//! these four columns any more.
//!
//! ### The row is a projection of the registers
//!
//! `account_sync` holds a register for every identity heard, registered here or
//! not; an `account` row carries the value of each field that has one. Two
//! labels signed in as one identity are one subscription twice, and a change to
//! either is applied to both. A row with no identity yet is stamped under a
//! placeholder (`flyway::accounts::PLACEHOLDER`), which [`adopt_identity`]
//! folds into the identity when it is learned — by the same rule, so a change
//! made before identification is not lost to an older one heard after.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::flyway::accounts::{self as wire, Register};

/// The register key an account is stamped under: its identity, or the
/// placeholder for its label until the identity is known.
pub fn key_of(conn: &Connection, label: &str) -> Option<String> {
    let identity: String = conn
        .query_row("SELECT identity FROM account WHERE label = ?1", params![label], |r| r.get(0))
        .optional()
        .ok()
        .flatten()?;
    Some(if identity.is_empty() { format!("{}{label}", wire::PLACEHOLDER) } else { identity })
}

/// The highest stamp this wall has seen, from anywhere — the hybrid clock's
/// memory, kept in the table itself so it survives a restart with nothing else
/// to persist.
pub fn highest(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(at), 0) FROM account_sync", [], |r| r.get(0)).unwrap_or(0)
}

/// Write one field of one account here, stamped now, and apply it to every row
/// it reaches. The one way the four synced columns are written from this wall.
///
/// Refused if the value is out of shape (`wire::normal`, the same rule a peer is
/// held to) or the account is not registered. Returns the register written, so
/// a caller can say when a change was made and by whom.
pub fn stamp(conn: &Connection, label: &str, field: &str, value: &Value, host: &str, now: i64) -> Result<Register, String> {
    let value = wire::normal(field, value).ok_or_else(|| format!("{field} cannot be {value}"))?;
    let identity = key_of(conn, label).ok_or_else(|| format!("there is no account called {label}"))?;
    let at = wire::next_stamp(now, highest(conn));
    let r = Register { identity, field: field.to_string(), value, at, host: host.to_string() };
    put(conn, &r)?;
    apply(conn, &r)?;
    Ok(r)
}

/// Several fields at once in one transaction — `reorder_accounts`, where a rank
/// is only meaningful against the others and a half-applied order is a wall
/// spending the wrong subscription. One stamp for the lot, so the whole order
/// wins or loses as a unit on every other wall.
pub fn stamp_all(conn: &mut Connection, writes: &[(String, &str, Value)], host: &str, now: i64) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| format!("stamp: {e}"))?;
    let at = wire::next_stamp(now, highest(&tx));
    for (label, field, value) in writes {
        let value = wire::normal(field, value).ok_or_else(|| format!("{field} cannot be {value}"))?;
        let Some(identity) = key_of(&tx, label) else { continue };
        let r = Register { identity, field: field.to_string(), value, at, host: host.to_string() };
        put(&tx, &r)?;
        apply(&tx, &r)?;
    }
    tx.commit().map_err(|e| format!("stamp: {e}"))
}

/// A register another wall said. Taken only if it beats what is held — the
/// merge's whole rule — and applied to every row signed in as that identity.
/// Returns whether anything moved, so the caller knows whether to tell the
/// front end.
pub fn receive(conn: &Connection, incoming: &Register) -> Result<bool, String> {
    let Some(r) = wire::admit(incoming) else { return Ok(false) };
    let held: Option<(i64, String)> = conn
        .query_row(
            "SELECT at, host FROM account_sync WHERE identity = ?1 AND field = ?2",
            params![r.identity, r.field],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("read register: {e}"))?;
    if let Some((at, host)) = held {
        if !r.beats(at, &host) {
            return Ok(false);
        }
    }
    put(conn, &r)?;
    apply(conn, &r)?;
    Ok(true)
}

/// Every register that may travel: stamped, and under a real identity.
pub fn published(conn: &Connection) -> Vec<Register> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT identity, field, value, at, host FROM account_sync
         WHERE identity NOT LIKE 'label:%' AND at > 0 ORDER BY identity, field",
    ) else {
        return Vec::new();
    };
    stmt.query_map([], read_register)
        .map(|rows| rows.filter_map(Result::ok).flatten().collect())
        .unwrap_or_default()
}

/// The register each field of one account holds, for the panel's sync line and
/// the `accounts` tool: who changed it last, and when.
pub fn registers_of(conn: &Connection, label: &str) -> Vec<Register> {
    let Some(key) = key_of(conn, label) else { return Vec::new() };
    let Ok(mut stmt) =
        conn.prepare("SELECT identity, field, value, at, host FROM account_sync WHERE identity = ?1 ORDER BY field")
    else {
        return Vec::new();
    };
    stmt.query_map(params![key], read_register)
        .map(|rows| rows.filter_map(Result::ok).flatten().collect())
        .unwrap_or_default()
}

/// Who one account signs in as, learned off its own credential
/// (`limits::learn_identity`). Records it, folds any change made under the
/// placeholder into the identity, and brings the row up to every register the
/// identity holds — which is how a wall that has just signed `lyss` in adopts
/// the on/off another wall set while it could not tell which account `lyss` was.
///
/// Returns whether the row's settings moved. An identity that changed under a
/// label — the store signed in as somebody else — is followed: the row takes the
/// new identity's registers and the old one's are left to the identity they
/// belong to.
pub fn adopt_identity(conn: &Connection, label: &str, identity: &str, email: &str, org: &str, now: i64) -> Result<bool, String> {
    if !wire::is_identity(identity) {
        return Err(format!("{identity:?} is not an account identity"));
    }
    let before: Option<String> = conn
        .query_row("SELECT identity FROM account WHERE label = ?1", params![label], |r| r.get(0))
        .optional()
        .map_err(|e| format!("read account: {e}"))?;
    let Some(before) = before else { return Ok(false) };
    conn.execute(
        "UPDATE account SET identity = ?1, identity_email = ?2, identity_org = ?3, identity_at = ?4 WHERE label = ?5",
        params![identity, clip(email), clip(org), now, label],
    )
    .map_err(|e| format!("record identity: {e}"))?;
    if before == identity {
        return Ok(false);
    }
    /* What was changed here before anybody knew whose account it was. Merged by
       the same rule as anything heard, so it beats an older register and loses
       to a newer one; the placeholder then goes, since no other row can carry
       it. */
    let placeholder = format!("{}{label}", wire::PLACEHOLDER);
    let pending: Vec<Register> = {
        let mut stmt = conn
            .prepare("SELECT identity, field, value, at, host FROM account_sync WHERE identity = ?1")
            .map_err(|e| format!("read placeholder: {e}"))?;
        let rows = stmt.query_map(params![placeholder], read_register).map_err(|e| format!("read placeholder: {e}"))?;
        rows.filter_map(Result::ok).flatten().collect()
    };
    for mut r in pending {
        r.identity = identity.to_string();
        let held: Option<(i64, String)> = conn
            .query_row(
                "SELECT at, host FROM account_sync WHERE identity = ?1 AND field = ?2",
                params![r.identity, r.field],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("read register: {e}"))?;
        if held.as_ref().is_none_or(|(at, host)| r.beats(*at, host)) {
            put(conn, &r)?;
        }
    }
    conn.execute("DELETE FROM account_sync WHERE identity = ?1", params![placeholder])
        .map_err(|e| format!("drop placeholder: {e}"))?;
    let mut moved = false;
    for field in wire::FIELDS {
        let held: Option<String> = conn
            .query_row(
                "SELECT value FROM account_sync WHERE identity = ?1 AND field = ?2",
                params![identity, field],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("read register: {e}"))?;
        if let Some(v) = held.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            moved |= set_column(conn, "label", label, field, &v)?;
        }
    }
    Ok(moved)
}

/// The labels here signed in as `identity`.
pub fn labels_of(conn: &Connection, identity: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT label FROM account WHERE identity = ?1 ORDER BY label") else {
        return Vec::new();
    };
    stmt.query_map(params![identity], |r| r.get(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// When an account's identity was last learned, or zero.
pub fn identity_at(conn: &Connection, label: &str) -> i64 {
    conn.query_row("SELECT identity_at FROM account WHERE label = ?1", params![label], |r| r.get(0))
        .unwrap_or(0)
}

/// Every label's identity, for the readings: label → identity, known ones only.
pub fn identities(conn: &Connection) -> Vec<(String, String)> {
    let Ok(mut stmt) = conn.prepare("SELECT label, identity FROM account WHERE identity != '' ORDER BY label") else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/* ── the table ─────────────────────────────────────────────────────────────*/

fn put(conn: &Connection, r: &Register) -> Result<(), String> {
    conn.execute(
        "INSERT INTO account_sync (identity, field, value, at, host) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(identity, field) DO UPDATE SET value = ?3, at = ?4, host = ?5",
        params![r.identity, r.field, r.value.to_string(), r.at, r.host],
    )
    .map_err(|e| format!("write register: {e}"))?;
    Ok(())
}

/// Bring every row the register reaches up to its value.
fn apply(conn: &Connection, r: &Register) -> Result<bool, String> {
    if let Some(label) = r.identity.strip_prefix(wire::PLACEHOLDER) {
        return set_column(conn, "label", label, &r.field, &r.value);
    }
    set_column(conn, "identity", &r.identity, &r.field, &r.value)
}

/// One synced column on the rows matching `by = key`. Returns whether any row
/// changed, so a repeat of a value already there tells nobody anything.
fn set_column(conn: &Connection, by: &str, key: &str, field: &str, v: &Value) -> Result<bool, String> {
    let by = match by {
        "label" => "label",
        _ => "identity",
    };
    let n = match field {
        "enabled" => conn.execute(
            &format!("UPDATE account SET enabled = ?1 WHERE {by} = ?2 AND enabled != ?1"),
            params![v.as_bool().unwrap_or(true) as i64, key],
        ),
        "caps" => conn.execute(
            &format!("UPDATE account SET caps = ?1 WHERE {by} = ?2 AND caps != ?1"),
            params![v.to_string(), key],
        ),
        "priority" => conn.execute(
            &format!("UPDATE account SET priority = ?1 WHERE {by} = ?2 AND priority != ?1"),
            params![v.as_i64().unwrap_or(1).max(1), key],
        ),
        "rank" => conn.execute(
            &format!("UPDATE account SET rank = ?1 WHERE {by} = ?2 AND rank != ?1"),
            params![v.as_i64().unwrap_or(0).max(0), key],
        ),
        _ => return Ok(false),
    }
    .map_err(|e| format!("apply {field}: {e}"))?;
    Ok(n > 0)
}

fn read_register(r: &rusqlite::Row) -> rusqlite::Result<Option<Register>> {
    let text: String = r.get(2)?;
    Ok(serde_json::from_str::<Value>(&text).ok().map(|value| Register {
        identity: r.get(0).unwrap_or_default(),
        field: r.get(1).unwrap_or_default(),
        value,
        at: r.get(3).unwrap_or(0),
        host: r.get(4).unwrap_or_default(),
    }))
}

fn clip(s: &str) -> String {
    crate::clip::preview(&crate::clean::scrub(s.trim()), 200)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const X: &str = "8ebb2352-0000-4000-8000-000000000001:10340709-0000-4000-8000-000000000002";

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::store::migrate(&conn).unwrap();
        conn
    }

    fn add(conn: &Connection, label: &str, identity: &str) {
        conn.execute(
            "INSERT INTO account (label, rank, priority, enabled, caps, added_at, identity) VALUES (?1, 0, 1, 1, '{}', 0, ?2)",
            params![label, identity],
        )
        .unwrap();
    }

    fn enabled(conn: &Connection, label: &str) -> bool {
        conn.query_row("SELECT enabled FROM account WHERE label = ?1", params![label], |r| r.get::<_, i64>(0)).unwrap() != 0
    }

    /// The upgrade moves nothing: rows from before carry no register, so
    /// nothing is published until somebody changes something.
    #[test]
    fn nothing_travels_until_a_person_changes_something() {
        let conn = db();
        add(&conn, "lyss", X);
        assert!(published(&conn).is_empty());
        stamp(&conn, "lyss", "enabled", &json!(false), "QUEERISFREEDOM", 1_000).unwrap();
        let p = published(&conn);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].value, json!(false));
        assert!(!enabled(&conn, "lyss"));
    }

    /// A change heard from another wall reaches every row signed in as that
    /// identity — two labels on one subscription are one subscription.
    #[test]
    fn a_register_heard_reaches_every_label_signed_in_as_it() {
        let conn = db();
        add(&conn, "lyss", X);
        add(&conn, "lyss-again", X);
        let r = Register { identity: X.into(), field: "enabled".into(), value: json!(false), at: 50, host: "AU-LT-288".into() };
        assert!(receive(&conn, &r).unwrap());
        assert!(!enabled(&conn, "lyss") && !enabled(&conn, "lyss-again"));
        /* A repeat moves nothing and says so. */
        assert!(!receive(&conn, &r).unwrap());
        /* And an older one loses to it. */
        let older = Register { at: 40, value: json!(true), ..r.clone() };
        assert!(!receive(&conn, &older).unwrap());
        assert!(!enabled(&conn, "lyss"));
    }

    /// The local stamp always beats what this wall has seen, so a change made
    /// after hearing another wins on every wall even if this clock is behind.
    #[test]
    fn a_local_change_after_hearing_one_wins() {
        let conn = db();
        add(&conn, "lyss", X);
        let theirs = Register { identity: X.into(), field: "enabled".into(), value: json!(false), at: 9_000, host: "fast".into() };
        receive(&conn, &theirs).unwrap();
        let mine = stamp(&conn, "lyss", "enabled", &json!(true), "slow", 1_000).unwrap();
        assert!(mine.at > 9_000);
        assert!(enabled(&conn, "lyss"));
    }

    /// A change made before the identity was known is stamped under the
    /// placeholder, never published, and folded in when the identity arrives —
    /// winning over an older register and losing to a newer one.
    #[test]
    fn a_change_before_identification_is_kept_and_then_merged() {
        let conn = db();
        add(&conn, "lyss", "");
        stamp(&conn, "lyss", "caps", &json!({ "session": 80 }), "here", 2_000).unwrap();
        stamp(&conn, "lyss", "enabled", &json!(false), "here", 2_001).unwrap();
        assert!(published(&conn).is_empty(), "a placeholder never travels");
        /* Meanwhile another wall had said older caps and a newer on/off. */
        receive(&conn, &Register { identity: X.into(), field: "caps".into(), value: json!({ "session": 50 }), at: 1_000, host: "there".into() }).unwrap();
        receive(&conn, &Register { identity: X.into(), field: "enabled".into(), value: json!(true), at: 5_000, host: "there".into() }).unwrap();
        let moved = adopt_identity(&conn, "lyss", X, "l@example.com", "Org", 6_000).unwrap();
        assert!(moved);
        let caps: String = conn.query_row("SELECT caps FROM account WHERE label = 'lyss'", [], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&caps).unwrap(), json!({ "session": 80.0 }));
        assert!(enabled(&conn, "lyss"), "the newer word from the other wall wins");
        assert_eq!(published(&conn).len(), 2);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM account_sync WHERE identity LIKE 'label:%'", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        /* Learning the same identity again moves nothing. */
        assert!(!adopt_identity(&conn, "lyss", X, "l@example.com", "Org", 7_000).unwrap());
    }

    /// A wall that has just signed an account in takes the settings the others
    /// agreed while it could not tell which account it was.
    #[test]
    fn a_newly_identified_account_adopts_what_the_others_set() {
        let conn = db();
        add(&conn, "lyss", "");
        receive(&conn, &Register { identity: X.into(), field: "enabled".into(), value: json!(false), at: 10, host: "AU-LT-288".into() }).unwrap();
        receive(&conn, &Register { identity: X.into(), field: "priority".into(), value: json!(3), at: 10, host: "AU-LT-288".into() }).unwrap();
        assert!(enabled(&conn, "lyss"), "nothing reaches a row whose identity is unknown");
        adopt_identity(&conn, "lyss", X, "", "", 20).unwrap();
        assert!(!enabled(&conn, "lyss"));
        let p: i64 = conn.query_row("SELECT priority FROM account WHERE label = 'lyss'", [], |r| r.get(0)).unwrap();
        assert_eq!(p, 3);
    }

    #[test]
    fn a_reorder_is_one_stamp() {
        let mut conn = db();
        add(&conn, "a", X);
        add(&conn, "b", "");
        stamp_all(&mut conn, &[("a".into(), "rank", json!(1)), ("b".into(), "rank", json!(0))], "h", 100).unwrap();
        let ats: Vec<i64> = conn
            .prepare("SELECT at FROM account_sync")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(ats.len(), 2);
        assert_eq!(ats[0], ats[1]);
    }

    #[test]
    fn an_out_of_shape_local_write_is_refused() {
        let conn = db();
        add(&conn, "lyss", X);
        assert!(stamp(&conn, "lyss", "priority", &json!(0), "h", 1).is_err());
        assert!(stamp(&conn, "nobody", "enabled", &json!(true), "h", 1).is_err());
        assert!(published(&conn).is_empty());
    }
}
