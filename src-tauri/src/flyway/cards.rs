//! What the cards on each wall look like, as the wall that holds them says.
//!
//! The dashboard half of the flyway: a card hosted on the laptop drawn on the
//! desk. **This file carries the drawing and never reads it.** What a card's
//! digest *contains* — tier, ending, context, the last line said — is decided by
//! the owning wall's front end, because the taxonomy that produces it lives in
//! `classify.ts` and a second copy of it in Rust would drift silently, on the
//! machine you cannot see. So a snapshot is a `serde_json::Value`, opaque here,
//! with a normaliser on the reading side: the same bargain `widget.config_json`
//! strikes, and for the same reason — a field added next month costs no Rust
//! change and no version lockstep between two walls.
//!
//! ### One snapshot per wall, replaced whole
//!
//! The reader takes a card missing from the next snapshot to be closed, so
//! there are no tombstones and nothing to merge — the newest snapshot from a
//! host *is* that host's wall. Two consequences follow, and both live here:
//!
//! - **Newer wins, by a version that only rises for that host.** A snapshot
//!   that arrives late — a slow push overtaken by a tick — must never overwrite
//!   the one after it. The version is persisted for `Fleet::announce`'s reason:
//!   a wall restarted after its clock was corrected backwards would otherwise
//!   publish versions every peer has already passed, and be drawn frozen.
//! - **Nothing is sent until there is something true to send.** Absence means
//!   closed, so a snapshot taken while the wall was still painting itself from
//!   SQLite would read on the other machine as every card closing at once. The
//!   front end publishes only once it has loaded; this side sends nothing until
//!   it has been handed something, which is the half of that guard a receiver
//!   could never supply — it cannot tell a partial wall from a quiet one.
//!
//! ### An age, counted from the moment it was published
//!
//! `Heard`'s rule from `fleet.rs`, with the producing wall counted as a
//! holder: the age a snapshot travels with is the time since the front end
//! handed it over, including however long it sat here before a connection
//! carried it. The reader needs that rather than "when was this host last heard
//! from", because cards carry a resting-since on the producer's clock and idle
//! time is computed as producer-clock differences plus this age — so clock skew
//! between the two machines never enters. Liveness is a separate question, and
//! the roster answers it (`Entry::quiet_for`): a wall whose cards have not
//! changed for an hour sends an hour-old snapshot and is perfectly awake.
//!
//! ### Not relayed
//!
//! Unlike the roster, a snapshot goes only from the wall that made it to the
//! walls it talks to. A third wall passing on what the laptop looked like an
//! hour ago would be drawing history as a dashboard, and every wall dials every
//! wall it knows, so there is nobody a relay would reach that a dial does not.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The most one snapshot may weigh, serialised. A real one is a kilobyte a
/// card; this is a bound on what a confused peer can make us hold and draw,
/// not a budget anybody is expected to approach.
pub const MAX_SNAPSHOT: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum CardsMsg {
    /// One wall's cards, whole.
    Cards { host: String, version: u64, age_ms: u64, snapshot: Value },
}

/// A snapshot as this wall holds it.
#[derive(Debug, Clone)]
struct Held {
    version: u64,
    /// When the producing wall published it, estimated on *this* wall's clock.
    published_at: i64,
    snapshot: Value,
}

/// A peer's snapshot that was news, for the wiring to hand the front end.
#[derive(Debug, Clone, PartialEq)]
pub struct Arrived {
    pub host: String,
    pub age_ms: u64,
    pub snapshot: Value,
}

pub struct Cards {
    me: String,
    mine: Option<Held>,
    last_version: u64,
    theirs: BTreeMap<String, Held>,
}

impl Cards {
    /// `last_version` is what `version()` returned the last time this wall ran.
    pub fn new(me: &str, last_version: u64) -> Self {
        Self { me: me.to_string(), mine: None, last_version, theirs: BTreeMap::new() }
    }

    pub fn version(&self) -> u64 {
        self.last_version
    }

    /// The front end's latest snapshot of this wall. Refused rather than cut
    /// when it is too large: a snapshot with cards missing reads as those
    /// cards having closed, which is worse than the previous one standing.
    pub fn publish(&mut self, snapshot: Value, now: i64) -> Result<(), String> {
        let size = serde_json::to_vec(&snapshot).map(|b| b.len()).unwrap_or(usize::MAX);
        if size > MAX_SNAPSHOT {
            return Err(format!(
                "that snapshot is {size} bytes and a wall's cards may be at most {MAX_SNAPSHOT} — \
                 the previous one still stands"
            ));
        }
        let version = (now.max(0) as u64).max(self.last_version.saturating_add(1));
        self.last_version = version;
        self.mine = Some(Held { version, published_at: now, snapshot });
        Ok(())
    }

    /// What to tell a peer about this wall, or nothing if the front end has
    /// not published yet — see the module note on why silence is the guard.
    pub fn say(&self, now: i64) -> Option<CardsMsg> {
        let h = self.mine.as_ref()?;
        Some(CardsMsg::Cards {
            host: self.me.clone(),
            version: h.version,
            age_ms: age(now, h.published_at),
            snapshot: h.snapshot.clone(),
        })
    }

