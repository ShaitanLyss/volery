//! The forge, as a card reaches it — three MCP tools over the path the wall
//! already has working.
//!
//! **Why this file exists is a certificate, and that is worth stating first
//! because it is the whole justification.** This network runs Netskope TLS
//! interception: probed 2026-08-14, `dev.azure.com` here presents a certificate
//! issued by `ca.macquarietelecom-103950.au.goskope.com`, whose root is in
//! Windows' `LocalMachine\Root` and in no bundled root set. Volery's `ureq` is
//! built with `native-certs` for exactly that reason (see the note in
//! `Cargo.toml`, which calls the choice load-bearing), so every request the
//! pipelines and reviews widgets make succeeds. `az` does not read that store on
//! this path, so a card reaching for `az repos pr create` or `az pipelines runs
//! list` fails with a certificate error — on a machine where the app beside it is
//! talking to the same host without trouble.
//!
//! So the cards were never being denied a capability on purpose. They were
//! failing to reach a path that was already built, tested and working eight feet
//! away, and spending turns on a diagnosis this repository had already written
//! down. These three tools are that path, exposed:
//!
//! - **`pipelines`** — what is building for this card's territory, and one run's
//!   stages and steps if it names one. Reading, and free.
//! - **`reviews`** — the open pull requests, and one in full (with its
//!   description) if it names one. Reading, and free.
//! - **`pull_request`** — open one, or change an existing one's title and
//!   description. The only verb, and the only genuinely new code.
//!
//! ### The floor, redrawn one step in rather than removed
//!
//! `.claude/rules/azdo.md` states a deliberate floor for the widgets: *a row is
//! a link and nothing else. No re-run, no cancel, no approve.* The argument is
//! about a **button on a list read at a glance** — this wall spawns agents with
//! `--dangerously-skip-permissions`, so a "re-run" beside a row somebody glanced
//! at would be the most consequential thing in the app one stray click away. That
//! argument is untouched by anything here and the widgets keep the floor.
//!
//! An MCP tool is not that gesture. It is called deliberately, by an agent that
//! was asked to do this, and it is in the transcript. But "not that gesture" is
//! not a licence, so the floor is redrawn rather than dropped:
//!
//! > **A card may write only what a person would type into a text field.**
//!
//! A title, a description, and the pull request they belong to. **No vote, no
//! completion, no auto-complete, no abandon, no re-queue, no cancel, no policy
//! override**, and no `merge` under any name. Those are the acts that either land
//! under your name on somebody else's work or start a machine moving, and they
//! are as unavailable to a card here as they are to a click on the wall. The line
//! is not "reads are safe and writes are not" — it is *whether the act is
//! reversible by the person whose name is on it*, and a title is.
//!
//! It also happens to be exactly what was asked for, which is the cheapest kind
//! of agreement between a rule and a request.
//!
//! ### Why the write half is Azure DevOps only
//!
//! Not an unfinished edge. `azdo.md`'s section on the second forge settles it:
//! GitHub needs no credential ladder here because `gh` is already installed and
//! already signed in on any machine somebody works on GitHub from, and **`gh pr
//! create` works on this network**. There is no certificate problem to bypass, so
//! there is nothing for a tool to add except a second way to do the same thing
//! and a second vocabulary of errors. A card on a GitHub repository is told to
//! use `gh`, by name, rather than being handed a tool that would be a worse
//! `gh`.
//!
//! The *reading* half answers for both forges, because there it costs nothing:
//! `azdo::both_runs` and `both_reviews` already merge the two, and a card asking
//! what is building should not have to know which service hosts its repository —
//! the same argument that made GitHub Actions rows go into the wall's existing
//! runs list rather than into a second widget.
//!
//! ### The territory is read off the wall, never named
//!
//! Every one of these three is scoped to the project the calling card stands in,
//! and the org/project/repo triple comes off that project's own git remote
//! (`azdo::origin_for`). A card cannot name a repository, for the reason
//! `spawn.rs` will not take a path: **a card that could name its own project
//! could name somebody else's**, and then a tool that writes has the whole
//! organisation as its blast radius instead of the territory it was put in. This
//! is the same rule `servers.rs` states — *a card sees the dev servers of the
//! territory it stands in and no others* — reaching a service instead of a
//! process.
//!
//! ### Threads and locks
//!
//! Nothing here is a `#[tauri::command]` and nothing here wants `crate::off_main`
//! — that rule is about a command running inline on the thread that paints every
//! card. `ask::start` gives every MCP request a thread of its own, so a pass that
//! makes six sequential requests against a ten-second connect timeout parks a
//! thread nobody is drawing from. What is still owed is the lock discipline, and
//! it is kept by not having any of it here: `azdo.rs` takes its own mutex inside
//! each of the four functions this file calls, so *never both forges' locks at
//! once* stays a fact about one file.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The roster of runs, and one run's insides. Reading, and free.
pub const PIPELINES_TOOL: &str = "pipelines";
/// Open pull requests, and one in full. Reading, and free.
pub const REVIEWS_TOOL: &str = "reviews";
/// Open one, or change its title and description. The only verb here.
///
/// Singular where the two readings are plural, which is not a style choice: the
/// reading tools answer about a list and this one acts on exactly one pull
/// request, and a model reaching for `reviews` when it meant `pull_request`
/// gets a list rather than a write. The confusion is safe in that direction and
/// cannot run the other way — `pull_request` requires an `action`, so a call
/// that meant to read is a schema error rather than something happening.
pub const PULL_REQUEST_TOOL: &str = "pull_request";

/// How many runs a list answers with.
///
/// Azure DevOps' pull requests come back org-wide and its builds come back
/// twenty-five deep *per project*, so an organisation with six projects can put
/// a hundred and fifty rows in front of a card that asked whether its branch
/// built. Twenty is enough to carry a project's recent history; what was cut is
/// in the answer, because a bound that can hide the row you wanted has to say
/// so out loud — the same rule `Runs::unseen` and `server_log`'s clamp follow.
const RUNS_SHOWN: usize = 20;

/// And for pull requests, which are far fewer — eight across this organisation
/// on the day it was measured. High enough that the cap is essentially never
/// what decides, and present so that a pathological org cannot pour its whole
/// review queue into a context window.
const REVIEWS_SHOWN: usize = 30;

/* ── the words that make these findable, and where they live ───────────────
 *
 * Not here — in `ask::roster`, as the second argument to `found_by`, alongside
 * the tier itself. That is card 3f08dc99's arrangement and it is the right one:
 * a hint is only useful if it can be read against its neighbours', because the
 * failure it guards against is two tools claiming the same words. Nine of them
 * side by side in one list shows that; nine of them scattered through nine
 * modules does not. `every_deferred_tool_can_be_found` is the test that refuses
 * a deferred tool with no hint at all.
 *
 * These three had them written in the schema functions first, and one source of
 * truth beat the co-location argument — `found_by` *overwrites* `_meta`, so
 * keeping both would have meant two hint texts with the nearer one silently
 * winning, which is the drift this codebase writes rules against.
 *
 * What is worth knowing here rather than there, because it is a fact about
 * *these* tools: **a card reaching for the forge has usually just failed with
 * `az`**, so it is searching for the word in its hand — `certificate`, `ssl`,
 * `az repos pr create` — rather than for a noun it does not know this server
 * has. And nobody thinks "pipelines"; they think "did my build pass". The hints
 * carry both, and that is why they read oddly wide. */

