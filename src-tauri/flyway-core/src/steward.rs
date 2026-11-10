//! A spoken sentence carried from a phone to a wall, and the plan that comes back.
//!
//! `docs/PHONE.md` M5, the command loop: the phone has ears and a mouth but no
//! `claude` child, so *understanding* stays on a wall. The phone ships its
//! transcript; a wall runs the steward (`src-tauri/src/steward.rs` spawning,
//! `src/lib/steward.ts` prompt and validation); the plan comes back. This file
//! is the wire between those two halves, and nothing else — the wall stays the
//! brain (`docs/PHONE.md`).
//!
//! ### One exchange, answered on the same stream, never gossiped
//!
//! This is `tail.rs`'s shape, not `fleet`'s: a transcript is a question one
//! node asks of one wall, answered once and never kept or re-said. The
//! alternative — a fleet `answer` said again every tick for ten minutes — is
//! right for an act and wrong for a parse that costs a `claude` turn, and a
//! plan is of interest to exactly the phone that asked. Nothing on either side
//! is kept once read, and nothing retries: a phone that wants it again says
//! the sentence again.
//!
//! ### Gated like work, because it is
//!
//! A steward run is one `claude --print` on the wall's *own* account — the same
//! spend `steward.rs` makes for a sentence spoken at the keyboard, now made on
//! a sentence spoken into a phone and dialled here. So it is held to the wall's
//! "take work from other walls" switch (`act::Cost::Work`), announced under its
//! own `can` word (`WORD`), and refused by the asker at once when the wall is
//! quiet, unknown or too old — never queued for a lid to lift hours later.
//!
//! ### The answer is opaque, for `tail.rs`'s reason
//!
//! What `understand` decides — a plan, or an ask, a question, a decline, an
//! unusable reply — is `steward.ts`'s taxonomy. It gets no second home in Rust.
//! So `answer` is carried as a `Value` the wall's own front end made, bounded on
//! the way out (`fit`) and read on the way in (`answer_in`), and nothing here
//! looks inside it. A field a later build adds costs an older reader nothing.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The word a wall announces in `Facts::can` when it will run the steward for
/// another wall. Not one of `fleet::CAN`, for `tail::WORD`'s reason: those are
/// the acts an *agent* may ask of another wall's cards, and a wall missing one
/// of them is described to agents as unsteerable. A wall with every one of
/// those and not this is still steerable — it simply cannot be the brain for a
/// phone, and the phone says so rather than dialling it.
pub const WORD: &str = "steward";

/// The most a transcript may be, in characters. A spoken sentence is short —
/// a paragraph is a different gesture — and anything past this is not one.
/// Held on both ends: the wall refuses a longer one, and the asker refuses to
/// send one.
pub const TRANSCRIPT_MOST: usize = 2_000;

/// The most a refusal or a wall-side failure may say, as `act.rs`'s `WHY_MOST`.
const WHY_MOST: usize = 400;

/// The most one string inside the answer may be — `tail.rs`'s `TEXT`, since a
/// plan's payloads are a transcript's worth of words, never more.
const TEXT: usize = 6_000;

/// How deep the answer may nest. A plan is two levels — the plan and its steps
/// — and anything deeper is nothing this build wrote.
const DEPTH: usize = 4;

/// The most fields one object may carry, as `tail.rs`'s `FIELDS`.
const FIELDS: usize = 24;

/// The most entries one list may carry — a plan's `steps`, an `args` value. A
/// plan is a handful of steps, never more, and a peer sending hundreds is not a
/// build of this app.
const ITEMS: usize = 32;

