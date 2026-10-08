//! Notices: a card that finished, ended on a question, or gave up on an error,
//! waiting in the dock's queue until you acknowledge it or follow it up — and
//! the `notice` tool, which lets a card put one there itself.
//!
//! **The failure this exists for.** The only way to find out that a card had
//! gone to rest was to pan the wall to it. The chronicle did not solve it: a
//! register is a history, and nothing in it waits for you to have seen it. A
//! notice does, which is the whole difference — it stands in the same queue as a
//! parked `ask_user` and a `close` confirmation (after them, since those hold an
//! agent mid-turn), it rings the same ladder, and it goes into the pile when the
//! wall is away, because that is what away mode does to everything that waits
//! on a person. See `.claude/rules/notice.md`.
//!
//! **What is decided here and what is not.** The front end decides *that* a
//! turn ended, how (`classify.ts::endingFor`), what it said, and whether its own
//! background work is young enough to wait for — it holds all four already, and
//! three of them are folds Rust never sees. This file decides the three things
//! only the wall can answer, all of which make a rest *not* the end of anything
//! (measured on 926 real rests, `notice.md`):
//!
//!  - the card armed a `wake_me` — it said when it would be back;
//!  - a card it opened is still working, or its report is on the way
//!    (`spawn::settling_toward`) — the orchestrator case, and most of the noise;
//!  - it was opened by a card that is still live — that parent already gets the
//!    settle relay, and a second notice for one piece of work is a double ring.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::{NoticeRow, Store};

pub const NOTICE_TOOL: &str = "notice";

/// The kinds a turn ending raises. `card` is the tool's, and is never raised
/// through `notice_raise` — a card says so by calling the tool, not the wall.
const REST_KINDS: [&str; 3] = ["done", "question", "error"];

/// A finishing text longer than this is clipped, with the marker saying so.
/// The panel scrolls, so this is a bound on the row rather than on the reading:
/// a closing summary runs a few thousand characters at the long end.
const TEXT_MAX: usize = 12_000;

/// A card's own notices standing at once. `presence::MAX_PER_CARD`'s argument:
/// a card that notifies, is told it worked, and notifies again is a loop with
/// nobody awake to notice, and what it produces is a queue nobody can read.
const CARD_MAX: usize = 5;

/// The first words of a waiting notice that went to the queue instead of being
/// waited on. A third opening rather than a reuse of either of `presence.rs`'s,
/// for `UNATTENDED_OPENING`'s reason: "Volery queued your question" is false
/// about a notice, and a false sentence handed to a model gets reasoned from.
/// `presence::is_deferral` knows all three, which is how the park tells this
/// from an answer.
pub const QUEUED_OPENING: &str = "Volery queued your notice.";

/* ── a notice answered from another wall ──────────────────────────────────
 *
 * Sink `16864f3d`'s rule: anything that waits on a person must travel to
 * where the person is. A notice rides the card's digest to every other wall
 * (`shadow.ts`), and taking one down from there comes back the way an answer
 * to a parked question does — over the prompt wire, naming what it answers in
 * `Ask::answers` — so there is one mechanism for both rather than a second
 * tag. A question's answer names its ask id; a notice's names `AFAR_PREFIX`
 * and the notice's id, which no ask id can be mistaken for (`store::uuid_v4`
 * has no colon). A notice holding its card's turn open is not one of these:
 * it is parked like a question and is answered by its ask id, into the call.
 *
 * A wall from before this reads the prefixed id as an ask id, finds no such
 * question and refuses — "no longer waiting" — which is the right answer from
 * a wall that never published the notice in the first place. */

/// What `Ask::answers` starts with when it names a notice rather than a
/// parked question.
pub const AFAR_PREFIX: &str = "notice:";

/// The text of an answer that only takes the notice down — `acknowledge`,
/// with nothing said. Anything else is a follow-up, sent to the card.
pub const AFAR_ACK: &str = "acknowledged";

