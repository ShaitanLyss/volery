//! `spend`: what this card has used, and a warning it sets on itself.
//!
//! `docs/ANALYTICS.md` §11.13 is the design and §17 is the table. The wall has
//! plenty of faces that read *everybody's* spend; this is the other direction,
//! and it is the one an agent can act on: an agent deciding whether to fan out
//! ten subagents, compact its context or stop, asked what it had spent and was
//! told about the account rather than about itself. `allowance` keeps its job
//! (the account's own windows, `limits.rs`); this answers *this card's* turns,
//! its subagents and the turn it is in.
//!
//! Four verbs across two tools, §11.13's vocabulary:
//!
//! ```text
//! spend read [children]                    -- what this card has used
//! spend list                               -- the watches on this card
//! spend_watch watch <measure> <at> [period] [scope]
//! spend_watch unwatch <id>
//! ```
//!
//! **Two tools rather than one because of plan mode.** `read` and `list` are
//! advertised with `readOnlyHint`, which is what lets a planning card use them ,
//! and a planning card working out what it can afford is exactly who this is
//! for. `watch` writes a row and, on breach, a notice, so it cannot carry that
//! hint; `ask.rs` asserts both directions of its read-only list, so one tool
//! cannot be both. The split is recorded in §11.13.
//!
//! **A watch is a bookmark, not a brake.** On breach it writes one notice for
//! the person and marks the period instance; it never stops, pauses or slows
//! anything. A threshold that could halt work would be a second allowance gate
//! nobody configured, and the first one already exists.
//!
//! **The tool reads only this card's rows**, by construction rather than by a
//! check: every statement is scoped by the conversation id the MCP request
//! arrived under, the session ids `analytics_session` attributes to it, and the
//! cards it opened when `children` is asked for. The ingest's breach pass is the
//! one reader that is not the tool's: it evaluates the watches of the cards
//! whose facts the pass just wrote, and writes each watch's own row.
//!
//! ## The one place Rust prices anything
//!
//! `usage.rs`'s rule is that Rust never prices: the front end turns tokens into
//! dollars through `usage.ts`, a table that went stale by a month once and was
//! corrected twice. This tool is the exception, and it is forced rather than
//! chosen: a `usd` watch is enforced during ingest, inside this process, and a
//! breach cannot be decided anywhere but here. The table itself did not move
//! into the Rust: `pricing.json` beside `usage.ts` is read by both, here with
//! `include_str!`, so the two dollars are the same dollars by construction.
//! §20's decision entry records the reversal and what holds it to one table.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

use crate::store::{SpendWatch, Store};

pub const SPEND_TOOL: &str = "spend";
/// The write half of §11.13. A second tool because a read-only annotation is a
/// promise plan mode relies on; see `handle`.
pub const SPEND_WATCH_TOOL: &str = "spend_watch";

/// The price table, the clock and the family guesses, shared with `usage.ts`.
const PRICING: &str = include_str!("../../src/lib/pricing.json");

/// How many tokens one `spend read` will estimate `next_turn_usd` from, and how
/// much of the transcript tail it scans to find the context. Both are bounds on
/// a single card's own file, and neither can grow with the wall.
const CONTEXT_TAIL_BYTES: u64 = 256 * 1024;

/// A notice's body is one line and a sentence. The cap is the notice tool's own
/// shape rather than this tool's judgement, and it is applied through
/// `clip::keep` like every other stored text.
const NOTICE_MAX: usize = 600;

/* ── the rules: pure, and lifted by `tools/lift-spend.ts` ──────────────────*/

