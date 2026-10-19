//! The thing that actually runs: a wall that answers dials and makes them.
//!
//! Everything under `flyway/` was built so this file could be short. `seal.rs`
//! makes a frame unreadable, `sync.rs` says how two piles converge,
//! `session.rs` says what two walls say about the sink, `fleet.rs` what they say
//! about each other, `cards.rs` what their cards look like, `frame.rs` how the
//! three share one wire, `wire.rs` carries bytes, and `sinksync.rs` keeps the
//! outbox. None of them does anything on its own. This starts them.
//!
//! ### Pull on a tick, push what somebody is waiting for
//!
//! This file opened, for its first life, with *both walls pull; nobody
//! pushes*, and argued it: a push needs the sender to know the receiver's
//! watermark, which it only learns by asking — a second round trip, on a
//! connection held open while both ends interleave, and `wire.rs` deliberately
//! finishes its send before reading because a stream where both ends wait hangs
//! until the idle timeout and reads as a sleeping machine.
//!
//! **That argument is true of sink events and was generalised to the whole
//! protocol without anybody noticing the generalisation.** It is also not quite
//! true of sink events, and both corrections are worth having in the place the
//! original was:
//!
//! - **A fleet message needs no watermark.** An ask, an answer, a roster entry
//!   and a cards snapshot each carry their own identity, and the receiving side
//!   drops a repeat (`fleet.rs`'s keys, `cards.rs`'s version). So pushing one
//!   costs exactly a pull's shape — dial, send, finish, read — with nothing
//!   held open and `wire.rs`'s ordering untouched. And it has to be pushed: an
//!   ask that waited up to a tick for the other wall's next pull is an ask
//!   nobody would use, and "open a card over there" has to feel like pressing a
//!   button. So an ask goes to the wall it is for the moment it is made, an
//!   answer to the wall that asked the moment the card is open, and a changed
//!   snapshot to every peer within a second (coalesced, `CARDS_EVERY`). The
//!   tick re-says everything still worth saying (`Fleet::open`), so a push that
//!   fails costs a tick of latency and never the message.
//! - **The watermark is already in hand after every pull.** The answer to a
//!   pull opens with the far wall's own `Hello`, which *is* its watermark — the
//!   first cut read it and threw it away. So a pull is now followed by one more
//!   exchange carrying whatever that watermark shows the other wall lacks, made
//!   only when there is something to carry. Without it the sink was
//!   **one-directional**: the wall that started a flyway has its own name in its
//!   invite, so it dialled nobody, and the joiner's `Hello` carried a watermark
//!   and no events — nothing a joiner said ever reached the wall that invited
//!   it. A wall one release behind, which cannot pull from us at all, is reached
//!   the same way.
//!
//! Not a held-open connection. It would save one round trip per push — the
//! handshake — at the price of a connection cache with liveness, reconnection
//! and idle-timeout handling, and the round trip it saves is noise beside what
//! a push usually triggers: opening a card is a process and several seconds. A
//! live transcript is where a held connection would start paying for itself,
//! and that is when this becomes the thing it is built on.
//!
//! ### One tick, and it is the roster's
//!
//! Thirty seconds, which is `fleet::ANNOUNCE_EVERY_MS`, and the sink's old
//! forty-five went with it. The roster's quiet rule — three silent periods —
//! assumes an announcement is heard every period, and an announcement only
//! travels when a connection does. A second timer for the fleet alone would be
//! a second connection per peer to the same peer, so the sink takes the
//! roster's period: one and a half times the connections it made alone, still
//! one per peer per half-minute, and every one of them carrying all three.
//!
//! ### Who a wall dials
//!
//! The invite's host is a **seed**, not the peer. A wall dials every host the
//! roster names, every host that has dialled it (an old wall says who it is in
//! its `Hello` and sends no roster), and the seed. One name is enough to find
//! one wall, and every other wall on the flyway is learned from that one — which
//! is what `key.rs` always said, and what the first link never did.
//!
//! ### A wall never dials itself
//!
//! It would deadlock against its own accept loop, and the case is reachable
//! rather than theoretical: the wall that *started* a flyway has its own name
//! in its stored invite. `key::joined_peer` filters it there, and `peers` here,
//! since the roster lists this wall too.
//!
//! ### Why this polls, when almost nothing else here does
//!
//! CLAUDE.md's rule is that the wall folds events rather than asking, and names
//! the three places that go and look and why each had no event to fold. This is
//! a fourth and it owes the same argument: **the thing being watched is another
//! machine, which emits nothing we can hear until we open a connection to it.**
//! There is no local event that means "the laptop has had a thought". What
//! *does* have an event — an ask, an opened card, a snapshot changing — is
//! pushed off that event rather than waiting for the clock. The residue is
//! bounded the way the others are: one timer however many peers, started when a
//! key exists, and a peer that keeps failing is dialled less and less often.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use super::act::{self, ActMsg};
use super::boards::{self, BoardMsg, Boards};
use super::cards::{Arrived, Cards};
use super::fleet::{self, Act, Answer, Deliver, Facts, Fleet, FleetMsg, Origin, Outcome, PromptRequest, Refusal, Request, Spawn, Standing};
use super::frame::Frame;
use super::here;
use super::key;
use super::look::{self, LookMsg};
use super::session::Msg;
use super::tail::{self, TailMsg};
use super::wire::{Dialler, Fault, Wire};
use crate::store::Store;

pub(crate) mod accounting;
mod billboard;
mod leaving;
mod moves;

use leaving::{tick_hosts, tick_until_closed, Tenure};

/// How often a wall asks the others what it has missed — and says what it is.
/// See the module note on why this is the roster's period.
const EVERY: Duration = Duration::from_millis(fleet::ANNOUNCE_EVERY_MS as u64);

/// How long the front end has to report a card opened for another wall before
/// this wall answers that it could not. `#openIn` takes seconds; this is long
/// past it, and short enough that the asker's tool call is still listening.
const OPEN_WITHIN_MS: i64 = 2 * 60_000;

/// How long a peer refusing the current language is dialled in the old one
/// before the current is tried again — so a wall that updates is noticed
/// within minutes rather than at the next restart.
const OLDER_FOR_MS: i64 = 10 * 60_000;

/// The longest a peer that keeps failing waits between dials. A laptop in a
/// bag for a week should cost a dial every few minutes, not two a minute.
const BACKOFF_MAX_MS: i64 = 5 * 60_000;

/// How often a changed cards snapshot may go out. The front end publishes at
/// most once a second and only on change; this is the same bound on the wire,
/// so a burst of changes is one push carrying the last of them.
const CARDS_EVERY: Duration = Duration::from_secs(1);

/// How long a wall asked for a card's conversation waits for its own front end
/// to make it. The asker's whole exchange is bounded at twenty seconds
/// (`wire.rs`), dial included, so this has to be well inside that or the
/// answer is written to a stream nobody is reading. Making a tail is a fold
/// over lines already in memory — milliseconds — unless the card's scrollback
/// has to be read off disk first, which is the case this leaves room for.
const TAIL_WITHIN: Duration = Duration::from_secs(12);

/// The most tails one exchange may ask for. A panel asks for one, and the
/// waits are serial, so a second could only be answered after the asker's
/// twenty seconds had run out — anything asking for more is not this app.
const TAILS_PER_EXCHANGE: usize = 1;

/// How long a wall asked to do something to one of its cards waits for its own
/// front end to do it — `TAIL_WITHIN`'s bound and for its reason: well inside
/// the asker's twenty-second exchange. A wake is a spawn, which is seconds; a
/// clear closes a process first. Past it the asker is told it may or may not
/// have happened, which is the truth.
const ACT_WITHIN: Duration = Duration::from_secs(12);

/// The most acts one exchange may carry, for `TAILS_PER_EXCHANGE`'s reason.
const ACTS_PER_EXCHANGE: usize = 1;

/// The running link, if this wall has a key.
#[derive(Default)]
pub struct Flyway {
    link: StdMutex<Option<Arc<Link>>>,
    /// Held across bringing a link up, so launch and a key being entered at
    /// the same moment cannot bind two endpoints.
    arriving: Mutex<()>,
    /// The front end's snapshot from before there was a link to hand it to,
    /// with when it was published. Kept rather than dropped, or a wall whose
    /// link comes up after its cards were drawn — every launch, since binding
    /// reaches a lookup service — would show the other walls nothing until one
    /// of its cards happened to change.
    early_cards: StdMutex<Option<(Value, i64)>>,
}

/// What this wall knows and is doing on the flyway.
pub struct Link {
    app: AppHandle,
    wire: Wire,
    me: String,
    fleet: StdMutex<Fleet>,
    cards: StdMutex<Cards>,
    /// Hosts that answered a dial in the old language, and until when to keep
    /// using it. See `OLDER_FOR_MS`.
    older: StdMutex<HashMap<String, i64>>,
    /// Hosts that have dialled in and said who they are. An old wall sends no
    /// roster, and this is the only way it gets dialled back.
    heard: StdMutex<BTreeSet<String>>,
    /// Consecutive failures and when to try again, per host.
    failing: StdMutex<HashMap<String, (u32, i64)>>,
    /// Asks this wall made, by request id.
    waiting: StdMutex<HashMap<String, Waiter>>,
    /// Cards being opened for other walls, by the card's id here.
    opening: StdMutex<HashMap<String, Opening>>,
    /// This wall's burn rate and whether anyone here is reading it, as the
    /// front end last noted them (`flyway_note_rate`) — said in `Facts`.
    rate: StdMutex<(Option<u64>, bool)>,
    /// Prompts this wall sent, by request id, until they are answered.
    prompts_out: StdMutex<HashMap<String, PromptOut>>,
    /// Prompts handed to cards here, by the asker's host and request id.
    prompts_in: StdMutex<HashMap<(String, String), i64>>,
    /// Prompts with pictures being written right now (`push_pictured`).
    pictured_out: StdMutex<std::collections::HashSet<String>>,
    /// Conversations another wall asked for, parked until this wall's front
    /// end has made them — `ask.rs`'s shape, a channel per request under an id
    /// the front end answers by. Keyed on an id minted here rather than the
    /// asker's, so two walls asking at once cannot answer each other.
    tails: StdMutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    /// Gestures a person at another wall asked of cards here, parked the same
    /// way until this wall's front end has done them (`act_here`).
    acts: StdMutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Option<String>, String>>>>,
    cards_due: AtomicBool,
    /// What every other wall's billboard says, and the version this wall's
    /// own is said under (`boards.rs`, `link/billboard.rs`).
    boards: StdMutex<Boards>,
    board_due: AtomicBool,
    /// Readings other walls took of the accounts, by identity, and whether a
    /// push of this wall's account picture is already due
    /// (`flyway/accounts.rs`, `link/accounting.rs`).
    afar_accounts: StdMutex<accounting::Afar>,
    accounts_due: AtomicBool,
    /// Closed by `shutdown` when this wall leaves, and read by every task this
    /// link started (`leaving.rs`).
    tenure: Tenure,
    /// Walls that said goodbye and have not been heard from since — not dialled
    /// on the strength of a stale `heard` entry or the invite's seed.
    left: StdMutex<BTreeSet<String>>,
}

/// One of this wall's prompts to another wall's card.
struct PromptOut {
    to: String,
    /// Written to a connection to `to` at least once. Until it is, the front
    /// end draws it as still on this machine — the fourth mark a remote prompt
    /// needs, so that a link that is down never reads as an agent thinking.
    left: bool,
    asked_at: i64,
    /// Carries pictures, so it leaves only on an exchange of its own
    /// (`push_pictured`) and a greeting written to `to` is not it leaving.
    pictured: bool,
}

/// What one of this wall's own asks was for — which decides what its answer
/// reads like, and whether an answer that comes after the call returned is
/// worth a turn on the card that asked (`Link::tell`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Wants {
    /// A card opened there. Always told, late or not: a card running on
    /// another machine that its asker believes was never opened is the one
    /// outcome nobody can afford to leave unsaid.
    Spawn,
    /// A message delivered. Told late only if it was refused — a turn spent on
    /// "it arrived after all" buys nothing, and one spent on "it never arrived"
    /// is the asker learning its report went nowhere.
    Send,
    /// A card's words read back. Never told late: a reading is only worth
    /// having while somebody waits for it, and the asker was already told to
    /// try again.
    Recall,
    /// A card taken off. Told late either way, for `Spawn`'s reason in reverse.
    Close,
    /// A card a *person* here asked for from a section's menu
    /// (`flyway_open`). Nobody is parked on it and no card asked, so the
    /// answer goes to the front end as `flyway:opened-there` rather than into
    /// a tool call or a card's inbox — late or not, since a card that opened
    /// over there is one its shadow is about to show anyway.
    Open,
}

impl Wants {
    fn of(act: Act) -> Self {
        match act {
            Act::Prompt => Wants::Send,
            Act::Recall => Wants::Recall,
            Act::Close => Wants::Close,
        }
    }

    fn worth_telling_late(self, a: &Answer) -> bool {
        match self {
            Wants::Spawn | Wants::Close | Wants::Open => true,
            Wants::Send => matches!(a.outcome, Outcome::Refused { .. }),
            Wants::Recall => false,
        }
    }
}

/// One of this wall's own asks, and who to tell when it is answered.
struct Waiter {
    wants: Wants,
    /// The card it was about on the far wall, as the asker addressed it —
    /// for a send, a recall or a close.
    there: Option<String>,
    /// The card that asked, if one did.
    card: Option<String>,
    /// The parked tool call, while it is still listening.
    tx: Option<mpsc::Sender<String>>,
    to: String,
    territory: String,
    title: Option<String>,
    /// Told "nobody answered" already — so a late answer is news, and says so.
    gave_up: bool,
    asked_at: i64,
    /// For a spawn: a credential the card needs that the far wall could not
    /// vouch for, said in the receipt (`fleet::unconfirmed`).
    note: Option<String>,
}

struct Opening {
    asked_by: String,
    request: String,
    since: i64,
}

fn current(app: &AppHandle) -> Option<Arc<Link>> {
    app.try_state::<Flyway>()?.link.lock().ok()?.clone()
}

