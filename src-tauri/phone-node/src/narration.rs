//! The narration brain — turning a change between two card digests into the
//! short lines a phone says out loud (`docs/PHONE.md`, M3).
//!
//! This is the *what to say* half only. Nothing here is platform: it reads the
//! opaque snapshot `Node::sight` already returns and folds one digest against
//! the one before it. The ears and the mouth (ASR/TTS) are a later Android
//! card; this module owes them nothing beyond `Line`s and a `needs_you` flag.
//!
//! ### A line is templated, never composed
//!
//! `docs/VOICE.md`'s `reads` rule, applied to narration: a spoken line is a
//! small template over the digest's own structured fields — a card's `title`,
//! `working`, `dormant`, `ending`, `asks` and `notices`. Nothing reads the
//! `doing`/`said` free text and nothing asks a model. The card-state vocabulary
//! is the digest's own small stable subset, made explicit here and held by
//! test: **working / asking / idle / dormant**, plus **finished** as the word
//! for the `working → idle` move.
//!
//! ### The fold
//!
//! `diff(prev, curr, chatty)` walks `curr`'s cards, matches each to `prev` by
//! id, and asks a small table what changed. A card absent from `prev` *opened*;
//! a card whose state moved is read off the state-transition table below; a
//! card with more notices than before *noticed*. At most one line per card, the
//! most urgent change winning. `needs_you` is set when any card opened or is
//! asking — the two things the `needs` level speaks — whatever the chatty level,
//! so a caller can duck music without also asking it to murmur.
//!
//! `prev: None` is the first sighting: there is no baseline to fold against, so
//! it is silence, not a fanfare for every card on the wall.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::node::Digest;

/// How much the phone says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chatty {
    /// Nothing, ever. `needs_you` is still computed, for a caller that wants
    /// the flag without the voice.
    Off,
    /// Only what needs Lyss now: a card that opened for her, or a question
    /// waiting on her.
    Needs,
    /// Everything notable: the above, plus a card finished, started, went
    /// dormant, or raised a notice.
    Murmur,
}

/// What a line is about. This is the stable, testable vocabulary; the sentence
/// is the template over it.
///
/// The variant order is the speak order: `Opened` first, `Notice` last, and
/// `diff` sorts lines by it so the thing that needs her is said before the
/// weather. A new event kind is one variant here plus one row (or phrase) in
/// the table that picks it — not a new branch in the fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// A card that was not in the previous digest — it opened for her.
    Opened,
    /// A card asking her something now (a parked question, a question left in
    /// prose, or a `question` notice). Needs her.
    Ask,
    /// A card whose turn ended and came to rest (`working → idle`).
    Finished,
    /// A card that began a turn (`idle/dormant → working`).
    Started,
    /// A card that went dormant.
    Dormant,
    /// A card raised a notice not already covered by one of the above.
    Notice,
}

/// One line to speak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub kind: Kind,
    /// The card's id on its wall — what a later answer is addressed to.
    pub card: String,
    /// The sentence. Short, templated from the card's own fields; for an
    /// `Ask` it carries the question itself, so the phone can speak it rather
    /// than only "is asking you something".
    pub text: String,
    /// The parked question's id, for an `Ask` line — what an answer is sent
    /// against. `None` for every other kind, and `None` for an `Ask` whose
    /// digest carried no question (a question left in prose, or a `question`
    /// notice), which has no parked id to answer.
    pub ask_id: Option<String>,
}

/// What to say now, and whether it needs her.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Narration {
    pub lines: Vec<Line>,
    /// True when any card opened or is asking — the `needs` set — regardless of
    /// `chatty`, so the flag drives ducking without making the voice murmur.
    pub needs_you: bool,
}

