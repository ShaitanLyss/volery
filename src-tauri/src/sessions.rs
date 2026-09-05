//! What Claude Code has already recorded, for conversations Skein never opened.
//!
//! A session started in the terminal is a `.jsonl` under
//! `~/.claude/projects/<slug>/`, and Skein can adopt one by doing nothing more
//! than writing a row that points at it: nothing is copied, nothing moves, and
//! the file stays the shared surface both front ends append to.
//!
//! Two things about this walk are deliberate.
//!
//! **Identity comes from inside the file, never from the directory name.** The
//! slug folds every non-alphanumeric character to a dash (see
//! `supervisor::transcript_dir_name`), so `.scratch` and `-scratch` land in the
//! same place and no decoding can tell them apart. Every record carries its own
//! `cwd` — 97 of 97 transcripts here — so the catalogue reads that instead.
//!
//! **At most three lines per file are parsed as JSON.** The 278 transcripts on
//! this machine are 167 MB and the largest is 11 MB, nearly all of it tool
//! results nobody is listing. Only the last `ai-title` and the last `assistant`
//! record say anything a picker shows, so the scan carries those two lines
//! forward as text and parses them once the file is done.
//!
//! **And a session is reported in the wall's own spelling of where it was.**
//! That is `settle_roots`, and it is the one thing here that looks at the
//! database: a record's `cwd` is the path *as the child resolved it*, which
//! under a junction is not the path the `project` row holds. Reading it
//! faithfully and handing it on unchanged gave the wall a second territory
//! pointing at the same repository.
//!
//! **And only the head and the tail of each file are read at all**, which this
//! module claimed for a year while its loop went through every line of all
//! 167 MB — `field` scanning a multi-megabyte tool result seven times over to
//! learn a timestamp that was never on it. The panel that shows this list came
//! up empty for long enough that you would start typing in the filter, which is
//! how it was found. See `HEAD` and `TAIL` for what is read instead and the
//! measurement that sized them.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// A conversation on disk that no card points at yet.
#[derive(Serialize)]
pub struct Session {
    /// The session id, which is the filename — and what `--resume` takes.
    id: String,
    /// Where the session was, in the spelling **this wall** uses for that
    /// directory — see `settle_roots`, which is the whole of the difference
    /// between adopting a session into its territory and beside it.
    cwd: String,
    branch: Option<String>,
    title: Option<String>,
    /// The bare API name from the last answered message. It carries no window
    /// tier — see the note in `list_sessions`.
    model: Option<String>,
    /// What the last request actually occupied. Left as tokens rather than a
    /// fraction because the front end owns the window arithmetic.
    ctx_tokens: u64,
    /// ISO timestamps, exactly as recorded.
    born_at: Option<String>,
    last_at: Option<String>,
    bytes: u64,
}

/// Pull `"key":"value"` out of a line without parsing it.
///
/// Only used for fields whose values are plain ISO strings or paths — the point
/// is to avoid deserialising megabytes of tool output to learn a timestamp.
fn field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let start = line.find(&pat)? + pat.len();
    let rest = &line[start..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                /* Windows paths arrive as `C:\\atelier\\skein`. Nothing else
                   escaped appears in the fields read here. */
                let next = chars.next()?;
                out.push(if next == 'n' { '\n' } else { next });
            }
            _ => out.push(c),
        }
    }
    None
}

/// Every transcript Claude Code has written, newest activity first.
///
/// Deliberately says nothing about which of these Skein already knows: the
/// front end holds the wall and can answer that without a query. And it counts
/// no messages — deciding what is a prompt rather than injected context or a
/// subagent's turn is `history.ts`'s job, and duplicating those rules here
/// would give the two readers a chance to disagree.
///
/// Off the main thread, via `crate::off_main`: this walks every directory under
/// `~/.claude/projects` and opens the head and tail of every transcript in them,
/// which is unbounded in the only way that matters — it grows with how long the
/// CLI has been used on this machine.
#[tauri::command]
pub async fn list_sessions(app: AppHandle) -> Result<Vec<Session>, String> {
    crate::off_main(move || {
        let mut out = sessions_of(&app)?;
        settle_roots(&mut out, &wall_roots(&app));
        Ok(out)
    })
    .await?
}

