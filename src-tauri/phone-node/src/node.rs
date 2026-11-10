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
//! So the node's whole job is bind, dial, say the greeting, read the answer —
//! and, for a picture or file a card produced, read that too. It keeps no
//! store, emits nothing, spawns nothing, and accepts no dials. The surface is
//! three calls — `start`, `sight`, `fetch` — all async and returning through
//! the handle, which is the shape M2b's JNI bridge drives.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flyway_core::cards::CardsMsg;
use flyway_core::fleet::{Act, Announcement, Ask, Facts, FleetMsg, Heard, Origin, Territory};
use flyway_core::frame::Frame;
use flyway_core::seal::WallKey;
use flyway_core::seeing::{self, SeeMsg, Sight};
use flyway_core::session::Msg;
use flyway_core::steward::{self, StewardMsg};
use flyway_core::wire::{carrying_within, Wire};

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

/// What the phone asks to view: the media a card on the wall produced, in the
/// two forms the flyway already carries (`seeing.rs`) — a picture by the copy
/// `show` kept or by path, and a file by path. A sent file is the second kind:
/// once a parcel has landed on the owning wall it is a file at a path, and
/// `seeing` reads it like any other.
#[derive(Debug, Clone, PartialEq)]
pub enum Media {
    Picture {
        kept: Option<String>,
        path: Option<String>,
    },
    File {
        path: String,
    },
}

