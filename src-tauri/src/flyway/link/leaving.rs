//! Leaving a flyway, and being told a wall has.
//!
//! ### Leaving used to write a setting and nothing else
//!
//! `key::leave` clears the vault entry. Every task `arrive` had started held
//! the endpoint, the key in memory and a `loop {}` that never asked whether it
//! should go on — so the wall went on dialling, answering, announcing and
//! publishing its cards to every peer, as a member, until the process was
//! closed. Lyss's report (2026-10-19): *"leaving the flyway didn't actually
//! leave until volery was closed and reopened"*. A task that lives as long as a
//! link owes the link a way to end it, and `Tenure` is it: closed once, and
//! every loop that outlives a call reads it.
//!
//! ### And nobody was told
//!
//! The other walls saw a wall that had stopped announcing — which is what a
//! shut lid looks like, and they drew it **quiet**, with its cards, for as long
//! as the process lived. A wall that leaves says so: one `leaving` word to
//! every wall it flies with, on the way out (`farewell`). Heard, it takes the
//! wall off at once — roster, cards, notices, and the shadows the front end
//! draws from them — and a wall that merely went quiet still reads as quiet,
//! because a shut lid is not a departure.
//!
//! **The word is best-effort and is not gated on a `Facts::can` word.** A
//! capability word exists so the *sender* can refuse something the receiver
//! would mishandle (a prompt's pictures arriving as the sentence without them).
//! A goodbye has nothing to refuse: an older wall skips the unknown `msg`
//! (`frame::take`) and reads the leaver as quiet, exactly as before, and a wall
//! on the v1 language is not sent it at all. A peer that was asleep when it was
//! said never hears it, and reads quiet too — said once, never queued, because
//! a goodbye delivered a week late would take a wall that has since rejoined
//! off the roster.
//!
//! **Who said it is the handshake's to prove**, not the frame's: the word names
//! a host, and `departed` acts only if that name derives the identity the
//! connection proved (`Wire::peer`). A frame sealed with the wall key shows
//! only that somebody holding it sent it.
//!
//! Rejoining is nothing special. The leaver's announcement version only ever
//! rises, so the entry the peers held off against gossip (`Fleet::forget`) is
//! passed by the first announcement after it returns.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::super::fleet::{self, FleetMsg};
use super::super::frame::Frame;
use super::super::key;
use super::super::wire::Dialler;
use super::{current, Flyway, Link, RosterRow};

/// How long a goodbye may take to land. Said to every peer at once, so this is
/// the whole of what leaving can wait on a wall that does not answer.
const FAREWELL_WITHIN: Duration = Duration::from_secs(4);

/// How long closing the endpoint may take: it waits for connections to wind
/// down, and a peer that has gone away mid-exchange would hold it for the idle
/// timeout.
const CLOSE_WITHIN: Duration = Duration::from_secs(3);

/// Whether this link is still one a wall is a member by — the one thing that
/// ends the tasks it started.
pub(super) struct Tenure {
    closed: AtomicBool,
    ended: tokio::sync::Notify,
}

impl Tenure {
    pub(super) fn new() -> Self {
        Self { closed: AtomicBool::new(false), ended: tokio::sync::Notify::new() }
    }

    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ended.notify_waiters();
    }

    pub(super) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Sleep for `d`, or until the link is closed — and say whether it is still
    /// open to carry on with. Armed before the check, so a close that lands
    /// between the two is heard rather than slept through.
    pub(super) async fn sleep(&self, d: Duration) -> bool {
        let ended = self.ended.notified();
        if self.is_closed() {
            return false;
        }
        let _ = tokio::time::timeout(d, ended).await;
        !self.is_closed()
    }
}

/// Do `one` now and then every `every`, until the link is closed. The tick's
/// whole shape, apart from what one tick does — so that "a left wall stops
/// dialling" is something a test can hold rather than something a task is
/// trusted to do.
pub(super) async fn tick_until_closed<F, Fut>(stop: &Tenure, every: Duration, mut one: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    while !stop.is_closed() {
        one().await;
        if !stop.sleep(every).await {
            break;
        }
    }
}