/// Bring the link up, if there is a key to bring it up with.
///
/// Idempotent: called at launch and again whenever a key is entered, because
/// those are the two moments a wall can become a member and neither should have
/// to know about the other.
pub async fn arrive(app: AppHandle) -> Result<bool, String> {
    let Some(k) = key::wall_key() else {
        return Ok(false);
    };
    let me = key::host_name();
    let state = app.state::<Flyway>();
    let _one = state.arriving.lock().await;
    if current(&app).is_some() {
        return Ok(true);
    }

    let (fleet_v, cards_v, board_v) = {
        /* `try_state`, because this is reached from a command as well as from
           setup, and a missing store must be an error here rather than a
           panic on a runtime thread, which takes the process with it. */
        let store = app.try_state::<Store>().ok_or("the store is not open yet")?;
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        (
            here::version(&conn, here::FLEET_VERSION),
            here::version(&conn, here::CARDS_VERSION),
            here::version(&conn, here::BOARD_VERSION),
        )
    };
    /* What questions from other walls left here last time: no sheet survives a
       restart, so none of it is pointed at any more (`sweep_looks`). Before the
       link exists, so no pull can be writing while it goes. */
    {
        let a = app.clone();
        let _ = crate::off_main(move || sweep_looks(&a, true)).await;
    }
    let wire = Wire::start(k, &me).await?;
    let link = Arc::new(Link {
        app: app.clone(),
        wire,
        me: me.clone(),
        fleet: StdMutex::new(Fleet::new(&me, fleet_v)),
        cards: StdMutex::new(Cards::new(&me, cards_v)),
        older: StdMutex::new(HashMap::new()),
        heard: StdMutex::new(BTreeSet::new()),
        failing: StdMutex::new(HashMap::new()),
        waiting: StdMutex::new(HashMap::new()),
        opening: StdMutex::new(HashMap::new()),
        rate: StdMutex::new((None, false)),
        prompts_out: StdMutex::new(HashMap::new()),
        prompts_in: StdMutex::new(HashMap::new()),
        pictured_out: StdMutex::new(std::collections::HashSet::new()),
        tails: StdMutex::new(HashMap::new()),
        acts: StdMutex::new(HashMap::new()),
        cards_due: AtomicBool::new(false),
        boards: StdMutex::new(Boards::new(&me, board_v)),
        board_due: AtomicBool::new(false),
        afar_accounts: StdMutex::new(accounting::Afar::default()),
        accounts_due: AtomicBool::new(false),
        tenure: Tenure::new(),
        left: StdMutex::new(BTreeSet::new()),
    });
    *state.link.lock().map_err(|_| "the flyway is wedged".to_string())? = Some(link.clone());
    if let Some((snapshot, at)) = state.early_cards.lock().ok().and_then(|mut e| e.take()) {
        if let Ok(mut c) = link.cards.lock() {
            let _ = c.publish(snapshot, at);
        }
    }

    /* Answer anybody who dials, each on a task of its own — see `wire.rs` on
       why one at a time stopped being right. Detached rather than held,
       because the endpoint closing is what ends it. */
    let serving = link.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(incoming) = serving.wire.next_dial().await {
            /* A wall that has left answers nobody: a dial landing while the
               endpoint closes is dropped, and the dialler reads a wall that is
               not there — which, now, it is not. */
            if serving.tenure.is_closed() {
                break;
            }
            let l = serving.clone();
            tauri::async_runtime::spawn(async move {
                let me = l.clone();
                let out = l
                    .wire
                    .answer(incoming, move |heard, who| async move { me.answer_all(heard, who).await })
                    .await;
                if let Err(e) = out {
                    /* A failed dial is somebody else's network, not a reason
                       to stop listening. */
                    log::debug!("flyway: a dial came to nothing: {e}");
                }
            });
        }
    });

    /* And ask the others what we have missed — **now, then for ever.**

       The sleep is after the ask rather than before it, which is the whole of
       the difference between joining a flyway and watching nothing happen for
       half a minute. `arrive` is called when a key is entered as well as at
       launch, so the ask-first order is also what makes pasting an invite
       produce an answer on the spot. */
    let asking = link.clone();
    tauri::async_runtime::spawn(async move {
        /* Until the link is closed, and on *this* link rather than whichever is
           current: a wall that left and came back has a new one, and the old
           loop must not go on ticking beside it. */
        tick_until_closed(&asking.tenure, EVERY, || {
            let l = asking.clone();
            async move {
                if let Err(e) = l.tick().await {
                    log::debug!("flyway: nothing came back this time: {e}");
                }
            }
        })
        .await;
    });

    Ok(true)
}

/// One tick: say what this wall is, tidy what is too old to matter, and dial
/// every peer at once.
pub async fn pull(app: AppHandle) -> Result<usize, String> {
    let Some(link) = current(&app) else {
        return Err("this wall is not on a flyway".to_string());
    };
    link.tick().await
}

/// What to say to a wall that dialled us, against a connection rather than an
/// app — kept for `examples/flyway-link.rs`, which exercises the sink's
/// integrated path with no Tauri app around it.
pub fn answer_with(conn: &rusqlite::Connection, heard: Vec<Msg>) -> Vec<Msg> {
    let mut out = Vec::new();
    for m in heard {
        match m {
            Msg::Hello { watermark, .. } => {
                let mine = crate::sinksync::watermark(conn).unwrap_or_default();
                out.push(Msg::Hello { host: key::host_name(), watermark: mine });
                if let Ok(events) = crate::sinksync::events_after(conn, &watermark) {
                    if !events.is_empty() {
                        out.push(Msg::Events { events });
                    }
                }
            }
            /* A wall that pushes is not refused — the fold is idempotent and a
               frame we did not ask for is still news. Which is now exactly
               what every wall does after a pull; see the module note. */
            Msg::Events { events } => {
                for e in &events {
                    let _ = crate::sinksync::receive(conn, e);
                }
            }
        }
    }
    out
}

impl Link {
    fn now(&self) -> i64 {
        crate::store::now()
    }

