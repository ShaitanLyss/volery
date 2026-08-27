//! Azure DevOps, as far as a wall needs to know about it.
//!
//! Two questions, and they are genuinely different questions: what is *running*
//! right now across every project, and which pull requests are open. This file
//! answers both in facts and never in verbs — the split `perf.rs` and `usage.rs`
//! draw. What a status *means*, what colour it is, how it is worded and how the
//! rows are ordered are `azdo.ts`'s, which is pure and tested.
//!
//! Four things about Azure DevOps carry the whole module:
//!
//! - **Pull requests are org-wide in one call; builds are not.**
//!   `_apis/git/pullrequests` with no project in the path returns every open PR
//!   in every repo the caller can see — probed 2026-08-14 against api-version
//!   7.1, one request, eight PRs across three projects. There is no equivalent
//!   for builds: `_apis/build/builds` requires a project, so runs cost one
//!   request per project and the projects are fetched (and cached) to know what
//!   to ask. That asymmetry is why the two widgets poll on different clocks.
//!
//! - **The organisation is not configured, it is read off the wall.** The AzDO
//!   organisations worth watching are exactly the ones whose repositories are
//!   standing on your wall, so `git remote get-url origin` in each project root
//!   is the whole of the configuration. A wall with no Azure DevOps repo on it
//!   asks nothing of the network, which is the same bargain the process sampler
//!   strikes.
//!
//!   This paragraph used to rest on "Skein has no text field anywhere on it",
//!   which is no longer true — the dock, the shell, the finder and now
//!   `Keyring.svelte` all have one — and the argument is better without it. An
//!   organisation is a **fact about the wall**, derivable from what is on it, so
//!   asking would be asking somebody to retype what the app can already see. A
//!   token is not derivable from anything, which is why that one *is* a field.
//!
//! - **Authentication is a ladder that falls through on 401, not on absence.**
//!   Git Credential Manager already holds a credential for `dev.azure.com` on
//!   any machine that has cloned from it, and it is enough for pull requests but
//!   not for builds — GCM issues a code-scoped token. Probed 2026-08-14 against
//!   org `LagardereAWPL` with `.scratch/tlsprobe`, one credential, four
//!   endpoints:
//!
//!   ```text
//!   projects   200    131ms
//!   pull reqs  200     89ms
//!   builds     401     48ms
//!   identity   200     25ms
//!   ```
//!
//!   So a ladder that stopped at the first credential it could *find* would work
//!   for reviews and be permanently broken for pipelines, with nothing to say
//!   about why. Each rung is therefore tried until one is *accepted*, and which
//!   rung answered is remembered per organisation and per endpoint family so the
//!   401 above is paid once rather than on every poll.
//!
//!   Four rungs: the git credential, an `az` sign-in, a token stored in the
//!   Windows vault, then `VOLERY_AZDO_PAT`. **The middle one did not work at all
//!   for the first ten days**, and how it failed is the more useful half of the
//!   lesson — `Command::new("az")` cannot find `az.cmd`, which is the only thing
//!   the Azure CLI installs on Windows, and `output` turned the spawn failure
//!   into the same `None` that means "az is not installed". So the ladder was one
//!   rung long, the widget said "a token was refused (401)" for ever, and the
//!   message was consistent with having tried everything. Two things came out of
//!   it and both are load-bearing: a rung is looked for under every name it goes
//!   by (`az_names`), and a `Cred` carries **what to call it** rather than
//!   deriving that from its shape, so a refusal names the rung that was refused.
//!
//! - **This network intercepts TLS, and the client had to be chosen for it.**
//!   `dev.azure.com` here presents a certificate signed by
//!   `ca.macquarietelecom-103950.au.goskope.com` — Netskope — whose root is in
//!   Windows' own store and in no bundled root set. The same probe is what
//!   established that rustls with `rustls-native-certs` accepts it: those four
//!   200s are real TLS handshakes through the proxy. Built the obvious way
//!   instead, every request here fails with a certificate error while working
//!   perfectly on the developer's home wifi, which is the worst shape a bug can
//!   have — hence the note above `ureq` in Cargo.toml as well as this one.

use crate::forge::{
    agent, encode, output, quiet, remote_of, stamp, text, Detail, Forge, Review, Run, Stage, Step,
    Vote,
};
use crate::github;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// How long a project list is trusted. Projects are created about once a year;
/// this is short enough that a new one appears the same morning and long enough
/// that it is never the reason a poll is slow.
const PROJECTS_FOR: Duration = Duration::from_secs(10 * 60);

/// How long an organisation read off a git remote is trusted. A remote does
/// change — a repo moves org, a worktree is made from a different one — but
/// spawning a `git` per project per poll to find out would make the cheap half
/// of this the expensive half.
const ORG_FOR: Duration = Duration::from_secs(5 * 60);

/// How long the caller's own identity is trusted. It does not change at all;
/// this exists so a token swapped underneath us is noticed within the hour
/// rather than never.
const ME_FOR: Duration = Duration::from_secs(60 * 60);

/// The margin taken off an `az` token's own expiry before it is trusted.
///
/// A token that dies between being chosen and the request landing is a refusal
/// that looks exactly like a credential problem, and this poll is slow enough
/// (six projects, a network away) that the gap is real rather than theoretical.
const AZ_MARGIN: Duration = Duration::from_secs(2 * 60);

/// The least time an `az` token is held, whatever its own expiry says.
///
/// Without a floor, a token handed over with a minute left would be re-resolved
/// on *every* poll — an `az` process spawn each time, for a credential that is
/// about to be replaced anyway. Better to present it, take the one refusal, and
/// let the ladder rotate.
const AZ_MIN_HOLD: Duration = Duration::from_secs(60);

/// How long an `az` token is held when it did not say when it expires.
///
/// Only reachable if a future `az` stops printing `expires_on`. Conservative on
/// purpose: the cost of being wrong low is one process spawn, and the cost of
/// being wrong high is the bug this whole mechanism exists to prevent.
const AZ_BLIND_HOLD: Duration = Duration::from_secs(30 * 60);

/// Builds asked for per project. Deep enough that a project mid-deploy shows
/// the run and the two before it, shallow enough that six of these is a payload
/// measured in tens of kilobytes.
const BUILDS_PER_PROJECT: usize = 25;

/// Open pull requests asked for per organisation. Above any real number; the
/// API caps its own page at 101 without it.
const PRS_PER_ORG: usize = 200;

#[derive(Default)]
pub struct Azdo(Mutex<Cache>);

/// Everything worth not asking twice. Public only so the probe can make one —
/// nothing outside this module reads a field.
#[derive(Default)]
pub struct Cache {
    /// Project root → the organisation its origin points at, and when we looked.
    /// `None` is a real answer and is cached: a repo that is not on Azure DevOps
    /// must not be re-probed on every poll.
    orgs: HashMap<String, (Option<String>, Instant)>,
    /// Organisation → its projects, and when they were listed.
    projects: HashMap<String, (Vec<Project>, Instant)>,
    /// Organisation → the caller's own identity id there.
    me: HashMap<String, (String, Instant)>,
    /// (organisation, endpoint family) → which rung of the ladder was accepted.
    /// See the note at the top: this is what keeps a 401 from being paid on
    /// every poll for a credential that will never work for that family.
    rung: HashMap<(String, &'static str), usize>,
    /// Organisation → its ladder. Per organisation rather than once for the app,
    /// because the first rung genuinely differs by organisation: Git Credential
    /// Manager stores an Azure DevOps credential *per org* and refuses to answer
    /// without being told which (see `from_git`). Each rung costs a process
    /// spawn, so this is resolved once per org and held.
    creds: HashMap<String, Vec<Cred>>,
}

#[derive(Clone)]
struct Project {
    id: String,
    name: String,
}

/// How a request is signed. Two shapes because the sources give two shapes: a
/// personal access token goes in as HTTP Basic with an empty user, an Entra
/// token goes in as a bearer.
#[derive(Clone, PartialEq)]
enum Kind {
    Basic,
    Bearer,
}

/// One rung's answer: what to sign with, and what to *call* it.
///
/// **The name is carried rather than derived from the shape**, and that is a
/// correction rather than a flourish. `source()` used to answer off the `Kind`
/// alone — "a token" for Basic, "a sign-in" for Bearer — which was unambiguous
/// only while exactly one rung was Basic. Three of the four now are, so a
/// widget saying "a token was refused (401)" named a rung you could not
/// identify, and the one thing it most needed to distinguish was a *code-scoped
/// credential git happens to hold* from *a PAT you minted on purpose*. That
/// ambiguity is most of why the dead `az` rung above went unnoticed for ten
/// days: the message was consistent with a ladder that had tried everything.
#[derive(Clone)]
struct Cred {
    kind: Kind,
    secret: String,
    /// Which rung this came off, for the one line the widget has room for.
    /// Never the secret, and never enough of it to be one.
    from: &'static str,
    /// When this credential stops working, for the one kind that does.
    ///
    /// `None` is the common case and means *does not expire on its own*: a PAT
    /// is good for months, an environment variable does not change underneath
    /// us, and Git Credential Manager refreshes its own. The exception is an
    /// `az` sign-in, which is an Entra access token with about an hour in it —
    /// see `from_az`. An `Instant` rather than a wall-clock time because it is
    /// a deadline rather than a date, and the machine's clock moving must not
    /// make a live token look dead.
    until: Option<Instant>,
}

impl Cred {
    fn basic(from: &'static str, secret: String) -> Self {
        Cred { kind: Kind::Basic, secret, from, until: None }
    }

