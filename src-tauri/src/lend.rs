//! Lending a card a credential the wall holds, behind the user's own click.
//!
//! One tool, `credential`, for every secret Volery keeps in the tokens panel:
//! the card names which one and says why, the call parks, the user is shown the
//! reason and decides, and on a yes the secret lands **in the card's process
//! environment** from its next spawn onward — never in a tool result, so never
//! in the transcript. `asana_token` is the same path with the credential fixed
//! to `asana`, kept because it is already quoted in transcripts on this machine
//! (CLAUDE.md's argument for never renaming an `mcp__skein__*` tool).
//!
//! It began as `docket::token`, an Asana-only tool, and `.claude/rules/asana.md`
//! still carries the long argument for why a sanctioned door with a person
//! standing in it beats an agent reading Credential Manager itself, why the grant
//! is an environment variable rather than a result, and why it dies with the
//! card. None of that was about Asana, which is why the second credential
//! (Azure DevOps, 2026-10-14) arrived as a table entry rather than a copy.
//!
//! ## What is shared and what is per-credential
//!
//! The machinery is one copy: the question, the two buttons, the grant row
//! (`store::secret_grant`, keyed on the service id it always was), the spawn arm
//! that reads it (`supervisor::spawn_now` walks `LENDABLE`), and the
//! `--secret <id>` line for the turn that asked (`hooks::serve_secret`, which was
//! never Asana-specific). What differs is data, and it is all in one `Lending`:
//! the variable name, the user-facing warning about reach, where to revoke it,
//! how to use it, and which dedicated tools to try first.
//!
//! **`LENDABLE` is keyed by `creds.rs`'s service id rather than living inside
//! `creds::SERVICES`**, and that is a lift constraint rather than a taste: the
//! schema built from this table is asserted by `tools/lift-roster.ts` on a
//! machine that cannot run `cargo test`, and `SERVICES` carries network probes
//! and vault constants that cannot be lifted. `every_lendable_credential_is_one_the_panel_stores`
//! holds the two tables against each other. Adding a credential the panel
//! already stores is one entry here; one it does not store yet needs its panel
//! entry first, which it would need anyway.
//!
//! GitHub is deliberately absent. Volery stores no GitHub token — `github.rs`
//! derives one from `gh auth token` per request — and a card can run `gh` itself
//! with nothing lent, so an entry here would be a question with no secret behind
//! it. Spotify's refresh token is in the vault and absent too: it is the
//! player's, and no card has a use for it that `put_on` does not already cover.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The tool. Takes a `credential` and a `reason`.
pub const CREDENTIAL_TOOL: &str = "credential";
/// The name it had while Asana was the only one. Same path, credential fixed.
pub const ASANA_TOKEN_TOOL: &str = "asana_token";

/// One credential a card may be lent, and everything the two prompts need to
/// say about it.
pub(crate) struct Lending {
    /// `creds.rs`'s service id, and what `secret_grant.service` records.
    pub id: &'static str,
    /// What the user and the card call it.
    pub label: &'static str,
    /// What a granted card finds it under. **The name the service's own
    /// tooling already reads**, so a script reaches for it without being told —
    /// most of the value over a result the agent must thread through by hand.
    pub env: &'static str,
    /// What handing it over actually reaches, for the user deciding. The
    /// sentence a person would otherwise assume the wrong way.
    pub reach: &'static str,
    /// Where the token itself is killed, since closing the card only ends the
    /// grant and not the credential.
    pub revoke: &'static str,
    /// How to call the service with it, for the card. Markdown.
    pub usage: &'static str,
    /// The tools on this server that cover the ordinary cases without lending
    /// anything, which the card is told to try first.
    pub instead: &'static str,
}

