//! Asana, as a card reaches it — two MCP tools over the connection the wall
//! already has working.
//!
//! **Why this file exists is a credential the app was holding and not lending,
//! and that is worth stating first because it is the whole justification.**
//! Volery takes an Asana personal access token in the tokens panel, keeps it in
//! the Windows credential vault, verifies it, and draws three widgets off it.
//! An agent on the same wall had no route to any of that: it could see a kanban
//! board eight feet away and could not read the task it was being asked to work
//! on. There is no CLI to fall back to either — `integrations.ts` marks Asana
//! `sole: true` precisely because nothing else on this machine holds an Asana
//! credential — so a card asking "what does the ticket say" had no answer at
//! all.
//!
//! That is the same shape `smith.rs` was written for one service over, and the
//! same answer: **not a new client, not a new credential, not a second
//! vocabulary of errors.** `docket.rs` is a door onto `asana.rs`.
//!
//! - **`tasks`** — what is assigned to you, or a project's board, or one task
//!   in full with its description. Reading, and free.
//! - **`task`** — create, edit, move, comment, tick, or delete one. Every one of
//!   them asks the user first.
//! - **`asana_token`** — the stored PAT itself, for everything the six actions
//!   do not cover. Asks, and is the one tool here that hands over a secret; the
//!   long argument is above `token`.
//!
//! ### The certificate matters here too, and it is not the reason
//!
//! `app.asana.com` is intercepted on this network exactly as `dev.azure.com`
//! is — probed 2026-09-04, it presents a leaf issued by
//! `ca.macquarietelecom-103950.au.goskope.com`, the same Netskope CA. So a card
//! that shells out to `curl` reads a certificate error where Volery's `ureq`,
//! built with `native-certs` and widened by `forge::tls`, succeeds against the
//! same host.
//!
//! But unlike the forge that is **not** the argument for this file, and saying
//! so keeps the two apart. `az` cannot reach Azure DevOps here and `gh` can
//! reach GitHub, which is why `smith.rs` writes for one forge and not the
//! other. For Asana there is no tool to compare against: the capability is
//! absent rather than broken. The certificate is why a card could not route
//! around us; the vault is why it should not have to.
//!
//! ### Every write asks, and that is one rule rather than a table
//!
//! `smith.rs` draws the floor as *a card may write only what a person would
//! type into a text field*, and gates its one verb behind a real `ask_user`.
//! Both halves are inherited, and the gate is drawn wider: **there is no
//! unattended write in this file.** Not create, not a comment, not a checkbox,
//! and not a move — even though a move is the one write the *widget* already
//! makes on a drag.
//!
//! The asymmetry with the widget is deliberate and is the point. A drag is a
//! gesture a person made, on a board they were looking at, that they can undo
//! by dragging it back. A card's `move` is none of those things, and the person
//! whose board it is may not be at the wall at all.
//!
//! Two facts decide the rest, and they pull in opposite directions:
//!
//! - **An Asana PAT is unscoped.** `integrations.ts` records this in a field
//!   that exists to stop the panel implying otherwise: a token is the whole of
//!   what the account can do, across every workspace it can see. There is no
//!   narrower credential to hand a card, so the narrowing has to be here.
//! - **A card cannot be scoped to a territory the way `smith.rs` scopes one.**
//!   There, the org/project/repo triple comes off the card's own git remote, so
//!   a card physically cannot name somebody else's repository. Asana has no
//!   such anchor — a project is not derivable from a working directory — so a
//!   card *must* be able to name one, and the blast radius the forge closed by
//!   construction is open here by necessity.
//!
//! **The confirmation is what stands in for the missing scope**, which is why
//! it is unconditional rather than reserved for the destructive verbs. Every
//! question names the project and the task in the user's own words, so the
//! thing being approved is *where* as much as *what* — and a card reaching into
//! a workspace nobody expected it to touch is visible in the one place it has
//! to pass through.
//!
//! **`delete` is offered, and it is the one that needed checking rather than
//! arguing.** The floor turns on whether an act is reversible by the person
//! whose name is on it, and Asana's `DELETE /tasks/{gid}` is not a hard delete:
//! it moves the task to a deleted state, recoverable from that person's own
//! trash for 30 days. So it clears the same bar `pull_request`'s create does,
//! and it is refused the way `merge` is refused there — by not being reachable
//! without a person — rather than by not existing.
//!
//! ### A chat card is refused outright
//!
//! Same rule `smith.rs` states: a credential-carrying tool is exactly the reach
//! that card kind exists to deny. A chat card spawns `--tools
//! WebSearch,WebFetch` with no bypass and can touch nothing on this machine,
//! and handing it the user's whole Asana account through an MCP tool would be
//! the one hole in that.
//!
//! ### Threads and locks
//!
//! Nothing here is a `#[tauri::command]` and nothing here wants
//! `crate::off_main` — that rule is about a command running inline on the
//! thread that paints every card. `ask::start` gives every MCP request a thread
//! of its own, so a pass making three sequential requests parks a thread nobody
//! is drawing from. There is no lock discipline to keep because there is no
//! lock: `asana.rs` caches no credential, reading the vault per request, which
//! is the property `creds.rs` chose it for.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// What is on you, or a board, or one task in full. Reading, and free.
pub const TASKS_TOOL: &str = "tasks";
/// The one verb. Singular against the reading's plural, for the reason
/// `smith.rs` gives about `pull_request` against `reviews`: a model reaching
/// for the reading when it meant the write gets a list, and the confusion
/// cannot run the other way, since `task` requires an `action` and a call that
/// meant to read is a schema error rather than something happening.
pub const TASK_TOOL: &str = "task";
/// The stored PAT itself, asked for and handed over.
///
/// The escape hatch from the six actions above, and the one tool on this server
/// that hands a card a **secret**. See the section on it below the schemas — it
/// crosses a line `creds.rs` draws deliberately, so it is worth reading before
/// touching.
pub const TOKEN_TOOL: &str = "asana_token";

/// The service id `creds.rs` knows this token by, and `store::secret_grant`
/// records a grant against.
pub(crate) const SERVICE: &str = "asana";

/// What a granted card finds the token under.
///
/// The name Asana's own tooling and every community client already read, so a
/// script an agent writes reaches for it without being told — which is most of
/// the value of an environment variable over a tool result the agent has to
/// remember to thread through by hand.
pub(crate) const TOKEN_ENV: &str = "ASANA_ACCESS_TOKEN";

/// How many tasks one board or list answers with.
///
/// A board on a real workspace runs to a few hundred, and the whole of one is
/// not what a card asked for — it asked what is in a column, or what is on
/// somebody. What was cut is reported, because a bound that can hide the row
/// you wanted has to say so out loud: the same rule `Board::more`,
/// `Runs::unseen` and `server_log`'s clamp all follow.
const SHOWN: usize = 60;

/// The most of a description that reaches a confirmation question.
///
/// `smith.rs`'s number and its argument: this is one panel on a wall, not a
/// document viewer, and somebody deciding whether a task should be created
/// needs enough of the body to recognise it.
const MAX_SHOWN: usize = 600;

/// The fields every task reading asks for.
///
/// One string, used by all three readings, so a field added for one of them
/// cannot be missing from the others — the drift that makes a tool answer a
/// different shape depending on which argument you passed.
const TASK_FIELDS: &str = "name,notes,completed,due_on,permalink_url,assignee.name,\
                           memberships.project.name,memberships.project.gid,\
                           memberships.section.name,\
                           custom_fields.name,custom_fields.display_value";

/* ── where the caller stands ───────────────────────────────────────────────*/

/// Whether this card may reach a credential at all.
///
/// The only thing asked of the wall here, and it is a refusal rather than a
/// scope: unlike `smith::standing` there is no territory to derive, because an
/// Asana project is not a fact about a working directory. See the header on
/// what stands in for the scoping that buys.
fn permitted(app: &AppHandle, caller: &str) -> Result<(), String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store
        .0
        .lock()
        .map_err(|_| "the store is unavailable".to_string())?;
    let me = crate::store::roster_one(&conn, caller)
        .ok_or_else(|| "this conversation is not on the wall.".to_string())?;
    if me.kind == "chat" {
        return Err("this is a chat card: it reaches nothing on this machine and holds no \
                    credential, so it cannot read or write Asana. Ask on a project card."
            .into());
    }
    Ok(())
}

/* ── finding what the card named ───────────────────────────────────────────*/

/// A project the caller named, resolved to something Asana can be asked about.
struct Found {
    gid: String,
    name: String,
}

/// Every workspace the token can see, as `(gid, name)`.
fn workspaces() -> Result<Vec<(String, String)>, String> {
    let v = crate::asana::get("/workspaces?opt_fields=name")?;
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .map(|r| (crate::forge::text(r, "gid"), crate::forge::text(r, "name")))
                .filter(|(g, _)| !g.is_empty())
                .collect()
        })
        .unwrap_or_default())
}