    fn store(&self) -> Option<tauri::State<'_, Store>> {
        self.app.try_state::<Store>()
    }

    /// Directories that are Skein's own rather than anybody's territory.
    fn own_dirs(&self) -> Vec<std::path::PathBuf> {
        let Some(store) = self.store() else {
            return Vec::new();
        };
        let raw = store.1.clone();
        let real = std::path::PathBuf::from(crate::store::canonical_root(&raw.to_string_lossy()));
        vec![raw, real]
    }

    /// What this wall is, read fresh. An ask is decided against these and
    /// never against what was last announced (`Fleet::on`).
    fn facts(&self) -> Facts {
        let Some(store) = self.store() else {
            return Facts::default();
        };
        let own = self.own_dirs();
        let own: Vec<&std::path::Path> = own.iter().map(|p| p.as_path()).collect();
        let in_flight = self.opening.lock().map(|o| o.len() as u32).unwrap_or(0);
        let (mut f, open) = {
            let Ok(conn) = store.0.lock() else {
                return Facts::default();
            };
            let f = Facts {
                territories: here::territories(&conn, &own),
                accepting: here::accepting(&conn),
                bound: here::bound(&conn),
                /* Cards opened for other walls and cards that moved here are
                   both arriving work, and the bounds are on arriving work. */
                remote_live: here::births_live(&conn) + here::arrivals_live(&conn),
                /* A card agreed to and not yet open is in both the table and
                   the fleet's in-flight count; taken out here so the bound does
                   not count it twice. */
                remote_last_hour: (here::births_since(&conn, self.now() - 60 * 60_000)
                    + here::arrivals_since(&conn, self.now() - 60 * 60_000))
                .saturating_sub(in_flight),
                can: fleet::can_now()
                    .into_iter()
                    .chain([
                        tail::WORD.to_string(),
                        super::moving::WORD.to_string(),
                        look::WORD.to_string(),
                        crate::attachments::CAN_FILES.to_string(),
                        super::opening::WORD.to_string(),
                        boards::WORD.to_string(),
                    ])
                    .chain(act::words())
                    .chain(accounting::words())
                    .collect(),
                ..Facts::default()
            };
            (f, here::open_cards(&conn))
        };
        let sup = self.app.state::<crate::supervisor::Supervisor>();
        f.cards_live = open.len() as u32;
        f.cards_working = open.iter().filter(|c| sup.liveness(c).1).count() as u32;
        f.allowance_used = crate::limits::headroom_used(&self.app);
        /* This wall's own word only — never the union, which reads the roster
           and would have every wall vouching for every other. Not here if the
           switch says away, or if nobody has touched this machine for longer
           than Windows would take to decide they had gone (`machine::idle_away`)
           — a laptop left open is not where she is. The same reading also
           decides this wall's own filing now (`presence::nobody_to_ask`),
           since questions lost their deadline; `idle_away` has why. */
        f.present = !crate::presence::away_here(&self.app) && !crate::machine::idle_away();
        (f.rate, f.wants_rate) = self.rate.lock().map(|r| *r).unwrap_or_default();
        /* Outside the store lock: two vault reads, and the wall's cards do not
           wait on the credential manager. Names only — `creds::holdings`. */
        (f.holds, f.lacks) = crate::creds::holdings();
        f
    }

    /// One tick: say what this wall is, tidy what is too old to matter, and
    /// dial every peer at once. Nothing at all once the link is closed — a tick
    /// already under way when a wall leaves finishes its dials, which fail
    /// against the closed endpoint, and starts no more.
    async fn tick(self: &Arc<Self>) -> Result<usize, String> {
        if self.tenure.is_closed() {
            return Err("this wall has left the flyway".to_string());
        }
        self.housekeep();
        let mut dials = Vec::new();
        for host in self.due_peers() {
            let l = self.clone();
            dials.push(tauri::async_runtime::spawn(async move { l.dial(&host).await }));
        }
        let mut news = 0;
        for d in dials {
            if let Ok(Ok(n)) = d.await {
                news += n;
            }
        }
        Ok(news)
    }

    /// The tick's bookkeeping: announce, keep the version, forget what is too
    /// old, and settle what nobody is going to settle.
    fn housekeep(self: &Arc<Self>) {
        let now = self.now();
        let facts = self.facts();
        let (version, gave_up) = {
            let Ok(mut f) = self.fleet.lock() else { return };
            f.announce(facts, now);
            (f.version(), f.prune(now))
        };
        /* Kept after every announcement, not at exit: a crash is the restart
           this exists for. See `Fleet::announce`. */
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                let _ = here::set_setting(&conn, here::FLEET_VERSION, &version.to_string());
            }
        }
        for id in gave_up {
            self.nobody_answered(&id);
        }
        /* A card handed to the front end and never reported: answered as not
           opened, so the asker is not left waiting and the bound is freed. */
        let stale: Vec<String> = self
            .opening
            .lock()
            .map(|o| o.iter().filter(|(_, v)| now - v.since > OPEN_WITHIN_MS).map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        for card in stale {
            self.failed(
                &card,
                &format!(
                    "the wall did not report the card open within {} minutes — check that wall; if a \
                     card did appear there, it is the one",
                    OPEN_WITHIN_MS / 60_000
                ),
            );
        }
        let stale: Vec<(String, String)> = self
            .prompts_in
            .lock()
            .map(|p| p.iter().filter(|(_, since)| now - **since > OPEN_WITHIN_MS).map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        for (host, request) in stale {
            self.prompt_settled(&host, &request, Err("the wall did not hand it to the card in time".into()));
        }
        self.waiting
            .lock()
            .map(|mut w| w.retain(|_, v| now - v.asked_at <= fleet::ANSWER_KEPT_MS))
            .ok();
        self.sweep_moves();
        self.prompts_out
            .lock()
            .map(|mut o| o.retain(|_, v| now - v.asked_at <= fleet::ANSWER_KEPT_MS))
            .ok();
        self.emit_roster();
    }

    /// Every wall worth dialling this tick.
    fn due_peers(&self) -> Vec<String> {
        let now = self.now();
        let roster: Vec<String> =
            self.fleet.lock().map(|f| f.roster().map(|e| e.host.clone()).collect()).unwrap_or_default();
        let heard = self.heard.lock().map(|h| h.clone()).unwrap_or_default();
        let left = self.left.lock().map(|l| l.clone()).unwrap_or_default();
        let hosts = tick_hosts(&self.me, &roster, &heard, key::joined_peer().as_deref(), &left);
        let failing = self.failing.lock().map(|f| f.clone()).unwrap_or_default();
        hosts.into_iter().filter(|h| failing.get(h).is_none_or(|(_, next)| now >= *next)).collect()
    }

    fn mark(&self, host: &str, ok: bool) {
        let Ok(mut f) = self.failing.lock() else { return };
        if ok {
            f.remove(host);
            return;
        }
        let e = f.entry(host.to_string()).or_insert((0, 0));
        e.0 = e.0.saturating_add(1);
        let wait = (EVERY.as_millis() as i64).saturating_mul(1i64 << e.0.min(6)).min(BACKOFF_MAX_MS);
        e.1 = self.now() + wait;
    }

    fn speaks_older(&self, host: &str) -> bool {
        let now = self.now();
        self.older.lock().map(|o| o.get(host).is_some_and(|until| now < *until)).unwrap_or(false)
    }

    /// What to say on connect: the sink's hello, everything the fleet knows,
    /// and this wall's cards — or only the hello, to a wall that knows nothing
    /// else.
    fn greeting(&self, current: bool) -> Result<Vec<Frame>, String> {
        let now = self.now();
        let watermark = {
            let store = self.store().ok_or("the store is unavailable")?;
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            crate::sinksync::watermark(&conn)?
        };
        let mut out = vec![Frame::Sink(Msg::Hello { host: self.me.clone(), watermark })];
        if current {
            if let Ok(f) = self.fleet.lock() {
                out.extend(f.open(now).into_iter().map(Frame::Fleet));
            }
            if let Some(c) = self.cards.lock().ok().and_then(|c| c.say(now)) {
                out.push(Frame::Cards(c));
            }
            if let Some(b) = self.board_say() {
                out.push(Frame::Board(b));
            }
        }
        Ok(out)
    }

    /// One pull from one wall, and the push its answer shows is owed.
    async fn dial(self: &Arc<Self>, host: &str) -> Result<usize, String> {
        if self.tenure.is_closed() {
            return Err("this wall has left the flyway".to_string());
        }
        let peer = self.wire.peer(host)?;
        let mut current = !self.speaks_older(host);
        let back = match self.wire.exchange(peer, self.greeting_for(host, current)?, current).await {
            Ok(b) => b,
            Err(Fault::Older(why)) if current => {
                log::info!("flyway: {host} speaks the older language ({why}); syncing its sink only");
                if let Ok(mut o) = self.older.lock() {
                    o.insert(host.to_string(), self.now() + OLDER_FOR_MS);
                }
                current = false;
                match self.wire.exchange(peer, self.greeting(false)?, false).await {
                    Ok(b) => b,
                    Err(e) => {
                        self.mark(host, false);
                        return Err(e.to_string());
                    }
                }
            }
            Err(e) => {
                self.mark(host, false);
                return Err(e.to_string());
            }
        };
        self.mark(host, true);
        /* The greeting carried `Fleet::open`, which says again every prompt
           still worth saying — so anything for this host has now been written
           to a connection to it. */
        if current {
            self.left_for(host);
            /* A prompt with pictures never rides the greeting (`fleet::gossip`),
               so it is said again here, on an exchange of its own, for as long
               as it is unanswered and could still be acted on. */
            let pictured = self.fleet.lock().map(|f| f.pictured_for(self.now(), host)).unwrap_or_default();
            for (id, m) in pictured {
                self.push_pictured(host.to_string(), id, m);
            }
        }
        let (news, theirs) = self.take(back, Some(host));

        /* The push the answer showed is owed. See the module note: this is
           the half that makes the sink travel both ways. */
        if let Some(watermark) = theirs {
            let lacking = {
                let store = self.store().ok_or("the store is unavailable")?;
                let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
                crate::sinksync::events_after(&conn, &watermark).unwrap_or_default()
            };
            if !lacking.is_empty() {
                let n = lacking.len();
                match self.wire.exchange(peer, vec![Frame::Sink(Msg::Events { events: lacking })], current).await {
                    Ok(back) => {
                        self.take(back, Some(host));
                        log::debug!("flyway: carried {n} event(s) {host} was missing");
                    }
                    Err(e) => log::debug!("flyway: could not carry what {host} was missing: {e}"),
                }
            }
        }
        Ok(news)
    }

    /// Say something to one wall now, and take whatever it says back.
    fn push(self: &Arc<Self>, host: String, frames: Vec<Frame>) {
        if host.eq_ignore_ascii_case(&self.me) || frames.is_empty() || self.tenure.is_closed() {
            return;
        }
        let l = self.clone();
        tauri::async_runtime::spawn(async move {
            /* Fleet and cards frames only ever go in the current language; a
               wall that does not speak it cannot read them, and the tick's
               `open` will say them again once it does. */
            if l.speaks_older(&host) {
                return;
            }
            let Ok(peer) = l.wire.peer(&host) else { return };
            match l.wire.exchange(peer, frames, true).await {
                Ok(back) => {
                    l.left_for(&host);
                    l.take(back, Some(&host));
                }
                Err(e) => log::debug!("flyway: a push to {host} did not land (the tick will say it again): {e}"),
            }
        });
    }

    /// Fold an answer in. Returns how many sink events were news, and the far
    /// wall's watermark if it said one.
    fn take(self: &Arc<Self>, frames: Vec<Frame>, from: Option<&str>) -> (usize, Option<BTreeMap<String, u64>>) {
        let now = self.now();
        let mut news = 0;
        let mut theirs = None;
        let mut fleet_spoke = false;
        for f in frames {
            match f {
                Frame::Sink(Msg::Hello { watermark, .. }) => theirs = Some(watermark),
                Frame::Sink(Msg::Events { events }) => {
                    if let Some(store) = self.store() {
                        if let Ok(conn) = store.0.lock() {
                            for e in &events {
                                if crate::sinksync::receive(&conn, e).unwrap_or(false) {
                                    news += 1;
                                }
                            }
                        }
                    }
                }
                Frame::Fleet(m) => {
                    fleet_spoke = true;
                    self.hear(m, from);
                }
                Frame::Cards(m) => {
                    let got = self.cards.lock().ok().and_then(|mut c| c.on(m, now));
                    if let Some(a) = got {
                        self.emit_cards(a);
                    }
                }
                /* A tail is only ever read by the exchange that asked for it
                   (`read_tail`), which takes it out before this sees the rest. */
                Frame::Tail(_) => {}
                /* So is a move's answer (`moves.rs`); one arriving loose is from
                   an exchange that already gave up on it. */
                Frame::Move(_) => {}
                /* And a look's (`read_look`), and an act's (`read_act`). */
                Frame::Look(_) | Frame::Act(_) => {}
                Frame::Board(m @ BoardMsg::Board { .. }) => self.on_board(m),
                Frame::Accounts(m) => self.on_accounts(m, from),
                /* An unpost's answer is read by the exchange that asked
                   (`unpost_there`); an ask is only ever answered, never taken. */
                Frame::Board(_) => {}
            }
        }
        if fleet_spoke {
            self.emit_roster();
        }
        (news, theirs)
    }

    /// Answer a wall that dialled us, a card's conversation included.
    ///
    /// The tail is the one answer that waits on something — this wall's front
    /// end — so it is taken out first, everything else is answered as it
    /// always was, and the tails are written after. Held to the current
    /// language: an old wall never asks, and a frame that somehow came from one
    /// is answered as though it had not.
    async fn answer_all(self: Arc<Self>, heard: Vec<Frame>, who: Dialler) -> Vec<Frame> {
        let (asks, rest): (Vec<Frame>, Vec<Frame>) =
            heard.into_iter().partition(|f| matches!(f, Frame::Tail(TailMsg::Tail { .. })));
        let (acts, rest): (Vec<Frame>, Vec<Frame>) =
            rest.into_iter().partition(|f| matches!(f, Frame::Act(ActMsg::Act { .. })));
        /* Which wall asked, before `answer` consumes the frames: an act is
           done for a named wall or not at all. */
        let from = if acts.is_empty() { None } else { self.who_is(&rest, who) };
        let mut out = self.answer(rest, who);
        if who.current {
            for f in asks.into_iter().take(TAILS_PER_EXCHANGE) {
                if let Frame::Tail(TailMsg::Tail { id, card }) = f {
                    out.push(Frame::Tail(self.tail_here(id, card).await));
                }
            }
            for f in acts.into_iter().take(ACTS_PER_EXCHANGE) {
                if let Frame::Act(ActMsg::Act { id, card, verb, args, from_card }) = f {
                    if let Some(m) = self.act_here(id, card, verb, args, from_card, from.as_deref()).await {
                        out.push(Frame::Act(m));
                    }
                }
            }
        }
        out
    }

    /// Answer a wall that dialled us.
    fn answer(self: &Arc<Self>, heard: Vec<Frame>, who: Dialler) -> Vec<Frame> {
        let now = self.now();
        let from = self.who_is(&heard, who);
        let mut out = Vec::new();
        let mut fleet_spoke = false;
        for f in heard {
            match f {
                Frame::Sink(m) => {
                    let Some(store) = self.store() else { continue };
                    let Ok(conn) = store.0.lock() else { continue };
                    out.extend(answer_with(&conn, vec![m]).into_iter().map(Frame::Sink));
                }
                /* A wall saying it is leaving — taken off at once, but only if
                   it is who the handshake proved. Not `hear`d: the roster
                   cannot check a name against a connection (`leaving.rs`). */
                Frame::Fleet(FleetMsg::Leaving { host }) if who.current => self.departed(&host, who),
                /* An old wall never sends these; a frame that is somehow here
                   from one is answered as though it had not been, since an
                   answer it cannot read would cost it the sink frames beside. */
                Frame::Fleet(m) if who.current => {
                    fleet_spoke = true;
                    out.extend(self.hear(m, from.as_deref()).into_iter().map(Frame::Fleet));
                }
                Frame::Cards(m) if who.current => {
                    let got = self.cards.lock().ok().and_then(|mut c| c.on(m, now));
                    if let Some(a) = got {
                        self.emit_cards(a);
                    }
                }
                /* A card moving between walls, answered on the same stream —
                   `moves.rs`. */
                Frame::Move(m) if who.current => {
                    if let Some(r) = self.on_move(m, from.as_deref()) {
                        out.push(Frame::Move(r));
                    }
                }
                /* What a parked question shows, read off this wall for the
                   wall a person is at — `look.rs`. Not gated by "take work
                   from other walls", for `tail_here`'s reason: it starts
                   nothing, and the answer to the question already passes. */
                Frame::Look(LookMsg::Look { id, card, ask, want }) if who.current => {
                    out.push(Frame::Look(self.look_here(&id, &card, &ask, &want)));
                }
                Frame::Board(m @ BoardMsg::Board { .. }) if who.current => self.on_board(m),
                Frame::Accounts(m) if who.current => self.on_accounts(m, from.as_deref()),
                /* A notice of this wall's taken down from another — decided
                   here, against this wall's own ladder (`board.rs`). Not gated
                   by "take work from other walls": it starts nothing. */
                Frame::Board(m @ BoardMsg::Unpost { .. }) if who.current => {
                    if let Some(r) = self.unpost_here(m, from.as_deref()) {
                        out.push(Frame::Board(r));
                    }
                }
                _ => {}
            }
        }
        if who.current {
            /* Answered in kind, as `Hello` is: the dialler gets this wall's
               cards in the same exchange it sent its own. */
            if let Some(c) = self.cards.lock().ok().and_then(|c| c.say(now)) {
                out.push(Frame::Cards(c));
            }
            /* And this wall's board, said after anything above was answered —
               so an `unpost` it just carried out leaves the asker's copy in the
               same exchange. */
            if let Some(b) = self.board_say() {
                out.push(Frame::Board(b));
            }
            /* And its accounts, to a wall that says them (`accounting.rs`). */
            out.extend(self.accounts_for(from.as_deref()));
        }
        if fleet_spoke {
            self.emit_roster();
        }
        out
    }

    /// Which host dialled — off its `Hello` where it said one, off the roster
    /// otherwise — and only ever a name whose derived identity is the one the
    /// handshake proved. A name that does not match is not believed.
    fn who_is(&self, heard: &[Frame], who: Dialler) -> Option<String> {
        let said = heard.iter().find_map(|f| match f {
            Frame::Sink(Msg::Hello { host, .. }) => Some(host.clone()),
            _ => None,
        });
        if let Some(h) = said {
            if self.wire.peer(&h).ok() == Some(who.id) {
                if !h.eq_ignore_ascii_case(&self.me) {
                    if let Ok(mut heard) = self.heard.lock() {
                        heard.insert(h.clone());
                    }
                    /* Heard from, so no longer a wall that said goodbye. */
                    if let Ok(mut left) = self.left.lock() {
                        left.remove(&h);
                    }
                }
                return Some(h);
            }
        }
        let hosts: Vec<String> = self.fleet.lock().map(|f| f.roster().map(|e| e.host.clone()).collect()).unwrap_or_default();
        hosts.into_iter().find(|h| self.wire.peer(h).ok() == Some(who.id))
    }

    /// One fleet message, and everything it causes. Returns what it says, for
    /// the serving side to send back to the wall that sent it.
    fn hear(self: &Arc<Self>, m: FleetMsg, from: Option<&str>) -> Vec<FleetMsg> {
        let now = self.now();
        let facts = self.facts();
        let reply = match self.fleet.lock() {
            Ok(mut f) => f.on(m, now, &facts),
            Err(_) => return Vec::new(),
        };
        for s in reply.open {
            self.open_for(s);
        }
        for d in reply.deliver {
            self.deliver_here(d);
        }
        for a in reply.answered {
            self.answered(a);
        }
        self.route(&reply.say, from);
        reply.say
    }

    /// Push what is owed to the walls it is for. Everything in a `say` is
    /// gossip and safe to send anywhere; what is *pushed* is only what
    /// somebody is waiting for — an ask to its addressee, an answer to its
    /// asker. A roster change rides the tick.
    fn route(self: &Arc<Self>, say: &[FleetMsg], except: Option<&str>) {
        for m in say {
            let to = match m {
                /* Never relayed and never pushed from here — see `push_pictured`. */
                FleetMsg::Pictured { .. } => None,
                FleetMsg::Ask { ask, .. }
                | FleetMsg::Prompt { ask, .. }
                | FleetMsg::Recall { ask, .. }
                | FleetMsg::Close { ask, .. } => Some(ask.to.clone()),
                FleetMsg::Answer { answer, .. } => Some(answer.asked_by.clone()),
                FleetMsg::Roster { .. } | FleetMsg::Leaving { .. } => None,
            };
            if let Some(to) = to {
                if to != self.me && except != Some(to.as_str()) {
                    self.push(to, vec![Frame::Fleet(m.clone())]);
                }
            }
        }
    }

    /* ── asking another wall for a card ────────────────────────────────────── */

    /// Ask a wall to open a card. What comes back is a receiver the parked
    /// tool call waits on; the sentence arrives when the answer does.
    pub fn ask_spawn(self: &Arc<Self>, r: Request) -> Result<mpsc::Receiver<String>, String> {
        let now = self.now();
        let (msg, note) = {
            let mut f = self.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?;
            /* Read off the same entry the ask is about to be judged against, so
               the receipt cannot disagree with the refusal it was not. */
            let note = f.entry(&r.to).and_then(|e| fleet::unconfirmed(&r.to, &r.needs, &e.facts));
            (f.ask(r.clone(), now), note)
        };
        let msg = match msg {
            Ok(m) => m,
            Err(why) => return Err(why.reason()),
        };
        let (tx, rx) = mpsc::channel();
        if let Ok(mut w) = self.waiting.lock() {
            w.insert(
                r.id.clone(),
                Waiter {
                    wants: Wants::Spawn,
                    there: None,
                    card: r.card.clone(),
                    tx: Some(tx),
                    to: r.to.clone(),
                    territory: r.territory.name.clone(),
                    title: r.title.clone(),
                    gave_up: false,
                    asked_at: now,
                    note,
                },
            );
        }
        self.push(r.to, vec![Frame::Fleet(msg)]);
        Ok(rx)
    }

    /// Ask a wall to open a card for a person here — a section's menu, not a
    /// tool call. Judged by `opening::person_request` against what that wall
    /// last said, then by `Fleet::ask` (quiet, unknown), then by the far wall
    /// when it decides. Answers with the request id; how it ends arrives as
    /// `flyway:opened-there`.
    pub fn ask_open(
        self: &Arc<Self>,
        host: &str,
        project: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<String, String> {
        let now = self.now();
        let id = crate::store::uuid_v4();
        let msg = {
            let mut f = self.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?;
            let facts = f.entry(host).map(|e| e.facts.clone());
            let r = super::opening::person_request(id.clone(), host, project, model, effort, facts.as_ref())?;
            let to = r.to.clone();
            let territory = r.territory.name.clone();
            let m = f.ask(r, now).map_err(|u| u.reason())?;
            (m, to, territory)
        };
        let (msg, to, territory) = msg;
        if let Ok(mut w) = self.waiting.lock() {
            w.insert(
                id.clone(),
                Waiter {
                    wants: Wants::Open,
                    there: None,
                    card: None,
                    tx: None,
                    to: to.clone(),
                    territory,
                    title: None,
                    gave_up: false,
                    asked_at: now,
                    note: None,
                },
            );
        }
        self.push(to, vec![Frame::Fleet(msg)]);
        Ok(id)
    }

    /// Send to, recall or close a card on another wall, for an agent here. What
    /// comes back is a receiver the parked tool call waits on, as a spawn's is;
    /// `Err` is said at once — an unknown wall, a quiet one, one too old to
    /// understand the request — and nothing is queued for later, for
    /// a2a4468e's reason: a lid that lifts eight hours on is not when anybody
    /// wanted this to happen.
    pub fn reach_card(self: &Arc<Self>, act: Act, r: PromptRequest) -> Result<mpsc::Receiver<String>, String> {
        let now = self.now();
        let msg = self
            .fleet
            .lock()
            .map_err(|_| "the fleet is wedged".to_string())?
            .reach(act, r.clone(), now)
            .map_err(|u| u.reason())?;
        let (tx, rx) = mpsc::channel();
        if let Ok(mut w) = self.waiting.lock() {
            w.insert(
                r.id.clone(),
                Waiter {
                    wants: Wants::of(act),
                    there: Some(r.card.clone()),
                    card: r.from_card.clone(),
                    tx: Some(tx),
                    to: r.to.clone(),
                    territory: String::new(),
                    title: None,
                    gave_up: false,
                    asked_at: now,
                    note: None,
                },
            );
        }
        self.push(r.to, vec![Frame::Fleet(msg)]);
        Ok(rx)
    }

    /// One of this wall's asks has been answered.
    fn answered(&self, a: Answer) {
        if let Some(p) = self.prompts_out.lock().ok().and_then(|mut o| o.remove(&a.request)) {
            let _ = p;
            let (outcome, why) = match &a.outcome {
                Outcome::Refused { refusal } => ("refused", Some(prompt_why(refusal, &a.by))),
                /* A person's prompt is only ever answered `Opened`; anything
                   else that is not a refusal still means the far wall took it. */
                Outcome::Opened { .. } | Outcome::Said { .. } => ("taken", None),
            };
            let _ = self.app.emit(
                "flyway:prompt-answer",
                PromptAnswered { id: a.request.clone(), by: a.by.clone(), outcome, why },
            );
            return;
        }
        let Some(w) = self.waiting.lock().ok().and_then(|mut w| w.remove(&a.request)) else {
            return;
        };
        if w.wants == Wants::Open {
            let (outcome, card, why) = match &a.outcome {
                Outcome::Opened { card } => ("opened", Some(card.clone()), None),
                Outcome::Refused { refusal } => ("refused", None, Some(prompt_why(refusal, &a.by))),
                Outcome::Said { .. } => ("refused", None, Some(format!("{} answered with something other than a card", a.by))),
            };
            let _ = self.app.emit(
                "flyway:opened-there",
                OpenedThere { id: a.request.clone(), host: a.by.clone(), outcome, card, why },
            );
            return;
        }
        /* The pair written down the moment the answer says the card opened —
           it is what lets that card's report back through this wall's switch
           (`fleet::may_reach`, `migrate_v48`). Before the receipt, so a reply
           that races the receipt still finds it. */
        if let (Wants::Spawn, Outcome::Opened { card }, Some(parent)) = (w.wants, &a.outcome, &w.card) {
            if let Some(store) = self.store() {
                if let Ok(conn) = store.0.lock() {
                    if let Err(e) = here::record_child(&conn, &a.by, card, parent, &a.request, self.now()) {
                        log::warn!("flyway: could not write down the card {} opened for {parent}: {e}", a.by);
                    }
                }
            }
        }
        let text = match w.wants {
            Wants::Spawn => receipt(&a, &w, &self.me),
            _ => reached(&a, &w),
        };
        let late = w.wants.worth_telling_late(&a);
        self.tell(w, text, late);
    }

    /// Nobody answered one of this wall's asks in time.
    fn nobody_answered(&self, request: &str) {
        if let Some(p) = self.prompts_out.lock().ok().and_then(|mut o| o.remove(request)) {
            let why = if p.left {
                format!(
                    "{} did not answer — it may be asleep or off the network, and its clock may be far \
                     from this one's. Nothing says the card has it.",
                    p.to
                )
            } else {
                format!(
                    "it never left this wall — {} could not be reached while the prompt could still be \
                     acted on, so it was not sent",
                    p.to
                )
            };
            let _ = self.app.emit(
                "flyway:prompt-answer",
                PromptAnswered { id: request.to_string(), by: p.to, outcome: "refused", why: Some(why) },
            );
            return;
        }
        let w = {
            let Ok(mut all) = self.waiting.lock() else { return };
            let Some(w) = all.get_mut(request) else { return };
            /* A send, a recall or a close parks for half a minute and says
               then that it does not know; by `GIVE_UP_MS` that call returned
               long ago, and saying "still nothing" costs the card a turn to
               learn what it was already told. The waiter stays, so a late
               answer that is worth a turn still finds it. */
            if w.wants == Wants::Open {
                /* Taken away rather than kept for a late answer: nothing is
                   waiting on one, and a card that opens after all simply
                   appears in its section. Said once, after the lock is let go. */
                let to = w.to.clone();
                all.remove(request);
                drop(all);
                let _ = self.app.emit(
                    "flyway:opened-there",
                    OpenedThere {
                        id: request.to_string(),
                        host: to.clone(),
                        outcome: "refused",
                        card: None,
                        why: Some(format!(
                            "{to} did not answer — it may be asleep or off the network. If it opens the card \
                             after all, it will appear in its section"
                        )),
                    },
                );
                return;
            }
            if w.wants != Wants::Spawn {
                return;
            }
            w.gave_up = true;
            Waiter {
                wants: w.wants,
                there: w.there.clone(),
                card: w.card.clone(),
                tx: w.tx.take(),
                to: w.to.clone(),
                territory: w.territory.clone(),
                title: w.title.clone(),
                gave_up: true,
                asked_at: w.asked_at,
                note: w.note.clone(),
            }
        };
        let text = format!(
            "{} has not answered the ask to open a card in {} — it is probably asleep or off the \
             network, or its clock is far from this one's. Nothing was opened that this wall knows \
             of. If an answer arrives late you will be told; ask again later, or ask another wall.",
            w.to, w.territory
        );
        self.tell(w, text, true);
    }

    /// Put an answer in front of whoever asked: the parked tool call while it
    /// is still listening, and the card itself afterwards.
    fn tell(&self, w: Waiter, text: String, late: bool) {
        if let Some(tx) = w.tx {
            if tx.send(text.clone()).is_ok() {
                return;
            }
        }
        if !late {
            return;
        }
        let Some(card) = w.card else { return };
        let mark = crate::relay::RELAY_MARK;
        let late = if w.gave_up { " It arrived after you were told nobody had answered." } else { "" };
        let body = format!(
            "{mark} from the wall —\n\n**The answer to your ask of {} came after your call had \
             returned.**{late}\n\n{text}\n\n(This came from the wall rather than from anybody, so \
             nobody is waiting on a reply.)",
            w.to
        );
        if crate::supervisor::deliver(&self.app, &card, &body).is_err() {
            /* Asleep: the inbox, delivered on wake as written — a self-row,
               which `relay::drain_inbox` hands over without a second envelope. */
            if let Some(store) = self.store() {
                if let Ok(conn) = store.0.lock() {
                    let _ = crate::store::record_relay(&conn, &crate::store::uuid_v4(), &card, &card, &body, "", 0, false);
                }
            }
        }
    }

    /* ── opening a card another wall asked for ─────────────────────────────── */

    /// A card this wall agreed to open. Through `Skein.#openIn` and nothing
    /// else — `spawn.rs`'s "Rust decides; the wall opens" — so this resolves
    /// where it stands from this wall's own table, mints the id, writes the
    /// birth down and emits. The front end reports back with `flyway_opened`
    /// or `flyway_failed`, which is what answers the asker.
    fn open_for(self: &Arc<Self>, s: Spawn) {
        let now = self.now();
        let card = crate::store::uuid_v4();
        let refuse = |why: String| {
            let m = self.fleet.lock().ok().and_then(|mut f| f.failed(&s.asked_by.host, &s.request, &why, now));
            if let Some(m) = m {
                self.route(&[m], None);
            }
        };
        /* The same two words `spawn` takes and the same gate, asked again on
           this side: the asker may be a different build, and a model this
           wall's front end cannot resolve would open on the machine's own
           setting with every surface agreeing it had not. */
        let setup = serde_json::json!({ "model": s.model, "effort": s.effort });
        let model = match crate::spawn::asked_model(&setup) {
            Ok(m) => m,
            Err(why) => return refuse(why),
        };
        let effort = match crate::spawn::asked_effort(&setup, model.as_deref()) {
            Ok(e) => e,
            Err(why) => return refuse(why),
        };
        /* Empty only for a person's ask, which opens a card the way this
           wall's own `+` does — waiting for its first message (`opening.rs`).
           An agent's is refused here whatever the asking build checked. */
        if let Some(why) = super::opening::brief_refusal(&s.brief, s.asked_by.card.as_deref()) {
            return refuse(why.into());
        }
        let own = self.own_dirs();
        let own: Vec<&std::path::Path> = own.iter().map(|p| p.as_path()).collect();
        let cwd = {
            let Some(store) = self.store() else { return refuse("the store is unavailable".into()) };
            let Ok(conn) = store.0.lock() else { return refuse("the store is wedged".into()) };
            let cwd = match here::root_for(&conn, &s.territory.identity, &own) {
                Ok(r) => r,
                Err(why) => {
                    drop(conn);
                    return refuse(why);
                }
            };
            /* Before the emit, for `spawned`'s reason: the bound has to be true
               of the card from the moment it was agreed to. */
            if let Err(e) = here::record_birth(&conn, &card, &s.request, &s.asked_by.host, s.asked_by.card.as_deref(), now) {
                drop(conn);
                return refuse(format!("could not write the card down: {e}"));
            }
            cwd
        };
        if let Ok(mut o) = self.opening.lock() {
            o.insert(card.clone(), Opening { asked_by: s.asked_by.host.clone(), request: s.request.clone(), since: now });
        }
        /* The minimum `spawn.md` asks of a card nobody in this room asked for:
           a row saying who did. The card's own face says it too (`flyway:born`). */
        crate::chronicle::note(
            &self.app,
            None,
            "volery",
            "note",
            &format!("{} opened a card here, in {}", s.asked_by.host, s.territory.name),
            &match &s.title {
                Some(t) => format!("{t} — asked for over the flyway, and it runs on this machine"),
                None => "asked for over the flyway, and it runs on this machine".to_string(),
            },
        );
        let _ = self.app.emit(
            "flyway:spawn",
            SpawnHere {
                id: card,
                cwd,
                prompt: s.brief,
                title: s.title,
                model,
                effort,
                from_host: s.asked_by.host,
                from_card: s.asked_by.card,
            },
        );
    }

    fn opened(self: &Arc<Self>, card: &str) {
        let Some(o) = self.opening.lock().ok().and_then(|mut o| o.remove(card)) else { return };
        let now = self.now();
        let m = self.fleet.lock().ok().and_then(|mut f| f.opened(&o.asked_by, &o.request, card, now));
        if let Some(m) = m {
            self.route(&[m], None);
        }
        let birth = self.store().and_then(|s| s.0.lock().ok().and_then(|c| here::birth_of(&c, card)));
        if let Some(b) = birth {
            let _ = self.app.emit("flyway:born", b);
        }
        self.emit_roster();
    }

    fn failed(self: &Arc<Self>, card: &str, why: &str) {
        let Some(o) = self.opening.lock().ok().and_then(|mut o| o.remove(card)) else { return };
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                here::unrecord_birth(&conn, card);
            }
        }
        let now = self.now();
        let m = self.fleet.lock().ok().and_then(|mut f| f.failed(&o.asked_by, &o.request, why, now));
        if let Some(m) = m {
            self.route(&[m], None);
        }
        self.emit_roster();
    }

    /* ── prompting another wall's card ─────────────────────────────────────── */

    /// Send a prompt to a card on another wall. `Err` is said at once, for
    /// a2a4468e's rule that an unreachable wall is refused now and never queued:
    /// an unknown host, a quiet one, or this wall.
    fn send_prompt(self: &Arc<Self>, r: PromptRequest) -> Result<(), String> {
        self.send_person(Act::Prompt, r)
    }

    /// A person's prompt or close, one path: both are answered through
    /// `flyway:prompt-answer`, keyed on the request id the front end minted.
    fn send_person(self: &Arc<Self>, act: Act, r: PromptRequest) -> Result<(), String> {
        let now = self.now();
        let msg = self
            .fleet
            .lock()
            .map_err(|_| "the fleet is wedged".to_string())?
            .reach(act, r.clone(), now)
            .map_err(|u| u.reason())?;
        let pictured = matches!(msg, FleetMsg::Pictured { .. });
        if let Ok(mut o) = self.prompts_out.lock() {
            o.entry(r.id.clone()).or_insert(PromptOut { to: r.to.clone(), left: false, asked_at: now, pictured });
        }
        if pictured {
            self.push_pictured(r.to, r.id, msg);
        } else {
            self.push(r.to, vec![Frame::Fleet(msg)]);
        }
        Ok(())
    }

    /// Say one prompt with pictures in it to the wall it is for, on an exchange
    /// of its own and with time for its size (`wire::carrying_within`) — never
    /// in a greeting, where megabytes on a slow link would time out the sink and
    /// the cards beside it (`fleet::gossip`). One at a time per prompt: the tick
    /// re-says an unanswered one, and two uploads of the same seven megabytes
    /// would each get half the link. It has left when *this* exchange lands.
    fn push_pictured(self: &Arc<Self>, host: String, id: String, msg: FleetMsg) {
        if host.eq_ignore_ascii_case(&self.me) || self.speaks_older(&host) {
            return;
        }
        let bytes = match &msg {
            FleetMsg::Pictured { ask, .. } => ask.pictures.iter().map(|p| p.data.len()).sum::<usize>() + ask.brief.len(),
            _ => 0,
        };
        let first = self.pictured_out.lock().map(|mut o| o.insert(id.clone())).unwrap_or(false);
        if !first {
            return;
        }
        let l = self.clone();
        tauri::async_runtime::spawn(async move {
            let landed = match l.wire.peer(&host) {
                Ok(peer) => l
                    .wire
                    .exchange_within(peer, vec![Frame::Fleet(msg)], true, super::wire::carrying_within(bytes))
                    .await
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e),
            };
            if let Ok(mut o) = l.pictured_out.lock() {
                o.remove(&id);
            }
            match landed {
                Ok(back) => {
                    l.left_one(&id);
                    l.take(back, Some(&host));
                }
                Err(e) => log::debug!("flyway: a prompt with pictures did not reach {host} (the tick will say it again): {e}"),
            }
        });
    }

    /// One prompt has been written to a connection to the wall it is for.
    fn left_one(&self, id: &str) {
        let left = self
            .prompts_out
            .lock()
            .ok()
            .and_then(|mut o| o.get_mut(id).map(|p| !std::mem::replace(&mut p.left, true)))
            .unwrap_or(false);
        if left {
            let _ = self.app.emit("flyway:prompt-left", PromptLeft { id: id.to_string() });
        }
    }

    /// Every prompt for `host` that had not yet left has now been written to a
    /// connection to it.
    fn left_for(&self, host: &str) {
        let gone: Vec<String> = match self.prompts_out.lock() {
            Ok(mut o) => o
                .iter_mut()
                .filter(|(_, p)| !p.left && !p.pictured && p.to == host)
                .map(|(id, p)| {
                    p.left = true;
                    id.clone()
                })
                .collect(),
            Err(_) => return,
        };
        for id in gone {
            let _ = self.app.emit("flyway:prompt-left", PromptLeft { id });
        }
    }

    /// A request for one of this wall's cards — a prompt, a recall or a close
    /// — that the fleet has found trustworthy. Everything about the *card* is
    /// decided here, in this order, and each step answers the asker if it is
    /// the last:
    ///
    /// 1. **Which card.** The address is resolved against this wall's own
    ///    roster by `relay::resolve`, the one answer to what a handle or a
    ///    title means — so an ambiguous title is refused by name here exactly
    ///    as it is to a `send` on this wall, and nothing the asker wrote is ever
    ///    an id this wall did not mint.
    /// 2. **Whether this asker may.** `fleet::may_reach`, with the two facts
    ///    about this card that only this wall has: who asked for it
    ///    (`flyway_birth`) and whether the asker is a card it opened elsewhere
    ///    (`flyway_child`).
    /// 3. **Doing it.** An answer goes straight into the parked call; an
    ///    agent's message goes in through the relay, in an envelope saying where
    ///    it came from; a person's prompt goes to the front end, which sends it
    ///    as one typed here; a recall reads the transcript off the serving task;
    ///    a close goes through `spawn::close_from_afar`, which keeps the local
    ///    close's refusals.
    fn deliver_here(self: &Arc<Self>, d: Deliver) {
        let now = self.now();
        let host = d.asked_by.host.clone();
        let request = d.request.clone();
        let answer = |l: &Arc<Self>, m: Option<FleetMsg>| {
            if let Some(m) = m {
                l.route(&[m], None);
            }
        };
        let refuse = |l: &Arc<Self>, why: String| {
            let m = l.fleet.lock().ok().and_then(|mut f| f.refused(&host, &request, &why, now));
            answer(l, m);
        };

        let found = self.store().and_then(|store| {
            let conn = store.0.lock().ok()?;
            let rows = crate::store::roster(&conn, None).ok()?;
            let row = match crate::relay::resolve(&rows, &d.card) {
                Ok(row) => row.clone(),
                Err(why) => {
                    let shared = rows.iter().filter(|r| r.title.trim().eq_ignore_ascii_case(d.card.trim())).count() > 1;
                    return Some(Err((why, shared)));
                }
            };
            let born = here::birth_of(&conn, &row.id).map(|b| Origin { host: b.host, card: b.asker_card });
            let replies = d
                .asked_by
                .card
                .as_deref()
                .is_some_and(|c| here::is_child_of(&conn, c, &row.id));
            Some(Ok((row, born, replies)))
        });
        let (row, born, replies) = match found {
            Some(Ok(it)) => it,
            /* Two cards share the title: `resolve`'s own sentence, which names
               them by handle, is the useful answer. Anything else is the card
               not being here, said as the dock has always said it. */
            Some(Err((why, true))) => return refuse(self, format!("{why} — on {}", self.me)),
            Some(Err((_, false))) => {
                return refuse(
                    self,
                    format!(
                        "no card {} is open on {} — it may have been closed since it was drawn there",
                        d.card.trim(),
                        self.me
                    ),
                )
            }
            None => return refuse(self, format!("{} could not read its own wall just then — try again", self.me)),
        };

        /* An answer starts no work here — unless it is a follow-up to a notice,
           which is a message to the card and is held to the switch like any
           prompt (`notice::answer_starts_nothing`). */
        let answering = d.answers.as_deref().is_some_and(|a| crate::notice::answer_starts_nothing(a, &d.text));
        if let Err(refusal) = fleet::may_reach(d.act, &d.asked_by, d.accepting, answering, born.as_ref(), replies) {
            let m = self.fleet.lock().ok().and_then(|mut f| f.refuse(&host, &request, refusal, now));
            return answer(self, m);
        }

        match d.act {
            /* A notice taken down from another wall — acknowledged, or followed
               up. The queue is the front end's to read and Rust's to hold, and
               taking one down is `Skein.acknowledgeNotice`/`followUpNotice`, so
               it goes the way a person's prompt does: to the front end, which
               answers `flyway_prompt_answer`. Only a person's: an agent on
               another wall has no business clearing this wall's queue. */
            Act::Prompt if crate::notice::afar(d.answers.as_deref()).is_some() => {
                if d.asked_by.card.is_some() {
                    return refuse(self, "a notice is taken down by a person, not by another card".into());
                }
                let notice = crate::notice::afar(d.answers.as_deref()).map(str::to_string);
                /* A reply may carry what a prompt may, checked here as a
                   prompt's is. */
                if let Err(why) = crate::attach::carried_fit(&d.pictures, &d.text) {
                    return refuse(self, format!("{} would not take its pictures: {why}", self.me));
                }
                if let Ok(mut p) = self.prompts_in.lock() {
                    p.insert((host.clone(), request.clone()), now);
                }
                let _ = self.app.emit(
                    "flyway:prompt",
                    PromptHere {
                        id: request,
                        from: PromptFrom { host, card: None },
                        card: row.id,
                        text: d.text,
                        notice,
                        pictures: d.pictures,
                        answers: None,
                    },
                );
            }
            /* An answer to a parked question goes straight into the parked call
               — the channel a click in this wall's own dock uses — and is
               answered taken or refused on the spot, with no front end in
               between. */
            /* An answer that carries pictures or files goes the way a person's
               prompt does — to the front end, which fetches the files, cuts
               the sentence as the dock would and answers the parked call
               through `answer_ask` — once this wall has said the question may
               take one. */
            Act::Prompt if d.answers.is_some() && !d.pictures.is_empty() => {
                let ask_id = d.answers.clone().unwrap_or_default();
                if d.asked_by.card.is_some() {
                    return refuse(self, "a question is answered by a person, not by another card".into());
                }
                if let Err(why) = crate::ask::afar_may_attach(&self.app, &row.id, &ask_id)
                    .and_then(|()| crate::attach::carried_fit(&d.pictures, &d.text))
                {
                    return refuse(self, why);
                }
                if let Ok(mut p) = self.prompts_in.lock() {
                    p.insert((host.clone(), request.clone()), now);
                }
                let _ = self.app.emit(
                    "flyway:prompt",
                    PromptHere {
                        id: request,
                        from: PromptFrom { host, card: None },
                        card: row.id,
                        text: d.text,
                        notice: None,
                        pictures: d.pictures,
                        answers: Some(ask_id),
                    },
                );
            }
            Act::Prompt if d.answers.is_some() => {
                let ask_id = d.answers.clone().unwrap_or_default();
                let outcome = crate::ask::answer_from_afar(&self.app, &row.id, &ask_id, &d.text);
                let m = self.fleet.lock().ok().and_then(|mut f| match &outcome {
                    Ok(()) => f.taken(&host, &request, &row.id, now),
                    Err(why) => f.refused(&host, &request, why, now),
                });
                answer(self, m);
            }
            /* From an agent: through the relay, as a `send` on this wall is, so
               a dormant card wakes to read it and the card is marked as acting
               on a message. Never through the front end's `Skein.send`, which
               would echo it as a line the person here typed. */
            Act::Prompt if d.asked_by.card.is_some() => {
                let from = d.asked_by.card.as_deref().unwrap_or_default();
                let text = crate::relay::afar_envelope(&host, from, d.from_title.as_deref(), d.from_project.as_deref(), &d.text);
                let m = match crate::relay::deliver_from_afar(&self.app, &row.id, &text) {
                    Ok(_) => self.fleet.lock().ok().and_then(|mut f| f.taken(&host, &request, &row.id, now)),
                    Err(why) => self.fleet.lock().ok().and_then(|mut f| f.refused(&host, &request, &why, now)),
                };
                answer(self, m);
            }
            /* From a person at another wall's dock: the front end sends it as
               though typed here, introduced, and answers `flyway_prompt_answer`.
               Its pictures are checked again here, on the machine whose card
               would be handed them — the sender's check is a claim, and these
               bytes go into a `src=` and a request (`attach::carried_fit`). */
            Act::Prompt => {
                if let Err(why) = crate::attach::carried_fit(&d.pictures, &d.text) {
                    return refuse(self, format!("{} would not take its pictures: {why}", self.me));
                }
                if let Ok(mut p) = self.prompts_in.lock() {
                    p.insert((host.clone(), request.clone()), now);
                }
                let _ = self.app.emit(
                    "flyway:prompt",
                    PromptHere {
                        id: request,
                        from: PromptFrom { host, card: d.asked_by.card },
                        card: row.id,
                        text: d.text,
                        notice: None,
                        pictures: d.pictures,
                        answers: None,
                    },
                );
            }
            /* A transcript read is a file read, up to eight megabytes of it, and
               this is the serving task — so it goes where blocking work goes,
               and answers when it is done. */
            Act::Recall => {
                let l = self.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let read = crate::relay::said_by(&l.app, &row);
                    let now = l.now();
                    let m = l.fleet.lock().ok().and_then(|mut f| match read {
                        Ok(said) => f.said(&host, &request, &row.id, &row.title, said, now),
                        Err(why) => f.refused(&host, &request, &why, now),
                    });
                    if let Some(m) = m {
                        l.route(&[m], None);
                    }
                });
            }
            Act::Close => {
                let m = match crate::spawn::close_from_afar(&self.app, &row, &host, d.asked_by.card.is_none()) {
                    Ok(()) => self.fleet.lock().ok().and_then(|mut f| f.taken(&host, &request, &row.id, now)),
                    Err(why) => self.fleet.lock().ok().and_then(|mut f| f.refused(&host, &request, &why, now)),
                };
                answer(self, m);
            }
        }
    }

    /// The front end's report on a prompt it was handed: taken, or why not.
    fn prompt_settled(self: &Arc<Self>, asked_by: &str, request: &str, outcome: Result<String, String>) {
        let was = self
            .prompts_in
            .lock()
            .ok()
            .and_then(|mut p| p.remove(&(asked_by.to_string(), request.to_string())));
        if was.is_none() {
            return;
        }
        let now = self.now();
        let m = self.fleet.lock().ok().and_then(|mut f| match &outcome {
            Ok(card) => f.taken(asked_by, request, card, now),
            Err(why) => f.refused(asked_by, request, why, now),
        });
        if let Some(m) = m {
            self.route(&[m], None);
        }
    }

    /* ── a card's conversation, read from another wall ─────────────────────── */

    /// Make one of this wall's cards' tails for a wall that asked, by asking
    /// this wall's front end — the only thing that can, since what a line is
    /// is `classify.ts`'s. Parked as `ask.rs` parks a `tools/call`: a channel
    /// under a fresh id, an event carrying it, and `flyway_tail_answer`
    /// handing the answer back by that id.
    ///
    /// **Not gated by "take work from other walls".** That switch is about
    /// *starting* work, and reading a transcript starts nothing; gating it
    /// would be a wall whose cards you can see and not read — the argument
    /// that already lets an answer to a parked question through.
    async fn tail_here(self: &Arc<Self>, id: String, card: String) -> TailMsg {
        let card: String = crate::clean::scrub(card.trim()).chars().take(80).collect();
        let said = |lines: Option<Value>, why: Option<String>| TailMsg::Tailed {
            id: id.clone(),
            card: card.clone(),
            lines,
            why,
        };
        if card.is_empty() {
            return said(None, Some("no card was named".into()));
        }
        let local = crate::store::uuid_v4();
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut t) = self.tails.lock() {
            t.insert(local.clone(), tx);
        }
        let _ = self.app.emit("flyway:tail", TailHere { id: local.clone(), card: card.clone() });
        let got = tokio::time::timeout(TAIL_WITHIN, rx).await;
        /* Whatever happened, the slot is this call's to clear: an answer has
           taken it already, and a timeout leaves it behind. */
        if let Ok(mut t) = self.tails.lock() {
            t.remove(&local);
        }
        match got {
            /* Bounded on the way out as well as on the way in: the front end
               caps it, and this is the wall's own last word on what leaves. */
            Ok(Ok(Ok(lines))) => match tail::fit(lines) {
                Some(lines) => said(Some(lines), None),
                None => said(None, Some(format!("{} made something that is not a conversation", self.me))),
            },
            Ok(Ok(Err(why))) => said(None, Some(why)),
            Ok(Err(_)) | Err(_) => said(
                None,
                Some(format!("{} did not read that card's conversation in time — try opening it again", self.me)),
            ),
        }
    }

    /// The front end's answer to a `flyway:tail`.
    fn tail_answered(&self, id: &str, answer: Result<Value, String>) -> Result<(), String> {
        let tx = self
            .tails
            .lock()
            .map_err(|_| "the flyway is wedged".to_string())?
            .remove(id)
            .ok_or("nobody is waiting for that conversation any more")?;
        tx.send(answer).map_err(|_| "the wall that asked has stopped waiting".to_string())
    }

    /// Whether a tail could be asked of `host` at all — said at once, before
    /// anything is dialled, for a2a4468e's rule that a wall which cannot answer
    /// is told so now and never waited on. Unknown, quiet and too old are the
    /// three the roster can already see.
    fn tail_reachable(&self, host: &str) -> Result<(), String> {
        self.reachable(
            host,
            tail::WORD,
            "cannot show its cards' conversations to another wall — update it, or read the card there",
        )
    }

    /// Whether `host` can be asked a reading it announces `word` for — said at
    /// once, never waited on. `older` finishes "{host} runs an older Volery,
    /// which …".
    fn reachable(&self, host: &str, word: &str, older: &str) -> Result<(), String> {
        if host.eq_ignore_ascii_case(&self.me) {
            return Err("that card is on this wall".into());
        }
        let now = self.now();
        let f = self.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?;
        let Some(e) = f.entry(host) else {
            let known: Vec<String> = f.roster().filter(|e| e.host != self.me).map(|e| e.host.clone()).collect();
            return Err(fleet::Unsendable::UnknownHost { host: host.into(), known }.reason());
        };
        let quiet = e.quiet_for(now);
        if quiet > fleet::QUIET_AFTER_MS as u64 {
            return Err(fleet::Unsendable::Quiet { host: host.into(), for_ms: quiet }.reason());
        }
        let can = e.facts.can.iter().any(|c| c == word);
        drop(f);
        if !can || self.speaks_older(host) {
            return Err(format!("{host} runs an older Volery, which {older}"));
        }
        Ok(())
    }

    /// Ask `host` for one card's tail, and keep the answer out of the same
    /// exchange — with the id it was asked under. Everything else the far wall
    /// says back, its cards most often, is folded in as any answer is.
    async fn read_tail(self: &Arc<Self>, host: &str, card: &str) -> Result<(String, Vec<TailMsg>), String> {
        let peer = self.wire.peer(host)?;
        let id = crate::store::uuid_v4();
        let ask = Frame::Tail(TailMsg::Tail { id: id.clone(), card: card.to_string() });
        /* Neither outcome touches `failing`. That is the tick's backoff, and a
           read that ran long — a slow relay, a far front end reading a large
           scrollback off disk — is not a wall asleep; marking it would make
           reading a transcript decide when the two walls next sync. */
        let back = self
            .wire
            .exchange(peer, vec![ask], true)
            .await
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let mut tails = Vec::new();
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::Tail(m) => tails.push(m),
                other => rest.push(other),
            }
        }
        self.take(rest, Some(host));
        Ok((id, tails))
    }

    /* ── a person's gesture on a card here, from another wall ───────────────── */

    /// Do `verb` to one of this wall's cards for a person at another wall, by
    /// asking this wall's front end — which runs the same `Skein` calls its own
    /// menu does — parked as `tail_here` is. Gated first, here, on this wall's
    /// switch read fresh (`act::gate`), so a refusal costs the front end
    /// nothing. `None` for an id that is not one this app minted: there is no
    /// question to answer.
    async fn act_here(
        self: &Arc<Self>,
        id: String,
        card: String,
        verb: String,
        args: Value,
        from_card: Option<String>,
        from: Option<&str>,
    ) -> Option<ActMsg> {
        if !act::is_id(&id) {
            return None;
        }
        let said = |r: Result<Option<String>, String>| Some(act::acted(&id, r));
        if !act::is_id(&card) {
            return said(Err("no card was named".into()));
        }
        let Some(host) = from else {
            return said(Err(format!(
                "{} could not tell which wall asked — it may not have heard from yours yet; try again in a minute",
                self.me
            )));
        };
        let accepting = self.store().and_then(|s| s.0.lock().ok().map(|c| here::accepting(&c))).unwrap_or(false);
        if let Err(why) = act::gate(&verb, from_card.as_deref(), accepting, &self.me) {
            return said(Err(why));
        }
        let args = match act::read_args(&verb, &args) {
            Ok(a) => a,
            Err(why) => return said(Err(why)),
        };
        let local = crate::store::uuid_v4();
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut t) = self.acts.lock() {
            t.insert(local.clone(), tx);
        }
        let _ = self.app.emit(
            "flyway:act",
            ActHere { id: local.clone(), host: act::fit_text(host, 120), card, verb, args },
        );
        let got = tokio::time::timeout(ACT_WITHIN, rx).await;
        /* The slot is this call's to clear, for `tail_here`'s reason. */
        if let Ok(mut t) = self.acts.lock() {
            t.remove(&local);
        }
        said(match got {
            Ok(Ok(r)) => r,
            Ok(Err(_)) | Err(_) => Err(format!(
                "{} did not say in time whether it did that — look at the card before asking again",
                self.me
            )),
        })
    }

    /// The front end's answer to a `flyway:act`.
    fn act_answered(&self, id: &str, answer: Result<Option<String>, String>) -> Result<(), String> {
        let tx = self
            .acts
            .lock()
            .map_err(|_| "the flyway is wedged".to_string())?
            .remove(id)
            .ok_or("nobody is waiting for that any more")?;
        tx.send(answer).map_err(|_| "the wall that asked has stopped waiting".to_string())
    }

    /// Whether `verb` could be asked of `host` at all — unknown, quiet, too old
    /// to know the verb, and for a work verb a wall that last said it takes no
    /// work. Said at once; never waited on and never queued.
    fn act_reachable(&self, host: &str, verb: &str) -> Result<(), String> {
        let Some(c) = act::cost(verb) else {
            return Err(format!("that cannot be asked of a card on {host}"));
        };
        self.reachable(
            host,
            &format!("{}{verb}", act::PREFIX),
            "cannot do that to its cards from another wall — update it, or do it there",
        )?;
        /* The owner decides again on its own switch read fresh; this is the
           same answer given before anything leaves, off what it last said. */
        if c == act::Cost::Work {
            let accepting =
                self.fleet.lock().ok().and_then(|f| f.entry(host).map(|e| e.facts.accepting)).unwrap_or(false);
            /* `act::gate`'s sentence rather than the fleet's, whose tail —
               ask another wall with this territory — is about a spawn. */
            if !accepting {
                return act::gate(verb, None, false, host).map(|_| ());
            }
        }
        Ok(())
    }

    /// Ask `host` to do `verb` to one card, and read the answer out of the same
    /// exchange. Never touches `failing`, for `read_tail`'s reason.
    async fn read_act(self: &Arc<Self>, host: &str, card: &str, verb: &str, args: Value) -> Result<Option<String>, String> {
        let peer = self.wire.peer(host)?;
        let id = crate::store::uuid_v4();
        let ask = Frame::Act(ActMsg::Act {
            id: id.clone(),
            card: card.to_string(),
            verb: verb.to_string(),
            args,
            from_card: None,
        });
        let back = self
            .wire
            .exchange(peer, vec![ask], true)
            .await
            /* Not "nothing was done": the exchange can fail after the far wall
               has read the act — its front end takes up to `ACT_WITHIN` of
               the asker's twenty seconds, and a slow dial eats the rest — so a
               fault here cannot tell an act never sent from one done unheard. */
            .map_err(|e| {
                format!("did not hear back from {host} ({e}) — it may or may not have done it; look at the card before asking again")
            })?;
        let mut acts = Vec::new();
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::Act(m) => acts.push(m),
                other => rest.push(other),
            }
        }
        self.take(rest, Some(host));
        act::answer_in(&acts, &id, host)
    }

    /* ── what a question asked here shows, for another wall ─────────────────── */

    /// One answer to a `look`: the parked call's arguments as `ask.rs` holds
    /// them, and its files' bytes off this disk. Synchronous, like a move's
    /// part — an answer reads at most `look::BUDGET` of file, which is a disk
    /// read rather than a wait on anything.
    fn look_here(&self, id: &str, card: &str, ask: &str, want: &[look::Want]) -> LookMsg {
        /* A stage is a prompt's files this wall is holding for the card's own
           wall to pull (`attachments::stage_outbound`), served exactly as a
           question's files are. */
        let args = if ask.trim().starts_with("stage-") {
            crate::attachments::outbound_args(card.trim(), ask.trim())
        } else {
            crate::ask::args_for_afar(&self.app, card.trim(), ask.trim())
        };
        match args {
            Ok(args) => look::answer(id, &self.me, &args, want, &mut Disk),
            Err(why) => LookMsg::Looked { id: id.to_string(), args: None, files: vec![], parts: vec![], why: Some(why) },
        }
    }

    /// Pull one parked question from `host`, every file whole — or as far as
    /// it got, each file that did not finish saying why. As many exchanges as
    /// the files need (`look.rs`), none of them touching the tick's backoff,
    /// for `read_tail`'s reason.
    async fn read_look(self: &Arc<Self>, host: &str, card: &str, ask: &str) -> Result<look::Gathering, String> {
        let peer = self.wire.peer(host)?;
        let mut g = look::Gathering::default();
        let mut want = Vec::new();
        let mut idle = 0;
        for round in 0..look::ROUNDS_MOST {
            let id = crate::store::uuid_v4();
            let m = LookMsg::Look { id: id.clone(), card: card.to_string(), ask: ask.to_string(), want: want.clone() };
            let back = match self.wire.exchange(peer, vec![Frame::Look(m)], true).await {
                Ok(b) => b,
                /* The first is the question failing; a later one is a file
                   that stopped arriving, and what arrived is still worth
                   drawing. */
                Err(e) if round == 0 => return Err(format!("could not reach {host}: {e}")),
                Err(e) => {
                    g.give_up(&format!("{host} stopped answering while it was being carried ({e})"));
                    return Ok(g);
                }
            };
            let mut looks = Vec::new();
            let mut rest = Vec::new();
            for f in back {
                match f {
                    Frame::Look(m) => looks.push(m),
                    other => rest.push(other),
                }
            }
            self.take(rest, Some(host));
            let Some(answer) = look::answer_in(looks, &id) else {
                if round == 0 {
                    return Err(format!("{host} did not answer for what that question shows"));
                }
                g.give_up(&format!("{host} stopped answering while it was being carried"));
                return Ok(g);
            };
            /* A reason mid-way is the question answered or run out over there
               while its files were crossing: nothing is left to draw it for. */
            idle = if g.take(answer, host)? { 0 } else { idle + 1 };
            want = g.wants();
            if want.is_empty() {
                return Ok(g);
            }
            if idle >= 2 {
                g.give_up(&format!("{host} stopped sending it"));
                return Ok(g);
            }
        }
        g.give_up("it took more exchanges than any file should");
        Ok(g)
    }

    /* ── the cards ─────────────────────────────────────────────────────────── */

    fn publish_cards(self: &Arc<Self>, snapshot: Value) -> Result<(), String> {
        let now = self.now();
        let version = {
            let mut c = self.cards.lock().map_err(|_| "the cards are wedged".to_string())?;
            c.publish(snapshot, now)?;
            c.version()
        };
        if let Some(store) = self.store() {
            if let Ok(conn) = store.0.lock() {
                let _ = here::set_setting(&conn, here::CARDS_VERSION, &version.to_string());
            }
        }
        /* Coalesced: one push in flight, carrying whatever is newest when it
           goes. See `CARDS_EVERY`. */
        if self.cards_due.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let l = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CARDS_EVERY).await;
            l.cards_due.store(false, Ordering::Release);
            let Some(m) = l.cards.lock().ok().and_then(|c| c.say(l.now())) else { return };
            for host in l.known_current() {
                l.push(host, vec![Frame::Cards(m.clone())]);
            }
        });
        Ok(())
    }

    /// Walls on the roster that speak the current language and are not quiet.
    fn known_current(&self) -> Vec<String> {
        let now = self.now();
        let hosts: Vec<String> = self
            .fleet
            .lock()
            .map(|f| {
                f.roster()
                    .filter(|e| e.host != self.me && e.quiet_for(now) <= fleet::QUIET_AFTER_MS as u64)
                    .map(|e| e.host.clone())
                    .collect()
            })
            .unwrap_or_default();
        hosts.into_iter().filter(|h| !self.speaks_older(h)).collect()
    }

    fn emit_cards(&self, a: Arrived) {
        let quiet = self.fleet.lock().ok().and_then(|f| f.entry(&a.host).map(|e| e.quiet_for(self.now())));
        let _ = self.app.emit(
            "flyway:cards",
            RemoteCards { host: a.host, age_ms: a.age_ms, quiet_ms: quiet, snapshot: a.snapshot },
        );
    }

    fn remote_cards(&self) -> Vec<RemoteCards> {
        let now = self.now();
        let all = self.cards.lock().map(|c| c.theirs(now)).unwrap_or_default();
        let f = self.fleet.lock().ok();
        all.into_iter()
            .map(|a| RemoteCards {
                quiet_ms: f.as_ref().and_then(|f| f.entry(&a.host).map(|e| e.quiet_for(now))),
                host: a.host,
                age_ms: a.age_ms,
                snapshot: a.snapshot,
            })
            .collect()
    }

    /* ── the roster, as the panel and the cards read it ────────────────────── */

    fn roster(&self) -> Vec<RosterRow> {
        let now = self.now();
        let older = self.older.lock().map(|o| o.clone()).unwrap_or_default();
        let Ok(f) = self.fleet.lock() else { return Vec::new() };
        f.roster()
            .map(|e| {
                let (standing, reason) = match e.standing(now) {
                    Standing::Open => ("open", None),
                    Standing::Closed => ("closed", Some(fleet::Refusal::NotAccepting.reason(&e.host))),
                    Standing::Full(r) => ("full", Some(r.reason(&e.host))),
                    Standing::Quiet { .. } => ("quiet", None),
                };
                RosterRow {
                    host: e.host.clone(),
                    me: e.host == self.me,
                    quiet_ms: e.quiet_for(now),
                    standing,
                    reason,
                    cards_live: e.facts.cards_live,
                    cards_working: e.facts.cards_working,
                    allowance_used: e.facts.allowance_used,
                    territories: e.facts.territories.iter().map(|t| t.name.clone()).collect(),
                    older: older.get(&e.host).is_some_and(|until| now < *until),
                    acts: act::offered(&e.facts.can),
                    closes: e.facts.can.iter().any(|c| c == fleet::CAN_PERSON_CLOSE),
                    opens: e.facts.can.iter().any(|c| c == super::opening::WORD),
                    pictures: e.facts.can.iter().any(|c| c == fleet::CAN_PICTURES),
                    files: e.facts.can.iter().any(|c| c == crate::attachments::CAN_FILES),
                    rate: e.facts.rate,
                    wants_rate: e.facts.wants_rate,
                }
            })
            .collect()
    }

    /// Every wall on the roster with its latest cards, for the `walls` tool.
    /// The standing is the roster's own word, so an agent and the flyway
    /// panel are told the same thing about a wall.
    pub fn walls_seen(&self) -> Vec<super::reach::WallSeen> {
        let now = self.now();
        let snapshots: BTreeMap<String, Value> = self
            .cards
            .lock()
            .map(|c| c.theirs(now).into_iter().map(|a| (a.host, a.snapshot)).collect())
            .unwrap_or_default();
        let Ok(f) = self.fleet.lock() else { return Vec::new() };
        f.roster()
            .map(|e| super::reach::WallSeen {
                host: e.host.clone(),
                standing: match e.standing(now) {
                    Standing::Open => "open",
                    Standing::Closed => "closed",
                    Standing::Full(_) => "full",
                    Standing::Quiet { .. } => "quiet",
                },
                quiet_ms: e.quiet_for(now),
                accepting: e.facts.accepting,
                territories: e.facts.territories.iter().map(|t| t.name.clone()).collect(),
                cards_live: e.facts.cards_live,
                cards_working: e.facts.cards_working,
                can: e.facts.can.clone(),
                holds: e.facts.holds.clone(),
                lacks: e.facts.lacks.clone(),
                snapshot: snapshots.get(&e.host).cloned(),
            })
            .collect()
    }

    fn emit_roster(&self) {
        let _ = self.app.emit("flyway:roster", self.roster());
    }

    /// The roster entry for a host, for the asking side to resolve a
    /// territory against.
    pub fn territories_of(&self, host: &str) -> Option<Vec<fleet::Territory>> {
        self.fleet.lock().ok()?.entry(host).map(|e| e.facts.territories.clone())
    }

    pub fn me(&self) -> &str {
        &self.me
    }

    /// Whether the person is at another wall right now — `fleet::present_elsewhere`
    /// over the roster as it stands.
    pub fn present_elsewhere(&self) -> bool {
        let now = self.now();
        self.fleet.lock().map(|f| fleet::present_elsewhere(f.roster(), &self.me, now)).unwrap_or(false)
    }

    pub fn known_hosts(&self) -> Vec<String> {
        self.fleet
            .lock()
            .map(|f| f.roster().filter(|e| e.host != self.me).map(|e| e.host.clone()).collect())
            .unwrap_or_default()
    }
}