/// Who a wall owes a goodbye when it leaves: every wall it flies with now.
///
/// The roster's walls that are not quiet — a wall that has gone quiet is not
/// listening, and saying it to the empty room costs a whole timeout — plus any
/// wall that dialled in or seeded the invite and is not on the roster at all
/// (an older wall says who it is in its `Hello` and sends no roster). Never
/// this wall, and never one on the older language, which cannot read the word.
/// A pure function of what the link knows, so the rule is held by a test.
pub(super) fn farewell_to(
    me: &str,
    roster: &[(String, bool)],
    heard: &BTreeSet<String>,
    seed: Option<&str>,
    older: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let quiet: BTreeSet<&str> = roster.iter().filter(|(_, q)| *q).map(|(h, _)| h.as_str()).collect();
    let mut hosts: BTreeSet<String> = roster.iter().filter(|(_, q)| !*q).map(|(h, _)| h.clone()).collect();
    hosts.extend(heard.iter().filter(|h| !quiet.contains(h.as_str())).cloned());
    hosts.extend(seed.filter(|h| !quiet.contains(h)).map(str::to_string));
    hosts.retain(|h| !h.eq_ignore_ascii_case(me) && !older(h));
    hosts.into_iter().collect()
}

/// Which hosts a tick dials: the roster's, plus the ones that only dialled in
/// and the invite's seed — minus a wall that said goodbye, which is neither
/// until it is heard from again. The roster is never filtered: a wall that
/// announces after leaving is back on it, and that is what makes it dialled.
pub(super) fn tick_hosts(
    me: &str,
    roster: &[String],
    heard: &BTreeSet<String>,
    seed: Option<&str>,
    left: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut hosts: BTreeSet<String> = roster.iter().cloned().collect();
    hosts.extend(heard.iter().filter(|h| !left.contains(*h)).cloned());
    hosts.extend(seed.filter(|h| !left.contains(*h)).map(str::to_string));
    hosts.retain(|h| !h.eq_ignore_ascii_case(me));
    hosts
}

/// What `flyway:left` carries. `host` is the wall that left, or `None` for
/// *this* wall — everything it drew from the flyway comes down.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Left {
    host: Option<String>,
}

impl Link {
    /// Whom to say goodbye to, read before the key is cleared (the seed is in
    /// the vault).
    fn farewell_hosts(&self) -> Vec<String> {
        let now = self.now();
        let roster: Vec<(String, bool)> = self
            .fleet
            .lock()
            .map(|f| f.roster().map(|e| (e.host.clone(), e.quiet_for(now) > fleet::QUIET_AFTER_MS as u64)).collect())
            .unwrap_or_default();
        let heard = self.heard.lock().map(|h| h.clone()).unwrap_or_default();
        farewell_to(&self.me, &roster, &heard, key::joined_peer().as_deref(), &|h| self.speaks_older(h))
    }

    /// Say `leaving` to each of `hosts` at once, and how many it reached.
    /// Straight to the wire rather than through `push`, which stops at a
    /// closed link — this is the one thing a closed link still says.
    async fn farewell(self: &Arc<Self>, hosts: Vec<String>) -> usize {
        let say = vec![Frame::Fleet(FleetMsg::Leaving { host: self.me.clone() })];
        let mut sent = Vec::new();
        for host in hosts {
            let l = self.clone();
            let say = say.clone();
            sent.push(tauri::async_runtime::spawn(async move {
                let Ok(peer) = l.wire.peer(&host) else { return false };
                match l.wire.exchange_within(peer, say, true, FAREWELL_WITHIN).await {
                    Ok(_) => true,
                    Err(e) => {
                        log::debug!("flyway: could not say goodbye to {host}: {e}");
                        false
                    }
                }
            }));
        }
        let mut told = 0;
        for s in sent {
            if let Ok(true) = s.await {
                told += 1;
            }
        }
        told
    }