/// Resolve what a card typed into one project.
///
/// **A gid or a name, because a card has whichever it has.** An agent that has
/// just read `tasks` output holds gids; an agent acting on a sentence somebody
/// typed holds `"RISE"`. Refusing the second would make the tool usable only
/// after it had already been used once, which is the shape of a capability
/// nobody reaches for.
///
/// All-digits is taken as a gid and asked for directly — Asana gids are
/// numeric strings, and a project genuinely *named* `12345` is a case worth
/// losing against a lookup that is one request instead of one per workspace.
/// Anything else is matched case-insensitively, exact before substring, across
/// every workspace the token sees.
///
/// **Ambiguity is answered with the candidates, never resolved by picking.**
/// Two projects matching `board` is a question the card can settle in one more
/// call, and guessing at it would put a write on the wrong board behind a
/// confirmation that named the wrong board — the failure this whole file is
/// arranged to make impossible.
fn find_project(want: &str) -> Result<Found, String> {
    let want = want.trim();
    if want.is_empty() {
        return Err("name a project — its gid, or enough of its name to pick it out".into());
    }
    if want.chars().all(|c| c.is_ascii_digit()) {
        let v = crate::asana::get(&format!("/projects/{want}?opt_fields=name"))?;
        let data = v.get("data").cloned().unwrap_or(Value::Null);
        let name = crate::forge::text(&data, "name");
        return Ok(Found { gid: want.to_string(), name });
    }

    let mut all: Vec<(String, String)> = Vec::new();
    for (ws, _) in workspaces()? {
        let v = crate::asana::get(&format!(
            "/projects?workspace={ws}&archived=false&limit=100&opt_fields=name"
        ))?;
        if let Some(rows) = v.get("data").and_then(|d| d.as_array()) {
            for r in rows {
                let gid = crate::forge::text(r, "gid");
                if !gid.is_empty() {
                    all.push((gid, crate::forge::text(r, "name")));
                }
            }
        }
    }

    let lower = want.to_ascii_lowercase();
    let exact: Vec<_> = all
        .iter()
        .filter(|(_, n)| n.to_ascii_lowercase() == lower)
        .collect();
    let hits: Vec<_> = if exact.len() == 1 {
        exact
    } else {
        all.iter()
            .filter(|(_, n)| n.to_ascii_lowercase().contains(&lower))
            .collect()
    };

    match hits.len() {
        0 => Err(format!(
            "no project here is called {want:?}. Call `mcp__skein__tasks` with no arguments to see the \
             projects your own tasks are in, or name the project exactly as Asana spells it."
        )),
        1 => Ok(Found { gid: hits[0].0.clone(), name: hits[0].1.clone() }),
        _ => Err(format!(
            "{want:?} matches {} projects — name one of these exactly, or pass its gid:\n{}",
            hits.len(),
            hits.iter()
                .take(12)
                .map(|(g, n)| format!("- {n} ({g})"))
                .collect::<Vec<_>>()
                .join("\n")
        )),
    }
}

/* ── the schemas ──────────────────────────────────────────────────────────
 *
 * Longer than the code they describe, which is the arrangement rather than an
 * accident — see the note above `smith::pipelines_schema`. Both are on the
 * deferred tier, so this text is paid for only by a card that went looking,
 * and the search hints live in `ask::roster` beside the tier itself so they can
 * be read against their neighbours'.
 */

pub fn tasks_schema() -> Value {
    json!({
        "name": TASKS_TOOL,
        "description":
            "Read Asana: what is assigned to you, one project's board with its columns, or one \
             task in full with its description. Free, and it uses the token the wall is already \
             holding — there is no `asana` CLI on this machine and nothing else here holds an \
             Asana credential, so this is the only route.\n\n\
             **Call it with no arguments first.** That answers what is on you across every \
             workspace, which is both the cheapest question and the one that names the projects \
             you can then ask about.\n\n\
             `project` takes a gid or enough of a name to pick one out (`RISE`, `t&d`), matched \
             case-insensitively. If it matches several you get the candidates back rather than a \
             guess.\n\n\
             `task` takes one gid and answers with that task **including its `notes`** — the \
             description — which the list and board readings deliberately do not carry. Read it \
             before editing one with the `task` tool: an update replaces the whole field, so \
             amending a description you have not read is how one gets silently thrown \
             away.\n\n\
             Two things everybody gets wrong about Asana, so they are worth having in front of \
             you: **a column is a `section`**, not a custom field — `custom_fields` is a \
             different feature and arrives separately, as name/value chips. And **`completed` is \
             the checkmark, not the column**: a task can sit in a Done column for weeks unticked, \
             and a ticked one stays in whatever column it was in.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description":
                        "A project's gid, or enough of its name to identify it. Answers that \
                         project's board — its sections as columns, with the tasks in each."
                },
                "task": {
                    "type": "string",
                    "description":
                        "One task's gid, for that task in full with its description. \
                         Everything else is ignored when this is given."
                },
                "open": {
                    "type": "boolean",
                    "description":
                        "Leave out completed tasks. Defaults to true — this is a filter on the \
                         checkmark, so a Done column still draws either way. Pass false to see \
                         what has been ticked."
                }
            }
        }
    })
}

pub fn task_schema() -> Value {
    json!({
        "name": TASK_TOOL,
        "description":
            "Create, edit, move, comment on, tick or delete one Asana task. **Every one of these \
             writes, and every one of them asks the user first** — the call parks, a question \
             goes up on this card naming the project and the task, and nothing happens unless \
             they press the button. Expect to wait, and do not call it twice because the first \
             one is taking a while.\n\n\
             Read `tasks` first and act on what it said. In particular read a task before \
             `update`ing it: `notes` is replaced wholesale, not merged.\n\n\
             It writes under the user's own credential and their name, on a board other people \
             read. An Asana token is unscoped — it can reach every workspace the account can — \
             so the confirmation is the only thing standing between a card and somebody else's \
             board, and it names the project so that is what gets approved.\n\n\
             **`move` is how a card changes a column**, because a column is a section. It is not \
             `complete`, which is the checkmark, and the two are independent: ticking a task \
             leaves it where it is, and moving it to Done does not tick it.\n\n\
             **`delete` is offered and is not a hard delete** — Asana moves the task to the \
             user's own trash, where they can restore it for 30 days. That is why it is here at \
             all; an act nobody could take back would not be.\n\n\
             What it will not do, and will not gain: it does not change project settings, add or \
             remove people, alter custom field definitions, create or delete sections, or touch \
             anything outside the one task named.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "update", "move", "comment", "complete", "delete"],
                    "description":
                        "What to do. `create` needs `project` and `name`. Everything else needs \
                         `task`."
                },
                "task": {
                    "type": "string",
                    "description":
                        "The task's gid, exactly as `tasks` reported it. Required for every \
                         action except `create`."
                },
                "project": {
                    "type": "string",
                    "description":
                        "For `create`, which project it goes in — a gid or enough of the name. \
                         For `move`, which project's column you mean, since a task can be in \
                         several; left out, the task's first project is used."
                },
                "section": {
                    "type": "string",
                    "description":
                        "For `move` (required) and `create` (optional): the column, by name or \
                         gid. A column is an Asana *section*. Matched case-insensitively against \
                         that project's own sections."
                },
                "name": {
                    "type": "string",
                    "description":
                        "The task's title. Required for `create`; for `update`, leave it out to \
                         change only the description."
                },
                "notes": {
                    "type": "string",
                    "description":
                        "The task's description, as plain text. **Replaces the whole field** — \
                         leave it out of an `update` to change only the title. Passing an empty \
                         string is a real instruction to empty it, and the question says so."
                },
                "due": {
                    "type": "string",
                    "description":
                        "A due date, `YYYY-MM-DD`. Only on `create` and `update`. Pass an empty \
                         string to clear one."
                },
                "assignee": {
                    "type": "string",
                    "description":
                        "Who it is on: `me`, an email address, or a user gid. Only on `create` \
                         and `update`. Pass an empty string to unassign."
                },
                "text": {
                    "type": "string",
                    "description":
                        "For `comment`: what to say. It appears on the task's activity feed \
                         under the user's name and notifies its followers, which is the part \
                         they are approving."
                },
                "done": {
                    "type": "boolean",
                    "description":
                        "For `complete`: true ticks the checkmark, false unticks it. Defaults \
                         to true. This is not the column — see `move`."
                }
            },
            "required": ["action"]
        }
    })
}