/// The sentence the asking card reads.
fn receipt(a: &Answer, w: &Waiter, me: &str) -> String {
    match &a.outcome {
        Outcome::Opened { card } => {
            let handle = crate::relay::handle_of(card);
            let mut called = match &w.title {
                Some(t) => format!(" It is called {t:?} until it names itself."),
                None => String::new(),
            };
            if let Some(n) = &w.note {
                called.push_str(&format!("\n\n{n}"));
            }
            format!(
                "{by} opened a card in its {territory} territory — its handle there is {handle}. It \
                 runs on that machine, not this one, and it is not in this wall's \
                 `mcp__skein__list`, but its handle reaches it from here as a card's on this wall does: \
                 `mcp__skein__recall` to read what it has said and `mcp__skein__close` when it is \
                 done, both yours whatever {by} is set to; `mcp__skein__send` to tell it more, \
                 which needs {by} still taking work from other walls. It has the brief you wrote \
                 and nothing else of yours, and it was told it was opened from {me} by you, so it \
                 can report back — this wall lets that report through even while it takes no \
                 work from other walls. Tell the user you have opened it, on which machine, and \
                 what for.{called}",
                by = a.by,
                territory = w.territory,
            )
        }
        Outcome::Refused { refusal } => format!("no card was opened: {}", refusal.reason(&a.by)),
        /* Never the answer to a spawn; said rather than unreachable, since a
           confused far wall is not a reason to panic here. */
        Outcome::Said { .. } => format!("{} answered the ask with something that is not a card — nothing was opened that this wall knows of", a.by),
    }
}

