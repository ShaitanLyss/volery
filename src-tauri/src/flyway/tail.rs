//! A card's conversation, read from the wall it runs on.
//!
//! The digest (`cards.rs`) is a card's *tier* — what it is doing, its last
//! line — and it travels to every peer every time it changes. A transcript is
//! the other kind of thing: hundreds of kilobytes, wanted one card at a time,
//! and only while somebody has a panel open on it. So it is never gossiped. It
//! is **pulled**, as one exchange, by the wall that wants it.
//!
//! ### Answered in the same exchange, not by a dial back
//!
//! Everything else a wall asks of another — open a card, send, recall, close —
//! is answered by the far wall dialling *back* with a fleet `answer`, which is
//! kept and said again every tick until it is out of date (`Fleet::open`).
//! That is right for an act and ruinous for a reading: a 400k tail re-said to
//! every peer every thirty seconds is the transcript gossiped after all. So the
//! far wall holds the dialler's stream open while its own front end makes the
//! tail (`link.rs`'s `tail_here`, parked the way `ask.rs` parks a `tools/call`)
//! and writes it back on the stream the request came in on. Nothing is kept on
//! either side once it has been read, and nothing retries: a panel that wants
//! it again asks again.
//!
//! ### Made by the front end, read by nobody here
//!
//! The tail is `shadow.ts::tailOf` over the owning wall's `Line[]`, because
//! what a line *is* — a folded tool call, narration, a held prompt — is
//! `classify.ts`'s taxonomy, in TypeScript, and `elsewhere.md` is emphatic that
//! it gets no second home in Rust. So this file carries it as a `Value` and
//! asks nothing of its meaning. What it does do is **bound** it, on the way out
//! and again on the way in (`fit`): the far wall is a different build and its
//! words are agent output from another machine, going into this card's panel.
//! `readTail` caps on the TypeScript side too; Rust is not allowed to be the
//! hole between them.
//!
//! ### Two words, and an older wall skips both
//!
//! `tail` asks and `tailed` answers. A wall from before them passes over a
//! `tail` frame as a word it has no use for (`frame::take`) and answers
//! whatever else the exchange carried — so the asker hears no `tailed` and says
//! the far wall cannot show a conversation, at once, rather than waiting on
//! one that will never come. The asker does not even dial it: a wall that can
//! answer says `tail` in its `Facts::can` (`WORD`), and one that does not is
//! refused before anything leaves.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The word a wall announces in `Facts::can` when it will answer a `tail`.
///
/// Not one of `fleet::CAN`: those are the acts an *agent* may ask of another
/// wall's cards, and a wall missing one of them is described to agents as an
/// older Volery that cannot be steered. A wall with every one of those and not
/// this is not that — it is a wall whose cards can be steered and not read.
pub const WORD: &str = "tail";

/// How many lines may cross, the same as `shadow.ts`'s `TAIL_LINES`. The two
/// are held equal by nothing but this sentence, which is acceptable because
/// either one being smaller only means fewer lines drawn — never a fault.
pub const LINES: usize = 120;

/// The most one string inside a line may be, in characters. `TAIL_TEXT_CAP`
/// is the larger of the two TypeScript caps; a tool result is held to its own
/// 2k there and is not re-checked by name here, since naming fields is the
/// reading this file does not do.
pub const TEXT: usize = 6_000;

/// The ceiling on everything in one tail, in characters — `TAIL_BUDGET`, with
/// room for the names and notes that file does not count.
pub const BUDGET: usize = 480_000;

/// How deep a line may nest. A line is two levels — the line and its `call` —
/// and anything deeper is something no build of this app wrote.
const DEPTH: usize = 3;

