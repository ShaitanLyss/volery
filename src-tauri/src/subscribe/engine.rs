//! When a card is handed the events it subscribed to.
//!
//! **"Wake" here means one thing: hand the card a turn.** It is said this
//! precisely because the word meant three things to the person who asked for
//! it, and the three are three different code paths:
//!
//! - **an idle live card** is handed a new turn, now;
//! - **a card mid-turn is never interrupted.** What matches while it works is
//!   held, and when that turn ends it is handed over as *one* turn — not queued
//!   behind it as one turn per event, which is what writing each into its stdin
//!   would do (the CLI queues a prompt sent mid-turn);
//! - **a dormant card is roused** — the batch goes to its inbox and the front
//!   end is asked to spawn it, `relay.rs`'s "a message addressed to one card by
//!   name now wakes it", so the first thing it reads is this.
//!
//! **Nothing here is a polling tick.** The loop sleeps on a channel with a
//! timeout of exactly the next moment something becomes due, and wakes for
//! three messages: an event matched (`Arrived`), a card's turn closed
//! (`TurnEnded`, folded off `supervisor::persist_turn`, the one place both
//! boundaries of every turn already pass), a card went (`Forget`). With nothing
//! pending it blocks on the channel with no timeout at all. CLAUDE.md's "three
//! places that go and look" is the rule: this is not a fourth.
//!
//! ### Batching
//!
//! Events that land together are one turn. A card's batch goes `QUIET_MS` after
//! the last event of a burst, or `MAX_HOLD_MS` after the first if the burst
//! never pauses — so a steady trickle is still delivered, in turns half a
//! minute apart, rather than held for ever waiting for a quiet that never
//! comes. A subscription's `every_minutes` spaces it further (`ledger::claim`).
//!
//! ### The loop guard, which must never throttle a real session
//!
//! Lyss: *"it shouldn't prevent me from having intensive feedback sessions."*
//! So there is no hourly cap that stops delivery, and **nothing is ever
//! dropped, only batched.** Past `GUARD_TURNS` subscription turns in an hour a
//! card's turns are spaced `GUARD_SPACING_MS` apart — at most a minute's delay
//! on each, with everything that arrived in that minute riding along — and a
//! chronicle line says so, once. A real session at that pace loses a minute per
//! turn; a loop loses its speed and gets seen.
//!
//! The loop worth detecting by name is the **self-trigger**: a card reacting to
//! an event by producing one on the stream it is subscribed to. Its signature is
//! that a matching event arrives *during the turn our delivery opened*, batch
//! after batch. `ECHO_LIMIT` of those in a row writes a chronicle line, and the
//! next envelope says what it looks like and how to filter its own writes out.
//! That costs a real session nothing either.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::MutexGuard;
use std::time::Duration;

use rusqlite::Connection;

use super::ledger;

pub const QUIET_MS: i64 = 5_000;
pub const MAX_HOLD_MS: i64 = 30_000;
/// Events in one turn. What is over it is the next turn's, not lost.
pub const MAX_LINES: usize = 100;
pub const GUARD_TURNS: usize = 30;
pub const GUARD_WINDOW_MS: i64 = 60 * 60 * 1_000;
pub const GUARD_SPACING_MS: i64 = 60_000;
/// Consecutive batches with a matching event arriving inside the turn the last
/// one opened, before it is called a self-trigger.
pub const ECHO_LIMIT: u32 = 5;
/// How long a card is held for a turn end that has not come. A turn ends or
/// its process does, and both close the turn (`persist_turn`); this is only
/// for a rouse that never became a process, so a card cannot be held for ever
/// on a signal that will not arrive. Past it, the next attempt looks again.
pub const TURN_HOLD_LIMIT_MS: i64 = 15 * 60 * 1_000;

pub enum Msg {
    Arrived(String),
    TurnEnded(String),
    Forget(String),
    /// The front end is up and listening. Nothing is served before it: a
    /// dormant card is roused by an event the webview answers, and one emitted
    /// before there is a webview reaches nobody — the batch would sit in an
    /// inbox nothing was going to open.
    Ready,
}

