//! The other walls, and asking one of them to open a card.
//!
//! `sync.rs` and `session.rs` make one pile out of several. This is the first
//! thing the flyway does that a single wall cannot: **put a card on a machine
//! you are not sitting at.** The repo is checked out on the desktop, the
//! toolchain is on the build box, the laptop is where you are — and until now
//! the only way to get a card where the work can actually run was to walk over
//! to it.
//!
//! Two things are needed for that and this file is both of them: knowing what
//! the other walls are and what they can host (the **roster**), and a request
//! one wall makes of another with an answer that comes back (the **ask**).
//!
//! ### No sockets, no threads, no clock — the same bargain as `session.rs`
//!
//! A `Fleet` is handed a message, the time, and the facts about this wall, and
//! answers with what it would like said, what it would like opened, and which
//! of its own asks have been answered. Nothing here reads a clock, a store or a
//! process table. The facts a wall announces — its territories, how many cards
//! it is running, how much of its allowance is left — come in as a `Facts`
//! value that the wiring assembles from `store`, `perf.rs` and `limits.rs`.
//! That is what lets the properties below be unit tests with three `Fleet`s
//! in a loop rather than three machines.
//!
//! ### Everything is gossip, and a repeat is free
//!
//! The three decisions `session.rs` is built on hold here unchanged, and each
//! one shaped something:
//!
//! - **A wall serves what it did not originate.** A roster entry, an ask and
//!   an answer are all passed on by whoever hears them, so the laptop can ask
//!   the desktop to open a card through the server in the cupboard, and the
//!   answer comes back the same way. Which is why an ask names its *addressee*
//!   (`to`) and an answer names its *asker* (`asked_by`) rather than either
//!   assuming the far end of the link is the party it wants.
//! - **Either end may open.** `open` is a full statement of what this wall
//!   knows, and a `Roster` marked `greeting` is answered with whatever the
//!   greeter lacked — so whoever speaks first, both end up with everything,
//!   and nothing here holds per-connection state about who dialled whom.
//! - **A replay costs nothing.** An announcement is deduplicated on its
//!   version, an ask and its answer on the request id. What a `Fleet` returns
//!   to be said is only ever what was *new to it*, which is also what makes a
//!   flood terminate: a thing echoed back to a wall that already holds it dies
//!   there. So everything in `Reply::say` is safe to send to every peer, and
//!   must reach at least the one that sent the message being answered.
//!
//! The third one carries real weight for asks, because an ask is the one
//! message on this wire whose effect is not idempotent by construction —
//! opening a card twice is two cards, two agents, twice the money. See
//! `Fleet::on`'s handling of `Ask`, and `the_memory_of_a_decision_outlives_
//! any_ask_that_could_still_be_acted_on`, which is the invariant that keeps a
//! redelivered frame from being a second card.
//!
//! ### Attribution, not authorisation
//!
//! A card opened over the flyway runs with `--dangerously-skip-permissions`,
//! like every project card. Nothing here signs an ask or checks a capability,
//! and that is the decision `seal.rs` argues at length rather than an
//! omission: holding the key is already the whole of membership, and anybody
//! who can seal a frame can run code on every machine in the flyway. An extra
//! token would defend against an insider who is fully trusted by construction.
//!
//! What the user's protection *is*, here as in `spawn.rs`, is that **a fan-out
//! is visible**. So every ask carries an `Origin` — which wall asked and which
//! card on it, if a card did — and `Spawn` hands it to the wall that opens the
//! card. The receiving wall must draw it: a card that arrived from the laptop
//! and does not say so is a card nobody in the room with the desktop can
//! account for, and the fan-out is visible only on a wall nobody is looking at.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// How often a wall says what it is.
///
/// Thirty seconds because an announcement carries load — cards working,
/// allowance used — and a figure a minute stale is still a fair basis for
/// choosing a machine, where one ten minutes stale is not. It is a handful of
/// bytes per peer per period, so there is nothing to save by going slower.
pub const ANNOUNCE_EVERY_MS: i64 = 30_000;

/// How long without an announcement before a wall reads as quiet.
///
/// Three periods, not one: a single missing announcement is a dropped frame or
/// a reconnect, and on this machine NordVPN re-keys the tunnel often enough
/// that one missed period is routine. Three in a row is a pattern — the lid is
/// shut, the process is gone, or the network is.
pub const QUIET_AFTER_MS: i64 = 3 * ANNOUNCE_EVERY_MS;

/// How old an ask may be and still open a card.
///
/// An ask is somebody waiting — a card that decided it needed a card on the
/// build box, or a person who pressed a key. Two minutes is long past the point
/// where either has stopped waiting, and the hazard on the other side is real:
/// without a bound, an ask passed to a sleeping wall through a third one opens
/// a card when the lid lifts eight hours later, on a brief written for a
/// morning that is over. That card would run with the machine in its hands and
/// nobody would know why it existed.
pub const ASK_TTL_MS: i64 = 2 * 60_000;

/// How far two machines' clocks may disagree before an ask is refused for it.
///
/// An ask carries the asker's wall clock as well as its hop-counted age (see
/// `Heard` for why ages are hop-counted at all). The age is immune to skew but
/// trusts whoever relayed it; the stamp is immune to a transport holding a
/// frame but trusts the clocks. The ask is checked against both, and this is
/// how much the clocks are allowed to be wrong by. Two minutes is far beyond
/// what NTP leaves between two machines and still small beside the time a
/// decision is remembered for.
pub const CLOCK_SLACK_MS: i64 = 2 * 60_000;

/// When an asker stops waiting and says nobody answered.
///
/// After this the addressee would refuse the ask as expired even with its
/// clock at the far edge of `CLOCK_SLACK_MS`, so no answer saying "opened" can
/// still be on its way *unless* a card really was opened — which is why a late
/// answer still surfaces after this (`Fleet::on`, `Answer`).
pub const GIVE_UP_MS: i64 = ASK_TTL_MS + 2 * CLOCK_SLACK_MS;

/// How long a wall remembers an ask and what it answered.
///
/// This is the memory that turns a repeat into a no-op rather than a second
/// card, so it has to outlast every ask that could still pass the age checks —
/// `the_memory_of_a_decision_outlives_any_ask_that_could_still_be_acted_on`
/// holds the arithmetic. Ten minutes leaves room above the six that requires.
pub const ANSWER_KEPT_MS: i64 = 10 * 60_000;

/// A place a card can stand, as another machine can name it.
///
/// **The shared identity, never the path.** `C:\atelier\skein` means nothing
/// on a laptop whose checkout lives at `D:\src\skein`, and a path written into
/// a request is exactly the thing `spawn.rs` refuses to let an agent choose a
/// card's ground by. The identity is what two walls agree a territory *is*;
/// the name is what a person reads, and plays no part in matching.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Territory {
    pub identity: String,
    pub name: String,
}

/// How much work from elsewhere a wall will take, or `None` for no limit.
///
/// These are the receiving wall's own, and they are a different thing from
/// `spawn.rs`'s `MAX_LIVE` and `MAX_PER_HOUR`, which bound one *card's*
/// children and are both off. Read that module's argument for why they came
/// off — a fan-out you can see is a fan-out you can stop — and then note what
/// is different here: a card opened over the flyway lands on a wall in
/// another room. It is visible, but on a screen the person who caused it may
/// not be in front of. That is why the refusal exists on this path even
/// though its twin is parked on the local one.
///
/// Off by default, for the reason `spawn.rs` gives about its own numbers: any
/// figure written here would be a guess, and a guess shows up as the good case
/// refused. The person who owns the machine sets it if they want one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Bound {
    /// Cards opened for other walls, on this wall at once.
    pub live: Option<u32>,
    /// Cards opened for other walls in the last hour, closed or not — the
    /// shape that sees a loop, which a live count cannot tell from ordinary
    /// work.
    pub per_hour: Option<u32>,
}

