//! Being away from the wall, and the questions that wait for you.
//!
//! `ask_user` parks an HTTP request until you click, and every clock either
//! side of that connection is measured in minutes — `ANSWER_MAX` is 45 of them
//! and `ask.rs` spends two thousand words on the three watchdogs it took to get
//! that far. Which is right for a question asked while you are at the wall and
//! useless for one asked at seven in the evening when you have gone home: the
//! card asks, nobody is there, and the question is gone by a quarter to eight.
//! What the agent is handed is "nobody answered, carry on" — so it decides
//! alone, or loses the question, and either way the morning starts with a
//! decision already taken by something that did not want to take it.
//!
//! Away mode's whole move is that **a deferred question is not parked at all**.
//! The `tools/call` returns immediately with a note saying it was queued, the
//! card carries on with whatever does not depend on the answer, and the answer
//! arrives later as a new turn. Nothing is held open, so none of the three
//! clocks is in play — which is why this is a few hundred lines rather than
//! another round with Bun's `fetch` timeout.
//!
//! See `.claude/rules/away.md` for the rest of away mode: the silence, the
//! morning pile, and what the wall does with nobody watching.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::Store;

/// What a card calls to put the wall into away mode.
pub const AWAY_TOOL: &str = "away";

/// The most questions one card may have waiting at once.
///
/// A bound rather than a courtesy. An agent that asks, is told it was queued,
/// and asks again is a loop with nobody awake to notice it, and what it
/// produces is a morning pile nobody can read — which is the one way this
/// feature fails *worse* than the timeout it replaces, since a timeout at least
/// forgets. Past the bound the tool says so in as many words and tells the card
/// to decide for itself, which is the same answer the timeout gave and is now
/// an answer given in one call instead of after forty-five minutes.
const MAX_PER_CARD: usize = 8;

/// The first words of what a deferred call is answered with.
///
/// `park_and_stream` matches on this to tell a conversion from an answer, the
/// way it already matches `TIMED_OUT_OPENING` — see `defer_parked`, which is
/// the only thing that puts this string on a channel somebody is listening to.
pub const DEFERRED_OPENING: &str = "Volery is in away mode.";

/// What the asking card is told. The whole contract with the agent is in here
/// rather than in the tool's schema, and that is deliberate: `ask_user` is an
/// `alwaysLoad` tool, so every byte of its description is paid on every spawn of
/// every card for ever, while this text costs nothing until the one turn it is
/// true of — and lands in front of the model at exactly the moment it needs to
/// know. See `ask.rs`'s note on the two tiers for the arithmetic.
///
/// Four things it has to say, and each of them is a way this goes wrong without
/// it: the question is **not** lost (or the agent re-asks), nothing has been
/// decided (or the agent reads a non-answer as consent), the answer arrives as
/// a *message* rather than as this call's result (or the agent waits for a
/// return value that already came), and asking again queues a second copy (or
/// the morning pile is the same question eleven times).
fn deferred_note(queued: usize) -> String {
    format!(
        "{DEFERRED_OPENING} The user is not at the wall, so your question was \
         **queued** rather than put to them — nothing timed out and nothing was \
         lost. There are now {queued} of your questions waiting.\n\n\
         Nothing has been decided. When the user returns they will be shown \
         every question that piled up, and their answer will arrive in this \
         conversation as a new message naming the question it answers.\n\n\
         What to do now: carry on with whatever does not depend on this answer, \
         and say in your closing line what you are holding back and why. Do not \
         decide it unilaterally — it was worth asking, and it is still worth \
         asking. Do not ask it again: a second call queues a second copy of the \
         same question, and the user reads the pile by hand. If everything you \
         have left depends on this answer, stop here and say so."
    )
}

/// What the tool answers when a card has filled its share of the pile.
fn pile_full() -> String {
    format!(
        "{DEFERRED_OPENING} The user is away, and you already have {MAX_PER_CARD} \
         questions queued — which is as many as one card may leave for one \
         person to read. This question was **not** queued.\n\n\
         Treat it as you would a question that timed out: decide it yourself on \
         the best reasoning you have, write down what you decided and why, and \
         say so plainly in your closing line so it can be revisited. If you are \
         genuinely blocked, stop and say what on."
    )
}

