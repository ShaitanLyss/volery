//! The app's own log — everything this process and its dependencies say about
//! themselves, which until now went nowhere at all.
//!
//! ### Why this exists, in one afternoon's worth of evidence
//!
//! `grep -rn "env_logger\|tauri_plugin_log\|log::set" src-tauri/src` used to find
//! two comments about *other programs'* loggers and no logger of our own. So
//! every `info!`, `warn!` and `error!` in every dependency was compiled in,
//! formatted, and dropped on the floor. The app is `windows_subsystem =
//! "windows"`, so even a stderr fallback goes nowhere.
//!
//! On 2026-08-28 that cost a day. Spotify would not connect, and librespot was
//! saying exactly why, on a 21-second cadence, the whole time:
//!
//! ```text
//! INFO  Connecting to AP "ap-gae2.spotify.com:4070"
//! DEBUG Connection to "ap-gae2.spotify.com:4070" failed: ... (os error 10060)
//! ERROR Tried too many access points
//! ERROR starting dealer failed: No access point available for endpoint dealer
//! WARN  SpircCommand::Load(..) will be ignored while Not Active
//! DEBUG Input volume 32767 mapped to: 3.16%
//! ```
//!
//! Every one of those lines is a bug's whole diagnosis, and recovering them took
//! a throwaway cargo crate and four browser sign-ins from the user. The last two
//! are the ones that sting: *"ignored while Not Active"* was a tool reporting
//! success while nothing played, and *"mapped to: 3.16%"* was the answer to "why
//! is it so quiet" sitting in a line nobody could read.
//!
//! ### What it is, and the bound that keeps it honest
//!
//! A bounded ring and an event. Not a file — see the note at the bottom about
//! the half this deliberately does not do yet.
//!
//! **`KEEP` lines and no more.** A log that grows is a leak with a heartbeat on
//! a wall left open for days, and the rule this app already follows for the same
//! shape is `logface`'s: what you can read is what the box fits, and reaching
//! further back is a different tool's job.
//!
//! **`Info` by default**, which is not timidity: every line quoted above is
//! `info` or worse except the two `debug`s, and `debug` across this dependency
//! graph is thousands of lines a second from `wry` alone. `SKEIN_LOG` raises it
//! when somebody is actually looking — `SKEIN_LOG=debug`, or
//! `SKEIN_LOG=librespot=debug` to raise one target and leave the rest alone,
//! which is what you want nine times in ten.
//!
//! ### Two traps this had to avoid, both of which are silent
//!
//! **A logger that logs is a stack overflow.** `app.emit` runs through Tauri and
//! `serde`, and anything in that path that reaches for `log!` re-enters this
//! function on the same thread. `BUSY` is a thread-local latch, not a mutex: a
//! mutex would deadlock rather than recurse, which is worse because it takes the
//! thread with it.
//!
//! **The ring must never be held across the emit.** `emit` is not ours and its
//! cost is not knowable from here; holding the lock across it would put every
//! logging thread in the process behind whatever Tauri is doing. The line is
//! cloned out and the guard dropped first, which is the same discipline
//! `off_main` exists for one layer up.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// How many lines are kept for a face that mounts late.
///
/// Two thousand is about a minute of a busy `debug` session and hours of an
/// ordinary `info` one. The number matters less than the fact that there is one.
const KEEP: usize = 2000;

/// One line, as the wall draws it.
#[derive(Debug, Clone, Serialize)]
pub struct Line {
    /// Milliseconds since the epoch. Stamped here rather than in the front end
    /// because a line's time is when it was *said*, and an event can queue.
    pub at: u64,
    /// `error` | `warn` | `info` | `debug` | `trace`, lowercased for the wall's
    /// voice and because `applog.ts` matches on it.
    pub level: &'static str,
    /// The emitting module path — `librespot_core::session`, and so on. What
    /// makes a line filterable, and the only reason this is not one string.
    pub target: String,
    pub text: String,
}

static RING: Mutex<VecDeque<Line>> = Mutex::new(VecDeque::new());
static APP: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    /// See the module note: a logger that logs must not re-enter itself.
    static BUSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct Sink {
    /// Per-target ceilings from `SKEIN_LOG`, longest prefix wins.
    targets: Vec<(String, log::LevelFilter)>,
    everything: log::LevelFilter,
}

/// Read `SKEIN_LOG` into a default and a set of per-target ceilings.
///
/// `SKEIN_LOG=debug` raises everything. `SKEIN_LOG=librespot=debug` raises one
/// family and leaves the rest at the default, which is the shape actually
/// wanted: the whole graph at `debug` is unreadable, and the question is nearly
/// always about one subsystem.
///
/// Pure and asserted, because it is the difference between a log that answers
/// the question and one that buries it, and because a spec nobody can test is a
/// spec that quietly means something else.
fn parse_spec(spec: &str) -> (log::LevelFilter, Vec<(String, log::LevelFilter)>) {
    use log::LevelFilter as F;
    let level = |s: &str| -> Option<F> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Some(F::Off),
            "error" => Some(F::Error),
            "warn" | "warning" => Some(F::Warn),
            "info" => Some(F::Info),
            "debug" => Some(F::Debug),
            "trace" => Some(F::Trace),
            _ => None,
        }
    };

    let mut everything = F::Info;
    let mut targets = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.split_once('=') {
            Some((who, what)) => {
                if let Some(f) = level(what) {
                    targets.push((who.trim().to_string(), f));
                }
            }
            None => {
                if let Some(f) = level(part) {
                    everything = f;
                }
            }
        }
    }
    /* Longest first, so `librespot_core::session=warn` beats `librespot=debug`
       rather than losing to whichever happened to be written first. */
    targets.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    (everything, targets)
}

