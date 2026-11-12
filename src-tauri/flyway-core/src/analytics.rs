//! The fleet's hourly rollups on the wire: one owner's day, and how two walls
//! agree they hold the same one.
//!
//! `docs/ANALYTICS.md` §8 owns the reasoning. This module is the carrying, and
//! it is pure: the row shapes, the digest over them, and the one exchange that
//! asks a wall for a day.
//!
//! ### A day is a union, because a fact has one owner
//!
//! Every row in `usage_hour` was written by the machine that produced it, and
//! no two walls ever write the same `(host, hour, …)` key. So merging another
//! wall's day needs no stamps and no tie-break: the day is written once by its
//! owner, replaced whole when the owner's copy changes, and never merged field
//! by field. Two walls that have seen the same day therefore hold byte-identical
//! rows rather than two sums of the same work.
//!
//! **A day is replaced rather than added to**, which is the one rule that makes
//! replaying a frame a no-op. An incremental merge would add a day's rows to
//! rows already there the first time it was re-sent, and the total would double
//! without anything looking wrong.
//!
//! ### The digest covers the sidecars, not only the rows
//!
//! The rows cannot be joined to a card, a branch or an agent without
//! `analytics_session` and `analytics_agent` (§8.2), so a day travels with
//! both. They are in the digest for the same reason: a session row's
//! `ended_at` and a card's branch change after the fact, and a digest over the
//! rows alone would leave a peer that already held the day with a stale
//! sidecar for ever, because it would never ask again.
//!
//! ### A day that does not match its own digest is refused whole
//!
//! The owner is authoritative, so a mismatch means a truncated or altered
//! frame, never a correction to apply. Storing the rows anyway is how a wall
//! ends up with a day nobody can tell is short, which is the failure the
//! count and the digest exist to make visible (`usage_day_digest`).

use serde::{Deserialize, Serialize};

use crate::clip;

/// The word this vocabulary announces in `Facts::can`: a wall that says it
/// holds rollups worth asking for.
pub const WORD: &str = "analytics";
pub const ASK: &str = "analytics_ask";
pub const DAY: &str = "analytics_day";

/// Every tag this module writes, held against the enum by a test.
pub const TAGS: [&str; 3] = [WORD, ASK, DAY];

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// A day of hourly rows is at most a few hundred, since the rollup drops the
/// session and the agent. The caps are set well above what a day can plausibly
/// hold and exist to bound a frame from a build this one does not trust, not to
/// trim an honest one. A day over a cap is refused, never trimmed.
pub const ROWS_CAP: usize = 4_000;
pub const SESSIONS_CAP: usize = 2_000;
pub const AGENTS_CAP: usize = 4_000;

/// A dimension value: a model id, a project path, a branch, a card name.
pub const TEXT_CAP: usize = 256;

/// One `usage_hour` row as its owner holds it. `host` is on the frame rather
/// than the row, because every row in a day belongs to the wall that sent it
/// and a per-row copy would be the same string a few hundred times.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayRow {
    pub hour: i64,
    pub account: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub cli: String,
    pub source: String,
    pub project: String,
    pub provenance: String,
    pub in_tok: i64,
    pub out_tok: i64,
    pub cache_read: i64,
    pub write_5m: i64,
    pub write_1h: i64,
    pub requests: i64,
    pub usd_reported: f64,
}

/// One `analytics_session` row: what a remote fact needs to reach its card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DaySession {
    pub session: String,
    pub project: String,
    pub source: String,
    pub card_id: Option<String>,
    pub parent_card: Option<String>,
    pub opened_by: String,
    pub branch: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub cli_min: Option<String>,
    pub cli_max: Option<String>,
    pub account_first: String,
    pub account_last: String,
    pub provider_first: String,
    pub provider_last: String,
    pub turns: i64,
}

