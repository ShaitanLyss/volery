//! The fleet's live beat: what each wall is spending right now (§8.3, §20.1).
//!
//! **This is not a finer rollup.** The hourly tier is the sync grain because a
//! day is a union with one owner and an hour is the only bucket two timezones
//! cannot disagree about. This module carries the other question, the one no
//! bucket answers: what is arriving at this moment on the other machine. It is
//! ephemeral by design, nothing it carries is stored, and a wall with no
//! analytics view open says nothing at all.
//!
//! ### Two seconds, on its own exchange, and only while somebody is looking
//!
//! §20.1 weighed a faster roster, an exchange of its own, a pull at open time
//! and a persistent stream. It chose the exchange of its own: a `live` frame
//! every [`BEAT_EVERY_MS`], sent as an exchange of its own so it can never
//! queue in front of a prompt, an answer or a close, and **abandoned rather
//! than retried** when it is slow or lost. The roster is the backstop, so a
//! lost beat costs a reading, never a fact.
//!
//! **A persistent stream was rejected, and the reason is the failure that
//! matters here**: a long-lived connection has a state the flyway's
//! request/response model does not, and the worst thing this reading can do is
//! draw a dead stream as a quiet wall. If it is ever built, that is the failure
//! it owes an answer to first.
//!
//! ### A beat is a rate, not a count
//!
//! What crosses is tokens and dollars per minute over the sender's own last
//! minute, not the raw totals. A rate needs no reconciliation between two walls
//! whose beats start at different instants, and a lost beat costs nothing: the
//! next one carries its own window rather than a hole somebody has to notice.
//!
//! The face draws the age of every line (§20.1), and **never interpolates
//! between two beats**: a line drawn through two points two seconds apart and
//! one drawn through two thirty seconds apart are the same lie at different
//! resolutions.

use serde::{Deserialize, Serialize};

use crate::clip;

/// The word a wall announces to say it understands this frame.
pub const WORD: &str = "live";

/// How often a wall with a view open says its beat.
pub const BEAT_EVERY_MS: i64 = 2_000;

/// How old a beat may be before the face calls the line stale. Three beats:
/// two lost in a row is a blip, three is a link that is not working.
pub const STALE_AFTER_MS: i64 = 3 * BEAT_EVERY_MS;

/// The word this module puts on the wire, for the test that holds every
/// vocabulary in `frame.rs` to a `TAGS`.
pub const TAGS: [&str; 1] = [WORD];

/// How long a host name may be. The same cap every other host field takes.
const HOST_KEEP: usize = 80;

/// The machine's own half of a beat (§8.3, `machinefacts.rs`).
///
/// **Every field is optional, and that is the rule rather than a wire
/// convenience**: a counter a wall cannot read is absent, never zero, so a GPU
/// this build cannot ask about does not draw as an idle one on every other
/// machine. An older wall sends none of these at all, and the whole struct
/// defaults to absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Now {
    /// The whole machine, 0–100.
    pub cpu: Option<f32>,
    pub mem_used: Option<u64>,
    pub mem_total: Option<u64>,
    /// The busiest GPU engine, 0–100.
    pub gpu: Option<f32>,
    /// Bytes per second over the sender's last sampling interval.
    pub net_rx: Option<u64>,
    pub net_tx: Option<u64>,
    /// Cards on that wall working in a worktree.
    pub worktrees: Option<u32>,
}

/// One wall's beat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum LiveMsg {
    Live {
        host: String,
        /// When the sender took the reading, by its own clock. The receiver
        /// measures age against the same skew it already tolerates for every
        /// other frame, and never against this field alone.
        at: i64,
        /// Tokens processed per minute over the sender's last minute.
        tokens: f64,
        /// Modeled dollars per minute over the same window.
        usd: f64,
        /// Requests per minute over the same window.
        requests: f64,
        /// What that machine's hardware was doing, where it could be read.
        /// **`default` on the way in**, so a beat from a build before this
        /// field is a beat that says nothing about its machine rather than a
        /// frame that fails to parse and leaves the wall dark.
        #[serde(default)]
        now: Option<Now>,
    },
}

