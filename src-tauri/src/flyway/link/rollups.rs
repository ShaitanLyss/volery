//! The fleet's hourly rollups, wired to the exchange (`docs/ANALYTICS.md` §8).
//!
//! `flyway-core/src/analytics.rs` is what a day looks like and how a wall
//! checks one. `analytics.rs` in the app is how a day is read out of the store
//! and written back into it. This is the third part: when a manifest is said,
//! when a day is asked for, and when one arrives.
//!
//! ### A manifest only crosses when it changed
//!
//! Every wall announces on a thirty-second tick, and a manifest lists every
//! owner and every day it holds. Sent unconditionally that is a few hundred
//! lines per exchange, forever, to say nothing has happened. So this wall keeps
//! the fingerprint of the last manifest it sent each peer, and says the whole
//! thing again only when a row moved. An ordinary exchange carries no manifest
//! at all.
//!
//! ### A hole is filled once, and the rows stay
//!
//! A day is stored here rather than read from its owner on demand, which is
//! what makes a machine that is off, or has left the flyway, still counted.
//! `analytics::merge_day` replaces the owner's copy of one day in one
//! transaction, and `days_needed` is the comparison that decides what is
//! asked for: a day this wall has no digest for, or holds under a different
//! one.
//!
//! ### What a version skew costs, and what it does not
//!
//! An older wall passes these frames over as words it has never heard
//! (`frame::take`), and keeps syncing everything else. It never says
//! `analytics` in `Facts::can`, so this wall never sends it a manifest either —
//! which is why the word is what gates the exchange rather than the frame
//! arriving and being skipped.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use crate::analytics;
use crate::flyway::analytics::{self as wire, AnalyticsMsg, DayAgent, DayRow, DaySession, HostDays};
use crate::flyway::frame::Frame;

use super::Link;

/// How many days one exchange will ask for. A wall that has just joined a
/// three-year flyway has a lot of holes, and filling them all in one exchange
/// would be a frame the transport has to hold while every other exchange
/// waits. A handful per tick is a few minutes to catch up, and costs nothing
/// once it has.
const DAYS_PER_EXCHANGE: usize = 4;

/// How many times one `(owner, day)` is asked for before it is left alone. Small
/// on purpose: a day that has been asked for five times across five ticks and
/// never arrived is a peer that cannot serve what it advertises, and asking a
/// sixth time buys nothing. An ordinary catch-up needs one.
const TRIES_BEFORE_GIVING_UP: u32 = 5;

impl Link {
    /// Whether `host` last announced that it holds rollups worth asking for.
    fn says_analytics(&self, host: &str) -> bool {
        self.fleet
            .lock()
            .ok()
            .and_then(|f| f.entry(host).map(|e| e.facts.can.iter().any(|c| c == wire::WORD)))
            .unwrap_or(false)
    }

    /// This wall's manifest for `host`, or nothing if that wall does not hold
    /// rollups, or nothing has changed since it last heard this wall's.
    pub(super) fn analytics_for(&self, host: Option<&str>) -> Option<Frame> {
        let host = host?;
        if !self.says_analytics(host) {
            return None;
        }
        let store = self.store()?;
        let hosts = {
            let conn = store.0.lock().ok()?;
            analytics::manifest(&conn).ok()?
        };
        if hosts.is_empty() {
            return None;
        }
        let msg = AnalyticsMsg::Analytics { hosts };
        let now = fingerprint(&msg);
        let mut said = self.rollups_said.lock().ok()?;
        if said.get(host).is_some_and(|last| *last == now) {
            return None;
        }
        said.insert(host.to_string(), now);
        Some(Frame::Analytics(msg))
    }

    /// Fold one rollup frame from `from`.
    pub(super) fn on_analytics(self: &Arc<Self>, m: AnalyticsMsg, from: Option<&str>) {
        match m {
            AnalyticsMsg::Analytics { hosts } => {
                let Some(from) = from else { return };
                /* Kept, not only acted on once: an ask can be lost to a link
                   that dropped after the manifest landed, and a manifest is
                   only said again when the sender's rows move. The tick asks
                   again for whatever is still missing (`retry_holes`). */
                if let Ok(mut held) = self.rollup_holes.lock() {
                    held.insert(from.to_string(), hosts.clone());
                }
                let _ = self.ask_for_days(from, hosts);
            }
            AnalyticsMsg::AnalyticsDay { host, day, digest, rows, sessions, agents } => {
                let Some(from) = from else { return };
                self.take_day(from, &host, &day, &digest, &rows, &sessions, &agents);
            }
            /* An ask is only ever answered (`on_ask`); one arriving loose is
               from an exchange that already gave up on it. */
            AnalyticsMsg::AnalyticsAsk { .. } => {}
        }
    }

