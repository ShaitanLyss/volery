//! What a directory offers under a slash — asked of the CLI, not worked out here.
//!
//! The dock's palette offers Volery's own commands and then everything the
//! *agent* answers to: the CLI's built-ins, a project's `.claude/commands/`
//! files, the user's own, and every skill from every installed plugin. This
//! module fetches that list, with a description for each one.
//!
//! ## The one request, and why it replaced two wrong answers
//!
//! `control_request { subtype: "initialize" }` on a `claude`'s stdin comes back
//! with `commands: [{ name, description, argumentHint, aliases }]` — 57 of them
//! on this machine, 60 in a project keeping three of its own. Probed 2026-09-07
//! against claude 2.1.233 with `tools/probe-skills.ts initialize`:
//!
//! ```text
//! 1.22s  57 commands   stdin left open, trusted directory
//! 1.32s  57 commands   stdin closed straight after the write
//! 1.24s  57 commands   a fresh directory nobody has ever trusted, no flags
//! ```
//!
//! Three properties, and each one killed a design that was here first:
//!
//! - **It costs nothing and needs no turn.** The CLI answers this itself, before
//!   any prompt, in about 1.2s. So there is nothing to *store*: this was briefly
//!   a schema column (v31, `skills_json`) holding what `system/init` had said,
//!   because init only arrives after a card's first message and the palette is
//!   wanted before it. A request that answers in a second needs no column, and
//!   the column was reverted.
//! - **It carries descriptions.** Every name, including the CLI's own built-ins,
//!   which live inside a 320MB binary and are on disk nowhere — the reason an
//!   earlier version of this file said a palette row could only say where a
//!   command *came from*. It also tags provenance into the description itself:
//!   `"… (project)"`, `"(tx-toolkit) …"`, `"(dynamic workflow)"`.
//! - **It already knows about `.claude/commands/`.** This module used to walk
//!   that directory and parse frontmatter — 400 lines to arrive at a worse
//!   version of one field. The CLI reports `deep/nested.md` as `deep:nested`
//!   with `argumentHint: "branch"` read out of its `argument-hint:`, and gives a
//!   file with no frontmatter at all a description off its first line.
//!
//! The general shape, which is the same one `.claude/rules/turns.md` records
//! about the task-notification events: **when something is publishing the answer
//! already, the work is finding where it says it — not reconstructing it.** Two
//! probes and a `--help` read would have cost less than either wrong version.
//!
//! ## What it does not say
//!
//! Nothing in the response distinguishes a *skill* from a built-in or a project
//! command, and the palette needs that: a skill is invoked by the model out of
//! the prose, so it may sit anywhere in a line, where everything else here is
//! parsed by the CLI at the head of a prompt. `system/init`'s `skills` array is
//! the only authoritative label, and it arrives with a card's first turn — so
//! `commands.ts` degrades toward *offering more* rather than less until then.
//! See `.claude/rules/commands.md`.
//!
//! ## The spawn
//!
//! A throwaway process rather than a question down a live card's stdin, and that
//! is a deliberate trade of one cheap process for one code path. Asking the
//! card's own child would be free — but only a card that *has* a child, and the
//! whole point is the palette working before you have said anything to a dormant
//! one. One mechanism that always works beats two that each half do.
//!
//! Minimal argv: no `--dangerously-skip-permissions`, because this process never
//! runs a tool and the probe above shows an untrusted directory answers without
//! it. Stdin is closed straight after the request, so anything that ever *did*
//! want to ask a question reads EOF and exits instead of parking forever — the
//! standing rule that a background read must never ask one, made structural
//! rather than argued. The account is not swapped either: plugins and command
//! files live on disk under `~/.claude`, shared by every subscription, so the
//! answer does not depend on who is signed in.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::servers::jobs;

/// How long to wait for the answer before giving up.
///
/// It arrives in about 1.2s. Twenty seconds is for a cold start on a loaded
/// machine, and the failure is a palette holding only Volery's own commands
/// rather than anything a person would notice as broken.
const WAIT: Duration = Duration::from_secs(20);

/// How many rows are accepted.
///
/// Sixty is the real figure here. The bound is against a build that one day
/// answers with something pathological, since these are drawn one to a row in a
/// popup over the dock.
const MAX_COMMANDS: usize = 500;

/// How long a description may be.
///
/// The summary column is a line you scan. Some of these are a full paragraph —
/// `tx-toolkit:design-system`'s is 300-odd characters — so it is cut here rather
/// than in CSS, which would leave the palette measuring a string it then hides.
const MAX_DESCRIPTION: usize = 140;