impl Sink {
    fn ceiling(&self, target: &str) -> log::LevelFilter {
        self.targets
            .iter()
            .find(|(who, _)| target.starts_with(who.as_str()))
            .map(|(_, f)| *f)
            .unwrap_or(self.everything)
    }
}

impl log::Log for Sink {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= self.ceiling(meta.target())
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if BUSY.with(|b| b.replace(true)) {
            return; /* re-entered from inside the emit below. */
        }

        let line = Line {
            at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            level: match record.level() {
                log::Level::Error => "error",
                log::Level::Warn => "warn",
                log::Level::Info => "info",
                log::Level::Debug => "debug",
                log::Level::Trace => "trace",
            },
            target: record.target().to_string(),
            text: record.args().to_string(),
        };

        /* Pushed and the guard dropped *before* the emit — see the module note
           on why the lock must not span it. */
        if let Ok(mut ring) = RING.lock() {
            ring.push_back(line.clone());
            while ring.len() > KEEP {
                ring.pop_front();
            }
        }

        if let Some(app) = APP.get() {
            let _ = app.emit("app:log", line);
        }

        BUSY.with(|b| b.set(false));
    }

    fn flush(&self) {}
}

/// Install the sink. Called once, from `setup`, as early as it can be.
///
/// Early matters: anything logged before this lands nowhere, and the interesting
/// failures at launch are exactly the ones a person cannot reproduce on demand.
///
/// Failure here is deliberately not fatal and not even reported. `set_boxed_logger`
/// refuses only if something already installed a logger, which in this process
/// means this ran twice — and an app that would not start because it could not
/// set up *logging* has its priorities backwards.
pub fn install(app: AppHandle) {
    let spec = std::env::var("SKEIN_LOG").unwrap_or_default();
    let (everything, targets) = parse_spec(&spec);

    let ceiling = targets
        .iter()
        .map(|(_, f)| *f)
        .chain(std::iter::once(everything))
        .max()
        .unwrap_or(log::LevelFilter::Info);

    let _ = APP.set(app);
    if log::set_boxed_logger(Box::new(Sink { targets, everything })).is_ok() {
        /* The global max is the *loosest* of the ceilings, because it is a
           cheap pre-filter in front of `enabled` rather than a policy of its
           own — setting it to the default would silently discard a target
           somebody raised. */
        log::set_max_level(ceiling);
        log::info!(
            "volery {} — log sink installed ({})",
            env!("CARGO_PKG_VERSION"),
            if spec.is_empty() {
                "info; set SKEIN_LOG to raise it".to_string()
            } else {
                format!("SKEIN_LOG={spec}")
            }
        );
    }
}

/// What has been said so far, for a face that mounted late.
///
/// The same bargain `spotify_status` strikes and for the same reason: events are
/// only useful to something that was listening, and a log widget hung on the
/// wall after the interesting thing happened would otherwise draw an empty box
/// about a process that has been talking for hours.
#[tauri::command]
pub fn app_log() -> Vec<Line> {
    RING.lock().map(|r| r.iter().cloned().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::LevelFilter as F;

    #[test]
    fn the_default_is_info_and_nothing_else() {
        let (everything, targets) = parse_spec("");
        assert_eq!(everything, F::Info);
        assert!(targets.is_empty());
    }

    #[test]
    fn a_bare_level_raises_everything() {
        let (everything, targets) = parse_spec("debug");
        assert_eq!(everything, F::Debug);
        assert!(targets.is_empty());
    }

    /// The shape actually wanted: one subsystem loud, the rest quiet. `debug`
    /// across this dependency graph is thousands of lines a second from `wry`.
    #[test]
    fn one_target_can_be_raised_alone() {
        let (everything, targets) = parse_spec("librespot=debug");
        assert_eq!(everything, F::Info);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("librespot_core::session"), F::Debug);
        assert_eq!(sink.ceiling("wry::webview"), F::Info);
    }

    /// Longest prefix wins, so a narrower rule is not defeated by the order it
    /// was written in — which is the bug a naive `find` on an unsorted list has.
    #[test]
    fn the_more_specific_target_wins_whichever_order_it_is_written() {
        for spec in [
            "librespot=debug,librespot_core::session=warn",
            "librespot_core::session=warn,librespot=debug",
        ] {
            let (everything, targets) = parse_spec(spec);
            let sink = Sink { targets, everything };
            assert_eq!(sink.ceiling("librespot_core::session"), F::Warn, "{spec}");
            assert_eq!(sink.ceiling("librespot_playback::player"), F::Debug, "{spec}");
        }
    }

    /// A spec is read off an environment variable, so every way of getting it
    /// wrong has to degrade to something rather than refusing to start.
    #[test]
    fn nonsense_leaves_the_default_standing() {
        let (everything, targets) = parse_spec("shouty");
        assert_eq!(everything, F::Info);
        assert!(targets.is_empty());

        let (everything, targets) = parse_spec("librespot=shouty");
        assert_eq!(everything, F::Info);
        assert!(targets.is_empty(), "an unreadable level is not a rule");

        /* Stray separators and whitespace are somebody typing, not an error. */
        let (everything, targets) = parse_spec("  ,, warn , librespot = trace ,");
        assert_eq!(everything, F::Warn);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("librespot_core"), F::Trace);
        assert_eq!(sink.ceiling("rusqlite"), F::Warn);
    }

    #[test]
    fn off_really_is_off() {
        let (everything, _) = parse_spec("off");
        assert_eq!(everything, F::Off);
    }
}