pub(crate) const LENDABLE: &[Lending] = &[
    Lending {
        id: "asana",
        label: "Asana personal access token",
        /* Asserted literally in `the_env_names_are_the_ones_tooling_already_reads`:
           a house-style rename here compiles, still exports, and every Asana
           client on the machine stops finding it. */
        env: "ASANA_ACCESS_TOKEN",
        reach: "Asana tokens are **not scoped** — this is the whole account, every workspace, \
                read and write. There is no narrower thing to give it.",
        revoke: "Asana: my settings → apps → manage developer apps",
        usage: "`Authorization: Bearer <token>` against `https://app.asana.com/api/1.0`. curl, \
                Python and Node reach `app.asana.com` on this machine with no certificate \
                workaround — `CURL_CA_BUNDLE`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` are \
                already set (verified 2026-09-04).",
        instead: "`mcp__skein__tasks` and `mcp__skein__task` read boards and tasks and do \
                  the six ordinary writes, each behind its own confirmation. Reach for the \
                  token for attachments, \
                  subtasks, portfolios, goals, webhooks, custom field administration or a bulk \
                  read.",
    },
    Lending {
        id: "azdo",
        label: "Azure DevOps personal access token",
        /* The name the `az devops` extension reads on its own, so `az repos`
           and `az pipelines` pick it up unprompted — though `az` itself fails
           TLS on this network (`azdo.md`), which is why `usage` leads with curl. */
        env: "AZURE_DEVOPS_EXT_PAT",
        reach: "An Azure DevOps PAT carries **whatever scopes and organisations it was created \
                with** — Volery can neither see nor narrow them. If you minted it with full \
                access, that is what the card gets, across every project in those \
                organisations.",
        revoke: "dev.azure.com → user settings → personal access tokens",
        usage: "HTTP Basic with an **empty user name**: `curl -u \":$AZURE_DEVOPS_EXT_PAT\" \
                \"https://dev.azure.com/<org>/<project>/_apis/git/repositories?api-version=7.1\"`. \
                curl and Node reach `dev.azure.com` through this network's TLS interception \
                (`CURL_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` are set; verified 2026-10-14); \
                `az` does **not**, and fails with a certificate error, so do not reach for it.",
        instead: "`mcp__skein__pipelines` reads runs and their failing logs, \
                  `mcp__skein__reviews` reads pull requests and their threads, and \
                  `mcp__skein__pull_request` opens or edits one — none of them \
                  lends anything. Reach for the token for what they do not cover: a pull \
                  request's commits, a repository's history, build timelines, work items, \
                  wikis, a bulk read.",
    },
];

/// The entry for a service id, if it is one a card may be lent.
pub(crate) fn lending(id: &str) -> Option<&'static Lending> {
    LENDABLE.iter().find(|l| l.id == id)
}

/// The ids, as the card would write them: `` `asana`, `azdo` ``.
fn ids() -> String {
    LENDABLE.iter().map(|l| format!("`{}`", l.id)).collect::<Vec<_>>().join(", ")
}

/* ── the schemas ───────────────────────────────────────────────────────────*/

/// The whole of what a card is told before it asks. Built from `LENDABLE`, so
/// a credential added there is described here without anybody remembering to.
pub fn credential_schema() -> Value {
    let each: String = LENDABLE
        .iter()
        .map(|l| {
            format!(
                "\n\n### `{}` — {}, as `{}`\n\n**Try first:** {}\n\n**Using it:** {}",
                l.id, l.label, l.env, l.instead, l.usage
            )
        })
        .collect();
    json!({
        "name": CREDENTIAL_TOOL,
        "description": format!(
            "Ask the user to lend you a credential Volery is holding, so you can call a \
             service's API yourself rather than only through the dedicated tools on this \
             server. The call parks; the user is shown what you said you wanted it for, and \
             decides.\n\n\
             **Prefer the dedicated tools when they suffice** — they need no credential and \
             put nothing anywhere. Reach for this only when what you need is genuinely not \
             there, and **say what, in `reason`**, because that sentence is the whole of what \
             the user decides on.\n\n\
             **The credential is never put in this conversation.** What you get back is a \
             grant: from your next turn onward it is in your process environment under the \
             variable named below, which every Bash, PowerShell and script call you make \
             inherits. Read it at the point of use — `$NAME`, `$env:NAME`, \
             `os.environ[\"NAME\"]` — and **never print it, echo it, log it, commit it, write \
             it into a file, or repeat it to another card**. A transcript is on disk for ever \
             and nothing can take it back out.\n\n\
             The turn you ask on is the exception, and the answer hands you a one-line command \
             for it: an environment is fixed when a process starts, and yours started before \
             the user agreed.\n\n\
             A grant lasts until this card is **closed or cleared**, so you do not need to ask \
             again on a later turn — **check whether the variable is already set before \
             calling this.** If the user says no, that is an answer: do not ask again for the \
             same job — say what you could not do, and get on with the rest.\n\n\
             If Volery holds no such credential you are told so, with the ones it does hold.\n\n\
             ## The credentials{each}"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "credential": {
                    "type": "string",
                    "enum": LENDABLE.iter().map(|l| l.id).collect::<Vec<_>>(),
                    "description": format!("Which one: {}.", ids())
                },
                "reason": reason_schema()
            },
            "required": ["credential", "reason"]
        }
    })
}