/// The sentence an agent reads when a send, a recall or a close comes back.
fn reached(a: &Answer, w: &Waiter) -> String {
    let by = &a.by;
    let there = w.there.as_deref().unwrap_or("that card");
    /* The switch's own sentence is about opening a card in a territory; here it
       is about reaching into one that is already open, and the exception the
       gate makes is worth saying, since it is the thing an orchestrator can do
       about it. */
    if let Outcome::Refused { refusal: Refusal::NotAccepting } = &a.outcome {
        return format!(
            "{by} is not taking work from other walls, so {there} was not reached — while that is \
             switched off, {by} lets in only answers to a card's own questions, a card's report to \
             the card that opened it, and the card that opened one reading or closing it. Ask the \
             user to switch it on in the flyway panel on {by} if this should go through."
        );
    }
    match (&a.outcome, w.wants) {
        (Outcome::Refused { refusal }, Wants::Send) => {
            format!("not delivered to {there} on {by}: {}", prompt_why(refusal, by))
        }
        (Outcome::Refused { refusal }, Wants::Recall) => {
            format!("nothing was read from {there} on {by}: {}", prompt_why(refusal, by))
        }
        (Outcome::Refused { refusal }, _) => {
            format!("{there} on {by} was not closed: {}", prompt_why(refusal, by))
        }
        (Outcome::Said { card, title, said }, _) => crate::relay::recalled(title, card, Some(by.as_str()), said),
        (Outcome::Opened { card }, Wants::Close) => format!(
            "{by} is taking {} off its wall. Its transcript stays on {by} and the session can be \
             adopted back there, so this is the card going away rather than the work. Tell the user \
             which one you closed, on which machine, and what it finished.",
            crate::relay::handle_of(card)
        ),
        (Outcome::Opened { card }, _) => format!(
            "delivered to {} on {by} — that card has it, or, if it was asleep, is being woken and \
             will read this first. Neither is it having answered: a reply comes back as a message \
             from it, if one is needed.",
            crate::relay::handle_of(card)
        ),
    }
}

