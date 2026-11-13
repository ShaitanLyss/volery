//! Your own share of an account's window, as the *door* needs it.
//!
//! `accounts.ts` decides what a cap means and measures it on the work this
//! wall's own facts explain; `deliver_blocks` is the one door every prompt goes
//! through, so a cap enforced only where the front end sends would be a cap a
//! relay, a wake or a subscription walks around — the same argument the
//! spending cap next to it makes (`provider::budget_refusal`).
//!
//! **The arithmetic stays in one place.** This file does not attribute
//! anything: the front end computes the share (`allowancesamples.ts::ownPoints`,
//! pure and tested) and notes it here with the reading it is a share of, and
//! what happens at the door is a comparison (`share.rs`). Two implementations of
//! "how much of this window is yours" would drift, and the drift would show as a
//! wall holding work back over a figure the panel was drawing differently.
//!
//! **The note carries the whole comparison.** An earlier cut read the account's
//! percentage out of `limits::own_reading`, and that was two failures for one
//! lookup: the cache is emptied when the last usage widget detaches and filled
//! only by a successful poll, so the door silently stopped enforcing on a wall
//! nobody was watching; and a cached figure can describe a window that has since
//! rolled, so the door could refuse a prompt on a reset that had already
//! happened. Now the note says what it measured and when that window turns over.
//!
//! **The note is a rate, not a fact** — at most three minutes old, refreshed on
//! the waterfall's pass. Inside a window usage only accumulates, so a stale
//! share *understates*, which is the direction this wall already accepts one
//! layer out: an unmeasured account may cross a ceiling once. Missing entirely
//! means the old behaviour exactly, so a wall that has never measured a share is
//! not a wall with every card held.

pub mod share;

use share::{refusal, refusal_said, Note, Share};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct OwnShare(pub Mutex<HashMap<String, Vec<Share>>>);

const KIND_MOST: usize = 16;
const LABEL_MOST: usize = 64;

#[tauri::command]
pub fn note_own(state: State<'_, OwnShare>, shares: Vec<Note>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|_| "the share table is unavailable")?;
    map.clear();
    for one in shares {
        let account = one.account.trim().to_string();
        if account.is_empty() {
            continue;
        }
        /* Bounded by **labels**, not by rows: a wall with more accounts than
           `LABEL_MOST` must lose whole accounts rather than the least-moved
           window of the last one, and an account with no share is a share the
           door reads as unknown, which falls back rather than holding work. */
        if !map.contains_key(&account) && map.len() >= LABEL_MOST {
            continue;
        }
        let finite = |v: f64| if v.is_finite() { v.max(0.0) } else { 0.0 };
        map.entry(account).or_default().push(Share {
            kind: one.kind,
            points: finite(one.points),
            priced: finite(one.priced),
            worked: one.worked,
            used: finite(one.used),
            resets_at: one.resets_at,
        });
    }
    for list in map.values_mut() {
        list.truncate(KIND_MOST);
    }
    Ok(())
}

/// The shares this wall last noted for one account.
pub fn shares_of(app: &AppHandle, label: &str) -> Vec<Share> {
    let Some(state) = app.try_state::<OwnShare>() else {
        return Vec::new();
    };
    let Ok(map) = state.0.lock() else {
        return Vec::new();
    };
    map.get(label).cloned().unwrap_or_default()
}

/// Why a prompt into this card must not be sent, or none.
///
/// Called from `deliver_blocks` beside `provider::budget_refusal`, and on the
/// same terms: the paths that reach it are the ones that never met the front
/// end's own settling — a relay message, a wake, a queue drained at spawn.
///
/// **A bypassed card is not refused**, because the bypass is the deliberate
/// instruction that this card matters more than the reserve and it already moves
/// the ceiling on the front end (`capFor`). A door that ignored it would refuse
/// the one gesture made to spend past the reserve, which is the worse of the two
/// ways to be wrong.
pub fn cap_refusal(app: &AppHandle, card: &str) -> Option<String> {
    let store = app.try_state::<crate::store::Store>()?;
    let now = crate::store::now();
    let (label, caps) = {
        let conn = store.0.lock().ok()?;
        if crate::admit::bypass_of(&conn, card) {
            return None;
        }
        let label = crate::store::account_of(&conn, card)?;
        if label.is_empty() {
            return None;
        }
        let caps = crate::accounts::caps_of(&conn, &label)?;
        (label, caps)
    };
    let shares = shares_of(app, &label);
    let (kind, points, cap) = refusal(&caps, &shares, now)?;
    Some(refusal_said(&label, &kind, points, cap))
}
