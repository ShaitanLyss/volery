//! The sink's half of the flyway: what the pile says when it changes, and what
//! it does when somebody else's saying arrives.
//!
//! `flyway::sync` is the pure model — events, a ledger, the properties. This is
//! that model laid over the real rows, and it exists as its own file because the
//! two questions are different ones: *do two piles converge* is answered over
//! values, *does a crash leave the pile and the log disagreeing* can only be
//! answered over SQLite.
//!
//! ### The outbox is one table and is also the memory
//!
//! `flyway_event` holds every event this wall knows — its own, written by the
//! sink's own operations, and what it has heard — keyed `(host, seq)`. The key
//! is the whole of the idempotence: an event whose key is already there is a
//! re-delivery and changes nothing, which is what a reconnect that replays is
//! allowed to be. It is also what makes "everything after seq N from host H" a
//! single indexed read, so a wall that has been away a week is told only what it
//! missed.
//!
//! ### Same transaction, or the log lies
//!
//! Every local write goes through `atomic`, so the row change and the event
//! that describes it commit together or not at all. A crash between the two
//! would leave a pile that has a finding the log never mentioned (so no other
//! wall ever hears of it) or a log mentioning one the pile lacks — the same
//! shape as the migration stamp `store.rs` has a long note on.
//!
//! ### `voices` is a count kept in step with a set
//!
//! A count cannot survive a merge, which is the argument `sync.rs` opens with:
//! two walls each gain a voice while apart and both say `voices: 2`. So who has
//! spoken is `sink_voice(item_id, who)`, a set, and `sink_item.voices` stays as
//! a **denormalised** count of it. Kept rather than derived because every
//! listing reads it per row and the rest of the app already does, and keeping it
//! in step is one `recount` at the only two places a voice is added — here.
//!
//! ### Where this deliberately differs from `sync::Ledger`
//!
//! - A twin is matched among **open** items only, as `put_sink_item` does.
//!   Folding a drop into a long-settled item of the same title would make a
//!   recurrence of a fixed bug vanish into the record of the old one.
//! - A settling clears a hold, as `settle_sink_item` always has, and a hold is
//!   not taken on a settled item.
//! - The scope on the wire is the project's **name** for now — the one thing two
//!   checkouts of a repository share without a registry. `scope_of` and
//!   `project_for_scope` are the seam where a real shared identity goes; a scope
//!   this wall has no project for lands wall-wide rather than being lost.
//! - Not shipped, because the event vocabulary has no word for them: a local
//!   merge appending words to a body, a hold being refreshed (`touch_sink_hold`),
//!   and your deleting an item outright.

/* `receive`, `events_after` and `watermark` wait for the transport, as the rest
   of `flyway` does; this comes off with `flyway/mod.rs`'s own allow. */
#![allow(dead_code)]

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::flyway::sync::{Event, Stamp, What};

/// Run `f` so that everything it writes lands together or not at all.
///
/// A savepoint rather than a transaction, so it composes: callers that are
/// already inside one (the migration ladder, a test) get a nested scope instead
/// of "cannot start a transaction within a transaction".
pub fn atomic<T>(conn: &Connection, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    conn.execute_batch("SAVEPOINT sinkw").map_err(|e| e.to_string())?;
    match f() {
        Ok(v) => {
            conn.execute_batch("RELEASE sinkw").map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO sinkw; RELEASE sinkw");
            Err(e)
        }
    }
}

/// The item an event is about, as written.
pub fn target(w: &What) -> &str {
    match w {
        What::Dropped { id, .. }
        | What::Seconded { id, .. }
        | What::Held { id, .. }
        | What::Released { id, .. }
        | What::Settled { id, .. }
        | What::Unsettled { id, .. }
        | What::Reworded { id, .. } => id,
    }
}

