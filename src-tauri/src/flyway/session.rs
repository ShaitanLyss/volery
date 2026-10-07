//! What two walls actually say to each other, as a state machine with no IO in
//! it.
//!
//! `sync.rs` answers *do these two piles end up the same given a bag of
//! events*. This answers the question underneath it: **how does each wall come
//! to have the other's events at all**, over a link that drops, reconnects and
//! replays.
//!
//! ### No sockets, no threads, no clock
//!
//! A `Session` is handed a message and answers with the messages it would like
//! sent. That is the whole interface. It means the interesting property — two
//! walls that have been apart, each with events the other has never seen,
//! converge after one exchange — is a unit test with two `Session`s in a loop,
//! rather than two machines, a network and a database.
//!
//! The socket underneath is then a thin thing whose only job is bytes, and
//! `seal.rs` is already between it and here. That ordering is deliberate: the
//! transport is the piece still waiting on a fact about the office network
//! (`docs/FLYWAY-PROBE.md`), and nothing above it should have been blocked on
//! that.
//!
//! ### The exchange
//!
//! ```text
//!   A ──── Hello { host, watermark } ───▶ B
//!   A ◀─── Hello { host, watermark } ──── B      (B answers in kind)
//!   A ◀─── Events { … }  ─────────────── B      (what A was missing)
//!   A ──── Events { … }  ─────────────▶ B      (what B was missing)
//! ```
//!
//! A watermark is "the furthest seq I have from each host", so what comes back
//! is only what is missing — the thing that makes a reconnect after a week cost
//! a few frames rather than the whole pile.
//!
//! **A wall serves events it did not originate.** That is not an optimisation,
//! it is what makes three machines work when only two of them are ever awake at
//! the same time: the laptop learns what the desktop said through the server
//! that heard it, and nobody has to be online together. It is also why `Stamp`
//! carries the *originating* host rather than the sender — a relayed event is
//! the same event.
//!
//! ### Why `Hello` is answered rather than assumed
//!
//! Both sides open with one, and a side that receives one answers with its own
//! unless it already sent it. A single opener would need somebody to be the
//! client, and over a relay neither is: both walls dial out and the thing in
//! the middle introduces them. Answering in kind makes the exchange symmetric
//! and makes "who connected to whom" a fact about the transport that nothing up
//! here has to know.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::sync::{Event, Ledger};

/// How many events one `Events` message may carry.
///
/// A wall that has been away for a month comes back wanting everything, and one
/// frame holding all of it is a frame the far side has to buffer whole before
/// it can act on any of it. Chunking means the pile fills in visibly instead of
/// arriving at once or not at all — and it bounds what a malformed peer can
/// make us allocate.
const CHUNK: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum Msg {
    /// Who I am and what I already have, per originating host.
    Hello {
        host: String,
        watermark: BTreeMap<String, u64>,
    },
    Events { events: Vec<Event> },
}

pub struct Session {
    me: String,
    /// Everything this wall can serve — its own events and everything it has
    /// heard. Kept beside the ledger rather than derived from it, because the
    /// ledger folds events away and what a peer asks for is the events.
    log: Vec<Event>,
    ledger: Ledger,
    greeted: bool,
}