/// Fold one digest against the one before it into the lines to speak now.
///
/// `prev: None` is the first sighting and folds to nothing (there is no
/// baseline). Lines are ordered most-urgent first; `needs_you` is computed from
/// the change alone, so it is the same at every chatty level.
pub fn diff(prev: Option<&Digest>, curr: &Digest, chatty: Chatty) -> Narration {
    let Some(prev) = prev else {
        return Narration::default();
    };
    /* A digest is one wall's, and card ids are UUIDs. Folding a new wall's
       digest against the last wall's would call every card on it newly opened
       and raise `needsYou`, so a wall switch would read out a wall of dormant
       cards and open the microphone. A dial that lands on another wall is a
       first sighting. */
    if !prev.host.is_empty() && !curr.host.is_empty() && prev.host != curr.host {
        return Narration::default();
    }

    let prev_cards = read_cards(&prev.snapshot);
    let curr_cards = read_cards(&curr.snapshot);
    let prev_by_id: BTreeMap<&str, &Card> = prev_cards.iter().map(|c| (c.id.as_str(), c)).collect();

    let mut events: Vec<(Kind, &Card)> = Vec::new();
    for curr_card in &curr_cards {
        if let Some(kind) = event_of(prev_by_id.get(curr_card.id.as_str()).copied(), curr_card) {
            events.push((kind, curr_card));
        }
    }

    let needs_you = events.iter().any(|(kind, _)| needs_worthy(*kind));

    // Most urgent first (`Kind`'s derived order), then by title for a stable
    // run when two cards did the same thing.
    events.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.title.cmp(&b.1.title)));

    let mut lines = Vec::new();
    for (kind, card) in events {
        if speak(kind, chatty) {
            let ask_id = if kind == Kind::Ask { card.ask.as_ref().map(|a| a.id.clone()) } else { None };
            lines.push(Line { kind, card: card.id.clone(), text: say(kind, card), ask_id });
        }
    }

    Narration { lines, needs_you }
}

/// The two kinds of thing the `needs` level speaks — what needs her right now.
fn needs_worthy(kind: Kind) -> bool {
    matches!(kind, Kind::Opened | Kind::Ask)
}

/// Whether `kind` is spoken at `chatty`.
fn speak(kind: Kind, chatty: Chatty) -> bool {
    match chatty {
        Chatty::Off => false,
        Chatty::Needs => needs_worthy(kind),
        Chatty::Murmur => true,
    }
}

/* ── the card, as narration reads it ───────────────────────────────────── */

/// The card-state vocabulary, made explicit. Derived from the structured fields
/// only (`working`, `dormant`, `ending`, `asks`, `notices`) — never from the
/// `doing`/`said` free text, and never re-derived from the owner's `tier`,
/// which warms over time and would read a card neglected for five minutes as a
/// change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Working,
    Asking,
    Idle,
    Dormant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    Ok,
    Question,
    Asked,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeKind {
    Done,
    Question,
    Error,
    Card,
}

struct Notice {
    kind: NoticeKind,
}

struct Card {
    id: String,
    title: String,
    working: bool,
    dormant: bool,
    ending: Option<Ending>,
    asks: usize,
    /// The card's oldest parked question, with its id and its words — what the
    /// phone speaks for an `Ask`, and what an answer is sent against.
    ask: Option<AskInfo>,
    notices: Vec<Notice>,
}

/// One parked question, as the digest carries it. `question` is the words to
/// speak; `None` for a question the digest kept as words the phone should not
/// read out (empty, or a wall from before it said them) — the line then falls
/// back to the generic "is asking you something".
struct AskInfo {
    id: String,
    question: Option<String>,
}

impl Card {
    /// Is a question waiting on her right now: a parked `ask_user`, a turn that
    /// ended leaving a question in prose, or a `question` notice. This is the
    /// one predicate the `Asking` state folds from; a new way for a card to ask
    /// is one arm here, not a new transition.
    fn waiting(&self) -> bool {
        self.asks > 0
            || matches!(self.ending, Some(Ending::Question | Ending::Asked))
            || self.notices.iter().any(|n| n.kind == NoticeKind::Question)
    }
}

fn state_of(card: &Card) -> State {
    if card.dormant {
        State::Dormant
    } else if card.waiting() {
        State::Asking
    } else if card.working {
        State::Working
    } else {
        State::Idle
    }
}