/// `asana_token`: the same path with the credential fixed. Short on purpose —
/// everything worth saying is said once, in `credential`'s description.
pub fn asana_alias_schema() -> Value {
    json!({
        "name": ASANA_TOKEN_TOOL,
        "description":
            "The same as `credential` with `credential: \"asana\"` — ask the user to lend you \
             the Asana personal access token, delivered as `ASANA_ACCESS_TOKEN` in your \
             environment from your next turn, never in this conversation. Prefer `tasks` and \
             `task` when they suffice. See `credential` for the rest, and prefer calling it.",
        "inputSchema": {
            "type": "object",
            "properties": { "reason": reason_schema() },
            "required": ["reason"]
        }
    })
}

fn reason_schema() -> Value {
    json!({
        "type": "string",
        "description":
            "What you need it for, in one or two plain sentences, written for the user rather \
             than for a log. Name the endpoint or the operation and what you are trying to \
             achieve — \"to list the commits on PR 412, which `reviews` does not show\" is a \
             decision somebody can take; \"to work with Azure DevOps\" is not, and will be \
             refused. This is shown to them verbatim."
    })
}

/* ── the decisions, pure ───────────────────────────────────────────────────*/

/// The exact words a click sends. Their own, not `docket::DO_IT`'s: handing
/// over a credential and making a write are not the same act, and a button
/// reading *do it* under a credential question is the one place a habit built
/// on six confirmations could carry somebody through the seventh.
pub(crate) const HAND_IT_OVER: &str = "hand it over";
pub(crate) const KEEP_IT: &str = "keep it";

/// How long a reason may run in the question before it is clipped.
const MAX_REASON: usize = 600;

/// Which credential a call names, or why it cannot be lent.
///
/// `held` is the ids the vault has an entry for right now — passed in so this
/// stays pure. The refusal names them, because "no such credential" alone
/// leaves the card guessing what to ask for instead.
pub(crate) fn resolve(asked: &str, held: &[&str]) -> Result<&'static Lending, String> {
    let asked = asked.trim();
    let have = if held.is_empty() {
        "Volery holds none at the moment — the tokens panel in the header is where one is \
         entered."
            .to_string()
    } else {
        format!(
            "Volery holds: {}.",
            held.iter().map(|h| format!("`{h}`")).collect::<Vec<_>>().join(", ")
        )
    };
    let Some(l) = lending(asked) else {
        return Err(format!(
            "there is no credential called {asked:?} that can be lent. The ones a card may ask \
             for are {}. {have} The user has not been asked.",
            ids()
        ));
    };
    if !held.contains(&l.id) {
        return Err(format!(
            "Volery holds no {} — nothing has been entered in the tokens panel for `{}`. {have} \
             The user has not been asked.",
            l.label, l.id
        ));
    }
    Ok(l)
}

/// The reason, or the refusal a call with none gets — before anybody is asked
/// and ahead of the network, so a malformed call costs nothing.
pub(crate) fn reason_of(args: &Value) -> Result<String, String> {
    args.get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            "say what you need it for in `reason` — it is shown to the user verbatim and is the \
             whole of what they have to decide on. Name the endpoint or the operation and what \
             you are trying to achieve."
                .to_string()
        })
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