    /// Stop everything this link started and let go of the endpoint. After
    /// this nothing dials, answers, announces or publishes.
    async fn shutdown(self: &Arc<Self>) {
        self.tenure.close();
        /* What this wall was waiting on will not come: settled now, so a parked
           tool call is answered rather than dropped and a prompt drawn as
           waiting is not left so for ever. */
        let pending: Vec<String> = self
            .waiting
            .lock()
            .map(|w| w.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .chain(self.prompts_out.lock().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default())
            .collect();
        for id in pending {
            self.nobody_answered(&id);
        }
        let _ = tokio::time::timeout(CLOSE_WITHIN, self.wire.close()).await;
    }

    /// Everything this wall holds about another one, let go of: its roster
    /// entry, its cards, its notices, the dialling that was kept up for it, and
    /// — by the events — the shadows and the panel's row. Returns whether it
    /// was on the roster. `departed` is a goodbye rather than a person's forgetting
    /// a quiet wall — see `Cards::depart`.
    pub(super) fn drop_wall(&self, host: &str, departed: bool) -> bool {
        let known = self.fleet.lock().map(|mut f| f.depart(host)).unwrap_or(false);
        if let Ok(mut c) = self.cards.lock() {
            if departed {
                c.depart(host);
            } else {
                c.forget(host);
            }
        }
        if let Ok(mut b) = self.boards.lock() {
            b.forget(host);
        }
        if let Ok(mut h) = self.heard.lock() {
            h.remove(host);
        }
        if let Ok(mut f) = self.failing.lock() {
            f.remove(host);
        }
        if let Ok(mut o) = self.older.lock() {
            o.remove(host);
        }
        crate::board::heard_from_afar(&self.app);
        let _ = self.app.emit("flyway:left", Left { host: Some(host.to_string()) });
        self.emit_roster();
        known
    }

    /// A wall says it is leaving. Believed only if it is who the handshake
    /// proved (`Wire::peer` derives an identity from a name, so a name that
    /// does not derive this connection's is somebody else's goodbye).
    pub(super) fn departed(self: &Arc<Self>, host: &str, who: Dialler) {
        let host = crate::clean::scrub(host).into_owned();
        if host.is_empty() || host.eq_ignore_ascii_case(&self.me) {
            return;
        }
        if self.wire.peer(&host).ok() != Some(who.id) {
            log::warn!("flyway: a goodbye naming {host} came from a wall that is not {host} — ignored");
            return;
        }
        if let Ok(mut left) = self.left.lock() {
            left.insert(host.clone());
        }
        if self.drop_wall(&host, true) {
            crate::chronicle::note(&self.app, None, "volery", "note", &format!("{host} left the flyway"), "the flyway");
        }
    }
}

/// Leave the flyway — and mean it, now, without a restart.
///
/// In this order, and each step is why the next is safe:
///
/// 1. Who to tell is read while the invite's seed is still in the vault.
/// 2. The key is cleared. This is the decision, and the only step that can
///    refuse (a lab borrowing the installed wall's key may not), so it comes
///    before anything is said: a leave that fails has changed nothing.
/// 3. The link is taken out of the wall, so nothing new can reach it, and
///    closed, so nothing it started carries on.
/// 4. The goodbye, to every wall that is listening.
/// 5. The endpoint closes, which ends every connection and the accept loop.
/// 6. The front end is told, and drops everything it drew from the flyway.
///
/// The cards other walls opened here are not closed by this — leaving ends the
/// *link*, and a card is a conversation somebody may still want. See
/// `key.rs`, which has always said the caller is expected to deal with them.
pub(super) async fn leave(app: AppHandle) -> Result<(), String> {
    key::can_leave()?;
    let Some(state) = app.try_state::<Flyway>() else {
        return crate::off_main(key::leave).await?;
    };
    /* Held across the whole of it, so a launch or a key being entered at the
       same moment cannot bring a second link up between the steps. */
    let _one = state.arriving.lock().await;
    let tell = current(&app).map(|l| l.farewell_hosts()).unwrap_or_default();
    crate::off_main(key::leave).await??;
    let link = state.link.lock().map_err(|_| "the flyway is wedged".to_string())?.take();
    if let Some(l) = link {
        l.tenure.close();
        let wanted = tell.len();
        let told = l.farewell(tell).await;
        l.shutdown().await;
        log::info!("flyway: left — said goodbye to {told} of {wanted} wall(s)");
    }
    crate::chronicle::note(&app, None, "volery", "note", "this wall left the flyway", "the flyway");
    let _ = app.emit("flyway:roster", Vec::<RosterRow>::new());
    let _ = app.emit("flyway:left", Left { host: None });
    crate::board::heard_from_afar(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(f)
    }

    fn set(hosts: &[&str]) -> BTreeSet<String> {
        hosts.iter().map(|h| h.to_string()).collect()
    }

    fn never(_: &str) -> bool {
        false
    }

    /// **Leave stops dialling.** The tick is the thing that kept a left wall on
    /// the flyway; once the tenure is closed it runs no more, however long the
    /// period, and a sleep in progress is cut short rather than waited out.
    #[test]
    fn a_closed_link_runs_no_more_ticks_and_does_not_wait_out_its_sleep() {
        let ticks = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(Tenure::new());
        let (t, s) = (ticks.clone(), stop.clone());
        let started = std::time::Instant::now();
        run(async move {
            let closer = s.clone();
            tick_until_closed(&s, Duration::from_secs(3600), || {
                let t = t.clone();
                let closer = closer.clone();
                async move {
                    /* The first tick is the only one: it ends the link itself.
                       Bounded, so a loop that ignores the close *fails* here
                       rather than spinning for ever and holding the test binary
                       — which is what the guard check of this test did once. */
                    let n = t.fetch_add(1, Ordering::SeqCst);
                    assert!(n < 100, "the loop went on ticking after the link closed");
                    if n == 0 {
                        closer.close();
                    }
                }
            })
            .await;
        });
        assert_eq!(ticks.load(Ordering::SeqCst), 1, "no tick after the link closed");
        assert!(started.elapsed() < Duration::from_secs(5), "an hour's sleep must not be waited out");
    }

    /// The other half: a close that arrives *during* the sleep ends it.
    #[test]
    fn a_close_during_the_sleep_wakes_it() {
        let stop = Arc::new(Tenure::new());
        let s = stop.clone();
        let started = std::time::Instant::now();
        let carried_on = run(async move {
            let closer = s.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                closer.close();
            });
            s.sleep(Duration::from_secs(3600)).await
        });
        assert!(!carried_on);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// A link that is not closed ticks on its period, so the guard above is
    /// the thing stopping it and not the loop being broken.
    #[test]
    fn an_open_link_keeps_ticking() {
        let ticks = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(Tenure::new());
        let (t, s) = (ticks.clone(), stop.clone());
        run(async move {
            let closer = s.clone();
            tick_until_closed(&s, Duration::from_millis(5), || {
                let t = t.clone();
                let closer = closer.clone();
                async move {
                    if t.fetch_add(1, Ordering::SeqCst) == 4 {
                        closer.close();
                    }
                }
            })
            .await;
        });
        assert_eq!(ticks.load(Ordering::SeqCst), 5);
    }