/// The notice an answer from another wall names, if it names one.
pub fn afar(answers: Option<&str>) -> Option<&str> {
    answers
        .and_then(|a| a.strip_prefix(AFAR_PREFIX))
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// Whether an answer from another wall starts no work here — what lets it past
/// this wall's "take work from other walls" switch (`fleet::may_reach`).
///
/// An answer to a parked question never does: it is the reply a card stopped
/// and asked for. An acknowledgement never does: it takes a row down. A
/// **follow-up** to a notice does — it is a message to the card, which wakes
/// it to take a turn — so it is held to the switch exactly as a prompt is, and
/// the person who turned the switch off meant it.
pub fn answer_starts_nothing(answers: &str, text: &str) -> bool {
    match afar(Some(answers)) {
        Some(_) => text.trim() == AFAR_ACK,
        None => !answers.starts_with(AFAR_PREFIX),
    }
}

#[derive(Clone, serde::Serialize)]
struct Changed {
    /// The card whose notices moved, or `None` for a change across the wall.
    conversation_id: Option<String>,
}

pub(crate) fn changed(app: &AppHandle, conversation_id: Option<&str>) {
    let _ = app.emit(
        "notice:changed",
        Changed { conversation_id: conversation_id.map(str::to_string) },
    );
}

/// Why a rest raises nothing, or `None` if it should raise.
///
/// Pure over what the wall answered, so the three rules can be asserted without
/// a wall. `parent_live` is a parent with a process — a dormant one gets no
/// settle relay (`spawn::sweep` delivers only to a live stdin), so a dormant
/// parent is no reason to keep the notice from you.
pub(crate) fn held(wakes_armed: i64, children_busy: bool, parent_live: bool) -> Option<&'static str> {
    if wakes_armed > 0 {
        return Some("a wake is armed");
    }
    if children_busy {
        return Some("a card it opened is still working");
    }
    if parent_live {
        return Some("the card that opened it is told instead");
    }
    None
}

/// Put a rest notice up, unless the wall knows the rest is not the end of
/// anything. Answers whether it went up.
///
/// Off the main thread, `crate::off_main`'s rule one step out: it takes the
/// supervisor's lock to ask about liveness, and `deliver_blocks` holds that lock
/// across a stdin write that can stall — a command waiting on it inline is the
/// back-door freeze `CLAUDE.md` describes.
#[tauri::command(async)]
pub async fn notice_raise(
    app: AppHandle,
    conversation_id: String,
    kind: String,
    text: String,
) -> Result<bool, String> {
    crate::off_main(move || raise(&app, conversation_id, kind, text)).await?
}

fn raise(app: &AppHandle, conversation_id: String, kind: String, text: String) -> Result<bool, String> {
    if !REST_KINDS.contains(&kind.as_str()) {
        return Err(format!("not a notice kind: {kind}"));
    }
    let store = app.state::<Store>();
    let sup = app.state::<crate::supervisor::Supervisor>();

    let (wakes, kin, parent, row) = {
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        let wakes = crate::store::wakes_armed_by(&conn, &conversation_id);
        let pairs = crate::store::lineage(&conn).unwrap_or_default();
        let kin: Vec<String> = pairs
            .iter()
            .filter(|(_, p)| *p == conversation_id)
            .map(|(c, _)| c.clone())
            .collect();
        let parent = pairs
            .iter()
            .find(|(c, _)| *c == conversation_id)
            .map(|(_, p)| p.clone());
        let row = crate::store::roster_one(&conn, &conversation_id);
        (wakes, kin, parent, row)
    };
    /* Read after the store lock is down: `liveness` takes the supervisor's own
       lock, and holding both at once is an ordering somebody else will one day
       take the other way round. */
    let children_busy = kin.iter().any(|c| sup.liveness(c).1)
        || crate::spawn::settling_toward(&conversation_id);
    let parent_live = parent.is_some_and(|p| sup.liveness(&p).0);
    /* And the card's own turn: a relay or a wake that landed in the moments
       before the front end's timer fired has opened one the front end has not
       heard about yet. A notice over a working card says something false. */
    if sup.liveness(&conversation_id).1 {
        return Ok(false);
    }
    if held(wakes, children_busy, parent_live).is_some() {
        return Ok(false);
    }

    let away = crate::presence::away(app);
    let notice = NoticeRow {
        id: crate::store::uuid_v4(),
        conversation_id: conversation_id.clone(),
        kind: kind.clone(),
        text: crate::clip::keep(text.trim(), TEXT_MAX).marked("The whole of it is in the card's transcript."),
        raised_at: crate::store::now(),
        away,
        waited: false,
    };
    {
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        crate::store::raise_notice(&conn, &notice)?;
    }
    changed(app, Some(&conversation_id));

    /* One row per notice, which is what the register became the day notices
       existed: the passive history of what happened, read when you want it,
       where the notice is the thing that waits. Not for an error — the turn
       already wrote "turn ended in an error" with the CLI's own sentence, and a
       second row for the same failure is the register stuttering. */
    if kind != "error" {
        let (level, mark) = match kind.as_str() {
            "question" => ("ask", "ended on a question"),
            _ => ("good", "finished"),
        };
        let source = row.as_ref().map(source_of).unwrap_or_else(|| "volery".into());
        crate::chronicle::note(
            app,
            row.as_ref().map(|r| r.project_id.as_str()),
            &source,
            level,
            mark,
            &first_line(&notice.text),
        );
    }
    Ok(true)
}

