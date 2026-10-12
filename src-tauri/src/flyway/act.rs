//! A person's gesture on a card on another wall — one frame for every verb.
//!
//! A shadow's right-click used to offer two rows, the glass and the close,
//! because everything else on a card's menu reaches for a process or a session
//! on the other machine. `handle.ts` is the table of what a card can be asked
//! and what each verb costs; this is the half that carries a verb to the wall
//! the card runs on. `elsewhere.md`, "one card handle", is the design.
//!
//! ### One frame, not one per verb
//!
//! `act { id, card, verb, args }`, answered `acted { id, outcome, why, text }`
//! on the same stream (`tail.rs`'s shape: one exchange, nothing kept, nothing
//! retried). The verb is a word rather than a variant, so the next verb is an
//! entry in `VERBS` here and one arm in `Elsewhere.#perform`, and no frame a
//! wall one release behind has to learn. A wall says which verbs it will do in
//! `Facts::can`, one `act:<verb>` word each (`words`), so an older wall is
//! simply not offered a verb it would refuse — and a verb sent anyway reaches
//! it as a word it has no use for (`frame::take`).
//!
//! `outcome` is a string and not an enum for `TailMsg::Tailed`'s reason: a
//! variant a newer build adds is a frame an older one cannot read. Anything
//! but `taken` reads as refused, which is the safe direction.
//!
//! ### Gated by what the verb costs, decided on the wall that pays
//!
//! The owner's front end runs the verb — what a card *is* lives in TypeScript
//! — but whether it may run is decided here, before the front end is asked,
//! against this wall's own switch read fresh (`gate`):
//!
//! - **work** (wake, clear, account, bypass) starts a process or spends an
//!   account, so it is held to "take work from other walls" exactly as a
//!   prompt is. Lyss, 2026-10-13: account, bypass and clear are settable from
//!   another wall — *"I am the owner everywhere"* — and gated like a prompt.
//! - **cosmetic** (aside) and **read** (copy-resume, copy-cwd) start nothing
//!   and pass the switch, for `tail_here`'s reason.
//! - **Never an agent's.** The road an agent has to another wall's cards is
//!   `walls`/`send`/`recall`/`close`; nothing an agent can call sends an
//!   `act`, and an `act` that names a card as its asker is refused anyway —
//!   the second lock `deliver_here` keeps on a notice answer.
//!
//! A quiet wall is refused on the *asker's* side, at once and never queued
//! (`Link::reachable`): a card runs `--dangerously-skip-permissions`, and a lid
//! lifting hours later must not deliver something you have changed your mind
//! about. Nothing here can be queued anyway — an exchange that does not land
//! is the gesture refused.
//!
//! ### Strict on the way in, bounded on the way out
//!
//! The id and the card are held to letters, digits and dashes; the verb to one
//! of `VERBS`; the arguments to the handful each verb takes, read into a fresh
//! object (`read_args`), so nothing a peer adds reaches the front end. Every
//! string that crosses either way is scrubbed (`crate::clean`) and capped.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The prefix a verb is announced under in `Facts::can`.
pub const PREFIX: &str = "act:";

/// What a verb does to the machine the card runs on — `handle.ts`'s `Cost`,
/// for the verbs that cross. The two tables are held equal by
/// `test/handle.test.ts` reading this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cost {
    Work,
    Cosmetic,
    Read,
}

/// Every verb this build will do for a person on another wall.
pub const VERBS: [(&str, Cost); 7] = [
    ("wake", Cost::Work),
    ("clear", Cost::Work),
    ("account", Cost::Work),
    ("bypass", Cost::Work),
    ("aside", Cost::Cosmetic),
    ("copy-resume", Cost::Read),
    ("copy-cwd", Cost::Read),
];

/// The most an id or a card handle may be. Both are uuids.
const ID_MOST: usize = 64;

/// The most an account label may be, in characters.
const LABEL_MOST: usize = 120;

/// The most a returned text may be: a resume command or a working directory.
/// A path on Windows is bounded far below this; a peer sending more is not a
/// build of this app.
pub const TEXT_MOST: usize = 4_096;

