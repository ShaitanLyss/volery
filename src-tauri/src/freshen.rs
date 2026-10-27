//! Keeping Claude Code and its plugins current — by itself, and on a button.
//!
//! The team ships skills through a plugin marketplace (tx-toolkit, a git repo).
//! After a skill is pushed, every machine's marketplace clone and installed
//! plugin copy stay where they were until somebody runs the update commands, and
//! inside a card `/plugin` answers "isn't available in this environment" — so
//! nobody could update from the wall at all (sink 9e477f33: a card briefed to
//! load a skill pushed that morning got the September copy). This is the one
//! place that runs them.
//!
//! ### What it runs, and why it is the CLI's own commands
//!
//! Three kinds of step, in this order, one at a time:
//!
//! ```text
//! claude update                                         the CLI itself
//! claude plugin marketplace update <name> --json        each known marketplace
//! claude plugin update <plugin@market> --scope <s> --json   each install, per scope
//! ```
//!
//! **The marketplace goes first because a plugin update reads it**: refreshing
//! the clone alone moves no installed copy, and updating a plugin against a
//! stale clone finds nothing newer. Both are needed, in that order — verified by
//! hand on 2026-10-27.
//!
//! **Nothing here edits `installed_plugins.json` or `known_marketplaces.json`.**
//! They are read to make the plan and read again to say what is installed now;
//! every write is the CLI's. They are the CLI's files, and a second writer is a
//! race nobody here can see the other side of. That is also what makes a new
//! marketplace or a new project scope cost no code: the plan *is* those files.
//!
//! **A project scope runs in its project**, `cwd = projectPath` and `--scope
//! project` — the CLI resolves a project install from where it is run. One whose
//! folder has gone (a worktree deleted, a checkout moved) is skipped and says so,
//! rather than run from somewhere else where it would mean a different install.
//!
//! `--json` on both plugin commands is the CLI's own machine-readable line —
//! `{"command":"update","outcome":"ok","updateOutcome":"updated"|"up_to_date",
//! "oldVersion","newVersion","message"}` and `{"command":"marketplace-update",
//! "outcome":"ok","message"}`, probed against 2.1.311. `claude update` has no
//! such flag, so it is read as text, and its three sentences are in the tests.
//!
//! ### What it never does
//!
//! - **Pass `-y`.** A plugin whose marketplace changed its install command asks
//!   a person to confirm the new command, and refuses without `-y` when nobody
//!   can. That refusal is the right answer for a background job: the failure's
//!   first line says so, and the person runs it where they can read it.
//! - **Ask a question from the background.** The marketplace is a git fetch, and
//!   a credential that expired would pop a sign-in window over the wall from a
//!   run nobody started (CLAUDE.md, "A background poll must never ask a
//!   question"). The automatic run sets `GIT_TERMINAL_PROMPT=0` and
//!   `credential.interactive=false`; the button does not, because a person
//!   pressed it and a sign-in is then a question they can answer.
//! - **Restart a card.** Every running card keeps the CLI and the plugin copy it
//!   started with until its process goes. Which cards those are is the front
//!   end's reading (`freshen.ts`), and standing them down is `Skein`'s, through
//!   the reaper's own lossless path — never mid-turn.
//!
//! ### When
//!
//! Once a minute after launch, then every `every_hours` (six unless set), and
//! never while one is running. The clock is a condvar wait aimed at the next due
//! moment rather than a tick, so a settings change wakes it at once and an idle
//! wall pays one sleeping thread. **Not in a development build** unless
//! `VOLERY_FRESHEN_AUTO` is set: a lab wall and the installed wall would both be
//! updating the same `~/.claude` on their own schedules, and two CLIs writing
//! `installed_plugins.json` at once is the race the paragraph above declines to
//! be in. The button works everywhere.
//!
//! ### What is kept
//!
//! `freshen.json` in the app data directory: the settings, the last run item by
//! item, and when something last actually changed (which is what a card with no
//! `system/init` yet is compared against). Every failure is also a `warn!` in
//! `logs/volery.log`, so a card asked "why did the plugin not update" can read
//! the answer rather than guess it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/* ── what a run is made of ───────────────────────────────────────────────── */

/// One thing to bring up to date.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// `cli`, `marketplace` or `plugin`.
    pub kind: String,
    /// The marketplace's name, or the plugin's `name@marketplace` key. `claude`
    /// for the CLI.
    pub name: String,
    /// A plugin install's scope — `user`, `project`, `local`.
    #[serde(default)]
    pub scope: Option<String>,
    /// The project a non-user scope belongs to, as `installed_plugins.json`
    /// spells it.
    #[serde(default)]
    pub project: Option<String>,
    /// `waiting`, `running`, `updated`, `current`, `skipped` or `failed`.
    pub state: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// Why it was skipped, or the first line of what the failure said.
    #[serde(default)]
    pub said: Option<String>,
}

impl Item {
    fn new(kind: &str, name: &str, scope: Option<&str>, project: Option<&str>) -> Item {
        Item {
            kind: kind.into(),
            name: name.into(),
            scope: scope.map(str::to_string),
            project: project.map(str::to_string),
            state: "waiting".into(),
            from: None,
            to: None,
            said: None,
        }
    }
}

/// A plugin as it is installed, read back out of `installed_plugins.json`.
/// What the front end compares a card's `system/init` plugin paths against.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub key: String,
    pub scope: String,
    pub project: Option<String>,
    pub path: String,
    pub version: Option<String>,
}

