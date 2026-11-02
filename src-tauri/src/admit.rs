//! Whether the wall's allowance admits new work right now — the one fact a
//! fan-out, a wake and a stop notice all need before they spend a turn.
//!
//! **What this file decides and what it does not.** Which account takes the
//! next turn is `accounts.ts::choose` and `credits.ts::route`, in the front end,
//! and nothing here re-decides it: the caps, the tiers, the refusals the stream
//! has heard and boost all live there, and a second copy of that policy in Rust
//! is the drift `spawn.md` warns about every time a decision crosses an `emit`.
//! What the front end *says* is the outcome, as it changes (`note_allowance`,
//! `quit::note_busy`'s shape and `credits::note_boost`'s): whether the ladder
//! would hold a new card, and if not, which account it would land on and how
//! close that account is to its ceiling. This file only reads that against the
//! two things Rust alone can see — which cards are mid-turn, and what is about
//! to be handed a turn.
//!
//! **The two failures it exists for**, both measured on 2026-10-30
//! (`.scratch-12fa2a91/`): a Remote Desktop fan-out of five and the RISE
//! coordinator all hit "You've hit your 5-hour limit" within minutes of each
//! other, twice in a day, and then paid a cold full-context cache rewrite
//! together at the reset; and the coordinator was handed eighteen turns that were
//! "cut off — allowance ran out" and seventeen that "never reached a model".
//! Sink d08fa95e and d0a91bf0.
//!
//! - **A wake, or a parent's stop notice, waits while every account is spent**
//!   (`wall_held`). It is held, never dropped: the wake row stays due and is
//!   served once the wall says there is room, and a settle stays pending.
//!   `turns.md`'s rule for a nudge — "a card with no allowance is not nudged
//!   either; a deferred nudge is put back, not dropped" — carried to the two
//!   prompts Rust writes on its own initiative.
//! - **A spawn queues when the account it would land on is past [`CEILING`]
//!   and other cards are working** (`verdict`). The card still opens — Lyss,
//!   2026-11-02: visible, with its brief held — so it can be seen, cancelled or
//!   let go, and it starts when the window resets, when another account frees
//!   up, or when nothing else is working. Running work finishes before new work
//!   starts, which is what keeps a window from ending with N half-done contexts
//!   that all re-pay their cache writes at once.
//!
//! **A reading too old to trust admits everything.** The front end re-notes
//! every minute (`Skein.#holdSweep`) and whenever the waterfall moves; a wall
//! whose webview has stopped saying anything is a wall this file knows nothing
//! about, and the failure on that side must be the one that existed before it —
//! a turn tried and refused — never a wake that silently never fires.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// How close to its ceiling the landing account may be before a new card
/// queues. Lyss's number, 2026-11-02, asked against "on a 5-hour window that
/// leaves roughly 45 minutes of a busy wall's spend for the running cards to
/// finish in". It is a fraction of *her* ceiling where she set a cap, of the
/// server's where she did not — `accounts.ts::spentOf`'s denominator.
pub const CEILING: f64 = 0.85;

/// Past this a noted reading is not trusted. Five sweeps of the front end's
/// minute, so a wall that is merely busy never trips it.
const STALE_MS: i64 = 5 * 60_000;

/// What the wall last said, or nothing if it never has (no accounts managed,
/// or a webview that has not reached `load`).
#[derive(Default)]
pub struct Allowance(Mutex<Option<Noted>>);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Noted {
    /// No account — and no credits, with boost on — would take a new card.
    pub held: bool,
    /// When the first door opens, epoch ms, where a blocker named one.
    pub until: Option<i64>,
    /// The account a new card would land on, when it is an account.
    pub landing: Option<String>,
    /// How close `landing` is to its ceiling, 0..=1 (past 1 is over a cap).
    pub spent: Option<f64>,
    /// When the window behind `spent` resets, epoch ms.
    pub resets_at: Option<i64>,
    /// When this was noted, on this clock.
    pub at: i64,
}

/// The front end's word, written as it changes. A mutex and nothing else, so it
/// is safe on the main thread — the rule `off_main` enforces is about waiting,
/// and nothing here waits.
#[tauri::command]
pub fn note_allowance(
    state: State<'_, Allowance>,
    held: bool,
    until: Option<i64>,
    landing: Option<String>,
    spent: Option<f64>,
    resets_at: Option<i64>,
) {
    let noted = Noted {
        held,
        until,
        landing: landing.map(|l| crate::clip::preview(&crate::clean::scrub(l.trim()), 80)).filter(|l| !l.is_empty()),
        spent: spent.filter(|s| s.is_finite() && *s >= 0.0),
        resets_at,
        at: crate::store::now(),
    };
    if let Ok(mut n) = state.0.lock() {
        *n = Some(noted);
    }
}

/// The wall has no accounts to manage, or has stopped managing them.
#[tauri::command]
pub fn forget_allowance(state: State<'_, Allowance>) {
    if let Ok(mut n) = state.0.lock() {
        *n = None;
    }
}

fn noted(app: &AppHandle) -> Option<Noted> {
    app.try_state::<Allowance>()?.0.lock().ok()?.clone()
}

/// What a new card is told about where it stands.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Queued {
    /// The face's line, lowercase and quiet: what it is waiting on.
    pub why: String,
    /// When it starts at the latest, if anything named a time.
    pub until: Option<i64>,
}