/// The most a refusal may say.
const WHY_MOST: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum ActMsg {
    /// Ask the wall a card runs on to do `verb` to it. `id` is the asker's and
    /// only ties the answer to the question in this exchange.
    Act {
        id: String,
        card: String,
        verb: String,
        #[serde(default)]
        args: Value,
        /// The card that asked, if one did. Nothing on this build ever sets
        /// it — an `act` is a person's — and a wall that receives one with it
        /// set refuses.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_card: Option<String>,
    },
    /// The answer: `taken`, or anything else with a reason. `text` is what a
    /// reading verb answers with.
    Acted {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
}

/// What this wall announces in `Facts::can`.
pub fn words() -> Vec<String> {
    VERBS.iter().map(|(v, _)| format!("{PREFIX}{v}")).collect()
}

/// The verbs a wall's `can` offers a person here: its `act:<verb>` words,
/// only those this build also knows — a verb this wall cannot send is not one
/// to offer — and once each.
pub fn offered(can: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in can.iter().filter_map(|c| c.strip_prefix(PREFIX)) {
        if cost(v).is_some() && !out.iter().any(|o| o == v) {
            out.push(v.to_string());
        }
    }
    out
}

/// The verb's cost, or `None` for a word this build does not do.
pub fn cost(verb: &str) -> Option<Cost> {
    VERBS.iter().find(|(v, _)| *v == verb).map(|(_, c)| *c)
}

/// An id or a card handle: a uuid's alphabet, and short. Anything else is not
/// one this app minted — refused rather than cleaned, since a cleaned id is a
/// different id.
pub fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= ID_MOST && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A string off the wire, made safe to carry and to show.
pub fn fit_text(s: &str, most: usize) -> String {
    crate::clean::scrub(s.trim()).chars().take(most).collect()
}

/// The arguments a verb takes, read into a fresh object so nothing else a peer
/// sends reaches the front end. `Err` is the sentence the asker is told.
///
/// - `aside`, `bypass`: `{ on: bool }` — the state wanted, never a toggle, so
///   a gesture made against a face a snapshot old cannot flip it the wrong way.
/// - `account`: `{ account: string }`, the label.
/// - `clear`: `{ sawWorking: bool }`, what the asker's face said when the
///   person chose it — so the owner can refuse a card that has *started* a
///   turn since, while still letting a turn going wrong be abandoned, which is
///   what a local clear allows.
/// - the rest take nothing.
pub fn read_args(verb: &str, args: &Value) -> Result<Value, String> {
    let get = |k: &str| args.as_object().and_then(|m| m.get(k));
    let flag = |k: &str| match get(k) {
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("{verb} needs to say whether it is on or off")),
    };
    let mut out = Map::new();
    match verb {
        "aside" | "bypass" => {
            out.insert("on".into(), Value::Bool(flag("on")?));
        }
        "account" => {
            let label = get("account").and_then(Value::as_str).map(|s| fit_text(s, LABEL_MOST)).unwrap_or_default();
            if label.is_empty() {
                return Err("no account was named".into());
            }
            out.insert("account".into(), Value::String(label));
        }
        "clear" => {
            /* Absent reads as resting: the stricter of the two, since a clear
               that cannot say what it saw must not land on a turn in flight. */
            let saw = matches!(get("sawWorking"), Some(Value::Bool(true)));
            out.insert("sawWorking".into(), Value::Bool(saw));
        }
        _ => {}
    }
    Ok(Value::Object(out))
}

/// Whether this wall may do `verb` for the wall that asked, decided on this
/// wall's own switch read fresh. `Err` is the refusal in words. `me` is this
/// wall's name, for the sentence.
pub fn gate(verb: &str, from_card: Option<&str>, accepting: bool, me: &str) -> Result<Cost, String> {
    let Some(c) = cost(verb) else {
        return Err(format!("{me} does not know how to {verb} a card from another wall — it may need updating"));
    };
    if from_card.is_some() {
        return Err("that is a person's gesture, and another card asked it".into());
    }
    if c == Cost::Work && !accepting {
        return Err(format!(
            "{me} is not taking work from other walls — switch that on in the flyway panel on {me}"
        ));
    }
    Ok(c)
}

