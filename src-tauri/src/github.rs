//! GitHub, as far as a wall needs to know about it.
//!
//! The same two questions `azdo.rs` answers, against a service that answers them
//! differently enough to be worth its own file and similarly enough to fill the
//! same rows. Everything it builds is `forge.rs`'s, and every judgement about
//! what it means is `azdo.ts`'s.
//!
//! Four things carry the module, and three of them are the reverse of the Azure
//! DevOps ones.
//!
//! - **The credential is already on the machine, and it is `gh`'s.** This was
//!   the real design question and it is worth the paragraph. Azure DevOps needed
//!   a four-rung ladder because none of its credentials is reliably enough:
//!   Git Credential Manager holds one that is code-scoped and 401s on builds, so
//!   a PAT had to be minted, entered and stored, and `vault.rs` and
//!   `Keyring.svelte` exist because of it. GitHub needs none of that, because
//!   `gh` is already installed and already signed in on any machine somebody
//!   works on GitHub from — probed 2026-08-27 on this one: `gh auth status`
//!   reports scopes `gist, read:org, repo, workflow`, and `repo` and `workflow`
//!   are exactly and only what Actions runs and pull requests need.
//!
//!   So `gh auth token` is the rung, and the thing to notice is **what it is
//!   not**. It is not a second wire format: `gh` is asked for a *credential*,
//!   once, and every request after that is the same `ureq` call through the same
//!   proxy-aware agent as Azure DevOps. Shelling out to `gh api` per request
//!   would have been the expensive answer — a process spawn per poll, a second
//!   JSON envelope to parse, and `gh`'s own error vocabulary layered over
//!   GitHub's. Asking it for the secret and then getting out of its way costs
//!   one spawn per hour and leaves one HTTP path in the app.
//!
//!   And it is not a second thing to manage. A PAT in the vault would mean a
//!   second `Keyring`, a second secret to rotate and a second way to be
//!   mysteriously unauthorised — for a credential the machine already has. The
//!   test `azdo.md` states for whether a setting deserves a field is whether the
//!   app could have worked it out: an org is derivable and is read off the wall,
//!   a PAT is not and is asked for. A GitHub token *is* derivable here, so it is
//!   not asked for. `GITHUB_TOKEN`/`GH_TOKEN` are read first for the case `gh`
//!   itself honours them — CI, a devcontainer, somebody who deliberately
//!   exported one — and there is no third rung.
//!
//! - **Everything is per repository, and there is no org-wide call worth
//!   making.** The exact reverse of Azure DevOps, where pull requests come back
//!   for a whole organisation in one request and builds cost one per project.
//!   Here both cost one per repository, which is *cheaper* in practice because
//!   the number of repositories is the number of GitHub projects on your wall —
//!   usually one or two, against six Azure DevOps projects for one clone.
//!
//! - **Pull requests are asked for in GraphQL, and that is not gold-plating.**
//!   The REST list endpoint (`GET /repos/{o}/{r}/pulls`) does not carry
//!   `mergeable_state` — GitHub computes the merge in the background and only
//!   reports it on the single-PR endpoint — and it does not carry approvals
//!   either, only `requested_reviewers`, which is who has *not* answered.
//!   Probed 2026-08-27 against `cli/cli`: a REST row can say a PR is open and a
//!   draft, and cannot say whether it conflicts, whether it is approved, or
//!   whether anybody asked for changes. Three of the six things `reviewSaid`
//!   exists to say.
//!
//!   One GraphQL query answers all of it at the same cost — one request per
//!   repository — and folds the caller's own identity in for free
//!   (`viewer { login }`), which on the Azure DevOps side is a second request
//!   against `connectionData`. So the more capable shape is also the cheaper
//!   one, and the only price is a POST with a body in a module otherwise built
//!   on GETs.
//!
//! - **A rate limit is a fault worth naming.** 5000 requests an hour on the REST
//!   core budget, and the widget polls runs every twenty seconds. One repository
//!   is 180 an hour and nothing to think about; ten repositories on a wall left
//!   up all day is 1800, still fine, and a wall with thirty would not be. A 403
//!   carrying `x-ratelimit-remaining: 0` is therefore told apart from a 403
//!   meaning "not your repository", because the first one says *wait* and the
//!   second says *you cannot* and a widget that confuses them sends you looking
//!   for a permission problem you do not have.

use crate::forge::{
    agent, epoch_ms, encode, output, quiet, remote_of, stamp, text, Detail, Forge, Review, Run,
    Stage, Step, Vote,
};
use std::collections::HashMap;
use std::process::Command;
use std::time::{Duration, Instant};