/// Every territory's root as the `project` table spells it.
///
/// Read inside `off_main` with everything else, so the store lock is never
/// taken on the main thread. An empty answer — no store yet, a wedged mutex —
/// leaves every session reported exactly as its transcript recorded it, which
/// is what this command did for its whole life before `settle_roots`.
fn wall_roots(app: &AppHandle) -> Vec<String> {
    let Some(store) = app.try_state::<crate::store::Store>() else {
        return Vec::new();
    };
    let Ok(conn) = store.0.lock() else {
        return Vec::new();
    };
    crate::store::projects(&conn)
        .map(|ps| ps.into_iter().map(|p| p.root_path).collect())
        .unwrap_or_default()
}

/// Report each session under the spelling the wall already uses for the
/// directory it was in, where the two are the same directory.
///
/// The reading above is right and stays: a record's own `cwd` is the only
/// honest source, since the transcript's directory slug folds every
/// non-alphanumeric character and nothing may decode it. But a record's `cwd`
/// is the path **as the child resolved it**, and that is not always the path
/// the wall typed. `C:\Users\lyss` on this machine is a junction to
/// `C:\Users\flori`: Windows resolves a reparse point when a process's
/// current directory is opened, so every record from a card in those two
/// territories says `C:\Users\flori\codes\rise` while the `project` row
/// says `C:\Users\lyss\codes\rise`. The same gap cost those cards their
/// resume in 47e4d0f, from the other side.
///
/// Adopting one of them therefore made a second territory. `ensure_project`
/// matches on `root_path` and found none at the resolved path, and `layout`
/// groups cards by `cwd` against each territory's root — so the wall drew the
/// same checkout twice, with the same dev servers under it, and neither half
/// knew about the other.
///
/// Two properties this must keep, and both are why it is a *canonicalisation*
/// rather than anything cleverer:
///
/// - **It never decodes a slug.** The only thing asked of the filesystem is
///   "are these two paths the same directory", which it can answer exactly.
/// - **It never merges paths that genuinely differ.** Only whole-directory
///   identity counts: a session in a subdirectory of a territory, or in a git
///   worktree of it, canonicalises to something else and is left alone. A root
///   that is not on this machine — an imported territory pointing nowhere —
///   cannot be canonicalised at all, so nothing is ever matched to it.
///
/// Cost is one `canonicalize` per territory plus one per *distinct* session
/// cwd that is not already a territory's exact spelling, memoised below. The
/// common case — a session in a folder the wall spells the same way — takes no
/// syscall at all.
fn settle_roots(sessions: &mut [Session], roots: &[String]) {
    if roots.is_empty() {
        return;
    }
    /* Canonical form → the spelling the wall holds. Built once, and only for
       roots that are directories here. `or_insert` so that two territories
       somehow naming one directory settle on the first rather than fighting. */
    let mut real: HashMap<PathBuf, &str> = HashMap::new();
    for r in roots {
        if let Ok(p) = std::fs::canonicalize(r) {
            real.entry(p).or_insert(r.as_str());
        }
    }
    let exact: std::collections::HashSet<&str> = roots.iter().map(String::as_str).collect();
    let mut seen: HashMap<String, Option<&str>> = HashMap::new();
    for s in sessions.iter_mut() {
        if exact.contains(s.cwd.as_str()) {
            continue;
        }
        let cached = seen.get(&s.cwd).copied();
        let hit = match cached {
            Some(h) => h,
            None => {
                let h = std::fs::canonicalize(&s.cwd)
                    .ok()
                    .and_then(|p| real.get(&p).copied());
                seen.insert(s.cwd.clone(), h);
                h
            }
        };
        if let Some(root) = hit {
            s.cwd = root.to_string();
        }
    }
}

/// How much of a transcript's beginning is read, for the fields written once at
/// the top: `cwd`, `gitBranch` and the timestamp a session was born at.
///
/// Measured 2026-08-20 over the 278 transcripts on this machine: the first
/// `"cwd"` sat 4.5 KB in at worst (p50 796 bytes) and the first `"timestamp"`
/// 622 bytes (p50 48). Note it is *not* on line one in a single one of them —
/// the first record is a summary or a file-history snapshot — so this is a
/// budget of lines rather than one line, generous enough that the difference
/// costs nothing.
const HEAD: u64 = 64 * 1024;

