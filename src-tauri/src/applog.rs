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
//! A bounded ring, an event, and — since 2026-10-19 — a file.
//!
//! **The file is `logs/volery.log` in the app's data folder**, rolled to
//! `volery.old.log` at `FILE_BYTES`, so the whole of it on disk is a few MB and
//! no more. It exists because of the night the wall froze for ten minutes and
//! was restarted: everything this module had heard went with the process, and
//! the only account of what happened was the *Next.js* dev server's own log
//! file, which happened to keep one. A ring is the right reader for a widget
//! and the wrong one for a post-mortem, because the post-mortem is always
//! about a process that is no longer there. `watchdog.rs` writes its stalls
//! here, which is the reading that night needed.
//!
//! Lines leave through a `crate::sluice` — batched, at most ten emits a second
//! — and the file is written by the sluice's own thread, never the logging
//! one, so a `log!` on the main thread costs a lock and a push and no I/O.
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

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
/// Where lines leave for the wall and the file. Set once in `install`; a line
/// logged before it exists is in the ring and nowhere else, as before.
static OUTLET: OnceLock<crate::sluice::Sluice<Line>> = OnceLock::new();

/// How big `volery.log` may grow before it is rolled. Two of them on disk at
/// most: a busy `info` day is a few hundred KB, and the night this was written
/// for would have fitted many times over.
const FILE_BYTES: u64 = 2 * 1024 * 1024;