pub fn token_schema() -> Value {
    json!({
        "name": TOKEN_TOOL,
        "description":
            "Ask the user to hand you the Asana personal access token Volery is holding, so you \
             can call **any** Asana endpoint yourself rather than only the handful `task` \
             covers. The call parks; the user is shown what you said you wanted it for, and \
             decides.\n\n\
             **Try `tasks` and `task` first.** Between them they read boards and tasks and do \
             the six ordinary writes, each behind its own confirmation, and none of them puts a \
             credential anywhere. Reach for this one when what you need is genuinely not there \
             — attachments, subtasks, portfolios, goals, webhooks, custom field \
             administration, a bulk read — and **say which, in `reason`**, because that sentence \
             is the whole of what the user has to decide on.\n\n\
             **What you are being given is not scoped and cannot be narrowed.** An Asana PAT is \
             the entire account: every workspace, every project, read and write, with no \
             permission subset to request. There is no version of this that hands you less.\n\n\
             **The token is never put in this conversation.** What you get back is a grant: \
             from your next turn onward the token is in your process environment as \
             `ASANA_ACCESS_TOKEN`, which every Bash, PowerShell and script call you make \
             inherits. Read it at the point of use — `$ASANA_ACCESS_TOKEN`, \
             `$env:ASANA_ACCESS_TOKEN`, `os.environ[\"ASANA_ACCESS_TOKEN\"]` — and **never \
             print it, echo it, log it, commit it, write it into a file, or repeat it to \
             another card**. A transcript is on disk for ever and nothing can take it back \
             out.\n\n\
             The turn you ask on is the exception, and the answer hands you a one-line command \
             for it: an environment is fixed when a process starts, and yours started before \
             the user agreed.\n\n\
             On this machine you can call the API directly with no certificate workaround: the \
             network intercepts TLS, and `CURL_CA_BUNDLE`, `SSL_CERT_FILE` and \
             `REQUESTS_CA_BUNDLE` are already set in the environment, so `curl`, Python and \
             Node all reach `app.asana.com` (verified 2026-09-04). The API is \
             `https://app.asana.com/api/1.0`, and the header is `Authorization: Bearer <the \
             token>`.\n\n\
             The grant lasts until this card is **closed or cleared**, so you do not need to \
             ask again on a later turn — check whether `ASANA_ACCESS_TOKEN` is already set \
             before calling this.\n\n\
             If the user says no, that is an answer. Do not ask again for the same job — say \
             what you could not do, and get on with the rest.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description":
                        "What you need it for, in one or two plain sentences, written for the \
                         user rather than for a log. Name the endpoint or the operation and \
                         what you are trying to achieve — \"to attach the three screenshots to \
                         DATA-412, which `task` cannot do\" is a decision somebody can take; \
                         \"to work with Asana\" is not, and will be refused. This is shown to \
                         them verbatim."
                }
            },
            "required": ["reason"]
        }
    })
}

/* ── the readings ──────────────────────────────────────────────────────────*/

/// Route a `tools/call` to the **reading**, or `None` so `ask.rs` can try the
/// next module — the same contract `relay::handle` and `smith::handle` have.
///
/// **`task` is deliberately not here**, and the omission is `smith::handle`'s
/// exactly: a call that may have to wait for a person cannot be routed through
/// a chain that has already committed to answering on the spot. `ask.rs` calls
/// `docket::task` directly, before it reaches this. Adding it below would be a
/// write that never asked.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        TASKS_TOOL => Some(do_tasks(app, conversation_id, args)),
        _ => None,
    }
}

/// One task as the tools report it: everything a card needs to act, and the
/// gids it will need to name it again.
fn task_json(row: &Value, notes: bool) -> Value {
    let mut v = json!({
        "gid": crate::forge::text(row, "gid"),
        "name": crate::forge::text(row, "name"),
        "completed": row.get("completed").and_then(Value::as_bool).unwrap_or(false),
        "due": crate::forge::text(row, "due_on"),
        "url": crate::forge::text(row, "permalink_url"),
        "assignee": row.get("assignee").map(|a| crate::forge::text(a, "name")).unwrap_or_default(),
    });
    /* Only where it was asked for. The description is far and away the largest
       field on a task and is the whole of what the single-task reading is for,
       so a list carrying sixty of them would spend a context window saying what
       one call says better. */
    if notes {
        v["notes"] = json!(crate::forge::text(row, "notes"));
    }
    let fields: Vec<Value> = row
        .get("custom_fields")
        .and_then(|f| f.as_array())
        .map(|fs| {
            fs.iter()
                .filter_map(|f| {
                    let name = crate::forge::text(f, "name");
                    let value = crate::forge::text(f, "display_value");
                    (!name.is_empty() && !value.is_empty())
                        .then(|| json!({ "name": name, "value": value }))
                })
                .collect()
        })
        .unwrap_or_default();
    if !fields.is_empty() {
        v["fields"] = json!(fields);
    }
    let places: Vec<Value> = row
        .get("memberships")
        .and_then(|m| m.as_array())
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    json!({
                        "project": m.get("project")
                            .map(|p| crate::forge::text(p, "name")).unwrap_or_default(),
                        "column": m.get("section")
                            .map(|s| crate::forge::text(s, "name")).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if !places.is_empty() {
        v["in"] = json!(places);
    }
    v
}

fn do_tasks(app: &AppHandle, caller: &str, args: &Value) -> String {
    if let Err(why) = permitted(app, caller) {
        return why;
    }
    let open = args.get("open").and_then(Value::as_bool).unwrap_or(true);

    /* One task, in full. Answered first and on its own, because a caller that
       has named a task has stopped asking about a list and every filter below
       would be noise — `smith::do_pipelines`' arrangement for the same reason. */
    if let Some(gid) = args.get("task").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return match crate::asana::get(&format!("/tasks/{gid}?opt_fields={TASK_FIELDS}")) {
            Ok(v) => {
                let data = v.get("data").cloned().unwrap_or(Value::Null);
                task_json(&data, true).to_string()
            }
            Err(why) => format!(
                "{why}\n\nA task's gid is the `gid` this tool reports on each row. It is not \
                 the number in the task's url."
            ),
        };
    }

    if let Some(want) = args.get("project").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return match board_of(want, open) {
            Ok(s) => s,
            Err(why) => why,
        };
    }

    match mine(open) {
        Ok(s) => s,
        Err(why) => why,
    }
}

/// One project's board — its sections as columns, with the tasks in each.
///
/// Three requests, and the tasks come in **one** query with `memberships`
/// rather than one per section. That is `asana_board`'s arrangement and the
/// reason is the same: a nine-column board would otherwise be eleven round
/// trips against somebody else's server.
fn board_of(want: &str, open: bool) -> Result<String, String> {
    let found = find_project(want)?;
    let gid = &found.gid;

    let secs = crate::asana::get(&format!("/projects/{gid}/sections?opt_fields=name"))?;
    let columns: Vec<(String, String)> = secs
        .get("data")
        .and_then(|d| d.as_array())
        .map(|rows| {
            rows.iter()
                .map(|r| (crate::forge::text(r, "gid"), crate::forge::text(r, "name")))
                .collect()
        })
        .unwrap_or_default();

    let mut url = format!("/tasks?project={gid}&limit=100&opt_fields={TASK_FIELDS}");
    if open {
        url.push_str("&completed_since=now");
    }
    let v = crate::asana::get(&url)?;
    let rows = v
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let total = rows.len();

    /* Grouped by the section *of this project*, which has to be matched on the
       project gid rather than taken from the first membership — a task in
       several projects would otherwise be filed under whichever column it
       happens to occupy on somebody else's board. `asana::section_of` makes the
       same point one layer over. */
    let mut drawn = 0usize;
    let mut cols: Vec<Value> = Vec::new();
    for (sec_gid, sec_name) in &columns {
        let mut cards: Vec<Value> = Vec::new();
        for r in &rows {
            if section_gid_of(r, gid).as_deref() == Some(sec_gid.as_str()) {
                if drawn >= SHOWN {
                    break;
                }
                cards.push(task_json(r, false));
                drawn += 1;
            }
        }
        cols.push(json!({ "column": sec_name, "gid": sec_gid, "tasks": cards }));
    }
    /* Asana lets a task be in a project without being in any section, and
       dropping those would make this quietly disagree with the count in Asana's
       own header. Named as the widget names it, and only when something is in
       it. */
    let loose: Vec<Value> = rows
        .iter()
        .filter(|r| section_gid_of(r, gid).is_none())
        .take(SHOWN.saturating_sub(drawn))
        .map(|r| task_json(r, false))
        .collect();
    if !loose.is_empty() {
        drawn += loose.len();
        cols.push(json!({ "column": "no column", "gid": "", "tasks": loose }));
    }

    let mut out = json!({
        "project": found.name,
        "gid": found.gid,
        "showing": if open { "open tasks only" } else { "every task" },
        "columns": cols,
    });
    if total > drawn {
        out["more"] = json!(total - drawn);
        out["note"] = json!(format!(
            "{} more tasks in this project were not shown — name a column's tasks by asking \
             again, or narrow with `open`.",
            total - drawn
        ));
    }
    Ok(out.to_string())
}

