//! The tables `migrate_v57` made, and the two transactions that are the whole
//! of the delivery guarantee: `ingest`, which turns one event into deliveries
//! and moves the checkpoint past it in one commit, and `claim`, which takes a
//! batch out before it is handed over.
//!
//! Here rather than in `store.rs` for `later.rs::all_armed`'s reason: these are
//! queries nothing else wants, over tables only this subsystem owns — and
//! `store.rs` is thirteen thousand lines that several cards edit at once.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::filter;

/// How far an event's enqueued time may sit *before* a subscription's creation
/// and still be delivered to it.
///
/// The rule Lyss approved is that a new subscription starts now: it is matched
/// only against events enqueued at or after it was made, so an old checkpoint
/// never hands it a backlog from before it existed. The two clocks in that
/// comparison are different machines — Azure stamps `x-opt-enqueued-time`,
/// this laptop stamps `created_at` — and the commonest first use is *subscribe,
/// then make an event to see it arrive*. With the strict comparison, Azure's
/// clock half a second behind this one silently drops exactly that event. Two
/// seconds of tolerance costs at most an event from the two seconds before the
/// call, which nobody can have been relying on not receiving.
pub const SKEW_MS: i64 = 2_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Sub {
    pub id: String,
    pub conversation_id: String,
    pub source: String,
    pub filter_json: String,
    pub note: String,
    pub every_ms: i64,
    pub created_at: i64,
    pub last_served_at: i64,
}

fn sub_of(r: &rusqlite::Row) -> rusqlite::Result<Sub> {
    Ok(Sub {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        source: r.get(2)?,
        filter_json: r.get(3)?,
        note: r.get(4)?,
        every_ms: r.get(5)?,
        created_at: r.get(6)?,
        last_served_at: r.get(7)?,
    })
}

const SUB_COLS: &str =
    "id, conversation_id, source, filter_json, note, every_ms, created_at, last_served_at";

