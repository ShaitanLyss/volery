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
    let page = app.clone();
    let _ = std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || watch(&app));
    let _ = std::thread::Builder::new()
        .name("watchdog-page".into())
        .spawn(move || watch_page(&page));
}

/* ── the page ─────────────────────────────────────────────────────────────── */

/* A main thread that answers is not a wall that is drawing. Every event this
   app emits is handed to WebView2 as a script to run, and handing it over is
   instant — so on 2026-11-03 the loop above stayed quiet for eleven hours while
   the page behind it fell four hours behind the events it had been handed.
   The laptop was in Modern Standby with the screen off; the wake request kept
   `skein.exe` and its cards running, and covers no other process. From another
   wall it read "heard lately" and every spawn timed out at two minutes (sink
   67c3980c), and nothing on this machine said anything at all.

   What starved the page is not settled. It was not Chromium backgrounding it:
   measured in standby the next night, the page still read `visible`, was still
   animating the backdrop (a fifth of a core, and as much again in the GPU
   process) and ran at normal priority with no EcoQoS. This is the instrument
   that says when it happens, how long it lasted, and — in a remote spawn's
   refusal — why the wall did not answer.

   Same shape as the main-thread half: one pulse out, never a second behind an
   unanswered first, so a stalled page costs nothing more than it already is.
   The pulse rides the same queue as every card's events, so how long it takes
   to come back *is* how far behind the wall is. */

/// How often the page is asked.
const PULSE: Duration = Duration::from_secs(5);

/// How long the page may take before it is called behind. Generous for the
/// main-thread half's reason, and then some: a long transcript laid out on
/// first open, or a cold GC, holds a page for a second or two legitimately.
const PAGE_STALL: Duration = Duration::from_secs(30);

/// How long a stall must last to earn a row in the chronicle.
const PAGE_NOTEWORTHY: Duration = Duration::from_secs(60);

struct Pulse {
    seq: u64,
    /// The pulse not yet answered, and when it went.
    out: Option<(u64, Instant)>,
    warned: bool,
}

static PULSE_STATE: std::sync::Mutex<Pulse> =
    std::sync::Mutex::new(Pulse { seq: 0, out: None, warned: false });

/// How long the page has owed an answer, or `None` when it owes none. For a
/// caller explaining why something the page should have done did not happen —
/// a remote spawn that was never reported open is the case that needed it.
pub fn page_quiet() -> Option<Duration> {
    let p = PULSE_STATE.lock().ok()?;
    p.out.map(|(_, sent)| sent.elapsed()).filter(|d| *d >= PAGE_STALL)
}

/// `page_quiet` in words, for the end of a sentence that already says what
/// did not happen. Empty when the page is keeping up.
pub fn page_quiet_words() -> String {
    match page_quiet() {
        Some(d) => format!(
            " This wall's window has not answered for {} — it is asleep or stalled, so \
             nothing it is handed is being done.",
            spoken(d)
        ),
        None => String::new(),
    }
}

fn spoken(d: Duration) -> String {
    let s = d.as_secs();
    if s < 120 {
        format!("{s}s")
    } else if s < 7200 {
        format!("{}m", s / 60)
    } else {
        format!("{}h{:02}m", s / 3600, (s / 60) % 60)
    }
}

fn watch_page(app: &AppHandle) {
    use tauri::Emitter;
    std::thread::sleep(SETTLE);
    loop {
        std::thread::sleep(PULSE);
        let send = {
            let Ok(mut p) = PULSE_STATE.lock() else { return };
            match p.out {
                Some((_, sent)) => {
                    let late = sent.elapsed();
                    if late >= PAGE_STALL && !p.warned {
                        p.warned = true;
                        log::warn!(
                            "the window has not answered for {}s — the main thread is answering, so \
                             the page itself is behind: every card's events are queued and none is \
                             being drawn or acted on.",
                            late.as_secs()
                        );
                    }
                    None
                }
                None => {
                    p.seq += 1;
                    p.out = Some((p.seq, Instant::now()));
                    Some(p.seq)
                }
            }
        };
        if let Some(seq) = send {
            if app.emit_to("main", "volery:pulse", seq).is_err() {
                return;
            }
        }
    }
}

/// The page answering a pulse. A stale or repeated answer is ignored, so a
/// page catching up on a backlog settles the books once.
#[tauri::command]
pub fn pulse_back(app: AppHandle, seq: u64) {
    let (lasted, warned) = {
        let Ok(mut p) = PULSE_STATE.lock() else { return };
        let Some((out, sent)) = p.out else { return };
        if out != seq {
            return;
        }
        let warned = p.warned;
        p.out = None;
        p.warned = false;
        (sent.elapsed(), warned)
    };
    if !warned {
        return;
    }
    log::warn!("the window answered again after {}.", spoken(lasted));
    if lasted >= PAGE_NOTEWORTHY {
        crate::chronicle::note(
            &app,
            None,
            "volery",
            "bad",
            &format!("the window fell {} behind", spoken(lasted)),
            "Volery itself kept running and its cards kept working; the page that draws them \
             and acts on what they send was not keeping up, so nothing reached the wall or \
             another wall in that time.",
        );
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stall_is_said_in_the_unit_a_person_reads_it_in() {
        assert_eq!(spoken(Duration::from_secs(45)), "45s");
        assert_eq!(spoken(Duration::from_secs(119)), "119s");
        assert_eq!(spoken(Duration::from_secs(150)), "2m");
        assert_eq!(spoken(Duration::from_secs(4 * 3600 + 5 * 60)), "4h05m");
    }
}