    /// A goodbye goes to every wall that is listening — and not to this wall,
    /// to one on the older language, or to one that has gone quiet.
    #[test]
    fn a_goodbye_goes_to_every_wall_that_is_listening() {
        let roster = vec![("lap".to_string(), false), ("asleep".to_string(), true), ("old".to_string(), false), ("me".to_string(), false)];
        let heard = set(&["dialled", "asleep"]);
        let older = |h: &str| h == "old";
        let to = farewell_to("me", &roster, &heard, Some("seed"), &older);
        assert_eq!(to, vec!["dialled", "lap", "seed"]);
        /* Said to nobody when nobody is there. */
        assert!(farewell_to("me", &[], &BTreeSet::new(), None, &never).is_empty());
        /* A seed that is also quiet on the roster is not dialled for it. */
        assert!(farewell_to("me", &[("seed".to_string(), true)], &BTreeSet::new(), Some("seed"), &never).is_empty());
    }

    /// A wall that said goodbye is not dialled on a stale `heard` entry or the
    /// invite's seed, and is the moment it is on the roster again.
    #[test]
    fn a_wall_that_said_goodbye_is_not_dialled_until_it_is_back() {
        let left = set(&["gone"]);
        let heard = set(&["gone", "other"]);
        let none: Vec<String> = Vec::new();
        assert_eq!(tick_hosts("me", &none, &heard, Some("gone"), &left), set(&["other"]));
        /* It announced again — on the roster, so dialled, left or not. */
        assert_eq!(tick_hosts("me", &["gone".to_string()], &heard, None, &left), set(&["gone", "other"]));
        /* And never this wall. */
        assert_eq!(tick_hosts("me", &["me".to_string()], &BTreeSet::new(), Some("ME"), &BTreeSet::new()), BTreeSet::new());
    }
}
