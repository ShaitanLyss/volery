//! A node on the flyway that is not a wall: dials one wall and reads what it
//! says.
//!
//! `docs/PHONE.md` M2a. A wall is the whole of the flyway — a store, a front
//! end, a `claude` child per card, the roster and the asks. A phone is none of
//! those and can run none of them. But the flyway's own vocabulary already
//! covers what a phone needs, because everything a node and a wall share is
//! enough to be a member:
//!
//! - **an identity** — `WallKey::node_secret(name)`, the same derivation a wall
//!   uses, so the phone dials a wall by name and is itself diallable the same
//!   way;
//! - **a greeting** — `session::Msg::Hello` and a `fleet::FleetMsg::Roster`
//!   marked `greeting: true`, exactly the shape a wall sends on connect
//!   (`link.rs::greeting`), minus the `Cards` and `Board` the phone does not
//!   have;
//! - **the answer** — a wall answers a `Hello` with its own, and a greeting
//!   roster with the whole roster it holds (the phone's own entry among them,
//!   since it announced it), plus its `Cards` snapshot, unconditionally.
//!
//! ### Why this is the whole protocol, and not a second one
//!
//! The flyway was built wall↔wall, but nothing in the wall half of it requires
//! the *far* end to be a wall. The one ordering constraint that bites is in
//! `fleet.rs`: **a roster is only ever said in answer to a fleet message**, so a
//! node that wants to see the roster must announce itself first — send a
//! `Roster` with its own (empty) `Facts` and `greeting: true`. That is not a
//! protocol invented for the phone; it is the exact statement a wall opens with,
//! and it is what makes the phone appear on the wall's roster as well as making
//! the roster come back. The `Hello` is `session.rs`'s handshake: symmetric,
//! answered in kind, and its empty watermark says the truth — the phone holds
//! no sink events. That it means the wall will send its own sink events back is
//! harmless here and is what narration will later read.
//!
//! So the node's whole job is bind, dial, say the greeting, read the answer. It
//! keeps no store, emits nothing, spawns nothing, and — for M2a — accepts no
//! dials. The surface is two calls, both async and returning through the handle,
//! which is the shape M2b's uniffi/JNI bridge drives.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use flyway_core::cards::CardsMsg;
use flyway_core::fleet::{Announcement, Facts, FleetMsg, Heard};
use flyway_core::frame::Frame;
use flyway_core::seal::WallKey;
use flyway_core::session::Msg;
use flyway_core::wire::Wire;

/// A bound phone node: on the flyway, but with no cards, no store and no wall.
///
/// The key lives in the `Wire` (`Wire::start` takes it by value and derives
/// every identity from it), so the node keeps the name and the wire and nothing
/// else.
pub struct Node {
    name: String,
    wire: Wire,
}

/// What one dial of a wall returned, as a phone reads it.
#[derive(Debug, Clone)]
pub struct Sighting {
    /// Every wall the peer knows, this node included once it has announced.
    /// `fleet::Heard` is the wire's own shape — a wall's announcement with its
    /// age — not a second vocabulary.
    pub roster: Vec<Heard>,
    /// The peer's cards digest, if its front end has published one. A wall that
    /// is still painting itself sends none, and absence means exactly that
    /// (`cards.rs`: nothing is sent until there is something true to send).
    pub cards: Option<Digest>,
}

/// One wall's cards snapshot, as the phone reads it — `cards::CardsMsg::Cards`
/// flattened, since the phone wants the fields and never the enum.
#[derive(Debug, Clone)]
pub struct Digest {
    pub host: String,
    pub version: u64,
    pub age_ms: u64,
    pub snapshot: serde_json::Value,
}

impl Node {
    /// Take a place on the flyway: bind this node's endpoint, derived from the
    /// key and the node's name exactly as a wall derives its own.
    pub async fn start(key: WallKey, name: String) -> Result<Self, String> {
        let wire = Wire::start(key, &name).await?;
        Ok(Self { name, wire })
    }