/// Admit a new card, or say why it waits. Pure, so the rule is asserted.
///
/// `working` is how many *other* cards hold a turn open — the caller of a
/// `spawn` is always mid-turn, since it is making the call, and must not count
/// as a card the new one should wait behind.
pub fn verdict(noted: Option<&Noted>, working: usize, now: i64) -> Option<Queued> {
    let n = noted.filter(|n| now.saturating_sub(n.at) <= STALE_MS)?;
    if n.held {
        return Some(Queued {
            why: "queued — every account is spent, so it starts when one has room".into(),
            until: n.until,
        });
    }
    let (spent, landing) = (n.spent?, n.landing.as_deref()?);
    if spent < CEILING || working == 0 {
        return None;
    }
    let pct = (spent * 100.0).floor().min(999.0) as u32;
    let others = if working == 1 { "the card already working finishes".to_string() } else { format!("the {working} cards already working finish") };
    Some(Queued {
        why: format!("queued — {landing} is {pct}% spent, so {others} first"),
        until: n.resets_at.filter(|t| *t > now),
    })
}

/// The same, read off the live wall. `except` is the card asking, if one is.
///
/// Takes the supervisor's lock, which `deliver_blocks` holds across a stdin
/// write — so a Tauri command that reaches this must be off the main thread
/// (`admit_now`), `CLAUDE.md`'s back-door freeze.
pub fn queued(app: &AppHandle, except: Option<&str>) -> Option<Queued> {
    let n = noted(app)?;
    let working = app
        .try_state::<crate::supervisor::Supervisor>()
        .map(|s| s.mid_turn().into_iter().filter(|id| Some(id.as_str()) != except).count())
        .unwrap_or(0);
    verdict(Some(&n), working, crate::store::now())
}

/// Whether a card queued at spawn may start now. The front end asks this from
/// `releaseHeld`, having noted a fresh reading first, rather than deciding it
/// again — one rule, in one place.
#[tauri::command(async)]
pub async fn admit_now(app: AppHandle) -> Result<Option<Queued>, String> {
    crate::off_main(move || queued(&app, None)).await
}

/// Every account is spent, so a prompt Rust writes on its own initiative would
/// be a turn that never reaches a model. `Some(until)` while that is true, with
/// the first door's time where one is known. Pure over the noted reading.
pub fn held_at(noted: Option<&Noted>, now: i64) -> Option<Option<i64>> {
    let n = noted.filter(|n| now.saturating_sub(n.at) <= STALE_MS)?;
    n.held.then_some(n.until)
}

pub fn wall_held(app: &AppHandle) -> Option<Option<i64>> {
    held_at(noted(app).as_ref(), crate::store::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(spent: f64) -> Noted {
        Noted {
            held: false,
            until: None,
            landing: Some("tx-team".into()),
            spent: Some(spent),
            resets_at: Some(10_000),
            at: 1_000,
        }
    }

    #[test]
    fn room_on_the_landing_account_admits() {
        assert_eq!(verdict(Some(&n(0.84)), 5, 2_000), None);
    }

    #[test]
    fn nearly_spent_with_work_running_queues_until_the_reset() {
        let q = verdict(Some(&n(0.88)), 3, 2_000).expect("queued");
        assert!(q.why.contains("tx-team is 88% spent"), "{}", q.why);
        assert!(q.why.contains("3 cards already working"), "{}", q.why);
        assert_eq!(q.until, Some(10_000));
    }

    /// Nobody to finish first: starting one card is not a fan-out draining the
    /// window, and holding it would only wait for a reset nothing is spending
    /// towards.
    #[test]
    fn nearly_spent_with_nothing_working_admits() {
        assert_eq!(verdict(Some(&n(0.97)), 0, 2_000), None);
    }

    #[test]
    fn a_held_wall_queues_whatever_the_counts() {
        let held = Noted { held: true, until: Some(9_000), at: 1_000, ..Default::default() };
        let q = verdict(Some(&held), 0, 2_000).expect("queued");
        assert!(q.why.contains("every account is spent"), "{}", q.why);
        assert_eq!(q.until, Some(9_000));
        assert_eq!(held_at(Some(&held), 2_000), Some(Some(9_000)));
    }

    /// The failure on a silent webview must be the one that existed before:
    /// tried and refused, never a wake or a card that waits on nothing.
    #[test]
    fn a_stale_or_absent_reading_admits_and_holds_nothing() {
        assert_eq!(verdict(None, 9, 2_000), None);
        let held = Noted { held: true, at: 0, ..Default::default() };
        assert_eq!(verdict(Some(&held), 9, STALE_MS + 1), None);
        assert_eq!(held_at(Some(&held), STALE_MS + 1), None);
        assert_eq!(held_at(None, 0), None);
    }

    /// Credits, or a wall with nothing measured: no account to be near a
    /// ceiling of, so nothing to queue behind.
    #[test]
    fn no_landing_account_admits() {
        let credits = Noted { landing: None, spent: None, at: 1_000, ..Default::default() };
        assert_eq!(verdict(Some(&credits), 4, 2_000), None);
    }

    /// A reset already past is not a time to wait for.
    #[test]
    fn a_past_reset_is_not_offered() {
        let q = verdict(Some(&n(0.9)), 1, 20_000).expect("queued");
        assert_eq!(q.until, None);
        assert!(q.why.contains("the card already working finishes"), "{}", q.why);
    }
}