/// How long a repository read off a git remote is trusted. The same five
/// minutes `azdo.rs` gives an organisation, for the same reason: a remote does
/// change, and spawning a `git` per root per poll to find out would make the
/// cheap half of this the expensive half.
const REPOS_FOR: Duration = Duration::from_secs(5 * 60);

/// How long the `gh` token is held.
///
/// `gh` refreshes its own — the token it hands back is whatever is in its
/// keyring at the time — so this is not an expiry, it is how often we go and ask
/// again in case you signed in as somebody else. An hour, and the cost of being
/// wrong is one refusal that the next poll fixes.
const TOKEN_FOR: Duration = Duration::from_secs(60 * 60);

/// How long the caller's own login is trusted. Same hour, same reasoning as
/// `azdo.rs`'s `ME_FOR`: it does not change, and this exists so a token swapped
/// underneath us is noticed eventually rather than never.
const ME_FOR: Duration = Duration::from_secs(60 * 60);

/// Workflow runs asked for per repository. Deep enough that a repo mid-release
/// shows the run and the ones around it, shallow enough to be one small page.
const RUNS_PER_REPO: usize = 25;

/// Open pull requests asked for per repository. Above any number a wall would
/// draw, and GraphQL will not page past 100 in one go anyway.
const PRS_PER_REPO: usize = 50;

#[derive(Default)]
pub struct Cache {
    /// Project root → the repository its origin points at. `None` is a real
    /// answer and is cached: a repo that is not on GitHub must not be re-probed
    /// on every poll.
    repos: HashMap<String, (Option<Repo>, Instant)>,
    /// The credential, and when it was last asked for. `None` is cached too —
    /// a machine with no `gh` on it must not spawn a failing process every
    /// twenty seconds.
    token: Option<(Option<String>, Instant)>,
    /// The caller's own login.
    me: Option<(String, Instant)>,
}

/// A repository, compared the way GitHub compares one.
///
/// `PartialEq` is written out rather than derived because GitHub is
/// case-insensitive about both halves, and a wall with one card cloned
/// `ShaitanLyss/volery` and another cloned `shaitanlyss/Volery` must ask about
/// it once rather than twice. `Hash` is deliberately *not* derived alongside it:
/// a derived hash would disagree with this equality, which is a contract
/// violation, and nothing here uses a `Repo` as a key.
///
/// `Debug` is here for `assert_eq!`, which needs it on both sides — the tests
/// below compare two `Option<Repo>` to pin the case-folding down.
#[derive(Clone, Debug)]
pub struct Repo {
    owner: String,
    name: String,
}

impl PartialEq for Repo {
    fn eq(&self, other: &Self) -> bool {
        self.owner.eq_ignore_ascii_case(&other.owner) && self.name.eq_ignore_ascii_case(&other.name)
    }
}
impl Eq for Repo {}

impl Repo {
    fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/* ── the credential ────────────────────────────────────────────────────────*/

/// Every name `gh` goes by on this platform.
///
/// The lesson `azdo.rs` paid ten days for, applied before it could be paid
/// again: `Command::new("gh")` resolves a bare program name by appending `.exe`
/// and does **not** consult `PATHEXT`, so a tool installed as a `.cmd` shim is
/// invisible to it. The Azure CLI is exactly that and the ladder was silently
/// one rung short for a week and a half. `gh` ships a real `gh.exe` on this
/// machine (`C:\Users\…\bin\gh.exe`, verified 2026-08-27) so the bare name is
/// expected to win — which is why it is tried first — but a scoop or winget
/// shim is a `.cmd`, and costing one failed spawn to be right about somebody
/// else's install is the trade `az_names` already made.
fn gh_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["gh", "gh.exe", "gh.cmd", "gh.bat"]
    } else {
        &["gh"]
    }
}

