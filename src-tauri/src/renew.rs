//! A card renewing itself: same card, same handle, a fresh session that starts
//! from a note the card wrote rather than from everything it ever read.
//!
//! **Why this exists.** A long-lived coordinator pays its whole context on every
//! request. The RISE coordinator was one session for 22 days — 2,886 requests at
//! a median of 493k tokens, 64% of its 220M input units spent re-reading itself
//! and 31% rewriting that context cold after overnight and allowance stalls
//! (sink `71803a3b`). Its durable state already lived in files, so a fresh
//! session holding a good note would resume at a fraction of that.
//!
//! **Why renew rather than hand off to a new card** (Lyss, 2026-11-02, through
//! 12fa2a91). Everything the wall keys on a coordinator is keyed on its *card
//! id*: its children's `spawned` rows and the handle they `send` to, its event
//! subscriptions and their ledger positions, its armed wakes, its board notices,
//! its timeline, its place on the wall and the name Lyss knows it by. A new card
//! would mean re-pointing every one of those, and the ones that cross the flyway
//! (a child on another wall holds the parent's handle) cannot be re-pointed from
//! here at all. A renewed card moves nothing, because nothing has to move.
//!
//! **What it is mechanically**: Volery's `/clear` (`Skein.clear` — the card is
//! kept, its `agent_session_id` repointed, the old transcript left on disk) with
//! three differences, which are the whole of this file:
//!
//! 1. **It keeps what `clear_conversation` lets go of.** A clear drops the card's
//!    notices, wakes, subscriptions, queued questions and live timeline, on the
//!    argument that a reset card is no longer doing that work. A renewed card
//!    *is* still doing it, so `renew_conversation` repoints the session and
//!    keeps all five — and the title, since the work it names is the same work.
//! 2. **The new session's first prompt is the card's own note**, with the
//!    structural facts appended by the wall (`facts`) so the card does not have
//!    to remember them: its live children with their last report, subscriptions,
//!    wakes, notices, queued questions, timeline, and the path of the transcript
//!    it is leaving, so a detail the note missed can still be grepped for.
//! 3. **What is sent in between is kept behind the note.** From the tool call
//!    until the renewal is performed, while the old process lives, nothing is
//!    written into it (`holds`): the wall's post is held in the inbox behind the
//!    note and a relay is queued there with its own sender — so a child's report
//!    that lands mid-renewal is read by the new session, after it knows who that
//!    child is. After that the card is an ordinary dormant card.
//!
//! The card cannot end its own process mid-turn, so the tool only *schedules*.
//! The front end asks for the renewal once the turn is over (`Skein.#renew`),
//! but **Rust performs it** (`renew_conversation`): whether there is a process
//! to stop is the supervisor's answer, never the webview's belief, and the stop
//! and the repoint happen under the card's spawn claim so nothing can be spawned
//! on the old session in between. The front end then spawns, because it is the
//! one place that holds what a respawn needs (`relay.md`, "Rust asks; the
//! webview spawns"). `.claude/rules/context.md` has the 0.94 review that moved
//! the line.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const RENEW_TOOL: &str = "renew";

/// The head of the note the new session opens on. Under `RELAY_MARK`, as
/// `relay.md` asks of any new kind of unbidden prompt — "a shape under the
/// mark, not a mark of its own" — so every fold that already keeps a relay out
/// of your register keeps this out too. Must match `relay.ts`'s `RENEWED`.
pub const RENEW_HEAD: &str = "[skein relay] renewed —";

/// A note shorter than this is not a handoff, it is a lobotomy: the new session
/// would start knowing its children's handles and nothing about why it has
/// them. Three hundred characters is a short paragraph.
pub const MIN_NOTE: usize = 300;

/// One renewal per card per this long, counted when it is performed. A fresh
/// session that renews again at once is a loop with a full-context turn at the
/// front of every lap; an hour is far shorter than any round worth renewing at.
pub const MIN_GAP: Duration = Duration::from_secs(60 * 60);

/// The `chain` the note's inbox row carries: `renew:` and the session it was
/// written *from*. That is what makes a renewal that never happened readable off
/// the disk alone — a note row whose session is still the card's current one is
/// a note the card was never renewed onto, whatever this process remembers.
/// `PENDING` is memory, and a crash or a quit takes it; the row survives both,
/// so the row is what `release` asks.
pub const NOTE_CHAIN: &str = "renew:";

/// The three ways `renew_conversation` declines, as prefixes the front end reads
/// (`renewing.ts` holds the same three strings).
pub const NOT_SCHEDULED: &str = "not-scheduled:";
pub const BUSY: &str = "busy:";
pub const DROPPED: &str = "dropped:";

#[derive(Debug, Clone)]
struct Pending {
    /// The session the card was repointed at, once the renewal is performed.
    cleared: Option<String>,
    /// A `renew_conversation` is running for this card. Two at once would both
    /// stop and both repoint, and the second session id would win the row while
    /// the first caller drew the other.
    performing: bool,
}

static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);
static LAST: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn pending_of(id: &str) -> Option<Pending> {
    PENDING.lock().ok().and_then(|m| m.as_ref()?.get(id).cloned())
}

/// A renewal is scheduled or performed and not yet spawned. Asked by a move,
/// which must not carry a card off half-way through one.
pub(crate) fn pending_has(id: &str) -> bool {
    pending_of(id).is_some()
}

/// Whether a renewal is waiting to be performed for this card — scheduled and
/// not yet repointed. `compact` asks it: a `/compact` written now would wait
/// behind the turn and compact the *fresh* session's note.
pub fn scheduled(id: &str) -> bool {
    pending_of(id).is_some_and(|p| p.cleared.is_none())
}