/// The register's name for a card, `skein.svelte.ts::#sourceOf`'s shape.
fn source_of(r: &crate::store::RosterRow) -> String {
    let t = r.title.trim();
    if t.is_empty() {
        r.project.clone()
    } else {
        format!("{} · {}", r.project, t)
    }
}

/// The first line of prose, for a register row or a peek. Markdown markers off
/// the front, since a row is plain text.
pub(crate) fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(|l| l.trim().trim_start_matches(['#', '>', '-', '*', ' ']).trim())
        .find(|l| !l.is_empty() && !l.starts_with("```"))
        .unwrap_or("")
        .replace("**", "")
        .replace('`', "");
    crate::clip::keep(&line, 200).kept
}

#[tauri::command]
pub fn notices_read(store: State<'_, Store>) -> Vec<NoticeRow> {
    let Ok(conn) = store.0.lock() else { return Vec::new() };
    crate::store::queued_notices(&conn)
}

/// Take one down — acknowledged, or followed up. Answers the row so the caller
/// can tell what it was a follow-up *to*; `None` means somebody else got there
/// first, and the follow-up must not be sent twice.
#[tauri::command]
pub fn notice_take(app: AppHandle, id: String) -> Option<NoticeRow> {
    let taken = {
        let store = app.try_state::<Store>()?;
        let conn = store.0.lock().ok()?;
        crate::store::take_notice(&conn, &id)
    };
    if let Some(n) = &taken {
        changed(&app, Some(&n.conversation_id));
    }
    taken
}

/// A turn opened on this card. Called on the transition from
/// `supervisor::persist_turn`, `spawn::stirring`'s seat one line over.
pub fn stirred(app: &AppHandle, conversation_id: &str) {
    let gone = {
        let Some(store) = app.try_state::<Store>() else { return };
        let Ok(conn) = store.0.lock() else { return };
        crate::store::drop_rest_notices_of(&conn, conversation_id)
    };
    if gone > 0 {
        changed(app, Some(conversation_id));
    }
}

/// The wall went away with notices up. Called from `presence::flip`, after the
/// state is set, beside `defer_parked`.
pub fn went_away(app: &AppHandle) {
    {
        let Some(store) = app.try_state::<Store>() else { return };
        let Ok(conn) = store.0.lock() else { return };
        crate::store::notices_go_away(&conn);
    }
    changed(app, None);
}

/* ── the tool ─────────────────────────────────────────────────────────────── */

/// What a parked notice is drawn from: the text under a key no question has, so
/// `skein.svelte.ts` can tell it from an `ask_user` payload on sight, and
/// `answer_window` — which counts questions and options — gives it the floor.
pub(crate) fn parked_payload(text: &str) -> Value {
    json!({ "notice": { "text": text } })
}

/// Is this parked payload a notice rather than a question?
pub(crate) fn is_notice(args: &Value) -> bool {
    args.get("notice").and_then(|n| n.get("text")).is_some()
}