/// The token, from the environment or from `gh`.
///
/// The environment first, deliberately — and this is the opposite order to
/// `azdo.rs`, where `VOLERY_AZDO_PAT` is *last*. The reasoning there is that its
/// ladder falls through on refusal, so a rung above the variable is by
/// definition one that works, and letting a stale shell profile outrank a
/// sign-in somebody just did would be the only thing the order could achieve.
/// There is no ladder here — one credential, taken or not — so the order is not
/// choosing between two working things, it is choosing what "signed in" means.
/// `gh` itself reads `GH_TOKEN` ahead of its keyring, so reading it first is
/// agreeing with the tool rather than overruling it.
fn token_now() -> Option<String> {
    for key in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    for name in gh_names() {
        if let Some(out) = output(Command::new(name).args(["auth", "token"])) {
            let t = out.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn token(cache: &mut Cache) -> Option<String> {
    let now = Instant::now();
    if let Some((held, at)) = &cache.token {
        if now.duration_since(*at) < TOKEN_FOR {
            return held.clone();
        }
    }
    let found = token_now();
    cache.token = Some((found.clone(), now));
    found
}

/* ── what the wall is standing on ──────────────────────────────────────────*/

/// The `owner/name` a remote points at, or None if it is not GitHub at all.
///
/// Every shape a clone url comes in — https, ssh, `git@`, with and without the
/// `.git` suffix. Deliberately strict about the host: `github.example.com` is
/// GitHub Enterprise on somebody's own domain, which this does **not** claim to
/// support, and quietly pointing api.github.com at an Enterprise repository's
/// owner is a request that either 404s or, worse, answers about a different
/// repository that happens to share the name.
fn repo_of(remote: &str) -> Option<Repo> {
    let s = remote.trim();
    let s = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let s = s.rsplit_once('@').map(|(_, r)| r).unwrap_or(s);
    /* `git@github.com:owner/repo.git` puts a colon where a slash goes. */
    let s = s.replacen(':', "/", 1);
    let (host, rest) = s.split_once('/')?;
    let host = host.split_once(':').map(|(h, _)| h).unwrap_or(host);
    if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com") {
        return None;
    }
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let owner = parts.next()?.to_string();
    let name = parts.next()?.trim_end_matches(".git").to_string();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(Repo { owner, name })
}

/// Every distinct GitHub repository the wall is standing on, in the wall's own
/// order and deduplicated — so six cards on one repo ask about it once.
fn repos_for(cache: &mut Cache, roots: &[String]) -> Vec<Repo> {
    let now = Instant::now();
    let mut out: Vec<Repo> = Vec::new();
    for root in roots {
        let known = cache
            .repos
            .get(root)
            .filter(|(_, at)| now.duration_since(*at) < REPOS_FOR)
            .map(|(r, _)| r.clone());
        let repo = match known {
            Some(r) => r,
            None => {
                let found = remote_of(root).as_deref().and_then(repo_of);
                cache.repos.insert(root.clone(), (found.clone(), now));
                found
            }
        };
        if let Some(repo) = repo {
            if !out.iter().any(|r| r == &repo) {
                out.push(repo);
            }
        }
    }
    out
}

/* ── asking ────────────────────────────────────────────────────────────────*/

/// Why a request came back with no answer. The same two-way split `azdo.rs`
/// draws, and for the same reason: a repository you cannot see is the shape of
/// somebody's account rather than a fault, and a widget permanently red about it
/// is a widget you stop reading.
pub enum Denied {
    Said(String),
    /// The credential cannot see this repository. Not a fault.
    Unseen,
}

impl From<Denied> for String {
    fn from(d: Denied) -> String {
        match d {
            Denied::Said(s) => s,
            Denied::Unseen => "not visible to this credential".into(),
        }
    }
}

/// Whether a 403 is the rate limiter rather than a permission.
///
/// Told apart because they mean opposite things to a person: the limiter says
/// *wait*, a permission says *you cannot*, and a widget that reports the second
/// when it meant the first sends you hunting a problem you do not have. GitHub
/// signals it in the headers rather than the body — `x-ratelimit-remaining: 0`,
/// with `x-ratelimit-reset` a unix second — and also uses 403 for secondary
/// limits, which carry `retry-after` instead.
fn limited(res: &ureq::Response) -> Option<String> {
    let out_of = res
        .header("x-ratelimit-remaining")
        .and_then(|v| v.trim().parse::<i64>().ok())
        .is_some_and(|n| n <= 0);
    let backoff = res.header("retry-after").is_some();
    if !out_of && !backoff {
        return None;
    }
    let mins = res
        .header("x-ratelimit-reset")
        .and_then(|v| v.trim().parse::<i64>().ok())
        .map(|reset| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            ((reset - now) / 60).max(0)
        });
    Some(match mins {
        Some(m) if m > 0 => format!("github is rate limiting — {m}m to go"),
        _ => "github is rate limiting".to_string(),
    })
}

/// One request, signed with whichever token we have.
///
/// There is no rotation and no remembered rung, because there is no ladder —
/// which is the whole of what `gh` buys. A refusal here is one credential being
/// refused and is said plainly.
fn ask(
    cache: &mut Cache,
    method: &str,
    url: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, Denied> {
    let Some(secret) = token(cache) else {
        return Err(Denied::Said(
            "no github credential on this machine — run `gh auth login`".into(),
        ));
    };
    let agent = agent();
    let req = agent
        .request(method, url)
        .set("Authorization", &format!("Bearer {secret}"))
        .set("Accept", "application/vnd.github+json")
        /* Pinning the version is GitHub's own advice and is cheap insurance: the
           shapes read here are stable, and a future default that renames one
           would otherwise arrive as a field silently going empty. */
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("User-Agent", "volery");

    let sent = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };

    match sent {
        Ok(res) => res
            .into_json::<serde_json::Value>()
            .map_err(|e| Denied::Said(format!("unreadable answer from github: {e}"))),
        /* 404 is what GitHub answers for a private repository the credential
           cannot see — it will not admit one exists — so it is the same silence
           `azdo.rs` counts rather than faults. 403 is a permission unless the
           headers say it is the limiter. */
        Err(ureq::Error::Status(404, _)) => Err(Denied::Unseen),
        Err(ureq::Error::Status(403, res)) => Err(match limited(&res) {
            Some(said) => Denied::Said(said),
            None => Denied::Unseen,
        }),
        Err(ureq::Error::Status(401, _)) => Err(Denied::Said(
            "the github credential was refused (401) — try `gh auth login`".into(),
        )),
        Err(ureq::Error::Status(code, res)) => {
            let body = res.into_string().unwrap_or_default();
            Err(Denied::Said(format!(
                "github answered {code}: {}",
                first_line(&body)
            )))
        }
        Err(e) => Err(Denied::Said(format!("could not reach github: {e}"))),
    }
}

fn first_line(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.chars().take(200).collect();
        }
    }
    body.trim().lines().next().unwrap_or("").chars().take(200).collect()
}