/// Whether the wall is away, and since when.
///
/// Held in memory and mirrored to the store, rather than read from SQLite on
/// every `ask_user`: the question is asked on the server thread answering a
/// `tools/call`, which must not take the store lock behind a slow write to find
/// out whether to park.
#[derive(Default)]
pub struct Presence {
    since: Mutex<Option<i64>>,
    /// What was said on the way out, in the user's own words, when a card was
    /// the one told. Kept in memory only: it is worth nothing after the night
    /// it was said, and a restart that forgets it costs a line on a screen
    /// nobody was reading.
    note: Mutex<Option<String>>,
}

impl Presence {
    pub fn since(&self) -> Option<i64> {
        *self.since.lock().unwrap()
    }
    pub fn note(&self) -> Option<String> {
        self.note.lock().unwrap().clone()
    }
    fn set(&self, at: Option<i64>, note: Option<String>) {
        *self.since.lock().unwrap() = at;
        *self.note.lock().unwrap() = note;
    }
}

/// Read what the store remembers into the state, once, at setup.
///
/// It survives a restart in the one direction that matters. A wall that goes
/// down at two in the morning and comes back believing you are at it resumes
/// parking questions against a deadline nobody is going to meet, and resumes
/// throwing peek windows at an empty room — the two things away mode exists to
/// stop, undone by a crash nobody saw.
pub fn load(app: &AppHandle) {
    let Some(store) = app.try_state::<Store>() else { return };
    let since = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::read_away_since(&conn)
    };
    if let Some(p) = app.try_state::<Presence>() {
        p.set(since, None);
    }
}

/// Is the wall away? Every failure is `false` — see `store::read_away_since`
/// for why the fallback has to be "you are here".
pub fn away(app: &AppHandle) -> bool {
    app.try_state::<Presence>()
        .and_then(|p| p.since())
        .is_some()
}

#[derive(Clone, Serialize)]
pub struct PresenceChanged {
    away_since: Option<i64>,
    /// What was said on the way out, where anybody said anything.
    note: Option<String>,
    /// Who flipped it — `"you"` or a card's handle. The wall says so when it
    /// was not you, because away mode changes what every card on the wall is
    /// told, and a switch that threw itself is one you would have to go
    /// looking for the cause of.
    by: String,
}

#[derive(Clone, Serialize)]
struct AskDeferred {
    conversation_id: String,
    id: String,
    asked_at: i64,
}

/* ── going away, and coming back ──────────────────────────────────────────── */

/// Flip the switch. Returns when we went away, or `None` for back at the wall.
fn flip(
    app: &AppHandle,
    away: bool,
    by: &str,
    note: Option<String>,
) -> Result<Option<i64>, String> {
    let now = crate::store::now();
    let since = if away { Some(now) } else { None };

    let Some(p) = app.try_state::<Presence>() else {
        return Err("no presence on this wall".into());
    };
    /* Idempotent, and the early return matters rather than being tidy: going
       away twice must not move `away_since` forward, or the morning pile
       reports how long since the *last* agent said so instead of how long you
       were gone. */
    if p.since().is_some() == away {
        return Ok(p.since());
    }
    p.set(since, if away { note } else { None });

    if let Some(store) = app.try_state::<Store>() {
        if let Ok(conn) = store.0.lock() {
            crate::store::save_away_since(&conn, since)?;
        }
    }

    let _ = app.emit(
        "presence:changed",
        PresenceChanged {
            away_since: since,
            note: p.note(),
            by: by.to_string(),
        },
    );

    /* After the state is set, never before: `defer_parked` writes rows that are
       only correct if a question arriving in the same millisecond would also be
       deferred, and a card answering an `ask_user` between the two would park
       against a wall that has already gone quiet. */
    if away {
        defer_parked(app);
    }
    Ok(since)
}

/// Queue one question and say what the asking card is told.
///
/// The row is written before the note is composed, so the count in it is the
/// count including this one — which is what a card reading "there are now 3 of
/// your questions waiting" means by it.
pub fn defer(app: &AppHandle, conversation_id: &str, args: &Value) -> String {
    let Some(store) = app.try_state::<Store>() else {
        /* No store is no queue, and a note promising the question was kept
           would be a lie told to the one party that cannot check. */
        return pile_full();
    };
    let id = crate::store::uuid_v4();
    let at = crate::store::now();

    let queued = {
        let Ok(conn) = store.0.lock() else { return pile_full() };
        let mine = crate::store::deferred_asks(&conn)
            .iter()
            .filter(|d| d.conversation_id == conversation_id)
            .count();
        if mine >= MAX_PER_CARD {
            return pile_full();
        }
        if crate::store::defer_ask(&conn, &id, conversation_id, &args.to_string(), at).is_err() {
            return pile_full();
        }
        mine + 1
    };

    let _ = app.emit(
        "ask:deferred",
        AskDeferred {
            conversation_id: conversation_id.to_string(),
            id,
            asked_at: at,
        },
    );
    deferred_note(queued)
}