/// The text out of the tool's arguments, cleaned and capped, or why not.
pub(crate) fn text_of(args: &Value) -> Result<String, String> {
    let text = args.get("text").and_then(Value::as_str).unwrap_or("").trim();
    if text.is_empty() {
        return Err("`text` is empty — nothing was put in the user's queue.".into());
    }
    Ok(crate::clip::keep(text, TEXT_MAX).kept)
}

pub(crate) fn waits(args: &Value) -> bool {
    args.get("wait").and_then(Value::as_bool).unwrap_or(false)
}

/// Why a card's notice is in the queue rather than being waited on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Queued {
    /// It did not ask to wait.
    Sent,
    /// It asked to wait, and the wall is away.
    Away,
    /// It asked to wait, it stood on the wall, and nobody got to it in time.
    Unattended,
}

/// Put a card's notice in the queue, and say what the card is told.
pub(crate) fn queue(app: &AppHandle, conversation_id: &str, text: &str, why: Queued) -> String {
    let Some(store) = app.try_state::<Store>() else {
        return "Nothing was queued — the wall has no store to keep it in. Say it in your \
                closing message instead."
            .into();
    };
    let away = crate::presence::away(app);
    let n = NoticeRow {
        id: crate::store::uuid_v4(),
        conversation_id: conversation_id.to_string(),
        kind: "card".into(),
        text: text.to_string(),
        raised_at: crate::store::now(),
        away: away || why == Queued::Away,
        waited: why != Queued::Sent,
    };
    {
        let Ok(conn) = store.0.lock() else {
            return "Nothing was queued — the wall's store did not answer. Say it in your \
                    closing message instead."
                .into();
        };
        if crate::store::card_notices_of(&conn, conversation_id) >= CARD_MAX {
            return full_note();
        }
        if let Err(e) = crate::store::raise_notice(&conn, &n) {
            return format!("Nothing was queued — {e}. Say it in your closing message instead.");
        }
    }
    changed(app, Some(conversation_id));
    queued_note(why)
}

/// Whether a card may leave another notice — checked before a waiting notice
/// parks, since a full queue discovered on expiry would lose the text.
pub(crate) fn has_room(app: &AppHandle, conversation_id: &str) -> bool {
    let Some(store) = app.try_state::<Store>() else { return false };
    let Ok(conn) = store.0.lock() else { return false };
    crate::store::card_notices_of(&conn, conversation_id) < CARD_MAX
}

pub(crate) fn full_note() -> String {
    format!(
        "Not queued: you already have {CARD_MAX} notices standing in the user's queue, \
         which is as many as one card may leave. They have not got to the others yet. \
         Say this in your closing message instead, and do not send it again."
    )
}

/// What the card reads. Like `presence::deferred_note`, the contract lives in
/// the reply rather than in the schema: it costs nothing until the one turn it
/// is true of, and it lands at the moment the agent needs it.
pub(crate) fn queued_note(why: Queued) -> String {
    match why {
        Queued::Sent => "Your notice is in the user's queue, beside their other notices and \
                         questions, and it will ring for them. Carry on — nothing comes back \
                         from this call. If they follow it up, that arrives later as a new \
                         message."
            .into(),
        Queued::Away | Queued::Unattended => {
            let because = match why {
                Queued::Away => format!(
                    "{} The user is not at the wall, so your notice was **queued** \
                     rather than waited on",
                    crate::presence::DEFERRED_OPENING
                ),
                _ => format!(
                    "{QUEUED_OPENING} It stood on the wall and the user did not get to it \
                     in time, so rather than expiring it was **queued**"
                ),
            };
            format!(
                "{because} — nothing was lost. When they read it they can acknowledge it \
                 or follow it up. A follow-up arrives in this conversation as a new message \
                 naming your notice; an acknowledgement alone sends nothing.\n\n\
                 What to do now: carry on with whatever does not depend on their reply, and \
                 say in your closing line what you are holding back. Do not send the notice \
                 again — it is already in their queue."
            )
        }
    }
}