/// One `analytics_agent` row. `kind` is §4.4's vocabulary — `subagent`, `task`
/// or `workflow` — and `profile` is the one it was asked for (`scout`,
/// `review`, a kit agent's name), which is what makes a live count of agents
/// readable rather than a number. Nothing fills either yet; they are carried
/// here so a merged agent on another wall can be counted by them the moment the
/// writer lands, and so the wire does not arrive a release after the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayAgent {
    pub agent_id: String,
    pub session: String,
    pub parent_agent: String,
    pub depth: i64,
    pub kind: String,
    pub profile: String,
    pub requested_model: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub turns: i64,
    pub cost_usd: f64,
    pub account: String,
    pub provider: String,
}

/// What one wall holds of another's days, in the manifest frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostDays {
    pub host: String,
    pub days: Vec<DayDigest>,
}

/// One day this wall holds, as its own digest names it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayDigest {
    /// `YYYY-MM-DD`, UTC. A string rather than an epoch because a day is a
    /// calendar fact and the frame is read by a person when one goes wrong;
    /// the rows inside carry their own instants.
    pub day: String,
    pub digest: String,
    pub rows: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum AnalyticsMsg {
    /// What this wall holds, keyed by owner. Said to a wall that announces
    /// `analytics`, and only when it has changed since that wall last heard
    /// it, so an ordinary exchange carries no manifest at all.
    Analytics { hosts: Vec<HostDays> },
    /// A peer asking for one owner's day. `host` is the owner, which is not
    /// necessarily the wall being asked: a wall that holds a relayed day may
    /// serve it, and the digest is what makes that safe.
    ///
    /// `digest` is what the asker was told this day is, carried back so the
    /// answer can be refused where it disagrees with the manifest that
    /// prompted the ask (§8.2's "checked against the digest the owner
    /// published"). Without it a wall stores a day it can see is wrong, and
    /// nothing counts how many times that has happened.
    AnalyticsAsk { host: String, day: String, digest: String },
    /// The answer, and the only thing a day is ever carried in.
    AnalyticsDay {
        host: String,
        day: String,
        digest: String,
        rows: Vec<DayRow>,
        sessions: Vec<DaySession>,
        agents: Vec<DayAgent>,
    },
}

/// The digest over a day. Rows, sessions and agents are each sorted by their
/// own key first, so two walls that hold the same day compute the same string
/// whatever order their stores happened to return.
///
/// **Every string is put into its travel form first, and that is not tidiness.**
/// A stored digest is compared against the digest of a frame built by
/// `day_frame`, which scrubs and caps each dimension value; a digest computed
/// over a raw value would describe a string this wall can never put on the
/// wire, and the peer would ask for that day for ever because the answer never
/// matched the manifest. `text` is idempotent, so scrubbing here and again in
/// `day_frame` is the same day twice rather than two days.
pub fn digest(host: &str, day: &str, rows: &[DayRow], sessions: &[DaySession], agents: &[DayAgent]) -> String {
    let mut sorted_rows: Vec<DayRow> = rows.iter().map(canon_row).collect();
    sorted_rows.sort_by(|a, b| row_key(a).cmp(&row_key(b)));
    let mut sorted_sessions: Vec<DaySession> = sessions.iter().map(canon_session).collect();
    sorted_sessions.sort_by(|a, b| a.session.cmp(&b.session));
    let mut sorted_agents: Vec<DayAgent> = agents.iter().map(canon_agent).collect();
    sorted_agents.sort_by(|a, b| (a.agent_id.clone(), a.session.clone()).cmp(&(b.agent_id.clone(), b.session.clone())));

    #[derive(Serialize)]
    struct Sealed<'a> {
        host: &'a str,
        day: &'a str,
        rows: &'a [DayRow],
        sessions: &'a [DaySession],
        agents: &'a [DayAgent],
    }
    let bytes = serde_json::to_vec(&Sealed { host, day, rows: &sorted_rows, sessions: &sorted_sessions, agents: &sorted_agents })
        .unwrap_or_default();
    let d = ring::digest::digest(&ring::digest::SHA256, &bytes);
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn row_key(r: &DayRow) -> (i64, &str, &str, &str, &str, &str, &str, &str, &str) {
    (
        r.hour,
        r.account.as_str(),
        r.provider.as_str(),
        r.model.as_str(),
        r.effort.as_str(),
        r.cli.as_str(),
        r.source.as_str(),
        r.project.as_str(),
        r.provenance.as_str(),
    )
}