/// Whether a delivery to this card goes to its inbox rather than its stdin: a
/// renewal is scheduled and not performed, **and the old process is still there
/// to be kept from it.** Only then.
///
/// Once the renewal is performed the card is an ordinary dormant card, and an
/// ordinary dormant card's post goes the ordinary way — queued with its sender,
/// chain and hops, and a `relay:wake` that spawns it. Holding past that point
/// answered every sender "delivered" for a card nothing was going to wake. A
/// card whose old process died first has nothing to be kept from either: the
/// ordinary path queues and wakes it, and that wake performs the renewal before
/// it spawns (`Skein.#spawn`).
///
/// Takes the supervisor's lock for the liveness and lets it go; a caller takes
/// the store's afterwards, never both at once.
pub fn holds(app: &AppHandle, id: &str) -> bool {
    scheduled(id)
        && app
            .try_state::<crate::supervisor::Supervisor>()
            .is_some_and(|s| s.liveness(id).0)
}

/// `supervisor::deliver_blocks`' one call: put what would have gone into the
/// card's stdin into its inbox instead, behind the note. Text only — every Rust
/// caller of `deliver` composes words — and an attachment you typed into a
/// renewing card is said to be missing rather than silently dropped.
///
/// The relay's own two paths (`do_send`, `deliver_from_afar`) ask `holds` first
/// and queue with their own sender, chain and hops, so what reaches this is the
/// wall's own post — a wake, a stop notice, a board note, a subscription batch,
/// a typed prompt — each already in its envelope, so a self-row.
pub fn hold(app: &AppHandle, id: &str, content: &[crate::supervisor::Block]) -> Result<(), String> {
    let mut text = String::new();
    let mut lost = 0;
    for b in content {
        match b {
            crate::supervisor::Block::Text { text: t } => {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(t);
            }
            _ => lost += 1,
        }
    }
    if lost > 0 {
        text.push_str(&format!(
            "\n\n(skein: {lost} attachment(s) sent with this could not be held across the card's \
             renewal — ask for them again if they matter.)"
        ));
    }
    let store = app.try_state::<Store>().ok_or("no store")?;
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    crate::store::record_relay(&conn, &crate::store::uuid_v4(), id, id, &text, "", 0, false)
}

/// What the old session is told instead, when its note will never be read by a
/// new one. The wall's shape under the relay mark (`relay.md`), saying nobody
/// waits on it.
pub fn not_performed(why: &str) -> String {
    format!(
        "{} from the wall —\n\nThe renewal you asked for was **not performed**: {why} This is \
         still the same session, with everything you had before, and the note you wrote was \
         not delivered. If you still want a fresh session, call `mcp__skein__renew` again at the end of a \
         turn.\n\n(This came from the wall rather than from anybody, so nobody is waiting on a \
         reply.)",
        crate::relay::RELAY_MARK
    )
}

/// Turn every undelivered note this card was never renewed onto into
/// `not_performed` — the rows whose `renew:<session>` names the card's
/// *current* session. One statement, so it is true whether or not this process
/// remembers scheduling anything: after a crash `PENDING` is empty and the row
/// is the only record there is. Answers how many it rewrote.
fn withdraw_notes(conn: &Connection, id: &str, why: &str) -> usize {
    conn.execute(
        "UPDATE relay SET body = ?2, chain = ''
          WHERE to_id = ?1 AND from_id = ?1 AND delivered_at IS NULL
            AND chain = ?3 || COALESCE(
                  (SELECT agent_session_id FROM conversation WHERE id = ?1), ?1)",
        params![id, not_performed(why), NOTE_CHAIN],
    )
    .unwrap_or(0)
}

/// The session a card is on, as a spawn would read it: the row's, or its own
/// id for a card never cleared.
fn session_now(conn: &Connection, id: &str) -> String {
    crate::store::session_of(conn, id)
        .and_then(|(_, s)| s)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.to_string())
}

#[derive(Serialize, Clone)]
struct RenewDropped {
    id: String,
    why: String,
}

const WOKEN_OLD: &str = "the card was given a process on its old session before the renewal \
                         could be done — the wall restarted, or something woke it first.";

/// Called by `spawn_now` immediately before it drains the inbox: from here the
/// card has a process again and its post goes out in order.
///
/// - **Performed**: the hourly guard is charged now, on the renewal rather than
///   on the asking, and the note goes out first.
/// - **Scheduled and never performed** — woken on its *old* session: the note
///   is turned into a line saying so, so the old session is neither told it was
///   renewed nor left believing it is about to be, and the front end is told to
///   stop waiting (`renew:dropped`). Whatever was held still goes out after it.
/// - **Nothing in memory** — the wall restarted between the call and the
///   renewal: the same rewrite, read off the row alone.
pub fn release(app: &AppHandle, id: &str) {
    let gone = PENDING.lock().ok().and_then(|mut m| m.as_mut()?.remove(id));
    if gone.as_ref().is_some_and(|p| p.cleared.is_some()) {
        if let Ok(mut m) = LAST.lock() {
            m.get_or_insert_with(HashMap::new).insert(id.to_string(), Instant::now());
        }
    }
    if let Some(store) = app.try_state::<Store>() {
        if let Ok(conn) = store.0.lock() {
            withdraw_notes(&conn, id, WOKEN_OLD);
        }
    }
    if gone.is_some_and(|p| p.cleared.is_none()) {
        let _ = app.emit("renew:dropped", RenewDropped { id: id.to_string(), why: WOKEN_OLD.into() });
    }
}