/// Turn every question *already* on the wall into a deferred one.
///
/// You flip the switch at seven in the evening; a card asked at five to. Left
/// alone that question is parked against a deadline nobody is going to meet,
/// which is the exact loss away mode exists to prevent, five minutes before it
/// was switched on.
///
/// **A question Volery composed is not converted**, and the asymmetry is about
/// what an answer *is* rather than about effort. An `ask_user` answer is
/// information: it goes back to the agent as a turn, and the agent decides what
/// to do with it with its own context in hand. `close`, `unpost` and the
/// `remove` hand-off carry a `Settle` — the answer is a *decision*, and
/// approving one twelve hours later means Volery performing an irreversible act
/// against a wall that has moved on, with no agent left to tell and nothing to
/// catch it if the premise changed. Their unanswered behaviour is already the
/// conservative one — the card stays, the notice stays, the delete is refused —
/// and "nobody was there" is the right input to those, where it is the wrong
/// input to a product question.
fn defer_parked(app: &AppHandle) {
    let Some(asks) = app.try_state::<crate::ask::Asks>() else { return };
    for (conversation_id, args, tx) in crate::ask::take_parked_questions(&asks) {
        let note = defer(app, &conversation_id, &args);
        /* The park is listening on this channel and recognises the opening, so
           what the agent reads is the note and what the wall draws is a
           question taken down rather than one nobody answered. A send that
           fails is a turn that has already gone; the row stays queued, which is
           the right way round — the question is still worth an answer even if
           the card that asked it has to be told about it later. */
        let _ = tx.send(note);
    }
}

/* ── commands ─────────────────────────────────────────────────────────────── */

/// Where the user is, as far as the wall knows. Read once on load and then
/// folded off `presence:changed` like everything else here.
#[derive(Serialize)]
pub struct PresenceState {
    pub away_since: Option<i64>,
    pub note: Option<String>,
}

#[tauri::command]
pub fn presence_read(presence: State<'_, Presence>) -> PresenceState {
    PresenceState {
        away_since: presence.since(),
        note: presence.note(),
    }
}

/// The user saying where they are. The only path that may say *back* — see
/// `schema`.
#[tauri::command]
pub fn set_presence(
    app: AppHandle,
    away: bool,
    note: Option<String>,
) -> Result<Option<i64>, String> {
    flip(&app, away, "you", note)
}

#[derive(Serialize)]
pub struct DeferredRow {
    pub id: String,
    pub conversation_id: String,
    /// Parsed back out of the stored text, so the front end reads the same
    /// shape `ask:opened` hands it and `normalizeAsk` is the only thing that
    /// decides what a question is. A row this build cannot parse degrades to an
    /// empty object rather than being dropped: `normalizeAsk` is written to
    /// make something askable out of anything, and a question silently missing
    /// from the pile is the one failure nobody can see.
    pub ask: Value,
    pub asked_at: i64,
}

#[tauri::command]
pub fn deferred_asks(store: State<'_, Store>) -> Vec<DeferredRow> {
    let Ok(conn) = store.0.lock() else { return Vec::new() };
    crate::store::deferred_asks(&conn)
        .into_iter()
        .map(|d| DeferredRow {
            id: d.id,
            conversation_id: d.conversation_id,
            ask: serde_json::from_str(&d.ask_json).unwrap_or_else(|_| json!({})),
            asked_at: d.asked_at,
        })
        .collect()
}

/// Claim one, so it cannot be answered twice.
///
/// Called *before* the answer is sent to the card, `later::serve_due`'s
/// ordering and its reasoning: an interruption between the two loses an answer,
/// where the other order hands a card the same decision twice.
#[tauri::command]
pub fn take_deferred_ask(store: State<'_, Store>, id: String) -> bool {
    let Ok(conn) = store.0.lock() else { return false };
    crate::store::take_deferred_ask(&conn, &id)
}

/// A card is going, or has been cleared. Its queued questions go with it —
/// `later::clear_for`'s argument exactly: an answer is worth nothing once there
/// is nobody left to hand it to, and a card that has been reset is not the
/// conversation that asked.
pub fn clear_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let Ok(conn) = store.0.lock() else { return };
    crate::store::drop_deferred_asks_of(&conn, conversation_id);
}

