//! What the front end cannot see when it is deciding to let a card rest.
//!
//! `reaping.ts` holds the whole policy and most of the reasoning; this is the
//! two facts it has to ask for, in one call because they are asked together and
//! at the same rare moment.
//!
//! **How much of the machine is left.** The reaper shortens its wait as memory
//! runs out, which is where the value of the whole feature is — the wall it was
//! measured on had 1.5 GB available and nine idle cards holding ~6 GB. Note this
//! deliberately does *not* go through `perf::Meter`: that sampler exists only
//! while a performance widget is on the wall, it holds its lock across a full
//! process enumeration, and it is the one sanctioned poller in this app. Reading
//! memory is one syscall and wants none of that. A fresh `System` restricted to
//! RAM builds no process table at all, so there is nothing worth keeping between
//! two calls a minute apart.
//!
//! **Which of these cards has an armed `wake_me`.** A card with one may not be
//! stood down: `later::serve_due` delivers through `supervisor::deliver`, which
//! fails for a card with no process, and the wake then goes to the inbox
//! `spawn_conversation` drains — arriving whenever somebody next speaks to the
//! card rather than at the time it was asked for, which is the failure `wake_me`
//! exists to prevent. `reaping.ts` has the long form of that, including why
//! rousing the card instead was not taken.
//!
//! Asked about named ids rather than answered wall-wide, so this stays a
//! question about the cards actually being considered — a handful, and usually
//! none. It is `wakes_armed_by` per id rather than one `IN` query for the same
//! reason: the store already answers exactly this question, and a second
//! spelling of it in a second file is two things to keep in step.
//!
//! `async` and on `off_main`, per CLAUDE.md: it takes the store mutex, which
//! `azdo_runs` holds across an entire network pass, so a blocking arm here would
//! wait for that lock *on the main thread* and stop the wall being painted.

use serde::Serialize;
use sysinfo::{MemoryRefreshKind, RefreshKind, System};
use tauri::{AppHandle, Manager};

use crate::store::Store;

#[derive(Debug, Serialize)]
pub struct Survey {
    /// Bytes the machine could still hand out. The number `waitFor` reads.
    pub available: u64,
    /// And what that is out of, so a reading can be drawn as a fraction without
    /// a second call. Nothing uses it yet; it costs nothing and a memory figure
    /// with no denominator is one nobody can check.
    pub total: u64,
    /// Of the ids asked about, those holding at least one armed wake.
    pub awaiting_wake: Vec<String>,
}

#[tauri::command]
pub async fn reap_survey(app: AppHandle, ids: Vec<String>) -> Result<Survey, String> {
    crate::off_main(move || {
        let mut sys =
            System::new_with_specifics(RefreshKind::nothing().with_memory(
                MemoryRefreshKind::nothing().with_ram(),
            ));
        sys.refresh_memory();

        let store = app.state::<Store>();
        let awaiting_wake = {
            let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
            ids.into_iter()
                .filter(|id| crate::store::wakes_armed_by(&conn, id) > 0)
                .collect()
        };

        Ok(Survey {
            available: sys.available_memory(),
            total: sys.total_memory(),
            awaiting_wake,
        })
    })
    /* `off_main` is `Result<R, String>` and `R` is itself the closure's
       `Result`, so the two have to be flattened — the outer is "the blocking
       pool lost the work", the inner is "the store was unavailable", and a
       caller wants one error rather than a nest. */
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one thing here worth asserting without a wall: that the memory
    /// reading is a real one and not zero, since `waitFor` treats a small number
    /// as pressure and would stand every card down at the floor if this ever
    /// came back empty. A machine with no memory is not a case.
    #[test]
    fn the_machine_answers_with_memory() {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        sys.refresh_memory();
        assert!(sys.total_memory() > 0, "no total memory reading");
        assert!(sys.available_memory() > 0, "no available memory reading");
        assert!(sys.available_memory() <= sys.total_memory());
    }
}
