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

use super::cards::{Arrived, Cards};
use super::fleet::{self, Act, Answer, Deliver, Facts, Fleet, FleetMsg, Origin, Outcome, PromptRequest, Refusal, Request, Spawn, Standing};
use super::frame::Frame;
use super::here;
use super::key;
use super::session::Msg;
use super::wire::{Dialler, Fault, Wire};
use crate::store::Store;

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
    /// Prompts this wall sent, by request id, until they are answered.
    prompts_out: StdMutex<HashMap<String, PromptOut>>,
    /// Prompts handed to cards here, by the asker's host and request id.
    prompts_in: StdMutex<HashMap<(String, String), i64>>,
    cards_due: AtomicBool,
}

/// One of this wall's prompts to another wall's card.
struct PromptOut {
    to: String,
    /// Written to a connection to `to` at least once. Until it is, the front
    /// end draws it as still on this machine — the fourth mark a remote prompt
    /// needs, so that a link that is down never reads as an agent thinking.
    left: bool,
    asked_at: i64,
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
            Wants::Spawn | Wants::Close => true,
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

    let (fleet_v, cards_v) = {
        /* `try_state`, because this is reached from a command as well as from
           setup, and a missing store must be an error here rather than a
           panic on a runtime thread, which takes the process with it. */
        let store = app.try_state::<Store>().ok_or("the store is not open yet")?;
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        (here::version(&conn, here::FLEET_VERSION), here::version(&conn, here::CARDS_VERSION))
    };
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
        prompts_out: StdMutex::new(HashMap::new()),
        prompts_in: StdMutex::new(HashMap::new()),
        cards_due: AtomicBool::new(false),
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
            let l = serving.clone();
            tauri::async_runtime::spawn(async move {
                let me = l.clone();
                let out = l
                    .wire
                    .answer(incoming, move |heard, who| async move { me.answer(heard, who) })
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
    let asking = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = pull(asking.clone()).await {
                log::debug!("flyway: nothing came back this time: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });

    Ok(true)
}

/// One tick: say what this wall is, tidy what is too old to matter, and dial
/// every peer at once.
pub async fn pull(app: AppHandle) -> Result<usize, String> {
    let Some(link) = current(&app) else {
        return Err("this wall is not on a flyway".to_string());
    };
    link.housekeep();
    let mut dials = Vec::new();
    for host in link.due_peers() {
        let l = link.clone();
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
                remote_live: here::births_live(&conn),
                /* A card agreed to and not yet open is in both the table and
                   the fleet's in-flight count; taken out here so the bound does
                   not count it twice. */
                remote_last_hour: here::births_since(&conn, self.now() - 60 * 60_000).saturating_sub(in_flight),
                can: fleet::CAN.iter().map(|c| c.to_string()).collect(),
                ..Facts::default()
            };
            (f, here::open_cards(&conn))
        };
        let sup = self.app.state::<crate::supervisor::Supervisor>();
        f.cards_live = open.len() as u32;
        f.cards_working = open.iter().filter(|c| sup.liveness(c).1).count() as u32;
        f.allowance_used = crate::limits::headroom_used(&self.app);
        f
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
        self.prompts_out
            .lock()
            .map(|mut o| o.retain(|_, v| now - v.asked_at <= fleet::ANSWER_KEPT_MS))
            .ok();
        self.emit_roster();
    }

    /// Every wall worth dialling this tick.
    fn due_peers(&self) -> Vec<String> {
        let now = self.now();
        let mut hosts: BTreeSet<String> = BTreeSet::new();
        if let Some(seed) = key::joined_peer() {
            hosts.insert(seed);
        }
        if let Ok(f) = self.fleet.lock() {
            hosts.extend(f.roster().map(|e| e.host.clone()));
        }
        if let Ok(h) = self.heard.lock() {
            hosts.extend(h.iter().cloned());
        }
        hosts.retain(|h| !h.eq_ignore_ascii_case(&self.me));
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
        }
        Ok(out)
    }

    /// One pull from one wall, and the push its answer shows is owed.
    async fn dial(self: &Arc<Self>, host: &str) -> Result<usize, String> {
        let peer = self.wire.peer(host)?;
        let mut current = !self.speaks_older(host);
        let back = match self.wire.exchange(peer, self.greeting(current)?, current).await {
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
        if host.eq_ignore_ascii_case(&self.me) || frames.is_empty() {
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
            }
        }
        if fleet_spoke {
            self.emit_roster();
        }
        (news, theirs)
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
                _ => {}
            }
        }
        if who.current {
            /* Answered in kind, as `Hello` is: the dialler gets this wall's
               cards in the same exchange it sent its own. */
            if let Some(c) = self.cards.lock().ok().and_then(|c| c.say(now)) {
                out.push(Frame::Cards(c));
            }
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
                FleetMsg::Ask { ask, .. }
                | FleetMsg::Prompt { ask, .. }
                | FleetMsg::Recall { ask, .. }
                | FleetMsg::Close { ask, .. } => Some(ask.to.clone()),
                FleetMsg::Answer { answer, .. } => Some(answer.asked_by.clone()),
                FleetMsg::Roster { .. } => None,
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
        let msg = self.fleet.lock().map_err(|_| "the fleet is wedged".to_string())?.ask(r.clone(), now);
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
                },
            );
        }
        self.push(r.to, vec![Frame::Fleet(msg)]);
        Ok(rx)
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
        if s.brief.trim().is_empty() {
            return refuse("the brief was empty, and a card opened with nothing to do is a process spent on nothing".into());
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
        let now = self.now();
        let msg = self
            .fleet
            .lock()
            .map_err(|_| "the fleet is wedged".to_string())?
            .prompt(r.clone(), now)
            .map_err(|u| u.reason())?;
        if let Ok(mut o) = self.prompts_out.lock() {
            o.entry(r.id.clone()).or_insert(PromptOut { to: r.to.clone(), left: false, asked_at: now });
        }
        self.push(r.to, vec![Frame::Fleet(msg)]);
        Ok(())
    }

    /// Every prompt for `host` that had not yet left has now been written to a
    /// connection to it.
    fn left_for(&self, host: &str) {
        let gone: Vec<String> = match self.prompts_out.lock() {
            Ok(mut o) => o
                .iter_mut()
                .filter(|(_, p)| !p.left && p.to == host)
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

        if let Err(refusal) = fleet::may_reach(d.act, &d.asked_by, d.accepting, d.answers.is_some(), born.as_ref(), replies) {
            let m = self.fleet.lock().ok().and_then(|mut f| f.refuse(&host, &request, refusal, now));
            return answer(self, m);
        }

        match d.act {
            /* An answer to a parked question goes straight into the parked call
               — the channel a click in this wall's own dock uses — and is
               answered taken or refused on the spot, with no front end in
               between. */
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
               though typed here, introduced, and answers `flyway_prompt_answer`. */
            Act::Prompt => {
                if let Ok(mut p) = self.prompts_in.lock() {
                    p.insert((host.clone(), request.clone()), now);
                }
                let _ = self.app.emit(
                    "flyway:prompt",
                    PromptHere { id: request, from: PromptFrom { host, card: d.asked_by.card }, card: row.id, text: d.text },
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
                let m = match crate::spawn::close_from_afar(&self.app, &row, &host) {
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
            let called = match &w.title {
                Some(t) => format!(" It is called {t:?} until it names itself."),
                None => String::new(),
            };
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

/* ── what crosses to the front end ─────────────────────────────────────────── */

#[derive(Serialize, Clone)]
struct PromptLeft {
    id: String,
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
#[tauri::command]
pub async fn flyway_prompt(
    app: AppHandle,
    id: String,
    to: String,
    card: String,
    text: String,
    ask_id: Option<String>,
) -> Result<(), String> {
    let Some(l) = current(&app) else {
        return Err("this wall is not on a flyway, so it cannot reach another wall's card".into());
    };
    if text.trim().is_empty() {
        return Err("an empty prompt is nothing to send".into());
    }
    crate::off_main(move || {
        l.send_prompt(PromptRequest { id, from_card: None, to, card, text, answers: ask_id, title: None, project: None })
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