    /// A bearer, which always dies on its own — `hold` from now.
    ///
    /// There is deliberately no non-expiring constructor beside this one. Every
    /// bearer Skein holds is an Entra access token with about an hour in it, and
    /// a `bearer()` that quietly meant *forever* is the shape the bug had.
    fn bearer_for(from: &'static str, secret: String, hold: Duration) -> Self {
        Cred { kind: Kind::Bearer, secret, from, until: Some(Instant::now() + hold) }
    }

    /// Whether this one is past it. A rung with no expiry never is.
    fn spent(&self, now: Instant) -> bool {
        self.until.is_some_and(|t| now >= t)
    }

    fn header(&self) -> String {
        match self.kind {
            /* Basic with an empty username is Azure DevOps' documented way of
               presenting a PAT, and the only one it accepts. */
            Kind::Basic => format!("Basic {}", base64(format!(":{}", self.secret).as_bytes())),
            Kind::Bearer => format!("Bearer {}", self.secret),
        }
    }

    /// Whether two rungs resolved to the same credential — which is ordinary,
    /// and is the dedup `ladder` does. Deliberately **not** `PartialEq` on the
    /// whole struct: `from` differs precisely in the case worth collapsing (the
    /// stored token and `VOLERY_AZDO_PAT` holding the same PAT), so comparing it
    /// would keep both and pay the cost of discovering the refusal twice.
    fn same_as(&self, other: &Cred) -> bool {
        self.kind == other.kind && self.secret == other.secret
    }
}

/// Base64, written out rather than pulled in. It is eleven lines, it is used in
/// exactly one place, and the alternative is a dependency in the tree of an app
/// that is careful about its tree.
fn base64(bytes: &[u8]) -> String {
    const SET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(SET[((n >> (18 - i * 6)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/* ── the ladder ────────────────────────────────────────────────────────────*/

/// What Git Credential Manager already holds for this organisation.
///
/// Free on any machine that has cloned from it, which is every machine this
/// widget is for — so the common case costs nothing to set up.
///
/// **The organisation has to be in the request, and this is not optional.**
/// Probed 2026-08-14 with GCM against `dev.azure.com`: asked for the bare host,
/// it refuses outright —
///
/// ```text
/// fatal: Cannot determine the organization name for this 'dev.azure.com' remote
/// URL. Ensure the `credential.useHttpPath` configuration value is set, or set
/// the organization name as the user in the remote URL '{org}@dev.azure.com'.
/// ```
///
/// — and then falls through to prompting, which is the worse half of the bug: on
/// a machine with a terminal it blocks forever, and in a GUI it pops a sign-in
/// window over the wall from a poll nobody asked for. So the org goes in as
/// `path`, and `credential.useHttpPath` is forced **on the command line** rather
/// than trusted from the user's config — it happens to be set globally on this
/// machine, and a feature that quietly stops working on a colleague's because of
/// a config they have never heard of is not a feature.
///
/// `GIT_TERMINAL_PROMPT=0` and `credential.interactive=false` are the same pair
/// `project.rs::fetch_projects` sets, for exactly the same reason: a background
/// poll must never ask a question. Both turn a missing credential into a fast
/// failure, which is right — being unable to read pipelines is not worth
/// interrupting anybody about, and the widget says so on its own face.
fn from_git(org: &str) -> Option<Cred> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = quiet(
        Command::new("git")
            .args(["-c", "credential.useHttpPath=true"])
            .args(["-c", "credential.interactive=false"])
            .env("GIT_TERMINAL_PROMPT", "0")
            .arg("credential")
            .arg("fill"),
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
    child
        .stdin
        .take()?
        .write_all(format!("protocol=https\nhost=dev.azure.com\npath={org}\n\n").as_bytes())
        .ok()?;
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("password="))
        .filter(|p| !p.is_empty())
        .map(|p| Cred::basic("the git credential", p.to_string()))
}

/// Where an `az` might be, in the order worth trying.
///
/// **This is not a nicety — it is the difference between this rung existing and
/// not.** `Command::new("az")` resolves a bare program name by appending `.exe`
/// and does not consult `PATHEXT`; the Azure CLI installs `az.cmd`, and there is
/// no `az.exe` in a normal install. So the middle rung of this ladder silently
/// did not exist on Windows at all: `ladder` returned the git credential alone,
/// that credential is code-scoped, and the pipelines widget therefore read "a
/// token was refused (401)" on every poll with nothing to fall through to.
/// Probed 2026-08-24 on this machine, `UseShellExecute = false` so it is the same
/// CreateProcess resolution Rust does — bare `az` fails with "the system cannot
/// find the file specified", `az.cmd` starts and exits 0. Note also that
/// `output` turns the spawn failure into `None`, which is indistinguishable from
/// az not being installed, so nothing anywhere said the rung had been skipped.
///
/// Bare `az` is still tried first, the order `find.rs::candidates` uses for
/// ripgrep: an `az.exe` somebody put on their PATH on purpose is the one they
/// mean, and the miss costs a failed CreateProcess rather than a process.
fn az_names() -> &'static [&'static str] {
    #[cfg(windows)]
    {
        &["az", "az.cmd"]
    }
    #[cfg(not(windows))]
    {
        &["az"]
    }
}

/// An Entra token from the Azure CLI, for the Azure DevOps resource.
///
/// That GUID is Azure DevOps' own first-party application id — it is a
/// well-known constant, not something derived from this tenant, and it is the
/// only value `--resource` takes that yields a token these APIs accept.
///
/// This rung exists because it is the one that can be *broader* than the git
/// credential: a PAT is scoped at creation and cannot be widened afterwards,
/// where a sign-in carries whatever the person has. It can also be signed in as
/// a different identity than git is, which is why it is below git rather than
/// above it — the credential you clone with is the one whose PRs you mean.
fn from_az() -> Option<Cred> {
    for name in az_names() {
        /* The whole object rather than `--query accessToken -o tsv`, which is
           what this asked for until the token's own lifetime turned out to
           matter. See `az_hold` for what is read out of it and what is
           deliberately not. */
        let Some(out) = output(Command::new(name).args([
            "account",
            "get-access-token",
            "--resource",
            "499b84ac-1321-427f-aa17-267ca6975798",
            "-o",
            "json",
        ])) else {
            continue;
        };
        if let Some((tok, hold)) = az_token(&out, now_unix()) {
            return Some(Cred::bearer_for("an az sign-in", tok, hold));
        }
    }
    None
}

/// Now, in seconds since the epoch. Only ever subtracted from `az`'s own
/// `expires_on`, which is in the same units.
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The token `az` printed, and how long Skein will hold it.
///
/// Pure, and split out from `from_az` for that reason: everything interesting
/// here is arithmetic on somebody else's JSON, and the failure it guards
/// against — holding a dead token — is invisible until a widget goes dark an
/// hour later.
///
/// **`expires_on`, never `expiresOn`.** Probed 2026-08-25 against the Azure CLI
/// on this machine, one call returns both:
///
/// ```text
/// "expiresOn":  "2026-08-25 11:30:28.000000"
/// "expires_on": 1787621428
/// ```
///
/// The first is local time with no zone on it, so reading it means knowing
/// which zone the CLI meant and being wrong by hours in the other ones. The
/// second is seconds since the epoch and needs nothing. Accepted as a number or
/// a string, since which one a JSON serialiser produces for a large integer is
/// not a thing to depend on.
fn az_token(out: &str, now: u64) -> Option<(String, Duration)> {
    let v: serde_json::Value = serde_json::from_str(out).ok()?;
    let tok = v.get("accessToken")?.as_str()?.trim();
    if tok.is_empty() {
        return None;
    }
    let expires = v.get("expires_on").and_then(|e| {
        e.as_u64().or_else(|| e.as_str().and_then(|s| s.trim().parse().ok()))
    });
    let hold = match expires {
        /* Already gone, or so nearly gone that the margin eats it. Held for the
           floor anyway rather than discarded: the ladder's own rotation deals
           with a refusal in one request, where returning None here would spawn
           `az` again on the very next poll and keep doing it. */
        Some(at) => Duration::from_secs(at.saturating_sub(now))
            .saturating_sub(AZ_MARGIN)
            .max(AZ_MIN_HOLD),
        None => AZ_BLIND_HOLD,
    };
    Some((tok.to_string(), hold))
}

/// A token entered in the app, out of the Windows credential vault.
///
/// This rung is the answer to the case the two above cannot reach, and on this
/// network it is the common one rather than the exotic one: Git Credential
/// Manager holds a code-scoped credential that 401s on builds, and an `az`
/// sign-in is frequently a *different identity* — probed 2026-08-24 against
/// `LagardereAWPL`, git authenticates as `l.delprat@lagardereawpl.com` and az as
/// `ca.lyss.delprat@ltrp.onmicrosoft.com`, which can see builds in two of the
/// org's six projects and none of the other four. Neither of those is fixable
/// from inside this app; a PAT minted with Build (read) is.
///
/// **Above the environment variable, below the sign-in.** Above `from_env`
/// because the two are the same kind of credential — a PAT you minted by hand —
/// and this is the better-kept copy: a variable in a shell profile is the one
/// that goes stale unnoticed, so the more current statement wins, exactly as
/// `VOLERY_AZDO_PAT` is read ahead of `SKEIN_AZDO_PAT`. Below `from_az` for the
/// reason the whole order barely matters: the ladder falls through on refusal,
/// so a rung above this one only decides anything when it was *accepted*, and an
/// accepted rung is by definition a credential that works.
///
/// `vault.rs` has the argument about where the secret goes, and this is the only
/// place that reads it.
fn from_vault() -> Option<Cred> {
    crate::vault::read().map(|pat| Cred::basic("the stored token", pat))
}

/// A token set by hand, for when neither of the above has the scope.
///
/// Last rather than first, which is deliberate and is the one place the order
/// is worth arguing about. An environment variable set explicitly is the most
/// considered statement of the three, so it has a claim to winning outright —
/// but because the ladder falls through on refusal rather than on absence,
/// being last costs it nothing it would have won: the only case where the order
/// decides anything is one where a rung above it was *accepted*, and a rung that
/// was accepted is by definition a credential that works. Putting it first would
/// instead mean a stale variable in somebody's shell profile silently outranking
/// the sign-in they just did.
/// Both names, and the old one is not deprecated so much as *kept*: the app was
/// called Skein when this variable was documented, the rename was made with the
/// name explicitly provisional, and a variable already sitting in somebody's
/// shell profile is exactly the kind of thing a rename must not silently break.
/// The new name is read first so that setting both means the current one wins.
fn from_env() -> Option<Cred> {
    [
        ("VOLERY_AZDO_PAT", "VOLERY_AZDO_PAT"),
        ("SKEIN_AZDO_PAT", "SKEIN_AZDO_PAT"),
    ]
    .into_iter()
    .filter_map(|(k, name)| Some((std::env::var(k).ok()?, name)))
    .map(|(v, name)| (v.trim().to_string(), name))
    .find(|(v, _)| !v.is_empty())
    .map(|(v, name)| Cred::basic(name, v))
}

fn ladder(org: &str) -> Vec<Cred> {
    let mut out: Vec<Cred> = Vec::new();
    for got in [from_git(org), from_az(), from_vault(), from_env()] {
        /* Two rungs resolving to the same secret is ordinary — `VOLERY_AZDO_PAT`
           set to the same PAT the vault holds — and trying it twice would double
           the cost of discovering it is refused. Compared on the credential and
           not on the name it came off; see `Cred::same_as`. */
        if let Some(c) = got {
            if !out.iter().any(|held| held.same_as(&c)) {
                out.push(c);
            }
        }
    }
    out
}

/* ── asking ────────────────────────────────────────────────────────────────*/

/// Why a request came back with no answer.
///
/// Two variants because two of these are *not the same thing to a reader*. A
/// credential being refused is something you can act on — mint a PAT, sign in
/// again — and belongs in the widget's one line. A project that no rung can see
/// is a silence: an organisation with per-project permissions will legitimately
/// have projects your credential is not on, and drawing that as a fault means a
/// wall permanently reporting a problem that is only the shape of the org.
enum Denied {
    /// Say this. The last rung's refusal, or whatever else went wrong.
    Said(String),
    /// Every rung that answered said it cannot see this project. Not a fault.
    Unseen,
}

impl From<Denied> for String {
    fn from(d: Denied) -> String {
        match d {
            Denied::Said(s) => s,
            /* For the callers that have nowhere to put the distinction — the
               project list and the identity — where it also cannot arise: both
               are org-level and neither names a project. */
            Denied::Unseen => "not visible to any credential".into(),
        }
    }
}

/// Whether a body is Azure DevOps saying "you are not on this project".
///
/// It answers this with a **400**, not the 404 you would expect, and that is
/// what made it a bug rather than a case: 400 fell to the hard-error arm below,
/// so the ladder stopped dead on the first rung that could not see a project
/// instead of trying the ones that could. Probed 2026-08-24 against
/// `_apis/build/builds` with an Entra bearer lacking access:
///
/// ```text
/// 400  VS800075: The project with id 'vstfs:///Classification/TeamProject/969d…'
///      does not exist, or you do not have permission to access it.
///      typeKey: ProjectDoesNotExistException
/// ```
///
/// Matched on `typeKey` rather than on the status or the message: blanket-
/// forgiving every 400 would swallow a genuinely malformed request, which is a
/// bug in *this* file and has to stay loud, and the message is prose that gets
/// localised and rewritten.
fn unseen(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("typeKey")?.as_str().map(|s| s.to_string()))
        .is_some_and(|k| k == "ProjectDoesNotExistException")
}

/// One GET, signed with whichever rung is accepted, starting from the one that
/// worked last time for this family.
///
/// The rotation is what makes "starting from" safe: a remembered rung that has
/// since stopped working falls through to the others rather than pinning the
/// failure, and a rung that works is written back. `family` is `"build"` or
/// `"git"` — the two AzDO scopes that are granted separately and therefore the
/// two that can disagree about the same credential.
fn get(
    cache: &mut Cache,
    org: &str,
    family: &'static str,
    url: &str,
) -> Result<serde_json::Value, Denied> {
    /* The ladder is resolved once per organisation and held, because each rung
       costs a process spawn — and it was held *forever*, which is the bug this
       re-resolution answers. Three of the four rungs genuinely do not expire, so
       the expiry lives on the rung that does (`Cred::until`) rather than on the
       map: a TTL on the whole cache would re-spawn four processes on a clock to
       rediscover three things that had not changed.

       What went wrong without it: an `az` sign-in is good for about an hour, and
       a wall is left up for a day. `get` rotates past a refused rung, so on a
       machine with another working credential this cost one wasted request — but
       the ordinary case on this network is a git credential that is code-scoped
       and 401s on builds anyway, so once the bearer died *every* rung was
       refused and the widget went dark until you took it off the wall and put it
       back, which is the only thing that reached `release_azdo`. */
    let creds = match cache.creds.get(org) {
        Some(c) if !c.iter().any(|cred| cred.spent(Instant::now())) => c.clone(),
        _ => {
            let c = ladder(org);
            cache.creds.insert(org.to_string(), c.clone());
            /* The remembered rung is an *index into the ladder we just replaced*,
               and the new one can be a different length or a different order — a
               rung that resolved an hour ago may not now. Nothing unsafe comes of
               a stale one, since the walk is modulo the length and re-records on
               success, but it would start the pass at a rung nobody chose. */
            cache.rung.retain(|(o, _), _| o != org);
            c
        }
    };
    if creds.is_empty() {
        return Err(Denied::Said(format!(
            "no credential for {org} on this machine — clone from it, run `az login`, \
             or store a token"
        )));
    }

    let start = cache
        .rung
        .get(&(org.to_string(), family))
        .copied()
        .unwrap_or(0);
    let agent = agent();
    let mut refused: Option<String> = None;
    let mut invisible = false;

    for step in 0..creds.len() {
        let at = (start + step) % creds.len();
        let cred = &creds[at];
        let call = agent
            .get(url)
            .set("Authorization", &cred.header())
            .set("Accept", "application/json");
        match call.call() {
            Ok(res) => {
                cache.rung.insert((org.to_string(), family), at);
                return res
                    .into_json::<serde_json::Value>()
                    .map_err(|e| Denied::Said(format!("unreadable answer from Azure DevOps: {e}")));
            }
            /* 401 is "this credential is not enough", 403 is "this identity is
               not allowed" — both are answered by trying another identity, and
               both are the whole reason the ladder falls through rather than
               stopping at the first credential it can find. 404 joins them
               because Azure DevOps returns it for a project the caller cannot
               see rather than admitting the project exists. */
            Err(ureq::Error::Status(code, _)) if code == 401 || code == 403 || code == 404 => {
                refused = Some(format!("{} was refused ({code})", cred.from));
            }
            Err(ureq::Error::Status(code, res)) => {
                let body = res.into_string().unwrap_or_default();
                /* The same fact as that 404, wearing a 400. Falls through to the
                   next rung rather than ending the pass — a credential scoped to
                   some of an org's projects and not others is ordinary, and the
                   rung that *can* see this one may be the next in the list. */
                if code == 400 && unseen(&body) {
                    invisible = true;
                    continue;
                }
                return Err(Denied::Said(format!(
                    "Azure DevOps answered {code}: {}",
                    first_line(&body)
                )));
            }
            Err(e) => return Err(Denied::Said(format!("could not reach Azure DevOps: {e}"))),
        }
    }
    /* A credential refusal outranks an invisibility, and the mixed case is why.
       On this org before a PAT is stored, a build read gets 401 from the git
       credential and 400-unseen from the az sign-in: reporting "not visible"
       there would be true of one rung and would hide the actionable half, since
       a token with Build (read) fixes it. Only a pass where *every* rung said it
       cannot see the project is a silence. */
    match (refused, invisible) {
        (Some(r), _) => Err(Denied::Said(r)),
        (None, true) => Err(Denied::Unseen),
        (None, false) => Err(Denied::Said("no credential was accepted".into())),
    }
}

/// The useful part of an error body. Azure DevOps answers with a JSON object
/// carrying a `message`, and failing that with HTML from whatever is in front of
/// it — a corporate proxy's block page, most usefully.
fn first_line(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.chars().take(200).collect();
        }
    }
    body.trim().lines().next().unwrap_or("").chars().take(200).collect()
}

/* ── what the wall is standing on ──────────────────────────────────────────*/

/// The organisation a repository belongs to, or None if it is not on Azure
/// DevOps at all.
///
/// Both spellings, because both are still in the wild: `dev.azure.com/<org>/…`
/// is what everything issues today and `<org>.visualstudio.com` is what older
/// clones still carry. The `<user>@` in front of the host — which is how AzDO
/// writes its own clone urls — is stripped rather than parsed.
fn org_of(remote: &str) -> Option<String> {
    let s = remote.trim();
    let s = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let s = s.rsplit_once('@').map(|(_, r)| r).unwrap_or(s);
    let (host, rest) = s.split_once('/')?;
    let host = host.split_once(':').map(|(h, _)| h).unwrap_or(host);

    if host.eq_ignore_ascii_case("dev.azure.com") || host.eq_ignore_ascii_case("ssh.dev.azure.com")
    {
        /* `ssh.dev.azure.com` puts a literal `v3` segment first. */
        let mut parts = rest.split('/').filter(|p| !p.is_empty());
        let first = parts.next()?;
        let org = if first == "v3" { parts.next()? } else { first };
        return (!org.is_empty()).then(|| decode(org));
    }
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        return (!org.is_empty()).then(|| org.to_string());
    }
    None
}

