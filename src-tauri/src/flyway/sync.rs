//! How two walls that have been apart agree about one sink.
//!
//! The sink is the first thing to cross the flyway, and it is the right first
//! thing: low volume, high value, and nothing about it is urgent — a finding
//! that arrives four seconds late is a finding. What it *is* is a pile several
//! machines write to independently and then have to agree about, which is the
//! whole difficulty in miniature.
//!
//! ### Events, not rows
//!
//! The obvious design ships the row and takes the newer one. It is wrong on one
//! field and that field is the one the sink exists for. Two walls each second
//! the same item while apart; each ships a row saying `voices: 2`; last-writer-
//! wins yields 2, and the third voice is gone with nothing anywhere to say so.
//! Shipping *what happened* instead of *what is* makes that case arithmetic
//! rather than a race: a voice is a name in a set, and a set survives being
//! merged in either order.
//!
//! So everything here is an `Event`, every event is idempotent, and `Ledger`
//! folds a bag of them into item state. The fold must not care what order they
//! arrive in — `events_in_any_order_agree` is the property, and it is the one
//! test worth keeping if all the others went.
//!
//! ### The twin, and why both sides must pick the same survivor
//!
//! `sink.rs` merges on the **title**, so one finding dropped by two cards on
//! one wall is one item with two voices. Across a flyway the same finding gets
//! dropped on two machines *with two different uuids*, which is the same event
//! the merge exists to prevent, now wearing an id that makes it look distinct.
//! If each wall simply inserted what it received, a shared sink would grow a
//! twin per machine — and it would do it precisely where a shared pile makes
//! twins most likely, which is the failure the whole feature would be judged on.
//!
//! So a `Dropped` whose title already exists is folded, and the survivor is
//! chosen by a rule both sides can compute **without talking**: the earliest
//! `at`, and the lower id to break a tie. Deterministic from the data alone,
//! so two walls that never exchange another word still agree. The loser's id
//! becomes an alias, because events naming it are already in flight.
//!
//! ### What is deliberately not here
//!
//! No transport, no store writes, no clock. This file is pure so that the hard
//! part — *do these two piles end up the same* — can be tested without a second
//! machine, a network, or a database. Wiring it to `store::sink_item` and to a
//! socket are the two pieces that follow, and neither can make this wrong.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// Who said it and in what order *they* said it.
///
/// Per-host and monotonic, so a receiver can say "I have everything from you up
/// to 41" in one number and be sent only what it is missing. Deliberately not a
/// wall-clock: machine clocks disagree by seconds, and ordering two events by
/// them would make the fold depend on whose clock was fast.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Stamp {
    pub host: String,
    pub seq: u64,
}

/// A thing that happened to the sink.
///
/// `at` is a wall-clock millisecond and is used **only** where the semantics
/// genuinely are "the most recent statement wins" — settling, holding,
/// rewording. It never orders the fold. See `Stamp`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum What {
    Dropped {
        id: String,
        /// The project's shared identity, or `None` for a wall-wide item.
        scope: Option<String>,
        kind: String,
        title: String,
        body: String,
        paths: String,
        /// The card that dropped it, or `None` when a person did.
        from: Option<String>,
        at: i64,
        /// Which machine saw it first. Attribution, never identity — it plays
        /// no part in matching, exactly as in `store::SinkItem::origin_host`.
        host: String,
    },
    /// Somebody else has hit this too.
    Seconded { id: String, by: String },
    Held { id: String, by: String, at: i64 },
    Released { id: String, at: i64 },
    Settled { id: String, note: String, at: i64 },
    Unsettled { id: String, at: i64 },
    Reworded {
        id: String,
        kind: String,
        title: String,
        body: String,
        paths: String,
        at: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub stamp: Stamp,
    #[serde(flatten)]
    pub what: What,
}

impl What {
    /// The item an event is about, before aliasing.
    fn id(&self) -> &str {
        match self {
            What::Dropped { id, .. }
            | What::Seconded { id, .. }
            | What::Held { id, .. }
            | What::Released { id, .. }
            | What::Settled { id, .. }
            | What::Unsettled { id, .. }
            | What::Reworded { id, .. } => id,
        }
    }
}

