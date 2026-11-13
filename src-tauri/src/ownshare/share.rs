//! The pure half of `ownshare.rs`: what a share is, and the one comparison the
//! door makes with it.
//!
//! Its own file for the reason `repair/text.rs` is one — `cargo test` cannot
//! link on a machine with no MSVC, so the part worth asserting is kept where a
//! lift can compile it verbatim (`tools/lift-ownshare.ts`). Nothing here touches
//! Tauri, a store or a socket.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One account-window's share, as the front end measured it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Share {
    /// The window kind, in the vocabulary `caps` uses.
    pub kind: String,
    /// Points of the window's movement this wall's own facts explain.
    pub points: f64,
    /// Modeled dollars under that movement. Zero means nothing was priced, so
    /// the share is unknown rather than zero and may not hold work back.
    pub priced: f64,
}

/// What the front end notes, one row per account and window kind.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub account: String,
    pub kind: String,
    pub points: f64,
    pub priced: f64,
}

/// The reading as `limits::own_reading` hands it over: a `Report` in JSON, so
/// this file needs nothing of `limits`' own types.
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub kind: String,
    pub used: f64,
}

pub fn readings_of(report: &Value) -> Vec<Reading> {
    report
        .get("windows")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|w| {
                    Some(Reading {
                        kind: w.get("kind")?.as_str()?.to_string(),
                        used: w.get("used")?.as_f64()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// **The comparison, and the whole of what this half decides.**
///
/// Your own share at or past the ceiling you set on that window, and only where
/// the share is a reading rather than a hole (`priced > 0`). The account's own
/// percentage is deliberately not consulted for the ceiling: it is everybody's,
/// and a card held on somebody else's usage is the exact complaint the share
/// exists to answer.
///
/// `None` for every case that is not a ceiling of yours: no cap on that kind, a
/// cap of 100 or more (not a cap at all — `capFor`'s rule in `accounts.ts`), a
/// window the reading does not mention, an account with no share noted.
pub fn refusal(caps: &Value, readings: &[Reading], shares: &[Share]) -> Option<(String, f64, f64)> {
    for reading in readings {
        let Some(cap) = caps.get(&reading.kind).and_then(Value::as_f64) else {
            continue;
        };
        if !(0.0..100.0).contains(&cap) {
            continue;
        }
        let Some(share) = shares
            .iter()
            .find(|s| s.kind == reading.kind && s.priced > 0.0 && s.points.is_finite())
        else {
            continue;
        };
        /* Never above the whole window: the same sanity clamp
           `accounts.ts::measuredFor` makes, so the two cannot disagree about a
           figure that has drifted. */
        let points = share.points.max(0.0).min(reading.used.max(0.0));
        if points >= cap {
            return Some((reading.kind.clone(), points, cap));
        }
    }
    None
}

/// The sentence a prompt is refused with. Says whose ceiling and which window,
/// and what happens next, because a card that simply cannot send reads as the
/// wall being broken.
pub fn refusal_said(label: &str, kind: &str, points: f64, cap: f64) -> String {
    let what = if kind == "session" { "5 hours" } else { "7 days" };
    format!(
        "held at your cap on {label}'s {what} window: this wall's own share is {points:.0}% \
         against the {cap:.0}% ceiling you set. Nothing was sent; it waits until that window \
         resets or you raise the cap."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn share(kind: &str, points: f64, priced: f64) -> Share {
        Share { kind: kind.into(), points, priced }
    }

    fn reading(kind: &str, used: f64) -> Reading {
        Reading { kind: kind.into(), used }
    }

    #[test]
    fn a_share_past_the_cap_is_a_refusal() {
        let caps = json!({ "session": 50 });
        let got = refusal(&caps, &[reading("session", 70.0)], &[share("session", 55.0, 4.0)]);
        assert_eq!(got, Some(("session".into(), 55.0, 50.0)));
    }

    #[test]
    fn and_one_under_it_is_not() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[reading("session", 70.0)], &[share("session", 20.0, 4.0)]).is_none());
    }

    /// Somebody else's usage is the whole reason the share exists.
    #[test]
    fn the_accounts_own_percentage_decides_nothing() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[reading("session", 99.0)], &[share("session", 10.0, 4.0)]).is_none());
    }

    /// Unpriced is unknown, and an unknown share may not hold work back.
    #[test]
    fn a_share_with_nothing_priced_is_not_a_measurement() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[reading("session", 70.0)], &[share("session", 60.0, 0.0)]).is_none());
        assert!(refusal(&caps, &[reading("session", 70.0)], &[]).is_none());
    }

    /// A cap of 100 or more is not a cap (`capFor`'s rule), and no cap is the
    /// overwhelming case on a wall that has never set one.
    #[test]
    fn there_is_no_ceiling_to_be_past() {
        assert!(refusal(&json!({}), &[reading("session", 99.0)], &[share("session", 99.0, 4.0)]).is_none());
        assert!(refusal(&json!({ "session": 100 }), &[reading("session", 99.0)], &[share("session", 99.0, 4.0)]).is_none());
        assert!(refusal(&json!({ "session": 120 }), &[reading("session", 99.0)], &[share("session", 99.0, 4.0)]).is_none());
    }

    /// And the overflow guard: a drifted figure above the whole window is read
    /// as the window, exactly as `measuredFor` reads it.
    #[test]
    fn a_share_cannot_exceed_the_window_it_is_a_share_of() {
        let caps = json!({ "session": 50 });
        let got = refusal(&caps, &[reading("session", 40.0)], &[share("session", 80.0, 4.0)]);
        assert!(got.is_none(), "40 of a window is not past a cap of 50");
    }

    #[test]
    fn the_windows_are_read_off_the_report_as_limits_hands_it_over() {
        let report = json!({
            "windows": [
                { "kind": "session", "used": 70.0, "severity": "normal" },
                { "kind": "weekly_all", "used": 12.0 },
                { "kind": "weekly_scoped", "used": null }
            ]
        });
        let got = readings_of(&report);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], reading("session", 70.0));
        assert_eq!(readings_of(&json!({})).len(), 0);
    }

    #[test]
    fn the_sentence_says_whose_ceiling_and_what_happens_next() {
        let said = refusal_said("lyss", "session", 55.0, 50.0);
        assert!(said.contains("lyss"));
        assert!(said.contains("5 hours"));
        assert!(said.contains("55%"));
        assert!(said.contains("50%"));
        assert!(said.contains("waits until that window resets"));
        assert!(!said.contains('\u{2014}'), "the house voice has no em dash");
    }
}
