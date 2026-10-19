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
use crate::flyway::accounts::{self as wire, AccountsMsg, Chain, Reading, Seat};

/// One reading another wall took: which wall, the report as it said it, when
/// this wall heard it, and how old it was then.
pub(super) struct Heard {
    host: String,
    report: Value,
    heard_at: i64,
    age_ms: u64,
}

/// Every reading other walls have said, by identity — the freshest per
/// account — and each wall's accounts as it last said them. In memory only, as
/// a shadow is: a restart forgets them and the next exchange says them again.
#[derive(Default)]
pub(super) struct Afar(HashMap<String, Heard>, HashMap<String, Vec<Seat>>);

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
        Some(wire::say(&self.me, settings, readings, chains, self.seats_here()))
    }

    /// This wall's accounts, for a person at another wall to see which of
    /// them could be signed in from there: label, who it signs in as, and
    /// whether it can take work. Labels are this wall's own names, and are not
    /// matched on by anybody — only shown.
    fn seats_here(&self) -> Vec<Seat> {
        let Some(store) = self.store() else { return Vec::new() };
        let Ok(conn) = store.0.lock() else { return Vec::new() };
        crate::accounts::registry(&self.app, &conn)
            .into_iter()
            .map(|s| {
                let (identity, email): (String, String) = conn
                    .query_row(
                        "SELECT identity, identity_email FROM account WHERE label = ?1",
                        rusqlite::params![s.label],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap_or_default();
                let state = if s.copied {
                    "copied"
                } else if !s.signed_in {
                    "not signed in"
                } else if crate::accounts::lapsed(&self.app, &s.label) {
                    "lapsed"
                } else {
                    "signed in"
                };
                Seat { label: s.label, identity, email, state: state.into() }
            })
            .collect()
    }

    /// Another wall's account picture: every register that beats what is held
    /// is taken and applied, and its readings are kept. Only from a wall that
    /// announced the word — anything else passing for one is not read.
    pub(super) fn on_accounts(&self, m: AccountsMsg, from: Option<&str>) {
        let AccountsMsg::Accounts { host, settings, readings, chains, seats } = m else { return };
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
        let seats = wire::admitted_seats(&seats);
        let seated = match self.afar_accounts.lock() {
            Ok(mut a) => {
                a.take(&host, &readings, self.now());
                let news = a.1.get(&host) != Some(&seats);
                a.1.insert(host.clone(), seats);
                news
            }
            Err(_) => false,
        };
        if moved {
            crate::accounts::changed(&self.app);
        } else if seated {
            /* Only this wall's readers: another wall's account list is nothing
               to say to a third. */
            use tauri::Emitter;
            let _ = self.app.emit("accounts:changed", ());
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

    /// A person at another wall asking this one to sign an account in, or
    /// handing over the code that finishes it — answered on the same stream.
    /// Both block on the child (`signin.rs`), so they go to the pool built for
    /// that rather than holding a worker. Refused outright from a wall the
    /// handshake did not name, and from a card: no tool sends these.
    pub(super) async fn signin_here(self: &Arc<Self>, m: AccountsMsg, from: Option<String>) -> Option<AccountsMsg> {
        let Some(host) = from else {
            let id = match &m {
                AccountsMsg::SigninBegin { id, .. } | AccountsMsg::SigninCode { id, .. } => id.clone(),
                _ => return None,
            };
            let why = format!("{} could not tell which wall asked — try again in a minute", self.me);
            return Some(match m {
                AccountsMsg::SigninBegin { .. } => AccountsMsg::SigninBegun { id, url: None, why: Some(why) },
                _ => AccountsMsg::SigninDone { id, outcome: "refused".into(), why: Some(why) },
            });
        };
        let app = self.app.clone();
        match m {
            AccountsMsg::SigninBegin { id, label } => {
                if !super::act::is_id(&id) {
                    return None;
                }
                let r = tauri::async_runtime::spawn_blocking(move || crate::signin::begin_for_afar(&app, &label, &host))
                    .await
                    .unwrap_or_else(|e| Err(format!("the sign-in did not start: {e}")));
                Some(match r {
                    Ok(url) => AccountsMsg::SigninBegun { id, url: Some(url), why: None },
                    Err(why) => AccountsMsg::SigninBegun { id, url: None, why: Some(why) },
                })
            }
            AccountsMsg::SigninCode { id, label, code } => {
                if !super::act::is_id(&id) {
                    return None;
                }
                let Some(code) = wire::admit_code(&code) else {
                    return Some(AccountsMsg::SigninDone { id, outcome: "refused".into(), why: Some("that is not a code".into()) });
                };
                let (outcome, why) =
                    tauri::async_runtime::spawn_blocking(move || crate::signin::code_for_afar(&app, &label, &code))
                        .await
                        .unwrap_or_else(|e| ("refused".into(), Some(format!("the code was not handed over: {e}"))));
                Some(AccountsMsg::SigninDone { id, outcome, why })
            }
            _ => None,
        }
    }

    /// Ask `host` for one exchange about a sign-in, and keep its answer out of
    /// the rest of what it says back. Never touches `failing`, for
    /// `read_tail`'s reason. Refused at once for a wall unknown, quiet or too
    /// old — never queued: a sign-in is somebody waiting in front of a browser.
    async fn signin_exchange(self: &Arc<Self>, host: &str, ask: AccountsMsg, id: &str) -> Result<AccountsMsg, String> {
        self.reachable(host, wire::SIGNIN_WORD, "cannot be signed in from another wall — update it, or sign in there")?;
        let peer = self.wire.peer(host)?;
        let back = self
            .wire
            .exchange(peer, vec![Frame::Accounts(ask)], true)
            .await
            .map_err(|e| format!("did not hear back from {host} ({e})"))?;
        let mut answer = None;
        let mut rest = Vec::new();
        for f in back {
            match f {
                Frame::Accounts(m @ (AccountsMsg::SigninBegun { .. } | AccountsMsg::SigninDone { .. })) => {
                    let mine = match &m {
                        AccountsMsg::SigninBegun { id: i, .. } | AccountsMsg::SigninDone { id: i, .. } => i == id,
                        _ => false,
                    };
                    if mine {
                        answer = Some(m);
                    }
                }
                other => rest.push(other),
            }
        }
        self.take(rest, Some(host));
        answer.ok_or_else(|| format!("{host} answered without saying how the sign-in went"))
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
    vec![wire::WORD.to_string(), wire::SIGNIN_WORD.to_string()]
}

/// One account on another wall, as this wall's panel draws it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AfarSeat {
    pub host: String,
    pub label: String,
    pub identity: String,
    pub email: String,
    pub state: String,
    /// How long that wall has gone unheard — the roster's word.
    pub quiet_ms: u64,
}

/// Every other wall's accounts as it last said them, for the panel's *on other
/// walls* rows.
#[tauri::command]
pub fn afar_seats(app: AppHandle) -> Vec<AfarSeat> {
    let Some(link) = current(&app) else { return Vec::new() };
    let now = link.now();
    let seats: Vec<(String, Seat)> = link
        .afar_accounts
        .lock()
        .map(|a| a.1.iter().flat_map(|(h, v)| v.iter().map(move |s| (h.clone(), s.clone()))).collect())
        .unwrap_or_default();
    let fleet = link.fleet.lock().ok();
    let mut out: Vec<AfarSeat> = seats
        .into_iter()
        .map(|(host, s)| AfarSeat {
            quiet_ms: fleet.as_ref().and_then(|f| f.entry(&host).map(|e| e.quiet_for(now))).unwrap_or(u64::MAX),
            host,
            label: s.label,
            identity: s.identity,
            email: s.email,
            state: s.state,
        })
        .collect();
    out.sort_by(|a, b| (a.host.to_lowercase(), a.label.to_lowercase()).cmp(&(b.host.to_lowercase(), b.label.to_lowercase())));
    out
}

/// What a sign-in started from here came back with.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Begun {
    pub id: String,
    pub url: String,
}

/// Start signing `label` in on `host`, from here: the address comes back to
/// be opened in this machine's browser. A person's gesture from the accounts
/// panel; no tool reaches it.
#[tauri::command]
pub async fn flyway_signin_begin(app: AppHandle, host: String, label: String) -> Result<Begun, String> {
    if !crate::accounts::is_label(&label) {
        return Err("that is not an account name".into());
    }
    let link = current(&app).ok_or("this wall is not on a flyway")?;
    let id = crate::store::uuid_v4();
    let m = link.signin_exchange(&host, AccountsMsg::SigninBegin { id: id.clone(), label }, &id).await?;
    match m {
        AccountsMsg::SigninBegun { url: Some(url), .. } => {
            wire::admit_url(&url).map(|url| Begun { id, url }).ok_or_else(|| format!("{host} sent back an address that is not a sign-in page"))
        }
        AccountsMsg::SigninBegun { why, .. } => Err(why.map(|w| wire::admit_why(&w)).unwrap_or_else(|| format!("{host} did not start the sign-in"))),
        _ => Err(format!("{host} answered something else")),
    }
}

/// How a code handed to another wall ended.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub outcome: String,
    pub why: Option<String>,
}

/// Hand the `code#state` the platform page showed to the sign-in waiting on
/// `host`, and say how it ended there.
#[tauri::command]
pub async fn flyway_signin_code(app: AppHandle, host: String, id: String, label: String, code: String) -> Result<Finished, String> {
    let code = wire::admit_code(&code).ok_or("that is not a code — it is one line, usually two parts joined by a #")?;
    let link = current(&app).ok_or("this wall is not on a flyway")?;
    let m = link.signin_exchange(&host, AccountsMsg::SigninCode { id: id.clone(), label, code }, &id).await?;
    match m {
        AccountsMsg::SigninDone { outcome, why, .. } => Ok(Finished { outcome, why: why.map(|w| wire::admit_why(&w)) }),
        _ => Err(format!("{host} answered something else")),
    }
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