/// GraphQL, which answers 200 and puts the failure in the body.
///
/// That is the one genuinely awkward thing about the second wire shape and it
/// has to be handled here rather than in `ask`: a query naming a field that does
/// not exist comes back as a perfectly successful HTTP response carrying an
/// `errors` array, so treating a 200 as an answer would return an empty list and
/// call it a quiet morning.
fn graphql(
    cache: &mut Cache,
    query: &str,
    vars: serde_json::Value,
) -> Result<serde_json::Value, Denied> {
    let v = ask(
        cache,
        "POST",
        "https://api.github.com/graphql",
        Some(serde_json::json!({ "query": query, "variables": vars })),
    )?;
    if let Some(errs) = v.get("errors").and_then(|e| e.as_array()) {
        if !errs.is_empty() {
            /* A repository the credential cannot see arrives here as a
               `NOT_FOUND` type rather than as an HTTP 404 — same fact, different
               envelope — so it is folded back into the same silence. */
            let all_missing = errs.iter().all(|e| {
                e.get("type").and_then(|t| t.as_str()) == Some("NOT_FOUND")
            });
            if all_missing {
                return Err(Denied::Unseen);
            }
            let said = errs
                .first()
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("github rejected the query");
            return Err(Denied::Said(format!(
                "github answered: {}",
                said.chars().take(200).collect::<String>()
            )));
        }
    }
    v.get("data")
        .cloned()
        .ok_or_else(|| Denied::Said("github answered with no data".into()))
}

/// The caller's own login, for marking a row as theirs.
///
/// One request, cached for an hour. The reviews reading gets the same fact free
/// out of its own query (`viewer { login }`) and writes it back here, so on a
/// wall with both widgets up this endpoint is usually never called at all.
fn me(cache: &mut Cache) -> String {
    let now = Instant::now();
    if let Some((login, at)) = &cache.me {
        if now.duration_since(*at) < ME_FOR {
            return login.clone();
        }
    }
    let login = ask(cache, "GET", "https://api.github.com/user", None)
        .ok()
        .map(|v| text(&v, "login"))
        .unwrap_or_default();
    cache.me = Some((login.clone(), now));
    login
}

fn remember_me(cache: &mut Cache, login: &str) {
    if !login.is_empty() {
        cache.me = Some((login.to_string(), Instant::now()));
    }
}

/* ── runs ──────────────────────────────────────────────────────────────────*/

pub(crate) fn read_runs(cache: &mut Cache, repo: &Repo) -> Result<Vec<Run>, Denied> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/actions/runs?per_page={}",
        encode(&repo.owner),
        encode(&repo.name),
        RUNS_PER_REPO,
    );
    let v = ask(cache, "GET", &url, None)?;
    let me = me(cache);
    let empty = Vec::new();
    let rows = v.get("workflow_runs").and_then(|v| v.as_array()).unwrap_or(&empty);

    Ok(rows
        .iter()
        .filter_map(|r| {
            let run_id = r.get("id")?.as_i64()?;
            /* `triggering_actor` is who caused *this attempt* and `actor` is who
               caused the first one; on a re-run they differ, and the person
               looking at the wall wants the one who pressed the button just
               now. */
            let by = r
                .get("triggering_actor")
                .filter(|v| !v.is_null())
                .or_else(|| r.get("actor"))
                .cloned()
                .unwrap_or_default();
            let login = text(&by, "login");
            Some(Run {
                id: format!("github/{}/{}/{run_id}", repo.owner, repo.name),
                forge: Forge::Github.as_str(),
                org: repo.owner.clone(),
                project: repo.name.clone(),
                pipeline: text(r, "name"),
                number: r
                    .get("run_number")
                    .and_then(|n| n.as_i64())
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
                status: text(r, "status"),
                result: text(r, "conclusion"),
                branch: text(r, "head_branch"),
                by: login.clone(),
                queued_at: stamp(r, "created_at"),
                started_at: stamp(r, "run_started_at"),
                /* GitHub does not report a finish time on a run. `updated_at` is
                   the nearest true thing — the last time anything about the run
                   changed, which for a completed one is when it completed — and
                   it is only read once `status` is `completed`, which is where
                   `elapsed` uses it. Left as-is while it is running, where it
                   would mean "when the last job ticked" and be read as a finish
                   time by anything careless. */
                finished_at: if text(r, "status") == "completed" {
                    stamp(r, "updated_at")
                } else {
                    0
                },
                url: text(r, "html_url"),
                mine: !me.is_empty() && login == me,
            })
        })
        .collect())
}