    /// Fold a peer's snapshot in. Returns it if it was news.
    pub fn on(&mut self, m: CardsMsg, now: i64) -> Option<Arrived> {
        let CardsMsg::Cards { host, version, age_ms, snapshot } = m;
        let host = crate::clean::scrub(&host).into_owned();
        /* A statement about this wall from outside is either an echo or a
           namesake; neither is a picture of anything this wall should draw. */
        if host == self.me || host.is_empty() {
            return None;
        }
        if serde_json::to_vec(&snapshot).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_SNAPSHOT {
            return None;
        }
        if self.theirs.get(&host).is_some_and(|h| h.version >= version) {
            return None;
        }
        let snapshot = scrubbed(snapshot);
        let published_at = now.saturating_sub(age_ms.min(i64::MAX as u64) as i64);
        self.theirs.insert(host.clone(), Held { version, published_at, snapshot: snapshot.clone() });
        Some(Arrived { host, age_ms: age(now, published_at), snapshot })
    }

    /// Every peer's latest snapshot, with its age now.
    pub fn theirs(&self, now: i64) -> Vec<Arrived> {
        self.theirs
            .iter()
            .map(|(host, h)| Arrived { host: host.clone(), age_ms: age(now, h.published_at), snapshot: h.snapshot.clone() })
            .collect()
    }

    /// Take a wall off — when a person forgets it from the roster.
    pub fn forget(&mut self, host: &str) {
        self.theirs.remove(host);
    }
}

/// Every string in a snapshot, scrubbed of characters an agent could not send.
///
/// The reader is a front end, but what it draws is read off the wall by agents
/// too — a card's last line quoted into a `list`, a title into a brief — and
/// CLAUDE.md's rule is that a text somebody else will read may not carry one.
/// Walked rather than re-encoded, so keys and structure come through untouched.
fn scrubbed(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(crate::clean::scrub(&s).into_owned()),
        Value::Array(a) => Value::Array(a.into_iter().map(scrubbed).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter().map(|(k, v)| (crate::clean::scrub(&k).into_owned(), scrubbed(v))).collect(),
        ),
        other => other,
    }
}

fn age(now: i64, at: i64) -> u64 {
    now.saturating_sub(at).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snap(n: u64) -> Value {
        json!({ "v": 1, "at": n, "cards": [{ "id": format!("c{n}") }] })
    }

    #[test]
    fn nothing_is_said_until_the_wall_has_published() {
        let c = Cards::new("desk", 0);
        assert!(c.say(10).is_none(), "a wall that has not loaded must not claim it has no cards");
    }

    #[test]
    fn a_snapshot_crosses_with_its_age_from_publish() {
        let mut desk = Cards::new("desk", 0);
        let mut lap = Cards::new("lap", 0);
        desk.publish(snap(1), 1_000).unwrap();
        /* Held on the desk for four seconds before a connection carried it. */
        let m = desk.say(5_000).unwrap();
        let got = lap.on(m, 90_000).unwrap();
        assert_eq!(got.host, "desk");
        assert_eq!(got.age_ms, 4_000, "the age is from publish, not from the send");
        assert_eq!(got.snapshot, snap(1));
        /* And it keeps ageing on the reader's clock. */
        assert_eq!(lap.theirs(91_000)[0].age_ms, 5_000);
    }

    /// A slow push overtaken by a tick must not overwrite what came after it.
    #[test]
    fn an_older_snapshot_never_replaces_a_newer_one() {
        let mut desk = Cards::new("desk", 0);
        let mut lap = Cards::new("lap", 0);
        desk.publish(snap(1), 100).unwrap();
        let old = desk.say(100).unwrap();
        desk.publish(snap(2), 200).unwrap();
        let new = desk.say(200).unwrap();
        assert!(lap.on(new.clone(), 300).is_some());
        assert!(lap.on(old, 300).is_none());
        assert!(lap.on(new, 300).is_none(), "a repeat is not news");
        assert_eq!(lap.theirs(300)[0].snapshot, snap(2));
    }

    /// The restart after a clock correction: the persisted version carries on
    /// rising even when the clock does not.
    #[test]
    fn a_restart_with_a_slow_clock_still_publishes_newer() {
        let mut before = Cards::new("desk", 0);
        before.publish(snap(1), 5_000_000).unwrap();
        let mut after = Cards::new("desk", before.version());
        after.publish(snap(2), 1_000).unwrap();
        assert!(after.version() > before.version());
    }

    #[test]
    fn an_echo_of_this_wall_is_not_drawn() {
        let mut desk = Cards::new("desk", 0);
        desk.publish(snap(1), 0).unwrap();
        let mine = desk.say(0).unwrap();
        assert!(desk.on(mine, 0).is_none());
        assert!(desk.theirs(0).is_empty());
    }

    #[test]
    fn a_snapshot_too_large_is_refused_and_the_last_one_stands() {
        let mut desk = Cards::new("desk", 0);
        desk.publish(snap(1), 0).unwrap();
        let huge = json!({ "cards": ["x".repeat(MAX_SNAPSHOT)] });
        assert!(desk.publish(huge, 1).is_err());
        assert_eq!(desk.say(1).map(|m| match m { CardsMsg::Cards { snapshot, .. } => snapshot }), Some(snap(1)));
    }

    #[test]
    fn what_arrives_carries_no_character_an_agent_could_not_send() {
        let mut lap = Cards::new("lap", 0);
        let m = CardsMsg::Cards {
            host: "de\u{0}sk".into(),
            version: 1,
            age_ms: 0,
            snapshot: json!({ "cards": [{ "said": "bro\u{7}ken" }] }),
        };
        let got = lap.on(m, 0).unwrap();
        assert_eq!(got.host, "desk");
        assert_eq!(got.snapshot, json!({ "cards": [{ "said": "broken" }] }));
    }
}