    /// Ask again, on the tick, for whatever a peer's last manifest named and
    /// this wall still does not hold. `days_needed` filters what has arrived,
    /// so a day that was merged stops being asked for by itself.
    pub(super) fn retry_holes(self: &Arc<Self>) {
        let held: Vec<(String, Vec<HostDays>)> =
            self.rollup_holes.lock().map(|h| h.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
        for (from, hosts) in held {
            /* Nothing left to ask for: the catch-up is done, and forgetting the
               manifest is what keeps this from being a comparison over every
               day a peer ever held, once a tick, for the life of the wall. */
            if !self.ask_for_days(&from, hosts) {
                self.rollup_holes.lock().map(|mut h| h.remove(&from)).ok();
            }
        }
    }

    /// A peer's manifest: ask for the days this wall lacks. Answers whether
    /// there was anything to ask for.
    fn ask_for_days(self: &Arc<Self>, from: &str, hosts: Vec<HostDays>) -> bool {
        let Some(store) = self.store() else { return false };
        let needed = {
            let Ok(conn) = store.0.lock() else { return false };
            match analytics::days_needed(&conn, &hosts, &self.me) {
                Ok(n) => n,
                Err(why) => {
                    log::debug!("flyway: could not compare {from}'s rollups: {why}");
                    /* Not "nothing missing": the store could not answer, and
                       dropping the manifest would stop the retry. */
                    return true;
                }
            }
        };
        /* A day that has been asked for and answered with something that never
           matches is given up rather than retried for the life of the wall. A
           day refused five times is a wall serving a digest it cannot serve
           twice, or a relay that cannot answer; either is worth saying once and
           then leaving alone. */
        let mut tries = self.rollup_tries.lock().unwrap_or_else(|e| e.into_inner());
        let mut askable: Vec<(String, String, String)> = Vec::new();
        let mut gave_up: Vec<(String, String)> = Vec::new();
        for (host, day, digest) in needed {
            let key = (host.clone(), day.clone());
            let n = tries.get(&key).copied().unwrap_or(0);
            if n >= TRIES_BEFORE_GIVING_UP {
                gave_up.push((host, day));
                continue;
            }
            askable.push((host, day, digest));
        }
        let missing = !askable.is_empty();
        if !gave_up.is_empty() {
            let names: Vec<String> = gave_up.iter().map(|(h, d)| format!("{h}/{d}")).collect();
            log::warn!(
                "flyway: gave up asking {from} for {} day(s) after {TRIES_BEFORE_GIVING_UP} tries: {}",
                gave_up.len(),
                names.join(", ")
            );
        }
        let asks: Vec<Frame> = askable
            .into_iter()
            .take(DAYS_PER_EXCHANGE)
            .map(|(host, day, digest)| {
                *tries.entry((host.clone(), day.clone())).or_insert(0) += 1;
                Frame::Analytics(AnalyticsMsg::AnalyticsAsk { host, day, digest })
            })
            .collect();
        drop(tries);
        if !asks.is_empty() {
            self.push(from.to_string(), asks);
        }
        missing
    }

    /// The digest `owner` published for a day, as last heard.
    fn published_digest(&self, owner: &str, day: &str) -> Option<String> {
        self.rollup_holes.lock().ok()?.values().flatten().find(|h| h.host == owner).and_then(|h| {
            h.days.iter().find(|d| d.day == day).map(|d| d.digest.clone())
        })
    }

    /// Store one day. Refused whole if it does not match its own digest.
    fn take_day(
        &self,
        from: &str,
        host: &str,
        day: &str,
        digest: &str,
        rows: &[DayRow],
        sessions: &[DaySession],
        agents: &[DayAgent],
    ) {
        if let Err(why) = wire::check(host, day, digest, rows, sessions, agents) {
            log::warn!("flyway: refused a rollup day from {from}: {why}");
            return;
        }
        /* And the answer must be the day the manifest asked for. A day that is
           internally consistent but does not match what its owner published is
           one this wall already knows is not current, and storing it would put
           a digest in the manifest that the owner will contradict next tick. */
        if let Some(expected) = self.published_digest(host, day) {
            if expected != digest {
                log::warn!(
                    "flyway: refused {host}'s {day} from {from}: it does not match the digest {host} published"
                );
                return;
            }
        }
        let Some(store) = self.store() else { return };
        match analytics::merge_day(&store.0, host, day, digest, rows, sessions, agents, from, &self.me) {
            Ok(n) => {
                /* The day is here, so the asking is over for it. */
                self.rollup_tries.lock().map(|mut t| t.remove(&(host.to_string(), day.to_string()))).ok();
                log::debug!("flyway: took {n} hour row(s) of {host}'s {day} from {from}")
            }
            Err(why) => log::debug!("flyway: did not take {host}'s {day} from {from}: {why}"),
        }
    }

    /// Answer a peer's ask for one day, read out of this wall's store.
    pub(super) fn on_ask(&self, host: &str, day: &str) -> Option<Frame> {
        let store = self.store()?;
        let (rows, sessions, agents) = {
            let conn = store.0.lock().ok()?;
            /* Belt to the ingest's braces: a day is re-digested from what this
               wall actually holds before it is served, so the answer always
               matches the manifest that prompted it. The cost is one day's
               reads on an ask, which is the rare path. */
            analytics::refresh_day(&conn, host, day).ok()?;
            (
                analytics::day_rows(&conn, host, day).ok()?,
                analytics::day_sessions(&conn, host, day).ok()?,
                analytics::day_agents(&conn, host, day).ok()?,
            )
        };
        if rows.is_empty() && sessions.is_empty() && agents.is_empty() {
            return None;
        }
        Some(Frame::Analytics(wire::day_frame(host, day, rows, sessions, agents)))
    }
}

/// A manifest's own digest, so a wall can tell whether it has already said
/// this exact picture. It is compared only inside one process, between what
/// was sent and what is about to be, so it needs no cross-build stability.
fn fingerprint(m: &AnalyticsMsg) -> String {
    let bytes = serde_json::to_vec(m).unwrap_or_default();
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}", h.finish())
}