/// Read every install out of `installed_plugins.json`.
///
/// Version 2 maps a key to a *list* of installs, one per scope; an older file
/// mapped it to one. Both are read, and anything else is no installs rather than
/// an error — a run with nothing to update is a run, not a fault.
pub fn read_installs(said: &str) -> Vec<Install> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(said) else {
        return vec![];
    };
    let Some(plugins) = v.get("plugins").and_then(|p| p.as_object()) else {
        return vec![];
    };
    let mut out = vec![];
    for (key, entry) in plugins {
        let list: Vec<&serde_json::Value> = match entry {
            serde_json::Value::Array(a) => a.iter().collect(),
            o @ serde_json::Value::Object(_) => vec![o],
            _ => continue,
        };
        for one in list {
            let s = |k: &str| one.get(k).and_then(|x| x.as_str()).map(str::to_string);
            out.push(Install {
                key: key.clone(),
                scope: s("scope").unwrap_or_else(|| "user".into()),
                project: s("projectPath"),
                path: s("installPath").unwrap_or_default(),
                version: s("version"),
            });
        }
    }
    out
}

/// The marketplaces' names, out of `known_marketplaces.json`. Sorted, so a run
/// reads the same way every time.
pub fn read_marketplaces(said: &str) -> Vec<String> {
    let mut names: Vec<String> = serde_json::from_str::<serde_json::Value>(said)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect()))
        .unwrap_or_default();
    names.sort();
    names
}

/// The whole run, in order, before any of it happens.
///
/// `exists` is asked of each project path, so the test can say which folders
/// are there without making any. A project scope whose folder has gone is in
/// the plan already `skipped`, so the list says what was not done as well as
/// what was. `managed` is skipped too: an organisation's managed install is not
/// this machine's to move.
pub fn plan(
    marketplaces: &[String],
    installs: &[Install],
    exists: impl Fn(&str) -> bool,
) -> Vec<Item> {
    let mut items = vec![Item::new("cli", "claude", None, None)];
    for m in marketplaces {
        items.push(Item::new("marketplace", m, None, None));
    }
    let mut seen: Vec<(String, String, Option<String>)> = vec![];
    let mut sorted: Vec<&Install> = installs.iter().collect();
    /* User scope first within a plugin: it is the one every card has, and the
       one somebody pushing a skill is waiting on. */
    sorted.sort_by(|a, b| {
        (a.key.as_str(), a.scope != "user", a.project.as_deref())
            .cmp(&(b.key.as_str(), b.scope != "user", b.project.as_deref()))
    });
    for i in sorted {
        let id = (i.key.clone(), i.scope.clone(), i.project.clone());
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        let mut item = Item::new("plugin", &i.key, Some(&i.scope), i.project.as_deref());
        item.from = i.version.clone();
        if i.scope == "managed" {
            item.state = "skipped".into();
            item.said = Some("managed by your organisation".into());
        } else if i.scope != "user" {
            match i.project.as_deref() {
                None => {
                    item.state = "skipped".into();
                    item.said = Some("no project folder is recorded for it".into());
                }
                Some(p) if !exists(p) => {
                    item.state = "skipped".into();
                    item.said = Some("its project folder is gone".into());
                }
                _ => {}
            }
        }
        items.push(item);
    }
    items
}

/* ── reading what the CLI said ───────────────────────────────────────────── */

/// What one step came to.
#[derive(Debug, PartialEq)]
pub enum Came {
    Updated { from: Option<String>, to: Option<String> },
    Current(Option<String>),
    Skipped(String),
    Failed(String),
}

/// The first line worth reading out of something that went wrong — the CLI's
/// own words, trimmed to what a row has room for. Leading marks (`✘`, `Error:`)
/// are kept: they are part of what it said.
pub fn first_line(said: &str) -> String {
    let line = said
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    let line = crate::clean::scrub(&line).into_owned();
    if line.chars().count() > 200 {
        let cut: String = line.chars().take(199).collect();
        format!("{cut}…")
    } else {
        line
    }
}

/// `claude update`. Three sentences, from 2.1.304 → 2.1.311 by hand and
/// 2.1.311 up to date (2026-10-27):
///
/// ```text
/// Current version: 2.1.311
/// Checking for updates to latest version...
/// Claude Code is up to date (2.1.311)
///
/// Successfully updated from 2.1.304 to version 2.1.311
/// ```
pub fn read_cli(ok: bool, out: &str, err: &str) -> Came {
    let after = |line: &str, key: &str| -> Option<String> {
        line.find(key).map(|i| line[i + key.len()..].trim().to_string())
    };
    let mut current = None;
    for line in out.lines().chain(err.lines()).map(str::trim) {
        if let Some(rest) = after(line, "Successfully updated from ") {
            let mut parts = rest.splitn(2, " to version ");
            let from = parts.next().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let to = parts
                .next()
                .map(|s| s.trim().trim_end_matches('.').to_string())
                .filter(|s| !s.is_empty());
            return Came::Updated { from, to };
        }
        if let Some(rest) = after(line, "is up to date (") {
            return Came::Current(Some(rest.trim_end_matches(')').trim().to_string()));
        }
        if let Some(rest) = after(line, "Current version: ") {
            current = Some(rest.to_string()).filter(|s| !s.is_empty());
        }
    }
    if ok {
        Came::Current(current)
    } else {
        Came::Failed(failure(out, err))
    }
}

/// The JSON line a `--json` run ends on: the last line that parses and names
/// the command asked for. Earlier lines can be progress, and a later stray one
/// should not shadow it.
fn json_line(out: &str, command: &str) -> Option<serde_json::Value> {
    out.lines().rev().find_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l.trim()).ok()?;
        (v.get("command")?.as_str()? == command).then_some(v)
    })
}

fn failure(out: &str, err: &str) -> String {
    let e = first_line(err);
    if !e.is_empty() {
        return e;
    }
    let o = first_line(out);
    if o.is_empty() {
        "it failed and said nothing".into()
    } else {
        o
    }
}