/// One item, as a fold of everything said about it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Item {
    pub id: String,
    pub scope: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub paths: String,
    pub dropped_at: i64,
    pub origin_host: String,
    /// Everybody who has dropped or seconded it. A **set**, which is the whole
    /// reason this file ships events: re-delivering a `Seconded` cannot inflate
    /// it, and two walls merging cannot lose one.
    pub voices: BTreeSet<String>,
    pub held_by: Option<String>,
    held_at: i64,
    pub settled_note: Option<String>,
    settled_at: i64,
    pub settled: bool,
    worded_at: i64,
}

impl Item {
    /// What a listing shows. One plus the seconders in the single-wall case,
    /// which is what `sink_item.voices` already counts.
    pub fn voice_count(&self) -> usize {
        self.voices.len().max(1)
    }
}

/// Every item this wall knows about, however it heard.
#[derive(Debug, Default)]
pub struct Ledger {
    items: BTreeMap<String, Item>,
    /// An id that lost a twin merge, pointing at the one that won. Events
    /// naming the loser are already in flight when the merge happens, and they
    /// are about the same finding — so they are followed here rather than
    /// dropped.
    aliases: BTreeMap<String, String>,
    /// The furthest `seq` seen from each host, which is what a reconnect sends
    /// so it is told only what it is missing.
    seen: BTreeMap<String, u64>,
    /// Statements about an item this wall has not heard of yet.
    ///
    /// **Not an edge case: this is the ordinary shape of two machines.** The
    /// laptop seconds a finding the desk dropped, and the second can easily
    /// reach a third wall before the drop does — different hosts, different
    /// connections, no ordering between them. Dropping those on the floor was
    /// the first cut and it broke the one property this file exists to have:
    /// `events_in_any_order_agree` failed with a hold and a settling simply
    /// missing, because they had arrived three events too early.
    ///
    /// Held by the id as it was *written*, not as it resolves, since the whole
    /// problem is that nothing is known about that id yet.
    pending: BTreeMap<String, Vec<Event>>,
}

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// What to ask each host for on reconnect: everything after this.
    pub fn watermark(&self) -> BTreeMap<String, u64> {
        self.seen.clone()
    }

    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.items.values()
    }

    pub fn get(&self, id: &str) -> Option<&Item> {
        self.items.get(self.resolve(id).as_str())
    }

    fn resolve(&self, id: &str) -> String {
        /* One hop is not enough: a twin merged into a twin leaves a chain, and
           a wall that learns the two merges in the other order builds the chain
           the other way round. Bounded by the number of aliases so a cycle —
           which the ordering rule makes impossible, but which a corrupt frame
           could still describe — cannot spin here. */
        let mut at = id.to_string();
        for _ in 0..self.aliases.len() + 1 {
            match self.aliases.get(&at) {
                Some(next) => at = next.clone(),
                None => break,
            }
        }
        at
    }

    /// Fold one event in. Idempotent, and order-independent.
    pub fn apply(&mut self, e: &Event) {
        let seen = self.seen.entry(e.stamp.host.clone()).or_insert(0);
        *seen = (*seen).max(e.stamp.seq);

        let id = self.resolve(e.what.id());

        /* A statement about something not yet known is kept rather than lost —
           see `pending`. The drop that explains it is on its way, and may be
           seconds behind over a different connection. */
        if !matches!(e.what, What::Dropped { .. }) && !self.items.contains_key(&id) {
            self.pending.entry(id).or_default().push(e.clone());
            return;
        }

        match &e.what {
            What::Dropped { scope, kind, title, body, paths, from, at, host, .. } => {
                /* The twin: the same finding, dropped independently on two
                   machines, arriving with an id this wall has never seen. */
                let existing = self
                    .items
                    .values()
                    .find(|i| i.title == *title && i.scope == *scope && i.id != id)
                    .map(|i| i.id.clone());

                let fresh = Item {
                    id: id.clone(),
                    scope: scope.clone(),
                    kind: kind.clone(),
                    title: title.clone(),
                    body: body.clone(),
                    paths: paths.clone(),
                    dropped_at: *at,
                    origin_host: host.clone(),
                    voices: BTreeSet::from([from.clone().unwrap_or_else(|| host.clone())]),
                    ..Default::default()
                };

                match existing {
                    None => {
                        /* A re-delivery must not reset what has been said since.
                           The drop is the one event whose fields are the item's
                           starting point rather than a statement about it. */
                        self.items.entry(id).or_insert(fresh);
                    }
                    Some(other) => self.fold_twins(fresh, &other),
                }
                self.release_pending();
            }
            What::Seconded { by, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    i.voices.insert(by.clone());
                }
            }
            What::Held { by, at, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    if *at >= i.held_at {
                        i.held_at = *at;
                        i.held_by = Some(by.clone());
                    }
                }
            }
            What::Released { at, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    if *at >= i.held_at {
                        i.held_at = *at;
                        i.held_by = None;
                    }
                }
            }
            What::Settled { note, at, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    if *at >= i.settled_at {
                        i.settled_at = *at;
                        i.settled = true;
                        i.settled_note = Some(note.clone());
                    }
                }
            }
            What::Unsettled { at, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    if *at >= i.settled_at {
                        i.settled_at = *at;
                        i.settled = false;
                        i.settled_note = None;
                    }
                }
            }
            What::Reworded { kind, title, body, paths, at, .. } => {
                if let Some(i) = self.items.get_mut(&id) {
                    if *at >= i.worded_at {
                        i.worded_at = *at;
                        i.kind = kind.clone();
                        i.title = title.clone();
                        i.body = body.clone();
                        i.paths = paths.clone();
                    }
                }
            }
        }
    }

    /// Replay everything that was waiting for an item that now exists.
    ///
    /// Run after a drop, which is the only event that can make an unknown id
    /// known — and after a *twin merge* too, since that is how statements aimed
    /// at an id this wall never saw a drop for become answerable: the id
    /// resolves through an alias to the survivor.
    ///
    /// Re-applying cannot re-pend, because `items` now holds the resolved id,
    /// so this terminates without needing a bound.
    fn release_pending(&mut self) {
        let ready: Vec<String> = self
            .pending
            .keys()
            .filter(|k| self.items.contains_key(&self.resolve(k)))
            .cloned()
            .collect();
        for k in ready {
            if let Some(waiting) = self.pending.remove(&k) {
                for e in waiting {
                    self.apply(&e);
                }
            }
        }
    }

    /// Two ids for one finding become one, the same way on every wall.
    ///
    /// **The survivor is computed from the data alone** — earliest `dropped_at`,
    /// lower id to break the tie — because two walls may perform this merge
    /// without ever exchanging another word about it, and a rule that depended
    /// on who merged first would leave them disagreeing for ever.
    ///
    /// The voices are unioned rather than added, which is the point of holding
    /// them as a set: the two sides overlap by at least the person who dropped
    /// it on each, and adding would count them twice.
    fn fold_twins(&mut self, fresh: Item, other: &str) {
        let Some(there) = self.items.get(other).cloned() else { return };
        let (keep, gone) = if (fresh.dropped_at, fresh.id.as_str())
            <= (there.dropped_at, there.id.as_str())
        {
            (fresh, there)
        } else {
            (there, fresh)
        };

        let mut keeper = keep.clone();
        keeper.voices.extend(gone.voices.iter().cloned());
        /* Everything said about the loser since is kept: a hold, a settling or
           a rewording on either id is about this finding. Latest wins, which is
           the rule each of those fields already follows. */
        if gone.held_at > keeper.held_at {
            keeper.held_at = gone.held_at;
            keeper.held_by = gone.held_by.clone();
        }
        if gone.settled_at > keeper.settled_at {
            keeper.settled_at = gone.settled_at;
            keeper.settled = gone.settled;
            keeper.settled_note = gone.settled_note.clone();
        }
        if gone.worded_at > keeper.worded_at {
            keeper.worded_at = gone.worded_at;
            keeper.kind = gone.kind.clone();
            keeper.title = gone.title.clone();
            keeper.body = gone.body.clone();
            keeper.paths = gone.paths.clone();
        }

        let keep_id = keeper.id.clone();
        self.items.remove(&gone.id);
        self.items.insert(keep_id.clone(), keeper);
        if gone.id != keep_id {
            self.aliases.insert(gone.id, keep_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(host: &str, seq: u64, what: What) -> Event {
        Event { stamp: Stamp { host: host.into(), seq }, what }
    }

    fn dropped(id: &str, title: &str, at: i64, host: &str, from: Option<&str>) -> What {
        What::Dropped {
            id: id.into(),
            scope: Some("skein".into()),
            kind: "bug".into(),
            title: title.into(),
            body: "b".into(),
            paths: String::new(),
            from: from.map(str::to_string),
            at,
            host: host.into(),
        }
    }

    fn fold(events: &[Event]) -> Ledger {
        let mut l = Ledger::new();
        for e in events {
            l.apply(e);
        }
        l
    }

    /// **The property.** Two walls hear the same things in different orders and
    /// must end up the same, or a shared sink is two piles that look alike.
    #[test]
    fn events_in_any_order_agree() {
        let es = vec![
            ev("desk", 1, dropped("a", "ask_user times out", 10, "desk", Some("card-1"))),
            ev("lap", 1, dropped("b", "ask_user times out", 20, "lap", Some("card-2"))),
            ev("lap", 2, What::Seconded { id: "b".into(), by: "card-3".into() }),
            ev("desk", 2, What::Held { id: "a".into(), by: "card-1".into(), at: 30 }),
            ev("desk", 3, What::Settled { id: "a".into(), note: "fixed".into(), at: 40 }),
        ];

        let forward = fold(&es);
        let mut reversed = es.clone();
        reversed.reverse();
        let backward = fold(&reversed);

        let one: Vec<_> = forward.items().cloned().collect();
        let two: Vec<_> = backward.items().cloned().collect();
        assert_eq!(one, two, "the fold must not depend on arrival order");
        assert_eq!(one.len(), 1, "one finding, however many machines saw it");
    }

    /// Re-delivery is normal — a reconnect replays, and a frame can arrive
    /// twice. None of it may change anything.
    #[test]
    fn applying_everything_twice_changes_nothing() {
        let es = vec![
            ev("desk", 1, dropped("a", "t", 10, "desk", Some("card-1"))),
            ev("desk", 2, What::Seconded { id: "a".into(), by: "card-2".into() }),
            ev("desk", 3, What::Settled { id: "a".into(), note: "n".into(), at: 20 }),
        ];
        let once: Vec<_> = fold(&es).items().cloned().collect();

        let mut twice = es.clone();
        twice.extend(es);
        let again: Vec<_> = fold(&twice).items().cloned().collect();

        assert_eq!(once, again);
        assert_eq!(once[0].voice_count(), 2);
    }

    /// The failure the whole feature would be judged on: a shared sink growing
    /// a twin per machine, exactly where the title merge is most needed.
    #[test]
    fn the_same_finding_on_two_machines_is_one_item() {
        let l = fold(&[
            ev("desk", 1, dropped("a", "ask_user times out", 10, "desk", Some("card-1"))),
            ev("lap", 1, dropped("b", "ask_user times out", 20, "lap", Some("card-2"))),
        ]);
        let all: Vec<_> = l.items().collect();
        assert_eq!(all.len(), 1);
        /* The earlier drop survives, and keeps the machine that saw it first. */
        assert_eq!(all[0].id, "a");
        assert_eq!(all[0].origin_host, "desk");
        assert_eq!(all[0].voice_count(), 2, "both cards are voices on the one item");
        /* And the loser's id still finds it, because events naming it are in
           flight at the moment of the merge. */
        assert_eq!(l.get("b").map(|i| i.id.as_str()), Some("a"));
    }

    /// Two walls merge the same twins without talking, so the rule has to be a
    /// function of the data. Here they learn the two drops in opposite orders.
    #[test]
    fn both_walls_keep_the_same_survivor_without_talking() {
        let a = ev("desk", 1, dropped("a", "t", 10, "desk", Some("c1")));
        let b = ev("lap", 1, dropped("b", "t", 20, "lap", Some("c2")));
        let desk = fold(&[a.clone(), b.clone()]);
        let lap = fold(&[b, a]);
        assert_eq!(
            desk.items().map(|i| i.id.clone()).collect::<Vec<_>>(),
            lap.items().map(|i| i.id.clone()).collect::<Vec<_>>(),
        );
    }

    /// Simultaneous drops — the same millisecond on two machines — still have
    /// to settle, or the tie is decided by whoever asked first.
    #[test]
    fn a_tie_on_the_clock_is_broken_by_the_id() {
        let l = fold(&[
            ev("desk", 1, dropped("zzz", "t", 10, "desk", Some("c1"))),
            ev("lap", 1, dropped("aaa", "t", 10, "lap", Some("c2"))),
        ]);
        assert_eq!(l.items().next().unwrap().id, "aaa");
    }

    /// The case that rules out shipping rows: two walls each gain a voice while
    /// apart, and both must be there afterwards.
    #[test]
    fn a_voice_gained_on_each_side_survives_the_merge() {
        let l = fold(&[
            ev("desk", 1, dropped("a", "t", 10, "desk", Some("c1"))),
            ev("desk", 2, What::Seconded { id: "a".into(), by: "c2".into() }),
            ev("lap", 1, dropped("b", "t", 20, "lap", Some("c3"))),
            ev("lap", 2, What::Seconded { id: "b".into(), by: "c4".into() }),
        ]);
        assert_eq!(l.items().next().unwrap().voice_count(), 4);
    }

    /// A hold, a settling and a rewording are each "the most recent statement
    /// wins" — and an older one arriving late must not undo a newer one.
    #[test]
    fn a_late_arrival_does_not_undo_a_newer_statement() {
        let l = fold(&[
            ev("desk", 1, dropped("a", "t", 10, "desk", None)),
            ev("desk", 2, What::Settled { id: "a".into(), note: "new".into(), at: 50 }),
            /* Arrives after, happened before. */
            ev("lap", 1, What::Unsettled { id: "a".into(), at: 20 }),
        ]);
        let i = l.items().next().unwrap();
        assert!(i.settled);
        assert_eq!(i.settled_note.as_deref(), Some("new"));
    }

    /// Events about the loser keep landing after a merge, because they were
    /// already on the wire when it happened.
    #[test]
    fn a_statement_about_the_merged_away_id_still_lands() {
        let mut l = fold(&[
            ev("desk", 1, dropped("a", "t", 10, "desk", Some("c1"))),
            ev("lap", 1, dropped("b", "t", 20, "lap", Some("c2"))),
        ]);
        l.apply(&ev("lap", 2, What::Settled { id: "b".into(), note: "done".into(), at: 30 }));
        let i = l.items().next().unwrap();
        assert_eq!(i.id, "a");
        assert!(i.settled, "a settling aimed at the twin settled the survivor");
    }

    /// What a reconnect sends so it is told only what it is missing.
    #[test]
    fn the_watermark_is_the_furthest_heard_from_each_host() {
        let l = fold(&[
            ev("desk", 1, dropped("a", "t", 10, "desk", None)),
            ev("lap", 7, What::Seconded { id: "a".into(), by: "c".into() }),
            /* Out of order from the same host — the watermark is a high-water
               mark, not a counter, or a replay would wind it backwards. */
            ev("lap", 3, What::Seconded { id: "a".into(), by: "d".into() }),
        ]);
        let w = l.watermark();
        assert_eq!(w.get("desk"), Some(&1));
        assert_eq!(w.get("lap"), Some(&7));
    }

    /// A statement about something this wall has never heard of invents no
    /// item — the pile must not grow rows with no words in them.
    #[test]
    fn a_statement_about_an_unknown_item_invents_nothing() {
        let l = fold(&[ev("lap", 1, What::Seconded { id: "ghost".into(), by: "c".into() })]);
        assert_eq!(l.items().count(), 0);
    }

    /// But it is **kept**, and lands when the drop catches up. Two hosts have
    /// no ordering between them, so a second reaching a third wall before the
    /// drop does is ordinary rather than exotic — and losing it was what made
    /// `events_in_any_order_agree` fail on the first cut of this file.
    #[test]
    fn a_statement_that_arrives_before_its_drop_is_kept_until_it_lands() {
        let l = fold(&[
            ev("lap", 1, What::Seconded { id: "a".into(), by: "c2".into() }),
            ev("lap", 2, What::Settled { id: "a".into(), note: "done".into(), at: 50 }),
            ev("desk", 1, dropped("a", "t", 10, "desk", Some("c1"))),
        ]);
        let i = l.items().next().expect("the drop made it real");
        assert_eq!(i.voice_count(), 2, "the early second was not lost");
        assert!(i.settled, "nor the early settling");
    }

    /// And one aimed at an id that only ever arrives as the *loser* of a twin
    /// merge still finds its way home.
    #[test]
    fn a_statement_held_for_an_id_that_turns_out_to_be_a_twin_lands_too() {
        let l = fold(&[
            ev("lap", 1, What::Seconded { id: "b".into(), by: "c9".into() }),
            ev("desk", 1, dropped("a", "t", 10, "desk", Some("c1"))),
            ev("lap", 2, dropped("b", "t", 20, "lap", Some("c2"))),
        ]);
        let i = l.items().next().unwrap();
        assert_eq!(i.id, "a");
        assert_eq!(i.voice_count(), 3, "c1, c2 and the early second from c9");
    }
}