/// Build the frame a wall answers an ask with: scrubbed, sorted, and digested.
/// The one constructor, so a day is never put on the wire with a digest
/// computed some other way.
pub fn day_frame(
    host: &str,
    day: &str,
    rows: Vec<DayRow>,
    sessions: Vec<DaySession>,
    agents: Vec<DayAgent>,
) -> AnalyticsMsg {
    let mut rows: Vec<DayRow> = rows.iter().map(canon_row).collect();
    let mut sessions: Vec<DaySession> = sessions.iter().map(canon_session).collect();
    let mut agents: Vec<DayAgent> = agents.iter().map(canon_agent).collect();
    rows.sort_by(|a, b| row_key(a).cmp(&row_key(b)));
    sessions.sort_by(|a, b| a.session.cmp(&b.session));
    agents.sort_by(|a, b| (a.agent_id.clone(), a.session.clone()).cmp(&(b.agent_id.clone(), b.session.clone())));
    let digest = digest(host, day, &rows, &sessions, &agents);
    AnalyticsMsg::AnalyticsDay {
        host: host.to_string(),
        day: day.to_string(),
        digest,
        rows,
        sessions,
        agents,
    }
}

/// One dimension value, scrubbed and capped. `clip::keep` is the one place
/// both happen, and a dimension value is read by a person in a broken frame's
/// log line rather than by an agent, so the cut is not marked.
fn text(s: &str) -> String {
    clip::keep(s, TEXT_CAP).kept
}

/* The travel form of each shape: every string put through `text`, nothing else
   touched. Both the digest and the frame are built from these, so there is one
   definition of what a day looks like on the wire rather than two that can
   drift. */
fn canon_row(r: &DayRow) -> DayRow {
    let mut c = r.clone();
    for f in [
        &mut c.account,
        &mut c.provider,
        &mut c.model,
        &mut c.effort,
        &mut c.cli,
        &mut c.source,
        &mut c.project,
        &mut c.provenance,
    ] {
        *f = text(f);
    }
    c
}

fn canon_session(s: &DaySession) -> DaySession {
    let mut c = s.clone();
    for f in [
        &mut c.session,
        &mut c.project,
        &mut c.source,
        &mut c.opened_by,
        &mut c.branch,
        &mut c.account_first,
        &mut c.account_last,
        &mut c.provider_first,
        &mut c.provider_last,
    ] {
        *f = text(f);
    }
    c.card_id = c.card_id.as_deref().map(text);
    c.parent_card = c.parent_card.as_deref().map(text);
    c.cli_min = c.cli_min.as_deref().map(text);
    c.cli_max = c.cli_max.as_deref().map(text);
    c
}

fn canon_agent(a: &DayAgent) -> DayAgent {
    let mut c = a.clone();
    for f in [
        &mut c.agent_id,
        &mut c.session,
        &mut c.parent_agent,
        &mut c.kind,
        &mut c.profile,
        &mut c.requested_model,
        &mut c.account,
        &mut c.provider,
    ] {
        *f = text(f);
    }
    c
}