/// Why a prompt was refused, as the person who sent it reads it. The far
/// wall's own sentence where it wrote one; the ask's wording otherwise, which
/// is already about the wall rather than about opening anything.
fn prompt_why(r: &Refusal, by: &str) -> String {
    match r {
        Refusal::CouldNotStart { reason } => reason.clone(),
        other => other.reason(by),
    }
}

/// This machine's disk, as a `look` answer reads it: one named file in a
/// directory, from an offset, never more than asked.
struct Disk;

impl look::Disk for Disk {
    fn size(&mut self, root: &str, name: &str) -> Result<(u64, Option<u64>), String> {
        let m = std::fs::metadata(std::path::Path::new(root).join(name)).map_err(|e| e.to_string())?;
        if !m.is_file() {
            return Err("it is not a file any more".into());
        }
        let stamp = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        Ok((m.len(), stamp))
    }

    fn read(&mut self, root: &str, name: &str, from: u64, most: usize) -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(std::path::Path::new(root).join(name)).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(most);
        f.take(most as u64).read_to_end(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    }
}

/// Where a question pulled from another wall keeps its files: under this
/// wall's own data folder, a folder per wall and per question, so taking one
/// away is one `remove_dir_all` and two walls' questions cannot meet.
fn look_dir(app: &AppHandle, host: &str, ask: &str) -> Result<std::path::PathBuf, String> {
    let plain = |s: &str| -> String {
        let p: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
        if p.is_empty() { "_".into() } else { p }
    };
    Ok(looks_root(app)?.join(plain(host)).join(plain(ask)))
}