/// What a wall says about itself, read fresh by the wiring each time.
///
/// Everything here is what a person choosing *where* a card should run would
/// want to see, and nothing else: which territories it can host, whether it
/// will, how busy it is, and how much of its account is left. Load and
/// allowance are hints — the receiving wall decides against its own live
/// facts, not against what it last announced.
///
/// `#[serde(default)]` on the whole struct because two walls in a flyway are
/// not upgraded at the same moment. A field a newer build adds must read as
/// absent on an older one rather than failing the whole frame, and the frame
/// failing is what would happen without it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Facts {
    pub territories: Vec<Territory>,
    /// Whether this wall takes work from other walls at all. A person's
    /// switch, and it defaults to no — a machine joining a flyway should not
    /// thereby become somewhere anybody can open a card.
    pub accepting: bool,
    pub bound: Bound,
    /// Cards on this wall that another wall asked for, still open.
    pub remote_live: u32,
    /// Cards this wall opened for other walls in the last hour.
    pub remote_last_hour: u32,
    /// Every card on the wall, and how many of those are mid-turn. Working is
    /// the figure that matters for choosing — a wall with forty dormant cards
    /// is idle — but live is what says how crowded the wall already is to
    /// somebody looking at it.
    pub cards_live: u32,
    pub cards_working: u32,
    /// The percentage used of whichever of this wall's allowance windows is
    /// fullest, or `None` if it has not been read. A machine signed in to an
    /// account at 96% is a machine where the new card stops within the hour,
    /// which is the single most useful thing to know before choosing it.
    pub allowance_used: Option<u8>,
}

/// One wall's statement about itself.
///
/// `version` orders a host's statements and nothing else — it is only ever
/// compared with the same host's earlier versions, so whose clock is fast does
/// not matter. `Fleet::announce` derives it from the announcing wall's own
/// clock, which survives a restart without anything being stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Announcement {
    pub host: String,
    pub version: u64,
    pub facts: Facts,
}

/// An announcement as it travels: with how long ago it was made.
///
/// **An age, not a timestamp**, and that is what lets staleness survive both a
/// relay and two machines whose clocks disagree. Each wall that holds an
/// announcement and passes it on adds the time it held it, measured on its own
/// clock; the receiver subtracts the total from *its* clock. Nothing ever
/// compares one machine's clock to another's, so a laptop that is three
/// minutes fast reads the desktop as exactly as quiet as it is — and an
/// announcement relayed through the server an hour after it was made arrives
/// an hour old, rather than as fresh as the moment the server sent it, which
/// is what "when it was last heard from" would otherwise silently become.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heard {
    pub wall: Announcement,
    pub age_ms: u64,
}

/// What this wall knows about another, and when it last knew it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub host: String,
    pub version: u64,
    pub facts: Facts,
    /// When the wall made this statement, on *this* wall's clock. Estimated
    /// from the age it arrived with — see `Heard`.
    pub heard_at: i64,
}

impl Entry {
    pub fn quiet_for(&self, now: i64) -> u64 {
        age(now, self.heard_at)
    }

    /// What a person choosing a host should be told about this one.
    ///
    /// **Quiet comes first and hides the rest**, because what a quiet wall last
    /// said is history: a machine that announced it was idle and then went to
    /// sleep is not idle, and drawing it as available would send an ask into a
    /// two-minute wait for nothing.
    pub fn standing(&self, now: i64) -> Standing {
        let quiet = self.quiet_for(now);
        if quiet as i64 > QUIET_AFTER_MS {
            return Standing::Quiet { for_ms: quiet };
        }
        if !self.facts.accepting {
            return Standing::Closed;
        }
        if let Some(r) = over_bound(&self.facts, 0) {
            return Standing::Full(r);
        }
        Standing::Open
    }
}

/// Four different reasons a wall might not take a card, kept apart.
///
/// The one the brief for this file insisted on is `Quiet` against `Full`: a
/// wall that has stopped talking and a wall that said it is busy call for
/// different things from a person — wake the machine, or wait and close
/// something — and folding both into "unavailable" would hide which.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Standing {
    /// Not heard from for longer than `QUIET_AFTER_MS`.
    Quiet { for_ms: u64 },
    /// Heard from, and not taking work from other walls.
    Closed,
    /// Heard from, taking work, and at its own bound. Carries the refusal it
    /// would make, so the reason drawn beside it is the one an ask would get.
    Full(Refusal),
    Open,
}

impl Standing {
    /// For ordering candidates: the ones an ask would succeed on first.
    fn rank(&self) -> u8 {
        match self {
            Standing::Open => 0,
            Standing::Full(_) => 1,
            Standing::Closed => 2,
            Standing::Quiet { .. } => 3,
        }
    }
}

/// Who asked. A label, believed — see the module comment and `seal.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    pub host: String,
    /// The card on that wall that asked, or `None` when a person did. A card
    /// id from another wall resolves to nothing here, and is carried anyway:
    /// it is what lets the asking wall draw the line from its card to this
    /// one, and what lets a person on either side say which conversation
    /// started it.
    pub card: Option<String>,
}

/// One wall asking another to open a card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    /// Minted once per *gesture* by the asker, and the whole of what makes a
    /// repeat harmless. A retry after a timeout reuses it (`Fleet::ask` with
    /// the same id hands back the same ask), so the far side sees one request
    /// arriving twice rather than two requests.
    ///
    /// Which cuts the other way after a *refusal*: the far side remembers what
    /// it answered, so the same id asked again gets the same refusal even if
    /// the switch has since been thrown. Asking again after being told no is a
    /// new gesture and wants a new id — the reasons that say "ask again" mean
    /// that.
    pub id: String,
    pub from: Origin,
    /// The host it is for. Every other wall passes it on and does nothing else.
    pub to: String,
    /// Matched on `identity`; the name is what the asker calls it, carried so
    /// a refusal for a territory the far side does not have can still say
    /// which one was meant.
    pub territory: Territory,
    /// The new card's first prompt. Not clipped, for `spawn.rs`'s reason: the
    /// brief is the entire channel and it is already paid for. Scrubbed of
    /// impossible characters on the way into a `Spawn`, because it goes
    /// straight into a request the API would refuse otherwise.
    pub brief: String,
    pub title: Option<String>,
    /// The asker's wall clock when it asked. Checked against `CLOCK_SLACK_MS`
    /// — see there for why an ask carries both this and an age.
    pub asked_at: i64,
}

/// Why a wall would not open a card, in terms somebody can act on.
///
/// Every variant is one the receiving wall really makes, and each one's
/// `reason` says what to do about it, because the reader is as often an agent
/// as a person and an agent told only "refused" has no next move but to ask
/// again — which, for most of these, is exactly the wrong one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Refusal {
    /// The person who owns that machine has not let other walls open cards on
    /// it. The first check, because nothing else about the ask matters.
    NotAccepting,
    /// It has no territory with that identity. Says what it does have, the way
    /// `spawn.rs` refuses an unmatched project with the list that would have
    /// matched — the likeliest mistake is the right repo on the wrong machine.
    NoSuchTerritory { wanted: Territory, offered: Vec<Territory> },
    AtLiveBound { live: u32, limit: u32 },
    AtHourlyBound { opened: u32, limit: u32 },
    /// The ask was older than `ASK_TTL_MS` by the time it arrived — see there.
    Expired { waited_ms: u64 },
    /// The asker's clock is further ahead than `CLOCK_SLACK_MS`. Kept apart
    /// from `Expired` because the cure is different: no amount of asking again
    /// fixes a clock.
    ClocksDisagree { ahead_ms: u64 },
    /// It tried and the spawn itself failed — the account is out, the binary
    /// is missing, the directory is gone. The reason is the receiving wall's
    /// own words.
    CouldNotStart { reason: String },
}