pub fn schema() -> Value {
    json!({
        "name": NOTICE_TOOL,
        "description":
            "Put a short notice in the user's queue — beside the questions waiting on \
             them, and ringing for them like one — for something they should know *now* \
             though you need nothing from them: you are about to do something disruptive \
             (a migration, a restart, a long build that will hold a shared resource), or \
             you found something serious (a big bug, data at risk) and have started on \
             it.\n\n\
             Use it sparingly. Every card's finished turns already reach the user as \
             notices on their own, so do not use this to say you are done, and do not \
             use it for a question — that is `mcp__skein__ask_user`. A notice is for news that \
             cannot wait for your closing message.\n\n\
             `wait: false` (the default) queues it and returns at once. `wait: true` \
             holds your turn until the user acknowledges it or answers with a follow-up, \
             and that reply is this call's result — use it when you must not go on \
             until they have seen it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description":
                        "The notice, in markdown. Lead with the news in one sentence; \
                         a few lines of context after it at most."
                },
                "wait": {
                    "type": "boolean",
                    "description":
                        "Hold your turn until the user acknowledges or follows up. \
                         Default false."
                }
            },
            "required": ["text"],
            "additionalProperties": false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rest_is_held_by_a_wake_by_working_children_and_by_a_live_parent() {
        assert_eq!(held(0, false, false), None);
        assert!(held(1, false, false).is_some());
        assert!(held(0, true, false).is_some());
        assert!(held(0, false, true).is_some());
    }

    #[test]
    fn a_parked_notice_is_told_from_a_question_by_its_shape() {
        assert!(is_notice(&parked_payload("restarting the lab")));
        assert!(!is_notice(&json!({ "question": "which?" })));
        assert!(!is_notice(&json!({ "questions": [{ "question": "a" }] })));
    }

    #[test]
    fn an_empty_notice_is_refused_and_wait_defaults_off() {
        assert!(text_of(&json!({ "text": "  " })).is_err());
        assert_eq!(text_of(&json!({ "text": " found a bug " })).unwrap(), "found a bug");
        assert!(!waits(&json!({ "text": "x" })));
        assert!(waits(&json!({ "text": "x", "wait": true })));
    }

    #[test]
    fn a_queued_waiting_notice_is_a_deferral_to_the_park() {
        /* The park closes a call whose answer opens with a queueing note as
           *deferred* rather than answered; both waiting cases must, and the
           plain send must not be mistaken for one if it ever reached a park. */
        assert!(crate::presence::is_deferral(&queued_note(Queued::Away)));
        assert!(crate::presence::is_deferral(&queued_note(Queued::Unattended)));
        assert!(!crate::presence::is_deferral(&queued_note(Queued::Sent)));
    }

    #[test]
    fn the_first_line_skips_markdown_and_fences() {
        assert_eq!(first_line("\n## Done\n\nmore"), "Done");
        assert_eq!(first_line("```\ncode\n```\n- item"), "code");
        assert_eq!(first_line("**Bold** news in `x.rs`"), "Bold news in x.rs");
    }

    /// A notice answered from another wall names itself on the prompt wire,
    /// and only taking it down gets past the far wall's switch — a follow-up
    /// is a message to the card, which is work.
    #[test]
    fn a_notice_from_afar_is_named_and_only_its_acknowledgement_is_free() {
        assert_eq!(afar(Some("notice:ab12")), Some("ab12"));
        assert_eq!(afar(Some("notice:  ")), None);
        assert_eq!(afar(Some("2f1c-ask-id")), None);
        assert_eq!(afar(None), None);

        assert!(answer_starts_nothing("notice:ab12", AFAR_ACK));
        assert!(answer_starts_nothing("notice:ab12", " acknowledged \n"));
        assert!(!answer_starts_nothing("notice:ab12", "carry on with the tests"));
        /* A parked question's answer is never work, whatever it says. */
        assert!(answer_starts_nothing("2f1c-ask-id", "carry on with the tests"));
        /* Nor is a prefix with no id a free pass. */
        assert!(!answer_starts_nothing("notice:", AFAR_ACK));
    }
}