/// `claude plugin marketplace update <name> --json`.
pub fn read_marketplace(ok: bool, out: &str, err: &str) -> Came {
    if let Some(v) = json_line(out, "marketplace-update") {
        let outcome = v.get("outcome").and_then(|o| o.as_str()).unwrap_or("");
        let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
        if ok && outcome == "ok" {
            return Came::Updated { from: None, to: None };
        }
        return Came::Failed(if message.is_empty() { failure(out, err) } else { last_line(message) });
    }
    if ok && out.contains("Successfully updated marketplace") {
        return Came::Updated { from: None, to: None };
    }
    Came::Failed(failure(out, err))
}

/// The last non-empty line — a marketplace message is a progress line and then
/// the verdict, and the verdict is the part worth a row.
fn last_line(said: &str) -> String {
    first_line(&said.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or(""))
}

/// `claude plugin update <key> --scope <s> --json`.
pub fn read_plugin(ok: bool, out: &str, err: &str) -> Came {
    if let Some(v) = json_line(out, "update") {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
        let message = s("message").unwrap_or_default();
        if !ok || s("outcome").as_deref() != Some("ok") {
            return Came::Failed(if message.is_empty() { failure(out, err) } else { first_line(&message) });
        }
        return match s("updateOutcome").as_deref() {
            Some("updated") => Came::Updated { from: s("oldVersion"), to: s("newVersion") },
            Some("up_to_date") => Came::Current(s("newVersion").or(s("oldVersion"))),
            /* Skipped, blocked, or a word a later CLI adds: not a failure,
               since the command said ok, and not "current", since it did not
               say that either. Its own sentence is the honest row. */
            _ => Came::Skipped(if message.is_empty() { "the CLI left it as it was".into() } else { first_line(&message) }),
        };
    }
    /* The human sentence, for a CLI that stops honouring `--json`. */
    for line in out.lines().map(str::trim) {
        if let Some(i) = line.find(" updated from ") {
            let rest = &line[i + " updated from ".len()..];
            let mut parts = rest.splitn(2, " to ");
            let from = parts.next().map(|s| s.trim().to_string());
            let to = parts
                .next()
                .and_then(|s| s.split_whitespace().next())
                .map(|s| s.to_string());
            if ok {
                return Came::Updated { from, to };
            }
        }
        if ok && line.contains("already at the latest version") {
            return Came::Current(None);
        }
    }
    if ok {
        Came::Current(None)
    } else {
        Came::Failed(failure(out, err))
    }
}

fn settle(item: &mut Item, came: Came) {
    match came {
        Came::Updated { from, to } => {
            item.state = if from.is_some() && from == to { "current" } else { "updated" }.into();
            if from.is_some() {
                item.from = from;
            }
            item.to = to;
        }
        Came::Current(v) => {
            item.state = "current".into();
            /* The CLI can call a scope current at a version its own install
               record for that scope does not name — seen 2026-10-27 on a
               project scope recorded at bc2b8549769b, answered "already at
               8d5c04d1b46a", apparently resolved across scopes. Nothing here
               may mend the record, so the row keeps what the record said and
               says what the CLI said, rather than overwrite one with the
               other and hide that they differ. */
            match (&item.from, &v) {
                (Some(rec), Some(said)) if rec != said => {
                    item.said = Some(format!(
                        "the CLI calls it current at {said}; its install record for this scope still names {rec}"
                    ));
                }
                (None, Some(_)) => item.from = v.clone(),
                _ => {}
            }
            item.to = v.or(item.from.clone());
        }
        Came::Skipped(why) => {
            item.state = "skipped".into();
            item.said = Some(why);
        }
        Came::Failed(why) => {
            item.state = "failed".into();
            item.said = Some(why);
        }
    }
}

/* ── when ────────────────────────────────────────────────────────────────── */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub auto: bool,
    pub every_hours: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto: true, every_hours: DEFAULT_HOURS }
    }
}

const DEFAULT_HOURS: f64 = 6.0;
/// Inside these, so a settings field cannot ask for a run every second or once
/// a century.
const MIN_HOURS: f64 = 1.0;
const MAX_HOURS: f64 = 168.0;
/// After launch, before the first automatic run: long enough for the wall to
/// have painted and rousing to have taken what it needs, short enough that a
/// skill pushed overnight is there by the first coffee.
const LAUNCH_GRACE_MS: i64 = 60_000;

fn clamp_hours(h: f64) -> f64 {
    if h.is_finite() {
        h.clamp(MIN_HOURS, MAX_HOURS)
    } else {
        DEFAULT_HOURS
    }
}

/// When the next automatic run is due, in epoch ms — `None` when it is off.
/// Never before the launch grace, and never sooner than `every_hours` after the
/// last run *started* (a run that took two minutes does not push the clock).
pub fn next_due(settings: &Settings, last_started: Option<i64>, launched: i64) -> Option<i64> {
    if !settings.auto {
        return None;
    }
    let floor = launched + LAUNCH_GRACE_MS;
    let every = (clamp_hours(settings.every_hours) * 3_600_000.0) as i64;
    Some(match last_started {
        Some(t) => (t + every).max(floor),
        None => floor,
    })
}

/* ── the state, on disk and in memory ────────────────────────────────────── */

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// `auto` or `button`.
    pub trigger: String,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Kept {
    #[serde(default)]
    settings: Settings,
    #[serde(default)]
    last: Option<Run>,
    /// When a run last moved anything. A card whose process is older than this
    /// and has said nothing about itself yet is on the old copy.
    #[serde(default)]
    changed_at: Option<i64>,
}