impl Refusal {
    /// The refusal as a sentence, naming the wall that made it.
    ///
    /// Scrubbed on the way out because it carries text from both ends — a
    /// territory name the asker sent, a spawn error the receiver wrote — and
    /// it is read by an agent whose next request the API refuses if one of
    /// those smuggled in a control character (`crate::clean`).
    pub fn reason(&self, host: &str) -> String {
        let s = match self {
            Refusal::NotAccepting => format!(
                "{host} is not taking work from other walls — switch that on in the flyway \
                 panel on {host}, or ask another wall that has this territory"
            ),
            Refusal::NoSuchTerritory { wanted, offered } => {
                let has = if offered.is_empty() {
                    "no territories at all".to_string()
                } else {
                    offered.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", ")
                };
                format!(
                    "{host} has no territory {} — it has {has}. open it on {host} first, or ask \
                     a wall that already has it",
                    wanted.name
                )
            }
            Refusal::AtLiveBound { live, limit } => format!(
                "{host} already has {live} cards opened for other walls and takes at most \
                 {limit} at once — close one of those on {host}, raise its bound, or ask \
                 another wall"
            ),
            Refusal::AtHourlyBound { opened, limit } => format!(
                "{host} has opened {opened} cards for other walls in the last hour and takes at \
                 most {limit} an hour — wait, raise its bound, or ask another wall"
            ),
            Refusal::Expired { waited_ms } => format!(
                "the ask was {} old when {host} heard it, and an ask older than {} never opens \
                 a card — so nothing starts on a brief nobody is waiting for any more. ask again \
                 if it is still wanted; if {host} was awake throughout, check the two machines' \
                 clocks agree",
                span(*waited_ms),
                span(ASK_TTL_MS as u64),
            ),
            Refusal::ClocksDisagree { ahead_ms } => format!(
                "the asking wall's clock is {} ahead of {host}'s — set both machines' clocks \
                 from the network, then ask again",
                span(*ahead_ms)
            ),
            Refusal::CouldNotStart { reason } => format!(
                "{host} tried to open the card and could not: {reason} — nothing was opened \
                 there, so once that is fixed it is safe to ask again"
            ),
        };
        crate::clean::scrub(&s).into_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Outcome {
    /// The new card's id on the wall that opened it.
    Opened { card: String },
    Refused { refusal: Refusal },
}

/// The one reply an ask gets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Answer {
    pub request: String,
    /// The wall that answered — which is the wall the card is on, if one was
    /// opened.
    pub by: String,
    /// The wall that asked, so walls in between know where it is going.
    pub asked_by: String,
    pub outcome: Outcome,
}

/// What a wall says to another about the fleet.
///
/// `msg` is the tag, as in `session::Msg`, and the variant names do not
/// collide with that enum's, so the two can share an envelope however it
/// chooses to nest them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum FleetMsg {
    /// Statements about walls. `greeting` marks a full statement of everything
    /// the sender knows, which is answered with whatever it lacked.
    Roster { walls: Vec<Heard>, greeting: bool },
    Ask { ask: Ask, age_ms: u64 },
    Answer { answer: Answer, age_ms: u64 },
}

/// A card this wall has agreed to open. Handed to the wiring, which opens it
/// through the one birth path (`spawn.rs`'s "Rust decides; the wall opens")
/// and then calls `Fleet::opened` or `Fleet::failed` — **exactly one of them,
/// every time**, since until it does the ask counts against this wall's bound
/// and no answer goes back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    pub request: String,
    /// As *this* wall knows it — its own name for the territory, found by
    /// the identity the ask carried.
    pub territory: Territory,
    pub brief: String,
    pub title: Option<String>,
    /// Must be recorded on the card and drawn. See the module comment.
    pub asked_by: Origin,
}

/// Everything one message caused.
#[derive(Debug, Default)]
pub struct Reply {
    /// To be said to every peer — see the module comment on gossip.
    pub say: Vec<FleetMsg>,
    /// Cards to open here.
    pub open: Vec<Spawn>,
    /// Answers to asks *this* wall made, arriving for the first time. The
    /// wiring hands each to whoever asked, which is the receipt.
    pub answered: Vec<Answer>,
}

/// Why an ask never left this wall.
///
/// Distinct from `Refusal` because nobody refused it — this wall can already
/// see it would go nowhere, and saying so now beats an ask waiting out
/// `GIVE_UP_MS` for an answer that cannot come.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsendable {
    /// Use `spawn` — opening a card on this wall needs no flyway.
    ThisWall,
    UnknownHost { host: String, known: Vec<String> },
    Quiet { host: String, for_ms: u64 },
}

impl Unsendable {
    pub fn reason(&self) -> String {
        let s = match self {
            Unsendable::ThisWall => {
                "that is this wall — open the card here, no flyway needed".to_string()
            }
            Unsendable::UnknownHost { host, known } if known.is_empty() => format!(
                "no wall called {host} has been heard from, and no other wall has either — \
                 check this machine is in the flyway"
            ),
            Unsendable::UnknownHost { host, known } => format!(
                "no wall called {host} has been heard from — the walls this one knows are {}",
                known.join(", ")
            ),
            Unsendable::Quiet { host, for_ms } => format!(
                "{host} has not been heard from for {} — it is probably asleep or offline. wake \
                 it, or ask another wall",
                span(*for_ms)
            ),
        };
        crate::clean::scrub(&s).into_owned()
    }
}

/// What a person or a card hands `Fleet::ask`.
#[derive(Debug, Clone)]
pub struct Request {
    pub id: String,
    /// The card asking, or `None` for a person.
    pub card: Option<String>,
    pub to: String,
    pub territory: Territory,
    pub brief: String,
    pub title: Option<String>,
}

/// Something held with an estimate of when its origin made it, on this wall's
/// clock — the local half of `Heard`'s age arithmetic.
#[derive(Debug, Clone)]
struct Held<T> {
    it: T,
    origin_at: i64,
}

#[derive(Debug, Clone)]
struct Waiting {
    asked_at: i64,
    given_up: bool,
}

/// What this wall knows about the others, and the asks in flight between them.
pub struct Fleet {
    me: String,
    roster: BTreeMap<String, Entry>,
    /// Every ask this wall has heard, its own included, by id. Kept for
    /// `ANSWER_KEPT_MS` — this and `answers` are the memory that makes a
    /// repeat a no-op.
    asks: BTreeMap<String, Held<Ask>>,
    answers: BTreeMap<String, Held<Answer>>,
    /// Asks this wall has agreed to and handed out as a `Spawn`, not yet
    /// reported opened or failed. Counted against the bound, which is what
    /// stops two asks in one frame both passing a bound with room for one:
    /// the facts the wiring reads cannot know about a card that has not been
    /// opened yet.
    in_flight: BTreeSet<String>,
    /// This wall's own asks that nobody has answered yet.
    waiting: BTreeMap<String, Waiting>,
    last_version: u64,
}

