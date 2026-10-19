//! Whether the main thread is answering.
//!
//! ### Why this is allowed to look
//!
//! `CLAUDE.md` names three places on this app that go and look, and says a
//! fourth owes the argument. This is it: **a starved thread is the one thing
//! that cannot announce itself.** Every event this wall folds is delivered *by*
//! the main thread, so the moment it stops answering, the only events that
//! could have said so are queued behind whatever stopped it. There is no event
//! near it to fold; the absence of events is the symptom.
//!
//! On 2026-10-19 the wall froze for ten minutes behind 741,000 dev-server lines
//! (`crate::sluice` has the whole night), and nothing in the app could say so,
//! then or afterwards. This is the instrument that night lacked.
//!
//! ### What it costs, and the bound
//!
//! One thread, asleep, and once a second a no-op closure posted to the main
//! thread. Answered, that is a few microseconds of main-thread time a second
//! and nothing else. It never retries, never stacks — a ping that has not come
//! back is waited for rather than joined by a second one — so a stall costs it
//! nothing at all.
//!
//! ### What it says, and where
//!
//! A stall over `STALL` is a `warn` in the app log *when it starts* (so the
//! file has it even if the app is killed mid-stall, which is how the last one
//! ended) and again when it ends, with how long and which streams were busiest
//! while it lasted (`crate::sluice::busiest`). One over `NOTEWORTHY` is also a
//! row in the chronicle, because a ten-second freeze is something that
//! *happened to you* — the chronicle's rule for what Volery records itself.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use tauri::AppHandle;

/// How often the main thread is asked.
const EVERY: Duration = Duration::from_secs(1);

/// How long an answer may take before it is called a stall. Generous on
/// purpose: a cold WebView2 navigation or a big layout can hold the thread for
/// a few hundred milliseconds legitimately, and a watchdog that cries over
/// those is one whose warnings get skipped.
const STALL: Duration = Duration::from_secs(2);

/// How long a stall must last to earn a row in the chronicle.
const NOTEWORTHY: Duration = Duration::from_secs(10);

pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || watch(&app));
}

/// How long after launch before the first look. Making the windows is the
/// main thread's own work and takes one to two seconds on a cold WebView2;
/// a watchdog that reported every launch as a stall would teach everyone to
/// skip its warnings.
const SETTLE: Duration = Duration::from_secs(15);

fn watch(app: &AppHandle) {
    std::thread::sleep(SETTLE);
    /* The tally is read once here so the first report is about the stall and
       not about everything since launch. */
    let _ = crate::sluice::busiest();
    loop {
        std::thread::sleep(EVERY);
        let (tx, rx) = mpsc::channel::<()>();
        let sent = Instant::now();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(());
            })
            .is_err()
        {
            return; /* the event loop is gone: the app is closing. */
        }
        match rx.recv_timeout(STALL) {
            Ok(()) => {
                /* Answered in time. The tally since the last ping is about a
                   healthy second, and is thrown away so the next stall's
                   report is about that stall. */
                let _ = crate::sluice::busiest();
            }
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                log::warn!(
                    "the main thread has not answered for {}s — the wall is not drawing \
                     and no command is being answered. {}",
                    STALL.as_secs(),
                    busiest_words()
                );
                /* Waited for, not re-asked: the same closure is still in the
                   queue, and its arrival is the end of the stall. */
                if rx.recv().is_err() {
                    return;
                }
                let lasted = sent.elapsed();
                let words = busiest_words();
                log::warn!(
                    "the main thread answered again after {:.1}s. {words}",
                    lasted.as_secs_f64()
                );
                if lasted >= NOTEWORTHY {
                    crate::chronicle::note(
                        app,
                        None,
                        "volery",
                        "bad",
                        &format!("the wall froze for {}s", lasted.as_secs()),
                        &words,
                    );
                }
            }
        }
    }
}

/// The busiest streams since the last read, in a sentence.
fn busiest_words() -> String {
    let top = crate::sluice::busiest();
    if top.is_empty() {
        return "No line stream was busy, so the cause is elsewhere — a command or a lock on \
                the main thread."
            .into();
    }
    let parts: Vec<String> = top
        .iter()
        .take(3)
        .map(|(name, emits, items)| format!("{name} {items} items in {emits} emits"))
        .collect();
    format!("Busiest streams: {}.", parts.join(", "))
}