/// The state-transition table: `(from, to) → what to say`. A new card-state is
/// a new row here, never a new `if` in the fold. Only the moves that are news
/// appear; an answered question going back to idle, for instance, says nothing.
const TRANSITIONS: &[(State, State, Kind)] = &[
    (State::Working, State::Idle, Kind::Finished),
    (State::Working, State::Asking, Kind::Ask),
    (State::Working, State::Dormant, Kind::Dormant),
    (State::Idle, State::Working, Kind::Started),
    (State::Idle, State::Asking, Kind::Ask),
    (State::Idle, State::Dormant, Kind::Dormant),
    (State::Dormant, State::Working, Kind::Started),
    (State::Dormant, State::Asking, Kind::Ask),
    (State::Asking, State::Dormant, Kind::Dormant),
];

fn transition(from: State, to: State) -> Option<Kind> {
    TRANSITIONS.iter().find(|(f, t, _)| *f == from && *t == to).map(|&(_, _, kind)| kind)
}

/// The single most-urgent thing that changed about one card, or none. A card
/// that both finished and raised a `done` notice says *finished* once, not
/// twice; the notice is the fallback for what has no state-transition of its
/// own (`error`, a card that spoke).
fn event_of(prev: Option<&Card>, curr: &Card) -> Option<Kind> {
    let Some(prev) = prev else {
        return Some(Kind::Opened);
    };
    if let Some(kind) = transition(state_of(prev), state_of(curr)) {
        return Some(kind);
    }
    if curr.notices.len() > prev.notices.len() {
        return Some(Kind::Notice);
    }
    None
}

/// The sentence for a card's change. Short, and templated from its own fields.
fn say(kind: Kind, card: &Card) -> String {
    match kind {
        Kind::Opened => format!("{} opened.", card.title),
        Kind::Ask => match card.ask.as_ref().and_then(|a| a.question.as_deref()) {
            Some(q) => format!("{} is asking: {q}", card.title),
            None => format!("{} is asking you something.", card.title),
        },
        Kind::Finished => format!("{} finished.", card.title),
        Kind::Started => format!("{} started.", card.title),
        Kind::Dormant => format!("{} went dormant.", card.title),
        Kind::Notice => {
            let phrase = match card.notices.last().map(|n| n.kind) {
                Some(NoticeKind::Done) => "finished.",
                Some(NoticeKind::Question) => "is asking you something.",
                Some(NoticeKind::Error) => "hit an error.",
                Some(NoticeKind::Card) => "has something for you.",
                None => "has a new notice.",
            };
            format!("{} {}", card.title, phrase)
        }
    }
}

/* ── reading the snapshot ───────────────────────────────────────────────── */

/// The cards out of an opaque snapshot, leniently: a card with no id is dropped
/// (as the wall's own reader does), an unknown or missing field reads as the
/// value that claims least, and every string comes back as it crossed.
fn read_cards(snapshot: &Value) -> Vec<Card> {
    let Some(cards) = snapshot.get("cards").and_then(Value::as_array) else {
        return Vec::new();
    };
    cards.iter().filter_map(read_card).collect()
}

fn read_card(raw: &Value) -> Option<Card> {
    let obj = raw.as_object()?;
    let id = obj.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let title = obj.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
    let title = title.unwrap_or("a card").to_string();
    let working = obj.get("working").and_then(Value::as_bool).unwrap_or(false);
    let dormant = obj.get("dormant").and_then(Value::as_bool).unwrap_or(false);
    let ending = obj.get("ending").and_then(Value::as_str).and_then(read_ending);
    let asks_arr = obj.get("asks").and_then(Value::as_array);
    let asks = asks_arr.map(|a| a.len()).unwrap_or(0);
    let ask = asks_arr.and_then(|a| a.first()).and_then(read_ask);
    let notices = read_notices(obj.get("notices"));
    Some(Card { id: id.to_string(), title, working, dormant, ending, asks, ask, notices })
}

/// The first parked question, as an id plus the words to speak. A question with
/// no id is not answerable (there is nothing to send the answer against), and
/// one with no words is kept — the line falls back to the generic form.
fn read_ask(raw: &Value) -> Option<AskInfo> {
    let id = raw.get("askId")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let question = raw
        .get("questions")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|q| q.get("question").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Some(AskInfo { id: id.to_string(), question })
}

