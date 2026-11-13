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
//! pure and tested), notes it here, and what happens at the door is a
//! comparison (`share.rs`). Two implementations of "how much of this window is
//! yours" would drift, and the drift would show as a wall holding work back over
//! a figure the panel was drawing differently.
//!
//! Three facts meet here, and all three already existed: the caps (`account`'s
//! `caps` column), the account's own last reading (`limits::own_reading`, the
//! cache the waterfall's poll keeps warm), and the noted share.
//!
//! **The note is a rate, not a fact** — at most two minutes old, refreshed on
//! the wall's tick. Inside a window usage only accumulates, so a stale share
//! *understates*, which is the direction this wall already accepts one layer
//! out: an unmeasured account may cross a ceiling once. Missing entirely means
//! the old behaviour exactly, so a wall that has never measured a share is not a
//! wall with every card held.

pub mod share;

use share::{readings_of, refusal, refusal_said, Note, Share};
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
    for one in shares.into_iter().take(LABEL_MOST) {
        let account = one.account.trim().to_string();
        if account.is_empty() {
            continue;
        }
        let priced = if one.priced.is_finite() { one.priced.max(0.0) } else { 0.0 };
        let points = if one.points.is_finite() { one.points.max(0.0) } else { 0.0 };
        map.entry(account)
            .or_default()
            .push(Share { kind: one.kind, points, priced });
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
pub fn cap_refusal(app: &AppHandle, card: &str) -> Option<String> {
    let store = app.try_state::<crate::store::Store>()?;
    let (label, caps) = {
        let conn = store.0.lock().ok()?;
        let label = crate::store::account_of(&conn, card)?;
        if label.is_empty() {
            return None;
        }
        let caps = crate::accounts::caps_of(&conn, &label)?;
        (label, caps)
    };
    let (report, _) = crate::limits::own_reading(app, &label)?;
    let readings = readings_of(&report);
    let shares = shares_of(app, &label);
    let (kind, points, cap) = refusal(&caps, &readings, &shares)?;
    Some(refusal_said(&label, &kind, points, cap))
}
