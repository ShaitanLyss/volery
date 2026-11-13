//! A node on the flyway that is not a wall: dials the walls it knows and reads
//! what the first one says.
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
//! `start` and then the one-shot exchanges — `sight`, `sight_any`, `fetch`,
//! `plan`, `confirm`, `answer` — all async and returning through the handle,
//! which is the shape M2b's JNI bridge drives.
//!
//! ### Which wall
//!
//! `sight` dials one wall. `sight_any` walks: the wall the phone was pointed
//! at, then the ones its last sighting showed, then every name the flyway's
//! directory holds. A phone that only ever dialled one wall left the flyway
//! without saying so whenever that laptop was shut, while the rest of the
//! flyway stayed up, which is the exact shape of the complaint that put the
//! walk here.
//!
//! **The directory is read and never written.** A name on it is an invitation
//! to dial, and this node answers no dials; listing itself would put every wall
//! on the flyway on a schedule of calls that can only fail. It arrives at the
//! roster when it dials, which is the half that matters. The desktop's
//! `directory::wanted` is a wall's; a node has nothing to add.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flyway_core::cards::CardsMsg;
use flyway_core::clip;
use flyway_core::directory;
use flyway_core::fleet::{Act, Announcement, Ask, Facts, FleetMsg, Heard, Origin, Territory};
use flyway_core::frame::Frame;
use flyway_core::seal::WallKey;
use flyway_core::seeing::{self, SeeMsg, Sight};
use flyway_core::session::Msg;
use flyway_core::steward::{self, StewardMsg};
use flyway_core::tail::{self, TailMsg};
use flyway_core::wire::{carrying_within, Wire, EXCHANGE_WITHIN};

/// How long every wall after the first gets in a walk. Shorter than the wire's
/// own bound because a walk may have several to try, and still well past a real
/// exchange: a few round trips over a relay, with a hole punch at the front.
const TRY_WITHIN: Duration = Duration::from_secs(10);

/// How many walls the walk tries from what it already knows (the chosen one
/// included) before it asks the directory. The rest of the budget is spent
/// after the read, and [`remainder`] keeps one of those attempts for a name the
/// directory holds: a roster of six dead laptops otherwise consumes every
/// attempt and the one source of walls this phone has never met is never
/// dialled, which is the failure the walk exists to fix, reached through a
/// longer list.
const MOST_KNOWN: usize = 3;

/// The most walls one walk dials, the chosen one included. A cap is what stops
/// a directory that has collected names of laptops sold last year from
/// becoming a dial that never ends.
const MOST_DOORS: usize = 6;

/// How long a failed directory read is kept before it is tried again. A phone
/// off the flyway polls every fifteen seconds, and one relay GET per poll is a
/// radio cost nobody asked for; a minute still recovers from a hiccup promptly.
const LISTED_AGAIN: Duration = Duration::from_secs(60);

/// The directory as this node last read it, held until `until`.
struct Listed {
    until: Option<std::time::Instant>,
    names: BTreeSet<String>,
}

/// A bound phone node: on the flyway, but with no cards, no store and no wall.
///
/// The key lives in the `Wire` (`Wire::start` takes it by value and derives
/// every identity from it), so the node keeps the name and the wire and nothing
/// else.
pub struct Node {
    name: String,
    wire: Wire,
    listed: std::sync::Mutex<Listed>,
}