/* ── reviews ───────────────────────────────────────────────────────────────*/

/// One query for everything a pull request row needs, plus the caller's login.
///
/// `latestOpinionatedReviews` rather than `reviews`, deliberately: it is the
/// most recent *approve or request-changes* per person, which is the question a
/// vote answers. Plain `reviews` returns every comment anybody ever left, so a
/// reviewer who approved after asking for changes would appear as both.
const PRS_QUERY: &str = r#"
query($owner:String!,$name:String!,$n:Int!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:$n,orderBy:{field:CREATED_AT,direction:DESC}){
      nodes{
        number title isDraft createdAt url mergeable reviewDecision
        baseRefName
        author{ login }
        autoMergeRequest{ enabledAt }
        reviewRequests(first:25){ nodes{ requestedReviewer{ __typename ... on User{ login } } } }
        latestOpinionatedReviews(first:25){ nodes{ state author{ login } } }
      }
    }
  }
}"#;

/// GitHub's merge state, in Azure DevOps' words.
///
/// The one place a run of the no-folding rule is broken on purpose, and it
/// qualifies under the test `forge.rs` states: three states to three states,
/// total, lossless, nothing invented. `UNKNOWN` is GitHub still computing the
/// merge in the background, which is precisely what Azure DevOps calls `queued`.
fn merge_of(mergeable: &str) -> &'static str {
    match mergeable {
        "MERGEABLE" => "succeeded",
        "CONFLICTING" => "conflicts",
        _ => "queued",
    }
}

/// A GitHub review state on the five-point scale.
///
/// **`CHANGES_REQUESTED` is -5 and not -10**, and the difference is the whole
/// reason this is a judgement rather than a lookup. Azure DevOps' -10 is
/// *rejected* — a reviewer saying no to the change itself — where -5 is *waiting
/// for the author*, which is a turn passing. GitHub has only the one state and
/// it means the second: requesting changes on GitHub is how you hand the branch
/// back, and it clears the moment the author pushes and re-requests. Mapping it
/// to -10 would put "rejected" on the wall for the ordinary back-and-forth of a
/// code review, which is both wrong and the more alarming of the two errors.
///
/// `reviewSaid` says "changes asked" for -5, which is exactly the right words.
fn vote_of(state: &str) -> i64 {
    match state {
        "APPROVED" => 10,
        "CHANGES_REQUESTED" => -5,
        /* `COMMENTED` and `DISMISSED` are both "has not taken a position": one
           said something without voting, the other's vote was cleared by a push.
           Neither blocks and neither approves. */
        _ => 0,
    }
}

/// GitHub's rollup, in the vocabulary `landable` reads.
fn decision_of(d: &str) -> &'static str {
    match d {
        "APPROVED" => "approved",
        "CHANGES_REQUESTED" => "changesRequested",
        "REVIEW_REQUIRED" => "reviewRequired",
        /* Null is what GitHub answers for a repository with no review policy at
           all — nobody's approval is required, so nothing is outstanding. That
           is the same vacuous truth `landable` already grants an Azure DevOps
           repo with no required reviewers, so it is said the same way. */
        _ => "approved",
    }
}