/// Which section of *this* project a task is in.
fn section_gid_of(row: &Value, project: &str) -> Option<String> {
    for m in row.get("memberships")?.as_array()? {
        if m.get("project").map(|p| crate::forge::text(p, "gid")).as_deref() != Some(project) {
            continue;
        }
        let sec = m.get("section").map(|s| crate::forge::text(s, "gid"))?;
        if !sec.is_empty() {
            return Some(sec);
        }
    }
    None
}

/// What is assigned to the token's own account, across every workspace.
///
/// `assignee=me` **requires** `workspace` — Asana refuses the pair otherwise,
/// which is the fact that makes this a request per workspace rather than one.
/// Nearly every tenant has exactly one.
fn mine(open: bool) -> Result<String, String> {
    let spaces = workspaces()?;
    if spaces.is_empty() {
        return Err("this token can see no workspaces at all, which usually means it was \
                    minted on the wrong account. The tokens panel in the header will name \
                    whose it is."
            .into());
    }
    let mut out: Vec<Value> = Vec::new();
    for (ws, ws_name) in &spaces {
        let mut url = format!(
            "/tasks?assignee=me&workspace={ws}&limit=100&opt_fields={TASK_FIELDS}"
        );
        if open {
            url.push_str("&completed_since=now");
        }
        let v = crate::asana::get(&url)?;
        let rows = v
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();
        out.push(json!({
            "workspace": ws_name,
            "gid": ws,
            "tasks": rows.iter().take(SHOWN).map(|r| task_json(r, false)).collect::<Vec<_>>(),
            "more": rows.len().saturating_sub(SHOWN),
        }));
    }
    Ok(json!({
        "assigned to": "the account this wall's token belongs to",
        "showing": if open { "open tasks only" } else { "every task" },
        "workspaces": out,
        "next": "name a `project` from the rows above to see its board, or pass `task: <gid>` to read \
                 one in full with its description.",
    })
    .to_string())
}

/* ── the write, and the person it is asked of ──────────────────────────────
 *
 * `smith.rs`'s mechanism, exactly: the decision is taken **before** the
 * transport commits to answering, the call is parked as a real `ask_user`
 * question on the card, and a closure does the writing if the answer is yes.
 *
 * The difference from `smith.rs` is what gets gated, and it is wider. There,
 * one verb writes and two read. Here every action writes and every one of them
 * asks — see the header for why the confirmation is standing in for a scope
 * that does not exist rather than merely being careful.
 *
 * Two things carried over unchanged because they were got right there:
 *
 * - **The target is resolved before the question, not after.** Working out
 *   which project and which column costs a request or two, and doing it after
 *   approval would put a panel up saying "move a task" unable to say *where
 *   to* — which is most of what somebody is deciding.
 * - **Nothing is re-read on approval.** The only thing that can have changed is
 *   on Asana's side, and Asana is the one that checks it: a task somebody
 *   deleted answers 404 and it is surfaced verbatim. A re-read would be a
 *   second opinion about a fact the write itself establishes. */

/// What a `task` call turns out to be. `smith::Writing`'s shape, for the same
/// reason it has one.
pub(crate) enum Writing {
    /// Answer the tool call with this, now. Every refusal and every argument
    /// problem is one of these — nothing reaches a person until the call is
    /// well-formed enough to be worth their attention.
    Now(String),
    /// Put this question up and wait. `settle` does the writing if it is a yes.
    Ask { question: Value, settle: crate::ask::Settle },
}

/// The exact words a click sends. `approved` matches the given label and
/// nothing looser — `smith::approved`'s reason, which is that the panel has a
/// free-text field beside its buttons, so what comes back is arbitrary prose and
/// reading a yes out of prose works right up until *"yes, but call it something
/// else"*.
const DO_IT: &str = "do it";
const DO_NOT: &str = "leave it alone";

/// And for the token, which is a different decision and says so.
///
/// Its own words rather than `DO_IT` reused, because the two questions are not
/// the same act and a button reading *do it* under a question about handing over
/// a credential is the one place a habit could carry somebody through.
const HAND_IT_OVER: &str = "hand it over";
const KEEP_IT: &str = "keep it";

fn approved(answer: &str, yes: &str) -> bool {
    answer.trim().eq_ignore_ascii_case(yes)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n\n… (clipped for this question — the whole of it will be written)")
}

/// What the caller is told when nobody answers.
fn unanswered(what: &str) -> String {
    format!(
        "nobody answered, so nothing was written — {what} did not happen. Either the question \
         stood until it expired or the card was dismissed while it was up. Carry on with your \
         own judgement, say that you offered, and do not simply try again."
    )
}

/// And when they say no, or say something else.
fn declined(what: &str, answer: &str, no: &str) -> String {
    let said = answer.trim();
    if said.eq_ignore_ascii_case(no) {
        return format!(
            "the user was asked and said no, so {what} did not happen. That is an answer rather \
             than this tool refusing you — do not ask again about the same task, and say in your \
             reply that you offered."
        );
    }
    format!(
        "the user was asked and pressed neither button. They said: {said:?}. Nothing was \
         written. Act on what they actually said."
    )
}

/// The question every write goes through.
///
/// One composer rather than one per action, because the six differ only in the
/// sentence at the top: what is being changed, and where. Writing six of these
/// would be six places for the project name to go missing from — and the
/// project name is the whole reason this question exists, since it is standing
/// in for a scope the credential does not have.
fn question(header: &str, body: String, danger: Option<&str>) -> Value {
    let tail = danger.unwrap_or(
        "It is written with your own Asana credential, so it shows as yours to everyone on \
         that board.",
    );
    json!({
        "questions": [{
            "header": header,
            "question": format!("{body}\n\n{tail}"),
            "options": [
                { "label": DO_IT, "detail": "Write it. The agent gets the result back." },
                { "label": DO_NOT, "detail": "Nothing is written. The agent is told you said so." }
            ]
        }]
    })
}

/// A task's name and project, for a question that has to say what it is about.
///
/// Read before the question rather than trusted from the call, because the gid
/// is the only thing the card supplied and a question quoting the card's own
/// idea of what that task is called would confirm nothing at all.
fn describe(gid: &str) -> Result<(String, String), String> {
    let v = crate::asana::get(&format!(
        "/tasks/{gid}?opt_fields=name,notes,memberships.project.name"
    ))?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let name = crate::forge::text(&data, "name");
    let project = data
        .get("memberships")
        .and_then(|m| m.as_array())
        .and_then(|ms| ms.first())
        .and_then(|m| m.get("project"))
        .map(|p| crate::forge::text(p, "name"))
        .unwrap_or_default();
    Ok((name, project))
}

/// Which section a card meant, in a named project.
fn find_section(project: &str, want: &str) -> Result<(String, String), String> {
    let want = want.trim();
    let v = crate::asana::get(&format!("/projects/{project}/sections?opt_fields=name"))?;
    let rows: Vec<(String, String)> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|rs| {
            rs.iter()
                .map(|r| (crate::forge::text(r, "gid"), crate::forge::text(r, "name")))
                .collect()
        })
        .unwrap_or_default();
    let lower = want.to_ascii_lowercase();
    if let Some(hit) = rows
        .iter()
        .find(|(g, n)| g == want || n.to_ascii_lowercase() == lower)
        .or_else(|| rows.iter().find(|(_, n)| n.to_ascii_lowercase().contains(&lower)))
    {
        return Ok(hit.clone());
    }
    Err(format!(
        "that project has no column matching {want:?}. Its columns are: {}",
        rows.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ")
    ))
}

/// A field the caller either named or did not.
///
/// `None` means *leave it alone* all the way to the wire, which is the property
/// `asana::put`'s doc comment turns on: sending `notes: ""` for a caller who
/// only meant to fix a typo in the title would silently empty a description.
/// An empty string that was genuinely passed is a real instruction and survives
/// as `Some("")`.
fn named<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// Every tool here that may have to wait for a person, in one entry point.
///
/// `None` for anything that is not one of them, so `ask.rs` has one arm to call
/// and one shape to match — the same contract `handle` has for the reading, and
/// the reason it is a single function rather than two conditions in the
/// dispatch: **which tools park is this module's business.** A third one added
/// here needs no edit over there, and — more to the point — a tool that *should*
/// park and is left out of the dispatch's list becomes an unattended write with
/// nothing to say so.
pub(crate) fn writes(
    app: &AppHandle,
    caller: &str,
    tool: &str,
    args: &Value,
) -> Option<Writing> {
    match tool {
        TASK_TOOL => Some(task(app, caller, args)),
        TOKEN_TOOL => Some(token(app, caller, args)),
        _ => None,
    }
}