/* ── where the caller stands ───────────────────────────────────────────────*/

/// The territory a calling card is in, and the two paths that matter about it.
struct Standing {
    project: String,
    /// The project's own root — what the widgets poll with, so asking here warms
    /// and reuses the same per-root caches rather than adding a second entry for
    /// every card.
    root: String,
    /// The card's *own* working directory, which for a card in a worktree is not
    /// `root`. This is the one that answers "what branch am I on", and using
    /// `root` for that would offer a card in a worktree the trunk's branch as
    /// the source of its pull request — the single most confidently wrong thing
    /// this file could do.
    cwd: String,
}

fn standing(app: &AppHandle, caller: &str) -> Result<Standing, String> {
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
        return Err("this is a chat card: it stands outside the wall's projects and reaches \
                    nothing on this machine, so it has no repository and no forge to look at."
            .into());
    }
    let project = crate::store::project_row(&conn, &me.project_id)
        .ok_or_else(|| "this card's territory is not on the wall any more.".to_string())?;
    /* A card that somehow has no cwd of its own falls back to the project root,
       which is where it would have been spawned. */
    let cwd = if me.cwd.is_empty() { project.root_path.clone() } else { me.cwd };
    Ok(Standing { project: project.name, root: project.root_path, cwd })
}

/// The branch the calling card's own working tree is on.
///
/// `GIT_TERMINAL_PROMPT=0` and `credential.interactive=false` for the reason
/// every other shell-out in this app sets them: `rev-parse` does not
/// authenticate *today*, and that is a property of today's git rather than a
/// guarantee. A tool call is not a background poll, but a credential window
/// opening over the wall is no more welcome for having been provoked by
/// something on purpose.
fn branch_at(cwd: &str) -> Option<String> {
    let out = crate::forge::output(
        std::process::Command::new("git")
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["-c", "credential.interactive=false"])
            .args(["rev-parse", "--abbrev-ref", "HEAD"]),
    )?;
    let b = out.trim().to_string();
    /* A detached HEAD answers the literal string `HEAD`, which is not a branch
       and cannot be the source of a pull request. Told apart here so the caller
       can say why rather than sending `refs/heads/HEAD` and reading a 400 about
       a ref that does not exist. */
    (!b.is_empty() && b != "HEAD").then_some(b)
}

/* ── the schemas ──────────────────────────────────────────────────────────
 *
 * Longer than the code they describe, which is the arrangement rather than an
 * accident: the descriptions are where the reasoning lives, so
 * `supervisor::append_prompt` does not have to carry it. See the note above
 * `servers::servers_schema` and `ask::mcp_config`.
 *
 * These three are also the tools most likely to be reached for by a card that
 * has *already tried `az` and failed*, so each description says what the tool
 * replaces. A model that knows only that a tool exists will still shell out to
 * the thing it has always shelled out to.
 */

pub fn pipelines_schema() -> Value {
    json!({
        "name": PIPELINES_TOOL,
        "description":
            "What is building for this card's territory — Azure DevOps builds and GitHub \
             Actions runs in one list, newest first — and one run's stages and steps if you \
             name it. Reading, and free: the wall is already holding the credential and the \
             connection.\n\n\
             **Use this instead of `az pipelines`.** On this machine `az` cannot reach \
             `dev.azure.com` at all: the network intercepts TLS and presents a corporate \
             certificate, and Volery's HTTP client reads the Windows certificate store where \
             `az` does not. A card that shells out gets a certificate error and spends the \
             turn diagnosing a problem this app already solved. Same for `gh run list` — it \
             works, and this is one call for both forges.\n\n\
             Name a `run` from the list to see which job and which step went red, which is \
             what you actually want nine times in ten. The steps carry each service's own \
             vocabulary verbatim, so `inProgress` from Azure DevOps and `in_progress` from \
             GitHub are both themselves and neither is folded into the other.\n\n\
             `branch` is the cheap narrowing and usually the right one — asking whether the \
             branch you just pushed built, rather than reading the project's whole recent \
             history.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run": {
                    "type": "string",
                    "description":
                        "A run's id exactly as this tool reported it, to get that run's \
                         stages and steps instead of the list. Everything else is ignored \
                         when this is given."
                },
                "branch": {
                    "type": "string",
                    "description":
                        "Keep only runs off this branch. Written the way people write them \
                         (`main`, `feature/x`); the `refs/heads/` Azure DevOps sends is \
                         matched for you, and so is a bare branch name from GitHub."
                },
                "failed": {
                    "type": "boolean",
                    "description":
                        "Keep only runs that did not succeed — failed, cancelled, timed out, \
                         or parked waiting for somebody to approve a deployment. What to ask \
                         when the question is \"is anything broken\" rather than \"what has \
                         been running\"."
                }
            }
        }
    })
}

pub fn reviews_schema() -> Value {
    json!({
        "name": REVIEWS_TOOL,
        "description":
            "The open pull requests for this card's territory — who opened each one, whether \
             it conflicts, who has voted and which way, and whether it is waiting on a person \
             or on a build. Azure DevOps and GitHub in one list. Reading, and free.\n\n\
             **Use this instead of `az repos pr list`.** `az` cannot reach `dev.azure.com` on \
             this network — the TLS interception described under `pipelines` — so a card that \
             shells out reads a certificate error. `gh pr list` does work on the GitHub half, \
             and this answers both halves in one call.\n\n\
             Name a `pull` number to get that one in full, **including its description**, \
             which the list deliberately does not carry. Do that before editing a description \
             with `pull_request`: an update replaces the whole field, so amending one you have \
             not read is how a description gets silently thrown away.\n\n\
             The vote scale is Azure DevOps' own and GitHub is mapped onto it: 10 approved, 5 \
             approved with suggestions, 0 no vote yet, -5 waiting for the author, -10 \
             rejected. A pull request whose author is also listed as a required reviewer is \
             ordinary rather than odd — that is what a branch policy adds.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "pull": {
                    "type": "integer",
                    "description":
                        "One pull request's number, for that one in full with its \
                         description. Azure DevOps only — on a GitHub repository, \
                         `gh pr view <n>` is the equivalent and works here."
                },
                "mine": {
                    "type": "boolean",
                    "description":
                        "Keep only the ones you opened, read off the credential's own \
                         identity. Note this is about the *account* Volery authenticates \
                         with, which is the user's, not about which card did anything."
                }
            }
        }
    })
}