/// What the engine does to a card, behind a seam so a test can be the card.
pub trait Hands: Send {
    /// `Some(true)` mid-turn, `Some(false)` idle, `None` no process.
    fn turn_open(&self, conversation_id: &str) -> Option<bool>;
    /// Write a turn into a live card. `false` if it has no process after all.
    fn hand(&self, conversation_id: &str, text: &str) -> bool;
    /// Put it in a dormant card's inbox and ask for the card to be woken.
    fn rouse(&self, conversation_id: &str, text: &str);
    /// A line on the chronicle.
    fn note(&self, conversation_id: &str, mark: &str, detail: &str);
}

/// The store, behind a seam for the same reason.
pub trait Db: Send {
    fn lock(&self) -> Option<MutexGuard<'_, Connection>>;
}

impl Db for std::sync::Mutex<Connection> {
    fn lock(&self) -> Option<MutexGuard<'_, Connection>> {
        std::sync::Mutex::lock(self).ok()
    }
}

#[derive(Debug, Default, Clone)]
struct Card {
    pending: bool,
    /// The current gathering: first and last arrival. Zero when none.
    first: i64,
    last: i64,
    /// Nothing goes before this — spacing from `every_minutes` or the guard.
    not_before: i64,
    /// Held for a turn to end, since when.
    held_since: Option<i64>,
    /// Our delivery opened the turn now running.
    ours_open: bool,
    arrived_in_ours: bool,
    echoes: u32,
    echo_noted: bool,
    served: VecDeque<i64>,
    guarded: bool,
}

/// The state, with no clock and no I/O: every method is handed `now`.
#[derive(Default)]
pub struct Batcher {
    cards: HashMap<String, Card>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Guard {
    /// Spacing just engaged, with this many turns in the hour.
    Spaced(usize),
    /// Events kept arriving inside our own turns, this many times running.
    Echo(u32),
}

impl Batcher {
    pub fn arrived(&mut self, id: &str, now: i64) {
        let c = self.cards.entry(id.to_string()).or_default();
        c.pending = true;
        if c.first == 0 {
            c.first = now;
        }
        c.last = now;
        if c.ours_open {
            c.arrived_in_ours = true;
        } else {
            /* An event landing while the card is not on one of our turns is a
               stream that is busy by itself, which is all a match inside our
               turns then shows. Only events that come *only* while the card
               works on our batches look like the card making them. */
            c.echoes = 0;
            c.echo_noted = false;
        }
    }

    pub fn turn_ended(&mut self, id: &str) {
        let Some(c) = self.cards.get_mut(id) else { return };
        c.held_since = None;
        if c.ours_open {
            c.ours_open = false;
            if std::mem::take(&mut c.arrived_in_ours) {
                c.echoes += 1;
            } else {
                c.echoes = 0;
                c.echo_noted = false;
            }
        }
    }

    pub fn forget(&mut self, id: &str) {
        self.cards.remove(id);
    }

    /// The card is mid-turn: hold it until that turn ends. Restarted on every
    /// hold, since a card is only looked at again when it was due — and one
    /// still mid-turn at the limit is held for another, rather than found due
    /// on every pass.
    pub fn hold(&mut self, id: &str, now: i64) {
        if let Some(c) = self.cards.get_mut(id) {
            c.held_since = Some(now);
        }
    }

    fn ready_at(c: &Card) -> Option<i64> {
        if !c.pending {
            return None;
        }
        let gathered = if c.first == 0 { 0 } else { (c.last + QUIET_MS).min(c.first + MAX_HOLD_MS) };
        let at = gathered.max(c.not_before);
        Some(match c.held_since {
            Some(since) => at.max(since + TURN_HOLD_LIMIT_MS),
            None => at,
        })
    }

    pub fn next_deadline(&self) -> Option<i64> {
        self.cards.values().filter_map(Self::ready_at).min()
    }