/* ── the credential itself ─────────────────────────────────────────────────
 *
 * **This is the one tool on this server that hands a card a secret, and it
 * crosses a line `creds.rs` draws on purpose.** That file states it plainly:
 * *"the one read path out of this file, and it hands back the secret — which
 * everything else here is arranged not to do"*, and `integration_held` answers
 * a boolean precisely so no command can return a token to the front end.
 *
 * An agent is further out than the front end, so this is a real exception and is
 * written down rather than quietly taken. What licenses it is that the
 * alternative is worse in a specific way: an Asana PAT is **unscoped**, the six
 * actions in `task` are a fraction of the API, and a card that needs an
 * attachment, a subtask, a portfolio or a webhook has no route at all. Faced
 * with that, the thing an agent actually does is go looking for the credential
 * itself — which on this machine it can, since the vault is readable by any
 * process running as the user. `processes.md` records the same shape one
 * subsystem over and states the lesson: **the fix for an escape is not detection,
 * it is removing the reason to reach for it.** A sanctioned door with a person
 * standing in it is better than an unsanctioned one with nobody.
 *
 * ### What the question has to say, and why nothing is masked
 *
 * The token is returned as a tool result, which is written to the session
 * transcript on disk in plain text and stays there. Three consequences, and the
 * question says all three rather than the panel hiding any of them:
 *
 * - **Volery's own `forget it` stops being enough.** Clearing the vault entry
 *   removes Volery's copy and not the one now on disk, so revocation moves to
 *   Asana — *my settings → apps → manage developer apps*. That is the single
 *   most important sentence in the question, because it is the one thing
 *   somebody would otherwise assume they still controlled from here.
 * - **It cannot be un-handed.** Approval is a moment; the token is in that
 *   card's context for the rest of the session and in the file for ever.
 * - **Masking it in the panel would be theatre.** `toolcall.ts` could redact the
 *   result and the bytes would still be on disk — so the reading would be
 *   *safer-looking* and no safer, which is the direction this codebase refuses
 *   everywhere else (`checkFailed`'s "a check that can be wrong in the
 *   reassuring direction is worse than no check").
 *
 * What is *not* a leak, and is worth stating so nobody widens the warning past
 * what is true: **another card cannot read it.** `relay::recall` folds only
 * `assistant` speech out of a transcript and never tool results, so the token
 * reaches a second card only if this agent quotes it in its own words — which is
 * why the schema tells it not to, in as many words.
 *
 * ### It asks every time, and that needs no state
 *
 * There is no grant to remember and no expiry to run, which looks like an
 * omission and is the design. A card that has been given the token is holding it
 * in context and will not call this again; a card that *does* call again is one
 * that genuinely does not have it — a new session, a cleared card, a fresh
 * rouse — and that is exactly the moment a fresh approval is right. So the
 * absence of a cache is not laziness: a remembered grant would hand the token to
 * a card the user approved *yesterday*, silently, on a turn they never saw. */

/// The stored PAT, handed over if the user says so.
pub(crate) fn token(app: &AppHandle, caller: &str, args: &Value) -> Writing {
    if let Err(why) = permitted(app, caller) {
        return Writing::Now(why);
    }
    let Some(reason) = named(args, "reason").map(str::trim).filter(|s| !s.is_empty()) else {
        return Writing::Now(
            "say what you need it for in `reason` — it is shown to the user verbatim and is the \
             whole of what they have to decide on. Name the endpoint or the operation and what \
             you are trying to achieve."
                .into(),
        );
    };
    /* Owned before the closure takes it: `args` does not outlive this call, and
       the settle runs on the parking thread up to ten minutes later. */
    let reason = reason.to_string();
    /* Resolved before the question rather than after, per this module's rule for
       the writes: the user deciding whether to hand over a credential wants to
       know **whose** it is, and a token minted on the wrong account is accepted
       by Asana and then sees none of your projects. It also catches a stored
       token that is already dead, which is worth a refusal rather than a
       question — nothing reaches a person until the call is worth their
       attention. */
    let who = match whoami() {
        Ok(w) => w,
        Err(why) => {
            return Writing::Now(format!(
                "{why}\n\nSo there is nothing worth handing over — the user has not been asked. \
                 The tokens panel in the header is where this is fixed."
            ))
        }
    };

    let q = json!({
        "questions": [{
            "header": "hand over the asana token",
            "question": format!(
                "A card is asking for **your Asana personal access token**, to call the API \
                 directly.\n\n**It says it needs it for:**\n\n---\n\n{}\n\n---\n\nThe token is \
                 {}, and Asana tokens are **not scoped** — this is the whole account, every \
                 workspace, read and write. There is no narrower thing to give it.\n\n\
                 **It goes into the card's environment, not into the conversation** — as \
                 `{TOKEN_ENV}`, where its shell and script calls will find it. It is written to \
                 no file and appears in no transcript, so what you are agreeing to is this card \
                 being able to *use* your account, rather than a copy of the token existing \
                 somewhere new.\n\n\
                 **It lasts until you close or clear this card.** There is no expiry and no \
                 separate way to take it back — closing the card is how, and a card you clear \
                 has to ask again. If you want the token itself dead, that is Asana's side: my \
                 settings → apps → manage developer apps.\n\n\
                 If you would rather it did not have this, say no: reading and updating \
                 tasks still works, and the card will be told to carry on without it.",
                clip(&reason, MAX_SHOWN),
                if who.is_empty() { "live".to_string() } else { format!("**{who}**'s") }
            ),
            "options": [
                {
                    "label": HAND_IT_OVER,
                    "detail": "The card gets the token. It goes in the transcript for good."
                },
                {
                    "label": KEEP_IT,
                    "detail": "Nothing is handed over. The agent is told you said so."
                }
            ]
        }]
    });

    let card = caller.to_string();
    Writing::Ask {
        question: q,
        settle: Box::new(move |app, answer| {
            let Some(answer) = answer else {
                return unanswered("the token");
            };
            if !approved(answer, HAND_IT_OVER) {
                return declined("the token", answer, KEEP_IT);
            }
            /* The grant, and **not the token**. Nothing this function returns
               carries the secret, which is the whole of the redesign: a tool
               result is written to the session transcript on disk in plain text
               and stays there, where an environment variable is in no file at
               all. See the section above. */
            let Some(store) = app.try_state::<crate::store::Store>() else {
                return "the user agreed, but the wall's store is unavailable, so the grant \
                        could not be recorded and nothing was handed over."
                    .to_string();
            };
            let wrote = store
                .0
                .lock()
                .map_err(|_| "the store is unavailable".to_string())
                .and_then(|conn| crate::store::grant_secret(&conn, &card, SERVICE, &reason));
            if let Err(why) = wrote {
                return format!(
                    "the user agreed, but the grant could not be recorded ({why}), so nothing \
                     was handed over. Say so rather than trying again."
                );
            }
            /* The command for *this* turn, because an environment is fixed when
               a process starts and this process started before the user agreed.
               Built here rather than described, so the card has something it can
               run rather than a shape it has to assemble — and quoted, since
               both paths can hold spaces. */
            let now = match (std::env::current_exe(), crate::store::db_path(app)) {
                (Ok(exe), Some(db)) => format!(
                    "\n\nFor **this turn only**, your process was started before the grant \
                     existed, so its environment does not have it yet. Fetch it once and it is \
                     in your shell for the rest of the turn:\n\n\
                     ```bash\n\
                     export {TOKEN_ENV}=$(\"{}\" {} {SERVICE} {} {} {} \"{}\")\n\
                     ```\n\n\
                     That command prints nothing at all unless this card is granted, so it is \
                     safe to leave in a script — but do not echo what it returns.",
                    exe.display(),
                    crate::hooks::FLAG_SECRET,
                    crate::hooks::FLAG_CARD,
                    card,
                    crate::hooks::FLAG_DB,
                    db.display(),
                ),
                /* No path to name is not a failure of the grant — the variable
                   still lands at the next spawn. Say what is true and no more,
                   rather than printing a command with a hole in it. */
                _ => "\n\nYour current process was started before the grant existed, so its \
                      environment does not have it yet; it will from your next turn."
                    .to_string(),
            };
            format!(
                "The user agreed, and the grant is recorded against this card.\n\n\
                 **The token is not in this reply, and must not be put in one.** From your next \
                 turn onward it is in your environment as `{TOKEN_ENV}` — every Bash, \
                 PowerShell and script call you make inherits it, so read it with \
                 `$env:{TOKEN_ENV}`, `$ {TOKEN_ENV}` or `os.environ[\"{TOKEN_ENV}\"]` at the \
                 point of use and never print it.{now}\n\n\
                 Use it as `Authorization: Bearer <token>` against \
                 `https://app.asana.com/api/1.0`. No certificate workaround is needed on this \
                 machine — the network intercepts TLS, and CURL_CA_BUNDLE, SSL_CERT_FILE and \
                 REQUESTS_CA_BUNDLE are already set, so curl, Python and Node all reach the \
                 host (verified 2026-09-04).\n\n\
                 The grant lasts until this card is closed or cleared. It is unscoped, so every \
                 request you make is the user's whole account acting under their name — stay \
                 inside what you said you needed it for: {}",
                clip(reason.trim(), 200)
            )
        }),
    }
}