/// The most fields one object may carry. A line has six and a call four; a
/// newer build adding a few costs nothing, and a peer sending thousands is not
/// a build of this app.
const FIELDS: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum TailMsg {
    /// Ask for one card's tail. `id` is the asker's, and only ties the answer
    /// to the question in the exchange it was asked in.
    Tail { id: String, card: String },
    /// The answer. Lines, or a reason, or neither — the card has nothing to
    /// show, which is a real answer (a card cleared, or never spoken to) and
    /// must not read as a failure.
    ///
    /// Two optional fields rather than an enum of outcomes, because a variant
    /// a newer build adds to an enum is a frame an older one cannot read
    /// (`frame.rs`'s `Malformed`), and a field it adds costs nothing.
    Tailed {
        id: String,
        card: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
}

/// What a tail came back as, for the panel.
#[derive(Debug, Clone, PartialEq)]
pub enum Read {
    Lines(Value),
    /// The far wall answered and has nothing to show.
    Nothing,
}

/// A tail made safe to carry and to draw: an array of at most `LINES` objects,
/// every string scrubbed of what an agent cannot send and capped at `TEXT`,
/// nothing nested past `DEPTH`, and the whole held to `BUDGET` — spent from
/// the **newest** line backwards, as `tailOf` spends it, so one enormous
/// summary near the start cannot cost the rounds somebody opened the panel to
/// read. A line that is not an object is dropped, never guessed at, and the
/// budget is a ceiling, field names and all — no line, not even the newest,
/// is kept past it.
///
/// Anything that is not an array is no tail at all, and nor is an array with
/// lines in it of which not one could be read: that is a broken answer, and
/// reading it as an empty conversation would say the card has nothing.
pub fn fit(v: Value) -> Option<Value> {
    let Value::Array(all) = v else { return None };
    let had = !all.is_empty();
    let start = all.len().saturating_sub(LINES);
    let mut out: Vec<Value> = Vec::new();
    let mut spent = 0usize;
    for line in all.into_iter().skip(start).rev() {
        let Value::Object(_) = line else { continue };
        let mut cost = 0usize;
        let Some(kept) = fit_value(line, 0, &mut cost) else { continue };
        /* Stops the walk rather than skipping the line, for `tailOf`'s reason:
           what is past it is older, and a hole reads as a missed round. */
        if spent + cost > BUDGET {
            break;
        }
        spent += cost;
        out.push(kept);
    }
    if had && out.is_empty() {
        return None;
    }
    out.reverse();
    Some(Value::Array(out))
}

fn fit_value(v: Value, depth: usize, cost: &mut usize) -> Option<Value> {
    match v {
        Value::String(s) => {
            let clean: String = crate::clean::scrub(&s).chars().take(TEXT).collect();
            *cost += clean.chars().count();
            Some(Value::String(clean))
        }
        Value::Object(m) if depth < DEPTH => {
            let mut kept = Map::new();
            for (k, v) in m.into_iter().take(FIELDS) {
                let k: String = crate::clean::scrub(&k).chars().take(64).collect();
                *cost += k.chars().count();
                if let Some(v) = fit_value(v, depth + 1, cost) {
                    kept.insert(k, v);
                }
            }
            Some(Value::Object(kept))
        }
        /* No line this app writes holds a list; a field a newer build adds as
           one is dropped rather than carried unbounded. */
        Value::Object(_) | Value::Array(_) => None,
        other => Some(other),
    }
}

/// Read the far wall's answer to the request `id`, out of everything the
/// exchange brought back. `Err` is the sentence the panel shows.
pub fn answer_in<'a>(frames: impl IntoIterator<Item = &'a TailMsg>, id: &str, host: &str) -> Result<Read, String> {
    let found = frames.into_iter().find_map(|m| match m {
        TailMsg::Tailed { id: i, lines, why, .. } if i == id => Some((lines.clone(), why.clone())),
        _ => None,
    });
    match found {
        /* The far wall answered nothing to the question — a build that knows
           the word and dropped it, or one that announced it and is not the
           wall that answered. Said plainly, since it is not "nothing there". */
        None => Err(format!("{host} did not answer for that card's conversation — try opening it again")),
        Some((_, Some(why))) => {
            let why: String = crate::clean::scrub(why.trim()).chars().take(400).collect();
            Err(if why.is_empty() { format!("{host} could not read that card's conversation") } else { why })
        }
        Some((Some(lines), None)) => match fit(lines) {
            Some(Value::Array(a)) if a.is_empty() => Ok(Read::Nothing),
            Some(v) => Ok(Read::Lines(v)),
            None => Err(format!("{host} sent something that is not a conversation")),
        },
        Some((None, None)) => Ok(Read::Nothing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The bound a different build's words meet on the way in: an impossible
    /// character never reaches the panel, a string is capped, a line that is
    /// not an object is dropped, and nothing nested past a call is carried.
    #[test]
    fn a_tail_is_scrubbed_capped_and_never_trusted_with_its_shape() {
        let long = "x".repeat(TEXT + 50);
        let v = json!([
            { "kind": "text", "text": "hi\u{0}there" },
            7,
            "loose",
            { "kind": "tool", "text": long, "call": { "name": "Bash", "input": "{}", "deep": { "deeper": { "x": 1 } } } },
            { "kind": "text", "text": "", "future": [1, 2, 3] },
        ]);
        let got = fit(v).unwrap();
        let a = got.as_array().unwrap();
        assert_eq!(a.len(), 3, "{got}");
        assert_eq!(a[0]["text"], "hithere");
        assert_eq!(a[1]["text"].as_str().unwrap().chars().count(), TEXT);
        assert_eq!(a[1]["call"]["name"], "Bash");
        assert!(a[1]["call"]["deep"].get("deeper").is_none(), "nothing past a call is carried");
        assert!(a[2].get("future").is_none(), "a list is not a field any line has");
        assert!(fit(json!({ "kind": "text" })).is_none());
    }

    /// Too many lines keeps the newest, and the budget is spent from the end —
    /// so a monster at the start costs the start, not the end.
    #[test]
    fn the_newest_lines_survive_the_bounds() {
        let many: Vec<Value> = (0..LINES + 30).map(|i| json!({ "kind": "text", "text": i.to_string() })).collect();
        let a = fit(Value::Array(many)).unwrap();
        let a = a.as_array().unwrap();
        assert_eq!(a.len(), LINES);
        assert_eq!(a.last().unwrap()["text"], (LINES + 29).to_string());

        let big = "y".repeat(TEXT);
        let mut lines: Vec<Value> = (0..100).map(|_| json!({ "kind": "text", "text": big })).collect();
        lines.push(json!({ "kind": "text", "text": "newest" }));
        let a = fit(Value::Array(lines)).unwrap();
        let a = a.as_array().unwrap();
        assert!(a.len() < 101 && a.len() >= BUDGET / TEXT, "{}", a.len());
        assert_eq!(a.last().unwrap()["text"], "newest");
    }

    /// The three answers a panel can be given, and the fourth that is not an
    /// answer at all — a wall that heard the question and said nothing.
    #[test]
    fn an_answer_is_lines_nothing_or_a_reason() {
        let said = |lines: Option<Value>, why: Option<&str>| TailMsg::Tailed {
            id: "r".into(),
            card: "c".into(),
            lines,
            why: why.map(str::to_string),
        };
        let lines = said(Some(json!([{ "kind": "text", "text": "ok" }])), None);
        assert!(matches!(answer_in([&lines], "r", "lab"), Ok(Read::Lines(_))));
        assert_eq!(answer_in([&said(Some(json!([])), None)], "r", "lab"), Ok(Read::Nothing));
        assert_eq!(answer_in([&said(None, None)], "r", "lab"), Ok(Read::Nothing));
        assert_eq!(
            answer_in([&said(None, Some("no card x\u{7} is open"))], "r", "lab"),
            Err("no card x is open".into())
        );
        assert!(answer_in([&lines], "other", "lab").unwrap_err().contains("lab did not answer"));
        assert!(answer_in([&said(Some(json!("no")), None)], "r", "lab").is_err());
        /* Lines in it and not one readable is a broken answer, not an empty
           conversation. */
        assert!(answer_in([&said(Some(json!([7, "x"])), None)], "r", "lab").is_err());
    }

    /// The budget is a ceiling a peer cannot widen: fields past `FIELDS` are
    /// not carried, their names are paid for, and a line over the whole budget
    /// is not kept merely for being the newest.
    #[test]
    fn a_flood_of_fields_is_not_a_way_round_the_budget() {
        let mut line = Map::new();
        for i in 0..5_000 {
            line.insert(format!("k{i:05}"), Value::String("z".repeat(TEXT)));
        }
        let got = fit(json!([{ "kind": "text", "text": "ok" }, Value::Object(line)])).unwrap();
        let a = got.as_array().unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[1].as_object().unwrap().len(), FIELDS);

        /* Nested to the depth a call allows, a single line can be made larger
           than the budget; it is refused rather than carried. */
        let wide = |depth: usize| -> Value {
            let mut v = Value::String("w".repeat(TEXT));
            for _ in 0..depth {
                let mut m = Map::new();
                for i in 0..FIELDS {
                    m.insert(format!("f{i}"), v.clone());
                }
                v = Value::Object(m);
            }
            v
        };
        assert!(fit(json!([wide(2)])).is_none(), "{} chars in one line", FIELDS * FIELDS * TEXT);
    }

    /// The two words survive the wire as themselves, and an answer from a
    /// build that added a field still reads.
    #[test]
    fn the_words_round_trip_and_a_newer_field_is_free() {
        for m in [
            TailMsg::Tail { id: "r".into(), card: "c".into() },
            TailMsg::Tailed { id: "r".into(), card: "c".into(), lines: Some(json!([])), why: None },
        ] {
            let back: TailMsg = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
            assert_eq!(back, m);
        }
        let newer: TailMsg =
            serde_json::from_value(json!({ "msg": "tailed", "id": "r", "card": "c", "partial": true })).unwrap();
        assert!(matches!(newer, TailMsg::Tailed { lines: None, why: None, .. }));
    }
}