/// What the user is asked. `who` is what the service said the token is when
/// it was checked just now — an identity for Asana, an organisation it reads
/// for Azure DevOps — or empty where it would not say.
/// The same question, as a person at another wall decides it (`ask::Confirm`).
///
/// **Names and reach, never the secret** — the credential stays on the machine
/// that holds it whatever is decided, and what crosses is only what `question`
/// already shows: which credential, whose account it checked as, what it can
/// reach, where it lands and for how long. Approving from the other laptop lends
/// it *there*, to that card, in that machine's environment; nothing about the
/// token moves (Lyss: *"we're not sending tokens across the wire"*).
fn evidence(l: &Lending, reason: &str, who: &str) -> crate::ask::Confirm {
    crate::ask::Confirm::new(format!("lend your {} to this card", l.label.to_lowercase()))
        .fact("credential", l.label)
        .fact("checked just now", if who.is_empty() { "live" } else { who })
        .fact("what it reaches", l.reach)
        .fact(
            "where it goes",
            format!(
                "`{}` in the card's environment on that machine — written to no file and in no \
                 transcript",
                l.env
            ),
        )
        .fact("how long", "until the card is closed or cleared; a cleared card has to ask again")
        .fact("to kill the token itself", l.revoke)
        .why(Some(&clip(reason, MAX_REASON)))
        .stakes("Every request the card makes with it acts under your name.")
}

pub(crate) fn question(l: &Lending, reason: &str, who: &str) -> Value {
    let checked = if who.is_empty() {
        "It was checked just now and is live.".to_string()
    } else {
        format!("It was checked just now: **{who}**.")
    };
    json!({
        "questions": [{
            "header": format!("lend the {}", l.label.to_lowercase()),
            "question": format!(
                "A card is asking for **your {}**, to call the API directly.\n\n\
                 **It says it needs it for:**\n\n---\n\n{}\n\n---\n\n{checked} {}\n\n\
                 **It goes into the card's environment, not into the conversation** — as \
                 `{}`, where its shell and script calls will find it. It is written to no file \
                 and appears in no transcript, so what you are agreeing to is this card being \
                 able to *use* the credential, rather than a copy of it existing somewhere \
                 new.\n\n\
                 **It lasts until you close or clear this card.** There is no expiry and no \
                 separate way to take it back — closing the card is how, and a card you clear \
                 has to ask again. If you want the token itself dead, that is the service's \
                 side: {}.\n\n\
                 If you would rather it did not have this, say no — the card will be told to \
                 carry on without it.",
                l.label,
                clip(reason, MAX_REASON),
                l.reach,
                l.env,
                l.revoke,
            ),
            "options": [
                {
                    "label": HAND_IT_OVER,
                    "detail": "The card gets it in its environment. Never in the transcript."
                },
                {
                    "label": KEEP_IT,
                    "detail": "Nothing is lent. The agent is told you said so."
                }
            ]
        }]
    })
}

/// What the card is told when nobody answered.
pub(crate) fn unanswered(l: &Lending) -> String {
    format!(
        "nobody answered, so nothing was lent — you do not have the {}. Either the question \
         stood until it expired or the card was dismissed while it was up. Carry on with your \
         own judgement, say that you asked, and do not simply ask again.",
        l.label
    )
}

/// And when they said no, or said something else.
pub(crate) fn declined(l: &Lending, answer: &str) -> String {
    let said = answer.trim();
    if said.eq_ignore_ascii_case(KEEP_IT) {
        return format!(
            "the user was asked and said no, so you do not have the {}. That is an answer \
             rather than this tool refusing you — do not ask again for the same job, and say in \
             your reply what you could not do.",
            l.label
        );
    }
    format!(
        "the user was asked and pressed neither button. They said: {said:?}. Nothing was lent. \
         Act on what they actually said."
    )
}

/// The command that fetches it for the turn that asked. Built here rather than
/// described, so the card has something to run rather than a shape to
/// assemble — and quoted, since both paths can hold spaces.
pub(crate) fn turn_command(l: &Lending, exe: &str, card: &str, db: &str) -> String {
    format!(
        "export {}=$(\"{exe}\" {} {} {} {card} {} \"{db}\")",
        l.env,
        crate::hooks::FLAG_SECRET,
        l.id,
        crate::hooks::FLAG_CARD,
        crate::hooks::FLAG_DB,
    )
}