/// Whose token this is, or why there is none worth offering.
///
/// `GET /users/me` is the same probe `creds::probe_asana` makes and for the same
/// reason — it is the cheapest authenticated call and it answers with the
/// identity, which is both halves of the check at once.
fn whoami() -> Result<String, String> {
    let v = crate::asana::get("/users/me")?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let name = crate::forge::text(&data, "name");
    let email = crate::forge::text(&data, "email");
    Ok(match (name.is_empty(), email.is_empty()) {
        (false, false) => format!("{name} <{email}>"),
        (false, true) => name,
        (true, false) => email,
        (true, true) => String::new(),
    })
}

/// The `task` tool, as far as it can be decided without a person.
///
/// Called from `ask.rs` through `writes` rather than through `handle`, the way
/// `smith::pull_request` and `spawn::close` are, because the decision has to be
/// taken before the transport commits to answering on the spot — and it must be
/// taken once.
fn task(app: &AppHandle, caller: &str, args: &Value) -> Writing {
    if let Err(why) = permitted(app, caller) {
        return Writing::Now(why);
    }
    let action = args.get("action").and_then(Value::as_str).unwrap_or("").trim();
    match action {
        "create" => create(args),
        "update" => update(args),
        "move" => shift(args),
        "comment" => comment(args),
        "complete" => complete(args),
        "delete" => remove(args),
        "" => Writing::Now(
            "name an `action`: create, update, move, comment, complete or delete.".into(),
        ),
        other => Writing::Now(format!(
            "there is no {other:?} action here. It is one of: create, update, move, comment, \
             complete, delete.\n\nThis tool changes one task and nothing around it — it does \
             not alter project settings, add or remove people, create or delete columns, or \
             change what a custom field means."
        )),
    }
}

/// The gid a write is about, or the sentence saying it is missing.
fn wants_task(args: &Value, action: &str) -> Result<String, String> {
    match named(args, "task").map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => Ok(t.to_string()),
        None => Err(format!(
            "`{action}` needs a task gid — the one `mcp__skein__tasks` reported for it. Pass it as \
             `task: <gid>`."
        )),
    }
}

