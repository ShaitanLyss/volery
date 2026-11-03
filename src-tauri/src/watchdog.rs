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
   process) and ran at normal priority with no EcoQoS. So whatever the cause,
   this both says when it happens — in the log, the chronicle and a remote
   spawn's refusal — and gets the wall back by itself (the ladder below).

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

/* ── and what is done about it ────────────────────────────────────────────
   Lyss, the morning after: "I want this to never happen again … the rust side
   could identify that the window is dead and restart it." Reporting a dead
   window is half a fix; the other half is a ladder, each rung cheaper to be
   wrong about than staying stuck:

   1. **Reload the page** once it has owed an answer for `RELOAD_AFTER`. The
      page holds nothing that is not on disk or in Rust — the wall is painted
      from SQLite, the scrollback from the transcripts, and a card that has a
      process answers a wake with `already` (`Skein.#spawnNow`), so rousing
      prompts nobody. What a reload loses is the backlog of events the page had
      not yet folded, which is exactly the thing that was hours stale.
   2. **Restart Volery** if the reloaded page has still not answered after
      `RESTART_AFTER`. The exit handler marks what was mid-turn and the next
      launch rouses it, which is what a person closing and reopening the wall
      would have got — the gesture that did fix it, nine hours late.

   Bounded so a sick machine cannot make it loop: a restart is not done again
   within `REVIVE_GAP` of the last one this watchdog made (the time rides into
   the new process as `VOLERY_REVIVED_AT`), and inside that gap the page is
   only reloaded, at most every `RELOAD_AGAIN`. `SKEIN_NO_REVIVE=1` turns both
   rungs off — a page paused in DevTools is a page not answering. */

/// How long the page may owe an answer before it is reloaded.
const RELOAD_AFTER: Duration = Duration::from_secs(60);

/// How long a reloaded page may stay silent before Volery restarts.
const RESTART_AFTER: Duration = Duration::from_secs(60);

/// Inside `REVIVE_GAP`, how often a page that is still not answering is
/// reloaded again instead.
const RELOAD_AGAIN: Duration = Duration::from_secs(5 * 60);

/// The least time between two restarts this watchdog makes.
const REVIVE_GAP: Duration = Duration::from_secs(30 * 60);

/// How long the main thread may not answer before Volery restarts. Longer
/// than the page's: nothing cheaper can be tried first, since a reload is
/// itself work for the thread that is not answering.
const MAIN_REVIVE: Duration = Duration::from_secs(120);

/// What to do about a page that owes an answer. Pure, so the ladder is tested
/// rather than trusted.
#[derive(Debug, PartialEq, Eq)]
enum Rung {
    Nothing,
    Warn,
    Reload,
    Restart,
}

/// `late`: how long the oldest unanswered pulse has waited. `reloaded`: how
/// long ago this stall's last reload was, if there was one.
fn rung(late: Duration, warned: bool, reloaded: Option<Duration>, may_restart: bool) -> Rung {
    match reloaded {
        None if late >= RELOAD_AFTER => Rung::Reload,
        Some(r) if r >= RESTART_AFTER && may_restart => Rung::Restart,
        Some(r) if r >= RELOAD_AGAIN => Rung::Reload,
        _ if late >= PAGE_STALL && !warned => Rung::Warn,
        _ => Rung::Nothing,
    }
}

struct Pulse {
    seq: u64,
    /// The oldest pulse not yet answered, and when it went.
    out: Option<(u64, Instant)>,
    warned: bool,
    /// When this stall's page was last reloaded.
    reloaded: Option<Instant>,
}

static PULSE_STATE: std::sync::Mutex<Pulse> =
    std::sync::Mutex::new(Pulse { seq: 0, out: None, warned: false, reloaded: None });