/// One name the agent answers to.
#[derive(Debug, Serialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// What is typed after the slash. A plugin's skills and a command in a
    /// subdirectory are both spelled with a colon (`tx-toolkit:committee`,
    /// `deep:nested`).
    pub name: String,
    /// What it does, in its author's words. Empty where the CLI gave none.
    pub description: String,
    /// What it takes after the name — `"<model>"`, `"[interval] [prompt]"`,
    /// `"branch"`. Empty for one that takes nothing, which is what tells the
    /// palette whether to leave a space after a completion.
    pub argument_hint: String,
    /// Shorter names for the same thing, as the CLI publishes them: `review` for
    /// `code-review`, `committee` for `tx-toolkit:committee`, `reset` and `new`
    /// for `clear`. Offered by the palette, since a name nobody can guess is a
    /// name nobody uses.
    pub aliases: Vec<String>,
}

/// Ask the `claude` in this directory what it answers to.
///
/// `async`, through `crate::off_main`: it spawns a process and waits on it, and
/// the rule on blocking commands is absolute — this on the main thread would be
/// the whole wall unpainted for a second and a bit every time you focused a card
/// in a directory nobody had asked about yet.
#[tauri::command]
pub async fn slash_commands(app: AppHandle, cwd: String) -> Result<Vec<SlashCommand>, String> {
    let program = {
        let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
        crate::claude::program(&home)
    };
    crate::off_main(move || ask(&program, &cwd)).await?
}

/// The spawn, the request and the wait, apart from the command that carries it.
///
/// `pub` so `examples/slash-probe.rs` can drive it without a Tauri app; the
/// command above is the only caller inside it.
pub fn ask(program: &str, cwd: &str) -> Result<Vec<SlashCommand>, String> {
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd);
    /* Everything needed to be spoken to over stdin and nothing else. No bypass
       flag: this process never runs a tool, and an untrusted directory answers
       without one (see the module note). */
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
    ]);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("could not ask claude: {e}"))?;

    /* A job object, per the rule that has no exceptions: a `claude` of our own
       carries a `conhost` and whatever its stdio MCP servers start, and `kill()`
       reaches exactly one process. Without it a request that timed out would
       leave that tree running with nothing holding a handle on it. */
    let job = jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    if let Some(mut w) = child.stdin.take() {
        let line = r#"{"type":"control_request","request_id":"volery-initialize","request":{"subtype":"initialize"}}"#;
        let _ = w.write_all(line.as_bytes());
        let _ = w.write_all(b"\n");
        let _ = w.flush();
        /* And EOF. The answer still arrives — probed — and anything that ever
           did want to ask a question now reads the end of its input instead of
           parking on a prompt nobody can see. */
    }

    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel::<Result<Vec<SlashCommand>, String>>();
    std::thread::spawn(move || {
        let Some(out) = stdout else {
            let _ = tx.send(Err("no stdout".into()));
            return;
        };
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            /* A cheap reject before parsing. The stream carries whatever else
               the CLI feels like emitting, and `serde_json` on every line of it
               is the whole cost of this. */
            if !line.contains("control_response") {
                continue;
            }
            if let Some(found) = commands_from(&line) {
                let _ = tx.send(Ok(found));
                return;
            }
        }
        let _ = tx.send(Err("claude answered no initialize".into()));
    });

    let answer = rx.recv_timeout(WAIT);
    /* The tree first, so the whole of it goes at once rather than the agent
       dying and its servers being orphaned in the gap. */
    drop(job);
    let _ = child.kill();
    let _ = child.wait();

    match answer {
        Ok(found) => found,
        Err(_) => Err(format!("claude did not answer within {}s", WAIT.as_secs())),
    }
}

