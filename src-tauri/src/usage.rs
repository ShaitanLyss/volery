//! What Claude Code has spent, read off the transcripts it writes anyway.
//!
//! The limits this answers to are **per account, not per app** — a five-hour
//! window and a weekly one, both counting every turn taken on this machine
//! whether Skein spawned it or a terminal did. So the source has to be the same
//! one `history.ts` reads for scrollback: `~/.claude/projects/<slug>/*.jsonl`,
//! every session on the machine, not Skein's own `turn` table. The `turn` table
//! knows only what this wall did, which is the wrong denominator for "am I about
//! to be cut off" and is empty for cards opened before it started recording
//! properly (see `migrate_v7`).
//!
//! Three facts about the file format carry this whole module:
//!
//! - **One API response is several records.** A turn with a thinking block and a
//!   text block writes *two* `assistant` lines, and both carry the same
//!   `message.usage` verbatim — the same numbers, not halves. Summed naively a
//!   reasoning turn counts two to five times over. So a line is folded in only
//!   once per `message.id` + `requestId`, which is the pair that identifies one
//!   request. Probed 2026-08-14 against claude 2.1.229's own transcripts.
//! - **`usage.iterations[]` repeats the same field names.** `input_tokens` and
//!   friends appear again inside it, per iteration, so nothing here may match on
//!   a bare key name — the record is parsed properly and read by path.
//! - **Cache writes are two prices, and the file says which.**
//!   `cache_creation.ephemeral_5m_input_tokens` and `…_1h_…` are 1.25x and 2x
//!   input respectively — a factor of 1.6 between two numbers it would be easy
//!   to add together. `store.rs::migrate_v7` had to separate reads from writes
//!   for the same reason; this is the next split down and it is free, because
//!   the transcript already keeps them apart.
//!
//! Rust answers in facts and never in verbs — the split `perf.rs` draws. What a
//! token *costs*, which window it falls in, and what to call the reading are
//! `usage.ts`'s, which is pure and tested. This file returns buckets.

use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// How finely time is cut. Five minutes over eight days is ~2300 buckets per
/// model, which is a JSON payload measured in hundreds of kilobytes rather than
/// megabytes — and the only thing coarser buckets cost is where exactly a
/// rolling window's trailing edge falls, which moves a five-hour reading by at
/// most a bucket's worth.
const BUCKET_MS: i64 = 5 * 60 * 1000;

/// How far back anything is kept. The widest window anybody reads is a week;
/// the day of slack is so a reading taken just after midnight still has a whole
/// week behind it, and so the previous week is there to compare against.
const KEEP_MS: i64 = 8 * 24 * 60 * 60 * 1000;

/// A transcript far larger than any real one, refused rather than read. A tail
/// read is bounded by the offset we already hold; this bounds the *first* read
/// of a file we have never seen.
const MAX_FILE: u64 = 512 * 1024 * 1024;

#[derive(Default)]
pub struct Usage(Mutex<Index>);

#[derive(Default)]
struct Index {
    /// How far into each file we have already folded. The whole reason a poll
    /// every few seconds is affordable: the first pass reads whatever a week of
    /// work amounts to, and every pass after it reads only what was appended.
    files: HashMap<PathBuf, u64>,
    /// Every request already counted, and which bucket it landed in — the
    /// bucket is carried so the set can be pruned on the same clock the
    /// buckets are, rather than growing for the life of the process.
    seen: HashMap<String, i64>,
    totals: HashMap<(i64, String), Totals>,
}

#[derive(Default, Clone, Copy)]
pub(crate) struct Totals {
    pub(crate) input: i64,
    pub(crate) output: i64,
    pub(crate) cache_read: i64,
    pub(crate) write_5m: i64,
    pub(crate) write_1h: i64,
}

