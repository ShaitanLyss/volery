//! What one sealed frame carries.
//!
//! Three vocabularies share the wire — the sink's (`session::Msg`), the
//! fleet's (`fleet::FleetMsg`) and the cards' (`cards::CardsMsg`) — and each
//! names its messages under one tag, `msg`, with no name used twice. So the
//! envelope is **untagged**: a frame is whichever vocabulary its `msg` belongs
//! to, and a bare `session::Msg` from a wall that only ever spoke the sink is
//! still a valid frame. That is the whole of what lets a new wall answer an old
//! one's dial without a second encoding.
//!
//! ### A frame this wall does not know is skipped, not fatal
//!
//! The next vocabulary will be added by a build the other machine has not got
//! yet. If an unknown `msg` failed the read, every frame in the same exchange
//! would go with it — the sink's events included — and two walls one release
//! apart would stop syncing anything until both updated. So a frame that opens
//! (the key is right, the bytes are ours) and names a `msg` this build has no
//! word for is counted and passed over. A frame that does not open, or opens to
//! something with no `msg` at all, is still refused: that is a different wall or
//! a broken one, and saying so is the point.
//!
//! ### And so is a word we know that will not read
//!
//! The first cut refused a frame whose `msg` this build knows but whose body
//! does not parse, on the argument that it "should have parsed, so it is seen".
//! Two walls on different builds is the **normal** case, not the edge one — a
//! person updates the machine they are sitting at and the other stays where it
//! was — and the way a newer build makes a known word unreadable to an older
//! one is ordinary: one more variant in `Outcome` or `Refusal`, one more required
//! field. An `answer` frame is gossiped to every peer, so that one variant would
//! fail every exchange with every older wall, and the sink frames beside it with
//! them. So it is passed over too, logged where an older wall's owner can read
//! it (`Read::Malformed`), and the exchange carries everything else.
//!
//! **What may still be refused is the whole read, never one frame of it.** A
//! frame that does not open, or is not JSON, or names no message, is not one of
//! ours at all, and that does end the exchange — `take` is the loop's rule, so
//! it is what the tests hold.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cards::CardsMsg;
use super::fleet::FleetMsg;
use super::session::Msg;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Frame {
    Sink(Msg),
    Fleet(FleetMsg),
    Cards(CardsMsg),
}

/// What one opened payload turned out to be.
#[derive(Debug, PartialEq)]
pub enum Read {
    Frame(Box<Frame>),
    /// One of ours, from a build that knows a word this one does not.
    Unknown(String),
    /// A word this build knows, in a shape it cannot read — most often a
    /// newer build's. See the module note on why it is passed over.
    Malformed(String),
}

/// Read one opened payload. See the module note for which failures are
/// failures.
pub fn read(plain: &[u8]) -> Result<Read, String> {
    let v: Value = serde_json::from_slice(plain).map_err(|e| format!("a frame was not one of ours: {e}"))?;
    let tag = v.get("msg").and_then(Value::as_str).map(str::to_string);
    match serde_json::from_value::<Frame>(v) {
        Ok(f) => Ok(Read::Frame(Box::new(f))),
        Err(e) => match tag {
            /* A word we know, in a shape we do not — passed over and said, see
               the module note. */
            Some(t) if KNOWN.contains(&t.as_str()) => Ok(Read::Malformed(format!("a {t} frame did not read: {e}"))),
            Some(t) => Ok(Read::Unknown(t)),
            None => Err("a frame was not one of ours: it names no message".to_string()),
        },
    }
}

/// One opened payload, folded into what a read has gathered so far — the read
/// loop's whole rule, here so it can be held by a test rather than only by the
/// stream it runs over. Frames this build has no use for are passed over and
/// logged; a payload that is not one of ours ends the read.
pub fn take(plain: &[u8], into: &mut Vec<Frame>) -> Result<(), String> {
    match read(plain)? {
        Read::Frame(f) => into.push(*f),
        Read::Unknown(tag) => log::debug!("flyway: passed over a `{tag}` frame this build has no word for"),
        Read::Malformed(why) => log::warn!(
            "flyway: passed over a frame this build could not read ({why}) — the other wall is probably \
             a newer build; everything else in the exchange still arrived"
        ),
    }
    Ok(())
}