    pub fn due(&self, now: i64) -> Vec<String> {
        let mut v: Vec<(i64, String)> = self
            .cards
            .iter()
            .filter_map(|(id, c)| Self::ready_at(c).filter(|at| *at <= now).map(|at| (at, id.clone())))
            .collect();
        v.sort();
        v.into_iter().map(|(_, id)| id).collect()
    }

    /// A claim found nothing it may hand over yet.
    pub fn nothing_yet(&mut self, id: &str, remaining: bool, next_due: Option<i64>) {
        let Some(c) = self.cards.get_mut(id) else { return };
        c.pending = remaining;
        c.first = 0;
        c.last = 0;
        c.held_since = None;
        if let Some(at) = next_due {
            c.not_before = c.not_before.max(at);
        }
    }

    /// A batch went to the card. Returns a guard line to write, if one engaged.
    pub fn delivered(&mut self, id: &str, now: i64, remaining: bool, next_due: Option<i64>) -> Option<Guard> {
        let c = self.cards.entry(id.to_string()).or_default();
        c.pending = remaining;
        c.first = 0;
        c.last = 0;
        /* Live or roused, the card is now in (or about to be in) the turn this
           batch opens, and the next one waits for it to close. */
        c.held_since = Some(now);
        c.ours_open = true;
        c.arrived_in_ours = false;
        if remaining {
            /* Overflow is the next turn's: it gathers from now. */
            c.first = now;
            c.last = now - QUIET_MS;
        }
        c.served.push_back(now);
        while c.served.front().is_some_and(|t| *t <= now - GUARD_WINDOW_MS) {
            c.served.pop_front();
        }
        let mut not_before = next_due.unwrap_or(0);
        let mut note = None;
        if c.served.len() >= GUARD_TURNS {
            not_before = not_before.max(now + GUARD_SPACING_MS);
            if !c.guarded {
                c.guarded = true;
                note = Some(Guard::Spaced(c.served.len()));
            }
        } else {
            c.guarded = false;
        }
        c.not_before = not_before;
        if c.echoes >= ECHO_LIMIT && !c.echo_noted {
            c.echo_noted = true;
            note = note.or(Some(Guard::Echo(c.echoes)));
        }
        note
    }

    /// How many batches running have seen events arrive inside our own turn.
    pub fn echoes(&self, id: &str) -> u32 {
        self.cards.get(id).map(|c| c.echoes).unwrap_or(0)
    }
}

/// One pass over what is due: each card is handed its batch, or held.
pub fn serve<D: Db, H: Hands>(b: &mut Batcher, db: &D, hands: &H, now: i64) {
    for id in b.due(now) {
        if hands.turn_open(&id) == Some(true) {
            b.hold(&id, now);
            continue;
        }
        let claim = {
            let Some(conn) = db.lock() else { return };
            ledger::claim(&conn, &id, now, MAX_LINES)
        };
        let claim = match claim {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[subscribe] claim for {id}: {e}");
                b.nothing_yet(&id, true, Some(now + QUIET_MS));
                continue;
            }
        };
        if claim.sections.is_empty() {
            b.nothing_yet(&id, claim.remaining > 0, claim.next_due);
            continue;
        }
        let text = super::envelope(&claim.sections, claim.remaining, b.echoes(&id));
        let live = hands.turn_open(&id).is_some() && hands.hand(&id, &text);
        if !live {
            hands.rouse(&id, &text);
        }
        match b.delivered(&id, now, claim.remaining > 0, claim.next_due) {
            Some(Guard::Spaced(n)) => hands.note(
                &id,
                &format!("{n} subscription turns in an hour — spacing them a minute apart"),
                "nothing is dropped; events gather into each turn. Lyss can say if that is a loop.",
            ),
            Some(Guard::Echo(n)) => hands.note(
                &id,
                &format!("subscribed card may be triggering itself — events arrived during its own turn {n} times running"),
                "its next turn says how to filter its own writes out",
            ),
            None => {}
        }
    }
}

/// The loop: block until something is due or a message arrives, serve, repeat.
/// Returns when every sender has gone.
pub fn run<D: Db, H: Hands>(db: &D, hands: &H, rx: Receiver<Msg>, clock: impl Fn() -> i64) {
    run_from(db, hands, rx, clock, false)
}