/// What the front end draws, whole, on every change.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    settings: Settings,
    last: Option<Run>,
    changed_at: Option<i64>,
    running: bool,
    /// The automatic run is suppressed in a development build; the panel says
    /// so rather than offering a switch that does nothing.
    auto_allowed: bool,
    next_due: Option<i64>,
    installs: Vec<Install>,
}

pub struct Freshen {
    file: PathBuf,
    plugins: PathBuf,
    launched: i64,
    inner: Mutex<(Kept, bool)>,
    /// Woken when the settings change or a run ends, so the scheduler re-aims.
    nudge: Condvar,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn auto_allowed() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("VOLERY_FRESHEN_AUTO").is_some()
}

impl Freshen {
    fn open(data: &Path, home: &Path) -> Freshen {
        let file = data.join("freshen.json");
        let kept: Kept = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Freshen {
            file,
            plugins: home.join(".claude").join("plugins"),
            launched: now_ms(),
            inner: Mutex::new((kept, false)),
            nudge: Condvar::new(),
        }
    }

    fn installs(&self) -> Vec<Install> {
        std::fs::read_to_string(self.plugins.join("installed_plugins.json"))
            .map(|s| read_installs(&s))
            .unwrap_or_default()
    }

    fn snapshot(&self) -> Snapshot {
        let (kept, running) = self.inner.lock().map(|g| (g.0.clone(), g.1)).unwrap_or_default();
        let due = if auto_allowed() {
            next_due(&kept.settings, kept.last.as_ref().map(|r| r.started_at), self.launched)
        } else {
            None
        };
        Snapshot {
            settings: kept.settings,
            last: kept.last,
            changed_at: kept.changed_at,
            running,
            auto_allowed: auto_allowed(),
            next_due: due,
            installs: self.installs(),
        }
    }

    fn save(&self, kept: &Kept) {
        if let Ok(s) = serde_json::to_string_pretty(kept) {
            if let Err(e) = std::fs::write(&self.file, s) {
                log::warn!("freshen: could not keep the last run in {}: {e}", self.file.display());
            }
        }
    }
}

fn announce(app: &AppHandle) {
    let f = app.state::<Freshen>();
    let _ = app.emit("freshen:changed", f.snapshot());
}

/* ── running it ──────────────────────────────────────────────────────────── */

#[cfg(windows)]
fn quiet(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn quiet(_: &mut Command) {}

/// Run one command to its end or its timeout. In a job like every other spawn
/// (CLAUDE.md): a timed-out `claude` is killed with whatever git it started.
fn call(program: &str, args: &[&str], cwd: Option<&Path>, asking: bool, limit: Duration) -> (bool, String, String) {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        /* A wall started from inside a card would hand these on, and a CLI
           that thinks it is nested inside another session may refuse. */
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT");
    if !asking {
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "credential.interactive")
            .env("GIT_CONFIG_VALUE_0", "false");
    }
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    quiet(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, String::new(), format!("could not run claude: {e}")),
    };
    let job = crate::servers::jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }
    use std::io::Read;
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = so.as_mut() {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = se.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let until = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if std::time::Instant::now() < until => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                break None;
            }
        }
    };
    /* Dropping the job takes down anything the child left behind, which is
       also what lets the pipes close when it timed out holding a grandchild. */
    drop(job);
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    match status {
        Some(s) => (s.success(), out, err),
        None => (
            false,
            out,
            format!("gave up after {} minutes with no answer", limit.as_secs() / 60),
        ),
    }
}

const CLI_LIMIT: Duration = Duration::from_secs(300);
const STEP_LIMIT: Duration = Duration::from_secs(180);

/// One whole run, start to finish, on the calling thread. Refuses to start a
/// second while one is going and returns false then.
fn run(app: &AppHandle, trigger: &str) -> bool {
    let f = app.state::<Freshen>();
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(_) => return false,
    };
    let marketplaces = std::fs::read_to_string(f.plugins.join("known_marketplaces.json"))
        .map(|s| read_marketplaces(&s))
        .unwrap_or_default();
    let items = plan(&marketplaces, &f.installs(), |p| Path::new(p).is_dir());
    let started = now_ms();
    {
        let Ok(mut g) = f.inner.lock() else { return false };
        if g.1 {
            return false;
        }
        g.1 = true;
        g.0.last = Some(Run { trigger: trigger.into(), started_at: started, finished_at: None, items });
    }
    announce(app);

    let program = crate::claude::program(&home);
    let asking = trigger == "button";
    let mut moved = false;
    let count = f.inner.lock().ok().and_then(|g| g.0.last.as_ref().map(|r| r.items.len())).unwrap_or(0);
    for i in 0..count {
        let Some(item) = f.inner.lock().ok().and_then(|mut g| {
            let it = g.0.last.as_mut()?.items.get_mut(i)?;
            if it.state != "waiting" {
                return None;
            }
            it.state = "running".into();
            Some(it.clone())
        }) else {
            continue;
        };
        announce(app);

        let came = match item.kind.as_str() {
            "cli" => {
                let (ok, out, err) = call(&program, &["update"], None, asking, CLI_LIMIT);
                read_cli(ok, &out, &err)
            }
            "marketplace" => {
                let (ok, out, err) = call(
                    &program,
                    &["plugin", "marketplace", "update", &item.name, "--json"],
                    None,
                    asking,
                    STEP_LIMIT,
                );
                read_marketplace(ok, &out, &err)
            }
            _ => {
                let scope = item.scope.clone().unwrap_or_else(|| "user".into());
                let cwd = (scope != "user").then(|| item.project.clone()).flatten().map(PathBuf::from);
                let (ok, out, err) = call(
                    &program,
                    &["plugin", "update", &item.name, "--scope", &scope, "--json"],
                    cwd.as_deref(),
                    asking,
                    STEP_LIMIT,
                );
                read_plugin(ok, &out, &err)
            }
        };
        if let Came::Failed(why) = &came {
            let at = match (&item.scope, &item.project) {
                (Some(s), Some(p)) => format!(" ({s} scope, {p})"),
                (Some(s), None) => format!(" ({s} scope)"),
                _ => String::new(),
            };
            log::warn!("freshen: {} {}{at} did not update — {why}", item.kind, item.name);
        }
        if let Ok(mut g) = f.inner.lock() {
            if let Some(it) = g.0.last.as_mut().and_then(|r| r.items.get_mut(i)) {
                settle(it, came);
                /* A marketplace refreshed is not a change any card runs on —
                   only the CLI and the installed copies are. */
                if it.state == "updated" && it.kind != "marketplace" {
                    moved = true;
                }
            }
        }
        announce(app);
    }

    let snapshot = {
        let Ok(mut g) = f.inner.lock() else { return true };
        let done = now_ms();
        if let Some(r) = g.0.last.as_mut() {
            r.finished_at = Some(done);
        }
        if moved {
            g.0.changed_at = Some(done);
        }
        g.1 = false;
        g.0.clone()
    };
    f.save(&snapshot);
    f.nudge.notify_all();
    let failed = snapshot
        .last
        .as_ref()
        .map(|r| r.items.iter().filter(|i| i.state == "failed").count())
        .unwrap_or(0);
    log::info!(
        "freshen: {trigger} run finished — {}{}",
        if moved { "something moved" } else { "nothing moved" },
        if failed > 0 { format!(", {failed} failed") } else { String::new() }
    );
    announce(app);
    true
}