/// Percent-decoding, for the org and project names that arrive out of a remote
/// url with their spaces escaped (`TX%20Development%20Squad`).
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(n) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Every distinct Azure DevOps organisation the wall is standing on.
///
/// Order is the wall's own, deduplicated — so a studio with six NOVA cards and
/// one personal GitHub repo asks about one organisation, once.
fn orgs_for(cache: &mut Cache, roots: &[String]) -> Vec<String> {
    let now = Instant::now();
    let mut out: Vec<String> = Vec::new();
    for root in roots {
        let known = cache
            .orgs
            .get(root)
            .filter(|(_, at)| now.duration_since(*at) < ORG_FOR)
            .map(|(o, _)| o.clone());
        let org = match known {
            Some(o) => o,
            None => {
                /* `forge::remote_of` rather than a `git` spawned here, and
                   that is a fix rather than a tidy-up: this call had no
                   `GIT_TERMINAL_PROMPT=0` and no `credential.interactive=false`
                   on it, which every other shell-out in the app sets and which
                   `from_git` forty lines down sets for exactly this reason. A
                   background poll must never ask a question, and `remote
                   get-url` not authenticating *today* is a property of today's
                   git rather than a guarantee. Sharing the one reader with
                   `github.rs` is the smaller half of the reason. */
                let found = remote_of(root).as_deref().and_then(org_of);
                cache.orgs.insert(root.clone(), (found.clone(), now));
                found
            }
        };
        if let Some(org) = org {
            if !out.contains(&org) {
                out.push(org);
            }
        }
    }
    out
}