pub fn pull_request_schema() -> Value {
    json!({
        "name": PULL_REQUEST_TOOL,
        "description":
            "Open a pull request, or change an existing one's title and description. **This \
             one writes**, on Azure DevOps, under the user's own credential and their name — \
             so read `reviews` first and act on what it said.\n\n\
             **Use this instead of `az repos pr create`,** which cannot work on this machine: \
             the network intercepts TLS and `az` does not read the Windows certificate store, \
             so it fails with a certificate error while this call succeeds against the same \
             host. That mismatch is the whole reason this tool exists.\n\n\
             **Azure DevOps only, and deliberately.** On a GitHub repository use `gh pr \
             create` / `gh pr edit` — `gh` is signed in on this machine and has no \
             certificate problem, so there is nothing here for a tool to add. This one will \
             tell you so rather than guessing.\n\n\
             What it will not do, and will not gain: **no vote, no approve, no complete, no \
             auto-complete, no abandon, no merge, no re-queueing a build.** A card may write \
             what a person would type into a text field and nothing that lands a judgement \
             under somebody's name or starts a machine moving. Those belong where the diff \
             is.\n\n\
             `create` needs the source branch pushed first — a pull request is about a ref \
             the server can see, and an unpushed branch comes back as a ref that does not \
             exist. The branch you are on and the repository's default branch are the \
             defaults, so the ordinary call names only a title and a description.\n\n\
             `update` sends **only the fields you name**. Leave `description` out to change \
             the title alone; passing an empty string is a real instruction to empty it.\n\n\
             Write the description as a person would want to read it: what changed and why, \
             not a transcript of how you got there. It is the first thing a reviewer sees and \
             the last thing anybody edits.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "update"],
                    "description":
                        "`create` opens a new one. `update` changes the title or description \
                         of one that exists and needs its `pull` number. Named rather than \
                         inferred from whether `pull` is present, because the way that infers \
                         wrongly is by opening a duplicate pull request on somebody's review \
                         queue."
                },
                "pull": {
                    "type": "integer",
                    "description":
                        "Which pull request to change. Required for `update`, and refused for \
                         `create` — a create that names one is a call that meant to update."
                },
                "title": {
                    "type": "string",
                    "description":
                        "One line. Required for `create`; for `update`, give it only if you \
                         are changing it."
                },
                "description": {
                    "type": "string",
                    "description":
                        "The body, in markdown. For `update` this replaces the whole field, \
                         so read the current one with `reviews` first unless you mean to \
                         discard it."
                },
                "source": {
                    "type": "string",
                    "description":
                        "The branch to merge, for `create`. Defaults to the branch this \
                         card's own working tree is on, which is nearly always what you \
                         mean — and is the card's worktree branch, not the project's. Must \
                         already be pushed."
                },
                "target": {
                    "type": "string",
                    "description":
                        "The branch to merge into, for `create`. Defaults to the \
                         repository's own default branch, asked of the server rather than \
                         guessed at — a repository whose trunk is `master` would otherwise \
                         get a pull request aimed at a `main` that does not exist."
                },
                "draft": {
                    "type": "boolean",
                    "description":
                        "Open it as a draft, for `create`. Worth it when you want the diff \
                         visible without putting it on anybody's review queue yet."
                }
            },
            "required": ["action"]
        }
    })
}

/* ── the answers ─────────────────────────────────────────────────────────── */

/// Route a `tools/call` to whichever of the **two readings** it names, or `None`
/// so `ask.rs` can try the next module — the same contract `relay::handle` and
/// `servers::handle` have.
///
/// **`pull_request` is deliberately not here**, and the omission is the same one
/// `spawn::close` makes for the same reason: a call that may have to wait for a
/// person cannot be routed through a chain that has already committed to
/// answering on the spot. `ask.rs` calls `smith::pull_request` directly, before
/// it reaches this. Adding it below would be a write that never asked.
///
/// **This must not become a `#[tauri::command]`**, and it is worth the same
/// sentence `servers::handle` carries: these calls make sequential HTTPS
/// requests against a ten-second connect timeout, which is affordable only
/// because `ask::start` gives each MCP request its own thread. On the main
/// thread it would be the freeze `crate::off_main` exists to prevent.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        PIPELINES_TOOL => Some(do_pipelines(app, conversation_id, args)),
        REVIEWS_TOOL => Some(do_reviews(app, conversation_id, args)),
        _ => None,
    }
}

/// A branch matcher that copes with both forges' spellings.
///
/// Azure DevOps sends `refs/heads/main` and GitHub sends a bare `main`, and a
/// card types whichever it thinks of. Compared on the tail rather than by
/// stripping a prefix, so `refs/heads/feature/x` matches `feature/x` and a tag
/// push — which GitHub sends bare and unmarked — still matches its own name.
fn same_branch(row: &str, want: &str) -> bool {
    let tidy = |s: &str| s.trim().trim_start_matches("refs/heads/").to_ascii_lowercase();
    tidy(row) == tidy(want)
}

/// Whether a run is one somebody would want to hear about.
///
/// Not `result != "succeeded"`, which would sweep in every run still going and
/// every one that was skipped. Each forge's own words, and the two GitHub has
/// that Azure DevOps has no spelling for are exactly the interesting ones —
/// `action_required` is a deployment parked waiting for a person, which is the
/// single most useful row this can answer with.
fn went_wrong(status: &str, result: &str) -> bool {
    matches!(
        result,
        "failed" | "canceled" | "cancelled" | "failure" | "timed_out" | "startup_failure"
            | "action_required"
    ) || status == "waiting"
}

fn do_pipelines(app: &AppHandle, caller: &str, args: &Value) -> String {
    let stand = match standing(app, caller) {
        Ok(s) => s,
        Err(why) => return why,
    };

    /* One run, opened. Answered first and on its own, because a caller that has
       named a run has stopped asking about a list and every filter below would
       be noise. */
    if let Some(id) = args.get("run").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return match crate::azdo::one_run(app, id) {
            Ok(detail) => match serde_json::to_value(&detail) {
                Ok(v) => v.to_string(),
                Err(e) => format!("could not read that run: {e}"),
            },
            Err(why) => format!(
                "{why}\n\nA run's id is the string this tool reports on each row — \
                 `azdo/<org>/<project>/<build>` or `github/<owner>/<repo>/<run>`. It is not \
                 the build number."
            ),
        };
    }

    let got = crate::azdo::both_runs(app, &[stand.root.clone()]);
    let mine = crate::azdo::origin_for(&stand.root);

    /* Azure DevOps answers builds per project and there is no way to ask for one
       project's alone without enumerating the organisation, so the narrowing
       happens here. GitHub rows need none of it — that half is already asked per
       repository, and this card's territory is one repository. */
    let all: Vec<&crate::forge::Run> = got.runs.iter().collect();
    let (rows, scope): (Vec<&crate::forge::Run>, &str) = match &mine {
        Some(at) => {
            let kept: Vec<&crate::forge::Run> = all
                .iter()
                .copied()
                .filter(|r| {
                    r.forge != "azdo" || r.project.eq_ignore_ascii_case(&at.project)
                })
                .collect();
            /* The remote can name a project by its guid, or by a name the API
               spells differently, and then the filter matches nothing. Falling
               back to the organisation is better than answering "nothing is
               building here" — which would be the face claiming to know
               something it does not — and the scope says which happened. */
            if kept.is_empty() && !all.is_empty() {
                (all, "the whole organisation — this project's remote matched no rows")
            } else {
                (kept, "this project")
            }
        }
        None => (all, "everything this card's territory can see"),
    };

    let want_branch = args.get("branch").and_then(Value::as_str).filter(|s| !s.is_empty());
    let only_bad = args.get("failed").and_then(Value::as_bool).unwrap_or(false);
    let matched: Vec<&crate::forge::Run> = rows
        .into_iter()
        .filter(|r| want_branch.is_none_or(|b| same_branch(&r.branch, b)))
        .filter(|r| !only_bad || went_wrong(&r.status, &r.result))
        .collect();

    let found = matched.len();
    let shown: Vec<Value> = matched
        .iter()
        .take(RUNS_SHOWN)
        .filter_map(|r| serde_json::to_value(r).ok())
        .collect();

    json!({
        "project": stand.project,
        "scope": scope,
        "orgs": got.orgs,
        "runs": shown,
        "found": found,
        /* Named rather than left to be inferred from `found` against the array
           length, because a bound that can hide the row you were looking for
           has to say so in a word the reader cannot miss. */
        "dropped": found.saturating_sub(RUNS_SHOWN),
        /* Requests that left the machine, and projects no credential could see.
           Both are carried through from the widgets' own reading for the reason
           they exist there: "nothing is building" and "you are not on these
           projects" are different sentences. */
        "asked": got.asked,
        "unseen": got.unseen,
        "fault": got.fault,
        "note": "Name a `run` id from a row above for its stages and steps — which job and \
                 which step went red. Each service's own vocabulary, verbatim.",
    })
    .to_string()
}

