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
///
/// **Everything the comparison needs travels in the note**, including the
/// reading it is a share of. The first cut read the account's percentage out of
/// `limits::own_reading` and that was two failure modes for one lookup: the
/// cache is emptied whenever the last usage widget detaches and is only filled
/// by a successful poll, so the door silently stopped enforcing; and a cached
/// figure can describe a window that has since rolled, so the door refused a
/// prompt the wall had every right to send.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Share {
    /// The window kind, in the vocabulary `caps` uses.
    pub kind: String,
    /// Points of the window's movement this wall's own facts explain.
    pub points: f64,
    /// Modeled dollars under that movement. Zero means nothing was priced, so
    /// the share is unknown rather than zero and may not hold work back.
    pub priced: f64,
    /// Did this wall work in this window at all, priced or not. `None` is a
    /// caller that did not say, which is read as unknown.
    pub worked: Option<bool>,
    /// The account's own percentage at the sample this share was measured over.
    pub used: f64,
    /// When that window rolls, so a note about one that has already rolled is
    /// recognised rather than enforced.
    pub resets_at: Option<i64>,
}

/// What the front end notes, one row per account and window kind.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub account: String,
    pub kind: String,
    pub points: f64,
    pub priced: f64,
    #[serde(default)]
    pub worked: Option<bool>,
    #[serde(default)]
    pub used: f64,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

/// **The comparison, and the whole of what this half decides.**
///
/// Your own share at or past the ceiling you set on that window. The account's
/// own percentage is never the thing compared — it is everybody's, and a card
/// held on somebody else's usage is the exact complaint the share exists to
/// answer. It is only the clamp, because a share cannot exceed the whole.
///
/// Three states, and the difference between them is the point:
///
/// - **`worked: Some(false)`** — this wall spent nothing in this window. Its
///   share is zero, whatever the account reads, so a ceiling of 50 does not
///   hold the first prompt of a five-hour window because somebody else filled
///   it. A ceiling of **0** still refuses, which is what a cap of zero means.
/// - **`priced: 0`** — this wall worked and no request under the window could
///   be priced, so the share is unknown rather than zero and the door does not
///   pretend to a figure it does not have. The front end falls back to the
///   account's own percentage in exactly this case, and it does so on its side;
///   see `ownshare.rs` on why the two are allowed to differ here and nowhere
///   else.
/// - **otherwise** — the share, clamped to the window.
///
/// `None` for a window with no cap of yours (`capFor`'s rule: a cap of 100 or
/// more is not a cap), and for one whose reset has already passed, since a note
/// two minutes old can describe the window before the one being judged.
pub fn refusal(caps: &Value, shares: &[Share], now: i64) -> Option<(String, f64, f64)> {
    for share in shares {
        let Some(cap) = caps.get(&share.kind).and_then(Value::as_f64) else {
            continue;
        };
        if !(0.0..100.0).contains(&cap) {
            continue;
        }
        if share.resets_at.is_some_and(|t| t <= now) {
            continue;
        }
        let points = match share.worked {
            Some(false) => 0.0,
            _ if !(share.priced > 0.0) || !share.points.is_finite() => continue,
            _ => share.points.max(0.0).min(share.used.max(0.0)),
        };
        if points >= cap {
            return Some((share.kind.clone(), points, cap));
        }
    }
    None
}

/// The sentence a prompt is refused with. Says whose ceiling and which window,
/// and what happens next, because a card that simply cannot send reads as the
/// wall being broken.
pub fn refusal_said(label: &str, kind: &str, points: f64, cap: f64) -> String {
    let what = if kind == "session" {
        "5 hours".to_string()
    } else if kind.starts_with("weekly") {
        "7 days".to_string()
    } else {
        kind.replace('_', " ")
    };
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

    const SOON: i64 = 4_000_000_000_000;

    fn share(kind: &str, points: f64, priced: f64, used: f64) -> Share {
        Share {
            kind: kind.into(),
            points,
            priced,
            worked: Some(true),
            used,
            resets_at: Some(SOON),
        }
    }

    #[test]
    fn a_share_past_the_cap_is_a_refusal() {
        let caps = json!({ "session": 50 });
        let got = refusal(&caps, &[share("session", 55.0, 4.0, 70.0)], 1);
        assert_eq!(got, Some(("session".into(), 55.0, 50.0)));
    }

    #[test]
    fn and_one_under_it_is_not() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[share("session", 20.0, 4.0, 70.0)], 1).is_none());
    }

    /// Somebody else's usage is the whole reason the share exists.
    #[test]
    fn the_accounts_own_percentage_decides_nothing() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[share("session", 10.0, 4.0, 99.0)], 1).is_none());
    }

    /// Nothing to report is a share of zero, however full the account is — and
    /// a ceiling of zero still refuses, because that is what it means.
    #[test]
    fn a_window_this_wall_did_not_work_in_is_not_its_doing() {
        let none = Share { worked: Some(false), priced: 0.0, points: 0.0, ..share("session", 0.0, 0.0, 90.0) };
        assert!(refusal(&json!({ "session": 50 }), &[none.clone()], 1).is_none());
        assert!(refusal(&json!({ "session": 0 }), &[none], 1).is_some());
    }

    /// Unpriced is unknown, and an unknown share may not hold work back.
    #[test]
    fn a_share_with_nothing_priced_is_not_a_measurement() {
        let unknown = Share { priced: 0.0, ..share("session", 0.0, 0.0, 70.0) };
        assert!(refusal(&json!({ "session": 50 }), &[unknown], 1).is_none());
        assert!(refusal(&json!({ "session": 50 }), &[], 1).is_none());
    }

    /// A note two minutes old can describe the window before this one.
    #[test]
    fn a_note_about_a_window_that_has_rolled_holds_nothing() {
        let rolled = Share { resets_at: Some(10), ..share("session", 80.0, 4.0, 90.0) };
        assert!(refusal(&json!({ "session": 50 }), &[rolled], 1_000).is_none());
    }

    /// A cap of 100 or more is not a cap (`capFor`'s rule), and no cap is the
    /// overwhelming case on a wall that has never set one.
    #[test]
    fn there_is_no_ceiling_to_be_past() {
        assert!(refusal(&json!({}), &[share("session", 99.0, 4.0, 99.0)], 1).is_none());
        assert!(refusal(&json!({ "session": 100 }), &[share("session", 99.0, 4.0, 99.0)], 1).is_none());
        assert!(refusal(&json!({ "session": 120 }), &[share("session", 99.0, 4.0, 99.0)], 1).is_none());
    }

    /// And the overflow guard: a drifted figure above the whole window is read
    /// as the window, exactly as `measuredFor` reads it.
    #[test]
    fn a_share_cannot_exceed_the_window_it_is_a_share_of() {
        let caps = json!({ "session": 50 });
        assert!(refusal(&caps, &[share("session", 80.0, 4.0, 40.0)], 1).is_none());
    }

    /// A note written by an older build, or by hand, carries no `worked`: that
    /// is unknown, and unknown falls to the priced check rather than to zero.
    #[test]
    fn a_note_that_does_not_say_whether_the_wall_worked_is_unknown() {
        let quiet = Share { worked: None, ..share("session", 60.0, 4.0, 70.0) };
        assert!(refusal(&json!({ "session": 50 }), &[quiet], 1).is_some());
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
        /* A kind nobody has heard of is titled from its own name rather than
           called a week. */
        assert!(refusal_said("lys", "nimbus_quill", 1.0, 0.0).contains("nimbus quill"));
    }
}