/// The answer, as `ActMsg::Acted`, bounded on the way out.
pub fn acted(id: &str, outcome: Result<Option<String>, String>) -> ActMsg {
    match outcome {
        Ok(text) => ActMsg::Acted {
            id: id.to_string(),
            outcome: "taken".into(),
            why: None,
            text: text.map(|t| fit_text(&t, TEXT_MOST)).filter(|t| !t.is_empty()),
        },
        Err(why) => ActMsg::Acted { id: id.to_string(), outcome: "refused".into(), why: Some(fit_text(&why, WHY_MOST)), text: None },
    }
}

/// Read the far wall's answer to the request `id` out of everything the
/// exchange brought back: `Ok` with the text a reading verb returned, `Err`
/// with the sentence to show. Bounded again here — the far wall is another
/// build.
pub fn answer_in<'a>(frames: impl IntoIterator<Item = &'a ActMsg>, id: &str, host: &str) -> Result<Option<String>, String> {
    let found = frames.into_iter().find_map(|m| match m {
        ActMsg::Acted { id: i, outcome, why, text } if i == id => Some((outcome, why, text)),
        _ => None,
    });
    match found {
        None => Err(format!("{host} did not answer — it may or may not have done it; look at the card before asking again")),
        Some((o, _, text)) if o == "taken" => Ok(text.as_deref().map(|t| fit_text(t, TEXT_MOST)).filter(|t| !t.is_empty())),
        Some((_, why, _)) => {
            let why = why.as_deref().map(|w| fit_text(w, WHY_MOST)).unwrap_or_default();
            Err(if why.is_empty() { format!("{host} would not do that") } else { why })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The gate is per cost, never per verb: a work verb is held to the switch,
    /// a cosmetic or reading one is not, and nothing an agent asks passes.
    #[test]
    fn work_is_held_to_the_switch_and_nothing_else_is() {
        for (v, c) in VERBS {
            let off = gate(v, None, false, "desk");
            match c {
                Cost::Work => assert!(off.unwrap_err().contains("not taking work"), "{v}"),
                _ => assert_eq!(off, Ok(c), "{v}"),
            }
            assert_eq!(gate(v, None, true, "desk"), Ok(c));
            assert!(gate(v, Some("card-1"), true, "desk").unwrap_err().contains("person's"), "{v}");
        }
        assert!(gate("processes", None, true, "desk").unwrap_err().contains("does not know"));
        assert!(gate("move", None, true, "desk").is_err());
    }

    /// One word per verb, under the prefix, and nothing else.
    #[test]
    fn every_verb_is_announced_once() {
        let w = words();
        assert_eq!(w.len(), VERBS.len());
        assert!(w.iter().all(|x| x.starts_with(PREFIX)));
        assert!(w.contains(&"act:copy-cwd".to_string()));
    }

    /// What a roster row offers: the act words, unprefixed, and only verbs this
    /// build knows — a newer wall's verb is not offered by a build that cannot
    /// send it, and the agent words beside them are not verbs at all.
    #[test]
    fn a_wall_offers_what_it_announced_and_this_build_knows() {
        let can: Vec<String> =
            ["send", "close_by_person", "act:aside", "act:teleport", "act:aside", "act:clear", "tail"].map(str::to_string).into();
        assert_eq!(offered(&can), vec!["aside".to_string(), "clear".to_string()]);
        assert!(offered(&[]).is_empty());
        assert_eq!(offered(&words()).len(), VERBS.len());
    }

    /// Only the fields a verb takes cross, a flag must be a flag, and a label
    /// is scrubbed and capped.
    #[test]
    fn arguments_are_read_into_a_fresh_shape() {
        assert_eq!(read_args("aside", &json!({ "on": true, "extra": "x" })).unwrap(), json!({ "on": true }));
        assert!(read_args("bypass", &json!({ "on": "yes" })).is_err());
        assert!(read_args("bypass", &Value::Null).is_err());
        let long = format!("work\u{0}{}", "a".repeat(500));
        let got = read_args("account", &json!({ "account": long })).unwrap();
        let label = got["account"].as_str().unwrap();
        assert!(label.starts_with("worka") && label.chars().count() == LABEL_MOST);
        assert!(read_args("account", &json!({ "account": "  " })).is_err());
        assert_eq!(read_args("clear", &json!({})).unwrap(), json!({ "sawWorking": false }));
        assert_eq!(read_args("clear", &json!({ "sawWorking": true })).unwrap(), json!({ "sawWorking": true }));
        assert_eq!(read_args("wake", &json!({ "anything": [1, 2] })).unwrap(), json!({}));
    }

    #[test]
    fn an_id_is_a_uuids_alphabet_and_short() {
        assert!(is_id("6fd60171-aaaa-bbbb"));
        assert!(!is_id(""));
        assert!(!is_id("a b"));
        assert!(!is_id("../x"));
        assert!(!is_id(&"a".repeat(ID_MOST + 1)));
    }

    /// Taken with text, refused with a reason, and the two non-answers: a far
    /// wall that said nothing, and an outcome this build has no word for —
    /// which is refused, the safe direction.
    #[test]
    fn an_answer_is_text_or_a_reason() {
        let said = |o: &str, why: Option<&str>, text: Option<&str>| ActMsg::Acted {
            id: "r".into(),
            outcome: o.into(),
            why: why.map(str::to_string),
            text: text.map(str::to_string),
        };
        assert_eq!(answer_in([&said("taken", None, Some("C:\\x\u{7}"))], "r", "lab"), Ok(Some("C:\\x".into())));
        assert_eq!(answer_in([&said("taken", None, None)], "r", "lab"), Ok(None));
        assert_eq!(answer_in([&said("refused", Some("no\u{0}pe"), None)], "r", "lab"), Err("nope".into()));
        assert_eq!(answer_in([&said("deferred", None, Some("x"))], "r", "lab"), Err("lab would not do that".into()));
        assert!(answer_in([&said("taken", None, None)], "other", "lab").unwrap_err().contains("may or may not"));
        let huge = "z".repeat(TEXT_MOST * 2);
        let got = answer_in([&said("taken", None, Some(&huge))], "r", "lab").unwrap().unwrap();
        assert_eq!(got.chars().count(), TEXT_MOST);
    }

    /// Bounded on the way out too.
    #[test]
    fn what_leaves_is_bounded() {
        match acted("r", Ok(Some("y".repeat(TEXT_MOST + 9)))) {
            ActMsg::Acted { text: Some(t), outcome, .. } => {
                assert_eq!(outcome, "taken");
                assert_eq!(t.chars().count(), TEXT_MOST);
            }
            other => panic!("{other:?}"),
        }
        match acted("r", Err(format!("bad\u{1b}{}", "w".repeat(WHY_MOST)))) {
            ActMsg::Acted { why: Some(w), outcome, .. } => {
                assert_eq!(outcome, "refused");
                assert!(!w.contains('\u{1b}') && w.chars().count() == WHY_MOST);
            }
            other => panic!("{other:?}"),
        }
    }

    /// The two words survive the wire, an older asker's frame with no `args`
    /// or `from_card` reads, and a newer field is free.
    #[test]
    fn the_words_round_trip_and_a_newer_field_is_free() {
        for m in [
            ActMsg::Act { id: "r".into(), card: "c".into(), verb: "aside".into(), args: json!({ "on": true }), from_card: None },
            acted("r", Ok(Some("t".into()))),
            acted("r", Err("no".into())),
        ] {
            let back: ActMsg = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
            assert_eq!(back, m);
        }
        let bare: ActMsg = serde_json::from_value(json!({ "msg": "act", "id": "r", "card": "c", "verb": "wake" })).unwrap();
        assert!(matches!(bare, ActMsg::Act { args: Value::Null, from_card: None, .. }));
        let newer: ActMsg =
            serde_json::from_value(json!({ "msg": "acted", "id": "r", "outcome": "taken", "later": 1 })).unwrap();
        assert!(matches!(newer, ActMsg::Acted { text: None, .. }));
    }
}