/// What a granted card is told. `now` is the command for this turn, or `None`
/// where there was no path to name one with.
pub(crate) fn granted(l: &Lending, reason: &str, now: Option<&str>) -> String {
    let now = match now {
        Some(cmd) => format!(
            "\n\nFor **this turn only**, your process was started before the grant existed, so \
             its environment does not have it yet. Fetch it once and it is in your shell for \
             the rest of the turn:\n\n```bash\n{cmd}\n```\n\n\
             That command prints nothing at all unless this card is granted, so it is safe to \
             leave in a script — but do not echo what it returns."
        ),
        /* No path to name is not a failure of the grant — the variable still
           lands at the next spawn. Say what is true and no more, rather than
           printing a command with a hole in it. */
        None => "\n\nYour current process was started before the grant existed, so its \
                 environment does not have it yet; it will from your next turn."
            .to_string(),
    };
    let env = l.env;
    format!(
        "The user agreed, and the grant is recorded against this card.\n\n\
         **The {label} is not in this reply, and must not be put in one.** From your next turn \
         onward it is in your environment as `{env}` — every Bash, PowerShell and script call \
         you make inherits it, so read it with `$env:{env}`, `${env}` or \
         `os.environ[\"{env}\"]` at the point of use and never print it.{now}\n\n\
         Using it: {usage}\n\n\
         The grant lasts until this card is closed or cleared. Every request you make with it \
         acts under the user's name — stay inside what you said you needed it for: {why}",
        label = l.label,
        usage = l.usage,
        why = clip(reason, 200),
    )
}

/* ── the wiring ────────────────────────────────────────────────────────────*/

/// Every tool here, as the one entry point `ask.rs` calls — `docket::writes`'
/// contract, and its `Writing` shape, so the dispatch has one arm for both.
pub(crate) fn writes(
    app: &AppHandle,
    caller: &str,
    tool: &str,
    args: &Value,
) -> Option<crate::docket::Writing> {
    let asked = match tool {
        CREDENTIAL_TOOL => args.get("credential").and_then(Value::as_str).unwrap_or(""),
        ASANA_TOKEN_TOOL => "asana",
        _ => return None,
    };
    Some(lend(app, caller, asked, args))
}

fn lend(app: &AppHandle, caller: &str, asked: &str, args: &Value) -> crate::docket::Writing {
    use crate::docket::Writing;
    let me = match whoever(app, caller) {
        Ok(me) => me,
        Err(why) => return Writing::Now(why),
    };
    let reason = match reason_of(args) {
        Ok(r) => r,
        Err(why) => return Writing::Now(why),
    };
    let held: Vec<&str> =
        LENDABLE.iter().map(|l| l.id).filter(|id| crate::creds::held(id)).collect();
    let l = match resolve(asked, &held) {
        Ok(l) => l,
        Err(why) => return Writing::Now(why),
    };
    /* Checked before the question rather than after: the user deciding whether
       to lend a credential wants to know **what** it is — whose Asana account,
       which Azure DevOps organisation it reads — and a token already dead is a
       refusal rather than a question. The card's own directory leads, so the
       organisation named is the one it is working in. */
    let mut roots = vec![me.cwd.clone()];
    if let Some(store) = app.try_state::<crate::store::Store>() {
        if let Ok(conn) = store.0.lock() {
            roots.extend(
                crate::store::projects(&conn)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.root_path),
            );
        }
    }
    let who = match crate::creds::check(l.id, &roots) {
        Ok(w) => w,
        Err(why) => {
            return Writing::Now(format!(
                "the stored {} did not check out: {why}\n\nSo there is nothing worth lending — \
                 the user has not been asked. The tokens panel in the header is where this is \
                 fixed.",
                l.label
            ))
        }
    };

    let card = caller.to_string();
    Writing::Ask {
        question: question(l, &reason, &who),
        settle: crate::ask::Settle::new(evidence(l, &reason, &who), move |app, answer| {
            let Some(answer) = answer else {
                return unanswered(l);
            };
            if !crate::docket::approved(answer, HAND_IT_OVER) {
                return declined(l, answer);
            }
            /* The grant, and **not the secret**. Nothing this returns carries
               it: a tool result is written to the transcript on disk for good,
               where an environment variable is in no file at all. */
            let Some(store) = app.try_state::<crate::store::Store>() else {
                return "the user agreed, but the wall's store is unavailable, so the grant \
                        could not be recorded and nothing was lent."
                    .to_string();
            };
            let wrote = store
                .0
                .lock()
                .map_err(|_| "the store is unavailable".to_string())
                .and_then(|conn| crate::store::grant_secret(&conn, &card, l.id, &reason));
            if let Err(why) = wrote {
                return format!(
                    "the user agreed, but the grant could not be recorded ({why}), so nothing \
                     was lent. Say so rather than trying again."
                );
            }
            let now = match (std::env::current_exe(), crate::store::db_path(app)) {
                (Ok(exe), Some(db)) => Some(turn_command(
                    l,
                    &exe.display().to_string(),
                    &card,
                    &db.display().to_string(),
                )),
                _ => None,
            };
            granted(l, &reason, now.as_deref())
        }),
    }
}

