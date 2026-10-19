//! What one wall says about its accounts to the walls it flies with: the
//! settings, kept in step, and the readings, shared.
//!
//! `accounts.rs` is the registry and `accounts.ts` the policy. This is the
//! carrying, and it is pure — the vocabulary, the merge and the bounds — so the
//! hard part, *do two walls end up with the same settings*, is tested without a
//! second machine. `accountsync.rs` is the store's half and `link/accounts.rs`
//! the wiring. `.claude/rules/accounts.md`, *One account, every wall*, is the
//! design.
//!
//! ### Why the settings converge rather than one wall owning them
//!
//! The billboard has a home wall and ships a picture of it (`boards.rs`): a
//! notice has one writer. An account has none — Lyss is at whichever laptop she
//! is at, and switching `lyss` off there is the same act as switching it off
//! here. Lyss, 2026-10-19: *"it doesn't make sense to have different account
//! limits and on/off per machine since account are shared"*. So every wall
//! writes, and they must agree afterwards, which is the sink's problem
//! (`sync.rs`) on a much smaller scale: four fields per account.
//!
//! ### A register per field, last write wins, on a hybrid clock
//!
//! Each `(identity, field)` is a register holding the value and the stamp that
//! wrote it, and a register only ever moves to a higher stamp. That is a
//! state-based CRDT: two walls exchanging whole tables in any order, any number
//! of times, end at the same table (`any_order_of_any_exchanges_agrees`).
//!
//! - **Per field, not per account.** Switched off on one wall and capped at 80
//!   on the other while they were apart is two decisions, and both survive. One
//!   register per account would keep whichever was later and silently drop the
//!   other — a cap you set, gone, with nothing to say so.
//! - **The stamp is a hybrid logical clock**: `at = max(now, highest stamp this
//!   wall has seen + 1)`, the host breaking a tie. A bare wall clock would let a
//!   machine running five minutes fast win against a change made after it; the
//!   flyway compares no two machines' clocks anywhere else (`boards.rs`' ages,
//!   `shadow.ts::idleOf`) and this keeps that true where it matters: **a change
//!   made after hearing another always beats it**, whatever either clock says.
//!   Where two changes were genuinely concurrent the wall clock decides, which
//!   is the only honest reading of "last" there is.
//! - **A value nobody has changed under this build is never sent.** Settings
//!   from before `migrate_v56` carry no stamp. Sending them at stamp zero would
//!   leave the first contact after an upgrade to a tie broken by host name —
//!   one wall's caps silently replacing the other's. A schema change may not
//!   move money; a field starts travelling the first time a person changes it.
//! - **A placeholder never leaves.** A change made to an account whose identity
//!   is not yet known is stamped under `label:<label>` (`PLACEHOLDER`) and
//!   merged into the identity when it is learned, so it is not lost — but it
//!   names a label, which is local, and no other wall could match it.
//!
//! ### Readings travel as ages
//!
//! An account's allowance is the account's, whichever machine read it, so a
//! wall that polled a minute ago saves every other wall the request and tells a
//! wall that has not polled at all that the account is at 90%. Only a wall's
//! *own* readings are said (never one it heard), each with how long ago it was
//! taken; the holder adds its own time since hearing. No clock is compared, and
//! `limits.rs` turns the result back into an ordinary dated `Report` so
//! `keptThrough` and the staleness words apply unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// What a wall announces in `Facts::can` when it says its accounts. A frame is
/// sent only to a wall announcing it, so an older wall never meets one and
/// keeps its own settings, untouched.
pub const WORD: &str = "accounts";

/// The four settings that travel. Labels stay local — they are what *this*
/// machine calls a subscription — and so does whether it is signed in, which
/// is a fact about this disk.
pub const FIELDS: [&str; 4] = ["enabled", "caps", "priority", "rank"];

/// The prefix a change made before an account's identity is known is stamped
/// under. Never sent, never accepted.
pub const PLACEHOLDER: &str = "label:";

/* Bounds on what a peer can make this wall hold. An honest wall has a handful
   of accounts; these are a ceiling for a confused one, not a budget. */
pub const IDENTITIES_MOST: usize = 64;
const SETTINGS_MOST: usize = IDENTITIES_MOST * FIELDS.len();
pub const READINGS_MOST: usize = IDENTITIES_MOST;
const IDENTITY_MOST: usize = 160;
const HOST_MOST: usize = 120;
const CAPS_MOST: usize = 24;
const KIND_MOST: usize = 64;
/// The serialised report one reading may carry.
pub const REPORT_MOST: usize = 16 * 1024;