/// Everything here takes and returns plain values. `Mod` is a Rust keyword, so
/// the module name is `rules`.
pub(crate) mod rules {
    /// What a watch is a threshold on. `docs/ANALYTICS.md` §11.13's vocabulary.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Measure {
        Usd,
        Tokens,
        AllowancePoints,
    }

    impl Measure {
        pub(crate) fn key(self) -> &'static str {
            match self {
                Measure::Usd => "usd",
                Measure::Tokens => "tokens",
                Measure::AllowancePoints => "allowance_points",
            }
        }
    }

    impl std::str::FromStr for Measure {
        type Err = String;
        fn from_str(s: &str) -> Result<Self, Self::Err> {
            match s.trim() {
                "usd" => Ok(Measure::Usd),
                "tokens" => Ok(Measure::Tokens),
                "allowance_points" => Ok(Measure::AllowancePoints),
                other => Err(format!(
                    "`{other}` is not a measure this tool watches. Use `usd`, `tokens` or \
                     `allowance_points`."
                )),
            }
        }
    }

    /// The stretch a threshold is measured over.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Period {
        Session,
        Day,
        Turn,
        Window,
    }

    impl Period {
        pub(crate) fn key(self) -> &'static str {
            match self {
                Period::Session => "session",
                Period::Day => "day",
                Period::Turn => "turn",
                Period::Window => "window",
            }
        }

        /// How the period reads at the end of a notice: *this session*, *today*.
        pub(crate) fn phrase(self) -> &'static str {
            match self {
                Period::Session => "this session",
                Period::Day => "today",
                Period::Turn => "this turn",
                Period::Window => "this window",
            }
        }
    }

    impl std::str::FromStr for Period {
        type Err = String;
        fn from_str(s: &str) -> Result<Self, Self::Err> {
            match s.trim() {
                "session" => Ok(Period::Session),
                "day" => Ok(Period::Day),
                "turn" => Ok(Period::Turn),
                "window" => Ok(Period::Window),
                other => Err(format!(
                    "`{other}` is not a period. Use `session` (the default), `day`, `turn` or \
                     `window` (`window` only with `allowance_points`)."
                )),
            }
        }
    }

    /// Whose spend counts. `self` is the card's own sessions; `self+children`
    /// adds the cards it opened, which are sessions of their own (§4.4).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Scope {
        SelfOnly,
        WithChildren,
    }

    impl Scope {
        pub(crate) fn key(self) -> &'static str {
            match self {
                Scope::SelfOnly => "self",
                Scope::WithChildren => "self+children",
            }
        }

        pub(crate) fn with_children(self) -> bool {
            self == Scope::WithChildren
        }
    }

    impl std::str::FromStr for Scope {
        type Err = String;
        fn from_str(s: &str) -> Result<Self, Self::Err> {
            match s.trim() {
                "self" => Ok(Scope::SelfOnly),
                "self+children" | "children" => Ok(Scope::WithChildren),
                other => Err(format!(
                    "`{other}` is not a scope. Use `self` (the default) or `self+children`."
                )),
            }
        }
    }

    /// **A measure and a period that cannot be answered together is refused at
    /// the write, not left to fire never.** An `allowance_points` reading is a
    /// share of one allowance window's delta (§5.2), so it only exists for
    /// `window`; tokens and dollars are this card's own and exist for the three
    /// periods that have an instance. A watch that could not fire is worse than
    /// a refusal: it reads as protection and provides none.
    pub(crate) fn answerable(measure: Measure, period: Period) -> Result<(), String> {
        match (measure, period) {
            (Measure::AllowancePoints, Period::Window) => Ok(()),
            (Measure::AllowancePoints, _) => Err(
                "`allowance_points` is a share of one allowance window, so its period is \
                 `window`. For this card's own spend use `usd` or `tokens`."
                    .into(),
            ),
            (_, Period::Window) => Err(
                "a `window` period is the account's allowance window and is answered in \
                 `allowance_points` only. Use `session`, `day` or `turn` for `usd` and `tokens`."
                    .into(),
            ),
            _ => Ok(()),
        }
    }

    /// The identifiers a period instance is named by.
    ///
    /// It is a value rather than a query so the once-per-instance rule can be
    /// asserted without a store: a rolling day restarts because the label
    /// changes, and nothing has to run at midnight.
    #[derive(Clone, Debug, Default)]
    pub(crate) struct PeriodKeys {
        /// The card's current agent session, or `''` for a card that has never
        /// taken a turn.
        pub(crate) session: String,
        /// `YYYY-MM-DD` on the local calendar, which is the wall's day and not
        /// UTC's (§11.13).
        pub(crate) day: String,
        /// The open turn's row id, if one is running.
        pub(crate) turn: Option<i64>,
        /// The current allowance window's `resets_at`, if the wall keeps one.
        pub(crate) window: Option<String>,
    }

    /// The period instance a value is measured over, or `None` when that
    /// period has no instance right now.
    ///
    /// **A day watch restarts by itself.** The string changes when the calendar
    /// does, so there is no timer and no cron: the next evaluation compares a
    /// different key and fires again. The same is true of a session (a cleared
    /// card gets a new id), a turn (a new row id) and a window (a reset stamp).
    pub(crate) fn instance_key(period: Period, keys: &PeriodKeys) -> Option<String> {
        match period {
            Period::Session => Some(format!(
                "session:{}",
                if keys.session.is_empty() { "-" } else { &keys.session }
            )),
            Period::Day => Some(format!("day:{}", keys.day)),
            Period::Turn => keys.turn.map(|id| format!("turn:{id}")),
            Period::Window => keys.window.as_ref().map(|w| format!("window:{w}")),
        }
    }

    /// Whether a value has passed its threshold. Strictly greater: *when I pass
    /// ten dollars* means ten is not over.
    pub(crate) fn breached(at_value: f64, value: f64) -> bool {
        value.is_finite() && at_value.is_finite() && value > at_value
    }

    /// `$10.40`, two places above a dollar, four below it, so a fraction of a
    /// cent is not rounded into a number that looks like a measurement.
    pub(crate) fn usd_said(v: f64) -> String {
        if v >= 1.0 {
            format!("${v:.2}")
        } else {
            format!("${v:.4}")
        }
    }

    /// A threshold as the card wrote it. `10.0` reads `$10`, not `$10.00`.
    pub(crate) fn threshold_said(measure: Measure, at: f64) -> String {
        match measure {
            Measure::Usd => {
                if (at.fract()).abs() < 1e-9 {
                    format!("${}", at.trunc() as i64)
                } else {
                    usd_said(at)
                }
            }
            Measure::Tokens => tokens_said(at.max(0.0) as i64),
            Measure::AllowancePoints => format!("{}", trim1(at)),
        }
    }

    fn trim1(v: f64) -> String {
        let s = format!("{v:.1}");
        s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
    }

    /// `1.2M`, `84k`, `312`. The same scale `usage.ts` uses for a count, kept
    /// here rather than imported because the reader is a model and the unit has
    /// to be in the same string as the number.
    pub(crate) fn tokens_said(n: i64) -> String {
        let n = n.max(0);
        if n >= 1_000_000 {
            let m = format!("{:.1}", n as f64 / 1e6);
            format!("{}M", m.strip_suffix(".0").unwrap_or(&m))
        } else if n >= 1_000 {
            format!("{}k", n / 1_000)
        } else {
            n.to_string()
        }
    }

    /// One line, in the card's own words: `$10.40 of $10, this session`.
    pub(crate) fn breach_line(
        measure: Measure,
        value: f64,
        at: f64,
        period: Period,
        scope: Scope,
    ) -> String {
        let measured = match measure {
            Measure::Usd => usd_said(value),
            Measure::Tokens => format!("{} tokens", tokens_said(value as i64)),
            Measure::AllowancePoints => format!("{} points", trim1(value)),
        };
        let mut line = format!(
            "{measured} of {}, {}",
            threshold_said(measure, at),
            period.phrase()
        );
        if scope.with_children() {
            line.push_str(", with the cards it opened");
        }
        line
    }

    /* ── the price table ──────────────────────────────────────────────────*/

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(crate) struct OffPeak {
        pub(crate) input: f64,
        pub(crate) output: f64,
        pub(crate) cache_read: Option<f64>,
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(crate) struct Rate {
        pub(crate) input: f64,
        pub(crate) output: f64,
        pub(crate) cache_read: Option<f64>,
        pub(crate) off_peak: Option<OffPeak>,
    }

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(crate) struct Multipliers {
        pub(crate) cache_read: f64,
        pub(crate) write_5m: f64,
        pub(crate) write_1h: f64,
    }

    #[derive(Clone, Debug, PartialEq)]
    pub(crate) struct Peak {
        /// UTC weekdays on which the peak window applies, `0` = Sunday, the
        /// same numbering `Date.getUTCDay` uses in `usage.ts`.
        pub(crate) days: Vec<u32>,
        /// `[from, to)` hours, UTC.
        pub(crate) windows: Vec<(u32, u32)>,
    }

    #[derive(Clone, Debug, PartialEq)]
    pub(crate) struct Book {
        pub(crate) mult: Multipliers,
        pub(crate) peak: Peak,
        pub(crate) models: Vec<(String, Rate)>,
        pub(crate) families: Vec<(String, String)>,
    }

    /// Parse `pricing.json`. `None` for a table this build cannot read, which
    /// prices nothing rather than something wrong: an unpriced figure is said
    /// out loud and a guessed one is not.
    pub(crate) fn parse_book(raw: &str) -> Option<Book> {
        let v: serde_json::Value = serde_json::from_str(raw).ok()?;
        let m = v.get("multipliers")?;
        let mult = Multipliers {
            cache_read: m.get("cacheRead")?.as_f64()?,
            write_5m: m.get("write5m")?.as_f64()?,
            write_1h: m.get("write1h")?.as_f64()?,
        };
        let peak_v = v.get("peak")?;
        let days = peak_v
            .get("days")?
            .as_array()?
            .iter()
            .filter_map(|d| d.as_u64().map(|n| n as u32))
            .collect();
        let windows = peak_v
            .get("windows")?
            .as_array()?
            .iter()
            .filter_map(|w| {
                let pair = w.as_array()?;
                Some((pair.first()?.as_u64()? as u32, pair.get(1)?.as_u64()? as u32))
            })
            .collect();
        let peak = Peak { days, windows };
        let mut models = Vec::new();
        for (name, r) in v.get("models")?.as_object()? {
            let off_peak = r.get("offPeak").map(|o| OffPeak {
                input: o.get("input").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
                output: o.get("output").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
                cache_read: o.get("cacheRead").and_then(serde_json::Value::as_f64),
            });
            models.push((
                name.clone(),
                Rate {
                    input: r.get("input")?.as_f64()?,
                    output: r.get("output")?.as_f64()?,
                    cache_read: r.get("cacheRead").and_then(serde_json::Value::as_f64),
                    off_peak,
                },
            ));
        }
        let mut families = Vec::new();
        for (family, newest) in v.get("families")?.as_object()? {
            families.push((family.clone(), newest.as_str()?.to_string()));
        }
        Some(Book { mult, peak, models, families })
    }

    /// **The same three rungs `usage.ts::rateFor` walks**, in the same order:
    /// the id itself, the longest key it starts with (cut only at a `-`, or
    /// `claude-opus-45` would match `claude-opus-4`), and the family's newest.
    /// An id matching none is `None`, which is `unpriced` at the face.
    pub(crate) fn rate_for<'a>(book: &'a Book, model: &str) -> Option<&'a Rate> {
        let id = model.split('[').next().unwrap_or(model).trim();
        if let Some((_, rate)) = book.models.iter().find(|(k, _)| k == id) {
            return Some(rate);
        }
        let mut best: Option<&(String, Rate)> = None;
        for row in &book.models {
            if !id.starts_with(&format!("{}-", row.0)) {
                continue;
            }
            if best.is_none_or(|b| row.0.len() > b.0.len()) {
                best = Some(row);
            }
        }
        if let Some((_, rate)) = best {
            return Some(rate);
        }
        for (family, newest) in &book.families {
            if id.contains(family.as_str()) {
                return book.models.iter().find(|(k, _)| k == newest).map(|(_, r)| r);
            }
        }
        None
    }

    /// Whether a moment falls in a provider's peak window, UTC weekdays and
    /// hours, exactly as `usage.ts::deepseekPeak` reads the same JSON.
    ///
    /// Its published rule also excludes Chinese public holidays, which this
    /// machine has no calendar for; a holiday is priced at the peak rate, the
    /// conservative direction, and both readers make that choice.
    pub(crate) fn peak_hour(peak: &Peak, at: i64) -> bool {
        let days = at.div_euclid(86_400_000);
        /* 1970-01-01 was a Thursday, which is `4` in `getUTCDay`'s numbering. */
        let weekday = (days + 4).rem_euclid(7) as u32;
        if !peak.days.contains(&weekday) {
            return false;
        }
        let hour = (at.div_euclid(3_600_000)).rem_euclid(24) as u32;
        peak.windows.iter().any(|(from, to)| hour >= *from && hour < *to)
    }

    /// The rate in force at a moment: the peak one, or the off-peak half where
    /// a provider bills two. A model with one clock has one row and is the same
    /// at every hour.
    pub(crate) fn rate_at(book: &Book, model: &str, at: i64) -> Option<Rate> {
        let rate = *rate_for(book, model)?;
        let Some(off) = rate.off_peak else { return Some(rate) };
        if peak_hour(&book.peak, at) {
            return Some(rate);
        }
        Some(Rate {
            input: off.input,
            output: off.output,
            cache_read: off.cache_read.or(rate.cache_read),
            off_peak: None,
        })
    }

    /// The five token kinds, priced through the rate in force at the fact's own
    /// instant. `None` for a model the table does not know, which is counted as
    /// unpriced rather than priced at zero.
    pub(crate) fn price(
        book: &Book,
        model: &str,
        at: i64,
        input: i64,
        output: i64,
        cache_read: i64,
        write_5m: i64,
        write_1h: i64,
    ) -> Option<f64> {
        let rate = rate_at(book, model, at)?;
        let read_mult = rate.cache_read.unwrap_or(book.mult.cache_read);
        Some(
            (input as f64 * rate.input
                + output as f64 * rate.output
                + cache_read as f64 * rate.input * read_mult
                + write_5m as f64 * rate.input * book.mult.write_5m
                + write_1h as f64 * rate.input * book.mult.write_1h)
                / 1e6,
        )
    }

    /// What was actually billed for a fact, given who paid.
    ///
    /// **A provider card's transcript carries a Claude alias**, because Claude
    /// Code validates `--model` locally (`docs/PROVIDERS.md`), so the table has
    /// no way to know the tokens were billed by DeepSeek at all. DeepSeek maps
    /// `claude-opus*` to its pro model and everything else to flash, server
    /// side; that mapping is the one thing this needs to mirror, and it is
    /// stated in `providers.md` rather than measured here.
    pub(crate) fn billed_model<'a>(model: &'a str, provider: &str) -> &'a str {
        if provider == "deepseek" {
            if model.starts_with("claude-opus") {
                "deepseek-v4-pro"
            } else {
                "deepseek-flash"
            }
        } else {
            model
        }
    }
}

use rules::{Measure, Period, PeriodKeys, Scope};

/* ── the price book, parsed once ───────────────────────────────────────────*/

static BOOK: OnceLock<Option<rules::Book>> = OnceLock::new();

fn book() -> Option<&'static rules::Book> {
    BOOK.get_or_init(|| rules::parse_book(PRICING)).as_ref()
}

/* ── the clock ─────────────────────────────────────────────────────────────*/