/// The commands out of one `control_response` line, or `None` if it is not one.
///
/// Pure, so the wire format has a test on it without a `claude` in the way. The
/// nesting is the CLI's and is worth naming because it is easy to read past:
/// the envelope's `response` holds the *dispatcher's* reply (`subtype`,
/// `request_id`) and that holds a second `response` with the payload.
///
/// Tolerant on the way in, because every field here is drawn and none of it is
/// load-bearing: a row with no name is dropped, and anything else missing costs
/// that row a description or its hint rather than costing the palette.
pub fn commands_from(line: &str) -> Option<Vec<SlashCommand>> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "control_response" {
        return None;
    }
    let inner = v.get("response")?;
    /* An error reply is a real answer and must not be mistaken for "keep
       reading" — the reader would otherwise sit until the timeout on a request
       that has already been refused. */
    if inner.get("subtype").and_then(|s| s.as_str()) == Some("error") {
        return Some(Vec::new());
    }
    let said = inner.get("response")?.get("commands")?.as_array()?;
    let mut out = Vec::new();
    for one in said.iter().take(MAX_COMMANDS) {
        let name = one
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if name.is_empty() {
            continue;
        }
        out.push(SlashCommand {
            name,
            description: clip(one.get("description").and_then(|d| d.as_str()).unwrap_or_default()),
            argument_hint: one
                .get("argumentHint")
                .and_then(|h| h.as_str())
                .unwrap_or_default()
                .trim()
                .to_string(),
            aliases: one
                .get("aliases")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str())
                        .map(|s| s.trim().to_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    Some(out)
}

/// One line's worth of a description, cut on a word where it can be.
fn clip(said: &str) -> String {
    let said = said.trim();
    if said.chars().count() <= MAX_DESCRIPTION {
        return said.to_string();
    }
    let cut: String = said.chars().take(MAX_DESCRIPTION).collect();
    /* Back to the last space, so a summary does not end mid-word — but only if
       that leaves most of the line, or a description with no spaces in it would
       be cut to nothing. */
    let at = cut.rfind(' ').filter(|i| *i > MAX_DESCRIPTION / 2);
    let kept = match at {
        Some(i) => &cut[..i],
        None => cut.as_str(),
    };
    format!("{}…", kept.trim_end_matches([',', '.', ';', ' ']))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the CLI really sends, quoted from `tools/probe-skills.ts
    /// initialize` against claude 2.1.233 — including the double `response`
    /// nesting, which is the part easiest to read past.
    const REAL: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"volery-initialize","response":{"commands":[
      {"name":"bare","description":"No frontmatter at all. (project)","argumentHint":""},
      {"name":"deep:nested","description":"a command in a subdirectory (project)","argumentHint":"branch"},
      {"name":"code-review","description":"Review the current diff.","argumentHint":"[low|medium|high]","aliases":["review"]},
      {"name":"tx-toolkit:committee","description":"(tx-toolkit) Convene a panel.","argumentHint":"","aliases":["committee"]}
    ],"agents":["claude"],"pid":27188}}}"#;

    #[test]
    fn the_wire_shape_is_read_including_hints_and_aliases() {
        let found = commands_from(REAL).expect("a control_response carrying commands");
        assert_eq!(
            found.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["bare", "deep:nested", "code-review", "tx-toolkit:committee"]
        );
        /* A file with no frontmatter still gets a description, off its first
           line, and the CLI tags the provenance into it. */
        assert_eq!(found[0].description, "No frontmatter at all. (project)");
        /* `argument-hint:` frontmatter, come back as a hint. */
        assert_eq!(found[1].argument_hint, "branch");
        assert_eq!(found[2].aliases, vec!["review"]);
        /* And the un-prefixed form of a plugin's skill, which is the only name
           anybody actually types. */
        assert_eq!(found[3].aliases, vec!["committee"]);
        assert!(found[0].aliases.is_empty(), "absent aliases are not an error");
    }

    #[test]
    fn anything_that_is_not_the_answer_is_not_mistaken_for_it() {
        /* The reader skips lines until it finds the reply, so everything else on
           the stream has to come back `None` rather than an empty answer. */
        for other in [
            r#"{"type":"system","subtype":"init","skills":["dataviz"]}"#,
            r#"{"type":"assistant","message":{"content":[]}}"#,
            r#"{"type":"control_response","response":{"subtype":"success","response":{}}}"#,
            "not json at all",
            "",
        ] {
            assert!(commands_from(other).is_none(), "{other}");
        }
    }

    /// A refusal is an answer. Read as "keep looking" the reader would sit there
    /// until the timeout on a request that had already been declined.
    #[test]
    fn a_refused_request_answers_with_nothing_rather_than_waiting() {
        let said = r#"{"type":"control_response","response":{"subtype":"error","request_id":"volery-initialize","error":"Unsupported control request subtype"}}"#;
        assert_eq!(commands_from(said), Some(Vec::new()));
    }

    #[test]
    fn a_row_with_no_name_is_dropped_and_the_rest_survive() {
        let said = r#"{"type":"control_response","response":{"subtype":"success","response":{"commands":[
          {"description":"nameless"},{"name":"   "},{"name":"Kept","description":"yes"}
        ]}}}"#;
        let found = commands_from(said).unwrap();
        /* Lowercased, because the palette matches in lowercase and a name that
           could only be found by typing it in capitals is unreachable. */
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "kept");
    }

    #[test]
    fn a_paragraph_of_a_description_is_cut_to_a_line() {
        /* `tx-toolkit:design-system`'s real one is 300-odd characters. Cut here
           rather than in CSS, which would have the palette measure a string it
           then hides. */
        let long = "word ".repeat(60);
        let said = format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","response":{{"commands":[{{"name":"x","description":"{}"}}]}}}}}}"#,
            long.trim()
        );
        let found = commands_from(&said).unwrap();
        assert!(found[0].description.chars().count() <= MAX_DESCRIPTION + 1);
        assert!(found[0].description.ends_with('…'));
        /* Cut on a word, not mid-word. */
        assert!(!found[0].description.contains("wor…"));
    }

    #[test]
    fn a_description_with_no_spaces_is_still_cut_to_something() {
        let long = "x".repeat(400);
        let said = format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","response":{{"commands":[{{"name":"x","description":"{long}"}}]}}}}}}"#
        );
        let found = commands_from(&said).unwrap();
        assert!(found[0].description.chars().count() <= MAX_DESCRIPTION + 1);
        assert!(found[0].description.len() > 1, "cut to something, not to nothing");
    }
}