/* ── the tool ─────────────────────────────────────────────────────────────── */

/// **Away only, and never back.** A card may say you have gone and may not say
/// you have returned, which is not a courtesy about who owns the wall — it is
/// about which direction the mistake runs in. Saying "away" wrongly costs a
/// question being queued instead of asked, and the queue is read the moment you
/// touch the wall. Saying "back" wrongly re-arms every peek, every chime and
/// every parking deadline, in a room with nobody in it, and nothing finds out
/// until the morning shows a pile of questions that expired.
///
/// So "back" is a claim about where a person is that only that person can make.
pub fn schema() -> Value {
    json!({
        "name": AWAY_TOOL,
        "description":
            "Tell the wall the user has gone — they said they are off, going to bed, \
             out for the evening. Call it the moment they say so, in whatever words.\n\n\
             It changes what happens to every card here, not just yours: no card \
             raises a window, rings or flashes the taskbar, and `mcp__skein__ask_user` stops \
             parking. A question asked while away is **queued** instead and your turn \
             carries on — see what that call answers you with, which is where the \
             rules for a deferred question are.\n\n\
             It cannot say they are back. That is a claim about where a person is, and \
             only the person at the wall can make it; getting it wrong re-arms every \
             notification in an empty room. If they tell you they are back, say that \
             the wall is still in away mode and they can end it themselves — space \
             then z, or the away button in the header.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": {
                    "type": "string",
                    "description":
                        "Optional. What they said, in their words — 'off for the \
                         night', 'back around nine'. Shown on the away screen, so \
                         whoever walks past knows what the wall is waiting for."
                }
            },
            "additionalProperties": false
        }
    })
}

/// Route a `tools/call` that belongs here.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    if tool != AWAY_TOOL {
        return None;
    }
    let was = away(app);
    let handle = &conversation_id[..conversation_id.len().min(8)];
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    match flip(app, true, handle, note) {
        Ok(_) if was => Some(
            "The wall was already in away mode, and still is. Nothing changed — \
             questions are being queued and the notifications are off."
                .into(),
        ),
        Ok(_) => Some(
            "The wall is in away mode. Every card is quiet — no peek, no chime, no \
             taskbar — and `mcp__skein__ask_user` now queues a question instead of parking on it, \
             so asking one no longer costs you your turn.\n\n\
             You cannot end this; only the user can, from the wall itself. Carry on \
             with the work you were given, and ask what you need to ask — that is what \
             the queue is for. If you are about to stop for want of a decision, queue \
             the decision first: a question in the pile is one they can answer at a \
             glance in the morning, where a card stopped with nothing filed is a \
             morning spent working out what you wanted.\n\n\
             Say in your closing line what you got through and what is waiting on an \
             answer."
                .into(),
        ),
        Err(e) => Some(format!("the wall could not be put into away mode: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deferred_call_tells_the_agent_all_four_things() {
        let note = deferred_note(3);
        assert!(note.starts_with(DEFERRED_OPENING), "the park matches on this");
        /* Not lost; nothing decided; the answer comes as a message; do not
           re-ask. Each of these is a way the feature fails without it. */
        assert!(note.contains("queued"));
        assert!(note.contains("nothing was lost"));
        assert!(note.contains("Nothing has been decided"));
        assert!(note.contains("new message"));
        assert!(note.contains("Do not ask it again"));
        assert!(note.contains("3 of your questions"));
    }

    #[test]
    fn a_full_pile_reads_as_a_timeout_rather_than_as_a_queue() {
        let note = pile_full();
        assert!(note.starts_with(DEFERRED_OPENING));
        assert!(note.contains("**not** queued"), "it must not claim to have kept it");
        assert!(note.contains("decide it yourself"));
    }

    #[test]
    fn the_tool_says_it_cannot_say_you_are_back() {
        let s = schema();
        let d = s["description"].as_str().unwrap();
        assert!(d.contains("cannot say they are back"));
        /* The way out has to be in the same paragraph as the refusal, or a card
           told "no" has nothing to tell the user. */
        assert!(d.contains("space then z"));
    }

    #[test]
    fn the_tool_takes_no_argument_that_could_end_away_mode() {
        let s = schema();
        let props = s["inputSchema"]["properties"].as_object().unwrap();
        assert_eq!(props.len(), 1, "only `note`");
        assert!(props.contains_key("note"));
        assert_eq!(s["inputSchema"]["additionalProperties"], json!(false));
    }
}