pub fn add(conn: &Connection, s: &Sub) -> Result<(), String> {
    conn.execute(
        &format!("INSERT INTO subscription ({SUB_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
        params![
            s.id,
            s.conversation_id,
            s.source,
            s.filter_json,
            s.note,
            s.every_ms,
            s.created_at,
            s.last_served_at
        ],
    )
    .map_err(|e| format!("record subscription: {e}"))?;
    Ok(())
}

fn query(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Vec<Sub> {
    try_query(conn, sql, p).unwrap_or_default()
}

/// The same, failing loudly — for the two transactions, where an empty list
/// read off an error is not "nobody": in `ingest` it would checkpoint an event
/// nobody was given, and in `claim` it would clear every waiting row as an
/// orphan.
fn try_query(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Sub>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("read subscriptions: {e}"))?;
    let rows = stmt.query_map(p, sub_of).map_err(|e| format!("read subscriptions: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("read subscriptions: {e}"))
}

pub fn of_card(conn: &Connection, conversation_id: &str) -> Vec<Sub> {
    query(
        conn,
        &format!("SELECT {SUB_COLS} FROM subscription WHERE conversation_id = ?1 ORDER BY created_at"),
        [conversation_id],
    )
}

pub fn all(conn: &Connection) -> Vec<Sub> {
    query(conn, &format!("SELECT {SUB_COLS} FROM subscription ORDER BY created_at"), [])
}

/// The sources at least one subscription uses — the ones that should be
/// connected. No subscribers, no connection.
pub fn sources_in_use(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT DISTINCT source FROM subscription ORDER BY source") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return Vec::new() };
    rows.filter_map(Result::ok).collect()
}

pub fn count_on_source(conn: &Connection, source: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM subscription WHERE source = ?1", [source], |r| r.get(0))
        .unwrap_or(0)
}

/// Take one subscription away, with whatever it had matched and not yet
/// handed over. Checks the owner as well as the id, so a card cannot reach
/// another card's subscription.
pub fn remove(conn: &Connection, conversation_id: &str, id: &str) -> bool {
    let n = conn
        .execute(
            "DELETE FROM subscription WHERE id = ?1 AND conversation_id = ?2",
            params![id, conversation_id],
        )
        .unwrap_or(0);
    if n > 0 {
        let _ = conn.execute("DELETE FROM sub_pending WHERE subscription_id = ?1", [id]);
    }
    n > 0
}

/// Every subscription a card holds, for a card that is going or was cleared.
pub fn remove_card(conn: &Connection, conversation_id: &str) -> usize {
    let n = conn
        .execute("DELETE FROM subscription WHERE conversation_id = ?1", [conversation_id])
        .unwrap_or(0);
    let _ = conn.execute("DELETE FROM sub_pending WHERE conversation_id = ?1", [conversation_id]);
    n
}

/* ── where to start reading ─────────────────────────────────────────────── */

/// Where a partition's reader starts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Start {
    /// Strictly after this sequence number — the checkpoint.
    After(i64),
    /// Strictly after this enqueued time, in epoch milliseconds — a fresh start.
    Since(i64),
}

/// How far this wall has read a partition: `(sequence, enqueued_at)`.
pub fn checkpoint(conn: &Connection, source: &str, partition: &str) -> Option<(i64, i64)> {
    conn.query_row(
        "SELECT sequence, enqueued_at FROM source_checkpoint WHERE source = ?1 AND partition = ?2",
        params![source, partition],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn clear_checkpoints(conn: &Connection, source: &str) {
    let _ = conn.execute("DELETE FROM source_checkpoint WHERE source = ?1", [source]);
}

/// Where to start a partition, given its checkpoint and the oldest
/// subscription still using the source. Pure.
///
/// The checkpoint is exact and is preferred — it is what makes events that
/// arrived while the laptop slept or Volery was shut arrive now, once. But a
/// checkpoint *older than every current subscription* would only replay events
/// none of them is allowed to receive (`ingest`'s created-at rule), so the
/// reader starts at the oldest subscription instead, less the skew. That is also
/// the fresh start: a source never read before begins where its first
/// subscriber did, never at the beginning of the hub's retention.
pub fn start_for(check: Option<(i64, i64)>, oldest: i64) -> Start {
    let floor = oldest - SKEW_MS;
    match check {
        Some((seq, enqueued)) if enqueued >= floor => Start::After(seq),
        _ => Start::Since(floor),
    }
}

pub fn oldest_on(conn: &Connection, source: &str) -> Option<i64> {
    conn.query_row("SELECT MIN(created_at) FROM subscription WHERE source = ?1", [source], |r| {
        r.get::<_, Option<i64>>(0)
    })
    .ok()
    .flatten()
}

/* ── one event in ───────────────────────────────────────────────────────── */

/// One event off a source, already read into the two shapes the rest of this
/// subsystem wants.
#[derive(Debug, Clone, PartialEq)]
pub struct Arrival {
    pub partition: String,
    pub sequence: i64,
    pub enqueued_at: i64,
    /// Application properties overlaid by the body's own fields — what a
    /// filter is evaluated against. Body fields win.
    pub fields: Map<String, Value>,
    /// What the card is handed: one compact JSON line.
    pub line: String,
}

/// Match an event, write its deliveries and move the checkpoint past it — in
/// one transaction. Returns the cards that now have something waiting.
///
/// **An event at or before the checkpoint is skipped**, and that is what makes
/// a reconnect safe whatever the source replays: a receiver re-attached from a
/// slightly stale position, or the service re-sending after a dropped link,
/// produces nothing twice.
pub fn ingest(conn: &Connection, source: &str, ev: &Arrival, now: i64) -> Result<Vec<String>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("begin ingest: {e}"))?;
    if let Some((seq, _)) = checkpoint(conn, source, &ev.partition) {
        if ev.sequence <= seq {
            return Ok(Vec::new());
        }
    }
    let mut cards = Vec::new();
    let subs = try_query(
        conn,
        &format!("SELECT {SUB_COLS} FROM subscription WHERE source = ?1 ORDER BY created_at"),
        [source],
    )?;
    for s in subs {
        if ev.enqueued_at + SKEW_MS < s.created_at {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<Value>(&s.filter_json) else { continue };
        let Ok(f) = filter::compile(&raw) else { continue };
        if !filter::matches(&f, &ev.fields) {
            continue;
        }
        conn.execute(
            "INSERT INTO sub_pending (subscription_id, conversation_id, line, enqueued_at, arrived_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.id, s.conversation_id, ev.line, ev.enqueued_at, now],
        )
        .map_err(|e| format!("record delivery: {e}"))?;
        if !cards.contains(&s.conversation_id) {
            cards.push(s.conversation_id.clone());
        }
    }
    conn.execute(
        "INSERT INTO source_checkpoint (source, partition, sequence, enqueued_at, at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source, partition) DO UPDATE SET
           sequence = excluded.sequence, enqueued_at = excluded.enqueued_at, at = excluded.at",
        params![source, ev.partition, ev.sequence, ev.enqueued_at, now],
    )
    .map_err(|e| format!("checkpoint: {e}"))?;
    tx.commit().map_err(|e| format!("commit ingest: {e}"))?;
    Ok(cards)
}

/* ── a batch out ────────────────────────────────────────────────────────── */

/// The cards with anything waiting — what the engine picks up at start, after
/// a restart left deliveries in the table.
pub fn pending_cards(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare("SELECT DISTINCT conversation_id FROM sub_pending") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return Vec::new() };
    rows.filter_map(Result::ok).collect()
}

/// What one subscription has for the card in this batch.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub sub: Sub,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Claim {
    pub sections: Vec<Section>,
    /// Rows still waiting after this batch — over the per-turn cap, or on a
    /// subscription whose `every_ms` has not come round.
    pub remaining: usize,
    /// When the earliest of those may go, if any is held only by spacing.
    pub next_due: Option<i64>,
}

/// Take the batch a card may be handed now, out of the table, and stamp the
/// subscriptions it came from as served.
///
/// **Taken before it is delivered**, `later.rs::serve_due`'s ordering: a
/// delivery is a pipe write and a turn, and if this thread were interrupted
/// between the two, losing a batch is a card that waits for an event it
/// missed, where delivering one twice is a card handed the same events again —
/// and the second is what a subscription's whole reason for being exists to
/// stop. A batch that cannot reach a live card goes to its inbox instead
/// (`rouse`), so the ordinary failure of a delivery loses nothing.
///
/// `max_lines` caps one turn; what is over it waits for the next turn, which
/// is batching and not dropping. The oldest go first.
pub fn claim(conn: &Connection, conversation_id: &str, now: i64, max_lines: usize) -> Result<Claim, String> {
    let tx = conn.unchecked_transaction().map_err(|e| format!("begin claim: {e}"))?;
    let subs = try_query(
        conn,
        &format!("SELECT {SUB_COLS} FROM subscription WHERE conversation_id = ?1 ORDER BY created_at"),
        [conversation_id],
    )?;
    let due: Vec<&Sub> = subs.iter().filter(|s| s.last_served_at + s.every_ms <= now).collect();

    let mut rows: Vec<(i64, String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, subscription_id, line FROM sub_pending WHERE conversation_id = ?1 ORDER BY id")
            .map_err(|e| format!("read deliveries: {e}"))?;
        let it = stmt
            .query_map([conversation_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| format!("read deliveries: {e}"))?;
        for r in it.flatten() {
            rows.push(r);
        }
    }
    /* A row whose subscription has gone is an orphan of a cancel that raced an
       ingest; it has nobody to go to, so it is cleared rather than counted. */
    let known: Vec<&str> = subs.iter().map(|s| s.id.as_str()).collect();
    for (id, sub, _) in &rows {
        if !known.contains(&sub.as_str()) {
            let _ = conn.execute("DELETE FROM sub_pending WHERE id = ?1", [id]);
        }
    }
    rows.retain(|(_, sub, _)| known.contains(&sub.as_str()));

    let mut out = Claim::default();
    let mut left: Vec<&str> = Vec::new();
    let mut taken = 0usize;
    for (id, sub_id, line) in &rows {
        let sub = due.iter().find(|s| &s.id == sub_id);
        let Some(sub) = sub.filter(|_| taken < max_lines) else {
            left.push(sub_id);
            continue;
        };
        conn.execute("DELETE FROM sub_pending WHERE id = ?1", [id])
            .map_err(|e| format!("claim delivery: {e}"))?;
        taken += 1;
        match out.sections.iter_mut().find(|s| &s.sub.id == sub_id) {
            Some(sec) => sec.lines.push(line.clone()),
            None => out.sections.push(Section { sub: (*sub).clone(), lines: vec![line.clone()] }),
        }
    }
    for sec in &out.sections {
        conn.execute("UPDATE subscription SET last_served_at = ?1 WHERE id = ?2", params![now, sec.sub.id])
            .map_err(|e| format!("stamp subscription: {e}"))?;
    }
    out.remaining = left.len();
    /* The soonest anything still waiting may go: now for a row held only by
       the per-turn cap, the subscription's spacing for one that has not come
       round — counted from now for a subscription this batch just served. */
    let served: Vec<&str> = out.sections.iter().map(|s| s.sub.id.as_str()).collect();
    out.next_due = subs
        .iter()
        .filter(|s| left.contains(&s.id.as_str()))
        .map(|s| {
            let last = if served.contains(&s.id.as_str()) { now } else { s.last_served_at };
            (last + s.every_ms).max(now)
        })
        .min();
    tx.commit().map_err(|e| format!("commit claim: {e}"))?;
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::store::migrate(&c).unwrap();
        c
    }

    pub fn sub(id: &str, card: &str, filter: Value, created_at: i64, every_ms: i64) -> Sub {
        Sub {
            id: id.into(),
            conversation_id: card.into(),
            source: "nova-feedback".into(),
            filter_json: filter.to_string(),
            note: format!("note for {id}"),
            every_ms,
            created_at,
            last_served_at: 0,
        }
    }

    pub fn arrival(partition: &str, seq: i64, enqueued_at: i64, fields: Value) -> Arrival {
        Arrival {
            partition: partition.into(),
            sequence: seq,
            enqueued_at,
            line: fields.to_string(),
            fields: fields.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn an_event_goes_to_the_subscriptions_it_matches_and_moves_the_checkpoint() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({"channel": "ui"}), 1_000, 0)).unwrap();
        add(&c, &sub("b", "card-b", json!({"channel": "mcp"}), 1_000, 0)).unwrap();
        let got = ingest(&c, "nova-feedback", &arrival("0", 5, 2_000, json!({"channel": "ui"})), 2_100).unwrap();
        assert_eq!(got, vec!["card-a".to_string()]);
        assert_eq!(checkpoint(&c, "nova-feedback", "0"), Some((5, 2_000)));
        assert_eq!(pending_cards(&c), vec!["card-a".to_string()]);
    }

    /// The checkpoint moves even when nothing matched — an event nobody wanted
    /// is still an event this wall has read.
    #[test]
    fn a_non_matching_event_is_read_past_and_delivers_nothing() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({"channel": "ui"}), 1_000, 0)).unwrap();
        let got = ingest(&c, "nova-feedback", &arrival("1", 9, 2_000, json!({"channel": "sync"})), 2_100).unwrap();
        assert!(got.is_empty());
        assert!(pending_cards(&c).is_empty());
        assert_eq!(checkpoint(&c, "nova-feedback", "1"), Some((9, 2_000)));
    }

    #[test]
    fn a_replayed_event_is_not_delivered_twice() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({}), 1_000, 0)).unwrap();
        let ev = arrival("0", 5, 2_000, json!({"n": 1}));
        assert_eq!(ingest(&c, "nova-feedback", &ev, 2_100).unwrap().len(), 1);
        assert!(ingest(&c, "nova-feedback", &ev, 2_200).unwrap().is_empty());
        let older = arrival("0", 4, 1_900, json!({"n": 0}));
        assert!(ingest(&c, "nova-feedback", &older, 2_300).unwrap().is_empty());
        let claim = claim(&c, "card-a", 3_000, 100).unwrap();
        assert_eq!(claim.sections[0].lines.len(), 1);
    }

    /// A subscription never receives backlog from before it existed, however
    /// old the source's checkpoint — with the skew's two seconds of slack.
    #[test]
    fn a_new_subscription_starts_now() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({}), 100_000, 0)).unwrap();
        assert!(ingest(&c, "nova-feedback", &arrival("0", 1, 50_000, json!({})), 101_000).unwrap().is_empty());
        assert!(!ingest(&c, "nova-feedback", &arrival("0", 2, 99_000, json!({})), 101_000).unwrap().is_empty());
    }

    #[test]
    fn a_fresh_start_begins_at_the_oldest_subscriber_and_a_stale_checkpoint_is_skipped() {
        assert_eq!(start_for(None, 100_000), Start::Since(100_000 - SKEW_MS));
        assert_eq!(start_for(Some((40, 120_000)), 100_000), Start::After(40));
        assert_eq!(start_for(Some((40, 10_000)), 100_000), Start::Since(100_000 - SKEW_MS));
    }

    #[test]
    fn a_claim_takes_the_batch_out_and_leaves_the_overflow() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({}), 0, 0)).unwrap();
        for seq in 1..=5 {
            ingest(&c, "nova-feedback", &arrival("0", seq, 1_000 + seq, json!({"n": seq})), 2_000).unwrap();
        }
        let first = claim(&c, "card-a", 3_000, 3).unwrap();
        assert_eq!(first.sections.len(), 1);
        assert_eq!(first.sections[0].lines, vec![r#"{"n":1}"#, r#"{"n":2}"#, r#"{"n":3}"#]);
        assert_eq!(first.remaining, 2);
        assert_eq!(first.next_due, Some(3_000), "held by the cap alone, so due at once");
        let second = claim(&c, "card-a", 3_001, 3).unwrap();
        assert_eq!(second.sections[0].lines.len(), 2);
        assert_eq!(second.remaining, 0);
        assert!(claim(&c, "card-a", 3_002, 3).unwrap().sections.is_empty());
    }

    #[test]
    fn every_minutes_holds_a_subscription_until_its_spacing_comes_round() {
        let c = db();
        add(&c, &sub("slow", "card-a", json!({}), 0, 600_000)).unwrap();
        ingest(&c, "nova-feedback", &arrival("0", 1, 1_000, json!({})), 2_000).unwrap();
        let first = claim(&c, "card-a", 700_000, 100).unwrap();
        assert_eq!(first.sections.len(), 1, "never served, so due at once");
        ingest(&c, "nova-feedback", &arrival("0", 2, 700_100, json!({})), 700_200).unwrap();
        let held = claim(&c, "card-a", 800_000, 100).unwrap();
        assert!(held.sections.is_empty());
        assert_eq!(held.remaining, 1);
        assert_eq!(held.next_due, Some(1_300_000));
        assert_eq!(claim(&c, "card-a", 1_300_000, 100).unwrap().sections.len(), 1);
    }

    #[test]
    fn a_cancelled_or_cleared_subscription_takes_its_deliveries_with_it() {
        let c = db();
        add(&c, &sub("a", "card-a", json!({}), 0, 0)).unwrap();
        add(&c, &sub("b", "card-a", json!({}), 0, 0)).unwrap();
        ingest(&c, "nova-feedback", &arrival("0", 1, 1_000, json!({})), 2_000).unwrap();
        assert!(!remove(&c, "card-b", "a"), "another card's subscription is out of reach");
        assert!(remove(&c, "card-a", "a"));
        let left = claim(&c, "card-a", 3_000, 100).unwrap();
        assert_eq!(left.sections.len(), 1);
        assert_eq!(left.sections[0].sub.id, "b");
        ingest(&c, "nova-feedback", &arrival("0", 2, 1_500, json!({})), 2_000).unwrap();
        assert_eq!(remove_card(&c, "card-a"), 1);
        assert!(pending_cards(&c).is_empty());
        assert!(sources_in_use(&c).is_empty());
        /* With nothing subscribed, an event is read past and goes nowhere. */
        assert!(ingest(&c, "nova-feedback", &arrival("0", 3, 1_600, json!({})), 2_000).unwrap().is_empty());
    }
}
