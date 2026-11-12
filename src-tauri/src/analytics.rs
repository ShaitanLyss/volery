//! What the wall has spent, written down as facts.
//!
//! This is phase 2b of `docs/ANALYTICS.md`: the ingest. It reads the same
//! transcripts `usage.rs` already walks — **one reader, two sinks** (§7.1) —
//! and writes the fine and hourly token tiers plus the session row each card and
//! terminal is.
//!
//! Three things about the arrangement are the design rather than the plumbing:
//!
//! - **It is a sink on the existing pass, not a second walker.** Two walkers
//!   would be two offset tables and a class of bug where one sees a request the
//!   other does not. `usage::scan_with_sink` parses each line once and hands the
//!   same `Record` to the ledger's fold and to this one.
//! - **It has its own clock.** The ledger's twenty-second beat only runs while a
//!   usage widget is on the wall (`usage.md`), so recording cannot ride it: a
//!   wall with no widget would record nothing. `start` is a collector of its own
//!   at sixty seconds, and the ledger's beat is simply an extra caller.
//! - **The store lock is never held across file IO, and never for a whole
//!   backfill.** The offsets are read under it and it is released for the walk.
//!   The write is then cut into `CHUNK_REQUESTS`-sized transactions, each taking
//!   the lock and handing it back. `open_turn`, `record_turn` and every other
//!   command wait on that mutex, so holding it for a file parse — or for the
//!   deep pass's ninety thousand requests — would stop the wall.
//!
//! What a fact is, is §3.1's grain and §4's attribution ladder. Since phase 6a
//! the same walk also feeds **the tool half** (§3.7: a mutable `tool_pending`
//! row per call, folded into `tool_fact` and `tool_hour` once its turn has a
//! cost) and **the work half** (§3.9: a receipt read off a shell result, and a
//! bounded local `git log` attributed by branch, turn interval and file touch).
//! What is deliberately absent: the prompt vault's workings, allowances and
//! machine facts. Those are other phases and other tables.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::prompt::{self, Form};
use crate::redact;
use crate::sessions::{self, Folded};
use crate::store::Store;
use crate::usage::{epoch_ms, now_ms, Record};

/// §3.1's grain. The same five minutes the ledger cuts, so the two readings can
/// be compared bucket for bucket.
pub(crate) const BUCKET_MS: i64 = 5 * 60 * 1000;

/// §3.6's hourly tier: a UTC hour start, because a day boundary is a timezone
/// and two machines in two timezones must not disagree about where an hour goes.
pub(crate) const HOUR_MS: i64 = 60 * 60 * 1000;

/// How long the fine tier and the per-request dedupe are kept (§3.6, §7.2).
/// The hourly tier outlives it and is what a year view reads.
pub(crate) const FINE_KEEP_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// How often the collector looks. The ledger's twenty seconds would be a
/// hundredth of the value at ten times the cost: a five-hour window moves by a
/// third of a percent in twenty seconds, and the fine grain is five minutes.
const BEAT_EVERY: Duration = Duration::from_secs(60);

/// How close two writes to one path must be to be one churn episode (§3.9).
///
/// **A churn episode is a run, not a write.** Three edits to `CLAUDE.md` in ten
/// minutes is one episode and its cost is the excess after the last write,
/// because the earlier ones were overwritten before anybody read them. Ten
/// minutes is the same span a conflict episode is measured over, so the two
/// readings on the coordination strip are cut at one scale.
pub(crate) const CHURN_GAP_MS: i64 = 10 * 60 * 1000;

/// How far back the fold re-reads events, and how long it waits for a payer's
/// next request.
///
/// **The wait is the lookback, not a shorter clock, because the excess is paid
/// at a card's next start** (§20 decision 19). A card that was running makes its
/// first request seconds after the event, so its answer is unchanged by this
/// bound; the bound is what reaches a card that was at rest and is woken hours
/// later, whose resume request *is* the re-read. Thirty minutes, as this first
/// had it, left the commonest case on a quiet wall permanently unmeasured.
///
/// It is deliberately not longer than the lookback: an event that has aged out
/// of the scan can never be revisited, so a wait past it would be a promise the
/// fold cannot keep. The lookback is six hours, and a card roused inside it is
/// measured on the pass that sees the request.
pub(crate) const ATTRIBUTE_WAIT_MS: i64 = ATTRIBUTE_LOOKBACK_MS;
const ATTRIBUTE_LOOKBACK_MS: i64 = 6 * 60 * 60 * 1000;

/// How many requests before an event the median is taken over, and the fewest
/// that add up to a measurement (§3.9).
pub(crate) const MEDIAN_REQUESTS: usize = 20;
pub(crate) const MEDIAN_FLOOR: usize = 5;

/// The backfill's bound per pass: files and bytes.
///
/// The one-off walk reads every transcript from the beginning, because those
/// files are on the CLI's own deletion clock. It is bounded per pass rather
/// than one long read: the collector's beat is a minute, and a wall that spent
/// that minute walking a year of transcripts would answer no card meanwhile.
const BACKFILL_FILES: usize = 12;
const BACKFILL_BYTES: u64 = 64 * 1024 * 1024;
/// A transcript larger than this is not read by the backfill at all. The
/// measured maximum on this machine is ~11 MB; this is a refusal with a number
/// beside it rather than a silent hole, and it is counted in the log line.
const BACKFILL_FILE_CAP: u64 = 128 * 1024 * 1024;

/// The cap on a path stored as an invalidation's `ref`. It is a label, not a
/// document: the path is also the whole of what makes one event different from
/// another, so it is clipped with `preview` (an ellipsis, no marker) rather
/// than `keep`.
pub(crate) const MAX_INVALIDATE_REF: usize = 400;

/// How many requests one store transaction carries.
///
/// **The mutex is the reason this exists.** Every command that touches the store
/// waits on it, and the synchronous ones run on the thread that paints the wall,
/// so a single transaction over the deep pass's ~90,000 requests is a freeze for
/// as long as it takes. A chunk bounds the wait instead: at most four rows per
/// request (one fact, one hour row, one `usage_seen` key, one session row) makes
/// this 4,000 rows, measured on this machine's SQLite in WAL at a median 15 ms
/// and a 34 ms worst case; one card's real requests collapse their facts and
/// hours and measure at a median 14 ms. Ninety chunks over the corpus cost the
/// same in total as the one transaction did (401 ms against 409 ms, no fsync),
/// so the protection is paid for out of contention rather than throughput.
///
/// The number is small on purpose. Per-chunk overhead is a prepare of four
/// statements and one commit's fsync, which is cheap next to the latency of a
/// command waiting behind it; a larger chunk buys five milliseconds of total
/// work and costs tens of milliseconds of held lock.
const CHUNK_REQUESTS: usize = 1_000;

/* ── what the walk offers the sink ───────────────────────────────────────── */

/// Where this wall left a transcript, as §7.2's durable offset.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Mark {
    pub(crate) offset: u64,
    pub(crate) mtime: i64,
    pub(crate) size: u64,
}

/// Where to start reading a file this wall has seen before.
///
/// **A transcript can be replaced rather than appended to**, and the offset this
/// wall holds then means nothing: reading from it would skip the beginning of a
/// new file. Two signals, both cheap, either of which is enough: a file shorter
/// than the offset, or one whose last write is *older* than the write we
/// recorded while its size differs. A file that merely lost bytes without a new
/// mtime (a truncate in the same tick) is caught by the first; a file replaced by
/// a longer one is caught by the second, since a replacement rewrites the whole
/// file and the mtime of the newest write can only be older than the one we saw
/// if something put an old copy there.
///
/// Re-reading is always safe, which is why both arms go to zero rather than
/// trying to be clever: `usage_seen` is what makes a re-read idempotent (§7.2).
pub(crate) fn resume_at(mark: Option<&Mark>, size: u64, mtime: i64) -> u64 {
    let Some(m) = mark else { return 0 };
    if m.offset > size {
        return 0;
    }
    if mtime < m.mtime && size != m.size {
        return 0;
    }
    m.offset
}

/// What one file contributed this pass, to be written with the facts.
struct FileMark {
    path: String,
    mark: Mark,
}

/// One prompt, as the walk sees it: its form, its kind, and nothing it said.
///
/// **The text does not reach this struct.** `Reading::prompt` classifies and
/// redacts while the line is still the only copy, seals what may be kept, and
/// drops the string, so no prompt body is ever held past the statement that read
/// it. What crosses to the write is the form, its counts, and a
/// `crate::promptvault::Body` — ciphertext, or a note of where the text can be
/// found again.
#[derive(Clone)]
pub(crate) struct Prompt {
    pub(crate) id: String,
    /// The first occurrence's stamp. A replay carries a different one and the
    /// first is what the row keeps (§3.8).
    pub(crate) at: i64,
    pub(crate) session: String,
    /// The working directory's last segment, never the path (§7.3).
    pub(crate) project: String,
    pub(crate) entrypoint: String,
    pub(crate) kind: &'static str,
    pub(crate) form: Form,
    pub(crate) redactions: usize,
    pub(crate) withheld: bool,
    /// What phase 5b decided about this prompt's words: sealed under the active
    /// vault, withheld, or locked with a locator pointing at the line.
    pub(crate) body: crate::promptvault::Body,
}

/// One `tool_use` block, as the call record wrote it (§3.7).
///
/// **The input's text does not reach this struct.** What is kept is the shape:
/// which tool, which server, the subagent type or skill name, the model the
/// call asked for, and whether the result will be a receipt rather than work.
/// A shell command is the largest part of an input and nothing here reads it.
#[derive(Clone, Debug)]
pub(crate) struct ToolCall {
    pub(crate) id: String,
    pub(crate) at: i64,
    pub(crate) session: String,
    /// The agent that made the call, or `''` for the card's own thread.
    pub(crate) agent: String,
    /// `builtin | mcp | skill | agent`.
    pub(crate) kind: &'static str,
    pub(crate) server: String,
    pub(crate) tool: String,
    pub(crate) target: String,
    pub(crate) requested_model: String,
    /// The result is a receipt that returns before the work does (`turns.md`),
    /// so its latency measures the receipt and the face must say so.
    pub(crate) async_: bool,
}

/// One `tool_result` block, or the receipt a `toolUseResult` carried (§3.7).
#[derive(Clone, Debug)]
pub(crate) struct ToolResult {
    pub(crate) id: String,
    pub(crate) at: i64,
    pub(crate) errors: i64,
    /// The size of what came back, never what came back.
    pub(crate) out_bytes: i64,
    /// The agent an `Agent`/`Task` call opened, from the result's `agentId`.
    pub(crate) child_agent: String,
}

/// One artifact or coordination event, read off a tool result (§3.9).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Receipt {
    pub(crate) session: String,
    /// The call this result answers, so `ms` can be measured off its row.
    pub(crate) tool_use_id: String,
    pub(crate) at: i64,
    /// The working directory's last segment, for a session with no card row.
    pub(crate) project: String,
    /// The `gitBranch` the record carried, which is the branch the tree had
    /// checked out when the result was written.
    pub(crate) branch: String,
    pub(crate) kind: &'static str,
    /// The sha, PR number, branch or worktree key.
    pub(crate) reference: String,
    /// How many distinct paths a conflict named.
    pub(crate) conflict_files: i64,
}

/// One write to an instruction file, read off a `tool_use` block (§3.9).
///
/// **Only the path is kept, and only for a file that governs an agent's
/// reading.** The content of a `Write` is the largest part of its input and
/// nothing here reads it: what crosses is that a path was written at an
/// instant, by a session, which is the whole of an invalidation fact.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct InstructionWrite {
    pub(crate) at: i64,
    pub(crate) session: String,
    /// The `tool_use` id, so a re-read of a replaced transcript is recognised.
    pub(crate) tool_use_id: String,
    /// The working directory the record carried, for a session with no card.
    pub(crate) cwd: String,
    /// The path as the tool named it, forward slashes, already clipped.
    pub(crate) path: String,
    /// `instructions` or `rule`.
    pub(crate) kind: &'static str,
}

/// One pass's worth of readings, filled by the walk and written afterwards.
///
/// The batch is why the store lock is not held across file IO: the walk appends
/// here, and only the facts are written under it — a chunk at a time, with the
/// marks and the retention deletes left to one small transaction at the end.
#[derive(Default)]
pub(crate) struct Batch {
    requests: Vec<Record>,
    /// Requests already taken this pass — a file replaced mid-pass can offer
    /// the same request twice, and the DB check cannot see the first one yet.
    keys: HashSet<String>,
    /// Prompts taken this pass, already shaped and already stripped of their
    /// text. See `Prompt`.
    prompts: Vec<Prompt>,
    /// Prompt ids **and their stamps** taken this pass, for the same
    /// replaced-file reason as `keys`.
    ///
    /// The pair rather than the id alone: two records carrying one id at two
    /// times are a genuine replay (§3.8 says a repeat carries a different
    /// stamp) and `seen_count` is what counts it. Keying on the id would drop
    /// the second before the writer could, and only a byte-identical re-read
    /// should be dropped here.
    prompt_ids: HashSet<(String, i64)>,
    /// `tool_use` blocks seen this pass, by `tool_use_id`.
    calls: Vec<ToolCall>,
    /// Results seen this pass. A result may resolve a call an earlier pass
    /// wrote, which is the whole reason `tool_pending` is mutable.
    results: Vec<ToolResult>,
    /// Work receipts parsed off a result: a commit, a push, a conflict. These
    /// are facts of their own and are written in the same pass (§3.9).
    receipts: Vec<Receipt>,
    /// Writes to an instruction file, from a `tool_use` block (§3.9). Kept
    /// apart from `calls` because a call is a shape and this is an event with a
    /// path; the two are read from the same line and neither needs the other.
    writes: Vec<InstructionWrite>,
    /// Write ids already taken this pass, for the replaced-file reason
    /// `call_ids` exists.
    write_ids: HashSet<String>,
    /// Tool-use ids already taken this pass, for the replaced-file reason
    /// `keys` and `prompt_ids` exist.
    call_ids: HashSet<String>,
    result_ids: HashSet<String>,
    /// Session → `accountUuid:organizationUuid`, from any file of the session
    /// that carries a `session-owner` record (§4).
    owners: HashMap<String, String>,
    /// `(session, child agent)` → the agent that launched it. §4.4's link, and
    /// deliberately not `parentUuid`.
    parents: HashMap<(String, String), String>,
    files: Vec<FileMark>,
    /// Every transcript the walk saw, whether or not it was read. `usage_file`
    /// is pruned to this, or a mark for a deleted session would sit in the
    /// table for ever and be loaded once a minute.
    alive: HashSet<String>,
    /// Transcripts over `MAX_FILE` on a first read: refused by both readers and
    /// therefore never ingested. Counted so the report can say so.
    refused: i64,
    bytes: u64,
}

/// The analytics reader, as the walk sees it.
pub(crate) struct Reading {
    marks: HashMap<PathBuf, Mark>,
    cutoff: i64,
    /// The host this wall is, which is part of a body's associated data. Empty
    /// in the suites that build a `Reading` by hand and care only about the
    /// fold, which is why it is a field rather than a parameter threaded
    /// through every test.
    host: String,
    /// The prompt vault, when this process has one. Absent means every body is
    /// ingested `locked` with a locator, which is exactly what a wall with no
    /// vault gets anyway.
    vault: Option<crate::promptvault::PromptVault>,
    batch: Batch,
}

impl Reading {
    pub(crate) fn new(marks: HashMap<PathBuf, Mark>, cutoff: i64) -> Self {
        Reading {
            marks,
            cutoff,
            host: String::new(),
            vault: None,
            batch: Batch::default(),
        }
    }

    /// The vault this pass seals under, and the host a body's binding names.
    ///
    /// Set by `pass` and by nothing else: the walk is the only caller that has
    /// both, and a suite that leaves it off gets the locked path, which is the
    /// honest default for a walk that has no key.
    pub(crate) fn with_vault(
        mut self,
        host: &str,
        vault: crate::promptvault::PromptVault,
    ) -> Self {
        self.host = host.to_string();
        self.vault = Some(vault);
        self
    }

    pub(crate) fn into_batch(self) -> Batch {
        self.batch
    }

    /// Whether this file is inside the analytics window, and from where.
    ///
    /// `None` for a file never seen and too old to hold anything; `Some(0)` for
    /// one never seen and inside the window — which is what makes the first pass
    /// the deep backfill §7.3 describes rather than a fresh start.
    pub(crate) fn reach(&self, path: &Path, size: u64, mtime: i64) -> (bool, Option<u64>) {
        match self.marks.get(path) {
            Some(m) => (true, Some(resume_at(Some(m), size, mtime))),
            None if mtime >= self.cutoff => (true, None),
            None => (false, None),
        }
    }

    /// A transcript that still exists as the walk found it, read or not.
    pub(crate) fn alive(&mut self, path: &Path) {
        self.batch.alive.insert(path.to_string_lossy().to_string());
    }

    /// One request, if it is inside the window and not already in this batch.
    pub(crate) fn request(&mut self, rec: &Record) {
        if rec.at < self.cutoff {
            return;
        }
        /* A record with no session cannot be attributed to anything, and a row
           keyed on an empty session would pool unrelated requests under one
           name. Counted in the report rather than guessed at. */
        if rec.session.is_empty() {
            return;
        }
        if !self.batch.keys.insert(rec.key.clone()) {
            return;
        }
        self.batch.requests.push(rec.clone());
    }

    /// Everything that is not a request. Two records here are the ones §4 needs
    /// and no assistant record carries: the session's owner, and the agent id a
    /// spawning call's result names.
    ///
    /// Both are found by a substring before a parse, because a tool result is
    /// often the largest record in a file and parsing every one of them is the
    /// cost §16 says is not in the assistant-only figure.
    pub(crate) fn other(&mut self, line: &str) {
        if line.contains("\"accountUuid\"") {
            let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else {
                return;
            };
            if rec.get("type").and_then(|v| v.as_str()) != Some("session-owner") {
                return;
            }
            let pick = |k: &str| rec.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
            let (session, account, org) = (pick("sessionId"), pick("accountUuid"), pick("organizationUuid"));
            if session.is_empty() || account.is_empty() || org.is_empty() {
                return;
            }
            /* First one wins: §4 dates the owner by position and the record
               carries no timestamp, and in every file measured the repeats are
               the same owner. A session that genuinely changed funding
               mid-file is the case the *facts* record, per interval. */
            self.batch
                .owners
                .entry(session.to_string())
                .or_insert_with(|| format!("{account}:{org}"));
        } else if line.contains("\"toolUseResult\"") && line.contains("\"agentId\"") {
            let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else {
                return;
            };
            if rec.get("type").and_then(|v| v.as_str()) != Some("user") {
                return;
            }
            let Some(child) = rec
                .get("toolUseResult")
                .and_then(|t| t.get("agentId"))
                .and_then(|v| v.as_str())
            else {
                return;
            };
            let session = rec.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            /* The agent that made the call, or `''` for the card itself. This
               is the *parent* of the child the result names, and it is read off
               the record that carries the call's result — never `parentUuid`,
               which is the message chain inside one file (§4.4). */
            let parent = rec.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
            if session.is_empty() || child.is_empty() {
                return;
            }
            self.batch
                .parents
                .insert((session.to_string(), child.to_string()), parent.to_string());
        }
    }

    /// The tool half of the walk (§3.7).
    ///
    /// **A `tool_use` is on an `assistant` record and its result is on a
    /// `user` one**, which is why this is a reader of its own rather than part
    /// of `request`: `usage::read_record` deliberately refuses every `user`
    /// record, since those are the largest records in a file. This is the
    /// second branch in the same pass §3.7 asks for, and it is called for both
    /// arms of the walk's match — an assistant record carrying a tool call also
    /// carries `usage`, so it never reaches the `other` arm.
    ///
    /// Nothing here keeps an input's text or a result's content: a call is
    /// reduced to its name and shape, and a result to its size, its error bit
    /// and the agent id it names.
    pub(crate) fn tools(&mut self, line: &str) {
        if line.contains("\"tool_use\"") {
            for call in parse_tool_use(line) {
                if call.at < self.cutoff || call.session.is_empty() {
                    continue;
                }
                if !self.batch.call_ids.insert(call.id.clone()) {
                    continue;
                }
                self.batch.calls.push(call);
            }
            /* The invalidation half of the same record (§3.9). A write to an
               instruction file is an event, and it is read here rather than off
               a result because a result names no path: `toolUseResult` carries
               what the call did, not what it was pointed at. */
            for write in parse_writes(line) {
                if write.at < self.cutoff || write.session.is_empty() {
                    continue;
                }
                if !write.tool_use_id.is_empty()
                    && !self.batch.write_ids.insert(write.tool_use_id.clone())
                {
                    continue;
                }
                self.batch.writes.push(write);
            }
        } else if line.contains("\"tool_result\"") {
            for parsed in parse_tool_result(line) {
                if parsed.result.at < self.cutoff {
                    continue;
                }
                for receipt in parsed.receipts {
                    if receipt.at < self.cutoff {
                        continue;
                    }
                    self.batch.receipts.push(receipt);
                }
                if self.batch.result_ids.insert(parsed.result.id.clone()) {
                    self.batch.results.push(parsed.result);
                }
            }
        }
    }

    /// One `user` record, if it is somebody speaking.
    ///
    /// The third reader on the walk (`docs/ANALYTICS.md` §7.1, §3.8), and it is
    /// deliberately built on `sessions::fold` rather than on a filter of its
    /// own: that function already rejects the eight injected markers, the three
    /// flags and a tool result, and a second copy of that list is what would
    /// have shipped a stop note, a task notification and a compaction summary
    /// as human prompts.
    ///
    /// **The text dies here.** The form and the kind are read off it, the
    /// redactor counts what it would take and supplies the redacted text the
    /// vault seals, and the string is dropped before the batch is touched.
    /// Nothing downstream can log a body because nothing downstream has one.
    ///
    /// `path` and `off` are where this line starts in its transcript, which is
    /// what a locator records when the vault is locked: the seam that lets
    /// `seal pending` find the words later without a second walk of every file.
    pub(crate) fn prompt(&mut self, path: &Path, off: u64, line: &str) {
        let Folded::Prompt {
            text,
            images,
            record,
        } = sessions::fold(line)
        else {
            return;
        };
        let pick = |k: &str| record.get(k).and_then(|v| v.as_str()).unwrap_or("").trim();
        let Some(at) = record
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(epoch_ms)
        else {
            return;
        };
        if at < self.cutoff {
            return;
        }
        let session = pick("sessionId");
        /* A prompt with no session cannot be attributed to anything, the same
           rule `request` applies. */
        if session.is_empty() {
            return;
        }
        /* `promptId` is on every user record measured on this machine (4,120 of
           4,120 across the first sixty transcripts). The `uuid` fallback keeps
           a shape we have not seen from being dropped silently, and a record
           with neither is the one thing here that is skipped. */
        let id = match pick("promptId") {
            "" => pick("uuid"),
            id => id,
        };
        if id.is_empty() {
            return;
        }
        if !self.batch.prompt_ids.insert((id.to_string(), at)) {
            return;
        }

        let form = prompt::form(&text, images);
        let kind = prompt::kind(&text);
        /* **Before the text goes, and never bypassed.** The classifier and the
           form read the raw text; this reads the same text and keeps only its
           verdict. A row that says `redactions = 0` without this line having run
           would be a row claiming a prompt was clean. */
        let redacted = redact::redact(&text);
        /* Sealed here, while the redacted text is the only copy and the raw one
           is already out of scope. `decide` is the only thing that may see it,
           and what it hands back is either ciphertext or the place the text
           still lives. */
        let body = crate::promptvault::decide(
            self.vault.as_ref(),
            &self.host,
            session,
            id,
            at,
            &redacted,
            &path.to_string_lossy(),
            off,
        );
        self.batch.prompts.push(Prompt {
            id: id.to_string(),
            at,
            session: session.to_string(),
            /* Both separators: a transcript's `cwd` is a Windows path even when
               it is read on a machine that does not think backslashes separate
               anything. Same rule as `read_record`, and never the path. */
            project: pick("cwd").rsplit(['\\', '/']).next().unwrap_or("").to_string(),
            entrypoint: pick("entrypoint").to_string(),
            kind: kind.as_str(),
            form,
            redactions: redacted.redactions,
            withheld: redacted.withheld,
            body,
        });
    }

    /// A transcript too large to read on a first pass, marked as consumed and
    /// **counted**, because the mark is what makes the hole permanent: nothing
    /// ever reads that file again. `Report::refused` is the only place that
    /// says so, and a hole with a number beside it is a reading rather than a
    /// silence.
    pub(crate) fn refused(&mut self, path: &Path, size: u64, mtime: i64) {
        self.batch.refused += 1;
        self.batch.files.push(FileMark {
            path: path.to_string_lossy().to_string(),
            mark: Mark {
                offset: size,
                mtime,
                size,
            },
        });
    }

    /// A file the pass decided not to read, recorded at its end so the next
    /// pass does not stat its way back to the same answer.
    pub(crate) fn skipped(&mut self, path: &Path, offset: u64, mtime: i64, size: u64) {
        self.batch.files.push(FileMark {
            path: path.to_string_lossy().to_string(),
            mark: Mark {
                offset,
                mtime,
                size,
            },
        });
    }

    /// A file consumed to `offset`, where only whole lines were taken.
    pub(crate) fn consumed(&mut self, path: &Path, offset: u64, mtime: i64, size: u64, bytes: u64) {
        self.batch.bytes += bytes;
        self.batch.files.push(FileMark {
            path: path.to_string_lossy().to_string(),
            mark: Mark {
                offset,
                mtime,
                size,
            },
        });
    }
}

/* ── the ladder, pure, so each rung has a test ───────────────────────────── */

/// One turn's claimed interval, from the `turn` table (`migrate_v61`). A row
/// still open has `ended: None` and runs from its open to now, which is what
/// lets a request be attributed while its turn is in flight (§4).
#[derive(Clone, Debug)]
pub(crate) struct Span {
    pub(crate) opened: i64,
    pub(crate) ended: Option<i64>,
    pub(crate) label: String,
    pub(crate) identity: String,
}

/// Who paid for one request.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Funding {
    pub(crate) account: String,
    pub(crate) identity: String,
    pub(crate) provider: String,
}

/// Which funding a request at `at` belongs to — §4's three rungs, in order, and
/// the order is the whole point: the interval's label is what a swap changes,
/// and the session's owner is the fallback for a request no turn covers.
///
/// **A `turn` row with a NULL label is `unknown`, never Claude.** That is what
/// every pre-v59 row carries and what a front end that forgot the argument
/// writes; reading it as the subscription would silently shrink §5's residual.
///
/// **A request outside every recorded turn, in a session with no owner, is
/// unknown for the account too** — not folded into the nearest account. The
/// residual is what accounts for it. The **provider** is different, and §4.1 is
/// explicit about why: "`@deepseek` in `turn.account_label` (or the conversation
/// row, for a session with no turn)". It is a sentinel in the account column, so
/// nothing in a transcript can supply it, and for a session with no turn the
/// card's current label is the only app-side answer there is. It is also the
/// only answer for history from before `turn.opened_at` existed, where every row
/// is boundaryless and the first rung can never match; left out, the 90-day
/// backfill would file every `@deepseek` card's spend as `unknown` and no later
/// pass could correct it, because the request is deduped by then. The cost is
/// that a card which swapped provider long ago reads as its current provider for
/// that old span, which is the same compromise §4.1 accepted by naming the
/// conversation row at all.
///
/// **The identity is carried whichever rung decided the account.** §4 wants "the
/// identity in `account_identity` when the transcript named one", and the
/// transcript names it in the `session-owner` record, not in the turn row — so a
/// turn with no identity of its own takes the session's. Without that the
/// identity was never written for any card request, `account_identity` was empty
/// everywhere, and a subagent still running after its parent's turn settled fell
/// to the owner rung and lost the label it had a moment earlier.
///
/// `spans` must be ordered by `opened_at` (`spans_for` does it), which is what
/// makes the lookup a binary search plus a walk back over the windows still open
/// at that instant. Turns are disjoint in practice — one card runs one turn — so
/// that walk is one span; a queued prompt used to make it two and no longer can.
pub(crate) fn funding_at(
    spans: &[Span],
    at: i64,
    owner: Option<&str>,
    labels: &HashMap<String, String>,
    card: Option<&str>,
) -> Funding {
    let owner = owner.map(str::trim).filter(|o| !o.is_empty());
    let end = spans.partition_point(|s| s.opened <= at);
    if let Some(span) = spans[..end].iter().rev().find(|s| s.ended.is_none_or(|e| at < e)) {
        let identity = if span.identity.is_empty() {
            owner.unwrap_or("").to_string()
        } else {
            span.identity.clone()
        };
        let label = span.label.trim();
        if label.is_empty() {
            return Funding {
                account: "unknown".into(),
                identity,
                provider: "unknown".into(),
            };
        }
        return Funding {
            account: label.to_string(),
            identity,
            provider: provider_of(Some(label)).into(),
        };
    }
    /* One namespace for the account key, because a UUID is not a label (§4).
       An identity this wall has never registered keeps the identity and calls
       the account unknown, which is what puts it in the residual. */
    let provider = provider_of(card).to_string();
    match owner {
        Some(o) => Funding {
            account: labels.get(o).cloned().unwrap_or_else(|| "unknown".into()),
            identity: o.to_string(),
            provider,
        },
        None => Funding {
            account: "unknown".into(),
            identity: String::new(),
            provider,
        },
    }
}

/// Which provider a funding label means (§4.1).
///
/// **A provider is a sentinel in the account column, not a fact of its own.** A
/// registered label is the Claude subscription; `@deepseek` is DeepSeek and its
/// name comes from the same table the spawn uses; `@credits` is an Anthropic API
/// key and so bills Anthropic. A sentinel this build does not know is `unknown`
/// rather than guessed into Claude, and so is NULL.
pub(crate) fn provider_of(label: Option<&str>) -> &'static str {
    let Some(label) = label.map(str::trim).filter(|l| !l.is_empty()) else {
        return "unknown";
    };
    if let Some(p) = crate::provider::of(Some(label)) {
        return p.name;
    }
    if label == crate::credits::LABEL {
        return "claude";
    }
    if label.starts_with('@') {
        return "unknown";
    }
    "claude"
}

/// Who ran this session: a Volery card, a terminal, or something this wall has
/// no name for.
///
/// The card arm is the conversation lookup and nothing else; a terminal is the
/// CLI's own `entrypoint` for an interactive session. An `sdk-cli` session with
/// no card behind it is `unknown` — a `claude -p` run from a script or a probe,
/// which is a real thing on this machine and is not a terminal (§4's "about 26
/// are ordinary `sdk-cli` sessions").
pub(crate) fn source_of(entrypoint: &str, card: bool) -> &'static str {
    if card {
        "card"
    } else if entrypoint == "cli" {
        "terminal"
    } else {
        "unknown"
    }
}

/// How a session's `source` merges: `card` beats `terminal` beats `unknown`.
///
/// A *maximum*, so it is commutative: folding it over a session's records and
/// then over its chunks gives the same answer however a pass was batched, which
/// is what lets a session span a chunk boundary without the row depending on
/// which half was written first. The order also keeps the two transitions that
/// matter — a card stays a card, and a later pass may upgrade an `unknown`.
fn source_rank(source: &str) -> u8 {
    match source {
        "card" => 2,
        "terminal" => 1,
        _ => 0,
    }
}

/// How deep a subagent is, and who spawned it — §4.4.
///
/// `parent` is the agent that made the spawning call, or `''` for the card
/// itself. **A depth the records cannot prove is 0 (unknown), not 1**: a
/// subagent whose spawning call this wall never saw is drawn as a root rather
/// than guessed into the card. The chain is followed until it reaches the card
/// or stops at an agent with no proven parent, so what comes back is the depth
/// that is proven rather than the depth that is likely.
pub(crate) fn resolve_agent(
    session: &str,
    agent: &str,
    parents: &HashMap<(String, String), String>,
    known: Option<(&str, i64)>,
) -> (String, i64) {
    if agent.is_empty() {
        return (String::new(), 0);
    }
    let key = (session.to_string(), agent.to_string());
    match parents.get(&key) {
        Some(parent) => (parent.clone(), depth_of(session, agent, parents)),
        /* Nothing in this batch; what an earlier pass already learnt. The depth
           is what makes it evidence, not the parent: a card-spawned agent's
           parent is the empty string and its depth is 1. */
        None => match known {
            Some((p, d)) if d > 0 => (p.to_string(), d),
            _ => (String::new(), 0),
        },
    }
}

fn depth_of(session: &str, agent: &str, parents: &HashMap<(String, String), String>) -> i64 {
    let mut at = agent.to_string();
    let mut depth = 0;
    /* Bounded rather than trusting the file: a cycle in a hand-edited transcript
       is a hang otherwise, and sixteen is deeper than any real tree. */
    for _ in 0..16 {
        let Some(parent) = parents.get(&(session.to_string(), at.clone())) else {
            break;
        };
        depth += 1;
        if parent.is_empty() {
            break;
        }
        at = parent.clone();
    }
    depth
}

/// A UTC hour's start.
pub(crate) fn hour_of(at: i64) -> i64 {
    at - at.rem_euclid(HOUR_MS)
}

/// The five-minute bucket a request lands in.
pub(crate) fn bucket_of(at: i64) -> i64 {
    at - at.rem_euclid(BUCKET_MS)
}

/* ── the tool reader and the receipt parser, pure (§3.7, §3.9) ──────────── */

/// What one tool call is, as `tool_fact` names it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolShape {
    pub(crate) kind: &'static str,
    pub(crate) server: String,
    pub(crate) tool: String,
    pub(crate) target: String,
    pub(crate) requested_model: String,
    /// The result returns before the work does, so its latency is the
    /// receipt's and the face must say so.
    pub(crate) receipt: bool,
}

/// `builtin`, `mcp`, `skill` or `agent`, and the dimensions that follow from
/// the name alone.
///
/// **An MCP name is `mcp__<server>__<tool>`**, so the server is a dimension
/// without a second record. A built-in has no server and says `builtin` rather
/// than inventing one. `Skill` carries the skill name and `Agent`/`Task` the
/// subagent type in their inputs; the requested model is the input's `model`,
/// which on this machine only 7 of 373 agent calls carried — hence `unknown`
/// rather than a guess.
///
/// **A receipt is an `Agent`, `Monitor`, `Workflow` or a background `Bash`**
/// (§3.7, `turns.md`). A foreground `Agent` call is not one: its result is the
/// subagent's answer, and calling that latency a receipt would make real work
/// look free.
pub(crate) fn classify_tool(name: &str, input: Option<&serde_json::Value>) -> ToolShape {
    let text = |k: &str| {
        input
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let background = input
        .and_then(|v| v.get("run_in_background"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(rest) = name.strip_prefix("mcp__") {
        let (server, tool) = match rest.split_once("__") {
            Some((server, tool)) => (server, tool),
            None => ("", rest),
        };
        return ToolShape {
            kind: "mcp",
            server: server.to_string(),
            tool: tool.to_string(),
            target: String::new(),
            requested_model: String::new(),
            receipt: false,
        };
    }
    if name == "Skill" {
        return ToolShape {
            kind: "skill",
            server: String::new(),
            tool: name.to_string(),
            target: text("skill"),
            requested_model: String::new(),
            receipt: false,
        };
    }
    if name == "Agent" || name == "Task" {
        return ToolShape {
            kind: "agent",
            server: String::new(),
            tool: name.to_string(),
            target: text("subagent_type"),
            requested_model: text("model"),
            receipt: background,
        };
    }
    ToolShape {
        kind: "builtin",
        server: String::new(),
        tool: name.to_string(),
        target: String::new(),
        requested_model: String::new(),
        receipt: background || name == "Monitor" || name == "Workflow",
    }
}

/// The tools whose input names a file that is written. `NotebookEdit` is here
/// because a notebook is a governed file like any other; `Bash` is not, because
/// a shell line that writes `CLAUDE.md` through a redirection is a guess rather
/// than a path, and an invalidation fact may not be invented.
pub(crate) const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// The path a write tool's input names, or `None` for an input that names none.
///
/// **Read out of the input, never built.** `file_path` is what `Write` and
/// `Edit` carry; `NotebookEdit` spells the same thing `notebook_path`, and
/// `path` is the fallback for a shape this build has not seen. A write with no
/// path is recorded as nothing at all, which is the guard the suite holds.
pub(crate) fn write_path(input: Option<&serde_json::Value>) -> Option<String> {
    let pick = |k: &str| {
        input
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    pick("file_path")
        .or_else(|| pick("notebook_path"))
        .or_else(|| pick("path"))
        .map(|p| p.replace('\\', "/"))
}

/// What an instruction file is called (§3.9).
///
/// **A rule wins over an instruction**, because a file under `.claude/rules/`
/// is read only when a governed path is opened whatever it is named, and
/// calling it an instruction would overstate what it costs.
///
/// The comparison is case-insensitive because this is a Windows-first wall and
/// `claude.md` is the same file as `CLAUDE.md` there; on a case-sensitive disk
/// it is a name the CLI would not read either, so the false positive costs a
/// row and never a wrong one about a file anybody reads.
pub(crate) fn instruction_kind(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.contains("/.claude/rules/") || lower.starts_with(".claude/rules/") {
        return Some("rule");
    }
    let name = lower.rsplit(['/', '\\']).next().unwrap_or("");
    if name == "claude.md" || name == "agents.md" {
        return Some("instructions");
    }
    None
}

/// The episode a write belongs to (§3.9): the path for an instruction file,
/// the rules directory for a rule, and the reference itself for a switch.
///
/// **A rule's key is its directory, not its file.** Every rule under one
/// `.claude/rules/` is a change to the same reading, so six edits across three
/// rule files in ten minutes is one churn episode rather than six events no
/// reader can act on. The same function exists in `analyticswork.ts`, and the
/// two are held together by the fixture and the suite rather than by a shared
/// constant, because one is Rust and one is TypeScript.
pub(crate) fn invalidate_key(kind: &str, reference: &str) -> String {
    if kind != "rule" {
        return reference.to_string();
    }
    let lower = reference.to_ascii_lowercase();
    /* The needle with a leading slash starts one character before the segment,
       so its cut lands one later than the bare one. Getting this wrong answers
       `…/.claude/rule`, which groups nothing with anything. */
    if let Some(at) = lower.find("/.claude/rules/") {
        return reference[..at + 1 + ".claude/rules".len()].to_string();
    }
    match lower.find(".claude/rules/") {
        Some(at) => reference[..at + ".claude/rules".len()].to_string(),
        None => reference.to_string(),
    }
}

/// One `tool_use` block that wrote a file governing an agent's reading.
///
/// The cheap gate is two conditions rather than one: most assistant records
/// carry a call, and only a handful of names can make an invalidation fact.
/// Parsing those and only those is what keeps this from being a second full
/// parse of every record the pass already paid for.
pub(crate) fn parse_writes(line: &str) -> Vec<InstructionWrite> {
    if !line.contains("tool_use") {
        return Vec::new();
    }
    /* Literal needles rather than a `format!` per tool per line: the backfill
       runs this over every transcript on the machine, and a write tool's name
       in the CLI's compact JSON is a constant. */
    let named = line.contains("\"name\":\"Write\"")
        || line.contains("\"name\":\"Edit\"")
        || line.contains("\"name\":\"MultiEdit\"")
        || line.contains("\"name\":\"NotebookEdit\"");
    if !named || !line.contains("\"type\":\"assistant\"") {
        return Vec::new();
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    if rec.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return Vec::new();
    }
    let Some(at) = rec
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(epoch_ms)
    else {
        return Vec::new();
    };
    let session = rec.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let cwd = rec.get("cwd").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let Some(blocks) = rec
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in blocks {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !WRITE_TOOLS.contains(&name) {
            continue;
        }
        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let Some(path) = write_path(block.get("input")) else {
            continue;
        };
        let Some(kind) = instruction_kind(&path) else {
            continue;
        };
        out.push(InstructionWrite {
            at,
            session: session.clone(),
            tool_use_id: id,
            cwd: cwd.clone(),
            path: crate::clip::preview(&path, MAX_INVALIDATE_REF),
            kind,
        });
    }
    out
}

/// A `tool_use` record's timestamp, session and agent, and its calls.
///
/// **Several blocks on one record are several calls.** The CLI writes a
/// parallel batch into one assistant message, and folding them into one row
/// would hide that a turn called two tools at once.
pub(crate) fn parse_tool_use(line: &str) -> Vec<ToolCall> {
    if !line.contains("\"type\":\"assistant\"") {
        return Vec::new();
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    if rec.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return Vec::new();
    }
    let Some(at) = rec
        .get("timestamp")
        .and_then(|v| v.as_str())
        .and_then(epoch_ms)
    else {
        return Vec::new();
    };
    let session = rec.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let agent = rec.get("agentId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let Some(blocks) = rec
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for block in blocks {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if id.is_empty() || name.is_empty() {
            continue;
        }
        let shape = classify_tool(name, block.get("input"));
        out.push(ToolCall {
            id: id.to_string(),
            at,
            session: session.clone(),
            agent: agent.clone(),
            kind: shape.kind,
            server: shape.server,
            tool: shape.tool,
            target: shape.target,
            requested_model: shape.requested_model,
            async_: shape.receipt,
        });
    }
    out
}

/// The size of a result's content, summed over the blocks it came in.
///
/// **The content itself is dropped one line later.** A tool result can be a
/// file, a screenshot or a token; the store keeps `42,318` and never the bytes,
/// and that line is drawn here rather than in a policy.
pub(crate) fn content_size(content: &serde_json::Value) -> i64 {
    match content {
        serde_json::Value::String(s) => s.len() as i64,
        serde_json::Value::Array(items) => items
            .iter()
            .map(|block| match block.get("text").and_then(|v| v.as_str()) {
                Some(text) => text.len() as i64,
                /* An image or an unknown block has no text to measure; its
                   serialized size is the closest honest reading and still
                   stores no content. */
                None => serde_json::to_string(block).map(|s| s.len() as i64).unwrap_or(0),
            })
            .sum(),
        serde_json::Value::Null => 0,
        other => serde_json::to_string(other).map(|s| s.len() as i64).unwrap_or(0),
    }
}

/// The result of one `user` record, and the receipts it carried.
pub(crate) struct ParsedResult {
    pub(crate) result: ToolResult,
    pub(crate) receipts: Vec<Receipt>,
}

/// A `tool_result` record, reduced to what a fact needs (§3.7).
///
/// **The result's text is read here and never kept.** It is scanned for the
/// receipt patterns §3.9 names, and what crosses to the write is the kind, the
/// sha or branch, and a count of conflicted paths.
pub(crate) fn parse_tool_result(line: &str) -> Vec<ParsedResult> {
    if !line.contains("\"type\":\"user\"") {
        return Vec::new();
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    if rec.get("type").and_then(|v| v.as_str()) != Some("user") {
        return Vec::new();
    }
    let Some(at) = rec.get("timestamp").and_then(|v| v.as_str()).and_then(epoch_ms) else {
        return Vec::new();
    };
    let session = rec.get("sessionId").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let Some(blocks) = rec
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    /* The agent an `Agent`/`Task` call opened. **The result's `agentId`, never
       `parentUuid`**: the latter is the message chain inside one file (§4.4).
       It is a property of the record rather than of a block, so it goes on the
       first result; a record holding two results is a shape this walk has not
       seen (2,843 results, none of them), and guessing which block owns it
       would be worse than leaving the second without one. */
    let child_agent = rec
        .pointer("/toolUseResult/agentId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    /* A receipt is only read off a shell-shaped result. `toolUseResult` is the
       CLI's own summary of what the call did, and a `Read` of a document that
       happens to contain `[main abc1234]` has none — so gating on it is what
       stops the analytics inventing a commit out of prose. */
    let summary = rec.get("toolUseResult");
    let shell = summary.is_some_and(|s| {
        s.get("stdout").is_some() || s.get("gitOperation").is_some() || s.get("stderr").is_some()
    });
    let cwd = rec.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    let project = cwd.rsplit(['\\', '/']).next().unwrap_or("").to_string();
    let branch = rec.get("gitBranch").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();

    let mut out = Vec::new();
    for (n, block) in blocks.iter().enumerate() {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
            continue;
        }
        let id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let errors = if block.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
            1
        } else {
            0
        };
        let mut out_bytes = 0i64;
        let mut text = String::new();
        if let Some(content) = block.get("content") {
            out_bytes = content_size(content);
            match content {
                serde_json::Value::String(s) => {
                    text.push_str(s);
                    text.push('\n');
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                            text.push_str(t);
                            text.push('\n');
                        }
                    }
                }
                _ => {}
            }
        }
        let receipts = if shell {
            parse_receipts(&text, summary.and_then(|s| s.get("gitOperation")))
                .into_iter()
                .map(|r| Receipt {
                    session: session.clone(),
                    tool_use_id: id.clone(),
                    at,
                    project: project.clone(),
                    branch: branch.clone(),
                    kind: r.kind,
                    reference: r.reference,
                    conflict_files: r.conflict_files,
                })
                .collect()
        } else {
            Vec::new()
        };
        out.push(ParsedResult {
            result: ToolResult {
                id,
                at,
                errors,
                out_bytes,
                child_agent: if n == 0 { child_agent.clone() } else { String::new() },
            },
            receipts,
        });
    }
    out
}

/// One receipt before it is given a session.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ParsedReceipt {
    pub(crate) kind: &'static str,
    pub(crate) reference: String,
    pub(crate) conflict_files: i64,
}

/// The artifacts a shell result names (§3.9).
///
/// **The receipt is exact and it comes off the CLI's own output**, which is the
/// whole reason the work half needs no guess: `git commit` prints
/// `[main 8adbaaa] subject`, the CLI's `toolUseResult` names the same sha and
/// branch structurally, a push names its branch, and a conflicted integration
/// prints one `CONFLICT` line per path. The `gitOperation` object is read
/// first because it is the shape the CLI committed to; the printed lines are
/// the fallback for a build whose summary is absent.
///
/// No text is kept beyond the reference. The subject, the command and the diff
/// are dropped here.
pub(crate) fn parse_receipts(
    text: &str,
    git_op: Option<&serde_json::Value>,
) -> Vec<ParsedReceipt> {
    let mut out: Vec<ParsedReceipt> = Vec::new();

    if let Some(op) = git_op {
        if let Some(commit) = op.get("commit") {
            let sha = commit.get("sha").and_then(|v| v.as_str()).unwrap_or("").trim();
            if !sha.is_empty() {
                out.push(ParsedReceipt {
                    kind: "commit",
                    reference: sha.to_string(),
                    conflict_files: 0,
                });
            }
        }
        if let Some(push) = op.get("push") {
            let branch = push.get("branch").and_then(|v| v.as_str()).unwrap_or("").trim();
            if !branch.is_empty() {
                out.push(ParsedReceipt {
                    kind: "push",
                    reference: branch.to_string(),
                    conflict_files: 0,
                });
            }
        }
        if let Some(branch) = op.get("branch") {
            let action = branch.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let name = branch.get("ref").and_then(|v| v.as_str()).unwrap_or("").trim();
            let kind = match action {
                "merged" => Some("merge"),
                "rebased" => Some("rebase"),
                _ => None,
            };
            if let (Some(kind), false) = (kind, name.is_empty()) {
                out.push(ParsedReceipt {
                    kind,
                    reference: name.to_string(),
                    conflict_files: 0,
                });
            }
        }
    }

    /* The printed commit line, for a build that carried no `gitOperation`.
       The branch printed beside the sha is where the commit landed, not a
       branch anybody made, so it is not a receipt of its own — the commit
       row's own `branch` carries it, off the record's `gitBranch`. */
    if !out.iter().any(|r| r.kind == "commit") {
        if let Some((_branch, sha)) = bracket_commit(text) {
            out.push(ParsedReceipt {
                kind: "commit",
                reference: sha,
                conflict_files: 0,
            });
        }
    }

    let conflicts = conflict_paths(text);
    if !conflicts.is_empty() {
        out.push(ParsedReceipt {
            kind: "conflict",
            reference: String::new(),
            conflict_files: conflicts.len() as i64,
        });
    }

    if let Some((number, merged)) = pr_link(text) {
        out.push(ParsedReceipt {
            kind: if merged { "pr_merge" } else { "pr_open" },
            reference: number,
            conflict_files: 0,
        });
    }

    if let Some(name) = quoted_after(text, "Preparing worktree (new branch '") {
        out.push(ParsedReceipt {
            kind: "worktree",
            reference: name,
            conflict_files: 0,
        });
    } else if let Some(name) = quoted_after(text, "Switched to a new branch '") {
        out.push(ParsedReceipt {
            kind: "branch",
            reference: name,
            conflict_files: 0,
        });
    }

    dedupe_receipts(out)
}

/// One row per kind and reference. A commit prints the same sha in the summary
/// and the line, and the fact table must not count it twice.
fn dedupe_receipts(rows: Vec<ParsedReceipt>) -> Vec<ParsedReceipt> {
    let mut out: Vec<ParsedReceipt> = Vec::new();
    for row in rows {
        if out
            .iter()
            .any(|r| r.kind == row.kind && r.reference == row.reference)
        {
            continue;
        }
        out.push(row);
    }
    out
}

fn is_hex(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `[main 8adbaaa] subject` → the branch and the short sha.
fn bracket_commit(text: &str) -> Option<(String, String)> {
    for line in text.lines() {
        let line = line.trim_start();
        let Some(rest) = line.strip_prefix('[') else {
            continue;
        };
        let Some((head, _subject)) = rest.split_once("] ") else {
            continue;
        };
        let Some((branch, sha)) = head.rsplit_once(' ') else {
            continue;
        };
        if branch.is_empty() || !is_hex(sha) {
            continue;
        }
        return Some((branch.to_string(), sha.to_string()));
    }
    None
}

/// The paths a conflicted integration named, distinct.
///
/// Two of git's shapes matter: `CONFLICT (content): Merge conflict in <path>`,
/// and the `CONFLICT (modify/delete): <path> deleted in …` family, where the
/// path is what follows the parenthesis. **These are compared as git printed
/// them**, not folded through `board::normalize`: one command's output uses one
/// separator throughout, so normalising buys nothing, and reaching for the
/// shared folding here would drag a module that links a database into the pure
/// lift that executes this function (`tools/lift-analytics.ts`).
fn conflict_paths(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim_start();
        if !line.starts_with("CONFLICT") {
            continue;
        }
        let path = if let Some((_, rest)) = line.split_once("Merge conflict in ") {
            rest.trim()
        } else if let Some((_, rest)) = line.split_once("): ") {
            rest.split(" deleted in").next().unwrap_or(rest).trim()
        } else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        let path = path.to_string();
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// The PR a `gh pr create` or `gh pr merge` result names, and whether it says
/// the request was merged.
///
/// GitHub's own URL is the reference; `gh pr merge` prints
/// `✓ Merged pull request #123 (title)`, which carries the number and no link.
fn pr_link(text: &str) -> Option<(String, bool)> {
    let merged = text.contains("Merged pull request");
    if let Some(at) = text.find("/pull/") {
        let digits: String = text[at + 6..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        /* **A URL in prose is not an open request.** `gh pr create` prints the
           link as its whole output, so a line that is the URL and nothing else
           is the receipt; a `gh pr view` or a `WebFetch` that merely mentions
           one is not, and counting it would invent a pull request per mention.
           `gh pr merge` is recognised above by its own sentence. */
        let alone = text
            .lines()
            .any(|line| line.trim().ends_with(&format!("/pull/{digits}")));
        if !digits.is_empty() && (alone || text.contains("Creating pull request")) {
            return Some((digits, merged));
        }
    }
    if let Some(at) = text.find("Merged pull request #") {
        let digits: String = text[at + 21..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return Some((digits, true));
        }
    }
    None
}

/// The text between a prefix and the next quote, which is how git names a
/// branch it made.
fn quoted_after(text: &str, prefix: &str) -> Option<String> {
    let at = text.find(prefix)?;
    let rest = &text[at + prefix.len()..];
    let name: String = rest.chars().take_while(|c| *c != '\'' && *c != '"').collect();
    let name = name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// One commit as local git history gives it (§3.9).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HistCommit {
    pub(crate) sha: String,
    /// A merge has two, which is how a history integration is recognised.
    pub(crate) parents: Vec<String>,
    /// The author time, in epoch milliseconds.
    pub(crate) at: i64,
    pub(crate) files: i64,
    pub(crate) added: i64,
    pub(crate) removed: i64,
    /// The changed paths, relative to the repository root. Read for
    /// attribution and never stored.
    pub(crate) paths: Vec<String>,
}

/// Parse `git log --numstat` with the field separator this module asks for.
///
/// The format is `%x1e%H%x1f%P%x1f%at`, so a commit starts with a record
/// separator and the numstat lines that follow it belong to it until the next
/// one. A binary file's numstat is `-` in both count columns, and counts as a
/// file with no lines rather than being dropped.
pub(crate) fn parse_numstat_log(text: &str) -> Vec<HistCommit> {
    let mut out: Vec<HistCommit> = Vec::new();
    let mut cur: Option<HistCommit> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('\u{1e}') {
            if let Some(done) = cur.take() {
                out.push(done);
            }
            let mut fields = rest.split('\u{1f}');
            let sha = fields.next().unwrap_or("").trim().to_string();
            if sha.is_empty() {
                continue;
            }
            let parents: Vec<String> = fields
                .next()
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_string)
                .collect();
            let at = fields
                .next()
                .and_then(|s| s.trim().parse::<i64>().ok())
                .unwrap_or(0)
                * 1000;
            cur = Some(HistCommit {
                sha,
                parents,
                at,
                files: 0,
                added: 0,
                removed: 0,
                paths: Vec::new(),
            });
        } else if let Some(commit) = cur.as_mut() {
            let mut cols = line.split('\t');
            let (Some(added), Some(removed), Some(path)) =
                (cols.next(), cols.next(), cols.next())
            else {
                continue;
            };
            commit.files += 1;
            commit.added += added.trim().parse::<i64>().unwrap_or(0);
            commit.removed += removed.trim().parse::<i64>().unwrap_or(0);
            if !path.trim().is_empty() {
                commit.paths.push(path.trim().to_string());
            }
        }
    }
    if let Some(done) = cur {
        out.push(done);
    }
    out
}

/* ── the write ───────────────────────────────────────────────────────────── */

#[derive(Clone, PartialEq, Eq, Hash)]
struct FactKey {
    at: i64,
    session: String,
    agent: String,
    parent_agent: String,
    depth: i64,
    model: String,
    effort: String,
    cli: String,
    source: String,
    account: String,
    provider: String,
    project: String,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct HourKey {
    hour: i64,
    account: String,
    provider: String,
    model: String,
    effort: String,
    cli: String,
    source: String,
    project: String,
}

#[derive(Default, Clone, Copy)]
struct Sums {
    input: i64,
    output: i64,
    cache_read: i64,
    write_5m: i64,
    write_1h: i64,
    requests: i64,
}

impl Sums {
    fn add(&mut self, rec: &Record) {
        self.input += rec.tokens.input;
        self.output += rec.tokens.output;
        self.cache_read += rec.tokens.cache_read;
        self.write_5m += rec.tokens.write_5m;
        self.write_1h += rec.tokens.write_1h;
        self.requests += 1;
    }
}

/// One session as this batch saw it.
struct SessionNow {
    project: String,
    source: String,
    branch: String,
    started_at: i64,
    ended_at: i64,
    cli_min: String,
    cli_max: String,
    account_first: String,
    account_last: String,
    provider_first: String,
    provider_last: String,
}

/// The row already on disk, if any.
struct SessionOld {
    project: String,
    source: String,
    card_id: Option<String>,
    parent_card: Option<String>,
    opened_by: String,
    branch: String,
    started_at: i64,
    ended_at: Option<i64>,
    cli_min: Option<String>,
    cli_max: Option<String>,
    account_first: String,
    account_last: String,
    provider_first: String,
    provider_last: String,
    turns: i64,
    endings_json: String,
}

/// What a session row becomes. Every column, because it is written whole.
struct SessionWrite {
    session: String,
    host: String,
    project: String,
    source: String,
    card_id: Option<String>,
    parent_card: Option<String>,
    opened_by: String,
    branch: String,
    started_at: i64,
    ended_at: i64,
    cli_min: String,
    cli_max: String,
    account_first: String,
    account_last: String,
    provider_first: String,
    provider_last: String,
    turns: i64,
    endings_json: String,
}

/// What a Volery card knows about a session that the transcript does not.
struct Card {
    id: String,
    project: String,
    branch: String,
    parent: Option<String>,
    opened_by: String,
    /// `conversation.account_label`: the funding the card is on **now**, which
    /// §4.1 makes the provider's source for a session with no turn covering a
    /// request. Empty for a card on the CLI's own sign-in.
    label: String,
    /// The territory the card was opened in, and the worktree group it works in
    /// when it has one. Both are needed for `tree`, which is the directory the
    /// agent actually stands in and therefore the scope of an invalidation.
    cwd: String,
    worktree: String,
    /// `conversation.kind == "chat"`. A chat card can write no file, and is
    /// excluded from every invalidation reading rather than counted as a card
    /// in a tree of its own.
    chat: bool,
}

impl Card {
    /// The directory the agent stands in: the territory for a card in the
    /// shared checkout, `worktree::run_dir` for one in a group.
    ///
    /// **Forward slashes, so `tree` and a write's `ref` agree.** The value is
    /// compared for equality against another session's tree, and two spellings
    /// of one directory would make two cards in one tree look like two trees.
    fn tree(&self) -> String {
        crate::worktree::run_dir(&self.cwd, Some(self.worktree.as_str()))
            .replace('\\', "/")
    }
}

/// The same answer for a session with no card: the directory the transcript
/// recorded. Empty when the record carried none, which is a fact with no tree
/// rather than a guess at one.
fn tree_of(cwd: &str) -> String {
    cwd.trim().replace('\\', "/")
}

/// A move of account, provider or model inside one session (§3.9).
struct Switch {
    at: i64,
    session: String,
    card: String,
    tree: String,
    kind: &'static str,
    reference: String,
}

/// Whether two readings of one dimension are a move.
///
/// **`unknown` is not a value and a first sighting is not a move.** A session
/// whose earlier requests were funded by no turn has `unknown` on the row, and
/// the first turn label would otherwise be recorded as a switch that never
/// happened. An empty side is the same absence.
fn moved(prev: &str, next: &str) -> bool {
    let (a, b) = (prev.trim(), next.trim());
    !a.is_empty() && !b.is_empty() && a != "unknown" && b != "unknown" && a != b
}

/// `classify.ts::sameModel`, in Rust: the window tier is a suffix, not a model.
///
/// A `system/init` id can carry `[1m]` and every per-message id is bare, so the
/// same model arrives spelled two ways and must never be recorded as a move.
pub(crate) fn same_model(a: &str, b: &str) -> bool {
    fn base(m: &str) -> String {
        let m = m.trim();
        /* `baseModel`'s suffix, end-anchored: only a bracket at the end is the
           window tier, so an id carrying one in the middle keeps it. */
        let m = if m.ends_with(']') {
            match m.rfind('[') {
                Some(at) => &m[..at],
                None => m,
            }
        } else {
            m
        };
        m.strip_suffix("-1m").unwrap_or(m).trim().to_string()
    }
    let x = base(a);
    !x.is_empty() && x == base(b)
}

/// Whether this session's move is already a fact.
///
/// A move Volery made is written the moment it happens (`store::note_invalidate`),
/// and the first request that shows it must not write a second row for the same
/// cache. A switch the wall did not make has no such row, so the ingest is what
/// records it. Ten minutes is the churn gap: a card that genuinely moved twice
/// inside it is one episode of churn rather than two events.
fn switch_seen(conn: &Connection, host: &str, session: &str, at: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM invalidate_fact
          WHERE host = ?1 AND session = ?2 AND provenance = 'receipt'
            AND kind IN ('account', 'provider', 'model')
            AND at >= ?3 AND at <= ?4",
        params![host, session, at - CHURN_GAP_MS, at + CHURN_GAP_MS],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| format!("analytics: switch: {e}"))
}

/// The model this session's own thread was on before `before`, if the store
/// still holds a request for it.
///
/// **The card's thread, not a subagent's.** A subagent may run a requested
/// model of its own, and reading that as the card's would invent a switch every
/// time one was opened.
fn prior_model(conn: &Connection, session: &str, host: &str, before: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT model FROM usage_fact
          WHERE session = ?1 AND host = ?2 AND agent = '' AND at < ?3
          ORDER BY at DESC LIMIT 1",
        params![session, host, before],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map(|r| r.unwrap_or_default())
    .map_err(|e| format!("analytics: prior model: {e}"))
}

/// The cards working at one instant, for a switch's `affected` (§3.9).
///
/// **A switch is a timing reading, not a payer count.** What it invalidates is
/// the moved card's cache; what `affected` says is how many cards were mid-turn
/// when it happened, because a switch during other cards' work invalidates the
/// turn that is running as well as the next one. That is why the moved card is
/// counted too.
fn working_at(conn: &Connection, host: &str, at: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM analytics_session s
          WHERE s.host = ?1 AND s.card_id IS NOT NULL
            AND s.started_at <= ?2 AND (s.ended_at IS NULL OR s.ended_at >= ?2)",
        params![host, at],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0)
}

/// What one write did, for the report and the log line.
#[derive(Default)]
struct Counts {
    /// Requests the dedupe had not seen — the only ones anything was written for.
    requests: i64,
    /// Requests the transcript offered that were already counted.
    duplicates: i64,
    /// Prompts written: the ones `(host, prompt_id)` had not seen.
    prompts: i64,
    /// Prompts offered under an id the store already had, whose `seen_count`
    /// was what moved. §3.8's replays.
    prompt_duplicates: i64,
    facts: i64,
    hours: i64,
    prompt_hours: i64,
    sessions: i64,
    bytes: u64,
    /// `tool_use` blocks written or resolved this pass.
    calls: i64,
    results: i64,
    /// Work receipts written from a result (§3.9).
    receipts: i64,
    /// Settled turns folded into tool facts, and calls written as `no-turn`.
    folds: i64,
    no_turn: i64,
    /// Commits the history observer wrote, and the ones it skipped because a
    /// receipt already held them.
    history: i64,
    /// Invalidation events written, and attributed rows (§3.9). Apart from the
    /// events, because one event can produce a row per paying card and the two
    /// are the halves a reader may never add together.
    invalidations: i64,
    attributed: i64,
    /// Transcripts the one-off walk read, and those too large to read.
    walked: i64,
    unreadable: i64,
}

impl Counts {
    /// Sum a chunk's counts into the pass's.
    ///
    /// A fact or session key that spans two chunks is counted by both, because
    /// both transactions touched its row (`ON CONFLICT` adds, `INSERT OR
    /// REPLACE` rewrites). The tables still hold one row; this number is what
    /// the pass did, not how many rows exist.
    fn add(&mut self, other: Counts) {
        self.requests += other.requests;
        self.duplicates += other.duplicates;
        self.prompts += other.prompts;
        self.prompt_duplicates += other.prompt_duplicates;
        self.facts += other.facts;
        self.hours += other.hours;
        self.prompt_hours += other.prompt_hours;
        self.sessions += other.sessions;
        self.calls += other.calls;
        self.results += other.results;
        self.receipts += other.receipts;
        self.folds += other.folds;
        self.no_turn += other.no_turn;
        self.history += other.history;
        self.invalidations += other.invalidations;
        self.attributed += other.attributed;
        self.walked += other.walked;
        self.unreadable += other.unreadable;
    }
}

/// What one forced pass did, as `analytics_pass` answers it.
///
/// **It is the answer to a question somebody asked, not a health check.** The
/// collector logs the passes that wrote something and says nothing about the
/// ones that did not, so a wall nobody asks looks the same whether its reader is
/// idle or broken. Anyone who wants to know calls the command and reads this:
/// `requests` and `duplicates` apart is what tells a broken reader (`files` at
/// zero for a tree that is not empty) from a quiet minute, and `refused` is the
/// count of transcripts too large to ingest at all.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub files: usize,
    pub bytes: u64,
    pub requests: i64,
    pub duplicates: i64,
    /// Facts the chunks wrote. A key that spans two chunks is counted by both,
    /// because both transactions touched its row; the table still holds one.
    pub facts: i64,
    /// Hour rows, counted the same way.
    pub hours: i64,
    /// Prompt facts written, and prompts already in the store whose
    /// `seen_count` moved instead (§3.8's replay). Apart, because a reader that
    /// fell back to `at` would count a replay as a new prompt.
    pub prompts: i64,
    pub prompt_duplicates: i64,
    /// Prompt hour rows, counted like `hours`.
    pub prompt_hours: i64,
    /// Session rows, counted the same way.
    pub sessions: i64,
    /// Tool calls and results written, and the work receipts read off results.
    pub calls: i64,
    pub results: i64,
    pub receipts: i64,
    /// Turns folded into tool facts, calls written as `no-turn`, and commits
    /// the history observer added.
    pub folds: i64,
    pub no_turn: i64,
    pub history: i64,
    /// Invalidation events and attributed rows written (§3.9), and the
    /// transcripts the one-off walk read or refused this pass.
    pub invalidations: i64,
    pub attributed: i64,
    pub walked: i64,
    pub unreadable: i64,
    pub refused: i64,
    pub ms: u64,
}

/// Fold one chunk of requests into the store, in **one transaction** (§7.2).
///
/// A fact and its `usage_seen` key land together, which is the lesson `migrate`
/// and `set_mid_turn` both paid for. The file offset is deliberately **not** in
/// this transaction: it advances once, in `write_tail`, after every chunk has
/// committed. A crash between chunks therefore leaves committed facts whose
/// offsets are still old, and the next pass re-reads those bytes and finds their
/// `usage_seen` keys — nothing double counted, nothing committed lost.
fn write_chunk(
    conn: &mut Connection,
    host: &str,
    requests: &[Record],
    session_owners: &HashMap<String, String>,
    parents: &HashMap<(String, String), String>,
    prior: &Prior,
    now: i64,
) -> Result<Counts, String> {
    let cutoff = now - FINE_KEEP_MS;
    let mut counts = Counts::default();

    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;

    /* 1. Which of these requests is new. */
    let mut fresh: Vec<Record> = Vec::new();
    {
        let mut seen = tx
            .prepare("SELECT 1 FROM usage_seen WHERE key = ?1")
            .map_err(|e| format!("analytics: read seen: {e}"))?;
        for rec in requests {
            if rec.at < cutoff {
                continue;
            }
            let known = seen
                .exists([&rec.key])
                .map_err(|e| format!("analytics: read seen: {e}"))?;
            if known {
                counts.duplicates += 1;
            } else {
                fresh.push(rec.clone());
            }
        }
    }
    counts.requests = fresh.len() as i64;

    /* 2. Per session: the turn intervals, the owner, the label of every
       identity either of them names, and what the card behind it knows. */
    let mut by_session: HashMap<String, Vec<Record>> = HashMap::new();
    for rec in fresh {
        by_session.entry(rec.session.clone()).or_default().push(rec);
    }

    let mut facts: HashMap<FactKey, (Sums, String)> = HashMap::new();
    let mut hours: HashMap<HourKey, Sums> = HashMap::new();
    let mut session_rows: Vec<SessionWrite> = Vec::new();
    /* §3.9's moves, written in this transaction with the facts they belong
       beside: a switch is exact, and a row that landed a pass late would be a
       fact about the wall nobody was on any more. */
    let mut switches: Vec<Switch> = Vec::new();

    let mut sessions: Vec<(String, Vec<Record>)> = by_session.into_iter().collect();
    /* Sorted so a run over one wall writes its rows in the same order twice,
       which is what makes a diff of two stores readable and a test stable. */
    sessions.sort_by(|a, b| a.0.cmp(&b.0));

    for (session, mut recs) in sessions {
        recs.sort_by_key(|r| r.at);
        let first = recs.first().map(|r| r.at).unwrap_or(0);
        let last = recs.last().map(|r| r.at).unwrap_or(0);

        let spans = spans_for(&tx, &session, first, last)?;
        let owners = session_owners
            .get(&session)
            .cloned()
            .filter(|i| !i.is_empty())
            .or_else(|| prior.identity.get(&session).cloned().flatten());
        let card = card_for(&tx, &session);
        /* **The row before this batch is read here, not after the fold.** §3.9
           detects a switch by comparing consecutive requests, and that needs
           the state the session was in when the batch arrived. Read after the
           fold, `account_last` would already be the batch's own last request
           and no move could ever be seen. */
        let old = session_old(&tx, &session, host)?;
        let mut prev_account = old.as_ref().map(|o| o.account_last.clone()).unwrap_or_default();
        let mut prev_provider = old.as_ref().map(|o| o.provider_last.clone()).unwrap_or_default();
        let mut prev_model = prior_model(&tx, &session, host, first)?;
        /* A chat card records nothing (§3.9): it can write no instruction file,
           and its territory is the shared chat home, where every chat card
           would count as affected by every other. */
        let chat = card.as_ref().is_some_and(|c| c.chat);
        let tree = card.as_ref().map(Card::tree).unwrap_or_default();

        /* One lookup per *identity*, once: a session's turns all carry the same
           identity, and running the query per span would be one round trip per
           turn of a long card. */
        let distinct: HashSet<&str> = spans
            .iter()
            .map(|s| s.identity.as_str())
            .chain(owners.as_deref())
            .filter(|i| !i.is_empty())
            .collect();
        let mut labels: HashMap<String, String> = HashMap::new();
        for id in distinct {
            if let Some(label) = crate::accounts::label_for(&tx, id) {
                labels.insert(id.to_string(), label);
            }
        }

        let mut now_row = SessionNow {
            project: String::new(),
            source: "unknown".into(),
            branch: String::new(),
            started_at: first,
            ended_at: last,
            cli_min: String::new(),
            cli_max: String::new(),
            account_first: String::new(),
            account_last: String::new(),
            provider_first: String::new(),
            provider_last: String::new(),
        };
        let mut seen_entry = false;

        for rec in &recs {
            let funding = funding_at(
                &spans,
                rec.at,
                owners.as_deref(),
                &labels,
                card.as_ref().map(|c| c.label.as_str()),
            );
            /* §3.9's moves, on a transition only: an account, provider or model
               that differs from the request before it retired a cache, and the
               first request that shows the new one is where the fact belongs.
               The tier-bearing id versus its bare form is the same model and is
               deliberately not a move (`classify.ts::sameModel`).

               **One row per move, not one per dimension.** A provider switch
               changes the account label and the model as well, and they all
               retire the same cache; three rows would be one cost counted three
               times. The order is provider, account, model, and when one fires
               the others at that instant are the same move. A move Volery
               itself made has already written its row (`store::note_invalidate`)
               and the lookback below is what stops this arm writing it again. */
            if !chat {
                let mut fired = false;
                for (kind, prev, next) in [
                    ("provider", prev_provider.clone(), funding.provider.clone()),
                    ("account", prev_account.clone(), funding.account.clone()),
                ] {
                    if !fired && moved(&prev, &next) && !switch_seen(&tx, host, &session, rec.at)? {
                        switches.push(Switch {
                            at: rec.at,
                            session: session.clone(),
                            card: card.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                            tree: tree.clone(),
                            kind,
                            reference: next,
                        });
                        fired = true;
                    }
                }
                if !fired
                    && !prev_model.is_empty()
                    && !rec.model.is_empty()
                    && !same_model(&prev_model, &rec.model)
                    && !switch_seen(&tx, host, &session, rec.at)?
                {
                    switches.push(Switch {
                        at: rec.at,
                        session: session.clone(),
                        card: card.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                        tree: tree.clone(),
                        kind: "model",
                        reference: rec.model.clone(),
                    });
                }
                prev_account = funding.account.clone();
                prev_provider = funding.provider.clone();
                prev_model = rec.model.clone();
            }
            /* What an earlier pass proved about this agent, read once for the
               whole pass rather than once per chunk: a chunk that read it late
               would see the rows an earlier chunk had just written and fund the
               same agent differently. */
            let known = prior
                .agents
                .get(&(session.clone(), rec.agent.clone()))
                .cloned()
                .flatten();
            let (parent_agent, depth) = resolve_agent(
                &session,
                &rec.agent,
                parents,
                known.as_ref().map(|(p, d)| (p.as_str(), *d)),
            );
            let source = source_of(&rec.entrypoint, card.is_some());
            let project = card
                .as_ref()
                .map(|c| c.project.clone())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| rec.project.clone());

            let fk = FactKey {
                at: bucket_of(rec.at),
                session: session.clone(),
                agent: rec.agent.clone(),
                parent_agent,
                depth,
                model: rec.model.clone(),
                effort: rec.effort.clone(),
                cli: rec.cli.clone(),
                source: source.to_string(),
                account: funding.account.clone(),
                provider: funding.provider.clone(),
                project: project.clone(),
            };
            let entry = facts.entry(fk).or_insert_with(|| (Sums::default(), String::new()));
            entry.0.add(rec);
            if entry.1.is_empty() && !funding.identity.is_empty() {
                entry.1 = funding.identity.clone();
            }

            let hk = HourKey {
                hour: hour_of(rec.at),
                account: funding.account.clone(),
                provider: funding.provider.clone(),
                model: rec.model.clone(),
                effort: rec.effort.clone(),
                cli: rec.cli.clone(),
                source: source.to_string(),
                project: project.clone(),
            };
            hours.entry(hk).or_default().add(rec);

            if !seen_entry {
                seen_entry = true;
                now_row.account_first = funding.account.clone();
                now_row.provider_first = funding.provider.clone();
                now_row.cli_min = rec.cli.clone();
                now_row.cli_max = rec.cli.clone();
            }
            /* The session's earliest record that names a project, not simply
               its earliest record: a record with no `cwd` says nothing, and
               taking it would leave the one-chunk batch with an empty project
               while a split batch fell back to the next record's. */
            if now_row.project.is_empty() {
                now_row.project = project.clone();
            }
            /* Folded as a maximum rather than taken from the first record: a
               session's records can disagree (a card resumed in a terminal), and
               "first" would then be whichever chunk the batch happened to put
               first. */
            if source_rank(source) > source_rank(&now_row.source) {
                now_row.source = source.to_string();
            }
            /* The first and last readings are by time, and the batch is sorted
               by it, so the last one to land wins the `last` half. */
            now_row.account_last = funding.account.clone();
            now_row.provider_last = funding.provider.clone();
            now_row.ended_at = rec.at;
            if !rec.cli.is_empty() {
                if now_row.cli_min.is_empty() || version_less(&rec.cli, &now_row.cli_min) {
                    now_row.cli_min = rec.cli.clone();
                }
                if now_row.cli_max.is_empty() || version_less(&now_row.cli_max, &rec.cli) {
                    now_row.cli_max = rec.cli.clone();
                }
            }
        }

        if !seen_entry {
            continue;
        }
        /* The branch is the card's. A transcript record carries `gitBranch`,
           and `read_record` deliberately does not keep it: the card is the
           authority where there is one, and a terminal session's branch would
           be a dimension with nothing behind it. Left empty rather than
           invented, which is the schema's own default. */
        now_row.branch = card
            .as_ref()
            .map(|c| c.branch.clone())
            .unwrap_or_default();

        let turns = turns_for(&tx, &session)?;
        let row = merge_session(&session, host, old, &now_row, card.as_ref(), turns);
        session_rows.push(row);
    }

    /* 3. The facts. */
    let mut fact_sql = tx
        .prepare(
            "INSERT INTO usage_fact
               (at, host, session, agent, parent_agent, depth, model, effort, cli, source,
                account, account_identity, provider, project, provenance,
                in_tok, out_tok, cache_read, write_5m, write_1h, requests)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'transcript',?15,?16,?17,?18,?19,?20)
             ON CONFLICT(at, host, session, agent, parent_agent, depth, model, effort, cli,
                         source, account, provider, project, provenance)
             DO UPDATE SET
               in_tok = in_tok + excluded.in_tok,
               out_tok = out_tok + excluded.out_tok,
               cache_read = cache_read + excluded.cache_read,
               write_5m = write_5m + excluded.write_5m,
               write_1h = write_1h + excluded.write_1h,
               requests = requests + excluded.requests,
               account_identity = CASE WHEN excluded.account_identity <> ''
                                       THEN excluded.account_identity
                                       ELSE account_identity END",
        )
        .map_err(|e| format!("analytics: fact: {e}"))?;
    for (k, (s, identity)) in &facts {
        fact_sql
            .execute(params![
                k.at,
                host,
                k.session,
                k.agent,
                k.parent_agent,
                k.depth,
                k.model,
                k.effort,
                k.cli,
                k.source,
                k.account,
                identity,
                k.provider,
                k.project,
                s.input,
                s.output,
                s.cache_read,
                s.write_5m,
                s.write_1h,
                s.requests
            ])
            .map_err(|e| format!("analytics: fact: {e}"))?;
    }
    drop(fact_sql);

    /* 4. The hour, in the same transaction, so the rollup can never be half a
          bucket behind the fact it rolled. */
    let mut hour_sql = tx
        .prepare(
            "INSERT INTO usage_hour
               (hour, host, account, provider, model, effort, cli, source, project, provenance,
                in_tok, out_tok, cache_read, write_5m, write_1h, requests)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'transcript',?10,?11,?12,?13,?14,?15)
             ON CONFLICT(hour, host, account, provider, model, effort, cli, source, project, provenance)
             DO UPDATE SET
               in_tok = in_tok + excluded.in_tok,
               out_tok = out_tok + excluded.out_tok,
               cache_read = cache_read + excluded.cache_read,
               write_5m = write_5m + excluded.write_5m,
               write_1h = write_1h + excluded.write_1h,
               requests = requests + excluded.requests",
        )
        .map_err(|e| format!("analytics: hour: {e}"))?;
    for (k, s) in &hours {
        hour_sql
            .execute(params![
                k.hour, host, k.account, k.provider, k.model, k.effort, k.cli, k.source, k.project,
                s.input, s.output, s.cache_read, s.write_5m, s.write_1h, s.requests
            ])
            .map_err(|e| format!("analytics: hour: {e}"))?;
    }
    drop(hour_sql);
    counts.facts = facts.len() as i64;
    counts.hours = hours.len() as i64;

    /* 5. The dedupe keys, in the same transaction as the facts they protect. */
    {
        let mut seen = tx
            .prepare("INSERT OR IGNORE INTO usage_seen (key, at) VALUES (?1, ?2)")
            .map_err(|e| format!("analytics: seen: {e}"))?;
        for rec in requests {
            if rec.at < cutoff {
                continue;
            }
            seen.execute(params![rec.key, rec.at])
                .map_err(|e| format!("analytics: seen: {e}"))?;
        }
    }

    /* 6. The session rows. */
    {
        let mut sql = tx
            .prepare(
                "INSERT OR REPLACE INTO analytics_session
                   (session, host, project, source, card_id, parent_card, opened_by, branch,
                    started_at, ended_at, cli_min, cli_max,
                    account_first, account_last, provider_first, provider_last,
                    turns, endings_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            )
            .map_err(|e| format!("analytics: session: {e}"))?;
        for r in &session_rows {
            sql.execute(params![
                r.session,
                r.host,
                r.project,
                r.source,
                r.card_id,
                r.parent_card,
                r.opened_by,
                r.branch,
                r.started_at,
                r.ended_at,
                r.cli_min,
                r.cli_max,
                r.account_first,
                r.account_last,
                r.provider_first,
                r.provider_last,
                r.turns,
                r.endings_json
            ])
            .map_err(|e| format!("analytics: session: {e}"))?;
        }
    }
    counts.sessions = session_rows.len() as i64;

    /* 7. The moves, after the session rows so `affected` counts this session
          too: a switch is a fact about how many cards were working, and the
          card that moved is one of them. */
    counts.invalidations += write_switches(&tx, host, &switches)?;

    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(counts)
}

/// The key of one `prompt_hour` row. Its grain is §17's, and it is *wider* than
/// `usage_hour`'s in one place: `kind` is a dimension here, so the mix, the
/// redirect rate and the nudge rate can be read off the rollup rather than by
/// walking three years of fine rows.
#[derive(Clone, PartialEq, Eq, Hash)]
struct PromptHourKey {
    hour: i64,
    account: String,
    provider: String,
    project: String,
    source: String,
    kind: String,
}

/// Everything §17's `prompt_hour` adds up, in one place so the insert and the
/// conflict arm cannot disagree about the list.
#[derive(Default, Clone, Copy)]
struct PromptSums {
    prompts: i64,
    chars: i64,
    words: i64,
    lines: i64,
    code_lines: i64,
    questions: i64,
    fences: i64,
    images: i64,
    redactions: i64,
    withheld: i64,
    /// The five word bands, in `prompt::word_band`'s order.
    bands: [i64; 5],
}

impl PromptSums {
    fn add(&mut self, p: &Prompt) {
        self.prompts += 1;
        self.chars += p.form.chars as i64;
        self.words += p.form.words as i64;
        self.lines += p.form.lines as i64;
        self.code_lines += p.form.code_lines as i64;
        self.questions += p.form.questions as i64;
        self.fences += p.form.fences as i64;
        self.images += p.form.images as i64;
        self.redactions += p.redactions as i64;
        self.withheld += i64::from(p.withheld);
        self.bands[prompt::word_band(p.form.words)] += 1;
    }
}

/// Fold one chunk of prompts into the store, in **one transaction** (§7.2).
///
/// Two things are worth reading before changing any of it:
///
/// - **The dedupe is the fact row's own key.** `(host, prompt_id)` is the
///   primary key, so "have I seen this prompt" is a lookup rather than a second
///   table, and a repeat only moves `seen_count`. The first `at` is kept,
///   because the row's hour is computed from it and moving the stamp under a
///   rolled count would leave the hour row naming an hour the fact no longer
///   sits in.
/// - **A re-read is not a repeat, and the stamp is what tells them apart.** The
///   file offsets advance only in `write_tail`, so every pass that dies after a
///   chunk (or a second `analytics_pass` overlapping the collector's long first
///   backfill) reads the same lines again. Bumping `seen_count` on "the row
///   exists" would have counted those, and the column means how many records
///   carried the id. §3.8 gives the discriminator: a replay carries a
///   *different* stamp, so the bump is guarded on `at <> ?`. A repeat with the
///   same stamp as the first is indistinguishable from a re-read and is not
///   counted, which is the direction that cannot inflate the number.
/// - **A body is written only where the vault sealed one.** `Prompt` carries a
///   [`crate::promptvault::Body`]: ciphertext for a wall with an unlocked vault,
///   `withheld` where the redactor refused to keep anything, and otherwise
///   `locked` plus one `prompt_locator` row pointing at the transcript line.
///   The locator is a table of its own on purpose — `prompt_fact` is what the
///   archive serializer writes, and a path a serializer never sees is a path it
///   cannot carry (§3.8).
fn write_prompts(
    conn: &mut Connection,
    host: &str,
    prompts: &[Prompt],
    session_owners: &HashMap<String, String>,
    prior: &Prior,
) -> Result<Counts, String> {
    let mut counts = Counts::default();
    if prompts.is_empty() {
        return Ok(counts);
    }
    let tx = conn.transaction().map_err(|e| format!("analytics: prompt begin: {e}"))?;

    /* 1. The ladder, per session, exactly as the usage facts resolve it: the
          turn covering the prompt, then the session's owner, then unknown.
          A prompt is dated by when it was said, which is inside the turn it
          opened, so the first rung is the answer with no second rule. */
    let mut by_session: HashMap<String, Vec<&Prompt>> = HashMap::new();
    for p in prompts {
        by_session.entry(p.session.clone()).or_default().push(p);
    }
    let mut sessions: Vec<(String, Vec<&Prompt>)> = by_session.into_iter().collect();
    sessions.sort_by(|a, b| a.0.cmp(&b.0));

    let mut resolved: Vec<(Prompt, String, String, String, String, String)> = Vec::new();
    for (session, mut group) in sessions {
        group.sort_by_key(|p| p.at);
        let first = group.first().map(|p| p.at).unwrap_or(0);
        let last = group.last().map(|p| p.at).unwrap_or(0);
        let spans = spans_for(&tx, &session, first, last)?;
        let owners = session_owners
            .get(&session)
            .cloned()
            .filter(|i| !i.is_empty())
            .or_else(|| prior.identity.get(&session).cloned().flatten());
        let card = card_for(&tx, &session);
        let distinct: HashSet<&str> = spans
            .iter()
            .map(|s| s.identity.as_str())
            .chain(owners.as_deref())
            .filter(|i| !i.is_empty())
            .collect();
        let mut labels: HashMap<String, String> = HashMap::new();
        for id in distinct {
            if let Some(label) = crate::accounts::label_for(&tx, id) {
                labels.insert(id.to_string(), label);
            }
        }
        for p in group {
            let funding = funding_at(
                &spans,
                p.at,
                owners.as_deref(),
                &labels,
                card.as_ref().map(|c| c.label.as_str()),
            );
            let project = card
                .as_ref()
                .map(|c| c.project.clone())
                .filter(|x| !x.is_empty())
                .unwrap_or_else(|| p.project.clone());
            resolved.push((
                p.clone(),
                card.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                project,
                source_of(&p.entrypoint, card.is_some()).to_string(),
                funding.account,
                funding.provider,
            ));
        }
    }

    /* 2. New or seen, and the two writes each of them owes. */
    let mut hours: HashMap<PromptHourKey, PromptSums> = HashMap::new();
    {
        let mut known = tx
            .prepare("SELECT 1 FROM prompt_fact WHERE host = ?1 AND prompt_id = ?2")
            .map_err(|e| format!("analytics: prompt seen: {e}"))?;
        let mut bump = tx
            .prepare(
                "UPDATE prompt_fact SET seen_count = seen_count + 1
                  WHERE host = ?1 AND prompt_id = ?2 AND at <> ?3",
            )
            .map_err(|e| format!("analytics: prompt seen: {e}"))?;
        let mut insert = tx
            .prepare(
                "INSERT INTO prompt_fact
                   (host, prompt_id, at, hour, seen_count, session, card, project, source,
                    account, provider, vault_id, kind, kind_override, chars, words, lines,
                    fences, code_lines, images, questions, redactions, withheld,
                    body_state, body_truncated, body_sealed)
                 VALUES (?1,?2,?3,?4,1,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)",
            )
            .map_err(|e| format!("analytics: prompt fact: {e}"))?;
        /* One locator per locked body, and it is `OR REPLACE` because a file
           replaced under a re-read can offer the same prompt twice inside one
           pass, where the fact check above cannot see the first write yet. */
        let mut locate = tx
            .prepare(
                "INSERT OR REPLACE INTO prompt_locator (host, prompt_id, path, off)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("analytics: prompt locator: {e}"))?;
        /* **The two facts that can make a body unstorable, asked inside the
           transaction that is about to store it.**
           A walk seals a body as it reads the line and writes it a minute later,
           so a `forget prompts` or a `reset vault` in between is a gesture that
           catches nothing: the delete commits, then the seal lands behind it.
           The stamp is what the gesture leaves, and a prompt said at or before
           it goes in `locked` with a locator rather than `sealed`. The vault
           record is the reset half: a body naming a vault row that has been
           deleted can never be opened by anything, and `locked` is recoverable
           where a dead blob is not. */
        let forgotten: i64 = tx
            .query_row(
                "SELECT COALESCE((SELECT at FROM prompt_forget WHERE id = 1), 0)",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("analytics: prompt forget stamp: {e}"))?;
        let mut vault_known = tx
            .prepare("SELECT 1 FROM prompt_vault WHERE vault_id = ?1")
            .map_err(|e| format!("analytics: prompt vault: {e}"))?;

        for (p, card, project, source, account, provider) in &resolved {
            let seen = known
                .exists(params![host, &p.id])
                .map_err(|e| format!("analytics: prompt seen: {e}"))?;
            if seen {
                /* Zero rows means the store already had this id at this very
                   stamp, which is a re-read of bytes rather than a record
                   offered twice. */
                let counted = bump
                    .execute(params![host, &p.id, p.at])
                    .map_err(|e| format!("analytics: prompt seen: {e}"))?;
                if counted > 0 {
                    counts.prompt_duplicates += 1;
                }
                continue;
            }
            let hour = hour_of(p.at);
            /* The state this row is written in, which is the ingest's decision
               unless a gesture said otherwise since. **The stamp is compared
               against when this body was captured**, on this machine's clock,
               not against the prompt's own `at` — that is the transcript's
               writer's clock and a session copied from a machine that ran fast
               would otherwise slip past a forget. */
            let mut state = p.body.state;
            let mut vault_id = p.body.vault_id.as_str();
            let mut sealed = p.body.sealed.as_deref();
            let mut truncated = p.body.truncated;
            if matches!(state, "sealed" | "locked") && p.body.captured_at <= forgotten {
                /* The gesture happened after this body was captured, so the
                   gesture wins: the form is kept, the body is not, and there is
                   no locator, because a locator is exactly what `seal pending`
                   would use to put it back. `deleted` says the archive does not
                   hold it, which is true and deliberate. */
                state = "deleted";
                vault_id = "";
                sealed = None;
                truncated = false;
            } else if state == "sealed" {
                /* A body whose vault record is gone can never be opened by
                   anything. `locked` is recoverable under a new vault; a dead
                   blob is not. */
                let store_has_vault = vault_known
                    .exists(params![vault_id])
                    .map_err(|e| format!("analytics: prompt vault: {e}"))?;
                if !store_has_vault {
                    state = "locked";
                    vault_id = "";
                    sealed = None;
                    truncated = false;
                }
            }
            insert
                .execute(params![
                    host,
                    p.id,
                    p.at,
                    hour,
                    p.session,
                    card,
                    project,
                    source,
                    account,
                    provider,
                    vault_id,
                    p.kind,
                    p.form.chars as i64,
                    p.form.words as i64,
                    p.form.lines as i64,
                    p.form.fences as i64,
                    p.form.code_lines as i64,
                    p.form.images as i64,
                    p.form.questions as i64,
                    p.redactions as i64,
                    i64::from(p.withheld),
                    state,
                    i64::from(truncated),
                    sealed,
                ])
                .map_err(|e| format!("analytics: prompt fact: {e}"))?;
            if state == "locked" {
                if let Some((path, off)) = &p.body.locator {
                    locate
                        .execute(params![host, p.id, path, *off as i64])
                        .map_err(|e| format!("analytics: prompt locator: {e}"))?;
                }
            }
            counts.prompts += 1;
            hours
                .entry(PromptHourKey {
                    hour,
                    account: account.clone(),
                    provider: provider.clone(),
                    project: project.clone(),
                    source: source.clone(),
                    kind: p.kind.to_string(),
                })
                .or_default()
                .add(p);
        }
    }

    /* 3. The rollup, in the same transaction, so a correction can never find it
          a bucket behind the fact it rolls. */
    {
        let mut sql = tx
            .prepare(
                "INSERT INTO prompt_hour
                   (hour, host, account, provider, project, source, kind, prompts, chars, words,
                    lines, code_lines, questions, fences, images, redactions, withheld,
                    words_under_16, words_under_64, words_under_256, words_under_1024,
                    words_over_1024)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
                 ON CONFLICT(hour, host, account, provider, project, source, kind)
                 DO UPDATE SET
                   prompts = prompts + excluded.prompts,
                   chars = chars + excluded.chars,
                   words = words + excluded.words,
                   lines = lines + excluded.lines,
                   code_lines = code_lines + excluded.code_lines,
                   questions = questions + excluded.questions,
                   fences = fences + excluded.fences,
                   images = images + excluded.images,
                   redactions = redactions + excluded.redactions,
                   withheld = withheld + excluded.withheld,
                   words_under_16 = words_under_16 + excluded.words_under_16,
                   words_under_64 = words_under_64 + excluded.words_under_64,
                   words_under_256 = words_under_256 + excluded.words_under_256,
                   words_under_1024 = words_under_1024 + excluded.words_under_1024,
                   words_over_1024 = words_over_1024 + excluded.words_over_1024",
            )
            .map_err(|e| format!("analytics: prompt hour: {e}"))?;
        for (k, s) in &hours {
            sql.execute(params![
                k.hour,
                host,
                k.account,
                k.provider,
                k.project,
                k.source,
                k.kind,
                s.prompts,
                s.chars,
                s.words,
                s.lines,
                s.code_lines,
                s.questions,
                s.fences,
                s.images,
                s.redactions,
                s.withheld,
                s.bands[0],
                s.bands[1],
                s.bands[2],
                s.bands[3],
                s.bands[4],
            ])
            .map_err(|e| format!("analytics: prompt hour: {e}"))?;
        }
    }
    counts.prompt_hours = hours.len() as i64;

    tx.commit().map_err(|e| format!("analytics: prompt commit: {e}"))?;
    Ok(counts)
}

/// The marks and the retention deletes: **the end of the pass, in one small
/// transaction**.
///
/// The offsets advance only here, after every chunk has committed. That is what
/// makes the chunking safe: a pass that dies between chunks leaves committed
/// facts whose `usage_seen` keys are committed and whose offsets are still old,
/// so the next pass re-reads the same bytes and writes nothing new. Had the
/// offset gone into the chunk's own transaction, a crash after chunk one would
/// have advanced past requests chunk two never wrote — the one thing `usage_seen`
/// cannot repair.
///
/// Small is a property, not a hope: a mark per transcript the walk read (hundreds
/// at most) and two indexed deletes, never a row per request.
/* ── the tool and work writes (§3.7, §3.9) ──────────────────────────────── */

/// The calls this pass saw, as mutable pending rows.
///
/// **The memo is what makes a replaced file harmless.** `tool_pending` is
/// deleted when a turn folds or the sweep writes it, so its own key cannot say
/// whether a call has already been counted; `tool_seen` can, and it is the same
/// pattern `usage_seen` strikes for requests. Without it, a transcript re-read
/// from zero re-inserts a call whose turn already folded — where the marker
/// stops a second fold and the sweep's claim test stops it being written, so it
/// sits in `tool_pending` for ever — and re-inserts a subagent's call that an
/// earlier turn had claimed by its spawn, which the sweep then writes again as
/// `no-turn`.
///
/// `DO NOTHING` on the pending row stays as the belt: two files offering the
/// same call in one pass are already deduped in memory, and this is the brace.
fn write_calls(conn: &mut Connection, host: &str, calls: &[ToolCall]) -> Result<i64, String> {
    if calls.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
    let mut n = 0i64;
    {
        let mut seen = tx
            .prepare("INSERT OR IGNORE INTO tool_seen (tool_use_id, at) VALUES (?1, ?2)")
            .map_err(|e| format!("analytics: tool seen: {e}"))?;
        let mut sql = tx
            .prepare(
                "INSERT INTO tool_pending
                   (tool_use_id, at, host, session, agent, kind, server, tool, target,
                    child_agent, requested_model, async, resolved_at, errors, out_bytes)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'',?10,?11,NULL,0,0)
                 ON CONFLICT(tool_use_id) DO NOTHING",
            )
            .map_err(|e| format!("analytics: tool call: {e}"))?;
        for call in calls {
            let fresh = seen
                .execute(params![call.id, call.at])
                .map_err(|e| format!("analytics: tool seen: {e}"))?;
            if fresh == 0 {
                continue;
            }
            n += sql
                .execute(params![
                    call.id,
                    call.at,
                    host,
                    call.session,
                    call.agent,
                    call.kind,
                    call.server,
                    call.tool,
                    call.target,
                    call.requested_model,
                    call.async_ as i64,
                ])
                .map_err(|e| format!("analytics: tool call: {e}"))? as i64;
        }
    }
    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(n)
}

/// What a result adds to the call it belongs to.
///
/// **`resolved_at IS NULL` is the once-only guard.** A result seen twice — a
/// replaced file, a replay — does not move the latency, and a result landing
/// after its pending row was folded and deleted updates nothing and is dropped,
/// which is §3.7's "an unresolved call is written once as `no-result`".
fn write_results(conn: &mut Connection, results: &[ToolResult]) -> Result<i64, String> {
    if results.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
    let mut n = 0i64;
    {
        let mut sql = tx
            .prepare(
                "UPDATE tool_pending
                    SET resolved_at = ?2,
                        errors = ?3,
                        out_bytes = ?4,
                        child_agent = CASE WHEN ?5 <> '' THEN ?5 ELSE child_agent END
                  WHERE tool_use_id = ?1 AND resolved_at IS NULL",
            )
            .map_err(|e| format!("analytics: tool result: {e}"))?;
        for result in results {
            n += sql
                .execute(params![
                    result.id,
                    result.at,
                    result.errors,
                    result.out_bytes,
                    result.child_agent,
                ])
                .map_err(|e| format!("analytics: tool result: {e}"))? as i64;
        }
    }
    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(n)
}

/// The artifacts a result's command named, written as facts at once.
///
/// **A receipt needs no turn and no cost**, so it is written in the pass that
/// read it rather than waiting for a fold. It is append-only, and the key does
/// the idempotence: the same result read twice lands on the same `at`, `ref`
/// and provenance.
///
/// `ms` is the call's own latency, read off the pending row by the
/// `tool_use_id` the result carries. A receipt arriving after its pending row
/// was folded has no row to measure and says 0, which is honest: the latency is
/// unknown rather than zero.
fn write_receipts(conn: &mut Connection, host: &str, receipts: &[Receipt]) -> Result<Counts, String> {
    if receipts.is_empty() {
        return Ok(Counts::default());
    }
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
    let mut counts = Counts::default();
    let mut fact = tx
        .prepare(
            "INSERT INTO work_fact
               (at, host, session, card, agent, kind, ref, branch, project,
                files, added, removed, conflict_files, ms, provenance)
             VALUES (?1,?2,?3,?4,'',?5,?6,?7,?8,0,0,0,?9,?10,'receipt')
             ON CONFLICT DO NOTHING",
        )
        .map_err(|e| format!("analytics: work: {e}"))?;
    let mut hour = tx
        .prepare(
            "INSERT INTO work_hour
               (hour, host, project, branch, kind, count, files, added, removed, conflict_ms)
             VALUES (?1,?2,?3,?4,?5,1,0,0,0,?6)
             ON CONFLICT(hour, host, project, branch, kind) DO UPDATE SET
               count = count + 1,
               conflict_ms = conflict_ms + excluded.conflict_ms",
        )
        .map_err(|e| format!("analytics: work hour: {e}"))?;
    for receipt in receipts {
        let card = card_for(&tx, &receipt.session);
        let (card_id, card_project, card_branch) = match &card {
            Some(c) => (c.id.clone(), c.project.clone(), c.branch.clone()),
            None => (String::new(), String::new(), String::new()),
        };
        /* A card's project and branch are the authority where there is one;
           a terminal or a session whose card row is gone keeps what its own
           record said, which is the directory's last segment and `gitBranch`. */
        let project = if card_project.is_empty() {
            receipt.project.clone()
        } else {
            card_project
        };
        let branch = if receipt.branch.is_empty() {
            card_branch
        } else {
            receipt.branch.clone()
        };
        let ms: i64 = tx
            .query_row(
                "SELECT MAX(0, ?2 - at) FROM tool_pending WHERE tool_use_id = ?1",
                params![receipt.tool_use_id, receipt.at],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|e| format!("analytics: work: {e}"))?
            .flatten()
            .unwrap_or(0);
        let conflict_ms = if receipt.kind == "conflict" { ms } else { 0 };
        let inserted = fact
            .execute(params![
                receipt.at,
                host,
                receipt.session,
                card_id,
                receipt.kind,
                receipt.reference,
                branch,
                project,
                receipt.conflict_files,
                ms,
            ])
            .map_err(|e| format!("analytics: work: {e}"))? as i64;
        /* **The hour only when the fact is new.** A transcript re-read from
           zero offers the same result again and the fact's key absorbs it; the
           rollup has no key of its own, so counting every offer would double
           those receipts in the month's reading. */
        if inserted > 0 {
            counts.receipts += inserted;
            hour.execute(params![
                hour_of(receipt.at),
                host,
                project,
                branch,
                receipt.kind,
                conflict_ms,
            ])
            .map_err(|e| format!("analytics: work hour: {e}"))?;
        }
    }
    drop(fact);
    drop(hour);
    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(counts)
}

/* ── invalidation: the event and the excess (§3.9) ───────────────────────── */

/// One instruction write as a row, with its tree and the cards that pay for it.
///
/// `INSERT OR IGNORE` is the whole idempotence story: a transcript re-read from
/// zero offers the same write again, and `(at, host, session, card, kind, ref,
/// tree, provenance)` is the same key. The backfill and the live pass can touch
/// the same write and the row is written once.
fn write_writes(conn: &Connection, host: &str, writes: &[InstructionWrite]) -> Result<i64, String> {
    if writes.is_empty() {
        return Ok(0);
    }
    let mut cards: HashMap<String, Option<Card>> = HashMap::new();
    let mut sql = conn
        .prepare(
            "INSERT OR IGNORE INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'receipt')",
        )
        .map_err(|e| format!("analytics: invalidate: {e}"))?;
    let mut written = 0;
    for w in writes {
        let card = cards
            .entry(w.session.clone())
            .or_insert_with(|| card_for(conn, &w.session));
        if card.as_ref().is_some_and(|c| c.chat) {
            continue;
        }
        let tree = card
            .as_ref()
            .map(Card::tree)
            .unwrap_or_else(|| tree_of(&w.cwd));
        let card_id = card.as_ref().map(|c| c.id.clone()).unwrap_or_default();
        /* The episode this write opens, as far as it is knowable at the write:
           ten minutes on from it, counted against the sessions that exist now.
           It is **not** the episode's final count. A card that starts partway
           into a longer run is missed by this row and counted by the later write
           whose window covers it, so the reading takes the largest count across
           the run rather than trusting the opener. */
        let affected =
            sessions_sharing(conn, host, &tree, &w.session, w.at, w.at + CHURN_GAP_MS)?.len() as i64;
        written += sql
            .execute(params![
                w.at,
                host,
                w.session,
                card_id,
                w.kind,
                w.path,
                tree,
                affected
            ])
            .map_err(|e| format!("analytics: invalidate: {e}"))? as i64;
    }
    Ok(written)
}

/// A move of account, provider or model as a row (§3.9).
///
/// Written in the same transaction as the facts it was detected beside, and
/// again idempotent by key. `affected` is the timing reading: the cards working
/// at that instant, this one included.
fn write_switches(conn: &Connection, host: &str, switches: &[Switch]) -> Result<i64, String> {
    if switches.is_empty() {
        return Ok(0);
    }
    let mut sql = conn
        .prepare(
            "INSERT OR IGNORE INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'receipt')",
        )
        .map_err(|e| format!("analytics: invalidate: {e}"))?;
    let mut written = 0;
    for s in switches {
        let reference = crate::clip::preview(&s.reference, MAX_INVALIDATE_REF);
        let affected = working_at(conn, host, s.at);
        written += sql
            .execute(params![
                s.at,
                host,
                s.session,
                s.card,
                s.kind,
                reference,
                s.tree,
                affected
            ])
            .map_err(|e| format!("analytics: invalidate: {e}"))? as i64;
    }
    Ok(written)
}

/// The last request before an event and the ones around it, for §3.9's excess.
///
/// **The grain is the five-minute fact row**, because that is the finest thing
/// the store holds: a "request" here is one row's tokens divided by its request
/// count, which is the card's typical cache write per request. The first row
/// wholly after the event is the row at or after its instant — a bucket that
/// began before the event mixes pre-event requests into the write and would
/// overstate the excess.
fn measure_excess(
    conn: &Connection,
    session: &str,
    host: &str,
    at: i64,
) -> Result<Option<(String, i64, i64, i64)>, String> {
    let first: Option<(i64, String, i64, i64, i64)> = conn
        .query_row(
            "SELECT at, model, write_5m + write_1h, in_tok, requests FROM usage_fact
              WHERE session = ?1 AND host = ?2 AND agent = '' AND requests > 0
                AND at >= ?3 AND at <= ?4
              ORDER BY at ASC LIMIT 1",
            params![session, host, at, at + ATTRIBUTE_WAIT_MS],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("analytics: attribute: {e}"))?;
    let Some((paid_at, model, write, input, requests)) = first else {
        /* No request within the wait: unmeasured, which is not the same as
           free and is why no row is written. */
        return Ok(None);
    };
    if requests <= 0 {
        return Ok(None);
    }

    let mut stmt = conn
        .prepare(
            "SELECT write_5m + write_1h, in_tok, requests FROM usage_fact
              WHERE session = ?1 AND host = ?2 AND agent = '' AND requests > 0 AND at < ?3
              ORDER BY at DESC LIMIT ?4",
        )
        .map_err(|e| format!("analytics: attribute: {e}"))?;
    let recent: Vec<(f64, f64)> = stmt
        .query_map(params![session, host, at, MEDIAN_REQUESTS as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("analytics: attribute: {e}"))?
        .filter_map(Result::ok)
        .filter(|(_, _, n)| *n > 0)
        .map(|(w, i, n)| (w as f64 / n as f64, i as f64 / n as f64))
        .collect();
    drop(stmt);
    if recent.len() < MEDIAN_FLOOR {
        return Ok(None);
    }
    /* A median per bucket rather than one over their sum: the two are billed at
       different rates, and a request whose cache write fell while its fresh
       input rose is not evidence of a re-read. Sorting by the bucket's own
       value and taking the middle is what §3.9 means by *that card's median*. */
    let median = |pick: fn(&(f64, f64)) -> f64| {
        let mut values: Vec<f64> = recent.iter().map(pick).collect();
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = values.len() / 2;
        if values.len() % 2 == 0 {
            (values[mid - 1] + values[mid]) / 2.0
        } else {
            values[mid]
        }
    };
    let write_excess = (write as f64 / requests as f64) - median(|v| v.0);
    let input_excess = (input as f64 / requests as f64) - median(|v| v.1);
    Ok(Some((
        model,
        write_excess.max(0.0).round() as i64,
        input_excess.max(0.0).round() as i64,
        paid_at,
    )))
}

/// Whether a later receipt on this tree stands at or before the paying request.
///
/// The claim rule for a write's excess: **a re-read belongs to the latest event
/// on that tree before the paying request.** It matters only because the wait is
/// hours; at thirty minutes no two events could share one request. It is a range
/// read on `invalidate_fact_by_tree`.
fn later_receipt(
    conn: &Connection,
    host: &str,
    tree: &str,
    after: i64,
    upto: i64,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM invalidate_fact
          WHERE host = ?1 AND tree = ?2 AND provenance = 'receipt'
            AND at > ?3 AND at <= ?4",
        params![host, tree, after, upto],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .map_err(|e| format!("analytics: attribute: {e}"))
}

/// One event's attributed excess, written as a second row at the same key.
struct Event {
    at: i64,
    session: String,
    card: String,
    kind: String,
    reference: String,
    tree: String,
    /// The run of writes this event closes, for an instruction or a rule.
    start: i64,
    end: i64,
}

/// Attribute the excess to the cards that paid it (§3.9).
///
/// **The event is exact and the cost is an inference, and the two are different
/// rows.** Every receipt row in the lookback window is grouped into its churn
/// episode; only the episode's *last* write is priced, because the earlier ones
/// were overwritten before anybody read them. For each payer — the other card
/// sessions that overlapped the episode, or the moved card itself for a switch
/// — the first request after the event is compared with that card's own median
/// cache write, and the excess is stored in cache-write tokens. Rust never
/// prices (`usage.rs`'s rule); the front end does, through the one rate table.
///
/// Re-running is safe and intended: the same inputs write the same row, and an
/// event revisited as its payers' requests land moves from unmeasured to
/// measured without a second event.
///
/// **The payer set is not settled when the event lands, and that is the point
/// of the re-run.** `sessions_sharing` is asked again on every pass, and a card
/// that was at rest through the episode joins the set the moment its session row
/// grows to cover the event — which happens when it is woken and takes its first
/// request. That is also why the wait may be hours: the pass that first sees the
/// woken card's request is the pass that attributes the excess to it.
fn attribute(conns: &Mutex<Connection>, host: &str, now: i64) -> Result<Counts, String> {
    let mut counts = Counts::default();
    let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
    let from = now - ATTRIBUTE_LOOKBACK_MS;
    let upto = now - CHURN_GAP_MS;

    let mut stmt = conn
        .prepare(
            "SELECT at, session, card, kind, ref, tree FROM invalidate_fact
              WHERE host = ?1 AND provenance = 'receipt' AND at >= ?2 AND at <= ?3
              ORDER BY at ASC, session ASC",
        )
        .map_err(|e| format!("analytics: attribute: {e}"))?;
    let rows: Vec<(i64, String, String, String, String, String)> = stmt
        .query_map(params![host, from, upto], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(|e| format!("analytics: attribute: {e}"))?
        .filter_map(Result::ok)
        .collect();
    drop(stmt);

    /* Group into episodes. A run of writes to one tree and one key within the
       gap is one event; a switch is its own. */
    let mut events: Vec<Event> = Vec::new();
    let mut open: HashMap<(String, String), usize> = HashMap::new();
    for (at, session, card, kind, reference, tree) in rows {
        let key = invalidate_key(&kind, &reference);
        let churn = kind == "instructions" || kind == "rule";
        if churn {
            if let Some(&i) = open.get(&(tree.clone(), key.clone())) {
                if at >= events[i].start && at - events[i].end <= CHURN_GAP_MS {
                    events[i].at = at;
                    events[i].end = at;
                    events[i].session = session;
                    events[i].card = card;
                    continue;
                }
            }
        }
        let i = events.len();
        events.push(Event {
            at,
            session,
            card,
            kind: kind.clone(),
            reference,
            tree: tree.clone(),
            start: at,
            end: at,
        });
        if churn {
            open.insert((tree, key), i);
        }
    }

    let mut insert = conn
        .prepare(
            "INSERT OR REPLACE INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, tokens, in_tokens,
                model, usd, provenance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, 0, 'attributed')",
        )
        .map_err(|e| format!("analytics: attribute: {e}"))?;

    for event in &events {
        /* Who pays. A write is paid by the other cards in its tree that were
           working through the episode; a switch by the card that moved. The
           payer is a *session*, because that is the grain the request facts
           are keyed by and one card can have had several. */
        let payers: Vec<String> = if event.kind == "instructions" || event.kind == "rule" {
            sessions_sharing(&conn, host, &event.tree, &event.session, event.start, event.end)?
        } else if event.session.is_empty() {
            Vec::new()
        } else {
            vec![event.session.clone()]
        };

        for session in payers {
            let card = card_for(&conn, &session)
                .map(|c| c.id)
                .unwrap_or_else(|| {
                    if session == event.session {
                        event.card.clone()
                    } else {
                        String::new()
                    }
                });
            let Some((model, tokens, in_tokens, paid_at)) =
                measure_excess(&conn, &session, host, event.at)?
            else {
                continue;
            };
            /* **A re-read belongs to the latest event on that tree before the
               paying request.** With a wait measured in hours, two instruction
               writes on one tree can otherwise both find the same woken card's
               first request and count one re-read twice. It is §3.9's churn
               sentence one timescale out: an earlier write was overwritten (or,
               here, superseded) before anybody read it. A switch needs no such
               rule — it retires the cache key itself and its payer is the card
               that moved. */
            if (event.kind == "instructions" || event.kind == "rule")
                && later_receipt(&conn, host, &event.tree, event.at, paid_at)?
            {
                continue;
            }
            insert
                .execute(params![
                    event.at,
                    host,
                    session,
                    card,
                    event.kind,
                    event.reference,
                    event.tree,
                    tokens,
                    in_tokens,
                    model
                ])
                .map_err(|e| format!("analytics: attribute: {e}"))?;
            counts.attributed += 1;
        }
    }
    Ok(counts)
}

/// The sessions — not the cards — that shared a tree through an episode.
fn sessions_sharing(
    conn: &Connection,
    host: &str,
    tree: &str,
    writer: &str,
    from: i64,
    to: i64,
) -> Result<Vec<String>, String> {
    if tree.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT s.session FROM analytics_session s
              WHERE s.host = ?1 AND s.session <> ?2
                AND s.started_at <= ?3 AND (s.ended_at IS NULL OR s.ended_at >= ?4)
              ORDER BY s.session",
        )
        .map_err(|e| format!("analytics: sharers: {e}"))?;
    let sessions: Vec<String> = stmt
        .query_map(params![host, writer, to, from], |r| r.get::<_, String>(0))
        .map_err(|e| format!("analytics: sharers: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: sharers: {e}"))?;
    drop(stmt);
    let mut out = Vec::new();
    for session in sessions {
        let Some(card) = card_for(conn, &session) else { continue };
        if !card.chat && card.tree() == tree {
            out.push(session);
        }
    }
    Ok(out)
}

/// The one-off walk of every transcript, for the writes that happened before
/// this feature shipped (§3.9).
///
/// **Transcripts are on a deletion clock and the store is not.** A `CLAUDE.md`
/// written three months ago and since swept is an invalidation this wall paid
/// for and would otherwise never know about, so this reads each file from its
/// beginning once and marks it in `invalidate_walk`. It touches no offset in
/// `usage_file` and writes no other fact: those offsets are the collector's, and
/// a backfill that moved one would make every other reading skip bytes.
///
/// **Bounded per pass, on the existing beat.** Twelve files and sixty-four
/// megabytes a minute is one minute's disk work rather than a launch-long
/// stall; the mark means the work shrinks to nothing and never comes back. A
/// file past the size cap is marked and counted rather than retried for ever —
/// a hole with a number beside it is a reading, a silent skip is not.
fn backfill(
    conns: &Mutex<Connection>,
    app: &AppHandle,
    host: &str,
    now: i64,
) -> Result<Counts, String> {
    backfill_paths(conns, host, now, crate::usage::transcript_paths(app))
}

/// The walk itself, over a list of transcripts, so a suite can hand it a
/// temporary directory rather than this machine's history.
fn backfill_paths(
    conns: &Mutex<Connection>,
    host: &str,
    now: i64,
    paths: Vec<PathBuf>,
) -> Result<Counts, String> {
    let mut counts = Counts::default();
    let done: HashSet<String> = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let mut stmt = conn
            .prepare("SELECT path FROM invalidate_walk WHERE host = ?1")
            .map_err(|e| format!("analytics: invalidate walk: {e}"))?;
        let rows = stmt
            .query_map([host], |r| r.get::<_, String>(0))
            .map_err(|e| format!("analytics: invalidate walk: {e}"))?;
        rows.filter_map(Result::ok).collect()
    };

    let mut bytes = 0u64;
    for path in paths {
        if counts.walked as usize >= BACKFILL_FILES || bytes >= BACKFILL_BYTES {
            break;
        }
        let key = path.to_string_lossy().to_string();
        if done.contains(&key) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let size = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        /* A file too large to read whole is marked rather than retried every
           minute for the rest of the wall's life. */
        if size > BACKFILL_FILE_CAP {
            let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO invalidate_walk (path, host, size, mtime, done_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![key, host, size as i64, mtime, now],
            )
            .map_err(|e| format!("analytics: invalidate walk: {e}"))?;
            counts.unreadable += 1;
            continue;
        }
        let Ok(data) = std::fs::read(&path) else { continue };
        let needle: &[u8] = b"\"tool_use\"";
        let mut writes: Vec<InstructionWrite> = Vec::new();
        for line in data.split(|b| *b == b'\n') {
            if !line.windows(needle.len()).any(|w| w == needle) {
                continue;
            }
            let text = String::from_utf8_lossy(line);
            writes.extend(parse_writes(&text));
        }
        bytes += size;
        counts.walked += 1;

        let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("analytics: begin: {e}"))?;
        let written = write_writes(&tx, host, &writes)?;
        tx.execute(
            "INSERT OR REPLACE INTO invalidate_walk (path, host, size, mtime, done_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key, host, size as i64, mtime, now],
        )
        .map_err(|e| format!("analytics: invalidate walk: {e}"))?;
        tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
        counts.invalidations += written;
    }
    Ok(counts)
}

/* ── the fold (§3.7) ─────────────────────────────────────────────────────── */

/// How long after a turn settles its calls are folded.
///
/// **The grace is what lets a result that landed just after `ended_at` be
/// written rather than swept.** Too short and a slow receipt becomes a
/// `no-result` row on the ordinary path; a turn's own end is written by the
/// front end when its `result` arrives, and the result records of the calls in
/// it are already on disk by then, so thirty seconds is generous rather than
/// tight.
const FOLD_GRACE_MS: i64 = 30_000;

/// How long a call with no turn waits before the sweep writes it as `no-turn`.
///
/// Longer than the fold grace on purpose: a call inside a just-settled turn
/// must be folded, not swept, and the claim test alone would not save it if the
/// sweep ran before the fold.
const NO_TURN_WAIT_MS: i64 = 10 * 60 * 1000;

/// How many settled turns one pass folds. A wall upgrading on a year of history
/// has thousands, and the pass must remain bounded: each turn is its own
/// transaction, and the rest wait for the next minute.
const FOLD_TURNS_PER_PASS: i64 = 400;

/// How many pending rows one fold or sweep transaction carries.
const FOLD_BATCH: i64 = 500;

/// One settled turn, as the fold reads it.
struct FoldTurn {
    id: i64,
    session: String,
    opened: i64,
    ended: i64,
    usd: f64,
    account: String,
    provider: String,
    project: String,
}

/// One pending call, as a fold or sweep reads it.
struct Pending {
    id: String,
    at: i64,
    agent: String,
    kind: String,
    server: String,
    tool: String,
    target: String,
    child_agent: String,
    requested_model: String,
    async_: i64,
    ms: i64,
    errors: i64,
    out_bytes: i64,
}

/// What one `tool_hour` row accumulates.
#[derive(Default)]
struct ToolSum {
    calls: i64,
    errors: i64,
    receipts: i64,
    ms: i64,
    under_50: i64,
    under_200: i64,
    under_1s: i64,
    under_5s: i64,
    over_5s: i64,
    out_bytes: i64,
    usd: f64,
}

impl ToolSum {
    fn add(&mut self, row: &Pending, usd: f64) {
        self.calls += 1;
        self.errors += row.errors;
        self.receipts += row.async_;
        self.ms += row.ms;
        self.out_bytes += row.out_bytes;
        self.usd += usd;
        /* A call with no result contributes no latency, so it lands in no
           bucket: a median is over completed calls and the count is over all of
           them (§3.7). */
        if row.ms > 0 {
            if row.ms < 50 {
                self.under_50 += 1;
            } else if row.ms < 200 {
                self.under_200 += 1;
            } else if row.ms < 1_000 {
                self.under_1s += 1;
            } else if row.ms < 5_000 {
                self.under_5s += 1;
            } else {
                self.over_5s += 1;
            }
        }
    }
}

/// Fold every settled turn that has come of age, then sweep what no turn
/// claimed.
///
/// **The order is the correctness.** Folding first means a call inside a
/// settled turn is written against its turn before the sweep is allowed to look
/// at it; the sweep's claim test is every turn's interval, open or settled, so
/// it could not steal one anyway — but the order makes the ordinary case
/// independent of that test being right.
fn fold_tools(conns: &Mutex<Connection>, host: &str, now: i64) -> Result<Counts, String> {
    let turns = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT t.id, COALESCE(t.agent_session_id, ''), t.opened_at, t.ended_at,
                        t.usd, COALESCE(t.account_label, ''), COALESCE(t.provider, ''),
                        COALESCE((SELECT p.name FROM conversation c
                                    LEFT JOIN project p ON p.id = c.project_id
                                   WHERE c.id = t.conversation_id), '')
                   FROM turn t
                  WHERE t.ended_at IS NOT NULL
                    AND t.ended_at <= ?1
                    AND NOT EXISTS (SELECT 1 FROM analytics_fold f WHERE f.turn_id = t.id)
                  ORDER BY t.id
                  LIMIT ?2",
            )
            .map_err(|e| format!("analytics: fold turns: {e}"))?;
        let rows = stmt
            .query_map(params![now - FOLD_GRACE_MS, FOLD_TURNS_PER_PASS], |r| {
                let account: String = r.get(5)?;
                let provider: String = r.get(6)?;
                Ok(FoldTurn {
                    id: r.get(0)?,
                    session: r.get(1)?,
                    opened: r.get(2)?,
                    ended: r.get(3)?,
                    usd: r.get(4)?,
                    account: if account.trim().is_empty() {
                        "unknown".into()
                    } else {
                        account
                    },
                    provider: if provider.trim().is_empty() {
                        provider_of(Some(&r.get::<_, String>(5)?.clone())).to_string()
                    } else {
                        provider
                    },
                    project: r.get(7)?,
                })
            })
            .map_err(|e| format!("analytics: fold turns: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("analytics: fold turns: {e}"))?;
        rows
    };

    /* **The spawn map is built before any turn folds**, because folding deletes
       the spawning call's pending row and a child whose parent folded first
       would then be claimed by whichever turn happened to be running when it
       acted — exactly the rule §3.7 forbids. One read for the whole pass is also
       what makes the answer independent of the order the turns fold in. */
    let spawn: HashMap<(String, String), i64> = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT session, child_agent, MIN(at) FROM tool_pending
                  WHERE child_agent <> ''
                  GROUP BY session, child_agent",
            )
            .map_err(|e| format!("analytics: fold: {e}"))?;
        let collected = stmt
            .query_map([], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("analytics: fold: {e}"))?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| format!("analytics: fold: {e}"))?;
        collected
    };

    let mut counts = Counts::default();
    for turn in &turns {
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            fold_one(&mut conn, host, turn, now, &spawn)?
        };
        counts.add(written);
    }
    counts.add(sweep_no_turn(conns, host, now)?);
    Ok(counts)
}

/// One turn, one transaction: the facts, the hour rows, the marker and the
/// delete of what it consumed.
///
/// **All five in one commit, or none of them.** A crash before the commit rolls
/// the fold back and the next pass writes it once; a crash after leaves the
/// marker that skips it. With `tool_hour` outside the transaction a crash in
/// the window would lose the monthly reading of those calls for good, because
/// the marker then prevents a re-fold from repairing it.
fn fold_one(
    conn: &mut Connection,
    host: &str,
    turn: &FoldTurn,
    now: i64,
    spawn: &HashMap<(String, String), i64>,
) -> Result<Counts, String> {
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
    let mut counts = Counts::default();
    counts.folds = 1;

    tx.execute(
        "INSERT OR IGNORE INTO analytics_fold (turn_id, at) VALUES (?1, ?2)",
        params![turn.id, now],
    )
    .map_err(|e| format!("analytics: fold mark: {e}"))?;

    /* A turn with no session or no duration writes the marker and no facts, so
       the pass does not reconsider it every minute. Its calls are not deleted:
       they are in no interval, so the sweep writes them as `no-turn` once they
       are old enough — the count and latency survive even where the money
       cannot. */
    if turn.session.is_empty() || turn.opened >= turn.ended {
        tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
        return Ok(counts);
    }

    /* The spawn map: a subagent's call belongs to the turn its **spawning**
       call fell in, not to whichever turn was running when it acted (§3.7).
       It is built once for the pass (`fold_tools`) from the whole session's
       pending rows, because folding the spawning turn deletes its row. A spawn
       that folded in an earlier pass is not there, and the call falls back to
       its own timestamp — the one case this cannot repair, and the smaller
       loss. */
    /* **The session's pending rows, not just the interval's.** A subagent's call
       is claimed from where its spawn fell, which can be outside this turn, so
       the filter is the claim in Rust rather than a `BETWEEN` here. That read is
       bounded by the calls a live session is holding, not by its history: every
       fold deletes what it consumed and the sweep clears what no turn claims, so
       the set is the work since the last settle. */
    let pending = {
        let mut stmt = tx
            .prepare(
                "SELECT tool_use_id, at, agent, kind, server, tool, target, child_agent,
                        requested_model, async, resolved_at, errors, out_bytes
                   FROM tool_pending
                  WHERE session = ?1",
            )
            .map_err(|e| format!("analytics: fold: {e}"))?;
        let rows = stmt
            .query_map([&turn.session], |r| {
                let resolved: Option<i64> = r.get(10)?;
                Ok(Pending {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    agent: r.get(2)?,
                    kind: r.get(3)?,
                    server: r.get(4)?,
                    tool: r.get(5)?,
                    target: r.get(6)?,
                    child_agent: r.get(7)?,
                    requested_model: r.get(8)?,
                    async_: r.get(9)?,
                    ms: resolved.map(|done| (done - r.get::<_, i64>(1).unwrap_or(0)).max(0)).unwrap_or(0),
                    errors: r.get(11)?,
                    out_bytes: r.get(12)?,
                })
            })
            .map_err(|e| format!("analytics: fold: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("analytics: fold: {e}"))?;
        rows
    };
    let claimed: Vec<Pending> = pending
        .into_iter()
        .filter(|row| {
            let claim = if row.agent.is_empty() {
                row.at
            } else {
                spawn
                    .get(&(turn.session.clone(), row.agent.clone()))
                    .copied()
                    .unwrap_or(row.at)
            };
            claim >= turn.opened && claim < turn.ended
        })
        .collect();

    if claimed.is_empty() {
        tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
        return Ok(counts);
    }

    let total = claimed.len() as f64;
    /* One row per tool and target, in a stable order so two stores diff. */
    let mut groups: std::collections::BTreeMap<(String, String, String, String, String, String), Vec<usize>> =
        std::collections::BTreeMap::new();
    for (i, row) in claimed.iter().enumerate() {
        groups
            .entry((
                row.agent.clone(),
                row.kind.clone(),
                row.server.clone(),
                row.tool.clone(),
                row.target.clone(),
                row.child_agent.clone(),
            ))
            .or_default()
            .push(i);
    }

    {
        let mut fact = tx
            .prepare(
                "INSERT INTO tool_fact
                   (turn_id, at, host, session, agent, kind, server, tool, target,
                    child_agent, requested_model, calls, errors, ms_total, out_bytes, turn_usd)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
                 ON CONFLICT DO NOTHING",
            )
            .map_err(|e| format!("analytics: tool fact: {e}"))?;
        for ((agent, kind, server, tool, target, child), indexes) in &groups {
            let calls = indexes.len() as i64;
            let errors: i64 = indexes.iter().map(|i| claimed[*i].errors).sum();
            let ms_total: i64 = indexes.iter().map(|i| claimed[*i].ms).sum();
            let out_bytes: i64 = indexes.iter().map(|i| claimed[*i].out_bytes).sum();
            let requested = indexes
                .iter()
                .map(|i| claimed[*i].requested_model.as_str())
                .find(|m| !m.is_empty())
                .unwrap_or("");
            /* **The exact apportionment.** The divisor is the turn's own calls,
               so a sum over the rows is the turn; a no-turn row is outside the
               denominator by construction (§3.7). */
            let usd = turn.usd * calls as f64 / total;
            counts.facts += fact
                .execute(params![
                    turn.id,
                    turn.ended,
                    host,
                    turn.session,
                    agent,
                    kind,
                    server,
                    tool,
                    target,
                    child,
                    requested,
                    calls,
                    errors,
                    ms_total,
                    out_bytes,
                    usd,
                ])
                .map_err(|e| format!("analytics: tool fact: {e}"))? as i64;
        }
    }

    {
        let share = turn.usd / total;
        let hour = hour_of(turn.ended);
        let mut sums: std::collections::BTreeMap<(String, String, String, String), ToolSum> =
            std::collections::BTreeMap::new();
        for row in &claimed {
            sums.entry((
                row.kind.clone(),
                row.server.clone(),
                row.tool.clone(),
                row.target.clone(),
            ))
            .or_default()
            .add(row, share);
        }
        let mut sql = tx
            .prepare(
                "INSERT INTO tool_hour
                   (hour, host, account, provider, project, kind, server, tool, target,
                    calls, errors, receipts, ms_total,
                    ms_under_50, ms_under_200, ms_under_1s, ms_under_5s, ms_over_5s,
                    out_bytes, turn_usd)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
                 ON CONFLICT(hour, host, account, provider, project, kind, server, tool, target)
                 DO UPDATE SET
                   calls = calls + excluded.calls,
                   errors = errors + excluded.errors,
                   receipts = receipts + excluded.receipts,
                   ms_total = ms_total + excluded.ms_total,
                   ms_under_50 = ms_under_50 + excluded.ms_under_50,
                   ms_under_200 = ms_under_200 + excluded.ms_under_200,
                   ms_under_1s = ms_under_1s + excluded.ms_under_1s,
                   ms_under_5s = ms_under_5s + excluded.ms_under_5s,
                   ms_over_5s = ms_over_5s + excluded.ms_over_5s,
                   out_bytes = out_bytes + excluded.out_bytes,
                   turn_usd = turn_usd + excluded.turn_usd",
            )
            .map_err(|e| format!("analytics: tool hour: {e}"))?;
        for ((kind, server, tool, target), sum) in &sums {
            sql.execute(params![
                hour,
                host,
                turn.account,
                turn.provider,
                turn.project,
                kind,
                server,
                tool,
                target,
                sum.calls,
                sum.errors,
                sum.receipts,
                sum.ms,
                sum.under_50,
                sum.under_200,
                sum.under_1s,
                sum.under_5s,
                sum.over_5s,
                sum.out_bytes,
                sum.usd,
            ])
            .map_err(|e| format!("analytics: tool hour: {e}"))?;
        }
    }

    {
        let mut gone = tx
            .prepare("DELETE FROM tool_pending WHERE tool_use_id = ?1")
            .map_err(|e| format!("analytics: fold: {e}"))?;
        for row in &claimed {
            gone.execute([&row.id])
                .map_err(|e| format!("analytics: fold: {e}"))?;
        }
    }

    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(counts)
}

/// Write the calls no turn ever claimed, once they are old enough.
///
/// **The claim is the test, not the age** (§3.7): a call inside a live turn is
/// inside its open interval and is never swept however old it is. The age only
/// keeps a result that is still on its way from being written as `no-result`
/// first. A swept row keeps `turn_id = 0` and `turn_usd = 0`, so it is outside
/// every turn's denominator by construction.
fn sweep_no_turn(conns: &Mutex<Connection>, host: &str, now: i64) -> Result<Counts, String> {
    let mut counts = Counts::default();
    /* A fixed number of batches per pass, so a corpus with a year of terminal
       calls cannot turn one minute's ingest into a long hold. */
    for _ in 0..16 {
        let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
        let rows = {
            let mut stmt = tx
                .prepare(
                    "SELECT p.tool_use_id, p.at, p.session, p.agent, p.kind, p.server,
                            p.tool, p.target, p.child_agent, p.requested_model, p.async,
                            p.resolved_at, p.errors, p.out_bytes
                       FROM tool_pending p
                      WHERE p.at < ?1
                        AND NOT EXISTS (
                              SELECT 1 FROM turn t
                               WHERE t.agent_session_id = p.session
                                 AND t.opened_at <= p.at
                                 AND (t.ended_at IS NULL OR p.at < t.ended_at))
                      ORDER BY p.at
                      LIMIT ?2",
                )
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            let collected = stmt
                .query_map(params![now - NO_TURN_WAIT_MS, FOLD_BATCH], |r| {
                let at: i64 = r.get(1)?;
                let resolved: Option<i64> = r.get(11)?;
                Ok((
                    Pending {
                        id: r.get(0)?,
                        at,
                        agent: r.get(3)?,
                        kind: r.get(4)?,
                        server: r.get(5)?,
                        tool: r.get(6)?,
                        target: r.get(7)?,
                        child_agent: r.get(8)?,
                        requested_model: r.get(9)?,
                        async_: r.get(10)?,
                        ms: resolved.map(|done| (done - at).max(0)).unwrap_or(0),
                        errors: r.get(12)?,
                        out_bytes: r.get(13)?,
                    },
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("analytics: sweep: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            collected
        };
        if rows.is_empty() {
            break;
        }
        let full = rows.len() as i64 == FOLD_BATCH;
        let with_session = rows;

        /* The project is the session's, where the ingest has written one; a
           session it has never seen is `''` rather than guessed. Account and
           provider are `unknown`, because no turn named them. */
        let mut projects: HashMap<String, String> = HashMap::new();
        for (_, session) in &with_session {
            if projects.contains_key(session) {
                continue;
            }
            let project: Option<String> = tx
                .query_row(
                    "SELECT project FROM analytics_session WHERE session = ?1 AND host = ?2",
                    params![session, host],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            projects.insert(session.clone(), project.unwrap_or_default());
        }

        let mut groups: std::collections::BTreeMap<(i64, String, String, String, String, String, String, String), Vec<&Pending>> =
            std::collections::BTreeMap::new();
        for (row, session) in &with_session {
            groups
                .entry((
                    bucket_of(row.at),
                    session.clone(),
                    row.agent.clone(),
                    row.kind.clone(),
                    row.server.clone(),
                    row.tool.clone(),
                    row.target.clone(),
                    row.child_agent.clone(),
                ))
                .or_default()
                .push(row);
        }
        {
            let mut fact = tx
                .prepare(
                    "INSERT INTO tool_fact
                       (turn_id, at, host, session, agent, kind, server, tool, target,
                        child_agent, requested_model, calls, errors, ms_total, out_bytes,
                        turn_usd)
                     VALUES (0,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,0)
                     ON CONFLICT(turn_id, at, host, session, agent, kind, server, tool,
                                 target, child_agent)
                     DO UPDATE SET
                       calls = calls + excluded.calls,
                       errors = errors + excluded.errors,
                       ms_total = ms_total + excluded.ms_total,
                       out_bytes = out_bytes + excluded.out_bytes",
                )
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            let mut hour = tx
                .prepare(
                    "INSERT INTO tool_hour
                       (hour, host, account, provider, project, kind, server, tool, target,
                        calls, errors, receipts, ms_total,
                        ms_under_50, ms_under_200, ms_under_1s, ms_under_5s, ms_over_5s,
                        out_bytes, turn_usd)
                     VALUES (?1,?2,'unknown','unknown',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,0)
                     ON CONFLICT(hour, host, account, provider, project, kind, server, tool, target)
                     DO UPDATE SET
                       calls = calls + excluded.calls,
                       errors = errors + excluded.errors,
                       receipts = receipts + excluded.receipts,
                       ms_total = ms_total + excluded.ms_total,
                       ms_under_50 = ms_under_50 + excluded.ms_under_50,
                       ms_under_200 = ms_under_200 + excluded.ms_under_200,
                       ms_under_1s = ms_under_1s + excluded.ms_under_1s,
                       ms_under_5s = ms_under_5s + excluded.ms_under_5s,
                       ms_over_5s = ms_over_5s + excluded.ms_over_5s,
                       out_bytes = out_bytes + excluded.out_bytes",
                )
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            for ((at, session, agent, kind, server, tool, target, child), rows) in &groups {
                let calls = rows.len() as i64;
                let errors: i64 = rows.iter().map(|r| r.errors).sum();
                let ms_total: i64 = rows.iter().map(|r| r.ms).sum();
                let out_bytes: i64 = rows.iter().map(|r| r.out_bytes).sum();
                let requested = rows
                    .iter()
                    .map(|r| r.requested_model.as_str())
                    .find(|m| !m.is_empty())
                    .unwrap_or("");
                counts.no_turn += fact
                    .execute(params![
                        at, host, session, agent, kind, server, tool, target, child,
                        requested, calls, errors, ms_total, out_bytes
                    ])
                    .map_err(|e| format!("analytics: sweep: {e}"))? as i64;
                let project = projects.get(session).cloned().unwrap_or_default();
                let mut sum = ToolSum::default();
                for row in rows {
                    sum.add(row, 0.0);
                }
                hour.execute(params![
                    hour_of(*at),
                    host,
                    project,
                    kind,
                    server,
                    tool,
                    target,
                    calls,
                    sum.errors,
                    sum.receipts,
                    sum.ms,
                    sum.under_50,
                    sum.under_200,
                    sum.under_1s,
                    sum.under_5s,
                    sum.over_5s,
                    sum.out_bytes,
                ])
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            }
        }
        {
            let mut gone = tx
                .prepare("DELETE FROM tool_pending WHERE tool_use_id = ?1")
                .map_err(|e| format!("analytics: sweep: {e}"))?;
            for (row, _) in &with_session {
                gone.execute([&row.id])
                    .map_err(|e| format!("analytics: sweep: {e}"))?;
            }
        }
        tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
        if !full {
            break;
        }
    }
    Ok(counts)
}

fn write_tail(
    conn: &mut Connection,
    files: &[FileMark],
    alive: &HashSet<String>,
    now: i64,
) -> Result<(), String> {
    let cutoff = now - FINE_KEEP_MS;
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;

    /* 7. The offsets — only the bytes that ended in a newline, which is what
          `usage.rs` hands over — and the marks for files that are gone. */
    {
        let mut sql = tx
            .prepare("INSERT OR REPLACE INTO usage_file (path, offset, mtime, size) VALUES (?1,?2,?3,?4)")
            .map_err(|e| format!("analytics: file: {e}"))?;
        for f in files {
            sql.execute(params![f.path, f.mark.offset as i64, f.mark.mtime, f.mark.size as i64])
                .map_err(|e| format!("analytics: file: {e}"))?;
        }
        drop(sql);
        /* A mark for a transcript that no longer exists is dead weight read
           into memory on every pass, and nothing else ever deletes one. The
           guard is not cosmetic: a walk that could not read the root at all
           reports no files, and pruning on that would throw away every offset
           and re-read ninety days the next time the disk came back. */
        if !alive.is_empty() {
            let known: Vec<String> = {
                let mut stmt = tx
                    .prepare("SELECT path FROM usage_file")
                    .map_err(|e| format!("analytics: file: {e}"))?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| format!("analytics: file: {e}"))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("analytics: file: {e}"))?
            };
            let mut gone = tx
                .prepare("DELETE FROM usage_file WHERE path = ?1")
                .map_err(|e| format!("analytics: file: {e}"))?;
            for path in known {
                if !alive.contains(&path) {
                    gone.execute([&path])
                        .map_err(|e| format!("analytics: file: {e}"))?;
                }
            }
        }
    }

    /* 8. Retention. The fine tier and the dedupe that guards it are kept for the
          same ninety days; the hourly tier outlives both (§3.6).
          **A fact is pruned by the end of its bucket, not its start.** `at` is
          the bucket's beginning, so `at < cutoff` deleted a row for a request
          that was inside the window while keeping its `usage_seen` key: that
          request could never be written again, and a five-minute band at the old
          edge of the tier was a hole for ever.
          **Written as a bound on `at` rather than on `at + BUCKET_MS`** so
          `usage_fact_by_at` answers it with a range search: the arithmetic form
          is not sargable and scans the whole fine tier. This tail is the entire
          store hold on a quiet pass, which is exactly where a cost proportional
          to the table rather than to the work cannot hide. */
    tx.execute("DELETE FROM usage_fact WHERE at <= ?1", [cutoff - BUCKET_MS])
        .map_err(|e| format!("analytics: prune facts: {e}"))?;
    tx.execute("DELETE FROM usage_seen WHERE at < ?1", [cutoff])
        .map_err(|e| format!("analytics: prune seen: {e}"))?;
    /* **The tool and work fine tiers keep the same ninety days**, and their
       memos with them (§3.9, §7.2). `analytics_fold` goes too: its marker is
       only consulted for a turn that could still have pending rows, and none
       can be older than the window the walk is willing to read. `tool_hour` and
       `work_hour` are the rollups and are deliberately not here. */
    tx.execute(
        "DELETE FROM tool_fact WHERE at <= ?1",
        [cutoff - BUCKET_MS],
    )
    .map_err(|e| format!("analytics: prune tools: {e}"))?;
    tx.execute("DELETE FROM tool_seen WHERE at < ?1", [cutoff])
        .map_err(|e| format!("analytics: prune tool seen: {e}"))?;
    tx.execute("DELETE FROM work_fact WHERE at < ?1", [cutoff])
        .map_err(|e| format!("analytics: prune work: {e}"))?;
    tx.execute("DELETE FROM analytics_fold WHERE at < ?1", [cutoff])
        .map_err(|e| format!("analytics: prune folds: {e}"))?;
    /* The invalidation fine tier keeps the same ninety days, **except the move
       receipts**: an account, provider or model change is a card's history
       rather than a moment, the same distinction `analytics_session` and the
       walk mark make. A card's page draws its change timeline from them
       (§11.10), and one pruned at ninety days would say a card that swapped
       accounts last spring never did. They are bounded by a person's gestures,
       not by requests, so the rows kept are a fraction of the writes beside
       them.
       **A receipt only.** `attribute` writes one `attributed` row per paying
       card per switch, of the same kind, and that is a measurement of one
       turn's excess rather than the card's history; it prunes with the rest.
       The walk mark is not pruned on that clock either: it is a fact about a
       file rather than about a moment, and forgetting it would re-read an old
       transcript. It is pruned to the files that still exist, under the same
       "a walk that could not read the root reports nothing" guard the offsets
       use. */
    tx.execute(
        "DELETE FROM invalidate_fact
          WHERE at < ?1
            AND NOT (provenance = 'receipt' AND kind IN ('account', 'provider', 'model'))",
        [cutoff],
    )
    .map_err(|e| format!("analytics: prune invalidation: {e}"))?;
    if !alive.is_empty() {
        let known: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT path FROM invalidate_walk")
                .map_err(|e| format!("analytics: walk: {e}"))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("analytics: walk: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("analytics: walk: {e}"))?
        };
        let mut gone = tx
            .prepare("DELETE FROM invalidate_walk WHERE path = ?1")
            .map_err(|e| format!("analytics: walk: {e}"))?;
        for path in known {
            if !alive.contains(&path) {
                gone.execute([&path])
                    .map_err(|e| format!("analytics: walk: {e}"))?;
            }
        }
    }

    tx.commit().map_err(|e| format!("analytics: commit: {e}"))
}

/// The write half of a pass: the prior snapshot, then every chunk under its own
/// hold on the store, then the tail.
///
/// **The lock is taken and released per chunk.** Every command that touches the
/// store waits on this mutex, so it is never held across a chunk boundary: the
/// longest hold is one chunk's transaction, bounded by `CHUNK_REQUESTS`, plus
/// this one snapshot read before it, which is bounded by the batch's sessions and
/// agents rather than by its requests.
///
/// `stop_after` is the crash seam. A test cannot kill a process between two
/// chunks, so the loop returns after that many chunks without the tail — the
/// exact state a crash leaves: the chunks' facts and dedupe keys durable, the
/// offsets old. Production always passes `None`.
fn flush(
    conns: &Mutex<Connection>,
    host: &str,
    batch: &Batch,
    now: i64,
    chunk: usize,
    stop_after: Option<usize>,
) -> Result<Counts, String> {
    /* The distinct sessions and agents, built from the batch **before** the
       lock is taken: a hash insert and two clones per request is not work that
       belongs inside a hold this function exists to keep short. Under the lock
       there is one query per distinct session and agent. A session whose owner
       the batch already read out of a transcript needs no query — that owner
       wins anyway. */
    let mut sessions: Vec<String> = Vec::new();
    let mut agents: Vec<(String, String)> = Vec::new();
    {
        let mut seen_sessions: HashSet<&str> = HashSet::new();
        let mut seen_agents: HashSet<(&str, &str)> = HashSet::new();
        for rec in &batch.requests {
            if seen_sessions.insert(&rec.session) && !batch.owners.contains_key(&rec.session) {
                sessions.push(rec.session.clone());
            }
            if !rec.agent.is_empty() && seen_agents.insert((&rec.session, &rec.agent)) {
                agents.push((rec.session.clone(), rec.agent.clone()));
            }
        }
        /* A session with prompts in it and no requests still needs its owner
           looked up, or the prompt facts fall to `unknown` for want of a query
           nobody made. */
        for p in &batch.prompts {
            if seen_sessions.insert(&p.session) && !batch.owners.contains_key(&p.session) {
                sessions.push(p.session.clone());
            }
        }
    }
    let prior = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        Prior::read(&conn, &sessions, &agents)?
    };
    let mut counts = Counts {
        bytes: batch.bytes,
        ..Counts::default()
    };
    for (n, part) in batch.requests.chunks(chunk.max(1)).enumerate() {
        if stop_after.is_some_and(|stop| n >= stop) {
            return Ok(counts);
        }
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_chunk(
                &mut conn,
                host,
                part,
                &batch.owners,
                &batch.parents,
                &prior,
                now,
            )?
        };
        counts.add(written);
    }
    /* The prompt facts, under the same discipline and their own chunk size: one
       transaction each, the offsets still advancing only in `write_tail`. A pass
       that dies between two of these leaves rows whose `seen_count` is what the
       next pass finds, which is the idempotence `usage_seen` gives the other
       half. */
    for part in batch.prompts.chunks(chunk.max(1)) {
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_prompts(&mut conn, host, part, &batch.owners, &prior)?
        };
        counts.add(written);
    }
    /* The tool half, under the same discipline. **Every call lands before any
       result is applied**, which is what lets a call and its result be read in
       one pass and need no second one; splitting it per chunk of a mixed batch
       would let a result reach a call the same pass had not written yet. */
    for part in batch.calls.chunks(chunk.max(1)) {
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_calls(&mut conn, host, part)?
        };
        counts.calls += written;
    }
    for part in batch.results.chunks(chunk.max(1)) {
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_results(&mut conn, part)?
        };
        counts.results += written;
    }
    /* A receipt is a fact of its own and waits for no turn (§3.9). */
    for part in batch.receipts.chunks(chunk.max(1)) {
        let written = {
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_receipts(&mut conn, host, part)?
        };
        counts.add(written);
    }
    /* A write to an instruction file is an event, and it needs its tree and its
       payers resolved against the session rows written a moment ago — which is
       why it follows the requests rather than riding beside them. */
    for part in batch.writes.chunks(chunk.max(1)) {
        let written = {
            let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            write_writes(&conn, host, part)?
        };
        counts.invalidations += written;
    }
    /* The offsets advance only once every chunk is durable, so an interrupted
       pass re-reads what it already wrote and `usage_seen` makes that a no-op. */
    {
        let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        write_tail(&mut conn, &batch.files, &batch.alive, now)?;
    }
    Ok(counts)
}

/// One batch on one store, at the chunk size the wall writes with.
#[cfg(test)]
fn write(conns: &Mutex<Connection>, host: &str, batch: &Batch, now: i64) -> Result<Counts, String> {
    flush(conns, host, batch, now, CHUNK_REQUESTS, None)
}

/// The turn rows whose interval can contain one of this session's requests.
///
/// A row still open (`ended_at IS NULL`) is included: §4 writes the turn row at
/// its open, and "nothing is held back, because the row exists while the turn
/// runs".
fn spans_for(conn: &Connection, session: &str, from: i64, to: i64) -> Result<Vec<Span>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT opened_at, ended_at, COALESCE(account_label, ''), COALESCE(account_identity, '')
               FROM turn
              WHERE agent_session_id = ?1
                AND opened_at <= ?2
                AND (ended_at IS NULL OR ended_at > ?3)
              ORDER BY opened_at",
        )
        .map_err(|e| format!("analytics: turns: {e}"))?;
    let rows = stmt
        .query_map(params![session, to, from], |r| {
            Ok(Span {
                opened: r.get(0)?,
                ended: r.get(1)?,
                label: r.get(2)?,
                identity: r.get(3)?,
            })
        })
        .map_err(|e| format!("analytics: turns: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: turns: {e}"))
}

/// The identity an earlier pass recorded for this session.
///
/// This is the durable half of §4's per-session owner: the `session-owner`
/// record sits at the top of a file that a later pass has already read past, so
/// the fact table is where the answer is kept rather than an in-memory map that
/// a restart would empty.
fn prior_identity(conn: &Connection, session: &str) -> Option<String> {
    conn.query_row(
        "SELECT account_identity FROM usage_fact
          WHERE session = ?1 AND account_identity <> '' LIMIT 1",
        [session],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// The parent and depth an earlier pass proved for this subagent, for the same
/// durability reason: the call's result may already be behind the offset.
///
/// `depth > 0` rather than `parent_agent <> ''`, because a **card-spawned**
/// agent has a proven parent and an empty `parent_agent` — the empty string is
/// what §4.4 says a card-spawned agent's parent is, so filtering on it would
/// throw away every depth-1 agent and report it as unknown after a restart.
fn prior_agent(
    conn: &Connection,
    session: &str,
    agent: &str,
) -> Result<Option<(String, i64)>, String> {
    if agent.is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT parent_agent, depth FROM usage_fact
          WHERE session = ?1 AND agent = ?2 AND depth > 0 LIMIT 1",
        params![session, agent],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()
    .map_err(|e| format!("analytics: prior agent: {e}"))
}

/// What earlier passes recorded, read **once for the whole pass**.
///
/// `prior_identity` and `prior_agent` answer "what did a previous pass prove",
/// and a chunk that asked them would sometimes get rows an earlier chunk of the
/// same pass had just written — the very thing the answer must not include. A
/// session split across a boundary would then fund its halves differently, and a
/// different account is a different `usage_fact` primary key: `usage_seen` would
/// make that permanent. One snapshot taken before the first chunk makes every
/// chunk see what the old single transaction saw.
struct Prior {
    /// Session → the owner identity a previous pass recorded.
    identity: HashMap<String, Option<String>>,
    /// `(session, agent)` → the parent and depth a previous pass proved.
    agents: HashMap<(String, String), Option<(String, i64)>>,
}

impl Prior {
    /// The keys are handed in already distinct, built from the batch before the
    /// lock is taken, so this is one query per session and per agent and nothing
    /// proportional to the requests. Each is an indexed lookup that stops at its
    /// first match, and on the deep first pass the tables it reads are empty.
    ///
    /// It is a point in time, and a second pass overlapping this one could commit
    /// after it. That costs attribution at worst, never a count, and the two were
    /// already outside any lock for the whole walk.
    fn read(
        conn: &Connection,
        sessions: &[String],
        agents: &[(String, String)],
    ) -> Result<Prior, String> {
        let mut identity: HashMap<String, Option<String>> = HashMap::new();
        for session in sessions {
            identity.insert(session.clone(), prior_identity(conn, session));
        }
        let mut known: HashMap<(String, String), Option<(String, i64)>> = HashMap::new();
        for (session, agent) in agents {
            known.insert(
                (session.clone(), agent.clone()),
                prior_agent(conn, session, agent)?,
            );
        }
        Ok(Prior {
            identity,
            agents: known,
        })
    }
}

/// The Volery card behind a session, if there is one.
///
/// `ORDER BY born_at DESC` because a conversation that was cleared or renewed
/// has several sessions and its current `agent_session_id` names only the
/// newest; the tie is not possible in practice and the order keeps the answer
/// stable if it ever is.
fn card_for(conn: &Connection, session: &str) -> Option<Card> {
    let (id, project, branch, label, cwd, worktree, kind): (String, String, String, String, String, String, String) = conn
        .query_row(
            "SELECT c.id, COALESCE(p.name, ''), COALESCE(c.branch, ''),
                    COALESCE(c.account_label, ''), COALESCE(c.cwd, ''),
                    COALESCE(c.worktree, ''), COALESCE(c.kind, 'project')
               FROM conversation c LEFT JOIN project p ON p.id = c.project_id
              WHERE c.agent_session_id = ?1
              ORDER BY c.born_at DESC LIMIT 1",
            [session],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()?;
    /* `spawned` is where an agent-opened card is recorded (`migrate_v20`), and
       it is the only thing that can answer §3.2's `opened_by` months later. */
    let parent: Option<String> = conn
        .query_row("SELECT parent_id FROM spawned WHERE child_id = ?1", [&id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    Some(Card {
        opened_by: if parent.is_some() { "agent" } else { "person" }.to_string(),
        parent,
        id,
        project,
        branch,
        label,
        cwd,
        worktree,
        chat: kind == "chat",
    })
}

/// Settled turns this session has taken. §3.2's `turns`.
fn turns_for(conn: &Connection, session: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM turn WHERE agent_session_id = ?1 AND ended_at IS NOT NULL",
        [session],
        |r| r.get(0),
    )
    .map_err(|e| format!("analytics: turns: {e}"))
}

fn session_old(conn: &Connection, session: &str, host: &str) -> Result<Option<SessionOld>, String> {
    conn.query_row(
        "SELECT project, source, card_id, parent_card, opened_by, branch, started_at, ended_at,
                cli_min, cli_max, account_first, account_last, provider_first, provider_last,
                turns, endings_json
           FROM analytics_session WHERE session = ?1 AND host = ?2",
        params![session, host],
        |r| {
            Ok(SessionOld {
                project: r.get(0)?,
                source: r.get(1)?,
                card_id: r.get(2)?,
                parent_card: r.get(3)?,
                opened_by: r.get(4)?,
                branch: r.get(5)?,
                started_at: r.get(6)?,
                ended_at: r.get(7)?,
                cli_min: r.get(8)?,
                cli_max: r.get(9)?,
                account_first: r.get(10)?,
                account_last: r.get(11)?,
                provider_first: r.get(12)?,
                provider_last: r.get(13)?,
                turns: r.get(14)?,
                endings_json: r.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("analytics: session: {e}"))
}

/// Compare two CLI versions as version numbers, not as strings.
///
/// `2.1.312` comes after `2.1.99`, and sorting them as text says the opposite,
/// which would put the wrong one in `cli_max` on a wall that upgraded mid-week.
/// A segment that is not a number sorts below one that is, so a shape this does
/// not recognise loses rather than winning by accident.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| -> Vec<(bool, i64)> {
        v.trim()
            .split('.')
            .map(|p| match p.parse::<i64>() {
                Ok(n) => (true, n),
                Err(_) => (false, 0),
            })
            .collect()
    };
    parts(a).cmp(&parts(b))
}

fn version_less(a: &str, b: &str) -> bool {
    version_cmp(a, b) == std::cmp::Ordering::Less
}

/// Fold what this pass learnt into the row already on disk.
///
/// Pure, so every rule about first-and-last, earliest-start and widest-version
/// has a test rather than a paragraph. The two that matter:
///
/// - **`account_first` and `account_last` are by time, and nothing may read them
///   as "the" account** (§3.2). The batch is sorted, so the earliest and latest
///   requests in it say which half each belongs to; a batch entirely before the
///   row's start keeps its `first`, a batch entirely after its end takes
///   `last`.
/// - **`turns` only grows.** It counts settled turn rows, and a count that fell
///   because a card was deleted would be a session reporting less work than it
///   did.
fn merge_session(
    session: &str,
    host: &str,
    old: Option<SessionOld>,
    now: &SessionNow,
    card: Option<&Card>,
    turns: i64,
) -> SessionWrite {
    /* **The source is a maximum, not "whichever chunk was written last."** A
       session can hold records from more than one entrypoint (a card resumed in
       a terminal appends to the same transcript), and now that one pass writes it
       in several transactions, the answer must not depend on where the cuts
       fell. `card` beats `terminal` beats `unknown` is commutative, keeps the
       card stickiness the old match had, and still upgrades an `unknown` row a
       later pass learns more about. */
    let old_source = old.as_ref().map(|o| o.source.as_str()).unwrap_or("unknown");
    let source = if source_rank(old_source) > source_rank(&now.source) {
        old_source
    } else {
        now.source.as_str()
    };
    let old_started = old.as_ref().map(|o| o.started_at).unwrap_or(now.started_at);
    let old_ended = old.as_ref().and_then(|o| o.ended_at);
    /* The row's first half survives a later batch and is replaced by an earlier
       one; the last half is the other way round. */
    let batch_is_earlier = now.started_at <= old_started;
    let batch_is_later = now.ended_at >= old_ended.unwrap_or(i64::MIN);

    let account_first = if batch_is_earlier {
        now.account_first.clone()
    } else {
        old.as_ref().map(|o| o.account_first.clone()).unwrap_or_default()
    };
    let account_last = if batch_is_later {
        now.account_last.clone()
    } else {
        old.as_ref().map(|o| o.account_last.clone()).unwrap_or_default()
    };
    let provider_first = if batch_is_earlier {
        now.provider_first.clone()
    } else {
        old.as_ref().map(|o| o.provider_first.clone()).unwrap_or_default()
    };
    let provider_last = if batch_is_later {
        now.provider_last.clone()
    } else {
        old.as_ref().map(|o| o.provider_last.clone()).unwrap_or_default()
    };

    let cli_min = match old.as_ref().and_then(|o| o.cli_min.clone()).filter(|c| !c.is_empty()) {
        Some(c) if now.cli_min.is_empty() || version_less(&c, &now.cli_min) => c,
        _ => now.cli_min.clone(),
    };
    let cli_max = match old.as_ref().and_then(|o| o.cli_max.clone()).filter(|c| !c.is_empty()) {
        Some(c) if now.cli_max.is_empty() || version_less(&now.cli_max, &c) => c,
        _ => now.cli_max.clone(),
    };

    /* The project belongs to the earlier half, for the same reason: a session
       resumed from another directory would otherwise be named by whichever chunk
       went last, and the same batch cut differently is the same session. The
       card, where there is one, remains the authority. */
    let project = card
        .map(|c| c.project.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| {
            let (early, late) = if batch_is_earlier {
                (
                    now.project.clone(),
                    old.as_ref().map(|o| o.project.clone()).unwrap_or_default(),
                )
            } else {
                (
                    old.as_ref().map(|o| o.project.clone()).unwrap_or_default(),
                    now.project.clone(),
                )
            };
            if early.is_empty() {
                late
            } else {
                early
            }
        });
    let branch = card
        .map(|c| c.branch.clone())
        .filter(|b| !b.is_empty())
        .or_else(|| Some(now.branch.clone()).filter(|b| !b.is_empty()))
        .or_else(|| old.as_ref().map(|o| o.branch.clone()).filter(|b| !b.is_empty()))
        .unwrap_or_default();

    SessionWrite {
        session: session.to_string(),
        host: host.to_string(),
        project,
        source: source.to_string(),
        card_id: card
            .map(|c| c.id.clone())
            .or_else(|| old.as_ref().and_then(|o| o.card_id.clone())),
        parent_card: card
            .and_then(|c| c.parent.clone())
            .or_else(|| old.as_ref().and_then(|o| o.parent_card.clone())),
        opened_by: card
            .map(|c| c.opened_by.clone())
            .or_else(|| old.as_ref().map(|o| o.opened_by.clone()))
            .unwrap_or_else(|| "unknown".into()),
        branch,
        started_at: now.started_at.min(old_started),
        ended_at: now.ended_at.max(old_ended.unwrap_or(i64::MIN)),
        cli_min,
        cli_max,
        account_first,
        account_last,
        provider_first,
        provider_last,
        turns: turns.max(old.as_ref().map(|o| o.turns).unwrap_or(0)),
        /* Opaque and normalised on read, the `widget.config_json` bargain. The
           ending vocabulary is `classify.ts`'s and a later phase fills it. */
        endings_json: old.map(|o| o.endings_json).unwrap_or_else(|| "{}".into()),
    }
}

/* ── the pass ────────────────────────────────────────────────────────────── */

fn read_marks(conn: &Connection) -> Result<HashMap<PathBuf, Mark>, String> {
    let mut stmt = conn
        .prepare("SELECT path, offset, mtime, size FROM usage_file")
        .map_err(|e| format!("analytics: read offsets: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                PathBuf::from(r.get::<_, String>(0)?),
                Mark {
                    offset: r.get::<_, i64>(1)? as u64,
                    mtime: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                },
            ))
        })
        .map_err(|e| format!("analytics: read offsets: {e}"))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|e| format!("analytics: read offsets: {e}"))
}

/* ── catching up one card, for `spend read` ────────────────────────────────*/

/// How much of a card's own transcript one catch-up may read.
///
/// **A bound on a first read, not on the ordinary one.** The mark in
/// `usage_file` makes every later catch-up incremental, so this only bites on a
/// file the collector has never seen, a card restored on a fresh store, or a
/// session long enough to have outrun one pass. Eight megabytes is roughly what
/// a very long card writes in a day. **The read walks forward from the mark and
/// stops at the bound; it never takes the end of the file**, because the mark
/// this call advances is the collector's and a tail-biased read would skip the
/// bytes in between for good. A capped answer covers the window since the last
/// read, says so, and the collector consumes the rest on its next beat.
const CATCH_UP_BYTES: u64 = 8 * 1024 * 1024;
/// A subagent's file is a slice of one turn, so it gets its own, smaller bound.
const CATCH_UP_AGENT_BYTES: u64 = 2 * 1024 * 1024;

/// What one bounded catch-up did, for the answer's `as_of` and `live_turn`.
pub(crate) struct Caught {
    pub bytes: u64,
    pub requests: i64,
    /// The file had more past the bound, so the figure covers the window since
    /// the last read rather than everything to now.
    pub capped: bool,
}

/// Read what is new in this card's own transcript, and write it.
///
/// **The pass runs on a minute; a card asking mid-turn deserves the turn it is
/// in.** This is the same reader and the same writer the collector uses ,
/// `Reading`, `read_record`, `flush`, pointed at one card's files instead of
/// every transcript on the machine. Nothing here is a second parser, and the
/// marks it advances are the collector's own, so the next pass finds the work
/// already done rather than reading it twice.
///
/// The scope is one card's session: its own transcript, plus the subagent files
/// the CLI files one directory below it. Nothing else on disk is opened, so the
/// cost is bounded by how much this card has written since the last pass rather
/// than by how much the wall has ever written.
pub(crate) fn catch_up(app: &AppHandle, conversation_id: &str) -> Result<Caught, String> {
    use std::fs::File;
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

    let store = app.state::<Store>();
    let (dir, session) = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::session_of(&conn, conversation_id)
            .ok_or_else(|| format!("no card {conversation_id}"))?
    };
    let Some(session) = session.filter(|s| !s.is_empty()) else {
        /* A card that has never taken a turn has no transcript to catch up.
           Nothing is stale about that answer: there is nothing to be stale. */
        return Ok(Caught { bytes: 0, requests: 0, capped: false });
    };
    let main = crate::supervisor::transcript_path(app, &dir, &session)?;
    /* The subagent files, one directory below the session's own. A missing
       directory is the ordinary case for a card that has run no agents. */
    let mut paths: Vec<(PathBuf, u64)> = vec![(main.clone(), CATCH_UP_BYTES)];
    if let Some(parent) = main.parent() {
        let dir = parent.join(&session).join("subagents");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    paths.push((p, CATCH_UP_AGENT_BYTES));
                }
            }
        }
    }

    /* The marks for these files only, read and released before any file is
       opened, the rule the whole pass keeps. */
    let marks: HashMap<PathBuf, Mark> = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let mut stmt = conn
            .prepare("SELECT offset, mtime, size FROM usage_file WHERE path = ?1")
            .map_err(|e| format!("analytics: catch up: {e}"))?;
        let mut marks = HashMap::new();
        for (path, _) in &paths {
            let key = path.to_string_lossy().to_string();
            if let Ok(Some((offset, mtime, size))) = stmt
                .query_row([&key], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })
                .optional()
            {
                marks.insert(
                    path.clone(),
                    Mark { offset: offset as u64, mtime, size: size as u64 },
                );
            }
        }
        marks
    };

    let now = now_ms();
    let mut reading = Reading::new(marks, now - FINE_KEEP_MS).with_vault(
        &crate::flyway::key::host_name(),
        app.state::<crate::promptvault::PromptVault>().inner().clone(),
    );
    let mut caught = Caught { bytes: 0, requests: 0, capped: false };

    for (path, cap) in paths {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let len = meta.len();
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        /* **Deliberately not `alive`.** `write_tail` prunes every mark absent
           from that set, and this walk has seen only this card's files, so
           saying "alive" here would delete the offset of every other transcript
           on the machine and make the next full pass re-read ninety days of
           them. An empty `alive` is what the tail's own guard reads as "this
           walk did not survey the tree", and the marks it does write are the
           ones this call advanced. */
        let (wanted, from) = reading.reach(&path, len, mtime);
        if !wanted {
            continue;
        }
        let start = from.unwrap_or(0).min(len);
        if start == len {
            reading.skipped(&path, start, mtime, len);
            continue;
        }
        /* **Forward from the mark, never biased to the tail.** Reading the last
           eight megabytes of a longer file is fresher and leaves a hole: this
           call advances the *collector's* mark to the end, and nothing ever
           comes back for the bytes it skipped. A bounded read that walks forward
           may answer an older window on the first call after a fresh store, and
           the collector consumes the rest within its minute, a lag the answer
           says out loud, which is the smaller lie than a permanent hole. */
        caught.capped |= len - start > cap;
        let Ok(mut f) = File::open(&path) else { continue };
        if f.seek(SeekFrom::Start(start)).is_err() {
            continue;
        }

        let mut r = BufReader::with_capacity(64 * 1024, Read::take(&mut f, cap));
        let mut off = start;
        loop {
            let mut line: Vec<u8> = Vec::new();
            match r.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(n) => {
                    /* **Only a line that ended is a line.** A write still in
                       flight is left for the next pass, and it is left
                       unparsed, not merely uncounted: a truncated record is
                       still JSON-shaped enough for the prompt reader to store
                       half a body under a locator nobody can complete. `off`
                       stops at the byte it began on, which is what makes the
                       next read resume there. */
                    if line.last() != Some(&b'\n') {
                        break;
                    }
                    off += n as u64;
                    line.pop();
                    let text = String::from_utf8_lossy(&line);
                    match crate::usage::read_record(&text) {
                        Some(rec) => {
                            reading.request(&rec);
                            reading.tools(&text);
                            caught.requests += 1;
                        }
                        None => {
                            reading.other(&text);
                            reading.tools(&text);
                            /* The line's start, for a prompt locator. */
                            reading.prompt(&path, off - n as u64, &text);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        caught.bytes += off - start;
        reading.consumed(&path, off, mtime, len, off - start);
    }

    let batch = reading.into_batch();
    let host = crate::flyway::key::host_name();
    flush(&store.0, &host, &batch, now, CHUNK_REQUESTS, None)?;
    /* The marks have moved past these bytes, so the collector will never offer
       this session in a batch of its own. The next ingest's breach pass is told
       about it here, so a watch crossed by this reading still fires. */
    crate::spend::note_caught(&session);
    Ok(caught)
}

/// One pass: read the transcripts, write what is new.
///
/// The collector is the ordinary caller; `analytics_pass` is the same function
/// on demand. Nothing else in the app calls it, and the front end never does.
pub fn pass(app: &AppHandle) -> Result<Report, String> {
    let began = Instant::now();
    let now = now_ms();
    let host = crate::flyway::key::host_name();
    let store = app.state::<Store>();

    /* The offsets, read and released before any file is opened — the whole of
       "do not hold the store lock across file IO". */
    let marks = {
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        read_marks(&conn)?
    };
    /* The vault is a handle to memory, not a lock on the store: a pass that is
       reading a thousand lines asks it for the key once per prompt, and the
       answer is `None` the moment it locks or expires, which is the ingest
       falling back to a locator rather than a pass failing. */
    let mut reading = Reading::new(marks, now - FINE_KEEP_MS)
        .with_vault(&host, app.state::<crate::promptvault::PromptVault>().inner().clone());

    let scan = crate::usage::scan_with_sink(app, &app.state::<crate::usage::Usage>(), &mut reading)?;
    let batch = reading.into_batch();
    let refused = batch.refused;

    /* Which cards this pass put facts under, so the watch pass is bounded to
       them rather than re-evaluating every watch on the wall on every beat. */
    let touched: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        batch
            .requests
            .iter()
            .filter(|r| seen.insert(r.session.as_str()))
            .map(|r| r.session.clone())
            .collect()
    };

    /* A command arriving mid-pass waits for one chunk rather than for the whole
       backfill — the difference between the 34 ms worst case measured for
       `CHUNK_REQUESTS` and a single transaction over every request on the
       machine. `flush` is where the per-chunk lock lives. */
    let mut counts = flush(&store.0, &host, &batch, now, CHUNK_REQUESTS, None)?;

    /* §11.13's breach pass, riding the ingest rather than a clock of its own: a
       card's own threshold is decided on the same facts the pass just wrote.
       It writes a notice and a mark and never stops, pauses or slows anything. */
    crate::spend::evaluate(&store.0, app, &touched)?;

    /* The fold comes after the offsets have advanced on purpose: a call and its
       result are both durable before any turn is allowed to consume them, so a
       crash between the two writes re-reads the file and finds the pending rows
       still there rather than a turn folded around half a call. */
    counts.add(fold_tools(&store.0, &host, now)?);

    /* §3.9's invalidation half. The walk is one-off and bounded per pass; the
       attribution is a fold over the last few hours, re-run each pass so an
       event its payers had not yet answered moves from unmeasured to measured.
       Both are store-and-file work on this thread, never the main one. */
    counts.add(backfill(&store.0, app, &host, now)?);
    counts.add(attribute(&store.0, &host, now)?);

    /* The one reader that is not a fold (`docs/ANALYTICS.md` §3.9): a commit
       made in a terminal emits nothing this app can hear. Bounded by its own
       clock, because a `git log` per root per minute is three process spawns
       the wall does not need — §16's budget prices this at one bounded log per
       repository per observation, not per ingest. */
    if history_due() {
        counts.add(observe_history(&store.0, &host, now)?);
    }

    Ok(Report {
        files: scan.read,
        bytes: counts.bytes,
        requests: counts.requests,
        duplicates: counts.duplicates,
        facts: counts.facts,
        hours: counts.hours,
        prompts: counts.prompts,
        prompt_duplicates: counts.prompt_duplicates,
        prompt_hours: counts.prompt_hours,
        sessions: counts.sessions,
        calls: counts.calls,
        results: counts.results,
        receipts: counts.receipts,
        folds: counts.folds,
        no_turn: counts.no_turn,
        history: counts.history,
        invalidations: counts.invalidations,
        attributed: counts.attributed,
        walked: counts.walked,
        unreadable: counts.unreadable,
        refused,
        ms: began.elapsed().as_millis() as u64,
    })
}

/// Force a pass, and answer what it did.
///
/// Registered as a command so a wall test or a probe can ask for one rather than
/// waiting out the collector's minute; the control surface has no op for it yet,
/// which is a front-end line somebody else's lane owns. Nothing on the wall
/// calls it, so a wall in normal use records on the collector alone.
#[tauri::command]
pub async fn analytics_pass(app: AppHandle) -> Result<Report, String> {
    crate::off_main(move || pass(&app)).await?
}

/* ── git history, attributed and labelled (§3.9) ────────────────────────── */

/// How often the history observer may look.
///
/// **Not a fact that emits an event, and not cheap either**: one `git log` per
/// repository and per worktree group, each a process spawn. §3.9 accepts that
/// cost as the fourth thing that goes and looks, and the cadence is what keeps
/// it from being a per-minute one. A commit made through a card's own `Bash` is
/// a receipt and needs none of this; what waits ten minutes is the commit made
/// in a terminal, which the wall could not otherwise hear at all. Ten rather
/// than five because **creating a process on this machine costs about half a
/// second** (`spawn-costs-half-a-second`): a root is one spawn and a branch is
/// another, so the cadence is the term that decides what the observation costs
/// a wall doing nothing else.
const HISTORY_EVERY: Duration = Duration::from_secs(600);

/// Commits one `git log` page may return, pages one tree may be read in, and
/// trees one observation may read.
///
/// **The page is a page, not a cap on the window.** The fine tier is ninety
/// days, so `--since` is the real bound; `-n` alone would return only the newest
/// N in that window and leave the rest unreachable for ever, which is what a
/// fixed 600 did to this repository's own ~1,200 in-window commits.
const HISTORY_CAP: usize = 900;
const HISTORY_PAGES: usize = 4;
const HISTORY_ROOTS: usize = 24;

/// How long one `git log` may take before it is killed. A repository on a
/// network path or behind a credential prompt must not hold the ingest's thread.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

static HISTORY_AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

/// Whether this pass may observe history, and if so, it arms the next one.
fn history_due() -> bool {
    let gate = HISTORY_AT.get_or_init(|| Mutex::new(None));
    let Ok(mut at) = gate.lock() else {
        return false;
    };
    let now = Instant::now();
    match *at {
        Some(last) if now.duration_since(last) < HISTORY_EVERY => false,
        _ => {
            *at = Some(now);
            true
        }
    }
}

/// One card that has worked in a root.
#[derive(Clone)]
struct Candidate {
    card: String,
    session: String,
}

/// A tree the observer reads: the project it belongs to, the branch checked out
/// there, and who was in it.
struct Root {
    path: String,
    project: String,
    /// Empty when only git can answer it; filled by a `rev-parse` in
    /// `observe_history`, where no store lock is held.
    branch: String,
    candidates: Vec<Candidate>,
}

/// The trees a card has been in, over the fine window.
///
/// **`conversation.worktree` is a worktree's *name*, not a path.** The agent
/// stands in `worktree::run_dir(cwd, name)`, and the name is the branch the
/// tree is on (`wt/<key>`), which is why the branch needs no `rev-parse` there.
/// Its `cwd` is the territory and is where a card without a worktree works.
/// Neither is read from `analytics_session`, which deliberately drops a
/// worktree path because that table is synced.
fn history_roots(conn: &Connection, since: i64) -> Result<Vec<Root>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, COALESCE(c.agent_session_id, ''), COALESCE(c.branch, ''),
                    COALESCE(c.cwd, ''), COALESCE(c.worktree, ''), COALESCE(p.name, '')
               FROM conversation c LEFT JOIN project p ON p.id = c.project_id
              WHERE c.closed_at IS NULL OR c.closed_at >= ?1
              /* Newest first, so the fixed cap on roots is spent on the trees
                 a card was in most recently rather than on whichever order the
                 table happened to return. */
              ORDER BY c.born_at DESC",
        )
        .map_err(|e| format!("analytics: history roots: {e}"))?;
    let rows = stmt
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("analytics: history roots: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: history roots: {e}"))?;

    let mut roots: Vec<Root> = Vec::new();
    for (card, session, branch, cwd, worktree, project) in rows {
        if cwd.trim().is_empty() {
            continue;
        }
        let worktree = worktree.trim();
        let path = crate::worktree::run_dir(&cwd, (!worktree.is_empty()).then_some(worktree));
        /* A path that is gone is not a repository to read, and asking git about
           it would be a process per launch for nothing. */
        if !Path::new(&path).is_dir() {
            continue;
        }
        /* A worktree's name **is** its branch. A shared tree's is whatever is
           checked out, which `conversation.branch` is not written with today —
           so it stays empty here and git answers it outside the lock. */
        let named = if !worktree.is_empty() {
            worktree.to_string()
        } else {
            branch.trim().to_string()
        };
        let candidate = Candidate {
            card: card.clone(),
            session: session.clone(),
        };
        match roots.iter_mut().find(|r| r.path == path) {
            Some(root) => {
                if !root.candidates.iter().any(|c| c.card == candidate.card) {
                    root.candidates.push(candidate);
                }
                if root.branch.is_empty() {
                    root.branch = named;
                }
                if root.project.is_empty() {
                    root.project = project.clone();
                }
            }
            None => roots.push(Root {
                path,
                project: project.clone(),
                branch: named,
                candidates: vec![candidate],
            }),
        }
    }
    Ok(roots)
}

/* A GUI app spawning a console program flashes a black window unless it says
   not to. The same `quiet` as `project.rs`, `forge.rs` and the rest. */
#[cfg(windows)]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Run a command with a deadline, never a network prompt, and no window to
/// block on.
///
/// **The reader thread is why this is not `Command::output`.** A `git log` over
/// a few hundred commits with numstat is larger than a pipe buffer, so a child
/// whose output nobody drains blocks before it can exit, and a timeout that
/// expected it to exit would wait for ever. Draining and polling are two
/// threads, and the kill is the timeout.
///
/// **And `quiet` is why the history pass does not put windows on the screen.**
/// This `git` was the one spawn in the app that never asked Windows to hide
/// its console, so the observer taught the truth of `project.rs`'s comment the
/// hard way: a history pass reads one root after another for as long as it
/// takes (88 to 102 seconds measured on 2026-11-12), and each spawn opened a
/// visible black console over whatever Lyss was doing, then closed, then
/// opened the next. A background read nobody asked for must not take focus.
fn run_bounded(root: &str, args: &[String], timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("git");
    /* The two halves of "a background poll never asks a question"
       (`actions.md`): no terminal prompt, and a credential helper told not to
       go interactive. `git log` reads local objects and needs neither, which is
       exactly why a repository whose remote credentials expired must not be
       able to pop a window from here. */
    cmd.arg("-c")
        .arg("credential.interactive=false")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = quiet(&mut cmd).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    let bytes = reader.join().ok()?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

/// Whether a sha is already in the store, as a receipt or as a history row.
///
/// **A receipt is the exact source and wins.** `git commit` through a card's
/// tool prints the sha, so the same commit is both a receipt and, minutes
/// later, a line of local history; counting both would double every commit a
/// card made, which is every commit the wall made. The receipt's ref may be a
/// short sha and history's is always full, so the match is by prefix.
fn history_known(conn: &Connection, sha: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
                  SELECT 1 FROM work_fact
                   WHERE kind = 'commit' AND provenance = 'receipt'
                     AND (ref = ?1 OR ?1 LIKE ref || '%'))
             OR EXISTS(
                  SELECT 1 FROM work_fact
                   WHERE kind = 'commit' AND provenance = 'history' AND ref = ?1)",
        [sha],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .map_err(|e| format!("analytics: history: {e}"))
}

/// Did a card's own tool call already record this integration?
///
/// **A merge receipt carries no sha.** Verified against real transcripts: the
/// `gitOperation` is `{"branch":{"ref":"…","action":"merged"}}` and the printed
/// output is `Merge made by the 'ort' strategy.`, with no `[branch sha]` line —
/// so `history_known`, which matches on a sha, cannot suppress the history row
/// that follows. Without this the integration is counted twice: once as the
/// exact receipt and once as a `merge` commit history finds. The window is
/// generous because the receipt's stamp is the command's end and the commit's
/// is its author time, and both belong to the same minute.
fn receipt_covers_merge(conn: &Connection, branch: &str, at: i64) -> bool {
    const WINDOW_MS: i64 = 30 * 60 * 1000;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM work_fact
                        WHERE kind = 'merge'
                          AND provenance = 'receipt'
                          AND branch = ?1
                          AND at BETWEEN ?2 AND ?3)",
        params![branch, at - WINDOW_MS, at + WINDOW_MS],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .unwrap_or(false)
}

/// Was this card mid-turn at the author time?
fn in_turn(conn: &Connection, card: &str, at: i64) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM turn
                        WHERE conversation_id = ?1
                          AND opened_at <= ?2
                          AND (ended_at IS NULL OR ?2 < ended_at))",
        params![card, at],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .unwrap_or(false)
}

/// Did this card touch any of the commit's paths lately?
///
/// **Lately, not ever**: a card that edited a file last week did not author
/// today's commit, so the window runs from twelve hours before the author time
/// to five minutes after it. A commit's files were written before it landed,
/// and the small forward allowance covers clock skew between the two records.
fn touched_by(conn: &Connection, card: &str, commit: &HistCommit) -> bool {
    if commit.paths.is_empty() {
        return false;
    }
    let window = (commit.at - 12 * 60 * 60 * 1000, commit.at + 5 * 60 * 1000);
    let Ok(mut stmt) = conn.prepare(
        "SELECT path FROM file_touch
          WHERE conversation_id = ?1 AND at >= ?2 AND at <= ?3
          LIMIT 4000",
    ) else {
        return false;
    };
    let Ok(rows) = stmt.query_map(params![card, window.0, window.1], |r| r.get::<_, String>(0))
    else {
        return false;
    };
    let touched: Vec<String> = rows.filter_map(Result::ok).map(|p| crate::board::normalize(&p)).collect();
    commit.paths.iter().any(|path| {
        let want = crate::board::normalize(path);
        touched.iter().any(|stored| {
            stored == &want || stored.ends_with(&format!("/{want}"))
        })
    })
}

/// Who made a commit the transcript did not see, in §3.9's order.
///
/// `candidates` are the cards whose tree had the branch checked out. One is the
/// answer on the first rung. Several fall to the turn interval the author time
/// falls in, then to `file_touch`. A tie at any rung is left unattributed rather
/// than guessed: `card = ''` still counts the commit toward the project, which
/// is the honest reading of "somebody in this tree made it".
fn attribute_commit(
    conn: &Connection,
    commit: &HistCommit,
    candidates: &[Candidate],
) -> Option<(String, String)> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some((candidates[0].card.clone(), candidates[0].session.clone()));
    }
    let mid_turn: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| in_turn(conn, &c.card, commit.at))
        .collect();
    if mid_turn.len() == 1 {
        return Some((mid_turn[0].card.clone(), mid_turn[0].session.clone()));
    }
    let pool: Vec<&Candidate> = if mid_turn.is_empty() {
        candidates.iter().collect()
    } else {
        mid_turn
    };
    let touched: Vec<&Candidate> = pool
        .into_iter()
        .filter(|c| touched_by(conn, &c.card, commit))
        .collect();
    if touched.len() == 1 {
        return Some((touched[0].card.clone(), touched[0].session.clone()));
    }
    None
}

/// Give a receipt the line counts only git knows.
///
/// **A receipt names the sha and not the lines.** The CLI prints
/// `[main 8adbaaa] subject`, from which the ingest can take the branch, the
/// short sha and the subject, and `work_fact`'s `files`/`added`/`removed` are
/// written as zero. History is the only writer that runs `--numstat`, and it
/// used to skip the sha entirely because `history_known` found the receipt, so
/// every commit a card made through its own `Bash` tool carried a structural
/// zero. That is §9.1's missing row drawn as zero, on the measure the work page
/// exists to show.
///
/// So history still suppresses its duplicate *row*, and it fills the receipt's
/// counts on the way past. The receipt keeps its card and its provenance: the
/// artifact is exact, and the lines are as exact as the sha. `work_hour` is
/// moved by the same delta, in the receipt's own hour, because that is the
/// bucket its count was rolled into.
fn backfill_receipt_lines(conn: &Connection, commit: &HistCommit) -> Result<(), String> {
    let row: Option<(i64, String, String, String, i64, i64, i64)> = conn
        .query_row(
            "SELECT at, project, branch, host, files, added, removed
               FROM work_fact
              WHERE kind = 'commit' AND provenance = 'receipt'
                AND (ref = ?1 OR ?1 LIKE ref || '%')
              LIMIT 1",
            params![commit.sha],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("analytics: history: {e}"))?;
    let Some((at, project, branch, host, files, added, removed)) = row else {
        return Ok(());
    };
    /* Already counted by a receipt writer that learns to read numstat, or by an
       earlier pass: the counts are filled once. */
    if files != 0 || added != 0 || removed != 0 {
        return Ok(());
    }
    conn.execute(
        "UPDATE work_fact SET files = ?2, added = ?3, removed = ?4
          WHERE kind = 'commit' AND provenance = 'receipt'
            AND (ref = ?1 OR ?1 LIKE ref || '%')",
        params![commit.sha, commit.files, commit.added, commit.removed],
    )
    .map_err(|e| format!("analytics: history: {e}"))?;
    conn.execute(
        "UPDATE work_hour
            SET files = files + ?4, added = added + ?5, removed = removed + ?6
          WHERE hour = ?1 AND host = ?2 AND project = ?3 AND branch = ?7 AND kind = 'commit'",
        params![
            hour_of(at),
            host,
            project,
            commit.files,
            commit.added,
            commit.removed,
            branch
        ],
    )
    .map_err(|e| format!("analytics: history: {e}"))?;
    Ok(())
}

/// Write one tree's history, skipping what the store already holds.
///
/// The branch is the tree's, so every candidate in it was working on that
/// branch: **the first attribution rung has done its work by choosing the
/// tree**, and interval and file touch are what tell one card in a shared tree
/// from another.
fn write_history(
    conn: &mut Connection,
    host: &str,
    root: &Root,
    commits: &[HistCommit],
) -> Result<Counts, String> {
    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;
    let mut counts = Counts::default();
    let project = if root.project.is_empty() {
        root.path.rsplit(['\\', '/']).next().unwrap_or("").to_string()
    } else {
        root.project.clone()
    };
    let branch = root.branch.as_str();
    let candidates: Vec<Candidate> = root.candidates.clone();

    let mut fact = tx
        .prepare(
            "INSERT INTO work_fact
               (at, host, session, card, agent, kind, ref, branch, project,
                files, added, removed, conflict_files, ms, provenance)
             VALUES (?1,?2,?3,?4,'',?5,?6,?7,?8,?9,?10,?11,0,0,'history')
             ON CONFLICT DO NOTHING",
        )
        .map_err(|e| format!("analytics: history: {e}"))?;
    let mut hour = tx
        .prepare(
            "INSERT INTO work_hour
               (hour, host, project, branch, kind, count, files, added, removed, conflict_ms)
             VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8,0)
             ON CONFLICT(hour, host, project, branch, kind) DO UPDATE SET
               count = count + 1,
               files = files + excluded.files,
               added = added + excluded.added,
               removed = removed + excluded.removed",
        )
        .map_err(|e| format!("analytics: history: {e}"))?;

    for commit in commits {
        if history_known(&tx, &commit.sha)? {
            /* The row exists; what a receipt cannot carry is the numstat. */
            backfill_receipt_lines(&tx, commit)?;
            continue;
        }
        /* A merge commit's receipt has no sha to match on, so the branch and
           the moment are what say the card already recorded this integration. */
        if commit.parents.len() >= 2 && receipt_covers_merge(&tx, branch, commit.at) {
            continue;
        }
        let (card, session) = attribute_commit(&tx, commit, &candidates).unwrap_or_default();
        let inserted = fact
            .execute(params![
                commit.at,
                host,
                session,
                card,
                "commit",
                commit.sha,
                branch,
                project,
                commit.files,
                commit.added,
                commit.removed,
            ])
            .map_err(|e| format!("analytics: history: {e}"))? as i64;
        if inserted > 0 {
            counts.history += 1;
            hour.execute(params![
                hour_of(commit.at),
                host,
                project,
                branch,
                "commit",
                commit.files,
                commit.added,
                commit.removed,
            ])
            .map_err(|e| format!("analytics: history: {e}"))?;
        }
        /* A merge commit is an integration, and the history knows it by its two
           parents. It is written as a second row rather than a column, because
           `work_fact` has no parents field and the kind vocabulary already has
           the word for it (§3.9). */
        if commit.parents.len() >= 2 {
            let merged = fact
                .execute(params![
                    commit.at,
                    host,
                    session,
                    card,
                    "merge",
                    commit.sha,
                    branch,
                    project,
                    0,
                    0,
                    0,
                ])
                .map_err(|e| format!("analytics: history: {e}"))? as i64;
            if merged > 0 {
                hour.execute(params![
                    hour_of(commit.at),
                    host,
                    project,
                    branch,
                    "merge",
                    0,
                    0,
                    0
                ])
                .map_err(|e| format!("analytics: history: {e}"))?;
            }
        }
    }
    drop(fact);
    drop(hour);
    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(counts)
}

/// The fourth reader that goes and looks, for the commits nothing emits an
/// event for (§3.9).
///
/// **No network.** Only local objects are read, with the terminal prompt
/// disabled and optional locks off, so a repository behind an expired
/// credential cannot pop a window over the wall from a background pass — the
/// same rule `actions.md` states for every other background `git`.
///
/// A git that is missing, slow or refused costs nothing: every failure here is
/// a skipped root, never a failed ingest.
fn observe_history(conns: &Mutex<Connection>, host: &str, now: i64) -> Result<Counts, String> {
    let mut roots = {
        let conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
        history_roots(&conn, now - FINE_KEEP_MS)?
    };
    let mut counts = Counts::default();
    for root in roots.iter_mut().take(HISTORY_ROOTS) {
        /* **The branch is asked of the tree, never of the card**, because
           nothing writes `conversation.branch` today and a card's idea of where
           it is can be a week old. A worktree already knows its name is its
           branch; a shared tree is one `rev-parse` — outside the lock, because
           a spawn under the store mutex is a frozen wall. */
        if root.branch.is_empty() {
            root.branch = run_bounded(
                &root.path,
                &["rev-parse".to_string(), "--abbrev-ref".to_string(), "HEAD".to_string()],
                GIT_TIMEOUT,
            )
            .map(|text| text.trim().to_string())
            .filter(|b| !b.is_empty() && b != "HEAD")
            .unwrap_or_else(|| "HEAD".to_string());
        }
        let since = (now - FINE_KEEP_MS).div_euclid(1000).to_string();
        /* **Paged, because `-n` alone starves the window for ever.** A fixed
           newest-N cap on a repository with more than N commits in ninety days
           hides the older half and no later observation ever reaches it: this
           repository has ~1,200 in the window, which is what made the first
           cut wrong on its own project. Each page is one `git log`; a short
           page is the end of the history. */
        let mut skip = 0usize;
        for _ in 0..HISTORY_PAGES {
            let args = vec![
                "log".to_string(),
                root.branch.clone(),
                "--numstat".to_string(),
                "--format=%x1e%H%x1f%P%x1f%at".to_string(),
                format!("--since={since}"),
                "-n".to_string(),
                HISTORY_CAP.to_string(),
                format!("--skip={skip}"),
            ];
            let Some(text) = run_bounded(&root.path, &args, GIT_TIMEOUT) else {
                break;
            };
            let commits = parse_numstat_log(&text);
            if commits.is_empty() {
                break;
            }
            let full = commits.len() >= HISTORY_CAP;
            let mut conn = conns.lock().map_err(|_| "the store is wedged".to_string())?;
            counts.add(write_history(&mut conn, host, root, &commits)?);
            if !full {
                break;
            }
            skip += HISTORY_CAP;
        }
    }
    Ok(counts)
}

/* ── the read the room makes (§11) ──────────────────────────────────────── */

/// The widest span the fine tier answers a room's chart from.
///
/// §9.3 puts the boundary at the fine tier's whole retention, which is right
/// for a query layer that can afford to ask. The room draws at most two hundred
/// points, so a week of five-minute rows is two thousand rows of JSON carried
/// over the IPC for sixteen of them to reach the screen. Forty-eight hours is
/// the point where the fine tier still costs less than the hourly one answers
/// with too little: a day of five-minute points is 288 rows, and the hourly
/// rollup cannot see an hour's shape at all.
pub const FINE_WINDOW_MS: i64 = 48 * 60 * 60 * 1000;

/// What one answer may carry, and the reason both bounds exist: a span is data
/// the front end asks for, so a hand-written request, a clock jump or a wall
/// with more history than this one must be **refused with a reason** rather
/// than answered in part. A silently truncated window is a chart that says the
/// month cost less than it did.
///
/// **The numbers are sized for the widest span the room offers, a year.** §16
/// puts three years of hourly rollups at ~100,000 rows, so a year is ~33,000 at
/// the design's own volume; a serialized hour row measures ~300 bytes, which is
/// ~10 MB. That fits the old 12 MB bound with a fifth to spare, which is why
/// this is not 12 MB: a wall a quarter denser than the design's estimate — more
/// models, more projects per hour — would have lost the year to a cap that was
/// silently doing the choosing. Twenty-four megabytes admits ~80,000 rows, a
/// little over twice the estimate, and the refusal still stands past it.
///
/// **These rows cannot be folded in SQL to shrink them**, which is the fix
/// §9.3 reaches for beyond a year. `usd_modeled` prices each row through the
/// rate in force at its own timestamp, so summing tokens first and pricing the
/// sum would price a mixed-model bucket at one model's rate. To fold in SQL you
/// must group by the split dimension *and* the model, which is the grain the
/// rows already have. So the shape is right and the bound is what carries the
/// honest answer or the honest refusal.
pub const ROW_CAP: usize = 150_000;
pub const BYTE_CAP: usize = 24 * 1024 * 1024;

/// One `usage_fact` row, as `analytics.ts::Fact` reads it. The five-minute
/// grain carries the session and the agent, which the hourly rollup does not.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FineRow {
    pub at: i64,
    pub host: String,
    pub session: String,
    pub agent: String,
    pub parent_agent: String,
    pub depth: i64,
    pub model: String,
    pub effort: String,
    pub cli: String,
    pub source: String,
    pub account: String,
    pub account_identity: String,
    pub provider: String,
    pub project: String,
    pub provenance: String,
    pub in_tok: i64,
    pub out_tok: i64,
    pub cache_read: i64,
    pub write_5m: i64,
    pub write_1h: i64,
    pub requests: i64,
    pub usd_reported: f64,
}

/// One `usage_hour` row, as `analytics.ts::HourFact` reads it. `hour` rather
/// than `at` is the discriminator the query layer folds on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourRow {
    pub hour: i64,
    pub host: String,
    pub account: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub cli: String,
    pub source: String,
    pub project: String,
    pub provenance: String,
    pub in_tok: i64,
    pub out_tok: i64,
    pub cache_read: i64,
    pub write_5m: i64,
    pub write_1h: i64,
    pub requests: i64,
    pub usd_reported: f64,
}

/// The two shapes in one column, untagged, so the front end reads the same
/// `UsageRow` union it folds everywhere else and tells the tiers apart by
/// `"hour" in row` / `"at" in row`.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Row {
    Fine(FineRow),
    Hour(HourRow),
}

/// One window of facts, and the four readings a face needs beside them.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    /// `fine` or `hourly`, named so the face can say which tier answered
    /// (§9.1: a refusal names its tier, and so does an answer).
    pub tier: &'static str,
    pub since: i64,
    pub until: i64,
    pub rows: Vec<Row>,
    /// Cards whose session overlaps the window (`analytics_session.card_id`).
    /// Facts carry a session, not a card, and the hourly tier carries neither,
    /// so this is read off the session table at any span.
    pub cards: i64,
    /// The earliest instant either tier holds, or `None` when nothing has ever
    /// been recorded. This is what lets the empty state tell "the collector has
    /// not run yet" from "nothing happened in this window".
    ///
    /// **Both this and `recorded` are only answered for an empty window.** They
    /// exist for the empty state and nothing else reads them, and one of the
    /// two queries behind them is the only unindexed scan in this function.
    /// `None` on a window with rows is "not asked", not "nothing recorded".
    pub first: Option<i64>,
    /// Requests recorded across the whole store, so an empty window can say how
    /// much there is elsewhere. Read from the hourly tier, which outlives the
    /// fine one and holds every request either tier saw. Zero on a window with
    /// rows, for the same reason `first` is `None` there.
    pub recorded: i64,
}

const FINE_SQL: &str = "SELECT at, host, session, agent, parent_agent, depth, model, effort, cli,
                               source, account, account_identity, provider, project, provenance,
                               in_tok, out_tok, cache_read, write_5m, write_1h, requests,
                               usd_reported
                          FROM usage_fact
                         WHERE at >= ?1 AND at < ?2
                         ORDER BY at";

const HOUR_SQL: &str = "SELECT hour, host, account, provider, model, effort, cli, source,
                               project, provenance, in_tok, out_tok, cache_read, write_5m,
                               write_1h, requests, usd_reported
                          FROM usage_hour
                         WHERE hour >= ?1 AND hour < ?2
                         ORDER BY hour";

fn over_cap(tier: &str) -> String {
    format!(
        "this window needs more than {ROW_CAP} rows from the {tier} tier; ask for a shorter span"
    )
}

/// Read one window. The command is a thin shell around this so the refusals and
/// the two tiers can be tested against a store in memory.
pub(crate) fn query_window(
    conn: &Connection,
    since: i64,
    until: i64,
    fine: bool,
) -> Result<Window, String> {
    if until <= since {
        return Err("the window is empty: it ends before it starts".to_string());
    }
    if fine && until - since > FINE_WINDOW_MS {
        return Err(format!(
            "a window of {}h is wider than the fine tier's {}h; read it hourly instead",
            (until - since) / HOUR_MS,
            FINE_WINDOW_MS / HOUR_MS
        ));
    }

    let tier = if fine { "fine" } else { "hourly" };
    let mut rows: Vec<Row> = Vec::new();

    if fine {
        let mut stmt = conn.prepare(FINE_SQL).map_err(|e| format!("analytics: read facts: {e}"))?;
        let mut got = stmt
            .query(params![since, until])
            .map_err(|e| format!("analytics: read facts: {e}"))?;
        while let Some(r) = got.next().map_err(|e| format!("analytics: read facts: {e}"))? {
            /* One row past the cap is proof there is a row past the cap, and it
               is checked before the push rather than after the loop, which is
               the difference between refusing and truncating. */
            if rows.len() == ROW_CAP {
                return Err(over_cap(tier));
            }
            rows.push(Row::Fine(FineRow {
                at: r.get(0).map_err(|e| e.to_string())?,
                host: r.get(1).map_err(|e| e.to_string())?,
                session: r.get(2).map_err(|e| e.to_string())?,
                agent: r.get(3).map_err(|e| e.to_string())?,
                parent_agent: r.get(4).map_err(|e| e.to_string())?,
                depth: r.get(5).map_err(|e| e.to_string())?,
                model: r.get(6).map_err(|e| e.to_string())?,
                effort: r.get(7).map_err(|e| e.to_string())?,
                cli: r.get(8).map_err(|e| e.to_string())?,
                source: r.get(9).map_err(|e| e.to_string())?,
                account: r.get(10).map_err(|e| e.to_string())?,
                account_identity: r.get(11).map_err(|e| e.to_string())?,
                provider: r.get(12).map_err(|e| e.to_string())?,
                project: r.get(13).map_err(|e| e.to_string())?,
                provenance: r.get(14).map_err(|e| e.to_string())?,
                in_tok: r.get(15).map_err(|e| e.to_string())?,
                out_tok: r.get(16).map_err(|e| e.to_string())?,
                cache_read: r.get(17).map_err(|e| e.to_string())?,
                write_5m: r.get(18).map_err(|e| e.to_string())?,
                write_1h: r.get(19).map_err(|e| e.to_string())?,
                requests: r.get(20).map_err(|e| e.to_string())?,
                usd_reported: r.get(21).map_err(|e| e.to_string())?,
            }));
        }
    } else {
        let mut stmt = conn.prepare(HOUR_SQL).map_err(|e| format!("analytics: read hours: {e}"))?;
        let mut got = stmt
            .query(params![since, until])
            .map_err(|e| format!("analytics: read hours: {e}"))?;
        while let Some(r) = got.next().map_err(|e| format!("analytics: read hours: {e}"))? {
            if rows.len() == ROW_CAP {
                return Err(over_cap(tier));
            }
            rows.push(Row::Hour(HourRow {
                hour: r.get(0).map_err(|e| e.to_string())?,
                host: r.get(1).map_err(|e| e.to_string())?,
                account: r.get(2).map_err(|e| e.to_string())?,
                provider: r.get(3).map_err(|e| e.to_string())?,
                model: r.get(4).map_err(|e| e.to_string())?,
                effort: r.get(5).map_err(|e| e.to_string())?,
                cli: r.get(6).map_err(|e| e.to_string())?,
                source: r.get(7).map_err(|e| e.to_string())?,
                project: r.get(8).map_err(|e| e.to_string())?,
                provenance: r.get(9).map_err(|e| e.to_string())?,
                in_tok: r.get(10).map_err(|e| e.to_string())?,
                out_tok: r.get(11).map_err(|e| e.to_string())?,
                cache_read: r.get(12).map_err(|e| e.to_string())?,
                write_5m: r.get(13).map_err(|e| e.to_string())?,
                write_1h: r.get(14).map_err(|e| e.to_string())?,
                requests: r.get(15).map_err(|e| e.to_string())?,
                usd_reported: r.get(16).map_err(|e| e.to_string())?,
            }));
        }
    }

    /* `first` and `recorded` are only ever read by the empty state, so they are
       asked for only when the window is empty. That matters because the sum is
       not indexed: `EXPLAIN QUERY PLAN` says `SCAN usage_hour` for
       `SUM(requests)`, and `usage_hour` is never pruned, so on a wall years old
       it is the most expensive thing in this function and the least often
       useful. `MIN` on each tier is the other way round — both clocks are
       indexed, so each is a covering-index search. */
    let (first, recorded) = if rows.is_empty() {
        let (first_at, first_hour, recorded): (Option<i64>, Option<i64>, i64) = conn
            .query_row(
                "SELECT (SELECT MIN(at)   FROM usage_fact),
                        (SELECT MIN(hour) FROM usage_hour),
                        (SELECT COALESCE(SUM(requests), 0) FROM usage_hour)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| format!("analytics: read the store's span: {e}"))?;
        let first = match (first_at, first_hour) {
            (Some(a), Some(h)) => Some(a.min(h)),
            (a, h) => a.or(h),
        };
        (first, recorded)
    } else {
        (None, 0)
    };

    /* A session counts while it overlaps the window, and one with no `ended_at`
       is still open: `until` stands in for its end, which is the same rule the
       wall draws a live card by.

       Only a session with a card is a card. A terminal session has no card row
       and counting it here would put a number under a word that does not mean
       it.

       This one is not window-bounded by an index (`analytics_session` is keyed
       by session and host, not by time), so it is a scan. It is a scan of the
       *sessions* table, which is one row per conversation rather than one per
       request: thousands on the busiest wall this app has seen, against the
       hundreds of thousands in `usage_hour`. It is paid on every read because
       the strip shows it on every read, and an index for that would be a schema
       rung for a microsecond. */
    let cards: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM analytics_session
              WHERE card_id IS NOT NULL
                AND started_at < ?2
                AND COALESCE(ended_at, ?2) >= ?1",
            params![since, until],
            |r| r.get(0),
        )
        .map_err(|e| format!("analytics: count cards: {e}"))?;

    let window = Window {
        tier,
        since,
        until,
        rows,
        cards,
        first,
        recorded,
    };

    /* The byte cap is measured on the answer itself rather than estimated from
       the row count, because what a row costs is the project's name and the
       session id. The row cap above is what keeps this measurement's own
       allocation bounded. */
    let bytes = serde_json::to_vec(&window)
        .map_err(|e| format!("analytics: measure the answer: {e}"))?
        .len();
    if bytes > BYTE_CAP {
        return Err(format!(
            "this window's answer is {:.1} MB, past the {} MB cap; ask for a shorter span",
            bytes as f64 / 1e6,
            BYTE_CAP / 1_000_000
        ));
    }

    Ok(window)
}

/// Read one window for the room (§11). `fine` is the caller's tier decision,
/// made in `analyticsroom.ts::windowTier` and enforced here as well: the wire is
/// not a place to trust.
///
/// The lock is taken and released inside the blocking pool. A month of hourly
/// rows on a busy wall is tens of thousands of rows, and doing that inline on
/// the main thread would stop every card painting for as long as the scan took
/// (`off_main`).
#[tauri::command]
pub async fn analytics_window(
    app: AppHandle,
    since: i64,
    until: i64,
    fine: bool,
) -> Result<Window, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        query_window(&conn, since, until, fine)
    })
    .await?
}

/* ── the prompt facts a trace reads (§3.8, phase 5a) ────────────────────── */

/// One `prompt_fact` row, **without its body**.
///
/// No `bodySealed` and no text, ever, at any version of this struct: the trace
/// that draws these has no use for a ciphertext it cannot open, and a field that
/// exists is a field somebody will fill in from the wrong place. The body is
/// phase 5b's, behind the vault, and it will arrive through a call of its own
/// once there is a key to unseal it with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRow {
    pub host: String,
    pub prompt_id: String,
    pub at: i64,
    pub hour: i64,
    pub seen_count: i64,
    pub session: String,
    pub card: String,
    pub project: String,
    pub source: String,
    pub account: String,
    pub provider: String,
    pub vault_id: String,
    pub kind: String,
    pub kind_override: Option<String>,
    pub chars: i64,
    pub words: i64,
    pub lines: i64,
    pub fences: i64,
    pub code_lines: i64,
    pub images: i64,
    pub questions: i64,
    pub redactions: i64,
    pub withheld: i64,
    /// `sealed` under an open vault, `locked` when there was no key (the text is
    /// still in its transcript), `withheld` where the redactor refused it,
    /// `deleted` where a forget removed it, and `none` for a row recorded
    /// before phase 5b existed.
    pub body_state: String,
    pub body_truncated: i64,
}

/// How many rows one day's trace may ask for.
///
/// A day of prompts is a few hundred: the five-day window §3.8 measured had
/// 832. Ten thousand is a bound on a malformed request rather than a budget any
/// real day meets, and past it the answer is a refusal that names the number,
/// the same bargain `analytics_window` strikes one table over.
pub const PROMPT_ROW_CAP: usize = 10_000;

/// The prompts said in `[from, to)`, oldest first.
///
/// **The window is the caller's.** A day is a timezone and Rust does not know
/// where midnight is (`usage.md`'s argument for `spend_since`), so the front end
/// passes its own bounds; a local day is 23 or 25 hours twice a year, and only
/// the front end can compute that. The trace lane decides whether it wants a
/// local day, a UTC one, or something else entirely.
pub fn prompt_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<PromptRow>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT host, prompt_id, at, hour, seen_count, session, card, project, source,
                    account, provider, vault_id, kind, kind_override, chars, words, lines,
                    fences, code_lines, images, questions, redactions, withheld,
                    body_state, body_truncated
               FROM prompt_fact
              WHERE at >= ?1 AND at < ?2
              ORDER BY at, prompt_id
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: prompts: {e}"))?;
    let rows = stmt
        .query_map(
            params![from, to, PROMPT_ROW_CAP as i64 + 1],
            |r| {
                Ok(PromptRow {
                    host: r.get(0)?,
                    prompt_id: r.get(1)?,
                    at: r.get(2)?,
                    hour: r.get(3)?,
                    seen_count: r.get(4)?,
                    session: r.get(5)?,
                    card: r.get(6)?,
                    project: r.get(7)?,
                    source: r.get(8)?,
                    account: r.get(9)?,
                    provider: r.get(10)?,
                    vault_id: r.get(11)?,
                    kind: r.get(12)?,
                    kind_override: r.get(13)?,
                    chars: r.get(14)?,
                    words: r.get(15)?,
                    lines: r.get(16)?,
                    fences: r.get(17)?,
                    code_lines: r.get(18)?,
                    images: r.get(19)?,
                    questions: r.get(20)?,
                    redactions: r.get(21)?,
                    withheld: r.get(22)?,
                    body_state: r.get(23)?,
                    body_truncated: r.get(24)?,
                })
            },
        )
        .map_err(|e| format!("analytics: prompts: {e}"))?;
    let out: Vec<PromptRow> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: prompts: {e}"))?;
    if out.len() > PROMPT_ROW_CAP {
        return Err(format!(
            "analytics: that window holds more than {PROMPT_ROW_CAP} prompts, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    Ok(out)
}

/// The prompt facts of one window, for the trace phase 5b and the hall draw.
///
/// Off the main thread, like every other reading here: a day's rows are small
/// but the query takes the store's mutex, and the main thread is the one that
/// paints.
#[tauri::command]
pub async fn prompt_facts(app: AppHandle, from: i64, to: i64) -> Result<Vec<PromptRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        prompt_rows(&conn, from, to)
    })
    .await?
}

/* ── tool and work readings, for the behaviour and cost pages (§11.9, §11.14) ── */

/// One `tool_fact` row, as a page reads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRow {
    pub turn_id: i64,
    pub at: i64,
    pub host: String,
    pub session: String,
    pub agent: String,
    pub kind: String,
    pub server: String,
    pub tool: String,
    pub target: String,
    pub child_agent: String,
    pub requested_model: String,
    pub calls: i64,
    pub errors: i64,
    pub ms_total: i64,
    pub out_bytes: i64,
    pub turn_usd: f64,
}

/// A window's tool facts, bounded the way `prompt_rows` is.
///
/// **`turn_id = 0` is a call no turn claimed**, and its `turn_usd` is 0 by
/// construction: a reader must not divide a turn's cost by rows that were never
/// in its denominator (§3.7).
pub const TOOL_ROW_CAP: usize = 100_000;

pub fn tool_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<ToolRow>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT turn_id, at, host, session, agent, kind, server, tool, target,
                    child_agent, requested_model, calls, errors, ms_total, out_bytes, turn_usd
               FROM tool_fact
              WHERE at >= ?1 AND at < ?2
              ORDER BY at, tool, server
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: tools: {e}"))?;
    let rows = stmt
        .query_map(params![from, to, TOOL_ROW_CAP as i64 + 1], |r| {
            Ok(ToolRow {
                turn_id: r.get(0)?,
                at: r.get(1)?,
                host: r.get(2)?,
                session: r.get(3)?,
                agent: r.get(4)?,
                kind: r.get(5)?,
                server: r.get(6)?,
                tool: r.get(7)?,
                target: r.get(8)?,
                child_agent: r.get(9)?,
                requested_model: r.get(10)?,
                calls: r.get(11)?,
                errors: r.get(12)?,
                ms_total: r.get(13)?,
                out_bytes: r.get(14)?,
                turn_usd: r.get(15)?,
            })
        })
        .map_err(|e| format!("analytics: tools: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: tools: {e}"))?;
    if rows.len() > TOOL_ROW_CAP {
        return Err(format!(
            "analytics: that window holds more than {TOOL_ROW_CAP} tool facts, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    Ok(rows)
}

#[tauri::command]
pub async fn tool_facts(app: AppHandle, from: i64, to: i64) -> Result<Vec<ToolRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        tool_rows(&conn, from, to)
    })
    .await?
}

/// One tool's totals over the window, as the behaviour page reads them
/// (§11.9).
///
/// The rollup is the reason this command exists rather than the page reading
/// `tool_facts`: the fine tier is pruned at ninety days while `tool_hour` is
/// kept, and a percentile over months can only be answered by the five latency
/// bands that table carries.
///
/// **Grouped here, so the answer is tools rather than tool-hours.** The page
/// draws no instant: its tables, its strip and its scatter answer per tool, and
/// a year of hours x tools x projects is hundreds of thousands of rows for
/// dozens of groups. Summing in SQL is what lets the tab offer the spend tab's
/// year at all, and it is the same figures at a smaller grain. The dimensions
/// the grouping drops (host, account, provider, project) are the spend view's
/// filters and are not drawn here; a filter on this page would ask for them
/// back, which is a change to make when the rail reaches this tab.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTotalRow {
    pub kind: String,
    pub server: String,
    pub tool: String,
    pub target: String,
    pub calls: i64,
    pub errors: i64,
    pub receipts: i64,
    pub ms_total: i64,
    pub ms_under_50: i64,
    pub ms_under_200: i64,
    pub ms_under_1s: i64,
    pub ms_under_5s: i64,
    pub ms_over_5s: i64,
    pub out_bytes: i64,
    pub turn_usd: f64,
}

/// Distinct tools, servers, skills and subagents — dozens, not hours. The guard
/// is for a malformed window, refused rather than truncated, the same bargain
/// every other read here strikes.
pub const TOOL_TOTAL_CAP: usize = 20_000;

pub fn tool_total_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<ToolTotalRow>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT kind, server, tool, target,
                    SUM(calls), SUM(errors), SUM(receipts), SUM(ms_total),
                    SUM(ms_under_50), SUM(ms_under_200), SUM(ms_under_1s),
                    SUM(ms_under_5s), SUM(ms_over_5s), SUM(out_bytes), SUM(turn_usd)
               FROM tool_hour
              WHERE hour >= ?1 AND hour < ?2
              GROUP BY kind, server, tool, target
              ORDER BY kind, server, tool, target
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: tool totals: {e}"))?;
    let rows = stmt
        .query_map(params![from, to, TOOL_TOTAL_CAP as i64 + 1], |r| {
            Ok(ToolTotalRow {
                kind: r.get(0)?,
                server: r.get(1)?,
                tool: r.get(2)?,
                target: r.get(3)?,
                calls: r.get(4)?,
                errors: r.get(5)?,
                receipts: r.get(6)?,
                ms_total: r.get(7)?,
                ms_under_50: r.get(8)?,
                ms_under_200: r.get(9)?,
                ms_under_1s: r.get(10)?,
                ms_under_5s: r.get(11)?,
                ms_over_5s: r.get(12)?,
                out_bytes: r.get(13)?,
                turn_usd: r.get(14)?,
            })
        })
        .map_err(|e| format!("analytics: tool totals: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: tool totals: {e}"))?;
    if rows.len() > TOOL_TOTAL_CAP {
        return Err(format!(
            "analytics: that window holds more than {TOOL_TOTAL_CAP} tool totals, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    Ok(rows)
}

#[tauri::command]
pub async fn tool_totals(app: AppHandle, from: i64, to: i64) -> Result<Vec<ToolTotalRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        tool_total_rows(&conn, from, to)
    })
    .await?
}

/// One `analytics_session` row, whole, as the behaviour page's habits read it
/// (§11.9).
///
/// `work_series` already carries a narrower session row for the coordination
/// strip. This one is the record rather than a drawing of it: `opened_by` is
/// what splits a spawn by person or agent, and the account, provider and turn
/// halves are what a card's history will read when a view asks for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFact {
    pub session: String,
    pub host: String,
    pub project: String,
    pub source: String,
    /// `''` for a terminal session, which has no card behind it.
    pub card: String,
    pub parent_card: String,
    /// `person`, `agent`, or `unknown` when nothing recorded who opened it.
    pub opened_by: String,
    pub branch: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub cli_min: String,
    pub cli_max: String,
    pub account_first: String,
    pub account_last: String,
    pub provider_first: String,
    pub provider_last: String,
    pub turns: i64,
}

pub const SESSION_FACT_CAP: usize = 20_000;

/// One `analytics_session` row off a reader, in the column order both queries
/// below select. Shared so a card's life and a window cannot disagree about
/// what a session row is.
fn session_at(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionFact> {
    Ok(SessionFact {
        session: r.get(0)?,
        host: r.get(1)?,
        project: r.get(2)?,
        source: r.get(3)?,
        card: r.get(4)?,
        parent_card: r.get(5)?,
        opened_by: r.get(6)?,
        branch: r.get(7)?,
        started_at: r.get(8)?,
        ended_at: r.get(9)?,
        cli_min: r.get(10)?,
        cli_max: r.get(11)?,
        account_first: r.get(12)?,
        account_last: r.get(13)?,
        provider_first: r.get(14)?,
        provider_last: r.get(15)?,
        turns: r.get(16)?,
    })
}

const SESSION_COLUMNS: &str =
    "session, host, project, source, COALESCE(card_id, ''),
     COALESCE(parent_card, ''), opened_by, branch, started_at, ended_at,
     COALESCE(cli_min, ''), COALESCE(cli_max, ''),
     account_first, account_last, provider_first, provider_last, turns";

/// Sessions that overlap the window, not only those that started inside it:
/// a card working at the window's edge belongs to whatever the window counts,
/// and `started_at < to AND coalesce(ended_at, to) > from` is the same overlap
/// the coordination strip places with.
///
/// **A spawn is narrower than this.** The front end counts a card as opened
/// only when its `started_at` falls inside the window, so a session returned
/// here because it overlapped is in the window's sessions and not in its
/// spawns; that is the doc's §9.7 measure and it is decided where the habits
/// are folded.
pub fn session_fact_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<SessionFact>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SESSION_COLUMNS}
               FROM analytics_session
              WHERE started_at < ?2 AND COALESCE(ended_at, ?2) > ?1
              ORDER BY started_at
              LIMIT ?3"
        ))
        .map_err(|e| format!("analytics: sessions: {e}"))?;
    let rows = stmt
        .query_map(params![from, to, SESSION_FACT_CAP as i64 + 1], session_at)
        .map_err(|e| format!("analytics: sessions: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: sessions: {e}"))?;
    if rows.len() > SESSION_FACT_CAP {
        return Err(format!(
            "analytics: that window holds more than {SESSION_FACT_CAP} sessions, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    Ok(rows)
}

#[tauri::command]
pub async fn session_facts(app: AppHandle, from: i64, to: i64) -> Result<Vec<SessionFact>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        session_fact_rows(&conn, from, to)
    })
    .await?
}

/* ── a card's life (§11.10) ────────────────────────────────────────────────*/

/// One `(session, account, provider, model)` group of a card's spend.
///
/// Built by `spend::payer_split`, which is where the fold lives: the
/// `prefer_transcript` rule that stops a backfilled turn day and the transcript
/// facts over the same hour being added twice is that module's, and a second
/// copy of it here would be a second answer to one question.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeSpend {
    pub session: String,
    pub account: String,
    pub provider: String,
    pub model: String,
    /// The first and last request under this funding and model. The bar reads
    /// the sums; the change timeline reads the instants.
    pub first_at: i64,
    pub last_at: i64,
    pub in_tok: i64,
    pub out_tok: i64,
    pub cache_read: i64,
    pub write_5m: i64,
    pub write_1h: i64,
    pub requests: i64,
    /// Modelled dollars at each fact's own instant (`pricing.json`); null only
    /// when this build cannot read the table.
    pub usd: Option<f64>,
    /// Tokens on a model the table does not know: counted, never priced as 0.
    pub unpriced: i64,
}

/// A move of account, provider or model, as a card's change timeline reads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeMove {
    pub at: i64,
    pub kind: String,
    pub reference: String,
}

/// Everything a card's page draws, in one read.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardLife {
    pub card: String,
    pub label: String,
    /// The session it is on now, and the funding and model its row carries —
    /// the chip at the top, never the caption of the total (§11.10).
    pub now_session: String,
    pub now_account: String,
    pub now_model: String,
    /// Every session `analytics_session` attributes to this card, oldest first.
    pub sessions: Vec<SessionFact>,
    pub spend: Vec<LifeSpend>,
    pub moves: Vec<LifeMove>,
    /// The CLI's own reported cost over this card's settled turns, all time.
    /// The `turn` table is not pruned, so this figure is the card's whole life.
    pub usd_reported: f64,
    pub turns: i64,
    /// The oldest `usage_fact` this wall still holds. When the card was born
    /// before it, the token totals and the split cover only what survived the
    /// fine tier's ninety days, and the page says so rather than drawing a
    /// lifetime bar over a recent window.
    pub facts_from: i64,
}

pub const LIFE_MOVE_CAP: usize = 2_000;
pub const LIFE_SPEND_CAP: usize = 4_000;

/// A card's whole life: its sessions, who paid for what, when it moved, and
/// what it cost. **Not windowed on the surface's span** — a card is a history,
/// and a page fed by the current span would redraw the card whenever you
/// widened a chart.
pub fn card_life_rows(conn: &Connection, card: &str) -> Result<CardLife, String> {
    if card.trim().is_empty() {
        return Err("analytics: a card's life needs a card".into());
    }
    let (label, now_session, now_account, now_model) = conn
        .query_row(
            "SELECT COALESCE(title, ''), COALESCE(agent_session_id, ''),
                    COALESCE(account_label, ''), COALESCE(model, '')
               FROM conversation WHERE id = ?1",
            [card],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("analytics: card: {e}"))?
        .unwrap_or_default();

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SESSION_COLUMNS}
               FROM analytics_session
              WHERE card_id = ?1
              ORDER BY started_at
              LIMIT ?2"
        ))
        .map_err(|e| format!("analytics: card sessions: {e}"))?;
    let sessions = stmt
        .query_map(params![card, SESSION_FACT_CAP as i64 + 1], session_at)
        .map_err(|e| format!("analytics: card sessions: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: card sessions: {e}"))?;
    if sessions.len() > SESSION_FACT_CAP {
        return Err(format!(
            "analytics: this card holds more than {SESSION_FACT_CAP} sessions, which is more than \
             a page can draw"
        ));
    }
    drop(stmt);

    let spend = crate::spend::payer_split(conn, card)?;
    if spend.len() > LIFE_SPEND_CAP {
        return Err(format!(
            "analytics: this card has spend under more than {LIFE_SPEND_CAP} account, provider \
             and model groupings, which is more than the page can draw"
        ));
    }

    /* Moves only, and only receipts: an `attributed` row is one paying card's
       excess at the same instant, not a transition of this card. The move rows
       are kept past the fine tier's ninety days by the retention tail in
       `write_tail`, so a card's history does not lose its turns in the middle. */
    let mut stmt = conn
        .prepare(
            "SELECT at, kind, ref FROM invalidate_fact
              WHERE card = ?1 AND provenance = 'receipt'
                AND kind IN ('account', 'provider', 'model')
              ORDER BY at, kind
              LIMIT ?2",
        )
        .map_err(|e| format!("analytics: card moves: {e}"))?;
    let moves = stmt
        .query_map(params![card, LIFE_MOVE_CAP as i64 + 1], |r| {
            Ok(LifeMove {
                at: r.get(0)?,
                kind: r.get(1)?,
                reference: r.get(2)?,
            })
        })
        .map_err(|e| format!("analytics: card moves: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: card moves: {e}"))?;
    if moves.len() > LIFE_MOVE_CAP {
        return Err(format!(
            "analytics: this card has moved more than {LIFE_MOVE_CAP} times, which is more than a \
             timeline can draw"
        ));
    }
    drop(stmt);

    let (turns, usd_reported): (i64, f64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(usd), 0) FROM turn
              WHERE conversation_id = ?1 AND ended_at IS NOT NULL",
            [card],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("analytics: card turns: {e}"))?;

    let facts_from: i64 = conn
        .query_row("SELECT COALESCE(MIN(at), 0) FROM usage_fact", [], |r| r.get(0))
        .map_err(|e| format!("analytics: facts: {e}"))?;

    Ok(CardLife {
        card: card.to_string(),
        label,
        now_session,
        now_account,
        now_model,
        sessions,
        spend,
        moves,
        usd_reported,
        turns,
        facts_from,
    })
}

#[tauri::command]
pub async fn card_life(app: AppHandle, card: String) -> Result<CardLife, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        card_life_rows(&conn, &card)
    })
    .await?
}

/// One `work_fact` row, as the cost-against-output page reads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRow {
    pub at: i64,
    pub host: String,
    pub session: String,
    pub card: String,
    pub agent: String,
    pub kind: String,
    pub r#ref: String,
    pub branch: String,
    pub project: String,
    pub files: i64,
    pub added: i64,
    pub removed: i64,
    pub conflict_files: i64,
    pub ms: i64,
    /// `receipt | history`, kept because §3.9 forbids summing them without
    /// saying so.
    pub provenance: String,
}

pub const WORK_ROW_CAP: usize = 50_000;

pub fn work_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<WorkRow>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT at, host, session, card, agent, kind, ref, branch, project,
                    files, added, removed, conflict_files, ms, provenance
               FROM work_fact
              WHERE at >= ?1 AND at < ?2
              ORDER BY at, kind, ref
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: work: {e}"))?;
    let rows = stmt
        .query_map(params![from, to, WORK_ROW_CAP as i64 + 1], |r| {
            Ok(WorkRow {
                at: r.get(0)?,
                host: r.get(1)?,
                session: r.get(2)?,
                card: r.get(3)?,
                agent: r.get(4)?,
                kind: r.get(5)?,
                r#ref: r.get(6)?,
                branch: r.get(7)?,
                project: r.get(8)?,
                files: r.get(9)?,
                added: r.get(10)?,
                removed: r.get(11)?,
                conflict_files: r.get(12)?,
                ms: r.get(13)?,
                provenance: r.get(14)?,
            })
        })
        .map_err(|e| format!("analytics: work: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: work: {e}"))?;
    if rows.len() > WORK_ROW_CAP {
        return Err(format!(
            "analytics: that window holds more than {WORK_ROW_CAP} work facts, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    Ok(rows)
}

/// One invalidation fact, as the work page reads it (§3.9).
///
/// **Two provenances, one event.** A `receipt` row is the write or the move; an
/// `attributed` row is one paying card's excess at the same instant. The page
/// counts events from receipts and sums dollars from attributed rows, and the
/// two numbers are never added together (§9.1).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidateRow {
    pub at: i64,
    pub host: String,
    pub session: String,
    pub card: String,
    pub kind: String,
    pub r#ref: String,
    pub tree: String,
    pub affected: i64,
    /// The attributed excess, in cache-write tokens. The front end prices it.
    pub tokens: i64,
    /// The same excess in fresh input tokens, where a restarted process's
    /// re-read of the prefix lands on the CLI this was measured against.
    pub in_tokens: i64,
    /// The model the excess was written against, `''` on a receipt row.
    pub model: String,
    /// Dollars a writer that knows them stored. 0 on every row this build
    /// writes, because Rust does not price.
    pub usd: f64,
    pub provenance: String,
}

pub const INVALIDATE_ROW_CAP: usize = 20_000;

pub fn invalidate_rows(conn: &Connection, from: i64, to: i64) -> Result<Vec<InvalidateRow>, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT at, host, session, card, kind, ref, tree, affected, tokens, in_tokens,
                    model, usd, provenance
               FROM invalidate_fact
              WHERE at >= ?1 AND at < ?2
              ORDER BY at, kind, ref, provenance
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: invalidate: {e}"))?;
    let rows = stmt
        .query_map(params![from, to, INVALIDATE_ROW_CAP as i64 + 1], |r| {
            Ok(InvalidateRow {
                at: r.get(0)?,
                host: r.get(1)?,
                session: r.get(2)?,
                card: r.get(3)?,
                kind: r.get(4)?,
                r#ref: r.get(5)?,
                tree: r.get(6)?,
                affected: r.get(7)?,
                tokens: r.get(8)?,
                in_tokens: r.get(9)?,
                model: r.get(10)?,
                usd: r.get(11)?,
                provenance: r.get(12)?,
            })
        })
        .map_err(|e| format!("analytics: invalidate: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: invalidate: {e}"))?;
    if rows.len() > INVALIDATE_ROW_CAP {
        return Err(format!(
            "analytics: that window holds more than {INVALIDATE_ROW_CAP} invalidation facts, so \
             it is refused rather than truncated: ask for a narrower one"
        ));
    }
    Ok(rows)
}

#[tauri::command]
pub async fn invalidate_facts(app: AppHandle, from: i64, to: i64) -> Result<Vec<InvalidateRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        invalidate_rows(&conn, from, to)
    })
    .await?
}

#[tauri::command]
pub async fn work_facts(app: AppHandle, from: i64, to: i64) -> Result<Vec<WorkRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        work_rows(&conn, from, to)
    })
    .await?
}

/// One hour of `work_hour`, which is what a year view reads.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHourRow {
    pub hour: i64,
    pub host: String,
    pub project: String,
    pub branch: String,
    pub kind: String,
    pub count: i64,
    pub files: i64,
    pub added: i64,
    pub removed: i64,
    pub conflict_ms: i64,
}

/// One card's tokens for one UTC hour, which is what lets the front end price a
/// card's cost without shipping its facts.
///
/// **Pricing is a query-time read of the rate table**, so it lives in
/// `analytics.ts::modeledUsd`, not here: a SQL `SUM` of dollars would be a
/// second price table and would disagree with the spend page. What Rust can do
/// is the join `usage_fact` has no column for — a fact carries a *session*, and
/// `analytics_session.card_id` is what says whose session it was. Grouping by
/// hour keeps the answer to cards x hours x models rather than one row per
/// fact, and the hour is the grain a card-level aggregate can honestly claim
/// (§7.4's argument for the turn backfill, the same one).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSpendRow {
    /// `''` when no session row claims the fact, which is spend the card table
    /// shows as uncarded rather than silently assigning.
    pub card: String,
    pub hour: i64,
    pub account: String,
    pub model: String,
    pub provenance: String,
    pub in_tok: i64,
    pub out_tok: i64,
    pub cache_read: i64,
    pub write_5m: i64,
    pub write_1h: i64,
    pub requests: i64,
    pub usd_reported: f64,
}

/// A card's session, as the coordination strip draws its bar.
///
/// The interval, not a duration: the strip needs where a card was working, and
/// two sessions of one card are two stretches of the same bar. `ended_at` is
/// `None` while a session is open, and the face draws it to the window's edge
/// rather than inventing an end.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionRow {
    pub session: String,
    pub host: String,
    /// `''` for a terminal session, which has no card and is drawn as its own
    /// row so its spend and commits are not attributed to anybody.
    pub card: String,
    pub project: String,
    pub source: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

/// The rollup and the two readings that share its window.
///
/// The hour rows are what a year can afford to carry. `spend` and `sessions`
/// are what move the work page from a card's artifacts to its *cost against
/// output*: the tokens to price and the intervals to place. They are part of
/// the same answer because the page's table, scatter and coordination strip
/// must not be three reads of one window that can disagree. The per-card
/// artifact totals are folded in the front end from the facts themselves, which
/// the page already has, so they are deliberately not a fourth copy here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSeries {
    pub hourly: Vec<WorkHourRow>,
    pub spend: Vec<CardSpendRow>,
    pub sessions: Vec<WorkSessionRow>,
}

pub const WORK_HOUR_CAP: usize = 50_000;
/// Cards x hours x models, not facts: a busy week on a ten-card wall is a few
/// thousand rows. The guard is for a malformed window, refused rather than
/// truncated, the same bargain every other read here strikes.
pub const WORK_SPEND_CAP: usize = 120_000;
pub const WORK_SESSION_CAP: usize = 20_000;

pub fn work_series_rows(conn: &Connection, from: i64, to: i64) -> Result<WorkSeries, String> {
    if to <= from {
        return Err(format!(
            "analytics: a window ending at {to} does not start after {from}"
        ));
    }
    let mut stmt = conn
        .prepare(
            "SELECT hour, host, project, branch, kind, count, files, added, removed, conflict_ms
               FROM work_hour
              WHERE hour >= ?1 AND hour < ?2
              ORDER BY hour, project, kind
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: work series: {e}"))?;
    let hourly = stmt
        .query_map(params![from, to, WORK_HOUR_CAP as i64 + 1], |r| {
            Ok(WorkHourRow {
                hour: r.get(0)?,
                host: r.get(1)?,
                project: r.get(2)?,
                branch: r.get(3)?,
                kind: r.get(4)?,
                count: r.get(5)?,
                files: r.get(6)?,
                added: r.get(7)?,
                removed: r.get(8)?,
                conflict_ms: r.get(9)?,
            })
        })
        .map_err(|e| format!("analytics: work series: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: work series: {e}"))?;
    if hourly.len() > WORK_HOUR_CAP {
        return Err(format!(
            "analytics: that window holds more than {WORK_HOUR_CAP} work hours, so it is refused \
             rather than truncated: ask for a narrower one"
        ));
    }
    /* The card join, and it is a left join on purpose: a fact whose session has
       no `analytics_session` row is still spend, it just cannot be attributed to
       a card. `''` keeps it in the total and out of a card's column, which is
       the same "counts toward the project, not a card" rule §3.9 states for an
       unattributable commit. */
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(s.card_id, '') AS card, (f.at / 3600000) * 3600000 AS hour,
                    f.account, f.model, f.provenance,
                    COALESCE(SUM(f.in_tok), 0), COALESCE(SUM(f.out_tok), 0),
                    COALESCE(SUM(f.cache_read), 0), COALESCE(SUM(f.write_5m), 0),
                    COALESCE(SUM(f.write_1h), 0), COALESCE(SUM(f.requests), 0),
                    COALESCE(SUM(f.usd_reported), 0)
               FROM usage_fact f
               LEFT JOIN analytics_session s
                      ON s.session = f.session AND s.host = f.host
              WHERE f.at >= ?1 AND f.at < ?2
              GROUP BY card, hour, f.account, f.model, f.provenance
              ORDER BY hour, card
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: work spend: {e}"))?;
    let spend = stmt
        .query_map(params![from, to, WORK_SPEND_CAP as i64 + 1], |r| {
            Ok(CardSpendRow {
                card: r.get(0)?,
                hour: r.get(1)?,
                account: r.get(2)?,
                model: r.get(3)?,
                provenance: r.get(4)?,
                in_tok: r.get(5)?,
                out_tok: r.get(6)?,
                cache_read: r.get(7)?,
                write_5m: r.get(8)?,
                write_1h: r.get(9)?,
                requests: r.get(10)?,
                usd_reported: r.get(11)?,
            })
        })
        .map_err(|e| format!("analytics: work spend: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: work spend: {e}"))?;
    if spend.len() > WORK_SPEND_CAP {
        return Err(format!(
            "analytics: that window holds more than {WORK_SPEND_CAP} card-hours, so it is \
             refused rather than truncated: ask for a narrower one"
        ));
    }

    /* A session that is still open has no end; the face draws it to the
       window's edge, so `None` travels rather than a made-up instant. */
    let mut stmt = conn
        .prepare(
            "SELECT session, host, COALESCE(card_id, ''), project, source, started_at, ended_at
               FROM analytics_session
              WHERE started_at < ?2 AND COALESCE(ended_at, ?2) > ?1
              ORDER BY started_at
              LIMIT ?3",
        )
        .map_err(|e| format!("analytics: work sessions: {e}"))?;
    let sessions = stmt
        .query_map(params![from, to, WORK_SESSION_CAP as i64 + 1], |r| {
            Ok(WorkSessionRow {
                session: r.get(0)?,
                host: r.get(1)?,
                card: r.get(2)?,
                project: r.get(3)?,
                source: r.get(4)?,
                started_at: r.get(5)?,
                ended_at: r.get(6)?,
            })
        })
        .map_err(|e| format!("analytics: work sessions: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("analytics: work sessions: {e}"))?;
    if sessions.len() > WORK_SESSION_CAP {
        return Err(format!(
            "analytics: that window holds more than {WORK_SESSION_CAP} sessions, so it is \
             refused rather than truncated: ask for a narrower one"
        ));
    }

    Ok(WorkSeries { hourly, spend, sessions })
}

#[tauri::command]
pub async fn work_series(app: AppHandle, from: i64, to: i64) -> Result<WorkSeries, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        work_series_rows(&conn, from, to)
    })
    .await?
}

/* ── saved views (§11.6) ─────────────────────────────────────────────────── */

/// One row of the library, as the surface reads it. The spec travels as the
/// string it is stored as: the front end normalises it (`analytics.ts`'s
/// `normalizeView`), and Rust has no vocabulary for a measure or a split.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRow {
    pub id: String,
    pub name: String,
    pub config_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<crate::store::SavedViewRow> for ViewRow {
    fn from(r: crate::store::SavedViewRow) -> Self {
        ViewRow {
            id: r.id,
            name: r.name,
            config_json: r.config_json,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// The library, newest change first. Off the main thread for `analytics_window`'s
/// reason: it takes the store's mutex, and a command that blocks holding it on
/// the dispatching thread stops every card painting.
#[tauri::command]
pub async fn analytics_views(app: AppHandle) -> Result<Vec<ViewRow>, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        Ok(crate::store::analytics_views(&conn).into_iter().map(ViewRow::from).collect())
    })
    .await?
}

/// Save the surface's current question under a name. A new id every time: the
/// menu saves, and saving twice is two views, which is the honest reading of a
/// gesture that named it twice.
#[tauri::command]
pub async fn analytics_save_view(
    app: AppHandle,
    name: String,
    config_json: String,
) -> Result<ViewRow, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let id = crate::store::uuid_v4();
        crate::store::save_analytics_view(&conn, &id, &name, &config_json).map(ViewRow::from)
    })
    .await?
}

/// Rename in place. `false` means no view holds that id, which the surface says
/// rather than drawing a row that is not there.
#[tauri::command]
pub async fn analytics_rename_view(app: AppHandle, id: String, name: String) -> Result<bool, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::rename_analytics_view(&conn, &id, &name)
    })
    .await?
}

/// Delete one. `false` is "there was nothing to delete", and a second press is
/// allowed to say that rather than fail.
#[tauri::command]
pub async fn analytics_delete_view(app: AppHandle, id: String) -> Result<bool, String> {
    crate::off_main(move || {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        crate::store::delete_analytics_view(&conn, &id)
    })
    .await?
}

/* ── the collector ───────────────────────────────────────────────────────── */

struct Beat {
    stop: Mutex<bool>,
    wake: Condvar,
}

static BEAT: OnceLock<Arc<Beat>> = OnceLock::new();

/// Start the sixty-second collector (§7.1).
///
/// **The ledger's beat is not enough**, which is the whole reason this exists: it
/// runs only while a usage widget is attached, so recording would stop on the
/// wall that has none — the common case. The ledger keeps its twenty seconds as
/// an extra caller; both go through the same `Usage` state and the same walk.
///
/// **It stops by two things and needs only the second.** `stop` sets the flag and
/// wakes the condvar, which the exit handler calls; and the thread itself is a
/// plain thread of this process, so a crash or a kill takes it with the wall
/// rather than leaving a timer behind. Nothing here outlives the studios, and
/// nothing sleeps on a handle somebody else has to remember to release.
///
/// The first pass waits one beat. A launch is a webview starting and a store
/// opening, and the first pass after this feature lands reads every transcript
/// on the machine — a minute of quiet is a better neighbour than that read
/// competing with the window.
pub fn start(app: &AppHandle) {
    let beat = BEAT
        .get_or_init(|| {
            Arc::new(Beat {
                stop: Mutex::new(false),
                wake: Condvar::new(),
            })
        })
        .clone();
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("analytics".into())
        .spawn(move || loop {
            {
                let Ok(guard) = beat.stop.lock() else { return };
                let (guard, _) = beat
                    .wake
                    .wait_timeout(guard, BEAT_EVERY)
                    .unwrap_or_else(|e| e.into_inner());
                if *guard {
                    return;
                }
            }
            if app.try_state::<Store>().is_none() {
                return;
            }
            match pass(&app) {
                Ok(r) if r.requests > 0 => log::info!(
                    "analytics: {} requests in {} ms, {} facts, {} files, {} bytes",
                    r.requests,
                    r.ms,
                    r.facts,
                    r.files,
                    r.bytes
                ),
                Ok(_) => {}
                Err(e) => log::warn!("analytics: {e}"),
            }
        });
}

/// Stop the collector. Called from the exit handler, so a wall on its way down
/// does not start one more pass reading files it will never finish writing.
pub fn stop() {
    if let Some(beat) = BEAT.get() {
        if let Ok(mut guard) = beat.stop.lock() {
            *guard = true;
        }
        beat.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::store::migrate(&conn).unwrap();
        conn
    }

    fn request(at: i64, model: &str, tokens: i64) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"u-{at}","requestId":"req-{at}","timestamp":"{stamp}",
                "sessionId":"s1","version":"2.1.319","effort":"high","cwd":"C:\\workbench\\volery",
                "entrypoint":"sdk-cli",
                "message":{{"model":"{model}","id":"msg-{at}","usage":{{"input_tokens":{tokens}}}}}}}"#,
            stamp = stamp(at),
        )
    }

    /// A stamp for an arbitrary millisecond instant, so fixtures read as times
    /// rather than as arithmetic.
    ///
    /// **The milliseconds are written, not zeroed.** `epoch_ms` reads the
    /// fraction, so a fixture that dropped it rounded every parsed instant down
    /// to the second — which made a latency of 450 ms unrepresentable and a
    /// bucket boundary depend on where `now` happened to fall.
    fn stamp(at: i64) -> String {
        let secs = at.div_euclid(1000);
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let (y, m, d) = civil_from_days(days);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60,
            at.rem_euclid(1000)
        )
    }

    /// Howard Hinnant's `civil_from_days`, the inverse of `usage.rs`'s
    /// `days_from_civil`. Fixtures need it; nothing in the pass does.
    fn civil_from_days(days: i64) -> (i64, i64, i64) {
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        (if m <= 2 { y + 1 } else { y }, m, d)
    }

    fn record(line: &str) -> Record {
        crate::usage::read_record(line).expect("a request")
    }

    fn batch(lines: &[String]) -> Batch {
        let mut reading = Reading::new(HashMap::new(), 0);
        for line in lines {
            reading.request(&record(line));
        }
        reading.into_batch()
    }

    #[test]
    fn a_request_lands_in_its_five_minute_bucket() {
        /* Midnight UTC, which is on a five-minute boundary because the epoch is
           and a day is a whole number of them. */
        let base = 1_786_579_200_000;
        assert_eq!(bucket_of(base), base);
        assert_eq!(bucket_of(base + 4 * 60 * 1000), base);
        assert_eq!(bucket_of(base + 5 * 60 * 1000), base + BUCKET_MS);
        /* The boundary itself belongs to the later bucket, and the instant just
           before it to the earlier one — a bucket is `[at, at + 5m)`. */
        let edge = base + BUCKET_MS;
        assert_eq!(bucket_of(edge), edge);
        assert_eq!(bucket_of(edge - 1), base);
    }

    #[test]
    fn an_hour_is_a_utc_hour() {
        let midnight = 1_786_579_200_000; /* 2026-08-13T00:00:00Z */
        assert_eq!(hour_of(midnight), midnight);
        assert_eq!(hour_of(midnight + 59 * 60 * 1000), midnight);
        assert_eq!(hour_of(midnight + 60 * 60 * 1000), midnight + HOUR_MS);
    }

    /// One response written out as several records is one request, and the key
    /// is `message.id` + `requestId` — the pair `usage.rs` dedupes on. Two
    /// records differing only in `uuid` are the same request; two differing in
    /// `requestId` are not.
    #[test]
    fn the_dedupe_key_is_the_message_and_the_request() {
        let line = |uuid: &str, req: &str| {
            format!(
                r#"{{"type":"assistant","uuid":"{uuid}","requestId":"{req}",
                    "timestamp":"2026-08-13T06:07:48.364Z",
                    "message":{{"model":"claude-opus-5-5","id":"msg_1",
                    "usage":{{"output_tokens":408}}}}}}"#
            )
        };
        assert_eq!(record(&line("a", "r1")).key, record(&line("b", "r1")).key);
        assert_ne!(record(&line("a", "r1")).key, record(&line("a", "r2")).key);
    }

    #[test]
    fn a_request_is_folded_once_however_often_it_is_read() {
        let conns = Mutex::new(db());
        /* Relative to now, and that is not tidiness: `write` drops anything
           older than the fine tier's ninety days, so a fixture written as a
           fixed stamp passes on the day it is written and fails on CI a season
           later. */
        let line = request(now_ms() - 60_000, "claude-opus-5-5", 1000);
        let counts = write(&conns, "here", &batch(&[line.clone()]), now_ms()).unwrap();
        assert_eq!(counts.requests, 1);
        let one: (i64, i64) = conns
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(requests), SUM(in_tok) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(one, (1, 1000));

        /* The same file offered again — a replacement re-read from zero. */
        let again = write(&conns, "here", &batch(&[line]), now_ms()).unwrap();
        assert_eq!(again.requests, 0, "the dedupe stopped the second count");
        assert_eq!(again.duplicates, 1);
        let two: (i64, i64) = conns
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(requests), SUM(in_tok) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(two, (1, 1000), "and the totals did not move");
    }

    #[test]
    fn the_hour_is_the_sum_of_its_facts() {
        let conns = Mutex::new(db());
        /* A minute past an hour boundary and half a minute apart, so six
           requests cannot straddle an hour or a five-minute bucket and both
           tiers are one row either way. */
        let base = hour_of(now_ms() - 3_600_000) + 60_000;
        let lines: Vec<String> = (0..6)
            .map(|i| request(base + i * 30 * 1000, "claude-opus-5-5", 10))
            .collect();
        write(&conns, "here", &batch(&lines), now_ms()).unwrap();

        let facts: (i64, i64, i64) = conns
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(requests), SUM(in_tok), COUNT(*) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let hours: (i64, i64, i64) = conns
            .lock()
            .unwrap()
            .query_row(
                "SELECT SUM(requests), SUM(in_tok), COUNT(*) FROM usage_hour",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(facts.0, 6);
        assert_eq!(hours.0, facts.0, "every request reached the hour");
        assert_eq!(hours.1, facts.1, "and so did every token");
        /* Six requests in one minute are one fact row and one hour row. */
        assert_eq!(facts.2, 1);
        assert_eq!(hours.2, 1);
    }

    /* ── the room's read ─────────────────────────────────────────────────── */

    #[test]
    fn an_empty_window_and_an_unrecorded_store_are_different_readings() {
        let conn = db();
        let now = now_ms();
        let empty = query_window(&conn, now - 3_600_000, now, true).unwrap();
        assert_eq!(empty.tier, "fine");
        assert!(empty.rows.is_empty());
        assert_eq!(empty.cards, 0);
        /* The whole store is empty, which is what the face says *recording
           starts within a minute* for. It is not a zero spend. */
        assert_eq!(empty.first, None);
        assert_eq!(empty.recorded, 0);

        let conns = Mutex::new(db());
        let line = request(now_ms() - 60_000, "claude-opus-5-5", 1000);
        write(&conns, "here", &batch(&[line]), now_ms()).unwrap();
        let conn = conns.lock().unwrap();
        let now = now_ms();
        let window = query_window(&conn, now - 3_600_000, now, true).unwrap();
        assert_eq!(window.rows.len(), 1, "one fine row inside the hour");
        /* The store's own span is not asked for when the window has rows: it is
           the empty state's reading, and one of its two queries is a scan. */
        assert_eq!(window.first, None);
        assert_eq!(window.recorded, 0);

        /* An hour earlier holds nothing, and says so without claiming the store
           is empty. */
        let quiet = query_window(&conn, now - 7_200_000, now - 3_600_000, true).unwrap();
        assert!(quiet.rows.is_empty());
        assert!(quiet.first.is_some());
        assert_eq!(quiet.recorded, 1);
    }

    #[test]
    fn the_fine_tier_is_refused_past_its_own_window_and_the_hourly_tier_answers_it() {
        let conns = Mutex::new(db());
        let line = request(now_ms() - 60_000, "claude-opus-5-5", 1000);
        write(&conns, "here", &batch(&[line]), now_ms()).unwrap();
        let conn = conns.lock().unwrap();
        let now = now_ms();

        let refused = query_window(&conn, now - FINE_WINDOW_MS - 1, now, true).unwrap_err();
        assert!(refused.contains("fine tier"), "{refused}");

        /* The same span read hourly is answered, names its tier, and carries
           the rollup row the request landed in. */
        let wide = query_window(&conn, now - 7 * 24 * 3_600_000, now, false).unwrap();
        assert_eq!(wide.tier, "hourly");
        assert_eq!(wide.rows.len(), 1);
    }

    #[test]
    fn a_window_that_ends_before_it_starts_is_refused() {
        let conn = db();
        let now = now_ms();
        assert!(query_window(&conn, now, now, true).is_err());
        assert!(query_window(&conn, now, now - 1_000, false).is_err());
    }

    #[test]
    fn a_card_counts_while_its_session_overlaps_the_window() {
        let conn = db();
        let now = now_ms();
        let hour = 3_600_000;
        /* A card that ran inside the window, a card that ended before it, one
           still open from earlier, and a terminal session with no card at all. */
        conn.execute(
            "INSERT INTO analytics_session (session, host, card_id, started_at, ended_at)
             VALUES ('in', 'here', 'c1', ?1, ?2)",
            params![now - 2 * hour, now - hour],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO analytics_session (session, host, card_id, started_at, ended_at)
             VALUES ('gone', 'here', 'c2', ?1, ?2)",
            params![now - 9 * hour, now - 8 * hour],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO analytics_session (session, host, card_id, started_at, ended_at)
             VALUES ('open', 'here', 'c3', ?1, NULL)",
            params![now - 3 * hour],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO analytics_session (session, host, card_id, started_at, ended_at)
             VALUES ('terminal', 'here', NULL, ?1, ?2)",
            params![now - 2 * hour, now - hour],
        )
        .unwrap();

        let cards = query_window(&conn, now - hour, now, true).unwrap().cards;
        assert_eq!(cards, 2, "the open card and the one that ran inside it");
    }

    #[test]
    fn a_window_past_the_row_cap_is_refused_rather_than_truncated() {
        let conn = db();
        let now = now_ms();
        let since = now - 3_600_000;
        {
            conn.execute_batch("BEGIN").unwrap();
            let mut stmt = conn
                .prepare(
                    "INSERT INTO usage_fact
                       (at, host, session, model, source, account, provider, project, requests)
                     VALUES (?1, 'here', 's', 'm', 'card', 'a', 'anthropic', 'p', 1)",
                )
                .unwrap();
            for i in 0..=(ROW_CAP as i64) {
                stmt.execute(params![since + i]).unwrap();
            }
        }
        conn.execute_batch("COMMIT").unwrap();

        let refused = query_window(&conn, since, now, true).unwrap_err();
        assert!(refused.contains("more than"), "{refused}");
        assert!(refused.contains(&ROW_CAP.to_string()), "{refused}");
    }

    #[test]
    fn the_ladder_takes_the_turn_then_the_owner_then_unknown() {
        let at = 1_786_601_268_000;
        let mut labels = HashMap::new();
        labels.insert("acct:org".to_string(), "lyss".to_string());
        let spans = vec![Span {
            opened: at - 1000,
            ended: Some(at + 1000),
            label: "tx-team".into(),
            identity: String::new(),
        }];

        /* 1. the turn containing the request wins, even with an owner present.
              The identity is still carried, because the transcript named one
              even though this turn row did not (§4). */
        assert_eq!(
            funding_at(&spans, at, Some("acct:org"), &labels, None),
            Funding {
                account: "tx-team".into(),
                identity: "acct:org".into(),
                provider: "claude".into()
            }
        );
        /* a request after the turn has ended falls through to the owner */
        assert_eq!(
            funding_at(&spans, at + 5000, Some("acct:org"), &labels, None),
            Funding {
                account: "lyss".into(),
                identity: "acct:org".into(),
                provider: "unknown".into()
            }
        );
        /* 2. an owner this wall has never registered keeps the identity, and the
              account is unknown rather than somebody else's */
        assert_eq!(
            funding_at(&spans, at + 5000, Some("other:org"), &labels, None),
            Funding {
                account: "unknown".into(),
                identity: "other:org".into(),
                provider: "unknown".into()
            }
        );
        /* 3. NULL is not Claude */
        let null = vec![Span {
            opened: at - 1000,
            ended: Some(at + 1000),
            label: String::new(),
            identity: String::new(),
        }];
        assert_eq!(funding_at(&null, at, None, &labels, None).account, "unknown");
        /* 4. neither rung: the account is unknown */
        assert_eq!(
            funding_at(&spans, at + 5000, None, &labels, None).account,
            "unknown"
        );
    }

    /// §4.1's second sentence, which is the one a `v61` upgrade depends on:
    /// every turn row from before that rung is boundaryless, so an old session's
    /// requests all fall to the owner rung — and the *card* still says which
    /// provider that session ran on. Without it the whole backfill of a DeepSeek
    /// card would read `unknown`, and `usage_seen` would stop any later pass
    /// correcting it.
    #[test]
    fn a_request_no_turn_covers_takes_its_provider_from_the_card() {
        let at = 1_786_601_268_000;
        let boundaryless = vec![Span {
            opened: at,
            ended: Some(at),
            label: "@deepseek".into(),
            identity: String::new(),
        }];
        let labels = HashMap::new();
        /* no owner record either: the account is unknown, the provider is not */
        let f = funding_at(&boundaryless, at, None, &labels, Some("@deepseek"));
        assert_eq!(f.account, "unknown");
        assert_eq!(f.provider, "deepseek");
        /* with an owner, the account resolves and the provider still comes from
           the card */
        let mut labels = HashMap::new();
        labels.insert("acct:org".to_string(), "lyss".to_string());
        let f = funding_at(&boundaryless, at, Some("acct:org"), &labels, Some("@credits"));
        assert_eq!(f.account, "lyss");
        assert_eq!(f.provider, "claude");
        /* a terminal session has no card, so its provider is unknown however
           familiar the alias in its records looks (§4.1) */
        assert_eq!(
            funding_at(&boundaryless, at, None, &HashMap::new(), None).provider,
            "unknown"
        );
    }

    /// A request inside a turn, with the turn's own identity present, keeps it
    /// rather than the session's.
    #[test]
    fn a_turn_that_named_its_own_identity_keeps_it() {
        let at = 1_786_601_268_000;
        let spans = vec![Span {
            opened: at - 1000,
            ended: Some(at + 1000),
            label: "lyss".into(),
            identity: "turn:org".into(),
        }];
        let labels = HashMap::new();
        let f = funding_at(&spans, at, Some("owner:org"), &labels, None);
        assert_eq!(f.identity, "turn:org");
    }

    #[test]
    fn an_open_turn_covers_the_requests_after_its_open() {
        let at = 1_786_601_268_000;
        let spans = vec![Span {
            opened: at - 1000,
            ended: None,
            label: "lyss".into(),
            identity: String::new(),
        }];
        let labels = HashMap::new();
        assert_eq!(funding_at(&spans, at, None, &labels, None).account, "lyss");
        /* and a zero-length row is boundaryless rather than covering the instant */
        let closed = vec![Span {
            opened: at,
            ended: Some(at),
            label: "lyss".into(),
            identity: String::new(),
        }];
        assert_eq!(funding_at(&closed, at, None, &labels, None).account, "unknown");
    }

    /// §4.1: a provider is a sentinel in the account column, and the record's
    /// model stays the alias the CLI sent. A terminal session is not DeepSeek
    /// just because its model looks the same as a provider card's.
    #[test]
    fn a_provider_card_is_named_by_its_sentinel_and_not_by_its_model() {
        assert_eq!(provider_of(Some("@deepseek")), "deepseek");
        assert_eq!(provider_of(Some("@credits")), "claude");
        assert_eq!(provider_of(Some("lyss")), "claude");
        assert_eq!(provider_of(Some("")), "unknown");
        assert_eq!(provider_of(None), "unknown");

        let at = 1_786_601_268_000;
        let deepseek = vec![Span {
            opened: at - 1000,
            ended: Some(at + 1000),
            label: "@deepseek".into(),
            identity: String::new(),
        }];
        let f = funding_at(&deepseek, at, None, &HashMap::new(), None);
        assert_eq!(f.account, "@deepseek");
        assert_eq!(f.provider, "deepseek", "the sentinel, not the alias");

        /* the same model in a terminal session is unknown, never deepseek */
        assert_eq!(source_of("cli", false), "terminal");
        assert_eq!(provider_of(None), "unknown");
    }

    #[test]
    fn a_subagent_is_as_deep_as_its_links_prove() {
        let mut parents: HashMap<(String, String), String> = HashMap::new();
        /* a card spawned `a`; `a` spawned `b`; `b` spawned `c` */
        parents.insert(("s".into(), "a".into()), String::new());
        parents.insert(("s".into(), "b".into()), "a".into());
        parents.insert(("s".into(), "c".into()), "b".into());

        assert_eq!(resolve_agent("s", "", &parents, None), (String::new(), 0));
        assert_eq!(resolve_agent("s", "a", &parents, None), (String::new(), 1));
        assert_eq!(resolve_agent("s", "b", &parents, None), ("a".into(), 2));
        assert_eq!(resolve_agent("s", "c", &parents, None), ("b".into(), 3));
        /* no link anywhere: drawn as a root rather than guessed into the card */
        assert_eq!(resolve_agent("s", "z", &parents, None), (String::new(), 0));
        /* what an earlier pass proved is used when this batch saw no link */
        assert_eq!(
            resolve_agent("s", "z", &parents, Some(("y", 2))),
            ("y".into(), 2)
        );
        /* and a card-spawned agent is recovered from its depth, not from a
           parent id it does not have */
        assert_eq!(
            resolve_agent("s", "z", &parents, Some(("", 1))),
            (String::new(), 1)
        );
    }

    #[test]
    fn a_replaced_file_is_read_from_zero() {
        let mark = Mark {
            offset: 500,
            mtime: 1_000,
            size: 900,
        };
        /* appended to: carry on from where we were */
        assert_eq!(resume_at(Some(&mark), 1200, 2_000), 500);
        /* shorter than the offset: replaced */
        assert_eq!(resume_at(Some(&mark), 100, 2_000), 0);
        /* older last write and a different size: replaced by an old copy */
        assert_eq!(resume_at(Some(&mark), 1000, 900), 0);
        /* the same write we recorded: carry on */
        assert_eq!(resume_at(Some(&mark), 900, 1_000), 500);
        /* never seen: from the beginning */
        assert_eq!(resume_at(None, 900, 1_000), 0);
    }

    #[test]
    fn a_session_records_the_funding_it_started_and_ended_on() {
        let now = SessionNow {
            project: "volery".into(),
            source: "card".into(),
            branch: "main".into(),
            started_at: 100,
            ended_at: 200,
            cli_min: "2.1.9".into(),
            cli_max: "2.1.312".into(),
            account_first: "lyss".into(),
            account_last: "@deepseek".into(),
            provider_first: "claude".into(),
            provider_last: "deepseek".into(),
        };
        let row = merge_session("s", "here", None, &now, None, 3);
        assert_eq!(row.account_first, "lyss");
        assert_eq!(row.account_last, "@deepseek");
        assert_eq!(row.provider_last, "deepseek");
        assert_eq!(row.opened_by, "unknown", "no card behind it");
        assert_eq!(row.turns, 3);

        /* an earlier batch takes the first half, and leaves the last alone */
        let mut earlier = now;
        earlier.started_at = 50;
        earlier.ended_at = 80;
        earlier.account_first = "tx-team".into();
        let old = SessionOld {
            project: "volery".into(),
            source: "card".into(),
            card_id: Some("c1".into()),
            parent_card: None,
            opened_by: "person".into(),
            branch: "main".into(),
            started_at: 100,
            ended_at: Some(200),
            cli_min: Some("2.1.9".into()),
            cli_max: Some("2.1.312".into()),
            account_first: "lyss".into(),
            account_last: "@deepseek".into(),
            provider_first: "claude".into(),
            provider_last: "deepseek".into(),
            turns: 3,
            endings_json: "{}".into(),
        };
        let row = merge_session("s", "here", Some(old), &earlier, None, 1);
        assert_eq!(row.started_at, 50);
        assert_eq!(row.ended_at, 200, "the later end is kept");
        assert_eq!(row.account_first, "tx-team");
        assert_eq!(row.account_last, "@deepseek");
        assert_eq!(row.cli_max, "2.1.312", "the newer version, numerically");
        assert_eq!(row.turns, 3, "a count that only grows");
        assert_eq!(row.card_id.as_deref(), Some("c1"));
    }

    #[test]
    fn a_version_is_compared_as_a_number() {
        assert!(version_less("2.1.99", "2.1.312"));
        assert!(!version_less("2.1.312", "2.1.99"));
        assert!(version_less("2.1.312", "2.2.0"));
        assert!(version_cmp("2.1.312", "2.1.312").is_eq());
    }

    /// A subagent's records carry its own `agentId` and its session's
    /// `sessionId`; the spawning call's result names the child and the caller.
    #[test]
    fn the_spawning_call_names_the_child_and_its_parent() {
        let mut reading = Reading::new(HashMap::new(), 0);
        reading.other(
            r#"{"type":"user","sessionId":"s1","agentId":"parent1",
                "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"child1"}}"#,
        );
        assert_eq!(
            reading.batch.parents.get(&("s1".into(), "child1".into())),
            Some(&"parent1".to_string())
        );
        /* and the owner, from a record with no timestamp */
        reading.other(
            r#"{"type":"session-owner","accountUuid":"a","organizationUuid":"o","sessionId":"s1"}"#,
        );
        assert_eq!(reading.batch.owners.get("s1"), Some(&"a:o".to_string()));
    }

    #[test]
    fn a_session_owner_is_read_once_and_kept() {
        let mut reading = Reading::new(HashMap::new(), 0);
        reading.other(
            r#"{"type":"session-owner","accountUuid":"first","organizationUuid":"o","sessionId":"s"}"#,
        );
        reading.other(
            r#"{"type":"session-owner","accountUuid":"second","organizationUuid":"o","sessionId":"s"}"#,
        );
        assert_eq!(reading.batch.owners.get("s"), Some(&"first:o".to_string()));
    }

    /// §7.2: the offset only ever advances over whole lines, so a half-written
    /// last record is read again rather than lost.
    #[test]
    fn a_file_is_only_consumed_to_its_last_newline() {
        let mut reading = Reading::new(HashMap::new(), 0);
        let path = Path::new("C:\\x\\y.jsonl");
        reading.consumed(path, 100, 5, 200, 100);
        let mark = &reading.batch.files[0].mark;
        assert_eq!(mark.offset, 100);
        assert_eq!(mark.size, 200);
        assert_eq!(reading.batch.bytes, 100);
    }

    /// The same fixture under another session, entrypoint or working directory,
    /// so a test can build a session whose records disagree. A card resumed in a
    /// terminal appends to the same transcript, and a session resumed from
    /// another directory carries a second `cwd`; neither may make the session
    /// row depend on where a chunk boundary fell.
    fn request_with(session: &str, entrypoint: &str, cwd: &str, at: i64, tokens: i64) -> String {
        request(at, "claude-opus-5-5", tokens)
            .replace("\"sessionId\":\"s1\"", &format!("\"sessionId\":\"{session}\""))
            .replace("\"entrypoint\":\"sdk-cli\"", &format!("\"entrypoint\":\"{entrypoint}\""))
            .replace(
                r#""cwd":"C:\\workbench\\volery""#,
                &format!(r#""cwd":"{}""#, cwd.replace('\\', "\\\\")),
            )
    }

    /// The same fixture under another session id, so a test can build two cards
    /// or one whose requests fall either side of a chunk boundary.
    fn request_for(session: &str, at: i64, tokens: i64) -> String {
        request_with(session, "sdk-cli", r"C:\workbench\volery", at, tokens)
    }

    /// One table's rows as text, every column, in a stable order — so two
    /// databases can be compared without a column list per call site.
    fn dump(conn: &Connection, sql: &str, cols: usize) -> Vec<String> {
        let mut stmt = conn.prepare(sql).unwrap();
        stmt.query_map([], |r| {
            let mut out = String::new();
            for i in 0..cols {
                out.push_str(&format!("{:?}|", r.get_ref(i)?));
            }
            Ok(out)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    /// Every row the ingest writes, from the four tables batching could move.
    fn dump_all(conn: &Connection) -> Vec<Vec<String>> {
        vec![
            dump(
                conn,
                "SELECT at, host, session, agent, parent_agent, depth, model, effort, cli,
                        source, account, account_identity, provider, project, provenance,
                        in_tok, out_tok, cache_read, write_5m, write_1h, requests, usd_reported
                   FROM usage_fact
                  ORDER BY at, session, agent, model, source, account, provider, project",
                22,
            ),
            dump(
                conn,
                "SELECT hour, host, account, provider, model, effort, cli, source, project,
                        provenance, in_tok, out_tok, cache_read, write_5m, write_1h, requests,
                        usd_reported
                   FROM usage_hour
                  ORDER BY hour, account, provider, model, source, project",
                17,
            ),
            dump(
                conn,
                "SELECT session, host, project, source, card_id, parent_card, opened_by, branch,
                        started_at, ended_at, cli_min, cli_max, account_first, account_last,
                        provider_first, provider_last, turns, endings_json
                   FROM analytics_session
                  ORDER BY session, host",
                18,
            ),
            dump(conn, "SELECT key, at FROM usage_seen ORDER BY key", 2),
        ]
    }

    /// **The property the chunking must not break.** What ends up in the tables
    /// may not depend on how the batch was cut: the same requests in one
    /// transaction and one at a time have to leave byte-identical rows.
    ///
    /// The fixture is built to break each merge rule the first cut got wrong,
    /// because every one of them is a row that used to depend on the cut:
    ///
    /// - `a`: four records in one five-minute bucket, so a fact key spans chunks
    ///   and its sums must add; and an entrypoint that changes halfway, which is
    ///   what a terminal `--resume` of a card leaves in one transcript.
    /// - `c`: two working directories, so the earlier one must name the session.
    /// - `d`: its earliest record has no `cwd`, so the earliest *naming* record
    ///   must win.
    /// - `priors`: a turn row carries the account identity of the request inside
    ///   it and nothing covers the one after it, so a chunk that read
    ///   `prior_identity` live would fund the second request from the first
    ///   chunk's row while a single transaction would not.
    #[test]
    fn a_chunked_batch_writes_the_same_rows_as_one_transaction() {
        let base = hour_of(now_ms() - 6 * 3_600_000) + 60_000;
        let volery = r"C:\workbench\volery";
        /* (session, entrypoint, cwd, at, tokens). */
        let spec: [(&str, &str, &str, i64, i64); 14] = [
            ("a", "sdk-cli", volery, base, 100),
            ("a", "cli", volery, base + 1_000, 101),
            ("a", "sdk-cli", volery, base + 2_000, 102),
            ("a", "cli", volery, base + 3_000, 103),
            ("b", "sdk-cli", volery, base + BUCKET_MS, 104),
            ("b", "cli", volery, base + 2 * BUCKET_MS, 105),
            ("b", "sdk-cli", volery, base + 3 * BUCKET_MS, 106),
            ("b", "cli", volery, base + 4 * BUCKET_MS, 107),
            ("c", "sdk-cli", r"C:\workbench\alpha", base + 30 * 60_000, 108),
            ("c", "sdk-cli", r"C:\workbench\beta", base + 31 * 60_000, 109),
            ("d", "sdk-cli", "", base + 40 * 60_000, 110),
            ("d", "sdk-cli", r"C:\workbench\gamma", base + 41 * 60_000, 111),
            ("priors", "sdk-cli", volery, base + 50 * 60_000, 112),
            ("priors", "sdk-cli", volery, base + 52 * 60_000, 113),
        ];
        let lines: Vec<String> = spec
            .iter()
            .map(|(s, e, cwd, at, tokens)| request_with(s, e, cwd, *at, *tokens))
            .collect();

        /* The turn row is the only thing that can put an identity on a request
           with no `session-owner` record, which is what `prior_identity` reads
           back. It claims no conversation, so the foreign key is off for this
           insert alone. */
        let inside = base + 50 * 60_000;
        let seeded = || {
            let conn = db();
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            conn.execute(
                "INSERT INTO turn
                   (conversation_id, opened_at, ended_at, status_tier, account_label,
                    account_identity, agent_session_id)
                 VALUES ('priors', ?1, ?2, 'working', 'lyss', 'acct:org', 'priors')",
                params![inside - 1_000, inside + 1_000],
            )
            .unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
            conn
        };

        let one = Mutex::new(seeded());
        flush(&one, "here", &batch(&lines), now_ms(), 4096, None).unwrap();

        let many = Mutex::new(seeded());
        flush(&many, "here", &batch(&lines), now_ms(), 1, None).unwrap();

        let whole = dump_all(&one.lock().unwrap());
        assert_eq!(whole[2].len(), 5, "five sessions, five rows");
        assert_eq!(whole[3].len(), 14, "one dedupe key per request");
        assert_eq!(
            whole,
            dump_all(&many.lock().unwrap()),
            "fourteen chunks wrote the same rows"
        );

        let field = |conn: &Connection, session: &str, column: &str| -> String {
            conn.query_row(
                &format!("SELECT {column} FROM analytics_session WHERE session = ?1"),
                [session],
                |r| r.get(0),
            )
            .unwrap()
        };
        let one = one.lock().unwrap();
        let many = many.lock().unwrap();
        /* Holding both guards is safe: nothing here takes a second one. */
        assert_eq!(
            field(&one, "a", "source"),
            "terminal",
            "the strongest record names the session, not the first one seen"
        );
        assert_eq!(field(&many, "a", "source"), "terminal");
        assert_eq!(
            field(&one, "c", "project"),
            "alpha",
            "the earlier directory names the session"
        );
        assert_eq!(field(&many, "c", "project"), "alpha");
        assert_eq!(
            field(&one, "d", "project"),
            "gamma",
            "a record with no cwd defers to the first that names one"
        );
        assert_eq!(field(&many, "d", "project"), "gamma");

        let funded: i64 = one
            .query_row(
                "SELECT COUNT(*) FROM usage_fact
                  WHERE session = 'priors' AND account_identity = 'acct:org'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            funded, 1,
            "only the request inside the turn is funded by it"
        );
        let funded: i64 = many
            .query_row(
                "SELECT COUNT(*) FROM usage_fact
                  WHERE session = 'priors' AND account_identity = 'acct:org'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(funded, 1, "and a chunk cannot be funded by the one before it");
    }

    /// **§7.2 under chunking.** A pass commits facts a chunk at a time and
    /// advances the offsets only in the tail, so a crash between chunks leaves
    /// the old offset behind. The next pass re-reads from it; `usage_seen` is
    /// what turns that re-read into nothing.
    ///
    /// This drives the shipped `flush` rather than re-cutting the batch by hand,
    /// so a future edit that moved the mark write into the chunk loop fails
    /// here: with two of three chunks committed there would be an offset for the
    /// file and the re-read would start past requests nothing had written.
    #[test]
    fn a_pass_that_dies_between_chunks_counts_nothing_twice() {
        let base = hour_of(now_ms() - 6 * 3_600_000) + 60_000;
        let lines: Vec<String> = (0..9)
            .map(|i| request_for(&format!("s{i}"), base + i as i64 * BUCKET_MS, 1000))
            .collect();
        let mut reading = Reading::new(HashMap::new(), 0);
        for line in &lines {
            reading.request(&record(line));
        }
        /* A file the walk finished reading; its mark is the tail's to write. */
        let path = Path::new("C:\\t\\s.jsonl");
        reading.consumed(path, 100, 5, 200, 100);
        let whole = reading.into_batch();
        let now = now_ms();
        let conns = Mutex::new(db());

        /* Two of three chunks commit, then the process dies: the loop returns
           before the third chunk and before the tail. */
        flush(&conns, "here", &whole, now, 3, Some(2)).unwrap();
        {
            let conn = conns.lock().unwrap();
            let committed: i64 = conn
                .query_row("SELECT COUNT(*) FROM usage_fact", [], |r| r.get(0))
                .unwrap();
            assert_eq!(committed, 6, "two chunks of three are durable");
            let marks: i64 = conn
                .query_row("SELECT COUNT(*) FROM usage_file", [], |r| r.get(0))
                .unwrap();
            assert_eq!(marks, 0, "and no offset moved, so a re-read starts at zero");
        }

        /* The next pass: the same batch, from the old marks. */
        let again = flush(&conns, "here", &whole, now, 3, None).unwrap();
        assert_eq!(again.requests, 3, "only the third chunk was new");
        assert_eq!(again.duplicates, 6, "the committed chunks were recognised");

        let conn = conns.lock().unwrap();
        let facts: (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), SUM(requests), SUM(in_tok) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(facts, (9, 9, 9000), "each request counted exactly once");
        let seen: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_seen", [], |r| r.get(0))
            .unwrap();
        assert_eq!(seen, 9);
        let mark: (i64, i64) = conn
            .query_row(
                "SELECT offset, size FROM usage_file WHERE path = ?1",
                ["C:\\t\\s.jsonl"],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(mark, (100, 200), "and the tail advanced the offset");
    }

    /// **Sessions outlive a chunk.** `merge_session` is an upsert, so the
    /// second chunk's share of a card folds into the row the first wrote: one
    /// row, spanning the whole session's times, with every request in it.
    #[test]
    fn a_session_split_across_chunks_keeps_one_row() {
        let base = hour_of(now_ms() - 6 * 3_600_000) + 60_000;
        let lines: Vec<String> = (0..4)
            .map(|i| request_for("split", base + i as i64 * BUCKET_MS, 100))
            .collect();
        let conns = Mutex::new(db());
        /* Two requests a chunk: the session has rows in both transactions. */
        flush(&conns, "here", &batch(&lines), now_ms(), 2, None).unwrap();

        let conn = conns.lock().unwrap();
        let row: (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MIN(started_at), MAX(ended_at)
                   FROM analytics_session WHERE session = 'split'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (1, base, base + 3 * BUCKET_MS), "one row, the whole span");

        let totals: (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), SUM(requests), SUM(in_tok)
                   FROM usage_fact WHERE session = 'split'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(totals, (4, 4, 400), "and both chunks' requests are in it");
    }

    /* ── prompt facts (§3.8, phase 5a) ───────────────────────────────────── */

    /// A `user` record as the CLI writes one, with the text escaped by the JSON
    /// writer rather than by hand: a fixture that escapes its own prompt is a
    /// fixture that tests the escaping as well.
    fn prompt_line(id: &str, at: i64, session: &str, said: &str) -> String {
        format!(
            r#"{{"type":"user","promptId":"{id}","sessionId":"{session}","timestamp":"{}",
                "entrypoint":"sdk-cli","cwd":"C:\\workbench\\volery",
                "message":{{"content":{}}}}}"#,
            stamp(at),
            serde_json::to_string(said).unwrap(),
        )
    }

    /// A batch built the way the walk builds one, against a transcript path
    /// that does not exist. That is deliberate: with no vault every body is
    /// `locked` and what this writes is a locator, and a locator may point at a
    /// file that has since gone — the shape §3.8 says must keep its form.
    fn prompt_batch(lines: &[String], cutoff: i64) -> Batch {
        let mut reading = Reading::new(HashMap::new(), cutoff);
        let path = std::path::PathBuf::from("C:\\t\\s.jsonl");
        let mut off = 0u64;
        for line in lines {
            reading.prompt(&path, off, line);
            off += line.len() as u64 + 1;
        }
        reading.into_batch()
    }

    /// The same batch, with a vault that is open, so the ingest seals.
    fn prompt_batch_sealed(lines: &[String], vault: &crate::promptvault::PromptVault) -> Batch {
        let mut reading =
            Reading::new(HashMap::new(), 0).with_vault("home", vault.clone());
        let path = std::path::PathBuf::from("C:\\t\\s.jsonl");
        let mut off = 0u64;
        for line in lines {
            reading.prompt(&path, off, line);
            off += line.len() as u64 + 1;
        }
        reading.into_batch()
    }

    /// Every value in every table, rendered as text. The blunt instrument the
    /// next test needs: "this sentence is nowhere in the store" cannot be
    /// asserted column by column without listing the columns a later lane will
    /// add, which is exactly what such an assertion must not depend on.
    fn every_value(conn: &Connection) -> String {
        use rusqlite::types::ValueRef;
        let mut out = String::new();
        let tables: Vec<String> = {
            let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            else {
                return out;
            };
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
            rows.filter_map(Result::ok).collect()
        };
        for t in tables {
            let Ok(mut stmt) = conn.prepare(&format!("SELECT * FROM \"{t}\"")) else {
                continue;
            };
            let cols = stmt.column_count();
            let Ok(mut rows) = stmt.query([]) else { continue };
            while let Ok(Some(row)) = rows.next() {
                for i in 0..cols {
                    let Ok(v) = row.get_ref(i) else { continue };
                    if let ValueRef::Text(b) | ValueRef::Blob(b) = v {
                        out.push_str(&String::from_utf8_lossy(b));
                    }
                    out.push('\u{1f}');
                }
            }
        }
        out
    }

    /// **The hard rule of this lane, on a wall with no key.** The form and the
    /// counts are kept, no body is written, and the line is remembered by a
    /// locator so it can be sealed once there is a vault.
    ///
    /// The prompt below carries a fake key on purpose: the assertion is not
    /// only that the text is absent, but that the redactor *ran* and said so,
    /// because a row claiming `redactions = 0` is a row claiming a prompt was
    /// clean.
    #[test]
    fn a_locked_prompt_row_carries_its_counts_and_a_locator() {
        let now = 1_786_601_268_000;
        let said = "the deploy key is sk-live-9fK2mQ7tR4vX1zL8nB6wY3pA and it is wrong";
        let conns = Mutex::new(db());
        let counts = write(
            &conns,
            "home",
            &prompt_batch(&[prompt_line("p1", now, "s1", said)], 0),
            now + 1_000,
        )
        .unwrap();
        assert_eq!(counts.prompts, 1);

        let conn = conns.lock().unwrap();
        let (state, sealed, truncated, redactions, words): (
            String,
            Option<Vec<u8>>,
            i64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT body_state, body_sealed, body_truncated, redactions, words
                   FROM prompt_fact WHERE prompt_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(state, "locked", "a wall with no key wrote something else");
        assert!(sealed.is_none(), "a body reached a row that had no key to seal it");
        assert_eq!(truncated, 0);
        assert_eq!(redactions, 1, "the redactor did not run, or did not count");
        assert_eq!(words, 9, "the words were counted off the raw text");
        let (path, off): (String, i64) = conn
            .query_row(
                "SELECT path, off FROM prompt_locator WHERE prompt_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(path, "C:\\t\\s.jsonl");
        assert_eq!(off, 0);

        /* And the sentence itself is in no table at all. */
        let everything = every_value(&conn);
        assert!(
            !everything.contains("deploy key"),
            "the prompt's own words reached the store"
        );
        assert!(
            !everything.contains("9fK2mQ7tR4vX1zL8nB6wY3pA"),
            "the secret reached the store"
        );
    }

    /// **The same row with a key in hand**: the redacted body is sealed, the
    /// row names the vault that sealed it, and there is no locator because
    /// there is nothing left to find. The words are in no table, and what opens
    /// is the redacted text rather than the secret.
    #[test]
    fn an_unlocked_ingest_seals_the_redacted_body() {
        let now = 1_786_601_268_000;
        let said = "the deploy key is sk-live-9fK2mQ7tR4vX1zL8nB6wY3pA and it is wrong";
        let vault = crate::promptvault::PromptVault::default();
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            crate::promptvault::create(&conn, "correct horse battery".into(), &vault).unwrap();
        }
        let counts = write(
            &conns,
            "home",
            &prompt_batch_sealed(&[prompt_line("p1", now, "s1", said)], &vault),
            now + 1_000,
        )
        .unwrap();
        assert_eq!(counts.prompts, 1);

        let conn = conns.lock().unwrap();
        let (state, vault_id, blob): (String, String, Vec<u8>) = conn
            .query_row(
                "SELECT body_state, vault_id, body_sealed
                   FROM prompt_fact WHERE prompt_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "sealed");
        assert!(!vault_id.is_empty(), "a sealed body names no vault");
        let locators: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
            .unwrap();
        assert_eq!(locators, 0, "a sealed body wrote a locator");

        let text = vault
            .open_body(&vault_id, "home", "s1", "p1", now, &blob)
            .unwrap();
        assert!(
            !text.contains("9fK2mQ7tR4vX1zL8nB6wY3pA"),
            "the secret was sealed alongside the prompt"
        );
        assert!(
            text.contains("deploy key"),
            "the ordinary words were lost with the secret: {}",
            &*text
        );
        drop(conn);

        let everything = every_value(&conns.lock().unwrap());
        assert!(
            !everything.contains("deploy key"),
            "the prompt's own words reached a table unsealed"
        );
    }

    /// **A gesture that lands between the seal and the write wins.**
    ///
    /// The walk seals a prompt as it reads the line and writes the batch a
    /// moment later, so `forget prompts` and `reset vault` can commit in
    /// between. The row is then written `deleted`: the form is kept, the body is
    /// not, there is no locator, and the gesture means what it said. `locked`
    /// would be the wrong answer even though it is recoverable, because a
    /// locator is exactly what `seal pending` would use to put the body back.
    #[test]
    fn a_body_sealed_before_a_forget_is_written_deleted() {
        let now = 1_786_601_268_000;
        let vault = crate::promptvault::PromptVault::default();
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            crate::promptvault::create(&conn, "correct horse battery".into(), &vault).unwrap();
        }
        /* Sealed while the vault was open: this is the body the race is about. */
        let batch = prompt_batch_sealed(&[prompt_line("p1", now, "s1", "add a thing")], &vault);
        let sealed_at_ingest = batch.prompts[0].body.state;
        assert_eq!(sealed_at_ingest, "sealed", "the fixture did not seal");

        {
            let conn = conns.lock().unwrap();
            crate::promptvault::forget(&conn).unwrap();
        }
        write(&conns, "home", &batch, now + 1_000).unwrap();

        let conn = conns.lock().unwrap();
        let (state, blob): (String, Option<Vec<u8>>) = conn
            .query_row(
                "SELECT body_state, body_sealed FROM prompt_fact WHERE prompt_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, "deleted", "a body landed behind the forget");
        assert!(blob.is_none());
        let locators: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_locator", [], |r| r.get(0))
            .unwrap();
        assert_eq!(locators, 0, "a locator would let seal pending put the body back");
        let stamp: i64 = conn
            .query_row("SELECT COUNT(*) FROM prompt_forget", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamp, 1, "the forget left no stamp for a running pass to read");
    }

    /// The other half of the window: a reset deletes the vault record, so a body
    /// sealed a moment earlier names a key nobody has. It is the same stamp, so
    /// the same answer.
    #[test]
    fn a_body_sealed_before_a_reset_is_written_deleted() {
        let now = 1_786_601_268_000;
        let vault = crate::promptvault::PromptVault::default();
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            crate::promptvault::create(&conn, "correct horse battery".into(), &vault).unwrap();
        }
        let batch = prompt_batch_sealed(&[prompt_line("p1", now, "s1", "add a thing")], &vault);
        {
            let conn = conns.lock().unwrap();
            crate::promptvault::reset(&conn, &vault, true).unwrap();
        }
        write(&conns, "home", &batch, now + 1_000).unwrap();

        let conn = conns.lock().unwrap();
        let (state, vault_id, blob): (String, String, Option<Vec<u8>>) = conn
            .query_row(
                "SELECT body_state, vault_id, body_sealed
                   FROM prompt_fact WHERE prompt_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, "deleted", "a body landed naming a vault that no longer exists");
        assert!(vault_id.is_empty());
        assert!(blob.is_none());
    }

    /// §3.8's replay rule: an id seen twice is one row at the **first** stamp,
    /// with `seen_count` carrying the repeat, and the hourly rollup counts it
    /// once. A row that moved its `at` to the replay's would leave the hour it
    /// counted in naming a time the fact no longer sits at.
    #[test]
    fn a_repeated_prompt_keeps_the_first_at_and_counts_the_replay() {
        let first = 1_786_601_268_000;
        let conns = Mutex::new(db());
        write(
            &conns,
            "home",
            &prompt_batch(&[prompt_line("p1", first, "s1", "continue")], 0),
            first + 1_000,
        )
        .unwrap();
        let again = write(
            &conns,
            "home",
            &prompt_batch(&[prompt_line("p1", first + 60_000, "s1", "continue")], 0),
            first + 61_000,
        )
        .unwrap();
        assert_eq!(again.prompts, 0, "the replay wrote no second fact");
        assert_eq!(again.prompt_duplicates, 1);

        let conn = conns.lock().unwrap();
        let (rows, seen, at): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(seen_count), MIN(at) FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(rows, 1);
        assert_eq!(seen, 2);
        assert_eq!(at, first, "the row kept the first time it was said");

        let prompts: i64 = conn
            .query_row("SELECT SUM(prompts) FROM prompt_hour", [], |r| r.get(0))
            .unwrap();
        assert_eq!(prompts, 1, "a replay must not be counted twice in the rollup");
    }

    /// And the other side of that rule: **a re-read of the same bytes is not a
    /// replay.** The offsets advance only in `write_tail`, so a pass that dies
    /// after a chunk reads the same lines again, and the column means how many
    /// records carried the id rather than how many times this wall looked.
    #[test]
    fn a_re_read_of_the_same_bytes_does_not_bump_seen_count() {
        let at = 1_786_601_268_000;
        let conns = Mutex::new(db());
        let line = prompt_line("p1", at, "s1", "continue");
        write(&conns, "home", &prompt_batch(&[line.clone()], 0), at + 1_000).unwrap();
        let again =
            write(&conns, "home", &prompt_batch(&[line], 0), at + 2_000).unwrap();
        assert_eq!(again.prompts, 0, "the re-read wrote no second fact");
        assert_eq!(
            again.prompt_duplicates, 0,
            "a re-read was counted as a record offered twice"
        );

        let conn = conns.lock().unwrap();
        let (rows, seen): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(seen_count) FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, seen), (1, 1), "one record, seen once");
    }

    /// A replay inside **one** pass, which is the case the batch's own dedupe
    /// would otherwise drop: two records, one id, two stamps, and the first
    /// stamp is the row's.
    #[test]
    fn a_replay_inside_one_batch_bumps_seen_count() {
        let at = 1_786_601_268_000;
        let conns = Mutex::new(db());
        let counts = write(
            &conns,
            "home",
            &prompt_batch(
                &[
                    prompt_line("p1", at, "s1", "continue"),
                    prompt_line("p1", at + 30_000, "s2", "continue"),
                ],
                0,
            ),
            at + 60_000,
        )
        .unwrap();
        assert_eq!(counts.prompts, 1);
        assert_eq!(counts.prompt_duplicates, 1);

        let conn = conns.lock().unwrap();
        let (seen, first): (i64, i64) = conn
            .query_row("SELECT seen_count, at FROM prompt_fact", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((seen, first), (2, at));
    }

    /// The rollup is the sum of its facts, the five word bands are exclusive and
    /// exhaustive, and a prompt with a fence keeps the lines and fences the fold
    /// went to the trouble of not flattening.
    #[test]
    fn the_prompt_hour_is_the_sum_of_its_facts() {
        let at = 1_786_601_268_000;
        let conns = Mutex::new(db());
        let lines = vec![
            prompt_line("p1", at, "s1", "add the redact module beside the ingest"),
            prompt_line(
                "p2",
                at + 60_000,
                "s1",
                "draw a box:\n```rust\nfn main() {}\nfn b() {}\n```\nwhy is it wrong?",
            ),
        ];
        write(&conns, "home", &prompt_batch(&lines, 0), at + 120_000).unwrap();

        let conn = conns.lock().unwrap();
        let facts: (i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(words), SUM(chars), SUM(lines), SUM(fences), SUM(code_lines)
                   FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(facts.3, 1, "one fenced block");
        assert_eq!(facts.4, 2, "two lines of code inside it");

        let hour: (i64, i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), SUM(prompts), SUM(words), SUM(chars), SUM(fences),
                        SUM(code_lines)
                   FROM prompt_hour",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        /* **Two rows, and that is the key rather than a bug.** `prompt_hour` is
           keyed on the kind as well, and these two fixtures classify apart (one
           opens with an imperative, the other ends in a question mark), which is
           the dimension existing for exactly the reading it enables: the mix.
           Every sum below is over rows, so it does not care how they were cut. */
        assert_eq!(hour.0, 2, "two kinds are two rows");
        assert_eq!(
            (hour.1, hour.2, hour.3, hour.4, hour.5),
            (2, facts.0, facts.1, facts.3, facts.4),
            "the rollup is the sum of its facts"
        );

        let bands: (i64, i64) = conn
            .query_row(
                "SELECT SUM(words_under_16 + words_under_64 + words_under_256 +
                            words_under_1024 + words_over_1024), SUM(prompts)
                   FROM prompt_hour",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(bands.0, bands.1, "the five bands must sum to the prompt count");
        /* And per row, which is the assertion a third band added without its
           neighbour changed would fail. */
        let ragged: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM prompt_hour
                  WHERE words_under_16 + words_under_64 + words_under_256 +
                        words_under_1024 + words_over_1024 <> prompts",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ragged, 0, "a row whose bands do not sum to its prompts");
    }

    /// A prompt is dated by when it was said, which is inside the turn it
    /// opened, so §4's ladder answers on its first rung with no second rule for
    /// prompts to remember.
    #[test]
    fn a_prompt_is_funded_by_the_turn_it_opened() {
        use rusqlite::params;
        let at = 1_786_601_268_000;
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
            conn.execute(
                "INSERT INTO turn
                   (conversation_id, opened_at, ended_at, status_tier, account_label,
                    account_identity, agent_session_id)
                 VALUES ('c', ?1, ?2, 'working', 'work', 'acct:org', 's1')",
                params![at - 1_000, at + 600_000],
            )
            .unwrap();
            conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        }
        write(
            &conns,
            "home",
            &prompt_batch(&[prompt_line("p1", at, "s1", "add a thing")], 0),
            at + 1_000,
        )
        .unwrap();

        let conn = conns.lock().unwrap();
        let (account, provider, source, project): (String, String, String, String) = conn
            .query_row(
                "SELECT account, provider, source, project FROM prompt_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(account, "work");
        assert_eq!(provider, "claude");
        assert_eq!(source, "unknown", "an sdk-cli session with no card behind it");
        assert_eq!(project, "volery", "the working directory's last segment");
    }

    /// The prompt half of the chunking's property: the tables may not depend on
    /// how the batch was cut, and a prompt id that spans two transactions must
    /// still be one row counted in one hour.
    #[test]
    fn a_chunked_prompt_batch_writes_the_same_rows_as_one_transaction() {
        let at = 1_786_601_268_000;
        let lines: Vec<String> = (0..4)
            .map(|i| prompt_line(&format!("p{i}"), at + i * 1_000, "s1", "add a thing"))
            .collect();
        let now = at + 120_000;

        let one = Mutex::new(db());
        flush(&one, "home", &prompt_batch(&lines, 0), now, 4096, None).unwrap();
        let many = Mutex::new(db());
        flush(&many, "home", &prompt_batch(&lines, 0), now, 1, None).unwrap();

        let dump = |conn: &Connection| -> Vec<Vec<String>> {
            vec![
                dump(
                    conn,
                    "SELECT host, prompt_id, at, hour, seen_count, session, source, account,
                            provider, kind, chars, words, lines, fences, code_lines, images,
                            questions, redactions, withheld, body_state
                       FROM prompt_fact ORDER BY prompt_id",
                    20,
                ),
                dump(
                    conn,
                    "SELECT hour, host, account, provider, project, source, kind, prompts, chars,
                            words, lines, code_lines, questions, fences, images, redactions,
                            withheld, words_under_16, words_under_64, words_under_256,
                            words_under_1024, words_over_1024
                       FROM prompt_hour",
                    22,
                ),
            ]
        };
        assert_eq!(
            dump(&one.lock().unwrap()),
            dump(&many.lock().unwrap()),
            "four chunks wrote the same rows as one transaction"
        );
        assert_eq!(dump(&many.lock().unwrap())[0].len(), 4, "four facts");
    }

    /// A window is a range the caller names, and a range that ends before it
    /// starts is refused rather than answered empty: the same rule
    /// `analytics_window` keeps one table over.
    #[test]
    fn a_prompt_window_is_read_and_a_backwards_one_is_refused() {
        let conn = db();
        let at = 1_786_601_268_000;
        assert!(prompt_rows(&conn, at, at).is_err());
        assert!(prompt_rows(&conn, at, at - 1).is_err());

        let conns = Mutex::new(conn);
        write(
            &conns,
            "home",
            &prompt_batch(&[prompt_line("p1", at, "s1", "continue")], 0),
            at + 1_000,
        )
        .unwrap();
        let conn = conns.lock().unwrap();
        let rows = prompt_rows(&conn, at - 1, at + 1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].prompt_id, "p1");
        assert_eq!(rows[0].body_state, "locked");
        assert!(prompt_rows(&conn, at + 1, at + 2).unwrap().is_empty());
    }

    /* ── tools and work (§3.7, §3.9; phase 6a) ───────────────────────────── */

    /* The fixtures are transcript lines, not structs, so a test exercises the
       parser the walk actually calls. */

    fn call_line(id: &str, at: i64, session: &str, name: &str, input: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"u-{id}","timestamp":"{stamp}","sessionId":"{session}",
                "message":{{"model":"claude-opus-5-5","content":[
                  {{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}]}}}}"#,
            stamp = stamp(at),
        )
    }

    fn agent_call_line(id: &str, at: i64, session: &str, agent: &str, name: &str, input: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"u-{id}","timestamp":"{stamp}","sessionId":"{session}",
                "agentId":"{agent}",
                "message":{{"model":"claude-opus-5-5","content":[
                  {{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}]}}}}"#,
            stamp = stamp(at),
        )
    }

    fn result_line(id: &str, at: i64, session: &str, content: &str, is_error: bool) -> String {
        let content = serde_json::to_string(content).unwrap();
        let flag = if is_error { "true" } else { "false" };
        format!(
            r#"{{"type":"user","uuid":"r-{id}","timestamp":"{stamp}","sessionId":"{session}",
                "cwd":"C:\\workbench\\volery","gitBranch":"main",
                "message":{{"role":"user","content":[
                  {{"type":"tool_result","tool_use_id":"{id}","is_error":{flag},"content":{content}}}]}},
                "toolUseResult":{{"stdout":{content},"stderr":"","interrupted":false}}}}"#,
            stamp = stamp(at),
        )
    }

    fn seed(conn: &Connection, session: &str) -> String {
        conn.execute(
            "INSERT OR IGNORE INTO project (id, name, root_path, created_at)
             VALUES ('p1', 'volery', 'C:/x', 0)",
            [],
        )
        .unwrap();
        let id = format!("card-{session}");
        conn.execute(
            "INSERT OR IGNORE INTO conversation
               (id, agent_session_id, project_id, cwd, branch, born_at)
             VALUES (?1, ?2, 'p1', 'C:/x', 'main', 0)",
            params![id, session],
        )
        .unwrap();
        id
    }

    fn settled_turn(conn: &Connection, card: &str, session: &str, opened: i64, ended: i64, usd: f64) -> i64 {
        conn.execute(
            "INSERT INTO turn (conversation_id, opened_at, ended_at, status_tier, usd, agent_session_id)
             VALUES (?1, ?2, ?3, 'done', ?4, ?5)",
            params![card, opened, ended, usd, session],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// One call and one result, written through the same sink and writer the
    /// live pass uses, then folded.
    fn tool_batch(lines: &[String]) -> Batch {
        let mut reading = Reading::new(HashMap::new(), 0);
        for line in lines {
            reading.tools(line);
        }
        reading.into_batch()
    }

    fn tool_facts(conn: &Connection) -> Vec<(i64, String, i64, i64, i64, i64, f64)> {
        let mut stmt = conn
            .prepare(
                "SELECT turn_id, tool, calls, errors, ms_total, out_bytes, turn_usd
                   FROM tool_fact ORDER BY tool",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
    }

    #[test]
    fn a_tool_name_is_reduced_to_the_dimensions_the_fact_has() {
        let mcp = classify_tool("mcp__browser__browser_click", None);
        assert_eq!((mcp.kind, mcp.server.as_str(), mcp.tool.as_str()), ("mcp", "browser", "browser_click"));
        assert!(classify_tool("mcp__skein__ask_user", None).server == "skein");

        let input: serde_json::Value =
            serde_json::from_str(r#"{"skill":"tx-toolkit:committee","args":"x"}"#).unwrap();
        let skill = classify_tool("Skill", Some(&input));
        assert_eq!((skill.kind, skill.tool.as_str(), skill.target.as_str()), ("skill", "Skill", "tx-toolkit:committee"));

        let input: serde_json::Value =
            serde_json::from_str(r#"{"subagent_type":"scout","model":"opus","run_in_background":true}"#).unwrap();
        let agent = classify_tool("Agent", Some(&input));
        assert_eq!((agent.kind, agent.target.as_str(), agent.requested_model.as_str()), ("agent", "scout", "opus"));
        assert!(agent.receipt, "a background agent's result is a receipt");

        let bash = classify_tool("Bash", None);
        assert_eq!(bash.kind, "builtin");
        assert!(!bash.receipt, "a foreground shell is work");
        assert!(classify_tool("Workflow", None).receipt);
        assert!(classify_tool("Monitor", None).receipt);
    }

    #[test]
    fn a_result_keeps_its_size_and_never_its_content() {
        let at = 1_786_601_268_000;
        let line = result_line("t1", at, "s1", "the answer is 42", false);
        let parsed = parse_tool_result(&line).remove(0);
        assert_eq!(parsed.result.id, "t1");
        assert_eq!(parsed.result.out_bytes, 16);
        assert_eq!(parsed.result.errors, 0);

        let failed = result_line("t2", at, "s1", "no such file", true);
        assert_eq!(parse_tool_result(&failed)[0].result.errors, 1);

        /* A result in block form sums the blocks' text; the content is gone by
           the time the struct exists. */
        let blocks = format!(
            r#"{{"type":"user","timestamp":"{}","sessionId":"s1",
                 "message":{{"content":[{{"type":"tool_result","tool_use_id":"t3",
                   "content":[{{"type":"text","text":"abc"}},{{"type":"text","text":"de"}}]}}]}}}}"#,
            stamp(at)
        );
        assert_eq!(parse_tool_result(&blocks)[0].result.out_bytes, 5);

        /* Two results in one record are two results, each with its own id. */
        let pair = format!(
            r#"{{"type":"user","timestamp":"{}","sessionId":"s1",
                 "message":{{"content":[
                   {{"type":"tool_result","tool_use_id":"t4","content":"aa"}},
                   {{"type":"tool_result","tool_use_id":"t5","is_error":true,"content":"bbb"}}]}}}}"#,
            stamp(at)
        );
        let parsed = parse_tool_result(&pair);
        assert_eq!(parsed.len(), 2);
        assert_eq!((parsed[0].result.id.as_str(), parsed[0].result.out_bytes), ("t4", 2));
        assert_eq!((parsed[1].result.id.as_str(), parsed[1].result.errors), ("t5", 1));
    }

    #[test]
    fn a_commit_receipt_parses_branch_and_sha() {
        let op: serde_json::Value = serde_json::from_str(
            r#"{"commit":{"sha":"8adbaaa","kind":"committed","branch":"main"}}"#,
        )
        .unwrap();
        let receipts = parse_receipts("nothing printed", Some(&op));
        assert_eq!(
            receipts,
            vec![ParsedReceipt { kind: "commit", reference: "8adbaaa".into(), conflict_files: 0 }]
        );

        /* And the printed line is the fallback when the summary is absent. */
        let printed = parse_receipts("[main 8adbaaa] skein: a thing\n 2 files changed", None);
        assert!(printed.iter().any(|r| r.kind == "commit" && r.reference == "8adbaaa"));

        /* Two tools in one afternoon do not make a receipt out of prose. */
        assert!(parse_receipts("read about [main abc1234] in a doc", None)
            .iter()
            .all(|r| r.kind != "commit"));
    }

    #[test]
    fn a_pr_receipt_names_its_number() {
        let opened = parse_receipts(
            "https://github.com/lagardere/volery/pull/412\n",
            None,
        );
        assert_eq!(
            opened,
            vec![ParsedReceipt { kind: "pr_open", reference: "412".into(), conflict_files: 0 }]
        );

        let merged = parse_receipts("✓ Merged pull request #412 (a feature)", None);
        assert!(merged.iter().any(|r| r.kind == "pr_merge" && r.reference == "412"));
    }

    #[test]
    fn a_conflict_names_its_paths() {
        let text = "Auto-merging src/lib/a.ts\n\
                    CONFLICT (content): Merge conflict in src/lib/a.ts\n\
                    CONFLICT (modify/delete): src/lib/b.ts deleted in HEAD and modified in main\n\
                    Automatic merge failed; fix conflicts and then commit the result.";
        let op: serde_json::Value =
            serde_json::from_str(r#"{"branch":{"ref":"main","action":"merged"}}"#).unwrap();
        let receipts = parse_receipts(text, Some(&op));
        let conflict = receipts.iter().find(|r| r.kind == "conflict").unwrap();
        assert_eq!(conflict.conflict_files, 2, "one per path, normalised");
        assert!(receipts.iter().any(|r| r.kind == "merge" && r.reference == "main"));
    }

    #[test]
    fn a_history_commit_carries_its_numstat_and_parents() {
        let text = "\u{1e}abc123\u{1f}p1 p2\u{1f}1760000000\n\
                    12\t3\tsrc/lib/a.ts\n\
                    -\t-\tassets/logo.png\n\
                    \u{1e}def456\u{1f}abc123\u{1f}1760000100\n\
                    1\t1\tsrc/lib/b.ts\n";
        let commits = parse_numstat_log(text);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].sha, "abc123");
        assert_eq!(commits[0].parents, vec!["p1", "p2"], "a merge has two");
        assert_eq!(commits[0].at, 1_760_000_000_000, "seconds become milliseconds");
        assert_eq!((commits[0].files, commits[0].added, commits[0].removed), (2, 12, 3));
        assert_eq!(commits[0].paths, vec!["src/lib/a.ts", "assets/logo.png"]);
        assert_eq!(commits[1].parents, vec!["abc123"]);
    }

    #[test]
    fn a_call_and_result_resolve_once() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.25);
        }
        let call = call_line("t1", opened + 1_000, "s1", "Bash", r#"{"command":"ls"}"#);
        let result = result_line("t1", opened + 1_450, "s1", "a b c", true);
        let batch = tool_batch(&[call, result]);
        write(&conns, "home", &batch, now).unwrap();

        /* A second result for the same call changes nothing: the first one
           resolved it, and the `resolved_at IS NULL` guard is what says so. */
        let late = result_line("t1", opened + 9_000, "s1", "a much longer late answer", false);
        write(&conns, "home", &tool_batch(&[late]), now).unwrap();

        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let facts = tool_facts(&conn);
        assert_eq!(facts.len(), 1);
        let (turn_id, tool, calls, errors, ms, out_bytes, usd) = facts[0].clone();
        assert_eq!(tool, "Bash");
        assert_eq!((calls, errors, ms, out_bytes), (1, 1, 450, 5), "the first result, not the late one");
        assert!((usd - 0.25).abs() < 1e-12, "one call takes the whole turn");
        assert!(turn_id > 0);
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM tool_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "the folded row is deleted");
        let marked: i64 = conn
            .query_row("SELECT COUNT(*) FROM analytics_fold WHERE turn_id = ?1", [turn_id], |r| r.get(0))
            .unwrap();
        assert_eq!(marked, 1);
    }

    /// The page reads the rollup at every span, because the fine tier is
    /// pruned at ninety days and this one is kept: it has to carry the bands
    /// and the dollars the percentile and the cost column are computed from,
    /// and the read has to sum them across hours or a year is refused for a
    /// payload nobody draws. **Two calls in two different hours**, because one
    /// row would pass with no `GROUP BY` at all.
    #[test]
    fn the_rollup_sums_its_hours_and_carries_the_bands() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        let old_opened = now - 4 * 60 * 60 * 1000;
        let old_ended = now - 3 * 60 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.25);
            settled_turn(&conn, &card, "s1", old_opened, old_ended, 0.5);
        }
        let call = call_line("t1", opened + 1_000, "s1", "Bash", r#"{"command":"ls"}"#);
        let result = result_line("t1", opened + 1_450, "s1", "a b c", true);
        let older_call = call_line("t2", old_opened + 1_000, "s1", "Bash", r#"{"command":"pwd"}"#);
        let older_result = result_line("t2", old_opened + 1_200, "s1", "ok", false);
        write(
            &conns,
            "home",
            &tool_batch(&[call, result, older_call, older_result]),
            now,
        )
        .unwrap();
        fold_tools(&conns, "home", now).unwrap();

        let conn = conns.lock().unwrap();
        let rows = tool_total_rows(&conn, now - 86_400_000, now + 1).unwrap();
        assert_eq!(rows.len(), 1, "one tool, one row, whatever the hour count");
        let row = &rows[0];
        assert_eq!((row.kind.as_str(), row.tool.as_str()), ("builtin", "Bash"));
        assert_eq!((row.calls, row.errors, row.out_bytes), (2, 1, 7), "both hours, summed");
        /* 450ms lands in the 200ms-1s band and 200ms in the same one, which is
           what makes the five counts a distribution rather than five totals. */
        assert_eq!(
            (row.ms_under_50, row.ms_under_200, row.ms_under_1s, row.ms_under_5s, row.ms_over_5s),
            (0, 0, 2, 0, 0)
        );
        assert!((row.turn_usd - 0.75).abs() < 1e-12, "both turns' apportioned cost");
    }

    /// A session row is what says who opened a card and what it spent on, and
    /// the reader must keep the three states of `opened_by` apart: a session
    /// with no lineage record is `unknown`, never *person* (§9.7).
    #[test]
    fn a_session_fact_keeps_its_opener_and_its_overlap() {
        let conn = db();
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, parent_card, opened_by, branch,
                started_at, ended_at, account_first, account_last, provider_first,
                provider_last, turns)
             VALUES ('s1', 'home', 'volery', 'card', 'c1', '', 'person', 'main',
                     1000, 9000, 'lyss', 'tx-team', 'anthropic', 'anthropic', 3),
                    ('s2', 'home', 'volery', 'card', '', '', 'agent', 'main',
                     2000, NULL, 'lyss', 'lyss', 'anthropic', 'deepseek', 1)",
            [],
        )
        .unwrap();
        /* The window starts after both sessions did and ends before the open
           one ends: both overlap it, and one that merely *started* before it
           must not be dropped. */
        let rows = session_fact_rows(&conn, 5_000, 7_000).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows.iter().find(|r| r.session == "s1").unwrap();
        assert_eq!((first.opened_by.as_str(), first.card.as_str()), ("person", "c1"));
        assert_eq!(first.turns, 3);
        assert_eq!(first.ended_at, Some(9_000));
        let open = rows.iter().find(|r| r.session == "s2").unwrap();
        assert_eq!(open.ended_at, None, "an open session travels as no end, not a made-up one");
        assert_eq!((open.provider_first.as_str(), open.provider_last.as_str()), ("anthropic", "deepseek"));
        assert!(session_fact_rows(&conn, 7_000, 5_000).is_err(), "a backwards window is refused");
    }

    /// A card's page reads four things that must not leak into each other: its
    /// own sessions (not another card's), its own spend grouped by who paid,
    /// its own moves (not the writes beside them, not attributed excess), and
    /// its settled turns only.
    #[test]
    fn a_cards_life_is_its_own_sessions_spend_moves_and_reported_cost() {
        let conn = db();
        let card = seed(&conn, "s1");
        let other = seed(&conn, "s9");
        conn.execute(
            "UPDATE conversation SET title = 'agent audit', account_label = '@deepseek',
                    model = 'deepseek-chat' WHERE id = ?1",
            [&card],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, opened_by, started_at, ended_at, turns)
             VALUES ('s1','home','volery','card',?1,'person',1000,2000,2),
                    ('s2','home','volery','card',?1,'person',3000,NULL,1),
                    ('sx','home','volery','card',?2,'person',1500,2500,9)",
            params![card, other],
        )
        .unwrap();
        /* Two requests under one model in one session, one under another model
           in the second session, and one belonging to another card: the split
           must fold the first two and leave the fourth out. */
        conn.execute(
            "INSERT INTO usage_fact
               (at, host, session, model, source, account, provider, project,
                in_tok, out_tok, requests)
             VALUES (1100,'home','s1','claude-opus-5-5','card','lyss','anthropic','volery',100,10,1),
                    (1200,'home','s1','claude-opus-5-5','card','lyss','anthropic','volery',50,5,1),
                    (3100,'home','s2','deepseek-chat','card','@deepseek','deepseek','volery',7,3,1),
                    (1600,'home','sx','claude-opus-5-5','card','lyss','anthropic','volery',999,999,9)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO invalidate_fact (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (1500,'home','s1',?1,'account','tx-team','/w',1,'receipt'),
                    (1550,'home','s1',?1,'write','a.rs','/w',1,'receipt'),
                    (1600,'home','s1',?1,'model','claude-opus-5-5','/w',1,'attributed'),
                    (1700,'home','sx',?2,'provider','deepseek','/w',1,'receipt')",
            params![card, other],
        )
        .unwrap();
        settled_turn(&conn, &card, "s1", 1000, 2000, 0.25);
        conn.execute(
            "INSERT INTO turn (conversation_id, opened_at, status_tier, agent_session_id)
             VALUES (?1, 3000, 'working', 's2')",
            [&card],
        )
        .unwrap();

        let life = card_life_rows(&conn, &card).unwrap();
        assert_eq!(life.label, "agent audit");
        assert_eq!((life.now_account.as_str(), life.now_model.as_str()), ("@deepseek", "deepseek-chat"));
        assert_eq!(life.sessions.len(), 2, "the other card's session is not this card's life");
        assert_eq!(life.spend.len(), 2, "two fundings, folded within each");
        let first = life.spend.iter().find(|s| s.session == "s1").unwrap();
        assert_eq!((first.in_tok, first.out_tok, first.requests), (150, 15, 2));
        assert_eq!((first.first_at, first.last_at), (1_100, 1_200));
        let second = life.spend.iter().find(|s| s.session == "s2").unwrap();
        assert_eq!((second.in_tok, second.requests), (7, 1));
        assert_eq!(life.moves.len(), 1, "a receipt move, not a write and not attributed excess");
        assert_eq!((life.moves[0].kind.as_str(), life.moves[0].reference.as_str()), ("account", "tx-team"));
        assert_eq!(life.turns, 1, "the open turn has not settled");
        assert!((life.usd_reported - 0.25).abs() < 1e-12);
        assert_eq!(life.facts_from, 1_100, "where the fine tier begins");
    }

    /// A card nobody has a row for is still answered — what the facts hold is
    /// the answer — and a life read never invents a session to go with them.
    #[test]
    fn a_card_with_no_row_is_an_empty_life_not_an_error() {
        let conn = db();
        let life = card_life_rows(&conn, "gone").unwrap();
        assert_eq!((life.sessions.len(), life.spend.len(), life.moves.len()), (0, 0, 0));
        assert_eq!((life.label.as_str(), life.now_session.as_str()), ("", ""));
        assert!(card_life_rows(&conn, "  ").is_err(), "a life with no card named is refused");
    }

    /// **A move receipt outlives the fine tier's ninety days.** An account,
    /// provider or model change is a card's history; the writes beside it, and
    /// the `attributed` measurement of one turn's excess, are moments. Both
    /// live in the same table, so retention has to tell them apart.
    #[test]
    fn a_move_receipt_is_kept_past_the_ninety_days_the_rest_is_not() {
        let mut conn = db();
        let now = now_ms();
        let old = now - FINE_KEEP_MS - 60_000;
        conn.execute(
            "INSERT INTO invalidate_fact (at, host, session, card, kind, ref, tree, affected, tokens, provenance)
             VALUES (?1,'home','s','c1','account','tx-team','/w',1,0,'receipt'),
                    (?1,'home','s','c1','provider','deepseek','/w',1,0,'receipt'),
                    (?1,'home','s','c1','model','claude-opus-5-5','/w',1,0,'receipt'),
                    (?1,'home','s','c1','instructions','CLAUDE.md','/w',1,0,'receipt'),
                    (?1,'home','s','c2','account','tx-team','/w',2,900,'attributed')",
            params![old],
        )
        .unwrap();
        write_tail(&mut conn, &[], &HashSet::new(), now).unwrap();
        let mut stmt = conn
            .prepare("SELECT kind FROM invalidate_fact WHERE provenance = 'receipt' ORDER BY kind")
            .unwrap();
        let left: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec!["account", "model", "provider"], "the three moves survived; the write did not");
        let attributed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invalidate_fact WHERE provenance = 'attributed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attributed, 0, "an attributed row is a measurement, not the card's history");
    }

    #[test]
    fn a_result_in_a_later_pass_still_resolves_its_call() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.10);
        }
        write(
            &conns,
            "home",
            &tool_batch(&[call_line("t1", opened + 1_000, "s1", "Read", r#"{"file_path":"a"}"#)]),
            now,
        )
        .unwrap();
        let pending: Option<i64> = conns
            .lock()
            .unwrap()
            .query_row("SELECT resolved_at FROM tool_pending WHERE tool_use_id = 't1'", [], |r| r.get(0))
            .unwrap();
        assert!(pending.is_none(), "the call waits for its result");

        write(
            &conns,
            "home",
            &tool_batch(&[result_line("t1", opened + 2_000, "s1", "text", false)]),
            now,
        )
        .unwrap();
        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let (_, _, calls, errors, ms, out_bytes, _) = tool_facts(&conn)[0].clone();
        assert_eq!((calls, errors, ms, out_bytes), (1, 0, 1_000, 4));
    }

    #[test]
    fn a_call_with_no_result_is_written_as_no_result() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.10);
        }
        write(
            &conns,
            "home",
            &tool_batch(&[call_line("t1", opened + 1_000, "s1", "Grep", r#"{"pattern":"x"}"#)]),
            now,
        )
        .unwrap();
        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let (_, _, calls, errors, ms, out_bytes, _) = tool_facts(&conn)[0].clone();
        assert_eq!((calls, errors, ms, out_bytes), (1, 0, 0, 0), "counted, with no time");
    }

    #[test]
    fn a_call_no_turn_claims_is_swept_as_no_turn() {
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1");
        }
        let now = now_ms();
        let at = now - 30 * 60 * 1000;
        write(
            &conns,
            "home",
            &tool_batch(&[call_line("t1", at, "s1", "Bash", r#"{"command":"ls"}"#)]),
            now,
        )
        .unwrap();
        let written = fold_tools(&conns, "home", now).unwrap();
        assert_eq!(written.no_turn, 1);
        let conn = conns.lock().unwrap();
        let (turn_id, _, calls, _, _, _, usd) = tool_facts(&conn)[0].clone();
        assert_eq!(turn_id, 0);
        assert_eq!(calls, 1);
        assert_eq!(usd, 0.0, "outside every turn's denominator");
        let fact_at: i64 = conn.query_row("SELECT at FROM tool_fact", [], |r| r.get(0)).unwrap();
        assert_eq!(fact_at, bucket_of(at), "a no-turn row keeps the bucket grain");
        let pending: i64 = conn.query_row("SELECT COUNT(*) FROM tool_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(pending, 0);
    }

    #[test]
    fn two_tools_in_a_turn_apportion_exactly() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.333_333);
        }
        let lines = vec![
            call_line("t1", opened + 100, "s1", "Bash", r#"{"command":"x"}"#),
            call_line("t2", opened + 200, "s1", "Read", r#"{"file_path":"a"}"#),
        ];
        write(&conns, "home", &tool_batch(&lines), now).unwrap();
        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let facts = tool_facts(&conn);
        assert_eq!(facts.len(), 2);
        let sum: f64 = facts.iter().map(|f| f.6).sum();
        assert!((sum - 0.333_333).abs() < 1e-12, "the rows sum to the turn: {sum}");
        let hours: (i64, f64) = conn
            .query_row("SELECT SUM(calls), SUM(turn_usd) FROM tool_hour", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(hours.0, 2);
        assert!((hours.1 - 0.333_333).abs() < 1e-12, "and the hour agrees");
    }

    /// **A transcript read twice is one call.** A file replaced under the offset
    /// is re-read from zero and offers every call again; `tool_pending` has been
    /// deleted by then, so its key cannot answer "was this counted" — `tool_seen`
    /// can. Without the memo the call inside the folded turn is re-inserted and
    /// never swept, and a subagent's call is re-inserted and swept a second
    /// time, because the sweep's claim test only knows the call's own stamp.
    #[test]
    fn a_replayed_transcript_does_not_count_a_call_twice() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let opened = now - 20 * 60 * 1000;
        let ended = now - 10 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            settled_turn(&conn, &card, "s1", opened, ended, 0.40);
        }
        let call = call_line("t1", opened + 1_000, "s1", "Bash", r#"{"command":"ls"}"#);
        let result = result_line("t1", opened + 1_450, "s1", "a b c", false);
        write(&conns, "home", &tool_batch(&[call.clone(), result.clone()]), now).unwrap();
        fold_tools(&conns, "home", now).unwrap();

        /* The same file, re-read from zero, and folded again. */
        write(&conns, "home", &tool_batch(&[call, result]), now).unwrap();
        let again = fold_tools(&conns, "home", now).unwrap();
        assert_eq!(again.folds, 0, "the turn's marker still stands");

        let conn = conns.lock().unwrap();
        let facts: (i64, i64) = conn
            .query_row("SELECT COUNT(*), SUM(calls) FROM tool_fact", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(facts, (1, 1), "one fact, one call");
        let hour: i64 = conn.query_row("SELECT SUM(calls) FROM tool_hour", [], |r| r.get(0)).unwrap();
        assert_eq!(hour, 1, "and the rollup agrees");
        let pending: i64 = conn.query_row("SELECT COUNT(*) FROM tool_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(pending, 0, "nothing is re-staged to leak or be swept twice");
    }

    #[test]
    fn a_lost_turn_writes_nothing_and_keeps_its_calls_for_the_sweep() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let at = now - 20 * 60 * 1000;
        {
            let conn = conns.lock().unwrap();
            /* A backfilled row: the only boundary history knows is its end. */
            settled_turn(&conn, &card, "s1", at, at, 0.10);
        }
        write(
            &conns,
            "home",
            &tool_batch(&[call_line("t1", at, "s1", "Bash", r#"{"command":"x"}"#)]),
            now,
        )
        .unwrap();
        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let facts = tool_facts(&conn);
        assert!(
            facts.iter().all(|f| f.0 == 0),
            "a zero-length turn writes no fact of its own"
        );
        assert_eq!(facts.len(), 1, "the sweep still keeps the call, as no-turn");
        let marked: i64 = conn.query_row("SELECT COUNT(*) FROM analytics_fold", [], |r| r.get(0)).unwrap();
        assert_eq!(marked, 1, "but it is not reconsidered every minute");
    }

    #[test]
    fn a_subagents_call_belongs_to_the_turn_that_spawned_it() {
        let conns = Mutex::new(db());
        let card = {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1")
        };
        let now = now_ms();
        let first_end = now - 20 * 60 * 1000;
        let second_open = first_end;
        let second_end = now - 10 * 60 * 1000;
        let spawn_turn;
        {
            let conn = conns.lock().unwrap();
            spawn_turn = settled_turn(&conn, &card, "s1", first_end - 60_000, first_end, 0.20);
            settled_turn(&conn, &card, "s1", second_open, second_end, 0.80);
        }
        /* The spawn in turn one, the child's call while turn two was running. */
        let lines = vec![
            agent_call_line("spawn", first_end - 30_000, "s1", "", "Agent", r#"{"subagent_type":"scout"}"#),
            result_line("spawn", first_end - 20_000, "s1", "receipt", false),
            agent_call_line("child", second_open + 1_000, "s1", "a1", "Read", r#"{"file_path":"a"}"#),
        ];
        write(&conns, "home", &tool_batch(&lines), now).unwrap();
        /* The result carries no agentId in this fixture, so set the mapping the
           way the CLI's receipt would. */
        conns
            .lock()
            .unwrap()
            .execute("UPDATE tool_pending SET child_agent = 'a1' WHERE tool_use_id = 'spawn'", [])
            .unwrap();
        fold_tools(&conns, "home", now).unwrap();
        let conn = conns.lock().unwrap();
        let rows: Vec<(i64, String, f64)> = conn
            .prepare("SELECT turn_id, tool, turn_usd FROM tool_fact ORDER BY tool")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let read = rows.iter().find(|r| r.1 == "Read").unwrap();
        assert_eq!(
            read.0, spawn_turn,
            "the child's call belongs to the turn that spawned it, not the one running when it acted"
        );
        assert!(
            (read.2 - 0.10).abs() < 1e-12,
            "apportioned against that turn's cost, shared with its spawn"
        );
    }

    #[test]
    fn a_receipt_is_written_once_and_suppresses_its_history_duplicate() {
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1");
        }
        let now = now_ms();
        let at = now - 60_000;
        let call = call_line("t1", at - 1_000, "s1", "Bash", r#"{"command":"git commit -m x"}"#);
        let result = result_line("t1", at, "s1", "[main 8adbaaa] skein: a thing", false);
        write(&conns, "home", &tool_batch(&[call, result]), now).unwrap();
        {
            let conn = conns.lock().unwrap();
            let row: (String, String, String, String, i64) = conn
                .query_row(
                    "SELECT kind, ref, branch, card, ms FROM work_fact",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )
                .unwrap();
            assert_eq!(row.0, "commit");
            assert_eq!(row.1, "8adbaaa");
            assert_eq!(row.2, "main");
            assert_eq!(row.3, "card-s1");
            assert!(row.4 >= 1_000, "the call's own latency");
        }

        /* Re-reading the same result is a no-op. */
        write(&conns, "home", &tool_batch(&[result_line("t1", at, "s1", "[main 8adbaaa] skein: a thing", false)]), now).unwrap();
        {
            let conn = conns.lock().unwrap();
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM work_fact", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
        }

        /* History later finds the same commit with a full sha. */
        assert!(
            history_known(
                &conns.lock().unwrap(),
                "8adbaaa0000000000000000000000000000000000"
            )
            .unwrap()
        );
        let commit = HistCommit {
            sha: "8adbaaa0000000000000000000000000000000000".into(),
            parents: vec!["p".into()],
            at,
            files: 2,
            added: 10,
            removed: 1,
            paths: vec!["src/a.ts".into()],
        };
        let root = Root {
            path: "C:/x".into(),
            project: "volery".into(),
            branch: "main".into(),
            candidates: vec![],
        };
        let mut conn = conns.lock().unwrap();
        let wrote = write_history(&mut conn, "home", &root, &[commit]).unwrap();
        assert_eq!(wrote.history, 0, "the receipt already holds it");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM work_fact", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "one row, not a receipt and a history duplicate");
        /* The receipt named the sha and not the lines; history is the only
           writer that reads numstat, so it fills them in place. */
        let (files, added, removed, provenance): (i64, i64, i64, String) = conn
            .query_row(
                "SELECT files, added, removed, provenance FROM work_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((files, added, removed), (2, 10, 1));
        assert_eq!(provenance, "receipt", "the artifact keeps its card and its provenance");
        let (hfiles, hadded, hremoved): (i64, i64, i64) = conn
            .query_row(
                "SELECT files, added, removed FROM work_hour WHERE kind = 'commit'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((hfiles, hadded, hremoved), (2, 10, 1), "the hourly rollup moves with it");
    }

    #[test]
    fn a_history_commit_is_attributed_by_branch_then_interval_then_touch() {
        let conn = db();
        seed(&conn, "s1");
        conn.execute(
            "INSERT OR IGNORE INTO conversation (id, agent_session_id, project_id, cwd, branch, born_at)
             VALUES ('card-s2', 's2', 'p1', 'C:/x', 'main', 0)",
            [],
        )
        .unwrap();
        let at = 1_786_601_268_000;
        let commit = HistCommit {
            sha: "aaaaaaa".into(),
            parents: vec!["p".into()],
            at,
            files: 1,
            added: 1,
            removed: 0,
            paths: vec!["src/lib/a.ts".into()],
        };
        let both = vec![
            Candidate { card: "card-s1".into(), session: "s1".into() },
            Candidate { card: "card-s2".into(), session: "s2".into() },
        ];

        /* One card on the branch is the first rung. */
        assert_eq!(
            attribute_commit(&conn, &commit, &both[..1]),
            Some(("card-s1".into(), "s1".into()))
        );
        /* Two cards, one mid-turn at the author time. */
        settled_turn(&conn, "card-s2", "s2", at - 1_000, at + 60_000, 0.1);
        assert_eq!(
            attribute_commit(&conn, &commit, &both),
            Some(("card-s2".into(), "s2".into()))
        );
        /* Neither mid-turn: the card that touched the file lately wins. */
        conn.execute("DELETE FROM turn", []).unwrap();
        conn.execute(
            "INSERT INTO file_touch (conversation_id, path, op, at)
             VALUES ('card-s1', 'C:/x/src/lib/a.ts', 'write', ?1)",
            params![at - 60_000],
        )
        .unwrap();
        assert_eq!(
            attribute_commit(&conn, &commit, &both),
            Some(("card-s1".into(), "s1".into()))
        );
        /* Nothing ties it to a card, so it counts toward the project. */
        conn.execute("DELETE FROM file_touch", []).unwrap();
        assert_eq!(attribute_commit(&conn, &commit, &both), None);
    }

    #[test]
    fn a_history_merge_commit_is_written_as_an_integration() {
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1");
        }
        let at = now_ms() - 60_000;
        let commit = HistCommit {
            sha: "bbbbbbb".into(),
            parents: vec!["a".into(), "b".into()],
            at,
            files: 1,
            added: 2,
            removed: 3,
            paths: vec!["src/a.ts".into()],
        };
        let root = Root {
            path: "C:/x".into(),
            project: "volery".into(),
            branch: "main".into(),
            candidates: vec![Candidate { card: "card-s1".into(), session: "s1".into() }],
        };
        let mut conn = conns.lock().unwrap();
        let wrote = write_history(&mut conn, "home", &root, &[commit]).unwrap();
        assert_eq!(wrote.history, 1);
        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM work_fact ORDER BY kind")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(kinds, vec!["commit", "merge"]);
        let counts: Vec<i64> = conn
            .prepare("SELECT count FROM work_hour ORDER BY kind")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(counts, vec![1, 1]);
    }

    #[test]
    fn the_tool_and_work_readings_are_bounded_and_the_series_rolls_up() {
        let conns = Mutex::new(db());
        {
            let conn = conns.lock().unwrap();
            seed(&conn, "s1");
            conn.execute(
                "INSERT INTO work_fact (at, host, session, card, kind, ref, project, files, added, removed, provenance)
                 VALUES (100, 'home', 's1', 'card-s1', 'commit', 'a', 'volery', 2, 10, 1, 'receipt')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO work_hour (hour, host, project, branch, kind, count, files, added, removed)
                 VALUES (0, 'home', 'volery', 'main', 'commit', 1, 2, 10, 1)",
                [],
            )
            .unwrap();
            /* The card join: a session row is what says whose money this was. */
            conn.execute(
                "INSERT INTO analytics_session
                   (session, host, project, source, card_id, started_at, ended_at)
                 VALUES ('s1', 'home', 'volery', 'card', 'card-s1', 0, 100)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_fact
                   (at, host, session, model, source, account, provider, project,
                    in_tok, out_tok, cache_read, requests)
                 VALUES (30_000, 'home', 's1', 'claude-opus-5-5', 'card', 'lyss',
                         'anthropic', 'volery', 1000, 200, 4000, 2)",
                [],
            )
            .unwrap();
            /* A fact no session claims stays spend and gets no card, which is
               what stops it being quietly attributed to the one card present. */
            conn.execute(
                "INSERT INTO usage_fact (at, host, session, model, source, account, provider, project, requests)
                 VALUES (40_000, 'home', 'elsewhere', 'claude-opus-5-5', 'terminal',
                         'lyss', 'anthropic', 'volery', 1)",
                [],
            )
            .unwrap();
        }
        let conn = conns.lock().unwrap();
        assert!(work_rows(&conn, 10, 1).is_err(), "a backwards window is refused");
        assert_eq!(work_rows(&conn, 0, 200).unwrap().len(), 1);
        assert_eq!(tool_rows(&conn, 0, 200).unwrap().len(), 0);
        /* The spend half is read over a window that holds the usage rows above:
           30,000 and 40,000 are where they were put to keep them clear of the
           work fact's own instant, and a window ending at 200 excludes both.
           That is the test's fixture rather than the query's rule — a bounded
           read answers with the rows inside its bound, which is the whole of
           what the `at >= ?1 AND at < ?2` clause claims. */
        let series = work_series_rows(&conn, 0, 50_000).unwrap();
        assert_eq!(series.hourly.len(), 1);
        assert_eq!(series.hourly[0].kind, "commit");
        assert_eq!(series.hourly[0].count, 1);
        assert_eq!(series.sessions.len(), 1);
        assert_eq!(series.sessions[0].card, "card-s1");
        assert_eq!(series.spend.len(), 2, "one row per card and hour, not per fact");
        let carded = series.spend.iter().find(|r| r.card == "card-s1").unwrap();
        assert_eq!((carded.in_tok, carded.out_tok, carded.requests), (1000, 200, 2));
        assert!(
            series.spend.iter().any(|r| r.card.is_empty()),
            "a fact no session claims is still spend, and is not given to a card"
        );
    }

    /* ── invalidation (§3.9; phase 6b) ────────────────────────────────────── */

    #[test]
    fn only_a_governing_file_is_an_instruction_write() {
        let at = 1_786_601_268_000;
        let claude = parse_writes(&call_line(
            "w1",
            at,
            "s1",
            "Write",
            r#"{"file_path":"C:\\x\\CLAUDE.md","content":"x"}"#,
        ));
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].kind, "instructions");
        assert_eq!(claude[0].path, "C:/x/CLAUDE.md", "the path is forward-slashed");

        let rule = parse_writes(&call_line(
            "w2",
            at,
            "s1",
            "Edit",
            r#"{"file_path":"C:\\x\\.claude\\rules\\style.md"}"#,
        ));
        assert_eq!(rule[0].kind, "rule");
        assert_eq!(invalidate_key("rule", &rule[0].path), "C:/x/.claude/rules");

        let agents = parse_writes(&call_line(
            "w3",
            at,
            "s1",
            "MultiEdit",
            r#"{"file_path":"/repo/AGENTS.md","edits":[]}"#,
        ));
        assert_eq!(agents[0].kind, "instructions");

        let notebook = parse_writes(&call_line(
            "w4",
            at,
            "s1",
            "NotebookEdit",
            r#"{"notebook_path":"C:\\x\\CLAUDE.md","new_source":"x"}"#,
        ));
        assert_eq!(notebook.len(), 1, "a notebook edit names its path as notebook_path");

        for (name, input) in [
            ("Write", r#"{"file_path":"C:\\x\\src\\main.ts","content":"x"}"#),
            /* A write with no path at all records nothing: an invalidation may
               never invent the file it is about. */
            ("Write", r#"{"content":"x"}"#),
            ("Bash", r#"{"command":"echo x > CLAUDE.md"}"#),
        ] {
            assert!(
                parse_writes(&call_line("w5", at, "s1", name, input)).is_empty(),
                "{name} {input} is not an instruction write"
            );
        }
    }

    #[test]
    fn a_chat_card_records_no_instruction_write() {
        let conn = db();
        let id = seed(&conn, "s1");
        conn.execute("UPDATE conversation SET kind = 'chat' WHERE id = ?1", [&id])
            .unwrap();
        let at = 1_786_601_268_000;
        let batch = tool_batch(&[call_line(
            "w1",
            at,
            "s1",
            "Write",
            r#"{"file_path":"C:\\x\\CLAUDE.md","content":"x"}"#,
        )]);
        let conns = Mutex::new(conn);
        write(&conns, "here", &batch, at + 1).unwrap();
        let conn = conns.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM invalidate_fact", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "a chat card has no tree to invalidate");
    }

    #[test]
    fn a_project_write_names_its_card_and_tree_and_counts_its_payers() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        /* Two sessions in one tree, both live at the instant of the write. */
        for (session, card) in [("s1", "card-s1"), ("s2", "card-s2")] {
            conn.execute(
                "INSERT OR REPLACE INTO analytics_session
                   (session, host, project, source, card_id, started_at, ended_at)
                 VALUES (?1, 'here', 'volery', 'card', ?2, ?3, NULL)",
                params![session, card, at - 60_000],
            )
            .unwrap();
        }
        let batch = tool_batch(&[call_line(
            "w1",
            at,
            "s1",
            "Write",
            r#"{"file_path":"C:\\x\\CLAUDE.md","content":"x"}"#,
        )]);
        let conns = Mutex::new(conn);
        write(&conns, "here", &batch, at + 1).unwrap();
        let conn = conns.lock().unwrap();
        let row: (String, String, String, i64) = conn
            .query_row(
                "SELECT card, kind, tree, affected FROM invalidate_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(row.0, "card-s1");
        assert_eq!(row.1, "instructions");
        assert_eq!(row.2, "C:/x");
        assert_eq!(row.3, 1, "the other card in the tree pays; the writer does not");
    }

    #[test]
    fn a_tier_suffix_is_not_a_model_move_and_unknown_is_not_a_value() {
        assert!(same_model("claude-opus-5[1m]", "claude-opus-5"));
        assert!(same_model("claude-opus-5-1m", "claude-opus-5"));
        assert!(!same_model("claude-opus-5", "claude-sonnet-5"));
        assert!(!moved("unknown", "lyss"), "the first turn is not a switch");
        assert!(!moved("", "lyss"), "a first sighting is not a switch");
        assert!(!moved("lyss", "lyss"));
        assert!(moved("lyss", "tx-team"));
    }

    #[test]
    fn the_backfill_reads_each_transcript_once() {
        let dir = std::env::temp_dir().join(format!("skein-backfill-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let at = 1_786_601_268_000;
        /* `call_line` is written for the sink, which parses a record as a
           string, and it is pretty-printed across several physical lines. The
           backfill reads a transcript the way the CLI writes one, a record per
           line, so the fixture has to be folded to one line here or the walk
           splits it and every record fails to parse. */
        let line = call_line(
            "w1",
            at,
            "s1",
            "Write",
            r#"{"file_path":"C:\\x\\CLAUDE.md","content":"x"}"#,
        )
        .replace('\n', " ");
        std::fs::write(&path, format!("{line}\n{line}\n")).unwrap();

        let conns = Mutex::new(db());
        let host = "here";
        let first = backfill_paths(&conns, host, at + 1000, vec![path.clone()]).unwrap();
        assert_eq!(first.walked, 1);
        assert_eq!(first.invalidations, 1, "the same write twice is one row");

        /* The mark is what makes it one-off. A second pass does not re-read. */
        let second = backfill_paths(&conns, host, at + 2000, vec![path.clone()]).unwrap();
        assert_eq!(second.walked, 0, "a marked transcript is never re-read");
        let conn = conns.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM invalidate_fact", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let walked: i64 = conn
            .query_row("SELECT COUNT(*) FROM invalidate_walk", [], |r| r.get(0))
            .unwrap();
        assert_eq!(walked, 1);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Seed a card's own requests: one fact row per five-minute bucket, with a
    /// cache write of `write` per request.
    fn write_row(conn: &Connection, session: &str, at: i64, write: i64, input: i64, requests: i64) {
        conn.execute(
            "INSERT INTO usage_fact
               (at, host, session, agent, model, source, account, provider, project,
                in_tok, write_5m, requests)
             VALUES (?1, 'here', ?2, '', 'claude-opus-5-5', 'card', 'lyss', 'claude', 'volery',
                     ?3, ?4, ?5)",
            params![at, session, input, write, requests],
        )
        .unwrap();
    }

    #[test]
    fn attribution_is_the_excess_over_the_cards_own_median() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        /* The writer and the payer share a tree and overlap the episode. */
        for (session, card) in [("s1", "card-s1"), ("s2", "card-s2")] {
            conn.execute(
                "INSERT INTO analytics_session
                   (session, host, project, source, card_id, started_at, ended_at)
                 VALUES (?1, 'here', 'volery', 'card', ?2, ?3, NULL)",
                params![session, card, at - 3_600_000],
            )
            .unwrap();
        }
        /* The payer's own recent median is 100 tokens a request, all of it
           strictly before the event so it is the baseline and not the answer. */
        for i in 0..6 {
            write_row(&conn, "s2", at - 1_800_000 + i * 300_000, 100, 0, 1);
        }
        /* Its first request after the event writes 5,100. */
        write_row(&conn, "s2", at + 300_000, 5_100, 0, 1);
        conn.execute(
            "INSERT INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, 'here', 's1', 'card-s1', 'instructions', 'C:/x/CLAUDE.md', 'C:/x', 1, 'receipt')",
            params![at],
        )
        .unwrap();

        let conns = Mutex::new(conn);
        let counts = attribute(&conns, "here", at + 3_600_000).unwrap();
        assert_eq!(counts.attributed, 1);
        let conn = conns.lock().unwrap();
        let row: (String, String, i64, String, i64) = conn
            .query_row(
                "SELECT session, card, tokens, model, affected FROM invalidate_fact
                  WHERE provenance = 'attributed'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(row.0, "s2", "the payer is the other card, not the writer");
        assert_eq!(row.1, "card-s2");
        assert_eq!(row.2, 5_000, "5,100 written less a 100 median");
        assert_eq!(row.3, "claude-opus-5-5", "the model is what prices it");
        assert_eq!(row.4, 0);

        /* Re-running is the same row, not a second one. */
        drop(conn);
        attribute(&conns, "here", at + 3_600_000).unwrap();
        let conn = conns.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invalidate_fact WHERE provenance = 'attributed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn an_unmeasured_event_writes_no_row_rather_than_a_zero() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, started_at, ended_at)
             VALUES ('s2', 'here', 'volery', 'card', 'card-s2', ?1, NULL)",
            params![at - 3_600_000],
        )
        .unwrap();
        /* Four requests before the event: fewer than the floor, so unmeasured. */
        for i in 0..4 {
            write_row(&conn, "s2", at - 1_200_000 + i * 300_000, 100, 0, 1);
        }
        write_row(&conn, "s2", at + 300_000, 5_100, 0, 1);
        conn.execute(
            "INSERT INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, 'here', 's1', 'card-s1', 'instructions', 'C:/x/CLAUDE.md', 'C:/x', 1, 'receipt')",
            params![at],
        )
        .unwrap();
        let conns = Mutex::new(conn);
        let counts = attribute(&conns, "here", at + 3_600_000).unwrap();
        assert_eq!(counts.attributed, 0);
        let conn = conns.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invalidate_fact WHERE provenance = 'attributed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "unmeasured is not free, and no row may say it is");
    }

    /// The mechanism `tools/probe-invalidate.ts` measured on this machine
    /// (2026-11-12): a card that restarts reads the new `CLAUDE.md` as fresh
    /// input, with no cache creation at all. Measuring only `write_5m` would
    /// read that as an invalidation that cost nothing.
    #[test]
    fn a_prefix_re_read_as_fresh_input_is_an_excess_too() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, started_at, ended_at)
             VALUES ('s2', 'here', 'volery', 'card', 'card-s2', ?1, NULL)",
            params![at - 3_600_000],
        )
        .unwrap();
        for i in 0..6 {
            write_row(&conn, "s2", at - 1_800_000 + i * 300_000, 0, 180, 1);
        }
        /* The resumed process: the 3,600-token file arrives as input tokens. */
        write_row(&conn, "s2", at + 300_000, 0, 3_800, 1);
        conn.execute(
            "INSERT INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, 'here', 's1', 'card-s1', 'instructions', 'C:/x/CLAUDE.md', 'C:/x', 1, 'receipt')",
            params![at],
        )
        .unwrap();
        let conns = Mutex::new(conn);
        attribute(&conns, "here", at + 3_600_000).unwrap();
        let conn = conns.lock().unwrap();
        let row: (i64, i64) = conn
            .query_row(
                "SELECT tokens, in_tokens FROM invalidate_fact WHERE provenance = 'attributed'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, 0, "no cache creation was reported");
        assert_eq!(row.1, 3_620, "3,800 input less a 180 median");
    }

    /// The commonest case on a quiet wall: the other cards are at rest, and the
    /// cost is paid when one of them is woken hours later. A thirty-minute wait
    /// left that unmeasured for ever.
    #[test]
    fn a_card_woken_hours_later_pays_the_excess() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, started_at, ended_at)
             VALUES ('s2', 'here', 'volery', 'card', 'card-s2', ?1, NULL)",
            params![at - 3_600_000],
        )
        .unwrap();
        for i in 0..6 {
            write_row(&conn, "s2", at - 1_800_000 + i * 300_000, 0, 180, 1);
        }
        /* Two hours after the write, the card is roused and reads the file. */
        write_row(&conn, "s2", at + 7_200_000, 0, 3_800, 1);
        conn.execute(
            "INSERT INTO invalidate_fact
               (at, host, session, card, kind, ref, tree, affected, provenance)
             VALUES (?1, 'here', 's1', 'card-s1', 'instructions', 'C:/x/CLAUDE.md', 'C:/x', 1, 'receipt')",
            params![at],
        )
        .unwrap();
        let conns = Mutex::new(conn);
        let counts = attribute(&conns, "here", at + 10_800_000).unwrap();
        assert_eq!(counts.attributed, 1, "the wake is the re-read");
        let conn = conns.lock().unwrap();
        let paid: (i64, i64) = conn
            .query_row(
                "SELECT at, in_tokens FROM invalidate_fact WHERE provenance = 'attributed'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(paid, (at, 3_620), "attributed at the event, priced from the wake");
    }

    /// With a wait measured in hours, two events on one tree can both find the
    /// same woken card's request. The re-read belongs to the latest one, the
    /// churn rule one timescale out.
    #[test]
    fn a_re_read_belongs_to_the_latest_event_on_the_tree() {
        let conn = db();
        seed(&conn, "s1");
        seed(&conn, "s2");
        let at = 1_786_601_268_000;
        conn.execute(
            "INSERT INTO analytics_session
               (session, host, project, source, card_id, started_at, ended_at)
             VALUES ('s2', 'here', 'volery', 'card', 'card-s2', ?1, NULL)",
            params![at - 3_600_000],
        )
        .unwrap();
        for i in 0..6 {
            write_row(&conn, "s2", at - 1_800_000 + i * 300_000, 0, 180, 1);
        }
        /* The card is roused once, five hours after the first write and one
           hour after the second. */
        write_row(&conn, "s2", at + 5 * 3_600_000, 0, 3_800, 1);
        for (write_at, reference) in [
            (at, "C:/x/CLAUDE.md"),
            (at + 4 * 3_600_000, "C:/x/CLAUDE.md"),
        ] {
            conn.execute(
                "INSERT INTO invalidate_fact
                   (at, host, session, card, kind, ref, tree, affected, provenance)
                 VALUES (?1, 'here', 's1', 'card-s1', 'instructions', ?2, 'C:/x', 1, 'receipt')",
                params![write_at, reference],
            )
            .unwrap();
        }
        let conns = Mutex::new(conn);
        attribute(&conns, "here", at + 5 * 3_600_000 + 1_800_000).unwrap();
        let conn = conns.lock().unwrap();
        let paid: Vec<i64> = conn
            .prepare("SELECT at FROM invalidate_fact WHERE provenance = 'attributed'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            paid,
            vec![at + 4 * 3_600_000],
            "one re-read, claimed by the later write"
        );
    }
}