fn do_reviews(app: &AppHandle, caller: &str, args: &Value) -> String {
    let stand = match standing(app, caller) {
        Ok(s) => s,
        Err(why) => return why,
    };

    /* One pull request in full, which is the only reading that carries a
       description — and therefore the one to take before amending it. */
    if let Some(number) = args.get("pull").and_then(Value::as_i64).filter(|n| *n > 0) {
        let Some(at) = crate::azdo::origin_for(&stand.root) else {
            return not_azdo(&stand.project, &format!("gh pr view {number}"));
        };
        return match crate::azdo::pull_read(app, &at, number) {
            Ok(v) => one_pull(&at, &v).to_string(),
            Err(why) => format!(
                "could not read pull request {number} in {}/{}: {why}",
                at.project, at.repo
            ),
        };
    }

    let got = crate::azdo::both_reviews(app, &[stand.root.clone()]);
    let mine = crate::azdo::origin_for(&stand.root);

    let all: Vec<&crate::forge::Review> = got.reviews.iter().collect();
    let (rows, scope): (Vec<&crate::forge::Review>, &str) = match &mine {
        Some(at) => {
            let kept: Vec<&crate::forge::Review> = all
                .iter()
                .copied()
                .filter(|r| {
                    r.forge != "azdo"
                        || r.repo.eq_ignore_ascii_case(&at.repo)
                        || r.project.eq_ignore_ascii_case(&at.project)
                })
                .collect();
            if kept.is_empty() && !all.is_empty() {
                (all, "the whole organisation — this project's remote matched no rows")
            } else {
                (kept, "this project")
            }
        }
        None => (all, "everything this card's territory can see"),
    };

    let only_mine = args.get("mine").and_then(Value::as_bool).unwrap_or(false);
    let matched: Vec<&crate::forge::Review> =
        rows.into_iter().filter(|r| !only_mine || r.mine).collect();

    let found = matched.len();
    let shown: Vec<Value> = matched
        .iter()
        .take(REVIEWS_SHOWN)
        .filter_map(|r| serde_json::to_value(r).ok())
        .collect();

    json!({
        "project": stand.project,
        "scope": scope,
        "orgs": got.orgs,
        "reviews": shown,
        "found": found,
        "dropped": found.saturating_sub(REVIEWS_SHOWN),
        "asked": got.asked,
        "unseen": got.unseen,
        "fault": got.fault,
        "note": "No description on a row — name a `pull` number for one in full. Votes are \
                 Azure DevOps' scale: 10 approved, 5 with suggestions, 0 not yet, -5 waiting \
                 for the author, -10 rejected.",
    })
    .to_string()
}