pub(crate) fn read_reviews(cache: &mut Cache, repo: &Repo) -> Result<Vec<Review>, Denied> {
    let data = graphql(
        cache,
        PRS_QUERY,
        serde_json::json!({
            "owner": repo.owner,
            "name": repo.name,
            "n": PRS_PER_REPO,
        }),
    )?;

    let me = data
        .get("viewer")
        .map(|v| text(v, "login"))
        .unwrap_or_default();
    remember_me(cache, &me);

    let empty = Vec::new();
    let rows = data
        .get("repository")
        .and_then(|r| r.get("pullRequests"))
        .and_then(|p| p.get("nodes"))
        .and_then(|n| n.as_array())
        .unwrap_or(&empty);

    Ok(rows
        .iter()
        .filter_map(|p| {
            let number = p.get("number")?.as_i64()?;
            let author = p
                .get("author")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_default();
            let by = text(&author, "login");

            /* Two lists, and they are disjoint by construction: GitHub takes a
               person out of `reviewRequests` the moment they submit a review and
               puts them in `latestOpinionatedReviews`. So "asked and has not
               answered" and "has answered" arrive already told apart, which is
               the distinction `needsMe` is built on and which the REST list
               cannot make at all. */
            let asked: Vec<String> = p
                .get("reviewRequests")
                .and_then(|r| r.get("nodes"))
                .and_then(|n| n.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|n| {
                            let who = n.get("requestedReviewer")?;
                            /* A null here is a *team* being asked rather than a
                               person — the query only spreads `... on User`.
                               Dropped rather than guessed at: a team request
                               that happens to include you is a fact this query
                               does not carry, and inventing a row for it would
                               claim more than we know. */
                            let login = who.get("login")?.as_str()?;
                            Some(login.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();

            let mut votes: Vec<Vote> = p
                .get("latestOpinionatedReviews")
                .and_then(|r| r.get("nodes"))
                .and_then(|n| n.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|r| {
                            let who = r.get("author").filter(|v| !v.is_null())?;
                            Some(Vote {
                                by: text(who, "login"),
                                vote: vote_of(&text(r, "state")),
                                /* GitHub does not say who is required, and this
                                   is the honest answer rather than a guess.
                                   `landable` does not read it for a GitHub row —
                                   it reads `decision`, which is GitHub answering
                                   the rolled-up question instead. */
                                required: false,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            /* Somebody asked and still silent is a row on the list at zero, so
               the panel can name them. Azure DevOps sends these as reviewers
               with a vote of 0 and this is the same shape arriving the long way
               round. */
            for login in &asked {
                votes.push(Vote { by: login.clone(), vote: 0, required: false });
            }

            let reviewing = !me.is_empty()
                && (asked.iter().any(|l| l == &me)
                    || votes.iter().any(|v| v.by == me && v.vote != 0));
            let my_vote = votes
                .iter()
                .find(|v| !me.is_empty() && v.by == me)
                .map(|v| v.vote)
                .unwrap_or(0);

            Some(Review {
                id: format!("github/{}/{}/{number}", repo.owner, repo.name),
                forge: Forge::Github.as_str(),
                org: repo.owner.clone(),
                /* The repository stands in for both, because GitHub has no
                   level between an owner and a repo. Saying the repo twice is
                   better than leaving `project` empty, which the `lanes`
                   reading would draw as a nameless group. */
                project: repo.name.clone(),
                repo: repo.name.clone(),
                number,
                title: text(p, "title"),
                by: by.clone(),
                draft: p.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
                merge: merge_of(&text(p, "mergeable")).to_string(),
                target: text(p, "baseRefName"),
                created_at: stamp(p, "createdAt"),
                url: text(p, "url"),
                auto: p
                    .get("autoMergeRequest")
                    .map(|v| !v.is_null())
                    .unwrap_or(false),
                mine: !me.is_empty() && by == me,
                reviewing,
                my_vote,
                votes,
                decision: decision_of(
                    p.get("reviewDecision").and_then(|v| v.as_str()).unwrap_or(""),
                )
                .to_string(),
            })
        })
        .collect())
}

/* ── one run, opened ───────────────────────────────────────────────────────*/

/// A run's jobs and their steps.
///
/// One request, and the shape maps straight onto `forge.rs`'s two levels
/// without any rearranging — which is the half of the detail reading that was
/// free, and worth saying because the Azure DevOps half is not.
pub(crate) fn read_detail(cache: &mut Cache, id: &str) -> Result<Detail, String> {
    let (owner, name, run_id) = split_id(id)?;
    let url = format!(
        "https://api.github.com/repos/{}/{}/actions/runs/{}/jobs?per_page=100",
        encode(&owner),
        encode(&name),
        encode(&run_id),
    );
    let v = ask(cache, "GET", &url, None).map_err(String::from)?;
    let empty = Vec::new();
    let jobs = v.get("jobs").and_then(|j| j.as_array()).unwrap_or(&empty);

    let stages: Vec<Stage> = jobs
        .iter()
        .map(|j| Stage {
            name: text(j, "name"),
            status: text(j, "status"),
            result: text(j, "conclusion"),
            started_at: stamp(j, "started_at"),
            finished_at: stamp(j, "completed_at"),
            steps: j
                .get("steps")
                .and_then(|s| s.as_array())
                .map(|a| {
                    a.iter()
                        .map(|s| Step {
                            name: text(s, "name"),
                            status: text(s, "status"),
                            result: text(s, "conclusion"),
                            started_at: stamp(s, "started_at"),
                            finished_at: stamp(s, "completed_at"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect();

    /* Asked of the jobs rather than of the run, because the run is a second
       request and the answer is the same: a run with a job still going is
       going. The one case this is wrong about — every job finished, the run not
       yet marked complete — resolves itself on the next refresh, and erring
       towards "finished" there merely stops the polling a beat early rather
       than showing a stale panel for ever. */
    let live = stages.iter().any(|s| s.status != "completed");

    Ok(Detail {
        id: id.to_string(),
        forge: Forge::Github.as_str(),
        stages,
        live,
        fault: None,
    })
}

/// `github/{owner}/{repo}/{run}` back into its three parts.
///
/// The id is composed in `read_runs` and taken apart here, which is the whole
/// reason it carries the forge: a detail request needs nothing from the front
/// end but the string already on the row.
fn split_id(id: &str) -> Result<(String, String, String), String> {
    let mut parts = id.split('/');
    match (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("github"), Some(o), Some(r), Some(n), None)
            if !o.is_empty() && !r.is_empty() && !n.is_empty() =>
        {
            Ok((o.to_string(), r.to_string(), n.to_string()))
        }
        _ => Err(format!("not a github run id: {id}")),
    }
}

/* ── the pass ──────────────────────────────────────────────────────────────*/

/// What one forge's half of a reading came to. Merged with Azure DevOps' in
/// `azdo.rs`, which owns the command.
pub struct Scan<T> {
    pub rows: Vec<T>,
    /// Each repository counts as one asked, so the widget's `asked` number stays
    /// a count of requests that left the machine whichever forge they went to.
    pub asked: usize,
    pub unseen: usize,
    pub fault: Option<String>,
    /// The owners seen, so a wall with a GitHub repo on it says so in the header
    /// beside the Azure DevOps organisations.
    pub orgs: Vec<String>,
}

pub fn runs_with(cache: &mut Cache, roots: &[String]) -> Scan<Run> {
    let repos = repos_for(cache, roots);
    let mut rows = Vec::new();
    let mut fault = None;
    let mut unseen = 0usize;
    let mut orgs: Vec<String> = Vec::new();

    for repo in &repos {
        if !orgs.contains(&repo.owner) {
            orgs.push(repo.owner.clone());
        }
        match read_runs(cache, repo) {
            Ok(mut got) => rows.append(&mut got),
            Err(Denied::Unseen) => unseen += 1,
            Err(Denied::Said(e)) => {
                fault.get_or_insert(format!("{}: {e}", repo.slug()));
            }
        }
    }
    Scan { rows, asked: repos.len(), unseen, fault, orgs }
}

pub fn reviews_with(cache: &mut Cache, roots: &[String]) -> Scan<Review> {
    let repos = repos_for(cache, roots);
    let mut rows = Vec::new();
    let mut fault = None;
    let mut unseen = 0usize;
    let mut orgs: Vec<String> = Vec::new();

    for repo in &repos {
        if !orgs.contains(&repo.owner) {
            orgs.push(repo.owner.clone());
        }
        match read_reviews(cache, repo) {
            Ok(mut got) => rows.append(&mut got),
            Err(Denied::Unseen) => unseen += 1,
            Err(Denied::Said(e)) => {
                fault.get_or_insert(format!("{}: {e}", repo.slug()));
            }
        }
    }
    Scan { rows, asked: repos.len(), unseen, fault, orgs }
}

/// Unused today and kept deliberately: `quiet` and `epoch_ms` are imported so
/// this module and `azdo.rs` cannot drift onto two spellings of the same thing.
#[allow(dead_code)]
fn _keep_imports_honest(c: &mut Command, t: &str) -> i64 {
    quiet(c);
    epoch_ms(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repo_is_read_out_of_every_remote_shape_in_the_wild() {
        let cases = [
            "https://github.com/ShaitanLyss/volery.git",
            "https://github.com/ShaitanLyss/volery",
            "git@github.com:ShaitanLyss/volery.git",
            "ssh://git@github.com/ShaitanLyss/volery.git",
            "https://ShaitanLyss@github.com/ShaitanLyss/volery.git",
            "https://www.github.com/ShaitanLyss/volery",
        ];
        for c in cases {
            let r = repo_of(c).unwrap_or_else(|| panic!("no repo from {c}"));
            assert_eq!(r.owner, "ShaitanLyss", "{c}");
            assert_eq!(r.name, "volery", "{c}");
        }
    }

    #[test]
    fn anything_that_is_not_github_dot_com_is_not_guessed_at() {
        /* Half this workspace is on Azure DevOps, and a wall holding both must
           ask each service only about what is actually on it. */
        assert!(repo_of("https://LagardereAWPL@dev.azure.com/LagardereAWPL/NOVA/_git/NOVA").is_none());
        assert!(repo_of("https://dev.azure.com/org/proj/_git/repo").is_none());
        /* GitHub Enterprise on somebody's own domain is deliberately refused
           rather than pointed at api.github.com, where the owner might name a
           different repository that happens to share the name. */
        assert!(repo_of("https://github.example.com/owner/repo.git").is_none());
        assert!(repo_of("https://gitlab.com/owner/repo.git").is_none());
        assert!(repo_of("not a url").is_none());
    }

    #[test]
    fn a_repo_is_the_same_repo_whatever_case_it_is_written_in() {
        /* GitHub itself is case-insensitive about both halves, and a wall with
           one card cloned `ShaitanLyss/volery` and another `shaitanlyss/Volery`
           must ask about it once rather than twice. */
        assert_eq!(
            repo_of("https://github.com/ShaitanLyss/volery"),
            repo_of("https://github.com/shaitanlyss/VOLERY")
        );
    }

    #[test]
    fn an_id_round_trips_from_the_row_to_the_detail() {
        assert_eq!(
            split_id("github/ShaitanLyss/volery/33032289871").unwrap(),
            ("ShaitanLyss".into(), "volery".into(), "33032289871".into())
        );
    }

    #[test]
    fn an_id_from_the_other_forge_is_refused_rather_than_half_read() {
        /* Both forges' ids are slash-separated and the same length, so the
           prefix is the only thing telling them apart — and a detail request
           routed to the wrong provider would 404 confusingly instead of saying
           what happened. */
        assert!(split_id("azdo/LagardereAWPL/969d/2515").is_err());
        assert!(split_id("github/ShaitanLyss/volery").is_err());
        assert!(split_id("github/ShaitanLyss/volery/1/2").is_err());
        assert!(split_id("github//volery/1").is_err());
    }

    #[test]
    fn the_three_merge_states_correspond_exactly() {
        /* The projection `forge.rs` licenses: total, lossless, nothing
           invented. If GitHub ever grows a fourth it lands in `queued`, which is
           the honest "still being worked out" rather than a claim. */
        assert_eq!(merge_of("MERGEABLE"), "succeeded");
        assert_eq!(merge_of("CONFLICTING"), "conflicts");
        assert_eq!(merge_of("UNKNOWN"), "queued");
        assert_eq!(merge_of(""), "queued");
    }

    #[test]
    fn requesting_changes_is_the_authors_turn_and_not_a_rejection() {
        /* The judgement in this file most worth pinning down: -5 means the ball
           is with the author, -10 means somebody said no to the change. GitHub
           has only the first, and drawing "rejected" over an ordinary review
           round-trip is the more alarming of the two ways to be wrong. */
        assert_eq!(vote_of("APPROVED"), 10);
        assert_eq!(vote_of("CHANGES_REQUESTED"), -5);
        assert_eq!(vote_of("COMMENTED"), 0);
        assert_eq!(vote_of("DISMISSED"), 0);
        assert_eq!(vote_of("PENDING"), 0);
    }

    #[test]
    fn a_repo_with_no_review_policy_is_landable_rather_than_unknown() {
        /* Null `reviewDecision` is GitHub saying nobody's approval is required.
           That is the same vacuous truth `landable` already grants an Azure
           DevOps repo with no required reviewers. */
        assert_eq!(decision_of(""), "approved");
        assert_eq!(decision_of("APPROVED"), "approved");
        assert_eq!(decision_of("CHANGES_REQUESTED"), "changesRequested");
        assert_eq!(decision_of("REVIEW_REQUIRED"), "reviewRequired");
    }

    #[test]
    fn gh_is_looked_for_under_every_name_it_goes_by() {
        /* The lesson `az` cost ten days: a bare program name does not consult
           PATHEXT, so a `.cmd` shim is invisible. */
        let names = gh_names();
        assert!(names.contains(&"gh"));
        if cfg!(windows) {
            assert!(names.contains(&"gh.cmd"), "a scoop or winget install is a .cmd shim");
        }
    }
}

/// The cache behind however many widgets are up, as Tauri state.
///
/// Its own state rather than a field on `Azdo`, so that a wall with no GitHub
/// repository on it holds nothing at all — and so that `release_azdo` clearing
/// both is a visible decision rather than a side effect of them sharing a
/// struct.
#[derive(Default)]
pub struct Github(pub(crate) std::sync::Mutex<Cache>);
