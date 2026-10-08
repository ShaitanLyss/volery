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

/// The first words of a question that went to the pile because **nobody got to
/// it**, rather than because the wall was away.
///
/// A second opening rather than a second meaning for the first one, because
/// `DEFERRED_OPENING` is a sentence the agent reads and "Volery is in away
/// mode" is simply false here — the user is at the wall, the question was
/// drawn, and it stood there until the clock ran out. Telling a model
/// something false about the state of the world to reuse a string is the kind
/// of economy that gets reasoned from later.
///
/// Everything *after* the opening is shared, and that is the point: the four
/// things `deferred_note` has to say are the same four either way, because
/// what happened to the question is the same. See `Queued`.
pub const UNATTENDED_OPENING: &str = "Volery queued your question.";

/// Why a question went to the pile instead of being answered.
///
/// It only ever changes the opening sentence. The rest of the contract — not
/// lost, nothing decided, the answer arrives as a message, do not ask again —
/// is a property of being queued and not of the reason for it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Queued {
    /// The switch was on. The question was never drawn.
    Away,
    /// It was drawn, it stood on the wall, and its deadline passed. Sink
    /// `7264177f`: a timeout used to tell the agent to proceed on its own best
    /// judgement, which is the same conflation `SKIPPED` was split out of one
    /// layer up — running out of time is not a decision, and the cost of
    /// reading it as one is asymmetric in the direction that pushes code.
    Unattended,
}

impl Queued {
    fn opening(self) -> &'static str {
        match self {
            Queued::Away => DEFERRED_OPENING,
            Queued::Unattended => UNATTENDED_OPENING,
        }
    }

    /// Why it was queued, as the clause that follows the opening.
    fn because(self) -> &'static str {
        match self {
            Queued::Away => "The user is not at the wall, so your question was \
                             **queued** rather than put to them",
            Queued::Unattended => "It stood on the wall and the user did not get to it \
                                   in time, so rather than expiring it was **queued** \
                                   for them to answer later",
        }
    }

    /// Why a sheet stopped partway, as the sentence that opens what the agent
    /// is told about the questions left on it. See `rest_note`.
    fn partway(self) -> &'static str {
        match self {
            Queued::Away => "The user left the wall partway through answering.",
            Queued::Unattended => "The user stopped partway through answering, and the \
                                   call's time ran out.",
        }
    }
}