fn looks_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("afar-asks"))
}

/// Take away what questions from other walls left behind. A question's own
/// folder goes when its sheet does (`flyway_look_forget`); this is for the ones
/// nothing got to. At launch (`all`) everything goes, since a sheet lives in
/// memory and none survives a restart — a question still standing is pulled
/// afresh. During a pull, only what is more than a day old.
fn sweep_looks(app: &AppHandle, all: bool) {
    let Ok(root) = looks_root(app) else { return };
    if all {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let Ok(hosts) = std::fs::read_dir(&root) else { return };
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for host in hosts.flatten() {
        let Ok(asks) = std::fs::read_dir(host.path()) else { continue };
        for ask in asks.flatten() {
            let old = ask.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
            if old {
                let _ = std::fs::remove_dir_all(ask.path());
            }
        }
    }
}

/* ── what crosses to the front end ─────────────────────────────────────────── */

/// A conversation another wall asked for, as this wall's front end is handed
/// the question. `id` is minted here; see `Link::tails`.
#[derive(Serialize, Clone)]
struct TailHere {
    id: String,
    card: String,
}

/// A person's gesture from another wall, as this wall's front end is handed
/// it: already gated, its arguments already read into the verb's own shape
/// (`act::read_args`). `id` is minted here; see `Link::acts`.
#[derive(Serialize, Clone)]
struct ActHere {
    id: String,
    host: String,
    card: String,
    verb: String,
    args: Value,
}

#[derive(Serialize, Clone)]
struct PromptLeft {
    id: String,
}

/// How a person's `flyway_open` ended: `opened` with the card's id on that
/// wall, or `refused` with the reason in a person's words.
#[derive(Serialize, Clone)]
struct OpenedThere {
    id: String,
    host: String,
    outcome: &'static str,
    card: Option<String>,
    why: Option<String>,
}

#[derive(Serialize, Clone)]
struct PromptAnswered {
    id: String,
    by: String,
    /// `taken` — the owning wall handed it to the card's send path, which is
    /// not the agent having answered — or `refused`.
    outcome: &'static str,
    why: Option<String>,
}

#[derive(Serialize, Clone)]
struct PromptFrom {
    host: String,
    card: Option<String>,
}

#[derive(Serialize, Clone)]
struct PromptHere {
    id: String,
    from: PromptFrom,
    card: String,
    text: String,
    /// The notice this takes down, when it is an acknowledgement or a
    /// follow-up from another wall rather than a prompt (`notice::afar`).
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
    /// What it carries besides its words, already checked here
    /// (`attach::carried_fit`) — the front end decodes each again and attaches
    /// it exactly as a paste in its own dock is (`Attachments.fromCarried`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pictures: Vec<fleet::Picture>,
    /// The parked question this answers, when the answer carries pictures or
    /// files: the front end fetches and cuts it as it would a prompt, then
    /// answers the question through `answer_ask` (`ask::afar_may_attach`).
    #[serde(skip_serializing_if = "Option::is_none")]
    answers: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SpawnHere {
    /// The id the wall must use, so the answer that goes back names the card
    /// that appears.
    id: String,
    /// The territory's root on *this* wall — never a path the asker wrote.
    cwd: String,
    prompt: String,
    title: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    from_host: String,
    from_card: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCards {
    host: String,
    /// Since the owning wall's front end published it. See `cards.rs`.
    age_ms: u64,
    /// Since that wall was last heard from at all, or `None` if the roster has
    /// never heard it — which is not the same as quiet.
    quiet_ms: Option<u64>,
    snapshot: Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RosterRow {
    host: String,
    me: bool,
    quiet_ms: u64,
    /// `open`, `full`, `closed` or `quiet` — `Standing`, kept apart for its
    /// reason: a wall that stopped talking and one that said it is busy want
    /// different things from a person.
    standing: &'static str,
    /// What an ask would be told, word for word.
    reason: Option<String>,
    cards_live: u32,
    cards_working: u32,
    allowance_used: Option<u8>,
    territories: Vec<String>,
    /// Answered a dial only in the old language — syncing the sink, and
    /// nothing else, until it updates.
    older: bool,
    /// The verbs a person here may ask of its cards (`act::offered`) — what
    /// `handle.ts::verbsFor` reads as `Remote.acts`.
    acts: Vec<String>,
    /// It announced `close_by_person` — `Remote.closes`.
    closes: bool,
    /// It announced `pictures` — `Remote.pictures`: a person's prompt to one
    /// of its cards may carry them.
    pictures: bool,
    /// It announced `files` — `Remote.files`: it pulls a prompt's files from
    /// the wall that sent them (`flyway_fetch`).
    files: bool,
    /// It opens a card a person here asks for with no brief
    /// (`opening::WORD`) — what a section's menu reads to offer one.
    opens: bool,
    /// Its burn rate, tokens per minute (`Facts::rate`), or none said.
    rate: Option<u64>,
    /// Somebody there is looking at a burn rate (`Facts::wants_rate`).
    wants_rate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    accepting: bool,
    bound_live: Option<u32>,
    bound_hour: Option<u32>,
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/// Bring the link up now — called after a key is entered, so joining a flyway
/// does not need a restart to take effect.
#[tauri::command]
pub async fn flyway_arrive(app: AppHandle) -> Result<bool, String> {
    arrive(app).await
}

/// Leave the flyway, now: say goodbye to every wall, stop dialling and
/// answering, close the endpoint, and clear the key. See `leaving.rs`. The
/// command is `key::flyway_leave`, which is where it has always been registered.
pub async fn leave(app: AppHandle) -> Result<(), String> {
    leaving::leave(app).await
}

/// Ask the others now rather than at the next tick, and say how much was news.
#[tauri::command]
pub async fn flyway_pull(app: AppHandle) -> Result<usize, String> {
    pull(app).await
}

/// Whether the link is up, which is a different question from whether a key is
/// held: a wall with a key whose endpoint could not bind is a wall that will
/// sync nothing, and the two must not look alike.
#[tauri::command]
pub fn flyway_linked(app: AppHandle) -> bool {
    current(&app).is_some()
}

/// Every wall this one knows, itself included once it has announced.
#[tauri::command]
pub fn flyway_roster(app: AppHandle) -> Vec<RosterRow> {
    current(&app).map(|l| l.roster()).unwrap_or_default()
}

/// This wall's burn rate and whether anyone here is reading it, for the next
/// announcement (`Facts::rate`). Noted by the front end, which is where the
/// transcripts are read into a rate; a wall not on a flyway drops it. Its own
/// mutex, held for an assignment, so nothing here waits on the main thread.
#[tauri::command]
pub fn flyway_note_rate(app: AppHandle, rate: Option<u64>, wants: bool) {
    if let Some(l) = current(&app) {
        if let Ok(mut r) = l.rate.lock() {
            *r = (rate, wants);
        }
    }
}

/// Take a wall off the roster.
///
/// **Only a wall that has gone quiet**, and the bound is the whole of what
/// makes this honest rather than a hiding place. `Fleet::forget` holds against
/// *gossip* — a peer's stale copy of a forgotten wall does not bring it back —
/// but it cannot hold against the wall itself, which re-announces on its own
/// tick. So offering it for a live wall would be a button that appears to work
/// and silently undoes itself within thirty seconds, which is worse than no
/// button: the roster's whole value is that every row on it means something,
/// and a row you removed that came back means less than one you never touched.
///
/// What it is actually for is the machine that is *gone* — a laptop retired, a
/// lab torn down. Lyss's roster had accumulated `lab`, `lab2`, `lab-a` and
/// `lab-b` from a day's testing, none of which will ever speak again, and until
/// now there was no way to clear one: `Fleet::forget` existed, was tested, and
/// had no caller.
///
/// A forgotten wall that *does* come back is simply learned again, which is
/// right. Nothing here is a ban.
#[tauri::command]
pub async fn flyway_forget(app: AppHandle, host: String) -> Result<(), String> {
    let Some(link) = current(&app) else {
        return Err("this wall is not on a flyway".to_string());
    };
    let host = crate::clip::keep(host.trim(), 40).kept;
    if host.is_empty() {
        return Err("no wall was named".to_string());
    }
    let now = link.now();
    {
        let mut f = link.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?;
        let Some(e) = f.entry(&host) else {
            return Err(format!("{host} is not on this wall's roster"));
        };
        /* The quiet bound, read off the same `Standing` the panel draws from,
           so the button and the refusal can never disagree about which walls
           it is offered for. */
        if !matches!(e.standing(now), Standing::Quiet { .. }) {
            return Err(format!(
                "{host} is still being heard from — a wall takes itself back onto the roster \
                 the moment it announces, so forgetting one that is up would undo itself. \
                 Close volery there first, or wait until it has gone quiet."
            ));
        }
        f.forget(&host);
    }
    /* Its notices go with it — a wall nobody will hear from again has nobody
       to take them down — and so do its cards, which this used to leave in the
       link and on the wall as shadows of a wall that was no longer there. */
    link.drop_wall(&host, false);
    crate::chronicle::note(
        &app,
        None,
        "volery",
        "note",
        &format!("{host} was taken off the roster"),
        "the flyway",
    );
    let _ = app.emit("flyway:roster", link.roster());
    Ok(())
}

/// Whether this wall takes work from other walls, and its bounds.
#[tauri::command]
pub async fn flyway_setup(app: AppHandle) -> Result<Setup, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let b = here::bound(&conn);
        Ok(Setup { accepting: here::accepting(&conn), bound_live: b.live, bound_hour: b.per_hour })
    })
    .await?
}

/// A person's switch. Announced at once, because "switch it on, then ask from
/// the other machine" is the gesture, and a wall that went on reading as
/// closed for half a minute would be a switch that seemed not to work.
#[tauri::command]
pub async fn flyway_set_accepting(app: AppHandle, on: bool) -> Result<(), String> {
    {
        let a = app.clone();
        crate::off_main(move || {
            let store = a.state::<Store>();
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            here::set_setting(&conn, here::ACCEPTING, if on { "1" } else { "0" })
        })
        .await??;
    }
    crate::chronicle::note(
        &app,
        None,
        "volery",
        "note",
        if on { "this wall now takes work from other walls" } else { "this wall stopped taking work from other walls" },
        "the flyway switch",
    );
    /* Not awaited: a tick dials every peer, and a sleeping one holds it for
       the exchange's whole timeout — the switch must not. */
    tauri::async_runtime::spawn(pull(app));
    Ok(())
}

/// This wall's own bounds on arriving work; `None` for none.
#[tauri::command]
pub async fn flyway_set_bound(app: AppHandle, live: Option<u32>, per_hour: Option<u32>) -> Result<(), String> {
    {
        let a = app.clone();
        crate::off_main(move || {
            let store = a.state::<Store>();
            let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
            for (k, v) in [(here::BOUND_LIVE, live), (here::BOUND_HOUR, per_hour)] {
                match v {
                    Some(n) => here::set_setting(&conn, k, &n.to_string())?,
                    None => here::clear_setting(&conn, k)?,
                }
            }
            Ok::<(), String>(())
        })
        .await??;
    }
    tauri::async_runtime::spawn(pull(app));
    Ok(())
}

/// The front end's latest snapshot of this wall's cards. Opaque here; see
/// `cards.rs`.
///
/// Off the main thread, as every command here that takes the store's lock is:
/// a pull folding a week of sink events holds that lock, and a command waiting
/// on it from the main thread is the whole wall waiting (CLAUDE.md, `off_main`).
#[tauri::command]
pub async fn flyway_publish_cards(app: AppHandle, snapshot: Value) -> Result<(), String> {
    match current(&app) {
        Some(l) => crate::off_main(move || l.publish_cards(snapshot)).await?,
        /* No link yet — kept for when there is one. See `early_cards`. A wall
           with no key holds one snapshot it never sends, which costs nothing. */
        None => {
            if let Some(f) = app.try_state::<Flyway>() {
                if let Ok(mut e) = f.early_cards.lock() {
                    *e = Some((snapshot, crate::store::now()));
                }
            }
            Ok(())
        }
    }
}

/// Every other wall's latest snapshot, for the wall to draw at launch.
#[tauri::command]
pub fn flyway_remote_cards(app: AppHandle) -> Vec<RemoteCards> {
    current(&app).map(|l| l.remote_cards()).unwrap_or_default()
}

/// The card another wall asked for is on this wall.
#[tauri::command]
pub async fn flyway_opened(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(l) = current(&app) {
        crate::off_main(move || l.opened(&id)).await?;
    }
    Ok(())
}

/// The card another wall asked for could not be opened here.
#[tauri::command]
pub async fn flyway_failed(app: AppHandle, id: String, reason: String) -> Result<(), String> {
    if let Some(l) = current(&app) {
        let why = crate::clean::scrub(reason.trim()).into_owned();
        let why = if why.is_empty() { "the wall could not open it".to_string() } else { why };
        crate::off_main(move || l.failed(&id, &why)).await?;
    }
    Ok(())
}

/// Every card on this wall that another wall asked for, still open — for the
/// card's own face to say so.
#[tauri::command]
pub async fn flyway_births(app: AppHandle) -> Result<Vec<here::Birth>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        Ok(here::births(&conn))
    })
    .await?
}

