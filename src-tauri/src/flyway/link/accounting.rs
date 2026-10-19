//! The accounts' half of the link: saying this wall's account picture, taking
//! another's, and holding the readings other walls took.
//!
//! `flyway/accounts.rs` is the vocabulary and the merge and holds the argument;
//! `accountsync.rs` is the store's half. This is only the wiring, a child of
//! `link.rs` for `billboard.rs`'s reason — it uses the wire and the fleet
//! without either growing a public face for one subsystem. (Named `accounting`
//! rather than `accounts` so it does not shadow the vocabulary it carries.)
//!
//! **Only to walls that announce the word.** A picture is put in an exchange
//! only for a host whose last announcement carried `accounts` in `Facts::can`,
//! so an older wall never meets one, and nothing it says is read as an account
//! picture either — it keeps its own settings, untouched. The first exchange
//! with a wall not yet heard from carries none; the next tick does.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::Value;
use tauri::AppHandle;

use super::{current, Frame, Link, CARDS_EVERY};
use crate::flyway::accounts::{self as wire, AccountsMsg, Chain, Reading};

/// One reading another wall took: which wall, the report as it said it, when
/// this wall heard it, and how old it was then.
pub(super) struct Heard {
    host: String,
    report: Value,
    heard_at: i64,
    age_ms: u64,
}

/// Every reading other walls have said, by identity — the freshest per
/// account. In memory only, as a shadow is: a restart forgets them and the next
/// exchange says them again.
#[derive(Default)]
pub(super) struct Afar(HashMap<String, Heard>);

impl Afar {
    fn take(&mut self, host: &str, readings: &[Reading], now: i64) {
        for r in readings.iter().take(wire::READINGS_MOST) {
            if !wire::admit_reading(r) {
                continue;
            }
            /* The freshest per identity, measured on this clock: an older
               reading from another wall must not displace a newer one. */
            let fresh = |h: &Heard| (now - h.heard_at).max(0) as u64 + h.age_ms;
            let keep = self.0.get(&r.identity).is_none_or(|h| r.age_ms <= fresh(h));
            if keep {
                self.0.insert(
                    r.identity.clone(),
                    Heard { host: host.to_string(), report: r.report.clone(), heard_at: now, age_ms: r.age_ms },
                );
            }
        }
        if self.0.len() > wire::IDENTITIES_MOST {
            /* A confused peer naming hundreds: keep the freshest. */
            let mut all: Vec<(String, u64)> =
                self.0.iter().map(|(k, h)| (k.clone(), (now - h.heard_at).max(0) as u64 + h.age_ms)).collect();
            all.sort_by_key(|(_, age)| *age);
            for (k, _) in all.into_iter().skip(wire::IDENTITIES_MOST) {
                self.0.remove(&k);
            }
        }
    }
}

impl Link {
    /// Whether `host` last announced that it says accounts.
    fn says_accounts(&self, host: &str) -> bool {
        self.fleet
            .lock()
            .ok()
            .and_then(|f| f.entry(host).map(|e| e.facts.can.iter().any(|c| c == wire::WORD)))
            .unwrap_or(false)
    }

    /// This wall's account picture for `host`, or nothing if that wall does
    /// not say accounts (or is not known yet) or the store cannot be read.
    pub(super) fn accounts_for(&self, host: Option<&str>) -> Option<Frame> {
        let host = host?;
        if !self.says_accounts(host) {
            return None;
        }
        self.accounts_say().map(Frame::Accounts)
    }

    /// The greeting a dial opens with, and this wall's account picture after it
    /// for a wall that says accounts — `greeting` itself does not know whom it
    /// is greeting.
    pub(super) fn greeting_for(&self, host: &str, current: bool) -> Result<Vec<Frame>, String> {
        let mut out = self.greeting(current)?;
        if current {
            out.extend(self.accounts_for(Some(host)));
        }
        Ok(out)
    }

    fn accounts_say(&self) -> Option<AccountsMsg> {
        let (settings, ids) = {
            let store = self.store()?;
            let conn = store.0.lock().ok()?;
            (crate::accountsync::published(&conn), crate::accountsync::identities(&conn))
        };
        let now = self.now();
        /* Which chain each store holds, for finding a sign-in copied between
           machines — every label, since two labels on one identity could each
           be a copy. A digest and an age, never a token. */
        let chains: Vec<Chain> = ids
            .iter()
            .filter_map(|(label, identity)| {
                Some(Chain {
                    identity: identity.clone(),
                    digest: crate::accounts::chain_digest(&self.app, label, identity)?,
                    age_ms: crate::accounts::store_age_ms(&self.app, label)?,
                })
            })
            .collect();
        let mut seen = std::collections::HashSet::new();
        let readings: Vec<Reading> = ids
            .into_iter()
            .filter(|(_, id)| seen.insert(id.clone()))
            .filter_map(|(label, identity)| {
                let (report, at) = crate::limits::own_reading(&self.app, &label)?;
                Some(Reading { identity, age_ms: (now - at).max(0) as u64, report })
            })
            .collect();
        Some(wire::say(&self.me, settings, readings, chains))
    }