/// Start the scheduler. Called once from `open_wall`.
pub fn start(app: &AppHandle) {
    let data = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let home = app.path().home_dir().unwrap_or_else(|_| PathBuf::from("."));
    app.manage(Freshen::open(&data, &home));
    if !auto_allowed() {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new().name("freshen".into()).spawn(move || loop {
        let f = app.state::<Freshen>();
        let due = {
            let Ok(g) = f.inner.lock() else { return };
            next_due(&g.0.settings, g.0.last.as_ref().map(|r| r.started_at), f.launched)
        };
        let wait = match due {
            Some(t) => (t - now_ms()).max(0) as u64,
            /* Off: sleep until somebody changes the setting. An hour is only
               the bound on a missed notify, not a clock anything waits on. */
            None => 3_600_000,
        };
        if due.is_some() && wait == 0 {
            run(&app, "auto");
            continue;
        }
        if let Ok(g) = f.inner.lock() {
            let _ = f.nudge.wait_timeout(g, Duration::from_millis(wait.min(3_600_000)));
        };
    });
}

/* ── the tool a card can call ───────────────────────────────────────────── */

/// A card calls this as `mcp__skein__update_claude`.
pub const FRESHEN_TOOL: &str = "update_claude";

/// Deferred, found by its hint. Asked for 2026-10-27 ("make sure agents can
/// trigger plugins update as well and claude cli update"): an orchestrator that
/// has just pushed a skill to the marketplace is exactly the party that knows a
/// refresh is due, and `/plugin` is not available inside a card. The hint
/// carries the words of that moment — *pushed a skill*, *stale plugin*, *skill
/// not found* — because a card searching here is holding the symptom, not the
/// name.
pub fn freshen_schema() -> serde_json::Value {
    serde_json::json!({
        "name": FRESHEN_TOOL,
        "description":
            "Bring Claude Code and the installed Claude Code plugins on this machine up to \
             date, the same run as the accounts panel's button: `claude update`, then every \
             known plugin marketplace refreshed, then every installed plugin updated in every \
             scope it is installed in (a project scope from its own folder; one whose folder \
             is gone is skipped). Call it after pushing a skill or a plugin change to a \
             marketplace, or when a skill a brief names is missing or out of date — `/plugin` \
             does not work inside a card.\n\n\
             It waits for the run (usually under a minute, at most about four) and answers \
             item by item: what moved from what to what, what was already current, and the \
             first line of anything that failed. `status: true` only reads the last run \
             without starting one.\n\n\
             **An update reaches the next process, never a running one** — yours included. \
             This card and every card already running keep the CLI and the plugin copy they \
             started with. A card opened after this starts on the new copy; the person can \
             restart the cards on the old copy from the accounts panel (space then a), which \
             only stands down cards with nothing in flight. Do not try to restart yourself.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "boolean",
                    "description": "Only read the last run; start nothing."
                }
            }
        }
    })
}