/// What one dial of a wall returned, as a phone reads it.
#[derive(Debug, Clone)]
pub struct Sighting {
    /// The wall that answered. Not always the one asked: `sight_any` walks,
    /// and every later call (a fetch, a prompt, a `see`) has to name this
    /// wall, so the answer carries it rather than leaving the caller to
    /// remember which door opened.
    pub host: String,
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
        Ok(Self { name, wire, listed: std::sync::Mutex::new(Listed { until: None, names: BTreeSet::new() }) })
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
        Ok(Sighting::read(host, back))
    }

    /// Dial the first wall that answers: `chosen`, then the walls last seen
    /// working, then every name the flyway's directory holds. The answer names
    /// the wall that opened, and the caller should address that one from then
    /// on.
    ///
    /// A phone has no one wall it can rely on. The laptop it was last pointed
    /// at may be off while the flyway is still up on others, and a node that
    /// keeps dialling that one wall is a node that has left the flyway without
    /// saying so. The directory is read only after the walls this phone already
    /// knows have had their attempts, so a wall that answers costs exactly what
    /// a `sight` costs.
    pub async fn sight_any(&self, chosen: &str, remembered: &[String]) -> Result<Sighting, String> {
        let mut last = String::new();
        let mut tried: BTreeSet<String> = BTreeSet::new();
        let known = doors(&self.name, chosen, remembered, &BTreeSet::new());

        for (i, host) in known.iter().take(MOST_KNOWN).enumerate() {
            tried.insert(host.to_lowercase());
            /* The wall the phone was pointed at keeps the wire's own bound. The
               walk is not a reason to give the primary door a shorter one, and
               a cross-network first connection has taken the full twenty on
               this fleet before. The rest are the fallback and are cheaper. */
            let within = if i == 0 { EXCHANGE_WITHIN } else { TRY_WITHIN };
            match self.sight_within(host, within).await {
                Ok(found) => return Ok(found),
                Err(e) => last = e,
            }
        }

        /* The one place a wall this phone has never met can come from. Read
           after the known ones because it is an HTTP round trip, and the
           ordinary dial must not wait on the relay. What is left of the budget
           is ordered by `remainder`, which keeps an attempt for a directory
           name so a long remembered list cannot spend all of it first. */
        if tried.len() < MOST_DOORS {
            let listed = self.listed().await;
            let listed_only = doors(&self.name, "", &[], &listed);
            for host in remainder(&known, &listed_only, &tried) {
                tried.insert(host.to_lowercase());
                match self.sight_within(&host, TRY_WITHIN).await {
                    Ok(found) => return Ok(found),
                    Err(e) => last = e,
                }
            }
        }

        Err(if last.is_empty() {
            "no wall to dial: this phone has met none and the directory is empty".to_string()
        } else {
            format!("no wall answered: {last}")
        })
    }

    /// The flyway's directory, read at most once per `directory::EVERY` when it
    /// answers and once per [`LISTED_AGAIN`] when it does not. A phone off the
    /// flyway walks on every poll; without a floor, every one of those would be
    /// a pkarr relay GET on a phone's radio, and the desktop bounds the same
    /// read to five minutes.
    async fn listed(&self) -> BTreeSet<String> {
        if let Ok(l) = self.listed.lock() {
            if l.until.is_some_and(|until| std::time::Instant::now() < until) {
                return l.names.clone();
            }
        }
        let read = self.wire.directory_read().await;
        let (names, keep) = match read {
            directory::Read::Unreadable => (BTreeSet::new(), LISTED_AGAIN),
            other => (directory::names(&other), directory::EVERY),
        };
        if let Ok(mut l) = self.listed.lock() {
            l.until = Some(std::time::Instant::now() + keep);
            l.names = names.clone();
        }
        names
    }

    /// One wall, bounded. The error names the wall, since a walk reports the
    /// last failure and a bare "could not reach that wall" would leave the
    /// app unable to say which one.
    async fn sight_within(&self, host: &str, within: Duration) -> Result<Sighting, String> {
        let peer = self.wire.peer(host).map_err(|e| format!("{host}: {e}"))?;
        let back = self
            .wire
            .exchange_within(peer, self.greeting(), true, within)
            .await
            .map_err(|e| format!("{host}: {e}"))?;
        Ok(Sighting::read(host, back))
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

    /// A sentence the steward could not place as a Volery command.
    ///
    /// **Two answers come back through this word**, and the phone must speak
    /// only one of them. `general` is the wall answering on the spot from its
    /// own balance (`provider::answer_question`, the fallback for a wall with
    /// no project). `talk` is the wall handing the sentence to its front desk
    /// card (`assistant`): the card's words arrive later as a parked question
    /// of that card, which the prompt reader draws and the narrator reads, so
    /// the phone says nothing here. Refusing an unknown kind is what kept the
    /// second one from ever arriving — it surfaced as spoken nonsense, because
    /// the error travels the same envelope an answer does.
    ///
    /// Same exchange as `plan` and a different word in it: one turn, answered
    /// on the stream it was asked on, nothing kept. The wall gates it on its
    /// take-work switch, because it may start a card that spends money.
    pub async fn general(&self, host: &str, text: &str) -> Result<serde_json::Value, String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("nothing was said".into());
        }
        if text.chars().count() > steward::TRANSCRIPT_MOST {
            return Err(format!(
                "that sentence is longer than the {} characters a question may be",
                steward::TRANSCRIPT_MOST
            ));
        }
        let peer = self.wire.peer(host)?;
        let id = fresh_id();
        let m = StewardMsg::General { id: id.clone(), text };
        let mut out = self.greeting();
        out.push(Frame::Steward(m));
        let back = self
            .wire
            .exchange_within(peer, out, true, steward::WITHIN)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let answers = back.iter().filter_map(|f| match f {
            Frame::Steward(m) => Some(m),
            _ => None,
        });
        let answer = steward::answer_in(answers, &id, host)?;
        match answer.get("kind").and_then(serde_json::Value::as_str) {
            Some("general") | Some("talk") => Ok(answer),
            _ => Err(format!("{host} answered with something that was not an answer")),
        }
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
    /// the question has gone and the card has resumed. **A refusal looks
    /// exactly like an acceptance from this side**, which is why the app's mark
    /// on an answered row expires: a question still in the digest after that is
    /// offered again, so the sentence can be said again.
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
            provider: None,
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

    /// The prose that led to a card's prompt: its conversation, read on demand
    /// and reduced to what a person can read on a phone.
    ///
    /// `tail.rs`'s exchange, and the phone asks it for a `tail` frame exactly
    /// as another wall does — the owning wall holds this exchange open while
    /// its front end makes the tail and answers on the same stream. Nothing is
    /// kept on either side. The reduction to prose lines (`prompts::said_before`)
    /// is this crate's, because a phone screen wants the paragraph that led to
    /// a question and *not* a transcript with tool calls in it.
    ///
    /// Read on demand, never by a clock: this is the most expensive thing the
    /// phone asks a wall for (up to half a megabyte before the reduction), and
    /// it is wanted only when a person presses *what led to this* on a prompt.
    pub async fn tail(&self, host: &str, card: &str) -> Result<Vec<crate::prompts::Said>, String> {
        let peer = self.wire.peer(host)?;
        let id = fresh_id();
        let m = TailMsg::Tail { id: id.clone(), card: card.to_string() };
        let mut out = self.greeting();
        out.push(Frame::Tail(m));
        let back = self
            .wire
            .exchange_within(peer, out, true, EXCHANGE_WITHIN)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let tails = back.iter().filter_map(|f| match f {
            Frame::Tail(m) => Some(m),
            _ => None,
        });
        match tail::answer_in(tails, &id, host)? {
            tail::Read::Nothing => Ok(Vec::new()),
            tail::Read::Lines(lines) => Ok(crate::prompts::said_before(&lines, crate::prompts::SAID_MOST)),
        }
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
    fn read(host: &str, frames: Vec<Frame>) -> Self {
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
        Sighting { host: host.to_string(), roster, cards }
    }
}