/// Whether a frame is safe to store: one owner, one day, every row inside it,
/// nothing over a cap, and the digest agreeing with the rows it carries.
/// Anything else is refused whole, and the wall says why rather than storing
/// part of a day it cannot vouch for.
pub fn check(host: &str, day: &str, digest: &str, rows: &[DayRow], sessions: &[DaySession], agents: &[DayAgent]) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("a day arrived with no owner".into());
    }
    let Some(start) = day_start(day) else {
        return Err(format!("a day arrived named `{day}`, which is not a UTC date"));
    };
    if rows.len() > ROWS_CAP {
        return Err(format!("{host}'s {day} carries more than {ROWS_CAP} hourly rows; refused whole"));
    }
    if sessions.len() > SESSIONS_CAP {
        return Err(format!("{host}'s {day} carries more than {SESSIONS_CAP} sessions; refused whole"));
    }
    if agents.len() > AGENTS_CAP {
        return Err(format!("{host}'s {day} carries more than {AGENTS_CAP} agents; refused whole"));
    }
    if let Some(bad) = rows.iter().find(|r| r.hour < start || r.hour >= start + DAY_MS) {
        return Err(format!("{host}'s {day} carries a row at {} which is not in that day", bad.hour));
    }
    if digest != digest_computed(host, day, rows, sessions, agents) {
        return Err(format!("{host}'s {day} does not match its own digest; refused whole"));
    }
    Ok(())
}

fn digest_computed(host: &str, day: &str, rows: &[DayRow], sessions: &[DaySession], agents: &[DayAgent]) -> String {
    digest(host, day, rows, sessions, agents)
}