/// A spawn on a session the card has just been renewed away from. Refused in
/// `spawn_now`, after its claim: the front end performs the renewal inside the
/// card's spawn single-flight, so this is the backstop for any spawn that did
/// not wait — and the one that would otherwise resume the old conversation
/// whole and hand it the note saying it was fresh. A spawn while the renewal is
/// being performed is refused for the same reason.
pub fn spawn_blocks(id: &str, session: &str) -> Option<String> {
    let p = pending_of(id)?;
    if p.performing {
        return Some(format!(
            "{} is being renewed onto a fresh session — try again in a moment",
            crate::relay::handle_of(id)
        ));
    }
    match p.cleared {
        Some(fresh) if fresh != session => Some(format!(
            "{} was renewed onto a fresh session; refusing to resume the one it left",
            crate::relay::handle_of(id)
        )),
        _ => None,
    }
}

/// A card left the wall, or this one: whatever renewal it had scheduled goes
/// with it. Its note stays an undelivered row in a closed card's inbox, which
/// is where every other undelivered row of a closed card stays.
pub fn forget(id: &str) {
    if let Ok(mut m) = PENDING.lock() {
        if let Some(m) = m.as_mut() {
            m.remove(id);
        }
    }
}

/// A card was cleared: whatever renewal it had scheduled is over, and every
/// undelivered note it wrote goes, whichever session the note names. A clear is
/// a repoint `withdraw_notes` cannot see — the chain names the session the note
/// left, and after a clear the card is on neither that one nor the one a renewal
/// would have given it — so the note would otherwise open the cleared session
/// reading as though it had been renewed. Deleted rather than rewritten: the
/// cleared session has nothing to be told about the old one's plans.
pub fn cleared(app: &AppHandle, id: &str) {
    forget(id);
    if let Some(store) = app.try_state::<Store>() {
        if let Ok(conn) = store.0.lock() {
            drop_notes(&conn, id);
        }
    }
}

fn drop_notes(conn: &Connection, id: &str) -> usize {
    conn.execute(
        "DELETE FROM relay WHERE to_id = ?1 AND from_id = ?1 AND delivered_at IS NULL
           AND substr(chain, 1, length(?2)) = ?2",
        params![id, NOTE_CHAIN],
    )
    .unwrap_or(0)
}

/// Give up a scheduled renewal and say why: the note becomes `not_performed`,
/// what was held goes into the live process in order behind it, and the front
/// end is told. For a card that cannot be renewed without losing something —
/// a background job or a schedule the old process holds.
fn abandon(app: &AppHandle, id: &str, why: &str) {
    forget(id);
    if let Some(store) = app.try_state::<Store>() {
        if let Ok(conn) = store.0.lock() {
            withdraw_notes(&conn, id, why);
        }
    }
    /* `PENDING` is gone, so nothing holds any more and the drain writes into the
       live process. A card with no process keeps it all for its next wake. */
    if app
        .try_state::<crate::supervisor::Supervisor>()
        .is_some_and(|s| s.liveness(id).0)
    {
        crate::relay::drain_inbox(app, id);
    }
    let _ = app.emit("renew:dropped", RenewDropped { id: id.to_string(), why: why.into() });
}