/// And how much of the end, for the three fields that are last-wins: the
/// closing timestamp, the generated title, and the last answered `assistant`
/// message that carries the model and the occupancy.
///
/// Same measurement: the last `ai-title` record sat 64.8 KB from EOF at worst
/// (p50 8.7 KB) and the last answered `assistant` message 82.3 KB (p50 2.4 KB).
/// 256 KB found every one of the 278 with room to spare — and `whole` below
/// covers the file where it would not, by reading the rest rather than
/// reporting a conversation with no name and no occupancy.
const TAIL: u64 = 256 * 1024;

/// The fields a picker shows, folded out of whatever lines it is fed.
///
/// Fed a file's head and then its tail — in that order — this answers exactly
/// what feeding it every line would, for every field it holds. Three are
/// first-wins and no later line can beat them; three are last-wins and a later
/// line only ever improves them. That equivalence is the whole reason the walk
/// is allowed to skip the middle, and it is why overlapping reads on a small
/// file are harmless: feeding the same line twice, in order, changes nothing.
#[derive(Default)]
struct Scan {
    cwd: Option<String>,
    branch: Option<String>,
    born_at: Option<String>,
    last_at: Option<String>,
    title_line: Option<String>,
    assistant_line: Option<String>,
}

impl Scan {
    fn feed(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        if self.cwd.is_none() {
            self.cwd = field(line, "cwd");
        }
        if self.branch.is_none() {
            self.branch = field(line, "gitBranch").filter(|b| !b.is_empty());
        }
        if let Some(ts) = field(line, "timestamp") {
            self.born_at.get_or_insert_with(|| ts.clone());
            self.last_at = Some(ts);
        }
        if line.contains("\"ai-title\"") {
            self.title_line = Some(line.to_string());
        }
        /* The usage test is what makes this the last *answered* message: a
           refusal or an interrupted stream carries none. */
        if line.contains("\"type\":\"assistant\"") && line.contains("\"usage\"") {
            self.assistant_line = Some(line.to_string());
        }
    }

    /// Is there nothing left to gain by reading more of this file?
    ///
    /// The two the walk cannot do without: no `cwd` means nothing addressable,
    /// and no answered `assistant` record means either a session that never got
    /// an answer — in which case there is nothing to resume — or a tail that was
    /// cut above the last one. Those two are indistinguishable from here, so the
    /// caller reads the whole file and lets the distinction make itself.
    fn whole(&self) -> bool {
        self.cwd.is_some() && self.assistant_line.is_some()
    }
}

/// Feed `scan` the lines in `[from, from + len)`, dropping a partial one at
/// either edge.
///
/// The dropping is not tidiness. A line cut in half mid-`cwd` hands `field` an
/// unterminated value, which it answers `None` to — that much is safe — but one
/// cut inside a tool result can still carry `"type":"assistant"` and `"usage"`,
/// and then fails to parse as JSON, and the session is reported with no model
/// and an occupancy of zero. So a read that does not start at byte 0 discards
/// its first line, and one that does not reach EOF discards its last.
fn feed_range(scan: &mut Scan, file: &mut File, from: u64, len: u64, size: u64) {
    if file.seek(SeekFrom::Start(from)).is_err() {
        return;
    }
    let lines: Vec<String> = BufReader::new(file.take(len))
        .lines()
        .map_while(Result::ok)
        .collect();
    let mut slice: &[String] = &lines;
    if from > 0 && !slice.is_empty() {
        slice = &slice[1..];
    }
    if from + len < size && !slice.is_empty() {
        slice = &slice[..slice.len() - 1];
    }
    for line in slice {
        scan.feed(line);
    }
}