/// One request, as the transcript wrote it, parsed once for both readers.
///
/// There is **one walker** (`docs/ANALYTICS.md` §7.1) and this is what makes
/// that literal rather than a promise: the ledger's fold and the analytics
/// sink are handed the same parse, so no line is ever read twice and no line is
/// visible to one of them and not the other. The fields past `tokens` are
/// analytics' alone; the ledger ignores them, which costs a struct that is a
/// little wider than `absorb` was.
#[derive(Clone)]
pub(crate) struct Record {
    /// `message.id` + `requestId` — the pair that identifies one request,
    /// however many content blocks it was written out as.
    pub(crate) key: String,
    pub(crate) at: i64,
    pub(crate) model: String,
    pub(crate) tokens: Totals,
    pub(crate) session: String,
    /// The subagent id the record carries, or `''` for the card's own thread.
    pub(crate) agent: String,
    pub(crate) effort: String,
    /// The CLI version that made the request (`2.1.319`).
    pub(crate) cli: String,
    /// The working directory's last segment, never the path (§7.3).
    pub(crate) project: String,
    /// `sdk-cli` for a `--print` card, `cli` for an interactive terminal.
    pub(crate) entrypoint: String,
}

/// The cheap gate, the parse, and nothing about whether anybody wants the
/// record: `absorb_record` applies the ledger's window and its dedup, and the
/// analytics sink applies its own. Splitting it here is what lets one parse
/// feed both.
pub(crate) fn read_record(line: &str) -> Option<Record> {
    /* The cheap gate first. Most lines in a transcript are prompts, tool calls,
       tool results and Claude Code's own bookkeeping records, none of which
       carry usage — and parsing them properly is most of what a pass costs. */
    if !line.contains("\"type\":\"assistant\"") {
        return None;
    }
    let rec = serde_json::from_str::<serde_json::Value>(line).ok()?;
    if rec.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }
    let msg = rec.get("message")?;
    let usage = msg.get("usage")?;

    let at = rec
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(epoch_ms)?;

    /* Synthetic messages are Claude Code talking to itself — an API error
       rendered as an assistant turn — and they carry a zeroed usage under a
       model name no price list has. Left in they would be a model row on the
       widget that never costs anything, and a fact under a model no query layer
       can name. */
    let model = msg.get("model").and_then(|v| v.as_str()).unwrap_or("");
    if model.is_empty() || model.starts_with('<') {
        return None;
    }

    /* One request, however many content blocks it was written out as. The
       record's own `uuid` is the fallback rather than a reason to skip: a line
       with no `message.id` is a shape we have not seen, and counting it once is
       a better failure than dropping it. */
    let id = msg
        .get("id")
        .and_then(|v| v.as_str())
        .or_else(|| rec.get("uuid").and_then(|v| v.as_str()))
        .unwrap_or("");
    let req = rec.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
    let key = format!("{id}|{req}");

    let creation = usage.get("cache_creation");
    let write_5m = int(creation.and_then(|c| c.get("ephemeral_5m_input_tokens")));
    let write_1h = int(creation.and_then(|c| c.get("ephemeral_1h_input_tokens")));
    let created = int(usage.get("cache_creation_input_tokens"));
    /* The two TTLs are 1.25x and 2x input, a factor of 1.6 apart. A record with
       no breakdown is charged at the cheaper of the two rather than dropped:
       under-reporting a cost is a smaller lie than losing the tokens. */
    let (w5, w1) = if write_5m + write_1h > 0 {
        (write_5m, write_1h)
    } else {
        (created, 0)
    };

    let text = |k: &str| {
        rec.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let cwd = text("cwd");

    Some(Record {
        key,
        at,
        model: model.to_string(),
        tokens: Totals {
            input: int(usage.get("input_tokens")),
            output: int(usage.get("output_tokens")),
            cache_read: int(usage.get("cache_read_input_tokens")),
            write_5m: w5,
            write_1h: w1,
        },
        session: text("sessionId"),
        agent: text("agentId"),
        effort: text("effort"),
        cli: text("version"),
        /* Both separators, rather than `Path::file_name`: a transcript's `cwd`
           is a Windows path even when it is read on a machine that does not
           think backslashes separate anything. */
        project: cwd
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_string(),
        entrypoint: text("entrypoint"),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    /// The bucket's own start, in epoch milliseconds.
    at: i64,
    model: String,
    input: i64,
    output: i64,
    cache_read: i64,
    /// Cache writes at the 5-minute TTL — 1.25x input.
    write5m: i64,
    /// Cache writes at the 1-hour TTL — 2x input.
    write1h: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    slices: Vec<Slice>,
    /// Files this pass actually opened, and requests it newly folded in. Both
    /// are reported because a wall that has been quiet and a wall whose reader
    /// is broken produce the same unchanged numbers otherwise.
    pub(crate) read: usize,
    added: i64,
    /// The oldest moment anything here covers.
    since: i64,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Epoch milliseconds from the ISO-8601 stamp Claude Code writes
/// (`2026-08-13T06:07:48.364Z`, always UTC, always that shape).
///
/// Parsed by hand rather than by pulling in a date crate: this is the only date
/// arithmetic in the app, the format is fixed by the writer, and everything
/// downstream wants a number anyway. `limits.rs` shares it rather than growing a
/// second one, which is the whole reason it is `pub(crate)` — two date parsers
/// is two places for a leap year to be wrong.
pub(crate) fn epoch_ms(ts: &str) -> Option<i64> {
    let n = |a: usize, z: usize| -> Option<i64> { ts.get(a..z)?.parse().ok() };
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, s) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    /* Fractional seconds are optional and are the only part of the stamp that
       varies in width; anything unreadable there costs a millisecond, not a
       record. */
    let frac = if ts.as_bytes().get(19) == Some(&b'.') {
        n(20, 23).unwrap_or(0)
    } else {
        0
    };
    Some(
        (days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s) * 1000 + frac
            - offset_ms(ts),
    )
}

/// The `±HH:MM` a stamp may end in, as milliseconds to subtract.
///
/// A transcript is always `Z` and this is always zero for one. `/api/oauth/usage`
/// writes `+00:00` instead — the same instant spelled differently, and harmless
/// today. It is read properly anyway because the *only* thing standing between
/// "harmless" and a reset time five and a half hours out is the server one day
/// answering in something other than UTC, and a countdown wrong by a timezone is
/// exactly the failure this widget exists to prevent.
fn offset_ms(ts: &str) -> i64 {
    let b = ts.as_bytes();
    if b.len() < 6 {
        return 0;
    }
    let i = b.len() - 6;
    let sign = match b[i] {
        b'+' => 1,
        b'-' => -1,
        _ => return 0,
    };
    if b[i + 3] != b':' {
        return 0;
    }
    let n = |a: usize, z: usize| -> i64 { ts.get(a..z).and_then(|s| s.parse().ok()).unwrap_or(0) };
    sign * (n(i + 1, i + 3) * 3600 + n(i + 4, i + 6) * 60) * 1000
}

/// Days since 1970-01-01 for a proleptic Gregorian date — Howard Hinnant's
/// `days_from_civil`, which is the standard closed form and handles the century
/// rules without a table.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn int(v: Option<&serde_json::Value>) -> i64 {
    v.and_then(|v| v.as_i64()).unwrap_or(0).max(0)
}

/// Fold one parsed request into the ledger, if it is inside the window and
/// nobody has counted it yet. Returns whether anything was added.
///
/// The order of the three gates is the ledger's and is load-bearing: the window
/// drops a record **before** it is remembered, so a record too old to count
/// never fills the dedup set (`anything_older_than_the_window_is_dropped_before
/// _it_is_remembered`). The parse moved out from under this when the analytics
/// sink arrived; what it decides did not.
fn absorb_record(index: &mut Index, rec: &Record, cutoff: i64) -> bool {
    if rec.at < cutoff {
        return false;
    }
    if index.seen.contains_key(&rec.key) {
        return false;
    }

    let bucket = rec.at - rec.at.rem_euclid(BUCKET_MS);
    let t = index.totals.entry((bucket, rec.model.clone())).or_default();
    t.input += rec.tokens.input;
    t.output += rec.tokens.output;
    t.cache_read += rec.tokens.cache_read;
    t.write_5m += rec.tokens.write_5m;
    t.write_1h += rec.tokens.write_1h;

    index.seen.insert(rec.key.clone(), bucket);
    true
}

/// Fold one transcript line in, if it is a request nobody has counted yet.
/// Returns whether anything was added.
///
/// The ledger's own entry, kept as a line-in/answer-out function because that
/// is what its tests are written against, and untouched by this phase on
/// purpose: the pass parses once and hands the same `Record` to both readers,
/// so this is the wrapper the tests already call rather than the body they now
/// exercise through it.
#[cfg(test)]
fn absorb(index: &mut Index, line: &str, cutoff: i64) -> bool {
    match read_record(line) {
        Some(rec) => absorb_record(index, &rec, cutoff),
        None => false,
    }
}

/// How deep the walk goes. `<slug>/<session>/subagents/<file>` is three levels
/// under the root, so this reaches it with room to spare — and being bounded at
/// all is what turns a symlink loop under a directory we do not own into a
/// missing file rather than a hang.
const MAX_DEPTH: usize = 5;

/// Every session file under the projects root, at whatever depth.
///
/// **Two levels is the obvious shape and it is wrong.** Subagent transcripts —
/// every turn a Task-tool agent took — are written to
/// `<slug>/<session>/subagents/agent-*.jsonl`, one level below the session file
/// that spawned them, and on this machine that is 194 files out of 507. Probed
/// 2026-08-14. Those turns spend real tokens against the same limits, so a walk
/// that stopped at the session file would under-report agent-heavy work by most
/// of what it cost — and would do it silently, since the reading it produced
/// would still look like a plausible number.
///
/// Recursing costs nothing in correctness even where the two overlap: a request
/// is folded in once per `message.id` + `requestId` whichever file it turns up
/// in, so a record appearing in both a subagent's transcript and its parent's
/// is still counted once.
fn transcripts(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        /* `file_type` on a directory entry does not follow symlinks, so a link
           to a directory is neither walked nor mistaken for one — which is the
           second half of the loop guard. */
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, depth + 1, out),
            Ok(t) if t.is_file() => {
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    out.push(p);
                }
            }
            _ => {}
        }
    }
}

