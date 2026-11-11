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
//! What a fact is, is §3.1's grain and §4's attribution ladder. What is
//! deliberately absent: tool facts, prompt facts, vault, allowances, machine
//! facts. Those are other phases and other tables.

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

        let old = session_old(&tx, &session, host)?;
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
    let (id, project, branch, label): (String, String, String, String) = conn
        .query_row(
            "SELECT c.id, COALESCE(p.name, ''), COALESCE(c.branch, ''),
                    COALESCE(c.account_label, '')
               FROM conversation c LEFT JOIN project p ON p.id = c.project_id
              WHERE c.agent_session_id = ?1
              ORDER BY c.born_at DESC LIMIT 1",
            [session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
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

    /* A command arriving mid-pass waits for one chunk rather than for the whole
       backfill — the difference between the 34 ms worst case measured for
       `CHUNK_REQUESTS` and a single transaction over every request on the
       machine. `flush` is where the per-chunk lock lives. */
    let counts = flush(&store.0, &host, &batch, now, CHUNK_REQUESTS, None)?;

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
    /// rather than as arithmetic. Second precision is enough for every fixture.
    fn stamp(at: i64) -> String {
        let secs = at.div_euclid(1000);
        let days = secs.div_euclid(86_400);
        let rem = secs.rem_euclid(86_400);
        let (y, m, d) = civil_from_days(days);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
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
}
