//! The rung under the grammar: one spoken sentence, one small model, one plan.
//!
//! **Everything interesting about the steward is in `src/lib/steward.ts`**, and
//! this file is deliberately the boring half. The prompt is built there, from
//! the wall the front end is already holding; the reply is read and re-checked
//! there, against that same wall. What is left over is *spawning a process and
//! waiting for it*, which is Rust's because nothing in a webview can spawn one.
//!
//! So the wire is two strings in and one string out. The temptation is to move
//! the prompt down here so the command takes a wall instead of a system prompt —
//! and it is the wrong shape for the reason `voice.ts`'s header already gives
//! about the parse: the wall a referent resolves against is front-end `$state`,
//! so a prompt built here would need the wall shipped down and the plan shipped
//! back, twice per utterance, to arrive in the same place.
//!
//! ## Its own spawn rather than a fork, and a small model on purpose
//!
//! `aside.rs` is the other one-shot `claude` in this tree and the machinery here
//! is lifted from it wholesale — the job object, the timeout poll, the stderr
//! thread, `CREATE_NO_WINDOW`. What is deliberately *not* taken is
//! `--fork-session`. `docs/VOICE.md` settled this: a fork of the addressed card
//! inherits that card's model, and for a wall of Opus cards that is the wrong
//! model for this job by a wide margin. The steward's work is natural language
//! to an ordered list of ops with resolved referents — structured extraction
//! against a closed schema, which is the task class small models are best at —
//! so it is its own spawn with its own `--model`, and the model choice is worth
//! more than the context a fork would have brought.
//!
//! Measured before it was built rather than after (`tools/probe-steward.ts`,
//! 2026-09-05/06, sixty utterances across two models): Haiku 4.5 wholly right on
//! **28/30**, Sonnet 5 on 27/30, and neither acted on a remark or a question
//! once. Haiku's median was 9.3s against Sonnet's 5.9s, which is the one column
//! that argues the other way and is not enough to overturn the rest.
//!
//! ## The three flags that are not decoration
//!
//! `--tools ""` and the empty `--mcp-config`, both measured by that probe: a
//! default `claude --print` on this machine loads the whole MCP roster — blender,
//! two Houdinis, both browsers, skein — before it answers anything, which is
//! ~1.4s of a ~2.0s reply. A steward booting Blender to parse *"select card A"*
//! is absurd on its face and it is also the cheapest latency win available.
//!
//! And **neither may be the last flag before the prompt**. Both are `<x...>` in
//! the CLI's own help, so commander goes on collecting until it meets something
//! beginning with `-`; put either immediately before a positional and it eats it,
//! which fails as *"MCP config file not found: …/say this"* or as *"Input must be
//! provided either through stdin or as a prompt argument"*. Here the utterance
//! goes in on **stdin** rather than as a positional, which sidesteps that
//! entirely — and is also what keeps a sentence with a leading dash in it from
//! being read as an argument.
//!
//! ## What it spends, and whose
//!
//! One request per escalated utterance, on the account Claude Code is signed in
//! as. Not a card's: the steward is the wall's, it is not spoken beside any one
//! conversation, and there is no card whose subscription it would be right to
//! spend. That is the same choice `spawn_now` makes for a card with no label of
//! its own.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::servers::jobs;

/// The model the parse goes to unless the caller names another.
///
/// An alias rather than a pinned id, deliberately: `--model haiku` is a request
/// for whichever haiku this CLI considers current, and pinning
/// `claude-haiku-4-5-20251001` here would mean a wall still asking for last
/// year's model long after the CLI had moved on. The probe's numbers are a
/// finding about the *class* of model, not about one build of it.
const MODEL: &str = "haiku";

/// How long to wait before giving up on a parse.
///
/// The probe's worst haiku run was 23.3s and its worst sonnet 39.2s, so this is
/// generous against what was measured rather than tight against what is
/// comfortable. It is finite because the alternative is a spoken sentence that
/// never comes back and a bar that says *listening* forever — and `voicing`
/// draws whatever this answers, including the giving up.
const TIMEOUT: Duration = Duration::from_secs(60);

/// The most of a reply this will carry back.
///
/// A reply is one JSON object holding a handful of steps. Anything past this is
/// a model that has started explaining itself, and `replyIn` next door is
/// already tolerant of prose around the object — so this is a backstop against a
/// runaway, not a routine cut.
const REPLY_CAP: usize = 16_000;