/// Whether the rungs may act at all.
fn reviving() -> bool {
    std::env::var("SKEIN_NO_REVIVE").as_deref() != Ok("1")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether a restart may be made now: on, and not within `REVIVE_GAP` of the
/// last one this watchdog made, in this process or the one before it.
fn may_restart() -> bool {
    if !reviving() {
        return false;
    }
    let last = std::env::var("VOLERY_REVIVED_AT").ok().and_then(|v| v.parse::<u64>().ok());
    match last {
        Some(at) => now_ms().saturating_sub(at) >= REVIVE_GAP.as_millis() as u64,
        None => true,
    }
}

static RESTARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Start this wall again, saying why in the new process's first chronicle row.
/// `graceful` asks the event loop to exit, so the exit handler marks what was
/// mid-turn and stops every child; without it — the loop itself is what has
/// stopped — the process ends here, the job objects take the children with it,
/// and `set_mid_turn` has already written what a crash would lose.
fn restart(app: &AppHandle, why: String, graceful: bool) {
    if RESTARTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    log::warn!("restarting Volery: {why}");
    let env = [("VOLERY_REVIVED_AT", now_ms().to_string()), ("VOLERY_REVIVED_WHY", why)];
    if let Err(e) = crate::update::relaunch_after_exit(&env) {
        log::warn!("could not restart Volery ({e}), so it stays up as it is");
        RESTARTING.store(false, std::sync::atomic::Ordering::SeqCst);
        return;
    }
    log::logger().flush();
    if graceful {
        app.exit(0);
        /* An exit that never lands is the same stuck wall; this one ends it. */
        std::thread::sleep(Duration::from_secs(20));
    }
    std::process::exit(0);
}

/// Said once by the process a restart started, when there is a store to say
/// it in.
fn say_why_revived(app: &AppHandle) {
    let Ok(why) = std::env::var("VOLERY_REVIVED_WHY") else { return };
    std::env::remove_var("VOLERY_REVIVED_WHY");
    crate::chronicle::note(
        app,
        None,
        "volery",
        "bad",
        "volery restarted itself",
        &format!(
            "{why} Cards that were mid-turn were picked up again, and cards that were awake are awake."
        ),
    );
}
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
             nothing it is handed is being done; it reloads itself at {}s and Volery \
             restarts if that does not bring it back.",
            spoken(d),
            RELOAD_AFTER.as_secs()
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
    use tauri::{Emitter, Manager};
    std::thread::sleep(SETTLE);
    say_why_revived(app);
    loop {
        std::thread::sleep(PULSE);
        let (send, act, late) = {
            let Ok(mut p) = PULSE_STATE.lock() else { return };
            match p.out {
                None => {
                    p.seq += 1;
                    p.out = Some((p.seq, Instant::now()));
                    (Some(p.seq), Rung::Nothing, Duration::ZERO)
                }
                Some((_, since)) => {
                    let late = since.elapsed();
                    let mut act = rung(late, p.warned, p.reloaded.map(|r| r.elapsed()), may_restart());
                    if !reviving() && act == Rung::Reload {
                        /* Revival switched off: warn, and nothing more. */
                        act = if p.warned { Rung::Nothing } else { Rung::Warn };
                    }
                    match act {
                        Rung::Warn => p.warned = true,
                        Rung::Reload => {
                            p.warned = true;
                            p.reloaded = Some(Instant::now());
                        }
                        _ => {}
                    }
                    /* A reloaded page never got the pulse its predecessor
                       owed, so it is asked afresh every beat; the answer to
                       any of them settles the stall. Before a reload there is
                       never a second pulse behind the first. */
                    let send = p.reloaded.is_some().then(|| {
                        p.seq += 1;
                        p.seq
                    });
                    (send, act, late)
                }
            }
        };
        match act {
            Rung::Nothing => {}
            Rung::Warn => log::warn!(
                "the window has not answered for {}s — the main thread is answering, so the page \
                 itself is behind: every card's events are queued and none is being drawn or acted on.",
                late.as_secs()
            ),
            Rung::Reload => {
                log::warn!("the window has not answered for {}, so it is being reloaded.", spoken(late));
                crate::chronicle::note(
                    app,
                    None,
                    "volery",
                    "bad",
                    &format!("the window stopped answering for {}, so it was reloaded", spoken(late)),
                    "Volery and its cards kept running; the page that draws them had stopped keeping \
                     up, and a reload puts it back on what is current. Anything it had not yet drawn \
                     is read again from the store and the transcripts.",
                );
                match app.get_webview_window("main") {
                    Some(w) => {
                        if let Err(e) = w.reload() {
                            log::warn!("the window could not be reloaded: {e}");
                        }
                    }
                    None => log::warn!("there is no main window to reload"),
                }
            }
            Rung::Restart => restart(
                app,
                format!(
                    "The window stopped answering for {} and a reload did not bring it back.",
                    spoken(late)
                ),
                true,
            ),
        }
        if let Some(seq) = send {
            if app.emit_to("main", "volery:pulse", seq).is_err() {
                return;
            }
        }
    }
}

