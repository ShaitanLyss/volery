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
//! The one thing the wiring must *keep* for it is the last roster version it
//! announced (`Fleet::version`, handed back to `Fleet::new`) — see `announce`
//! for the restart that freezes a wall on every peer's roster without it.
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
//!   version, an ask and its answer on the asking host and the request id.
//!   What a `Fleet` returns to be said is only ever what was *new to it*, which
//!   is also what makes a flood terminate: a thing echoed back to a wall that
//!   already holds it dies there. So everything in `Reply::say` is safe to send
//!   to every peer, and must reach at least the one that sent the message
//!   being answered.
//!
//! The third one carries real weight for asks, because an ask is the one
//! message on this wire whose effect is not idempotent by construction —
//! opening a card twice is two cards, two agents, twice the money. See
//! `Fleet::on`'s handling of `Ask` and `Held::keep_until`, which together keep
//! a redelivered frame from being a second card however late it arrives and
//! however wrong the asker's clock is.
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
//!
//! ### What was got wrong first
//!
//! The first cut passed its own tests and a red-team review then broke four of
//! its promises, each with a test that is now below. Worth knowing because each
//! one is a way a design like this goes wrong without looking wrong:
//!
//! - **The clock guard was checked only at arrival.** An asker seven minutes
//!   fast was refused, the refusal was forgotten ten minutes later, and the
//!   *same frame* redelivered then passed the check it had failed — the
//!   asker's clock had become "only" three minutes off relative to a now that
//!   had moved. Memory now lasts until the stamp check would refuse on its own
//!   (`keep_until`), and a wall whose clock the roster has measured as off by
//!   more than the slack is refused outright, whatever the frame says.
//! - **A relay forwarded asks of any age.** Hop age does not grow in transit,
//!   so a stale ask between two relays was remembered for less than the time it
//!   took to come back, and bounced for ever. Relays now pass on only what the
//!   addressee could still act on.
//! - **The request id alone was the dedup key**, so two walls each minting
//!   `r1` swallowed each other's ask. The key is the asking host and the id.
//! - **The roster version was the clock**, which goes backwards across a
//!   restart after a clock correction, and every peer then ignored the wall
//!   until its clock caught up.

use std::collections::BTreeMap;

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
/// trusts whoever relayed it and cannot see a frame the *transport* held; the
/// stamp sees that but trusts the clocks. So the ask is checked against both,
/// and this is how wrong the clocks are allowed to be — measured from the
/// roster where it can be (`Entry::skew_ms`), from the stamp where it cannot.
/// Two minutes is far beyond what NTP leaves between two machines.
pub const CLOCK_SLACK_MS: i64 = 2 * 60_000;

/// When an asker stops waiting and says nobody answered.
///
/// After this the addressee would refuse the ask as expired even with the
/// clocks at the far edge of `CLOCK_SLACK_MS`, so no answer saying "opened" can
/// still be on its way *unless* a card really was opened — which is why a late
/// answer still surfaces after this (`Fleet::on`, `Answer`).
pub const GIVE_UP_MS: i64 = ASK_TTL_MS + 2 * CLOCK_SLACK_MS;

/// How long a wall remembers an ask and its answer, at the least.
///
/// Measured from when *this wall* heard it rather than from when it was asked,
/// so a relay's memory always outlasts the time a copy takes to come back
/// round. The addressee keeps its decision longer still where the ask's stamp
/// demands it — see `Held::keep_until`.
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Announcement {
    pub host: String,
    /// Orders this host's statements and nothing else — only ever compared
    /// with the same host's earlier versions. See `Fleet::announce`.
    pub version: u64,
    /// The announcing wall's own clock when it said this. Never used to order
    /// anything; it is how a receiver measures how far the two clocks disagree
    /// (`Entry::skew_ms`), which the ask's stamp check needs to be trustworthy.
    #[serde(default)]
    pub said_at: Option<i64>,
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
    said_at: Option<i64>,
}

impl Entry {
    pub fn quiet_for(&self, now: i64) -> u64 {
        age(now, self.heard_at)
    }

    /// How far that wall's clock is ahead of this one's, or `None` if it did
    /// not say. Its clock when it spoke, less this wall's estimate of when that
    /// was — both halves read off one statement, so a relay in between adds
    /// only its own transit time, never its own clock.
    pub fn skew_ms(&self) -> Option<i64> {
        self.said_at.map(|s| s.saturating_sub(self.heard_at))
    }