impl Fleet {
    pub fn new(me: &str) -> Self {
        Self {
            me: me.to_string(),
            roster: BTreeMap::new(),
            asks: BTreeMap::new(),
            answers: BTreeMap::new(),
            in_flight: BTreeSet::new(),
            waiting: BTreeMap::new(),
            last_version: 0,
        }
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// Every wall this one knows about, itself included once it has announced.
    pub fn roster(&self) -> impl Iterator<Item = &Entry> {
        self.roster.values()
    }

    pub fn entry(&self, host: &str) -> Option<&Entry> {
        self.roster.get(host)
    }

    pub fn answer(&self, request: &str) -> Option<&Answer> {
        self.answers.get(request).map(|h| &h.it)
    }

    /// Take a wall off the roster — a machine retired, or renamed.
    ///
    /// Nothing here does this on its own. A quiet wall stays on the roster
    /// drawn as quiet, because "the build box has not been heard from for
    /// three days" is information, and an entry that silently vanished would
    /// read as a machine that was never there.
    pub fn forget(&mut self, host: &str) {
        self.roster.remove(host);
    }

    /// The walls that could host a card in this territory, best first.
    ///
    /// Best is: one that would take it now, then one that is merely full,
    /// then closed, then quiet — so a person sees the dead ends too, with
    /// their reasons, rather than an empty list. Within that, the fewest cards
    /// working, then the most allowance left, then the host name, so the
    /// order is the same on every wall that knows the same things.
    pub fn candidates(&self, territory: &str, now: i64) -> Vec<(&Entry, Standing)> {
        let mut out: Vec<(&Entry, Standing)> = self
            .roster
            .values()
            .filter(|e| e.host != self.me)
            .filter(|e| e.facts.territories.iter().any(|t| t.identity == territory))
            .map(|e| (e, e.standing(now)))
            .collect();
        out.sort_by(|(a, sa), (b, sb)| {
            (sa.rank(), a.facts.cards_working, a.facts.allowance_used.unwrap_or(u8::MAX), &a.host)
                .cmp(&(sb.rank(), b.facts.cards_working, b.facts.allowance_used.unwrap_or(u8::MAX), &b.host))
        });
        out
    }

    /// Say what this wall is. Call every `ANNOUNCE_EVERY_MS`, and whenever
    /// something a chooser would care about changes — a territory opened, the
    /// accepting switch thrown.
    ///
    /// The version is this wall's clock, or one past the last version if the
    /// clock has gone backwards: it must only ever rise for this host, and it
    /// must survive a restart, which a counter in memory would not and a clock
    /// does without anything being stored.
    pub fn announce(&mut self, facts: Facts, now: i64) -> FleetMsg {
        let version = (now.max(0) as u64).max(self.last_version + 1);
        self.last_version = version;
        let e = Entry { host: self.me.clone(), version, facts, heard_at: now };
        self.roster.insert(self.me.clone(), e.clone());
        FleetMsg::Roster { walls: vec![heard(&e, now)], greeting: false }
    }

    /// What to say on connect: everything this wall knows that is still worth
    /// saying. Whoever receives it answers with what this wall lacked.
    pub fn open(&self, now: i64) -> Vec<FleetMsg> {
        let mut out = vec![FleetMsg::Roster {
            walls: self.roster.values().map(|e| heard(e, now)).collect(),
            greeting: true,
        }];
        out.extend(self.gossip(now));
        out
    }

    /// Ask a wall to open a card. What comes back is the message to say; the
    /// answer arrives later through `on`, in `Reply::answered`.
    ///
    /// Asking again with an id already asked hands back the same ask — the
    /// retry is the same request, which is the whole point of the id.
    pub fn ask(&mut self, r: Request, now: i64) -> Result<FleetMsg, Unsendable> {
        if let Some(h) = self.asks.get(&r.id) {
            return Ok(FleetMsg::Ask { ask: h.it.clone(), age_ms: age(now, h.origin_at) });
        }
        if r.to == self.me {
            return Err(Unsendable::ThisWall);
        }
        let Some(there) = self.roster.get(&r.to) else {
            return Err(Unsendable::UnknownHost {
                host: r.to,
                known: self.roster.keys().filter(|h| **h != self.me).cloned().collect(),
            });
        };
        let quiet = there.quiet_for(now);
        if quiet as i64 > QUIET_AFTER_MS {
            return Err(Unsendable::Quiet { host: r.to, for_ms: quiet });
        }
        let ask = Ask {
            id: r.id.clone(),
            from: Origin { host: self.me.clone(), card: r.card },
            to: r.to,
            territory: r.territory,
            brief: r.brief,
            title: r.title,
            asked_at: now,
        };
        self.asks.insert(r.id.clone(), Held { it: ask.clone(), origin_at: now });
        self.waiting.insert(r.id, Waiting { asked_at: now, given_up: false });
        Ok(FleetMsg::Ask { ask, age_ms: 0 })
    }

    /// The card a `Spawn` asked for is open. Returns the answer to say, or
    /// nothing if this request was not in flight — reporting twice is a no-op,
    /// for the same reason everything else here is.
    pub fn opened(&mut self, request: &str, card: &str, now: i64) -> Option<FleetMsg> {
        self.settle(request, Outcome::Opened { card: card.to_string() }, now)
    }

    /// The card a `Spawn` asked for could not be opened.
    pub fn failed(&mut self, request: &str, reason: &str, now: i64) -> Option<FleetMsg> {
        let refusal = Refusal::CouldNotStart { reason: reason.to_string() };
        self.settle(request, Outcome::Refused { refusal }, now)
    }

    fn settle(&mut self, request: &str, outcome: Outcome, now: i64) -> Option<FleetMsg> {
        if !self.in_flight.remove(request) {
            return None;
        }
        let asked_by = self.asks.get(request).map(|h| h.it.from.host.clone())?;
        Some(self.record(Answer { request: request.to_string(), by: self.me.clone(), asked_by, outcome }, now))
    }

    fn record(&mut self, answer: Answer, now: i64) -> FleetMsg {
        self.answers.insert(answer.request.clone(), Held { it: answer.clone(), origin_at: now });
        FleetMsg::Answer { answer, age_ms: 0 }
    }

    /// Forget what is too old to matter, and say which of this wall's own asks
    /// it has given up waiting for. Call on the wiring's tick.
    ///
    /// The given-up list is returned rather than dropped because an ask
    /// nobody answered is still an outcome somebody is waiting to hear — the
    /// card that asked would otherwise wait for ever.
    pub fn prune(&mut self, now: i64) -> Vec<String> {
        self.asks.retain(|_, h| now - h.origin_at <= ANSWER_KEPT_MS);
        self.answers.retain(|_, h| now - h.origin_at <= ANSWER_KEPT_MS);
        let mut gave_up = Vec::new();
        for (id, w) in self.waiting.iter_mut() {
            if !w.given_up && now - w.asked_at > GIVE_UP_MS {
                w.given_up = true;
                gave_up.push(id.clone());
            }
        }
        self.waiting.retain(|_, w| now - w.asked_at <= ANSWER_KEPT_MS);
        gave_up
    }

    /// Answer a message. `here` is this wall's facts *now*, read fresh — an
    /// ask is decided against them, never against what was last announced.
    pub fn on(&mut self, m: FleetMsg, now: i64, here: &Facts) -> Reply {
        let mut reply = Reply::default();
        match m {
            FleetMsg::Roster { walls, greeting } => {
                let mut theirs: BTreeMap<String, u64> = BTreeMap::new();
                let mut news = Vec::new();
                for h in walls {
                    let v = theirs.entry(h.wall.host.clone()).or_insert(0);
                    *v = (*v).max(h.wall.version);
                    if let Some(e) = self.learn(h, now) {
                        news.push(heard(&e, now));
                    }
                }
                if !news.is_empty() {
                    reply.say.push(FleetMsg::Roster { walls: news, greeting: false });
                }
                if greeting {
                    /* Answering in kind, as `session.rs` does with `Hello`: the
                       greeter has stated everything it holds, so what it lacks
                       is exactly the difference, and neither end needs to have
                       been the one that dialled. */
                    let lacking: Vec<Heard> = self
                        .roster
                        .values()
                        .filter(|e| theirs.get(&e.host).is_none_or(|v| *v < e.version))
                        .map(|e| heard(e, now))
                        .collect();
                    if !lacking.is_empty() {
                        reply.say.push(FleetMsg::Roster { walls: lacking, greeting: false });
                    }
                    reply.say.extend(self.gossip(now));
                }
            }

            FleetMsg::Ask { ask, age_ms } => {
                let id = ask.id.clone();
                /* **The repeat.** An ask this wall has seen is never decided
                   twice — that is the second card. If this wall is the one it
                   was for and has answered, the repeat is most likely the asker
                   retrying because the answer was lost, so the answer is said
                   again; the asker's own dedup makes that free if it was not. */
                if self.asks.contains_key(&id) || self.answers.contains_key(&id) || self.in_flight.contains(&id) {
                    if ask.to == self.me {
                        if let Some(h) = self.answers.get(&id) {
                            reply.say.push(FleetMsg::Answer { answer: h.it.clone(), age_ms: age(now, h.origin_at) });
                        }
                    }
                    return reply;
                }
                let origin_at = now.saturating_sub(clamp(age_ms));
                self.asks.insert(id.clone(), Held { it: ask.clone(), origin_at });

                if ask.to != self.me {
                    reply.say.push(FleetMsg::Ask { ask, age_ms: age(now, origin_at) });
                    return reply;
                }
                match self.decide(&ask, age_ms, now, here) {
                    Ok(spawn) => {
                        self.in_flight.insert(id);
                        reply.open.push(spawn);
                    }
                    Err(refusal) => {
                        let answer = Answer {
                            request: id,
                            by: self.me.clone(),
                            asked_by: ask.from.host.clone(),
                            outcome: Outcome::Refused { refusal },
                        };
                        reply.say.push(self.record(answer, now));
                    }
                }
            }

            FleetMsg::Answer { answer, age_ms } => {
                if self.answers.contains_key(&answer.request) {
                    return reply;
                }
                let origin_at = now.saturating_sub(clamp(age_ms));
                self.answers.insert(answer.request.clone(), Held { it: answer.clone(), origin_at });
                if answer.asked_by == self.me {
                    /* Reported even if this wall had given up waiting. Past
                       `GIVE_UP_MS` the far side should have refused as expired,
                       so an answer that says "opened" this late means a card
                       really is running there — and the card that asked is the
                       one that most needs to know, having been told nobody
                       answered. */
                    if self.waiting.remove(&answer.request).is_some() {
                        reply.answered.push(answer);
                    }
                } else {
                    reply.say.push(FleetMsg::Answer { answer, age_ms: age(now, origin_at) });
                }
            }
        }
        reply
    }

    /// Whether to open a card for this ask, against this wall's facts now.
    ///
    /// The order is the order of what would make the rest moot: an ask too old
    /// to act on, then a wall that takes nothing, then the territory, then the
    /// bounds — so the refusal names the thing that would have to change
    /// first, not the third of three.
    fn decide(&self, ask: &Ask, hop_age: u64, now: i64, here: &Facts) -> Result<Spawn, Refusal> {
        let by_clock = now - ask.asked_at;
        if by_clock < -CLOCK_SLACK_MS {
            return Err(Refusal::ClocksDisagree { ahead_ms: (-by_clock) as u64 });
        }
        /* Both measures, because each covers the other's blind spot: the hop
           age catches an ask held by a wall that relayed it, whatever the
           clocks say; the stamp catches a frame the *transport* held and
           redelivered with the age it left with, which no wall ever saw. */
        if clamp(hop_age) > ASK_TTL_MS || by_clock > ASK_TTL_MS + CLOCK_SLACK_MS {
            return Err(Refusal::Expired { waited_ms: hop_age.max(by_clock.max(0) as u64) });
        }
        if !here.accepting {
            return Err(Refusal::NotAccepting);
        }
        let Some(t) = here.territories.iter().find(|t| t.identity == ask.territory.identity) else {
            return Err(Refusal::NoSuchTerritory {
                wanted: ask.territory.clone(),
                offered: here.territories.clone(),
            });
        };
        if let Some(r) = over_bound(here, self.in_flight.len() as u32) {
            return Err(r);
        }
        Ok(Spawn {
            request: ask.id.clone(),
            territory: t.clone(),
            brief: crate::clean::scrub(&ask.brief).into_owned(),
            title: ask.title.as_deref().map(|s| crate::clean::scrub(s).into_owned()),
            asked_by: ask.from.clone(),
        })
    }

    /// Fold one statement in. Returns the entry if it was news — a version of
    /// that host this wall had not heard — which is what gets passed on.
    ///
    /// The kept entry is the greatest by `(version, heard_at)`, which is a max
    /// over a total order and so cannot depend on arrival order — the property
    /// `a_roster_converges_however_announcements_interleave` holds. A same-
    /// version copy that arrived by a quicker path improves the estimate of
    /// when it was said but is not news: passing it on would be every relay
    /// re-announcing every wall once per path.
    ///
    /// Statements about this wall itself are ignored. It knows what it is
    /// better than any relay does, and an old copy of its own announcement
    /// coming back round must never overwrite the current one.
    fn learn(&mut self, h: Heard, now: i64) -> Option<Entry> {
        if h.wall.host == self.me {
            return None;
        }
        let incoming = Entry {
            host: h.wall.host.clone(),
            version: h.wall.version,
            facts: h.wall.facts,
            heard_at: now.saturating_sub(clamp(h.age_ms)),
        };
        match self.roster.get(&incoming.host) {
            Some(e) if (e.version, e.heard_at) >= (incoming.version, incoming.heard_at) => None,
            Some(e) if e.version == incoming.version => {
                self.roster.insert(incoming.host.clone(), incoming);
                None
            }
            _ => {
                self.roster.insert(incoming.host.clone(), incoming.clone());
                Some(incoming)
            }
        }
    }

    /// The asks and answers worth passing to a wall that has just arrived.
    ///
    /// Asks only while they could still be acted on, and never the ones for
    /// this wall — it is their destination, and nobody beyond it needs them.
    /// Answers for as long as they are kept, since the asker may be the wall
    /// that just arrived.
    fn gossip(&self, now: i64) -> Vec<FleetMsg> {
        let asks = self
            .asks
            .values()
            .filter(|h| h.it.to != self.me)
            .filter(|h| !self.answers.contains_key(&h.it.id))
            .filter(|h| now - h.origin_at <= ASK_TTL_MS)
            .map(|h| FleetMsg::Ask { ask: h.it.clone(), age_ms: age(now, h.origin_at) });
        let answers = self
            .answers
            .values()
            .map(|h| FleetMsg::Answer { answer: h.it.clone(), age_ms: age(now, h.origin_at) });
        asks.chain(answers).collect()
    }
}

/// The bound refusal a wall would make with this many asks already agreed to.
/// One function for `decide` and `Entry::standing`, so the reason drawn beside
/// a full wall is word for word the one an ask to it would get.
fn over_bound(f: &Facts, in_flight: u32) -> Option<Refusal> {
    if let Some(limit) = f.bound.live {
        let live = f.remote_live.saturating_add(in_flight);
        if live >= limit {
            return Some(Refusal::AtLiveBound { live, limit });
        }
    }
    if let Some(limit) = f.bound.per_hour {
        let opened = f.remote_last_hour.saturating_add(in_flight);
        if opened >= limit {
            return Some(Refusal::AtHourlyBound { opened, limit });
        }
    }
    None
}

fn heard(e: &Entry, now: i64) -> Heard {
    Heard {
        wall: Announcement { host: e.host.clone(), version: e.version, facts: e.facts.clone() },
        age_ms: age(now, e.heard_at),
    }
}

/// How long ago, never negative. A wall whose estimate of when something was
/// said lands in its own future — a relay with a confused clock — reads it as
/// just now rather than as a negative age wrapping to the far end of a `u64`.
fn age(now: i64, at: i64) -> u64 {
    now.saturating_sub(at).max(0) as u64
}

/// An age off the wire as something safe to subtract. A peer is trusted, but a
/// corrupt frame claiming an age of `u64::MAX` should not wrap the arithmetic.
fn clamp(age_ms: u64) -> i64 {
    age_ms.min(i64::MAX as u64) as i64
}

/// A duration as a person says it.
fn span(ms: u64) -> String {
    let s = ms / 1000;
    if s < 90 {
        format!("{s}s")
    } else if s < 90 * 60 {
        format!("{} min", (s + 30) / 60)
    } else {
        format!("{} h", (s + 1800) / 3600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(identity: &str, name: &str) -> Territory {
        Territory { identity: identity.into(), name: name.into() }
    }

    fn skein() -> Territory {
        t("tid-skein", "skein")
    }

    /// A wall hosting skein and taking work, with no bound.
    fn open_facts() -> Facts {
        Facts { territories: vec![skein()], accepting: true, ..Default::default() }
    }

    struct Node {
        f: Fleet,
        here: Facts,
        spawns: Vec<Spawn>,
        answered: Vec<Answer>,
    }

    impl Node {
        fn new(host: &str, here: Facts) -> Self {
            Self { f: Fleet::new(host), here, spawns: Vec::new(), answered: Vec::new() }
        }

        fn hear(&mut self, m: FleetMsg, now: i64) -> Vec<FleetMsg> {
            let r = self.f.on(m, now, &self.here);
            self.spawns.extend(r.open);
            self.answered.extend(r.answered);
            r.say
        }

        fn hear_all(&mut self, ms: Vec<FleetMsg>, now: i64) -> Vec<FleetMsg> {
            ms.into_iter().flat_map(|m| self.hear(m, now)).collect()
        }
    }

    /// Two walls meet and talk until neither has anything to say. Bounded, so
    /// a protocol that echoed for ever fails here rather than hanging.
    fn converse(a: &mut Node, b: &mut Node, now: i64) {
        let mut to_b = a.f.open(now);
        let mut to_a = b.f.open(now);
        for _ in 0..12 {
            if to_a.is_empty() && to_b.is_empty() {
                return;
            }
            let next_a = b.hear_all(std::mem::take(&mut to_b), now);
            let next_b = a.hear_all(std::mem::take(&mut to_a), now);
            to_a = next_a;
            to_b = next_b;
        }
        panic!("the exchange never went quiet");
    }

    fn request(id: &str, to: &str, territory: Territory) -> Request {
        Request {
            id: id.into(),
            card: Some("card-1".into()),
            to: to.into(),
            territory,
            brief: "build the thing".into(),
            title: None,
        }
    }

    fn snapshot(f: &Fleet) -> Vec<(String, u64, Facts, i64)> {
        f.roster().map(|e| (e.host.clone(), e.version, e.facts.clone(), e.heard_at)).collect()
    }

    /// A deterministic shuffle — the suite has no `rand`, and a property test
    /// whose failures cannot be replayed is a property test nobody can fix.
    fn shuffled<T: Clone>(xs: &[T], seed: u64) -> Vec<T> {
        let mut v = xs.to_vec();
        let mut s = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        for i in (1..v.len()).rev() {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let j = (s >> 33) as usize % (i + 1);
            v.swap(i, j);
        }
        v
    }

    fn announced(host: &str, version: u64, working: u32, age_ms: u64) -> FleetMsg {
        FleetMsg::Roster {
            walls: vec![Heard {
                wall: Announcement {
                    host: host.into(),
                    version,
                    facts: Facts { cards_working: working, ..open_facts() },
                },
                age_ms,
            }],
            greeting: false,
        }
    }

    /// **The property.** Statements about three walls — several versions
    /// each, one version arriving by two paths with different ages, some
    /// bundled the way a relay bundles them — reach an observer in every
    /// order. It must end up with the same roster every time, or two walls
    /// looking at the same fleet would offer a person different machines.
    #[test]
    fn a_roster_converges_however_announcements_interleave() {
        let bundle = FleetMsg::Roster {
            walls: vec![
                Heard {
                    wall: Announcement { host: "lap".into(), version: 2, facts: Facts { cards_working: 2, ..open_facts() } },
                    age_ms: 4_000,
                },
                Heard {
                    wall: Announcement { host: "server".into(), version: 1, facts: Facts { cards_working: 0, ..open_facts() } },
                    age_ms: 9_000,
                },
            ],
            greeting: false,
        };
        let msgs = vec![
            announced("desk", 1, 1, 60_000),
            announced("desk", 2, 3, 30_000),
            announced("desk", 3, 5, 1_000),
            /* The same statement by a slower path: it must not displace the
               quicker estimate whichever arrives first. */
            announced("desk", 3, 5, 8_000),
            announced("lap", 1, 0, 50_000),
            bundle,
            announced("lap", 2, 2, 2_000),
            announced("server", 4, 7, 500),
        ];

        let now = 1_000_000;
        let fold = |ms: &[FleetMsg]| {
            let mut n = Node::new("observer", open_facts());
            for m in ms {
                n.hear(m.clone(), now);
            }
            snapshot(&n.f)
        };
        let reference = fold(&msgs);
        for seed in 0..200 {
            assert_eq!(fold(&shuffled(&msgs, seed)), reference, "seed {seed}");
        }

        let desk = reference.iter().find(|e| e.0 == "desk").unwrap();
        assert_eq!((desk.1, desk.3), (3, now - 1_000), "the newest version, by its quickest path");
        let server = reference.iter().find(|e| e.0 == "server").unwrap();
        assert_eq!(server.1, 4, "an older version bundled by a relay did not win");
    }

    /// The same property through real meetings rather than a bag: three walls
    /// that meet in pairs, in different orders, all end up knowing all three.
    #[test]
    fn walls_that_only_ever_meet_in_pairs_all_learn_the_whole_fleet() {
        let orders: [[(usize, usize); 3]; 3] = [[(0, 1), (1, 2), (0, 1)], [(1, 2), (0, 1), (1, 2)], [(0, 2), (1, 2), (0, 1)]];
        let mut outcomes = Vec::new();
        for order in orders {
            let mut nodes = vec![
                Node::new("desk", open_facts()),
                Node::new("server", open_facts()),
                Node::new("lap", open_facts()),
            ];
            for n in nodes.iter_mut() {
                n.f.announce(n.here.clone(), 100);
            }
            for (i, j) in order {
                let (lo, hi) = nodes.split_at_mut(j);
                converse(&mut lo[i], &mut hi[0], 200);
            }
            let views: Vec<Vec<(String, u64)>> =
                nodes.iter().map(|n| n.f.roster().map(|e| (e.host.clone(), e.version)).collect()).collect();
            assert!(views.iter().all(|v| *v == views[0]), "{order:?}: {views:?}");
            assert_eq!(views[0].len(), 3);
            outcomes.push(views[0].clone());
        }
        assert!(outcomes.iter().all(|o| *o == outcomes[0]));
    }

    /// An announcement relayed an hour after it was made arrives an hour old —
    /// and the reading is right even on a wall whose clock is an hour fast,
    /// because nothing compares one machine's clock with another's.
    #[test]
    fn a_relayed_announcement_keeps_its_age_whatever_the_clocks_say() {
        let mut desk = Node::new("desk", open_facts());
        let mut server = Node::new("server", open_facts());
        let mut lap = Node::new("lap", open_facts());

        desk.f.announce(open_facts(), 0);
        converse(&mut desk, &mut server, 0);
        /* The desk sleeps. An hour later on the server's clock the laptop
           arrives — and the laptop's clock is a further hour ahead. */
        let hour = 3_600_000;
        let server_sees = server.f.open(hour);
        let lap_now = 2 * hour;
        lap.hear_all(server_sees, lap_now);

        let e = lap.f.entry("desk").expect("learned through the server");
        assert_eq!(e.quiet_for(lap_now), hour as u64, "an hour old, not fresh from the relay");
        assert!(matches!(e.standing(lap_now), Standing::Quiet { .. }));
    }

    /// **Quiet is not busy.** A wall that said it was full and a wall that has
    /// stopped talking want different things from a person, so they must read
    /// differently — and a wall that went quiet after saying it was idle must
    /// not read as idle.
    #[test]
    fn a_stale_entry_is_not_a_busy_one() {
        let mut me = Node::new("me", open_facts());
        let full = Facts { bound: Bound { live: Some(2), per_hour: None }, remote_live: 2, ..open_facts() };
        me.hear(FleetMsg::Roster { walls: vec![Heard { wall: Announcement { host: "busy".into(), version: 1, facts: full }, age_ms: 0 }], greeting: false }, 0);
        me.hear(announced("idle", 1, 0, 0), 0);

        let soon = 10_000;
        assert!(matches!(me.f.entry("busy").unwrap().standing(soon), Standing::Full(Refusal::AtLiveBound { live: 2, limit: 2 })));
        assert_eq!(me.f.entry("idle").unwrap().standing(soon), Standing::Open);

        let later = QUIET_AFTER_MS + 1;
        assert!(matches!(me.f.entry("idle").unwrap().standing(later), Standing::Quiet { .. }), "idle when last heard is not idle now");
        assert!(matches!(me.f.entry("busy").unwrap().standing(later), Standing::Quiet { .. }), "nor is full: what a quiet wall said is history");

        /* One missed announcement is a dropped frame, not a quiet wall. */
        assert_eq!(me.f.entry("idle").unwrap().standing(ANNOUNCE_EVERY_MS * 2), Standing::Open);
    }

    /// A wall knows itself better than any relay does. An old copy of its own
    /// announcement coming back round must not replace the current one.
    #[test]
    fn a_wall_is_never_told_what_it_is_by_an_echo() {
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(Facts { cards_working: 9, ..open_facts() }, 5_000);
        desk.hear(announced("desk", 1, 0, 0), 6_000);
        assert_eq!(desk.f.entry("desk").unwrap().facts.cards_working, 9);
    }

    /// The version only rises for a host, even if the clock it is drawn from
    /// steps backwards — otherwise every wall would ignore it until the clock
    /// caught up.
    #[test]
    fn a_clock_stepping_back_does_not_freeze_a_wall_on_the_roster() {
        let mut desk = Fleet::new("desk");
        desk.announce(open_facts(), 10_000);
        let FleetMsg::Roster { walls, .. } = desk.announce(open_facts(), 4_000) else { unreachable!() };
        assert!(walls[0].wall.version > 10_000);
    }

    /// Either end may open, and the other answers with what the opener lacked
    /// — over a relay neither end is the client.
    #[test]
    fn either_side_may_open_and_the_other_answers_in_kind() {
        let mut a = Node::new("a", open_facts());
        let mut b = Node::new("b", open_facts());
        a.f.announce(open_facts(), 0);
        b.f.announce(open_facts(), 0);

        /* Only A opens. */
        let replies = b.hear_all(a.f.open(0), 0);
        a.hear_all(replies, 0);
        assert!(a.f.entry("b").is_some(), "A learned B from B's answer");
        assert!(b.f.entry("a").is_some());
    }

    /// The greeting that echoed: two walls that already agree must go quiet at
    /// once rather than re-stating each other.
    #[test]
    fn two_walls_that_agree_have_nothing_to_say() {
        let mut a = Node::new("a", open_facts());
        let mut b = Node::new("b", open_facts());
        a.f.announce(open_facts(), 0);
        b.f.announce(open_facts(), 0);
        converse(&mut a, &mut b, 0);
        let replies = b.hear_all(a.f.open(1_000), 1_000);
        assert!(replies.is_empty(), "{replies:?}");
    }

    /// An ask, a card, an answer: the whole round trip, and the card knows
    /// who asked for it.
    #[test]
    fn an_ask_opens_a_card_and_the_asker_hears_which() {
        let mut lap = Node::new("lap", open_facts());
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        converse(&mut lap, &mut desk, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        let said = desk.hear(ask, 1_100);
        assert!(said.is_empty(), "nothing is said until the card is really open");
        assert_eq!(desk.spawns.len(), 1);

        /* A card born elsewhere is attributable: the wall opening it is told
           which wall and which card asked. */
        let s = &desk.spawns[0];
        assert_eq!(s.asked_by, Origin { host: "lap".into(), card: Some("card-1".into()) });
        assert_eq!(s.territory, skein());

        let answer = desk.f.opened("r1", "card-on-desk", 2_000).unwrap();
        lap.hear(answer, 2_100);
        assert_eq!(lap.answered.len(), 1);
        assert_eq!(lap.answered[0].by, "desk");
        assert_eq!(lap.answered[0].outcome, Outcome::Opened { card: "card-on-desk".into() });
    }

    /// **A repeated ask opens one card.** Arriving twice from the transport,
    /// arriving again by another path, arriving while the card is still being
    /// opened, and arriving after — none of it is a second card.
    #[test]
    fn a_repeated_ask_does_not_open_two_cards() {
        let mut lap = Node::new("lap", open_facts());
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        converse(&mut lap, &mut desk, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        desk.hear(ask.clone(), 1_000);
        desk.hear(ask.clone(), 1_001);
        assert_eq!(desk.spawns.len(), 1, "in flight, a repeat is silence");

        desk.f.opened("r1", "card-on-desk", 2_000).unwrap();
        assert!(desk.f.opened("r1", "card-on-desk", 2_001).is_none(), "reporting twice is a no-op");

        /* The asker retries with the same id because it never heard back. */
        let retry = lap.f.ask(request("r1", "desk", skein()), 30_000).unwrap();
        let said = desk.hear(retry, 30_000);
        assert_eq!(desk.spawns.len(), 1, "answered, a repeat is still not a card");
        assert!(
            matches!(&said[..], [FleetMsg::Answer { answer, .. }] if answer.outcome == Outcome::Opened { card: "card-on-desk".into() }),
            "but the answer is said again, since the asker evidently lost it: {said:?}"
        );
        lap.hear_all(said, 30_000);
        assert_eq!(lap.answered.len(), 1);
    }

    /// Two different asks in one frame, a bound with room for one. The facts
    /// the wiring reads cannot know about a card not yet opened, so the
    /// in-flight count is what stops both passing.
    #[test]
    fn two_asks_at_once_cannot_both_squeeze_under_a_bound_of_one() {
        let here = Facts { bound: Bound { live: Some(1), per_hour: None }, ..open_facts() };
        let mut desk = Node::new("desk", here.clone());
        let mut lap = Node::new("lap", open_facts());
        desk.f.announce(here, 0);
        converse(&mut lap, &mut desk, 0);

        let one = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        let two = lap.f.ask(request("r2", "desk", skein()), 1_000).unwrap();
        let said = desk.hear_all(vec![one, two], 1_000);
        assert_eq!(desk.spawns.len(), 1);
        assert!(matches!(
            &said[..],
            [FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal: Refusal::AtLiveBound { live: 1, limit: 1 } }, .. }, .. }]
        ), "{said:?}");
    }

    /// The invariant under the dedup. A wall remembers what it decided for
    /// `ANSWER_KEPT_MS`; an ask may still pass the age checks up to
    /// `ASK_TTL_MS + CLOCK_SLACK_MS` after it was stamped, by a clock up to
    /// `CLOCK_SLACK_MS` ahead. If the memory were shorter than that, a frame
    /// the transport redelivered late would meet no memory and still pass —
    /// and be a second card.
    #[test]
    fn the_memory_of_a_decision_outlives_any_ask_that_could_still_be_acted_on() {
        assert!(ANSWER_KEPT_MS > ASK_TTL_MS + 2 * CLOCK_SLACK_MS);
        assert!(GIVE_UP_MS < ANSWER_KEPT_MS, "a late answer must still find its waiting entry");
        assert!(QUIET_AFTER_MS > ANNOUNCE_EVERY_MS);
    }

    /// And the behaviour that invariant buys: the transport redelivers an ask
    /// long after the memory of it is gone, carrying the age it left with. The
    /// stamp catches it.
    #[test]
    fn a_redelivery_after_the_memory_is_gone_is_refused_not_opened() {
        let mut lap = Node::new("lap", open_facts());
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        converse(&mut lap, &mut desk, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        desk.hear(ask.clone(), 1_000);
        desk.f.opened("r1", "c", 1_500);

        /* Past the memory of the *answer*, which was made at 1_500 — the ask's
           own memory went half a second earlier. */
        let much_later = 1_500 + ANSWER_KEPT_MS + 1;
        desk.f.prune(much_later);
        let said = desk.hear(ask, much_later);
        assert_eq!(desk.spawns.len(), 1);
        assert!(matches!(
            &said[..],
            [FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal: Refusal::Expired { .. } }, .. }, .. }]
        ), "{said:?}");
    }