thread_local! {
    /// See the module note: a logger that logs must not re-enter itself.
    static BUSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

struct Sink {
    /// Per-target ceilings from `SKEIN_LOG`, longest prefix wins.
    targets: Vec<(String, log::LevelFilter)>,
    everything: log::LevelFilter,
}

/// Families held at `warn` unless `SKEIN_LOG` names them. Both are narration
/// at `info` that drowned the file: with the flyway up, iroh logs a
/// `poll_send` per relay packet and `tracing`'s bridge logs every span it
/// enters, several a second between them, so `volery.log` rolled its 2 MB in
/// minutes and a source failure or a watchdog stall was gone before anybody
/// looked (sink 2f64be10). `iroh::endpoint`'s connect lines are kept: they are
/// the flyway's own account of a dial, and arrive once a dial.
const QUIET: &[(&str, log::LevelFilter)] =
    &[("iroh::socket", log::LevelFilter::Warn), ("tracing::span", log::LevelFilter::Warn)];

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
    /* The quiet defaults, unless `SKEIN_LOG` says anything about that family —
       `iroh=debug` names `iroh::socket` as much as `iroh::socket=debug` does,
       and a default that out-ranked it by being the longer prefix would be the
       ordering bug below, wearing a default's coat. */
    for (who, f) in QUIET {
        let named = targets.iter().any(|(t, _): &(String, F)| who.starts_with(t.as_str()) || t.starts_with(who));
        if !named {
            /* Only ever lower: `SKEIN_LOG=off` is off for these too. */
            targets.push((who.to_string(), (*f).min(everything)));
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

        if let Some(out) = OUTLET.get() {
            out.push(line);
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

    let dir = app.path().app_data_dir().ok().map(|d| d.join("logs"));
    let mut file = dir.map(Journal::new);
    let _ = OUTLET.set(crate::sluice::Sluice::open(
        crate::sluice::Spec {
            name: "app:log",
            cap: Some(KEEP),
            period: Duration::from_millis(100),
            flood: None,
        },
        move |lines: Vec<Line>, skipped| {
            /* On the sluice's thread, or a pusher's when it is closed — and
               anything in the emit's path that logs would re-enter this module
               and wait on the lock this closure is called under. The latch
               turns that into a dropped line instead of a deadlock. */
            let was = BUSY.with(|b| b.replace(true));
            if let Some(f) = file.as_mut() {
                f.write(&lines, skipped);
            }
            let _ = app.emit_to("main", "app:log", lines);
            BUSY.with(|b| b.set(was));
        },
        |_, _| {},
    ));
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

/// The newest `warn`-or-worse line from `prefix`, provided it is recent enough
/// to plausibly be about the thing that just happened.
///
/// ### Why a subsystem gets to read the log back
///
/// This module's whole argument is that a dependency's own words are a bug's
/// diagnosis — the block at the top of this file is six librespot lines, each
/// of which *was* the answer to a day's confusion. Until now they were only
/// ever drawn in the log widget, which means the diagnosis reached somebody
/// who already knew to go and look.
///
/// `spotify.rs` is the case that forces the issue. librespot's Spirc task
/// returns `()` and every one of its exit paths logs why immediately before
/// taking it (`starting dealer failed: …`, `Tried too many access points`,
/// `… selected, but none received`) — so the reason exists, is already in this
/// ring, and was being thrown away in favour of a hardcoded sentence. Reading
/// it back is not a second logging mechanism; it is the one we have, asked a
/// question.
///
/// **Bounded in time, and that is the load-bearing part.** A complaint from ten
/// minutes ago is not the explanation for a drop that happened now, and
/// attaching one would manufacture a causal link out of adjacency — a worse
/// failure than saying nothing, because it reads as evidence. `within` is the
/// caller's judgement about its own subject; nothing here guesses it.
pub fn last_complaint(prefix: &str, within: Duration) -> Option<String> {
    let floor = now_ms().saturating_sub(within.as_millis() as u64);
    let ring = RING.lock().ok()?;
    pick_complaint(&ring, prefix, floor)
}

/// The choosing, with the clock and the lock left outside so it can be asserted.
///
/// Newest first, stopping at the first line older than `floor` rather than
/// filtering the whole ring: the ring is in push order, so everything past that
/// point is older still. `warn` and `error` only — `info` is librespot narrating
/// its ordinary progress ("Connecting to AP …"), and the newest such line is
/// almost always something that went *right* just before the thing that went
/// wrong.
fn pick_complaint(ring: &VecDeque<Line>, prefix: &str, floor: u64) -> Option<String> {
    ring.iter()
        .rev()
        .take_while(|l| l.at >= floor)
        .find(|l| matches!(l.level, "error" | "warn") && l.target.starts_with(prefix))
        .map(|l| l.text.clone())
}

/// The log on disk: one file, appended to, rolled once at `FILE_BYTES`.
///
/// Failure anywhere here is silent and permanent for the session — a log that
/// cannot be written is not worth an app that will not run, and there is no
/// better channel to complain through than the one that just failed.
struct Journal {
    dir: std::path::PathBuf,
    out: Option<std::fs::File>,
    size: u64,
}

impl Journal {
    fn new(dir: std::path::PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let mut j = Journal { dir, out: None, size: 0 };
        j.open();
        j
    }

    fn open(&mut self) {
        let path = self.dir.join("volery.log");
        self.out = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
        self.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    }

    fn write(&mut self, lines: &[Line], skipped: usize) {
        use std::io::Write;
        if self.size >= FILE_BYTES {
            self.out = None;
            let _ = std::fs::rename(self.dir.join("volery.log"), self.dir.join("volery.old.log"));
            self.open();
        }
        let Some(out) = self.out.as_mut() else { return };
        let mut text = String::new();
        if skipped > 0 {
            text.push_str(&format!("… {skipped} lines came too fast to keep\n"));
        }
        for l in lines {
            text.push_str(&file_line(l));
        }
        if out.write_all(text.as_bytes()).is_ok() {
            self.size += text.len() as u64;
        }
    }
}

/// One line as the file keeps it: UTC time, level, target, text.
fn file_line(l: &Line) -> String {
    format!("{} {:5} {}: {}\n", stamp(l.at), l.level, l.target, l.text.replace('\n', "\n  "))
}

/// Milliseconds since the epoch as `2026-10-19T06:04:12.345Z`, without a date
/// crate. UTC on purpose: a file read on another machine, or across a daylight
/// change, says one thing. Days to a civil date is Howard Hinnant's
/// `civil_from_days`.
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use log::LevelFilter as F;

    #[test]
    fn a_stamp_is_utc_and_reads_back() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00.000Z");
        /* The night this file was written for: 17:04:12.345 AEDT. */
        assert_eq!(stamp(1_792_389_852_345), "2026-10-19T06:04:12.345Z");
        assert_eq!(stamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn a_file_line_keeps_a_multiline_message_on_its_own_indent() {
        let l = Line { at: 0, level: "warn", target: "skein".into(), text: "a\nb".into() };
        assert_eq!(file_line(&l), "1970-01-01T00:00:00.000Z warn  skein: a\n  b\n");
    }

    #[test]
    fn the_default_is_info_with_the_relay_chatter_held_at_warn() {
        let (everything, targets) = parse_spec("");
        assert_eq!(everything, F::Info);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("iroh::socket::transports"), F::Warn);
        assert_eq!(sink.ceiling("tracing::span"), F::Warn);
        assert_eq!(sink.ceiling("iroh::endpoint"), F::Info, "a dial is still said");
        assert_eq!(sink.ceiling("source"), F::Info);
    }

    #[test]
    fn a_bare_level_raises_everything_but_the_chatter() {
        let (everything, targets) = parse_spec("debug");
        assert_eq!(everything, F::Debug);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("wry::webview"), F::Debug);
        assert_eq!(sink.ceiling("iroh::socket::transports"), F::Warn);
    }

    /// Naming the family, at any breadth, is asking for it — a quiet default
    /// must not out-rank `iroh=debug` by being the longer prefix.
    #[test]
    fn naming_a_quiet_family_lifts_its_default() {
        for spec in ["iroh=debug", "iroh::socket=debug", "iroh::socket::transports=debug"] {
            let (everything, targets) = parse_spec(spec);
            let sink = Sink { targets, everything };
            assert_eq!(sink.ceiling("iroh::socket::transports"), F::Debug, "{spec}");
            assert_eq!(sink.ceiling("tracing::span"), F::Warn, "{spec}");
        }
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
        let (_, quiet) = parse_spec("");
        let (everything, targets) = parse_spec("shouty");
        assert_eq!(everything, F::Info);
        assert_eq!(targets, quiet);

        let (everything, targets) = parse_spec("librespot=shouty");
        assert_eq!(everything, F::Info);
        assert_eq!(targets, quiet, "an unreadable level is not a rule");

        /* Stray separators and whitespace are somebody typing, not an error. */
        let (everything, targets) = parse_spec("  ,, warn , librespot = trace ,");
        assert_eq!(everything, F::Warn);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("librespot_core"), F::Trace);
        assert_eq!(sink.ceiling("rusqlite"), F::Warn);
    }

    #[test]
    fn off_really_is_off() {
        let (everything, targets) = parse_spec("off");
        assert_eq!(everything, F::Off);
        let sink = Sink { targets, everything };
        assert_eq!(sink.ceiling("iroh::socket::transports"), F::Off, "a quiet default never raises");
    }

    /* ── reading the log back ──────────────────────────────────────────────*/

    fn line(at: u64, level: &'static str, target: &str, text: &str) -> Line {
        Line { at, level, target: target.into(), text: text.into() }
    }

    /// The case this exists for, in librespot's own words — the exact line
    /// `.claude/rules/spotify.md` records as the whole diagnosis of the 0.14.4
    /// bug, which the wall was throwing away.
    #[test]
    fn the_newest_complaint_is_the_one_returned() {
        let ring = VecDeque::from(vec![
            line(1_000, "error", "librespot_core::session", "Tried too many access points"),
            line(2_000, "error", "librespot_connect::spirc", "starting dealer failed: No access point available for endpoint dealer"),
        ]);
        assert_eq!(
            pick_complaint(&ring, "librespot", 0).as_deref(),
            Some("starting dealer failed: No access point available for endpoint dealer")
        );
    }

    /// `info` is librespot narrating what is going *right*. Taking the newest
    /// line regardless of level would have answered "Connecting to AP …" — a
    /// true statement and the opposite of a diagnosis.
    #[test]
    fn progress_is_not_a_complaint() {
        let ring = VecDeque::from(vec![
            line(1_000, "error", "librespot_core::session", "Tried too many access points"),
            line(2_000, "info", "librespot_core::session", "Connecting to AP \"ap-gae2.spotify.com:443\""),
        ]);
        assert_eq!(
            pick_complaint(&ring, "librespot", 0).as_deref(),
            Some("Tried too many access points")
        );
    }

    /// The bound that keeps this honest. A complaint from before the window is
    /// not evidence about what just happened, and attaching it would invent a
    /// causal link out of adjacency.
    #[test]
    fn a_stale_complaint_is_not_evidence() {
        let ring = VecDeque::from(vec![line(
            1_000,
            "error",
            "librespot_core::session",
            "Tried too many access points",
        )]);
        assert_eq!(pick_complaint(&ring, "librespot", 5_000), None);
    }

    /// Somebody else's error is not ours. `wry` and `hyper` are noisy and share
    /// the ring.
    #[test]
    fn another_subsystems_error_is_not_borrowed() {
        let ring = VecDeque::from(vec![
            line(2_000, "error", "wry::webview", "something about a webview"),
        ]);
        assert_eq!(pick_complaint(&ring, "librespot", 0), None);
        assert_eq!(
            pick_complaint(&ring, "wry", 0).as_deref(),
            Some("something about a webview")
        );
    }

    /// Silence is a real answer: a clean shutdown complains about nothing, and
    /// the caller must be able to tell that from a diagnosis.
    #[test]
    fn nothing_said_is_none_rather_than_a_guess() {
        assert_eq!(pick_complaint(&VecDeque::new(), "librespot", 0), None);
    }

    /// `take_while` stops at the first line older than the floor, so a ring
    /// whose older half is full of complaints costs nothing to scan — and, more
    /// importantly, cannot reach past the window to find one.
    #[test]
    fn the_scan_stops_at_the_window_rather_than_filtering_past_it() {
        let mut ring = VecDeque::new();
        for at in 0..50 {
            ring.push_back(line(at, "error", "librespot_core::session", "old noise"));
        }
        ring.push_back(line(9_000, "info", "librespot_core::session", "fine"));
        assert_eq!(pick_complaint(&ring, "librespot", 5_000), None);
    }
}