/// One beat, with its numbers made safe at the boundary.
///
/// **A non-finite number is sent as zero rather than as itself.** A NaN in a
/// `f64` does not survive JSON (`serde_json` refuses it), so a beat carrying
/// one would be a frame that never leaves — and the wall that computed it
/// would look dark to every peer for a reason nothing reports. Zero is a quiet
/// reading, which is the honest direction to fail in for a figure nobody acts
/// on.
pub fn beat(
    host: &str,
    at: i64,
    tokens: f64,
    usd: f64,
    requests: f64,
    now: Option<Now>,
) -> LiveMsg {
    LiveMsg::Live {
        host: clip::keep(host, HOST_KEEP).kept,
        at,
        tokens: finite(tokens),
        usd: finite(usd),
        requests: finite(requests),
        now: now.map(clean_now),
    }
}

fn finite(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        0.0
    }
}

/// A percentage clamped to its own unit, and dropped rather than sent as a
/// value that is not a number: the same rule the spend figures follow.
fn percent(v: Option<f32>) -> Option<f32> {
    v.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 100.0))
}

fn clean_now(now: Now) -> Now {
    Now {
        cpu: percent(now.cpu),
        gpu: percent(now.gpu),
        mem_used: now.mem_used,
        mem_total: now.mem_total,
        net_rx: now.net_rx,
        net_tx: now.net_tx,
        worktrees: now.worktrees,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_beat_says_its_own_word_and_round_trips() {
        let one = beat("AU-LT-285", 1_764_000_000_000, 12_500.0, 0.42, 3.0, None);
        let raw = serde_json::to_string(&one).unwrap();
        assert!(raw.contains("\"msg\":\"live\""), "{raw}");
        let back: crate::frame::Frame = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, crate::frame::Frame::Live(one));
    }

    /// A beat is a wall saying it is well, and a `NaN` cannot be said: it is
    /// not representable in JSON, so a frame carrying one never leaves and the
    /// wall looks dark for no reason. Zeros are a quiet wall, which is honest.
    #[test]
    fn a_number_that_is_not_one_is_sent_as_quiet() {
        let one = beat("w", 1, f64::NAN, f64::INFINITY, -3.0, None);
        match one {
            LiveMsg::Live { tokens, usd, requests, .. } => {
                assert_eq!((tokens, usd, requests), (0.0, 0.0, 0.0));
            }
        }
    }

    #[test]
    fn a_host_is_capped_like_every_other_one() {
        let long = "h".repeat(HOST_KEEP + 40);
        match beat(&long, 1, 0.0, 0.0, 0.0, None) {
            LiveMsg::Live { host, .. } => assert_eq!(host.chars().count(), HOST_KEEP),
        }
    }

    /// The machine's half travels with the spend, and a wall that cannot read a
    /// counter says nothing about it rather than sending a zero.
    #[test]
    fn a_beat_carries_the_machine_where_it_can_read_it() {
        let one = beat(
            "w",
            1,
            10.0,
            0.0,
            1.0,
            Some(Now {
                cpu: Some(37.5),
                mem_used: Some(8 << 30),
                mem_total: Some(32 << 30),
                gpu: None,
                net_rx: Some(1_000),
                net_tx: Some(500),
                worktrees: Some(2),
            }),
        );
        let raw = serde_json::to_string(&one).unwrap();
        assert!(raw.contains("\"cpu\":37.5"), "{raw}");
        assert!(raw.contains("\"gpu\":null"), "{raw}");
        let back: crate::frame::Frame = serde_json::from_str(&raw).unwrap();
        assert_eq!(back, crate::frame::Frame::Live(one));
    }

    /// **A beat from a build before this field is a reading, not a broken
    /// frame.** The whole point of the optional machine half is that the fleet
    /// is mixed for months at a time.
    #[test]
    fn an_older_beat_without_a_machine_still_parses() {
        let raw = r#"{"msg":"live","host":"old","at":5,"tokens":1.0,"usd":0.0,"requests":2.0}"#;
        let back: crate::frame::Frame = serde_json::from_str(raw).unwrap();
        match back {
            crate::frame::Frame::Live(LiveMsg::Live { host, now, .. }) => {
                assert_eq!(host, "old");
                assert_eq!(now, None);
            }
            other => panic!("not a live frame: {other:?}"),
        }
    }

    /// A percentage outside its unit, or one that is not a number, is dropped.
    #[test]
    fn a_machine_reading_stays_inside_its_own_units() {
        let one = beat(
            "w",
            1,
            0.0,
            0.0,
            0.0,
            Some(Now { cpu: Some(140.0), gpu: Some(f32::NAN), ..Default::default() }),
        );
        match one {
            LiveMsg::Live { now: Some(now), .. } => {
                assert_eq!(now.cpu, Some(100.0));
                assert_eq!(now.gpu, None);
            }
            _ => panic!("no machine half"),
        }
    }
}
