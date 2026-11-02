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
//! 3. **Nothing sent to the card in between is lost.** From the moment the tool
//!    is called until the new process drains its inbox, every `deliver` to the
//!    card is written to the inbox instead (`hold`), behind the note — so a
//!    child's report that lands mid-renewal is read by the new session, after it
//!    knows who that child is. The note is the first inbox row because it is
//!    written first.
//!
//! The card cannot end its own process mid-turn, so the tool only *schedules*:
//! the front end performs the renewal once the card's turn is over
//! (`Skein.renew`), exactly as it performs a clear, because the front end is the
//! one place that holds what a respawn needs (`relay.md`, "Rust asks; the
//! webview spawns").

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

/// One renewal per card per this long, counted when it is scheduled. A fresh
/// session that renews again at once is a loop with a full-context turn at the
/// front of every lap; an hour is far shorter than any round worth renewing at.
pub const MIN_GAP: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
struct Pending {
    /// The inbox row holding the note, so a renewal that never happened can take
    /// it back rather than hand a false "you were renewed" to the old session.
    note_row: String,
    /// Whether `renew_conversation` has repointed the session yet.
    cleared: bool,
}

static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);
static LAST: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn pending_has(id: &str) -> bool {
    PENDING.lock().ok().and_then(|m| m.as_ref().map(|m| m.contains_key(id))).unwrap_or(false)
}

/// Whether deliveries to this card are being held for its next session.
pub fn holding(id: &str) -> bool {
    pending_has(id)
}

/// `supervisor::deliver_blocks`' one call: put what would have gone into the
/// card's stdin into its inbox instead, behind the note. Text only — every Rust
/// caller of `deliver` composes words — and an attachment you typed into a
/// renewing card is said to be missing rather than silently dropped.
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
    /* A self-row: `drain_inbox` hands it over as written, and every caller of
       `deliver` has already put its own envelope on the text. */
    crate::store::record_relay(&conn, &crate::store::uuid_v4(), id, id, &text, "", 0, false)
}

/// Called by `spawn_now` immediately before it drains the inbox: from here the
/// card has a process again and its post goes out in order. A renewal that was
/// scheduled and never performed — the card was woken on its *old* session —
/// takes its note back first, or the old session would be told it had been
/// renewed when it had not; whatever was held is still delivered.
pub fn release(app: &AppHandle, id: &str) {
    let gone = PENDING.lock().ok().and_then(|mut m| m.as_mut()?.remove(id));
    let Some(p) = gone else { return };
    if !p.cleared {
        if let Some(store) = app.try_state::<Store>() {
            if let Ok(conn) = store.0.lock() {
                let _ = conn.execute(
                    "DELETE FROM relay WHERE id = ?1 AND delivered_at IS NULL",
                    params![p.note_row],
                );
            }
        }
    }
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

fn read_facts(app: &AppHandle, conn: &Connection, id: &str) -> Facts {
    let mut f = Facts::default();
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
            let state = match crate::supervisor::turn_open(app, &child) {
                Some(true) => "working",
                Some(false) => "idle",
                None => "dormant",
            };
            f.children.push(Child {
                handle: crate::relay::handle_of(&child),
                title,
                state,
                last_report: last,
            });
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
    f.transcript = crate::store::session_of(conn, id)
        .and_then(|(dir, session)| session.map(|s| (dir, s)))
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
    let row = crate::store::uuid_v4();
    {
        let Ok(conn) = store.0.lock() else {
            return "Not scheduled: the wall's store is busy; try again.".into();
        };
        let facts = say_facts(&read_facts(app, &conn, caller), crate::store::now());
        let text = compose(note, &facts);
        /* First into the inbox, so first out of it: everything held after this
           line is written behind it. */
        if let Err(e) = crate::store::record_relay(&conn, &row, caller, caller, &text, "", 0, false) {
            return format!("Not scheduled: the note could not be written down ({e}). Nothing was changed.");
        }
    }
    if let Ok(mut m) = PENDING.lock() {
        m.get_or_insert_with(HashMap::new)
            .insert(caller.to_string(), Pending { note_row: row, cleared: false });
    }
    if let Ok(mut m) = LAST.lock() {
        m.get_or_insert_with(HashMap::new).insert(caller.to_string(), Instant::now());
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

/// Repoint a card at a fresh session for a scheduled renewal, keeping
/// everything `store::clear_conversation` lets go of. The process has already
/// been closed by the caller (`Skein.renew`), exactly as for a clear.
///
/// What it still lets go of, and why: credentials lent to the old conversation
/// (`drop_secret_grants` — the person agreed for what *that* conversation said
/// it needed; the new one can ask), and the delete hand-offs parked for the old
/// process (`drop_handoffs` — the turn that asked is over). Holding is not
/// released here: the card is about to be dormant until it spawns, and a
/// delivery in that gap must still go to the inbox behind the note.
#[tauri::command]
pub fn renew_conversation(
    app: AppHandle,
    store: tauri::State<'_, Store>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    if !pending_has(&id) {
        return Err(format!("no renewal is scheduled for {}", crate::relay::handle_of(&id)));
    }
    {
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        renew_row(&conn, &id, &session_id)?;
        crate::store::drop_secret_grants(&conn, &id)?;
    }
    if let Some(asks) = app.try_state::<crate::ask::Asks>() {
        crate::ask::drop_handoffs(&asks, &id);
    }
    if let Ok(mut m) = PENDING.lock() {
        if let Some(p) = m.as_mut().and_then(|m| m.get_mut(&id)) {
            p.cleared = true;
        }
    }
    Ok(())
}

/// The cards with a renewal scheduled and not yet performed — read once by the
/// front end at load, in case the `renew:asked` it missed was emitted before it
/// was listening (a webview reload mid-renewal).
#[tauri::command]
pub fn renewals_pending() -> Vec<String> {
    PENDING
        .lock()
        .ok()
        .and_then(|m| m.as_ref().map(|m| m.iter().filter(|(_, p)| !p.cleared).map(|(k, _)| k.clone()).collect()))
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
             WHERE id = ?1",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no conversation {id}"));
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
               rest_seen INTEGER);
             INSERT INTO conversation VALUES ('c1', 'old', 'RISE Coordinator', 1, 0.6, 'ok', 1, 1);",
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
    }
}