    /// What a person choosing a host should be told about this one.
    ///
    /// **Quiet comes first and hides the rest**, because what a quiet wall last
    /// said is history: a machine that announced it was idle and then went to
    /// sleep is not idle, and drawing it as available would send an ask into a
    /// two-minute wait for nothing.
    pub fn standing(&self, now: i64) -> Standing {
        let quiet = self.quiet_for(now);
        if quiet > QUIET_AFTER_MS as u64 {
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

    /// The roster's merge order. A max over this is what makes the roster
    /// converge whatever order statements arrive in; the facts are the last
    /// term only so that two different statements claiming one version — which
    /// a correct wall never makes, but a namesake would — still settle the same
    /// way everywhere instead of by arrival.
    fn order(&self) -> (u64, i64, String) {
        (self.version, self.heard_at, serde_json::to_string(&self.facts).unwrap_or_default())
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
    /// Minted once per *gesture* by the asker — a uuid, never a counter, and
    /// never reused. Together with `from.host` it is the whole of what makes a
    /// repeat harmless. A retry within `ASK_TTL_MS` reuses it (`Fleet::ask`
    /// with the same id hands back the same ask), so the far side sees one
    /// request arriving twice rather than two requests.
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
    /// impossible characters on arrival, because it goes straight into a
    /// request the API would refuse otherwise.
    pub brief: String,
    pub title: Option<String>,
    /// The asker's wall clock when it asked. See `CLOCK_SLACK_MS` for why an
    /// ask carries both this and an age.
    pub asked_at: i64,
    /// Which model family the card opens on, and how hard it thinks — the
    /// same two words `spawn.rs` takes, validated against the same lists on
    /// *both* ends, since the two walls may not be the same build. `None` for
    /// whatever that machine is set up for.
    ///
    /// Carried because what a card costs is the asker's decision: it divided
    /// the job and knows which lane is small (sink `564bd55d`). Not the
    /// account, which is a fact about the machine the card runs on and is
    /// therefore that wall's ladder to choose from. `#[serde(default)]`, so a
    /// wall from before these fields reads an ask without them as "no
    /// preference" rather than failing the frame.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// The card on the addressee's wall that `brief` is for — set on a
    /// **prompt** and on nothing else. A prompt travels under its own tag
    /// (`FleetMsg::Prompt`), never under `Ask`: a wall from before prompts
    /// skips a tag it has no word for (`frame.rs`), where it would read a field
    /// it had never heard of as absent and open a card with the prompt as its
    /// brief. So the tag is what says which a request is, and an `Ask` arriving
    /// with this set has it taken off.
    #[serde(default)]
    pub card: Option<String>,
}

/// Why a wall would not open a card, in terms somebody can act on.
///
/// Every variant is one the receiving wall really makes, and each one's
/// `reason` says what to do about it, because the reader is as often an agent
/// as a person and an agent told only "refused" has no next move but to ask
/// again — which, for most of these, is exactly the wrong one.
///
/// The order `decide` checks them in is the order of what would make the rest
/// moot: first whether the ask itself can be trusted (its clock, its age), then
/// whether this wall takes anything, then the territory, then the bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Refusal {
    /// The person who owns that machine has not let other walls open cards on
    /// it. The first check about the wall itself.
    NotAccepting,
    /// It has no territory with that identity. Says what it does have, the way
    /// `spawn.rs` refuses an unmatched project with the list that would have
    /// matched — the likeliest mistake is the right repo on the wrong machine.
    NoSuchTerritory { wanted: Territory, offered: Vec<Territory> },
    AtLiveBound { live: u32, limit: u32 },
    AtHourlyBound { opened: u32, limit: u32 },
    /// The ask was older than `ASK_TTL_MS` by the time it arrived — see there.
    Expired { waited_ms: u64 },
    /// The two machines' clocks are further apart than `CLOCK_SLACK_MS`. Kept
    /// apart from `Expired` because the cure is different: no amount of
    /// asking again fixes a clock.
    ClocksDisagree { by_ms: u64, asker_ahead: bool },
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
            /* A bound of zero is a wall saying "none", and telling somebody to
               close one of the zero cards it is running is nonsense. */
            Refusal::AtLiveBound { limit: 0, .. } | Refusal::AtHourlyBound { limit: 0, .. } => format!(
                "{host} takes no cards from other walls while its bound is zero — raise its \
                 bound on {host}, or ask another wall"
            ),
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
            Refusal::ClocksDisagree { by_ms, asker_ahead } => format!(
                "the asking wall's clock is {} {} {host}'s — set both machines' clocks from the \
                 network, then ask again",
                span(*by_ms),
                if *asker_ahead { "ahead of" } else { "behind" },
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
    /// The wall that asked, so walls in between know where it is going — and,
    /// with `request`, the key it is deduplicated on.
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
    /// A prompt for a card on another wall: an `Ask` whose `card` is set and
    /// whose `brief` is the prompt. Everything an ask was red-teamed for holds
    /// for it unchanged — it is not idempotent (twice is two prompts and twice
    /// the money), so it is keyed, remembered and aged exactly as an ask is,
    /// and passed on by walls in between. Its answer is an ordinary `Answer`:
    /// `Opened { card }` means the card took it, and a refusal is a refusal —
    /// no new outcome, because a wall from before prompts relays answers too,
    /// and an outcome it had no word for would fail its whole exchange.
    Prompt { ask: Ask, age_ms: u64 },
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
    /// Must be recorded on the card and drawn. See the module comment. Its
    /// `host` is also half of what `opened` and `failed` are keyed on.
    pub asked_by: Origin,
    /// As the ask carried them. See `Ask::model`.
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// A prompt this wall has agreed to hand to one of its cards. The wiring gives
/// it to that card's own send path and then calls `Fleet::taken` or
/// `Fleet::refused` — exactly one, for `Spawn`'s reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deliver {
    pub request: String,
    pub card: String,
    pub text: String,
    pub asked_by: Origin,
}

/// Everything one message caused.
#[derive(Debug, Default)]
pub struct Reply {
    /// To be said to every peer — see the module comment on gossip.
    pub say: Vec<FleetMsg>,
    /// Cards to open here.
    pub open: Vec<Spawn>,
    /// Prompts to hand to cards here.
    pub deliver: Vec<Deliver>,
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
    /// A retry of an ask too old to be acted on. Sending it would only buy a
    /// refusal, and sending it under the old id is how a request outlives the
    /// memory that keeps it from being a second card.
    Expired { id: String },
    /// A retry of an ask that has already been answered. The answer is the
    /// thing the caller was missing, so it is handed back rather than the ask.
    AlreadyAnswered { answer: Box<Answer> },
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
            Unsendable::Expired { .. } => format!(
                "that ask is more than {} old and will not be sent again — if it is still \
                 wanted, ask afresh",
                span(ASK_TTL_MS as u64)
            ),
            Unsendable::AlreadyAnswered { answer } => match &answer.outcome {
                Outcome::Opened { card } => {
                    format!("already answered: {} opened it as card {card}", answer.by)
                }
                Outcome::Refused { refusal } => {
                    format!("already answered: {}", refusal.reason(&answer.by))
                }
            },
        };
        crate::clean::scrub(&s).into_owned()
    }
}

/// What a person or a card hands `Fleet::ask`.
#[derive(Debug, Clone)]
pub struct Request {
    /// A uuid — see `Ask::id`.
    pub id: String,
    /// The card asking, or `None` for a person.
    pub card: Option<String>,
    pub to: String,
    pub territory: Territory,
    pub brief: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// What a person or a card hands `Fleet::prompt`.
#[derive(Debug, Clone)]
pub struct PromptRequest {
    /// A uuid — see `Ask::id`.
    pub id: String,
    /// The card asking, or `None` for a person.
    pub from_card: Option<String>,
    pub to: String,
    /// The card on that wall.
    pub card: String,
    pub text: String,
}

/// An ask or answer's identity: the asking host and the request id. The id
/// alone was the first cut, and two walls each minting `r1` swallowed each
/// other's ask — the second arrived, was taken for a repeat, and nobody
/// opened anything or said so.
type Key = (String, String);

/// Something held with an estimate of when its origin made it, on this wall's
/// clock — the local half of `Heard`'s age arithmetic.
#[derive(Debug, Clone)]
struct Held<T> {
    it: T,
    origin_at: i64,
    /// When this wall may forget it.
    ///
    /// **For the addressee this is the guarantee against a second card**, so it
    /// is not simply `ANSWER_KEPT_MS` after hearing. A redelivered ask that
    /// meets no memory is decided again, and the only thing that refuses it
    /// then is the stamp check — which refuses once `now - asked_at` passes
    /// `ASK_TTL_MS + CLOCK_SLACK_MS`, on *this* wall's clock against the
    /// *asker's* stamp. So memory lasts until at least that moment, whatever
    /// the skew: an asker seven minutes fast moves the moment seven minutes
    /// later, and the memory moves with it. That case was the first cut's
    /// hole — refused at arrival, forgotten at ten minutes, and the same frame
    /// passing at ten minutes and one.
    keep_until: i64,
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
    /// Every ask this wall has heard, its own included. This and `answers` are
    /// the memory that makes a repeat a no-op.
    asks: BTreeMap<Key, Held<Ask>>,
    answers: BTreeMap<Key, Held<Answer>>,
    /// Asks this wall has agreed to and handed out as a `Spawn`, not yet
    /// reported opened or failed, with how long the answer must then be kept.
    /// Counted against the bound, which is what stops two asks in one frame
    /// both passing a bound with room for one: the facts the wiring reads
    /// cannot know about a card that has not been opened yet. Never pruned —
    /// the wiring owes every `Spawn` a report.
    in_flight: BTreeMap<Key, i64>,
    /// The same, for prompts handed to cards here — kept apart so a prompt in
    /// flight never counts against this wall's bound on *cards* opened for
    /// other walls.
    delivering: BTreeMap<Key, i64>,
    /// This wall's own asks that nobody has answered yet, by id.
    waiting: BTreeMap<String, Waiting>,
    /// Walls a person took off the roster, with the version they had then. A
    /// peer still holding the entry would otherwise gossip it straight back.
    forgotten: BTreeMap<String, u64>,
    /// Whether a statement about a wall of *this* name arrived with a version
    /// this wall never made — another machine answering to the same name.
    namesake: bool,
    last_version: u64,
}

impl Fleet {
    /// `last_version` is what `version()` returned the last time this wall
    /// ran, or zero the first time. See `announce` for why it is kept.
    pub fn new(me: &str, last_version: u64) -> Self {
        Self {
            me: me.to_string(),
            roster: BTreeMap::new(),
            asks: BTreeMap::new(),
            answers: BTreeMap::new(),
            in_flight: BTreeMap::new(),
            delivering: BTreeMap::new(),
            waiting: BTreeMap::new(),
            forgotten: BTreeMap::new(),
            namesake: false,
            last_version,
        }
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// The version of this wall's latest announcement. The wiring persists it
    /// and hands it back to `new`.
    pub fn version(&self) -> u64 {
        self.last_version
    }

    /// Another machine is in this flyway under this wall's name. Both would
    /// answer asks addressed to it — two cards for one ask — and each ignores
    /// the other's announcements as echoes of itself. Nothing here can fix
    /// that; a person renaming one machine can, so it is said.
    pub fn namesake(&self) -> bool {
        self.namesake
    }

    /// Every wall this one knows about, itself included once it has announced.
    pub fn roster(&self) -> impl Iterator<Item = &Entry> {
        self.roster.values()
    }

    pub fn entry(&self, host: &str) -> Option<&Entry> {
        self.roster.get(host)
    }

    /// An ask or prompt this wall still remembers, by its key.
    pub fn asked(&self, asked_by: &str, request: &str) -> Option<&Ask> {
        self.asks.get(&(asked_by.to_string(), request.to_string())).map(|h| &h.it)
    }

    pub fn answer(&self, asked_by: &str, request: &str) -> Option<&Answer> {
        self.answers.get(&(asked_by.to_string(), request.to_string())).map(|h| &h.it)
    }

    /// Take a wall off the roster — a machine retired, or renamed.
    ///
    /// Nothing here does this on its own. A quiet wall stays on the roster
    /// drawn as quiet, because "the build box has not been heard from for
    /// three days" is information, and an entry that silently vanished would
    /// read as a machine that was never there.
    ///
    /// It holds against gossip — a peer still carrying the old entry does not
    /// put it back — but not against the wall itself: if it announces again,
    /// it is plainly not retired, and it reappears.
    pub fn forget(&mut self, host: &str) {
        if let Some(e) = self.roster.remove(host) {
            self.forgotten.insert(host.to_string(), e.version);
        }
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
    /// The version must only ever rise for this host, or every peer ignores
    /// the wall as repeating itself. It is this wall's clock, but never less
    /// than one past the last version — *including the last version from
    /// before a restart*, which is why the wiring keeps it. The first cut used
    /// the clock alone, and a machine whose clock had been an hour fast,
    /// corrected and then restarted announced versions every peer had already
    /// passed: they kept the old entry, read the live wall as quiet within two
    /// minutes, and refused to ask it anything. The clock term is kept so a
    /// wall whose wiring loses the number still recovers by itself, if slowly.
    pub fn announce(&mut self, facts: Facts, now: i64) -> FleetMsg {
        let version = (now.max(0) as u64).max(self.last_version.saturating_add(1));
        self.last_version = version;
        let e = Entry { host: self.me.clone(), version, facts, heard_at: now, said_at: Some(now) };
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
    /// Asking again with an id already asked hands back the same ask while it
    /// could still be acted on, the answer if one came, and a refusal past
    /// that — the retry is the same request, which is the whole point of the
    /// id, and an old id is never re-minted into a fresh ask.
    pub fn ask(&mut self, r: Request, now: i64) -> Result<FleetMsg, Unsendable> {
        let key = (self.me.clone(), r.id.clone());
        if let Some(h) = self.answers.get(&key) {
            return Err(Unsendable::AlreadyAnswered { answer: Box::new(h.it.clone()) });
        }
        if let Some(h) = self.asks.get(&key) {
            if age(now, h.origin_at) > ASK_TTL_MS as u64 {
                return Err(Unsendable::Expired { id: r.id });
            }
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
        if quiet > QUIET_AFTER_MS as u64 {
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
            model: r.model,
            effort: r.effort,
            card: None,
        };
        self.asks.insert(
            key,
            Held { it: ask.clone(), origin_at: now, keep_until: now.saturating_add(ANSWER_KEPT_MS) },
        );
        self.waiting.insert(r.id, Waiting { asked_at: now, given_up: false });
        Ok(FleetMsg::Ask { ask, age_ms: 0 })
    }

    /// Send a prompt to a card on another wall, with `ask`'s rules: a retry
    /// under the same id is the same prompt, an old id is never re-minted, and
    /// a wall that is quiet is refused here rather than sent a prompt that
    /// would wait for its lid to lift — the hazard `ASK_TTL_MS` exists for.
    pub fn prompt(&mut self, r: PromptRequest, now: i64) -> Result<FleetMsg, Unsendable> {
        let key = (self.me.clone(), r.id.clone());
        if let Some(h) = self.answers.get(&key) {
            return Err(Unsendable::AlreadyAnswered { answer: Box::new(h.it.clone()) });
        }
        if let Some(h) = self.asks.get(&key) {
            if age(now, h.origin_at) > ASK_TTL_MS as u64 {
                return Err(Unsendable::Expired { id: r.id });
            }
            return Ok(FleetMsg::Prompt { ask: h.it.clone(), age_ms: age(now, h.origin_at) });
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
        if quiet > QUIET_AFTER_MS as u64 {
            return Err(Unsendable::Quiet { host: r.to, for_ms: quiet });
        }
        let ask = Ask {
            id: r.id.clone(),
            from: Origin { host: self.me.clone(), card: r.from_card },
            to: r.to,
            territory: Territory { identity: String::new(), name: String::new() },
            brief: r.text,
            title: None,
            asked_at: now,
            model: None,
            effort: None,
            card: Some(r.card),
        };
        self.asks.insert(
            key,
            Held { it: ask.clone(), origin_at: now, keep_until: now.saturating_add(ANSWER_KEPT_MS) },
        );
        self.waiting.insert(r.id, Waiting { asked_at: now, given_up: false });
        Ok(FleetMsg::Prompt { ask, age_ms: 0 })
    }

    /// The card a `Deliver` was for has the prompt.
    pub fn taken(&mut self, asked_by: &str, request: &str, card: &str, now: i64) -> Option<FleetMsg> {
        self.settle_from(true, asked_by, request, Outcome::Opened { card: card.to_string() }, now)
    }

    /// The card a `Deliver` was for could not be given it.
    pub fn refused(&mut self, asked_by: &str, request: &str, reason: &str, now: i64) -> Option<FleetMsg> {
        let refusal = Refusal::CouldNotStart { reason: reason.to_string() };
        self.settle_from(true, asked_by, request, Outcome::Refused { refusal }, now)
    }

    /// The card a `Spawn` asked for is open. Returns the answer to say, or
    /// nothing if this request was not in flight — reporting twice is a no-op,
    /// for the same reason everything else here is.
    pub fn opened(&mut self, asked_by: &str, request: &str, card: &str, now: i64) -> Option<FleetMsg> {
        self.settle(asked_by, request, Outcome::Opened { card: card.to_string() }, now)
    }

    /// The card a `Spawn` asked for could not be opened.
    pub fn failed(&mut self, asked_by: &str, request: &str, reason: &str, now: i64) -> Option<FleetMsg> {
        let refusal = Refusal::CouldNotStart { reason: reason.to_string() };
        self.settle(asked_by, request, Outcome::Refused { refusal }, now)
    }

    /// Everything needed is in the key and `in_flight`, deliberately — the
    /// first cut read the asker off `asks`, which a spawn slower than the
    /// memory had already pruned, and the card opened with no answer ever
    /// sent and a later redelivery told it had expired.
    fn settle(&mut self, asked_by: &str, request: &str, outcome: Outcome, now: i64) -> Option<FleetMsg> {
        self.settle_from(false, asked_by, request, outcome, now)
    }

    fn settle_from(&mut self, prompt: bool, asked_by: &str, request: &str, outcome: Outcome, now: i64) -> Option<FleetMsg> {
        let key = (asked_by.to_string(), request.to_string());
        let keep_until = if prompt { self.delivering.remove(&key)? } else { self.in_flight.remove(&key)? };
        let answer = Answer { request: key.1.clone(), by: self.me.clone(), asked_by: key.0.clone(), outcome };
        Some(self.record(key, answer, now, keep_until.max(now.saturating_add(ANSWER_KEPT_MS))))
    }

    fn record(&mut self, key: Key, answer: Answer, now: i64, keep_until: i64) -> FleetMsg {
        self.answers.insert(key, Held { it: answer.clone(), origin_at: now, keep_until });
        FleetMsg::Answer { answer, age_ms: 0 }
    }

    /// Forget what is too old to matter, and say which of this wall's own asks
    /// it has given up waiting for. Call on the wiring's tick.
    ///
    /// The given-up list is returned rather than dropped because an ask
    /// nobody answered is still an outcome somebody is waiting to hear — the
    /// card that asked would otherwise wait for ever.
    pub fn prune(&mut self, now: i64) -> Vec<String> {
        self.asks.retain(|_, h| now <= h.keep_until);
        self.answers.retain(|_, h| now <= h.keep_until);
        let mut gave_up = Vec::new();
        for (id, w) in self.waiting.iter_mut() {
            if !w.given_up && age(now, w.asked_at) > GIVE_UP_MS as u64 {
                w.given_up = true;
                gave_up.push(id.clone());
            }
        }
        self.waiting.retain(|_, w| age(now, w.asked_at) <= ANSWER_KEPT_MS as u64);
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
                    let v = theirs.entry(sc(&h.wall.host)).or_insert(0);
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
                /* Never a prompt under this tag — see `Ask::card`. */
                let ask = Ask { card: None, ..clean_ask(ask) };
                self.hear_ask(ask, age_ms, now, here, &mut reply);
            }

            FleetMsg::Prompt { ask, age_ms } => {
                let ask = clean_ask(ask);
                /* A prompt for no card is nothing anybody could deliver, and
                   it is dropped rather than refused: there is no card on any
                   wall it could have been meant for. */
                if ask.card.as_deref().is_none_or(str::is_empty) {
                    return reply;
                }
                self.hear_ask(ask, age_ms, now, here, &mut reply);
            }

            FleetMsg::Answer { answer, age_ms } => {
                let answer = clean_answer(answer);
                let key = (answer.asked_by.clone(), answer.request.clone());
                if self.answers.contains_key(&key) {
                    return reply;
                }
                let origin_at = now.saturating_sub(clamp(age_ms));
                if answer.asked_by == self.me {
                    self.answers.insert(
                        key,
                        Held { it: answer.clone(), origin_at, keep_until: now.saturating_add(ANSWER_KEPT_MS) },
                    );
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
                    /* An answer older than anybody's memory of its ask is
                       nobody's to receive; carrying it on would only be the
                       ask's bounce again, one message later. */
                    if age(now, origin_at) > ANSWER_KEPT_MS as u64 {
                        return reply;
                    }
                    self.answers.insert(
                        key,
                        Held { it: answer.clone(), origin_at, keep_until: now.saturating_add(ANSWER_KEPT_MS) },
                    );
                    reply.say.push(FleetMsg::Answer { answer, age_ms: age(now, origin_at) });
                }
            }
        }
        reply
    }

    /// An ask or a prompt arriving — one path for both, so the rules that
    /// keep a repeat from being a second card keep it from being a second
    /// prompt too. `ask.card` says which (`Ask::card`).
    fn hear_ask(&mut self, ask: Ask, age_ms: u64, now: i64, here: &Facts, reply: &mut Reply) {
        let prompt = ask.card.is_some();
        let key = (ask.from.host.clone(), ask.id.clone());
        /* **The repeat.** An ask this wall has seen is never decided
           twice — that is the second card. If this wall is the one it
           was for and has answered, the repeat is most likely the asker
           retrying because the answer was lost, so the answer is said
           again; the asker's own dedup makes that free if it was not. */
        if self.asks.contains_key(&key)
            || self.answers.contains_key(&key)
            || self.in_flight.contains_key(&key)
            || self.delivering.contains_key(&key)
        {
            if ask.to == self.me {
                if let Some(h) = self.answers.get(&key) {
                    reply.say.push(FleetMsg::Answer { answer: h.it.clone(), age_ms: age(now, h.origin_at) });
                }
            }
            return;
        }
        let origin_at = now.saturating_sub(clamp(age_ms));

        if ask.to != self.me {
            /* Passed on only while the addressee could still act on it,
               by either measure. Without this a stale ask bounced
               between two relays for ever: hop age does not grow in
               transit, so each remembered it for less than the time it
               took to come back. Dropped rather than remembered — a
               repeat is dropped again, and says nothing either way. */
            if age(now, origin_at) > ASK_TTL_MS as u64 || stamp_age(now, ask.asked_at) > ASK_TTL_MS + CLOCK_SLACK_MS {
                return;
            }
            self.asks.insert(
                key,
                Held { it: ask.clone(), origin_at, keep_until: now.saturating_add(ANSWER_KEPT_MS) },
            );
            reply.say.push(tagged(ask, age(now, origin_at)));
            return;
        }

        let keep_until = now
            .saturating_add(ANSWER_KEPT_MS)
            .max(ask.asked_at.saturating_add(ASK_TTL_MS + CLOCK_SLACK_MS + 1));
        self.asks.insert(key.clone(), Held { it: ask.clone(), origin_at, keep_until });
        let decided = if prompt {
            /* A prompt has no territory and counts against no bound; what it
               shares with an ask is the trust and the switch. Whether the card
               exists, and will take it, is the wiring's to answer. */
            self.trust(&ask, age_ms, now)
                .and_then(|()| if here.accepting { Ok(()) } else { Err(Refusal::NotAccepting) })
                .map(|()| {
                    self.delivering.insert(key.clone(), keep_until);
                    reply.deliver.push(Deliver {
                        request: ask.id.clone(),
                        card: ask.card.clone().unwrap_or_default(),
                        text: ask.brief.clone(),
                        asked_by: ask.from.clone(),
                    });
                })
        } else {
            self.decide(&ask, age_ms, now, here).map(|spawn| {
                self.in_flight.insert(key.clone(), keep_until);
                reply.open.push(spawn);
            })
        };
        if let Err(refusal) = decided {
            let answer = Answer {
                request: key.1.clone(),
                by: self.me.clone(),
                asked_by: key.0.clone(),
                outcome: Outcome::Refused { refusal },
            };
            reply.say.push(self.record(key, answer, now, keep_until));
        }
    }

    /// Whether the ask itself can be trusted — its clock and its age — before
    /// anything about this wall is asked. The first half of `decide`, shared
    /// with prompts.
    fn trust(&self, ask: &Ask, hop_age: u64, now: i64) -> Result<(), Refusal> {
        /* The skew the roster has *measured*, when it has. This is what makes
           the stamp check below honest: the stamp can only catch a frame the
           transport held if the clocks agree to within the slack, and nothing
           else enforces that. An asker half an hour fast whose frame was held
           twenty-nine minutes has a stamp that looks a minute old. */
        if let Some(skew) = self.roster.get(&ask.from.host).and_then(Entry::skew_ms) {
            if skew.unsigned_abs() > CLOCK_SLACK_MS as u64 {
                return Err(Refusal::ClocksDisagree { by_ms: skew.unsigned_abs(), asker_ahead: skew > 0 });
            }
        }
        let by_clock = now.saturating_sub(ask.asked_at);
        if by_clock < -CLOCK_SLACK_MS {
            return Err(Refusal::ClocksDisagree { by_ms: by_clock.unsigned_abs(), asker_ahead: true });
        }
        /* Both measures, because each covers the other's blind spot: the hop
           age catches an ask held by a wall that relayed it, whatever the
           clocks say; the stamp catches a frame the *transport* held and
           redelivered with the age it left with, which no wall ever saw. */
        if hop_age > ASK_TTL_MS as u64 || by_clock > ASK_TTL_MS + CLOCK_SLACK_MS {
            return Err(Refusal::Expired { waited_ms: hop_age.max(by_clock.max(0) as u64) });
        }
        Ok(())
    }

    /// Whether to open a card for this ask, against this wall's facts now.
    ///
    /// The ask's own trustworthiness first — its clock and its age — then
    /// whether this wall takes anything, then the territory, then the bounds,
    /// so the refusal names the thing that would have to change first rather
    /// than the third of three.
    fn decide(&self, ask: &Ask, hop_age: u64, now: i64, here: &Facts) -> Result<Spawn, Refusal> {
        self.trust(ask, hop_age, now)?;
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
            brief: ask.brief.clone(),
            title: ask.title.clone(),
            asked_by: ask.from.clone(),
            model: ask.model.clone(),
            effort: ask.effort.clone(),
        })
    }

    /// Fold one statement in. Returns the entry if it was news — a version of
    /// that host this wall had not heard — which is what gets passed on.
    ///
    /// The kept entry is the greatest by `Entry::order`, a max over a total
    /// order and so independent of arrival order — the property
    /// `a_roster_converges_however_announcements_interleave` holds. A same-
    /// version copy that arrived by a quicker path improves the estimate of
    /// when it was said but is not news: passing it on would be every relay
    /// re-announcing every wall once per path.
    ///
    /// Statements about this wall itself are ignored. It knows what it is
    /// better than any relay does, and an old copy of its own announcement
    /// coming back round must never overwrite the current one. One with a
    /// version it never made is not an echo, though — see `namesake`.
    fn learn(&mut self, h: Heard, now: i64) -> Option<Entry> {
        let host = sc(&h.wall.host);
        if host == self.me {
            if h.wall.version > self.last_version {
                self.namesake = true;
            }
            return None;
        }
        if let Some(v) = self.forgotten.get(&host) {
            if h.wall.version <= *v {
                return None;
            }
            self.forgotten.remove(&host);
        }
        let heard_at = now.saturating_sub(clamp(h.age_ms));
        let incoming = Entry {
            host: host.clone(),
            version: h.wall.version,
            facts: clean_facts(h.wall.facts),
            heard_at,
            said_at: h.wall.said_at,
        };
        match self.roster.get(&host) {
            Some(e) if e.order() >= incoming.order() => None,
            Some(e) if e.version == incoming.version => {
                self.roster.insert(host, incoming);
                None
            }
            _ => {
                self.roster.insert(host, incoming.clone());
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
            .iter()
            .filter(|(_, h)| h.it.to != self.me)
            .filter(|(k, _)| !self.answers.contains_key(*k))
            .filter(|(_, h)| age(now, h.origin_at) <= ASK_TTL_MS as u64)
            .filter(|(_, h)| stamp_age(now, h.it.asked_at) <= ASK_TTL_MS + CLOCK_SLACK_MS)
            .map(|(_, h)| tagged(h.it.clone(), age(now, h.origin_at)));
        let answers = self
            .answers
            .values()
            .filter(|h| age(now, h.origin_at) <= ANSWER_KEPT_MS as u64)
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

/// An ask under the tag that says what it is — see `Ask::card`.
fn tagged(ask: Ask, age_ms: u64) -> FleetMsg {
    if ask.card.is_some() {
        FleetMsg::Prompt { ask, age_ms }
    } else {
        FleetMsg::Ask { ask, age_ms }
    }
}

fn heard(e: &Entry, now: i64) -> Heard {
    Heard {
        wall: Announcement { host: e.host.clone(), version: e.version, said_at: e.said_at, facts: e.facts.clone() },
        age_ms: age(now, e.heard_at),
    }
}

/* ── at the boundary ─────────────────────────────────────────────────────────
   Every string that arrives from another wall and can reach an agent — a host,
   a card id, a territory name, a brief — is scrubbed here, once, on the way in
   (CLAUDE.md: a text an agent will read may not carry a character it cannot
   send). On the way *in* rather than at each reader, because the readers are
   the wiring's and do not exist yet; and because `crate::clean::scrub` is
   idempotent, a wall relaying something it scrubbed hands on exactly what the
   next wall would have made of it, so keys built from these strings agree. */

fn sc(s: &str) -> String {
    crate::clean::scrub(s).into_owned()
}

fn sc_opt(s: Option<String>) -> Option<String> {
    s.map(|s| sc(&s))
}

fn clean_territory(t: Territory) -> Territory {
    Territory { identity: sc(&t.identity), name: sc(&t.name) }
}

fn clean_facts(mut f: Facts) -> Facts {
    f.territories = f.territories.into_iter().map(clean_territory).collect();
    f
}

fn clean_ask(a: Ask) -> Ask {
    Ask {
        id: sc(&a.id),
        from: Origin { host: sc(&a.from.host), card: sc_opt(a.from.card) },
        to: sc(&a.to),
        territory: clean_territory(a.territory),
        brief: sc(&a.brief),
        title: sc_opt(a.title),
        asked_at: a.asked_at,
        model: sc_opt(a.model),
        effort: sc_opt(a.effort),
        card: sc_opt(a.card),
    }
}

fn clean_answer(a: Answer) -> Answer {
    let outcome = match a.outcome {
        Outcome::Opened { card } => Outcome::Opened { card: sc(&card) },
        Outcome::Refused { refusal: Refusal::CouldNotStart { reason } } => {
            Outcome::Refused { refusal: Refusal::CouldNotStart { reason: sc(&reason) } }
        }
        Outcome::Refused { refusal: Refusal::NoSuchTerritory { wanted, offered } } => Outcome::Refused {
            refusal: Refusal::NoSuchTerritory {
                wanted: clean_territory(wanted),
                offered: offered.into_iter().map(clean_territory).collect(),
            },
        },
        other => other,
    };
    Answer { request: sc(&a.request), by: sc(&a.by), asked_by: sc(&a.asked_by), outcome }
}

/// How long ago, never negative. A wall whose estimate of when something was
/// said lands in its own future — a relay with a confused clock — reads it as
/// just now rather than as a negative age wrapping to the far end of a `u64`.
fn age(now: i64, at: i64) -> u64 {
    now.saturating_sub(at).max(0) as u64
}

/// How old an ask's stamp says it is, on this wall's clock. Signed, because a
/// stamp from the future is a clock question rather than an age.
fn stamp_age(now: i64, asked_at: i64) -> i64 {
    now.saturating_sub(asked_at)
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
    use std::collections::BTreeSet;

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
            Self { f: Fleet::new(host, 0), here, spawns: Vec::new(), answered: Vec::new() }
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
            model: None,
            effort: None,
        }
    }

    fn raw_ask(id: &str, from: &str, to: &str, asked_at: i64) -> Ask {
        Ask {
            id: id.into(),
            from: Origin { host: from.into(), card: None },
            to: to.into(),
            territory: skein(),
            brief: "b".into(),
            title: None,
            asked_at,
            model: None,
            effort: None,
            card: None,
        }
    }

    fn statement(host: &str, version: u64, facts: Facts, said_at: Option<i64>, age_ms: u64) -> FleetMsg {
        FleetMsg::Roster {
            walls: vec![Heard { wall: Announcement { host: host.into(), version, said_at, facts }, age_ms }],
            greeting: false,
        }
    }

    fn announced(host: &str, version: u64, working: u32, age_ms: u64) -> FleetMsg {
        statement(host, version, Facts { cards_working: working, ..open_facts() }, None, age_ms)
    }

    fn refusal_in(said: &[FleetMsg]) -> Option<&Refusal> {
        match said {
            [FleetMsg::Answer { answer: Answer { outcome: Outcome::Refused { refusal }, .. }, .. }] => Some(refusal),
            _ => None,
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
                    wall: Announcement { host: "lap".into(), version: 2, said_at: None, facts: Facts { cards_working: 2, ..open_facts() } },
                    age_ms: 4_000,
                },
                Heard {
                    wall: Announcement { host: "server".into(), version: 1, said_at: None, facts: Facts { cards_working: 0, ..open_facts() } },
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
            /* A namesake's collision: two different statements claiming one
               version. A correct wall never makes this, but the roster must
               still settle it the same way everywhere. */
            announced("server", 4, 8, 500),
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
        /* And the same arithmetic measures the clocks: the desk said 0 when
           the laptop's clock read an hour. */
        assert_eq!(e.skew_ms(), Some(-hour));
    }

    /// **Quiet is not busy.** A wall that said it was full and a wall that has
    /// stopped talking want different things from a person, so they must read
    /// differently — and a wall that went quiet after saying it was idle must
    /// not read as idle.
    #[test]
    fn a_stale_entry_is_not_a_busy_one() {
        let mut me = Node::new("me", open_facts());
        let full = Facts { bound: Bound { live: Some(2), per_hour: None }, remote_live: 2, ..open_facts() };
        me.hear(statement("busy", 1, full, None, 0), 0);
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
    /// announcement coming back round must not replace the current one — and
    /// is not mistaken for a namesake.
    #[test]
    fn a_wall_is_never_told_what_it_is_by_an_echo() {
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(Facts { cards_working: 9, ..open_facts() }, 5_000);
        desk.hear(announced("desk", 1, 0, 0), 6_000);
        assert_eq!(desk.f.entry("desk").unwrap().facts.cards_working, 9);
        assert!(!desk.f.namesake());
    }

    /// Two machines answering to one name would both open a card for one ask,
    /// and each would take the other's announcements for echoes. The only
    /// sign is a statement about "me" with a version this wall never made.
    #[test]
    fn a_second_machine_with_this_name_is_noticed() {
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(open_facts(), 5_000);
        desk.hear(announced("desk", 9_000, 0, 0), 6_000);
        assert!(desk.f.namesake());
    }

    /// The version only rises for a host — across a clock stepping back while
    /// running, and across a restart after one, which is the case that froze a
    /// wall on every roster when the version was the clock alone.
    #[test]
    fn a_clock_stepping_back_does_not_freeze_a_wall_on_the_roster() {
        let mut desk = Fleet::new("desk", 0);
        desk.announce(open_facts(), 10_000);
        let FleetMsg::Roster { walls, .. } = desk.announce(open_facts(), 4_000) else { unreachable!() };
        assert!(walls[0].wall.version > 10_000);

        /* The clock was an hour fast; it is corrected and the app restarts,
           with the version the wiring kept. */
        let hour = 3_600_000;
        let mut lap = Node::new("lap", open_facts());
        let mut before = Fleet::new("desk", 0);
        lap.hear(before.announce(open_facts(), 2 * hour), 0);
        let kept = before.version();

        let mut after = Fleet::new("desk", kept);
        let closed = Facts { accepting: false, ..open_facts() };
        lap.hear(after.announce(closed, hour), 1_000);
        assert!(!lap.f.entry("desk").unwrap().facts.accepting, "the restarted wall's word was taken");
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

    /// A forgotten wall stays forgotten when a peer gossips the old entry back,
    /// and comes back if it speaks for itself again — it is plainly not retired.
    #[test]
    fn forgetting_a_wall_holds_against_gossip_but_not_against_the_wall() {
        let mut me = Node::new("me", open_facts());
        me.hear(announced("old", 5, 0, 0), 0);
        me.f.forget("old");
        me.hear(announced("old", 5, 0, 0), 1_000);
        assert!(me.f.entry("old").is_none(), "a peer's stale copy does not undo it");
        me.hear(announced("old", 6, 0, 0), 2_000);
        assert!(me.f.entry("old").is_some());
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

        let answer = desk.f.opened("lap", "r1", "card-on-desk", 2_000).unwrap();
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

        desk.f.opened("lap", "r1", "card-on-desk", 2_000).unwrap();
        assert!(desk.f.opened("lap", "r1", "card-on-desk", 2_001).is_none(), "reporting twice is a no-op");

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

    /// Two walls each minting the same id ask the same wall. They are two
    /// asks — the first cut keyed on the id alone and the second was taken for
    /// a repeat, opening nothing and saying nothing.
    #[test]
    fn two_walls_using_the_same_id_are_two_asks() {
        let mut desk = Node::new("desk", open_facts());
        desk.hear(FleetMsg::Ask { ask: raw_ask("r1", "lap", "desk", 0), age_ms: 0 }, 0);
        desk.hear(FleetMsg::Ask { ask: raw_ask("r1", "server", "desk", 0), age_ms: 0 }, 0);
        assert_eq!(desk.spawns.len(), 2);
        assert!(desk.f.opened("server", "r1", "c-server", 10).is_some());
        assert!(desk.f.opened("lap", "r1", "c-lap", 10).is_some());

        /* And on the asking side, a stranger's answer under the same id does
           not swallow this wall's own. */
        let mut lap = Node::new("lap", open_facts());
        lap.hear(announced("desk", 1, 0, 0), 0);
        lap.f.ask(request("r1", "desk", skein()), 0).unwrap();
        let theirs = Answer { request: "r1".into(), by: "desk".into(), asked_by: "server".into(), outcome: Outcome::Opened { card: "c-server".into() } };
        let mine = Answer { request: "r1".into(), by: "desk".into(), asked_by: "lap".into(), outcome: Outcome::Opened { card: "c-lap".into() } };
        lap.hear(FleetMsg::Answer { answer: theirs, age_ms: 0 }, 10);
        lap.hear(FleetMsg::Answer { answer: mine, age_ms: 0 }, 10);
        assert_eq!(lap.answered.len(), 1);
        assert_eq!(lap.answered[0].outcome, Outcome::Opened { card: "c-lap".into() });
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
        assert_eq!(refusal_in(&said), Some(&Refusal::AtLiveBound { live: 1, limit: 1 }), "{said:?}");
    }

    /// The constants the guarantees lean on. The no-second-card guarantee no
    /// longer rests on these — `keep_until` is computed from each ask's own
    /// stamp — but a relay's memory must still outlast the window in which it
    /// forwards, or the bounce comes back.
    #[test]
    fn the_timing_constants_keep_their_order() {
        assert!(ANSWER_KEPT_MS > ASK_TTL_MS + CLOCK_SLACK_MS);
        assert!(GIVE_UP_MS < ANSWER_KEPT_MS, "a late answer must still find its waiting entry");
        assert!(QUIET_AFTER_MS > ANNOUNCE_EVERY_MS);
    }

    /// The transport redelivers an ask long after the memory of it is gone,
    /// carrying the age it left with. The stamp catches it.
    #[test]
    fn a_redelivery_after_the_memory_is_gone_is_refused_not_opened() {
        let mut lap = Node::new("lap", open_facts());
        let mut desk = Node::new("desk", open_facts());
        desk.f.announce(desk.here.clone(), 0);
        converse(&mut lap, &mut desk, 0);

        let ask = lap.f.ask(request("r1", "desk", skein()), 1_000).unwrap();
        desk.hear(ask.clone(), 1_000);
        desk.f.opened("lap", "r1", "c", 1_500);

        /* Past the memory of the *answer*, which was made at 1_500. */
        let much_later = 1_500 + ANSWER_KEPT_MS + 1;
        desk.f.prune(much_later);
        let said = desk.hear(ask, much_later);
        assert_eq!(desk.spawns.len(), 1);
        assert!(matches!(refusal_in(&said), Some(Refusal::Expired { .. })), "{said:?}");
    }

    /// **The review's first hole.** An asker seven minutes fast is refused at
    /// arrival. The first cut forgot that at ten minutes, and the same frame
    /// redelivered at ten minutes and one passed — its stamp was by then only
    /// three minutes in the future of a clock that had moved on. Memory now
    /// lasts until the stamp check refuses on its own, and the frame never
    /// opens a card at any moment.
    #[test]
    fn a_fast_clock_cannot_wait_out_the_memory_of_its_refusal() {
        let mut desk = Node::new("desk", open_facts());
        let ask = FleetMsg::Ask { ask: raw_ask("r1", "lap", "desk", 7 * 60_000), age_ms: 0 };
        let said = desk.hear(ask.clone(), 0);
        assert!(matches!(refusal_in(&said), Some(Refusal::ClocksDisagree { asker_ahead: true, .. })));

        for minute in 1..=20 {
            let now = minute * 60_000 + 1;
            desk.f.prune(now);
            desk.hear(ask.clone(), now);
        }
        assert!(desk.spawns.is_empty(), "a redelivery at any minute opened a card");
    }

    /// And the case the stamp alone cannot see: an asker half an hour fast
    /// whose frame the transport held twenty-nine minutes, so the stamp looks
    /// a minute old. The roster has measured that clock, and that is what
    /// refuses it.
    #[test]
    fn a_clock_the_roster_has_measured_as_wrong_is_refused_whatever_the_stamp_says() {
        let mut desk = Node::new("desk", open_facts());
        let half_hour = 30 * 60_000;
        desk.hear(statement("lap", 1, open_facts(), Some(half_hour), 0), 0);

        let held = FleetMsg::Ask { ask: raw_ask("r1", "lap", "desk", half_hour - 29 * 60_000), age_ms: 0 };
        let said = desk.hear(held, 0);
        assert!(desk.spawns.is_empty());
        assert_eq!(
            refusal_in(&said),
            Some(&Refusal::ClocksDisagree { by_ms: half_hour as u64, asker_ahead: true }),
            "{said:?}"
        );
        assert!(refusal_in(&said).unwrap().reason("desk").contains("ahead of desk"));
    }

    /// **The review's second hole**: an over-aged ask between two relays was
    /// remembered for less than the time it took to come back, and bounced for
    /// ever. Relays now carry only what the addressee could still act on, so
    /// even with every relay's memory gone between hops, it dies.
    #[test]
    fn a_stale_ask_between_two_relays_dies_rather_than_bouncing() {
        let mut a = Node::new("a", open_facts());
        let mut b = Node::new("b", open_facts());
        /* Too old by its hop age to be passed on at all. */
        let old = FleetMsg::Ask { ask: raw_ask("r1", "lap", "offline", 0), age_ms: (ANSWER_KEPT_MS - 100) as u64 };
        assert!(a.hear(old, 0).is_empty());

        /* Young by its hop age, and the transport takes eleven minutes a hop —
           longer than either relay remembers anything. */
        let mut msgs = vec![FleetMsg::Ask { ask: raw_ask("r2", "lap", "offline", 0), age_ms: 0 }];
        let mut now = 0;
        for hop in 0.. {
            if msgs.is_empty() {
                break;
            }
            assert!(hop < 10, "still bouncing after {hop} hops");
            let to = if hop % 2 == 0 { &mut a } else { &mut b };
            to.f.prune(now);
            msgs = to.hear_all(msgs, now);
            now += 11 * 60_000;
        }
    }

    /// A spawn slower than the ask's memory still gets its answer sent. The
    /// first cut read the asker back off the pruned ask and sent nothing.
    #[test]
    fn a_slow_spawn_still_answers() {
        let mut desk = Node::new("desk", open_facts());
        desk.hear(FleetMsg::Ask { ask: raw_ask("r1", "lap", "desk", 0), age_ms: 0 }, 0);
        let slow = ANSWER_KEPT_MS + 60_000;
        desk.f.prune(slow);
        assert!(desk.f.opened("lap", "r1", "c", slow).is_some());
    }

    /// Retrying an id is the same request only while it could still be acted
    /// on. Past that, and once it has been answered, `ask` says so rather than
    /// re-sending — the first cut re-minted an old id into a fresh ask once
    /// the memory had gone, which is a second card for "the same request".
    #[test]
    fn retrying_an_old_or_answered_id_does_not_send_it_again() {
        let mut lap = Node::new("lap", open_facts());
        lap.hear(announced("desk", 1, 0, 0), 0);
        lap.f.ask(request("r1", "desk", skein()), 0).unwrap();
        assert!(matches!(lap.f.ask(request("r1", "desk", skein()), ASK_TTL_MS + 1), Err(Unsendable::Expired { .. })));

        lap.f.ask(request("r2", "desk", skein()), 0).unwrap();
        let answer = Answer { request: "r2".into(), by: "desk".into(), asked_by: "lap".into(), outcome: Outcome::Opened { card: "c".into() } };
        lap.hear(FleetMsg::Answer { answer, age_ms: 0 }, 10);
        match lap.f.ask(request("r2", "desk", skein()), 20) {
            Err(e @ Unsendable::AlreadyAnswered { .. }) => assert!(e.reason().contains("opened it as card c")),
            other => panic!("{other:?}"),
        }
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

        let answer = desk.f.opened("lap", "r1", "card-on-desk", 2_000).unwrap();
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
        let held = server.f.asks.get(&("lap".to_string(), "r1".to_string())).unwrap().it.clone();
        desk.hear(FleetMsg::Ask { ask: held, age_ms: (morning - 1_000) as u64 }, morning);
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
        let ask_with = |id: &str, territory: Territory, asked_at: i64| Ask { territory, ..raw_ask(id, "lap", "desk", asked_at) };
        let refused = |here: Facts, ask: Ask, age_ms: u64| -> Refusal {
            let mut desk = Fleet::new("desk", 0);
            let r = desk.on(FleetMsg::Ask { ask, age_ms }, now, &here);
            assert!(r.open.is_empty());
            refusal_in(&r.say).unwrap_or_else(|| panic!("expected one refusal, got {:?}", r.say)).clone()
        };

        let mut got = vec![
            refused(Facts { accepting: false, ..open_facts() }, ask_with("a", skein(), now), 0),
            refused(open_facts(), ask_with("b", t("tid-nova", "nova"), now), 0),
            refused(Facts { bound: Bound { live: Some(3), per_hour: None }, remote_live: 3, ..open_facts() }, ask_with("c", skein(), now), 0),
            refused(Facts { bound: Bound { live: None, per_hour: Some(6) }, remote_last_hour: 6, ..open_facts() }, ask_with("d", skein(), now), 0),
            refused(open_facts(), ask_with("e", skein(), now), (ASK_TTL_MS + 1) as u64),
            refused(open_facts(), ask_with("f", skein(), now + CLOCK_SLACK_MS + 60_000), 0),
        ];
        let mut desk = Fleet::new("desk", 0);
        let r = desk.on(FleetMsg::Ask { ask: ask_with("g", skein(), now), age_ms: 0 }, now, &open_facts());
        assert_eq!(r.open.len(), 1);
        match desk.failed("lap", "g", "the account is out of allowance until 14:00", now) {
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

    /// A bound of zero is "none", and the reason must not tell anybody to
    /// close one of the zero cards.
    #[test]
    fn a_bound_of_zero_reads_as_none_rather_than_as_full() {
        let r = Refusal::AtLiveBound { live: 0, limit: 0 }.reason("desk");
        assert!(!r.contains("close one"), "{r}");
        assert!(r.contains("raise its bound"), "{r}");
    }

    /// Among the checks about the wall itself, a wall that takes nothing says
    /// so first, rather than that it lacks the territory too.
    #[test]
    fn a_closed_wall_says_it_is_closed_before_it_says_anything_about_the_territory() {
        let mut desk = Fleet::new("desk", 0);
        let here = Facts { accepting: false, territories: vec![], ..Default::default() };
        let ask = Ask { territory: t("tid-nova", "nova"), ..raw_ask("r", "lap", "desk", 0) };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &here);
        assert_eq!(refusal_in(&r.say), Some(&Refusal::NotAccepting));
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

    /// Every string from another wall that can reach an agent is scrubbed on
    /// the way in. The brief most of all: it goes straight into a card's first
    /// request, and a control character in it would have the API refuse that
    /// request — the card would be born unable to speak.
    #[test]
    fn nothing_from_another_wall_reaches_an_agent_with_characters_it_could_not_send() {
        let mut desk = Fleet::new("desk", 0);
        let ask = Ask {
            from: Origin { host: "lap".into(), card: Some("c\u{0}1".into()) },
            brief: "build\u{0}the\u{7}thing\nplease".into(),
            title: Some("t\u{1b}itle".into()),
            ..raw_ask("r", "lap", "desk", 0)
        };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &open_facts());
        assert_eq!(r.open[0].brief, "buildthething\nplease");
        assert_eq!(r.open[0].title.as_deref(), Some("title"));
        assert_eq!(r.open[0].asked_by.card.as_deref(), Some("c1"));

        let mut lap = Node::new("lap", open_facts());
        lap.hear(announced("desk", 1, 0, 0), 0);
        lap.f.ask(request("r1", "desk", skein()), 0).unwrap();
        let answer = Answer { request: "r1".into(), by: "de\u{7}sk".into(), asked_by: "lap".into(), outcome: Outcome::Opened { card: "ca\u{0}rd".into() } };
        lap.hear(FleetMsg::Answer { answer, age_ms: 0 }, 10);
        assert_eq!(lap.answered[0].by, "desk");
        assert_eq!(lap.answered[0].outcome, Outcome::Opened { card: "card".into() });
    }

    fn prompt_req(id: &str, to: &str, card: &str) -> PromptRequest {
        PromptRequest { id: id.into(), from_card: None, to: to.into(), card: card.into(), text: "carry on".into() }
    }

    /// A prompt crosses, is handed to the card, and its answer comes back as
    /// taken — and the repeat a lost answer provokes is not a second prompt.
    #[test]
    fn a_prompt_is_delivered_once_and_answered_as_taken() {
        let mut lap = Fleet::new("lap", 0);
        let mut desk = Fleet::new("desk", 0);
        lap.on(announced("desk", 1, 0, 0), 0, &open_facts());
        let m = lap.prompt(prompt_req("p1", "desk", "card-9"), 10).unwrap();
        assert!(matches!(m, FleetMsg::Prompt { .. }));

        let r = desk.on(m.clone(), 10, &open_facts());
        assert_eq!(r.deliver.len(), 1);
        assert_eq!(r.deliver[0].card, "card-9");
        assert_eq!(r.deliver[0].text, "carry on");
        assert!(r.open.is_empty(), "a prompt never opens a card");

        let again = desk.on(m.clone(), 20, &open_facts());
        assert!(again.deliver.is_empty(), "the same prompt twice is one prompt");

        let answer = desk.taken("lap", "p1", "card-9", 30).unwrap();
        let back = lap.on(answer, 40, &open_facts());
        assert_eq!(back.answered.len(), 1);
        assert_eq!(back.answered[0].outcome, Outcome::Opened { card: "card-9".into() });

        /* And a repeat after the answer says the answer again, not the prompt. */
        let late = desk.on(m, 50, &open_facts());
        assert!(late.deliver.is_empty());
        assert!(matches!(late.say.as_slice(), [FleetMsg::Answer { .. }]));
    }

    /// The tag is what says a request is a prompt. An `Ask` carrying a card is
    /// an ask — which is the reading a wall from before prompts would make of
    /// it anyway, and the reason prompts never travel under that tag.
    #[test]
    fn an_ask_carrying_a_card_is_still_an_ask() {
        let mut desk = Fleet::new("desk", 0);
        let ask = Ask { card: Some("card-9".into()), ..raw_ask("r", "lap", "desk", 0) };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &open_facts());
        assert_eq!(r.open.len(), 1);
        assert!(r.deliver.is_empty());
        /* And it is remembered without the card, so it gossips as an ask. */
        assert!(desk.asked("lap", "r").unwrap().card.is_none());
    }

    #[test]
    fn a_wall_that_takes_no_work_refuses_a_prompt_too() {
        let mut desk = Fleet::new("desk", 0);
        let ask = Ask { card: Some("card-9".into()), ..raw_ask("p", "lap", "desk", 0) };
        let closed = Facts { accepting: false, ..open_facts() };
        let r = desk.on(FleetMsg::Prompt { ask, age_ms: 0 }, 0, &closed);
        assert!(r.deliver.is_empty());
        assert_eq!(refusal_in(&r.say), Some(&Refusal::NotAccepting));
    }

    /// A prompt in flight is not a card opened for another wall, and must not
    /// fill the bound that counts those.
    #[test]
    fn a_prompt_in_flight_does_not_count_against_the_card_bound() {
        let mut desk = Fleet::new("desk", 0);
        let bounded = Facts { bound: Bound { live: Some(1), per_hour: None }, ..open_facts() };
        let p = Ask { card: Some("card-9".into()), ..raw_ask("p", "lap", "desk", 0) };
        assert_eq!(desk.on(FleetMsg::Prompt { ask: p, age_ms: 0 }, 0, &bounded).deliver.len(), 1);
        let r = desk.on(FleetMsg::Ask { ask: raw_ask("r", "lap", "desk", 0), age_ms: 0 }, 0, &bounded);
        assert_eq!(r.open.len(), 1, "the prompt still in hand must not have used the slot");
    }

    /// A relay passes a prompt on as a prompt, and a wall that arrives later
    /// hears it as one.
    #[test]
    fn a_prompt_relayed_or_gossiped_keeps_its_tag() {
        let mut server = Fleet::new("server", 0);
        let ask = Ask { card: Some("card-9".into()), ..raw_ask("p", "lap", "desk", 0) };
        let r = server.on(FleetMsg::Prompt { ask, age_ms: 0 }, 0, &open_facts());
        assert!(matches!(r.say.as_slice(), [FleetMsg::Prompt { .. }]));
        assert!(server.open(10).iter().any(|m| matches!(m, FleetMsg::Prompt { .. })));
        assert!(!server.open(10).iter().any(|m| matches!(m, FleetMsg::Ask { .. })));
    }

    #[test]
    fn a_prompt_for_no_card_is_dropped() {
        let mut desk = Fleet::new("desk", 0);
        let ask = Ask { card: Some(String::new()), ..raw_ask("p", "lap", "desk", 0) };
        let r = desk.on(FleetMsg::Prompt { ask, age_ms: 0 }, 0, &open_facts());
        assert!(r.deliver.is_empty() && r.say.is_empty());
    }

    /// What a card costs is the asker's decision and has to arrive whole — and
    /// an ask from a build that predates the two fields must still read, as no
    /// preference, rather than failing the frame and every frame beside it.
    #[test]
    fn the_model_and_effort_travel_and_an_older_ask_still_reads() {
        let mut desk = Fleet::new("desk", 0);
        let ask = Ask { model: Some("sonnet".into()), effort: Some("low".into()), ..raw_ask("r", "lap", "desk", 0) };
        let r = desk.on(FleetMsg::Ask { ask, age_ms: 0 }, 0, &open_facts());
        assert_eq!(r.open[0].model.as_deref(), Some("sonnet"));
        assert_eq!(r.open[0].effort.as_deref(), Some("low"));

        let mut v = serde_json::to_value(FleetMsg::Ask { ask: raw_ask("r2", "lap", "desk", 0), age_ms: 0 }).unwrap();
        v["ask"].as_object_mut().unwrap().remove("model");
        v["ask"].as_object_mut().unwrap().remove("effort");
        let older: FleetMsg = serde_json::from_value(v).expect("an ask without the new fields still reads");
        let r = desk.on(older, 0, &open_facts());
        assert_eq!(r.open[0].model, None);
    }

    /// A corrupt frame — an age of `u64::MAX`, a stamp at either end of `i64`
    /// — must not overflow the arithmetic. A debug build panicked on these.
    #[test]
    fn absurd_ages_and_stamps_do_not_overflow() {
        let mut desk = Node::new("desk", open_facts());
        for (asked_at, age_ms) in [(i64::MIN, u64::MAX), (i64::MAX, 0), (0, u64::MAX), (i64::MIN, 0)] {
            let id = format!("r{asked_at}{age_ms}");
            desk.hear(FleetMsg::Ask { ask: raw_ask(&id, "lap", "desk", asked_at), age_ms }, 1_000);
            desk.hear(FleetMsg::Ask { ask: raw_ask(&id, "lap", "elsewhere", asked_at), age_ms }, 1_000);
        }
        desk.hear(statement("odd", u64::MAX, open_facts(), Some(i64::MIN), u64::MAX), 1_000);
        desk.f.prune(i64::MAX);
        desk.f.open(i64::MIN);
        assert!(desk.spawns.is_empty());
    }

    /// Candidates come best first, dead ends included with their reasons, and
    /// never this wall itself.
    #[test]
    fn candidates_are_ordered_by_what_would_actually_work() {
        let mut me = Node::new("me", open_facts());
        me.f.announce(open_facts(), 0);
        me.hear(statement("asleep", 1, open_facts(), None, (QUIET_AFTER_MS * 2) as u64), 0);
        me.hear(statement("closed", 1, Facts { accepting: false, ..open_facts() }, None, 0), 0);
        me.hear(statement("busy", 1, Facts { cards_working: 6, ..open_facts() }, None, 0), 0);
        me.hear(statement("calm", 1, Facts { cards_working: 1, ..open_facts() }, None, 0), 0);
        me.hear(statement("elsewhere", 1, Facts { territories: vec![t("tid-nova", "nova")], ..open_facts() }, None, 0), 0);

        let order: Vec<&str> = me.f.candidates("tid-skein", 0).iter().map(|(e, _)| e.host.as_str()).collect();
        assert_eq!(order, vec!["calm", "busy", "closed", "asleep"]);
    }

    /// The wire is what two builds share. An older wall must read a newer
    /// one's facts, which is what `#[serde(default)]` is for.
    #[test]
    fn the_wire_survives_a_round_trip_and_a_missing_field() {
        let mut lap = Fleet::new("lap", 0);
        let m = lap.announce(Facts { allowance_used: Some(40), ..open_facts() }, 7);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"msg\":\"roster\""), "{json}");
        assert_eq!(serde_json::from_str::<FleetMsg>(&json).unwrap(), m);

        let sparse = r#"{"msg":"roster","greeting":false,"walls":[{"wall":{"host":"old","version":1,"facts":{"accepting":true}},"age_ms":0}]}"#;
        let FleetMsg::Roster { walls, .. } = serde_json::from_str::<FleetMsg>(sparse).unwrap() else { unreachable!() };
        assert!(walls[0].wall.facts.accepting);
        assert!(walls[0].wall.facts.territories.is_empty());
        assert_eq!(walls[0].wall.said_at, None);
    }
}