/// Background jobs the store knows the card's current session is holding. A row
/// is written on the receipt and deleted when the job reports in (`turns.md`),
/// so a row here is work the renewal would kill with the process, whose report
/// would then land in a session that no longer exists.
fn jobs_held(conn: &Connection, id: &str) -> i64 {
    let session = session_now(conn, id);
    conn.query_row(
        "SELECT COUNT(*) FROM job WHERE conversation_id = ?1 AND session_id = ?2",
        params![id, session],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

fn jobs_said(n: i64) -> String {
    format!(
        "this card has {n} background job(s) still running, and renewing would end them with \
         the process and send their reports to a session that no longer exists."
    )
}

/* ── what the wall knows that the card should not have to remember ───────── */

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Child {
    pub handle: String,
    pub title: String,
    /// `working`, `idle`, or `dormant` — what the supervisor says right now.
    pub state: &'static str,
    /// The first line of the last thing it sent this card, and how long ago.
    pub last_report: Option<(String, i64)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts {
    pub children: Vec<Child>,
    /// `(host, handle)` of children opened on other walls.
    pub far_children: Vec<(String, String)>,
    /// `(source, note)`.
    pub subscriptions: Vec<(String, String)>,
    /// `(due_at, note)`.
    pub wakes: Vec<(i64, String)>,
    /// `(subject, paths)`.
    pub notices: Vec<(String, String)>,
    pub queued_questions: i64,
    pub timeline: Option<String>,
    pub transcript: Option<String>,
}

fn ago(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    match s {
        0..=89 => format!("{s}s"),
        90..=5399 => format!("{}m", s / 60),
        5400..=172_799 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    }
}

fn first_line(body: &str) -> String {
    /* A report usually arrives in a relay envelope; its first line is the
       header, so the line worth quoting is the first one after it. */
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    let mut line = lines.next().unwrap_or("");
    if line.starts_with("[skein") {
        line = lines.next().unwrap_or(line);
    }
    crate::clip::preview(line, 200)
}

/// The facts, worded for the new session. Pure, so the wording is tested.
pub fn say_facts(f: &Facts, now: i64) -> String {
    let mut out = String::from("What the wall carried across for you (it holds all of this; none of it moved):\n");
    if f.children.is_empty() && f.far_children.is_empty() {
        out.push_str("- Children: none open.\n");
    } else {
        out.push_str("- Children you opened, still on the wall — they are still yours, and what they send reaches you by this card's handle as before:\n");
        for c in &f.children {
            let last = match &c.last_report {
                Some((line, at)) => format!(" — last told you, {} ago: \"{line}\"", ago(now - at)),
                None => " — has not sent you anything".into(),
            };
            out.push_str(&format!("  - `{}` \"{}\" ({}){last}\n", c.handle, c.title, c.state));
        }
        for (host, handle) in &f.far_children {
            out.push_str(&format!("  - `{handle}` on {host}\n"));
        }
    }
    if !f.subscriptions.is_empty() {
        out.push_str("- Event subscriptions, still armed (`mcp__skein__subscriptions` lists them):\n");
        for (source, note) in &f.subscriptions {
            out.push_str(&format!("  - {source}: {}\n", crate::clip::preview(note, 200)));
        }
    }
    if !f.wakes.is_empty() {
        out.push_str("- Wakes you armed, still armed — they will arrive in this session:\n");
        for (due, note) in &f.wakes {
            let when = if *due > now { format!("in {}", ago(due - now)) } else { "due now".into() };
            out.push_str(&format!("  - {when}: {}\n", crate::clip::preview(note, 200)));
        }
    }
    if !f.notices.is_empty() {
        out.push_str("- Your billboard notices, still up — take them down with `mcp__skein__unpost` when they stop being true:\n");
        for (subject, paths) in &f.notices {
            let on = if paths.is_empty() { String::new() } else { format!(" ({paths})") };
            out.push_str(&format!("  - {subject}{on}\n"));
        }
    }
    if f.queued_questions > 0 {
        out.push_str(&format!(
            "- {} question(s) you asked are queued for the user; their answers will reach this \
             session as messages.\n",
            f.queued_questions
        ));
    }
    if let Some(t) = &f.timeline {
        out.push_str(&format!(
            "- Your timeline \"{t}\" is still live — `mcp__skein__timeline` reads it.\n"
        ));
    }
    match &f.transcript {
        Some(p) => out.push_str(&format!(
            "- The conversation you are continuing is at `{p}` — grep it (do not read it whole) \
             if a detail your note left out turns out to matter.\n"
        )),
        None => out.push_str("- The previous transcript could not be located.\n"),
    }
    out
}

/// The whole first prompt of the renewed session.
pub fn compose(note: &str, facts: &str) -> String {
    format!(
        "{RENEW_HEAD} this card has a fresh session. You wrote the note below to yourself \
         before renewing — you are the same card, with the same handle, children and \
         responsibilities; only the conversation is new.\n\n{}\n\n{facts}\n\
         Anything sent to this card while it was renewing follows this message. Pick up from \
         the note: say nothing to the user about the renewal unless it bears on their work.",
        crate::clean::scrub(note.trim())
    )
}

/// What the store holds about the card, read under its lock. Everything that
/// asks the supervisor or the disk is left for `settle_facts`, after the lock is
/// let go: the supervisor lock is never taken while the store lock is held
/// (`notice.rs`, `spawn.rs`), and a canonicalize is a filesystem call that has no
/// business holding the one mutex every main-thread store command waits on.
/// Answers the facts, the children by id in the same order, and where the
/// transcript lives.
fn read_facts(conn: &Connection, id: &str) -> (Facts, Vec<String>, Option<(String, String)>) {
    let mut f = Facts::default();
    let mut ids = Vec::new();
    if let Ok(mut st) = conn.prepare(
        "SELECT s.child_id, COALESCE(c.title, '') FROM spawned s
           JOIN conversation c ON c.id = s.child_id
          WHERE s.parent_id = ?1 AND c.closed_at IS NULL ORDER BY s.at",
    ) {
        let rows: Vec<(String, String)> = st
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map(|it| it.flatten().collect())
            .unwrap_or_default();
        for (child, title) in rows {
            let last: Option<(String, i64)> = conn
                .query_row(
                    "SELECT body, sent_at FROM relay WHERE from_id = ?1 AND to_id = ?2
                      ORDER BY sent_at DESC LIMIT 1",
                    params![child, id],
                    |r| Ok((r.get::<_, String>(0)?, r.get(1)?)),
                )
                .optional()
                .ok()
                .flatten()
                .map(|(b, at)| (first_line(&b), at));
            f.children.push(Child {
                handle: crate::relay::handle_of(&child),
                title,
                state: "dormant",
                last_report: last,
            });
            ids.push(child);
        }
    }
    let strings2 = |sql: &str| -> Vec<(String, String)> {
        conn.prepare(sql)
            .and_then(|mut st| {
                st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map(|it| it.flatten().collect())
            })
            .unwrap_or_default()
    };
    f.far_children = strings2("SELECT host, card FROM flyway_child WHERE parent_id = ?1 ORDER BY at")
        .into_iter()
        .map(|(h, c)| (h, crate::relay::handle_of(&c)))
        .collect();
    f.subscriptions = strings2("SELECT source, note FROM subscription WHERE conversation_id = ?1 ORDER BY created_at");
    f.notices = strings2("SELECT subject, paths FROM notice WHERE from_id = ?1 ORDER BY posted_at");
    f.wakes = conn
        .prepare("SELECT due_at, note FROM wake WHERE conversation_id = ?1 ORDER BY due_at")
        .and_then(|mut st| {
            st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).map(|it| it.flatten().collect())
        })
        .unwrap_or_default();
    f.queued_questions = conn
        .query_row("SELECT COUNT(*) FROM deferred_ask WHERE conversation_id = ?1", params![id], |r| r.get(0))
        .unwrap_or(0);
    f.timeline = conn
        .query_row(
            "SELECT title FROM timeline WHERE owner_id = ?1 AND state = 'live' AND archived_at IS NULL
              ORDER BY updated_at DESC LIMIT 1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let at = crate::store::session_of(conn, id).map(|(dir, s)| (dir, s.unwrap_or_else(|| id.to_string())));
    (f, ids, at)
}

/// The half of the facts that is not the store's: each child's state from the
/// supervisor, and the transcript's path from the disk. Called with no lock held.
fn settle_facts(app: &AppHandle, mut f: Facts, ids: &[String], at: Option<(String, String)>) -> Facts {
    for (c, id) in f.children.iter_mut().zip(ids) {
        c.state = match crate::supervisor::turn_open(app, id) {
            Some(true) => "working",
            Some(false) => "idle",
            None => "dormant",
        };
    }
    f.transcript = at
        .and_then(|(dir, s)| crate::supervisor::transcript_path(app, &dir, &s).ok())
        .map(|p| p.display().to_string());
    f
}

/* ── the tool ───────────────────────────────────────────────────────────── */

pub fn renew_schema() -> Value {
    serde_json::json!({
        "name": RENEW_TOOL,
        "description":
            "Renew this card: when the current turn ends, the wall starts it on a fresh, empty \
             session whose first message is the `note` you write here. You stay the same card — \
             same handle, same place on the wall — and everything the wall keys on you stays: \
             your children (their messages still reach you), event subscriptions, armed wakes, \
             billboard notices, queued questions, your timeline. The wall appends a list of all \
             of those to your note, with your children's last reports and the path of the \
             transcript you are leaving, so you do not need to restate them.\n\n\
             Use it at a round boundary when your context is large (`allowance` says how large) \
             and long-lived — a coordinator above all, since every request re-reads the whole \
             conversation. Unlike `compact`, nothing is summarised for you: the note is all the \
             new session knows, so write it for a stranger — decisions made and why, what is in \
             flight and what you are waiting on, what comes next, and which files hold your \
             durable notes. After calling it, end your turn; messages that arrive meanwhile are \
             held and delivered after the note. Refused for a note under 300 characters, and \
             more than once an hour.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": {
                    "type": "string",
                    "description": "The handoff to your next session, written for a reader with none of your context."
                }
            },
            "required": ["note"]
        }
    })
}

/// Why a renewal would not be scheduled, or `None`. Pure, for the tests.
fn refusal(note: &str, pending: bool, since_last: Option<Duration>) -> Option<String> {
    if pending {
        return Some(
            "Not scheduled: a renewal is already waiting for this turn to end. End the turn and \
             it will happen; nothing else is needed."
                .into(),
        );
    }
    let n = note.trim().chars().count();
    if n < MIN_NOTE {
        return Some(format!(
            "Not scheduled: the note is {n} characters, and it is the only thing the new session \
             will know about the work — under {MIN_NOTE} it is not a handoff. Write what was \
             decided and why, what is in flight, what you are waiting on, what comes next and \
             where your durable notes live, then call this again. Nothing was changed."
        ));
    }
    if let Some(ago) = since_last.filter(|a| *a < MIN_GAP) {
        return Some(format!(
            "Not scheduled: this card was renewed {} minute(s) ago, and renewing again so soon \
             spends a full-context turn to save almost nothing. Nothing was changed; carry on in \
             this session.",
            ago.as_secs() / 60
        ));
    }
    None
}

#[derive(Serialize, Clone)]
struct RenewAsked {
    id: String,
}

fn do_renew(app: &AppHandle, caller: &str, args: &Value) -> String {
    let note = args.get("note").and_then(Value::as_str).unwrap_or("");
    let since = LAST.lock().ok().and_then(|m| m.as_ref()?.get(caller).map(|at| at.elapsed()));
    if let Some(why) = refusal(note, pending_has(caller), since) {
        return why;
    }
    let Some(store) = app.try_state::<Store>() else {
        return "Not scheduled: the wall's store is not available.".into();
    };
    /* Read under the store lock, said with it let go — see `read_facts`. */
    let (facts, ids, at, jobs) = {
        let Ok(conn) = store.0.lock() else {
            return "Not scheduled: the wall's store is busy; try again.".into();
        };
        let (f, ids, at) = read_facts(&conn, caller);
        (f, ids, at, jobs_held(&conn, caller))
    };
    /* Work that would die with the process. Refused while there is still a turn
       to act on it in; a job started after this call is caught again when the
       renewal is performed (`perform`). */
    if jobs > 0 {
        return format!(
            "Not scheduled: {} Renew once it has reported in — its notification wakes you. \
             Nothing was changed.",
            jobs_said(jobs)
        );
    }
    let text = compose(note, &say_facts(&settle_facts(app, facts, &ids, at), crate::store::now()));
    {
        let Ok(conn) = store.0.lock() else {
            return "Not scheduled: the wall's store is busy; try again.".into();
        };
        /* First into the inbox, so first out of it: everything held after this
           line is written behind it (`store::inbox` orders by time, then by
           rowid, so a row written in the same millisecond still follows). The
           chain names the session the note leaves, which is what lets a note
           that was never acted on be recognised from the row alone. */
        let chain = format!("{NOTE_CHAIN}{}", session_now(&conn, caller));
        if let Err(e) =
            crate::store::record_relay(&conn, &crate::store::uuid_v4(), caller, caller, &text, &chain, 0, false)
        {
            return format!("Not scheduled: the note could not be written down ({e}). Nothing was changed.");
        }
    }
    if let Ok(mut m) = PENDING.lock() {
        m.get_or_insert_with(HashMap::new)
            .insert(caller.to_string(), Pending { cleared: None, performing: false });
    }
    let _ = app.emit("renew:asked", RenewAsked { id: caller.to_string() });
    "Renewal scheduled. End your turn now — say whatever the user should read in this session \
     first. When the turn is over the wall starts this card on a fresh session that opens with \
     your note and the list of what it carried across; anything sent to you meanwhile is held \
     and delivered after it."
        .into()
}

pub fn handle(app: &AppHandle, caller: &str, tool: &str, args: &Value) -> Option<String> {
    (tool == RENEW_TOOL).then(|| do_renew(app, caller, args))
}

/* ── the front end's half ───────────────────────────────────────────────── */

/// What a performed renewal answers: the session the card now points at, and
/// whether a process was stopped to get there (so the caller knows an exit is
/// coming and waits for it before it spawns).
#[derive(Serialize, Clone)]
pub struct Renewed {
    session: String,
    stopped: bool,
}

/// Perform a scheduled renewal: stop the old process, repoint the card at a
/// fresh session, keep everything `store::clear_conversation` lets go of.
///
/// **Rust decides whether there is a process to stop, never the caller.** This
/// used to be told: `Skein.renew` closed the process if *it* believed the card
/// was awake. After a webview reload every restored card believes it is
/// dormant, so the close was skipped, the row was repointed under a process
/// still running the old session, and holding then answered every delivery
/// "delivered" while the live process never got one. Now the supervisor's own
/// map answers, and the stop and the repoint are one step:
///
/// - the process is stopped under the supervisor's lock **unless a turn is
///   open** (`stop_unless_turning`) — a card that took up a queued prompt in the
///   meantime is answered `busy:` and asked again after the turn;
/// - the card's spawn claim is then **held across the repoint**
///   (`supervisor::claimed_for`), so no spawn can land on the old session in
///   between; and `spawn_blocks` refuses any that arrives after with the old id.
///
/// `blocker` is what the front end alone can see that would be lost — a
/// `CronCreate` or `ScheduleWakeup` the old process holds, a background job it
/// has not written down yet. With one, or with job rows the store holds, the
/// renewal is **abandoned** (`dropped:`), the card told why, and what was held
/// delivered to it. Waiting instead would hold the card's post for as long as
/// the job ran, and a schedule may never end.
///
/// Off the main thread: a stop waits for the process to die.
#[tauri::command]
pub async fn renew_conversation(
    app: AppHandle,
    id: String,
    session_id: String,
    blocker: Option<String>,
) -> Result<Renewed, String> {
    crate::off_main(move || perform(&app, &id, &session_id, blocker.as_deref())).await?
}

fn set_performing(id: &str, on: bool) {
    if let Ok(mut m) = PENDING.lock() {
        if let Some(p) = m.as_mut().and_then(|m| m.get_mut(id)) {
            p.performing = on;
        }
    }
}

fn perform(app: &AppHandle, id: &str, session_id: &str, blocker: Option<&str>) -> Result<Renewed, String> {
    {
        let mut m = PENDING.lock().map_err(|e| e.to_string())?;
        let Some(p) = m.as_mut().and_then(|m| m.get_mut(id)) else {
            return Err(format!("{NOT_SCHEDULED} no renewal is scheduled for {}", crate::relay::handle_of(id)));
        };
        /* Performed already — a front end that reloaded between the repoint and
           its wake asks again, and is answered with what was done. */
        if let Some(s) = &p.cleared {
            return Ok(Renewed { session: s.clone(), stopped: false });
        }
        if p.performing {
            return Err(format!("{BUSY} this card is already being renewed"));
        }
        p.performing = true;
    }
    let store = app.try_state::<Store>().ok_or_else(|| {
        set_performing(id, false);
        "the wall's store is not available".to_string()
    })?;
    /* Rows are only work at risk while the process holding them lives: a card
       whose process has already gone lost its jobs with it, and refusing the
       renewal over them would keep nothing. */
    let alive = app
        .try_state::<crate::supervisor::Supervisor>()
        .is_some_and(|s| s.liveness(id).0);
    let jobs = if alive { store.0.lock().map(|c| jobs_held(&c, id)).unwrap_or(0) } else { 0 };
    let why = match (blocker.map(str::trim).filter(|b| !b.is_empty()), jobs) {
        (Some(b), _) => Some(b.to_string()),
        (None, n) if n > 0 => Some(jobs_said(n)),
        _ => None,
    };
    if let Some(why) = why {
        abandon(app, id, &why);
        return Err(format!("{DROPPED} {why}"));
    }
    let done = crate::supervisor::claimed_for(app, id, |stopped| -> Result<bool, String> {
        {
            let conn = store.0.lock().map_err(|e| e.to_string())?;
            renew_row(&conn, id, session_id)?;
            crate::store::drop_secret_grants(&conn, id)?;
        }
        /* Marked inside the claim, so the first spawn that can reach this card
           already finds it renewed (`spawn_blocks`). */
        if let Ok(mut m) = PENDING.lock() {
            if let Some(p) = m.as_mut().and_then(|m| m.get_mut(id)) {
                p.cleared = Some(session_id.to_string());
                p.performing = false;
            }
        }
        Ok(stopped)
    });
    let stopped = match done {
        Ok(Ok(stopped)) => stopped,
        Ok(Err(e)) => {
            set_performing(id, false);
            return Err(e);
        }
        Err((why, stopped)) => {
            set_performing(id, false);
            /* A process stopped before the claim failed is said, so the front
               end keeps its exit quiet rather than drawing it as a crash. */
            let said = if stopped { " (its old process was stopped)" } else { "" };
            return Err(format!("{BUSY} {why}{said}"));
        }
    };
    if let Some(asks) = app.try_state::<crate::ask::Asks>() {
        crate::ask::drop_handoffs(&asks, id);
    }
    Ok(Renewed { session: session_id.to_string(), stopped })
}

/// One renewal the front end should know about at load: scheduled and waiting
/// for the turn to end, or performed and waiting for its spawn (`session`).
#[derive(Serialize, Clone)]
pub struct PendingRenewal {
    id: String,
    session: Option<String>,
}

/// The renewals this process is holding, read once by the front end at load in
/// case the events it missed were emitted before it was listening — a webview
/// reload mid-renewal. A performed one is included: its card was stopped and
/// repointed and nothing has spawned it yet, so the reloaded wall wakes it.
#[tauri::command]
pub fn renewals_pending() -> Vec<PendingRenewal> {
    PENDING
        .lock()
        .ok()
        .and_then(|m| {
            m.as_ref().map(|m| {
                m.iter()
                    .map(|(k, p)| PendingRenewal { id: k.clone(), session: p.cleared.clone() })
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// `store::clear_row` without the parts that make it a reset: the title and the
/// hand-given name stay, because the renewed card is doing the same work.
fn renew_row(conn: &Connection, id: &str, session_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE conversation SET
               agent_session_id = ?2,
               last_ctx_frac    = 0,
               last_ending      = NULL,
               interrupted      = 0,
               rest_seen        = 0
             WHERE id = ?1 AND closed_at IS NULL",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?;
    /* A closed card is not renewed: closing it while its renewal was being
       performed must not end in a process for a card on no wall. */
    if n == 0 {
        return Err(format!("no open conversation {id}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thin_note_is_refused_and_says_what_a_good_one_holds() {
        let why = refusal("carry on", false, None).unwrap();
        assert!(why.contains("Nothing was changed"));
        assert!(why.contains("in flight"));
        assert_eq!(refusal(&"x".repeat(MIN_NOTE), false, None), None);
    }

    #[test]
    fn a_renewal_cannot_be_stacked_or_looped() {
        let note = "x".repeat(MIN_NOTE);
        assert!(refusal(&note, true, None).unwrap().contains("already waiting"));
        assert!(refusal(&note, false, Some(Duration::from_secs(120))).unwrap().contains("2 minute"));
        assert_eq!(refusal(&note, false, Some(MIN_GAP)), None);
    }

    #[test]
    fn the_note_opens_under_the_relay_mark_and_carries_the_facts() {
        let text = compose("  decided X; waiting on Y  ", "FACTS");
        assert!(text.starts_with(RENEW_HEAD));
        assert!(text.starts_with(crate::relay::RELAY_MARK), "a shape under the mark (relay.md)");
        assert!(text.contains("decided X; waiting on Y\n\nFACTS"));
    }

    #[test]
    fn the_facts_name_children_by_handle_with_their_last_word() {
        let now = 10_000_000;
        let f = Facts {
            children: vec![
                Child {
                    handle: "ab12cd34".into(),
                    title: "fix the parser".into(),
                    state: "idle",
                    last_report: Some(("tests green, pushed".into(), now - 600_000)),
                },
                Child { handle: "ef56ab78".into(), title: "docs".into(), state: "working", last_report: None },
            ],
            far_children: vec![("laptop".into(), "99887766".into())],
            subscriptions: vec![("nova-feedback".into(), "triage new items".into())],
            wakes: vec![(now + 1_800_000, "check CI".into())],
            notices: vec![("reworking store".into(), "src/store.rs".into())],
            queued_questions: 2,
            timeline: Some("round 4".into()),
            transcript: Some("C:/x/y.jsonl".into()),
        };
        let s = say_facts(&f, now);
        assert!(s.contains("`ab12cd34` \"fix the parser\" (idle) — last told you, 10m ago: \"tests green, pushed\""), "{s}");
        assert!(s.contains("`ef56ab78` \"docs\" (working) — has not sent you anything"));
        assert!(s.contains("`99887766` on laptop"));
        assert!(s.contains("nova-feedback: triage new items"));
        assert!(s.contains("in 30m: check CI"));
        assert!(s.contains("reworking store (src/store.rs)"));
        assert!(s.contains("2 question(s)"));
        assert!(s.contains("\"round 4\""));
        assert!(s.contains("`C:/x/y.jsonl`"));
    }

    #[test]
    fn nothing_to_carry_still_says_so() {
        let s = say_facts(&Facts::default(), 0);
        assert!(s.contains("Children: none open"));
        assert!(s.contains("could not be located"));
        assert!(!s.contains("subscriptions"));
    }

    #[test]
    fn a_report_is_quoted_past_its_envelope() {
        assert_eq!(first_line("[skein relay] from \"x\" (ab) in p —\n\ndone: 3 files\nmore"), "done: 3 files");
        assert_eq!(first_line("plain report\nsecond"), "plain report");
    }

    #[test]
    fn the_row_keeps_its_title_and_takes_the_new_session() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation (id TEXT PRIMARY KEY, agent_session_id TEXT, title TEXT,
               named_by_hand INTEGER, last_ctx_frac REAL, last_ending TEXT, interrupted INTEGER,
               rest_seen INTEGER, closed_at INTEGER);
             INSERT INTO conversation VALUES ('c1', 'old', 'RISE Coordinator', 1, 0.6, 'ok', 1, 1, NULL);
             INSERT INTO conversation VALUES ('c2', 'old', 'closed', 0, 0, 'ok', 0, 0, 5);",
        )
        .unwrap();
        renew_row(&conn, "c1", "new").unwrap();
        let (s, t, n, f, e): (String, String, i64, f64, Option<String>) = conn
            .query_row(
                "SELECT agent_session_id, title, named_by_hand, last_ctx_frac, last_ending FROM conversation",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!((s.as_str(), t.as_str(), n, f, e), ("new", "RISE Coordinator", 1, 0.0, None));
        assert!(renew_row(&conn, "nobody", "x").is_err());
        assert!(renew_row(&conn, "c2", "x").is_err(), "a closed card is never renewed");
    }

    fn wall() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversation (id TEXT PRIMARY KEY, cwd TEXT, worktree TEXT, agent_session_id TEXT);
             CREATE TABLE relay (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, body TEXT, chain TEXT,
               hops INTEGER, sent_at INTEGER, delivered_at INTEGER);
             CREATE TABLE job (tool_id TEXT PRIMARY KEY, conversation_id TEXT, session_id TEXT);",
        )
        .unwrap();
        conn
    }

    fn note(conn: &Connection, row: &str, card: &str, chain: &str, at: i64) {
        conn.execute(
            "INSERT INTO relay VALUES (?1, ?2, ?2, 'NOTE', ?3, 0, ?4, NULL)",
            params![row, card, chain, at],
        )
        .unwrap();
    }

    /// The crash between the call and the renewal: nothing is in memory, and the
    /// row alone says the note was written from the session the card is still
    /// on — so the old session is told it was not renewed, not that it was.
    #[test]
    fn a_note_never_acted_on_is_known_from_the_row_alone() {
        let conn = wall();
        conn.execute("INSERT INTO conversation VALUES ('c1', 'C:/x', NULL, 'old')", []).unwrap();
        note(&conn, "n1", "c1", "renew:old", 1);
        assert_eq!(withdraw_notes(&conn, "c1", "the wall restarted."), 1);
        let (body, chain): (String, String) =
            conn.query_row("SELECT body, chain FROM relay WHERE id = 'n1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(body.starts_with(crate::relay::RELAY_MARK), "a shape under the mark: {body}");
        assert!(body.contains("not performed") && body.contains("the wall restarted."), "{body}");
        assert!(!body.contains("fresh session.") , "never says it was renewed: {body}");
        assert_eq!(chain, "", "and is a plain wall message from then on");
    }

    /// Performed: the row points at the new session, so the note — written
    /// from the old one — is the new session's first message and is left alone.
    #[test]
    fn a_note_the_card_was_renewed_onto_is_kept() {
        let conn = wall();
        conn.execute("INSERT INTO conversation VALUES ('c1', 'C:/x', NULL, 'new')", []).unwrap();
        note(&conn, "n1", "c1", "renew:old", 1);
        assert_eq!(withdraw_notes(&conn, "c1", "x"), 0);
        let body: String = conn.query_row("SELECT body FROM relay WHERE id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(body, "NOTE");
    }

    /// A card never cleared has no session column; its session is its own id.
    #[test]
    fn a_card_never_cleared_is_on_its_own_id() {
        let conn = wall();
        conn.execute("INSERT INTO conversation VALUES ('c1', 'C:/x', NULL, NULL)", []).unwrap();
        note(&conn, "n1", "c1", "renew:c1", 1);
        note(&conn, "d1", "c1", "renew:c1", 1);
        conn.execute("UPDATE relay SET delivered_at = 2 WHERE id = 'd1'", []).unwrap();
        assert_eq!(session_now(&conn, "c1"), "c1");
        assert_eq!(withdraw_notes(&conn, "c1", "x"), 1, "only the undelivered one");
    }

    #[test]
    fn only_the_current_session_s_jobs_hold_a_renewal_back() {
        let conn = wall();
        conn.execute("INSERT INTO conversation VALUES ('c1', 'C:/x', NULL, 'now')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO job VALUES ('t1', 'c1', 'before');
             INSERT INTO job VALUES ('t2', 'c1', 'now');
             INSERT INTO job VALUES ('t3', 'c2', 'now');",
        )
        .unwrap();
        assert_eq!(jobs_held(&conn, "c1"), 1);
        assert!(jobs_said(1).contains("1 background job(s)"));
    }

    /// The backstop for a spawn that did not wait for the renewal: refused while
    /// it is being performed, refused on the old session once it is, and let
    /// through on the new one.
    #[test]
    fn a_renewed_card_is_never_spawned_on_the_session_it_left() {
        let id = "renewtest-spawn-blocks";
        let set = |p: Option<Pending>| {
            let mut m = PENDING.lock().unwrap();
            let m = m.get_or_insert_with(HashMap::new);
            match p {
                Some(p) => m.insert(id.into(), p),
                None => m.remove(id),
            };
        };
        set(Some(Pending { cleared: None, performing: false }));
        assert_eq!(spawn_blocks(id, "old"), None, "scheduled only: release answers it");
        assert!(scheduled(id));
        set(Some(Pending { cleared: None, performing: true }));
        assert!(spawn_blocks(id, "old").unwrap().contains("being renewed"));
        set(Some(Pending { cleared: Some("new".into()), performing: false }));
        assert!(!scheduled(id), "performed is not scheduled: compact may queue, holding stops");
        assert!(spawn_blocks(id, "old").unwrap().contains("refusing to resume"));
        assert_eq!(spawn_blocks(id, "new"), None);
        forget(id);
        assert_eq!(spawn_blocks(id, "old"), None);
        assert!(!pending_has(id));
    }

    /// A clear retires every undelivered note, whichever session it names, and
    /// nothing else in the inbox.
    #[test]
    fn a_clear_takes_the_note_and_leaves_the_post() {
        let conn = wall();
        note(&conn, "n1", "c1", "renew:old", 1);
        note(&conn, "n2", "c1", "renew:older", 1);
        note(&conn, "p1", "c1", "", 2);
        note(&conn, "x1", "c9", "renew:old", 1);
        assert_eq!(drop_notes(&conn, "c1"), 2);
        let left: Vec<String> =
            crate::store::inbox(&conn, "c1").unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(left, ["p1"]);
        assert_eq!(crate::store::inbox(&conn, "c9").unwrap().len(), 1, "another card's note is its own");
    }

    /// The note and whatever is held behind it are written in the same
    /// millisecond often enough to matter; the inbox breaks the tie by rowid,
    /// so the note still goes first.
    #[test]
    fn the_inbox_breaks_a_tie_by_order_written() {
        let conn = wall();
        for (row, at) in [("z-note", 5), ("a-held", 5), ("m-later", 6)] {
            note(&conn, row, "c1", "", at);
        }
        let order: Vec<String> = crate::store::inbox(&conn, "c1").unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(order, ["z-note", "a-held", "m-later"]);
    }
}