/// How another wall names this project. See the module comment.
pub fn scope_of(conn: &Connection, project_id: Option<&str>) -> Option<String> {
    let id = project_id?;
    conn.query_row("SELECT name FROM project WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// The project here that another wall's scope names — the oldest, if two share
/// a name — or `None`, which lands the item wall-wide.
pub fn project_for_scope(conn: &Connection, scope: Option<&str>) -> Option<String> {
    let name = scope?;
    conn.query_row(
        "SELECT id FROM project WHERE name = ?1 ORDER BY created_at, id LIMIT 1",
        params![name],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Write one event of this wall's own into the outbox, with the next `seq`.
pub fn emit(conn: &Connection, what: &What) -> Result<Event, String> {
    let host = crate::flyway::key::host_name();
    let seq: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM flyway_event WHERE host = ?1",
            params![host],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let event = Event { stamp: Stamp { host, seq: seq as u64 }, what: what.clone() };
    let json = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO flyway_event (host, seq, event, applied) VALUES (?1, ?2, ?3, 1)",
        params![event.stamp.host, seq, json],
    )
    .map_err(|e| format!("write flyway event: {e}"))?;
    Ok(event)
}

/// What a local sink write calls after changing a row: stamp the field the
/// event is the latest word on, and put the event in the outbox. Call inside
/// `atomic` with the write itself.
pub fn record(conn: &Connection, what: What) -> Result<(), String> {
    let (col, id, at) = match &what {
        What::Held { id, at, .. } | What::Released { id, at } => ("held_ev", id, *at),
        What::Settled { id, at, .. } | What::Unsettled { id, at } => ("settled_ev", id, *at),
        What::Reworded { id, at, .. } => ("worded_ev", id, *at),
        _ => ("", &String::new(), 0),
    };
    if !col.is_empty() {
        conn.execute(
            &format!("UPDATE sink_item SET {col} = ?2 WHERE id = ?1"),
            params![id, at],
        )
        .map_err(|e| e.to_string())?;
    }
    emit(conn, &what).map(|_| ())
}

/// Add a name to an item's voices; true if it was new. Keeps the count in step.
pub fn add_voice(conn: &Connection, item: &str, who: &str) -> Result<bool, String> {
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO sink_voice (item_id, who) VALUES (?1, ?2)",
            params![item, who],
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        recount(conn, item)?;
    }
    Ok(n > 0)
}

fn recount(conn: &Connection, item: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE sink_item SET voices = MAX(1, (SELECT COUNT(*) FROM sink_voice WHERE item_id = ?1))
          WHERE id = ?1",
        params![item],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The furthest `seq` this wall holds from each host — what a reconnect says.
pub fn watermark(conn: &Connection) -> Result<BTreeMap<String, u64>, String> {
    let mut stmt = conn
        .prepare("SELECT host, MAX(seq) FROM flyway_event GROUP BY host")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Everything this wall holds that a peer with `have` does not, oldest first
/// within each host. A host the peer has never heard of is sent whole.
pub fn events_after(
    conn: &Connection,
    have: &BTreeMap<String, u64>,
) -> Result<Vec<Event>, String> {
    let hosts: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT host FROM flyway_event ORDER BY host")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let mut out = Vec::new();
    for host in hosts {
        let after = have.get(&host).copied().unwrap_or(0) as i64;
        let mut stmt = conn
            .prepare("SELECT event FROM flyway_event WHERE host = ?1 AND seq > ?2 ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![host, after], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for json in rows {
            let json = json.map_err(|e| e.to_string())?;
            out.push(serde_json::from_str(&json).map_err(|e| format!("read flyway event: {e}"))?);
        }
    }
    Ok(out)
}

fn resolve(conn: &Connection, id: &str) -> String {
    /* Bounded, for the reason `Ledger::resolve` is: a corrupt frame could
       describe a cycle, and a loop here would hold the store's lock. */
    let mut at = id.to_string();
    for _ in 0..16 {
        let next: Option<String> = conn
            .query_row("SELECT new_id FROM sink_alias WHERE old_id = ?1", params![at], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        match next {
            Some(n) => at = n,
            None => break,
        }
    }
    at
}

fn exists(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT 1 FROM sink_item WHERE id = ?1", params![id], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// Words from another wall are stored and then handed to cards, so they owe the
/// scrub and the cap every other box a card reads from has.
fn clean(s: &str, max: usize) -> String {
    crate::clip::keep(&crate::clean::scrub(s), max).kept
}

/// Hear an event. True if it was news.
///
/// Stored first, by key — a key already there ends it, which is the whole of
/// idempotence — and then applied to the rows, in the same savepoint. One that
/// is about an item this wall has not heard of stays stored with `applied = 0`
/// and lands when the drop catches up (`replay`).
pub fn receive(conn: &Connection, e: &Event) -> Result<bool, String> {
    atomic(conn, || {
        let json = serde_json::to_string(e).map_err(|x| x.to_string())?;
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO flyway_event (host, seq, event, applied)
                 VALUES (?1, ?2, ?3, 0)",
                params![e.stamp.host, e.stamp.seq as i64, json],
            )
            .map_err(|x| x.to_string())?;
        if n == 0 {
            return Ok(false);
        }
        if apply(conn, &e.what)? {
            conn.execute(
                "UPDATE flyway_event SET applied = 1 WHERE host = ?1 AND seq = ?2",
                params![e.stamp.host, e.stamp.seq as i64],
            )
            .map_err(|x| x.to_string())?;
        }
        if matches!(e.what, What::Dropped { .. }) {
            replay(conn)?;
        }
        Ok(true)
    })
}

/// Apply what was waiting for an item that now exists.
fn replay(conn: &Connection) -> Result<(), String> {
    let waiting: Vec<(String, i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT host, seq, event FROM flyway_event WHERE applied = 0 ORDER BY host, seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    for (host, seq, json) in waiting {
        let ev: Event = match serde_json::from_str(&json) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if apply(conn, &ev.what)? {
            conn.execute(
                "UPDATE flyway_event SET applied = 1 WHERE host = ?1 AND seq = ?2",
                params![host, seq],
            )
            .map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}

/// Fold one event into the rows. False means "not yet": the item is unknown.
fn apply(conn: &Connection, what: &What) -> Result<bool, String> {
    let e = |x: rusqlite::Error| x.to_string();
    if let What::Dropped { id, scope, kind, title, body, paths, from, at, host } = what {
        apply_drop(conn, id, scope.as_deref(), kind, title, body, paths, from.as_deref(), *at, host)?;
        return Ok(true);
    }
    let id = resolve(conn, target(what));
    if !exists(conn, &id) {
        return Ok(false);
    }
    match what {
        What::Seconded { by, .. } => {
            add_voice(conn, &id, by)?;
        }
        What::Held { by, at, .. } => {
            conn.execute(
                "UPDATE sink_item SET held_by = ?2, held_at = ?3, held_ev = ?3,
                                      touched_at = MAX(touched_at, ?3)
                  WHERE id = ?1 AND settled_at IS NULL AND ?3 >= held_ev",
                params![id, by, at],
            )
            .map_err(e)?;
        }
        What::Released { at, .. } => {
            conn.execute(
                "UPDATE sink_item SET held_by = NULL, held_at = NULL, held_ev = ?2
                  WHERE id = ?1 AND ?2 >= held_ev",
                params![id, at],
            )
            .map_err(e)?;
        }
        What::Settled { note, at, .. } => {
            let note = clean(note, crate::store::MAX_SINK_BODY);
            conn.execute(
                "UPDATE sink_item SET settled_at = ?2, settled_note = NULLIF(?3, ''),
                                      held_by = NULL, held_at = NULL, settled_ev = ?2,
                                      touched_at = MAX(touched_at, ?2)
                  WHERE id = ?1 AND ?2 >= settled_ev",
                params![id, at, note],
            )
            .map_err(e)?;
        }
        What::Unsettled { at, .. } => {
            conn.execute(
                "UPDATE sink_item SET settled_at = NULL, settled_note = NULL, settled_ev = ?2,
                                      touched_at = MAX(touched_at, ?2)
                  WHERE id = ?1 AND ?2 >= settled_ev",
                params![id, at],
            )
            .map_err(e)?;
        }
        What::Reworded { kind, title, body, paths, at, .. } => {
            conn.execute(
                "UPDATE sink_item SET kind = ?2, title = ?3, body = ?4, paths = ?5,
                                      edited_at = ?6, worded_ev = ?6,
                                      touched_at = MAX(touched_at, ?6)
                  WHERE id = ?1 AND ?6 >= worded_ev",
                params![
                    id,
                    clean(kind, 40),
                    clean(title, 400),
                    clean(body, crate::store::MAX_SINK_BODY),
                    clean(paths, 2000),
                    at
                ],
            )
            .map_err(e)?;
        }
        What::Dropped { .. } => unreachable!(),
    }
    Ok(true)
}

/// A drop, which is either a new item, a re-delivery, or the same finding
/// another machine already told us about.
#[allow(clippy::too_many_arguments)]
fn apply_drop(
    conn: &Connection,
    id: &str,
    scope: Option<&str>,
    kind: &str,
    title: &str,
    body: &str,
    paths: &str,
    from: Option<&str>,
    at: i64,
    host: &str,
) -> Result<(), String> {
    let e = |x: rusqlite::Error| x.to_string();
    let id = resolve(conn, id);
    if exists(conn, &id) {
        /* A re-delivery must not reset what has been said since: the drop is
           the one event whose fields are a starting point, not a statement. */
        return Ok(());
    }
    let kind = clean(kind, 40);
    let title = clean(title, 400);
    let body = clean(body, crate::store::MAX_SINK_BODY);
    let paths = clean(paths, 2000);
    let who = from.unwrap_or(host).to_string();
    let project = project_for_scope(conn, scope);

    let twin: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT id, dropped_at, worded_ev FROM sink_item
              WHERE settled_at IS NULL AND lower(title) = lower(?1)
                AND ((project_id IS NULL AND ?2 IS NULL) OR project_id = ?2)",
            params![title, project],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(e)?;

    match twin {
        None => {
            conn.execute(
                "INSERT INTO sink_item (id, project_id, kind, title, body, paths, from_id,
                                        dropped_at, touched_at, voices, origin_host)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 1, ?9)",
                params![id, project, kind, title, body, paths, from, at, host],
            )
            .map_err(e)?;
            add_voice(conn, &id, &who)?;
        }
        Some((there, there_at, there_worded)) => {
            /* Both walls pick the same survivor from the data alone: the
               earliest drop, the lower id on a tie. */
            if (at, id.as_str()) <= (there_at, there.as_str()) {
                conn.execute(
                    "UPDATE sink_item SET id = ?2, dropped_at = ?3, origin_host = ?4, from_id = ?5
                      WHERE id = ?1",
                    params![there, id, at, host, from],
                )
                .map_err(e)?;
                if there_worded == 0 {
                    conn.execute(
                        "UPDATE sink_item SET kind = ?2, title = ?3, body = ?4, paths = ?5
                          WHERE id = ?1",
                        params![id, kind, title, body, paths],
                    )
                    .map_err(e)?;
                }
                conn.execute(
                    "UPDATE sink_voice SET item_id = ?2 WHERE item_id = ?1",
                    params![there, id],
                )
                .map_err(e)?;
                conn.execute(
                    "UPDATE sink_alias SET new_id = ?2 WHERE new_id = ?1",
                    params![there, id],
                )
                .map_err(e)?;
                conn.execute(
                    "INSERT OR REPLACE INTO sink_alias (old_id, new_id) VALUES (?1, ?2)",
                    params![there, id],
                )
                .map_err(e)?;
                add_voice(conn, &id, &who)?;
                recount(conn, &id)?;
            } else {
                conn.execute(
                    "INSERT OR REPLACE INTO sink_alias (old_id, new_id) VALUES (?1, ?2)",
                    params![id, there],
                )
                .map_err(e)?;
                add_voice(conn, &there, &who)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES ('p1', 'skein', 'C:/x', 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn ev(host: &str, seq: u64, what: What) -> Event {
        Event { stamp: Stamp { host: host.into(), seq }, what }
    }

    fn drop_ev(id: &str, title: &str, at: i64, host: &str, from: &str) -> What {
        What::Dropped {
            id: id.into(),
            scope: Some("skein".into()),
            kind: "bug".into(),
            title: title.into(),
            body: "b".into(),
            paths: String::new(),
            from: Some(from.into()),
            at,
            host: host.into(),
        }
    }

    fn rows(conn: &Connection) -> Vec<(String, i64, String, i64)> {
        let mut s = conn
            .prepare("SELECT id, voices, origin_host, dropped_at FROM sink_item ORDER BY id")
            .unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn a_local_drop_and_a_second_both_land_in_the_outbox_with_their_rows() {
        let conn = db();
        let me = crate::flyway::key::host_name();
        let first = store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", Some("c1")).unwrap();
        let again = store::put_sink_item(&conn, "x", Some("p1"), "bug", "t", "b2", "", Some("c2")).unwrap();
        assert_eq!((first.id.as_str(), again.merged, again.voices), ("a", true, 2));
        let sent = events_after(&conn, &BTreeMap::new()).unwrap();
        assert_eq!(sent.len(), 2);
        assert!(matches!(sent[0].what, What::Dropped { .. }));
        assert!(matches!(&sent[1].what, What::Seconded { by, .. } if by == "c2"));
        assert_eq!(sent[1].stamp, Stamp { host: me, seq: 2 });
        /* The same card again is not a voice, and says nothing. */
        store::put_sink_item(&conn, "y", Some("p1"), "bug", "t", "b3", "", Some("c2")).unwrap();
        assert_eq!(events_after(&conn, &BTreeMap::new()).unwrap().len(), 2);
    }

    #[test]
    fn a_failed_event_write_takes_the_row_change_with_it() {
        let conn = db();
        conn.execute_batch("DROP TABLE flyway_event").unwrap();
        let r = store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", None);
        assert!(r.is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM sink_item", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the pile and the log must not disagree");
    }

    #[test]
    fn the_outbox_answers_a_watermark() {
        let conn = db();
        let me = crate::flyway::key::host_name();
        store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", Some("c1")).unwrap();
        store::put_sink_item(&conn, "x", Some("p1"), "bug", "t", "b", "", Some("c2")).unwrap();
        store::put_sink_item(&conn, "z", Some("p1"), "bug", "u", "b", "", None).unwrap();
        assert_eq!(watermark(&conn).unwrap().get(&me), Some(&3));
        let have = BTreeMap::from([(me.clone(), 2)]);
        let rest = events_after(&conn, &have).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].stamp.seq, 3);
        assert!(events_after(&conn, &BTreeMap::from([(me, 3)])).unwrap().is_empty());
    }

    #[test]
    fn an_event_applied_twice_changes_nothing() {
        let conn = db();
        let es = [
            ev("desk", 1, drop_ev("a", "t", 10, "desk", "c1")),
            ev("desk", 2, What::Seconded { id: "a".into(), by: "c2".into() }),
            ev("desk", 3, What::Settled { id: "a".into(), note: "n".into(), at: 20 }),
        ];
        for e in &es {
            assert!(receive(&conn, e).unwrap());
        }
        let once = rows(&conn);
        for e in &es {
            assert!(!receive(&conn, e).unwrap(), "a known key is not news");
        }
        assert_eq!(once, rows(&conn));
        assert_eq!(once[0].1, 2);
    }

    #[test]
    fn a_twin_from_another_machine_folds_rather_than_doubling() {
        let conn = db();
        store::put_sink_item(&conn, "b", Some("p1"), "bug", "ask_user times out", "b", "", Some("c-local"))
            .unwrap();
        let local_at = rows(&conn)[0].3;
        /* The desk saw it first. */
        receive(&conn, &ev("desk", 1, drop_ev("a", "Ask_user times out", local_at - 5, "desk", "c-desk")))
            .unwrap();
        let r = rows(&conn);
        assert_eq!(r.len(), 1, "one finding however many machines saw it");
        assert_eq!(r[0].0, "a");
        assert_eq!(r[0].1, 2);
        assert_eq!(r[0].2, "desk", "the first machine's name is kept");
        /* And what is aimed at the loser still lands. */
        receive(&conn, &ev("desk", 2, What::Settled { id: "b".into(), note: "done".into(), at: local_at + 10 }))
            .unwrap();
        let settled: Option<i64> = conn
            .query_row("SELECT settled_at FROM sink_item WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert!(settled.is_some());
    }

    #[test]
    fn a_later_twin_keeps_the_local_item_and_adds_its_voice() {
        let conn = db();
        store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", Some("c1")).unwrap();
        let at = rows(&conn)[0].3;
        receive(&conn, &ev("lap", 1, drop_ev("b", "t", at + 100, "lap", "c2"))).unwrap();
        let r = rows(&conn);
        assert_eq!((r.len(), r[0].0.as_str(), r[0].1), (1, "a", 2));
        assert_eq!(r[0].2, crate::flyway::key::host_name());
    }

    #[test]
    fn a_voice_gained_on_each_side_survives() {
        let conn = db();
        store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", Some("c1")).unwrap();
        store::put_sink_item(&conn, "q", Some("p1"), "bug", "t", "b", "", Some("c2")).unwrap();
        let at = rows(&conn)[0].3;
        receive(&conn, &ev("lap", 1, drop_ev("b", "t", at + 1, "lap", "c3"))).unwrap();
        receive(&conn, &ev("lap", 2, What::Seconded { id: "b".into(), by: "c4".into() })).unwrap();
        assert_eq!(rows(&conn)[0].1, 4);
    }

    #[test]
    fn a_statement_before_its_drop_waits_and_then_lands() {
        let conn = db();
        receive(&conn, &ev("lap", 2, What::Seconded { id: "a".into(), by: "c2".into() })).unwrap();
        receive(&conn, &ev("lap", 3, What::Settled { id: "a".into(), note: "d".into(), at: 50 })).unwrap();
        assert!(rows(&conn).is_empty(), "nothing invented");
        receive(&conn, &ev("lap", 1, drop_ev("a", "t", 10, "lap", "c1"))).unwrap();
        let r = rows(&conn);
        assert_eq!(r[0].1, 2);
        let settled: Option<i64> = conn
            .query_row("SELECT settled_at FROM sink_item WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(settled, Some(50));
    }

    #[test]
    fn an_older_statement_arriving_late_does_not_undo_a_newer() {
        let conn = db();
        receive(&conn, &ev("d", 1, drop_ev("a", "t", 10, "d", "c1"))).unwrap();
        receive(&conn, &ev("d", 2, What::Settled { id: "a".into(), note: "new".into(), at: 50 })).unwrap();
        receive(&conn, &ev("l", 1, What::Unsettled { id: "a".into(), at: 20 })).unwrap();
        let note: Option<String> = conn
            .query_row("SELECT settled_note FROM sink_item WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note.as_deref(), Some("new"));
    }

    #[test]
    fn local_holds_settles_and_rewords_are_events_too() {
        let conn = db();
        store::put_sink_item(&conn, "a", Some("p1"), "bug", "t", "b", "", None).unwrap();
        assert!(store::hold_sink_item(&conn, "a", Some("c1"), None));
        assert!(store::hold_sink_item(&conn, "a", None, Some("c1")));
        assert!(store::edit_sink_item(&conn, "a", "note", "t2", "b", "", 0));
        assert!(store::settle_sink_item(&conn, "a", Some("done")));
        assert!(store::unsettle_sink_item(&conn, "a"));
        let kinds: Vec<&str> = events_after(&conn, &BTreeMap::new())
            .unwrap()
            .iter()
            .map(|e| match e.what {
                What::Dropped { .. } => "drop",
                What::Held { .. } => "held",
                What::Released { .. } => "released",
                What::Reworded { .. } => "reworded",
                What::Settled { .. } => "settled",
                What::Unsettled { .. } => "unsettled",
                What::Seconded { .. } => "seconded",
            })
            .collect();
        assert_eq!(kinds, ["drop", "held", "released", "reworded", "settled", "unsettled"]);
    }

    #[test]
    fn what_another_wall_says_is_scrubbed_before_a_card_reads_it() {
        let conn = db();
        let mut w = drop_ev("a", "t\u{0}itle", 10, "d", "c1");
        if let What::Dropped { body, .. } = &mut w {
            *body = "x\u{3}y".into();
        }
        receive(&conn, &ev("d", 1, w)).unwrap();
        let (t, b): (String, String) = conn
            .query_row("SELECT title, body FROM sink_item WHERE id = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((t.as_str(), b.as_str()), ("title", "xy"));
    }

    #[test]
    fn a_scope_this_wall_has_no_project_for_lands_wall_wide() {
        let conn = db();
        let mut w = drop_ev("a", "t", 10, "d", "c1");
        if let What::Dropped { scope, .. } = &mut w {
            *scope = Some("elsewhere".into());
        }
        receive(&conn, &ev("d", 1, w)).unwrap();
        let p: Option<String> = conn
            .query_row("SELECT project_id FROM sink_item WHERE id = 'a'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p, None);
    }
}