/// One pull request, as much of it as is worth reading.
///
/// A projection rather than the raw body, and this is the one place in the file
/// that makes one. Azure DevOps' single-pull-request payload is several
/// kilobytes of identity objects, `_links` and repository metadata around the
/// four fields anybody wants, and a card that asked to read a description before
/// editing it should not pay for the rest of it. The list readings are passed
/// through whole by contrast, because there the shapes are `forge.rs`'s own and
/// already exactly what a wall needs.
fn one_pull(at: &crate::azdo::Origin, v: &Value) -> Value {
    let s = |k: &str| crate::forge::text(v, k);
    json!({
        "org": at.org,
        "project": at.project,
        "repo": at.repo,
        "number": v.get("pullRequestId").and_then(Value::as_i64),
        "title": s("title"),
        /* The whole point of this reading. Absent rather than empty when there
           is none, so "it has no description" and "I could not read it" are not
           the same answer. */
        "description": v.get("description").and_then(Value::as_str),
        "status": s("status"),
        "draft": v.get("isDraft").and_then(Value::as_bool),
        "source": s("sourceRefName"),
        "target": s("targetRefName"),
        "merge": s("mergeStatus"),
        "by": v.get("createdBy").map(|b| crate::forge::text(b, "displayName")),
        "createdAt": s("creationDate"),
        "url": v
            .get("_links")
            .and_then(|l| l.get("web"))
            .map(|w| crate::forge::text(w, "href")),
        "votes": v.get("reviewers").and_then(Value::as_array).map(|a| {
            a.iter()
                .map(|r| {
                    json!({
                        "by": crate::forge::text(r, "displayName"),
                        "vote": r.get("vote").and_then(Value::as_i64),
                        "required": r.get("isRequired").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>()
        }),
    })
}

/// The sentence a card on a GitHub repository gets instead of a worse `gh`.
///
/// Names the command rather than saying "not supported", because the card is
/// mid-task and what it needs is the thing that does work. See the header for
/// why this is a floor rather than a gap.
fn not_azdo(project: &str, instead: &str) -> String {
    format!(
        "{project} is not on Azure DevOps, and this tool is Azure DevOps only — deliberately. \
         `gh` is signed in on this machine and has no certificate problem to work around, so \
         `{instead}` does what you want and there is nothing here that would do it better. \
         The `pipelines` and `reviews` *readings* do answer for GitHub; only the writing half \
         is one forge."
    )
}

/* ── the write, and the person it is asked of ──────────────────────────────
 *
 * **A pull request is outward-facing, so this tool asks before it writes.** That
 * is the guard, and it is worth stating why it is not merely caution.
 *
 * Everything else on this server is reversible from inside the wall: a notice
 * comes down, a sink item goes back, a card is adopted again. A pull request is
 * not — it appears on other people's review queue, under the user's own name, on
 * a server this app does not own, and a card cannot un-notify anybody. Sink
 * `4951f398` is the cautionary case from the other direction: the Spotify player
 * is green on every gate in this repository and has never made a sound, because
 * *nothing that gate could check was the thing that mattered*. A write into
 * somebody's organisation has the same shape — every test can pass and the pull
 * request can still be one nobody wanted.
 *
 * So the mechanism is `spawn::close`'s, exactly: the decision is taken **before**
 * the transport commits to answering, the call is parked as a real `ask_user`
 * question on the card, and a closure does the writing if the answer is yes. Two
 * consequences worth knowing:
 *
 * - **The defaults are resolved before the question, not after.** Working out the
 *   source branch and asking the server for the target costs a `git` spawn and
 *   one request, and doing it after approval would put a question up saying "open
 *   a pull request" without being able to say *from what, into what* — which is
 *   most of what somebody is deciding.
 * - **Nothing is re-read on approval, and that is deliberate here where it is not
 *   in `spawn::close`.** Closing a card had to re-check the wall because the card
 *   could have started a turn in the ten minutes. Here the only thing that could
 *   have changed is on Azure DevOps' side, and Azure DevOps is the one that
 *   checks it: a duplicate comes back 409 naming the existing pull request, an
 *   abandoned one comes back 404, and both are surfaced verbatim. A re-read would
 *   be a second opinion about a fact the write itself establishes. */

/// What a `pull_request` call turns out to be. `spawn::Closing`'s shape, for the
/// same reason it has one.
pub(crate) enum Writing {
    /// Answer the tool call with this, now. Every refusal and every argument
    /// problem is one of these — nothing reaches a person until the call is
    /// well-formed enough to be worth their attention.
    Now(String),
    /// Put this question up and wait. `settle` does the writing if it is a yes.
    Ask {
        question: Value,
        settle: crate::ask::Settle,
    },
}

/// The two things the user may say to a create, and the exact words a click
/// sends. `approved` matches the first and nothing looser — see below.
const OPEN_IT: &str = "open it";
const DO_NOT_OPEN: &str = "do not open it";

/// And to an update.
const CHANGE_IT: &str = "change it";
const DO_NOT_CHANGE: &str = "leave it as it is";

/// Did the user actually approve this?
///
/// Exact, and nothing looser, for the reason `spawn::approved` gives: the panel
/// has a free-text field beside the buttons (`Ask.svelte`), so what comes back is
/// arbitrary prose, and reading a yes out of prose works until "yes, but call it
/// something else" — at which point a pull request exists with the wrong title on
/// it. **Only the button is an approval.** Everything else is carried back to the
/// agent verbatim rather than flattened into a no, because the user has said
/// something and the agent is the thing standing there able to act on it.
fn approved(answer: &str, yes: &str) -> bool {
    answer.trim().eq_ignore_ascii_case(yes)
}

/// The most of a description that reaches the question.
///
/// This is one panel on a wall, not a document viewer. A card that has written
/// two thousand words of pull request body is asking about the *act*, and the
/// user deciding whether to open it needs the title, the branches and enough of
/// the body to recognise it. What was cut is marked, because a body that stops
/// mid-sentence with nothing said about it reads as the body that will be posted.
const MAX_SHOWN: usize = 600;

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}\n\n… (clipped for this question — the whole of it will be posted)")
}

/// What goes up before a pull request is opened.
///
/// Written to the standard `ask_user` questions are held to, and carrying the
/// four things somebody cannot go and look up for themselves: **where** it lands
/// (project and repository), **what** is being merged into what, **what it will
/// say**, and **that it is going out under their name**. The last is the one an
/// agent would never think to mention and is half the reason to ask at all.
fn create_question(
    at: &crate::azdo::Origin,
    source: &str,
    target: &str,
    title: &str,
    description: &str,
    draft: bool,
) -> Value {
    let body = if description.trim().is_empty() {
        "\n\nIt has written **no description**.".to_string()
    } else {
        format!("\n\n---\n\n{}", clip(description, MAX_SHOWN))
    };
    let kind = if draft { " as a **draft**" } else { "" };
    json!({
        "questions": [{
            "header": "open a pull request",
            "question": format!(
                "A card wants to open a pull request{kind} in **{}/{}** — merging `{source}` \
                 into `{target}`.\n\n**{title}**{body}\n\nThis goes out under your own \
                 credential and your own name, and lands on whoever reviews that repository. \
                 Nothing here can take it back.",
                at.project, at.repo
            ),
            "options": [
                { "label": OPEN_IT, "detail": "Open it. You get the url back." },
                {
                    "label": DO_NOT_OPEN,
                    "detail": "Nothing is created. The agent is told you said so."
                }
            ]
        }]
    })
}

/// And before an existing one is edited.
///
/// Says which fields are changing rather than only showing the new values,
/// because the thing worth catching here is a card replacing a description it
/// never read — and "the description will be replaced" is the sentence that makes
/// somebody look.
fn update_question(
    at: &crate::azdo::Origin,
    number: i64,
    title: Option<&str>,
    description: Option<&str>,
) -> Value {
    let mut said = String::new();
    if let Some(t) = title {
        said.push_str(&format!("\n\n**New title:** {t}"));
    }
    if let Some(d) = description {
        said.push_str(&format!(
            "\n\n**The description will be replaced** with:\n\n---\n\n{}",
            if d.trim().is_empty() {
                "*(emptied)*".to_string()
            } else {
                clip(d, MAX_SHOWN)
            }
        ));
    }
    json!({
        "questions": [{
            "header": "edit a pull request",
            "question": format!(
                "A card wants to edit pull request **!{number}** in **{}/{}**.{said}\n\nThe \
                 edit is made with your credential, so it shows as yours. Only the fields \
                 above change — the branches, the votes and the policies are not touched.",
                at.project, at.repo
            ),
            "options": [
                { "label": CHANGE_IT, "detail": "Make the change." },
                {
                    "label": DO_NOT_CHANGE,
                    "detail": "Nothing is changed. The agent is told you said so."
                }
            ]
        }]
    })
}

/// What the caller is told when nobody answers.
fn unanswered(what: &str) -> String {
    format!(
        "nobody answered, so nothing was written — {what} did not happen. Either the question \
         stood for ten minutes or the card was dismissed while it was up. Carry on with your \
         own judgement, say that you offered, and do not simply try again."
    )
}

/// And when they say no, or say something else.
///
/// The refusal is not reworded into "I cannot do that": the user *was* asked and
/// has answered, and telling an agent to go and ask them is how a card asks twice
/// about one pull request. Anything that is not the button comes back verbatim,
/// because a person who typed a sentence typed it for the agent.
fn declined(what: &str, answer: &str, no: &str) -> String {
    let said = answer.trim();
    if said.eq_ignore_ascii_case(no) {
        return format!(
            "the user was asked and said no, so {what} did not happen. That is an answer \
             rather than this tool refusing you — do not ask again about the same pull \
             request, and say in your reply that you offered."
        );
    }
    format!(
        "the user was asked and pressed neither button. They said: {said:?}. Nothing was \
         written. Act on what they actually said."
    )
}

/// The `pull_request` tool, as far as it can be decided without a person.
///
/// Called from `ask.rs` directly rather than through `handle`, the way
/// `spawn::close` is, because the decision has to be taken before the transport
/// commits to answering on the spot — and it must be taken once.
pub(crate) fn pull_request(app: &AppHandle, caller: &str, args: &Value) -> Writing {
    let stand = match standing(app, caller) {
        Ok(s) => s,
        Err(why) => return Writing::Now(why),
    };
    let action = args.get("action").and_then(Value::as_str).unwrap_or("");
    let title = args.get("title").and_then(Value::as_str).map(str::trim);
    /* Not trimmed, unlike the title. A description is markdown and its trailing
       newline is the author's; a title is one line and its stray whitespace is
       never meant. */
    let description = args.get("description").and_then(Value::as_str);
    let number = args.get("pull").and_then(Value::as_i64);

    let Some(at) = crate::azdo::origin_for(&stand.root) else {
        let instead = match action {
            "update" => "gh pr edit",
            _ => "gh pr create",
        };
        return Writing::Now(not_azdo(&stand.project, instead));
    };

    match action {
        "update" => {
            let Some(number) = number.filter(|n| *n > 0) else {
                return Writing::Now(
                    "`update` needs the `pull` number of the pull request to change. `reviews` \
                     lists them."
                        .into(),
                );
            };
            if title.is_none() && description.is_none() {
                return Writing::Now(
                    "nothing to change — `update` wants a `title`, a `description`, or both. \
                     Only the fields you name are sent, so leaving one out keeps it as it is."
                        .into(),
                );
            }
            if title.is_some_and(str::is_empty) {
                return Writing::Now(
                    "a pull request cannot have an empty title. Leave `title` out to keep the \
                     one it has."
                        .into(),
                );
            }
            /* An update that names branches is a create that lost its way, or a
               card expecting this tool to retarget one. Refused rather than
               silently ignored: a request that quietly does less than it said is
               how a card reports having done something it has not. */
            if args.get("source").is_some() || args.get("target").is_some() {
                return Writing::Now(
                    "this tool does not move a pull request's branches — only its title and \
                     description. Retargeting changes what is being merged, which is not \
                     something a card decides on somebody's behalf; do it in the browser, or \
                     abandon this one and open another."
                        .into(),
                );
            }

            let question = update_question(&at, number, title, description);
            let what = format!("editing pull request !{number}");
            /* Owned into the closure, because it outlives this call by up to ten
               minutes. `Settle` is `Send` and the request is answered on its own
               thread, so nothing here may borrow from `args`. */
            let at = at.clone();
            let title = title.map(str::to_string);
            let description = description.map(str::to_string);
            Writing::Ask {
                question,
                settle: Box::new(move |app, answer| {
                    let Some(answer) = answer else {
                        return unanswered(&what);
                    };
                    if !approved(answer, CHANGE_IT) {
                        return declined(&what, answer, DO_NOT_CHANGE);
                    }
                    /* Which fields actually went, echoed rather than left to be
                       inferred from the request. A PATCH here is a merge, so "a
                       title and not a description" is the difference between a
                       typo fixed and a description emptied. */
                    let mut fields: Vec<&str> = Vec::new();
                    if title.is_some() {
                        fields.push("title");
                    }
                    if description.is_some() {
                        fields.push("description");
                    }
                    match crate::azdo::pull_amend(
                        app,
                        &at,
                        number,
                        title.as_deref(),
                        description.as_deref(),
                    ) {
                        Ok(v) => json!({
                            "changed": true,
                            "approvedByTheUser": true,
                            "number": v
                                .get("pullRequestId")
                                .and_then(Value::as_i64)
                                .unwrap_or(number),
                            "title": crate::forge::text(&v, "title"),
                            "fields": fields,
                            "url": web_url(&at, number),
                            "note": "The user approved this and it is written under their own \
                                     name. Say that you asked, that they agreed, and what \
                                     changed.",
                        })
                        .to_string(),
                        Err(why) => format!(
                            "the user approved it, but the edit did not land: {why}\n\nPull \
                             request {number} in {}/{} — it may have been completed or \
                             abandoned while the question was up, or the credential Volery \
                             holds may have no Code (write) scope. Tell the user it failed \
                             rather than trying again.",
                            at.project, at.repo
                        ),
                    }
                }),
            }
        }
        "create" => {
            if number.is_some() {
                return Writing::Now(
                    "`create` opens a new pull request and cannot be given a `pull` number. If \
                     you meant to change one that exists, that is `action: \"update\"`."
                        .into(),
                );
            }
            let Some(title) = title.filter(|t| !t.is_empty()) else {
                return Writing::Now(
                    "`create` needs a `title` — it is the line every reviewer sees first."
                        .into(),
                );
            };
            let source = match args
                .get("source")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(s) => s.to_string(),
                None => match branch_at(&stand.cwd) {
                    Some(b) => b,
                    None => {
                        return Writing::Now(format!(
                            "could not tell what branch {} is on — it may be a detached HEAD. \
                             Name `source` explicitly.",
                            stand.cwd
                        ))
                    }
                },
            };
            let target = match args
                .get("target")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(t) => t.to_string(),
                /* Asked of the server rather than defaulted to `main`, because
                   guessing fails in the expensive direction: a repository with
                   both branches would get a real pull request aimed at the wrong
                   one. See `azdo::default_branch_of`. It happens before the
                   question so the question can say what it is asking about. */
                None => match crate::azdo::pull_target(app, &at) {
                    Ok(t) => t,
                    Err(why) => {
                        return Writing::Now(format!(
                            "could not ask {}/{} what its default branch is: {why}",
                            at.project, at.repo
                        ))
                    }
                },
            };
            /* Caught here rather than left to the service, because Azure DevOps'
               own message for it names refs and not the mistake, and the mistake
               is nearly always the same one: a card on the trunk that meant to
               push a branch first. */
            if same_branch(&source, &target) {
                return Writing::Now(format!(
                    "`{source}` is both the source and the target, so there is nothing to \
                     merge. If you are still on the target branch, make and push a branch \
                     first — or name `source` if you meant a different one."
                ));
            }

            let draft = args.get("draft").and_then(Value::as_bool).unwrap_or(false);
            let description = description.unwrap_or("").to_string();
            let question = create_question(&at, &source, &target, title, &description, draft);
            let what = format!("opening a pull request from `{source}`");
            let at = at.clone();
            let title = title.to_string();
            Writing::Ask {
                question,
                settle: Box::new(move |app, answer| {
                    let Some(answer) = answer else {
                        return unanswered(&what);
                    };
                    if !approved(answer, OPEN_IT) {
                        return declined(&what, answer, DO_NOT_OPEN);
                    }
                    match crate::azdo::pull_open(
                        app,
                        &at,
                        &source,
                        &target,
                        &title,
                        &description,
                        draft,
                    ) {
                        Ok(v) => {
                            let n = v.get("pullRequestId").and_then(Value::as_i64).unwrap_or(0);
                            json!({
                                "created": true,
                                "approvedByTheUser": true,
                                "number": n,
                                "title": crate::forge::text(&v, "title"),
                                "source": crate::forge::text(&v, "sourceRefName"),
                                "target": crate::forge::text(&v, "targetRefName"),
                                "draft": v.get("isDraft").and_then(Value::as_bool),
                                "url": web_url(&at, n),
                                "note": "The user approved this and it is on the team's review \
                                         queue now, under their own name. Say that you asked, \
                                         that they agreed, and give them the url.",
                            })
                            .to_string()
                        }
                        Err(why) => format!(
                            "the user approved it, but the pull request was not opened: \
                             {why}\n\nFrom `{source}` into `{target}` in {}/{}. The usual \
                             causes, in the order they happen: the source branch has not been \
                             pushed; a pull request for these two branches is already open \
                             (the message names it); or the credential Volery holds has no \
                             Code (write) scope — the token panel on the wall is where that \
                             is fixed. Tell the user it failed rather than trying again.",
                            at.project, at.repo
                        ),
                    }
                }),
            }
        }
        "" => Writing::Now(
            "`pull_request` needs an `action`: \"create\" to open one, \"update\" to change an \
             existing one's title or description."
                .into(),
        ),
        other => Writing::Now(format!(
            "no such action {other:?} — this tool does \"create\" and \"update\" and nothing \
             else. It deliberately cannot vote, approve, complete, abandon or merge; those \
             land a judgement under the user's name and belong where the diff is."
        )),
    }
}