impl Session {
    pub fn new(me: &str) -> Self {
        Self { me: me.to_string(), log: Vec::new(), ledger: Ledger::new(), greeted: false }
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    /// Record something that happened on *this* wall: folded in, and kept to be
    /// served to anybody who has not heard it.
    pub fn originate(&mut self, e: Event) {
        self.take(e);
    }

    /// What to say on connect.
    pub fn open(&mut self) -> Msg {
        self.greeted = true;
        Msg::Hello { host: self.me.clone(), watermark: self.ledger.watermark() }
    }

    /// Answer a message with whatever it is now this wall's turn to say.
    pub fn on(&mut self, m: Msg) -> Vec<Msg> {
        match m {
            Msg::Hello { watermark, .. } => {
                let mut out = Vec::new();
                /* Symmetric: whoever speaks first, the other answers in kind,
                   so neither end has to be the client. Guarded so two opens
                   cannot bounce a greeting back and forth for ever. */
                if !self.greeted {
                    out.push(self.open());
                }
                for chunk in self.missing(&watermark).chunks(CHUNK) {
                    out.push(Msg::Events { events: chunk.to_vec() });
                }
                out
            }
            Msg::Events { events } => {
                for e in events {
                    self.take(e);
                }
                /* Nothing to say back. An acknowledgement would be a second
                   round trip for something the next `Hello` already settles —
                   a reconnect re-states the watermark, which is the only
                   honest acknowledgement there is. */
                Vec::new()
            }
        }
    }

    /// Everything the far side has not got, oldest first.
    ///
    /// Oldest first matters: a `Dropped` should land before the statements
    /// about it where it can, so the far side's `pending` stays small. It is
    /// only a preference — `sync.rs` holds early statements precisely because
    /// nothing can guarantee this across hosts.
    fn missing(&self, watermark: &BTreeMap<String, u64>) -> Vec<Event> {
        let mut out: Vec<Event> = self
            .log
            .iter()
            .filter(|e| e.stamp.seq > watermark.get(&e.stamp.host).copied().unwrap_or(0))
            .cloned()
            .collect();
        out.sort_by(|a, b| a.stamp.cmp(&b.stamp));
        out
    }

    /// Fold an event in and keep it to pass on.
    ///
    /// **Deduplicated on the stamp**, which is what makes a replay free: a
    /// reconnect re-sends whatever the watermark did not cover, and a frame can
    /// simply arrive twice. `Ledger::apply` is idempotent, so the fold is safe
    /// either way; the log is what would otherwise grow a copy per delivery and
    /// then serve them all on.
    fn take(&mut self, e: Event) {
        if self.log.iter().any(|k| k.stamp == e.stamp) {
            return;
        }
        self.ledger.apply(&e);
        self.log.push(e);
    }
}

#[cfg(test)]
mod tests {
    use super::super::sync::{Stamp, What};
    use super::*;

    fn ev(host: &str, seq: u64, what: What) -> Event {
        Event { stamp: Stamp { host: host.into(), seq }, what }
    }