/// The UTC date an instant falls in: `YYYY-MM-DD`.
pub fn day_key(at: i64) -> String {
    let (y, m, d) = civil(at.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

/// The instant a `YYYY-MM-DD` names, at midnight UTC, or `None` if it is not
/// one. Strict: exactly ten characters, digits, month and day in range.
pub fn day_start(day: &str) -> Option<i64> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |s: &str| -> Option<i64> {
        if !s.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let y = num(&day[0..4])?;
    let m = num(&day[5..7])?;
    let d = num(&day[8..10])?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in(y, m) {
        return None;
    }
    Some(days_from_civil(y, m, d) * DAY_MS)
}

fn days_in(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 to a civil date, and back. Howard Hinnant's
/// `civil_from_days` and `days_from_civil`, written out because this crate
/// carries no date library and a UTC day needs no timezone database.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(hour: i64, model: &str, in_tok: i64) -> DayRow {
        DayRow {
            hour,
            account: "lyss".into(),
            provider: "anthropic".into(),
            model: model.into(),
            effort: "".into(),
            cli: "2.1.233".into(),
            source: "transcript".into(),
            project: "C:\\workbench\\volery".into(),
            provenance: "transcript".into(),
            in_tok,
            out_tok: 0,
            cache_read: 0,
            write_5m: 0,
            write_1h: 0,
            requests: 1,
            usd_reported: 0.0,
        }
    }

    fn session(id: &str) -> DaySession {
        DaySession {
            session: id.into(),
            project: "p".into(),
            source: "transcript".into(),
            card_id: Some("c".into()),
            parent_card: None,
            opened_by: "person".into(),
            branch: "main".into(),
            started_at: 0,
            ended_at: None,
            cli_min: None,
            cli_max: None,
            account_first: "lyss".into(),
            account_last: "lyss".into(),
            provider_first: "anthropic".into(),
            provider_last: "anthropic".into(),
            turns: 1,
        }
    }

    fn agent(id: &str) -> DayAgent {
        DayAgent {
            agent_id: id.into(),
            session: "s".into(),
            parent_agent: "".into(),
            depth: 0,
            kind: "native".into(),
            profile: "scout".into(),
            requested_model: "".into(),
            started_at: 0,
            ended_at: None,
            turns: 1,
            cost_usd: 0.0,
            account: "lyss".into(),
            provider: "anthropic".into(),
        }
    }

    #[test]
    fn the_tags_are_the_ones_the_enum_writes() {
        let mut written = vec![
            serde_json::to_value(AnalyticsMsg::Analytics { hosts: vec![] }).unwrap()["msg"].as_str().unwrap().to_string(),
            serde_json::to_value(AnalyticsMsg::AnalyticsAsk {
                host: String::new(),
                day: String::new(),
                digest: String::new(),
            })
            .unwrap()["msg"]
                .as_str()
                .unwrap()
                .to_string(),
            serde_json::to_value(AnalyticsMsg::AnalyticsDay {
                host: String::new(),
                day: String::new(),
                digest: String::new(),
                rows: vec![],
                sessions: vec![],
                agents: vec![],
            })
            .unwrap()["msg"]
                .as_str()
                .unwrap()
                .to_string(),
        ];
        written.sort();
        let mut tags: Vec<String> = TAGS.iter().map(|s| s.to_string()).collect();
        tags.sort();
        assert_eq!(written, tags);
    }

    /// A day round-trips as itself, and the digest it carries verifies.
    #[test]
    fn a_day_round_trips_and_its_digest_agrees() {
        let day = "2026-11-12";
        let at = day_start(day).unwrap();
        let rows = vec![row(at + 3_600_000, "opus", 10), row(at + 7_200_000, "sonnet", 20)];
        let f = day_frame("desk", day, rows, vec![session("s")], vec![agent("a")]);
        let bytes = serde_json::to_vec(&f).unwrap();
        let back: AnalyticsMsg = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, f);
        let AnalyticsMsg::AnalyticsDay { host, day, digest, rows, sessions, agents } = back else { panic!() };
        assert!(check(&host, &day, &digest, &rows, &sessions, &agents).is_ok());
    }

    /// The digest is the same whichever order the rows arrived in, which is
    /// what lets two stores that sort differently still agree about a day.
    #[test]
    fn the_digest_does_not_depend_on_the_order_rows_arrived_in() {
        let a = vec![row(1, "opus", 10), row(2, "sonnet", 20)];
        let b = vec![row(2, "sonnet", 20), row(1, "opus", 10)];
        assert_eq!(digest("desk", "2026-11-12", &a, &[], &[]), digest("desk", "2026-11-12", &b, &[], &[]));
    }

    /// And it is not the digest of another day, another owner, or the same rows
    /// with one number changed.
    #[test]
    fn the_digest_separates_the_things_it_must() {
        let rows = vec![row(1, "opus", 10)];
        let base = digest("desk", "2026-11-12", &rows, &[], &[]);
        assert_ne!(base, digest("lap", "2026-11-12", &rows, &[], &[]));
        assert_ne!(base, digest("desk", "2026-11-13", &rows, &[], &[]));
        let mut changed = rows.clone();
        changed[0].in_tok = 11;
        assert_ne!(base, digest("desk", "2026-11-12", &changed, &[], &[]));
    }

    /// A sidecar changing changes the digest, which is how a peer that already
    /// holds the day learns its session row is stale. Without this the card and
    /// the agent a remote row joins to would freeze at whatever they were when
    /// the day first crossed.
    #[test]
    fn a_changed_session_or_agent_changes_the_digest() {
        let rows = vec![row(1, "opus", 10)];
        let base = digest("desk", "2026-11-12", &rows, &[session("s")], &[agent("a")]);
        let mut s = session("s");
        s.ended_at = Some(5);
        assert_ne!(base, digest("desk", "2026-11-12", &rows, &[s], &[agent("a")]));
        let mut a = agent("a");
        a.turns = 9;
        assert_ne!(base, digest("desk", "2026-11-12", &rows, &[session("s")], &[a]));
    }

    /// A frame whose rows do not match its digest is refused whole, as is one
    /// carrying a row from another day, one over a cap, or one with no owner.
    #[test]
    fn a_day_that_does_not_match_its_own_digest_is_refused_whole() {
        let days = ["2026-11-12"];
        let start = day_start(days[0]).unwrap();
        let rows = vec![row(start + 1000, "opus", 10)];
        let good = digest("desk", days[0], &rows, &[], &[]);
        assert!(check("desk", days[0], &good, &rows, &[], &[]).is_ok());

        let mut altered = rows.clone();
        altered[0].in_tok = 999;
        assert!(check("desk", days[0], &good, &altered, &[], &[]).is_err());

        let elsewhere = vec![row(start + DAY_MS, "opus", 10)];
        let d = digest("desk", days[0], &elsewhere, &[], &[]);
        assert!(check("desk", days[0], &d, &elsewhere, &[], &[]).is_err());

        let over: Vec<DayRow> = (0..=ROWS_CAP as i64).map(|h| row(start + h, "opus", 1)).collect();
        let d = digest("desk", days[0], &over, &[], &[]);
        assert!(check("desk", days[0], &d, &over, &[], &[]).is_err());

        assert!(check("", days[0], &good, &rows, &[], &[]).is_err());
        assert!(check("desk", "12/11/2026", &good, &rows, &[], &[]).is_err());
    }

    /// **A day is digested in the form it travels in.** The store digests a
    /// row's raw column values; the frame it serves is scrubbed and capped. If
    /// the two digests disagreed, the wall would advertise one and answer with
    /// another, and the peer would ask for that day for ever.
    #[test]
    fn a_digest_is_computed_over_the_form_a_day_travels_in() {
        let mut long = row(1, "opus", 10);
        long.project = format!("{}{}", "p".repeat(300), '\u{1}');
        let raw = digest("desk", "2026-11-12", std::slice::from_ref(&long), &[], &[]);
        let mut cut = long.clone();
        cut.project = clip::keep(&cut.project, TEXT_CAP).kept;
        assert_eq!(raw, digest("desk", "2026-11-12", &[cut], &[], &[]), "the stored and the travelled form agree");
        let AnalyticsMsg::AnalyticsDay { digest: served, .. } =
            day_frame("desk", "2026-11-12", vec![long], vec![], vec![])
        else {
            panic!()
        };
        assert_eq!(raw, served, "and a frame built from the raw row carries that same digest");
    }

    /// The scrubbing all three lists pass through, and the ceiling that keeps a
    /// dimension value from being a paragraph.
    #[test]
    fn every_string_is_scrubbed_and_capped_on_the_way_out() {
        let mut r = row(1, "opus", 1);
        r.project = format!("a\u{0}b{}", "x".repeat(1_000));
        let f = day_frame("desk", "2026-11-12", vec![r], vec![session("s")], vec![]);
        let AnalyticsMsg::AnalyticsDay { rows, .. } = f else { panic!() };
        assert!(!rows[0].project.contains('\u{0}'));
        assert!(rows[0].project.len() <= TEXT_CAP);
    }

    #[test]
    fn a_day_key_is_the_utc_date_an_instant_falls_in() {
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(DAY_MS - 1), "1970-01-01");
        assert_eq!(day_key(DAY_MS), "1970-01-02");
        /* 2026-11-12T00:00:00Z */
        let at = day_start("2026-11-12").unwrap();
        assert_eq!(day_key(at), "2026-11-12");
        assert_eq!(day_key(at - 1), "2026-11-11");
        assert_eq!(day_key(at + DAY_MS - 1), "2026-11-12");
    }

    /// A leap day is a date, and the day before one is not.
    #[test]
    fn the_calendar_is_a_calendar() {
        assert!(day_start("2024-02-29").is_some());
        assert!(day_start("2026-02-29").is_none());
        assert!(day_start("2026-04-31").is_none());
        assert!(day_start("2026-13-01").is_none());
        assert!(day_start("2026-1-01").is_none());
        assert!(day_start("2026-11-12 ").is_none());
        assert!(day_start("").is_none());
        /* Every day of a year comes back as itself, which is what makes the two
           conversions one inverse pair rather than two guesses. */
        let mut at = day_start("2026-01-01").unwrap();
        for n in 0..366 {
            let key = day_key(at + n * DAY_MS);
            assert_eq!(day_start(&key).unwrap(), at + n * DAY_MS, "{key}");
        }
        at = day_start("2024-01-01").unwrap();
        assert_eq!(day_key(at + 59 * DAY_MS), "2024-02-29");
    }
}