fn projects_of(cache: &mut Cache, org: &str) -> Result<Vec<Project>, String> {
    let now = Instant::now();
    if let Some((p, at)) = cache.projects.get(org) {
        if now.duration_since(*at) < PROJECTS_FOR {
            return Ok(p.clone());
        }
    }
    let url = format!(
        "https://dev.azure.com/{}/_apis/projects?api-version=7.1&$top=200",
        encode(org)
    );
    let v = get(cache, org, "core", &url).map_err(String::from)?;
    let list: Vec<Project> = v
        .get("value")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some(Project {
                        id: p.get("id")?.as_str()?.to_string(),
                        name: p.get("name")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    cache.projects.insert(org.to_string(), (list.clone(), now));
    Ok(list)
}

/// The caller's own identity in this organisation.
///
/// Worth one extra request because it is what turns a list of pull requests into
/// *your* list: `createdBy.id` and `reviewers[].id` are the same guid
/// `connectionData` hands back, verified 2026-08-14 against this org. Failing to
/// get it is not a failure of the whole reading — the rows are still true, they
/// just cannot be marked — so it returns an empty string rather than an error.
fn me_in(cache: &mut Cache, org: &str) -> String {
    let now = Instant::now();
    if let Some((id, at)) = cache.me.get(org) {
        if now.duration_since(*at) < ME_FOR {
            return id.clone();
        }
    }
    let url = format!(
        "https://dev.azure.com/{}/_apis/connectionData?api-version=7.1-preview",
        encode(org)
    );
    let id = get(cache, org, "core", &url)
        .ok()
        .and_then(|v| {
            v.get("authenticatedUser")?
                .get("id")?
                .as_str()
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    cache.me.insert(org.to_string(), (id.clone(), now));
    id
}

/* ── what comes back ───────────────────────────────────────────────────────*/

/// What one reading came to, including how it failed.
///
/// A fault is carried beside the rows rather than replacing them, for the reason
/// the ladder falls through: with two organisations on the wall, one of them
/// being unreachable must not blank the other. `at` is stamped by the front end
/// — Rust has no reason to hold a wall clock here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runs {
    runs: Vec<Run>,
    /// The organisations that were asked, so a wall with no AzDO repo on it can
    /// say *that* rather than saying nothing was running.
    orgs: Vec<String>,
    /// How many project-level requests this reading cost.
    asked: usize,
    /// Projects no credential on the ladder can see. Reported rather than
    /// merely skipped: an org where four of six projects are invisible to you
    /// draws an empty widget, and "nothing is building" and "you are not on
    /// these projects" are different sentences. The rule the caps follow — a
    /// bound that can hide an answer says so out loud.
    unseen: usize,
    fault: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviews {
    reviews: Vec<Review>,
    orgs: Vec<String>,
    asked: usize,
    /// Repositories no credential can see.
    ///
    /// **Always zero until GitHub arrived**, which is why this half did not have
    /// the field: Azure DevOps answers pull requests for a whole organisation in
    /// one call, so there was no per-project request to be refused. GitHub asks
    /// per repository and a private one the credential is not on is exactly the
    /// silence `Runs::unseen` already existed for. The front end had been
    /// defaulting it for this half all along (`#land`, `scan.unseen ?? 0`), so
    /// the number simply starts being true.
    unseen: usize,
    fault: Option<String>,
}

/* ── the two readings ──────────────────────────────────────────────────────*/

fn read_runs(cache: &mut Cache, org: &str, project: &Project) -> Result<Vec<Run>, Denied> {
    /* `queryOrder` is asked for explicitly: the default is by build id, which is
       the same order right up until a project has two pipelines whose ids
       interleave differently from their queue times. */
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/build/builds?api-version=7.1\
         &queryOrder=queueTimeDescending&$top={}",
        encode(org),
        encode(&project.id),
        BUILDS_PER_PROJECT,
    );
    let v = get(cache, org, "build", &url)?;
    let me = me_in(cache, org);
    let empty = Vec::new();
    let rows = v.get("value").and_then(|v| v.as_array()).unwrap_or(&empty);

    Ok(rows
        .iter()
        .filter_map(|b| {
            let build_id = b.get("id")?.as_i64()?;
            let by = b.get("requestedFor").cloned().unwrap_or_default();
            Some(Run {
                /* The forge goes in front, because this string is now a handle
                   as well as a key: `forge_run` takes it apart to know who to
                   ask. Both forges' ids are slash-separated and the same shape,
                   so the prefix is the only thing telling them apart. */
                id: format!("azdo/{org}/{}/{build_id}", project.id),
                forge: Forge::Azdo.as_str(),
                org: org.to_string(),
                project: project.name.clone(),
                pipeline: b
                    .get("definition")
                    .map(|d| text(d, "name"))
                    .unwrap_or_default(),
                number: text(b, "buildNumber"),
                status: text(b, "status"),
                result: text(b, "result"),
                branch: text(b, "sourceBranch"),
                by: text(&by, "displayName"),
                queued_at: stamp(b, "queueTime"),
                started_at: stamp(b, "startTime"),
                finished_at: stamp(b, "finishTime"),
                /* Built rather than taken from `_links`: the org-wide shapes do
                   not always carry one, and a url composed the same way every
                   time is one fewer thing that can be absent. Ids rather than
                   names, so a project with a space in it needs no escaping. */
                url: format!(
                    "https://dev.azure.com/{}/{}/_build/results?buildId={build_id}",
                    encode(org),
                    encode(&project.id),
                ),
                mine: !me.is_empty() && text(&by, "id") == me,
            })
        })
        .collect())
}

fn read_reviews(cache: &mut Cache, org: &str) -> Result<Vec<Review>, String> {
    let url = format!(
        "https://dev.azure.com/{}/_apis/git/pullrequests?api-version=7.1\
         &searchCriteria.status=active&$top={}",
        encode(org),
        PRS_PER_ORG,
    );
    let v = get(cache, org, "git", &url).map_err(String::from)?;
    let me = me_in(cache, org);
    let empty = Vec::new();
    let rows = v.get("value").and_then(|v| v.as_array()).unwrap_or(&empty);

    Ok(rows
        .iter()
        .filter_map(|p| {
            let number = p.get("pullRequestId")?.as_i64()?;
            let repo = p.get("repository")?;
            let repo_id = text(repo, "id");
            let project = repo.get("project").cloned().unwrap_or_default();
            let project_id = text(&project, "id");
            let author = p.get("createdBy").cloned().unwrap_or_default();

            let votes: Vec<Vote> = p
                .get("reviewers")
                .and_then(|r| r.as_array())
                .map(|a| {
                    a.iter()
                        .map(|r| Vote {
                            by: text(r, "displayName"),
                            vote: r.get("vote").and_then(|v| v.as_i64()).unwrap_or(0),
                            required: r
                                .get("isRequired")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default();

            let mine_row = p
                .get("reviewers")
                .and_then(|r| r.as_array())
                .and_then(|a| a.iter().find(|r| !me.is_empty() && text(r, "id") == me));

            Some(Review {
                id: format!("azdo/{org}/{repo_id}/{number}"),
                forge: Forge::Azdo.as_str(),
                org: org.to_string(),
                project: text(&project, "name"),
                repo: text(repo, "name"),
                number,
                title: text(p, "title"),
                by: text(&author, "displayName"),
                draft: p.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
                merge: text(p, "mergeStatus"),
                target: text(p, "targetRefName"),
                created_at: stamp(p, "creationDate"),
                url: format!(
                    "https://dev.azure.com/{}/{}/_git/{}/pullrequest/{number}",
                    encode(org),
                    encode(&project_id),
                    encode(&repo_id),
                ),
                auto: p.get("autoCompleteSetBy").map(|v| !v.is_null()).unwrap_or(false),
                mine: !me.is_empty() && text(&author, "id") == me,
                reviewing: mine_row.is_some(),
                my_vote: mine_row
                    .and_then(|r| r.get("vote"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
                votes,
                /* Empty, and not a gap. Azure DevOps marks each reviewer
                   required or not, so `landable` computes the rollup from the
                   votes; GitHub refuses to say who is required and answers the
                   rollup instead. See `forge::Review::decision`. */
                decision: String::new(),
            })
        })
        .collect())
}

/* ── one run, opened ───────────────────────────────────────────────────────*/

/// A build's timeline, flattened to the two levels `forge.rs` draws.
///
/// **Azure DevOps answers with a flat list and parent pointers, not a tree**,
/// and rebuilding one is most of this function. Probed 2026-08-27 against a RISE
/// build: 71 records across four `type`s — `Stage`, `Phase`, `Job`, `Task` —
/// with `parentId` naming the record above and `order` meaning *within your
/// parent*, so the list as it arrives is in no useful order at all.
///
/// What is kept and why:
///
/// - **`Job` becomes a stage**, because it is the unit that runs on an agent and
///   owns a log, which is what GitHub's job is too. That correspondence is the
///   whole reason a two-level reading is honest rather than a truncation.
/// - **`Task` becomes a step**, under the job that is its parent.
/// - **`Phase` is dropped.** It is a one-to-one wrapper around its Job in every
///   pipeline probed — a matrix would make it one-to-many, and then the Jobs
///   under it are the interesting rows anyway, which is exactly what keeping the
///   Job level gives.
/// - **`Stage` survives as a prefix** on the job's name, and only when the build
///   has more than one. A six-stage release pipeline reads as `Deploy to Test ·
///   VerifyTestJob`; a single-stage build is not made to carry the word "Build"
///   down every row for nothing.
/// - **`Checkpoint` is dropped.** It is the approval gate's own bookkeeping and
///   not work — four of them in that build, all called `Checkpoint`, none of
///   which a person reading a failed pipeline wants a row for.
fn read_timeline(cache: &mut Cache, org: &str, project: &str, build: &str) -> Result<Vec<Stage>, Denied> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/build/builds/{}/timeline?api-version=7.1",
        encode(org),
        encode(project),
        encode(build),
    );
    let v = get(cache, org, "build", &url)?;
    let empty = Vec::new();
    let records = v.get("records").and_then(|r| r.as_array()).unwrap_or(&empty);
    Ok(flatten_timeline(records))
}

/// The flattening itself, apart from the request that fetched it.
///
/// Split out for the reason `runs_with` is split from `azdo_runs`: it is the
/// only intricate logic in this file that is not a parser, and on a machine with
/// no MSVC the only way to *run* an assertion is to lift a pure function into a
/// throwaway `rustc --test` (see `.claude/rules/build.md`). Verified 2026-08-27
/// against a real 71-record RISE timeline that way — six stages, eleven jobs,
/// four Checkpoints — which is not something a hand-written fixture would have
/// got right, since the record order as it arrives is meaningless.
fn flatten_timeline(records: &[serde_json::Value]) -> Vec<Stage> {
    /* Record id -> (type, name, parent, order), so a job can walk up to whichever
       Stage it sits under however many Phases are in between.
       Owned rather than borrowed out of the parsed body: the walk below is a
       closure over this map, and keeping `&str` into the JSON means a lifetime
       argument threaded through a function whose whole job is to be read once.
       Seventy-one short strings is not a cost worth a fight. */
    let mut by_id: HashMap<String, (String, String, String, i64)> = HashMap::new();
    for r in records {
        let Some(id) = r.get("id").and_then(|i| i.as_str()) else { continue };
        by_id.insert(
            id.to_string(),
            (
                text(r, "type"),
                text(r, "name"),
                r.get("parentId").and_then(|p| p.as_str()).unwrap_or("").to_string(),
                r.get("order").and_then(|o| o.as_i64()).unwrap_or(0),
            ),
        );
    }

    /* The Stage a record sits under, and where that stage comes in the build.
       `order` on a Stage is its position in the pipeline, which is the only
       global ordering Azure DevOps gives us — a Job's own `order` is within its
       parent and says nothing about the build. */
    let stage_of = |from: &str| -> Option<(String, i64)> {
        /* Bounded by the record count rather than trusting the parent chain to
           be acyclic — this is somebody else's data structure and a cycle in it
           would be an infinite loop inside a poll. */
        let mut at = from.to_string();
        for _ in 0..by_id.len() {
            let (kind, name, parent, order) = by_id.get(&at)?;
            if kind == "Stage" {
                return Some((name.clone(), *order));
            }
            at = parent.clone();
        }
        None
    };

    let stages_in_build = records
        .iter()
        .filter(|r| r.get("type").and_then(|t| t.as_str()) == Some("Stage"))
        .count();

    /* Tasks first, grouped under the job that owns them, so the jobs pass below
       can take its own without a second walk. */
    let mut tasks: HashMap<&str, Vec<(i64, Step)>> = HashMap::new();
    for r in records {
        if r.get("type").and_then(|t| t.as_str()) != Some("Task") {
            continue;
        }
        let Some(parent) = r.get("parentId").and_then(|p| p.as_str()) else { continue };
        tasks.entry(parent).or_default().push((
            r.get("order").and_then(|o| o.as_i64()).unwrap_or(0),
            Step {
                name: text(r, "name"),
                status: text(r, "state"),
                result: text(r, "result"),
                started_at: stamp(r, "startTime"),
                finished_at: stamp(r, "finishTime"),
            },
        ));
    }

    /* Sort key: which stage, then when the job started, then its order within
       the stage. A job with no start time sorts *after* the ones that ran rather
       than before — a zero would put the work still to come above the work
       already done. */
    let key = |stage_order: i64, started: i64, order: i64| {
        (stage_order, if started == 0 { i64::MAX } else { started }, order)
    };

    let mut out: Vec<((i64, i64, i64), Stage)> = Vec::new();
    /* Which stages produced a job, so the pass below can tell which did not. */
    let mut covered: Vec<String> = Vec::new();

    for r in records {
        if r.get("type").and_then(|t| t.as_str()) != Some("Job") {
            continue;
        }
        let Some(id) = r.get("id").and_then(|i| i.as_str()) else { continue };
        let name = text(r, "name");
        let parent = r.get("parentId").and_then(|p| p.as_str()).unwrap_or("");
        let under = stage_of(parent);
        if let Some((stage, _)) = &under {
            if !covered.contains(stage) {
                covered.push(stage.clone());
            }
        }
        /* The stage's name in front, but only when the build has more than one —
           a single-stage build should not carry the word "Build" down every row —
           and only when it is not simply the job's name again, which is what a
           one-job stage usually is. */
        let name = match (stages_in_build > 1, &under) {
            (true, Some((stage, _))) if stage != &name => format!("{stage} · {name}"),
            _ => name,
        };
        let mut steps = tasks.remove(id).unwrap_or_default();
        steps.sort_by_key(|(order, _)| *order);
        let started = stamp(r, "startTime");
        out.push((
            /* A job with no Stage above it goes last. Azure DevOps' implicit
               finalization job is exactly this and it does run last, so the
               fallback happens to be the truth rather than a shrug. */
            key(
                under.map(|(_, o)| o).unwrap_or(i64::MAX),
                started,
                r.get("order").and_then(|o| o.as_i64()).unwrap_or(0),
            ),
            Stage {
                name,
                status: text(r, "state"),
                result: text(r, "result"),
                started_at: started,
                finished_at: stamp(r, "finishTime"),
                steps: steps.into_iter().map(|(_, s)| s).collect(),
            },
        ));
    }

    /* **A stage that produced no job is still a row**, and finding that out is
       the whole return on running this against a real build rather than a
       fixture. Probed 2026-08-27 against RISE build 2515: thirteen stages went
       in and five rows came out, because a stage that was skipped — or has not
       been reached yet — has a `Stage` record and a `Phase` record and **no
       `Job` record at all**. Nine of the thirteen were invisible.

       That is tolerable for a post-mortem and wrong for the thing this panel is
       for. On a running release pipeline you could see what had happened and not
       what was still to come, so a thirteen-stage run showed four rows with
       nothing to say there were nine more — which is the opposite of live
       progress. So the stage stands in for its own missing job, carrying its own
       state and result and no steps, because it genuinely has none. */
    for r in records {
        if r.get("type").and_then(|t| t.as_str()) != Some("Stage") {
            continue;
        }
        let name = text(r, "name");
        if covered.contains(&name) {
            continue;
        }
        let started = stamp(r, "startTime");
        let order = r.get("order").and_then(|o| o.as_i64()).unwrap_or(0);
        out.push((
            key(order, started, 0),
            Stage {
                name,
                status: text(r, "state"),
                result: text(r, "result"),
                started_at: started,
                finished_at: stamp(r, "finishTime"),
                steps: Vec::new(),
            },
        ));
    }

    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, s)| s).collect()
}

/// `azdo/{org}/{project}/{build}` back into its three parts.
fn split_id(id: &str) -> Result<(String, String, String), String> {
    let mut parts = id.split('/');
    match (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("azdo"), Some(o), Some(p), Some(b), None)
            if !o.is_empty() && !p.is_empty() && !b.is_empty() =>
        {
            Ok((o.to_string(), p.to_string(), b.to_string()))
        }
        _ => Err(format!("not an azure devops run id: {id}")),
    }
}

fn detail_of(cache: &mut Cache, id: &str) -> Result<Detail, String> {
    let (org, project, build) = split_id(id)?;
    let stages = read_timeline(cache, &org, &project, &build).map_err(String::from)?;
    /* Asked of the jobs rather than of the build, for the reason `github.rs`
       gives: the build is a second request and the answer is the same. */
    let live = stages.iter().any(|s| s.status != "completed");
    Ok(Detail { id: id.to_string(), forge: Forge::Azdo.as_str(), stages, live, fault: None })
}

/// Everything running, across every organisation the wall stands on.
///
/// Sequential rather than threaded, deliberately. Six projects at roughly 300ms
/// each is under two seconds against a poll measured in tens of seconds, and the
/// alternative — a thread per project — would need the cache behind its own lock
/// and would open six connections to one host at once, which is the shape a
/// corporate proxy rate-limits. The cost is bounded by the project count, and
/// the project count is bounded by what you have cloned.
///
/// Off the main thread, and it is the reason `crate::off_main` exists: this
/// makes one blocking request per project, in sequence, against timeouts of ten
/// and twenty seconds, and on the main thread that was a freeze of the whole
/// wall. It holds the cache mutex across the lot, so `release_azdo` has to leave
/// the main thread too.
#[tauri::command]
pub async fn azdo_runs(app: AppHandle, roots: Vec<String>) -> Result<Runs, String> {
    crate::off_main(move || {
        let mut got = {
            let state = app.state::<Azdo>();
            let mut cache = state.0.lock().unwrap();
            runs_with(&mut cache, &roots)
        };
        /* The Azure DevOps lock is dropped before the GitHub one is taken, and
           that is deliberate rather than tidy. Both are held across a whole
           network pass, so a command that took them in one order while anything
           else took them in the other would deadlock the wall for as long as two
           polls — and there would be no way to tell that from the freeze
           `off_main` was introduced to fix. Never both at once is a rule that
           needs no ordering to be remembered. */
        let mine = {
            let state = app.state::<github::Github>();
            let mut cache = state.0.lock().unwrap();
            github::runs_with(&mut cache, &roots)
        };
        merge_runs(&mut got, mine);
        got
    })
    .await
}

/// One forge's rows folded into the other's reading.
///
/// The order the rows end up in does not matter much here — `orderRuns` in
/// `azdo.ts` sorts the whole list by how much it wants you, and it has never
/// cared which service a row came off. What matters is the three numbers beside
/// them: `asked` is requests that left the machine and must count both, `unseen`
/// is silences and must count both, and `fault` is the one line the widget has
/// room for.
///
/// **Azure DevOps' fault wins a tie**, and that is a judgement rather than an
/// accident of which is checked first. The Azure DevOps half is the one that
/// needs a credential you have to go and mint — it is the fault the keyring
/// button is offered for, and `Pipelines.svelte` matches on its wording to
/// decide whether to offer one. A GitHub fault is nearly always `gh auth login`,
/// which is a sentence rather than a panel. Hiding the actionable half behind
/// the self-explanatory one is the same mistake `get` avoids when it lets a
/// credential refusal outrank an invisibility.
fn merge_runs(into: &mut Runs, from: github::Scan<Run>) {
    into.runs.extend(from.rows);
    into.orgs.extend(from.orgs);
    into.asked += from.asked;
    into.unseen += from.unseen;
    if into.fault.is_none() {
        into.fault = from.fault;
    }
    into.runs.sort_by(|a, b| b.queued_at.cmp(&a.queued_at));
}

fn merge_reviews(into: &mut Reviews, from: github::Scan<Review>) {
    into.reviews.extend(from.rows);
    into.orgs.extend(from.orgs);
    into.asked += from.asked;
    into.unseen += from.unseen;
    if into.fault.is_none() {
        into.fault = from.fault;
    }
    into.reviews.sort_by(|a, b| b.created_at.cmp(&a.created_at));
}

/// The reading itself, apart from the command that carries it — so
/// `examples/azdo-probe.rs` exercises this code rather than a copy of it. The
/// probe is how the two things this module cannot assume were established: that
/// TLS resolves through the corporate proxy, and which rung of the ladder each
/// endpoint family actually accepts.
pub fn runs_with(cache: &mut Cache, roots: &[String]) -> Runs {
    let orgs = orgs_for(cache, roots);
    let mut runs = Vec::new();
    let mut fault = None;
    let mut asked = 0usize;
    let mut unseen = 0usize;

    for org in &orgs {
        let projects = match projects_of(cache, org) {
            Ok(p) => p,
            Err(e) => {
                fault.get_or_insert(e);
                continue;
            }
        };
        for project in projects {
            asked += 1;
            match read_runs(cache, org, &project) {
                Ok(mut rows) => runs.append(&mut rows),
                /* A project nobody on the ladder is on is counted, not faulted.
                   Per-project permissions are ordinary in a large org, and a
                   widget that reports one as an error is a widget permanently
                   red about the shape of somebody else's tenant. */
                Err(Denied::Unseen) => unseen += 1,
                /* One project refusing must not lose the other five. The first
                   fault is kept because a widget has room for one line, and the
                   rows that did arrive are the more useful half of the answer. */
                Err(Denied::Said(e)) => {
                    fault.get_or_insert(e);
                }
            }
        }
    }

    runs.sort_by(|a, b| b.queued_at.cmp(&a.queued_at));
    Runs {
        runs,
        orgs,
        asked,
        unseen,
        fault,
    }
}

/// Every open pull request, across every organisation the wall stands on.
///
/// Off the main thread for the reason `azdo_runs` is.
#[tauri::command]
pub async fn azdo_reviews(app: AppHandle, roots: Vec<String>) -> Result<Reviews, String> {
    crate::off_main(move || {
        let mut got = {
            let state = app.state::<Azdo>();
            let mut cache = state.0.lock().unwrap();
            reviews_with(&mut cache, &roots)
        };
        let mine = {
            let state = app.state::<github::Github>();
            let mut cache = state.0.lock().unwrap();
            github::reviews_with(&mut cache, &roots)
        };
        merge_reviews(&mut got, mine);
        got
    })
    .await
}

/// One run's stages and steps, from whichever forge the id names.
///
/// **The forge is read off the id rather than passed alongside it**, which keeps
/// the front end from having to know there is a choice: a row carries a string,
/// the string is enough, and a widget that has just been handed a row cannot get
/// the pairing wrong. Both providers refuse an id with the other's prefix rather
/// than half-reading it, so a routing mistake says so instead of 404ing
/// confusingly.
///
/// Off the main thread for the reason every other command here is, and with the
/// same one-lock-at-a-time rule: only one provider is asked, so only one is
/// taken.
#[tauri::command]
pub async fn forge_run(app: AppHandle, id: String) -> Result<Detail, String> {
    crate::off_main(move || {
        if id.starts_with("github/") {
            let state = app.state::<github::Github>();
            let mut cache = state.0.lock().unwrap();
            github::read_detail(&mut cache, &id)
        } else {
            let state = app.state::<Azdo>();
            let mut cache = state.0.lock().unwrap();
            detail_of(&mut cache, &id)
        }
    })
    .await?
}

pub fn reviews_with(cache: &mut Cache, roots: &[String]) -> Reviews {
    let orgs = orgs_for(cache, roots);
    let mut reviews = Vec::new();
    let mut fault = None;
    let mut asked = 0usize;

    for org in &orgs {
        asked += 1;
        match read_reviews(cache, org) {
            Ok(mut rows) => reviews.append(&mut rows),
            Err(e) => {
                fault.get_or_insert(e);
            }
        }
    }

    reviews.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Reviews {
        reviews,
        orgs,
        asked,
        /* Always zero on this half: pull requests come back org-wide in one
           call, so there is no per-project request here to be refused. The
           GitHub half is where the number comes from. */
        unseen: 0,
        fault,
    }
}

/// Let go of everything remembered — the ladder included, so a `az login` or a
/// newly stored PAT is picked up without restarting the app.
///
/// Called when the last widget detaches, the same contract `release_performance`
/// has: a wall that has stopped asking should not be holding a token.
///
/// Off the main thread not because clearing a cache is slow, but because the
/// mutex it wants is held for the whole of a reading pass. Left on the main
/// thread it would wait there for a poll's worth of network — the freeze it took
/// moving the polls off to remove, reintroduced by the detach.
#[tauri::command]
pub async fn release_azdo(app: AppHandle) -> Result<(), String> {
    crate::off_main(move || {
        *app.state::<Azdo>().0.lock().unwrap() = Cache::default();
        /* Both, because the front end has one connection and detaching from it
           means the wall has stopped asking anything of anybody. A GitHub token
           left cached here would be a credential held by an app with no face
           reading it, which is the property this command exists to keep. It is
           also what makes a fresh `gh auth login` take effect without restarting
           the app — the same thing it already did for `az login`. */
        *app.state::<github::Github>().0.lock().unwrap() = github::Cache::default();
    })
    .await
}

/* ── the token you entered ─────────────────────────────────────────────────
 *
 * Three commands over `vault.rs`, and the shape of them is the point: the front
 * end can say whether a token is held and can replace or remove it, and there is
 * no command that hands one back. Nothing outside `vault.rs` and the
 * `Authorization` header ever holds the secret, so no panel can leak it, no
 * snapshot can carry it, and a screenshot of the wall cannot either.
 *
 * All three leave the main thread. Reading the vault is a syscall and cheap, but
 * `set` and `clear` also reset the cache — and that mutex is held across an
 * entire reading pass, which is the whole reason `release_azdo` is `async`. */

/// Whether a token is stored. Never the token.
#[tauri::command]
pub async fn azdo_token() -> Result<bool, String> {
    crate::off_main(crate::vault::held).await
}

/// Store one, replacing whatever was there.
///
/// The cache goes with it, for the reason `release_azdo` exists: `creds` is
/// resolved once per organisation and held, so without this the ladder you just
/// changed would not be consulted until the last widget came off the wall.
#[tauri::command]
pub async fn set_azdo_token(app: AppHandle, token: String) -> Result<(), String> {
    crate::off_main(move || {
        crate::vault::store(&token)?;
        *app.state::<Azdo>().0.lock().unwrap() = Cache::default();
        Ok(())
    })
    .await?
}

#[tauri::command]
pub async fn clear_azdo_token(app: AppHandle) -> Result<(), String> {
    crate::off_main(move || {
        crate::vault::clear()?;
        *app.state::<Azdo>().0.lock().unwrap() = Cache::default();
        Ok(())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `az account get-access-token -o json` actually printed on this
    /// machine, 2026-08-25, trimmed to the fields that are read. The token was
    /// 2290 characters; nothing here depends on its length.
    fn az_json(expires_on: &str) -> String {
        format!(
            r#"{{"accessToken":"ey.J","expiresOn":"2026-08-25 11:30:28.000000",
                 "expires_on":{expires_on},"subscription":"b0556cda","tenant":"e8a8a7fa",
                 "tokenType":"Bearer"}}"#
        )
    }

    #[test]
    fn a_token_is_held_for_its_own_life_less_the_margin() {
        /* The real numbers off the probe: issued at 1787617212, expiring at
           1787621428, which is a little over 70 minutes. */
        let (tok, hold) = az_token(&az_json("1787621428"), 1_787_617_212).unwrap();
        assert_eq!(tok, "ey.J");
        assert_eq!(hold, Duration::from_secs(1787621428 - 1787617212) - AZ_MARGIN);
    }

    #[test]
    fn the_local_time_field_is_not_the_one_read() {
        /* `expiresOn` says 11:30:28 with no zone on it and is right there in the
           same object. Reading it would mean guessing which zone the CLI meant.
           Here it stays fixed while `expires_on` moves, and the answer follows
           `expires_on`. */
        let (_, a) = az_token(&az_json("1787621428"), 1_787_617_212).unwrap();
        let (_, b) = az_token(&az_json("1787624428"), 1_787_617_212).unwrap();
        assert!(b > a, "the epoch field is what decides: {a:?} then {b:?}");
    }

    #[test]
    fn a_token_already_dead_is_still_held_briefly() {
        /* Not discarded, which would spawn `az` again on the very next poll and
           keep doing it. The ladder's rotation settles a refusal in one
           request. */
        let (_, hold) = az_token(&az_json("1787617000"), 1_787_617_212).unwrap();
        assert_eq!(hold, AZ_MIN_HOLD);
    }

    #[test]
    fn a_token_inside_the_margin_does_not_come_back_as_zero() {
        /* Expiring in one minute, which the two-minute margin would take past
           zero. `Duration` does not go negative, but a zero hold is a token
           re-resolved on every poll. */
        let (_, hold) = az_token(&az_json("1787617272"), 1_787_617_212).unwrap();
        assert_eq!(hold, AZ_MIN_HOLD);
    }

    #[test]
    fn an_expiry_that_arrives_as_a_string_is_read_too() {
        /* Which spelling a JSON serialiser gives a large integer is not a thing
           to depend on. */
        let (_, hold) = az_token(&az_json(r#""1787621428""#), 1_787_617_212).unwrap();
        assert_eq!(hold, Duration::from_secs(1787621428 - 1787617212) - AZ_MARGIN);
    }

    #[test]
    fn a_token_that_says_nothing_about_expiry_gets_the_blind_hold() {
        /* Only reachable if a future `az` stops printing the field. Holding it
           forever is the bug; holding it for half an hour costs one spawn. */
        let out = r#"{"accessToken":"ey.J","tokenType":"Bearer"}"#;
        let (_, hold) = az_token(out, 1_787_617_212).unwrap();
        assert_eq!(hold, AZ_BLIND_HOLD);
    }

    #[test]
    fn nothing_usable_is_not_a_credential() {
        assert!(az_token("not json at all", 0).is_none());
        assert!(az_token(r#"{"accessToken":""}"#, 0).is_none());
        assert!(az_token(r#"{"error":"please run az login"}"#, 0).is_none());
    }

    #[test]
    fn only_the_rung_that_expires_ever_looks_spent() {
        /* The point of putting the expiry on the rung: a PAT is good for months
           and an environment variable does not change underneath us, so a clock
           on the whole cache would re-spawn four processes to rediscover three
           things that had not moved. */
        let now = Instant::now();
        assert!(!Cred::basic("a stored token", "pat".into()).spent(now));
        let live = Cred::bearer_for("an az sign-in", "ey.J".into(), Duration::from_secs(600));
        assert!(!live.spent(now));
        assert!(live.spent(now + Duration::from_secs(601)));
    }

    #[test]
    fn an_org_is_read_out_of_every_remote_shape_in_the_wild() {
        /* Exactly what `git remote -v` prints in this workspace. */
        assert_eq!(
            org_of("https://LagardereAWPL@dev.azure.com/LagardereAWPL/NOVA/_git/NOVA"),
            Some("LagardereAWPL".into())
        );
        assert_eq!(
            org_of("https://dev.azure.com/LagardereAWPL/RISE/_git/RISE"),
            Some("LagardereAWPL".into())
        );
        /* ssh puts a literal `v3` in front of the org, and comes in two
           spellings. The scp-like one is what Azure DevOps' own Clone → SSH
           button hands out, so it is the commoner of the two in the wild: the
           `v3` rides on the *host* half (`…azure.com:v3`) rather than on the
           path, which is the whole reason `org_of` trims the host at its colon
           before matching. This asserted `None` for a while, on the reading
           that a colon after the host put the remote out of reach — a repo
           cloned the ordinary way then got no pipelines and no reviews. */
        assert_eq!(
            org_of("git@ssh.dev.azure.com:v3/LagardereAWPL/NOVA/NOVA"),
            Some("LagardereAWPL".into())
        );
        assert_eq!(
            org_of("ssh://git@ssh.dev.azure.com/v3/LagardereAWPL/NOVA/NOVA"),
            Some("LagardereAWPL".into())
        );
        /* The older host, still on plenty of clones. */
        assert_eq!(
            org_of("https://LagardereAWPL.visualstudio.com/NOVA/_git/NOVA"),
            Some("LagardereAWPL".into())
        );
    }

    #[test]
    fn anything_that_is_not_azure_devops_is_not_guessed_at() {
        /* Half this workspace is on GitHub, and a wall holding both must ask
           about one of them and not the other. */
        assert_eq!(org_of("https://github.com/ShaitanLyss/skein.git"), None);
        assert_eq!(org_of("git@github.com:ShaitanLyss/skein.git"), None);
        assert_eq!(org_of(""), None);
        assert_eq!(org_of("C:/some/local/path"), None);
    }

    #[test]
    fn an_org_with_a_space_survives_the_round_trip() {
        /* `TX Development Squad` arrives escaped in a remote url and has to go
           back into a request path escaped again — decoded in between so it can
           be compared against what the API calls it. */
        let org = org_of("https://x@dev.azure.com/TX%20Squad/NOVA/_git/NOVA").unwrap();
        assert_eq!(org, "TX Squad");
        assert_eq!(encode(&org), "TX%20Squad");
    }

    #[test]
    fn a_pat_is_presented_the_way_azure_devops_wants_it() {
        /* Basic with an empty user, which is the documented and only accepted
           form. `:hunter2` is the exact string being encoded. */
        assert_eq!(
            Cred::basic("the stored token", "hunter2".into()).header(),
            "Basic Omh1bnRlcjI="
        );
        assert_eq!(
            Cred::bearer_for("an az sign-in", "ey.J".into(), AZ_MIN_HOLD).header(),
            "Bearer ey.J"
        );
    }

    #[test]
    fn two_rungs_holding_one_secret_are_tried_once() {
        /* The case this exists for: a PAT stored in the vault and the same PAT
           still sitting in a shell profile. Two names, one credential, and
           discovering it is refused must not cost two round trips. */
        let vault = Cred::basic("the stored token", "hunter2".into());
        let env = Cred::basic("VOLERY_AZDO_PAT", "hunter2".into());
        assert!(vault.same_as(&env));
        /* Same secret presented two different ways is genuinely two attempts —
           Azure DevOps accepts a PAT as Basic and refuses it as a bearer. */
        assert!(!vault.same_as(&Cred::bearer_for("an az sign-in", "hunter2".into(), AZ_MIN_HOLD)));
        assert!(!vault.same_as(&Cred::basic("the git credential", "other".into())));
    }

    #[test]
    fn a_project_you_cannot_see_is_recognised_by_its_type_key() {
        /* Verbatim from `_apis/build/builds` on 2026-08-24, with an Entra bearer
           that is not on the project. Note the 400: this is the whole reason it
           needed its own arm rather than riding the 401/403/404 one. */
        let body = r#"{"$id":"1","innerException":null,
            "message":"VS800075: The project with id 'vstfs:///Classification/TeamProject/969d50af-ce8a-4fa8-a262-1b7c9f6f8e8a' does not exist, or you do not have permission to access it.",
            "typeName":"Microsoft.TeamFoundation.Core.WebApi.ProjectDoesNotExistException, Microsoft.TeamFoundation.Core.WebApi",
            "typeKey":"ProjectDoesNotExistException","errorCode":0,"eventId":3000}"#;
        assert!(unseen(body));

        /* A real malformed request must stay loud — forgiving every 400 would
           turn a bug in this file into a project that quietly went missing. */
        assert!(!unseen(
            r#"{"message":"The query parameter $top is invalid","typeKey":"VssPropertyValidationException"}"#
        ));
        assert!(!unseen("<html>418 from a proxy</html>"));
        assert!(!unseen(""));
    }

    #[test]
    fn base64_pads_the_way_everything_else_does() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn an_azure_devops_stamp_becomes_a_number() {
        use crate::forge::epoch_ms;
        /* The shape the build API writes — seven fractional digits, where
           Claude Code writes three. */
        assert_eq!(epoch_ms("2025-08-26T00:16:35.9795575Z"), 1_756_167_395_979);
        assert_eq!(epoch_ms("2026-08-14T00:00:00Z"), 1_786_665_600_000);
        /* A build that has not started has no start time, and a run with no
           start is an ordinary state rather than a record to drop. */
        assert_eq!(epoch_ms(""), 0);
        assert_eq!(epoch_ms("not a date"), 0);
    }
}