/// The walls a walk tries, in order: `chosen`, then the ones last seen, then
/// every name the directory holds. The node itself is dropped, as is any repeat
/// (names are compared the way the rest of the flyway compares them, without
/// case) and anything a name could not be — a record is another machine's
/// writing, and every text this node stores goes through `clip` first.
///
/// **`chosen` is not clipped.** It is this phone's own setting, typed by the
/// person holding it, not another machine's writing; cutting it to forty
/// characters would derive a different identity and dial a wall that exists
/// under neither spelling, while a chip tap dials the same name whole. A name
/// longer than a wall's own forty can only be a typo, and a typo should fail
/// visibly rather than be silently turned into a second name.
///
/// No cap here: `sight_any` stops after [`MOST_DOORS`] attempts, and the list
/// has to stay whole so a directory name can still be reached after the
/// remembered ones have failed.
pub fn doors(me: &str, chosen: &str, remembered: &[String], listed: &BTreeSet<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chosen = chosen.trim();
    /* `clean` keeps newlines on purpose (a paragraph break is a real character
       in prose), and `directory::decode` refuses them in a name for the same
       reason this does: a roster host is written into a preferences list,
       where a line break would become two walls. */
    if !chosen.is_empty() && !chosen.contains(['\n', '\r']) && !chosen.eq_ignore_ascii_case(me) {
        out.push(chosen.to_string());
    }
    for name in remembered.iter().map(String::as_str).chain(listed.iter().map(String::as_str)) {
        let name = clip::keep(name.trim(), directory::NAME_MOST).kept;
        if name.is_empty() || name.contains(['\n', '\r']) || name.eq_ignore_ascii_case(me) {
            continue;
        }
        if out.iter().any(|h| h.eq_ignore_ascii_case(&name)) {
            continue;
        }
        out.push(name);
    }
    out
}