/// The caller, if it is a card that may be lent anything at all.
///
/// A chat card is refused here and again at `spawn_now`, which will not put a
/// lent variable in its environment either: that card kind's whole claim is
/// that it reaches nothing on this machine, and a capability resting on one
/// check is one edit from being ungated.
fn whoever(app: &AppHandle, caller: &str) -> Result<crate::store::RosterRow, String> {
    let store = app
        .try_state::<crate::store::Store>()
        .ok_or_else(|| "the store is unavailable".to_string())?;
    let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
    let me = crate::store::roster_one(&conn, caller)
        .ok_or_else(|| "this conversation is not on the wall.".to_string())?;
    if me.kind == "chat" {
        return Err("this is a chat card: it reaches nothing on this machine and holds no \
                    credential, so nothing can be lent to it. Ask on a project card."
            .into());
    }
    Ok(me)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_credential_is_found_by_its_own_id_and_no_other() {
        for l in LENDABLE {
            assert_eq!(lending(l.id).map(|x| x.env), Some(l.env));
        }
        assert!(lending("github").is_none(), "volery stores no github token to lend");
        assert!(lending("").is_none());
    }

    #[test]
    fn no_two_credentials_share_an_id_or_a_variable() {
        /* Two entries on one variable is a card granted one secret finding the
           other under its name — and the spawn arm would set it twice, the
           second silently winning. */
        for (i, a) in LENDABLE.iter().enumerate() {
            for b in LENDABLE.iter().skip(i + 1) {
                assert_ne!(a.id, b.id);
                assert_ne!(a.env, b.env, "{} and {} share a variable", a.id, b.id);
            }
        }
    }

    #[test]
    fn the_env_names_are_the_ones_tooling_already_reads() {
        /* A house-style rename compiles, still exports, and every client on the
           machine stops finding it. These are the names Asana's own tooling and
           the `az devops` extension read. */
        assert_eq!(lending("asana").unwrap().env, "ASANA_ACCESS_TOKEN");
        assert_eq!(lending("azdo").unwrap().env, "AZURE_DEVOPS_EXT_PAT");
    }

    #[test]
    fn an_unknown_credential_is_refused_naming_what_is_held() {
        let err = resolve("bitbucket", &["azdo"]).err().unwrap();
        assert!(err.contains("bitbucket"), "{err}");
        assert!(err.contains("`azdo`"), "the refusal does not say what is held: {err}");
        assert!(err.contains("has not been asked"), "{err}");
    }

    #[test]
    fn a_credential_volery_does_not_hold_is_refused_before_anybody_is_asked() {
        let err = resolve("azdo", &["asana"]).err().unwrap();
        assert!(err.contains("Azure DevOps"), "{err}");
        assert!(err.contains("`asana`"), "the refusal does not say what is held: {err}");
        let none = resolve("asana", &[]).err().unwrap();
        assert!(none.contains("tokens panel"), "{none}");
        assert_eq!(resolve(" azdo ", &["azdo"]).unwrap().id, "azdo");
    }

    #[test]
    fn asking_without_a_reason_is_refused_before_anybody_is_asked() {
        assert!(reason_of(&json!({})).is_err());
        assert!(reason_of(&json!({ "reason": "   " })).is_err());
        assert!(reason_of(&json!({ "reason": 4 })).is_err());
        assert_eq!(reason_of(&json!({ "reason": " commits on !12 " })).unwrap(), "commits on !12");
    }

    #[test]
    fn the_credential_takes_its_own_word_and_not_the_writes_one() {
        /* `approved` takes the label it matches, so a write's yes and a lend's
           yes are different strings by convention only — passing the wrong
           constant compiles perfectly. */
        assert!(crate::docket::approved(HAND_IT_OVER, HAND_IT_OVER));
        assert!(!crate::docket::approved(crate::docket::DO_IT, HAND_IT_OVER));
        assert!(!crate::docket::approved(HAND_IT_OVER, crate::docket::DO_IT));
        assert!(!crate::docket::approved(KEEP_IT, HAND_IT_OVER));
        assert!(!crate::docket::approved("yes, hand it over", HAND_IT_OVER));
    }

    #[test]
    fn the_question_names_the_credential_its_reach_and_both_buttons() {
        for l in LENDABLE {
            let q = question(l, "to read the commits on !12", "reads builds in LagardereAWPL");
            let text = q["questions"][0]["question"].as_str().unwrap();
            for must in [l.label, l.reach, l.env, l.revoke, "to read the commits on !12"] {
                assert!(text.contains(must), "{}: the question lost {must:?}", l.id);
            }
            let labels: Vec<&str> = q["questions"][0]["options"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| o["label"].as_str().unwrap())
                .collect();
            assert_eq!(labels, [HAND_IT_OVER, KEEP_IT]);
            /* The first cut's button said the token went in the transcript for
               good, which stopped being true with the environment redesign and
               then sat there telling the user the opposite of what happens. */
            let detail = q["questions"][0]["options"][0]["detail"].as_str().unwrap();
            assert!(!detail.contains("goes in the transcript"), "{detail}");
        }
    }

    #[test]
    fn a_refusal_is_an_answer_and_says_so() {
        let l = lending("azdo").unwrap();
        assert!(declined(l, KEEP_IT).contains("said no"));
        assert!(declined(l, "only for the build timeline").contains("only for the build timeline"));
        assert!(unanswered(l).contains("nothing was lent"));
    }

    #[test]
    fn a_grant_puts_the_variable_in_the_command_and_never_a_secret() {
        let l = lending("azdo").unwrap();
        let cmd = turn_command(l, "C:/Program Files/Volery/volery.exe", "abc123", "C:/db/skein.db");
        assert!(cmd.starts_with("export AZURE_DEVOPS_EXT_PAT=$("), "{cmd}");
        for part in [crate::hooks::FLAG_SECRET, " azdo ", crate::hooks::FLAG_CARD, "abc123"] {
            assert!(cmd.contains(part), "{cmd} lacks {part:?}");
        }
        assert!(cmd.contains("\"C:/Program Files/Volery/volery.exe\""), "unquoted path: {cmd}");
        let said = granted(l, "commits", Some(&cmd));
        assert!(said.contains(&cmd));
        assert!(said.contains("AZURE_DEVOPS_EXT_PAT"));
        assert!(said.contains("never print it"));
        let later = granted(l, "commits", None);
        assert!(later.contains("from your next turn"), "{later}");
    }

    #[test]
    fn the_schema_names_every_credential_and_says_what_it_cannot_take_back() {
        let s = credential_schema();
        let text = s["description"].as_str().unwrap();
        for l in LENDABLE {
            for must in [l.id, l.env, l.label] {
                assert!(text.contains(must), "the schema does not mention {must:?}");
            }
        }
        for claim in ["never print it", "closed or cleared", "never put in this conversation",
                      "already set before"] {
            assert!(text.contains(claim), "the schema stopped saying {claim:?}");
        }
        let ids: Vec<&str> = s["inputSchema"]["properties"]["credential"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(ids, LENDABLE.iter().map(|l| l.id).collect::<Vec<_>>());
        let req = s["inputSchema"]["required"].as_array().unwrap();
        assert!(req.contains(&json!("credential")) && req.contains(&json!("reason")));
    }

    #[test]
    fn the_asana_alias_is_the_same_path_with_the_credential_fixed() {
        let a = asana_alias_schema();
        assert_eq!(a["name"], ASANA_TOKEN_TOOL);
        assert_eq!(a["inputSchema"]["required"], json!(["reason"]));
        assert!(a["description"].as_str().unwrap().contains("ASANA_ACCESS_TOKEN"));
        assert_ne!(CREDENTIAL_TOOL, ASANA_TOKEN_TOOL);
    }
}