/// `(now_ms, "YYYY-MM-DD", local_midnight_ms)`.
///
/// **Local, and not arithmetic on UTC.** `now - (now % DAY)` is midnight UTC,
/// which here is the middle of the afternoon, and `now - offset` applies the
/// offset in force *now* to a moment that may be the other side of a DST
/// change. Windows can answer the real instant for a local wall time, so it is
/// asked; the fallback is honest UTC for the platforms this app does not ship
/// on.
#[cfg(windows)]
fn local_now() -> (i64, String, i64) {
    use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows::Win32::System::SystemInformation::GetLocalTime;
    use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;

    let now = crate::usage::now_ms();
    let local = unsafe { GetLocalTime() };
    let day = format!("{:04}-{:02}-{:02}", local.wYear, local.wMonth, local.wDay);
    let midnight = SYSTEMTIME {
        wYear: local.wYear,
        wMonth: local.wMonth,
        wDay: local.wDay,
        ..Default::default()
    };
    let mut utc = SYSTEMTIME::default();
    let mut start = None;
    if unsafe { TzSpecificLocalTimeToSystemTime(None, &midnight, &mut utc) }.is_ok() {
        let mut ft = FILETIME::default();
        if unsafe { windows::Win32::System::Time::SystemTimeToFileTime(&utc, &mut ft) }.is_ok() {
            let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
            start = Some(ticks_to_ms(ticks));
        }
    }
    (
        now,
        day,
        start.unwrap_or_else(|| now - (now.rem_euclid(86_400_000))),
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
/// FILETIME's 100-nanosecond ticks since 1601, as Unix milliseconds.
///
/// **The unit is the whole of this function and it was wrong once**: `ticks / 10`
/// is microseconds, and paired with the millisecond epoch offset it put "today"
/// somewhere in the year 2400, so `today` read zero and a `day` watch could
/// never fire, silently, because a zero is a number. It is its own function so
/// a test can round-trip it against `clock_said`'s inverse.
fn ticks_to_ms(ticks: u64) -> i64 {
    /* 1601-01-01 to 1970-01-01, in milliseconds. */
    const EPOCH_MS: i64 = 11_644_473_600_000;
    (ticks / 10_000) as i64 - EPOCH_MS
}

#[cfg(not(windows))]
fn local_now() -> (i64, String, i64) {
    let now = crate::usage::now_ms();
    let day_ms = now - now.rem_euclid(86_400_000);
    let days = day_ms.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    (now, format!("{y:04}-{m:02}-{d:02}"), day_ms)
}

/// The civil date from a count of days since 1970-01-01 (Howard Hinnant's
/// algorithm, which is exact for every date this app can see).
#[cfg(not(windows))]
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/* ── what one card has used ────────────────────────────────────────────────*/

/// One `usage_fact` row, as this module needs it.
#[derive(Clone, Debug)]
struct Fact {
    at: i64,
    session: String,
    agent: String,
    parent_agent: String,
    depth: i64,
    model: String,
    account: String,
    provider: String,
    provenance: String,
    input: i64,
    output: i64,
    cache_read: i64,
    write_5m: i64,
    write_1h: i64,
    requests: i64,
}

impl Fact {
    fn tokens(&self) -> i64 {
        self.input + self.output + self.cache_read + self.write_5m + self.write_1h
    }
}

/// Tokens and requests summed over some rows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Tok {
    input: i64,
    output: i64,
    cache_read: i64,
    write_5m: i64,
    write_1h: i64,
    requests: i64,
}

impl Tok {
    fn add(&mut self, f: &Fact) {
        self.input += f.input;
        self.output += f.output;
        self.cache_read += f.cache_read;
        self.write_5m += f.write_5m;
        self.write_1h += f.write_1h;
        self.requests += f.requests;
    }

    fn tokens(&self) -> i64 {
        self.input + self.output + self.cache_read + self.write_5m + self.write_1h
    }

    /// The share of prompt tokens that were a cache read. `None` when there
    /// were no prompt tokens, because a ratio with no divisor is not zero.
    fn cache_share(&self) -> Option<f64> {
        let prompt = self.input + self.cache_read + self.write_5m + self.write_1h;
        if prompt <= 0 {
            return None;
        }
        Some(self.cache_read as f64 / prompt as f64)
    }
}

/// One row of `by_model` / `by_subagent`.
struct Split {
    key: String,
    note: String,
    tok: Tok,
    usd: Option<f64>,
    unpriced: i64,
}

struct CardRow {
    session: String,
    model: String,
}

fn card_row(conn: &Connection, card: &str) -> Option<CardRow> {
    conn.query_row(
        "SELECT COALESCE(agent_session_id, ''), COALESCE(model, '') FROM conversation WHERE id = ?1",
        [card],
        |r| Ok(CardRow { session: r.get(0)?, model: r.get(1)? }),
    )
    .optional()
    .ok()
    .flatten()
}

/// Every session `analytics_session` attributes to this card, plus the one it
/// is running now. A card that has cleared has several; a synthetic
/// `turn:<id>` session from the backfill is one of them and is where old
/// history lives (§7.4).
fn card_sessions(conn: &Connection, card: &str, current: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT session FROM analytics_session WHERE card_id = ?1")
        .map_err(|e| format!("spend: sessions: {e}"))?;
    let rows = stmt
        .query_map([card], |r| r.get::<_, String>(0))
        .map_err(|e| format!("spend: sessions: {e}"))?;
    let mut out: Vec<String> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("spend: sessions: {e}"))?;
    if !current.is_empty() && !out.iter().any(|s| s == current) {
        out.push(current.to_string());
    }
    Ok(out)
}

fn children_of(conn: &Connection, card: &str) -> Vec<String> {
    crate::store::lineage(conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, parent)| parent == card)
        .map(|(child, _)| child)
        .collect()
}

/// The card's facts, over the sessions in scope, from `since`. One query per
/// card, served by `usage_fact_by_session`, and never a scan of the fine tier.
fn facts(conn: &Connection, sessions: &[String], since: i64) -> Result<Vec<Fact>, String> {
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    let holes = vec!["?"; sessions.len()].join(",");
    let sql = format!(
        "SELECT at, session, agent, parent_agent, depth, model, account, provider, provenance,
                in_tok, out_tok, cache_read, write_5m, write_1h, requests
           FROM usage_fact
          WHERE session IN ({holes}) AND at >= ?
          ORDER BY at"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("spend: facts: {e}"))?;
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = sessions
        .iter()
        .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::ToSql>)
        .collect();
    args.push(Box::new(since));
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())), |r| {
            Ok(Fact {
                at: r.get(0)?,
                session: r.get(1)?,
                agent: r.get(2)?,
                parent_agent: r.get(3)?,
                depth: r.get(4)?,
                model: r.get(5)?,
                account: r.get(6)?,
                provider: r.get(7)?,
                provenance: r.get(8)?,
                input: r.get(9)?,
                output: r.get(10)?,
                cache_read: r.get(11)?,
                write_5m: r.get(12)?,
                write_1h: r.get(13)?,
                requests: r.get(14)?,
            })
        })
        .map_err(|e| format!("spend: facts: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("spend: facts: {e}"))
}

/// Drop the coarser source where both cover one hour.
///
/// §7.4: a backfilled `turn` day and the transcript facts covering the same
/// hours must not add into one figure, and the finer source wins. The fine
/// tier is where a card's own reading lives, so this is the same preference the
/// query layer makes, applied before anything is summed.
fn prefer_transcript(rows: Vec<Fact>) -> Vec<Fact> {
    let mut fine: std::collections::HashSet<(String, i64)> = Default::default();
    for f in &rows {
        if f.provenance == "transcript" {
            fine.insert((f.session.clone(), crate::analytics::hour_of(f.at)));
        }
    }
    rows.into_iter()
        .filter(|f| {
            f.provenance == "transcript"
                || !fine.contains(&(f.session.clone(), crate::analytics::hour_of(f.at)))
        })
        .collect()
}

/* ── a card's life, by who paid for it (§11.10) ────────────────────────────*/

/// One `(session, account, provider, model)` group of a card's spend, with the
/// instants the card was first and last billed under it.
///
/// **This is the card page's bar and its change timeline.** It is grouped here
/// rather than in the front end because the rule that matters is
/// `prefer_transcript`: a backfilled `turn` day and the transcript facts over
/// the same hour must not be added into one figure, and that rule lives in
/// this module. A reader asking for the groups gets them already deduped.
///
/// `usd` is modelled per fact at the fact's own instant through
/// `pricing.json`, the one table both sides price from, so this figure and the
/// surface's own `usd_modeled` agree. It is `None` only when this build cannot
/// read the table; tokens on a model it does not know are counted in
/// `unpriced` and never priced as zero.
///
/// **The groups are what the wall still holds**, not the card's whole life: the
/// fine tier keeps ninety days (the `turn` table, which is where the all-time
/// reported dollars come from, keeps everything). `analytics::card_life` reads
/// the oldest fact on the wall beside this so the page can say when the split
/// begins.
pub(crate) fn payer_split(
    conn: &Connection,
    card: &str,
) -> Result<Vec<crate::analytics::LifeSpend>, String> {
    let current = card_row(conn, card).map(|r| r.session).unwrap_or_default();
    let sessions = card_sessions(conn, card, &current)?;
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    let rows = prefer_transcript(facts(conn, &sessions, i64::MIN)?);
    let have_book = book().is_some();
    let mut groups: HashMap<(String, String, String, String), crate::analytics::LifeSpend> =
        HashMap::new();
    for f in &rows {
        let key = (
            f.session.clone(),
            f.account.clone(),
            f.provider.clone(),
            f.model.clone(),
        );
        let g = groups.entry(key).or_insert_with(|| crate::analytics::LifeSpend {
            session: f.session.clone(),
            account: f.account.clone(),
            provider: f.provider.clone(),
            model: f.model.clone(),
            first_at: f.at,
            last_at: f.at,
            in_tok: 0,
            out_tok: 0,
            cache_read: 0,
            write_5m: 0,
            write_1h: 0,
            requests: 0,
            usd: if have_book { Some(0.0) } else { None },
            unpriced: 0,
        });
        g.first_at = g.first_at.min(f.at);
        g.last_at = g.last_at.max(f.at);
        g.in_tok += f.input;
        g.out_tok += f.output;
        g.cache_read += f.cache_read;
        g.write_5m += f.write_5m;
        g.write_1h += f.write_1h;
        g.requests += f.requests;
        let priced = book().and_then(|b| {
            rules::price(
                b,
                rules::billed_model(&f.model, &f.provider),
                f.at,
                f.input,
                f.output,
                f.cache_read,
                f.write_5m,
                f.write_1h,
            )
        });
        if priced.is_none() {
            g.unpriced += f.tokens();
        }
        g.usd = g.usd.map(|sum| sum + priced.unwrap_or(0.0));
    }
    let mut out: Vec<_> = groups.into_values().collect();
    out.sort_by(|a, b| {
        a.first_at
            .cmp(&b.first_at)
            .then_with(|| a.session.cmp(&b.session))
            .then_with(|| a.account.cmp(&b.account))
            .then_with(|| a.model.cmp(&b.model))
    });
    Ok(out)
}

/// What one card has spent, in the pieces the answer and a watch both need.
struct Spend {
    session: Tok,
    today: Tok,
    lifetime: Tok,
    turn: Tok,
    usd_session: f64,
    usd_today: f64,
    usd_lifetime: f64,
    usd_turn: Option<f64>,
    by_model: Vec<Split>,
    by_agent: Vec<Split>,
    cache_share: Option<f64>,
    unpriced: i64,
    sessions: Vec<String>,
    current: String,
    open_turn: Option<(i64, i64)>,
    model: String,
}

/// Every session in scope, and each card in it paired with its own current
/// session.
///
/// A spawned card is a session of its own (§4.4), so a parent's session id
/// matches none of a child's facts. Pairing them here is what keeps a `session`
/// reading from being zero for every child while `today` and `lifetime` count
/// it.
fn scope_of(
    conn: &Connection,
    card: &str,
    scope: Scope,
) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    let Some(row) = card_row(conn, card) else {
        return Err(format!("no card {card}"));
    };
    let mut sessions = card_sessions(conn, card, &row.session)?;
    let mut currents: Vec<(String, String)> = vec![(card.to_string(), row.session.clone())];
    if scope.with_children() {
        for child in children_of(conn, card) {
            let Some(child_row) = card_row(conn, &child) else { continue };
            sessions.extend(card_sessions(conn, &child, &child_row.session)?);
            currents.push((child, child_row.session));
        }
    }
    sessions.sort();
    sessions.dedup();
    Ok((sessions, currents))
}