/// One run, said for an agent: a line per item and what to do about it.
pub fn say_run(run: &Run, running: bool, now: i64) -> String {
    let when = |ms: i64| {
        let ago = (now - ms).max(0) / 60_000;
        if ago < 1 {
            "just now".to_string()
        } else {
            format!("{ago} min ago")
        }
    };
    let mut out = if running {
        format!("An update run (started {} by {}) is still going:\n", when(run.started_at), run.trigger)
    } else {
        format!(
            "Last update run, {} ({}):\n",
            run.finished_at.map(when).unwrap_or_else(|| "unfinished".into()),
            match run.trigger.as_str() {
                "auto" => "automatic",
                "button" => "the button",
                _ => "asked by a card",
            }
        )
    };
    let mut moved = false;
    let mut failed = false;
    for i in &run.items {
        let what = match (i.kind.as_str(), &i.scope, &i.project) {
            ("cli", _, _) => "claude code".to_string(),
            ("marketplace", _, _) => format!("{} marketplace", i.name),
            (_, Some(s), Some(p)) if s != "user" => format!("{} ({s} scope, {p})", i.name),
            (_, Some(s), _) => format!("{} ({s} scope)", i.name),
            _ => i.name.clone(),
        };
        let v = |x: &Option<String>| x.clone().unwrap_or_else(|| "?".into());
        let came = match i.state.as_str() {
            "updated" | "current" if i.kind == "marketplace" => "refreshed".to_string(),
            "updated" => {
                moved = true;
                format!("updated {} → {}", v(&i.from), v(&i.to))
            }
            "current" => format!("already current ({})", v(&i.to)),
            "skipped" => format!("skipped — {}", i.said.clone().unwrap_or_default()),
            "failed" => {
                failed = true;
                format!("FAILED — {}", i.said.clone().unwrap_or_default())
            }
            "running" => "running now…".into(),
            _ => "waiting".into(),
        };
        out.push_str(&format!("- {what}: {came}\n"));
    }
    if running {
        out.push_str("\nCall this again with `status: true` in a minute to read the result.");
        return out;
    }
    if moved {
        out.push_str(
            "\nWhat moved reaches the next process only: cards already running (this one \
             included) keep their old copy until they restart. A card opened now starts on \
             the new one; tell the person if a running card needs the new skills — they can \
             restart idle cards from the accounts panel (space then a).",
        );
    }
    if failed {
        out.push_str(
            "\nEach failure is also in `logs/volery.log` under `freshen:`. A plugin that asks \
             to confirm a changed install command is refused here on purpose; the person runs \
             `claude plugin update <name>` in a terminal to read and accept it.",
        );
    }
    out
}

/// How long the tool waits for a run before answering "still going". Under the
/// 300s clock Bun's `fetch` holds every MCP call to (`ask.md`), with room.
const TOOL_WAIT: Duration = Duration::from_secs(240);

/// Route a `tools/call` that belongs to this file. Blocking, on the MCP
/// request's own thread, so it parks nobody but its caller.
pub fn handle(app: &AppHandle, caller: &str, tool: &str, args: &serde_json::Value) -> Option<String> {
    (tool == FRESHEN_TOOL).then(|| answer(app, caller, args))
}

fn busy(f: &Freshen) -> bool {
    f.inner.lock().map(|g| g.1).unwrap_or(false)
}