/// Where a pull request lives on the web.
///
/// Composed rather than taken out of `_links`, the same bargain `read_reviews`
/// strikes with a run's url: the shape is stable, it is one fewer field that can
/// be absent, and the create response's `_links` is not documented to carry a
/// `web` entry at all.
fn web_url(at: &crate::azdo::Origin, number: i64) -> String {
    format!(
        "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{number}",
        crate::forge::encode(&at.org),
        crate::forge::encode(&at.project),
        crate::forge::encode(&at.repo),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_branch_matches_across_both_forges_spellings() {
        /* Azure DevOps sends `refs/heads/main`, GitHub sends `main`, and a card
           types whichever it thought of. All four pairings have to match. */
        assert!(same_branch("refs/heads/main", "main"));
        assert!(same_branch("main", "refs/heads/main"));
        assert!(same_branch("main", "main"));
        assert!(same_branch("refs/heads/main", "refs/heads/main"));
        /* A branch with slashes in it, which is most of them. */
        assert!(same_branch("refs/heads/feature/azdo-tools", "feature/azdo-tools"));
        /* Case, because git is case-sensitive and people are not. */
        assert!(same_branch("refs/heads/Main", "main"));
        assert!(same_branch("  main  ", "main"));
    }

    #[test]
    fn a_branch_that_is_not_the_one_asked_for_does_not_match() {
        assert!(!same_branch("refs/heads/main", "master"));
        assert!(!same_branch("refs/heads/feature/a", "feature/b"));
        /* A prefix is not a match — `main` and `maintenance` are two branches,
           and a `starts_with` here would have quietly merged them. */
        assert!(!same_branch("refs/heads/maintenance", "main"));
        /* A tag push arrives from GitHub as a bare name with no marker, so it
           matches its own name and not a branch's. */
        assert!(!same_branch("v0.13.0", "main"));
    }

    #[test]
    fn a_run_still_going_has_not_gone_wrong() {
        /* `result` is empty while a run is in flight on both forges, and the
           obvious spelling of this predicate — `result != "succeeded"` — calls
           every running build a failure. That is the whole reason it is a
           function. */
        assert!(!went_wrong("inProgress", ""));
        assert!(!went_wrong("in_progress", ""));
        assert!(!went_wrong("notStarted", ""));
        assert!(!went_wrong("queued", ""));
    }

    #[test]
    fn a_run_that_succeeded_or_was_skipped_has_not_gone_wrong() {
        assert!(!went_wrong("completed", "succeeded"));
        assert!(!went_wrong("completed", "success"));
        /* `partiallySucceeded` means the build worked and something
           non-blocking did not, so it produced an artifact — amber on the wall,
           and not what somebody asking "is anything broken" means. */
        assert!(!went_wrong("completed", "partiallySucceeded"));
        assert!(!went_wrong("completed", "skipped"));
        assert!(!went_wrong("completed", "neutral"));
        /* Something neither forge's vocabulary covers is not invented into a
           fault — the same rule that keeps the widget from drawing red at a
           result nothing recognises. */
        assert!(!went_wrong("completed", "somethingNewInApiVersion8"));
    }

    #[test]
    fn both_forges_spellings_of_going_wrong_are_recognised() {
        /* Azure DevOps has one `l` in cancelled and GitHub has two, which is
           exactly the sort of thing a single spelling would silently miss. */
        assert!(went_wrong("completed", "failed"));
        assert!(went_wrong("completed", "failure"));
        assert!(went_wrong("completed", "canceled"));
        assert!(went_wrong("completed", "cancelled"));
        /* The two GitHub states Azure DevOps has no word for, which is why
           `forge.rs` refuses to project a conclusion. `action_required` is a
           deployment parked waiting for a person — the single most useful row
           this predicate can keep. */
        assert!(went_wrong("completed", "timed_out"));
        assert!(went_wrong("completed", "startup_failure"));
        assert!(went_wrong("completed", "action_required"));
        assert!(went_wrong("waiting", ""));
    }

    #[test]
    fn only_the_button_is_an_approval() {
        /* The panel has a free-text field beside its two buttons, so what comes
           back is arbitrary prose. Reading a yes out of prose works right up
           until "yes, but call it something else" — and then a pull request
           exists with the wrong title on it, under the user's name, on somebody
           else's review queue. */
        assert!(approved("open it", OPEN_IT));
        assert!(approved("  Open It  ", OPEN_IT));
        assert!(approved("change it", CHANGE_IT));
        /* Every one of these is a person saying something, and none of them is
           the button. */
        assert!(!approved("yes", OPEN_IT));
        assert!(!approved("yes, open it", OPEN_IT));
        assert!(!approved("open it but retitle it first", OPEN_IT));
        assert!(!approved("", OPEN_IT));
        assert!(!approved(DO_NOT_OPEN, OPEN_IT));
        /* And the two questions cannot answer each other, which matters because
           one creates and one edits. */
        assert!(!approved(CHANGE_IT, OPEN_IT));
        assert!(!approved(OPEN_IT, CHANGE_IT));
    }

    #[test]
    fn a_deliberate_no_reads_differently_from_a_sentence() {
        /* Two different things for the agent to do about it. A pressed "no" is a
           decision to stop asking; anything typed is an instruction to act on,
           and is carried back word for word rather than flattened into a
           refusal. */
        let no = declined("opening it", DO_NOT_OPEN, DO_NOT_OPEN);
        assert!(no.contains("said no"), "{no}");
        assert!(no.contains("do not ask again"), "{no}");

        let prose = declined("opening it", "not until the tests pass", DO_NOT_OPEN);
        assert!(
            prose.contains("not until the tests pass"),
            "the user's own words have to survive: {prose}"
        );
        assert!(prose.contains("neither button"), "{prose}");
    }

    #[test]
    fn nobody_answering_is_not_read_as_a_yes() {
        /* The ten minutes running out, or the card being dismissed. The one
           thing this must never do is look like approval. */
        let said = unanswered("opening a pull request");
        assert!(said.contains("nobody answered"), "{said}");
        assert!(said.contains("did not happen"), "{said}");
        assert!(said.contains("do not simply try again"), "{said}");
    }

    #[test]
    fn a_question_says_where_it_lands_and_whose_name_is_on_it() {
        /* The four things somebody cannot go and look up while a panel is in
           front of them: which repository, what is merging into what, what it
           will say, and that it goes out as them. A question missing the last
           one is a question that reads as harmless. */
        let at = crate::azdo::Origin {
            org: "LagardereAWPL".into(),
            project: "NOVA".into(),
            repo: "NOVA".into(),
        };
        let q = create_question(
            &at,
            "feature/azdo-tools",
            "refs/heads/main",
            "expose the forge to cards",
            "Three tools over the path the wall already has working.",
            false,
        );
        let said = q["questions"][0]["question"].as_str().unwrap();
        assert!(said.contains("NOVA/NOVA"), "{said}");
        assert!(said.contains("feature/azdo-tools"), "{said}");
        assert!(said.contains("refs/heads/main"), "{said}");
        assert!(said.contains("expose the forge to cards"), "{said}");
        assert!(said.contains("your own name"), "{said}");
        /* Both buttons offered, and the yes is the exact string `approved`
           matches — a label and a matcher that drift apart is a question nobody
           can say yes to. */
        assert_eq!(q["questions"][0]["options"][0]["label"], OPEN_IT);
        assert_eq!(q["questions"][0]["options"][1]["label"], DO_NOT_OPEN);
    }

    #[test]
    fn a_create_with_no_description_says_that_rather_than_showing_a_gap() {
        /* A card that wrote no body is a thing worth seeing before approving,
           and an empty stretch of panel does not say it. */
        let at = crate::azdo::Origin {
            org: "o".into(),
            project: "p".into(),
            repo: "r".into(),
        };
        let q = create_question(&at, "a", "b", "t", "   \n ", false);
        let said = q["questions"][0]["question"].as_str().unwrap();
        assert!(said.contains("no description"), "{said}");
        /* And a draft is named, since it is the difference between landing on
           somebody's queue and not. */
        let d = create_question(&at, "a", "b", "t", "body", true);
        assert!(d["questions"][0]["question"].as_str().unwrap().contains("draft"));
    }

    #[test]
    fn an_update_question_names_which_fields_change() {
        /* The failure worth catching here is a card replacing a description it
           never read. Showing the new value is not enough — "the description
           will be replaced" is the sentence that makes somebody look. */
        let at = crate::azdo::Origin {
            org: "o".into(),
            project: "NOVA".into(),
            repo: "NOVA".into(),
        };
        let only_title = update_question(&at, 41, Some("a better title"), None);
        let said = only_title["questions"][0]["question"].as_str().unwrap();
        assert!(said.contains("!41"), "{said}");
        assert!(said.contains("a better title"), "{said}");
        assert!(
            !said.contains("description will be replaced"),
            "a title-only edit must not claim to touch the description: {said}"
        );

        let both = update_question(&at, 41, Some("t"), Some("new body"));
        let said = both["questions"][0]["question"].as_str().unwrap();
        assert!(said.contains("description will be replaced"), "{said}");
        assert!(said.contains("new body"), "{said}");

        /* An explicit empty string is a real instruction to empty the field, and
           the question has to say so — this is the one edit that destroys
           something and it would otherwise be the quietest. */
        let emptied = update_question(&at, 41, None, Some(""));
        let said = emptied["questions"][0]["question"].as_str().unwrap();
        assert!(said.contains("emptied"), "{said}");
    }

    #[test]
    fn a_long_description_is_clipped_and_says_that_it_was() {
        /* A body that stops mid-sentence with nothing said about it reads as the
           body that will be posted, which is the wrong thing to be approving. */
        let long = "x".repeat(MAX_SHOWN + 50);
        let out = clip(&long, MAX_SHOWN);
        assert!(out.contains("clipped for this question"), "{out}");
        assert!(out.contains("the whole of it will be posted"), "{out}");
        /* And something that fits is untouched, down to its trailing newline —
           a description's whitespace is the author's. */
        assert_eq!(clip("short\n", MAX_SHOWN), "short\n");
    }

    #[test]
    fn a_pull_request_url_is_composed_from_names_and_escaped() {
        let at = crate::azdo::Origin {
            org: "TX Squad".into(),
            project: "Design System".into(),
            repo: "tokens".into(),
        };
        assert_eq!(
            web_url(&at, 41),
            "https://dev.azure.com/TX%20Squad/Design%20System/_git/tokens/pullrequest/41"
        );
    }

    #[test]
    fn one_pull_keeps_the_description_and_drops_the_rest() {
        /* Trimmed from what api-version 7.1 answers for a single pull request —
           several kilobytes of identity objects and `_links` around the four
           fields anybody wants. The description is the field this reading exists
           for and the reason the list is not enough. */
        let body = json!({
            "pullRequestId": 41,
            "title": "the forge, as a card reaches it",
            "description": "Three tools over the path the wall already has working.",
            "status": "active",
            "isDraft": false,
            "sourceRefName": "refs/heads/feature/azdo-tools",
            "targetRefName": "refs/heads/main",
            "mergeStatus": "succeeded",
            "createdBy": { "displayName": "Lyss Delprat", "id": "b0556cda" },
            "creationDate": "2026-08-27T02:07:24.277Z",
            "reviewers": [
                { "displayName": "Lyss Delprat", "vote": 0, "isRequired": true },
                { "displayName": "TX Squad", "vote": 10, "isRequired": false }
            ],
            "repository": { "id": "969d50af", "name": "tokens", "size": 41231 },
            "supportsIterations": true,
            "artifactId": "vstfs:///Git/PullRequestId/969d50af%2f41"
        });
        let at = crate::azdo::Origin {
            org: "TX Squad".into(),
            project: "Design System".into(),
            repo: "tokens".into(),
        };
        let out = one_pull(&at, &body);
        assert_eq!(out["number"], 41);
        assert_eq!(
            out["description"],
            "Three tools over the path the wall already has working."
        );
        assert_eq!(out["source"], "refs/heads/feature/azdo-tools");
        assert_eq!(out["by"], "Lyss Delprat");
        assert_eq!(out["votes"][1]["vote"], 10);
        assert_eq!(out["votes"][0]["required"], true);
        /* The org/project/repo come off the remote rather than out of the body,
           which is what makes them trustworthy — see the header on why a card
           cannot name a repository. */
        assert_eq!(out["project"], "Design System");
        /* And the several kilobytes that were not asked about are gone. */
        assert!(out.get("artifactId").is_none());
        assert!(out.get("supportsIterations").is_none());
    }

    #[test]
    fn a_pull_request_with_no_description_says_so_rather_than_saying_nothing() {
        /* Absent, not empty: "it has no description" and "I could not read it"
           must not be the same answer to a card that is about to replace it. */
        let at = crate::azdo::Origin {
            org: "o".into(),
            project: "p".into(),
            repo: "r".into(),
        };
        let out = one_pull(&at, &json!({ "pullRequestId": 7, "title": "wip" }));
        assert!(out["description"].is_null());
        assert_eq!(out["number"], 7);
        /* And a missing reviewers array is not an empty vote list invented for
           it. */
        assert!(out["votes"].is_null());
    }
}