/// The page answering a pulse. Any answer at or after the oldest one owed
/// settles the stall — a reloaded page answers only the pulses it was sent —
/// and an older or repeated one is ignored, so a page catching up on a backlog
/// settles the books once.
#[tauri::command]
pub fn pulse_back(app: AppHandle, seq: u64) {
    let (lasted, warned, reloaded) = {
        let Ok(mut p) = PULSE_STATE.lock() else { return };
        let Some((first, sent)) = p.out else { return };
        if seq < first {
            return;
        }
        let warned = p.warned;
        let reloaded = p.reloaded.is_some();
        p.out = None;
        p.warned = false;
        p.reloaded = None;
        (sent.elapsed(), warned, reloaded)
    };
    if !warned {
        return;
    }
    if reloaded {
        log::warn!("the reloaded window is answering, {} after the stall began.", spoken(lasted));
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
                   queue, and its arrival is the end of the stall. Past
                   `MAIN_REVIVE` nothing in this process can be trusted to
                   unstick it — every gesture and every event waits on the
                   thread that is not answering — so it is restarted. */
                loop {
                    match rx.recv_timeout(Duration::from_secs(1)) {
                        Ok(()) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => {
                            if sent.elapsed() >= MAIN_REVIVE && may_restart() {
                                restart(
                                    app,
                                    format!(
                                        "The main thread stopped answering for {}, so nothing on \
                                         the wall was drawn and no command was answered. {}",
                                        spoken(sent.elapsed()),
                                        busiest_words()
                                    ),
                                    false,
                                );
                            }
                        }
                    }
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
    fn the_ladder_warns_then_reloads_then_restarts() {
        let s = Duration::from_secs;
        assert_eq!(rung(s(10), false, None, true), Rung::Nothing);
        assert_eq!(rung(s(31), false, None, true), Rung::Warn);
        assert_eq!(rung(s(45), true, None, true), Rung::Nothing);
        assert_eq!(rung(s(61), true, None, true), Rung::Reload);
        assert_eq!(rung(s(61), false, None, true), Rung::Reload, "a reload says so itself");
        assert_eq!(rung(s(90), true, Some(s(30)), true), Rung::Nothing, "the reload gets its minute");
        assert_eq!(rung(s(125), true, Some(s(61)), true), Rung::Restart);
    }

    #[test]
    fn inside_the_gap_a_dead_page_is_only_reloaded_and_not_every_beat() {
        let s = Duration::from_secs;
        assert_eq!(rung(s(125), true, Some(s(61)), false), Rung::Nothing);
        assert_eq!(rung(s(400), true, Some(s(299)), false), Rung::Nothing);
        assert_eq!(rung(s(400), true, Some(s(301)), false), Rung::Reload);
    }

    #[test]
    fn a_stall_is_said_in_the_unit_a_person_reads_it_in() {
        assert_eq!(spoken(Duration::from_secs(45)), "45s");
        assert_eq!(spoken(Duration::from_secs(119)), "119s");
        assert_eq!(spoken(Duration::from_secs(150)), "2m");
        assert_eq!(spoken(Duration::from_secs(4 * 3600 + 5 * 60)), "4h05m");
    }
}