fn answer(app: &AppHandle, caller: &str, args: &serde_json::Value) -> String {
    let Some(f) = app.try_state::<Freshen>() else {
        return "The updater is not running on this wall.".into();
    };
    let status = args.get("status").and_then(|v| v.as_bool()).unwrap_or(false);
    if !status {
        let chat = app
            .try_state::<crate::store::Store>()
            .and_then(|s| s.0.lock().ok().and_then(|c| crate::store::roster_one(&c, caller)))
            .map(|me| me.kind == "chat")
            .unwrap_or(false);
        if chat {
            return "This is a chat card: it reaches nothing on this machine, so it does not \
                    update the software on it either. Nothing was done."
                .into();
        }
        if !busy(&f) {
            let app2 = app.clone();
            let _ = std::thread::Builder::new()
                .name("freshen-card".into())
                .spawn(move || {
                    run(&app2, "card");
                });
            /* Let the run claim the latch before the wait below reads it. */
            let until = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < until && !busy(&f) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let until = std::time::Instant::now() + TOOL_WAIT;
        while std::time::Instant::now() < until && busy(&f) {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    let (last, running) = f
        .inner
        .lock()
        .map(|g| (g.0.last.clone(), g.1))
        .unwrap_or((None, false));
    match last {
        Some(r) => say_run(&r, running, now_ms()),
        None => "No update has run on this wall yet. Call this without `status` to run one.".into(),
    }
}

/* ── commands ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn freshen_state(app: AppHandle) -> Result<Snapshot, String> {
    crate::off_main(move || app.state::<Freshen>().snapshot()).await
}

/// The button. Returns at once; the run reports itself on `freshen:changed`.
/// False when a run is already going — the panel is already drawing that one.
#[tauri::command]
pub async fn freshen_now(app: AppHandle) -> Result<bool, String> {
    let busy = app.state::<Freshen>().inner.lock().map(|g| g.1).unwrap_or(true);
    if busy {
        return Ok(false);
    }
    std::thread::Builder::new()
        .name("freshen-now".into())
        .spawn(move || {
            run(&app, "button");
        })
        .map_err(|e| format!("could not start the update: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn freshen_settings(app: AppHandle, auto: bool, every_hours: f64) -> Result<Snapshot, String> {
    crate::off_main(move || {
        let f = app.state::<Freshen>();
        let kept = {
            let mut g = f.inner.lock().map_err(|_| "the updater is wedged".to_string())?;
            g.0.settings = Settings { auto, every_hours: clamp_hours(every_hours) };
            g.0.clone()
        };
        f.save(&kept);
        f.nudge.notify_all();
        let snap = f.snapshot();
        let _ = app.emit("freshen:changed", snap.clone());
        Ok(snap)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALLED: &str = r#"{
      "version": 2,
      "plugins": {
        "lua-lsp@claude-plugins-official": [
          { "scope": "user", "installPath": "C:\\c\\lua\\1.0.0", "version": "1.0.0" }
        ],
        "tx-toolkit@tx-squad": [
          { "scope": "project", "projectPath": "C:\\codes\\rise",
            "installPath": "C:\\c\\tx\\8d5c04d1b46a", "version": "8d5c04d1b46a" },
          { "scope": "user", "installPath": "C:\\c\\tx\\8d5c04d1b46a", "version": "8d5c04d1b46a" },
          { "scope": "project", "projectPath": "C:\\codes\\gone",
            "installPath": "C:\\c\\tx\\bc2b8549769b", "version": "bc2b8549769b" }
        ]
      }
    }"#;

    #[test]
    fn installs_are_read_per_scope() {
        let i = read_installs(INSTALLED);
        assert_eq!(i.len(), 4);
        let tx: Vec<_> = i.iter().filter(|x| x.key == "tx-toolkit@tx-squad").collect();
        assert_eq!(tx.len(), 3);
        assert!(tx.iter().any(|x| x.scope == "user" && x.project.is_none()));
        assert!(tx.iter().any(|x| x.project.as_deref() == Some("C:\\codes\\rise")));
    }

    #[test]
    fn an_older_file_with_one_install_per_key_is_read_too() {
        let i = read_installs(r#"{"plugins":{"a@m":{"scope":"user","installPath":"p"}}}"#);
        assert_eq!(i, vec![Install { key: "a@m".into(), scope: "user".into(), project: None, path: "p".into(), version: None }]);
    }

    #[test]
    fn a_file_that_is_not_the_record_is_no_installs() {
        assert!(read_installs("not json").is_empty());
        assert!(read_installs(r#"{"version":2}"#).is_empty());
    }

    #[test]
    fn the_plan_is_cli_then_marketplaces_then_every_scope() {
        let m = read_marketplaces(r#"{"tx-squad":{},"claude-plugins-official":{}}"#);
        assert_eq!(m, vec!["claude-plugins-official", "tx-squad"]);
        let p = plan(&m, &read_installs(INSTALLED), |p| p != "C:\\codes\\gone");
        let kinds: Vec<_> = p.iter().map(|i| (i.kind.as_str(), i.name.as_str(), i.scope.as_deref())).collect();
        assert_eq!(
            kinds,
            vec![
                ("cli", "claude", None),
                ("marketplace", "claude-plugins-official", None),
                ("marketplace", "tx-squad", None),
                ("plugin", "lua-lsp@claude-plugins-official", Some("user")),
                ("plugin", "tx-toolkit@tx-squad", Some("user")),
                ("plugin", "tx-toolkit@tx-squad", Some("project")),
                ("plugin", "tx-toolkit@tx-squad", Some("project")),
            ]
        );
    }

    #[test]
    fn a_project_whose_folder_is_gone_is_skipped_and_says_so() {
        let p = plan(&[], &read_installs(INSTALLED), |p| p != "C:\\codes\\gone");
        let gone = p.iter().find(|i| i.project.as_deref() == Some("C:\\codes\\gone")).unwrap();
        assert_eq!(gone.state, "skipped");
        assert_eq!(gone.said.as_deref(), Some("its project folder is gone"));
        let here = p.iter().find(|i| i.project.as_deref() == Some("C:\\codes\\rise")).unwrap();
        assert_eq!(here.state, "waiting");
        assert_eq!(here.from.as_deref(), Some("8d5c04d1b46a"));
    }

    #[test]
    fn a_managed_install_is_not_this_machines_to_move() {
        let i = vec![Install { key: "a@m".into(), scope: "managed".into(), project: None, path: "p".into(), version: None }];
        assert_eq!(plan(&[], &i, |_| true)[1].state, "skipped");
    }

    #[test]
    fn the_cli_reads_updated_current_and_failed() {
        assert_eq!(
            read_cli(true, "Current version: 2.1.304\nChecking for updates to latest version...\nSuccessfully updated from 2.1.304 to version 2.1.311\n", ""),
            Came::Updated { from: Some("2.1.304".into()), to: Some("2.1.311".into()) }
        );
        assert_eq!(
            read_cli(true, "Current version: 2.1.311\nChecking for updates to latest version...\nClaude Code is up to date (2.1.311)\n", ""),
            Came::Current(Some("2.1.311".into()))
        );
        assert_eq!(read_cli(true, "Current version: 2.1.311\n", ""), Came::Current(Some("2.1.311".into())));
        assert_eq!(
            read_cli(false, "Current version: 2.1.311\n", "\nError: EACCES: permission denied, rename 'claude.exe'\n  at x\n"),
            Came::Failed("Error: EACCES: permission denied, rename 'claude.exe'".into())
        );
        assert_eq!(read_cli(false, "", ""), Came::Failed("it failed and said nothing".into()));
    }

    #[test]
    fn a_marketplace_reads_its_json_line() {
        let ok = r#"{"command":"marketplace-update","outcome":"ok","marketplace":"tx-squad","message":"Refreshing marketplace cache (timeout: 120s)…\nSuccessfully updated marketplace: tx-squad"}"#;
        assert_eq!(read_marketplace(true, ok, ""), Came::Updated { from: None, to: None });
        let bad = r#"{"command":"marketplace-update","outcome":"error","message":"Refreshing…\nFailed to update marketplace tx-squad: git fetch failed"}"#;
        assert_eq!(read_marketplace(false, bad, ""), Came::Failed("Failed to update marketplace tx-squad: git fetch failed".into()));
        assert_eq!(
            read_marketplace(false, "", "fatal: Authentication failed for 'https://dev.azure.com/…'\n"),
            Came::Failed("fatal: Authentication failed for 'https://dev.azure.com/…'".into())
        );
        assert_eq!(read_marketplace(true, "Successfully updated marketplace: tx-squad\n", ""), Came::Updated { from: None, to: None });
    }

    #[test]
    fn a_plugin_reads_updated_current_skipped_and_failed() {
        let up = r#"{"command":"update","outcome":"ok","plugin":"tx-toolkit@tx-squad","scope":"user","message":"Plugin \"tx-toolkit\" updated from 69c07eef4031 to 8d5c04d1b46a for scope user. Restart to apply changes.","updateOutcome":"updated","oldVersion":"69c07eef4031","newVersion":"8d5c04d1b46a"}"#;
        assert_eq!(read_plugin(true, up, ""), Came::Updated { from: Some("69c07eef4031".into()), to: Some("8d5c04d1b46a".into()) });
        let cur = r#"{"command":"update","outcome":"ok","plugin":"tx-toolkit@tx-squad","pluginId":"tx-toolkit@tx-squad","scope":"user","message":"tx-toolkit is already at the latest version (8d5c04d1b46a).","updateOutcome":"up_to_date","oldVersion":"8d5c04d1b46a","newVersion":"8d5c04d1b46a"}"#;
        assert_eq!(read_plugin(true, cur, ""), Came::Current(Some("8d5c04d1b46a".into())));
        let skip = r#"{"command":"update","outcome":"ok","message":"Skipped: pinned to a version.","updateOutcome":"skipped","skipReason":"pinned"}"#;
        assert_eq!(read_plugin(true, skip, ""), Came::Skipped("Skipped: pinned to a version.".into()));
        let fail = r#"{"command":"update","outcome":"error","message":"The marketplace changed the install command — confirm it with -y.\nshownCommand: …"}"#;
        assert_eq!(read_plugin(false, fail, ""), Came::Failed("The marketplace changed the install command — confirm it with -y.".into()));
    }

    #[test]
    fn a_plugin_without_json_is_read_from_its_sentence() {
        let said = "Checking for updates for plugin \"tx-toolkit@tx-squad\" at user scope…\nPlugin \"tx-toolkit\" updated from 69c07eef4031 to 8d5c04d1b46a for scope user. Restart to apply changes.\n";
        assert_eq!(read_plugin(true, said, ""), Came::Updated { from: Some("69c07eef4031".into()), to: Some("8d5c04d1b46a".into()) });
        assert_eq!(read_plugin(true, "✔ tx-toolkit is already at the latest version (8d5c04d1b46a).\n", ""), Came::Current(None));
    }

    #[test]
    fn a_settled_item_keeps_what_it_was_and_what_it_became() {
        let mut i = Item::new("plugin", "a@m", Some("user"), None);
        i.from = Some("old".into());
        settle(&mut i, Came::Updated { from: Some("old".into()), to: Some("new".into()) });
        assert_eq!((i.state.as_str(), i.from.as_deref(), i.to.as_deref()), ("updated", Some("old"), Some("new")));
        let mut j = Item::new("plugin", "a@m", Some("user"), None);
        settle(&mut j, Came::Updated { from: Some("same".into()), to: Some("same".into()) });
        assert_eq!(j.state, "current");
        let mut k = Item::new("plugin", "a@m", Some("project"), Some("C:\\p"));
        k.from = Some("bc2b8549769b".into());
        settle(&mut k, Came::Current(Some("8d5c04d1b46a".into())));
        assert_eq!((k.state.as_str(), k.from.as_deref(), k.to.as_deref()), ("current", Some("bc2b8549769b"), Some("8d5c04d1b46a")));
        assert!(k.said.as_deref().unwrap_or("").contains("install record"), "a disagreement is said, not hidden");
    }

    #[test]
    fn the_next_run_waits_out_the_launch_and_the_interval() {
        let s = Settings::default();
        let launched = 1_000_000;
        assert_eq!(next_due(&s, None, launched), Some(launched + LAUNCH_GRACE_MS));
        let long_ago = launched - 10 * 3_600_000;
        assert_eq!(next_due(&s, Some(long_ago), launched), Some(launched + LAUNCH_GRACE_MS));
        let just = launched + 120_000;
        assert_eq!(next_due(&s, Some(just), launched), Some(just + 6 * 3_600_000));
        assert_eq!(next_due(&Settings { auto: false, every_hours: 6.0 }, None, launched), None);
        assert_eq!(
            next_due(&Settings { auto: true, every_hours: 0.0 }, Some(just), launched),
            Some(just + 3_600_000),
            "an interval below an hour is an hour"
        );
        assert_eq!(
            next_due(&Settings { auto: true, every_hours: f64::NAN }, Some(just), launched),
            Some(just + 6 * 3_600_000)
        );
    }

    #[test]
    fn an_agent_is_told_what_moved_and_that_it_reaches_the_next_process() {
        let mut cli = Item::new("cli", "claude", None, None);
        settle(&mut cli, Came::Updated { from: Some("2.1.304".into()), to: Some("2.1.311".into()) });
        let mut m = Item::new("marketplace", "tx-squad", None, None);
        settle(&mut m, Came::Updated { from: None, to: None });
        let mut gone = Item::new("plugin", "tx-toolkit@tx-squad", Some("project"), Some("C:\\gone"));
        gone.state = "skipped".into();
        gone.said = Some("its project folder is gone".into());
        let run = Run { trigger: "card".into(), started_at: 0, finished_at: Some(60_000), items: vec![cli, m, gone] };
        let said = say_run(&run, false, 60_000);
        assert!(said.contains("asked by a card"), "{said}");
        assert!(said.contains("- claude code: updated 2.1.304 → 2.1.311"), "{said}");
        assert!(said.contains("- tx-squad marketplace: refreshed"), "{said}");
        assert!(said.contains("skipped — its project folder is gone"), "{said}");
        assert!(said.contains("next process only"), "{said}");
        assert!(say_run(&run, true, 60_000).contains("still going"));
    }

    #[test]
    fn a_first_line_is_clipped_and_cleaned() {
        assert_eq!(first_line("\n\n  boom\x07 \nmore"), "boom");
        assert_eq!(first_line(&"x".repeat(300)).chars().count(), 200);
    }
}