/// Bring the ledger up to date and hand back everything inside the window.
///
/// Cheap to call often, which is the point: the first pass after launch reads a
/// week of transcripts, and every pass after it reads the handful of bytes that
/// were appended since. Nothing here is incremental about the *answer* — the
/// full set of buckets comes back each time — because it is small and because a
/// caller holding a partial copy is a second place for the two to disagree.
///
/// Off the main thread, via `crate::off_main`: the first pass after launch reads
/// a week of transcripts and holds the index mutex across the lot, and on the
/// main thread that was the wall freezing at the moment it was being painted.
#[tauri::command]
pub async fn read_usage(app: AppHandle) -> Result<Scan, String> {
    crate::off_main(move || scan_with(&app, &app.state::<Usage>(), None)).await?
}

/// The analytics collector's way in: the same walk, with a sink attached.
///
/// `docs/ANALYTICS.md` §7.1 is why this is a parameter rather than a second
/// reader. Two walkers would be two offset tables and a class of bug where one
/// sees a request the other does not; this is one walk, one parse per line, and
/// two readers each applying their own window and their own dedup.
pub(crate) fn scan_with_sink(
    app: &AppHandle,
    state: &Usage,
    reading: &mut crate::analytics::Reading,
) -> Result<Scan, String> {
    scan_with(app, state, Some(reading))
}