/// Is this reply one of Volery's own queueing notes rather than an answer?
///
/// Both openings, in one place, because `park_and_stream` asks this question
/// about a string on a channel and a second opening added here must not need a
/// second `starts_with` found by reading. The same bargain the TS side strikes
/// in `asking.ts`'s `UNANSWERED`, and for the same reason.
pub fn is_deferral(answer: &str) -> bool {
    answer.starts_with(DEFERRED_OPENING)
        || answer.starts_with(UNATTENDED_OPENING)
        || answer.starts_with(crate::notice::QUEUED_OPENING)
}

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
fn deferred_note(queued: usize, why: Queued) -> String {
    let (opening, because) = (why.opening(), why.because());
    format!(
        "{opening} {because} — nothing was \
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

/// What the asking card is told about the questions it did **not** get answers
/// to, when it did get some (`defer_rest`).
///
/// It follows the answers, inside the same reply, so it is written as the
/// second half of something rather than as an opening: the `not reached` slots
/// above it are what "the questions marked `not reached`" points at. The four
/// things `deferred_note` has to say are still the four things — not lost,
/// nothing decided, the answer comes as a message, do not ask again — narrowed
/// to the questions they are true of, plus the one thing that is new: **the
/// answers above stand.** An agent told "nothing has been decided" in the same
/// reply as four decisions has to work out which of the two to believe, and the
/// cautious reading throws the four away, which is the loss this exists to
/// prevent arriving by a politer route.
fn rest_note(queued: usize, why: Queued) -> String {
    let partway = why.partway();
    format!(
        "{partway} Volery queued the questions marked `not reached` for them to \
         answer later — nothing about those was lost, and nothing about them has \
         been decided. There are now {queued} of your questions waiting.\n\n\
         The answers above are the user's own and they stand: act on them now. \
         Answers to the ones not reached will arrive in this conversation as a \
         new message naming them. Until then, carry on with whatever they do not \
         gate, and say in your closing line what you are holding back and why. \
         Do not decide them unilaterally, and do not ask them again: a second \
         call queues a second copy, and the user reads the pile by hand."
    )
}

/// `pile_full`, for the questions left on a sheet that was partly answered.
///
/// The answers given still stand — they are in the reply above this — so the
/// one case where an agent must decide for itself is narrowed to the questions
/// it got nothing for.
fn rest_full(why: Queued) -> String {
    let partway = why.partway();
    format!(
        "{partway} The questions marked `not reached` could **not** be queued: you \
         already have {MAX_PER_CARD} questions waiting, which is as many as one \
         card may leave for one person to read.\n\n\
         The answers above are the user's own and they stand: act on them. For the \
         ones not reached there is nowhere left to put them, so decide them \
         yourself on the best reasoning you have, writing down what you decided \
         and why, and saying so plainly in your closing line so it can be \
         revisited. If you are genuinely blocked, stop and say what on."
    )
}

/// What the tool answers when a card has filled its share of the pile.
fn pile_full(why: Queued) -> String {
    let opening = why.opening();
    format!(
        "{opening} You already have {MAX_PER_CARD} \
         questions queued — which is as many as one card may leave for one \
         person to read. This question was **not** queued.\n\n\
         This is the one case where there is nowhere left to put the \
         question, so decide it yourself: on the best reasoning you have, \
         writing down what you decided and why, and saying so plainly in your \
         closing line so it can be revisited. If you are genuinely blocked, \
         stop and say what on."
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
        /* And the notices already up go to the pile with them — the same move
           made on the same edge, so coming back reads one pile. */
        crate::notice::went_away(app);
    }
    Ok(since)
}

/// Queue one question and say what the asking card is told.
///
/// The row is written before the note is composed, so the count in it is the
/// count including this one — which is what a card reading "there are now 3 of
/// your questions waiting" means by it.
pub fn defer(app: &AppHandle, conversation_id: &str, args: &Value, why: Queued) -> String {
    match file(app, conversation_id, args) {
        Some(queued) => deferred_note(queued, why),
        None => pile_full(why),
    }
}

/// Hand an agent the answers already given on a sheet that closed partway,
/// and queue what is left of it.
///
/// `said` is the reply as far as it goes, composed by the panel
/// (`asking.ts::heldAnswer`), and `rest` the questions not reached, as an ask
/// the pile can hold. What is added here is the only part the panel cannot
/// know: whether there was room for the rest, and why it came to be left.
/// `rest` absent is a sheet answered in full and never sent, which `said`
/// already says, so there is nothing to queue and nothing to add. See
/// `ask::Held`, and sink `fdc6954b` for what this used to cost.
pub fn defer_rest(
    app: &AppHandle,
    conversation_id: &str,
    said: &str,
    rest: Option<&Value>,
    why: Queued,
) -> String {
    let Some(rest) = rest else { return said.to_string() };
    let note = match file(app, conversation_id, rest) {
        Some(queued) => rest_note(queued, why),
        None => rest_full(why),
    };
    rest_reply(said, &note)
}

/// The two halves joined. After `said`'s own aside and with no marker of its
/// own, so the transcript's fold (`answerNote`, which cuts at the *last*
/// marker) keeps this with Skein's other words to the agent rather than
/// drawing it as a line the user wrote.
fn rest_reply(said: &str, note: &str) -> String {
    format!("{said}\n\n{note}")
}

/// Write one question into the pile, and say how many this card now has
/// there — or `None` when it could not be kept, for whatever reason.
fn file(app: &AppHandle, conversation_id: &str, args: &Value) -> Option<usize> {
    /* No store is no queue, and a note promising the question was kept would
       be a lie told to the one party that cannot check. */
    let store = app.try_state::<Store>()?;
    let id = crate::store::uuid_v4();
    let at = crate::store::now();

    let queued = {
        let conn = store.0.lock().ok()?;
        let mine = crate::store::deferred_asks(&conn)
            .iter()
            .filter(|d| d.conversation_id == conversation_id)
            .count();
        if mine >= MAX_PER_CARD {
            return None;
        }
        crate::store::defer_ask(&conn, &id, conversation_id, &args.to_string(), at).ok()?;
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
    Some(queued)
}

/// Turn every question *already* on the wall into a deferred one.
///
/// You flip the switch at seven in the evening; a card asked at five to. Left
/// alone that question is parked against a deadline nobody is going to meet,
/// which is the exact loss away mode exists to prevent, five minutes before it
/// was switched on.
///
/// **The two piles are different and a question Volery composed goes to the
/// other one.** An `ask_user` answer is information: it goes back to the agent
/// as a turn and the agent decides what to do with it. `close`, `unpost` and
/// the `remove` hand-off carry a `Settle` — the answer is a *decision*, and
/// replaying one twelve hours later would mean Volery performing an
/// irreversible act against a wall that has moved on. So those are filed as
/// requests and re-entered on the way out rather than replayed; see
/// `defer_act`, which is where that whole argument lives.
///
/// What is left parked after this is the third case: a question Volery composed
/// with no request stored beside it, which is `smith` and `docket` — writes to
/// somebody else's service, where re-entry could check nothing about what
/// changed overnight. Those still time out, and their unanswered behaviour is
/// the conservative one.
fn defer_parked(app: &AppHandle) {
    let Some(asks) = app.try_state::<crate::ask::Asks>() else { return };
    for taken in crate::ask::take_parked_questions(&asks) {
        let crate::ask::Taken { conversation_id, question, act, held, tx } = taken;
        /* A question Volery composed goes to the *act* pile, which is what the
           request stored beside it is for: its answer is a decision rather than
           a message, and replaying a decision twelve hours later is the thing
           away mode refuses to do. See `defer_act`. */
        let note = match act {
            Some((tool, args)) => {
                defer_act(app, &conversation_id, &tool, &args, &question, "it")
            }
            /* A card's notice that was waiting is not a question: it goes into
               the notice queue, marked as one that waited, so a follow-up from
               the pile reaches the card as a message naming it. Filing it with
               the questions would draw it as a question with no question in it. */
            None if crate::notice::is_notice(&question) => {
                let text = question["notice"]["text"].as_str().unwrap_or_default();
                crate::notice::queue(app, &conversation_id, text, crate::notice::Queued::Away)
            }
            /* A sheet the user had started: what they answered goes to the
               card now, and only what they did not reach is queued. */
            None => match held {
                Some(h) => {
                    defer_rest(app, &conversation_id, &h.said, h.rest.as_ref(), Queued::Away)
                }
                None => defer(app, &conversation_id, &question, Queued::Away),
            },
        };
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
    {
        let Some(store) = app.try_state::<Store>() else { return };
        let Ok(conn) = store.0.lock() else { return };
        crate::store::drop_deferred_asks_of(&conn, conversation_id);
    }
    /* Its notices went with them, and the queue the dock reads is a reading
       of the table — it has to be told, or it goes on drawing them. */
    crate::notice::changed(app, Some(conversation_id));
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
            "Tell the wall the user has stepped away — for ten minutes or for the night. \
             Call it the moment they say so, in whatever words: out for lunch, back in \
             twenty, off to the gym, finishing for the day, going to bed. It is the same \
             switch either way and it costs nothing to use for a short one.\n\n\
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
                        "Optional. What they said, in their words — 'back in twenty', \
                         'out for lunch', 'off for the night'. Shown on the away screen, \
                         so whoever walks past knows what the wall is waiting for."
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
             glance when they are back, where a card stopped with nothing filed is \
             somebody working out what you wanted before they can answer it.\n\n\
             Say in your closing line what you got through and what is waiting on an \
             answer."
                .into(),
        ),
        Err(e) => Some(format!("the wall could not be put into away mode: {e}")),
    }
}

/* ── the other pile: things to *do* ───────────────────────────────────────── */

/// What Volery itself asks about, as opposed to what an agent asks.
///
/// Three tools compose their own question — closing a card, taking down a dead
/// card's notice, deleting a path — and for away mode's first day these
/// deliberately went on timing out, on the argument that their unanswered
/// behaviour is already the conservative one.
///
/// **That argument was wrong about what gets lost.** Lyss: *"close unpost
/// remove should be queued somehow instead, if still relevant, otherwise we're
/// going to miss a lot of cleanup — often cards want to remove scratch temp
/// folders they built for their experiments"*. A refusal is safe in the sense
/// that nothing wrong happens, and not safe in the sense that matters: a night
/// of refusals is a tree full of other cards' scratch directories and a board
/// full of notices nobody can take down, and nobody goes back for them.
///
/// The qualifier is the whole design. An act is queued as a **request** — the
/// tool and the arguments the card gave — and answering it **re-enters the
/// decision** rather than replaying it, so twelve hours later the same function
/// that decided to ask is the one that decides what to do, against the wall as
/// it is now. A card that has since started a turn is refused. A notice whose
/// author came back is refused. A directory now holding somebody's unwritten
/// work is refused, because `remove`'s own settle re-checks that too.
pub const ACT_TOOLS: &[&str] =
    &[crate::spawn::CLOSE_TOOL, crate::board::UNPOST_TOOL, REMOVE_ACT];

/// The shell delete has no tool name of its own — it arrives over
/// `ask::REMOVE_PATH` from a hook rather than as a `tools/call` — so the pile
/// needs one to file it under.
pub const REMOVE_ACT: &str = "remove";

/// What a re-entered decision turned out to be.
pub(crate) enum Reentry {
    /// It no longer wants to ask. The string is what the tool would have
    /// answered on the spot, and it is the honest outcome: the premise changed
    /// while you were out.
    Stale(String),
    /// Still worth asking, and this settle is what performs it.
    Live(crate::ask::Settle),
}

/// Ask the tool again, with what the card originally said.
fn reenter(app: &AppHandle, tool: &str, caller: &str, args: &Value) -> Reentry {
    if tool == crate::spawn::CLOSE_TOOL {
        return match crate::spawn::close(app, caller, args) {
            crate::spawn::Closing::Now(said) => Reentry::Stale(said),
            crate::spawn::Closing::Ask { settle, .. } => Reentry::Live(settle),
        };
    }
    if tool == crate::board::UNPOST_TOOL {
        return match crate::board::unpost(app, caller, args) {
            crate::board::Unposting::Now(said) => Reentry::Stale(said),
            crate::board::Unposting::Ask { settle, .. } => Reentry::Live(settle),
        };
    }
    if tool == REMOVE_ACT {
        return match crate::remove::remove(app, caller, args) {
            crate::remove::Writing::Now(said) => Reentry::Stale(said),
            crate::remove::Writing::Ask { settle, .. } => Reentry::Live(settle),
        };
    }
    Reentry::Stale(format!("volery no longer knows how to do `{tool}`"))
}

/// What the asking card is told when its act goes in the pile.
///
/// Unlike a deferred question, the card is **not** waiting for this: the call
/// returns, the turn carries on, and whatever happens arrives later as a
/// message. So the note's job is to stop it doing the thing by hand — a card
/// told "not now" about deleting its own scratch directory will reach for a
/// shell next, which is the one outcome worse than waiting.
fn act_note(what: &str) -> String {
    format!(
        "{DEFERRED_OPENING} The user is not at the wall, so {what} was **queued** for them \
         rather than refused — nothing has happened yet, and nothing is waiting on your \
         turn.\n\n\
         When they are back they will be shown it and decide. Volery asks itself the same \
         question again at that moment, against the wall as it is then, so if the reason has \
         gone by the time they are back it simply will not happen — there is nothing you \
         need to do to cancel it.\n\n\
         What you must not do is go around it. Do not retry, and do not reach for a shell to \
         do it by hand: that is the one way this ends badly, and it is exactly what the queue \
         exists to make unnecessary. Carry on with the rest of your work — a message will \
         arrive saying what came of it."
    )
}

#[derive(Clone, Serialize)]
struct ActDeferred {
    conversation_id: String,
    id: String,
    tool: String,
    asked_at: i64,
}

/// Queue one act, and say what the asking card is told.
pub(crate) fn defer_act(
    app: &AppHandle,
    conversation_id: &str,
    tool: &str,
    args: &Value,
    question: &Value,
    what: &str,
) -> String {
    /* A tool `reenter` does not know would queue an act that can never be
       performed, and the user would read "the wall has moved on" about
       something that had simply never been wired up. Refused at the door
       instead, where the caller is the one that can fix it. */
    if !ACT_TOOLS.contains(&tool) {
        return format!(
            "{DEFERRED_OPENING} The user is away, and `{tool}` is not something Volery can \
             queue for them — so nothing happened and nothing was filed. Leave it, and say \
             in your closing line that it is still waiting."
        );
    }
    let Some(store) = app.try_state::<Store>() else {
        return format!(
            "{DEFERRED_OPENING} The user is away and Volery could not file {what} for them, \
             so nothing happened and nothing is queued. Leave it alone, say so in your \
             closing line, and let them deal with it."
        );
    };
    let id = crate::store::uuid_v4();
    let at = crate::store::now();
    {
        let Ok(conn) = store.0.lock() else {
            return act_note(what);
        };
        let mine = crate::store::deferred_acts(&conn)
            .iter()
            .filter(|d| d.conversation_id == conversation_id)
            .count();
        /* The same bound the questions have, and a second reason for it here: a
           pile of a hundred queued deletes is one nobody can read, and a pile
           nobody reads is a pile approved in bulk. */
        if mine >= MAX_PER_CARD {
            return pile_full(Queued::Away);
        }
        if crate::store::defer_act(
            &conn,
            &id,
            conversation_id,
            tool,
            &args.to_string(),
            &question.to_string(),
            at,
        )
        .is_err()
        {
            return pile_full(Queued::Away);
        }
    }
    let _ = app.emit(
        "act:deferred",
        ActDeferred {
            conversation_id: conversation_id.to_string(),
            id: id.clone(),
            tool: tool.to_string(),
            asked_at: at,
        },
    );
    act_note(what)
}

#[derive(Serialize)]
pub struct DeferredActRow {
    pub id: String,
    pub conversation_id: String,
    pub tool: String,
    /// What was drawn when the card asked. Normalized by `asking.ts` exactly as
    /// a question is — the pile draws it without re-entering anything, because
    /// re-entry reads the whole wall and listing a pile must not.
    pub question: Value,
    pub asked_at: i64,
}

#[tauri::command]
pub fn deferred_acts(store: State<'_, Store>) -> Vec<DeferredActRow> {
    let Ok(conn) = store.0.lock() else { return Vec::new() };
    crate::store::deferred_acts(&conn)
        .into_iter()
        .map(|d| DeferredActRow {
            id: d.id,
            conversation_id: d.conversation_id,
            tool: d.tool,
            question: serde_json::from_str(&d.question_json).unwrap_or_else(|_| json!({})),
            asked_at: d.asked_at,
        })
        .collect()
}

/// Answer one. Answers back with what came of it, for the panel to show.
///
/// The row is taken first and the act attempted second — `store::take_deferred_act`
/// says why, and it is the opposite ordering from a deferred *question*: an
/// answer lost is a card that waits, where an act performed twice is a card
/// closed that somebody had reopened.
#[tauri::command]
pub async fn answer_deferred_act(
    app: AppHandle,
    id: String,
    answer: String,
) -> Result<String, String> {
    crate::off_main(move || {
        let Some(store) = app.try_state::<Store>() else {
            return Err("no store on this wall".to_string());
        };
        let took = {
            let Ok(conn) = store.0.lock() else {
                return Err("the store is busy".to_string());
            };
            crate::store::take_deferred_act(&conn, &id)
        };
        let Some(act) = took else {
            return Err("that is no longer waiting".into());
        };
        let args: Value = serde_json::from_str(&act.args_json).unwrap_or_else(|_| json!({}));

        /* Re-entered rather than replayed, and this is the line the whole
           feature turns on: the function that decided to ask is the function
           that decides what to do, now, with the wall as it is — so an act
           whose reason has gone simply does not happen, and says so. */
        let said = match reenter(&app, &act.tool, &act.conversation_id, &args) {
            Reentry::Stale(said) => {
                format!("it did not happen — the wall has moved on since you were asked. {said}")
            }
            Reentry::Live(settle) => settle(&app, Some(answer.as_str())),
        };
        /* The card is told what came of it, and is **not** roused for it: it
           asked for something to be done rather than for an answer it is
           blocked on, so `later.rs`'s rule holds — spending a process and an
           API turn on a sleeping card with nobody asking is the wrong default.
           A deferred *question* is the deliberate exception, because there you
           are answering something the agent stopped for. */
        tell_late(&app, &act.conversation_id, &act.tool, &said);
        Ok(said)
    })
    .await?
}

/// Tell a card what came of something it asked for hours ago.
///
/// `remove::deliver_late`'s shape generalised to the three acts: a prompt under
/// `RELAY_MARK`'s `from the wall —` heading, which `relay.ts` already draws as
/// *this was not you* — and which is honest here in a way it would not be for
/// an answer to a question, since this genuinely is the wall speaking rather
/// than the user. Dormant, it goes to the inbox a spawn drains.
fn tell_late(app: &AppHandle, card: &str, tool: &str, said: &str) {
    let text = format!(
        "{mark} from the wall —\n\nThe `{tool}` you asked for while the user was away has \
         been put to them, and this is what came of it:\n\n{said}\n\n(This came from the \
         wall rather than from anybody, so nobody is waiting on a reply. Volery asked itself \
         the question again before acting, so if it says nothing happened, nothing did. If \
         this changes nothing about what you are doing, do nothing.)",
        mark = crate::relay::RELAY_MARK
    );
    if crate::supervisor::deliver(app, card, &text).is_ok() {
        return;
    }
    let Some(store) = app.try_state::<Store>() else { return };
    let Ok(conn) = store.0.lock() else { return };
    let id = crate::store::uuid_v4();
    let _ = crate::store::record_relay(&conn, &id, card, card, &text, &id, 0, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deferred_call_tells_the_agent_all_four_things() {
        let note = deferred_note(3, Queued::Away);
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
        let note = pile_full(Queued::Away);
        assert!(note.starts_with(DEFERRED_OPENING));
        assert!(note.contains("**not** queued"), "it must not claim to have kept it");
        assert!(note.contains("decide it yourself"));
    }

    /* Sink `7264177f`: a question nobody got to goes to the same pile an away
       question goes to, and the agent is told the same four things about it.
       What it must NOT be told is that the wall is away, which it is not. */
    #[test]
    fn an_unattended_question_is_queued_without_claiming_the_wall_is_away() {
        let note = deferred_note(1, Queued::Unattended);
        assert!(note.starts_with(UNATTENDED_OPENING));
        assert!(!note.contains("away mode"), "the user is at the wall");
        assert!(note.contains("did not get to it in time"));
        /* The same contract, which is the whole argument for one note. */
        assert!(note.contains("Nothing has been decided"));
        assert!(note.contains("new message"));
        assert!(note.contains("Do not ask it again"));
    }

    /* Both openings, because `park_and_stream` tells a queueing note from an
       answer by asking this and nothing else. */
    #[test]
    fn either_opening_reads_as_a_deferral() {
        assert!(is_deferral(&deferred_note(1, Queued::Away)));
        assert!(is_deferral(&deferred_note(1, Queued::Unattended)));
        assert!(is_deferral(&pile_full(Queued::Unattended)));
        assert!(!is_deferral("green, the second one"));
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

    /* ── a sheet partway through (sink `fdc6954b`) ─────────────────────── */

    #[test]
    fn the_rest_of_a_sheet_says_the_answers_stand_and_the_rest_waits() {
        for why in [Queued::Unattended, Queued::Away] {
            let note = rest_note(2, why);
            assert!(note.starts_with(why.partway()), "says why it stopped");
            assert!(note.contains("`not reached`"), "points at the slots it is about");
            assert!(note.contains("they stand"), "the answers above are decisions");
            assert!(note.contains("nothing about them has been decided"), "the rest are not");
            assert!(note.contains("new message"), "how the rest will arrive");
            assert!(note.contains("do not ask them again"));
            assert!(note.contains("2 of your questions waiting"));
            /* Not the generic sentence: "nothing has been decided", unqualified,
               beside four decisions is the contradiction this note exists to
               avoid. */
            assert!(!note.contains("Nothing has been decided"));
        }
        assert!(rest_note(1, Queued::Away).contains("left the wall"));
        assert!(rest_note(1, Queued::Unattended).contains("time ran out"));
    }

    #[test]
    fn a_full_pile_narrows_deciding_alone_to_the_questions_not_reached() {
        let note = rest_full(Queued::Unattended);
        assert!(note.contains("could **not** be queued"));
        assert!(note.contains("they stand"));
        assert!(note.contains("decide them yourself"));
        assert!(note.contains(&MAX_PER_CARD.to_string()));
    }

    /// The reply opens with the answers, not with a queueing opening — the
    /// parking thread must not read a partial as a whole question deferred,
    /// and the transcript fold must draw the answers as the user's.
    #[test]
    fn a_partial_reply_opens_with_the_answers_and_is_not_a_deferral() {
        let said = "Answering each in turn:\n1. A: yes\n2. B: not reached\n\n— skein: …";
        let reply = rest_reply(said, &rest_note(1, Queued::Unattended));
        assert!(reply.starts_with(said));
        assert!(!is_deferral(&reply));
        /* No marker of its own: `answerNote` cuts at the last one, and that has
           to stay the panel's, or Rust's note would be drawn as your words. */
        assert_eq!(reply.matches("\n\n— skein: ").count(), 1);
    }
}