/// Everything one transcript says about itself, or nothing if it says too
/// little to be adopted.
fn read_session(path: &Path, id: String) -> Option<Session> {
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut file = File::open(path).ok()?;

    let mut scan = Scan::default();
    if bytes <= HEAD + TAIL {
        /* Small enough that the two reads would overlap most of it anyway — and
           most of them are: the median transcript here is 28 KB. One read, no
           seeking, and either `whole` is satisfied or the file genuinely lacks
           what it wants. */
        feed_range(&mut scan, &mut file, 0, bytes, bytes);
    } else {
        feed_range(&mut scan, &mut file, 0, HEAD, bytes);
        feed_range(&mut scan, &mut file, bytes - TAIL, TAIL, bytes);
        /* The measurement above says this does not happen on this machine. It is
           here because that is a measurement of one machine on one day, and the
           cost of being wrong without it is a row reading "untitled · 0%" for a
           conversation that has a name — worse than the cost of being wrong with
           it, which is one file read twice. */
        if !scan.whole() {
            scan = Scan::default();
            feed_range(&mut scan, &mut file, 0, bytes, bytes);
        }
    }

    /* No cwd means nothing addressable; no assistant record means the session
       never got an answer and there is nothing to resume. Three of the 278
       transcripts here are one or the other. */
    let (Some(cwd), Some(assistant)) = (scan.cwd.clone(), scan.assistant_line.as_ref()) else {
        return None;
    };

    let title = scan
        .title_line
        .as_deref()
        .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .and_then(|v| {
            v.get("aiTitle")
                .and_then(|t| t.as_str())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from)
        });

    let mut model = None;
    let mut ctx_tokens = 0u64;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(assistant) {
        let msg = v.get("message");
        /* The bare API name, with no window tier — `[1m]` reaches the wire only
           on `system/init`, which is not written to the transcript. An imported
           card therefore cannot know its window until it wakes; `#adoptModel`
           settles it then. */
        model = msg
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .map(String::from);
        if let Some(u) = msg.and_then(|m| m.get("usage")) {
            let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            /* Matches the live fold exactly — and note it is this message's
               usage, never a sum across the turn. */
            ctx_tokens = n("input_tokens")
                + n("cache_read_input_tokens")
                + n("cache_creation_input_tokens")
                + n("output_tokens");
        }
    }

    Some(Session {
        id,
        cwd,
        branch: scan.branch,
        title,
        model,
        ctx_tokens,
        born_at: scan.born_at,
        last_at: scan.last_at,
        bytes,
    })
}

/// The walk itself, apart from the command that carries it.
fn sessions_of(app: &AppHandle) -> Result<Vec<Session>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    walk(&home.join(".claude").join("projects"))
}