/// Every `msg` this build reads. Held against the three enums by a test, so a
/// variant added to one of them without this list is caught rather than
/// silently skipped as "from a newer build".
const KNOWN: &[&str] = &["hello", "events", "roster", "ask", "answer", "prompt", "recall", "close", "cards"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flyway::fleet::{Announcement, Facts, Heard};
    use std::collections::BTreeMap;

    fn round(f: Frame) -> Frame {
        let bytes = serde_json::to_vec(&f).unwrap();
        match read(&bytes).unwrap() {
            Read::Frame(back) => *back,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_vocabulary_comes_back_as_itself() {
        let hello = Frame::Sink(Msg::Hello { host: "desk".into(), watermark: BTreeMap::new() });
        assert_eq!(round(hello.clone()), hello);
        let roster = Frame::Fleet(FleetMsg::Roster {
            walls: vec![Heard {
                wall: Announcement { host: "desk".into(), version: 3, said_at: Some(1), facts: Facts::default() },
                age_ms: 0,
            }],
            greeting: true,
        });
        assert_eq!(round(roster.clone()), roster);
        let cards = Frame::Cards(CardsMsg::Cards {
            host: "desk".into(),
            version: 1,
            age_ms: 2,
            snapshot: serde_json::json!({ "v": 1, "cards": [] }),
        });
        assert_eq!(round(cards.clone()), cards);
    }

    /// The whole of backward compatibility: an old wall's frame, written by
    /// the old code path, is a frame here.
    #[test]
    fn a_bare_sink_message_from_an_older_wall_reads() {
        let old = serde_json::to_vec(&Msg::Hello { host: "lap".into(), watermark: BTreeMap::new() }).unwrap();
        assert!(matches!(read(&old).unwrap(), Read::Frame(f) if matches!(*f, Frame::Sink(_))));
    }

    #[test]
    fn a_word_from_a_newer_build_is_skipped_not_fatal() {
        let newer = br#"{"msg":"carry","id":"x"}"#;
        assert_eq!(read(newer).unwrap(), Read::Unknown("carry".into()));
    }

    #[test]
    fn a_word_we_know_that_will_not_read_is_passed_over_and_said() {
        assert!(matches!(read(br#"{"msg":"hello","host":7}"#).unwrap(), Read::Malformed(_)));
        /* Not one of ours at all, which does end the read. */
        assert!(read(br#"{"no":"tag"}"#).is_err());
        assert!(read(b"not json").is_err());
    }

    /// **The rule two builds side by side depend on, held at the loop rather
    /// than at one frame.** A newer wall's exchange carries a word this build
    /// has never heard of and an `answer` with an outcome it cannot read, in
    /// among the sink's events; everything this build *can* read must still
    /// arrive, in order, or the sink stops between two machines one release
    /// apart.
    #[test]
    fn a_newer_walls_exchange_still_delivers_everything_this_build_can_read() {
        let hello = serde_json::to_vec(&Frame::Sink(Msg::Hello { host: "lap".into(), watermark: BTreeMap::new() })).unwrap();
        let events = serde_json::to_vec(&Frame::Sink(Msg::Events { events: vec![] })).unwrap();
        let unknown = br#"{"msg":"carry","card":"x","to":"desk"}"#.to_vec();
        let future_answer =
            br#"{"msg":"answer","answer":{"request":"r","by":"desk","asked_by":"lap","outcome":{"outcome":"moved","to":"box"}},"age_ms":0}"#
                .to_vec();
        let mut got = Vec::new();
        for p in [hello.clone(), unknown, future_answer, events.clone()] {
            take(&p, &mut got).expect("nothing here may end the read");
        }
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(matches!(got[0], Frame::Sink(Msg::Hello { .. })));
        assert!(matches!(got[1], Frame::Sink(Msg::Events { .. })));
        /* And a payload that is not one of ours still ends it. */
        assert!(take(b"garbage", &mut got).is_err());
    }

    /// `KNOWN` is the list a malformed frame is told apart from a newer one
    /// by, so it must be exactly the tags the three enums produce.
    #[test]
    fn the_known_words_are_the_ones_the_enums_write() {
        let mut written: Vec<String> = vec![
            serde_json::to_value(Msg::Hello { host: String::new(), watermark: BTreeMap::new() }).unwrap(),
            serde_json::to_value(Msg::Events { events: vec![] }).unwrap(),
            serde_json::to_value(FleetMsg::Roster { walls: vec![], greeting: false }).unwrap(),
            serde_json::to_value(CardsMsg::Cards { host: String::new(), version: 0, age_ms: 0, snapshot: Value::Null }).unwrap(),
        ]
        .into_iter()
        .map(|v| v["msg"].as_str().unwrap().to_string())
        .collect();
        /* `ask` and `answer` want whole structs to build; their tags are the
           variant names under `rename_all = "snake_case"`. */
        written.extend(["ask", "answer", "prompt", "recall", "close"].map(str::to_string));
        written.sort();
        let mut known: Vec<String> = KNOWN.iter().map(|s| s.to_string()).collect();
        known.sort();
        assert_eq!(written, known);
    }
}