    /// This node's name — the name its identity is derived from, and the one a
    /// wall puts on its roster.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Dial one wall and read what it says. `host` is the wall's name — the one
    /// its invite carries — from which its identity is derived
    /// (`WallKey::node_secret`).
    ///
    /// One exchange, nothing held open: send the greeting, finish, read — the
    /// shape every wall's own pull is (`wire.rs`).
    pub async fn sight(&self, host: &str) -> Result<Sighting, String> {
        let peer = self.wire.peer(host)?;
        let out = vec![
            Frame::Sink(Msg::Hello { host: self.name.clone(), watermark: BTreeMap::new() }),
            Frame::Fleet(FleetMsg::Roster { walls: vec![self.announcement()], greeting: true }),
        ];
        let back = self.wire.exchange(peer, out, true).await.map_err(|f| f.to_string())?;
        Ok(Sighting::read(back))
    }

    /// This node's statement about itself, in the wire's own shape. The facts
    /// are empty and `accepting` is false — a phone takes no work and holds no
    /// cards — which is the honest announcement, not a parallel protocol. The
    /// `build` field is left empty on purpose: it names the app a wall runs,
    /// and the phone app does not exist yet (`fleet.rs` on why the crate's own
    /// version must not stand in).
    fn announcement(&self) -> Heard {
        let now = now_ms();
        Heard {
            wall: Announcement {
                host: self.name.clone(),
                version: now.max(0) as u64,
                said_at: Some(now),
                facts: Facts::default(),
            },
            age_ms: 0,
        }
    }
}

impl Sighting {
    /// Fold a wall's answer into what a phone reads. The wall may send its
    /// roster in two frames — what it just learned and what the greeter lacked —
    /// so a later version wins per host.
    fn read(frames: Vec<Frame>) -> Self {
        let mut roster: Vec<Heard> = Vec::new();
        let mut cards = None;
        for f in frames {
            match f {
                Frame::Fleet(FleetMsg::Roster { walls, .. }) => {
                    for h in walls {
                        if let Some(existing) = roster.iter_mut().find(|e| e.wall.host == h.wall.host) {
                            if h.wall.version > existing.wall.version {
                                *existing = h;
                            }
                        } else {
                            roster.push(h);
                        }
                    }
                }
                Frame::Cards(CardsMsg::Cards { host, version, age_ms, snapshot }) => {
                    cards = Some(Digest { host, version, age_ms, snapshot });
                }
                _ => {}
            }
        }
        Sighting { roster, cards }
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn heard(host: &str, version: u64) -> Heard {
        Heard {
            wall: Announcement { host: host.into(), version, said_at: Some(version as i64), facts: Facts::default() },
            age_ms: 0,
        }
    }

    /// The wall answers a greeting with two roster frames — what it just learned
    /// (the node) and what the greeter lacked (itself) — and a phone folds them
    /// into one entry per host, later version winning.
    #[test]
    fn a_walls_two_roster_frames_fold_into_one_with_the_latest_winning() {
        let frames = vec![
            Frame::Fleet(FleetMsg::Roster { walls: vec![heard("phone", 100)], greeting: false }),
            Frame::Fleet(FleetMsg::Roster { walls: vec![heard("phone", 100), heard("desk", 500)], greeting: false }),
            Frame::Cards(CardsMsg::Cards { host: "desk".into(), version: 7, age_ms: 0, snapshot: json!({ "v": 1 }) }),
        ];
        let s = Sighting::read(frames);
        assert_eq!(s.roster.len(), 2, "one entry per host, not one per frame");
        assert_eq!(s.roster.iter().find(|e| e.wall.host == "phone").unwrap().wall.version, 100);
        assert_eq!(s.roster.iter().find(|e| e.wall.host == "desk").unwrap().wall.version, 500);
        assert_eq!(s.cards.unwrap().host, "desk");
    }

    /// A wall still painting itself sends no `Cards` frame, and the phone reads
    /// that as `None` rather than an empty digest — the same guard the wire has.
    #[test]
    fn no_cards_frame_is_no_digest() {
        let s = Sighting::read(vec![Frame::Sink(Msg::Hello { host: "desk".into(), watermark: BTreeMap::new() })]);
        assert!(s.cards.is_none());
        assert!(s.roster.is_empty());
    }
}