    /// Another wall's account picture: every register that beats what is held
    /// is taken and applied, and its readings are kept. Only from a wall that
    /// announced the word — anything else passing for one is not read.
    pub(super) fn on_accounts(&self, m: AccountsMsg, from: Option<&str>) {
        let AccountsMsg::Accounts { host, settings, readings, chains } = m;
        /* The host the handshake vouched for, where there is one — a picture
           naming another wall is read as the dialler's. */
        let host = from.map(str::to_string).unwrap_or(host);
        if !self.says_accounts(&host) {
            return;
        }
        let moved = {
            let Some(store) = self.store() else { return };
            let Ok(conn) = store.0.lock() else { return };
            let mut moved = false;
            for r in wire::admitted(&settings) {
                moved |= crate::accountsync::receive(&conn, &r).unwrap_or(false);
            }
            moved |= self.retire_copies(&conn, &host, &chains);
            moved
        };
        if let Ok(mut a) = self.afar_accounts.lock() {
            a.take(&host, &readings, self.now());
        }
        if moved {
            crate::accounts::changed(&self.app);
        }
    }

    /// Another wall holds the same refresh-token chain as a store here: one of
    /// the two is a copy, and the first refresh on either will sign the other
    /// out. Retire this wall's sign-in if it is the copy
    /// (`wire::is_the_copy`); the other wall, reading the same two ages, keeps
    /// its own. Returns whether anything here was retired.
    fn retire_copies(&self, conn: &rusqlite::Connection, host: &str, chains: &[Chain]) -> bool {
        let mut retired = false;
        for c in chains.iter().filter(|c| wire::admit_chain(c)).take(wire::READINGS_MOST) {
            for label in crate::accountsync::labels_of(conn, &c.identity) {
                let Some(mine) = crate::accounts::chain_digest(&self.app, &label, &c.identity) else { continue };
                if mine != c.digest {
                    continue;
                }
                let Some(age) = crate::accounts::store_age_ms(&self.app, &label) else { continue };
                if !wire::is_the_copy(age, c.age_ms, &self.me, host) {
                    continue;
                }
                if crate::accounts::retire_copy(conn, &label, &mine).unwrap_or(false) {
                    log::warn!(
                        "accounts: '{label}' holds the same sign-in as {host}'s, copied from there — retired here until it is signed in again"
                    );
                    retired = true;
                }
            }
        }
        retired
    }

    /// The accounts changed here: say the new picture to every wall that can
    /// hear it within `CARDS_EVERY`, coalesced as the board is, so a toggle on
    /// this wall is on the other laptop's panel in about a second. The tick says
    /// it again regardless, so a push that fails costs half a minute, never the
    /// change.
    pub(crate) fn accounts_changed(self: &Arc<Self>) {
        if self.accounts_due.swap(true, Ordering::AcqRel) {
            return;
        }
        let l = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CARDS_EVERY).await;
            l.accounts_due.store(false, Ordering::Release);
            for host in l.known_current() {
                if let Some(f) = l.accounts_for(Some(&host)) {
                    l.push(host, vec![f]);
                }
            }
        });
    }
}

/// The freshest reading another wall said of `identity`: which wall, the
/// report as said, and its age now. `None` with no link, or nothing heard.
pub fn afar_reading(app: &AppHandle, identity: &str) -> Option<(String, Value, u64)> {
    let link = current(app)?;
    let now = link.now();
    let a = link.afar_accounts.lock().ok()?;
    let h = a.0.get(identity)?;
    Some((h.host.clone(), h.report.clone(), (now - h.heard_at).max(0) as u64 + h.age_ms))
}

/// The word this wall announces in `Facts::can`.
///
/// A debug build started with `VOLERY_LAB_NO_ACCOUNTS=1` announces nothing, and
/// so stands in for a wall from before this — the one way a lab run can show an
/// older peer being left alone without building a second binary from an older
/// commit. A release build ignores the variable.
pub(super) fn words() -> Vec<String> {
    if cfg!(debug_assertions) && std::env::var("VOLERY_LAB_NO_ACCOUNTS").is_ok_and(|v| v.trim() == "1") {
        return Vec::new();
    }
    vec![wire::WORD.to_string()]
}

/// Tell the link the accounts changed, if there is a link.
pub fn changed(app: &AppHandle) {
    if let Some(l) = current(app) {
        l.accounts_changed();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const X: &str = "8ebb2352-0000-4000-8000-000000000001:10340709-0000-4000-8000-000000000002";

    fn reading(age: u64, used: i64) -> Reading {
        Reading { identity: X.into(), age_ms: age, report: json!({ "used": used }) }
    }

    /// The freshest reading per account wins, measured on this clock — a stale
    /// one heard later does not displace a fresher one heard earlier.
    #[test]
    fn the_freshest_reading_is_kept() {
        let mut a = Afar::default();
        a.take("lap", &[reading(10_000, 40)], 1_000_000);
        /* Heard five seconds later, but taken a minute before saying it. */
        a.take("box", &[reading(60_000, 30)], 1_005_000);
        assert_eq!(a.0[X].host, "lap");
        /* A genuinely newer one does. */
        a.take("box", &[reading(1_000, 55)], 1_006_000);
        assert_eq!(a.0[X].host, "box");
        assert_eq!(a.0[X].report, json!({ "used": 55 }));
        /* A placeholder is never held. */
        a.take("box", &[Reading { identity: "label:x".into(), age_ms: 0, report: json!({}) }], 1_007_000);
        assert_eq!(a.0.len(), 1);
    }
}