/// Sum one card, or the card and its children.
fn gather(conn: &Connection, card: &str, scope: Scope, day_start: i64) -> Result<Spend, String> {
    let Some(row) = card_row(conn, card) else {
        return Err(format!("no card {card}"));
    };
    let (sessions, currents) = scope_of(conn, card, scope)?;
    let current_set: std::collections::HashSet<&str> =
        currents.iter().map(|(_, s)| s.as_str()).filter(|s| !s.is_empty()).collect();

    let rows = prefer_transcript(facts(conn, &sessions, i64::MIN)?);
    let open = open_turn(conn, card)?;

    let mut session = Tok::default();
    let mut today = Tok::default();
    let mut lifetime = Tok::default();
    let mut turn = Tok::default();
    let mut by_model: HashMap<String, (Tok, Option<f64>, i64)> = HashMap::new();
    let mut by_agent: HashMap<(String, i64, String), (Tok, Option<f64>, i64)> = HashMap::new();
    let mut unpriced = 0i64;
    /* A row with no price table behind it at all is `unpriced`, and says so
       rather than reading `$0.00` over real tokens. A single unknown model
       inside an otherwise priced row does not erase the row's dollars. */
    let have_book = book().is_some();
    let fresh_usd = if have_book { Some(0.0) } else { None };

    for f in &rows {
        lifetime.add(f);
        if f.at >= day_start {
            today.add(f);
        }
        /* The open turn, partial by construction: the requests this session has
           made since the turn opened, which is all that exists until it
           settles and writes a `turn` row. */
        if let Some((_, opened)) = open {
            if f.at >= opened && f.session == row.session {
                turn.add(f);
            }
        }
        if current_set.contains(f.session.as_str()) {
            session.add(f);
        }
        let billed = rules::billed_model(&f.model, &f.provider);
        let priced_opt = book().and_then(|b| {
            rules::price(b, billed, f.at, f.input, f.output, f.cache_read, f.write_5m, f.write_1h)
        });
        if priced_opt.is_none() {
            unpriced += f.tokens();
        }
        /* **A row's dollars are the priced tokens' dollars, and an unpriced
           fact is counted rather than poisoning the row.** Setting the whole
           row to `None` at one unknown model would throw away the priced
           majority and print `unpriced` over a real number; the count beside
           it is what stops that reading as complete. */
        let priced = priced_opt.unwrap_or(0.0);
        let m = by_model.entry(f.model.clone()).or_insert((Tok::default(), fresh_usd, 0));
        m.0.add(f);
        m.1 = m.1.map(|sum| sum + priced);
        if !f.agent.is_empty() {
            let key = (f.agent.clone(), f.depth, f.parent_agent.clone());
            let a = by_agent.entry(key).or_insert((Tok::default(), fresh_usd, 0));
            a.0.add(f);
            a.1 = a.1.map(|sum| sum + priced);
            if priced_opt.is_none() {
                a.2 += f.tokens();
            }
        }
    }

    let usd_session = turns_usd(conn, &currents)?;
    let cards: Vec<String> = currents.into_iter().map(|(c, _)| c).collect();
    let usd_today = turns_usd_for(conn, &cards, Some(day_start), None)?;
    let usd_lifetime = turns_usd_for(conn, &cards, None, None)?;
    let usd_turn = Some(turn_usd_modelled(&turn, &rows, &row.session, open));

    let mut by_model: Vec<Split> = by_model
        .into_iter()
        .map(|(key, (tok, usd, unpriced))| Split {
            note: String::new(),
            key,
            tok,
            usd,
            unpriced,
        })
        .collect();
    by_model.sort_by(|a, b| b.tok.tokens().cmp(&a.tok.tokens()));
    let mut by_agent: Vec<Split> = by_agent
        .into_iter()
        .map(|((agent, depth, parent), (tok, usd, unpriced))| Split {
            key: agent,
            note: format!(
                "depth {depth}{}",
                if parent.is_empty() { String::new() } else { format!(" · under {parent}") }
            ),
            tok,
            usd,
            unpriced,
        })
        .collect();
    by_agent.sort_by(|a, b| b.tok.tokens().cmp(&a.tok.tokens()));

    Ok(Spend {
        cache_share: lifetime.cache_share(),
        session,
        today,
        lifetime,
        turn,
        usd_session,
        usd_today,
        usd_lifetime,
        usd_turn,
        by_model,
        by_agent,
        unpriced,
        sessions: card_sessions(conn, card, &row.session)?,
        current: row.session,
        open_turn: open,
        model: row.model,
    })
}

/// The open turn's row id and `opened_at`, if this card is mid-turn.
fn open_turn(conn: &Connection, card: &str) -> Result<Option<(i64, i64)>, String> {
    conn.query_row(
        "SELECT id, opened_at FROM turn
          WHERE conversation_id = ?1 AND ended_at IS NULL
          ORDER BY id DESC LIMIT 1",
        [card],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| format!("spend: turn: {e}"))
}

/// `SUM(turn.usd)` for one card's current session, over a set of cards.
///
/// **The reported figure, not a modelled one.** These are the CLI's own
/// dollars, the same rows the title bar's day sums, and using them here means
/// the tool and the wall cannot disagree about what a session cost. The
/// cache-write half is a token count, and no price is invented for it.
fn turns_usd(conn: &Connection, currents: &[(String, String)]) -> Result<f64, String> {
    let mut total = 0.0;
    for (card, session) in currents {
        if session.is_empty() {
            continue;
        }
        let got: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(usd), 0) FROM turn
                  WHERE conversation_id = ?1 AND agent_session_id = ?2
                    AND ended_at IS NOT NULL",
                params![card, session],
                |r| r.get(0),
            )
            .map_err(|e| format!("spend: turns: {e}"))?;
        total += got;
    }
    Ok(total)
}

fn turns_usd_for(
    conn: &Connection,
    cards: &[String],
    since: Option<i64>,
    _unused: Option<()>,
) -> Result<f64, String> {
    let mut total = 0.0;
    for card in cards {
        let got: f64 = match since {
            Some(s) => conn.query_row(
                "SELECT COALESCE(SUM(usd), 0) FROM turn
                  WHERE conversation_id = ?1 AND ended_at IS NOT NULL AND ended_at >= ?2",
                params![card, s],
                |r| r.get(0),
            ),
            None => conn.query_row(
                "SELECT COALESCE(SUM(usd), 0) FROM turn
                  WHERE conversation_id = ?1 AND ended_at IS NOT NULL",
                params![card],
                |r| r.get(0),
            ),
        }
        .map_err(|e| format!("spend: turns: {e}"))?;
        total += got;
    }
    Ok(total)
}

/// The open turn's cost, modelled from the facts inside its interval.
///
/// A turn that has not settled has no reported cost yet, the `turn` row is
/// written at its open with a zero, so the honest partial reading is what its
/// requests' tokens price at. It is labelled modelled in the answer because it
/// is.
fn turn_usd_modelled(_turn: &Tok, rows: &[Fact], current: &str, open: Option<(i64, i64)>) -> f64 {
    let Some((_, opened)) = open else { return 0.0 };
    let Some(b) = book() else { return 0.0 };
    rows.iter()
        .filter(|f| f.session == current && f.at >= opened)
        .filter_map(|f| {
            let billed = rules::billed_model(&f.model, &f.provider);
            rules::price(b, billed, f.at, f.input, f.output, f.cache_read, f.write_5m, f.write_1h)
        })
        .sum()
}

/* ── the reading ───────────────────────────────────────────────────────────*/

