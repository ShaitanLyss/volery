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
//! - **The store lock is never held across file IO.** The offsets are read under
//!   it and it is released for the walk; it is taken again once, to write one
//!   transaction. `open_turn`, `record_turn` and every other command wait on
//!   that mutex, so holding it while a file is parsed would stop the wall.
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

use crate::store::Store;
use crate::usage::{now_ms, Record};

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

/// One pass's worth of readings, filled by the walk and written afterwards.
///
/// The batch is the whole reason the store lock is not held across file IO: the
/// walk appends here, `write` takes the lock once and does one transaction.
#[derive(Default)]
pub(crate) struct Batch {
    requests: Vec<Record>,
    /// Requests already taken this pass — a file replaced mid-pass can offer
    /// the same request twice, and the DB check cannot see the first one yet.
    keys: HashSet<String>,
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
    batch: Batch,
}

impl Reading {
    pub(crate) fn new(marks: HashMap<PathBuf, Mark>, cutoff: i64) -> Self {
        Reading {
            marks,
            cutoff,
            batch: Batch::default(),
        }
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
    facts: i64,
    hours: i64,
    sessions: i64,
    bytes: u64,
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
    pub facts: i64,
    pub hours: i64,
    pub sessions: i64,
    pub refused: i64,
    pub ms: u64,
}

/// Fold one batch into the store, in **one transaction** (§7.2).
///
/// A crash leaves either the pass or not: a fact and its `usage_seen` key and
/// its file offset land together, which is the lesson `migrate` and
/// `set_mid_turn` both paid for. That is also what makes the offset safe to
/// advance — if this fails, the next pass re-reads the same bytes and the dedupe
/// has nothing, which is the truth.
fn write(conn: &mut Connection, host: &str, batch: Batch, now: i64) -> Result<Counts, String> {
    let cutoff = now - FINE_KEEP_MS;
    let mut counts = Counts {
        bytes: batch.bytes,
        ..Counts::default()
    };

    let tx = conn.transaction().map_err(|e| format!("analytics: begin: {e}"))?;

    /* 1. Which of these requests is new. */
    let mut fresh: Vec<Record> = Vec::new();
    {
        let mut seen = tx
            .prepare("SELECT 1 FROM usage_seen WHERE key = ?1")
            .map_err(|e| format!("analytics: read seen: {e}"))?;
        for rec in &batch.requests {
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
        let owners = batch
            .owners
            .get(&session)
            .cloned()
            .filter(|i| !i.is_empty())
            .or_else(|| prior_identity(&tx, &session));
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
        /* Asked once per agent rather than once per request: a subagent file
           can hold hundreds of records, and the answer cannot change inside
           one transaction. */
        let mut known_agents: HashMap<String, Option<(String, i64)>> = HashMap::new();

        for rec in &recs {
            let funding = funding_at(
                &spans,
                rec.at,
                owners.as_deref(),
                &labels,
                card.as_ref().map(|c| c.label.as_str()),
            );
            let known = match known_agents.get(&rec.agent) {
                Some(k) => k.clone(),
                None => {
                    let k = prior_agent(&tx, &session, &rec.agent)?;
                    known_agents.insert(rec.agent.clone(), k.clone());
                    k
                }
            };
            let (parent_agent, depth) = resolve_agent(
                &session,
                &rec.agent,
                &batch.parents,
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
                now_row.project = project.clone();
                now_row.source = source.to_string();
                now_row.account_first = funding.account.clone();
                now_row.provider_first = funding.provider.clone();
                now_row.cli_min = rec.cli.clone();
                now_row.cli_max = rec.cli.clone();
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
        for rec in &batch.requests {
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

    /* 7. The offsets — only the bytes that ended in a newline, which is what
          `usage.rs` hands over — and the marks for files that are gone. */
    {
        let mut sql = tx
            .prepare("INSERT OR REPLACE INTO usage_file (path, offset, mtime, size) VALUES (?1,?2,?3,?4)")
            .map_err(|e| format!("analytics: file: {e}"))?;
        for f in &batch.files {
            sql.execute(params![f.path, f.mark.offset as i64, f.mark.mtime, f.mark.size as i64])
                .map_err(|e| format!("analytics: file: {e}"))?;
        }
        drop(sql);
        /* A mark for a transcript that no longer exists is dead weight read
           into memory on every pass, and nothing else ever deletes one. The
           guard is not cosmetic: a walk that could not read the root at all
           reports no files, and pruning on that would throw away every offset
           and re-read ninety days the next time the disk came back. */
        if !batch.alive.is_empty() {
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
                if !batch.alive.contains(&path) {
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
          edge of the tier was a hole for ever. */
    tx.execute(
        "DELETE FROM usage_fact WHERE at + ?2 <= ?1",
        params![cutoff, BUCKET_MS],
    )
    .map_err(|e| format!("analytics: prune facts: {e}"))?;
    tx.execute("DELETE FROM usage_seen WHERE at < ?1", [cutoff])
        .map_err(|e| format!("analytics: prune seen: {e}"))?;

    tx.commit().map_err(|e| format!("analytics: commit: {e}"))?;
    Ok(counts)
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
    let source = match old.as_ref().map(|o| o.source.as_str()) {
        Some("card") => "card",
        Some("terminal") => {
            if now.source == "card" {
                "card"
            } else {
                "terminal"
            }
        }
        _ => now.source.as_str(),
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

    let project = card
        .map(|c| c.project.clone())
        .filter(|p| !p.is_empty())
        .or_else(|| Some(now.project.clone()).filter(|p| !p.is_empty()))
        .or_else(|| old.as_ref().map(|o| o.project.clone()).filter(|p| !p.is_empty()))
        .unwrap_or_default();
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
    let mut reading = Reading::new(marks, now - FINE_KEEP_MS);

    let scan = crate::usage::scan_with_sink(app, &app.state::<crate::usage::Usage>(), &mut reading)?;
    let batch = reading.into_batch();
    let refused = batch.refused;

    let counts = {
        let mut conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        write(&mut conn, &host, batch, now)?
    };

    Ok(Report {
        files: scan.read,
        bytes: counts.bytes,
        requests: counts.requests,
        duplicates: counts.duplicates,
        facts: counts.facts,
        hours: counts.hours,
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
        let mut conn = db();
        /* Relative to now, and that is not tidiness: `write` drops anything
           older than the fine tier's ninety days, so a fixture written as a
           fixed stamp passes on the day it is written and fails on CI a season
           later. */
        let line = request(now_ms() - 60_000, "claude-opus-5-5", 1000);
        let counts = write(&mut conn, "here", batch(&[line.clone()]), now_ms()).unwrap();
        assert_eq!(counts.requests, 1);
        let one: (i64, i64) = conn
            .query_row(
                "SELECT SUM(requests), SUM(in_tok) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(one, (1, 1000));

        /* The same file offered again — a replacement re-read from zero. */
        let again = write(&mut conn, "here", batch(&[line]), now_ms()).unwrap();
        assert_eq!(again.requests, 0, "the dedupe stopped the second count");
        assert_eq!(again.duplicates, 1);
        let two: (i64, i64) = conn
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
        let mut conn = db();
        /* A minute past an hour boundary and half a minute apart, so six
           requests cannot straddle an hour or a five-minute bucket and both
           tiers are one row either way. */
        let base = hour_of(now_ms() - 3_600_000) + 60_000;
        let lines: Vec<String> = (0..6)
            .map(|i| request(base + i * 30 * 1000, "claude-opus-5-5", 10))
            .collect();
        write(&mut conn, "here", batch(&lines), now_ms()).unwrap();

        let facts: (i64, i64, i64) = conn
            .query_row(
                "SELECT SUM(requests), SUM(in_tok), COUNT(*) FROM usage_fact",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let hours: (i64, i64, i64) = conn
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
}