/// How long the asker holds the exchange open. The steward's own spawn waits up
/// to sixty seconds (`steward.rs::TIMEOUT`), so an exchange held to the wire's
/// ordinary twenty would drop a slow-but-correct parse. Generous against that,
/// and finite so a wall that never answers still releases the dial.
pub const WITHIN: Duration = Duration::from_secs(75);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum StewardMsg {
    /// Ask the wall to turn a spoken transcript into a plan. `id` is the
    /// asker's, and only ties the answer to the question in this exchange.
    Steward { id: String, transcript: String },
    /// Confirm the plan the wall returned for `id` — the id of the `Steward`
    /// whose `Stewarded` answer is being confirmed — and carry it out. The
    /// phone speaks the plan's `reads`, hears a yes, and sends this; it never
    /// sends the plan back, so the wall is the only thing that ever held the
    /// steps and the only thing that runs them. Answered `Stewarded` with the
    /// carry's `Outcome` — `{ "kind": "done" | "refused" | "stopped", … }`.
    Confirm { id: String },
    /// The answer. `answer` is the whole of what `steward.ts::understand`
    /// decided — `{ "kind": "plan", "plan": { "steps": …, "reads": …,
    /// "needs": … } }` most often, else `ask`, `question`, `decline` or
    /// `unusable` — carried as an opaque value; on a `Confirm` it is the
    /// carry's `Outcome`. `why` is a *wall-side* failure: the wall could not
    /// run the steward at all (still starting, no front end), rather than a
    /// reply the steward made.
    Stewarded {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        answer: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
}

/// An answer made safe to cross: every string scrubbed of what an agent cannot
/// send and capped at `TEXT`, nothing nested past `DEPTH`, and no object wider
/// than `FIELDS`. `None` when the whole of it could not be read — the same
/// shape as `tail::fit`, applied on the way out (a different build's answer is
/// going into a phone's narration) and again on the way in (`answer_in`).
pub fn fit(answer: Value) -> Option<Value> {
    let v = fit_value(answer, 0);
    /* A plan with no readable `kind` at the root is no answer at all. */
    if let Some(Value::Object(m)) = &v {
        if m.contains_key("kind") {
            return v;
        }
    }
    None
}

fn fit_value(v: Value, depth: usize) -> Option<Value> {
    match v {
        Value::String(s) => {
            let clean: String = crate::clean::scrub(&s).chars().take(TEXT).collect();
            Some(Value::String(clean))
        }
        Value::Object(m) if depth < DEPTH => {
            let mut kept = Map::new();
            for (k, v) in m.into_iter().take(FIELDS) {
                let k: String = crate::clean::scrub(&k).chars().take(64).collect();
                if let Some(v) = fit_value(v, depth + 1) {
                    kept.insert(k, v);
                }
            }
            Some(Value::Object(kept))
        }
        /* The plan's own shape is a list — `steps` — so a list is carried, not
           dropped: each entry scrubbed and capped, the list itself bounded. */
        Value::Array(a) if depth < DEPTH => {
            Some(Value::Array(a.into_iter().take(ITEMS).filter_map(|v| fit_value(v, depth + 1)).collect()))
        }
        /* Anything past the depth is nothing this build wrote — dropped, never
           carried unbounded. */
        Value::Object(_) | Value::Array(_) => None,
        other => Some(other),
    }
}

/// Read the wall's answer to the request `id` out of everything the exchange
/// brought back. `Err` is the sentence the phone narrates.
pub fn answer_in<'a>(frames: impl IntoIterator<Item = &'a StewardMsg>, id: &str, host: &str) -> Result<Value, String> {
    let found = frames.into_iter().find_map(|m| match m {
        StewardMsg::Stewarded { id: i, answer, why } if i == id => Some((answer.clone(), why.clone())),
        _ => None,
    });
    match found {
        /* The wall answered nothing to the question — a build that knows the
           word and dropped it, or one that announced it and is not the wall
           that answered. */
        None => Err(format!("{host} did not answer — say it again")),
        Some((_, Some(why))) => {
            let why: String = crate::clean::scrub(why.trim()).chars().take(WHY_MOST).collect();
            Err(if why.is_empty() { format!("{host} could not run the steward") } else { why })
        }
        Some((Some(answer), None)) => match fit(answer) {
            Some(a) => Ok(a),
            None => Err(format!("{host} sent something that is not a plan")),
        },
        Some((None, None)) => Err(format!("{host} answered with nothing")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A plan round-trips as itself, a `why` reads, and a field a newer build
    /// adds is free — the two optional fields rather than an enum, so nothing
    /// an older reader meets is `Malformed`.
    #[test]
    fn the_words_round_trip_and_a_newer_field_is_free() {
        let ask = StewardMsg::Steward { id: "r".into(), transcript: "open a card for the orchard migration".into() };
        assert_eq!(ask, serde_json::from_value(serde_json::to_value(&ask).unwrap()).unwrap());
        let confirm = StewardMsg::Confirm { id: "r".into() };
        assert_eq!(confirm, serde_json::from_value(serde_json::to_value(&confirm).unwrap()).unwrap());
        let plan = StewardMsg::Stewarded {
            id: "r".into(),
            answer: Some(json!({ "kind": "plan", "plan": { "steps": [], "reads": "nothing", "needs": "nothing" } })),
            why: None,
        };
        assert_eq!(plan, serde_json::from_value(serde_json::to_value(&plan).unwrap()).unwrap());
        let newer: StewardMsg =
            serde_json::from_value(json!({ "msg": "stewarded", "id": "r", "later": true })).unwrap();
        assert!(matches!(newer, StewardMsg::Stewarded { answer: None, why: None, .. }));
    }

    /// The answer is scrubbed and capped and never trusted with a shape no plan
    /// has: an impossible character never reaches the phone, a root with no
    /// `kind` is no answer at all, and — the thing the first cut got wrong — a
    /// plan's `steps` list survives rather than being dropped with the bound.
    #[test]
    fn an_answer_is_scrubbed_and_bounded() {
        let good = json!({ "kind": "plan", "plan": { "reads": "open a card in orchard\u{0}", "steps": [{ "op": "open", "args": { "project": "orchard" } }] } });
        let got = fit(good).unwrap();
        assert_eq!(got["plan"]["reads"], "open a card in orchard");
        assert_eq!(got["plan"]["steps"][0]["op"], "open", "the plan's steps must cross, not be dropped");

        assert!(fit(json!({ "plan": { "reads": "x" } })).is_none(), "no kind is no answer");
        assert_eq!(fit(json!({ "kind": "plan", "plan": { "steps": [1, 2, 3] } })).unwrap()["plan"]["steps"], json!([1, 2, 3]));
        /* A list past the bound is cut, never carried unbounded. */
        let many = json!({ "kind": "plan", "plan": { "steps": (0..ITEMS + 9).map(|i| json!({ "op": i })).collect::<Vec<_>>() } });
        assert_eq!(fit(many).unwrap()["plan"]["steps"].as_array().unwrap().len(), ITEMS);
    }

    /// The three answers a phone can be given, and the fourth that is not an
    /// answer at all — a wall that heard the question and said nothing.
    #[test]
    fn an_answer_is_a_plan_a_reason_or_nothing() {
        let said = |answer: Option<Value>, why: Option<&str>| StewardMsg::Stewarded {
            id: "r".into(),
            answer,
            why: why.map(str::to_string),
        };
        let plan = said(Some(json!({ "kind": "plan", "plan": { "reads": "open a card in orchard" } })), None);
        assert_eq!(answer_in([&plan], "r", "lab").unwrap()["kind"], "plan");
        assert_eq!(answer_in([&said(None, Some("no\u{7} such wall"))], "r", "lab"), Err("no such wall".into()));
        assert_eq!(answer_in([&said(None, None)], "r", "lab"), Err("lab answered with nothing".into()));
        assert!(answer_in([&plan], "other", "lab").unwrap_err().contains("lab did not answer"));
    }

    /// The wait outlives the steward's own sixty-second spawn, and is still
    /// finite — a wall that never answers releases the dial rather than
    /// holding it for ever.
    #[test]
    fn the_exchange_wait_outlasts_the_spawn_and_is_finite() {
        assert!(WITHIN.as_secs() > 60, "{WITHIN:?}");
        assert!(WITHIN.as_secs() <= 120, "{WITHIN:?}");
    }
}