    /// Three walls, two awake at a time: the laptop asks the desktop through
    /// the server, and the answer comes back the same way. Nobody but the desk
    /// opens anything.
    #[test]
    fn an_ask_and_its_answer_travel_through_a_third_wall() {
        let mut desk = Node::new("desk", open_facts());
        let mut server = Node::new("server", open_facts());
        let mut lap = Node::new("lap", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        server.f.announce(server.here.clone(), 0);
        converse(&mut desk, &mut server, 0);
        converse(&mut server, &mut lap, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        let passed = server.hear(ask, 1_000);
        assert!(server.spawns.is_empty(), "not for the server");
        desk.hear_all(passed, 1_000);
        assert_eq!(desk.spawns.len(), 1);

        let answer = desk.f.opened("r1", "card-on-desk", 2_000).unwrap();
        let passed = server.hear(answer, 2_000);
        lap.hear_all(passed, 2_000);
        assert_eq!(lap.answered.len(), 1);
        assert_eq!(lap.answered[0].outcome, Outcome::Opened { card: "card-on-desk".into() });
    }

    /// The hazard `ASK_TTL_MS` exists for: an ask left with a relay while its
    /// addressee sleeps must not open a card when the lid lifts hours later.
    #[test]
    fn an_ask_held_while_its_wall_slept_does_not_open_a_card_on_waking() {
        let mut desk = Node::new("desk", open_facts());
        let mut server = Node::new("server", open_facts());
        let mut lap = Node::new("lap", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        converse(&mut desk, &mut server, 0);
        converse(&mut server, &mut lap, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        server.hear(ask, 1_000);
        /* The desk sleeps; the server is still holding the ask when it wakes,
           but past the TTL it is no longer gossiped. */
        let morning = 1_000 + 8 * 3_600_000;
        assert!(server.f.open(morning).iter().all(|m| !matches!(m, FleetMsg::Ask { .. })));
        /* And even handed directly — say a relay that ignores the TTL — the
           hop age refuses it, with the clocks in perfect agreement. */
        let stale = FleetMsg::Ask {
            ask: server.f.asks.get("r1").unwrap().it.clone(),
            age_ms: (morning - 1_000) as u64,
        };
        desk.hear(stale, morning);
        assert!(desk.spawns.is_empty());
    }

    /// **Every refusal is reachable, and every one says what to do.** The
    /// match below is exhaustive on purpose: a variant added without a way to
    /// reach it here fails to compile rather than going untested.
    #[test]
    fn every_refusal_is_reachable_and_actionable() {
        fn which(r: &Refusal) -> usize {
            match r {
                Refusal::NotAccepting => 0,
                Refusal::NoSuchTerritory { .. } => 1,
                Refusal::AtLiveBound { .. } => 2,
                Refusal::AtHourlyBound { .. } => 3,
                Refusal::Expired { .. } => 4,
                Refusal::ClocksDisagree { .. } => 5,
                Refusal::CouldNotStart { .. } => 6,
            }
        }
        const ALL: usize = 7;

        let now = 10_000_000;
        let ask_with = |id: &str, territory: Territory, asked_at: i64| Ask {
            id: id.into(),
            from: Origin { host: "lap".into(), card: None },
            to: "desk".into(),
            territory,
            brief: "b".into(),
            title: None,
            asked_at,
        };
        let refused = |here: Facts, ask: Ask, age_ms: u64| -> Refusal {
            let mut desk = Fleet::new("desk");
            let r = desk.on(FleetMsg::Ask { ask, age_ms }, now, &here);
            assert!(r.open.is_empty());
            match &r.say[..] {
                [FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal }, .. }, .. }] => refusal.clone(),
                other => panic!("expected one refusal, got {other:?}"),
            }
        };

        let mut got = vec![
            refused(Facts { accepting: false, ..open_facts() }, ask_with("a", skein(), now), 0),
            refused(open_facts(), ask_with("b", t("tid-nova", "nova"), now), 0),
            refused(Facts { bound: Bound { live: Some(3), per_hour: None }, remote_live: 3, ..open_facts() }, ask_with("c", skein(), now), 0),
            refused(Facts { bound: Bound { live: None, per_hour: Some(6) }, remote_last_hour: 6, ..open_facts() }, ask_with("d", skein(), now), 0),
            refused(open_facts(), ask_with("e", skein(), now), (ASK_TTL_MS + 1) as u64),
            refused(open_facts(), ask_with("f", skein(), now + CLOCK_SLACK_MS + 60_000), 0),
        ];
        let mut desk = Fleet::new("desk");
        let r = desk.on(FleetMsg::Ask { ask: ask_with("g", skein(), now), age_ms: 0 }, now, &open_facts());
        assert_eq!(r.open.len(), 1);
        match desk.failed("g", "the account is out of allowance until 14:00", now) {
            Some(FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal }, .. }, .. }) => got.push(refusal),
            other => panic!("{other:?}"),
        }

        let reached: BTreeSet<usize> = got.iter().map(which).collect();
        assert_eq!(reached.len(), ALL, "every refusal reached: {got:?}");

        let actions = ["ask again", "ask another wall", "ask a wall", "switch that on", "close one", "set both", "raise its bound", "wait"];
        for r in &got {
            let s = r.reason("desk");
            assert!(s.contains("desk"), "names the wall that refused: {s}");
            assert!(actions.iter().any(|a| s.contains(a)), "says what to do: {s}");
        }

        /* The two that most need their specifics carried, carry them. */
        assert!(got[1].reason("desk").contains("nova"), "which territory was meant");
        assert!(got[1].reason("desk").contains("skein"), "and which it does have");
        assert!(got[6].reason("desk").contains("until 14:00"), "the receiving wall's own words");
    }

    /// The order of checks names the thing that would have to change first: a
    /// wall that takes nothing says so, rather than that it lacks the
    /// territory too.
    #[test]
    fn a_closed_wall_says_it_is_closed_before_anything_else() {
        let mut desk = Fleet::new("desk");
        let here = Facts { accepting: false, territories: vec![], ..Default::default() };
        let ask = Ask {
            id: "r".into(),
            from: Origin { host: "lap".into(), card: None },
            to: "desk".into(),
            territory: t("tid-nova", "nova"),
            brief: "b".into(),
            title: None,
            asked_at: 0,
        };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &here);
        assert!(matches!(
            &r.say[..],
            [FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal: Refusal::NotAccepting }, .. }, .. }]
        ));
    }

    /// What this wall can already see is pointless never leaves it.
    #[test]
    fn an_ask_that_could_go_nowhere_is_refused_before_it_is_sent() {
        let mut lap = Node::new("lap", open_facts());
        lap.hear(announced("desk", 1, 0, 0), 0);

        assert_eq!(lap.f.ask(request("a", "lap", skein()), 0), Err(Unsendable::ThisWall));
        match lap.f.ask(request("b", "nowhere", skein()), 0) {
            Err(e @ Unsendable::UnknownHost { .. }) => assert!(e.reason().contains("desk"), "lists who it does know"),
            other => panic!("{other:?}"),
        }
        match lap.f.ask(request("c", "desk", skein()), QUIET_AFTER_MS + 1) {
            Err(e @ Unsendable::Quiet { .. }) => assert!(e.reason().contains("ask another wall")),
            other => panic!("{other:?}"),
        }
        assert!(lap.f.waiting.is_empty(), "nothing refused here is waited for");
    }

    /// An ask nobody answers is still an outcome, and is reported once.
    #[test]
    fn an_ask_nobody_answers_is_given_up_on_out_loud() {
        let mut lap = Node::new("lap", open_facts());
        lap.hear(announced("desk", 1, 0, 0), 0);
        lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();

        assert!(lap.f.prune(1_000 + GIVE_UP_MS).is_empty());
        assert_eq!(lap.f.prune(1_000 + GIVE_UP_MS + 1), vec!["r1".to_string()]);
        assert!(lap.f.prune(1_000 + GIVE_UP_MS + 2).is_empty(), "said once");

        /* And if a card really was opened after all, the asker still hears. */
        let late = FleetMsg::Answer {
            answer: Answer {
                request: "r1".into(),
                by: "desk".into(),
                asked_by: "lap".into(),
                outcome: Outcome::Opened { card: "c".into() },
            },
            age_ms: 0,
        };
        lap.hear(late, 1_000 + GIVE_UP_MS + 3);
        assert_eq!(lap.answered.len(), 1);
    }

    /// The brief goes straight into a card's first request, and a control
    /// character in it would make the API refuse that request — the card would
    /// be born unable to speak.
    #[test]
    fn the_brief_arrives_without_characters_it_could_not_send() {
        let mut desk = Fleet::new("desk");
        let ask = Ask {
            id: "r".into(),
            from: Origin { host: "lap".into(), card: None },
            to: "desk".into(),
            territory: skein(),
            brief: "build\u{0}the\u{7}thing\nplease".into(),
            title: Some("t\u{1b}itle".into()),
            asked_at: 0,
        };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &open_facts());
        assert_eq!(r.open[0].brief, "buildthething\nplease");
        assert_eq!(r.open[0].title.as_deref(), Some("title"));
    }

    /// Candidates come best first, dead ends included with their reasons, and
    /// never this wall itself.
    #[test]
    fn candidates_are_ordered_by_what_would_actually_work() {
        let mut me = Node::new("me", open_facts());
        me.f.announce(open_facts(), 0);
        let heard = |host: &str, facts: Facts, age_ms: u64| FleetMsg::Roster {
            walls: vec![Heard { wall: Announcement { host: host.into(), version: 1, facts }, age_ms }],
            greeting: false,
        };
        me.hear(heard("asleep", open_facts(), (QUIET_AFTER_MS * 2) as u64), 0);
        me.hear(heard("closed", Facts { accepting: false, ..open_facts() }, 0), 0);
        me.hear(heard("busy", Facts { cards_working: 6, ..open_facts() }, 0), 0);
        me.hear(heard("calm", Facts { cards_working: 1, ..open_facts() }, 0), 0);
        me.hear(heard("elsewhere", Facts { territories: vec![t("tid-nova", "nova")], ..open_facts() }, 0), 0);

        let order: Vec<&str> = me.f.candidates("tid-skein", 0).iter().map(|(e, _)| e.host.as_str()).collect();
        assert_eq!(order, vec!["calm", "busy", "closed", "asleep"]);
    }

    /// The wire is what two builds share. An older wall must read a newer
    /// one's facts, which is what `#[serde(default)]` is for.
    #[test]
    fn the_wire_survives_a_round_trip_and_a_missing_field() {
        let mut lap = Fleet::new("lap");
        let m = lap.announce(Facts { allowance_used: Some(40), ..open_facts() }, 7);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"msg\":\"roster\""), "{json}");
        assert_eq!(serde_json::from_str::<FleetMsg>(&json).unwrap(), m);

        let sparse = r#"{"msg":"roster","greeting":false,"walls":[{"wall":{"host":"old","version":1,"facts":{"accepting":true}},"age_ms":0}]}"#;
        let FleetMsg::Roster { walls, .. } = serde_json::from_str::<FleetMsg>(sparse).unwrap() else { unreachable!() };
        assert!(walls[0].wall.facts.accepting);
        assert!(walls[0].wall.facts.territories.is_empty());
    }
}