/// Every transcript under `root`, newest activity first.
///
/// Split from `sessions_of` so it can be pointed at a fixture directory: what is
/// worth testing here is the reading, and the reading has nothing to do with
/// where the CLI happens to keep its files.
fn walk(root: &Path) -> Result<Vec<Session>, String> {
    let Ok(dirs) = std::fs::read_dir(root) else {
        // No CLI sessions on this machine at all is an empty list, not a fault.
        return Ok(Vec::new());
    };

    let mut out: Vec<Session> = Vec::new();
    for dir in dirs.flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            if let Some(session) = read_session(&path, id) {
                out.push(session);
            }
        }
    }

    /* Newest first, and the picker leans on it harder than it looks: that list
       is what you see before you have typed anything, so its order is the whole
       of the answer to "what was I just doing". A missing timestamp sorts last,
       which is where a transcript that never said when it was belongs. */
    out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{field, settle_roots, walk, Session};

    /// A session that says only where it was. Every other field is beside the
    /// point for `settle_roots`, which reads and writes exactly one.
    fn at(cwd: &str) -> Session {
        Session {
            id: "s".into(),
            cwd: cwd.into(),
            branch: None,
            title: None,
            model: None,
            ctx_tokens: 0,
            born_at: None,
            last_at: None,
            bytes: 0,
        }
    }

    #[test]
    fn a_field_is_read_without_parsing_the_line() {
        let line = r#"{"type":"user","timestamp":"2026-08-11T05:38:38.213Z","cwd":"C:\\atelier\\caravan"}"#;
        assert_eq!(
            field(line, "timestamp"),
            Some("2026-08-11T05:38:38.213Z".into())
        );
        // The escaped separators have to survive, or nothing matches a project.
        assert_eq!(field(line, "cwd"), Some("C:\\atelier\\caravan".into()));
    }

    #[test]
    fn an_absent_field_is_absent_rather_than_wrong() {
        let line = r#"{"type":"queue-operation","operation":"enqueue"}"#;
        assert_eq!(field(line, "cwd"), None);
        assert_eq!(field(line, "timestamp"), None);
    }

    /// Tool output is full of text that looks like a field. Reading stops at the
    /// closing quote of the value, so a later mention cannot overwrite it.
    #[test]
    fn the_first_match_wins_and_stops_at_its_own_quote() {
        let line = r#"{"cwd":"C:\\atelier","content":"the \"cwd\":\"C:\\elsewhere\" was printed"}"#;
        assert_eq!(field(line, "cwd"), Some("C:\\atelier".into()));
    }

    /// A transcript with the fields at the top and the bottom and a megabyte of
    /// tool output in between — which is every real one, in miniature. What is
    /// asserted is that the reading is *unchanged* by the middle being skipped:
    /// the same cwd, the same title, the same occupancy as a full read gives.
    #[test]
    fn the_middle_of_a_large_transcript_is_not_read_and_costs_nothing() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let id = "11111111-2222-3333-4444-555555555555";
        let mut body = String::new();
        // The head: a summary first, as the CLI writes it — cwd is never on line one.
        body.push_str("{\"type\":\"summary\",\"summary\":\"an older thread\"}\n");
        body.push_str(
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"gitBranch\":\"main\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        );
        // The middle: one tool result of a megabyte, and nothing worth reading.
        body.push_str("{\"type\":\"user\",\"message\":{\"content\":\"");
        body.push_str(&"x".repeat(1024 * 1024));
        body.push_str("\"},\"timestamp\":\"2026-08-01T10:30:00.000Z\"}\n");
        // Padding, so head and tail cannot meet.
        for i in 0..400 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}},\"timestamp\":\"2026-08-01T11:{:02}:00.000Z\"}}\n",
                "y".repeat(1024),
                i % 60
            ));
        }
        // The tail: the last answered message, then the generated title.
        body.push_str(
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":90,\"cache_creation_input_tokens\":0,\"output_tokens\":100}},\"timestamp\":\"2026-08-02T09:00:00.000Z\"}\n",
        );
        body.push_str(
            "{\"type\":\"ai-title\",\"aiTitle\":\"the adoption panel\",\"timestamp\":\"2026-08-02T09:00:01.000Z\"}\n",
        );
        std::fs::write(proj.join(format!("{id}.jsonl")), &body).unwrap();

        let out = walk(&dir).unwrap();
        assert_eq!(out.len(), 1);
        let s = &out[0];
        assert_eq!(s.id, id);
        assert_eq!(s.cwd, "C:\\atelier\\skein");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.title.as_deref(), Some("the adoption panel"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(s.ctx_tokens, 200);
        /* Born at the top, last heard from at the bottom — and the bottom is
           the title record, which carries a timestamp of its own. Last-wins
           over every line, exactly as it was when every line was read. */
        assert_eq!(s.born_at.as_deref(), Some("2026-08-01T10:00:00.000Z"));
        assert_eq!(s.last_at.as_deref(), Some("2026-08-02T09:00:01.000Z"));
        assert!(s.bytes > 1024 * 1024);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The fallback, which is the reason `whole` exists. A transcript whose only
    /// answered message is in the middle is one the tail cannot see — and the
    /// answer is to read the rest, not to report a conversation with no model
    /// and an occupancy of zero.
    #[test]
    fn an_answer_only_in_the_middle_is_still_found() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let mut body = String::new();
        body.push_str(
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        );
        body.push_str(&format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n", "x".repeat(80 * 1024)));
        body.push_str(
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0,\"output_tokens\":2}},\"timestamp\":\"2026-08-01T10:01:00.000Z\"}\n",
        );
        /* Everything after it is bulk, and more than TAIL of it — so the tail
           read reaches back only into padding. */
        for _ in 0..400 {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n",
                "y".repeat(1024)
            ));
        }
        body.push_str(&format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n", "z".repeat(600 * 1024)));
        std::fs::write(proj.join("aaaa.jsonl"), &body).unwrap();

        let out = walk(&dir).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(out[0].ctx_tokens, 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A session with no answer in it at all is not offered, and neither is one
    /// that never said where it was — there is nothing to resume in either.
    #[test]
    fn a_transcript_with_nothing_to_resume_is_left_out() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        std::fs::write(
            proj.join("no-answer.jsonl"),
            "{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\"}\n",
        )
        .unwrap();
        std::fs::write(
            proj.join("no-cwd.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":1}}}\n",
        )
        .unwrap();
        // Not a transcript at all.
        std::fs::write(proj.join("notes.txt"), "nothing here\n").unwrap();

        assert!(walk(&dir).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Newest activity first, because that order *is* the panel's answer to
    /// "what was I just doing" — it is what you see before you have typed a
    /// thing, and a list nobody has sorted is a list nobody can read.
    #[test]
    fn the_catalogue_is_newest_first() {
        let dir = std::env::temp_dir().join(format!("skein-sessions-{}", crate::store::uuid_v4()));
        let proj = dir.join("C--atelier-skein");
        std::fs::create_dir_all(&proj).unwrap();

        let at = |ts: &str| {
            format!(
                "{{\"cwd\":\"C:\\\\atelier\\\\skein\",\"type\":\"user\",\"timestamp\":\"{ts}\"}}\n{{\"type\":\"assistant\",\"message\":{{\"model\":\"claude-opus-5\",\"usage\":{{\"input_tokens\":1}}}},\"timestamp\":\"{ts}\"}}\n"
            )
        };
        std::fs::write(proj.join("older.jsonl"), at("2026-07-01T10:00:00.000Z")).unwrap();
        std::fs::write(proj.join("newest.jsonl"), at("2026-08-19T10:00:00.000Z")).unwrap();
        std::fs::write(proj.join("middle.jsonl"), at("2026-08-01T10:00:00.000Z")).unwrap();

        let ids: Vec<String> = walk(&dir).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["newest", "middle", "older"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The bug this module grew `settle_roots` for, in the one shape a string
    /// test cannot reach: two spellings of one directory.
    ///
    /// A real junction, because that is what `C:\Users\lyss` is on the machine
    /// this was found on — and every string comparison in this file passed
    /// throughout, the same way every string test in `supervisor.rs` did when
    /// the resume half of it shipped (47e4d0f).
    #[test]
    fn a_session_under_a_junction_is_reported_where_the_wall_already_looks() {
        let base = std::env::temp_dir().join(format!("skein-sessions-junction-{}", std::process::id()));
        let (real, link) = (base.join("real"), base.join("link"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(real.join("codes").join("rise")).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .output()
            .is_ok_and(|o| o.status.success());
        if !made {
            /* No junction to be had — nothing to assert about one. Skipped
               rather than failed: `mklink` is not this crate's to guarantee. */
            let _ = std::fs::remove_dir_all(&base);
            return;
        }

        /* What the wall holds is the junction spelling — that is the path that
           was typed when the territory was made. What every transcript record
           says is the resolved one, because Windows resolves a reparse point
           when a process's current directory is opened. */
        let root = link.join("codes").join("rise").to_string_lossy().into_owned();
        let recorded = real.join("codes").join("rise").to_string_lossy().into_owned();
        assert_ne!(root, recorded, "the two spellings must differ, or this proves nothing");

        let mut sessions = vec![at(&recorded)];
        settle_roots(&mut sessions, &[root.clone()]);
        assert_eq!(sessions[0].cwd, root);

        let _ = std::fs::remove_dir_all(&link);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The two things it must never do, both against real directories: a
    /// session somewhere else stays where it was, and a session *inside* a
    /// territory is not swallowed by it. Only whole-directory identity counts —
    /// a worktree and a subfolder are their own places and a card in one is
    /// not a card in the territory's root.
    #[test]
    fn only_the_same_directory_is_folded_and_never_one_below_it() {
        let base = std::env::temp_dir().join(format!("skein-sessions-elsewhere-{}", std::process::id()));
        let (root, inside, other) = (base.join("rise"), base.join("rise").join("apps"), base.join("nova"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let root_s = root.to_string_lossy().into_owned();
        let mut sessions = vec![
            at(&inside.to_string_lossy()),
            at(&other.to_string_lossy()),
        ];
        let was: Vec<String> = sessions.iter().map(|s| s.cwd.clone()).collect();
        settle_roots(&mut sessions, &[root_s]);
        assert_eq!(sessions[0].cwd, was[0]);
        assert_eq!(sessions[1].cwd, was[1]);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A wall with no territories, and a territory that is not on this machine.
    /// Neither can match anything, and both must leave the catalogue exactly as
    /// the transcripts recorded it — an unrooted territory in particular, since
    /// `canonicalize` cannot answer for a path that is not there and a fallback
    /// that compared strings instead would match the wrong folder by its name.
    #[test]
    fn nothing_to_match_against_leaves_every_session_as_recorded() {
        let mut sessions = vec![at(r"C:\atelier\skein")];
        settle_roots(&mut sessions, &[]);
        assert_eq!(sessions[0].cwd, r"C:\atelier\skein");

        settle_roots(&mut sessions, &[r"D:\a-machine-this-is-not\skein".to_string()]);
        assert_eq!(sessions[0].cwd, r"C:\atelier\skein");
    }
}