fn create(args: &Value) -> Writing {
    let Some(name) = named(args, "name").map(str::trim).filter(|s| !s.is_empty()) else {
        return Writing::Now("`create` needs a `name` — what the task is called.".into());
    };
    let Some(want) = named(args, "project").map(str::trim).filter(|s| !s.is_empty()) else {
        return Writing::Now(
            "`create` needs a `project` — a gid, or enough of the name to identify it.".into(),
        );
    };
    let found = match find_project(want) {
        Ok(f) => f,
        Err(why) => return Writing::Now(why),
    };
    /* Resolved before the question for the reason stated above the module's
       write section: a panel that could not say which column would be asking
       about half the decision. */
    let section = match named(args, "section").map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => match find_section(&found.gid, s) {
            Ok(hit) => Some(hit),
            Err(why) => return Writing::Now(why),
        },
        None => None,
    };

    let notes = named(args, "notes").unwrap_or("").to_string();
    let due = named(args, "due").map(str::trim).unwrap_or("").to_string();
    let assignee = named(args, "assignee").map(str::trim).unwrap_or("").to_string();

    let mut said = format!("**{name}**");
    if let Some((_, col)) = &section {
        said.push_str(&format!("\n\nIn the **{col}** column."));
    }
    if !due.is_empty() {
        said.push_str(&format!("\n\nDue **{due}**."));
    }
    if !assignee.is_empty() {
        said.push_str(&format!("\n\nAssigned to **{assignee}**."));
    }
    said.push_str(&if notes.trim().is_empty() {
        "\n\nIt has written **no description**.".to_string()
    } else {
        format!("\n\n---\n\n{}", clip(&notes, MAX_SHOWN))
    });

    let q = question(
        "create an asana task",
        format!(
            "A card wants to create a task in **{}**.\n\n{said}",
            found.name
        ),
        Some(
            "It is created under your own Asana credential and your name, and everyone \
             following that project sees it.",
        ),
    );

    let project = found.gid.clone();
    let project_name = found.name.clone();
    let title = name.to_string();
    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the task");
            };
            if !approved(answer, DO_IT) {
                return declined("the task", answer, DO_NOT);
            }
            let mut data = serde_json::Map::new();
            data.insert("name".into(), json!(title));
            data.insert("projects".into(), json!([project]));
            if !notes.is_empty() {
                data.insert("notes".into(), json!(notes));
            }
            if !due.is_empty() {
                data.insert("due_on".into(), json!(due));
            }
            if !assignee.is_empty() {
                data.insert("assignee".into(), json!(assignee));
            }
            match crate::asana::post("/tasks", json!({ "data": data })) {
                Ok(v) => {
                    let made = v.get("data").cloned().unwrap_or(Value::Null);
                    let gid = crate::forge::text(&made, "gid");
                    let url = crate::forge::text(&made, "permalink_url");
                    /* The section is a second request by Asana's own design —
                       `POST /tasks` takes projects and not sections — so a
                       failure here leaves a real task in the project's
                       unsectioned pile rather than nothing at all. Said
                       plainly, because a card told only "created" would report
                       a column it is not in. */
                    let placed = match &section {
                        Some((sec, col)) => match crate::asana::post(
                            &format!("/sections/{sec}/addTask"),
                            json!({ "data": { "task": gid } }),
                        ) {
                            Ok(_) => format!(" in the {col} column"),
                            Err(why) => format!(
                                " — but it could not be put in the {col} column ({why}), so it \
                                 is in that project with no column set"
                            ),
                        },
                        None => String::new(),
                    };
                    format!(
                        "created in {project_name}{placed}. gid {gid}{}",
                        if url.is_empty() { String::new() } else { format!(" — {url}") }
                    )
                }
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

fn update(args: &Value) -> Writing {
    let gid = match wants_task(args, "update") {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };
    /* `None` where the caller said nothing, all the way to the wire. */
    let name = named(args, "name").map(str::to_string);
    let notes = named(args, "notes").map(str::to_string);
    let due = named(args, "due").map(|s| s.trim().to_string());
    let assignee = named(args, "assignee").map(|s| s.trim().to_string());
    if name.is_none() && notes.is_none() && due.is_none() && assignee.is_none() {
        return Writing::Now(
            "`update` needs at least one of `name`, `notes`, `due` or `assignee`. Anything you \
             leave out is left alone."
                .into(),
        );
    }

    let (was, project) = match describe(&gid) {
        Ok(d) => d,
        Err(why) => return Writing::Now(format!("asana would not answer for that task: {why}")),
    };

    let mut said = String::new();
    if let Some(n) = &name {
        said.push_str(&format!("\n\n**New title:** {n}"));
    }
    if let Some(n) = &notes {
        said.push_str(&format!(
            "\n\n**The description will be replaced** with:\n\n---\n\n{}",
            if n.trim().is_empty() { "*(emptied)*".to_string() } else { clip(n, MAX_SHOWN) }
        ));
    }
    if let Some(d) = &due {
        said.push_str(&format!(
            "\n\n**Due date:** {}",
            if d.is_empty() { "cleared".to_string() } else { d.clone() }
        ));
    }
    if let Some(a) = &assignee {
        said.push_str(&format!(
            "\n\n**Assignee:** {}",
            if a.is_empty() { "cleared".to_string() } else { a.clone() }
        ));
    }

    let q = question(
        "edit an asana task",
        format!(
            "A card wants to edit **{was}**{}.{said}\n\nOnly the fields above change — the \
             column, the comments and everything else are left alone.",
            if project.is_empty() { String::new() } else { format!(" in **{project}**") }
        ),
        None,
    );

    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the edit");
            };
            if !approved(answer, DO_IT) {
                return declined("the edit", answer, DO_NOT);
            }
            let mut data = serde_json::Map::new();
            if let Some(n) = name {
                data.insert("name".into(), json!(n));
            }
            if let Some(n) = notes {
                data.insert("notes".into(), json!(n));
            }
            if let Some(d) = due {
                /* Null rather than "" — Asana clears a date on null and answers
                   400 on an empty string, which would read to a card as its own
                   argument being malformed. */
                data.insert("due_on".into(), if d.is_empty() { Value::Null } else { json!(d) });
            }
            if let Some(a) = assignee {
                data.insert("assignee".into(), if a.is_empty() { Value::Null } else { json!(a) });
            }
            match crate::asana::put(&format!("/tasks/{gid}"), json!({ "data": data })) {
                Ok(_) => format!(
                    "edited. The fields you were asked about are the only ones that changed: {}",
                    data.keys().cloned().collect::<Vec<_>>().join(", ")
                ),
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

fn shift(args: &Value) -> Writing {
    let gid = match wants_task(args, "move") {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };
    let Some(want_col) = named(args, "section").map(str::trim).filter(|s| !s.is_empty()) else {
        return Writing::Now(
            "`move` needs a `section` — the column to put it in, by name or gid. A column is an \
             Asana section; `mcp__skein__tasks` on the project lists them."
                .into(),
        );
    };

    /* Which project's columns are meant. A task can be in several, so naming
       one is how a card disambiguates; without it the task's own first project
       is used, which is what `tasks` reports first as well. */
    let project = match named(args, "project").map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => match find_project(p) {
            Ok(f) => f,
            Err(why) => return Writing::Now(why),
        },
        None => match project_of_task(&gid) {
            Ok(f) => f,
            Err(why) => return Writing::Now(why),
        },
    };
    let (sec, col) = match find_section(&project.gid, want_col) {
        Ok(hit) => hit,
        Err(why) => return Writing::Now(why),
    };
    let (was, _) = match describe(&gid) {
        Ok(d) => d,
        Err(why) => return Writing::Now(format!("asana would not answer for that task: {why}")),
    };

    let q = question(
        "move an asana task",
        format!(
            "A card wants to move **{was}** into the **{col}** column of **{}**.\n\nThis is the \
             column only — it does **not** tick the task off, which is a separate thing in \
             Asana.",
            project.name
        ),
        None,
    );

    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the move");
            };
            if !approved(answer, DO_IT) {
                return declined("the move", answer, DO_NOT);
            }
            match crate::asana::post(
                &format!("/sections/{sec}/addTask"),
                json!({ "data": { "task": gid } }),
            ) {
                /* No position is sent, and unlike the widget that is right
                   here. `asana.md` records that `addTask` with neither
                   `insert_before` nor `insert_after` puts the task at the *top*
                   of the column — measured 2026-09-03 — which matters to a drag
                   because the card was drawn where it was dropped and would
                   jump. A card naming a column has expressed no opinion about
                   where in it, so Asana's default is also the only honest
                   answer, and inventing a neighbour would be this tool deciding
                   something nobody asked it to. */
                Ok(_) => format!(
                    "moved to {col}. It went to the top of that column, which is where Asana \
                     puts a task added with no position."
                ),
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

/// The project a task is in, when the card did not say which.
fn project_of_task(gid: &str) -> Result<Found, String> {
    let v = crate::asana::get(&format!(
        "/tasks/{gid}?opt_fields=memberships.project.name,memberships.project.gid"
    ))?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let first = data
        .get("memberships")
        .and_then(|m| m.as_array())
        .and_then(|ms| ms.first())
        .and_then(|m| m.get("project"))
        .cloned()
        .unwrap_or(Value::Null);
    let pgid = crate::forge::text(&first, "gid");
    if pgid.is_empty() {
        return Err(
            "that task is not in any project, so it has no columns to move between. Name a \
             `project` it should go into."
                .into(),
        );
    }
    Ok(Found { gid: pgid, name: crate::forge::text(&first, "name") })
}

fn comment(args: &Value) -> Writing {
    let gid = match wants_task(args, "comment") {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };
    let Some(text) = named(args, "text").filter(|s| !s.trim().is_empty()) else {
        return Writing::Now("`comment` needs `text` — what to say on the task.".into());
    };
    let text = text.to_string();
    let (was, project) = match describe(&gid) {
        Ok(d) => d,
        Err(why) => return Writing::Now(format!("asana would not answer for that task: {why}")),
    };

    let q = question(
        "comment on an asana task",
        format!(
            "A card wants to comment on **{was}**{}.\n\n---\n\n{}",
            if project.is_empty() { String::new() } else { format!(" in **{project}**") },
            clip(&text, MAX_SHOWN)
        ),
        Some(
            "It is posted under your name and notifies everybody following that task. Nothing \
             here can un-notify them.",
        ),
    );

    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the comment");
            };
            if !approved(answer, DO_IT) {
                return declined("the comment", answer, DO_NOT);
            }
            match crate::asana::post(
                &format!("/tasks/{gid}/stories"),
                json!({ "data": { "text": text } }),
            ) {
                Ok(_) => "posted. Everyone following that task has been notified.".to_string(),
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

fn complete(args: &Value) -> Writing {
    let gid = match wants_task(args, "complete") {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };
    let done = args.get("done").and_then(Value::as_bool).unwrap_or(true);
    let (was, project) = match describe(&gid) {
        Ok(d) => d,
        Err(why) => return Writing::Now(format!("asana would not answer for that task: {why}")),
    };

    let q = question(
        if done { "tick off an asana task" } else { "reopen an asana task" },
        format!(
            "A card wants to mark **{was}**{} as **{}**.\n\nThis is the checkmark, not the \
             column — the task stays in whatever column it is in either way.",
            if project.is_empty() { String::new() } else { format!(" in **{project}**") },
            if done { "complete" } else { "not complete" }
        ),
        None,
    );

    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the change");
            };
            if !approved(answer, DO_IT) {
                return declined("the change", answer, DO_NOT);
            }
            match crate::asana::put(
                &format!("/tasks/{gid}"),
                json!({ "data": { "completed": done } }),
            ) {
                Ok(_) => format!(
                    "marked {}. It has not moved column.",
                    if done { "complete" } else { "not complete" }
                ),
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

fn remove(args: &Value) -> Writing {
    let gid = match wants_task(args, "delete") {
        Ok(g) => g,
        Err(why) => return Writing::Now(why),
    };
    let (was, project) = match describe(&gid) {
        Ok(d) => d,
        Err(why) => return Writing::Now(format!("asana would not answer for that task: {why}")),
    };

    let q = question(
        "delete an asana task",
        format!(
            "A card wants to **delete {was}**{}.",
            if project.is_empty() { String::new() } else { format!(" from **{project}**") }
        ),
        Some(
            "Asana moves it to **your own trash**, where you can restore it for 30 days — after \
             that it is gone. Its comments and attachments go with it, and anybody following it \
             loses it from their list.",
        ),
    );

    Writing::Ask {
        question: q,
        settle: Box::new(move |_app, answer| {
            let Some(answer) = answer else {
                return unanswered("the deletion");
            };
            if !approved(answer, DO_IT) {
                return declined("the deletion", answer, DO_NOT);
            }
            match crate::asana::delete(&format!("/tasks/{gid}")) {
                Ok(_) => "deleted. It is in your Asana trash and can be restored there for 30 \
                          days."
                    .to_string(),
                Err(why) => format!("asana refused it: {why}"),
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_button_is_an_approval() {
        /* `smith::approved`'s rule, restated here because this file has seven
           gates behind it rather than one. The panel has a free-text field
           beside the buttons, so anything that is not the exact label is prose
           and must not be read as a yes. */
        assert!(approved("do it", DO_IT));
        assert!(approved("  Do It  ", DO_IT));
        assert!(!approved("yes", DO_IT));
        assert!(!approved("yes, but call it something else", DO_IT));
        assert!(!approved("do it, but move it to Done first", DO_IT));
        assert!(!approved(DO_NOT, DO_IT));
        assert!(!approved("", DO_IT));
    }

    #[test]
    fn the_token_takes_its_own_word_and_not_the_writes_one() {
        /* The two questions are not the same act, and a button reading `do it`
           under a question about handing over an unscoped credential is the one
           place a habit could carry somebody through. So the labels are
           disjoint, and — the half that actually guards anything — the word
           that approves a *write* must not approve the *token*. */
        assert_ne!(DO_IT, HAND_IT_OVER);
        assert_ne!(DO_NOT, KEEP_IT);
        assert!(approved("hand it over", HAND_IT_OVER));
        assert!(!approved(DO_IT, HAND_IT_OVER));
        assert!(!approved("yes", HAND_IT_OVER));
        assert!(!approved(KEEP_IT, HAND_IT_OVER));
        /* And not the other way round either: the token's own yes must not
           stand in for a write's. */
        assert!(!approved(HAND_IT_OVER, DO_IT));
    }

    #[test]
    fn a_refusal_is_an_answer_and_says_so() {
        let said = declined("the deletion", DO_NOT, DO_NOT);
        assert!(said.contains("said no"), "{said}");
        assert!(said.contains("do not ask again"), "{said}");

        /* The token's refusal reads the same way, off its own label — a `no`
           matched against the wrong button would fall through to the verbatim
           arm and tell the agent the user "pressed neither button" when they
           had pressed one. */
        let said = declined("the token", KEEP_IT, KEEP_IT);
        assert!(said.contains("said no"), "{said}");
    }

    #[test]
    fn anything_that_is_not_a_button_comes_back_verbatim() {
        /* The user typed a sentence and typed it for the agent — flattening it
           into a no would throw away the only instruction in the exchange. */
        let said = declined("the edit", "rename it to 'sync fails on reissue' instead", DO_NOT);
        assert!(said.contains("sync fails on reissue"), "{said}");
    }

    #[test]
    fn asking_for_the_token_without_a_reason_is_refused_before_anybody_is_asked() {
        /* `reason` is the whole of what the user decides on, so a call without
           one must not reach them — and this is checked before the network, so
           a malformed call costs no request either. Asserted on the argument
           reading rather than through `token`, which needs an `AppHandle`. */
        for args in [json!({}), json!({ "reason": "" }), json!({ "reason": "   " })] {
            assert!(
                named(&args, "reason").map(str::trim).filter(|s| !s.is_empty()).is_none(),
                "{args} should not count as a reason"
            );
        }
        let good = json!({ "reason": "to attach three screenshots to DATA-412" });
        assert_eq!(
            named(&good, "reason").map(str::trim).filter(|s| !s.is_empty()),
            Some("to attach three screenshots to DATA-412")
        );
    }

    #[test]
    fn the_token_schema_says_what_it_cannot_take_back() {
        /* The description is the only thing an agent reads before deciding
           whether to reach for this, and four of its claims are the whole
           reason it is safe to offer at all: that the token is unscoped, where
           it will actually arrive, that it must never be printed, and how long
           the grant lasts. A schema that lost any of them would still compile,
           still register, and still be found.

           The last one earns its place for a reason the others do not: without
           it an agent re-asks on every turn, which is a question the user is
           trained to click through — the way an approval stops meaning
           anything. */
        let text = token_schema()["description"].as_str().unwrap().to_string();
        for claim in ["not scoped", TOKEN_ENV, "never", "closed or cleared"] {
            assert!(text.contains(claim), "the token schema stopped saying {claim:?}");
        }
        /* And the environment is named as the place it arrives, rather than the
           reply — the whole of the redesign, and a sentence that would read as
           fine if it silently went back to promising the token inline. */
        assert!(
            text.contains("never put in this conversation"),
            "the token schema stopped promising the token stays out of the transcript"
        );
        /* And `reason` is required, or the guard above is a suggestion. */
        let req = token_schema()["inputSchema"]["required"].as_array().unwrap().clone();
        assert_eq!(req, vec![json!("reason")]);
    }

    #[test]
    fn the_env_var_is_the_name_asana_tooling_already_reads() {
        /* Most of the value of an environment variable over a tool result is
           that a script an agent writes reaches for the right name without
           being told. A house-style rename here would be silent: everything
           still compiles, the token is still exported, and every Asana client
           on the machine stops finding it. */
        assert_eq!(TOKEN_ENV, "ASANA_ACCESS_TOKEN");
        /* And the service id is what `creds.rs` answers for, since `spawn_now`
           and `--secret` both look the token up by it. */
        assert_eq!(SERVICE, "asana");
    }

    #[test]
    fn a_field_nobody_named_is_left_alone() {
        /* The `Option` all the way to the wire, which is what stops an update
           of the title emptying a description. An empty string that *was*
           passed is a real instruction and survives. */
        let args = json!({ "action": "update", "task": "1", "name": "x", "notes": "" });
        assert_eq!(named(&args, "name"), Some("x"));
        assert_eq!(named(&args, "notes"), Some(""));
        assert_eq!(named(&args, "due"), None);
        assert_eq!(named(&args, "assignee"), None);
    }

    #[test]
    fn every_action_in_the_schema_is_one_the_tool_answers_for() {
        /* An enum the model is handed and a match arm are two lists, and a
           value in the first with no arm in the second is a call that is
           well-formed, accepted by the client, and refused with "there is no
           such action" — which reads to an agent as the tool being broken. */
        let schema = task_schema();
        let listed = schema["inputSchema"]["properties"]["action"]["enum"]
            .as_array()
            .expect("the action enum")
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            vec!["create", "update", "move", "comment", "complete", "delete"]
        );
    }

    #[test]
    fn a_write_with_no_action_says_what_the_actions_are() {
        /* The useful answer to a model that guessed wrong is the list, not a
           schema error — `smith::pull_request`'s rule about refusing `merge`
           with the floor rather than with a validation failure. */
        let args = json!({ "action": "archive", "task": "1" });
        let action = args.get("action").and_then(Value::as_str).unwrap();
        assert!(!matches!(
            action,
            "create" | "update" | "move" | "comment" | "complete" | "delete"
        ));
    }

    #[test]
    fn a_clipped_body_says_it_was_clipped() {
        /* A description that stops mid-sentence with nothing said about it
           reads as the description that will be written. */
        let long = "x".repeat(MAX_SHOWN + 10);
        let out = clip(&long, MAX_SHOWN);
        assert!(out.contains("clipped for this question"), "{out}");
        assert_eq!(clip("short", MAX_SHOWN), "short");
    }

    #[test]
    fn the_question_always_names_both_buttons() {
        let q = question("x", "body".into(), None);
        let opts = q["questions"][0]["options"].as_array().unwrap();
        assert_eq!(opts[0]["label"], DO_IT);
        assert_eq!(opts[1]["label"], DO_NOT);
    }

    #[test]
    fn a_task_reading_carries_notes_only_when_asked() {
        /* The description is the largest field on a task and the whole of what
           the single-task reading is for; sixty of them in a list would spend a
           context window saying what one call says better. */
        let row = json!({
            "gid": "1", "name": "a task", "notes": "the description",
            "completed": false, "due_on": "2026-09-12",
            "permalink_url": "https://app.asana.com/0/1/1",
            "assignee": { "name": "Lyss" },
            "custom_fields": [
                { "name": "Priority", "display_value": "P2" },
                { "name": "Effort", "display_value": "" }
            ],
            "memberships": [
                { "project": { "name": "RISE", "gid": "9" }, "section": { "name": "Doing" } }
            ]
        });
        let lean = task_json(&row, false);
        assert!(lean.get("notes").is_none());
        let full = task_json(&row, true);
        assert_eq!(full["notes"], "the description");

        /* A custom field with no value is dropped rather than drawn empty —
           `fields_of`'s rule, for the same reason. */
        assert_eq!(full["fields"].as_array().unwrap().len(), 1);
        assert_eq!(full["fields"][0]["name"], "Priority");
        assert_eq!(full["in"][0]["column"], "Doing");
        assert_eq!(full["assignee"], "Lyss");
    }

    #[test]
    fn a_tasks_section_is_matched_on_this_project_and_not_the_first() {
        /* A task in several projects would otherwise be filed under whichever
           column it occupies on somebody else's board — `asana::section_of`
           makes the same point one layer over, and it is the one bug in this
           grouping that produces a plausible answer rather than an error. */
        let row = json!({
            "memberships": [
                { "project": { "gid": "other" }, "section": { "gid": "theirs" } },
                { "project": { "gid": "ours" }, "section": { "gid": "mine" } }
            ]
        });
        assert_eq!(section_gid_of(&row, "ours").as_deref(), Some("mine"));
        assert_eq!(section_gid_of(&row, "other").as_deref(), Some("theirs"));
        assert_eq!(section_gid_of(&row, "absent"), None);
    }

    #[test]
    fn a_task_in_no_section_is_loose_rather_than_missing() {
        /* Asana lets a task be in a project without being in any section, and
           dropping those would make this quietly disagree with the count in
           Asana's own header. */
        let row = json!({
            "memberships": [ { "project": { "gid": "ours" } } ]
        });
        assert_eq!(section_gid_of(&row, "ours"), None);
    }

    #[test]
    fn the_three_tools_do_not_share_a_name_with_each_other() {
        assert_ne!(TASKS_TOOL, TASK_TOOL);
        assert_ne!(TASKS_TOOL, TOKEN_TOOL);
        assert_ne!(TASK_TOOL, TOKEN_TOOL);
    }
}