/// One request's prompt size, read off the tail of the card's own transcript.
///
/// `context_tokens` is the conversation's own fold rather than a table, and the
/// fold's rule is the last assistant message's usage, input plus both cache
/// halves plus output (`conversation.svelte.ts`). A bounded tail scan gives the
/// same number for the same reason, and it is the only reading here that is not
/// a sum over rows: a bucket's total is *not* a context size, and reading one
/// would overstate the next turn by however many requests shared the bucket.
fn context_tokens(app: &AppHandle, card: &str) -> Option<i64> {
    use std::io::{Read, Seek, SeekFrom};

    let store = app.state::<Store>();
    let (dir, session) = {
        let conn = store.0.lock().ok()?;
        crate::store::session_of(&conn, card)?
    };
    let session = session.filter(|s| !s.is_empty())?;
    let path = crate::supervisor::transcript_path(app, &dir, &session).ok()?;
    let mut f = std::fs::File::open(&path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(CONTEXT_TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    /* The first line of a tail read may be a partial record; it is a fragment
       of an older one and parsing it as a record would invent a usage. */
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if start > 0 {
        lines.remove(0);
    }
    for line in lines.iter().rev() {
        if !line.contains("\"type\":\"assistant\"") {
            continue;
        }
        if let Some(rec) = crate::usage::read_record(line) {
            let t = &rec.tokens;
            return Some(t.input + t.output + t.cache_read + t.write_5m + t.write_1h);
        }
    }
    None
}

/// What one more request would cost: the context re-read from cache.
///
/// **A floor, and labelled as one.** The next turn re-reads the whole context,
/// which is a cache read in the ordinary case, and then spends output nobody
/// can predict. Pricing the known half at the cached rate is the number that is
/// honest; pricing it at the fresh-input rate would overstate it tenfold on a
/// calm card, and guessing an output length would invent the larger half.
fn next_turn_usd(context: Option<i64>, model: &str, at: i64) -> Option<f64> {
    let context = context?;
    let b = book()?;
    let rate = rules::rate_at(b, model, at)?;
    let read_mult = rate.cache_read.unwrap_or(b.mult.cache_read);
    Some(context as f64 * rate.input * read_mult / 1e6)
}

/// The share of an allowance window's attributed delta this card accounts for.
///
/// §5.2's arithmetic needs both halves of the window: the account's delta
/// between samples, and the modelled cost of every known request in it. Since
/// schema v71 the wall **does** keep samples (`allowance_fact`, §3.3), and the
/// analytics room attributes a week of them (`allowancesamples.ts`, §5). What
/// is deliberately absent is a *per-card* share computed here: the arithmetic
/// prices facts, the room folds it in TypeScript where the same pricing is used
/// for every other dollar on the surface, and a second attribution in Rust is a
/// second answer to one question. So this answers null with the reason rather
/// than a number that could disagree with the room.
struct Share {
    points: Option<f64>,
    why: String,
}

fn share_of_window(conn: &Connection, card: &str) -> Result<Share, String> {
    /* The card is still unused, and is the first thing a per-card share would
       need: the share is this card's points, not the wall's. */
    let _ = card;
    let kept: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'allowance_fact'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("spend: share: {e}"))?;
    if kept == 0 {
        return Ok(Share {
            points: None,
            why: "this wall keeps no allowance samples, so there is no window delta to share"
                .into(),
        });
    }
    Ok(Share {
        points: None,
        why: "the allowance is attributed over a window in the analytics room, not per card \
              here"
            .into(),
    })
}

fn cache_said(share: Option<f64>) -> String {
    match share {
        Some(s) => format!("{:.0}% of prompt tokens were cache reads", s * 100.0),
        None => "no prompt tokens recorded, so no cache share".into(),
    }
}

/// The answer to `read`, as the model reads it.
fn render(
    s: &Spend,
    children: bool,
    caught: &crate::analytics::Caught,
    context: Option<i64>,
    next_usd: Option<f64>,
    share: &Share,
    breached: &[String],
    now: i64,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "**what this card has spent**, as of {} (local).\n",
        clock_said(now)
    ));
    let live = match s.open_turn {
        Some(_) => "a turn is open: its tokens are counted below and its money is not in the \
                    session, today or lifetime figures until it settles. `turn` is that partial.",
        None => "no turn is open.",
    };
    out.push_str(&format!("{live}\n"));
    if caught.bytes > 0 {
        out.push_str(&format!(
            "caught up {} KB of this card's transcript before answering{}.\n",
            caught.bytes / 1024,
            if caught.capped {
                ", the window since the last read only; the collector takes the rest on its \
                 next beat"
            } else {
                ""
            }
        ));
    }
    let scope = if children { " (with the cards it opened)" } else { "" };
    out.push_str(&format!(
        "\nsession   {} · {} tokens · {} requests{}\n",
        rules::usd_said(s.usd_session),
        rules::tokens_said(s.session.tokens()),
        s.session.requests,
        if children { scope } else { "" }
    ));
    out.push_str(&format!(
        "today     {} · {} tokens · {} requests\n",
        rules::usd_said(s.usd_today),
        rules::tokens_said(s.today.tokens()),
        s.today.requests
    ));
    out.push_str(&format!(
        "lifetime  {} · {} tokens · {} requests\n",
        rules::usd_said(s.usd_lifetime),
        rules::tokens_said(s.lifetime.tokens()),
        s.lifetime.requests
    ));
    if s.open_turn.is_some() {
        out.push_str(&format!(
            "turn      {} modelled · {} tokens · {} requests (partial)\n",
            s.usd_turn.map(rules::usd_said).unwrap_or_else(|| "unpriced".into()),
            rules::tokens_said(s.turn.tokens()),
            s.turn.requests
        ));
    }
    out.push_str(&format!(
        "\ncontext   {}\n",
        match context {
            Some(n) => format!(
                "{} tokens · next cached re-read {} (modelled floor, no output)",
                rules::tokens_said(n),
                next_usd
                    .map(rules::usd_said)
                    .unwrap_or_else(|| "unpriced".into())
            ),
            None => "not read yet: no assistant request in this card's transcript".into(),
        }
    ));
    out.push_str(&format!("cache     {}\n", cache_said(s.cache_share)));

    if s.by_model.is_empty() {
        out.push_str("\nby model\n  no requests recorded for this card yet.\n");
    } else {
        out.push_str("\nby model\n");
        for row in &s.by_model {
            out.push_str(&format!(
                "  {:<24} {:>8} tok  {:>10}  {} req{}\n",
                row.key,
                rules::tokens_said(row.tok.tokens()),
                row.usd.map(rules::usd_said).unwrap_or_else(|| "unpriced".into()),
                row.tok.requests,
                if row.unpriced > 0 { "  (part unpriced)" } else { "" }
            ));
        }
    }
    if !s.by_agent.is_empty() {
        out.push_str("\nby subagent\n");
        for row in &s.by_agent {
            out.push_str(&format!(
                "  {:<20} {:>8} tok  {:>10}  {} req  {}\n",
                row.key,
                rules::tokens_said(row.tok.tokens()),
                row.usd.map(rules::usd_said).unwrap_or_else(|| "unpriced".into()),
                row.tok.requests,
                row.note
            ));
        }
    }

    out.push_str(&format!(
        "\nshare of window  {}\n",
        match share.points {
            Some(p) => format!("{} of the window's attributed delta (attributed)", trim1(p)),
            None => format!("not provable, {}", share.why),
        }
    ));
    out.push_str(&format!(
        "\nthe reading covers {} session(s) of this card{}; {}. the dollars are the CLI's \
         reported cost from settled turns; `by model` and `by subagent` dollars are modelled \
         from their tokens, and are shares rather than a second total.\n",
        s.sessions.len(),
        if children { " and the cards it opened" } else { "" },
        if s.current.is_empty() {
            "no session open".to_string()
        } else {
            format!("current {}", s.current)
        }
    ));
    if s.unpriced > 0 {
        out.push_str(&format!(
            "{} tokens are on a model no price table here knows; they are counted in tokens and \
             left out of every dollar above, not priced at zero.\n",
            rules::tokens_said(s.unpriced)
        ));
    }
    if !breached.is_empty() {
        out.push_str("\n**breached watches**\n");
        for line in breached {
            out.push_str(&format!("  {line}\n"));
        }
    }
    out
}