    fn dropped(id: &str, title: &str, at: i64, host: &str, from: &str) -> What {
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

    /// Run two sessions against each other until neither has anything left to
    /// say. Bounded, so a protocol that answered itself for ever would fail
    /// here rather than hang the suite.
    fn converse(a: &mut Session, b: &mut Session) {
        let mut to_b = vec![a.open()];
        let mut to_a = vec![b.open()];
        for _ in 0..12 {
            if to_a.is_empty() && to_b.is_empty() {
                return;
            }
            let next_a: Vec<Msg> = std::mem::take(&mut to_b).into_iter().flat_map(|m| b.on(m)).collect();
            let next_b: Vec<Msg> = std::mem::take(&mut to_a).into_iter().flat_map(|m| a.on(m)).collect();
            to_a = next_a;
            to_b = next_b;
        }
        panic!("the exchange never went quiet");
    }

    fn titles(s: &Session) -> Vec<String> {
        let mut t: Vec<String> = s.ledger().items().map(|i| i.title.clone()).collect();
        t.sort();
        t
    }

    /// **The property.** Two walls that have been apart, each holding something
    /// the other has never heard, agree after one exchange.
    #[test]
    fn two_walls_that_have_been_apart_converge() {
        let mut desk = Session::new("desk");
        let mut lap = Session::new("lap");
        desk.originate(ev("desk", 1, dropped("a", "the ring pegs", 10, "desk", "c1")));
        lap.originate(ev("lap", 1, dropped("b", "the dock eats a key", 20, "lap", "c2")));

        converse(&mut desk, &mut lap);

        assert_eq!(titles(&desk), titles(&lap));
        assert_eq!(titles(&desk), vec!["the dock eats a key", "the ring pegs"]);
    }

    /// The same finding on both machines is still one item after the exchange —
    /// the twin rule holding across a real conversation rather than a bag.
    #[test]
    fn the_same_finding_on_both_sides_is_one_item_afterwards() {
        let mut desk = Session::new("desk");
        let mut lap = Session::new("lap");
        desk.originate(ev("desk", 1, dropped("a", "ask_user times out", 10, "desk", "c1")));
        lap.originate(ev("lap", 1, dropped("b", "ask_user times out", 20, "lap", "c2")));

        converse(&mut desk, &mut lap);

        for s in [&desk, &lap] {
            assert_eq!(s.ledger().items().count(), 1);
            let i = s.ledger().items().next().unwrap();
            assert_eq!(i.id, "a", "both kept the earlier drop");
            assert_eq!(i.voice_count(), 2);
        }
    }

    /// A reconnect asks only for what it is missing, which is what keeps a wall
    /// that has been away for a week from re-downloading the pile.
    #[test]
    fn a_second_exchange_carries_nothing() {
        let mut desk = Session::new("desk");
        let mut lap = Session::new("lap");
        desk.originate(ev("desk", 1, dropped("a", "t", 10, "desk", "c1")));
        converse(&mut desk, &mut lap);

        /* Second meeting, nothing new said in between. */
        let hello = lap.open();
        let answer = desk.on(hello);
        let carried: usize = answer
            .iter()
            .map(|m| match m {
                Msg::Events { events } => events.len(),
                _ => 0,
            })
            .sum();
        assert_eq!(carried, 0, "a reconnect re-sends nothing already held");
    }

    /// And a frame that arrives twice costs nothing — which is what lets the
    /// transport be allowed to replay rather than having to promise it will not.
    #[test]
    fn a_replayed_frame_changes_nothing() {
        let mut desk = Session::new("desk");
        let e = ev("lap", 1, dropped("b", "t", 10, "lap", "c2"));
        desk.on(Msg::Events { events: vec![e.clone(), e.clone()] });
        desk.on(Msg::Events { events: vec![e] });
        assert_eq!(desk.ledger().items().next().unwrap().voice_count(), 1);
        assert_eq!(desk.log.len(), 1, "the log must not grow a copy per delivery");
    }

    /// Three machines where only two are ever awake together: the laptop learns
    /// what the desktop said *through* the server. This is why a wall serves
    /// events it did not originate, and why a stamp names the originator rather
    /// than the sender.
    #[test]
    fn a_wall_passes_on_what_it_heard_from_a_third() {
        let mut desk = Session::new("desk");
        let mut server = Session::new("server");
        let mut lap = Session::new("lap");
        desk.originate(ev("desk", 1, dropped("a", "a finding", 10, "desk", "c1")));

        converse(&mut desk, &mut server);
        /* The desk goes to sleep. The laptop wakes and never meets it. */
        converse(&mut server, &mut lap);

        assert_eq!(titles(&lap), vec!["a finding"]);
        let i = lap.ledger().items().next().unwrap();
        assert_eq!(i.origin_host, "desk", "relaying does not re-attribute");
    }

    /// Whoever speaks first, the other answers — neither end is the client,
    /// because over a relay both walls dial out and the middle introduces them.
    #[test]
    fn either_side_may_open_and_the_other_answers_in_kind() {
        let mut a = Session::new("a");
        let mut b = Session::new("b");
        b.originate(ev("b", 1, dropped("x", "t", 10, "b", "c")));

        /* Only A opens. B has not greeted and must answer with its own hello
           and its events, or an exchange the other side started would be a
           one-way street. */
        let replies = b.on(a.open());
        assert!(replies.iter().any(|m| matches!(m, Msg::Hello { .. })));
        for m in replies {
            a.on(m);
        }
        assert_eq!(titles(&a), vec!["t"]);
    }

    /// A month away arrives in pieces rather than one frame the far side has to
    /// hold whole before it can act on any of it.
    #[test]
    fn a_long_absence_comes_back_in_chunks() {
        let mut desk = Session::new("desk");
        for n in 1..=(CHUNK as u64 * 2 + 5) {
            desk.originate(ev("desk", n, dropped(&format!("i{n}"), &format!("t{n}"), n as i64, "desk", "c")));
        }
        let fresh = Session::new("lap");
        let out = desk.on(Msg::Hello { host: "lap".into(), watermark: fresh.ledger().watermark() });
        let frames: Vec<usize> = out
            .iter()
            .filter_map(|m| match m {
                Msg::Events { events } => Some(events.len()),
                _ => None,
            })
            .collect();
        assert_eq!(frames.len(), 3, "{frames:?}");
        assert!(frames.iter().all(|n| *n <= CHUNK));
        assert_eq!(frames.iter().sum::<usize>(), CHUNK * 2 + 5);
    }
}