/// Where the steward is spawned, and why it is not a project.
///
/// An empty directory of its own under the app's data folder. A `claude` started
/// in a territory reads that territory's `CLAUDE.md` into its system prompt —
/// which for this tree is several thousand tokens about migrations and job
/// objects, paid on every utterance, to answer a question about which card to
/// select. It also gives the model a repository to have opinions about. Neither
/// is wanted: the whole world this rung may reason about is the wall in its
/// prompt.
fn steward_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("steward");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Ask the steward to turn one utterance into a plan, and hand back what it said.
///
/// The reply is returned **unread**: whatever came back on stdout, for
/// `steward.ts::replyIn` to parse and `understand` to re-check. Nothing here
/// looks inside it, which is the property that keeps the validation in one place
/// — a Rust-side peek at `steps` would be a second reader of a schema with one
/// owner.
///
/// `off_main` for the rule's own reason and not as a precaution: this spawns a
/// process and waits up to a minute on it, and on the main thread that is every
/// card on the wall unpainted for the duration.
#[tauri::command]
pub async fn voice_steward(
    app: AppHandle,
    system: String,
    utterance: String,
    model: Option<String>,
) -> Result<String, String> {
    let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| MODEL.to_string());
    crate::off_main(move || ask(&app, &system, &utterance, &model)).await?
}