/// Send a prompt to a card on another wall. `Ok` means it is on its way —
/// `flyway:prompt-left` says when it has actually left, and
/// `flyway:prompt-answer` what became of it.
///
/// With `ask_id`, the text **answers** that card's parked `ask_user` question
/// rather than being a new prompt — composed exactly as the owning wall's own
/// dock would compose it — and is not held to the far wall's switch.
///
/// With `pictures`, the prompt carries them (`fleet::FleetMsg::Pictured`): each
/// named by the `[name]` token where it sits in `text`, checked here before
/// anything is queued, so a prompt that could not cross is refused at once
/// with the draft still in the dock.
#[tauri::command]
pub async fn flyway_prompt(
    app: AppHandle,
    id: String,
    to: String,
    card: String,
    text: String,
    ask_id: Option<String>,
    pictures: Option<Vec<fleet::Picture>>,
) -> Result<(), String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway, so it cannot reach another wall's card".into());
    };
    if text.trim().is_empty() {
        return Err("an empty prompt is nothing to send".into());
    }
    /* An answer may carry pictures and files as a prompt may — the owning
       wall hands it to its front end to fetch and cut (`afar_may_attach`) —
       and is checked here as a prompt is. */
    let pictures = pictures.unwrap_or_default();
    crate::off_main(move || {
        crate::attach::carried_fit(&pictures, &text)?;
        l.send_prompt(PromptRequest {
            id,
            from_card: None,
            to,
            card,
            text,
            answers: ask_id,
            title: None,
            project: None,
            pictures,
        })
    })
    .await?
}

/// Close a card on another wall, for a person here. `Ok` means it is on its way;
/// `flyway:prompt-answer` says what became of it, and the card leaves this wall
/// when its owner's next snapshot no longer carries it — never before. Refused
/// at once, in words for a person, when that wall is quiet or too old to take it
/// (`fleet::CAN_PERSON_CLOSE`).
#[tauri::command]
pub async fn flyway_close(app: AppHandle, id: String, to: String, card: String) -> Result<(), String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway, so it cannot reach another wall's card".into());
    };
    crate::off_main(move || {
        l.send_person(
            Act::Close,
            PromptRequest {
                id,
                from_card: None,
                to,
                card,
                text: String::new(),
                answers: None,
                title: None,
                project: None,
                pictures: Vec::new(),
            },
        )
    })
    .await?
}

/// The front end's answer to a `flyway:prompt` it was handed.
#[tauri::command]
pub async fn flyway_prompt_answer(
    app: AppHandle,
    id: String,
    asked_by: String,
    outcome: String,
    why: Option<String>,
) -> Result<(), String> {
    if let Some(l) = current(&app) {
        let card_or_why = if outcome == "taken" {
            Ok(String::new())
        } else {
            let w = why.map(|w| crate::clean::scrub(w.trim()).into_owned()).filter(|w| !w.is_empty());
            Err(w.unwrap_or_else(|| "the card could not take it".into()))
        };
        crate::off_main(move || {
            /* The card the prompt was for is the one that took it; the
               fleet's `Opened` outcome carries an id, and this is it. */
            let outcome = match card_or_why {
                Ok(_) => Ok(card_for(&l, &asked_by, &id)),
                Err(w) => Err(w),
            };
            l.prompt_settled(&asked_by, &id, outcome)
        })
        .await?;
    }
    Ok(())
}

/// Read one card's conversation off the wall it runs on — pulled when a panel
/// opens on its shadow, never gossiped (see `tail.rs`).
///
/// `Ok(Some(lines))` is the tail, as `shadow.ts::readTail` reads it;
/// `Ok(None)` is the far wall saying the card has nothing to show; `Err` is
/// the sentence the panel draws — and a wall that cannot answer, unknown,
/// quiet or too old, is that at once rather than a request that hangs.
#[tauri::command]
pub async fn flyway_tail(app: AppHandle, host: String, card: String) -> Result<Option<Value>, String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway, so it cannot read another wall's card".into());
    };
    let host = host.trim().to_string();
    let card = card.trim().to_string();
    if host.is_empty() || card.is_empty() {
        return Err("no card was named".into());
    }
    /* The roster's lock off the main thread, for `flyway_publish_cards`'s
       reason; the exchange itself is network, and awaits rather than blocks. */
    let check = l.clone();
    let h = host.clone();
    crate::off_main(move || check.tail_reachable(&h)).await??;
    let (id, said) = l.read_tail(&host, &card).await?;
    /* The bound on arrival walks every string of up to half a megabyte —
       CPU, so it goes where blocking work goes. */
    crate::off_main(move || match tail::answer_in(&said, &id, &host)? {
        tail::Read::Lines(v) => Ok(Some(v)),
        tail::Read::Nothing => Ok(None),
    })
    .await?
}

/// This wall's front end's answer to a `flyway:tail`: the lines `tailOf`
/// made, or why there are none. Neither is "the card has nothing to show",
/// which is an empty list.
#[tauri::command]
pub async fn flyway_tail_answer(app: AppHandle, id: String, lines: Option<Value>, why: Option<String>) -> Result<(), String> {
    let Some(l) = current(&app) else { return Ok(()) };
    let answer = match why.map(|w| crate::clean::scrub(w.trim()).into_owned()).filter(|w| !w.is_empty()) {
        Some(why) => Err(why),
        None => Ok(lines.unwrap_or_else(|| Value::Array(Vec::new()))),
    };
    crate::off_main(move || l.tail_answered(&id, answer)).await?
}

/// Ask the wall a card runs on to do `verb` to it, for a person here — the
/// shadow's menu (`Elsewhere.act`). One exchange, answered on the same stream
/// (`act.rs`). `Ok(Some(text))` is what a reading verb answered with,
/// `Ok(None)` a gesture done; `Err` is the sentence to show, said at once for a
/// wall that is unknown, quiet, too old for the verb, or — for a verb that
/// starts work — not taking work. Never queued: a gesture that does not land
/// now is refused.
///
/// No MCP tool reaches this. An agent's road to another wall's cards is
/// `walls`/`send`/`recall`/`close`, and this is a person's.
#[tauri::command]
pub async fn flyway_act(app: AppHandle, host: String, card: String, verb: String, args: Option<Value>) -> Result<Option<String>, String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway, so it cannot reach another wall's card".into());
    };
    if !act::is_id(&card) {
        return Err("that is not a card another wall would know".into());
    }
    let check = l.clone();
    let (h, v) = (host.clone(), verb.clone());
    crate::off_main(move || check.act_reachable(&h, &v)).await??;
    let args = act::read_args(&verb, &args.unwrap_or(Value::Null))?;
    l.read_act(&host, &card, &verb, args).await
}

/// This wall's front end's answer to a `flyway:act`: `taken` with what a
/// reading verb returns, or anything else with the reason.
#[tauri::command]
pub async fn flyway_act_answer(
    app: AppHandle,
    id: String,
    outcome: String,
    why: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    let Some(l) = current(&app) else { return Ok(()) };
    let answer = if outcome == "taken" {
        Ok(text)
    } else {
        let w = why.map(|w| act::fit_text(&w, 400)).filter(|w| !w.is_empty());
        Err(w.unwrap_or_else(|| "the card could not do that".into()))
    };
    crate::off_main(move || l.act_answered(&id, answer)).await?
}

/// Pull what a question parked on another wall shows — its arguments and its
/// files — so this wall can draw it through the same `normalizeAsk` as a
/// question asked here (`look.rs`). Asked by the front end the moment a
/// question with something to show arrives.
///
/// `Ok` is the call's arguments with every file slot pointing into this wall's
/// own folder, or at a fault naming the file. `Err` is the sentence the
/// question carries instead — the wall is quiet or too old, or the question
/// has gone.
#[tauri::command]
pub async fn flyway_look(app: AppHandle, host: String, card: String, ask: String) -> Result<Value, String> {
    /* Two pulls at a time. Each gathers up to `look::ASK_MOST` in memory before
       it is written, and a wall whose cards all asked over screenshots at once
       would otherwise hold every one of them together (found in review). */
    static PULLS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _turn = PULLS
        .get_or_init(|| tokio::sync::Semaphore::new(2))
        .acquire()
        .await
        .map_err(|_| "this wall has stopped pulling questions".to_string())?;
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway".into());
    };
    let (host, card, ask) = (host.trim().to_string(), card.trim().to_string(), ask.trim().to_string());
    if host.is_empty() || card.is_empty() || ask.is_empty() {
        return Err("no question was named".into());
    }
    let check = l.clone();
    let h = host.clone();
    crate::off_main(move || {
        check.reachable(&h, look::WORD, "cannot send what its questions show — update it to see them here")
    })
    .await??;
    let gathered = l.read_look(&host, &card, &ask).await?;
    let whole = gathered.whole();
    /* Writing up to `ASK_MOST` of files is blocking work, and so is the sweep. */
    let args = crate::off_main(move || {
        sweep_looks(&app, false);
        let dir = look_dir(&app, &host, &ask)?;
        let _ = std::fs::remove_dir_all(&dir);
        gathered
            .settle(&host, &mut |n, name, bytes| {
                let at = dir.join(n.to_string());
                std::fs::create_dir_all(&at).map_err(|e| e.to_string())?;
                std::fs::write(at.join(name), bytes).map_err(|e| e.to_string())?;
                Ok((at.to_string_lossy().into_owned(), name.to_string()))
            })
            .ok_or_else(|| format!("{host} sent no question"))
    })
    .await??;
    /* `whole: false` is a file that stopped for a reason a later pull could get
       past; the front end draws what came and asks again on the wall's next
       snapshot. */
    Ok(serde_json::json!({ "args": args, "whole": whole }))
}

/// A question pulled from another wall has gone — answered, or run out — so
/// what it brought here goes too.
#[tauri::command]
pub async fn flyway_look_forget(app: AppHandle, host: String, ask: String) -> Result<(), String> {
    crate::off_main(move || {
        let dir = look_dir(&app, host.trim(), ask.trim())?;
        match std::fs::remove_dir_all(&dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    })
    .await?
}

/// One file a prompt from another wall carried, as this wall now holds it: a
/// path in the card's own folder, or why it is not here.
#[derive(Serialize)]
pub struct Fetched {
    n: usize,
    path: Option<String>,
    fault: Option<String>,
}

/// Pull the files a prompt from `host` carries for `card`, from the stage that
/// wall is holding them under, and write them into the card's own folder
/// (`attachments.rs`) — so the agent here is handed paths on this machine.
/// Through the transfer a question's files take (`look.rs`), in parts, each
/// file whole or said not to be.
#[tauri::command]
pub async fn flyway_fetch(app: AppHandle, host: String, card: String, stage: String) -> Result<Vec<Fetched>, String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway".into());
    };
    let (host, card, stage) = (host.trim().to_string(), card.trim().to_string(), stage.trim().to_string());
    if host.is_empty() || card.is_empty() || !stage.starts_with("stage-") {
        return Err("no files were named".into());
    }
    let check = l.clone();
    let h = host.clone();
    crate::off_main(move || check.reachable(&h, crate::attachments::CAN_FILES, "cannot send files to a card here — update it"))
        .await??;
    let gathered = l.read_look(&host, &card, &stage).await?;
    let wall = app.state::<crate::store::Store>().1.clone();
    crate::off_main(move || {
        let dir = crate::attachments::card_dir(&wall, &card).join(format!("from-{}", crate::store::uuid_v4()));
        let args = gathered
            .settle(&host, &mut |n, name, bytes| {
                let at = dir.join(n.to_string());
                std::fs::create_dir_all(&at).map_err(|e| e.to_string())?;
                std::fs::write(at.join(name), bytes).map_err(|e| e.to_string())?;
                Ok((at.to_string_lossy().into_owned(), name.to_string()))
            })
            .ok_or_else(|| format!("{host} sent no files"))?;
        let mut out = Vec::new();
        let mut n = 0usize;
        let mut walked = args;
        let _ = crate::ask::each_site::<()>(&mut walked, &mut |site: &mut Value| {
            if let Some(f) = site.get("file").filter(|f| !f.is_null()) {
                let s = |k: &str| f.get(k).and_then(Value::as_str).map(str::to_string);
                out.push(match (s("root"), s("path"), s("fault")) {
                    (_, _, Some(fault)) => Fetched { n, path: None, fault: Some(fault) },
                    (Some(root), Some(path), None) => Fetched {
                        n,
                        path: Some(std::path::Path::new(&root).join(path).to_string_lossy().into_owned()),
                        fault: None,
                    },
                    _ => Fetched { n, path: None, fault: Some("it did not arrive".into()) },
                });
                n += 1;
            }
            Ok(())
        });
        Ok(out)
    })
    .await?
}

/// The card a prompt in hand was addressed to, for the answer to name.
fn card_for(l: &Link, asked_by: &str, request: &str) -> String {
    l.fleet
        .lock()
        .ok()
        .and_then(|f| f.asked(asked_by, request).and_then(|a| a.card.clone()))
        .unwrap_or_default()
}

/// The running link, for `spawn.rs`'s remote arm.
pub fn link(app: &AppHandle) -> Option<Arc<Link>> {
    current(app)
}

/// Whether the person is at another wall, for `presence::away`. A wall with no
/// flyway has nobody elsewhere, so it answers exactly as it did before there
/// was one.
pub fn present_elsewhere(app: &AppHandle) -> bool {
    current(app).is_some_and(|l| l.present_elsewhere())
}

/// Say what this wall is now rather than at the next tick — for a change a
/// peer acts on, which the away switch is. Not awaited; a wall with no flyway
/// does nothing.
pub fn announce_soon(app: &AppHandle) {
    if current(app).is_some() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = pull(app).await;
        });
    }
}

/// Whether a card may be given a process, for `supervisor::spawn_now` — a
/// card moving between walls is frozen on one and held on the other
/// (`moves.rs`). Asked whether or not this wall is on a flyway: a move's rows
/// outlive the link, and a wall that came up without its key must not wake a
/// card it half gave away.
pub fn move_blocks(app: &AppHandle, card: &str) -> Option<String> {
    moves::blocks(app, card)
}

/// A turn has ended on a card, for `supervisor::persist_turn`.
pub fn move_turn_closed(app: &AppHandle, card: &str) {
    moves::turn_closed(app, card)
}

/// Open a card on another wall, for a person's right-click on one of that
/// wall's sections (`opening.rs`). Answers at once with the request id or
/// the reason it cannot be asked; how it ends arrives as
/// `flyway:opened-there`. No MCP tool reaches this — an agent's road is
/// `spawn` with a `host`, which keeps its own refusal of an empty brief.
#[tauri::command]
pub async fn flyway_open(
    app: AppHandle,
    host: String,
    project: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    crate::off_main(move || {
        let link = current(&app).ok_or("this wall is not on a flyway, so there is no other wall to open a card on")?;
        link.ask_open(&host, &project, model.as_deref(), effort.as_deref())
    })
    .await?
}

/// Move a card on this wall to another one. Answers at once with the move's
/// id or the reason it cannot go; how it ends arrives as `flyway:move`.
#[tauri::command]
pub async fn flyway_move(app: AppHandle, id: String, host: String) -> Result<String, String> {
    crate::off_main(move || {
        let link = current(&app).ok_or("this wall is not on a flyway, so there is no other wall to move a card to")?;
        link.move_out(&id, &host)
    })
    .await?
}

/// This wall's front end could not open a card that moved here.
#[tauri::command]
pub async fn flyway_move_failed(app: AppHandle, request: String, reason: String) -> Result<(), String> {
    crate::off_main(move || {
        if let Some(link) = current(&app) {
            link.move_open_failed(&request, &reason);
        }
    })
    .await
}