/// The scan itself, apart from the command that carries it.
fn scan_with(
    app: &AppHandle,
    state: &Usage,
    mut reading: Option<&mut crate::analytics::Reading>,
) -> Result<Scan, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    let root = home.join(".claude").join("projects");

    let now = now_ms();
    let cutoff = now - KEEP_MS;
    let mut index = state.0.lock().unwrap();

    let mut read = 0usize;
    let mut added = 0i64;
    let mut alive: Vec<PathBuf> = Vec::new();

    for path in transcripts(&root) {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let len = meta.len();
        /* The last write, as a number. The ledger reads it to decide whether a
           file it has never opened can hold anything; the sink reads it to
           decide whether a file was replaced rather than appended to. */
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        alive.push(path.clone());
        if let Some(r) = reading.as_deref_mut() {
            r.alive(&path);
        }

        let known = index.files.get(&path).copied();
        /* Does the analytics sink want this file, and from where? `None` when
           there is no sink at all. It answers 0 for a file it has never seen
           inside its own window, and its own offset — or zero, for a file
           replaced under it — for one it has. */
        let (wants_analytics, analytic_from) = match reading.as_deref() {
            Some(r) => r.reach(&path, len, mtime),
            None => (false, None),
        };
        /* A file the ledger has never opened whose last write predates the
           window cannot hold anything *the ledger* wants. This is what keeps
           the first pass to the week's traffic rather than to every session
           ever recorded. The sink gets its own say first: a file eight to
           ninety days old is one analytics still wants and the ledger does
           not. */
        let stale = known.is_none() && mtime < cutoff;
        if stale && !wants_analytics {
            index.files.insert(path, len);
            continue;
        }
        /* A first read is bounded in what it will take in one go; a file we
           already hold an offset into is bounded by that offset and is read as
           it always was. */
        if len > MAX_FILE && known.is_none() {
            index.files.insert(path.clone(), len);
            if let Some(r) = reading.as_deref_mut() {
                if wants_analytics {
                    r.refused(&path, len, mtime);
                }
            }
            continue;
        }

        /* A shorter file than we left is one that was replaced rather than
           appended to, so the offset we hold means nothing. Re-reading it is
           safe because dedup is by request, not by position.
           **The start is the earliest position any reader that wants this file
           holds**, and each reader is asked before the minimum is taken. A file
           the ledger has given up on and analytics has not — eight to ninety
           days old, which is the whole first backfill — must start at zero, and
           folding the two into one `if` is how that file would have been
           skipped instead. */
        let mut off = len;
        if !stale {
            /* The ledger's own position, or zero for a file that shrank under
               it. **Not `known.unwrap_or(0)` alone**: an offset past the end is
               a file replaced by a shorter one, and taking the minimum of a
               value above `len` would have let `off > len` here and then left
               the file unread, which is the truncation this branch exists to
               catch. The sink has its own answer to the same question
               (`resume_at`) and the earlier of the two wins. */
            off = off.min(known.filter(|k| *k <= len).unwrap_or(0));
        }
        if wants_analytics {
            off = off.min(analytic_from.unwrap_or(0));
        }
        if off == len {
            /* Nothing new for either. The sink still learns the file's shape,
               so a replacement that shortened it to the same length is caught
               by the mtime next time rather than never. */
            if let Some(r) = reading.as_deref_mut() {
                if wants_analytics {
                    r.skipped(&path, off, mtime, len);
                }
            }
            continue;
        }

        let Ok(mut f) = File::open(&path) else {
            continue;
        };
        if f.seek(SeekFrom::Start(off)).is_err() {
            continue;
        }
        read += 1;
        let from = off;

        let mut r = BufReader::new(&mut f);
        let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
        let mut line: Vec<u8> = Vec::new();
        /* Read the tail whole and split it here rather than using `read_line`,
           which wants valid UTF-8 and fails the entire read on one bad byte in
           a tool result. */
        if r.read_to_end(&mut buf).is_err() {
            continue;
        }
        for byte in buf {
            off += 1;
            if byte != b'\n' {
                line.push(byte);
                continue;
            }
            /* Only a line that ended is a line: the last write may still be in
               flight, and consuming half a record would lose it for good. */
            let text = String::from_utf8_lossy(&line);
            match read_record(&text) {
                Some(rec) => {
                    if absorb_record(&mut index, &rec, cutoff) {
                        added += 1;
                    }
                    if let Some(sink) = reading.as_deref_mut() {
                        sink.request(&rec);
                    }
                }
                /* Everything that is not a request: the two records analytics
                   needs from elsewhere in the file — the session's owner and
                   the agent that a subagent was launched as, and, since phase
                   5a, the one thing in the file a person actually said. Both of
                   the first two are rare enough to be worth a substring before
                   a parse, and the prompt reader is gated the same way inside
                   `sessions::fold`. */
                None => {
                    if let Some(sink) = reading.as_deref_mut() {
                        sink.other(&text);
                        sink.prompt(&text);
                    }
                }
            }
            line.clear();
        }
        /* Whatever is left has no newline yet, so it stays unread — `off` was
           advanced only over the bytes that were consumed. */
        off -= line.len() as u64;
        index.files.insert(path.clone(), off);
        if let Some(sink) = reading.as_deref_mut() {
            if wants_analytics {
                sink.consumed(&path, off, mtime, len, off - from);
            }
        }
    }

    /* Forget files that have gone, or a long-running studio accumulates an
       offset per session ever recorded. */
    if alive.len() != index.files.len() {
        let keep: std::collections::HashSet<&PathBuf> = alive.iter().collect();
        index.files.retain(|p, _| keep.contains(p));
    }
    index.totals.retain(|(at, _), _| *at >= cutoff);
    index.seen.retain(|_, at| *at >= cutoff);

    let mut slices: Vec<Slice> = index
        .totals
        .iter()
        .map(|((at, model), t)| Slice {
            at: *at,
            model: model.clone(),
            input: t.input,
            output: t.output,
            cache_read: t.cache_read,
            write5m: t.write_5m,
            write1h: t.write_1h,
        })
        .collect();
    /* Sorted here rather than in the front end, which would otherwise sort the
       same list on every reading it takes. */
    slices.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.model.cmp(&b.model)));

    Ok(Scan {
        slices,
        read,
        added,
        since: cutoff,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_transcript_stamp_becomes_a_number() {
        /* The exact stamp shape claude 2.1.229 writes. */
        assert_eq!(epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(epoch_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(
            epoch_ms("2026-08-13T06:07:48.364Z"),
            Some(1_786_601_268_364)
        );
        /* Leap day, and the century rule either side of it. */
        assert_eq!(
            epoch_ms("2024-02-29T00:00:00.000Z").unwrap()
                - epoch_ms("2024-02-28T00:00:00.000Z").unwrap(),
            86_400_000
        );
        assert_eq!(
            epoch_ms("2100-03-01T00:00:00.000Z").unwrap()
                - epoch_ms("2100-02-28T00:00:00.000Z").unwrap(),
            86_400_000,
            "2100 is not a leap year"
        );
    }

    #[test]
    fn a_stamp_with_no_fraction_is_still_a_stamp() {
        assert_eq!(epoch_ms("2026-08-13T06:07:48Z"), Some(1_786_601_268_000));
    }

    /// The shape `/api/oauth/usage` answers in — microseconds and a written-out
    /// offset, where a transcript writes milliseconds and `Z`.
    #[test]
    fn an_offset_is_read_rather_than_assumed_to_be_zero() {
        let z = epoch_ms("2026-08-13T06:07:48.364Z").unwrap();
        assert_eq!(epoch_ms("2026-08-13T06:07:48.364762+00:00"), Some(z));
        assert_eq!(
            epoch_ms("2026-08-13T16:07:48.364762+10:00"),
            Some(z),
            "the same instant, said in Sydney"
        );
        assert_eq!(
            epoch_ms("2026-08-13T02:07:48.364762-04:00"),
            Some(z),
            "and in New York"
        );
        assert_eq!(
            epoch_ms("2026-08-13T05:37:48.364762-00:30"),
            Some(z),
            "a half-hour offset is still an offset"
        );
    }

    #[test]
    fn nonsense_is_refused_rather_than_guessed_at() {
        assert_eq!(epoch_ms(""), None);
        assert_eq!(epoch_ms("not a date at all!!"), None);
        assert_eq!(epoch_ms("2026-13-01T00:00:00.000Z"), None);
    }

    /// The bug this whole module is arranged around: one API response written
    /// out as several records, each carrying the *same* usage.
    #[test]
    fn one_request_written_twice_is_counted_once() {
        let mut index = Index::default();
        let line = |uuid: &str| {
            format!(
                r#"{{"type":"assistant","uuid":"{uuid}","requestId":"req_1",
                 "timestamp":"2026-08-13T06:07:48.364Z",
                 "message":{{"model":"claude-opus-5","id":"msg_1","usage":{{
                   "input_tokens":2,"output_tokens":408,
                   "cache_read_input_tokens":18022,
                   "cache_creation_input_tokens":10556,
                   "cache_creation":{{"ephemeral_1h_input_tokens":10556,
                                      "ephemeral_5m_input_tokens":0}},
                   "iterations":[{{"input_tokens":2,"output_tokens":408}}]}}}}}}"#
            )
        };
        assert!(absorb(&mut index, &line("a"), 0));
        assert!(!absorb(&mut index, &line("b"), 0), "same request, second block");

        let t = index.totals.values().next().copied().unwrap();
        assert_eq!(t.output, 408, "the thinking block and the text block are one turn");
        assert_eq!(t.write_1h, 10556);
        assert_eq!(t.write_5m, 0, "a 1h write is not a 5m write — they are 1.6x apart");
        assert_eq!(t.input, 2, "usage.iterations[] repeats the field names");
    }

    #[test]
    fn a_line_with_nothing_to_count_is_left_alone() {
        let mut index = Index::default();
        assert!(!absorb(&mut index, r#"{"type":"user","message":{}}"#, 0));
        assert!(!absorb(&mut index, "not json at all", 0));
        assert!(!absorb(
            &mut index,
            r#"{"type":"assistant","timestamp":"2026-08-13T06:07:48.364Z",
                "message":{"model":"<synthetic>","id":"m","usage":{"output_tokens":9}}}"#,
            0
        ));
        assert!(index.totals.is_empty());
    }

    #[test]
    fn anything_older_than_the_window_is_dropped_before_it_is_remembered() {
        let mut index = Index::default();
        let line = r#"{"type":"assistant","uuid":"a","requestId":"r",
            "timestamp":"2020-01-01T00:00:00.000Z",
            "message":{"model":"claude-opus-5","id":"m","usage":{"output_tokens":9}}}"#;
        assert!(!absorb(&mut index, line, 1_700_000_000_000));
        assert!(index.seen.is_empty(), "a dropped record must not fill the dedup set");
    }

    #[test]
    fn a_cache_write_with_no_breakdown_still_counts() {
        let mut index = Index::default();
        let line = r#"{"type":"assistant","uuid":"a","requestId":"r",
            "timestamp":"2026-08-13T06:07:48.364Z",
            "message":{"model":"claude-opus-5","id":"m","usage":{
              "cache_creation_input_tokens":1000}}}"#;
        assert!(absorb(&mut index, line, 0));
        let t = index.totals.values().next().copied().unwrap();
        assert_eq!(t.write_5m, 1000, "charged at the cheaper rate, not dropped");
    }

    #[test]
    fn records_land_in_five_minute_buckets() {
        let mut index = Index::default();
        for (i, ts) in ["06:01:00", "06:04:59", "06:05:00"].iter().enumerate() {
            let line = format!(
                r#"{{"type":"assistant","uuid":"u{i}","requestId":"r{i}",
                   "timestamp":"2026-08-13T{ts}.000Z",
                   "message":{{"model":"claude-opus-5","id":"m{i}",
                   "usage":{{"output_tokens":1}}}}}}"#
            );
            assert!(absorb(&mut index, &line, 0));
        }
        assert_eq!(index.totals.len(), 2, "two buckets, not three records");
    }
}