/// The rest of a walk, in the order it will be tried, after `tried` walls have
/// failed: the known names not yet tried, then the directory's, bounded by what
/// is left of [`MOST_DOORS`].
///
/// **One attempt is kept back for a directory name when there is one**, and
/// only then. That reserve is the whole point: a remembered roster can be
/// longer than the budget, and without it a phone whose laptop is off spends
/// every attempt on dead names from its last sighting and never dials the live
/// wall the directory is naming. When the directory is empty or could not be
/// read, the reserve is not taken and every remaining attempt goes to known
/// walls, because there is nothing better to spend it on.
pub fn remainder(known: &[String], listed: &[String], tried: &BTreeSet<String>) -> Vec<String> {
    let left = MOST_DOORS.saturating_sub(tried.len());
    /* A listed name needs a reserved attempt only when the known pass cannot
       reach it in the budget it already has. The directory usually names the
       walls the roster was learned from, so reserving for every listed name
       would take an attempt away from an untried known wall and then skip the
       listed one as a duplicate — one attempt of six wasted, and a known wall
       left undialled. A listed name beyond that reach still reserves. */
    let untried: Vec<&String> = known.iter().filter(|h| !tried.contains(&h.to_lowercase())).collect();
    let reachable = |h: &String| untried.iter().take(left).any(|k| k.eq_ignore_ascii_case(h));
    let reserve = usize::from(listed.iter().any(|h| !tried.contains(&h.to_lowercase()) && !reachable(h)));
    let known_left = left.saturating_sub(reserve);
    let mut out: Vec<String> = Vec::new();
    for host in known {
        if out.len() >= known_left {
            break;
        }
        if tried.contains(&host.to_lowercase()) || out.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            continue;
        }
        out.push(host.clone());
    }
    for host in listed {
        if tried.len() + out.len() >= MOST_DOORS {
            break;
        }
        if tried.contains(&host.to_lowercase()) || out.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            continue;
        }
        out.push(host.clone());
    }
    out
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

    fn names(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// A walk asks the wall the phone was pointed at first, then the ones the
    /// last sighting showed, then the directory — the only place a wall this
    /// phone has never met can come from.
    #[test]
    fn a_walk_tries_the_chosen_wall_then_the_ones_last_seen_then_the_directory() {
        let listed = names(&["annex", "workshop"]);
        let remembered = vec!["desk".to_string()];
        assert_eq!(doors("phone", "desk", &remembered, &listed), vec!["desk", "annex", "workshop"]);
    }

    /// The node drops itself, repeats in another case, names that are only
    /// space, and anything with a line break in it, since a name taken off a
    /// roster is another machine's writing and is about to be stored.
    #[test]
    fn a_walk_drops_this_node_its_repeats_and_what_a_name_cannot_be() {
        let listed = names(&["PHONE", "desk", "", "a\nb"]);
        let remembered = vec!["Phone".to_string(), "desk".to_string(), "   ".to_string()];
        assert_eq!(doors("phone", "DESK", &remembered, &listed), vec!["DESK"]);
    }

    /// A name another machine wrote is capped the way the directory caps one, so
    /// a roster entry cannot become a key derivation on a megabyte of text.
    #[test]
    fn a_walk_caps_a_long_name_from_another_machine() {
        let long = "a".repeat(400);
        let listed = BTreeSet::from([long.clone()]);
        let out = doors("phone", "desk", &[], &listed);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "desk");
        assert_eq!(out[1].chars().count(), directory::NAME_MOST);
        assert!(long.starts_with(&out[1]), "the cap keeps the front of the name");
    }

    /// The chosen wall is this phone's own setting, so it is dialled as typed:
    /// clipping it would derive a different identity from the one a chip tap
    /// uses for the same wall.
    #[test]
    fn a_walk_keeps_the_chosen_name_whole() {
        let long = "a".repeat(400);
        let out = doors("phone", &long, &[], &BTreeSet::new());
        assert_eq!(out, vec![long]);
    }

    /// A stale roster longer than the budget must not spend every attempt
    /// before the directory is dialled. With the first three known walls
    /// already failed, the last three attempts are two more known and then the
    /// directory's name.
    #[test]
    fn a_long_roster_leaves_the_last_attempt_for_the_directory() {
        let remembered: Vec<String> = ["desk", "w2", "w3", "w4", "w5", "w6"].iter().map(|s| s.to_string()).collect();
        let known = doors("phone", "desk", &remembered, &BTreeSet::new());
        let listed = doors("phone", "", &[], &BTreeSet::from(["annex".to_string()]));
        let tried: BTreeSet<String> = ["desk", "w2", "w3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(remainder(&known, &listed, &tried), vec!["w4", "w5", "annex"]);
    }

    /// With no configured wall and no roster, the directory is the whole walk.
    /// This is the fresh-install shape now that `phone.host` may be empty.
    #[test]
    fn a_walk_with_no_seed_starts_at_the_directory() {
        let listed = doors("phone", "", &[], &BTreeSet::from(["annex".to_string(), "workshop".to_string()]));
        assert_eq!(listed, vec!["annex", "workshop"]);
        assert_eq!(remainder(&[], &listed, &BTreeSet::new()), vec!["annex", "workshop"]);
    }

    /// A directory name the known pass will dial anyway must not take an
    /// attempt away from a known wall: the directory usually lists the walls
    /// the roster came from, so this is the common shape, not a corner.
    #[test]
    fn a_listed_name_the_known_pass_will_dial_takes_no_attempt() {
        let remembered: Vec<String> = ["desk", "w2", "w3", "w4", "w5", "w6"].iter().map(|s| s.to_string()).collect();
        let known = doors("phone", "desk", &remembered, &BTreeSet::new());
        let listed = doors("phone", "", &[], &BTreeSet::from(["w5".to_string()]));
        let tried: BTreeSet<String> = ["desk", "w2", "w3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(remainder(&known, &listed, &tried), vec!["w4", "w5", "w6"]);
    }

    /// With no directory names there is nothing to reserve, so every attempt
    /// left goes to the walls this phone already knows.
    #[test]
    fn a_walk_with_no_directory_names_spends_every_attempt_on_what_it_knows() {
        let remembered: Vec<String> = ["desk", "w2", "w3", "w4", "w5", "w6"].iter().map(|s| s.to_string()).collect();
        let known = doors("phone", "desk", &remembered, &BTreeSet::new());
        let tried: BTreeSet<String> = ["desk", "w2", "w3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(remainder(&known, &[], &tried), vec!["w4", "w5", "w6"]);
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
        let s = Sighting::read("desk", frames);
        assert_eq!(s.host, "desk", "the answer names the wall that opened");
        assert_eq!(s.roster.len(), 2, "one entry per host, not one per frame");
        assert_eq!(s.roster.iter().find(|e| e.wall.host == "phone").unwrap().wall.version, 100);
        assert_eq!(s.roster.iter().find(|e| e.wall.host == "desk").unwrap().wall.version, 500);
        assert_eq!(s.cards.unwrap().host, "desk");
    }

    /// A wall still painting itself sends no `Cards` frame, and the phone reads
    /// that as `None` rather than an empty digest — the same guard the wire has.
    #[test]
    fn no_cards_frame_is_no_digest() {
        let s = Sighting::read("desk", vec![Frame::Sink(Msg::Hello { host: "desk".into(), watermark: BTreeMap::new() })]);
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