fn ask(app: &AppHandle, system: &str, utterance: &str, model: &str) -> Result<String, String> {
    if utterance.trim().is_empty() {
        /* Nothing may spend a request on silence. `voice.rs::outcome` already
           refuses an empty transcript at the microphone, and this is the same
           refusal one layer in, for the paths that do not come from one. */
        return Err("nothing was said".into());
    }

    let cwd = steward_dir(app)?;
    let program = {
        let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
        crate::claude::program(&home)
    };

    let mut cmd = Command::new(&program);
    cmd.current_dir(&cwd);
    cmd.args([
        "--print",
        /* Text, not `json`: the probe wanted `modelUsage` to say which model had
           really answered, and nothing here does — `replyIn` is looking for one
           JSON object and a second layer of JSON around it would only be
           unwrapped again. */
        "--output-format",
        "text",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        /* Last, and it takes exactly one value — which terminates the two
           variadic flags above. The utterance goes in on stdin. */
        "--append-system-prompt",
        system,
    ]);

    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not reach the steward: {e}"))?;

    /* The rule with no exceptions: a `claude` child of our own carries a
       `conhost` and whatever else it starts, and `kill()` reaches exactly one
       process. Without this a parse that timed out would leave its tree running
       with nothing holding a handle on it. */
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    if let Some(mut w) = child.stdin.take() {
        let _ = w.write_all(utterance.as_bytes());
        let _ = w.write_all(b"\n");
        let _ = w.flush();
        /* And EOF, which is what makes `--print` answer and exit. */
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    /* stderr on its own thread, or a child that fills that pipe blocks forever
       while we read the other one. Kept for the failure message rather than
       drawn. */
    let errs = std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(r) = stderr {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                if out.len() < 2_000 {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        out
    });

    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(r) = stdout {
            for line in BufReader::new(r).lines().map_while(Result::ok) {
                if out.len() >= REPLY_CAP {
                    break;
                }
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    });

    /* `wait_timeout` is not in std, so this is the poll every other one-shot
       here uses. Coarse because the thing being waited on takes seconds. */
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => return Err(format!("could not reach the steward: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    let reply = reader.join().unwrap_or_default();
    let said = errs.join().unwrap_or_default();

    let Some(status) = status else {
        return Err(format!("the steward did not answer in {}s", TIMEOUT.as_secs()));
    };
    let reply = reply.trim().to_string();
    if !status.success() && reply.is_empty() {
        let why = said.trim();
        return Err(if why.is_empty() {
            format!("the steward failed ({status})")
        } else {
            why.lines().last().unwrap_or(why).to_string()
        });
    }
    if reply.is_empty() {
        return Err("the steward answered with nothing".into());
    }
    Ok(reply)
}

/* ── the wall, as a transcript handed it is understood against ─────────────
 *
 * The steward's prompt and its validation both read a `Wall`
 * (`src/lib/voice.ts`): cards with a title and a project, territories with a
 * name and a root, and which card is focused. `voicing.svelte.ts` builds that
 * wall from the front end's live `$state` for a sentence spoken at the
 * keyboard. A transcript that arrives over the flyway — from a phone, which
 * has no `$state` of its own — must be understood against *this wall's* store
 * and live state, and that is what this command assembles: cards and
 * territories from the store (`conversation` joined to `project`), `working`
 * from the supervisor's own turn flag, and file lists left to the front end's
 * `find_files` for the one or two territories a sentence names. The front end
 * supplies the one field the store cannot know — the focused card — because it
 * is viewport state, not a row.
 */

/// One card as the steward sees it.
#[derive(Serialize)]
pub struct WallCard {
    pub id: String,
    pub title: String,
    pub project: String,
    pub working: bool,
}

/// One territory as the steward sees it. Files are fetched by the front end,
/// per the territories a sentence names, as `voicing` already does.
#[derive(Serialize)]
pub struct WallTerritory {
    pub project: String,
    pub cwd: String,
}

#[derive(Serialize)]
pub struct StewardWall {
    pub cards: Vec<WallCard>,
    pub territories: Vec<WallTerritory>,
}

/// The wall a transcript is understood against, read from the store and the
/// supervisor rather than from the front end's `$state` — which is the same
/// data materialised, but a transcript can arrive before the wall has painted
/// itself, and a phone has no `$state` of its own to read anyway.
#[tauri::command]
pub async fn steward_wall(app: AppHandle) -> Result<StewardWall, String> {
    crate::off_main(move || {
        let store = app.state::<crate::store::Store>();
        let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
        let territories = crate::store::projects(&conn)
            .map_err(|e| format!("could not read the wall's projects: {e}"))?
            .into_iter()
            .map(|p| WallTerritory { project: p.name, cwd: p.root_path })
            .collect();
        let sup = app.state::<crate::supervisor::Supervisor>();
        let cards = wall_cards(&conn, |id| sup.liveness(id).1)?;
        Ok(StewardWall { cards, territories })
    })
    .await?
}

/// The open cards, joined to their project's name, with `working` asked of the
/// supervisor by id — a dormant card has no process and reads `false`.
fn wall_cards(conn: &rusqlite::Connection, working: impl Fn(&str) -> bool) -> Result<Vec<WallCard>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, COALESCE(c.title, 'untitled'), COALESCE(p.name, '')
               FROM conversation c LEFT JOIN project p ON p.id = c.project_id
              WHERE c.closed_at IS NULL",
        )
        .map_err(|e| format!("could not read the wall's cards: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .map_err(|e| format!("could not read the wall's cards: {e}"))?;
    let mut cards = Vec::new();
    for row in rows {
        let (id, title, project) = row.map_err(|e| format!("could not read a card: {e}"))?;
        cards.push(WallCard { working: working(&id), id, title, project });
    }
    Ok(cards)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cards a transcript is understood against come from the store, joined
    /// to their project's name, and only the open ones — a closed card is not
    /// on the wall. `working` is asked of the caller, never read from a row.
    #[test]
    fn the_wall_cards_are_open_and_joined_to_their_project() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL);
             CREATE TABLE conversation (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
               cwd TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'untitled',
               born_at INTEGER NOT NULL, closed_at INTEGER
             );
             INSERT INTO project VALUES ('p1', 'orchard', 'C:/orchard');
             INSERT INTO conversation VALUES ('a', 'p1', 'C:/orchard', 'the migration', 1, NULL);
             INSERT INTO conversation VALUES ('b', 'p1', 'C:/orchard', 'untitled', 1, 2);",
        )
        .unwrap();
        let cards = wall_cards(&conn, |id| id == "a").unwrap();
        assert_eq!(cards.len(), 1, "a closed card is not on the wall");
        assert_eq!(cards[0].id, "a");
        assert_eq!(cards[0].title, "the migration");
        assert_eq!(cards[0].project, "orchard");
        assert!(cards[0].working, "working is the supervisor's, asked by id");
    }

    /// The model is a request for a class, not a pinned build.
    ///
    /// Asserted because the alias is the whole of what keeps this wall off a
    /// model id that will one day name something retired — and because the
    /// probe's 28/30 is a finding about small models rather than about one of
    /// them.
    #[test]
    fn the_parse_goes_to_a_small_model_by_alias() {
        assert_eq!(MODEL, "haiku");
    }

    /// A finite wait, generous against what was measured.
    ///
    /// The probe's worst run was 39.2s. A timeout under that would turn a slow
    /// but correct parse into a failure, and one that was absent would leave a
    /// spoken sentence with no answer at all.
    #[test]
    fn the_wait_is_finite_and_longer_than_the_worst_measured_parse() {
        assert!(TIMEOUT.as_secs() > 40, "{TIMEOUT:?}");
        assert!(TIMEOUT.as_secs() <= 120, "{TIMEOUT:?}");
    }
}