/// `run`, told whether the front end is already listening.
pub fn run_from<D: Db, H: Hands>(db: &D, hands: &H, rx: Receiver<Msg>, clock: impl Fn() -> i64, mut ready: bool) {
    let mut b = Batcher::default();
    /* A restart leaves deliveries in the table; they are due as if they had
       just arrived. */
    if let Some(conn) = db.lock() {
        let now = clock();
        for id in ledger::pending_cards(&conn) {
            b.arrived(&id, now - QUIET_MS);
        }
    }
    loop {
        if ready {
            serve(&mut b, db, hands, clock());
        }
        let msg = match b.next_deadline().filter(|_| ready) {
            Some(at) => {
                let wait = (at - clock()).clamp(0, i64::MAX) as u64;
                match rx.recv_timeout(Duration::from_millis(wait.max(1))) {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        match msg {
            Some(Msg::Arrived(id)) => b.arrived(&id, clock()),
            Some(Msg::TurnEnded(id)) => b.turn_ended(&id),
            Some(Msg::Forget(id)) => b.forget(&id),
            Some(Msg::Ready) => ready = true,
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscribe::ledger::tests::{arrival, db, sub};
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::Mutex;

    /// A card the test plays: whether it is live and mid-turn, and every turn
    /// it was handed.
    #[derive(Default)]
    struct Card {
        live: bool,
        mid_turn: bool,
        turns: Vec<String>,
        inbox: Vec<String>,
        notes: Vec<String>,
    }
    struct Fake(Mutex<RefCell<HashMap<String, Card>>>);
    impl Fake {
        fn new() -> Self {
            Fake(Mutex::new(RefCell::new(HashMap::new())))
        }
        fn set(&self, id: &str, live: bool, mid_turn: bool) {
            let g = self.0.lock().unwrap();
            let mut m = g.borrow_mut();
            let c = m.entry(id.into()).or_default();
            c.live = live;
            c.mid_turn = mid_turn;
        }
        fn turns(&self, id: &str) -> Vec<String> {
            self.0.lock().unwrap().borrow().get(id).map(|c| c.turns.clone()).unwrap_or_default()
        }
        fn inbox(&self, id: &str) -> Vec<String> {
            self.0.lock().unwrap().borrow().get(id).map(|c| c.inbox.clone()).unwrap_or_default()
        }
        fn notes(&self, id: &str) -> Vec<String> {
            self.0.lock().unwrap().borrow().get(id).map(|c| c.notes.clone()).unwrap_or_default()
        }
    }
    impl Hands for Fake {
        fn turn_open(&self, id: &str) -> Option<bool> {
            let g = self.0.lock().unwrap();
            let m = g.borrow();
            m.get(id).filter(|c| c.live).map(|c| c.mid_turn)
        }
        fn hand(&self, id: &str, text: &str) -> bool {
            let g = self.0.lock().unwrap();
            let mut m = g.borrow_mut();
            let Some(c) = m.get_mut(id).filter(|c| c.live) else { return false };
            c.turns.push(text.to_string());
            c.mid_turn = true;
            true
        }
        fn rouse(&self, id: &str, text: &str) {
            let g = self.0.lock().unwrap();
            g.borrow_mut().entry(id.into()).or_default().inbox.push(text.to_string());
        }
        fn note(&self, id: &str, mark: &str, _detail: &str) {
            let g = self.0.lock().unwrap();
            g.borrow_mut().entry(id.into()).or_default().notes.push(mark.to_string());
        }
    }

    struct World {
        db: Mutex<Connection>,
        hands: Fake,
        b: Batcher,
        seq: i64,
    }

    impl World {
        fn new() -> Self {
            World { db: Mutex::new(db()), hands: Fake::new(), b: Batcher::default(), seq: 0 }
        }
        fn subscribe(&self, id: &str, card: &str, filter: serde_json::Value) {
            ledger::add(&self.db.lock().unwrap(), &sub(id, card, filter, 0, 0)).unwrap();
        }
        /// An event off the source at `now`, through the real ingest.
        fn event(&mut self, now: i64, fields: serde_json::Value) {
            self.seq += 1;
            let cards = ledger::ingest(
                &self.db.lock().unwrap(),
                "nova-feedback",
                &arrival("0", self.seq, now, fields),
                now,
            )
            .unwrap();
            for c in cards {
                self.b.arrived(&c, now);
            }
        }
        fn tick(&mut self, now: i64) {
            serve(&mut self.b, &self.db, &self.hands, now);
        }
        fn end_turn(&mut self, card: &str) {
            self.hands.set(card, true, false);
            self.b.turn_ended(card);
        }
    }

    #[test]
    fn a_matching_event_wakes_exactly_one_turn() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({"channel": "ui"}));
        w.hands.set("card", true, false);
        w.event(1_000, json!({"channel": "ui", "eventId": 1}));
        w.tick(1_000 + QUIET_MS - 1);
        assert!(w.hands.turns("card").is_empty(), "it gathers first");
        assert_eq!(w.b.next_deadline(), Some(1_000 + QUIET_MS));
        w.tick(1_000 + QUIET_MS);
        let turns = w.hands.turns("card");
        assert_eq!(turns.len(), 1);
        assert!(turns[0].contains(r#""eventId":1"#), "{}", turns[0]);
        assert!(turns[0].contains("note for s1"));
        /* And nothing more, however long it waits. */
        w.end_turn("card");
        w.tick(1_000_000);
        assert_eq!(w.hands.turns("card").len(), 1);
        assert_eq!(w.b.next_deadline(), None, "nothing pending, so no deadline at all");
    }

    #[test]
    fn a_non_matching_event_wakes_nothing() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({"channel": "ui"}));
        w.hands.set("card", true, false);
        w.event(1_000, json!({"channel": "mcp"}));
        assert_eq!(w.b.next_deadline(), None);
        w.tick(100_000);
        assert!(w.hands.turns("card").is_empty());
    }

    #[test]
    fn a_burst_becomes_one_batched_turn() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, false);
        for i in 0..12 {
            w.event(1_000 + i * 300, json!({"n": i}));
            w.tick(1_000 + i * 300);
        }
        w.tick(1_000 + 11 * 300 + QUIET_MS);
        let turns = w.hands.turns("card");
        assert_eq!(turns.len(), 1, "{turns:?}");
        assert!(turns[0].contains("12 events"), "{}", turns[0]);
        assert!(turns[0].contains(r#"{"n":0}"#) && turns[0].contains(r#"{"n":11}"#));
    }

    /// A burst that never pauses still lands, at the hold's ceiling.
    #[test]
    fn a_steady_trickle_is_delivered_at_the_ceiling() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, false);
        let mut t = 1_000;
        while t < 1_000 + MAX_HOLD_MS + 2_000 {
            w.event(t, json!({"t": t}));
            w.tick(t);
            t += 1_000;
        }
        assert_eq!(w.hands.turns("card").len(), 1, "delivered at first + MAX_HOLD_MS");
    }

    #[test]
    fn events_held_while_mid_turn_arrive_as_one_turn_at_its_end() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, true);
        for i in 0..5 {
            w.event(1_000 + i * 10_000, json!({"n": i}));
            w.tick(1_000 + i * 10_000 + QUIET_MS);
        }
        assert!(w.hands.turns("card").is_empty(), "never interrupted");
        w.end_turn("card");
        w.tick(60_000);
        let turns = w.hands.turns("card");
        assert_eq!(turns.len(), 1);
        assert!(turns[0].contains("5 events"), "{}", turns[0]);
        /* Our own turn is now open; what arrives during it waits for it too. */
        w.event(61_000, json!({"n": 5}));
        w.tick(70_000);
        assert_eq!(w.hands.turns("card").len(), 1);
        w.end_turn("card");
        w.tick(70_001);
        assert_eq!(w.hands.turns("card").len(), 2);
    }

    #[test]
    fn a_dormant_card_is_roused_with_its_batch() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.event(1_000, json!({"n": 1}));
        w.tick(1_000 + QUIET_MS);
        let inbox = w.hands.inbox("card");
        assert_eq!(inbox.len(), 1);
        /* A second batch while the rouse is in flight waits for that turn,
           rather than becoming a second inbox row and a second turn. */
        w.event(2_000 + QUIET_MS, json!({"n": 2}));
        w.tick(3_000 + 2 * QUIET_MS);
        assert_eq!(w.hands.inbox("card").len(), 1);
        w.end_turn("card");
        w.tick(3_001 + 2 * QUIET_MS);
        assert_eq!(w.hands.turns("card").len(), 1, "now live, handed directly");
    }

    #[test]
    fn a_cleared_card_hears_nothing_more() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, false);
        w.event(1_000, json!({"n": 1}));
        ledger::remove_card(&w.db.lock().unwrap(), "card");
        w.b.forget("card");
        w.tick(100_000);
        w.event(200_000, json!({"n": 2}));
        w.tick(300_000);
        assert!(w.hands.turns("card").is_empty());
        assert!(w.hands.inbox("card").is_empty());
    }

    /// The guard spaces, says so once, and drops nothing.
    #[test]
    fn an_intensive_session_is_spaced_never_starved() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, false);
        let mut t = 1_000;
        let mut sent = 0;
        for _ in 0..40 {
            w.event(t, json!({"n": sent}));
            sent += 1;
            t += QUIET_MS;
            w.tick(t);
            /* Wait out whatever spacing applies, then end the turn. */
            t += GUARD_SPACING_MS + 1;
            w.tick(t);
            w.end_turn("card");
        }
        w.tick(t + GUARD_SPACING_MS + QUIET_MS);
        let turns = w.hands.turns("card");
        let delivered: usize = turns.iter().map(|x| x.matches(r#"{"n":"#).count()).sum();
        assert_eq!(delivered, sent, "nothing dropped");
        let notes = w.hands.notes("card");
        assert_eq!(notes.iter().filter(|n| n.contains("spacing")).count(), 1, "{notes:?}");
    }

    #[test]
    fn past_the_guard_turns_are_a_minute_apart() {
        let mut b = Batcher::default();
        let mut now = 0;
        for _ in 0..GUARD_TURNS - 1 {
            b.arrived("c", now);
            assert_eq!(b.delivered("c", now, false, None), None);
            b.turn_ended("c");
            now += 10_000;
        }
        b.arrived("c", now);
        assert_eq!(b.delivered("c", now, false, None), Some(Guard::Spaced(GUARD_TURNS)));
        b.turn_ended("c");
        b.arrived("c", now + 1_000);
        assert_eq!(b.next_deadline(), Some(now + GUARD_SPACING_MS), "a minute after the last, not five seconds");
    }

    #[test]
    fn a_card_feeding_itself_is_named() {
        let mut b = Batcher::default();
        let mut now = 0;
        let mut notes = Vec::new();
        /* One event to start; after that, every event arrives inside the turn
           the last batch opened, and is the next batch. */
        b.arrived("c", now);
        for _ in 0..ECHO_LIMIT + 1 {
            if let Some(n) = b.delivered("c", now, false, None) {
                notes.push(n);
            }
            /* The card writes an event during the turn we opened. */
            b.arrived("c", now + 1_000);
            b.turn_ended("c");
            now += 20_000;
        }
        assert!(notes.contains(&Guard::Echo(ECHO_LIMIT)), "{notes:?}");
        assert!(b.echoes("c") >= ECHO_LIMIT);
    }

    /// A stream busy by itself also lands events inside our turns; it lands
    /// them outside too, and that is what tells the two apart.
    #[test]
    fn a_busy_stream_is_not_a_card_feeding_itself() {
        let mut b = Batcher::default();
        let mut now = 0;
        for _ in 0..ECHO_LIMIT * 2 {
            b.arrived("c", now);
            assert_eq!(b.delivered("c", now, false, None), None);
            b.arrived("c", now + 1_000);
            b.turn_ended("c");
            b.arrived("c", now + 10_000); // and while the card is idle
            now += 20_000;
        }
        assert!(b.echoes("c") < ECHO_LIMIT);
    }

    /// Events that arrived while the wall was not connected are delivered once
    /// it is, from the checkpoint: the source replays from an older position
    /// and the replay delivers nothing twice and loses nothing.
    #[test]
    fn a_reconnect_delivers_the_gap_once() {
        let mut w = World::new();
        w.subscribe("s1", "card", json!({}));
        w.hands.set("card", true, false);
        /* Three read, then the connection drops. */
        for seq in 1..=3 {
            let cards = ledger::ingest(&w.db.lock().unwrap(), "nova-feedback", &arrival("0", seq, 1_000 + seq, json!({"seq": seq})), 2_000).unwrap();
            for c in cards {
                w.b.arrived(&c, 2_000);
            }
        }
        w.tick(2_000 + QUIET_MS);
        w.end_turn("card");
        let check = ledger::checkpoint(&w.db.lock().unwrap(), "nova-feedback", "0").unwrap();
        assert_eq!(check.0, 3);
        /* While down, the hub took seq 4..=6. The reconnect starts after the
           checkpoint, but a careless source might replay from 2. */
        let start = ledger::start_for(Some(check), 0);
        assert_eq!(start, ledger::Start::After(3));
        for seq in 2..=6 {
            let cards = ledger::ingest(&w.db.lock().unwrap(), "nova-feedback", &arrival("0", seq, 1_000 + seq, json!({"seq": seq})), 50_000).unwrap();
            for c in cards {
                w.b.arrived(&c, 50_000);
            }
        }
        w.tick(50_000 + QUIET_MS);
        let turns = w.hands.turns("card");
        assert_eq!(turns.len(), 2);
        for seq in 1..=6 {
            let n = turns.iter().map(|t| t.matches(&format!(r#"{{"seq":{seq}}}"#)).count()).sum::<usize>();
            assert_eq!(n, 1, "seq {seq} delivered exactly once");
        }
    }

    /// The loop itself, on a real channel and a real clock: what a restart
    /// left in the table is handed over at once, and the loop ends when its
    /// senders do.
    #[test]
    fn the_loop_picks_up_what_a_restart_left_and_ends_with_its_senders() {
        use std::sync::{mpsc, Arc};
        let db = Arc::new(Mutex::new(db()));
        ledger::add(&db.lock().unwrap(), &sub("s1", "card", json!({}), 0, 0)).unwrap();
        ledger::ingest(&db.lock().unwrap(), "nova-feedback", &arrival("0", 1, 1, json!({"n": 1})), 1).unwrap();
        let hands = Arc::new(Fake::new());
        hands.set("card", true, false);
        let (tx, rx) = mpsc::channel::<Msg>();
        let (db2, hands2) = (db.clone(), hands.clone());
        struct D(Arc<Mutex<Connection>>);
        impl Db for D {
            fn lock(&self) -> Option<MutexGuard<'_, Connection>> {
                self.0.lock().ok()
            }
        }
        struct H(Arc<Fake>);
        impl Hands for H {
            fn turn_open(&self, id: &str) -> Option<bool> {
                self.0.turn_open(id)
            }
            fn hand(&self, id: &str, t: &str) -> bool {
                self.0.hand(id, t)
            }
            fn rouse(&self, id: &str, t: &str) {
                self.0.rouse(id, t)
            }
            fn note(&self, id: &str, m: &str, d: &str) {
                self.0.note(id, m, d)
            }
        }
        let worker = std::thread::spawn(move || {
            run(&D(db2), &H(hands2), rx, crate::store::now);
        });
        /* Nothing goes before the front end says it is listening. */
        std::thread::sleep(Duration::from_millis(100));
        assert!(hands.turns("card").is_empty(), "served before the webview was up");
        tx.send(Msg::Ready).unwrap();
        let t = std::time::Instant::now();
        while hands.turns("card").is_empty() && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(hands.turns("card").len(), 1);
        tx.send(Msg::TurnEnded("card".into())).unwrap();
        drop(tx);
        worker.join().unwrap();
    }
}