fn read_ending(s: &str) -> Option<Ending> {
    match s {
        "ok" => Some(Ending::Ok),
        "question" => Some(Ending::Question),
        "asked" => Some(Ending::Asked),
        "stopped" => Some(Ending::Stopped),
        "error" => Some(Ending::Error),
        _ => None,
    }
}

fn read_notices(raw: Option<&Value>) -> Vec<Notice> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .map(|n| {
            let kind = n
                .get("kind")
                .and_then(Value::as_str)
                .and_then(|s| match s {
                    "done" => Some(NoticeKind::Done),
                    "question" => Some(NoticeKind::Question),
                    "error" => Some(NoticeKind::Error),
                    "card" => Some(NoticeKind::Card),
                    _ => None,
                })
                .unwrap_or(NoticeKind::Done);
            Notice { kind }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A digest over the given cards, the cards built by `card`.
    fn digest(version: u64, cards: &[Value]) -> Digest {
        Digest {
            host: "desk".into(),
            version,
            age_ms: 0,
            snapshot: json!({ "v": 1, "at": version, "cards": cards }),
        }
    }

    /// One card, with only the fields narration reads. `asks` is the count of
    /// parked questions; `notices` the notice kinds; `ending` the turn's ending.
    fn card(id: &str, title: &str, working: bool, dormant: bool, ending: Option<&str>, asks: usize, notices: &[&str]) -> Value {
        let mut c = json!({
            "id": id,
            "title": title,
            "working": working,
            "dormant": dormant,
            "asks": (0..asks).map(|i| json!({ "askId": format!("{id}-{i}"), "since": 0, "questions": [] })).collect::<Vec<_>>(),
        });
        if let Some(ending) = ending {
            c["ending"] = json!(ending);
        }
        if !notices.is_empty() {
            c["notices"] = Value::Array(
                notices
                    .iter()
                    .enumerate()
                    .map(|(i, k)| json!({ "id": format!("n{i}"), "kind": k, "raisedAt": 0, "askId": null }))
                    .collect::<Vec<_>>(),
            );
        }
        c
    }

    /// The kinds a `diff` returned, in order.
    fn kinds(prev: Option<&Digest>, curr: &Digest, chatty: Chatty) -> Vec<Kind> {
        diff(prev, curr, chatty).lines.into_iter().map(|l| l.kind).collect()
    }

    /// A digest from another wall is a first sighting, not a wall of cards
    /// opening at once. The baseline survives a walk that lands elsewhere, so
    /// the host has to be part of what "the same wall" means.
    #[test]
    fn a_different_wall_is_silence_not_a_wall_of_new_cards() {
        let prev = digest(1, &[card("a", "caravan", false, true, None, 0, &[])]);
        let mut curr = digest(
            2,
            &[card("b", "orchard", false, true, None, 0, &[]), card("c", "hold", false, true, None, 0, &[])],
        );
        curr.host = "annex".into();
        let n = diff(Some(&prev), &curr, Chatty::Murmur);
        assert!(n.lines.is_empty(), "every card on a new wall would read as opened");
        assert!(!n.needs_you, "a wall switch is not something that needs her");
    }

    #[test]
    fn off_is_always_empty() {
        let prev = digest(1, &[card("a", "auth work", true, false, None, 0, &[])]);
        let curr = digest(
            2,
            &[
                card("a", "auth work", false, false, Some("ok"), 0, &[]), // finished
                card("b", "caravan", false, false, None, 1, &[]),         // a question
                card("c", "orchard", false, false, None, 0, &["card"]),   // a notice
                card("d", "spawn", true, false, None, 0, &[]),            // opened
            ],
        );
        let n = diff(Some(&prev), &curr, Chatty::Off);
        assert!(n.lines.is_empty(), "off says nothing: {:?}", n.lines);
        assert!(n.needs_you, "the flag is still computed at off");
    }

    #[test]
    fn needs_says_only_what_needs_her() {
        let prev = digest(
            1,
            &[
                card("a", "auth work", true, false, None, 0, &[]),
                card("b", "started work", false, false, None, 0, &[]),
                card("c", "dormant work", true, false, None, 0, &[]),
                card("d", "quiet work", false, false, Some("ok"), 0, &[]),
                card("f", "noticed work", false, false, None, 0, &[]),
            ],
        );
        let curr = digest(
            2,
            &[
                card("a", "auth work", false, false, Some("ok"), 0, &[]), // finished — not said
                card("b", "started work", true, false, None, 0, &[]),     // started — not said
                card("c", "dormant work", false, true, None, 0, &[]),     // dormant — not said
                card("d", "quiet work", false, false, None, 1, &[]),      // ask — said
                card("e", "spawn", true, false, None, 0, &[]),            // opened — said
                card("f", "noticed work", false, false, None, 0, &["card"]), // notice — not said
            ],
        );
        assert_eq!(kinds(Some(&prev), &curr, Chatty::Needs), vec![Kind::Opened, Kind::Ask]);
    }

    #[test]
    fn murmur_says_everything_notable() {
        let prev = digest(
            1,
            &[
                card("a", "auth work", true, false, None, 0, &[]),
                card("b", "started work", false, false, None, 0, &[]),
                card("c", "dormant work", true, false, None, 0, &[]),
                card("d", "quiet work", false, false, None, 0, &[]),
                card("f", "noticed work", false, false, None, 0, &[]),
            ],
        );
        let curr = digest(
            2,
            &[
                card("a", "auth work", false, false, Some("ok"), 0, &[]),
                card("b", "started work", true, false, None, 0, &[]),
                card("c", "dormant work", false, true, None, 0, &[]),
                card("d", "quiet work", false, false, None, 1, &[]),
                card("e", "spawn", true, false, None, 0, &[]),
                card("f", "noticed work", false, false, None, 0, &["card"]),
            ],
        );
        assert_eq!(
            kinds(Some(&prev), &curr, Chatty::Murmur),
            vec![Kind::Opened, Kind::Ask, Kind::Finished, Kind::Started, Kind::Dormant, Kind::Notice],
        );
    }

    #[test]
    fn a_plain_finish_sets_no_needs_you_and_needs_says_nothing() {
        let prev = digest(1, &[card("a", "auth work", true, false, None, 0, &[])]);
        let curr = digest(2, &[card("a", "auth work", false, false, Some("ok"), 0, &[])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert!(n.lines.is_empty(), "a plain finish is not something that needs her");
        assert!(!n.needs_you);
        // And murmur does say it, as a finish.
        let m = diff(Some(&prev), &curr, Chatty::Murmur);
        assert_eq!(m.lines.len(), 1);
        assert_eq!(m.lines[0].kind, Kind::Finished);
        assert_eq!(m.lines[0].text, "auth work finished.");
        assert!(!m.needs_you);
    }

    #[test]
    fn a_question_sets_needs_you() {
        let prev = digest(1, &[card("a", "caravan", false, false, Some("ok"), 0, &[])]);
        let curr = digest(2, &[card("a", "caravan", false, false, None, 1, &[])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Ask);
        assert_eq!(n.lines[0].text, "caravan is asking you something.");
        assert!(n.needs_you);
    }

    #[test]
    fn a_question_speaks_its_words_and_carries_its_id() {
        let prev = digest(1, &[card("a", "caravan", false, false, Some("ok"), 0, &[])]);
        let mut asked = card("a", "caravan", false, false, None, 1, &[]);
        asked["asks"] = json!([{
            "askId": "ask-9",
            "since": 0,
            "questions": [{ "header": "which", "question": "square or circle?", "options": [] }],
        }]);
        let n = diff(Some(&prev), &digest(2, &[asked]), Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Ask);
        assert_eq!(n.lines[0].text, "caravan is asking: square or circle?");
        assert_eq!(n.lines[0].ask_id.as_deref(), Some("ask-9"));
    }

    #[test]
    fn a_question_without_a_parked_id_carries_none() {
        // A question left in prose has no parked ask to answer against.
        let prev = digest(1, &[card("a", "caravan", true, false, None, 0, &[])]);
        let curr = digest(2, &[card("a", "caravan", false, false, Some("question"), 0, &[])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Ask);
        assert_eq!(n.lines[0].ask_id, None);
    }

    #[test]
    fn a_spawned_card_sets_needs_you() {
        let prev = digest(1, &[card("a", "auth work", false, false, Some("ok"), 0, &[])]);
        let curr = digest(2, &[card("a", "auth work", false, false, Some("ok"), 0, &[]), card("b", "orchard", true, false, None, 0, &[])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Opened);
        assert_eq!(n.lines[0].text, "orchard opened.");
        assert!(n.needs_you);
    }

    #[test]
    fn a_question_left_in_prose_needs_her_too() {
        let prev = digest(1, &[card("a", "caravan", true, false, None, 0, &[])]);
        // The turn ended with a question in prose — no parked ask, no notice.
        let curr = digest(2, &[card("a", "caravan", false, false, Some("question"), 0, &[])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Ask);
        assert!(n.needs_you);
    }

    #[test]
    fn a_question_notice_needs_her() {
        let prev = digest(1, &[card("a", "caravan", false, false, None, 0, &[])]);
        let curr = digest(2, &[card("a", "caravan", false, false, None, 0, &["question"])]);
        let n = diff(Some(&prev), &curr, Chatty::Needs);
        assert_eq!(n.lines.len(), 1);
        assert_eq!(n.lines[0].kind, Kind::Ask);
        assert!(n.needs_you);
    }

    #[test]
    fn a_notice_is_murmur_not_needs() {
        let prev = digest(1, &[card("a", "noticed work", false, false, None, 0, &[])]);
        let curr = digest(2, &[card("a", "noticed work", false, false, None, 0, &["card"])]);
        assert_eq!(kinds(Some(&prev), &curr, Chatty::Needs), vec![]);
        let m = diff(Some(&prev), &curr, Chatty::Murmur);
        assert_eq!(m.lines.len(), 1);
        assert_eq!(m.lines[0].kind, Kind::Notice);
        assert_eq!(m.lines[0].text, "noticed work has something for you.");
        assert!(!m.needs_you);
    }

    #[test]
    fn a_finish_and_its_done_notice_say_finished_once() {
        let prev = digest(1, &[card("a", "auth work", true, false, None, 0, &[])]);
        let curr = digest(2, &[card("a", "auth work", false, false, Some("ok"), 0, &["done"])]);
        let m = diff(Some(&prev), &curr, Chatty::Murmur);
        assert_eq!(m.lines.len(), 1, "the done notice is not a second line");
        assert_eq!(m.lines[0].kind, Kind::Finished);
    }

    #[test]
    fn no_baseline_is_silence() {
        let curr = digest(1, &[card("a", "auth work", true, false, None, 0, &[])]);
        let n = diff(None, &curr, Chatty::Murmur);
        assert!(n.lines.is_empty(), "the first sighting is a baseline, not news");
        assert!(!n.needs_you);
    }

    #[test]
    fn a_closed_card_says_nothing() {
        let prev = digest(1, &[card("a", "auth work", false, false, Some("ok"), 0, &[]), card("b", "old work", false, false, Some("ok"), 0, &[])]);
        let curr = digest(2, &[card("a", "auth work", false, false, Some("ok"), 0, &[])]);
        assert_eq!(kinds(Some(&prev), &curr, Chatty::Murmur), vec![]);
    }

    #[test]
    fn unknown_fields_read_as_the_least_claiming_value() {
        // A card with no working/dormant/ending/asks/notices is idle, and a card
        // with no id is dropped — the owner's reader does the same.
        let prev = digest(1, &[]);
        let curr = digest(2, &[json!({ "title": "nameless" }), json!({ "id": "b", "working": true, "title": "busy" })]);
        let m = diff(Some(&prev), &curr, Chatty::Murmur);
        // Only the id-bearing card opened; the nameless one is dropped.
        assert_eq!(m.lines.len(), 1);
        assert_eq!(m.lines[0].kind, Kind::Opened);
        assert_eq!(m.lines[0].text, "busy opened.");
    }
}