fn trim1(v: f64) -> String {
    let s = format!("{v:.1}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

/// One instant, on the local clock to the second, enough to tell a caught-up
/// reading from a stale one, and enough to date a watch that fired.
///
/// It converts the instant it is given rather than reading the clock now,
/// because the two uses differ: `as_of` is now, and a watch's `fired_at` is
/// whenever it fired. A formatter that read the clock would print the same
/// minute on every row of `list`.
fn clock_said(ms: i64) -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
        /* 100-nanosecond ticks, and the epoch is 11644473600s into it. */
        let ticks = (ms + 11_644_473_600_000).max(0) as u64 * 10_000;
        let ft = FILETIME {
            dwLowDateTime: (ticks & 0xffff_ffff) as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        let mut utc = SYSTEMTIME::default();
        let mut local = SYSTEMTIME::default();
        if unsafe { FileTimeToSystemTime(&ft, &mut utc) }.is_ok()
            && unsafe { SystemTimeToTzSpecificLocalTime(None, &utc, &mut local) }.is_ok()
        {
            return format!("{:02}:{:02}:{:02}", local.wHour, local.wMinute, local.wSecond);
        }
        /* A failed conversion falls back to UTC rather than to the clock. */
        let secs = (ms / 1000).rem_euclid(86_400);
        format!("{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
    }
    #[cfg(not(windows))]
    {
        let secs = (ms / 1000).rem_euclid(86_400);
        format!("{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60)
    }
}

/* ── watches ───────────────────────────────────────────────────────────────*/

fn watch_line(w: &SpendWatch) -> String {
    format!(
        "#{} {} {} over {} ({}){}",
        w.id,
        w.measure,
        match w.measure.as_str() {
            "usd" => rules::threshold_said(Measure::Usd, w.at_value),
            "tokens" => rules::threshold_said(Measure::Tokens, w.at_value),
            _ => rules::threshold_said(Measure::AllowancePoints, w.at_value),
        },
        w.period,
        w.scope,
        match w.fired_at {
            Some(at) => format!(" · fired {}", clock_said(at)),
            None => String::new(),
        }
    )
}

/// The value a watch measures, for the period instance it is on.
///
/// **Bounded to the instance's own window, and that is the difference between
/// a reading and a scan.** This runs on the ingest's sixty-second beat for
/// every card with a watch, under the store mutex every command waits on, so
/// it asks only for the facts the period covers (this session, today, or the
/// open turn), never for the card's ninety days. The full history is what
/// `read` is for, and `read` is a card's own gesture.
///
/// `Ok(Err(why))` for a period with no instance right now, a `turn` watch with
/// no turn open, which is not a zero and must not be compared as one.
fn value_of(
    conn: &Connection,
    card: &str,
    w: &SpendWatch,
    scope: Scope,
    keys: &PeriodKeys,
    day_start: i64,
) -> Result<Result<f64, String>, String> {
    let measure: Measure = w.measure.parse()?;
    let period: Period = w.period.parse()?;
    if let (Measure::AllowancePoints, Period::Window) = (measure, period) {
        return Ok(Ok(share_of_window(conn, card)?.points.unwrap_or(0.0)));
    }
    if measure == Measure::AllowancePoints || period == Period::Window {
        return Ok(Err("that measure and period do not go together".into()));
    }
    let (sessions, currents) = scope_of(conn, card, scope)?;
    let current_cards: Vec<String> = currents.iter().map(|(c, _)| c.clone()).collect();

    if measure == Measure::Usd && period != Period::Turn {
        /* Reported dollars, from the card's settled turns, served by the
           session and conversation indexes. */
        return Ok(Ok(match period {
            Period::Session => turns_usd(conn, &currents)?,
            _ => turns_usd_for(conn, &current_cards, Some(day_start), None)?,
        }));
    }

    let open = match period {
        Period::Turn => match open_turn(conn, card)? {
            Some((_, opened)) => Some(opened),
            None => return Ok(Err("no turn is open".into())),
        },
        _ => None,
    };
    let from = match (period, open) {
        (Period::Day, _) => day_start,
        (Period::Turn, Some(opened)) => opened,
        _ => 0,
    };
    /* A `session` watch asks for the sessions **currently in force**, not every
       session the card has ever had: `from` is zero for it, so handing the
       whole scope over would load the card's lifetime on the beat. */
    let query_sessions: Vec<String> = if period == Period::Session {
        currents
            .iter()
            .map(|(_, s)| s.clone())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        sessions
    };
    let rows = prefer_transcript(facts(conn, &query_sessions, from)?);
    let current_set: std::collections::HashSet<&str> =
        currents.iter().map(|(_, s)| s.as_str()).filter(|s| !s.is_empty()).collect();
    let mut tok = Tok::default();
    let mut priced = 0.0;
    for f in &rows {
        let in_period = match period {
            Period::Session => current_set.contains(f.session.as_str()),
            Period::Day => f.at >= day_start,
            Period::Turn => f.session == keys.session && f.at >= from,
            Period::Window => false,
        };
        if !in_period {
            continue;
        }
        tok.add(f);
        if measure == Measure::Usd {
            let billed = rules::billed_model(&f.model, &f.provider);
            priced += book()
                .and_then(|b| {
                    rules::price(
                        b,
                        billed,
                        f.at,
                        f.input,
                        f.output,
                        f.cache_read,
                        f.write_5m,
                        f.write_1h,
                    )
                })
                .unwrap_or(0.0);
        }
    }
    Ok(Ok(match measure {
        Measure::Tokens => tok.tokens() as f64,
        Measure::Usd => priced,
        Measure::AllowancePoints => 0.0,
    }))
}

/// The keys a card's periods are named by, without gathering its spend.
fn keys_for_card(conn: &Connection, card: &str, now: i64) -> Result<PeriodKeys, String> {
    let Some(row) = card_row(conn, card) else {
        return Err(format!("no card {card}"));
    };
    Ok(PeriodKeys {
        session: row.session,
        day: local_now().1,
        turn: open_turn(conn, card)?.map(|(id, _)| id),
        window: current_window(conn, now)?,
    })
}

/// The current allowance window's reset stamp, read off the wall's own cache.
///
/// `None` because this wall does not resolve a *per-card* allowance window:
/// samples are kept (§3.3) and the room attributes them over a window, but
/// nothing here turns one into a card's share. That is also the reason an
/// `allowance_points` watch is refused rather than stored.
fn current_window(_conn: &Connection, _now: i64) -> Result<Option<String>, String> {
    Ok(None)
}

/// Sessions whose facts a `spend read` wrote outside the collector's own batch.
///
/// **A catch-up advances the collector's marks**, so the requests it consumed
/// are never in a batch `pass` builds: the next beat finds nothing new for that
/// session and its `touched` list is empty. Without this set, a card that read
/// its spend and then stood still could have a watch crossed by that very
/// reading and never hear about it. The evaluation still happens on the ingest
/// thread, which is what keeps `read` honestly read-only.
static PENDING: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

/// Remember a session a catch-up wrote. Drained by the next `evaluate`.
pub(crate) fn note_caught(session: &str) {
    if session.is_empty() {
        return;
    }
    if let Ok(mut set) = PENDING.get_or_init(|| Mutex::new(Default::default())).lock() {
        set.insert(session.to_string());
    }
}

fn drain_pending() -> Vec<String> {
    let Some(gate) = PENDING.get() else { return Vec::new() };
    let Ok(mut set) = gate.lock() else { return Vec::new() };
    set.drain().collect()
}

/// **The breach pass.** Called by the ingest after it has written facts, with
/// the sessions it wrote. It is deliberately not called by `read`: `read` is
/// advertised read-only, and this can write a fired mark and a notice.
///
/// It also takes the sessions a `spend read` caught up, from the pending set
/// above, because that reading advances the collector's marks past bytes the
/// pass will never see in a batch of its own.
pub(crate) fn evaluate(
    conns: &Mutex<Connection>,
    app: &AppHandle,
    sessions: &[String],
) -> Result<i64, String> {
    let mut all: Vec<String> = sessions.to_vec();
    all.extend(drain_pending());
    all.sort();
    all.dedup();
    let sessions = &all[..];
    if sessions.is_empty() {
        return Ok(0);
    }
    /* Which cards these sessions belong to. Two answers: the session table's
       attribution, and the conversation row's current session, a rung-old card
       may have facts before the session row caught up. */
    let cards: Vec<String> = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let holes = vec!["?"; sessions.len()].join(",");
        let sql = format!(
            "SELECT DISTINCT card_id FROM analytics_session
              WHERE session IN ({holes}) AND card_id IS NOT NULL
             UNION
             SELECT id FROM conversation WHERE agent_session_id IN ({holes})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("spend: cards: {e}"))?;
        let args: Vec<Box<dyn rusqlite::ToSql>> = sessions
            .iter()
            .map(|s| Box::new(s.clone()) as Box<dyn rusqlite::ToSql>)
            .chain(sessions.iter().map(|s| Box::new(s.clone()) as Box<dyn rusqlite::ToSql>))
            .collect();
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
                |r| r.get::<_, String>(0),
            )
            .map_err(|e| format!("spend: cards: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("spend: cards: {e}"))?
    };
    let mut fired: i64 = 0;
    for card in cards {
        fired += evaluate_one(conns, app, &card)?;
    }
    Ok(fired)
}

/// Evaluate one card's watches for the period instances they are on.
pub(crate) fn evaluate_one(
    conns: &Mutex<Connection>,
    app: &AppHandle,
    card: &str,
) -> Result<i64, String> {
    let (watches, keys, now, day_start, live) = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let watches = crate::store::watches_of(&conn, card)?;
        if watches.is_empty() {
            return Ok(0);
        }
        let (now, _, day_start) = local_now();
        let keys = keys_for_card(&conn, card, now)?;
        let live = keys.turn.is_some();
        (watches, keys, now, day_start, live)
    };
    let mut fired = 0;
    for w in watches {
        let measure: Measure = w.measure.parse()?;
        let period: Period = w.period.parse()?;
        let scope: Scope = w.scope.parse()?;
        let Some(instance) = rules::instance_key(period, &keys) else { continue };
        if w.fired_for.as_deref() == Some(instance.as_str()) {
            continue;
        }
        let value = {
            let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            match value_of(&conn, card, &w, scope, &keys, day_start)? {
                Ok(v) => v,
                Err(_) => continue,
            }
        };
        if !rules::breached(w.at_value, value) {
            continue;
        }
        /* A full queue is not a reason to lose a notice: the instance is left
           unmarked so a later ingest tries again, rather than a breach being
           recorded as told when nobody was. */
        if !crate::notice::has_room(app, card) {
            continue;
        }
        let marked = {
            let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            crate::store::mark_watch_fired(&conn, card, w.id, &instance, now)?
        };
        if !marked {
            continue;
        }
        /* **No claim about the card still working.** The pass runs on facts a
           transcript already holds, so the ordinary breach is noticed after the
           turn has settled; saying it is working would be false in the common
           case. "Nothing was stopped" is true whenever it is read. */
        let text = crate::clip::keep(
            &format!(
                "spend watch: {}. nothing was stopped{}. Raise or remove it with \
                 `mcp__skein__spend_watch` (`unwatch {}`).",
                rules::breach_line(measure, value, w.at_value, period, scope),
                if live { "; the card is mid-turn" } else { "" },
                w.id
            ),
            NOTICE_MAX,
        )
        .kept;
        crate::notice::queue(app, card, &text, crate::notice::Queued::Sent);
        fired += 1;
    }
    Ok(fired)
}

/// The watches a card currently reports as breached, as one line each.
fn breached_lines(conn: &Connection, card: &str, now: i64) -> Result<Vec<String>, String> {
    let keys = keys_for_card(conn, card, now)?;
    let (_, _, day_start) = local_now();
    let mut out = Vec::new();
    for w in crate::store::watches_of(conn, card)? {
        let period: Period = w.period.parse()?;
        let Some(instance) = rules::instance_key(period, &keys) else { continue };
        if w.fired_for.as_deref() != Some(instance.as_str()) {
            continue;
        }
        let measure: Measure = w.measure.parse()?;
        let scope: Scope = w.scope.parse()?;
        let value = match value_of(conn, card, &w, scope, &keys, day_start)? {
            Ok(v) => v,
            Err(_) => continue,
        };
        out.push(format!(
            "{} (watch #{}, {} for {})",
            rules::breach_line(measure, value, w.at_value, period, scope),
            w.id,
            measure.key(),
            period.key()
        ));
    }
    Ok(out)
}

/* ── the verbs ─────────────────────────────────────────────────────────────*/

/// `spend read`
fn do_read(app: &AppHandle, card: &str, args: &Value) -> Result<String, String> {
    let children = args.get("children").and_then(Value::as_bool).unwrap_or(false);
    let store = app.state::<Store>();

    /* §11.13: the reading catches up first. Same reader, same writer, pointed
       at this card's own files; no API turn and not on the main thread. */
    let caught = crate::analytics::catch_up(app, card)?;
    /* **The breach pass is deliberately not run here.** `read` is advertised
       read-only, and that is a promise a planning card relies on: evaluating
       watches can write a fired mark and a notice, which is a write. Firing
       therefore rides the ingest alone (the brief's own shape, and no new
       timer); this answer reports the watches the ingest has already stamped,
       and a threshold crossed a moment ago is decided on the next beat. */

    let (now, _, day_start) = local_now();
    let (view, share, breached) = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let scope = if children { Scope::WithChildren } else { Scope::SelfOnly };
        let spent = gather(&conn, card, scope, day_start)?;
        let share = share_of_window(&conn, card)?;
        let breached = breached_lines(&conn, card, now)?;
        (spent, share, breached)
    };
    let context = context_tokens(app, card);
    let next = next_turn_usd(context, &view.model, now);
    Ok(render(&view, children, &caught, context, next, &share, &breached, now))
}

/// `spend watch`
fn do_watch(app: &AppHandle, card: &str, args: &Value) -> Result<String, String> {
    let measure: Measure = args
        .get("measure")
        .and_then(Value::as_str)
        .ok_or("`watch` needs a measure: `usd`, `tokens` or `allowance_points`.")?
        .parse()?;
    let period: Period = match args.get("period").and_then(Value::as_str) {
        Some(p) => p.parse()?,
        None => Period::Session,
    };
    rules::answerable(measure, period)?;
    let at = args
        .get("at")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or("`watch` needs `at`, a positive number: the threshold to warn at.")?;
    let scope: Scope = match args.get("scope").and_then(Value::as_str) {
        Some(s) => s.parse()?,
        None => Scope::SelfOnly,
    };
    /* A turn is one card's. A child's work happens on its own turns, so a
       `turn` watch that folded them in would be named for one thing and
       measuring another. */
    if period == Period::Turn && scope.with_children() {
        return Err(
            "a `turn` is one card's own, so its watch takes `self`. Use `session` or `day` with \
             `self+children`."
                .into(),
        );
    }
    let store = app.state::<Store>();
    let (now, _, day_start) = local_now();

    /* An `allowance_points` watch can only be honest where the wall keeps
       allowance samples, and this one does not (§3.3). Refusing now is better
       than storing a watch that could never fire. */
    if measure == Measure::AllowancePoints {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let share = share_of_window(&conn, card)?;
        if share.points.is_none() {
            return Err(format!(
                "an `allowance_points` watch cannot fire on this wall, {}. Watch `usd` or \
                 `tokens` instead; `mcp__skein__allowance` answers the account's own windows.",
                share.why
            ));
        }
    }

    let new = SpendWatch {
        id: 0,
        conversation_id: card.into(),
        measure: measure.key().into(),
        period: period.key().into(),
        at_value: at,
        scope: scope.key().into(),
        created_at: now,
        fired_for: None,
        fired_at: None,
    };
    /* What it was set against, the moment it is set: a threshold with no
       starting number is a number the card cannot sanity-check. */
    let standing = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let keys = keys_for_card(&conn, card, now)?;
        match value_of(&conn, card, &new, scope, &keys, day_start)? {
            Ok(v) => match measure {
                Measure::Usd => format!("it stands at {} now.", rules::usd_said(v)),
                Measure::Tokens => {
                    format!("it stands at {} tokens now.", rules::tokens_said(v as i64))
                }
                Measure::AllowancePoints => format!("it stands at {} points now.", trim1(v)),
            },
            Err(why) => format!(
                "there is nothing to measure yet, {why}, so the watch will be measured when \
                 that instance starts."
            ),
        }
    };
    let id = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::add_watch(&conn, &new)?
    };
    Ok(format!(
        "watch #{id} set: warn when this card's {} passes {} over {} ({}).\n\
         {standing}\n\
         one notice per {} instance, and nothing is ever stopped.",
        measure.key(),
        rules::threshold_said(measure, at),
        period.key(),
        scope.key(),
        period.key()
    ))
}

