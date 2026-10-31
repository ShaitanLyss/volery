//! Volery out of its own picture.
//!
//! A tile showing this laptop's own monitor would otherwise show the wall,
//! which shows the tile, which shows the wall: a hall of mirrors, and nothing
//! of the desktop behind. `set_content_protected(true)` is
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` underneath, and DWM
//! honours it for Desktop Duplication as it does for screenshots — measured by
//! `examples/cast-probe.rs`, which reads the pixels back with a control
//! window beside the excluded one so that "absent" means something.
//!
//! **Held only while a local self-view is open**, counted, and cleared when
//! the last one closes. The same flag hides Volery from screenshots and from
//! screen sharing, and that must not become a permanent side effect of having
//! once opened a tile (`docs/SCREENS.md`). A far wall watching this laptop
//! while a self-view is open also sees it without Volery; that is accepted.

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static HELD: Mutex<usize> = Mutex::new(0);

/// One self-view's claim. Dropping it gives the claim back.
pub struct Hold {
    app: AppHandle,
}

/// Every window this app has — the wall, the peek, and anything opened since
/// — rather than a list of labels that the next window would be missing from.
fn protect(app: &AppHandle, on: bool) {
    for (label, w) in app.webview_windows() {
        if let Err(e) = w.set_content_protected(on) {
            log::warn!("cast: could not {} {label} from capture: {e}", if on { "hide" } else { "unhide" });
        }
    }
}

/// The step a count takes: whether this change crosses zero, and which way.
pub fn crossing(before: usize, after: usize) -> Option<bool> {
    match (before, after) {
        (0, 1) => Some(true),
        (1, 0) => Some(false),
        _ => None,
    }
}

pub fn hold(app: &AppHandle) -> Hold {
    let mut n = HELD.lock().unwrap();
    if let Some(on) = crossing(*n, *n + 1) {
        protect(app, on);
    }
    *n += 1;
    Hold { app: app.clone() }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut n = HELD.lock().unwrap();
        let after = n.saturating_sub(1);
        if let Some(on) = crossing(*n, after) {
            protect(&self.app, on);
        }
        *n = after;
    }
}

#[cfg(test)]
mod tests {
    use super::crossing;

    #[test]
    fn only_the_first_hold_and_the_last_release_touch_the_windows() {
        assert_eq!(crossing(0, 1), Some(true));
        assert_eq!(crossing(1, 2), None);
        assert_eq!(crossing(2, 1), None);
        assert_eq!(crossing(1, 0), Some(false));
    }
}