/// One register: a field of one account, and the stamp that wrote it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Register {
    pub identity: String,
    pub field: String,
    pub value: Value,
    pub at: i64,
    pub host: String,
}

impl Register {
    /// Whether this register's stamp beats `(at, host)`. Ties on the clock go
    /// to the host that sorts *later*, case folded — arbitrary, but the same
    /// answer on every wall, which is all a tie-break owes anybody.
    pub fn beats(&self, at: i64, host: &str) -> bool {
        (self.at, self.host.to_lowercase()) > (at, host.to_lowercase())
    }
}

/// One account's allowance as the wall that read it says it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    pub identity: String,
    /// How long before saying it the reading was taken.
    pub age_ms: u64,
    /// `limits::Report`'s shape, read strictly by `limits.rs` on arrival.
    pub report: Value,
}

/// Which refresh-token chain a wall's store holds for one account, and how
/// long ago that store was written — what finds a sign-in that was copied
/// between machines (`accounts.rs`, *a sign-in never leaves its machine*). The
/// digest is salted and cut to 128 bits: it tells two chains apart and is
/// nothing anybody could spend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chain {
    pub identity: String,
    pub digest: String,
    pub age_ms: u64,
}

/// One account as its own wall says it, for a person at another wall to see
/// what could be signed in from there. The label is that wall's name for it;
/// `state` is `signed in`, `not signed in`, `lapsed` or `copied`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Seat {
    pub label: String,
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub email: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum AccountsMsg {
    /// A wall's whole account picture: every register it holds that may
    /// travel, and the readings it took itself.
    Accounts {
        host: String,
        #[serde(default)]
        settings: Vec<Register>,
        #[serde(default)]
        readings: Vec<Reading>,
        #[serde(default)]
        chains: Vec<Chain>,
        #[serde(default)]
        seats: Vec<Seat>,
    },
    /// A person at another wall starting a sign-in of one of this wall's
    /// accounts. Answered on the same stream with `SigninBegun`.
    SigninBegin { id: String, label: String },
    /// The address to finish it at — the CLI's own manual authorize URL, which
    /// carries a PKCE challenge and a state and nothing anybody could spend —
    /// or why there is none.
    SigninBegun {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
    /// The `code#state` the platform page showed the person, for this wall's
    /// waiting `claude auth login` to exchange with its own verifier.
    SigninCode { id: String, label: String, code: String },
    /// How it ended: `signed in`, `refused` or `pending`, as a string for
    /// `act::ActMsg`'s reason — a newer build's word reads as a refusal here.
    SigninDone {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        why: Option<String>,
    },
}

/// Every `msg` this vocabulary writes, for `frame::KNOWN`.
pub const TAGS: [&str; 5] = ["accounts", "signin_begin", "signin_begun", "signin_code", "signin_done"];

/// What a wall announces in `Facts::can` when it can be signed in from another
/// wall. Apart from `WORD` so an account picture and a sign-in can be told
/// apart by a peer from a build that has one and not the other.
pub const SIGNIN_WORD: &str = "signin";

const URL_MOST: usize = 4_096;
const CODE_MOST: usize = 4_096;
const WHY_MOST: usize = 1_000;
const SEATS_MOST: usize = IDENTITIES_MOST;

/// The last authorize URL in what a `claude auth login` has printed — the
/// manual one, which is the only one a browser on another machine can finish
/// (its redirect is the platform's page that shows a code, never this
/// machine's localhost). Matched on the durable half, `oauth/authorize`, as
/// `signin.ts` does. Pure, so the matching is tested here.
pub fn authorize_url(out: &str) -> Option<String> {
    out.split(|c: char| c.is_whitespace())
        .filter(|w| (w.starts_with("https://") || w.starts_with("http://")) && w.contains("oauth/authorize"))
        .map(|w| w.trim_end_matches(['.', ',', ')', '"', '\'']).to_string())
        .next_back()
}

/// An authorize URL off the wire, held to its shape before it is put in front
/// of a person as a link: https, an authorize path, bounded, no control
/// characters.
pub fn admit_url(u: &str) -> Option<String> {
    let u = u.trim();
    (u.starts_with("https://") && u.contains("oauth/authorize") && u.len() <= URL_MOST && !u.chars().any(char::is_control))
        .then(|| u.to_string())
}

/// A pasted code off the wire, held to its shape before it is written to a
/// child's stdin: one line, bounded, no control characters.
pub fn admit_code(c: &str) -> Option<String> {
    let c = c.trim();
    (!c.is_empty() && c.len() <= CODE_MOST && !c.chars().any(char::is_control)).then(|| c.to_string())
}

/// A refusal from another wall, held to a sentence.
pub fn admit_why(w: &str) -> String {
    crate::clip::preview(&crate::clean::scrub(w.trim()), WHY_MOST)
}

/// The seats a picture carries, bounded and held to shape.
pub fn admitted_seats(seats: &[Seat]) -> Vec<Seat> {
    const STATES: [&str; 4] = ["signed in", "not signed in", "lapsed", "copied"];
    seats
        .iter()
        .take(SEATS_MOST)
        .filter(|s| crate::accounts::is_label(&s.label) && STATES.contains(&s.state.as_str()))
        .map(|s| Seat {
            label: s.label.clone(),
            identity: if is_identity(&s.identity) { s.identity.clone() } else { String::new() },
            email: crate::clip::preview(&crate::clean::scrub(s.email.trim()), 200),
            state: s.state.clone(),
        })
        .collect()
}

/// The stamp a change made now takes: the wall clock, unless this wall has
/// already seen a stamp at or past it.
pub fn next_stamp(now: i64, highest: i64) -> i64 {
    now.max(highest.saturating_add(1))
}

/// Whether `s` is an identity that may cross: `<account uuid>:<org uuid>`, each
/// half a uuid's alphabet. A placeholder never is.
pub fn is_identity(s: &str) -> bool {
    if s.len() > IDENTITY_MOST || s.starts_with(PLACEHOLDER) {
        return false;
    }
    let Some((a, o)) = s.split_once(':') else { return false };
    let half = |h: &str| !h.is_empty() && h.len() <= 64 && h.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    half(a) && half(o)
}

/// A field's value, held to its shape — or `None`, and the register is
/// refused. The same rules a local write is held to (`accountsync::stamp`), so
/// a peer cannot put on this wall what its own panel could not.
pub fn normal(field: &str, v: &Value) -> Option<Value> {
    match field {
        "enabled" => v.as_bool().map(Value::Bool),
        "priority" => v.as_i64().filter(|p| (1..=1_000).contains(p)).map(Value::from),
        "rank" => v.as_i64().filter(|r| (0..=100_000).contains(r)).map(Value::from),
        "caps" => {
            let o = v.as_object()?;
            if o.len() > CAPS_MOST {
                return None;
            }
            let mut out = serde_json::Map::new();
            for (k, c) in o {
                if k.is_empty() || k.len() > KIND_MOST || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    return None;
                }
                let n = c.as_f64().filter(|n| n.is_finite() && (0.0..=1_000.0).contains(n))?;
                out.insert(k.clone(), Value::from(n));
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}

/// A register off the wire, held to every bound — or `None`.
pub fn admit(r: &Register) -> Option<Register> {
    if !is_identity(&r.identity) || !FIELDS.contains(&r.field.as_str()) {
        return None;
    }
    let host = crate::clean::scrub(r.host.trim()).into_owned();
    if host.is_empty() || host.len() > HOST_MOST || r.at <= 0 {
        return None;
    }
    Some(Register { identity: r.identity.clone(), field: r.field.clone(), value: normal(&r.field, &r.value)?, at: r.at, host })
}

/// What a wall's picture may say, bounded: the registers that may travel, and
/// the readings, each list cut at its ceiling.
pub fn say(host: &str, settings: Vec<Register>, readings: Vec<Reading>, chains: Vec<Chain>, seats: Vec<Seat>) -> AccountsMsg {
    let settings = settings
        .into_iter()
        .filter(|r| is_identity(&r.identity) && r.at > 0)
        .take(SETTINGS_MOST)
        .collect();
    let readings = readings.into_iter().filter(|r| is_identity(&r.identity)).take(READINGS_MOST).collect();
    let chains = chains.into_iter().filter(admit_chain).take(READINGS_MOST).collect();
    let seats = seats.into_iter().take(SEATS_MOST).collect();
    AccountsMsg::Accounts { host: host.to_string(), settings, readings, chains, seats }
}

/// The registers a picture carries that may be taken, in the order given —
/// anything out of shape dropped, the rest bounded.
pub fn admitted(settings: &[Register]) -> Vec<Register> {
    settings.iter().take(SETTINGS_MOST).filter_map(admit).collect()
}

/// The pure merge, over a map standing for the `account_sync` table: take
/// every register that beats what is held. Returns the keys that moved. The
/// store's `accountsync::receive` is this, one register at a time, against
/// SQLite; this is what the property is tested on.
pub fn merge(held: &mut BTreeMap<(String, String), Register>, incoming: &[Register]) -> Vec<(String, String)> {
    let mut moved = Vec::new();
    for r in admitted(incoming) {
        let key = (r.identity.clone(), r.field.clone());
        let wins = held.get(&key).is_none_or(|h| r.beats(h.at, &h.host));
        if wins {
            held.insert(key.clone(), r);
            moved.push(key);
        }
    }
    moved
}

/// A reading off the wire: an identity that may cross and a report small
/// enough to hold. The report's shape is `limits.rs`'s to read.
pub fn admit_reading(r: &Reading) -> bool {
    is_identity(&r.identity) && serde_json::to_vec(&r.report).map(|b| b.len() <= REPORT_MOST).unwrap_or(false)
}

/// A chain off the wire: an identity that may cross and a digest of the shape
/// `accounts::chain_digest` writes.
pub fn admit_chain(c: &Chain) -> bool {
    is_identity(&c.identity) && c.digest.len() == 32 && c.digest.chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Two walls hold the same chain for one account: whether *this* wall's store
/// is the copy, and so the one to retire.
///
/// While the digests match, neither store has refreshed since the copy was made,
/// so the original was last written by its own sign-in or refresh and the copy
/// by the install that came after it: **the store written more recently is the
/// copy.** Two ages, each measured on its own wall's clock, so no two clocks are
/// compared. A tie — which needs two writes in the same millisecond — goes by
/// host name, the later one retiring, so the two walls still agree.
pub fn is_the_copy(mine_ms: u64, theirs_ms: u64, me: &str, them: &str) -> bool {
    match mine_ms.cmp(&theirs_ms) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => me.to_lowercase() > them.to_lowercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const X: &str = "8ebb2352-0000-4000-8000-000000000001:10340709-0000-4000-8000-000000000002";
    const Y: &str = "aaaa2352-0000-4000-8000-000000000001:bbbb0709-0000-4000-8000-000000000002";

    fn reg(id: &str, field: &str, value: Value, at: i64, host: &str) -> Register {
        Register { identity: id.into(), field: field.into(), value, at, host: host.into() }
    }

    /// **The property the feature rests on**: walls exchanging their tables in
    /// any order, any number of times, end with the same table. Every
    /// permutation of six registers from three walls, folded into empty maps.
    #[test]
    fn any_order_of_any_exchanges_agrees() {
        let all = vec![
            reg(X, "enabled", json!(false), 100, "QUEERISFREEDOM"),
            reg(X, "enabled", json!(true), 105, "AU-LT-288"),
            reg(X, "caps", json!({ "session": 80 }), 101, "QUEERISFREEDOM"),
            reg(X, "caps", json!({ "session": 60 }), 101, "AU-LT-288"),
            reg(Y, "priority", json!(2), 50, "box"),
            reg(X, "rank", json!(3), 7, "box"),
        ];
        let mut expected: Option<BTreeMap<(String, String), Register>> = None;
        let n = all.len();
        let mut idx: Vec<usize> = (0..n).collect();
        /* Heap's algorithm: every ordering, 720 of them. */
        let mut c = vec![0usize; n];
        let mut check = |order: &[usize]| {
            let mut m = BTreeMap::new();
            for &i in order {
                merge(&mut m, std::slice::from_ref(&all[i]));
            }
            /* And a second exchange of everything changes nothing. */
            assert!(merge(&mut m, &all).is_empty());
            match &expected {
                None => expected = Some(m),
                Some(e) => assert_eq!(&m, e),
            }
        };
        check(&idx);
        let mut i = 0;
        while i < n {
            if c[i] < i {
                if i % 2 == 0 { idx.swap(0, i) } else { idx.swap(c[i], i) }
                check(&idx);
                c[i] += 1;
                i = 0;
            } else {
                c[i] = 0;
                i += 1;
            }
        }
        let e = expected.unwrap();
        /* Per field: the later on/off and the tie on caps both settled, and the
           unrelated fields kept — nothing one wall said dropped another's. */
        assert_eq!(e[&(X.to_string(), "enabled".to_string())].value, json!(true));
        assert_eq!(e[&(X.to_string(), "caps".to_string())].host, "QUEERISFREEDOM", "a clock tie goes to the later host name");
        assert_eq!(e.len(), 4);
    }

    /// Two decisions made apart both survive — the reason it is per field.
    #[test]
    fn switched_off_here_and_capped_there_are_both_kept() {
        let mut a = BTreeMap::new();
        merge(&mut a, &[reg(X, "enabled", json!(false), 10, "a")]);
        let mut b = BTreeMap::new();
        merge(&mut b, &[reg(X, "caps", json!({ "weekly_all": 70 }), 20, "b")]);
        let a_said: Vec<Register> = a.values().cloned().collect();
        let b_said: Vec<Register> = b.values().cloned().collect();
        merge(&mut a, &b_said);
        merge(&mut b, &a_said);
        assert_eq!(a, b);
        assert_eq!(a.len(), 2);
    }

    /// The clock: a change made after hearing another beats it even when this
    /// machine's clock is behind the other's.
    #[test]
    fn a_change_made_after_hearing_beats_it_whatever_the_clocks_say() {
        /* The other wall runs five minutes fast and stamped at 1_000_300_000. */
        let theirs = reg(X, "enabled", json!(false), 1_000_300_000, "fast");
        /* This wall heard it, and its own clock reads 1_000_000_000. */
        let mine_at = next_stamp(1_000_000_000, theirs.at);
        let mine = reg(X, "enabled", json!(true), mine_at, "slow");
        assert!(mine.beats(theirs.at, &theirs.host));
        let mut m = BTreeMap::new();
        merge(&mut m, &[theirs, mine]);
        assert_eq!(m[&(X.to_string(), "enabled".to_string())].value, json!(true));
        /* And with nothing seen, the wall clock is the stamp. */
        assert_eq!(next_stamp(42, 0), 42);
    }

    /// Nothing unstamped and nothing placeholder ever leaves, and neither is
    /// taken if a peer sends one anyway.
    #[test]
    fn unstamped_and_placeholder_registers_never_travel() {
        let m = say(
            "me",
            vec![
                reg(X, "enabled", json!(true), 0, "me"),
                reg("label:lyss", "enabled", json!(true), 9, "me"),
                reg(X, "caps", json!({}), 9, "me"),
            ],
            vec![],
            vec![],
            vec![],
        );
        let AccountsMsg::Accounts { settings, .. } = m else { panic!() };
        assert_eq!(settings.len(), 1);
        assert_eq!(settings[0].field, "caps");
        assert!(admit(&reg("label:lyss", "enabled", json!(true), 9, "x")).is_none());
        assert!(admit(&reg(X, "enabled", json!(true), 0, "x")).is_none());
    }

    /// A peer cannot put on this wall what its own panel could not.
    #[test]
    fn a_value_out_of_shape_is_refused() {
        assert!(admit(&reg(X, "enabled", json!("yes"), 1, "x")).is_none());
        assert!(admit(&reg(X, "priority", json!(0), 1, "x")).is_none());
        assert!(admit(&reg(X, "priority", json!(2.5), 1, "x")).is_none());
        assert!(admit(&reg(X, "rank", json!(-1), 1, "x")).is_none());
        assert!(admit(&reg(X, "caps", json!({ "session": "80" }), 1, "x")).is_none());
        assert!(admit(&reg(X, "caps", json!({ "a b": 80 }), 1, "x")).is_none());
        assert!(admit(&reg(X, "label", json!("lyss"), 1, "x")).is_none(), "a label is local");
        assert!(admit(&reg("not-an-identity", "enabled", json!(true), 1, "x")).is_none());
        assert!(admit(&reg(X, "enabled", json!(true), 1, "")).is_none());
        let ok = admit(&reg(X, "caps", json!({ "session": 80, "weekly_all": 100 }), 1, " x ")).unwrap();
        assert_eq!(ok.host, "x");
        assert_eq!(ok.value, json!({ "session": 80.0, "weekly_all": 100.0 }));
    }

    #[test]
    fn an_identity_is_two_uuids() {
        assert!(is_identity(X));
        assert!(!is_identity("abc"));
        assert!(!is_identity("abc:"));
        assert!(!is_identity("abc:de f"));
        assert!(!is_identity("label:lyss"));
        assert!(!is_identity(&format!("{}:{}", "a".repeat(65), "b")));
    }

    #[test]
    fn the_frame_comes_back_as_itself() {
        let m = say(
            "desk",
            vec![reg(X, "enabled", json!(false), 5, "desk")],
            vec![Reading { identity: X.into(), age_ms: 30_000, report: json!({ "windows": [] }) }],
            vec![Chain { identity: X.into(), digest: "0".repeat(32), age_ms: 5 }, Chain { identity: X.into(), digest: "nope".into(), age_ms: 5 }],
            vec![Seat { label: "lyss".into(), identity: X.into(), email: "l@example.com".into(), state: "lapsed".into() }],
        );
        let text = serde_json::to_string(&m).unwrap();
        assert!(text.contains("\"msg\":\"accounts\""));
        let back: AccountsMsg = serde_json::from_str(&text).unwrap();
        assert_eq!(back, m);
        let AccountsMsg::Accounts { chains, .. } = &back else { panic!() };
        assert_eq!(chains.len(), 1, "a digest not of the shape written is not said");
        /* A wall from a later build adding a field to the picture is still read. */
        let later = r#"{"msg":"accounts","host":"x","settings":[],"readings":[],"chains":[],"signins":[{"what":"new"}]}"#;
        assert!(serde_json::from_str::<AccountsMsg>(later).is_ok());
    }

    /// The store written more recently is the copy, and the two walls agree on
    /// it from their own ages alone — even on an exact tie.
    #[test]
    fn the_copy_is_the_store_written_since() {
        /* Signed in on the desk a week ago, copied to the laptop yesterday. */
        let week = 7 * 86_400_000;
        let day = 86_400_000;
        assert!(is_the_copy(day, week, "LAPTOP", "DESK"), "the laptop's store is younger: it is the copy");
        assert!(!is_the_copy(week, day, "DESK", "LAPTOP"), "and the desk keeps its sign-in");
        assert_ne!(is_the_copy(5, 5, "a", "b"), is_the_copy(5, 5, "b", "a"), "a tie still has one copy");
    }

    /// The manual authorize URL is read out of what `auth login` printed, the
    /// last one if there were several, without the punctuation around it.
    #[test]
    fn the_authorize_url_is_the_last_one_printed() {
        let out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc\nPaste code here if prompted > ";
        assert_eq!(authorize_url(out).as_deref(), Some("https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc"));
        assert_eq!(authorize_url("visit (https://a.example/oauth/authorize?s=1). or https://b.example/oauth/authorize?s=2.").as_deref(), Some("https://b.example/oauth/authorize?s=2"));
        assert!(authorize_url("Paste code here if prompted > ").is_none());
        assert!(authorize_url("https://claude.com/login").is_none());
    }

    /// What crosses is held to its shape on the way in: a URL a person will
    /// click, a code a child will read, a seat a panel will draw.
    #[test]
    fn what_a_sign_in_carries_is_held_to_its_shape() {
        assert!(admit_url("https://claude.com/cai/oauth/authorize?x=1").is_some());
        assert!(admit_url("http://claude.com/cai/oauth/authorize?x=1").is_none(), "https only");
        assert!(admit_url("https://evil.example/login").is_none());
        assert!(admit_url("https://claude.com/cai/oauth/authorize?x=1\u{7}").is_none());
        assert_eq!(admit_code(" abc#def \n").as_deref(), Some("abc#def"));
        assert!(admit_code("a\nb").is_none(), "one line, or the child reads two answers");
        assert!(admit_code("").is_none());
        let seats = admitted_seats(&[
            Seat { label: "lyss".into(), identity: X.into(), email: "l@example.com".into(), state: "copied".into() },
            Seat { label: "../x".into(), identity: X.into(), email: String::new(), state: "lapsed".into() },
            Seat { label: "ok".into(), identity: "nope".into(), email: String::new(), state: "dancing".into() },
        ]);
        assert_eq!(seats.len(), 1);
        assert_eq!(seats[0].state, "copied");
    }

    #[test]
    fn a_reading_too_large_is_not_held() {
        assert!(admit_reading(&Reading { identity: X.into(), age_ms: 0, report: json!({}) }));
        let big = json!({ "windows": "x".repeat(REPORT_MOST) });
        assert!(!admit_reading(&Reading { identity: X.into(), age_ms: 0, report: big }));
        assert!(!admit_reading(&Reading { identity: "label:x".into(), age_ms: 0, report: json!({}) }));
    }
}