/// `spend unwatch`
fn do_unwatch(app: &AppHandle, card: &str, args: &Value) -> Result<String, String> {
    let id = args
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("`unwatch` needs `id`: the watch number `mcp__skein__spend` with verb list showed you.")?;
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    if crate::store::drop_watch(&conn, card, id)? {
        Ok(format!("watch #{id} removed. Nothing else changed."))
    } else {
        Err(format!(
            "this card has no watch #{id}. `spend list` shows the ones it has."
        ))
    }
}

/// `spend list`
fn do_list(app: &AppHandle, card: &str) -> Result<String, String> {
    let store = app.state::<Store>();
    let (now, _, _day_start) = local_now();
    let (watches, keys) = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let watches = crate::store::watches_of(&conn, card)?;
        let keys = if watches.is_empty() {
            None
        } else {
            Some(keys_for_card(&conn, card, now)?)
        };
        (watches, keys)
    };
    if watches.is_empty() {
        return Ok(
            "this card has set no spend watches. `spend_watch watch usd 10 session` sets one."
                .into(),
        );
    }
    let keys = keys.expect("a watch implies a card");
    let mut out = String::from("the watches on this card:\n");
    for w in &watches {
        let period: Period = w.period.parse()?;
        let current = rules::instance_key(period, &keys);
        let state = match (&w.fired_for, &current) {
            (Some(f), Some(c)) if f == c => "breached now",
            (Some(f), Some(_)) => {
                out.push_str(&format!("  {}\n", watch_line(w)));
                out.push_str(&format!("      fired for {f}; that period has rolled.\n"));
                continue;
            }
            (Some(f), None) => {
                out.push_str(&format!("  {}\n", watch_line(w)));
                out.push_str(&format!("      fired for {f}; that instance is over.\n"));
                continue;
            }
            /* A `turn` watch with no turn open has no instance, which is not a
               zero and not a breach. */
            (None, None) => "not breached, this period has no instance right now",
            _ => "not breached",
        };
        out.push_str(&format!("  {}\n", watch_line(w)));
        out.push_str(&format!("      {state}\n"));
    }
    out.push_str(
        "\n`spend_watch unwatch <id>` removes one. A watch never stops, pauses or slows a turn.",
    );
    Ok(out)
}

/// Route a `tools/call` that belongs to this file.
///
/// **Two tools rather than one, and the reason is plan mode.** `spend read` and
/// `spend list` change nothing a call made them do, so they carry
/// `readOnlyHint` and a planning card may use them, which is exactly the card
/// deciding how much it can afford to plan. `watch` and `unwatch` write a row
/// and, on breach, a notice in the user's queue, so they cannot carry that
/// hint: `ask.rs` asserts both directions of that list, and a planning card
/// that could set a watch would be doing the thing the gear exists to prevent.
/// One tool cannot be both, so it is two, and §11.13 records the split.
pub fn handle(app: &AppHandle, caller: &str, tool: &str, args: &Value) -> Option<String> {
    let verb = args.get("verb").and_then(Value::as_str).unwrap_or("").trim();
    let answer = match tool {
        SPEND_TOOL => match verb {
            "read" => do_read(app, caller, args),
            "list" => do_list(app, caller),
            "" => Err(
                "`mcp__skein__spend` needs a verb: read, or list. read answers what this card \
                 has used."
                    .into(),
            ),
            "watch" | "unwatch" => Err(format!(
                "`{verb}` is on `{SPEND_WATCH_TOOL}`, which is the tool that writes. This one \
                 only reads."
            )),
            other => Err(format!(
                "`{other}` is not a verb of `mcp__skein__spend`. Use read, or list."
            )),
        },
        SPEND_WATCH_TOOL => match verb {
            "watch" => do_watch(app, caller, args),
            "unwatch" => do_unwatch(app, caller, args),
            "" => Err(
                "`mcp__skein__spend_watch` needs a verb: watch sets a threshold, unwatch \
                 removes one."
                    .into(),
            ),
            other => Err(format!(
                "`{other}` is not a verb of `mcp__skein__spend_watch`. Use watch or unwatch; \
                 the reading itself is `mcp__skein__spend`."
            )),
        },
        _ => return None,
    };
    Some(match answer {
        Ok(text) => text,
        Err(e) => format!("spend did nothing: {e}"),
    })
}

/* ── what a person may read and take down ──────────────────────────────────*/

/// The watches on one card, for its page beside the spend it draws.
#[tauri::command(async)]
pub async fn spend_watches(app: AppHandle, conversation_id: String) -> Result<Vec<SpendWatch>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::watches_of(&conn, &conversation_id)
    })
    .await?
}

/// Remove one from the card's page. The card id is the caller's, and
/// `drop_watch` puts it in the `WHERE` so an id from another card deletes
/// nothing.
#[tauri::command(async)]
pub async fn spend_unwatch(
    app: AppHandle,
    conversation_id: String,
    id: i64,
) -> Result<bool, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::drop_watch(&conn, &conversation_id, id)
    })
    .await?
}

/* ── the tool's schema ─────────────────────────────────────────────────────*/

/// The reading, and the listing: both read, so both are safe in plan mode.
pub fn spend_schema() -> Value {
    json!({
        "name": SPEND_TOOL,
        "description":
            "What **this card itself** has used, its own turns, its subagents, and the turn it \
             is in. `allowance` answers the account's windows; this answers *what have I spent*, \
             which is the question a card deciding whether to fan out, compact or stop actually \
             has. Read-only: to set a warning on itself the card uses `mcp__skein__spend_watch`, \
             which is the tool that writes. `read` does write the analytics facts for the stretch \
             of its own transcript it catches up on, which the collector would have written on \
             its next beat; it changes nothing a person or another card can see.\n\n\
             `read` catches up this card's own transcript first (a local read, no API turn) and \
             answers `session`, `today` (the wall's local day, not UTC), `lifetime`, the open \
             `turn` (partial by construction), `by_model`, `by_subagent`, requests, the cache-read \
             share of prompt tokens, `context_tokens` and a modelled `next_turn_usd`. \
             `children: true` adds the cards this one opened and the answer says so.\n\n\
             `list` shows the watches this card has set on itself and whether one is breached.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "verb": {
                    "type": "string",
                    "enum": ["read", "list"],
                    "description": "`read` is the reading; `list` is the watches."
                },
                "children": {
                    "type": "boolean",
                    "description":
                        "For `read`: also count the sessions of the cards this one opened. \
                         Default false, because a spawned card is a session of its own."
                }
            },
            "required": ["verb"],
            "additionalProperties": false
        }
    })
}

