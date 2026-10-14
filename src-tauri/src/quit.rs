//! Whether closing the window should go through the first time it is asked.
//!
//! Skein's close is unconditional and has to stay that way in spirit: quitting
//! takes every card's process tree down with it, and a background job spared at
//! shutdown is a process nothing can ever reap. See `.claude/rules/turns.md`,
//! "a row is not a handle". What this adds is not an escape from that, it is a
//! sentence before it — a wall with a twenty-five-minute import on it says so
//! rather than losing it silently and explaining at the next launch.
//!
//! **The answer has to be here rather than asked for at the moment of closing.**
//! `CloseRequested` is handled on the main thread inside the event loop, and the
//! only thing that knows which cards are busy is the webview — which cannot be
//! asked a question synchronously from there, and may not answer at all. So the
//! wall keeps this counter current as its jobs come and go (`note_busy`), the
//! same bargain `store::set_mid_turn` strikes for a turn: write the fact through
//! as it changes, so the code that runs at exit only has to read it.
//!
//! **And a second close always goes through**, which is the whole safety story.
//! Anything else risks an app that cannot be quit — the failure `lib.rs` already
//! carries a comment about, whose only remedy was Task Manager. If the webview
//! is wedged, or the counter is stale, or the dialog never paints, pressing
//! close twice exits. That is also what the dialog's own "quit anyway" does: it
//! closes the window again rather than calling some third command, so the
//! confirmed path and the escape hatch are one path and there is no way for them
//! to disagree.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tauri::State;

#[derive(Default)]
pub struct Quit {
    /// How many cards are holding background work, as the wall last said.
    ///
    /// Zero on a fresh launch, which is the honest answer: nothing has reported
    /// a job yet, and a quit in the first seconds of a wall has nothing to warn
    /// about.
    busy: AtomicUsize,
    /// Whether a close has already been refused once.
    ///
    /// Set when we prevent one, cleared when the wall says the user chose to
    /// stay. Never cleared anywhere else — a wedged webview leaves it set, and
    /// set is precisely the state in which the next close goes through.
    asked: AtomicBool,
}

impl Quit {
    /// Should this close be held back to ask first?
    ///
    /// Consumes the one refusal it is allowed: the `swap` is what makes the
    /// second press go through, and it is deliberately done here rather than by
    /// the caller so there is no path that checks without spending.
    pub fn should_ask(&self) -> Option<usize> {
        let busy = self.busy.load(Ordering::Relaxed);
        if busy == 0 {
            return None;
        }
        if self.asked.swap(true, Ordering::Relaxed) {
            return None;
        }
        Some(busy)
    }

    /// How many cards are holding background work, read without spending the
    /// refusal — what the update tool tells a person before they approve.
    pub fn busy(&self) -> usize {
        self.busy.load(Ordering::Relaxed)
    }

    /// A person has already said yes to closing, in a question that told them
    /// what this one would have — so the close they approved goes through.
    ///
    /// The update tool's (`update::self_update`), and the reason it exists is
    /// where that question can be answered. This latch is answered by a dialog
    /// on *this* machine, and the update is driven, in the case it exists for,
    /// from another one: a held close here would put up a question nobody is in
    /// front of, and the update would stall behind it. Setting `asked` is the
    /// state a second press already leaves, so this is not a third path through
    /// the close — it is the one that already lets the second press through.
    pub fn consent(&self) {
        self.asked.store(true, Ordering::Relaxed);
    }
}

/// The wall reporting how many of its cards are holding background work.
///
/// Called on the transition rather than on a beat — see `App.svelte`. The number
/// is a count and not a list because that is all the decision needs; the list is
/// drawn by the side that already has it.
#[tauri::command]
pub fn note_busy(quit: State<'_, Quit>, count: usize) {
    quit.busy.store(count, Ordering::Relaxed);
}

/// The user chose not to quit, so the next close should ask again.
///
/// Without this, "stay" would buy exactly one reprieve and the following close
/// would go straight through — which is the shape of a dialog that lies, since
/// the second press looks identical to the first.
#[tauri::command]
pub fn stay(quit: State<'_, Quit>) {
    quit.asked.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_wall_is_never_held_back() {
        let q = Quit::default();
        assert_eq!(q.should_ask(), None);
        /* And repeatedly, since nothing about a quiet wall changes by asking. */
        assert_eq!(q.should_ask(), None);
    }

    #[test]
    fn a_busy_wall_is_asked_once_and_then_let_through() {
        let q = Quit::default();
        q.busy.store(3, Ordering::Relaxed);
        assert_eq!(q.should_ask(), Some(3), "the first close should ask");
        assert_eq!(
            q.should_ask(),
            None,
            "the second must go through, or a wedged webview is an app you cannot quit"
        );
    }

    #[test]
    fn staying_restores_the_question() {
        let q = Quit::default();
        q.busy.store(1, Ordering::Relaxed);
        assert_eq!(q.should_ask(), Some(1));
        q.asked.store(false, Ordering::Relaxed); // what `stay` does
        assert_eq!(
            q.should_ask(),
            Some(1),
            "after choosing to stay, the next close asks again"
        );
    }

    /// A yes given elsewhere — the update tool's question, answered from another
    /// wall — lets the close it approved straight through, and the count it was
    /// told is still readable without spending anything.
    #[test]
    fn consent_given_elsewhere_lets_the_close_through() {
        let q = Quit::default();
        q.busy.store(2, Ordering::Relaxed);
        assert_eq!(q.busy(), 2);
        assert_eq!(q.busy(), 2, "reading the count spends nothing");
        q.consent();
        assert_eq!(q.should_ask(), None, "the approved close must not be held a second time");
    }

    #[test]
    fn work_that_lands_after_staying_is_not_asked_about_again() {
        /* You were asked, you stayed, and the job finished while you carried
           on. The next close has nothing to warn about and must not spend a
           question on it — the wall keeps `busy` current for exactly this, so
           the answer is already here by the time the close arrives. */
        let q = Quit::default();
        q.busy.store(1, Ordering::Relaxed);
        assert_eq!(q.should_ask(), Some(1));
        q.asked.store(false, Ordering::Relaxed);
        q.busy.store(0, Ordering::Relaxed);
        assert_eq!(q.should_ask(), None);
    }
}