/// What one `fetch` came back with, flattened from the wire's own shapes
/// (`seeing::Pictured` for a picture, `seeing::Gathering` for a file) so the
/// phone reads fields and never the enums.
#[derive(Debug, Clone, PartialEq)]
pub struct Fetched {
    pub name: String,
    /// Base64 — a picture's pixels, or a file's bytes.
    pub data: String,
    pub bytes: u64,
    /// A picture's size in pixels; `None` for a file.
    pub size: Option<(u32, u32)>,
    /// A picture too large to draw, whose `data` is then empty.
    pub too_large: bool,
    /// Where a file is on the owning wall, in that wall's spelling. A picture
    /// carries none: a path from another machine is not one to open here.
    pub full: String,
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
        let back = self.wire.exchange(peer, self.greeting(), true).await.map_err(|f| f.to_string())?;
        Ok(Sighting::read(back))
    }

    /// Fetch a picture or file a card on the wall produced. `host` is the
    /// wall's name; `card` the card's id there, which the phone read out of the
    /// digest and passes back — a relative path counts from where that card
    /// runs, and the read is gated by that wall's take-work-from-other-walls
    /// switch exactly as an agent's `recall` is (`seeing.rs`, "Who may").
    ///
    /// `seeing.rs` is the whole of the wire: a `see`/`seen` exchange, never
    /// gossiped, answered on the same stream. A picture crosses whole in one
    /// frame; a file arrives in parts, so it is pulled in as many exchanges as
    /// it takes, held to its first part's word (`seeing::Gathering`).
    pub async fn fetch(&self, host: &str, card: &str, want: Media) -> Result<Fetched, String> {
        match want {
            Media::Picture { kept, path } => {
                let ask = Sight::Picture { call: None, n: 0, kept, path, measure: false, have: None };
                let within = carrying_within(PICTURE_MOST);
                match self.read_see(host, card, ask, within).await? {
                    SeeMsg::Seen { picture: Some(p), .. } => Ok(picture_into(p)),
                    _ => Err(format!("{host} sent no picture")),
                }
            }
            Media::File { path } => {
                let mut g = seeing::Gathering::default();
                let mut from = 0u64;
                let within = carrying_within(seeing::BUDGET);
                for _ in 0..seeing::ROUNDS_MOST {
                    let ask = Sight::File { path: path.clone(), from };
                    let part = match self.read_see(host, card, ask, within).await? {
                        SeeMsg::Seen { part: Some(p), .. } => p,
                        _ => return Err(format!("{host} sent none of that file")),
                    };
                    if g.take(part, host)? {
                        return Ok(file_into(&g));
                    }
                    from = g.got.len() as u64;
                }
                Err(format!("{host} took more exchanges than any file should"))
            }
        }
    }

    /// One `see`, answered on the same stream — the desktop's `read_see`, with
    /// the request id made here rather than by the store the phone has not got,
    /// and the greeting sent ahead of it so a wall that has never met the node
    /// can still say who asked (`link.rs::who_is` reads the `Hello`).
    async fn read_see(&self, host: &str, card: &str, ask: Sight, within: Duration) -> Result<SeeMsg, String> {
        let peer = self.wire.peer(host)?;
        let id = fresh_id();
        let m = SeeMsg::See { id: id.clone(), card: card.to_string(), ask };
        let mut out = self.greeting();
        out.push(Frame::See(m));
        let back = self
            .wire
            .exchange_within(peer, out, true, within)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let sees = back.into_iter().filter_map(|f| match f {
            Frame::See(m) => Some(m),
            _ => None,
        });
        seeing::answer_in(sees, &id, host)
    }

    /// Hand a spoken transcript to a wall and read back the plan it made. The
    /// phone has ears and a mouth but no `claude` child, so understanding stays
    /// on the wall — `docs/PHONE.md` M5, "the wall stays the brain". One
    /// exchange, held open past the steward's own spawn (`steward::WITHIN`),
    /// answered on the same stream and never kept. Returns the request's id and
    /// the whole of what `steward.ts::understand` decided — most often
    /// `{ "kind": "plan", "plan": { "reads": …, "needs": … } }` — as an opaque
    /// value, for the Kotlin side to read and narrate. The id is what a later
    /// `confirm` names, so the phone never sends the plan back.
    pub async fn plan(&self, host: &str, transcript: &str) -> Result<(String, serde_json::Value), String> {
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err("nothing was said".into());
        }
        if transcript.chars().count() > steward::TRANSCRIPT_MOST {
            return Err(format!(
                "that sentence is longer than the {} characters a transcript may be",
                steward::TRANSCRIPT_MOST
            ));
        }
        let peer = self.wire.peer(host)?;
        let id = fresh_id();
        let m = StewardMsg::Steward { id: id.clone(), transcript };
        let mut out = self.greeting();
        out.push(Frame::Steward(m));
        let back = self
            .wire
            .exchange_within(peer, out, true, steward::WITHIN)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let stewards = back.iter().filter_map(|f| match f {
            Frame::Steward(m) => Some(m),
            _ => None,
        });
        let answer = steward::answer_in(stewards, &id, host)?;
        Ok((id, answer))
    }

    /// Confirm the plan the wall returned for `id` and have it carried out.
    /// The phone has already spoken the plan's `reads` and heard a yes; it
    /// sends only the id — the wall is the only thing that ever held the steps,
    /// so the wall runs them (`docs/PHONE.md` M5, "the phone sends only the
    /// confirmation"). One exchange, answered on the same stream, and the
    /// answer is the carry's `Outcome`: `{ "kind": "done" }` when it ran, else
    /// `refused`/`stopped` with a `why` to narrate.
    pub async fn confirm(&self, host: &str, id: &str) -> Result<serde_json::Value, String> {
        let peer = self.wire.peer(host)?;
        let m = StewardMsg::Confirm { id: id.to_string() };
        let mut out = self.greeting();
        out.push(Frame::Steward(m));
        let back = self
            .wire
            .exchange_within(peer, out, true, steward::WITHIN)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let stewards = back.iter().filter_map(|f| match f {
            Frame::Steward(m) => Some(m),
            _ => None,
        });
        steward::answer_in(stewards, id, host)
    }

    /// Answer a question a card on the wall has parked on `ask_user`, as a
    /// person speaking through the phone. `card` is the card's id on that wall
    /// and `ask_id` the question's id, both read out of the digest the wall
    /// published; `text` is the spoken answer.
    ///
    /// This is the wall's own answer path (`docs/PHONE.md` M5, questions): a
    /// `fleet` prompt whose `answers` names the parked question, handed by the
    /// wall straight into the parked call (`ask::answer_from_afar`) — the same
    /// channel a click in that wall's dock uses, and it passes even while the
    /// wall is not taking work, since an answer starts nothing. The phone never
    /// executes anything itself.
    ///
    /// **Fire-and-forget on purpose.** A prompt's answer is gossiped back to
    /// the asker by the wall dialling *us* (`fleet::Answer`), and this node is
    /// dial-only — it accepts no dials and runs no tick to read one. So the
    /// result is not read here; it surfaces in the wall's next digest, where
    /// the question has gone and the card has resumed. A refusal (the card
    /// closed, the question gone) reads the same way: the question is still
    /// there, and the sentence can be said again.
    pub async fn answer(&self, host: &str, card: &str, ask_id: &str, text: &str) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("nothing was said".into());
        }
        let peer = self.wire.peer(host)?;
        let ask = Ask {
            id: fresh_answer_id(),
            from: Origin { host: self.name.clone(), card: None },
            to: host.to_string(),
            /* A prompt has no territory; the name is where the asking node
               stands, for the envelope over there. */
            territory: Territory { identity: String::new(), name: String::new() },
            brief: text,
            title: None,
            asked_at: now_ms(),
            model: None,
            effort: None,
            needs: Vec::new(),
            worktree: None,
            worktree_base: None,
            card: Some(card.to_string()),
            answers: Some(ask_id.to_string()),
            pictures: Vec::new(),
            parcel: None,
            act: Act::Prompt,
        };
        let mut out = self.greeting();
        out.push(Frame::Fleet(FleetMsg::Prompt { ask, age_ms: 0 }));
        self.wire
            .exchange(peer, out, true)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        Ok(())
    }

    /// The greeting the node opens an exchange with — the same shape a wall
    /// opens with, so a wall answers in kind and, on first contact, folds the
    /// node into its roster. `sight` sends it alone; `fetch` sends it before
    /// the `see`, so a wall that has never met the node can still say who asked.
    fn greeting(&self) -> Vec<Frame> {
        vec![
            Frame::Sink(Msg::Hello { host: self.name.clone(), watermark: BTreeMap::new() }),
            Frame::Fleet(FleetMsg::Roster { walls: vec![self.announcement()], greeting: true }),
        ]
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

/// A picture crosses whole in one frame, and the desktop caps one at 3 MB
/// (`show::MAX_PICTURE`, an app-crate constant the phone cannot link) — 4 MB as
/// base64. The number is restated here rather than read from `show`; it sets
/// the exchange's timeout, not a cap.
const PICTURE_MOST: usize = 4 * 1024 * 1024;

fn picture_into(p: seeing::Pictured) -> Fetched {
    Fetched {
        name: p.name,
        data: p.data,
        bytes: p.bytes,
        size: p.size,
        too_large: p.too_large,
        full: String::new(),
    }
}

fn file_into(g: &seeing::Gathering) -> Fetched {
    Fetched {
        name: g.name.clone(),
        data: flyway_core::base64(&g.got),
        bytes: g.size,
        size: None,
        too_large: false,
        full: g.full.clone(),
    }
}

/// A request id, unique enough that one `see` cannot answer another. The
/// desktop takes one from the store (`store::uuid_v4`); the phone has no
/// store, and the id only ever ties an answer to the exchange it was asked in.
fn fresh_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("p{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

/// An id for a prompt this node sends. The fleet remembers a request for ten
/// minutes after it is answered (`fleet::ANSWER_KEPT_MS`), which outlives a
/// phone process — so a bare counter would reuse an id after a restart and a
/// redelivered old answer could swallow the new one. A wall-clock prefix makes
/// a repeat impossible in practice; the counter disambiguates two sends in one
/// millisecond.
fn fresh_answer_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("a{}-{}", now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
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

    /// A picture flattens to what the phone draws: the base64 the wall sent, its
    /// size, and no `full` — a path on another machine is not one to open here.
    #[test]
    fn a_picture_fetches_as_its_own_shape() {
        let p = seeing::Pictured {
            name: "shot.png".into(),
            data: "iVBOR".into(),
            bytes: 6,
            size: Some((2, 3)),
            too_large: false,
            ..seeing::Pictured::default()
        };
        let f = picture_into(p);
        assert_eq!(f.name, "shot.png");
        assert_eq!(f.data, "iVBOR");
        assert_eq!(f.bytes, 6);
        assert_eq!(f.size, Some((2, 3)));
        assert!(!f.too_large);
        assert!(f.full.is_empty());
    }

    /// A prompt id is unique and stays within the alphabet the wire carries —
    /// and, unlike the exchange id, it carries a wall-clock prefix so a phone
    /// restarted within the fleet's ten-minute memory cannot reuse one.
    #[test]
    fn a_prompt_id_is_unique_and_clocked() {
        let a = fresh_answer_id();
        let b = fresh_answer_id();
        assert_ne!(a, b);
        assert!(a.bytes().all(|x| x.is_ascii_alphanumeric() || x == b'-'), "{a}");
        assert!(a.contains('-'), "the clock prefix is what survives a restart: {a}");
    }

    /// A file folds out of the gathering: its bytes re-encoded, its size as the
    /// wall declared, no picture size, and its owning path kept in the wall's
    /// spelling for the phone to say where it is.
    #[test]
    fn a_file_fetches_as_bytes() {
        let mut g = seeing::Gathering::default();
        let part = seeing::Part {
            name: "note.md".into(),
            full: "C:/p/note.md".into(),
            size: 4,
            stamp: Some("4-1".into()),
            from: 0,
            data: flyway_core::base64(b"note"),
        };
        assert!(g.take(part, "lap").unwrap());
        let f = file_into(&g);
        assert_eq!(f.name, "note.md");
        assert_eq!(flyway_core::unbase64(&f.data).as_deref(), Some(b"note".as_slice()));
        assert_eq!(f.bytes, 4);
        assert_eq!(f.size, None);
        assert!(!f.too_large);
        assert_eq!(f.full, "C:/p/note.md");
    }
}