/// The watch: the one thing here a card may write, so no `readOnlyHint`.
pub fn watch_schema() -> Value {
    json!({
        "name": SPEND_WATCH_TOOL,
        "description":
            "Set, or remove, a threshold on **this card's own spend**. A watch is a bookmark, \
             never a brake: on the first breach in a period instance it puts one notice in the \
             user's queue and every later `mcp__skein__spend read` reports it. Nothing is ever \
             stopped, paused or slowed, and a threshold that could halt work would be a second \
             allowance gate nobody configured.\n\n\
             A watch is this card's own preference, so it needs no confirmation and only ever \
             changes its own row. The reading itself is `mcp__skein__spend`.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "verb": {
                    "type": "string",
                    "enum": ["watch", "unwatch"],
                    "description": "`watch` sets one; `unwatch` removes one by id."
                },
                "measure": {
                    "type": "string",
                    "enum": ["usd", "tokens", "allowance_points"],
                    "description": "For `watch`: what the threshold is on."
                },
                "at": {
                    "type": "number",
                    "description":
                        "For `watch`: the threshold to warn at. Dollars for `usd`, whole tokens \
                         for `tokens`, allowance points for `allowance_points`."
                },
                "period": {
                    "type": "string",
                    "enum": ["session", "day", "turn", "window"],
                    "description":
                        "For `watch`: the stretch it is measured over. Default `session`, which \
                         is this card's current agent session. `window` takes \
                         `allowance_points` only, and a card's share of a window is not computed \
                         on this wall (the room attributes a week over every card at once), so \
                         that combination is refused rather than stored."
                },
                "scope": {
                    "type": "string",
                    "enum": ["self", "self+children"],
                    "description":
                        "For `watch`: whose spend counts. Default `self`; `self+children` adds \
                         the cards this one opened. A `turn` watch is `self` only."
                },
                "id": {
                    "type": "integer",
                    "description": "For `unwatch`: the watch number `list` showed."
                }
            },
            "required": ["verb"],
            "additionalProperties": false
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn keys() -> PeriodKeys {
        PeriodKeys {
            session: "s-1".into(),
            day: "2026-11-12".into(),
            turn: Some(7),
            window: Some("1762900000000".into()),
        }
    }

    #[test]
    fn the_verbs_vocabulary_is_the_docs_and_nothing_else() {
        for m in ["usd", "tokens", "allowance_points"] {
            assert!(Measure::from_str(m).is_ok(), "{m}");
        }
        assert!(Measure::from_str("dollars").is_err());
        for p in ["session", "day", "turn", "window"] {
            assert!(Period::from_str(p).is_ok(), "{p}");
        }
        assert!(Period::from_str("week").is_err());
        assert_eq!(Scope::from_str("self").unwrap(), Scope::SelfOnly);
        assert_eq!(Scope::from_str("self+children").unwrap(), Scope::WithChildren);
    }

    #[test]
    fn a_measure_and_period_that_could_not_fire_are_refused() {
        assert!(rules::answerable(Measure::AllowancePoints, Period::Window).is_ok());
        assert!(rules::answerable(Measure::AllowancePoints, Period::Session).is_err());
        assert!(rules::answerable(Measure::Usd, Period::Window).is_err());
        assert!(rules::answerable(Measure::Usd, Period::Session).is_ok());
        assert!(rules::answerable(Measure::Tokens, Period::Turn).is_ok());
    }

    #[test]
    fn a_rolling_period_is_a_new_instance_with_no_cron() {
        let k = keys();
        assert_eq!(rules::instance_key(Period::Session, &k).unwrap(), "session:s-1");
        assert_eq!(rules::instance_key(Period::Day, &k).unwrap(), "day:2026-11-12");
        assert_eq!(rules::instance_key(Period::Turn, &k).unwrap(), "turn:7");
        assert_eq!(
            rules::instance_key(Period::Window, &k).unwrap(),
            "window:1762900000000"
        );
        /* The next day is a different string, which is the whole restart. */
        let tomorrow = PeriodKeys { day: "2026-11-13".into(), ..k.clone() };
        assert_ne!(
            rules::instance_key(Period::Day, &k),
            rules::instance_key(Period::Day, &tomorrow)
        );
        /* A period with no instance now has none, and is not compared as zero. */
        let idle = PeriodKeys { turn: None, ..k };
        assert_eq!(rules::instance_key(Period::Turn, &idle), None);
    }

    #[test]
    fn a_threshold_is_passed_and_not_reached() {
        assert!(!rules::breached(10.0, 10.0));
        assert!(rules::breached(10.0, 10.0001));
        assert!(!rules::breached(10.0, f64::NAN));
    }

    #[test]
    fn the_breach_line_is_the_sentence_the_doc_promises() {
        assert_eq!(
            rules::breach_line(Measure::Usd, 10.40, 10.0, Period::Session, Scope::SelfOnly),
            "$10.40 of $10, this session"
        );
        assert_eq!(
            rules::breach_line(Measure::Tokens, 1_200_000.0, 1_000_000.0, Period::Day, Scope::SelfOnly),
            "1.2M tokens of 1M, today"
        );
        assert_eq!(
            rules::breach_line(
                Measure::Usd,
                12.0,
                10.0,
                Period::Session,
                Scope::WithChildren
            ),
            "$12.00 of $10, this session, with the cards it opened"
        );
    }

    #[test]
    fn the_price_book_parses_and_prices_the_same_way_usage_ts_does() {
        let b = rules::parse_book(PRICING).expect("pricing.json parses");
        assert!(b.models.iter().any(|(k, _)| k == "claude-opus-5-5"));
        let exact = rules::rate_for(&b, "claude-opus-5-5").unwrap();
        assert_eq!(exact.input, 4.0);
        /* A dated id prices as the model it is dated from. */
        let dated = rules::rate_for(&b, "claude-sonnet-4-20250514").unwrap();
        assert_eq!(dated.input, 3.0);
        /* A family this build has never seen prices as its newest member. */
        let future = rules::rate_for(&b, "claude-opus-9").unwrap();
        assert_eq!(future.input, 4.0);
        assert!(rules::rate_for(&b, "a-model-from-nowhere").is_none());
    }

    #[test]
    fn the_peak_clock_is_utc_weekdays_only() {
        let b = rules::parse_book(PRICING).unwrap();
        /* 2026-11-12 is a Thursday (`getUTCDay` 4). 02:00 UTC is peak, 05:00 is
           not, and both instants are `Date.UTC(2026, 10, 12, h)`. */
        let thu_02 = 1_794_448_800_000; /* 2026-11-12T02:00:00Z */
        let thu_05 = 1_794_459_600_000; /* 2026-11-12T05:00:00Z */
        assert!(rules::peak_hour(&b.peak, thu_02));
        assert!(!rules::peak_hour(&b.peak, thu_05));
        let on = rules::rate_at(&b, "deepseek-flash", thu_02).unwrap();
        let off = rules::rate_at(&b, "deepseek-flash", thu_05).unwrap();
        assert_eq!(on.input, 0.3);
        assert_eq!(off.input, 0.15, "off-peak is half");
        /* A Claude model has one clock and is the same at every hour. */
        assert_eq!(
            rules::rate_at(&b, "claude-opus-5-5", thu_02),
            rules::rate_at(&b, "claude-opus-5-5", thu_05)
        );
    }

    #[test]
    fn a_provider_card_is_priced_as_the_model_it_was_billed_as() {
        assert_eq!(
            rules::billed_model("claude-opus-5-5", "deepseek"),
            "deepseek-v4-pro"
        );
        assert_eq!(
            rules::billed_model("claude-sonnet-5-5", "deepseek"),
            "deepseek-flash"
        );
        assert_eq!(rules::billed_model("claude-opus-5-5", "claude"), "claude-opus-5-5");
    }

    #[test]
    fn an_unknown_model_is_unpriced_rather_than_zero() {
        let b = rules::parse_book(PRICING).unwrap();
        assert_eq!(rules::price(&b, "model-of-the-future", 0, 1, 1, 0, 0, 0), None);
    }

    #[test]
    fn a_card_that_is_not_there_is_an_error_not_an_empty_answer() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        assert!(card_row(&conn, "nope").is_none());
    }

    #[test]
    fn the_four_verbs_are_split_across_a_read_tool_and_the_tool_that_writes() {
        /* Plan mode relies on `readOnlyHint`, and `ask.rs` asserts both
           directions of its list, so the verbs that write cannot share a tool
           with the ones that do not. §11.13 records the split. */
        let read = spend_schema();
        assert_eq!(read["name"], SPEND_TOOL);
        let verbs = read["inputSchema"]["properties"]["verb"]["enum"].as_array().unwrap();
        let verbs: Vec<&str> = verbs.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(verbs, vec!["read", "list"]);
        assert_eq!(read["inputSchema"]["required"][0], "verb");

        let watch = watch_schema();
        assert_eq!(watch["name"], SPEND_WATCH_TOOL);
        let verbs = watch["inputSchema"]["properties"]["verb"]["enum"].as_array().unwrap();
        let verbs: Vec<&str> = verbs.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(verbs, vec!["watch", "unwatch"]);
        assert!(watch["inputSchema"]["properties"]["at"].is_object());
    }

    #[test]
    fn a_filetime_is_converted_in_milliseconds_not_microseconds() {
        /* 1970-01-01T00:00:00Z is exactly the epoch offset into FILETIME. The
           first version divided by ten and put "today" in the year 2400, so
           every `day` watch measured zero, silently. */
        assert_eq!(ticks_to_ms(116_444_736_000_000_000), 0);
        for ms in [1_794_441_600_000i64, 1_794_448_800_000, 1_700_000_000_000] {
            let ticks = ((ms + 11_644_473_600_000) as u64) * 10_000;
            assert_eq!(ticks_to_ms(ticks), ms);
        }
    }
}
